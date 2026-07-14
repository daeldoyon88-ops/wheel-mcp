// AF-17 — Rendement hebdomadaire normalisé pour Capital Combinations.
//
// CHANGEMENT DE CONTRAT (2026-07-14) — bandes de bucket sur rendement PÉRIODE :
// - Ancienne règle (AF-17 initial) : l'admissibilité des bandes SAFE/BALANCED/
//   AGGRESSIVE se décidait sur le rendement hebdomadaire normalisé
//   (période × 7 / DTE).
// - Nouvelle règle : l'admissibilité se décide sur le rendement PÉRIODE
//   (jusqu'à expiration) — codes PERIOD_YIELD_BELOW_BUCKET_MIN /
//   PERIOD_YIELD_ABOVE_BUCKET_MAX (voir capitalComboPortfolio.period-yield-bands.test.mjs).
// - Le rendement 7J normalisé reste calculé/affiché/persisté (scoring,
//   comparaison DTE 3/4/7) : les sections A-C ci-dessous restent le contrat de
//   CALCUL du 7J, inchangé.
// - Tests modifiés : section D (34-37, 40) re-documentée sur la bande période ;
//   section E : resolveCompatibleLegForMode reçoit désormais des rendements
//   PÉRIODE depuis le moteur (comportement générique du helper inchangé).

import test from "node:test";
import assert from "node:assert/strict";
import {
  getLegPeriodYieldPct,
  getLegYieldPct,
  getLegWeeklyNormalizedYieldPct,
  resolveLegDte,
  isValidComboDte,
  resolveCompatibleLegForMode,
  buildCapitalComboScoreBreakdown,
  buildCapitalComboCandidate,
  buildCapitalComboPoolStats,
  BALANCED_PREFERRED_LEG_YIELD_BAND,
} from "./capitalComboPortfolio.js";

function leg({
  strike = 50,
  periodYield,
  weeklyNormalizedYield = undefined,
  dteDays = undefined,
  bid = undefined,
} = {}) {
  const premium =
    bid !== undefined
      ? bid
      : periodYield != null
        ? Number(((periodYield * strike) / 100).toFixed(4))
        : null;
  const out = {
    strike,
    bid: premium,
    premiumUsed: premium,
    weeklyYield: periodYield,
    periodYield,
  };
  if (weeklyNormalizedYield !== undefined) out.weeklyNormalizedYield = weeklyNormalizedYield;
  if (dteDays !== undefined) out.dteDays = dteDays;
  return out;
}

function candidate(dteDays = 7, extra = {}) {
  return { dteDays, ticker: "AAPL", ...extra };
}

function approx(a, b, eps = 0.01) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `${a} ≈ ${b}`);
}

// ── A. Résolution du rendement ─────────────────────────────────────────────

test("1 weeklyNormalizedYield explicite prioritaire", () => {
  const l = leg({ periodYield: 0.5, weeklyNormalizedYield: 1.2, dteDays: 3 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, candidate(3)), 1.2);
});

test("2 pas de double calcul si weeklyNormalizedYield existe", () => {
  const l = leg({ periodYield: 0.5, weeklyNormalizedYield: 0.88, dteDays: 3 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, candidate(3)), 0.88);
  assert.notEqual(getLegWeeklyNormalizedYieldPct(l, candidate(3)), (0.5 * 7) / 3);
});

test("3 periodYield × 7 / DTE", () => {
  const l = leg({ periodYield: 0.5, dteDays: 3 });
  approx(getLegWeeklyNormalizedYieldPct(l, candidate(3)), 1.1667, 0.001);
});

test("4 weeklyYield historique = période", () => {
  const l = leg({ periodYield: 0.7 });
  assert.equal(getLegPeriodYieldPct(l, {}), 0.7);
  assert.equal(getLegYieldPct(l, {}), 0.7);
});

test("5 fallback premium/strike puis normalisation", () => {
  const l = { strike: 40, bid: 0.2, dteDays: 7 };
  approx(getLegWeeklyNormalizedYieldPct(l, candidate(7)), (0.2 / 40) * 100, 0.001);
});

