import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  buildCapitalComboCandidate,
  buildCapitalComboScoreBreakdown,
  resolveSelectedLegProScore,
  computeLegProFinalScore,
  computeLegProDistanceScore,
  getLegExecutionScore,
} from "./capitalComboPortfolio.js";

const OPTS = { optimizerV2: { leftoverDensityPassEnabled: false } };

function makeLeg({
  strike,
  bid,
  yieldPct,
  spreadPct = 8,
  distancePct = -10,
  popDecimal = 0.9,
  volume = 500,
  openInterest = 1000,
  proFinalScore,
  proDistanceScore,
  proExecutionScore,
  dteDays = 7,
} = {}) {
  const premium = bid ?? (yieldPct != null && strike ? (yieldPct * strike) / 100 : null);
  const leg = {
    strike,
    bid: premium,
    ask: premium != null ? premium * 1.05 : null,
    premiumUsed: premium,
    mid: premium,
    weeklyYield: yieldPct,
    periodYield: yieldPct,
    dteDays,
    distancePct,
    popProfitEstimated: popDecimal,
    liquidity: { spreadPct },
    volume,
    openInterest,
    source: "IBKR live",
  };
  if (proFinalScore !== undefined) leg.proFinalScore = proFinalScore;
  if (proDistanceScore !== undefined) leg.proDistanceScore = proDistanceScore;
  if (proExecutionScore !== undefined) leg.proExecutionScore = proExecutionScore;
  return leg;
}

function makeCandidate({
  ticker = "AAPL",
  safe = null,
  agg = null,
  safeGrade = "A",
  aggressiveGrade = "A",
  finalDisplayMode = "SAFE",
  finalDisplayGrade = "A",
  proFinalScore = 0.02,
  proExecutionScore = 0.8,
  proDistanceScore = 0.9,
  targetExpiration = "2026-07-17",
  dteDays = 7,
} = {}) {
  return {
    ticker,
    dteDays,
    safeStrike: safe,
    aggressiveStrike: agg,
    safeGrade,
    aggressiveGrade,
    finalDisplayMode,
    finalDisplayGrade,
    targetExpiration,
    expiration: targetExpiration,
    currentPrice: 55,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    qualityScore: 0.85,
    proFinalScore,
    proExecutionScore,
    proDistanceScore,
  };
}

function expectedProFromLeg(leg, candidate) {
  const exec = getLegExecutionScore(leg);
  const dist = computeLegProDistanceScore(leg, candidate);
  const fin = computeLegProFinalScore(leg, candidate, exec, dist);
  return { proFinalScore: fin, proExecutionScore: exec, proDistanceScore: dist };
}

function comboPick(pool, label, ticker, options = {}) {
  const capital = options.capital ?? 100000;
  const maxPositions = options.maxPositions ?? 1;
  const combo = buildPortfolioCombos(pool, capital, 100, maxPositions, new Set(), { ...OPTS, ...options })
    .find((c) => c?.label === label);
  return combo?.picks?.find((p) => p.ticker === ticker) ?? null;
}

function stripFinancial(combo) {
  if (!combo) return null;
  return {
    picks: (combo.picks || []).map((p) => ({
      ticker: p.ticker,
      strike: p.strike,
      premiumUnit: p.premiumUnit,
      contracts: p.contracts,
      capitalUsed: p.capitalUsed,
      weeklyReturn: p.weeklyReturn,
      spreadPct: p.spreadPct,
    })),
    totalCapital: combo.totalCapital,
  };
}

function deepFreeze(obj, seen = new Set()) {
  if (obj === null || typeof obj !== "object" || seen.has(obj)) return obj;
  seen.add(obj);
  for (const k of Object.keys(obj)) deepFreeze(obj[k], seen);
  return Object.freeze(obj);
}

const safeLeg = makeLeg({ strike: 50, bid: 0.30, yieldPct: 0.60, distancePct: -10, volume: 100, openInterest: 100 });
const aggLeg = makeLeg({ strike: 52, bid: 0.55, yieldPct: 1.06, distancePct: -6, volume: 800, openInterest: 2000 });
const safeExpected = expectedProFromLeg(safeLeg);
const aggExpected = expectedProFromLeg(aggLeg);

test("TEST 1 — SAFE sélectionnée : score utilisé = SAFE", () => {
  const c = makeCandidate({ ticker: "AAPL", safe: safeLeg, agg: aggLeg, finalDisplayMode: "SAFE" });
  const built = buildCapitalComboCandidate(c, 100000);
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Math.abs(resolved.proFinalScore - safeExpected.proFinalScore) < 1e-5);
  assert.equal(resolved.proScoreSource, "selected_leg_recomputed");
});

