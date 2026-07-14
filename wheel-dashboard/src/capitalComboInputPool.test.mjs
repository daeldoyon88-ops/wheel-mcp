// AF-06 — Tests : le pool canonique du moteur de combinaisons est indépendant
// des filtres visuels (recherche, filtre Mode UI, tri) ; les filtres métier
// (expiration, exclusions IBKR, capital) restent actifs.
//
// Ces tests exercent le VRAI code de production :
// - buildComboCandidatePool / buildVisibleTableRows (capitalComboInputPool.js,
//   utilisés par dashboard.jsx pour `comboCandidateRows` et `filtered`) ;
// - buildPortfolioCombos (capitalComboPortfolio.js, moteur réel, intact).
// `simulateDashboardFlow` reproduit exactement le câblage des useMemo du
// dashboard : pool → tableau visible ; pool → moteur.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildComboCandidatePool,
  buildVisibleTableRows,
  rowMatchesSearchQuery,
} from "./capitalComboInputPool.js";
import { buildPortfolioCombos } from "./capitalComboPortfolio.js";

// ── Fixtures : 4 candidats admissibles SAFE (style tests AF-05) ──────────────
function makeLeg({ strike = 50, bid = 0.27, weeklyYield = 0.54, spreadPct = 12, distancePct = -8, dteDays = 7 } = {}) {
  return {
    strike,
    bid,
    premiumUsed: bid,
    mid: bid,
    weeklyYield,
    periodYield: weeklyYield,
    dteDays,
    distancePct,
    volume: 1000,
    openInterest: 2000,
    source: "IBKR live",
    liquidity: { spreadPct },
    popProfitEstimated: 0.82,
  };
}

function makeCandidate({ ticker, name, proFinalScore, qualityScore, weeklyReturn, spreadPct, targetExpiration = "2026-07-17", dteDays = 7 }) {
  const periodYield = weeklyReturn ?? 0.54;
  return {
    ticker,
    name,
    dteDays,
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "B",
    safeGrade: "B",
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore,
    proExecutionScore: 0.9,
    proDistanceScore: 0.9,
    qualityScore,
    weeklyReturn,
    targetExpiration,
    safeStrike: makeLeg({ spreadPct, weeklyYield: periodYield, dteDays }),
    rank: 0,
  };
}

function makePool() {
  return [
    makeCandidate({ ticker: "AAPL", name: "Apple Inc.", proFinalScore: 0.95, qualityScore: 95, weeklyReturn: 0.61, spreadPct: 12 }),
    makeCandidate({ ticker: "MSFT", name: "Microsoft Corporation", proFinalScore: 0.9, qualityScore: 90, weeklyReturn: 0.58, spreadPct: 13 }),
    makeCandidate({ ticker: "ORCL", name: "Oracle Corporation", proFinalScore: 0.85, qualityScore: 85, weeklyReturn: 0.55, spreadPct: 11 }),
    makeCandidate({ ticker: "SOFI", name: "SoFi Technologies Inc.", proFinalScore: 0.8, qualityScore: 80, weeklyReturn: 0.52, spreadPct: 10 }),
  ];
}

const SELECTED_EXPIRATION = "2026-07-17";
const CAPITAL = 100000;
const MAX_CAPITAL_PCT = 20; // usable = 20 000 ; strike 50 → 5 000/contrat
const MAX_POSITIONS = 2; // ⇒ recommandation = sous-ensemble strict du pool

// Miroir de getSafeSpreadPct côté dashboard pour le tri « spread » (injection).
const spreadStub = (item) => item?.safeStrike?.liquidity?.spreadPct ?? null;

const DEFAULT_UI = {
  query: "",
  filter: "all",
  sortBy: "quality",
  sortOrder: "desc",
  dataSource: "snapshot",
  selectedExpiration: SELECTED_EXPIRATION,
};

