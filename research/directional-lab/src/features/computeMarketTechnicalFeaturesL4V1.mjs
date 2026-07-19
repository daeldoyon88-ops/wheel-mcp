/**
 * L4A-A closed orchestration: official I6 bindings -> verified L1 EOD rows ->
 * deterministic feature rows and fully recomputable report.
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
  MARKET_TECHNICAL_AVAILABILITY_CODES,
  MARKET_TECHNICAL_BENCHMARK_ROLES,
  MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS,
  MARKET_TECHNICAL_FEATURE_POLICY_VALUES,
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketTechnicalFeatureComputationPolicyV1,
  normalizeMarketTechnicalFeatureComputationReportV1,
  normalizeMarketTechnicalFeatureRowsV1,
  normalizeMarketTechnicalFeatureSourceBundleV1,
} from '../contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
  tipForBindingPublicationKey,
  verifyMarketDataDatasetSnapshotBinding,
  verifyMarketDataDatasetSnapshotBindingRegistry,
} from '../contracts/marketDataDatasetSnapshotBindingL3V1.mjs';
import { MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION } from '../contracts/marketDataSnapshotMaterializationL3V1.mjs';
import { verifySnapshotDatasetManifest } from '../data/buildSnapshotDatasetManifest.mjs';
import { verifyDatasetSnapshot } from '../data/buildDatasetSnapshot.mjs';
import { toInternalFeatureBars } from './fixedPointFeatureMathL4V1.mjs';
import { computeReturnsDrawdownFeatures } from './returnsDrawdownFeaturesL4V1.mjs';
import { computeVolatilityFeatures } from './volatilityFeaturesL4V1.mjs';
import { computeMomentumFeatures } from './momentumFeaturesL4V1.mjs';
import {
  computeRelativeStrengthFeatures,
  computeTrendFeatures,
} from './trendRelativeStrengthFeaturesL4V1.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

/** Read a normalized-namespace feature document with hash and schema verification. */
function readFeatureRows(store, technicalFeatureRowsId) {
  assertCasId(technicalFeatureRowsId, 'technicalFeatureRowsId');
  try {
    return store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'normalized', objectId: technicalFeatureRowsId }),
      expectedObjectId: technicalFeatureRowsId,
      schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    }).value;
  } catch (cause) {
    throw new MarketDataL3Error(
      'MARKET_DATA_REFERENCE_CORRUPT', 'technical feature rows are missing or corrupt', { cause },
    );
  }
}

/**
 * Verify one binding is the official tip under the caller pin, then collapse
 * a descendant non-contributive registry to the first pin where it was that tip.
 */
function resolveOfficialBindingReference(store, reference) {
  const { bindingRegistryManifest: callingRegistry } = verifyMarketDataDatasetSnapshotBindingRegistry({
    store, bindingRegistryManifestId: reference.bindingRegistryManifestId,
  });
  const { binding } = verifyMarketDataDatasetSnapshotBinding({ store, bindingId: reference.bindingId });
  if (!callingRegistry.bindingIds.includes(reference.bindingId)
      || tipForBindingPublicationKey(callingRegistry, binding.bindingPublicationKey) !== reference.bindingId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
      'binding is absent or is not the publication-key tip under the pinned registry',
    );
  }

  const chain = [];
  const seen = new Set();
  let cursorId = reference.bindingRegistryManifestId;
  while (cursorId !== null) {
    if (seen.has(cursorId)) {
      throw new MarketDataL3Error('MARKET_DATA_BINDING_REGISTRY_CYCLE', 'binding registry chain contains a cycle');
    }
    seen.add(cursorId);
    const registry = readTypedReference(
      store, cursorId, MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
      'binding registry',
    );
    chain.push({ id: cursorId, registry });
    cursorId = registry.supersedesBindingRegistryManifestId;
  }
  chain.reverse();
  const firstAuthoritative = chain.find(({ registry }) => (
    registry.bindingIds.includes(reference.bindingId)
    && tipForBindingPublicationKey(registry, binding.bindingPublicationKey) === reference.bindingId
  ));
  if (!firstAuthoritative) {
    throw new MarketDataL3Error('MARKET_DATA_SNAPSHOT_BINDING_CONFLICT', 'binding has no authoritative registry prefix');
  }

  const manifest = verifySnapshotDatasetManifest({
    store, snapshotDatasetManifestId: binding.datasetSnapshotManifestId,
  });
  const snapshot = verifyDatasetSnapshot({
    store, snapshotRecordId: manifest.manifest.snapshotRecordId,
  });
  if (snapshot.normalizedDailyBars.schemaVersion !== MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION) {
    throw new MarketDataL3Error(
      'MARKET_DATA_WRONG_REFERENCE_TYPE', 'binding snapshot is not official EOD OHLCV canonical rows',
    );
  }
  const rows = snapshot.normalizedDailyBars.rows;
  if (rows.some((row) => row.frequency !== 'DAILY_REGULAR_SESSION')) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'binding snapshot contains a non-EOD row');
  }
  const currencies = [...new Set(rows.map((row) => row.currency))];
  if (currencies.length > 1) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'binding snapshot mixes currencies');
  }
  return {
    reference: {
      bindingRegistryManifestId: firstAuthoritative.id,
      bindingId: reference.bindingId,
    },
    binding,
    rows,
    currency: currencies[0] ?? null,
  };
}