test("TEST 2 — AGGRESSIVE sélectionnée : score AGG recalculé, jamais SAFE parent", () => {
  const parentSafeScore = 0.02;
  const c = makeCandidate({
    ticker: "TSLA",
    safe: safeLeg,
    agg: aggLeg,
    finalDisplayMode: "AGGRESSIVE",
    aggressiveGrade: "A",
    proFinalScore: parentSafeScore,
  });
  const pick = comboPick([c], "AGGRESSIVE", "TSLA");
  assert.ok(pick);
  assert.equal(pick.strike, 52);
  const built = buildCapitalComboCandidate(c, 100000);
  built.selectedLeg = aggLeg;
  built.selectedLegMode = "AGGRESSIVE";
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Math.abs(resolved.proFinalScore - aggExpected.proFinalScore) < 1e-5);
  assert.notEqual(resolved.proFinalScore, parentSafeScore);
});

test("TEST 3 — BALANCED→SAFE : score SAFE", () => {
  const safeBal = makeLeg({ strike: 40, bid: 0.32, yieldPct: 0.80, distancePct: -9 });
  const aggBal = makeLeg({ strike: 43, bid: 0.90, yieldPct: 2.09, distancePct: -3 });
  const c = makeCandidate({ ticker: "CRM", safe: safeBal, agg: aggBal, finalDisplayMode: "SAFE" });
  const pick = comboPick([c], "BALANCED", "CRM");
  assert.ok(pick);
  assert.equal(pick.strike, 40);
  const exp = expectedProFromLeg(safeBal);
  const built = buildCapitalComboCandidate(c, 100000);
  built.selectedLeg = safeBal;
  built.selectedLegMode = "SAFE";
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Math.abs(resolved.proFinalScore - exp.proFinalScore) < 1e-5);
});

test("TEST 4 — BALANCED→AGGRESSIVE : score AGGRESSIVE", () => {
  const safeBal = makeLeg({ strike: 40, bid: 0.28, yieldPct: 0.70, distancePct: -9 });
  const aggBal = makeLeg({ strike: 43, bid: 0.86, yieldPct: 0.95, distancePct: -3 });
  const c = makeCandidate({ ticker: "ORCL", safe: safeBal, agg: aggBal, finalDisplayMode: "AGGRESSIVE", aggressiveGrade: "A" });
  const pick = comboPick([c], "BALANCED", "ORCL");
  assert.ok(pick);
  assert.equal(pick.strike, 43);
  const exp = expectedProFromLeg(aggBal);
  const built = buildCapitalComboCandidate(c, 100000);
  built.selectedLeg = aggBal;
  built.selectedLegMode = "AGGRESSIVE";
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Math.abs(resolved.proFinalScore - exp.proFinalScore) < 1e-5);
});

test("TEST 5 — fallback AF-07 vers SAFE : score jambe retenue", () => {
  const safeBal = makeLeg({ strike: 40, bid: 0.30, yieldPct: 0.75, distancePct: -9 });
  const aggBal = makeLeg({ strike: 43, bid: 0.90, yieldPct: 2.09, distancePct: -3 });
  const c = makeCandidate({ ticker: "NFLX", safe: safeBal, agg: aggBal, proFinalScore: 0.99 });
  const pick = comboPick([c], "BALANCED", "NFLX");
  assert.ok(pick);
  assert.equal(pick.strike, 40);
  const exp = expectedProFromLeg(safeBal);
  const built = buildCapitalComboCandidate(c, 100000);
  built.selectedLeg = safeBal;
  built.selectedLegMode = "SAFE";
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Math.abs(resolved.proFinalScore - exp.proFinalScore) < 1e-5);
  assert.notEqual(resolved.proFinalScore, 0.99);
});

test("TEST 6 — fallback AF-07 vers AGGRESSIVE si chemin atteignable", () => {
  const safeBal = makeLeg({ strike: 40, bid: 0.20, yieldPct: 0.50, distancePct: -12 });
  const aggBal = makeLeg({ strike: 43, bid: 0.86, yieldPct: 0.95, distancePct: -3 });
  const c = makeCandidate({ ticker: "MSFT", safe: safeBal, agg: aggBal, aggressiveGrade: "A", proFinalScore: 0.01 });
  const pick = comboPick([c], "BALANCED", "MSFT");
  assert.ok(pick);
  assert.equal(pick.strike, 43);
  const exp = expectedProFromLeg(aggBal);
  const built = buildCapitalComboCandidate(c, 100000);
  built.selectedLeg = aggBal;
  built.selectedLegMode = "AGGRESSIVE";
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Math.abs(resolved.proFinalScore - exp.proFinalScore) < 1e-5);
});

