import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  enrichCandidateRowForDisplay,
  resolveAggressiveLegDisplayGrade,
  resolveBalancedCardViewModel,
  resolveDashboardModePresentation,
  resolvePortfolioSelectionByTicker,
  resolveSafeLegDisplayGrade,
  resolveScanRecommendationSemantics,
} from "./balancedModeUi.js";
import {
  BALANCED_LEG_SOURCES,
  BALANCED_NATIVE_REASON_CODES,
  buildPortfolioCombos,
  getFinalDisplayRecommendation,
  resolveBalancedLegSelection,
} from "./capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");
const BALANCED_MODE_UI = fs.readFileSync(path.join(__dirname, "balancedModeUi.js"), "utf8");

const EXPIRATION = "2026-07-31";

function askForSpread(bid, spreadPct = 8) {
  return bid * (spreadPct + 200) / (200 - spreadPct);
}

function makeLeg(strike, periodYieldPct, {
  ticker = "TQQQ",
  dteDays = 3,
  spreadPct = 8,
  distancePct = -8,
  pop = 0.9,
  expiration = EXPIRATION,
  optionSymbol = `${ticker}-${strike}-P`,
  conId = Math.round(strike * 10),
} = {}) {
  const bid = (strike * periodYieldPct) / 100;
  const ask = askForSpread(bid, spreadPct);
  return {
    ticker,
    symbol: ticker,
    expiration,
    right: "PUT",
    optionType: "PUT",
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    premiumUsed: bid,
    dteDays,
    distancePct,
    weeklyYield: periodYieldPct,
    popProfitEstimated: pop,
    volume: 500,
    openInterest: 1000,
    optionSymbol,
    conId,
    contractId: conId * 10,
    quoteTimestamp: "2026-07-14T15:00:00Z",
    marketDataType: "live",
    quoteSource: "IBKR",
    liquidity: { spreadPct },
  };
}

function makeCandidate({
  ticker = "TQQQ",
  price = 100,
  safeStrike = 69,
  aggressiveStrike = 72,
  safeYield = 0.55,
  aggressiveYield = 1.14,
  safeGrade = "A",
  aggressiveGrade = "A",
  safeSpreadPct = 8,
  aggressiveSpreadPct = 8,
  dteDays = 3,
  chain = [],
  chainAvailable = true,
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
      optionSymbol: `${ticker}-SAFE`,
    }),
    aggressiveStrike: makeLeg(aggressiveStrike, aggressiveYield, {
      ticker,
      dteDays,
      spreadPct: aggressiveSpreadPct,
      optionSymbol: `${ticker}-AGG`,
    }),
    safeGrade,
    aggressiveGrade,
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

function withBalancedVm(row, portfolioSelection = null) {
  const vm = resolveBalancedCardViewModel({ candidate: row, portfolioSelection });
  return {
    ...row,
    balancedCardViewModel: vm,
    balancedLegSource: vm.source,
    capitalComboBucketMode: vm.available ? "BALANCED" : null,
  };
}

function membershipMap(ticker, { safe = false, balanced = false, aggressive = false } = {}) {
  return new Map([
    [
      ticker,
      {
        selectedForSafe: safe,
        selectedForBalanced: balanced,
        selectedForAggressive: aggressive,
      },
    ],
  ]);
}

// Fixtures des cas exacts de l'audit -----------------------------------------

// NFLX : SAFE 66 (0,65 %), AGGRESSIVE 68 (1,15 %, spread 2,5 %), milieu 67,
// bande BALANCED 3 DTE 0,70 % inclusif – 1,05 % exclusif.
function makeNflx({ chain = [] } = {}) {
  return makeCandidate({
    ticker: "NFLX",
    price: 74,
    safeStrike: 66,
    aggressiveStrike: 68,
    safeYield: 0.65,
    aggressiveYield: 1.15,
    aggressiveSpreadPct: 2.5,
    dteDays: 3,
    chain,
  });
}

