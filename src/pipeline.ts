import pLimit from 'p-limit';
import { ENVIRONMENTS, ORG_STAGES, type Account, type Config, type EnvName, type OrgStage } from './config.js';
import { runsDir as defaultRunsDir } from './env.js';
import type { TfRunner } from './terraform.js';
import { writeRun, type AccountStep, type DriftResult, type OrgStep, type Ring, type Run, type RunTrigger } from './runs.js';

export const MAX_PARALLEL = 3;
export const MAX_ATTEMPTS = 2;
/** A wave stops starting new accounts once more than this share of it has failed. */
export const FAILURE_BUDGET = 0.1;

/**
 * Organization stages applied at the start of each ring. Environment OU SCPs follow their ring.
 * Root and the shared OUs ("core") affect every account, so they wait for the Prod approval.
 */
export const ORG_STAGES_BY_RING: Record<EnvName, OrgStage[]> = { dev: ['dev'], test: ['test'], prod: ['core', 'prod'] };

interface Common {
  config: Config;
  runner: TfRunner;
  runId: string;
  trigger: RunTrigger;
  runsDir?: string;
  maxParallel?: number;
  log?: (message: string) => void;
}

export interface DeployOptions extends Common {
  ring?: EnvName;
  account?: string;
  approveProd: boolean;
  /** Recorded in the run file when Prod is approved. */
  approvedBy?: string;
  retryDelayMs?: number;
  /** Accounts whose first attempt fails with a simulated transient error (demo mode only). */
  simulateTransient?: string[];
}

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function accountsByRing(config: Config, opts: Pick<DeployOptions, 'ring' | 'account'>): { name: EnvName; accounts: Account[] }[] {
  if (opts.account) {
    const account = config.accounts[opts.account];
    if (!account) throw new Error(`Unknown account: ${opts.account}`);
    return [{ name: account.environment, accounts: [account] }];
  }
  return ENVIRONMENTS.filter((env) => !opts.ring || env === opts.ring).map((env) => ({
    name: env,
    accounts: Object.values(config.accounts)
      .filter((a) => a.environment === env)
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function skipSteps(steps: AccountStep[], reason: string): void {
  for (const s of steps) {
    if (s.status !== 'PENDING') continue;
    s.status = 'SKIPPED';
    s.error = reason;
  }
}

function skipFrom(rings: Ring[], index: number, reason?: string): void {
  for (const ring of rings.slice(index)) {
    ring.status = 'SKIPPED';
    if (reason) ring.reason = reason;
    for (const o of ring.organization) if (o.status === 'PENDING') o.status = 'SKIPPED';
    skipSteps(ring.accounts, reason ?? 'Earlier stage failed');
  }
}

/**
 * Rollout, ring by ring (dev -> test -> prod). Each ring:
 *   1. applies its organization stage(s): the environment OU's SCPs (Prod also: Root/core),
 *   2. deploys canary accounts first; if a canary fails, the rest of the ring is skipped,
 *   3. deploys the rest, max N in parallel, one retry per account, and stops starting new
 *      accounts once failures exceed the failure budget.
 * A failed ring halts later rings. Prod (and core) only with explicit approval.
 */
export async function runDeploy(opts: DeployOptions): Promise<Run> {
  const { config, runner, log = () => {} } = opts;
  const dir = opts.runsDir ?? defaultRunsDir;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const parallel = opts.maxParallel ?? MAX_PARALLEL;
  const simulate = new Set(opts.simulateTransient ?? []);

  const plan = accountsByRing(config, opts);
  if (opts.account && plan[0].name === 'prod' && !opts.approveProd) {
    throw new Error(`${opts.account} is a production account: --approve-prod is required.`);
  }

  const run: Run = {
    runId: opts.runId,
    kind: 'deploy',
    trigger: opts.trigger,
    status: 'RUNNING',
    startedAt: now(),
    options: {
      ring: opts.ring,
      account: opts.account,
      approveProd: opts.approveProd,
      approvedBy: opts.approveProd ? opts.approvedBy : undefined,
    },
    rings: plan.map((r) => ({
      name: r.name,
      status: 'PENDING',
      organization: opts.account ? [] : ORG_STAGES_BY_RING[r.name].map((stage) => ({ stage, status: 'PENDING' })),
      accounts: r.accounts.map((a) => ({
        name: a.name,
        accountId: a.account_id,
        status: 'PENDING',
        attempts: 0,
        ...(a.canary ? { canary: true } : {}),
      })),
    })),
  };
  const save = () => writeRun(run, dir);
  const finish = (status: Run['status'], error?: string) => {
    run.status = status;
    run.finishedAt = now();
    if (error) run.error = error;
    save();
    log(`Run ${run.runId}: ${status}${error ? ` (${error})` : ''}`);
    return run;
  };
  save();

  for (const [index, ring] of run.rings.entries()) {
    if (ring.name === 'prod' && !opts.approveProd) {
      skipFrom(run.rings, index, 'Awaiting production approval');
      log('[prod] SKIPPED (awaiting production approval)');
      return finish('PARTIAL', 'Prod not approved: Root/core and Prod were not deployed');
    }
    ring.status = 'RUNNING';
    save();

    for (const step of ring.organization) {
      await applyOrgStage(step);
      if (step.status === 'FAILED') {
        ring.status = 'FAILED';
        skipSteps(ring.accounts, `Organization stage ${step.stage} failed`);
        skipFrom(run.rings, index + 1, `Ring ${ring.name} failed`);
        return finish('HALTED', `Organization stage ${step.stage} failed; later rings skipped`);
      }
    }

    const canaries = ring.accounts.filter((a) => a.canary);
    const rest = ring.accounts.filter((a) => !a.canary);
    await runWave(canaries, 0, ring.name);
    if (canaries.some((a) => a.status === 'FAILED')) {
      skipSteps(rest, 'Canary failed');
    } else {
      await runWave(rest, Math.floor(rest.length * FAILURE_BUDGET), ring.name);
    }

    if (ring.accounts.some((a) => a.status === 'FAILED')) {
      ring.status = 'FAILED';
      skipFrom(run.rings, index + 1, `Ring ${ring.name} failed`);
      return finish('HALTED', `Ring ${ring.name} failed; later rings skipped`);
    }
    ring.status = 'SUCCEEDED';
    save();
  }
  return finish('SUCCEEDED');

  async function applyOrgStage(step: OrgStep): Promise<void> {
    const started = Date.now();
    step.status = 'RUNNING';
    save();
    try {
      step.changes = await runner.applyOrg(step.stage as OrgStage);
      step.status = 'SUCCEEDED';
      log(`[organization/${step.stage}] SUCCEEDED ${fmtChanges(step.changes)}`);
    } catch (e) {
      step.status = 'FAILED';
      step.error = message(e);
      log(`[organization/${step.stage}] FAILED ${step.error}`);
    }
    step.durationMs = Date.now() - started;
    save();
  }

  /** Deploys a wave; once failures exceed the budget, accounts not yet started are skipped. */
  async function runWave(steps: AccountStep[], budget: number, ringName: string): Promise<void> {
    const limit = pLimit(parallel);
    let failures = 0;
    await Promise.all(
      steps.map((step) =>
        limit(async () => {
          if (failures > budget) {
            step.status = 'SKIPPED';
            step.error = `Not started: failure budget exceeded (${failures} failed, budget ${budget})`;
            save();
            return;
          }
          await deployAccount(step, ringName);
          if (step.status === 'FAILED') failures++;
        }),
      ),
    );
  }

  async function deployAccount(step: AccountStep, ringName: string): Promise<void> {
    const started = Date.now();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      step.attempts = attempt;
      step.status = attempt === 1 ? 'RUNNING' : 'RETRYING';
      save();
      try {
        if (attempt === 1 && simulate.has(step.name)) {
          throw new Error('ThrottlingException (simulated): Rate exceeded');
        }
        step.changes = await runner.applyAccount(step.name);
        step.status = 'SUCCEEDED';
        delete step.error;
        break;
      } catch (e) {
        step.error = message(e);
        log(`[${ringName}] ${step.name} attempt ${attempt} failed: ${step.error}`);
        if (attempt < MAX_ATTEMPTS) {
          step.status = 'RETRYING';
          save();
          await sleep(retryDelayMs);
        } else {
          step.status = 'FAILED';
        }
      }
    }
    step.durationMs = Date.now() - started;
    step.finishedAt = now();
    log(`[${ringName}] ${step.name} ${step.status} ${step.changes ? fmtChanges(step.changes) : ''} attempts=${step.attempts}`);
    save();
  }
}

export interface DriftOptions extends Common {}

/** module.network.local_file.network -> network; local_file.organization -> organization */
function components(addresses: string[]): string[] {
  return [...new Set(addresses.map((addr) => /^module\.([a-z_]+)[.[]/.exec(addr)?.[1] ?? addr.split('.')[1]).filter(Boolean))];
}

/**
 * terraform plan -detailed-exitcode per deployed organization stage and account: 0 = in sync, 2 = drifted.
 * Organization stages also drift when a governance exception expires (its SCP exemption must be removed).
 */
export async function runDrift(opts: DriftOptions): Promise<Run> {
  const { config, runner, log = () => {} } = opts;
  const dir = opts.runsDir ?? defaultRunsDir;
  const stages = ORG_STAGES.filter((s) => runner.hasOrgState(s));
  const accounts = Object.values(config.accounts)
    .filter((a) => runner.hasState(a.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const run: Run = {
    runId: opts.runId,
    kind: 'drift',
    trigger: opts.trigger,
    status: 'RUNNING',
    startedAt: now(),
    options: {},
    rings: [],
    drift: [],
  };
  writeRun(run, dir);

  const targets = [
    ...stages.map((s) => ({ name: `organization/${s}`, accountId: '', kind: 'organization' as const, plan: () => runner.planOrg(s) })),
    ...accounts.map((a) => ({ name: a.name, accountId: a.account_id, kind: 'account' as const, plan: () => runner.planAccount(a.name) })),
  ];
  const limit = pLimit(opts.maxParallel ?? MAX_PARALLEL);
  const results = await Promise.all(
    targets.map((t) =>
      limit(async (): Promise<DriftResult> => {
        const base = { name: t.name, accountId: t.accountId, kind: t.kind };
        for (let attempt = 1; ; attempt++) {
          try {
            const plan = await t.plan();
            const result: DriftResult = { ...base, status: plan.changed ? 'DRIFTED' : 'IN_SYNC', components: components(plan.addresses) };
            log(`[drift] ${t.name} ${result.status}${result.components.length ? ` (${result.components.join(', ')})` : ''}`);
            return result;
          } catch (e) {
            // Same retry policy as apply: transient errors (throttling, provider start-up) get one more attempt.
            if (attempt < MAX_ATTEMPTS) {
              log(`[drift] ${t.name} attempt ${attempt} failed, retrying: ${message(e)}`);
              continue;
            }
            log(`[drift] ${t.name} ERROR ${message(e)}`);
            return { ...base, status: 'ERROR', components: [], error: message(e) };
          }
        }
      }),
    ),
  );
  run.drift = results;
  run.status = results.some((r) => r.status === 'ERROR') ? 'FAILED' : 'SUCCEEDED';
  run.finishedAt = now();
  writeRun(run, dir);
  return run;
}

export function fmtChanges(c: { add: number; change: number; destroy: number }): string {
  return `+${c.add} ~${c.change} -${c.destroy}`;
}
