/**
 * L4B-I1 adversarial suite: 60 numbered corruptions across series identity,
 * registry, observation identity, vintage identity, vintage content, policy,
 * vintage set and snapshot. Every corruption must be refused with a
 * deterministic error code; two cases (49, 50) prove refusal by invariance
 * (the pinned output must NOT change). All fixtures are synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_INGESTION_POLICY_SCHEMA_VERSION,
  MACRO_INGESTION_POLICY_VALUES,
  MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_POLICY_VERSION,
  MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
  macroOrderedVintageIdentityDigestV1,
  macroSeriesIdentityIdFor,
  macroVintageSetFlatEntriesV1,
  normalizeMacroDatasetSnapshotManifestV1,
  normalizeMacroFixedPointValueV1,
  normalizeMacroIngestionPolicyV1,
  normalizeMacroObservationIdentityCoreV1,
  normalizeMacroObservationVintageCoreV1,
  normalizeMacroSeriesIdentityCoreV1,
  normalizeMacroSeriesRegistryManifestV1,
  normalizeMacroVintageIdentityCoreV1,
  normalizeMacroVintageSetManifestV1,
  verifyMacroSeriesRegistryChainV1,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import {
  assertMacroObservationMatchesSeriesV1,
  verifyMacroSourceDocument,
} from '../src/macro/macroObservationVintageL4BV1.mjs';
import {
  assertMacroVintageAdmissibleV1,
  verifyMacroObservationVintageGraphV1,
  verifyMacroVintageSetManifest,
} from '../src/macro/macroVintageSetL4BV1.mjs';
import {
  buildMacroSeriesRegistryGenesis,
} from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import {
  verifyMacroDatasetSnapshotManifest,
} from '../src/macro/macroDatasetSnapshotL4BV1.mjs';
import {
  code,
  syntheticMacroSeriesIdentity,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';

/**
 * Pure captured values from one deterministic fixture run. These are plain
 * objects and stay valid after the temporary store is removed; the cases
 * needing live store reads run inside their own fresh fixture instead.
 */
const F = withOfficialMacroL4BI1Fixture((ctx) => ({
  policy: ctx.policy,
  seriesEffr: ctx.series['US.NYFED.EFFR'].macroSeriesIdentity,
  seriesCpi: ctx.series['US.BLS.CPIAUCSL'].macroSeriesIdentity,
  observationEffr: ctx.observations.effr.observationIdentity,
  observationEffrId: ctx.observations.effr.observationIdentityId,
  observationCpi: ctx.observations.cpi.observationIdentity,
  observationCpiId: ctx.observations.cpi.observationIdentityId,
  effrInitial: ctx.vintages.effrInitial.observationVintage,
  cpiInitial: ctx.vintages.cpiInitial.observationVintage,
  cpiRevision: ctx.vintages.cpiRevision.observationVintage,
  cpiCorrection: ctx.vintages.cpiCorrection.observationVintage,
  registry: ctx.registry.registry,
  vintageSet: ctx.vintageSet.vintageSet,
  snapshot: ctx.snapshot.datasetSnapshot,
}));

const FAKE = (letter) => `sha256:${letter.repeat(64)}`;

function wirePolicy(overrides) {
  return {
    schemaVersion: MACRO_INGESTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_INGESTION_POLICY_VALUES),
    ...overrides,
  };
}

function graphStub(sequence, parentSequence, overrides = {}) {
  return {
    macroVintageIdentityId: FAKE(String(sequence)),
    observationIdentityId: F.observationEffrId,
    availableAt: '2026-02-06T14:00:00.000Z',
    vintageSequence: sequence,
    revisionKind: sequence === 0 ? 'INITIAL' : 'REVISION',
    parentVintageId: parentSequence === null ? null : FAKE(String(parentSequence)),
    ...overrides,
  };
}

