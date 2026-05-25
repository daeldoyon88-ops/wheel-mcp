import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOptionQuoteSnapshot,
  enrichRecordWithOptionQuoteFields,
  parseOptionQuoteSnapshot,
  summarizeOptionQuoteDiagnostics,
} from "./optionQuoteSnapshot.js";
import { computeOnePercentWheelProfiles } from "./wheelValidationService.js";

test("buildOptionQuoteSnapshot — IBKR complet", () => {
  const scanTimestamp = "2026-05-24T15:00:00.000Z";
  const candidate = {
    symbol: "SOXL",
    source: "IBKR",
    optionsSource: "IBKR live",
    currentPrice: 28.5,
    expectedMove: 2.1,
    lowerBound: 26.4,
    dteAtScan: 5,
    expiration: "20260530",
    ibkrDirect: {
      underlyingPrice: 28.5,
      scanCompletedAt: "2026-05-24T14:59:50.000Z",
      safeStrike: { strike: 26, bid: 0.42, ask: 0.44, mid: 0.43, spreadPct: 0.047 },
      putCandidates: [
        { strike: 26, bid: 0.42, ask: 0.44, mid: 0.43, volume: 120, openInterest: 800 },
      ],
    },
    safeStrike: { strike: 26, bid: 0.4, ask: 0.45, mid: 0.425, impliedVolatility: 0.62, popEstimate: 0.91 },
  };
  const snapshot = buildOptionQuoteSnapshot({
    candidate,
    strikeMode: "safe",
    scanTimestamp,
    strikeRow: candidate.safeStrike,
  });
  assert.equal(snapshot.primaryOptionDataSource, "IBKR");
  assert.equal(snapshot.quote.bid, 0.42);
  assert.equal(snapshot.quote.ask, 0.44);
  assert.equal(snapshot.liquidity.openInterest, 800);
  const diag = summarizeOptionQuoteDiagnostics({ optionQuoteSnapshot: snapshot });
  assert.equal(diag.hasObservedIbkrOptionData, true);
  assert.ok(diag.optionDataCompletenessPct >= 50);
});

test("buildOptionQuoteSnapshot — sans snapshot record compatible", () => {
  const record = { symbol: "OLD", strike: { strike: 10, bid: 0.5 } };
  const diag = summarizeOptionQuoteDiagnostics(record);
  assert.equal(diag.hasObservedIbkrOptionData, false);
  assert.equal(diag.optionSnapshotStorageStatus, "snapshot_absent");
  assert.ok(Array.isArray(diag.optionDataMissingFields));
  assert.ok(diag.optionDataMissingFields.length > 0);
  const enriched = enrichRecordWithOptionQuoteFields(record);
  assert.equal(enriched.hasObservedIbkrOptionData, false);
  assert.doesNotThrow(() => JSON.stringify(enriched));
});

test("buildOptionQuoteSnapshot — Yahoo fallback pas IBKR observé", () => {
  const candidate = {
    symbol: "AAPL",
    raw: { expiration: "20260606" },
    techniqueSource: "Yahoo",
    currentPrice: 200,
    safeStrike: { strike: 190, bid: 1.2, ask: 1.25, mid: 1.225, impliedVolatility: 0.25 },
  };
  const snapshot = buildOptionQuoteSnapshot({
    candidate,
    strikeMode: "safe",
    scanTimestamp: "2026-05-24T16:00:00.000Z",
    strikeRow: candidate.safeStrike,
  });
  const diag = summarizeOptionQuoteDiagnostics({ optionQuoteSnapshot: snapshot });
  assert.equal(diag.hasObservedIbkrOptionData, false);
  assert.equal(snapshot.dataConfidence, "observed_yahoo");
  assert.ok(snapshot.warnings.includes("source_fallback_yahoo"));
});

test("parseOptionQuoteSnapshot — round-trip JSON SQLite", () => {
  const snapshot = { source: "IBKR", quote: { bid: 1, ask: 1.1 }, dataConfidence: "observed_ibkr" };
  const json = JSON.stringify(snapshot);
  const parsed = parseOptionQuoteSnapshot({ option_quote_snapshot_json: json });
  assert.equal(parsed.quote.bid, 1);
});

test("computeOnePercentWheelProfiles — verdict inchangé avec snapshot présent", () => {
  const records = Array.from({ length: 35 }, (_, index) => ({
    symbol: "SNAP",
    strikeMode: "safe",
    expiration: `202502${String(10 + (index % 20)).padStart(2, "0")}`,
    scanDate: `202502${String((index % 28) + 1).padStart(2, "0")}`,
    captureClass: "primaryDaily",
    strike: { strike: 100, popEstimate: 0.92, bid: 1 },
    resolution: {
      resolved: true,
      assigned: false,
      expiredWorthless: true,
      popPredictionCorrect: true,
      underlying_close_at_expiration: 102,
    },
  }));
  const without = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const withSnapshot = computeOnePercentWheelProfiles(
    records.map((r) => ({
      ...r,
      optionQuoteSnapshot: {
        source: "IBKR",
        dataConfidence: "observed_ibkr",
        quote: { bid: 1, ask: 1.05, freshnessLabel: "fraîche" },
        greeks: { impliedVolatility: 0.4, delta: -0.2 },
      },
    })),
    [],
    { today: "2026-05-24" }
  );
  const p0 = without.profiles.find((p) => p.ticker === "SNAP");
  const p1 = withSnapshot.profiles.find((p) => p.ticker === "SNAP");
  assert.equal(p0?.primaryVerdict, p1?.primaryVerdict);
  assert.deepEqual(p0?.verdicts, p1?.verdicts);
});

test("snapshot minimal — pas de chaîne options massive", () => {
  const candidate = {
    symbol: "TQQQ",
    ibkrDirect: {
      putCandidates: Array.from({ length: 200 }, (_, i) => ({ strike: 40 - i * 0.5, bid: 0.1 })),
      safeStrike: { strike: 38, bid: 0.5, ask: 0.52 },
    },
    safeStrike: { strike: 38, bid: 0.5, ask: 0.52 },
  };
  const snapshot = buildOptionQuoteSnapshot({
    candidate: {
      ...candidate,
      ibkrSafePutRow: { strike: 38, bid: 0.5, ask: 0.52 },
    },
    strikeMode: "safe",
    scanTimestamp: new Date().toISOString(),
    strikeRow: candidate.safeStrike,
  });
  const json = JSON.stringify(snapshot);
  assert.ok(json.length < 5000, `snapshot trop volumineux: ${json.length} o`);
  assert.equal(Array.isArray(snapshot.putCandidates), false);
});
