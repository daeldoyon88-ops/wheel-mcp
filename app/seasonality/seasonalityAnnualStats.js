/**
 * Stats annuelles exactes + robustesse glissante pour fenêtres saisonnières.
 * Pur : aucun appel réseau. Optimisé : index prix, cache, glissant sur gagnante seulement.
 */

import {
  weekOfMonthToDay,
  buildSeasonalWindowDisplayFields,
} from './seasonalityWindowDisplay.js';
import { buildCalendarCoverageMask } from './seasonalityWindowDistinct.js';
import { collectOfficialAnnualDisplayWindows } from './seasonalityAnnualDisplayWindows.js';
import {
  computeOccurrence,
  toIsoDate,
} from './seasonalityChart3y.js';

export const ANNUAL_HORIZON_YEARS = [3, 5, 10, 15];
export const ANNUAL_ALGORITHM_VERSION = 'annual-v2';

/** Seuils multi-horizons stricts — annuel réel uniquement (glissant ignoré). */
export const STRICT_HORIZON_THRESHOLDS = [
  { key: '3y', years: 3, forteMin: 3, confirmMin: 2 },
  { key: '5y', years: 5, forteMin: 5, confirmMin: 4 },
  { key: '10y', years: 10, forteMin: 9, confirmMin: 8 },
  { key: '15y', years: 15, forteMin: 12, confirmMin: 10 },
];

export const STRICT_STRENGTH_LABELS = {
  FORTE: 'Forte',
  CONFIRMEE: 'Confirmée',
  FAIBLE: 'Faible',
  NON_CONFIRMEE: 'Non confirmée',
};
const MIN_ANNUAL_OCCURRENCES = 3;
const MIN_CALENDAR_DAYS = 28;
const MAX_CALENDAR_DAYS = 120;
const GLIDING_WINDOW_DAYS_LIST = [20, 40, 60, 90];
const MIN_GLIDING_SAMPLE = 3;
const DEFAULT_MAX_CANDIDATES = 48;
const BEARISH_GRID_STEP = 5;
const BEARISH_MAX_GRID_CANDIDATES = 160;
const BEARISH_MAX_ANNUAL_SCORE = 96;
const BEST_ANNUAL_CACHE_TTL_MS = 4 * 3_600_000;
const BEARISH_ANNUAL_ALGORITHM_VERSION = 'bearish-annual-grid-v2';
const BEARISH_AVG5_POSITIVE_SCORE_PENALTY = 12;

const _r4 = (n) => Math.round(n * 10_000) / 10_000;
const _r3 = (n) => Math.round(n * 1_000) / 1_000;

const BULLISH_GRID_STEP = 5;
const BULLISH_MAX_GRID_CANDIDATES = 160;
const BULLISH_MAX_ANNUAL_SCORE = 96;
const BULLISH_ANNUAL_ALGORITHM_VERSION = 'bullish-annual-grid-v1';

const _bestAnnualCache = new Map();
const _bestBearishAnnualCache = new Map();
const _bestBullishAnnualCache = new Map();
const _maskDayCountCache = new Map();

let _lastPerf = null;

const _perfEnabled = () =>
  String(process.env.SEASONALITY_PERF ?? process.env.DEBUG_SEASONALITY ?? '')
    .toLowerCase() === 'true';

function _logPerf(payload) {
  _lastPerf = payload;
  if (_perfEnabled()) {
    console.log('[SEASONALITY_PERF]', JSON.stringify(payload));
  }
}

export function getLastSeasonalityPerf() {
  return _lastPerf;
}

function _median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _horizonKey(years) {
  return `${years}y`;
}

function _directionalYearsFromStats(stats, direction) {
  if (!stats || stats.yearsCount == null) return 0;
  return direction === 'bearish'
    ? (stats.negativeYears ?? 0)
    : (stats.positiveYears ?? 0);
}

function _scaledMinThreshold(absoluteMin, horizonYears, yearsCount) {
  if (yearsCount >= horizonYears) return absoluteMin;
  return Math.ceil(absoluteMin * yearsCount / horizonYears);
}

function _evaluateStrictHorizon(stats, direction, forteMin, confirmMin, horizonYears) {
  if (!stats || stats.insufficient || stats.yearsCount == null) {
    return {
      sufficient: false,
      directional: 0,
      total: 0,
      meetsForte: false,
      meetsConfirm: false,
      inDirection: false,
      strongOpposite: false,
    };
  }

  const total = stats.yearsCount;
  const directional = _directionalYearsFromStats(stats, direction);
  const opposite = direction === 'bearish'
    ? (stats.positiveYears ?? 0)
    : (stats.negativeYears ?? 0);
  const forteThreshold = _scaledMinThreshold(forteMin, horizonYears, total);
  const confirmThreshold = _scaledMinThreshold(confirmMin, horizonYears, total);

  return {
    sufficient: true,
    directional,
    total,
    meetsForte: directional >= forteThreshold,
    meetsConfirm: directional >= confirmThreshold,
    inDirection: directional > total / 2,
    strongOpposite: opposite >= confirmThreshold,
  };
}

/**
 * Classification stricte multi-horizons (annuel réel).
 * La robustesse glissante ne peut jamais élever la force.
 */
export function getStrictMultiHorizonStrength(window, direction) {
  const dir = direction === 'bearish' ? 'bearish' : 'bullish';
  const annualHorizons = window?.annualHorizons;
  if (!annualHorizons || typeof annualHorizons !== 'object') {
    return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
  }

  const evals = STRICT_HORIZON_THRESHOLDS.map((h) => ({
    key: h.key,
    ..._evaluateStrictHorizon(
      annualHorizons[h.key],
      dir,
      h.forteMin,
      h.confirmMin,
      h.years,
    ),
  }));

  const sufficient = evals.filter((e) => e.sufficient);
  if (sufficient.length === 0) {
    return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
  }

  const eval15 = evals.find((e) => e.key === '15y');
  const eval5 = evals.find((e) => e.key === '5y');
  const inDirectionCount = evals.filter((e) => e.inDirection).length;

  if (eval15?.sufficient) {
    const min15 = _scaledMinThreshold(10, 15, eval15.total);
    if (eval15.directional < min15) {
      return inDirectionCount >= 2
        ? STRICT_STRENGTH_LABELS.FAIBLE
        : STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
    }
  }

  if (eval5?.sufficient) {
    const min5 = _scaledMinThreshold(4, 5, eval5.total);
    if (eval5.directional < min5) {
      return inDirectionCount >= 2
        ? STRICT_STRENGTH_LABELS.FAIBLE
        : STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
    }
  }

  if (evals.some((e) => e.strongOpposite)) {
    return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
  }

  if (inDirectionCount < 2) {
    return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
  }

  let strength;
  const allSufficientMeetForte = STRICT_HORIZON_THRESHOLDS.every((h) => {
    const e = evals.find((x) => x.key === h.key);
    return e?.sufficient && e.meetsForte;
  });
  if (allSufficientMeetForte) {
    strength = STRICT_STRENGTH_LABELS.FORTE;
  } else {
    const allSufficientMeetConfirm = STRICT_HORIZON_THRESHOLDS.every((h) => {
      const e = evals.find((x) => x.key === h.key);
      return e?.sufficient && e.meetsConfirm;
    });
    strength = allSufficientMeetConfirm
      ? STRICT_STRENGTH_LABELS.CONFIRMEE
      : STRICT_STRENGTH_LABELS.FAIBLE;
  }

  if (dir === 'bearish') {
    strength = _applyBearishReturnRequirements(annualHorizons, strength);
  }

  return strength;
}

/** Exigences rendement négatif pour baissier Forte/Confirmée. */
function _applyBearishReturnRequirements(annualHorizons, strength) {
  if (!isStrongOrConfirmedStrength(strength)) return strength;

  const s15 = annualHorizons?.['15y'];
  const s5 = annualHorizons?.['5y'];
  const avg15 = s15?.insufficient ? null : s15?.avgReturnAnnual;
  const med15 = s15?.insufficient ? null : s15?.medianReturnAnnual;
  const avg5 = s5?.insufficient ? null : s5?.avgReturnAnnual;

  if (strength === STRICT_STRENGTH_LABELS.FORTE) {
    if (avg15 == null || avg15 >= 0) return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
    if (med15 != null && med15 >= 0) return STRICT_STRENGTH_LABELS.FAIBLE;
    return strength;
  }

  // Confirmée : avgReturnAnnual 15y < 0 (fallback 5y si 15y indisponible)
  const avgRef = avg15 ?? avg5;
  if (avgRef == null || avgRef >= 0) {
    return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
  }

  return strength;
}

export function isStrongOrConfirmedStrength(strength) {
  return strength === STRICT_STRENGTH_LABELS.FORTE
    || strength === STRICT_STRENGTH_LABELS.CONFIRMEE;
}

function _weekOfMonth(date) {
  const day = date.getUTCDate();
  if (day <= 7) return 1;
  if (day <= 14) return 2;
  if (day <= 21) return 3;
  if (day <= 28) return 4;
  return 5;
}

function _maskDayCount(window) {
  const sig = _windowSignature(window);
  if (sig && _maskDayCountCache.has(sig)) return _maskDayCountCache.get(sig);
  const { mask } = buildCalendarCoverageMask(window);
  let n = 0;
  for (let d = 1; d < mask.length; d++) if (mask[d]) n++;
  if (sig) _maskDayCountCache.set(sig, n);
  return n;
}

function _normalizeWindow(window) {
  if (!window) return null;
  const refYear = new Date().getUTCFullYear();
  const startMonth = window.startMonth;
  const startWeekOfMonth = window.startWeekOfMonth ?? 1;
  const endMonth = window.endMonth;
  const endWeekOfMonth = window.endWeekOfMonth ?? 1;

  if (startMonth == null || endMonth == null) return null;

  const startDay = window.startDay ?? weekOfMonthToDay(startMonth, startWeekOfMonth, refYear);
  const endDay = window.endDay ?? weekOfMonthToDay(endMonth, endWeekOfMonth, refYear);

  return {
    startMonth,
    startWeekOfMonth,
    endMonth,
    endWeekOfMonth,
    startDay,
    endDay,
    windowDays: window.windowDays ?? null,
  };
}

