import test from "node:test";
import assert from "node:assert/strict";
import {
  toSpreadPctPercent,
  resolveLegSpreadPctPercent,
  gradeLeg,
  buildCapitalComboCandidate,
} from "./capitalComboPortfolio.js";
import { computeScoreV2, normalizeSpreadPct } from "./scoreV2.js";

test("toSpreadPctPercent — IBKR raw fraction 0.008 → 0.8 %", () => {
  assert.equal(toSpreadPctPercent(0.008, { source: "ibkr_raw_fraction" }), 0.8);
});

test("toSpreadPctPercent — dashboard percent 0.8 → 0.8 %", () => {
  assert.equal(toSpreadPctPercent(0.8, { source: "dashboard_percent" }), 0.8);
});

test("toSpreadPctPercent — Yahoo percent 0.8 → 0.8 %", () => {
  assert.equal(toSpreadPctPercent(0.8, { source: "yahoo_percent" }), 0.8);
});

test("toSpreadPctPercent — percent 5 → 5 %", () => {
  assert.equal(toSpreadPctPercent(5, { source: "dashboard_percent" }), 5);
  assert.equal(toSpreadPctPercent(5, { source: "yahoo_percent" }), 5);
});

test("toSpreadPctPercent — percent 80 → 80 %", () => {
  assert.equal(toSpreadPctPercent(80, { source: "dashboard_percent" }), 80);
});

test("toSpreadPctPercent — null/NaN → null", () => {
  assert.equal(toSpreadPctPercent(null), null);
  assert.equal(toSpreadPctPercent(undefined), null);
  assert.equal(toSpreadPctPercent(NaN), null);
});

test("toSpreadPctPercent — alreadyPercent true", () => {
  assert.equal(toSpreadPctPercent(0.8, { alreadyPercent: true }), 0.8);
});

test("toSpreadPctPercent — source inconnue ne multiplie pas 0.8", () => {
  assert.equal(toSpreadPctPercent(0.8), 0.8);
  assert.notEqual(toSpreadPctPercent(0.8), 80);
});

test("resolveLegSpreadPctPercent — jambe dashboard liquide 0.8 %", () => {
  const leg = { strike: 50, liquidity: { spreadPct: 0.8 } };
  assert.equal(resolveLegSpreadPctPercent(leg), 0.8);
});

test("gradeLeg — spread 0.8 % ne produit pas REJECT", () => {
  const grade = gradeLeg({ spreadPct: 0.8, weeklyYieldPct: 0.6, popDecimal: 0.85 });
  assert.notEqual(grade, "REJECT");
  assert.equal(grade, "A");
});

test("buildCapitalComboCandidate — spread 0.8 % jambe valide (pas REJECT)", () => {
  const candidate = {
    ticker: "TQQQ",
    safeGrade: "A",
    aggressiveGrade: "B",
    safeStrike: {
      strike: 50,
      bid: 0.25,
      weeklyYield: 0.6,
      popProfitEstimated: 0.85,
      liquidity: { spreadPct: 0.8 },
    },
    aggressiveStrike: {
      strike: 52,
      bid: 0.45,
      weeklyYield: 0.9,
      popProfitEstimated: 0.88,
      liquidity: { spreadPct: 0.8 },
    },
  };
  const built = buildCapitalComboCandidate(candidate, 50000);
  assert.equal(built._safeSpreadPct, 0.8);
  assert.equal(built._aggSpreadPct, 0.8);
  assert.equal(built._hasSafeLegValid, true);
  assert.equal(built._hasAggLegValid, true);
  const derived = gradeLeg({
    spreadPct: built._safeSpreadPct,
    weeklyYieldPct: built._safeYieldPct,
    popDecimal: candidate.safeStrike.popProfitEstimated,
  });
  assert.notEqual(derived, "REJECT");
});

test("Score V2 — spread 0.8 % dashboard reçoit bonus liquidité max (18 pts)", () => {
  const item = {
    finalDisplayMode: "SAFE",
    safeStrike: {
      strike: 50,
      weeklyYield: 0.8,
      popProfitEstimated: 0.85,
      liquidity: { spreadPct: 0.8 },
    },
  };
  const result = computeScoreV2(item);
  const spreadBlock = result.breakdown.find((b) => b.key === "spread");
  assert.equal(spreadBlock.pts, 18);
});

test("Score V2 — fraction IBKR brute via resolveLegSpreadPctPercent", () => {
  const leg = {
    source: "IBKR live",
    spreadPct: 0.008,
    raw: { spreadPct: 0.008 },
  };
  assert.equal(resolveLegSpreadPctPercent(leg), 0.8);
  const item = {
    finalDisplayMode: "SAFE",
    safeStrike: leg,
  };
  const result = computeScoreV2(item);
  const spreadBlock = result.breakdown.find((b) => b.key === "spread");
  assert.equal(spreadBlock.pts, 18);
});

test("UI helper — badge liquide pour 0.8 % dashboard, pas 80 %", () => {
  const pct = toSpreadPctPercent(0.8, { source: "dashboard_percent" });
  assert.equal(pct, 0.8);
  assert.ok(pct <= 5, "0.8 % doit être classé liquide (≤ 5 %)");
  assert.notEqual(pct, 80);
});

test("normalizeSpreadPct — délègue à toSpreadPctPercent avec source", () => {
  assert.equal(normalizeSpreadPct(0.008, { source: "ibkr_raw_fraction" }), 0.8);
  assert.equal(normalizeSpreadPct(0.8, { source: "dashboard_percent" }), 0.8);
});
