// Bandes de bucket Capital Combinations — rendement PÉRIODE (jusqu'à expiration).
//
// Décision fonctionnelle (2026-07-14), remplace les bandes hebdomadaires AF-17 :
//   SAFE       : periodYieldPct ∈ [0,45 ; 0,80)
//   BALANCED   : periodYieldPct ∈ [0,70 ; 1,05)
//   AGGRESSIVE : periodYieldPct >= 0,95
//
// bucketEligibilityYield = periodYieldPct (décide l'admissibilité)
// dteComparisonYield     = weeklyNormalizedYieldPct (reste calculé/affiché/persisté,
//                          ne sert plus jamais à accepter/rejeter une jambe)
//
// Codes de rejet : PERIOD_YIELD_BELOW_BUCKET_MIN / PERIOD_YIELD_ABOVE_BUCKET_MAX,
// avec periodYieldPct (décisif) ET weeklyNormalizedYieldPct (informatif) exposés.
//
// Ces tests exercent le VRAI moteur (buildPortfolioCombos), aucune bande simulée.

import test from "node:test";
import assert from "node:assert/strict";

import { buildPortfolioCombos } from "./capitalComboPortfolio.js";

function approx(a, b, eps = 0.01) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `${a} ≈ ${b}`);
}

function askFromBidAndSpreadPct(bid, spreadPct) {
  const b = Number(bid);
  const s = Number(spreadPct);
  if (!Number.isFinite(b) || b <= 0) return null;
  if (!Number.isFinite(s) || s <= 0) return b;
  return Number((b * (s + 200) / (200 - s)).toFixed(6));
}

function makeLeg({
  strike,
  periodYieldPct = null,
  bid = null,
  spreadPct = 8,
  distancePct = -9,
  popDecimal = 0.9,
  dteDays = 3,
} = {}) {
  const premium = bid != null ? bid : Number(((periodYieldPct * strike) / 100).toFixed(6));
  const period = Number(((premium / strike) * 100).toFixed(6));
  return {
    strike,
    bid: premium,
    ask: askFromBidAndSpreadPct(premium, spreadPct),
    premiumUsed: premium,
    mid: premium,
    weeklyYield: period,
    periodYield: period,
    weeklyNormalizedYield: dteDays > 0 ? Number(((period * 7) / dteDays).toFixed(6)) : period,
    dteDays,
    distancePct,
    popProfitEstimated: popDecimal,
    popEstimate: null,
    liquidity: { spreadPct },
    volume: 300,
    openInterest: 800,
    source: "IBKR live",
  };
}

function makeCandidate({ ticker, safe = null, agg = null, dteDays = 3 } = {}) {
  return {
    ticker,
    dteDays,
    safeStrike: safe,
    aggressiveStrike: agg,
    safeGrade: safe ? "A" : null,
    aggressiveGrade: agg ? "A" : null,
    finalDisplayMode: safe ? "SAFE" : "AGGRESSIVE",
    finalDisplayGrade: "A",
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 1,
  };
}

function runBuckets(pool, { capital = 100000, maxPositions = 10 } = {}) {
  const holder = {};
  const combos = buildPortfolioCombos(pool, capital, 100, maxPositions, new Set(), {
    optimizerV2: {},
    capitalComboTraceDebug: true,
    capitalComboTraceSuppressConsoleLogs: true,
    comboTracePayloadHolder: holder,
  });
  return { combos, holder };
}

function bucketOf(combos, label) {
  return (combos || []).find((c) => c?.label === label) ?? null;
}

function rejectsOf(holder, label) {
  return (
    holder?.capitalComboAllocationTraceV1?.scoredCandidatesByMode?.[label]
      ?.rejectedBeforeAllocation ?? []
  );
}

function pickOf(combos, label, ticker) {
  return (bucketOf(combos, label)?.picks ?? []).find((p) => p.ticker === ticker) ?? null;
}

// ── SAFE [0,45 ; 0,80) ──────────────────────────────────────────────────────

