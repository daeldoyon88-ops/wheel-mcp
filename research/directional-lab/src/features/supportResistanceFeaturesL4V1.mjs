/**
 * L4A-B2 — nearest confirmed-pivot support and resistance, level tolerance,
 * touch counting and penetration.
 *
 * Closed conventions:
 * - a row only uses pivots confirmed at or before that row, with the pivot
 *   session inside the 252 observed-session structure lookback;
 * - support = highest SWING_LOW pivot price at or below the close,
 *   resistance = lowest SWING_HIGH pivot price at or above the close; exact
 *   price ties keep the most recently confirmed pivot;
 * - tolerance = max(level × 0.005, atr14 × 0.25); when ATR14 is unavailable
 *   the price-percentage term alone applies;
 * - touches are counted over the last 120 observed sessions including the
 *   current one, bounded by the snapshot start; a session touches the level
 *   when its range intersects [level - tolerance, level + tolerance];
 * - penetration is exactly zero when the session did not pierce the level —
 *   a real value, not missing data.
 */

import {
  availableFixedCell,
  multiplyByRatio,
  ratioChangeFixed,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';
import { assertMarketVolumeStructureRuntimeSectionV1 } from './marketVolumeStructureRuntimePolicyL4V1.mjs';

/** @param {any} level @param {{value: any, availability: string}} atrCell */
function toleranceAtomsFor(level, atrCell, config) {
  const priceTolerance = multiplyByRatio(
    level, config.priceTolerance.numerator, config.priceTolerance.denominator,
  );
  if (atrCell.availability !== 'AVAILABLE') return priceTolerance.atoms;
  const atrTolerance = multiplyByRatio(
    atrCell.value, config.atrTolerance.numerator, config.atrTolerance.denominator,
  );
  return atrTolerance.atoms > priceTolerance.atoms ? atrTolerance.atoms : priceTolerance.atoms;
}

/** @param {Array<any>} bars @param {number} index @param {any} level @param {bigint} tolerance */
function touchStatistics(bars, index, level, tolerance, touchLookback) {
  const lowerBound = level.atoms - tolerance;
  const upperBound = level.atoms + tolerance;
  let touchCount = 0;
  let lastTouchIndex = null;
  for (let cursor = Math.max(0, index - touchLookback + 1); cursor <= index; cursor += 1) {
    if (bars[cursor].low.atoms <= upperBound && bars[cursor].high.atoms >= lowerBound) {
      touchCount += 1;
      lastTouchIndex = cursor;
    }
  }
  return { touchCount, lastTouchIndex };
}

/** Emit the seven descriptive cells for one selected level side. */
function levelCells(prefix, bars, index, selected, atrCell, missingReason, config) {
  const touchCountName = `${prefix}TouchCount${config.touchLookback}`;
  if (selected === null) {
    const reason = unavailableCell(missingReason);
    return {
      [`${prefix}Price`]: reason,
      [`distanceTo${prefix[0].toUpperCase()}${prefix.slice(1)}`]: reason,
      [`${prefix}PivotSessionDate`]: reason,
      [`${prefix}ConfirmedAtSessionDate`]: reason,
      [`${prefix}AgeSessions`]: reason,
      [touchCountName]: reason,
      [`${prefix}LastTouchSessionsAgo`]: reason,
    };
  }
  const level = selected.pivotPrice;
  const tolerance = toleranceAtomsFor(level, atrCell, config);
  const { touchCount, lastTouchIndex } = touchStatistics(
    bars, index, level, tolerance, config.touchLookback,
  );
  const distance = prefix === 'nearestSupport'
    ? ratioChangeFixed(bars[index].close, level, config.scales.internalScale)
    : ratioChangeFixed(level, bars[index].close, config.scales.internalScale);
  return {
    [`${prefix}Price`]: availableFixedCell(level, config.scales.priceScale),
    [`distanceTo${prefix[0].toUpperCase()}${prefix.slice(1)}`]: availableFixedCell(
      distance, config.scales.ratioScale,
    ),
    [`${prefix}PivotSessionDate`]: { value: selected.pivotSessionDate, availability: 'AVAILABLE' },
    [`${prefix}ConfirmedAtSessionDate`]: { value: selected.confirmedAtSessionDate, availability: 'AVAILABLE' },
    [`${prefix}AgeSessions`]: { value: index - selected.pivotIndex, availability: 'AVAILABLE' },
    [touchCountName]: { value: touchCount, availability: 'AVAILABLE' },
    [`${prefix}LastTouchSessionsAgo`]: lastTouchIndex === null
      ? unavailableCell('NO_LEVEL_TOUCH')
      : { value: index - lastTouchIndex, availability: 'AVAILABLE' },
  };
}

/**
 * @param {Array<any>} bars internal volume-structure bars
 * @param {Array<any>} pivots confirmed pivots sorted by confirmation
 * @param {Array<{atr14: {value: any, availability: string}}>} technicalCells
 * @returns {{rows: Array<object>, levels: Array<{support: any, resistance: any}>}}
 */
export function computeSupportResistanceFeatures(bars, pivots, technicalCells, config) {
  assertMarketVolumeStructureRuntimeSectionV1(config, 'supportResistance');
  const rows = [];
  const levels = [];
  const active = [];
  let cursor = 0;
  let head = 0;
  for (let index = 0; index < bars.length; index += 1) {
    while (cursor < pivots.length && pivots[cursor].confirmedIndex <= index) {
      active.push(pivots[cursor]);
      cursor += 1;
    }
    while (head < active.length && active[head].pivotIndex < index - config.structureLookback + 1) {
      head += 1;
    }
    const close = bars[index].close;
    let support = null;
    let resistance = null;
    for (let scan = head; scan < active.length; scan += 1) {
      const pivot = active[scan];
      if (pivot.pivotType === 'SWING_LOW' && pivot.pivotPrice.atoms <= close.atoms) {
        if (support === null
            || pivot.pivotPrice.atoms > support.pivotPrice.atoms
            || (pivot.pivotPrice.atoms === support.pivotPrice.atoms
                && pivot.confirmedIndex > support.confirmedIndex)) {
          support = pivot;
        }
      } else if (pivot.pivotType === 'SWING_HIGH' && pivot.pivotPrice.atoms >= close.atoms) {
        if (resistance === null
            || pivot.pivotPrice.atoms < resistance.pivotPrice.atoms
            || (pivot.pivotPrice.atoms === resistance.pivotPrice.atoms
                && pivot.confirmedIndex > resistance.confirmedIndex)) {
          resistance = pivot;
        }
      }
    }
    const atrCell = technicalCells[index].atr14;

    let supportPenetration;
    if (support === null) supportPenetration = unavailableCell('NO_SUPPORT_LEVEL');
    else if (bars[index].low.atoms < support.pivotPrice.atoms) {
      supportPenetration = availableFixedCell(
        ratioChangeFixed(support.pivotPrice, bars[index].low, config.scales.internalScale),
        config.scales.ratioScale,
      );
    } else {
      supportPenetration = availableFixedCell(
        { atoms: 0n, scale: support.pivotPrice.scale }, config.scales.ratioScale,
      );
    }
    let resistancePenetration;
    if (resistance === null) resistancePenetration = unavailableCell('NO_RESISTANCE_LEVEL');
    else if (bars[index].high.atoms > resistance.pivotPrice.atoms) {
      resistancePenetration = availableFixedCell(
        ratioChangeFixed(bars[index].high, resistance.pivotPrice, config.scales.internalScale),
        config.scales.ratioScale,
      );
    } else {
      resistancePenetration = availableFixedCell(
        { atoms: 0n, scale: resistance.pivotPrice.scale }, config.scales.ratioScale,
      );
    }

    rows.push({
      ...levelCells('nearestSupport', bars, index, support, atrCell, 'NO_SUPPORT_LEVEL', config),
      supportPenetrationPct: supportPenetration,
      ...levelCells('nearestResistance', bars, index, resistance, atrCell, 'NO_RESISTANCE_LEVEL', config),
      resistancePenetrationPct: resistancePenetration,
    });
    levels.push({
      support: support === null ? null : support.pivotPrice,
      resistance: resistance === null ? null : resistance.pivotPrice,
    });
  }
  return { rows, levels };
}
