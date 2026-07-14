// AF-07 — Tests : fallback BALANCED conforme.
//
// Le bucket BALANCED doit évaluer TOUTES les jambes disponibles (SAFE,
// AGGRESSIVE, et plus tard la vraie jambe BALANCED) au lieu de s'arrêter à la
// première jambe essayée : une jambe hors bande de rendement n'empêche plus
// d'essayer la suivante ; aucune jambe hors bande n'est forcée.
//
// Ces tests exercent le VRAI code de production :
// - buildPortfolioCombos + resolveCompatibleLegForMode (capitalComboPortfolio.js) ;
// - buildComboCandidatePool / buildVisibleTableRows (capitalComboInputPool.js, AF-06).
//
// Aucune bande financière n'est codée en dur ici : les bornes effectives
// min/max du bucket BALANCED sont EXTRAITES des diagnostics de rejet du moteur
// réel (PERIOD_YIELD_BELOW_BUCKET_MIN.minPeriodYieldPct et
// PERIOD_YIELD_ABOVE_BUCKET_MAX.maxPeriodYieldConfig), et la bande
// préférée vient de la constante exportée BALANCED_PREFERRED_LEG_YIELD_BAND.
//
// Depuis le 2026-07-14, les bandes s'appliquent au rendement PÉRIODE (jusqu'à
// expiration) — anciens codes MIN_WEEKLY_YIELD_NOT_MET /
// MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT remplacés. Les fixtures de ce fichier
// n'ont pas de DTE (legacy période = 7J) : les décisions restent identiques.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  resolveCompatibleLegForMode,
  resolveLegSpreadPctPercent,
  BALANCED_PREFERRED_LEG_YIELD_BAND,
} from "./capitalComboPortfolio.js";
import {
  buildComboCandidatePool,
  buildVisibleTableRows,
} from "./capitalComboInputPool.js";

// ── Fixtures (style harnais fable : jambes au format dashboard) ──────────────

function askFromBidAndSpreadPct(bid, spreadPct) {
  const b = Number(bid);
  const s = Number(spreadPct);
  if (!Number.isFinite(b) || b <= 0 || !Number.isFinite(s) || s < 0) {
    return b > 0 ? Number((b * 1.05).toFixed(4)) : null;
  }
  if (s === 0) return b;
  return Number((b * (s + 200) / (200 - s)).toFixed(4));
}

function makeLeg({
  strike,
  spreadPct = 8,
  yieldPct,
  distancePct = -9,
  popDecimal = 0.9,
  bid = undefined,
  volume = 300,
  openInterest = 800,
} = {}) {
  const premium =
    bid !== undefined
      ? bid
      : Number.isFinite(Number(yieldPct)) && Number.isFinite(Number(strike))
        ? Number(((yieldPct * strike) / 100).toFixed(4))
        : null;
  return {
    strike,
    bid: premium,
    ask: premium != null ? askFromBidAndSpreadPct(premium, spreadPct) : null,
    premiumUsed: premium,
    mid: premium,
    weeklyYield: yieldPct,
    distancePct,
    popProfitEstimated: popDecimal,
    popEstimate: null,
    liquidity: { spreadPct },
    volume,
    openInterest,
    source: "IBKR live",
  };
}

function makeCandidate({
  ticker,
  safe = null,
  agg = null,
  safeGrade,
  aggressiveGrade,
  finalDisplayMode = "AGGRESSIVE",
  finalDisplayGrade = "A",
  proFinalScore = 0.5,
  proExecutionScore = 0.8,
  proDistanceScore = 1,
  name,
} = {}) {
  const c = {
    ticker,
    safeStrike: safe,
    aggressiveStrike: agg,
    weeklyReturn: safe?.weeklyYield ?? agg?.weeklyYield ?? 0,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore,
    proExecutionScore,
    proDistanceScore,
  };
  if (name !== undefined) c.name = name;
  if (safeGrade !== undefined) c.safeGrade = safeGrade;
  if (aggressiveGrade !== undefined) c.aggressiveGrade = aggressiveGrade;
  if (finalDisplayMode !== undefined) c.finalDisplayMode = finalDisplayMode;
  if (finalDisplayGrade !== undefined) c.finalDisplayGrade = finalDisplayGrade;
  return c;
}

function runCombos(pool, { capital = 100000, maxPositions = 10 } = {}) {
  const holder = {};
  const combos = buildPortfolioCombos(pool, capital, 100, maxPositions, new Set(), {
    optimizerV2: {},
    capitalComboTraceDebug: true,
    capitalComboTraceSuppressConsoleLogs: true,
    comboTracePayloadHolder: holder,
  });
  return { combos, holder };
}

