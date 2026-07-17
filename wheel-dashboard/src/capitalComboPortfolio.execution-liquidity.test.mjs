import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BALANCED_LEG_SOURCES,
  CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE,
  buildPortfolioCombos,
  getCandidateExecutionScore,
  getLegExecutionBreakdown,
  resolveBalancedLegSelection,
  resolveLegExecutionLiquidity,
} from "./capitalComboPortfolio.js";
import {
  resolveBalancedCardViewModel,
  resolveDashboardModePresentation,
} from "./balancedModeUi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SOURCE = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");
const PORTFOLIO_SOURCE = fs.readFileSync(
  path.join(__dirname, "capitalComboPortfolio.js"),
  "utf8",
);

function approx(actual, expected, epsilon = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `attendu ${expected}, reçu ${actual}, écart ${Math.abs(actual - expected)}`,
  );
}

function extractIbkrStrikeMapper() {
  const start = DASHBOARD_SOURCE.indexOf("function ibkrStrikeToDashboardStrike(");
  const nextFunction = DASHBOARD_SOURCE.indexOf("function buildIbkrDataProvenance", start);
  const end = DASHBOARD_SOURCE.lastIndexOf("\n}", nextFunction);
  assert.ok(start >= 0 && end > start, "fonction ibkrStrikeToDashboardStrike introuvable");
  const functionSource = DASHBOARD_SOURCE.slice(start, end + 2);
  return new Function(
    "resolveLegExecutionLiquidity",
    "strikeDistancePct",
    `${functionSource}\nreturn ibkrStrikeToDashboardStrike;`,
  )(
    resolveLegExecutionLiquidity,
    (strike, spot) => ((Number(strike) - Number(spot)) / Number(spot)) * 100,
  );
}

const ibkrStrikeToDashboardStrike = extractIbkrStrikeMapper();

function executionLeg({ spreadPct = 12.9, volume, openInterest, extra = {} } = {}) {
  return {
    strike: 100,
    premiumUsed: 1,
    weeklyYield: 1,
    periodYield: 1,
    dteDays: 7,
    distancePct: -8,
    popProfitEstimated: 0.9,
    liquidity: { spreadPct },
    volume,
    openInterest,
    source: "IBKR live",
    ...extra,
  };
}

function askForSpread(bid, spreadPct) {
  return bid * ((spreadPct + 200) / (200 - spreadPct));
}

function balancedLeg(strike, periodYieldPct, {
  ticker = "AAPL",
  spreadPct = 8,
  volume = 300,
  openInterest = 800,
} = {}) {
  const bid = (strike * periodYieldPct) / 100;
  const ask = askForSpread(bid, spreadPct);
  return {
    ticker,
    symbol: ticker,
    expiration: "2026-07-24",
    right: "PUT",
    optionType: "PUT",
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    premiumUsed: bid,
    weeklyYield: periodYieldPct,
    periodYield: periodYieldPct,
    dteDays: 8,
    distancePct: -8,
    popProfitEstimated: 0.9,
    volume,
    openInterest,
    liquidity: { spreadPct },
    source: "IBKR live",
    quoteSource: "IBKR",
  };
}

function balancedCandidate({
  safe = balancedLeg(85, 1.15, { volume: 111, openInterest: 222 }),
  aggressive = balancedLeg(110, 3.82, { volume: 333, openInterest: 444 }),
  chain = [],
} = {}) {
  return {
    ticker: "AAPL",
    symbol: "AAPL",
    targetExpiration: "2026-07-24",
    dteDays: 8,
    price: 120,
    safeStrike: safe,
    aggressiveStrike: aggressive,
    safeGrade: "A",
    aggressiveGrade: "A",
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: "A",
    balancedPutChainAvailable: true,
    balancedPutCandidates: chain,
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
  };
}

function aggressiveBoundaryCandidate(ticker, targetExecutionScore) {
  const spreadPct = 50 * (1 - 2 * targetExecutionScore);
  return {
    ticker,
    dteDays: 7,
    aggressiveStrike: {
      strike: 50,
      bid: 0.5,
      premiumUsed: 0.5,
      weeklyYield: 1,
      periodYield: 1,
      weeklyNormalizedYield: 1,
      dteDays: 7,
      distancePct: -6,
      popProfitEstimated: 0.9,
      liquidity: { spreadPct },
      volume: 0,
      openInterest: 0,
      source: "IBKR live",
    },
    aggressiveGrade: "A",
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: "A",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
  };
}

function aggressivePick(candidate) {
  const combos = buildPortfolioCombos([candidate], 100_000, 100, 10, new Set(), {
    optimizerV2: {},
  });
  return combos.find((combo) => combo.label === "AGGRESSIVE")?.picks?.[0] ?? null;
}

