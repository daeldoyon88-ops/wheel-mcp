/**
 * L3-I5 — closed canonical shapes for official snapshot materialization.
 *
 * Three schemas close the provenance and result of projecting a verified
 * MarketDataResolvedSeriesManifest/1 into an official L1 dataset snapshot:
 *
 *   MarketDataSnapshotSourceBundle/1
 *   MarketDataSnapshotMaterializationPolicy/1
 *   MarketDataSnapshotMaterializationReport/1
 *
 * Plus the normalized row document stored under the L1 `normalized` namespace:
 *   MarketDataEodOhlcvCanonicalRows/1
 *
 * No wall clock, no network, no price transformation, no I6 bindings.
 */

import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertExactFields,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  assertSortedUniqueStrings,
  assertUtcInstant,
} from './marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
  MARKET_DATA_INGESTION_PRICE_BASES,
  MARKET_DATA_TEMPORAL_CAPABILITIES,
} from './marketDataIngestionRegistryL3V1.mjs';
import { normalizeMarketDataReplacementValuesV1 } from './marketDataCandidateL3V1.mjs';

export const MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION = 'MarketDataSnapshotSourceBundle/1';
export const MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION = 'MarketDataSnapshotMaterializationPolicy/1';
export const MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION = 'MarketDataSnapshotMaterializationReport/1';
export const MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION = 'MarketDataEodOhlcvCanonicalRows/1';

export const MARKET_DATA_SNAPSHOT_MATERIALIZATION_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
]);

/** Official first materialization format (policy enum, not a snapshots-namespace schema). */
export const MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1_FORMAT = 'MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1';

export const MARKET_DATA_SNAPSHOT_MATERIALIZATION_STATUSES = Object.freeze([
  'MATERIALIZED',
  'MATERIALIZED_EMPTY',
]);

export const MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES = Object.freeze({
  format: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1_FORMAT,
  rowSelection: 'PRESENT_ONLY',
  rowOrdering: 'SESSION_DATE_THEN_BAR_IDENTITY',
  duplicatePolicy: 'REJECT',
  withdrawnEntryPolicy: 'OMIT',
  movedEntryPolicy: 'OMIT_SOURCE_ENTRY',
  priceTransformation: 'NONE',
  corporateActionTransformation: 'NONE',
  serialization: 'CanonicalJSON/1',
  numericEncoding: 'MARKET_DATA_REPLACEMENT_VALUES_ATOMS_V1',
  nullPolicy: 'EXPLICIT_NULL_VOLUME_ALLOWED',
  lineEnding: 'LF',
  encoding: 'UTF-8',
});

const SOURCE_BUNDLE_FIELDS = Object.freeze([
  'schemaVersion',
  'resolvedSeriesManifestId',
  'contributingRegistryPrefixId',
  'ingestionLineageId',
  'knowledgeCutoff',
  'temporalCapability',
  'contributingIngestionManifestIds',
  'contributingObservationIds',
  'contributingCorrectionIds',
  'contributingAcquisitionRecordIds',
  'contributingSourceArtifactIds',
  'identityRegistryManifestId',
  'calendarRegistryManifestId',
  'corporateActionRegistryManifestId',
  'priceBasis',
  'corporateActionTreatment',
]);

const POLICY_FIELDS = Object.freeze([
  'schemaVersion',
  'format',
  'rowSelection',
  'rowOrdering',
  'duplicatePolicy',
  'withdrawnEntryPolicy',
  'movedEntryPolicy',
  'priceTransformation',
  'corporateActionTransformation',
  'serialization',
  'numericEncoding',
  'nullPolicy',
  'lineEnding',
  'encoding',
]);

const REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'snapshotSourceBundleId',
  'materializationPolicyId',
  'resolvedSeriesManifestId',
  'datasetSnapshotManifestId',
  'status',
  'rowCount',
  'presentEntryCount',
  'withdrawnEntryCount',
  'movedToOtherSessionEntryCount',
  'firstSessionDate',
  'lastSessionDate',
  'materializedObservationIds',
  'materializedCorrectionTipIds',
  'outputSchemaVersion',
]);

const ROWS_ROOT_FIELDS = Object.freeze(['schemaVersion', 'rows']);

const ROW_FIELDS = Object.freeze([
  'instrumentIdentityId',
  'barIdentityId',
  'sessionDate',
  'frequency',
  'currency',
  'openAtoms',
  'highAtoms',
  'lowAtoms',
  'closeAtoms',
  'priceScale',
  'volumeAtoms',
  'volumeScale',
  'priceBasis',
  'resolvedObservationId',
  'resolvedCorrectionTipId',
]);

