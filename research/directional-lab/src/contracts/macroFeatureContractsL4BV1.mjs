/**
 * L4B-F1 closed macro feature contracts: source bundle, computation policy,
 * MacroStateBySessionRows and computation report. Consumes pinned L4B-I1/I2
 * authorities only. No network, wall clock, latest, float authority, CPI,
 * UNRATE or ICSA features.
 */

import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  canonicalDigest,
} from './marketDataL3CommonV1.mjs';
import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import {
  MACRO_CURRENCY_CODES,
  MACRO_JURISDICTION_CODES,
  normalizeMacroFixedPointValueV1,
} from './macroIngestionContractsL4BV1.mjs';
import {
  MACRO_BINDING_TEMPORAL_CAPABILITIES,
  assertMacroMaterializationUtcInstant,
  closedMacroRecord,
} from './macroMaterializationContractsL4BV1.mjs';
import { MARKET_CALENDAR_SESSION_KINDS } from './marketCalendarL3V1.mjs';

export const MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION =
  'MarketMacroFeatureSourceBundle/1';
export const MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION =
  'MarketMacroFeatureComputationPolicy/1';
export const MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION = 'MacroStateBySessionRows/1';
export const MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION =
  'MarketMacroFeatureComputationReport/1';

export const MACRO_FEATURE_L4B_F1_SCHEMA_VERSIONS = Object.freeze([
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
]);

export const MARKET_MACRO_FEATURE_SOURCE_BUNDLE_POLICY_VERSION =
  'MARKET_MACRO_FEATURE_SOURCE_BUNDLE_L4B_F1_V1';
export const MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VERSION =
  'MARKET_MACRO_FEATURE_COMPUTATION_L4B_F1_V1';

/** Logical projection label — not a snapshots-namespace schema. */
export const MACRO_MARKET_SESSION_IDENTITY_PROJECTION = 'MacroMarketSessionIdentity/1';

export const F1_SERIES_ALIAS_TO_CODE = Object.freeze({
  FED_TARGET_LOWER_BOUND: 'US.FRB.DFEDTARL',
  FED_TARGET_UPPER_BOUND: 'US.FRB.DFEDTARU',
  EFFECTIVE_FEDERAL_FUNDS_RATE: 'US.NYFED.EFFR',
  SOFR: 'US.NYFED.SOFR',
  TREASURY_3M: 'US.TREAS.DGS3MO',
  TREASURY_2Y: 'US.TREAS.DGS2',
  TREASURY_5Y: 'US.TREAS.DGS5',
  TREASURY_10Y: 'US.TREAS.DGS10',
  TREASURY_30Y: 'US.TREAS.DGS30',
  FOMC_DECISION: 'US.FOMC.DECISION',
});

export const F1_SERIES_CODES = Object.freeze([
  'US.FRB.DFEDTARL',
  'US.FRB.DFEDTARU',
  'US.NYFED.EFFR',
  'US.NYFED.SOFR',
  'US.TREAS.DGS3MO',
  'US.TREAS.DGS2',
  'US.TREAS.DGS5',
  'US.TREAS.DGS10',
  'US.TREAS.DGS30',
  'US.FOMC.DECISION',
]);

export const F1_SERIES_FAMILIES = Object.freeze([
  'POLICY_RATE', 'MONEY_MARKET', 'TREASURY', 'FOMC_EVENT',
]);

export const F1_SERIES_FAMILY_BY_CODE = Object.freeze({
  'US.FRB.DFEDTARL': 'POLICY_RATE',
  'US.FRB.DFEDTARU': 'POLICY_RATE',
  'US.NYFED.EFFR': 'MONEY_MARKET',
  'US.NYFED.SOFR': 'MONEY_MARKET',
  'US.TREAS.DGS3MO': 'TREASURY',
  'US.TREAS.DGS2': 'TREASURY',
  'US.TREAS.DGS5': 'TREASURY',
  'US.TREAS.DGS10': 'TREASURY',
  'US.TREAS.DGS30': 'TREASURY',
  'US.FOMC.DECISION': 'FOMC_EVENT',
});

export const F1_SPREAD_DEFINITIONS = Object.freeze([
  Object.freeze({
    spreadCode: 'SPREAD_10Y_2Y', left: 'US.TREAS.DGS10', right: 'US.TREAS.DGS2',
  }),
  Object.freeze({
    spreadCode: 'SPREAD_10Y_3M', left: 'US.TREAS.DGS10', right: 'US.TREAS.DGS3MO',
  }),
  Object.freeze({
    spreadCode: 'SPREAD_30Y_5Y', left: 'US.TREAS.DGS30', right: 'US.TREAS.DGS5',
  }),
  Object.freeze({
    spreadCode: 'SPREAD_5Y_2Y', left: 'US.TREAS.DGS5', right: 'US.TREAS.DGS2',
  }),
  Object.freeze({
    spreadCode: 'SPREAD_2Y_3M', left: 'US.TREAS.DGS2', right: 'US.TREAS.DGS3MO',
  }),
  Object.freeze({
    spreadCode: 'SPREAD_30Y_10Y', left: 'US.TREAS.DGS30', right: 'US.TREAS.DGS10',
  }),
]);