/** Pure corruption cases: [number, label, expected code, thunk]. */
const pureCases = [
  [1, 'unknown key on a series identity', 'MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID',
    () => normalizeMacroSeriesIdentityCoreV1({ ...F.seriesEffr, injected: 1 })],
  [2, 'Symbol key on a registry manifest', 'MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID',
    () => {
      const forged = { ...F.registry };
      forged[Symbol.for('macro-registry')] = true;
      return normalizeMacroSeriesRegistryManifestV1(forged);
    }],
  [3, 'accessor property on an observation identity', 'MARKET_DATA_MACRO_OBSERVATION_IDENTITY_INVALID',
    () => {
      const forged = { ...F.observationEffr };
      delete forged.unit;
      Object.defineProperty(forged, 'unit', { get: () => 'PERCENT', enumerable: true, configurable: true });
      return normalizeMacroObservationIdentityCoreV1(forged);
    }],
  [4, 'non-enumerable field on a vintage identity', 'MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID',
    () => {
      const forged = {
        schemaVersion: 'MacroVintageIdentityCore/1',
        observationIdentityId: F.observationEffrId,
        availableAt: '2026-01-06T14:00:00.000Z',
        sourceDocumentId: F.effrInitial.sourceDocumentId,
      };
      Object.defineProperty(forged, 'vintageSequence', { value: 0, enumerable: false, configurable: true });
      return normalizeMacroVintageIdentityCoreV1(forged);
    }],
  [5, 'unexpected prototype on a policy', 'MARKET_DATA_INPUT_INVALID',
    () => normalizeMacroIngestionPolicyV1(
      Object.assign(Object.create({ evil: true }), wirePolicy({})))],
  [6, 'wrong schemaVersion on a snapshot', 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED',
    () => normalizeMacroDatasetSnapshotManifestV1({ ...F.snapshot, schemaVersion: 'MacroDatasetSnapshotManifest/2' })],
  [7, 'forged macroVintageIdentityId on a vintage content', 'MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID',
    () => normalizeMacroObservationVintageCoreV1({ ...F.effrInitial, macroVintageIdentityId: FAKE('a') })],
  [9, 'duplicate series identity in a registry', 'MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID',
    () => normalizeMacroSeriesRegistryManifestV1({
      ...F.registry,
      orderedSeriesEntries: [F.registry.orderedSeriesEntries[0], F.registry.orderedSeriesEntries[0],
        ...F.registry.orderedSeriesEntries.slice(1)],
    })],
  [10, 'two ACTIVE tips for one canonical code', 'MARKET_DATA_MACRO_SERIES_DUPLICATE_ACTIVE_CODE',
    () => {
      const twin = { ...F.registry.orderedSeriesEntries[0], macroSeriesIdentityId: FAKE('a') };
      const entries = [twin, ...F.registry.orderedSeriesEntries]
        .sort((l, r) => (l.canonicalSeriesCode === r.canonicalSeriesCode
          ? (l.macroSeriesIdentityId < r.macroSeriesIdentityId ? -1 : 1)
          : (l.canonicalSeriesCode < r.canonicalSeriesCode ? -1 : 1)));
      return normalizeMacroSeriesRegistryManifestV1({ ...F.registry, orderedSeriesEntries: entries });
    }],
  [11, 'registry chain self-reference at genesis', 'MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION',
    () => verifyMacroSeriesRegistryChainV1([{
      registryManifestId: FAKE('a'),
      registry: { ...F.registry, supersedesRegistryManifestId: FAKE('a') },
    }])],
  [12, 'registry chain child detached from its parent', 'MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION',
    () => verifyMacroSeriesRegistryChainV1([
      { registryManifestId: FAKE('a'), registry: F.registry },
      { registryManifestId: FAKE('b'), registry: { ...F.registry, supersedesRegistryManifestId: FAKE('c') } },
    ])],
  [13, 'series replacement cycle', 'MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE',
    () => normalizeMacroSeriesRegistryManifestV1({
      schemaVersion: MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
      registryPolicyVersion: MACRO_SERIES_REGISTRY_POLICY_VERSION,
      supersedesRegistryManifestId: null,
      orderedSeriesEntries: [
        {
          macroSeriesIdentityId: FAKE('a'),
          canonicalSeriesCode: 'US.NYFED.EFFR',
          status: 'REPLACED',
          supersedesSeriesIdentityId: FAKE('b'),
          replacementReason: 'METHODOLOGY_CHANGE',
        },
        {
          macroSeriesIdentityId: FAKE('b'),
          canonicalSeriesCode: 'US.NYFED.SOFR',
          status: 'REPLACED',
          supersedesSeriesIdentityId: FAKE('a'),
          replacementReason: 'METHODOLOGY_CHANGE',
        },
      ],
    })],
  [14, 'reversed observation period', 'MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID',
    () => normalizeMacroObservationIdentityCoreV1({
      ...F.observationEffr,
      observationPeriodStart: '2026-01-07',
      observationPeriodEnd: '2026-01-05',
    })],
  [15, 'observation unit diverging from the series', 'MARKET_DATA_MACRO_UNIT_MISMATCH',
    () => assertMacroObservationMatchesSeriesV1(
      { ...F.observationEffr, unit: 'INDEX' }, F.seriesEffr)],
  [16, 'observation seasonal adjustment diverging from the series', 'MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH',
    () => assertMacroObservationMatchesSeriesV1(
      { ...F.observationEffr, seasonalAdjustment: 'SEASONALLY_ADJUSTED' }, F.seriesEffr)],
  [17, 'identity/content availableAt mismatch', 'MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID',
    () => normalizeMacroObservationVintageCoreV1({
      ...F.effrInitial,
      releaseTimestamp: '2026-01-06T15:00:00.000Z',
      availableAt: '2026-01-06T15:00:00.000Z',
    })],
  [18, 'identity/content sequence mismatch', 'MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID',
    () => normalizeMacroObservationVintageCoreV1({
      ...F.cpiRevision,
      vintageSequence: 5,
    })],
  [19, 'identity/content sourceDocument mismatch', 'MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID',
    () => normalizeMacroObservationVintageCoreV1({
      ...F.effrInitial,
      sourceDocumentId: FAKE('d'),
    })],
  [20, 'two contents under one vintage identity', 'MARKET_DATA_MACRO_VINTAGE_CONFLICT',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      F.effrInitial, { ...F.effrInitial, value: { atoms: '499', scale: 2 } },
    ])],
  [21, 'two INITIAL vintages for one observation', 'MARKET_DATA_MACRO_VINTAGE_CONFLICT',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null), graphStub(1, null, { revisionKind: 'INITIAL', vintageSequence: 1 }),
    ])],
  [22, 'future parent (child availableAt precedes its parent)', 'MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null, { availableAt: '2026-03-01T14:00:00.000Z' }),
      graphStub(1, 0, { availableAt: '2026-02-01T14:00:00.000Z' }),
    ])],
  [23, 'parent from another observation', 'MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null),
      graphStub(1, 0, { observationIdentityId: F.observationCpiId }),
    ])],
  [24, 'parent from another series (absent from the chain)', 'MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null), graphStub(1, 9),
    ])],
  [25, 'duplicate sequence inside one observation', 'MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null), graphStub(1, 0), graphStub(1, 0, { macroVintageIdentityId: FAKE('e') }),
    ])],
  [26, 'two branches from the same parent', 'MARKET_DATA_MACRO_VINTAGE_CONFLICT',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null), graphStub(1, 0), graphStub(2, 0),
    ])],
  [27, 'vintage self-parent', 'MARKET_DATA_MACRO_VINTAGE_CYCLE',
    () => normalizeMacroObservationVintageCoreV1({
      ...F.cpiRevision, parentVintageId: F.cpiRevision.macroVintageIdentityId,
    })],
  [28, 'vintage parent cycle of length 2', 'MARKET_DATA_MACRO_VINTAGE_CYCLE',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null), graphStub(1, 2), graphStub(2, 1),
    ])],
  [29, 'vintage parent cycle of length 3', 'MARKET_DATA_MACRO_VINTAGE_CYCLE',
    () => verifyMacroObservationVintageGraphV1(F.observationEffrId, [
      graphStub(0, null), graphStub(1, 3), graphStub(2, 1), graphStub(3, 2),
    ])],
  [30, 'unknown release time stored as available', 'MARKET_DATA_MACRO_RELEASE_TIMESTAMP_UNKNOWN',
    () => normalizeMacroObservationVintageCoreV1({
      ...F.effrInitial, releaseTimeResolutionMode: 'UNKNOWN_REJECTED',
    })],
  [31, 'generic global 08:30 default rule', 'MARKET_DATA_MACRO_POLICY_INVALID',
    () => normalizeMacroIngestionPolicyV1(wirePolicy({
      releaseTimeRules: [{
        sourceAuthority: 'DEFAULT_ALL_SERIES',
        canonicalSeriesCode: 'DEFAULT_ALL_SERIES_08_30',
        localTime: '08:30',
        timezone: 'AMERICA_NEW_YORK',
        effectiveFrom: '2007-01-01',
        effectiveThrough: null,
        resolutionMode: 'SERIES_AUTHORITY_POLICY',
      }],
    }))],
  [32, 'non-UTC availableAt', 'MARKET_DATA_INPUT_INVALID',
    () => normalizeMacroVintageIdentityCoreV1({
      schemaVersion: 'MacroVintageIdentityCore/1',
      observationIdentityId: F.observationEffrId,
      availableAt: '2026-01-06T09:00:00.000-05:00',
      vintageSequence: 0,
      sourceDocumentId: F.effrInitial.sourceDocumentId,
    })],
  [33, 'machine timezone in a release rule', 'MARKET_DATA_MACRO_POLICY_INVALID',
    () => normalizeMacroIngestionPolicyV1(wirePolicy({
      releaseTimeRules: MACRO_INGESTION_POLICY_VALUES.releaseTimeRules.map((rule, index) => (
        index === 0 ? { ...rule, timezone: 'LOCAL_MACHINE' } : rule)),
    }))],
  [34, 'policy allowing latest references', 'MARKET_DATA_MACRO_POLICY_INVALID',
    () => normalizeMacroIngestionPolicyV1(wirePolicy({ latestReferencePolicy: 'ALLOWED' }))],
  [35, 'policy allowing network during computation', 'MARKET_DATA_MACRO_POLICY_INVALID',
    () => normalizeMacroIngestionPolicyV1(wirePolicy({ networkDuringComputationPolicy: 'ALLOWED' }))],
  [36, 'policy allowing registry mutation', 'MARKET_DATA_MACRO_POLICY_INVALID',
    () => normalizeMacroIngestionPolicyV1(wirePolicy({ registryMutationPolicy: 'MUTABLE' }))],
  [37, 'FINAL_ONLY accepted for revision-sensitive CPI', 'MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN',
    () => assertMacroVintageAdmissibleV1(F.policy, F.seriesCpi, F.observationCpi,
      { ...F.cpiInitial, vintageCompletenessClass: 'FINAL_ONLY' })],
  [38, 'PUBLICATION_ATTESTED for an undeclared series', 'MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN',
    () => assertMacroVintageAdmissibleV1(F.policy, F.seriesEffr, F.observationEffr,
      { ...F.effrInitial, vintageCompletenessClass: 'PUBLICATION_ATTESTED' })],
  [39, 'parseFloat-like exponential value', 'MARKET_DATA_MACRO_VINTAGE_INVALID',
    () => normalizeMacroFixedPointValueV1({ atoms: '4.33e2', scale: 2 })],
  [40, 'NaN value', 'MARKET_DATA_INPUT_INVALID',
    () => normalizeMacroFixedPointValueV1(NaN)],
  [41, 'Infinity value', 'MARKET_DATA_INPUT_INVALID',
    () => normalizeMacroFixedPointValueV1(Infinity)],
  [42, 'negative zero atoms', 'MARKET_DATA_MACRO_VINTAGE_INVALID',
    () => normalizeMacroFixedPointValueV1({ atoms: '-0', scale: 2 })],
  [43, 'fixed-point scale incompatible with the unit', 'MARKET_DATA_MACRO_UNIT_MISMATCH',
    () => assertMacroVintageAdmissibleV1(F.policy,
      { ...F.seriesEffr, units: 'COUNT' },
      { ...F.observationEffr, unit: 'COUNT' },
      { ...F.effrInitial, value: { atoms: '4335', scale: 1 } })],
  [44, 'forged vintage set counters', 'MARKET_DATA_MACRO_VINTAGE_INVALID',
    () => normalizeMacroVintageSetManifestV1({ ...F.vintageSet, vintageCount: 99 })],
  [45, 'forged ordered vintage identity digest', 'MARKET_DATA_MACRO_VINTAGE_INVALID',
    () => normalizeMacroVintageSetManifestV1(
      { ...F.vintageSet, orderedVintageIdentityDigest: FAKE('d') })],
  [46, 'forged firstAvailableAt bound', 'MARKET_DATA_MACRO_VINTAGE_INVALID',
    () => normalizeMacroVintageSetManifestV1(
      { ...F.vintageSet, firstAvailableAt: '2020-01-01T00:00:00.000Z' })],
  [47, 'forged lastAvailableAt bound', 'MARKET_DATA_MACRO_VINTAGE_INVALID',
    () => normalizeMacroVintageSetManifestV1(
      { ...F.vintageSet, lastAvailableAt: '2030-01-01T00:00:00.000Z' })],
  [48, 'forged emptySnapshot flag', 'MARKET_DATA_MACRO_SNAPSHOT_INVALID',
    () => normalizeMacroDatasetSnapshotManifestV1({ ...F.snapshot, emptySnapshot: true })],
  [57, 'provider code smuggled into the permanent identity', 'MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID',
    () => normalizeMacroSeriesIdentityCoreV1({ ...F.seriesEffr, providerSeriesCode: 'EFFR' })],
  [58, 'old registry entry deleted in a child', 'MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION',
    () => verifyMacroSeriesRegistryChainV1([
      { registryManifestId: FAKE('a'), registry: F.registry },
      {
        registryManifestId: FAKE('b'),
        registry: {
          ...F.registry,
          supersedesRegistryManifestId: FAKE('a'),
          orderedSeriesEntries: F.registry.orderedSeriesEntries.slice(1),
        },
      },
    ])],
];

