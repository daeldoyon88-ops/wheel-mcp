/** L4A-A4 — moving averages, trend state, Wilder ADX and benchmark-relative strength. */

import {
  absoluteFixed,
  addFixed,
  availableFixedCell,
  availableScalarCell,
  averageFixed,
  compareFixed,
  divideFixed,
  exponentialMovingAverageSeries,
  fixedFromInteger,
  multiplyByRatio,
  ratioChangeFixed,
  simpleMovingAverageSeries,
  subtractFixed,
  unavailableCell,
  wilderStep,
} from './fixedPointFeatureMathL4V1.mjs';
import { simpleReturnAt } from './returnsDrawdownFeaturesL4V1.mjs';
import { computeTrueRangeSeries } from './volatilityFeaturesL4V1.mjs';

const SMA_PERIODS = Object.freeze([20, 50, 200]);
const EMA_PERIODS = Object.freeze([8, 34, 50, 200]);
const RELATIVE_PERIODS = Object.freeze([5, 20, 60]);
const ZERO = fixedFromInteger(0n);

/** @param {Array<any>} bars */
function computeAdxSeries(bars) {
  const output = bars.map(() => ({
    plusDi: { value: null, availability: 'INSUFFICIENT_HISTORY' },
    minusDi: { value: null, availability: 'INSUFFICIENT_HISTORY' },
    adx: { value: null, availability: 'INSUFFICIENT_HISTORY' },
  }));
  const trueRange = computeTrueRangeSeries(bars);
  const plusDm = [null];
  const minusDm = [null];
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    if (!current?.high || !current?.low || !previous?.high || !previous?.low) {
      plusDm.push(null);
      minusDm.push(null);
      continue;
    }
    const upMove = subtractFixed(current.high, previous.high);
    const downMove = subtractFixed(previous.low, current.low);
    plusDm.push(upMove.atoms > 0n && compareFixed(upMove, downMove) > 0 ? upMove : ZERO);
    minusDm.push(downMove.atoms > 0n && compareFixed(downMove, upMove) > 0 ? downMove : ZERO);
  }

  let smoothedTr = null;
  let smoothedPlus = null;
  let smoothedMinus = null;
  const dx = bars.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  for (let index = 14; index < bars.length; index += 1) {
    if (index === 14) {
      const trSeed = trueRange.slice(1, 15);
      const plusSeed = plusDm.slice(1, 15);
      const minusSeed = minusDm.slice(1, 15);
      if (trSeed.some((cell) => cell.availability !== 'AVAILABLE')
          || plusSeed.some((value) => value === null) || minusSeed.some((value) => value === null)) {
        output[index].plusDi = { value: null, availability: 'MISSING_INPUT' };
        output[index].minusDi = { value: null, availability: 'MISSING_INPUT' };
        dx[index] = { value: null, availability: 'MISSING_INPUT' };
        continue;
      }
      smoothedTr = averageFixed(trSeed.map((cell) => cell.value));
      smoothedPlus = averageFixed(plusSeed);
      smoothedMinus = averageFixed(minusSeed);
    } else if (smoothedTr !== null && trueRange[index].availability === 'AVAILABLE'
      && plusDm[index] !== null && minusDm[index] !== null) {
      smoothedTr = wilderStep(smoothedTr, trueRange[index].value, 14);
      smoothedPlus = wilderStep(smoothedPlus, plusDm[index], 14);
      smoothedMinus = wilderStep(smoothedMinus, minusDm[index], 14);
    } else {
      output[index].plusDi = { value: null, availability: 'MISSING_INPUT' };
      output[index].minusDi = { value: null, availability: 'MISSING_INPUT' };
      dx[index] = { value: null, availability: 'MISSING_INPUT' };
      continue;
    }

    let plus;
    let minus;
    if (smoothedTr.atoms === 0n) {
      plus = ZERO;
      minus = ZERO;
    } else {
      plus = multiplyByRatio(divideFixed(smoothedPlus, smoothedTr), 100n, 1n);
      minus = multiplyByRatio(divideFixed(smoothedMinus, smoothedTr), 100n, 1n);
    }
    output[index].plusDi = { value: plus, availability: 'AVAILABLE' };
    output[index].minusDi = { value: minus, availability: 'AVAILABLE' };
    const denominator = addFixed(plus, minus);
    dx[index] = {
      value: denominator.atoms === 0n
        ? ZERO
        : multiplyByRatio(divideFixed(absoluteFixed(subtractFixed(plus, minus)), denominator), 100n, 1n),
      availability: 'AVAILABLE',
    };
  }

  let previousAdx = null;
  for (let index = 27; index < bars.length; index += 1) {
    if (index === 27) {
      const seed = dx.slice(14, 28);
      if (!seed.every((cell) => cell.availability === 'AVAILABLE')) continue;
      previousAdx = averageFixed(seed.map((cell) => cell.value));
    } else if (previousAdx !== null && dx[index].availability === 'AVAILABLE') {
      previousAdx = wilderStep(previousAdx, dx[index].value, 14);
    } else continue;
    output[index].adx = { value: previousAdx, availability: 'AVAILABLE' };
  }
  return output;
}

