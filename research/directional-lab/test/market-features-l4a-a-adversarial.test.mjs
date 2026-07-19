import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_POLICY_VALUES,
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
  normalizeMarketTechnicalFeatureComputationPolicyV1,
} from '../src/contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  divideFixed,
  divideRoundHalfEven,
  fixedFromCanonical,
  fixedToCanonical,
  squareRootFixed,
} from '../src/features/fixedPointFeatureMathL4V1.mjs';
import { computeRelativeStrengthFeatures } from '../src/features/trendRelativeStrengthFeaturesL4V1.mjs';
import { withStore } from './l2aSyntheticPipeline.mjs';
import { makeInternalBars } from './marketFeaturesL4SyntheticPipeline.mjs';

for (const [name, numerator, denominator, expected] of [
  ['positive even tie', 1n, 2n, 0n],
  ['positive odd tie', 3n, 2n, 2n],
  ['negative even tie', -1n, 2n, 0n],
  ['negative odd tie', -3n, 2n, -2n],
  ['above tie', 8n, 3n, 3n],
]) {
  test(`L4A fixed-point HALF_EVEN ${name}`, () => {
    assert.equal(divideRoundHalfEven(numerator, denominator), expected);
  });
}

for (const [label, value, target] of [
  ['0.1', { atoms: '1', scale: 1 }, { atoms: '100000000000', scale: 12 }],
  ['0.2', { atoms: '2', scale: 1 }, { atoms: '200000000000', scale: 12 }],
  ['9007199254740993', { atoms: '9007199254740993', scale: 0 }, { atoms: '9007199254740993000000000000', scale: 12 }],
  ['0.00000001', { atoms: '1', scale: 8 }, { atoms: '10000', scale: 12 }],
  ['large decimal', { atoms: '123456789012345678123456', scale: 6 }, { atoms: '123456789012345678123456000000', scale: 12 }],
]) {
  test(`L4A fixed-point preserves ${label} without IEEE-754`, () => {
    assert.deepEqual(fixedToCanonical(fixedFromCanonical(value), 12), target);
  });
}

test('L4A fixed-point division aligns different input scales exactly', () => {
  const left = fixedFromCanonical({ atoms: '100', scale: 2 });
  const right = fixedFromCanonical({ atoms: '2', scale: 0 });
  assert.deepEqual(fixedToCanonical(divideFixed(left, right), 12), {
    atoms: '500000000000', scale: 12,
  });
});

test('L4A fixed-point square root is deterministic at twelve decimals', () => {
  const two = fixedFromCanonical({ atoms: '2', scale: 0 });
  assert.deepEqual(fixedToCanonical(squareRootFixed(two), 12), {
    atoms: '1414213562373', scale: 12,
  });
});

test('L4A fixed-point refuses zero denominator and malformed atoms', () => {
  const one = fixedFromCanonical({ atoms: '1', scale: 0 });
  const zero = fixedFromCanonical({ atoms: '0', scale: 0 });
  assert.throws(() => divideFixed(one, zero), /zero/);
  assert.throws(() => fixedFromCanonical({ atoms: '01', scale: 0 }));
  assert.throws(() => fixedFromCanonical({ atoms: '-0', scale: 0 }));
});

test('L4A policy refuses free periods, scales and unknown fields', () => {
  const base = {
    schemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...MARKET_TECHNICAL_FEATURE_POLICY_VALUES,
  };
  assert.throws(() => normalizeMarketTechnicalFeatureComputationPolicyV1({ ...base, atrPeriod: 15 }));
  assert.throws(() => normalizeMarketTechnicalFeatureComputationPolicyV1({ ...base, ratioScale: 10 }));
  assert.throws(() => normalizeMarketTechnicalFeatureComputationPolicyV1({ ...base, freePeriod: 7 }));
});

test('L4A normalized namespace accepts only the closed feature rows shape', () => withStore((store) => {
  const empty = store.putCanonicalObject({
    namespace: 'normalized',
    schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    value: { schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION, rows: [] },
  });
  const reread = store.readCanonicalObject({
    uri: empty.uri,
    expectedObjectId: empty.objectId,
    schemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
  });
  assert.deepEqual(reread.value.rows, []);
  assert.throws(() => store.putCanonicalObject({
    namespace: 'normalized', schemaVersion: 'FreeFeatureRows/1', value: {},
  }));
}));

test('L4A missing current benchmark session dominates relative values without fill', () => {
  const subject = makeInternalBars([100n, 110n]);
  const benchmark = makeInternalBars([100n]);
  const row = computeRelativeStrengthFeatures(subject, { MARKET: benchmark }).MARKET[1];
  assert.equal(row.relativePriceRatio.value, null);
  assert.equal(row.relativePriceRatio.availability, 'BENCHMARK_SESSION_MISSING');
});

test('L4A relative strength refuses benchmark zero as an explicit denominator failure', () => {
  const subject = makeInternalBars([100n], { spread: 0n });
  const benchmark = makeInternalBars([0n], { spread: 0n });
  const row = computeRelativeStrengthFeatures(subject, { MARKET: benchmark }).MARKET[0];
  assert.deepEqual(row.relativePriceRatio, { value: null, availability: 'DIVISION_BY_ZERO' });
});
