import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openOfficialMacroL4BF2Live } from './macroFullFeaturesL4BF2SyntheticFixture.mjs';
import {
  L4BP_OFFICIAL_AVAILABLE_AT,
  authorityPinsFromL4BF2Context,
} from './marketMacroFeaturePublicationL4BPFixture.mjs';
import {
  publishOfficialMarketMacroFeaturesL4BPV1,
} from '../src/macro/marketMacroFeaturePublicationL4BPV1.mjs';

let left;
let right;
let leftPublication;
let rightPublication;

function publish(context) {
  return publishOfficialMarketMacroFeaturesL4BPV1({
    store: context.store,
    authorityPins: authorityPinsFromL4BF2Context(context),
    availableAt: L4BP_OFFICIAL_AVAILABLE_AT,
    publicationStatus: 'PARTIAL',
    withdrawalReason: null,
    baseRegistryManifestId: null,
    supersedesPublicationManifestId: null,
  });
}

before(() => {
  left = openOfficialMacroL4BF2Live();
  right = openOfficialMacroL4BF2Live({ reverseInsertion: true, addCasNoise: true });
  leftPublication = publish(left);
  rightPublication = publish(right);
});

after(() => {
  left?.close();
  right?.close();
});

test('multi-store publication quartet is identity-identical', () => {
  for (const field of ['authorityPolicyId', 'registryManifestId',
    'coverageReportId', 'publicationManifestId']) {
    assert.equal(leftPublication[field], rightPublication[field], field);
  }
});

test('multi-store implementation identities are identical', () => {
  assert.deepEqual(leftPublication.implementationIdentities,
    rightPublication.implementationIdentities);
});

test('reverse insertion and CAS noise preserve registry bytes', () => {
  assert.deepEqual(leftPublication.registryManifest, rightPublication.registryManifest);
});

test('reverse insertion and CAS noise preserve coverage bytes', () => {
  assert.deepEqual(leftPublication.coverageReport, rightPublication.coverageReport);
});

test('reverse insertion and CAS noise preserve publication bytes', () => {
  assert.deepEqual(leftPublication.publicationManifest, rightPublication.publicationManifest);
});
