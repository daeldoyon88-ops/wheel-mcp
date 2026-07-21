/** L4A-C1 orchestration only: bundle, closed policy, runtime and normalized rows. */

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
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
  tipForBindingPublicationKey,
  verifyMarketDataDatasetSnapshotBinding,
  verifyMarketDataDatasetSnapshotBindingRegistry,
} from '../contracts/marketDataDatasetSnapshotBindingL3V1.mjs';
import { MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION } from '../contracts/marketDataSourceL3V1.mjs';
import { INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION } from '../contracts/instrumentIdentityV1.mjs';
import {
  MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
} from '../contracts/marketDataSnapshotMaterializationL3V1.mjs';
import { verifyMarketCalendarRegistry } from '../contracts/marketCalendarL3V1.mjs';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_POLICY_VALUES,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketSeasonalityFeatureComputationPolicyV1,
  normalizeMarketSeasonalityFeatureRowsV1,
  normalizeMarketSeasonalityFeatureSourceBundleV1,
} from '../contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import { TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION } from '../data/transformImplementationManifestV2.mjs';
import { verifyDatasetSnapshot } from '../data/buildDatasetSnapshot.mjs';
import { verifySnapshotDatasetManifest } from '../data/buildSnapshotDatasetManifest.mjs';
import { deriveMarketSeasonalityRuntimePolicyV1 } from './marketSeasonalityRuntimePolicyL4V1.mjs';
import {
  deriveMarketSeasonalityFeatureRowsDocumentV1,
  validateSeasonalityPriceBasisClosureV1,
} from './marketSeasonalityOccurrenceEngineL4V1.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

function readSeasonalityRows(store, rowsId) {
  assertCasId(rowsId, 'seasonalityFeatureRowsId');
  try {
    return store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'normalized', objectId: rowsId }),
      expectedObjectId: rowsId,
      schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    }).value;
  } catch (cause) {
    throw new MarketDataL3Error(
      'MARKET_DATA_REFERENCE_CORRUPT', 'seasonality feature rows are missing or corrupt', { cause },
    );
  }
}

function mergeCalendarSessions(calendars) {
  const byDate = new Map();
  for (const calendar of calendars) {
    for (const session of calendar.sessions) {
      const existing = byDate.get(session.sessionDate);
      if (existing !== undefined && (existing.sessionKind !== session.sessionKind
          || existing.openUtc !== session.openUtc || existing.closeUtc !== session.closeUtc)) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SEASONALITY_CALENDAR_ALIGNMENT_UNAVAILABLE',
          'pinned calendar cores disagree on an overlapping session',
        );
      }
      byDate.set(session.sessionDate, session);
    }
  }
  return [...byDate.values()].sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
}

function verifyOfficialBindingPin(store, registryManifestId, bindingId) {
  const { bindingRegistryManifest } = verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: registryManifestId,
  });
  const { binding } = verifyMarketDataDatasetSnapshotBinding({ store, bindingId });
  if (!bindingRegistryManifest.bindingIds.includes(bindingId)
      || tipForBindingPublicationKey(bindingRegistryManifest, binding.bindingPublicationKey) !== bindingId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
      'seasonality binding is not the authoritative tip under the pinned registry',
    );
  }
  return binding;
}

