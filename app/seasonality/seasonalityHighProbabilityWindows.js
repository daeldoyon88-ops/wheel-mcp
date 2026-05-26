/**
 * Fenêtres saisonnières swing à haute probabilité (5–16 semaines).
 * Lecture seule — réutilise fetchHistoryRows + buildSeasonalWindowDisplayFields.
 */

import { fetchHistoryRows } from './seasonalityEngine.js';
import { buildSeasonalWindowDisplayFields } from './seasonalityWindowDisplay.js';
import {
  resolveBacktestTickerList,
  parseTruthyQuery,
  TICKER_SOURCES,
} from './seasonalityBacktest.js';

// ─── Labels mois ─────────────────────────────────────────────────────────────
const MONTH_LABELS = [
  'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
  'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc',
];

// ─── Defaults ────────────────────────────────────────────────────────────────
export const DEFAULT_MIN_WEEKS           = 5;
export const DEFAULT_MAX_WEEKS           = 16;
export const DEFAULT_STEP_DAYS           = 5;
export const DEFAULT_MIN_WIN_RATE        = 0.9;
export const DEFAULT_MIN_AVG_RETURN      = 0.10;
export const DEFAULT_MIN_MEDIAN_RETURN   = 0.05;
export const DEFAULT_MIN_SAMPLES         = 8;
export const DEFAULT_MAX_RESULTS_PER_TICKER = 10;
export const DEFAULT_DIRECTION           = 'both';
export const TRADING_DAYS_PER_WEEK       = 5;
export const HPW_CONCURRENCY             = 3;

const _r4 = n => Math.round(n * 10_000) / 10_000;
const _r3 = n => Math.round(n * 1_000)  / 1_000;
const _r2 = n => Math.round(n * 100)    / 100;

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function _weekOfMonth(date) {
  const d = date.getUTCDate();
  if (d <= 7)  return 1;
  if (d <= 14) return 2;
  if (d <= 21) return 3;
  if (d <= 28) return 4;
  return 5;
}

function _median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _windowLabel(startMonth, startWeek, endMonth, endWeek) {
  return `${MONTH_LABELS[startMonth - 1]} W${startWeek} → ${MONTH_LABELS[endMonth - 1]} W${endWeek}`;
}

/**
 * Génère les durées en jours de bourse pour une plage de semaines.
 * 5 semaines ≈ 25 jours, stepDays=5 → 25,30,…,80.
 */
export function buildSwingDurationDays(minWeeks, maxWeeks, stepDays) {
  const minDays = minWeeks * TRADING_DAYS_PER_WEEK;
  const maxDays = maxWeeks * TRADING_DAYS_PER_WEEK;
  const step    = Math.max(1, stepDays);
  const out     = [];
  for (let d = minDays; d <= maxDays; d += step) out.push(d);
  return out;
}

function _collectSeasonalWindowGroups(rows, windowDays) {
  const groups = new Map();
  const today  = new Date();
  today.setUTCHours(23, 59, 59, 999);

  for (let i = 0; i + windowDays < rows.length; i++) {
    const startRow = rows[i];
    const endRow   = rows[i + windowDays];
    if (!startRow || !endRow) continue;
    if (endRow.date > today) continue;

    const sc = startRow.close;
    const ec = endRow.close;
    if (!Number.isFinite(sc) || sc <= 0) continue;
    if (!Number.isFinite(ec) || ec <= 0) continue;

    const ret = (ec - sc) / sc;

    const startMonth = startRow.date.getUTCMonth() + 1;
    const startWeek  = _weekOfMonth(startRow.date);
    const endMonth   = endRow.date.getUTCMonth() + 1;
    const endWeek    = _weekOfMonth(endRow.date);
    const key = `${startMonth}-W${startWeek}:${endMonth}-W${endWeek}:${windowDays}`;

    if (!groups.has(key)) {
      groups.set(key, {
        startMonth,
        startWeekOfMonth: startWeek,
        endMonth,
        endWeekOfMonth: endWeek,
        returns: [],
      });
    }
    groups.get(key).returns.push(ret);
  }

  return groups;
}

