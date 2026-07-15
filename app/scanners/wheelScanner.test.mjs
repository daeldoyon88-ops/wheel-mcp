import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveFiniteBalancedStrikeBoundaries,
  resolveSelectedStrikeForSupportResistanceV4,
} from "./wheelScanner.js";

test("resolveFiniteBalancedStrikeBoundaries: normalise les frontières inversées", () => {
  assert.deepEqual(resolveFiniteBalancedStrikeBoundaries(75, 67), {
    valid: true,
    lowerBoundaryStrike: 67,
    upperBoundaryStrike: 75,
  });
});

test("resolveFiniteBalancedStrikeBoundaries: refuse les frontières non finies", () => {
  for (const [safe, aggressive] of [
    [NaN, 75],
    [67, Infinity],
    [null, 75],
    [67, undefined],
  ]) {
    assert.deepEqual(resolveFiniteBalancedStrikeBoundaries(safe, aggressive), {
      valid: false,
      lowerBoundaryStrike: null,
      upperBoundaryStrike: null,
    });
  }
});

test("resolveSelectedStrikeForSupportResistanceV4: aggressive selected prioritaire", () => {
  const strike = resolveSelectedStrikeForSupportResistanceV4({
    aggressiveStrike: { strike: 160, selected: true },
    safeStrike: { strike: 155, selected: false },
  });
  assert.equal(strike, 160);
});

test("resolveSelectedStrikeForSupportResistanceV4: safe selected si agressif non selectionne", () => {
  const strike = resolveSelectedStrikeForSupportResistanceV4({
    aggressiveStrike: { strike: 160, selected: false },
    safeStrike: { strike: 155, selected: true },
  });
  assert.equal(strike, 155);
});

test("resolveSelectedStrikeForSupportResistanceV4: selected final explicite avant fallback safe", () => {
  const strike = resolveSelectedStrikeForSupportResistanceV4({
    aggressiveStrike: { strike: 160 },
    safeStrike: { strike: 155 },
    finalDisplayMode: "AGGRESSIVE",
    finalDisplayGrade: "B",
  });
  assert.equal(strike, 160);
});

test("resolveSelectedStrikeForSupportResistanceV4: fallback safe si rien n'est selectionne", () => {
  const strike = resolveSelectedStrikeForSupportResistanceV4({
    aggressiveStrike: { strike: 160, selected: false },
    safeStrike: { strike: 155, selected: false },
    finalDisplayMode: "REJECT",
    finalDisplayGrade: "REJECT",
  });
  assert.equal(strike, 155);
});

test("resolveSelectedStrikeForSupportResistanceV4: null si aucun strike valide", () => {
  const strike = resolveSelectedStrikeForSupportResistanceV4({
    aggressiveStrike: null,
    safeStrike: null,
    selectedOption: null,
  });
  assert.equal(strike, null);
});
