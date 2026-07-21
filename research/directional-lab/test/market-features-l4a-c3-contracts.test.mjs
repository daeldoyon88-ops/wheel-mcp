import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_POLICY_VALUES,
  MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_SET_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
  MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
  normalizeMarketFeaturePublicationAuthorityPolicyV1,
  normalizeMarketFeaturePublicationManifestV1,
  normalizeMarketFeaturePublicationRegistryManifestV1,
} from '../src/contracts/marketFeaturePublicationContractsV1.mjs';
import {
  MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS,
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';

const id = (character) => `sha256:${character.repeat(64)}`;
const coverage = () => ({
  rowCount: 2, firstSessionDate: '2026-01-02', lastSessionDate: '2026-01-03',
  orderedRowIdentityDigest: id('d'),
});

function policy() {
  return { schemaVersion: MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_FEATURE_PUBLICATION_POLICY_VALUES) };
}

function family(familyCode, offset) {
  const technical = familyCode === MARKET_TECHNICAL_FEATURE_FAMILY_CODE;
  const volume = familyCode === MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE;
  return {
    familyCode,
    featureFamilyVersion: technical ? { ...MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS }
      : volume ? { ...MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS }
        : MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
    rowsSchemaVersion: technical ? MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION
      : volume ? MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION
        : MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    reportSchemaVersion: technical ? MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION
      : volume ? MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION
        : MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    sourceBundleId: id(String(offset)), computationPolicyId: id(String(offset + 1)),
    rowsId: id(String(offset + 2)), reportId: id(String(offset + 3)),
    implementationManifestId: id(String(offset + 4)), instrumentIdentityId: id('a'),
    datasetSnapshotBindingId: id('b'), datasetSnapshotManifestId: id('c'),
    normalizedMarketDataObjectId: id('e'), calendarRegistryManifestId: id('f'),
    knowledgeCutoff: '2026-01-03T22:00:00.000Z', temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED',
    priceBasis: 'RAW', corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED', ...coverage(),
  };
}

function manifest() {
  return {
    schemaVersion: MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: id('9'), featureSetVersion: MARKET_FEATURE_SET_VERSION,
    instrumentIdentityId: id('a'), datasetSnapshotBindingId: id('b'),
    datasetSnapshotManifestId: id('c'), normalizedMarketDataObjectId: id('e'),
    calendarRegistryManifestId: id('f'), knowledgeCutoff: '2026-01-03T22:00:00.000Z',
    temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED', priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED', sessionCoverage: coverage(),
    families: [family(MARKET_TECHNICAL_FEATURE_FAMILY_CODE, 1),
      family(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE, 2),
      family(MARKET_SEASONALITY_FEATURE_FAMILY_CODE, 3)],
  };
}

function entry(overrides = {}) {
  return {
    publicationManifestId: id('1'),
    logicalKey: { instrumentIdentityId: id('a'), datasetSnapshotBindingId: id('b'),
      publicationAuthorityPolicyId: id('9'), featureSetVersion: MARKET_FEATURE_SET_VERSION },
    knowledgeCutoff: '2026-01-03T22:00:00.000Z', sessionCoverage: coverage(),
    supersedesPublicationManifestId: null, ...overrides,
  };
}

test('C3 contract accepts the closed authority policy', () => {
  assert.deepEqual(normalizeMarketFeaturePublicationAuthorityPolicyV1(policy()), policy());
});

for (const [name, mutate] of [
  ['unknown key', (value) => { value.unknown = true; }],
  ['missing key', (value) => { delete value.publicationMode; }],
  ['missing family', (value) => { value.requiredFamilyCodes.pop(); }],
  ['extra family', (value) => { value.requiredFamilyCodes.push('EXTRA'); }],
  ['family order', (value) => { value.requiredFamilyCodes.reverse(); }],
  ['latest enabled', (value) => { value.latestResolutionPolicy = 'ALLOWED'; }],
  ['cross binding enabled', (value) => { value.crossBindingPublicationPolicy = 'ALLOWED'; }],
]) test(`C3 policy refuses ${name}`, () => {
  const value = policy(); mutate(value);
  assert.throws(() => normalizeMarketFeaturePublicationAuthorityPolicyV1(value));
});

