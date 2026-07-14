// Politique hybride de rendement par DTE — hybrid-period-v1
// Minimum SAFE exact : 26 × 7 / 365 = 0,4986301369863014 %
// DTE ≤ 7 : facteur 1 ; DTE > 7 : bornes × DTE / 7

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  getCanonicalPeriodYieldBand,
  isPeriodYieldAdmissibleInBand,
  SAFE_BASE_PERIOD_MIN_PCT,
  SAFE_ANNUAL_SIMPLE_MIN_PCT,
  YIELD_POLICY_VERSION,
  resolveLegDte,
} from "./capitalComboPortfolio.js";

function approx(a, b, eps = 0.0001) {
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
  dteDays = 7,
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
    liquidity: { spreadPct },
    volume: 300,
    openInterest: 800,
    source: "IBKR live",
  };
}

function makeCandidate({ ticker, safe = null, agg = null, dteDays = 7 } = {}) {
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

function pickOf(combos, label, ticker) {
  return (combos.find((c) => c?.label === label)?.picks ?? []).find((p) => p.ticker === ticker) ?? null;
}

function rejectsOf(holder, label) {
  return holder?.capitalComboAllocationTraceV1?.scoredCandidatesByMode?.[label]?.rejectedBeforeAllocation ?? [];
}

function gatePeriod(periodYieldPct, mode, dteDays) {
  const band = getCanonicalPeriodYieldBand(mode, dteDays);
  return isPeriodYieldAdmissibleInBand(periodYieldPct, band);
}

// ── Minimum SAFE exact ───────────────────────────────────────────────────────

test("1 — SAFE_BASE_PERIOD_MIN_PCT = 26 × 7 / 365", () => {
  approx(SAFE_BASE_PERIOD_MIN_PCT, (26 * 7) / 365, 1e-12);
  assert.equal(SAFE_ANNUAL_SIMPLE_MIN_PCT, 26);
});

test("2 — 0,4985 % rejeté SAFE à 7 DTE", () => {
  assert.ok(!gatePeriod(0.4985, "SAFE", 7));
});

test("3 — minimum exact accepté SAFE à 7 DTE", () => {
  assert.ok(gatePeriod(SAFE_BASE_PERIOD_MIN_PCT, "SAFE", 7));
});

test("4 — 0,50 % accepté SAFE à 7 DTE", () => {
  assert.ok(gatePeriod(0.5, "SAFE", 7));
});

test("5 — 0,49 % rejeté SAFE à 7 DTE", () => {
  assert.ok(!gatePeriod(0.49, "SAFE", 7));
});

test("6 — 0,799999 % accepté SAFE à 7 DTE", () => {
  assert.ok(gatePeriod(0.799999, "SAFE", 7));
});

test("7 — 0,80 % exact rejeté SAFE (max exclusif)", () => {
  assert.ok(!gatePeriod(0.8, "SAFE", 7));
});

// ── DTE ≤ 7 ──────────────────────────────────────────────────────────────────

test("8 — DTE 3 SAFE période 0,53 % accepté, facteur 1", () => {
  const band = getCanonicalPeriodYieldBand("SAFE", 3);
  assert.equal(band.dteScaleFactor, 1);
  const pool = [makeCandidate({ ticker: "CRM", dteDays: 3, safe: makeLeg({ strike: 100, periodYieldPct: 0.53, dteDays: 3 }) })];
  assert.ok(pickOf(runBuckets(pool).combos, "SAFE", "CRM"));
});

test("9 — DTE 3 SAFE période 0,49 % rejeté", () => {
  const pool = [makeCandidate({ ticker: "CRM", dteDays: 3, safe: makeLeg({ strike: 100, periodYieldPct: 0.49, dteDays: 3 }) })];
  const { holder } = runBuckets(pool);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "CRM");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
});

