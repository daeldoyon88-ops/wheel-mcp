import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION } from '../src/contracts/marketFeaturePublicationContractsV1.mjs';
import { TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION } from '../src/data/transformImplementationManifestV2.mjs';
import {
  buildMarketFeaturePublicationAuthorityPolicy,
  buildMarketFeaturePublicationManifest,
  verifyMarketFeaturePublicationManifest,
} from '../src/publication/marketFeaturePublicationV1.mjs';
import {
  buildMarketFeaturePublicationRegistryGenesis,
  publishMarketFeaturePublicationRegistryManifest,
} from '../src/publication/marketFeaturePublicationRegistryV1.mjs';
import { withOfficialL4C3Publication } from './marketFeaturePublicationL4C3Fixture.mjs';

test('L4A-C3 replay — mêmes IDs et implementation identities fermées', () => (
  withOfficialL4C3Publication((context) => {
    const { store } = context;
    const authorityReplay = buildMarketFeaturePublicationAuthorityPolicy({ store });
    assert.equal(authorityReplay.publicationAuthorityPolicyId,
      context.authority.publicationAuthorityPolicyId);
    const replay = buildMarketFeaturePublicationManifest({ store,
      publicationAuthorityPolicyId: authorityReplay.publicationAuthorityPolicyId,
      technicalFeatureComputationReportId: context.technical.technicalFeatureComputationReportId,
      technicalImplementationManifestId: context.technicalImplementationManifestId,
      volumeStructureFeatureComputationReportId: context.volume.volumeStructureFeatureComputationReportId,
      volumeStructureImplementationManifestId: context.volumeStructureImplementationManifestId,
      seasonalityFeatureComputationReportId: context.seasonality.seasonalityFeatureComputationReportId });
    assert.equal(replay.publicationManifestId, context.publication.publicationManifestId);
    const genesisReplay = buildMarketFeaturePublicationRegistryGenesis({ store,
      publicationAuthorityPolicyId: authorityReplay.publicationAuthorityPolicyId });
    assert.equal(genesisReplay.registryManifestId, context.genesis.registryManifestId);
    const registryReplay = publishMarketFeaturePublicationRegistryManifest({ store,
      baseRegistryManifestId: context.registry.registryManifestId,
      publicationManifestId: replay.publicationManifestId,
      expectedParentPublicationManifestId: null });
    assert.equal(registryReplay.noop, true);
    assert.equal(registryReplay.registryManifestId, context.registry.registryManifestId);

    const originalImplementation = store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'snapshots',
        objectId: context.technicalImplementationManifestId }),
      expectedObjectId: context.technicalImplementationManifestId,
      schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
    }).value;
    const wrongImplementation = store.putCanonicalObject({ namespace: 'snapshots',
      schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
      value: { ...originalImplementation,
        runtimeContractVersion: `${originalImplementation.runtimeContractVersion}:WRONG` } });
    const baseInput = {
      store, publicationAuthorityPolicyId: authorityReplay.publicationAuthorityPolicyId,
      technicalFeatureComputationReportId: context.technical.technicalFeatureComputationReportId,
      technicalImplementationManifestId: context.technicalImplementationManifestId,
      volumeStructureFeatureComputationReportId: context.volume.volumeStructureFeatureComputationReportId,
      volumeStructureImplementationManifestId: context.volumeStructureImplementationManifestId,
      seasonalityFeatureComputationReportId: context.seasonality.seasonalityFeatureComputationReportId,
    };
    assert.throws(() => buildMarketFeaturePublicationManifest({ ...baseInput,
      technicalImplementationManifestId: wrongImplementation.objectId }),
    (error) => error?.code === 'MARKET_DATA_FEATURE_PUBLICATION_IMPLEMENTATION_MISMATCH');
    assert.throws(() => buildMarketFeaturePublicationManifest({ ...baseInput,
      volumeStructureImplementationManifestId: wrongImplementation.objectId }),
    (error) => error?.code === 'MARKET_DATA_FEATURE_PUBLICATION_IMPLEMENTATION_MISMATCH');
    assert.throws(() => buildMarketFeaturePublicationManifest({ ...baseInput,
      technicalImplementationManifestId: authorityReplay.publicationAuthorityPolicyId }));

    const corruptedC = structuredClone(replay.publicationManifest);
    corruptedC.families[2].implementationManifestId = wrongImplementation.objectId;
    const corruptedStored = store.putCanonicalObject({ namespace: 'snapshots',
      schemaVersion: MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION, value: corruptedC });
    assert.throws(() => verifyMarketFeaturePublicationManifest({ store,
      publicationManifestId: corruptedStored.objectId }),
    (error) => error?.code === 'MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH');
  })
));
