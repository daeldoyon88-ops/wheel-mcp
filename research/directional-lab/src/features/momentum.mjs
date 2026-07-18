/**
 * Causal momentum indicators: RSI (Wilder), MACD 12/26/9, ROC.
 */

import { emaSeries } from './movingAverages.mjs';
import { shift } from './rolling.mjs';

/**
 * Wilder RSI. Null until `period` deltas of consecutive non-null closes exist;
 * restarts after any null.
 * @param {(number|null)[]} close
 * @param {number} [period]
 * @returns {(number|null)[]}
 */
export function rsiSeries(close, period = 14) {
  const out = new Array(close.length).fill(null);
  let avgGain = null;
  let avgLoss = null;
  let runStart = 1;
  for (let i = 1; i < close.length; i++) {
    const curr = close[i];
    const prev = close[i - 1];
    if (curr === null || prev === null) {
      avgGain = null;
      avgLoss = null;
      runStart = i + 1;
      continue;
    }
    if (avgGain === null) {
      if (i - runStart + 1 >= period) {
        let gains = 0;
        let losses = 0;
        for (let j = i - period + 1; j <= i; j++) {
          const d = /** @type {number} */ (close[j]) - /** @type {number} */ (close[j - 1]);
          if (d > 0) gains += d; else losses -= d;
        }
        avgGain = gains / period;
        avgLoss = losses / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      const d = curr - prev;
      avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

/**
 * MACD 12/26/9 built from causal EMAs.
 * @param {(number|null)[]} close
 * @param {number} [fast] @param {number} [slow] @param {number} [signal]
 * @returns {{macdLine: (number|null)[], signalLine: (number|null)[], histogram: (number|null)[]}}
 */
export function macdSeries(close, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(close, fast);
  const emaSlow = emaSeries(close, slow);
  const macdLine = close.map((_, i) => (emaFast[i] === null || emaSlow[i] === null ? null : emaFast[i] - emaSlow[i]));
  const signalLine = emaSeries(macdLine, signal);
  const histogram = macdLine.map((m, i) => (m === null || signalLine[i] === null ? null : m - signalLine[i]));
  return { macdLine, signalLine, histogram };
}

/**
 * Rate of change in percent over n bars.
 * @param {(number|null)[]} close @param {number} n @returns {(number|null)[]}
 */
export function rocSeries(close, n) {
  const lagged = shift(close, n);
  return close.map((c, i) => {
    if (c === null || lagged[i] === null || lagged[i] === 0) return null;
    return (c / /** @type {number} */ (lagged[i]) - 1) * 100;
  });
}
