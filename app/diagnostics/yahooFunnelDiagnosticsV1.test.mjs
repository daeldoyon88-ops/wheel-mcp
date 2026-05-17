import assert from "node:assert/strict";
import test from "node:test";

import {
  atmSpreadToLiquidityScore,
  buildScanFunnelDiagnosticsV1,
  buildWatchlistYahooFunnelFlags,
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

test("isYahooFunnelDiagnosticsV1Enabled — lecture env", () => {
  const prev = process.env.YAHOO_FUNNEL_DIAGNOSTICS;
  delete process.env.YAHOO_FUNNEL_DIAGNOSTICS;
  assert.equal(isYahooFunnelDiagnosticsV1Enabled(), false);
  process.env.YAHOO_FUNNEL_DIAGNOSTICS = "1";
  assert.equal(isYahooFunnelDiagnosticsV1Enabled(), true);
  if (prev === undefined) delete process.env.YAHOO_FUNNEL_DIAGNOSTICS;
  else process.env.YAHOO_FUNNEL_DIAGNOSTICS = prev;
});
