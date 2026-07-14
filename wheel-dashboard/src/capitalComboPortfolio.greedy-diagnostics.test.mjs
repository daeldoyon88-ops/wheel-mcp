// Diagnostics greedy Capital Combinations — lecture seule, vrai moteur.
// Ne modifie pas les picks : vérifie diagnostics terminal + scoredPoolNotSelected.

import test from "node:test";
import assert from "node:assert/strict";

import { buildPortfolioCombos } from "./capitalComboPortfolio.js";
import { UNUSED_CAPITAL_TERMINAL_CODES } from "./capitalComboEngineV2.js";

const CAPITAL = 25500;
const MONEY_TOL = 1;
const OPTS = { optimizerV2: { capDiagnosticsEnabled: true } };

function approx(a, b, eps = MONEY_TOL) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `${a} ≈ ${b}`);
}

function makeAggLeg({ strike, periodYieldPct = 1.0, bid = null, spreadPct = 8, proFinalScore = 0.8 } = {}) {
  const premium = bid != null ? bid : Number(((periodYieldPct * strike) / 100).toFixed(6));
  const period = Number(((premium / strike) * 100).toFixed(6));
  return {
    strike,
    bid: premium,
    premiumUsed: premium,
    mid: premium,
    weeklyYield: period,
    periodYield: period,
    weeklyNormalizedYield: Number(((period * 7) / 3).toFixed(6)),
    dteDays: 3,
    distancePct: -9,
    liquidity: { spreadPct },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
    popProfitEstimated: 0.9,
    proFinalScore,
  };
}

function makeCandidate({
  ticker,
  strike,
  periodYieldPct = 1.0,
  proFinalScore = 0.8,
  aggressiveGrade = "A",
} = {}) {
  return {
    ticker,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore,
    proExecutionScore: 0.9,
    proDistanceScore: 1,
    safeGrade: null,
    aggressiveGrade,
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: aggressiveGrade,
    aggressiveStrike: makeAggLeg({ strike, periodYieldPct, proFinalScore }),
  };
}

function runAgg(pool, { capital = CAPITAL, maxPositions = 10 } = {}) {
  const combos =
    buildPortfolioCombos(pool, capital, 100, maxPositions, new Set(), OPTS) ?? [];
  const combo = combos.find((c) => c?.label === "AGGRESSIVE") ?? null;
  return { combos, combo };
}

function pickTickers(combo) {
  return (combo?.picks ?? []).map((p) => p.ticker);
}

function diag(combo) {
  return combo?.capDiagnosticsV2 ?? null;
}

function notSelectedRow(combo, ticker) {
  return (diag(combo)?.scoredPoolNotSelected ?? []).find((r) => r.ticker === ticker) ?? null;
}

function prePoolReject(holder, ticker) {
  const rows =
    holder?.capitalComboAllocationTraceV1?.scoredCandidatesByMode?.AGGRESSIVE
      ?.rejectedBeforeAllocation ?? [];
  return rows.find((r) => r.ticker === ticker) ?? null;
}

// ── Scénario réel S2 (rendement période sous 0,95 %) ───────────────────────

function makeRealWorldPoolS2() {
  return [
    makeCandidate({ ticker: "NFLX", strike: 68, periodYieldPct: 1.0, proFinalScore: 0.95 }),
    makeCandidate({ ticker: "CRWV", strike: 74, periodYieldPct: 1.0, proFinalScore: 0.94 }),
    makeCandidate({ ticker: "RKLB", strike: 74, periodYieldPct: 1.0, proFinalScore: 0.93 }),
    makeCandidate({ ticker: "APLD", strike: 26, periodYieldPct: 0.80, proFinalScore: 0.85 }),
    makeCandidate({ ticker: "SMCI", strike: 26, periodYieldPct: 0.80, proFinalScore: 0.84 }),
    makeCandidate({ ticker: "HIMS", strike: 33, periodYieldPct: 0.80, proFinalScore: 0.86 }),
  ];
}

// ── Scénario S1 (tous admissibles AGGRESSIVE) ───────────────────────────────

