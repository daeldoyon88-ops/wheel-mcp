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
  test(`${index + 1} — marqueur debug absent du JSX : ${marker}`, () => {
    assert.ok(!faceplateColumn.includes(marker), `FaceplateStrikeColumn contient ${marker}`);
    assert.ok(!balancedColumn.includes(marker), `BalancedFaceplateStrikeColumn contient ${marker}`);
    assert.ok(!opportunities.includes(marker), `FaceplateStrikeOpportunities contient ${marker}`);
  });
}

test("9 — badge de recommandation conservé", () => {
  assert.ok(faceplateColumn.includes("Recommandée par le scan"));
  assert.ok(faceplateColumn.includes("hasSelection &&"));
});

test("10 — contour SAFE recommandé conservé", () => {
  assert.ok(faceplateColumn.includes('isScanRecommended && (selectedGrade === "A"'));
  assert.ok(faceplateColumn.includes("border-emerald-500 ring-2 ring-emerald-300/55"));
  assert.ok(opportunities.includes("isScanRecommended={isSafeScanRecommended}"));
});

test("11 — contour AGGRESSIVE recommandé conservé", () => {
  assert.ok(faceplateColumn.includes("border-amber-500 ring-2 ring-amber-300/55"));
  assert.ok(opportunities.includes("isScanRecommended={isAggressiveScanRecommended}"));
});

test("12 — portefeuille sans effet sur le contour", () => {
  assert.ok(!opportunities.includes("isScanRecommended={item.selectedFor"));
  assert.ok(opportunities.includes('portfolioBadges={isInSafePortfolio ? ["Portefeuille SAFE"] : []}'));
  assert.ok(opportunities.includes('portfolioBadges={isInAggressivePortfolio ? ["Portefeuille AGRESSIF"] : []}'));
  assert.ok(balancedColumn.includes("isScanRecommended={false}"));
});

test("13/14/15/16 — libellés Native, fallback et indisponible conservés", () => {
  assert.ok(balancedColumn.includes("vm.sourceLabel"));
  assert.ok(balancedColumn.includes("BALANCED indisponible"));
  assert.ok(balancedColumn.includes("Raison finale :"));
  assert.ok(balancedColumn.includes("diag.safeFallbackRejection"));
  assert.ok(balancedColumn.includes("diag.aggressiveFallbackRejection"));
  assert.ok(balancedColumn.includes("Diagnostics SAFE / AGRESSIF"));
});

test("17/18/19/20 — structure d'alignement vertical", () => {
  assert.ok(faceplateColumn.includes("flex h-full flex-col"));
  assert.ok(faceplateColumn.includes("flex flex-1 flex-col"));
  assert.ok(faceplateColumn.includes("mt-auto"));
  assert.ok(opportunities.includes("items-stretch"));
  assert.ok(opportunities.includes('className="h-full"'));
  assert.ok(balancedColumn.includes("flex h-full flex-col"));
});

test("21 — aucun footer technique réintroduit", () => {
  const banned = [
    "optionSymbol",
    "localSymbol",
    "conId",
    "contractId",
    "SAFE · Milieu · AGRESSIF",
    "BALANCED retenu",
    "Cible effective",
  ];
  for (const token of banned) {
    assert.ok(!faceplateColumn.includes(token), `footer technique : ${token}`);
    assert.ok(!balancedColumn.includes(token), `footer technique : ${token}`);
  }
});

test("22 — métriques principales conservées", () => {
  const required = [
    "Prime utilisée",
    "Rendement",
    "Rend. 7J",
    "Annualisé 7J",
    "Distance",
    "POP estimée",
    "DTE",
    "Marché live",
    "Bid",
    "Ask",
    "Mid",
    "Spread",
    "Grade réel",
  ];
  for (const label of required) {
    assert.ok(
      faceplateColumn.includes(label) || balancedColumn.includes(label),
      `métrique manquante : ${label}`,
    );
  }
});

test("helpers — sémantique scan inchangée malgré le nettoyage UI", () => {
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
