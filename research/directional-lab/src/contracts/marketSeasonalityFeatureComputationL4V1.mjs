/** Closed L4A-C1 contracts. No report/publication contract is introduced here. */

import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
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
  MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1,
  assertClosedMarketSeasonalityFeaturePolicyValuesV1,
  extractMarketSeasonalityFeaturePolicyValuesV1,
} from './marketSeasonalityFeaturePolicyValuesL4V1.mjs';

export {
  MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1,
  MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1,
  assertClosedMarketSeasonalityFeaturePolicyValuesV1,
  extractMarketSeasonalityFeaturePolicyValuesV1,
  findClosedMarketSeasonalityFeaturePolicyMismatchPathV1,
} from './marketSeasonalityFeaturePolicyValuesL4V1.mjs';

export const MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION =
  'MarketSeasonalityFeatureSourceBundle/1';
export const MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION =
  'MarketSeasonalityFeatureComputationPolicy/1';
export const MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION = 'MarketSeasonalityFeatureRows/1';
export const MARKET_SEASONALITY_OCCURRENCE_IDENTITY_SCHEMA_VERSION =
  'MarketSeasonalityOccurrenceIdentity/1';

export const MARKET_SEASONALITY_FEATURE_L4_SCHEMA_VERSIONS = Object.freeze([
  MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
]);

export const MARKET_SEASONALITY_PRIMARY_AVAILABILITY_REASONS = Object.freeze([
  'PRICE_BASIS_UNAVAILABLE',
  'CALENDAR_ALIGNMENT_UNAVAILABLE',
  'NO_ELIGIBLE_OCCURRENCE',
  'INSUFFICIENT_HISTORY',
  'MINIMUM_SAMPLE_NOT_MET',
  'AVAILABLE',
]);

export const MARKET_SEASONALITY_CURRENT_WINDOW_STATUSES = Object.freeze([
  'NOT_STARTED', 'IN_PROGRESS', 'COMPLETE_AS_OF_T', 'UNAVAILABLE',
]);

export const MARKET_SEASONALITY_CURRENT_AVAILABILITY_REASONS = Object.freeze([
  'FUTURE_WINDOW', 'PARTIAL_WINDOW', 'AVAILABLE', 'MISSING_INPUT',
  'CALENDAR_ALIGNMENT_UNAVAILABLE', 'DIVISION_BY_ZERO',
]);

export const MARKET_SEASONALITY_FEATURE_POLICY_VALUES =
  MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1;

const SOURCE_BUNDLE_FIELDS = Object.freeze([
  'schemaVersion', 'subjectBindingRegistryManifestId', 'subjectBindingId',
  'datasetSnapshotManifestId', 'normalizedMarketDataObjectId', 'knowledgeCutoff',
  'temporalCapability', 'priceBasis', 'corporateActionTreatment', 'instrumentIdentityId',
  'calendarRegistryManifestId', 'implementationManifestId',
]);
const POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1),
]);
const ROWS_FIELDS = Object.freeze(['schemaVersion', 'rows']);
const ROW_FIELDS = Object.freeze([
  'sourceBundleId', 'computationPolicyId', 'datasetSnapshotBindingId',
  'instrumentIdentityId', 'sessionDate', 'subjectBarIdentityId',
  'subjectResolvedObservationId', 'features', 'availability',
]);
const HORIZON_WINDOW_FIELDS = Object.freeze([
  'horizonYears', 'forwardSessionCount', 'occurrenceCount', 'distinctYearCount',
  'bullishCount', 'bearishCount', 'flatCount', 'bullishRate', 'bearishRate',
  'meanReturn', 'medianReturn', 'minimumReturn', 'maximumReturn', 'returnStdSample',
  'lowerQuantile25', 'upperQuantile75', 'medianMaxAdverseExcursion',
  'medianMaxFavorableExcursion', 'primaryAvailabilityReason', 'diagnostics',
]);
const DIAGNOSTIC_FIELDS = Object.freeze([
  'candidateYearCount', 'calendarAlignmentUnavailableCount', 'lookaheadRejectedCount',
  'missingInputCount', 'divisionByZeroCount', 'rawHistoryCoverageComplete',
]);
const CURRENT_WINDOW_FIELDS = Object.freeze([
  'forwardSessionCount', 'status', 'anchorCivilDate', 'startSessionDate',
  'expectedEndSessionDate', 'sessionsElapsed', 'sessionsRemaining', 'returnToDate',
  'maxAdverseExcursionToDate', 'maxFavorableExcursionToDate', 'availabilityReason',
]);

