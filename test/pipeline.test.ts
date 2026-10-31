import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account, Config, EnvName, OrgStage } from '../src/config.js';
import { runDeploy, runDrift } from '../src/pipeline.js';
import { newRunId, readRun, type Changes } from '../src/runs.js';
import type { PlanResult, TfRunner } from '../src/terraform.js';

const account = (name: string, environment: EnvName, id: string, canary = false): Account => ({
  name,
  account_id: id,
  environment,
  owner: 'x@northstar.example',
  business_unit: 'x',
  cost_center: 'CC-1',
  network_index: 1,
  ...(canary ? { canary: true } : {}),
  overrides: {},
});

// The pipeline only reads config.accounts.
const configOf = (accounts: Account[]) => ({ accounts: Object.fromEntries(accounts.map((a) => [a.name, a])) }) as unknown as Config;
const config = configOf([
  account('a-dev', 'dev', '210000000001'),
  account('b-dev', 'dev', '210000000002'),
  account('a-test', 'test', '220000000001'),
  account('a-prod', 'prod', '230000000001'),
]);

const CHANGES: Changes = { add: 4, change: 0, destroy: 0 };
const NO_PLAN: PlanResult = { changed: false, changes: { add: 0, change: 0, destroy: 0 }, addresses: [] };

/** Fake Terraform: records calls in order; `failures[name]` = number of attempts that fail before success. */
class FakeRunner implements TfRunner {
  applied: string[] = [];
  constructor(
    private failures: Record<string, number> = {},
    private drifted: Record<string, string[]> = {},
  ) {}
  private maybeFail(target: string): void {
    if ((this.failures[target] ?? 0) > 0) {
      this.failures[target]--;
      throw new Error(`apply failed for ${target}`);
    }
  }
  async applyOrg(stage: OrgStage): Promise<Changes> {
    this.applied.push(`org:${stage}`);
    this.maybeFail(`org:${stage}`);
    return { add: 1, change: 0, destroy: 0 };
  }
  async applyAccount(name: string): Promise<Changes> {
    this.applied.push(name);
    this.maybeFail(name);
    return CHANGES;
  }
  async planOrg(stage: OrgStage): Promise<PlanResult> {
    const addresses = this.drifted[`org:${stage}`] ?? [];
    return { ...NO_PLAN, changed: addresses.length > 0, addresses };
  }
  async planAccount(name: string): Promise<PlanResult> {
    this.maybeFail(`plan:${name}`);
    const addresses = this.drifted[name] ?? [];
    return { changed: addresses.length > 0, changes: { add: addresses.length, change: 0, destroy: 0 }, addresses };
  }
  hasState(): boolean {
    return true;
  }
  hasOrgState(stage: OrgStage): boolean {
    return stage === 'core' || stage === 'prod';
  }
}

let runsDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(path.join(tmpdir(), 'lz-runs-'));
});
afterEach(() => rmSync(runsDir, { recursive: true, force: true }));

const deploy = (
  runner: TfRunner,
  opts: { approveProd?: boolean; account?: string; simulateTransient?: string[]; config?: Config; maxParallel?: number } = {},
) =>
  runDeploy({
    config: opts.config ?? config,
    runner,
    runId: newRunId(),
    trigger: 'cli',
    runsDir,
    retryDelayMs: 0,
    approveProd: opts.approveProd ?? true,
    approvedBy: 'tester',
    account: opts.account,
    maxParallel: opts.maxParallel,
    simulateTransient: opts.simulateTransient,
  });

const step = (run: Awaited<ReturnType<typeof deploy>>, name: string) =>
  run.rings.flatMap((r) => r.accounts).find((a) => a.name === name)!;
const ring = (run: Awaited<ReturnType<typeof deploy>>, name: string) => run.rings.find((r) => r.name === name)!;