export const MACRO_FEATURE_AVAILABILITY_STATUSES = Object.freeze([
  'AVAILABLE', 'NOT_AVAILABLE', 'WITHDRAWN', 'STALE', 'SERIES_NOT_IN_BINDING',
]);
export const MACRO_FEATURE_POLICY_DIRECTIONS = Object.freeze([
  'EASING', 'TIGHTENING', 'UNCHANGED', 'NOT_AVAILABLE',
]);
export const MACRO_FEATURE_FOMC_DECISION_TYPES = Object.freeze([
  'HIKE', 'CUT', 'HOLD', 'RANGE_RESTRUCTURE', 'WITHDRAWN', 'NOT_AVAILABLE',
]);
export const MACRO_FEATURE_CURVE_SHAPES = Object.freeze([
  'NORMAL', 'FLAT', 'PARTIALLY_INVERTED', 'INVERTED', 'MIXED', 'NOT_AVAILABLE',
]);
export const MACRO_FEATURE_CURVE_DIRECTIONS = Object.freeze([
  'STEEPENING', 'FLATTENING', 'UNCHANGED', 'MIXED', 'NOT_AVAILABLE',
]);
export const MACRO_FEATURE_RATE_REGIMES = Object.freeze([
  'LOW', 'MODERATE', 'HIGH', 'VERY_HIGH', 'NOT_AVAILABLE',
]);
export const MACRO_FEATURE_MONETARY_POLICY_REGIMES = Object.freeze([
  'EASING', 'TIGHTENING', 'HIGH_RATE_HOLD', 'MID_RATE_HOLD', 'LOW_RATE_HOLD', 'NOT_AVAILABLE',
]);
export const MACRO_FEATURE_COMPLETENESS = Object.freeze([
  'COMPLETE', 'PARTIAL', 'UNAVAILABLE',
]);

const closedFeatureRecord = closedMacroRecord;

function copyClosed(value) {
  if (Array.isArray(value)) return value.map(copyClosed);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, copyClosed(value[key])]));
  }
  return value;
}

function sameClosedValue(left, right) {
  if (Array.isArray(right)) {
    return Array.isArray(left) && left.length === right.length
      && right.every((value, index) => sameClosedValue(left[index], value));
  }
  if (right !== null && typeof right === 'object') {
    if (left === null || typeof left !== 'object' || Array.isArray(left)) return false;
    const keys = Object.keys(right);
    return Object.keys(left).length === keys.length
      && keys.every((key) => Object.hasOwn(left, key) && sameClosedValue(left[key], right[key]));
  }
  return left === right;
}

function normalizeNullableFixed(value, label) {
  if (value === null) return null;
  return normalizeMacroFixedPointValueV1(value, label);
}

function normalizeFixedPointLiteral(value, label, expectedScale) {
  const fixed = normalizeMacroFixedPointValueV1(value, label);
  if (fixed.scale !== expectedScale) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID',
      `${label}.scale must equal ${expectedScale}`);
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

function assertBoolean(value, label, code) {
  if (typeof value !== 'boolean') {
    throw new MarketDataL3Error(code, `${label} must be a boolean`);
  }
  return value;
}

/* ------------------------------------------------------------------------- *
 * MarketMacroFeatureComputationPolicy/1 — closed singleton.
 * ------------------------------------------------------------------------- */

export const MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES = Object.freeze({
  policyVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VERSION,
  jurisdictionCode: 'UNITED_STATES',
  currencyCode: 'USD',
  sessionKnowledgeCutoffPolicy: 'OFFICIAL_SESSION_CLOSE_UTC',
  observationSelectionPolicy: 'RESOLVE_AS_OF_SESSION_CLOSE_FROM_PINNED_BINDING',
  carryForwardPolicy: 'LAST_CAUSALLY_AVAILABLE_OBSERVATION_WITHOUT_FUTURE_LOOKAHEAD',
  missingDataPolicy: 'EMIT_EXPLICIT_NOT_AVAILABLE',
  fixedPointPolicy: 'INTEGER_ATOMS_WITH_EXPLICIT_SCALE',
  rateFeatureScale: 6,
  sourceBundleSelectionPolicy: 'EXPLICIT_PIN_ONLY',
  networkPolicy: 'FORBIDDEN',
  latestPolicy: 'FORBIDDEN',
  interpolationPolicy: 'FORBIDDEN',
  futureBackfillPolicy: 'FORBIDDEN',
  carryBackwardPolicy: 'FORBIDDEN',
  stalenessPolicySessionsByFamily: Object.freeze({
    POLICY_RATE: null,
    MONEY_MARKET: 5,
    TREASURY: 5,
  }),
  seriesFamilyByCode: F1_SERIES_FAMILY_BY_CODE,
  orderedSpreadDefinitions: F1_SPREAD_DEFINITIONS,
  curveShapePolicy: Object.freeze({
    flatThreshold: Object.freeze({ atoms: '10', scale: 2 }),
    inversionThreshold: Object.freeze({ atoms: '-10', scale: 2 }),
    requiredSpreadCodes: Object.freeze(['SPREAD_10Y_2Y', 'SPREAD_10Y_3M']),
    partialCurvePolicy: 'CLASSIFY_FROM_AVAILABLE_REQUIRED_SPREADS',
  }),
  rateRegimeThresholds: Object.freeze({
    lowMaxExclusive: Object.freeze({ atoms: '200', scale: 2 }),
    moderateMaxExclusive: Object.freeze({ atoms: '400', scale: 2 }),
    highMaxExclusive: Object.freeze({ atoms: '600', scale: 2 }),
  }),
  monetaryPolicyRegimePolicy: 'NOMINAL_HOLD_FROM_POLICY_RATE_LEVEL_AND_DIRECTION_ONLY',
  orderingPolicy: 'SESSION_DATE_OPEN_CLOSE_ID',
});

const POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
]);

export function normalizeMarketMacroFeatureComputationPolicyV1(value) {
  const code = 'MARKET_DATA_MACRO_FEATURE_POLICY_INVALID';
  const policy = closedFeatureRecord(value, POLICY_FIELDS,
    MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `policy field ${field} diverges from closed V1`);
    }
  }
  return {
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...copyClosed(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
  };
}

