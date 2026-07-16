import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BALANCED_LEG_SOURCES,
  buildPortfolioCombos,
  getCanonicalPeriodYieldBand,
  getLegPopPct,
  resolveBalancedLegSelection,
} from "./capitalComboPortfolio.js";
import {
  resolveBalancedCardViewModel,
  weightedMeanByCapitalExcludingUnknown,
} from "./balancedModeUi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");

const EXP = "2026-07-31";

function askForSpread(bid, spreadPct = 8) {
  return bid * (spreadPct + 200) / (200 - spreadPct);
}

/**
 * Contrat intermédiaire tel qu'il arrive dans la chaîne IBKR brute
 * (`ibkrDirect.putCandidates`) : strike/bid/ask/mid/delta, mais AUCUN champ POP.
 */
function rawIbkrPut(strike, periodYieldPct, { ticker = "TQQQ", spreadPct = 8, delta = -0.15 } = {}) {
  const bid = (strike * periodYieldPct) / 100;
  const ask = askForSpread(bid, spreadPct);
  return {
    ticker,
    symbol: ticker,
    expiration: EXP,
    right: "PUT",
    optionType: "PUT",
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    dteDays: 7,
    distancePct: -8,
    delta,
    volume: 500,
    openInterest: 1000,
    optionSymbol: `${ticker}  ${strike}P`,
    conId: strike * 10,
    contractId: strike * 100,
    quoteTimestamp: "2026-07-14T15:00:00Z",
    marketDataType: "live",
    quoteSource: "IBKR",
  };
}

/**
 * Même strike, mais enrichi par le scanner (`balancedPutCandidates`) : porte la
 * POP réellement calculée pour ce contrat. C'est la source à transporter.
 */
function scannerBalancedPut(strike, periodYieldPct, { ticker = "TQQQ", spreadPct = 8, popEstimate = 0.92 } = {}) {
  const bid = (strike * periodYieldPct) / 100;
  const ask = askForSpread(bid, spreadPct);
  return {
    ticker,
    symbol: ticker,
    expiration: EXP,
    right: "PUT",
    optionType: "PUT",
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    dteDays: 7,
    distancePct: -8,
    popEstimate,
    popModel: "lognormal_iv_v1_bid",
    volume: 500,
    openInterest: 1000,
    optionSymbol: `${ticker}-${strike}-P`,
    conId: strike * 10,
    contractId: strike * 100,
    quoteSource: "IBKR",
  };
}

/** Jambe SAFE/AGGRESSIVE réelle : porte sa propre POP (via merge applyPop). */
function sideLeg(strike, periodYieldPct, pop, { ticker = "TQQQ", optionSymbol } = {}) {
  const bid = (strike * periodYieldPct) / 100;
  const ask = askForSpread(bid, 8);
  return {
    ticker,
    symbol: ticker,
    expiration: EXP,
    right: "PUT",
    optionType: "PUT",
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    dteDays: 7,
    distancePct: -8,
    popProfitEstimated: pop,
    popEstimate: pop,
    popSource: "IBKR expected move",
    optionSymbol: optionSymbol ?? `${ticker}-${strike}`,
    conId: strike,
    contractId: strike,
    quoteSource: "IBKR",
  };
}

/**
 * Candidat façon IBKR live mergé : la chaîne native provient du brut IBKR (sans
 * POP), tandis que la POP réelle du même strike existe dans `balancedPutCandidates`.
 */
function mergedNativeCandidate({
  ticker = "TQQQ",
  safeStrike = 67,
  aggressiveStrike = 75,
  nativeStrike = 70,
  nativeYield = 0.875,
  nativePop = 0.92,
  safePop = 0.99,
  aggressivePop = 0.6,
  withEnrichedChain = true,
} = {}) {
  return {
    ticker,
    symbol: ticker,
    targetExpiration: EXP,
    dteDays: 7,
    price: 100,
    safeStrike: sideLeg(safeStrike, 0.74, safePop, { ticker, optionSymbol: `${ticker}-SAFE` }),
    aggressiveStrike: sideLeg(aggressiveStrike, 1.0, aggressivePop, { ticker, optionSymbol: `${ticker}-AGG` }),
    safeGrade: "A",
    aggressiveGrade: "A",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
    optionsSource: "IBKR live",
    balancedPutChainAvailable: true,
    // Chaîne enrichie scanner (avec POP) — présente sauf variante de contrôle.
    balancedPutCandidates: withEnrichedChain
      ? [scannerBalancedPut(nativeStrike, nativeYield, { ticker, popEstimate: nativePop })]
      : undefined,
    // Chaîne IBKR brute (sans POP) — prioritaire dans resolveBalancedChainInput.
    ibkrDirect: { putCandidates: [rawIbkrPut(nativeStrike, nativeYield, { ticker })], expiration: EXP },
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 0.8,
  };
}