/** @param {unknown} value */
export function normalizeMarketDataSnapshotSourceBundleV1(value) {
  const bundle = assertPlainObject(value, MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION);
  assertSchemaVersion(bundle, MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION);
  assertExactFields(bundle, SOURCE_BUNDLE_FIELDS);
  for (const field of [
    'resolvedSeriesManifestId', 'contributingRegistryPrefixId', 'ingestionLineageId',
    'identityRegistryManifestId', 'calendarRegistryManifestId', 'corporateActionRegistryManifestId',
  ]) {
    assertCasId(bundle[field], field);
  }
  assertUtcInstant(bundle.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(bundle.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, 'temporalCapability');
  assertEnum(bundle.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  assertEnum(bundle.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS, 'corporateActionTreatment');
  for (const [field, options] of [
    ['contributingIngestionManifestIds', { nonEmpty: true }],
    ['contributingObservationIds', { nonEmpty: true }],
    ['contributingCorrectionIds', { nonEmpty: true }],
    ['contributingAcquisitionRecordIds', { nonEmpty: true }],
    ['contributingSourceArtifactIds', {}],
  ]) {
    assertSortedUniqueStrings(bundle[field], field, options);
    for (let i = 0; i < bundle[field].length; i += 1) {
      assertCasId(bundle[field][i], `${field}[${i}]`);
    }
  }
  return {
    schemaVersion: MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
    resolvedSeriesManifestId: bundle.resolvedSeriesManifestId,
    contributingRegistryPrefixId: bundle.contributingRegistryPrefixId,
    ingestionLineageId: bundle.ingestionLineageId,
    knowledgeCutoff: bundle.knowledgeCutoff,
    temporalCapability: bundle.temporalCapability,
    contributingIngestionManifestIds: [...bundle.contributingIngestionManifestIds],
    contributingObservationIds: [...bundle.contributingObservationIds],
    contributingCorrectionIds: [...bundle.contributingCorrectionIds],
    contributingAcquisitionRecordIds: [...bundle.contributingAcquisitionRecordIds],
    contributingSourceArtifactIds: [...bundle.contributingSourceArtifactIds],
    identityRegistryManifestId: bundle.identityRegistryManifestId,
    calendarRegistryManifestId: bundle.calendarRegistryManifestId,
    corporateActionRegistryManifestId: bundle.corporateActionRegistryManifestId,
    priceBasis: bundle.priceBasis,
    corporateActionTreatment: bundle.corporateActionTreatment,
  };
}

/** @param {unknown} value */
export function normalizeMarketDataSnapshotMaterializationPolicyV1(value) {
  const policy = assertPlainObject(value, MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION);
  assertExactFields(policy, POLICY_FIELDS);
  const expected = MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_VALUES;
  for (const field of POLICY_FIELDS) {
    if (field === 'schemaVersion') continue;
    if (policy[field] !== expected[field]) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        `materialization policy field ${field} must be the closed V1 value`,
        { field, expected: expected[field], actual: policy[field] },
      );
    }
  }
  return {
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_POLICY_SCHEMA_VERSION,
    ...expected,
  };
}

/** @param {unknown} value @param {number} index */
function normalizeCanonicalRow(value, index) {
  const row = assertPlainObject(value, `rows[${index}]`);
  assertExactFields(row, ROW_FIELDS);
  assertCasId(row.instrumentIdentityId, `rows[${index}].instrumentIdentityId`);
  assertCasId(row.barIdentityId, `rows[${index}].barIdentityId`);
  assertCivilDate(row.sessionDate, `rows[${index}].sessionDate`);
  if (row.frequency !== 'DAILY_REGULAR_SESSION') {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `rows[${index}].frequency must be DAILY_REGULAR_SESSION`);
  }
  assertCasId(row.resolvedObservationId, `rows[${index}].resolvedObservationId`);
  assertCasId(row.resolvedCorrectionTipId, `rows[${index}].resolvedCorrectionTipId`);
  const values = normalizeMarketDataReplacementValuesV1({
    openAtoms: row.openAtoms,
    highAtoms: row.highAtoms,
    lowAtoms: row.lowAtoms,
    closeAtoms: row.closeAtoms,
    priceScale: row.priceScale,
    volumeAtoms: row.volumeAtoms,
    volumeScale: row.volumeScale,
    currency: row.currency,
    priceBasis: row.priceBasis,
  });
  return {
    instrumentIdentityId: row.instrumentIdentityId,
    barIdentityId: row.barIdentityId,
    sessionDate: row.sessionDate,
    frequency: row.frequency,
    currency: values.currency,
    openAtoms: values.openAtoms,
    highAtoms: values.highAtoms,
    lowAtoms: values.lowAtoms,
    closeAtoms: values.closeAtoms,
    priceScale: values.priceScale,
    volumeAtoms: values.volumeAtoms,
    volumeScale: values.volumeScale,
    priceBasis: values.priceBasis,
    resolvedObservationId: row.resolvedObservationId,
    resolvedCorrectionTipId: row.resolvedCorrectionTipId,
  };
}

/**
 * Official L1 normalized-namespace content for L3-I5 materialization.
 * Empty rows are allowed (MATERIALIZED_EMPTY). Ordering is sessionDate then
 * barIdentityId. Atom scales are preserved — never coerced to IEEE floats.
 * @param {unknown} value
 */