/* ------------------------------------------------------------------------- *
 * MarketMacroFeatureSourceBundle/1
 * ------------------------------------------------------------------------- */

const SOURCE_BUNDLE_FIELDS = Object.freeze([
  'schemaVersion', 'sourceBundlePolicyVersion', 'macroDatasetBindingId',
  'macroMaterializationReportId', 'macroDatasetSnapshotManifestId',
  'macroVintageSetManifestId', 'macroSeriesRegistryManifestId',
  'macroReleaseCalendarRegistryManifestId', 'macroIngestionPolicyId',
  'macroAsOfResolutionPolicyId', 'marketCalendarRegistryManifestId',
  'featureComputationStartSessionDate', 'featureComputationEndSessionDateInclusive',
  'jurisdictionCode', 'currencyCode', 'temporalCapability',
]);

export function normalizeMarketMacroFeatureSourceBundleV1(value) {
  const code = 'MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_INVALID';
  const bundle = closedFeatureRecord(value, SOURCE_BUNDLE_FIELDS,
    MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, code);
  assertSchemaVersion(bundle, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION);
  if (bundle.sourceBundlePolicyVersion !== MARKET_MACRO_FEATURE_SOURCE_BUNDLE_POLICY_VERSION) {
    throw new MarketDataL3Error(code, 'sourceBundlePolicyVersion diverges from closed V1');
  }
  for (const field of [
    'macroDatasetBindingId', 'macroMaterializationReportId',
    'macroDatasetSnapshotManifestId', 'macroVintageSetManifestId',
    'macroSeriesRegistryManifestId', 'macroReleaseCalendarRegistryManifestId',
    'macroIngestionPolicyId', 'macroAsOfResolutionPolicyId',
    'marketCalendarRegistryManifestId',
  ]) assertCasId(bundle[field], field);
  assertCivilDate(bundle.featureComputationStartSessionDate, 'featureComputationStartSessionDate');
  assertCivilDate(bundle.featureComputationEndSessionDateInclusive,
    'featureComputationEndSessionDateInclusive');
  if (bundle.featureComputationStartSessionDate
      > bundle.featureComputationEndSessionDateInclusive) {
    throw new MarketDataL3Error(code, 'featureComputationStartSessionDate must be <= end inclusive');
  }
  assertEnum(bundle.jurisdictionCode, MACRO_JURISDICTION_CODES, 'jurisdictionCode', code);
  assertEnum(bundle.currencyCode, MACRO_CURRENCY_CODES, 'currencyCode', code);
  assertEnum(bundle.temporalCapability, MACRO_BINDING_TEMPORAL_CAPABILITIES,
    'temporalCapability', code);
  return Object.fromEntries(SOURCE_BUNDLE_FIELDS.map((field) => [field, bundle[field]]));
}

/* ------------------------------------------------------------------------- *
 * Session identity projection
 * ------------------------------------------------------------------------- */

const SESSION_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'marketCalendarRegistryManifestId', 'sessionDate',
  'openUtc', 'closeUtc',
]);

