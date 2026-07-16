import assert from "node:assert/strict";
import test from "node:test";

import {
  BALANCED_LEG_SOURCES,
  BALANCED_NATIVE_REASON_CODES,
  YIELD_POLICY_VERSION,
  buildPortfolioCombos,
  getCanonicalPeriodYieldBand,
  resolveBalancedLegSelection,
  resolveNativeBalancedLeg,
} from "./capitalComboPortfolio.js";
import {
  resolveBalancedCardViewModel,
  resolvePortfolioSelectionByTicker,
} from "./balancedModeUi.js";
import { rowMatchesModeFilter } from "./capitalComboInputPool.js";

const EXPIRATION = "2026-07-24";

function askForSpread(bid, spreadPct) {
  return bid * ((spreadPct + 200) / (200 - spreadPct));
}

function makeLeg(strike, periodYieldPct, {
  ticker = "SOXL",
  spreadPct = 8,
  dteDays = 8,
  bid = undefined,
  ask = undefined,
  mid = undefined,
  pop = 0.9,
  volume = 300,
  openInterest = 800,
  distancePct = -8,
  proFinalScore = undefined,
  optionSymbol = `${ticker}-${strike}-P`,
} = {}) {
  const resolvedBid = bid === undefined ? (strike * periodYieldPct) / 100 : bid;
  const resolvedAsk = ask === undefined && Number.isFinite(resolvedBid)
    ? askForSpread(resolvedBid, spreadPct)
    : ask;
  return {
    ticker,
    symbol: ticker,
    expiration: EXPIRATION,
    right: "PUT",
    optionType: "PUT",
    strike,
    bid: resolvedBid,
    ask: resolvedAsk,
    mid:
      mid === undefined && Number.isFinite(resolvedBid) && Number.isFinite(resolvedAsk)
        ? (resolvedBid + resolvedAsk) / 2
        : mid,
    premiumUsed: resolvedBid,
    periodYield: periodYieldPct,
    weeklyYield: periodYieldPct,
    dteDays,
    distancePct,
    popProfitEstimated: pop,
    volume,
    openInterest,
    liquidity: { spreadPct },
    optionSymbol,
    quoteTimestamp: "2026-07-16T15:00:00Z",
    quoteSource: "IBKR",
    proFinalScore,
  };
}

function makeCandidate({
  ticker = "SOXL",
  safeStrike = 85,
  aggressiveStrike = 110,
  safeYield = 1.15,
  aggressiveYield = 3.82,
  safeSpread = 8,
  aggressiveSpread = 8,
  dteDays = 8,
  chain = [],
} = {}) {
  return {
    ticker,
    symbol: ticker,
    targetExpiration: EXPIRATION,
    dteDays,
    price: 120,
    safeStrike: makeLeg(safeStrike, safeYield, { ticker, spreadPct: safeSpread, dteDays }),
    aggressiveStrike: makeLeg(aggressiveStrike, aggressiveYield, {
      ticker,
      spreadPct: aggressiveSpread,
      dteDays,
    }),
    safeGrade: "A",
    aggressiveGrade: "A",
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: "A",
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

function combosFor(candidates, {
  capital = 100_000,
  maxPositions = 10,
  trace = false,
} = {}) {
  const holder = {};
  const combos = buildPortfolioCombos(candidates, capital, 100, maxPositions, new Set(), {
    optimizerV2: {},
    capitalComboTraceDebug: trace,
    capitalComboTraceSuppressConsoleLogs: true,
    comboTracePayloadHolder: holder,
  });
  return {
    combos,
    holder,
    balanced: combos.find((row) => row.label === "BALANCED") ?? null,
  };
}

test("BALANCED 1,40 % au midpoint reste natif, exécutable et informativement ABOVE", () => {
  const candidate = makeCandidate({ chain: [makeLeg(97.5, 1.4)] });
  const result = resolveBalancedLegSelection({ candidate });
  assert.equal(result.selectedStrike, 97.5);
  assert.equal(result.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(result.selectedYieldBandStatus, "ABOVE");
  assert.equal(result.executionEligible, true);
  assert.equal(result.balancedLegAvailable, true);
  assert.equal(result.includedInBalancedPool, true);
  assert.equal(result.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.OUTSIDE_YIELD_BAND), false);
});

test("BALANCED 2,50 % reste disponible sans exclusion de rendement", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({ chain: [makeLeg(97.5, 2.5)] }),
  });
  assert.equal(result.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(result.selectedYieldBandStatus, "ABOVE");
  assert.equal(result.executionEligible, true);
});

test("BALANCED sous la cible reste disponible avec statut BELOW", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({ chain: [makeLeg(97.5, 0.6)] }),
  });
  assert.equal(result.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(result.selectedYieldBandStatus, "BELOW");
  assert.equal(result.executionEligible, true);
});

