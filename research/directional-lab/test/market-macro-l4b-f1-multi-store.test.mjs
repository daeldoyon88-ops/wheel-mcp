import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { withOfficialMacroL4BF1Fixture } from './macroFeaturesL4BSyntheticFixture.mjs';

export const GOLDEN_L4B_F1 = Object.freeze({
  featureComputationPolicyId: 'sha256:240d4fb9b6e202e93514c72c450ef86f2a01bcfe2e1ff2ebdc6bad815988274f',
  sourceBundleId: 'sha256:aff19b2fad1b014c34eefa79eba4ef66f6d2428ceb28493ee484d3514720d717',
  macroStateBySessionRowsId: 'sha256:9b094928a79f8af13ae22830c4ace19b0bc05b249b3ace9677c490dabcce7b6a',
  macroFeatureComputationReportId: 'sha256:fb7e6891135b6e889208e37c71133024d86b3ebfbe715a0f6117b295a0d5e516',
});

function fingerprint(ctx) {
  return {
    featureComputationPolicyId: ctx.featurePolicy.featureComputationPolicyId,
    sourceBundleId: ctx.sourceBundle.sourceBundleId,
    macroStateBySessionRowsId: ctx.rows.macroStateBySessionRowsId,
    macroFeatureComputationReportId: ctx.report.macroFeatureComputationReportId,
    bytes: [
      ctx.featurePolicy.featureComputationPolicy,
      ctx.sourceBundle.sourceBundle,
      ctx.rows.macroStateBySessionRows,
      ctx.report.featureComputationReport,
    ].map((value) => canonicalJsonBytes(value).toString('hex')),
  };
}

test('store A and B produce identical F1 IDs and bytes', () => {
  const a = withOfficialMacroL4BF1Fixture(fingerprint);
  const b = withOfficialMacroL4BF1Fixture(fingerprint);
  assert.deepEqual(a, b);
  assert.deepEqual(a, b);
});

test('official F1 fixture reproduces pinned golden IDs', () => {
  const actual = withOfficialMacroL4BF1Fixture((ctx) => {
    const { bytes, ...ids } = fingerprint(ctx);
    return ids;
  });
  assert.deepEqual(actual, GOLDEN_L4B_F1);
});

test('F1 golden byte fingerprints are stable across two builds', () => {
  const first = withOfficialMacroL4BF1Fixture((ctx) => fingerprint(ctx).bytes);
  const second = withOfficialMacroL4BF1Fixture((ctx) => fingerprint(ctx).bytes);
  assert.deepEqual(first, second);
});