export function normalizeMacroMarketSessionIdentityProjectionV1(value) {
  const code = 'MARKET_DATA_MACRO_SESSION_REGISTRY_MISMATCH';
  const identity = closedFeatureRecord(value, SESSION_IDENTITY_FIELDS,
    MACRO_MARKET_SESSION_IDENTITY_PROJECTION, code);
  assertSchemaVersion(identity, MACRO_MARKET_SESSION_IDENTITY_PROJECTION);
  assertCasId(identity.marketCalendarRegistryManifestId, 'marketCalendarRegistryManifestId');
  assertCivilDate(identity.sessionDate, 'sessionDate');
  assertMacroMaterializationUtcInstant(identity.openUtc, 'openUtc');
  assertMacroMaterializationUtcInstant(identity.closeUtc, 'closeUtc');
  if (identity.openUtc >= identity.closeUtc) {
    throw new MarketDataL3Error(code, 'session openUtc must precede closeUtc');
  }
  return Object.fromEntries(SESSION_IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

export function macroMarketSessionIdFor(components) {
  return canonicalHash(MACRO_MARKET_SESSION_IDENTITY_PROJECTION,
    normalizeMacroMarketSessionIdentityProjectionV1({
      schemaVersion: MACRO_MARKET_SESSION_IDENTITY_PROJECTION,
      marketCalendarRegistryManifestId: components.marketCalendarRegistryManifestId,
      sessionDate: components.sessionDate,
      openUtc: components.openUtc,
      closeUtc: components.closeUtc,
    }));
}

/* ------------------------------------------------------------------------- *
 * MacroStateBySessionRows/1
 * ------------------------------------------------------------------------- */

const SERIES_RESOLUTION_FIELDS = Object.freeze([
  'canonicalSeriesCode', 'macroSeriesIdentityId', 'observationIdentityId',
  'macroVintageIdentityId', 'observationVintageId', 'availableAt',
  'referencePeriod', 'revisionKind', 'completenessClass', 'value',
  'availabilityStatus', 'carryForwardAgeSessions', 'sourceDocumentId',
]);

const SPREAD_FIELDS = Object.freeze([
  'spreadCode', 'value', 'availabilityStatus', 'sourceLeftSeriesIdentityId',
  'sourceRightSeriesIdentityId', 'leftVintageIdentityId', 'rightVintageIdentityId',
  'effectiveAvailableAt', 'ageSessions',
]);

const RATE_STATE_FIELDS = Object.freeze([
  'fedTargetLowerBound', 'fedTargetUpperBound', 'fedTargetMidpoint', 'targetRangeWidth',
  'effectiveFedFundsRate', 'sofr', 'effrMinusTargetMidpoint', 'sofrMinusEffr',
  'lowerBoundChange', 'upperBoundChange', 'midpointChange', 'policyDirection',
  'sessionsSincePolicyChange', 'policyStateAvailability',
  'treasury3m', 'treasury2y', 'treasury5y', 'treasury10y', 'treasury30y',
  'policyRateLevel', 'shortRateLevel', 'longRateLevel', 'rateRegime',
  'monetaryPolicyRegime',
]);

const FOMC_STATE_FIELDS = Object.freeze([
  'lastKnownFomcDecisionEventId', 'lastKnownFomcDecisionAvailableAt',
  'lastKnownFomcDecisionSessionId', 'sessionsSinceLastFomcDecision',
  'fomcDecisionDuringSession', 'fomcDecisionType', 'targetLowerChange',
  'targetUpperChange', 'targetMidpointChange', 'nextKnownFomcEventId',
  'nextKnownFomcScheduledTimestamp', 'sessionsUntilNextKnownFomcEvent',
  'nextEventKnowledgeAvailableAt', 'fomcCalendarStatus', 'fomcStateAvailability',
]);

const CURVE_STATE_FIELDS = Object.freeze([
  'orderedSpreads', 'curveShape', 'curveDirection', 'curveChange10y2y',
  'curveChange10y3m', 'sessionsSinceCurveDirectionChange', 'curveRegime',
]);

const AVAILABILITY_STATE_FIELDS = Object.freeze([
  'availableSeriesCount', 'missingSeriesCount', 'staleSeriesCount',
  'withdrawnSeriesCount', 'availableCurveSpreadCount', 'requiredCurveSpreadCount',
  'rateStateCompleteness', 'curveStateCompleteness', 'fomcStateCompleteness',
  'overallF1Completeness',
]);

const PROVENANCE_STATE_FIELDS = Object.freeze([
  'macroMaterializationReportId', 'sessionCloseUtc', 'orderedSeriesResolutions',
  'lastFomcReleaseEventVersionId', 'nextFomcReleaseEventVersionId',
  'orderedFeatureProvenanceDigest',
]);

const ROW_IDENTITY_FIELDS = Object.freeze([
  'sessionId', 'sessionDate', 'sessionOpenUtc', 'sessionCloseUtc', 'sessionKind',
  'jurisdictionCode', 'currencyCode', 'marketCalendarRegistryManifestId',
  'macroDatasetBindingId', 'featureComputationPolicyId', 'sourceBundleId',
]);

const ROW_FIELDS = Object.freeze([
  ...ROW_IDENTITY_FIELDS,
  'rateState', 'fomcState', 'curveState', 'availabilityState', 'provenanceState',
]);

const ROWS_FIELDS = Object.freeze(['schemaVersion', 'rows']);

function normalizeSeriesResolution(value, index) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const label = `orderedSeriesResolutions[${index}]`;
  const row = closedFeatureRecord(value, SERIES_RESOLUTION_FIELDS, label, code);
  assertEnum(row.canonicalSeriesCode, F1_SERIES_CODES, `${label}.canonicalSeriesCode`, code);
  assertCasId(row.macroSeriesIdentityId, `${label}.macroSeriesIdentityId`, true);
  assertCasId(row.observationIdentityId, `${label}.observationIdentityId`, true);
  assertCasId(row.macroVintageIdentityId, `${label}.macroVintageIdentityId`, true);
  assertCasId(row.observationVintageId, `${label}.observationVintageId`, true);
  assertMacroMaterializationUtcInstant(row.availableAt, `${label}.availableAt`, true);
  if (row.referencePeriod !== null && typeof row.referencePeriod !== 'string') {
    throw new MarketDataL3Error(code, `${label}.referencePeriod must be string or null`);
  }
  if (row.revisionKind !== null && typeof row.revisionKind !== 'string') {
    throw new MarketDataL3Error(code, `${label}.revisionKind must be string or null`);
  }
  if (row.completenessClass !== null && typeof row.completenessClass !== 'string') {
    throw new MarketDataL3Error(code, `${label}.completenessClass must be string or null`);
  }
  const normalizedValue = normalizeNullableFixed(row.value, `${label}.value`);
  assertEnum(row.availabilityStatus, MACRO_FEATURE_AVAILABILITY_STATUSES,
    `${label}.availabilityStatus`, code);
  assertSafeInteger(row.carryForwardAgeSessions, `${label}.carryForwardAgeSessions`, {
    nonNegative: true,
  });
  assertCasId(row.sourceDocumentId, `${label}.sourceDocumentId`, true);
  return {
    canonicalSeriesCode: row.canonicalSeriesCode,
    macroSeriesIdentityId: row.macroSeriesIdentityId,
    observationIdentityId: row.observationIdentityId,
    macroVintageIdentityId: row.macroVintageIdentityId,
    observationVintageId: row.observationVintageId,
    availableAt: row.availableAt,
    referencePeriod: row.referencePeriod,
    revisionKind: row.revisionKind,
    completenessClass: row.completenessClass,
    value: normalizedValue,
    availabilityStatus: row.availabilityStatus,
    carryForwardAgeSessions: row.carryForwardAgeSessions,
    sourceDocumentId: row.sourceDocumentId,
  };
}

function normalizeSpread(value, index) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const label = `orderedSpreads[${index}]`;
  const spread = closedFeatureRecord(value, SPREAD_FIELDS, label, code);
  const allowedCodes = F1_SPREAD_DEFINITIONS.map((item) => item.spreadCode);
  assertEnum(spread.spreadCode, allowedCodes, `${label}.spreadCode`, code);
  const normalizedValue = normalizeNullableFixed(spread.value, `${label}.value`);
  assertEnum(spread.availabilityStatus, MACRO_FEATURE_AVAILABILITY_STATUSES,
    `${label}.availabilityStatus`, code);
  assertCasId(spread.sourceLeftSeriesIdentityId, `${label}.sourceLeftSeriesIdentityId`, true);
  assertCasId(spread.sourceRightSeriesIdentityId, `${label}.sourceRightSeriesIdentityId`, true);
  assertCasId(spread.leftVintageIdentityId, `${label}.leftVintageIdentityId`, true);
  assertCasId(spread.rightVintageIdentityId, `${label}.rightVintageIdentityId`, true);
  assertMacroMaterializationUtcInstant(spread.effectiveAvailableAt,
    `${label}.effectiveAvailableAt`, true);
  assertSafeInteger(spread.ageSessions, `${label}.ageSessions`, { nonNegative: true });
  return {
    spreadCode: spread.spreadCode,
    value: normalizedValue,
    availabilityStatus: spread.availabilityStatus,
    sourceLeftSeriesIdentityId: spread.sourceLeftSeriesIdentityId,
    sourceRightSeriesIdentityId: spread.sourceRightSeriesIdentityId,
    leftVintageIdentityId: spread.leftVintageIdentityId,
    rightVintageIdentityId: spread.rightVintageIdentityId,
    effectiveAvailableAt: spread.effectiveAvailableAt,
    ageSessions: spread.ageSessions,
  };
}

