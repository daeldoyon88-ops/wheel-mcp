/**
 * Fenêtres saisonnières distinctes — déduplication par chevauchement calendaire.
 * Pur : aucun appel réseau. Réutilise les champs enrichis (startDay, endDay, score).
 */

import { weekOfMonthToDay } from './seasonalityWindowDisplay.js';

const CALENDAR_DAYS     = 366;
const DEFAULT_MAX_DISTINCT       = 4;
const DEFAULT_OVERLAP_THRESHOLD  = 0.60;
const DEFAULT_CENTER_PROXIMITY_DAYS = 21;

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function _dayOfYear(month, day) {
  const m = Math.min(12, Math.max(1, Number(month) || 1));
  const d = Math.min(31, Math.max(1, Number(day) || 1));
  let doy = d;
  for (let i = 1; i < m; i++) doy += DAYS_IN_MONTH[i];
  return doy;
}

function _resolveWindowDays(window) {
  if (window.startDay != null && window.endDay != null) {
    return {
      startMonth: window.startMonth,
      startDay:   window.startDay,
      endMonth:   window.endMonth,
      endDay:     window.endDay,
    };
  }

  const refYear = new Date().getUTCFullYear();
  return {
    startMonth: window.startMonth,
    startDay:   weekOfMonthToDay(window.startMonth, window.startWeekOfMonth ?? 1, refYear),
    endMonth:   window.endMonth,
    endDay:     weekOfMonthToDay(window.endMonth, window.endWeekOfMonth ?? 1, refYear),
  };
}

/**
 * Masque booléen 1..366 pour une fenêtre (gère déc. → mars).
 */
export function buildCalendarCoverageMask(window) {
  const { startMonth, startDay, endMonth, endDay } = _resolveWindowDays(window);
  const startDOY = _dayOfYear(startMonth, startDay);
  const endDOY   = _dayOfYear(endMonth, endDay);
  const mask     = new Uint8Array(CALENDAR_DAYS + 1);

  if (startDOY <= endDOY) {
    for (let d = startDOY; d <= endDOY; d++) mask[d] = 1;
  } else {
    for (let d = startDOY; d <= CALENDAR_DAYS; d++) mask[d] = 1;
    for (let d = 1; d <= endDOY; d++) mask[d] = 1;
  }

  return { mask, startDOY, endDOY };
}

function _maskDayCount(mask) {
  let n = 0;
  for (let d = 1; d <= CALENDAR_DAYS; d++) if (mask[d]) n++;
  return n;
}

function _maskOverlapDays(maskA, maskB) {
  let n = 0;
  for (let d = 1; d <= CALENDAR_DAYS; d++) if (maskA[d] && maskB[d]) n++;
  return n;
}

function _windowCenterDOY(mask) {
  let sinSum = 0;
  let cosSum = 0;
  let n      = 0;
  for (let d = 1; d <= CALENDAR_DAYS; d++) {
    if (!mask[d]) continue;
    const angle = (2 * Math.PI * (d - 1)) / CALENDAR_DAYS;
    sinSum += Math.sin(angle);
    cosSum += Math.cos(angle);
    n++;
  }
  if (n === 0) return 0;
  const angle = Math.atan2(sinSum / n, cosSum / n);
  let doy = Math.round((angle / (2 * Math.PI)) * CALENDAR_DAYS) + 1;
  if (doy < 1) doy += CALENDAR_DAYS;
  if (doy > CALENDAR_DAYS) doy -= CALENDAR_DAYS;
  return doy;
}

function _circularDayDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, CALENDAR_DAYS - d);
}

function _monthDistanceCircular(m1, m2) {
  const a = Math.min(12, Math.max(1, Number(m1) || 1));
  const b = Math.min(12, Math.max(1, Number(m2) || 1));
  const d = Math.abs(a - b);
  return Math.min(d, 12 - d);
}

/**
 * Ratio de chevauchement : overlapDays / min(durationA, durationB).
 */
export function computeCalendarOverlapRatio(windowA, windowB) {
  const covA = buildCalendarCoverageMask(windowA);
  const covB = buildCalendarCoverageMask(windowB);
  const lenA = _maskDayCount(covA.mask);
  const lenB = _maskDayCount(covB.mask);
  if (lenA === 0 || lenB === 0) return 0;

  const overlap = _maskOverlapDays(covA.mask, covB.mask);
  return overlap / Math.min(lenA, lenB);
}

