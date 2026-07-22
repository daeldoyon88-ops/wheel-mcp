/**
 * L4B-I1 contract tests: closed canonicality of the eight macro schemas,
 * exact registry counts, byte-stability and the deterministic New-York
 * derivation. All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { canonicalJsonBytes, canonicalHash } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_INGESTION_L4B_SCHEMA_VERSIONS,
  MACRO_INGESTION_POLICY_SCHEMA_VERSION,
  MACRO_INGESTION_POLICY_VALUES,
  MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION,
  deriveNewYorkUtcInstantV1,
  macroSeriesIdentityIdFor,
  macroVintageIdentityIdFor,
  newYorkDaylightSavingBoundsV1,
  normalizeMacroFixedPointValueV1,
  normalizeMacroIngestionPolicyV1,
  normalizeMacroObservationIdentityCoreV1,
  normalizeMacroSeriesIdentityCoreV1,
  normalizeMacroVintageIdentityCoreV1,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import {
  code,
  syntheticMacroSeriesIdentity,
} from './macroIngestionL4BSyntheticFixture.mjs';

const FAKE_ID = `sha256:${'a'.repeat(64)}`;
const FAKE_ID_B = `sha256:${'b'.repeat(64)}`;

function validSeriesIdentity(overrides = {}) {
  return { ...syntheticMacroSeriesIdentity('US.NYFED.EFFR'), ...overrides };
}

function validObservationIdentity(overrides = {}) {
  return {
    schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
    macroSeriesIdentityId: FAKE_ID,
    observationPeriodStart: '2026-01-05',
    observationPeriodEnd: '2026-01-05',
    referencePeriod: '2026-01-05',
    unit: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE',
    ...overrides,
  };
}

function validVintageIdentity(overrides = {}) {
  return {
    schemaVersion: MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION,
    observationIdentityId: FAKE_ID,
    availableAt: '2026-01-06T14:00:00.000Z',
    vintageSequence: 0,
    sourceDocumentId: FAKE_ID_B,
    ...overrides,
  };
}

function validPolicy() {
  return {
    schemaVersion: MACRO_INGESTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_INGESTION_POLICY_VALUES),
  };
}

test('L4B-I1 registers exactly the eight macro schemas: 97 total, all unique', () => {
  assert.equal(MACRO_INGESTION_L4B_SCHEMA_VERSIONS.length, 8);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 97);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 97);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-8),
    [...MACRO_INGESTION_L4B_SCHEMA_VERSIONS]);
});

test('L4B-I1 adds no normalized CAS type: exactly 5, all unique', () => {
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  assert.equal(new Set(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS).size, 5);
  for (const schema of MACRO_INGESTION_L4B_SCHEMA_VERSIONS) {
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(schema), false);
  }
});

test('every macro schema dispatches through the canonical registry', () => {
  assert.deepEqual(
    normalizeCanonicalValue(MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION, validSeriesIdentity()),
    normalizeMacroSeriesIdentityCoreV1(validSeriesIdentity()),
  );
  assert.deepEqual(
    normalizeCanonicalValue(MACRO_INGESTION_POLICY_SCHEMA_VERSION, validPolicy()),
    normalizeMacroIngestionPolicyV1(validPolicy()),
  );
});

test('series identity: valid value normalizes to stable canonical bytes', () => {
  const first = canonicalJsonBytes(normalizeMacroSeriesIdentityCoreV1(validSeriesIdentity()));
  const second = canonicalJsonBytes(normalizeMacroSeriesIdentityCoreV1(validSeriesIdentity()));
  assert.deepEqual(first, second);
  assert.equal(macroSeriesIdentityIdFor(validSeriesIdentity()),
    canonicalHash(MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
      normalizeMacroSeriesIdentityCoreV1(validSeriesIdentity())));
});

test('series identity: title and provider code are rejected as unknown keys', () => {
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(
    validSeriesIdentity({ title: 'Synthetic title' })),
  code('MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID'));
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(
    validSeriesIdentity({ providerSeriesCode: 'EFFR' })),
  code('MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID'));
});

const seriesIdentityAdversarial = [
  ['unknown key', validSeriesIdentity({ extra: 1 })],
  ['missing field', (() => { const v = validSeriesIdentity(); delete v.units; return v; })()],
  ['unknown enum jurisdiction', validSeriesIdentity({ jurisdictionCode: 'CANADA' })],
  ['unknown enum currency', validSeriesIdentity({ currencyCode: 'CAD' })],
  ['unknown enum authority', validSeriesIdentity({ sourceAuthority: 'YAHOO_FINANCE' })],
  ['unknown enum frequency', validSeriesIdentity({ frequency: 'QUARTERLY' })],
  ['unknown enum units', validSeriesIdentity({ units: 'DOLLARS' })],
  ['unknown enum seasonal adjustment', validSeriesIdentity({ seasonalAdjustment: 'MAYBE' })],
  ['unknown enum revision policy', validSeriesIdentity({ revisionPolicy: 'WHATEVER' })],
  ['free-text methodology', validSeriesIdentity({ methodologyVersionId: 'v2 improved' })],
  ['non-canonical series code', validSeriesIdentity({ canonicalSeriesCode: 'effr' })],
  ['validThrough before validFrom',
    validSeriesIdentity({ validFrom: '2024-01-01', validThrough: '2020-01-01' })],
  ['wrong type sequence', validSeriesIdentity({ validFrom: 20200101 })],
];

for (const [label, value] of seriesIdentityAdversarial) {
  test(`series identity rejects: ${label}`, () => {
    assert.throws(() => normalizeMacroSeriesIdentityCoreV1(value));
  });
}

test('series identity rejects Symbol keys, accessors and non-enumerable fields', () => {
  const symbolCarrier = validSeriesIdentity();
  symbolCarrier[Symbol.for('macro')] = 1;
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(symbolCarrier),
    code('MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID'));

  const accessorCarrier = validSeriesIdentity();
  delete accessorCarrier.units;
  Object.defineProperty(accessorCarrier, 'units', { get: () => 'PERCENT', enumerable: true, configurable: true });
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(accessorCarrier),
    code('MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID'));

  const hiddenCarrier = validSeriesIdentity();
  delete hiddenCarrier.units;
  Object.defineProperty(hiddenCarrier, 'units', { value: 'PERCENT', enumerable: false, configurable: true });
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(hiddenCarrier),
    code('MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID'));
});

test('series identity rejects unexpected prototypes and non-objects', () => {
  const prototyped = Object.assign(Object.create({ inherited: true }), validSeriesIdentity());
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(prototyped));
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(new Map()));
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1(null));
  assert.throws(() => normalizeMacroSeriesIdentityCoreV1([validSeriesIdentity()]));
});

test('observation identity: valid daily value normalizes with stable bytes', () => {
  const normalized = normalizeMacroObservationIdentityCoreV1(validObservationIdentity());
  assert.deepEqual(canonicalJsonBytes(normalized),
    canonicalJsonBytes(normalizeMacroObservationIdentityCoreV1(validObservationIdentity())));
});

const observationAdversarial = [
  ['unknown key', validObservationIdentity({ value: 1 }), undefined],
  ['embedded release timestamp', validObservationIdentity({ releaseTimestamp: '2026-01-06T14:00:00.000Z' }), undefined],
  ['embedded vintage order', validObservationIdentity({ vintageSequence: 0 }), undefined],
  ['missing field', (() => { const v = validObservationIdentity(); delete v.unit; return v; })(), undefined],
  ['period reversed', validObservationIdentity({
    observationPeriodStart: '2026-01-07', observationPeriodEnd: '2026-01-05', referencePeriod: '2026-01-05',
  }), 'MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'],
  ['reference period free text', validObservationIdentity({ referencePeriod: 'january' }),
    'MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'],
  ['unknown unit', validObservationIdentity({ unit: 'DOLLARS' }), undefined],
  ['non-CAS series reference', validObservationIdentity({ macroSeriesIdentityId: 'latest' }), undefined],
];

for (const [label, value, expectedCode] of observationAdversarial) {
  test(`observation identity rejects: ${label}`, () => {
    assert.throws(() => normalizeMacroObservationIdentityCoreV1(value),
      expectedCode === undefined ? undefined : code(expectedCode));
  });
}

test('vintage identity: valid value normalizes and derives a stable identity ID', () => {
  const identityId = macroVintageIdentityIdFor(validVintageIdentity());
  assert.equal(identityId, macroVintageIdentityIdFor(validVintageIdentity()));
  assert.match(identityId, /^sha256:[0-9a-f]{64}$/);
});

const vintageIdentityAdversarial = [
  ['unknown key', validVintageIdentity({ value: { atoms: '1', scale: 0 } })],
  ['missing sourceDocumentId', (() => { const v = validVintageIdentity(); delete v.sourceDocumentId; return v; })()],
  ['non-UTC availableAt', validVintageIdentity({ availableAt: '2026-01-06T09:00:00.000-05:00' })],
  ['date-only availableAt', validVintageIdentity({ availableAt: '2026-01-06' })],
  ['negative sequence', validVintageIdentity({ vintageSequence: -1 })],
  ['float sequence', validVintageIdentity({ vintageSequence: 0.5 })],
  ['URL source document', validVintageIdentity({ sourceDocumentId: 'https://example.test/doc' })],
  ['path source document', validVintageIdentity({ sourceDocumentId: 'C:/data/doc.json' })],
];

for (const [label, value] of vintageIdentityAdversarial) {
  test(`vintage identity rejects: ${label}`, () => {
    assert.throws(() => normalizeMacroVintageIdentityCoreV1(value));
  });
}

const fixedPointAdversarial = [
  ['float number', 3.14, 'MARKET_DATA_INPUT_INVALID'],
  ['plain integer number', 42, 'MARKET_DATA_INPUT_INVALID'],
  ['NaN', NaN, 'MARKET_DATA_INPUT_INVALID'],
  ['Infinity', Infinity, 'MARKET_DATA_INPUT_INVALID'],
  ['negative zero atoms', { atoms: '-0', scale: 2 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['exponential atoms', { atoms: '1e5', scale: 0 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['leading zero atoms', { atoms: '007', scale: 0 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['decimal point atoms', { atoms: '4.33', scale: 2 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['whitespace atoms', { atoms: ' 433', scale: 2 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['numeric atoms', { atoms: 433, scale: 2 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['negative scale', { atoms: '433', scale: -1 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['huge scale', { atoms: '433', scale: 13 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['unknown key', { atoms: '433', scale: 2, unit: 'PERCENT' }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
  ['oversized atoms', { atoms: '9'.repeat(39), scale: 0 }, 'MARKET_DATA_MACRO_VINTAGE_INVALID'],
];

for (const [label, value, expectedCode] of fixedPointAdversarial) {
  test(`fixed-point value rejects: ${label}`, () => {
    assert.throws(() => normalizeMacroFixedPointValueV1(value), code(expectedCode));
  });
}

test('fixed-point value accepts canonical atoms/scale losslessly', () => {
  assert.deepEqual(normalizeMacroFixedPointValueV1({ atoms: '433', scale: 2 }),
    { atoms: '433', scale: 2 });
  assert.deepEqual(normalizeMacroFixedPointValueV1({ atoms: '-125', scale: 2 }),
    { atoms: '-125', scale: 2 });
  assert.deepEqual(normalizeMacroFixedPointValueV1({ atoms: '0', scale: 0 }),
    { atoms: '0', scale: 0 });
});

test('New-York DST bounds follow the closed post-2007 statute', () => {
  assert.deepEqual(newYorkDaylightSavingBoundsV1('2026-01-15'),
    { dstStartDate: '2026-03-08', dstEndDate: '2026-11-01' });
  assert.deepEqual(newYorkDaylightSavingBoundsV1('2025-06-01'),
    { dstStartDate: '2025-03-09', dstEndDate: '2025-11-02' });
  assert.throws(() => newYorkDaylightSavingBoundsV1('2006-06-01'),
    code('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID'));
});

test('New-York derivation pins EST (UTC-5) and EDT (UTC-4) deterministically', () => {
  assert.equal(deriveNewYorkUtcInstantV1('2026-01-13', '08:30'), '2026-01-13T13:30:00.000Z');
  assert.equal(deriveNewYorkUtcInstantV1('2026-07-13', '08:30'), '2026-07-13T12:30:00.000Z');
  assert.equal(deriveNewYorkUtcInstantV1('2026-01-05', '16:00'), '2026-01-05T21:00:00.000Z');
  assert.equal(deriveNewYorkUtcInstantV1('2026-12-31', '23:30'), '2027-01-01T04:30:00.000Z');
});

test('New-York derivation fails closed on the DST transition anomalies', () => {
  assert.throws(() => deriveNewYorkUtcInstantV1('2026-03-08', '02:30'),
    code('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID'));
  assert.throws(() => deriveNewYorkUtcInstantV1('2026-11-01', '01:30'),
    code('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID'));
  assert.equal(deriveNewYorkUtcInstantV1('2026-03-08', '01:59'), '2026-03-08T06:59:00.000Z');
  assert.equal(deriveNewYorkUtcInstantV1('2026-03-08', '03:00'), '2026-03-08T07:00:00.000Z');
  assert.equal(deriveNewYorkUtcInstantV1('2026-11-01', '00:59'), '2026-11-01T04:59:00.000Z');
  assert.equal(deriveNewYorkUtcInstantV1('2026-11-01', '02:00'), '2026-11-01T07:00:00.000Z');
});

test('New-York derivation rejects malformed local times', () => {
  for (const bad of ['8:30', '24:00', '08:60', '08:30:00', '', null, 830]) {
    assert.throws(() => deriveNewYorkUtcInstantV1('2026-01-13', bad),
      code('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID'));
  }
});

test('policy: the closed V1 singleton normalizes to stable canonical bytes', () => {
  const first = canonicalJsonBytes(normalizeMacroIngestionPolicyV1(validPolicy()));
  const second = canonicalJsonBytes(normalizeMacroIngestionPolicyV1(validPolicy()));
  assert.deepEqual(first, second);
});

test('policy: every field divergence from the closed V1 is rejected', () => {
  for (const field of Object.keys(MACRO_INGESTION_POLICY_VALUES)) {
    const forged = validPolicy();
    forged[field] = 'FORGED';
    assert.throws(() => normalizeMacroIngestionPolicyV1(forged),
      code('MARKET_DATA_MACRO_POLICY_INVALID'), `field ${field}`);
  }
});
