import assert from "node:assert/strict";
import test from "node:test";

import {
  BALANCED_LEG_SOURCES,
  BALANCED_NATIVE_REASON_CODES,
  MODE_GRADE_RANK,
  buildPortfolioCombos,
  getFinalDisplayRecommendation,
  resolveBalancedLegSelection,
} from "./capitalComboPortfolio.js";
import { selectPrincipalThreeLeg, selectPrincipalThreeLegFromRow } from "./threeLegSelection.js";

const EXPIRATION = "2026-07-31";

function askForSpread(bid, spreadPct) {
  return (bid * (spreadPct + 200)) / (200 - spreadPct);
}

function makeLeg(strike, periodYieldPct, {
  spreadPct = 8,
  pop = 0.9,
  distancePct = -8,
  ticker = "TQQQ",
  dteDays = 3,
  withBook = false,
  bid = null,
  ask = null,
} = {}) {
  const leg = {
    ticker,
    symbol: ticker,
    expiration: EXPIRATION,
    right: "PUT",
    optionType: "PUT",
    strike,
    dteDays,
    distancePct,
    weeklyYield: periodYieldPct,
    popProfitEstimated: pop,
    volume: 500,
    openInterest: 1000,
    optionSymbol: `${ticker}-${strike}-P`,
    conId: Math.round(Number(strike) * 100),
    contractId: Math.round(Number(strike) * 1000),
    quoteTimestamp: "2026-07-14T15:00:00Z",
    marketDataType: "live",
    quoteSource: "IBKR",
    liquidity: { spreadPct },
    spreadPct,
  };
  if (withBook) {
    const bookBid = bid ?? (strike * periodYieldPct) / 100;
    leg.bid = bookBid;
    leg.ask = ask ?? askForSpread(bookBid, spreadPct);
    leg.mid = (leg.bid + leg.ask) / 2;
    leg.premiumUsed = bookBid;
  }
  return leg;
}

function makeCandidate({
  ticker = "TQQQ",
  price = 110,
  safeStrike = 90,
  aggressiveStrike = 100,
  safeYield = 0.6,
  aggressiveYield = 1.2,
  safeSpreadPct = 8,
  aggressiveSpreadPct = 18,
  dteDays = 3,
  chain = [],
  safePop = 0.9,
  aggressivePop = 0.9,
} = {}) {
  return {
    ticker,
    symbol: ticker,
    targetExpiration: EXPIRATION,
    dteDays,
    price,
    safeStrike: makeLeg(safeStrike, safeYield, {
      ticker,
      dteDays,
      spreadPct: safeSpreadPct,
      pop: safePop,
      withBook: true,
      optionSymbol: `${ticker}-SAFE`,
    }),
    aggressiveStrike: makeLeg(aggressiveStrike, aggressiveYield, {
      ticker,
      dteDays,
      spreadPct: aggressiveSpreadPct,
      pop: aggressivePop,
      distancePct: -8,
      withBook: true,
      optionSymbol: `${ticker}-AGG`,
    }),
    safeGrade: "A",
    aggressiveGrade: "B",
    optionsSource: "IBKR live",
    balancedPutChainAvailable: true,
    balancedPutCandidates: chain,
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 0.8,
  };
}

function pickSignature(combos) {
  return Object.fromEntries(
    ["SAFE", "BALANCED", "AGGRESSIVE"].map((label) => [
      label,
      (combos.find((combo) => combo.label === label)?.picks ?? []).map(
        (pick) => `${pick.ticker}:${pick.strike}`,
      ),
    ]),
  );
}

test("MODE_GRADE_RANK des combinaisons reste le classement à deux jambes", () => {
  assert.equal(MODE_GRADE_RANK.AGGRESSIVE_A, 8);
  assert.equal(MODE_GRADE_RANK.AGGRESSIVE_B, 7);
  assert.equal(MODE_GRADE_RANK.SAFE_A, 6);
  assert.equal(MODE_GRADE_RANK.SAFE_B, 5);
});

