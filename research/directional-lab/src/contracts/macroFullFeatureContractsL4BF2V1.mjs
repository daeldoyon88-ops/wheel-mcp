/**
 * L4B-F2 closed macro full-state contracts: the instrument projection policy,
 * the additive MarketMacroFullStateRows, the MarketMacroInstrumentRows and the
 * full computation report. F2 enriches the pinned L4B-F1 rows with CPI, UNRATE
 * and initial-claims causal state and projects the global macro state onto
 * explicitly pinned instruments. No network, wall clock, latest, float
 * authority, score, ranking or recommendation. CORE CPI is out of scope: no
 * authoritative core-CPI series exists in the L4B-I1 registry.
 */

import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertSafeInteger,
  assertSchemaVersion,
} from './marketDataL3CommonV1.mjs';
import {
  MACRO_CURRENCY_CODES,
  MACRO_JURISDICTION_CODES,
  normalizeMacroFixedPointValueV1,
} from './macroIngestionContractsL4BV1.mjs';
import { assertMacroMaterializationUtcInstant } from './macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_FEATURE_COMPLETENESS,
  MACRO_FEATURE_CURVE_SHAPES,
  MACRO_FEATURE_POLICY_DIRECTIONS,
  MACRO_FEATURE_RATE_REGIMES,
  closedFeatureRecord,
  copyClosed,
  normalizeNullableFixed,
  sameClosedValue,
} from './macroFeatureContractsL4BV1.mjs';
import { INSTRUMENT_KINDS } from './instrumentIdentityV1.mjs';

export const MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION =
  'MarketMacroInstrumentProjectionPolicy/1';
export const MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION = 'MarketMacroFullStateRows/1';
export const MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION = 'MarketMacroInstrumentRows/1';
export const MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION =
  'MarketMacroFullComputationReport/1';

export const MACRO_FEATURE_L4B_F2_SCHEMA_VERSIONS = Object.freeze([
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
]);

export const MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VERSION =
  'MARKET_MACRO_INSTRUMENT_PROJECTION_L4B_F2_V1';

/* F2 series (must exist in the L4B-I1 registry and binding). */
export const F2_CPI_SERIES_CODE = 'US.BLS.CPIAUCSL';
export const F2_UNRATE_SERIES_CODE = 'US.BLS.UNRATE';
export const F2_CLAIMS_SERIES_CODE = 'US.BLS.ICSA';
export const F2_SERIES_CODES = Object.freeze([
  F2_CPI_SERIES_CODE, F2_UNRATE_SERIES_CODE, F2_CLAIMS_SERIES_CODE,
]);

/* Closed enums. */
export const MACRO_F2_AVAILABILITY_STATUSES = Object.freeze([
  'AVAILABLE', 'STALE', 'NOT_AVAILABLE', 'WITHDRAWN',
]);
export const MACRO_INFLATION_DIRECTIONS = Object.freeze([
  'RISING', 'FALLING', 'UNCHANGED', 'NOT_AVAILABLE',
]);
export const MACRO_INFLATION_ACCELERATION_STATES = Object.freeze([
  'ACCELERATING', 'DECELERATING', 'STABLE', 'MIXED', 'NOT_AVAILABLE',
]);
export const MACRO_UNEMPLOYMENT_DIRECTIONS = Object.freeze([
  'RISING', 'FALLING', 'UNCHANGED', 'NOT_AVAILABLE',
]);
export const MACRO_UNEMPLOYMENT_TRENDS = Object.freeze([
  'IMPROVING', 'DETERIORATING', 'STABLE', 'MIXED', 'NOT_AVAILABLE',
]);
export const MACRO_CLAIMS_DIRECTIONS = Object.freeze([
  'RISING', 'FALLING', 'UNCHANGED', 'NOT_AVAILABLE',
]);
export const MACRO_CLAIMS_TRENDS = Object.freeze([
  'IMPROVING', 'DETERIORATING', 'STABLE', 'MIXED', 'NOT_AVAILABLE',
]);
export const MACRO_CLAIMS_SPIKE_STATES = Object.freeze([
  'SPIKE', 'ELEVATED', 'NORMAL', 'NOT_AVAILABLE',
]);
export const MACRO_INFLATION_REGIMES = Object.freeze([
  'LOW_AND_FALLING', 'LOW_AND_RISING', 'MODERATE_AND_FALLING', 'MODERATE_AND_RISING',
  'HIGH_AND_FALLING', 'HIGH_AND_RISING', 'NOT_AVAILABLE',
]);
export const MACRO_LABOR_REGIMES = Object.freeze([
  'STABLE', 'IMPROVING', 'DETERIORATING', 'MIXED', 'NOT_AVAILABLE',
]);
export const MACRO_CLAIMS_REGIMES = Object.freeze([
  'NORMAL', 'ELEVATED', 'SPIKE', 'IMPROVING', 'DETERIORATING', 'MIXED', 'NOT_AVAILABLE',
]);
export const MACRO_COMPOSITE_STATES = Object.freeze([
  'DISINFLATIONARY_EASING', 'DISINFLATIONARY_TIGHT', 'REFLATIONARY',
  'INFLATIONARY_TIGHTENING', 'LABOR_WEAKENING', 'MIXED', 'INSUFFICIENT_DATA',
]);
export const MACRO_PROJECTION_STATUSES = Object.freeze([
  'PROJECTED', 'PARTIAL', 'NOT_APPLICABLE', 'SESSION_MISMATCH',
]);
export const MACRO_LEVERAGE_CLASSES = Object.freeze(['NOT_AUTHORITATIVE']);

const ISO_3166_ALPHA2_OR_UNKNOWN = /^([A-Z]{2}|UNKNOWN)$/;
const ISO_4217_OR_UNKNOWN = /^([A-Z]{3}|UNKNOWN)$/;

function assertBoolean(value, label, code) {
  if (typeof value !== 'boolean') throw new MarketDataL3Error(code, `${label} must be a boolean`);
  return value;
}

