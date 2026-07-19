/**
 * L3-I5 — materialize a verified point-in-time resolved series into an
 * official L1 dataset snapshot under a closed projection policy.
 *
 * Boundary:
 *   L3-I4 decides which observations are historically visible.
 *   L3-I5 materializes exactly those PRESENT observations — it does not
 *   re-resolve tips, transform prices, or search for tip-of-CAS objects.
 *
 * Offline research pipeline only. Never imported by the scanner or dashboard.
 */

import { canonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
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
  MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketDataEodOhlcvCanonicalRowsV1,
  normalizeMarketDataSnapshotMaterializationPolicyV1,
  normalizeMarketDataSnapshotMaterializationReportV1,
  normalizeMarketDataSnapshotSourceBundleV1,
} from '../contracts/marketDataSnapshotMaterializationL3V1.mjs';
import {
  verifyMarketDataBarObservation,
} from '../contracts/marketDataBarRevisionL3V1.mjs';
import {
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
  verifyMarketDataBarIdentity,
} from '../contracts/marketDataBarIdentityL3V1.mjs';
import {
  MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
} from '../contracts/marketDataSourceL3V1.mjs';
import {
  buildDatasetSnapshot,
  verifyDatasetSnapshot,
} from '../data/buildDatasetSnapshot.mjs';
import {
  buildSnapshotDatasetManifest,
  verifySnapshotDatasetManifest,
} from '../data/buildSnapshotDatasetManifest.mjs';
import {
  verifyMarketDataResolvedSeries,
  verifyMarketDataResolvedSeriesManifest,
} from '../resolution/resolveMarketDataAsOfL3V1.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

const MATERIALIZER_VERSION = 'marketDataSnapshotMaterializationL3V1/1';

/** Derive the closed source-bundle value from a fully verified resolved series. */
function deriveSourceBundleValue(resolvedSeriesManifestId, manifest) {
  return normalizeMarketDataSnapshotSourceBundleV1({
    schemaVersion: MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
    resolvedSeriesManifestId,
    contributingRegistryPrefixId: manifest.contributingRegistryPrefixId,
    ingestionLineageId: manifest.ingestionLineageId,
    knowledgeCutoff: manifest.knowledgeCutoff,
    temporalCapability: manifest.temporalCapability,
    contributingIngestionManifestIds: manifest.contributingIngestionManifestIds,
    contributingObservationIds: manifest.contributingObservationIds,
    contributingCorrectionIds: manifest.contributingCorrectionIds,
    contributingAcquisitionRecordIds: manifest.contributingAcquisitionRecordIds,
    contributingSourceArtifactIds: manifest.contributingSourceArtifactIds,
    identityRegistryManifestId: manifest.identityRegistryManifestId,
    calendarRegistryManifestId: manifest.calendarRegistryManifestId,
    corporateActionRegistryManifestId: manifest.corporateActionRegistryManifestId,
    priceBasis: manifest.priceBasis,
    corporateActionTreatment: manifest.corporateActionTreatment,
  });
}

/**
 * Build the closed MarketDataSnapshotSourceBundle/1 from a verified
 * resolved-series manifest. Contributor lists are never accepted from the caller.
 * @param {unknown} input
 */
