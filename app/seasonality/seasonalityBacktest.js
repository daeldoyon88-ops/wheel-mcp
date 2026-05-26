/**
 * Backtest saisonnier — mesure si les signaux historiques auraient fonctionné sur une année cible.
 *
 * Anti-lookahead strict :
 *   Pour tester l'année N, les signaux sont construits uniquement avec les données des années < N.
 *   L'outcome réel est ensuite mesuré sur les données de l'année N.
 *
 * Réutilise fetchHistoryRows() du moteur principal (cache 6h partagé, zéro appel Yahoo dupliqué).
 * Réutilise buildSeasonalWindowDisplayFields() pour les libellés de dates lisibles.
 */

import { fetchHistoryRows } from './seasonalityEngine.js';
import { buildSeasonalWindowDisplayFields } from './seasonalityWindowDisplay.js';

// ─── Labels mois (français, cohérents avec seasonalityEngine) ────────────────
const MONTH_LABELS = [
  'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
  'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc',
];

// ─── Sources prédéfinies (lecture seule) ─────────────────────────────────────
export const TICKER_SOURCES = {
  'top20-wheel': [
    'AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'TSLA',
    'TQQQ', 'SOXL', 'PLTR', 'COIN', 'MSTR', 'SOFI', 'HOOD',
    'SPY', 'QQQ', 'IWM', 'GLD', 'SLV',
  ],
  'strict-watchlist': [
    'AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'SPY', 'QQQ',
  ],
  'fallback65': [
    'AAPL', 'MSFT', 'NVDA', 'AMD', 'META', 'AMZN', 'GOOGL', 'TSLA',
    'TQQQ', 'SOXL', 'PLTR', 'COIN', 'MSTR', 'SOFI', 'HOOD',
    'SPY', 'QQQ', 'IWM', 'GLD', 'SLV',
    'NFLX', 'DIS', 'BABA', 'BA', 'JPM', 'GS', 'XOM', 'CVX',
    'PFE', 'JNJ', 'WMT', 'COST', 'V', 'MA', 'PYPL',
    'UBER', 'SNAP', 'PINS', 'RBLX', 'RIVN',
    'NIO', 'F', 'GM', 'INTC', 'QCOM',
    'MU', 'AVGO', 'TXN', 'CRM', 'ORCL',
    'SHOP', 'SQ', 'GME', 'ARKK', 'XLE',
    'XLF', 'XLK', 'XLV', 'XLI', 'SPXL',
  ],
};

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_WINDOWS       = [20, 40, 60, 90];
const DEFAULT_MIN_SAMPLES   = 5;
const DEFAULT_BULLISH_WR    = 0.65;
const DEFAULT_BEARISH_WR    = 0.45;
const BACKTEST_CONCURRENCY  = 3;
const MIN_HIST_ROWS         = 50;
const DEFAULT_SIGNALS_LIMIT = 100;
const MAX_SIGNALS_LIMIT     = 500;
const DEFAULT_BEST_LIMIT    = 10;
const DEFAULT_WORST_LIMIT   = 10;

// ─── Utilitaires ──────────────────────────────────────────────────────────────
const _r4 = n => Math.round(n * 10_000) / 10_000;
const _r3 = n => Math.round(n * 1_000)  / 1_000;

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

// ─── Collecte des groupes historiques ────────────────────────────────────────
/**
 * Parcourt rows et regroupe les retours de fenêtres glissantes par clé saisonnière.
 * Chaque clé = startMonth-WstartWeek:endMonth-WendWeek:windowDays.
 * Utilisé uniquement sur les données historiques AVANT l'année cible.
 */
