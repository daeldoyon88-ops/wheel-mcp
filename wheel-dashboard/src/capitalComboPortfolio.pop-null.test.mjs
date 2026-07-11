import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCapitalComboCandidate,
  buildPortfolioCombos,
  getLegPopPct,
  gradeLeg,
  normalizeOptionalPopDecimal,
} from "./capitalComboPortfolio.js";

const POP_MISSING = Symbol("POP_MISSING");

function makeLeg({
  strike = 50,
  bid = 0.6,
  weeklyYield = 1.2,
  spreadPct = 8,
  distancePct = -8,
  popProfitEstimated = POP_MISSING,
  popEstimate = POP_MISSING,
} = {}) {
  const leg = {
    strike,
    bid,
    premiumUsed: bid,
    mid: bid,
    weeklyYield,
    distancePct,
    liquidity: { spreadPct },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
  };
  if (popProfitEstimated !== POP_MISSING) leg.popProfitEstimated = popProfitEstimated;
  if (popEstimate !== POP_MISSING) leg.popEstimate = popEstimate;
  return leg;
}

function makeAggressiveCandidate(popProfitEstimated, popEstimate = null) {
  return {
    ticker: "NFLX",
    aggressiveGrade: "A",
    aggressiveStrike: makeLeg({ popProfitEstimated, popEstimate, weeklyYield: 1.2 }),
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore: 0.8,
    proExecutionScore: 0.9,
    proDistanceScore: 1,
  };
}

function makeSafeCandidate(popProfitEstimated, popEstimate = null) {
  return {
    ticker: "MSFT",
    safeStrike: makeLeg({ popProfitEstimated, popEstimate, weeklyYield: 0.6 }),
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore: 0.8,
    proExecutionScore: 0.9,
    proDistanceScore: 1,
  };
}

function comboByLabel(combos, label) {
  return (combos || []).find((combo) => combo?.label === label) ?? null;
}

function buildSingleCandidateCombo(candidate, label) {
  return comboByLabel(
    buildPortfolioCombos([candidate], 50000, 100, 5, new Set(), { optimizerV2: {} }),
    label,
  );
}

test("normalizeOptionalPopDecimal keeps unknown POP unknown and real zero as zero", () => {
  const cases = [
    { label: "null", value: null, expectedDecimal: null, expectedPct: null, expectedGrade: "A" },
    { label: "undefined", value: undefined, expectedDecimal: null, expectedPct: null, expectedGrade: "A" },
    { label: "missing", value: POP_MISSING, expectedDecimal: null, expectedPct: null, expectedGrade: "A" },
    { label: "NaN", value: NaN, expectedDecimal: null, expectedPct: null, expectedGrade: "A" },
    { label: "zero", value: 0, expectedDecimal: 0, expectedPct: 0, expectedGrade: "WATCH" },
    { label: "decimal 0.86", value: 0.86, expectedDecimal: 0.86, expectedPct: 86, expectedGrade: "A" },
    { label: "decimal 1", value: 1, expectedDecimal: 1, expectedPct: 100, expectedGrade: "A" },
    { label: "empty string", value: "", expectedDecimal: null, expectedPct: null, expectedGrade: "A" },
    { label: "non numeric", value: "abc", expectedDecimal: null, expectedPct: null, expectedGrade: "A" },
    { label: "percent 86", value: 86, expectedDecimal: 0.86, expectedPct: 86, expectedGrade: "A" },
  ];

  for (const row of cases) {
    const leg =
      row.value === POP_MISSING
        ? makeLeg()
        : makeLeg({ popProfitEstimated: row.value, popEstimate: null });
    assert.equal(
      row.value === POP_MISSING ? normalizeOptionalPopDecimal(undefined) : normalizeOptionalPopDecimal(row.value),
      row.expectedDecimal,
      row.label,
    );
    assert.equal(getLegPopPct(leg), row.expectedPct, row.label);
    assert.equal(
      gradeLeg({ spreadPct: 8, weeklyYieldPct: 0.7, popDecimal: row.value === POP_MISSING ? undefined : row.value }),
      row.expectedGrade,
      row.label,
    );
  }
});