function balancedComboFor(candidate, capital = 100000) {
  const combos = buildPortfolioCombos([candidate], capital, 100, 10, new Set(), { optimizerV2: {} });
  const combo = combos.find((c) => c.label === "BALANCED") ?? null;
  return { combo, pick: combo?.picks?.find((p) => p.ticker === candidate.ticker) ?? null, combos };
}

// ── Part A — transport POP native ───────────────────────────────────────────

test("1 — la jambe native transporte popProfitEstimated réel (jamais perdu)", () => {
  const engine = resolveBalancedLegSelection({ candidate: mergedNativeCandidate() });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedStrike, 70);
  assert.equal(engine.selectedLeg.popProfitEstimated, 0.92);
});

test("2 — la jambe native transporte popEstimate réel", () => {
  const engine = resolveBalancedLegSelection({ candidate: mergedNativeCandidate() });
  assert.equal(engine.selectedLeg.popEstimate, 0.92);
  assert.equal(getLegPopPct(engine.selectedLeg), 92);
});

test("3 — la jambe native conserve un popSource explicite", () => {
  const engine = resolveBalancedLegSelection({ candidate: mergedNativeCandidate() });
  assert.equal(engine.selectedLeg.popSource, "scanner_balanced_chain");
  assert.equal(engine.selectedLeg.popDecimal, 0.92);
  assert.equal(engine.selectedLeg.popPct, 92);
});

test("4 — fallback SAFE utilise la POP réelle de la jambe SAFE", () => {
  // Pas de chaîne native ⇒ fallback ; SAFE la plus proche du centre de bande.
  const candidate = mergedNativeCandidate({ safePop: 0.97, aggressivePop: 0.55, withEnrichedChain: false });
  candidate.ibkrDirect = { putCandidates: [], expiration: EXP };
  candidate.safeStrike = sideLeg(67, 0.8, 0.97, { optionSymbol: "TQQQ-SAFE" });
  candidate.aggressiveStrike = sideLeg(75, 1.2, 0.55, { optionSymbol: "TQQQ-AGG" });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.popDecimal, 0.97);
  assert.equal(view.popPct, 97);
});

test("5 — fallback AGGRESSIVE utilise la POP réelle de la jambe AGGRESSIVE", () => {
  const candidate = mergedNativeCandidate({ withEnrichedChain: false });
  candidate.ibkrDirect = { putCandidates: [], expiration: EXP };
  candidate.safeStrike = sideLeg(67, 0.5, 0.99, { optionSymbol: "TQQQ-SAFE" });
  candidate.aggressiveStrike = sideLeg(75, 0.9, 0.83, { optionSymbol: "TQQQ-AGG" });
  candidate.safeStrike.ask = askForSpread(candidate.safeStrike.bid, 30);
  candidate.safeStrike.mid = (candidate.safeStrike.bid + candidate.safeStrike.ask) / 2;
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE);
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.popDecimal, 0.83);
  assert.equal(view.popPct, 83);
});

test("6 — POP réellement absente reste null (aucune source disponible)", () => {
  const candidate = mergedNativeCandidate({ withEnrichedChain: false });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engine.selectedLeg.popProfitEstimated, null);
  assert.equal(engine.selectedLeg.popEstimate, null);
  assert.equal(engine.selectedLeg.popSource, null);
  assert.equal(getLegPopPct(engine.selectedLeg), null);
});

test("7 — POP absente ne devient jamais 0 (ni carte ni pick)", () => {
  const candidate = mergedNativeCandidate({ withEnrichedChain: false });
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.popDecimal, null);
  assert.equal(view.popPct, null);
  assert.notEqual(view.popDecimal, 0);
  const { pick } = balancedComboFor(candidate);
  assert.ok(pick, "pick BALANCED attendu");
  assert.equal(pick.popEstimate, null);
  assert.notEqual(pick.popEstimate, 0);
});