/** Reproduit le câblage exact du dashboard après patch AF-06. */
function simulateDashboardFlow(enrichedCandidates, uiOverrides = {}, engineOverrides = {}) {
  const ui = { ...DEFAULT_UI, ...uiOverrides };
  const comboCandidateRows = buildComboCandidatePool(enrichedCandidates, {
    selectedExpiration: ui.selectedExpiration,
  });
  const visible = buildVisibleTableRows(comboCandidateRows, {
    query: ui.query,
    modeFilter: ui.filter,
    sortBy: ui.sortBy,
    sortOrder: ui.sortOrder,
    dataSource: ui.dataSource,
    getSpreadPct: spreadStub,
  });
  const combos = buildPortfolioCombos(
    comboCandidateRows,
    engineOverrides.capital ?? CAPITAL,
    engineOverrides.maxCapitalPct ?? MAX_CAPITAL_PCT,
    engineOverrides.maxPositions ?? MAX_POSITIONS,
    engineOverrides.ibkrRejectedSymbols ?? new Set(),
    { optimizerV2: { leftoverDensityPassEnabled: false } }
  );
  return { comboCandidateRows, visible, combos };
}

/** Empreinte financière stable (section 23) — ordre des picks = ordre canonique AF-05 du moteur. */
function fingerprintCombos(combos) {
  const byLabel = (label) => {
    const combo = combos.find((c) => c?.label === label) ?? null;
    if (!combo) return null;
    return {
      comboLabel: combo.label,
      picks: (combo.picks ?? []).map((p) => ({
        ticker: p.ticker,
        selectedMode: p.mode,
        strike: p.strike,
        contracts: p.contracts,
        capitalRequired: p.capitalRequired,
        premium: p.premiumCollected,
        score: p.selectionScore,
      })),
      capitalUsed: combo.totalCapital,
      freeCapital: combo.freeCapital,
      totalPremium: combo.totalPremium ?? null,
      portfolioYield: combo.avgWeeklyReturn ?? null,
    };
  };
  return { SAFE: byLabel("SAFE"), BALANCED: byLabel("BALANCED"), AGGRESSIVE: byLabel("AGGRESSIVE") };
}

const visibleTickers = (state) => state.visible.map((c) => c.ticker);
const poolTickers = (state) => state.comboCandidateRows.map((c) => c.ticker);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Empreinte de référence (recherche vide) partagée par plusieurs tests.
const baseline = simulateDashboardFlow(makePool());
const baselineFp = fingerprintCombos(baseline.combos);

test("AF-06 baseline — la recommandation est un sous-ensemble strict du pool (précondition)", () => {
  assert.equal(baseline.comboCandidateRows.length, 4);
  const picks = baselineFp.SAFE?.picks ?? [];
  assert.ok(picks.length >= 1 && picks.length < 4, "précondition : sous-ensemble strict requis");
});

test("TEST 1 — recherche vide : pool combo = 4, tableau visible complet", () => {
  const state = simulateDashboardFlow(makePool(), { query: "" });
  assert.equal(state.comboCandidateRows.length, 4);
  assert.equal(state.visible.length, 4);
});

test("TEST 2 — recherche ticker présent (ORCL) : visible = ORCL seul, pool = 4, portefeuille identique", () => {
  const state = simulateDashboardFlow(makePool(), { query: "ORCL" });
  assert.deepEqual(visibleTickers(state), ["ORCL"]);
  assert.equal(state.comboCandidateRows.length, 4);
  assert.deepEqual(fingerprintCombos(state.combos), baselineFp);
});

test("TEST 3 — recherche ticker absent : visible vide, pool complet, portefeuille identique", () => {
  const state = simulateDashboardFlow(makePool(), { query: "ZZZZ_NOT_FOUND" });
  assert.equal(state.visible.length, 0);
  assert.equal(state.comboCandidateRows.length, 4);
  assert.deepEqual(fingerprintCombos(state.combos), baselineFp);
});