// INTC : SAFE 97,5 (0,69 %), BALANCED native 99 (0,90 %), AGGRESSIVE 102
// (1,51 %, spread 8,7 %).
function makeIntc() {
  return makeCandidate({
    ticker: "INTC",
    price: 110,
    safeStrike: 97.5,
    aggressiveStrike: 102,
    safeYield: 0.69,
    aggressiveYield: 1.51,
    aggressiveSpreadPct: 8.7,
    dteDays: 3,
    chain: [makeLeg(99, 0.9, { ticker: "INTC", dteDays: 3, optionSymbol: "INTC-99-P" })],
  });
}

// SMCI : SAFE 25,50 (0,75 %), AGGRESSIVE 26 (1,08 %), aucun strike
// intermédiaire → BALANCED fallback SAFE.
function makeSmci() {
  return makeCandidate({
    ticker: "SMCI",
    price: 28,
    safeStrike: 25.5,
    aggressiveStrike: 26,
    safeYield: 0.75,
    aggressiveYield: 1.08,
    dteDays: 3,
    chain: [],
  });
}

// 1–6 : contour vert = recommandation du scan, jamais les portefeuilles ------

test("1/2 — isScanRecommended dépend du scan, jamais de l'appartenance portefeuille", () => {
  const row = makeSmci();
  const scan = getFinalDisplayRecommendation(row);
  assert.equal(scan.finalDisplayMode, "AGGRESSIVE");

  const noPortfolio = resolveScanRecommendationSemantics(row);
  assert.equal(noPortfolio.isAggressiveScanRecommended, true);
  assert.equal(noPortfolio.isSafeScanRecommended, false);
  assert.equal(noPortfolio.isBalancedScanRecommended, false);

  const enriched = enrichCandidateRowForDisplay(
    row,
    membershipMap("SMCI", { safe: true, balanced: true, aggressive: false }),
  );
  const withPortfolio = resolveScanRecommendationSemantics(enriched);
  // Les appartenances ne modifient pas la recommandation du scan.
  assert.equal(withPortfolio.isAggressiveScanRecommended, true);
  assert.equal(withPortfolio.isSafeScanRecommended, false);
  assert.equal(withPortfolio.isInSafePortfolio, true);
  assert.equal(withPortfolio.isInBalancedPortfolio, true);
  assert.equal(withPortfolio.isInAggressivePortfolio, false);
});

test("3 — présent dans BALANCED et AGGRESSIVE ≠ deux contours", () => {
  const enriched = enrichCandidateRowForDisplay(
    makeSmci(),
    membershipMap("SMCI", { balanced: true, aggressive: true }),
  );
  const semantics = resolveScanRecommendationSemantics(enriched);
  const recommendedFlags = [
    semantics.isSafeScanRecommended,
    semantics.isBalancedScanRecommended,
    semantics.isAggressiveScanRecommended,
  ].filter(Boolean);
  assert.equal(recommendedFlags.length, 1, "une seule jambe recommandée par le scan");
  assert.equal(semantics.isAggressiveScanRecommended, true);
});

test("4 — jambe recommandée garde son contour même hors de tout portefeuille", () => {
  const enriched = enrichCandidateRowForDisplay(makeIntc(), new Map());
  const semantics = resolveScanRecommendationSemantics(enriched);
  assert.equal(semantics.isInSafePortfolio, false);
  assert.equal(semantics.isInBalancedPortfolio, false);
  assert.equal(semantics.isInAggressivePortfolio, false);
  assert.equal(semantics.isAggressiveScanRecommended, true);
});

test("5 — ticker absent des portefeuilles peut avoir une recommandation", () => {
  const semantics = resolveScanRecommendationSemantics(makeNflx());
  assert.equal(semantics.scanRecommendationMode, "AGGRESSIVE");
  assert.equal(semantics.portfolioMembershipLabels.length, 0);
});

