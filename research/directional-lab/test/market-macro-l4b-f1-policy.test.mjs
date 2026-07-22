/**
 * L4B-F1 feature computation policy: closed singleton, forbidden latest/network,
 * thresholds, closed spreads, staleness limits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES,
  F1_SPREAD_DEFINITIONS,
  F1_SERIES_FAMILY_BY_CODE,
  normalizeMarketMacroFeatureComputationPolicyV1,
} from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import {
  buildMarketMacroFeatureComputationPolicy,
  verifyMarketMacroFeatureComputationPolicy,
} from '../src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { code, withMacroStore } from './macroIngestionL4BSyntheticFixture.mjs';

function wire(overrides = {}) {
  return {
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
    ...overrides,
  };
}

test('policy builds, verifies and round-trips', () => withMacroStore((store) => {
  const built = buildMarketMacroFeatureComputationPolicy({ store });
  const verified = verifyMarketMacroFeatureComputationPolicy({
    store, featureComputationPolicyId: built.featureComputationPolicyId,
  });
  assert.deepEqual(verified.featureComputationPolicy, built.featureComputationPolicy);
  assert.match(built.featureComputationPolicyId, /^sha256:[0-9a-f]{64}$/);
}));

test('policy is a closed singleton with stable bytes', () => {
  const a = normalizeMarketMacroFeatureComputationPolicyV1(wire());
  const b = normalizeMarketMacroFeatureComputationPolicyV1(wire());
  assert.deepEqual(a, b);
  assert.deepEqual(canonicalJsonBytes(a), canonicalJsonBytes(b));
  assert.equal(a.policyVersion, 'MARKET_MACRO_FEATURE_COMPUTATION_L4B_F1_V1');
});

test('latestPolicy is FORBIDDEN', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.latestPolicy, 'FORBIDDEN');
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ latestPolicy: 'ALLOWED' })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('networkPolicy is FORBIDDEN', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.networkPolicy, 'FORBIDDEN');
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ networkPolicy: 'ALLOWED' })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('interpolationPolicy is FORBIDDEN', () => {
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ interpolationPolicy: 'LINEAR' })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('futureBackfillPolicy is FORBIDDEN', () => {
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ futureBackfillPolicy: 'ALLOWED' })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('carryBackwardPolicy is FORBIDDEN', () => {
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ carryBackwardPolicy: 'ALLOWED' })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('rateFeatureScale is locked at 6', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.rateFeatureScale, 6);
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ rateFeatureScale: 2 })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ rateFeatureScale: 8 })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('rate regime thresholds are closed fixed-point bounds', () => {
  const t = MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.rateRegimeThresholds;
  assert.deepEqual(t.lowMaxExclusive, { atoms: '200', scale: 2 });
  assert.deepEqual(t.moderateMaxExclusive, { atoms: '400', scale: 2 });
  assert.deepEqual(t.highMaxExclusive, { atoms: '600', scale: 2 });
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({
    rateRegimeThresholds: { ...t, lowMaxExclusive: { atoms: '250', scale: 2 } },
  })), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('curve flat and inversion thresholds are closed', () => {
  const c = MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.curveShapePolicy;
  assert.deepEqual(c.flatThreshold, { atoms: '10', scale: 2 });
  assert.deepEqual(c.inversionThreshold, { atoms: '-10', scale: 2 });
  assert.deepEqual(c.requiredSpreadCodes, ['SPREAD_10Y_2Y', 'SPREAD_10Y_3M']);
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({
    curveShapePolicy: { ...c, flatThreshold: { atoms: '5', scale: 2 } },
  })), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('ordered spread definitions are exactly the closed six', () => {
  const policy = normalizeMarketMacroFeatureComputationPolicyV1(wire());
  assert.equal(policy.orderedSpreadDefinitions.length, 6);
  assert.deepEqual(policy.orderedSpreadDefinitions, F1_SPREAD_DEFINITIONS);
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({
    orderedSpreadDefinitions: F1_SPREAD_DEFINITIONS.slice(0, 5),
  })), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('spread set refuses open or reordered definitions', () => {
  const defs = structuredClone(F1_SPREAD_DEFINITIONS);
  defs[0] = { ...defs[0], left: 'US.TREAS.DGS2', right: 'US.TREAS.DGS10' };
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({
    orderedSpreadDefinitions: defs,
  })), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
  const swapped = [...F1_SPREAD_DEFINITIONS].reverse();
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({
    orderedSpreadDefinitions: swapped,
  })), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('staleness limits: POLICY_RATE null, MONEY_MARKET 5, TREASURY 5', () => {
  const s = MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.stalenessPolicySessionsByFamily;
  assert.equal(s.POLICY_RATE, null);
  assert.equal(s.MONEY_MARKET, 5);
  assert.equal(s.TREASURY, 5);
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({
    stalenessPolicySessionsByFamily: { ...s, MONEY_MARKET: 3 },
  })), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({
    stalenessPolicySessionsByFamily: { ...s, POLICY_RATE: 5 },
  })), code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('seriesFamilyByCode covers the closed F1 map', () => {
  const policy = normalizeMarketMacroFeatureComputationPolicyV1(wire());
  assert.deepEqual(policy.seriesFamilyByCode, F1_SERIES_FAMILY_BY_CODE);
});

test('jurisdiction and currency are locked to US/USD', () => {
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ jurisdictionCode: 'CANADA' })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
  assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(wire({ currencyCode: 'CAD' })),
    code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'));
});

test('every closed policy field diverges fail-closed', () => {
  for (const key of Object.keys(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES)) {
    const forged = wire();
    forged[key] = typeof forged[key] === 'number' ? forged[key] + 1
      : typeof forged[key] === 'string' ? 'FORGED' : { forged: true };
    assert.throws(() => normalizeMarketMacroFeatureComputationPolicyV1(forged),
      code('MARKET_DATA_MACRO_FEATURE_POLICY_INVALID'), key);
  }
});

test('verify refuses latest marker policy id', () => withMacroStore((store) => {
  assert.throws(() => verifyMarketMacroFeatureComputationPolicy({
    store, featureComputationPolicyId: 'latest',
  }));
}));

test('verify refuses missing CAS object', () => withMacroStore((store) => {
  assert.throws(() => verifyMarketMacroFeatureComputationPolicy({
    store, featureComputationPolicyId: `sha256:${'a'.repeat(64)}`,
  }));
}));

test('two independent builds produce identical policy IDs', () => {
  const a = withMacroStore((store) => buildMarketMacroFeatureComputationPolicy({ store }).featureComputationPolicyId);
  const b = withMacroStore((store) => buildMarketMacroFeatureComputationPolicy({ store }).featureComputationPolicyId);
  assert.equal(a, b);
});

test('sessionKnowledgeCutoffPolicy is OFFICIAL_SESSION_CLOSE_UTC', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.sessionKnowledgeCutoffPolicy,
    'OFFICIAL_SESSION_CLOSE_UTC');
});

test('observationSelectionPolicy is pinned-binding as-of close', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.observationSelectionPolicy,
    'RESOLVE_AS_OF_SESSION_CLOSE_FROM_PINNED_BINDING');
});

test('carryForwardPolicy forbids future lookahead', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.carryForwardPolicy,
    'LAST_CAUSALLY_AVAILABLE_OBSERVATION_WITHOUT_FUTURE_LOOKAHEAD');
});

test('missingDataPolicy emits explicit NOT_AVAILABLE', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.missingDataPolicy,
    'EMIT_EXPLICIT_NOT_AVAILABLE');
});

test('sourceBundleSelectionPolicy is EXPLICIT_PIN_ONLY', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.sourceBundleSelectionPolicy,
    'EXPLICIT_PIN_ONLY');
});

test('orderingPolicy is SESSION_DATE_OPEN_CLOSE_ID', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.orderingPolicy,
    'SESSION_DATE_OPEN_CLOSE_ID');
});

test('fixedPointPolicy is INTEGER_ATOMS_WITH_EXPLICIT_SCALE', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.fixedPointPolicy,
    'INTEGER_ATOMS_WITH_EXPLICIT_SCALE');
});

test('monetaryPolicyRegimePolicy is nominal hold from level and direction', () => {
  assert.equal(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.monetaryPolicyRegimePolicy,
    'NOMINAL_HOLD_FROM_POLICY_RATE_LEVEL_AND_DIRECTION_ONLY');
});
