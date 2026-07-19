/**
 * L4A-A — closed canonical contracts for deterministic point-in-time market
 * technical features. This layer computes features only: no model, score,
 * recommendation, scanner import, network access or wall clock.
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
} from './marketDataL3CommonV1.mjs';

export const MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION =
  'MarketTechnicalFeatureSourceBundle/1';
export const MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION =
  'MarketTechnicalFeatureComputationPolicy/1';
export const MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION =
  'MarketTechnicalFeatureComputationReport/1';
export const MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION = 'MarketTechnicalFeatureRows/1';

export const MARKET_TECHNICAL_FEATURE_L4_SCHEMA_VERSIONS = Object.freeze([
  MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
]);

export const MARKET_TECHNICAL_BENCHMARK_ROLES = Object.freeze([
  'MARKET', 'SECTOR', 'UNDERLYING',
]);

export const MARKET_TECHNICAL_AVAILABILITY_CODES = Object.freeze([
  'AVAILABLE',
  'INSUFFICIENT_HISTORY',
  'MISSING_INPUT',
  'DIVISION_BY_ZERO',
  'FLAT_RANGE',
  'BENCHMARK_NOT_CONFIGURED',
  'BENCHMARK_SESSION_MISSING',
  'INCOMPATIBLE_BENCHMARK',
]);

export const MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS = Object.freeze({
  returnsDrawdowns: 'L4A-A1/1',
  volatility: 'L4A-A2/1',
  momentum: 'L4A-A3/1',
  trend: 'L4A-A4/1',
  relativeStrength: 'L4A-A4-RS/1',
});

export const MARKET_TECHNICAL_FEATURE_POLICY_VALUES = Object.freeze({
  numericRepresentation: 'FIXED_POINT_BIGINT_V1',
  calculationScale: 24,
  ratioScale: 12,
  priceFeatureScale: 12,
  roundingMode: 'HALF_EVEN',
  rowOrdering: 'SESSION_DATE_THEN_BAR_IDENTITY',
  missingHistoryPolicy: 'NULL_WITH_REASON',
  benchmarkAlignment: 'EXACT_SESSION_DATE',
  futureDataPolicy: 'FORBIDDEN',
  peakTiePolicy: 'MOST_RECENT_SESSION',
  trueRangeFirstSessionPolicy: 'HIGH_MINUS_LOW',
  realizedVolatilityEstimator: 'SAMPLE_STANDARD_DEVIATION_SIMPLE_RETURNS',
  annualizationSessions: 252,
  returnPeriods: [1, 3, 5, 10, 20, 60],
  drawdownPeriods: [20, 60, 252],
  realizedVolatilityPeriods: [5, 10, 20, 60],
  atrPeriod: 14,
  rsiPeriod: 14,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  stochasticPeriod: 14,
  stochasticDPeriod: 3,
  stochRsiPeriod: 14,
  stochRsiKPeriod: 3,
  stochRsiDPeriod: 3,
  cciPeriod: 20,
  smaPeriods: [20, 50, 200],
  emaPeriods: [8, 34, 50, 200],
  trendChangePeriod: 5,
  adxPeriod: 14,
});

export const RETURNS_DRAWDOWNS_FEATURE_NAMES = Object.freeze([
  'return1', 'return3', 'return5', 'return10', 'return20', 'return60',
  'drawdownFromRunningPeak', 'drawdownFrom20SessionPeak',
  'drawdownFrom60SessionPeak', 'drawdownFrom252SessionPeak',
  'sessionsSinceRunningPeak', 'sessionsSince20SessionPeak',
  'sessionsSince60SessionPeak', 'sessionsSince252SessionPeak',
]);

export const VOLATILITY_FEATURE_NAMES = Object.freeze([
  'trueRange', 'atr14', 'atr14Pct', 'intradayRangePct', 'gapOpenPct',
  'closeLocationValue', 'realizedVolatility5', 'realizedVolatility10',
  'realizedVolatility20', 'realizedVolatility60', 'volatilityAcceleration20vs60',
]);

export const MOMENTUM_FEATURE_NAMES = Object.freeze([
  'rsi14', 'macdLine', 'macdSignal', 'macdHistogram',
  'stochasticK14', 'stochasticD3', 'stochRsiRaw', 'stochRsiK',
  'stochRsiD', 'cci20', 'roc5', 'roc10', 'roc20',
]);

export const TREND_FEATURE_NAMES = Object.freeze([
  'sma20', 'sma50', 'sma200', 'ema8', 'ema34', 'ema50', 'ema200',
  'distanceToSma20', 'distanceToSma50', 'distanceToSma200',
  'distanceToEma8', 'distanceToEma34', 'distanceToEma50', 'distanceToEma200',
  'ema8Change5', 'ema34Change5', 'ema50Change5', 'ema200Change5',
  'sma20Change5', 'sma50Change5', 'sma200Change5',
  'closeAboveEma8', 'closeAboveEma34', 'closeAboveEma50', 'closeAboveEma200',
  'ema8AboveEma34', 'ema34AboveEma50', 'ema50AboveEma200',
  'plusDi14', 'minusDi14', 'adx14',
]);

export const RELATIVE_STRENGTH_FEATURE_NAMES = Object.freeze([
  'relativePriceRatio', 'relativeReturn5', 'relativeReturn20',
  'relativeReturn60', 'relativeRatioChange20', 'relativeRatioChange60',
]);

const PRICE_FEATURE_NAMES = new Set([
  'trueRange', 'atr14', 'macdLine', 'macdSignal', 'macdHistogram',
  'sma20', 'sma50', 'sma200', 'ema8', 'ema34', 'ema50', 'ema200',
]);
const INTEGER_FEATURE_NAMES = new Set([
  'sessionsSinceRunningPeak', 'sessionsSince20SessionPeak',
  'sessionsSince60SessionPeak', 'sessionsSince252SessionPeak',
]);
const BOOLEAN_FEATURE_NAMES = new Set([
  'closeAboveEma8', 'closeAboveEma34', 'closeAboveEma50', 'closeAboveEma200',
  'ema8AboveEma34', 'ema34AboveEma50', 'ema50AboveEma200',
]);

const BINDING_REFERENCE_FIELDS = Object.freeze(['bindingRegistryManifestId', 'bindingId']);
const BENCHMARK_REFERENCE_FIELDS = Object.freeze(['role', ...BINDING_REFERENCE_FIELDS]);
const SOURCE_BUNDLE_FIELDS = Object.freeze(['schemaVersion', 'subject', 'benchmarks']);
const POLICY_FIELDS = Object.freeze(['schemaVersion', ...Object.keys(MARKET_TECHNICAL_FEATURE_POLICY_VALUES)]);
const ROWS_FIELDS = Object.freeze(['schemaVersion', 'rows']);
const ROW_FIELDS = Object.freeze([
  'sessionDate', 'subjectBarIdentityId', 'subjectResolvedObservationId',
  'sourceBindingId', 'features', 'availability',
]);
const FAMILY_FIELDS = Object.freeze([
  'returnsDrawdowns', 'volatility', 'momentum', 'trend', 'relativeStrength',
]);
const REPORT_FIELDS = Object.freeze([
  'schemaVersion', 'technicalFeatureSourceBundleId',
  'technicalFeatureComputationPolicyId', 'technicalFeatureRowsId',
  'subjectBindingId', 'benchmarkBindingIds', 'rowCount',
  'firstSessionDate', 'lastSessionDate', 'featureSchemaVersion',
  'featureFamilyVersions', 'availabilityCounts',
]);

/** @param {unknown} value @param {string} label */
function normalizeBindingReference(value, label) {
  const reference = assertPlainObject(value, label);
  assertExactFields(reference, BINDING_REFERENCE_FIELDS);
  assertCasId(reference.bindingRegistryManifestId, `${label}.bindingRegistryManifestId`);
  assertCasId(reference.bindingId, `${label}.bindingId`);
  return {
    bindingRegistryManifestId: reference.bindingRegistryManifestId,
    bindingId: reference.bindingId,
  };
}

