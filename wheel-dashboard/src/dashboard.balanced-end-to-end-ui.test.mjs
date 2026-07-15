import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeAnnualizedSimpleYieldPct,
  enrichCandidateRowForDisplay,
  formatAnnualizedSimpleYieldPct,
  resolveBalancedCardViewModel,
  resolveDashboardModeForFilter,
  resolveDashboardModePresentation,
  resolvePortfolioSelectionByTicker,
} from "./balancedModeUi.js";
import { rowMatchesModeFilter } from "./capitalComboInputPool.js";
import {
  BALANCED_LEG_SOURCES,
  BALANCED_NATIVE_REASON_CODES,
  buildPortfolioCombos,
  getLegPeriodYieldPct,
  getLegWeeklyNormalizedYieldPct,
  resolveBalancedLegSelection,
} from "./capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SOURCE = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");

const EXPIRATION = "2026-07-31";

function askForSpread(bid, spreadPct = 8) {
  return bid * (spreadPct + 200) / (200 - spreadPct);
}

function makeLeg(strike, periodYieldPct, {
  ticker = "TQQQ",
  dteDays = 3,
  spreadPct = 8,
  optionSymbol = `${ticker}-${strike}-P`,
  conId = strike * 10,
} = {}) {
  const bid = (strike * periodYieldPct) / 100;
  const ask = askForSpread(bid, spreadPct);
  return {
    ticker,
    symbol: ticker,
    expiration: EXPIRATION,
    right: "PUT",
    optionType: "PUT",
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    dteDays,
    distancePct: -8,
    popProfitEstimated: 0.9,
    volume: 500,
    openInterest: 1000,
    optionSymbol,
    conId,
    contractId: conId * 10,
    quoteTimestamp: "2026-07-14T15:00:00Z",
    marketDataType: "live",
    quoteSource: "IBKR",
  };
}

function makeCandidate({
  ticker = "TQQQ",
  safeStrike = 69,
  aggressiveStrike = 72,
  safeYield = 0.55,
  aggressiveYield = 1.14,
  dteDays = 3,
  chain = [],
  chainAvailable = true,
} = {}) {
  return {
    ticker,
    symbol: ticker,
    targetExpiration: EXPIRATION,
    dteDays,
    price: 100,
    safeStrike: makeLeg(safeStrike, safeYield, { ticker, dteDays, optionSymbol: `${ticker}-SAFE` }),
    aggressiveStrike: makeLeg(aggressiveStrike, aggressiveYield, {
      ticker,
      dteDays,
      optionSymbol: `${ticker}-AGG`,
    }),
    safeGrade: "A",
    aggressiveGrade: "A",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
    optionsSource: "IBKR live",
    balancedPutChainAvailable: chainAvailable,
    balancedPutCandidates: chain,
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 0.8,
  };
}

function withBalancedVm(row) {
  const vm = resolveBalancedCardViewModel({ candidate: row });
  return {
    ...row,
    balancedCardViewModel: vm,
    balancedLegSource: vm.source,
    capitalComboBucketMode: vm.available ? "BALANCED" : null,
  };
}

function combosFor(candidates, capital = 250000) {
  return buildPortfolioCombos(candidates, capital, 100, 10, new Set(), { optimizerV2: {} });
}

