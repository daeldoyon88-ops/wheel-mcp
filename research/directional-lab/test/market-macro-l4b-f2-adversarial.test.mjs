/**
 * L4B-F2 closed-wire adversarial corpus. Every named corruption is a distinct
 * node:test case and must be refused by one of the four canonical normalizers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MACRO_CLAIMS_REGIMES,
  MACRO_COMPOSITE_STATES,
  MACRO_INFLATION_REGIMES,
  MACRO_LABOR_REGIMES,
  MACRO_PROJECTION_STATUSES,
  MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
  MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
  normalizeMarketMacroFullComputationReportV1,
  normalizeMarketMacroFullStateRowsV1,
  normalizeMarketMacroInstrumentProjectionPolicyV1,
  normalizeMarketMacroInstrumentRowsV1,
} from '../src/contracts/macroFullFeatureContractsL4BF2V1.mjs';

const ID = `sha256:${'a'.repeat(64)}`;
const OTHER_ID = `sha256:${'b'.repeat(64)}`;

const policyBaseline = () => ({
  schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
});

const fullRowsBaseline = () => ({
  schemaVersion: MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
  f1MacroStateBySessionRowsId: ID,
  f1SourceBundleId: ID,
  f1FeatureComputationPolicyId: ID,
  f1MacroFeatureComputationReportId: ID,
  projectionPolicyId: ID,
  rows: [],
});

const instrumentRowsBaseline = () => ({
  schemaVersion: MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
  fullStateRowsId: ID,
  projectionPolicyId: ID,
  instrumentRegistryManifestId: ID,
  rows: [],
});

function zeroCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

const reportBaseline = () => ({
  schemaVersion: MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
  f1SourceBundleId: ID,
  f1FeatureComputationPolicyId: ID,
  f1MacroStateBySessionRowsId: ID,
  f1MacroFeatureComputationReportId: ID,
  fullStateRowsId: ID,
  instrumentProjectionPolicyId: ID,
  instrumentRowsId: ID,
  macroDatasetBindingId: ID,
  marketCalendarRegistryManifestId: ID,
  instrumentIdentityRegistryManifestId: ID,
  firstSessionId: null,
  lastSessionId: null,
  firstSessionDate: null,
  lastSessionDate: null,
  sessionCount: 0,
  instrumentCount: 0,
  fullStateRowCount: 0,
  instrumentRowCount: 0,
  completeMacroSessionCount: 0,
  partialMacroSessionCount: 0,
  unavailableMacroSessionCount: 0,
  cpiAvailableSessionCount: 0,
  cpiStaleSessionCount: 0,
  cpiWithdrawnSessionCount: 0,
  cpiNotAvailableSessionCount: 0,
  unrateAvailableSessionCount: 0,
  unrateStaleSessionCount: 0,
  unrateWithdrawnSessionCount: 0,
  unrateNotAvailableSessionCount: 0,
  claimsAvailableSessionCount: 0,
  claimsStaleSessionCount: 0,
  claimsWithdrawnSessionCount: 0,
  claimsNotAvailableSessionCount: 0,
  projectedInstrumentRowCount: 0,
  partialInstrumentRowCount: 0,
  notApplicableInstrumentRowCount: 0,
  sessionMismatchInstrumentRowCount: 0,
  futureObservationRejectedCount: 0,
  futureRevisionRejectedCount: 0,
  futureCalendarUpdateRejectedCount: 0,
  inflationRegimeCounts: zeroCounts(MACRO_INFLATION_REGIMES),
  laborRegimeCounts: zeroCounts(MACRO_LABOR_REGIMES),
  claimsRegimeCounts: zeroCounts(MACRO_CLAIMS_REGIMES),
  compositeStateCounts: zeroCounts(MACRO_COMPOSITE_STATES),
  projectionStatusCounts: zeroCounts(MACRO_PROJECTION_STATUSES),
  orderedFullStateRowDigest: ID,
  orderedInstrumentRowDigest: ID,
  orderedFullProvenanceDigest: ID,
  emptyComputation: true,
});

function omitted(factory, field) {
  const value = factory();
  delete value[field];
  return value;
}

function changed(factory, field, replacement) {
  const value = factory();
  value[field] = replacement;
  return value;
}

function extra(factory, field) {
  const value = factory();
  value[field] = true;
  return value;
}

function symbolExtra(factory) {
  const value = factory();
  value[Symbol('hidden-corruption')] = true;
  return value;
}

function accessor(factory, field) {
  const value = factory();
  Object.defineProperty(value, field, { enumerable: true, get() { return ID; } });
  return value;
}

function nonEnumerable(factory, field) {
  const value = factory();
  Object.defineProperty(value, field, { enumerable: false, value: value[field] });
  return value;
}

function inherited(factory) {
  const value = factory();
  Object.setPrototypeOf(value, { inheritedCorruption: true });
  return value;
}

const policyFields = Object.keys(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES);
const policyCases = [
  ...policyFields.slice(0, 16).map((field) => ({
    name: `policy divergence ${field}`,
    value: changed(policyBaseline, field, null),
  })),
  { name: 'policy wrong schema', value: changed(policyBaseline, 'schemaVersion', 'MarketMacroInstrumentProjectionPolicy/2') },
  { name: 'policy missing schema', value: omitted(policyBaseline, 'schemaVersion') },
  { name: 'policy unknown key blocks latest injection', value: extra(policyBaseline, 'resolveLatest') },
  { name: 'policy Symbol key', value: symbolExtra(policyBaseline) },
  { name: 'policy accessor', value: accessor(policyBaseline, 'latestPolicy') },
  { name: 'policy non-enumerable field', value: nonEnumerable(policyBaseline, 'networkPolicy') },
  { name: 'policy inherited prototype', value: inherited(policyBaseline) },
  { name: 'policy NaN ratio scale', value: changed(policyBaseline, 'ratioScale', Number.NaN) },
  { name: 'policy negative zero ratio scale', value: changed(policyBaseline, 'ratioScale', -0) },
];

const fullCases = [
  { name: 'full rows wrong schema', value: changed(fullRowsBaseline, 'schemaVersion', 'MarketMacroFullStateRows/2') },
  ...['schemaVersion', 'f1MacroStateBySessionRowsId', 'f1SourceBundleId',
    'f1FeatureComputationPolicyId', 'f1MacroFeatureComputationReportId',
    'projectionPolicyId', 'rows'].map((field) => ({
    name: `full rows missing ${field}`, value: omitted(fullRowsBaseline, field),
  })),
  ...['f1MacroStateBySessionRowsId', 'f1SourceBundleId', 'f1FeatureComputationPolicyId',
    'f1MacroFeatureComputationReportId', 'projectionPolicyId'].map((field) => ({
    name: `full rows bad CAS ${field}`, value: changed(fullRowsBaseline, field, OTHER_ID.slice(0, -1)),
  })),
  { name: 'full rows rows null', value: changed(fullRowsBaseline, 'rows', null) },
  { name: 'full rows rows Date wire', value: changed(fullRowsBaseline, 'rows', new Date('2026-01-01T00:00:00.000Z')) },
  { name: 'full rows rows Map wire', value: changed(fullRowsBaseline, 'rows', new Map()) },
  { name: 'full rows rows Set wire', value: changed(fullRowsBaseline, 'rows', new Set()) },
  { name: 'full rows undefined rows', value: changed(fullRowsBaseline, 'rows', undefined) },
  { name: 'full rows null row', value: changed(fullRowsBaseline, 'rows', [null]) },
  { name: 'full rows unknown score', value: extra(fullRowsBaseline, 'score') },
  { name: 'full rows unknown latest', value: extra(fullRowsBaseline, 'latest') },
  { name: 'full rows Symbol key', value: symbolExtra(fullRowsBaseline) },
  { name: 'full rows accessor', value: accessor(fullRowsBaseline, 'projectionPolicyId') },
  { name: 'full rows non-enumerable field', value: nonEnumerable(fullRowsBaseline, 'rows') },
  { name: 'full rows inherited prototype', value: inherited(fullRowsBaseline) },
];

const instrumentCases = [
  { name: 'instrument rows wrong schema', value: changed(instrumentRowsBaseline, 'schemaVersion', 'MarketMacroInstrumentRows/2') },
  ...['schemaVersion', 'fullStateRowsId', 'projectionPolicyId',
    'instrumentRegistryManifestId', 'rows'].map((field) => ({
    name: `instrument rows missing ${field}`, value: omitted(instrumentRowsBaseline, field),
  })),
  ...['fullStateRowsId', 'projectionPolicyId', 'instrumentRegistryManifestId'].map((field) => ({
    name: `instrument rows bad CAS ${field}`, value: changed(instrumentRowsBaseline, field, 'latest'),
  })),
  { name: 'instrument rows rows null', value: changed(instrumentRowsBaseline, 'rows', null) },
  { name: 'instrument rows rows object', value: changed(instrumentRowsBaseline, 'rows', {}) },
  { name: 'instrument rows rows Date', value: changed(instrumentRowsBaseline, 'rows', new Date()) },
  { name: 'instrument rows rows Map', value: changed(instrumentRowsBaseline, 'rows', new Map()) },
  { name: 'instrument rows rows Set', value: changed(instrumentRowsBaseline, 'rows', new Set()) },
  { name: 'instrument rows undefined rows', value: changed(instrumentRowsBaseline, 'rows', undefined) },
  { name: 'instrument rows null row', value: changed(instrumentRowsBaseline, 'rows', [null]) },
  { name: 'instrument rows ticker mapping injection', value: extra(instrumentRowsBaseline, 'canonicalTicker') },
  { name: 'instrument rows rank injection', value: extra(instrumentRowsBaseline, 'rank') },
  { name: 'instrument rows recommendation injection', value: extra(instrumentRowsBaseline, 'recommendation') },
  { name: 'instrument rows BUY injection', value: extra(instrumentRowsBaseline, 'buy') },
  { name: 'instrument rows score injection', value: extra(instrumentRowsBaseline, 'score') },
  { name: 'instrument rows Symbol key', value: symbolExtra(instrumentRowsBaseline) },
  { name: 'instrument rows accessor', value: accessor(instrumentRowsBaseline, 'projectionPolicyId') },
  { name: 'instrument rows non-enumerable field', value: nonEnumerable(instrumentRowsBaseline, 'rows') },
  { name: 'instrument rows inherited prototype', value: inherited(instrumentRowsBaseline) },
];

const reportCases = [
  { name: 'report wrong schema', value: changed(reportBaseline, 'schemaVersion', 'MarketMacroFullComputationReport/2') },
  { name: 'report missing schema', value: omitted(reportBaseline, 'schemaVersion') },
  { name: 'report forged session count', value: changed(reportBaseline, 'sessionCount', 1) },
  { name: 'report negative instrument count', value: changed(reportBaseline, 'instrumentCount', -1) },
  { name: 'report fractional row count', value: changed(reportBaseline, 'fullStateRowCount', 0.5) },
  { name: 'report NaN row count', value: changed(reportBaseline, 'instrumentRowCount', Number.NaN) },
  { name: 'report Infinity count', value: changed(reportBaseline, 'futureObservationRejectedCount', Number.POSITIVE_INFINITY) },
  { name: 'report undefined count', value: changed(reportBaseline, 'futureRevisionRejectedCount', undefined) },
  { name: 'report string count', value: changed(reportBaseline, 'futureCalendarUpdateRejectedCount', '0') },
  { name: 'report forged empty flag', value: changed(reportBaseline, 'emptyComputation', false) },
  { name: 'report forged first session ID', value: changed(reportBaseline, 'firstSessionId', ID) },
  { name: 'report forged last session date', value: changed(reportBaseline, 'lastSessionDate', '2026-01-01') },
  { name: 'report Date wire session date', value: changed(reportBaseline, 'firstSessionDate', new Date()) },
  { name: 'report bad rows digest', value: changed(reportBaseline, 'orderedFullStateRowDigest', 'sha256:bad') },
  { name: 'report bad instrument digest', value: changed(reportBaseline, 'orderedInstrumentRowDigest', 'latest') },
  { name: 'report bad provenance digest', value: changed(reportBaseline, 'orderedFullProvenanceDigest', null) },
  { name: 'report inflation count Map', value: changed(reportBaseline, 'inflationRegimeCounts', new Map()) },
  { name: 'report labor count Set', value: changed(reportBaseline, 'laborRegimeCounts', new Set()) },
  { name: 'report claims count missing key', value: (() => { const v = reportBaseline(); delete v.claimsRegimeCounts.NORMAL; return v; })() },
  { name: 'report composite count unknown key', value: (() => { const v = reportBaseline(); v.compositeStateCounts.LATEST = 0; return v; })() },
  { name: 'report projection count negative', value: (() => { const v = reportBaseline(); v.projectionStatusCounts.PROJECTED = -1; return v; })() },
  { name: 'report unknown field', value: extra(reportBaseline, 'nearestSession') },
  { name: 'report Symbol key', value: symbolExtra(reportBaseline) },
  { name: 'report accessor', value: accessor(reportBaseline, 'fullStateRowsId') },
  { name: 'report non-enumerable field', value: nonEnumerable(reportBaseline, 'sessionCount') },
  { name: 'report inherited prototype', value: inherited(reportBaseline) },
];

const groups = [
  { label: 'policy', normalize: normalizeMarketMacroInstrumentProjectionPolicyV1, cases: policyCases },
  { label: 'full rows', normalize: normalizeMarketMacroFullStateRowsV1, cases: fullCases },
  { label: 'instrument rows', normalize: normalizeMarketMacroInstrumentRowsV1, cases: instrumentCases },
  { label: 'report', normalize: normalizeMarketMacroFullComputationReportV1, cases: reportCases },
];

for (const group of groups) {
  for (const corruption of group.cases) {
    test(`adversarial ${group.label}: ${corruption.name}`, () => {
      assert.throws(() => group.normalize(corruption.value));
    });
  }
}

test('adversarial inventory contains exactly 101 distinct internal corruptions', () => {
  const names = groups.flatMap((group) => group.cases.map((item) => `${group.label}:${item.name}`));
  assert.equal(names.length, 101);
  assert.equal(new Set(names).size, names.length);
});

test('all four uncorrupted empty canonical baselines normalize', () => {
  assert.deepEqual(normalizeMarketMacroInstrumentProjectionPolicyV1(policyBaseline()), policyBaseline());
  assert.deepEqual(normalizeMarketMacroFullStateRowsV1(fullRowsBaseline()), fullRowsBaseline());
  assert.deepEqual(normalizeMarketMacroInstrumentRowsV1(instrumentRowsBaseline()), instrumentRowsBaseline());
  assert.deepEqual(normalizeMarketMacroFullComputationReportV1(reportBaseline()), reportBaseline());
});
