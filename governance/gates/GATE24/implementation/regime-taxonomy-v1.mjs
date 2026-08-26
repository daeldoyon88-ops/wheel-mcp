/**
 * GATE24 versioned regime taxonomy.
 *
 * Eleven declared dimensions: six ACTIVE_IN_CORE_V1 and five
 * REGISTERED_NOT_ACTIVE_IN_CORE_V1 carrying only their fail-closed members.
 * Every dimension has EXACT_ONLY closure: an emitted value maps to exactly one
 * declared entry of that dimension's taxonomy version, or it fails closed.
 *
 * Curve tokens are the exact canonical producer tokens. Nothing is invented,
 * re-spelled or prefixed, and PARTIALLY_INVERTED, MIXED, FLATTENING and UNCHANGED
 * are preserved rather than collapsed. Shape and direction stay orthogonal and are
 * never merged into a composite value.
 *
 * No cartesian regime label is ever produced: dimensions are independent and
 * independently versioned.
 */

export const REGIME_TAXONOMY_VERSION_ID = 'REGIME_VECTOR_V1';
export const REGIME_TAXONOMY_SCHEMA_VERSION = 'GATE24_RegimeTaxonomy/1';
export const DIMENSION_CLOSURE_RULE = 'EXACT_ONLY';
export const CARTESIAN_LABEL_FORBIDDEN = true;

export const DIMENSION_STATUS = Object.freeze({
  active: 'ACTIVE_IN_CORE_V1',
  registeredNotActive: 'REGISTERED_NOT_ACTIVE_IN_CORE_V1',
});

/**
 * Closed reason enumeration for an unresolvable input, one token per declared
 * unresolvable-input rule in the mandate. EXACT_ONLY: an absenceReason outside
 * this set is a defect and silent collapse is forbidden.
 */
export const UNRESOLVABLE_INPUT_REASONS_V1 = Object.freeze([
  'PRODUCER_VALUE_NOT_AVAILABLE',
  'PRODUCER_VALUE_OUT_OF_VOCABULARY',
  'PRODUCER_RECORD_ABSENT',
  'CORE_INPUT_MISSING',
  'MACRO_CONTEXT_ABSENT',
  'INSUFFICIENT_HISTORY_IN_WINDOW',
  'FEATURE_RECORD_FAIL_CLOSED',
  'INPUT_NOT_AVAILABLE_AT_CUTOFF',
]);

const reasonSet = new Set(UNRESOLVABLE_INPUT_REASONS_V1);
export const isDeclaredUnresolvableReason = (reason) => reasonSet.has(reason);

/** Producer token denoting a declared absence rather than a value. */
export const PRODUCER_NOT_AVAILABLE = 'NOT_AVAILABLE';

const dimension = (spec) => Object.freeze({
  ...spec,
  closureRule: DIMENSION_CLOSURE_RULE,
  entries: Object.freeze([...spec.entries]),
  failClosedMembers: Object.freeze([...spec.failClosedMembers]),
  classifyingEntries: Object.freeze(spec.entries.filter((entry) => !spec.failClosedMembers.includes(entry))),
  classifyingCount: spec.entries.filter((entry) => !spec.failClosedMembers.includes(entry)).length,
});

export const PRIMARY_MARKET_REGIME = dimension({
  name: 'primaryMarketRegime',
  status: DIMENSION_STATUS.active,
  taxonomyVersionId: 'PRIMARY_MARKET_REGIME_V1',
  primaryInputBoundary: 'MARKET_FEATURE_BOUNDARY',
  entries: ['BULL', 'BEAR', 'RANGE', 'CRISIS', 'RECOVERY', 'TRANSITION', 'LIQUIDITY_STRESS', 'REGIME_UNKNOWN', 'REGIME_INSUFFICIENT_DATA'],
  failClosedMembers: ['REGIME_UNKNOWN', 'REGIME_INSUFFICIENT_DATA'],
  unknownMember: 'REGIME_UNKNOWN',
  insufficientMember: 'REGIME_INSUFFICIENT_DATA',
});

