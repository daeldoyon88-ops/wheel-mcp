import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MACRO_CLAIMS_DIRECTIONS,
  MACRO_CLAIMS_REGIMES,
  MACRO_CLAIMS_SPIKE_STATES,
  MACRO_CLAIMS_TRENDS,
  MACRO_COMPOSITE_STATES,
  MACRO_FEATURE_L4B_F2_SCHEMA_VERSIONS,
  MACRO_F2_AVAILABILITY_STATUSES,
  MACRO_INFLATION_ACCELERATION_STATES,
  MACRO_INFLATION_DIRECTIONS,
  MACRO_INFLATION_REGIMES,
  MACRO_LABOR_REGIMES,
  MACRO_LEVERAGE_CLASSES,
  MACRO_PROJECTION_STATUSES,
  MACRO_UNEMPLOYMENT_DIRECTIONS,
  MACRO_UNEMPLOYMENT_TRENDS,
  MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
  MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
  normalizeMarketMacroFullStateRowsV1,
  normalizeMarketMacroInstrumentProjectionPolicyV1,
  normalizeMarketMacroInstrumentRowsV1,
} from '../src/contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import { macroRatioChangeFixed } from '../src/macro/macroFixedPointRatioL4BF2V1.mjs';

const ID = `sha256:${'a'.repeat(64)}`;

test('F2 adds exactly the four required canonical schemas', () => {
  assert.deepEqual(MACRO_FEATURE_L4B_F2_SCHEMA_VERSIONS, [
    MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
    MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
    MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
    MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
  ]);
});

test('canonical schema registry contains exactly 132 unique schemas', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 132);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 132);
});

test('normalized schema namespace remains exactly five unique schemas', () => {
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  assert.equal(new Set(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS).size, 5);
  for (const schema of MACRO_FEATURE_L4B_F2_SCHEMA_VERSIONS) {
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(schema), false);
  }
});

test('closed projection policy round-trips canonically', () => {
  const wire = {
    schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
  };
  assert.deepEqual(normalizeMarketMacroInstrumentProjectionPolicyV1(wire), wire);
  assert.deepEqual(normalizeCanonicalValue(wire.schemaVersion, wire), wire);
});

test('projection policy closes causality, arithmetic and non-decision rules', () => {
  const p = MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES;
  assert.equal(p.latestPolicy, 'FORBIDDEN');
  assert.equal(p.networkPolicy, 'FORBIDDEN');
  assert.equal(p.cpiInputScale, 3);
  assert.equal(p.unrateInputScale, 1);
  assert.equal(p.claimsInputScale, 0);
  assert.equal(p.ratioScale, 6);
  assert.equal(p.roundingMode, 'HALF_EVEN');
  assert.equal(p.monthlyWindowPolicy, 'ALL_INTERMEDIATE_MONTHS_REQUIRED');
  assert.equal(p.claimsWindowPolicy, 'EXACT_SEVEN_DAY_STEPS');
  assert.equal(p.scorePolicy, 'FORBIDDEN');
  assert.equal(p.rankingPolicy, 'FORBIDDEN');
  assert.equal(p.recommendationPolicy, 'FORBIDDEN');
});

test('full rows empty canonical value dispatches through the registry', () => {
  const wire = {
    schemaVersion: MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
    f1MacroStateBySessionRowsId: ID,
    f1SourceBundleId: ID,
    f1FeatureComputationPolicyId: ID,
    f1MacroFeatureComputationReportId: ID,
    projectionPolicyId: ID,
    rows: [],
  };
  assert.deepEqual(normalizeMarketMacroFullStateRowsV1(wire), wire);
  assert.deepEqual(normalizeCanonicalValue(wire.schemaVersion, wire), wire);
});

test('instrument rows empty canonical value dispatches through the registry', () => {
  const wire = {
    schemaVersion: MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
    fullStateRowsId: ID,
    projectionPolicyId: ID,
    instrumentRegistryManifestId: ID,
    rows: [],
  };
  assert.deepEqual(normalizeMarketMacroInstrumentRowsV1(wire), wire);
  assert.deepEqual(normalizeCanonicalValue(wire.schemaVersion, wire), wire);
});

test('ratio output scale is closed to six', () => {
  assert.throws(() => macroRatioChangeFixed(
    { atoms: '101', scale: 0 }, { atoms: '100', scale: 0 }, 'CLOSED_SCALE', 5,
  ), /ratio output scale must equal closed F2 scale 6/);
});

const enumContracts = [
  ['availability', MACRO_F2_AVAILABILITY_STATUSES],
  ['inflation direction', MACRO_INFLATION_DIRECTIONS],
  ['inflation acceleration', MACRO_INFLATION_ACCELERATION_STATES],
  ['unemployment direction', MACRO_UNEMPLOYMENT_DIRECTIONS],
  ['unemployment trend', MACRO_UNEMPLOYMENT_TRENDS],
  ['claims direction', MACRO_CLAIMS_DIRECTIONS],
  ['claims trend', MACRO_CLAIMS_TRENDS],
  ['claims spike', MACRO_CLAIMS_SPIKE_STATES],
  ['inflation regime', MACRO_INFLATION_REGIMES],
  ['labor regime', MACRO_LABOR_REGIMES],
  ['claims regime', MACRO_CLAIMS_REGIMES],
  ['composite', MACRO_COMPOSITE_STATES],
  ['projection', MACRO_PROJECTION_STATUSES],
  ['leverage', MACRO_LEVERAGE_CLASSES],
];

for (const [label, values] of enumContracts) {
  test(`${label} enum is non-empty, closed and duplicate-free`, () => {
    assert.ok(values.length > 0);
    assert.equal(new Set(values).size, values.length);
    assert.ok(values.every((value) => typeof value === 'string' && value.length > 0));
    assert.equal(Object.isFrozen(values), true);
  });
}
