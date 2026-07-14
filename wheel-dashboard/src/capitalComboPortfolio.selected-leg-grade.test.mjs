import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  getLegPopPct,
  gradeLeg,
  resolveSelectedLegGrade,
} from "./capitalComboPortfolio.js";

const POP_MISSING = Symbol("POP_MISSING");

function makeLeg({
  strike = 50,
  bid = 0.27,
  weeklyYield = 0.54,
  spreadPct = 12,
  distancePct = -8,
  popProfitEstimated = 0.82,
  popEstimate = POP_MISSING,
  volume = 1000,
  openInterest = 2000,
  mode,
  dteDays = 7,
} = {}) {
  const leg = {
    strike,
    bid,
    premiumUsed: bid,
    mid: bid,
    weeklyYield,
    periodYield: weeklyYield,
    dteDays,
    distancePct,
    volume,
    openInterest,
    source: "IBKR live",
  };
  if (spreadPct !== POP_MISSING) leg.liquidity = { spreadPct };
  if (popProfitEstimated !== POP_MISSING) leg.popProfitEstimated = popProfitEstimated;
  if (popEstimate !== POP_MISSING) leg.popEstimate = popEstimate;
  if (mode) leg.mode = mode;
  return leg;
}

function makeCandidate({
  ticker = "CRM",
  finalDisplayMode = "AGGRESSIVE",
  finalDisplayGrade = "A",
  safeGrade = null,
  aggressiveGrade = null,
  safeStrike = null,
  aggressiveStrike = null,
  proFinalScore = 0.85,
  proExecutionScore = 0.9,
  proDistanceScore = 0.9,
  dteDays = 7,
} = {}) {
  const candidate = {
    ticker,
    dteDays,
    finalDisplayMode,
    finalDisplayGrade,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore,
    proExecutionScore,
    proDistanceScore,
  };
  if (safeStrike) candidate.safeStrike = safeStrike;
  if (aggressiveStrike) candidate.aggressiveStrike = aggressiveStrike;
  if (safeGrade != null) candidate.safeGrade = safeGrade;
  if (aggressiveGrade != null) candidate.aggressiveGrade = aggressiveGrade;
  return candidate;
}

function comboByLabel(candidates, label, options = {}) {
  return (
    buildPortfolioCombos(candidates, 100000, 20, 1, new Set(), {
      optimizerV2: { leftoverDensityPassEnabled: false },
      ...options,
    }).find((combo) => combo?.label === label) ?? null
  );
}

function pickSummary(combo) {
  const pick = combo?.picks?.[0] ?? null;
  if (!pick) return null;
  return {
    ticker: pick.ticker,
    grade: pick.grade,
    score: pick.selectionScore,
    strike: pick.strike,
    premiumUnit: pick.premiumUnit,
    weeklyReturn: pick.weeklyReturn,
    spreadPct: pick.spreadPct,
    distancePct: pick.distancePct,
    popEstimate: pick.popEstimate,
  };
}

function makeCrmOrclPair(crmSafeGrade = null, crmSourceGrade = "A", crmPop = 0.82) {
  const crm = makeCandidate({
    ticker: "CRM",
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: crmSourceGrade,
    safeGrade: crmSafeGrade,
    aggressiveGrade: "A",
    safeStrike: makeLeg({ weeklyYield: 0.54, spreadPct: 12, distancePct: -6, popProfitEstimated: crmPop }),
  });
  const orcl = makeCandidate({
    ticker: "ORCL",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "B",
    safeGrade: "B",
    safeStrike: makeLeg({ weeklyYield: 0.54, spreadPct: 12, distancePct: -8, popProfitEstimated: 0.82 }),
  });
  return { crm, orcl };
}

test("TEST 1 - explicit safeGrade A is used over source grade B", () => {
  const safeStrike = makeLeg({ weeklyYield: 0.6, spreadPct: 8, distancePct: -8, popProfitEstimated: 0.86 });
  const candidate = makeCandidate({
    ticker: "CRM",
    finalDisplayGrade: "B",
    safeGrade: "A",
    safeStrike,
  });

  const pick = comboByLabel([candidate], "SAFE")?.picks?.[0] ?? null;
  assert.equal(resolveSelectedLegGrade({ explicitGrade: "A", selectedLeg: safeStrike, selectedMode: "SAFE", candidate }), "A");
  assert.equal(pick?.grade, "A");
  assert.match(pick?.selectionSummary ?? "", /grade \+24/);
});

test("TEST 2 - explicit safeGrade B is used over source grade A", () => {
  const safeStrike = makeLeg({ weeklyYield: 0.54, spreadPct: 12, distancePct: -8, popProfitEstimated: 0.82 });
  const candidate = makeCandidate({
    ticker: "CRM",
    finalDisplayGrade: "A",
    safeGrade: "B",
    safeStrike,
  });

  const pick = comboByLabel([candidate], "SAFE")?.picks?.[0] ?? null;
  assert.equal(pick?.grade, "B");
  assert.match(pick?.selectionSummary ?? "", /grade \+17/);
});

