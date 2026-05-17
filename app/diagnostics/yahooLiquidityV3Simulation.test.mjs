import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyV3RecoveryBucket,
  evaluateYahooLiquidityV3RecoveryEligibility,
  isAbsoluteSpreadOnlyLiquidityFailure,
  isYahooLiquidityV3LiveSafeEnabled,
  isYahooLiquidityV3SimulationEnabled,
  runYahooLiquidityV3Simulation,
} from "./yahooLiquidityV3Simulation.js";

test("isYahooLiquidityV3SimulationEnabled — défaut désactivé", () => {
  delete process.env.YAHOO_LIQUIDITY_V3_SIMULATION;
  assert.equal(isYahooLiquidityV3SimulationEnabled(), false);
  process.env.YAHOO_LIQUIDITY_V3_SIMULATION = "1";
  assert.equal(isYahooLiquidityV3SimulationEnabled(), true);
  delete process.env.YAHOO_LIQUIDITY_V3_SIMULATION;
});

test("isYahooLiquidityV3LiveSafeEnabled — défaut désactivé", () => {
  delete process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
  assert.equal(isYahooLiquidityV3LiveSafeEnabled(), false);
  process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE = "1";
  assert.equal(isYahooLiquidityV3LiveSafeEnabled(), true);
  delete process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
});

/** Checks Yahoo « échec spread absolu seul » (cohorte V3). */
const CHECKS_PURE_ABS_SPREAD_FAIL = {
  hasRealMarket: true,
  rejectReason: null,
  spreadPctOk: true,
  volumeOk: true,
  openInterestOk: true,
  absoluteSpreadOk: false,
};

test("evaluateYahooLiquidityV3RecoveryEligibility — high récupéré (AA-like)", () => {
  const row = {
    symbol: "AA",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          spreadPct: 9.4,
          absoluteSpread: 0.21,
          volume: 377,
          openInterest: 296,
          checks: { ...CHECKS_PURE_ABS_SPREAD_FAIL },
        },
      },
    },
  };
  const ev = evaluateYahooLiquidityV3RecoveryEligibility(row, { maxAbsoluteSpreadV3: 0.35 });
  assert.equal(ev.kind, "recovered");
  assert.equal(ev.bucket, "high");
  assert.equal(ev.symbol, "AA");
});

test("evaluateYahooLiquidityV3RecoveryEligibility — medium récupéré", () => {
  const row = {
    symbol: "APLD",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          spreadPct: 15,
          absoluteSpread: 0.24,
          volume: 80,
          openInterest: 80,
          checks: { ...CHECKS_PURE_ABS_SPREAD_FAIL },
        },
      },
    },
  };
  const ev = evaluateYahooLiquidityV3RecoveryEligibility(row, { maxAbsoluteSpreadV3: 0.35 });
  assert.equal(ev.kind, "recovered");
  assert.equal(ev.bucket, "medium");
});

test("evaluateYahooLiquidityV3RecoveryEligibility — weak non récupéré", () => {
  const row = {
    symbol: "WEAK_VOL",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          spreadPct: 10,
          absoluteSpread: 0.22,
          volume: 40,
          openInterest: 200,
          checks: { ...CHECKS_PURE_ABS_SPREAD_FAIL },
        },
      },
    },
  };
  const ev = evaluateYahooLiquidityV3RecoveryEligibility(row, { maxAbsoluteSpreadV3: 0.35 });
  assert.equal(ev.kind, "exclude_weak");
});

test("evaluateYahooLiquidityV3RecoveryEligibility — no_real_bid_ask", () => {
  const row = {
    symbol: "ZZZ_NB",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          checks: {
            hasRealMarket: false,
            rejectReason: "no_real_bid_ask",
            spreadPctOk: true,
            volumeOk: true,
            openInterestOk: true,
            absoluteSpreadOk: false,
          },
        },
      },
    },
  };
  assert.equal(evaluateYahooLiquidityV3RecoveryEligibility(row, {}).kind, "exclude_no_real_bid_ask");
});

