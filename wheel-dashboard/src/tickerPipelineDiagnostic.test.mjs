import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOtmPoolSourceBannerMessage,
  buildOtmRebuildRequiredMessage,
  buildPreIbkrCutTickerList,
  buildTickerPipelineDiagnostic,
  buildTickerPipelineTraceSteps,
  buildWatchlistRejectedBySymbol,
  buildYahooRejectedBySymbol,
  isOtmRebuildRequired,
  normalizeTickerQueryForDiagnostic,
  resolveOtmProbeTraceability,
  resolvePreScanAbsentReason,
  resolveYahooAbsentReason,
  summarizePreIbkrCutByCategory,
} from "./tickerPipelineDiagnostic.js";

test("isOtmRebuildRequired — mismatch UI vs dernier build", () => {
  assert.equal(isOtmRebuildRequired(6, 5), true);
  assert.equal(isOtmRebuildRequired(6, 6), false);
  assert.equal(isOtmRebuildRequired(6, null), false);
});

test("buildOtmRebuildRequiredMessage — texte UX", () => {
  assert.match(buildOtmRebuildRequiredMessage(6), /Rebuild watchlist requis.*6%/);
});

test("buildOtmPoolSourceBannerMessage — research vs strict", () => {
  assert.match(
    buildOtmPoolSourceBannerMessage("research_expanded"),
    /Research Expanded ignore la sonde OTM/
  );
  assert.match(
    buildOtmPoolSourceBannerMessage("strict_watchlist"),
    /Strict Watchlist.*sonde OTM appliquée/
  );
  assert.equal(buildOtmPoolSourceBannerMessage("fallback_65"), null);
});

test("resolveOtmProbeTraceability — APLD bypassed en Research Expanded", () => {
  const t = resolveOtmProbeTraceability("APLD", {
    liquidityOtmProbePctSelected: 6,
    liquidityOtmProbePctApplied: 5,
    scanPoolSource: "research_expanded",
    watchlistTickers: ["TQQQ"],
    watchlistRejectedBySymbol: {
      APLD: { reason: "liquid_options_otm_probe_failed" },
    },
  });
  assert.equal(t.otmProbeStatus, "bypassed");
  assert.match(t.otmProbeNote, /ne filtre pas par sonde OTM/);
  assert.match(t.otmMismatchNote, /UI affiche 6%.*appliqué = 5%/);
  assert.equal(t.otmRebuildRequired, true);
});

test("resolveOtmProbeTraceability — APLD fail strict watchlist", () => {
  const t = resolveOtmProbeTraceability("APLD", {
    liquidityOtmProbePctSelected: 6,
    liquidityOtmProbePctApplied: 6,
    scanPoolSource: "strict_watchlist",
    watchlistTickers: ["TQQQ"],
    watchlistRejectedBySymbol: {
      APLD: { reason: "liquid_options_otm_probe_failed" },
    },
  });
  assert.equal(t.otmProbeStatus, "fail");
  assert.equal(t.liquidityOtmProbePctApplied, 6);
});

test("resolveOtmProbeTraceability — pass strict après rebuild 6%", () => {
  const t = resolveOtmProbeTraceability("APLD", {
    liquidityOtmProbePctSelected: 6,
    liquidityOtmProbePctApplied: 6,
    scanPoolSource: "strict_watchlist",
    watchlistTickers: ["APLD", "TQQQ"],
  });
  assert.equal(t.otmProbeStatus, "pass");
  assert.equal(t.otmRebuildRequired, false);
});

