/**
 * Seasonality Routes V1 — read-only, additive endpoints.
 * Mounted at /seasonality in server.js.
 * Zero impact on existing scanner, IBKR, or journal routes.
 */

import { Router } from "express";
import {
  computeSeasonality,
  computeSeasonalityCalendar,
  computeSeasonalityShortTerm,
  computeSeasonalityWindows,
  computeSeasonalityScanSummary,
  getSeasonalityCacheStats,
  getSeasonalityDiagnostic,
} from "./seasonalityEngine.js";
import {
  computeSeasonalityBacktest,
  buildBacktestApiResponse,
  parseBacktestOutputOptions,
  resolveBacktestTickerList,
} from "./seasonalityBacktest.js";
import {
  computeSeasonalityHighProbabilityWindows,
  buildHighProbabilityWindowsApiResponse,
  parseHighProbabilityWindowsParams,
} from "./seasonalityHighProbabilityWindows.js";
import {
  computeSeasonalityChart3y,
  buildChart3yApiResponse,
} from "./seasonalityChart3y.js";
import {
  createSeasonalityPersistentCache,
  SEASONALITY_CACHE_VERSION,
} from "./seasonalityPersistentCache.js";

const router   = Router();
const TICKER_RE = /^[A-Z0-9.\-^]{1,10}$/;

// Cache SQLite persistant (expiration quotidienne UTC) — partagé par toutes les requêtes /bundle
const persistentCache = createSeasonalityPersistentCache();

// Calcule les 4 sources en parallèle et retourne le payload bundle
async function computeSeasonalityBundle(ticker) {
  const [calendar, shortTerm, windows, chart3yRaw] = await Promise.all([
    computeSeasonalityCalendar(ticker),
    computeSeasonalityShortTerm(ticker),
    computeSeasonalityWindows(ticker),
    computeSeasonalityChart3y(ticker),
  ]);
  return {
    ok:            true,
    ticker,
    calendarData:  calendar  ?? null,
    shortTermData: shortTerm ?? null,
    windowsData:   windows   ?? null,
    chart3yData:   buildChart3yApiResponse(chart3yRaw),
  };
}

// NOTE: specific routes must be registered BEFORE the /:ticker param route
// so Express matches them before the wildcard.

/**
 * POST /seasonality/warmup
 * Body: { tickers: ["TQQQ", "SOXL", ...] }
 * Lance le préchauffage discret des 4 endpoints pour chaque ticker (max 20).
 * Réponse immédiate — traitement en arrière-plan avec concurrence max 2.
 */
router.post("/warmup", (req, res) => {
  const raw = Array.isArray(req.body?.tickers) ? req.body.tickers : [];
  const tickers = raw
    .map(t => String(t ?? "").trim().toUpperCase())
    .filter(t => t && TICKER_RE.test(t))
    .slice(0, 20);

  if (!tickers.length) {
    return res.status(400).json({ ok: false, error: "tickers array required (max 20)" });
  }

  // Réponse immédiate
  res.json({ ok: true, warming: tickers });

  // Préchauffage en arrière-plan — concurrence max 2
  let idx = 0;
  let active = 0;
  function next() {
    while (idx < tickers.length && active < 2) {
      const sym = tickers[idx++];
      active++;
      Promise.all([
        computeSeasonalityCalendar(sym),
        computeSeasonalityShortTerm(sym),
        computeSeasonalityWindows(sym),
        computeSeasonalityChart3y(sym),
      ]).catch(() => {}).finally(() => { active--; next(); });
    }
  }
  next();
});

/**
 * GET /seasonality/cache-stats
 * Diagnostic — returns cache sizes and TTLs.
 */
router.get("/cache-stats", (_req, res) => {
  try {
    res.json({ ok: true, ...getSeasonalityCacheStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "cache_stats_failed") });
  }
});

/**
 * GET /seasonality/cache/status
 * Diagnostic SQLite — résumé du cache persistant (entries, versions, dates).
 */
router.get("/cache/status", async (_req, res) => {
  try {
    await persistentCache.ensureInitialized();
    res.json({ ok: true, ...persistentCache.getCacheStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "cache_status_failed") });
  }
});

/**
 * GET /seasonality/diagnostic/:ticker
 * Inspects cache state for a symbol without triggering computation.
 * Useful for debugging null results.
 */
router.get("/diagnostic/:ticker", async (req, res) => {
  try {
    const symbol = String(req.params.ticker ?? "").trim().toUpperCase();
    if (!symbol || !TICKER_RE.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid ticker" });
    }
    const diag = await getSeasonalityDiagnostic(symbol);
    res.json({ ok: true, ...diag });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "diagnostic_failed") });
  }
});

/**
 * GET /seasonality/scan-summary?tickers=AAPL,MSFT,NVDA
 * Batch seasonality for up to 30 tickers.
 * Results are computed with bounded concurrency and cached server-side (6h TTL).
 */