test("6 — trois portefeuilles, une seule recommandation de scan", () => {
  const enriched = enrichCandidateRowForDisplay(
    makeSmci(),
    membershipMap("SMCI", { safe: true, balanced: true, aggressive: true }),
  );
  const semantics = resolveScanRecommendationSemantics(enriched);
  assert.deepEqual(semantics.portfolioMembershipLabels, ["SAFE", "BALANCED", "AGRESSIF"]);
  const recommendedFlags = [
    semantics.isSafeScanRecommended,
    semantics.isBalancedScanRecommended,
    semantics.isAggressiveScanRecommended,
  ].filter(Boolean);
  assert.equal(recommendedFlags.length, 1);
});

// 7–12 : SMCI -----------------------------------------------------------------

test("7/8 — SMCI : BALANCED fallback SAFE valide et AGGRESSIVE valide", () => {
  const candidate = makeSmci();
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  assert.equal(engine.selectedStrike, 25.5);

  const scan = getFinalDisplayRecommendation(candidate);
  assert.equal(scan.finalDisplayMode, "AGGRESSIVE");
  assert.equal(scan.finalDisplayGrade, "A");
});

test("9/10/11/12 — SMCI : appartenances séparées, contour unique piloté par le scan", () => {
  const enriched = enrichCandidateRowForDisplay(
    withBalancedVm(makeSmci()),
    membershipMap("SMCI", { balanced: true, aggressive: true }),
  );
  assert.equal(enriched.selectedForBalanced, true);
  assert.equal(enriched.selectedForAggressive, true);
  assert.equal(enriched.selectedForSafe, false);

  const semantics = resolveScanRecommendationSemantics(enriched);
  // Contour : uniquement la jambe AGGRESSIVE recommandée par le scan.
  assert.equal(semantics.isAggressiveScanRecommended, true);
  assert.equal(semantics.isSafeScanRecommended, false);
  assert.equal(semantics.isBalancedScanRecommended, false);
  // Appartenances affichées séparément (badges secondaires).
  assert.deepEqual(semantics.portfolioMembershipLabels, ["BALANCED", "AGRESSIF"]);
});

// 13–18 : INTC ----------------------------------------------------------------

test("13/14/15/16 — INTC : SAFE 97,5, BALANCED native 99, AGGRESSIVE 102, recommandation scan", () => {
  const candidate = makeIntc();
  assert.equal(candidate.safeStrike.strike, 97.5);
  assert.equal(candidate.aggressiveStrike.strike, 102);

  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedStrike, 99);

  const scan = getFinalDisplayRecommendation(candidate);
  assert.equal(scan.finalDisplayMode, "AGGRESSIVE");
  assert.equal(scan.finalDisplayGrade, "A");
});

test("17/18 — INTC : contour sur la jambe recommandée seulement, BALANCED native visible sans contour", () => {
  const row = withBalancedVm(makeIntc());
  const semantics = resolveScanRecommendationSemantics(row);
  assert.equal(semantics.isAggressiveScanRecommended, true);
  assert.equal(semantics.isSafeScanRecommended, false);
  assert.equal(semantics.isBalancedScanRecommended, false);

  // La jambe BALANCED native reste visible/valide (état « disponible »)…
  const balancedPresentation = resolveDashboardModePresentation(row, { modeFilter: "BALANCED" });
  assert.equal(balancedPresentation.bucketMode, "BALANCED");
  assert.equal(balancedPresentation.status, "available");
  assert.equal(balancedPresentation.isScanRecommended, false);
  // …tandis que la jambe recommandée porte l'état « recommended ».
  const scanPresentation = resolveDashboardModePresentation(row, { modeFilter: "all" });
  assert.equal(scanPresentation.bucketMode, "AGGRESSIVE");
  assert.equal(scanPresentation.status, "recommended");
  assert.equal(scanPresentation.isScanRecommended, true);
});

// 19–27 : NFLX — mode/grade cohérents et diagnostics séparés -------------------

