// AF-17 — Allocation / picks / invariants 7 DTE vs multi-DTE.
//
// CHANGEMENT DE CONTRAT (2026-07-14) : l'admissibilité des bandes de bucket se
// décide désormais sur le rendement PÉRIODE (jusqu'à expiration), plus sur le
// 7J normalisé (tests 56-57 réécrits explicitement). Le 7J reste calculé,
// persisté (weeklyReturn des picks) et exposé pour la comparaison DTE.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPortfolioCombos,
  buildCapitalComboCandidate,
  getLegWeeklyNormalizedYieldPct,
  getLegPeriodYieldPct,
  projectSelectedLegMetadata,
  resolveSelectedLegProScore,
} from "./capitalComboPortfolio.js";

function makeLeg({
  strike,
  yieldPct,
  spreadPct = 8,
  distancePct = -9,
  popDecimal = 0.9,
  dteDays = 7,
} = {}) {
  const bid = Number(((yieldPct * strike) / 100).toFixed(4));
  const weeklyNorm =
    dteDays > 0 ? Number(((yieldPct * 7) / dteDays).toFixed(4)) : yieldPct;
  return {
    strike,
    bid,
    ask: Number((bid * 1.05).toFixed(4)),
    premiumUsed: bid,
    weeklyYield: yieldPct,
    periodYield: yieldPct,
    weeklyNormalizedYield: weeklyNorm,
    dteDays,
    distancePct,
    popProfitEstimated: popDecimal,
    liquidity: { spreadPct },
    volume: 300,
    openInterest: 800,
  };
}

function makeCandidate({
  ticker,
  dteDays = 7,
  safe = null,
  agg = null,
  finalDisplayMode = "AGGRESSIVE",
  finalDisplayGrade = "A",
} = {}) {
  return {
    ticker,
    dteDays,
    safeStrike: safe,
    aggressiveStrike: agg,
    safeGrade: safe ? "A" : null,
    aggressiveGrade: agg ? "A" : null,
    finalDisplayMode,
    finalDisplayGrade,
    proFinalScore: 0.85,
    proExecutionScore: 0.75,
    proDistanceScore: 0.7,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
  };
}

function runCombos(pool, capital = 100000) {
  return buildPortfolioCombos(pool, capital, 100, 10, new Set(), {
    optimizerV2: {},
    capitalComboTraceSuppressConsoleLogs: true,
  });
}

function pickByTicker(combo, ticker) {
  return (combo?.picks ?? []).find((p) => p.ticker === ticker) ?? null;
}

test("55 allocation 7 DTE homogène — NVDA admissible BALANCED", () => {
  const pool = [
    makeCandidate({
      ticker: "NVDA",
      dteDays: 7,
      safe: makeLeg({ strike: 40, yieldPct: 0.72, dteDays: 7 }),
      agg: makeLeg({ strike: 43, yieldPct: 0.88, dteDays: 7, distancePct: -4, spreadPct: 10 }),
    }),
  ];
  const combos = runCombos(pool);
  const bal = combos.find((c) => c.label === "BALANCED");
  assert.ok(bal?.picks?.length >= 1);
  const p = pickByTicker(bal, "NVDA");
  approx(p.weeklyReturn, 0.88, 0.01);
});