test("SAFE — période 0,44 % / 7J ~1,03 % → rejet PERIOD_YIELD_BELOW_BUCKET_MIN", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 0.44, dteDays: 3 }) })];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "SAFE", "CRM"), null);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "CRM");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
  approx(row.periodYieldPct, 0.44, 0.001);
  approx(row.weeklyNormalizedYieldPct, 1.0267, 0.01);
  approx(row.minPeriodYieldPct, 0.45, 0.0001);
});

test("SAFE — période 0,45 % / 7J 1,05 % → accepté (min inclusif)", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 0.45, dteDays: 3 }) })];
  const { combos } = runBuckets(pool);
  const p = pickOf(combos, "SAFE", "CRM");
  assert.ok(p, "0,45 % période >= min SAFE 0,45");
  approx(p.periodYield, 0.45, 0.001);
  approx(p.weeklyReturn, 1.05, 0.01);
});

test("SAFE — exemple réel strike 127, prime 0,67 $, DTE 3 : période ~0,53 % → accepté malgré 7J ~1,23 %", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 127, bid: 0.67, dteDays: 3 }) })];
  const { combos, holder } = runBuckets(pool);
  const p = pickOf(combos, "SAFE", "CRM");
  assert.ok(p, "la jambe strike 127 ne doit plus être rejetée par le plafond hebdomadaire");
  assert.equal(p.strike, 127);
  approx(p.periodYield, 0.5276, 0.002);
  approx(p.weeklyReturn, 1.2311, 0.01);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "CRM");
  assert.equal(row, undefined, "aucun rejet de bande SAFE pour la jambe strike 127");
});

test("SAFE — exemple réel strike 128 : période 0,66 % / 7J ~1,54 % → accepté", () => {
  const pool = [makeCandidate({ ticker: "ORCL", safe: makeLeg({ strike: 128, periodYieldPct: 0.66, dteDays: 3 }) })];
  const { combos } = runBuckets(pool);
  const p = pickOf(combos, "SAFE", "ORCL");
  assert.ok(p);
  assert.equal(p.strike, 128);
  approx(p.periodYield, 0.66, 0.002);
  approx(p.weeklyReturn, 1.54, 0.01);
});

test("SAFE — période 0,799 % → accepté (sous le max exclusif)", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 0.799, dteDays: 3 }) })];
  const { combos } = runBuckets(pool);
  assert.ok(pickOf(combos, "SAFE", "CRM"));
});

test("SAFE — période 0,80 % → rejet PERIOD_YIELD_ABOVE_BUCKET_MAX (max exclusif)", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 0.8, dteDays: 3 }) })];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "SAFE", "CRM"), null);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "CRM");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_ABOVE_BUCKET_MAX");
  approx(row.periodYieldPct, 0.8, 0.001);
  approx(row.maxPeriodYieldConfig, 0.8, 0.0001);
  assert.ok(row.weeklyNormalizedYieldPct != null, "le 7J reste exposé à titre informatif");
});

// ── BALANCED [0,70 ; 1,05) ──────────────────────────────────────────────────

test("BALANCED — période 0,69 % → rejet PERIOD_YIELD_BELOW_BUCKET_MIN", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 0.69, dteDays: 7 }) })];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "BALANCED", "CRM"), null);
  const row = rejectsOf(holder, "BALANCED").find((r) => r.ticker === "CRM");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
  approx(row.minPeriodYieldPct, 0.7, 0.0001);
});

test("BALANCED — période 0,70 % → accepté (min inclusif)", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 0.7, dteDays: 7 }) })];
  const { combos } = runBuckets(pool);
  const p = pickOf(combos, "BALANCED", "CRM");
  assert.ok(p, "0,70 % période >= min BALANCED 0,70 (aucun assouplissement V3 résiduel)");
  approx(p.periodYield, 0.7, 0.001);
});

test("BALANCED — période 0,90 % → accepté", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 0.9, dteDays: 7 }) })];
  const { combos } = runBuckets(pool);
  assert.ok(pickOf(combos, "BALANCED", "CRM"));
});