/** @param {any} subject @param {any} benchmark @param {string} role */
function assertBenchmarkCompatibility(subject, benchmark, role) {
  if (benchmark.binding.knowledgeCutoff !== subject.binding.knowledgeCutoff) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID', `${role} benchmark knowledgeCutoff is incompatible`,
    );
  }
  if (benchmark.binding.calendarRegistryManifestId !== subject.binding.calendarRegistryManifestId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID', `${role} benchmark calendar is incompatible`,
    );
  }
  if (benchmark.binding.priceBasis !== subject.binding.priceBasis
      || benchmark.binding.corporateActionTreatment !== subject.binding.corporateActionTreatment) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID', `${role} benchmark price basis is incompatible`,
    );
  }
  if (subject.currency !== null && benchmark.currency !== null && subject.currency !== benchmark.currency) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID', `${role} benchmark currency is incompatible`,
    );
  }
}

/** Derive and verify the exact canonical bundle plus runtime L1 rows. */
function deriveSourceBundle(store, value) {
  const candidate = normalizeMarketTechnicalFeatureSourceBundleV1(value);
  const subject = resolveOfficialBindingReference(store, candidate.subject);
  const benchmarks = [];
  for (const benchmarkReference of candidate.benchmarks) {
    const benchmark = resolveOfficialBindingReference(store, benchmarkReference);
    assertBenchmarkCompatibility(subject, benchmark, benchmarkReference.role);
    benchmarks.push({ role: benchmarkReference.role, ...benchmark });
  }
  const canonical = normalizeMarketTechnicalFeatureSourceBundleV1({
    schemaVersion: MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    subject: subject.reference,
    benchmarks: benchmarks.map((benchmark) => ({ role: benchmark.role, ...benchmark.reference })),
  });
  return { canonical, subject, benchmarks };
}

/** @param {unknown} input */
export function buildMarketTechnicalFeatureSourceBundle(input) {
  const api = assertApiInput(input, ['subject', 'benchmarks']);
  assertStore(api.store, STORE_METHODS);
  const derived = deriveSourceBundle(api.store, {
    schemaVersion: MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    subject: api.subject,
    benchmarks: api.benchmarks,
  });
  const stored = putCanonicalL3(
    api.store, MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, derived.canonical,
  );
  return { technicalFeatureSourceBundleId: stored.objectId };
}

/** @param {unknown} input */
export function verifyMarketTechnicalFeatureSourceBundle(input) {
  const api = assertApiInput(input, ['technicalFeatureSourceBundleId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.technicalFeatureSourceBundleId, 'technicalFeatureSourceBundleId');
  const stored = normalizeMarketTechnicalFeatureSourceBundleV1(readTypedReference(
    api.store, api.technicalFeatureSourceBundleId,
    MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, 'technical feature source bundle',
  ));
  const derived = deriveSourceBundle(api.store, stored);
  if (!canonicalValuesEqual(stored, derived.canonical)) {
    throw new MarketDataL3Error('MARKET_DATA_RESOLVED_SERIES_CONFLICT', 'technical feature source bundle diverges from binding closure');
  }
  return {
    technicalFeatureSourceBundleId: api.technicalFeatureSourceBundleId,
    technicalFeatureSourceBundle: stored,
    subject: derived.subject,
    benchmarks: derived.benchmarks,
  };
}

/** @param {unknown} input */
export function buildMarketTechnicalFeatureComputationPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, STORE_METHODS);
  const policy = normalizeMarketTechnicalFeatureComputationPolicyV1({
    schemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_TECHNICAL_FEATURE_POLICY_VALUES,
  });
  const stored = putCanonicalL3(
    api.store, MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, policy,
  );
  return { technicalFeatureComputationPolicyId: stored.objectId };
}