function normalizeRateState(value) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const state = closedFeatureRecord(value, RATE_STATE_FIELDS, 'rateState', code);
  const out = {};
  for (const field of [
    'fedTargetLowerBound', 'fedTargetUpperBound', 'fedTargetMidpoint', 'targetRangeWidth',
    'effectiveFedFundsRate', 'sofr', 'effrMinusTargetMidpoint', 'sofrMinusEffr',
    'lowerBoundChange', 'upperBoundChange', 'midpointChange',
    'treasury3m', 'treasury2y', 'treasury5y', 'treasury10y', 'treasury30y',
    'policyRateLevel', 'shortRateLevel', 'longRateLevel',
  ]) {
    out[field] = normalizeNullableFixed(state[field], `rateState.${field}`);
  }
  assertEnum(state.policyDirection, MACRO_FEATURE_POLICY_DIRECTIONS,
    'rateState.policyDirection', code);
  if (state.sessionsSincePolicyChange !== null) {
    assertSafeInteger(state.sessionsSincePolicyChange, 'rateState.sessionsSincePolicyChange', {
      nonNegative: true,
    });
  }
  out.policyDirection = state.policyDirection;
  out.sessionsSincePolicyChange = state.sessionsSincePolicyChange;
  assertEnum(state.policyStateAvailability, MACRO_FEATURE_COMPLETENESS,
    'rateState.policyStateAvailability', code);
  out.policyStateAvailability = state.policyStateAvailability;
  assertEnum(state.rateRegime, MACRO_FEATURE_RATE_REGIMES, 'rateState.rateRegime', code);
  out.rateRegime = state.rateRegime;
  assertEnum(state.monetaryPolicyRegime, MACRO_FEATURE_MONETARY_POLICY_REGIMES,
    'rateState.monetaryPolicyRegime', code);
  out.monetaryPolicyRegime = state.monetaryPolicyRegime;
  return out;
}

function normalizeFomcState(value) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const state = closedFeatureRecord(value, FOMC_STATE_FIELDS, 'fomcState', code);
  assertCasId(state.lastKnownFomcDecisionEventId, 'fomcState.lastKnownFomcDecisionEventId', true);
  assertMacroMaterializationUtcInstant(state.lastKnownFomcDecisionAvailableAt,
    'fomcState.lastKnownFomcDecisionAvailableAt', true);
  assertCasId(state.lastKnownFomcDecisionSessionId, 'fomcState.lastKnownFomcDecisionSessionId', true);
  if (state.sessionsSinceLastFomcDecision !== null) {
    assertSafeInteger(state.sessionsSinceLastFomcDecision,
      'fomcState.sessionsSinceLastFomcDecision', { nonNegative: true });
  }
  assertBoolean(state.fomcDecisionDuringSession, 'fomcState.fomcDecisionDuringSession', code);
  assertEnum(state.fomcDecisionType, MACRO_FEATURE_FOMC_DECISION_TYPES,
    'fomcState.fomcDecisionType', code);
  const out = {
    lastKnownFomcDecisionEventId: state.lastKnownFomcDecisionEventId,
    lastKnownFomcDecisionAvailableAt: state.lastKnownFomcDecisionAvailableAt,
    lastKnownFomcDecisionSessionId: state.lastKnownFomcDecisionSessionId,
    sessionsSinceLastFomcDecision: state.sessionsSinceLastFomcDecision,
    fomcDecisionDuringSession: state.fomcDecisionDuringSession,
    fomcDecisionType: state.fomcDecisionType,
    targetLowerChange: normalizeNullableFixed(state.targetLowerChange, 'fomcState.targetLowerChange'),
    targetUpperChange: normalizeNullableFixed(state.targetUpperChange, 'fomcState.targetUpperChange'),
    targetMidpointChange: normalizeNullableFixed(state.targetMidpointChange,
      'fomcState.targetMidpointChange'),
    nextKnownFomcEventId: state.nextKnownFomcEventId,
    nextKnownFomcScheduledTimestamp: state.nextKnownFomcScheduledTimestamp,
    sessionsUntilNextKnownFomcEvent: state.sessionsUntilNextKnownFomcEvent,
    nextEventKnowledgeAvailableAt: state.nextEventKnowledgeAvailableAt,
    fomcCalendarStatus: state.fomcCalendarStatus,
    fomcStateAvailability: state.fomcStateAvailability,
  };
  assertCasId(out.nextKnownFomcEventId, 'fomcState.nextKnownFomcEventId', true);
  assertMacroMaterializationUtcInstant(out.nextKnownFomcScheduledTimestamp,
    'fomcState.nextKnownFomcScheduledTimestamp', true);
  if (out.sessionsUntilNextKnownFomcEvent !== null) {
    assertSafeInteger(out.sessionsUntilNextKnownFomcEvent,
      'fomcState.sessionsUntilNextKnownFomcEvent', { nonNegative: true });
  }
  assertMacroMaterializationUtcInstant(out.nextEventKnowledgeAvailableAt,
    'fomcState.nextEventKnowledgeAvailableAt', true);
  if (out.fomcCalendarStatus !== null && typeof out.fomcCalendarStatus !== 'string') {
    throw new MarketDataL3Error(code, 'fomcState.fomcCalendarStatus must be string or null');
  }
  assertEnum(out.fomcStateAvailability, MACRO_FEATURE_COMPLETENESS,
    'fomcState.fomcStateAvailability', code);
  return out;
}