/** @param {unknown} value */
export function normalizeMarketTechnicalFeatureSourceBundleV1(value) {
  const bundle = assertPlainObject(value, MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION);
  assertSchemaVersion(bundle, MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION);
  assertExactFields(bundle, SOURCE_BUNDLE_FIELDS);
  const subject = normalizeBindingReference(bundle.subject, 'subject');
  if (!Array.isArray(bundle.benchmarks)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'benchmarks must be an array');
  }
  const seen = new Set();
  const benchmarks = bundle.benchmarks.map((item, index) => {
    const benchmark = assertPlainObject(item, `benchmarks[${index}]`);
    assertExactFields(benchmark, BENCHMARK_REFERENCE_FIELDS);
    assertEnum(benchmark.role, MARKET_TECHNICAL_BENCHMARK_ROLES, `benchmarks[${index}].role`);
    if (seen.has(benchmark.role)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID', 'benchmarks contains a duplicate role', { role: benchmark.role },
      );
    }
    seen.add(benchmark.role);
    return { role: benchmark.role, ...normalizeBindingReference(benchmark, `benchmarks[${index}]`) };
  });
  benchmarks.sort((left, right) => (
    MARKET_TECHNICAL_BENCHMARK_ROLES.indexOf(left.role)
    - MARKET_TECHNICAL_BENCHMARK_ROLES.indexOf(right.role)
  ));
  return {
    schemaVersion: MARKET_TECHNICAL_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    subject,
    benchmarks,
  };
}

