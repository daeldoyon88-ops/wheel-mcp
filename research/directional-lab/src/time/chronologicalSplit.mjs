/**
 * Simple chronological train/validation/test split of ordered civil dates.
 * Segments are contiguous, disjoint, and strictly ordered: every train date
 * precedes every validation date, which precedes every test date.
 */

import { compareCivilDate } from './civilDate.mjs';

/**
 * @param {string[]} dates ordered civil dates
 * @param {{trainFraction?: number, validationFraction?: number}} [options]
 * @returns {{train: string[], validation: string[], test: string[]}}
 */
export function chronologicalSplit(dates, options = {}) {
  const trainFraction = options.trainFraction ?? 0.6;
  const validationFraction = options.validationFraction ?? 0.2;
  if (!(trainFraction > 0) || !(validationFraction >= 0) || trainFraction + validationFraction >= 1) {
    throw new Error(`Invalid fractions: train=${trainFraction}, validation=${validationFraction} (train+val must be < 1)`);
  }
  for (let i = 1; i < dates.length; i++) {
    if (compareCivilDate(dates[i - 1], dates[i]) >= 0) {
      throw new Error(`Dates not strictly ascending at index ${i}: ${dates[i - 1]} -> ${dates[i]}`);
    }
  }
  const n = dates.length;
  const trainEnd = Math.floor(n * trainFraction);
  const valEnd = Math.floor(n * (trainFraction + validationFraction));
  return {
    train: dates.slice(0, trainEnd),
    validation: dates.slice(trainEnd, valEnd),
    test: dates.slice(valEnd),
  };
}
