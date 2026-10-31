import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configDir = path.join(repoRoot, 'config');
export const policiesDir = path.join(repoRoot, 'policies');
export const terraformDir = path.join(repoRoot, 'terraform');
export const lzDir = path.join(repoRoot, '.lz');
export const estateDir = path.join(lzDir, 'estate');
export const stateDir = path.join(lzDir, 'state');
export const runsDir = path.join(lzDir, 'runs');

/** Terraform on Windows accepts forward slashes everywhere; backslashes break HCL string escapes. */
export function toTfPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function loadEnv(): void {
  const file = path.join(repoRoot, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function demoMode(): boolean {
  return process.env.LZ_DEMO_MODE === 'true';
}

/** Accounts whose first apply attempt fails with a simulated transient error (demo mode only). */
export function simulatedTransientAccounts(): string[] {
  if (!demoMode()) return [];
  return (process.env.LZ_SIMULATE_TRANSIENT ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