/** @param {unknown} value */
export function normalizeMarketTechnicalFeatureComputationPolicyV1(value) {
  const policy = assertPlainObject(value, MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION);
  assertExactFields(policy, POLICY_FIELDS);
  for (const field of Object.keys(MARKET_TECHNICAL_FEATURE_POLICY_VALUES)) {
    const expected = MARKET_TECHNICAL_FEATURE_POLICY_VALUES[field];
    const actual = policy[field];
    const equal = Array.isArray(expected)
      ? Array.isArray(actual) && expected.length === actual.length
        && expected.every((item, index) => item === actual[index])
      : actual === expected;
    if (!equal) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID', `policy field ${field} must be the closed V1 value`,
        { field, expected, actual },
      );
    }
  }
  return {
    schemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_TECHNICAL_FEATURE_POLICY_VALUES,
    returnPeriods: [...MARKET_TECHNICAL_FEATURE_POLICY_VALUES.returnPeriods],
    drawdownPeriods: [...MARKET_TECHNICAL_FEATURE_POLICY_VALUES.drawdownPeriods],
    realizedVolatilityPeriods: [...MARKET_TECHNICAL_FEATURE_POLICY_VALUES.realizedVolatilityPeriods],
    smaPeriods: [...MARKET_TECHNICAL_FEATURE_POLICY_VALUES.smaPeriods],
    emaPeriods: [...MARKET_TECHNICAL_FEATURE_POLICY_VALUES.emaPeriods],
  };
}

/** @param {unknown} value @param {string} label @param {number} scale */
function normalizeFixedPoint(value, label, scale) {
  const fixed = assertPlainObject(value, label);
  assertExactFields(fixed, ['atoms', 'scale']);
  if (typeof fixed.atoms !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(fixed.atoms) || fixed.atoms === '-0') {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label}.atoms must be a canonical signed integer string`);
  }
  if (fixed.scale !== scale) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label}.scale must equal ${scale}`);
  }
  return { atoms: fixed.atoms, scale };
}

