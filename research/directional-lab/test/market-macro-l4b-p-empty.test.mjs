import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openOfficialMacroL4BF2Live } from './macroFullFeaturesL4BF2SyntheticFixture.mjs';
import {
  L4BP_OFFICIAL_AVAILABLE_AT,
  authorityPinsFromL4BF2Context,
} from './marketMacroFeaturePublicationL4BPFixture.mjs';
import {
  publishOfficialMarketMacroFeaturesL4BPV1,
  resolveMarketMacroFeaturePublicationAsOf,
} from '../src/macro/marketMacroFeaturePublicationL4BPV1.mjs';

let live;
let publication;

before(() => {
  live = openOfficialMacroL4BF2Live({
    emptySessions: true,
    emptyInstrumentRegistry: true,
  });
  publication = publishOfficialMarketMacroFeaturesL4BPV1({
    store: live.store,
    authorityPins: authorityPinsFromL4BF2Context(live),
    availableAt: L4BP_OFFICIAL_AVAILABLE_AT,
    publicationStatus: 'EMPTY',
    withdrawalReason: null,
    baseRegistryManifestId: null,
    supersedesPublicationManifestId: null,
  });
});

after(() => live?.close());

test('empty L4B-P publication has explicit EMPTY status', () => {
  assert.equal(publication.publicationManifest.publicationStatus, 'EMPTY');
  assert.equal(publication.coverageReport.emptyPublication, true);
});

test('empty L4B-P coverage has null bounds and zero row counts', () => {
  assert.equal(publication.coverageReport.sessionCount, 0);
  assert.equal(publication.coverageReport.f1RowCount, 0);
  assert.equal(publication.coverageReport.f2FullRowCount, 0);
  assert.equal(publication.coverageReport.instrumentRowCount, 0);
  assert.equal(publication.coverageReport.firstSessionId, null);
  assert.equal(publication.coverageReport.lastSessionId, null);
});

test('empty L4B-P registry retains all eight explicit families', () => {
  assert.equal(publication.registryManifest.entries.length, 8);
  assert.ok(publication.registryManifest.entries
    .every((entry) => entry.publicationStatus === 'EMPTY'));
});

test('empty L4B-P resolves exactly at availableAt', () => {
  const resolved = resolveMarketMacroFeaturePublicationAsOf({
    store: live.store,
    publicationManifestId: publication.publicationManifestId,
    asOfKnowledgeCutoff: L4BP_OFFICIAL_AVAILABLE_AT,
  });
  assert.equal(resolved.resolutionStatus, 'RESOLVED');
  assert.equal(resolved.publicationManifest.publicationStatus, 'EMPTY');
});
