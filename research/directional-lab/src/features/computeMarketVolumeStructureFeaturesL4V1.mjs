/**
 * L4A-B closed orchestration: a verified L4A-A computation report -> derived
 * volume/structure source bundle -> deterministic feature rows and a fully
 * recomputable report. L4A-A rows, IDs, formulas and contracts are never
 * modified; L4A-B is a separate offline artefact.
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
  MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES,
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS,
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketVolumeStructureFeatureComputationPolicyV1,
  normalizeMarketVolumeStructureFeatureComputationReportV1,
  normalizeMarketVolumeStructureFeatureRowsV1,
  normalizeMarketVolumeStructureFeatureSourceBundleV1,
} from '../contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import {
  verifyMarketTechnicalFeatureComputation,
  verifyMarketTechnicalFeatureSourceBundle,
} from './computeMarketTechnicalFeaturesL4V1.mjs';
import {
  extractTechnicalCells,
  toInternalVolumeStructureBars,
} from './volumeStructureBarInputsL4V1.mjs';
import { computeVolumeParticipationFeatures } from './volumeParticipationFeaturesL4V1.mjs';
import { computeEodVolumeWeightedPriceFeatures } from './eodVolumeWeightedPriceFeaturesL4V1.mjs';
import {
  computeAlternatedStreamStates,
  computePivotFamilyRows,
  detectConfirmedPivots,
} from './confirmedPivotFeaturesL4V1.mjs';
import { computeSupportResistanceFeatures } from './supportResistanceFeaturesL4V1.mjs';
import { computeGapBreakoutFeatures } from './gapBreakoutFeaturesL4V1.mjs';
import { computeCongestionFeatures } from './congestionFeaturesL4V1.mjs';
import { computeFibonacciFeatures } from './fibonacciStructureFeaturesL4V1.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

/** Read a normalized-namespace L4A-B rows document with hash verification. */
function readVolumeStructureRows(store, volumeStructureFeatureRowsId) {
  assertCasId(volumeStructureFeatureRowsId, 'volumeStructureFeatureRowsId');
  try {
    return store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'normalized', objectId: volumeStructureFeatureRowsId }),
      expectedObjectId: volumeStructureFeatureRowsId,
      schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    }).value;
  } catch (cause) {
    throw new MarketDataL3Error(
      'MARKET_DATA_REFERENCE_CORRUPT', 'volume structure feature rows are missing or corrupt', { cause },
    );
  }
}

/**
 * Fully verify the referenced L4A-A computation, its official I6 binding and
 * the exact correspondence between the L4A-A rows and the L1 snapshot rows,
 * then derive the closed canonical L4A-B source bundle.
 */
function deriveSourceBundle(store, technicalFeatureComputationReportId) {
  const technical = verifyMarketTechnicalFeatureComputation({
    store, technicalFeatureComputationReportId,
  });
  const report = technical.technicalFeatureComputationReport;
  const sourceRuntime = verifyMarketTechnicalFeatureSourceBundle({
    store, technicalFeatureSourceBundleId: report.technicalFeatureSourceBundleId,
  });
  const subject = sourceRuntime.subject;
  const technicalRows = technical.technicalFeatureRows.rows;
  const subjectRows = subject.rows;
  if (technicalRows.length !== subjectRows.length) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'L4A-A rows and subject snapshot rows have different lengths',
    );
  }
  for (let index = 0; index < technicalRows.length; index += 1) {
    const technicalRow = technicalRows[index];
    const subjectRow = subjectRows[index];
    if (technicalRow.sessionDate !== subjectRow.sessionDate
        || technicalRow.subjectBarIdentityId !== subjectRow.barIdentityId
        || technicalRow.subjectResolvedObservationId !== subjectRow.resolvedObservationId
        || technicalRow.sourceBindingId !== subject.reference.bindingId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
        'L4A-A rows do not correspond exactly to the subject binding snapshot',
        { index },
      );
    }
  }
  const canonical = normalizeMarketVolumeStructureFeatureSourceBundleV1({
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    technicalFeatureComputationReportId,
    technicalFeatureRowsId: report.technicalFeatureRowsId,
    technicalFeatureSourceBundleId: report.technicalFeatureSourceBundleId,
    technicalFeatureComputationPolicyId: report.technicalFeatureComputationPolicyId,
    subjectBindingRegistryManifestId: subject.reference.bindingRegistryManifestId,
    subjectBindingId: subject.reference.bindingId,
    datasetSnapshotManifestId: subject.binding.datasetSnapshotManifestId,
    normalizedMarketDataObjectId: subject.binding.normalizedObjectId,
    knowledgeCutoff: subject.binding.knowledgeCutoff,
    temporalCapability: subject.binding.temporalCapability,
    priceBasis: subject.binding.priceBasis,
    corporateActionTreatment: subject.binding.corporateActionTreatment,
  });
  return { canonical, technicalRows, subjectRows, subject };
}

