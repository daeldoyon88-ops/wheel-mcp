import test from "node:test";
import assert from "node:assert/strict";

import {
  BALANCED_LEG_SOURCES,
  BALANCED_NATIVE_REASON_CODES,
  YIELD_POLICY_VERSION,
  buildPortfolioCombos,
  formatCapitalComboPickLegBadge,
  getCanonicalPeriodYieldBand,
  resolveBalancedLegSelection,
  resolveNativeBalancedLeg,
} from "./capitalComboPortfolio.js";

const EXP = "2026-07-31";

function askForSpread(bid, spreadPct = 8) {
  return bid * (spreadPct + 200) / (200 - spreadPct);
}

function leg(strike, periodYieldPct, {
  dteDays = 7,
  spreadPct = 8,
  ticker = "AAPL",
  expiration = EXP,
  right = "PUT",
  optionSymbol = `AAPL-${strike}-P`,
  conId = strike * 10,
  contractId = strike * 100,
  pop = 0.9,
  distancePct = -8,
  bid,
  ask,
  mid,
  grade,
  proFinalScore,
} = {}) {
  const premium = bid ?? (strike * periodYieldPct) / 100;
  const resolvedAsk = ask === undefined ? askForSpread(premium, spreadPct) : ask;
  return {
    ticker,
    symbol: ticker,
    expiration,
    right,
    optionType: right,
    strike,
    bid: premium,
    ask: resolvedAsk,
    mid: mid === undefined && Number.isFinite(resolvedAsk) ? (premium + resolvedAsk) / 2 : mid,
    dteDays,
    distancePct,
    popProfitEstimated: pop,
    volume: 300,
    openInterest: 800,
    optionSymbol,
    conId,
    contractId,
    quoteTimestamp: "2026-07-14T15:00:00Z",
    marketDataType: "live",
    quoteSource: "IBKR",
    grade,
    proFinalScore,
  };
}

function candidate({
  ticker = "AAPL",
  safeStrike = 67,
  aggressiveStrike = 75,
  safeYield = 0.74,
  aggressiveYield = 1.0,
  dteDays = 7,
  chain = [],
  chainAvailable = true,
  safe = undefined,
  aggressive = undefined,
} = {}) {
  return {
    ticker,
    symbol: ticker,
    targetExpiration: EXP,
    dteDays,
    price: 100,
    safeStrike:
      safe === undefined
        ? leg(safeStrike, safeYield, { ticker, dteDays, optionSymbol: `${ticker}-SAFE` })
        : safe,
    aggressiveStrike:
      aggressive === undefined
        ? leg(aggressiveStrike, aggressiveYield, {
            ticker,
            dteDays,
            optionSymbol: `${ticker}-AGG`,
          })
        : aggressive,
    safeGrade: "A",
    aggressiveGrade: "A",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
    optionsSource: "IBKR live",
    balancedPutChainAvailable: chainAvailable,
    balancedPutCandidates: chain,
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.4,
    proExecutionScore: 0.8,
    proDistanceScore: 0.8,
  };
}

function native(c) {
  return resolveNativeBalancedLeg({ candidate: c });
}

function balancedPick(c, capital = 100000) {
  const combos = buildPortfolioCombos([c], capital, 100, 10, new Set(), {
    optimizerV2: {},
  });
  return {
    combo: combos.find((row) => row.label === "BALANCED") ?? null,
    safe: combos.find((row) => row.label === "SAFE") ?? null,
    aggressive: combos.find((row) => row.label === "AGGRESSIVE") ?? null,
  };
}

test("A1 — midpoint réel 71 sélectionné comme BALANCED native", () => {
  const result = native(candidate({ chain: [leg(71, 0.875)] }));
  assert.equal(result.selectedStrike, 71);
  assert.equal(result.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.SELECTED);
});

test("A2 — égalité géométrique 70/72 : le strike inférieur gagne", () => {
  const result = native(candidate({ chain: [leg(72, 0.9), leg(70, 0.9)] }));
  assert.equal(result.selectedStrike, 70);
});

