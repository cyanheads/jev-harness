/**
 * src/index.ts — the harness as a library. Consumers outside this repo link
 * the package (`bun link jev-harness`) and import from here or from the
 * per-module subpaths (`jev-harness/client`, `/questions`, `/experiments`,
 * `/input`, `/run`, `/analysis`).
 */
export * from './analysis/index.ts';
export * from './client/index.ts';
export * from './experiments/index.ts';
export * from './input/index.ts';
export * from './questions/index.ts';
export * from './run/index.ts';