function _computeGroupStats(g) {
  const returns = g.returns;
  const n       = returns.length;
  if (n === 0) return null;

  const avgReturn     = returns.reduce((s, r) => s + r, 0) / n;
  const medianReturn  = _median(returns);
  const positiveCount = returns.filter(r => r > 0).length;
  const negativeCount = returns.filter(r => r < 0).length;
  const bullishWinRate = positiveCount / n;
  const bearishWinRate = negativeCount / n;
  const bestReturn    = Math.max(...returns);
  const worstReturn   = Math.min(...returns);

  return {
    sampleSize:      n,
    avgReturn:       _r4(avgReturn),
    medianReturn:    medianReturn != null ? _r4(medianReturn) : null,
    bullishWinRate:  _r3(bullishWinRate),
    bearishWinRate:  _r3(bearishWinRate),
    positiveCount,
    negativeCount,
    bestReturn:      _r4(bestReturn),
    worstReturn:     _r4(worstReturn),
  };
}

export function qualifiesBullishWindow(stats, params) {
  return (
    stats.bullishWinRate >= params.minWinRate &&
    stats.avgReturn      >= params.minAvgReturn &&
    stats.medianReturn   >= params.minMedianReturn &&
    stats.sampleSize     >= params.minSamples
  );
}

export function qualifiesBearishWindow(stats, params) {
  return (
    stats.bearishWinRate >= params.minWinRate &&
    stats.avgReturn      <= -params.minAvgReturn &&
    stats.medianReturn   <= -params.minMedianReturn &&
    stats.sampleSize     >= params.minSamples
  );
}

/**
 * Score déterministe pour classement.
 * Bullish : bonus rendements + échantillon, pénalité worstReturn négatif.
 * Bearish : bonus rendements abs + échantillon, pénalité bestReturn positif.
 */
export function computeWindowScore(stats, direction) {
  const wr = direction === 'bullish' ? stats.bullishWinRate : stats.bearishWinRate;
  const avgBonus    = Math.abs(stats.avgReturn) * 0.5;
  const medianBonus = Math.abs(stats.medianReturn ?? 0) * 0.3;
  const sampleBonus = Math.min(stats.sampleSize / 20, 0.5);

  let penalty = 0;
  if (direction === 'bullish') {
    penalty = Math.max(0, -stats.worstReturn) * 0.3;
  } else {
    penalty = Math.max(0, stats.bestReturn) * 0.3;
  }

  return _r2(wr + avgBonus + medianBonus + sampleBonus - penalty);
}

export function computeBullishVerdict(stats) {
  if (stats.sampleSize < 8) return 'Préliminaire';
  if (stats.bullishWinRate >= 0.95 && stats.avgReturn >= 0.10) return 'Elite swing';
  if (stats.bullishWinRate >= 0.90 && stats.avgReturn >= 0.10) return 'Très fort';
  if (stats.bullishWinRate >= 0.85 && stats.avgReturn >= 0.07) return 'Bon';
  return 'Préliminaire';
}

export function computeBearishVerdict(stats) {
  if (stats.sampleSize < 8) return 'Préliminaire';
  if (stats.bearishWinRate >= 0.90 && stats.avgReturn <= -0.10) return 'Danger élevé';
  if (stats.bearishWinRate >= 0.80 && stats.avgReturn <= -0.07) return 'Danger moyen';
  return 'Préliminaire';
}

function _sortWindows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.winRate !== a.winRate) return b.winRate - a.winRate;
  const absA = Math.abs(a.avgReturn);
  const absB = Math.abs(b.avgReturn);
  if (absB !== absA) return absB - absA;
  return b.sampleSize - a.sampleSize;
}