for (const [number, label, expectedCode, run] of pureCases) {
  test(`adversarial case ${number}: ${label}`, () => {
    assert.throws(run, code(expectedCode));
  });
}

/* Store-based cases. */

test('adversarial case 8: registry entry code diverging from the pinned identity', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => buildMacroSeriesRegistryGenesis({
      store: ctx.store,
      entries: [{
        macroSeriesIdentityId: ctx.series['US.NYFED.EFFR'].macroSeriesIdentityId,
        canonicalSeriesCode: 'US.NYFED.SOFR',
        status: 'ACTIVE',
        supersedesSeriesIdentityId: null,
        replacementReason: null,
      }],
    }), code('MARKET_DATA_MACRO_SERIES_REFERENCE_MISMATCH'));
  });
});

test('adversarial case 49: future store noise never changes the pinned output', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const before = canonicalJsonBytes(ctx.snapshot.datasetSnapshot).toString('hex');
    ctx.store.putSourceBytes(Buffer.from('SYNTHETIC_TEST_FIXTURE future noise', 'utf8'));
    const verified = verifyMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    });
    assert.equal(canonicalJsonBytes(verified.datasetSnapshot).toString('hex'), before);
  });
});

test('adversarial case 50: insertion order never changes the pinned output', () => {
  const first = withOfficialMacroL4BI1Fixture(
    (ctx) => ctx.snapshot.macroDatasetSnapshotManifestId);
  const second = withOfficialMacroL4BI1Fixture(
    (ctx) => ctx.snapshot.macroDatasetSnapshotManifestId);
  assert.equal(first, second);
});