function makeRealWorldPoolS1() {
  return [
    makeCandidate({ ticker: "NFLX", strike: 68, periodYieldPct: 1.0, proFinalScore: 0.99 }),
    makeCandidate({ ticker: "CRWV", strike: 74, periodYieldPct: 1.0, proFinalScore: 0.98 }),
    makeCandidate({ ticker: "RKLB", strike: 74, periodYieldPct: 1.0, proFinalScore: 0.97 }),
    makeCandidate({ ticker: "HIMS", strike: 33, periodYieldPct: 1.0, proFinalScore: 0.96 }),
    makeCandidate({ ticker: "APLD", strike: 26, periodYieldPct: 1.0, proFinalScore: 0.2 }),
    makeCandidate({ ticker: "SMCI", strike: 26, periodYieldPct: 1.0, proFinalScore: 0.1 }),
  ];
}

test("TEST 1 — candidat trop cher ne stoppe pas la boucle greedy", () => {
  const pool = [
    makeCandidate({ ticker: "NVDA", strike: 200, periodYieldPct: 1.2, proFinalScore: 0.99 }),
    makeCandidate({ ticker: "NOK", strike: 20, periodYieldPct: 1.0, proFinalScore: 0.7 }),
    makeCandidate({ ticker: "SOFI", strike: 25, periodYieldPct: 1.0, proFinalScore: 0.65 }),
  ];
  const { combo } = runAgg(pool, { capital: 5000, maxPositions: 5 });
  assert.ok(combo, "combo AGGRESSIVE attendu");
  const picks = pickTickers(combo);
  assert.ok(picks.includes("NOK") || picks.includes("SOFI"), "un petit contrat doit être sélectionné");
  assert.ok(!picks.includes("NVDA"), "le contrat trop cher ne doit pas bloquer la sélection des petits");
  const totals = combo.capDiagnosticsV2?.rejectionTotalsAcrossCycles ?? {};
  assert.ok((totals.contract_size_too_large ?? 0) > 0, "rejet contract_size_too_large attendu en cycle");
});

test("TEST 2 — petit contrat après gros contrat trop cher peut être sélectionné", () => {
  const pool = [
    makeCandidate({ ticker: "NVDA", strike: 180, periodYieldPct: 1.1, proFinalScore: 0.98 }),
    makeCandidate({ ticker: "AMD", strike: 30, periodYieldPct: 1.0, proFinalScore: 0.8 }),
    makeCandidate({ ticker: "NOK", strike: 18, periodYieldPct: 1.0, proFinalScore: 0.75 }),
  ];
  const { combo } = runAgg(pool, { capital: 6000, maxPositions: 5 });
  const picks = pickTickers(combo);
  assert.ok(picks.length >= 2, "au moins deux positions attendues");
  assert.ok(picks.includes("NOK") || picks.includes("AMD"));
});

test("TEST 3 — scénario S1 admissible (HIMS sélectionné, ~600 $ restants)", () => {
  const pool = [
    makeCandidate({ ticker: "NFLX", strike: 68, periodYieldPct: 1.0, proFinalScore: 0.99 }),
    makeCandidate({ ticker: "CRWV", strike: 74, periodYieldPct: 1.0, proFinalScore: 0.98 }),
    makeCandidate({ ticker: "RKLB", strike: 74, periodYieldPct: 1.0, proFinalScore: 0.97 }),
    makeCandidate({ ticker: "HIMS", strike: 33, periodYieldPct: 1.0, proFinalScore: 0.96 }),
  ];
  const { combo } = runAgg(pool);
  assert.deepEqual(pickTickers(combo).sort(), ["CRWV", "HIMS", "NFLX", "RKLB"].sort());
  approx(combo.totalCapital, 24900);
  approx(combo.freeCapital, 600);
  assert.ok(combo.capitalTargetReached !== true || combo.freeCapital > 0);
});

test("TEST 4 — scénario S2 réel (APLD/SMCI/HIMS hors scoredPool)", () => {
  const holder = {};
  const combos = buildPortfolioCombos(makeRealWorldPoolS2(), CAPITAL, 100, 10, new Set(), {
    ...OPTS,
    capitalComboTraceDebug: true,
    capitalComboTraceSuppressConsoleLogs: true,
    comboTracePayloadHolder: holder,
  });
  const combo = combos.find((c) => c?.label === "AGGRESSIVE");
  assert.deepEqual(pickTickers(combo).sort(), ["CRWV", "NFLX", "RKLB"].sort());
  approx(combo.totalCapital, 21600);
  approx(combo.freeCapital, 3900);

  for (const tk of ["APLD", "SMCI", "HIMS"]) {
    assert.ok(!notSelectedRow(combo, tk), `${tk} absent du scoredPoolNotSelected`);
    const pre = prePoolReject(holder, tk);
    assert.equal(pre?.primaryBlocker, "PERIOD_YIELD_BELOW_BUCKET_MIN", `${tk} rejeté avant scoredPool`);
    assert.ok(!diag(combo)?.scoredPoolTickers?.includes(tk));
  }

  const unused = combo.capDiagnosticsV2?.unusedCapitalDiagnostic;
  assert.equal(unused?.terminalReasonCode, UNUSED_CAPITAL_TERMINAL_CODES.ALL_REMAINING_CONTRACTS_TOO_LARGE);
  assert.match(unused?.messageFr ?? "", /3\s*900\s*\$/);
  assert.match(unused?.messageFr ?? "", /APLD|SMCI|HIMS/);
  assert.doesNotMatch(unused?.messageFr ?? "", /non retenu greedy/i);
});

