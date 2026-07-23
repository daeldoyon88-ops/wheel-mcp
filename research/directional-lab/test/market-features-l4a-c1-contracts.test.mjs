import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import {
  MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1,
  MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_L4_SCHEMA_VERSIONS,
  MARKET_SEASONALITY_FEATURE_POLICY_VALUES,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketSeasonalityFeatureComputationPolicyV1,
  normalizeMarketSeasonalityFeatureRowsV1,
  normalizeMarketSeasonalityFeatureSourceBundleV1,
} from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import { deriveMarketSeasonalityRuntimePolicyV1 } from '../src/features/marketSeasonalityRuntimePolicyL4V1.mjs';

const ID = `sha256:${'a'.repeat(64)}`;

function bundle() {
  return {
    schemaVersion: MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    subjectBindingRegistryManifestId: ID,
    subjectBindingId: ID,
    datasetSnapshotManifestId: ID,
    normalizedMarketDataObjectId: ID,
    knowledgeCutoff: '2026-01-02T22:00:00.000Z',
    temporalCapability: 'RETROSPECTIVE_CAPTURE_ONLY',
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    instrumentIdentityId: ID,
    calendarRegistryManifestId: ID,
    implementationManifestId: ID,
  };
}

function policy() {
  return JSON.parse(JSON.stringify({
    schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_SEASONALITY_FEATURE_POLICY_VALUES,
  }));
}

test('L4A-C1/C2 seasonality schemas remain registered before C3 (97 total)', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 109);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 109);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-26, -23), [
    ...MARKET_SEASONALITY_FEATURE_L4_SCHEMA_VERSIONS,
  ]);
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  assert.deepEqual(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.slice(-1), [
    MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  ]);
  assert.equal(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION),
    false,
  );
  assert.equal(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes('MarketFeaturePublicationManifest/1'),
    true,
  );
});

test('L4A-C1 source bundle is closed against unknown, hidden and Symbol keys', () => {
  assert.deepEqual(normalizeMarketSeasonalityFeatureSourceBundleV1(bundle()), bundle());
  assert.throws(() => normalizeMarketSeasonalityFeatureSourceBundleV1({ ...bundle(), latest: true }));
  const hidden = bundle();
  Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
  assert.throws(() => normalizeMarketSeasonalityFeatureSourceBundleV1(hidden));
  const symbol = bundle();
  symbol[Symbol('alien')] = true;
  assert.throws(() => normalizeMarketSeasonalityFeatureSourceBundleV1(symbol));
});

test('L4A-C1 policy normalizes and derives the exact closed runtime', () => {
  const normalized = normalizeMarketSeasonalityFeatureComputationPolicyV1(policy());
  const runtime = deriveMarketSeasonalityRuntimePolicyV1(normalized);
  assert.deepEqual(runtime.horizons, [3, 5, 10, 15]);
  assert.deepEqual(runtime.forwardSessionCounts, [5, 10, 20, 40, 60]);
  assert.equal(runtime.internalScale, 24);
  assert.equal(runtime.ratioScale, 12);
  assert.equal(runtime.roundingMode, 'HALF_EVEN');
  assert.equal(runtime.futureDataPolicy, 'FORBIDDEN');
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.horizons), true);
});

for (const [name, mutate] of [
  ['unknown', (value) => { value.alien = true; }],
  ['missing horizon', (value) => { value.horizons = [3, 5, 10]; }],
  ['extra horizon', (value) => { value.horizons = [3, 5, 10, 15, 20]; }],
  ['horizon order', (value) => { value.horizons = [5, 3, 10, 15]; }],
  ['window missing', (value) => { value.forwardSessionCounts = [5, 10, 20, 40]; }],
  ['window order', (value) => { value.forwardSessionCounts = [10, 5, 20, 40, 60]; }],
  ['scale', (value) => { value.ratioScale = 10; }],
  ['rounding', (value) => { value.roundingMode = 'HALF_UP'; }],
  ['future', (value) => { value.futureDataPolicy = 'ALLOWED'; }],
]) {
  test(`L4A-C1 policy refuses ${name}`, () => {
    const value = policy();
    mutate(value);
    assert.throws(
      () => normalizeMarketSeasonalityFeatureComputationPolicyV1(value),
      (error) => error?.code === MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1,
    );
  });
}

test('L4A-C1 policy refuses non-enumerable, accessor and Symbol own keys', () => {
  for (const mutate of [
    (value) => Object.defineProperty(value, 'hidden', { value: true, enumerable: false }),
    (value) => Object.defineProperty(value, 'ratioScale', { get: () => 12, enumerable: true }),
    (value) => { value[Symbol('alien')] = true; },
  ]) {
    const value = policy();
    mutate(value);
    assert.throws(() => normalizeMarketSeasonalityFeatureComputationPolicyV1(value));
  }
});

test('L4A-C1 empty normalized rows are canonical and unknown schema dispatch stays closed', () => {
  const empty = {
    schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    rows: [],
  };
  assert.deepEqual(normalizeMarketSeasonalityFeatureRowsV1(empty), empty);
  assert.deepEqual(normalizeCanonicalValue(MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION, empty), empty);
  assert.throws(() => normalizeCanonicalValue('MarketSeasonalityFeatureReport/1', {}));
});
