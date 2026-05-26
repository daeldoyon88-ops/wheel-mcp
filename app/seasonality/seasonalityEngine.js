/**
 * Seasonality Engine V1
 *
 * Read-only, fully isolated module.
 * - Separate Yahoo Finance client (no shared state with main provider)
 * - Separate in-memory cache (no impact on scanner cache/metrics)
 * - Returns null on any failure — scanner continues normally
 * - No DB writes, no impact on EliteScore, IBKR, or ranking
 *
 * Data source: yahoo-finance2 chart() — same method used by the main scanner.
 * historical() is deprecated in yahoo-finance2@3.x and must NOT be used.
 */

import YahooFinance from "yahoo-finance2";

// ─── Configuration ─────────────────────────────────────────────────────────────
const WINDOW_SIZES_WEEKS    = [2, 4, 8, 12, 16];
const HORIZONS              = { "3Y": 3, "5Y": 5, "10Y": 10, "15Y": 15 };
const HORIZON_WEIGHTS       = { "3Y": 0.20, "5Y": 0.35, "10Y": 0.30, "15Y": 0.15 };
const HISTORY_FETCH_YEARS   = 15;              // fetch max; slice per horizon
const HISTORY_CACHE_TTL_MS  = 6 * 3_600_000;  // 6 h — history only changes daily
const HISTORY_FAIL_TTL_MS   = 5 * 60_000;     // 5 min — short cache for fetch failures
const RESULT_CACHE_TTL_MS   = 4 * 3_600_000;  // 4 h — result cache (never stores null)
const MIN_SAMPLE_SIZE       = 3;
const SCORE_NORMALIZER      = 0.05;            // 5 % return → raw score ~1
const BIAS_THRESHOLD        = 0.25;
const CONCURRENCY_LIMIT     = 3;
const MONTH_LABELS          = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

// ─── Debug logging (controlled — set DEBUG_SEASONALITY=true to enable) ─────────
const _debug = String(process.env.DEBUG_SEASONALITY ?? "").toLowerCase() === "true";
function _log(...args) { if (_debug) console.log("[SEASONALITY]", ...args); }
function _warn(...args) { console.warn("[SEASONALITY]", ...args); }

// ─── Isolated in-memory caches ─────────────────────────────────────────────────
const _histCache   = new Map(); // sym → { value: rows|null, expiresAt }
const _resultCache = new Map(); // sym → { value: result, expiresAt } — NEVER stores null
const _calendarCache = new Map(); // sym → { value: calendarResult, expiresAt } — NEVER stores null
const _inFlight    = new Map(); // key → Promise — dedup concurrent requests

// ─── Lazy isolated Yahoo client ────────────────────────────────────────────────
let _client = null;
function _getClient() {
  if (!_client) {
    _client = new YahooFinance({
      suppressNotices: ["yahooSurvey", "ripHistorical"],
    });
  }
  return _client;
}

// ─── Cache primitives ──────────────────────────────────────────────────────────
function _getCached(map, key) {
  const e = map.get(key);
  if (!e) return undefined; // undefined = not in cache
  if (Date.now() >= e.expiresAt) { map.delete(key); return undefined; }
  return e.value; // may be null (failure cached with short TTL in histCache)
}

function _setCached(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ─── ISO week utilities (ISO 8601) ─────────────────────────────────────────────
function _isoWeek(date) {
  const d   = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;            // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);   // nearest Thursday
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return {
    week: Math.ceil(((d - jan1) / 86_400_000 + 1) / 7),
    year: d.getUTCFullYear(),
  };
}

// ─── Raw row normalisation ─────────────────────────────────────────────────────
function _normalizeQuote(q) {
  if (!q) return null;
  const close = Number(q.close ?? q.adjclose ?? q.adjClose);
  if (!Number.isFinite(close) || close <= 0) return null;
  const date = q.date instanceof Date ? q.date : new Date(q.date);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date,
    open:  Number(q.open  ?? close),
    high:  Number(q.high  ?? close),
    low:   Number(q.low   ?? close),
    close,
  };
}