test("TEST 7 — écart historique ~3,6 points supprimé", () => {
  const safeScored = { ...safeLeg, proFinalScore: 0, proDistanceScore: 0 };
  const aggScored = { ...aggLeg, proFinalScore: 1, proDistanceScore: 1 };
  const c = makeCandidate({
    ticker: "GTEST",
    safe: safeScored,
    agg: aggScored,
    finalDisplayMode: "AGGRESSIVE",
    aggressiveGrade: "A",
    proFinalScore: 0,
    proDistanceScore: 0,
    proExecutionScore: 0,
  });
  const builtWrong = buildCapitalComboCandidate(c, 100000);
  builtWrong.selectedLeg = aggScored;
  builtWrong.selectedLegMode = "AGGRESSIVE";
  builtWrong.proFinalScore = 0;
  builtWrong.proDistanceScore = 0;
  builtWrong.proExecutionScore = 0;
  const modeAgg = {
    minWeeklyYield: 0.95,
    maxWeeklyYield: null,
    maxSpreadPct: 25,
    distanceTargetAbs: 5,
    weights: { grade: 20, yield: 24, spread: 14, distance: 10, quality: 12, riskPenalty: 10, capitalFit: 12, diversificationPenalty: 8 },
  };
  const poolStats = { sectorCounts: new Map([["technology", 1]]), themeCounts: new Map([["none", 1]]) };
  const scoreWrong = buildCapitalComboScoreBreakdown(builtWrong, modeAgg, 100000, poolStats).totalScore;

  const fixedPro = resolveSelectedLegProScore(builtWrong);
  builtWrong.proFinalScore = fixedPro.proFinalScore;
  builtWrong.proDistanceScore = fixedPro.proDistanceScore;
  builtWrong.proExecutionScore = fixedPro.proExecutionScore;
  const scoreFixed = buildCapitalComboScoreBreakdown(builtWrong, modeAgg, 100000, poolStats).totalScore;
  const delta = Math.abs(scoreFixed - scoreWrong);
  assert.ok(delta > 0, "ancien et nouveau score doivent différer");
  assert.ok(delta <= 6, `écart attendu <= 6 pts, obtenu ${delta}`);
  assert.equal(fixedPro.proFinalScore, 1);
});

test("TEST 8 — ordre serré : score recalculé peut modifier l'ordre", () => {
  const mk = (ticker, proFinalScore) => makeCandidate({
    ticker,
    safe: makeLeg({ strike: 50, bid: 0.30, yieldPct: 0.60, proFinalScore, proDistanceScore: proFinalScore }),
    agg: makeLeg({ strike: 52, bid: 0.55, yieldPct: 1.06, distancePct: -6 }),
    finalDisplayMode: "SAFE",
    safeGrade: "A",
  });
  const order = (pool) => buildPortfolioCombos(pool, 100000, 100, 2, new Set(), OPTS)
    .find((c) => c.label === "SAFE")?.picks?.map((p) => p.ticker) ?? [];
  const o1 = order([mk("AAPL", 0.001), mk("MSFT", 0.95)]);
  const o2 = order([mk("MSFT", 0.95), mk("AAPL", 0.001)]);
  assert.deepEqual(o1, o2);
  assert.equal(o1[0], "MSFT");
});

test("TEST 9 — pas de changement de strike", () => {
  const c = makeCandidate({ ticker: "AAPL", safe: safeLeg, agg: aggLeg, finalDisplayMode: "AGGRESSIVE", aggressiveGrade: "A" });
  const pick = comboPick([c], "AGGRESSIVE", "AAPL");
  assert.equal(pick?.strike, 52);
});

test("TEST 10 — pas de changement de contrats (déterminisme)", () => {
  const c = makeCandidate({ ticker: "AAPL", safe: safeLeg, agg: aggLeg, finalDisplayMode: "SAFE" });
  const p1 = comboPick([c], "SAFE", "AAPL", { maxPositions: 10 });
  const p2 = comboPick([c], "SAFE", "AAPL", { maxPositions: 10 });
  assert.equal(p1?.contracts, p2?.contracts);
});

test("TEST 11 — pas de changement de caps : totalCapital identique ordre inversé", () => {
  const pool = [
    makeCandidate({ ticker: "AAPL", safe: safeLeg, safeGrade: "A", finalDisplayMode: "SAFE" }),
    makeCandidate({ ticker: "MSFT", safe: makeLeg({ strike: 51, bid: 0.31, yieldPct: 0.61 }), safeGrade: "A", finalDisplayMode: "SAFE" }),
  ];
  const a = buildPortfolioCombos(pool, 100000, 100, 10, new Set(), OPTS).find((c) => c.label === "SAFE");
  const b = buildPortfolioCombos([...pool].reverse(), 100000, 100, 10, new Set(), OPTS).find((c) => c.label === "SAFE");
  assert.equal(a?.totalCapital, b?.totalCapital);
});

