/**
 * Causal price-structure features. Only the prefix [0..t] is ever used:
 * "previous N-day high/low" excludes the current session; the causal peak is
 * the expanding prefix max. No future pivots exist in V1 (a pivot requiring
 * future candles would only become available after confirmation — not
 * implemented yet, see TEMPORAL_RULES.md).
 */

import { rollingMax, rollingMin, shift, expandingMax } from './rolling.mjs';

/**
 * Highest close of the PREVIOUS `window` sessions (current session excluded).
 * @param {(number|null)[]} close @param {number} [window] @returns {(number|null)[]}
 */
export function prevHighestCloseSeries(close, window = 20) {
  return shift(rollingMax(close, window), 1);
}

/**
 * Lowest close of the PREVIOUS `window` sessions (current session excluded).
 * @param {(number|null)[]} close @param {number} [window] @returns {(number|null)[]}
 */
export function prevLowestCloseSeries(close, window = 20) {
  return shift(rollingMin(close, window), 1);
}

/**
 * Causal breakout: close above the previous `window`-day highest close.
 * @param {(number|null)[]} close @param {number} [window] @returns {(boolean|null)[]}
 */
export function breakoutSeries(close, window = 20) {
  const prevHigh = prevHighestCloseSeries(close, window);
  return close.map((c, i) => (c === null || prevHigh[i] === null ? null : c > /** @type {number} */ (prevHigh[i])));
}

/**
 * Drawdown (%) from the causal (prefix) peak close.
 * @param {(number|null)[]} close @returns {(number|null)[]}
 */
export function drawdownFromCausalPeakSeries(close) {
  const peak = expandingMax(close);
  return close.map((c, i) => {
    const p = peak[i];
    if (c === null || p === null || p === 0) return null;
    return (c / p - 1) * 100;
  });
}

/**
 * Simple higher-high: high[i] > high[i-1]. Null on first bar or null inputs.
 * @param {(number|null)[]} high @returns {(boolean|null)[]}
 */
export function higherHighSeries(high) {
  return high.map((h, i) => {
    if (i === 0) return null;
    const prev = high[i - 1];
    if (h === null || prev === null) return null;
    return h > prev;
  });
}

/**
 * Simple higher-low: low[i] > low[i-1]. Null on first bar or null inputs.
 * @param {(number|null)[]} low @returns {(boolean|null)[]}
 */
export function higherLowSeries(low) {
  return low.map((l, i) => {
    if (i === 0) return null;
    const prev = low[i - 1];
    if (l === null || prev === null) return null;
    return l > prev;
  });
}
