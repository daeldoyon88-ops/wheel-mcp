/** Pure policy-CAS output -> immutable L4A-C1 calculator runtime. */

import {
  MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1,
  assertClosedMarketSeasonalityFeaturePolicyValuesV1,
  extractMarketSeasonalityFeaturePolicyValuesV1,
} from '../contracts/marketSeasonalityFeaturePolicyValuesL4V1.mjs';

export const MARKET_SEASONALITY_RUNTIME_POLICY_SCHEMA_VERSION =
  'MarketSeasonalityRuntimePolicy/1';
const POLICY_SCHEMA_VERSION = 'MarketSeasonalityFeatureComputationPolicy/1';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactFields(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  const expected = new Set(fields);
  if (actual.length !== fields.length || actual.some((field) => !expected.has(field))) {
    throw new TypeError(`${label} has a non-closed field set`);
  }
}

const RUNTIME_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1),
]);

export function assertMarketSeasonalityRuntimePolicyV1(runtime) {
  exactFields(runtime, RUNTIME_FIELDS, 'seasonality runtime');
  if (runtime.schemaVersion !== MARKET_SEASONALITY_RUNTIME_POLICY_SCHEMA_VERSION) {
    throw new TypeError(`seasonality runtime must use ${MARKET_SEASONALITY_RUNTIME_POLICY_SCHEMA_VERSION}`);
  }
  assertClosedMarketSeasonalityFeaturePolicyValuesV1(
    extractMarketSeasonalityFeaturePolicyValuesV1(runtime),
  );
  return runtime;
}

export function deriveMarketSeasonalityRuntimePolicyV1(verifiedPolicy) {
  exactFields(
    verifiedPolicy,
    ['schemaVersion', ...Object.keys(MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1)],
    'verified seasonality policy',
  );
  if (verifiedPolicy.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new TypeError(`verified seasonality policy must use ${POLICY_SCHEMA_VERSION}`);
  }
  assertClosedMarketSeasonalityFeaturePolicyValuesV1(
    extractMarketSeasonalityFeaturePolicyValuesV1(verifiedPolicy),
  );
  const runtime = { schemaVersion: MARKET_SEASONALITY_RUNTIME_POLICY_SCHEMA_VERSION };
  for (const field of Object.keys(MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1)) {
    const value = verifiedPolicy[field];
    runtime[field] = Array.isArray(value) ? [...value] : value;
  }
  return deepFreeze(runtime);
}

export const MARKET_SEASONALITY_RUNTIME_POLICY_V1 =
  deriveMarketSeasonalityRuntimePolicyV1({
    schemaVersion: POLICY_SCHEMA_VERSION,
    ...MARKET_SEASONALITY_FEATURE_POLICY_VALUES_V1,
  });
