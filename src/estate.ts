import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { ORG_STAGES, type Account, type Config, type EnvName } from './config.js';
import { configDir, estateDir as defaultEstateDir, lzDir, syntheticDir } from './env.js';

/** Contents of the simulated AWS estate written by Terraform (or by hand, for legacy accounts). */
export interface AccountEstate {
  baseline?: Record<string, any>;
  network?: Record<string, any>;
  access?: Record<string, any>;
}

/** Merged view of the organization stages (organization/<stage>.json) that have been deployed. */
export interface OrganizationEstate {
  ous: Record<string, { parent: string | null; scp: string[] }>;
  policies: Record<string, { Version: string; Statement: Record<string, unknown>[] }>;
  exemptions: Record<string, string[]>;
  accounts: Record<string, { id: string; ou: string; type: 'core' | 'workload' }>;
  stages?: string[];
}

export const COMPONENTS = ['baseline', 'network', 'access'] as const;

function accountPath(id: string, dir: string): string {
  if (!/^\d{12}$/.test(id)) throw new Error(`Invalid account ID: ${id}`);
  return path.join(dir, 'accounts', id);
}

function readJson(file: string): Record<string, any> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function readAccountEstate(id: string, dir: string = defaultEstateDir): AccountEstate {
  const base = accountPath(id, dir);
  const estate: AccountEstate = {};
  for (const c of COMPONENTS) {
    const data = readJson(path.join(base, `${c}.json`));
    if (data) estate[c] = data;
  }
  return estate;
}

export function readOrganization(dir: string = defaultEstateDir): OrganizationEstate | undefined {
  const orgDir = path.join(dir, 'organization');
  if (!existsSync(orgDir)) return undefined;
  const merged: Required<OrganizationEstate> = { ous: {}, policies: {}, exemptions: {}, accounts: {}, stages: [] };
  for (const stage of ORG_STAGES) {
    const part = readJson(path.join(orgDir, `${stage}.json`)) as Partial<OrganizationEstate> | undefined;
    if (!part) continue;
    merged.stages.push(stage);
    Object.assign(merged.ous, part.ous);
    Object.assign(merged.policies, part.policies);
    Object.assign(merged.accounts, part.accounts);
    for (const [statement, ids] of Object.entries(part.exemptions ?? {})) {
      merged.exemptions[statement] = [...(merged.exemptions[statement] ?? []), ...ids];
    }
  }
  return merged.stages.length > 0 ? merged : undefined;
}

interface LegacySpec {
  network: Record<string, unknown>;
  access: Record<string, unknown>;
}

const LEGACY: LegacySpec = {
  network: { vpc_cidr: '172.31.0.0/16', public_subnets: true, tgw_route_table: null },
  access: { developers: 'AdministratorAccess', sre: 'AdministratorAccess' },
};

