/**
 * Causal moving averages. EMA restarts after any null run (no forward-fill).
 */

import { rollingMean, diffSeries } from './rolling.mjs';

/** @param {(number|null)[]} values @param {number} period @returns {(number|null)[]} */
export function smaSeries(values, period) {
  return rollingMean(values, period);
}

/**
 * EMA seeded with the SMA of the first `period` consecutive non-null values.
 * A null input breaks the chain: output is null and seeding restarts after it.
 * @param {(number|null)[]} values
 * @param {number} period
 * @returns {(number|null)[]}
 */
export function emaSeries(values, period) {
  if (!Number.isInteger(period) || period < 1) throw new Error(`period must be a positive integer, got ${period}`);
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let runStart = 0;
  let prevEma = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      prevEma = null;
      runStart = i + 1;
      continue;
    }
    if (prevEma === null) {
      const runLength = i - runStart + 1;
      if (runLength >= period) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += /** @type {number} */ (values[j]);
        prevEma = sum / period;
        out[i] = prevEma;
      }
    } else {
      prevEma = v * k + prevEma * (1 - k);
      out[i] = prevEma;
    }
  }
  return out;
}

/**
 * Average change per bar over `lookback` bars: (s[i] - s[i-lookback]) / lookback.
 * @param {(number|null)[]} series @param {number} lookback @returns {(number|null)[]}
 */
export function slopeSeries(series, lookback) {
  return diffSeries(series, lookback).map((d) => (d === null ? null : d / lookback));
}

/**
 * Count of sessions with close > reference over a trailing window.
 * @param {(number|null)[]} close
 * @param {(number|null)[]} reference
 * @param {number} window
 * @returns {(number|null)[]}
 */
export function countAboveSeries(close, reference, window) {
  const out = new Array(close.length).fill(null);
  for (let i = window - 1; i < close.length; i++) {
    let count = 0;
    let ok = true;
    for (let j = i - window + 1; j <= i; j++) {
      const c = close[j];
      const r = reference[j];
      if (c === null || r === null) { ok = false; break; }
      if (c > r) count++;
    }
    if (ok) out[i] = count;
  }
  return out;
}
