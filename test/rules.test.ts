import { describe, expect, it } from 'vitest';
import type { Account, GovernanceException, Rule } from '../src/config.js';
import type { AccountEstate, OrganizationEstate } from '../src/estate.js';
import { effectiveScps, evaluateAccount } from '../src/rules.js';

const prodAccount: Account = {
  name: 'ns-x-prod',
  account_id: '230000000009',
  environment: 'prod',
  owner: 'x@northstar.example',
  business_unit: 'x',
  cost_center: 'CC-1',
  network_index: 1,
  overrides: {},
};

const org: OrganizationEstate = {
  ous: {
    Root: { parent: null, scp: ['RestrictRegions'] },
    Workloads: { parent: 'Root', scp: [] },
    'Workloads/Prod': { parent: 'Workloads', scp: ['DenyPublicIp'] },
  },
  policies: {},
  exemptions: {},
  accounts: { 'ns-x-prod': { id: '230000000009', ou: 'Workloads/Prod', type: 'workload' } },
};

const estate: AccountEstate = {
  baseline: {
    security_services: { cloudtrail: true, inspector: false },
    logging: { retention_days: 400 },
    tags: { Environment: 'prod', Owner: 'x' },
  },
  network: { public_subnets: false },
  access: { developers: 'ReadOnlyAccess' },
};

const rule = (id: string, checks: Rule['checks'], environments: Rule['environments'] = ['dev', 'test', 'prod']): Rule => ({
  id,
  title: id,
  environments,
  severity: 'high',
  checks,
});

function evaluate(rules: Rule[], opts: { estate?: AccountEstate; exceptions?: GovernanceException[]; org?: OrganizationEstate; now?: Date } = {}) {
  return evaluateAccount({
    account: prodAccount,
    rules,
    exceptions: opts.exceptions ?? [],
    estate: opts.estate ?? estate,
    org: opts.org ?? org,
    now: opts.now ?? new Date('2026-11-01T00:00:00Z'),
  });
}

const status = (result: ReturnType<typeof evaluate>, id: string) => result.results.find((r) => r.id === id)?.status;

describe('rule operators', () => {
  it('equals', () => {
    const r = evaluate([
      rule('T-01', [{ path: 'baseline.security_services.cloudtrail', equals: true }]),
      rule('T-02', [{ path: 'baseline.security_services.inspector', equals: true }]),
      rule('T-03', [{ path: 'access.developers', equals: 'ReadOnlyAccess' }]),
    ]);
    expect(status(r, 'T-01')).toBe('PASS');
    expect(status(r, 'T-02')).toBe('FAIL');
    expect(status(r, 'T-03')).toBe('PASS');
  });

  it('gte and lte', () => {
    const r = evaluate([
      rule('T-01', [{ path: 'baseline.logging.retention_days', gte: 365 }]),
      rule('T-02', [{ path: 'baseline.logging.retention_days', lte: 90 }]),
    ]);
    expect(status(r, 'T-01')).toBe('PASS');
    expect(status(r, 'T-02')).toBe('FAIL');
  });

  it('hasKeys reports missing keys', () => {
    const r = evaluate([
      rule('T-01', [{ path: 'baseline.tags', hasKeys: ['Environment', 'Owner'] }]),
      rule('T-02', [{ path: 'baseline.tags', hasKeys: ['Environment', 'CostCenter'] }]),
    ]);
    expect(status(r, 'T-01')).toBe('PASS');
    expect(status(r, 'T-02')).toBe('FAIL');
    expect(r.results[1].checks[0].detail).toBe('missing CostCenter');
  });

  it('a missing path fails', () => {
    const r = evaluate([rule('T-01', [{ path: 'baseline.backup.enabled', equals: true }])]);
    expect(status(r, 'T-01')).toBe('FAIL');
    expect(r.results[0].checks[0].detail).toBe('actual missing');
  });

  it('a rule passes only if all checks pass', () => {
    const r = evaluate([
      rule('T-01', [
        { path: 'network.public_subnets', equals: false },
        { path: 'baseline.security_services.inspector', equals: true },
      ]),
    ]);
    expect(status(r, 'T-01')).toBe('FAIL');
  });
});