export const VOLATILITY_STATE = dimension({
  name: 'volatilityState',
  status: DIMENSION_STATUS.active,
  taxonomyVersionId: 'VOLATILITY_STATE_V1',
  primaryInputBoundary: 'MARKET_FEATURE_BOUNDARY',
  entries: ['CALM', 'NORMAL', 'VOLATILE', 'EXTREME', 'UNKNOWN', 'INSUFFICIENT_DATA'],
  failClosedMembers: ['UNKNOWN', 'INSUFFICIENT_DATA'],
  unknownMember: 'UNKNOWN',
  insufficientMember: 'INSUFFICIENT_DATA',
});

export const INFLATION_STATE = dimension({
  name: 'inflationState',
  status: DIMENSION_STATUS.active,
  taxonomyVersionId: 'INFLATION_STATE_V1',
  primaryInputBoundary: 'MACRO_CONTEXT_BOUNDARY',
  coreInputs: Object.freeze(['US.BLS.CPIAUCSL', 'cpiMoM', 'cpiYoY']),
  entries: ['INFLATIONARY', 'DISINFLATIONARY', 'INFLATION_STABLE', 'INFLATION_UNKNOWN', 'INFLATION_INSUFFICIENT_DATA'],
  failClosedMembers: ['INFLATION_UNKNOWN', 'INFLATION_INSUFFICIENT_DATA'],
  unknownMember: 'INFLATION_UNKNOWN',
  insufficientMember: 'INFLATION_INSUFFICIENT_DATA',
});

export const RATES_STATE = dimension({
  name: 'ratesState',
  status: DIMENSION_STATUS.active,
  taxonomyVersionId: 'RATES_STATE_V1',
  primaryInputBoundary: 'MACRO_CONTEXT_BOUNDARY',
  coreInputs: Object.freeze(['US.TREAS.DGS3MO', 'US.TREAS.DGS2', 'US.TREAS.DGS5', 'US.TREAS.DGS10', 'US.TREAS.DGS30', 'US.NYFED.EFFR', 'US.NYFED.SOFR']),
  entries: ['RATES_RISING', 'RATES_FALLING', 'RATES_STABLE', 'RATES_UNKNOWN', 'RATES_INSUFFICIENT_DATA'],
  failClosedMembers: ['RATES_UNKNOWN', 'RATES_INSUFFICIENT_DATA'],
  unknownMember: 'RATES_UNKNOWN',
  insufficientMember: 'RATES_INSUFFICIENT_DATA',
  directionalOnly: true,
  distinctFrom: 'fedPolicyState',
});

export const YIELD_CURVE_SHAPE = dimension({
  name: 'yieldCurveShape',
  status: DIMENSION_STATUS.active,
  taxonomyVersionId: 'YIELD_CURVE_SHAPE_V1',
  primaryInputBoundary: 'MACRO_CONTEXT_BOUNDARY',
  coreInputs: Object.freeze(['SPREAD_10Y_2Y', 'SPREAD_10Y_3M', 'SPREAD_5Y_2Y']),
  entries: ['NORMAL', 'FLAT', 'PARTIALLY_INVERTED', 'INVERTED', 'MIXED', 'UNKNOWN', 'INSUFFICIENT_DATA'],
  failClosedMembers: ['UNKNOWN', 'INSUFFICIENT_DATA'],
  unknownMember: 'UNKNOWN',
  insufficientMember: 'INSUFFICIENT_DATA',
  producerVocabularyConstant: 'MACRO_FEATURE_CURVE_SHAPES',
});

export const YIELD_CURVE_DIRECTION = dimension({
  name: 'yieldCurveDirection',
  status: DIMENSION_STATUS.active,
  taxonomyVersionId: 'YIELD_CURVE_DIRECTION_V1',
  primaryInputBoundary: 'MACRO_CONTEXT_BOUNDARY',
  coreInputs: Object.freeze(['SPREAD_10Y_2Y', 'SPREAD_10Y_3M', 'SPREAD_5Y_2Y']),
  entries: ['STEEPENING', 'FLATTENING', 'UNCHANGED', 'MIXED', 'UNKNOWN', 'INSUFFICIENT_DATA'],
  failClosedMembers: ['UNKNOWN', 'INSUFFICIENT_DATA'],
  unknownMember: 'UNKNOWN',
  insufficientMember: 'INSUFFICIENT_DATA',
  producerVocabularyConstant: 'MACRO_FEATURE_CURVE_DIRECTIONS',
});

