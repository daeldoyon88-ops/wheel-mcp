/**
 * L4A-B2 — strict causal pivot detection, confirmation and the deterministic
 * alternated pivot stream.
 *
 * Closed conventions:
 * - a swing high at i requires high(i) strictly above every high of the three
 *   previous AND three following sessions (plateaus never produce a pivot);
 * - the pivot is confirmed at session i+3 and is unusable before that row;
 * - pivots are folded into the alternated stream in (confirmation, session,
 *   SWING_LOW-first) order; two consecutive same-type pivots keep the higher
 *   high / lower low, exact price ties keep the most recently confirmed;
 * - the stream is recomputable for every historical prefix and folding a new
 *   pivot never rewrites an earlier row's captured state.
 */

import {
  availableFixedCell,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';
import { assertMarketVolumeStructureRuntimeSectionV1 } from './marketVolumeStructureRuntimePolicyL4V1.mjs';

/**
 * Detect every strict confirmed pivot of the full series. Callers must only
 * use a pivot at rows >= pivot.confirmedIndex.
 * @param {Array<any>} bars
 */
export function detectConfirmedPivots(bars, config) {
  assertMarketVolumeStructureRuntimeSectionV1(config, 'pivots');
  const pivots = [];
  for (let index = config.radius; index + config.radius < bars.length; index += 1) {
    const bar = bars[index];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= config.radius; offset += 1) {
      if (bars[index - offset].high.atoms >= bar.high.atoms
          || bars[index + offset].high.atoms >= bar.high.atoms) isHigh = false;
      if (bars[index - offset].low.atoms <= bar.low.atoms
          || bars[index + offset].low.atoms <= bar.low.atoms) isLow = false;
      if (!isHigh && !isLow) break;
    }
    const confirmedIndex = index + config.confirmationDelay;
    if (confirmedIndex >= bars.length) continue;
    const shared = {
      pivotIndex: index,
      confirmedIndex,
      pivotSessionDate: bar.source.sessionDate,
      confirmedAtSessionDate: bars[confirmedIndex].source.sessionDate,
      pivotBarIdentityId: bar.source.barIdentityId,
      pivotResolvedObservationId: bar.source.resolvedObservationId,
    };
    if (isLow) pivots.push({ pivotType: 'SWING_LOW', pivotPrice: bar.low, ...shared });
    if (isHigh) pivots.push({ pivotType: 'SWING_HIGH', pivotPrice: bar.high, ...shared });
  }
  pivots.sort((left, right) => {
    if (left.confirmedIndex !== right.confirmedIndex) return left.confirmedIndex - right.confirmedIndex;
    if (left.pivotIndex !== right.pivotIndex) return left.pivotIndex - right.pivotIndex;
    return left.pivotType === right.pivotType ? 0 : (left.pivotType === 'SWING_LOW' ? -1 : 1);
  });
  return pivots;
}

/** Fold one confirmed pivot into the alternated stream (mutates the array). */
function foldIntoStream(stream, pivot) {
  if (stream.length === 0) {
    stream.push(pivot);
    return;
  }
  const last = stream[stream.length - 1];
  if (last.pivotType !== pivot.pivotType) {
    stream.push(pivot);
    return;
  }
  if (pivot.pivotType === 'SWING_HIGH') {
    if (pivot.pivotPrice.atoms >= last.pivotPrice.atoms) stream[stream.length - 1] = pivot;
    return;
  }
  if (pivot.pivotPrice.atoms <= last.pivotPrice.atoms) stream[stream.length - 1] = pivot;
}

/**
 * Walk every row and capture, per row, the causal alternated-stream state:
 * last confirmed swing high/low entries and the active opposite-type leg.
 * @param {Array<any>} bars @param {Array<any>} pivots
 */
export function computeAlternatedStreamStates(bars, pivots, config) {
  assertMarketVolumeStructureRuntimeSectionV1(config, 'pivots');
  const stream = [];
  let cursor = 0;
  return bars.map((bar, index) => {
    while (cursor < pivots.length && pivots[cursor].confirmedIndex <= index) {
      foldIntoStream(stream, pivots[cursor]);
      cursor += 1;
    }
    const last = stream.length >= 1 ? stream[stream.length - 1] : null;
    const previous = stream.length >= 2 ? stream[stream.length - 2] : null;
    const lastSwingHigh = last?.pivotType === 'SWING_HIGH'
      ? last
      : (previous?.pivotType === 'SWING_HIGH' ? previous : null);
    const lastSwingLow = last?.pivotType === 'SWING_LOW'
      ? last
      : (previous?.pivotType === 'SWING_LOW' ? previous : null);
    const leg = previous !== null ? { start: previous, end: last } : null;
    return { lastSwingHigh, lastSwingLow, leg };
  });
}

/** @param {any} entry @param {number} index @param {string} prefix */
function pivotCells(entry, index, prefix, priceScale) {
  if (entry === null) {
    return {
      [`${prefix}Price`]: unavailableCell('NO_CONFIRMED_PIVOT'),
      [`${prefix}PivotSessionDate`]: unavailableCell('NO_CONFIRMED_PIVOT'),
      [`${prefix}ConfirmedAtSessionDate`]: unavailableCell('NO_CONFIRMED_PIVOT'),
      [`${prefix}AgeSessions`]: unavailableCell('NO_CONFIRMED_PIVOT'),
    };
  }
  return {
    [`${prefix}Price`]: availableFixedCell(entry.pivotPrice, priceScale),
    [`${prefix}PivotSessionDate`]: { value: entry.pivotSessionDate, availability: 'AVAILABLE' },
    [`${prefix}ConfirmedAtSessionDate`]: { value: entry.confirmedAtSessionDate, availability: 'AVAILABLE' },
    [`${prefix}AgeSessions`]: { value: index - entry.pivotIndex, availability: 'AVAILABLE' },
  };
}

/**
 * Per-row pivot family cells from the alternated stream states.
 * @param {Array<any>} streamStates
 */
export function computePivotFamilyRows(streamStates, config) {
  assertMarketVolumeStructureRuntimeSectionV1(config, 'pivots');
  return streamStates.map((state, index) => ({
    ...pivotCells(state.lastSwingHigh, index, 'lastConfirmedSwingHigh', config.scales.priceScale),
    ...pivotCells(state.lastSwingLow, index, 'lastConfirmedSwingLow', config.scales.priceScale),
  }));
}
