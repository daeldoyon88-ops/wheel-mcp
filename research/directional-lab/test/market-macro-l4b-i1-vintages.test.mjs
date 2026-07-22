/**
 * L4B-I1 vintage tests: release time resolution modes, revision kinds, the
 * parent graph, identity/content coherence and the split between temporal
 * identity and content. All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
  macroVintageIdentityIdFor,
  normalizeMacroObservationVintageCoreV1,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import { buildMacroSeriesIdentityCore } from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import {
  buildMacroObservationIdentityCore,
  buildMacroObservationVintageCore,
  buildMacroVintageIdentityCore,
  verifyMacroObservationVintageCore,
  verifyMacroSourceDocument,
  verifyMacroVintageIdentityCore,
} from '../src/macro/macroObservationVintageL4BV1.mjs';
import {
  verifyMacroObservationVintageGraphV1,
} from '../src/macro/macroVintageSetL4BV1.mjs';
import { buildMacroIngestionPolicy } from '../src/macro/macroIngestionPolicyL4BV1.mjs';
import {
  code,
  pinSyntheticSourceDocument,
  syntheticMacroSeriesIdentity,
  withMacroStore,
} from './macroIngestionL4BSyntheticFixture.mjs';

/** Shared harness: one store, the pinned policy, one EFFR daily observation. */
function withVintageHarness(fn) {
  return withMacroStore((store) => {
    const policy = buildMacroIngestionPolicy({ store }).macroIngestionPolicy;
    const series = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const observation = buildMacroObservationIdentityCore({
      store,
      identity: {
        schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
        macroSeriesIdentityId: series.macroSeriesIdentityId,
        observationPeriodStart: '2026-01-05',
        observationPeriodEnd: '2026-01-05',
        referencePeriod: '2026-01-05',
        unit: 'PERCENT',
        seasonalAdjustment: 'NOT_APPLICABLE',
      },
    });
    const document = pinSyntheticSourceDocument(store, 'effr-vintage-doc');
    const vintage = (overrides = {}) => buildMacroObservationVintageCore({
      store,
      policy,
      series: series.macroSeriesIdentity,
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-06T14:00:00.000Z',
      releaseCivilDate: null,
      vintageSequence: 0,
      value: { atoms: '433', scale: 2 },
      revisionKind: 'INITIAL',
      parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: document,
      ...overrides,
    });
    return fn({ store, policy, series, observation, document, vintage });
  });
}

test('OFFICIAL_TIMESTAMP pins availableAt to the official release timestamp', () => {
  withVintageHarness(({ store, vintage }) => {
    const built = vintage();
    assert.equal(built.observationVintage.availableAt, '2026-01-06T14:00:00.000Z');
    const verified = verifyMacroObservationVintageCore({
      store, observationVintageId: built.observationVintageId,
    });
    assert.deepEqual(verified.observationVintage, built.observationVintage);
  });
});

test('SERIES_AUTHORITY_POLICY derives availableAt from the pinned NY Fed rule (09:00 ET)', () => {
  withVintageHarness(({ vintage }) => {
    const built = vintage({
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
      releaseTimestamp: null,
      releaseCivilDate: '2026-01-06',
    });
    // 09:00 America/New_York on 2026-01-06 (EST) is 14:00 UTC.
    assert.equal(built.observationVintage.availableAt, '2026-01-06T14:00:00.000Z');
    assert.equal(built.observationVintage.releaseTimestamp, null);
  });
});

test('SERIES_AUTHORITY_POLICY under EDT derives a different UTC hour', () => {
  withVintageHarness(({ vintage }) => {
    const built = vintage({
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
      releaseTimestamp: null,
      releaseCivilDate: '2026-07-06',
    });
    assert.equal(built.observationVintage.availableAt, '2026-07-06T13:00:00.000Z');
  });
});

test('UNKNOWN_REJECTED can never produce a computable vintage', () => {
  withVintageHarness(({ vintage }) => {
    assert.throws(() => vintage({
      releaseTimeResolutionMode: 'UNKNOWN_REJECTED',
      releaseTimestamp: null,
    }), code('MARKET_DATA_MACRO_RELEASE_TIMESTAMP_UNKNOWN'));
  });
});