test("10 — DTE 4 BALANCED période 0,70 % accepté", () => {
  const pool = [
    makeCandidate({
      ticker: "CRM",
      dteDays: 4,
      safe: makeLeg({ strike: 100, periodYieldPct: 0.7, dteDays: 4 }),
      agg: makeLeg({ strike: 100, periodYieldPct: 0.7, dteDays: 4, distancePct: -6 }),
    }),
  ];
  assert.ok(pickOf(runBuckets(pool).combos, "BALANCED", "CRM"));
});

test("11 — DTE 7 AGGRESSIVE période 0,95 % accepté", () => {
  const pool = [
    makeCandidate({
      ticker: "NVDA",
      dteDays: 7,
      agg: makeLeg({ strike: 100, periodYieldPct: 0.95, dteDays: 7, distancePct: -6 }),
    }),
  ];
  assert.ok(pickOf(runBuckets(pool).combos, "AGGRESSIVE", "NVDA"));
});

test("12 — DTE 7 facteur exactement 1", () => {
  const band = getCanonicalPeriodYieldBand("SAFE", 7);
  assert.equal(band.dteScaleFactor, 1);
});

test("13 — candidats entre 0,45 % et minimum exact rejetés SAFE", () => {
  const pool = [makeCandidate({ ticker: "CRM", dteDays: 7, safe: makeLeg({ strike: 100, periodYieldPct: 0.47, dteDays: 7 }) })];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "SAFE", "CRM"), null);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "CRM");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
});

// ── Passage 7 → 8 DTE ────────────────────────────────────────────────────────

test("14 — DTE 8 bandes effectives exactes", () => {
  const safe = getCanonicalPeriodYieldBand("SAFE", 8);
  approx(safe.effectivePeriodMinPct, (26 * 8) / 365, 1e-9);
  approx(safe.effectivePeriodMaxPct, 0.8 * (8 / 7), 1e-9);
  const agg = getCanonicalPeriodYieldBand("AGGRESSIVE", 8);
  approx(agg.effectivePeriodMinPct, 0.95 * (8 / 7), 1e-9);
});

test("15 — AGGRESSIVE 0,95 % accepté à 7 DTE, rejeté à 8 DTE", () => {
  const leg7 = makeLeg({ strike: 100, periodYieldPct: 0.95, dteDays: 7, distancePct: -6 });
  const leg8 = makeLeg({ strike: 100, periodYieldPct: 0.95, dteDays: 8, distancePct: -6 });
  assert.ok(pickOf(runBuckets([makeCandidate({ ticker: "NVDA", dteDays: 7, agg: leg7 })]).combos, "AGGRESSIVE", "NVDA"));
  const { combos, holder } = runBuckets([makeCandidate({ ticker: "NVDA", dteDays: 8, agg: leg8 })]);
  assert.equal(pickOf(combos, "AGGRESSIVE", "NVDA"), null);
  const row = rejectsOf(holder, "AGGRESSIVE").find((r) => r.ticker === "NVDA");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
});

// ── 14 DTE ───────────────────────────────────────────────────────────────────

test("16 — 14 DTE SAFE minimum et max exclusif", () => {
  const min = (26 * 14) / 365;
  assert.ok(!gatePeriod(min - 0.0001, "SAFE", 14));
  assert.ok(gatePeriod(min, "SAFE", 14));
  assert.ok(gatePeriod(1.599999, "SAFE", 14));
  assert.ok(!gatePeriod(1.6, "SAFE", 14));
});

test("17 — 14 DTE BALANCED 1,40 % accepté, 2,10 % rejeté", () => {
  assert.ok(gatePeriod(1.4, "BALANCED", 14));
  assert.ok(!gatePeriod(2.1, "BALANCED", 14));
});

test("18 — 14 DTE AGGRESSIVE 1,899 % rejeté, 1,90 % accepté", () => {
  assert.ok(!gatePeriod(1.899, "AGGRESSIVE", 14));
  assert.ok(gatePeriod(1.9, "AGGRESSIVE", 14));
});

