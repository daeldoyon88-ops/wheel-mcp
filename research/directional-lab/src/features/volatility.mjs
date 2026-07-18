/**
 * Causal volatility indicators: True Range, Wilder ATR, ATR%, realized
 * volatility and its rolling percentile, distance from causal peak in ATRs.
 */

import { rollingStd, rollingPercentileRank, expandingMax } from './rolling.mjs';

/**
 * True Range. TR[0] = high-low; otherwise max(h-l, |h-prevC|, |l-prevC|).
 * Null when any needed input is null.
 * @param {(number|null)[]} high @param {(number|null)[]} low @param {(number|null)[]} close
 * @returns {(number|null)[]}
 */
export function trueRangeSeries(high, low, close) {
  const out = new Array(close.length).fill(null);
  for (let i = 0; i < close.length; i++) {
    const h = high[i];
    const l = low[i];
    if (h === null || l === null) continue;
    if (i === 0) { out[i] = h - l; continue; }
    const pc = close[i - 1];
    if (pc === null) { out[i] = h - l; continue; }
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

/**
 * Wilder ATR seeded with the SMA of the first `period` consecutive non-null TRs.
 * @param {(number|null)[]} trueRange @param {number} [period] @returns {(number|null)[]}
 */
export function atrSeries(trueRange, period = 14) {
  const out = new Array(trueRange.length).fill(null);
  let prevAtr = null;
  let runStart = 0;
  for (let i = 0; i < trueRange.length; i++) {
    const tr = trueRange[i];
    if (tr === null) {
      prevAtr = null;
      runStart = i + 1;
      continue;
    }
    if (prevAtr === null) {
      if (i - runStart + 1 >= period) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += /** @type {number} */ (trueRange[j]);
        prevAtr = sum / period;
        out[i] = prevAtr;
      }
    } else {
      prevAtr = (prevAtr * (period - 1) + tr) / period;
      out[i] = prevAtr;
    }
  }
  return out;
}

/** ATR as % of close. @param {(number|null)[]} atr @param {(number|null)[]} close @returns {(number|null)[]} */
export function atrPctSeries(atr, close) {
  return atr.map((a, i) => (a === null || close[i] === null || close[i] === 0 ? null : (a / /** @type {number} */ (close[i])) * 100));
}

/**
 * Annualized realized volatility (%) of log returns over a trailing window.
 * @param {(number|null)[]} close @param {number} [window] @returns {(number|null)[]}
 */
export function realizedVolSeries(close, window = 20) {
  const logReturns = close.map((c, i) => {
    if (i === 0) return null;
    const prev = close[i - 1];
    if (c === null || prev === null || prev <= 0 || c <= 0) return null;
    return Math.log(c / prev);
  });
  const std = rollingStd(logReturns, window);
  return std.map((s) => (s === null ? null : s * Math.sqrt(252) * 100));
}

/**
 * Rolling percentile (0..100) of realized volatility.
 * @param {(number|null)[]} realizedVol @param {number} [window] @returns {(number|null)[]}
 */
export function realizedVolPercentileSeries(realizedVol, window = 126) {
  return rollingPercentileRank(realizedVol, window);
}

/**
 * (causal peak close - close) / ATR. Peak is the expanding prefix max of close.
 * @param {(number|null)[]} close @param {(number|null)[]} atr @returns {(number|null)[]}
 */
export function distanceFromPeakAtrSeries(close, atr) {
  const peak = expandingMax(close);
  return close.map((c, i) => {
    const p = peak[i];
    const a = atr[i];
    if (c === null || p === null || a === null || a === 0) return null;
    return (p - c) / a;
  });
}
