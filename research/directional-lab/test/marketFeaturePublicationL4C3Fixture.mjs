import {
  MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
  MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
} from '../src/contracts/marketFeaturePublicationContractsV1.mjs';
import {
  buildMarketVolumeStructureFeatureComputationPolicy,
  buildMarketVolumeStructureFeatureSourceBundle,
  computeMarketVolumeStructureFeatures,
} from '../src/features/computeMarketVolumeStructureFeaturesL4V1.mjs';
import {
  buildMarketSeasonalityFeatureComputationPolicy,
  buildMarketSeasonalityFeatureSourceBundle,
  computeMarketSeasonalityFeatures,
} from '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs';
import {
  buildMarketFeaturePublicationAuthorityPolicy,
  buildMarketFeatureFamilyImplementationManifestV1,
  buildMarketFeaturePublicationManifest,
} from '../src/publication/marketFeaturePublicationV1.mjs';
import {
  buildMarketFeaturePublicationRegistryGenesis,
  publishMarketFeaturePublicationRegistryManifest,
} from '../src/publication/marketFeaturePublicationRegistryV1.mjs';
import {
  defaultFixtureSessions,
  withOfficialL4AReport,
} from './marketVolumeStructureL4SyntheticFixture.mjs';

/** Build one fully verifiable A/B/C publication over one official I6 binding. */
export function withOfficialL4C3Publication(callback, options = {}) {
  const sessions = options.sessions ?? defaultFixtureSessions(options.rowCount ?? 2);
  return withOfficialL4AReport(sessions, (context) => {
    const { store } = context;
    const technicalImplementationManifestId = buildMarketFeatureFamilyImplementationManifestV1({
      store, familyCode: MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
    }).implementationManifestId;
    const volumeStructureImplementationManifestId = buildMarketFeatureFamilyImplementationManifestV1({
      store, familyCode: MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
    }).implementationManifestId;
    const seasonalityImplementationManifestId = buildMarketFeatureFamilyImplementationManifestV1({
      store, familyCode: MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
    }).implementationManifestId;

    const volumePolicy = buildMarketVolumeStructureFeatureComputationPolicy({ store });
    const volumeSource = buildMarketVolumeStructureFeatureSourceBundle({
      store, technicalFeatureComputationReportId: context.technical.technicalFeatureComputationReportId,
    });
    const volume = computeMarketVolumeStructureFeatures({
      store,
      volumeStructureFeatureSourceBundleId: volumeSource.volumeStructureFeatureSourceBundleId,
      volumeStructureFeatureComputationPolicyId: volumePolicy.volumeStructureFeatureComputationPolicyId,
    });

    const seasonalitySource = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: context.published.bindingRegistryManifestId,
      subjectBindingId: context.published.bindingId,
      implementationManifestId: seasonalityImplementationManifestId,
    });
    const seasonalityPolicy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    const seasonality = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: seasonalitySource.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: seasonalityPolicy.seasonalityFeatureComputationPolicyId,
    });

    const authority = buildMarketFeaturePublicationAuthorityPolicy({ store });
    const publication = buildMarketFeaturePublicationManifest({
      store,
      publicationAuthorityPolicyId: authority.publicationAuthorityPolicyId,
      technicalFeatureComputationReportId: context.technical.technicalFeatureComputationReportId,
      technicalImplementationManifestId,
      volumeStructureFeatureComputationReportId: volume.volumeStructureFeatureComputationReportId,
      volumeStructureImplementationManifestId,
      seasonalityFeatureComputationReportId: seasonality.seasonalityFeatureComputationReportId,
    });
    const genesis = buildMarketFeaturePublicationRegistryGenesis({
      store, publicationAuthorityPolicyId: authority.publicationAuthorityPolicyId,
    });
    const registry = publishMarketFeaturePublicationRegistryManifest({
      store, baseRegistryManifestId: genesis.registryManifestId,
      publicationManifestId: publication.publicationManifestId,
      expectedParentPublicationManifestId: null,
    });
    return callback({ ...context, technicalImplementationManifestId,
      volumeStructureImplementationManifestId, seasonalityImplementationManifestId,
      volumePolicy, volumeSource, volume, seasonalitySource, seasonalityPolicy, seasonality,
      authority, publication, genesis, registry });
  }, options);
}