test("buildTickerPipelineDiagnostic — inclut traçabilité OTM APLD", () => {
  const d = buildTickerPipelineDiagnostic("APLD", {
    tickersForScan: ["APLD"],
    yahooReturnedCandidates: [],
    ibkrDirectSentTickers: [],
    backendCandidates: [],
    filtered: [],
    enrichedCandidates: [],
    capital: 50000,
    maxCapitalPct: 100,
    liquidityOtmProbePctSelected: 6,
    liquidityOtmProbePctApplied: 6,
    scanPoolSource: "strict_watchlist",
    watchlistTickers: ["APLD"],
    watchlistRejectedBySymbol: {},
  });
  assert.equal(d.liquidityOtmProbePctSelected, 6);
  assert.equal(d.liquidityOtmProbePctApplied, 6);
  assert.equal(d.otmProbeStatus, "pass");
  assert.equal(d.poolSource, "strict_watchlist");
});

test("normalizeTickerQueryForDiagnostic accepts exact tickers", () => {
  assert.equal(normalizeTickerQueryForDiagnostic("TQQQ"), "TQQQ");
  assert.equal(normalizeTickerQueryForDiagnostic("  apld "), "APLD");
  assert.equal(normalizeTickerQueryForDiagnostic("T"), null);
  assert.equal(normalizeTickerQueryForDiagnostic("toolongname"), null);
});

test("buildTickerPipelineDiagnostic — absent ticker", () => {
  const d = buildTickerPipelineDiagnostic("ZZZZ", {
    tickersForScan: ["TQQQ"],
    yahooReturnedCandidates: [],
    ibkrDirectSentTickers: [],
    backendCandidates: [],
    filtered: [],
    enrichedCandidates: [],
    capital: 50000,
    maxCapitalPct: 100,
  });
  assert.equal(d.ticker, "ZZZZ");
  assert.equal(d.presentInYahoo, false);
  assert.equal(d.lostAtStep, "pool_pre_scan");
});

test("buildTickerPipelineDiagnostic — IBKR retained but not displayed", () => {
  const d = buildTickerPipelineDiagnostic("TQQQ", {
    tickersForScan: ["TQQQ"],
    yahooReturnedCandidates: [{ ticker: "TQQQ", rank: 3, passesFilter: true }],
    ibkrDirectSentTickers: ["TQQQ"],
    ibkrDirectResult: {
      shortlist: [{ symbol: "TQQQ", safeStrike: { strike: 50, weeklyYield: 0.8, spreadPct: 12 } }],
      testedSymbols: ["TQQQ"],
    },
    backendCandidates: [],
    enrichedCandidates: [],
    filtered: [],
    capital: 50000,
    maxCapitalPct: 100,
    notDisplayedReason: "spread trop large",
  });
  assert.equal(d.presentInIbkrShortlist, true);
  assert.equal(d.presentInBackendCandidates, false);
  assert.equal(d.lostAtStep, "ibkr_display_slice");
  assert.match(d.likelyReason, /spread trop large/);
});

test("buildTickerPipelineDiagnostic — visible in filtered", () => {
  const d = buildTickerPipelineDiagnostic("APLD", {
    tickersForScan: ["APLD"],
    yahooReturnedCandidates: [{ ticker: "APLD", passesFilter: true }],
    ibkrDirectSentTickers: ["APLD"],
    ibkrDirectResult: { shortlist: [{ symbol: "APLD" }], testedSymbols: ["APLD"] },
    backendCandidates: [
      {
        ticker: "APLD",
        ok: true,
        verdict: "conservative",
        safeStrike: { strike: 38, weeklyYield: 0.45, spreadPct: 32 },
        aggressiveStrike: { strike: 41.5, weeklyYield: 0.9, spreadPct: 15 },
        safeGrade: "WATCH",
        aggressiveGrade: "REJECT",
      },
    ],
    enrichedCandidates: [
      {
        ticker: "APLD",
        ok: true,
        verdict: "conservative",
        safeStrike: { strike: 38, weeklyYield: 0.45, spreadPct: 32 },
        aggressiveStrike: { strike: 41.5, weeklyYield: 0.9, spreadPct: 15 },
        safeGrade: "WATCH",
        aggressiveGrade: "REJECT",
      },
    ],
    filtered: [
      {
        ticker: "APLD",
        ok: true,
        verdict: "conservative",
        safeStrike: { strike: 38, weeklyYield: 0.45, spreadPct: 32 },
        aggressiveStrike: { strike: 41.5, weeklyYield: 0.9, spreadPct: 15 },
        safeGrade: "WATCH",
        aggressiveGrade: "REJECT",
      },
    ],
    capital: 50000,
    maxCapitalPct: 100,
  });
  assert.equal(d.presentInFilteredCards, true);
  assert.equal(d.selectedMode, "SAFE");
  assert.equal(d.safeCandidateSummary.strike, 38);
  assert.match(d.safeCandidateSummary.status, /WATCH.*sélectionné/);
  assert.equal(d.aggressiveCandidateSummary.strike, 41.5);
});