test("midpoint rejeté au spread : le candidat exécutable suivant est essayé", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({
      chain: [
        makeLeg(97.5, 1.4, { spreadPct: 25 }),
        makeLeg(95, 1.4, { spreadPct: 9 }),
        makeLeg(100, 1.4, { spreadPct: 5 }),
      ],
    }),
  });
  assert.equal(result.selectedStrike, 100);
  assert.deepEqual(
    result.diagnostics.candidateDiagnostics.slice(0, 2).map((row) => row.strike),
    [97.5, 100],
  );
  assert.deepEqual(result.diagnostics.candidateDiagnostics[0].rejectionReasons, ["SPREAD_NOT_ELIGIBLE"]);
});

test("plusieurs échecs successifs : le quatrième candidat géométrique est sélectionné", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({
      chain: [
        makeLeg(97.5, 1.4, { ask: null }),
        makeLeg(95, 1.4, { spreadPct: 25 }),
        makeLeg(100, 1.4, { pop: 0.5 }),
        makeLeg(92.5, 1.4),
      ],
    }),
  });
  assert.equal(result.selectedStrike, 92.5);
  assert.equal(result.diagnostics.candidateDiagnostics.filter((row) => !row.admissionEligible).length, 3);
  assert.equal(result.diagnostics.candidateDiagnostics.filter((row) => !row.executionEligible).length, 2);
});

test("égalité de distance : spread, liquidité, puis strike inférieur", () => {
  const bySpread = resolveNativeBalancedLeg({
    candidate: makeCandidate({
      chain: [makeLeg(95, 1.4, { spreadPct: 9 }), makeLeg(100, 1.4, { spreadPct: 5 })],
    }),
  });
  assert.equal(bySpread.selectedStrike, 100);

  const byLiquidity = resolveNativeBalancedLeg({
    candidate: makeCandidate({
      chain: [
        makeLeg(95, 1.4, { volume: 50, openInterest: 100 }),
        makeLeg(100, 1.4, { volume: 500, openInterest: 1_000 }),
      ],
    }),
  });
  assert.equal(byLiquidity.selectedStrike, 100);

  const byStrike = resolveNativeBalancedLeg({
    candidate: makeCandidate({ chain: [makeLeg(100, 1.4), makeLeg(95, 1.4)] }),
  });
  assert.equal(byStrike.selectedStrike, 95);
});

test("SOXL : huit rendements hors cible restent examinés et le plus proche gagne", () => {
  const strikes = [90, 92.5, 95, 97.5, 100, 102.5, 105, 107.5];
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({
      safeSpread: 31.76,
      chain: strikes.map((strike, index) => makeLeg(strike, 1.3 + index * 0.1)),
    }),
  });
  assert.equal(result.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(result.selectedStrike, 97.5);
  assert.equal(result.intermediateContractCount, 8);
  assert.equal(result.quoteValidIntermediateCount, 8);
  assert.equal(result.yieldEligibleIntermediateCount, 0);
  assert.equal(result.executionEligibleIntermediateCount, 8);
  assert.ok(result.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.ALL_YIELDS_OUTSIDE_TARGET_BAND));
});

test("tous les intermédiaires échouent au spread : fallback SAFE prioritaire", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({ chain: [makeLeg(97.5, 1.4, { spreadPct: 25 })] }),
  });
  assert.equal(result.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
});

test("fallback SAFE rejeté au spread : AGGRESSIVE 3,82 % est accepté", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({
      safeSpread: 31.76,
      aggressiveSpread: 8,
      chain: [makeLeg(97.5, 1.4, { spreadPct: 25 })],
    }),
  });
  assert.equal(result.source, BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE);
  assert.equal(result.selectedYieldBandStatus, "ABOVE");
  assert.equal(result.executionEligible, true);
});

test("intermédiaires et fallbacks non exécutables : indisponible sans raison rendement", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({
      safeSpread: 30,
      aggressiveSpread: 30,
      chain: [makeLeg(97.5, 1.4, { spreadPct: 30 })],
    }),
  });
  assert.equal(result.source, BALANCED_LEG_SOURCES.UNAVAILABLE);
  assert.equal(result.reasonCode, BALANCED_NATIVE_REASON_CODES.NO_FALLBACK);
  assert.equal(result.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.OUTSIDE_YIELD_BAND), false);
  assert.ok(result.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.FAILED_SPREAD));
});

test("SAFE = AGRESSIF : aucun natif et fallback explicitement étiqueté", () => {
  const candidate = makeCandidate({ safeStrike: 100, aggressiveStrike: 100, chain: [] });
  const native = resolveNativeBalancedLeg({ candidate });
  const result = resolveBalancedLegSelection({ candidate });
  assert.equal(native.selectedLeg, null);
  assert.ok(native.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.EQUAL_BOUNDARIES));
  assert.equal(result.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
});

