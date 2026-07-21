import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findIndependentOracleSourcePolicyViolations } from './helpers/independentOracleSourcePolicyL4V1.mjs';
import {
  INDEPENDENT_SEASONALITY_MANUAL_VECTORS_L4V1,
  oracleOccurrenceIdentityId,
} from './helpers/independentSeasonalityOracleL4V1.mjs';
import { buildMarketSeasonalityOccurrenceIdentityV1 } from '../src/features/marketSeasonalityOccurrenceEngineL4V1.mjs';

test('L4A-C1 independent oracle runs at least 30 manual vectors', () => {
  assert.ok(INDEPENDENT_SEASONALITY_MANUAL_VECTORS_L4V1.length >= 30);
  for (const [name, compute, expected] of INDEPENDENT_SEASONALITY_MANUAL_VECTORS_L4V1) {
    assert.deepEqual(compute(), expected, name);
  }
});

test('L4A-C1 independent occurrence identity oracle matches production CAS identity', () => {
  const value = {
    instrumentIdentityId: `sha256:${'a'.repeat(64)}`,
    datasetSnapshotBindingId: `sha256:${'b'.repeat(64)}`,
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    forwardSessionCount: 5,
    historicalYear: 2025,
    startSessionDate: '2025-01-02',
    endSessionDate: '2025-01-07',
    anchorMonth: 1,
    anchorDay: 2,
  };
  assert.equal(
    buildMarketSeasonalityOccurrenceIdentityV1(value).occurrenceIdentityId,
    oracleOccurrenceIdentityId(value),
  );
});

test('L4A-C1 oracle helper is statically isolated from tested calculators', () => {
  const source = readFileSync(
    new URL('./helpers/independentSeasonalityOracleL4V1.mjs', import.meta.url), 'utf8',
  );
  const violations = findIndependentOracleSourcePolicyViolations(source, {
    allowlist: ['node:crypto'],
  });
  assert.deepEqual(violations, []);
  for (const forbidden of [
    'marketSeasonalityOccurrenceEngine', 'marketSeasonalityStatistics',
    'marketSeasonalityFeatureRows', 'fixedPointFeatureMathL4V1',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});