function _windowSignature(window) {
  const w = _normalizeWindow(window);
  if (!w) return null;
  return `${w.startMonth}-W${w.startWeekOfMonth}:${w.endMonth}-W${w.endWeekOfMonth}`;
}

/** Index trié + iso dates pour lookups répétés (une fois par série). */
export function buildPriceRowIndex(priceRows) {
  if (!priceRows?.length) return null;

  const sortedRows = priceRows[0].date <= priceRows[priceRows.length - 1].date
    ? priceRows
    : [...priceRows].sort((a, b) => a.date - b.date);

  const isoDates = sortedRows.map((r) => toIsoDate(r.date));
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const firstYear = sortedRows[0].date.getUTCFullYear();
  const lastYear = sortedRows[sortedRows.length - 1].date.getUTCFullYear();
  const lastCompleteYear = currentYear - 1;

  const filteredByHorizon = {};
  for (const years of ANNUAL_HORIZON_YEARS) {
    const startYear = currentYear - years;
    const cutoff = new Date(Date.UTC(startYear, 0, 1));
    filteredByHorizon[years] = sortedRows.filter(
      (r) => r.date >= cutoff && r.date.getUTCFullYear() < currentYear,
    );
  }

  return {
    sortedRows,
    isoDates,
    now,
    currentYear,
    firstYear,
    lastYear,
    lastCompleteYear,
    lastDateIso: isoDates[isoDates.length - 1],
    rowsCount: sortedRows.length,
    filteredByHorizon,
  };
}

function _bestAnnualCacheKey(ticker, index, candidateCount) {
  return [
    String(ticker ?? '').toUpperCase(),
    index.lastDateIso,
    index.rowsCount,
    candidateCount,
    ANNUAL_ALGORITHM_VERSION,
    MIN_CALENDAR_DAYS,
    MAX_CALENDAR_DAYS,
    DEFAULT_MAX_CANDIDATES,
  ].join('|');
}

function _getBestAnnualCached(key) {
  const e = _bestAnnualCache.get(key);
  if (!e) return undefined;
  if (Date.now() >= e.expiresAt) {
    _bestAnnualCache.delete(key);
    return undefined;
  }
  return e.value;
}

function _setBestAnnualCached(key, value) {
  _bestAnnualCache.set(key, { value, expiresAt: Date.now() + BEST_ANNUAL_CACHE_TTL_MS });
}

function _sliceAnnualStats(allReturns, horizonYears) {
  const slice = allReturns.slice(-horizonYears);
  const yearsCount = slice.length;

  if (yearsCount < MIN_ANNUAL_OCCURRENCES) {
    return {
      yearsCount,
      positiveYears: 0,
      negativeYears: 0,
      winRateAnnual: null,
      bearishRateAnnual: null,
      avgReturnAnnual: null,
      medianReturnAnnual: null,
      annualReturns: slice,
      insufficient: true,
    };
  }

  const positiveYears = slice.filter((a) => a.returnPct > 0).length;
  const negativeYears = slice.filter((a) => a.returnPct < 0).length;
  const returns = slice.map((a) => a.returnPct);
  const avgReturnAnnual = returns.reduce((s, r) => s + r, 0) / yearsCount;

  return {
    yearsCount,
    positiveYears,
    negativeYears,
    winRateAnnual: _r3(positiveYears / yearsCount),
    bearishRateAnnual: _r3(negativeYears / yearsCount),
    avgReturnAnnual: _r4(avgReturnAnnual),
    medianReturnAnnual: _median(returns) != null ? _r4(_median(returns)) : null,
    annualReturns: slice,
    insufficient: false,
  };
}

function _collectAnnualReturnsForWindow(window, index, ctx) {
  const sig = _windowSignature(window);
  if (!sig) return [];

  if (ctx.annualBySig.has(sig)) return ctx.annualBySig.get(sig);

  const norm = _normalizeWindow(window);
  const list = [];

  for (let year = index.firstYear; year <= index.lastCompleteYear; year++) {
    const occKey = `${sig}:${year}`;
    let occ = ctx.occurrenceByKey.get(occKey);
    if (!occ) {
      occ = computeOccurrence(norm, index.sortedRows, year, index.now);
      ctx.occurrenceByKey.set(occKey, occ);
      ctx.annualStatsCalls += 1;
    }
    if (occ.status !== 'complete' || occ.realizedReturn == null) continue;
    list.push({
      year,
      startDate: occ.startDate,
      endDate: occ.endDate,
      startClose: occ.startClose,
      endClose: occ.endClose,
      returnPct: _r4(occ.realizedReturn),
    });
  }

  ctx.annualBySig.set(sig, list);
  return list;
}

/**
 * Occurrences annuelles : close(fin) / close(début) - 1 par année civile.
 */
export function computeAnnualWindowStats(window, priceRows, horizonYears, indexOrCtx = null) {
  const norm = _normalizeWindow(window);
  if (!norm || !priceRows?.length || !Number.isFinite(horizonYears) || horizonYears < 1) {
    return null;
  }

  const index = indexOrCtx?.sortedRows ? indexOrCtx : buildPriceRowIndex(priceRows);
  const ctx = indexOrCtx?.annualBySig
    ? indexOrCtx
    : {
      annualBySig: new Map(),
      occurrenceByKey: new Map(),
      annualStatsCalls: 0,
      glidingStatsCalls: 0,
      index,
    };

  const allReturns = _collectAnnualReturnsForWindow(window, index, ctx);
  return _sliceAnnualStats(allReturns, horizonYears);
}

/**
 * Robustesse glissante — signature calendaire fixe (sous-tests glissants).
 * Accepte index.filteredByHorizon pré-calculé.
 */
export function computeGlidingWindowStats(window, priceRows, horizonYears, windowDays, index = null) {
  const norm = _normalizeWindow(window);
  if (!norm || !priceRows?.length || !windowDays) return null;

  const idx = index ?? buildPriceRowIndex(priceRows);
  const filtered = idx.filteredByHorizon?.[horizonYears]
    ?? _filterRowsByHorizonFallback(idx.sortedRows, horizonYears);

  if (filtered.length < windowDays + 1) return null;

  const key = `${norm.startMonth}-W${norm.startWeekOfMonth}:${norm.endMonth}-W${norm.endWeekOfMonth}:${windowDays}`;
  const returns = [];
  const today = idx.now;
  today.setUTCHours(23, 59, 59, 999);

  for (let i = 0; i < filtered.length - windowDays; i++) {
    const startRow = filtered[i];
    const endRow = filtered[i + windowDays];
    if (!startRow || !endRow || endRow.date > today) continue;

    const startClose = startRow.close;
    const endClose = endRow.close;
    if (!Number.isFinite(startClose) || startClose <= 0) continue;
    if (!Number.isFinite(endClose) || endClose <= 0) continue;

    const startMonth = startRow.date.getUTCMonth() + 1;
    const startWeek = _weekOfMonth(startRow.date);
    const endMonth = endRow.date.getUTCMonth() + 1;
    const endWeek = _weekOfMonth(endRow.date);
    const rowKey = `${startMonth}-W${startWeek}:${endMonth}-W${endWeek}:${windowDays}`;
    if (rowKey !== key) continue;

    returns.push((endClose - startClose) / startClose);
  }

  const n = returns.length;
  if (n < MIN_GLIDING_SAMPLE) return null;

  const positiveCount = returns.filter((r) => r > 0).length;
  const avgReturn = returns.reduce((s, r) => s + r, 0) / n;

  return {
    horizonYears,
    windowDays,
    sampleSize: n,
    winRateGliding: _r3(positiveCount / n),
    avgReturnGliding: _r4(avgReturn),
    medianReturnGliding: _median(returns) != null ? _r4(_median(returns)) : null,
    positiveCount,
    negativeCount: n - positiveCount,
  };
}

function _filterRowsByHorizonFallback(rows, horizonYears) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const startYear = currentYear - horizonYears;
  const cutoff = new Date(Date.UTC(startYear, 0, 1));
  return rows.filter(
    (r) => r.date >= cutoff && r.date.getUTCFullYear() < currentYear,
  );
}

function _buildAnnualHorizonsFromCtx(window, ctx) {
  const allReturns = _collectAnnualReturnsForWindow(window, ctx.index, ctx);
  const annualHorizons = {};
  for (const years of ANNUAL_HORIZON_YEARS) {
    annualHorizons[_horizonKey(years)] = _sliceAnnualStats(allReturns, years);
  }
  return annualHorizons;
}

function _attachAnnualHorizonsToOneWindow(window, ctx, bestAnnualWindow, perf, direction = 'bullish') {
  if (!window) return window;

  const sig = _windowSignature(window);
  const bestSig = bestAnnualWindow?.window ? _windowSignature(bestAnnualWindow.window) : null;

  if (sig && ctx.annualBySig.has(sig)) perf.cacheHits += 1;
  let enriched;
  if (sig && bestSig && sig === bestSig && bestAnnualWindow?.annualHorizons) {
    perf.cacheHits += 1;
    enriched = { ...window, annualHorizons: bestAnnualWindow.annualHorizons };
  } else {
    enriched = { ...window, annualHorizons: _buildAnnualHorizonsFromCtx(window, ctx) };
  }

  const dir = direction === 'bearish' ? 'bearish' : 'bullish';
  return {
    ...enriched,
    strength: getStrictMultiHorizonStrength(enriched, dir),
    strengthDirection: dir,
  };
}

/**
 * Attache annualHorizons (3y/5y/10y/15y) à chaque fenêtre swing haussière/baissière.
 * Réutilise buildPriceRowIndex, cache annualBySig et occurrences.
 */
