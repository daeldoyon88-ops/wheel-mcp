/**
 * POP live des jambes BALANCED — appariement canonique et enrichissement réel.
 *
 * Contexte mesuré en live (scan IBKR réel, expiration 2026-07-17) :
 *  - `/scan_shortlist` renvoie `liquiditySource: "yahoo_unreliable"` =>
 *    `safeStrike: null`, `aggressiveStrike: null`, `balancedPutCandidates: []` ;
 *  - `/ibkr/shadow/scan` renvoie `putCandidates` SANS expiration, SANS ticker,
 *    SANS right et SANS aucun champ POP (strike/bid/ask/mid/conId/localSymbol/delta) ;
 *  - la jambe BALANCED native est choisie dans cette chaîne IBKR brute.
 *
 * La POP native ne pouvait donc jamais être transportée : le fixture historique
 * (`balanced-pop-transport`) supposait une chaîne enrichie non vide, plus riche que
 * les vraies données live. `mergeIbkrIntoDashboardCandidate` enrichit désormais
 * chaque put IBKR avec la POP de SON PROPRE contrat, via la même fonction canonique
 * que SAFE/AGGRESSIVE (`estimateShortPutPopFromExpectedMove`, niveau = strike − prime).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BALANCED_LEG_SOURCES,
  buildPortfolioCombos,
  resolveBalancedLegSelection,
} from "./capitalComboPortfolio.js";
import {
  resolveBalancedCardViewModel,
  weightedMeanByCapitalExcludingUnknown,
} from "./balancedModeUi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");

const EXP_ISO = "2026-07-17";
const EXP_COMPACT = "20260717";

// ── Réplique exacte du modèle POP canonique de dashboard.jsx (SAFE/AGG/chaîne) ──

function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const prob =
    1 -
    d *
      (0.31938153 * t -
        0.356563782 * t ** 2 +
        1.781477937 * t ** 3 -
        1.821255978 * t ** 4 +
        1.330274429 * t ** 5);
  return x >= 0 ? prob : 1 - prob;
}

function estimateShortPutPopFromExpectedMove({ spot, level, expectedMove }) {
  const s = Number(spot);
  const l = Number(level);
  const em = Number(expectedMove);
  if (!(s > 0) || !(l > 0) || !(em > 0)) return null;
  const sigmaPeriod = em / s;
  if (!(sigmaPeriod > 0)) return null;
  const z = (Math.log(s / l) - 0.5 * sigmaPeriod * sigmaPeriod) / sigmaPeriod;
  const pop = normalCdf(z);
  return Number.isFinite(pop) ? Math.max(0, Math.min(1, pop)) : null;
}

/** Enrichissement POP de la chaîne IBKR — même logique que le merge du dashboard. */
function enrichIbkrPutCandidates(putCandidates, { spot, expectedMove }) {
  return putCandidates.map((put) => {
    const strike = Number(put?.strike);
    const rawPu = put?.primeUsed ?? put?.bid;
    const premiumUsed = Number.isFinite(Number(rawPu)) ? Number(rawPu) : null;
    const popProfitEstimated =
      premiumUsed == null || !Number.isFinite(strike)
        ? null
        : estimateShortPutPopFromExpectedMove({ spot, level: strike - premiumUsed, expectedMove });
    if (popProfitEstimated == null) return put;
    return { ...put, popProfitEstimated, popSource: "IBKR expected move" };
  });
}

// ── Fixtures : formes réellement observées ──────────────────────────────────

/**
 * Put IBKR brut tel que réellement reçu : ni expiration, ni ticker, ni right,
 * ni POP. `localSymbol` au format IBKR (« INTC  260717P00099000 »).
 */
function rawIbkrPut({ ticker, strike, bid, ask }) {
  const pad = String(Math.round(strike * 1000)).padStart(8, "0");
  return {
    strike,
    bid,
    ask,
    mid: (bid + ask) / 2,
    primeUsed: bid,
    premiumYield: bid / strike,
    conId: Math.round(strike * 1000) + 800000000,
    localSymbol: `${ticker.padEnd(6, " ")}260717P${pad}`,
    tradingClass: ticker,
    exchange: "SMART",
    currency: "USD",
    multiplier: "100",
    delta: -0.16,
    impliedVolatility: 0.68,
    volume: 500,
    openInterest: 1000,
  };
}

