import test from "node:test";
import assert from "node:assert/strict";
import {
  TWO_PHASE_PUT_WINDOW,
  SAFE_SPREAD_RESCUE_STRIKES_ABOVE,
  SAFE_SPREAD_RESCUE_STRIKES_BELOW,
  buildSafeRescueStrikeWindow,
  attemptSafeSpreadRescue,
  getActiveSpreadPctForSelectedMode,
  shouldGlobalSpreadReject,
  normalizeSpreadPctPercent,
} from "./safeSpreadRescue.js";

test("constants — fenêtre two-phase = 10 strikes, rescue 2 haut / 4 bas", () => {
  assert.equal(TWO_PHASE_PUT_WINDOW, 10);
  assert.equal(SAFE_SPREAD_RESCUE_STRIKES_ABOVE, 2);
  assert.equal(SAFE_SPREAD_RESCUE_STRIKES_BELOW, 4);
});

test("buildSafeRescueStrikeWindow — 2 au-dessus et 4 en-dessous", () => {
  const ladder = [35, 36, 37, 37.5, 38, 38.5, 39, 39.5, 40];
  const window = buildSafeRescueStrikeWindow(38, ladder);
  assert.deepEqual(window, [35, 36, 37, 37.5, 38.5, 39]);
});

test("APLD-like — rescue remplace 38 spread 85% par 38.5 ou 37.5 plus propres", () => {
  const putCandidates = [
    { strike: 39, bid: 0.45, ask: 0.5, spreadPct: 0.117, primeUsed: 0.45, isBelowLowerBound: true },
    { strike: 38.5, bid: 0.31, ask: 0.46, spreadPct: 0.39, primeUsed: 0.31, isBelowLowerBound: true },
    {
      strike: 38,
      bid: 0.27,
      ask: 0.67,
      spreadPct: 0.851,
      primeUsed: 0.27,
      isBelowLowerBound: true,
    },
    { strike: 37.5, bid: 0.24, ask: 0.35, spreadPct: 0.377, primeUsed: 0.24, isBelowLowerBound: true },
  ];
  const safeOriginal = putCandidates.find((p) => p.strike === 38);
  const { safeStrike, diagnostics } = attemptSafeSpreadRescue({
    safeStrike: safeOriginal,
    aggressiveStrike: { strike: 39 },
    putCandidates,
    lowerBound: 39.2,
    targetPremium: 0.19,
    spot: 41,
    allStrikes: putCandidates.map((p) => p.strike),
  });

  assert.equal(diagnostics.safeSpreadRescueTriggered, true);
  assert.equal(diagnostics.safeOriginalStrike, 38);
  assert.notEqual(safeStrike.strike, 38);
  assert.ok(
    safeStrike.strike === 38.5 || safeStrike.strike === 37.5,
    `attendu 38.5 ou 37.5, reçu ${safeStrike.strike}`
  );
  assert.ok(normalizeSpreadPctPercent(safeStrike.spreadPct) < 85);
});

test("strike au-dessus meilleur spread mais trop proche — préférer plus bas acceptable", () => {
  const putCandidates = [
    { strike: 40, bid: 0.5, ask: 0.55, spreadPct: 0.095, primeUsed: 0.5, isBelowLowerBound: true },
    {
      strike: 39.5,
      bid: 0.42,
      ask: 0.44,
      spreadPct: 0.047,
      primeUsed: 0.42,
      isBelowLowerBound: false,
    },
    { strike: 38, bid: 0.3, ask: 0.55, spreadPct: 0.588, primeUsed: 0.3, isBelowLowerBound: true },
    { strike: 37.5, bid: 0.28, ask: 0.36, spreadPct: 0.25, primeUsed: 0.28, isBelowLowerBound: true },
  ];
  const { safeStrike } = attemptSafeSpreadRescue({
    safeStrike: putCandidates.find((p) => p.strike === 38),
    aggressiveStrike: { strike: 40 },
    putCandidates,
    lowerBound: 39.8,
    targetPremium: 0.2,
    spot: 42,
    allStrikes: putCandidates.map((p) => p.strike),
  });
  assert.equal(safeStrike.strike, 37.5);
});

test("aucun rescue acceptable — SAFE original conservé", () => {
  const putCandidates = [
    { strike: 38, bid: 0.27, ask: 0.67, spreadPct: 0.851, primeUsed: 0.27, isBelowLowerBound: true },
    { strike: 37.5, bid: 0.1, ask: 0.3, spreadPct: 1.0, primeUsed: 0.1, isBelowLowerBound: true },
  ];
  const original = putCandidates[0];
  const { safeStrike, diagnostics } = attemptSafeSpreadRescue({
    safeStrike: original,
    aggressiveStrike: { strike: 39 },
    putCandidates,
    lowerBound: 39,
    targetPremium: 0.2,
    spot: 41,
  });
  assert.equal(safeStrike.strike, 38);
  assert.equal(diagnostics.safeRescueReason, "no_acceptable_rescue_candidate");
});

test("rejet global spread — AGGRESSIVE sélectionné avec spread ok ignore SAFE rejeté", () => {
  const card = {
    finalDisplayMode: "AGGRESSIVE",
    safeStrike: { spreadPct: 85.1, weeklyYield: 0.71 },
    aggressiveStrike: { spreadPct: 12, weeklyYield: 1.1 },
  };
  assert.equal(getActiveSpreadPctForSelectedMode({ card }), 12);
  assert.equal(shouldGlobalSpreadReject(card), false);
});

test("rejet global spread — SAFE sélectionné avec spread mauvais", () => {
  const card = {
    finalDisplayMode: "SAFE",
    safeStrike: { spreadPct: 85.1, weeklyYield: 0.71 },
    aggressiveStrike: { spreadPct: 12, weeklyYield: 1.1 },
  };
  assert.equal(getActiveSpreadPctForSelectedMode({ card }), 85.1);
  assert.equal(shouldGlobalSpreadReject(card), true);
});

test("rejet global spread — BALANCED utilise jambe réellement retenue", () => {
  const card = {
    finalDisplayMode: "BALANCED",
    safeStrike: { spreadPct: 85, weeklyYield: 0.8 },
    aggressiveStrike: { spreadPct: 15, weeklyYield: 0.9 },
    _safeYieldPct: 0.8,
    _aggYieldPct: 0.9,
  };
  assert.equal(getActiveSpreadPctForSelectedMode({ card, selectedMode: "BALANCED" }), 15);
  assert.equal(shouldGlobalSpreadReject(card), false);
});