export function attachAnnualHorizonsToSwingWindows(swingWindows, priceRows, options = {}) {
  if (!swingWindows || !priceRows?.length) return swingWindows;

  const t0 = performance.now();
  const index = options.index ?? buildPriceRowIndex(priceRows);
  if (!index) return swingWindows;

  const ctx = options.ctx ?? {
    index,
    annualBySig: new Map(),
    occurrenceByKey: new Map(),
    annualStatsCalls: 0,
    glidingStatsCalls: 0,
  };

  const perf = { cacheHits: 0 };
  const bestAnnual = options.bestAnnualWindow ?? null;
  const attachList = (list, direction) =>
    (list ?? []).map((w) => _attachAnnualHorizonsToOneWindow(w, ctx, bestAnnual, perf, direction));

  const bullish = attachList(swingWindows.bullish, 'bullish');
  const bearish = attachList(swingWindows.bearish, 'bearish');
  const windowsCount = bullish.length + bearish.length;
  const annualHorizonsSwingMs = Math.round(performance.now() - t0);

  if (_perfEnabled()) {
    _logPerf({
      annualHorizonsSwingMs,
      windowsCount,
      cacheHit: perf.cacheHits > 0,
      annualBySigSize: ctx.annualBySig.size,
      annualStatsCalls: ctx.annualStatsCalls,
    });
  }

  return {
    ...swingWindows,
    bullish,
    bearish,
  };
}

function _buildGlidingHorizons(window, index, windowDays, ctx) {
  const glidingRobustness = {};
  const days = windowDays ?? GLIDING_WINDOW_DAYS_LIST[1];

  for (const years of ANNUAL_HORIZON_YEARS) {
    ctx.glidingStatsCalls += 1;
    const stats = computeGlidingWindowStats(
      window,
      index.sortedRows,
      years,
      days,
      index,
    );
    if (stats) glidingRobustness[_horizonKey(years)] = stats;
  }
  return glidingRobustness;
}

/** Score candidat — annual uniquement (pas de glissant ici). */
function _scoreAnnualCandidateFast(window, ctx) {
  const annualHorizons = _buildAnnualHorizonsFromCtx(window, ctx);

  const s5 = annualHorizons['5y'];
  const s10 = annualHorizons['10y'];
  const s15 = annualHorizons['15y'];

  if (!s5 || s5.insufficient || s5.winRateAnnual == null) {
    return { score: -Infinity, annualHorizons };
  }

  let score = 0;
  score += (s5.winRateAnnual ?? 0) * 3;
  score += Math.max(s5.avgReturnAnnual ?? 0, 0) * 12;
  score += (s5.medianReturnAnnual ?? 0) * 4;

  if (s10 && !s10.insufficient) {
    score += (s10.winRateAnnual ?? 0) * 2;
    score += Math.max(s10.avgReturnAnnual ?? 0, 0) * 6;
  }
  if (s15 && !s15.insufficient) {
    score += (s15.winRateAnnual ?? 0) * 1.5;
    score += Math.max(s15.avgReturnAnnual ?? 0, 0) * 4;
  }

  const calDays = _maskDayCount(window);
  if (calDays < 35) score -= 0.5;
  if (s5.yearsCount < 5) score -= (5 - s5.yearsCount) * 0.4;

  const worst = Math.min(
    ...(s5.annualReturns ?? []).map((a) => a.returnPct),
    0,
  );
  if (worst < -0.25) score -= 0.8;

  return { score, annualHorizons };
}

/** Score candidat baissier — annual uniquement (force via getStrictMultiHorizonStrength). */
function _scoreAnnualBearishCandidateFast(window, ctx) {
  const annualHorizons = _buildAnnualHorizonsFromCtx(window, ctx);

  const s5 = annualHorizons['5y'];
  const s10 = annualHorizons['10y'];
  const s15 = annualHorizons['15y'];

  if (!s5 || s5.insufficient || s5.bearishRateAnnual == null) {
    return { score: -Infinity, annualHorizons, strength: STRICT_STRENGTH_LABELS.NON_CONFIRMEE };
  }

  const strength = getStrictMultiHorizonStrength({ annualHorizons }, 'bearish');

  let score = 0;
  score += (s5.bearishRateAnnual ?? 0) * 3;
  score += Math.max(-(s5.avgReturnAnnual ?? 0), 0) * BEARISH_AVG5_POSITIVE_SCORE_PENALTY;
  if ((s5.avgReturnAnnual ?? 0) > 0) {
    score -= (s5.avgReturnAnnual ?? 0) * BEARISH_AVG5_POSITIVE_SCORE_PENALTY;
  }
  score += Math.min(s5.medianReturnAnnual ?? 0, 0) * -4;

  if (s10 && !s10.insufficient) {
    score += (s10.bearishRateAnnual ?? 0) * 2;
    score += Math.max(-(s10.avgReturnAnnual ?? 0), 0) * 6;
  }
  if (s15 && !s15.insufficient) {
    score += (s15.bearishRateAnnual ?? 0) * 1.5;
    score += Math.max(-(s15.avgReturnAnnual ?? 0), 0) * 4;
  }

  if (strength === STRICT_STRENGTH_LABELS.FORTE) score += 20;
  else if (strength === STRICT_STRENGTH_LABELS.CONFIRMEE) score += 12;
  else score -= 20;

  const calDays = _maskDayCount(window);
  if (calDays < 35) score -= 0.5;
  if (s5.yearsCount < 5) score -= (5 - s5.yearsCount) * 0.4;

  const worst = Math.max(...(s5.annualReturns ?? []).map((a) => a.returnPct), 0);
  if (worst > 0.25) score -= 0.8;

  return { score, annualHorizons, strength };
}

function _finalizeBearishAnnualWindow(candidate, evalResult, index, ctx, options = {}) {
  const display = buildSeasonalWindowDisplayFields({
    startMonth: candidate.startMonth,
    startWeekOfMonth: candidate.startWeekOfMonth,
    endMonth: candidate.endMonth,
    endWeekOfMonth: candidate.endWeekOfMonth,
    windowDays: candidate.windowDays,
  });

  const s15 = evalResult.annualHorizons?.['15y'];
  const glidingRobustness = options.skipGliding
    ? null
    : _buildGlidingHorizons(candidate, index, candidate.windowDays, ctx);

  return {
    ...enrichAnnualWindow({ ...candidate, ...display }),
    annualHorizons: evalResult.annualHorizons,
    ...(glidingRobustness ? { glidingRobustness } : {}),
    negativeYears: s15?.negativeYears ?? null,
    bearishRateAnnual: s15?.bearishRateAnnual ?? null,
    avgReturnAnnual: s15?.avgReturnAnnual ?? null,
    medianReturnAnnual: s15?.medianReturnAnnual ?? null,
    strength: evalResult.strength,
    strengthDirection: 'bearish',
    score: _r3(evalResult.score),
  };
}

/**
 * Grille annuelle indépendante du glissant swing — scan signatures calendaires sur prix réels.
 * Step 5 jours · durées 20/40/60/90 · horizon 15y.
 */
export function collectAnnualBearishGridCandidates(index, options = {}) {
  if (!index?.sortedRows?.length) return [];

  const sigMap = new Map();
  const step = options.gridStep ?? BEARISH_GRID_STEP;
  const windowDaysList = options.windowDaysList ?? GLIDING_WINDOW_DAYS_LIST;
  const horizonYears = options.horizonYears ?? 15;
  const filtered = index.filteredByHorizon?.[horizonYears];
  if (!filtered || filtered.length < 100) return [];

  const today = index.now;
  today.setUTCHours(23, 59, 59, 999);

  for (const windowDays of windowDaysList) {
    for (let i = 0; i < filtered.length - windowDays; i += step) {
      const startRow = filtered[i];
      const endRow = filtered[i + windowDays];
      if (!startRow || !endRow || endRow.date > today) continue;

      const startClose = startRow.close;
      const endClose = endRow.close;
      if (!Number.isFinite(startClose) || startClose <= 0) continue;
      if (!Number.isFinite(endClose) || endClose <= 0) continue;

      const previewReturn = (endClose - startClose) / startClose;
      const candidate = {
        startMonth: startRow.date.getUTCMonth() + 1,
        startWeekOfMonth: _weekOfMonth(startRow.date),
        endMonth: endRow.date.getUTCMonth() + 1,
        endWeekOfMonth: _weekOfMonth(endRow.date),
        windowDays,
      };

      const calDays = _maskDayCount(candidate);
      if (calDays < MIN_CALENDAR_DAYS || calDays > MAX_CALENDAR_DAYS) continue;

      const sig = _windowSignature(candidate);
      if (!sig) continue;

      const prev = sigMap.get(sig);
      if (!prev || previewReturn < prev.previewReturn) {
        sigMap.set(sig, { ...candidate, calDays, previewReturn, source: 'annual-grid' });
      }
    }
  }

  return [...sigMap.values()];
}

function _bestBearishCacheKey(ticker, index) {
  return [
    String(ticker ?? '').toUpperCase(),
    index.lastDateIso,
    index.rowsCount,
    BEARISH_ANNUAL_ALGORITHM_VERSION,
    BEARISH_GRID_STEP,
    BEARISH_MAX_GRID_CANDIDATES,
    BEARISH_MAX_ANNUAL_SCORE,
  ].join('|');
}

