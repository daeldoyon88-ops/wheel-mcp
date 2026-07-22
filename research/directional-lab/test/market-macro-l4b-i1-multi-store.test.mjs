/**
 * L4B-I1 multi-store tests: three independent temporary stores must produce
 * identical IDs, bytes, digests and counts; a store enriched with future,
 * unpinned objects must change nothing. The golden IDs below were computed
 * from the closed contracts, then confirmed by replay before being pinned.
 * All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  pinSyntheticSourceDocument,
  syntheticMacroSeriesIdentity,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';
import { buildMacroSeriesIdentityCore } from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import { verifyMacroDatasetSnapshotManifest } from '../src/macro/macroDatasetSnapshotL4BV1.mjs';

export const GOLDEN_L4B_I1 = Object.freeze({
  macroIngestionPolicyId:
    'sha256:ff11152134d49f95c1bc8b7a152aea7833d0bb4094103944ee1214f0cc43f1b2',
  macroSeriesRegistryManifestId:
    'sha256:d7a47060b96a49f2971e89d173b7c75d6a5d639f493204d19cd3f6a3583863f6',
  macroVintageSetManifestId:
    'sha256:8d8651c2db49a87e86975b3b9e637121b369ea0ae29100bb250a871ca970fa95',
  macroDatasetSnapshotManifestId:
    'sha256:b74883aba3a7dc7301363227826c46010e7d8953a50dbdba2d8e8503a573cd83',
  seriesCount: 5,
  observationCount: 5,
  vintageCount: 9,
  orderedSeriesIdentityDigest:
    'sha256:a10f2e0b08211e8a8bd60a0e3bfeb9b012dc80f9a0c46724b1ca0669dffda0e9',
  orderedObservationIdentityDigest:
    'sha256:8ab01cd80974eaf68c7bd2d12167001ef8e76333e894df281b7abe90c44a086c',
  orderedVintageIdentityDigest:
    'sha256:d1b172a2b7cba177136297c693f2dc2ca71f20e5877eaad40de2dee6b45bfa00',
  firstAvailableAt: '2026-01-05T21:00:00.000Z',
  lastAvailableAt: '2026-04-02T12:30:00.000Z',
});

function fingerprint(ctx) {
  const snapshot = ctx.snapshot.datasetSnapshot;
  return {
    macroIngestionPolicyId: ctx.macroIngestionPolicyId,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    seriesCount: snapshot.seriesCount,
    observationCount: snapshot.observationCount,
    vintageCount: snapshot.vintageCount,
    orderedSeriesIdentityDigest: snapshot.orderedSeriesIdentityDigest,
    orderedObservationIdentityDigest: snapshot.orderedObservationIdentityDigest,
    orderedVintageIdentityDigest: snapshot.orderedVintageIdentityDigest,
    firstAvailableAt: snapshot.firstAvailableAt,
    lastAvailableAt: snapshot.lastAvailableAt,
  };
}

test('store A and store B produce identical IDs, digests, counts and bytes', () => {
  const storeA = withOfficialMacroL4BI1Fixture((ctx) => ({
    ...fingerprint(ctx),
    snapshotBytes: canonicalJsonBytes(ctx.snapshot.datasetSnapshot).toString('hex'),
    vintageSetBytes: canonicalJsonBytes(ctx.vintageSet.vintageSet).toString('hex'),
    policyBytes: canonicalJsonBytes(ctx.policy).toString('hex'),
    registryBytes: canonicalJsonBytes(ctx.registry.registry).toString('hex'),
  }));
  const storeB = withOfficialMacroL4BI1Fixture((ctx) => ({
    ...fingerprint(ctx),
    snapshotBytes: canonicalJsonBytes(ctx.snapshot.datasetSnapshot).toString('hex'),
    vintageSetBytes: canonicalJsonBytes(ctx.vintageSet.vintageSet).toString('hex'),
    policyBytes: canonicalJsonBytes(ctx.policy).toString('hex'),
    registryBytes: canonicalJsonBytes(ctx.registry.registry).toString('hex'),
  }));
  assert.deepEqual(storeA, storeB);
});

test('the official fixture reproduces the pinned L4B-I1 golden IDs', () => {
  const observed = withOfficialMacroL4BI1Fixture(fingerprint);
  assert.deepEqual(observed, { ...GOLDEN_L4B_I1 });
});

test('store C enriched with future unpinned objects yields the same golden snapshot', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    pinSyntheticSourceDocument(ctx.store, 'store-c-noise-a');
    buildMacroSeriesIdentityCore({
      store: ctx.store,
      identity: syntheticMacroSeriesIdentity('US.TREAS.DGS10', {
        methodologyVersionId: `sha256:${'8'.repeat(64)}`,
      }),
    });
    pinSyntheticSourceDocument(ctx.store, 'store-c-noise-b');
    const verified = verifyMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroDatasetSnapshotManifestId: GOLDEN_L4B_I1.macroDatasetSnapshotManifestId,
    });
    assert.equal(verified.datasetSnapshot.orderedVintageIdentityDigest,
      GOLDEN_L4B_I1.orderedVintageIdentityDigest);
    assert.equal(verified.datasetSnapshot.vintageCount, GOLDEN_L4B_I1.vintageCount);
  });
});

test('no latest scan: verification touches only explicit pinned references', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const reads = [];
    const spyStore = Object.freeze({
      ...ctx.store,
      uriForObject: (input) => {
        reads.push(input.objectId);
        return ctx.store.uriForObject(input);
      },
      readObject: (input) => ctx.store.readObject(input),
      readCanonicalObject: (input) => ctx.store.readCanonicalObject(input),
      putCanonicalObject: (input) => ctx.store.putCanonicalObject(input),
      putSourceBytes: (bytes) => ctx.store.putSourceBytes(bytes),
    });
    verifyMacroDatasetSnapshotManifest({
      store: spyStore,
      macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    });
    assert.equal(reads.length > 0, true);
    for (const objectId of reads) {
      assert.match(objectId, /^sha256:[0-9a-f]{64}$/);
    }
  });
});