function normalizeFixedLiteral(value, label, expectedScale, code) {
  const fixed = normalizeMacroFixedPointValueV1(value, label);
  if (fixed.scale !== expectedScale) {
    throw new MarketDataL3Error(code, `${label}.scale must equal ${expectedScale}`);
  }
  return { atoms: fixed.atoms, scale: fixed.scale };
}

function normalizeCountMap(value, allowedKeys, label, code) {
  const record = closedFeatureRecord(value, allowedKeys, label, code);
  const out = {};
  for (const key of allowedKeys) {
    assertSafeInteger(record[key], `${label}.${key}`, { nonNegative: true });
    out[key] = record[key];
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * MarketMacroInstrumentProjectionPolicy/1 — closed singleton (also pins the
 * F2 CPI/UNRATE/claims thresholds; §5 preference).
 * ------------------------------------------------------------------------- */

export const MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES = Object.freeze({
  policyVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VERSION,
  jurisdictionCode: 'UNITED_STATES',
  currencyCode: 'USD',
  explicitPinOnly: true,
  latestPolicy: 'FORBIDDEN',
  networkPolicy: 'FORBIDDEN',
  projectionMode: 'SESSION_ALIGNED_REFERENCE_ONLY',
  mismatchPolicy: 'REJECT_OR_EXPLICIT_STATUS',
  unsupportedInstrumentPolicy: 'EXPLICIT_NOT_APPLICABLE',
  missingMacroPolicy: 'EXPLICIT_PARTIAL',
  scorePolicy: 'FORBIDDEN',
  recommendationPolicy: 'FORBIDDEN',
  rankingPolicy: 'FORBIDDEN',
  instrumentSelectionPolicy: 'EXPLICIT_REGISTRY_ONLY',
  sessionAlignmentPolicy: 'INSTRUMENT_LISTING_INTERVAL_ON_MACRO_SESSION',
  neighbourSessionFallbackPolicy: 'FORBIDDEN',
  timezonePolicy: 'EXPLICIT_UTC_ONLY',
  orderingPolicy: 'INSTRUMENT_IDENTITY_SESSION_DATE_ID',
  leverageClassPolicy: 'NOT_AUTHORITATIVE',
  supportedDomicileCountry: 'US',
  supportedPrimaryCurrency: 'USD',
  fixedPointPolicy: 'INTEGER_ATOMS_WITH_EXPLICIT_SCALE',
  cpiInputScale: 3,
  unrateInputScale: 1,
  claimsInputScale: 0,
  ratioScale: 6,
  roundingMode: 'HALF_EVEN',
  cpiStalenessMaxMonths: 3,
  cpiMinObservationsForMoM: 2,
  cpiMinObservationsForYoY: 13,
  monthlyWindowPolicy: 'ALL_INTERMEDIATE_MONTHS_REQUIRED',
  unrateStalenessMaxMonths: 3,
  unrateTrendWindowMonths: 3,
  claimsStalenessMaxWeeks: 3,
  claimsFourWeekWindow: 4,
  claimsWindowPolicy: 'EXACT_SEVEN_DAY_STEPS',
  compositeRuleVersion: 'EXPLAINABLE_AXES_V1',
  inflationUnchangedRegimeSide: 'NON_RISING',
  futureCounterPolicy: 'PER_SESSION_PINNED_F2_ENTRY',
  instrumentCountPolicy: 'PINNED_REGISTRY_IDENTITIES',
  inflationRegimeBands: Object.freeze({
    lowMaxExclusiveYoY: Object.freeze({ atoms: '20000', scale: 6 }),
    moderateMaxExclusiveYoY: Object.freeze({ atoms: '40000', scale: 6 }),
  }),
  claimsSpikeThresholds: Object.freeze({
    elevatedMinInclusive: Object.freeze({ atoms: '300000', scale: 0 }),
    spikeMinInclusive: Object.freeze({ atoms: '400000', scale: 0 }),
  }),
});

const PROJECTION_POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
]);

export function normalizeMarketMacroInstrumentProjectionPolicyV1(value) {
  const code = 'MARKET_DATA_MACRO_INSTRUMENT_POLICY_INVALID';
  const policy = closedFeatureRecord(value, PROJECTION_POLICY_FIELDS,
    MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `policy field ${field} diverges from closed V1`);
    }
  }
  return {
    schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
    ...copyClosed(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
  };
}

/* ------------------------------------------------------------------------- *
 * MarketMacroFullStateRows/1
 * ------------------------------------------------------------------------- */

const F1_STATE_REFERENCE_FIELDS = Object.freeze([
  'f1MacroStateBySessionRowsId', 'f1SourceBundleId', 'f1FeatureComputationPolicyId',
  'f1MacroFeatureComputationReportId', 'f1SessionId', 'f1SessionCloseUtc',
  'f1OverallCompleteness', 'nominalRateRegime', 'curveRegime', 'policyDirection',
]);

const CPI_PROVENANCE_FIELDS = Object.freeze([
  'observationIdentityId', 'macroVintageIdentityId', 'observationVintageId',
]);

const INFLATION_STATE_FIELDS = Object.freeze([
  'cpiLevel', 'cpiReferencePeriod', 'cpiAvailableAt', 'cpiRevisionKind',
  'cpiCompletenessClass', 'cpiMoM', 'cpiYoY', 'cpiMoMChange', 'cpiYoYChange',
  'inflationDirection', 'inflationAccelerationState', 'monthsSinceLatestCpi',
  'cpiAvailabilityStatus', 'cpiProvenance',
]);

const UNEMPLOYMENT_STATE_FIELDS = Object.freeze([
  'unemploymentRate', 'unemploymentReferencePeriod', 'unemploymentAvailableAt',
  'unemploymentMoMChange', 'unemploymentThreeMonthChange', 'unemploymentDirection',
  'unemploymentTrend', 'monthsSinceLatestUnrate', 'unemploymentAvailabilityStatus',
  'unemploymentProvenance',
]);