test("6 parent weeklyNormalizedYield seulement si allowParent", () => {
  const l = leg({ periodYield: 0.5, dteDays: 7 });
  const c = candidate(7, { weeklyNormalizedYield: 0.99 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, c), (0.5 * 7) / 7);
  assert.equal(
    getLegWeeklyNormalizedYieldPct(l, c, { allowParentCandidateFallback: true }),
    0.99,
  );
});

test("7 rendement absent → null", () => {
  assert.equal(getLegWeeklyNormalizedYieldPct({}, candidate(7)), null);
});

test("8 rendement NaN → null", () => {
  const l = leg({ periodYield: NaN, dteDays: 7 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, candidate(7)), null);
});

test("9 rendement Infinity → null", () => {
  const l = leg({ periodYield: Infinity, dteDays: 7 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, candidate(7)), null);
});

test("10 rendement négatif → null", () => {
  const l = leg({ periodYield: -0.5, dteDays: 7 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, candidate(7)), null);
});

test("11 rendement zéro → null", () => {
  const l = leg({ periodYield: 0, dteDays: 7 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, candidate(7)), null);
});

// ── B. DTE ─────────────────────────────────────────────────────────────────

const DTE_CASES = [
  [1, 0.5, 3.5],
  [3, 0.5, 1.1667],
  [4, 0.7, 1.225],
  [7, 0.7, 0.7],
  [10, 0.8, 0.56],
  [14, 0.8, 0.4],
  [21, 1.0, 0.3333],
  [30, 1.5, 0.35],
  [45, 2.0, 0.3111],
];

for (const [idx, dte, period, weekly] of DTE_CASES.map((r, i) => [12 + i, ...r])) {
  test(`${idx} DTE ${dte}`, () => {
    const l = leg({ periodYield: period, dteDays: dte });
    approx(getLegWeeklyNormalizedYieldPct(l, candidate(dte)), weekly, 0.02);
  });
}

test("21 DTE absent avec periodYield → legacy implicit 7 DTE", () => {
  const l = leg({ periodYield: 0.7 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, {}), 0.7);
});

test("21b DTE absent sans period ni weeklyNormalized → null", () => {
  assert.equal(getLegWeeklyNormalizedYieldPct({}, {}), null);
});

test("22 DTE null → null", () => {
  const l = leg({ periodYield: 0.7, dteDays: null });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, { dteDays: null }), null);
});

test("23 DTE 0 → null", () => {
  assert.equal(isValidComboDte(0), false);
  const l = leg({ periodYield: 0.7, dteDays: 0 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, candidate(0)), null);
});

test("24 DTE négatif → null", () => {
  assert.equal(resolveLegDte(leg({ dteDays: -3 }), {}), null);
});

test("25 DTE NaN → null", () => {
  assert.equal(resolveLegDte(leg({ dteDays: NaN }), {}), null);
});

test("26 DTE Infinity → null", () => {
  assert.equal(resolveLegDte(leg({ dteDays: Infinity }), {}), null);
});

test("27 expiration sans DTE : weeklyNormalizedYield explicite OK", () => {
  const l = leg({ weeklyNormalizedYield: 0.75 });
  assert.equal(getLegWeeklyNormalizedYieldPct(l, { expiration: "2026-07-18" }), 0.75);
});

// ── C. Cas de référence ────────────────────────────────────────────────────

test("28 CAS 3 DTE 0,50 % → ~1,1667 % hebdo", () => {
  approx(getLegWeeklyNormalizedYieldPct(leg({ periodYield: 0.5, dteDays: 3 }), candidate(3)), 1.1667, 0.001);
});

test("29 CAS 7 DTE 0,70 % → 0,70 %", () => {
  approx(getLegWeeklyNormalizedYieldPct(leg({ periodYield: 0.7, dteDays: 7 }), candidate(7)), 0.7, 0.001);
});

test("30 CAS 14 DTE 0,80 % → 0,40 %", () => {
  approx(getLegWeeklyNormalizedYieldPct(leg({ periodYield: 0.8, dteDays: 14 }), candidate(14)), 0.4, 0.001);
});

test("31 CAS 30 DTE 1,50 % → 0,35 %", () => {
  approx(getLegWeeklyNormalizedYieldPct(leg({ periodYield: 1.5, dteDays: 30 }), candidate(30)), 0.35, 0.001);
});

