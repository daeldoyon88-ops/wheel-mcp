import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LIQUIDITY_OTM_PROBE_PCT } from "../config/constants.js";
import { evaluateOtmPutLiquidityProbe } from "./watchlistFilters.js";
import { resolveEffectiveOtmProbePercent } from "../../scripts/otmProbeAuditApld.mjs";

test("resolveEffectiveOtmProbePercent — 6 reste 6", () => {
  const r = resolveEffectiveOtmProbePercent(6);
  assert.equal(r.effectiveOtmProbePercent, 6);
  assert.equal(r.probeMode, "OTM_PROBE");
  assert.equal(r.fallbackReason, null);
});

test("resolveEffectiveOtmProbePercent — 0 = ATM_ONLY", () => {
  const r = resolveEffectiveOtmProbePercent(0);
  assert.equal(r.effectiveOtmProbePercent, 0);
  assert.equal(r.probeMode, "ATM_ONLY");
  assert.equal(r.fallbackReason, "explicit_zero_disables_otm");
});

test("resolveEffectiveOtmProbePercent — absent → défaut projet", () => {
  const r = resolveEffectiveOtmProbePercent(undefined);
  assert.equal(r.effectiveOtmProbePercent, DEFAULT_LIQUIDITY_OTM_PROBE_PCT);
  assert.match(r.fallbackReason, /default/);
});

test("evaluateOtmPutLiquidityProbe — pct 0 skip sans rejeter", () => {
  const r = evaluateOtmPutLiquidityProbe({ puts: [] }, 100, 0);
  assert.equal(r.ok, true);
  assert.equal(r.detail?.skipped, true);
});

test("evaluateOtmPutLiquidityProbe — pas de fallback implicite vers 0 si chaîne vide", () => {
  const r = evaluateOtmPutLiquidityProbe({ puts: [] }, 100, 6);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_liquid_otm_put");
  assert.equal(r.detail?.minOtmPct, 6);
});