test("8 — la carte native affiche la POP réelle", () => {
  const view = resolveBalancedCardViewModel({ candidate: mergedNativeCandidate() });
  assert.equal(view.available, true);
  assert.equal(view.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(view.popDecimal, 0.92);
  assert.equal(view.popPct, 92);
});

test("9 — le pick BALANCED contient la POP réelle (pourcentage)", () => {
  const { pick } = balancedComboFor(mergedNativeCandidate());
  assert.ok(pick, "pick BALANCED attendu");
  assert.equal(pick.strike, 70);
  assert.equal(Math.round(Number(pick.popEstimate)), 92);
});

test("10 — la ligne du portefeuille reçoit la POP de la jambe retenue", () => {
  const { pick } = balancedComboFor(mergedNativeCandidate());
  // La ligne du portefeuille rend Math.round(pick.popEstimate) %.
  assert.ok(Number.isFinite(Number(pick.popEstimate)));
  assert.equal(`${Math.round(Number(pick.popEstimate))} %`, "92 %");
});

test("11 — la moyenne exclut une POP inconnue (jamais comptée 0)", () => {
  const picks = [
    { popEstimate: 94, capitalUsed: 7000 },
    { popEstimate: 94, capitalUsed: 7000 },
    { popEstimate: 95, capitalUsed: 7000 },
    { popEstimate: null, capitalUsed: 7000 },
  ];
  const avg = weightedMeanByCapitalExcludingUnknown(picks, (p) => p.popEstimate, (p) => p.capitalUsed);
  assert.ok(Math.abs(avg - 94.3333) < 1e-3, `attendu 94,3 obtenu ${avg}`);
  assert.ok(avg > 90, "une POP inconnue comptée 0 donnerait ~70,8");
});

test("12 — la moyenne de quatre POP connues est correcte", () => {
  const picks = [
    { popEstimate: 90, capitalUsed: 5000 },
    { popEstimate: 92, capitalUsed: 5000 },
    { popEstimate: 94, capitalUsed: 5000 },
    { popEstimate: 96, capitalUsed: 5000 },
  ];
  const avg = weightedMeanByCapitalExcludingUnknown(picks, (p) => p.popEstimate, (p) => p.capitalUsed);
  assert.equal(avg, 93);
  // aucune ligne connue ⇒ null, jamais 0
  assert.equal(
    weightedMeanByCapitalExcludingUnknown([{ popEstimate: null, capitalUsed: 100 }], (p) => p.popEstimate, (p) => p.capitalUsed),
    null,
  );
});

test("13 — aucune POP synthétique depuis SAFE/AGGRESSIVE pour une native", () => {
  // POP native distincte (0,92) de SAFE (0,99) et AGGRESSIVE (0,60).
  const engine = resolveBalancedLegSelection({
    candidate: mergedNativeCandidate({ nativePop: 0.92, safePop: 0.99, aggressivePop: 0.6 }),
  });
  assert.equal(engine.selectedLeg.popProfitEstimated, 0.92);
  assert.notEqual(engine.selectedLeg.popProfitEstimated, 0.99);
  assert.notEqual(engine.selectedLeg.popProfitEstimated, 0.6);
  // Sans chaîne enrichie, la native ne récupère PAS la POP SAFE/AGG : elle reste null.
  const engineNoPop = resolveBalancedLegSelection({
    candidate: mergedNativeCandidate({ withEnrichedChain: false, safePop: 0.99, aggressivePop: 0.6 }),
  });
  assert.equal(engineNoPop.source, BALANCED_LEG_SOURCES.NATIVE);
  assert.equal(engineNoPop.selectedLeg.popProfitEstimated, null);
});

// ── Non-régression — le transport POP ne change ni sélection ni scoring ──────

test("14 — aucun changement de strike (POP présente ou non)", () => {
  const withPop = resolveBalancedLegSelection({ candidate: mergedNativeCandidate({ withEnrichedChain: true }) });
  const withoutPop = resolveBalancedLegSelection({ candidate: mergedNativeCandidate({ withEnrichedChain: false }) });
  assert.equal(withPop.selectedStrike, 70);
  assert.equal(withoutPop.selectedStrike, 70);
  assert.equal(withPop.selectedStrike, withoutPop.selectedStrike);
});

test("15 — aucun changement des grades", () => {
  const withPop = balancedComboFor(mergedNativeCandidate({ withEnrichedChain: true })).pick;
  const withoutPop = balancedComboFor(mergedNativeCandidate({ withEnrichedChain: false })).pick;
  assert.equal(withPop.grade, withoutPop.grade);
  assert.equal(withPop.grade, "A");
});

test("16 — aucun changement des scores", () => {
  const withPop = balancedComboFor(mergedNativeCandidate({ withEnrichedChain: true })).pick;
  const withoutPop = balancedComboFor(mergedNativeCandidate({ withEnrichedChain: false })).pick;
  assert.equal(withPop.selectionScore, withoutPop.selectionScore);
  assert.equal(withPop.proScoreSource, withoutPop.proScoreSource);
});

test("17 — aucun changement du greedy (positions, tickers, contrats)", () => {
  const a = balancedComboFor(mergedNativeCandidate({ withEnrichedChain: true })).combo;
  const b = balancedComboFor(mergedNativeCandidate({ withEnrichedChain: false })).combo;
  assert.equal(a.positions, b.positions);
  assert.deepEqual(a.picks.map((p) => p.ticker), b.picks.map((p) => p.ticker));
  assert.deepEqual(a.picks.map((p) => p.contracts), b.picks.map((p) => p.contracts));
  assert.deepEqual(a.balancedLegSourceCounts, b.balancedLegSourceCounts);
});

test("18 — aucun changement des bandes DTE", () => {
  const withPop = resolveBalancedLegSelection({ candidate: mergedNativeCandidate({ withEnrichedChain: true }) });
  const withoutPop = resolveBalancedLegSelection({ candidate: mergedNativeCandidate({ withEnrichedChain: false }) });
  const band7 = getCanonicalPeriodYieldBand("BALANCED", 7);
  assert.equal(withPop.effectivePeriodMinPct, band7.effectivePeriodMinPct);
  assert.equal(withPop.effectivePeriodMaxPct, band7.effectivePeriodMaxPct);
  assert.equal(withPop.effectivePeriodMinPct, withoutPop.effectivePeriodMinPct);
  assert.equal(withPop.effectivePeriodMaxPct, withoutPop.effectivePeriodMaxPct);
});

// ── Cas exacts du ticket ────────────────────────────────────────────────────

test("TQQQ — BALANCED native strike 70 : POP visible bout en bout", () => {
  const candidate = mergedNativeCandidate({ ticker: "TQQQ", safeStrike: 67, aggressiveStrike: 75, nativeStrike: 70 });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.selectedStrike, 70);
  assert.equal(engine.selectedLeg.popProfitEstimated, 0.92);
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.popPct, 92);
  const { pick } = balancedComboFor(candidate);
  assert.equal(Math.round(Number(pick.popEstimate)), 92);
});

