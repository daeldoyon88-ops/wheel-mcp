import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMarketFeatureOrderedRowIdentityDigestV1,
  marketFeaturePublicationLogicalKeyFor } from '../src/publication/marketFeaturePublicationV1.mjs';
import { resolveMarketFeaturePublicationAsOf } from '../src/publication/marketFeaturePublicationRegistryV1.mjs';
import { withOfficialL4C3Publication } from './marketFeaturePublicationL4C3Fixture.mjs';

test('L4A-C3 empty — trois familles vides, alignées, publiées et résolues', () => (
  withOfficialL4C3Publication((context) => {
    const manifest = context.publication.publicationManifest;
    const emptyDigest = computeMarketFeatureOrderedRowIdentityDigestV1([]);
    assert.deepEqual(manifest.sessionCoverage, { rowCount: 0, firstSessionDate: null,
      lastSessionDate: null, orderedRowIdentityDigest: emptyDigest });
    assert.equal(manifest.families.length, 3);
    for (const family of manifest.families) {
      assert.equal(family.rowCount, 0);
      assert.equal(family.firstSessionDate, null);
      assert.equal(family.lastSessionDate, null);
      assert.equal(family.orderedRowIdentityDigest, emptyDigest);
    }
    const resolved = resolveMarketFeaturePublicationAsOf({ store: context.store,
      registryManifestId: context.registry.registryManifestId,
      logicalKey: marketFeaturePublicationLogicalKeyFor(manifest),
      asOfKnowledgeCutoff: manifest.knowledgeCutoff });
    assert.equal(resolved.publicationManifestId, context.publication.publicationManifestId);
  }, { sessions: [] })
));
