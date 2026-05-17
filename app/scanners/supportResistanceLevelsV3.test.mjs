import assert from "node:assert/strict";
import test from "node:test";

import { buildSupportResistanceLevelsV3 } from "./supportResistanceLevelsV3.js";

const emptyDiag = { notes: [] };

test("V3: near / wide / résistances — S1 S2 R1 R2, max 3, tri", () => {
  const v3 = buildSupportResistanceLevelsV3({
    spot: 100,
    strike: 97,
    dteDays: 5,
    supportResistance: {
      supportNear: 97,
      supportWide: 88,
      resistanceAboveSpot: 108,
      resistanceCurrent: 104,
    },
    priceSeries: null,
    supportDiagnosticsV1: emptyDiag,
    supportScoringV2: { strikeSupportLevelUsed: "near", enabled: true },
  });

  assert.equal(v3.version, "support_resistance_levels_v3");
  assert.equal(v3.diagnosticOnly, true);
  assert.equal(v3.supportsBelowSpot.length, 2);
  assert.equal(v3.supportsBelowSpot[0].label, "S1");
  assert.equal(v3.supportsBelowSpot[0].price, 97);
  assert.equal(v3.supportsBelowSpot[1].label, "S2");
  assert.equal(v3.supportsBelowSpot[1].price, 88);
  assert.ok(v3.supportsBelowSpot[0].confidence === "high" || v3.supportsBelowSpot[0].confidence === "medium");
  assert.equal(v3.resistancesAboveSpot.length, 2);
  assert.equal(v3.resistancesAboveSpot[0].label, "R1");
  assert.equal(v3.resistancesAboveSpot[0].price, 104);
  assert.equal(v3.resistancesAboveSpot[1].label, "R2");
  assert.equal(v3.resistancesAboveSpot[1].price, 108);
  assert.ok(v3.supportsBelowSpot.length <= 3);
  assert.ok(v3.resistancesAboveSpot.length <= 3);
});

test("V3: closes seulement — swings simples, confidence basse/medium, diagnosticOnly", () => {
  const closes = [102, 100, 99, 95, 96, 94, 98, 103, 101, 105, 104, 107];
  const v3 = buildSupportResistanceLevelsV3({
    spot: 100,
    strike: 96,
    dteDays: 4,
    supportResistance: {},
    priceSeries: { closes, count: closes.length },
    supportDiagnosticsV1: { notes: ["supportNear indisponible: test."] },
    supportScoringV2: { strikeSupportLevelUsed: "wide", enabled: true },
  });

  assert.equal(v3.diagnosticOnly, true);
  assert.ok(v3.supportsBelowSpot.length >= 1);
  assert.ok(v3.resistancesAboveSpot.length >= 1);
  const lowConf = [...v3.supportsBelowSpot, ...v3.resistancesAboveSpot].filter((x) => x.type === "swing");
  assert.ok(lowConf.length >= 1);
  for (const x of lowConf) {
    assert.equal(x.confidence, "low");
  }
});

test("V3: flip resistanceCurrent sous spot + supportWide au-dessus", () => {
  const v3 = buildSupportResistanceLevelsV3({
    spot: 100,
    strike: 96,
    dteDays: 3,
    supportResistance: {
      supportNear: 95,
      supportWide: 102,
      resistanceCurrent: 98,
      resistanceAboveSpot: 110,
    },
    priceSeries: null,
    supportDiagnosticsV1: emptyDiag,
    supportScoringV2: { strikeSupportLevelUsed: "near", enabled: true },
  });

  assert.ok(v3.flippedLevels.length >= 2);
  const fr = v3.flippedLevels.find((f) => f.from === "resistance" && f.to === "support");
  const fs = v3.flippedLevels.find((f) => f.from === "support" && f.to === "resistance");
  assert.ok(fr);
  assert.equal(fr.price, 98);
  assert.ok(fs);
  assert.equal(fs.price, 102);
  assert.ok(v3.resistancesAboveSpot.some((r) => r.price === 102));
});

test("V3: données insuffisantes — pas d'exception, notes explicites", () => {
  const v3 = buildSupportResistanceLevelsV3({
    spot: null,
    strike: null,
    dteDays: null,
    supportResistance: {},
    priceSeries: null,
    supportDiagnosticsV1: null,
    supportScoringV2: null,
  });

  assert.equal(v3.supportsBelowSpot.length, 0);
  assert.equal(v3.resistancesAboveSpot.length, 0);
  assert.ok(Array.isArray(v3.notes));
  assert.ok(v3.notes.some((n) => /Spot indisponible/i.test(n)));
});
