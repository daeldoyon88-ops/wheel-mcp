/**
 * Seasonality Routes V1 — read-only, additive endpoints.
 * Mounted at /seasonality in server.js.
 * Zero impact on existing scanner, IBKR, or journal routes.
 */

import { Router } from "express";
import {
  computeSeasonality,
  computeSeasonalityCalendar,
  computeSeasonalityScanSummary,
  getSeasonalityCacheStats,
  getSeasonalityDiagnostic,
} from "./seasonalityEngine.js";

const router   = Router();
const TICKER_RE = /^[A-Z0-9.\-^]{1,10}$/;

// NOTE: specific routes must be registered BEFORE the /:ticker param route
// so Express matches them before the wildcard.

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