function comboByLabel(combos, label) {
  return (combos || []).find((c) => c?.label === label) ?? null;
}

function balancedRejections(holder) {
  return (
    holder?.capitalComboAllocationTraceV1?.scoredCandidatesByMode?.BALANCED
      ?.rejectedBeforeAllocation ?? []
  );
}

function runBalanced(pool, opts) {
  const { combos, holder } = runCombos(pool, opts);
  return { bal: comboByLabel(combos, "BALANCED"), holder, combos };
}

function stripCombo(combo) {
  if (!combo) return null;
  return {
    label: combo.label,
    positions: combo.positions,
    totalCapital: combo.totalCapital,
    freeCapital: combo.freeCapital,
    totalPremiumCollected: combo.totalPremiumCollected,
    picks: (combo.picks || []).map((p) => ({
      ticker: p.ticker,
      mode: p.mode,
      grade: p.grade,
      strike: p.strike,
      premiumUnit: p.premiumUnit,
      contracts: p.contracts,
      capitalUsed: p.capitalUsed,
      premiumCollected: p.premiumCollected,
      weeklyReturn: p.weeklyReturn,
      spreadPct: p.spreadPct,
      distancePct: p.distancePct,
      popEstimate: p.popEstimate,
      selectionScore: p.selectionScore,
    })),
  };
}

function deepFreeze(obj, seen = new Set()) {
  if (obj === null || typeof obj !== "object" || seen.has(obj)) return obj;
  seen.add(obj);
  for (const k of Object.keys(obj)) deepFreeze(obj[k], seen);
  return Object.freeze(obj);
}

// ── Extraction des bornes RÉELLES de la bande effective BALANCED ─────────────
// Deux sondes volontairement hors bande (0,5 % très bas / 5 % très haut) font
// émettre au moteur ses propres bornes dans les diagnostics de rejet.
function extractBalancedYieldBand() {
  const lowProbe = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.5, distancePct: -12, popDecimal: 0.94 }),
    safeGrade: "A",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
  });
  const highProbe = makeCandidate({
    ticker: "ORCL",
    agg: makeLeg({ strike: 43, yieldPct: 5.0, distancePct: -6, popDecimal: 0.88 }),
    aggressiveGrade: "A",
  });
  const { holder } = runCombos([lowProbe, highProbe]);
  const rows = balancedRejections(holder);
  const minRow = rows.find((r) => r.primaryBlocker === "PERIOD_YIELD_BELOW_BUCKET_MIN");
  const maxRow = rows.find((r) => r.primaryBlocker === "PERIOD_YIELD_ABOVE_BUCKET_MAX");
  assert.ok(minRow, "sonde basse : le moteur doit exposer minPeriodYieldPct");
  assert.ok(maxRow, "sonde haute : le moteur doit exposer maxPeriodYieldConfig");
  const min = Number(minRow.minPeriodYieldPct);
  const max = Number(maxRow.maxPeriodYieldConfig);
  assert.ok(Number.isFinite(min) && Number.isFinite(max) && min < max);
  return { min, max };
}

const BAND = extractBalancedYieldBand();
const PREF = BALANCED_PREFERRED_LEG_YIELD_BAND;
const EPS = 0.001;
// Rendement conforme à la bande effective mais SOUS la bande préférée
// (la zone où l'ancien fallback aveugle perdait le candidat).
const Y_IN_BAND_BELOW_PREF = (BAND.min + PREF.minInclusivePct) / 2;
const Y_MID = PREF.midTargetPct;
const Y_TOO_LOW = BAND.min - 0.1;
const Y_TOO_HIGH = BAND.max + 0.95;

assert.ok(
  PREF.minInclusivePct >= BAND.min && PREF.maxExclusivePct <= BAND.max,
  "la bande préférée doit être incluse dans la bande effective",
);

// Descripteurs pour les tests directs du helper (jambe fictive inerte).
function desc({ mode, yieldPct, valid = true, priority = 1, leg = {} }) {
  return { mode, priority, valid, leg, yieldPct, strikeValue: 40, capital: 4000, grade: "A" };
}

