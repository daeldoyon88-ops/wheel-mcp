import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketFeaturePublicationLogicalKeyFor } from '../src/publication/marketFeaturePublicationV1.mjs';
import { resolveMarketFeaturePublicationAsOf,
  verifyMarketFeaturePublicationRegistryManifest } from '../src/publication/marketFeaturePublicationRegistryV1.mjs';
import { withOfficialL4C3Publication } from './marketFeaturePublicationL4C3Fixture.mjs';

function bytesFor(store, objectId) {
  return store.readObject({ uri: store.uriForObject({ namespace: 'snapshots', objectId }),
    expectedObjectId: objectId }).bytes;
}

test('L4A-C3 multi-store — bytes, IDs, tips et as-of identiques', () => (
  withOfficialL4C3Publication((left) => (
    withOfficialL4C3Publication((right) => {
      left.store.putSourceBytes(Buffer.from('left-cas-noise'));
      right.store.putSourceBytes(Buffer.from('right-cas-noise'));
      assert.equal(left.authority.publicationAuthorityPolicyId,
        right.authority.publicationAuthorityPolicyId);
      assert.equal(left.publication.publicationManifestId,
        right.publication.publicationManifestId);
      assert.equal(left.genesis.registryManifestId, right.genesis.registryManifestId);
      assert.equal(left.registry.registryManifestId, right.registry.registryManifestId);
      assert.deepEqual(bytesFor(left.store, left.publication.publicationManifestId),
        bytesFor(right.store, right.publication.publicationManifestId));
      assert.deepEqual(bytesFor(left.store, left.registry.registryManifestId),
        bytesFor(right.store, right.registry.registryManifestId));
      const leftVerified = verifyMarketFeaturePublicationRegistryManifest({ store: left.store,
        registryManifestId: left.registry.registryManifestId });
      const rightVerified = verifyMarketFeaturePublicationRegistryManifest({ store: right.store,
        registryManifestId: right.registry.registryManifestId });
      assert.deepEqual(leftVerified.tips, rightVerified.tips);
      const logicalKey = marketFeaturePublicationLogicalKeyFor(left.publication.publicationManifest);
      const leftResolved = resolveMarketFeaturePublicationAsOf({ store: left.store,
        registryManifestId: left.registry.registryManifestId, logicalKey,
        asOfKnowledgeCutoff: left.publication.publicationManifest.knowledgeCutoff });
      const rightResolved = resolveMarketFeaturePublicationAsOf({ store: right.store,
        registryManifestId: right.registry.registryManifestId, logicalKey,
        asOfKnowledgeCutoff: right.publication.publicationManifest.knowledgeCutoff });
      assert.equal(leftResolved.publicationManifestId, rightResolved.publicationManifestId);
      assert.deepEqual(leftVerified.registry.entries, rightVerified.registry.entries);
      return { publicationManifestId: leftResolved.publicationManifestId };
    })
  ))
));