test("TEST 4 — recherche par nom long (microsoft) : visible filtré, pool inchangé", () => {
  const state = simulateDashboardFlow(makePool(), { query: "microsoft" });
  assert.deepEqual(visibleTickers(state), ["MSFT"]);
  assert.equal(state.comboCandidateRows.length, 4);
  assert.deepEqual(fingerprintCombos(state.combos), baselineFp);
});

test("TEST 5 — casse et espaces : orcl / ' ORCL' / OrCl → même visible, pool inchangé", () => {
  const variants = ["orcl", " ORCL", "OrCl", "  orcl  "];
  const results = variants.map((q) => simulateDashboardFlow(makePool(), { query: q }));
  for (const state of results) {
    assert.deepEqual(visibleTickers(state), ["ORCL"]);
    assert.equal(state.comboCandidateRows.length, 4);
    assert.deepEqual(fingerprintCombos(state.combos), baselineFp);
  }
});

test("TEST 6 — effacement de la recherche : vide → ORCL → vide, portefeuille identique aux 3 états", () => {
  const s1 = simulateDashboardFlow(makePool(), { query: "" });
  const s2 = simulateDashboardFlow(makePool(), { query: "ORCL" });
  const s3 = simulateDashboardFlow(makePool(), { query: "" });
  assert.deepEqual(fingerprintCombos(s1.combos), baselineFp);
  assert.deepEqual(fingerprintCombos(s2.combos), baselineFp);
  assert.deepEqual(fingerprintCombos(s3.combos), baselineFp);
  assert.equal(s3.visible.length, 4, "le tableau revient au pool complet");
});

test("TEST 7 — recherches successives : le tableau varie, le portefeuille reste strictement identique", () => {
  const searches = ["AAPL", "MSFT", "SOFI", "NOT_FOUND"];
  const expectedVisible = [["AAPL"], ["MSFT"], ["SOFI"], []];
  searches.forEach((q, i) => {
    const state = simulateDashboardFlow(makePool(), { query: q });
    assert.deepEqual(visibleTickers(state), expectedVisible[i]);
    assert.deepEqual(fingerprintCombos(state.combos), baselineFp);
  });
});

test("TEST 8 — tri ASC puis DESC (adaptation : pas de tri ticker dans l'UI ; tri « quality ») : ordre visible différent, portefeuille identique", () => {
  const asc = simulateDashboardFlow(makePool(), { sortBy: "quality", sortOrder: "asc" });
  const desc = simulateDashboardFlow(makePool(), { sortBy: "quality", sortOrder: "desc" });
  assert.deepEqual(visibleTickers(asc), ["SOFI", "ORCL", "MSFT", "AAPL"]);
  assert.deepEqual(visibleTickers(desc), ["AAPL", "MSFT", "ORCL", "SOFI"]);
  assert.deepEqual(fingerprintCombos(asc.combos), baselineFp);
  assert.deepEqual(fingerprintCombos(desc.combos), baselineFp);
  assert.deepEqual(poolTickers(asc), poolTickers(desc), "ordre canonique du pool inchangé par le tri");
});

test("TEST 9 — tri par score/rendement/spread ASC et DESC : ordre différent, portefeuille identique", () => {
  for (const sortBy of ["weeklyReturn", "spread"]) {
    const asc = simulateDashboardFlow(makePool(), { sortBy, sortOrder: "asc" });
    const desc = simulateDashboardFlow(makePool(), { sortBy, sortOrder: "desc" });
    assert.notDeepEqual(visibleTickers(asc), visibleTickers(desc), `tri ${sortBy} : ordres asc/desc distincts`);
    assert.deepEqual(fingerprintCombos(asc.combos), baselineFp);
    assert.deepEqual(fingerprintCombos(desc.combos), baselineFp);
  }
});

test("TEST 10 — pagination : NON APPLICABLE (le tableau affiche toutes les lignes filtrées, aucune limite/pagination dans buildVisibleTableRows ni dans CremeDeLaCremePanel)", () => {
  const state = simulateDashboardFlow(makePool(), { query: "" });
  assert.equal(state.visible.length, state.comboCandidateRows.length, "aucune limite implicite d'affichage");
});