router.get("/scan-summary", async (req, res) => {
  try {
    const raw = String(req.query.tickers ?? "").trim();
    if (!raw) {
      return res.status(400).json({ ok: false, error: "tickers query param is required" });
    }
    const symbols = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (symbols.length > 30) {
      return res.status(400).json({ ok: false, error: "max 30 tickers per request" });
    }
    const result = await computeSeasonalityScanSummary(symbols);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "scan_summary_failed") });
  }
});

/**
 * GET /seasonality/backtest?year=2025&tickers=TQQQ,NVDA,PLTR
 * Backtest saisonnier par année cible — anti-lookahead strict.
 * Les signaux pour l'année N sont construits uniquement avec les données des années < N.
 *
 * Paramètres :
 *   year          Année cible (défaut : année précédente). Doit être < année courante.
 *   tickers       Liste de tickers séparés par virgule (prioritaire sur source).
 *   source        Source prédéfinie : top20-wheel | strict-watchlist | fallback65.
 *   windows       Durées de fenêtre en jours (défaut : 20,40,60,90).
 *   minSamples    Taille d'échantillon minimum (défaut : 5).
 *   bullishWinRate Taux de réussite minimum pour signal haussier (défaut : 0.65).
 *   bearishWinRate Taux de réussite maximum pour signal baissier (défaut : 0.45).
 *   includeSignals  Si 1/true : inclut signals[] (défaut : absent).
 *   signalsLimit    Max signaux détaillés si includeSignals (défaut 100, max 500).
 *   bestLimit       Top signaux réussis dans globalSummary.bestSignals (défaut 10).
 *   worstLimit      Top signaux échoués dans globalSummary.worstSignals (défaut 10).
 */
router.get("/backtest", async (req, res) => {
  try {
    // ── Année cible ──────────────────────────────────────────────────────────
    const currentYear = new Date().getUTCFullYear();
    const yearRaw     = req.query.year;
    const year        = yearRaw ? parseInt(yearRaw, 10) : currentYear - 1;

    if (!Number.isFinite(year) || year < 2010 || year >= currentYear) {
      return res.status(400).json({
        ok: false,
        error: `Paramètre year invalide: ${yearRaw ?? "(absent)"}. Attendu entre 2010 et ${currentYear - 1}.`,
        warnings: [],
      });
    }

    // ── Tickers ou source ────────────────────────────────────────────────────
    const resolved = resolveBacktestTickerList({
      tickersRaw: req.query.tickers,
      sourceRaw:  req.query.source,
    });

    if (!resolved.ok) {
      const status = resolved.error?.includes('Source inconnue') ? 200 : 400;
      return res.status(status).json({
        ok: false,
        error: resolved.error,
        warnings: [],
      });
    }

    const { tickers, source: sourceLabel } = resolved;

    if (!tickers.length) {
      return res.status(400).json({ ok: false, error: "Aucun ticker fourni.", warnings: [] });
    }

    if (tickers.length > 50) {
      return res.status(400).json({ ok: false, error: "Maximum 50 tickers par requête.", warnings: [] });
    }

    // Validation format tickers
    const invalidTickers = tickers.filter(t => !TICKER_RE.test(t));
    if (invalidTickers.length) {
      return res.status(400).json({
        ok: false,
        error: `Tickers au format invalide : ${invalidTickers.join(", ")}`,
        warnings: [],
      });
    }

    // ── Paramètres optionnels ────────────────────────────────────────────────
    const windowsRaw  = String(req.query.windows ?? "").trim();
    const windowDays  = windowsRaw
      ? windowsRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
      : [20, 40, 60, 90];

    const minSamples    = Math.max(1, parseInt(req.query.minSamples    ?? "5",    10) || 5);
    const bullishWinRate = Math.min(1, Math.max(0, parseFloat(req.query.bullishWinRate ?? "0.65") || 0.65));
    const bearishWinRate = Math.min(1, Math.max(0, parseFloat(req.query.bearishWinRate ?? "0.45") || 0.45));
    const outputOptions  = parseBacktestOutputOptions(req.query);

    if (!windowDays.length) {
      return res.status(400).json({ ok: false, error: "Paramètre windows invalide.", warnings: [] });
    }

    const parameters = {
      windows:        windowDays,
      minSamples,
      bullishWinRate,
      bearishWinRate,
      includeSignals: outputOptions.includeSignals,
      signalsLimit:   outputOptions.signalsLimit,
      bestLimit:      outputOptions.bestLimit,
      worstLimit:     outputOptions.worstLimit,
    };

    // ── Backtest ─────────────────────────────────────────────────────────────
    const result = await computeSeasonalityBacktest({
      year,
      tickers,
      windowDays,
      minSamples,
      bullishWinRate,
      bearishWinRate,
      bestLimit:  outputOptions.bestLimit,
      worstLimit: outputOptions.worstLimit,
    });

    return res.json(buildBacktestApiResponse({
      year,
      source: sourceLabel,
      parameters,
      result,
      outputOptions,
    }));

  } catch (err) {
    res.status(500).json({
      ok:       false,
      error:    String(err?.message ?? "backtest_failed"),
      warnings: [],
    });
  }
});