test("SAFE A gagne contre AGGRESSIVE B malgré un rendement agressif plus haut", () => {
  const safeLeg = makeLeg(90, 0.6, { spreadPct: 8, pop: 0.9, distancePct: -8 });
  const aggressiveLeg = makeLeg(100, 1.8, { spreadPct: 18, pop: 0.96, distancePct: -12 });
  const principal = selectPrincipalThreeLeg({ safeLeg, aggressiveLeg });
  assert.equal(principal.finalDisplayMode, "SAFE");
  assert.equal(principal.finalDisplayGrade, "A");
  assert.equal(principal.topExecutableEligible, true);

  const comboFacing = getFinalDisplayRecommendation({
    safeStrike: safeLeg,
    aggressiveStrike: aggressiveLeg,
    safeGrade: "A",
    aggressiveGrade: "B",
  });
  assert.equal(comboFacing.finalDisplayMode, "AGGRESSIVE");
  assert.equal(comboFacing.finalDisplayGrade, "B");
});

test("BALANCED native A est la troisième jambe et ne compte qu'une fois", () => {
  const candidate = makeCandidate({
    ticker: "INTC",
    price: 110,
    safeStrike: 97.5,
    aggressiveStrike: 102,
    safeYield: 0.69,
    aggressiveYield: 1.51,
    safeSpreadPct: 8,
    aggressiveSpreadPct: 8.7,
    chain: [makeLeg(99, 0.9, { ticker: "INTC", dteDays: 3, spreadPct: 8, withBook: true })],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  const principal = selectPrincipalThreeLegFromRow(candidate);
  assert.equal(principal.legs.filter((leg) => leg.mode === "BALANCED").length, 1);
  assert.equal(principal.selectedLegSource, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(principal.finalDisplayMode, "BALANCED");
  assert.equal(principal.finalDisplayGrade, "A");
  assert.equal(principal.strike, 99);
  assert.equal(principal.topExecutableEligible, true);
  assert.equal(getFinalDisplayRecommendation(candidate).finalDisplayMode, "AGGRESSIVE");
});

test("un fallback SAFE ou AGGRESSIVE n'est pas une troisième jambe", () => {
  const candidate = makeCandidate({
    ticker: "SMCI",
    price: 28,
    safeStrike: 25.5,
    aggressiveStrike: 26,
    safeYield: 0.75,
    aggressiveYield: 1.08,
    safeSpreadPct: 8,
    aggressiveSpreadPct: 8,
    chain: [],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  const principal = selectPrincipalThreeLegFromRow(candidate);
  assert.equal(principal.legs.some((leg) => leg.mode === "BALANCED"), false);
  assert.equal(principal.finalDisplayMode, "AGGRESSIVE");
  assert.notEqual(principal.selectedLegSource, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(
    principal.exclusions.some(
      (item) => item.mode === "BALANCED" && item.reasonCode === BALANCED_NATIVE_REASON_CODES.FALLBACK_SAFE,
    ),
    true,
  );
});

test("le veto earnings 0 à 7 jours reste définitif même si le grade agressif prioritaire serait A", () => {
  const safeLeg = makeLeg(90, 0.6, { spreadPct: 8, pop: 0.9, distancePct: -10 });
  const aggressiveLeg = makeLeg(100, 1.2, { spreadPct: 12, pop: 0.92, distancePct: -8 });
  const withoutVeto = getFinalDisplayRecommendation({
    safeStrike: safeLeg,
    aggressiveStrike: aggressiveLeg,
    safeGrade: "A",
    aggressiveGrade: "A",
  });
  assert.equal(withoutVeto.finalDisplayMode, "AGGRESSIVE");
  assert.equal(withoutVeto.finalDisplayGrade, "A");

  for (const earningsDaysUntil of [0, 3, 7]) {
    const principal = selectPrincipalThreeLegFromRow({
      safeStrike: safeLeg,
      aggressiveStrike: aggressiveLeg,
      earningsDaysUntil,
      dteDays: 3,
    });
    assert.notEqual(principal.finalDisplayMode, "AGGRESSIVE", String(earningsDaysUntil));
    assert.equal(principal.finalDisplayMode, "SAFE");
    assert.equal(
      principal.exclusions.some((item) => item.mode === "AGGRESSIVE" && item.reasonCode === "earningsRisk"),
      true,
    );
    const comboFacing = getFinalDisplayRecommendation({
      safeStrike: safeLeg,
      aggressiveStrike: aggressiveLeg,
      safeGrade: "A",
      aggressiveGrade: "REJECT",
      recommendationDiagnostics: { earningsRisk: true },
    });
    assert.notEqual(comboFacing.finalDisplayMode, "AGGRESSIVE");
    assert.equal(comboFacing.finalDisplayGrade === "A" && comboFacing.finalDisplayMode === "AGGRESSIVE", false);
  }
});

test("earnings inconnus ne fabriquent pas un rejet", () => {
  const safeLeg = makeLeg(124, 0.63, { spreadPct: 21.71, pop: 0.909, distancePct: -7.5 });
  const aggressiveLeg = makeLeg(125, 0.82, { spreadPct: 7.55, pop: 0.891, distancePct: -6.7 });
  for (const earningsDaysUntil of [null, undefined, "", "  ", Number.NaN, "abc", 8, 30]) {
    const principal = selectPrincipalThreeLegFromRow({
      safeStrike: safeLeg,
      aggressiveStrike: aggressiveLeg,
      earningsDaysUntil,
      hasUpcomingEarningsBeforeExpiration: false,
      hasEarningsBeforeExpiration: false,
    });
    assert.equal(principal.finalDisplayMode, "AGGRESSIVE", String(earningsDaysUntil));
    assert.equal(principal.finalDisplayGrade, "A");
    assert.equal(
      principal.exclusions.some((item) => item.reasonCode === "earningsRisk"),
      false,
    );
  }
});

test("POP absente n'est pas exécutable et POP sous 85 ne entre pas dans Top", () => {
  const missingPop = selectPrincipalThreeLeg({
    safeLeg: makeLeg(90, 0.7, { spreadPct: 8, pop: null, distancePct: -8 }),
    aggressiveLeg: makeLeg(100, 0.4, { spreadPct: 40, pop: 0.9, distancePct: -8 }),
  });
  assert.equal(missingPop.executable, false);
  assert.equal(missingPop.topExecutableEligible, false);
  assert.equal(
    missingPop.exclusions.some((item) => item.reasonCode === "POP_UNKNOWN") ||
      missingPop.legs.some((leg) => leg.mode === "SAFE" && leg.executable === false),
    true,
  );

  const lowPop = selectPrincipalThreeLeg({
    safeLeg: makeLeg(90, 0.7, { spreadPct: 8, pop: 0.8, distancePct: -8 }),
    aggressiveLeg: null,
  });
  assert.equal(lowPop.finalDisplayMode, "SAFE");
  assert.equal(lowPop.finalDisplayGrade, "A");
  assert.equal(lowPop.executable, true);
  assert.equal(lowPop.topExecutableEligible, false);

  const enoughPop = selectPrincipalThreeLeg({
    safeLeg: makeLeg(90, 0.7, { spreadPct: 8, pop: 0.85, distancePct: -8 }),
    aggressiveLeg: null,
  });
  assert.equal(enoughPop.topExecutableEligible, true);
});

test("spreads 20, 20.01, 25, 30 et 35 respectent Top et le grade", () => {
  const at20 = selectPrincipalThreeLeg({
    safeLeg: makeLeg(90, 1.1, { spreadPct: 20, pop: 0.9, distancePct: -8 }),
    aggressiveLeg: null,
  });
  assert.equal(at20.finalDisplayGrade, "B");
  assert.equal(at20.topExecutableEligible, true);

  const above20 = selectPrincipalThreeLeg({
    safeLeg: makeLeg(90, 1.1, { spreadPct: 20.01, pop: 0.9, distancePct: -8 }),
    aggressiveLeg: null,
  });
  assert.equal(above20.topExecutableEligible, false);

  for (const spreadPct of [25, 30]) {
    const priority = selectPrincipalThreeLeg({
      safeLeg: makeLeg(90, 0.45, { spreadPct: 28, pop: 0.9, distancePct: -4 }),
      aggressiveLeg: makeLeg(100, 1.2, { spreadPct, pop: 0.9, distancePct: -8 }),
    });
    assert.equal(priority.finalDisplayMode, "AGGRESSIVE", String(spreadPct));
    assert.equal(priority.finalDisplayGrade, "B");
    assert.equal(priority.executable, true);
    assert.equal(priority.topExecutableEligible, false);
  }

  const at35 = selectPrincipalThreeLeg({
    safeLeg: makeLeg(90, 0.45, { spreadPct: 35, pop: 0.9, distancePct: -8 }),
    aggressiveLeg: null,
  });
  assert.equal(at35.finalDisplayGrade, "WATCH");
  assert.equal(at35.selectionPool, "WATCH");
  assert.equal(at35.topExecutableEligible, false);
});

test("une jambe WATCH reste visible et hors Top exécutables", () => {
  const principal = selectPrincipalThreeLeg({
    safeLeg: makeLeg(90, 0.45, { spreadPct: 22, pop: 0.91, distancePct: -8 }),
    aggressiveLeg: makeLeg(100, 0.2, { spreadPct: 50, pop: 0.9, distancePct: -8 }),
  });
  assert.equal(principal.finalDisplayMode, "SAFE");
  assert.equal(principal.finalDisplayGrade, "WATCH");
  assert.equal(principal.topExecutableEligible, false);
  assert.equal(principal.selectionPool, "WATCH");
});

test("marché croisé et spread négatif ne gagnent jamais", () => {
  const crossed = makeLeg(100, 2, { spreadPct: 8, pop: 0.95, distancePct: -12, withBook: true, bid: 1.2, ask: 1 });
  const negative = makeLeg(100, 2, { spreadPct: -4, pop: 0.95, distancePct: -12 });
  const safeLeg = makeLeg(90, 0.45, { spreadPct: 22, pop: 0.9, distancePct: -8 });
  for (const aggressiveLeg of [crossed, negative]) {
    const principal = selectPrincipalThreeLeg({ safeLeg, aggressiveLeg });
    assert.notEqual(principal.finalDisplayMode, "AGGRESSIVE");
    assert.equal(principal.selectedLeg, safeLeg);
  }
});

test("une native hors bande de rendement reste admissible", () => {
  const candidate = makeCandidate({
    ticker: "INTC",
    safeStrike: 90,
    aggressiveStrike: 100,
    safeYield: 0.52,
    aggressiveYield: 1.4,
    safeSpreadPct: 12,
    aggressiveSpreadPct: 12,
    chain: [makeLeg(95, 0.55, { ticker: "INTC", dteDays: 3, spreadPct: 8, withBook: true })],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedLeg.yieldBandStatus, "BELOW");
  const principal = selectPrincipalThreeLegFromRow(candidate);
  assert.equal(principal.finalDisplayMode, "BALANCED");
  assert.equal(principal.strike, 95);
  assert.equal(
    principal.exclusions.some((item) => item.mode === "BALANCED"),
    false,
  );
});

test("les combinaisons ne changent pas quand le choix principal est calculé", () => {
  const candidates = [
    makeCandidate({
      ticker: "SMCI",
      price: 28,
      safeStrike: 25.5,
      aggressiveStrike: 26,
      safeYield: 0.75,
      aggressiveYield: 1.08,
      safeSpreadPct: 8,
      aggressiveSpreadPct: 8,
      chain: [],
    }),
    makeCandidate({
      ticker: "INTC",
      price: 110,
      safeStrike: 97.5,
      aggressiveStrike: 102,
      safeYield: 0.69,
      aggressiveYield: 1.51,
      safeSpreadPct: 8,
      aggressiveSpreadPct: 8.7,
      chain: [makeLeg(99, 0.9, { ticker: "INTC", dteDays: 3, spreadPct: 8, withBook: true })],
    }),
    makeCandidate({
      ticker: "NFLX",
      price: 74,
      safeStrike: 66,
      aggressiveStrike: 68,
      safeYield: 0.65,
      aggressiveYield: 1.15,
      safeSpreadPct: 8,
      aggressiveSpreadPct: 2.5,
      chain: [],
    }),
  ];
  const before = structuredClone(candidates);
  const combosBefore = buildPortfolioCombos(candidates, 250000, 100, 10, new Set(), { optimizerV2: {} });
  for (const candidate of candidates) selectPrincipalThreeLegFromRow(candidate);
  assert.deepEqual(candidates, before);
  const combosAfter = buildPortfolioCombos(candidates, 250000, 100, 10, new Set(), { optimizerV2: {} });
  assert.deepEqual(pickSignature(combosAfter), pickSignature(combosBefore));
});

test("le veto earnings change seulement le ticker vetoé dans les combinaisons", () => {
  const base = [
    makeCandidate({
      ticker: "NFLX",
      price: 74,
      safeStrike: 66,
      aggressiveStrike: 68,
      safeYield: 0.65,
      aggressiveYield: 1.15,
      safeSpreadPct: 8,
      aggressiveSpreadPct: 2.5,
      chain: [],
    }),
    makeCandidate({
      ticker: "SMCI",
      price: 28,
      safeStrike: 25.5,
      aggressiveStrike: 26,
      safeYield: 0.75,
      aggressiveYield: 1.08,
      safeSpreadPct: 8,
      aggressiveSpreadPct: 8,
      chain: [],
    }),
  ];
  const plain = makeCandidate({ ticker: "PLAIN", aggressiveSpreadPct: 18, aggressiveYield: 1.2 });
  const veto = makeCandidate({ ticker: "VETO", aggressiveSpreadPct: 18, aggressiveYield: 1.2 });
  veto.recommendationDiagnostics = { earningsRisk: true };
  assert.equal(getFinalDisplayRecommendation(plain).finalDisplayMode, "AGGRESSIVE");
  assert.equal(getFinalDisplayRecommendation(veto).finalDisplayMode, "SAFE");

  const without = buildPortfolioCombos([...base, plain], 250000, 100, 10, new Set(), { optimizerV2: {} });
  const withVeto = buildPortfolioCombos([...base, veto], 250000, 100, 10, new Set(), { optimizerV2: {} });
  for (const label of ["SAFE", "BALANCED", "AGGRESSIVE"]) {
    const left = (without.find((combo) => combo.label === label)?.picks ?? [])
      .filter((pick) => pick.ticker !== "PLAIN")
      .map((pick) => `${pick.ticker}:${pick.strike}`);
    const right = (withVeto.find((combo) => combo.label === label)?.picks ?? [])
      .filter((pick) => pick.ticker !== "VETO")
      .map((pick) => `${pick.ticker}:${pick.strike}`);
    assert.deepEqual(right, left, `picks ${label} hors ticker vetoé`);
  }
  const vetoPicks = ["SAFE", "BALANCED", "AGGRESSIVE"].flatMap((label) =>
    (withVeto.find((combo) => combo.label === label)?.picks ?? [])
      .filter((pick) => pick.ticker === "VETO")
      .map((pick) => `${label}:${pick.strike}`),
  );
  assert.equal(vetoPicks.some((pick) => pick.startsWith("AGGRESSIVE:")), false);
});