function _buildWindowRecord(ticker, direction, g, stats, windowDays, referenceYear) {
  const label = _windowLabel(g.startMonth, g.startWeekOfMonth, g.endMonth, g.endWeekOfMonth);
  const displayFields = buildSeasonalWindowDisplayFields({
    startMonth:       g.startMonth,
    startWeekOfMonth: g.startWeekOfMonth,
    endMonth:         g.endMonth,
    endWeekOfMonth:   g.endWeekOfMonth,
    label,
    windowDays,
    referenceYear,
  });

  const winRate = direction === 'bullish' ? stats.bullishWinRate : stats.bearishWinRate;
  const score   = computeWindowScore(stats, direction);
  const verdict = direction === 'bullish'
    ? computeBullishVerdict(stats)
    : computeBearishVerdict(stats);

  return {
    ticker,
    direction,
    label,
    displayLabel:           displayFields.displayLabel,
    displayLabelWithYear:   displayFields.displayLabelWithYear,
    durationDays:           windowDays,
    approxWeeks:            Math.round(windowDays / TRADING_DAYS_PER_WEEK),
    sampleSize:             stats.sampleSize,
    winRate,
    bullishWinRate:         stats.bullishWinRate,
    bearishWinRate:         stats.bearishWinRate,
    avgReturn:              stats.avgReturn,
    medianReturn:           stats.medianReturn,
    worstReturn:            stats.worstReturn,
    bestReturn:             stats.bestReturn,
    positiveCount:          stats.positiveCount,
    negativeCount:          stats.negativeCount,
    score,
    verdict,
  };
}

/**
 * Calcule les fenêtres swing à haute probabilité à partir de rows brutes (sans réseau).
 */
export function computeHighProbabilityWindowsFromRows(rows, options = {}) {
  if (!rows?.length) return { bullish: [], bearish: [], all: [] };

  const params = {
    durationDays: options.durationDays ?? buildSwingDurationDays(
      options.minWeeks ?? DEFAULT_MIN_WEEKS,
      options.maxWeeks ?? DEFAULT_MAX_WEEKS,
      options.stepDays ?? DEFAULT_STEP_DAYS,
    ),
    minWinRate:      options.minWinRate      ?? DEFAULT_MIN_WIN_RATE,
    minAvgReturn:    options.minAvgReturn    ?? DEFAULT_MIN_AVG_RETURN,
    minMedianReturn: options.minMedianReturn ?? DEFAULT_MIN_MEDIAN_RETURN,
    minSamples:      options.minSamples      ?? DEFAULT_MIN_SAMPLES,
    direction:       options.direction       ?? DEFAULT_DIRECTION,
    includeAll:      options.includeAll      ?? false,
  };

  const sorted = [...rows].sort((a, b) => a.date - b.date);
  const refYear = new Date().getUTCFullYear();
  const bullish = [];
  const bearish = [];
  const all     = [];

  for (const windowDays of params.durationDays) {
    const groups = _collectSeasonalWindowGroups(sorted, windowDays);

    for (const g of groups.values()) {
      const stats = _computeGroupStats(g);
      if (!stats) continue;
      if (stats.sampleSize < params.minSamples && !params.includeAll) continue;

      const isBull = qualifiesBullishWindow(stats, params);
      const isBear = qualifiesBearishWindow(stats, params);

      const wantBull = params.direction === 'bullish' || params.direction === 'both';
      const wantBear = params.direction === 'bearish' || params.direction === 'both';

      if (params.includeAll || isBull || isBear) {
        if (wantBull && (params.includeAll || isBull)) {
          bullish.push(_buildWindowRecord('SYN', 'bullish', g, stats, windowDays, refYear));
        }
        if (wantBear && (params.includeAll || isBear)) {
          bearish.push(_buildWindowRecord('SYN', 'bearish', g, stats, windowDays, refYear));
        }
        all.push({ stats, g, windowDays, isBull, isBear });
      }
    }
  }

  bullish.sort(_sortWindows);
  bearish.sort(_sortWindows);

  return { bullish, bearish, all, params };
}

