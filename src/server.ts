import express, { type NextFunction, type Request, type Response } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import {
  ACCOUNT_NAME,
  APPROVER,
  ConfigError,
  effectiveSettings,
  ENVIRONMENTS,
  isExceptionActive,
  loadConfig,
  ouChain,
  type Account,
  type Config,
  type EnvName,
  type GovernanceException,
} from './config.js';
import { demoMode, loadEnv, repoRoot } from './env.js';
import { readAccountEstate, readOrganization, tamper } from './estate.js';
import { effectiveScps, evaluateAccount, type AccountCompliance } from './rules.js';
import { listRuns, newRunId, readRun, RUN_ID, writeRun, type Run } from './runs.js';

loadEnv();

const HOST = '127.0.0.1';
const PORT = 4000;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Read model: configuration + estate + run files, evaluated on each request.
// ---------------------------------------------------------------------------

type DriftState = 'IN_SYNC' | 'DRIFTED' | 'ERROR' | 'UNKNOWN' | 'NOT_DEPLOYED';

interface AccountRow {
  name: string;
  accountId: string;
  environment: EnvName;
  ou: string;
  managedBy: string;
  synthetic: boolean;
  canary: boolean;
  lastDeployment: { runId: string; at: string; status: string } | null;
  compliance: { score: number | null; pass: number; fail: number; excepted: number; deployed: boolean };
  drift: { status: DriftState; components: string[]; at: string | null };
}

interface Snapshot {
  config: Config;
  runs: Run[];
  rows: AccountRow[];
  compliance: Map<string, AccountCompliance>;
}

function lastDeployment(runs: Run[], name: string): AccountRow['lastDeployment'] {
  for (const run of runs) {
    if (run.kind !== 'deploy') continue;
    for (const ring of run.rings) {
      const step = ring.accounts.find((a) => a.name === name);
      if (step && (step.status === 'SUCCEEDED' || step.status === 'FAILED')) {
        return { runId: run.runId, at: step.finishedAt ?? run.startedAt, status: step.status };
      }
    }
  }
  return null;
}

/** Newest evidence wins: a drift check result, or a successful apply (which brings the account back in sync). */
function driftState(runs: Run[], name: string, deployedByTerraform: boolean): AccountRow['drift'] {
  if (!deployedByTerraform) return { status: 'NOT_DEPLOYED', components: [], at: null };
  let best: AccountRow['drift'] = { status: 'UNKNOWN', components: [], at: null };
  for (const run of runs) {
    if (run.kind === 'drift' && run.finishedAt) {
      const r = run.drift?.find((d) => d.name === name);
      if (r && (!best.at || run.finishedAt > best.at)) best = { status: r.status, components: r.components, at: run.finishedAt };
    }
    if (run.kind === 'deploy') {
      for (const ring of run.rings) {
        const step = ring.accounts.find((a) => a.name === name && a.status === 'SUCCEEDED' && a.finishedAt);
        if (step && (!best.at || step.finishedAt! > best.at)) best = { status: 'IN_SYNC', components: [], at: step.finishedAt! };
      }
    }
  }
  return best;
}

function snapshot(): Snapshot {
  const config = loadConfig();
  const org = readOrganization();
  const runs = listRuns();
  const compliance = new Map<string, AccountCompliance>();
  const rows: AccountRow[] = Object.values(config.accounts)
    .sort((a, b) => ENVIRONMENTS.indexOf(a.environment) - ENVIRONMENTS.indexOf(b.environment) || a.name.localeCompare(b.name))
    .map((account) => {
      const estate = readAccountEstate(account.account_id);
      const result = evaluateAccount({ account, rules: config.rules, exceptions: config.exceptions, estate, org });
      compliance.set(account.name, result);
      const managedBy = (estate.baseline?.managed_by as string | undefined) ?? (result.deployed ? 'unknown' : 'not deployed');
      return {
        name: account.name,
        accountId: account.account_id,
        environment: account.environment,
        ou: config.environments[account.environment].ou,
        managedBy,
        synthetic: account.synthetic === true,
        canary: account.canary === true,
        lastDeployment: lastDeployment(runs, account.name),
        compliance: { score: result.score, pass: result.pass, fail: result.fail, excepted: result.excepted, deployed: result.deployed },
        drift: driftState(runs, account.name, managedBy === 'landing-zone'),
      };
    });
  return { config, runs, rows, compliance };
}