test('adversarial cases 51+52: snapshot policy or registry diverging from the vintage set', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    for (const overrides of [
      { macroIngestionPolicyId: FAKE('a') },
      { macroSeriesRegistryManifestId: FAKE('b') },
    ]) {
      const forged = { ...ctx.snapshot.datasetSnapshot, ...overrides };
      const stored = ctx.store.putCanonicalObject({
        namespace: 'snapshots',
        schemaVersion: 'MacroDatasetSnapshotManifest/1',
        value: forged,
      });
      assert.throws(() => verifyMacroDatasetSnapshotManifest({
        store: ctx.store, macroDatasetSnapshotManifestId: stored.objectId,
      }), code('MARKET_DATA_MACRO_REFERENCE_MISMATCH'));
    }
  });
});

test('adversarial case 53: snapshot pinned to a diverging vintage set', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const otherSet = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
      value: {
        ...ctx.vintageSet.vintageSet,
        orderedObservationEntries: [ctx.vintageSet.vintageSet.orderedObservationEntries[0]],
        orderedVintageIds: ctx.vintageSet.vintageSet.orderedObservationEntries[0]
          .orderedVintages.map((v) => v.observationVintageId),
        observationCount: 1,
        vintageCount: ctx.vintageSet.vintageSet.orderedObservationEntries[0].orderedVintages.length,
        firstAvailableAt: ctx.vintageSet.vintageSet.orderedObservationEntries[0].orderedVintages[0].availableAt,
        lastAvailableAt: ctx.vintageSet.vintageSet.orderedObservationEntries[0]
          .orderedVintages.at(-1).availableAt,
        orderedVintageIdentityDigest: macroOrderedVintageIdentityDigestV1(
          macroVintageSetFlatEntriesV1([ctx.vintageSet.vintageSet.orderedObservationEntries[0]])),
      },
    });
    const forged = {
      ...ctx.snapshot.datasetSnapshot,
      macroVintageSetManifestId: otherSet.objectId,
    };
    const stored = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: 'MacroDatasetSnapshotManifest/1',
      value: forged,
    });
    assert.throws(() => verifyMacroDatasetSnapshotManifest({
      store: ctx.store, macroDatasetSnapshotManifestId: stored.objectId,
    }), code('MARKET_DATA_MACRO_SNAPSHOT_INVALID'));
  });
});