test("buildTickerPipelineDiagnostic — jambe sélectionnée affiche grade effectif, pas brut REJECT", () => {
  const row = {
    ticker: "TQQQ",
    ok: true,
    verdict: "conservative",
    safeStrike: { strike: 50, weeklyYield: 0.3, spreadPct: 30 },
    aggressiveStrike: { strike: 52, weeklyYield: 1.1, spreadPct: 8, popProfitEstimated: 0.88 },
    safeGrade: "REJECT",
    aggressiveGrade: "REJECT",
  };
  const d = buildTickerPipelineDiagnostic("TQQQ", {
    tickersForScan: ["TQQQ"],
    yahooReturnedCandidates: [{ ticker: "TQQQ", passesFilter: true }],
    ibkrDirectSentTickers: ["TQQQ"],
    ibkrDirectResult: { shortlist: [{ symbol: "TQQQ" }], testedSymbols: ["TQQQ"] },
    backendCandidates: [row],
    enrichedCandidates: [row],
    filtered: [row],
    capital: 50000,
    maxCapitalPct: 100,
  });
  assert.equal(d.selectedMode, "AGGRESSIVE");
  assert.match(d.aggressiveCandidateSummary.status, /A · grade brut REJECT.*sélectionné/);
  assert.doesNotMatch(d.aggressiveCandidateSummary.status, /^REJECT \(sélectionné\)/);
});

test("buildTickerPipelineDiagnostic — yahoo_returned avec raison Yahoo précise", () => {
  const d = buildTickerPipelineDiagnostic("SOXL", {
    tickersForScan: ["SOXL", "TQQQ"],
    yahooReturnedCandidates: [],
    yahooDiagnostics: {
      rejectedSample: [{ symbol: "SOXL", reason: "premium_below_target" }],
    },
    ibkrDirectSentTickers: [],
    backendCandidates: [],
    filtered: [],
    enrichedCandidates: [],
    capital: 50000,
    maxCapitalPct: 100,
  });
  assert.equal(d.lostAtStep, "yahoo_returned");
  assert.match(d.likelyReason, /premium_below_target/);
});

test("buildTickerPipelineDiagnostic — ETHA exclu crypto pool pré-scan", () => {
  const d = buildTickerPipelineDiagnostic("ETHA", {
    tickersForScan: ["TQQQ", "SOFI"],
    yahooReturnedCandidates: [],
    ibkrDirectSentTickers: [],
    backendCandidates: [],
    filtered: [],
    enrichedCandidates: [],
    capital: 50000,
    maxCapitalPct: 100,
  });
  assert.equal(d.lostAtStep, "pool_pre_scan");
  assert.match(d.likelyReason, /crypto_blocked_except_bitx/);
  assert.equal(d.cryptoBlockReason, "crypto_blocked_except_bitx");
});

