import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ACCOUNT_NAME } from './config.js';
import { configDir, estateDir, stateDir, terraformDir, toTfPath } from './env.js';
import type { Changes } from './runs.js';

export interface PlanResult {
  changed: boolean;
  changes: Changes;
  /** Resource addresses with planned changes, e.g. module.network.local_file.network */
  addresses: string[];
}

/** The pipeline only depends on this interface, so tests can use a fake. */
export interface TfRunner {
  ensureWorkspaces(names: string[]): Promise<void>;
  applyOrg(): Promise<Changes>;
  applyAccount(name: string): Promise<Changes>;
  planOrg(): Promise<PlanResult>;
  planAccount(name: string): Promise<PlanResult>;
  hasState(name: string): boolean;
}

export class TerraformError extends Error {}

interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

interface JsonMessage {
  type?: string;
  '@level'?: string;
  changes?: { add: number; change: number; remove: number };
  diagnostic?: { severity: string; summary: string; detail?: string };
  change?: { resource?: { addr?: string }; action?: string };
}

const orgDir = path.join(terraformDir, 'organization');
const accountDir = path.join(terraformDir, 'account');

function exec(cwd: string, args: string[], workspace?: string): Promise<Exec> {
  const env: NodeJS.ProcessEnv = { ...process.env, TF_IN_AUTOMATION: '1', TF_INPUT: '0' };
  delete env.TF_WORKSPACE;
  if (workspace) env.TF_WORKSPACE = workspace;
  return new Promise((resolve, reject) => {
    // Fixed argument list and shell: false: no user input is ever interpreted by a shell.
    const child = spawn('terraform', args, { cwd, env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => reject(new TerraformError(`Cannot start terraform: ${e.message}`)));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseJsonLines(stdout: string): JsonMessage[] {
  const messages: JsonMessage[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      messages.push(JSON.parse(line) as JsonMessage);
    } catch {
      /* not a JSON line */
    }
  }
  return messages;
}

function changeSummary(messages: JsonMessage[]): Changes {
  const summary = messages.filter((m) => m.type === 'change_summary').pop()?.changes;
  return { add: summary?.add ?? 0, change: summary?.change ?? 0, destroy: summary?.remove ?? 0 };
}

function errorText(result: Exec, messages: JsonMessage[]): string {
  const diag = messages.find((m) => m.type === 'diagnostic' && m.diagnostic?.severity === 'error')?.diagnostic;
  if (diag) return [diag.summary, diag.detail].filter(Boolean).join(': ');
  const text = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ');
  return text || `terraform exited with code ${result.code}`;
}

function assertAccountName(name: string): void {
  if (!ACCOUNT_NAME.test(name)) throw new TerraformError(`Invalid account name: ${name}`);
}

export class TerraformCli implements TfRunner {
  private readonly vars = [
    `-var=config_dir=${toTfPath(configDir)}`,
    `-var=estate_dir=${toTfPath(estateDir)}`,
  ];

  async ensureWorkspaces(names: string[]): Promise<void> {
    const list = await exec(accountDir, ['workspace', 'list', '-no-color']);
    if (list.code !== 0) throw new TerraformError(`terraform workspace list failed: ${list.stderr.trim()}`);
    const existing = new Set(list.stdout.split(/\r?\n/).map((l) => l.replace('*', '').trim()).filter(Boolean));
    // Sequential on purpose: workspace creation writes shared metadata.
    for (const name of names) {
      assertAccountName(name);
      if (existing.has(name)) continue;
      const res = await exec(accountDir, ['workspace', 'new', '-no-color', name]);
      if (res.code !== 0) throw new TerraformError(`terraform workspace new ${name} failed: ${res.stderr.trim()}`);
    }
  }

  private async apply(cwd: string, extraVars: string[], workspace?: string): Promise<Changes> {
    const res = await exec(
      cwd,
      ['apply', '-auto-approve', '-input=false', '-json', '-lock-timeout=30s', ...this.vars, ...extraVars],
      workspace,
    );
    const messages = parseJsonLines(res.stdout);
    if (res.code !== 0) throw new TerraformError(errorText(res, messages));
    return changeSummary(messages);
  }

  private async plan(cwd: string, extraVars: string[], workspace?: string): Promise<PlanResult> {
    const res = await exec(
      cwd,
      ['plan', '-detailed-exitcode', '-input=false', '-json', '-lock-timeout=30s', ...this.vars, ...extraVars],
      workspace,
    );
    const messages = parseJsonLines(res.stdout);
    if (res.code === 1) throw new TerraformError(errorText(res, messages));
    const addresses = [
      ...new Set(
        messages
          .filter((m) => m.type === 'planned_change' && m.change?.resource?.addr)
          .map((m) => m.change!.resource!.addr!),
      ),
    ];
    return { changed: res.code === 2, changes: changeSummary(messages), addresses };
  }

  applyOrg(): Promise<Changes> {
    return this.apply(orgDir, []);
  }

  planOrg(): Promise<PlanResult> {
    return this.plan(orgDir, []);
  }

  applyAccount(name: string): Promise<Changes> {
    assertAccountName(name);
    return this.apply(accountDir, [`-var=account_name=${name}`], name);
  }

  planAccount(name: string): Promise<PlanResult> {
    assertAccountName(name);
    return this.plan(accountDir, [`-var=account_name=${name}`], name);
  }

  hasState(name: string): boolean {
    assertAccountName(name);
    return existsSync(path.join(stateDir, 'accounts', name, 'terraform.tfstate'));
  }
}
