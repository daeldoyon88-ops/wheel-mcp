import assert from "node:assert/strict";
import test from "node:test";

import { evaluateLiquidity, evaluateTradability, selectPutStrikes } from "./wheelMetrics.js";

const liquidBook = { bid: 0.5, ask: 0.6, lastPrice: 0.55, volume: 100, openInterest: 100, strike: 90 };
const crossed = { bid: 1, ask: 0.5, lastPrice: 0.8, volume: 100, openInterest: 100, strike: 90 };
const equalBook = { bid: 0.5, ask: 0.5, lastPrice: 0.5, volume: 100, openInterest: 100, strike: 90 };
const absentBid = { bid: null, ask: 0.6, lastPrice: 0.55, volume: 100, openInterest: 100, strike: 90 };
const zeroBid = { bid: 0, ask: 0.6, lastPrice: 0.55, volume: 100, openInterest: 100, strike: 90 };

test("marché croisé : isLiquid=false, isTradable=false, CROSSED_MARKET", () => {
  const liq = evaluateLiquidity(crossed);
  const trad = evaluateTradability(crossed);
  assert.equal(liq.checks.rejectReason, "CROSSED_MARKET");
  assert.equal(trad.checks.rejectReason, "CROSSED_MARKET");
  assert.equal(liq.isLiquid, false);
  assert.equal(trad.isTradable, false);
});

test("livre normal inchangé", () => {
  const liq = evaluateLiquidity(liquidBook);
  const trad = evaluateTradability(liquidBook);
  assert.equal(liq.isLiquid, true);
  assert.equal(trad.isTradable, true);
  assert.equal(liq.checks.rejectReason, null);
});

test("marché égal (bid=ask) reste valide", () => {
  const liq = evaluateLiquidity(equalBook);
  assert.equal(liq.isLiquid, true);
  assert.equal(liq.spreadPct, 0);
});

test("bid absent / zéro : pas de marché réel, pas CROSSED_MARKET", () => {
  assert.equal(evaluateLiquidity(absentBid).isLiquid, false);
  assert.equal(evaluateLiquidity(absentBid).checks.rejectReason, "no_real_bid_ask");
  assert.equal(evaluateLiquidity(zeroBid).isLiquid, false);
  assert.equal(evaluateLiquidity(zeroBid).checks.rejectReason, "no_real_bid_ask");
});

test("ask absent n'est pas un marché croisé", () => {
  const missingAsk = { bid: 1, ask: null, lastPrice: 0.8, volume: 100, openInterest: 100, strike: 90 };
  assert.equal(evaluateLiquidity(missingAsk).checks.rejectReason, "no_real_bid_ask");
  assert.equal(evaluateTradability(missingAsk).checks.rejectReason, "no_real_bid_ask");
});

test("selectPutStrikes ignore le croisé et conserve le livre liquide", () => {
  const puts = [
    { ...crossed, strike: 95 },
    { ...liquidBook, strike: 90, bid: 0.8, ask: 0.9 },
  ];
  const selected = selectPutStrikes({
    puts,
    spot: 100,
    lowerBoundForSelection: 96,
    dteDays: 7,
  });
  const liquidStrikes = (selected.liquidEligible || selected.eligible || []).map((p) => p.strike);
  assert.ok(!liquidStrikes.includes(95), "le croisé ne doit pas rester liquide");
});