test("TEST 11 — filtre purement visuel (filtre Mode UI) : affichage différent, portefeuille identique", () => {
  const all = simulateDashboardFlow(makePool(), { filter: "all" });
  const safeOnly = simulateDashboardFlow(makePool(), { filter: "SAFE" });
  const aggOnly = simulateDashboardFlow(makePool(), { filter: "AGGRESSIVE" });
  assert.equal(all.visible.length, 4);
  assert.equal(safeOnly.visible.length, 4, "toutes les lignes fixtures affichent SAFE");
  assert.equal(aggOnly.visible.length, 0, "aucune ligne AGGRESSIVE → tableau vide");
  assert.deepEqual(fingerprintCombos(all.combos), baselineFp);
  assert.deepEqual(fingerprintCombos(safeOnly.combos), baselineFp);
  assert.deepEqual(fingerprintCombos(aggOnly.combos), baselineFp, "le filtre Mode UI ne touche pas le pool moteur");
});

test("TEST 12 — filtre métier réel (expiration sélectionnée) : le pool combo change légitimement", () => {
  const pool = makePool();
  pool[2] = makeCandidate({
    ticker: "ORCL", name: "Oracle Corporation", proFinalScore: 0.85, qualityScore: 85,
    weeklyReturn: 0.55, spreadPct: 11, targetExpiration: "2026-07-24",
  });
  const expA = simulateDashboardFlow(pool, { selectedExpiration: "2026-07-17" });
  const expB = simulateDashboardFlow(pool, { selectedExpiration: "2026-07-24" });
  assert.deepEqual(poolTickers(expA), ["AAPL", "MSFT", "SOFI"], "expiration A exclut ORCL du pool");
  assert.deepEqual(poolTickers(expB), ["ORCL"], "expiration B ne garde qu'ORCL");
  assert.notDeepEqual(fingerprintCombos(expA.combos), fingerprintCombos(expB.combos), "le filtre métier change le portefeuille");
});

test("TEST 13 — ticker explicitement bloqué (ibkrRejectedSymbols) : retiré du pool moteur, règle préservée", () => {
  const blockedTicker = baselineFp.SAFE.picks[0].ticker;
  const state = simulateDashboardFlow(makePool(), {}, { ibkrRejectedSymbols: new Set([blockedTicker]) });
  const fp = fingerprintCombos(state.combos);
  const pickedTickers = (fp.SAFE?.picks ?? []).map((p) => p.ticker);
  assert.ok(!pickedTickers.includes(blockedTicker), `${blockedTicker} exclu du portefeuille`);
  assert.notDeepEqual(fp, baselineFp, "l'exclusion métier change bien la combinaison");
});

test("TEST 14 — buckets SAFE / AGGRESSIVE : la recherche ne change aucun bucket ; les buckets diffèrent entre eux", () => {
  const noSearch = simulateDashboardFlow(makePool(), { query: "" });
  const withSearch = simulateDashboardFlow(makePool(), { query: "ORCL" });
  const fpA = fingerprintCombos(noSearch.combos);
  const fpB = fingerprintCombos(withSearch.combos);
  assert.deepEqual(fpA.SAFE, fpB.SAFE, "bucket SAFE invariant sous recherche");
  assert.deepEqual(fpA.AGGRESSIVE, fpB.AGGRESSIVE, "bucket AGGRESSIVE invariant sous recherche");
  assert.notDeepEqual(fpA.SAFE, fpA.AGGRESSIVE, "changer volontairement de bucket change la combinaison");
});

test("TEST 15 — capital différent : le portefeuille peut légitimement changer (le patch ne gèle pas la combinaison)", () => {
  const capA = simulateDashboardFlow(makePool(), {}, { maxCapitalPct: 20 });
  const capB = simulateDashboardFlow(makePool(), {}, { maxCapitalPct: 40 });
  assert.notDeepEqual(fingerprintCombos(capA.combos), fingerprintCombos(capB.combos), "capital utilisable différent ⇒ empreinte différente");
});