test("BALANCED — période 1,049 % → accepté", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 1.049, dteDays: 7 }) })];
  const { combos } = runBuckets(pool);
  assert.ok(pickOf(combos, "BALANCED", "CRM"));
});

test("BALANCED — période 1,05 % → rejet PERIOD_YIELD_ABOVE_BUCKET_MAX (max exclusif)", () => {
  const pool = [makeCandidate({ ticker: "CRM", safe: makeLeg({ strike: 100, periodYieldPct: 1.05, dteDays: 7 }) })];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "BALANCED", "CRM"), null);
  const row = rejectsOf(holder, "BALANCED").find((r) => r.ticker === "CRM");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_ABOVE_BUCKET_MAX");
  approx(row.maxPeriodYieldConfig, 1.05, 0.0001);
});

// ── AGGRESSIVE [0,95 ; ∞) ───────────────────────────────────────────────────

test("AGGRESSIVE — période 0,949 % → rejet PERIOD_YIELD_BELOW_BUCKET_MIN", () => {
  const pool = [
    makeCandidate({ ticker: "NVDA", agg: makeLeg({ strike: 100, periodYieldPct: 0.949, dteDays: 7, distancePct: -6 }) }),
  ];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "AGGRESSIVE", "NVDA"), null);
  const row = rejectsOf(holder, "AGGRESSIVE").find((r) => r.ticker === "NVDA");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
  approx(row.minPeriodYieldPct, 0.95, 0.0001);
});

test("AGGRESSIVE — période 0,95 % → accepté (min inclusif)", () => {
  const pool = [
    makeCandidate({ ticker: "NVDA", agg: makeLeg({ strike: 100, periodYieldPct: 0.95, dteDays: 7, distancePct: -6 }) }),
  ];
  const { combos } = runBuckets(pool);
  assert.ok(pickOf(combos, "AGGRESSIVE", "NVDA"));
});

test("AGGRESSIVE — période 1,50 % (30 DTE, 7J 0,35 %) → accepté malgré 7J sous l'ancien min hebdo", () => {
  const pool = [
    makeCandidate({
      ticker: "NVDA",
      dteDays: 30,
      agg: makeLeg({ strike: 100, periodYieldPct: 1.5, dteDays: 30, distancePct: -6 }),
    }),
  ];
  const { combos } = runBuckets(pool);
  const p = pickOf(combos, "AGGRESSIVE", "NVDA");
  assert.ok(p, "1,50 % période >= 0,95 — le 7J 0,35 % ne décide plus");
  approx(p.periodYield, 1.5, 0.005);
  approx(p.weeklyReturn, 0.35, 0.01);
});

// ── Indépendance DTE ─────────────────────────────────────────────────────────

test("Indépendance DTE — même période 0,53 %, DTE 3 (7J 1,23) et DTE 7 (7J 0,53) → même décision SAFE", () => {
  const pool = [
    // Jambe documentée du scan courant : strike 127, prime 0,67 $, DTE 3.
    makeCandidate({ ticker: "CRM", dteDays: 3, safe: makeLeg({ strike: 127, bid: 0.67, dteDays: 3 }) }),
    makeCandidate({ ticker: "AAPL", dteDays: 7, safe: makeLeg({ strike: 100, periodYieldPct: 0.5276, dteDays: 7 }) }),
  ];
  const { combos, holder } = runBuckets(pool);
  const p3 = pickOf(combos, "SAFE", "CRM");
  const p7 = pickOf(combos, "SAFE", "AAPL");
  assert.ok(p3, "DTE 3 admissible SAFE par la période");
  assert.ok(p7, "DTE 7 admissible SAFE par la période");
  approx(p3.periodYield, p7.periodYield, 0.005);
  assert.ok(Math.abs(p3.weeklyReturn - p7.weeklyReturn) > 0.5, "les 7J diffèrent, la décision est identique");
  assert.equal(
    rejectsOf(holder, "SAFE").filter((r) => ["CRM", "AAPL"].includes(r.ticker)).length,
    0,
    "aucun rejet de bande pour les deux DTE",
  );
});