test("TEST 3 - missing safeGrade derives B from the selected SAFE leg", () => {
  const safeStrike = makeLeg({ weeklyYield: 0.54, spreadPct: 12, distancePct: -8, popProfitEstimated: 0.82 });
  const explicit = makeCandidate({ ticker: "CRM", finalDisplayGrade: "A", safeGrade: "B", safeStrike });
  const missing = makeCandidate({ ticker: "CRM", finalDisplayGrade: "A", safeGrade: null, safeStrike });

  const explicitPick = pickSummary(comboByLabel([explicit], "SAFE"));
  const missingPick = pickSummary(comboByLabel([missing], "SAFE"));
  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: safeStrike, selectedMode: "SAFE", candidate: missing }), "B");
  assert.equal(missingPick?.grade, "B");
  assert.equal(missingPick?.score, explicitPick?.score);
});

test("TEST 4 - AF-03 CRM versus ORCL selects ORCL after deriving CRM SAFE as B", () => {
  const { crm, orcl } = makeCrmOrclPair(null, "A");
  const explicitPair = makeCrmOrclPair("B", "A");
  const combo = comboByLabel([crm, orcl], "SAFE");
  const explicitCombo = comboByLabel([explicitPair.crm, explicitPair.orcl], "SAFE");

  assert.equal(gradeLeg({ spreadPct: 12, weeklyYieldPct: 0.54, popDecimal: 0.82 }), "B");
  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: crm.safeStrike, selectedMode: "SAFE", candidate: crm }), "B");
  assert.equal(combo?.picks?.[0]?.ticker, "ORCL");
  assert.equal(combo?.picks?.[0]?.grade, "B");
  assert.equal(combo?.picks?.[0]?.selectionScore, explicitCombo?.picks?.[0]?.selectionScore);
});

test("TEST 5 - explicit and missing correct safeGrade produce the same order and portfolio", () => {
  const missingPair = makeCrmOrclPair(null, "A");
  const explicitPair = makeCrmOrclPair("B", "A");

  assert.deepEqual(
    pickSummary(comboByLabel([missingPair.crm, missingPair.orcl], "SAFE")),
    pickSummary(comboByLabel([explicitPair.crm, explicitPair.orcl], "SAFE")),
  );
});

test("TEST 6 - sourceGrade changes do not change selected leg grade, score, or portfolio", () => {
  const summaries = ["A", "B", "WATCH"].map((sourceGrade) => {
    const { crm, orcl } = makeCrmOrclPair(null, sourceGrade);
    return pickSummary(comboByLabel([crm, orcl], "SAFE"));
  });

  assert.deepEqual(summaries[0], summaries[1]);
  assert.deepEqual(summaries[1], summaries[2]);
});

test("TEST 7 - POP null remains unknown and selected leg grade is derived without source fallback", () => {
  const { crm } = makeCrmOrclPair(null, "A", null);
  const combo = comboByLabel([crm], "SAFE");
  const pick = combo?.picks?.[0] ?? null;

  assert.equal(getLegPopPct(crm.safeStrike), null);
  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: crm.safeStrike, selectedMode: "SAFE", candidate: crm }), "B");
  assert.equal(pick?.grade, "B");
  assert.equal(pick?.popEstimate, null);
});

test("TEST 8 - real POP zero stays zero and follows existing WATCH gate", () => {
  const safeStrike = makeLeg({ weeklyYield: 0.6, spreadPct: 8, distancePct: -8, popProfitEstimated: 0 });
  const candidate = makeCandidate({ ticker: "CRM", finalDisplayGrade: "A", safeGrade: null, safeStrike });
  const combo = comboByLabel([candidate], "SAFE");

  assert.equal(getLegPopPct(safeStrike), 0);
  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: safeStrike, selectedMode: "SAFE", candidate }), "WATCH");
  assert.equal(combo?.picks?.length ?? 0, 0);
});

test("TEST 9 - AGGRESSIVE explicit aggressiveGrade is used", () => {
  const aggressiveStrike = makeLeg({
    weeklyYield: 1.2,
    spreadPct: 8,
    distancePct: -8,
    popProfitEstimated: 0.86,
  });
  const candidate = makeCandidate({
    ticker: "NFLX",
    finalDisplayGrade: "B",
    aggressiveGrade: "A",
    aggressiveStrike,
  });
  const pick = comboByLabel([candidate], "AGGRESSIVE")?.picks?.[0] ?? null;

  assert.equal(resolveSelectedLegGrade({ explicitGrade: "A", selectedLeg: aggressiveStrike, selectedMode: "AGGRESSIVE", candidate }), "A");
  assert.equal(pick?.grade, "A");
});