function _limitPerTicker(windows, maxResults) {
  const counts = new Map();
  const out    = [];
  for (const w of windows) {
    const n = counts.get(w.ticker) ?? 0;
    if (n >= maxResults) continue;
    counts.set(w.ticker, n + 1);
    out.push(w);
  }
  return out;
}

/**
 * Parse les paramètres de requête HTTP.
 */
export function parseHighProbabilityWindowsParams(query = {}) {
  const minWeeks  = Math.max(1, parseInt(query.minWeeks  ?? String(DEFAULT_MIN_WEEKS),  10) || DEFAULT_MIN_WEEKS);
  const maxWeeks  = Math.max(minWeeks, parseInt(query.maxWeeks ?? String(DEFAULT_MAX_WEEKS), 10) || DEFAULT_MAX_WEEKS);
  const stepDays  = Math.max(1, parseInt(query.stepDays  ?? String(DEFAULT_STEP_DAYS),  10) || DEFAULT_STEP_DAYS);

  const minWinRate      = Math.min(1, Math.max(0, parseFloat(query.minWinRate      ?? String(DEFAULT_MIN_WIN_RATE))      || DEFAULT_MIN_WIN_RATE));
  const minAvgReturn    = Math.max(0, parseFloat(query.minAvgReturn    ?? String(DEFAULT_MIN_AVG_RETURN))    || DEFAULT_MIN_AVG_RETURN);
  const minMedianReturn = Math.max(0, parseFloat(query.minMedianReturn ?? String(DEFAULT_MIN_MEDIAN_RETURN)) || DEFAULT_MIN_MEDIAN_RETURN);
  const minSamples      = Math.max(1, parseInt(query.minSamples ?? String(DEFAULT_MIN_SAMPLES), 10) || DEFAULT_MIN_SAMPLES);

  const maxResultsRaw = parseInt(query.maxResultsPerTicker ?? String(DEFAULT_MAX_RESULTS_PER_TICKER), 10);
  const maxResultsPerTicker = Number.isFinite(maxResultsRaw) && maxResultsRaw > 0
    ? maxResultsRaw
    : DEFAULT_MAX_RESULTS_PER_TICKER;

  const directionRaw = String(query.direction ?? DEFAULT_DIRECTION).trim().toLowerCase();
  const direction = ['bullish', 'bearish', 'both'].includes(directionRaw)
    ? directionRaw
    : DEFAULT_DIRECTION;

  const includeAll = parseTruthyQuery(query.includeAll);

  const durationDays = buildSwingDurationDays(minWeeks, maxWeeks, stepDays);

  return {
    minWeeks,
    maxWeeks,
    stepDays,
    durationDays,
    minWinRate,
    minAvgReturn,
    minMedianReturn,
    minSamples,
    maxResultsPerTicker,
    direction,
    includeAll,
  };
}

/**
 * Corps JSON GET /seasonality/high-probability-windows.
 */
export function buildHighProbabilityWindowsApiResponse({
  source,
  parameters,
  byTicker,
  topBullishWindows,
  topBearishWindows,
  warnings,
  tickersRequested,
  tickersAnalyzed,
}) {
  const totalBullish = byTicker.reduce((s, t) => s + t.bullishWindows, 0);
  const totalBearish = byTicker.reduce((s, t) => s + t.bearishWindows, 0);

  return {
    ok: true,
    source,
    parameters: {
      minWeeks:         parameters.minWeeks,
      maxWeeks:         parameters.maxWeeks,
      durationsDays:    parameters.durationDays,
      minWinRate:       parameters.minWinRate,
      minAvgReturn:     parameters.minAvgReturn,
      minMedianReturn:  parameters.minMedianReturn,
      minSamples:       parameters.minSamples,
      maxResultsPerTicker: parameters.maxResultsPerTicker,
      direction:        parameters.direction,
      includeAll:       parameters.includeAll,
    },
    summary: {
      tickersRequested,
      tickersAnalyzed,
      totalQualifiedWindows: totalBullish + totalBearish,
      totalBullishWindows:   totalBullish,
      totalBearishWindows:   totalBearish,
    },
    byTicker,
    topBullishWindows,
    topBearishWindows,
    warnings: warnings ?? [],
  };
}