/** @param {Array<any>} bars */
export function computeTrendFeatures(bars) {
  const closes = bars.map((bar) => bar?.close ?? null);
  const sma = new Map(SMA_PERIODS.map((period) => [period, simpleMovingAverageSeries(closes, period)]));
  const ema = new Map(EMA_PERIODS.map((period) => [period, exponentialMovingAverageSeries(closes, period)]));
  const adx = computeAdxSeries(bars);
  const priceCell = (cell) => cell.availability === 'AVAILABLE'
    ? availableFixedCell(cell.value, 12)
    : unavailableCell(cell.availability);
  const distanceCell = (cell, close) => {
    if (cell.availability !== 'AVAILABLE') return unavailableCell(cell.availability);
    if (!close) return unavailableCell('MISSING_INPUT');
    if (cell.value.atoms === 0n) return unavailableCell('DIVISION_BY_ZERO');
    return availableFixedCell(ratioChangeFixed(close, cell.value));
  };
  const changeCell = (series, index) => {
    if (index < 5) return unavailableCell('INSUFFICIENT_HISTORY');
    if (series[index].availability !== 'AVAILABLE') return unavailableCell(series[index].availability);
    if (series[index - 5].availability !== 'AVAILABLE') return unavailableCell(series[index - 5].availability);
    if (series[index - 5].value.atoms === 0n) return unavailableCell('DIVISION_BY_ZERO');
    return availableFixedCell(ratioChangeFixed(series[index].value, series[index - 5].value));
  };
  const comparisonCell = (left, right) => {
    if (!left || !right) return unavailableCell('MISSING_INPUT');
    if (left.availability && left.availability !== 'AVAILABLE') return unavailableCell(left.availability);
    if (right.availability && right.availability !== 'AVAILABLE') return unavailableCell(right.availability);
    const leftValue = left.value ?? left;
    const rightValue = right.value ?? right;
    return availableScalarCell(compareFixed(leftValue, rightValue) > 0);
  };
  const ratioCell = (cell) => cell.availability === 'AVAILABLE'
    ? availableFixedCell(cell.value)
    : unavailableCell(cell.availability);

  return bars.map((bar, index) => ({
    sma20: priceCell(sma.get(20)[index]),
    sma50: priceCell(sma.get(50)[index]),
    sma200: priceCell(sma.get(200)[index]),
    ema8: priceCell(ema.get(8)[index]),
    ema34: priceCell(ema.get(34)[index]),
    ema50: priceCell(ema.get(50)[index]),
    ema200: priceCell(ema.get(200)[index]),
    distanceToSma20: distanceCell(sma.get(20)[index], bar?.close),
    distanceToSma50: distanceCell(sma.get(50)[index], bar?.close),
    distanceToSma200: distanceCell(sma.get(200)[index], bar?.close),
    distanceToEma8: distanceCell(ema.get(8)[index], bar?.close),
    distanceToEma34: distanceCell(ema.get(34)[index], bar?.close),
    distanceToEma50: distanceCell(ema.get(50)[index], bar?.close),
    distanceToEma200: distanceCell(ema.get(200)[index], bar?.close),
    ema8Change5: changeCell(ema.get(8), index),
    ema34Change5: changeCell(ema.get(34), index),
    ema50Change5: changeCell(ema.get(50), index),
    ema200Change5: changeCell(ema.get(200), index),
    sma20Change5: changeCell(sma.get(20), index),
    sma50Change5: changeCell(sma.get(50), index),
    sma200Change5: changeCell(sma.get(200), index),
    closeAboveEma8: comparisonCell(bar?.close, ema.get(8)[index]),
    closeAboveEma34: comparisonCell(bar?.close, ema.get(34)[index]),
    closeAboveEma50: comparisonCell(bar?.close, ema.get(50)[index]),
    closeAboveEma200: comparisonCell(bar?.close, ema.get(200)[index]),
    ema8AboveEma34: comparisonCell(ema.get(8)[index], ema.get(34)[index]),
    ema34AboveEma50: comparisonCell(ema.get(34)[index], ema.get(50)[index]),
    ema50AboveEma200: comparisonCell(ema.get(50)[index], ema.get(200)[index]),
    plusDi14: ratioCell(adx[index].plusDi),
    minusDi14: ratioCell(adx[index].minusDi),
    adx14: ratioCell(adx[index].adx),
  }));
}

