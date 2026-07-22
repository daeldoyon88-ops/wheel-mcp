/**
 * L4B-I1 empty snapshot tests: a configured registry with zero observed
 * vintages is a valid, closed, deterministic state. No date is fabricated.
 * All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { canonicalDigest } from '../src/contracts/marketDataL3CommonV1.mjs';
import { buildMacroSeriesRegistryGenesis } from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import { buildMacroVintageSetManifest } from '../src/macro/macroVintageSetL4BV1.mjs';
import {
  buildMacroDatasetSnapshotManifest,
  verifyMacroDatasetSnapshotManifest,
} from '../src/macro/macroDatasetSnapshotL4BV1.mjs';
import { buildMacroIngestionPolicy } from '../src/macro/macroIngestionPolicyL4BV1.mjs';
import {
  withEmptyMacroL4BI1Fixture,
  withMacroStore,
} from './macroIngestionL4BSyntheticFixture.mjs';

test('a configured registry with zero observations yields a valid empty snapshot', () => {
  withEmptyMacroL4BI1Fixture((ctx) => {
    const snapshot = ctx.snapshot.datasetSnapshot;
    assert.equal(snapshot.emptySnapshot, true);
    assert.equal(snapshot.seriesCount, 1);
    assert.equal(snapshot.observationCount, 0);
    assert.equal(snapshot.vintageCount, 0);
    assert.equal(snapshot.firstAvailableAt, null);
    assert.equal(snapshot.lastAvailableAt, null);
  });
});

test('empty digests are the canonical digest of the empty list, never fabricated', () => {
  withEmptyMacroL4BI1Fixture((ctx) => {
    const snapshot = ctx.snapshot.datasetSnapshot;
    assert.equal(snapshot.orderedObservationIdentityDigest, canonicalDigest([]));
    assert.equal(snapshot.orderedVintageIdentityDigest, canonicalDigest([]));
    assert.notEqual(snapshot.orderedSeriesIdentityDigest, canonicalDigest([]));
  });
});

test('a totally empty registry also yields a valid, distinct empty snapshot', () => {
  withMacroStore((store) => {
    const policy = buildMacroIngestionPolicy({ store });
    const registry = buildMacroSeriesRegistryGenesis({ store, entries: [] });
    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: policy.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: [],
    });
    const snapshot = buildMacroDatasetSnapshotManifest({
      store,
      macroIngestionPolicyId: policy.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    });
    assert.equal(snapshot.datasetSnapshot.seriesCount, 0);
    assert.equal(snapshot.datasetSnapshot.emptySnapshot, true);
    assert.equal(snapshot.datasetSnapshot.orderedSeriesIdentityDigest, canonicalDigest([]));
    verifyMacroDatasetSnapshotManifest({
      store, macroDatasetSnapshotManifestId: snapshot.macroDatasetSnapshotManifestId,
    });
  });
});

test('configured-but-unobserved and totally-empty snapshots have different IDs', () => {
  const configured = withEmptyMacroL4BI1Fixture(
    (ctx) => ctx.snapshot.macroDatasetSnapshotManifestId);
  const bare = withMacroStore((store) => {
    const policy = buildMacroIngestionPolicy({ store });
    const registry = buildMacroSeriesRegistryGenesis({ store, entries: [] });
    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: policy.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: [],
    });
    return buildMacroDatasetSnapshotManifest({
      store,
      macroIngestionPolicyId: policy.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    }).macroDatasetSnapshotManifestId;
  });
  assert.notEqual(configured, bare);
});

test('the empty snapshot replays byte-for-byte in a fresh store', () => {
  const build = () => withEmptyMacroL4BI1Fixture((ctx) => ({
    id: ctx.snapshot.macroDatasetSnapshotManifestId,
    bytes: canonicalJsonBytes(ctx.snapshot.datasetSnapshot).toString('hex'),
  }));
  assert.deepEqual(build(), build());
});
