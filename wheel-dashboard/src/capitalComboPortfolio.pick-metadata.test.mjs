import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  projectSelectedLegMetadata,
} from "./capitalComboPortfolio.js";

const OPTS = { optimizerV2: { leftoverDensityPassEnabled: false } };

function makeLeg({
  strike = 50,
  bid = 0.30,
  yieldPct = 0.60,
  spreadPct = 8,
  distancePct = -9,
  popDecimal = 0.9,
  expiration,
  dte,
  ask,
  mid,
  rank,
  finalRank,
  optionSymbol,
  conId,
  contractId,
  quoteTimestamp,
  marketDataType,
  quoteSource,
} = {}) {
  const premium = bid ?? (yieldPct * strike) / 100;
  const leg = {
    strike,
    bid: premium,
    ask: ask ?? premium * 1.05,
    premiumUsed: premium,
    mid: mid ?? premium,
    weeklyYield: yieldPct,
    distancePct,
    popProfitEstimated: popDecimal,
    liquidity: { spreadPct },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
  };
  if (expiration !== undefined) leg.expiration = expiration;
  if (dte !== undefined) leg.dte = dte;
  if (rank !== undefined) leg.rank = rank;
  if (finalRank !== undefined) leg.finalRank = finalRank;
  if (optionSymbol !== undefined) leg.optionSymbol = optionSymbol;
  if (conId !== undefined) leg.conId = conId;
  if (contractId !== undefined) leg.contractId = contractId;
  if (quoteTimestamp !== undefined) leg.quoteTimestamp = quoteTimestamp;
  if (marketDataType !== undefined) leg.marketDataType = marketDataType;
  if (quoteSource !== undefined) leg.quoteSource = quoteSource;
  return leg;
}

function makeCandidate({
  ticker = "AAPL",
  safe = null,
  agg = null,
  safeGrade = "A",
  aggressiveGrade = "A",
  finalDisplayMode = "SAFE",
  finalDisplayGrade = "A",
  targetExpiration = "2026-07-17",
  dteDays = 7,
  rank,
  finalRank,
} = {}) {
  const c = {
    ticker,
    safeStrike: safe,
    aggressiveStrike: agg,
    safeGrade,
    aggressiveGrade,
    finalDisplayMode,
    finalDisplayGrade,
    targetExpiration,
    expiration: targetExpiration,
    dteDays,
    currentPrice: 55,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    qualityScore: 0.85,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 1,
  };
  if (rank !== undefined) c.rank = rank;
  if (finalRank !== undefined) c.finalRank = finalRank;
  return c;
}

function pick(pool, label, ticker, options = {}) {
  const capital = options.capital ?? 100000;
  const maxPositions = options.maxPositions ?? 1;
  const combo = buildPortfolioCombos(pool, capital, 100, maxPositions, new Set(), { ...OPTS, ...options })
    .find((c) => c?.label === label);
  return combo?.picks?.find((p) => p.ticker === ticker) ?? null;
}

function deepFreeze(obj, seen = new Set()) {
  if (obj === null || typeof obj !== "object" || seen.has(obj)) return obj;
  seen.add(obj);
  for (const k of Object.keys(obj)) deepFreeze(obj[k], seen);
  return Object.freeze(obj);
}

const EXP_SAFE = "2026-07-17";
const EXP_AGG = "2026-07-24";

test("TEST 1 — expiration SAFE copiée", () => {
  const safe = makeLeg({ strike: 50, expiration: EXP_SAFE });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.expiration, EXP_SAFE);
  assert.equal(p?.expirationSource, "selectedLeg");
});

test("TEST 2 — expiration AGGRESSIVE copiée", () => {
  const agg = makeLeg({ strike: 52, bid: 0.55, yieldPct: 1.06, expiration: EXP_AGG });
  const p = pick([makeCandidate({ agg, aggressiveGrade: "A", finalDisplayMode: "AGGRESSIVE" })], "AGGRESSIVE", "AAPL");
  assert.equal(p?.expiration, EXP_AGG);
});

