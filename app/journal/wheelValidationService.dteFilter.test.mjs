import test from "node:test";
import assert from "node:assert/strict";
import {
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "./wheelValidationService.js";

// ─────────────────────────────────────────────────────────────────────────────
// J6-A — Filtre DTE réel du Top réaliste.
// `dteFilter` (7/4/3 ou null/"all") recalcule le Top réaliste sur les seules
// observations du DTE choisi : le sous-ensemble est filtré AVANT la reconstruction
// des profils, donc selectedTradeCount / rendement réel / assignation réelle / score
// sont recalculés par horizon. `null` / "all" = comportement global inchangé.
// ─────────────────────────────────────────────────────────────────────────────

let __idSeq = 0;
function rec({
  ticker = "TEST",
  expiration = "2025-01-10",
  mode = "safe",
  dte = 7,
  strike = 100,
  premium = 1,
  assigned = false,
  close = null,
  resolved = true,
  captureClass = "primaryDaily",
} = {}) {
  __idSeq += 1;
  const resolution = {
    resolved,
    assigned_flag: assigned,
    expiredWorthless: assigned ? false : true,
    popPredictionCorrect: !assigned,
  };
  if (close != null) resolution.underlying_close_at_expiration = close;
  return {
    id: `id-${String(__idSeq).padStart(4, "0")}`,
    symbol: ticker,
    selectedExpiration: expiration,
    strikeMode: mode,
    dteAtScan: dte,
    strike: { strike, premium },
    captureClass,
    resolution,
  };
}

// Ticker « propre » sur un DTE unique : `expirations` expirations × 2 observations
// (SAFE/AGRESSIF), non assignées, rendement ~1 % → selectedTradeCount = expirations,
// n = expirations × 2.
function cleanDte(ticker, dte, expirations, { premium = 1.0, month = "03" } = {}) {
  const out = [];
  for (let e = 0; e < expirations; e += 1) {
    const expiration = `2025-${month}-${String(3 + e).padStart(2, "0")}`;
    for (let o = 0; o < 2; o += 1) {
      out.push(
        rec({
          ticker,
          expiration,
          mode: o === 0 ? "safe" : "aggressive",
          dte,
          premium: premium + o * 0.01,
          assigned: false,
        }),
      );
    }
  }
  return out;
}

// Observations assignées « proches » (close juste sous le strike) sur un DTE donné.
function assignedDte(ticker, dte, expirations, { premium = 2.0, month = "04", close = 99.5 } = {}) {
  const out = [];
  for (let e = 0; e < expirations; e += 1) {
    const expiration = `2025-${month}-${String(1 + e).padStart(2, "0")}`;
    out.push(rec({ ticker, expiration, mode: "safe", dte, premium, assigned: true, close }));
  }
  return out;
}

function buildView(records, dteFilter) {
  const { profiles } = computeOnePercentWheelProfiles(records, [], { today: "2026-04-01" });
  return computeDynamicTop20WheelProfiles(profiles, {
    today: "2026-04-01",
    records,
    ...(dteFilter !== undefined ? { dteFilter } : {}),
  });
}

function allRows(result) {
  return [
    ...result.top20,
    ...result.nearEntry,
    ...result.watchValidate,
    ...result.stressed,
    ...result.excludedHighYield,
    ...result.insufficientSample,
    ...result.excludedCrypto,
  ];
}

function rowFor(result, ticker) {
  return allRows(result).find((r) => r.ticker === ticker) ?? null;
}

function tickersInTop20(result) {
  return result.top20.map((r) => r.ticker).sort();
}

// Jeu de données : tickers propres mono-DTE + SEVENOK mixte (DTE 7 propre + DTE 3
// faible/assigné). Chaque ticker mono-DTE a 12 observations (6 exp × 2) → n ≥ 10.
function dataset() {
  return [
    // DTE 7 propre + DTE 3 faible (3 obs assignées proches, rendement plus élevé).
    ...cleanDte("SEVENOK", 7, 6, { month: "03", premium: 1.0 }),
    ...assignedDte("SEVENOK", 3, 3, { month: "04", premium: 2.0, close: 99.5 }),
    // Mono-DTE purs pour prouver le cloisonnement par horizon.
    ...cleanDte("SEVENONLY", 7, 6, { month: "06", premium: 1.0 }),
    ...cleanDte("FOURONLY", 4, 6, { month: "05", premium: 1.0 }),
    ...cleanDte("THREEONLY", 3, 6, { month: "07", premium: 1.0 }),
  ];
}

// ── A — dteFilter "all" (ou absent) = comportement global actuel ─────────────────
test("A — dteFilter 'all' identique au calcul sans filtre (global inchangé)", () => {
  const records = dataset();
  const noFilter = buildView(records); // pas d'option dteFilter
  const all = buildView(records, "all");

  assert.equal(noFilter.meta.dteFilter, null, "sans filtre → meta.dteFilter null");
  assert.equal(all.meta.dteFilter, null, "'all' → meta.dteFilter null");

  const project = (r) => r.top20.map((row) => ({ t: row.ticker, s: row.dynamicTop20Score }));
  assert.deepEqual(project(all), project(noFilter), "Top réaliste 'all' = Top réaliste global");
  assert.deepEqual(tickersInTop20(all), tickersInTop20(noFilter));
});

// ── B — dteFilter 7 ne calcule que les observations DTE 7 ───────────────────────
test("B — dteFilter 7 : Top réaliste recalculé sur les seuls records DTE 7", () => {
  const records = dataset();
  const dte7 = buildView(records, 7);

  assert.equal(dte7.meta.dteFilter, 7);
  const top = tickersInTop20(dte7);
  assert.ok(top.includes("SEVENOK"), "SEVENOK (DTE 7 propre) admissible en 7 DTE");
  assert.ok(top.includes("SEVENONLY"), "SEVENONLY (DTE 7) admissible en 7 DTE");
  // Aucun ticker sans observation DTE 7 ne doit apparaître dans la vue 7 DTE.
  assert.equal(rowFor(dte7, "FOURONLY"), null, "FOURONLY (DTE 4) absent de la vue 7 DTE");
  assert.equal(rowFor(dte7, "THREEONLY"), null, "THREEONLY (DTE 3) absent de la vue 7 DTE");

  // Métriques SEVENOK recalculées sur DTE 7 seulement : 6 décisions, 0 assignation.
  const s = dte7.top20.find((r) => r.ticker === "SEVENOK");
  assert.equal(s.realisticDecisionMetrics.selectedTradeCount, 6);
  assert.equal(s.n, 12);
  assert.equal(s.assignmentRate, 0);
});

// ── C — dteFilter 4 ne calcule que les observations DTE 4 ───────────────────────
test("C — dteFilter 4 : Top réaliste recalculé sur les seuls records DTE 4", () => {
  const records = dataset();
  const dte4 = buildView(records, 4);

  assert.equal(dte4.meta.dteFilter, 4);
  const top = tickersInTop20(dte4);
  assert.ok(top.includes("FOURONLY"), "FOURONLY (DTE 4) admissible en 4 DTE");
  assert.equal(rowFor(dte4, "SEVENONLY"), null, "SEVENONLY (DTE 7) absent de la vue 4 DTE");
  assert.equal(rowFor(dte4, "SEVENOK"), null, "SEVENOK (aucune obs DTE 4) absent de la vue 4 DTE");
});

// ── D — dteFilter 3 ne calcule que les observations DTE 3 ───────────────────────
test("D — dteFilter 3 : Top réaliste recalculé sur les seuls records DTE 3", () => {
  const records = dataset();
  const dte3 = buildView(records, 3);

  assert.equal(dte3.meta.dteFilter, 3);
  const top = tickersInTop20(dte3);
  assert.ok(top.includes("THREEONLY"), "THREEONLY (DTE 3, 12 obs) admissible en 3 DTE");
  assert.equal(rowFor(dte3, "SEVENONLY"), null, "SEVENONLY (DTE 7) absent de la vue 3 DTE");
  assert.equal(rowFor(dte3, "FOURONLY"), null, "FOURONLY (DTE 4) absent de la vue 3 DTE");
});

// ── E — Un ticker Top réaliste en 7 DTE peut être absent/mauvais en 3 DTE ────────
test("E — SEVENOK : Top réaliste en 7 DTE mais hors Top réaliste en 3 DTE", () => {
  const records = dataset();
  const dte7 = buildView(records, 7);
  const dte3 = buildView(records, 3);

  assert.ok(
    dte7.top20.some((r) => r.ticker === "SEVENOK"),
    "SEVENOK est Top réaliste en 7 DTE",
  );
  assert.equal(
    dte3.top20.some((r) => r.ticker === "SEVENOK"),
    false,
    "SEVENOK n'est PAS Top réaliste en 3 DTE",
  );
  // En 3 DTE, SEVENOK n'a que 3 observations → échantillon insuffisant (n < 10).
  const sDte3 = rowFor(dte3, "SEVENOK");
  assert.ok(sDte3, "SEVENOK reste présent dans un autre bucket en 3 DTE");
  assert.equal(sDte3.dynamicTop20Status, "insufficient_sample");
});

// ── F — selectedTradeCount / avgYield / assignmentRate / score changent par DTE ──
test("F — métriques SEVENOK différentes entre 'all', 7 DTE et 3 DTE", () => {
  const records = dataset();
  const all = buildView(records, "all");
  const dte7 = buildView(records, 7);
  const dte3 = buildView(records, 3);

  const sAll = rowFor(all, "SEVENOK");
  const sDte7 = rowFor(dte7, "SEVENOK");
  const sDte3 = rowFor(dte3, "SEVENOK");

  // selectedTradeCount : 9 (tous DTE) vs 6 (DTE 7) vs 3 (DTE 3).
  assert.equal(sAll.realisticDecisionMetrics.selectedTradeCount, 9);
  assert.equal(sDte7.realisticDecisionMetrics.selectedTradeCount, 6);
  assert.equal(sDte3.realisticDecisionMetrics.selectedTradeCount, 3);

  // avgYield : la vue 7 DTE (rendement ~1 %) < global (mélangé avec DTE 3 à ~2 %).
  assert.ok(
    sAll.avgCspYieldPct > sDte7.avgCspYieldPct,
    "rendement global > rendement 7 DTE (DTE 3 à 2 % tire la moyenne globale vers le haut)",
  );

  // assignmentRate : 0 % en 7 DTE (propre) vs > 0 % en global (assignations DTE 3).
  assert.equal(sDte7.assignmentRate, 0);
  assert.ok(sAll.assignmentRate > 0, "assignation globale > 0 (apportée par DTE 3)");

  // score réaliste recalculé : différent entre global et 7 DTE.
  assert.notEqual(sAll.dynamicTop20Score, sDte7.dynamicTop20Score);
});

// ── G — Le Top réaliste global reste inchangé après calcul des vues DTE ──────────
test("G — calculer les vues DTE ne modifie pas le Top réaliste global", () => {
  const records = dataset();
  const before = buildView(records); // global, sans filtre
  // On calcule les vues DTE entre deux mesures du global.
  buildView(records, 7);
  buildView(records, 4);
  buildView(records, 3);
  const after = buildView(records);

  const project = (r) => r.top20.map((row) => ({ t: row.ticker, s: row.dynamicTop20Score }));
  assert.deepEqual(project(after), project(before), "global identique avant/après vues DTE");
});