// Candidat AF-07 canonique : SAFE conforme sous bande préférée, AGG hors bande.
function makeAf07Candidate(overrides = {}) {
  return makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, spreadPct: 8, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9, popDecimal: 0.91 }),
    agg: makeLeg({ strike: 43, spreadPct: 10, yieldPct: Y_TOO_HIGH, distancePct: -3, popDecimal: 0.8 }),
    safeGrade: "A",
    aggressiveGrade: "A",
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test("TEST 1 — reproduction AF-07 : SAFE conforme + AGGRESSIVE trop élevée ⇒ SAFE sélectionnée pour le bucket BALANCED", () => {
  const { bal, holder } = runBalanced([makeAf07Candidate()]);
  const pick = bal?.picks?.[0] ?? null;
  assert.ok(pick, "le candidat ne doit plus être rejeté");
  assert.equal(pick.ticker, "CRM");
  assert.equal(pick.strike, 40, "strike de la jambe SAFE");
  assert.equal(pick.weeklyReturn, Y_IN_BAND_BELOW_PREF, "rendement de la jambe SAFE");
  assert.equal(balancedRejections(holder).length, 0, "aucun rejet de bande résiduel");
});

test("TEST 2 — inverse : SAFE trop faible + AGGRESSIVE conforme ⇒ AGGRESSIVE sélectionnée", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: Y_TOO_LOW, distancePct: -12, popDecimal: 0.94 }),
    agg: makeLeg({ strike: 43, yieldPct: Y_MID, distancePct: -6, popDecimal: 0.88 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  const { bal } = runBalanced([cand]);
  const pick = bal?.picks?.[0] ?? null;
  assert.ok(pick);
  assert.equal(pick.strike, 43, "strike de la jambe AGGRESSIVE");
  assert.equal(pick.weeklyReturn, Y_MID);
});

test("TEST 3 — deux jambes conformes : préférence historique conservée (MID, égalité → SAFE, sous-bande → AGGRESSIVE)", () => {
  // (a) bande préférée : la jambe la plus proche du MID gagne (ici AGGRESSIVE).
  const closerAgg = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: PREF.minInclusivePct + 0.05, distancePct: -9 }),
    agg: makeLeg({ strike: 43, yieldPct: Y_MID, distancePct: -6 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  assert.equal(runBalanced([closerAgg]).bal?.picks?.[0]?.strike, 43);

  // (b) égalité exacte de distance au MID → règle « <= » historique : SAFE gagne.
  const tie = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: Y_MID - 0.025, distancePct: -9 }),
    agg: makeLeg({ strike: 43, yieldPct: Y_MID + 0.025, distancePct: -6 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  assert.equal(runBalanced([tie]).bal?.picks?.[0]?.strike, 40);

  // (c) deux conformes SOUS la bande préférée → ordre de fallback historique : AGGRESSIVE.
  const bothBelowPref = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9 }),
    agg: makeLeg({ strike: 43, yieldPct: Y_IN_BAND_BELOW_PREF + 0.01, distancePct: -6 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  assert.equal(runBalanced([bothBelowPref]).bal?.picks?.[0]?.strike, 43);
});

test("TEST 4 — aucune jambe conforme ⇒ candidat BALANCED rejeté, aucune jambe forcée", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: Y_TOO_LOW, distancePct: -12, popDecimal: 0.94 }),
    agg: makeLeg({ strike: 43, yieldPct: Y_TOO_HIGH, distancePct: -3, popDecimal: 0.8 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  const { bal, holder } = runBalanced([cand]);
  assert.equal(bal?.picks?.length ?? 0, 0);
  // Chemin de rejet existant conservé : le dernier recours (AGG) est rejeté par la bande.
  const rows = balancedRejections(holder);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].primaryBlocker, "PERIOD_YIELD_ABOVE_BUCKET_MAX");
  // Et le helper lui-même retourne null (aucune jambe hors bande n'est « conforme »).
  assert.equal(
    resolveCompatibleLegForMode({
      legCandidates: [
        desc({ mode: "AGGRESSIVE", yieldPct: Y_TOO_HIGH }),
        desc({ mode: "SAFE", yieldPct: Y_TOO_LOW }),
      ],
      minYieldPctInclusive: BAND.min,
      maxYieldPctExclusive: BAND.max,
      preferredBand: PREF,
    }),
    null,
  );
});

test("TEST 5 — SAFE absente + AGGRESSIVE conforme ⇒ AGGRESSIVE sélectionnée", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    agg: makeLeg({ strike: 43, yieldPct: Y_MID, distancePct: -6, popDecimal: 0.88 }),
    aggressiveGrade: "A",
  });
  assert.equal(runBalanced([cand]).bal?.picks?.[0]?.strike, 43);
});

test("TEST 6 — AGGRESSIVE absente + SAFE conforme ⇒ SAFE sélectionnée", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9, popDecimal: 0.91 }),
    safeGrade: "A",
    finalDisplayMode: "SAFE",
  });
  assert.equal(runBalanced([cand]).bal?.picks?.[0]?.strike, 40);
});