function ratio(rows: AccountRow[]): number | null {
  const pass = rows.reduce((n, r) => n + r.compliance.pass, 0);
  const fail = rows.reduce((n, r) => n + r.compliance.fail, 0);
  return pass + fail > 0 ? pass / (pass + fail) : null;
}

function findAccount(config: Config, name: string): Account {
  const account = ACCOUNT_NAME.test(name) ? config.accounts[name] : undefined;
  if (!account) throw new HttpError(404, `Unknown account: ${name}`);
  return account;
}

/** Exceptions expiring within this many days are flagged on the Overview. */
const EXPIRY_WARNING_DAYS = 30;

function exceptionStatus(e: GovernanceException, now = new Date()) {
  const daysRemaining = Math.ceil((Date.parse(`${e.expires}T23:59:59Z`) - now.getTime()) / 86_400_000);
  const active = isExceptionActive(e, now);
  const state = !active ? 'EXPIRED' : daysRemaining <= EXPIRY_WARNING_DAYS ? 'EXPIRING' : 'ACTIVE';
  return { ...e, active, daysRemaining, state };
}

// ---------------------------------------------------------------------------
// Pipeline integration: the portal starts the same lz CLI that CI runs.
// ---------------------------------------------------------------------------

let active: { runId: string; child: ChildProcess } | null = null;

function startCli(runId: string, args: string[]): void {
  const cli = path.join(repoRoot, 'src', 'cli.ts');
  // process.execPath + shell: false works on Windows/macOS/Linux and never interprets input in a shell.
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args, '--run-id', runId, '--trigger', 'portal'], {
    cwd: repoRoot,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (d: Buffer) => {
    output = (output + d.toString()).slice(-4000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  active = { runId, child };

  const done = (error?: string) => {
    if (active?.runId === runId) active = null;
    if (!readRun(runId)) {
      writeRun({
        runId,
        kind: args[0] === 'drift' ? 'drift' : 'deploy',
        trigger: 'portal',
        status: 'FAILED',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        options: {},
        rings: [],
        error: error ?? (output.trim().split(/\r?\n/).slice(-3).join(' ') || 'CLI exited without a run file'),
      });
    }
  };
  child.on('error', (e) => done(e.message));
  child.on('close', () => done());
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(repoRoot, 'public')));

const EmptyQuery = z.object({}).strict();
const AccountsQuery = z.object({ env: z.enum(ENVIRONMENTS).optional() }).strict();
const RunRequest = z
  .object({
    kind: z.enum(['deploy', 'drift']),
    includeProd: z.boolean().optional(),
    account: z.string().regex(ACCOUNT_NAME).optional(),
    /** Required for anything that deploys to Prod; recorded in the run file. */
    approvedBy: z.string().trim().regex(APPROVER, 'must be 2-60 characters: letters, digits, space . _ @ : / ( ) -').optional(),
  })
  .strict();
const TamperRequest = z.object({ account: z.string().regex(ACCOUNT_NAME) }).strict();

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `Invalid request: ${issue.path.join('.') || '(body)'}: ${issue.message}`);
  }
  return result.data;
}

app.get('/api/summary', (req, res) => {
  parse(EmptyQuery, req.query);
  const { rows, runs, config } = snapshot();
  const deployed = rows.filter((r) => r.compliance.deployed);
  const latest = runs[0];
  const exceptions = config.exceptions.map((e) => exceptionStatus(e));
  res.json({
    accounts: rows.length,
    synthetic: rows.filter((r) => r.synthetic).length,
    managed: rows.filter((r) => r.managedBy === 'landing-zone').length,
    legacy: rows.filter((r) => r.managedBy === 'manual').length,
    notDeployed: rows.filter((r) => !r.compliance.deployed).length,
    compliance: ratio(deployed),
    nonCompliant: rows.filter((r) => r.compliance.fail > 0).length,
    drifted: rows.filter((r) => r.drift.status === 'DRIFTED').length,
    activeExceptions: exceptions.filter((e) => e.active).length,
    exceptionAlerts: exceptions
      .filter((e) => e.state !== 'ACTIVE')
      .map((e) => ({ id: e.id, account: e.account, rule: e.rule, expires: e.expires, state: e.state, daysRemaining: e.daysRemaining })),
    organizationStages: readOrganization()?.stages ?? [],
    lastRun: latest ? { runId: latest.runId, kind: latest.kind, status: latest.status, startedAt: latest.startedAt } : null,
    activeRunId: active?.runId ?? null,
    demoMode: demoMode(),
    byEnvironment: ENVIRONMENTS.map((env) => {
      const envRows = rows.filter((r) => r.environment === env);
      return {
        environment: env,
        accounts: envRows.length,
        deployed: envRows.filter((r) => r.compliance.deployed).length,
        compliance: ratio(envRows),
      };
    }),
  });
});

