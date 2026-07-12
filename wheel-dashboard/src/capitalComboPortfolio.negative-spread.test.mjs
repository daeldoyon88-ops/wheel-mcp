// AF-11 — Spread négatif et marché croisé : rejet strict sans casser Pool Research hors marché.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  buildCapitalComboCandidate,
  resolveLegSpreadPctPercent,
  resolveLegSpreadDiagnostics,
  SPREAD_PCT_REJECTION,
  gradeLeg,
  toSpreadPctPercent,
  compareCapitalComboCandidatesStable,
} from "./capitalComboPortfolio.js";
import { computeScoreV2 } from "./scoreV2.js";
import {
  attemptSafeSpreadRescue,
  isSpreadAcceptable,
} from "../../app/calculations/safeSpreadRescue.js";

const SAFE_MODE = {
  maxSpreadPct: 15,
  weights: {
    grade: 24,
    yield: 10,
    spread: 18,
    distance: 20,
    quality: 14,
    riskPenalty: 10,
    capitalFit: 10,
    diversificationPenalty: 6,
  },
  distanceTargetAbs: 8,
  minWeeklyYield: 0.45,
};

const KNOWN_TICKER = "AAPL";

function spreadNorm(spreadPct, max = 15) {
  const value = Number(spreadPct);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, Math.min(1, (max - value) / max));
}

function makeLeg({
  strike = 50,
  bid = 0.25,
  ask = undefined,
  spreadPct = undefined,
  yieldPct = 0.6,
  distancePct = -9,
  popDecimal = 0.9,
  quoteStatus = undefined,
  liquiditySpread = undefined,
  omitBidAsk = false,
} = {}) {
  const resolvedAsk =
    ask !== undefined
      ? ask
      : bid != null
        ? Number((bid * 1.05).toFixed(4))
        : null;
  const leg = {
    strike,
    premiumUsed: bid,
    mid: bid,
    weeklyYield: yieldPct,
    distancePct,
    popProfitEstimated: popDecimal,
    volume: 300,
    openInterest: 800,
    source: "IBKR live",
  };
  if (!omitBidAsk) {
    leg.bid = bid;
    leg.ask = resolvedAsk;
  }
  if (quoteStatus) leg.quoteStatus = quoteStatus;
  if (liquiditySpread !== undefined) {
    leg.liquidity = { spreadPct: liquiditySpread };
  } else if (spreadPct !== undefined) {
    leg.liquidity = { spreadPct };
  }
  return leg;
}

function makeCandidate({
  ticker = KNOWN_TICKER,
  safe = null,
  agg = null,
  safeGrade = "A",
  aggressiveGrade = "A",
  finalDisplayMode = "SAFE",
  finalDisplayGrade = "A",
} = {}) {
  return {
    ticker,
    name: ticker,
    safeStrike: safe,
    aggressiveStrike: agg,
    safeGrade,
    aggressiveGrade,
    finalDisplayMode,
    finalDisplayGrade,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    proFinalScore: 0.7,
    proExecutionScore: 0.8,
    proDistanceScore: 0.9,
  };
}

function pickSafe(pool, capital = 100000) {
  const combos = buildPortfolioCombos(pool, capital, 100, 10, new Set(), {});
  return combos.find((c) => c.label === "SAFE")?.picks?.[0] ?? null;
}

// ── TEST 1-3 — spreads négatifs fournis ─────────────────────────────────────

for (const [label, spread] of [
  ["TEST 1 — spread -22 %", -22],
  ["TEST 2 — spread -1 %", -1],
  ["TEST 3 — spread -0,0001 %", -0.0001],
]) {
  test(label, () => {
    const leg = makeLeg({ spreadPct: spread, omitBidAsk: true, bid: 0.25 });
    const built = buildCapitalComboCandidate(
      makeCandidate({ ticker: "AAPL", safe: leg }),
      100000,
    );
    assert.equal(built._hasSafeLegValid, false);
    assert.equal(gradeLeg({ spreadPct: spread, weeklyYieldPct: 0.6, popDecimal: 0.9 }), "REJECT");
    assert.equal(spreadNorm(spread), 0);
    assert.equal(pickSafe([makeCandidate({ ticker: "AAPL", safe: leg })]), null);
  });
}

