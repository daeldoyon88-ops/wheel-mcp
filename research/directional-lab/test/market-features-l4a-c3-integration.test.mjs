import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS } from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  MARKET_FEATURE_PUBLICATION_FAMILY_CODES,
  MARKET_FEATURE_PUBLICATION_L4_SCHEMA_VERSIONS,
} from '../src/contracts/marketFeaturePublicationContractsV1.mjs';
import {
  computeMarketFeatureOrderedRowIdentityDigestV1,
  marketFeaturePublicationLogicalKeyFor,
} from '../src/publication/marketFeaturePublicationV1.mjs';
import {
  resolveMarketFeaturePublicationAsOf,
} from '../src/publication/marketFeaturePublicationRegistryV1.mjs';
import { withOfficialL4C3Publication } from './marketFeaturePublicationL4C3Fixture.mjs';

test('L4A-C3 official A/B/C reference publication, registry and as-of resolution', () => (
  withOfficialL4C3Publication((context) => {
    const { store, publication, registry, genesis } = context;
    assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 105);
    assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 105);
    assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-19, -16),
      [...MARKET_FEATURE_PUBLICATION_L4_SCHEMA_VERSIONS]);
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
    assert.equal(new Set(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS).size, 5);

    // Both builders already execute their full verifier gates before returning.
    const manifest = publication.publicationManifest;
    assert.deepEqual(manifest.families.map((family) => family.familyCode),
      [...MARKET_FEATURE_PUBLICATION_FAMILY_CODES]);
    assert.equal(manifest.families.length, 3);
    assert.equal(Object.hasOwn(manifest, 'rows'), false);
    assert.equal(manifest.families.every((family) => !Object.hasOwn(family, 'rows')), true);
    assert.equal(new Set(manifest.families.map((family) => family.reportId)).size, 3);
    assert.equal(new Set(manifest.families.map((family) => family.rowsId)).size, 3);
    assert.equal(new Set(manifest.families.map((family) => family.instrumentIdentityId)).size, 1);
    assert.equal(new Set(manifest.families.map((family) => family.datasetSnapshotBindingId)).size, 1);
    assert.equal(new Set(manifest.families.map((family) => family.datasetSnapshotManifestId)).size, 1);
    assert.equal(new Set(manifest.families.map((family) => family.normalizedMarketDataObjectId)).size, 1);
    assert.equal(new Set(manifest.families.map((family) => family.knowledgeCutoff)).size, 1);
    assert.equal(new Set(manifest.families.map((family) => family.priceBasis)).size, 1);
    assert.equal(new Set(manifest.families.map((family) => family.corporateActionTreatment)).size, 1);
    assert.equal(new Set(manifest.families.map((family) => family.orderedRowIdentityDigest)).size, 1);
    assert.equal(manifest.sessionCoverage.orderedRowIdentityDigest,
      computeMarketFeatureOrderedRowIdentityDigestV1(
        context.seasonality
          ? context.store.readCanonicalObject({
            uri: context.store.uriForObject({ namespace: 'normalized',
              objectId: context.seasonality.seasonalityFeatureRowsId }),
            expectedObjectId: context.seasonality.seasonalityFeatureRowsId,
            schemaVersion: 'MarketSeasonalityFeatureRows/1',
          }).value.rows : [],
      ));

    assert.equal(registry.registryManifest.entries.length, 1);
    assert.equal(registry.registryManifest.entries[0].publicationManifestId,
      publication.publicationManifestId);
    assert.equal(registry.registryManifest.supersedesRegistryManifestId, genesis.registryManifestId);

    const logicalKey = marketFeaturePublicationLogicalKeyFor(manifest);
    const resolved = resolveMarketFeaturePublicationAsOf({
      store, registryManifestId: registry.registryManifestId, logicalKey,
      asOfKnowledgeCutoff: manifest.knowledgeCutoff,
    });
    assert.equal(resolved.publicationManifestId, publication.publicationManifestId);
    assert.throws(() => resolveMarketFeaturePublicationAsOf({
      store, registryManifestId: genesis.registryManifestId, logicalKey,
      asOfKnowledgeCutoff: manifest.knowledgeCutoff,
    }), (error) => error?.code === 'MARKET_DATA_FEATURE_PUBLICATION_AS_OF_NOT_FOUND');
    return {
      publicationManifestId: publication.publicationManifestId,
      registryManifestId: registry.registryManifestId,
    };
  })
));