function normalizeCurveState(value) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const state = closedFeatureRecord(value, CURVE_STATE_FIELDS, 'curveState', code);
  if (!Array.isArray(state.orderedSpreads)) {
    throw new MarketDataL3Error(code, 'curveState.orderedSpreads must be an array');
  }
  if (state.orderedSpreads.length !== F1_SPREAD_DEFINITIONS.length) {
    throw new MarketDataL3Error(code, 'curveState.orderedSpreads must cover the closed spread set');
  }
  const orderedSpreads = state.orderedSpreads.map((spread, index) => normalizeSpread(spread, index));
  for (let index = 0; index < F1_SPREAD_DEFINITIONS.length; index += 1) {
    if (orderedSpreads[index].spreadCode !== F1_SPREAD_DEFINITIONS[index].spreadCode) {
      throw new MarketDataL3Error(code, 'curveState.orderedSpreads order diverges from policy');
    }
  }
  assertEnum(state.curveShape, MACRO_FEATURE_CURVE_SHAPES, 'curveState.curveShape', code);
  assertEnum(state.curveDirection, MACRO_FEATURE_CURVE_DIRECTIONS, 'curveState.curveDirection', code);
  if (state.sessionsSinceCurveDirectionChange !== null) {
    assertSafeInteger(state.sessionsSinceCurveDirectionChange,
      'curveState.sessionsSinceCurveDirectionChange', { nonNegative: true });
  }
  assertEnum(state.curveRegime, MACRO_FEATURE_CURVE_SHAPES, 'curveState.curveRegime', code);
  return {
    orderedSpreads,
    curveShape: state.curveShape,
    curveDirection: state.curveDirection,
    curveChange10y2y: normalizeNullableFixed(state.curveChange10y2y, 'curveState.curveChange10y2y'),
    curveChange10y3m: normalizeNullableFixed(state.curveChange10y3m, 'curveState.curveChange10y3m'),
    sessionsSinceCurveDirectionChange: state.sessionsSinceCurveDirectionChange,
    curveRegime: state.curveRegime,
  };
}

function normalizeAvailabilityState(value) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const state = closedFeatureRecord(value, AVAILABILITY_STATE_FIELDS, 'availabilityState', code);
  const out = {};
  for (const field of [
    'availableSeriesCount', 'missingSeriesCount', 'staleSeriesCount',
    'withdrawnSeriesCount', 'availableCurveSpreadCount', 'requiredCurveSpreadCount',
  ]) {
    assertSafeInteger(state[field], `availabilityState.${field}`, { nonNegative: true });
    out[field] = state[field];
  }
  for (const field of [
    'rateStateCompleteness', 'curveStateCompleteness', 'fomcStateCompleteness',
    'overallF1Completeness',
  ]) {
    assertEnum(state[field], MACRO_FEATURE_COMPLETENESS, `availabilityState.${field}`, code);
    out[field] = state[field];
  }
  return out;
}

function normalizeProvenanceState(value) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const state = closedFeatureRecord(value, PROVENANCE_STATE_FIELDS, 'provenanceState', code);
  assertCasId(state.macroMaterializationReportId, 'provenanceState.macroMaterializationReportId');
  assertMacroMaterializationUtcInstant(state.sessionCloseUtc, 'provenanceState.sessionCloseUtc');
  if (!Array.isArray(state.orderedSeriesResolutions)) {
    throw new MarketDataL3Error(code, 'provenanceState.orderedSeriesResolutions must be an array');
  }
  if (state.orderedSeriesResolutions.length !== F1_SERIES_CODES.length) {
    throw new MarketDataL3Error(code, 'provenanceState.orderedSeriesResolutions must cover F1 series');
  }
  const orderedSeriesResolutions = state.orderedSeriesResolutions
    .map((row, index) => normalizeSeriesResolution(row, index));
  for (let index = 0; index < F1_SERIES_CODES.length; index += 1) {
    if (orderedSeriesResolutions[index].canonicalSeriesCode !== F1_SERIES_CODES[index]) {
      throw new MarketDataL3Error(code, 'orderedSeriesResolutions order diverges from F1_SERIES_CODES');
    }
  }
  assertCasId(state.lastFomcReleaseEventVersionId,
    'provenanceState.lastFomcReleaseEventVersionId', true);
  assertCasId(state.nextFomcReleaseEventVersionId,
    'provenanceState.nextFomcReleaseEventVersionId', true);
  assertCasId(state.orderedFeatureProvenanceDigest,
    'provenanceState.orderedFeatureProvenanceDigest');
  return {
    macroMaterializationReportId: state.macroMaterializationReportId,
    sessionCloseUtc: state.sessionCloseUtc,
    orderedSeriesResolutions,
    lastFomcReleaseEventVersionId: state.lastFomcReleaseEventVersionId,
    nextFomcReleaseEventVersionId: state.nextFomcReleaseEventVersionId,
    orderedFeatureProvenanceDigest: state.orderedFeatureProvenanceDigest,
  };
}