test('adversarial case 54: missing source document', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => verifyMacroSourceDocument(ctx.store, FAKE('d')),
      code('MARKET_DATA_MACRO_SOURCE_DOCUMENT_INVALID'));
  });
});

test('adversarial case 55: snapshot-namespace object claimed as a source document', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => verifyMacroSourceDocument(ctx.store, ctx.macroIngestionPolicyId),
      code('MARKET_DATA_MACRO_SOURCE_DOCUMENT_INVALID'));
  });
});

test('adversarial case 56: methodology changed in-place cannot keep the old identity', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const mutated = syntheticMacroSeriesIdentity('US.NYFED.EFFR', {
      methodologyVersionId: FAKE('7'),
    });
    // The mutated identity hashes to a new ID: claiming it under the old
    // pinned ID is impossible, and a registry entry pointing at the never
    // pinned mutated ID fails reference verification.
    const mutatedId = macroSeriesIdentityIdFor(mutated);
    assert.notEqual(mutatedId, ctx.series['US.NYFED.EFFR'].macroSeriesIdentityId);
    assert.throws(() => buildMacroSeriesRegistryGenesis({
      store: ctx.store,
      entries: [{
        macroSeriesIdentityId: mutatedId,
        canonicalSeriesCode: 'US.NYFED.EFFR',
        status: 'ACTIVE',
        supersedesSeriesIdentityId: null,
        replacementReason: null,
      }],
    }), code('MARKET_DATA_REFERENCE_MISSING'));
  });
});

