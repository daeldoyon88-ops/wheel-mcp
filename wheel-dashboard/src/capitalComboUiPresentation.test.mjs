import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { buildPortfolioCombos } from "./capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = fs.readFileSync(path.join(__dirname, "dashboard.jsx"), "utf8");

const OPTS = { optimizerV2: { leftoverDensityPassEnabled: false } };

function fingerprint(pool) {
  return buildPortfolioCombos(pool, 100_000, 100, 3, new Set(), OPTS).map((combo) => ({
    label: combo.label,
    picks: (combo.picks ?? []).map((p) => ({
      ticker: p.ticker,
      strike: p.strike,
      contracts: p.contracts,
      capitalUsed: p.capitalUsed,
      premiumCollected: p.premiumCollected,
      weeklyReturn: p.weeklyReturn,
      selectionScore: p.selectionScore,
      mode: p.mode,
      selectedLegMode: p.selectedLegMode,
    })),
    totalCapital: combo.totalCapital,
  }));
}

function makeLeg(strike, yieldPct, dteDays = 7) {
  const premium = (yieldPct * strike) / 100;
  return {
    strike,
    bid: premium,
    premiumUsed: premium,
    weeklyYield: yieldPct,
    periodYield: yieldPct,
    dteDays,
    distancePct: -8,
    liquidity: { spreadPct: 8 },
    volume: 500,
    openInterest: 1000,
    popProfitEstimated: 0.88,
    source: "IBKR live",
  };
}

test("AF-13 — allowedModes actif trompeur absent du dashboard", () => {
  assert.ok(!DASHBOARD.includes("· modes {[...cfg.allowedModes]"));
  assert.ok(!DASHBOARD.includes("modes {[...cfg.allowedModes]"));
});

test("AF-16 — labels corrigés présents", () => {
  assert.ok(DASHBOARD.includes("Jambe / Grade"));
  assert.ok(!DASHBOARD.includes('"Mode / Grade"'));
  assert.ok(DASHBOARD.includes("Rend. hebdo."));
  assert.ok(DASHBOARD.includes("Prime / capital"));
  assert.ok(DASHBOARD.includes("Collatéral ligne"));
  assert.ok(DASHBOARD.includes("CONCENTRATION"));
  assert.ok(!DASHBOARD.includes("Rend. moy."));
  assert.ok(!DASHBOARD.includes("% / sem."));
  assert.ok(DASHBOARD.includes("formatCapitalComboPickLegBadge"));
});

test("AF-13/16 — invariants moteur inchangés", () => {
  const pool = [
    {
      ticker: "AAPL",
      dteDays: 7,
      safeStrike: makeLeg(50, 0.6),
      aggressiveStrike: makeLeg(48, 1.0),
      safeGrade: "A",
      aggressiveGrade: "A",
      finalDisplayMode: "AGGRESSIVE",
      finalDisplayGrade: "A",
      optionsSource: "IBKR live",
      hasEarningsBeforeExpiration: false,
      proFinalScore: 0.5,
      proExecutionScore: 0.8,
      proDistanceScore: 1,
    },
    {
      ticker: "MSFT",
      safeStrike: makeLeg(50, 0.65),
      aggressiveStrike: makeLeg(48, 1.05),
      safeGrade: "A",
      aggressiveGrade: "A",
      finalDisplayMode: "SAFE",
      finalDisplayGrade: "A",
      optionsSource: "IBKR live",
      hasEarningsBeforeExpiration: false,
      proFinalScore: 0.5,
      proExecutionScore: 0.8,
      proDistanceScore: 1,
    },
  ];
  const fp = fingerprint(pool);
  assert.equal(fp.length, 3);
  for (const combo of fp) {
    for (const p of combo.picks) {
      assert.ok(Number.isFinite(p.capitalUsed));
      assert.ok(Number.isFinite(p.premiumCollected));
      assert.ok(p.selectedLegMode === "SAFE" || p.selectedLegMode === "AGGRESSIVE");
    }
  }
});
