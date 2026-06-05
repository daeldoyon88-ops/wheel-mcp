import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTickerScanMemoryStore, classifyScanOutcome } from "./tickerScanMemoryStore.js";

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsm-test-"));
  return path.join(dir, "journal.sqlite");
}

test("classifyScanOutcome — mappe statuts et raisons", () => {
  assert.equal(classifyScanOutcome({ status: "kept" }), "retained");
  assert.equal(classifyScanOutcome({ status: "rejected", reason: "spread_too_wide" }), "rejected");
  assert.equal(classifyScanOutcome({ status: "timeout" }), "no_data");
  assert.equal(classifyScanOutcome({ status: "error", reason: "ibkr_unavailable" }), "no_data");
  assert.equal(classifyScanOutcome({ status: "error", reason: "no_market_data" }), "no_data");
  assert.equal(
    classifyScanOutcome({ status: "rejected", reason: "no_safe_candidate_meets_min_premium" }),
    "rejected"
  );
});

test("recordScan — compteurs, consécutifs et EWMA", async () => {
  const store = createTickerScanMemoryStore({ sqlitePath: tmpDbPath() });

  // Scan 1 : AAA retenu, BBB rejeté (spread), CCC rejeté (premium).
  const r1 = await store.recordScan({
    scanTimestamp: "2026-06-01T00:00:00.000Z",
    entries: [
      { symbol: "AAA", status: "kept", spreadPct: 0.04, premiumYield: 0.01, yahooRank: 1 },
      { symbol: "BBB", status: "rejected", reason: "spread_too_wide", yahooRank: 2 },
      { symbol: "CCC", status: "rejected", reason: "no_safe_candidate_meets_min_premium", yahooRank: 3 },
    ],
  });
  assert.equal(r1.skipped, false);
  assert.equal(r1.updated, 3);

  // Scan 2 : BBB encore rejeté spread, AAA pas de data.
  await store.recordScan({
    scanTimestamp: "2026-06-02T00:00:00.000Z",
    entries: [
      { symbol: "AAA", status: "error", reason: "timeout", yahooRank: 1 },
      { symbol: "BBB", status: "rejected", reason: "spread_too_wide", yahooRank: 2 },
    ],
  });

  const aaa = await store.getSymbol("AAA");
  assert.equal(aaa.timesSentIbkr, 2);
  assert.equal(aaa.timesIbkrRetained, 1);
  assert.equal(aaa.timesNoData, 1);
  assert.equal(aaa.consecutiveNoData, 1);
  assert.equal(aaa.consecutiveRejects, 0);
  assert.equal(aaa.lastRetainedAt, "2026-06-01T00:00:00.000Z");

  const bbb = await store.getSymbol("BBB");
  assert.equal(bbb.timesIbkrRejected, 2);
  assert.equal(bbb.consecutiveRejects, 2);
  assert.equal(bbb.consecutiveWideSpread, 2);
  assert.equal(bbb.mainRejectReason, "spread_too_wide");
  assert.equal(bbb.rejectReasonCounts.spread_too_wide, 2);

  const ccc = await store.getSymbol("CCC");
  assert.equal(ccc.consecutiveNoPremium, 1);
  assert.equal(ccc.consecutiveWideSpread, 0);
});

test("recordScan — garde-fou ibkrSuspiciousEmpty (aucune écriture)", async () => {
  const store = createTickerScanMemoryStore({ sqlitePath: tmpDbPath() });
  const res = await store.recordScan({
    suspiciousEmpty: true,
    entries: [{ symbol: "AAA", status: "kept" }],
  });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "ibkr_suspicious_empty");
  assert.equal(await store.getSymbol("AAA"), null);
});

test("recordScan — garde-fou batch entièrement no_data (pas de pénalité)", async () => {
  const store = createTickerScanMemoryStore({ sqlitePath: tmpDbPath() });
  const res = await store.recordScan({
    entries: [
      { symbol: "AAA", status: "error", reason: "ibkr_unavailable" },
      { symbol: "BBB", status: "timeout" },
    ],
  });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "batch_ibkr_failure");
  assert.equal(await store.getSymbol("AAA"), null);
});

test("getSummary — agrège les top listes", async () => {
  const store = createTickerScanMemoryStore({ sqlitePath: tmpDbPath() });
  await store.recordScan({
    entries: [
      { symbol: "AAA", status: "kept", yahooRank: 1 },
      { symbol: "BBB", status: "rejected", reason: "spread_too_wide", yahooRank: 2 },
    ],
  });
  const summary = await store.getSummary({ minTests: 1 });
  assert.equal(summary.totalTickers, 2);
  assert.equal(summary.topRetained[0].symbol, "AAA");
  assert.equal(summary.topRejected[0].symbol, "BBB");
  assert.equal(summary.topRejectReasons[0].reason, "spread_too_wide");
  assert.ok(summary.neverRetained.some((r) => r.symbol === "BBB"));
});