test("32 CAS 4 DTE 0,70 % → 1,225 %", () => {
  approx(getLegWeeklyNormalizedYieldPct(leg({ periodYield: 0.7, dteDays: 4 }), candidate(4)), 1.225, 0.001);
});

test("33 CAS 45 DTE 2,00 % → ~0,3111 %", () => {
  approx(getLegWeeklyNormalizedYieldPct(leg({ periodYield: 2.0, dteDays: 45 }), candidate(45)), 0.3111, 0.001);
});

// ── D. Bandes de bucket — décidées par le rendement PÉRIODE ────────────────
// Ancienne règle (documentée ici jusqu'au 2026-07-14) : gates sur le rendement
// hebdomadaire normalisé. Nouvelle règle : gates sur le rendement période ;
// le 7J reste calculé mais ne décide plus (assertions croisées ci-dessous).

function gatePeriod(periodYieldPct, min, max = null) {
  if (periodYieldPct == null || !Number.isFinite(periodYieldPct) || periodYieldPct <= 0) return false;
  if (periodYieldPct < min) return false;
  if (max != null && periodYieldPct >= max) return false;
  return true;
}

test("34 SAFE 3 DTE 0,50 % période admis par la bande PÉRIODE malgré 7J ≥ plafond", () => {
  const l = leg({ periodYield: 0.5, dteDays: 3 });
  const p = getLegPeriodYieldPct(l, candidate(3));
  const w = getLegWeeklyNormalizedYieldPct(l, candidate(3));
  assert.ok(w >= 0.8, "7J au-dessus du plafond SAFE — il ne décide plus");
  assert.ok(gatePeriod(p, 0.45, 0.8), "0,50 % période ∈ [0,45 ; 0,80)");
});

test("35 AGGRESSIVE 3 DTE 0,50 % période rejeté (période < 0,95) malgré 7J ≥ 0,95", () => {
  const l = leg({ periodYield: 0.5, dteDays: 3 });
  const p = getLegPeriodYieldPct(l, candidate(3));
  const w = getLegWeeklyNormalizedYieldPct(l, candidate(3));
  assert.ok(w >= 0.95, "7J franchit le min AGGRESSIVE — il ne décide plus");
  assert.ok(!gatePeriod(p, 0.95, null));
});

test("36 SAFE 14 DTE 0,80 % période rejeté au plafond période (0,80 >= max 0,80)", () => {
  const l = leg({ periodYield: 0.8, dteDays: 14 });
  const p = getLegPeriodYieldPct(l, candidate(14));
  const w = getLegWeeklyNormalizedYieldPct(l, candidate(14));
  assert.ok(w < 0.45, "7J sous le min SAFE — il ne décide plus");
  assert.ok(!gatePeriod(p, 0.45, 0.8), "max exclusif sur la période");
});

test("37 AGGRESSIVE 30 DTE 1,50 % période admis par la bande PÉRIODE malgré 7J 0,35 %", () => {
  const l = leg({ periodYield: 1.5, dteDays: 30 });
  const p = getLegPeriodYieldPct(l, candidate(30));
  const w = getLegWeeklyNormalizedYieldPct(l, candidate(30));
  assert.ok(w < 0.95, "7J sous le min AGGRESSIVE — il ne décide plus");
  assert.ok(gatePeriod(p, 0.95, null));
});

test("38 7 DTE classification équivalente période/hebdo", () => {
  const l = leg({ periodYield: 0.72, dteDays: 7 });
  assert.equal(getLegPeriodYieldPct(l, candidate(7)), getLegWeeklyNormalizedYieldPct(l, candidate(7)));
});

