/**
 * AF-18 — Intégration flags Optimizer V2 avec buildPortfolioCombos.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildPortfolioCombos } from "./capitalComboPortfolio.js";
import {
  CAPITAL_COMBO_OPTIMIZER_DEFAULTS,
  readCapitalOptimizerV2FlagsFromLocalStorage,
  resolveCapitalOptimizerV2Flags,
} from "./capitalComboEngineV2.js";

function makeSafeLeg(strike, weeklyYield = 0.6, dteDays = 7) {
  return {
    strike,
    bid: 0.6,
    premiumUsed: 0.6,
    mid: 0.6,
    weeklyYield,
    periodYield: weeklyYield,
    dteDays,
    distancePct: -8,
    liquidity: { spreadPct: 8 },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
    popProfitEstimated: 0.86,
  };
}

function makeAggLeg(strike, weeklyYield = 1.1, dteDays = 7) {
  return {
    strike,
    bid: 0.35,
    premiumUsed: 0.35,
    mid: 0.35,
    weeklyYield,
    periodYield: weeklyYield,
    dteDays,
    distancePct: -9,
    liquidity: { spreadPct: 8 },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
    popProfitEstimated: 0.86,
  };
}

function makeCandidate(ticker, { safeStrike = null, aggressiveStrike = null, dteDays = 7 } = {}) {
  return {
    ticker,
    dteDays,
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
    ...(safeStrike ? { safeStrike } : {}),
    ...(aggressiveStrike ? { aggressiveStrike } : {}),
  };
}

const TEST_POOL = [
  makeCandidate("AAPL", { safeStrike: makeSafeLeg(50), aggressiveStrike: makeAggLeg(48) }),
  makeCandidate("MSFT", { safeStrike: makeSafeLeg(50), aggressiveStrike: makeAggLeg(48) }),
  makeCandidate("KO", { safeStrike: makeSafeLeg(32), aggressiveStrike: makeAggLeg(30) }),
  makeCandidate("SOFI", { safeStrike: makeSafeLeg(17), aggressiveStrike: makeAggLeg(15) }),
  makeCandidate("RIVN", { safeStrike: makeSafeLeg(14), aggressiveStrike: makeAggLeg(12) }),
];

const CAPITAL = 25500;
const OPTS_EMPTY = { optimizerV2: {} };

function fingerprint(combos) {
  return JSON.stringify(
    (combos || []).map((c) => ({
      label: c.label,
      totalCapital: c.totalCapital,
      freeCapital: c.freeCapital,
      picks: (c.picks ?? []).map((p) => ({
        ticker: p.ticker,
        contracts: p.contracts,
        capitalUsed: p.capitalUsed,
      })),
      flagsSnapshot: c.capDiagnosticsV2?.flagsSnapshot ?? null,
    })),
  );
}

function picksOnly(combos) {
  return JSON.stringify(
    (combos || []).map((c) => ({
      label: c.label,
      picks: c.picks ?? [],
    })),
  );
}

function run(pool, options = OPTS_EMPTY) {
  return buildPortfolioCombos(pool, CAPITAL, 100, 10, new Set(), options) ?? [];
}

// ── G. Intégration ───────────────────────────────────────────────────────────

test("G59 mêmes données + options → empreinte identique ×3", () => {
  const opts = { optimizerV2: resolveCapitalOptimizerV2Flags({}) };
  const a = fingerprint(run(TEST_POOL, opts));
  const b = fingerprint(run(TEST_POOL, opts));
  const c = fingerprint(run(TEST_POOL, opts));
  assert.equal(a, b);
  assert.equal(b, c);
});

test("G60 changement flag → flagsSnapshot", () => {
  const on = run(TEST_POOL, { optimizerV2: { leftoverDensityPassEnabled: true } });
  const off = run(TEST_POOL, { optimizerV2: { leftoverDensityPassEnabled: false } });
  const snapOn = on[0]?.capDiagnosticsV2?.flagsSnapshot?.leftoverDensityPassEnabled;
  const snapOff = off[0]?.capDiagnosticsV2?.flagsSnapshot?.leftoverDensityPassEnabled;
  assert.equal(snapOn, true);
  assert.equal(snapOff, false);
});

test("G61 chaîne false normalisée dans flagsSnapshot", () => {
  const combos = run(TEST_POOL, {
    optimizerV2: resolveCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: "false" }),
  });
  const snap = combos[0]?.capDiagnosticsV2?.flagsSnapshot;
  assert.equal(snap.leftoverDensityPassEnabled, false);
  assert.equal(typeof snap.leftoverDensityPassEnabled, "boolean");
});

test("G62 option explicite gagne dans flagsSnapshot", () => {
  const combos = run(TEST_POOL, {
    optimizerV2: resolveCapitalOptimizerV2Flags({ safeLeftoverDensityPassEnabled: true }),
  });
  assert.equal(combos[0]?.capDiagnosticsV2?.flagsSnapshot?.safeLeftoverDensityPassEnabled, true);
});

test("G63 pas de changement picks si flag n'affecte pas scénario (leftover off)", () => {
  const base = run(TEST_POOL, OPTS_EMPTY);
  const off = run(TEST_POOL, { optimizerV2: { leftoverDensityPassEnabled: false } });
  assert.equal(picksOnly(base), picksOnly(off));
});

test("G moteur sans options.optimizerV2 → defaults (pas localStorage)", () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ leftoverDensityPassEnabled: false }),
  };
  try {
    const combos = buildPortfolioCombos(TEST_POOL, CAPITAL, 100, 10, new Set(), {});
    const snap = combos[0]?.capDiagnosticsV2?.flagsSnapshot;
    assert.equal(snap.leftoverDensityPassEnabled, true, "moteur pur ignore localStorage");
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
});

test("G dashboard runtime transmet LS normalisé", () => {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  store.set(
    "wheelCapitalComboOptimizerV2Flags",
    JSON.stringify({ leftoverDensityPassEnabled: "false" }),
  );
  const runtimeFlags = readCapitalOptimizerV2FlagsFromLocalStorage(ls);
  assert.equal(runtimeFlags.leftoverDensityPassEnabled, false);
  const combos = run(TEST_POOL, { optimizerV2: runtimeFlags });
  assert.equal(combos[0]?.capDiagnosticsV2?.flagsSnapshot?.leftoverDensityPassEnabled, false);
});

test("G priorité option explicite vs flags runtime", () => {
  const runtime = resolveCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: false });
  const combos = run(TEST_POOL, {
    optimizerV2: resolveCapitalOptimizerV2Flags({
      ...runtime,
      leftoverDensityPassEnabled: true,
    }),
  });
  assert.equal(combos[0]?.capDiagnosticsV2?.flagsSnapshot?.leftoverDensityPassEnabled, true);
});

test("G capDiagnosticsEnabled false — picks inchangés, diagnostics absents", () => {
  const base = run(TEST_POOL, OPTS_EMPTY);
  const noDiag = run(TEST_POOL, { optimizerV2: { capDiagnosticsEnabled: false } });
  assert.equal(picksOnly(base), picksOnly(noDiag));
  assert.equal(noDiag[0]?.capDiagnosticsV2, null);
});

test("G defaults alignés tests existants optimizerV2:{}", () => {
  const a = run(TEST_POOL, {});
  const b = run(TEST_POOL, OPTS_EMPTY);
  assert.equal(picksOnly(a), picksOnly(b));
});

test("G flagsSnapshot contient les 6 flags effectifs", () => {
  const combos = run(TEST_POOL, OPTS_EMPTY);
  const snap = combos.find((c) => c.capDiagnosticsV2?.flagsSnapshot)?.capDiagnosticsV2?.flagsSnapshot;
  assert.ok(snap, "flagsSnapshot attendu");
  const expectedKeys = Object.keys(CAPITAL_COMBO_OPTIMIZER_DEFAULTS).sort();
  assert.deepEqual(Object.keys(snap).sort(), expectedKeys);
  for (const key of expectedKeys) {
    assert.equal(typeof snap[key], typeof CAPITAL_COMBO_OPTIMIZER_DEFAULTS[key], key);
  }
});

test("G flagsSnapshot ne contient pas clés inconnues", () => {
  const combos = run(TEST_POOL, {
    optimizerV2: resolveCapitalOptimizerV2Flags({ unknownFlag: true }),
  });
  const snap = combos.find((c) => c.capDiagnosticsV2?.flagsSnapshot)?.capDiagnosticsV2?.flagsSnapshot;
  assert.ok(snap, "flagsSnapshot attendu sur au moins un combo");
  assert.equal("unknownFlag" in snap, false);
  assert.deepEqual(Object.keys(snap).sort(), Object.keys(CAPITAL_COMBO_OPTIMIZER_DEFAULTS).sort());
});

test("G scénario delta — flagsSnapshot diffère quand leftover désactivé", () => {
  const on = fingerprint(run(TEST_POOL, OPTS_EMPTY));
  const off = fingerprint(run(TEST_POOL, { optimizerV2: { leftoverDensityPassEnabled: false } }));
  assert.notEqual(on, off, "au minimum flagsSnapshot / trace diffère");
});