test("resolveYahooAbsentReason — rejectedSample puis payload rejected puis index complet", () => {
  assert.equal(
    resolveYahooAbsentReason("XYZ", {
      yahooDiagnostics: { rejectedSample: [{ symbol: "XYZ", reason: "expiration_not_available" }] },
    }),
    "expiration_not_available"
  );
  assert.equal(
    resolveYahooAbsentReason("ABC", {
      yahooScanRejected: [{ symbol: "ABC", reason: "safe_strike_not_liquid" }],
    }),
    "safe_strike_not_liquid"
  );
  assert.equal(
    resolveYahooAbsentReason("APLD", {
      yahooRejectedBySymbol: {
        APLD: { reason: "premium_below_target", debug: null },
      },
    }),
    "premium_below_target"
  );
});

test("buildYahooRejectedBySymbol — index complet hors top 20", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    symbol: `T${i}`,
    reason: i === 24 ? "yield_below_target" : "premium_below_target",
  }));
  rows.push({ symbol: "APLD", reason: "no_liquid_strike_below_lower_bound" });
  const index = buildYahooRejectedBySymbol(rows);
  assert.equal(index.APLD.reason, "no_liquid_strike_below_lower_bound");
  assert.equal(index.T24.reason, "yield_below_target");
});

test("buildWatchlistRejectedBySymbol — OTM probe et troncature limite", () => {
  const index = buildWatchlistRejectedBySymbol({
    rejectedRows: [{ symbol: "APLD", reason: "liquid_options_otm_probe_failed" }],
    truncatedSymbols: ["SOFI"],
  });
  assert.equal(index.APLD.reason, "liquid_options_otm_probe_failed");
  assert.equal(index.SOFI.reason, "excluded_by_watchlist_limit");
});

test("resolvePreScanAbsentReason — ETHA/GBTC crypto et APLD watchlist", () => {
  for (const sym of ["ETHA", "GBTC"]) {
    const row = resolvePreScanAbsentReason(sym, {
      watchlistTickers: ["TQQQ"],
      preIbkrPoolMode: "strict_watchlist",
    });
    assert.equal(row.category, "crypto_blocked");
    assert.match(row.display, /crypto_blocked_except_bitx/);
  }

  const apld = resolvePreScanAbsentReason("APLD", {
    watchlistTickers: ["TQQQ"],
    watchlistRejectedBySymbol: {
      APLD: { reason: "liquid_options_otm_probe_failed", stage: "watchlist_rebuild", source: "watchlistBuilder" },
    },
    preIbkrPoolMode: "strict_watchlist",
  });
  assert.match(apld.display, /liquid_options_otm_probe_failed/);
});

test("buildTickerPipelineDiagnostic — yahoo rejet hors rejectedSample via index", () => {
  const d = buildTickerPipelineDiagnostic("APLD", {
    tickersForScan: ["APLD", "TQQQ"],
    yahooReturnedCandidates: [],
    yahooRejectedBySymbol: {
      APLD: { reason: "no_safe_candidate_at_or_above_target_bid", debug: null },
    },
    ibkrDirectSentTickers: [],
    backendCandidates: [],
    filtered: [],
    enrichedCandidates: [],
    capital: 50000,
    maxCapitalPct: 100,
  });
  assert.equal(d.lostAtStep, "yahoo_returned");
  assert.match(d.likelyReason, /no_safe_candidate_at_or_above_target_bid/);
});

test("buildTickerPipelineTraceSteps — trace APLD pool pré-scan", () => {
  const trace = buildTickerPipelineTraceSteps("APLD", {
    watchlistTickers: ["TQQQ"],
    watchlistRejectedBySymbol: {
      APLD: { reason: "liquid_options_otm_probe_failed", stage: "watchlist_rebuild", source: "watchlistBuilder" },
    },
    tickersForScan: ["TQQQ"],
    preIbkrPoolMode: "strict_watchlist",
  });
  assert.equal(trace.length, 10);
  const scanStep = trace.find((s) => s.step.includes("scan_shortlist"));
  assert.equal(scanStep.present, false);
  assert.match(scanStep.reason, /otm_probe_failed|watchlist/);
});