test("19/20/33 — mode et grade viennent de la même jambe : AGGRESSIVE effective A jamais AGRESSIF REJET", () => {
  // Grade brut REJECT sur la jambe AGGRESSIVE, mais métriques (1,15 %,
  // spread 2,5 %, POP 90, distance −8) = grade prioritaire A — le cas exact
  // « AGRESSIF REJET » observé sur NFLX/INTC.
  const row = { ...makeNflx(), aggressiveGrade: "REJECT" };
  const scan = getFinalDisplayRecommendation(row);
  assert.equal(scan.finalDisplayMode, "AGGRESSIVE");
  assert.equal(scan.finalDisplayGrade, "A");

  const presentation = resolveDashboardModePresentation(row, { modeFilter: "all" });
  assert.equal(presentation.bucketMode, "AGGRESSIVE");
  assert.equal(presentation.bucketLabel, "AGRESSIF");
  assert.equal(presentation.grade, "A", "le grade affiché doit être celui de la jambe affichée");
  assert.notEqual(presentation.grade, "REJECT");
  assert.equal(presentation.leg, row.aggressiveStrike);
});

test("21 — jambe réellement rejetée : mode/statut corrects avec raison vérifiable", () => {
  // Deux jambes hors critères : spreads extrêmes → REJECT canonique.
  const row = makeCandidate({
    ticker: "NFLX",
    safeYield: 0.2,
    aggressiveYield: 0.2,
    safeSpreadPct: 60,
    aggressiveSpreadPct: 60,
    safeGrade: "REJECT",
    aggressiveGrade: "REJECT",
  });
  const scan = getFinalDisplayRecommendation(row);
  assert.equal(scan.finalDisplayMode, "REJECT");
  const presentation = resolveDashboardModePresentation(row, { modeFilter: "all" });
  assert.equal(presentation.bucketMode, "REJECT");
  assert.equal(presentation.status, "unavailable");
});

test("22/24/25/26 — diagnostics NFLX : native ≠ fallbacks ≠ finale, NO_FALLBACK jamais natif", () => {
  const candidate = makeNflx({ chain: [] });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.UNAVAILABLE);
  assert.equal(engine.primaryReason, BALANCED_NATIVE_REASON_CODES.NO_FALLBACK);
  // La raison native est conservée séparément par le moteur.
  assert.equal(
    engine.diagnostics?.nativePrimaryReason,
    BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE,
  );

  const view = resolveBalancedCardViewModel({ candidate });
  const diag = view.unavailableDiagnostics;
  assert.ok(diag);
  // 24 — NO_BALANCED_FALLBACK_ELIGIBLE n'est jamais présenté comme raison native.
  assert.notEqual(diag.nativePrimaryReason, BALANCED_NATIVE_REASON_CODES.NO_FALLBACK);
  assert.equal(diag.nativePrimaryReason, BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE);
  assert.equal(diag.native.primaryReason, BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE);
  // Raison finale distincte.
  assert.equal(diag.final.reason, BALANCED_NATIVE_REASON_CODES.NO_FALLBACK);
  assert.equal(view.primaryReason, BALANCED_NATIVE_REASON_CODES.NO_FALLBACK);
  assert.equal(view.nativePrimaryReason, BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE);
  // 25 — fallback SAFE 0,65 % rejeté sous 0,70 % inclusif.
  assert.equal(diag.fallbackSafe.status, "rejected");
  assert.match(diag.fallbackSafe.reason, /0\.65 % < minimum BALANCED 0\.70 %/);
  // 26 — fallback AGGRESSIVE 1,15 % rejeté au-dessus de 1,05 % exclusif.
  assert.equal(diag.fallbackAggressive.status, "rejected");
  assert.match(diag.fallbackAggressive.reason, /1\.15 % ≥ maximum BALANCED exclusif 1\.05 %/);
});