function keyLabel(key) {
  if (typeof key === 'string') return key;
  const global = Symbol.keyFor(key);
  if (global !== undefined) return `Symbol.for(${JSON.stringify(global)})`;
  return key.description === undefined ? 'Symbol()' : `Symbol(${key.description})`;
}

/** Closed record gate: rejects Symbols, non-enumerable fields and accessors. */
function closedRecord(value, fields, label, code = 'MARKET_DATA_SEASONALITY_INPUT_INVALID') {
  const record = assertPlainObject(value, label);
  const allowed = new Set(fields);
  for (const field of [...fields].sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (descriptor === undefined || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
      throw new MarketDataL3Error(code, `${label}.${field} must be an own enumerable data property`);
    }
  }
  const extras = Reflect.ownKeys(record).filter((key) => !allowed.has(key))
    .sort((left, right) => keyLabel(left).localeCompare(keyLabel(right)));
  if (extras.length > 0) {
    throw new MarketDataL3Error(code, `${label} contains unknown field ${keyLabel(extras[0])}`);
  }
  return record;
}

function normalizeFixed12(value, label, nullable = false) {
  if (value === null && nullable) return null;
  const fixed = closedRecord(value, ['atoms', 'scale'], label);
  if (typeof fixed.atoms !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(fixed.atoms)
      || fixed.atoms === '-0') {
    throw new MarketDataL3Error(
      'MARKET_DATA_SEASONALITY_INPUT_INVALID', `${label}.atoms must be a canonical integer string`,
    );
  }
  if (fixed.scale !== 12) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SEASONALITY_INPUT_INVALID', `${label}.scale must equal 12`,
    );
  }
  return { atoms: fixed.atoms, scale: 12 };
}

export function normalizeMarketSeasonalityFeatureSourceBundleV1(value) {
  const bundle = closedRecord(
    value, SOURCE_BUNDLE_FIELDS, MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    'MARKET_DATA_SEASONALITY_SOURCE_BUNDLE_INVALID',
  );
  assertSchemaVersion(bundle, MARKET_SEASONALITY_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION);
  for (const field of [
    'subjectBindingRegistryManifestId', 'subjectBindingId', 'datasetSnapshotManifestId',
    'normalizedMarketDataObjectId', 'instrumentIdentityId', 'calendarRegistryManifestId',
    'implementationManifestId',
  ]) assertCasId(bundle[field], field);
  assertUtcInstant(bundle.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(bundle.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, 'temporalCapability');
  assertEnum(bundle.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  assertEnum(
    bundle.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
    'corporateActionTreatment',
  );
  return Object.fromEntries(SOURCE_BUNDLE_FIELDS.map((field) => [field, bundle[field]]));
}

function copyClosed(value) {
  if (Array.isArray(value)) return value.map(copyClosed);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, copyClosed(value[key])]));
  }
  return value;
}

export function normalizeMarketSeasonalityFeatureComputationPolicyV1(value) {
  const policy = closedRecord(
    value, POLICY_FIELDS, MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    'MARKET_DATA_SEASONALITY_POLICY_NOT_CLOSED_V1',
  );
  assertSchemaVersion(policy, MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION);
  assertClosedMarketSeasonalityFeaturePolicyValuesV1(
    extractMarketSeasonalityFeaturePolicyValuesV1(policy),
  );
  const normalized = { schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION };
  for (const field of Object.keys(MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1)) {
    normalized[field] = copyClosed(MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1[field]);
  }
  return normalized;
}

function normalizeDiagnostics(value, label) {
  const diagnostics = closedRecord(value, DIAGNOSTIC_FIELDS, label);
  for (const field of DIAGNOSTIC_FIELDS) {
    if (field === 'rawHistoryCoverageComplete') {
      if (typeof diagnostics[field] !== 'boolean') {
        throw new MarketDataL3Error('MARKET_DATA_SEASONALITY_INPUT_INVALID', `${label}.${field} must be boolean`);
      }
    } else assertSafeInteger(diagnostics[field], `${label}.${field}`, { nonNegative: true });
  }
  return Object.fromEntries(DIAGNOSTIC_FIELDS.map((field) => [field, diagnostics[field]]));
}

