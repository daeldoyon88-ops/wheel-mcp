/**
 * L4B-I2 MacroDatasetBinding/1: immutably pin the macro authorities required
 * for point-in-time resolution. Jurisdiction, currency and temporalCapability
 * are derived from verified objects — never accepted freely from the caller.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_DATASET_BINDING_POLICY_VERSION,
  MACRO_DATASET_BINDING_SCHEMA_VERSION,
  assertMacroMaterializationUtcInstant,
  normalizeMacroDatasetBindingV1,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroAsOfResolutionPolicy } from './macroAsOfResolutionPolicyL4BV1.mjs';
import { verifyMacroDatasetSnapshotManifest } from './macroDatasetSnapshotL4BV1.mjs';
import { verifyMacroObservationVintageCore } from './macroObservationVintageL4BV1.mjs';
import { verifyMacroReleaseCalendarRegistryManifest } from './macroReleaseCalendarRegistryL4BV1.mjs';

/**
 * Derive temporal capability from verified vintage contents on the pinned
 * vintage set. Forbidden completeness classes fail closed.
 */
export function deriveMacroBindingTemporalCapabilityV1(store, vintageSet) {
  if (vintageSet.observationCount === 0) return 'POINT_IN_TIME_VINTAGE_COMPLETE';
  let hasPartial = false;
  for (const observation of vintageSet.orderedObservationEntries) {
    for (const vintageEntry of observation.orderedVintages) {
      const { observationVintage } = verifyMacroObservationVintageCore({
        store, observationVintageId: vintageEntry.observationVintageId,
      });
      const completeness = observationVintage.vintageCompletenessClass;
      if (completeness === 'VINTAGE_PARTIAL') hasPartial = true;
      if (completeness === 'FINAL_ONLY'
          || completeness === 'RELEASE_TIME_UNKNOWN'
          || completeness === 'UNUSABLE_FOR_POINT_IN_TIME') {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_TEMPORAL_CAPABILITY_MISMATCH',
          'binding refuses non point-in-time completeness classes');
      }
    }
  }
  return hasPartial ? 'POINT_IN_TIME_VINTAGE_PARTIAL' : 'POINT_IN_TIME_VINTAGE_COMPLETE';
}

function expectedBindingValue(references, derived) {
  return normalizeMacroDatasetBindingV1({
    schemaVersion: MACRO_DATASET_BINDING_SCHEMA_VERSION,
    macroDatasetSnapshotManifestId: references.macroDatasetSnapshotManifestId,
    macroVintageSetManifestId: references.macroVintageSetManifestId,
    macroSeriesRegistryManifestId: references.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: references.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: references.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: references.macroReleaseCalendarRegistryManifestId,
    jurisdictionCode: derived.jurisdictionCode,
    currencyCode: derived.currencyCode,
    knowledgeCutoff: references.knowledgeCutoff,
    temporalCapability: derived.temporalCapability,
    bindingPolicyVersion: MACRO_DATASET_BINDING_POLICY_VERSION,
  });
}

function assertDerivedOnlyInput(api) {
  for (const field of [
    'jurisdictionCode', 'currencyCode', 'temporalCapability',
    'macroVintageSetManifestId', 'macroSeriesRegistryManifestId', 'macroIngestionPolicyId',
  ]) {
    if (Object.hasOwn(api, field)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_INVALID',
        `binding builder derives ${field}; free caller values are refused`);
    }
  }
}

/**
 * Build a binding from explicitly pinned authorities. jurisdiction, currency
 * and temporalCapability are derived; caller-supplied values are refused.
 */
