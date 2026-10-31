import { parseArgs } from 'node:util';
import { ConfigError, ENVIRONMENTS, loadConfig, type EnvName } from './config.js';
import { demoMode, loadEnv, simulatedTransientAccounts } from './env.js';
import { resetDemoConfig, seedLegacy, tamper } from './estate.js';
import { fmtChanges, runDeploy, runDrift } from './pipeline.js';
import { evaluateAll, type AccountCompliance } from './rules.js';
import { newRunId, readRun, RUN_ID, writeRun, type Run, type RunTrigger } from './runs.js';
import { TerraformCli } from './terraform.js';

loadEnv();

const USAGE = `Usage: npm run lz -- <command> [options]

Commands:
  validate                         Validate all configuration
  plan    [--account <name>]       Terraform plan for the organization and each account
  apply   [--ring dev|test|prod] [--account <name>] [--approve-prod]
                                   Roll out: organization, then dev -> test -> prod
  drift                            Detect drift (terraform plan -detailed-exitcode per account)
  evaluate [--markdown]            Compliance per account
  seed    [--reset-demo-config]    Reset .lz/ and create the legacy (unmanaged) estate
  tamper  --account <name>         Demo only: simulate a manual console change`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    account: { type: 'string' },
    ring: { type: 'string' },
    'approve-prod': { type: 'boolean', default: false },
    'run-id': { type: 'string' },
    trigger: { type: 'string' },
    markdown: { type: 'boolean', default: false },
    'reset-demo-config': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const log = (m: string) => console.log(m);

function runIdOption(): string {
  const id = opts['run-id'] ?? newRunId();
  if (!RUN_ID.test(id)) throw new Error(`Invalid --run-id: ${id}`);
  return id;
}

function triggerOption(): RunTrigger {
  const t = opts.trigger ?? (process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'cli');
  if (t !== 'cli' && t !== 'portal' && t !== 'ci') throw new Error(`Invalid --trigger: ${t}`);
  return t;
}

function ringOption(): EnvName | undefined {
  const r = opts.ring;
  if (r === undefined) return undefined;
  if (!(ENVIRONMENTS as readonly string[]).includes(r)) throw new Error(`Invalid --ring: ${r} (expected ${ENVIRONMENTS.join('|')})`);
  return r as EnvName;
}

function pct(score: number | null): string {
  return score === null ? '-' : `${Math.round(score * 100)}%`;
}

function printCompliance(results: AccountCompliance[], markdown: boolean): void {
  const rows = results.map((r) => ({
    account: r.account,
    env: r.environment,
    deployed: r.deployed ? 'yes' : 'no',
    score: pct(r.score),
    pass: r.pass,
    fail: r.fail,
    excepted: r.excepted,
    failing: r.results.filter((x) => x.status === 'FAIL').map((x) => x.id).join(' ') || '-',
  }));
  if (markdown) {
    console.log('## Compliance by account\n');
    console.log('| Account | Env | Deployed | Score | Pass | Fail | Excepted | Failing rules |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      console.log(`| ${r.account} | ${r.env} | ${r.deployed} | ${r.score} | ${r.pass} | ${r.fail} | ${r.excepted} | ${r.failing} |`);
    }
  } else {
    console.table(rows);
  }
}

async function main(): Promise<number> {
  const [command] = positionals;
  if (opts.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  switch (command) {
    case 'validate': {
      const cfg = loadConfig();
      console.log(
        `Configuration valid: ${Object.keys(cfg.accounts).length} accounts, ${cfg.rules.length} rules, ${cfg.exceptions.length} exceptions.`,
      );
      return 0;
    }

    case 'plan': {
      const cfg = loadConfig();
      const tf = new TerraformCli();
      const names = opts.account ? [opts.account] : Object.keys(cfg.accounts).sort();
      for (const n of names) if (!cfg.accounts[n]) throw new Error(`Unknown account: ${n}`);
      await tf.ensureWorkspaces(names);
      const rows: Record<string, string | number>[] = [];
      if (!opts.account) {
        const p = await tf.planOrg();
        rows.push({ target: 'organization', ...p.changes, status: p.changed ? 'CHANGES' : 'NO CHANGES' });
      }
      for (const n of names) {
        const p = await tf.planAccount(n);
        rows.push({ target: n, ...p.changes, status: p.changed ? 'CHANGES' : 'NO CHANGES' });
      }
      console.table(rows);
      return 0;
    }

    case 'apply': {
      const cfg = loadConfig();
      const run = await runDeploy({
        config: cfg,
        runner: new TerraformCli(),
        runId: runIdOption(),
        trigger: triggerOption(),
        ring: ringOption(),
        account: opts.account,
        approveProd: opts['approve-prod'] ?? false,
        simulateTransient: simulatedTransientAccounts(),
        log,
      });
      if (run.organization?.changes) console.log(`organization: ${fmtChanges(run.organization.changes)}`);
      return run.status === 'SUCCEEDED' ? 0 : 1;
    }

    case 'drift': {
      const cfg = loadConfig();
      const run = await runDrift({ config: cfg, runner: new TerraformCli(), runId: runIdOption(), trigger: triggerOption(), log });
      const drifted = run.drift?.filter((d) => d.status !== 'IN_SYNC').length ?? 0;
      console.log(`${run.drift?.length ?? 0} accounts checked, ${drifted} drifted or failed.`);
      return run.status === 'SUCCEEDED' ? 0 : 1;
    }

    case 'evaluate': {
      printCompliance(evaluateAll(loadConfig()), opts.markdown ?? false);
      return 0;
    }

    case 'seed': {
      if (opts['reset-demo-config']) for (const c of resetDemoConfig()) console.log(`Demo config: ${c}`);
      const seeded = seedLegacy(loadConfig());
      console.log(`Estate reset. Legacy (unmanaged) accounts: ${seeded.join(', ') || 'none'}.`);
      return 0;
    }

    case 'tamper': {
      if (!demoMode()) throw new Error('tamper is only available when LZ_DEMO_MODE=true');
      const cfg = loadConfig();
      const account = opts.account ? cfg.accounts[opts.account] : undefined;
      if (!account) throw new Error('tamper requires --account <name> of a configured account');
      tamper(account.account_id);
      console.log(`Simulated manual change on ${account.name}: network.public_subnets = true`);
      return 0;
    }

    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const text = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    console.error(text);
    // If a caller (the portal) is waiting on this run ID, make sure the run reports the failure.
    const id = opts['run-id'];
    if (id && RUN_ID.test(id) && !readRun(id)) {
      const run: Run = {
        runId: id,
        kind: positionals[0] === 'drift' ? 'drift' : 'deploy',
        trigger: 'portal',
        status: 'FAILED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        options: {},
        rings: [],
        error: text,
      };
      writeRun(run);
    }
    process.exit(1);
  },
);
