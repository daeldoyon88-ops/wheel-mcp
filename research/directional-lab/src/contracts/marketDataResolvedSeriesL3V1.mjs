/**
 * L3-I4 — MarketDataResolvedSeriesManifest/1 canonical shape.
 *
 * A resolved-series manifest is the provable point-in-time answer for one
 * ingestion lineage under one explicitly pinned ingestion registry chain:
 * which bar series was knowable at knowledgeCutoff. This module owns only the
 * closed canonical shape; resolution and store-backed verification live in
 * src/resolution/resolveMarketDataAsOfL3V1.mjs. No latest-wins rule, no CAS
 * order, no wall clock.
 */

import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertExactFields,
  assertPlainObject,
  assertSchemaVersion,
  assertSortedUniqueStrings,
  assertUtcInstant,
} from './marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
  MARKET_DATA_INGESTION_PRICE_BASES,
  MARKET_DATA_TEMPORAL_CAPABILITIES,
} from './marketDataIngestionRegistryL3V1.mjs';

export const MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION = 'MarketDataResolvedSeriesManifest/1';
export const MARKET_DATA_RESOLVED_SERIES_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
]);

export const MARKET_DATA_RESOLVED_BAR_DISPOSITIONS = Object.freeze([
  'MOVED_TO_OTHER_SESSION',
  'PRESENT',
  'WITHDRAWN',
]);

const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion',
  'contributingRegistryPrefixId',
  'ingestionLineageId',
  'knowledgeCutoff',
  'temporalCapability',
  'resolvedBarEntries',
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

const ENTRY_FIELDS = Object.freeze([
  'barIdentityId',
  'resolvedObservationId',
  'resolvedCorrectionTipId',
  'sessionDate',
  'disposition',
]);

/** @param {unknown} value @param {number} index */
function normalizeResolvedBarEntry(value, index) {
  const entry = assertPlainObject(value, `resolvedBarEntries[${index}]`);
  assertExactFields(entry, ENTRY_FIELDS);
  assertCasId(entry.barIdentityId, `resolvedBarEntries[${index}].barIdentityId`);
  assertCasId(entry.resolvedObservationId, `resolvedBarEntries[${index}].resolvedObservationId`, true);
  assertCasId(entry.resolvedCorrectionTipId, `resolvedBarEntries[${index}].resolvedCorrectionTipId`);
  assertCivilDate(entry.sessionDate, `resolvedBarEntries[${index}].sessionDate`);
  assertEnum(entry.disposition, MARKET_DATA_RESOLVED_BAR_DISPOSITIONS, `resolvedBarEntries[${index}].disposition`);
  if ((entry.disposition === 'PRESENT') !== (entry.resolvedObservationId !== null)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'resolvedObservationId must be non-null exactly for PRESENT dispositions',
      { index, disposition: entry.disposition },
    );
  }
  return {
    barIdentityId: entry.barIdentityId,
    resolvedObservationId: entry.resolvedObservationId,
    resolvedCorrectionTipId: entry.resolvedCorrectionTipId,
    sessionDate: entry.sessionDate,
    disposition: entry.disposition,
  };
}

/** @param {unknown} value */
export function normalizeMarketDataResolvedSeriesManifestV1(value) {
  const manifest = assertPlainObject(value, MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION);
  assertSchemaVersion(manifest, MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION);
  assertExactFields(manifest, MANIFEST_FIELDS);
  for (const field of [
    'contributingRegistryPrefixId', 'ingestionLineageId',
    'identityRegistryManifestId', 'calendarRegistryManifestId', 'corporateActionRegistryManifestId',
  ]) {
    assertCasId(manifest[field], field);
  }
  assertUtcInstant(manifest.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(manifest.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, 'temporalCapability');
  assertEnum(manifest.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  assertEnum(manifest.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS, 'corporateActionTreatment');

  if (!Array.isArray(manifest.resolvedBarEntries) || manifest.resolvedBarEntries.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'resolvedBarEntries must be a non-empty array');
  }
  const resolvedBarEntries = manifest.resolvedBarEntries.map(normalizeResolvedBarEntry);
  const seenBarIdentityIds = new Set();
  for (const entry of resolvedBarEntries) {
    if (seenBarIdentityIds.has(entry.barIdentityId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
        'resolvedBarEntries contains a duplicate barIdentityId',
        { barIdentityId: entry.barIdentityId },
      );
    }
    seenBarIdentityIds.add(entry.barIdentityId);
  }
  for (let i = 1; i < resolvedBarEntries.length; i += 1) {
    const previousKey = `${resolvedBarEntries[i - 1].sessionDate}\0${resolvedBarEntries[i - 1].barIdentityId}`;
    const currentKey = `${resolvedBarEntries[i].sessionDate}\0${resolvedBarEntries[i].barIdentityId}`;
    if (previousKey >= currentKey) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        'resolvedBarEntries must be sorted by sessionDate then barIdentityId',
        { index: i },
      );
    }
  }

  for (const [field, options] of [
    ['contributingIngestionManifestIds', { nonEmpty: true }],
    ['contributingObservationIds', { nonEmpty: true }],
    ['contributingCorrectionIds', { nonEmpty: true }],
    ['contributingAcquisitionRecordIds', { nonEmpty: true }],
    ['contributingSourceArtifactIds', {}],
  ]) {
    assertSortedUniqueStrings(manifest[field], field, options);
    for (let i = 0; i < manifest[field].length; i += 1) {
      assertCasId(manifest[field][i], `${field}[${i}]`);
    }
  }

  return {
    schemaVersion: MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
    contributingRegistryPrefixId: manifest.contributingRegistryPrefixId,
    ingestionLineageId: manifest.ingestionLineageId,
    knowledgeCutoff: manifest.knowledgeCutoff,
    temporalCapability: manifest.temporalCapability,
    resolvedBarEntries,
    contributingIngestionManifestIds: [...manifest.contributingIngestionManifestIds],
    contributingObservationIds: [...manifest.contributingObservationIds],
    contributingCorrectionIds: [...manifest.contributingCorrectionIds],
    contributingAcquisitionRecordIds: [...manifest.contributingAcquisitionRecordIds],
    contributingSourceArtifactIds: [...manifest.contributingSourceArtifactIds],
    identityRegistryManifestId: manifest.identityRegistryManifestId,
    calendarRegistryManifestId: manifest.calendarRegistryManifestId,
    corporateActionRegistryManifestId: manifest.corporateActionRegistryManifestId,
    priceBasis: manifest.priceBasis,
    corporateActionTreatment: manifest.corporateActionTreatment,
  };
}
