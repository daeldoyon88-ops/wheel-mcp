/** L4A-A3 — RSI, MACD, stochastic oscillators, CCI and ROC. */

import {
  absoluteFixed,
  addFixed,
  availableFixedCell,
  averageFixed,
  compareFixed,
  divideFixed,
  exponentialMovingAverageSeries,
  fixedFromInteger,
  multiplyByRatio,
  simpleMovingAverageSeries,
  subtractFixed,
  unavailableCell,
  wilderStep,
} from './fixedPointFeatureMathL4V1.mjs';
import { simpleReturnAt } from './returnsDrawdownFeaturesL4V1.mjs';

const ZERO = fixedFromInteger(0n);
const FIFTY = fixedFromInteger(50n);
const ONE_HUNDRED = fixedFromInteger(100n);

/** @param {any} averageGain @param {any} averageLoss */
function rsiValue(averageGain, averageLoss) {
  if (averageGain.atoms === 0n && averageLoss.atoms === 0n) return FIFTY;
  if (averageLoss.atoms === 0n) return ONE_HUNDRED;
  if (averageGain.atoms === 0n) return ZERO;
  return multiplyByRatio(divideFixed(averageGain, addFixed(averageGain, averageLoss)), 100n, 1n);
}

/** Wilder RSI14, seed after exactly fourteen close variations. */
export function computeRsi14Series(bars) {
  const output = bars.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  if (bars.length <= 14) return output;
  const gains = [null];
  const losses = [null];
  for (let index = 1; index < bars.length; index += 1) {
    if (!bars[index]?.close || !bars[index - 1]?.close) {
      gains.push(null);
      losses.push(null);
      continue;
    }
    const change = subtractFixed(bars[index].close, bars[index - 1].close);
    gains.push(change.atoms > 0n ? change : ZERO);
    losses.push(change.atoms < 0n ? absoluteFixed(change) : ZERO);
  }
  const seedGains = gains.slice(1, 15);
  const seedLosses = losses.slice(1, 15);
  if (seedGains.some((value) => value === null) || seedLosses.some((value) => value === null)) {
    output[14] = { value: null, availability: 'MISSING_INPUT' };
    return output;
  }
  let averageGain = averageFixed(seedGains);
  let averageLoss = averageFixed(seedLosses);
  output[14] = { value: rsiValue(averageGain, averageLoss), availability: 'AVAILABLE' };
  for (let index = 15; index < bars.length; index += 1) {
    if (gains[index] === null || losses[index] === null) {
      output[index] = { value: null, availability: 'MISSING_INPUT' };
      continue;
    }
    averageGain = wilderStep(averageGain, gains[index], 14);
    averageLoss = wilderStep(averageLoss, losses[index], 14);
    output[index] = { value: rsiValue(averageGain, averageLoss), availability: 'AVAILABLE' };
  }
  return output;
}

/** @param {Array<any>} bars */
function computeMacdSeries(bars) {
  const closes = bars.map((bar) => bar?.close ?? null);
  const ema12 = exponentialMovingAverageSeries(closes, 12);
  const ema26 = exponentialMovingAverageSeries(closes, 26);
  const line = bars.map((bar, index) => (
    ema12[index].availability === 'AVAILABLE' && ema26[index].availability === 'AVAILABLE'
      ? { value: subtractFixed(ema12[index].value, ema26[index].value), availability: 'AVAILABLE' }
      : { value: null, availability: index < 25 ? 'INSUFFICIENT_HISTORY' : 'MISSING_INPUT' }
  ));
  const firstLineIndex = line.findIndex((cell) => cell.availability === 'AVAILABLE');
  const signal = bars.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  if (firstLineIndex >= 0) {
    const compact = line.slice(firstLineIndex).map((cell) => cell.value);
    const compactSignal = exponentialMovingAverageSeries(compact, 9);
    for (let index = 0; index < compactSignal.length; index += 1) {
      signal[firstLineIndex + index] = compactSignal[index];
    }
  }
  const histogram = bars.map((bar, index) => (
    line[index].availability === 'AVAILABLE' && signal[index].availability === 'AVAILABLE'
      ? { value: subtractFixed(line[index].value, signal[index].value), availability: 'AVAILABLE' }
      : { value: null, availability: signal[index].availability }
  ));
  return { line, signal, histogram };
}

