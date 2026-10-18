import assert from "node:assert/strict";
import test from "node:test";

import {
  atmSpreadToLiquidityScore,
  buildScanFunnelDiagnosticsV1,
  buildWatchlistYahooFunnelFlags,
  classifyYahooNonTransmission,
  computePreIbkrConfidenceScore,
  isYahooFunnelDiagnosticsV1Enabled,
  rejectionStageFromWatchlistReason,
} from "./yahooFunnelDiagnosticsV1.js";

test("atmSpreadToLiquidityScore — stable et monotone (spread bas = score plus haut)", () => {
  const a = atmSpreadToLiquidityScore(4);
  const b = atmSpreadToLiquidityScore(18);
  assert.ok(a != null && b != null);
  assert.ok(a > b);
});

test("rejectionStageFromWatchlistReason — regroupe raisons connues", () => {
  assert.equal(rejectionStageFromWatchlistReason("above_max_price"), "price_filter");
  assert.equal(rejectionStageFromWatchlistReason("liquid_options_otm_probe_failed"), "yahoo_liquidity");
});

test("computePreIbkrConfidenceScore — même entrée → même sortie (pas de Date)", () => {
  const item = {
    passesFilter: true,
    noYahooLiquidity: false,
    safeStrike: {
      conservativePremium: 1.2,
      annualizedYield: 0.3,
      liquidity: { spreadPct: 8 },
    },
    targetPremium: 1,
    expectedMoveIncomplete: false,
    supportStatusUsedByQualityScore: "strike_below_support",
    hasUpcomingEarningsBeforeExpiration: false,
    diagnosticsV12: { ivHvEdge: true },
    debug: { strikeDebug: { putsTotalCount: 20, putsBelowLowerBoundWithBidCount: 4 } },
  };
  const a = computePreIbkrConfidenceScore(item);
  const b = computePreIbkrConfidenceScore(item);
  assert.deepEqual(a, b);
  assert.ok(a.preIbkrConfidenceScore >= 0 && a.preIbkrConfidenceScore <= 100);
});

test("buildWatchlistYahooFunnelFlags — excluded_by_limit_but_viable quand proche cutoff", () => {
  const wf = buildWatchlistYahooFunnelFlags(
    {
      rankBeforeLimit: 40,
      watchlistScore: 62,
      sortScore: 60,
      excludedByLimit: true,
      atmLiquidityScore: 50,
    },
    { limitCutoffSortScore: 60 }
  );
  assert.equal(wf.excluded_by_limit_but_viable, true);
  assert.ok(wf.yahoo_funnel_flags_v1.includes("excluded_by_limit_but_viable"));
});

test("buildScanFunnelDiagnosticsV1 — overflow shortlist vs rejects, JSON stable", () => {
  const scanBySymbol = new Map();
  const okItem = {
    symbol: "AAA",
    ok: true,
    passesFilter: true,
    qualityScore: 10,
    finalScore: 0.02,
    safeStrike: {
      conservativePremium: 1,
      annualizedYield: 0.28,
      liquidity: { spreadPct: 7 },
    },
    targetPremium: 0.9,
    expectedMoveIncomplete: false,
    supportStatusLegacy: "strike_below_support",
    supportStatusV2: "below_support",
    qualityScoreDeltaLegacyVsV2: 0,
    noYahooLiquidity: false,
    debug: {
      passesPremiumTarget: true,
      passesLiquidity: true,
      strikeDebug: { putsTotalCount: 10, putsBelowLowerBoundWithBidCount: 2 },
    },
    diagnosticsV12: {},
  };
  scanBySymbol.set("AAA", okItem);
  scanBySymbol.set("BBB", {
    symbol: "BBB",
    ok: false,
    reason: "expiration_not_available",
  });

  const diag = buildScanFunnelDiagnosticsV1({
    cleanedTickers: ["AAA", "BBB"],
    shortlistFullSorted: [okItem],
    rejected: [{ symbol: "BBB", reason: "expiration_not_available" }],
    errors: [],
    scanBySymbol,
    returnLimit: 20,
    completedScanCount: 2,
  });

  assert.equal(diag.inputTickerCount, 2);
  assert.equal(diag.scannedTickerCount, 2);
  assert.equal(diag.passedTickerCount, 1);
  assert.equal(diag.rejectedCandidatesDetailed.length >= 1, true);
  const json = JSON.stringify(diag);
  assert.ok(json.includes("preIbkrConfidenceScore"));
  JSON.parse(json);
});

test("classifyYahooNonTransmission — n'invente pas de motif", () => {
  assert.deepEqual(classifyYahooNonTransmission({}), { class: "unknown_unproven", explicit: false, reason: null });
  assert.equal(classifyYahooNonTransmission({ reason: "premium_below_target" }).class, "financial_reject");
  assert.equal(classifyYahooNonTransmission({ reason: "yahoo_chain_expiration_mismatch" }).class, "data_or_expiration");
  assert.equal(classifyYahooNonTransmission({ error: "boom", reason: "scan_failed" }).class, "technical_error");
});

test("buildScanFunnelDiagnosticsV1 — yahooTrace et absents vs zéros", () => {
  const scanBySymbol = new Map();
  scanBySymbol.set("CCC", {
    symbol: "CCC",
    ok: false,
    reason: "yahoo_chain_expiration_mismatch",
    debug: {
      requestedExpiration: "2026-10-23",
      returnedExpiration: "2026-10-30",
      expirationMismatch: true,
      yahooContractCount: 12,
    },
  });
  const diag = buildScanFunnelDiagnosticsV1({
    cleanedTickers: ["CCC"],
    shortlistFullSorted: [],
    rejected: [{ symbol: "CCC", reason: "yahoo_chain_expiration_mismatch" }],
    errors: [],
    scanBySymbol,
    returnLimit: 20,
    completedScanCount: 1,
  });
  const row = diag.rejectedCandidatesDetailed[0];
  assert.equal(row.yahooTrace.response.returnedExpiration, "2026-10-30");
  assert.equal(row.nonTransmission.class, "data_or_expiration");
  assert.equal(row.yahooTrace.response.contractCount, 12);
});

test("isYahooFunnelDiagnosticsV1Enabled — lecture env", () => {
  const prev = process.env.YAHOO_FUNNEL_DIAGNOSTICS;
  delete process.env.YAHOO_FUNNEL_DIAGNOSTICS;
  assert.equal(isYahooFunnelDiagnosticsV1Enabled(), false);
  process.env.YAHOO_FUNNEL_DIAGNOSTICS = "1";
  assert.equal(isYahooFunnelDiagnosticsV1Enabled(), true);
  if (prev === undefined) delete process.env.YAHOO_FUNNEL_DIAGNOSTICS;
  else process.env.YAHOO_FUNNEL_DIAGNOSTICS = prev;
});