/** @param {unknown} input */
export function buildMarketVolumeStructureFeatureSourceBundle(input) {
  const api = assertApiInput(input, ['technicalFeatureComputationReportId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.technicalFeatureComputationReportId, 'technicalFeatureComputationReportId');
  const derived = deriveSourceBundle(api.store, api.technicalFeatureComputationReportId);
  const stored = putCanonicalL3(
    api.store, MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, derived.canonical,
  );
  return { volumeStructureFeatureSourceBundleId: stored.objectId };
}

/** @param {unknown} input */
export function verifyMarketVolumeStructureFeatureSourceBundle(input) {
  const api = assertApiInput(input, ['volumeStructureFeatureSourceBundleId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.volumeStructureFeatureSourceBundleId, 'volumeStructureFeatureSourceBundleId');
  const stored = normalizeMarketVolumeStructureFeatureSourceBundleV1(readTypedReference(
    api.store, api.volumeStructureFeatureSourceBundleId,
    MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, 'volume structure feature source bundle',
  ));
  const derived = deriveSourceBundle(api.store, stored.technicalFeatureComputationReportId);
  if (!canonicalValuesEqual(stored, derived.canonical)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'volume structure feature source bundle diverges from its L4A-A closure',
    );
  }
  return {
    volumeStructureFeatureSourceBundleId: api.volumeStructureFeatureSourceBundleId,
    volumeStructureFeatureSourceBundle: stored,
    technicalRows: derived.technicalRows,
    subjectRows: derived.subjectRows,
    subject: derived.subject,
  };
}

/** @param {unknown} input */
export function buildMarketVolumeStructureFeatureComputationPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, STORE_METHODS);
  const policy = normalizeMarketVolumeStructureFeatureComputationPolicyV1({
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES,
  });
  const stored = putCanonicalL3(
    api.store, MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, policy,
  );
  return { volumeStructureFeatureComputationPolicyId: stored.objectId };
}

/** @param {unknown} input */
export function verifyMarketVolumeStructureFeatureComputationPolicy(input) {
  const api = assertApiInput(input, ['volumeStructureFeatureComputationPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.volumeStructureFeatureComputationPolicyId, 'volumeStructureFeatureComputationPolicyId');
  const stored = normalizeMarketVolumeStructureFeatureComputationPolicyV1(readTypedReference(
    api.store, api.volumeStructureFeatureComputationPolicyId,
    MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, 'volume structure feature policy',
  ));
  return {
    volumeStructureFeatureComputationPolicyId: api.volumeStructureFeatureComputationPolicyId,
    policy: stored,
  };
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

/** Recompute every B1/B2 row strictly left-to-right plus report counters. */
function deriveFeatureRowsDocument(runtime) {
  const bars = toInternalVolumeStructureBars(runtime.subjectRows);
  const technicalCells = extractTechnicalCells(runtime.technicalRows);
  const return20Cells = technicalCells.map((cells) => cells.return20);

  const participation = computeVolumeParticipationFeatures(bars, return20Cells);
  const pivots = detectConfirmedPivots(bars);
  const streamStates = computeAlternatedStreamStates(bars, pivots);
  const weighted = computeEodVolumeWeightedPriceFeatures(bars, streamStates);
  const pivotRows = computePivotFamilyRows(streamStates);
  const supportResistance = computeSupportResistanceFeatures(bars, pivots, technicalCells);
  const gapsBreakouts = computeGapBreakoutFeatures(
    bars, supportResistance.levels, participation.relativeVolume20Internal,
  );
  const congestion = computeCongestionFeatures(bars, technicalCells);
  const fibonacci = computeFibonacciFeatures(bars, streamStates);

  const technicalFeatureRowsId = runtime.volumeStructureFeatureSourceBundle.technicalFeatureRowsId;
  const sourceBindingId = runtime.volumeStructureFeatureSourceBundle.subjectBindingId;
  const rows = bars.map((bar, index) => {
    const families = {
      volumeParticipation: splitCells(participation.rows[index]),
      eodVolumeWeightedPrices: splitCells(weighted[index]),
      pivots: splitCells(pivotRows[index]),
      supportResistance: splitCells(supportResistance.rows[index]),
      gapsBreakouts: splitCells(gapsBreakouts.rows[index]),
      congestion: splitCells(congestion[index]),
      fibonacci: splitCells(fibonacci[index]),
    };
    const features = {};
    const availability = {};
    for (const [family, split] of Object.entries(families)) {
      features[family] = split.features;
      availability[family] = split.availability;
    }
    return {
      sessionDate: bar.source.sessionDate,
      subjectBarIdentityId: bar.source.barIdentityId,
      subjectResolvedObservationId: bar.source.resolvedObservationId,
      sourceBindingId,
      technicalFeatureRowsId,
      features,
      availability,
    };
  });
  const document = normalizeMarketVolumeStructureFeatureRowsV1({
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    rows,
  });
  const confirmedSwingHighCount = pivots.filter((pivot) => pivot.pivotType === 'SWING_HIGH').length;
  const confirmedSwingLowCount = pivots.length - confirmedSwingHighCount;
  return {
    document,
    counters: {
      confirmedPivotCount: pivots.length,
      confirmedSwingHighCount,
      confirmedSwingLowCount,
      detectedGapCount: gapsBreakouts.detectedGapCount,
      openGapCount: gapsBreakouts.openGapCount,
    },
  };
}

/** @param {any} document */
function availabilityCountsFor(document) {
  const counts = Object.fromEntries(
    MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES.map((code) => [code, 0]),
  );
  for (const row of document.rows) {
    for (const family of Object.values(row.availability)) {
      for (const code of Object.values(family)) counts[code] += 1;
    }
  }
  return counts;
}

/** @param {object} input */
function deriveReportValue(input) {
  const bundle = input.runtime.volumeStructureFeatureSourceBundle;
  const rows = input.document.rows;
  return normalizeMarketVolumeStructureFeatureComputationReportV1({
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    volumeStructureFeatureSourceBundleId: input.volumeStructureFeatureSourceBundleId,
    volumeStructureFeatureComputationPolicyId: input.volumeStructureFeatureComputationPolicyId,
    volumeStructureFeatureRowsId: input.volumeStructureFeatureRowsId,
    technicalFeatureComputationReportId: bundle.technicalFeatureComputationReportId,
    technicalFeatureRowsId: bundle.technicalFeatureRowsId,
    subjectBindingId: bundle.subjectBindingId,
    datasetSnapshotManifestId: bundle.datasetSnapshotManifestId,
    rowCount: rows.length,
    firstSessionDate: rows.length === 0 ? null : rows[0].sessionDate,
    lastSessionDate: rows.length === 0 ? null : rows[rows.length - 1].sessionDate,
    featureSchemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    featureFamilyVersions: MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS,
    availabilityCounts: availabilityCountsFor(input.document),
    ...input.counters,
  });
}

/** @param {unknown} input */
export function computeMarketVolumeStructureFeatures(input) {
  const api = assertApiInput(input, [
    'volumeStructureFeatureSourceBundleId', 'volumeStructureFeatureComputationPolicyId',
  ]);
  assertStore(api.store, STORE_METHODS);
  const runtime = verifyMarketVolumeStructureFeatureSourceBundle({
    store: api.store,
    volumeStructureFeatureSourceBundleId: api.volumeStructureFeatureSourceBundleId,
  });
  verifyMarketVolumeStructureFeatureComputationPolicy({
    store: api.store,
    volumeStructureFeatureComputationPolicyId: api.volumeStructureFeatureComputationPolicyId,
  });

  const derived = deriveFeatureRowsDocument(runtime);
  const storedRows = api.store.putCanonicalObject({
    namespace: 'normalized',
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    value: derived.document,
  });
  const rereadRows = readVolumeStructureRows(api.store, storedRows.objectId);
  if (!canonicalValuesEqual(derived.document, rereadRows)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_REFERENCE_CORRUPT',
      'volume structure feature rows failed read-after-write verification',
    );
  }
  const report = deriveReportValue({
    volumeStructureFeatureSourceBundleId: api.volumeStructureFeatureSourceBundleId,
    volumeStructureFeatureComputationPolicyId: api.volumeStructureFeatureComputationPolicyId,
    volumeStructureFeatureRowsId: storedRows.objectId,
    runtime,
    document: derived.document,
    counters: derived.counters,
  });
  const storedReport = putCanonicalL3(
    api.store, MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, report,
  );
  verifyMarketVolumeStructureFeatureComputation({
    store: api.store, volumeStructureFeatureComputationReportId: storedReport.objectId,
  });
  return {
    volumeStructureFeatureRowsId: storedRows.objectId,
    volumeStructureFeatureComputationReportId: storedReport.objectId,
  };
}

/** Full verifier: re-verify every source and recompute every row and report byte. */
export function verifyMarketVolumeStructureFeatureComputation(input) {
  const api = assertApiInput(input, ['volumeStructureFeatureComputationReportId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.volumeStructureFeatureComputationReportId, 'volumeStructureFeatureComputationReportId');
  const storedReport = normalizeMarketVolumeStructureFeatureComputationReportV1(readTypedReference(
    api.store, api.volumeStructureFeatureComputationReportId,
    MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    'volume structure feature computation report',
  ));
  const runtime = verifyMarketVolumeStructureFeatureSourceBundle({
    store: api.store,
    volumeStructureFeatureSourceBundleId: storedReport.volumeStructureFeatureSourceBundleId,
  });
  verifyMarketVolumeStructureFeatureComputationPolicy({
    store: api.store,
    volumeStructureFeatureComputationPolicyId: storedReport.volumeStructureFeatureComputationPolicyId,
  });
  const derived = deriveFeatureRowsDocument(runtime);
  const storedRows = readVolumeStructureRows(api.store, storedReport.volumeStructureFeatureRowsId);
  if (!canonicalValuesEqual(storedRows, derived.document)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'stored volume structure feature rows diverge from full recomputation',
    );
  }
  const expectedReport = deriveReportValue({
    volumeStructureFeatureSourceBundleId: storedReport.volumeStructureFeatureSourceBundleId,
    volumeStructureFeatureComputationPolicyId: storedReport.volumeStructureFeatureComputationPolicyId,
    volumeStructureFeatureRowsId: storedReport.volumeStructureFeatureRowsId,
    runtime,
    document: derived.document,
    counters: derived.counters,
  });
  if (!canonicalValuesEqual(storedReport, expectedReport)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'volume structure feature report diverges from full recomputation',
    );
  }
  return {
    volumeStructureFeatureComputationReportId: api.volumeStructureFeatureComputationReportId,
    volumeStructureFeatureComputationReport: storedReport,
    volumeStructureFeatureRowsId: storedReport.volumeStructureFeatureRowsId,
    volumeStructureFeatureRows: storedRows,
  };
}
