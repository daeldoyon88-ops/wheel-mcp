/**
 * Seasonality Engine V1
 *
 * Read-only, fully isolated module.
 * - Separate Yahoo Finance client (no shared state with main provider)
 * - Separate in-memory cache (no impact on scanner cache/metrics)
 * - Returns null on any failure — scanner continues normally
 * - No DB writes, no impact on EliteScore, IBKR, or ranking
 */

import YahooFinance from "yahoo-finance2";

// ─── Configuration ─────────────────────────────────────────────────────────────
const WINDOW_SIZES_WEEKS   = [2, 4, 8, 12, 16];
const HORIZONS             = { "3Y": 3, "5Y": 5, "10Y": 10, "15Y": 15 };
const HORIZON_WEIGHTS      = { "3Y": 0.20, "5Y": 0.35, "10Y": 0.30, "15Y": 0.15 };
const HISTORY_FETCH_YEARS  = 15;                            // always fetch max, slice per horizon
const HISTORY_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;         // 6 h — historical data is daily
const RESULT_CACHE_TTL_MS  = 4 * 60 * 60 * 1_000;         // 4 h
const MIN_SAMPLE_SIZE      = 3;                             // min occurrences per window
const SCORE_NORMALIZER     = 0.05;                         // 5 % return → max raw score
const BIAS_THRESHOLD       = 0.25;                         // |score| threshold for bias label
const CONCURRENCY_LIMIT    = 3;                            // parallel fetches for scan-summary

// ─── Isolated in-memory caches ─────────────────────────────────────────────────
const _histCache   = new Map();   // raw daily price rows
const _resultCache = new Map();   // computed seasonality results
const _inFlight    = new Map();   // dedup concurrent requests

// ─── Lazy isolated Yahoo client ────────────────────────────────────────────────
let _client = null;
function _getClient() {
  if (!_client) _client = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  return _client;
}

// ─── Cache primitives ──────────────────────────────────────────────────────────
function _getCached(map, key) {
  const e = map.get(key);
  if (!e) return undefined;
  if (Date.now() >= e.expiresAt) { map.delete(key); return undefined; }
  return e.value;
}