/** Jambe SAFE/AGGRESSIVE après `applyPop` du merge : porte sa propre POP live. */
function sideLeg({ ticker, strike, bid, ask, spot, expectedMove }) {
  const raw = rawIbkrPut({ ticker, strike, bid, ask });
  const pop = estimateShortPutPopFromExpectedMove({ spot, level: strike - bid, expectedMove });
  return {
    ...raw,
    popProfitEstimated: pop,
    popEstimate: null, // Yahoo indisponible en live => fallbackPop null
    popSource: pop != null ? "IBKR expected move" : null,
  };
}

/**
 * Candidat mergé live : Yahoo sans liquidité (`balancedPutCandidates: []`),
 * chaîne IBKR brute enrichie au merge, SAFE/AGG IBKR avec POP.
 */
function liveMergedCandidate({
  ticker,
  spot,
  expectedMove,
  safe,
  aggressive,
  intermediates,
  enrichChain = true,
  balancedPutCandidates = [],
}) {
  const rawPuts = [aggressive, ...intermediates, safe].map((p) => rawIbkrPut({ ticker, ...p }));
  const putCandidates = enrichChain
    ? enrichIbkrPutCandidates(rawPuts, { spot, expectedMove })
    : rawPuts;
  return {
    ticker,
    symbol: ticker,
    targetExpiration: EXP_ISO,
    dteDays: 2,
    price: spot,
    currentPrice: spot,
    noYahooLiquidity: true,
    liquiditySource: "yahoo_unreliable",
    balancedPutChainAvailable: true,
    balancedPutCandidates,
    safeStrike: sideLeg({ ticker, ...safe, spot, expectedMove }),
    aggressiveStrike: sideLeg({ ticker, ...aggressive, spot, expectedMove }),
    safeGrade: "A",
    aggressiveGrade: "A",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
    optionsSource: "IBKR live",
    ibkrDirect: { putCandidates, expiration: EXP_ISO },
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 0.8,
  };
}

/** INTC — SAFE 97,5 / AGG 102 / natif 99 (valeurs live du 2026-07-15). */
const INTC = () =>
  liveMergedCandidate({
    ticker: "INTC",
    spot: 110,
    expectedMove: 7.49,
    safe: { strike: 97.5, bid: 0.67, ask: 0.72 },
    aggressive: { strike: 102, bid: 1.54, ask: 1.62 },
    intermediates: [
      { strike: 101, bid: 1.29, ask: 1.41 },
      { strike: 100, bid: 1.08, ask: 1.14 },
      { strike: 99, bid: 0.89, ask: 0.97 },
    ],
  });

/** ORCL — SAFE 121 / AGG 123 / natif 122. */
const ORCL = () =>
  liveMergedCandidate({
    ticker: "ORCL",
    spot: 129.14,
    expectedMove: 5.859,
    safe: { strike: 121, bid: 0.74, ask: 0.8 },
    aggressive: { strike: 123, bid: 1.16, ask: 1.22 },
    intermediates: [{ strike: 122, bid: 0.94, ask: 1.0 }],
  });

/** TQQQ — SAFE 69 / AGG 72 / natif 70. */
const TQQQ = () =>
  liveMergedCandidate({
    ticker: "TQQQ",
    spot: 75.815,
    expectedMove: 3.3855,
    safe: { strike: 69, bid: 0.38, ask: 0.42 },
    aggressive: { strike: 72, bid: 0.82, ask: 0.88 },
    intermediates: [
      { strike: 71, bid: 0.63, ask: 0.69 },
      { strike: 70, bid: 0.49, ask: 0.53 },
    ],
  });

/** NOW — SAFE 99 / AGG 101 / natif 100. NOW est bien NATIVE en live, pas fallback. */
const NOW = () =>
  liveMergedCandidate({
    ticker: "NOW",
    spot: 105.885,
    expectedMove: 4.8695,
    safe: { strike: 99, bid: 0.57, ask: 0.65 },
    aggressive: { strike: 101, bid: 0.98, ask: 1.05 },
    intermediates: [{ strike: 100, bid: 0.77, ask: 0.84 }],
  });

function balancedComboFor(candidate, capital = 100000) {
  const combos = buildPortfolioCombos([candidate], capital, 100, 10, new Set(), { optimizerV2: {} });
  const combo = combos.find((c) => c.label === "BALANCED") ?? null;
  return { combo, pick: combo?.picks?.find((p) => p.ticker === candidate.ticker) ?? null };
}

/** Chaîne enrichie scanner (Yahoo) — pour les cas d'appariement canonique. */
function enrichedEntry(overrides = {}) {
  return {
    ticker: "INTC",
    symbol: "INTC",
    expiration: EXP_ISO,
    right: "PUT",
    optionType: "PUT",
    strike: 99,
    popEstimate: 0.777,
    popModel: "lognormal_iv_v1_bid",
    optionSymbol: "INTC260717P00099000",
    localSymbol: "INTC  260717P00099000",
    ...overrides,
  };
}

