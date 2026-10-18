import assert from "node:assert/strict";
import test from "node:test";

import {
  FORENSIC_SCHEMA_VERSION,
  FORENSIC_UNITS,
  classifyQuoteValue,
  describeQuoteObservation,
  finiteObservationOrNull,
  pickIbkrForensicDiagnostics,
  positiveFiniteOrNull,
  projectForensicTrace,
} from "./forensicObservation.js";

test("finiteObservationOrNull distingue null/vide/non numérique du vrai zéro", () => {
  assert.equal(finiteObservationOrNull(null), null);
  assert.equal(finiteObservationOrNull(""), null);
  assert.equal(finiteObservationOrNull("   "), null);
  assert.equal(finiteObservationOrNull(undefined), null);
  assert.equal(finiteObservationOrNull("abc"), null);
  assert.equal(finiteObservationOrNull(true), null);
  assert.equal(finiteObservationOrNull(0), 0);
  assert.equal(finiteObservationOrNull("0"), 0);
  assert.equal(finiteObservationOrNull(0.123456789), 0.123457);
});

test("positiveFiniteOrNull refuse strike 0 / null / négatif", () => {
  assert.equal(positiveFiniteOrNull(null), null);
  assert.equal(positiveFiniteOrNull(0), null);
  assert.equal(positiveFiniteOrNull(-1), null);
  assert.equal(positiveFiniteOrNull(42), 42);
});

test("classifyQuoteValue et describeQuoteObservation — bid 0 vs absent vs ask invalide", () => {
  assert.equal(classifyQuoteValue(null), "absent");
  assert.equal(classifyQuoteValue(0), "zero");
  assert.equal(classifyQuoteValue("x"), "non_numeric");
  assert.equal(classifyQuoteValue(0.5), "positive");
  const zero = describeQuoteObservation(0, 0.2);
  assert.equal(zero.usable, false);
  assert.equal(zero.unusableReason, "bid_zero");
  const absent = describeQuoteObservation(null, 0.2);
  assert.equal(absent.usable, false);
  assert.equal(absent.unusableReason, "bid_absent");
  const crossed = describeQuoteObservation(1, 0.5);
  assert.equal(crossed.usable, false);
  assert.equal(crossed.unusableReason, "ask_below_bid");
  const ok = describeQuoteObservation(0.8, 0.9);
  assert.equal(ok.usable, true);
  assert.equal(ok.unusableReason, null);
});

test("unités déclarées : spreads = fraction, pas pourcentage silencieux", () => {
  assert.equal(FORENSIC_UNITS.aggressiveSpreadPct, "fraction_0_to_1");
  assert.equal(FORENSIC_UNITS.bestSafeSpreadPct, "fraction_0_to_1");
  assert.equal(FORENSIC_UNITS.aggressiveYieldPct, "percent");
  assert.equal(FORENSIC_SCHEMA_VERSION, "ibkr_rejection_forensics_v2");
});

test("pickIbkrForensicDiagnostics relais sans fabriquer de zéro ni de code droits", () => {
  const empty = pickIbkrForensicDiagnostics({});
  assert.equal(empty.errorDetail, null);
  assert.equal(empty.failureStage, null);
  assert.equal(empty.marketDataTypeReceivedLabel, "unknown");
  assert.equal(empty.forensicTrace, null);
  const row = {
    errorDetail: "atm_straddle_quotes_missing",
    failureStage: "atm_quotes_missing",
    marketDataTypeRequested: 2,
    marketDataTypeRequestedLabel: "frozen",
    ibkrCallMetrics: {
      safeScanStoppedReason: "no_bid_ask_fast_abort",
      validPutContractsChecked: 0,
      unusableQuoteStreak: 3,
    },
    forensicTrace: {
      schemaVersion: 1,
      quoteTrace: [{ seq: 1, bidRaw: 0, askRaw: 0.2, bidStatus: "zero" }],
      quoteTraceCount: 1,
    },
  };
  const d = pickIbkrForensicDiagnostics(row);
  assert.equal(d.errorDetail, "atm_straddle_quotes_missing");
  assert.equal(d.safeScanStoppedReason, "no_bid_ask_fast_abort");
  assert.equal(d.forensicTrace.quoteTraceCount, 1);
  assert.equal(d.forensicTrace.quoteTrace[0].bidRaw, 0);
});

test("projectForensicTrace borne et préserve truncated", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, bidRaw: i === 0 ? null : 0.1 }));
  const t0 = performance.now();
  const projected = projectForensicTrace({ quoteTrace: many, quoteTraceCount: 30, quoteTraceTruncated: false });
  const elapsed = performance.now() - t0;
  assert.equal(projected.quoteTrace.length, 24);
  assert.equal(projected.quoteTraceTruncated, true);
  assert.equal(projected.quoteTrace[0].bidRaw, null);
  assert.ok(elapsed < 20, `projection trop lente: ${elapsed}ms`);
});
