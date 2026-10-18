/** L4C-I2 explicit 68-edge traversal closure: 35 L4C-I1 edges + 33 L4C-I2 edges. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EARNINGS_I2_TRAVERSAL_EDGES_V1,
  EARNINGS_I2_TRAVERSAL_EDGE_COUNT_V1,
  EARNINGS_MATERIALIZATION_TRAVERSAL_EDGES_V1,
  EARNINGS_MATERIALIZATION_TRAVERSAL_EDGE_COUNT_V1,
  verifyEarningsMaterializationTraversalV1,
} from '../src/earnings/earningsMaterializationTraversalL4CIIV1.mjs';
import { EARNINGS_TRAVERSAL_EDGES_V1 } from '../src/earnings/earningsTraversalVerifyL4CIV1.mjs';
import {
  code,
  materializeL4CI2Dataset,
  overlayL4CI2Store,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const traverse = (store, materialization, labRoot) =>
  verifyEarningsMaterializationTraversalV1({
    store,
    earningsAsOfMaterializationReportId: materialization.earningsAsOfMaterializationReportId,
    ...(labRoot === undefined ? {} : { labRoot }),
  });

/** Serve a raw mutated report under its own id. */
const withMutatedReport = (ctx, materialization, patch) => overlayL4CI2Store(ctx.store,
  new Map([[materialization.earningsAsOfMaterializationReportId, {
    ...structuredClone(materialization.earningsAsOfMaterializationReport), ...patch,
  }]]));

test('I2-V001 closes the full 68-edge traversal from the materialization report', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const result = traverse(ctx.store, materialization);
    assert.equal(result.verified, true);
    assert.equal(result.edgeCount, 68);
    assert.ok(result.closureObjectIds.length > 0);
    assert.equal(result.closureObjectIds.includes(
      materialization.earningsAsOfMaterializationReportId), true);
  });
});

test('I2-V002 the declared edge count equals the edge table length', () => {
  assert.equal(EARNINGS_I2_TRAVERSAL_EDGES_V1.length, EARNINGS_I2_TRAVERSAL_EDGE_COUNT_V1);
  assert.equal(EARNINGS_I2_TRAVERSAL_EDGE_COUNT_V1, 33);
  assert.equal(EARNINGS_MATERIALIZATION_TRAVERSAL_EDGES_V1.length,
    EARNINGS_MATERIALIZATION_TRAVERSAL_EDGE_COUNT_V1);
  assert.equal(EARNINGS_MATERIALIZATION_TRAVERSAL_EDGE_COUNT_V1, 68);
  assert.equal(EARNINGS_TRAVERSAL_EDGES_V1.length, 35);
  assert.equal(EARNINGS_TRAVERSAL_EDGES_V1.length + EARNINGS_I2_TRAVERSAL_EDGES_V1.length, 68);
});

test('I2-V003 the edge table contains no duplicate parent/field pair', () => {
  const pairs = EARNINGS_MATERIALIZATION_TRAVERSAL_EDGES_V1
    .map(([parent, field]) => `${parent}|${field}`);
  assert.equal(new Set(pairs).size, pairs.length);
});

test('I2-V004 the combined L4C-I1 + L4C-I2 graph is acyclic', () => {
  // Walk parent -> child schema edges and prove no schema reaches itself.
  const adjacency = new Map();
  for (const [parent, , child] of EARNINGS_MATERIALIZATION_TRAVERSAL_EDGES_V1) {
    const target = child.split('|')[0];
    if (parent === target) continue; // snapshot supersession is a nullable self-link
    if (!adjacency.has(parent)) adjacency.set(parent, new Set());
    adjacency.get(parent).add(target);
  }
  const state = new Map();
  const visit = (node, trail) => {
    if (state.get(node) === 'done') return;
    assert.equal(state.get(node), undefined, `cycle through ${[...trail, node].join(' -> ')}`);
    state.set(node, 'open');
    for (const next of adjacency.get(node) ?? []) visit(next, [...trail, node]);
    state.set(node, 'done');
  };
  for (const node of adjacency.keys()) visit(node, []);
  assert.ok(adjacency.size > 0);
});

test('I2-V005 every classification core reference resolves', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const closure = traverse(ctx.store, materialization).closureObjectIds;
    assert.ok(report.orderedFiscalClassificationIds.length > 0);
    for (const id of report.orderedFiscalClassificationIds) {
      assert.equal(closure.includes(id), true, id);
    }
  });
});