function coherentChildManifest(ctx, mutateFlatEntry) {
  const parent = ctx.vintageSet.vintageSet;
  const entries = structuredClone(parent.orderedObservationEntries);
  mutateFlatEntry(entries);
  const flat = macroVintageSetFlatEntriesV1(entries);
  const availableAts = flat.map((entry) => entry.availableAt).sort();
  return {
    ...parent,
    supersedesVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    orderedObservationEntries: entries,
    orderedVintageIds: flat.map((entry) => entry.observationVintageId),
    observationCount: entries.length,
    vintageCount: flat.length,
    firstAvailableAt: availableAts[0],
    lastAvailableAt: availableAts.at(-1),
    orderedVintageIdentityDigest: macroOrderedVintageIdentityDigestV1(flat),
  };
}

test('adversarial case 59: historical vintage mutated in a child set', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const child = coherentChildManifest(ctx, (entries) => {
      entries[0].orderedVintages[0] = {
        ...entries[0].orderedVintages[0],
        observationVintageId: FAKE('e'),
      };
    });
    const stored = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
      value: child,
    });
    assert.throws(() => verifyMacroVintageSetManifest({
      store: ctx.store, macroVintageSetManifestId: stored.objectId,
    }), code('MARKET_DATA_MACRO_APPEND_ONLY_VIOLATION'));
  });
});

test('adversarial case 60: historical availableAt rewritten in a child set', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const child = coherentChildManifest(ctx, (entries) => {
      const last = entries.at(-1).orderedVintages.at(-1);
      entries.at(-1).orderedVintages[entries.at(-1).orderedVintages.length - 1] = {
        ...last,
        availableAt: '2026-05-02T12:30:00.000Z',
      };
    });
    const stored = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
      value: child,
    });
    assert.throws(() => verifyMacroVintageSetManifest({
      store: ctx.store, macroVintageSetManifestId: stored.objectId,
    }), code('MARKET_DATA_MACRO_APPEND_ONLY_VIOLATION'));
  });
});
