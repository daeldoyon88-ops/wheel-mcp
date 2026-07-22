/**
 * L4B-I1 dataset snapshot tests: full recomputation, byte-for-byte
 * comparison, forged-field rejection and reference pinning.
 * All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import {
  buildMacroDatasetSnapshotManifest,
  verifyMacroDatasetSnapshotManifest,
} from '../src/macro/macroDatasetSnapshotL4BV1.mjs';
import { buildMacroVintageSetManifest } from '../src/macro/macroVintageSetL4BV1.mjs';
import {
  code,
  pinSyntheticSourceDocument,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';

test('the official snapshot verifies against its fully recomputed value', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const verified = verifyMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    });
    assert.deepEqual(verified.datasetSnapshot, ctx.snapshot.datasetSnapshot);
    assert.equal(verified.datasetSnapshot.seriesCount, 5);
    assert.equal(verified.datasetSnapshot.observationCount, 5);
    assert.equal(verified.datasetSnapshot.vintageCount, 9);
    assert.equal(verified.datasetSnapshot.emptySnapshot, false);
    assert.equal(verified.datasetSnapshot.jurisdictionCode, 'UNITED_STATES');
    assert.equal(verified.datasetSnapshot.currencyCode, 'USD');
  });
});

test('the builder derives every counter, bound, flag and digest itself', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const snapshot = ctx.snapshot.datasetSnapshot;
    assert.equal(snapshot.firstAvailableAt, ctx.vintageSet.vintageSet.firstAvailableAt);
    assert.equal(snapshot.lastAvailableAt, ctx.vintageSet.vintageSet.lastAvailableAt);
    assert.equal(snapshot.orderedVintageIdentityDigest,
      ctx.vintageSet.vintageSet.orderedVintageIdentityDigest);
    assert.match(snapshot.orderedSeriesIdentityDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(snapshot.orderedObservationIdentityDigest, /^sha256:[0-9a-f]{64}$/);
  });
});

test('the builder refuses free counters: its input surface has no counter fields', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    assert.throws(() => buildMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
      vintageCount: 999,
    }), code('MARKET_DATA_UNKNOWN_FIELD'));
  });
});

const forgedSnapshotCases = [
  ['forged series count', (s) => ({ ...s, seriesCount: 99 }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged observation count', (s) => ({ ...s, observationCount: 99 }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged vintage count with coherent bounds', (s) => ({ ...s, vintageCount: 99 }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged firstAvailableAt', (s) => ({ ...s, firstAvailableAt: '2020-01-01T00:00:00.000Z' }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged lastAvailableAt', (s) => ({ ...s, lastAvailableAt: '2030-01-01T00:00:00.000Z' }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged empty flag', (s) => ({ ...s, emptySnapshot: true }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged series digest', (s) => ({ ...s, orderedSeriesIdentityDigest: `sha256:${'d'.repeat(64)}` }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged observation digest', (s) => ({ ...s, orderedObservationIdentityDigest: `sha256:${'d'.repeat(64)}` }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['forged vintage digest', (s) => ({ ...s, orderedVintageIdentityDigest: `sha256:${'d'.repeat(64)}` }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['latest policy reference', (s) => ({ ...s, macroIngestionPolicyId: 'latest' }), 'MARKET_DATA_INPUT_INVALID'],
  ['unknown snapshot field', (s) => ({ ...s, createdAt: '2026-01-01T00:00:00.000Z' }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['foreign jurisdiction', (s) => ({ ...s, jurisdictionCode: 'CANADA' }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
  ['foreign currency', (s) => ({ ...s, currencyCode: 'CAD' }), 'MARKET_DATA_MACRO_SNAPSHOT_INVALID'],
];

for (const [label, forge, expectedCode] of forgedSnapshotCases) {
  test(`snapshot rejects: ${label}`, () => {
    withOfficialMacroL4BI1Fixture((ctx) => {
      const forged = forge(ctx.snapshot.datasetSnapshot);
      // Structurally incoherent forgeries die at normalization / CAS write;
      // structurally coherent ones are stored but must be refused by the
      // authoritative verifier's full recomputation.
      assert.throws(() => {
        const stored = ctx.store.putCanonicalObject({
          namespace: 'snapshots',
          schemaVersion: MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
          value: forged,
        });
        verifyMacroDatasetSnapshotManifest({
          store: ctx.store, macroDatasetSnapshotManifestId: stored.objectId,
        });
      }, code(expectedCode));
    });
  });
}

test('a structurally coherent forged snapshot is refused by the authoritative verifier', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    // Coherent forgery: pretend both counts are one higher while keeping the
    // structural invariants intact. Normalization alone cannot see it; the
    // verifier recomputes from the pinned composition and refuses.
    const forged = {
      ...ctx.snapshot.datasetSnapshot,
      observationCount: ctx.snapshot.datasetSnapshot.observationCount + 1,
      vintageCount: ctx.snapshot.datasetSnapshot.vintageCount + 1,
    };
    const stored = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
      value: forged,
    });
    assert.throws(() => verifyMacroDatasetSnapshotManifest({
      store: ctx.store, macroDatasetSnapshotManifestId: stored.objectId,
    }), code('MARKET_DATA_MACRO_SNAPSHOT_INVALID'));
  });
});

test('snapshot references diverging from the vintage set composition are refused', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const otherSet = buildMacroVintageSetManifest({
      store: ctx.store,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: [ctx.vintages.effrInitial.observationVintageId],
    });
    const forged = {
      ...ctx.snapshot.datasetSnapshot,
      macroVintageSetManifestId: otherSet.macroVintageSetManifestId,
    };
    const stored = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
      value: forged,
    });
    assert.throws(() => verifyMacroDatasetSnapshotManifest({
      store: ctx.store, macroDatasetSnapshotManifestId: stored.objectId,
    }), code('MARKET_DATA_MACRO_SNAPSHOT_INVALID'));
  });
});

test('missing or diverging policy, registry and vintage set references are refused', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const cases = [
      // The vintage set exists but pins other IDs: reference mismatch.
      [{ macroIngestionPolicyId: `sha256:${'a'.repeat(64)}` }, 'MARKET_DATA_MACRO_REFERENCE_MISMATCH'],
      [{ macroSeriesRegistryManifestId: `sha256:${'b'.repeat(64)}` }, 'MARKET_DATA_MACRO_REFERENCE_MISMATCH'],
      // The vintage set itself is absent: missing reference.
      [{ macroVintageSetManifestId: `sha256:${'c'.repeat(64)}` }, 'MARKET_DATA_REFERENCE_MISSING'],
    ];
    for (const [overrides, expectedCode] of cases) {
      assert.throws(() => buildMacroDatasetSnapshotManifest({
        store: ctx.store,
        macroIngestionPolicyId: ctx.macroIngestionPolicyId,
        macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
        macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
        ...overrides,
      }), code(expectedCode));
    }
  });
});

test('latest references are refused fail-closed on every snapshot input', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    for (const field of ['macroIngestionPolicyId', 'macroSeriesRegistryManifestId',
      'macroVintageSetManifestId']) {
      assert.throws(() => buildMacroDatasetSnapshotManifest({
        store: ctx.store,
        macroIngestionPolicyId: ctx.macroIngestionPolicyId,
        macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
        macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
        [field]: 'latest',
      }), code('MARKET_DATA_MACRO_LATEST_FORBIDDEN'), field);
    }
    assert.throws(() => verifyMacroDatasetSnapshotManifest({
      store: ctx.store, macroDatasetSnapshotManifestId: 'LATEST',
    }), code('MARKET_DATA_MACRO_LATEST_FORBIDDEN'));
  });
});

test('future documents present in the store but not pinned never change the snapshot', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const before = canonicalJsonBytes(ctx.snapshot.datasetSnapshot).toString('hex');
    const beforeId = ctx.snapshot.macroDatasetSnapshotManifestId;
    // Future noise: new source documents and a bigger vintage set landing in
    // the same store after the snapshot was pinned.
    pinSyntheticSourceDocument(ctx.store, 'future-doc');
    buildMacroVintageSetManifest({
      store: ctx.store,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      supersedesVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
      observationVintageIds: Object.values(ctx.vintages).map((v) => v.observationVintageId),
    });
    const verified = verifyMacroDatasetSnapshotManifest({
      store: ctx.store, macroDatasetSnapshotManifestId: beforeId,
    });
    assert.equal(canonicalJsonBytes(verified.datasetSnapshot).toString('hex'), before);
    const rebuilt = buildMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    });
    assert.equal(rebuilt.macroDatasetSnapshotManifestId, beforeId);
  });
});

test('snapshot bytes are canonical and stable across rebuilds', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const rebuilt = buildMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    });
    assert.equal(rebuilt.macroDatasetSnapshotManifestId,
      ctx.snapshot.macroDatasetSnapshotManifestId);
    assert.deepEqual(canonicalJsonBytes(rebuilt.datasetSnapshot),
      canonicalJsonBytes(ctx.snapshot.datasetSnapshot));
  });
});