export function normalizeMacroStateBySessionRowV1(value, index = 0) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const label = `rows[${index}]`;
  const row = closedFeatureRecord(value, ROW_FIELDS, label, code);
  assertCasId(row.sessionId, `${label}.sessionId`);
  assertCivilDate(row.sessionDate, `${label}.sessionDate`);
  assertMacroMaterializationUtcInstant(row.sessionOpenUtc, `${label}.sessionOpenUtc`);
  assertMacroMaterializationUtcInstant(row.sessionCloseUtc, `${label}.sessionCloseUtc`);
  assertEnum(row.sessionKind, MARKET_CALENDAR_SESSION_KINDS, `${label}.sessionKind`, code);
  assertEnum(row.jurisdictionCode, MACRO_JURISDICTION_CODES, `${label}.jurisdictionCode`, code);
  assertEnum(row.currencyCode, MACRO_CURRENCY_CODES, `${label}.currencyCode`, code);
  for (const field of [
    'marketCalendarRegistryManifestId', 'macroDatasetBindingId',
    'featureComputationPolicyId', 'sourceBundleId',
  ]) assertCasId(row[field], `${label}.${field}`);
  const expectedSessionId = macroMarketSessionIdFor({
    marketCalendarRegistryManifestId: row.marketCalendarRegistryManifestId,
    sessionDate: row.sessionDate,
    openUtc: row.sessionOpenUtc,
    closeUtc: row.sessionCloseUtc,
  });
  if (row.sessionId !== expectedSessionId) {
    throw new MarketDataL3Error(code, `${label}.sessionId diverges from MacroMarketSessionIdentity/1`);
  }
  return {
    sessionId: row.sessionId,
    sessionDate: row.sessionDate,
    sessionOpenUtc: row.sessionOpenUtc,
    sessionCloseUtc: row.sessionCloseUtc,
    sessionKind: row.sessionKind,
    jurisdictionCode: row.jurisdictionCode,
    currencyCode: row.currencyCode,
    marketCalendarRegistryManifestId: row.marketCalendarRegistryManifestId,
    macroDatasetBindingId: row.macroDatasetBindingId,
    featureComputationPolicyId: row.featureComputationPolicyId,
    sourceBundleId: row.sourceBundleId,
    rateState: normalizeRateState(row.rateState),
    fomcState: normalizeFomcState(row.fomcState),
    curveState: normalizeCurveState(row.curveState),
    availabilityState: normalizeAvailabilityState(row.availabilityState),
    provenanceState: normalizeProvenanceState(row.provenanceState),
  };
}

export function normalizeMacroStateBySessionRowsV1(value) {
  const code = 'MARKET_DATA_MACRO_STATE_ROWS_INVALID';
  const container = closedFeatureRecord(value, ROWS_FIELDS,
    MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, code);
  assertSchemaVersion(container, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION);
  if (!Array.isArray(container.rows)) {
    throw new MarketDataL3Error(code, 'rows must be an array');
  }
  const rows = container.rows.map((row, index) => normalizeMacroStateBySessionRowV1(row, index));
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const ordered = compareMacroSessionOrderKeys(previous, current) < 0;
    if (!ordered) {
      throw new MarketDataL3Error(code, 'rows must be sorted by sessionDate/open/close/sessionId');
    }
  }
  return {
    schemaVersion: MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
    rows,
  };
}