test('OFFICIAL_TIMESTAMP without an official timestamp is refused', () => {
  withVintageHarness(({ vintage }) => {
    assert.throws(() => vintage({ releaseTimestamp: null }),
      code('MARKET_DATA_INPUT_INVALID'));
  });
});

test('SERIES_AUTHORITY_POLICY without a pinned rule for the series is refused', () => {
  withMacroStore((store) => {
    const policy = buildMacroIngestionPolicy({ store }).macroIngestionPolicy;
    const series = buildMacroSeriesIdentityCore({
      store,
      identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR', {
        sourceAuthority: 'TEST_FIXTURE', releaseAuthority: 'TEST_FIXTURE',
      }),
    });
    const observation = buildMacroObservationIdentityCore({
      store,
      identity: {
        schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
        macroSeriesIdentityId: series.macroSeriesIdentityId,
        observationPeriodStart: '2026-01-05',
        observationPeriodEnd: '2026-01-05',
        referencePeriod: '2026-01-05',
        unit: 'PERCENT',
        seasonalAdjustment: 'NOT_APPLICABLE',
      },
    });
    assert.throws(() => buildMacroObservationVintageCore({
      store,
      policy,
      series: series.macroSeriesIdentity,
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
      releaseTimestamp: null,
      releaseCivilDate: '2026-01-06',
      vintageSequence: 0,
      value: { atoms: '433', scale: 2 },
      revisionKind: 'INITIAL',
      parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: pinSyntheticSourceDocument(store, 'no-rule-doc'),
    }), code('MARKET_DATA_MACRO_RELEASE_TIMESTAMP_UNKNOWN'));
  });
});

test('caller series forged against another observation is refused', () => {
  withVintageHarness(({ store, policy, observation, document }) => {
    const foreign = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.TREAS.DGS10'),
    });
    assert.throws(() => buildMacroObservationVintageCore({
      store,
      policy,
      series: foreign.macroSeriesIdentity,
      observationIdentityId: observation.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
      releaseTimestamp: null,
      releaseCivilDate: '2026-01-06',
      vintageSequence: 0,
      value: { atoms: '433', scale: 2 },
      revisionKind: 'INITIAL',
      parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: document,
    }), code('MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH'));
  });
});

test('vintage identity build/verify round-trips and matches the derived ID', () => {
  withVintageHarness(({ store, observation, document }) => {
    const identity = {
      schemaVersion: 'MacroVintageIdentityCore/1',
      observationIdentityId: observation.observationIdentityId,
      availableAt: '2026-01-06T14:00:00.000Z',
      vintageSequence: 0,
      sourceDocumentId: document,
    };
    const built = buildMacroVintageIdentityCore({ store, identity });
    assert.equal(built.macroVintageIdentityId, macroVintageIdentityIdFor(identity));
    const verified = verifyMacroVintageIdentityCore({
      store, macroVintageIdentityId: built.macroVintageIdentityId,
    });
    assert.deepEqual(verified.macroVintageIdentity, built.macroVintageIdentity);
  });
});

test('the vintage identity is derived from the four pinned components, never the value', () => {
  withVintageHarness(({ vintage }) => {
    const left = vintage({ value: { atoms: '433', scale: 2 } });
    const right = vintage({ value: { atoms: '450', scale: 2 } });
    assert.equal(left.macroVintageIdentityId, right.macroVintageIdentityId);
    assert.notEqual(left.observationVintageId, right.observationVintageId);
  });
});

test('two contents under one temporal identity are a conflict in the graph', () => {
  withVintageHarness(({ vintage, observation }) => {
    const left = vintage({ value: { atoms: '433', scale: 2 } });
    const right = vintage({ value: { atoms: '450', scale: 2 } });
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId,
      [left.observationVintage, right.observationVintage],
    ), code('MARKET_DATA_MACRO_VINTAGE_CONFLICT'));
  });
});