export function buildMarketDataSnapshotSourceBundle(input) {
  const api = assertApiInput(input, ['resolvedSeriesManifestId', 'ingestionRegistryManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.resolvedSeriesManifestId, 'resolvedSeriesManifestId');
  assertCasId(api.ingestionRegistryManifestId, 'ingestionRegistryManifestId');

  const { resolvedSeriesManifest: manifest } = verifyMarketDataResolvedSeries({
    store: api.store,
    resolvedSeriesManifestId: api.resolvedSeriesManifestId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });
  const bundle = deriveSourceBundleValue(api.resolvedSeriesManifestId, manifest);
  const stored = putCanonicalL3(api.store, MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION, bundle);
  return { snapshotSourceBundleId: stored.objectId };
}

/**
 * Verify a stored source bundle by recomputing it from the resolved series.
 * @param {unknown} input
 */
export function verifyMarketDataSnapshotSourceBundle(input) {
  const api = assertApiInput(input, ['snapshotSourceBundleId', 'ingestionRegistryManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.snapshotSourceBundleId, 'snapshotSourceBundleId');
  assertCasId(api.ingestionRegistryManifestId, 'ingestionRegistryManifestId');

  const raw = readTypedReference(
    api.store, api.snapshotSourceBundleId,
    MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION, 'snapshot source bundle',
  );
  const stored = normalizeMarketDataSnapshotSourceBundleV1(raw);
  const { resolvedSeriesManifest: manifest } = verifyMarketDataResolvedSeries({
    store: api.store,
    resolvedSeriesManifestId: stored.resolvedSeriesManifestId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });
  const expected = deriveSourceBundleValue(stored.resolvedSeriesManifestId, manifest);
  if (!canonicalValuesEqual(stored, expected)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'snapshot source bundle diverges from the verified resolved-series provenance',
    );
  }
  return {
    snapshotSourceBundleId: api.snapshotSourceBundleId,
    snapshotSourceBundle: stored,
    resolvedSeriesManifest: manifest,
  };
}

/** Closed first-version materialization policy (no free economic parameters). */
function closedMaterializationPolicyValue() {
  return normalizeMarketDataSnapshotMaterializationPolicyV1({
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
    ...MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES,
  });
}

/**
 * @param {unknown} input
 */
export function buildMarketDataSnapshotMaterializationPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, STORE_METHODS);
  const policy = closedMaterializationPolicyValue();
  const stored = putCanonicalL3(api.store, MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION, policy);
  return { materializationPolicyId: stored.objectId };
}

/**
 * @param {unknown} input
 */
export function verifyMarketDataSnapshotMaterializationPolicy(input) {
  const api = assertApiInput(input, ['materializationPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.materializationPolicyId, 'materializationPolicyId');
  const raw = readTypedReference(
    api.store, api.materializationPolicyId,
    MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION, 'materialization policy',
  );
  const stored = normalizeMarketDataSnapshotMaterializationPolicyV1(raw);
  const expected = closedMaterializationPolicyValue();
  if (!canonicalValuesEqual(stored, expected)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'materialization policy is not the closed V1 policy',
    );
  }
  return {
    materializationPolicyId: api.materializationPolicyId,
    materializationPolicy: stored,
  };
}

/**
 * Project PRESENT-only rows from a verified resolved-series manifest.
 * WITHDRAWN and MOVED_TO_OTHER_SESSION source entries produce no price rows.
 * Ordering: sessionDate ascending, then barIdentityId lexicographic.
 * L3-I4 guarantees one lineage/instrument, so instrumentIdentityId is constant
 * and is not used as a primary sort key.
 * @param {any} store
 * @param {object} manifest
 * @param {object} sourceBundle
 */
function projectCanonicalRows(store, manifest, sourceBundle) {
  if (manifest.ingestionLineageId !== sourceBundle.ingestionLineageId
      || manifest.priceBasis !== sourceBundle.priceBasis
      || manifest.corporateActionTreatment !== sourceBundle.corporateActionTreatment
      || manifest.identityRegistryManifestId !== sourceBundle.identityRegistryManifestId
      || manifest.calendarRegistryManifestId !== sourceBundle.calendarRegistryManifestId
      || manifest.corporateActionRegistryManifestId !== sourceBundle.corporateActionRegistryManifestId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'source bundle pins diverge from the resolved-series manifest',
    );
  }

  const lineage = readTypedReference(
    store, manifest.ingestionLineageId,
    MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, 'ingestion lineage',
  );

  const contributingObservationIds = new Set(manifest.contributingObservationIds);
  const contributingCorrectionIds = new Set(manifest.contributingCorrectionIds);
  const rows = [];
  let presentEntryCount = 0;
  let withdrawnEntryCount = 0;
  let movedToOtherSessionEntryCount = 0;

  for (const entry of manifest.resolvedBarEntries) {
    if (entry.disposition === 'WITHDRAWN') {
      withdrawnEntryCount += 1;
      continue;
    }
    if (entry.disposition === 'MOVED_TO_OTHER_SESSION') {
      movedToOtherSessionEntryCount += 1;
      continue;
    }
    if (entry.disposition !== 'PRESENT') {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'unknown resolved bar disposition', {
        disposition: entry.disposition,
      });
    }
    presentEntryCount += 1;
    if (entry.resolvedObservationId === null) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'PRESENT entry missing resolvedObservationId');
    }
    if (!contributingObservationIds.has(entry.resolvedObservationId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE',
        'PRESENT observation is outside the contributing observation closure',
        { observationId: entry.resolvedObservationId },
      );
    }
    if (!contributingCorrectionIds.has(entry.resolvedCorrectionTipId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE',
        'PRESENT correction tip is outside the contributing correction closure',
        { correctionId: entry.resolvedCorrectionTipId },
      );
    }

    const { barIdentity } = verifyMarketDataBarIdentity({ store, barIdentityId: entry.barIdentityId });
    if (barIdentity.sessionDate !== entry.sessionDate) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
        'resolved entry sessionDate diverges from bar identity',
        { barIdentityId: entry.barIdentityId },
      );
    }
    if (barIdentity.instrumentIdentityId !== lineage.instrumentIdentityId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION',
        'resolved bar identity belongs to another instrument',
        { barIdentityId: entry.barIdentityId },
      );
    }

    const { observation } = verifyMarketDataBarObservation({
      store, observationId: entry.resolvedObservationId,
    });
    if (observation.ingestionLineageId !== manifest.ingestionLineageId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION',
        'materialized observation belongs to another lineage',
        { observationId: entry.resolvedObservationId },
      );
    }
    if (observation.barIdentityId !== entry.barIdentityId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
        'materialized observation barIdentityId diverges from the resolved entry',
        { observationId: entry.resolvedObservationId },
      );
    }
    if (observation.values.priceBasis !== manifest.priceBasis) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH',
        'materialized observation priceBasis diverges from the resolved series',
        { observationId: entry.resolvedObservationId },
      );
    }
    // The resolved series already closed calendar coverage under its advanced
    // pin. Observation calendar pins may be ancestors; I5 does not re-resolve
    // calendar authority and does not reject ancestor pins here.

    rows.push({
      instrumentIdentityId: barIdentity.instrumentIdentityId,
      barIdentityId: entry.barIdentityId,
      sessionDate: entry.sessionDate,
      frequency: barIdentity.frequency,
      currency: observation.values.currency,
      openAtoms: observation.values.openAtoms,
      highAtoms: observation.values.highAtoms,
      lowAtoms: observation.values.lowAtoms,
      closeAtoms: observation.values.closeAtoms,
      priceScale: observation.values.priceScale,
      volumeAtoms: observation.values.volumeAtoms,
      volumeScale: observation.values.volumeScale,
      priceBasis: observation.values.priceBasis,
      resolvedObservationId: entry.resolvedObservationId,
      resolvedCorrectionTipId: entry.resolvedCorrectionTipId,
    });
  }

  rows.sort((left, right) => (
    left.sessionDate < right.sessionDate ? -1
      : left.sessionDate > right.sessionDate ? 1
        : left.barIdentityId < right.barIdentityId ? -1
          : left.barIdentityId > right.barIdentityId ? 1 : 0
  ));

  const document = normalizeMarketDataEodOhlcvCanonicalRowsV1({
    schemaVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
    rows,
  });

  return {
    document,
    presentEntryCount,
    withdrawnEntryCount,
    movedToOtherSessionEntryCount,
  };
}