const CLAIMS_STATE_FIELDS = Object.freeze([
  'initialClaims', 'claimsReferenceWeek', 'claimsAvailableAt', 'claimsWoWChange',
  'claimsFourWeekAverage', 'claimsFourWeekAverageChange', 'claimsDirection',
  'claimsTrend', 'claimsSpikeState', 'weeksSinceLatestClaims',
  'claimsAvailabilityStatus', 'claimsProvenance',
]);

const FULL_REGIME_STATE_FIELDS = Object.freeze([
  'nominalRateRegime', 'curveRegime', 'inflationRegime', 'laborRegime',
  'claimsRegime', 'policyDirection', 'macroCompositeState', 'macroDataCompleteness',
]);

const FULL_AVAILABILITY_STATE_FIELDS = Object.freeze([
  'inflationAvailability', 'laborAvailability', 'claimsAvailability',
  'f1Completeness', 'fullMacroCompleteness',
]);

const FULL_PROVENANCE_STATE_FIELDS = Object.freeze([
  'f1MacroStateBySessionRowsId', 'f1SessionId', 'sessionCloseUtc',
  'cpiObservationVintageId', 'unrateObservationVintageId', 'claimsObservationVintageId',
  'orderedFullProvenanceDigest',
]);

const FULL_ROW_IDENTITY_FIELDS = Object.freeze([
  'sessionId', 'sessionDate', 'sessionOpenUtc', 'sessionCloseUtc',
]);

const FULL_ROW_FIELDS = Object.freeze([
  ...FULL_ROW_IDENTITY_FIELDS, 'f1StateReference', 'inflationState',
  'unemploymentState', 'claimsState', 'fullMacroRegimeState',
  'fullAvailabilityState', 'fullProvenanceState',
]);

const FULL_ROWS_FIELDS = Object.freeze([
  'schemaVersion', 'f1MacroStateBySessionRowsId', 'f1SourceBundleId',
  'f1FeatureComputationPolicyId', 'f1MacroFeatureComputationReportId',
  'projectionPolicyId', 'rows',
]);

const ROWS_CODE = 'MARKET_DATA_MACRO_FULL_ROWS_INVALID';

function normalizeProvenanceTriple(value, label) {
  const rec = closedFeatureRecord(value, CPI_PROVENANCE_FIELDS, label, ROWS_CODE);
  assertCasId(rec.observationIdentityId, `${label}.observationIdentityId`, true);
  assertCasId(rec.macroVintageIdentityId, `${label}.macroVintageIdentityId`, true);
  assertCasId(rec.observationVintageId, `${label}.observationVintageId`, true);
  return {
    observationIdentityId: rec.observationIdentityId,
    macroVintageIdentityId: rec.macroVintageIdentityId,
    observationVintageId: rec.observationVintageId,
  };
}

function assertMonthlyReferenceOrNull(value, label) {
  if (value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new MarketDataL3Error(ROWS_CODE, `${label} must be a closed YYYY-MM key or null`);
  }
}

function normalizeF1StateReference(value) {
  const rec = closedFeatureRecord(value, F1_STATE_REFERENCE_FIELDS, 'f1StateReference', ROWS_CODE);
  for (const field of ['f1MacroStateBySessionRowsId', 'f1SourceBundleId',
    'f1FeatureComputationPolicyId', 'f1MacroFeatureComputationReportId', 'f1SessionId']) {
    assertCasId(rec[field], `f1StateReference.${field}`);
  }
  assertMacroMaterializationUtcInstant(rec.f1SessionCloseUtc, 'f1StateReference.f1SessionCloseUtc');
  assertEnum(rec.f1OverallCompleteness, MACRO_FEATURE_COMPLETENESS,
    'f1StateReference.f1OverallCompleteness', ROWS_CODE);
  assertEnum(rec.nominalRateRegime, MACRO_FEATURE_RATE_REGIMES,
    'f1StateReference.nominalRateRegime', ROWS_CODE);
  assertEnum(rec.curveRegime, MACRO_FEATURE_CURVE_SHAPES, 'f1StateReference.curveRegime', ROWS_CODE);
  assertEnum(rec.policyDirection, MACRO_FEATURE_POLICY_DIRECTIONS,
    'f1StateReference.policyDirection', ROWS_CODE);
  return Object.fromEntries(F1_STATE_REFERENCE_FIELDS.map((field) => [field, rec[field]]));
}

function normalizeInflationState(value) {
  const s = closedFeatureRecord(value, INFLATION_STATE_FIELDS, 'inflationState', ROWS_CODE);
  assertMonthlyReferenceOrNull(s.cpiReferencePeriod, 'inflationState.cpiReferencePeriod');
  assertMacroMaterializationUtcInstant(s.cpiAvailableAt, 'inflationState.cpiAvailableAt', true);
  if (s.cpiRevisionKind !== null && typeof s.cpiRevisionKind !== 'string') {
    throw new MarketDataL3Error(ROWS_CODE, 'inflationState.cpiRevisionKind must be string or null');
  }
  if (s.cpiCompletenessClass !== null && typeof s.cpiCompletenessClass !== 'string') {
    throw new MarketDataL3Error(ROWS_CODE, 'inflationState.cpiCompletenessClass must be string or null');
  }
  assertEnum(s.inflationDirection, MACRO_INFLATION_DIRECTIONS,
    'inflationState.inflationDirection', ROWS_CODE);
  assertEnum(s.inflationAccelerationState, MACRO_INFLATION_ACCELERATION_STATES,
    'inflationState.inflationAccelerationState', ROWS_CODE);
  if (s.monthsSinceLatestCpi !== null) {
    assertSafeInteger(s.monthsSinceLatestCpi, 'inflationState.monthsSinceLatestCpi', { nonNegative: true });
  }
  assertEnum(s.cpiAvailabilityStatus, MACRO_F2_AVAILABILITY_STATUSES,
    'inflationState.cpiAvailabilityStatus', ROWS_CODE);
  return {
    cpiLevel: normalizeNullableFixed(s.cpiLevel, 'inflationState.cpiLevel'),
    cpiReferencePeriod: s.cpiReferencePeriod,
    cpiAvailableAt: s.cpiAvailableAt,
    cpiRevisionKind: s.cpiRevisionKind,
    cpiCompletenessClass: s.cpiCompletenessClass,
    cpiMoM: normalizeNullableFixed(s.cpiMoM, 'inflationState.cpiMoM'),
    cpiYoY: normalizeNullableFixed(s.cpiYoY, 'inflationState.cpiYoY'),
    cpiMoMChange: normalizeNullableFixed(s.cpiMoMChange, 'inflationState.cpiMoMChange'),
    cpiYoYChange: normalizeNullableFixed(s.cpiYoYChange, 'inflationState.cpiYoYChange'),
    inflationDirection: s.inflationDirection,
    inflationAccelerationState: s.inflationAccelerationState,
    monthsSinceLatestCpi: s.monthsSinceLatestCpi,
    cpiAvailabilityStatus: s.cpiAvailabilityStatus,
    cpiProvenance: normalizeProvenanceTriple(s.cpiProvenance, 'inflationState.cpiProvenance'),
  };
}