/** Candidat dont la chaîne IBKR n'est PAS enrichie : force l'appariement Yahoo. */
function matchingCandidate(entry, rowOverrides = {}) {
  const c = liveMergedCandidate({
    ticker: "INTC",
    spot: 110,
    expectedMove: 7.49,
    safe: { strike: 97.5, bid: 0.67, ask: 0.72 },
    aggressive: { strike: 102, bid: 1.54, ask: 1.62 },
    intermediates: [{ strike: 99, bid: 0.89, ask: 0.97 }],
    enrichChain: false,
    balancedPutCandidates: entry === null ? [] : [entry],
  });
  if (Object.keys(rowOverrides).length) {
    c.ibkrDirect.putCandidates = c.ibkrDirect.putCandidates.map((p) =>
      Number(p.strike) === 99 ? { ...p, ...rowOverrides } : p,
    );
  }
  return c;
}

function nativeLegOf(candidate) {
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.NATIVE, "jambe native attendue");
  return engine.selectedLeg;
}

// ── Part A — appariement canonique de la chaîne enrichie ────────────────────

test("1 — expiration compacte 20260717 correspond à 2026-07-17", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ expiration: EXP_COMPACT })));
  assert.equal(leg.popEstimate, 0.777);
  assert.equal(leg.popMatchStatus, "matched");
});

test("2 — strike \"99\" (chaîne) correspond à 99 (nombre)", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ strike: "99" })));
  assert.equal(leg.popEstimate, 0.777);
  assert.equal(leg.strike, 99);
});

test("3 — ticker porté par `ticker` correspond au même ticker porté par `symbol`", () => {
  const entry = enrichedEntry();
  delete entry.ticker; // seul `symbol` renseigné côté enrichi
  const leg = nativeLegOf(matchingCandidate(entry));
  assert.equal(leg.popEstimate, 0.777);
});

test("4 — right=\"P\" correspond à optionType=\"PUT\"", () => {
  const entry = enrichedEntry({ right: "P", optionType: undefined });
  const leg = nativeLegOf(matchingCandidate(entry, { right: "P" }));
  assert.equal(leg.popEstimate, 0.777);
});

test("5 — un localSymbol différent ne bloque pas un contrat économiquement identique", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ localSymbol: "INTC_2026-07-17_P99" })));
  assert.equal(leg.popEstimate, 0.777);
});

test("6 — un optionSymbol différent ne bloque pas un contrat économiquement identique", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ optionSymbol: "INTC-99-PUT-2026" })));
  assert.equal(leg.popEstimate, 0.777);
});

test("7 — même strike mais expiration différente ne matche pas", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ expiration: "2026-07-24" })));
  assert.equal(leg.popEstimate, null);
  assert.equal(leg.popMatchStatus, "unmatched");
  assert.equal(leg.popMatchReason, "no_enriched_contract");
});

test("8 — même strike mais ticker différent ne matche pas", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ ticker: "AMD", symbol: "AMD" })));
  assert.equal(leg.popEstimate, null);
  assert.equal(leg.popMatchStatus, "unmatched");
});

test("9 — même strike mais CALL ne matche pas", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ right: "C", optionType: "CALL" })));
  assert.equal(leg.popEstimate, null);
  assert.equal(leg.popMatchStatus, "unmatched");
});

test("10 — un contrat enrichi avec POP transporte cette POP", () => {
  const leg = nativeLegOf(matchingCandidate(enrichedEntry({ popEstimate: 0.913 })));
  assert.equal(leg.popEstimate, 0.913);
  assert.equal(leg.popDecimal, 0.913);
  assert.equal(leg.popPct, 91.3);
  assert.equal(leg.popMatchSource, "scanner_balanced_chain");
});

test("11 — un contrat enrichi sans POP laisse null (jamais 0)", () => {
  const entry = enrichedEntry();
  delete entry.popEstimate;
  const leg = nativeLegOf(matchingCandidate(entry));
  assert.equal(leg.popEstimate, null);
  assert.notEqual(leg.popEstimate, 0);
  assert.equal(leg.popMatchReason, "enriched_contract_without_pop");
});

// ── Part B — aucune contamination SAFE / AGGRESSIVE ─────────────────────────

test("12 — aucune copie depuis SAFE", () => {
  const candidate = matchingCandidate(null); // aucune chaîne enrichie
  const leg = nativeLegOf(candidate);
  assert.equal(leg.popEstimate, null);
  assert.notEqual(leg.popEstimate, candidate.safeStrike.popProfitEstimated);
});

