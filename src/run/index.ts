/**
 * src/run/index.ts — public surface of the run module.
 */
export { renderReport, summarizeRows } from './report.ts';
export {
  type RunFailure,
  type RunOptions,
  type RunOutcome,
  type RunRow,
  runExperiment,
} from './runner.ts';