function normalizeUnemploymentState(value) {
  const s = closedFeatureRecord(value, UNEMPLOYMENT_STATE_FIELDS, 'unemploymentState', ROWS_CODE);
  assertMonthlyReferenceOrNull(s.unemploymentReferencePeriod, 'unemploymentState.unemploymentReferencePeriod');
  assertMacroMaterializationUtcInstant(s.unemploymentAvailableAt,
    'unemploymentState.unemploymentAvailableAt', true);
  assertEnum(s.unemploymentDirection, MACRO_UNEMPLOYMENT_DIRECTIONS,
    'unemploymentState.unemploymentDirection', ROWS_CODE);
  assertEnum(s.unemploymentTrend, MACRO_UNEMPLOYMENT_TRENDS,
    'unemploymentState.unemploymentTrend', ROWS_CODE);
  if (s.monthsSinceLatestUnrate !== null) {
    assertSafeInteger(s.monthsSinceLatestUnrate, 'unemploymentState.monthsSinceLatestUnrate',
      { nonNegative: true });
  }
  assertEnum(s.unemploymentAvailabilityStatus, MACRO_F2_AVAILABILITY_STATUSES,
    'unemploymentState.unemploymentAvailabilityStatus', ROWS_CODE);
  return {
    unemploymentRate: normalizeNullableFixed(s.unemploymentRate, 'unemploymentState.unemploymentRate'),
    unemploymentReferencePeriod: s.unemploymentReferencePeriod,
    unemploymentAvailableAt: s.unemploymentAvailableAt,
    unemploymentMoMChange: normalizeNullableFixed(s.unemploymentMoMChange,
      'unemploymentState.unemploymentMoMChange'),
    unemploymentThreeMonthChange: normalizeNullableFixed(s.unemploymentThreeMonthChange,
      'unemploymentState.unemploymentThreeMonthChange'),
    unemploymentDirection: s.unemploymentDirection,
    unemploymentTrend: s.unemploymentTrend,
    monthsSinceLatestUnrate: s.monthsSinceLatestUnrate,
    unemploymentAvailabilityStatus: s.unemploymentAvailabilityStatus,
    unemploymentProvenance: normalizeProvenanceTriple(s.unemploymentProvenance,
      'unemploymentState.unemploymentProvenance'),
  };
}

function normalizeClaimsState(value) {
  const s = closedFeatureRecord(value, CLAIMS_STATE_FIELDS, 'claimsState', ROWS_CODE);
  if (s.claimsReferenceWeek !== null) {
    assertCivilDate(s.claimsReferenceWeek, 'claimsState.claimsReferenceWeek');
  }
  assertMacroMaterializationUtcInstant(s.claimsAvailableAt, 'claimsState.claimsAvailableAt', true);
  assertEnum(s.claimsDirection, MACRO_CLAIMS_DIRECTIONS, 'claimsState.claimsDirection', ROWS_CODE);
  assertEnum(s.claimsTrend, MACRO_CLAIMS_TRENDS, 'claimsState.claimsTrend', ROWS_CODE);
  assertEnum(s.claimsSpikeState, MACRO_CLAIMS_SPIKE_STATES, 'claimsState.claimsSpikeState', ROWS_CODE);
  if (s.weeksSinceLatestClaims !== null) {
    assertSafeInteger(s.weeksSinceLatestClaims, 'claimsState.weeksSinceLatestClaims',
      { nonNegative: true });
  }
  assertEnum(s.claimsAvailabilityStatus, MACRO_F2_AVAILABILITY_STATUSES,
    'claimsState.claimsAvailabilityStatus', ROWS_CODE);
  return {
    initialClaims: normalizeNullableFixed(s.initialClaims, 'claimsState.initialClaims'),
    claimsReferenceWeek: s.claimsReferenceWeek,
    claimsAvailableAt: s.claimsAvailableAt,
    claimsWoWChange: normalizeNullableFixed(s.claimsWoWChange, 'claimsState.claimsWoWChange'),
    claimsFourWeekAverage: normalizeNullableFixed(s.claimsFourWeekAverage,
      'claimsState.claimsFourWeekAverage'),
    claimsFourWeekAverageChange: normalizeNullableFixed(s.claimsFourWeekAverageChange,
      'claimsState.claimsFourWeekAverageChange'),
    claimsDirection: s.claimsDirection,
    claimsTrend: s.claimsTrend,
    claimsSpikeState: s.claimsSpikeState,
    weeksSinceLatestClaims: s.weeksSinceLatestClaims,
    claimsAvailabilityStatus: s.claimsAvailabilityStatus,
    claimsProvenance: normalizeProvenanceTriple(s.claimsProvenance, 'claimsState.claimsProvenance'),
  };
}