/** @param {Array<any>} bars */
function computeStochasticSeries(bars) {
  const k = bars.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  for (let index = 13; index < bars.length; index += 1) {
    const window = bars.slice(index - 13, index + 1);
    if (window.some((bar) => !bar?.high || !bar?.low) || !bars[index]?.close) {
      k[index] = { value: null, availability: 'MISSING_INPUT' };
      continue;
    }
    let highest = window[0].high;
    let lowest = window[0].low;
    for (const bar of window.slice(1)) {
      if (compareFixed(bar.high, highest) > 0) highest = bar.high;
      if (compareFixed(bar.low, lowest) < 0) lowest = bar.low;
    }
    const range = subtractFixed(highest, lowest);
    k[index] = {
      value: range.atoms === 0n
        ? FIFTY
        : multiplyByRatio(divideFixed(subtractFixed(bars[index].close, lowest), range), 100n, 1n),
      availability: 'AVAILABLE',
    };
  }
  const d = bars.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  for (let index = 2; index < bars.length; index += 1) {
    const window = k.slice(index - 2, index + 1);
    if (window.every((cell) => cell.availability === 'AVAILABLE')) {
      d[index] = { value: averageFixed(window.map((cell) => cell.value)), availability: 'AVAILABLE' };
    } else if (window.some((cell) => cell.availability === 'MISSING_INPUT')) {
      d[index] = { value: null, availability: 'MISSING_INPUT' };
    }
  }
  return { k, d };
}

/** @param {Array<any>} rsi */
function computeStochRsiSeries(rsi) {
  const raw = rsi.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  for (let index = 13; index < rsi.length; index += 1) {
    const window = rsi.slice(index - 13, index + 1);
    if (!window.every((cell) => cell.availability === 'AVAILABLE')) continue;
    let highest = window[0].value;
    let lowest = window[0].value;
    for (const cell of window.slice(1)) {
      if (compareFixed(cell.value, highest) > 0) highest = cell.value;
      if (compareFixed(cell.value, lowest) < 0) lowest = cell.value;
    }
    const range = subtractFixed(highest, lowest);
    raw[index] = {
      value: range.atoms === 0n
        ? FIFTY
        : multiplyByRatio(divideFixed(subtractFixed(rsi[index].value, lowest), range), 100n, 1n),
      availability: 'AVAILABLE',
    };
  }
  const smooth = (input) => {
    const output = input.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
    for (let index = 2; index < input.length; index += 1) {
      const window = input.slice(index - 2, index + 1);
      if (window.every((cell) => cell.availability === 'AVAILABLE')) {
        output[index] = { value: averageFixed(window.map((cell) => cell.value)), availability: 'AVAILABLE' };
      }
    }
    return output;
  };
  const k = smooth(raw);
  const d = smooth(k);
  return { raw, k, d };
}

/** @param {Array<any>} bars */
function computeCci20Series(bars) {
  const typical = bars.map((bar) => {
    if (!bar?.high || !bar?.low || !bar?.close) return null;
    return multiplyByRatio(addFixed(addFixed(bar.high, bar.low), bar.close), 1n, 3n);
  });
  const sma = simpleMovingAverageSeries(typical, 20);
  const output = bars.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  for (let index = 19; index < bars.length; index += 1) {
    if (sma[index].availability !== 'AVAILABLE') {
      output[index] = { value: null, availability: sma[index].availability };
      continue;
    }
    const window = typical.slice(index - 19, index + 1);
    if (window.some((value) => value === null)) {
      output[index] = { value: null, availability: 'MISSING_INPUT' };
      continue;
    }
    const meanDeviation = averageFixed(window.map((value) => absoluteFixed(subtractFixed(value, sma[index].value))));
    if (meanDeviation.atoms === 0n) {
      output[index] = { value: ZERO, availability: 'AVAILABLE' };
      continue;
    }
    const denominator = multiplyByRatio(meanDeviation, 15n, 1000n);
    output[index] = {
      value: divideFixed(subtractFixed(typical[index], sma[index].value), denominator),
      availability: 'AVAILABLE',
    };
  }
  return output;
}

/** @param {Array<any>} bars */
export function computeMomentumFeatures(bars) {
  const rsi = computeRsi14Series(bars);
  const macd = computeMacdSeries(bars);
  const stochastic = computeStochasticSeries(bars);
  const stochRsi = computeStochRsiSeries(rsi);
  const cci = computeCci20Series(bars);

  const ratioCell = (cell) => cell.availability === 'AVAILABLE'
    ? availableFixedCell(cell.value)
    : unavailableCell(cell.availability);
  const priceCell = (cell) => cell.availability === 'AVAILABLE'
    ? availableFixedCell(cell.value, 12)
    : unavailableCell(cell.availability);

  return bars.map((bar, index) => {
    const roc = {};
    for (const period of [5, 10, 20]) {
      const cell = simpleReturnAt(bars, index, period);
      roc[period] = ratioCell(cell);
    }
    return {
      rsi14: ratioCell(rsi[index]),
      macdLine: priceCell(macd.line[index]),
      macdSignal: priceCell(macd.signal[index]),
      macdHistogram: priceCell(macd.histogram[index]),
      stochasticK14: ratioCell(stochastic.k[index]),
      stochasticD3: ratioCell(stochastic.d[index]),
      stochRsiRaw: ratioCell(stochRsi.raw[index]),
      stochRsiK: ratioCell(stochRsi.k[index]),
      stochRsiD: ratioCell(stochRsi.d[index]),
      cci20: ratioCell(cci[index]),
      roc5: roc[5],
      roc10: roc[10],
      roc20: roc[20],
    };
  });
}