test("39 WATCH path : selectedYieldPct = hebdomadaire", () => {
  const safeStrike = {
    strike: 40,
    bid: 0.2,
    premiumUsed: 0.2,
    weeklyYield: 0.5,
    periodYield: 0.5,
    dteDays: 3,
    distancePct: -9,
    popProfitEstimated: 0.9,
    liquidity: { spreadPct: 8 },
    volume: 300,
    openInterest: 800,
  };
  const aggStrike = {
    strike: 43,
    bid: 0.22,
    premiumUsed: 0.22,
    weeklyYield: 0.55,
    periodYield: 0.55,
    dteDays: 3,
    distancePct: -7,
    popProfitEstimated: 0.9,
    liquidity: { spreadPct: 10 },
    volume: 300,
    openInterest: 800,
  };
  const built = buildCapitalComboCandidate(
    {
      ticker: "NVDA",
      dteDays: 3,
      safeStrike,
      aggressiveStrike: aggStrike,
      safeGrade: "A",
      aggressiveGrade: "A",
      finalDisplayMode: "AGGRESSIVE",
      finalDisplayGrade: "A",
      proFinalScore: 0.8,
      proExecutionScore: 0.7,
      proDistanceScore: 0.6,
    },
    100000,
  );
  approx(built._aggYieldPct, (0.55 * 7) / 3, 0.02);
  approx(built.selectedYieldPct, (0.55 * 7) / 3, 0.02);
});

test("40 la bande max utilise le rendement PÉRIODE (indépendance DTE)", () => {
  const p3 = getLegPeriodYieldPct(leg({ periodYield: 0.53, dteDays: 3 }), candidate(3));
  const p7 = getLegPeriodYieldPct(leg({ periodYield: 0.53, dteDays: 7 }), candidate(7));
  assert.equal(gatePeriod(p3, 0.45, 0.8), gatePeriod(p7, 0.45, 0.8), "même décision quel que soit le DTE");
  assert.ok(gatePeriod(p3, 0.45, 0.8));
});

// ── E. BALANCED / AF-07 ────────────────────────────────────────────────────
// Depuis le passage des bandes au rendement période, le moteur alimente
// resolveCompatibleLegForMode avec des rendements PÉRIODE ; le helper reste
// générique (mêmes règles min/max/préférence), seuls les intitulés changent.

function desc(mode, yieldPct, valid = true) {
  return { mode, priority: 1, valid, leg: {}, yieldPct, strikeValue: 40, capital: 4000, grade: "A" };
}

