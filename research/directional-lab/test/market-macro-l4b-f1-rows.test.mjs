import test from 'node:test';
import assert from 'node:assert/strict';
import { putCanonicalL3 } from '../src/contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  normalizeMacroStateBySessionRowsV1,
} from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import {
  buildMacroStateBySessionRows,
  verifyMacroStateBySessionRows,
} from '../src/macro/macroStateBySessionRowsL4BV1.mjs';
import { code, openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

const FAKE = (ch = 'a') => `sha256:${ch.repeat(64)}`;

test('official rows are strictly ordered by session date', () => {
  const rows = live.rows.macroStateBySessionRows.rows;
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].sessionDate <= rows[i].sessionDate);
  }
});

test('official rows verify byte-for-byte via recompute', () => {
  const verified = verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: live.rows.macroStateBySessionRowsId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
  assert.equal(verified.macroStateBySessionRows.rows.length, 6);
});

test('rows replay produces identical CAS id', () => {
  const built = buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
  assert.equal(built.macroStateBySessionRowsId, live.rows.macroStateBySessionRowsId);
});

test('duplicate session rows refuse normalization', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows[1] = structuredClone(bad.rows[0]);
  assert.throws(() => normalizeMacroStateBySessionRowsV1(bad));
});

test('forged policy direction on stored row refuses verify', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].rateState.policyDirection = 'EASING';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  }), code('MARKET_DATA_MACRO_STATE_ROWS_MISMATCH'));
});

test('forged curve shape on stored row refuses verify', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[2].curveState.curveShape = 'NORMAL';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  }), code('MARKET_DATA_MACRO_STATE_ROWS_MISMATCH'));
});

test('rows build refuses latest source bundle id', () => {
  assert.throws(() => buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: 'latest',
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  }));
});

test('rows build refuses missing policy id', () => {
  assert.throws(() => buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: live.sourceBundle.sourceBundleId,
  }));
});

test('rows verify refuses wrong source bundle pin on row', () => {
  assert.throws(() => verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: live.rows.macroStateBySessionRowsId,
    sourceBundleId: FAKE('b'),
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  }), code('MARKET_DATA_REFERENCE_MISSING'));
});

test('empty rows container normalizes', () => {
  const empty = normalizeMacroStateBySessionRowsV1({
    schemaVersion: MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
    rows: [],
  });
  assert.equal(empty.rows.length, 0);
});

test('each row sessionId matches MacroMarketSessionIdentity projection', () => {
  for (const row of live.rows.macroStateBySessionRows.rows) {
    assert.match(row.sessionId, /^sha256:[0-9a-f]{64}$/);
    assert.equal(row.sourceBundleId, live.sourceBundle.sourceBundleId);
    assert.equal(row.featureComputationPolicyId, live.featurePolicy.featureComputationPolicyId);
  }
});