// ── TEST 4-7 — spreads valides et limites ───────────────────────────────────

test("TEST 4 — spread 0 % valide, score spread maximal", () => {
  const leg = makeLeg({ bid: 0.5, ask: 0.5, spreadPct: 0 });
  assert.equal(resolveLegSpreadPctPercent(leg), 0);
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  assert.equal(built._hasSafeLegValid, true);
  assert.equal(spreadNorm(built._safeSpreadPct), 1);
});

test("TEST 5 — spread 5 % comportement inchangé", () => {
  const leg = makeLeg({ spreadPct: 5, omitBidAsk: true, bid: 0.25 });
  assert.equal(resolveLegSpreadPctPercent(leg), 5);
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  assert.equal(built._hasSafeLegValid, true);
  const norm = spreadNorm(built._safeSpreadPct);
  assert.ok(norm > 0.6 && norm < 1);
});

test("TEST 6 — spread max exact 15 % valide", () => {
  const leg = makeLeg({ spreadPct: 15, omitBidAsk: true, bid: 0.25 });
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  assert.equal(built._hasSafeLegValid, true);
  assert.equal(spreadNorm(15), 0);
});

test("TEST 7 — juste au-dessus du max 15,01 % rejeté", () => {
  const leg = makeLeg({ spreadPct: 15.01, omitBidAsk: true, bid: 0.25 });
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  assert.equal(built._hasSafeLegValid, true);
  assert.equal(pickSafe([makeCandidate({ ticker: "MSFT", safe: leg })]), null);
});

// ── TEST 8-11 — valeurs non finies ──────────────────────────────────────────

for (const [label, value] of [
  ["TEST 8 — null", null],
  ["TEST 9 — undefined", undefined],
  ["TEST 10 — NaN", NaN],
  ["TEST 11 — Infinity", Infinity],
]) {
  test(label, () => {
    const leg = makeLeg({ omitBidAsk: true, bid: 0.25 });
    if (value === undefined) {
      delete leg.liquidity;
    } else {
      leg.liquidity = { spreadPct: value };
    }
    const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
    assert.equal(built._hasSafeLegValid, false);
  });
}

// ── TEST 12-17 — bid/ask source de vérité ───────────────────────────────────

test("TEST 12 — bid < ask : spread recalculé positif", () => {
  const leg = makeLeg({ bid: 1.0, ask: 1.1 });
  const spread = resolveLegSpreadPctPercent(leg);
  assert.ok(spread > 0 && spread < 10);
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  assert.equal(built._hasSafeLegValid, true);
});

test("TEST 13 — bid = ask : spread 0 valide", () => {
  const leg = makeLeg({ bid: 0.8, ask: 0.8, spreadPct: 5 });
  assert.equal(resolveLegSpreadPctPercent(leg), 0);
  assert.equal(buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000)._hasSafeLegValid, true);
});

test("TEST 14 — bid > ask avec spread négatif fourni : CROSSED_MARKET", () => {
  const leg = makeLeg({ bid: 1.2, ask: 0.9, spreadPct: -22 });
  const diag = resolveLegSpreadDiagnostics(leg);
  assert.equal(diag.spreadPct, null);
  assert.equal(diag.rejectionReason, SPREAD_PCT_REJECTION.CROSSED_MARKET);
});

test("TEST 15 — bid > ask mais spreadPct positif fourni : rejet quand même", () => {
  const leg = makeLeg({ bid: 1.2, ask: 0.9, spreadPct: 5 });
  const diag = resolveLegSpreadDiagnostics(leg);
  assert.equal(diag.spreadPct, null);
  assert.equal(diag.rejectionReason, SPREAD_PCT_REJECTION.CROSSED_MARKET);
  assert.equal(buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000)._hasSafeLegValid, false);
});