describe('runDeploy', () => {
  it('rolls out ring by ring; each ring starts with its own organization stage, core waits for prod', async () => {
    const runner = new FakeRunner();
    const run = await deploy(runner);
    expect(run.status).toBe('SUCCEEDED');
    expect(run.rings.map((r) => r.name)).toEqual(['dev', 'test', 'prod']);
    expect(runner.applied).toEqual(['org:dev', 'a-dev', 'b-dev', 'org:test', 'a-test', 'org:core', 'org:prod', 'a-prod']);
    expect(ring(run, 'prod').organization.map((o) => o.stage)).toEqual(['core', 'prod']);
    expect(run.options.approvedBy).toBe('tester');
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
    expect(ring(run, 'prod').status).toBe('SKIPPED');
    expect(step(run, 'a-prod').status).toBe('SKIPPED');
    expect(runner.applied).not.toContain('a-prod');
    expect(runner.applied).not.toContain('org:core');
  });

  it('a failed organization stage skips its ring accounts and later rings', async () => {
    const runner = new FakeRunner({ 'org:test': 1 });
    const run = await deploy(runner);
    expect(run.status).toBe('HALTED');
    expect(ring(run, 'test').organization[0]).toMatchObject({ stage: 'test', status: 'FAILED' });
    expect(step(run, 'a-test').status).toBe('SKIPPED');
    expect(runner.applied).toEqual(['org:dev', 'a-dev', 'b-dev', 'org:test']);
  });

  it('without approval: Prod and Root/core are skipped and the run is PARTIAL', async () => {
    const runner = new FakeRunner();
    const run = await deploy(runner, { approveProd: false });
    expect(run.status).toBe('PARTIAL');
    expect(ring(run, 'prod')).toMatchObject({ status: 'SKIPPED', reason: 'Awaiting production approval' });
    expect(step(run, 'a-prod').status).toBe('SKIPPED');
    expect(runner.applied).not.toContain('a-prod');
    expect(runner.applied).not.toContain('org:core');
    expect(run.options.approvedBy).toBeUndefined();
  });

  it('--account applies only that account, without organization stages', async () => {
    const runner = new FakeRunner();
    const run = await deploy(runner, { account: 'b-dev' });
    expect(runner.applied).toEqual(['b-dev']);
    expect(run.rings).toHaveLength(1);
    expect(run.rings[0].organization).toEqual([]);
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

  it('deploys the canary first; a failed canary skips the rest of the ring', async () => {
    const prod = configOf([
      account('p-1', 'prod', '230000000001'),
      account('p-canary', 'prod', '230000000002', true),
      account('p-2', 'prod', '230000000003'),
    ]);
    const ok = new FakeRunner();
    await deploy(ok, { config: prod });
    expect(ok.applied.filter((n) => n.startsWith('p-'))[0]).toBe('p-canary');

    const failing = new FakeRunner({ 'p-canary': 99 });
    const run = await deploy(failing, { config: prod });
    expect(run.status).toBe('HALTED');
    expect(step(run, 'p-canary')).toMatchObject({ status: 'FAILED', canary: true });
    expect(step(run, 'p-1')).toMatchObject({ status: 'SKIPPED', error: 'Canary failed' });
    expect(failing.applied).not.toContain('p-1');
  });

  it('stops starting new accounts once failures exceed the failure budget', async () => {
    // 20 dev accounts -> budget floor(20 * 0.1) = 2; run one at a time so the order is deterministic.
    const dev = configOf(Array.from({ length: 20 }, (_, i) => account(`d-${String(i).padStart(2, '0')}`, 'dev', `21000000${String(i).padStart(4, '0')}`)));
    const runner = new FakeRunner({ 'd-00': 99, 'd-01': 99, 'd-02': 99 });
    const run = await deploy(runner, { config: dev, maxParallel: 1 });
    expect(run.status).toBe('HALTED');
    const statuses = run.rings[0].accounts.map((a) => a.status);
    expect(statuses.filter((s) => s === 'FAILED')).toHaveLength(3);
    expect(statuses.filter((s) => s === 'SKIPPED')).toHaveLength(17);
    expect(step(run, 'd-03').error).toMatch(/failure budget/);
  });
});

describe('runDrift', () => {
  it('reports drifted accounts and organization stages with the drifted component', async () => {
    const runner = new FakeRunner({}, { 'a-prod': ['module.network.local_file.network'], 'org:prod': ['local_file.organization'] });
    const run = await runDrift({ config, runner, runId: newRunId(), trigger: 'cli', runsDir });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.drift?.find((d) => d.name === 'a-prod')).toMatchObject({ status: 'DRIFTED', components: ['network'] });
    expect(run.drift?.find((d) => d.name === 'a-dev')?.status).toBe('IN_SYNC');
    expect(run.drift?.find((d) => d.name === 'organization/prod')).toMatchObject({ kind: 'organization', status: 'DRIFTED', components: ['organization'] });
    expect(run.drift?.find((d) => d.name === 'organization/core')?.status).toBe('IN_SYNC');
    expect(run.drift?.some((d) => d.name === 'organization/dev')).toBe(false);
  });

  it('retries a transient plan error once; a persistent one is reported as ERROR', async () => {
    const runner = new FakeRunner({ 'plan:a-dev': 1, 'plan:a-test': 99 });
    const run = await runDrift({ config, runner, runId: newRunId(), trigger: 'cli', runsDir });
    expect(run.drift?.find((d) => d.name === 'a-dev')?.status).toBe('IN_SYNC');
    expect(run.drift?.find((d) => d.name === 'a-test')).toMatchObject({ status: 'ERROR', error: 'apply failed for plan:a-test' });
    expect(run.status).toBe('FAILED');
  });
});