test("TEST 16 — empreinte financière strictement identique pour chaque recherche", () => {
  for (const q of ["", "TQQQ", "AAPL", "MSFT", "ORCL", "SOFI", "apple", "zzz", " sofi "]) {
    const state = simulateDashboardFlow(makePool(), { query: q });
    assert.deepEqual(fingerprintCombos(state.combos), baselineFp, `empreinte invariante pour query="${q}"`);
  }
});

test("TEST 17 — aucun candidat visible : tableau vide, portefeuille toujours calculé depuis le pool canonique", () => {
  const state = simulateDashboardFlow(makePool(), { query: "ZZZZ_NOT_FOUND" });
  assert.equal(state.visible.length, 0, "le tableau affichera « Aucun résultat »");
  assert.ok((fingerprintCombos(state.combos).SAFE?.picks ?? []).length > 0, "le portefeuille reste calculé");
});

test("TEST 18 — ordre d'entrée inversé : AF-05 préservée, portefeuille identique", () => {
  const state = simulateDashboardFlow(makePool().reverse());
  assert.deepEqual(fingerprintCombos(state.combos), baselineFp);
});

test("TEST 19 — aucune mutation : pool canonique deep-freezé, aucun tri en place, aucune exception", () => {
  const enriched = deepFreeze(makePool());
  const comboCandidateRows = deepFreeze(
    buildComboCandidatePool(enriched, { selectedExpiration: SELECTED_EXPIRATION })
  );
  const orderBefore = comboCandidateRows.map((c) => c.ticker);
  const visible = buildVisibleTableRows(comboCandidateRows, {
    query: "", modeFilter: "all", sortBy: "quality", sortOrder: "asc",
    dataSource: "snapshot", getSpreadPct: spreadStub,
  });
  const combos = buildPortfolioCombos(comboCandidateRows, CAPITAL, MAX_CAPITAL_PCT, MAX_POSITIONS, new Set(), {
    optimizerV2: { leftoverDensityPassEnabled: false },
  });
  assert.deepEqual(comboCandidateRows.map((c) => c.ticker), orderBefore, "ordre canonique intact (tri sur copie)");
  assert.deepEqual(visible.map((c) => c.ticker), ["SOFI", "ORCL", "MSFT", "AAPL"], "tri visible appliqué sur la copie");
  assert.deepEqual(fingerprintCombos(combos), baselineFp);
});

test("TEST 20 — répétition ×20 : empreinte combo et résultats visibles déterministes", () => {
  const searches = ["", "ORCL", "apple", "ZZZZ_NOT_FOUND"];
  const referenceVisible = searches.map((q) => visibleTickers(simulateDashboardFlow(makePool(), { query: q })));
  for (let i = 0; i < 20; i += 1) {
    searches.forEach((q, j) => {
      const state = simulateDashboardFlow(makePool(), { query: q });
      assert.deepEqual(visibleTickers(state), referenceVisible[j]);
      assert.deepEqual(fingerprintCombos(state.combos), baselineFp);
    });
  }
});

test("AF-06 unitaire — rowMatchesSearchQuery : trim + casse + nom + ticker", () => {
  const row = { ticker: "ORCL", name: "Oracle Corporation" };
  assert.equal(rowMatchesSearchQuery(row, ""), true);
  assert.equal(rowMatchesSearchQuery(row, "   "), true);
  assert.equal(rowMatchesSearchQuery(row, "orcl"), true);
  assert.equal(rowMatchesSearchQuery(row, " ORCL "), true);
  assert.equal(rowMatchesSearchQuery(row, "oracle corp"), true);
  assert.equal(rowMatchesSearchQuery(row, "AAPL"), false);
  assert.equal(rowMatchesSearchQuery({ ticker: "X" }, "x"), true, "nom manquant toléré");
});