test("23 — strike intermédiaire dans bande mais filtre postérieur : compteurs et raison exacts", () => {
  // Strike 67 dans la bande mais spread 25 % > 20 % : « dans bande : 1 » doit
  // s'accompagner de la raison réelle (spread), et « pleinement admissible » = 0.
  const candidate = makeNflx({
    chain: [makeLeg(67, 0.82, { ticker: "NFLX", dteDays: 3, spreadPct: 25 })],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.UNAVAILABLE);
  assert.equal(engine.intermediateContractCount, 1);
  assert.equal(engine.quoteValidIntermediateCount, 1);
  assert.equal(engine.yieldEligibleIntermediateCount, 1);
  assert.equal(engine.fullyEligibleIntermediateCount, 0);
  assert.equal(
    engine.diagnostics?.nativePrimaryReason,
    BALANCED_NATIVE_REASON_CODES.FAILED_SPREAD,
  );

  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.unavailableDiagnostics.nativePrimaryReason, BALANCED_NATIVE_REASON_CODES.FAILED_SPREAD);
  assert.equal(view.unavailableDiagnostics.native.fullyEligibleIntermediateCount, 0);

  // Un contrat sur une autre expiration n'entre pas dans les compteurs.
  const otherExpiration = makeNflx({
    chain: [makeLeg(67, 0.82, { ticker: "NFLX", dteDays: 3, expiration: "2026-08-07" })],
  });
  const engineOther = resolveBalancedLegSelection({ candidate: otherExpiration });
  assert.equal(engineOther.intermediateContractCount, 0);
  assert.equal(engineOther.fullyEligibleIntermediateCount, 0);
});

