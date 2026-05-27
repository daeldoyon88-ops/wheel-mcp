/**
 * Clusters saisonniers longs — regroupe les sous-fenêtres proches (overlap / gap ≤ 21j).
 * Garde-fous : durée max 180j, max 6 mois (bullish), gap linéaire sauf traversee d'année.
 */

import { buildSeasonalWindowDisplayFields } from './seasonalityWindowDisplay.js';
import {
  buildCalendarCoverageMask,
  flattenSeasonalityWindows,
} from './seasonalityWindowDistinct.js';

const CALENDAR_DAYS = 366;
const DEFAULT_GAP_TOLERANCE_DAYS = 21;
const DEFAULT_MAX_CLUSTERS = 8;
const DEFAULT_MAX_CLUSTER_DURATION_DAYS = 180;
const DEFAULT_MAX_BULLISH_MONTHS_COVERED = 6;

const MONTH_DISPLAY_FR = [
  'jan.', 'fév.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sep.', 'oct.', 'nov.', 'déc.',
];

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function _r4(n) {
  return Math.round(n * 10_000) / 10_000;
}

function _r3(n) {
  return Math.round(n * 1_000) / 1_000;
}

function _maskOverlapDays(maskA, maskB) {
  let n = 0;
  for (let d = 1; d <= CALENDAR_DAYS; d++) if (maskA[d] && maskB[d]) n++;
  return n;
}

function _firstCoveredDay(mask) {
  for (let d = 1; d <= CALENDAR_DAYS; d++) if (mask[d]) return d;
  return 0;
}

function _lastCoveredDay(mask) {
  for (let d = CALENDAR_DAYS; d >= 1; d--) if (mask[d]) return d;
  return 0;
}

function _unionMasks(masks) {
  const out = new Uint8Array(CALENDAR_DAYS + 1);
  for (const mask of masks) {
    for (let d = 1; d <= CALENDAR_DAYS; d++) if (mask[d]) out[d] = 1;
  }
  return out;
}

function _maskDayCount(mask) {
  let n = 0;
  for (let d = 1; d <= CALENDAR_DAYS; d++) if (mask[d]) n++;
  return n;
}

function _windowWrapsYear(window) {
  const cov = buildCalendarCoverageMask(window);
  return cov.startDOY > cov.endDOY;
}

function _isYearBoundaryZone(window) {
  const sm = window.startMonth ?? 0;
  const em = window.endMonth ?? 0;
  const startsLateYear = sm >= 10;
  const endsEarlyYear  = em <= 3;
  return startsLateYear || endsEarlyYear || _windowWrapsYear(window);
}

function _allowCircularGap(windowA, windowB, covA, covB) {
  if (_windowWrapsYear(windowA) || _windowWrapsYear(windowB)) return true;
  if (covA.startDOY > covA.endDOY || covB.startDOY > covB.endDOY) return true;
  return _isYearBoundaryZone(windowA) && _isYearBoundaryZone(windowB);
}

/**
 * Écart linéaire (même année civile) — ne court-circuite pas via décembre.
 */
function _linearGapBetweenMasks(maskA, maskB) {
  const lastA  = _lastCoveredDay(maskA);
  const firstA = _firstCoveredDay(maskA);
  const lastB  = _lastCoveredDay(maskB);
  const firstB = _firstCoveredDay(maskB);
  if (!lastA || !firstA || !lastB || !firstB) return CALENDAR_DAYS;

  let gap = CALENDAR_DAYS;

  if (lastA < firstB) {
    gap = Math.min(gap, firstB - lastA - 1);
  }
  if (lastB < firstA) {
    gap = Math.min(gap, firstA - lastB - 1);
  }

  return gap;
}

function _forwardGapBetweenMasks(maskFrom, maskTo) {
  const lastFrom = _lastCoveredDay(maskFrom);
  const firstTo  = _firstCoveredDay(maskTo);
  if (!lastFrom || !firstTo) return CALENDAR_DAYS;

  let gap = 0;
  let d   = lastFrom;
  for (let steps = 0; steps < CALENDAR_DAYS; steps++) {
    d = d >= CALENDAR_DAYS ? 1 : d + 1;
    if (maskTo[d]) return gap;
    gap++;
  }
  return CALENDAR_DAYS;
}

/**
 * Écart calendaire entre deux fenêtres (0 si chevauchement).
 */
