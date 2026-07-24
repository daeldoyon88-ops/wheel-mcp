import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  MARKET_MACRO_FAMILY_CODES,
} from '../src/contracts/marketMacroFeaturePublicationContractsL4BPV1.mjs';
import {
  publishOfficialMarketMacroFeaturesL4BPV1,
  resolveMarketMacroFeaturePublicationAsOf,
} from '../src/macro/marketMacroFeaturePublicationL4BPV1.mjs';
import { openOfficialMacroL4BF2Live } from './macroFullFeaturesL4BF2SyntheticFixture.mjs';
import {
  L4BP_OFFICIAL_AVAILABLE_AT,
  authorityPinsFromL4BF2Context,
} from './marketMacroFeaturePublicationL4BPFixture.mjs';

const GOLDEN_L4BP = Object.freeze({
  authorityPolicyId: 'sha256:1f842480d6b3f4ec62e4e56a8e5404bd285b68b816d9bfe8c3ac553da24b7e76',
  registryManifestId: 'sha256:d05fb7e56faff763952fdfd05992288441397ab87f790ffe39a97d390d006f35',
  coverageReportId: 'sha256:0499d76e518d8007e76ee01feb924028c7063dd2c3e31c64048bffd4a7bd2c30',
  publicationManifestId: 'sha256:703c1006dc80144d9ba102aa57a04541e9a1377a731417912cd9e44f6782b33c',
});

let live;
let authorityPins;
let publication;

before(() => {
  live = openOfficialMacroL4BF2Live();
  authorityPins = authorityPinsFromL4BF2Context(live);
  publication = publishOfficialMarketMacroFeaturesL4BPV1({
    store: live.store,
    authorityPins,
    availableAt: L4BP_OFFICIAL_AVAILABLE_AT,
    publicationStatus: 'PARTIAL',
    withdrawalReason: null,
    baseRegistryManifestId: null,
    supersedesPublicationManifestId: null,
  });
});

after(() => live?.close());

test('official L4B-P IDs reproduce the pinned golden quartet', () => {
  assert.deepEqual({
    authorityPolicyId: publication.authorityPolicyId,
    registryManifestId: publication.registryManifestId,
    coverageReportId: publication.coverageReportId,
    publicationManifestId: publication.publicationManifestId,
  }, GOLDEN_L4BP);
});

test('official publication pins exactly eighteen authorities', () => {
  assert.equal(Object.keys(publication.publicationManifest.authorityPins).length, 18);
  assert.deepEqual(publication.publicationManifest.authorityPins, authorityPins);
});

test('official registry publishes the closed eight-family order', () => {
  assert.deepEqual(publication.registryManifest.entries.map((entry) => entry.familyCode),
    MARKET_MACRO_FAMILY_CODES);
});

test('official publication pins four implementation identities in phase order', () => {
  assert.deepEqual(publication.implementationIdentities.map((entry) => entry.phaseCode),
    ['I1', 'I2', 'F1', 'F2']);
  assert.equal(new Set(publication.implementationIdentities
    .map((entry) => entry.implementationManifestId)).size, 4);
});

test('official coverage counts nine sessions, four instruments and 28 projections', () => {
  assert.equal(publication.coverageReport.sessionCount, 9);
  assert.equal(publication.coverageReport.f1RowCount, 9);
  assert.equal(publication.coverageReport.f2FullRowCount, 9);
  assert.equal(publication.coverageReport.instrumentCount, 4);
  assert.equal(publication.coverageReport.instrumentRowCount, 28);
});

test('official status is explicitly PARTIAL, not forged PUBLISHED', () => {
  assert.equal(publication.publicationManifest.publicationStatus, 'PARTIAL');
  assert.equal(publication.coverageReport.emptyPublication, false);
  assert.ok(publication.coverageReport.familyCoverage
    .some((entry) => entry.coverageStatus !== 'COMPLETE'));
});

test('official publication contains no score/rank/recommendation surface', () => {
  const text = JSON.stringify(publication.publicationManifest);
  assert.equal(/score|rank|recommendation|signal|strike|premium/iu.test(text), false);
});

test('official coverage exposes only derived sha256 digests', () => {
  for (const field of ['orderedSessionDigest', 'orderedRowDigest',
    'orderedInstrumentRowDigest', 'orderedProvenanceDigest',
    'orderedPublicationEntryDigest']) {
    assert.match(publication.coverageReport[field], /^sha256:[0-9a-f]{64}$/u);
  }
});

test('resolver is NOT_AVAILABLE one millisecond before genesis publication', () => {
  const resolved = resolveMarketMacroFeaturePublicationAsOf({
    store: live.store,
    publicationManifestId: publication.publicationManifestId,
    asOfKnowledgeCutoff: '2026-03-16T23:59:59.999Z',
  });
  assert.equal(resolved.resolutionStatus, 'NOT_AVAILABLE');
  assert.equal(resolved.publicationManifestId, null);
});

test('resolver includes publication exactly at availableAt', () => {
  const resolved = resolveMarketMacroFeaturePublicationAsOf({
    store: live.store,
    publicationManifestId: publication.publicationManifestId,
    asOfKnowledgeCutoff: L4BP_OFFICIAL_AVAILABLE_AT,
  });
  assert.equal(resolved.resolutionStatus, 'RESOLVED');
  assert.equal(resolved.publicationManifestId, publication.publicationManifestId);
});

test('unreferenced CAS noise cannot change the pinned publication', () => {
  live.store.putSourceBytes(Buffer.from('L4B-P unrelated noise', 'utf8'));
  const resolved = resolveMarketMacroFeaturePublicationAsOf({
    store: live.store,
    publicationManifestId: publication.publicationManifestId,
    asOfKnowledgeCutoff: L4BP_OFFICIAL_AVAILABLE_AT,
  });
  assert.equal(resolved.publicationManifestId, publication.publicationManifestId);
});

test('official publication replay is byte- and identity-identical', () => {
  const replay = publishOfficialMarketMacroFeaturesL4BPV1({
    store: live.store,
    authorityPins,
    availableAt: L4BP_OFFICIAL_AVAILABLE_AT,
    publicationStatus: 'PARTIAL',
    withdrawalReason: null,
    baseRegistryManifestId: null,
    supersedesPublicationManifestId: null,
  });
  assert.deepEqual({
    authorityPolicyId: replay.authorityPolicyId,
    registryManifestId: replay.registryManifestId,
    coverageReportId: replay.coverageReportId,
    publicationManifestId: replay.publicationManifestId,
  }, GOLDEN_L4BP);
});