test("A3-A4 — midpoint invalide : autre strike valide, pas la meilleure prime", () => {
  const result = native(candidate({
    chain: [
      leg(71, 0.875, { ask: null }),
      leg(72, 0.8),
      leg(74, 1.04),
    ],
  }));
  assert.equal(result.selectedStrike, 72);
  assert.notEqual(result.selectedStrike, 74);
});

test("A5 — frontières inversées : BALANCED natif indisponible et diagnostic explicite", () => {
  const c = candidate({
    safe: leg(75, 0.8),
    aggressive: leg(67, 1.0),
    chain: [leg(71, 0.875)],
  });
  const result = native(c);
  assert.equal(result.selectedLeg, null);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.INVERTED_BOUNDARIES);
  assert.equal(result.diagnostics.invertedSafeAggressiveOrder, true);
});

test("B6 — aucun strike strictement intermédiaire : fallback exécuté", () => {
  const c = candidate({ safeStrike: 67, aggressiveStrike: 68, chain: [] });
  const nativeResult = native(c);
  const final = resolveBalancedLegSelection({ candidate: c });
  assert.equal(nativeResult.reasonCode, BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE);
  assert.match(final.source, /^BALANCED_FALLBACK_/);
});

test("B7 — SAFE=AGGRESSIVE : diagnostic explicite, aucun crash", () => {
  const c = candidate({ safeStrike: 67, aggressiveStrike: 67, chain: [] });
  const result = native(c);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE);
  assert.ok(result.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.EQUAL_BOUNDARIES));
});

test("C8 — aucun contrat synthétique lorsque 71 est absent", () => {
  const result = native(candidate({ chain: [leg(70, 0.8), leg(72, 0.9)] }));
  assert.notEqual(result.selectedStrike, 71);
  assert.ok([70, 72].includes(result.selectedStrike));
});

test("C9-C11 — autre expiration, autre ticker et CALL sont exclus", () => {
  const result = native(candidate({
    chain: [
      leg(71, 0.875, { expiration: "2026-08-07" }),
      leg(70, 0.875, { ticker: "MSFT" }),
      leg(72, 0.875, { right: "CALL" }),
    ],
  }));
  assert.equal(result.selectedLeg, null);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE);
  assert.equal(result.diagnostics.scopeRejectedContractCount, 3);
});

test("C12 — quote manquante rejetée avec diagnostic", () => {
  const result = native(candidate({ chain: [leg(71, 0.875, { ask: null })] }));
  assert.equal(result.selectedLeg, null);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.QUOTES_INVALID);
});

test("C13 — toutes les métadonnées viennent du vrai contrat retenu", () => {
  const real = leg(71, 0.875, {
    optionSymbol: "REAL-71",
    conId: 71001,
    contractId: 71002,
    bid: 0.62125,
    ask: 0.65,
    mid: 0.635625,
  });
  const selected = native(candidate({ chain: [real] })).selectedLeg;
  for (const key of ["optionSymbol", "conId", "contractId", "bid", "ask", "mid"]) {
    assert.equal(selected[key], real[key], key);
  }
});

test("D14-D18 — bande hybride BALANCED 7/17 DTE reste calculée et informative", () => {
  const b7 = getCanonicalPeriodYieldBand("BALANCED", 7);
  const b17 = getCanonicalPeriodYieldBand("BALANCED", 17);
  assert.equal(b7.effectivePeriodMinPct, 0.7);
  assert.equal(b7.effectivePeriodMaxPct, 1.05);
  assert.ok(Math.abs(b17.effectivePeriodMinPct - 1.7) < 1e-12);
  assert.ok(Math.abs(b17.effectivePeriodMaxPct - 2.55) < 1e-12);

  const c17 = (yieldPct) => candidate({
    safeStrike: 90,
    aggressiveStrike: 110,
    safeYield: 1.8,
    aggressiveYield: 2.4,
    dteDays: 17,
    chain: [leg(100, yieldPct, { dteDays: 17 })],
  });
  assert.equal(native(c17(1.7)).selectedYieldBandStatus, "WITHIN");
  assert.equal(native(c17(2.55)).selectedYieldBandStatus, "ABOVE");
  assert.equal(native(c17(1.699)).selectedYieldBandStatus, "BELOW");
});