function normalizeFullRegimeState(value) {
  const s = closedFeatureRecord(value, FULL_REGIME_STATE_FIELDS, 'fullMacroRegimeState', ROWS_CODE);
  assertEnum(s.nominalRateRegime, MACRO_FEATURE_RATE_REGIMES,
    'fullMacroRegimeState.nominalRateRegime', ROWS_CODE);
  assertEnum(s.curveRegime, MACRO_FEATURE_CURVE_SHAPES, 'fullMacroRegimeState.curveRegime', ROWS_CODE);
  assertEnum(s.inflationRegime, MACRO_INFLATION_REGIMES,
    'fullMacroRegimeState.inflationRegime', ROWS_CODE);
  assertEnum(s.laborRegime, MACRO_LABOR_REGIMES, 'fullMacroRegimeState.laborRegime', ROWS_CODE);
  assertEnum(s.claimsRegime, MACRO_CLAIMS_REGIMES, 'fullMacroRegimeState.claimsRegime', ROWS_CODE);
  assertEnum(s.policyDirection, MACRO_FEATURE_POLICY_DIRECTIONS,
    'fullMacroRegimeState.policyDirection', ROWS_CODE);
  assertEnum(s.macroCompositeState, MACRO_COMPOSITE_STATES,
    'fullMacroRegimeState.macroCompositeState', ROWS_CODE);
  assertEnum(s.macroDataCompleteness, MACRO_FEATURE_COMPLETENESS,
    'fullMacroRegimeState.macroDataCompleteness', ROWS_CODE);
  return Object.fromEntries(FULL_REGIME_STATE_FIELDS.map((field) => [field, s[field]]));
}

function normalizeFullAvailabilityState(value) {
  const s = closedFeatureRecord(value, FULL_AVAILABILITY_STATE_FIELDS,
    'fullAvailabilityState', ROWS_CODE);
  for (const field of FULL_AVAILABILITY_STATE_FIELDS) {
    assertEnum(s[field], MACRO_FEATURE_COMPLETENESS, `fullAvailabilityState.${field}`, ROWS_CODE);
  }
  return Object.fromEntries(FULL_AVAILABILITY_STATE_FIELDS.map((field) => [field, s[field]]));
}

function normalizeFullProvenanceState(value) {
  const s = closedFeatureRecord(value, FULL_PROVENANCE_STATE_FIELDS,
    'fullProvenanceState', ROWS_CODE);
  assertCasId(s.f1MacroStateBySessionRowsId, 'fullProvenanceState.f1MacroStateBySessionRowsId');
  assertCasId(s.f1SessionId, 'fullProvenanceState.f1SessionId');
  assertMacroMaterializationUtcInstant(s.sessionCloseUtc, 'fullProvenanceState.sessionCloseUtc');
  assertCasId(s.cpiObservationVintageId, 'fullProvenanceState.cpiObservationVintageId', true);
  assertCasId(s.unrateObservationVintageId, 'fullProvenanceState.unrateObservationVintageId', true);
  assertCasId(s.claimsObservationVintageId, 'fullProvenanceState.claimsObservationVintageId', true);
  assertCasId(s.orderedFullProvenanceDigest, 'fullProvenanceState.orderedFullProvenanceDigest');
  return Object.fromEntries(FULL_PROVENANCE_STATE_FIELDS.map((field) => [field, s[field]]));
}

export function normalizeMarketMacroFullStateRowV1(value, index = 0) {
  const label = `rows[${index}]`;
  const row = closedFeatureRecord(value, FULL_ROW_FIELDS, label, ROWS_CODE);
  assertCasId(row.sessionId, `${label}.sessionId`);
  assertCivilDate(row.sessionDate, `${label}.sessionDate`);
  assertMacroMaterializationUtcInstant(row.sessionOpenUtc, `${label}.sessionOpenUtc`);
  assertMacroMaterializationUtcInstant(row.sessionCloseUtc, `${label}.sessionCloseUtc`);
  return {
    sessionId: row.sessionId,
    sessionDate: row.sessionDate,
    sessionOpenUtc: row.sessionOpenUtc,
    sessionCloseUtc: row.sessionCloseUtc,
    f1StateReference: normalizeF1StateReference(row.f1StateReference),
    inflationState: normalizeInflationState(row.inflationState),
    unemploymentState: normalizeUnemploymentState(row.unemploymentState),
    claimsState: normalizeClaimsState(row.claimsState),
    fullMacroRegimeState: normalizeFullRegimeState(row.fullMacroRegimeState),
    fullAvailabilityState: normalizeFullAvailabilityState(row.fullAvailabilityState),
    fullProvenanceState: normalizeFullProvenanceState(row.fullProvenanceState),
  };
}

export function compareMacroFullRowOrderKeys(left, right) {
  for (const field of ['sessionDate', 'sessionOpenUtc', 'sessionCloseUtc', 'sessionId']) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

const FULL_ROWS_F1_REFERENCE_FIELDS = Object.freeze([
  'f1MacroStateBySessionRowsId', 'f1SourceBundleId', 'f1FeatureComputationPolicyId',
  'f1MacroFeatureComputationReportId',
]);

export function normalizeMarketMacroFullStateRowsV1(value) {
  const container = closedFeatureRecord(value, FULL_ROWS_FIELDS,
    MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION, ROWS_CODE);
  assertSchemaVersion(container, MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION);
  for (const field of [...FULL_ROWS_F1_REFERENCE_FIELDS, 'projectionPolicyId']) {
    assertCasId(container[field], field);
  }
  if (!Array.isArray(container.rows)) {
    throw new MarketDataL3Error(ROWS_CODE, 'rows must be an array');
  }
  const rows = container.rows.map((row, index) => normalizeMarketMacroFullStateRowV1(row, index));
  for (let index = 0; index < rows.length; index += 1) {
    for (const field of FULL_ROWS_F1_REFERENCE_FIELDS) {
      if (rows[index].f1StateReference[field] !== container[field]) {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_FULL_ROWS_MISMATCH',
          `rows[${index}].f1StateReference.${field} diverges from the container F1 pin`);
      }
    }
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (compareMacroFullRowOrderKeys(rows[index - 1], rows[index]) >= 0) {
      throw new MarketDataL3Error(ROWS_CODE,
        'rows must be strictly sorted by sessionDate/open/close/sessionId');
    }
  }
  return {
    schemaVersion: MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
    f1MacroStateBySessionRowsId: container.f1MacroStateBySessionRowsId,
    f1SourceBundleId: container.f1SourceBundleId,
    f1FeatureComputationPolicyId: container.f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: container.f1MacroFeatureComputationReportId,
    projectionPolicyId: container.projectionPolicyId,
    rows,
  };
}

