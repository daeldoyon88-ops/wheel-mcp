import assert from "node:assert/strict";
import test from "node:test";

import { buildSupportDiagnosticsV1 } from "./supportDiagnosticsV1.js";

test("buildSupportDiagnosticsV1: wide vs near désaccord type wide_penalizes", () => {
  const d = buildSupportDiagnosticsV1({
    spot: 100,
    strike: 98,
    supportWide: 80,
    supportNear: 97,
    resistanceWide: 110,
    resistanceNear: 105,
    currentSupportStatusUsedByScoring: "strike_above_support",
    dteDays: 5,
  });
  assert.equal(d.whichSupportUsedByCurrentScoring, "wide");
  assert.equal(d.supportStatusWide, "strike_above_support");
  assert.equal(d.supportStatusNear, "strike_near_support");
  assert.equal(d.nearVsWideDisagreement, true);
  assert.equal(d.disagreementType, "wide_penalizes_near_support_ok");
  assert.equal(d.supportNearLooksMoreRelevantForShortDte, true);
  assert.equal(d.strikeVsSupportWidePct, 22.5);
  assert.equal(d.strikeVsSupportNearPct, 1.03);
});

test("buildSupportDiagnosticsV1: near_unavailable", () => {
  const d = buildSupportDiagnosticsV1({
    spot: 100,
    strike: 95,
    supportWide: 90,
    supportNear: null,
    resistanceWide: null,
    resistanceNear: null,
    currentSupportStatusUsedByScoring: "strike_near_support",
    dteDays: 3,
  });
  assert.equal(d.disagreementType, "near_unavailable");
  assert.equal(d.nearVsWideDisagreement, false);
  assert.equal(d.supportNearLooksMoreRelevantForShortDte, null);
});
