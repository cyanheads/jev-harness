/**
 * src/analysis/index.ts — public surface of the analysis module.
 */
export {
  type Calibration,
  type Cutoff,
  calibrate,
  type QuestionCalibration,
  type ReliabilityBin,
  renderCalibration,
  type Truth,
  truthLineSchema,
} from './calibration.ts';
export {
  type ChangedRecord,
  type Comparison,
  compare,
  type QuestionComparison,
  renderComparison,
} from './compare.ts';
export { type QuestionStability, renderStability, stability } from './stability.ts';