test("buildPreIbkrCutTickerList — agrège crypto, watchlist et Yahoo", () => {
  const rows = buildPreIbkrCutTickerList({
    watchlistTickers: ["TQQQ"],
    watchlistRejectedBySymbol: {
      APLD: { reason: "liquid_options_otm_probe_failed", stage: "watchlist_rebuild", source: "watchlistBuilder" },
    },
    cryptoBlockedRemovedSymbols: ["ETHA"],
    tickersForScan: ["TQQQ", "SOXL"],
    yahooRejectedBySymbol: {
      SOXL: { reason: "premium_below_target", debug: null },
    },
    yahooReturnedCandidates: [],
    ibkrDirectSentTickers: ["TQQQ"],
  });
  const tickers = rows.map((r) => r.ticker);
  assert.ok(tickers.includes("APLD"));
  assert.ok(tickers.includes("ETHA"));
  assert.ok(tickers.includes("SOXL"));
  const summary = summarizePreIbkrCutByCategory(rows);
  assert.ok(summary.counts.crypto_blocked >= 1);
  assert.ok(summary.counts.yahoo_rejected >= 1);
});

test("buildTickerPipelineDiagnostic — expiration UI filter accepte target OK malgré yahoo imbriqué périmé", () => {
  const enrichedRow = {
    ticker: "TQQQ",
    targetExpiration: "2026-06-05",
    expiration: "20260605",
    raw: { expiration: "2026-06-05" },
    yahoo: { targetExpiration: "2026-05-29" },
    ok: true,
    verdict: "conservative",
    safeStrike: { strike: 50, weeklyYield: 0.8, spreadPct: 12 },
    aggressiveStrike: { strike: 52, weeklyYield: 1.1, spreadPct: 10 },
    safeGrade: "WATCH",
    aggressiveGrade: "A",
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: "A",
  };
  const d = buildTickerPipelineDiagnostic("TQQQ", {
    tickersForScan: ["TQQQ"],
    yahooReturnedCandidates: [{ ticker: "TQQQ", rank: 1, passesFilter: true }],
    ibkrDirectSentTickers: ["TQQQ"],
    ibkrDirectResult: { shortlist: [{ symbol: "TQQQ" }], testedSymbols: ["TQQQ"] },
    backendCandidates: [enrichedRow],
    enrichedCandidates: [enrichedRow],
    filtered: [],
    capital: 50000,
    maxCapitalPct: 100,
    selectedExpiration: "2026-06-05",
    filter: "all",
  });
  assert.notEqual(d.lostAtStep, "ui_expiration_filter");
});

test("buildTickerPipelineDiagnostic — APLD compact IBKR + sélection ISO", () => {
  const enrichedRow = {
    ticker: "APLD",
    targetExpiration: "2026-06-05",
    expiration: "2026-06-05",
    ibkrDirect: { expiration: "20260605" },
    ok: true,
    verdict: "conservative",
    safeStrike: { strike: 38, weeklyYield: 0.45, spreadPct: 32 },
    aggressiveStrike: { strike: 41.5, weeklyYield: 0.9, spreadPct: 15 },
    safeGrade: "WATCH",
    aggressiveGrade: "A",
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: "A",
  };
  const d = buildTickerPipelineDiagnostic("APLD", {
    tickersForScan: ["APLD"],
    yahooReturnedCandidates: [{ ticker: "APLD", rank: 54, passesFilter: true }],
    ibkrDirectSentTickers: ["APLD"],
    ibkrDirectResult: { shortlist: [{ symbol: "APLD" }], testedSymbols: ["APLD"] },
    backendCandidates: [enrichedRow],
    enrichedCandidates: [enrichedRow],
    filtered: [enrichedRow],
    capital: 50000,
    maxCapitalPct: 100,
    selectedExpiration: "2026-06-05",
    filter: "all",
  });
  assert.notEqual(d.lostAtStep, "ui_expiration_filter");
  assert.equal(d.presentInFilteredCards, true);
});
