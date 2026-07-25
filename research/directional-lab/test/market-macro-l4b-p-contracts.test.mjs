import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  MARKET_MACRO_AUTHORITY_POLICY_VALUES,
  MARKET_MACRO_FAMILY_CODES,
  MARKET_MACRO_FEATURE_PUBLICATION_L4BP_SCHEMA_VERSIONS,
  MARKET_MACRO_IMPLEMENTATION_PHASES,
  normalizeMarketMacroFeatureAuthorityPolicyV1,
  normalizeMarketMacroFeatureCoverageReportV1,
  normalizeMarketMacroFeaturePublicationManifestV1,
  normalizeMarketMacroFeatureRegistryManifestV1,
} from '../src/contracts/marketMacroFeaturePublicationContractsL4BPV1.mjs';
import {
  sampleCoverage,
  samplePolicy,
  samplePublication,
  sampleRegistry,
} from './helpers/marketMacroFeaturePublicationSamplesL4BPV1.mjs';

test('L4B-P remains registered in the additive snapshot registry (129 unique)', () => {
  assert.equal(MARKET_MACRO_FEATURE_PUBLICATION_L4BP_SCHEMA_VERSIONS.length, 4);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 129);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 129);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-20, -16),
    MARKET_MACRO_FEATURE_PUBLICATION_L4BP_SCHEMA_VERSIONS);
});

test('L4B-P leaves normalized namespace exactly five', () => {
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  assert.equal(new Set(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS).size, 5);
  for (const schema of MARKET_MACRO_FEATURE_PUBLICATION_L4BP_SCHEMA_VERSIONS) {
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(schema), false);
  }
});

test('L4B-P family order is closed at eight', () => {
  assert.deepEqual(MARKET_MACRO_FAMILY_CODES, [
    'RATES', 'FOMC', 'TREASURY_CURVE', 'INFLATION', 'UNEMPLOYMENT',
    'CLAIMS', 'FULL_MACRO_STATE', 'INSTRUMENT_PROJECTION',
  ]);
});

test('L4B-P implementation phase order is I1/I2/F1/F2', () => {
  assert.deepEqual(MARKET_MACRO_IMPLEMENTATION_PHASES, ['I1', 'I2', 'F1', 'F2']);
});

const samples = [
  [samplePolicy, normalizeMarketMacroFeatureAuthorityPolicyV1],
  [sampleRegistry, normalizeMarketMacroFeatureRegistryManifestV1],
  [sampleCoverage, normalizeMarketMacroFeatureCoverageReportV1],
  [samplePublication, normalizeMarketMacroFeaturePublicationManifestV1],
];

for (const [factory, normalize] of samples) {
  test(`contract round-trip ${factory.name}`, () => {
    const value = factory();
    assert.deepEqual(normalize(value), value);
    assert.deepEqual(normalizeCanonicalValue(value.schemaVersion, value), value);
  });
  test(`contract rejects unknown field ${factory.name}`, () => {
    const value = factory();
    value.unexpected = true;
    assert.throws(() => normalize(value));
  });
  test(`contract rejects missing schemaVersion ${factory.name}`, () => {
    const value = factory();
    delete value.schemaVersion;
    assert.throws(() => normalize(value));
  });
  test(`contract canonical bytes are clone-stable ${factory.name}`, () => {
    const value = factory();
    assert.deepEqual(normalize(value), normalize(structuredClone(value)));
  });
}

test('authority policy forbids network/latest/score/recommendation', () => {
  assert.equal(MARKET_MACRO_AUTHORITY_POLICY_VALUES.networkPolicy, 'FORBIDDEN');
  assert.equal(MARKET_MACRO_AUTHORITY_POLICY_VALUES.latestPolicy, 'FORBIDDEN');
  assert.equal(MARKET_MACRO_AUTHORITY_POLICY_VALUES.scorePolicy, 'FORBIDDEN');
  assert.equal(MARKET_MACRO_AUTHORITY_POLICY_VALUES.recommendationPolicy, 'FORBIDDEN');
});
