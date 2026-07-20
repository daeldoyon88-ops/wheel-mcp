/**
 * L4A-B — closed canonical contracts for deterministic point-in-time volume,
 * participation and price-structure features. This layer is a separate
 * artefact from L4A-A: it references a verified L4A-A computation report and
 * never mutates MarketTechnicalFeatureRows/1, trains a model, produces a
 * score or recommendation, touches the scanner or calls the network.
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
  assertUtcInstant,
} from './marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
  MARKET_DATA_INGESTION_PRICE_BASES,
  MARKET_DATA_TEMPORAL_CAPABILITIES,
} from './marketDataIngestionRegistryL3V1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1,
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1,
  extractMarketVolumeStructureFeaturePolicyValuesV1,
} from './marketVolumeStructureFeaturePolicyValuesL4V1.mjs';

export {
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_NOT_CLOSED_V1,
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1,
  extractMarketVolumeStructureFeaturePolicyValuesV1,
  findClosedMarketVolumeStructureFeaturePolicyMismatchPathV1,
} from './marketVolumeStructureFeaturePolicyValuesL4V1.mjs';

export const MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION =
  'MarketVolumeStructureFeatureSourceBundle/1';
export const MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION =
  'MarketVolumeStructureFeatureComputationPolicy/1';
export const MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION =
  'MarketVolumeStructureFeatureComputationReport/1';
export const MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION =
  'MarketVolumeStructureFeatureRows/1';

export const MARKET_VOLUME_STRUCTURE_FEATURE_L4_SCHEMA_VERSIONS = Object.freeze([
  MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
]);

export const MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES = Object.freeze([
  'AVAILABLE',
  'INSUFFICIENT_HISTORY',
  'MISSING_INPUT',
  'DIVISION_BY_ZERO',
  'FLAT_RANGE',
  'ZERO_TOTAL_VOLUME',
  'NO_CONFIRMED_PIVOT',
  'NO_SUPPORT_LEVEL',
  'NO_RESISTANCE_LEVEL',
  'NO_ACTIVE_FIBONACCI_LEG',
  'NO_OPEN_GAP',
  'NO_LEVEL_TOUCH',
  'NO_FAILED_EVENT',
]);

export const MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS = Object.freeze({
  volumeParticipation: 'L4A-B1-VP/1',
  eodVolumeWeightedPrices: 'L4A-B1-VWAP/1',
  pivots: 'L4A-B2-PIVOTS/1',
  supportResistance: 'L4A-B2-SR/1',
  gapsBreakouts: 'L4A-B2-GB/1',
  congestion: 'L4A-B2-CONG/1',
  fibonacci: 'L4A-B2-FIB/1',
});

export const FIBONACCI_DIRECTIONS = Object.freeze([
  'BULLISH_RETRACEMENT',
  'BEARISH_RETRACEMENT',
]);

/**
 * Closed V1 policy. Ratios and thresholds are exact fixed-point values —
 * never authoritative IEEE-754 floats. The rolling and anchored EOD VWAP
 * values are approximations from daily OHLCV bars, not exchange intraday
 * VWAPs, and OBV / the A/D line are relative to the snapshot start.
 */
export const MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES =
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1;

export const VOLUME_PARTICIPATION_FEATURE_NAMES = Object.freeze([
  'volumeMean20Previous', 'volumeMean50Previous',
  'relativeVolume20', 'relativeVolume50', 'volumePercentile60Previous',
  'obv', 'obvDelta5', 'obvDelta20', 'obvDelta60',
  'moneyFlowMultiplier', 'moneyFlowVolume', 'accumulationDistributionLine',
  'adLineDelta20', 'chaikinMoneyFlow20', 'moneyFlowIndex14',
  'priceVolumeBullishConfirmation20', 'priceVolumeBearishConfirmation20',
  'bullishPriceVolumeDivergence20', 'bearishPriceVolumeDivergence20',
]);