/**
 * GET /seasonality/high-probability-windows?tickers=TQQQ,NVDA&minWinRate=0.9
 * Fenêtres swing saisonnières à haute probabilité (5–16 semaines).
 *
 * Paramètres :
 *   tickers            Liste séparée par virgule (prioritaire sur source).
 *   source             top20-wheel | strict-watchlist | fallback65.
 *   minWeeks           Semaines min (défaut 5).
 *   maxWeeks           Semaines max (défaut 16).
 *   stepDays           Pas en jours de bourse (défaut 5).
 *   minWinRate         Win rate minimum (défaut 0.9).
 *   minAvgReturn       Rendement moyen minimum (défaut 0.10).
 *   minMedianReturn    Rendement médian minimum (défaut 0.05).
 *   minSamples         Occurrences minimum (défaut 8).
 *   maxResultsPerTicker Max fenêtres par ticker (défaut 10).
 *   direction          bullish | bearish | both (défaut both).
 *   includeAll         1/true pour inclure toutes les fenêtres avec minSamples.
 */
router.get("/high-probability-windows", async (req, res) => {
  try {
    const resolved = resolveBacktestTickerList({
      tickersRaw: req.query.tickers,
      sourceRaw:  req.query.source,
    });

    if (!resolved.ok) {
      const status = resolved.error?.includes('Source inconnue') ? 200 : 400;
      return res.status(status).json({
        ok: false,
        error: resolved.error,
        warnings: [],
      });
    }

    const { tickers, source: sourceLabel } = resolved;

    if (!tickers.length) {
      return res.status(400).json({ ok: false, error: "Aucun ticker fourni.", warnings: [] });
    }

    if (tickers.length > 50) {
      return res.status(400).json({ ok: false, error: "Maximum 50 tickers par requête.", warnings: [] });
    }

    const invalidTickers = tickers.filter(t => !TICKER_RE.test(t));
    if (invalidTickers.length) {
      return res.status(400).json({
        ok: false,
        error: `Tickers au format invalide : ${invalidTickers.join(", ")}`,
        warnings: [],
      });
    }

    const parameters = parseHighProbabilityWindowsParams(req.query);

    const result = await computeSeasonalityHighProbabilityWindows({
      tickers,
      parameters,
    });

    return res.json(buildHighProbabilityWindowsApiResponse({
      source: sourceLabel,
      parameters,
      byTicker: result.byTicker,
      topBullishWindows: result.topBullishWindows,
      topBearishWindows: result.topBearishWindows,
      warnings: result.warnings,
      tickersRequested: tickers.length,
      tickersAnalyzed: result.tickersAnalyzed,
    }));

  } catch (err) {
    res.status(500).json({
      ok:       false,
      error:    String(err?.message ?? "high_probability_windows_failed"),
      warnings: [],
    });
  }
});

/**
 * GET /seasonality/:ticker/chart-3y
 * Série prix 3 ans + overlays swing + occurrences + progression fenêtre active — Patch 2C-B.
 * Lecture seule, réutilise fetchHistoryRows + swingWindows (max 2 haussier / 2 baissier).
 */
router.get("/:ticker/chart-3y", async (req, res) => {
  try {
    const symbol = String(req.params.ticker ?? "").trim().toUpperCase();
    if (!symbol || !TICKER_RE.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid ticker symbol" });
    }
    const chart = await computeSeasonalityChart3y(symbol);
    if (!chart) {
      return res.status(404).json({
        ok: false,
        error: `no chart-3y seasonality data available for ${symbol}`,
      });
    }
    res.json(buildChart3yApiResponse(chart));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "chart_3y_compute_failed") });
  }
});

/**
 * GET /seasonality/:ticker/short-term
 * Statistiques court terme (3j / 4j / 7j / 14j) pour CSP / CC / Wheel — Phase B Saisonnalité V2.
 * Lecture seule, aucun impact sur les endpoints existants.
 */
router.get("/:ticker/short-term", async (req, res) => {
  try {
    const symbol = String(req.params.ticker ?? "").trim().toUpperCase();
    if (!symbol || !TICKER_RE.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid ticker symbol" });
    }
    const shortTerm = await computeSeasonalityShortTerm(symbol);
    if (!shortTerm) {
      return res.status(404).json({
        ok: false,
        error: `no short-term seasonality data available for ${symbol}`,
      });
    }
    res.json({ ok: true, symbol, shortTerm });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "short_term_compute_failed") });
  }
});

