import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  buildCapitalComboCandidate,
  projectCapitalComboPickModeFields,
  resolveBucketLegForPresentation,
  resolveCapitalComboInspectorLegView,
  formatCapitalComboPickLegBadge,
  formatCapitalComboPickBucketContext,
} from "./capitalComboPortfolio.js";

const OPTS = { optimizerV2: { leftoverDensityPassEnabled: false } };
const CAPITAL = 100_000;

function askFromBidAndSpreadPct(bid, spreadPct) {
  const b = Number(bid);
  const s = Number(spreadPct);
  if (!Number.isFinite(b) || b <= 0) return b > 0 ? Number((b * 1.05).toFixed(4)) : null;
  if (s === 0) return b;
  return Number((b * (s + 200) / (200 - s)).toFixed(4));
}

function makeLeg({ strike = 50, yieldPct = 0.7, spreadPct = 8, distancePct = -9, popDecimal = 0.88 } = {}) {
  const premium = Number(((yieldPct * strike) / 100).toFixed(4));
  return {
    strike,
    bid: premium,
    ask: askFromBidAndSpreadPct(premium, spreadPct),
    premiumUsed: premium,
    mid: premium,
    weeklyYield: yieldPct,
    distancePct,
    popProfitEstimated: popDecimal,
    popEstimate: null,
    liquidity: { spreadPct },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
  };
}

function makeCandidate({
  ticker = "AAPL",
  safe = null,
  agg = null,
  safeGrade = "A",
  aggressiveGrade = "A",
  finalDisplayMode = "SAFE",
  finalDisplayGrade = "A",
} = {}) {
  return {
    ticker,
    safeStrike: safe,
    aggressiveStrike: agg,
    safeGrade,
    aggressiveGrade,
    finalDisplayMode,
    finalDisplayGrade,
    targetExpiration: "2026-07-17",
    dteDays: 7,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    proFinalScore: 0.5,
    proExecutionScore: 0.8,
    proDistanceScore: 1,
  };
}

function pick(pool, label, ticker, options = {}) {
  const combo = buildPortfolioCombos(pool, CAPITAL, 100, 1, new Set(), { ...OPTS, ...options }).find(
    (c) => c?.label === label,
  );
  return combo?.picks?.find((p) => p.ticker === ticker) ?? null;
}

test("AF-01 — SAFE bucket metadata", () => {
  const c = makeCandidate({
    ticker: "AAPL",
    safe: makeLeg({ strike: 50, yieldPct: 0.55 }),
    finalDisplayMode: "SAFE",
  });
  const p = pick([c], "SAFE", "AAPL");
  assert.ok(p);
  assert.equal(p.bucketMode, "SAFE");
  assert.equal(p.selectedLegMode, "SAFE");
  assert.equal(p.scannerMode, "SAFE");
  assert.equal(p.mode, "SAFE");
});

test("AF-01 — AGGRESSIVE bucket metadata", () => {
  const c = makeCandidate({
    ticker: "AAPL",
    agg: makeLeg({ strike: 48, yieldPct: 1.1 }),
    finalDisplayMode: "AGGRESSIVE",
  });
  const p = pick([c], "AGGRESSIVE", "AAPL");
  assert.ok(p);
  assert.equal(p.bucketMode, "AGGRESSIVE");
  assert.equal(p.selectedLegMode, "AGGRESSIVE");
});

test("AF-01 — BALANCED→SAFE avec scanner AGGRESSIVE", () => {
  const c = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.78 }),
    agg: makeLeg({ strike: 43, yieldPct: 1.2 }),
    finalDisplayMode: "AGGRESSIVE",
  });
  const p = pick([c], "BALANCED", "CRM");
  assert.ok(p);
  assert.equal(p.bucketMode, "BALANCED");
  assert.equal(p.selectedLegMode, "SAFE");
  assert.equal(p.scannerMode, "AGGRESSIVE");
  assert.equal(p.mode, "AGGRESSIVE", "legacy mode inchangé");
  assert.equal(p.strike, 40);
});

test("AF-01 — BALANCED→AGGRESSIVE", () => {
  const c = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.55 }),
    agg: makeLeg({ strike: 43, yieldPct: 0.95 }),
    finalDisplayMode: "SAFE",
  });
  const p = pick([c], "BALANCED", "CRM");
  assert.ok(p);
  assert.equal(p.bucketMode, "BALANCED");
  assert.equal(p.selectedLegMode, "AGGRESSIVE");
});