/** @param {unknown} input */
export function verifyMarketTechnicalFeatureComputationPolicy(input) {
  const api = assertApiInput(input, ['technicalFeatureComputationPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.technicalFeatureComputationPolicyId, 'technicalFeatureComputationPolicyId');
  const stored = normalizeMarketTechnicalFeatureComputationPolicyV1(readTypedReference(
    api.store, api.technicalFeatureComputationPolicyId,
    MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, 'technical feature policy',
  ));
  const expected = normalizeMarketTechnicalFeatureComputationPolicyV1({
    schemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_TECHNICAL_FEATURE_POLICY_VALUES,
  });
  if (!canonicalValuesEqual(stored, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'technical feature policy is not closed V1');
  }
  return { technicalFeatureComputationPolicyId: api.technicalFeatureComputationPolicyId, policy: stored };
}

/** @param {Record<string, {value: unknown, availability: string}>} cells */
function splitCells(cells) {
  const features = {};
  const availability = {};
  for (const [name, cell] of Object.entries(cells)) {
    features[name] = cell.value;
    availability[name] = cell.availability;
  }
  return { features, availability };
}

/** Recompute all A1-A4 rows in memory, strictly left-to-right. */
function deriveFeatureRowsDocument(sourceBundleId, sourceRuntime) {
  const subjectBars = toInternalFeatureBars(sourceRuntime.subject.rows);
  const benchmarkBarsByRole = {};
  for (const benchmark of sourceRuntime.benchmarks) {
    benchmarkBarsByRole[benchmark.role] = toInternalFeatureBars(benchmark.rows);
  }
  const returnsDrawdowns = computeReturnsDrawdownFeatures(subjectBars);
  const volatility = computeVolatilityFeatures(subjectBars);
  const momentum = computeMomentumFeatures(subjectBars);
  const trend = computeTrendFeatures(subjectBars);
  const relative = computeRelativeStrengthFeatures(subjectBars, benchmarkBarsByRole);

  const rows = subjectBars.map((bar, index) => {
    const a1 = splitCells(returnsDrawdowns[index]);
    const a2 = splitCells(volatility[index]);
    const a3 = splitCells(momentum[index]);
    const a4 = splitCells(trend[index]);
    const relativeFeatures = {};
    const relativeAvailability = {};
    for (const role of MARKET_TECHNICAL_BENCHMARK_ROLES) {
      const split = splitCells(relative[role][index]);
      relativeFeatures[role] = split.features;
      relativeAvailability[role] = split.availability;
    }
    return {
      sessionDate: bar.source.sessionDate,
      subjectBarIdentityId: bar.source.barIdentityId,
      subjectResolvedObservationId: bar.source.resolvedObservationId,
      sourceBindingId: sourceRuntime.subject.reference.bindingId,
      features: {
        returnsDrawdowns: a1.features,
        volatility: a2.features,
        momentum: a3.features,
        trend: a4.features,
        relativeStrength: relativeFeatures,
      },
      availability: {
        returnsDrawdowns: a1.availability,
        volatility: a2.availability,
        momentum: a3.availability,
        trend: a4.availability,
        relativeStrength: relativeAvailability,
      },
    };
  });
  return normalizeMarketTechnicalFeatureRowsV1({
    schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    rows,
  });
}

/** @param {any} document */
function availabilityCountsFor(document) {
  const counts = Object.fromEntries(MARKET_TECHNICAL_AVAILABILITY_CODES.map((code) => [code, 0]));
  const countGroup = (group) => {
    for (const value of Object.values(group)) {
      if (typeof value === 'string') counts[value] += 1;
      else countGroup(value);
    }
  };
  for (const row of document.rows) countGroup(row.availability);
  return counts;
}

/** @param {object} input */
function deriveReportValue(input) {
  const benchmarkBindingIds = { MARKET: null, SECTOR: null, UNDERLYING: null };
  for (const benchmark of input.sourceRuntime.benchmarks) {
    benchmarkBindingIds[benchmark.role] = benchmark.reference.bindingId;
  }
  return normalizeMarketTechnicalFeatureComputationReportV1({
    schemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    technicalFeatureSourceBundleId: input.technicalFeatureSourceBundleId,
    technicalFeatureComputationPolicyId: input.technicalFeatureComputationPolicyId,
    technicalFeatureRowsId: input.technicalFeatureRowsId,
    subjectBindingId: input.sourceRuntime.subject.reference.bindingId,
    benchmarkBindingIds,
    rowCount: input.document.rows.length,
    firstSessionDate: input.document.rows.length === 0 ? null : input.document.rows[0].sessionDate,
    lastSessionDate: input.document.rows.length === 0 ? null : input.document.rows[input.document.rows.length - 1].sessionDate,
    featureSchemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    featureFamilyVersions: MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS,
    availabilityCounts: availabilityCountsFor(input.document),
  });
}

/** @param {unknown} input */
export function computeMarketTechnicalFeatures(input) {
  const api = assertApiInput(input, [
    'technicalFeatureSourceBundleId', 'technicalFeatureComputationPolicyId',
  ]);
  assertStore(api.store, STORE_METHODS);
  const sourceRuntime = verifyMarketTechnicalFeatureSourceBundle({
    store: api.store, technicalFeatureSourceBundleId: api.technicalFeatureSourceBundleId,
  });
  verifyMarketTechnicalFeatureComputationPolicy({
    store: api.store, technicalFeatureComputationPolicyId: api.technicalFeatureComputationPolicyId,
  });

  const document = deriveFeatureRowsDocument(api.technicalFeatureSourceBundleId, sourceRuntime);
  const storedRows = api.store.putCanonicalObject({
    namespace: 'normalized', schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION, value: document,
  });
  const rereadRows = readFeatureRows(api.store, storedRows.objectId);
  if (!canonicalValuesEqual(document, rereadRows)) {
    throw new MarketDataL3Error('MARKET_DATA_REFERENCE_CORRUPT', 'technical feature rows failed read-after-write verification');
  }
  const report = deriveReportValue({
    technicalFeatureSourceBundleId: api.technicalFeatureSourceBundleId,
    technicalFeatureComputationPolicyId: api.technicalFeatureComputationPolicyId,
    technicalFeatureRowsId: storedRows.objectId,
    sourceRuntime,
    document,
  });
  const storedReport = putCanonicalL3(
    api.store, MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, report,
  );
  verifyMarketTechnicalFeatureComputation({
    store: api.store, technicalFeatureComputationReportId: storedReport.objectId,
  });
  return {
    technicalFeatureRowsId: storedRows.objectId,
    technicalFeatureComputationReportId: storedReport.objectId,
  };
}

/** Full verifier: re-verify every source and recompute every row and report byte. */
export function verifyMarketTechnicalFeatureComputation(input) {
  const api = assertApiInput(input, ['technicalFeatureComputationReportId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.technicalFeatureComputationReportId, 'technicalFeatureComputationReportId');
  const storedReport = normalizeMarketTechnicalFeatureComputationReportV1(readTypedReference(
    api.store, api.technicalFeatureComputationReportId,
    MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, 'technical feature computation report',
  ));
  const sourceRuntime = verifyMarketTechnicalFeatureSourceBundle({
    store: api.store,
    technicalFeatureSourceBundleId: storedReport.technicalFeatureSourceBundleId,
  });
  verifyMarketTechnicalFeatureComputationPolicy({
    store: api.store,
    technicalFeatureComputationPolicyId: storedReport.technicalFeatureComputationPolicyId,
  });
  const expectedRows = deriveFeatureRowsDocument(storedReport.technicalFeatureSourceBundleId, sourceRuntime);
  const storedRows = readFeatureRows(api.store, storedReport.technicalFeatureRowsId);
  if (!canonicalValuesEqual(storedRows, expectedRows)) {
    throw new MarketDataL3Error('MARKET_DATA_RESOLVED_SERIES_CONFLICT', 'stored technical feature rows diverge from full recomputation');
  }
  const expectedReport = deriveReportValue({
    technicalFeatureSourceBundleId: storedReport.technicalFeatureSourceBundleId,
    technicalFeatureComputationPolicyId: storedReport.technicalFeatureComputationPolicyId,
    technicalFeatureRowsId: storedReport.technicalFeatureRowsId,
    sourceRuntime,
    document: expectedRows,
  });
  if (!canonicalValuesEqual(storedReport, expectedReport)) {
    throw new MarketDataL3Error('MARKET_DATA_RESOLVED_SERIES_CONFLICT', 'technical feature report diverges from full recomputation');
  }
  return {
    technicalFeatureComputationReportId: api.technicalFeatureComputationReportId,
    technicalFeatureComputationReport: storedReport,
    technicalFeatureRowsId: storedReport.technicalFeatureRowsId,
    technicalFeatureRows: storedRows,
  };
}