test("56 candidate 3 DTE 0,50 % période — bande décidée par la PÉRIODE : admissible SAFE, pas AGGRESSIVE", () => {
  // Ancienne règle AF-17 : le 7J ~1,17 % sortait cette jambe de SAFE (plafond
  // hebdo 0,80) et le 7J de la jambe agressive (~1,28 %) la rendait admissible
  // AGGRESSIVE. Nouvelle règle : la bande utilise le rendement jusqu'à
  // expiration — 0,50 % ∈ [0,45 ; 0,80) SAFE ; 0,55 % < 0,95 hors AGGRESSIVE.
  const pool = [
    makeCandidate({
      ticker: "AAPL",
      dteDays: 3,
      safe: makeLeg({ strike: 40, yieldPct: 0.5, dteDays: 3 }),
      agg: makeLeg({ strike: 43, yieldPct: 0.55, dteDays: 3, distancePct: -6, spreadPct: 10 }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const built = buildCapitalComboCandidate(pool[0], 100000);
  approx(built._safeYieldPct, 1.1667, 0.02); // 7J toujours calculé (comparaison DTE)
  approx(built._safePeriodYieldPct, 0.5, 0.01);
  const { admissibleSafe, admissibleAgg } = combosSafeAgg(pool);
  assert.equal(admissibleSafe, true, "0,50 % période dans la bande SAFE [0,45 ; 0,80)");
  assert.equal(admissibleAgg, false, "0,55 % période < min AGGRESSIVE 0,95 malgré 7J ~1,28 %");
});

function combosSafeAgg(pool) {
  const combos = runCombos(pool);
  return {
    admissibleSafe: combos.some((c) => c.label === "SAFE" && pickByTicker(c, pool[0].ticker)),
    admissibleAgg: combos.some((c) => c.label === "AGGRESSIVE" && pickByTicker(c, pool[0].ticker)),
  };
}

test("57 candidate 30 DTE 1,50 % période — admissible AGGRESSIVE par la PÉRIODE malgré 7J 0,35 %", () => {
  // Ancienne règle AF-17 : 7J 0,35 % < 0,95 rejetait ce candidat AGGRESSIVE.
  // Nouvelle règle : 1,50 % période >= 0,95 → admissible (indépendance DTE).
  const pool = [
    makeCandidate({
      ticker: "MSFT",
      dteDays: 30,
      safe: makeLeg({ strike: 40, yieldPct: 1.2, dteDays: 30 }),
      agg: makeLeg({ strike: 43, yieldPct: 1.5, dteDays: 30, distancePct: -6, spreadPct: 10 }),
    }),
  ];
  const built = buildCapitalComboCandidate(pool[0], 100000);
  approx(built._aggYieldPct, 0.35, 0.02); // 7J toujours calculé (comparaison DTE)
  approx(built._aggPeriodYieldPct, 1.5, 0.01);
  const combos = runCombos(pool);
  const agg = combos.find((c) => c.label === "AGGRESSIVE");
  assert.ok(pickByTicker(agg, "MSFT"), "bande AGGRESSIVE décidée par le rendement expiration");
});

test("58 capital par contrat inchangé", () => {
  const c = makeCandidate({
    ticker: "NVDA",
    dteDays: 7,
    safe: makeLeg({ strike: 40, yieldPct: 0.72 }),
    agg: makeLeg({ strike: 43, yieldPct: 0.88, distancePct: -4 }),
  });
  const built = buildCapitalComboCandidate(c, 100000);
  assert.equal(built.capitalPerContract, 4300);
});

test("59 contrats inchangés si même pick 7 DTE", () => {
  const pool = [
    makeCandidate({
      ticker: "NVDA",
      dteDays: 7,
      safe: makeLeg({ strike: 40, yieldPct: 0.72 }),
      agg: makeLeg({ strike: 43, yieldPct: 0.88, distancePct: -4, spreadPct: 10 }),
    }),
  ];
  const combos = runCombos(pool);
  const bal = combos.find((c) => c.label === "BALANCED");
  const p = pickByTicker(bal, "NVDA");
  assert.ok(p.contracts >= 1);
  assert.equal(p.capitalUsed, p.contracts * p.strike * 100);
});

test("60 changement pick 3 DTE vs 7 DTE même prime période", () => {
  const short = buildCapitalComboCandidate(
    makeCandidate({
      ticker: "AAPL",
      dteDays: 3,
      agg: makeLeg({ strike: 43, yieldPct: 0.95, dteDays: 3, distancePct: -4 }),
    }),
    100000,
  );
  const week = buildCapitalComboCandidate(
    makeCandidate({
      ticker: "AAPL",
      dteDays: 7,
      agg: makeLeg({ strike: 43, yieldPct: 0.95, dteDays: 7, distancePct: -4 }),
    }),
    100000,
  );
  assert.ok(short._aggYieldPct > week._aggYieldPct);
});

test("61 caps structurellement présents", () => {
  const combos = runCombos([
    makeCandidate({
      ticker: "NVDA",
      safe: makeLeg({ strike: 40, yieldPct: 0.72 }),
      agg: makeLeg({ strike: 43, yieldPct: 0.88, distancePct: -4 }),
    }),
  ]);
  assert.ok(combos.length >= 1);
});

test("62 soft cap / free capital — combo retourne freeCapital", () => {
  const combos = runCombos([
    makeCandidate({
      ticker: "NVDA",
      safe: makeLeg({ strike: 40, yieldPct: 0.72 }),
      agg: makeLeg({ strike: 43, yieldPct: 0.88, distancePct: -4 }),
    }),
  ]);
  const bal = combos.find((c) => c.label === "BALANCED");
  assert.ok(Number.isFinite(Number(bal?.freeCapital)));
});

test("63 pool 7 DTE équivalent — weekly = period", () => {
  const l = makeLeg({ strike: 40, yieldPct: 0.7, dteDays: 7 });
  assert.equal(getLegPeriodYieldPct(l, { dteDays: 7 }), getLegWeeklyNormalizedYieldPct(l, { dteDays: 7 }));
});

test("64 pro score utilise hebdomadaire une fois", () => {
  const c = buildCapitalComboCandidate(
    makeCandidate({
      ticker: "NVDA",
      dteDays: 3,
      agg: makeLeg({ strike: 43, yieldPct: 0.5, dteDays: 3, distancePct: -4 }),
    }),
    100000,
  );
  const pro = resolveSelectedLegProScore(c);
  assert.ok(Number.isFinite(pro.proFinalScore));
  assert.ok(pro.proFinalScore >= 0);
});

test("65 metadata AF-15 inchangées structurellement", () => {
  const c = buildCapitalComboCandidate(
    makeCandidate({
      ticker: "NVDA",
      safe: makeLeg({ strike: 40, yieldPct: 0.72 }),
      agg: makeLeg({ strike: 43, yieldPct: 0.88, distancePct: -4 }),
    }),
    100000,
  );
  const meta = projectSelectedLegMetadata(c);
  assert.ok("expiration" in meta && "dte" in meta && "bid" in meta);
});

test("66 mode finalDisplayMode inchangé à la construction", () => {
  const c = buildCapitalComboCandidate(
    makeCandidate({ ticker: "NVDA", finalDisplayMode: "SAFE", safe: makeLeg({ strike: 40, yieldPct: 0.72 }), agg: makeLeg({ strike: 43, yieldPct: 0.88 }) }),
    100000,
  );
  assert.equal(c.finalDisplayMode, "SAFE");
});

test("67 explicit weeklyNormalizedYield sans DTE", () => {
  const l = { strike: 40, bid: 0.2, weeklyNormalizedYield: 0.81, weeklyYield: 0.5 };
  assert.equal(getLegWeeklyNormalizedYieldPct(l, {}), 0.81);
});

function approx(a, b, eps = 0.01) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `${a} ≈ ${b}`);
}
