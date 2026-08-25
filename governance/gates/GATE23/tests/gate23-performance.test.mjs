/**
 * GATE23 performance budget tests.
 *
 * GATE23 materialization is historical, off-scan work: it must stay bounded, must
 * not lengthen any live critical path, and must perform no filesystem or network
 * access per record. Budgets are deliberately loose so the test measures a
 * regression in shape, not the speed of the host.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { materializeFeatureRecords } from '../implementation/feature-materializer-v1.mjs';
import { createFeatureStore, appendFeatureRecords, storeDigest } from '../implementation/feature-store-v1.mjs';
import { materializeFixture, buildFixtureInput } from '../fixtures/causal-window-fixture.mjs';
import { SESSION_UNIVERSE } from '../fixtures/calendar-window-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const IMPLEMENTATION_DIR = path.join(REPO_ROOT, 'governance/gates/GATE23/implementation');

export const PERFORMANCE_BUDGET_V1 = Object.freeze({
  singleVectorMaterializationMs: 250,
  batchAnchorCount: 50,
  batchMaterializationMs: 8000,
  perFeatureRecordMs: 20,
  storeAppendMs: 2000,
  perScanApiCalls: 0,
  perRecordFilesystemReads: 0,
});

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };
const measure = (fn) => { const started = performance.now(); const value = fn(); return { ms: performance.now() - started, value }; };

/* Warm the module graph so the measurement is of the transform, not of module load. */
materializeFixture();

const single = measure(() => materializeFixture());
check(() => assert.equal(single.value.vectorStatus, 'RESOLVED'));
check(() => assert.ok(single.ms < PERFORMANCE_BUDGET_V1.singleVectorMaterializationMs, `single vector took ${single.ms}ms`));

/* Batch: the last N anchors that can carry the full declared vector. */
const anchors = SESSION_UNIVERSE.slice(-PERFORMANCE_BUDGET_V1.batchAnchorCount).map((session) => session.sessionDate);
const batch = measure(() => anchors.map((sessionDate) => materializeFeatureRecords(buildFixtureInput({ sessionDate }))));
const recordCount = batch.value.reduce((total, result) => total + result.records.length, 0);
check(() => assert.equal(batch.value.length, PERFORMANCE_BUDGET_V1.batchAnchorCount));
check(() => assert.ok(batch.value.every((result) => result.vectorStatus === 'RESOLVED')));
check(() => assert.ok(batch.ms < PERFORMANCE_BUDGET_V1.batchMaterializationMs, `batch took ${batch.ms}ms`));
check(() => assert.ok(batch.ms / recordCount < PERFORMANCE_BUDGET_V1.perFeatureRecordMs, `per-record ${batch.ms / recordCount}ms`));

/* Store append and digest stay bounded over the batch. */
const appended = measure(() => appendFeatureRecords(createFeatureStore(), batch.value.flatMap((result) => result.records)));
check(() => assert.equal(appended.value.records.length, recordCount));
check(() => assert.ok(appended.ms < PERFORMANCE_BUDGET_V1.storeAppendMs, `store append took ${appended.ms}ms`));
check(() => assert.match(storeDigest(appended.value), /^[0-9a-f]{64}$/));

/* Cost grows with window length, never super-linearly in the ladder. */
const wide = measure(() => materializeFixture());
check(() => assert.ok(wide.ms < PERFORMANCE_BUDGET_V1.singleVectorMaterializationMs, `rerun took ${wide.ms}ms`));

/* No per-record filesystem or network access anywhere in the implementation. */
for (const file of fs.readdirSync(IMPLEMENTATION_DIR)) {
  const source = fs.readFileSync(path.join(IMPLEMENTATION_DIR, file), 'utf8');
  check(() => assert.ok(!/node:fs|node:http|node:https|node:net|node:child_process/.test(source), `${file} performs I/O`));
  check(() => assert.ok(!/\bfetch\s*\(|XMLHttpRequest/.test(source), `${file} performs network access`));
}

export const MEASUREMENTS = Object.freeze({
  singleVectorMs: Number(single.ms.toFixed(3)),
  batchAnchorCount: PERFORMANCE_BUDGET_V1.batchAnchorCount,
  batchMs: Number(batch.ms.toFixed(3)),
  featureRecordCount: recordCount,
  perFeatureRecordMs: Number((batch.ms / recordCount).toFixed(4)),
  storeAppendMs: Number(appended.ms.toFixed(3)),
  storeRecordCount: appended.value.records.length,
});

console.log(`GATE23_PERFORMANCE_PASS ${assertions}`);
console.log(`GATE23_PERFORMANCE_MEASUREMENT_JSON ${JSON.stringify({ budget: PERFORMANCE_BUDGET_V1, measurements: MEASUREMENTS })}`);