/** @param {unknown} value @param {unknown} availability @param {string} name @param {string} label */
function normalizeFeatureValue(value, availability, name, label) {
  assertEnum(availability, MARKET_TECHNICAL_AVAILABILITY_CODES, `${label}.availability`);
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
  return normalizeFixedPoint(value, label, PRICE_FEATURE_NAMES.has(name) ? 12 : 12);
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

/** @param {unknown} values @param {unknown} availability */
function normalizeRelativeStrength(values, availability) {
  const group = assertPlainObject(values, 'features.relativeStrength');
  const reasons = assertPlainObject(availability, 'availability.relativeStrength');
  assertExactFields(group, MARKET_TECHNICAL_BENCHMARK_ROLES);
  assertExactFields(reasons, MARKET_TECHNICAL_BENCHMARK_ROLES);
  const normalizedValues = {};
  const normalizedReasons = {};
  for (const role of MARKET_TECHNICAL_BENCHMARK_ROLES) {
    const normalized = normalizeFeatureGroup(
      group[role], reasons[role], RELATIVE_STRENGTH_FEATURE_NAMES,
      `features.relativeStrength.${role}`,
    );
    normalizedValues[role] = normalized.values;
    normalizedReasons[role] = normalized.availability;
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
  const features = assertPlainObject(row.features, `rows[${index}].features`);
  const availability = assertPlainObject(row.availability, `rows[${index}].availability`);
  assertExactFields(features, FAMILY_FIELDS);
  assertExactFields(availability, FAMILY_FIELDS);
  const resultFeatures = {};
  const resultAvailability = {};
  for (const [family, names] of [
    ['returnsDrawdowns', RETURNS_DRAWDOWNS_FEATURE_NAMES],
    ['volatility', VOLATILITY_FEATURE_NAMES],
    ['momentum', MOMENTUM_FEATURE_NAMES],
    ['trend', TREND_FEATURE_NAMES],
  ]) {
    const normalized = normalizeFeatureGroup(features[family], availability[family], names, `features.${family}`);
    resultFeatures[family] = normalized.values;
    resultAvailability[family] = normalized.availability;
  }
  const relative = normalizeRelativeStrength(features.relativeStrength, availability.relativeStrength);
  resultFeatures.relativeStrength = relative.values;
  resultAvailability.relativeStrength = relative.availability;
  return {
    sessionDate: row.sessionDate,
    subjectBarIdentityId: row.subjectBarIdentityId,
    subjectResolvedObservationId: row.subjectResolvedObservationId,
    sourceBindingId: row.sourceBindingId,
    features: resultFeatures,
    availability: resultAvailability,
  };
}

/** @param {unknown} value */
export function normalizeMarketTechnicalFeatureRowsV1(value) {
  const root = assertPlainObject(value, MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION);
  assertSchemaVersion(root, MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION);
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
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'feature rows contain duplicate sessionDate or bar identity');
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
  }
  return { schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION, rows };
}

/** @param {unknown} value */
function normalizeBenchmarkBindingIds(value) {
  const ids = assertPlainObject(value, 'benchmarkBindingIds');
  assertExactFields(ids, MARKET_TECHNICAL_BENCHMARK_ROLES);
  const normalized = {};
  for (const role of MARKET_TECHNICAL_BENCHMARK_ROLES) {
    assertCasId(ids[role], `benchmarkBindingIds.${role}`, true);
    normalized[role] = ids[role];
  }
  return normalized;
}

/** @param {unknown} value */
function normalizeFamilyVersions(value) {
  const versions = assertPlainObject(value, 'featureFamilyVersions');
  assertExactFields(versions, Object.keys(MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS));
  for (const [family, expected] of Object.entries(MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS)) {
    if (versions[family] !== expected) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${family} feature family version is invalid`);
    }
  }
  return { ...MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS };
}

/** @param {unknown} value */
function normalizeAvailabilityCounts(value) {
  const counts = assertPlainObject(value, 'availabilityCounts');
  assertExactFields(counts, MARKET_TECHNICAL_AVAILABILITY_CODES);
  const normalized = {};
  for (const code of MARKET_TECHNICAL_AVAILABILITY_CODES) {
    assertSafeInteger(counts[code], `availabilityCounts.${code}`, { nonNegative: true });
    normalized[code] = counts[code];
  }
  return normalized;
}

/** @param {unknown} value */
export function normalizeMarketTechnicalFeatureComputationReportV1(value) {
  const report = assertPlainObject(value, MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION);
  assertSchemaVersion(report, MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION);
  assertExactFields(report, REPORT_FIELDS);
  for (const field of [
    'technicalFeatureSourceBundleId', 'technicalFeatureComputationPolicyId',
    'technicalFeatureRowsId', 'subjectBindingId',
  ]) assertCasId(report[field], field);
  const benchmarkBindingIds = normalizeBenchmarkBindingIds(report.benchmarkBindingIds);
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
  if (report.featureSchemaVersion !== MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'featureSchemaVersion is invalid');
  }
  return {
    schemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    technicalFeatureSourceBundleId: report.technicalFeatureSourceBundleId,
    technicalFeatureComputationPolicyId: report.technicalFeatureComputationPolicyId,
    technicalFeatureRowsId: report.technicalFeatureRowsId,
    subjectBindingId: report.subjectBindingId,
    benchmarkBindingIds,
    rowCount: report.rowCount,
    firstSessionDate: report.firstSessionDate,
    lastSessionDate: report.lastSessionDate,
    featureSchemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    featureFamilyVersions: normalizeFamilyVersions(report.featureFamilyVersions),
    availabilityCounts: normalizeAvailabilityCounts(report.availabilityCounts),
  };
}
