import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DASHBOARD_MODE_FILTER_OPTIONS,
  resolveBalancedCardViewModel,
  resolveDashboardModeForFilter,
} from "./balancedModeUi.js";
import { rowMatchesModeFilter } from "./capitalComboInputPool.js";
import {
  BALANCED_LEG_SOURCES,
  getLegPeriodYieldPct,
  getLegSpreadPct,
  getLegWeeklyNormalizedYieldPct,
  resolveBalancedLegSelection,
  resolveCapitalComboInspectorLegView,
} from "./capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");
const EXPIRATION = "2026-07-31";

function askForSpread(bid, spreadPct = 8) {
  return bid * (spreadPct + 200) / (200 - spreadPct);
}

function makeLeg(strike, periodYieldPct, {
  ticker = "TQQQ",
  spreadPct = 8,
  optionSymbol = `${ticker}-${strike}-P`,
  conId = strike * 10,
  contractId = strike * 100,
  quoteSource = "IBKR",
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
    dteDays: 7,
    distancePct: -8,
    popProfitEstimated: 0.9,
    volume: 500,
    openInterest: 1000,
    optionSymbol,
    conId,
    contractId,
    quoteTimestamp: "2026-07-14T15:00:00Z",
    marketDataType: "live",
    quoteSource,
  };
}

