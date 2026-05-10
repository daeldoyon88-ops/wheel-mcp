/**
 * Adaptive Calibration Routes — Phase 4B-PREP
 *
 * READ-ONLY DIAGNOSTIC ENDPOINTS. DORMANT MODE.
 *
 * NOT connected to:
 *   - Live scanner (appliedToScanner: false)
 *   - Shortlist ranking (appliedToRanking: false)
 *   - EliteScore (appliedToEliteScore: false)
 *   - IBKR
 *   - Yahoo live fetch
 *
 * All feature flags are false by default.
 * No scanner behaviour is modified by mounting these routes.
 */

import { Router } from "express";
import { createAdaptiveCalibrationEngine } from "./adaptiveCalibrationEngine.js";

// ─── Feature flags — Phase 4B-PREP ───────────────────────────────────────────
// All false by default. Environment variables can never flip scanner hooks here.
function readFlag(name) {
  return String(process.env[name] || "false").trim().toLowerCase() === "true";
}

const FLAGS = {
  ENABLE_ADAPTIVE_CALIBRATION: readFlag("ENABLE_ADAPTIVE_CALIBRATION"),
  ENABLE_SEASONALITY_SCAN_HOOK: readFlag("ENABLE_SEASONALITY_SCAN_HOOK"),
  ENABLE_MARKET_CONTEXT_SCAN_HOOK: readFlag("ENABLE_MARKET_CONTEXT_SCAN_HOOK"),
  ENABLE_ADAPTIVE_SCANNER_OVERLAY: readFlag("ENABLE_ADAPTIVE_SCANNER_OVERLAY"),
};

// Safety contract — hard-coded false, never derived from flags or env
const SAFETY = Object.freeze({
  appliedToScanner: false,
  appliedToRanking: false,
  appliedToEliteScore: false,
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export default function createAdaptiveCalibrationRoutes({ store }) {
  const router = Router();
  const engine = createAdaptiveCalibrationEngine({ store });
  const engineLoaded = engine != null;

  // ── GET /calibration/adaptive/safety-status ──────────────────────────────
  // Proves — in black and white — that nothing is activated.
  router.get("/adaptive/safety-status", async (_req, res) => {
    try {
      const counts =
        typeof store?.getJournalCounts === "function"
          ? await store.getJournalCounts()
          : { total: null, resolved: null, unresolved: null };

      return res.json({
        ok: true,
        mode: "read_only",
        adaptiveEngineLoaded: engineLoaded,
        scannerHookEnabled: false,
        seasonalityHookEnabled: false,
        marketContextHookEnabled: false,
        adaptiveOverlayEnabled: false,
        ...SAFETY,
        flags: FLAGS,
        journalStore: store?.sqlitePath ? "sqlite" : store ? "json" : "none",
        journalRecordCount: counts.total,
        resolvedRecordCount: counts.resolved,
        unresolvedRecordCount: counts.unresolved,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "safety_status_failed",
      });
    }
  });

  // ── GET /calibration/adaptive/portfolio ──────────────────────────────────
  // Portfolio-wide diagnostic. Reads resolved journal records only.
  router.get("/adaptive/portfolio", async (_req, res) => {
    try {
      const data = await engine.computePortfolioDiagnostic();
      const warnings = [];
      if ((data?.overall?.total_resolved ?? 0) < 10)
        warnings.push("low_sample_size: fewer than 10 resolved records in journal");
      if ((data?.overall?.tickers_with_data ?? 0) === 0)
        warnings.push("no_tickers_with_sufficient_data");

      return res.json({
        ok: true,
        mode: "read_only",
        ...SAFETY,
        data,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "portfolio_diagnostic_failed",
      });
    }
  });

  // ── GET /calibration/adaptive/ticker/:ticker ─────────────────────────────
  // Per-ticker diagnostic. No live fetch.
  router.get("/adaptive/ticker/:ticker", async (req, res) => {
    try {
      const ticker = String(req.params.ticker ?? "").trim().toUpperCase();
      if (!ticker)
        return res.status(400).json({ ok: false, error: "ticker_required" });

      const data = await engine.computeTickerDiagnostic(ticker);
      const warnings = [];
      if (!data)
        warnings.push("no_data: no resolved records found for this ticker");
      else if ((data.sample_size ?? 0) < 5)
        warnings.push(`low_sample_size: only ${data.sample_size} resolved records`);

      return res.json({
        ok: true,
        mode: "read_only",
        ...SAFETY,
        ticker,
        data: data ?? null,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "ticker_diagnostic_failed",
      });
    }
  });

  // ── GET /calibration/adaptive/recommendation/:ticker ─────────────────────
  // Theoretical recommendation. NOT applied to scanner. Optional ?regime= query.
  router.get("/adaptive/recommendation/:ticker", async (req, res) => {
    try {
      const ticker = String(req.params.ticker ?? "").trim().toUpperCase();
      if (!ticker)
        return res.status(400).json({ ok: false, error: "ticker_required" });

      const marketRegime = req.query.regime
        ? String(req.query.regime).trim()
        : undefined;

      const data = await engine.computeRecommendation(ticker, marketRegime, null);
      const warnings = [];
      if (data?.confidence_reason === "insufficient_sample_size")
        warnings.push("insufficient_sample_size: recommendation is theoretical only");

      return res.json({
        ok: true,
        mode: "read_only",
        ...SAFETY,
        ticker,
        marketRegime: marketRegime ?? null,
        data,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "recommendation_failed",
      });
    }
  });

  // ── GET /calibration/summary/tickers ────────────────────────────────────
  // Reads calibration_ticker_summary table. Returns [] if empty.
  router.get("/summary/tickers", async (_req, res) => {
    try {
      const rows =
        typeof store?.readCalibrationTickerSummary === "function"
          ? await store.readCalibrationTickerSummary()
          : [];

      return res.json({
        ok: true,
        mode: "read_only",
        ...SAFETY,
        count: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "summary_tickers_failed",
      });
    }
  });

  // ── GET /calibration/summary/market-regimes ──────────────────────────────
  // Reads calibration_market_regime_summary table. Returns [] if empty.
  router.get("/summary/market-regimes", async (_req, res) => {
    try {
      const rows =
        typeof store?.readCalibrationMarketRegimeSummary === "function"
          ? await store.readCalibrationMarketRegimeSummary()
          : [];

      return res.json({
        ok: true,
        mode: "read_only",
        ...SAFETY,
        count: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "summary_market_regimes_failed",
      });
    }
  });

  // ── POST /calibration/summary/recompute ──────────────────────────────────
  // Manual-only. Reads journal → writes summary tables. No scanner, no live fetch.
  router.post("/summary/recompute", async (_req, res) => {
    try {
      const tickerResults = await engine.computeAndPersistTickerSummary();
      const regimeResults = await engine.computeAndPersistMarketRegimeSummary();

      return res.json({
        ok: true,
        mode: "read_only",
        ...SAFETY,
        tickersRecomputed: tickerResults.length,
        regimesRecomputed: regimeResults.length,
        note: "Manual recompute from journal only. No scanner invoked, no live data fetched.",
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error?.message || "recompute_failed",
      });
    }
  });

  return router;
}