test("mapping IBKR conserve volume/OI au niveau jambe et liquidity", () => {
  const mapped = ibkrStrikeToDashboardStrike(
    {
      strike: 100,
      bid: 1,
      ask: 1.1378,
      mid: 1.0689,
      spread: 0.1378,
      spreadPct: 0.129,
      volume: 200,
      openInterest: 500,
    },
    110,
    "agressif IBKR live",
  );
  assert.equal(mapped.volume, 200);
  assert.equal(mapped.openInterest, 500);
  assert.equal(mapped.liquidity.volume, 200);
  assert.equal(mapped.liquidity.openInterest, 500);
  assert.equal(mapped.liquidity.source, "IBKR live");
  assert.equal(mapped.raw.volume, 200);
  assert.equal(mapped.raw.openInterest, 500);
});

test("score complet 12,9/200/500 reste 0,871 avec la formule 50/30/20", () => {
  const bd = getLegExecutionBreakdown(executionLeg({ volume: 200, openInterest: 500 }));
  approx(bd.spreadScore, 0.742);
  approx(bd.volumeScore, 1);
  approx(bd.openInterestScore, 1);
  approx(bd.executionScore, 0.871);
  assert.equal(bd.executionDataComplete, true);
  assert.equal(bd.formula, "spreadScore*0.5 + volumeScore*0.3 + openInterestScore*0.2");
});

test("score partiel connu 12,9/100/250 reste 0,621", () => {
  const bd = getLegExecutionBreakdown(executionLeg({ volume: 100, openInterest: 250 }));
  approx(bd.volumeScore, 0.5);
  approx(bd.openInterestScore, 0.5);
  approx(bd.executionScore, 0.621);
});

test("zéro réel reste connu et contribue zéro", () => {
  const bd = getLegExecutionBreakdown(executionLeg({ volume: 0, openInterest: 0 }));
  assert.equal(bd.volume, 0);
  assert.equal(bd.openInterest, 0);
  assert.equal(bd.volumeKnown, true);
  assert.equal(bd.openInterestKnown, true);
  assert.equal(bd.executionDataComplete, true);
  assert.equal(bd.volumeScore, 0);
  assert.equal(bd.openInterestScore, 0);
});

test("absence volume/OI reste null, inconnue et conservative", () => {
  const bd = getLegExecutionBreakdown(executionLeg());
  assert.equal(bd.volume, null);
  assert.equal(bd.openInterest, null);
  assert.equal(bd.volumeKnown, false);
  assert.equal(bd.openInterestKnown, false);
  assert.equal(bd.executionDataComplete, false);
  assert.equal(bd.volumeScore, 0);
  assert.equal(bd.openInterestScore, 0);
});

test("liquidity imbriquée est lue sans écraser zéro", () => {
  const leg = executionLeg({
    extra: { liquidity: { spreadPct: 12.9, volume: 0, openInterest: 250 } },
  });
  const resolved = resolveLegExecutionLiquidity(leg);
  assert.deepEqual(
    {
      volume: resolved.volume,
      openInterest: resolved.openInterest,
      volumeKnown: resolved.volumeKnown,
      openInterestKnown: resolved.openInterestKnown,
      volumeSource: resolved.volumeSource,
      openInterestSource: resolved.openInterestSource,
    },
    {
      volume: 0,
      openInterest: 250,
      volumeKnown: true,
      openInterestKnown: true,
      volumeSource: "leg.liquidity.volume",
      openInterestSource: "leg.liquidity.openInterest",
    },
  );
});

test("raw de la même jambe est le dernier fallback vérifié", () => {
  const bd = getLegExecutionBreakdown(
    executionLeg({ extra: { raw: { volume: 75, openInterest: 125 } } }),
  );
  assert.equal(bd.volume, 75);
  assert.equal(bd.openInterest, 125);
  assert.equal(bd.volumeSource, "leg.raw.volume");
  assert.equal(bd.openInterestSource, "leg.raw.openInterest");
});

test("priorité jambe > liquidity > raw, zéro direct compris", () => {
  const resolved = resolveLegExecutionLiquidity({
    volume: 0,
    openInterest: 10,
    liquidity: { volume: 200, openInterest: 300 },
    raw: { volume: 400, openInterest: 500 },
  });
  assert.equal(resolved.volume, 0);
  assert.equal(resolved.openInterest, 10);
  assert.equal(resolved.volumeSource, "leg.volume");
  assert.equal(resolved.openInterestSource, "leg.openInterest");
});

test("SAFE et AGRESSIF utilisent leurs propres liquidités", () => {
  const safe = executionLeg({ spreadPct: 8, volume: 20, openInterest: 40 });
  const aggressive = executionLeg({ spreadPct: 12, volume: 180, openInterest: 450 });
  const candidate = { safeStrike: safe, aggressiveStrike: aggressive };
  const safeScore = getCandidateExecutionScore(candidate, safe);
  const aggressiveScore = getCandidateExecutionScore(candidate, aggressive);
  assert.equal(safeScore, getLegExecutionBreakdown(safe).executionScore);
  assert.equal(aggressiveScore, getLegExecutionBreakdown(aggressive).executionScore);
  assert.notEqual(safeScore, aggressiveScore);
});

