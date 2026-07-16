import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  enrichCandidateRowForDisplay,
  resolveBalancedCardViewModel,
  resolveScanRecommendationSemantics,
} from "./balancedModeUi.js";
import {
  BALANCED_LEG_SOURCES,
  getFinalDisplayRecommendation,
} from "./capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");

function sectionBetween(startMarker, endMarker) {
  const start = DASHBOARD.indexOf(startMarker);
  const end = DASHBOARD.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} introuvable`);
  return DASHBOARD.slice(start, end);
}

const faceplateColumn = sectionBetween(
  "function FaceplateStrikeColumn",
  "function BalancedFaceplateStrikeColumn",
);
const balancedColumn = sectionBetween(
  "function BalancedFaceplateStrikeColumn",
  "function MiniTradeLevelsChart",
);
const opportunities = sectionBetween(
  "function FaceplateStrikeOpportunities",
  "function SupportStatusLine",
);

const balancedAvailableBranch = balancedColumn.slice(
  balancedColumn.indexOf("const strikeData = {"),
  balancedColumn.indexOf("// Carte BALANCED disponible : seules les métriques utilisateur"),
);

const DEBUG_MARKERS = [
  "cardMode=",
  "scanRecommendation=",
  "isScanRecommended=${",
  "safeRank=",
  "aggressiveRank=",
  "finalRank=",
  "underlyingLegMode=",
  "source=BALANCED_",
  "portefeuilles=",
  "debugLabel",
];

for (const [index, marker] of DEBUG_MARKERS.entries()) {
  test(`debug-${index + 1} — marqueur debug absent : ${marker}`, () => {
    assert.ok(!faceplateColumn.includes(marker), `FaceplateStrikeColumn contient ${marker}`);
    assert.ok(!balancedColumn.includes(marker), `BalancedFaceplateStrikeColumn contient ${marker}`);
    assert.ok(!opportunities.includes(marker), `FaceplateStrikeOpportunities contient ${marker}`);
  });
}

test("1 — badge « Recommandée par le scan » n'est plus rendu", () => {
  assert.ok(!faceplateColumn.includes("selectionBadgeClass"));
  assert.ok(!faceplateColumn.includes("selectionBadgeLabel"));
  assert.ok(!faceplateColumn.match(/<Badge[\s\S]{0,200}Recommandée par le scan/));
  assert.ok(faceplateColumn.includes("selectionAriaLabel"));
});

test("2 — grades [A]/[B]/[WATCH] ne sont plus ajoutés dans un badge visible", () => {
  assert.ok(!faceplateColumn.includes("[${selectedGrade}]"));
  assert.ok(faceplateColumn.includes("selectionAriaLabel"));
});

test("3 — contour SAFE recommandé reste actif", () => {
  assert.ok(faceplateColumn.includes('isScanRecommended && (selectedGrade === "A"'));
  assert.ok(faceplateColumn.includes("border-emerald-500 ring-2 ring-emerald-300/55"));
  assert.ok(opportunities.includes("isScanRecommended={isSafeScanRecommended}"));
});

test("4 — contour AGGRESSIVE recommandé reste actif", () => {
  assert.ok(opportunities.includes("isScanRecommended={isAggressiveScanRecommended}"));
});

test("5 — contour WATCH reste ambre", () => {
  assert.ok(faceplateColumn.includes("border-amber-500 ring-2 ring-amber-300/55"));
  assert.ok(faceplateColumn.includes('selectedGrade === "WATCH"'));
});

test("6 — jambe non recommandée garde le contour normal", () => {
  assert.ok(faceplateColumn.includes("const selectionBorder = !hasSelection"));
  assert.ok(faceplateColumn.includes("? border"));
});

test("7 — badge PUT reste visible", () => {
  assert.ok(faceplateColumn.includes("border-slate-700 bg-slate-950/80"));
  assert.ok(faceplateColumn.includes("PUT"));
});

test("8 — badges portefeuille restent indépendants du contour", () => {
  assert.ok(!opportunities.includes("isScanRecommended={item.selectedFor"));
  assert.ok(opportunities.includes('portfolioBadges={isInSafePortfolio ? ["Portefeuille SAFE"] : []}'));
  assert.ok(opportunities.includes('portfolioBadges={isInAggressivePortfolio ? ["Portefeuille AGRESSIF"] : []}'));
  assert.ok(balancedColumn.includes("vm.selectedForBalanced === true"));
});

for (const [num, label] of [
  ["9", "Grade réel"],
  ["10", "Expiration"],
  ["11", "Capital requis"],
  ["12", "Source quote"],
]) {
  test(`${num} — « ${label} » absent de la carte BALANCED disponible`, () => {
    assert.ok(!balancedAvailableBranch.includes(`label: "${label}"`), `carte disponible contient ${label}`);
    assert.ok(!balancedAvailableBranch.includes(label), `carte disponible contient ${label}`);
  });
}

test("13 — valeurs techniques restent dans le view model interne", () => {
  const EXPIRATION = "2026-07-31";
  const makeLeg = (strike, periodYieldPct, ticker = "ORCL") => {
    const bid = (strike * periodYieldPct) / 100;
    const ask = bid * 1.08;
    return {
      ticker,
      symbol: ticker,
      expiration: EXPIRATION,
      right: "PUT",
      strike,
      bid,
      ask,
      mid: (bid + ask) / 2,
      dteDays: 3,
      distancePct: -8,
      popProfitEstimated: 0.9,
      volume: 500,
      openInterest: 1000,
      quoteSource: "IBKR",
      marketDataType: "live",
    };
  };
  const candidate = {
    ticker: "ORCL",
    symbol: "ORCL",
    targetExpiration: EXPIRATION,
    dteDays: 3,
    price: 120,
    safeStrike: makeLeg(110, 0.7),
    aggressiveStrike: makeLeg(118, 1.1),
    safeGrade: "A",
    aggressiveGrade: "A",
    balancedPutChainAvailable: true,
    balancedPutCandidates: [makeLeg(116, 0.9)],
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 0.8,
  };
  const vm = resolveBalancedCardViewModel({ candidate });
  assert.equal(vm.available, true);
  assert.equal(vm.strike, 116);
  assert.ok(vm.grade);
  assert.equal(vm.expiration, EXPIRATION);
  assert.ok(vm.capitalRequired != null);
  assert.equal(vm.quoteSource, "IBKR");
});

for (const [num, label] of [
  ["14", "Strike"],
  ["15", "Prime utilisée"],
  ["16", "Rendement"],
  ["17", "Rend. 7J"],
  ["18", "Annualisé 7J"],
  ["19", "Distance"],
  ["20", "POP estimée"],
  ["21", "DTE"],
  ["22", "Marché live"],
]) {
  test(`${num} — métrique « ${label} » conservée`, () => {
    assert.ok(
      faceplateColumn.includes(label) || balancedColumn.includes(label),
      `métrique manquante : ${label}`,
    );
  });
}

test("23/24/25 — Native, Fallback SAFE et Fallback AGRESSIF conservés", () => {
  assert.ok(balancedColumn.includes("vm.sourceLabel"));
  assert.ok(balancedColumn.includes('title="BALANCED"'));
});

test("26 — BALANCED indisponible reste fonctionnel", () => {
  assert.ok(balancedColumn.includes("BALANCED indisponible"));
  assert.ok(balancedColumn.includes("Raison finale :"));
  assert.ok(balancedColumn.includes("Diagnostics SAFE / AGRESSIF"));
});

test("27/28 — alignement vertical conservé", () => {
  assert.ok(faceplateColumn.includes("flex h-full flex-col"));
  assert.ok(faceplateColumn.includes("flex flex-1 flex-col"));
  assert.ok(faceplateColumn.includes("mt-auto"));
  assert.ok(opportunities.includes("items-stretch"));
  assert.ok(opportunities.includes('className="h-full"'));
});

test("29 — aucun footer technique réintroduit", () => {
  const banned = [
    "optionSymbol",
    "localSymbol",
    "conId",
    "contractId",
    "SAFE · Milieu · AGRESSIF",
    "BALANCED retenu",
    "Cible effective",
    "extraMetricRows",
  ];
  for (const token of banned) {
    assert.ok(!faceplateColumn.includes(token), `footer technique : ${token}`);
    assert.ok(!balancedAvailableBranch.includes(token), `footer technique : ${token}`);
  }
});

test("30 — sémantique scan et moteur inchangés", () => {
  const EXPIRATION = "2026-07-31";
  const makeLeg = (strike, periodYieldPct, ticker = "SMCI") => {
    const bid = (strike * periodYieldPct) / 100;
    const ask = bid * 1.08;
    return {
      ticker,
      symbol: ticker,
      expiration: EXPIRATION,
      right: "PUT",
      strike,
      bid,
      ask,
      mid: (bid + ask) / 2,
      premiumUsed: bid,
      dteDays: 3,
      distancePct: -8,
      weeklyYield: periodYieldPct,
      weeklyNormalizedYield: periodYieldPct * (3 / 7),
      popProfitEstimated: 0.9,
      liquidity: { spreadPct: 8 },
    };
  };
  const candidate = {
    ticker: "SMCI",
    symbol: "SMCI",
    targetExpiration: EXPIRATION,
    dteDays: 3,
    price: 28,
    safeStrike: makeLeg(25.5, 0.75),
    aggressiveStrike: makeLeg(26, 1.08),
    safeGrade: "A",
    aggressiveGrade: "A",
    balancedPutChainAvailable: true,
    balancedPutCandidates: [],
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 0.8,
  };
  const vm = resolveBalancedCardViewModel({ candidate });
  const enriched = enrichCandidateRowForDisplay(
    { ...candidate, balancedCardViewModel: vm, balancedLegSource: vm.source },
    new Map(),
  );
  const semantics = resolveScanRecommendationSemantics(enriched);
  const recommendation = getFinalDisplayRecommendation(enriched);

  assert.equal(vm.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  assert.equal(vm.sourceLabel, "Fallback SAFE");
  assert.equal(recommendation.finalDisplayMode, "AGGRESSIVE");
  assert.equal(semantics.isAggressiveScanRecommended, true);
  assert.equal(semantics.isSafeScanRecommended, false);
});