/** Registered but not active: fail-closed members only, classifyingCount 0. */
const registeredNotActive = (name, deferredCapabilityId) => dimension({
  name,
  status: DIMENSION_STATUS.registeredNotActive,
  taxonomyVersionId: null,
  primaryInputBoundary: 'MACRO_CONTEXT_BOUNDARY',
  entries: ['UNKNOWN', 'INSUFFICIENT_DATA'],
  failClosedMembers: ['UNKNOWN', 'INSUFFICIENT_DATA'],
  unknownMember: 'UNKNOWN',
  insufficientMember: 'INSUFFICIENT_DATA',
  detailedTaxonomy: 'DEFERRED_TO_FUTURE_VERSION',
  blocksCoreV1: false,
  deferredCapabilityId,
});

export const GROWTH_STATE = registeredNotActive('growthState', 'GATE24-DC-01');
export const LABOR_STATE = registeredNotActive('laborState', 'GATE24-DC-02');
export const CREDIT_STATE = registeredNotActive('creditState', 'GATE24-DC-03');
export const LIQUIDITY_STATE = registeredNotActive('liquidityState', 'GATE24-DC-04');
export const FED_POLICY_STATE = registeredNotActive('fedPolicyState', 'GATE24-DC-05');

export const REGIME_DIMENSIONS_V1 = Object.freeze([
  PRIMARY_MARKET_REGIME, VOLATILITY_STATE, INFLATION_STATE, RATES_STATE,
  YIELD_CURVE_SHAPE, YIELD_CURVE_DIRECTION,
  GROWTH_STATE, LABOR_STATE, CREDIT_STATE, LIQUIDITY_STATE, FED_POLICY_STATE,
]);

export const REGIME_DIMENSION_COUNT = REGIME_DIMENSIONS_V1.length;

export const ACTIVE_DIMENSIONS_V1 = Object.freeze(
  REGIME_DIMENSIONS_V1.filter((item) => item.status === DIMENSION_STATUS.active),
);
export const ACTIVE_DIMENSION_NAMES_V1 = Object.freeze(ACTIVE_DIMENSIONS_V1.map((item) => item.name));
export const INACTIVE_DIMENSIONS_V1 = Object.freeze(
  REGIME_DIMENSIONS_V1.filter((item) => item.status === DIMENSION_STATUS.registeredNotActive),
);
export const INACTIVE_DIMENSION_NAMES_V1 = Object.freeze(INACTIVE_DIMENSIONS_V1.map((item) => item.name));

/** The four macro-fed active dimensions; primaryMarketRegime and volatilityState are market-fed. */
export const MACRO_FED_DIMENSION_NAMES_V1 = Object.freeze(
  ACTIVE_DIMENSIONS_V1.filter((item) => item.primaryInputBoundary === 'MACRO_CONTEXT_BOUNDARY').map((item) => item.name),
);

const byName = new Map(REGIME_DIMENSIONS_V1.map((item) => [item.name, item]));
export function resolveDimension(name) {
  const found = byName.get(name);
  if (!found) throw new Error('REGIME_DIMENSION_UNKNOWN');
  return found;
}

/**
 * Per-dimension taxonomy versions, pinned by the RegimeVector version. A dimension
 * taxonomy change bumps the vector version and therefore the RegimeRecordId.
 */
export const DIMENSION_TAXONOMY_VERSION_IDS_V1 = Object.freeze(
  Object.fromEntries(REGIME_DIMENSIONS_V1.map((item) => [item.name, item.taxonomyVersionId])),
);

/** Exhaustive producer mappings. Every producer token has exactly one target. */
export const CURVE_SHAPE_PRODUCER_TOKENS_V1 = Object.freeze(['NORMAL', 'FLAT', 'PARTIALLY_INVERTED', 'INVERTED', 'MIXED', 'NOT_AVAILABLE']);
export const CURVE_DIRECTION_PRODUCER_TOKENS_V1 = Object.freeze(['STEEPENING', 'FLATTENING', 'UNCHANGED', 'MIXED', 'NOT_AVAILABLE']);

const identityMap = (tokens, insufficientMember) => Object.freeze(Object.fromEntries(
  tokens.map((token) => [token, token === PRODUCER_NOT_AVAILABLE ? insufficientMember : token]),
));