export function buildMacroDatasetBinding(input) {
  const api = assertApiInput(input, [
    'macroDatasetSnapshotManifestId', 'macroAsOfResolutionPolicyId',
    'macroReleaseCalendarRegistryManifestId', 'knowledgeCutoff',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  for (const field of [
    'macroDatasetSnapshotManifestId', 'macroAsOfResolutionPolicyId',
    'macroReleaseCalendarRegistryManifestId',
  ]) {
    assertExplicitPinnedMacroId(api[field], field);
    assertCasId(api[field], field);
  }
  assertMacroMaterializationUtcInstant(api.knowledgeCutoff, 'knowledgeCutoff');
  assertDerivedOnlyInput(api);

  const snapshotVerified = verifyMacroDatasetSnapshotManifest({
    store: api.store, macroDatasetSnapshotManifestId: api.macroDatasetSnapshotManifestId,
  });
  const asOfVerified = verifyMacroAsOfResolutionPolicy({
    store: api.store, macroAsOfResolutionPolicyId: api.macroAsOfResolutionPolicyId,
  });
  if (asOfVerified.macroAsOfResolutionPolicy.latestReferencePolicy !== 'FORBIDDEN') {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_LATEST_FORBIDDEN',
      'binding refuses a latest-capable as-of policy');
  }
  const calendarVerified = verifyMacroReleaseCalendarRegistryManifest({
    store: api.store,
    macroReleaseCalendarRegistryManifestId: api.macroReleaseCalendarRegistryManifestId,
  });

  const snapshot = snapshotVerified.datasetSnapshot;
  const policy = snapshotVerified.macroIngestionPolicy;
  const vintageSet = snapshotVerified.vintageSet;

  if (calendarVerified.registry.macroSeriesRegistryManifestId
      !== snapshot.macroSeriesRegistryManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_MISMATCH',
      'calendar registry is pinned to a different series registry');
  }
  if (calendarVerified.registry.jurisdictionCode !== policy.jurisdictionCode
      || calendarVerified.registry.currencyCode !== policy.currencyCode) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_MISMATCH',
      'calendar registry jurisdiction or currency diverges from ingestion policy');
  }
  if (snapshot.jurisdictionCode !== policy.jurisdictionCode
      || snapshot.currencyCode !== policy.currencyCode) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_MISMATCH',
      'snapshot jurisdiction or currency diverges from ingestion policy');
  }

  const temporalCapability = deriveMacroBindingTemporalCapabilityV1(api.store, vintageSet);
  const binding = expectedBindingValue({
    macroDatasetSnapshotManifestId: api.macroDatasetSnapshotManifestId,
    macroVintageSetManifestId: snapshot.macroVintageSetManifestId,
    macroSeriesRegistryManifestId: snapshot.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: snapshot.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: api.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: api.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff: api.knowledgeCutoff,
  }, {
    jurisdictionCode: policy.jurisdictionCode,
    currencyCode: policy.currencyCode,
    temporalCapability,
  });

  const stored = putCanonicalL3(api.store, MACRO_DATASET_BINDING_SCHEMA_VERSION, binding);
  verifyMacroDatasetBinding({
    store: api.store, macroDatasetBindingId: stored.objectId,
  });
  return { macroDatasetBindingId: stored.objectId, binding: stored.value };
}

export function verifyMacroDatasetBinding(input) {
  const api = assertApiInput(input, ['macroDatasetBindingId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroDatasetBindingId, 'macroDatasetBindingId');
  assertCasId(api.macroDatasetBindingId, 'macroDatasetBindingId');
  const raw = readTypedReference(api.store, api.macroDatasetBindingId,
    MACRO_DATASET_BINDING_SCHEMA_VERSION, 'macro dataset binding');
  const binding = normalizeMacroDatasetBindingV1(raw);

  const snapshotVerified = verifyMacroDatasetSnapshotManifest({
    store: api.store, macroDatasetSnapshotManifestId: binding.macroDatasetSnapshotManifestId,
  });
  verifyMacroAsOfResolutionPolicy({
    store: api.store, macroAsOfResolutionPolicyId: binding.macroAsOfResolutionPolicyId,
  });
  const calendarVerified = verifyMacroReleaseCalendarRegistryManifest({
    store: api.store,
    macroReleaseCalendarRegistryManifestId: binding.macroReleaseCalendarRegistryManifestId,
  });

  const snapshot = snapshotVerified.datasetSnapshot;
  const policy = snapshotVerified.macroIngestionPolicy;
  if (binding.macroVintageSetManifestId !== snapshot.macroVintageSetManifestId
      || binding.macroSeriesRegistryManifestId !== snapshot.macroSeriesRegistryManifestId
      || binding.macroIngestionPolicyId !== snapshot.macroIngestionPolicyId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_MISMATCH',
      'binding references diverge from the pinned snapshot composition');
  }
  if (calendarVerified.registry.macroSeriesRegistryManifestId
      !== binding.macroSeriesRegistryManifestId
      || calendarVerified.registry.jurisdictionCode !== binding.jurisdictionCode
      || calendarVerified.registry.currencyCode !== binding.currencyCode) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_MISMATCH',
      'binding calendar registry authority diverges');
  }
  if (binding.jurisdictionCode !== policy.jurisdictionCode
      || binding.currencyCode !== policy.currencyCode) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_MISMATCH',
      'binding jurisdiction or currency diverges from ingestion policy');
  }

  const expectedCapability = deriveMacroBindingTemporalCapabilityV1(
    api.store, snapshotVerified.vintageSet,
  );
  if (binding.temporalCapability !== expectedCapability) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_TEMPORAL_CAPABILITY_MISMATCH',
      'binding temporalCapability diverges from the recomputed capability');
  }

  const expected = expectedBindingValue(binding, {
    jurisdictionCode: policy.jurisdictionCode,
    currencyCode: policy.currencyCode,
    temporalCapability: expectedCapability,
  });
  if (!canonicalValuesEqual(binding, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_BINDING_INVALID',
      'binding diverges from its recomputed canonical value');
  }
  return {
    macroDatasetBindingId: api.macroDatasetBindingId,
    binding,
    datasetSnapshot: snapshot,
    macroIngestionPolicy: policy,
    vintageSet: snapshotVerified.vintageSet,
    seriesRegistry: snapshotVerified.seriesRegistry,
    calendarRegistry: calendarVerified.registry,
  };
}
