/**
 * L4C-I2 multi-store invariance.
 *
 * Ids, digests and the functional fingerprint are content-addressed, so two
 * stores rooted at different temporary paths agree exactly, and a foreign
 * object added to one store changes nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  materializeL4CI2Dataset,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

/** Materialize the same authority in a fresh store and project one value. */
const inFreshStore = (project) => withL4CI2ThreeFilingFixture((ctx) => {
  const { binding, materialization } = materializeL4CI2Dataset(ctx.store, ctx);
  return project({ ctx, binding, materialization });
});

test('I2-S001 classification ids are identical in two stores at different temporary paths', () => {
  const first = inFreshStore(({ ctx, materialization }) => ({
    root: ctx.root,
    ids: materialization.earningsAsOfMaterializationReport.orderedFiscalClassificationIds,
  }));
  const second = inFreshStore(({ ctx, materialization }) => ({
    root: ctx.root,
    ids: materialization.earningsAsOfMaterializationReport.orderedFiscalClassificationIds,
  }));
  assert.notEqual(second.root, first.root);
  assert.ok(first.ids.length > 0);
  assert.deepEqual(second.ids, first.ids);
});

test('I2-S002 classification report ids are identical in two stores', () => {
  const project = ({ materialization }) =>
    materialization.earningsAsOfMaterializationReport.orderedFiscalClassificationReportIds;
  const first = inFreshStore(project);
  assert.ok(first.length > 0);
  assert.deepEqual(inFreshStore(project), first);
});

test('I2-S003 binding ids are identical in two stores', () => {
  const project = ({ binding }) => binding.earningsDatasetBindingId;
  assert.equal(inFreshStore(project), inFreshStore(project));
});

test('I2-S004 materialization report ids are identical in two stores', () => {
  const project = ({ materialization }) => materialization.earningsAsOfMaterializationReportId;
  assert.equal(inFreshStore(project), inFreshStore(project));
});

test('I2-S005 the functional fingerprint is identical in two stores', () => {
  const project = ({ materialization }) =>
    materialization.earningsAsOfMaterializationReport.materializationFunctionalFingerprint;
  assert.equal(inFreshStore(project), inFreshStore(project));
});

test('I2-S006 foreign objects added to one store do not change any id', () => {
  const baseline = inFreshStore(({ materialization }) =>
    materialization.earningsAsOfMaterializationReportId);
  const polluted = withL4CI2ThreeFilingFixture((ctx) => {
    ctx.store.putSourceBytes(Buffer.from('foreign noise A'));
    ctx.store.putSourceBytes(Buffer.from('foreign noise B'));
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    return materialization.earningsAsOfMaterializationReportId;
  });
  assert.equal(polluted, baseline);
});