// ── 17 DTE ───────────────────────────────────────────────────────────────────

test("19 — 17 DTE SAFE bande exacte", () => {
  const min = (26 * 17) / 365;
  const max = 0.8 * (17 / 7);
  assert.ok(!gatePeriod(min - 0.000001, "SAFE", 17));
  assert.ok(gatePeriod(min, "SAFE", 17));
  assert.ok(gatePeriod(1.942856, "SAFE", 17));
  assert.ok(!gatePeriod(max, "SAFE", 17));
});

test("20 — 17 DTE BALANCED min exact accepté, max exact rejeté", () => {
  assert.ok(gatePeriod(1.7, "BALANCED", 17));
  assert.ok(!gatePeriod(2.55, "BALANCED", 17));
});

test("21 — 17 DTE AGGRESSIVE min exact accepté, légèrement sous rejeté", () => {
  const min = 0.95 * (17 / 7);
  assert.ok(gatePeriod(min, "AGGRESSIVE", 17));
  assert.ok(!gatePeriod(min - 0.0001, "AGGRESSIVE", 17));
});

// ── Scénarios réels 17 DTE ───────────────────────────────────────────────────

test("22 — TQQQ 17 DTE 7J 1,00 % → période ~2,43 % AGGRESSIVE accepté", () => {
  const period = (1.0 * 17) / 7;
  const pool = [
    makeCandidate({
      ticker: "TQQQ",
      dteDays: 17,
      agg: makeLeg({ strike: 50, periodYieldPct: period, dteDays: 17, distancePct: -6 }),
    }),
  ];
  assert.ok(pickOf(runBuckets(pool).combos, "AGGRESSIVE", "TQQQ"));
});

test("23 — SOFI 17 DTE 7J 0,75 % → période ~1,82 % AGGRESSIVE rejeté", () => {
  const period = (0.75 * 17) / 7;
  const pool = [
    makeCandidate({
      ticker: "SOFI",
      dteDays: 17,
      agg: makeLeg({ strike: 25, periodYieldPct: period, dteDays: 17, distancePct: -6 }),
    }),
  ];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "AGGRESSIVE", "SOFI"), null);
  const row = rejectsOf(holder, "AGGRESSIVE").find((r) => r.ticker === "SOFI");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
});

test("24 — CRWV 17 DTE 7J 0,82 % → AGGRESSIVE rejeté", () => {
  const period = (0.82 * 17) / 7;
  const { holder } = runBuckets([
    makeCandidate({
      ticker: "CRWV",
      dteDays: 17,
      agg: makeLeg({ strike: 74, periodYieldPct: period, dteDays: 17, distancePct: -6 }),
    }),
  ]);
  const row = rejectsOf(holder, "AGGRESSIVE").find((r) => r.ticker === "CRWV");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
});

test("25 — CMG 17 DTE 7J 0,60 % → AGGRESSIVE rejeté", () => {
  const period = (0.6 * 17) / 7;
  const { holder } = runBuckets([
    makeCandidate({
      ticker: "CMG",
      dteDays: 17,
      agg: makeLeg({ strike: 50, periodYieldPct: period, dteDays: 17, distancePct: -6 }),
    }),
  ]);
  const row = rejectsOf(holder, "AGGRESSIVE").find((r) => r.ticker === "CMG");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
});

test("26 — NOW 17 DTE 7J 0,30 % → SAFE rejeté", () => {
  const period = (0.3 * 17) / 7;
  const { holder } = runBuckets([
    makeCandidate({
      ticker: "NOW",
      dteDays: 17,
      safe: makeLeg({ strike: 800, periodYieldPct: period, dteDays: 17 }),
    }),
  ]);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "NOW");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
});

