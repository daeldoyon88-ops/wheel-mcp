/**
 * L4B-I1 vintage set tests: canonical ordering, recomputed counters and
 * digests, conflicts, duplicates, append-only supersession and reference
 * pinning. All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
  macroVintageSetFlatEntriesV1,
  normalizeMacroVintageSetManifestV1,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import {
  buildMacroVintageSetManifest,
  verifyMacroVintageSetManifest,
} from '../src/macro/macroVintageSetL4BV1.mjs';
import {
  buildMacroObservationVintageCore,
} from '../src/macro/macroObservationVintageL4BV1.mjs';
import {
  code,
  pinSyntheticSourceDocument,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';

function buildSet(ctx, observationVintageIds, overrides = {}) {
  return buildMacroVintageSetManifest({
    store: ctx.store,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: ctx.macroIngestionPolicyId,
    supersedesVintageSetManifestId: null,
    observationVintageIds,
    ...overrides,
  });
}

test('empty vintage set pins zero counts, null bounds and the empty digest', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const empty = buildSet(ctx, []);
    assert.equal(empty.vintageSet.observationCount, 0);
    assert.equal(empty.vintageSet.vintageCount, 0);
    assert.equal(empty.vintageSet.firstAvailableAt, null);
    assert.equal(empty.vintageSet.lastAvailableAt, null);
    verifyMacroVintageSetManifest({
      store: ctx.store, macroVintageSetManifestId: empty.macroVintageSetManifestId,
    });
  });
});

test('a single-observation set derives exact counters and bounds', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const single = buildSet(ctx, [ctx.vintages.effrInitial.observationVintageId]);
    assert.equal(single.vintageSet.observationCount, 1);
    assert.equal(single.vintageSet.vintageCount, 1);
    assert.equal(single.vintageSet.firstAvailableAt, '2026-01-06T14:00:00.000Z');
    assert.equal(single.vintageSet.lastAvailableAt, '2026-01-06T14:00:00.000Z');
  });
});

test('the full multi-series set derives exact counters, bounds and flat order', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const manifest = ctx.vintageSet.vintageSet;
    assert.equal(manifest.observationCount, 5);
    assert.equal(manifest.vintageCount, 9);
    assert.equal(manifest.firstAvailableAt, '2026-01-05T21:00:00.000Z');
    assert.equal(manifest.lastAvailableAt, '2026-04-02T12:30:00.000Z');
    const flat = macroVintageSetFlatEntriesV1(manifest.orderedObservationEntries);
    assert.equal(flat.length, 9);
    assert.deepEqual(manifest.orderedVintageIds, flat.map((e) => e.observationVintageId));
  });
});

test('insertion order never changes the pinned manifest (reversed and shuffled)', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const ids = Object.values(ctx.vintages).map((v) => v.observationVintageId);
    const reference = buildSet(ctx, ids);
    const reversed = buildSet(ctx, [...ids].reverse());
    const shuffled = buildSet(ctx, [ids[4], ids[0], ids[7], ids[2], ids[8], ids[1], ids[5], ids[3], ids[6]]);
    assert.equal(reversed.macroVintageSetManifestId, reference.macroVintageSetManifestId);
    assert.equal(shuffled.macroVintageSetManifestId, reference.macroVintageSetManifestId);
    assert.deepEqual(canonicalJsonBytes(reversed.vintageSet), canonicalJsonBytes(reference.vintageSet));
  });
});

test('a duplicate vintage reference is refused as a duplicate sequence', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => buildSet(ctx, [
      ctx.vintages.effrInitial.observationVintageId,
      ctx.vintages.effrInitial.observationVintageId,
    ]), code('MARKET_DATA_MACRO_VINTAGE_CONFLICT'));
  });
});

test('two contents under one temporal identity are refused in the set', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const conflicting = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: 'MacroObservationVintageCore/1',
      value: {
        ...ctx.vintages.effrInitial.observationVintage,
        value: { atoms: '499', scale: 2 },
      },
    });
    assert.throws(() => buildSet(ctx, [
      ctx.vintages.effrInitial.observationVintageId,
      conflicting.objectId,
    ]), code('MARKET_DATA_MACRO_VINTAGE_CONFLICT'));
  });
});

test('a branch conflict inside one observation is refused in the set', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    // A second child of the CPI INITIAL vintage: cpiRevision already branches
    // from it, so the pair forms two concurrent branches.
    const branch = buildMacroObservationVintageCore({
      store: ctx.store,
      policy: ctx.policy,
      series: ctx.series['US.BLS.CPIAUCSL'].macroSeriesIdentity,
      observationIdentityId: ctx.observations.cpi.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-02-12T13:30:00.000Z',
      releaseCivilDate: null,
      vintageSequence: 3,
      value: { atoms: '317200', scale: 3 },
      revisionKind: 'REVISION',
      parentVintageId: ctx.vintages.cpiInitial.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: pinSyntheticSourceDocument(ctx.store, 'cpi-branch-doc'),
    });
    assert.throws(() => buildSet(ctx, [
      ctx.vintages.cpiInitial.observationVintageId,
      ctx.vintages.cpiRevision.observationVintageId,
      branch.observationVintageId,
    ]), code('MARKET_DATA_MACRO_VINTAGE_CONFLICT'));
  });
});

test('append-only supersession preserves history and allows growth', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const base = buildSet(ctx, [ctx.vintages.effrInitial.observationVintageId]);
    const grown = buildSet(ctx, [
      ctx.vintages.effrInitial.observationVintageId,
      ctx.vintages.dgs10Initial.observationVintageId,
    ], { supersedesVintageSetManifestId: base.macroVintageSetManifestId });
    const verified = verifyMacroVintageSetManifest({
      store: ctx.store, macroVintageSetManifestId: grown.macroVintageSetManifestId,
    });
    assert.equal(verified.vintageSetChain.length, 2);
    assert.equal(verified.vintageSet.vintageCount, 2);
  });
});

test('a child set removing a historical vintage is refused', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const base = buildSet(ctx, [
      ctx.vintages.effrInitial.observationVintageId,
      ctx.vintages.dgs10Initial.observationVintageId,
    ]);
    assert.throws(() => buildSet(ctx, [ctx.vintages.effrInitial.observationVintageId],
      { supersedesVintageSetManifestId: base.macroVintageSetManifestId }),
    code('MARKET_DATA_MACRO_APPEND_ONLY_VIOLATION'));
  });
});

test('a self-superseding vintage set is refused as a cycle', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => verifyMacroVintageSetManifest({
      store: ctx.store,
      macroVintageSetManifestId: `sha256:${'a'.repeat(64)}`,
    }), code('MARKET_DATA_REFERENCE_MISSING'));
  });
});

test('a vintage set pinned to an unrelated registry or policy is refused', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => buildSet(ctx, [ctx.vintages.effrInitial.observationVintageId], {
      macroSeriesRegistryManifestId: `sha256:${'b'.repeat(64)}`,
    }), code('MARKET_DATA_REFERENCE_MISSING'));
    assert.throws(() => buildSet(ctx, [ctx.vintages.effrInitial.observationVintageId], {
      macroIngestionPolicyId: `sha256:${'c'.repeat(64)}`,
    }), code('MARKET_DATA_REFERENCE_MISSING'));
  });
});

test('an observation whose series is absent from the registry is refused', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const bareRegistry = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: 'MacroSeriesRegistryManifest/1',
      value: {
        schemaVersion: 'MacroSeriesRegistryManifest/1',
        registryPolicyVersion: 'MACRO_SERIES_REGISTRY_L4B_I1_V1',
        supersedesRegistryManifestId: null,
        orderedSeriesEntries: [],
      },
    });
    assert.throws(() => buildSet(ctx, [ctx.vintages.effrInitial.observationVintageId], {
      macroSeriesRegistryManifestId: bareRegistry.objectId,
    }), code('MARKET_DATA_MACRO_SERIES_NOT_IN_SCOPE'));
  });
});

const forgedManifestCases = [
  ['forged observation count', (manifest) => ({ ...manifest, observationCount: 99 })],
  ['forged vintage count', (manifest) => ({ ...manifest, vintageCount: 99 })],
  ['forged firstAvailableAt', (manifest) => ({
    ...manifest, firstAvailableAt: '2020-01-01T00:00:00.000Z',
  })],
  ['forged lastAvailableAt', (manifest) => ({
    ...manifest, lastAvailableAt: '2030-01-01T00:00:00.000Z',
  })],
  ['forged ordered digest', (manifest) => ({
    ...manifest, orderedVintageIdentityDigest: `sha256:${'d'.repeat(64)}`,
  })],
  ['forged flat vintage ids', (manifest) => ({
    ...manifest, orderedVintageIds: [...manifest.orderedVintageIds].reverse(),
  })],
  ['reordered observation entries', (manifest) => ({
    ...manifest, orderedObservationEntries: [...manifest.orderedObservationEntries].reverse(),
  })],
];

for (const [label, forge] of forgedManifestCases) {
  test(`vintage set normalization refuses: ${label}`, () => {
    withOfficialMacroL4BI1Fixture((ctx) => {
      const manifest = ctx.vintageSet.vintageSet;
      assert.throws(() => normalizeMacroVintageSetManifestV1(forge(manifest)),
        code('MARKET_DATA_MACRO_VINTAGE_INVALID'));
    });
  });
}

test('the CAS itself refuses storing a forged vintage set manifest', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
      value: { ...ctx.vintageSet.vintageSet, vintageCount: 42 },
    }));
  });
});

test('vintage set verification ignores unrelated CAS noise', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    pinSyntheticSourceDocument(ctx.store, 'set-noise');
    const verified = verifyMacroVintageSetManifest({
      store: ctx.store,
      macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    });
    assert.deepEqual(verified.vintageSet, ctx.vintageSet.vintageSet);
  });
});
