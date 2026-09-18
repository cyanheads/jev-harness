/**
 * src/analysis/index.ts — public surface of the analysis module.
 */
export {
  calibrate,
  type QuestionCalibration,
  type ReliabilityBin,
  renderCalibration,
  type Truth,
} from './calibration.ts';
export { type QuestionStability, renderStability, stability } from './stability.ts';
