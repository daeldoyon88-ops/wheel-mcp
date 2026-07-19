/** L4A-A1 — deterministic simple returns and causal drawdowns. */

import {
  availableFixedCell,
  availableScalarCell,
  compareFixed,
  ratioChangeFixed,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';

const RETURN_PERIODS = Object.freeze([1, 3, 5, 10, 20, 60]);
const TRAILING_PEAK_PERIODS = Object.freeze([20, 60, 252]);

/** @param {Array<any>} bars @param {number} index @param {number} period */
export function simpleReturnAt(bars, index, period) {
  if (index < period) return { value: null, availability: 'INSUFFICIENT_HISTORY' };
  const reference = bars[index - period]?.close;
  const close = bars[index]?.close;
  if (!reference || !close) return { value: null, availability: 'MISSING_INPUT' };
  if (reference.atoms === 0n) return { value: null, availability: 'DIVISION_BY_ZERO' };
  return { value: ratioChangeFixed(close, reference), availability: 'AVAILABLE' };
}

/** Most recent equal peak wins. @param {Array<any>} bars @param {number} start @param {number} end */
function peakBetween(bars, start, end) {
  let peak = bars[start]?.close ?? null;
  let peakIndex = start;
  if (peak === null) return null;
  for (let index = start + 1; index <= end; index += 1) {
    const close = bars[index]?.close;
    if (!close) return null;
    if (compareFixed(close, peak) >= 0) {
      peak = close;
      peakIndex = index;
    }
  }
  return { peak, peakIndex };
}

/** @param {Array<any>} bars @param {number} index @param {number|null} period */
function drawdownCellPair(bars, index, period) {
  if (period !== null && index + 1 < period) {
    return {
      drawdown: unavailableCell('INSUFFICIENT_HISTORY'),
      sessionsSince: unavailableCell('INSUFFICIENT_HISTORY'),
    };
  }
  const start = period === null ? 0 : index - period + 1;
  const resolved = peakBetween(bars, start, index);
  if (resolved === null || !bars[index]?.close) {
    return {
      drawdown: unavailableCell('MISSING_INPUT'),
      sessionsSince: unavailableCell('MISSING_INPUT'),
    };
  }
  if (resolved.peak.atoms === 0n) {
    return {
      drawdown: unavailableCell('DIVISION_BY_ZERO'),
      sessionsSince: unavailableCell('DIVISION_BY_ZERO'),
    };
  }
  return {
    drawdown: availableFixedCell(ratioChangeFixed(bars[index].close, resolved.peak)),
    sessionsSince: availableScalarCell(index - resolved.peakIndex),
  };
}

/** @param {Array<any>} bars */
export function computeReturnsDrawdownFeatures(bars) {
  const runningPeak = [];
  let runningPeakValue = null;
  let runningPeakIndex = -1;
  for (let index = 0; index < bars.length; index += 1) {
    const close = bars[index]?.close;
    if (!close) {
      runningPeak.push(null);
      continue;
    }
    if (runningPeakValue === null || compareFixed(close, runningPeakValue) >= 0) {
      runningPeakValue = close;
      runningPeakIndex = index;
    }
    runningPeak.push({ peak: runningPeakValue, peakIndex: runningPeakIndex });
  }

  return bars.map((bar, index) => {
    const returns = {};
    for (const period of RETURN_PERIODS) {
      const result = simpleReturnAt(bars, index, period);
      returns[`return${period}`] = result.availability === 'AVAILABLE'
        ? availableFixedCell(result.value)
        : unavailableCell(result.availability);
    }
    let running;
    if (!bar?.close || runningPeak[index] === null) {
      running = {
        drawdown: unavailableCell('MISSING_INPUT'),
        sessionsSince: unavailableCell('MISSING_INPUT'),
      };
    } else if (runningPeak[index].peak.atoms === 0n) {
      running = {
        drawdown: unavailableCell('DIVISION_BY_ZERO'),
        sessionsSince: unavailableCell('DIVISION_BY_ZERO'),
      };
    } else {
      running = {
        drawdown: availableFixedCell(ratioChangeFixed(bar.close, runningPeak[index].peak)),
        sessionsSince: availableScalarCell(index - runningPeak[index].peakIndex),
      };
    }
    const trailing = Object.fromEntries(
      TRAILING_PEAK_PERIODS.map((period) => [period, drawdownCellPair(bars, index, period)]),
    );
    return {
      return1: returns.return1,
      return3: returns.return3,
      return5: returns.return5,
      return10: returns.return10,
      return20: returns.return20,
      return60: returns.return60,
      drawdownFromRunningPeak: running.drawdown,
      drawdownFrom20SessionPeak: trailing[20].drawdown,
      drawdownFrom60SessionPeak: trailing[60].drawdown,
      drawdownFrom252SessionPeak: trailing[252].drawdown,
      sessionsSinceRunningPeak: running.sessionsSince,
      sessionsSince20SessionPeak: trailing[20].sessionsSince,
      sessionsSince60SessionPeak: trailing[60].sessionsSince,
      sessionsSince252SessionPeak: trailing[252].sessionsSince,
    };
  });
}
