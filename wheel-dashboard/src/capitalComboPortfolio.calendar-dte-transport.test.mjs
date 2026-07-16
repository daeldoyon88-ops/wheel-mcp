import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapitalComboCandidate,
  getCanonicalPeriodYieldBand,
  projectSelectedLegMetadata,
  resolveLegDte,
} from "./capitalComboPortfolio.js";

function askFromBidAndSpreadPct(bid, spreadPct) {
  return bid * ((spreadPct + 200) / (200 - spreadPct));
}

function makeCandidate(dteDays) {
  const periodYieldPct = Math.max((26 * dteDays) / 365, (26 * 7) / 365) + 0.01;
  const bid = periodYieldPct;
  const leg = {
    strike: 100,
    bid,
    ask: askFromBidAndSpreadPct(bid, 8),
    premiumUsed: bid,
    mid: bid,
    periodYield: periodYieldPct,
    weeklyYield: periodYieldPct,
    weeklyNormalizedYield: (periodYieldPct * 7) / dteDays,
    dteDays,
    distancePct: -8,
    popProfitEstimated: 0.9,
    liquidity: { spreadPct: 8 },
    volume: 300,
    openInterest: 800,
  };
  return {
    ticker: "AAPL",
    targetExpiration: "2026-07-24",
    dteDays,
    safeStrike: leg,
    aggressiveStrike: null,
    safeGrade: "A",
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "A",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
  };
}

test("Combinaisons capital transporte sans recalcul concurrent les DTE 1, 8 et 15", () => {
  for (const dteDays of [1, 8, 15]) {
    const built = buildCapitalComboCandidate(makeCandidate(dteDays), 100_000);
    assert.equal(built.dteDays, dteDays);
    assert.equal(built.selectedLeg?.dteDays, dteDays);
    assert.equal(resolveLegDte(built.selectedLeg, built), dteDays);
    assert.equal(projectSelectedLegMetadata(built).dte, dteDays);
    assert.equal(getCanonicalPeriodYieldBand("SAFE", resolveLegDte(built.selectedLeg, built)).dteDays, dteDays);
  }
});