test("D19 — DTE manquant : diagnostic explicite, aucun NaN", () => {
  const withoutDte = leg(71, 0.875, { dteDays: undefined });
  delete withoutDte.dteDays;
  const c = candidate({
    dteDays: null,
    safe: { ...withoutDte, strike: 67 },
    aggressive: { ...withoutDte, strike: 75 },
    chain: [withoutDte],
  });
  delete c.dteDays;
  const result = native(c);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.INVALID_DTE);
  assert.equal(Number.isNaN(result.effectivePeriodMinPct), false);
});

test("E20 — midpoint au spread invalide : l'autre strike valide gagne", () => {
  const result = native(candidate({
    chain: [leg(71, 0.875, { spreadPct: 30 }), leg(72, 0.9, { spreadPct: 8 })],
  }));
  assert.equal(result.selectedStrike, 72);
});

test("E21 — tous spreads invalides : fallback et raison spread", () => {
  const c = candidate({ chain: [leg(71, 0.875, { spreadPct: 30 })] });
  const final = resolveBalancedLegSelection({ candidate: c });
  assert.match(final.source, /^BALANCED_FALLBACK_/);
  assert.ok(final.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.FAILED_SPREAD));
});

test("E22 — tous rendements hors bande : native conservée et statut informatif", () => {
  const c = candidate({ chain: [leg(71, 1.2)] });
  const final = resolveBalancedLegSelection({ candidate: c });
  assert.equal(final.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(final.selectedYieldBandStatus, "ABOVE");
  assert.equal(final.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.OUTSIDE_YIELD_BAND), false);
});

test("E23 — grade non admissible : fallback et raison grade", () => {
  const c = candidate({
    chain: [leg(71, 0.875, { spreadPct: 19, pop: 0.7, distancePct: -4 })],
  });
  const final = resolveBalancedLegSelection({ candidate: c });
  assert.match(final.source, /^BALANCED_FALLBACK_/);
  assert.ok(final.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.FAILED_GRADE));
});

test("F24-F25 — fallback SAFE seul puis AGGRESSIVE seul", () => {
  const safeOnly = candidate({
    safe: leg(67, 0.8),
    aggressive: leg(75, 1.2),
    chain: [],
  });
  const aggOnly = candidate({
    safe: leg(67, 0.5, { spreadPct: 30 }),
    aggressive: leg(75, 0.9),
    chain: [],
  });
  assert.equal(
    resolveBalancedLegSelection({ candidate: safeOnly }).source,
    BALANCED_LEG_SOURCES.FALLBACK_SAFE,
  );
  assert.equal(
    resolveBalancedLegSelection({ candidate: aggOnly }).source,
    BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
  );
});

test("F26-F27 — fallback SAFE prioritaire quel que soit le rendement", () => {
  const closerAgg = candidate({
    safe: leg(67, 0.72),
    aggressive: leg(75, 0.87),
    chain: [],
  });
  const tie = candidate({
    safe: leg(67, 0.8),
    aggressive: leg(75, 0.95),
    chain: [],
  });
  assert.equal(
    resolveBalancedLegSelection({ candidate: closerAgg }).source,
    BALANCED_LEG_SOURCES.FALLBACK_SAFE,
  );
  assert.equal(
    resolveBalancedLegSelection({ candidate: tie }).source,
    BALANCED_LEG_SOURCES.FALLBACK_SAFE,
  );
});

test("F28 — aucun fallback admissible : BALANCED_UNAVAILABLE", () => {
  const c = candidate({
    safe: leg(67, 0.5, { spreadPct: 30 }),
    aggressive: leg(75, 1.2, { spreadPct: 30 }),
    chain: [],
  });
  const result = resolveBalancedLegSelection({ candidate: c });
  assert.equal(result.source, BALANCED_LEG_SOURCES.UNAVAILABLE);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.NO_FALLBACK);
});

