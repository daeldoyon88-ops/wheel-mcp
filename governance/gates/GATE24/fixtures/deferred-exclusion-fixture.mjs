/**
 * GATE24 deferred exclusion fixture.
 *
 * FIXTURE SCOPE ONLY. Pins what must stay OUT of CORE_V1: the five
 * registered-but-inactive dimensions, the empty OPTIONAL_V1 tier, and the
 * REGISTERED_DEFERRED macro concepts. Absence of any of them must never block,
 * degrade or fail a CORE_V1 classification, and none may be silently promoted.
 */

export const FIXTURE_SCOPE = 'GATE24_FIXTURE_ONLY';

/** OD-Y: registered in the architecture with fail-closed members only. */
export const DEFERRED_DIMENSIONS = Object.freeze([
  Object.freeze({ name: 'growthState', deferredCapabilityId: 'GATE24-DC-01', classifyingCount: 0 }),
  Object.freeze({ name: 'laborState', deferredCapabilityId: 'GATE24-DC-02', classifyingCount: 0 }),
  Object.freeze({ name: 'creditState', deferredCapabilityId: 'GATE24-DC-03', classifyingCount: 0 }),
  Object.freeze({ name: 'liquidityState', deferredCapabilityId: 'GATE24-DC-04', classifyingCount: 0 }),
  Object.freeze({ name: 'fedPolicyState', deferredCapabilityId: 'GATE24-DC-05', classifyingCount: 0 }),
]);

export const DEFERRED_DIMENSION_NAMES = Object.freeze(DEFERRED_DIMENSIONS.map((item) => item.name));

/** The declared reason vocabulary. An empty reason or "later" is a defect. */
export const DEFERRED_REASON_VOCABULARY = Object.freeze([
  'CAUSAL_VINTAGE_PROOF_INCOMPLETE',
  'CANONICAL_IDENTITY_ABSENT',
  'AVAILABLE_AT_POLICY_INCOMPLETE',
  'RELEASE_TIMESTAMP_UNCERTAINTY',
  'HISTORICAL_COVERAGE_INSUFFICIENT',
  'CLASSIFIER_ROLE_NOT_YET_PROVEN',
  'REDUNDANT_INFORMATION_NOT_YET_EVALUATED',
  'PREDICTIVE_VALUE_BELONGS_TO_LATER_GATE',
  'TAXONOMY_INTENTIONALLY_DEFERRED',
  'NOT_REQUIRED_BY_CORE_V1',
]);

export const FORBIDDEN_DEFERRAL_REASONS = Object.freeze(['later', '', null, undefined, 'TBD']);

/**
 * REGISTERED_DEFERRED macro concepts. US.BLS.ICSA is admitted by the producer series
 * policy but is deferred for GATE24 V1 consumption; the rest have no canonical series
 * identifier and none is invented.
 */
export const DEFERRED_MACRO_SERIES_CODES = Object.freeze(['US.BLS.ICSA']);
export const DEFERRED_MACRO_CONCEPTS_WITHOUT_IDENTIFIER = Object.freeze([
  'PCE', 'Core PCE', 'PPI', 'inflation breakevens', 'NFP / payrolls', 'JOLTS',
  'participation rate', 'average hourly earnings', 'GDP', 'industrial production',
  'retail sales', 'durable goods', 'housing indicators', 'PMI', 'ISM',
  'credit spreads', 'Financial Conditions Index', 'mortgage rates', 'DXY',
  'Fed balance sheet', 'reserves', 'RRP', 'FOMC minutes', 'SEP / dots',
  'economic consensus / surprise data',
  'additional Treasury tenor 6M', 'additional Treasury tenor 1Y',
  'additional Treasury tenor 3Y', 'additional Treasury tenor 7Y',
  'additional Treasury tenor 20Y',
]);

/** OD-Z: the tier exists architecturally and is empty in V1. */
export const OPTIONAL_V1_MEMBERS = Object.freeze([]);

/** GATE24-DC-06: multi-horizon activation stays deferred and additive. */
export const DEFERRED_HORIZON_SESSION_COUNTS = Object.freeze([5, 63, 126, 252]);
export const ACTIVE_HORIZON_SESSION_COUNTS = Object.freeze([21]);

/** A hostile vintage store that smuggles a deferred series into the perimeter. */
export const DEFERRED_SERIES_INTRUSION = Object.freeze({
  seriesCode: 'US.BLS.ICSA',
  expectedDisposition: 'ABSENT_FROM_CONSUMED_SNAPSHOT',
});

/** Producer vocabularies that are candidates for a future fedPolicyState taxonomy only. */
export const FED_POLICY_CANDIDATE_VOCABULARIES = Object.freeze({
  MACRO_FEATURE_POLICY_DIRECTIONS: Object.freeze(['EASING', 'TIGHTENING', 'UNCHANGED', 'NOT_AVAILABLE']),
  MACRO_FEATURE_MONETARY_POLICY_REGIMES: Object.freeze(['EASING', 'TIGHTENING', 'HIGH_RATE_HOLD', 'MID_RATE_HOLD', 'LOW_RATE_HOLD', 'NOT_AVAILABLE']),
  MACRO_FEATURE_FOMC_DECISION_TYPES: Object.freeze(['HIKE', 'CUT', 'HOLD', 'RANGE_RESTRUCTURE', 'WITHDRAWN', 'NOT_AVAILABLE']),
  disposition: 'CANDIDATE_ONLY_NOT_A_RATIFIED_GATE24_TAXONOMY',
});