test('I2-V006 every classification report reference resolves', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const closure = traverse(ctx.store, materialization).closureObjectIds;
    assert.ok(report.orderedFiscalClassificationReportIds.length > 0);
    for (const id of report.orderedFiscalClassificationReportIds) {
      assert.equal(closure.includes(id), true, id);
    }
  });
});

test('I2-V007 a dangling classification id fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const dangling = `sha256:${'a'.repeat(64)}`;
    const overlay = withMutatedReport(ctx, materialization, {
      orderedFiscalClassificationIds: [dangling],
    });
    assert.throws(() => traverse(overlay, materialization),
      (error) => ['EARNINGS_FISCAL_CLASSIFICATION_MISSING',
        'EARNINGS_MATERIALIZATION_MISSING'].includes(error.code));
  });
});

test('I2-V008 a dangling visible observation id fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const overlay = withMutatedReport(ctx, materialization, {
      orderedVisibleMetricObservationIds: [`sha256:${'b'.repeat(64)}`],
    });
    assert.throws(() => traverse(overlay, materialization),
      (error) => ['EARNINGS_CLOSURE_REFERENCE_MISSING',
        'EARNINGS_MATERIALIZATION_MISSING'].includes(error.code));
  });
});

test('I2-V009 a classification referencing a non-visible revision fails closed', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    // Keep the classifications but declare a visible-revision set that excludes
    // the revision each classification belongs to.
    const overlay = withMutatedReport(ctx, materialization, {
      orderedVisibleRevisionIdentityIds: [report.orderedFiscalClassificationIds[0]],
    });
    assert.throws(() => traverse(overlay, materialization),
      (error) => ['EARNINGS_FISCAL_CLASSIFICATION_ORPHAN',
        'EARNINGS_MATERIALIZATION_MISSING',
        'EARNINGS_CLOSURE_REFERENCE_MISSING'].includes(error.code));
  });
});

test('I2-V010 no directory listing occurs during traversal', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const scanning = { calls: 0 };
    const guarded = {};
    for (const key of Object.keys(ctx.store)) {
      guarded[key] = typeof ctx.store[key] === 'function'
        ? ctx.store[key].bind(ctx.store) : ctx.store[key];
    }
    for (const forbidden of ['listObjects', 'readdir', 'scan', 'latest', 'listNamespace']) {
      guarded[forbidden] = () => {
        scanning.calls += 1;
        throw new Error(`${forbidden} is forbidden`);
      };
    }
    const result = traverse(Object.freeze(guarded), materialization);
    assert.equal(result.verified, true);
    assert.equal(scanning.calls, 0);
  });
});

test('I2-V011 the transform module source pins are re-verified when labRoot is supplied', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const withRoot = traverse(ctx.store, materialization, ctx.transform.labRoot);
    assert.equal(withRoot.verified, true);
    const withoutRoot = traverse(ctx.store, materialization);
    assert.deepEqual(withRoot.closureObjectIds, withoutRoot.closureObjectIds);
    // A foreign labRoot cannot reproduce the pinned module bytes.
    assert.throws(() => traverse(ctx.store, materialization, ctx.root),
      (error) => typeof error.code === 'string');
  });
});

test('I2-V012 traversal is proportional to the pinned closure and never scans the store', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const instrument = () => {
      const reads = new Set();
      const anonymousReads = { count: 0 };
      const counted = {};
      for (const key of Object.keys(ctx.store)) {
        counted[key] = typeof ctx.store[key] === 'function'
          ? ctx.store[key].bind(ctx.store) : ctx.store[key];
      }
      const record = (input) => {
        if (typeof input.expectedObjectId !== 'string') anonymousReads.count += 1;
        else reads.add(input.expectedObjectId);
      };
      counted.readObject = (input) => { record(input); return ctx.store.readObject(input); };
      counted.readCanonicalObject = (input) => {
        record(input);
        return ctx.store.readCanonicalObject(input);
      };
      return { store: Object.freeze(counted), reads, anonymousReads };
    };

    const before = instrument();
    const result = traverse(before.store, materialization);
    assert.equal(result.verified, true);
    // Every read is addressed by an explicit id: nothing is discovered.
    assert.equal(before.anonymousReads.count, 0);
    assert.ok(before.reads.size >= result.closureObjectIds.length - before.reads.size);

    // Adding a foreign object the closure never names must not change the work.
    ctx.store.putSourceBytes(Buffer.from('foreign object outside the pinned closure'));
    const after = instrument();
    traverse(after.store, materialization);
    assert.deepEqual([...after.reads].sort(), [...before.reads].sort());
  });
});