app.get('/api/accounts', (req, res) => {
  const { env } = parse(AccountsQuery, req.query);
  const { rows } = snapshot();
  res.json(env ? rows.filter((r) => r.environment === env) : rows);
});

app.get('/api/accounts/:name', (req, res) => {
  parse(EmptyQuery, req.query);
  const snap = snapshot();
  const account = findAccount(snap.config, req.params.name);
  const row = snap.rows.find((r) => r.name === account.name)!;
  const estate = readAccountEstate(account.account_id);
  const org = readOrganization();

  // Prefer what Terraform recorded in the estate; fall back to the desired config for unmanaged accounts.
  const recorded = estate.baseline?.managed_by === 'landing-zone';
  const settings = recorded
    ? Object.entries(estate.baseline!.settings as Record<string, unknown>).map(([key, value]) => ({
        key,
        value,
        source: (estate.baseline!.setting_sources as Record<string, string>)[key] ?? 'global',
      }))
    : Object.entries(effectiveSettings(snap.config, account)).map(([key, v]) => ({ key, value: v.value, source: v.source }));

  res.json({
    ...row,
    owner: account.owner,
    businessUnit: account.business_unit,
    costCenter: account.cost_center,
    results: snap.compliance.get(account.name)!.results,
    settings,
    settingsRecorded: recorded,
    network: estate.network ?? null,
    access: estate.access ?? null,
    securityServices: estate.baseline?.security_services ?? null,
    tags: estate.baseline?.tags ?? null,
    scps: effectiveScps(org, account.name, account.account_id),
    exceptions: snap.config.exceptions
      .filter((e) => e.account === account.name)
      .map((e) => exceptionStatus(e)),
  });
});