test("TEST 16 — bid < ask mais spreadPct négatif fourni : recalcul depuis bid/ask", () => {
  const leg = makeLeg({ bid: 0.9, ask: 1.0, spreadPct: -5 });
  const spread = resolveLegSpreadPctPercent(leg);
  assert.ok(spread > 0);
  assert.equal(buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000)._hasSafeLegValid, true);
});

test("TEST 17 — spread négatif sans bid/ask : NEGATIVE_SPREAD_PCT", () => {
  const leg = {
    strike: 50,
    premiumUsed: 0.25,
    weeklyYield: 0.6,
    liquidity: { spreadPct: -3 },
  };
  const diag = resolveLegSpreadDiagnostics(leg);
  assert.equal(diag.spreadPct, null);
  assert.equal(diag.rejectionReason, SPREAD_PCT_REJECTION.NEGATIVE_SPREAD_PCT);
});

// ── TEST 18-19 — duels CLEAN vs CROSSED ─────────────────────────────────────

test("TEST 18 — duel CLEAN 5 % vs CROSSED -22 % : CLEAN gagne", () => {
  const clean = makeCandidate({
    ticker: "AAPL",
    safe: makeLeg({ spreadPct: 5, omitBidAsk: true, strike: 180, bid: 0.9 }),
  });
  const crossed = makeCandidate({
    ticker: "MSFT",
    safe: makeLeg({ strike: 400, bid: 1.2, ask: 0.9, spreadPct: -22 }),
  });
  const combos = buildPortfolioCombos([crossed, clean], 100000, 100, 10, new Set(), {});
  const safe = combos.find((c) => c.label === "SAFE");
  const tickers = (safe?.picks ?? []).map((p) => p.ticker);
  assert.ok(tickers.includes("AAPL"));
  assert.ok(!tickers.includes("MSFT"));
});

test("TEST 19 — duel CLEAN 0 % vs CROSSED -0,01 % : CLEAN gagne", () => {
  const clean = makeCandidate({
    ticker: "AAPL",
    safe: makeLeg({ strike: 175, bid: 0.8, ask: 0.8, spreadPct: 0 }),
  });
  const crossed = makeCandidate({
    ticker: "MSFT",
    safe: makeLeg({ strike: 390, bid: 0.31, ask: 0.30, spreadPct: -0.01 }),
  });
  const combos = buildPortfolioCombos([crossed, clean], 100000, 100, 10, new Set(), {});
  const safe = combos.find((c) => c.label === "SAFE");
  const tickers = (safe?.picks ?? []).map((p) => p.ticker);
  assert.ok(tickers.includes("AAPL"));
  assert.ok(!tickers.includes("MSFT"));
});

// ── TEST 20 — grade : aucun négatif A/B ─────────────────────────────────────

test("TEST 20 — grade : spread négatif jamais A/B", () => {
  for (const spread of [-22, -1, -0.0001]) {
    const g = gradeLeg({ spreadPct: spread, weeklyYieldPct: 0.7, popDecimal: 0.9 });
    assert.notEqual(g, "A");
    assert.notEqual(g, "B");
  }
});

// ── TEST 21-24 — modes SAFE / BALANCED / AGGRESSIVE ─────────────────────────

test("TEST 21 — BALANCED AF-07 : SAFE propre, AGG crossed exclue", () => {
  const c = makeCandidate({
    ticker: "BAL21",
    safe: makeLeg({ strike: 45, spreadPct: 8, yieldPct: 0.85 }),
    agg: makeLeg({ strike: 48, bid: 1.0, ask: 0.8, spreadPct: -10, yieldPct: 0.95, distancePct: -4 }),
    finalDisplayMode: "AGGRESSIVE",
  });
  const combos = buildPortfolioCombos([c], 100000, 100, 10, new Set(), {});
  const bal = combos.find((x) => x.label === "BALANCED");
  const pick = bal?.picks?.[0];
  assert.ok(!pick || pick.strike === 45);
});