function normalizeHorizonWindow(value, index) {
  const label = `horizonWindows[${index}]`;
  const window = closedRecord(value, HORIZON_WINDOW_FIELDS, label);
  assertSafeInteger(window.horizonYears, `${label}.horizonYears`, { positive: true });
  assertSafeInteger(window.forwardSessionCount, `${label}.forwardSessionCount`, { positive: true });
  for (const field of [
    'occurrenceCount', 'distinctYearCount', 'bullishCount', 'bearishCount', 'flatCount',
  ]) assertSafeInteger(window[field], `${label}.${field}`, { nonNegative: true });
  if (window.distinctYearCount > window.occurrenceCount
      || window.occurrenceCount > window.horizonYears
      || window.bullishCount + window.bearishCount + window.flatCount !== window.occurrenceCount) {
    throw new MarketDataL3Error('MARKET_DATA_SEASONALITY_INPUT_INVALID', `${label} counts are inconsistent`);
  }
  const fixedFields = [
    'bullishRate', 'bearishRate', 'meanReturn', 'medianReturn', 'minimumReturn',
    'maximumReturn', 'returnStdSample', 'lowerQuantile25', 'upperQuantile75',
    'medianMaxAdverseExcursion', 'medianMaxFavorableExcursion',
  ];
  const normalized = {
    horizonYears: window.horizonYears,
    forwardSessionCount: window.forwardSessionCount,
    occurrenceCount: window.occurrenceCount,
    distinctYearCount: window.distinctYearCount,
    bullishCount: window.bullishCount,
    bearishCount: window.bearishCount,
    flatCount: window.flatCount,
  };
  for (const field of fixedFields) normalized[field] = normalizeFixed12(window[field], `${label}.${field}`, true);
  if (window.occurrenceCount === 0 && fixedFields.some((field) => normalized[field] !== null)) {
    throw new MarketDataL3Error('MARKET_DATA_SEASONALITY_INPUT_INVALID', `${label} empty sample must have null statistics`);
  }
  assertEnum(
    window.primaryAvailabilityReason, MARKET_SEASONALITY_PRIMARY_AVAILABILITY_REASONS,
    `${label}.primaryAvailabilityReason`,
  );
  return {
    ...normalized,
    primaryAvailabilityReason: window.primaryAvailabilityReason,
    diagnostics: normalizeDiagnostics(window.diagnostics, `${label}.diagnostics`),
  };
}

function normalizeCurrentWindow(value, index) {
  const label = `currentWindows[${index}]`;
  const window = closedRecord(value, CURRENT_WINDOW_FIELDS, label);
  assertSafeInteger(window.forwardSessionCount, `${label}.forwardSessionCount`, { positive: true });
  assertEnum(window.status, MARKET_SEASONALITY_CURRENT_WINDOW_STATUSES, `${label}.status`);
  assertCivilDate(window.anchorCivilDate, `${label}.anchorCivilDate`);
  for (const field of ['startSessionDate', 'expectedEndSessionDate']) {
    if (window[field] !== null) assertCivilDate(window[field], `${label}.${field}`);
  }
  for (const field of ['sessionsElapsed', 'sessionsRemaining']) {
    if (window[field] !== null) assertSafeInteger(window[field], `${label}.${field}`, { nonNegative: true });
  }
  assertEnum(
    window.availabilityReason, MARKET_SEASONALITY_CURRENT_AVAILABILITY_REASONS,
    `${label}.availabilityReason`,
  );
  return {
    forwardSessionCount: window.forwardSessionCount,
    status: window.status,
    anchorCivilDate: window.anchorCivilDate,
    startSessionDate: window.startSessionDate,
    expectedEndSessionDate: window.expectedEndSessionDate,
    sessionsElapsed: window.sessionsElapsed,
    sessionsRemaining: window.sessionsRemaining,
    returnToDate: normalizeFixed12(window.returnToDate, `${label}.returnToDate`, true),
    maxAdverseExcursionToDate: normalizeFixed12(
      window.maxAdverseExcursionToDate, `${label}.maxAdverseExcursionToDate`, true,
    ),
    maxFavorableExcursionToDate: normalizeFixed12(
      window.maxFavorableExcursionToDate, `${label}.maxFavorableExcursionToDate`, true,
    ),
    availabilityReason: window.availabilityReason,
  };
}

