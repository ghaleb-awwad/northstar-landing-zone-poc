import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { configDir as defaultConfigDir, policiesDir as defaultPoliciesDir } from './env.js';

export const ENVIRONMENTS = ['dev', 'test', 'prod'] as const;
export type EnvName = (typeof ENVIRONMENTS)[number];

export const SCP_STATEMENTS = [
  'DenyLeaveOrganization',
  'ProtectSecurityTooling',
  'RestrictRegions',
  'DenyLargeInstances',
  'DenyIamUsers',
  'DenyPublicIp',
] as const;

export const ACCOUNT_NAME = /^[a-z][a-z0-9-]{2,40}$/;

const AccountId = z.string().regex(/^\d{12}$/, 'must be a 12-digit AWS account ID');
const ScpName = z.enum(SCP_STATEMENTS);
const EnvEnum = z.enum(ENVIRONMENTS);

const SettingsSchema = z
  .object({
    allow_public_ip: z.boolean(),
    backup_required: z.boolean(),
    log_retention_days: z.number().int().positive(),
    budget_usd: z.number().positive(),
  })
  .strict();

const OrganizationSchema = z
  .object({
    ous: z.record(z.string(), z.object({ parent: z.string().optional(), scp: z.array(ScpName) }).strict()),
    core_accounts: z.array(
      z.object({ id: AccountId, name: z.string().regex(ACCOUNT_NAME), ou: z.string() }).strict(),
    ),
  })
  .strict();

const GlobalSchema = z
  .object({
    allowed_regions: z.array(z.string()).min(1),
    mandatory_tags: z.array(z.string()),
    defaults: SettingsSchema,
    security_services: z.record(z.string(), z.boolean()),
    hardening: z.record(z.string(), z.boolean()),
  })
  .strict();

const EnvironmentSchema = z
  .object({
    ou: z.string(),
    settings: SettingsSchema.partial(),
    network: z
      .object({
        cidr_pool: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/16$/, 'must be a /16 CIDR'),
        tgw_route_table: z.string(),
      })
      .strict(),
    access: z.record(z.string(), z.string()),
  })
  .strict();

const AccountSchema = z
  .object({
    account_id: AccountId,
    environment: EnvEnum,
    owner: z.string().email(),
    business_unit: z.string().min(1),
    cost_center: z.string().min(1),
    network_index: z.number().int().min(1).max(255),
    overrides: SettingsSchema.partial().default({}),
  })
  .strict();

const ExceptionSchema = z
  .object({
    id: z.string().regex(/^EXC-\d{4}$/),
    account: z.string(),
    rule: z.string(),
    scp_statement: ScpName.optional(),
    reason: z.string().min(1),
    approved_by: z.string().min(1),
    expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  })
  .strict();

const EstatePath = z.string().regex(/^(baseline|network|access)(\.[A-Za-z0-9_]+)+$/);
const CheckSchema = z.union([
  z.object({ path: EstatePath, equals: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ path: EstatePath, gte: z.number() }).strict(),
  z.object({ path: EstatePath, lte: z.number() }).strict(),
  z.object({ path: EstatePath, hasKeys: z.array(z.string()).min(1) }).strict(),
  z.object({ scp: ScpName }).strict(),
]);