function deriveReportValue({
  snapshotSourceBundleId,
  materializationPolicyId,
  resolvedSeriesManifestId,
  datasetSnapshotManifestId,
  document,
  presentEntryCount,
  withdrawnEntryCount,
  movedToOtherSessionEntryCount,
}) {
  const rowCount = document.rows.length;
  const status = rowCount === 0 ? 'MATERIALIZED_EMPTY' : 'MATERIALIZED';
  return normalizeMarketDataSnapshotMaterializationReportV1({
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    snapshotSourceBundleId,
    materializationPolicyId,
    resolvedSeriesManifestId,
    datasetSnapshotManifestId,
    status,
    rowCount,
    presentEntryCount,
    withdrawnEntryCount,
    movedToOtherSessionEntryCount,
    firstSessionDate: rowCount === 0 ? null : document.rows[0].sessionDate,
    lastSessionDate: rowCount === 0 ? null : document.rows[rowCount - 1].sessionDate,
    materializedObservationIds: document.rows.map((row) => row.resolvedObservationId).sort(),
    materializedCorrectionTipIds: document.rows.map((row) => row.resolvedCorrectionTipId).sort(),
    outputSchemaVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
  });
}

/**
 * Write the projected rows through the official L1 snapshot writer and envelope.
 * @param {any} store
 * @param {object} document
 * @param {object} sourceBundle
 * @param {string} materializationPolicyId
 */
