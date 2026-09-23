/**
 * src/experiments/load-experiment.ts
 *
 * Resolve an experiment reference — a path, or a bare name under
 * `experiments/` — and import its default export.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Experiment } from './experiment.ts';

export const EXPERIMENTS_DIR = resolve(import.meta.dir, '../../experiments');

export async function loadExperiment(ref: string): Promise<Experiment> {
  const path = resolveExperimentPath(ref);
  const mod = (await import(path)) as { default?: unknown };
  const exp = mod.default as Experiment | undefined;
  if (!exp || typeof exp !== 'object' || typeof exp.state !== 'function' || !exp.questions) {
    throw new Error(`${path} must default-export defineExperiment({...})`);
  }
  return exp;
}

export function resolveExperimentPath(ref: string): string {
  const candidates = [
    resolve(ref),
    resolve(EXPERIMENTS_DIR, ref),
    resolve(EXPERIMENTS_DIR, `${ref}.ts`),
  ];
  const found = candidates.find((p) => p.endsWith('.ts') && existsSync(p));
  if (!found) {
    throw new Error(`no experiment at "${ref}" — tried ${candidates.join(', ')}`);
  }
  return found;
}

export async function listExperiments(): Promise<string[]> {
  const names = await readdir(EXPERIMENTS_DIR);
  return names
    .filter((n) => n.endsWith('.ts'))
    .map((n) => n.slice(0, -3))
    .sort();
}
