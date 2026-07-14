import test from "node:test";
import assert from "node:assert/strict";
import { __testables__ } from "./wheelValidationService.js";
import { buildOptionQuoteSnapshot } from "./optionQuoteSnapshot.js";

const { computeStaleQuoteFlag, normalizeRecord } = __testables__;

function strikeRow({ spreadPct, bid = 1.0, ask = 1.02, liquiditySpreadPct = null } = {}) {
  const row = { strike: 50, bid, ask, mid: (bid + ask) / 2 };
  if (spreadPct != null) row.spreadPct = spreadPct;
  if (liquiditySpreadPct != null) row.liquidity = { spreadPct: liquiditySpreadPct };
  return row;
}

const spreadCases = [
  { label: "0 %", spreadPct: 0, expected: false },
  { label: "0,5 %", spreadPct: 0.5, expected: false },
  { label: "2,56 %", spreadPct: 2.56, expected: false },
  { label: "49,99 %", spreadPct: 49.99, expected: false },
  { label: "50 %", spreadPct: 50, expected: false },
  { label: "50,01 %", spreadPct: 50.01, expected: true },
  { label: "100 %", spreadPct: 100, expected: true },
];

for (const { label, spreadPct, expected } of spreadCases) {
  test(`computeStaleQuoteFlag — spread ${label} → ${expected ? "stale" : "non stale"}`, () => {
    assert.equal(computeStaleQuoteFlag(strikeRow({ spreadPct })), expected);
  });
}

test("computeStaleQuoteFlag — spread via liquidity.spreadPct", () => {
  assert.equal(
    computeStaleQuoteFlag({ strike: 50, bid: 1, ask: 1.1, liquidity: { spreadPct: 55 } }),
    true
  );
});

test("computeStaleQuoteFlag — bid+ask absents → stale (donnée manquante)", () => {
  assert.equal(computeStaleQuoteFlag({ strike: 50, spreadPct: 2 }), true);
});

test("computeStaleQuoteFlag — spread absent, bid+ask présents → non stale", () => {
  assert.equal(computeStaleQuoteFlag({ strike: 50, bid: 1, ask: 1.02 }), false);
});

test("computeStaleQuoteFlag — spread invalide ignoré, bid+ask présents → non stale", () => {
  assert.equal(computeStaleQuoteFlag({ strike: 50, bid: 1, ask: 1.02, spreadPct: "n/a" }), false);
});

test("computeStaleQuoteFlag — un seul côté du book présent → non stale si spread OK", () => {
  assert.equal(computeStaleQuoteFlag({ strike: 50, bid: 1, ask: null, spreadPct: 3 }), false);
  assert.equal(computeStaleQuoteFlag({ strike: 50, bid: null, ask: 1.02, spreadPct: 3 }), false);
});

test("normalizeRecord — stale_quote_flag reflète le seuil spread corrigé", () => {
  const scanTimestamp = "2026-07-13T16:01:00.000Z";
  const candidate = {
    symbol: "TQQQ",
    expiration: "20260717",
    safeStrike: { strike: 70, bid: 0.85, ask: 0.88, spreadPct: 3.5, premiumUsed: 0.85 },
  };
  const record = normalizeRecord(candidate, "safe", scanTimestamp, "20260713_120106", {
    selectedExpiration: "20260717",
    captureSource: "ibkr_auto_final",
  });
  assert.equal(record.stale_quote_flag, false);
});

test("normalizeRecord — spread excessif → stale_quote_flag true", () => {
  const candidate = {
    symbol: "TQQQ",
    expiration: "20260717",
    safeStrike: { strike: 70, bid: 0.10, ask: 0.30, spreadPct: 75, premiumUsed: 0.10 },
  };
  const record = normalizeRecord(candidate, "safe", "2026-07-13T16:01:00.000Z", "sess", {
    selectedExpiration: "20260717",
  });
  assert.equal(record.stale_quote_flag, true);
});

test("optionQuoteSnapshot — quote ancienne + spread propre : fraîcheur stale, flag journal séparé", () => {
  const scanTimestamp = "2026-07-13T16:01:00.000Z";
  const candidate = {
    symbol: "TQQQ",
    source: "IBKR",
    expiration: "20260717",
    ibkrDirect: {
      scanCompletedAt: "2026-07-13T14:00:00.000Z",
      putCandidates: [
        {
          strike: 70,
          bid: 0.85,
          ask: 0.88,
          mid: 0.865,
          quoteTimestamp: "2026-07-13T14:00:00.000Z",
        },
      ],
    },
    safeStrike: { strike: 70, bid: 0.85, ask: 0.88, spreadPct: 3.5 },
  };
  const snapshot = buildOptionQuoteSnapshot({
    candidate,
    strikeMode: "safe",
    scanTimestamp,
    strikeRow: candidate.safeStrike,
  });
  assert.equal(snapshot.quote.isStale, true);
  assert.equal(snapshot.quote.staleReason, "quote_older_than_scan_threshold");
  assert.equal(computeStaleQuoteFlag(candidate.safeStrike), false);
});

test("optionQuoteSnapshot — quote récente + spread excessif : flag journal stale", () => {
  const scanTimestamp = "2026-07-13T16:01:00.000Z";
  const strike = { strike: 70, bid: 0.10, ask: 0.30, spreadPct: 80 };
  const snapshot = buildOptionQuoteSnapshot({
    candidate: {
      symbol: "TQQQ",
      source: "IBKR",
      expiration: "20260717",
      ibkrDirect: {
        scanCompletedAt: "2026-07-13T16:00:50.000Z",
        putCandidates: [
          { strike: 70, bid: 0.10, ask: 0.30, mid: 0.20, quoteTimestamp: "2026-07-13T16:00:50.000Z" },
        ],
      },
      safeStrike: strike,
    },
    strikeMode: "safe",
    scanTimestamp,
    strikeRow: strike,
  });
  assert.equal(snapshot.quote.isStale, false);
  assert.equal(computeStaleQuoteFlag(strike), true);
});