function resolveSourceAuthorities(store, input) {
  const binding = verifyOfficialBindingPin(
    store, input.subjectBindingRegistryManifestId, input.subjectBindingId,
  );
  const manifest = verifySnapshotDatasetManifest({
    store, snapshotDatasetManifestId: binding.datasetSnapshotManifestId,
  });
  const snapshot = verifyDatasetSnapshot({
    store, snapshotRecordId: manifest.manifest.snapshotRecordId,
  });
  if (snapshot.normalizedDailyBars.schemaVersion !== MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION
      || snapshot.core.normalizedObjectId !== binding.normalizedObjectId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_WRONG_REFERENCE_TYPE', 'seasonality binding does not reference official EOD OHLCV rows',
    );
  }
  const lineage = readTypedReference(
    store, binding.ingestionLineageId,
    MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, 'seasonality ingestion lineage',
  );
  const instrumentIdentity = readTypedReference(
    store, lineage.instrumentIdentityId,
    INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION, 'seasonality instrument identity',
  );
  if (!['EQUITY', 'ETF', 'ETN'].includes(instrumentIdentity.instrumentKind)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SEASONALITY_SOURCE_BUNDLE_INVALID',
      'seasonality instrument kind is outside the closed V1 scope',
    );
  }
  readTypedReference(
    store, input.implementationManifestId,
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, 'seasonality implementation manifest',
  );
  const calendar = verifyMarketCalendarRegistry({
    store, calendarRegistryManifestId: binding.calendarRegistryManifestId,
  });
  const rows = snapshot.normalizedDailyBars.rows;
  validateSeasonalityPriceBasisClosureV1({
    priceBasis: binding.priceBasis,
    corporateActionTreatment: binding.corporateActionTreatment,
    rows,
  });
  const cutoffDate = binding.knowledgeCutoff.slice(0, 10);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.instrumentIdentityId !== lineage.instrumentIdentityId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SEASONALITY_SOURCE_BUNDLE_INVALID',
        'seasonality row instrument identity diverges from the pinned L2B lineage', { index },
      );
    }
    if (row.sessionDate > cutoffDate) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SEASONALITY_LOOKAHEAD_FORBIDDEN',
        'seasonality source contains a row after knowledgeCutoff', { index },
      );
    }
  }
  const canonical = normalizeMarketSeasonalityFeatureSourceBundleV1({
    schemaVersion: MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    subjectBindingRegistryManifestId: input.subjectBindingRegistryManifestId,
    subjectBindingId: input.subjectBindingId,
    datasetSnapshotManifestId: binding.datasetSnapshotManifestId,
    normalizedMarketDataObjectId: binding.normalizedObjectId,
    knowledgeCutoff: binding.knowledgeCutoff,
    temporalCapability: binding.temporalCapability,
    priceBasis: binding.priceBasis,
    corporateActionTreatment: binding.corporateActionTreatment,
    instrumentIdentityId: lineage.instrumentIdentityId,
    calendarRegistryManifestId: binding.calendarRegistryManifestId,
    implementationManifestId: input.implementationManifestId,
  });
  return {
    canonical,
    binding,
    sourceRows: rows,
    calendarSessions: mergeCalendarSessions(calendar.calendars),
    calendarCoverage: calendar.calendars.map((core) => ({
      coverageFromDate: core.coverageFromDate,
      coverageToDateExclusive: core.coverageToDateExclusive,
    })),
  };
}

export function buildMarketSeasonalityFeatureSourceBundle(input) {
  const api = assertApiInput(input, [
    'subjectBindingRegistryManifestId', 'subjectBindingId', 'implementationManifestId',
  ]);
  assertStore(api.store, STORE_METHODS);
  for (const field of [
    'subjectBindingRegistryManifestId', 'subjectBindingId', 'implementationManifestId',
  ]) assertCasId(api[field], field);
  const resolved = resolveSourceAuthorities(api.store, api);
  const stored = putCanonicalL3(
    api.store, MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, resolved.canonical,
  );
  return { seasonalityFeatureSourceBundleId: stored.objectId };
}

export function verifyMarketSeasonalityFeatureSourceBundle(input) {
  const api = assertApiInput(input, ['seasonalityFeatureSourceBundleId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.seasonalityFeatureSourceBundleId, 'seasonalityFeatureSourceBundleId');
  const stored = normalizeMarketSeasonalityFeatureSourceBundleV1(readTypedReference(
    api.store, api.seasonalityFeatureSourceBundleId,
    MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, 'seasonality source bundle',
  ));
  const resolved = resolveSourceAuthorities(api.store, stored);
  if (stored.priceBasis !== resolved.canonical.priceBasis
      || stored.corporateActionTreatment !== resolved.canonical.corporateActionTreatment) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SEASONALITY_PRICE_BASIS_MISMATCH',
      'seasonality source bundle price basis diverges from the pinned binding',
    );
  }
  if (!canonicalValuesEqual(stored, resolved.canonical)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SEASONALITY_SOURCE_BUNDLE_INVALID',
      'seasonality source bundle diverges from its pinned authorities',
    );
  }
  return {
    seasonalityFeatureSourceBundleId: api.seasonalityFeatureSourceBundleId,
    seasonalityFeatureSourceBundle: stored,
    sourceRows: resolved.sourceRows,
    calendarSessions: resolved.calendarSessions,
    calendarCoverage: resolved.calendarCoverage,
  };
}

export function buildMarketSeasonalityFeatureComputationPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, STORE_METHODS);
  const policy = normalizeMarketSeasonalityFeatureComputationPolicyV1({
    schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_SEASONALITY_FEATURE_POLICY_VALUES,
  });
  const stored = putCanonicalL3(
    api.store, MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, policy,
  );
  return { seasonalityFeatureComputationPolicyId: stored.objectId };
}

export function verifyMarketSeasonalityFeatureComputationPolicy(input) {
  const api = assertApiInput(input, ['seasonalityFeatureComputationPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.seasonalityFeatureComputationPolicyId, 'seasonalityFeatureComputationPolicyId');
  const policy = normalizeMarketSeasonalityFeatureComputationPolicyV1(readTypedReference(
    api.store, api.seasonalityFeatureComputationPolicyId,
    MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, 'seasonality policy',
  ));
  return {
    seasonalityFeatureComputationPolicyId: api.seasonalityFeatureComputationPolicyId,
    policy,
    verifiedPolicy: policy,
  };
}

/** Compute rows only. C2 will own the report and full recomputation verifier. */
export function computeMarketSeasonalityFeatureRows(input) {
  const api = assertApiInput(input, [
    'seasonalityFeatureSourceBundleId', 'seasonalityFeatureComputationPolicyId',
  ]);
  assertStore(api.store, STORE_METHODS);
  const source = verifyMarketSeasonalityFeatureSourceBundle({
    store: api.store, seasonalityFeatureSourceBundleId: api.seasonalityFeatureSourceBundleId,
  });
  const { verifiedPolicy } = verifyMarketSeasonalityFeatureComputationPolicy({
    store: api.store,
    seasonalityFeatureComputationPolicyId: api.seasonalityFeatureComputationPolicyId,
  });
  const runtime = deriveMarketSeasonalityRuntimePolicyV1(verifiedPolicy);
  const document = deriveMarketSeasonalityFeatureRowsDocumentV1({
    sourceBundleId: api.seasonalityFeatureSourceBundleId,
    computationPolicyId: api.seasonalityFeatureComputationPolicyId,
    sourceBundle: source.seasonalityFeatureSourceBundle,
    sourceRows: source.sourceRows,
    calendarSessions: source.calendarSessions,
    calendarCoverage: source.calendarCoverage,
  }, runtime);
  const stored = api.store.putCanonicalObject({
    namespace: 'normalized',
    schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    value: document,
  });
  const reread = readSeasonalityRows(api.store, stored.objectId);
  if (!canonicalValuesEqual(document, reread)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_REFERENCE_CORRUPT', 'seasonality rows failed read-after-write verification',
    );
  }
  return { seasonalityFeatureRowsId: stored.objectId, seasonalityFeatureRows: reread };
}

export function readMarketSeasonalityFeatureRows(input) {
  const api = assertApiInput(input, ['seasonalityFeatureRowsId']);
  assertStore(api.store, STORE_METHODS);
  return {
    seasonalityFeatureRowsId: api.seasonalityFeatureRowsId,
    seasonalityFeatureRows: normalizeMarketSeasonalityFeatureRowsV1(
      readSeasonalityRows(api.store, api.seasonalityFeatureRowsId),
    ),
  };
}

// Explicit pinned-registry type reference for source audits.
export const MARKET_SEASONALITY_PINNED_BINDING_REGISTRY_SCHEMA_VERSION =
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION;