function _buildBearishAnnualCandidatePool(index, options = {}) {
  const sigMap = new Map();
  const addList = (list, source) => {
    for (const c of list ?? []) {
      const sig = _windowSignature(c);
      if (!sig || sigMap.has(sig)) continue;
      sigMap.set(sig, { ...c, source: c.source ?? source });
    }
  };

  const gridAll = collectAnnualBearishGridCandidates(index, options);
  let grid = gridAll;
  if (gridAll.length > BEARISH_MAX_GRID_CANDIDATES) {
    grid = [...gridAll]
      .sort((a, b) => (a.previewReturn ?? 0) - (b.previewReturn ?? 0))
      .slice(0, BEARISH_MAX_GRID_CANDIDATES);
  }
  addList(grid, 'annual-grid');
  addList(_candidatesFromHorizonsBearish(options.horizons), 'horizon-bearish');
  addList(options.candidates, 'explicit');

  let candidates = [...sigMap.values()];
  const maxScore = options.maxAnnualScore ?? BEARISH_MAX_ANNUAL_SCORE;
  if (candidates.length > maxScore) {
    candidates = candidates
      .sort((a, b) => (a.previewReturn ?? 0) - (b.previewReturn ?? 0))
      .slice(0, maxScore);
  }

  return {
    candidates,
    gridCandidatesTotal: gridAll.length,
    gridCandidatesUsed: grid.length,
  };
}

/**
 * Cherche les meilleures fenêtres baissières annuelles réelles via grille + annuel.
 * Ne recycle pas le glissant swing comme source principale.
 */
export function findBestAnnualBearishWindows(ticker, priceRows, options = {}) {
  const empty = {
    windows: [],
    noStrongBearishAnnualWindow: true,
    allScored: [],
    bearishAnnualCandidatesTested: 0,
    gridCandidatesTotal: 0,
    gridCandidatesUsed: 0,
    strongBearishFound: 0,
    confirmedBearishFound: 0,
  };

  if (!priceRows?.length) return empty;

  const sym = String(ticker ?? '').trim().toUpperCase() || null;
  const index = options.index ?? buildPriceRowIndex(priceRows);
  if (!index) return empty;

  const cacheKey = _bestBearishCacheKey(sym, index);
  if (!options.skipCache) {
    const cached = _bestBearishAnnualCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      if (_perfEnabled()) {
        _logPerf({
          ticker: sym,
          bearishAnnualCandidatesTested: cached.value.bearishAnnualCandidatesTested ?? 0,
          bestBearishAnnualWindowsMs: 0,
          strongBearishFound: cached.value.strongBearishFound ?? 0,
          confirmedBearishFound: cached.value.confirmedBearishFound ?? 0,
          cacheHit: true,
        });
      }
      return cached.value;
    }
  }

  const pool = _buildBearishAnnualCandidatePool(index, options);
  const candidates = pool.candidates;

  const t0 = performance.now();
  const ctx = options.ctx ?? {
    index,
    annualBySig: new Map(),
    occurrenceByKey: new Map(),
    annualStatsCalls: 0,
    glidingStatsCalls: 0,
  };

  const allScored = [];
  for (const c of candidates) {
    const evalResult = _scoreAnnualBearishCandidateFast(c, ctx);
    if (evalResult.score <= -Infinity) continue;
    allScored.push({ candidate: c, evalResult, score: evalResult.score, strength: evalResult.strength });
  }

  allScored.sort((a, b) => {
    const strengthRank = (s) => {
      if (s === STRICT_STRENGTH_LABELS.FORTE) return 4;
      if (s === STRICT_STRENGTH_LABELS.CONFIRMEE) return 3;
      if (s === STRICT_STRENGTH_LABELS.FAIBLE) return 2;
      return 1;
    };
    const sr = strengthRank(b.strength) - strengthRank(a.strength);
    if (sr !== 0) return sr;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  const strongEntries = allScored
    .filter((x) => isStrongOrConfirmedStrength(x.strength))
    .slice(0, options.maxResults ?? 3);

  const strongWindows = strongEntries.map(({ candidate, evalResult }) =>
    _finalizeBearishAnnualWindow(candidate, evalResult, index, ctx),
  );

  const strongBearishFound = strongWindows.filter((w) => w.strength === STRICT_STRENGTH_LABELS.FORTE).length;
  const confirmedBearishFound = strongWindows.filter((w) => w.strength === STRICT_STRENGTH_LABELS.CONFIRMEE).length;
  const bestBearishAnnualWindowsMs = Math.round(performance.now() - t0);

  const result = {
    windows: strongWindows,
    noStrongBearishAnnualWindow: strongWindows.length === 0,
    allScored: allScored.map(({ candidate, evalResult }) =>
      _finalizeBearishAnnualWindow(candidate, evalResult, index, ctx, { skipGliding: true }),
    ),
    bearishAnnualCandidatesTested: candidates.length,
    gridCandidatesTotal: pool.gridCandidatesTotal,
    gridCandidatesUsed: pool.gridCandidatesUsed,
    strongBearishFound,
    confirmedBearishFound,
  };

  _bestBearishAnnualCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + BEST_ANNUAL_CACHE_TTL_MS,
  });

  if (_perfEnabled()) {
    _logPerf({
      ticker: sym,
      bestBearishAnnualWindowsMs,
      bearishAnnualCandidatesTested: candidates.length,
      gridCandidatesTotal: pool.gridCandidatesTotal,
      gridCandidatesUsed: pool.gridCandidatesUsed,
      annualStatsCalls: ctx.annualStatsCalls,
      strongBearishFound,
      confirmedBearishFound,
      cacheHit: options.ctx != null,
    });
  }

  return result;
}

function _candidatesFromHorizons(horizons) {
  const sigMap = new Map();
  for (const h of horizons ?? []) {
    for (const block of h.windows ?? []) {
      for (const w of block.bestBullish ?? []) {
        const sig = _windowSignature(w);
        if (!sig || sigMap.has(sig)) continue;
        const calDays = _maskDayCount(w);
        if (calDays < MIN_CALENDAR_DAYS || calDays > MAX_CALENDAR_DAYS) continue;
        sigMap.set(sig, {
          startMonth: w.startMonth,
          startWeekOfMonth: w.startWeekOfMonth,
          endMonth: w.endMonth,
          endWeekOfMonth: w.endWeekOfMonth,
          windowDays: w.windowDays ?? 40,
          previewReturn: w.avgReturn ?? 0,
        });
      }
    }
  }
  return [...sigMap.values()];
}

function _candidatesFromHorizonsBearish(horizons) {
  const sigMap = new Map();
  for (const h of horizons ?? []) {
    for (const block of h.windows ?? []) {
      for (const w of block.worstBearish ?? []) {
        const sig = _windowSignature(w);
        if (!sig || sigMap.has(sig)) continue;
        const calDays = _maskDayCount(w);
        if (calDays < MIN_CALENDAR_DAYS || calDays > MAX_CALENDAR_DAYS) continue;
        sigMap.set(sig, {
          startMonth: w.startMonth,
          startWeekOfMonth: w.startWeekOfMonth,
          endMonth: w.endMonth,
          endWeekOfMonth: w.endWeekOfMonth,
          windowDays: w.windowDays ?? 40,
          previewReturn: w.avgReturn ?? 0,
        });
      }
    }
  }
  return [...sigMap.values()];
}

function _candidatesFromSwingWindows(swingList) {
  const sigMap = new Map();
  for (const w of swingList ?? []) {
    const sig = _windowSignature(w);
    if (!sig || sigMap.has(sig)) continue;
    const calDays = _maskDayCount(w);
    if (calDays < MIN_CALENDAR_DAYS || calDays > MAX_CALENDAR_DAYS) continue;
    sigMap.set(sig, {
      startMonth: w.startMonth,
      startWeekOfMonth: w.startWeekOfMonth,
      endMonth: w.endMonth,
      endWeekOfMonth: w.endWeekOfMonth,
      windowDays: w.windowDays ?? 40,
      previewReturn: w.avgReturn ?? w.displayAvgReturn ?? 0,
    });
  }
  return [...sigMap.values()];
}

// ─── Moteur haussier annuel (grille indépendante) ─────────────────────────────

/** Fraction de chevauchement calendaire entre deux fenêtres (0–1). */
function _windowsOverlapFraction(w1, w2) {
  const { mask: mask1 } = buildCalendarCoverageMask(w1);
  const { mask: mask2 } = buildCalendarCoverageMask(w2);
  let overlap = 0, count1 = 0, count2 = 0;
  for (let d = 1; d < mask1.length; d++) {
    if (mask1[d]) count1++;
    if (mask2[d]) count2++;
    if (mask1[d] && mask2[d]) overlap++;
  }
  const minCount = Math.min(count1, count2);
  return minCount > 0 ? overlap / minCount : 0;
}

/** Exigences rendement positif pour haussier Forte/Confirmée. */
function _applyBullishReturnRequirements(annualHorizons, strength) {
  if (!isStrongOrConfirmedStrength(strength)) return strength;

  const s15 = annualHorizons?.['15y'];
  const s5 = annualHorizons?.['5y'];
  const avg15 = s15?.insufficient ? null : s15?.avgReturnAnnual;
  const med15 = s15?.insufficient ? null : s15?.medianReturnAnnual;
  const avg5 = s5?.insufficient ? null : s5?.avgReturnAnnual;

  if (strength === STRICT_STRENGTH_LABELS.FORTE) {
    if (avg15 == null || avg15 <= 0) return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
    if (med15 != null && med15 <= 0) return STRICT_STRENGTH_LABELS.FAIBLE;
    return strength;
  }

  const avgRef = avg15 ?? avg5;
  if (avgRef == null || avgRef <= 0) return STRICT_STRENGTH_LABELS.NON_CONFIRMEE;
  return strength;
}

function _getBullishStrengthWithReturnCheck(annualHorizons) {
  const base = getStrictMultiHorizonStrength({ annualHorizons }, 'bullish');
  return _applyBullishReturnRequirements(annualHorizons, base);
}