test("AF-01 — aucun fallback hors bande sur résolution bucket", () => {
  const raw = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.55 }),
    agg: makeLeg({ strike: 43, yieldPct: 0.65 }),
  });
  const leg = resolveBucketLegForPresentation("BALANCED", raw, CAPITAL);
  assert.equal(leg.source, "runtime");
  assert.equal(leg.bucketLegAvailable, false);
  assert.equal(leg.fallbackUsed, false);
  assert.equal(leg.selectedLegMode, null);
  assert.equal(leg.balancedLegSource, "BALANCED_UNAVAILABLE");
  assert.equal(leg.selectionReason, "NO_BALANCED_FALLBACK_ELIGIBLE");
});

test("AF-01 — JSON stringify et pas de mutation", () => {
  const pool = [
    makeCandidate({
      ticker: "AAPL",
      safe: makeLeg({ strike: 50, yieldPct: 0.6 }),
      finalDisplayMode: "SAFE",
    }),
  ];
  const snap = JSON.stringify(pool);
  const p = pick(pool, "SAFE", "AAPL");
  assert.doesNotThrow(() => JSON.stringify(p));
  assert.equal(JSON.stringify(pool), snap);
  const fields = projectCapitalComboPickModeFields({
    _capitalComboMode: "SAFE",
    selectedLegMode: "SAFE",
    finalDisplayMode: "AGGRESSIVE",
  });
  assert.equal(fields.bucketMode, "SAFE");
  assert.equal(fields.selectedLegMode, "SAFE");
  assert.equal(fields.scannerMode, "AGGRESSIVE");
});

test("AF-01 — badge helpers", () => {
  const p = {
    selectedLegMode: "SAFE",
    grade: "A",
    bucketMode: "BALANCED",
  };
  assert.equal(formatCapitalComboPickLegBadge(p), "Jambe SAFE · Grade A");
  assert.equal(formatCapitalComboPickBucketContext(p), "Bucket BALANCED");
  assert.equal(formatCapitalComboPickLegBadge({ selectedLegMode: null }), "Jambe —");
});

test("AF-14 — Inspector parité runtime BALANCED DTE 7", () => {
  const c = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.85 }),
    agg: makeLeg({ strike: 43, yieldPct: 0.95 }),
  });
  const runtime = resolveBucketLegForPresentation("BALANCED", c, CAPITAL);
  assert.equal(runtime.source, "runtime");
  const insp = resolveCapitalComboInspectorLegView({ bucketKey: "BALANCED", candidate: c, usableCapital: CAPITAL });
  assert.equal(insp.source, "runtime");
  assert.equal(insp.selectedLegMode, runtime.selectedLegMode);
  assert.equal(insp.selectedStrike, runtime.selectedStrike);
  assert.equal(insp.selectedWeeklyYieldPct, runtime.selectedWeeklyYieldPct);
});

test("AF-14 — Inspector lit pick runtime", () => {
  const c = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.78 }),
    agg: makeLeg({ strike: 43, yieldPct: 1.2 }),
    finalDisplayMode: "AGGRESSIVE",
  });
  const p = pick([c], "BALANCED", "CRM");
  assert.ok(p);
  const insp = resolveCapitalComboInspectorLegView({
    bucketKey: "BALANCED",
    candidate: c,
    pick: p,
    usableCapital: CAPITAL,
  });
  assert.equal(insp.source, "runtime");
  assert.equal(insp.inPicks, true);
  assert.equal(insp.selectedLegMode, p.selectedLegMode);
  assert.equal(insp.selectedStrike, p.strike);
  assert.equal(insp.selectedWeeklyYieldPct, p.weeklyReturn);
});

test("AF-14 — BALANCED indisponible exposé par le runtime", () => {
  const insp = resolveCapitalComboInspectorLegView({
    bucketKey: "BALANCED",
    candidate: { ticker: "ZZZZ" },
    usableCapital: CAPITAL,
  });
  assert.equal(insp.source, "runtime");
  assert.equal(insp.bucketLegAvailable, false);
  assert.equal(insp.balancedLegSource, "BALANCED_UNAVAILABLE");
});

test("AF-01 — projection sur candidat bucket sans pick", () => {
  const raw = makeCandidate({
    ticker: "CRM",
    safe: makeLeg({ strike: 40, yieldPct: 0.78 }),
    agg: makeLeg({ strike: 43, yieldPct: 1.2 }),
    finalDisplayMode: "AGGRESSIVE",
  });
  const built = buildCapitalComboCandidate(raw, CAPITAL);
  const leg = resolveBucketLegForPresentation("BALANCED", raw, CAPITAL);
  const merged = {
    ...built,
    _capitalComboMode: "BALANCED",
    selectedLegMode: leg.selectedLegMode,
    _bucketSelectedMode: leg.selectedLegMode,
    selectedLeg: leg.selectedLeg,
  };
  const fields = projectCapitalComboPickModeFields(merged);
  assert.equal(fields.bucketMode, "BALANCED");
  assert.equal(fields.selectedLegMode, "SAFE");
  assert.equal(fields.scannerMode, "AGGRESSIVE");
});