test("TEST 10 - AGGRESSIVE missing aggressiveGrade derives from AGGRESSIVE leg, not source", () => {
  const aggressiveStrike = makeLeg({
    weeklyYield: 1.0,
    spreadPct: 20,
    distancePct: -8,
    popProfitEstimated: 0.82,
  });
  const candidate = makeCandidate({
    ticker: "NFLX",
    finalDisplayGrade: "A",
    aggressiveGrade: null,
    aggressiveStrike,
  });
  const pick = comboByLabel([candidate], "AGGRESSIVE")?.picks?.[0] ?? null;

  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: aggressiveStrike, selectedMode: "AGGRESSIVE", candidate }), "B");
  assert.equal(pick?.grade, "B");
  assert.match(pick?.selectionSummary ?? "", /grade \+14/);
});

test("TEST 11 - current BALANCED selection rule keeps choosing existing SAFE or AGGRESSIVE legs", () => {
  const safeChosen = makeCandidate({
    ticker: "CRM",
    finalDisplayGrade: "A",
    safeStrike: makeLeg({ strike: 50, bid: 0.4, weeklyYield: 0.8, spreadPct: 12, distancePct: -8 }),
    aggressiveStrike: makeLeg({ strike: 55, bid: 0.66, weeklyYield: 1.2, spreadPct: 8, distancePct: -7 }),
  });
  const aggressiveChosen = makeCandidate({
    ticker: "ORCL",
    finalDisplayGrade: "A",
    safeStrike: makeLeg({ strike: 45, bid: 0.27, weeklyYield: 0.6, spreadPct: 12, distancePct: -9 }),
    aggressiveStrike: makeLeg({ strike: 50, bid: 0.4, weeklyYield: 0.8, spreadPct: 12, distancePct: -8 }),
  });

  const safePick = comboByLabel([safeChosen], "BALANCED")?.picks?.[0] ?? null;
  const aggressivePick = comboByLabel([aggressiveChosen], "BALANCED")?.picks?.[0] ?? null;

  assert.equal(safePick?.strike, 50);
  assert.equal(safePick?.premiumUnit, 0.4);
  assert.equal(safePick?.grade, "B");
  assert.equal(aggressivePick?.strike, 50);
  assert.equal(aggressivePick?.premiumUnit, 0.4);
  assert.equal(aggressivePick?.grade, "B");
});

test("TEST 12 - future BALANCED-style selected leg can resolve grade generically", () => {
  const selectedLeg = makeLeg({ mode: "BALANCED", weeklyYield: 0.54, spreadPct: 12, popProfitEstimated: 0.82 });
  const candidate = makeCandidate({ finalDisplayGrade: "A" });

  assert.equal(resolveSelectedLegGrade({ explicitGrade: "A", selectedLeg, selectedMode: "BALANCED", candidate }), "A");
  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg, selectedMode: "BALANCED", candidate }), "B");
  assert.equal(candidate.balancedLeg, undefined);
});

test("TEST 13 - missing leg creates no pick and does not use source grade", () => {
  const candidate = makeCandidate({ ticker: "CRM", finalDisplayGrade: "A", safeGrade: null });

  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: null, selectedMode: "SAFE", candidate }), null);
  assert.equal(comboByLabel([candidate], "SAFE"), null);
});

test("TEST 14 - insufficient leg metrics do not fabricate A or B", () => {
  const safeStrike = makeLeg({ weeklyYield: 0.54, spreadPct: POP_MISSING, popProfitEstimated: 0.82 });
  const candidate = makeCandidate({ ticker: "CRM", finalDisplayGrade: "A", safeGrade: null, safeStrike });

  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: safeStrike, selectedMode: "SAFE", candidate }), "WATCH");
  assert.equal(comboByLabel([candidate], "SAFE"), null);
});

test("TEST 15 - equal-score tie behavior is deterministic and independent of input order", () => {
  const crm = makeCandidate({
    ticker: "CRM",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "B",
    safeGrade: "B",
    safeStrike: makeLeg({ weeklyYield: 0.54, spreadPct: 12, distancePct: -8 }),
  });
  const orcl = makeCandidate({
    ticker: "ORCL",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "B",
    safeGrade: "B",
    safeStrike: makeLeg({ weeklyYield: 0.54, spreadPct: 12, distancePct: -8 }),
  });

  // AF-05: perfect ties use the canonical ticker tie-break, not input order.
  assert.equal(comboByLabel([crm, orcl], "SAFE")?.picks?.[0]?.ticker, "CRM");
  assert.equal(comboByLabel([orcl, crm], "SAFE")?.picks?.[0]?.ticker, "CRM");
});