export const EOD_VOLUME_WEIGHTED_PRICE_FEATURE_NAMES = Object.freeze([
  'eodVolumeWeightedAveragePrice20', 'eodVolumeWeightedAveragePrice60',
  'distanceToEodVwap20', 'distanceToEodVwap60',
  'anchoredEodVwapFromLastConfirmedSwingLow', 'distanceToAnchoredEodVwapFromSwingLow',
  'anchoredEodVwapFromLastConfirmedSwingHigh', 'distanceToAnchoredEodVwapFromSwingHigh',
]);

export const PIVOT_FEATURE_NAMES = Object.freeze([
  'lastConfirmedSwingHighPrice', 'lastConfirmedSwingHighPivotSessionDate',
  'lastConfirmedSwingHighConfirmedAtSessionDate', 'lastConfirmedSwingHighAgeSessions',
  'lastConfirmedSwingLowPrice', 'lastConfirmedSwingLowPivotSessionDate',
  'lastConfirmedSwingLowConfirmedAtSessionDate', 'lastConfirmedSwingLowAgeSessions',
]);

export const SUPPORT_RESISTANCE_FEATURE_NAMES = Object.freeze([
  'nearestSupportPrice', 'distanceToNearestSupport',
  'nearestSupportPivotSessionDate', 'nearestSupportConfirmedAtSessionDate',
  'nearestSupportAgeSessions', 'nearestSupportTouchCount120',
  'nearestSupportLastTouchSessionsAgo', 'supportPenetrationPct',
  'nearestResistancePrice', 'distanceToNearestResistance',
  'nearestResistancePivotSessionDate', 'nearestResistanceConfirmedAtSessionDate',
  'nearestResistanceAgeSessions', 'nearestResistanceTouchCount120',
  'nearestResistanceLastTouchSessionsAgo', 'resistancePenetrationPct',
]);

export const GAP_BREAKOUT_FEATURE_NAMES = Object.freeze([
  'breakoutAboveResistance', 'breakdownBelowSupport',
  'breakoutLevel', 'breakdownLevel',
  'volumeConfirmedBreakout', 'volumeConfirmedBreakdown',
  'failedBreakoutAboveResistanceWithin5', 'failedBreakdownBelowSupportWithin5',
  'failedEventAgeSessions', 'failedEventLevel',
  'nearestOpenGapBelowLower', 'nearestOpenGapBelowUpper',
  'nearestOpenGapBelowAgeSessions', 'distanceToNearestOpenGapBelow',
  'nearestOpenGapAboveLower', 'nearestOpenGapAboveUpper',
  'nearestOpenGapAboveAgeSessions', 'distanceToNearestOpenGapAbove',
]);

export const CONGESTION_FEATURE_NAMES = Object.freeze([
  'priceRange20Pct', 'priceRange60Pct', 'rangeCompression20Vs60',
  'directionalEfficiency20', 'congestionPosition20', 'isCongestion20',
]);

export const FIBONACCI_FEATURE_NAMES = Object.freeze([
  'fibonacciDirection',
  'fibonacciStartSessionDate', 'fibonacciStartConfirmedAtSessionDate', 'fibonacciStartPrice',
  'fibonacciEndSessionDate', 'fibonacciEndConfirmedAtSessionDate', 'fibonacciEndPrice',
  'fibonacci236', 'fibonacci382', 'fibonacci500', 'fibonacci618', 'fibonacci786',
  'distanceToFibonacci236', 'distanceToFibonacci382', 'distanceToFibonacci500',
  'distanceToFibonacci618', 'distanceToFibonacci786',
]);

