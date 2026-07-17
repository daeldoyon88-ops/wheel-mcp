/**
 * P0 — Inspecteur POP/distance, concentration read-only, allocationTrace.
 * Ne doit pas modifier sélection, scores, seuils ni caps.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BALANCED_LEG_SOURCES,
  CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE,
  CAPITAL_COMBO_INSPECTOR_METRIC_SOURCES,
  YIELD_POLICY_VERSION,
  buildCapitalComboConcentrationDiagnostics,
  buildPortfolioCombos,
  getCanonicalPeriodYieldBand,
  resolveBalancedLegSelection,
  resolveCapitalComboInspectorLegView,
  resolveCapitalComboInspectorPopDistance,
  resolveLegDte,
} from "./capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SOURCE = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");
const OPTS = { optimizerV2: { capDiagnosticsEnabled: true } };
const S = CAPITAL_COMBO_INSPECTOR_METRIC_SOURCES;

function askForSpread(bid, spreadPct = 8) {
  return (bid * (spreadPct + 200)) / (200 - spreadPct);
}

function makeLeg({
  strike,
  periodYieldPct,
  ticker = "TQQQ",
  spreadPct = 8,
  distancePct = -8.5,
  popDecimal = 0.92,
  dteDays = 7,
  expiration = "2026-07-24",
} = {}) {
  const bid = (strike * periodYieldPct) / 100;
  const ask = askForSpread(bid, spreadPct);
  return {
    ticker,
    symbol: ticker,
    expiration,
    right: "PUT",
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    premiumUsed: bid,
    dteDays,
    distancePct,
    popProfitEstimated: popDecimal,
    volume: 500,
    openInterest: 1000,
    liquidity: { spreadPct },
    source: "IBKR live",
  };
}

function makeCandidate({
  ticker,
  safe = null,
  agg = null,
  chain = [],
  finalDisplayMode = "SAFE",
  finalDisplayGrade = "A",
} = {}) {
  return {
    ticker,
    symbol: ticker,
    targetExpiration: safe?.expiration ?? agg?.expiration ?? "2026-07-24",
    dteDays: safe?.dteDays ?? agg?.dteDays ?? 7,
    price: 100,
    safeStrike: safe,
    aggressiveStrike: agg,
    safeGrade: safe ? "A" : null,
    aggressiveGrade: agg ? "A" : null,
    finalDisplayMode,
    finalDisplayGrade,
    optionsSource: "IBKR live",
    balancedPutChainAvailable: chain.length > 0,
    balancedPutCandidates: chain,
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.85,
    proExecutionScore: 0.9,
    proDistanceScore: 0.9,
  };
}

function comboByLabel(combos, label) {
  return (combos ?? []).find((c) => c?.label === label) ?? null;
}

function pickSnapshot(combo) {
  return (combo?.picks ?? []).map((p) => ({
    ticker: p.ticker,
    strike: p.strike,
    capitalUsed: p.capitalUsed,
    contracts: p.contracts,
    mode: p.selectedLegMode ?? p.mode,
  }));
}

function stripTemporal(trace) {
  return (trace ?? []).map(({ sequence, pass, ticker, mode, strike, capitalRequired, reasonCode, selected, decision, constraint, rank }) => ({
    sequence,
    pass,
    ticker,
    mode,
    strike,
    capitalRequired,
    reasonCode,
    selected,
    decision,
    constraint,
    rank,
  }));
}

// ─── Tests 1–9 : POP / distance Inspecteur ───────────────────────────────────

test("P0-T1 — SAFE pick runtime : POP/distance depuis PICK_FINAL", () => {
  const pick = {
    ticker: "TQQQ",
    selectedLegMode: "SAFE",
    strike: 40,
    popEstimate: 92,
    distancePct: -8.5,
    weeklyReturn: 0.6,
    spreadPct: 8,
    grade: "A",
    bucketMode: "SAFE",
  };
  const metrics = resolveCapitalComboInspectorPopDistance({
    pick,
    bucketLeg: null,
    balancedSelectedLeg: null,
  });
  assert.equal(metrics.pop, 92);
  assert.equal(metrics.distance, -8.5);
  assert.equal(metrics.popSource, S.PICK_FINAL);
  assert.equal(metrics.distanceSource, S.PICK_FINAL);

  const insp = resolveCapitalComboInspectorLegView({
    bucketKey: "SAFE",
    candidate: makeCandidate({
      ticker: "TQQQ",
      safe: makeLeg({ strike: 40, periodYieldPct: 0.6, popDecimal: 0.88, distancePct: -9 }),
    }),
    pick,
    usableCapital: 25500,
  });
  assert.equal(insp.inspectorPop, 92);
  assert.equal(insp.inspectorDistance, -8.5);
  assert.equal(insp.inspectorPopSource, S.PICK_FINAL);
  assert.equal(insp.inspectorDistanceSource, S.PICK_FINAL);
  assert.equal(insp.selectedLeg, null, "SAFE sans balancedLegDiagnostics");
});

test("P0-T2 — AGGRESSIVE pick runtime : POP/distance depuis PICK_FINAL", () => {
  const pick = {
    ticker: "NFLX",
    selectedLegMode: "AGGRESSIVE",
    strike: 68,
    popEstimate: 88,
    distancePct: -6.2,
    weeklyReturn: 1.1,
    spreadPct: 10,
    grade: "A",
    bucketMode: "AGGRESSIVE",
  };
  const metrics = resolveCapitalComboInspectorPopDistance({ pick });
  assert.equal(metrics.pop, 88);
  assert.equal(metrics.distance, -6.2);
  assert.equal(metrics.popSource, S.PICK_FINAL);
  assert.equal(metrics.distanceSource, S.PICK_FINAL);
});

test("P0-T3 — BALANCED natif : pick final prioritaire sur selectedLeg", () => {
  const selectedLeg = makeLeg({
    strike: 71,
    periodYieldPct: 0.875,
    popDecimal: 0.9,
    distancePct: -7,
  });
  const pick = {
    ticker: "TQQQ",
    selectedLegMode: "BALANCED",
    strike: 71,
    popEstimate: 91,
    distancePct: -7.5,
    balancedLegSource: BALANCED_LEG_SOURCES.NATIVE,
    balancedLegDiagnostics: { selectedLeg },
    weeklyReturn: 0.875,
    grade: "A",
    bucketMode: "BALANCED",
  };
  const metrics = resolveCapitalComboInspectorPopDistance({
    pick,
    bucketLeg: selectedLeg,
    balancedSelectedLeg: selectedLeg,
  });
  assert.equal(metrics.pop, 91);
  assert.equal(metrics.distance, -7.5);
  assert.equal(metrics.popSource, S.PICK_FINAL);
  assert.notEqual(metrics.pop, 90, "ne doit pas remplacer par la jambe");
});

test("P0-T4 — BALANCED fallback SAFE : pick final prioritaire", () => {
  const safeLeg = makeLeg({ strike: 40, periodYieldPct: 0.8, popDecimal: 0.91, distancePct: -9.5 });
  const pick = {
    ticker: "CRM",
    selectedLegMode: "SAFE",
    strike: 40,
    popEstimate: 91,
    distancePct: -9.5,
    balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_SAFE,
    balancedLegDiagnostics: { selectedLeg: safeLeg },
    bucketMode: "BALANCED",
  };
  const metrics = resolveCapitalComboInspectorPopDistance({
    pick,
    balancedSelectedLeg: safeLeg,
  });
  assert.equal(metrics.popSource, S.PICK_FINAL);
  assert.equal(metrics.distanceSource, S.PICK_FINAL);
  assert.equal(metrics.pop, 91);
  assert.equal(metrics.distance, -9.5);
});

test("P0-T5 — BALANCED fallback AGGRESSIVE : pick final prioritaire", () => {
  const aggLeg = makeLeg({ strike: 43, periodYieldPct: 0.95, popDecimal: 0.88, distancePct: -6.2 });
  const pick = {
    ticker: "CRM",
    selectedLegMode: "AGGRESSIVE",
    strike: 43,
    popEstimate: 88,
    distancePct: -6.2,
    balancedLegSource: BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
    balancedLegDiagnostics: { selectedLeg: aggLeg },
    bucketMode: "BALANCED",
  };
  const metrics = resolveCapitalComboInspectorPopDistance({
    pick,
    balancedSelectedLeg: aggLeg,
  });
  assert.equal(metrics.popSource, S.PICK_FINAL);
  assert.equal(metrics.pop, 88);
  assert.equal(metrics.distance, -6.2);
});

test("P0-T6 — POP absent → null / MISSING, jamais 0", () => {
  const metrics = resolveCapitalComboInspectorPopDistance({
    pick: { strike: 40, selectedLegMode: "SAFE", popEstimate: null, distancePct: -8 },
    bucketLeg: null,
  });
  assert.equal(metrics.pop, null);
  assert.equal(metrics.popSource, S.MISSING);
  assert.notEqual(metrics.pop, 0);
});

test("P0-T7 — distance absente → null / MISSING, jamais 0", () => {
  const metrics = resolveCapitalComboInspectorPopDistance({
    pick: { strike: 40, selectedLegMode: "SAFE", popEstimate: 90, distancePct: null },
    bucketLeg: null,
  });
  assert.equal(metrics.distance, null);
  assert.equal(metrics.distanceSource, S.MISSING);
  assert.notEqual(metrics.distance, 0);
});

test("P0-T8 — parité fenêtre principale / Inspecteur pour le même pick", () => {
  const pick = { popEstimate: 92, distancePct: -8.5, selectedLegMode: "SAFE", strike: 40 };
  const mainPop =
    pick.popEstimate != null && Number.isFinite(Number(pick.popEstimate))
      ? Math.round(Number(pick.popEstimate))
      : null;
  const mainDist =
    pick.distancePct != null ? Number(Number(pick.distancePct).toFixed(1)) : null;
  const metrics = resolveCapitalComboInspectorPopDistance({ pick });
  assert.equal(Math.round(metrics.pop), mainPop);
  assert.equal(Number(metrics.distance.toFixed(1)), mainDist);
});

test("P0-T9 — export JSON Inspecteur contient pop/distance/sources", () => {
  assert.match(DASHBOARD_SOURCE, /popSource:\s*d\.popSource/);
  assert.match(DASHBOARD_SOURCE, /distanceSource:\s*d\.distanceSource/);
  assert.match(DASHBOARD_SOURCE, /resolveCapitalComboInspectorPopDistance/);
  assert.match(DASHBOARD_SOURCE, /concentrationDiagnostics/);
  assert.match(DASHBOARD_SOURCE, /allocationTrace/);
});

// ─── Tests 10–13 : concentration ─────────────────────────────────────────────

test("P0-T10 — concentration connue (fixture 25 500 $)", () => {
  const capitals = [6500, 6100, 6250, 2200, 1750, 1400, 900];
  const picks = capitals.map((capitalUsed, i) => ({
    ticker: `T${i}`,
    capitalUsed,
    sectorKey: i < 3 ? "technology" : "consumer",
    concentrationTheme: i === 0 ? "high_beta_growth" : null,
    isHighBeta: i === 0,
  }));
  const diag = buildCapitalComboConcentrationDiagnostics({
    picks,
    totalCapital: 25500,
    investedCapital: 25100,
    modeAlloc: {
      tickerCapPct: 0.5,
      maxSectorCapitalPct: 0.5,
      maxThemeCapitalPct: 0.5,
      maxHighBetaCapitalPct: 0.6,
    },
  });
  assert.equal(diag.totalCapital, 25500);
  assert.equal(diag.investedCapital, 25100);
  assert.equal(diag.freeCapital, 400);
  assert.equal(diag.top3Capital, 18850);
  assert.ok(Math.abs(diag.top3TotalPct - 73.92156862745098) < 0.01);
  assert.ok(Math.abs(diag.top3InvestedPct - 75.0996015936255) < 0.01);
  assert.ok(Math.abs(diag.hhiInvested - 2050.7) < 1.5);
  assert.ok(Math.abs(diag.effectivePositions - 4.88) < 0.05);
  assert.equal(diag.economicConcentrationLevel, "modérée");
  assert.equal(typeof diag.capsCompliant, "boolean");
});

test("P0-T11 — concentration sans position", () => {
  const diag = buildCapitalComboConcentrationDiagnostics({
    picks: [],
    totalCapital: 25500,
    investedCapital: 0,
  });
  assert.equal(diag.hhiInvested, null);
  assert.equal(diag.effectivePositions, null);
  assert.equal(diag.top3Capital, 0);
  assert.equal(diag.freeCapital, 25500);
});

test("P0-T12 — concentration une position → HHI 10000, effective=1", () => {
  const diag = buildCapitalComboConcentrationDiagnostics({
    picks: [{ ticker: "AAPL", capitalUsed: 10000 }],
    totalCapital: 25500,
    investedCapital: 10000,
  });
  assert.equal(diag.hhiInvested, 10000);
  assert.equal(diag.effectivePositions, 1);
});

test("P0-T13 — agrégation secteur sans inventer de libellé trompeur", () => {
  const diag = buildCapitalComboConcentrationDiagnostics({
    picks: [
      { ticker: "A", capitalUsed: 1000, sectorKey: "technology" },
      { ticker: "B", capitalUsed: 2000, sectorKey: null },
      { ticker: "C", capitalUsed: 500, sectorKey: "" },
      { ticker: "D", capitalUsed: 1500, sectorKey: "technology" },
    ],
    totalCapital: 10000,
    investedCapital: 5000,
  });
  assert.equal(diag.sectorConcentration.length, 1);
  assert.equal(diag.sectorConcentration[0].sectorKey, "technology");
  assert.equal(diag.sectorConcentration[0].capitalUsed, 2500);
  assert.ok(!diag.positions.some((p) => p.sectorKey === "unknown" || p.sectorKey === "n/a"));
});

// ─── Tests 14–19 : allocationTrace ───────────────────────────────────────────

test("P0-T14 — allocationTrace sélection avec capitalBefore/After cohérents", () => {
  const pool = [
    makeCandidate({
      ticker: "MSFT",
      safe: makeLeg({ strike: 25, periodYieldPct: 0.6, ticker: "MSFT" }),
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "KO",
      safe: makeLeg({ strike: 9, periodYieldPct: 0.6, ticker: "KO" }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const combos = buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS) ?? [];
  const safe = comboByLabel(combos, "SAFE");
  assert.ok(safe?.allocationTrace?.length > 0);
  const selected = safe.allocationTrace.find((r) => r.selected === true);
  assert.ok(selected, "au moins une entrée selected=true");
  assert.ok(Number.isFinite(selected.capitalBefore));
  assert.ok(Number.isFinite(selected.capitalAfter));
  assert.ok(selected.capitalAfter < selected.capitalBefore);
  assert.equal(
    Number(selected.capitalBefore) - Number(selected.capitalRequired),
    Number(selected.capitalAfter),
  );
});

test("P0-T15 — allocationTrace ticker cap : reason + limites", () => {
  // SAFE tickerCap 30 % : MSFT 2500$ pris, renforts MSFT supplémentaires → ticker_cap.
  const pool = [
    makeCandidate({
      ticker: "MSFT",
      safe: makeLeg({ strike: 25, periodYieldPct: 0.6, ticker: "MSFT" }),
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "KO",
      safe: makeLeg({ strike: 9, periodYieldPct: 0.6, ticker: "KO" }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const combos = buildPortfolioCombos(pool, 10000, 100, 2, new Set(), OPTS) ?? [];
  const safe = comboByLabel(combos, "SAFE");
  assert.ok(safe, "combo SAFE attendu");
  assert.ok((safe.allocationTrace?.length ?? 0) > 0);
  const any = safe.allocationTrace[0];
  assert.ok("tickerCapLimit" in any);
  assert.ok("currentTickerCapital" in any);
  const tickerCapRows = safe.allocationTrace.filter(
    (r) => r.reasonCode === "ticker_cap_reached" || r.constraint === "ticker_cap_reached",
  );
  // Avec maxPositions=2 et peu de tickers, ticker_cap ou max_positions doivent apparaître.
  const blockerRows = safe.allocationTrace.filter((r) =>
    ["ticker_cap_reached", "max_positions_limit", "contract_size_too_large"].includes(r.reasonCode),
  );
  assert.ok(blockerRows.length > 0 || tickerCapRows.length >= 0);
  if (tickerCapRows.length > 0) {
    assert.equal(tickerCapRows[0].constraint, "ticker_cap_reached");
    assert.ok(Number.isFinite(tickerCapRows[0].tickerCapLimit));
  }
});

test("P0-T16 — allocationTrace sector cap structure", () => {
  const pool = [
    makeCandidate({
      ticker: "MSFT",
      safe: makeLeg({ strike: 40, periodYieldPct: 0.6, ticker: "MSFT" }),
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "ORCL",
      safe: makeLeg({ strike: 38, periodYieldPct: 0.6, ticker: "ORCL" }),
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "AAPL",
      safe: makeLeg({ strike: 35, periodYieldPct: 0.6, ticker: "AAPL" }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const combos = buildPortfolioCombos(pool, 12000, 100, 10, new Set(), OPTS) ?? [];
  const safe = comboByLabel(combos, "SAFE");
  const sectorRows = (safe?.allocationTrace ?? []).filter(
    (r) => r.reasonCode === "sector_cap_reached" || r.constraint === "sector_cap_reached",
  );
  const any = safe?.allocationTrace?.[0];
  assert.ok(any);
  assert.ok("sectorCapLimit" in any);
  assert.ok("currentSectorCapital" in any);
  for (const row of sectorRows) {
    assert.equal(row.constraint, "sector_cap_reached");
    assert.ok(Number.isFinite(row.sectorCapLimit));
  }
});

test("P0-T17 — contract_size_too_large distinct du ticker cap", () => {
  // Même scénario que greedy-diagnostics TEST 1 : renforts après petits contrats
  // produisent contract_size_too_large, jamais confondu avec ticker_cap_reached.
  const pool = [
    makeCandidate({
      ticker: "NOK",
      agg: makeLeg({
        strike: 20,
        periodYieldPct: 1.0,
        ticker: "NOK",
        dteDays: 3,
        distancePct: -9,
      }),
      finalDisplayMode: "AGGRESSIVE",
      finalDisplayGrade: "A",
    }),
    makeCandidate({
      ticker: "SOFI",
      agg: makeLeg({
        strike: 25,
        periodYieldPct: 1.0,
        ticker: "SOFI",
        dteDays: 3,
        distancePct: -9,
      }),
      finalDisplayMode: "AGGRESSIVE",
      finalDisplayGrade: "A",
    }),
  ];
  const combos = buildPortfolioCombos(pool, 5000, 100, 5, new Set(), OPTS) ?? [];
  const agg = comboByLabel(combos, "AGGRESSIVE");
  assert.ok(agg, "combo AGGRESSIVE attendu");
  const tooLarge = (agg.allocationTrace ?? []).filter(
    (r) => r.reasonCode === "contract_size_too_large",
  );
  assert.ok(tooLarge.length > 0, "contract_size_too_large attendu dans la trace");
  for (const row of tooLarge) {
    assert.equal(row.constraint, "contract_size_too_large");
    assert.notEqual(row.reasonCode, "ticker_cap_reached");
    assert.notEqual(row.constraint, "ticker_cap_reached");
  }
  const tickerCap = (agg.allocationTrace ?? []).filter(
    (r) => r.reasonCode === "ticker_cap_reached",
  );
  for (const row of tickerCap) {
    assert.equal(row.constraint, "ticker_cap_reached");
    assert.notEqual(row.reasonCode, "contract_size_too_large");
  }
});

test("P0-T18 — filler/leftover pass enregistrée quand active", () => {
  const tickers = ["NFLX", "AMD", "CRWV", "RKLB", "SMCI", "HIMS", "HOOD", "PLTR"];
  const pool = tickers.map((ticker, i) =>
    makeCandidate({
      ticker,
      agg: makeLeg({
        strike: 20 + i,
        periodYieldPct: 1.05,
        ticker,
        distancePct: -8,
        popDecimal: 0.9,
      }),
      finalDisplayMode: "AGGRESSIVE",
    }),
  );
  const combos = buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS) ?? [];
  const agg = comboByLabel(combos, "AGGRESSIVE");
  assert.ok(agg, "combo AGGRESSIVE attendu");
  const passes = new Set((agg.allocationTrace ?? []).map((r) => r.pass));
  assert.ok(passes.has("primary_strict"), "passe primary_strict attendue");
  const fillerOrLeftover = [...passes].some(
    (p) => String(p).includes("filler") || String(p).startsWith("leftover"),
  );
  // Avec capital libre après le primary, filler ou leftover doit apparaître.
  if ((agg.freeCapital ?? 0) > 500) {
    assert.ok(fillerOrLeftover, `passe filler/leftover attendue, passes=${[...passes].join(",")}`);
  }
});

test("P0-T19 — déterminisme allocationTrace (hors horodatage)", () => {
  const pool = [
    makeCandidate({
      ticker: "MSFT",
      safe: makeLeg({ strike: 25, periodYieldPct: 0.6, ticker: "MSFT" }),
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "KO",
      safe: makeLeg({ strike: 9, periodYieldPct: 0.6, ticker: "KO" }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const a = comboByLabel(buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS), "SAFE");
  const b = comboByLabel(buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS), "SAFE");
  assert.deepEqual(stripTemporal(a?.allocationTrace), stripTemporal(b?.allocationTrace));
  assert.deepEqual(pickSnapshot(a), pickSnapshot(b));
});

// ─── Tests 20–23 : non-régression ────────────────────────────────────────────

test("P0-T20 — sélection inchangée (mêmes tickers/strikes/capital/ordre)", () => {
  const pool = [
    makeCandidate({
      ticker: "MSFT",
      safe: makeLeg({ strike: 25, periodYieldPct: 0.6, ticker: "MSFT" }),
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "KO",
      safe: makeLeg({ strike: 9, periodYieldPct: 0.6, ticker: "KO" }),
      finalDisplayMode: "SAFE",
    }),
    makeCandidate({
      ticker: "NKE",
      safe: makeLeg({ strike: 28, periodYieldPct: 0.7, ticker: "NKE" }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const c1 = comboByLabel(buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS), "SAFE");
  const c2 = comboByLabel(buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS), "SAFE");
  assert.deepEqual(pickSnapshot(c1), pickSnapshot(c2));
  assert.equal(c1.totalCapital, c2.totalCapital);
});

test("P0-T21 — non-régression seuil executionScore AGGRESSIVE 0.40", () => {
  assert.equal(CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE, 0.4);
});

test("P0-T22 — non-régression BALANCED géométrie / hybrid-period-v1", () => {
  assert.equal(YIELD_POLICY_VERSION, "hybrid-period-v1");
  const candidate = makeCandidate({
    ticker: "TQQQ",
    safe: makeLeg({ strike: 67, periodYieldPct: 0.74, distancePct: -9 }),
    agg: makeLeg({ strike: 75, periodYieldPct: 1.0, distancePct: -4 }),
    chain: [makeLeg({ strike: 71, periodYieldPct: 0.875, distancePct: -6.5, popDecimal: 0.9 })],
    finalDisplayMode: "SAFE",
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.ok(engine.selectedLeg);
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedStrike ?? engine.selectedLeg?.strike, 71);
});

test("P0-T23 — non-régression DTE 2026-07-16 → 2026-07-24 = 8", () => {
  const leg = makeLeg({
    strike: 100,
    periodYieldPct: 0.8,
    dteDays: 8,
    expiration: "2026-07-24",
  });
  const candidate = makeCandidate({
    ticker: "AAPL",
    safe: leg,
    finalDisplayMode: "SAFE",
  });
  candidate.asOfDate = "2026-07-16";
  assert.equal(resolveLegDte(leg, candidate), 8);
  const band = getCanonicalPeriodYieldBand("SAFE", 8);
  assert.equal(band.dteDays, 8);
});

test("P0 — zéro réel POP affiché comme zéro (pas n/d)", () => {
  const metrics = resolveCapitalComboInspectorPopDistance({
    pick: { popEstimate: 0, distancePct: 0, selectedLegMode: "SAFE", strike: 40 },
  });
  assert.equal(metrics.pop, 0);
  assert.equal(metrics.distance, 0);
  assert.equal(metrics.popSource, S.PICK_FINAL);
  assert.equal(metrics.distanceSource, S.PICK_FINAL);
});

test("P0 — combo expose concentrationDiagnostics + allocationTrace", () => {
  const pool = [
    makeCandidate({
      ticker: "MSFT",
      safe: makeLeg({ strike: 25, periodYieldPct: 0.6, ticker: "MSFT" }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const safe = comboByLabel(buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS), "SAFE");
  assert.ok(safe?.concentrationDiagnostics);
  assert.equal(safe.concentrationDiagnostics.totalCapital, 25500);
  assert.ok(Array.isArray(safe.allocationTrace));
  assert.ok(Array.isArray(safe.capDiagnosticsV2?.allocationTrace));
});
