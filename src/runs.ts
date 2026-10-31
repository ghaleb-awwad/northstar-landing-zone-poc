import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { runsDir as defaultRunsDir } from './env.js';

export type RunKind = 'deploy' | 'drift';
export type RunTrigger = 'cli' | 'portal' | 'ci';
export type RunStatus = 'RUNNING' | 'SUCCEEDED' | 'HALTED' | 'FAILED';
export type StepStatus = 'PENDING' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
export type DriftStatus = 'IN_SYNC' | 'DRIFTED' | 'ERROR';

export interface Changes {
  add: number;
  change: number;
  destroy: number;
}

export interface AccountStep {
  name: string;
  accountId: string;
  status: StepStatus;
  attempts: number;
  changes?: Changes;
  durationMs?: number;
  error?: string;
  finishedAt?: string;
}

export interface Ring {
  name: string;
  status: StepStatus;
  accounts: AccountStep[];
}

export interface DriftResult {
  name: string;
  accountId: string;
  status: DriftStatus;
  components: string[];
  error?: string;
}

export interface Run {
  runId: string;
  kind: RunKind;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  options: { ring?: string; account?: string; approveProd?: boolean };
  organization?: { status: StepStatus; changes?: Changes; durationMs?: number; error?: string };
  rings: Ring[];
  drift?: DriftResult[];
  error?: string;
}

export const RUN_ID = /^run-\d{8}-\d{6}-[a-z0-9]{4}$/;

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `run-${stamp}-${randomBytes(2).toString('hex')}`;
}

function runFile(runId: string, dir: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
  return path.join(dir, `${runId}.json`);
}

/** Atomic write: temp file, then rename, so readers never see a half-written file. */
export function writeRun(run: Run, dir: string = defaultRunsDir): void {
  mkdirSync(dir, { recursive: true });
  const target = runFile(run.runId, dir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (e) {
      // Windows can briefly refuse the rename while a reader has the file open.
      if (attempt >= 5 || (e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    }
  }
}

const lastGood = new Map<string, Run>();

/** Returns the run, or the last successfully parsed version if the file is unreadable right now. */
export function readRun(runId: string, dir: string = defaultRunsDir): Run | undefined {
  const file = runFile(runId, dir);
  if (!existsSync(file)) return undefined;
  try {
    const run = JSON.parse(readFileSync(file, 'utf8')) as Run;
    lastGood.set(file, run);
    return run;
  } catch {
    return lastGood.get(file);
  }
}

/** All runs, newest first. */
export function listRuns(dir: string = defaultRunsDir): Run[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((id) => RUN_ID.test(id))
    .map((id) => readRun(id, dir))
    .filter((r): r is Run => r !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
