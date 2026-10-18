/** L4C-I2 resolveEarningsAsOfV1: the runtime visible closure of a pinned snapshot. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { resolveEarningsAsOfV1 } from '../src/earnings/resolveEarningsAsOfL4CIIV1.mjs';
import { verifyEarningsDatasetSnapshotManifest } from '../src/earnings/earningsDatasetSnapshotL4CIV1.mjs';
import { verifyEarningsRevisionIdentityCore } from '../src/earnings/earningsRevisionL4CIV1.mjs';
import {
  L4C_I2_CUTOFF_AFTER_ALL,
  L4C_I2_CUTOFF_BEFORE_ALL,
  L4C_I2_FILING_DEFINITIONS,
  L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT,
  pinL4CI2Dataset,
  withEarningsStore,
  withL4CI2SingleFilingFixture,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';
import { verifyEarningsMetricObservationCore } from '../src/earnings/earningsMetricObservationL4CIV1.mjs';

const resolveAt = (ctx, knowledgeCutoff) => resolveEarningsAsOfV1({
  store: ctx.store,
  earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
  knowledgeCutoff,
  earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
});

const isSortedUnique = (ids) =>
  ids.every((id, index) => index === 0 || ids[index - 1] < id);

test('I2-R001 resolves the full visible set when the cutoff is after every filing', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.equal(resolution.visibleEventCount, 3);
    assert.equal(resolution.visibleRevisionCount, 3);
    assert.equal(resolution.visibleExtractionReportCount, 3);
    assert.equal(resolution.visibleMetricObservationCount, 6);
    assert.equal(resolution.visibleRawPeriodCount, 2);
    assert.equal(resolution.emptyMaterialization, false);
    assert.equal(resolution.sourceSnapshotEmpty, false);
  });
});

test('I2-R002 returns EMPTY when the cutoff precedes the first publicAvailableAt', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, L4C_I2_CUTOFF_BEFORE_ALL);
    assert.equal(resolution.emptyMaterialization, true);
    assert.equal(resolution.visibleRevisionCount, 0);
    assert.deepEqual(resolution.orderedVisibleEventIdentityIds, []);
    assert.deepEqual(resolution.orderedVisibleRawPeriodIds, []);
    // The snapshot itself is not empty: only the visible set is.
    assert.equal(resolution.sourceSnapshotEmpty, false);
  });
});

test('I2-R003 ignores revisions published after the cutoff without raising', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    // Only the 10-K/A (2026-03-01T17:00:00.000Z) is visible one second later.
    const resolution = resolveAt(ctx, '2026-03-01T17:00:01.000Z');
    assert.equal(resolution.visibleRevisionCount, 1);
    assert.equal(resolution.earliestVisiblePublicAvailableAt,
      L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
    assert.equal(resolution.latestVisiblePublicAvailableAt,
      L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
  });
});

test('I2-R004 never returns an id that is absent from the pinned extraction set', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    const composition = verifyEarningsDatasetSnapshotManifest({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
    }).composition;
    const pinnedReports = new Set(composition.extractionSet.orderedRevisionExtractionEntries
      .map((entry) => entry.earningsMetricExtractionReportId));
    const pinnedObservations = new Set(composition.extractionSet
      .orderedRevisionExtractionEntries.flatMap((entry) => entry.orderedMetricObservationIds));
    for (const id of resolution.orderedVisibleExtractionReportIds) {
      assert.equal(pinnedReports.has(id), true, id);
    }
    for (const id of resolution.orderedVisibleMetricObservationIds) {
      assert.equal(pinnedObservations.has(id), true, id);
    }
  });
});

test('I2-R005 orders visible event ids bytewise ascending and unique', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const ids = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL).orderedVisibleEventIdentityIds;
    assert.equal(ids.length, 3);
    assert.equal(isSortedUnique(ids), true);
  });
});

test('I2-R006 orders visible revision ids bytewise ascending and unique', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const ids = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL).orderedVisibleRevisionIdentityIds;
    assert.equal(ids.length, 3);
    assert.equal(isSortedUnique(ids), true);
  });
});

test('I2-R007 orders visible extraction report ids bytewise ascending and unique', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const ids = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL).orderedVisibleExtractionReportIds;
    assert.equal(ids.length, 3);
    assert.equal(isSortedUnique(ids), true);
  });
});

test('I2-R008 orders visible observation ids bytewise ascending and unique', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const ids = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL).orderedVisibleMetricObservationIds;
    assert.equal(ids.length, 6);
    assert.equal(isSortedUnique(ids), true);
  });
});

test('I2-R009 deduplicates a raw period shared by two visible revisions', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    const perRevision = resolution.orderedVisibleRevisionEntries
      .flatMap((entry) => entry.orderedRawPeriodIds);
    // The 8-K and the 10-Q both attest DocumentPeriodEndDate 2026-03-31 and both
    // report the same duration, so the same raw period id appears twice per
    // revision and exactly once in the deduplicated snapshot-wide list.
    assert.equal(perRevision.length, 3);
    assert.equal(new Set(perRevision).size, 2);
    assert.deepEqual(resolution.orderedVisibleRawPeriodIds, [...new Set(perRevision)].sort());
  });
});

test('I2-R010 counts the shared raw period once in visibleRawPeriodCount', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.equal(resolution.visibleRawPeriodCount, 2);
    assert.equal(resolution.visibleRawPeriodCount, resolution.orderedVisibleRawPeriodIds.length);
    assert.ok(resolution.visibleRawPeriodCount < resolution.visibleMetricObservationCount);
  });
});

test('I2-R011 rejects a revision identity that is not in the pinned revision set', () => {
  withEarningsStore((store) => {
    // Snapshot A is valid. Snapshot B contributes a real foreign revision identity
    // present in the store but absent from A's pinned revision set. A calibrated
    // call-counting store serves the real observation during snapshot verify,
    // then the foreign-linked observation on the resolve reread, forcing the
    // exact EARNINGS_AS_OF_REFERENCE_MISMATCH code (never a missing-snapshot error).
    const datasetA = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.q1EightK,
      L4C_I2_FILING_DEFINITIONS.q1TenQ,
    ]);
    const datasetB = pinL4CI2Dataset(store, [L4C_I2_FILING_DEFINITIONS.fyTenKA]);
    const resolutionA = resolveEarningsAsOfV1({
      store,
      earningsDatasetSnapshotManifestId: datasetA.earningsDatasetSnapshotManifestId,
      knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
      earningsAsOfResolutionPolicyId: datasetA.earningsAsOfResolutionPolicyId,
    });
    const foreignRevisionId = resolveEarningsAsOfV1({
      store,
      earningsDatasetSnapshotManifestId: datasetB.earningsDatasetSnapshotManifestId,
      knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
      earningsAsOfResolutionPolicyId: datasetB.earningsAsOfResolutionPolicyId,
    }).orderedVisibleRevisionIdentityIds[0];
    assert.equal(
      resolutionA.orderedVisibleRevisionIdentityIds.includes(foreignRevisionId), false);
    const observationId = resolutionA.orderedVisibleMetricObservationIds[0];
    const observation = verifyEarningsMetricObservationCore({
      store, earningsMetricObservationId: observationId,
    }).earningsMetricObservationCore;

    const wrapCounting = (onRead) => {
      const wrapped = {};
      for (const key of Object.keys(store)) {
        wrapped[key] = typeof store[key] === 'function' ? store[key].bind(store) : store[key];
      }
      wrapped.readCanonicalObject = (input) => {
        onRead(input.expectedObjectId);
        return store.readCanonicalObject(input);
      };
      return Object.freeze(wrapped);
    };

    const calibrate = new Map();
    verifyEarningsDatasetSnapshotManifest({
      store: wrapCounting((id) => {
        calibrate.set(id, (calibrate.get(id) ?? 0) + 1);
      }),
      earningsDatasetSnapshotManifestId: datasetA.earningsDatasetSnapshotManifestId,
    });
    const verifyReadCount = calibrate.get(observationId) ?? 0;
    assert.ok(verifyReadCount >= 1);

    const readCounts = new Map();
    const wrapped = {};
    for (const key of Object.keys(store)) {
      wrapped[key] = typeof store[key] === 'function' ? store[key].bind(store) : store[key];
    }
    wrapped.readCanonicalObject = (input) => {
      const id = input.expectedObjectId;
      const count = (readCounts.get(id) ?? 0) + 1;
      readCounts.set(id, count);
      if (id === observationId && count > verifyReadCount) {
        return {
          objectId: id,
          uri: input.uri,
          sizeBytes: 1,
          bytes: Buffer.from('{}'),
          value: { ...structuredClone(observation), earningsRevisionIdentityId: foreignRevisionId },
        };
      }
      return store.readCanonicalObject(input);
    };
    assert.throws(() => resolveEarningsAsOfV1({
      store: Object.freeze(wrapped),
      earningsDatasetSnapshotManifestId: datasetA.earningsDatasetSnapshotManifestId,
      knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
      earningsAsOfResolutionPolicyId: datasetA.earningsAsOfResolutionPolicyId,
    }), (error) => error.code === 'EARNINGS_AS_OF_REFERENCE_MISMATCH');
  });
});

test('I2-R012 treats an /A filing as a separate event with its own visibility', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const afterAmendmentOnly = resolveAt(ctx, '2026-04-01T00:00:00.000Z');
    assert.equal(afterAmendmentOnly.visibleRevisionCount, 1);
    const identity = verifyEarningsRevisionIdentityCore({
      store: ctx.store,
      earningsRevisionIdentityId: afterAmendmentOnly.orderedVisibleRevisionIdentityIds[0],
    }).earningsRevisionIdentityCore;
    assert.equal(identity.publicAvailableAt, L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
    // The amendment carries its own event identity, distinct from the other two.
    const all = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.equal(all.orderedVisibleEventIdentityIds.length, 3);
    assert.equal(all.orderedVisibleEventIdentityIds
      .includes(afterAmendmentOnly.orderedVisibleEventIdentityIds[0]), true);
  });
});

test('I2-R013 reports earliest and latest visible publicAvailableAt from visible revisions only',
  () => {
    withL4CI2ThreeFilingFixture((ctx) => {
      const all = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
      assert.equal(all.earliestVisiblePublicAvailableAt,
        L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
      assert.equal(all.latestVisiblePublicAvailableAt,
        L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1TenQ);
      const twoVisible = resolveAt(ctx, L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1EightK);
      assert.equal(twoVisible.visibleRevisionCount, 2);
      assert.equal(twoVisible.latestVisiblePublicAvailableAt,
        L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1EightK);
    });
  });

test('I2-R014 returns null temporal bounds when the visible set is empty', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, L4C_I2_CUTOFF_BEFORE_ALL);
    assert.equal(resolution.earliestVisiblePublicAvailableAt, null);
    assert.equal(resolution.latestVisiblePublicAvailableAt, null);
  });
});

test('I2-R015 writes nothing to the store (runtime-only result)', () => {
  withL4CI2SingleFilingFixture(L4C_I2_FILING_DEFINITIONS.q1EightK, (ctx) => {
    const listing = () => readdirSync(ctx.root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`)
      .sort();
    const before = listing();
    resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    resolveAt(ctx, L4C_I2_CUTOFF_BEFORE_ALL);
    assert.deepEqual(listing(), before);
  });
});

test('I2-R016 is a pure function of (snapshot, cutoff, policy) across repeated calls', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const first = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    const second = resolveAt(ctx, L4C_I2_CUTOFF_AFTER_ALL);
    assert.deepEqual(second, first);
    const other = resolveAt(ctx, L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
    assert.notDeepEqual(other.orderedVisibleRevisionIdentityIds,
      first.orderedVisibleRevisionIdentityIds);
  });
});