/** Score candidat haussier — annual uniquement. */
function _scoreAnnualBullishCandidateFast(window, ctx) {
  const annualHorizons = _buildAnnualHorizonsFromCtx(window, ctx);

  const s5 = annualHorizons['5y'];
  const s10 = annualHorizons['10y'];
  const s15 = annualHorizons['15y'];

  if (!s5 || s5.insufficient || s5.winRateAnnual == null) {
    return { score: -Infinity, annualHorizons, strength: STRICT_STRENGTH_LABELS.NON_CONFIRMEE };
  }

  const strength = _getBullishStrengthWithReturnCheck(annualHorizons);

  let score = 0;
  score += (s5.winRateAnnual ?? 0) * 3;
  score += Math.max(s5.avgReturnAnnual ?? 0, 0) * 12;
  if ((s5.avgReturnAnnual ?? 0) < 0) score += (s5.avgReturnAnnual ?? 0) * 12;
  score += Math.max(s5.medianReturnAnnual ?? 0, 0) * 4;

  if (s10 && !s10.insufficient) {
    score += (s10.winRateAnnual ?? 0) * 2;
    score += Math.max(s10.avgReturnAnnual ?? 0, 0) * 6;
  }
  if (s15 && !s15.insufficient) {
    score += (s15.winRateAnnual ?? 0) * 1.5;
    score += Math.max(s15.avgReturnAnnual ?? 0, 0) * 4;
  }

  if (strength === STRICT_STRENGTH_LABELS.FORTE) score += 20;
  else if (strength === STRICT_STRENGTH_LABELS.CONFIRMEE) score += 12;
  else score -= 20;

  const calDays = _maskDayCount(window);
  if (calDays < 35) score -= 0.5;
  if (s5.yearsCount < 5) score -= (5 - s5.yearsCount) * 0.4;

  const worst = Math.min(...(s5.annualReturns ?? []).map((a) => a.returnPct), 0);
  if (worst < -0.25) score -= 0.8;

  return { score, annualHorizons, strength };
}

function _finalizeBullishAnnualWindow(candidate, evalResult, index, ctx, options = {}) {
  const display = buildSeasonalWindowDisplayFields({
    startMonth: candidate.startMonth,
    startWeekOfMonth: candidate.startWeekOfMonth,
    endMonth: candidate.endMonth,
    endWeekOfMonth: candidate.endWeekOfMonth,
    windowDays: candidate.windowDays,
  });

  const s15 = evalResult.annualHorizons?.['15y'];
  const glidingRobustness = options.skipGliding
    ? null
    : _buildGlidingHorizons(candidate, index, candidate.windowDays, ctx);

  return {
    ...enrichAnnualWindow({ ...candidate, ...display }),
    annualHorizons: evalResult.annualHorizons,
    ...(glidingRobustness ? { glidingRobustness } : {}),
    positiveYears: s15?.positiveYears ?? null,
    winRateAnnual: s15?.winRateAnnual ?? null,
    avgReturnAnnual: s15?.avgReturnAnnual ?? null,
    medianReturnAnnual: s15?.medianReturnAnnual ?? null,
    strength: evalResult.strength,
    strengthDirection: 'bullish',
    score: _r3(evalResult.score),
  };
}

/**
 * Grille annuelle indépendante — scan signatures calendaires haussières sur prix réels.
 * Step 5 jours · durées 20/40/60/90 · garde le meilleur return par signature.
 */
export function collectAnnualBullishGridCandidates(index, options = {}) {
  if (!index?.sortedRows?.length) return [];

  const sigMap = new Map();
  const step = options.gridStep ?? BULLISH_GRID_STEP;
  const windowDaysList = options.windowDaysList ?? GLIDING_WINDOW_DAYS_LIST;
  const horizonYears = options.horizonYears ?? 15;
  const filtered = index.filteredByHorizon?.[horizonYears];
  if (!filtered || filtered.length < 100) return [];

  const today = index.now;
  today.setUTCHours(23, 59, 59, 999);

  for (const windowDays of windowDaysList) {
    for (let i = 0; i < filtered.length - windowDays; i += step) {
      const startRow = filtered[i];
      const endRow = filtered[i + windowDays];
      if (!startRow || !endRow || endRow.date > today) continue;

      const startClose = startRow.close;
      const endClose = endRow.close;
      if (!Number.isFinite(startClose) || startClose <= 0) continue;
      if (!Number.isFinite(endClose) || endClose <= 0) continue;

      const previewReturn = (endClose - startClose) / startClose;
      const candidate = {
        startMonth: startRow.date.getUTCMonth() + 1,
        startWeekOfMonth: _weekOfMonth(startRow.date),
        endMonth: endRow.date.getUTCMonth() + 1,
        endWeekOfMonth: _weekOfMonth(endRow.date),
        windowDays,
      };

      const calDays = _maskDayCount(candidate);
      if (calDays < MIN_CALENDAR_DAYS || calDays > MAX_CALENDAR_DAYS) continue;

      const sig = _windowSignature(candidate);
      if (!sig) continue;

      const prev = sigMap.get(sig);
      if (!prev || previewReturn > prev.previewReturn) {
        sigMap.set(sig, { ...candidate, calDays, previewReturn, source: 'annual-grid' });
      }
    }
  }

  return [...sigMap.values()];
}

function _bestBullishCacheKey(ticker, index) {
  return [
    String(ticker ?? '').toUpperCase(),
    index.lastDateIso,
    index.rowsCount,
    BULLISH_ANNUAL_ALGORITHM_VERSION,
    BULLISH_GRID_STEP,
    BULLISH_MAX_GRID_CANDIDATES,
    BULLISH_MAX_ANNUAL_SCORE,
  ].join('|');
}

function _buildBullishAnnualCandidatePool(index, options = {}) {
  const sigMap = new Map();
  const addList = (list, source) => {
    for (const c of list ?? []) {
      const sig = _windowSignature(c);
      if (!sig || sigMap.has(sig)) continue;
      sigMap.set(sig, { ...c, source: c.source ?? source });
    }
  };

  const gridAll = collectAnnualBullishGridCandidates(index, options);
  let grid = gridAll;
  if (gridAll.length > BULLISH_MAX_GRID_CANDIDATES) {
    grid = [...gridAll]
      .sort((a, b) => (b.previewReturn ?? 0) - (a.previewReturn ?? 0))
      .slice(0, BULLISH_MAX_GRID_CANDIDATES);
  }
  addList(grid, 'annual-grid');
  addList(_candidatesFromHorizons(options.horizons), 'horizon-bullish');
  addList(options.candidates, 'explicit');

  let candidates = [...sigMap.values()];
  const maxScore = options.maxAnnualScore ?? BULLISH_MAX_ANNUAL_SCORE;
  if (candidates.length > maxScore) {
    candidates = candidates
      .sort((a, b) => (b.previewReturn ?? 0) - (a.previewReturn ?? 0))
      .slice(0, maxScore);
  }

  return {
    candidates,
    gridCandidatesTotal: gridAll.length,
    gridCandidatesUsed: grid.length,
  };
}

/**
 * Cherche les meilleures fenêtres haussières annuelles réelles via grille + annuel.
 * Retourne plusieurs fenêtres distinctes (déduplication par chevauchement calendaire).
 */
export function findBestAnnualBullishWindows(ticker, priceRows, options = {}) {
  const empty = {
    windows: [],
    noStrongBullishAnnualWindow: true,
    allScored: [],
    bullishAnnualCandidatesTested: 0,
    gridCandidatesTotal: 0,
    gridCandidatesUsed: 0,
    strongBullishFound: 0,
    confirmedBullishFound: 0,
  };

  if (!priceRows?.length) return empty;

  const sym = String(ticker ?? '').trim().toUpperCase() || null;
  const index = options.index ?? buildPriceRowIndex(priceRows);
  if (!index) return empty;

  const cacheKey = _bestBullishCacheKey(sym, index);
  if (!options.skipCache) {
    const cached = _bestBullishAnnualCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.value;
  }

  const pool = _buildBullishAnnualCandidatePool(index, options);
  const candidates = pool.candidates;

  const ctx = options.ctx ?? {
    index,
    annualBySig: new Map(),
    occurrenceByKey: new Map(),
    annualStatsCalls: 0,
    glidingStatsCalls: 0,
  };

  const allScored = [];
  for (const c of candidates) {
    const evalResult = _scoreAnnualBullishCandidateFast(c, ctx);
    if (evalResult.score <= -Infinity) continue;
    allScored.push({ candidate: c, evalResult, score: evalResult.score, strength: evalResult.strength });
  }

  allScored.sort((a, b) => {
    const strengthRank = (s) => {
      if (s === STRICT_STRENGTH_LABELS.FORTE) return 4;
      if (s === STRICT_STRENGTH_LABELS.CONFIRMEE) return 3;
      if (s === STRICT_STRENGTH_LABELS.FAIBLE) return 2;
      return 1;
    };
    const sr = strengthRank(b.strength) - strengthRank(a.strength);
    if (sr !== 0) return sr;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  // Sélection greedy : fenêtres distinctes (chevauchement < 60 %)
  const strongEntries = allScored.filter((x) => isStrongOrConfirmedStrength(x.strength));
  const maxResults = options.maxResults ?? 3;
  const selected = [];
  for (const entry of strongEntries) {
    if (selected.length >= maxResults) break;
    const overlaps = selected.some((s) => {
      if (_windowsOverlapFraction(entry.candidate, s.candidate) > 0.45) return true;
      const mDiff = Math.abs(entry.candidate.startMonth - s.candidate.startMonth);
      return Math.min(mDiff, 12 - mDiff) < 2;
    });
    if (!overlaps) selected.push(entry);
  }

  const strongWindows = selected.map(({ candidate, evalResult }) =>
    _finalizeBullishAnnualWindow(candidate, evalResult, index, ctx),
  );

  const strongBullishFound = strongWindows.filter((w) => w.strength === STRICT_STRENGTH_LABELS.FORTE).length;
  const confirmedBullishFound = strongWindows.filter((w) => w.strength === STRICT_STRENGTH_LABELS.CONFIRMEE).length;

  const result = {
    windows: strongWindows,
    noStrongBullishAnnualWindow: strongWindows.length === 0,
    allScored: allScored.map(({ candidate, evalResult }) =>
      _finalizeBullishAnnualWindow(candidate, evalResult, index, ctx, { skipGliding: true }),
    ),
    bullishAnnualCandidatesTested: candidates.length,
    gridCandidatesTotal: pool.gridCandidatesTotal,
    gridCandidatesUsed: pool.gridCandidatesUsed,
    strongBullishFound,
    confirmedBullishFound,
  };

  _bestBullishAnnualCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + BEST_ANNUAL_CACHE_TTL_MS,
  });

  return result;
}