test("AF-02 AGGRESSIVE: POP null does not demote a valid stored A leg to WATCH", () => {
  const presentBuilt = buildCapitalComboCandidate(makeAggressiveCandidate(0.86), 50000);
  assert.equal(presentBuilt._aggGrade, "A");
  assert.equal(presentBuilt._aggPopPct, 86);

  const nullBuilt = buildCapitalComboCandidate(makeAggressiveCandidate(null, null), 50000);
  assert.equal(nullBuilt._aggGrade, "A");
  assert.equal(nullBuilt._aggPopPct, null);

  const presentCombo = buildSingleCandidateCombo(makeAggressiveCandidate(0.86), "AGGRESSIVE");
  const nullCombo = buildSingleCandidateCombo(makeAggressiveCandidate(null, null), "AGGRESSIVE");
  assert.equal(presentCombo?.picks?.[0]?.ticker, "NFLX");
  assert.equal(presentCombo?.picks?.[0]?.grade, "A");
  assert.equal(nullCombo?.picks?.[0]?.ticker, "NFLX");
  assert.equal(nullCombo?.picks?.[0]?.grade, "A");
  assert.equal(nullCombo?.picks?.[0]?.popEstimate, null);
});

test("AF-02 SAFE: POP null remains non-blocking and keeps the SAFE leg selected", () => {
  const presentCombo = buildSingleCandidateCombo(makeSafeCandidate(0.86), "SAFE");
  const nullCombo = buildSingleCandidateCombo(makeSafeCandidate(null, null), "SAFE");

  assert.equal(presentCombo?.picks?.[0]?.ticker, "MSFT");
  assert.equal(presentCombo?.picks?.[0]?.mode, "SAFE");
  assert.equal(presentCombo?.picks?.[0]?.grade, "A");
  assert.equal(nullCombo?.picks?.[0]?.ticker, "MSFT");
  assert.equal(nullCombo?.picks?.[0]?.mode, "SAFE");
  assert.equal(nullCombo?.picks?.[0]?.grade, "A");
  assert.equal(nullCombo?.picks?.[0]?.popEstimate, null);
});

test("real POP zero is still a known zero and follows the WATCH gate", () => {
  const zeroBuilt = buildCapitalComboCandidate(makeAggressiveCandidate(0), 50000);
  assert.equal(zeroBuilt._aggPopPct, 0);
  assert.equal(zeroBuilt._aggGrade, "WATCH");

  const zeroCombo = buildSingleCandidateCombo(makeAggressiveCandidate(0), "AGGRESSIVE");
  assert.equal(zeroCombo?.picks?.length ?? 0, 0);
});

test("valid POP values keep existing grades and deterministic financial fields", () => {
  for (const pop of [0.8, 0.86, 0.92, 0.99]) {
    const combo = buildSingleCandidateCombo(makeAggressiveCandidate(pop), "AGGRESSIVE");
    const pick = combo?.picks?.[0] ?? null;
    assert.equal(gradeLeg({ spreadPct: 8, weeklyYieldPct: 1.2, popDecimal: pop }), "A");
    assert.equal(pick?.ticker, "NFLX");
    assert.equal(pick?.grade, "A");
    assert.equal(pick?.capitalRequired, 5000);
    assert.equal(pick?.premiumCollected, 300);
    assert.equal(combo?.totalCapital, 25000);
    assert.equal(combo?.freeCapital, 25000);
  }
});

test("POP normalization is mode-agnostic for a future BALANCED-style leg", () => {
  const balancedUnknown = { mode: "BALANCED", popProfitEstimated: null, popEstimate: null };
  const balancedKnown = { mode: "BALANCED", popProfitEstimated: 0.86, popEstimate: null };
  const balancedFallback = { mode: "BALANCED", popProfitEstimated: "", popEstimate: 0.86 };

  assert.equal(getLegPopPct(balancedUnknown), null);
  assert.equal(getLegPopPct(balancedKnown), 86);
  assert.equal(getLegPopPct(balancedFallback), 86);
  assert.equal(normalizeOptionalPopDecimal(86), 0.86);
});