const INTEGER_FEATURE_NAMES = new Set([
  'lastConfirmedSwingHighAgeSessions', 'lastConfirmedSwingLowAgeSessions',
  'nearestSupportAgeSessions', 'nearestSupportTouchCount120', 'nearestSupportLastTouchSessionsAgo',
  'nearestResistanceAgeSessions', 'nearestResistanceTouchCount120', 'nearestResistanceLastTouchSessionsAgo',
  'failedEventAgeSessions',
  'nearestOpenGapBelowAgeSessions', 'nearestOpenGapAboveAgeSessions',
]);
const BOOLEAN_FEATURE_NAMES = new Set([
  'priceVolumeBullishConfirmation20', 'priceVolumeBearishConfirmation20',
  'bullishPriceVolumeDivergence20', 'bearishPriceVolumeDivergence20',
  'breakoutAboveResistance', 'breakdownBelowSupport',
  'volumeConfirmedBreakout', 'volumeConfirmedBreakdown',
  'failedBreakoutAboveResistanceWithin5', 'failedBreakdownBelowSupportWithin5',
  'isCongestion20',
]);
const DATE_FEATURE_NAMES = new Set([
  'lastConfirmedSwingHighPivotSessionDate', 'lastConfirmedSwingHighConfirmedAtSessionDate',
  'lastConfirmedSwingLowPivotSessionDate', 'lastConfirmedSwingLowConfirmedAtSessionDate',
  'nearestSupportPivotSessionDate', 'nearestSupportConfirmedAtSessionDate',
  'nearestResistancePivotSessionDate', 'nearestResistanceConfirmedAtSessionDate',
  'fibonacciStartSessionDate', 'fibonacciStartConfirmedAtSessionDate',
  'fibonacciEndSessionDate', 'fibonacciEndConfirmedAtSessionDate',
]);
const ENUM_FEATURE_VALUES = new Map([
  ['fibonacciDirection', FIBONACCI_DIRECTIONS],
]);

const SOURCE_BUNDLE_FIELDS = Object.freeze([
  'schemaVersion',
  'technicalFeatureComputationReportId', 'technicalFeatureRowsId',
  'technicalFeatureSourceBundleId', 'technicalFeatureComputationPolicyId',
  'subjectBindingRegistryManifestId', 'subjectBindingId',
  'datasetSnapshotManifestId', 'normalizedMarketDataObjectId',
  'knowledgeCutoff', 'temporalCapability', 'priceBasis', 'corporateActionTreatment',
]);
const POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES),
]);
const ROWS_FIELDS = Object.freeze(['schemaVersion', 'rows']);
const ROW_FIELDS = Object.freeze([
  'sessionDate', 'subjectBarIdentityId', 'subjectResolvedObservationId',
  'sourceBindingId', 'technicalFeatureRowsId', 'features', 'availability',
]);
const FAMILY_FIELDS = Object.freeze([
  'volumeParticipation', 'eodVolumeWeightedPrices', 'pivots',
  'supportResistance', 'gapsBreakouts', 'congestion', 'fibonacci',
]);
const FAMILY_NAME_LISTS = Object.freeze([
  ['volumeParticipation', VOLUME_PARTICIPATION_FEATURE_NAMES],
  ['eodVolumeWeightedPrices', EOD_VOLUME_WEIGHTED_PRICE_FEATURE_NAMES],
  ['pivots', PIVOT_FEATURE_NAMES],
  ['supportResistance', SUPPORT_RESISTANCE_FEATURE_NAMES],
  ['gapsBreakouts', GAP_BREAKOUT_FEATURE_NAMES],
  ['congestion', CONGESTION_FEATURE_NAMES],
  ['fibonacci', FIBONACCI_FEATURE_NAMES],
]);
const REPORT_FIELDS = Object.freeze([
  'schemaVersion',
  'volumeStructureFeatureSourceBundleId', 'volumeStructureFeatureComputationPolicyId',
  'volumeStructureFeatureRowsId',
  'technicalFeatureComputationReportId', 'technicalFeatureRowsId',
  'subjectBindingId', 'datasetSnapshotManifestId',
  'rowCount', 'firstSessionDate', 'lastSessionDate',
  'featureSchemaVersion', 'featureFamilyVersions', 'availabilityCounts',
  'confirmedPivotCount', 'confirmedSwingHighCount', 'confirmedSwingLowCount',
  'detectedGapCount', 'openGapCount',
]);