test('INITIAL -> REVISION -> CORRECTION chain is accepted with correct ordering', () => {
  withVintageHarness(({ store, vintage, observation }) => {
    const initial = vintage();
    const revision = vintage({
      releaseTimestamp: '2026-02-06T14:00:00.000Z',
      vintageSequence: 1,
      value: { atoms: '435', scale: 2 },
      revisionKind: 'REVISION',
      parentVintageId: initial.macroVintageIdentityId,
      sourceDocumentId: pinSyntheticSourceDocument(store, 'revision-doc'),
    });
    const correction = vintage({
      releaseTimestamp: '2026-02-06T18:00:00.000Z',
      vintageSequence: 2,
      value: { atoms: '434', scale: 2 },
      revisionKind: 'CORRECTION',
      parentVintageId: revision.macroVintageIdentityId,
      sourceDocumentId: pinSyntheticSourceDocument(store, 'correction-doc'),
    });
    verifyMacroObservationVintageGraphV1(observation.observationIdentityId,
      [initial.observationVintage, revision.observationVintage, correction.observationVintage]);
    assert.equal(correction.observationVintage.availableAt >= revision.observationVintage.availableAt, true);
  });
});

test('BENCHMARK_REVISION requires a parent and a strictly greater sequence', () => {
  withVintageHarness(({ store, vintage }) => {
    const initial = vintage();
    const benchmark = vintage({
      releaseTimestamp: '2026-04-02T12:30:00.000Z',
      vintageSequence: 1,
      value: { atoms: '432', scale: 2 },
      revisionKind: 'BENCHMARK_REVISION',
      parentVintageId: initial.macroVintageIdentityId,
      sourceDocumentId: pinSyntheticSourceDocument(store, 'benchmark-doc'),
    });
    assert.equal(benchmark.observationVintage.revisionKind, 'BENCHMARK_REVISION');
    assert.throws(() => vintage({
      revisionKind: 'BENCHMARK_REVISION',
      parentVintageId: null,
      vintageSequence: 1,
    }), code('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH'));
  });
});

test('WITHDRAWAL pins the closed null value and keeps history intact', () => {
  withVintageHarness(({ store, vintage, observation }) => {
    const initial = vintage();
    const withdrawal = vintage({
      releaseTimestamp: '2026-03-06T14:00:00.000Z',
      vintageSequence: 1,
      value: null,
      revisionKind: 'WITHDRAWAL',
      parentVintageId: initial.macroVintageIdentityId,
      sourceDocumentId: pinSyntheticSourceDocument(store, 'withdrawal-doc'),
    });
    assert.equal(withdrawal.observationVintage.value, null);
    verifyMacroObservationVintageGraphV1(observation.observationIdentityId,
      [initial.observationVintage, withdrawal.observationVintage]);
    assert.throws(() => vintage({
      releaseTimestamp: '2026-03-06T14:00:00.000Z',
      vintageSequence: 2,
      value: { atoms: '1', scale: 0 },
      revisionKind: 'WITHDRAWAL',
      parentVintageId: initial.macroVintageIdentityId,
    }), code('MARKET_DATA_MACRO_VINTAGE_INVALID'));
  });
});

test('INITIAL with a parent, non-zero sequence or second INITIAL is refused', () => {
  withVintageHarness(({ vintage, observation }) => {
    const initial = vintage();
    assert.throws(() => vintage({ parentVintageId: initial.macroVintageIdentityId }),
      code('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH'));
    assert.throws(() => vintage({ vintageSequence: 1 }),
      code('MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID'));
    const secondInitial = vintage({
      releaseTimestamp: '2026-01-07T14:00:00.000Z',
    });
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId,
      [initial.observationVintage, secondInitial.observationVintage],
    ), code('MARKET_DATA_MACRO_VINTAGE_CONFLICT'));
  });
});

test('non-initial vintages require a parent and a positive sequence', () => {
  withVintageHarness(({ vintage }) => {
    assert.throws(() => vintage({ revisionKind: 'REVISION', vintageSequence: 1 }),
      code('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH'));
    assert.throws(() => vintage({
      revisionKind: 'REVISION',
      parentVintageId: `sha256:${'d'.repeat(64)}`,
      vintageSequence: 0,
    }), code('MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID'));
  });
});