test("TEST 7 — aucune jambe disponible ⇒ rejet propre, sans exception", () => {
  const cand = makeCandidate({ ticker: "CRM", finalDisplayMode: "SAFE", finalDisplayGrade: "B" });
  const { bal } = runBalanced([cand]);
  assert.equal(bal?.picks?.length ?? 0, 0);
});

test("TEST 8 — rendement SAFE inconnu ⇒ SAFE ignorée, AGGRESSIVE sélectionnée", () => {
  // Niveau helper : null / undefined / NaN sont tous non conformes, la suivante est essayée.
  for (const unknown of [null, undefined, Number.NaN]) {
    const picked = resolveCompatibleLegForMode({
      legCandidates: [
        desc({ mode: "AGGRESSIVE", yieldPct: Y_MID }),
        desc({ mode: "SAFE", yieldPct: unknown }),
      ],
      minYieldPctInclusive: BAND.min,
      maxYieldPctExclusive: BAND.max,
      preferredBand: PREF,
    });
    assert.equal(picked?.mode, "AGGRESSIVE");
  }
  // Niveau moteur : une jambe SAFE sans rendement exploitable (ni prime) est invalide et ignorée.
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: null, bid: null, distancePct: -9 }),
    agg: makeLeg({ strike: 43, yieldPct: Y_MID, distancePct: -6, popDecimal: 0.88 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  assert.equal(runBalanced([cand]).bal?.picks?.[0]?.strike, 43);
});

test("TEST 9 — rendement AGGRESSIVE inconnu ⇒ AGGRESSIVE ignorée, SAFE sélectionnée", () => {
  for (const unknown of [null, undefined, Number.NaN]) {
    const picked = resolveCompatibleLegForMode({
      legCandidates: [
        desc({ mode: "AGGRESSIVE", yieldPct: unknown }),
        desc({ mode: "SAFE", yieldPct: Y_IN_BAND_BELOW_PREF }),
      ],
      minYieldPctInclusive: BAND.min,
      maxYieldPctExclusive: BAND.max,
      preferredBand: PREF,
    });
    assert.equal(picked?.mode, "SAFE");
  }
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9, popDecimal: 0.91 }),
    agg: makeLeg({ strike: 43, yieldPct: null, bid: null, distancePct: -6 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  assert.equal(runBalanced([cand]).bal?.picks?.[0]?.strike, 40);
});

test("TEST 10 — borne minimum exacte : min inclusif (jambe acceptée)", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: BAND.min, distancePct: -9, popDecimal: 0.91 }),
    safeGrade: "A",
    finalDisplayMode: "SAFE",
  });
  const pick = runBalanced([cand]).bal?.picks?.[0] ?? null;
  assert.ok(pick, "rendement == min ⇒ conforme (convention >= min du moteur)");
  assert.equal(pick.weeklyReturn, BAND.min);
});

test("TEST 11 — borne maximum exacte : max exclusif (jambe rejetée)", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: BAND.max, distancePct: -9, popDecimal: 0.91 }),
    safeGrade: "A",
    finalDisplayMode: "SAFE",
  });
  const { bal, holder } = runBalanced([cand]);
  assert.equal(bal?.picks?.length ?? 0, 0, "rendement == max ⇒ non conforme (convention < max du moteur)");
  const rows = balancedRejections(holder);
  assert.equal(rows[0]?.primaryBlocker, "PERIOD_YIELD_ABOVE_BUCKET_MAX");
});

test("TEST 12 — min − epsilon : jambe rejetée puis jambe suivante essayée", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: BAND.min - EPS, distancePct: -9, popDecimal: 0.91 }),
    agg: makeLeg({ strike: 43, yieldPct: Y_MID, distancePct: -6, popDecimal: 0.88 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  const pick = runBalanced([cand]).bal?.picks?.[0] ?? null;
  assert.equal(pick?.strike, 43, "SAFE sous min ignorée, AGGRESSIVE conforme sélectionnée");
});

test("TEST 13 — max + epsilon : jambe rejetée puis jambe suivante essayée", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9, popDecimal: 0.91 }),
    agg: makeLeg({ strike: 43, yieldPct: BAND.max + EPS, distancePct: -6, popDecimal: 0.88 }),
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  const pick = runBalanced([cand]).bal?.picks?.[0] ?? null;
  assert.equal(pick?.strike, 40, "AGGRESSIVE au-dessus du max ignorée, SAFE conforme sélectionnée");
});