test("aucun strike intermédiaire : les fallbacks sont testés dans l'ordre", () => {
  const result = resolveBalancedLegSelection({
    candidate: makeCandidate({ safeStrike: 100, aggressiveStrike: 101, chain: [] }),
  });
  assert.equal(result.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
});

test("Combinaisons capital inclut et sélectionne une native à 1,40 %", () => {
  const candidate = makeCandidate({ chain: [makeLeg(97.5, 1.4)] });
  const { balanced } = combosFor([candidate]);
  const pick = balanced?.picks?.find((row) => row.ticker === candidate.ticker);
  assert.ok(pick);
  assert.equal(pick.strike, 97.5);
  assert.equal(pick.bucketMode, "BALANCED");
  assert.equal(pick.selectedLegMode, "BALANCED");
  assert.equal(pick.balancedLegSource, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(pick.balancedLegDiagnostics.selectedYieldBandStatus, "ABOVE");
});

test("capital insuffisant : jambe disponible avant optimisation, raison capitale uniquement", () => {
  const candidate = makeCandidate({ chain: [makeLeg(97.5, 1.4)] });
  const engine = resolveBalancedLegSelection({ candidate });
  const view = resolveBalancedCardViewModel({ candidate, usableCapital: 5_000 });
  const { holder } = combosFor([candidate], { capital: 5_000, trace: true });
  const rejects = holder?.capitalComboAllocationTraceV1?.scoredCandidatesByMode?.BALANCED
    ?.rejectedBeforeAllocation ?? [];
  assert.equal(engine.includedInBalancedPool, true);
  assert.equal(view.available, true);
  assert.equal(view.includedInBalancedPool, false);
  assert.equal(view.notSelectedReason, "CAPITAL_INSUFFICIENT");
  assert.equal(rejects[0]?.primaryBlocker, "CAPITAL_INSUFFICIENT");
});

test("greedy : une native 1,40 % non retenue reste dans le scored pool", () => {
  const highYield = makeCandidate({
    ticker: "AAPL",
    chain: [makeLeg(97.5, 1.4, { ticker: "AAPL", spreadPct: 18, pop: 0.9, proFinalScore: 0.01 })],
  });
  const stronger = makeCandidate({
    ticker: "AAPL",
    safeStrike: 90,
    aggressiveStrike: 110,
    chain: [makeLeg(100, 1.15, { ticker: "AAPL", spreadPct: 4, pop: 0.95, proFinalScore: 0.99 })],
  });
  const { balanced, holder } = combosFor([highYield, stronger], {
    maxPositions: 1,
    trace: true,
  });
  const scored = holder?.capitalComboAllocationTraceV1?.scoredCandidatesByMode?.BALANCED
    ?.scoredCandidatesOrdered ?? [];
  assert.ok(scored.some((row) => row.legSummary?.strike === 97.5));
  assert.equal(balanced?.picks?.some((row) => row.strike === 97.5), false);
  assert.equal(resolveBalancedLegSelection({ candidate: highYield }).balancedLegAvailable, true);
});

test("filtre Mode BALANCED conserve la native à 1,40 %", () => {
  const candidate = makeCandidate({ chain: [makeLeg(97.5, 1.4)] });
  const vm = resolveBalancedCardViewModel({ candidate });
  const row = {
    ...candidate,
    balancedCardViewModel: vm,
    balancedLegSource: vm.source,
    capitalComboBucketMode: "BALANCED",
  };
  assert.equal(vm.yieldBandStatus, "ABOVE");
  assert.equal(rowMatchesModeFilter(row, "BALANCED"), true);
  assert.equal(rowMatchesModeFilter(row, "AGGRESSIVE"), false);
});

test("non-régression DTE : 2026-07-16 vers 2026-07-24 reste transporté à 8", () => {
  const candidate = makeCandidate({ chain: [makeLeg(97.5, 1.4)] });
  const result = resolveBalancedLegSelection({ candidate });
  const band = getCanonicalPeriodYieldBand("BALANCED", result.dteDays);
  assert.equal(result.dteDays, 8);
  assert.equal(band.effectivePeriodMaxPct, 1.2);
  assert.equal(YIELD_POLICY_VERSION, "hybrid-period-v1");
});

test("non-régression SAFE/AGRESSIF : jambes, primes et quotes restent inchangées", () => {
  const candidate = makeCandidate({
    safeYield: 0.8,
    aggressiveYield: 1.5,
    chain: [makeLeg(97.5, 1.4)],
  });
  const safeBefore = structuredClone(candidate.safeStrike);
  const aggressiveBefore = structuredClone(candidate.aggressiveStrike);
  resolveBalancedLegSelection({ candidate });
  assert.deepEqual(candidate.safeStrike, safeBefore);
  assert.deepEqual(candidate.aggressiveStrike, aggressiveBefore);
  const { combos } = combosFor([candidate]);
  assert.equal(combos.find((row) => row.label === "SAFE")?.picks?.[0]?.strike, 85);
  assert.equal(combos.find((row) => row.label === "AGGRESSIVE")?.picks?.[0]?.strike, 110);
});