function _setCached(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Deduplicates concurrent calls for the same key and caches the result. */
async function _getOrFetch(map, key, ttlMs, fetcher) {
  const cached = _getCached(map, key);
  if (cached !== undefined) return cached;

  const flying = _inFlight.get(key);
  if (flying) return flying;

  const promise = (async () => {
    try {
      const value = await fetcher();
      _setCached(map, key, value, ttlMs);
      return value;
    } finally {
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, promise);
  return promise;
}

// ─── ISO week utilities (ISO 8601) ─────────────────────────────────────────────
/**
 * Returns { week: 1–53, year: ISO week-year }.
 * ISO 8601: week 1 contains Jan 4th; weeks start Monday.
 * The ISO week-year can differ from the calendar year in early Jan / late Dec.
 */
function _isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;        // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to nearest Thursday
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return {
    week: Math.ceil(((d - jan1) / 86_400_000 + 1) / 7),
    year: d.getUTCFullYear(),
  };
}

// ─── Historical data ───────────────────────────────────────────────────────────
async function _fetchHistory(symbol) {
  const key = `hist:${symbol}`;
  return _getOrFetch(_histCache, key, HISTORY_CACHE_TTL_MS, async () => {
    try {
      const period1 = new Date();
      period1.setFullYear(period1.getFullYear() - HISTORY_FETCH_YEARS);

      const rows = await _getClient().historical(symbol, { period1, interval: "1d" });
      if (!Array.isArray(rows) || rows.length < 50) return null;

      return rows
        .filter(r => r?.close != null && r?.date != null)
        .map(r => ({
          date:  new Date(r.date),
          open:  Number(r.open  ?? r.close),
          high:  Number(r.high  ?? r.close),
          low:   Number(r.low   ?? r.close),
          close: Number(r.close),
        }))
        .sort((a, b) => a.date - b.date);
    } catch {
      return null;
    }
  });
}

// ─── Group rows by (isoWeekYear, isoWeek) ─────────────────────────────────────
function _groupByWeek(rows) {
  const byYW = {};
  for (const r of rows) {
    const { week, year } = _isoWeek(r.date);
    const w = week > 52 ? 52 : week; // normalize rare week-53 into week-52
    if (!byYW[year]) byYW[year] = {};
    if (!byYW[year][w]) byYW[year][w] = [];
    byYW[year][w].push(r);
  }
  return byYW;
}

// ─── Statistics helpers ────────────────────────────────────────────────────────
function _median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _maxDrawdown(prices) {
  let peak = -Infinity, dd = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    if (peak > 0) dd = Math.min(dd, (p - peak) / peak);
  }
  return dd;
}

const _r4 = n => Math.round(n * 10_000) / 10_000;
const _r3 = n => Math.round(n * 1_000)  / 1_000;

// ─── Window-level analysis ─────────────────────────────────────────────────────
/**
 * Analyzes one (startWeek, sizeWeeks) window across all historical years.
 * Returns null when sample is too small.
 */
function _analyzeWindow(byYW, startWeek, sizeWeeks, currentWeek, currentYear) {
  const years   = Object.keys(byYW).map(Number).sort((a, b) => a - b);
  const returns = [], drawdowns = [];

  for (const year of years) {
    if (year >= currentYear) continue; // skip current incomplete year

    const entryRows = byYW[year]?.[startWeek];
    if (!entryRows?.length) continue;
    const entryOpen = entryRows[0].open;
    if (!Number.isFinite(entryOpen) || entryOpen <= 0) continue;

    // Collect all closes across the multi-week window (handles year boundary)
    const windowPrices = [entryOpen];
    let complete = true;
    for (let wi = 0; wi < sizeWeeks; wi++) {
      let w = startWeek + wi;
      let y = year;
      if (w > 52) { w -= 52; y += 1; }
      const weekRows = byYW[y]?.[w];
      if (!weekRows?.length) { complete = false; break; }
      for (const r of weekRows) windowPrices.push(r.close);
    }
    if (!complete || windowPrices.length < 2) continue;

    const exitPrice = windowPrices[windowPrices.length - 1];
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) continue;

    returns.push((exitPrice - entryOpen) / entryOpen);
    drawdowns.push(_maxDrawdown(windowPrices));
  }

  if (returns.length < MIN_SAMPLE_SIZE) return null;

  const n          = returns.length;
  const avgReturn  = returns.reduce((s, r) => s + r, 0) / n;
  const medReturn  = _median(returns);
  const winRate    = returns.filter(r => r > 0).length / n;
  const avgDd      = drawdowns.reduce((s, d) => s + d, 0) / n;
  const worstDd    = Math.min(...drawdowns);

  // confidenceScore: blend sample coverage (≥12 obs saturates) and directional consistency
  const sampleFactor    = Math.min(n / 12, 1.0);
  const consistency     = Math.abs(winRate - 0.5) * 2; // 0 if 50/50, 1 if 100/0
  const confidenceScore = _r3(sampleFactor * 0.6 + consistency * 0.4);

  // seasonalityScore: directional strength normalized to [-1, 1]
  const direction        = avgReturn >= 0 ? 1 : -1;
  const magnitude        = Math.abs(avgReturn);
  const rawScore         = direction * magnitude * consistency * sampleFactor / SCORE_NORMALIZER;
  const seasonalityScore = _r3(Math.max(-1, Math.min(1, rawScore)));

  const bias = seasonalityScore >= BIAS_THRESHOLD  ? "bullish"
    :          seasonalityScore <= -BIAS_THRESHOLD ? "bearish"
    :                                                "neutral";

  // Check whether the current week falls inside this window
  let isActive = false;
  for (let wi = 0; wi < sizeWeeks; wi++) {
    const w = ((startWeek - 1 + wi) % 52) + 1;
    if (w === currentWeek) { isActive = true; break; }
  }

  return {
    windowStart:    startWeek,
    windowEnd:      ((startWeek - 1 + sizeWeeks - 1) % 52) + 1,
    windowSizeWeeks: sizeWeeks,
    winRate:         _r3(winRate),
    avgReturn:       _r4(avgReturn),
    medianReturn:    medReturn != null ? _r4(medReturn) : null,
    avgDrawdown:     _r4(avgDd),
    worstDrawdown:   _r4(worstDd),
    confidenceScore,
    sampleSize:      n,
    seasonalityScore,
    bias,
    isActive,
  };
}

// ─── Horizon-level analysis ────────────────────────────────────────────────────
function _analyzeHorizon(allRows, horizonYears) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - horizonYears);
  const rows = allRows.filter(r => r.date >= cutoff);
  if (rows.length < 100) return null; // insufficient data for this horizon

  const today = new Date();
  const { week: currentWeek, year: currentYear } = _isoWeek(today);
  const byYW    = _groupByWeek(rows);
  const windows = [];

  for (const sizeWeeks of WINDOW_SIZES_WEEKS) {
    for (let startWeek = 1; startWeek <= 52; startWeek++) {
      const w = _analyzeWindow(byYW, startWeek, sizeWeeks, currentWeek, currentYear);
      if (w) windows.push(w);
    }
  }

  const bullishWindows = windows
    .filter(w => w.bias === "bullish")
    .sort((a, b) => b.seasonalityScore - a.seasonalityScore)
    .slice(0, 5);

  const bearishWindows = windows
    .filter(w => w.bias === "bearish")
    .sort((a, b) => a.seasonalityScore - b.seasonalityScore)
    .slice(0, 5);

  const activeWindows = windows.filter(w => w.isActive);

  return { windows, bullishWindows, bearishWindows, activeWindows };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Computes full seasonality analysis for one ticker.
 * Returns null on any failure — callers must handle null gracefully.
 */