test("TEST 14 — données du pick entièrement issues de la jambe SAFE (aucune fuite AGGRESSIVE)", () => {
  const safeLeg = makeLeg({ strike: 40, spreadPct: 9, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9.5, popDecimal: 0.91 });
  const aggLeg = makeLeg({ strike: 43, spreadPct: 12, yieldPct: Y_TOO_HIGH, distancePct: -3.2, popDecimal: 0.8 });
  const cand = makeCandidate({ ticker: "CRM", safe: safeLeg, agg: aggLeg, safeGrade: "A", aggressiveGrade: "B" });
  const pick = runBalanced([cand]).bal?.picks?.[0] ?? null;
  assert.ok(pick);
  assert.equal(pick.strike, safeLeg.strike);
  assert.equal(pick.premiumUnit, safeLeg.bid);
  assert.equal(pick.weeklyReturn, safeLeg.weeklyYield);
  assert.equal(pick.spreadPct, resolveLegSpreadPctPercent(safeLeg));
  assert.equal(pick.distancePct, safeLeg.distancePct);
  assert.equal(pick.popEstimate, safeLeg.popProfitEstimated * 100);
  assert.equal(pick.grade, "A", "grade explicite de la jambe SAFE");
  assert.equal(pick.capitalRequired, safeLeg.strike * 100);
  assert.equal(pick.capitalUsed, pick.contracts * safeLeg.strike * 100);
  for (const [field, aggValue] of [
    ["strike", aggLeg.strike],
    ["premiumUnit", aggLeg.bid],
    ["weeklyReturn", aggLeg.weeklyYield],
    ["spreadPct", resolveLegSpreadPctPercent(aggLeg)],
    ["distancePct", aggLeg.distancePct],
  ]) {
    assert.notEqual(pick[field], aggValue, `${field} ne doit pas venir de la jambe AGGRESSIVE`);
  }
});

test("TEST 15 — données du pick entièrement issues de la jambe AGGRESSIVE (aucune fuite SAFE)", () => {
  // Règle moteur existante pour la jambe AGGRESSIVE : grade DÉRIVÉ de la jambe
  // (priorityGrade ?? gradeLeg ?? stocké). Spread 10 + POP 88 + yield conforme ⇒ dérivé "A",
  // distinct du grade SAFE "B" : une fuite SAFE afficherait "B".
  const safeLeg = makeLeg({ strike: 40, spreadPct: 9, yieldPct: Y_TOO_LOW, distancePct: -12.5, popDecimal: 0.94 });
  const aggLeg = makeLeg({ strike: 43, spreadPct: 9, yieldPct: Y_MID, distancePct: -6.2, popDecimal: 0.88 });
  const cand = makeCandidate({ ticker: "CRM", safe: safeLeg, agg: aggLeg, safeGrade: "B", aggressiveGrade: "A" });
  const pick = runBalanced([cand]).bal?.picks?.[0] ?? null;
  assert.ok(pick);
  assert.equal(pick.strike, aggLeg.strike);
  assert.equal(pick.premiumUnit, aggLeg.bid);
  assert.equal(pick.weeklyReturn, aggLeg.weeklyYield);
  assert.equal(pick.spreadPct, resolveLegSpreadPctPercent(aggLeg));
  assert.equal(pick.distancePct, aggLeg.distancePct);
  assert.equal(pick.popEstimate, aggLeg.popProfitEstimated * 100);
  assert.equal(pick.grade, "A", "grade dérivé des données de la jambe AGGRESSIVE (spread 9, POP 88)");
  assert.equal(pick.capitalUsed, pick.contracts * aggLeg.strike * 100);
  for (const [field, safeValue] of [
    ["strike", safeLeg.strike],
    ["premiumUnit", safeLeg.bid],
    ["weeklyReturn", safeLeg.weeklyYield],
    ["spreadPct", resolveLegSpreadPctPercent(safeLeg)],
    ["distancePct", safeLeg.distancePct],
  ]) {
    assert.notEqual(pick[field], safeValue, `${field} ne doit pas venir de la jambe SAFE`);
  }
});