test("13 — aucune copie depuis AGGRESSIVE", () => {
  const candidate = matchingCandidate(null);
  const leg = nativeLegOf(candidate);
  assert.equal(leg.popEstimate, null);
  assert.notEqual(leg.popEstimate, candidate.aggressiveStrike.popProfitEstimated);
});

// ── Part C — fallbacks ──────────────────────────────────────────────────────

/**
 * SAFE/AGGRESSIVE adjacents (aucun strike strictement entre les deux) => aucune
 * native possible => fallback. Rendements dans la bande effective BALANCED.
 */
function adjacentFallbackCandidate() {
  return liveMergedCandidate({
    ticker: "NOW",
    spot: 105.885,
    expectedMove: 4.8695,
    safe: { strike: 99, bid: 0.87, ask: 0.93 }, // 0,879 % — quasi au centre de bande
    aggressive: { strike: 100, bid: 1.04, ask: 1.1 }, // 1,04 % — dans la bande, plus loin du centre
    intermediates: [],
  });
}

test("14 — le fallback SAFE conserve sa POP SAFE", () => {
  const candidate = adjacentFallbackCandidate();
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.FALLBACK_SAFE);
  assert.equal(engine.selectedLeg.strike, 99);
  assert.equal(engine.selectedLeg.popProfitEstimated, candidate.safeStrike.popProfitEstimated);
  assert.ok(engine.selectedLeg.popProfitEstimated > 0);
});

test("15 — le fallback AGGRESSIVE conserve sa POP AGGRESSIVE", () => {
  const candidate = adjacentFallbackCandidate();
  candidate._hasSafeLegValid = false; // SAFE écartée => seule AGGRESSIVE reste éligible
  const engine = resolveBalancedLegSelection({ candidate });
  assert.equal(engine.source, BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE);
  assert.equal(engine.selectedLeg.strike, 100);
  assert.equal(
    engine.selectedLeg.popProfitEstimated,
    candidate.aggressiveStrike.popProfitEstimated,
  );
  assert.ok(engine.selectedLeg.popProfitEstimated > 0);
});

// ── Part D — la native conserve le contrat IBKR réel ────────────────────────

test("16 — la native conserve les quotes et IDs du contrat IBKR brut", () => {
  const candidate = INTC();
  const leg = nativeLegOf(candidate);
  const raw = candidate.ibkrDirect.putCandidates.find((p) => p.strike === 99);
  assert.equal(leg.strike, 99);
  assert.equal(leg.bid, raw.bid);
  assert.equal(leg.ask, raw.ask);
  assert.equal(leg.mid, raw.mid);
  assert.equal(leg.conId, raw.conId);
  assert.equal(leg.contractId, raw.conId);
  assert.equal(leg.localSymbol, raw.localSymbol);
  assert.equal(leg.quoteSource, "IBKR");
});

test("17 — la native prend la POP du contrat enrichi correspondant, pas d'un autre strike", () => {
  const candidate = INTC();
  const leg = nativeLegOf(candidate);
  const raw = candidate.ibkrDirect.putCandidates.find((p) => p.strike === 99);
  assert.equal(leg.popProfitEstimated, raw.popProfitEstimated);
  // POP strictement encadrée par SAFE (97,5) et AGGRESSIVE (102), et distincte des deux.
  assert.ok(leg.popProfitEstimated < candidate.safeStrike.popProfitEstimated);
  assert.ok(leg.popProfitEstimated > candidate.aggressiveStrike.popProfitEstimated);
});

test("18 — aucune modification de strike (INTC 99, ORCL 122, TQQQ 70, NOW 100)", () => {
  assert.equal(nativeLegOf(INTC()).strike, 99);
  assert.equal(nativeLegOf(ORCL()).strike, 122);
  assert.equal(nativeLegOf(TQQQ()).strike, 70);
  assert.equal(nativeLegOf(NOW()).strike, 100);
});

test("19 — aucune modification de grade", () => {
  const candidate = INTC();
  const before = { safe: candidate.safeGrade, agg: candidate.aggressiveGrade };
  resolveBalancedLegSelection({ candidate });
  assert.equal(candidate.safeGrade, before.safe);
  assert.equal(candidate.aggressiveGrade, before.agg);
});

test("20 — aucune modification de score", () => {
  const candidate = INTC();
  const before = {
    final: candidate.proFinalScore,
    exec: candidate.proExecutionScore,
    dist: candidate.proDistanceScore,
  };
  resolveBalancedLegSelection({ candidate });
  assert.equal(candidate.proFinalScore, before.final);
  assert.equal(candidate.proExecutionScore, before.exec);
  assert.equal(candidate.proDistanceScore, before.dist);
});