/** @param {Array<any>} subjectBars @param {Record<string, Array<any>|undefined>} benchmarkBarsByRole */
export function computeRelativeStrengthFeatures(subjectBars, benchmarkBarsByRole) {
  const result = {};
  for (const role of ['MARKET', 'SECTOR', 'UNDERLYING']) {
    const benchmarkBars = benchmarkBarsByRole[role];
    if (benchmarkBars === undefined) {
      result[role] = subjectBars.map(() => ({
        relativePriceRatio: unavailableCell('BENCHMARK_NOT_CONFIGURED'),
        relativeReturn5: unavailableCell('BENCHMARK_NOT_CONFIGURED'),
        relativeReturn20: unavailableCell('BENCHMARK_NOT_CONFIGURED'),
        relativeReturn60: unavailableCell('BENCHMARK_NOT_CONFIGURED'),
        relativeRatioChange20: unavailableCell('BENCHMARK_NOT_CONFIGURED'),
        relativeRatioChange60: unavailableCell('BENCHMARK_NOT_CONFIGURED'),
      }));
      continue;
    }
    const byDate = new Map(benchmarkBars.map((bar) => [bar.source.sessionDate, bar]));
    result[role] = subjectBars.map((subject, index) => {
      const currentBenchmark = byDate.get(subject.source.sessionDate);
      let currentRatio;
      if (!currentBenchmark) currentRatio = unavailableCell('BENCHMARK_SESSION_MISSING');
      else if (currentBenchmark.close.atoms === 0n) currentRatio = unavailableCell('DIVISION_BY_ZERO');
      else currentRatio = availableFixedCell(divideFixed(subject.close, currentBenchmark.close));

      const relativeReturns = {};
      const ratioChanges = {};
      for (const period of RELATIVE_PERIODS) {
        if (index < period) {
          relativeReturns[period] = unavailableCell('INSUFFICIENT_HISTORY');
          if (period !== 5) ratioChanges[period] = unavailableCell('INSUFFICIENT_HISTORY');
          continue;
        }
        const previousSubject = subjectBars[index - period];
        const previousBenchmark = byDate.get(previousSubject.source.sessionDate);
        if (!currentBenchmark || !previousBenchmark) {
          relativeReturns[period] = unavailableCell('BENCHMARK_SESSION_MISSING');
          if (period !== 5) ratioChanges[period] = unavailableCell('BENCHMARK_SESSION_MISSING');
          continue;
        }
        if (previousSubject.close.atoms === 0n || previousBenchmark.close.atoms === 0n
            || currentBenchmark.close.atoms === 0n) {
          relativeReturns[period] = unavailableCell('DIVISION_BY_ZERO');
          if (period !== 5) ratioChanges[period] = unavailableCell('DIVISION_BY_ZERO');
          continue;
        }
        const subjectReturn = simpleReturnAt(subjectBars, index, period);
        const benchmarkReturn = ratioChangeFixed(currentBenchmark.close, previousBenchmark.close);
        relativeReturns[period] = subjectReturn.availability === 'AVAILABLE'
          ? availableFixedCell(subtractFixed(subjectReturn.value, benchmarkReturn))
          : unavailableCell(subjectReturn.availability);
        if (period !== 5) {
          const ratioNow = divideFixed(subject.close, currentBenchmark.close);
          const ratioThen = divideFixed(previousSubject.close, previousBenchmark.close);
          ratioChanges[period] = ratioThen.atoms === 0n
            ? unavailableCell('DIVISION_BY_ZERO')
            : availableFixedCell(ratioChangeFixed(ratioNow, ratioThen));
        }
      }
      return {
        relativePriceRatio: currentRatio,
        relativeReturn5: relativeReturns[5],
        relativeReturn20: relativeReturns[20],
        relativeReturn60: relativeReturns[60],
        relativeRatioChange20: ratioChanges[20],
        relativeRatioChange60: ratioChanges[60],
      };
    });
  }
  return result;
}
