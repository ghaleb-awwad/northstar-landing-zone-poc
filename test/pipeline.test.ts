import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, Config, EnvName } from '../src/config.js';
import { runDeploy, runDrift } from '../src/pipeline.js';
import { newRunId, readRun, type Changes } from '../src/runs.js';
import type { PlanResult, TfRunner } from '../src/terraform.js';

const account = (name: string, environment: EnvName, id: string): Account => ({
  name,
  account_id: id,
  environment,
  owner: 'x@northstar.example',
  business_unit: 'x',
  cost_center: 'CC-1',
  network_index: 1,
  overrides: {},
});

// The pipeline only reads config.accounts.
const config = {
  accounts: {
    'a-dev': account('a-dev', 'dev', '210000000001'),
    'b-dev': account('b-dev', 'dev', '210000000002'),
    'a-test': account('a-test', 'test', '220000000001'),
    'a-prod': account('a-prod', 'prod', '230000000001'),
  },
} as unknown as Config;

const CHANGES: Changes = { add: 4, change: 0, destroy: 0 };

/** Fake Terraform: records calls; `failures[name]` = number of attempts that fail before success. */
class FakeRunner implements TfRunner {
  applied: string[] = [];
  orgApplies = 0;
  constructor(
    private failures: Record<string, number> = {},
    private drifted: Record<string, string[]> = {},
  ) {}
  async ensureWorkspaces(): Promise<void> {}
  async applyOrg(): Promise<Changes> {
    this.orgApplies++;
    return { add: 1, change: 0, destroy: 0 };
  }
  async applyAccount(name: string): Promise<Changes> {
    this.applied.push(name);
    if ((this.failures[name] ?? 0) > 0) {
      this.failures[name]--;
      throw new Error(`apply failed for ${name}`);
    }
    return CHANGES;
  }
  async planOrg(): Promise<PlanResult> {
    return { changed: false, changes: { add: 0, change: 0, destroy: 0 }, addresses: [] };
  }
  async planAccount(name: string): Promise<PlanResult> {
    const addresses = this.drifted[name] ?? [];
    return { changed: addresses.length > 0, changes: { add: addresses.length, change: 0, destroy: 0 }, addresses };
  }
  hasState(): boolean {
    return true;
  }
}

let runsDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(path.join(tmpdir(), 'lz-runs-'));
});
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

const deploy = (runner: TfRunner, opts: { approveProd?: boolean; account?: string; simulateTransient?: string[] } = {}) =>
  runDeploy({
    config,
    runner,
    runId: newRunId(),
    trigger: 'cli',
    runsDir,
    retryDelayMs: 0,
    approveProd: opts.approveProd ?? true,
    account: opts.account,
    simulateTransient: opts.simulateTransient,
  });

const step = (run: Awaited<ReturnType<typeof deploy>>, name: string) =>
  run.rings.flatMap((r) => r.accounts).find((a) => a.name === name)!;

describe('runDeploy', () => {
  it('rolls out organization, then dev -> test -> prod', async () => {
    const runner = new FakeRunner();
    const run = await deploy(runner);
    expect(run.status).toBe('SUCCEEDED');
    expect(runner.orgApplies).toBe(1);
    expect(run.rings.map((r) => r.name)).toEqual(['dev', 'test', 'prod']);
    expect(runner.applied.indexOf('a-test')).toBeGreaterThan(runner.applied.indexOf('a-dev'));
    expect(runner.applied.indexOf('a-prod')).toBeGreaterThan(runner.applied.indexOf('a-test'));
    expect(readRun(run.runId, runsDir)?.status).toBe('SUCCEEDED');
  });

  it('retries a failed account once, then succeeds', async () => {
    const runner = new FakeRunner({ 'a-test': 1 });
    const run = await deploy(runner);
    expect(run.status).toBe('SUCCEEDED');
    expect(step(run, 'a-test')).toMatchObject({ status: 'SUCCEEDED', attempts: 2, changes: CHANGES });
  });

  it('halts later rings when an account fails permanently', async () => {
    const runner = new FakeRunner({ 'a-test': 99 });
    const run = await deploy(runner);
    expect(run.status).toBe('HALTED');
    expect(step(run, 'a-test')).toMatchObject({ status: 'FAILED', attempts: 2 });
    expect(run.rings.find((r) => r.name === 'prod')?.status).toBe('SKIPPED');
    expect(step(run, 'a-prod').status).toBe('SKIPPED');
    expect(runner.applied).not.toContain('a-prod');
  });

  it('skips prod without --approve-prod', async () => {
    const runner = new FakeRunner();
    const run = await deploy(runner, { approveProd: false });
    expect(run.status).toBe('SUCCEEDED');
    expect(step(run, 'a-prod').status).toBe('SKIPPED');
    expect(runner.applied).not.toContain('a-prod');
  });

  it('--account applies only that account and skips the organization stage', async () => {
    const runner = new FakeRunner();
    const run = await deploy(runner, { account: 'b-dev' });
    expect(runner.applied).toEqual(['b-dev']);
    expect(runner.orgApplies).toBe(0);
    expect(run.organization).toBeUndefined();
    expect(run.rings).toHaveLength(1);
  });

  it('refuses a single prod account without approval', async () => {
    await expect(deploy(new FakeRunner(), { account: 'a-prod', approveProd: false })).rejects.toThrow(/approve-prod/);
  });

  it('simulated transient failure: first attempt fails before Terraform runs, retry succeeds', async () => {
    const runner = new FakeRunner();
    const run = await deploy(runner, { simulateTransient: ['a-dev'] });
    expect(step(run, 'a-dev')).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    expect(runner.applied.filter((n) => n === 'a-dev')).toHaveLength(1);
  });
});

describe('runDrift', () => {
  it('reports drifted accounts and the drifted component', async () => {
    const runner = new FakeRunner({}, { 'a-prod': ['module.network.local_file.network'] });
    const run = await runDrift({ config, runner, runId: newRunId(), trigger: 'cli', runsDir });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.drift?.find((d) => d.name === 'a-prod')).toMatchObject({ status: 'DRIFTED', components: ['network'] });
    expect(run.drift?.find((d) => d.name === 'a-dev')?.status).toBe('IN_SYNC');
  });
});