test("23bis/27 — fullyEligible > 0 ⇒ native sélectionnée ; aucun contrat synthétique", () => {
  const candidate = makeNflx({
    chain: [makeLeg(67, 0.82, { ticker: "NFLX", dteDays: 3, optionSymbol: "NFLX-67-P" })],
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedStrike, 67);
  assert.ok(engine.fullyEligibleIntermediateCount > 0);
  // 27 — la jambe retenue est le contrat réel de la chaîne, pas une synthèse.
  assert.equal(engine.selectedLeg.optionSymbol, "NFLX-67-P");
  assert.equal(engine.selectedLeg.conId, candidate.balancedPutCandidates[0].conId);
});

// 28–34 : classement principal -------------------------------------------------

test("28-32 — mode, grade, strike, prime et rendement proviennent de la jambe affichée", () => {
  const row = makeIntc();
  const presentation = resolveDashboardModePresentation(row, { modeFilter: "all" });
  assert.equal(presentation.mode, "AGGRESSIVE");
  assert.equal(presentation.leg, row.aggressiveStrike);
  assert.equal(presentation.strike, row.aggressiveStrike.strike);
  assert.equal(presentation.premium, row.aggressiveStrike.premiumUsed);
  assert.equal(presentation.periodYieldPct, row.aggressiveStrike.weeklyYield);
  assert.equal(presentation.spreadPct, row.aggressiveStrike.liquidity.spreadPct);
  assert.equal(presentation.grade, getFinalDisplayRecommendation(row).finalDisplayGrade);

  const safeForced = resolveDashboardModePresentation(row, { modeFilter: "SAFE" });
  assert.equal(safeForced.leg, row.safeStrike);
  assert.equal(safeForced.strike, row.safeStrike.strike);
  assert.equal(safeForced.grade, resolveSafeLegDisplayGrade(row));
});

test("33bis — jambe AGGRESSIVE grade B (spread 8,7 % ≤ 15) reste AGRESSIF A/B, jamais REJET", () => {
  const row = { ...makeIntc(), aggressiveGrade: "REJECT" };
  const grade = resolveAggressiveLegDisplayGrade(row);
  assert.equal(grade, "A", "spread 8,7 ≤ 15 avec rendement 1,51 → grade prioritaire A");
  const presentation = resolveDashboardModePresentation(row, { modeFilter: "all" });
  assert.equal(`${presentation.bucketLabel} ${presentation.grade}`, "AGRESSIF A");
});

test("34 — Top exécutables (grade effectif A/B) jamais présenté REJET sans raison canonique", () => {
  // Même règle d'admission que getCreamQualityBucket : mode SAFE/AGGRESSIVE et
  // grade effectif A/B ⇒ Top exécutables. La présentation doit refléter le
  // même grade — aucun mélange avec le grade brut d'un autre objet.
  const row = { ...makeNflx(), aggressiveGrade: "REJECT" };
  const scan = getFinalDisplayRecommendation(row);
  const isTopExecutable =
    (scan.finalDisplayMode === "SAFE" || scan.finalDisplayMode === "AGGRESSIVE") &&
    (scan.finalDisplayGrade === "A" || scan.finalDisplayGrade === "B");
  assert.equal(isTopExecutable, true);
  const presentation = resolveDashboardModePresentation(row, { modeFilter: "all" });
  assert.notEqual(presentation.grade, "REJECT");
  assert.equal(presentation.grade, scan.finalDisplayGrade);
});

// 35–41 : états visuels ---------------------------------------------------------

test("35/36/37 — recommandé → recommended ; disponible → available ; indisponible → unavailable", () => {
  const row = withBalancedVm(makeIntc());
  assert.equal(resolveDashboardModePresentation(row, { modeFilter: "all" }).status, "recommended");
  assert.equal(resolveDashboardModePresentation(row, { modeFilter: "SAFE" }).status, "available");
  assert.equal(resolveDashboardModePresentation(row, { modeFilter: "BALANCED" }).status, "available");

  const rejected = makeCandidate({
    safeYield: 0.2,
    aggressiveYield: 0.2,
    safeSpreadPct: 60,
    aggressiveSpreadPct: 60,
    safeGrade: "REJECT",
    aggressiveGrade: "REJECT",
  });
  assert.equal(resolveDashboardModePresentation(rejected, { modeFilter: "all" }).status, "unavailable");
});

test("38/39/40/41 — chaque appartenance portefeuille est sans effet sur le contour", () => {
  const base = makeSmci();
  for (const memberships of [
    { safe: true },
    { balanced: true },
    { aggressive: true },
    { safe: true, balanced: true, aggressive: true },
  ]) {
    const enriched = enrichCandidateRowForDisplay(base, membershipMap("SMCI", memberships));
    const semantics = resolveScanRecommendationSemantics(enriched);
    assert.equal(semantics.isAggressiveScanRecommended, true, "le contour suit toujours le scan");
    assert.equal(semantics.isSafeScanRecommended, false);
    assert.equal(semantics.isBalancedScanRecommended, false);
  }
});

test("source dashboard.jsx — contour piloté par le scan, badges portefeuille secondaires", () => {
  const start = DASHBOARD.indexOf("function FaceplateStrikeOpportunities");
  const end = DASHBOARD.indexOf("function SupportStatusLine", start);
  const section = DASHBOARD.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(section.includes("resolveScanRecommendationSemantics(item)"));
  assert.ok(section.includes("isScanRecommended={isSafeScanRecommended}"));
  assert.ok(section.includes("isScanRecommended={isAggressiveScanRecommended}"));
  assert.ok(!section.includes("isScanRecommended={item.selectedFor"));
  assert.ok(!section.includes("isSelected={safeSelected}"));
  assert.ok(!section.includes("isSelected={aggressiveSelected}"));
  assert.ok(section.includes('portfolioBadges={isInSafePortfolio ? ["Portefeuille SAFE"] : []}'));
  assert.ok(section.includes('portfolioBadges={isInAggressivePortfolio ? ["Portefeuille AGRESSIF"] : []}'));

  const columnStart = DASHBOARD.indexOf("function FaceplateStrikeColumn");
  const columnEnd = DASHBOARD.indexOf("function BalancedFaceplateStrikeColumn", columnStart);
  const columnSection = DASHBOARD.slice(columnStart, columnEnd);
  // Le contour (ring émeraude/ambre) découle exclusivement de hasSelection,
  // lui-même dérivé de isScanRecommended.
  assert.ok(columnSection.includes('isScanRecommended && (selectedGrade === "A"'));
  assert.ok(columnSection.includes("Recommandée par le scan"));
  assert.ok(!columnSection.includes("Sélectionné dans SAFE"));
  assert.ok(!columnSection.includes("Sélectionné dans AGRESSIF"));

  const balancedStart = DASHBOARD.indexOf("function BalancedFaceplateStrikeColumn");
  const balancedEnd = DASHBOARD.indexOf("function MiniTradeLevelsChart", balancedStart);
  const balancedSection = DASHBOARD.slice(balancedStart, balancedEnd);
  // Cas A : la carte BALANCED n'a jamais le contour de recommandation.
  assert.ok(balancedSection.includes("isScanRecommended={false}"));
  assert.ok(balancedSection.includes("Raison finale :"));
});

// 42–50 : non-régression moteur --------------------------------------------------

test("42/43/44 — les picks SAFE/BALANCED/AGGRESSIVE sont identiques avec ou sans projection UI", () => {
  const candidates = [makeSmci(), makeIntc(), makeNflx()];
  const before = structuredClone(candidates);
  const combosBefore = buildPortfolioCombos(candidates, 250000, 100, 10, new Set(), { optimizerV2: {} });

  // Toute la chaîne de projection display s'exécute…
  const selection = resolvePortfolioSelectionByTicker(combosBefore);
  candidates.forEach((candidate) => {
    const enriched = enrichCandidateRowForDisplay(withBalancedVm(candidate, selection), selection);
    resolveDashboardModePresentation(enriched, { modeFilter: "all" });
    resolveDashboardModePresentation(enriched, { modeFilter: "BALANCED" });
    resolveScanRecommendationSemantics(enriched);
  });

  // …sans muter le pool canonique ni changer les picks.
  assert.deepEqual(candidates, before);
  const combosAfter = buildPortfolioCombos(candidates, 250000, 100, 10, new Set(), { optimizerV2: {} });
  for (const label of ["SAFE", "BALANCED", "AGGRESSIVE"]) {
    const picksBefore = combosBefore.find((c) => c.label === label)?.picks?.map((p) => `${p.ticker}:${p.strike}`);
    const picksAfter = combosAfter.find((c) => c.label === label)?.picks?.map((p) => `${p.ticker}:${p.strike}`);
    assert.deepEqual(picksAfter, picksBefore, `picks ${label} inchangés`);
  }
});

test("45/46/47/48 — scores, caps, greedy et politique DTE non touchés par la projection", () => {
  const candidate = makeIntc();
  const before = structuredClone(candidate);
  const engineBefore = resolveBalancedLegSelection({ candidate });
  const enriched = enrichCandidateRowForDisplay(withBalancedVm(candidate), new Map());
  resolveDashboardModePresentation(enriched, { modeFilter: "all" });
  const engineAfter = resolveBalancedLegSelection({ candidate });
  assert.deepEqual(candidate, before, "le candidat n'est pas muté");
  assert.deepEqual(engineAfter, engineBefore, "résolution moteur identique");
  assert.equal(candidate.proFinalScore, before.proFinalScore);
  assert.equal(engineAfter.dteDays, engineBefore.dteDays);
  assert.equal(engineAfter.effectivePeriodMinPct, engineBefore.effectivePeriodMinPct);
  assert.equal(engineAfter.effectivePeriodMaxPct, engineBefore.effectivePeriodMaxPct);
});

test("49 — aucune quote ni strike modifié : la présentation référence les jambes réelles", () => {
  const row = makeSmci();
  const presentation = resolveDashboardModePresentation(row, { modeFilter: "all" });
  assert.equal(presentation.leg, row.aggressiveStrike, "référence directe, pas de copie altérée");
  const safeForced = resolveDashboardModePresentation(row, { modeFilter: "SAFE" });
  assert.equal(safeForced.leg, row.safeStrike);

  const vm = resolveBalancedCardViewModel({ candidate: row });
  assert.equal(vm.optionSymbol, row.safeStrike.optionSymbol, "fallback SAFE = contrat SAFE réel");
});

test("50 — aucun appel réseau dans la couche de projection UI", () => {
  for (const banned of ["fetch(", "axios", "XMLHttpRequest", "WebSocket("]) {
    assert.ok(!BALANCED_MODE_UI.includes(banned), `balancedModeUi.js ne doit pas contenir ${banned}`);
  }
});