test("TEST 16 — AF-03 préservée : le grade source ne change ni le grade ni le score du pick BALANCED", () => {
  // safeGrade absent ⇒ grade dérivé de la jambe (spread 12, yield conforme, POP 82 ⇒ B).
  const mk = (sourceGrade) =>
    makeCandidate({
      ticker: "CRM",
      safe: makeLeg({ strike: 40, spreadPct: 12, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9, popDecimal: 0.82 }),
      agg: makeLeg({ strike: 43, spreadPct: 10, yieldPct: Y_TOO_HIGH, distancePct: -3, popDecimal: 0.8 }),
      safeGrade: null,
      aggressiveGrade: null,
      finalDisplayGrade: sourceGrade,
    });
  const picks = ["A", "B", "WATCH"].map((g) => runBalanced([mk(g)]).bal?.picks?.[0] ?? null);
  for (const pick of picks) {
    assert.ok(pick);
    assert.equal(pick.grade, "B", "grade dérivé de la jambe SAFE sélectionnée");
    assert.equal(pick.strike, 40);
  }
  assert.equal(picks[0].selectionScore, picks[1].selectionScore);
  assert.equal(picks[1].selectionScore, picks[2].selectionScore);
});

test("TEST 17 — AF-02 préservée : POP null reste inconnue (pas coercée à 0) sur la jambe sélectionnée", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, spreadPct: 8, yieldPct: Y_MID, distancePct: -9, popDecimal: null }),
    safeGrade: null,
    finalDisplayMode: "SAFE",
  });
  const pick = runBalanced([cand]).bal?.picks?.[0] ?? null;
  assert.ok(pick, "POP inconnue n'exclut pas la jambe (grade dérivé A : spread ≤ 10, yield ≥ 0,5)");
  assert.equal(pick.popEstimate, null);
  assert.equal(pick.grade, "A");
});

test("TEST 18 — POP réelle zéro : comportement existant préservé (grade dérivé WATCH ⇒ exclusion)", () => {
  const cand = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, spreadPct: 8, yieldPct: Y_MID, distancePct: -9, popDecimal: 0 }),
    safeGrade: null,
    finalDisplayMode: "SAFE",
  });
  const { bal } = runBalanced([cand]);
  assert.equal(bal?.picks?.length ?? 0, 0);
});

test("TEST 19 — spreads différents : le choix de jambe reste piloté par la bande, pas par le spread", () => {
  const mk = (safeSpread, aggSpread) =>
    makeCandidate({
      ticker: "CRM",
      safe: makeLeg({ strike: 40, spreadPct: safeSpread, yieldPct: PREF.minInclusivePct + 0.05, distancePct: -9 }),
      agg: makeLeg({ strike: 43, spreadPct: aggSpread, yieldPct: Y_MID, distancePct: -6 }),
      safeGrade: "A",
      aggressiveGrade: "A",
    });
  // AGG plus proche du MID gagne, quel que soit le côté du meilleur spread.
  assert.equal(runBalanced([mk(8, 15)]).bal?.picks?.[0]?.strike, 43);
  assert.equal(runBalanced([mk(15, 8)]).bal?.picks?.[0]?.strike, 43);
});

test("TEST 20 — distances différentes : préférence de jambe inchangée", () => {
  const mk = (safeDist, aggDist) =>
    makeCandidate({
      ticker: "CRM",
      safe: makeLeg({ strike: 40, yieldPct: PREF.minInclusivePct + 0.05, distancePct: safeDist }),
      agg: makeLeg({ strike: 43, yieldPct: Y_MID, distancePct: aggDist }),
      safeGrade: "A",
      aggressiveGrade: "A",
    });
  assert.equal(runBalanced([mk(-12, -6)]).bal?.picks?.[0]?.strike, 43);
  assert.equal(runBalanced([mk(-6, -12)]).bal?.picks?.[0]?.strike, 43);
});

test("TEST 21 — scores différents : la jambe sélectionnée ne dépend pas du score qualité du candidat", () => {
  const mk = (proFinalScore) => makeAf07Candidate({ proFinalScore });
  const low = runBalanced([mk(0.2)]).bal?.picks?.[0] ?? null;
  const high = runBalanced([mk(0.9)]).bal?.picks?.[0] ?? null;
  assert.equal(low?.strike, 40);
  assert.equal(high?.strike, 40);
  assert.equal(low?.premiumUnit, high?.premiumUnit);
  assert.equal(low?.weeklyReturn, high?.weeklyReturn);
});

test("TEST 22 — AF-05 préservée : ordre d'entrée inversé ⇒ portefeuille BALANCED identique", () => {
  const pool = [
    makeAf07Candidate({ ticker: "CRM" }),
    makeCandidate({
      ticker: "ORCL",
      safe: makeLeg({ strike: 45, yieldPct: Y_MID, distancePct: -8, popDecimal: 0.9 }),
      safeGrade: "A",
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "AAPL",
      agg: makeLeg({ strike: 50, yieldPct: PREF.maxExclusivePct - 0.05, distancePct: -6, popDecimal: 0.88 }),
      aggressiveGrade: "A",
    }),
  ];
  const a = stripCombo(runBalanced(pool).bal);
  const b = stripCombo(runBalanced([...pool].reverse()).bal);
  assert.ok((a?.picks?.length ?? 0) >= 2, "plusieurs picks attendus");
  assert.deepEqual(a, b);
});