function normalizeSeasonalityFeatures(value) {
  const features = closedRecord(value, ['seasonality'], 'features');
  const seasonality = closedRecord(
    features.seasonality, ['horizonWindows', 'currentWindows'], 'features.seasonality',
  );
  if (!Array.isArray(seasonality.horizonWindows) || !Array.isArray(seasonality.currentWindows)) {
    throw new MarketDataL3Error('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'seasonality windows must be arrays');
  }
  const horizonWindows = seasonality.horizonWindows.map(normalizeHorizonWindow);
  const currentWindows = seasonality.currentWindows.map(normalizeCurrentWindow);
  const expectedPairs = MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1.horizons.flatMap(
    (horizonYears) => MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1.forwardSessionCounts
      .map((forwardSessionCount) => `${horizonYears}\0${forwardSessionCount}`),
  );
  const actualPairs = horizonWindows.map((window) => `${window.horizonYears}\0${window.forwardSessionCount}`);
  if (expectedPairs.length !== actualPairs.length
      || expectedPairs.some((pair, index) => pair !== actualPairs[index])) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SEASONALITY_INPUT_INVALID', 'horizonWindows must use canonical V1 ordering',
    );
  }
  const actualCurrent = currentWindows.map((window) => window.forwardSessionCount);
  const expectedCurrent = MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1.forwardSessionCounts;
  if (actualCurrent.length !== expectedCurrent.length
      || expectedCurrent.some((count, index) => count !== actualCurrent[index])) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SEASONALITY_INPUT_INVALID', 'currentWindows must use canonical V1 ordering',
    );
  }
  return { seasonality: { horizonWindows, currentWindows } };
}

function normalizeAvailability(value, horizonWindows) {
  const availability = closedRecord(
    value, ['availableHorizonWindowCount', 'unavailableHorizonWindowCount'], 'availability',
  );
  for (const field of ['availableHorizonWindowCount', 'unavailableHorizonWindowCount']) {
    assertSafeInteger(availability[field], `availability.${field}`, { nonNegative: true });
  }
  const available = horizonWindows.filter((window) => window.primaryAvailabilityReason === 'AVAILABLE').length;
  if (availability.availableHorizonWindowCount !== available
      || availability.unavailableHorizonWindowCount !== horizonWindows.length - available) {
    throw new MarketDataL3Error('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'row availability counts are inconsistent');
  }
  return { ...availability };
}

function normalizeRow(value, index) {
  const label = `rows[${index}]`;
  const row = closedRecord(value, ROW_FIELDS, label);
  for (const field of [
    'sourceBundleId', 'computationPolicyId', 'datasetSnapshotBindingId',
    'instrumentIdentityId', 'subjectBarIdentityId', 'subjectResolvedObservationId',
  ]) assertCasId(row[field], `${label}.${field}`);
  assertCivilDate(row.sessionDate, `${label}.sessionDate`);
  const features = normalizeSeasonalityFeatures(row.features);
  return {
    sourceBundleId: row.sourceBundleId,
    computationPolicyId: row.computationPolicyId,
    datasetSnapshotBindingId: row.datasetSnapshotBindingId,
    instrumentIdentityId: row.instrumentIdentityId,
    sessionDate: row.sessionDate,
    subjectBarIdentityId: row.subjectBarIdentityId,
    subjectResolvedObservationId: row.subjectResolvedObservationId,
    features,
    availability: normalizeAvailability(row.availability, features.seasonality.horizonWindows),
  };
}

export function normalizeMarketSeasonalityFeatureRowsV1(value) {
  const root = closedRecord(value, ROWS_FIELDS, MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION);
  assertSchemaVersion(root, MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION);
  if (!Array.isArray(root.rows)) {
    throw new MarketDataL3Error('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'rows must be an array');
  }
  const rows = root.rows.map(normalizeRow);
  const seenDates = new Set();
  const seenBars = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (seenDates.has(row.sessionDate) || seenBars.has(row.subjectBarIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'rows contain duplicate identities');
    }
    seenDates.add(row.sessionDate);
    seenBars.add(row.subjectBarIdentityId);
    if (index > 0) {
      const previous = rows[index - 1];
      if (`${previous.sessionDate}\0${previous.subjectBarIdentityId}`
          >= `${row.sessionDate}\0${row.subjectBarIdentityId}`) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SEASONALITY_INPUT_INVALID', 'rows must use canonical ordering',
        );
      }
    }
  }
  return { schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION, rows };
}