function writeOfficialL1Snapshot(store, document, sourceBundle, materializationPolicyId) {
  const sourceBytes = canonicalJsonBytes(document);
  const instrumentKey = sourceBundle.ingestionLineageId.slice('sha256:'.length, 'sha256:'.length + 12);
  const built = buildDatasetSnapshot({
    store,
    sourceBytes,
    normalizedDailyBars: document,
    core: {
      canonicalSymbol: `L3I5_${instrumentKey}`,
      providerId: 'MARKET_DATA_L3_I5_MATERIALIZER',
      providerSymbol: `L3I5_${instrumentKey}`,
      sourceFormat: 'MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1',
      adapterVersion: MATERIALIZER_VERSION,
      adapterOptions: {
        resolvedSeriesManifestId: sourceBundle.resolvedSeriesManifestId,
      },
      normalizerVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
      normalizationOptions: {
        rowSelection: 'PRESENT_ONLY',
        rowOrdering: 'SESSION_DATE_THEN_BAR_IDENTITY',
        numericEncoding: 'MARKET_DATA_REPLACEMENT_VALUES_ATOMS_V1',
      },
      canonicalSerializationVersion: 'CanonicalJSON/1',
      priceBasis: sourceBundle.priceBasis,
      corporateActionPolicyHash: sourceBundle.corporateActionRegistryManifestId,
      calendarId: sourceBundle.calendarRegistryManifestId,
      calendarVersion: 'MarketCalendarRegistryManifest/1',
      transformImplementationHash: materializationPolicyId,
    },
    record: {
      sourceAcquiredAt: null,
      ingestedIntoLabAt: sourceBundle.knowledgeCutoff,
      acquisitionMethod: 'L3_I5_RESOLVED_SERIES_MATERIALIZATION',
      acquisitionToolVersion: MATERIALIZER_VERSION,
      acquisitionRequestIdentity: {
        resolvedSeriesManifestId: sourceBundle.resolvedSeriesManifestId,
        materializationPolicyId,
        contributingRegistryPrefixId: sourceBundle.contributingRegistryPrefixId,
      },
      acquisitionEvidenceIds: [...sourceBundle.contributingAcquisitionRecordIds],
    },
  });

  const manifest = buildSnapshotDatasetManifest({
    store,
    snapshotCoreId: built.snapshotCore.objectId,
    snapshotRecordId: built.snapshotRecord.objectId,
    materializationVerificationIds: [],
    qualityAssessmentRecordIds: [],
    createdByVersion: MATERIALIZER_VERSION,
  });

  verifyDatasetSnapshot({ store, snapshotRecordId: built.snapshotRecord.objectId });
  verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: manifest.manifestId });

  return {
    snapshotRecordId: built.snapshotRecord.objectId,
    snapshotCoreId: built.snapshotCore.objectId,
    datasetSnapshotManifestId: manifest.manifestId,
  };
}

/**
 * Materialize one official L1 snapshot from a verified resolved series.
 * @param {unknown} input
 */
export function materializeMarketDataSnapshot(input) {
  const api = assertApiInput(input, [
    'ingestionRegistryManifestId', 'resolvedSeriesManifestId', 'materializationPolicyId',
  ]);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.ingestionRegistryManifestId, 'ingestionRegistryManifestId');
  assertCasId(api.resolvedSeriesManifestId, 'resolvedSeriesManifestId');
  assertCasId(api.materializationPolicyId, 'materializationPolicyId');

  verifyMarketDataResolvedSeries({
    store: api.store,
    resolvedSeriesManifestId: api.resolvedSeriesManifestId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });

  const { snapshotSourceBundleId } = buildMarketDataSnapshotSourceBundle({
    store: api.store,
    resolvedSeriesManifestId: api.resolvedSeriesManifestId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });
  const { snapshotSourceBundle } = verifyMarketDataSnapshotSourceBundle({
    store: api.store,
    snapshotSourceBundleId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });
  verifyMarketDataSnapshotMaterializationPolicy({
    store: api.store,
    materializationPolicyId: api.materializationPolicyId,
  });

  const { resolvedSeriesManifest: manifest } = verifyMarketDataResolvedSeriesManifest({
    store: api.store,
    resolvedSeriesManifestId: api.resolvedSeriesManifestId,
  });
  const projection = projectCanonicalRows(api.store, manifest, snapshotSourceBundle);
  const l1 = writeOfficialL1Snapshot(
    api.store, projection.document, snapshotSourceBundle, api.materializationPolicyId,
  );

  const report = deriveReportValue({
    snapshotSourceBundleId,
    materializationPolicyId: api.materializationPolicyId,
    resolvedSeriesManifestId: api.resolvedSeriesManifestId,
    datasetSnapshotManifestId: l1.datasetSnapshotManifestId,
    document: projection.document,
    presentEntryCount: projection.presentEntryCount,
    withdrawnEntryCount: projection.withdrawnEntryCount,
    movedToOtherSessionEntryCount: projection.movedToOtherSessionEntryCount,
  });
  const storedReport = putCanonicalL3(
    api.store, MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION, report,
  );
  verifyMaterializedMarketDataSnapshot({
    store: api.store,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
    materializationReportId: storedReport.objectId,
  });

  return {
    snapshotSourceBundleId,
    datasetSnapshotManifestId: l1.datasetSnapshotManifestId,
    materializationReportId: storedReport.objectId,
  };
}