function makeCandidate({
  ticker = "TQQQ",
  safeYield = 0.74,
  aggressiveYield = 1,
  chain = [],
  chainAvailable = true,
} = {}) {
  return {
    ticker,
    symbol: ticker,
    targetExpiration: EXPIRATION,
    dteDays: 7,
    price: 100,
    safeStrike: makeLeg(67, safeYield, { ticker, optionSymbol: `${ticker}-SAFE` }),
    aggressiveStrike: makeLeg(75, aggressiveYield, {
      ticker,
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

test("UI-01 — options Mode dans l'ordre Tous, SAFE, BALANCED, AGRESSIF", () => {
  assert.deepEqual(DASHBOARD_MODE_FILTER_OPTIONS, [
    { value: "all", label: "Mode: Tous" },
    { value: "SAFE", label: "Mode: SAFE" },
    { value: "BALANCED", label: "Mode: BALANCED" },
    { value: "AGGRESSIVE", label: "Mode: AGRESSIF" },
  ]);
  assert.equal(
    (DASHBOARD.match(/DASHBOARD_MODE_FILTER_OPTIONS\.map/g) ?? []).length,
    1,
    "la source canonique des options ne doit être rendue qu'une fois",
  );
});

test("UI-02 à UI-10 — filtre bucket BALANCED sans fuite vers SAFE/AGGRESSIVE", () => {
  const safe = {
    ticker: "SAFE",
    capitalComboBucketMode: "SAFE",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
  };
  const aggressive = {
    ticker: "AGG",
    capitalComboBucketMode: "AGGRESSIVE",
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: "A",
  };
  const native = {
    ticker: "NATIVE",
    finalDisplayMode: "SAFE",
    balancedLegSource: BALANCED_LEG_SOURCES.NATIVE,
  };
  const fallbackSafe = {
    ticker: "FB_SAFE",
    finalDisplayMode: "SAFE",
    balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_SAFE,
  };
  const fallbackAggressive = {
    ticker: "FB_AGG",
    finalDisplayMode: "AGGRESSIVE",
    balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
  };
  const rows = [safe, aggressive, native, fallbackSafe, fallbackAggressive];

  assert.deepEqual(
    rows.filter((row) => rowMatchesModeFilter(row, "BALANCED")).map((row) => row.ticker),
    ["NATIVE", "FB_SAFE", "FB_AGG"],
  );
  assert.deepEqual(
    rows.filter((row) => rowMatchesModeFilter(row, "SAFE")).map((row) => row.ticker),
    ["SAFE"],
  );
  assert.deepEqual(
    rows.filter((row) => rowMatchesModeFilter(row, "AGGRESSIVE")).map((row) => row.ticker),
    ["AGG"],
  );
  assert.equal(rows.filter((row) => rowMatchesModeFilter(row, "all")).length, 5);
  assert.equal(resolveDashboardModeForFilter(fallbackSafe), "BALANCED");
  assert.equal(resolveDashboardModeForFilter(fallbackAggressive), "BALANCED");
});

test("UI-11/UI-12/UI-18/UI-21 — native conserve données, frontières, DTE et cible moteur", () => {
  const nativeLeg = makeLeg(71, 0.875, {
    optionSymbol: "TQQQ-NATIVE-71",
    conId: 71001,
    contractId: 71002,
  });
  const candidate = makeCandidate({ chain: [nativeLeg] });
  const before = structuredClone(candidate);
  const engine = resolveBalancedLegSelection({ candidate });
  const inspector = resolveCapitalComboInspectorLegView({
    bucketKey: "BALANCED",
    candidate,
  });
  const view = resolveBalancedCardViewModel({ candidate });

  assert.equal(view.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(view.sourceLabel, "Native");
  assert.equal(view.badgeLabel, null);
  assert.equal(view.strike, engine.selectedStrike);
  assert.equal(view.premium, engine.selectedLeg.premiumUsed);
  assert.equal(view.periodYieldPct, getLegPeriodYieldPct(engine.selectedLeg, candidate));
  assert.equal(
    view.weeklyNormalizedYieldPct,
    getLegWeeklyNormalizedYieldPct(engine.selectedLeg, candidate),
  );
  assert.equal(view.spreadPct, getLegSpreadPct(engine.selectedLeg));
  assert.equal(view.grade, inspector.selectedGrade);
  assert.equal(view.optionSymbol, "TQQQ-NATIVE-71");
  assert.equal(view.conId, 71001);
  assert.equal(view.contractId, 71002);
  assert.equal(view.safeStrike, 67);
  assert.equal(view.aggressiveStrike, 75);
  assert.equal(view.midpointStrike, 71);
  assert.equal(view.dteDays, engine.dteDays);
  assert.equal(view.effectivePeriodMinPct, engine.effectivePeriodMinPct);
  assert.equal(view.effectivePeriodMaxPct, engine.effectivePeriodMaxPct);
  assert.deepEqual(candidate, before, "la projection UI ne doit pas muter le candidat");
});

test("UI-13/UI-19 — fallback SAFE garde les données SAFE mais le bucket BALANCED", () => {
  const candidate = makeCandidate({ safeYield: 0.8, aggressiveYield: 1.2, chain: [] });
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  assert.equal(view.sourceLabel, "Fallback SAFE");
  assert.equal(view.badgeLabel, null);
  assert.equal(view.mode, "BALANCED");
  assert.equal(view.strike, candidate.safeStrike.strike);
  assert.equal(view.optionSymbol, candidate.safeStrike.optionSymbol);
  assert.equal(resolveDashboardModeForFilter({ ...candidate, balancedCardViewModel: view }), "BALANCED");
});

test("UI-14/UI-19 — fallback AGGRESSIVE garde les données AGGRESSIVE mais le bucket BALANCED", () => {
  const candidate = makeCandidate({ safeYield: 0.5, aggressiveYield: 0.9, chain: [] });
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.source, BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE);
  assert.equal(view.sourceLabel, "Fallback AGRESSIF");
  assert.equal(view.badgeLabel, null);
  assert.equal(view.mode, "BALANCED");
  assert.equal(view.strike, candidate.aggressiveStrike.strike);
  assert.equal(view.optionSymbol, candidate.aggressiveStrike.optionSymbol);
  assert.equal(resolveDashboardModeForFilter({ ...candidate, balancedCardViewModel: view }), "BALANCED");
});

test("UI-15/UI-16/UI-24 — unavailable reste visible avec raison et valeurs absentes stables", () => {
  const candidate = makeCandidate({ safeYield: 0.5, aggressiveYield: 1.2, chain: [] });
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.available, false);
  assert.equal(view.source, BALANCED_LEG_SOURCES.UNAVAILABLE);
  assert.equal(view.sourceLabel, "BALANCED indisponible");
  assert.equal(view.primaryReason, "NO_BALANCED_FALLBACK_ELIGIBLE");
  assert.ok(view.diagnostics.reasonCodes.includes("NO_STRIKE_STRICTLY_BETWEEN"));
  assert.equal(view.strike, null);
  assert.equal(view.premium, null);
  assert.equal(Number.isNaN(view.periodYieldPct), false);
  assert.ok(DASHBOARD.includes("BALANCED indisponible"));
  assert.ok(DASHBOARD.includes('vm?.primaryReason ?? "n/d"'));
});

test("UI-17/UI-20/UI-22/UI-23 — React affiche la projection sans résoudre BALANCED", () => {
  const cardStart = DASHBOARD.indexOf("function BalancedFaceplateStrikeColumn");
  const cardEnd = DASHBOARD.indexOf("function MiniTradeLevelsChart", cardStart);
  const cardSource = DASHBOARD.slice(cardStart, cardEnd);
  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  assert.ok(!cardSource.includes("resolveBalancedLegSelection"));
  assert.ok(!cardSource.includes("resolveNativeBalancedLeg"));
  assert.ok(!cardSource.includes("getCanonicalPeriodYieldBand"));
  assert.ok(!cardSource.includes("weeklyNormalizedYieldPct *"));
  assert.ok(cardSource.includes('selectedMode="BALANCED"'));
  assert.ok(cardSource.includes("vm.selectedForBalanced === true"));
});

test("UI-11/UI-25 — trois cartes SAFE, BALANCED, AGRESSIF dans une grille responsive", () => {
  const sectionStart = DASHBOARD.indexOf("function FaceplateStrikeOpportunities");
  const sectionEnd = DASHBOARD.indexOf("function SupportStatusLine", sectionStart);
  const section = DASHBOARD.slice(sectionStart, sectionEnd);
  const safeIndex = section.indexOf('title="Safe (IBKR live)"');
  const balancedIndex = section.indexOf("<BalancedFaceplateStrikeColumn");
  const aggressiveIndex = section.indexOf('title="Aggressif (IBKR live)"');
  assert.ok(safeIndex >= 0 && safeIndex < balancedIndex && balancedIndex < aggressiveIndex);
  assert.ok(section.includes("grid-cols-1"));
  assert.ok(section.includes("md:grid-cols-2"));
  assert.ok(section.includes("xl:grid-cols-3"));
});