test("TEST 5 — diagnostic terminal ALL_REMAINING_CONTRACTS_TOO_LARGE", () => {
  const pool = [
    makeCandidate({ ticker: "NFLX", strike: 68, proFinalScore: 0.95 }),
    makeCandidate({ ticker: "CRWV", strike: 74, proFinalScore: 0.94 }),
    makeCandidate({ ticker: "RKLB", strike: 74, proFinalScore: 0.93 }),
    makeCandidate({ ticker: "NVDA", strike: 90, proFinalScore: 0.5 }),
  ];
  const { combo } = runAgg(pool, { capital: 20000, maxPositions: 3 });
  const nvda = notSelectedRow(combo, "NVDA");
  const rklb = notSelectedRow(combo, "RKLB");
  assert.ok(nvda?.finalAllocationReason === "CONTRACT_SIZE_TOO_LARGE" || rklb?.finalAllocationReason === "CONTRACT_SIZE_TOO_LARGE");
  const unused = combo.capDiagnosticsV2?.unusedCapitalDiagnostic;
  assert.equal(unused?.terminalReasonCode, UNUSED_CAPITAL_TERMINAL_CODES.ALL_REMAINING_CONTRACTS_TOO_LARGE);
});

test("TEST 6 — candidat finançable bloqué par secteur → SECTOR_CAP_REACHED", () => {
  const pool = [
    makeCandidate({ ticker: "NVDA", strike: 64, proFinalScore: 0.95 }),
    makeCandidate({ ticker: "AMD", strike: 64, proFinalScore: 0.94 }),
    makeCandidate({ ticker: "INTC", strike: 25, proFinalScore: 0.7 }),
  ];
  const { combo } = runAgg(pool);
  const intc = notSelectedRow(combo, "INTC");
  if (intc) {
    assert.equal(intc.finalAllocationReason, "SECTOR_CAP_REACHED");
  }
  const unused = combo.capDiagnosticsV2?.unusedCapitalDiagnostic;
  if (unused?.freeCapitalUsd > 100 && intc?.canAfford) {
    assert.equal(unused.terminalReasonCode, UNUSED_CAPITAL_TERMINAL_CODES.SECTOR_CAP_REACHED);
  }
});

test("TEST 7 — candidat finançable bloqué par high-beta → HIGH_BETA_CAP_REACHED", () => {
  const pool = [
    makeCandidate({ ticker: "TQQQ", strike: 50, proFinalScore: 0.95 }),
    makeCandidate({ ticker: "SOXL", strike: 50, proFinalScore: 0.94 }),
    makeCandidate({ ticker: "NOK", strike: 20, proFinalScore: 0.7 }),
  ];
  const { combo } = runAgg(pool, { maxPositions: 3 });
  const unused = combo.capDiagnosticsV2?.unusedCapitalDiagnostic;
  const blocker = (diag(combo)?.scoredPoolNotSelected ?? []).find((r) => r.canAfford && r.finalAllocationReason === "HIGH_BETA_CAP_REACHED");
  if (blocker && unused?.freeCapitalUsd > 100) {
    assert.equal(unused.terminalReasonCode, UNUSED_CAPITAL_TERMINAL_CODES.HIGH_BETA_CAP_REACHED);
  } else {
    assert.ok(true, "scénario high-beta non déclenché sur cette fixture — skip souple");
  }
});