/** Rebuild a mutable canonical copy of a closed policy value. */
function copyClosedValue(value) {
  if (Array.isArray(value)) return value.map(copyClosedValue);
  if (value !== null && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = copyClosedValue(value[key]);
    return copy;
  }
  return value;
}

/** @param {unknown} value */
export function normalizeMarketVolumeStructureFeatureSourceBundleV1(value) {
  const bundle = assertPlainObject(value, MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION);
  assertSchemaVersion(bundle, MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION);
  assertExactFields(bundle, SOURCE_BUNDLE_FIELDS);
  for (const field of [
    'technicalFeatureComputationReportId', 'technicalFeatureRowsId',
    'technicalFeatureSourceBundleId', 'technicalFeatureComputationPolicyId',
    'subjectBindingRegistryManifestId', 'subjectBindingId',
    'datasetSnapshotManifestId', 'normalizedMarketDataObjectId',
  ]) assertCasId(bundle[field], field);
  assertUtcInstant(bundle.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(bundle.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, 'temporalCapability');
  assertEnum(bundle.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  assertEnum(
    bundle.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
    'corporateActionTreatment',
  );
  return {
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    technicalFeatureComputationReportId: bundle.technicalFeatureComputationReportId,
    technicalFeatureRowsId: bundle.technicalFeatureRowsId,
    technicalFeatureSourceBundleId: bundle.technicalFeatureSourceBundleId,
    technicalFeatureComputationPolicyId: bundle.technicalFeatureComputationPolicyId,
    subjectBindingRegistryManifestId: bundle.subjectBindingRegistryManifestId,
    subjectBindingId: bundle.subjectBindingId,
    datasetSnapshotManifestId: bundle.datasetSnapshotManifestId,
    normalizedMarketDataObjectId: bundle.normalizedMarketDataObjectId,
    knowledgeCutoff: bundle.knowledgeCutoff,
    temporalCapability: bundle.temporalCapability,
    priceBasis: bundle.priceBasis,
    corporateActionTreatment: bundle.corporateActionTreatment,
  };
}

/** @param {unknown} value */
export function normalizeMarketVolumeStructureFeatureComputationPolicyV1(value) {
  const policy = assertPlainObject(value, MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION);
  assertExactFields(policy, POLICY_FIELDS);
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(
    extractMarketVolumeStructureFeaturePolicyValuesV1(policy),
  );
  const normalized = { schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION };
  for (const field of Object.keys(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES)) {
    normalized[field] = copyClosedValue(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES[field]);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
function normalizeFixedPoint12(value, label) {
  const fixed = assertPlainObject(value, label);
  assertExactFields(fixed, ['atoms', 'scale']);
  if (typeof fixed.atoms !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(fixed.atoms) || fixed.atoms === '-0') {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label}.atoms must be a canonical signed integer string`);
  }
  if (fixed.scale !== 12) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label}.scale must equal 12`);
  }
  return { atoms: fixed.atoms, scale: 12 };
}

/** @param {unknown} value @param {unknown} availability @param {string} name @param {string} label */
function normalizeFeatureValue(value, availability, name, label) {
  assertEnum(availability, MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES, `${label}.availability`);
  if ((value !== null) !== (availability === 'AVAILABLE')) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID', `${label} must be non-null exactly when availability is AVAILABLE`,
    );
  }
  if (value === null) return null;
  if (INTEGER_FEATURE_NAMES.has(name)) {
    assertSafeInteger(value, label, { nonNegative: true });
    return value;
  }
  if (BOOLEAN_FEATURE_NAMES.has(name)) {
    if (typeof value !== 'boolean') {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be boolean`);
    }
    return value;
  }
  if (DATE_FEATURE_NAMES.has(name)) {
    assertCivilDate(value, label);
    return value;
  }
  const allowedEnum = ENUM_FEATURE_VALUES.get(name);
  if (allowedEnum) {
    assertEnum(value, allowedEnum, label);
    return value;
  }
  return normalizeFixedPoint12(value, label);
}

/** @param {unknown} values @param {unknown} availability @param {readonly string[]} names @param {string} label */
function normalizeFeatureGroup(values, availability, names, label) {
  const group = assertPlainObject(values, label);
  const reasons = assertPlainObject(availability, `${label}Availability`);
  assertExactFields(group, names);
  assertExactFields(reasons, names);
  const normalizedValues = {};
  const normalizedReasons = {};
  for (const name of names) {
    normalizedReasons[name] = reasons[name];
    normalizedValues[name] = normalizeFeatureValue(group[name], reasons[name], name, `${label}.${name}`);
  }
  return { values: normalizedValues, availability: normalizedReasons };
}

/** @param {unknown} value @param {number} index */
function normalizeFeatureRow(value, index) {
  const row = assertPlainObject(value, `rows[${index}]`);
  assertExactFields(row, ROW_FIELDS);
  assertCivilDate(row.sessionDate, `rows[${index}].sessionDate`);
  assertCasId(row.subjectBarIdentityId, `rows[${index}].subjectBarIdentityId`);
  assertCasId(row.subjectResolvedObservationId, `rows[${index}].subjectResolvedObservationId`);
  assertCasId(row.sourceBindingId, `rows[${index}].sourceBindingId`);
  assertCasId(row.technicalFeatureRowsId, `rows[${index}].technicalFeatureRowsId`);
  const features = assertPlainObject(row.features, `rows[${index}].features`);
  const availability = assertPlainObject(row.availability, `rows[${index}].availability`);
  assertExactFields(features, FAMILY_FIELDS);
  assertExactFields(availability, FAMILY_FIELDS);
  const resultFeatures = {};
  const resultAvailability = {};
  for (const [family, names] of FAMILY_NAME_LISTS) {
    const normalized = normalizeFeatureGroup(
      features[family], availability[family], names, `features.${family}`,
    );
    resultFeatures[family] = normalized.values;
    resultAvailability[family] = normalized.availability;
  }
  return {
    sessionDate: row.sessionDate,
    subjectBarIdentityId: row.subjectBarIdentityId,
    subjectResolvedObservationId: row.subjectResolvedObservationId,
    sourceBindingId: row.sourceBindingId,
    technicalFeatureRowsId: row.technicalFeatureRowsId,
    features: resultFeatures,
    availability: resultAvailability,
  };
}

/** @param {unknown} value */
export function normalizeMarketVolumeStructureFeatureRowsV1(value) {
  const root = assertPlainObject(value, MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION);
  assertSchemaVersion(root, MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION);
  assertExactFields(root, ROWS_FIELDS);
  if (!Array.isArray(root.rows)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'rows must be an array');
  }
  const rows = root.rows.map(normalizeFeatureRow);
  const seenDates = new Set();
  const seenBars = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (seenDates.has(row.sessionDate) || seenBars.has(row.subjectBarIdentityId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID', 'feature rows contain duplicate sessionDate or bar identity',
      );
    }
    seenDates.add(row.sessionDate);
    seenBars.add(row.subjectBarIdentityId);
    if (index > 0) {
      const previous = rows[index - 1];
      const previousKey = `${previous.sessionDate}\0${previous.subjectBarIdentityId}`;
      const currentKey = `${row.sessionDate}\0${row.subjectBarIdentityId}`;
      if (previousKey >= currentKey) {
        throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'feature rows must use canonical ordering');
      }
    }
    if (row.technicalFeatureRowsId !== rows[0].technicalFeatureRowsId
        || row.sourceBindingId !== rows[0].sourceBindingId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID', 'feature rows must reference a single L4A-A rows object and binding',
      );
    }
  }
  return { schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION, rows };
}

/** @param {unknown} value */
function normalizeFamilyVersions(value) {
  const versions = assertPlainObject(value, 'featureFamilyVersions');
  assertExactFields(versions, Object.keys(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS));
  for (const [family, expected] of Object.entries(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS)) {
    if (versions[family] !== expected) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${family} feature family version is invalid`);
    }
  }
  return { ...MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS };
}