export const CURVE_SHAPE_PRODUCER_MAP_V1 = identityMap(CURVE_SHAPE_PRODUCER_TOKENS_V1, YIELD_CURVE_SHAPE.insufficientMember);
export const CURVE_DIRECTION_PRODUCER_MAP_V1 = identityMap(CURVE_DIRECTION_PRODUCER_TOKENS_V1, YIELD_CURVE_DIRECTION.insufficientMember);

/**
 * Maps a producer token onto a declared dimension entry.
 *
 * NOT_AVAILABLE resolves to the dimension's INSUFFICIENT_DATA member; an
 * out-of-vocabulary or absent producer value resolves to UNKNOWN. Neither ever
 * resolves to a classifying entry, and neither is silently collapsed into the other.
 */
export function mapProducerToken({ dimensionName, producerToken, producerMap }) {
  const spec = resolveDimension(dimensionName);
  if (producerToken === undefined || producerToken === null) {
    return { value: spec.unknownMember, classifying: false, reason: 'PRODUCER_RECORD_ABSENT' };
  }
  if (!Object.hasOwn(producerMap, producerToken)) {
    return { value: spec.unknownMember, classifying: false, reason: 'PRODUCER_VALUE_OUT_OF_VOCABULARY' };
  }
  if (producerToken === PRODUCER_NOT_AVAILABLE) {
    return { value: spec.insufficientMember, classifying: false, reason: 'PRODUCER_VALUE_NOT_AVAILABLE' };
  }
  const value = producerMap[producerToken];
  assertDeclaredEntry(dimensionName, value);
  return { value, classifying: true, reason: null };
}

/** V-17 taxonomy closure: an out-of-enumeration value fails closed, never passes. */
export function assertDeclaredEntry(dimensionName, value) {
  const spec = resolveDimension(dimensionName);
  if (!spec.entries.includes(value)) throw new Error('REGIME_TAXONOMY_VALUE_OUT_OF_ENUMERATION');
  return value;
}

export function isClassifyingValue(dimensionName, value) {
  const spec = resolveDimension(dimensionName);
  return spec.classifyingEntries.includes(value);
}

export function isFailClosedValue(dimensionName, value) {
  const spec = resolveDimension(dimensionName);
  return spec.failClosedMembers.includes(value);
}

/** V-20: no emitted value may concatenate several dimensions into one label. */
export function refuseCartesianLabel(candidate) {
  if (typeof candidate !== 'string') return { status: 'ALLOWED', code: null };
  const collides = ACTIVE_DIMENSIONS_V1.reduce(
    (count, spec) => count + (spec.classifyingEntries.some((entry) => candidate.split('_').includes(entry)) ? 1 : 0),
    0,
  );
  return collides > 1
    ? { status: 'BLOCKED', code: 'CARTESIAN_REGIME_LABEL_FORBIDDEN' }
    : { status: 'ALLOWED', code: null };
}

/** The fail-closed vector emitted for the five registered-but-inactive dimensions. */
export function inactiveDimensionValues() {
  return Object.freeze(Object.fromEntries(
    INACTIVE_DIMENSIONS_V1.map((item) => [item.name, item.insufficientMember]),
  ));
}

export function describeRegimeTaxonomy() {
  return Object.freeze({
    schemaVersion: REGIME_TAXONOMY_SCHEMA_VERSION,
    regimeTaxonomyVersionId: REGIME_TAXONOMY_VERSION_ID,
    closureRule: DIMENSION_CLOSURE_RULE,
    cartesianLabelForbidden: CARTESIAN_LABEL_FORBIDDEN,
    dimensionCount: REGIME_DIMENSION_COUNT,
    activeDimensionCount: ACTIVE_DIMENSIONS_V1.length,
    inactiveDimensionCount: INACTIVE_DIMENSIONS_V1.length,
    activeDimensions: ACTIVE_DIMENSION_NAMES_V1,
    inactiveDimensions: INACTIVE_DIMENSION_NAMES_V1,
    macroFedDimensions: MACRO_FED_DIMENSION_NAMES_V1,
    dimensionTaxonomyVersionIds: DIMENSION_TAXONOMY_VERSION_IDS_V1,
    unresolvableInputReasons: UNRESOLVABLE_INPUT_REASONS_V1,
    curveShapeProducerMap: CURVE_SHAPE_PRODUCER_MAP_V1,
    curveDirectionProducerMap: CURVE_DIRECTION_PRODUCER_MAP_V1,
  });
}
