/** Synthetic offline L4B-P fixture built only from the official L4B-F2 closure. */

import {
  buildOfficialMacroL4BF2Context,
  withMacroStore,
} from './macroFullFeaturesL4BF2SyntheticFixture.mjs';
import {
  publishOfficialMarketMacroFeaturesL4BPV1,
} from '../src/macro/marketMacroFeaturePublicationL4BPV1.mjs';

export const L4BP_OFFICIAL_AVAILABLE_AT = '2026-03-17T00:00:00.000Z';

export function authorityPinsFromL4BF2Context(context) {
  const binding = context.binding.binding;
  return {
    macroIngestionPolicyId: binding.macroIngestionPolicyId,
    macroSeriesRegistryManifestId: binding.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: binding.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: binding.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: binding.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: binding.macroReleaseCalendarRegistryManifestId,
    macroDatasetBindingId: context.binding.macroDatasetBindingId,
    macroMaterializationReportId: context.materialization.macroMaterializationReportId,
    marketMacroFeatureComputationPolicyId: context.featurePolicy.featureComputationPolicyId,
    marketMacroFeatureSourceBundleId: context.sourceBundle.sourceBundleId,
    macroStateBySessionRowsId: context.f1Rows.macroStateBySessionRowsId,
    marketMacroFeatureComputationReportId: context.f1Report.macroFeatureComputationReportId,
    marketMacroInstrumentProjectionPolicyId: context.projectionPolicy.instrumentProjectionPolicyId,
    marketMacroFullStateRowsId: context.fullRows.fullStateRowsId,
    marketMacroInstrumentRowsId: context.instrumentRows.instrumentRowsId,
    marketMacroFullComputationReportId: context.fullReport.fullComputationReportId,
    marketSessionRegistryManifestId: context.calendarRegistry.calendarRegistryManifestId,
    instrumentIdentityRegistryManifestId: context.instrumentRegistry.registryManifestId,
  };
}

export function buildOfficialMarketMacroL4BPContext(store, options = {}) {
  const macro = buildOfficialMacroL4BF2Context(store, options);
  const authorityPins = authorityPinsFromL4BF2Context(macro);
  const publicationStatus = options.emptySessions === true ? 'EMPTY' : 'PARTIAL';
  const publication = publishOfficialMarketMacroFeaturesL4BPV1({
    store,
    authorityPins,
    availableAt: options.availableAt ?? L4BP_OFFICIAL_AVAILABLE_AT,
    publicationStatus,
    withdrawalReason: null,
    baseRegistryManifestId: null,
    supersedesPublicationManifestId: null,
  });
  return { ...macro, authorityPins, publication };
}

export function withOfficialMarketMacroL4BPFixture(callback, options = {}) {
  return withMacroStore((store) =>
    callback(buildOfficialMarketMacroL4BPContext(store, options)));
}