for (const attack of ['non-enumerable', 'accessor', 'symbol', 'prototype']) {
  test(`C3 policy refuses ${attack} shape`, () => {
    let value = policy();
    if (attack === 'non-enumerable') Object.defineProperty(value, 'hidden', { value: true });
    if (attack === 'accessor') Object.defineProperty(value, 'publicationMode', { enumerable: true, get: () => 'REFERENCE_MANIFEST_ONLY' });
    if (attack === 'symbol') value[Symbol('hidden')] = true;
    if (attack === 'prototype') value = Object.assign(Object.create({ inherited: true }), value);
    assert.throws(() => normalizeMarketFeaturePublicationAuthorityPolicyV1(value));
  });
}

test('C3 contract accepts the closed A/B/C reference manifest', () => {
  assert.deepEqual(normalizeMarketFeaturePublicationManifestV1(manifest()), manifest());
});

const topFields = [
  'publicationAuthorityPolicyId', 'featureSetVersion', 'instrumentIdentityId',
  'datasetSnapshotBindingId', 'datasetSnapshotManifestId', 'normalizedMarketDataObjectId',
  'calendarRegistryManifestId', 'knowledgeCutoff', 'temporalCapability', 'priceBasis',
  'corporateActionTreatment', 'sessionCoverage', 'families',
];
for (const field of topFields) test(`C3 manifest refuses missing top field ${field}`, () => {
  const value = manifest(); delete value[field];
  assert.throws(() => normalizeMarketFeaturePublicationManifestV1(value));
});

for (const [name, mutate] of [
  ['family A missing', (value) => value.families.splice(0, 1)],
  ['family B missing', (value) => value.families.splice(1, 1)],
  ['family C missing', (value) => value.families.splice(2, 1)],
  ['family A duplicate', (value) => { value.families[1] = structuredClone(value.families[0]); }],
  ['family B duplicate', (value) => { value.families[2] = structuredClone(value.families[1]); }],
  ['A/C/B order', (value) => { [value.families[1], value.families[2]] = [value.families[2], value.families[1]]; }],
  ['unknown family', (value) => { value.families[0].familyCode = 'UNKNOWN'; }],
  ['wrong feature set', (value) => { value.featureSetVersion = 'MARKET_FEATURE_SET_L4A_ABC/2'; }],
  ['wrong A family version', (value) => { value.families[0].featureFamilyVersion.returnsDrawdowns = 'BAD'; }],
  ['wrong B family version', (value) => { value.families[1].featureFamilyVersion.pivots = 'BAD'; }],
  ['wrong C family version', (value) => { value.families[2].featureFamilyVersion = 'BAD'; }],
  ['wrong A rows schema', (value) => { value.families[0].rowsSchemaVersion = 'Bad/1'; }],
  ['wrong B report schema', (value) => { value.families[1].reportSchemaVersion = 'Bad/1'; }],
  ['wrong C rows schema', (value) => { value.families[2].rowsSchemaVersion = 'Bad/1'; }],
  ['invalid parent cutoff', (value) => { value.knowledgeCutoff = 'bad'; }],
  ['invalid family cutoff', (value) => { value.families[1].knowledgeCutoff = 'bad'; }],
  ['invalid temporal capability', (value) => { value.temporalCapability = 'FUTURE'; }],
  ['invalid price basis', (value) => { value.families[0].priceBasis = 'CLOSE_ONLY'; }],
  ['invalid treatment', (value) => { value.corporateActionTreatment = 'MUTABLE'; }],
  ['negative coverage', (value) => { value.sessionCoverage.rowCount = -1; }],
  ['empty coverage with dates', (value) => { value.sessionCoverage.rowCount = 0; }],
  ['bad digest', (value) => { value.sessionCoverage.orderedRowIdentityDigest = 'sha256:bad'; }],
  ['reversed dates', (value) => { value.families[2].firstSessionDate = '2026-01-04'; }],
  ['unknown top key', (value) => { value.rows = []; }],
  ['unknown family key', (value) => { value.families[0].ticker = 'ABC'; }],
]) test(`C3 manifest refuses ${name}`, () => {
  const value = manifest(); mutate(value);
  assert.throws(() => normalizeMarketFeaturePublicationManifestV1(value));
});