export function computeCalendarGapDays(windowA, windowB) {
  const covA = buildCalendarCoverageMask(windowA);
  const covB = buildCalendarCoverageMask(windowB);
  if (_maskOverlapDays(covA.mask, covB.mask) > 0) return 0;

  if (_allowCircularGap(windowA, windowB, covA, covB)) {
    const gapAB = _forwardGapBetweenMasks(covA.mask, covB.mask);
    const gapBA = _forwardGapBetweenMasks(covB.mask, covA.mask);
    return Math.min(gapAB, gapBA);
  }

  return _linearGapBetweenMasks(covA.mask, covB.mask);
}

function _monthsCoveredFromMask(mask) {
  const months = new Set();
  let doy = 0;
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
      doy++;
      if (doy <= CALENDAR_DAYS && mask[doy]) months.add(m);
    }
  }
  const sorted = [...months].sort((a, b) => a - b);
  return {
    monthsCovered:       sorted.length,
    coveredMonthLabels:  sorted.map((m) => MONTH_DISPLAY_FR[m - 1]),
  };
}

function _maskSpansYearBoundary(mask) {
  const first = _firstCoveredDay(mask);
  const last  = _lastCoveredDay(mask);
  if (first > last) return true;
  let hasQ1 = false;
  let hasQ4 = false;
  for (let d = 1; d <= CALENDAR_DAYS; d++) {
    if (!mask[d]) continue;
    if (d <= 90)  hasQ1 = true;
    if (d >= 275) hasQ4 = true;
  }
  return hasQ1 && hasQ4;
}

function _mergeWouldExceedLimits(currentWindows, nextWindow, options) {
  const masks = [
    ...currentWindows.map((w) => buildCalendarCoverageMask(w).mask),
    buildCalendarCoverageMask(nextWindow).mask,
  ];
  const union     = _unionMasks(masks);
  const duration  = _maskDayCount(union);
  const { monthsCovered } = _monthsCoveredFromMask(union);

  if (duration > (options.maxClusterDurationDays ?? DEFAULT_MAX_CLUSTER_DURATION_DAYS)) {
    return true;
  }

  const maxMonths = options.direction === 'bearish'
    ? (options.maxBearishMonthsCovered ?? 8)
    : (options.maxBullishMonthsCovered ?? DEFAULT_MAX_BULLISH_MONTHS_COVERED);

  if (monthsCovered > maxMonths) return true;

  return false;
}

function _gapClusterToWindow(clusterMask, window, currentWindows) {
  const cov = buildCalendarCoverageMask(window);
  if (_maskOverlapDays(clusterMask, cov.mask) > 0) return 0;

  const useCircular = currentWindows.some((w) => _allowCircularGap(
    w,
    window,
    buildCalendarCoverageMask(w),
    cov,
  ));

  if (useCircular) {
    return Math.min(
      _forwardGapBetweenMasks(clusterMask, cov.mask),
      _forwardGapBetweenMasks(cov.mask, clusterMask),
    );
  }
  return _linearGapBetweenMasks(clusterMask, cov.mask);
}

function _canMergeWithClusterFixed(currentWindows, window, options) {
  const gapTolerance = options.gapToleranceDays ?? DEFAULT_GAP_TOLERANCE_DAYS;
  const clusterMask  = _unionMasks(
    currentWindows.map((w) => buildCalendarCoverageMask(w).mask),
  );
  const cov = buildCalendarCoverageMask(window);

  if (_maskOverlapDays(clusterMask, cov.mask) > 0) {
    return !_mergeWouldExceedLimits(currentWindows, window, options);
  }

  const gap = _gapClusterToWindow(clusterMask, window, currentWindows);
  if (gap > gapTolerance) return false;

  return !_mergeWouldExceedLimits(currentWindows, window, options);
}

function _calendarKey(window) {
  const cov = buildCalendarCoverageMask(window);
  return `${cov.startDOY}:${cov.endDOY}`;
}

function _dedupeCalendarWindows(windows) {
  const map = new Map();
  for (const w of windows ?? []) {
    const key = _calendarKey(w);
    const prev = map.get(key);
    if (!prev || (w.score ?? 0) > (prev.score ?? 0)) map.set(key, w);
  }
  return [...map.values()];
}

