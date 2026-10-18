/** L4C-I2 canonical registry cardinality, order and dispatch. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import { EARNINGS_L4C_I2_SCHEMA_VERSIONS } from '../src/contracts/earningsContractsL4CIIV1.mjs';
import { withEarningsStore } from './earningsFiscalL4CIISyntheticFixture.mjs';

const L4C_I1_SCHEMA_VERSIONS = Object.freeze([
  'EarningsIngestionPolicy/1', 'EarningsMetricExtractionPolicy/1',
  'SecFilingSourceDocumentCore/1', 'SecDocumentBytesCore/1',
  'EarningsTaxonomyBundleManifest/1', 'XbrlCanonicalUnitCore/1',
  'FinancialPeriodIdentityCore/1', 'EarningsEventIdentityCore/1',
  'EarningsRevisionIdentityCore/1', 'EarningsRevisionCore/1',
  'EarningsMetricObservationCore/1', 'EarningsMetricExtractionReport/1',
  'EarningsEventSetManifest/1', 'EarningsRevisionSetManifest/1',
  'EarningsExtractionSetManifest/1', 'EarningsDatasetSnapshotManifest/1',
]);

test('I2-G001 SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length is 135', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 135);
});

test('I2-G002 SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS has 135 unique entries', () => {
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 135);
});

test('I2-G003 the six L4C-I2 schemas occupy the final six positions in the declared order', () => {
  assert.equal(EARNINGS_L4C_I2_SCHEMA_VERSIONS.length, 6);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(129, 135),
    [...EARNINGS_L4C_I2_SCHEMA_VERSIONS]);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-6),
    [...EARNINGS_L4C_I2_SCHEMA_VERSIONS]);
});

test('I2-G004 NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length is still 5', () => {
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  for (const schemaVersion of EARNINGS_L4C_I2_SCHEMA_VERSIONS) {
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(schemaVersion), false);
  }
});

test('I2-G005 EarningsParserImplementationManifest/1 is still absent', () => {
  assert.equal(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes('EarningsParserImplementationManifest/1'), false);
});

test('I2-G006 TransformImplementationManifest/2 is registered exactly once', () => {
  const occurrences = SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS
    .filter((schemaVersion) => schemaVersion === 'TransformImplementationManifest/2');
  assert.equal(occurrences.length, 1);
});

test('I2-G007 no L4C-E1, L4C-R1 or L4C-P schema is registered', () => {
  const forbidden = ['EarningsEstimateConsensus/1', 'EarningsRevisionFeature/1',
    'EarningsPublicationManifest/1', 'EarningsSurprise/1'];
  for (const schemaVersion of forbidden) {
    assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(schemaVersion), false);
  }
});

test('I2-G008 the sixteen L4C-I1 entries keep their absolute positions 113..128', () => {
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(113, 129),
    [...L4C_I1_SCHEMA_VERSIONS]);
});

test('I2-G009 normalizeCanonicalValue dispatches each of the six new schemas', () => {
  for (const schemaVersion of EARNINGS_L4C_I2_SCHEMA_VERSIONS) {
    // An empty record can never satisfy a closed contract, but the dispatcher
    // must reach the schema's own normalizer rather than report it as unknown.
    assert.throws(() => normalizeCanonicalValue(schemaVersion, { schemaVersion }), (error) => {
      assert.notEqual(error.code, 'CANONICAL_SCHEMA_UNKNOWN');
      return true;
    }, schemaVersion);
  }
});

test('I2-G010 putCanonicalObject refuses an L4C-I2 schema in the normalized namespace', () => {
  withEarningsStore((store) => {
    assert.throws(() => store.putCanonicalObject({
      namespace: 'normalized',
      schemaVersion: 'EarningsAsOfMaterializationReport/1',
      value: { schemaVersion: 'EarningsAsOfMaterializationReport/1' },
    }), (error) => typeof error.code === 'string');
  });
});
