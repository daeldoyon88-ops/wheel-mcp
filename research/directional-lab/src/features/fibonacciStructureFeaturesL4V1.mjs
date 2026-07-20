/**
 * L4A-B2 — deterministic Fibonacci structure from the alternated
 * confirmed-pivot stream.
 *
 * Closed conventions:
 * - the active leg is the last two consecutive entries of the alternated
 *   stream (they are opposite types by construction); no leg means every
 *   fibonacci cell is NO_ACTIVE_FIBONACCI_LEG;
 * - SWING_LOW → SWING_HIGH is a BULLISH_RETRACEMENT with
 *   level(r) = high - (high - low) × r; SWING_HIGH → SWING_LOW is a
 *   BEARISH_RETRACEMENT with level(r) = low + (high - low) × r;
 * - the ratios are the exact rationals 236/1000, 382/1000, 500/1000,
 *   618/1000 and 786/1000 — closed, never caller-supplied, never floats;
 * - distances are close / level - 1; there is no subjective "best level"
 *   and no score of any kind.
 */

import {
  availableFixedCell,
  multiplyByRatio,
  ratioChangeFixed,
  subtractFixed,
  addFixed,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';
import { assertMarketVolumeStructureRuntimeSectionV1 } from './marketVolumeStructureRuntimePolicyL4V1.mjs';

/**
 * @param {Array<any>} bars internal volume-structure bars
 * @param {Array<any>} streamStates per-row alternated pivot stream states
 */
export function computeFibonacciFeatures(bars, streamStates, config) {
  assertMarketVolumeStructureRuntimeSectionV1(config, 'fibonacci');
  const { internalScale, priceScale, ratioScale } = config.scales;
  return bars.map((bar, index) => {
    const leg = streamStates[index].leg;
    if (leg === null) {
      const cells = {};
      for (const name of [
        'fibonacciDirection',
        'fibonacciStartSessionDate', 'fibonacciStartConfirmedAtSessionDate', 'fibonacciStartPrice',
        'fibonacciEndSessionDate', 'fibonacciEndConfirmedAtSessionDate', 'fibonacciEndPrice',
      ]) cells[name] = unavailableCell('NO_ACTIVE_FIBONACCI_LEG');
      for (const { suffix } of config.ratios) {
        cells[`fibonacci${suffix}`] = unavailableCell('NO_ACTIVE_FIBONACCI_LEG');
        cells[`distanceToFibonacci${suffix}`] = unavailableCell('NO_ACTIVE_FIBONACCI_LEG');
      }
      return cells;
    }
    const bullish = leg.start.pivotType === 'SWING_LOW';
    const high = bullish ? leg.end.pivotPrice : leg.start.pivotPrice;
    const low = bullish ? leg.start.pivotPrice : leg.end.pivotPrice;
    const range = subtractFixed(high, low);
    const cells = {
      fibonacciDirection: {
        value: bullish ? 'BULLISH_RETRACEMENT' : 'BEARISH_RETRACEMENT',
        availability: 'AVAILABLE',
      },
      fibonacciStartSessionDate: { value: leg.start.pivotSessionDate, availability: 'AVAILABLE' },
      fibonacciStartConfirmedAtSessionDate: { value: leg.start.confirmedAtSessionDate, availability: 'AVAILABLE' },
      fibonacciStartPrice: availableFixedCell(leg.start.pivotPrice, priceScale),
      fibonacciEndSessionDate: { value: leg.end.pivotSessionDate, availability: 'AVAILABLE' },
      fibonacciEndConfirmedAtSessionDate: { value: leg.end.confirmedAtSessionDate, availability: 'AVAILABLE' },
      fibonacciEndPrice: availableFixedCell(leg.end.pivotPrice, priceScale),
    };
    for (const { suffix, numerator, denominator } of config.ratios) {
      const retracement = multiplyByRatio(range, numerator, denominator);
      const level = bullish ? subtractFixed(high, retracement) : addFixed(low, retracement);
      cells[`fibonacci${suffix}`] = availableFixedCell(level, priceScale);
      cells[`distanceToFibonacci${suffix}`] = availableFixedCell(
        ratioChangeFixed(bar.close, level, internalScale), ratioScale,
      );
    }
    return cells;
  });
}
