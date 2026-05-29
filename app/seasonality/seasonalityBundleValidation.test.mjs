import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeBundlePayload,
  getBundleRecommendation,
  isValidBundlePayload,
} from "./seasonalityBundleValidation.js";

const INVALID_EMPTY = {
  calendarData:  null,
  shortTermData: null,
  windowsData:   null,
  chart3yData:   { ok: false, error: "no chart data available" },
};

const VALID_CHART_ONLY = {
  calendarData:  null,
  shortTermData: null,
  windowsData:   null,
  chart3yData:   { ok: true, series: [] },
};

test("bundle entièrement vide => INVALID", () => {
  const a = analyzeBundlePayload(INVALID_EMPTY);
  assert.equal(a.validBundle, false);
  assert.equal(isValidBundlePayload(INVALID_EMPTY), false);
});

test("chart3y ok=true suffit pour bundle valide", () => {
  assert.equal(isValidBundlePayload(VALID_CHART_ONLY), true);
});

test("cache hit + bundle invalide => CACHE_CORROMPU", () => {
  const rec = getBundleRecommendation({ cacheHit: true, validBundle: false });
  assert.match(rec, /CACHE_CORROMPU/);
});

test("bundle invalide sans cache => INVALID", () => {
  const rec = getBundleRecommendation({ cacheHit: false, validBundle: false });
  assert.match(rec, /INVALID/);
});