/**
 * Détecte la meilleure fenêtre saisonnière annuelle pour un ticker.
 */
export function findBestAnnualSeasonalityWindow(ticker, priceRows, options = {}) {
  if (!priceRows?.length) return null;

  const sym = String(ticker ?? '').trim().toUpperCase() || null;
  const index = buildPriceRowIndex(priceRows);
  if (!index) return null;

  let candidates = options.candidates?.length
    ? options.candidates
    : _candidatesFromHorizons(options.horizons);

  if (!candidates.length && options.allowFullScan) {
    candidates = _collectGlidingCandidatesSlow(priceRows);
  }

  const seed = options.seedWindow;
  if (seed) {
    const sig = _windowSignature(seed);
    if (sig && !candidates.some((c) => _windowSignature(c) === sig)) {
      candidates.push({
        ..._normalizeWindow(seed),
        windowDays: seed.windowDays ?? 40,
        previewReturn: seed.avgReturn ?? 0,
      });
    }
  }

  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (candidates.length > maxCandidates) {
    candidates = candidates
      .sort((a, b) => (b.previewReturn ?? 0) - (a.previewReturn ?? 0))
      .slice(0, maxCandidates);
  }

  const cacheKey = _bestAnnualCacheKey(sym, index, candidates.length);
  const cached = options.skipCache ? undefined : _getBestAnnualCached(cacheKey);
  if (cached !== undefined) {
    _logPerf({
      ticker: sym,
      rowsCount: index.rowsCount,
      candidateWindowsTested: 0,
      annualStatsCalls: 0,
      glidingStatsCalls: 0,
      bestAnnualWindowMs: 0,
      totalWindowsMs: options.totalWindowsMs ?? null,
      cacheHit: true,
    });
    return cached;
  }

  const t0 = performance.now();
  const ctx = {
    index,
    annualBySig: new Map(),
    occurrenceByKey: new Map(),
    annualStatsCalls: 0,
    glidingStatsCalls: 0,
  };

  let best = null;
  let bestEval = null;

  for (const c of candidates) {
    const evalResult = _scoreAnnualCandidateFast(c, ctx);
    if (evalResult.score > (bestEval?.score ?? -Infinity)) {
      best = c;
      bestEval = evalResult;
    }
  }

  if (!best || !bestEval) return null;

  const glidingRobustness = _buildGlidingHorizons(
    best,
    index,
    best.windowDays,
    ctx,
  );

  const display = buildSeasonalWindowDisplayFields({
    startMonth: best.startMonth,
    startWeekOfMonth: best.startWeekOfMonth,
    endMonth: best.endMonth,
    endWeekOfMonth: best.endWeekOfMonth,
    windowDays: best.windowDays,
  });

  const result = {
    ticker: sym,
    window: enrichAnnualWindow({ ...best, ...display }),
    annualHorizons: bestEval.annualHorizons,
    glidingRobustness,
    score: _r3(bestEval.score),
    strength: getStrictMultiHorizonStrength({ annualHorizons: bestEval.annualHorizons }, 'bullish'),
    strengthDirection: 'bullish',
    generatedAt: new Date().toISOString(),
    algorithmVersion: ANNUAL_ALGORITHM_VERSION,
  };
  if (result.window) {
    result.window = { ...result.window, strength: result.strength, strengthDirection: 'bullish' };
  }

  _setBestAnnualCached(cacheKey, result);

  const bestAnnualWindowMs = Math.round(performance.now() - t0);
  _logPerf({
    ticker: sym,
    rowsCount: index.rowsCount,
    candidateWindowsTested: candidates.length,
    annualStatsCalls: ctx.annualStatsCalls,
    glidingStatsCalls: ctx.glidingStatsCalls,
    bestAnnualWindowMs,
    totalWindowsMs: options.totalWindowsMs ?? null,
    cacheHit: false,
  });

  return result;
}

/** Scan complet quotidien — évité en prod si horizons fournis. */
function _collectGlidingCandidatesSlow(rows) {
  const sigMap = new Map();
  const index = buildPriceRowIndex(rows);
  if (!index) return [];

  for (const horizonYears of [15, 10]) {
    const filtered = index.filteredByHorizon[horizonYears];
    if (filtered.length < 100) continue;

    for (const windowDays of GLIDING_WINDOW_DAYS_LIST) {
      const today = index.now;
      today.setUTCHours(23, 59, 59, 999);

      for (let i = 0; i < filtered.length - windowDays; i += 5) {
        const startRow = filtered[i];
        const endRow = filtered[i + windowDays];
        if (!startRow || !endRow || endRow.date > today) continue;

        const startClose = startRow.close;
        const endClose = endRow.close;
        if (!Number.isFinite(startClose) || startClose <= 0) continue;
        if (!Number.isFinite(endClose) || endClose <= 0) continue;

        const candidate = {
          startMonth: startRow.date.getUTCMonth() + 1,
          startWeekOfMonth: _weekOfMonth(startRow.date),
          endMonth: endRow.date.getUTCMonth() + 1,
          endWeekOfMonth: _weekOfMonth(endRow.date),
          windowDays,
        };

        const calDays = _maskDayCount(candidate);
        if (calDays < MIN_CALENDAR_DAYS || calDays > MAX_CALENDAR_DAYS) continue;

        const sig = _windowSignature(candidate);
        if (!sig || sigMap.has(sig)) continue;

        sigMap.set(sig, {
          ...candidate,
          calDays,
          previewReturn: (endClose - startClose) / startClose,
        });
      }
    }
  }

  return [...sigMap.values()];
}

export function enrichAnnualWindow(window) {
  if (!window) return window;
  const hasWeeks =
    window.startMonth != null &&
    window.startWeekOfMonth != null &&
    window.endMonth != null &&
    window.endWeekOfMonth != null;
  if (!hasWeeks) return window;
  return {
    ...window,
    ...buildSeasonalWindowDisplayFields({
      startMonth: window.startMonth,
      startWeekOfMonth: window.startWeekOfMonth,
      endMonth: window.endMonth,
      endWeekOfMonth: window.endWeekOfMonth,
      label: window.label,
      windowDays: window.windowDays,
    }),
  };
}

export function formatAnnualHorizonLine(horizonKey, stats) {
  if (!stats || stats.insufficient || stats.yearsCount == null) return null;
  const pos = stats.positiveYears ?? 0;
  const total = stats.yearsCount;
  const avg = stats.avgReturnAnnual;
  const avgStr = typeof avg === 'number'
    ? `${avg >= 0 ? '+' : ''}${(avg * 100).toFixed(1)} %`
    : '—';
  return `${horizonKey} : ${pos}/${total} haussier · rendement moyen ${avgStr}`;
}

export function formatGlidingRobustnessLine(horizonKey, stats) {
  if (!stats || stats.sampleSize == null) return null;
  const pct = stats.winRateGliding != null
    ? `${Math.round(stats.winRateGliding * 100)} % positif`
    : '—';
  return `${horizonKey} : ${pct} · n=${stats.sampleSize} tests glissants`;
}

/** Raison principale de rejet baissier annuel (diagnostic — ne modifie pas les seuils). */
function _primaryBearishRejectReason(annualHorizons) {
  const s3 = annualHorizons?.['3y'];
  const s5 = annualHorizons?.['5y'];
  const s10 = annualHorizons?.['10y'];
  const s15 = annualHorizons?.['15y'];

  if (!s5 || s5.insufficient) return 'donnees_insuffisantes';

  const evals = STRICT_HORIZON_THRESHOLDS.map((h) => ({
    key: h.key,
    confirmMin: h.confirmMin,
    ..._evaluateStrictHorizon(
      annualHorizons[h.key],
      'bearish',
      h.forteMin,
      h.confirmMin,
      h.years,
    ),
  }));

  const sufficient = evals.filter((e) => e.sufficient);
  if (sufficient.length === 0) return 'donnees_insuffisantes';

  const eval15 = evals.find((e) => e.key === '15y');
  const eval10 = evals.find((e) => e.key === '10y');
  const eval5h = evals.find((e) => e.key === '5y');
  const eval3 = evals.find((e) => e.key === '3y');
  const inDirectionCount = evals.filter((e) => e.inDirection).length;

  if (eval15?.sufficient) {
    const min15 = _scaledMinThreshold(10, 15, eval15.total);
    if (eval15.directional < min15) return '15y_lt_10_sur_15';
  }
  if (eval10?.sufficient && !eval10.meetsConfirm) return '10y_lt_8_sur_10';
  if (eval5h?.sufficient) {
    const min5 = _scaledMinThreshold(4, 5, eval5h.total);
    if (eval5h.directional < min5) return '5y_lt_4_sur_5';
  }
  if (eval3?.sufficient && !eval3.meetsConfirm) return '3y_lt_2_sur_3';

  if (evals.some((e) => e.strongOpposite)) return 'strongOpposite';
  if (inDirectionCount < 2) return 'inDirection_lt_2_horizons';

  const strengthRaw = getStrictMultiHorizonStrength({ annualHorizons }, 'bearish');
  if (isStrongOrConfirmedStrength(strengthRaw)) return null;

  const avg15 = s15?.insufficient ? null : s15?.avgReturnAnnual;
  const med15 = s15?.insufficient ? null : s15?.medianReturnAnnual;
  const avg5v = s5.avgReturnAnnual;

  if (avg15 != null && avg15 >= 0) return 'avgReturn15y_ge_0';
  if (med15 != null && med15 >= 0 && strengthRaw === STRICT_STRENGTH_LABELS.FAIBLE) {
    return 'medianReturn15y_ge_0';
  }
  const avgRef = avg15 ?? avg5v;
  if (avgRef != null && avgRef >= 0) return 'avgReturn15y_ge_0';

  return strengthRaw === STRICT_STRENGTH_LABELS.FAIBLE ? 'faible' : 'autre';
}