/** Writes a hand-built, non-compliant account as it looks before the landing zone takes it over. */
function writeLegacyEstate(account: Account, spec: LegacySpec = LEGACY): void {
  const dir = accountPath(account.account_id, defaultEstateDir);
  mkdirSync(dir, { recursive: true });
  const files = {
    baseline: {
      account_id: account.account_id,
      account_name: account.name,
      environment: account.environment,
      managed_by: 'manual',
      security_services: { cloudtrail: true, guardduty: false, inspector: false },
      hardening: { s3_block_public_access: false, ebs_encryption_default: false },
      allowed_regions: ['us-east-1', 'eu-west-1'],
      tags: { Environment: account.environment, Owner: account.owner },
      logging: { retention_days: 7 },
      backup: { enabled: false },
      budget: { limit_usd: null },
    },
    network: { account_id: account.account_id, ...spec.network },
    access: { account_id: account.account_id, ...spec.access },
  };
  for (const [component, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${component}.json`), JSON.stringify(content, null, 2));
  }
}

/**
 * Resets .lz/ and writes two hand-built, non-compliant "legacy" accounts,
 * as they would look before the landing zone takes them over.
 */
export function seedLegacy(cfg: Config): string[] {
  rmSync(lzDir, { recursive: true, force: true });
  const seeded: string[] = [];
  for (const name of ['ns-booking-test', 'ns-booking-prod']) {
    const account = cfg.accounts[name];
    if (!account) continue;
    writeLegacyEstate(account);
    seeded.push(name);
  }
  return seeded;
}

export const MAX_SYNTHETIC = 600;
const BUSINESS_UNITS = ['loyalty', 'cargo', 'mro', 'ops', 'revenue', 'digital', 'fleet', 'ground', 'finance', 'people'];
const ENV_DIGIT: Record<EnvName, number> = { dev: 1, test: 2, prod: 3 };

/**
 * Scale demo: generates `count` account files in .lz/synthetic/accounts (never in config/).
 * Mix: 40% dev, 30% test, 30% prod; the first account of each environment is its ring's canary;
 * every 10th account already exists as an unmanaged legacy account.
 * Call after seedLegacy (which resets .lz/). Returns the number of legacy accounts written.
 */
export function seedSynthetic(count: number): { accounts: number; legacy: number } {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SYNTHETIC) {
    throw new Error(`--synthetic must be an integer between 1 and ${MAX_SYNTHETIC}`);
  }
  mkdirSync(syntheticDir, { recursive: true });
  const nextIndex: Record<EnvName, number> = { dev: 10, test: 10, prod: 10 };
  let legacy = 0;
  for (let i = 1; i <= count; i++) {
    const env: EnvName = i % 10 < 4 ? 'dev' : i % 10 < 7 ? 'test' : 'prod';
    const bu = BUSINESS_UNITS[i % BUSINESS_UNITS.length];
    const name = `ns-${bu}-${String(i).padStart(3, '0')}-${env}`;
    const index = nextIndex[env]++;
    const account: Account = {
      name,
      account_id: `2${ENV_DIGIT[env]}9${String(i).padStart(9, '0')}`,
      environment: env,
      owner: `${bu}-platform@northstar.example`,
      business_unit: bu,
      cost_center: `CC-${String(7000 + (i % 50)).padStart(4, '0')}`,
      network_index: index,
      ...(index === 10 ? { canary: true } : {}),
      overrides: i % 7 === 0 ? { budget_usd: 2500 } : {},
    };
    const { name: _name, ...file } = account;
    writeFileSync(path.join(syntheticDir, `${name}.yaml`), `# Generated by lz seed --synthetic (scale demo)\n${stringify(file)}`);
    if (i % 10 === 9) {
      writeLegacyEstate(account);
      legacy++;
    }
  }
  return { accounts: count, legacy };
}

/** Demo only: simulates a manual console change that opens public subnets. */
export function tamper(accountId: string, dir: string = defaultEstateDir): void {
  const file = path.join(accountPath(accountId, dir), 'network.json');
  const network = readJson(file);
  if (!network) throw new Error('Account has no network.json. Deploy it first.');
  network.public_subnets = true;
  writeFileSync(file, JSON.stringify(network));
}

/** Undoes the demo's config edits: removes the cargo account and turns Inspector back off. */
export function resetDemoConfig(): string[] {
  const changes: string[] = [];
  const cargo = path.join(configDir, 'accounts', 'ns-cargo-dev.yaml');
  if (existsSync(cargo)) {
    rmSync(cargo);
    changes.push('removed config/accounts/ns-cargo-dev.yaml');
  }
  const globalFile = path.join(configDir, 'global.yaml');
  const text = readFileSync(globalFile, 'utf8');
  const reset = text.replace(/^(\s*inspector:\s*)true\b/m, '$1false');
  if (reset !== text) {
    writeFileSync(globalFile, reset);
    changes.push('set inspector: false in config/global.yaml');
  }
  return changes;
}