app.get('/api/governance', (req, res) => {
  parse(EmptyQuery, req.query);
  const config = loadConfig();
  const org = config.organization;
  const scpsFor = (env: EnvName) => ouChain(org.ous, config.environments[env].ou).flatMap((ou) => org.ous[ou].scp);
  const setting = (env: EnvName) => ({ ...config.global.defaults, ...config.environments[env].settings });
  const perEnv = (fn: (env: EnvName) => string) => Object.fromEntries(ENVIRONMENTS.map((e) => [e, fn(e)]));
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

  const rows = [
    { label: 'OU', values: perEnv((e) => config.environments[e].ou) },
    {
      label: 'Public IPs',
      values: perEnv((e) => {
        const scp = scpsFor(e).includes('DenyPublicIp');
        if (setting(e).allow_public_ip) return scp ? 'Allowed (setting), denied by SCP' : 'Allowed';
        return scp ? 'Denied (setting + SCP)' : 'Denied (setting)';
      }),
    },
    { label: 'IAM users', values: perEnv((e) => (scpsFor(e).includes('DenyIamUsers') ? 'Denied (SCP)' : 'Allowed')) },
    { label: 'Large instances', values: perEnv((e) => (scpsFor(e).includes('DenyLargeInstances') ? 'Denied (SCP)' : 'Allowed')) },
    { label: 'Backup', values: perEnv((e) => (setting(e).backup_required ? 'Required' : 'No')) },
    { label: 'Log retention', values: perEnv((e) => `${setting(e).log_retention_days} days`) },
    { label: 'Budget', values: perEnv((e) => usd(setting(e).budget_usd)) },
    { label: 'Developer access', values: perEnv((e) => config.environments[e].access.developers ?? '-') },
    { label: 'SRE access', values: perEnv((e) => config.environments[e].access.sre ?? '-') },
    { label: 'Network CIDR pool', values: perEnv((e) => config.environments[e].network.cidr_pool) },
    { label: 'TGW route table', values: perEnv((e) => config.environments[e].network.tgw_route_table) },
  ];

  const workloadAccounts = Object.values(config.accounts);
  const ous = Object.entries(org.ous).map(([name, ou]) => ({
    name,
    parent: ou.parent ?? null,
    scp: ou.scp,
    accounts: [
      ...org.core_accounts.filter((a) => a.ou === name).map((a) => a.name),
      ...workloadAccounts.filter((a) => config.environments[a.environment].ou === name).map((a) => a.name).sort(),
    ],
  }));

  const deployedOrg = readOrganization();
  const coreName = (name: string) => org.core_accounts.find((a) => a.name === name);
  res.json({
    environments: ENVIRONMENTS,
    comparison: rows,
    ous,
    organizationDeployed: deployedOrg !== undefined,
    organizationStages: deployedOrg?.stages ?? [],
    sharedServices: Object.entries(org.shared_services).map(([role, name]) => ({ role, account: name, id: coreName(name)?.id ?? null })),
    globalStandards: {
      allowedRegions: config.global.allowed_regions,
      mandatoryTags: config.global.mandatory_tags,
      securityServices: config.global.security_services,
      hardening: config.global.hardening,
    },
    exceptions: config.exceptions.map((e) => exceptionStatus(e)),
    rules: config.rules.map((r) => ({ id: r.id, title: r.title, environments: r.environments, severity: r.severity })),
  });
});

app.get('/api/runs', (req, res) => {
  parse(EmptyQuery, req.query);
  res.json(
    listRuns()
      .slice(0, 25)
      .map((r) => ({
        runId: r.runId,
        kind: r.kind,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
        options: r.options,
      })),
  );
});

app.get('/api/runs/:runId', (req, res) => {
  if (!RUN_ID.test(req.params.runId)) throw new HttpError(400, 'Invalid run ID');
  const run = readRun(req.params.runId);
  if (!run) throw new HttpError(404, 'Run not found');
  res.json(run);
});

app.post('/api/runs', (req, res) => {
  const body = parse(RunRequest, req.body);
  if (active) throw new HttpError(409, `Run ${active.runId} is still in progress`);
  const config = loadConfig();

  const args: string[] = [];
  let touchesProd = false;
  if (body.kind === 'drift') {
    if (body.account || body.includeProd || body.approvedBy) throw new HttpError(400, 'Drift detection runs for all accounts');
    args.push('drift');
  } else if (body.account) {
    const account = findAccount(config, body.account);
    args.push('apply', '--account', account.name);
    touchesProd = account.environment === 'prod';
  } else {
    args.push('apply');
    touchesProd = body.includeProd === true;
  }
  if (touchesProd) {
    // Same gate as CI: Prod (and Root/core SCPs) only with a named approver, recorded in the run file.
    if (!body.approvedBy) throw new HttpError(403, 'Production approval required: approvedBy is missing');
    args.push('--approve-prod', `--approved-by=${body.approvedBy}`);
  } else if (body.approvedBy) {
    throw new HttpError(400, 'approvedBy is only accepted for Prod deployments');
  }

  const runId = newRunId();
  startCli(runId, args);
  res.status(202).json({ runId });
});

app.post('/api/demo/tamper', (req, res) => {
  if (!demoMode()) throw new HttpError(404, 'Not found');
  const { account: name } = parse(TamperRequest, req.body);
  if (active) throw new HttpError(409, `Run ${active.runId} is still in progress`);
  const account = findAccount(loadConfig(), name);
  try {
    tamper(account.account_id);
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  res.json({ account: account.name, change: 'network.public_subnets = true (manual console change)' });
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof ConfigError) {
    res.status(500).json({ error: err.message });
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON body' });
  } else if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large' });
  } else {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Governance portal: http://${HOST}:${PORT}  (demo mode: ${demoMode() ? 'on' : 'off'})`);
});