export function compareMacroSessionOrderKeys(left, right) {
  for (const field of ['sessionDate', 'sessionOpenUtc', 'sessionCloseUtc', 'sessionId']) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------------- *
 * MarketMacroFeatureComputationReport/1
 * ------------------------------------------------------------------------- */

const REPORT_FIELDS = Object.freeze([
  'schemaVersion', 'sourceBundleId', 'featureComputationPolicyId',
  'macroStateBySessionRowsId', 'macroDatasetBindingId', 'macroMaterializationReportId',
  'marketCalendarRegistryManifestId', 'firstSessionId', 'lastSessionId',
  'firstSessionDate', 'lastSessionDate', 'sessionCount', 'completeSessionCount',
  'partialSessionCount', 'unavailableSessionCount', 'sessionWithFomcDecisionCount',
  'easingSessionCount', 'tighteningSessionCount', 'holdSessionCount',
  'normalCurveSessionCount', 'flatCurveSessionCount', 'partiallyInvertedCurveSessionCount',
  'invertedCurveSessionCount', 'mixedCurveSessionCount',
  'missingSeriesResolutionCount', 'staleSeriesResolutionCount',
  'withdrawnSeriesResolutionCount', 'futureObservationRejectedCount',
  'futureVintageRejectedCount', 'futureCalendarUpdateRejectedCount',
  'orderedSessionIdentityDigest', 'orderedRowIdentityDigest',
  'orderedFeatureProvenanceDigest', 'countsByPolicyDirection', 'countsByCurveShape',
  'countsByCompleteness', 'emptyComputation',
]);

export function normalizeMarketMacroFeatureComputationReportV1(value) {
  const code = 'MARKET_DATA_MACRO_FEATURE_REPORT_INVALID';
  const report = closedFeatureRecord(value, REPORT_FIELDS,
    MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, code);
  assertSchemaVersion(report, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION);
  for (const field of [
    'sourceBundleId', 'featureComputationPolicyId', 'macroStateBySessionRowsId',
    'macroDatasetBindingId', 'macroMaterializationReportId',
    'marketCalendarRegistryManifestId',
  ]) assertCasId(report[field], field);
  assertCasId(report.firstSessionId, 'firstSessionId', true);
  assertCasId(report.lastSessionId, 'lastSessionId', true);
  if (report.firstSessionDate !== null) assertCivilDate(report.firstSessionDate, 'firstSessionDate');
  if (report.lastSessionDate !== null) assertCivilDate(report.lastSessionDate, 'lastSessionDate');
  for (const field of [
    'sessionCount', 'completeSessionCount', 'partialSessionCount', 'unavailableSessionCount',
    'sessionWithFomcDecisionCount', 'easingSessionCount', 'tighteningSessionCount',
    'holdSessionCount', 'normalCurveSessionCount', 'flatCurveSessionCount',
    'partiallyInvertedCurveSessionCount', 'invertedCurveSessionCount', 'mixedCurveSessionCount',
    'missingSeriesResolutionCount', 'staleSeriesResolutionCount',
    'withdrawnSeriesResolutionCount', 'futureObservationRejectedCount',
    'futureVintageRejectedCount', 'futureCalendarUpdateRejectedCount',
  ]) assertSafeInteger(report[field], field, { nonNegative: true });
  for (const field of [
    'orderedSessionIdentityDigest', 'orderedRowIdentityDigest', 'orderedFeatureProvenanceDigest',
  ]) assertCasId(report[field], field);
  const countsByPolicyDirection = normalizeCountMap(report.countsByPolicyDirection,
    MACRO_FEATURE_POLICY_DIRECTIONS, 'countsByPolicyDirection', code);
  const countsByCurveShape = normalizeCountMap(report.countsByCurveShape,
    MACRO_FEATURE_CURVE_SHAPES, 'countsByCurveShape', code);
  const countsByCompleteness = normalizeCountMap(report.countsByCompleteness,
    MACRO_FEATURE_COMPLETENESS, 'countsByCompleteness', code);
  assertBoolean(report.emptyComputation, 'emptyComputation', code);
  const expectedEmpty = report.sessionCount === 0;
  if (report.emptyComputation !== expectedEmpty) {
    throw new MarketDataL3Error(code, 'emptyComputation diverges from sessionCount');
  }
  if ((report.sessionCount === 0) !== (report.firstSessionId === null)
      || (report.firstSessionId === null) !== (report.lastSessionId === null)
      || (report.firstSessionDate === null) !== (report.lastSessionDate === null)) {
    throw new MarketDataL3Error(code, 'empty session bounds diverge from sessionCount');
  }
  return {
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    sourceBundleId: report.sourceBundleId,
    featureComputationPolicyId: report.featureComputationPolicyId,
    macroStateBySessionRowsId: report.macroStateBySessionRowsId,
    macroDatasetBindingId: report.macroDatasetBindingId,
    macroMaterializationReportId: report.macroMaterializationReportId,
    marketCalendarRegistryManifestId: report.marketCalendarRegistryManifestId,
    firstSessionId: report.firstSessionId,
    lastSessionId: report.lastSessionId,
    firstSessionDate: report.firstSessionDate,
    lastSessionDate: report.lastSessionDate,
    sessionCount: report.sessionCount,
    completeSessionCount: report.completeSessionCount,
    partialSessionCount: report.partialSessionCount,
    unavailableSessionCount: report.unavailableSessionCount,
    sessionWithFomcDecisionCount: report.sessionWithFomcDecisionCount,
    easingSessionCount: report.easingSessionCount,
    tighteningSessionCount: report.tighteningSessionCount,
    holdSessionCount: report.holdSessionCount,
    normalCurveSessionCount: report.normalCurveSessionCount,
    flatCurveSessionCount: report.flatCurveSessionCount,
    partiallyInvertedCurveSessionCount: report.partiallyInvertedCurveSessionCount,
    invertedCurveSessionCount: report.invertedCurveSessionCount,
    mixedCurveSessionCount: report.mixedCurveSessionCount,
    missingSeriesResolutionCount: report.missingSeriesResolutionCount,
    staleSeriesResolutionCount: report.staleSeriesResolutionCount,
    withdrawnSeriesResolutionCount: report.withdrawnSeriesResolutionCount,
    futureObservationRejectedCount: report.futureObservationRejectedCount,
    futureVintageRejectedCount: report.futureVintageRejectedCount,
    futureCalendarUpdateRejectedCount: report.futureCalendarUpdateRejectedCount,
    orderedSessionIdentityDigest: report.orderedSessionIdentityDigest,
    orderedRowIdentityDigest: report.orderedRowIdentityDigest,
    orderedFeatureProvenanceDigest: report.orderedFeatureProvenanceDigest,
    countsByPolicyDirection,
    countsByCurveShape,
    countsByCompleteness,
    emptyComputation: report.emptyComputation,
  };
}

/** Re-export helpers used by feature modules. */
export {
  closedFeatureRecord,
  copyClosed,
  sameClosedValue,
  normalizeNullableFixed,
  normalizeFixedPointLiteral,
  canonicalDigest,
};
