/**
 * L4A-B1 — rolling and pivot-anchored end-of-day volume-weighted average
 * prices. These are EOD approximations from daily OHLCV bars, never an
 * exchange intraday VWAP.
 *
 * Closed conventions:
 * - dailyTypicalPrice = (high + low + close) / 3, HALF_EVEN at the internal
 *   scale, and each typicalPrice × volume term is rounded once at the
 *   internal scale before exact summation;
 * - the anchored VWAP accumulates from the pivot session through the current
 *   session, but only becomes available at the pivot's confirmation row —
 *   at confirmation it may include the already-known bars since the pivot
 *   session (they are historical at that point, never future data);
 * - anchors are the last SWING_LOW / SWING_HIGH entries of the alternated
 *   confirmed-pivot stream;
 * - a null volume inside a window makes the value unavailable and a zero
 *   total volume is reported as ZERO_TOTAL_VOLUME.
 */

import {
  availableFixedCell,
  divideRoundHalfEven,
  fixedFromScaledAtoms,
  powerOfTen,
  ratioChangeFixed,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';
import { assertMarketVolumeStructureRuntimeSectionV1 } from './marketVolumeStructureRuntimePolicyL4V1.mjs';

/**
 * @param {Array<any>} bars internal volume-structure bars
 * @param {Array<any>} streamStates per-row alternated pivot stream states
 */
export function computeEodVolumeWeightedPriceFeatures(bars, streamStates, config) {
  assertMarketVolumeStructureRuntimeSectionV1(config, 'eodVolumeWeightedPrices');
  const { internalScale, priceScale, ratioScale } = config.scales;
  const unit = powerOfTen(internalScale);
  const count = bars.length;
  const volumeAtoms = bars.map((bar) => (bar.volume === null ? null : bar.volume.atoms));
  const typicalAtoms = bars.map((bar) => divideRoundHalfEven(
    bar.high.atoms + bar.low.atoms + bar.close.atoms, 3n,
  ));
  const termAtoms = bars.map((bar, index) => (
    volumeAtoms[index] === null
      ? null
      : divideRoundHalfEven(typicalAtoms[index] * volumeAtoms[index], unit)
  ));

  const prefixVolume = [0n];
  const prefixTerm = [0n];
  const lastNullVolume = [-1];
  for (let index = 0; index < count; index += 1) {
    prefixVolume.push(prefixVolume[index] + (volumeAtoms[index] ?? 0n));
    prefixTerm.push(prefixTerm[index] + (termAtoms[index] ?? 0n));
    lastNullVolume.push(volumeAtoms[index] === null ? index : lastNullVolume[index]);
  }

  const vwapOver = (start, end) => {
    if (lastNullVolume[end + 1] >= start) return { reason: 'MISSING_INPUT' };
    const sumVolume = prefixVolume[end + 1] - prefixVolume[start];
    if (sumVolume === 0n) return { reason: 'ZERO_TOTAL_VOLUME' };
    const sumTerm = prefixTerm[end + 1] - prefixTerm[start];
    return { atoms: divideRoundHalfEven(sumTerm * unit, sumVolume) };
  };

  return bars.map((bar, index) => {
    const cells = {};
    for (const period of config.rollingPeriods) {
      const priceName = `eodVolumeWeightedAveragePrice${period}`;
      const distanceName = `distanceToEodVwap${period}`;
      if (index + 1 < period) {
        cells[priceName] = unavailableCell('INSUFFICIENT_HISTORY');
        cells[distanceName] = unavailableCell('INSUFFICIENT_HISTORY');
        continue;
      }
      const result = vwapOver(index - period + 1, index);
      if (result.reason) {
        cells[priceName] = unavailableCell(result.reason);
        cells[distanceName] = unavailableCell(result.reason);
        continue;
      }
      const vwap = fixedFromScaledAtoms(result.atoms, internalScale);
      cells[priceName] = availableFixedCell(vwap, priceScale);
      cells[distanceName] = availableFixedCell(
        ratioChangeFixed(bar.close, vwap, internalScale), ratioScale,
      );
    }

    for (const [anchorKey, priceName, distanceName] of [
      ['lastSwingLow', 'anchoredEodVwapFromLastConfirmedSwingLow', 'distanceToAnchoredEodVwapFromSwingLow'],
      ['lastSwingHigh', 'anchoredEodVwapFromLastConfirmedSwingHigh', 'distanceToAnchoredEodVwapFromSwingHigh'],
    ]) {
      const anchor = streamStates[index][anchorKey];
      if (anchor === null) {
        cells[priceName] = unavailableCell('NO_CONFIRMED_PIVOT');
        cells[distanceName] = unavailableCell('NO_CONFIRMED_PIVOT');
        continue;
      }
      const result = vwapOver(anchor.pivotIndex, index);
      if (result.reason) {
        cells[priceName] = unavailableCell(result.reason);
        cells[distanceName] = unavailableCell(result.reason);
        continue;
      }
      const vwap = fixedFromScaledAtoms(result.atoms, internalScale);
      cells[priceName] = availableFixedCell(vwap, priceScale);
      cells[distanceName] = availableFixedCell(
        ratioChangeFixed(bar.close, vwap, internalScale), ratioScale,
      );
    }
    return cells;
  });
}
