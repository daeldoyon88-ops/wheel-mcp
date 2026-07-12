import test from "node:test";
import assert from "node:assert/strict";

import { buildPortfolioCombos } from "./capitalComboPortfolio.js";
import { buildCompositionSnapshot } from "./alternativeCompositionSimV1.js";

const OPTS = { optimizerV2: {} };
const MONEY_TOL = 0.02;

function makeSafeLeg(strike, weeklyYield = 0.6) {
  return {
    strike,
    bid: 0.6,
    premiumUsed: 0.6,
    mid: 0.6,
    weeklyYield,
    distancePct: -8,
    liquidity: { spreadPct: 8 },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
    popProfitEstimated: 0.86,
  };
}

function makeAggLeg(strike, weeklyYield = 1.1) {
  return {
    strike,
    bid: 0.35,
    premiumUsed: 0.35,
    mid: 0.35,
    weeklyYield,
    distancePct: -9,
    liquidity: { spreadPct: 8 },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
    popProfitEstimated: 0.86,
  };
}

function makeCandidate(ticker, { safeStrike = null, aggressiveStrike = null } = {}) {
  const candidate = {
    ticker,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore: 0.8,
    proExecutionScore: 0.9,
    proDistanceScore: 1,
    safeGrade: "A",
    aggressiveGrade: "A",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
  };
  if (safeStrike) candidate.safeStrike = safeStrike;
  if (aggressiveStrike) candidate.aggressiveStrike = aggressiveStrike;
  return candidate;
}

function combosFor(candidates, capital, maxCapitalPct = 100, maxPositions = 10) {
  return buildPortfolioCombos(candidates, capital, maxCapitalPct, maxPositions, new Set(), OPTS) ?? [];
}

function comboByLabel(combos, label) {
  return (combos || []).find((combo) => combo?.label === label) ?? null;
}

function usableCapital(capital, maxCapitalPct) {
  return capital * (maxCapitalPct / 100);
}

function expectedFree(capital, maxCapitalPct, used) {
  return Math.max(0, usableCapital(capital, maxCapitalPct) - used);
}

function assertFreeCapital(combo, capital, maxCapitalPct, label = "") {
  const used = combo?.totalCapital ?? 0;
  const usable = usableCapital(capital, maxCapitalPct);
  const expected = expectedFree(capital, maxCapitalPct, used);
  assert.ok(combo, `${label} combo attendu`);
  assert.ok(
    Math.abs(combo.freeCapital - expected) <= MONEY_TOL,
    `${label}: freeCapital ${combo.freeCapital} !== attendu ${expected} (usable=${usable}, used=${used})`,
  );
  assert.ok(combo.freeCapital >= 0, `${label}: freeCapital négatif`);
  assert.ok(combo.freeCapital <= usable + MONEY_TOL, `${label}: freeCapital > usable`);
  assert.ok(
    Math.abs(combo.totalCapital + combo.freeCapital - usable) <= MONEY_TOL,
    `${label}: totalCapital + freeCapital !== usable`,
  );
}

const mixedPool = [
  makeCandidate("AAPL", { safeStrike: makeSafeLeg(50), aggressiveStrike: makeAggLeg(48) }),
  makeCandidate("MSFT", { safeStrike: makeSafeLeg(50), aggressiveStrike: makeAggLeg(48) }),
  makeCandidate("NVDA", { safeStrike: makeSafeLeg(50), aggressiveStrike: makeAggLeg(48) }),
  makeCandidate("KO", { safeStrike: makeSafeLeg(32), aggressiveStrike: makeAggLeg(30) }),
  makeCandidate("SOFI", { safeStrike: makeSafeLeg(17), aggressiveStrike: makeAggLeg(15) }),
  makeCandidate("NOK", { safeStrike: makeSafeLeg(11), aggressiveStrike: makeAggLeg(10) }),
];

test("TEST 1 — capital complet 25 500 $, maxCapitalPct 100 %", () => {
  const combos = combosFor(mixedPool, 25500, 100);
  for (const label of ["SAFE", "BALANCED", "AGGRESSIVE"]) {
    const combo = comboByLabel(combos, label);
    if (!combo || combo.totalCapital <= 0) continue;
    assertFreeCapital(combo, 25500, 100, label);
    assert.equal(combo.freeCapital, 25500 - combo.totalCapital);
  }
});

test("TEST 2 — 50 000 $ à 50 % déployable", () => {
  const combos = combosFor(mixedPool, 50000, 50);
  for (const label of ["SAFE", "BALANCED", "AGGRESSIVE"]) {
    const combo = comboByLabel(combos, label);
    if (!combo || combo.totalCapital <= 0) continue;
    assertFreeCapital(combo, 50000, 50, label);
    assert.notEqual(combo.freeCapital, 50000 - combo.totalCapital, `${label}: ne doit pas inclure la réserve`);
  }
});