test("TEST 23 — AF-06 préservée : le moteur consomme le pool canonique, pas les lignes visibles filtrées", () => {
  const enriched = [
    makeAf07Candidate({ ticker: "CRM", name: "Salesforce" }),
    makeCandidate({
      ticker: "ORCL",
      name: "Oracle",
      safe: makeLeg({ strike: 45, yieldPct: Y_MID, distancePct: -8, popDecimal: 0.9 }),
      safeGrade: "A",
      finalDisplayMode: "SAFE",
    }),
  ];
  const pool = buildComboCandidatePool(enriched, { selectedExpiration: null });
  const visible = buildVisibleTableRows(pool, { query: "oracle" });
  assert.equal(visible.length, 1, "la recherche UI ne garde qu'ORCL dans le tableau visible");

  const { bal } = runBalanced(pool);
  const tickers = (bal?.picks ?? []).map((p) => p.ticker);
  assert.ok(tickers.includes("CRM"), "CRM reste dans le portefeuille malgré la recherche UI");
  assert.ok(tickers.includes("ORCL"));

  // Le tri/la recherche des lignes visibles ne changent pas le pool canonique.
  const poolAgain = buildComboCandidatePool(enriched, { selectedExpiration: null });
  assert.deepEqual(stripCombo(runBalanced(poolAgain).bal), stripCombo(bal));
});

test("TEST 24 — aucune mutation : candidats et jambes deep-freezés, exécution sans exception", () => {
  const pool = [makeAf07Candidate()];
  const snapshot = JSON.stringify(pool);
  deepFreeze(pool);
  const { bal } = runBalanced(pool);
  assert.equal(bal?.picks?.[0]?.strike, 40);
  assert.equal(JSON.stringify(pool), snapshot, "entrées intactes");

  // Le helper non plus ne modifie rien.
  const frozenDescs = deepFreeze([
    desc({ mode: "AGGRESSIVE", yieldPct: Y_TOO_HIGH }),
    desc({ mode: "SAFE", yieldPct: Y_IN_BAND_BELOW_PREF }),
  ]);
  const picked = resolveCompatibleLegForMode({
    legCandidates: frozenDescs,
    minYieldPctInclusive: BAND.min,
    maxYieldPctExclusive: BAND.max,
    preferredBand: PREF,
  });
  assert.equal(picked?.mode, "SAFE");
});

test("TEST 25 — répétition : 20 exécutions ⇒ même jambe, même score, même portefeuille", () => {
  const mkPool = () => [
    makeAf07Candidate({ ticker: "CRM" }),
    makeCandidate({
      ticker: "ORCL",
      safe: makeLeg({ strike: 45, yieldPct: Y_MID, distancePct: -8, popDecimal: 0.9 }),
      safeGrade: "A",
      finalDisplayMode: "SAFE",
    }),
  ];
  const reference = JSON.stringify(stripCombo(runBalanced(mkPool()).bal));
  for (let i = 0; i < 20; i++) {
    assert.equal(JSON.stringify(stripCombo(runBalanced(mkPool()).bal)), reference, `exécution ${i + 1}`);
  }
});

test("TEST 26 — compatibilité future : une jambe BALANCED fictive conforme (priority 0) gagne devant les fallbacks", () => {
  const balancedDesc = desc({ mode: "BALANCED", yieldPct: Y_IN_BAND_BELOW_PREF, priority: 0 });
  const picked = resolveCompatibleLegForMode({
    legCandidates: [
      balancedDesc,
      desc({ mode: "AGGRESSIVE", yieldPct: Y_MID }),
      desc({ mode: "SAFE", yieldPct: Y_MID - 0.05 }),
    ],
    minYieldPctInclusive: BAND.min,
    maxYieldPctExclusive: BAND.max,
    preferredBand: PREF,
  });
  assert.equal(picked, balancedDesc, "la vraie jambe BALANCED conforme gagne même hors bande préférée");
  // Aucune jambe balancedLeg n'est ajoutée au moteur réel.
  const cand = makeAf07Candidate();
  assert.equal(cand.balancedLeg, undefined);
});