test("TEST 22 — BALANCED seule jambe crossed en bande : aucun pick crossed", () => {
  const c = makeCandidate({
    ticker: "BAL22",
    agg: makeLeg({ strike: 46, bid: 1.1, ask: 0.9, spreadPct: -5, yieldPct: 0.85, distancePct: -5 }),
    finalDisplayMode: "AGGRESSIVE",
  });
  const combos = buildPortfolioCombos([c], 100000, 100, 10, new Set(), {});
  const bal = combos.find((x) => x.label === "BALANCED");
  assert.equal((bal?.picks ?? []).length, 0);
});

test("TEST 23 — AGGRESSIVE : spread négatif exclu", () => {
  const c = makeCandidate({
    ticker: "AGG23",
    agg: makeLeg({ strike: 47, bid: 1.2, ask: 0.9, spreadPct: -8, yieldPct: 1.0, distancePct: -6 }),
    finalDisplayMode: "AGGRESSIVE",
  });
  const combos = buildPortfolioCombos([c], 100000, 100, 10, new Set(), {});
  const agg = combos.find((x) => x.label === "AGGRESSIVE");
  assert.equal((agg?.picks ?? []).length, 0);
});

test("TEST 24 — SAFE : spread négatif exclu", () => {
  const c = makeCandidate({
    ticker: "SAFE24",
    safe: makeLeg({ strike: 48, bid: 1.2, ask: 0.9, spreadPct: -22 }),
  });
  assert.equal(pickSafe([c]), null);
});

// ── TEST 25-26 — rescue ─────────────────────────────────────────────────────

test("TEST 25 — rescue : strike propre préféré au crossed", () => {
  const original = {
    strike: 38,
    bid: 0.27,
    ask: 0.67,
    spreadPct: 85,
    primeUsed: 0.27,
    premiumUsed: 0.27,
    isBelowLowerBound: true,
  };
  const cleanNeighbor = {
    strike: 37.5,
    bid: 0.24,
    ask: 0.35,
    spreadPct: 8,
    primeUsed: 0.24,
    premiumUsed: 0.24,
    isBelowLowerBound: true,
  };
  const crossedNeighbor = {
    strike: 37,
    bid: 0.3,
    ask: 0.25,
    spreadPct: -15,
    primeUsed: 0.25,
    premiumUsed: 0.25,
    isBelowLowerBound: true,
  };
  const { safeStrike } = attemptSafeSpreadRescue({
    safeStrike: original,
    aggressiveStrike: { strike: 39 },
    putCandidates: [original, cleanNeighbor, crossedNeighbor],
    lowerBound: 39.2,
    targetPremium: 0.19,
    spot: 41,
    allStrikes: [39, 38.5, 38, 37.5, 37],
  });
  assert.equal(safeStrike.strike, 37.5);
  assert.equal(isSpreadAcceptable(-15), false);
});

test("TEST 26 — ordre inversé : AF-05 préservée, même portefeuille", () => {
  const a = makeCandidate({ ticker: "AAA", safe: makeLeg({ strike: 40, spreadPct: 6 }) });
  const b = makeCandidate({ ticker: "BBB", safe: makeLeg({ strike: 41, spreadPct: 6 }) });
  const c1 = buildPortfolioCombos([a, b], 100000, 100, 10, new Set(), {});
  const c2 = buildPortfolioCombos([b, a], 100000, 100, 10, new Set(), {});
  const strip = (combos) =>
    JSON.stringify(
      combos
        .find((x) => x.label === "SAFE")
        ?.picks?.map((p) => ({ ticker: p.ticker, strike: p.strike })) ?? [],
    );
  assert.equal(strip(c1), strip(c2));
  assert.equal(compareCapitalComboCandidatesStable(a, b), compareCapitalComboCandidatesStable(a, b));
});