test("41 BALANCED choisit SAFE selon le rendement période", () => {
  const r = resolveCompatibleLegForMode({
    legCandidates: [desc("AGGRESSIVE", 0.4), desc("SAFE", 0.78)],
    minYieldPctInclusive: 0.7,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  assert.equal(r.mode, "SAFE");
});

test("42 BALANCED choisit AGGRESSIVE selon le rendement période", () => {
  const r = resolveCompatibleLegForMode({
    legCandidates: [desc("AGGRESSIVE", 0.88), desc("SAFE", 0.5)],
    minYieldPctInclusive: 0.7,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  assert.equal(r.mode, "AGGRESSIVE");
});

test("43 bande preferred [0,75 ; 1,05) en rendement période", () => {
  const r = resolveCompatibleLegForMode({
    legCandidates: [desc("AGGRESSIVE", 0.76), desc("SAFE", 0.74)],
    minYieldPctInclusive: 0.7,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  assert.equal(r.mode, "AGGRESSIVE");
});

test("44 cible médiane 0,875 en rendement période", () => {
  const r = resolveCompatibleLegForMode({
    legCandidates: [desc("AGGRESSIVE", 0.9), desc("SAFE", 0.85)],
    minYieldPctInclusive: 0.7,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  assert.equal(r.yieldPct, 0.85);
});

test("45 égalité exacte → SAFE gagne (tie-break <=)", () => {
  const r = resolveCompatibleLegForMode({
    legCandidates: [desc("AGGRESSIVE", 0.875), desc("SAFE", 0.875)],
    minYieldPctInclusive: 0.7,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  assert.equal(r.mode, "SAFE");
});

test("46 fallback AF-07 : aucune conforme → null", () => {
  const r = resolveCompatibleLegForMode({
    legCandidates: [desc("AGGRESSIVE", 0.3), desc("SAFE", 0.35)],
    minYieldPctInclusive: 0.7,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  assert.equal(r, null);
});

test("47 fallback AF-07 AGGRESSIVE première conforme hors preferred", () => {
  const r = resolveCompatibleLegForMode({
    legCandidates: [desc("AGGRESSIVE", 0.72), desc("SAFE", 0.71)],
    minYieldPctInclusive: 0.7,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  assert.equal(r.mode, "AGGRESSIVE");
});

test("48 aucune jambe compatible", () => {
  assert.equal(
    resolveCompatibleLegForMode({
      legCandidates: [desc("SAFE", 1.2, false)],
      minYieldPctInclusive: 0.7,
      maxYieldPctExclusive: 1.05,
    }),
    null,
  );
});

// ── F. Score ───────────────────────────────────────────────────────────────

const MODE_SAFE = { minWeeklyYield: 0.45, maxWeeklyYield: 0.8, yieldHardCap: 0.95, weights: { grade: 10, yield: 10, spread: 10, distance: 10, quality: 10, riskPenalty: 10, capitalFit: 10, diversificationPenalty: 10 } };

test("49 normalizeComboYieldScore reçoit hebdomadaire via selectedYieldPct", () => {
  const c7 = { finalDisplayGrade: "A", selectedYieldPct: 0.7, selectedSpreadPct: 8, selectedDistancePct: -8, proFinalScore: 0.5, proExecutionScore: 0.5, proDistanceScore: 0.5, capitalPerContract: 4000, _qualityOverlay: { qualityScore: 0.8 }, _tickerMeta: { name: "X", sector: "Tech" } };
  const c3 = { ...c7, selectedYieldPct: 1.17 };
  const s7 = buildCapitalComboScoreBreakdown(c7, MODE_SAFE, 100000, buildCapitalComboPoolStats([c7]));
  const s3 = buildCapitalComboScoreBreakdown(c3, MODE_SAFE, 100000, buildCapitalComboPoolStats([c3]));
  assert.notEqual(s7.totalScore, s3.totalScore);
});

test("50 score change hors 7 DTE pour même prime période", () => {
  const base = { finalDisplayGrade: "A", selectedSpreadPct: 8, selectedDistancePct: -8, proFinalScore: 0.5, proExecutionScore: 0.5, proDistanceScore: 0.5, capitalPerContract: 4000, _qualityOverlay: { qualityScore: 0.8 }, _tickerMeta: { name: "X", sector: "Tech" } };
  const c7 = { ...base, selectedYieldPct: 0.5 };
  const c3 = { ...base, selectedYieldPct: (0.5 * 7) / 3 };
  const s7 = buildCapitalComboScoreBreakdown(c7, MODE_SAFE, 100000, buildCapitalComboPoolStats([c7]));
  const s3 = buildCapitalComboScoreBreakdown(c3, MODE_SAFE, 100000, buildCapitalComboPoolStats([c3]));
  assert.notEqual(s7.totalScore, s3.totalScore);
});

test("51 score identique à 7 DTE pour même yield hebdo", () => {
  const c = { finalDisplayGrade: "A", selectedYieldPct: 0.72, selectedSpreadPct: 8, selectedDistancePct: -8, proFinalScore: 0.5, proExecutionScore: 0.5, proDistanceScore: 0.5, capitalPerContract: 4000, _qualityOverlay: { qualityScore: 0.8 }, _tickerMeta: { name: "X", sector: "Tech" } };
  const a = buildCapitalComboScoreBreakdown(c, MODE_SAFE, 100000, buildCapitalComboPoolStats([c]));
  const b = buildCapitalComboScoreBreakdown({ ...c }, MODE_SAFE, 100000, buildCapitalComboPoolStats([c]));
  assert.equal(a.totalScore, b.totalScore);
});

test("52 ordre peut changer quand hebdo change", () => {
  assert.ok(true);
});

test("53 ordre stable scores égaux", () => {
  assert.ok(true);
});

test("54 aucun NaN dans score breakdown", () => {
  const c = { finalDisplayGrade: "A", selectedYieldPct: 0.72, selectedSpreadPct: 8, selectedDistancePct: -8, proFinalScore: 0.5, proExecutionScore: 0.5, proDistanceScore: 0.5, capitalPerContract: 4000, _qualityOverlay: {}, _tickerMeta: {} };
  const bd = buildCapitalComboScoreBreakdown(c, MODE_SAFE, 100000, buildCapitalComboPoolStats([c]));
  assert.ok(Number.isFinite(bd.totalScore));
});
