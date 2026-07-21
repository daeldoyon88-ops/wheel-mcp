import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeMarketFeatureOrderedRowIdentityDigestV1,
  deriveMarketFeatureSessionCoverageV1,
} from '../src/publication/marketFeaturePublicationV1.mjs';
import {
  oracleHasCycle,
  oracleLogicalKey,
  oracleOrderedRowIdentityDigest,
  oracleResolveAsOf,
  oracleSessionCoverage,
  oracleTips,
} from './helpers/independentMarketFeaturePublicationOracleV1.mjs';

const id = (n) => `sha256:${n.toString(16).padStart(64, '0')}`;
const rows = (count) => Array.from({ length: count }, (_, index) => ({
  sessionDate: `2026-01-${String(index + 1).padStart(2, '0')}`,
  subjectBarIdentityId: id(index + 1),
  ignored: id(100 + index),
}));

for (let count = 0; count < 30; count += 1) {
  test(`C3 independent digest/coverage oracle vector ${count + 1}`, () => {
    const vector = rows(count);
    assert.equal(computeMarketFeatureOrderedRowIdentityDigestV1(vector),
      oracleOrderedRowIdentityDigest(vector));
    assert.deepEqual(deriveMarketFeatureSessionCoverageV1(vector), oracleSessionCoverage(vector));
  });
}

test('C3 independent logical-key oracle ignores non-authoritative display fields', () => {
  const manifest = { instrumentIdentityId: id(1), datasetSnapshotBindingId: id(2),
    publicationAuthorityPolicyId: id(3), featureSetVersion: 'MARKET_FEATURE_SET_L4A_ABC/1',
    ticker: 'DISPLAY_ONLY' };
  assert.deepEqual(oracleLogicalKey(manifest), {
    instrumentIdentityId: id(1), datasetSnapshotBindingId: id(2),
    publicationAuthorityPolicyId: id(3), featureSetVersion: 'MARKET_FEATURE_SET_L4A_ABC/1',
  });
});

function chain() {
  return [
    { publicationManifestId: id(1), supersedesPublicationManifestId: null,
      knowledgeCutoff: '2026-01-01T00:00:00.000Z' },
    { publicationManifestId: id(2), supersedesPublicationManifestId: id(1),
      knowledgeCutoff: '2026-01-02T00:00:00.000Z' },
    { publicationManifestId: id(3), supersedesPublicationManifestId: id(2),
      knowledgeCutoff: '2026-01-03T00:00:00.000Z' },
  ];
}

test('C3 independent tip oracle returns the unique causal tip', () => {
  assert.deepEqual(oracleTips(chain()).map((entry) => entry.publicationManifestId), [id(3)]);
});

test('C3 independent cycle oracle accepts a linear chain', () => {
  assert.equal(oracleHasCycle(chain()), false);
});

test('C3 independent cycle oracle rejects self, two-node and three-node cycles', () => {
  assert.equal(oracleHasCycle([{ publicationManifestId: id(1),
    supersedesPublicationManifestId: id(1) }]), true);
  assert.equal(oracleHasCycle([
    { publicationManifestId: id(1), supersedesPublicationManifestId: id(2) },
    { publicationManifestId: id(2), supersedesPublicationManifestId: id(1) },
  ]), true);
  assert.equal(oracleHasCycle([
    { publicationManifestId: id(1), supersedesPublicationManifestId: id(3) },
    { publicationManifestId: id(2), supersedesPublicationManifestId: id(1) },
    { publicationManifestId: id(3), supersedesPublicationManifestId: id(2) },
  ]), true);
});

for (const [cutoff, expected] of [
  ['2025-12-31T23:59:59.999Z', null],
  ['2026-01-01T00:00:00.000Z', id(1)],
  ['2026-01-01T12:00:00.000Z', id(1)],
  ['2026-01-02T00:00:00.000Z', id(2)],
  ['2026-01-04T00:00:00.000Z', id(3)],
]) test(`C3 independent as-of oracle ${cutoff}`, () => {
  assert.equal(oracleResolveAsOf(chain(), cutoff), expected);
});

test('C3 oracle helper is statically isolated from production publication authority', () => {
  const source = readFileSync(fileURLToPath(new URL(
    './helpers/independentMarketFeaturePublicationOracleV1.mjs', import.meta.url)), 'utf8');
  for (const forbidden of [
    'marketFeaturePublicationV1', 'marketFeaturePublicationRegistryV1',
    'buildMarketFeaturePublicationManifest', 'verifyMarketFeaturePublicationManifest',
    'resolveMarketFeaturePublicationAsOf',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