test("evaluateYahooLiquidityV3RecoveryEligibility — spreadPctOk false", () => {
  const row = {
    symbol: "BAD_SPREAD",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          spreadPct: 40,
          absoluteSpread: 0.25,
          checks: {
            ...CHECKS_PURE_ABS_SPREAD_FAIL,
            spreadPctOk: false,
          },
        },
      },
    },
  };
  assert.equal(evaluateYahooLiquidityV3RecoveryEligibility(row, {}).kind, "exclude_spread_pct");
});

test("evaluateYahooLiquidityV3RecoveryEligibility — OTM probe failed", () => {
  const row = {
    symbol: "ZZZ_OTM",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_otm_probe_failed"],
    partialMetrics: { detail: { minOtmPct: 3 } },
  };
  assert.equal(evaluateYahooLiquidityV3RecoveryEligibility(row, {}).kind, "exclude_otm");
});

test("evaluateYahooLiquidityV3RecoveryEligibility — pattern_not_pure (volumeOk false)", () => {
  const row = {
    symbol: "MIXED",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          spreadPct: 9,
          absoluteSpread: 0.22,
          checks: {
            ...CHECKS_PURE_ABS_SPREAD_FAIL,
            volumeOk: false,
          },
        },
      },
    },
  };
  assert.equal(evaluateYahooLiquidityV3RecoveryEligibility(row, {}).kind, "exclude_pattern_not_pure");
});

test("evaluateYahooLiquidityV3RecoveryEligibility — TQQQ high + leveraged_etf_hint", () => {
  const row = {
    symbol: "TQQQ",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          spreadPct: 10,
          absoluteSpread: 0.21,
          volume: 500,
          openInterest: 400,
          checks: { ...CHECKS_PURE_ABS_SPREAD_FAIL },
        },
      },
    },
  };
  const ev = evaluateYahooLiquidityV3RecoveryEligibility(row, { maxAbsoluteSpreadV3: 0.35 });
  assert.equal(ev.kind, "recovered");
  assert.equal(ev.bucket, "high");
  assert.ok(Array.isArray(ev.risks) && ev.risks.includes("leveraged_etf_hint"));
});

test("evaluateYahooLiquidityV3RecoveryEligibility — LIVE_SAFE OFF ne change pas l’éligibilité (gate dans watchlistBuilder)", () => {
  delete process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
  const row = {
    symbol: "AA",
    rejectionStage: "yahoo_liquidity",
    rejectionReasons: ["liquid_options_failed"],
    partialMetrics: {
      detail: {
        code: "atm_put_not_liquid",
        liquidity: {
          spreadPct: 9.4,
          absoluteSpread: 0.21,
          volume: 377,
          openInterest: 296,
          checks: { ...CHECKS_PURE_ABS_SPREAD_FAIL },
        },
      },
    },
  };
  assert.equal(evaluateYahooLiquidityV3RecoveryEligibility(row, { maxAbsoluteSpreadV3: 0.35 }).kind, "recovered");
});

test("classifyV3RecoveryBucket — AA-like → high", () => {
  const b = classifyV3RecoveryBucket({
    absoluteSpread: 0.21,
    spreadPct: 9.4,
    volume: 377,
    openInterest: 296,
  });
  assert.equal(b, "high");
});

test("classifyV3RecoveryBucket — SNOW-like (OI trop bas pour high/medium)", () => {
  const b = classifyV3RecoveryBucket({
    absoluteSpread: 0.22,
    spreadPct: 10,
    volume: 200,
    openInterest: 10,
  });
  assert.equal(b, "weak");
});

test("classifyV3RecoveryBucket — OKTA-like (volume trop faible)", () => {
  const b = classifyV3RecoveryBucket({
    absoluteSpread: 0.22,
    spreadPct: 9,
    volume: 7,
    openInterest: 600,
  });
  assert.equal(b, "weak");
});

