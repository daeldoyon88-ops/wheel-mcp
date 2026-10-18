/**
 * L4C-I2 replay.
 *
 * Replay is deterministic and never supersedes: identical inputs republish
 * byte-identical canonical objects under the same ids and add no CAS object.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { buildEarningsAsOfMaterializationReport } from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import {
  L4C_I2_FILING_DEFINITIONS,
  bindL4CI2Dataset,
  classifyVisibleRevision,
  materializeL4CI2Dataset,
  pinL4CI2Dataset,
  withEarningsStore,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const storeFileCount = (root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).length;

test('I2-RP01 replaying the pipeline twice in one store yields identical ids', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const first = materializeL4CI2Dataset(ctx.store, ctx);
    const second = materializeL4CI2Dataset(ctx.store, ctx);
    assert.equal(second.binding.earningsDatasetBindingId,
      first.binding.earningsDatasetBindingId);
    assert.equal(second.materialization.earningsAsOfMaterializationReportId,
      first.materialization.earningsAsOfMaterializationReportId);
  });
});

test('I2-RP02 replaying after re-ingesting the same filings yields identical classification ids',
  () => {
    withEarningsStore((store) => {
      const first = pinL4CI2Dataset(store, [L4C_I2_FILING_DEFINITIONS.q1EightK]);
      const firstIds = classifyVisibleRevision(store, first)
        .classified.orderedFiscalPeriodClassificationIds;
      // Ingesting the same filing bytes a second time is a functional no-op.
      const second = pinL4CI2Dataset(store, [L4C_I2_FILING_DEFINITIONS.q1EightK]);
      assert.equal(second.earningsDatasetSnapshotManifestId,
        first.earningsDatasetSnapshotManifestId);
      const secondIds = classifyVisibleRevision(store, second)
        .classified.orderedFiscalPeriodClassificationIds;
      assert.deepEqual(secondIds, firstIds);
      assert.ok(firstIds.length > 0);
    });
  });

test('I2-RP03 replaying with the same cutoff yields the same binding id', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const first = bindL4CI2Dataset(ctx.store, ctx);
    const second = bindL4CI2Dataset(ctx.store, ctx);
    assert.equal(second.earningsDatasetBindingId, first.earningsDatasetBindingId);
    assert.deepEqual(second.earningsDatasetBinding, first.earningsDatasetBinding);
  });
});

test('I2-RP04 replaying yields byte-identical canonical JSON', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const first = materializeL4CI2Dataset(ctx.store, ctx);
    const second = materializeL4CI2Dataset(ctx.store, ctx);
    assert.ok(canonicalJsonBytes(second.materialization.earningsAsOfMaterializationReport)
      .equals(canonicalJsonBytes(first.materialization.earningsAsOfMaterializationReport)));
    assert.ok(canonicalJsonBytes(second.binding.earningsDatasetBinding)
      .equals(canonicalJsonBytes(first.binding.earningsDatasetBinding)));
  });
});

test('I2-RP05 replay writes no additional CAS objects', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const binding = bindL4CI2Dataset(ctx.store, ctx);
    buildEarningsAsOfMaterializationReport({
      store: ctx.store, earningsDatasetBindingId: binding.earningsDatasetBindingId,
    });
    const afterFirst = storeFileCount(ctx.root);
    buildEarningsAsOfMaterializationReport({
      store: ctx.store, earningsDatasetBindingId: binding.earningsDatasetBindingId,
    });
    assert.equal(storeFileCount(ctx.root), afterFirst);
  });
});