function _monthsSimilar(windowA, windowB) {
  if (computeCalendarOverlapRatio(windowA, windowB) <= 0) return false;
  const a = _resolveWindowDays(windowA);
  const b = _resolveWindowDays(windowB);
  return (
    _monthDistanceCircular(a.startMonth, b.startMonth) <= 1 &&
    _monthDistanceCircular(a.endMonth, b.endMonth) <= 1
  );
}

function _centersClose(windowA, windowB, maxDays) {
  if (computeCalendarOverlapRatio(windowA, windowB) <= 0) return false;
  const covA = buildCalendarCoverageMask(windowA);
  const covB = buildCalendarCoverageMask(windowB);
  const cA   = _windowCenterDOY(covA.mask);
  const cB   = _windowCenterDOY(covB.mask);
  return _circularDayDistance(cA, cB) <= maxDays;
}

/**
 * Deux fenêtres représentent la même zone saisonnière.
 */
export function areSeasonalityWindowsOverlapping(windowA, windowB, options = {}) {
  const threshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
  const centerDays = options.centerProximityDays ?? DEFAULT_CENTER_PROXIMITY_DAYS;

  if (computeCalendarOverlapRatio(windowA, windowB) >= threshold) return true;
  if (_centersClose(windowA, windowB, centerDays)) return true;
  if (_monthsSimilar(windowA, windowB)) return true;
  return false;
}

/**
 * Aplatit horizons → liste de fenêtres avec `days` (durée trading).
 */
export function flattenSeasonalityWindows(windowsData, direction = 'bullish') {
  if (!windowsData?.horizons?.length) return [];

  const key = direction === 'bearish' ? 'worstBearish' : 'bestBullish';
  const out = [];

  for (const h of windowsData.horizons) {
    for (const wBlock of h.windows ?? []) {
      for (const w of wBlock[key] ?? []) {
        out.push({
          ...w,
          days: w.days ?? wBlock.windowDays ?? w.windowDays ?? null,
          horizonYears: w.horizonYears ?? h.horizonYears ?? null,
        });
      }
    }
  }

  return out;
}

/**
 * Sélection gloutonne : meilleur score d'abord, exclut les zones qui chevauchent.
 */
export function selectDistinctSeasonalityWindows(windows, options = {}) {
  const maxDistinct = options.maxDistinct ?? DEFAULT_MAX_DISTINCT;
  const overlapThreshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
  const centerProximityDays = options.centerProximityDays ?? DEFAULT_CENTER_PROXIMITY_DAYS;

  const sorted = [...(windows ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const selected = [];
  const overlapOpts = { overlapThreshold, centerProximityDays };

  for (const candidate of sorted) {
    if (selected.length >= maxDistinct) break;
    const conflicts = selected.some((picked) =>
      areSeasonalityWindowsOverlapping(candidate, picked, overlapOpts),
    );
    if (!conflicts) selected.push(candidate);
  }

  return selected;
}

const DISTINCT_META = {
  maxDistinct:        DEFAULT_MAX_DISTINCT,
  overlapThreshold:   DEFAULT_OVERLAP_THRESHOLD,
  algorithm:          'greedy-by-score',
};

/**
 * Ajoute `distinct.bullish` / `distinct.bearish` sans retirer horizons ni summary.
 */
export function attachDistinctSeasonalityWindows(result, options = {}) {
  if (!result?.horizons) return result;

  const bullishFlat = flattenSeasonalityWindows(result, 'bullish');
  const bearishFlat = flattenSeasonalityWindows(result, 'bearish');

  const selectOpts = {
    maxDistinct:        options.maxDistinct ?? DEFAULT_MAX_DISTINCT,
    overlapThreshold:   options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD,
    centerProximityDays: options.centerProximityDays ?? DEFAULT_CENTER_PROXIMITY_DAYS,
  };

  return {
    ...result,
    distinct: {
      bullish: selectDistinctSeasonalityWindows(bullishFlat, selectOpts),
      bearish: selectDistinctSeasonalityWindows(bearishFlat, selectOpts),
      meta: {
        ...DISTINCT_META,
        ...selectOpts,
        algorithm: DISTINCT_META.algorithm,
      },
    },
  };
}