function _formatBearishHorizonRatio(stats, direction = 'bearish') {
  if (!stats || stats.insufficient || stats.yearsCount == null) return '—';
  const dir = direction === 'bearish'
    ? (stats.negativeYears ?? 0)
    : (stats.positiveYears ?? 0);
  return `${dir}/${stats.yearsCount}`;
}

function _summarizeBearishCandidateForDiagnosis(candidate, annualHorizons, rejectReason) {
  const display = buildSeasonalWindowDisplayFields({
    startMonth: candidate.startMonth,
    startWeekOfMonth: candidate.startWeekOfMonth,
    endMonth: candidate.endMonth,
    endWeekOfMonth: candidate.endWeekOfMonth,
    windowDays: candidate.windowDays,
  });
  const s15 = annualHorizons?.['15y'];
  const s10 = annualHorizons?.['10y'];
  const s5 = annualHorizons?.['5y'];
  const s3 = annualHorizons?.['3y'];

  return {
    displayLabel: display.displayLabel ?? display.label ?? _windowSignature(candidate),
    annual15y: _formatBearishHorizonRatio(s15, 'bearish'),
    annual10y: _formatBearishHorizonRatio(s10, 'bearish'),
    annual5y: _formatBearishHorizonRatio(s5, 'bearish'),
    annual3y: _formatBearishHorizonRatio(s3, 'bearish'),
    avgReturn15y: s15?.avgReturnAnnual ?? null,
    medianReturn15y: s15?.medianReturnAnnual ?? null,
    avgReturn10y: s10?.avgReturnAnnual ?? null,
    medianReturn10y: s10?.medianReturnAnnual ?? null,
    avgReturn5y: s5?.avgReturnAnnual ?? null,
    rejectReason: rejectReason ?? 'accepted',
    strength: getStrictMultiHorizonStrength({ annualHorizons }, 'bearish'),
    previewReturn: candidate.previewReturn ?? null,
    source: candidate.source ?? null,
  };
}

/** Fenêtres calendaires cibles pour vérifier la couverture de la grille baissière. */
export const BEARISH_GRID_TARGET_WINDOWS = [
  { label: 'août→sept', startMonth: 8, endMonth: 9 },
  { label: 'sept→oct', startMonth: 9, endMonth: 10 },
  { label: 'sept→nov', startMonth: 9, endMonth: 11 },
  { label: 'oct→déc', startMonth: 10, endMonth: 12 },
  { label: 'nov→jan', startMonth: 11, endMonth: 1, crossYear: true },
  { label: 'déc→mars', startMonth: 12, endMonth: 3, crossYear: true },
  { label: 'jan→mars', startMonth: 1, endMonth: 3 },
];

function _gridCoversTargetWindow(gridCandidates, target) {
  return (gridCandidates ?? []).some((c) => {
    if (c.startMonth !== target.startMonth) return false;
    if (target.crossYear) return c.endMonth === target.endMonth;
    return c.endMonth === target.endMonth;
  });
}

/**
 * Diagnostic baissier annuel — compteurs de rejet, top candidats rejetées, sans modifier les seuils.
 */
export function diagnoseBearishAnnualWindows(ticker, priceRows, options = {}) {
  const empty = {
    ticker: String(ticker ?? '').trim().toUpperCase() || null,
    gridCandidatesTotal: 0,
    gridCandidatesUsed: 0,
    bearishAnnualCandidatesTested: 0,
    bestBearishAnnualWindowsCount: 0,
    noStrongBearishAnnualWindow: true,
    rejectCounts: {},
    topRejectedBearishAnnualCandidates: [],
    avg5PositivePenalty: 0,
    gridTargetCoverage: [],
    bestRejectedCandidate: null,
    primaryRejectReasonSummary: null,
  };

  if (!priceRows?.length) return empty;

  const sym = String(ticker ?? '').trim().toUpperCase() || null;
  const index = options.index ?? buildPriceRowIndex(priceRows);
  if (!index) return empty;

  const pool = _buildBearishAnnualCandidatePool(index, options);
  const candidates = pool.candidates;
  const ctx = options.ctx ?? {
    index,
    annualBySig: new Map(),
    occurrenceByKey: new Map(),
    annualStatsCalls: 0,
    glidingStatsCalls: 0,
  };

  const gridAll = collectAnnualBearishGridCandidates(index, options);
  const gridTargetCoverage = BEARISH_GRID_TARGET_WINDOWS.map((target) => ({
    ...target,
    foundInGrid: _gridCoversTargetWindow(gridAll, target),
    matchingSignatures: gridAll
      .filter((c) => c.startMonth === target.startMonth && c.endMonth === target.endMonth)
      .slice(0, 3)
      .map((c) => ({
        sig: _windowSignature(c),
        displayLabel: buildSeasonalWindowDisplayFields(c).displayLabel,
        previewReturn: c.previewReturn,
      })),
  }));

  const rejectCounts = {};
  const bump = (key) => { rejectCounts[key] = (rejectCounts[key] ?? 0) + 1; };

  const evaluated = [];
  let avg5PositivePenalty = 0;

  for (const c of candidates) {
    const annualHorizons = _buildAnnualHorizonsFromCtx(c, ctx);
    const rejectReason = _primaryBearishRejectReason(annualHorizons);
    const s5 = annualHorizons?.['5y'];

    if (rejectReason) bump(rejectReason);
    else bump('accepted');

    if (s5 && !s5.insufficient && (s5.avgReturnAnnual ?? 0) > 0) {
      avg5PositivePenalty += 1;
    }

    const summary = _summarizeBearishCandidateForDiagnosis(c, annualHorizons, rejectReason);
    evaluated.push({ ...summary, score: _scoreAnnualBearishCandidateFast(c, ctx).score });
  }

  evaluated.sort((a, b) => {
    const bearishScore = (row) => {
      const parse = (s) => {
        if (!s || s === '—') return 0;
        const [n, d] = s.split('/').map(Number);
        return d > 0 ? n / d : 0;
      };
      let score = parse(row.annual15y) * 4 + parse(row.annual10y) * 2 + parse(row.annual5y);
      if (row.avgReturn15y != null && row.avgReturn15y < 0) score += 0.5;
      if (row.avgReturn5y != null && row.avgReturn5y < 0) score += 0.25;
      return score;
    };
    return bearishScore(b) - bearishScore(a);
  });

  const rejected = evaluated.filter((e) => e.rejectReason !== 'accepted');
  const topRejectedBearishAnnualCandidates = rejected.slice(0, options.topRejected ?? 10);
  const bestRejectedCandidate = rejected[0] ?? null;

  const result = findBestAnnualBearishWindows(sym, priceRows, {
    ...options,
    index,
    ctx,
    skipCache: true,
  });

  const primaryRejectReasonSummary = Object.entries(rejectCounts)
    .filter(([k]) => k !== 'accepted')
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    ticker: sym,
    gridCandidatesTotal: pool.gridCandidatesTotal,
    gridCandidatesUsed: pool.gridCandidatesUsed,
    bearishAnnualCandidatesTested: candidates.length,
    bestBearishAnnualWindowsCount: result.windows?.length ?? 0,
    noStrongBearishAnnualWindow: result.noStrongBearishAnnualWindow ?? true,
    strongBearishFound: result.strongBearishFound ?? 0,
    confirmedBearishFound: result.confirmedBearishFound ?? 0,
    rejectCounts,
    topRejectedBearishAnnualCandidates,
    avg5PositivePenalty,
    gridTargetCoverage,
    bestRejectedCandidate,
    primaryRejectReasonSummary,
    rowsCount: index.rowsCount,
    firstYear: index.firstYear,
    lastCompleteYear: index.lastCompleteYear,
  };
}

const RECENT_VIGILANCE_STATUS = 'Récente seulement';
const RECENT_VIGILANCE_MAX = 3;
const RECENT_VIGILANCE_OVERLAP_MAX = 0.45;

/** Raisons de rejet compatibles vigilance récente (10y/15y insuffisant, pas moyenne LT positive). */
const VIGILANCE_ELIGIBLE_REJECT_REASONS = new Set([
  '15y_lt_10_sur_15',
  '10y_lt_8_sur_10',
  'faible',
  'inDirection_lt_2_horizons',
  'autre',
]);

function _isRecentStrongBearishHorizons(annualHorizons) {
  const s3 = annualHorizons?.['3y'];
  const s5 = annualHorizons?.['5y'];
  const neg3 = s3 && !s3.insufficient
    && s3.yearsCount != null
    && (s3.negativeYears ?? 0) === s3.yearsCount;
  const neg5 = s5 && !s5.insufficient
    && s5.yearsCount != null
    && (s5.negativeYears ?? 0) === s5.yearsCount;
  return neg3 || neg5;
}