const RuleSchema = z
  .object({
    id: z.string().regex(/^[A-Z]{3}-\d{2}$/),
    title: z.string(),
    environments: z.array(EnvEnum).min(1),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    checks: z.array(CheckSchema).min(1),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type GlobalConfig = z.infer<typeof GlobalSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type Account = z.infer<typeof AccountSchema> & { name: string };
export type GovernanceException = z.infer<typeof ExceptionSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type Rule = z.infer<typeof RuleSchema>;

export interface Config {
  organization: Organization;
  global: GlobalConfig;
  environments: Record<EnvName, Environment>;
  accounts: Record<string, Account>;
  exceptions: GovernanceException[];
  rules: Rule[];
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

export interface ConfigDirs {
  configDir: string;
  policiesDir: string;
}

const defaultDirs: ConfigDirs = { configDir: defaultConfigDir, policiesDir: defaultPoliciesDir };

/** Loads, schema-validates and cross-checks all configuration. Throws ConfigError listing every problem. */
export function loadConfig(dirs: ConfigDirs = defaultDirs): Config {
  const problems: string[] = [];

  const read = <T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | undefined => {
    const rel = path.relative(path.dirname(dirs.configDir), file).replace(/\\/g, '/');
    if (!existsSync(file)) {
      problems.push(`${rel}: file not found`);
      return undefined;
    }
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, 'utf8'));
    } catch (e) {
      problems.push(`${rel}: invalid YAML (${(e as Error).message.split('\n')[0]})`);
      return undefined;
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push(`${rel}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      return undefined;
    }
    return result.data;
  };

  const yamlFiles = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort() : [];

  const organization = read(path.join(dirs.configDir, 'organization.yaml'), OrganizationSchema);
  const global = read(path.join(dirs.configDir, 'global.yaml'), GlobalSchema);
  const exceptions = read(
    path.join(dirs.configDir, 'exceptions.yaml'),
    z.object({ exceptions: z.array(ExceptionSchema) }).strict(),
  )?.exceptions;
  const rules = read(
    path.join(dirs.policiesDir, 'rules.yaml'),
    z.object({ rules: z.array(RuleSchema) }).strict(),
  )?.rules;

  const environments: Partial<Record<EnvName, Environment>> = {};
  for (const env of ENVIRONMENTS) {
    const e = read(path.join(dirs.configDir, 'environments', `${env}.yaml`), EnvironmentSchema);
    if (e) environments[env] = e;
  }
  for (const f of yamlFiles(path.join(dirs.configDir, 'environments'))) {
    const name = f.replace(/\.yaml$/, '');
    if (!(ENVIRONMENTS as readonly string[]).includes(name)) {
      problems.push(`config/environments/${f}: unknown environment (expected ${ENVIRONMENTS.join(', ')})`);
    }
  }

  const accounts: Record<string, Account> = {};
  for (const f of yamlFiles(path.join(dirs.configDir, 'accounts'))) {
    const name = f.replace(/\.yaml$/, '');
    if (!ACCOUNT_NAME.test(name)) {
      problems.push(`config/accounts/${f}: file name must be a valid account name (${ACCOUNT_NAME})`);
      continue;
    }
    const a = read(path.join(dirs.configDir, 'accounts', f), AccountSchema);
    if (a) accounts[name] = { ...a, name };
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const config: Config = {
    organization: organization!,
    global: global!,
    environments: environments as Record<EnvName, Environment>,
    accounts,
    exceptions: exceptions!,
    rules: rules!,
  };
  const crossProblems = crossCheck(config);
  if (crossProblems.length > 0) throw new ConfigError(crossProblems);
  return config;
}

function crossCheck(cfg: Config): string[] {
  const problems: string[] = [];
  const ous = cfg.organization.ous;

  for (const [name, ou] of Object.entries(ous)) {
    if (ou.parent === undefined && name !== 'Root') problems.push(`organization.yaml: OU ${name} has no parent`);
    if (ou.parent !== undefined && !ous[ou.parent]) problems.push(`organization.yaml: OU ${name} has unknown parent ${ou.parent}`);
  }
  if (!ous.Root) problems.push('organization.yaml: Root OU is missing');

  const ids = new Map<string, string>();
  const claimId = (id: string, owner: string) => {
    const existing = ids.get(id);
    if (existing) problems.push(`account ID ${id} is used by both ${existing} and ${owner}`);
    else ids.set(id, owner);
  };
  for (const core of cfg.organization.core_accounts) {
    if (!ous[core.ou]) problems.push(`organization.yaml: core account ${core.name} is in unknown OU ${core.ou}`);
    if (cfg.accounts[core.name]) problems.push(`accounts/${core.name}.yaml: name clashes with a core account`);
    claimId(core.id, core.name);
  }

  for (const [env, e] of Object.entries(cfg.environments)) {
    if (!ous[e.ou]) problems.push(`environments/${env}.yaml: unknown OU ${e.ou}`);
  }

  const indexes = new Map<string, string>();
  for (const a of Object.values(cfg.accounts)) {
    claimId(a.account_id, a.name);
    const key = `${a.environment}:${a.network_index}`;
    const other = indexes.get(key);
    if (other) problems.push(`accounts/${a.name}.yaml: network_index ${a.network_index} already used by ${other} in ${a.environment}`);
    else indexes.set(key, a.name);
  }

  const ruleIds = new Set<string>();
  for (const r of cfg.rules) {
    if (ruleIds.has(r.id)) problems.push(`rules.yaml: duplicate rule ${r.id}`);
    ruleIds.add(r.id);
  }

  const excIds = new Set<string>();
  for (const e of cfg.exceptions) {
    if (excIds.has(e.id)) problems.push(`exceptions.yaml: duplicate exception ${e.id}`);
    excIds.add(e.id);
    const account = cfg.accounts[e.account];
    const rule = cfg.rules.find((r) => r.id === e.rule);
    if (!account) problems.push(`exceptions.yaml: ${e.id} refers to unknown account ${e.account}`);
    if (!rule) problems.push(`exceptions.yaml: ${e.id} refers to unknown rule ${e.rule}`);
    if (account && rule && !rule.environments.includes(account.environment)) {
      problems.push(`exceptions.yaml: ${e.id}: rule ${e.rule} does not apply to ${account.environment}`);
    }
    if (account && e.scp_statement) {
      const chain = ouChain(ous, cfg.environments[account.environment].ou);
      if (!chain.some((ou) => ous[ou]?.scp.includes(e.scp_statement!))) {
        problems.push(`exceptions.yaml: ${e.id}: ${e.scp_statement} is not applied to ${e.account}'s OU`);
      }
    }
  }
  return problems;
}

/** The OU and all its ancestors, nearest first. */
export function ouChain(ous: Record<string, { parent?: string | null }>, ou: string): string[] {
  const chain: string[] = [];
  let current: string | undefined | null = ou;
  while (current && ous[current] && !chain.includes(current)) {
    chain.push(current);
    current = ous[current].parent;
  }
  return chain;
}

export type SettingSource = 'global' | 'environment' | 'account';

/** Mirrors the Terraform merge: global.defaults <- environment.settings <- account.overrides. */
export function effectiveSettings(cfg: Config, account: Account): Record<string, { value: unknown; source: SettingSource }> {
  const env = cfg.environments[account.environment];
  const result: Record<string, { value: unknown; source: SettingSource }> = {};
  for (const [k, v] of Object.entries(cfg.global.defaults)) result[k] = { value: v, source: 'global' };
  for (const [k, v] of Object.entries(env.settings)) result[k] = { value: v, source: 'environment' };
  for (const [k, v] of Object.entries(account.overrides)) result[k] = { value: v, source: 'account' };
  return result;
}

/** An exception is active until the end of its expiry day (UTC), matching the Terraform check. */
export function isExceptionActive(e: GovernanceException, now: Date = new Date()): boolean {
  return now.getTime() <= Date.parse(`${e.expires}T23:59:59Z`);
}