test("21 — aucune modification du greedy : le pick reste sur le strike natif", () => {
  const { pick } = balancedComboFor(INTC());
  assert.ok(pick, "pick BALANCED attendu");
  assert.equal(pick.strike, 99);
});

// ── Part E — carte, portefeuille, moyenne ───────────────────────────────────

test("22 — la moyenne POP exclut toujours les inconnues", () => {
  const picks = [
    { popEstimate: 95, capitalUsed: 9900 },
    { popEstimate: 92, capitalUsed: 12200 },
    { popEstimate: null, capitalUsed: 7000 },
  ];
  const avg = weightedMeanByCapitalExcludingUnknown(
    picks,
    (p) => p.popEstimate,
    (p) => p.capitalUsed,
  );
  assert.ok(avg > 92 && avg < 95, `moyenne attendue entre 92 et 95, obtenu ${avg}`);
  assert.equal(
    weightedMeanByCapitalExcludingUnknown(
      [{ popEstimate: null, capitalUsed: 100 }],
      (p) => p.popEstimate,
      (p) => p.capitalUsed,
    ),
    null,
  );
});

test("23 — la carte affiche la POP lorsqu'elle existe (INTC/ORCL/TQQQ/NOW)", () => {
  for (const build of [INTC, ORCL, TQQQ, NOW]) {
    const candidate = build();
    const view = resolveBalancedCardViewModel({ candidate });
    assert.equal(view.available, true, `${candidate.ticker} : carte disponible`);
    assert.equal(view.source, BALANCED_LEG_SOURCES.NATIVE, `${candidate.ticker} : native`);
    assert.ok(
      Number.isFinite(view.popPct) && view.popPct > 0,
      `${candidate.ticker} : POP attendue, obtenu ${view.popPct}`,
    );
  }
});

test("24 — le portefeuille affiche la même POP que la carte", () => {
  for (const build of [INTC, ORCL, TQQQ, NOW]) {
    const candidate = build();
    const view = resolveBalancedCardViewModel({ candidate });
    const { pick } = balancedComboFor(candidate);
    assert.ok(pick, `${candidate.ticker} : pick attendu`);
    assert.equal(pick.strike, view.strike, `${candidate.ticker} : même strike`);
    assert.ok(
      Math.abs(Number(pick.popEstimate) - view.popPct) < 1e-6,
      `${candidate.ticker} : carte ${view.popPct} vs portefeuille ${pick.popEstimate}`,
    );
  }
});

test("25 — aucune valeur 0 % produite depuis null", () => {
  // Sans expectedMove, la POP est incalculable : elle reste null, jamais 0.
  const candidate = INTC();
  candidate.ibkrDirect.putCandidates = candidate.ibkrDirect.putCandidates.map((p) => {
    const { popProfitEstimated, popSource, ...rest } = p;
    return rest;
  });
  candidate.balancedPutCandidates = [];
  const leg = nativeLegOf(candidate);
  assert.equal(leg.popEstimate, null);
  assert.equal(leg.popPct, null);
  assert.notEqual(leg.popPct, 0);
  const view = resolveBalancedCardViewModel({ candidate });
  assert.equal(view.popPct, null);
  assert.notEqual(view.popPct, 0);
});

// ── Part F — garde-fou sur le merge live (dashboard.jsx) ────────────────────

test("26 — le merge enrichit la chaîne IBKR avec la POP canonique SAFE/AGGRESSIVE", () => {
  assert.match(
    DASHBOARD,
    /const ibkrPutCandidatesWithPop = Array\.isArray\(ibkrCandidate\?\.putCandidates\)/,
    "le merge doit enrichir ibkrCandidate.putCandidates",
  );
  // Même fonction canonique que applyPop (SAFE/AGGRESSIVE) — aucune formule nouvelle.
  const enrichBlock = DASHBOARD.slice(
    DASHBOARD.indexOf("const ibkrPutCandidatesWithPop"),
    DASHBOARD.indexOf("const ibkrDirectWithPop"),
  );
  assert.match(enrichBlock, /estimateShortPutPopFromExpectedMove/);
  assert.match(enrichBlock, /level: strike - premiumUsed/);
  assert.doesNotMatch(enrichBlock, /1 - Math\.abs/, "aucune formule 1-|delta| improvisée");
  assert.match(DASHBOARD, /ibkrDirect: ibkrDirectWithPop/, "ibkrDirect doit porter la chaîne enrichie");
});