test("TEST 3 — expiration selectedLeg différente du parent : selectedLeg gagne", () => {
  const safe = makeLeg({ strike: 50, expiration: EXP_SAFE });
  const agg = makeLeg({ strike: 52, bid: 0.55, yieldPct: 1.06, expiration: EXP_AGG });
  const p = pick([makeCandidate({ safe, agg, targetExpiration: EXP_SAFE, aggressiveGrade: "A", finalDisplayMode: "AGGRESSIVE" })], "AGGRESSIVE", "AAPL");
  assert.equal(p?.expiration, EXP_AGG);
  assert.equal(p?.expirationMismatch, true);
});

test("TEST 4 — expiration selectedLeg absente : fallback parent", () => {
  const safe = makeLeg({ strike: 50 });
  const p = pick([makeCandidate({ safe, targetExpiration: EXP_SAFE, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.expiration, EXP_SAFE);
  assert.equal(p?.expirationSource, "parent");
});

test("TEST 5 — expiration totalement absente : null contrôlé", () => {
  const safe = makeLeg({ strike: 50 });
  const c = makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" });
  delete c.targetExpiration;
  delete c.expiration;
  const meta = projectSelectedLegMetadata({ ...c, selectedLeg: safe });
  assert.equal(meta.expiration, null);
});

test("TEST 6 — DTE selectedLeg", () => {
  const safe = makeLeg({ strike: 50, dte: 5, expiration: EXP_SAFE });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.dte, 5);
});

test("TEST 7 — DTE fallback parent", () => {
  const safe = makeLeg({ strike: 50 });
  const p = pick([makeCandidate({ safe, dteDays: 7, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.dte, 7);
});

test("TEST 8 — bid selectedLeg", () => {
  const safe = makeLeg({ strike: 50, bid: 0.31 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.bid, 0.31);
});

test("TEST 9 — ask selectedLeg", () => {
  const safe = makeLeg({ strike: 50, bid: 0.30, ask: 0.33 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.ask, 0.33);
});

test("TEST 10 — mid selectedLeg", () => {
  const safe = makeLeg({ strike: 50, bid: 0.30, mid: 0.315 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.mid, 0.315);
});

test("TEST 11 — rank/finalRank", () => {
  const safe = makeLeg({ strike: 50, rank: 3, finalRank: 5 });
  const p = pick([makeCandidate({ safe, rank: 9, finalRank: 8, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.rank, 3);
  assert.equal(p?.finalRank, 5);
});

test("TEST 12 — optionSymbol", () => {
  const safe = makeLeg({ strike: 50, optionSymbol: "AAPL250717P00050000" });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.optionSymbol, "AAPL250717P00050000");
});

test("TEST 13 — conId/contractId", () => {
  const safe = makeLeg({ strike: 50, conId: 12345, contractId: 67890 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.conId, 12345);
  assert.equal(p?.contractId, 67890);
});

test("TEST 14 — quoteTimestamp", () => {
  const safe = makeLeg({ strike: 50, quoteTimestamp: "2026-07-10T15:00:00Z" });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.quoteTimestamp, "2026-07-10T15:00:00Z");
});

test("TEST 15 — marketDataType live", () => {
  const safe = makeLeg({ strike: 50, marketDataType: "live" });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.marketDataType, "live");
});

test("TEST 16 — marketDataType frozen/delayed conservé", () => {
  const safe = makeLeg({ strike: 50, marketDataType: "frozen" });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.marketDataType, "frozen");
});

test("TEST 17 — bid/ask SAFE ≠ AGGRESSIVE : pick = jambe sélectionnée", () => {
  const safe = makeLeg({ strike: 50, bid: 0.10, ask: 0.12, yieldPct: 0.20 });
  const agg = makeLeg({ strike: 52, bid: 0.55, ask: 0.58, yieldPct: 1.06 });
  const p = pick([makeCandidate({ safe, agg, aggressiveGrade: "A", finalDisplayMode: "AGGRESSIVE" })], "AGGRESSIVE", "AAPL");
  assert.equal(p?.bid, 0.55);
  assert.equal(p?.ask, 0.58);
  assert.equal(p?.strike, 52);
});

test("TEST 18 — BALANCED fallback : metadata jambe retenue", () => {
  const safe = makeLeg({ strike: 40, bid: 0.32, yieldPct: 0.80, expiration: EXP_SAFE, optionSymbol: "SAFE_OPT" });
  const agg = makeLeg({ strike: 43, bid: 0.90, yieldPct: 2.09, expiration: EXP_AGG, optionSymbol: "AGG_OPT" });
  const p = pick([makeCandidate({ ticker: "CRM", safe, agg, safeGrade: "A", aggressiveGrade: "A" })], "BALANCED", "CRM");
  assert.equal(p?.strike, 40);
  assert.equal(p?.expiration, EXP_SAFE);
  assert.equal(p?.optionSymbol, "SAFE_OPT");
});

test("TEST 19 — spread/premium cohérents", () => {
  const safe = makeLeg({ strike: 50, bid: 0.30, spreadPct: 7 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.premiumUnit, 0.30);
  assert.ok(Number.isFinite(p?.spreadPct));
  assert.equal(p?.spreadPct, p?.spreadPct);
});

test("TEST 20 — strike cohérent", () => {
  const safe = makeLeg({ strike: 50 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.equal(p?.strike, 50);
});

test("TEST 21 — capitalUsed cohérent avec capitalRequired × contracts", () => {
  const safe = makeLeg({ strike: 50 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL", { maxPositions: 10 });
  assert.equal(p?.capitalUsed, p?.capitalRequired * p?.contracts);
});

test("TEST 22 — contracts déterministes entre exécutions", () => {
  const safe = makeLeg({ strike: 50 });
  const c = makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" });
  const p1 = pick([c], "SAFE", "AAPL", { maxPositions: 10 });
  const p2 = pick([c], "SAFE", "AAPL", { maxPositions: 10 });
  assert.equal(p1?.contracts, p2?.contracts);
});

test("TEST 23 — mode actuel inchangé (AF-01 non corrigé)", () => {
  const safe = makeLeg({ strike: 50 });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A" })], "SAFE", "AAPL");
  assert.equal(p?.mode, "AGGRESSIVE");
});

test("TEST 24 — snapshot sérialise expiration", () => {
  const safe = makeLeg({ strike: 50, expiration: EXP_SAFE });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  const payload = { conservative: { picks: [p] } };
  const roundtrip = JSON.parse(JSON.stringify(payload));
  assert.equal(roundtrip.conservative.picks[0].expiration, EXP_SAFE);
});

test("TEST 25 — objet legacy sans metadata", () => {
  const safe = { strike: 50, bid: 0.30, weeklyYield: 0.60, spreadPct: 8, distancePct: -8, popProfitEstimated: 0.9 };
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE", targetExpiration: EXP_SAFE })], "SAFE", "AAPL");
  assert.equal(p?.expiration, EXP_SAFE);
  assert.equal(p?.premiumUnit, 0.30);
});

test("TEST 26 — aucune mutation", () => {
  const pool = [makeCandidate({ safe: makeLeg({ strike: 50 }), safeGrade: "A", finalDisplayMode: "SAFE" })];
  const snap = JSON.stringify(pool);
  deepFreeze(pool);
  pick(pool, "SAFE", "AAPL");
  assert.equal(JSON.stringify(pool), snap);
});

test("TEST 27 — valeurs invalides contrôlées", () => {
  const meta = projectSelectedLegMetadata({
    selectedLeg: { bid: NaN, ask: Infinity, rank: "n/a" },
    targetExpiration: EXP_SAFE,
  });
  assert.equal(meta.bid, null);
  assert.equal(meta.ask, null);
  assert.equal(meta.rank, null);
});

test("TEST 28 — ordre inversé : empreinte financière identique", () => {
  const pool = [
    makeCandidate({ ticker: "AAPL", safe: makeLeg({ strike: 50 }), safeGrade: "A", finalDisplayMode: "SAFE" }),
    makeCandidate({ ticker: "MSFT", safe: makeLeg({ strike: 51, bid: 0.31, yieldPct: 0.61 }), safeGrade: "A", finalDisplayMode: "SAFE" }),
  ];
  const strip = (p) => JSON.stringify(
    buildPortfolioCombos(p, 100000, 100, 10, new Set(), OPTS)
      .find((c) => c.label === "SAFE")?.picks?.map((x) => ({ t: x.ticker, s: x.strike, c: x.capitalUsed, e: x.expiration }))
  );
  assert.equal(strip(pool), strip([...pool].reverse()));
});

test("TEST 29 — répétition déterministe", () => {
  const pool = [makeCandidate({ safe: makeLeg({ strike: 50, expiration: EXP_SAFE }), safeGrade: "A", finalDisplayMode: "SAFE" })];
  const ref = JSON.stringify(pick(pool, "SAFE", "AAPL"));
  for (let i = 0; i < 10; i++) assert.equal(JSON.stringify(pick(pool, "SAFE", "AAPL")), ref);
});

test("TEST 30 — JSON stringify du pick sans erreur", () => {
  const safe = makeLeg({ strike: 50, expiration: EXP_SAFE, conId: 1, quoteTimestamp: "2026-07-10T12:00:00Z" });
  const p = pick([makeCandidate({ safe, safeGrade: "A", finalDisplayMode: "SAFE" })], "SAFE", "AAPL");
  assert.doesNotThrow(() => JSON.stringify(p));
  assert.ok(JSON.parse(JSON.stringify(p)).expiration);
});

test("TEST 31 — selectedLeg.mid prioritaire sur candidate.mid", () => {
  const meta = projectSelectedLegMetadata({
    selectedLeg: { mid: 0.315 },
    mid: 0.999,
  });
  assert.equal(meta.mid, 0.315);
});

test("TEST 32 — fallback candidate.mid si selectedLeg.mid absent", () => {
  const meta = projectSelectedLegMetadata({
    selectedLeg: { strike: 50, bid: 0.30 },
    mid: 0.32,
  });
  assert.equal(meta.mid, 0.32);
});

test("TEST 33 — premium/premiumUsed/primeUsed ne remplissent jamais mid", () => {
  const meta = projectSelectedLegMetadata({
    selectedLeg: {
      strike: 50,
      bid: 0.30,
      premium: 0.30,
      premiumUsed: 0.30,
      primeUsed: 0.30,
    },
    premium: 0.30,
    selectedPremiumUnit: 0.30,
  });
  assert.equal(meta.mid, null);
});

test("TEST 34 — source générique ne remplit jamais quoteSource", () => {
  const meta = projectSelectedLegMetadata({
    selectedLeg: { strike: 50, source: "IBKR live" },
    source: "scanner",
    optionsSource: "yahoo",
  });
  assert.equal(meta.quoteSource, null);
});

test("TEST 35 — absence bid/ask/mid/quoteSource équivalent → null", () => {
  const meta = projectSelectedLegMetadata({
    selectedLeg: { strike: 50, premiumUsed: 0.30 },
    selectedPremiumUnit: 0.30,
    source: "scanner",
  });
  assert.equal(meta.bid, null);
  assert.equal(meta.ask, null);
  assert.equal(meta.mid, null);
  assert.equal(meta.quoteSource, null);
});

test("TEST 36 — quoteSource : leg prioritaire, fallback candidate.quoteSource", () => {
  const legFirst = projectSelectedLegMetadata({
    selectedLeg: { quoteSource: "IBKR delayed" },
    quoteSource: "yahoo",
    source: "scanner",
  });
  assert.equal(legFirst.quoteSource, "IBKR delayed");

  const parentOnly = projectSelectedLegMetadata({
    selectedLeg: { strike: 50 },
    quoteSource: "yahoo",
    source: "scanner",
  });
  assert.equal(parentOnly.quoteSource, "yahoo");
});

test("TEST 37 — fallback candidate.bid/ask si absents sur selectedLeg", () => {
  const meta = projectSelectedLegMetadata({
    selectedLeg: { strike: 50 },
    bid: 0.28,
    ask: 0.32,
  });
  assert.equal(meta.bid, 0.28);
  assert.equal(meta.ask, 0.32);
});
