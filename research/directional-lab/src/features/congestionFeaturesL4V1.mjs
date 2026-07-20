/**
 * L4A-B2 — raw congestion and compression attributes over closed windows.
 *
 * Closed conventions:
 * - priceRangeN = (highestHighN - lowestLowN) / close over the last N
 *   observed sessions including the current one;
 * - rangeCompression20Vs60 divides the raw 20-session range by the raw
 *   60-session range (a zero reference range is FLAT_RANGE);
 * - directionalEfficiency20 = |close(t) - close(t-20)| divided by the sum of
 *   the twenty absolute close-to-close moves ending at t (a zero path sum is
 *   DIVISION_BY_ZERO); its first available index is 20;
 * - congestionPosition20 locates the close inside the 20-session range
 *   (a zero range is FLAT_RANGE);
 * - isCongestion20 is the closed descriptive boolean
 *   directionalEfficiency20 <= 0.30 AND priceRange20Pct <= 4 × atr14Pct,
 *   with atr14Pct taken from the verified L4A-A rows. It is a fixed
 *   descriptive threshold, never a predictive signal.
 */

import {
  FEATURE_CALCULATION_SCALE,
  availableFixedCell,
  divideRoundHalfEven,
  fixedFromScaledAtoms,
  multiplyByRatio,
  powerOfTen,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';

const WINDOW = 20;
const REFERENCE_WINDOW = 60;

/** @param {Array<any>} bars @param {number} index @param {number} period */
function rawRangeAtoms(bars, index, period) {
  let highest = bars[index - period + 1].high.atoms;
  let lowest = bars[index - period + 1].low.atoms;
  for (let cursor = index - period + 2; cursor <= index; cursor += 1) {
    if (bars[cursor].high.atoms > highest) highest = bars[cursor].high.atoms;
    if (bars[cursor].low.atoms < lowest) lowest = bars[cursor].low.atoms;
  }
  return { rangeAtoms: highest - lowest, lowestAtoms: lowest };
}

/**
 * @param {Array<any>} bars internal volume-structure bars
 * @param {Array<{atr14Pct: {value: any, availability: string}}>} technicalCells
 */
export function computeCongestionFeatures(bars, technicalCells) {
  const unit = powerOfTen(FEATURE_CALCULATION_SCALE);
  const efficiencyThresholdAtoms = 30n * unit / 100n;

  const prefixAbsoluteMove = [0n, 0n];
  for (let index = 1; index < bars.length; index += 1) {
    const move = bars[index].close.atoms - bars[index - 1].close.atoms;
    prefixAbsoluteMove.push(prefixAbsoluteMove[index] + (move < 0n ? -move : move));
  }

  return bars.map((bar, index) => {
    const closeAtoms = bar.close.atoms;

    let range20 = null;
    let priceRange20Pct;
    let congestionPosition20;
    if (index + 1 < WINDOW) {
      priceRange20Pct = unavailableCell('INSUFFICIENT_HISTORY');
      congestionPosition20 = unavailableCell('INSUFFICIENT_HISTORY');
    } else {
      range20 = rawRangeAtoms(bars, index, WINDOW);
      priceRange20Pct = closeAtoms === 0n
        ? unavailableCell('DIVISION_BY_ZERO')
        : availableFixedCell(fixedFromScaledAtoms(
          divideRoundHalfEven(range20.rangeAtoms * unit, closeAtoms),
        ));
      congestionPosition20 = range20.rangeAtoms === 0n
        ? unavailableCell('FLAT_RANGE')
        : availableFixedCell(fixedFromScaledAtoms(
          divideRoundHalfEven((closeAtoms - range20.lowestAtoms) * unit, range20.rangeAtoms),
        ));
    }

    let range60 = null;
    let priceRange60Pct;
    if (index + 1 < REFERENCE_WINDOW) {
      priceRange60Pct = unavailableCell('INSUFFICIENT_HISTORY');
    } else {
      range60 = rawRangeAtoms(bars, index, REFERENCE_WINDOW);
      priceRange60Pct = closeAtoms === 0n
        ? unavailableCell('DIVISION_BY_ZERO')
        : availableFixedCell(fixedFromScaledAtoms(
          divideRoundHalfEven(range60.rangeAtoms * unit, closeAtoms),
        ));
    }

    let rangeCompression20Vs60;
    if (range20 === null) rangeCompression20Vs60 = unavailableCell('INSUFFICIENT_HISTORY');
    else if (range60 === null) rangeCompression20Vs60 = unavailableCell('INSUFFICIENT_HISTORY');
    else if (range60.rangeAtoms === 0n) rangeCompression20Vs60 = unavailableCell('FLAT_RANGE');
    else {
      rangeCompression20Vs60 = availableFixedCell(fixedFromScaledAtoms(
        divideRoundHalfEven(range20.rangeAtoms * unit, range60.rangeAtoms),
      ));
    }

    let efficiencyAtoms = null;
    let directionalEfficiency20;
    if (index < WINDOW) directionalEfficiency20 = unavailableCell('INSUFFICIENT_HISTORY');
    else {
      const pathAtoms = prefixAbsoluteMove[index + 1] - prefixAbsoluteMove[index - WINDOW + 1];
      if (pathAtoms === 0n) directionalEfficiency20 = unavailableCell('DIVISION_BY_ZERO');
      else {
        const move = closeAtoms - bars[index - WINDOW].close.atoms;
        efficiencyAtoms = divideRoundHalfEven((move < 0n ? -move : move) * unit, pathAtoms);
        directionalEfficiency20 = availableFixedCell(fixedFromScaledAtoms(efficiencyAtoms));
      }
    }

    let isCongestion20;
    const atrPct = technicalCells[index].atr14Pct;
    if (directionalEfficiency20.availability !== 'AVAILABLE') {
      isCongestion20 = unavailableCell(directionalEfficiency20.availability);
    } else if (priceRange20Pct.availability !== 'AVAILABLE') {
      isCongestion20 = unavailableCell(priceRange20Pct.availability);
    } else if (atrPct.availability !== 'AVAILABLE') {
      isCongestion20 = unavailableCell(atrPct.availability);
    } else {
      const rangePctAtoms = divideRoundHalfEven(range20.rangeAtoms * unit, closeAtoms);
      const atrBoundAtoms = multiplyByRatio(atrPct.value, 4n, 1n).atoms;
      isCongestion20 = {
        value: efficiencyAtoms <= efficiencyThresholdAtoms && rangePctAtoms <= atrBoundAtoms,
        availability: 'AVAILABLE',
      };
    }

    return {
      priceRange20Pct,
      priceRange60Pct,
      rangeCompression20Vs60,
      directionalEfficiency20,
      congestionPosition20,
      isCongestion20,
    };
  });
}