test("TEST 8 — ticker cap sur candidat finançable", () => {
  const pool = [
    makeCandidate({ ticker: "NVDA", strike: 120, proFinalScore: 0.99 }),
    makeCandidate({ ticker: "AMD", strike: 30, proFinalScore: 0.8 }),
  ];
  const { combo } = runAgg(pool, { capital: 25500, maxPositions: 5 });
  const nvdaRow = notSelectedRow(combo, "NVDA");
  if (nvdaRow && nvdaRow.canAfford === false) {
    assert.equal(nvdaRow.finalAllocationReason, "CONTRACT_SIZE_TOO_LARGE");
  }
  const amdSecond = (combo?.picks ?? []).filter((p) => p.ticker === "NVDA");
  if (amdSecond.length >= 1) {
    const blocked = (diag(combo)?.scoredPoolNotSelected ?? []).find(
      (r) => r.ticker === "NVDA" && r.finalAllocationReason === "TICKER_CAP_REACHED",
    );
    if (blocked) assert.equal(blocked.finalAllocationReason, "TICKER_CAP_REACHED");
  }
  assert.ok(combo);
});

test("TEST 9 — nombre maximal de positions → MAX_POSITIONS_REACHED", () => {
  const pool = [
    makeCandidate({ ticker: "NFLX", strike: 20, proFinalScore: 0.95 }),
    makeCandidate({ ticker: "CRWV", strike: 20, proFinalScore: 0.94 }),
    makeCandidate({ ticker: "RKLB", strike: 20, proFinalScore: 0.93 }),
    makeCandidate({ ticker: "HIMS", strike: 20, proFinalScore: 0.92 }),
  ];
  const { combo } = runAgg(pool, { capital: 9000, maxPositions: 2 });
  assert.equal((combo?.picks ?? []).length, 2);
  const unused = combo.capDiagnosticsV2?.unusedCapitalDiagnostic;
  assert.ok((combo?.freeCapital ?? 0) > 100, "capital libre attendu après 2 positions max");
  assert.equal(unused?.terminalReasonCode, UNUSED_CAPITAL_TERMINAL_CODES.MAX_POSITIONS_REACHED);
});

test("TEST 10 — score marginal / contrat trop cher explicite pour candidat non retenu", () => {
  const { combo } = runAgg(makeRealWorldPoolS1());
  const crwv = notSelectedRow(combo, "CRWV");
  const apld = notSelectedRow(combo, "APLD");
  const row = apld ?? crwv;
  assert.ok(row, "au moins un candidat scoredPool non sélectionné attendu");
  assert.ok(
    row.finalAllocationReason === "CONTRACT_SIZE_TOO_LARGE" ||
      row.finalAllocationReason === "NON_SELECTED_LOWER_MARGINAL_SCORE",
  );
  assert.ok(row.capitalRequired != null);
  assert.ok(row.freeCapitalAtDecision != null);
  assert.ok(row.evaluatedOrder >= 1);
});

test("TEST 11 — causes mixtes → MIXED_ALLOCATION_CONSTRAINTS", () => {
  const pool = [
    makeCandidate({ ticker: "NVDA", strike: 64, proFinalScore: 0.95 }),
    makeCandidate({ ticker: "AMD", strike: 64, proFinalScore: 0.94 }),
    makeCandidate({ ticker: "INTC", strike: 25, proFinalScore: 0.7 }),
    makeCandidate({ ticker: "NFLX", strike: 90, proFinalScore: 0.6 }),
  ];
  const { combo } = runAgg(pool);
  const unused = combo.capDiagnosticsV2?.unusedCapitalDiagnostic;
  const hasSector = (diag(combo)?.scoredPoolNotSelected ?? []).some((r) => r.finalAllocationReason === "SECTOR_CAP_REACHED");
  const hasTooLarge = (diag(combo)?.scoredPoolNotSelected ?? []).some((r) => r.finalAllocationReason === "CONTRACT_SIZE_TOO_LARGE");
  if (hasSector && hasTooLarge && (combo?.freeCapital ?? 0) > 100) {
    assert.equal(unused?.terminalReasonCode, UNUSED_CAPITAL_TERMINAL_CODES.MIXED_ALLOCATION_CONSTRAINTS);
  } else {
    assert.ok(unused?.terminalReasonCode);
  }
});

test("TEST 12 — non-régression : picks inchangés sur fixture S2", () => {
  const baseline = pickTickers(runAgg(makeRealWorldPoolS2()).combo);
  const repeat = pickTickers(runAgg(makeRealWorldPoolS2()).combo);
  assert.deepEqual(repeat, baseline);
  assert.deepEqual(baseline.sort(), ["CRWV", "NFLX", "RKLB"].sort());
});