test("INTC — BALANCED native strike 99 : POP visible bout en bout", () => {
  const candidate = mergedNativeCandidate({
    ticker: "INTC",
    safeStrike: 97.5,
    aggressiveStrike: 102,
    nativeStrike: 99,
    nativePop: 0.9,
  });
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.selectedStrike, 99);
  assert.equal(engine.selectedLeg.popProfitEstimated, 0.9);
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.popPct, 90);
});

// ── Part B — carte BALANCED disponible sans détails techniques ───────────────

test("UI — la carte BALANCED disponible ne rend plus les détails techniques", () => {
  const fnStart = DASHBOARD.indexOf("function BalancedFaceplateStrikeColumn");
  const fnEnd = DASHBOARD.indexOf("function MiniTradeLevelsChart", fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, "fonction carte BALANCED introuvable");
  const fnSource = DASHBOARD.slice(fnStart, fnEnd);
  // Branche « disponible » : tout ce qui suit le retour anticipé indisponible.
  const availableStart = fnSource.indexOf("const strikeData = {");
  assert.ok(availableStart > 0, "branche disponible introuvable");
  const availableSource = fnSource.slice(availableStart);

  for (const forbidden of ["Milieu", "BALANCED retenu", "Cible effective", "option ", "conId", "contractId"]) {
    assert.ok(
      !availableSource.includes(forbidden),
      `la carte BALANCED disponible ne doit plus rendre « ${forbidden} »`,
    );
  }
  // Les métriques utilisateur essentielles restent présentes.
  assert.ok(availableSource.includes("POP estimée") || DASHBOARD.includes('label: "POP estimée"'));
  assert.ok(!availableSource.includes('label: "Grade réel"'));
  assert.ok(!availableSource.includes('label: "Expiration"'));
  assert.ok(!availableSource.includes('label: "Capital requis"'));
  assert.ok(!availableSource.includes('label: "Source quote"'));
  // Les diagnostics techniques restent disponibles sur la carte INDISPONIBLE.
  const unavailableSource = fnSource.slice(0, availableStart);
  assert.ok(unavailableSource.includes("Milieu"), "diagnostics conservés pour la carte indisponible");
});