/**
 * Full end-to-end verification: recompute rows and report, compare exactly.
 * @param {unknown} input
 */
export function verifyMaterializedMarketDataSnapshot(input) {
  const api = assertApiInput(input, ['ingestionRegistryManifestId', 'materializationReportId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.ingestionRegistryManifestId, 'ingestionRegistryManifestId');
  assertCasId(api.materializationReportId, 'materializationReportId');

  const rawReport = readTypedReference(
    api.store, api.materializationReportId,
    MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION, 'materialization report',
  );
  const storedReport = normalizeMarketDataSnapshotMaterializationReportV1(rawReport);

  const { snapshotSourceBundle, resolvedSeriesManifest: manifest } = verifyMarketDataSnapshotSourceBundle({
    store: api.store,
    snapshotSourceBundleId: storedReport.snapshotSourceBundleId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });
  if (snapshotSourceBundle.resolvedSeriesManifestId !== storedReport.resolvedSeriesManifestId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'materialization report resolvedSeriesManifestId diverges from the source bundle',
    );
  }
  verifyMarketDataSnapshotMaterializationPolicy({
    store: api.store,
    materializationPolicyId: storedReport.materializationPolicyId,
  });
  verifyMarketDataResolvedSeries({
    store: api.store,
    resolvedSeriesManifestId: storedReport.resolvedSeriesManifestId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });

  const projection = projectCanonicalRows(api.store, manifest, snapshotSourceBundle);

  const datasetManifest = verifySnapshotDatasetManifest({
    store: api.store,
    snapshotDatasetManifestId: storedReport.datasetSnapshotManifestId,
  });
  const snapshot = verifyDatasetSnapshot({
    store: api.store,
    snapshotRecordId: datasetManifest.manifest.snapshotRecordId,
  });
  if (!canonicalValuesEqual(snapshot.normalizedDailyBars, projection.document)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'L1 normalized snapshot content diverges from the recomputed PRESENT projection',
    );
  }
  const expectedSourceBytes = canonicalJsonBytes(projection.document);
  if (!Buffer.from(snapshot.sourceBytes).equals(expectedSourceBytes)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'L1 source bytes diverge from the recomputed PRESENT projection',
    );
  }

  const expectedReport = deriveReportValue({
    snapshotSourceBundleId: storedReport.snapshotSourceBundleId,
    materializationPolicyId: storedReport.materializationPolicyId,
    resolvedSeriesManifestId: storedReport.resolvedSeriesManifestId,
    datasetSnapshotManifestId: storedReport.datasetSnapshotManifestId,
    document: projection.document,
    presentEntryCount: projection.presentEntryCount,
    withdrawnEntryCount: projection.withdrawnEntryCount,
    movedToOtherSessionEntryCount: projection.movedToOtherSessionEntryCount,
  });
  if (!canonicalValuesEqual(storedReport, expectedReport)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'materialization report diverges from recomputation',
    );
  }

  return {
    materializationReportId: api.materializationReportId,
    materializationReport: storedReport,
    snapshotSourceBundleId: storedReport.snapshotSourceBundleId,
    datasetSnapshotManifestId: storedReport.datasetSnapshotManifestId,
    resolvedSeriesManifestId: storedReport.resolvedSeriesManifestId,
  };
}