function _sortByStartDOY(windows) {
  return [...windows].sort((a, b) => {
    const sa = buildCalendarCoverageMask(a).startDOY;
    const sb = buildCalendarCoverageMask(b).startDOY;
    return sa - sb;
  });
}

function _weightedMean(values, weights) {
  let sum = 0;
  let wSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const w = weights[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const weight = typeof w === 'number' && w > 0 ? w : 1;
    sum += v * weight;
    wSum += weight;
  }
  return wSum > 0 ? sum / wSum : null;
}

function _median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _clusterConfidence(subWindows) {
  const totalSamples = subWindows.reduce((s, w) => s + (w.sampleSize ?? 0), 0);
  const count        = subWindows.length;
  const allRobuste   = subWindows.every((w) => w.status === 'robuste');
  if (count >= 2 && totalSamples >= 10 && allRobuste) return 'Robuste';
  if (totalSamples >= 5 || (count >= 2 && totalSamples >= 3)) return 'Mesurable';
  return 'Préliminaire';
}

function _clusterVerdict(direction, avgReturn, winRate, worstReturn) {
  if (direction === 'bullish') {
    if (avgReturn != null && avgReturn >= 0.10 && winRate != null && winRate >= 0.85) return 'Très favorable';
    if (avgReturn != null && avgReturn > 0.02 && winRate != null && winRate >= 0.6) return 'Favorable';
    if (avgReturn != null && avgReturn > 0) return 'Modéré';
    return 'Faible';
  }
  if (avgReturn != null && avgReturn <= -0.10 && winRate != null && winRate <= 0.35) return 'Danger élevé';
  if (avgReturn != null && avgReturn < 0 && winRate != null && winRate < 0.5) return 'Défavorable';
  if (worstReturn != null && worstReturn <= -0.10) return 'Risque';
  return 'Neutre';
}

function _formatDayMonth(day, month) {
  const label = MONTH_DISPLAY_FR[month - 1] ?? `m${month}`;
  return `${day} ${label}`;
}

function seasonalPrimaryStart(w) {
  const parts = String(w.displayLabel ?? '').split('→');
  return parts[0]?.trim() ?? w.displayLabel;
}

function seasonalPrimaryEnd(w) {
  const parts = String(w.displayLabel ?? '').split('→');
  return parts[1]?.trim() ?? w.displayLabel;
}

function _labelFromWindowStart(w) {
  if (w.displayLabel) return seasonalPrimaryStart(w);
  const d = buildSeasonalWindowDisplayFields({
    startMonth: w.startMonth,
    startWeekOfMonth: w.startWeekOfMonth,
    endMonth: w.endMonth,
    endWeekOfMonth: w.endWeekOfMonth,
    windowDays: w.windowDays,
  });
  return _formatDayMonth(w.startDay ?? d.startDay, w.startMonth);
}

function _labelFromWindowEnd(w) {
  if (w.displayLabel) return seasonalPrimaryEnd(w);
  const d = buildSeasonalWindowDisplayFields({
    startMonth: w.startMonth,
    startWeekOfMonth: w.startWeekOfMonth,
    endMonth: w.endMonth,
    endWeekOfMonth: w.endWeekOfMonth,
    windowDays: w.windowDays,
  });
  return _formatDayMonth(w.endDay ?? d.endDay, w.endMonth);
}

/**
 * Enveloppe affichable : linéaire (mars→août) ou traversee d'année (oct→jan).
 */
