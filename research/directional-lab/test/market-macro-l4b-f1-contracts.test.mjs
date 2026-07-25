/**
 * L4B-F1 contracts: schema registration and wire normalization for all four F1 types.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES,
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  normalizeMarketMacroFeatureComputationPolicyV1,
  normalizeMarketMacroFeatureSourceBundleV1,
  normalizeMacroStateBySessionRowsV1,
  normalizeMarketMacroFeatureComputationReportV1,
} from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import { openOfficialMacroL4BF1Live, code } from './macroFeaturesL4BSyntheticFixture.mjs';
import { putCanonicalL3 } from '../src/contracts/marketDataL3CommonV1.mjs';
import { verifyMarketMacroFeatureComputationReport } from '../src/macro/marketMacroFeatureComputationReportL4BV1.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

const ID = `sha256:${'a'.repeat(64)}`;

const valid = {
  policy: () => ({
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
  }),
  sourceBundle: () => structuredClone(live.sourceBundle.sourceBundle),
  rows: () => structuredClone(live.rows.macroStateBySessionRows),
  report: () => structuredClone(live.report.featureComputationReport),
};
const normalize = {
  policy: normalizeMarketMacroFeatureComputationPolicyV1,
  sourceBundle: normalizeMarketMacroFeatureSourceBundleV1,
  rows: normalizeMacroStateBySessionRowsV1,
  report: normalizeMarketMacroFeatureComputationReportV1,
};
const schema = {
  policy: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  sourceBundle: MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  rows: MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  report: MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
};

test('L4B-F1 schemas remain registered inside the 129-schema additive registry', () => {
  assert.equal(MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS.length, 4);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 129);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 129);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-28, -24), MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS);
});

test('L4B-F1 adds no normalized CAS type: exactly 5', () => {
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  for (const item of MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS) {
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(item), false);
  }
});

test('closed macro feature policy singleton normalizes and dispatches', () => {
  const policy = normalize.policy(valid.policy());
  assert.equal(policy.policyVersion, 'MARKET_MACRO_FEATURE_COMPUTATION_L4B_F1_V1');
  assert.equal(policy.rateFeatureScale, 6);
  assert.deepEqual(normalizeCanonicalValue(schema.policy, policy), policy);
});

test('F1 schema names are the closed quartet', () => {
  assert.deepEqual(MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS, [
    MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
    MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  ]);
});

for (const name of Object.keys(valid)) {
  test(`${name} valid value dispatches and has stable canonical bytes`, () => {
    const value = valid[name]();
    assert.deepEqual(normalizeCanonicalValue(schema[name], value), normalize[name](value));
    assert.deepEqual(canonicalJsonBytes(normalize[name](value)), canonicalJsonBytes(normalize[name](value)));
  });
  test(`${name} rejects an unknown own key`, () => {
    assert.throws(() => normalize[name]({ ...valid[name](), unexpected: true }));
  });
  test(`${name} rejects a missing required key`, () => {
    const value = valid[name]();
    delete value.schemaVersion;
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects a Symbol key`, () => {
    const value = valid[name]();
    value[Symbol.for('bad')] = true;
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects an accessor`, () => {
    const value = valid[name]();
    const field = Object.keys(value)[1];
    const previous = value[field];
    delete value[field];
    Object.defineProperty(value, field, { enumerable: true, get: () => previous });
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects a non-enumerable field`, () => {
    const value = valid[name]();
    const field = Object.keys(value)[1];
    const previous = value[field];
    delete value[field];
    Object.defineProperty(value, field, { enumerable: false, value: previous });
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects a prototype carrier`, () => {
    const value = Object.assign(Object.create({ inherited: true }), valid[name]());
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects wrong schema version`, () => {
    assert.throws(() => normalize[name]({ ...valid[name](), schemaVersion: `${schema[name]}/2` }));
  });
}

test('policy rejects every closed enum/value divergence', () => {
  for (const key of Object.keys(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES)) {
    const policy = valid.policy();
    policy[key] = 'FORGED';
    assert.throws(() => normalize.policy(policy), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
  }
});

test('sourceBundle rejects bad civil date ordering', () => {
  const bad = valid.sourceBundle();
  bad.featureComputationStartSessionDate = '2026-03-09';
  bad.featureComputationEndSessionDateInclusive = '2026-03-02';
  assert.throws(() => normalize.sourceBundle(bad));
});

test('sourceBundle rejects bad CAS reference', () => {
  const bad = valid.sourceBundle();
  bad.macroDatasetBindingId = 'latest';
  assert.throws(() => normalize.sourceBundle(bad));
});

test('rows rejects unsorted session order', () => {
  const bad = valid.rows();
  bad.rows = [...bad.rows].reverse();
  assert.throws(() => normalize.rows(bad));
});

test('rows rejects Date object timestamp', () => {
  const bad = valid.rows();
  bad.rows[0].sessionOpenUtc = new Date(bad.rows[0].sessionOpenUtc);
  assert.throws(() => normalize.rows(bad));
});

test('rows rejects bad fixed-point atoms', () => {
  const bad = valid.rows();
  bad.rows[0].rateState.fedTargetLowerBound = { atoms: '1.5', scale: 6 };
  assert.throws(() => normalize.rows(bad));
});

test('report forged sessionCount refuses verify', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.sessionCount += 1;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureComputationReport({
    store: live.store, macroFeatureComputationReportId: stored.objectId,
  }));
});

test('report forged digest refuses verify', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.orderedSessionIdentityDigest = ID;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureComputationReport({
    store: live.store, macroFeatureComputationReportId: stored.objectId,
  }));
});

test('report rejects bad timestamp on bound fields', () => {
  const bad = valid.report();
  bad.firstSessionDate = '2026/03/02';
  assert.throws(() => normalize.report(bad));
});

test('report rejects emptyComputation diverging from sessionCount', () => {
  const bad = valid.report();
  bad.emptyComputation = true;
  assert.throws(() => normalize.report(bad));
});

test('report rejects forged counter map key', () => {
  const bad = valid.report();
  bad.countsByPolicyDirection = { ...bad.countsByPolicyDirection, FORGED: 1 };
  assert.throws(() => normalize.report(bad));
});

test('rows rejects duplicate sessionId', () => {
  const bad = valid.rows();
  bad.rows[1].sessionId = bad.rows[0].sessionId;
  bad.rows[1].sessionDate = bad.rows[0].sessionDate;
  bad.rows[1].sessionOpenUtc = bad.rows[0].sessionOpenUtc;
  bad.rows[1].sessionCloseUtc = bad.rows[0].sessionCloseUtc;
  assert.throws(() => normalize.rows(bad));
});

test('sourceBundle rejects Date object on civil date field', () => {
  const bad = valid.sourceBundle();
  bad.featureComputationStartSessionDate = new Date('2026-03-02');
  assert.throws(() => normalize.sourceBundle(bad));
});

test('policy rejects bad fixed-point threshold scale', () => {
  const bad = valid.policy();
  bad.rateRegimeThresholds = {
    ...bad.rateRegimeThresholds,
    lowMaxExclusive: { atoms: '200', scale: 3 },
  };
  assert.throws(() => normalize.policy(bad), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});
