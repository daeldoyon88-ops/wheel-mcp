/** L4A-A2 — true range, Wilder ATR, ranges, gaps and realized volatility. */

import {
  absoluteFixed,
  addFixed,
  availableFixedCell,
  averageFixed,
  compareFixed,
  divideRoundHalfEven,
  divideFixed,
  fixedFromInteger,
  multiplyFixed,
  ratioChangeFixed,
  squareRootFixed,
  subtractFixed,
  unavailableCell,
  wilderStep,
} from './fixedPointFeatureMathL4V1.mjs';
import { simpleReturnAt } from './returnsDrawdownFeaturesL4V1.mjs';

const VOLATILITY_PERIODS = Object.freeze([5, 10, 20, 60]);
const SQRT_252 = squareRootFixed(fixedFromInteger(252n));

/** @param {Array<any>} bars */
export function computeTrueRangeSeries(bars) {
  return bars.map((bar, index) => {
    if (!bar?.high || !bar?.low) return { value: null, availability: 'MISSING_INPUT' };
    const highLow = subtractFixed(bar.high, bar.low);
    if (index === 0) return { value: highLow, availability: 'AVAILABLE' };
    const previousClose = bars[index - 1]?.close;
    if (!previousClose) return { value: null, availability: 'MISSING_INPUT' };
    const highGap = absoluteFixed(subtractFixed(bar.high, previousClose));
    const lowGap = absoluteFixed(subtractFixed(bar.low, previousClose));
    let maximum = highLow;
    if (compareFixed(highGap, maximum) > 0) maximum = highGap;
    if (compareFixed(lowGap, maximum) > 0) maximum = lowGap;
    return { value: maximum, availability: 'AVAILABLE' };
  });
}

/** @param {Array<any>} trueRanges */
export function computeAtr14Series(trueRanges) {
  const result = trueRanges.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  let previous = null;
  for (let index = 0; index < trueRanges.length; index += 1) {
    if (trueRanges[index].availability !== 'AVAILABLE') {
      result[index] = { value: null, availability: trueRanges[index].availability };
      previous = null;
      continue;
    }
    if (index < 13) continue;
    if (index === 13 || previous === null) {
      const window = trueRanges.slice(index - 13, index + 1);
      if (window.some((cell) => cell.availability !== 'AVAILABLE')) {
        result[index] = { value: null, availability: 'MISSING_INPUT' };
        continue;
      }
      previous = averageFixed(window.map((cell) => cell.value));
    } else {
      previous = wilderStep(previous, trueRanges[index].value, 14);
    }
    result[index] = { value: previous, availability: 'AVAILABLE' };
  }
  return result;
}

/** @param {Array<any>} bars @param {number} index @param {number} period */
export function realizedVolatilityAt(bars, index, period) {
  if (index < period) return { value: null, availability: 'INSUFFICIENT_HISTORY' };
  const returns = [];
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const cell = simpleReturnAt(bars, cursor, 1);
    if (cell.availability !== 'AVAILABLE') return cell;
    returns.push(cell.value);
  }
  const mean = averageFixed(returns);
  let squaredDeviationSum = fixedFromInteger(0n);
  for (const value of returns) {
    const deviation = subtractFixed(value, mean);
    squaredDeviationSum = addFixed(squaredDeviationSum, multiplyFixed(deviation, deviation));
  }
  const sampleVariance = {
    atoms: divideRoundHalfEven(squaredDeviationSum.atoms, BigInt(period - 1)),
    scale: squaredDeviationSum.scale,
  };
  const standardDeviation = squareRootFixed(sampleVariance);
  return { value: multiplyFixed(standardDeviation, SQRT_252), availability: 'AVAILABLE' };
}

/** @param {Array<any>} bars */
export function computeVolatilityFeatures(bars) {
  const trueRanges = computeTrueRangeSeries(bars);
  const atr14 = computeAtr14Series(trueRanges);
  const realized = new Map(VOLATILITY_PERIODS.map((period) => [
    period,
    bars.map((bar, index) => realizedVolatilityAt(bars, index, period)),
  ]));

  return bars.map((bar, index) => {
    const trueRange = trueRanges[index].availability === 'AVAILABLE'
      ? availableFixedCell(trueRanges[index].value, 12)
      : unavailableCell(trueRanges[index].availability);
    const atr = atr14[index].availability === 'AVAILABLE'
      ? availableFixedCell(atr14[index].value, 12)
      : unavailableCell(atr14[index].availability);
    let atrPct;
    if (atr14[index].availability !== 'AVAILABLE') atrPct = unavailableCell(atr14[index].availability);
    else if (!bar?.close) atrPct = unavailableCell('MISSING_INPUT');
    else if (bar.close.atoms === 0n) atrPct = unavailableCell('DIVISION_BY_ZERO');
    else atrPct = availableFixedCell(divideFixed(atr14[index].value, bar.close));

    let intradayRangePct;
    let closeLocationValue;
    if (!bar?.high || !bar?.low || !bar?.close) {
      intradayRangePct = unavailableCell('MISSING_INPUT');
      closeLocationValue = unavailableCell('MISSING_INPUT');
    } else {
      const range = subtractFixed(bar.high, bar.low);
      intradayRangePct = bar.close.atoms === 0n
        ? unavailableCell('DIVISION_BY_ZERO')
        : availableFixedCell(divideFixed(range, bar.close));
      closeLocationValue = range.atoms === 0n
        ? unavailableCell('FLAT_RANGE')
        : availableFixedCell(divideFixed(
          subtractFixed(subtractFixed(bar.close, bar.low), subtractFixed(bar.high, bar.close)),
          range,
        ));
    }

    let gapOpenPct;
    if (index === 0) gapOpenPct = unavailableCell('INSUFFICIENT_HISTORY');
    else if (!bar?.open || !bars[index - 1]?.close) gapOpenPct = unavailableCell('MISSING_INPUT');
    else if (bars[index - 1].close.atoms === 0n) gapOpenPct = unavailableCell('DIVISION_BY_ZERO');
    else gapOpenPct = availableFixedCell(ratioChangeFixed(bar.open, bars[index - 1].close));

    const volatilityCells = {};
    for (const period of VOLATILITY_PERIODS) {
      const cell = realized.get(period)[index];
      volatilityCells[period] = cell.availability === 'AVAILABLE'
        ? availableFixedCell(cell.value)
        : unavailableCell(cell.availability);
    }
    let acceleration;
    const vol20 = realized.get(20)[index];
    const vol60 = realized.get(60)[index];
    if (vol20.availability !== 'AVAILABLE') acceleration = unavailableCell(vol20.availability);
    else if (vol60.availability !== 'AVAILABLE') acceleration = unavailableCell(vol60.availability);
    else if (vol60.value.atoms === 0n) acceleration = unavailableCell('DIVISION_BY_ZERO');
    else acceleration = availableFixedCell(ratioChangeFixed(vol20.value, vol60.value));

    return {
      trueRange,
      atr14: atr,
      atr14Pct: atrPct,
      intradayRangePct,
      gapOpenPct,
      closeLocationValue,
      realizedVolatility5: volatilityCells[5],
      realizedVolatility10: volatilityCells[10],
      realizedVolatility20: volatilityCells[20],
      realizedVolatility60: volatilityCells[60],
      volatilityAcceleration20vs60: acceleration,
    };
  });
}