describe('rule statuses', () => {
  it('N/A when the rule does not apply to the environment', () => {
    const r = evaluate([rule('DEV-01', [{ scp: 'DenyLargeInstances' }], ['dev'])]);
    expect(status(r, 'DEV-01')).toBe('N/A');
  });

  it('NOT_DEPLOYED when the account has no estate files', () => {
    const r = evaluate([rule('T-01', [{ path: 'network.public_subnets', equals: false }])], { estate: {} });
    expect(status(r, 'T-01')).toBe('NOT_DEPLOYED');
    expect(r.deployed).toBe(false);
    expect(r.score).toBeNull();
  });

  it('score is PASS / (PASS + FAIL); excepted and N/A are excluded', () => {
    const exceptions: GovernanceException[] = [
      { id: 'EXC-0001', account: 'ns-x-prod', rule: 'T-03', reason: 'r', approved_by: 'sec', expires: '2027-01-31' },
    ];
    const r = evaluate(
      [
        rule('T-01', [{ path: 'network.public_subnets', equals: false }]),
        rule('T-02', [{ path: 'baseline.security_services.inspector', equals: true }]),
        rule('T-03', [{ path: 'baseline.security_services.inspector', equals: true }]),
        rule('T-04', [{ scp: 'DenyLargeInstances' }], ['dev']),
      ],
      { exceptions },
    );
    expect([r.pass, r.fail, r.excepted]).toEqual([1, 1, 1]);
    expect(r.score).toBe(0.5);
  });
});

describe('SCP checks and exceptions', () => {
  it('inherits SCP statements from parent OUs', () => {
    const scps = effectiveScps(org, 'ns-x-prod', '230000000009');
    expect(scps.map((s) => `${s.statement}@${s.ou}`)).toEqual(['DenyPublicIp@Workloads/Prod', 'RestrictRegions@Root']);
    const r = evaluate([rule('ORG-07', [{ scp: 'RestrictRegions' }]), rule('DEV-X', [{ scp: 'DenyLargeInstances' }])]);
    expect(status(r, 'ORG-07')).toBe('PASS');
    expect(r.results[0].checks[0].detail).toBe('inherited from Root');
    expect(status(r, 'DEV-X')).toBe('FAIL');
  });

  it('fails SCP checks when the account is not in the organization yet', () => {
    const r = evaluateAccount({
      account: prodAccount,
      rules: [rule('ORG-07', [{ scp: 'RestrictRegions' }])],
      exceptions: [],
      estate,
      org: undefined,
    });
    expect(status(r, 'ORG-07')).toBe('FAIL');
  });

  it('reports EXCEPTED for an active exception, including an SCP exemption', () => {
    const exempted: OrganizationEstate = { ...org, exemptions: { DenyPublicIp: ['230000000009'] } };
    const exceptions: GovernanceException[] = [
      { id: 'EXC-0042', account: 'ns-x-prod', rule: 'PRD-01', scp_statement: 'DenyPublicIp', reason: 'partner', approved_by: 'sec', expires: '2027-01-31' },
    ];
    const prd01 = rule('PRD-01', [{ path: 'network.public_subnets', equals: false }, { scp: 'DenyPublicIp' }], ['prod']);
    const r = evaluate([prd01], { org: exempted, exceptions, estate: { ...estate, network: { public_subnets: true } } });
    expect(status(r, 'PRD-01')).toBe('EXCEPTED');
    expect(r.results[0].exception).toMatchObject({ id: 'EXC-0042', expires: '2027-01-31' });
    expect(r.results[0].checks[1].detail).toContain('exempted');
  });

  it('reports FAIL once the exception has expired', () => {
    const exceptions: GovernanceException[] = [
      { id: 'EXC-0042', account: 'ns-x-prod', rule: 'PRD-01', reason: 'partner', approved_by: 'sec', expires: '2027-01-31' },
    ];
    const prd01 = rule('PRD-01', [{ path: 'network.public_subnets', equals: false }], ['prod']);
    const failing = { ...estate, network: { public_subnets: true } };
    expect(status(evaluate([prd01], { exceptions, estate: failing, now: new Date('2027-01-31T23:00:00Z') }), 'PRD-01')).toBe('EXCEPTED');
    expect(status(evaluate([prd01], { exceptions, estate: failing, now: new Date('2027-02-01T00:00:01Z') }), 'PRD-01')).toBe('FAIL');
  });
});