for (const field of ['sourceBundleId', 'computationPolicyId', 'rowsId', 'reportId',
  'implementationManifestId', 'instrumentIdentityId', 'datasetSnapshotBindingId',
  'datasetSnapshotManifestId', 'normalizedMarketDataObjectId', 'calendarRegistryManifestId']) {
  test(`C3 manifest refuses invalid family CAS field ${field}`, () => {
    const value = manifest(); value.families[1][field] = 'sha256:bad';
    assert.throws(() => normalizeMarketFeaturePublicationManifestV1(value));
  });
}

for (const attack of ['non-enumerable', 'accessor', 'symbol']) {
  test(`C3 manifest refuses ${attack} nested shape`, () => {
    const value = manifest();
    if (attack === 'non-enumerable') Object.defineProperty(value.families[0], 'hidden', { value: true });
    if (attack === 'accessor') Object.defineProperty(value.sessionCoverage, 'rowCount', { enumerable: true, get: () => 2 });
    if (attack === 'symbol') value.families[2][Symbol('hidden')] = true;
    assert.throws(() => normalizeMarketFeaturePublicationManifestV1(value));
  });
}

test('C3 registry contract accepts an empty canonical genesis', () => {
  const value = { schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: id('9'), supersedesRegistryManifestId: null, entries: [] };
  assert.deepEqual(normalizeMarketFeaturePublicationRegistryManifestV1(value), value);
});

test('C3 registry contract accepts one canonical entry', () => {
  const value = { schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: id('9'), supersedesRegistryManifestId: id('8'), entries: [entry()] };
  assert.deepEqual(normalizeMarketFeaturePublicationRegistryManifestV1(value), value);
});

for (const [name, mutate] of [
  ['unknown root key', (value) => { value.unknown = true; }],
  ['missing entries', (value) => { delete value.entries; }],
  ['bad policy id', (value) => { value.publicationAuthorityPolicyId = 'bad'; }],
  ['bad parent registry id', (value) => { value.supersedesRegistryManifestId = 'bad'; }],
  ['bad publication id', (value) => { value.entries[0].publicationManifestId = 'bad'; }],
  ['bad publication parent id', (value) => { value.entries[0].supersedesPublicationManifestId = 'bad'; }],
  ['bad logical instrument', (value) => { value.entries[0].logicalKey.instrumentIdentityId = 'bad'; }],
  ['bad logical binding', (value) => { value.entries[0].logicalKey.datasetSnapshotBindingId = 'bad'; }],
  ['bad logical policy', (value) => { value.entries[0].logicalKey.publicationAuthorityPolicyId = 'bad'; }],
  ['bad logical feature set', (value) => { value.entries[0].logicalKey.featureSetVersion = 'bad'; }],
  ['bad cutoff', (value) => { value.entries[0].knowledgeCutoff = 'bad'; }],
  ['bad coverage', (value) => { value.entries[0].sessionCoverage.rowCount = -1; }],
  ['unknown entry key', (value) => { value.entries[0].tip = true; }],
  ['unknown logical key', (value) => { value.entries[0].logicalKey.ticker = 'ABC'; }],
]) test(`C3 registry contract refuses ${name}`, () => {
  const value = { schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: id('9'), supersedesRegistryManifestId: id('8'), entries: [entry()] };
  mutate(value);
  assert.throws(() => normalizeMarketFeaturePublicationRegistryManifestV1(value));
});

test('C3 registry contract refuses non-canonical entry order', () => {
  const first = entry({ publicationManifestId: id('2'), knowledgeCutoff: '2026-01-04T22:00:00.000Z' });
  const second = entry({ publicationManifestId: id('1') });
  const value = { schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: id('9'), supersedesRegistryManifestId: id('8'), entries: [first, second] };
  assert.throws(() => normalizeMarketFeaturePublicationRegistryManifestV1(value));
});

for (const attack of ['non-enumerable', 'accessor', 'symbol']) {
  test(`C3 registry contract refuses ${attack} shape`, () => {
    const value = { schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      publicationAuthorityPolicyId: id('9'), supersedesRegistryManifestId: id('8'), entries: [entry()] };
    if (attack === 'non-enumerable') Object.defineProperty(value.entries[0], 'hidden', { value: true });
    if (attack === 'accessor') Object.defineProperty(value.entries[0], 'knowledgeCutoff', { enumerable: true, get: () => '2026-01-03T22:00:00.000Z' });
    if (attack === 'symbol') value.entries[0].logicalKey[Symbol('hidden')] = true;
    assert.throws(() => normalizeMarketFeaturePublicationRegistryManifestV1(value));
  });
}