// ── TEST 27 — score V2 ──────────────────────────────────────────────────────

test("TEST 27 — score V2 : spread négatif = 0 point + warning", () => {
  const item = {
    finalDisplayMode: "SAFE",
    safeStrike: makeLeg({ bid: 1.2, ask: 0.9, spreadPct: -10 }),
  };
  const result = computeScoreV2(item);
  const spreadBlock = result.breakdown.find((b) => b.key === "spread");
  assert.equal(spreadBlock.pts, 0);
  assert.ok(result.alerts.some((a) => /négatif|croisé/i.test(a)));
});

// ── TEST 28 — unités IBKR ───────────────────────────────────────────────────

test("TEST 28 — fraction IBKR 0.05 → 5 %, pas 500 % ni 0.05 %", () => {
  const leg = {
    source: "IBKR live",
    spreadPct: 0.05,
    raw: { spreadPct: 0.05 },
  };
  assert.equal(toSpreadPctPercent(0.05, { source: "ibkr_raw_fraction" }), 5);
  assert.equal(resolveLegSpreadPctPercent(leg), 5);
  assert.notEqual(resolveLegSpreadPctPercent(leg), 500);
  assert.notEqual(resolveLegSpreadPctPercent(leg), 0.05);
});

// ── TEST 29-30 — frozen/delayed hors marché ─────────────────────────────────

test("TEST 29 — quote frozen/delayed cohérente hors marché : admissible", () => {
  const leg = {
    strike: 180,
    bid: 0.4,
    ask: 0.42,
    premiumUsed: 0.4,
    weeklyYield: 0.6,
    distancePct: -9,
    popProfitEstimated: 0.9,
    liquidity: { spreadPct: 4.9 },
    quoteStatus: "frozen",
    marketDataType: "delayed",
    volume: 100,
    openInterest: 200,
  };
  const built = buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000);
  assert.equal(built._hasSafeLegValid, true);
  const spread = resolveLegSpreadPctPercent(leg);
  assert.ok(Number.isFinite(spread) && spread >= 0);
});

test("TEST 30 — quote frozen/delayed crossed : rejet bid>ask, pas statut", () => {
  const leg = makeLeg({
    bid: 0.5,
    ask: 0.45,
    spreadPct: -8,
    quoteStatus: "frozen",
  });
  const diag = resolveLegSpreadDiagnostics(leg);
  assert.equal(diag.rejectionReason, SPREAD_PCT_REJECTION.CROSSED_MARKET);
  assert.equal(buildCapitalComboCandidate(makeCandidate({ safe: leg }), 100000)._hasSafeLegValid, false);
});

// ── TEST 31-32 — immutabilité et déterminisme ───────────────────────────────

test("TEST 31 — aucune mutation du pool (deep-freeze)", () => {
  const pool = [
    makeCandidate({ ticker: "MUT", safe: makeLeg({ strike: 50, spreadPct: 6 }) }),
  ];
  const snapshot = JSON.stringify(pool);
  buildPortfolioCombos(pool, 100000, 100, 10, new Set(), {});
  assert.equal(JSON.stringify(pool), snapshot);
});

test("TEST 32 — 20 exécutions identiques", () => {
  const pool = [
    makeCandidate({ ticker: "DET", safe: makeLeg({ strike: 51, spreadPct: 5 }) }),
    makeCandidate({ ticker: "DET2", safe: makeLeg({ strike: 52, spreadPct: 6 }) }),
  ];
  const results = Array.from({ length: 20 }, () =>
    JSON.stringify(
      buildPortfolioCombos(pool, 100000, 100, 10, new Set(), {}).find((c) => c.label === "SAFE")?.picks,
    ),
  );
  assert.ok(results.every((r) => r === results[0]));
});
