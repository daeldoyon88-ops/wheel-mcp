/**
 * Walk-forward infrastructure (V1: window generation + fixed-parameter
 * evaluation only — NO grid search, NO parameter selection, NO ML training,
 * and the final test segment is never used to pick anything).
 */

import { applyPurgeEmbargo } from '../time/purgeEmbargo.mjs';

/**
 * @typedef {Object} WalkForwardWindow
 * @property {number} windowIndex
 * @property {{start: string, end: string, indices: [number, number]}} train inclusive index range
 * @property {{start: string, end: string, indices: [number, number]}} test inclusive index range
 */

/**
 * Expanding-window walk-forward: train always starts at index 0 and grows.
 * @param {string[]} dates strictly ascending civil dates
 * @param {{initialTrainSize: number, testSize: number, step?: number}} options
 * @returns {WalkForwardWindow[]}
 */
export function expandingWindows(dates, options) {
  return buildWindows(dates, options, 'expanding');
}

/**
 * Rolling-window walk-forward: train has fixed length and slides.
 * @param {string[]} dates
 * @param {{trainSize: number, testSize: number, step?: number}} options
 * @returns {WalkForwardWindow[]}
 */
export function rollingWindows(dates, options) {
  return buildWindows(dates, { initialTrainSize: options.trainSize, testSize: options.testSize, step: options.step, fixedTrain: options.trainSize }, 'rolling');
}

/**
 * @param {string[]} dates
 * @param {{initialTrainSize: number, testSize: number, step?: number, fixedTrain?: number}} options
 * @param {'expanding'|'rolling'} mode
 * @returns {WalkForwardWindow[]}
 */
function buildWindows(dates, options, mode) {
  const { initialTrainSize, testSize } = options;
  const step = options.step ?? testSize;
  if (!Number.isInteger(initialTrainSize) || initialTrainSize < 1) throw new Error('initialTrainSize/trainSize must be a positive integer');
  if (!Number.isInteger(testSize) || testSize < 1) throw new Error('testSize must be a positive integer');
  if (!Number.isInteger(step) || step < 1) throw new Error('step must be a positive integer');
  const windows = [];
  let windowIndex = 0;
  for (let testStart = initialTrainSize; testStart + testSize <= dates.length; testStart += step) {
    const trainStart = mode === 'expanding' ? 0 : testStart - /** @type {number} */ (options.fixedTrain);
    if (trainStart < 0) continue;
    const trainEnd = testStart - 1;
    const testEnd = testStart + testSize - 1;
    windows.push({
      windowIndex: windowIndex++,
      train: { start: dates[trainStart], end: dates[trainEnd], indices: [trainStart, trainEnd] },
      test: { start: dates[testStart], end: dates[testEnd], indices: [testStart, testEnd] },
    });
  }
  return windows;
}

/**
 * Apply purge/embargo to one window's train dates relative to its test range.
 * @param {WalkForwardWindow} window
 * @param {string[]} dates
 * @param {{purgeDays?: number, embargoDays?: number}} [options]
 * @returns {{kept: string[], purged: string[], embargoed: string[]}}
 */
export function windowTrainDatesWithPurge(window, dates, options = {}) {
  const [a, b] = window.train.indices;
  const trainDates = dates.slice(a, b + 1);
  return applyPurgeEmbargo({
    trainDates,
    testStart: window.test.start,
    testEnd: window.test.end,
    purgeDays: options.purgeDays ?? 0,
    embargoDays: options.embargoDays ?? 0,
  });
}

/**
 * Structural sanity checks used by tests and callers.
 * @param {WalkForwardWindow[]} windows
 * @returns {string[]} problems
 */
export function validateWindows(windows) {
  const problems = [];
  for (const w of windows) {
    if (!(w.train.end < w.test.start)) problems.push(`window ${w.windowIndex}: train end ${w.train.end} not before test start ${w.test.start}`);
    if (!(w.train.indices[1] < w.test.indices[0])) problems.push(`window ${w.windowIndex}: train indices overlap test`);
  }
  for (let i = 1; i < windows.length; i++) {
    if (!(windows[i].test.indices[0] > windows[i - 1].test.indices[0])) {
      problems.push(`window ${i}: test does not advance`);
    }
  }
  return problems;
}