function _buildRecentBearishVigilanceEntry(window, rejectReason) {
  const display = buildSeasonalWindowDisplayFields({
    startMonth: window.startMonth,
    startWeekOfMonth: window.startWeekOfMonth,
    endMonth: window.endMonth,
    endWeekOfMonth: window.endWeekOfMonth,
    windowDays: window.windowDays,
    label: window.label,
  });
  const ah = window.annualHorizons ?? {};
  const s5 = ah['5y'];
  const s10 = ah['10y'];
  const s15 = ah['15y'];
  const avg5 = s5?.insufficient ? null : s5?.avgReturnAnnual ?? null;
  const avg15 = s15?.insufficient ? null : s15?.avgReturnAnnual ?? null;

  return {
    displayLabel: display.displayLabel ?? window.displayLabel ?? display.label,
    startLabel: display.startLabel ?? null,
    endLabel: display.endLabel ?? null,
    startMonth: window.startMonth,
    startDay: display.startDay ?? window.startDay ?? null,
    endMonth: window.endMonth,
    endDay: display.endDay ?? window.endDay ?? null,
    startWeekOfMonth: window.startWeekOfMonth,
    endWeekOfMonth: window.endWeekOfMonth,
    strength: window.strength ?? STRICT_STRENGTH_LABELS.NON_CONFIRMEE,
    status: RECENT_VIGILANCE_STATUS,
    rejectReason: rejectReason ?? 'autre',
    annualHorizons: ah,
    avgReturnAnnual: avg15 ?? avg5 ?? null,
    medianReturnAnnual: s15?.insufficient ? (s5?.medianReturnAnnual ?? null) : (s15?.medianReturnAnnual ?? null),
    avgReturnAnnual5y: avg5,
    bearishRateAnnual5y: s5?.insufficient ? null : s5?.bearishRateAnnual ?? null,
    bearishRateAnnual10y: s10?.insufficient ? null : s10?.bearishRateAnnual ?? null,
    bearishRateAnnual15y: s15?.insufficient ? null : s15?.bearishRateAnnual ?? null,
  };
}

function _vigilanceSortScore(entry) {
  const ah = entry.annualHorizons ?? {};
  const s5 = ah['5y'];
  const s3 = ah['3y'];
  let score = 0;
  if (s5 && !s5.insufficient && (s5.negativeYears ?? 0) === s5.yearsCount) score += 100;
  if (s3 && !s3.insufficient && (s3.negativeYears ?? 0) === s3.yearsCount) score += 50;
  if (entry.avgReturnAnnual5y != null && entry.avgReturnAnnual5y < 0) {
    score += Math.min(Math.abs(entry.avgReturnAnnual5y) * 200, 40);
  }
  if (entry.rejectReason === '15y_lt_10_sur_15') score += 10;
  return score;
}

/**
 * Sélectionne les fenêtres baissières récentes fortes mais non confirmées long terme.
 * Source : findBestAnnualBearishWindows().allScored — jamais fusionné dans bestBearishAnnualWindows.
 */
export function selectRecentBearishVigilanceWindows(allScored, confirmedWindows = [], options = {}) {
  const maxResults = options.maxResults ?? RECENT_VIGILANCE_MAX;
  const confirmedSigs = new Set(
    (confirmedWindows ?? []).map((w) => _windowSignature(w)).filter(Boolean),
  );

  const candidates = [];
  for (const w of allScored ?? []) {
    if (!w || isStrongOrConfirmedStrength(w.strength)) continue;
    if (
      w.strength !== STRICT_STRENGTH_LABELS.FAIBLE
      && w.strength !== STRICT_STRENGTH_LABELS.NON_CONFIRMEE
    ) continue;

    const calDays = _maskDayCount(w);
    if (calDays < MIN_CALENDAR_DAYS) continue;

    const ah = w.annualHorizons;
    if (!_isRecentStrongBearishHorizons(ah)) continue;

    const s5 = ah?.['5y'];
    if (s5 && !s5.insufficient && (s5.avgReturnAnnual ?? 0) >= 0) continue;

    const rejectReason = _primaryBearishRejectReason(ah);
    if (!rejectReason || rejectReason === 'accepted') continue;
    if (!VIGILANCE_ELIGIBLE_REJECT_REASONS.has(rejectReason)) continue;

    const sig = _windowSignature(w);
    if (sig && confirmedSigs.has(sig)) continue;

    candidates.push(_buildRecentBearishVigilanceEntry(w, rejectReason));
  }

  candidates.sort((a, b) => _vigilanceSortScore(b) - _vigilanceSortScore(a));

  const selected = [];
  for (const c of candidates) {
    if (selected.length >= maxResults) break;
    const overlaps = selected.some((s) => {
      const ov = _windowsOverlapFraction(
        {
          startMonth: c.startMonth,
          startWeekOfMonth: c.startWeekOfMonth,
          endMonth: c.endMonth,
          endWeekOfMonth: c.endWeekOfMonth,
        },
        {
          startMonth: s.startMonth,
          startWeekOfMonth: s.startWeekOfMonth,
          endMonth: s.endMonth,
          endWeekOfMonth: s.endWeekOfMonth,
        },
      );
      return ov >= RECENT_VIGILANCE_OVERLAP_MAX;
    });
    if (!overlaps) selected.push(c);
  }

  return selected;
}

export function clearBestAnnualCache() {
  _bestAnnualCache.clear();
  _bestBearishAnnualCache.clear();
  _bestBullishAnnualCache.clear();
  _maskDayCountCache.clear();
}

export function attachBestAnnualWindowToResult(result, rows, ticker, options = {}) {
  if (!result || !rows?.length) return result;

  const seed = result.swingWindows?.bullish?.[0]
    ?? result.summary?.bestOverallBullish
    ?? null;

  const index = buildPriceRowIndex(rows);
  const sharedCtx = index
    ? {
      index,
      annualBySig: new Map(),
      occurrenceByKey: new Map(),
      annualStatsCalls: 0,
      glidingStatsCalls: 0,
    }
    : null;

  const t0 = performance.now();
  const bestAnnual = findBestAnnualSeasonalityWindow(ticker, rows, {
    seedWindow: seed,
    horizons: result.horizons,
    candidates: _candidatesFromHorizons(result.horizons),
    totalWindowsMs: options.totalWindowsMs ?? null,
    skipCache: options.skipCache,
  });

  const swingWindows = result.swingWindows
    ? attachAnnualHorizonsToSwingWindows(result.swingWindows, rows, {
      bestAnnualWindow: bestAnnual,
      index: sharedCtx?.index,
      ctx: sharedCtx ?? undefined,
    })
    : result.swingWindows;

  const bearishAnnual = sharedCtx
    ? findBestAnnualBearishWindows(ticker, rows, {
      horizons: result.horizons,
      index: sharedCtx.index,
      ctx: sharedCtx,
      skipCache: options.skipCache,
    })
    : {
      windows: [],
      noStrongBearishAnnualWindow: true,
      allScored: [],
      bearishAnnualCandidatesTested: 0,
      gridCandidatesTotal: 0,
    };

  const bullishAnnual = sharedCtx
    ? findBestAnnualBullishWindows(ticker, rows, {
      horizons: result.horizons,
      index: sharedCtx.index,
      ctx: sharedCtx,
      skipCache: options.skipCache,
    })
    : {
      windows: [],
      noStrongBullishAnnualWindow: true,
      allScored: [],
      bullishAnnualCandidatesTested: 0,
      gridCandidatesTotal: 0,
    };

  const attachMs = Math.round(performance.now() - t0);

  if (_perfEnabled()) {
    _logPerf({
      ticker: String(ticker ?? '').trim().toUpperCase() || null,
      attachBestAnnualMs: attachMs,
      bearishAnnualCandidatesTested: bearishAnnual.bearishAnnualCandidatesTested ?? 0,
      bullishAnnualCandidatesTested: bullishAnnual.bullishAnnualCandidatesTested ?? 0,
      gridCandidatesTotal: bearishAnnual.gridCandidatesTotal ?? 0,
      strongBearishFound: bearishAnnual.strongBearishFound ?? 0,
      confirmedBearishFound: bearishAnnual.confirmedBearishFound ?? 0,
      strongBullishFound: bullishAnnual.strongBullishFound ?? 0,
      confirmedBullishFound: bullishAnnual.confirmedBullishFound ?? 0,
      annualStatsCalls: sharedCtx?.annualStatsCalls ?? null,
      cacheHit: false,
    });
  }

  const recentBearishVigilance = selectRecentBearishVigilanceWindows(
    bearishAnnual.allScored ?? [],
    bearishAnnual.windows ?? [],
  );

  const preAnnualDisplay = {
    bestBullishAnnualWindows: bullishAnnual.windows ?? [],
    bestBearishAnnualWindows: bearishAnnual.windows ?? [],
    recentBearishVigilance,
  };
  const annualDisplayWindows = collectOfficialAnnualDisplayWindows(preAnnualDisplay);

  const baseOut = {
    ...result,
    swingWindows,
    bestBearishAnnualWindows: bearishAnnual.windows ?? [],
    noStrongBearishAnnualWindow: bearishAnnual.noStrongBearishAnnualWindow ?? true,
    recentBearishVigilance,
    annualDisplayWindows,
    bearishAnnualMeta: {
      candidatesTested: bearishAnnual.bearishAnnualCandidatesTested ?? 0,
      gridCandidatesTotal: bearishAnnual.gridCandidatesTotal ?? 0,
      gridCandidatesUsed: bearishAnnual.gridCandidatesUsed ?? 0,
      strongFound: bearishAnnual.strongBearishFound ?? 0,
      confirmedFound: bearishAnnual.confirmedBearishFound ?? 0,
    },
    bestBullishAnnualWindows: bullishAnnual.windows ?? [],
    noStrongBullishAnnualWindow: bullishAnnual.noStrongBullishAnnualWindow ?? true,
    bullishAnnualMeta: {
      candidatesTested: bullishAnnual.bullishAnnualCandidatesTested ?? 0,
      gridCandidatesTotal: bullishAnnual.gridCandidatesTotal ?? 0,
      gridCandidatesUsed: bullishAnnual.gridCandidatesUsed ?? 0,
      strongFound: bullishAnnual.strongBullishFound ?? 0,
      confirmedFound: bullishAnnual.confirmedBullishFound ?? 0,
    },
  };

  if (!bestAnnual) {
    return swingWindows === result.swingWindows
      ? baseOut
      : baseOut;
  }

  return {
    ...baseOut,
    bestAnnualWindow: bestAnnual,
    summary: {
      ...result.summary,
      bestAnnualSeasonality: bestAnnual,
    },
  };
}
