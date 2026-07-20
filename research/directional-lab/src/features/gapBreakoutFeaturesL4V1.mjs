/**
 * L4A-B2 — structural full gaps, open-gap tracking, causal breakout and
 * breakdown events and after-the-fact failed-event observation.
 *
 * Closed conventions:
 * - breakouts and breakdowns test the PREVIOUS row's nearest levels: a
 *   breakout requires previousClose <= previousResistance and
 *   close(t) > previousResistance (strictly);
 * - volume confirmation compares the internal relativeVolume20 against the
 *   closed 1.5 threshold; an unavailable relative volume leaves the
 *   volume-confirmation cell null while the structural event stays defined;
 * - a failed event is only ever observed today from an event of the five
 *   PREVIOUS sessions whose close has crossed back over the event level —
 *   no future session is ever consulted;
 * - only full gaps exist: low(t) > high(t-1) (FULL_GAP_UP with zone
 *   [high(t-1), low(t)]) or high(t) < low(t-1) (FULL_GAP_DOWN with zone
 *   [high(t), low(t-1)]); a gap-up is filled when a later session's low
 *   reaches its lower boundary, a gap-down when a later session's high
 *   reaches its upper boundary — partial traversals never fill;
 * - open gaps are reported inside the 252 observed-session lookback; gaps
 *   straddling the close belong to neither side; nearest-gap ties keep the
 *   most recent gap session.
 */

import {
  FEATURE_CALCULATION_SCALE,
  availableFixedCell,
  fixedFromScaledAtoms,
  powerOfTen,
  ratioChangeFixed,
  unavailableCell,
} from './fixedPointFeatureMathL4V1.mjs';

const FAILED_EVENT_WINDOW = 5;
const OPEN_GAP_LOOKBACK = 252;

/**
 * @param {Array<any>} bars internal volume-structure bars
 * @param {Array<{support: any, resistance: any}>} levels previous-level source
 * @param {Array<{atoms: bigint|null, availability: string}>} relativeVolume20Internal
 * @returns {{rows: Array<object>, detectedGapCount: number, openGapCount: number}}
 */