/* ------------------------------------------------------------------------- *
 * MarketMacroInstrumentRows/1
 * ------------------------------------------------------------------------- */

const INSTRUMENT_REGIME_AXES_FIELDS = Object.freeze([
  'nominalRateRegime', 'curveRegime', 'inflationRegime', 'laborRegime',
  'claimsRegime', 'policyDirection', 'macroCompositeState', 'macroDataCompleteness',
]);

const INSTRUMENT_ROW_FIELDS = Object.freeze([
  'instrumentIdentityId', 'sessionId', 'sessionDate', 'macroFullStateRowIdentity',
  'projectionPolicyId', 'instrumentRegistryManifestId', 'instrumentJurisdictionCode',
  'instrumentCurrencyCode', 'assetClass', 'leverageClass', 'projectionStatus',
  'macroStateCompleteness', 'macroRegimeAxes', 'provenanceDigest',
]);

const INSTRUMENT_ROWS_FIELDS = Object.freeze([
  'schemaVersion', 'fullStateRowsId', 'projectionPolicyId',
  'instrumentRegistryManifestId', 'rows',
]);

const INSTRUMENT_ROWS_CODE = 'MARKET_DATA_MACRO_INSTRUMENT_ROWS_INVALID';

/** Fields structurally forbidden on an instrument row (score/recommendation). */
const FORBIDDEN_INSTRUMENT_FIELDS = Object.freeze([
  'score', 'rank', 'ranking', 'recommendation', 'signal', 'buy', 'sell',
  'strike', 'premium', 'weight', 'safe', 'balanced', 'aggressive', 'agressif',
]);

function normalizeInstrumentRegimeAxes(value, label) {
  if (value === null) return null;
  const s = closedFeatureRecord(value, INSTRUMENT_REGIME_AXES_FIELDS, label, INSTRUMENT_ROWS_CODE);
  assertEnum(s.nominalRateRegime, MACRO_FEATURE_RATE_REGIMES, `${label}.nominalRateRegime`, INSTRUMENT_ROWS_CODE);
  assertEnum(s.curveRegime, MACRO_FEATURE_CURVE_SHAPES, `${label}.curveRegime`, INSTRUMENT_ROWS_CODE);
  assertEnum(s.inflationRegime, MACRO_INFLATION_REGIMES, `${label}.inflationRegime`, INSTRUMENT_ROWS_CODE);
  assertEnum(s.laborRegime, MACRO_LABOR_REGIMES, `${label}.laborRegime`, INSTRUMENT_ROWS_CODE);
  assertEnum(s.claimsRegime, MACRO_CLAIMS_REGIMES, `${label}.claimsRegime`, INSTRUMENT_ROWS_CODE);
  assertEnum(s.policyDirection, MACRO_FEATURE_POLICY_DIRECTIONS, `${label}.policyDirection`, INSTRUMENT_ROWS_CODE);
  assertEnum(s.macroCompositeState, MACRO_COMPOSITE_STATES, `${label}.macroCompositeState`, INSTRUMENT_ROWS_CODE);
  assertEnum(s.macroDataCompleteness, MACRO_FEATURE_COMPLETENESS, `${label}.macroDataCompleteness`, INSTRUMENT_ROWS_CODE);
  return Object.fromEntries(INSTRUMENT_REGIME_AXES_FIELDS.map((field) => [field, s[field]]));
}

