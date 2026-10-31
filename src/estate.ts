import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { configDir, estateDir as defaultEstateDir, lzDir } from './env.js';

/** Contents of the simulated AWS estate written by Terraform (or by hand, for legacy accounts). */
export interface AccountEstate {
  baseline?: Record<string, any>;
  network?: Record<string, any>;
  access?: Record<string, any>;
}

export interface OrganizationEstate {
  ous: Record<string, { parent: string | null; scp: string[] }>;
  policies: Record<string, { Version: string; Statement: Record<string, unknown>[] }>;
  exemptions: Record<string, string[]>;
  accounts: Record<string, { id: string; ou: string; type: 'core' | 'workload' }>;
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
  return readJson(path.join(dir, 'organization.json')) as OrganizationEstate | undefined;
}

/**
 * Resets .lz/ and writes two hand-built, non-compliant "legacy" accounts,
 * as they would look before the landing zone takes them over.
 */
export function seedLegacy(cfg: Config): string[] {
  rmSync(lzDir, { recursive: true, force: true });
  const seeded: string[] = [];

  const legacy: Record<string, { network: Record<string, unknown>; access: Record<string, unknown> }> = {
    'ns-booking-test': {
      network: { vpc_cidr: '172.31.0.0/16', public_subnets: true, tgw_route_table: null },
      access: { developers: 'AdministratorAccess', sre: 'AdministratorAccess' },
    },
    'ns-booking-prod': {
      network: { vpc_cidr: '172.31.0.0/16', public_subnets: true, tgw_route_table: null },
      access: { developers: 'AdministratorAccess', sre: 'AdministratorAccess' },
    },
  };

  for (const [name, spec] of Object.entries(legacy)) {
    const account = cfg.accounts[name];
    if (!account) continue;
    const dir = accountPath(account.account_id, defaultEstateDir);
    mkdirSync(dir, { recursive: true });
    const files = {
      baseline: {
        account_id: account.account_id,
        account_name: name,
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
    seeded.push(name);
  }
  return seeded;
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