test("27 — CRWV SAFE 17 DTE 7J 0,45 % → rejeté (nouveau min 1,21 %)", () => {
  const period = (0.45 * 17) / 7;
  const { holder } = runBuckets([
    makeCandidate({
      ticker: "CRWV",
      dteDays: 17,
      safe: makeLeg({ strike: 74, periodYieldPct: period, dteDays: 17 }),
    }),
  ]);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "CRWV");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
  approx(row?.effectivePeriodMinPct, (26 * 17) / 365, 1e-6);
});

test("28 — candidat SAFE exactement au minimum 26 % annualisé à 17 DTE", () => {
  const weekly = SAFE_BASE_PERIOD_MIN_PCT;
  const period = (26 * 17) / 365;
  const pool = [
    makeCandidate({
      ticker: "AAPL",
      dteDays: 17,
      safe: makeLeg({ strike: 100, periodYieldPct: period, dteDays: 17 }),
    }),
  ];
  const p = pickOf(runBuckets(pool).combos, "SAFE", "AAPL");
  assert.ok(p);
  approx(p.weeklyReturn, weekly, 0.01);
});

// ── DTE manquant ─────────────────────────────────────────────────────────────

test("29 — DTE absent → MISSING_OR_INVALID_DTE_FOR_YIELD_POLICY", () => {
  const pool = [
    makeCandidate({
      ticker: "AAPL",
      safe: makeLeg({ strike: 100, periodYieldPct: 0.6, dteDays: undefined }),
    }),
  ];
  delete pool[0].dteDays;
  delete pool[0].safeStrike.dteDays;
  const { holder } = runBuckets(pool);
  const row = rejectsOf(holder, "SAFE").find((r) => r.ticker === "AAPL");
  assert.equal(row?.primaryBlocker, "MISSING_OR_INVALID_DTE_FOR_YIELD_POLICY");
  assert.equal(row?.yieldPolicyVersion, YIELD_POLICY_VERSION);
});

// ── Invariants ───────────────────────────────────────────────────────────────

test("30 — rendement 7J toujours calculé", () => {
  const leg = makeLeg({ strike: 100, periodYieldPct: 0.6, dteDays: 17 });
  assert.ok(Number.isFinite(leg.weeklyNormalizedYield));
});

test("31 — politique version hybrid-period-v1", () => {
  const band = getCanonicalPeriodYieldBand("SAFE", 7);
  assert.equal(band.yieldPolicyVersion, "hybrid-period-v1");
});

test("32 — helper canonique seule source (bandes cohérentes)", () => {
  const b7 = getCanonicalPeriodYieldBand("SAFE", 7);
  const b17 = getCanonicalPeriodYieldBand("SAFE", 17);
  approx(b17.effectivePeriodMinPct, b7.basePeriodMinPct * (17 / 7), 1e-9);
});

test("33 — 30 DTE AGGRESSIVE 1,50 % rejeté (min ~4,07 %)", () => {
  const pool = [
    makeCandidate({
      ticker: "NVDA",
      dteDays: 30,
      agg: makeLeg({ strike: 100, periodYieldPct: 1.5, dteDays: 30, distancePct: -6 }),
    }),
  ];
  const { combos, holder } = runBuckets(pool);
  assert.equal(pickOf(combos, "AGGRESSIVE", "NVDA"), null);
  const row = rejectsOf(holder, "AGGRESSIVE").find((r) => r.ticker === "NVDA");
  assert.equal(row?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN");
  approx(row?.effectivePeriodMinPct, 0.95 * (30 / 7), 1e-6);
});

test("34 — resolveLegDte priorité jambe puis candidat", () => {
  const leg = { dteDays: 17 };
  const cand = { dteDays: 7 };
  assert.equal(resolveLegDte(leg, cand), 17);
});

test("35 — annualisé ne décide pas BALANCED (pas de annualizedSimpleMin sur BALANCED)", () => {
  const band = getCanonicalPeriodYieldBand("BALANCED", 7);
  assert.equal(band.annualizedSimpleMinPct, null);
});
