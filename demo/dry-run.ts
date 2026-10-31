// Rehearsal helper: runs the 5-minute demo sequence against a running portal and times each step.
// Usage: npm start (in another terminal), then: npx tsx demo/dry-run.ts
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configDir, repoRoot } from '../src/env.js';
import { resetDemoConfig, seedLegacy } from '../src/estate.js';
import { loadConfig } from '../src/config.js';

const BASE = 'http://127.0.0.1:4000';

async function api(p: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(`${p}: ${res.status} ${data.error}`);
  return data;
}

async function waitRun(runId: string): Promise<any> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const run = await api(`/api/runs/${runId}`).catch(() => undefined);
    if (run && run.status !== 'RUNNING') return run;
  }
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`Check failed: ${message}`);
}

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  const started = Date.now();
  await fn();
  console.log(`${name.padEnd(48)} ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

function reset(): void {
  resetDemoConfig();
  seedLegacy(loadConfig());
}

const total = Date.now();
await step('reset', reset);

await step('overview: 2 legacy, 4 not deployed', async () => {
  const s = await api('/api/summary');
  check(s.legacy === 2 && s.notDeployed === 4, `start state legacy=${s.legacy} notDeployed=${s.notDeployed}`);
});

await step('run pipeline (include prod), retry on booking-test', async () => {
  const run = await waitRun((await api('/api/runs', { kind: 'deploy', includeProd: true })).runId);
  const bt = run.rings.flatMap((r: any) => r.accounts).find((a: any) => a.name === 'ns-booking-test');
  check(run.status === 'SUCCEEDED', `deploy ${run.status}`);
  check(bt.attempts === 2, `booking-test attempts ${bt.attempts} (is LZ_SIMULATE_TRANSIENT set?)`);
});

await step('booking-prod: PRD-01 EXCEPTED, ORG-03 FAIL', async () => {
  const a = await api('/api/accounts/ns-booking-prod');
  const st = Object.fromEntries(a.results.map((r: any) => [r.id, r.status]));
  check(st['PRD-01'] === 'EXCEPTED' && st['ORG-03'] === 'FAIL', `PRD-01=${st['PRD-01']} ORG-03=${st['ORG-03']}`);
});

await step('inspector: true + onboard ns-cargo-dev, run', async () => {
  const g = path.join(configDir, 'global.yaml');
  writeFileSync(g, readFileSync(g, 'utf8').replace('inspector: false', 'inspector: true'));
  copyFileSync(path.join(repoRoot, 'demo', 'ns-cargo-dev.yaml'), path.join(configDir, 'accounts', 'ns-cargo-dev.yaml'));
  const run = await waitRun((await api('/api/runs', { kind: 'deploy', includeProd: true })).runId);
  const s = await api('/api/summary');
  check(run.status === 'SUCCEEDED' && s.accounts === 7 && s.nonCompliant === 0, `status=${run.status} accounts=${s.accounts} nonCompliant=${s.nonCompliant}`);
});

await step('simulate manual change + detect drift', async () => {
  await api('/api/demo/tamper', { account: 'ns-crew-prod' });
  const run = await waitRun((await api('/api/runs', { kind: 'drift' })).runId);
  const d = run.drift.find((x: any) => x.name === 'ns-crew-prod');
  check(d.status === 'DRIFTED' && d.components.join() === 'network', `drift ${d.status} ${d.components}`);
});

await step('re-apply ns-crew-prod', async () => {
  await waitRun((await api('/api/runs', { kind: 'deploy', account: 'ns-crew-prod' })).runId);
  const a = await api('/api/accounts/ns-crew-prod');
  check(a.drift.status === 'IN_SYNC' && a.compliance.fail === 0, `drift=${a.drift.status} fail=${a.compliance.fail}`);
});

await step('reset', reset);
console.log(`DRY RUN PASSED in ${((Date.now() - total) / 1000).toFixed(1)}s`);
