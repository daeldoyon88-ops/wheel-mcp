/**
 * Capital Combination Routes — Phase 4D
 *
 * READ-ONLY DIAGNOSTIC ENDPOINTS.  PASSIVE MODE.
 *
 * SAFETY CONTRACT (hard-coded, never derived from env or flags):
 *   appliedToScanner    : false — scanner is NOT modified
 *   appliedToRanking    : false — ranking is NOT modified
 *   appliedToEliteScore : false — EliteScore is NOT modified
 *   scannerModified     : false
 *   noLiveFetch         : true  — no Yahoo / IBKR call inside these routes
 *   noIbkrFetch         : true
 *   noYahooFetch        : true
 *
 * Endpoints:
 *   GET  /capital-combinations/safety-status
 *   POST /capital-combinations/audit
 *   POST /capital-combinations/snapshot
 *   GET  /capital-combinations/history
 *   GET  /capital-combinations/stats
 *   GET  /capital-combinations/latest-full   ← V2E feed (read-only)
 */

import { Router } from "express";
import { auditCapitalCombination } from "./capitalCombinationAuditService.js";
import { createCapitalCombinationStore } from "./capitalCombinationStore.js";

// ─── Safety contract — immutable ──────────────────────────────────────────────
const SAFETY = Object.freeze({
  appliedToScanner: false,
  appliedToRanking: false,
  appliedToEliteScore: false,
  scannerModified: false,
  noLiveFetch: true,
  noIbkrFetch: true,
  noYahooFetch: true,
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export default function createCapitalCombinationRoutes(options = {}) {
  const router = Router();
  const store = createCapitalCombinationStore(options);

  // Fire-and-forget table init on mount so first requests are fast.
  let tablesReady = false;
  store
    .ensureInitialized()
    .then(() => {
      tablesReady = true;
      console.log("[capital-combinations] SQLite tables ready (phase 4D)");
    })
    .catch((err) => {
      console.warn("[capital-combinations] DB init warning:", err?.message ?? err);
    });

  // ── GET /capital-combinations/safety-status ────────────────────────────────
  //
  // Proves — in black and white — that this module is passive.
  // No scanner, no ranking, no EliteScore, no live fetch.

  router.get("/safety-status", async (_req, res) => {
    try {
      const ready = tablesReady || (await store.getTablesReady());
      return res.json({
        ok: true,
        mode: "read_only",
        phase: "4D",
        description: "Capital Combination Audit — passive audit layer, no scanner hook",
        ...SAFETY,
        dbTablesReady: ready,
        tables: [
          "capital_combination_snapshots",
          "capital_combination_modes",
          "capital_combination_positions",
          "capital_combination_outcomes",
        ],
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? err), ...SAFETY });
    }
  });

  // ── POST /capital-combinations/audit ──────────────────────────────────────
  //
  // Accepts a combination payload, returns full audit report.
  // NO persistence. NO scanner call. NO live data fetch.
  //
  // Body (example — French or English aliases accepted):
  // {
  //   "accountCapital": 25500,
  //   "aggressive":    { "picks": [...] },
  //   "balanced":      { "picks": [...] },
  //   "conservative":  { "picks": [...] }
  // }

  router.post("/audit", async (req, res) => {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return res.status(400).json({
          ok: false,
          error: "Body must be a non-array JSON object",
          example: {
            accountCapital: 25500,
            aggressive: { picks: [{ ticker: "SOFI", strike: 15, premiumUnit: 0.13, contracts: 3, capitalUsed: 4500, premiumCollected: 39, weeklyReturn: 0.867 }] },
            balanced: { picks: [] },
            conservative: { picks: [] },
          },
        });
      }

      const result = auditCapitalCombination(payload);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? err), ...SAFETY });
    }
  });

  // ── POST /capital-combinations/snapshot ───────────────────────────────────
  //
  // Audits + persists one snapshot to SQLite.
  // Does NOT modify the scanner, ranking, or any existing record.

  router.post("/snapshot", async (req, res) => {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return res.status(400).json({ ok: false, error: "Body must be a non-array JSON object" });
      }

      const auditResult = auditCapitalCombination(payload);
      const { snapshotId, modeIds } = await store.saveSnapshot(payload, auditResult);

      return res.json({
        ok: true,
        snapshotId,
        modeIds,
        audit: auditResult,
        persisted: true,
        ...SAFETY,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message ?? err), ...SAFETY });
    }
  });

  // ── GET /capital-combinations/history ─────────────────────────────────────
  //
  // Returns the list of persisted combination snapshots.
  // Query param: limit (default 50, max 200)

  router.get("/history", async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
      const rows = await store.getHistory(limit);
      return res.json({ ok: true, count: rows.length, history: rows, ...SAFETY });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err?.message ?? err),
        history: [],
        ...SAFETY,
      });
    }
  });

  // ── GET /capital-combinations/stats ───────────────────────────────────────
  //
  // Returns aggregated statistics per mode (yield, utilization, risk score,
  // assignment rate, etc.).  Returns nulls/empty arrays when tables are empty.

  router.get("/stats", async (_req, res) => {
    try {
      const stats = await store.getStats();
      return res.json({ ok: true, ...stats, ...SAFETY });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err?.message ?? err),
        totalSnapshots: 0,
        modeStats: [],
        outcomeStats: [],
        ...SAFETY,
      });
    }
  });

  // ── GET /capital-combinations/latest-full ─────────────────────────────────
  //
  // V2E feed — returns the most recent snapshot with its modes and positions.
  // READ-ONLY: no INSERT / UPDATE / DELETE, no scanner call, no live fetch.
  //
  // Response shape:
  //   { ok, snapshot: { id, scan_date, ... }, modes: [{ mode, ..., positions: [...] }] }
  //   { ok, snapshot: null, modes: [], message } when tables are empty

  router.get("/latest-full", async (_req, res) => {
    try {
      const result = await store.getLatestFullCapitalCombination();
      if (!result) {
        return res.json({
          ok: true,
          snapshot: null,
          modes: [],
          message: "No capital combination snapshots found",
          ...SAFETY,
        });
      }
      return res.json({
        ok: true,
        snapshot: result.snapshot,
        modes: result.modes,
        ...SAFETY,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String(err?.message ?? err),
        snapshot: null,
        modes: [],
        ...SAFETY,
      });
    }
  });

  return router;
}
