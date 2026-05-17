import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAggressiveAlternativeRecommendationV1Envelope,
  buildRiskReviewFr,
  compactForcedFirstRows,
} from "./aggressiveAlternativeRecommendationV1Envelope.mjs";

const baseSumm = {
  label: "baseline_greedy",
  capitalUsedUsd: 10000,
  capitalFreeUsd: 13750,
  grossCapitalUsd: 25500,
  usableCapitalUsd: 23750,
  premiumTotalUsd: 200,
  portfolioYieldWeightedPct: 1.0,
  popAvgPct: 80,
  otmAvgPct: -10,
  diversificationHealthScore: 0.5,
  concentrationRiskScore: 0.2,
  highBetaCapitalPct: 40,
  dominantTickerCapitalPct: 35,
  simCompositePortfolioScore: 55,
  penaltiesSimV1: {
    concentrationPenalty: 0.1,
    earningsPenalty: 0.05,
    dataQualityPenalty: 0,
  },
  tickers: ["A", "B", "C"],
  distinctLines: 3,
};

const altSumm = {
  ...baseSumm,
  label: "force_first_Z",
  premiumTotalUsd: 230,
  portfolioYieldWeightedPct: 1.08,
  simCompositePortfolioScore: 61,
  highBetaCapitalPct: 52,
};

test("compactForcedFirstRows — ignore ligne baseline sans candidate", () => {
  const rows = compactForcedFirstRows([
    { id: "baseline", candidate: null, skipped: false, summary: baseSumm },
    { candidate: "Z", skipped: false, summary: altSumm, deltaVsGreedyBaseline: { deltaPremiumUsd: 30 } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].candidate, "Z");
});

test("buildAggressiveAlternativeRecommendationV1Envelope — sections attendues + deltaVsBaseline", () => {
  const core = {
    exportedAtIso: "2026-05-17T12:00:00.000Z",
    expiration: "2026-05-23",
    args: { capital: 25500 },
    missingData: ["note:test"],
    scanDiagnosticsV1: { shortlistLength: 10 },
    stagingMeta: { usableCapitalUsd: 24000 },
    inputSource: "fixture",
    forcedFirstCandidatesOrdered: ["Z"],
    baselineSummary: baseSumm,
    baselinePicks: [
      {
        ticker: "A",
        capitalUsed: 3000,
        premiumCollected: 40,
        weeklyReturn: 1,
      },
    ],
    scenarios: [],
    recommendationFr: "Fixture recommendation.",
    bestForced: {
      id: "force_first_Z_reoptimize",
      candidate: "Z",
      verdict: "meilleur score",
      summary: altSumm,
      picksCompact: [{ ticker: "Z", contracts: 1 }],
      finalPositions: [{ ticker: "Z" }],
      deltaVsGreedyBaseline: null,
    },
    fileStampLocal: "2026-05-17T12-00-00",
  };

  const env = buildAggressiveAlternativeRecommendationV1Envelope(core);
  assert.equal(env.kind, "aggressive_alternative_composition_recommendation_v1");
  assert.ok(env.baselineGreedy?.summary);
  assert.ok(Array.isArray(env.forcedFirstCandidates));
  assert.equal(env.bestAlternative?.forcedFirstTicker, "Z");
  assert.equal(env.deltaVsBaseline?.deltaPremiumUsd, 30);
  assert.ok(env.recommendation?.headlineFr);
  assert.ok(Array.isArray(env.riskReview?.bulletsFr));
  assert.deepEqual(env.missingData, ["note:test"]);
});

test("buildRiskReviewFr — high beta ↑ déclenche bullet", () => {
  const rr = buildRiskReviewFr({
    baselineLite: { highBetaCapitalPct: 40 },
    altLite: { highBetaCapitalPct: 52 },
    deltaVsBaseline: { deltaHighBetaCapitalPct: 12 },
  });
  assert.ok(rr.bulletsFr.some((b) => b.includes("high-beta")));
});