export async function computeSeasonality(symbol) {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return null;

  const cacheKey = `result:${sym}`;
  return _getOrFetch(_resultCache, cacheKey, RESULT_CACHE_TTL_MS, async () => {
    try {
      const rows = await _fetchHistory(sym);
      if (!rows?.length) return null;

      const today = new Date();
      const { week: currentWeek } = _isoWeek(today);

      // Analyze all horizons (rows sliced inside _analyzeHorizon)
      const horizons = {};
      for (const [label, years] of Object.entries(HORIZONS)) {
        horizons[label] = _analyzeHorizon(rows, years);
      }

      // Aggregate signal from active windows across horizons (weighted by horizon + confidence)
      let weightedScore = 0, totalWeight = 0;
      const allBullish = [], allBearish = [], allActive = [];

      for (const [label, h] of Object.entries(horizons)) {
        if (!h) continue;
        const w = HORIZON_WEIGHTS[label] ?? 0.25;
        for (const win of h.activeWindows) {
          allActive.push({ ...win, horizon: label });
          weightedScore += win.seasonalityScore * w * win.confidenceScore;
          totalWeight   += w * win.confidenceScore;
        }
        for (const win of h.bullishWindows) allBullish.push({ ...win, horizon: label });
        for (const win of h.bearishWindows) allBearish.push({ ...win, horizon: label });
      }

      const seasonalityScore = totalWeight > 0
        ? _r3(Math.max(-1, Math.min(1, weightedScore / totalWeight)))
        : 0;

      const seasonalBias = seasonalityScore >= BIAS_THRESHOLD  ? "favorable"
        :                  seasonalityScore <= -BIAS_THRESHOLD ? "unfavorable"
        :                                                        "neutral";

      // seasonalStrikeRisk: "unfavorable" window = higher assignment risk for put sellers
      const seasonalStrikeRisk = seasonalBias === "unfavorable" ? "high"
        : seasonalBias === "favorable" ? "low"
        : "medium";

      // Pick the most extreme active window for quick display
      const activeWindowNow = allActive.length > 0
        ? [...allActive].sort((a, b) => Math.abs(b.seasonalityScore) - Math.abs(a.seasonalityScore))[0]
        : null;

      return {
        symbol:           sym,
        generatedAt:      new Date().toISOString(),
        currentWeek,
        dataPointCount:   rows.length,
        horizons,
        bestBullishWindows: allBullish.sort((a, b) => b.seasonalityScore - a.seasonalityScore).slice(0, 5),
        bestBearishWindows: allBearish.sort((a, b) => a.seasonalityScore - b.seasonalityScore).slice(0, 5),
        activeWindowNow,
        seasonalityScore,
        seasonalBias,
        seasonalStrikeRisk,
      };
    } catch {
      return null; // fail silently — never propagate to main scanner
    }
  });
}

/**
 * Computes seasonality for multiple tickers with bounded concurrency.
 * Returns { symbols, results: { SYMBOL: data|null }, generatedAt }.
 */
export async function computeSeasonalityScanSummary(symbols) {
  const syms = [...new Set(
    (Array.isArray(symbols) ? symbols : [])
      .map(s => String(s ?? "").trim().toUpperCase())
      .filter(Boolean),
  )];

  if (!syms.length) {
    return { symbols: [], results: {}, generatedAt: new Date().toISOString() };
  }

  const results = {};
  for (let i = 0; i < syms.length; i += CONCURRENCY_LIMIT) {
    const batch   = syms.slice(i, i + CONCURRENCY_LIMIT);
    const settled = await Promise.allSettled(batch.map(s => computeSeasonality(s)));
    for (let j = 0; j < batch.length; j++) {
      results[batch[j]] = settled[j].status === "fulfilled" ? settled[j].value : null;
    }
  }

  return { symbols: syms, results, generatedAt: new Date().toISOString() };
}

/** Diagnostic — cache state for ops / monitoring. */
export function getSeasonalityCacheStats() {
  return {
    histCacheSize:       _histCache.size,
    resultCacheSize:     _resultCache.size,
    inFlightCount:       _inFlight.size,
    histCacheTtlHours:   HISTORY_CACHE_TTL_MS  / 3_600_000,
    resultCacheTtlHours: RESULT_CACHE_TTL_MS   / 3_600_000,
  };
}