test("classifyV3RecoveryBucket — APLD-like (pas high si OI < 100 mais medium)", () => {
  const b = classifyV3RecoveryBucket({
    absoluteSpread: 0.24,
    spreadPct: 15,
    volume: 80,
    openInterest: 80,
  });
  assert.equal(b, "medium");
});

test("isAbsoluteSpreadOnlyLiquidityFailure — carnet Yahoo conforme", () => {
  assert.equal(
    isAbsoluteSpreadOnlyLiquidityFailure({
      checks: {
        hasRealMarket: true,
        rejectReason: null,
        spreadPctOk: true,
        volumeOk: true,
        openInterestOk: true,
        absoluteSpreadOk: false,
      },
    }),
    true
  );
  assert.equal(
    isAbsoluteSpreadOnlyLiquidityFailure({
      checks: {
        hasRealMarket: false,
        rejectReason: "no_real_bid_ask",
        spreadPctOk: true,
        volumeOk: true,
        openInterestOk: true,
        absoluteSpreadOk: false,
      },
    }),
    false
  );
});

test("runYahooLiquidityV3Simulation — récupère AA, exclut OTM et no_bid", () => {
  const v1 = {
    watchlistKeptCount: 66,
    rejectedCandidates: [
      {
        symbol: "AA",
        rejectionStage: "yahoo_liquidity",
        rejectionReasons: ["liquid_options_failed"],
        partialMetrics: {
          detail: {
            code: "atm_put_not_liquid",
            strike: 63,
            liquidity: {
              isLiquid: false,
              spreadPct: 9.4,
              absoluteSpread: 0.21,
              volume: 377,
              openInterest: 296,
              checks: {
                hasRealMarket: true,
                hasLastFallback: true,
                absoluteSpreadOk: false,
                spreadPctOk: true,
                volumeOk: true,
                openInterestOk: true,
                rejectReason: null,
              },
            },
          },
        },
      },
      {
        symbol: "WEAK_VOL",
        rejectionStage: "yahoo_liquidity",
        rejectionReasons: ["liquid_options_failed"],
        partialMetrics: {
          detail: {
            code: "atm_put_not_liquid",
            strike: 50,
            liquidity: {
              spreadPct: 10,
              absoluteSpread: 0.22,
              volume: 40,
              openInterest: 200,
              checks: {
                hasRealMarket: true,
                hasLastFallback: true,
                absoluteSpreadOk: false,
                spreadPctOk: true,
                volumeOk: true,
                openInterestOk: true,
                rejectReason: null,
              },
            },
          },
        },
      },
      {
        symbol: "ZZZ_OTM",
        rejectionStage: "yahoo_liquidity",
        rejectionReasons: ["liquid_options_otm_probe_failed"],
        partialMetrics: { detail: { minOtmPct: 5 } },
      },
      {
        symbol: "ZZZ_NB",
        rejectionStage: "yahoo_liquidity",
        rejectionReasons: ["liquid_options_failed"],
        partialMetrics: {
          detail: {
            code: "atm_put_not_liquid",
            liquidity: {
              checks: {
                hasRealMarket: false,
                rejectReason: "no_real_bid_ask",
                spreadPctOk: true,
                volumeOk: true,
                openInterestOk: true,
                absoluteSpreadOk: false,
              },
            },
          },
        },
      },
    ],
  };

  const r = runYahooLiquidityV3Simulation(v1, { maxAbsoluteSpreadV3: 0.35, stats: { retainedAfterFiltersCount: 70, limitApplied: 80 } });
  assert.ok(r.simulated.recoveredSymbols.includes("AA"));
  assert.ok(!r.simulated.recoveredSymbols.includes("WEAK_VOL"));
  assert.ok(
    r.excluded.weakBucketExcludedDetail.some((row) => String(row.symbol) === "WEAK_VOL"),
    "bucket weak ne doit pas être récupéré"
  );
  assert.equal(r.excluded.otmProbeExcludedForNowCount, 1);
  assert.equal(r.excluded.noRealBidAskExcludedCount, 1);
  assert.ok(r.impact.watchlist.estimatedRetainedAfterFiltersAfterSim >= 71);
});