test("TEST 12 — ordre d'entrée inversé : AF-05 préservée", () => {
  const pool = [
    makeCandidate({ ticker: "AAA", safe: makeLeg({ strike: 50, bid: 0.30, yieldPct: 0.60 }), safeGrade: "A", finalDisplayMode: "SAFE" }),
    makeCandidate({ ticker: "BBB", safe: makeLeg({ strike: 51, bid: 0.31, yieldPct: 0.61 }), safeGrade: "A", finalDisplayMode: "SAFE" }),
    makeCandidate({ ticker: "CCC", safe: makeLeg({ strike: 52, bid: 0.32, yieldPct: 0.62 }), safeGrade: "A", finalDisplayMode: "SAFE" }),
  ];
  const strip = (p) => JSON.stringify(stripFinancial(buildPortfolioCombos(p, 100000, 100, 10, new Set(), OPTS).find((c) => c.label === "SAFE")));
  assert.equal(strip(pool), strip([...pool].reverse()));
});

test("TEST 13 — score explicite sur selectedLeg prioritaire", () => {
  const leg = makeLeg({ strike: 50, bid: 0.30, yieldPct: 0.60, proFinalScore: 0.777, proDistanceScore: 0.888 });
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  built.selectedLeg = leg;
  built.selectedLegMode = "SAFE";
  const resolved = resolveSelectedLegProScore(built);
  assert.equal(resolved.proFinalScore, 0.777);
  assert.equal(resolved.proDistanceScore, 0.888);
  assert.equal(resolved.proScoreSource, "selected_leg_explicit");
});

test("TEST 14 — score selectedLeg absent mais recalculable", () => {
  const built = buildCapitalComboCandidate(makeCandidate({ safe: safeLeg, agg: aggLeg }), 100000);
  built.selectedLeg = aggLeg;
  built.selectedLegMode = "AGGRESSIVE";
  const resolved = resolveSelectedLegProScore(built);
  assert.equal(resolved.proScoreSource, "selected_leg_recomputed");
  assert.ok(resolved.proFinalScore > 0);
});

test("TEST 15 — objet legacy SAFE parent : fallback compatible", () => {
  const c = { ticker: "LEGY", safeStrike: safeLeg, safeGrade: "A", proFinalScore: 0.045, proExecutionScore: 0.7, proDistanceScore: 0.8 };
  const built = buildCapitalComboCandidate(c, 100000);
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Math.abs(resolved.proFinalScore - expectedProFromLeg(safeLeg).proFinalScore) < 1e-5
    || resolved.proScoreSource === "selected_leg_recomputed");
});

test("TEST 16 — objet legacy indéterminable : valeur neutre contrôlée", () => {
  const resolved = resolveSelectedLegProScore({ ticker: "X", proFinalScore: NaN, proDistanceScore: Infinity });
  assert.equal(resolved.proFinalScore, 0);
  assert.equal(resolved.proDistanceScore, 0);
  assert.equal(resolved.proScoreSource, "neutral_fallback");
});

test("TEST 17 — NaN protégé", () => {
  const leg = makeLeg({ strike: 50, bid: 0.30, yieldPct: 0.60, proFinalScore: NaN });
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  built.selectedLeg = leg;
  built.selectedLegMode = "SAFE";
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Number.isFinite(resolved.proFinalScore));
});

test("TEST 18 — Infinity protégé", () => {
  const leg = makeLeg({ strike: 50, bid: 0.30, yieldPct: 0.60, proDistanceScore: Infinity });
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  built.selectedLeg = leg;
  built.selectedLegMode = "SAFE";
  const resolved = resolveSelectedLegProScore(built);
  assert.ok(Number.isFinite(resolved.proDistanceScore));
});

test("TEST 19 — aucune mutation", () => {
  const pool = [makeCandidate({ ticker: "AAPL", safe: safeLeg, safeGrade: "A", finalDisplayMode: "SAFE" })];
  const snap = JSON.stringify(pool);
  deepFreeze(pool);
  comboPick(pool, "SAFE", "AAPL");
  assert.equal(JSON.stringify(pool), snap);
});

test("TEST 20 — répétition déterministe 20 exécutions", () => {
  const pool = [makeCandidate({ ticker: "AAPL", safe: safeLeg, agg: aggLeg, finalDisplayMode: "AGGRESSIVE", aggressiveGrade: "A" })];
  const ref = JSON.stringify(comboPick(pool, "AGGRESSIVE", "AAPL"));
  for (let i = 0; i < 20; i++) {
    assert.equal(JSON.stringify(comboPick(pool, "AGGRESSIVE", "AAPL")), ref, `run ${i + 1}`);
  }
});