/** @param {unknown} value */
function normalizeAvailabilityCounts(value) {
  const counts = assertPlainObject(value, 'availabilityCounts');
  assertExactFields(counts, MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES);
  const normalized = {};
  for (const code of MARKET_VOLUME_STRUCTURE_AVAILABILITY_CODES) {
    assertSafeInteger(counts[code], `availabilityCounts.${code}`, { nonNegative: true });
    normalized[code] = counts[code];
  }
  return normalized;
}

/** @param {unknown} value */
export function normalizeMarketVolumeStructureFeatureComputationReportV1(value) {
  const report = assertPlainObject(value, MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION);
  assertSchemaVersion(report, MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION);
  assertExactFields(report, REPORT_FIELDS);
  for (const field of [
    'volumeStructureFeatureSourceBundleId', 'volumeStructureFeatureComputationPolicyId',
    'volumeStructureFeatureRowsId', 'technicalFeatureComputationReportId',
    'technicalFeatureRowsId', 'subjectBindingId', 'datasetSnapshotManifestId',
  ]) assertCasId(report[field], field);
  assertSafeInteger(report.rowCount, 'rowCount', { nonNegative: true });
  if (report.firstSessionDate !== null) assertCivilDate(report.firstSessionDate, 'firstSessionDate');
  if (report.lastSessionDate !== null) assertCivilDate(report.lastSessionDate, 'lastSessionDate');
  if ((report.firstSessionDate === null) !== (report.lastSessionDate === null)
      || (report.rowCount === 0) !== (report.firstSessionDate === null)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'report date range must match rowCount');
  }
  if (report.firstSessionDate !== null && report.firstSessionDate > report.lastSessionDate) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'report date range is reversed');
  }
  if (report.featureSchemaVersion !== MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'featureSchemaVersion is invalid');
  }
  for (const field of [
    'confirmedPivotCount', 'confirmedSwingHighCount', 'confirmedSwingLowCount',
    'detectedGapCount', 'openGapCount',
  ]) assertSafeInteger(report[field], field, { nonNegative: true });
  if (report.confirmedPivotCount !== report.confirmedSwingHighCount + report.confirmedSwingLowCount) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'confirmed pivot counts are inconsistent');
  }
  if (report.openGapCount > report.detectedGapCount) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'open gap count exceeds detected gap count');
  }
  return {
    schemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    volumeStructureFeatureSourceBundleId: report.volumeStructureFeatureSourceBundleId,
    volumeStructureFeatureComputationPolicyId: report.volumeStructureFeatureComputationPolicyId,
    volumeStructureFeatureRowsId: report.volumeStructureFeatureRowsId,
    technicalFeatureComputationReportId: report.technicalFeatureComputationReportId,
    technicalFeatureRowsId: report.technicalFeatureRowsId,
    subjectBindingId: report.subjectBindingId,
    datasetSnapshotManifestId: report.datasetSnapshotManifestId,
    rowCount: report.rowCount,
    firstSessionDate: report.firstSessionDate,
    lastSessionDate: report.lastSessionDate,
    featureSchemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    featureFamilyVersions: normalizeFamilyVersions(report.featureFamilyVersions),
    availabilityCounts: normalizeAvailabilityCounts(report.availabilityCounts),
    confirmedPivotCount: report.confirmedPivotCount,
    confirmedSwingHighCount: report.confirmedSwingHighCount,
    confirmedSwingLowCount: report.confirmedSwingLowCount,
    detectedGapCount: report.detectedGapCount,
    openGapCount: report.openGapCount,
  };
}