function _collectHistGroups(rows, windowDays) {
  const groups = new Map();

  for (let i = 0; i + windowDays < rows.length; i++) {
    const startRow = rows[i];
    const endRow   = rows[i + windowDays];
    if (!startRow || !endRow) continue;

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

function _computeGroupStats(g, minSamples) {
  const returns = g.returns;
  const n = returns.length;
  if (n < minSamples) return null;

  const avgReturn    = returns.reduce((s, r) => s + r, 0) / n;
  const medianReturn = _median(returns);
  const positiveCount = returns.filter(r => r > 0).length;
  const winRate      = positiveCount / n;
  const bestReturn   = Math.max(...returns);
  const worstReturn  = Math.min(...returns);

  return {
    sampleSize:     n,
    avgReturn:      _r4(avgReturn),
    medianReturn:   medianReturn != null ? _r4(medianReturn) : null,
    winRate:        _r3(winRate),
    bestReturn:     _r4(bestReturn),
    worstReturn:    _r4(worstReturn),
  };
}

// ─── Backtest pur (sans réseau) ───────────────────────────────────────────────
/**
 * Calcule les signaux saisonniers pour une année cible à partir de rows brutes.
 * Anti-lookahead garanti : les stats historiques n'utilisent que les rows < targetYear.
 *
 * @param {object[]} rows      Toutes les données historiques (triées ou non).
 * @param {number}   targetYear Année à backtester (ex. 2025).
 * @param {object}   [options]
 * @param {number[]} [options.windowDays]    Durées de fenêtre (défaut : [20,40,60,90]).
 * @param {number}   [options.minSamples]    Échantillon min (défaut : 5).
 * @param {number}   [options.bullishWinRate] Seuil haussier (défaut : 0.65).
 * @param {number}   [options.bearishWinRate] Seuil baissier (défaut : 0.45).
 * @returns {object[]|null} Tableau de signaux, ou null si données insuffisantes.
 */
export function computeBacktestForRows(rows, targetYear, options = {}) {
  if (!rows?.length || !targetYear) return null;

  const windowDaysList = options.windowDays     ?? DEFAULT_WINDOWS;
  const minSamples     = options.minSamples     ?? DEFAULT_MIN_SAMPLES;
  const bullishWinRate = options.bullishWinRate  ?? DEFAULT_BULLISH_WR;
  const bearishWinRate = options.bearishWinRate  ?? DEFAULT_BEARISH_WR;

  // Tri chronologique garanti
  const allSorted = [...rows].sort((a, b) => a.date - b.date);

  // Anti-lookahead : historique strictement avant l'année cible
  const histRows = allSorted.filter(r => r.date.getUTCFullYear() < targetYear);
  if (histRows.length < MIN_HIST_ROWS) return null;

  const signals = [];

  for (const windowDays of windowDaysList) {
    // Stats historiques calculées UNIQUEMENT sur les années antérieures
    const histGroups = _collectHistGroups(histRows, windowDays);

    // Une seule occurrence par clé saisonnière dans l'année cible (évite doublons)
    const seenKeys = new Set();

    for (let i = 0; i < allSorted.length; i++) {
      const startRow = allSorted[i];
      if (startRow.date.getUTCFullYear() !== targetYear) continue;

      const endIdx = i + windowDays;
      if (endIdx >= allSorted.length) continue;

      const endRow = allSorted[endIdx];
      if (!endRow) continue;

      const sc = startRow.close;
      const ec = endRow.close;
      if (!Number.isFinite(sc) || sc <= 0) continue;
      if (!Number.isFinite(ec) || ec <= 0) continue;

      const startMonth = startRow.date.getUTCMonth() + 1;
      const startWeek  = _weekOfMonth(startRow.date);
      const endMonth   = endRow.date.getUTCMonth() + 1;
      const endWeek    = _weekOfMonth(endRow.date);
      const key = `${startMonth}-W${startWeek}:${endMonth}-W${endWeek}:${windowDays}`;

      // Déduplication : un signal par pattern saisonnier et par taille de fenêtre
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const histGroup = histGroups.get(key);
      if (!histGroup) continue;

      const stats = _computeGroupStats(histGroup, minSamples);
      if (!stats) continue;

      // Détermination du signal
      let signalType = null;
      if (stats.winRate >= bullishWinRate && stats.avgReturn > 0) {
        signalType = 'bullish';
      } else if (stats.winRate <= bearishWinRate && stats.avgReturn < 0) {
        signalType = 'bearish';
      }
      if (!signalType) continue;

      // Retour réel dans l'année cible
      const actualReturn = _r4((ec - sc) / sc);
      const success = signalType === 'bullish' ? actualReturn > 0 : actualReturn < 0;

      // Libellés lisibles — réutilise seasonalityWindowDisplay.js
      const label = _windowLabel(startMonth, startWeek, endMonth, endWeek);
      const displayFields = buildSeasonalWindowDisplayFields({
        startMonth,
        startWeekOfMonth: startWeek,
        endMonth,
        endWeekOfMonth: endWeek,
        label,
        windowDays,
        referenceYear: targetYear,
      });

      signals.push({
        year:                   targetYear,
        signalType,
        success,
        actualReturn,
        expectedReturn:         stats.avgReturn,
        historicalAvgReturn:    stats.avgReturn,
        historicalMedianReturn: stats.medianReturn,
        historicalWinRate:      stats.winRate,
        historicalWorstReturn:  stats.worstReturn,
        historicalBestReturn:   stats.bestReturn,
        sampleSize:             stats.sampleSize,
        label,
        displayLabel:           displayFields.displayLabel,
        displayLabelWithYear:   displayFields.displayLabelWithYear,
        startDate:              displayFields.startDateCurrentYear,
        endDate:                displayFields.endDateCurrentYear,
        windowDays,
      });
    }
  }

  return signals;
}

// ─── Résumé par ticker ────────────────────────────────────────────────────────
function _computeTickerSummary(ticker, year, signals) {
  const totalSignals = signals.length;

  if (totalSignals === 0) {
    return {
      ticker, year,
      totalSignals: 0, successfulSignals: 0, failedSignals: 0, successRate: 0,
      bullishSignals: 0, bullishSuccessfulSignals: 0, bullishSuccessRate: 0,
      bearishSignals: 0, bearishSuccessfulSignals: 0, bearishSuccessRate: 0,
      avgActualReturn: 0, avgExpectedReturn: 0,
      bestActualSignal: null, worstActualSignal: null,
      verdict: 'Insuffisant',
    };
  }

  const successfulSignals = signals.filter(s => s.success).length;
  const failedSignals     = totalSignals - successfulSignals;
  const successRate       = _r3(successfulSignals / totalSignals);

  const bullish  = signals.filter(s => s.signalType === 'bullish');
  const bearish  = signals.filter(s => s.signalType === 'bearish');
  const bullN    = bullish.length;
  const bullOK   = bullish.filter(s => s.success).length;
  const bearN    = bearish.length;
  const bearOK   = bearish.filter(s => s.success).length;

  const avgActualReturn   = _r4(signals.reduce((s, sig) => s + sig.actualReturn, 0)          / totalSignals);
  const avgExpectedReturn = _r4(signals.reduce((s, sig) => s + sig.historicalAvgReturn, 0)   / totalSignals);

  const sorted            = [...signals].sort((a, b) => b.actualReturn - a.actualReturn);
  const bestActualSignal  = sorted[0] ?? null;
  const worstActualSignal = sorted[sorted.length - 1] ?? null;

  let verdict;
  if (totalSignals < 5)                               verdict = 'Insuffisant';
  else if (successRate >= 0.70 && totalSignals >= 10) verdict = 'Excellent';
  else if (successRate >= 0.60 && totalSignals >= 8)  verdict = 'Bon';
  else if (successRate >= 0.50)                       verdict = 'Moyen';
  else                                                verdict = 'Faible';

  return {
    ticker, year,
    totalSignals, successfulSignals, failedSignals, successRate,
    bullishSignals:           bullN,
    bullishSuccessfulSignals: bullOK,
    bullishSuccessRate:       bullN > 0 ? _r3(bullOK / bullN) : 0,
    bearishSignals:           bearN,
    bearishSuccessfulSignals: bearOK,
    bearishSuccessRate:       bearN > 0 ? _r3(bearOK / bearN) : 0,
    avgActualReturn, avgExpectedReturn,
    bestActualSignal, worstActualSignal, verdict,
  };
}

// ─── Résumé signal (UI / globalSummary) ───────────────────────────────────────
export function toBacktestSignalSummary(signal) {
  if (!signal) return null;
  return {
    ticker:               signal.ticker,
    signalType:           signal.signalType,
    success:              signal.success,
    displayLabelWithYear: signal.displayLabelWithYear,
    actualReturn:         signal.actualReturn,
    expectedReturn:       signal.expectedReturn,
    historicalWinRate:    signal.historicalWinRate,
    sampleSize:           signal.sampleSize,
    windowDays:           signal.windowDays,
  };
}

// ─── Paramètres de sortie HTTP ────────────────────────────────────────────────
export function parseTruthyQuery(val) {
  if (val === undefined || val === null || val === '') return false;
  const s = String(val).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

export function parseBacktestOutputOptions(query = {}) {
  const includeSignals = parseTruthyQuery(query.includeSignals);
  const signalsLimitRaw = parseInt(String(query.signalsLimit ?? DEFAULT_SIGNALS_LIMIT), 10);
  const signalsLimit = Number.isFinite(signalsLimitRaw)
    ? Math.min(MAX_SIGNALS_LIMIT, Math.max(1, signalsLimitRaw))
    : DEFAULT_SIGNALS_LIMIT;
  const bestLimitRaw  = parseInt(String(query.bestLimit  ?? DEFAULT_BEST_LIMIT), 10);
  const worstLimitRaw = parseInt(String(query.worstLimit ?? DEFAULT_WORST_LIMIT), 10);
  const bestLimit  = Number.isFinite(bestLimitRaw)  && bestLimitRaw  > 0 ? bestLimitRaw  : DEFAULT_BEST_LIMIT;
  const worstLimit = Number.isFinite(worstLimitRaw) && worstLimitRaw > 0 ? worstLimitRaw : DEFAULT_WORST_LIMIT;

  return { includeSignals, signalsLimit, bestLimit, worstLimit };
}

/**
 * Résout tickers ou source prédéfinie (pour route + tests).
 */
export function resolveBacktestTickerList({ tickersRaw = '', sourceRaw = '' } = {}) {
  const tickersStr = String(tickersRaw ?? '').trim();
  const sourceStr  = String(sourceRaw  ?? '').trim();

  if (tickersStr) {
    const tickers = tickersStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    return { ok: true, tickers, source: 'tickers' };
  }

  if (sourceStr) {
    const sourceTickers = TICKER_SOURCES[sourceStr];
    if (!sourceTickers) {
      return {
        ok: false,
        error: `Source inconnue: "${sourceStr}". Sources disponibles : ${Object.keys(TICKER_SOURCES).join(', ')}.`,
      };
    }
    return { ok: true, tickers: [...sourceTickers], source: sourceStr };
  }

  return { ok: false, error: 'Paramètre tickers ou source requis.' };
}

/**
 * Corps JSON GET /seasonality/backtest — mode résumé par défaut (sans signals).
 */
export function buildBacktestApiResponse({
  year,
  source,
  parameters,
  result,
  outputOptions,
}) {
  const opts = outputOptions ?? parseBacktestOutputOptions({});
  const totalSignalsAvailable = result.allSignals.length;

  const payload = {
    ok: true,
    year,
    source,
    parameters,
    globalSummary: result.globalSummary,
    byTicker:      result.byTicker,
    warnings:      result.warnings ?? [],
    signalsReturned: 0,
    totalSignalsAvailable,
  };

  if (opts.includeSignals) {
    const limited = result.allSignals.slice(0, opts.signalsLimit);
    payload.signals = limited;
    payload.signalsReturned = limited.length;
  }

  return payload;
}

// ─── Résumé global ────────────────────────────────────────────────────────────
function _computeGlobalSummary(year, tickers, byTicker, allSignals, parametersUsed, limits = {}) {
  const bestLimit  = limits.bestLimit  ?? DEFAULT_BEST_LIMIT;
  const worstLimit = limits.worstLimit ?? DEFAULT_WORST_LIMIT;

  const tickersAnalyzed   = byTicker.filter(t => t.totalSignals > 0).length;
  const totalSignals      = allSignals.length;
  const successfulSignals = allSignals.filter(s => s.success).length;
  const failedSignals     = totalSignals - successfulSignals;
  const successRate       = totalSignals > 0 ? _r3(successfulSignals / totalSignals) : 0;

  const eligible = [...byTicker].filter(t => t.totalSignals >= 5);
  eligible.sort((a, b) => b.successRate - a.successRate);

  const bestTickers  = eligible.slice(0, 3).map(t => ({ ticker: t.ticker, successRate: t.successRate, totalSignals: t.totalSignals }));
  const worstTickers = eligible.slice(-3).reverse().map(t => ({ ticker: t.ticker, successRate: t.successRate, totalSignals: t.totalSignals }));

  const bestSignals = allSignals
    .filter(s => s.success === true)
    .sort((a, b) => b.actualReturn - a.actualReturn)
    .slice(0, bestLimit)
    .map(toBacktestSignalSummary);

  const worstSignals = allSignals
    .filter(s => s.success === false)
    .sort((a, b) => a.actualReturn - b.actualReturn)
    .slice(0, worstLimit)
    .map(toBacktestSignalSummary);

  return {
    year,
    tickersRequested: tickers.length,
    tickersAnalyzed,
    totalSignals,
    successfulSignals,
    failedSignals,
    successRate,
    bestTickers,
    worstTickers,
    bestSignals,
    worstSignals,
    parametersUsed,
  };
}

// ─── API principale (avec réseau) ─────────────────────────────────────────────
/**
 * Backtest saisonnier pour une liste de tickers sur une année cible.
 *
 * @param {object}   params
 * @param {number}   params.year
 * @param {string[]} params.tickers
 * @param {number[]} [params.windowDays]
 * @param {number}   [params.minSamples]
 * @param {number}   [params.bullishWinRate]
 * @param {number}   [params.bearishWinRate]
 * @returns {Promise<{byTicker, allSignals, globalSummary, warnings}>}
 */
export async function computeSeasonalityBacktest(params) {
  const {
    year,
    tickers,
    windowDays    = DEFAULT_WINDOWS,
    minSamples    = DEFAULT_MIN_SAMPLES,
    bullishWinRate = DEFAULT_BULLISH_WR,
    bearishWinRate = DEFAULT_BEARISH_WR,
    bestLimit     = DEFAULT_BEST_LIMIT,
    worstLimit    = DEFAULT_WORST_LIMIT,
  } = params;

  const opts     = { windowDays, minSamples, bullishWinRate, bearishWinRate };
  const warnings = [];
  const byTicker = [];
  const allSignals = [];

  // Traitement par lots avec concurrence bornée (même pattern que computeSeasonalityScanSummary)
  for (let i = 0; i < tickers.length; i += BACKTEST_CONCURRENCY) {
    const batch   = tickers.slice(i, i + BACKTEST_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (ticker) => {
        try {
          const rows = await fetchHistoryRows(ticker);
          if (!rows?.length) {
            return { ticker, signals: [], warn: `${ticker}: historique indisponible` };
          }
          const signals = computeBacktestForRows(rows, year, opts);
          if (!signals) {
            return { ticker, signals: [], warn: `${ticker}: historique insuffisant avant ${year}` };
          }
          return { ticker, signals };
        } catch (err) {
          return { ticker, signals: [], warn: `${ticker}: erreur — ${err?.message ?? String(err)}` };
        }
      }),
    );

    for (let j = 0; j < batch.length; j++) {
      const ticker = batch[j];
      const result = settled[j].status === 'fulfilled'
        ? settled[j].value
        : { ticker, signals: [], warn: `${ticker}: promesse rejetée` };

      if (result.warn) warnings.push(result.warn);

      const tickerSignals = (result.signals ?? []).map(s => ({ ticker, ...s }));
      allSignals.push(...tickerSignals);

      const summary = _computeTickerSummary(ticker, year, tickerSignals);
      if (summary.totalSignals === 0 && !result.warn) {
        warnings.push(`${ticker}: aucun signal déclenché pour ${year}`);
      }
      byTicker.push(summary);
    }
  }

  const globalSummary = _computeGlobalSummary(
    year, tickers, byTicker, allSignals,
    { windowDays, minSamples, bullishWinRate, bearishWinRate },
    { bestLimit, worstLimit },
  );

  return { byTicker, allSignals, globalSummary, warnings };
}