export function computeGapBreakoutFeatures(bars, levels, relativeVolume20Internal) {
  const unit = powerOfTen(FEATURE_CALCULATION_SCALE);
  const volumeThresholdAtoms = 15n * unit / 10n;
  const rows = [];
  const events = [];
  const openGaps = [];
  let detectedGapCount = 0;

  for (let index = 0; index < bars.length; index += 1) {
    const close = bars[index].close;

    let breakoutState;
    let breakdownState;
    if (index === 0) {
      breakoutState = { reason: 'INSUFFICIENT_HISTORY' };
      breakdownState = { reason: 'INSUFFICIENT_HISTORY' };
    } else {
      const previousClose = bars[index - 1].close;
      const previousResistance = levels[index - 1].resistance;
      const previousSupport = levels[index - 1].support;
      breakoutState = previousResistance === null
        ? { reason: 'NO_RESISTANCE_LEVEL' }
        : {
          level: previousResistance,
          value: previousClose.atoms <= previousResistance.atoms
            && close.atoms > previousResistance.atoms,
        };
      breakdownState = previousSupport === null
        ? { reason: 'NO_SUPPORT_LEVEL' }
        : {
          level: previousSupport,
          value: previousClose.atoms >= previousSupport.atoms
            && close.atoms < previousSupport.atoms,
        };
    }
    events.push({ breakout: breakoutState, breakdown: breakdownState });

    const eventCell = (state) => (state.reason
      ? unavailableCell(state.reason)
      : { value: state.value, availability: 'AVAILABLE' });
    const levelCell = (state) => (state.reason
      ? unavailableCell(state.reason)
      : availableFixedCell(state.level, 12));
    const volumeCell = (state) => {
      if (state.reason) return unavailableCell(state.reason);
      if (state.value === false) return { value: false, availability: 'AVAILABLE' };
      const relative = relativeVolume20Internal[index];
      if (relative.atoms === null) return unavailableCell(relative.availability);
      return { value: relative.atoms >= volumeThresholdAtoms, availability: 'AVAILABLE' };
    };

    const failedFor = (kind) => {
      const first = Math.max(1, index - FAILED_EVENT_WINDOW);
      if (index === 0 || first > index - 1) return { reason: 'INSUFFICIENT_HISTORY' };
      let failure = null;
      let incomplete = false;
      for (let cursor = first; cursor <= index - 1; cursor += 1) {
        const state = events[cursor][kind];
        if (state.reason) {
          incomplete = true;
          continue;
        }
        if (state.value !== true) continue;
        const crossedBack = kind === 'breakout'
          ? close.atoms < state.level.atoms
          : close.atoms > state.level.atoms;
        if (crossedBack) failure = { eventIndex: cursor, level: state.level };
      }
      if (failure !== null) return { value: true, failure };
      if (incomplete) return { reason: 'MISSING_INPUT' };
      return { value: false };
    };
    const failedBreakout = failedFor('breakout');
    const failedBreakdown = failedFor('breakdown');
    const failedFlagCell = (state) => (state.reason
      ? unavailableCell(state.reason)
      : { value: state.value, availability: 'AVAILABLE' });
    let latestFailure = null;
    for (const state of [failedBreakout, failedBreakdown]) {
      if (state.failure && (latestFailure === null || state.failure.eventIndex > latestFailure.eventIndex)) {
        latestFailure = state.failure;
      }
    }
    let failedAgeCell;
    let failedLevelCell;
    if (latestFailure !== null) {
      failedAgeCell = { value: index - latestFailure.eventIndex, availability: 'AVAILABLE' };
      failedLevelCell = availableFixedCell(latestFailure.level, 12);
    } else {
      const reason = failedBreakout.reason ?? failedBreakdown.reason ?? 'NO_FAILED_EVENT';
      failedAgeCell = unavailableCell(reason);
      failedLevelCell = unavailableCell(reason);
    }

    if (index > 0) {
      for (let cursor = openGaps.length - 1; cursor >= 0; cursor -= 1) {
        const gap = openGaps[cursor];
        const filled = gap.gapType === 'FULL_GAP_UP'
          ? bars[index].low.atoms <= gap.lowerAtoms
          : bars[index].high.atoms >= gap.upperAtoms;
        if (filled || gap.gapIndex < index - OPEN_GAP_LOOKBACK + 1) openGaps.splice(cursor, 1);
      }
      if (bars[index].low.atoms > bars[index - 1].high.atoms) {
        openGaps.push({
          gapIndex: index,
          gapType: 'FULL_GAP_UP',
          gapSessionDate: bars[index].source.sessionDate,
          lowerAtoms: bars[index - 1].high.atoms,
          upperAtoms: bars[index].low.atoms,
        });
        detectedGapCount += 1;
      } else if (bars[index].high.atoms < bars[index - 1].low.atoms) {
        openGaps.push({
          gapIndex: index,
          gapType: 'FULL_GAP_DOWN',
          gapSessionDate: bars[index].source.sessionDate,
          lowerAtoms: bars[index].high.atoms,
          upperAtoms: bars[index - 1].low.atoms,
        });
        detectedGapCount += 1;
      }
    }

    let nearestBelow = null;
    let nearestAbove = null;
    for (const gap of openGaps) {
      if (gap.upperAtoms <= close.atoms) {
        if (nearestBelow === null
            || gap.upperAtoms > nearestBelow.upperAtoms
            || (gap.upperAtoms === nearestBelow.upperAtoms && gap.gapIndex > nearestBelow.gapIndex)) {
          nearestBelow = gap;
        }
      } else if (gap.lowerAtoms >= close.atoms) {
        if (nearestAbove === null
            || gap.lowerAtoms < nearestAbove.lowerAtoms
            || (gap.lowerAtoms === nearestAbove.lowerAtoms && gap.gapIndex > nearestAbove.gapIndex)) {
          nearestAbove = gap;
        }
      }
    }
    const gapCells = {};
    if (nearestBelow === null) {
      for (const name of [
        'nearestOpenGapBelowLower', 'nearestOpenGapBelowUpper',
        'nearestOpenGapBelowAgeSessions', 'distanceToNearestOpenGapBelow',
      ]) gapCells[name] = unavailableCell('NO_OPEN_GAP');
    } else {
      gapCells.nearestOpenGapBelowLower = availableFixedCell(fixedFromScaledAtoms(nearestBelow.lowerAtoms), 12);
      gapCells.nearestOpenGapBelowUpper = availableFixedCell(fixedFromScaledAtoms(nearestBelow.upperAtoms), 12);
      gapCells.nearestOpenGapBelowAgeSessions = { value: index - nearestBelow.gapIndex, availability: 'AVAILABLE' };
      gapCells.distanceToNearestOpenGapBelow = availableFixedCell(
        ratioChangeFixed(close, fixedFromScaledAtoms(nearestBelow.upperAtoms)),
      );
    }
    if (nearestAbove === null) {
      for (const name of [
        'nearestOpenGapAboveLower', 'nearestOpenGapAboveUpper',
        'nearestOpenGapAboveAgeSessions', 'distanceToNearestOpenGapAbove',
      ]) gapCells[name] = unavailableCell('NO_OPEN_GAP');
    } else {
      gapCells.nearestOpenGapAboveLower = availableFixedCell(fixedFromScaledAtoms(nearestAbove.lowerAtoms), 12);
      gapCells.nearestOpenGapAboveUpper = availableFixedCell(fixedFromScaledAtoms(nearestAbove.upperAtoms), 12);
      gapCells.nearestOpenGapAboveAgeSessions = { value: index - nearestAbove.gapIndex, availability: 'AVAILABLE' };
      gapCells.distanceToNearestOpenGapAbove = availableFixedCell(
        ratioChangeFixed(fixedFromScaledAtoms(nearestAbove.lowerAtoms), close),
      );
    }

    rows.push({
      breakoutAboveResistance: eventCell(breakoutState),
      breakdownBelowSupport: eventCell(breakdownState),
      breakoutLevel: levelCell(breakoutState),
      breakdownLevel: levelCell(breakdownState),
      volumeConfirmedBreakout: volumeCell(breakoutState),
      volumeConfirmedBreakdown: volumeCell(breakdownState),
      failedBreakoutAboveResistanceWithin5: failedFlagCell(failedBreakout),
      failedBreakdownBelowSupportWithin5: failedFlagCell(failedBreakdown),
      failedEventAgeSessions: failedAgeCell,
      failedEventLevel: failedLevelCell,
      ...gapCells,
    });
  }
  return { rows, detectedGapCount, openGapCount: openGaps.length };
}