test("BALANCED natif utilise volume/OI du strike intermédiaire exact", () => {
  const nativeLeg = balancedLeg(97.5, 1.4, { volume: 654, openInterest: 987 });
  const candidate = balancedCandidate({ chain: [nativeLeg] });
  const result = resolveBalancedLegSelection({ candidate });
  const bd = getLegExecutionBreakdown(result.selectedLeg);
  const vm = resolveBalancedCardViewModel({ candidate });
  const presentation = resolveDashboardModePresentation(
    { ...candidate, balancedCardViewModel: vm, balancedLegSource: vm.source },
    { modeFilter: "BALANCED" },
  );
  assert.equal(result.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(result.selectedStrike, 97.5);
  assert.equal(bd.volume, 654);
  assert.equal(bd.openInterest, 987);
  assert.equal(vm.volume, 654);
  assert.equal(vm.openInterest, 987);
  assert.equal(presentation.leg.volume, 654);
  assert.equal(presentation.leg.liquidity.openInterest, 987);
});

test("BALANCED fallback SAFE conserve exclusivement la liquidité SAFE", () => {
  const candidate = balancedCandidate();
  const result = resolveBalancedLegSelection({ candidate });
  const bd = getLegExecutionBreakdown(result.selectedLeg);
  assert.equal(result.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  assert.equal(result.selectedLeg, candidate.safeStrike);
  assert.equal(bd.volume, 111);
  assert.equal(bd.openInterest, 222);
});

test("BALANCED fallback AGRESSIF conserve exclusivement la liquidité AGRESSIVE", () => {
  const safe = balancedLeg(85, 1.15, { spreadPct: 30, volume: 111, openInterest: 222 });
  const aggressive = balancedLeg(110, 3.82, { volume: 333, openInterest: 444 });
  const candidate = balancedCandidate({ safe, aggressive });
  const result = resolveBalancedLegSelection({ candidate });
  const bd = getLegExecutionBreakdown(result.selectedLeg);
  assert.equal(result.source, BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE);
  assert.equal(result.selectedLeg, candidate.aggressiveStrike);
  assert.equal(bd.volume, 333);
  assert.equal(bd.openInterest, 444);
});

test("frontière AGRESSIVE : 0,399999 rejeté, 0,400000 et 0,400001 acceptés", () => {
  assert.equal(CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE, 0.4);
  for (const [ticker, target, accepted] of [
    ["AAPL", 0.399999, false],
    ["MSFT", 0.4, true],
    ["NVDA", 0.400001, true],
  ]) {
    const candidate = aggressiveBoundaryCandidate(ticker, target);
    const score = getLegExecutionBreakdown(candidate.aggressiveStrike).executionScore;
    approx(score, target, 1e-12);
    assert.equal(score >= CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE, accepted);
    assert.equal(aggressivePick(candidate) != null, accepted);
  }
});

test("bid/ask mathématique à 10 % documente la valeur IEEE sans epsilon", () => {
  const bid = 1;
  const ask = askForSpread(bid, 10);
  const bd = getLegExecutionBreakdown({ bid, ask, volume: 0, openInterest: 0 });
  const ieeeSpreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
  const ieeeExecutionScore = Math.max(0, 1 - ieeeSpreadPct / 50) * 0.5;
  assert.equal(bd.spreadPct, ieeeSpreadPct);
  assert.equal(bd.executionScore, ieeeExecutionScore);
  assert.equal(bd.executionScore >= 0.4, ieeeExecutionScore >= 0.4);
});

test("diagnostic distingue n/d de zéro et affiche quatre décimales", () => {
  assert.match(
    DASHBOARD_SOURCE,
    /executionScore.*toFixed\(4\).*minimum AGGRESSIVE.*toFixed\(4\)/,
  );
  assert.match(DASHBOARD_SOURCE, /volumeKnown \? diag\.executionBreakdown\.volume : "n\/d"/);
  assert.match(
    DASHBOARD_SOURCE,
    /openInterestKnown \? diag\.executionBreakdown\.openInterest : "n\/d"/,
  );
  assert.match(DASHBOARD_SOURCE, /Données d’exécution complètes/);
  assert.match(DASHBOARD_SOURCE, /Source liquidité/);
});

test("seuils et plafonds restent inchangés", () => {
  assert.match(
    PORTFOLIO_SOURCE,
    /minExecutionScore: CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE,\s*maxSpreadPct: 25/,
  );
  assert.match(PORTFOLIO_SOURCE, /minExecutionScore: 0,\s*maxSpreadPct: 20/);
  assert.match(PORTFOLIO_SOURCE, /minExecutionScore: 0,\s*maxSpreadPct: 15/);
  assert.match(PORTFOLIO_SOURCE, /executionScoreForFilter >= modeAlloc\.minExecutionScore/);
});