export function normalizeMarketDataEodOhlcvCanonicalRowsV1(value) {
  const root = assertPlainObject(value, MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION);
  assertSchemaVersion(root, MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION);
  assertExactFields(root, ROWS_ROOT_FIELDS);
  if (!Array.isArray(root.rows)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'rows must be an array');
  }
  const rows = root.rows.map(normalizeCanonicalRow);
  const seenBarIdentityIds = new Set();
  const seenSessionDates = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    if (seenBarIdentityIds.has(rows[i].barIdentityId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        'canonical rows contain a duplicate barIdentityId',
        { barIdentityId: rows[i].barIdentityId },
      );
    }
    seenBarIdentityIds.add(rows[i].barIdentityId);
    if (seenSessionDates.has(rows[i].sessionDate)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        'canonical rows contain a duplicate sessionDate under REJECT duplicatePolicy',
        { sessionDate: rows[i].sessionDate },
      );
    }
    seenSessionDates.add(rows[i].sessionDate);
  }
  for (let i = 1; i < rows.length; i += 1) {
    const previousKey = `${rows[i - 1].sessionDate}\0${rows[i - 1].barIdentityId}`;
    const currentKey = `${rows[i].sessionDate}\0${rows[i].barIdentityId}`;
    if (previousKey >= currentKey) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        'canonical rows must be sorted by sessionDate then barIdentityId',
        { index: i },
      );
    }
  }
  return {
    schemaVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
    rows,
  };
}

/** @param {unknown} value */
export function normalizeMarketDataSnapshotMaterializationReportV1(value) {
  const report = assertPlainObject(value, MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION);
  assertSchemaVersion(report, MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION);
  assertExactFields(report, REPORT_FIELDS);
  for (const field of [
    'snapshotSourceBundleId', 'materializationPolicyId', 'resolvedSeriesManifestId', 'datasetSnapshotManifestId',
  ]) {
    assertCasId(report[field], field);
  }
  assertEnum(report.status, MARKET_DATA_SNAPSHOT_MATERIALIZATION_STATUSES, 'status');
  assertSafeInteger(report.rowCount, 'rowCount', { nonNegative: true });
  assertSafeInteger(report.presentEntryCount, 'presentEntryCount', { nonNegative: true });
  assertSafeInteger(report.withdrawnEntryCount, 'withdrawnEntryCount', { nonNegative: true });
  assertSafeInteger(report.movedToOtherSessionEntryCount, 'movedToOtherSessionEntryCount', { nonNegative: true });
  if (report.firstSessionDate !== null) assertCivilDate(report.firstSessionDate, 'firstSessionDate');
  if (report.lastSessionDate !== null) assertCivilDate(report.lastSessionDate, 'lastSessionDate');
  if ((report.firstSessionDate === null) !== (report.lastSessionDate === null)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'firstSessionDate and lastSessionDate must both be null or both set');
  }
  if (report.firstSessionDate !== null && report.firstSessionDate > report.lastSessionDate) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'firstSessionDate must be <= lastSessionDate');
  }
  if (report.outputSchemaVersion !== MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'outputSchemaVersion must be MarketDataEodOhlcvCanonicalRows/1',
    );
  }
  assertSortedUniqueStrings(report.materializedObservationIds, 'materializedObservationIds');
  assertSortedUniqueStrings(report.materializedCorrectionTipIds, 'materializedCorrectionTipIds');
  for (let i = 0; i < report.materializedObservationIds.length; i += 1) {
    assertCasId(report.materializedObservationIds[i], `materializedObservationIds[${i}]`);
  }
  for (let i = 0; i < report.materializedCorrectionTipIds.length; i += 1) {
    assertCasId(report.materializedCorrectionTipIds[i], `materializedCorrectionTipIds[${i}]`);
  }
  if (report.status === 'MATERIALIZED_EMPTY') {
    if (report.rowCount !== 0 || report.materializedObservationIds.length !== 0
        || report.materializedCorrectionTipIds.length !== 0
        || report.firstSessionDate !== null) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'MATERIALIZED_EMPTY report must have zero rows and null date range');
    }
  } else if (report.rowCount === 0 || report.firstSessionDate === null) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'MATERIALIZED report requires at least one row and a date range');
  }
  if (report.rowCount !== report.materializedObservationIds.length
      || report.rowCount !== report.materializedCorrectionTipIds.length) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'rowCount must equal materializedObservationIds and materializedCorrectionTipIds lengths',
    );
  }
  return {
    schemaVersion: MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    snapshotSourceBundleId: report.snapshotSourceBundleId,
    materializationPolicyId: report.materializationPolicyId,
    resolvedSeriesManifestId: report.resolvedSeriesManifestId,
    datasetSnapshotManifestId: report.datasetSnapshotManifestId,
    status: report.status,
    rowCount: report.rowCount,
    presentEntryCount: report.presentEntryCount,
    withdrawnEntryCount: report.withdrawnEntryCount,
    movedToOtherSessionEntryCount: report.movedToOtherSessionEntryCount,
    firstSessionDate: report.firstSessionDate,
    lastSessionDate: report.lastSessionDate,
    materializedObservationIds: [...report.materializedObservationIds],
    materializedCorrectionTipIds: [...report.materializedCorrectionTipIds],
    outputSchemaVersion: MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_SCHEMA_VERSION,
  };
}