test('parent graph refuses missing parent, non-increasing sequence and earlier availableAt', () => {
  withVintageHarness(({ store, vintage, observation }) => {
    const initial = vintage();
    const orphan = vintage({
      releaseTimestamp: '2026-02-06T14:00:00.000Z',
      vintageSequence: 1,
      revisionKind: 'REVISION',
      parentVintageId: `sha256:${'d'.repeat(64)}`,
      sourceDocumentId: pinSyntheticSourceDocument(store, 'orphan-doc'),
    });
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId,
      [initial.observationVintage, orphan.observationVintage],
    ), code('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH'));

    const decreasing = {
      ...initial.observationVintage,
      vintageSequence: 1,
    };
    const child = {
      ...orphan.observationVintage,
      parentVintageId: initial.macroVintageIdentityId,
      vintageSequence: 1,
    };
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId, [decreasing, child],
    ), code('MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID'));

    const earlier = {
      ...orphan.observationVintage,
      parentVintageId: initial.macroVintageIdentityId,
      availableAt: '2026-01-01T14:00:00.000Z',
    };
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId, [initial.observationVintage, earlier],
    ), code('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID'));
  });
});

test('parent graph refuses two branches from the same parent', () => {
  withVintageHarness(({ store, vintage, observation }) => {
    const initial = vintage();
    const branchA = vintage({
      releaseTimestamp: '2026-02-06T14:00:00.000Z',
      vintageSequence: 1,
      revisionKind: 'REVISION',
      parentVintageId: initial.macroVintageIdentityId,
      sourceDocumentId: pinSyntheticSourceDocument(store, 'branch-a-doc'),
    });
    const branchB = vintage({
      releaseTimestamp: '2026-02-07T14:00:00.000Z',
      vintageSequence: 2,
      revisionKind: 'REVISION',
      parentVintageId: initial.macroVintageIdentityId,
      sourceDocumentId: pinSyntheticSourceDocument(store, 'branch-b-doc'),
    });
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId,
      [initial.observationVintage, branchA.observationVintage, branchB.observationVintage],
    ), code('MARKET_DATA_MACRO_VINTAGE_CONFLICT'));
  });
});

test('self-parent, 2-cycles and 3-cycles are refused deterministically', () => {
  withVintageHarness(({ vintage, observation, document }) => {
    const initial = vintage();
    const selfId = macroVintageIdentityIdFor({
      observationIdentityId: observation.observationIdentityId,
      availableAt: '2026-02-06T14:00:00.000Z',
      vintageSequence: 1,
      sourceDocumentId: document,
    });
    assert.throws(() => normalizeMacroObservationVintageCoreV1({
      schemaVersion: MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
      macroVintageIdentityId: selfId,
      observationIdentityId: observation.observationIdentityId,
      releaseTimestamp: '2026-02-06T14:00:00.000Z',
      availableAt: '2026-02-06T14:00:00.000Z',
      vintageSequence: 1,
      value: { atoms: '435', scale: 2 },
      revisionKind: 'REVISION',
      parentVintageId: selfId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      sourceDocumentId: document,
    }), code('MARKET_DATA_MACRO_VINTAGE_CYCLE'));

    // Parent-graph cycles are classified as CYCLE before sequence monotonicity.
    const stub = (sequence, parentSequence) => ({
      macroVintageIdentityId: `sha256:${String(sequence).repeat(64).slice(0, 64)}`,
      observationIdentityId: observation.observationIdentityId,
      availableAt: '2026-02-06T14:00:00.000Z',
      vintageSequence: sequence,
      revisionKind: sequence === 0 ? 'INITIAL' : 'REVISION',
      parentVintageId: parentSequence === null
        ? null : `sha256:${String(parentSequence).repeat(64).slice(0, 64)}`,
    });
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId,
      [stub(0, null), stub(1, 2), stub(2, 1)],
    ), code('MARKET_DATA_MACRO_VINTAGE_CYCLE'));
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      observation.observationIdentityId,
      [stub(0, null), stub(1, 3), stub(2, 1), stub(3, 2)],
    ), code('MARKET_DATA_MACRO_VINTAGE_CYCLE'));
    void initial;
  });
});

test('a vintage grouped under another observation is refused', () => {
  withVintageHarness(({ vintage }) => {
    const built = vintage();
    assert.throws(() => verifyMacroObservationVintageGraphV1(
      `sha256:${'9'.repeat(64)}`, [built.observationVintage],
    ), code('MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH'));
  });
});

