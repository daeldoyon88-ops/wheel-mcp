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

const WITHDRAWAL_AVAILABLE_AT = '2026-03-18T00:00:00.000Z';
let live;
let pins;
let base;
let withdrawn;

before(() => {
  live = openOfficialMacroL4BF2Live();
  pins = authorityPinsFromL4BF2Context(live);
  base = publishOfficialMarketMacroFeaturesL4BPV1({
    store: live.store,
    authorityPins: pins,
    availableAt: L4BP_OFFICIAL_AVAILABLE_AT,
    publicationStatus: 'PARTIAL',
    withdrawalReason: null,
    baseRegistryManifestId: null,
    supersedesPublicationManifestId: null,
  });
  withdrawn = publishOfficialMarketMacroFeaturesL4BPV1({
    store: live.store,
    authorityPins: pins,
    availableAt: WITHDRAWAL_AVAILABLE_AT,
    publicationStatus: 'WITHDRAWN',
    withdrawalReason: 'SYNTHETIC_TEST_FIXTURE explicit withdrawal',
    baseRegistryManifestId: base.registryManifestId,
    supersedesPublicationManifestId: base.publicationManifestId,
  });
});

after(() => live?.close());

test('withdrawal preserves explicit immediate publication parent', () => {
  assert.equal(withdrawn.publicationManifest.supersedesPublicationManifestId,
    base.publicationManifestId);
  assert.equal(withdrawn.registryManifest.supersedesRegistryManifestId,
    base.registryManifestId);
});

test('every withdrawn family entry supersedes its exact parent identity', () => {
  for (let index = 0; index < withdrawn.registryManifest.entries.length; index += 1) {
    assert.equal(
      withdrawn.registryManifest.entries[index].supersedesEntryIdentityDigest,
      base.registryManifest.entries[index].entryIdentityDigest,
    );
    assert.equal(withdrawn.registryManifest.entries[index].publicationStatus, 'WITHDRAWN');
  }
});

test('withdrawal is a tombstone and preserves the historical base bytes', () => {
  assert.equal(withdrawn.publicationManifest.publicationStatus, 'WITHDRAWN');
  assert.match(withdrawn.publicationManifest.withdrawalReason, /explicit withdrawal/u);
  assert.equal(base.publicationManifest.publicationStatus, 'PARTIAL');
  assert.notEqual(withdrawn.publicationManifestId, base.publicationManifestId);
});

test('prefix invariance: resolving the old explicit tip stays on old publication', () => {
  const resolved = resolveMarketMacroFeaturePublicationAsOf({
    store: live.store,
    publicationManifestId: base.publicationManifestId,
    asOfKnowledgeCutoff: '2026-04-01T00:00:00.000Z',
  });
  assert.equal(resolved.resolutionStatus, 'RESOLVED');
  assert.equal(resolved.publicationManifestId, base.publicationManifestId);
});

test('new tip before withdrawal availableAt resolves its explicit parent', () => {
  const resolved = resolveMarketMacroFeaturePublicationAsOf({
    store: live.store,
    publicationManifestId: withdrawn.publicationManifestId,
    asOfKnowledgeCutoff: L4BP_OFFICIAL_AVAILABLE_AT,
  });
  assert.equal(resolved.resolutionStatus, 'RESOLVED');
  assert.equal(resolved.publicationManifestId, base.publicationManifestId);
});

test('new tip at withdrawal availableAt resolves explicit WITHDRAWN tombstone', () => {
  const resolved = resolveMarketMacroFeaturePublicationAsOf({
    store: live.store,
    publicationManifestId: withdrawn.publicationManifestId,
    asOfKnowledgeCutoff: WITHDRAWAL_AVAILABLE_AT,
  });
  assert.equal(resolved.resolutionStatus, 'WITHDRAWN');
  assert.equal(resolved.publicationManifestId, withdrawn.publicationManifestId);
});