export function normalizeMarketMacroInstrumentRowV1(value, index = 0) {
  const label = `rows[${index}]`;
  const row = closedFeatureRecord(value, INSTRUMENT_ROW_FIELDS, label, INSTRUMENT_ROWS_CODE);
  for (const forbidden of FORBIDDEN_INSTRUMENT_FIELDS) {
    if (Object.hasOwn(row, forbidden)) {
      throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
        `${label} carries forbidden decision field ${forbidden}`);
    }
  }
  assertCasId(row.instrumentIdentityId, `${label}.instrumentIdentityId`);
  assertCasId(row.projectionPolicyId, `${label}.projectionPolicyId`);
  assertCasId(row.instrumentRegistryManifestId, `${label}.instrumentRegistryManifestId`);
  assertCasId(row.sessionId, `${label}.sessionId`, true);
  if (row.sessionDate !== null) assertCivilDate(row.sessionDate, `${label}.sessionDate`);
  assertCasId(row.macroFullStateRowIdentity, `${label}.macroFullStateRowIdentity`, true);
  if (typeof row.instrumentJurisdictionCode !== 'string'
      || !ISO_3166_ALPHA2_OR_UNKNOWN.test(row.instrumentJurisdictionCode)) {
    throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
      `${label}.instrumentJurisdictionCode must be ISO 3166-1 alpha-2 or UNKNOWN`);
  }
  if (typeof row.instrumentCurrencyCode !== 'string'
      || !ISO_4217_OR_UNKNOWN.test(row.instrumentCurrencyCode)) {
    throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
      `${label}.instrumentCurrencyCode must be ISO 4217 or UNKNOWN`);
  }
  assertEnum(row.assetClass, INSTRUMENT_KINDS, `${label}.assetClass`, INSTRUMENT_ROWS_CODE);
  assertEnum(row.leverageClass, MACRO_LEVERAGE_CLASSES, `${label}.leverageClass`, INSTRUMENT_ROWS_CODE);
  assertEnum(row.projectionStatus, MACRO_PROJECTION_STATUSES, `${label}.projectionStatus`, INSTRUMENT_ROWS_CODE);
  if (row.macroStateCompleteness !== null) {
    assertEnum(row.macroStateCompleteness, MACRO_FEATURE_COMPLETENESS,
      `${label}.macroStateCompleteness`, INSTRUMENT_ROWS_CODE);
  }
  assertCasId(row.provenanceDigest, `${label}.provenanceDigest`);
  // Cross-field closure: PROJECTED/PARTIAL require a session + macro reference;
  // NOT_APPLICABLE/SESSION_MISMATCH carry null axes.
  const projected = row.projectionStatus === 'PROJECTED' || row.projectionStatus === 'PARTIAL';
  if (projected) {
    if (row.sessionId === null || row.sessionDate === null
        || row.macroFullStateRowIdentity === null || row.macroStateCompleteness === null) {
      throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
        `${label} projected/partial rows require session and macro references`);
    }
  } else if (row.projectionStatus === 'NOT_APPLICABLE') {
    if (row.sessionId !== null || row.sessionDate !== null
        || row.macroFullStateRowIdentity !== null || row.macroRegimeAxes !== null
        || row.macroStateCompleteness !== null) {
      throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
        `${label} NOT_APPLICABLE rows carry no session or macro reference`);
    }
  } else {
    // SESSION_MISMATCH: session pinned but no macro projection.
    if (row.sessionId === null || row.sessionDate === null) {
      throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
        `${label} SESSION_MISMATCH rows still pin the attempted session`);
    }
    if (row.macroFullStateRowIdentity !== null || row.macroRegimeAxes !== null
        || row.macroStateCompleteness !== null) {
      throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
        `${label} SESSION_MISMATCH rows carry no macro projection`);
    }
  }
  const axes = normalizeInstrumentRegimeAxes(row.macroRegimeAxes, `${label}.macroRegimeAxes`);
  if (projected && axes === null) {
    throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
      `${label} projected/partial rows require macroRegimeAxes`);
  }
  return {
    instrumentIdentityId: row.instrumentIdentityId,
    sessionId: row.sessionId,
    sessionDate: row.sessionDate,
    macroFullStateRowIdentity: row.macroFullStateRowIdentity,
    projectionPolicyId: row.projectionPolicyId,
    instrumentRegistryManifestId: row.instrumentRegistryManifestId,
    instrumentJurisdictionCode: row.instrumentJurisdictionCode,
    instrumentCurrencyCode: row.instrumentCurrencyCode,
    assetClass: row.assetClass,
    leverageClass: row.leverageClass,
    projectionStatus: row.projectionStatus,
    macroStateCompleteness: row.macroStateCompleteness,
    macroRegimeAxes: axes,
    provenanceDigest: row.provenanceDigest,
  };
}

export function compareMacroInstrumentRowOrderKeys(left, right) {
  if (left.instrumentIdentityId < right.instrumentIdentityId) return -1;
  if (left.instrumentIdentityId > right.instrumentIdentityId) return 1;
  const leftDate = left.sessionDate ?? '';
  const rightDate = right.sessionDate ?? '';
  if (leftDate < rightDate) return -1;
  if (leftDate > rightDate) return 1;
  const leftSession = left.sessionId ?? '';
  const rightSession = right.sessionId ?? '';
  if (leftSession < rightSession) return -1;
  if (leftSession > rightSession) return 1;
  return 0;
}

export function normalizeMarketMacroInstrumentRowsV1(value) {
  const container = closedFeatureRecord(value, INSTRUMENT_ROWS_FIELDS,
    MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION, INSTRUMENT_ROWS_CODE);
  assertSchemaVersion(container, MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION);
  assertCasId(container.fullStateRowsId, 'fullStateRowsId');
  assertCasId(container.projectionPolicyId, 'projectionPolicyId');
  assertCasId(container.instrumentRegistryManifestId, 'instrumentRegistryManifestId');
  if (!Array.isArray(container.rows)) {
    throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE, 'rows must be an array');
  }
  const rows = container.rows.map((row, index) => normalizeMarketMacroInstrumentRowV1(row, index));
  for (const row of rows) {
    if (row.projectionPolicyId !== container.projectionPolicyId
        || row.instrumentRegistryManifestId !== container.instrumentRegistryManifestId) {
      throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
        'row policy/registry pins diverge from the container');
    }
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (compareMacroInstrumentRowOrderKeys(rows[index - 1], rows[index]) >= 0) {
      throw new MarketDataL3Error(INSTRUMENT_ROWS_CODE,
        'instrument rows must be strictly sorted by instrument/sessionDate/sessionId');
    }
  }
  return {
    schemaVersion: MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
    fullStateRowsId: container.fullStateRowsId,
    projectionPolicyId: container.projectionPolicyId,
    instrumentRegistryManifestId: container.instrumentRegistryManifestId,
    rows,
  };
}

/* ------------------------------------------------------------------------- *
 * MarketMacroFullComputationReport/1
 * ------------------------------------------------------------------------- */

const REPORT_COUNT_FIELDS = Object.freeze([
  'sessionCount', 'instrumentCount', 'fullStateRowCount', 'instrumentRowCount',
  'completeMacroSessionCount', 'partialMacroSessionCount', 'unavailableMacroSessionCount',
  'cpiAvailableSessionCount', 'cpiStaleSessionCount', 'cpiWithdrawnSessionCount',
  'cpiNotAvailableSessionCount',
  'unrateAvailableSessionCount', 'unrateStaleSessionCount',
  'unrateWithdrawnSessionCount', 'unrateNotAvailableSessionCount',
  'claimsAvailableSessionCount', 'claimsStaleSessionCount',
  'claimsWithdrawnSessionCount', 'claimsNotAvailableSessionCount',
  'projectedInstrumentRowCount', 'partialInstrumentRowCount',
  'notApplicableInstrumentRowCount', 'sessionMismatchInstrumentRowCount',
  'futureObservationRejectedCount', 'futureRevisionRejectedCount',
  'futureCalendarUpdateRejectedCount',
]);