/**
 * API principale — charge l'historique et calcule les fenêtres par ticker.
 */
export async function computeSeasonalityHighProbabilityWindows({
  tickers,
  parameters,
}) {
  const warnings = [];
  const byTicker = [];
  const allBullish = [];
  const allBearish = [];
  let tickersAnalyzed = 0;

  const opts = {
    durationDays:    parameters.durationDays,
    minWinRate:      parameters.minWinRate,
    minAvgReturn:    parameters.minAvgReturn,
    minMedianReturn: parameters.minMedianReturn,
    minSamples:      parameters.minSamples,
    direction:       parameters.direction,
    includeAll:      parameters.includeAll,
  };

  for (let i = 0; i < tickers.length; i += HPW_CONCURRENCY) {
    const batch   = tickers.slice(i, i + HPW_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (ticker) => {
        try {
          const rows = await fetchHistoryRows(ticker);
          if (!rows?.length) {
            return { ticker, bullish: [], bearish: [], warn: `${ticker}: historique indisponible` };
          }

          const sorted = [...rows].sort((a, b) => a.date - b.date);
          const refYear = new Date().getUTCFullYear();
          const bullish = [];
          const bearish = [];

          for (const windowDays of opts.durationDays) {
            const groups = _collectSeasonalWindowGroups(sorted, windowDays);

            for (const g of groups.values()) {
              const stats = _computeGroupStats(g);
              if (!stats) continue;
              if (stats.sampleSize < opts.minSamples && !opts.includeAll) continue;

              const isBull = qualifiesBullishWindow(stats, opts);
              const isBear = qualifiesBearishWindow(stats, opts);

              const wantBull = opts.direction === 'bullish' || opts.direction === 'both';
              const wantBear = opts.direction === 'bearish' || opts.direction === 'both';

              if (wantBull && (opts.includeAll || isBull)) {
                bullish.push(_buildWindowRecord(ticker, 'bullish', g, stats, windowDays, refYear));
              }
              if (wantBear && (opts.includeAll || isBear)) {
                bearish.push(_buildWindowRecord(ticker, 'bearish', g, stats, windowDays, refYear));
              }
            }
          }

          bullish.sort(_sortWindows);
          bearish.sort(_sortWindows);

          return { ticker, bullish, bearish };
        } catch (err) {
          return { ticker, bullish: [], bearish: [], warn: `${ticker}: erreur — ${err?.message ?? String(err)}` };
        }
      }),
    );

    for (let j = 0; j < batch.length; j++) {
      const ticker = batch[j];
      const result = settled[j].status === 'fulfilled'
        ? settled[j].value
        : { ticker, bullish: [], bearish: [], warn: `${ticker}: promesse rejetée` };

      if (result.warn) warnings.push(result.warn);

      const limitedBull = _limitPerTicker(result.bullish, parameters.maxResultsPerTicker);
      const limitedBear = _limitPerTicker(result.bearish, parameters.maxResultsPerTicker);

      if (limitedBull.length || limitedBear.length) tickersAnalyzed++;

      byTicker.push({
        ticker,
        qualifiedWindows: limitedBull.length + limitedBear.length,
        bullishWindows:   limitedBull.length,
        bearishWindows:   limitedBear.length,
        bestBullishWindows: limitedBull,
        bestBearishWindows: limitedBear,
      });

      allBullish.push(...limitedBull);
      allBearish.push(...limitedBear);
    }
  }

  allBullish.sort(_sortWindows);
  allBearish.sort(_sortWindows);

  return {
    byTicker,
    topBullishWindows: allBullish,
    topBearishWindows: allBearish,
    warnings,
    tickersAnalyzed,
  };
}

export { resolveBacktestTickerList, TICKER_SOURCES };