test("filtre et colonne MODE — bucket BALANCED distinct des jambes SAFE/AGRESSIF", () => {
  const safe = {
    ticker: "SAFE",
    capitalComboBucketMode: "SAFE",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
    safeGrade: "A",
    safeStrike: { strike: 50, weeklyYield: 0.6, bid: 0.3 },
  };
  const aggressive = { ticker: "AGG", capitalComboBucketMode: "AGGRESSIVE", finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A" };
  const native = {
    ticker: "NATIVE",
    finalDisplayMode: "SAFE",
    balancedLegSource: BALANCED_LEG_SOURCES.NATIVE,
    balancedCardViewModel: { available: true, source: BALANCED_LEG_SOURCES.NATIVE, grade: "A", mode: "BALANCED" },
  };
  const fallbackSafe = {
    ticker: "FB_SAFE",
    finalDisplayMode: "SAFE",
    balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_SAFE,
    balancedCardViewModel: { available: true, source: BALANCED_LEG_SOURCES.FALLBACK_SAFE, grade: "B", mode: "BALANCED" },
  };
  const fallbackAggressive = {
    ticker: "FB_AGG",
    finalDisplayMode: "AGGRESSIVE",
    balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
    balancedCardViewModel: { available: true, source: BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE, grade: "A", mode: "BALANCED" },
  };
  const rows = [safe, aggressive, native, fallbackSafe, fallbackAggressive];

  assert.deepEqual(rows.filter((row) => rowMatchesModeFilter(row, "BALANCED")).map((row) => row.ticker), ["NATIVE", "FB_SAFE", "FB_AGG"]);
  assert.deepEqual(rows.filter((row) => rowMatchesModeFilter(row, "SAFE")).map((row) => row.ticker), ["SAFE"]);
  assert.deepEqual(rows.filter((row) => rowMatchesModeFilter(row, "AGGRESSIVE")).map((row) => row.ticker), ["AGG"]);
  assert.equal(rows.filter((row) => rowMatchesModeFilter(row, "all")).length, 5);

  const nativeMode = resolveDashboardModePresentation(native, { modeFilter: "BALANCED" });
  assert.equal(nativeMode.bucketLabel, "BALANCED");
  assert.equal(nativeMode.grade, "A");
  assert.equal(nativeMode.legSourceLabel, "Native");

  const fbSafeMode = resolveDashboardModePresentation(fallbackSafe, { modeFilter: "BALANCED" });
  assert.equal(fbSafeMode.bucketLabel, "BALANCED");
  assert.equal(fbSafeMode.grade, "B");
  assert.equal(fbSafeMode.legSourceLabel, "Fallback SAFE");

  const fbAggMode = resolveDashboardModePresentation(fallbackAggressive, { modeFilter: "BALANCED" });
  assert.equal(fbAggMode.bucketLabel, "BALANCED");
  assert.equal(fbAggMode.grade, "A");
  assert.equal(fbAggMode.legSourceLabel, "Fallback AGRESSIF");

  const trueSafeMode = resolveDashboardModePresentation(safe, { modeFilter: "all" });
  assert.equal(trueSafeMode.bucketLabel, "SAFE");
});

test("TQQQ — native 70, annualisé non nul, badge portefeuille BALANCED", () => {
  const candidate = makeCandidate({
    ticker: "TQQQ",
    safeStrike: 69,
    aggressiveStrike: 72,
    safeYield: 0.55,
    aggressiveYield: 1.14,
    dteDays: 3,
    chain: [makeLeg(70, 0.7, { ticker: "TQQQ", dteDays: 3, optionSymbol: "TQQQ-NATIVE-70" })],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedStrike, 70);

  const weekly = getLegWeeklyNormalizedYieldPct(engine.selectedLeg, candidate);
  const annualized = computeAnnualizedSimpleYieldPct(weekly);
  assert.ok(weekly > 1.5 && weekly < 1.8, `weekly inattendu: ${weekly}`);
  assert.ok(annualized > 80 && annualized < 90, `annualisé inattendu: ${annualized}`);

  const combos = combosFor([candidate]);
  const selection = resolvePortfolioSelectionByTicker(combos);
  const enriched = enrichCandidateRowForDisplay(
    withBalancedVm({
      ...candidate,
      balancedCardViewModel: resolveBalancedCardViewModel({
        candidate,
        portfolioSelection: selection,
      }),
    }),
    selection,
  );
  const view = enriched.balancedCardViewModel;
  assert.equal(view.strike, 70);
  assert.ok(view.annualizedSimpleYieldPct > 80);
  assert.equal(formatAnnualizedSimpleYieldPct(null), "n/d");
  assert.equal(formatAnnualizedSimpleYieldPct(0), "0.0%");

  const balancedPick = combos.find((c) => c.label === "BALANCED")?.picks?.find((p) => p.ticker === "TQQQ");
  if (balancedPick) {
    assert.equal(enriched.selectedForBalanced, true);
    // Badge secondaire d'appartenance au portefeuille — jamais un badge de
    // recommandation du scan.
    assert.equal(view.badgeLabel, "Portefeuille BALANCED");
  }

  const mode = resolveDashboardModePresentation(enriched, { modeFilter: "BALANCED" });
  assert.equal(mode.bucketLabel, "BALANCED");
  assert.equal(mode.legSourceLabel, "Native");
});

test("NFLX — indisponible avec diagnostics frontières et fallbacks rejetés", () => {
  const candidate = makeCandidate({
    ticker: "NFLX",
    safeStrike: 66,
    aggressiveStrike: 68,
    safeYield: 0.65,
    aggressiveYield: 1.15,
    dteDays: 3,
    chain: [],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.UNAVAILABLE);
  assert.equal(engine.primaryReason, BALANCED_NATIVE_REASON_CODES.NO_FALLBACK);

  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.available, false);
  assert.ok(view.unavailableDiagnostics);
  assert.equal(view.unavailableDiagnostics.safeStrike, 66);
  assert.equal(view.unavailableDiagnostics.aggressiveStrike, 68);
  assert.equal(view.unavailableDiagnostics.midpointStrike, 67);
  assert.match(view.unavailableDiagnostics.safeFallbackRejection, /0\.65 % < minimum BALANCED 0\.70 %/);
  assert.match(view.unavailableDiagnostics.aggressiveFallbackRejection, /1\.15 % ≥ maximum BALANCED exclusif 1\.05 %/);
  assert.ok(view.unavailableDiagnostics.reasonCodes.includes(BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE));
});

test("NFLX — strike 67 valide devient BALANCED_NATIVE", () => {
  const candidate = makeCandidate({
    ticker: "NFLX",
    safeStrike: 66,
    aggressiveStrike: 68,
    safeYield: 0.65,
    aggressiveYield: 1.15,
    dteDays: 3,
    chain: [makeLeg(67, 0.82, { ticker: "NFLX", dteDays: 3 })],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedStrike, 67);
});

test("SMCI — sélections indépendantes BALANCED fallback SAFE et AGRESSIF", () => {
  const candidate = makeCandidate({
    ticker: "SMCI",
    safeStrike: 25.5,
    aggressiveStrike: 26,
    safeYield: 0.75,
    aggressiveYield: 1.08,
    dteDays: 3,
    chain: [],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  assert.equal(engine.selectedStrike, 25.5);

  const combos = combosFor([candidate]);
  const selection = resolvePortfolioSelectionByTicker(combos);
  const enriched = enrichCandidateRowForDisplay(withBalancedVm(candidate), selection);

  const balancedPick = combos.find((c) => c.label === "BALANCED")?.picks?.some((p) => p.ticker === "SMCI");
  const aggressivePick = combos.find((c) => c.label === "AGGRESSIVE")?.picks?.some((p) => p.ticker === "SMCI");
  if (balancedPick && aggressivePick) {
    assert.equal(enriched.selectedForBalanced, true);
    assert.equal(enriched.selectedForAggressive, true);
    // SAFE peut aussi sélectionner SMCI indépendamment si sa bande l'admet — pas lié au fallback BALANCED.
    assert.equal(typeof enriched.selectedForSafe, "boolean");
  }

  const balancedMode = resolveDashboardModePresentation(
    withBalancedVm({
      ...candidate,
      balancedCardViewModel: resolveBalancedCardViewModel({ candidate }),
    }),
    { modeFilter: "BALANCED" },
  );
  assert.equal(balancedMode.bucketLabel, "BALANCED");
  assert.equal(balancedMode.legSourceLabel, "Fallback SAFE");
  assert.equal(resolveDashboardModeForFilter(withBalancedVm(candidate)), "BALANCED");
});

test("états selected indépendants et formatters stables", () => {
  const selection = new Map([
    [
      "ABC",
      { selectedForSafe: true, selectedForBalanced: true, selectedForAggressive: false },
    ],
  ]);
  const row = enrichCandidateRowForDisplay({ ticker: "ABC" }, selection);
  assert.equal(row.selectedForSafe, true);
  assert.equal(row.selectedForBalanced, true);
  assert.equal(row.selectedForAggressive, false);

  const noPick = enrichCandidateRowForDisplay({ ticker: "ZZZ" }, selection);
  assert.equal(noPick.selectedForBalanced, false);
  assert.equal(formatAnnualizedSimpleYieldPct(undefined), "n/d");
  assert.equal(formatAnnualizedSimpleYieldPct(Number.NaN), "n/d");
  assert.equal(formatAnnualizedSimpleYieldPct(Number.POSITIVE_INFINITY), "n/d");
});

test("non-régression moteur — projection UI ne change pas la résolution BALANCED", () => {
  const candidate = makeCandidate({
    chain: [makeLeg(70, 0.7, { ticker: "TQQQ", dteDays: 3 })],
  });
  const before = structuredClone(candidate);
  const engineBefore = resolveBalancedLegSelection({ candidate });
  resolveBalancedCardViewModel({ candidate });
  const engineAfter = resolveBalancedLegSelection({ candidate });
  assert.deepEqual(candidate, before);
  assert.deepEqual(engineAfter, engineBefore);
  assert.equal(getLegPeriodYieldPct(engineAfter.selectedLeg, candidate), getLegPeriodYieldPct(engineBefore.selectedLeg, candidate));
});

test("initialisation Dashboard — ibkrRejectedSymbols avant combos sans ReferenceError", () => {
  const rejectedDecl = DASHBOARD_SOURCE.indexOf("const ibkrRejectedSymbols = useMemo");
  const combosDecl = DASHBOARD_SOURCE.indexOf("const combos = useMemo(() => {");
  assert.ok(rejectedDecl >= 0, "déclaration ibkrRejectedSymbols introuvable");
  assert.ok(combosDecl >= 0, "déclaration combos introuvable");
  assert.ok(
    rejectedDecl < combosDecl,
    "ibkrRejectedSymbols doit être déclaré avant combos pour éviter la TDZ",
  );
  assert.equal(
    (DASHBOARD_SOURCE.match(/const ibkrRejectedSymbols = useMemo/g) ?? []).length,
    1,
    "ibkrRejectedSymbols ne doit être déclaré qu'une fois",
  );

  const ibkrDirectResult = {
    rejected: [{ symbol: "SOFI" }],
  };
  const comboCandidateRows = [makeCandidate({ ticker: "TQQQ" })];
  const ibkrRejectedSymbols = new Set(
    (Array.isArray(ibkrDirectResult.rejected) ? ibkrDirectResult.rejected : [])
      .map((row) => String(row?.symbol || "").trim().toUpperCase())
      .filter(Boolean),
  );
  const combos = buildPortfolioCombos(
    comboCandidateRows,
    250000,
    100,
    10,
    ibkrRejectedSymbols,
    { optimizerV2: {} },
  );
  const portfolioSelectionByTicker = resolvePortfolioSelectionByTicker(combos);
  const displayComboCandidateRows = comboCandidateRows.map((item) => {
    const balancedCardViewModel = resolveBalancedCardViewModel({
      candidate: item,
      usableCapital: 250000,
      portfolioSelection: portfolioSelectionByTicker,
    });
    return enrichCandidateRowForDisplay(
      {
        ...item,
        balancedCardViewModel,
        capitalComboBucketMode: balancedCardViewModel.available ? "BALANCED" : null,
        balancedLegSource: balancedCardViewModel.source ?? null,
      },
      portfolioSelectionByTicker,
    );
  });

  assert.equal(ibkrRejectedSymbols.has("SOFI"), true);
  assert.equal(Array.isArray(displayComboCandidateRows), true);
  assert.equal(displayComboCandidateRows.length, 1);
});
