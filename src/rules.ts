import {
  isExceptionActive,
  ouChain,
  type Account,
  type Check,
  type Config,
  type GovernanceException,
  type Rule,
} from './config.js';
import { readAccountEstate, readOrganization, type AccountEstate, type OrganizationEstate } from './estate.js';

export type RuleStatus = 'PASS' | 'FAIL' | 'EXCEPTED' | 'N/A' | 'NOT_DEPLOYED';

export interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

export interface RuleResult {
  id: string;
  title: string;
  severity: Rule['severity'];
  status: RuleStatus;
  checks: CheckResult[];
  exception?: { id: string; expires: string; reason: string };
}

export interface AccountCompliance {
  account: string;
  accountId: string;
  environment: string;
  deployed: boolean;
  results: RuleResult[];
  pass: number;
  fail: number;
  excepted: number;
  /** PASS / (PASS + FAIL), null when nothing was evaluated. */
  score: number | null;
}

export interface EffectiveScp {
  statement: string;
  ou: string;
  exempt: boolean;
}

/** SCP statements that apply to an account: its OU plus every parent OU, as deployed in organization.json. */
export function effectiveScps(org: OrganizationEstate | undefined, accountName: string, accountId: string): EffectiveScp[] {
  const ou = org?.accounts?.[accountName]?.ou;
  if (!org || !ou) return [];
  return ouChain(org.ous, ou).flatMap((name) =>
    (org.ous[name]?.scp ?? []).map((statement) => ({
      statement,
      ou: name,
      exempt: (org.exemptions?.[statement] ?? []).includes(accountId),
    })),
  );
}

function getPath(estate: AccountEstate, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((value, key) => {
    if (value !== null && typeof value === 'object' && key in value) return (value as Record<string, unknown>)[key];
    return undefined;
  }, estate);
}

const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));

function evaluateCheck(check: Check, estate: AccountEstate, scps: EffectiveScp[]): CheckResult {
  if ('scp' in check) {
    const found = scps.find((s) => s.statement === check.scp);
    if (!found) return { check: `SCP ${check.scp}`, passed: false, detail: 'not attached to the account OU or its parents' };
    if (found.exempt) return { check: `SCP ${check.scp}`, passed: false, detail: `account exempted (inherited from ${found.ou})` };
    return { check: `SCP ${check.scp}`, passed: true, detail: `inherited from ${found.ou}` };
  }
  const actual = getPath(estate, check.path);
  if ('equals' in check) {
    return { check: `${check.path} = ${show(check.equals)}`, passed: actual === check.equals, detail: `actual ${show(actual)}` };
  }
  if ('gte' in check) {
    return { check: `${check.path} >= ${check.gte}`, passed: typeof actual === 'number' && actual >= check.gte, detail: `actual ${show(actual)}` };
  }
  if ('lte' in check) {
    return { check: `${check.path} <= ${check.lte}`, passed: typeof actual === 'number' && actual <= check.lte, detail: `actual ${show(actual)}` };
  }
  const obj = actual !== null && typeof actual === 'object' ? (actual as Record<string, unknown>) : {};
  const missing = check.hasKeys.filter((k) => !(k in obj));
  return {
    check: `${check.path} has ${check.hasKeys.join(', ')}`,
    passed: missing.length === 0,
    detail: missing.length ? `missing ${missing.join(', ')}` : 'all present',
  };
}

export interface EvaluateInput {
  account: Account;
  rules: Rule[];
  exceptions: GovernanceException[];
  estate: AccountEstate;
  org: OrganizationEstate | undefined;
  now?: Date;
}

export function evaluateAccount(input: EvaluateInput): AccountCompliance {
  const { account, rules, exceptions, estate, org, now = new Date() } = input;
  const deployed = Boolean(estate.baseline || estate.network || estate.access);
  const scps = effectiveScps(org, account.name, account.account_id);

  const results: RuleResult[] = rules.map((rule) => {
    const base = { id: rule.id, title: rule.title, severity: rule.severity, checks: [] as CheckResult[] };
    if (!rule.environments.includes(account.environment)) return { ...base, status: 'N/A' };
    if (!deployed) return { ...base, status: 'NOT_DEPLOYED' };

    const checks = rule.checks.map((c) => evaluateCheck(c, estate, scps));
    if (checks.every((c) => c.passed)) return { ...base, checks, status: 'PASS' };

    const exception = exceptions.find((e) => e.account === account.name && e.rule === rule.id && isExceptionActive(e, now));
    if (exception) {
      return {
        ...base,
        checks,
        status: 'EXCEPTED',
        exception: { id: exception.id, expires: exception.expires, reason: exception.reason },
      };
    }
    return { ...base, checks, status: 'FAIL' };
  });

  const count = (s: RuleStatus) => results.filter((r) => r.status === s).length;
  const pass = count('PASS');
  const fail = count('FAIL');
  return {
    account: account.name,
    accountId: account.account_id,
    environment: account.environment,
    deployed,
    results,
    pass,
    fail,
    excepted: count('EXCEPTED'),
    score: pass + fail > 0 ? pass / (pass + fail) : null,
  };
}

/** Evaluates every configured account against the current estate. */
export function evaluateAll(config: Config, now: Date = new Date()): AccountCompliance[] {
  const org = readOrganization();
  return Object.values(config.accounts)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((account) =>
      evaluateAccount({
        account,
        rules: config.rules,
        exceptions: config.exceptions,
        estate: readAccountEstate(account.account_id),
        org,
        now,
      }),
    );
}