function _envelopeBounds(subWindows) {
  const unionMask = _unionMasks(
    subWindows.map((w) => buildCalendarCoverageMask(w).mask),
  );
  const wraps = _maskSpansYearBoundary(unionMask) || subWindows.some((w) => _windowWrapsYear(w));

  if (!wraps) {
    let startW = subWindows[0];
    let endW   = subWindows[0];
    let minStart = Infinity;
    let maxEnd   = 0;

    for (const w of subWindows) {
      const cov  = buildCalendarCoverageMask(w);
      const last = _lastCoveredDay(cov.mask);
      if (cov.startDOY < minStart) {
        minStart = cov.startDOY;
        startW   = w;
      }
      if (last > maxEnd) {
        maxEnd = last;
        endW   = w;
      }
    }

    return {
      startLabel: _labelFromWindowStart(startW),
      endLabel:   _labelFromWindowEnd(endW),
      minStart,
      maxEnd,
      wrapsYear: false,
    };
  }

  let startW = subWindows[0];
  let endW   = subWindows[0];
  let bestStartDOY = Infinity;
  let bestEndDOY   = -1;

  for (const w of subWindows) {
    const sm  = w.startMonth ?? 0;
    const em  = w.endMonth ?? 0;
    const cov = buildCalendarCoverageMask(w);
    const last = _lastCoveredDay(cov.mask);

    if (sm >= 10 && cov.startDOY < bestStartDOY) {
      bestStartDOY = cov.startDOY;
      startW       = w;
    }
    if (em <= 3 && last > bestEndDOY) {
      bestEndDOY = last;
      endW       = w;
    }
  }

  if (bestStartDOY === Infinity) {
    startW = subWindows.reduce((a, b) =>
      (buildCalendarCoverageMask(a).startDOY > buildCalendarCoverageMask(b).startDOY ? a : b),
    );
  }
  if (bestEndDOY < 0) {
    endW = subWindows.reduce((a, b) => {
      const la = _lastCoveredDay(buildCalendarCoverageMask(a).mask);
      const lb = _lastCoveredDay(buildCalendarCoverageMask(b).mask);
      return la > lb ? a : b;
    });
  }

  const minStart = buildCalendarCoverageMask(startW).startDOY;
  const maxEnd   = _lastCoveredDay(buildCalendarCoverageMask(endW).mask);

  return {
    startLabel: _labelFromWindowStart(startW),
    endLabel:   _labelFromWindowEnd(endW),
    minStart,
    maxEnd,
    wrapsYear: true,
  };
}

function _clusterPassesLimits(cluster, options) {
  const direction = cluster.direction ?? 'bullish';
  const maxDur    = options.maxClusterDurationDays ?? DEFAULT_MAX_CLUSTER_DURATION_DAYS;
  if ((cluster.durationDays ?? 0) > maxDur) return false;

  const maxMonths = direction === 'bearish'
    ? (options.maxBearishMonthsCovered ?? 8)
    : (options.maxBullishMonthsCovered ?? DEFAULT_MAX_BULLISH_MONTHS_COVERED);

  if (direction === 'bullish' && (cluster.monthsCovered ?? 0) > maxMonths) {
    return false;
  }

  return true;
}

/**
 * Fusionne des sous-fenêtres en un objet cluster.
 */
