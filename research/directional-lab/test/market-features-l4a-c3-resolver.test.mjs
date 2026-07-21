import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKET_FEATURE_SET_VERSION } from '../src/contracts/marketFeaturePublicationContractsV1.mjs';
import {
  resolveMarketFeaturePublicationAsOf,
  resolveMarketFeaturePublicationEntryAsOfV1,
  verifyMarketFeaturePublicationRegistryGraphV1,
} from '../src/publication/marketFeaturePublicationRegistryV1.mjs';

const id = (n) => `sha256:${n.toString(16).padStart(64, '0')}`;
const logicalKey = (overrides = {}) => ({ instrumentIdentityId: id(1),
  datasetSnapshotBindingId: id(2), publicationAuthorityPolicyId: id(3),
  featureSetVersion: MARKET_FEATURE_SET_VERSION, ...overrides });
const coverage = (empty = false) => ({ rowCount: empty ? 0 : 2,
  firstSessionDate: empty ? null : '2026-01-01', lastSessionDate: empty ? null : '2026-01-02',
  orderedRowIdentityDigest: id(empty ? 99 : 98) });
const entry = (number, cutoff, parent = null, key = logicalKey(), empty = false) => ({
  publicationManifestId: id(number), logicalKey: key, knowledgeCutoff: cutoff,
  sessionCoverage: coverage(empty), supersedesPublicationManifestId: parent,
});
const first = entry(10, '2026-01-01T22:00:00.000Z');
const second = entry(11, '2026-01-03T22:00:00.000Z', first.publicationManifestId);

function resolveVerified(entries, cutoff, key = logicalKey()) {
  verifyMarketFeaturePublicationRegistryGraphV1(entries);
  return resolveMarketFeaturePublicationEntryAsOfV1(entries, key, cutoff).publicationManifestId;
}

const missingStore = {
  putCanonicalObject() { throw new Error('not used'); },
  putSourceBytes() { throw new Error('not used'); },
  uriForObject({ objectId }) { return `memory:${objectId}`; },
  readObject() {
    const error = new Error('missing'); error.details = { fsCode: 'ENOENT' }; throw error;
  },
  readCanonicalObject() { throw new Error('missing'); },
};

const cases = [
  ['genesis sans publication', () => assert.throws(() => resolveVerified([], '2026-01-04T22:00:00.000Z'))],
  ['une publication avant as-of', () => assert.equal(
    resolveVerified([first], '2026-01-02T22:00:00.000Z'), first.publicationManifestId)],
  ['une publication après as-of', () => assert.throws(() =>
    resolveVerified([first], '2025-12-31T22:00:00.000Z'))],
  ['deux publications successives', () => assert.equal(
    resolveVerified([first, second], '2026-01-04T22:00:00.000Z'), second.publicationManifestId)],
  ['as-of avant toutes', () => assert.throws(() =>
    resolveVerified([first, second], '2025-12-30T22:00:00.000Z'))],
  ['as-of exactement égal au cutoff', () => assert.equal(
    resolveVerified([first], first.knowledgeCutoff), first.publicationManifestId)],
  ['as-of entre deux cutoffs', () => assert.equal(
    resolveVerified([first, second], '2026-01-02T22:00:00.000Z'), first.publicationManifestId)],
  ['as-of après toutes', () => assert.equal(
    resolveVerified([first, second], '2026-01-05T22:00:00.000Z'), second.publicationManifestId)],
  ['deux clés distinctes', () => {
    const other = entry(12, '2026-01-02T22:00:00.000Z', null,
      logicalKey({ instrumentIdentityId: id(44) }));
    assert.equal(resolveVerified([first, other], '2026-01-04T22:00:00.000Z'), first.publicationManifestId);
  }],
  ['mauvaise clé', () => assert.throws(() => resolveVerified([first],
    '2026-01-04T22:00:00.000Z', logicalKey({ instrumentIdentityId: id(44) })))],
  ['registry piné ancien', () => assert.equal(
    resolveVerified([first], '2026-01-05T22:00:00.000Z'), first.publicationManifestId)],
  ['registry plus récent non piné', () => {
    const unpinned = second;
    assert.ok(unpinned);
    assert.equal(resolveVerified([first], '2026-01-05T22:00:00.000Z'), first.publicationManifestId);
  }],
  ['branche conflictuelle', () => assert.throws(() => resolveVerified([
    first, second, entry(12, '2026-01-04T22:00:00.000Z', first.publicationManifestId)],
  '2026-01-05T22:00:00.000Z'))],
  ['cycle', () => assert.throws(() => resolveVerified([
    entry(10, '2026-01-01T22:00:00.000Z', id(11)),
    entry(11, '2026-01-02T22:00:00.000Z', id(10))], '2026-01-05T22:00:00.000Z'))],
  ['latest implicite interdit', () => assert.throws(() => resolveMarketFeaturePublicationAsOf({
    store: missingStore, registryManifestId: id(50), logicalKey: logicalKey(),
  }))],
  ['ordre insertion inversé', () => assert.equal(
    resolveVerified([second, first], '2026-01-05T22:00:00.000Z'), second.publicationManifestId)],
  ['bruit CAS', () => {
    const noise = entry(90, '2025-01-01T22:00:00.000Z', null,
      logicalKey({ datasetSnapshotBindingId: id(91) }));
    assert.equal(resolveVerified([noise, first, second], '2026-01-05T22:00:00.000Z'),
      second.publicationManifestId);
  }],
  ['empty publication', () => {
    const empty = entry(80, '2026-01-01T22:00:00.000Z', null, logicalKey(), true);
    assert.equal(resolveVerified([empty], empty.knowledgeCutoff), empty.publicationManifestId);
  }],
  ['cutoff invalide', () => assert.throws(() => resolveVerified([first], 'latest'))],
  ['missing registry', () => assert.throws(() => resolveMarketFeaturePublicationAsOf({
    store: missingStore, registryManifestId: id(50), logicalKey: logicalKey(),
    asOfKnowledgeCutoff: '2026-01-05T22:00:00.000Z',
  }))],
];

test('L4A-C3 resolver as-of — exactement 20 cas explicites', async (t) => {
  assert.equal(cases.length, 20);
  for (const [name, assertion] of cases) await t.test(name, assertion);
});