const REPORT_FIELDS = Object.freeze([
  'schemaVersion', 'f1SourceBundleId', 'f1FeatureComputationPolicyId', 'f1MacroStateBySessionRowsId',
  'f1MacroFeatureComputationReportId', 'fullStateRowsId', 'instrumentProjectionPolicyId',
  'instrumentRowsId', 'macroDatasetBindingId', 'marketCalendarRegistryManifestId',
  'instrumentIdentityRegistryManifestId', 'firstSessionId', 'lastSessionId',
  'firstSessionDate', 'lastSessionDate', ...REPORT_COUNT_FIELDS,
  'inflationRegimeCounts', 'laborRegimeCounts', 'claimsRegimeCounts', 'compositeStateCounts',
  'projectionStatusCounts', 'orderedFullStateRowDigest', 'orderedInstrumentRowDigest',
  'orderedFullProvenanceDigest', 'emptyComputation',
]);

const REPORT_CODE = 'MARKET_DATA_MACRO_FULL_REPORT_INVALID';

export function normalizeMarketMacroFullComputationReportV1(value) {
  const report = closedFeatureRecord(value, REPORT_FIELDS,
    MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION, REPORT_CODE);
  assertSchemaVersion(report, MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION);
  for (const field of ['f1SourceBundleId', 'f1FeatureComputationPolicyId',
    'f1MacroStateBySessionRowsId', 'f1MacroFeatureComputationReportId', 'fullStateRowsId',
    'instrumentProjectionPolicyId', 'instrumentRowsId', 'macroDatasetBindingId',
    'marketCalendarRegistryManifestId', 'instrumentIdentityRegistryManifestId']) {
    assertCasId(report[field], field);
  }
  assertCasId(report.firstSessionId, 'firstSessionId', true);
  assertCasId(report.lastSessionId, 'lastSessionId', true);
  if (report.firstSessionDate !== null) assertCivilDate(report.firstSessionDate, 'firstSessionDate');
  if (report.lastSessionDate !== null) assertCivilDate(report.lastSessionDate, 'lastSessionDate');
  for (const field of REPORT_COUNT_FIELDS) {
    assertSafeInteger(report[field], field, { nonNegative: true });
  }
  const inflationRegimeCounts = normalizeCountMap(report.inflationRegimeCounts,
    MACRO_INFLATION_REGIMES, 'inflationRegimeCounts', REPORT_CODE);
  const laborRegimeCounts = normalizeCountMap(report.laborRegimeCounts,
    MACRO_LABOR_REGIMES, 'laborRegimeCounts', REPORT_CODE);
  const claimsRegimeCounts = normalizeCountMap(report.claimsRegimeCounts,
    MACRO_CLAIMS_REGIMES, 'claimsRegimeCounts', REPORT_CODE);
  const compositeStateCounts = normalizeCountMap(report.compositeStateCounts,
    MACRO_COMPOSITE_STATES, 'compositeStateCounts', REPORT_CODE);
  const projectionStatusCounts = normalizeCountMap(report.projectionStatusCounts,
    MACRO_PROJECTION_STATUSES, 'projectionStatusCounts', REPORT_CODE);
  for (const field of ['orderedFullStateRowDigest', 'orderedInstrumentRowDigest',
    'orderedFullProvenanceDigest']) {
    assertCasId(report[field], field);
  }
  assertBoolean(report.emptyComputation, 'emptyComputation', REPORT_CODE);
  if (report.emptyComputation !== (report.sessionCount === 0)) {
    throw new MarketDataL3Error(REPORT_CODE, 'emptyComputation diverges from sessionCount');
  }
  if ((report.sessionCount === 0) !== (report.firstSessionId === null)
      || (report.firstSessionId === null) !== (report.lastSessionId === null)
      || (report.firstSessionDate === null) !== (report.lastSessionDate === null)
      || (report.firstSessionId === null) !== (report.firstSessionDate === null)) {
    throw new MarketDataL3Error(REPORT_CODE, 'empty session bounds diverge from sessionCount');
  }
  return {
    schemaVersion: MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
    f1SourceBundleId: report.f1SourceBundleId,
    f1FeatureComputationPolicyId: report.f1FeatureComputationPolicyId,
    f1MacroStateBySessionRowsId: report.f1MacroStateBySessionRowsId,
    f1MacroFeatureComputationReportId: report.f1MacroFeatureComputationReportId,
    fullStateRowsId: report.fullStateRowsId,
    instrumentProjectionPolicyId: report.instrumentProjectionPolicyId,
    instrumentRowsId: report.instrumentRowsId,
    macroDatasetBindingId: report.macroDatasetBindingId,
    marketCalendarRegistryManifestId: report.marketCalendarRegistryManifestId,
    instrumentIdentityRegistryManifestId: report.instrumentIdentityRegistryManifestId,
    firstSessionId: report.firstSessionId,
    lastSessionId: report.lastSessionId,
    firstSessionDate: report.firstSessionDate,
    lastSessionDate: report.lastSessionDate,
    ...Object.fromEntries(REPORT_COUNT_FIELDS.map((field) => [field, report[field]])),
    inflationRegimeCounts,
    laborRegimeCounts,
    claimsRegimeCounts,
    compositeStateCounts,
    projectionStatusCounts,
    orderedFullStateRowDigest: report.orderedFullStateRowDigest,
    orderedInstrumentRowDigest: report.orderedInstrumentRowDigest,
    orderedFullProvenanceDigest: report.orderedFullProvenanceDigest,
    emptyComputation: report.emptyComputation,
  };
}