test("TEST 27 — compatibilité future : BALANCED fictive hors bande ⇒ la logique continue et sélectionne SAFE conforme", () => {
  const picked = resolveCompatibleLegForMode({
    legCandidates: [
      desc({ mode: "BALANCED", yieldPct: BAND.max + 1, priority: 0 }),
      desc({ mode: "AGGRESSIVE", yieldPct: Y_TOO_HIGH }),
      desc({ mode: "SAFE", yieldPct: Y_IN_BAND_BELOW_PREF }),
    ],
    minYieldPctInclusive: BAND.min,
    maxYieldPctExclusive: BAND.max,
    preferredBand: PREF,
  });
  assert.equal(picked?.mode, "SAFE");
});

test("TEST 28 — bucket SAFE strictement inchangé (la jambe AGGRESSIVE hors bande n'y joue aucun rôle)", () => {
  const safeLeg = makeLeg({ strike: 40, spreadPct: 12, yieldPct: 0.6, distancePct: -9, popDecimal: 0.9 });
  const withAgg = makeCandidate({
    ticker: "CRM",
    safe: safeLeg,
    agg: makeLeg({ strike: 43, yieldPct: Y_TOO_HIGH, distancePct: -3, popDecimal: 0.8 }),
    safeGrade: "B",
    aggressiveGrade: "A",
  });
  const withoutAgg = makeCandidate({
    ticker: "CRM",
    safe: safeLeg,
    safeGrade: "B",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "B",
  });
  const a = stripCombo(comboByLabel(runCombos([withAgg]).combos, "SAFE"));
  const b = stripCombo(comboByLabel(runCombos([withoutAgg]).combos, "SAFE"));
  assert.ok(a?.picks?.length === 1);
  assert.equal(a.picks[0].strike, safeLeg.strike);
  // Champ mode = mode source (AF-01, hors périmètre) : on ne compare que les données de jambe.
  const dropMode = (combo) => ({ ...combo, picks: combo.picks.map(({ mode, ...rest }) => rest) });
  assert.deepEqual(dropMode(a), dropMode(b));
});

test("TEST 29 — bucket AGGRESSIVE strictement inchangé (la jambe SAFE n'y joue aucun rôle)", () => {
  const aggLeg = makeLeg({ strike: 43, spreadPct: 8, yieldPct: 1.2, distancePct: -6, popDecimal: 0.88 });
  const withSafe = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.6, distancePct: -9, popDecimal: 0.9 }),
    agg: aggLeg,
    safeGrade: "B",
    aggressiveGrade: "A",
  });
  const withoutSafe = makeCandidate({ ticker: "CRM", agg: aggLeg, aggressiveGrade: "A" });
  const a = stripCombo(comboByLabel(runCombos([withSafe]).combos, "AGGRESSIVE"));
  const b = stripCombo(comboByLabel(runCombos([withoutSafe]).combos, "AGGRESSIVE"));
  assert.ok(a?.picks?.length === 1);
  assert.equal(a.picks[0].strike, aggLeg.strike);
  assert.deepEqual(a, b);
});

test("TEST 30 — empreinte financière BALANCED : tous les champs cohérents avec la seule jambe sélectionnée", () => {
  const safeLeg = makeLeg({ strike: 40, spreadPct: 9, yieldPct: Y_IN_BAND_BELOW_PREF, distancePct: -9.5, popDecimal: 0.91 });
  const cand = makeAf07Candidate({ safe: safeLeg });
  const { bal } = runBalanced([cand]);
  const pick = bal?.picks?.[0] ?? null;
  assert.ok(pick);
  assert.equal(bal.label, "BALANCED", "mode bucket");
  // Jambe source SAFE : pick.mode reflète encore le mode du candidat source
  // (AF-01, documenté hors périmètre) — les données financières, elles, sont 100 % SAFE.
  assert.equal(pick.ticker, "CRM");
  assert.equal(pick.strike, safeLeg.strike);
  assert.ok(Number.isInteger(pick.contracts) && pick.contracts >= 1);
  assert.equal(pick.capitalUsed, pick.contracts * safeLeg.strike * 100);
  assert.equal(pick.premiumUnit, safeLeg.bid);
  // Le moteur n'arrondit pas premiumCollected (produit flottant brut) : tolérance 1e-9.
  assert.ok(Math.abs(pick.premiumCollected - pick.contracts * safeLeg.bid * 100) < 1e-9);
  assert.equal(pick.weeklyReturn, safeLeg.weeklyYield);
  assert.equal(pick.spreadPct, resolveLegSpreadPctPercent(safeLeg));
  assert.equal(pick.distancePct, safeLeg.distancePct);
  assert.equal(pick.popEstimate, safeLeg.popProfitEstimated * 100);
  assert.equal(pick.grade, "A");
  assert.ok(Number.isFinite(pick.selectionScore) && pick.selectionScore > 0);
});