/**
 * GET /seasonality/:ticker/windows
 * Fenêtres saisonnières long terme (20 / 40 / 60 / 90 jours de bourse) — Phase C Saisonnalité V2.
 * Lecture seule, aucun impact sur les endpoints existants.
 */
router.get("/:ticker/windows", async (req, res) => {
  try {
    const symbol = String(req.params.ticker ?? "").trim().toUpperCase();
    if (!symbol || !TICKER_RE.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid ticker symbol" });
    }
    const windows = await computeSeasonalityWindows(symbol);
    if (!windows) {
      return res.status(404).json({
        ok: false,
        error: `no seasonality windows data available for ${symbol}`,
      });
    }
    res.json({ ok: true, symbol, windows });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "windows_compute_failed") });
  }
});

/**
 * GET /seasonality/:ticker/calendar
 * Statistiques mensuelles historiques pour Wheel / CSP / CC — Phase A Saisonnalité V2.
 * Lecture seule, aucun impact sur les endpoints existants.
 */
router.get("/:ticker/calendar", async (req, res) => {
  try {
    const symbol = String(req.params.ticker ?? "").trim().toUpperCase();
    if (!symbol || !TICKER_RE.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid ticker symbol" });
    }
    const calendar = await computeSeasonalityCalendar(symbol);
    if (!calendar) {
      return res.status(404).json({
        ok: false,
        error: `no calendar seasonality data available for ${symbol}`,
      });
    }
    res.json({ ok: true, symbol, calendar });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "calendar_compute_failed") });
  }
});

/**
 * GET /seasonality/:ticker/bundle
 * Retourne les 4 sources (calendar + short-term + windows + chart-3y) en une requête.
 * Cache SQLite quotidien (UTC) — stale-while-revalidate si entrée existante périmée.
 */
router.get("/:ticker/bundle", async (req, res) => {
  const symbol = String(req.params.ticker ?? "").trim().toUpperCase();
  if (!symbol || !TICKER_RE.test(symbol)) {
    return res.status(400).json({ ok: false, error: "invalid ticker symbol" });
  }
  try {
    await persistentCache.ensureInitialized();
    const entry = persistentCache.getCache(symbol);

    // Cache frais — réponse immédiate depuis SQLite
    if (entry?.fresh) {
      return res.json({
        ok: true,
        ...entry.payload,
        cacheMeta: {
          hit:            true,
          fresh:          true,
          computedAt:     entry.computedAt,
          sourceLastDate: entry.sourceLastDate,
          cacheVersion:   entry.cacheVersion,
        },
      });
    }

    // Cache périmé — réponse immédiate avec données stale + refresh silencieux
    if (entry) {
      res.json({
        ok: true,
        ...entry.payload,
        cacheMeta: {
          hit:            true,
          fresh:          false,
          refreshing:     true,
          computedAt:     entry.computedAt,
          sourceLastDate: entry.sourceLastDate,
          cacheVersion:   entry.cacheVersion,
        },
      });
      computeSeasonalityBundle(symbol).then((bundle) => {
        if (bundle?.ok) {
          persistentCache.setCache(symbol, {
            calendarData:  bundle.calendarData,
            shortTermData: bundle.shortTermData,
            windowsData:   bundle.windowsData,
            chart3yData:   bundle.chart3yData,
          });
        }
      }).catch(() => {});
      return;
    }

    // Aucun cache — calcul complet, stockage, réponse
    const bundle = await computeSeasonalityBundle(symbol);
    const payload = {
      calendarData:  bundle.calendarData,
      shortTermData: bundle.shortTermData,
      windowsData:   bundle.windowsData,
      chart3yData:   bundle.chart3yData,
    };
    persistentCache.setCache(symbol, payload);
    return res.json({
      ok: true,
      ...payload,
      cacheMeta: {
        hit:          false,
        fresh:        true,
        computedAt:   new Date().toISOString().slice(0, 10),
        cacheVersion: SEASONALITY_CACHE_VERSION,
      },
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "bundle_failed") });
  }
});

/**
 * GET /seasonality/:ticker
 * Full seasonality analysis for a single ticker.
 * Returns 404 when data is unavailable (new IPO, insufficient history, fetch failure).
 */
router.get("/:ticker", async (req, res) => {
  try {
    const symbol = String(req.params.ticker ?? "").trim().toUpperCase();
    if (!symbol || !TICKER_RE.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid ticker symbol" });
    }
    const seasonality = await computeSeasonality(symbol);
    if (!seasonality) {
      return res.status(404).json({
        ok: false,
        error: `no seasonality data available for ${symbol} (insufficient history or fetch failure)`,
      });
    }
    res.json({ ok: true, seasonality });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message ?? "seasonality_compute_failed") });
  }
});

export default router;