test("TEST 3 — 40 000 $ à 25 % déployable", () => {
  const combos = combosFor(mixedPool, 40000, 25);
  for (const label of ["SAFE", "BALANCED", "AGGRESSIVE"]) {
    const combo = comboByLabel(combos, label);
    if (!combo || combo.totalCapital <= 0) continue;
    assertFreeCapital(combo, 40000, 25, label);
  }
});

test("TEST 4 — utilisé exactement égal au usable", () => {
  const tiny = [makeCandidate("MSFT", { safeStrike: makeSafeLeg(25) })];
  const combos = combosFor(tiny, 10000, 30, 10);
  for (const combo of combos) {
    if (!combo || combo.totalCapital <= 0) continue;
    if (Math.abs(combo.totalCapital - 3000) <= MONEY_TOL) {
      assert.equal(combo.freeCapital, 0);
    }
  }
});

test("TEST 5 — arrondis/cents", () => {
  const combos = combosFor(
    [makeCandidate("AAPL", { safeStrike: makeSafeLeg(50.25), aggressiveStrike: makeAggLeg(48.25) })],
    25500.33,
    50,
  );
  for (const combo of combos) {
    if (!combo || combo.totalCapital <= 0) continue;
    assertFreeCapital(combo, 25500.33, 50, combo.label);
  }
});

test("TEST 6 — SAFE formule correcte", () => {
  const combo = comboByLabel(combosFor(mixedPool, 50000, 50), "SAFE");
  if (combo?.totalCapital > 0) assertFreeCapital(combo, 50000, 50, "SAFE");
});

test("TEST 7 — BALANCED formule correcte", () => {
  const combo = comboByLabel(combosFor(mixedPool, 50000, 50), "BALANCED");
  if (combo?.totalCapital > 0) assertFreeCapital(combo, 50000, 50, "BALANCED");
});

test("TEST 8 — AGGRESSIVE formule correcte", () => {
  const combo = comboByLabel(combosFor(mixedPool, 50000, 50), "AGGRESSIVE");
  if (combo?.totalCapital > 0) assertFreeCapital(combo, 50000, 50, "AGGRESSIVE");
});

test("TEST 9 — invariant totalCapital + freeCapital ≈ usable", () => {
  const combos = combosFor(mixedPool, 50000, 50);
  for (const combo of combos) {
    if (!combo) continue;
    assertFreeCapital(combo, 50000, 50, combo.label);
  }
});

test("TEST 10 — aucun impact allocation (picks/strikes/contrats/capitalUsed)", () => {
  const before = combosFor(mixedPool, 50000, 50);
  const after = combosFor(mixedPool, 50000, 50);
  const fp = (combos) =>
    JSON.stringify(
      (combos || []).map((c) => ({
        label: c.label,
        totalCapital: c.totalCapital,
        picks: (c.picks ?? []).map((p) => ({
          ticker: p.ticker,
          strike: p.strike,
          contracts: p.contracts,
          capitalUsed: p.capitalUsed,
        })),
      })),
    );
  assert.equal(fp(before), fp(after));
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    assert.equal(b?.freeCapital, a?.freeCapital);
  }
});

test("TEST 11 — déterminisme 20 exécutions", () => {
  const values = [];
  for (let i = 0; i < 20; i++) {
    const combo = comboByLabel(combosFor(mixedPool, 50000, 50), "SAFE");
    values.push(combo?.freeCapital ?? null);
  }
  assert.ok(values.every((v) => v === values[0]));
});

test("TEST 12 — aucune mutation du pool", () => {
  const pool = mixedPool.map((c) => structuredClone(c));
  const frozen = structuredClone(pool);
  combosFor(pool, 50000, 50);
  assert.deepEqual(pool, frozen);
});

test("TEST 13 — simulateur alternatif à 50 %", () => {
  const combos = combosFor(mixedPool, 50000, 50);
  const combo = comboByLabel(combos, "SAFE");
  if (!combo?.picks?.length) return;
  const usable = 25000;
  const snap = buildCompositionSnapshot(combo.picks, usable, 50000, []);
  assert.ok(Math.abs(snap.freeCapital - Math.max(0, usable - snap.usedCapital)) <= MONEY_TOL);
  assert.notEqual(snap.freeCapital, 50000 - snap.usedCapital);
});

test("TEST 14 — simulateur alternatif à 100 % inchangé", () => {
  const combos = combosFor(mixedPool, 25500, 100);
  const combo = comboByLabel(combos, "SAFE");
  if (!combo?.picks?.length) return;
  const snap = buildCompositionSnapshot(combo.picks, 25500, 25500, []);
  assert.ok(Math.abs(snap.freeCapital - Math.max(0, 25500 - snap.usedCapital)) <= MONEY_TOL);
});

test("TEST 15 — freeCapital jamais négatif (pct élevé)", () => {
  const combos = combosFor(mixedPool, 10000, 150);
  for (const combo of combos) {
    if (!combo) continue;
    assert.ok(combo.freeCapital >= 0, `${combo.label}: freeCapital négatif`);
  }
});
