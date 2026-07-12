import test from "node:test";
import assert from "node:assert/strict";

import {
  auditCapitalCombination,
  computeModeMetrics,
} from "./capitalCombinationAuditService.js";

const samplePick = {
  ticker: "AAPL",
  strike: 50,
  contracts: 4,
  premiumUnit: 0.3,
  capitalUsed: 20000,
  premiumCollected: 120,
  weeklyReturn: 0.6,
};

test("TEST B1 — payload moderne avec deployableCapital explicite", () => {
  const metrics = computeModeMetrics(
    {
      picks: [samplePick],
      totalCapital: 20000,
      freeCapital: 99999,
    },
    50000,
    { deployableCapital: 25000, maxCapitalPct: 50 },
  );
  assert.equal(metrics.capitalUsed, 20000);
  assert.equal(metrics.capitalFree, 5000);
});

test("TEST B2 — fallback par maxCapitalPct sans deployableCapital", () => {
  const metrics = computeModeMetrics(
    {
      picks: [samplePick],
      totalCapital: 20000,
      freeCapital: 30000,
    },
    50000,
    { maxCapitalPct: 50 },
  );
  assert.equal(metrics.capitalFree, 5000);
});

test("TEST B3 — ancien payload sans pct ni deployable (fallback 100 %)", () => {
  const metrics = computeModeMetrics(
    {
      picks: [samplePick],
      totalCapital: 20000,
      freeCapital: 5000,
    },
    25000,
  );
  assert.equal(metrics.capitalFree, 5000);
  assert.equal(metrics.capitalUtilizationPct, 80);
});

test("TEST B4 — client envoie freeCapital erroné, backend recalcule", () => {
  const audit = auditCapitalCombination({
    accountCapital: 50000,
    maxCapitalPct: 50,
    deployableCapital: 25000,
    conservative: {
      picks: [samplePick],
      totalCapital: 20000,
      freeCapital: 30000,
    },
  });
  assert.equal(audit.modes.conservative.capitalFree, 5000);
  const mismatch = audit.modes.conservative.warnings.find((w) => w.code === "FREE_CAPITAL_MISMATCH");
  assert.ok(mismatch, "warning FREE_CAPITAL_MISMATCH attendu");
});

test("TEST B5 — capitalUsed supérieur au deployable, capitalFree clampé à 0", () => {
  const metrics = computeModeMetrics(
    {
      picks: [{ ...samplePick, capitalUsed: 30000, contracts: 6 }],
      totalCapital: 30000,
      freeCapital: 1000,
    },
    50000,
    { deployableCapital: 25000 },
  );
  assert.equal(metrics.capitalFree, 0);
});