test('identity/content mismatches are refused at normalization', () => {
  withVintageHarness(({ vintage, observation, document }) => {
    const built = vintage();
    const withForged = (overrides) => ({
      ...built.observationVintage,
      ...overrides,
    });
    // Forged availableAt, sequence or source document no longer hash to the
    // pinned macroVintageIdentityId.
    assert.throws(() => normalizeMacroObservationVintageCoreV1(withForged({
      releaseTimestamp: '2026-01-06T15:00:00.000Z',
      availableAt: '2026-01-06T15:00:00.000Z',
    })), code('MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID'));
    assert.throws(() => normalizeMacroObservationVintageCoreV1(withForged({
      vintageSequence: 4,
      revisionKind: 'REVISION',
      parentVintageId: `sha256:${'d'.repeat(64)}`,
    })), code('MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID'));
    assert.throws(() => normalizeMacroObservationVintageCoreV1(withForged({
      sourceDocumentId: `sha256:${'d'.repeat(64)}`,
    })), code('MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID'));
    void observation;
    void document;
  });
});

test('availableAt earlier than the official release timestamp is refused', () => {
  withVintageHarness(({ observation, document }) => {
    const identityId = macroVintageIdentityIdFor({
      observationIdentityId: observation.observationIdentityId,
      availableAt: '2026-01-06T13:00:00.000Z',
      vintageSequence: 0,
      sourceDocumentId: document,
    });
    assert.throws(() => normalizeMacroObservationVintageCoreV1({
      schemaVersion: MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
      macroVintageIdentityId: identityId,
      observationIdentityId: observation.observationIdentityId,
      releaseTimestamp: '2026-01-06T14:00:00.000Z',
      availableAt: '2026-01-06T13:00:00.000Z',
      vintageSequence: 0,
      value: { atoms: '433', scale: 2 },
      revisionKind: 'INITIAL',
      parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
      sourceDocumentId: document,
    }), code('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID'));
  });
});

test('non-UTC, offset or non-canonical timestamps are refused everywhere', () => {
  withVintageHarness(({ vintage }) => {
    const cases = [
      ['2026-01-06T09:00:00.000-05:00', 'MARKET_DATA_INPUT_INVALID'],
      ['2026-01-06 14:00:00', 'MARKET_DATA_INPUT_INVALID'],
      // A second wire encoding of the same instant would mint a second
      // vintage identity: the canonical millisecond form is pinned.
      ['2026-01-06T14:00:00Z', 'MARKET_DATA_MACRO_AVAILABLE_AT_INVALID'],
    ];
    for (const [timestamp, expectedCode] of cases) {
      assert.throws(() => vintage({ releaseTimestamp: timestamp }),
        code(expectedCode), timestamp);
    }
  });
});

test('the source document is loaded and hash-verified, never trusted', () => {
  withVintageHarness(({ store, vintage, document }) => {
    verifyMacroSourceDocument(store, document);
    assert.throws(() => verifyMacroSourceDocument(store, `sha256:${'d'.repeat(64)}`),
      code('MARKET_DATA_MACRO_SOURCE_DOCUMENT_INVALID'));
    assert.throws(() => verifyMacroSourceDocument(store, 'latest'),
      code('MARKET_DATA_MACRO_LATEST_FORBIDDEN'));
    assert.throws(() => vintage({ sourceDocumentId: `sha256:${'d'.repeat(64)}` }),
      code('MARKET_DATA_MACRO_SOURCE_DOCUMENT_INVALID'));
  });
});

test('a snapshot-namespace object cannot masquerade as a source document', () => {
  withVintageHarness(({ store, series }) => {
    assert.throws(() => verifyMacroSourceDocument(store, series.macroSeriesIdentityId),
      code('MARKET_DATA_MACRO_SOURCE_DOCUMENT_INVALID'));
  });
});

test('vintage replay: identical inputs reproduce identical content IDs across stores', () => {
  const build = () => withVintageHarness(({ vintage }) => {
    const built = vintage();
    return {
      contentId: built.observationVintageId,
      identityId: built.macroVintageIdentityId,
    };
  });
  assert.deepEqual(build(), build());
});
