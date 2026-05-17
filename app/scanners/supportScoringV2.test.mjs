import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORT_SCORING_V2_SHORT_DTE_MAX,
  buildSupportScoringV2,
} from "./supportScoringV2.js";

test("supportScoringV2: wide pénalise, near favorable (exemple utilisateur)", () => {
  const s = buildSupportScoringV2({
    spot: 108.77,
    strike: 92,
    dteDays: 5,
    supportWide: 45.45,
    supportNear: 106.58,
    legacySupportStatus: "strike_above_support",
    enabled: true,
  });

  assert.equal(s.supportStatusV2, "strike_below_support");
  assert.equal(s.changedVsLegacy, true);
  assert.equal(s.legacyQualitySupportDelta, -12);
  assert.equal(s.v2QualitySupportDelta, 8);
  assert.equal(s.qualityScoreDeltaLegacyVsV2, 20);
  assert.equal(s.strikeSupportLevelUsed, "near");
  assert.equal(s.shortDteMax, SUPPORT_SCORING_V2_SHORT_DTE_MAX);
  assert.ok(s.shouldApplyQualityScoreV2);
});

test("supportScoringV2: wide et near quasi alignés, strike sous les deux", () => {
  const s = buildSupportScoringV2({
    spot: 138,
    strike: 125,
    dteDays: 5,
    supportWide: 133.02,
    supportNear: 133.46,
    legacySupportStatus: "strike_below_support",
    enabled: true,
  });

  assert.equal(s.supportStatusV2, "strike_below_support");
  assert.equal(s.changedVsLegacy, false);
  assert.equal(s.legacyQualitySupportDelta, s.v2QualitySupportDelta);
  assert.equal(s.qualityScoreDeltaLegacyVsV2, 0);
  assert.ok(!s.shouldApplyQualityScoreV2);
});

test("supportScoringV2: supportNear absent — fallback wide, pas de changement vs legacy aligné", () => {
  const s = buildSupportScoringV2({
    spot: 100,
    strike: 88,
    dteDays: 3,
    supportWide: 90,
    supportNear: null,
    legacySupportStatus: "strike_below_support",
    enabled: true,
  });

  assert.equal(s.strikeSupportLevelUsed, "wide");
  assert.equal(s.supportStatusV2, "strike_below_support");
  assert.equal(s.changedVsLegacy, false);
});

test("supportScoringV2: spot sous le support structural (min wide/near)", () => {
  const s = buildSupportScoringV2({
    spot: 94,
    strike: 88,
    dteDays: 5,
    supportWide: 100,
    supportNear: 105,
    legacySupportStatus: "strike_above_support",
    enabled: true,
  });

  assert.equal(Math.min(100, 105), 100);
  assert.equal(s.supportStatusV2, "current_below_support");
  assert.equal(s.v2QualitySupportDelta, -35);
});

test("supportScoringV2: désactivé — deltas identiques", () => {
  const s = buildSupportScoringV2({
    spot: 108.77,
    strike: 92,
    dteDays: 5,
    supportWide: 45.45,
    supportNear: 106.58,
    legacySupportStatus: "strike_above_support",
    enabled: false,
  });

  assert.equal(s.v2QualitySupportDelta, -12);
  assert.equal(s.qualityScoreDeltaLegacyVsV2, 0);
  assert.ok(!s.shouldApplyQualityScoreV2);
});
