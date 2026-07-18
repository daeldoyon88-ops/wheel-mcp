/**
 * Causal volume features. A null volume stays null everywhere downstream.
 */

import { rollingMean, rollingPercentileRank } from './rolling.mjs';

/** @param {(number|null)[]} volume @param {number} [window] @returns {(number|null)[]} */
export function volumeSmaSeries(volume, window = 20) {
  return rollingMean(volume, window);
}

/**
 * Relative volume = volume / trailing average volume.
 * @param {(number|null)[]} volume @param {(number|null)[]} volumeSma @returns {(number|null)[]}
 */
export function relativeVolumeSeries(volume, volumeSma) {
  return volume.map((v, i) => {
    const avg = volumeSma[i];
    if (v === null || avg === null || avg === 0) return null;
    return v / avg;
  });
}

/**
 * Rolling percentile rank (0..100) of volume over a trailing window.
 * @param {(number|null)[]} volume @param {number} [window] @returns {(number|null)[]}
 */
export function volumePercentileSeries(volume, window = 60) {
  return rollingPercentileRank(volume, window);
}
