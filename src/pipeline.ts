import pLimit from 'p-limit';
import { ENVIRONMENTS, type Account, type Config, type EnvName } from './config.js';
import { runsDir as defaultRunsDir } from './env.js';
import type { TfRunner } from './terraform.js';
import { writeRun, type AccountStep, type DriftResult, type Ring, type Run, type RunTrigger } from './runs.js';

export const MAX_PARALLEL = 3;
export const MAX_ATTEMPTS = 2;

interface Common {
  config: Config;
  runner: TfRunner;
  runId: string;
  trigger: RunTrigger;
  runsDir?: string;
  log?: (message: string) => void;
}

export interface DeployOptions extends Common {
  ring?: EnvName;
  account?: string;
  approveProd: boolean;
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

function skipFrom(rings: Ring[], index: number): void {
  for (const ring of rings.slice(index)) {
    ring.status = 'SKIPPED';
    for (const a of ring.accounts) a.status = 'SKIPPED';
  }
}

/**
 * Rollout: organization stage, then rings dev -> test -> prod.
 * Max 3 accounts in parallel, one retry per account, a failed ring halts later rings,
 * prod only with explicit approval.
 */
export async function runDeploy(opts: DeployOptions): Promise<Run> {
  const { config, runner, log = () => {} } = opts;
  const dir = opts.runsDir ?? defaultRunsDir;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
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
    options: { ring: opts.ring, account: opts.account, approveProd: opts.approveProd },
    organization: opts.account ? undefined : { status: 'PENDING' },
    rings: plan.map((r) => ({
      name: r.name,
      status: 'PENDING',
      accounts: r.accounts.map((a) => ({ name: a.name, accountId: a.account_id, status: 'PENDING', attempts: 0 })),
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

  try {
    await runner.ensureWorkspaces(run.rings.flatMap((r) => r.accounts.map((a) => a.name)));
  } catch (e) {
    skipFrom(run.rings, 0);
    return finish('FAILED', message(e));
  }

  if (run.organization) {
    const started = Date.now();
    run.organization.status = 'RUNNING';
    save();
    try {
      run.organization.changes = await runner.applyOrg();
      run.organization.status = 'SUCCEEDED';
      log(`[organization] SUCCEEDED ${fmtChanges(run.organization.changes)}`);
    } catch (e) {
      run.organization.status = 'FAILED';
      run.organization.error = message(e);
      log(`[organization] FAILED ${message(e)}`);
    }
    run.organization.durationMs = Date.now() - started;
    if (run.organization.status === 'FAILED') {
      skipFrom(run.rings, 0);
      return finish('FAILED', 'Organization stage failed');
    }
    save();
  }

  for (const [index, ring] of run.rings.entries()) {
    if (ring.name === 'prod' && !opts.approveProd) {
      skipFrom(run.rings, index);
      log('[prod] SKIPPED (no --approve-prod)');
      break;
    }
    ring.status = 'RUNNING';
    save();

    const limit = pLimit(MAX_PARALLEL);
    await Promise.all(ring.accounts.map((step) => limit(() => deployAccount(step, ring.name))));

    if (ring.accounts.some((a) => a.status === 'FAILED')) {
      ring.status = 'FAILED';
      skipFrom(run.rings, index + 1);
      return finish('HALTED', `Ring ${ring.name} failed; later rings skipped`);
    }
    ring.status = 'SUCCEEDED';
    save();
  }
  return finish('SUCCEEDED');

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

/** terraform plan -detailed-exitcode per deployed account: 0 = in sync, 2 = drifted. */
export async function runDrift(opts: DriftOptions): Promise<Run> {
  const { config, runner, log = () => {} } = opts;
  const dir = opts.runsDir ?? defaultRunsDir;
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

  const limit = pLimit(MAX_PARALLEL);
  const results = await Promise.all(
    accounts.map((a) =>
      limit(async (): Promise<DriftResult> => {
        try {
          const plan = await runner.planAccount(a.name);
          const components = [
            ...new Set(
              plan.addresses
                .map((addr) => /^module\.([a-z]+)\./.exec(addr)?.[1])
                .filter((c): c is string => c !== undefined),
            ),
          ];
          const result: DriftResult = {
            name: a.name,
            accountId: a.account_id,
            status: plan.changed ? 'DRIFTED' : 'IN_SYNC',
            components,
          };
          log(`[drift] ${a.name} ${result.status}${components.length ? ` (${components.join(', ')})` : ''}`);
          return result;
        } catch (e) {
          log(`[drift] ${a.name} ERROR ${message(e)}`);
          return { name: a.name, accountId: a.account_id, status: 'ERROR', components: [], error: message(e) };
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