// ─── Historical data fetch via chart() ────────────────────────────────────────
/**
 * Fetches up to HISTORY_FETCH_YEARS of daily OHLC via yahoo-finance2 chart().
 * Caches success for 6 h, failures for 5 min.
 * Returns normalized row array or null.
 */
async function _fetchHistory(symbol) {
  const key     = `hist:${symbol}`;
  const cached  = _getCached(_histCache, key);
  if (cached !== undefined) {
    _log(`hist cache ${cached ? "HIT" : "FAIL-HIT"} for ${symbol} (${cached?.length ?? 0} rows)`);
    return cached;
  }

  const flying = _inFlight.get(key);
  if (flying) return flying;

  const promise = (async () => {
    try {
      const period1 = new Date();
      period1.setFullYear(period1.getFullYear() - HISTORY_FETCH_YEARS);

      _log(`fetching chart() for ${symbol} from ${period1.toISOString().slice(0, 10)}`);

      const result = await _getClient().chart(symbol, {
        period1,
        period2: new Date(),  // explicit today — avoids schema validation issues
        interval: "1d",
      });

      const quotes = result?.quotes;
      if (!Array.isArray(quotes)) {
        _warn(`chart() for ${symbol}: quotes not an array (got ${typeof quotes})`);
        _setCached(_histCache, key, null, HISTORY_FAIL_TTL_MS);
        return null;
      }

      _log(`chart() for ${symbol}: ${quotes.length} raw quotes received`);

      const rows = quotes
        .map(_normalizeQuote)
        .filter(Boolean)
        .sort((a, b) => a.date - b.date);

      _log(`chart() for ${symbol}: ${rows.length} valid rows after normalisation`);

      if (rows.length < 50) {
        _warn(`chart() for ${symbol}: only ${rows.length} valid rows — insufficient (<50), caching as failure`);
        _setCached(_histCache, key, null, HISTORY_FAIL_TTL_MS);
        return null;
      }

      _setCached(_histCache, key, rows, HISTORY_CACHE_TTL_MS);
      return rows;

    } catch (err) {
      _warn(`chart() for ${symbol} threw: ${err?.message ?? String(err)}`);
      _setCached(_histCache, key, null, HISTORY_FAIL_TTL_MS);
      return null;
    } finally {
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, promise);
  return promise;
}

// ─── Group rows by (isoWeekYear, isoWeek) ─────────────────────────────────────
function _groupByWeek(rows) {
  const byYW = {};
  for (const r of rows) {
    const { week, year } = _isoWeek(r.date);
    const w = week > 52 ? 52 : week; // normalise rare week-53
    if (!byYW[year]) byYW[year] = {};
    if (!byYW[year][w]) byYW[year][w] = [];
    byYW[year][w].push(r);
  }
  return byYW;
}

// ─── Statistics ────────────────────────────────────────────────────────────────
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

function _groupByMonth(rows) {
  const byYM = {};
  for (const r of rows) {
    const year  = r.date.getUTCFullYear();
    const month = r.date.getUTCMonth() + 1;
    if (!byYM[year]) byYM[year] = {};
    if (!byYM[year][month]) byYM[year][month] = [];
    byYM[year][month].push(r);
  }
  return byYM;
}

const _r4 = n => Math.round(n * 10_000) / 10_000;
const _r3 = n => Math.round(n * 1_000)  / 1_000;

// ─── Window-level analysis ─────────────────────────────────────────────────────
function _analyzeWindow(byYW, startWeek, sizeWeeks, currentWeek, currentYear) {
  const years    = Object.keys(byYW).map(Number).sort((a, b) => a - b);
  const returns  = [], drawdowns = [];

  for (const year of years) {
    if (year >= currentYear) continue;

    const entryRows = byYW[year]?.[startWeek];
    if (!entryRows?.length) continue;
    const entryOpen = entryRows[0].open;
    if (!Number.isFinite(entryOpen) || entryOpen <= 0) continue;

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

  const n           = returns.length;
  const avgReturn   = returns.reduce((s, r) => s + r, 0) / n;
  const medReturn   = _median(returns);
  const winRate     = returns.filter(r => r > 0).length / n;
  const avgDd       = drawdowns.reduce((s, d) => s + d, 0) / n;
  const worstDd     = Math.min(...drawdowns);

  const sampleFactor    = Math.min(n / 12, 1.0);
  const consistency     = Math.abs(winRate - 0.5) * 2;
  const confidenceScore = _r3(sampleFactor * 0.6 + consistency * 0.4);

  const direction        = avgReturn >= 0 ? 1 : -1;
  const magnitude        = Math.abs(avgReturn);
  const rawScore         = direction * magnitude * consistency * sampleFactor / SCORE_NORMALIZER;
  const seasonalityScore = _r3(Math.max(-1, Math.min(1, rawScore)));

  const bias = seasonalityScore >= BIAS_THRESHOLD  ? "bullish"
    :          seasonalityScore <= -BIAS_THRESHOLD ? "bearish"
    :                                                "neutral";

  let isActive = false;
  for (let wi = 0; wi < sizeWeeks; wi++) {
    const w = ((startWeek - 1 + wi) % 52) + 1;
    if (w === currentWeek) { isActive = true; break; }
  }

  return {
    windowStart:     startWeek,
    windowEnd:       ((startWeek - 1 + sizeWeeks - 1) % 52) + 1,
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
  if (rows.length < 100) return null;

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
 * Computes full seasonality for one ticker.
 * Returns null on failure — null is NEVER stored in result cache (always retried).
 */
export async function computeSeasonality(symbol) {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return null;

  // Check result cache — only contains successful (non-null) results
  const resultCacheKey = `result:${sym}`;
  const cachedResult   = _getCached(_resultCache, resultCacheKey);
  if (cachedResult !== undefined) {
    _log(`result cache HIT for ${sym}`);
    return cachedResult; // guaranteed non-null
  }

  // Dedup concurrent computations for same symbol
  const flying = _inFlight.get(resultCacheKey);
  if (flying) return flying;

  const promise = (async () => {
    try {
      const rows = await _fetchHistory(sym);
      if (!rows?.length) {
        _log(`no rows for ${sym} — returning null (not cached in result cache)`);
        return null;
      }

      _log(`computing seasonality for ${sym} with ${rows.length} rows`);

      const today = new Date();
      const { week: currentWeek } = _isoWeek(today);

      const horizons = {};
      for (const [label, years] of Object.entries(HORIZONS)) {
        horizons[label] = _analyzeHorizon(rows, years);
      }

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

      const seasonalStrikeRisk = seasonalBias === "unfavorable" ? "high"
        :                        seasonalBias === "favorable"   ? "low"
        :                                                         "medium";

      const activeWindowNow = allActive.length > 0
        ? [...allActive].sort((a, b) => Math.abs(b.seasonalityScore) - Math.abs(a.seasonalityScore))[0]
        : null;

      const result = {
        symbol:             sym,
        generatedAt:        new Date().toISOString(),
        currentWeek,
        dataPointCount:     rows.length,
        horizons,
        bestBullishWindows: allBullish.sort((a, b) => b.seasonalityScore - a.seasonalityScore).slice(0, 5),
        bestBearishWindows: allBearish.sort((a, b) => a.seasonalityScore - b.seasonalityScore).slice(0, 5),
        activeWindowNow,
        seasonalityScore,
        seasonalBias,
        seasonalStrikeRisk,
      };

      // Only cache successful (non-null) results
      _setCached(_resultCache, resultCacheKey, result, RESULT_CACHE_TTL_MS);
      _log(`seasonality computed for ${sym}: bias=${seasonalBias} score=${seasonalityScore}`);
      return result;

    } catch (err) {
      _warn(`computeSeasonality threw for ${sym}: ${err?.message ?? String(err)}`);
      return null; // NOT cached — allows retry on next request
    } finally {
      _inFlight.delete(resultCacheKey);
    }
  })();

  _inFlight.set(resultCacheKey, promise);
  return promise;
}

// ─── Monthly calendar computation (Phase A — Seasonality V2) ──────────────────

/**
 * Pure computation: groups normalized rows by calendar month and returns statistics.
 * Exported for unit testing — no Yahoo calls, no cache side-effects.
 */
export function computeCalendarFromRows(rows) {
  if (!rows?.length) return null;

  const byYM     = _groupByMonth(rows);
  const allYears = Object.keys(byYM).map(Number).sort((a, b) => a - b);
  const now      = new Date();
  const currentYear  = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;

  const months = [];

  for (let month = 1; month <= 12; month++) {
    const monthReturns   = [];
    const monthDrawdowns = [];

    for (const year of allYears) {
      // Skip the current month and future months of the current year (données incomplètes)
      if (year === currentYear && month >= currentMonth) continue;

      const monthRows = byYM[year]?.[month];
      if (!monthRows || monthRows.length < 2) continue;

      const sorted     = [...monthRows].sort((a, b) => a.date - b.date);
      const firstClose = sorted[0].close;
      const lastClose  = sorted[sorted.length - 1].close;

      if (!Number.isFinite(firstClose) || firstClose <= 0) continue;
      if (!Number.isFinite(lastClose)  || lastClose  <= 0) continue;

      const ret = (lastClose - firstClose) / firstClose;
      monthReturns.push(ret);
      monthDrawdowns.push(_maxDrawdown(sorted.map(r => r.close)));
    }

    if (monthReturns.length < MIN_SAMPLE_SIZE) continue;

    const n             = monthReturns.length;
    const avgReturn     = monthReturns.reduce((s, r) => s + r, 0) / n;
    const medianReturn  = _median(monthReturns);
    const positiveYears = monthReturns.filter(r => r > 0).length;
    const negativeYears = monthReturns.filter(r => r < 0).length;
    const winRate       = positiveYears / n;
    const bestReturn    = Math.max(...monthReturns);
    const worstReturn   = Math.min(...monthReturns);
    const avgDrawdown   = monthDrawdowns.reduce((s, d) => s + d, 0) / monthDrawdowns.length;
    const worstDrawdown = Math.min(...monthDrawdowns);

    let verdict;
    if (winRate >= 0.65 && avgReturn > 0)      verdict = 'favorable';
    else if (winRate <= 0.45 && avgReturn < 0) verdict = 'faible';
    else                                        verdict = 'neutre';

    months.push({
      month,
      label:         MONTH_LABELS[month - 1],
      sampleSize:    n,
      avgReturn:     _r4(avgReturn),
      medianReturn:  medianReturn != null ? _r4(medianReturn) : null,
      winRate:       _r3(winRate),
      positiveYears,
      negativeYears,
      bestReturn:    _r4(bestReturn),
      worstReturn:   _r4(worstReturn),
      avgDrawdown:   _r4(avgDrawdown),
      worstDrawdown: _r4(worstDrawdown),
      verdict,
    });
  }

  if (!months.length) return null;

  const bestMonth  = months.reduce((b, m) => !b || m.avgReturn > b.avgReturn ? m : b, null);
  const worstMonth = months.reduce((w, m) => !w || m.avgReturn < w.avgReturn ? m : w, null);
  const favorableMonths = months.filter(m => m.verdict === 'favorable');
  const faibleMonths    = months.filter(m => m.verdict === 'faible');
  const strongestPositiveMonth = favorableMonths.length
    ? favorableMonths.reduce((b, m) => !b || m.avgReturn > b.avgReturn ? m : b, null)
    : bestMonth;
  const strongestNegativeMonth = faibleMonths.length
    ? faibleMonths.reduce((w, m) => !w || m.avgReturn < w.avgReturn ? m : w, null)
    : worstMonth;

  const yearsCovered = allYears.filter(y => y < currentYear).length;

  return {
    months,
    summary: {
      bestMonth,
      worstMonth,
      strongestPositiveMonth,
      strongestNegativeMonth,
      yearsCovered,
      generatedAt:   new Date().toISOString(),
      source:        'Yahoo Finance',
      cacheTtlHours: RESULT_CACHE_TTL_MS / 3_600_000,
    },
  };
}

/**
 * Computes monthly calendar seasonality for one ticker.
 * Reuses _fetchHistory / _histCache — no extra Yahoo calls.
 * Returns null on failure — null is NEVER stored in _calendarCache (always retried).
 */
export async function computeSeasonalityCalendar(symbol) {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!sym) return null;

  const calKey = `calendar:${sym}`;
  const cached = _getCached(_calendarCache, calKey);
  if (cached !== undefined) {
    _log(`calendar cache HIT for ${sym}`);
    return cached;
  }

  const flying = _inFlight.get(calKey);
  if (flying) return flying;

  const promise = (async () => {
    try {
      const rows = await _fetchHistory(sym);
      if (!rows?.length) {
        _log(`no rows for ${sym} calendar — returning null`);
        return null;
      }

      _log(`computing calendar for ${sym} with ${rows.length} rows`);
      const result = computeCalendarFromRows(rows);

      if (!result) {
        _log(`computeCalendarFromRows returned null for ${sym} (données insuffisantes)`);
        return null;
      }

      _setCached(_calendarCache, calKey, result, RESULT_CACHE_TTL_MS);
      _log(`calendar cached for ${sym}: ${result.months.length} mois, ${result.summary.yearsCovered} ans`);
      return result;

    } catch (err) {
      _warn(`computeSeasonalityCalendar threw for ${sym}: ${err?.message ?? String(err)}`);
      return null;
    } finally {
      _inFlight.delete(calKey);
    }
  })();

  _inFlight.set(calKey, promise);
  return promise;
}

/**
 * Batch seasonality for multiple tickers with bounded concurrency.
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

/**
 * Diagnostic — exposes cache state and data fetch status for a symbol.
 * Useful for debugging without triggering a full computation.
 */
export async function getSeasonalityDiagnostic(symbol) {
  const sym = String(symbol ?? "").trim().toUpperCase();
  const histKey     = `hist:${sym}`;
  const resultKey   = `result:${sym}`;
  const calendarKey = `calendar:${sym}`;

  const histEntry     = _histCache.get(histKey);
  const resultEntry   = _resultCache.get(resultKey);
  const calendarEntry = _calendarCache.get(calendarKey);

  const histStatus     = !histEntry     ? "miss" : Date.now() >= histEntry.expiresAt     ? "expired" : histEntry.value   ? "hit" : "cached-null";
  const resultStatus   = !resultEntry   ? "miss" : Date.now() >= resultEntry.expiresAt   ? "expired" : "hit";
  const calendarStatus = !calendarEntry ? "miss" : Date.now() >= calendarEntry.expiresAt ? "expired" : "hit";

  return {
    symbol:        sym,
    histCache:     { status: histStatus,     rowCount:   histEntry?.value?.length ?? null,               expiresAt: histEntry?.expiresAt     ?? null },
    resultCache:   { status: resultStatus,   hasBias:    resultEntry?.value?.seasonalBias ?? null,       expiresAt: resultEntry?.expiresAt   ?? null },
    calendarCache: { status: calendarStatus, monthCount: calendarEntry?.value?.months?.length ?? null,   expiresAt: calendarEntry?.expiresAt ?? null },
    inFlight:      { hist: _inFlight.has(histKey), result: _inFlight.has(resultKey), calendar: _inFlight.has(calendarKey) },
  };
}

/** Ops diagnostic — cache sizes and configuration. */
export function getSeasonalityCacheStats() {
  return {
    histCacheSize:        _histCache.size,
    resultCacheSize:      _resultCache.size,
    calendarCacheSize:    _calendarCache.size,
    inFlightCount:        _inFlight.size,
    histCacheTtlHours:    HISTORY_CACHE_TTL_MS  / 3_600_000,
    resultCacheTtlHours:  RESULT_CACHE_TTL_MS   / 3_600_000,
    histFailTtlMin:       HISTORY_FAIL_TTL_MS   / 60_000,
    debugEnabled:         _debug,
  };
}