export function mergeSeasonalityClusterWindows(clusterWindows, options = {}) {
  const direction = options.direction === 'bearish' ? 'bearish' : 'bullish';
  const subWindows = [...(clusterWindows ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (!subWindows.length) return null;

  const masks     = subWindows.map((w) => buildCalendarCoverageMask(w).mask);
  const unionMask = _unionMasks(masks);
  const monthInfo = _monthsCoveredFromMask(unionMask);
  const {
    startLabel, endLabel, minStart, maxEnd, wrapsYear,
  } = _envelopeBounds(subWindows);

  const weights = subWindows.map((w) => w.sampleSize ?? 1);
  const avgReturn    = _weightedMean(subWindows.map((w) => w.avgReturn), weights);
  const winRate      = _weightedMean(subWindows.map((w) => w.winRate), weights);
  const medianReturn = _median(subWindows.map((w) => w.medianReturn ?? w.avgReturn));

  const worstReturn = subWindows.reduce((min, w) => {
    if (typeof w.worstReturn !== 'number') return min;
    return min == null ? w.worstReturn : Math.min(min, w.worstReturn);
  }, null);

  const bestReturn = subWindows.reduce((max, w) => {
    if (typeof w.bestReturn !== 'number') return max;
    return max == null ? w.bestReturn : Math.max(max, w.bestReturn);
  }, null);

  const bestWindow = subWindows.reduce((best, w) =>
    (!best || (w.score ?? 0) > (best.score ?? 0) ? w : best),
  null);

  const confidence = _clusterConfidence(subWindows);
  const verdict    = _clusterVerdict(direction, avgReturn, winRate, worstReturn);

  const reasons = [];
  if (subWindows.length > 1) reasons.push(`${subWindows.length} sous-fenêtres fusionnées`);
  if (wrapsYear) reasons.push('traversee-annee');
  else reasons.push('zone-lineaire');

  return {
    direction,
    startLabel,
    endLabel,
    displayLabel: `${startLabel} → ${endLabel}`,
    startDayOfYear: minStart,
    endDayOfYear:   maxEnd,
    wrapsYear,
    durationDays:   _maskDayCount(unionMask),
    monthsCovered:  monthInfo.monthsCovered,
    coveredMonthLabels: monthInfo.coveredMonthLabels,
    windowsCount:   subWindows.length,
    subWindows:     subWindows.map((w) => ({
      ...w,
      subLabel: w.displayLabel || w.label,
    })),
    bestWindow,
    avgReturn:    avgReturn != null ? _r4(avgReturn) : null,
    medianReturn: medianReturn != null ? _r4(medianReturn) : null,
    worstReturn:  worstReturn != null ? _r4(worstReturn) : null,
    bestReturn:   bestReturn != null ? _r4(bestReturn) : null,
    winRate:      winRate != null ? _r3(winRate) : null,
    confidence,
    verdict,
    clusterReason: reasons.join(' · ') || 'single-window',
    clusterScore:  bestWindow?.score ?? 0,
  };
}

/**
 * Crée des clusters à partir d'une liste de fenêtres (déjà filtrées par direction).
 */
export function createSeasonalityClusters(windows, options = {}) {
  const gapTolerance = options.gapToleranceDays ?? DEFAULT_GAP_TOLERANCE_DAYS;
  const direction    = options.direction === 'bearish' ? 'bearish' : 'bullish';
  const maxClusters  = options.maxClusters ?? DEFAULT_MAX_CLUSTERS;
  const mergeOpts    = { ...options, direction, gapToleranceDays: gapTolerance };

  const deduped = _sortByStartDOY(_dedupeCalendarWindows(windows));
  if (!deduped.length) return [];

  const groups = [];
  let current = [deduped[0]];

  for (let i = 1; i < deduped.length; i++) {
    const w = deduped[i];
    if (_canMergeWithClusterFixed(current, w, mergeOpts)) {
      current.push(w);
    } else {
      const merged = mergeSeasonalityClusterWindows(current, { direction });
      if (merged && _clusterPassesLimits(merged, mergeOpts)) groups.push(merged);
      current = [w];
    }
  }

  const last = mergeSeasonalityClusterWindows(current, { direction });
  if (last && _clusterPassesLimits(last, mergeOpts)) groups.push(last);

  return groups
    .sort((a, b) => (b.clusterScore ?? 0) - (a.clusterScore ?? 0))
    .slice(0, maxClusters);
}

const CLUSTERS_META = {
  gapToleranceDays:           DEFAULT_GAP_TOLERANCE_DAYS,
  maxClusterDurationDays:     DEFAULT_MAX_CLUSTER_DURATION_DAYS,
  maxBullishMonthsCovered:    DEFAULT_MAX_BULLISH_MONTHS_COVERED,
  algorithm:                  'merge-overlap-and-nearby-calendar-windows',
  source:                     'raw-horizon-windows',
};

/**
 * Ajoute clusters.bullish / clusters.bearish sans retirer distinct ni horizons.
 */
export function attachSeasonalityClusters(windowsData, options = {}) {
  if (!windowsData?.horizons) return windowsData;

  const gapToleranceDays = options.gapToleranceDays ?? DEFAULT_GAP_TOLERANCE_DAYS;
  const clusterOpts = {
    gapToleranceDays,
    maxClusters:              options.maxClusters ?? DEFAULT_MAX_CLUSTERS,
    maxClusterDurationDays:   options.maxClusterDurationDays ?? DEFAULT_MAX_CLUSTER_DURATION_DAYS,
    maxBullishMonthsCovered:  options.maxBullishMonthsCovered ?? DEFAULT_MAX_BULLISH_MONTHS_COVERED,
  };

  const bullishRaw = flattenSeasonalityWindows(windowsData, 'bullish');
  const bearishRaw = flattenSeasonalityWindows(windowsData, 'bearish');

  return {
    ...windowsData,
    clusters: {
      bullish: createSeasonalityClusters(bullishRaw, { ...clusterOpts, direction: 'bullish' }),
      bearish: createSeasonalityClusters(bearishRaw, { ...clusterOpts, direction: 'bearish' }),
      meta: {
        ...CLUSTERS_META,
        gapToleranceDays,
        maxClusterDurationDays: clusterOpts.maxClusterDurationDays,
      },
    },
  };
}