test("F29 — centre fallback exact à 17 DTE", () => {
  const c = candidate({
    dteDays: 17,
    safe: leg(90, 1.8, { dteDays: 17 }),
    aggressive: leg(110, 2.3, { dteDays: 17 }),
    chain: [],
  });
  assert.equal(resolveBalancedLegSelection({ candidate: c }).effectiveTargetPct, 2.125);
});

test("G30-G33 — intégration moteur : capital, grade, score et métadonnées natifs", () => {
  const nativeLeg = leg(71, 0.875, {
    grade: "B",
    proFinalScore: 0.123456,
    optionSymbol: "NATIVE-REAL",
    conId: 7123,
    contractId: 7145,
  });
  const { combo } = balancedPick(candidate({ chain: [nativeLeg] }));
  const pick = combo?.picks?.[0];
  assert.ok(pick);
  assert.equal(pick.capitalRequired, 7100);
  assert.equal(pick.grade, "B");
  assert.equal(pick.proScoreSource, "selected_leg_explicit");
  assert.equal(pick.optionSymbol, "NATIVE-REAL");
  assert.equal(pick.conId, 7123);
  assert.equal(pick.contractId, 7145);
});

test("G34-G35 — format greedy/caps inchangé et compteurs moteur exposés", () => {
  const { combo } = balancedPick(candidate({ chain: [leg(71, 0.875)] }));
  assert.equal(combo?.positions, 1);
  assert.ok(combo?.picks?.[0]?.contracts >= 1);
  assert.deepEqual(combo?.balancedLegSourceCounts, {
    native: 1,
    fallbackSafe: 0,
    fallbackAggressive: 0,
    unavailable: 0,
  });
});

test("G36 — jambe native trop chère diagnostiquée par le greedy existant", () => {
  const c = candidate({
    safeStrike: 90,
    aggressiveStrike: 110,
    safeYield: 0.8,
    aggressiveYield: 1.0,
    chain: [leg(100, 0.875)],
  });
  const { combo } = balancedPick(c, 5000);
  assert.equal(combo?.picks?.length ?? 0, 0);
});

test("G37-G40 — SAFE/AGGRESSIVE et politique hybride restent inchangés", () => {
  const c = candidate({ chain: [leg(71, 0.875)] });
  const { safe, aggressive } = balancedPick(c);
  assert.equal(safe?.picks?.[0]?.strike, 67);
  assert.equal(aggressive?.picks?.[0]?.strike, 75);
  assert.equal(YIELD_POLICY_VERSION, "hybrid-period-v1");
  assert.ok(
    Math.abs(getCanonicalPeriodYieldBand("BALANCED", 17).effectivePeriodMinPct - 1.7) < 1e-12,
  );
});

test("H41-H43 — badges UI natif et fallbacks explicites", () => {
  assert.equal(
    formatCapitalComboPickLegBadge({ balancedLegSource: BALANCED_LEG_SOURCES.NATIVE }),
    "BALANCED native",
  );
  assert.equal(
    formatCapitalComboPickLegBadge({ balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_SAFE }),
    "Fallback SAFE",
  );
  assert.equal(
    formatCapitalComboPickLegBadge({
      balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
    }),
    "Fallback AGGRESSIVE",
  );
});

test("H44-H46 — inspecteur reçoit frontières/midpoint/strike réel et compteurs cohérents", () => {
  const { combo } = balancedPick(candidate({ chain: [leg(71, 0.875)] }));
  const diag = combo?.picks?.[0]?.balancedLegDiagnostics;
  assert.equal(diag.safeStrike, 67);
  assert.equal(diag.aggressiveStrike, 75);
  assert.equal(diag.midpointStrike, 71);
  assert.equal(diag.selectedStrike, 71);
  assert.equal(diag.intermediateContractCount, 1);
  assert.equal(combo.balancedLegSourceCounts.native, 1);
});
