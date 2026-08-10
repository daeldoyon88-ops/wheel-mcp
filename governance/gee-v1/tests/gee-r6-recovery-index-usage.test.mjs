/**
 * GEE V1 R6: recovery, repository index and usage ledger.
 *
 * R6-I* repository index, R6-R* recovery, R6-U* usage, R6-X* integration with
 * the real R2/R3/R4/R5 layers, and R6-DEMO the mandatory real interruption and
 * cross-process resume. Every case is deterministic, local and offline.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { createContentAddressedStore } from '../cas/content-addressed-store.mjs';
import { compileContext } from '../context/compile-context.mjs';
import { compareSnapshots, createSnapshot } from '../delta/delta-engine.mjs';
import { bindFreshValidations, createEvidenceGraph, evaluateEvidenceGraph } from '../evidence/evidence-graph.mjs';
import { createGeeR2SyntheticAdapter } from '../fixtures/gee-r2-synthetic-adapter.mjs';
import { routeWorkUnit } from '../router/router-engine.mjs';
import { DEFAULT_ROUTER_POLICY } from '../router/router-policy.mjs';
import { appendRepairRecord, createRepairLedger, SURVIVED } from '../repair/repair-containment.mjs';
import { isPathAuthorized } from '../core/work-unit-core.mjs';

import {
  buildRepoIndex, canonicalRepoPath, changedPathsFromR3Delta, DEFAULT_REPO_INDEX_POLICY,
  repoIndexSha256, updateRepoIndex, validateRepoIndex, validateRepoIndexPolicy,
  verifyRepoIndexAgainstDisk, trackedPathsSha256
} from '../index/repo-index.mjs';
import {
  aggregateUsage, appendUsageRecord, createUsageLedger, nextAttemptOrdinal, parseUsageLedger,
  serializeUsageLedger, usageRecordIdFor, validateUsageRecord, verifyUsageLedger
} from '../usage/usage-ledger.mjs';
import {
  assertCheckpoint, checkpointTasksFromRecovery, checkpointTasksFromRoutePlan, createCheckpoint,
  planRecovery, recoveryStateFor, taskSemanticSha256, validateCheckpoint
} from '../recovery/recovery-engine.mjs';
import { createCheckpointStore, reconcileCheckpointWithUsage, workUnitDirectoryName } from '../recovery/checkpoint-store.mjs';
import {
  buildWheelCheckpoint, createWheelRecoverySession, recordWheelTaskExecution,
  resumeWheelWorkUnit, wheelAuthorityIdentity, wheelRecoveryDelta
} from '../adapters/wheel/recovery-wheel-adapter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const R6_MISSION = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R6';
const CANONICAL_HEAD = 'f1d1422597e3b7d18476df2be4b73ddff6f4edb8';
const PASS = Object.freeze({ validator: 'TEST_PRODUCING_VALIDATOR', result: 'PASS' });
const AUTHORITY = wheelAuthorityIdentity(REPO_ROOT, R6_MISSION);

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(REPO_ROOT, relativePath)).href;
}

/* ===========================================================================
 * Repository index harness
 * ======================================================================== */

const INDEX_POLICY = Object.freeze({
  policyVersion: 'GEE_R6_TEST_INDEX_POLICY',
  roots: ['src/'],
  excludedDirectorySegments: ['node_modules'],
  excludedPathPrefixes: ['src/generated/'],
  subsystemRules: [{ prefix: 'src/', subsystem: 'SRC' }, { prefix: 'src/nested/', subsystem: 'NESTED' }],
  layerRules: [{ prefix: 'src/nested/', layer: 'L2' }],
  governancePrefixes: ['src/canonical.json'],
  geeRelevantPrefixes: ['src/'],
  trackedStatusSource: 'UNAVAILABLE',
  trackedPathsSha256: null
});

/**
 * A tree whose canonical order differs from its locale-collated order:
 * 'src/B.mjs' precedes 'src/a.json' by UTF-16 code unit and follows it under
 * an English collation, so any accidental localeCompare shows up immediately.
 */
function indexRoot(prefix = 'gee-r6-index-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'B.mjs'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'src', 'canonical.json'), '{"canonical":true}');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'c.md'), '# c\n');
  fs.writeFileSync(path.join(root, 'src', 'generated', 'skip.json'), '{"generated":true}');
  fs.writeFileSync(path.join(root, 'src', 'node_modules', 'junk.js'), 'module.exports = 1;\n');
  return root;
}

function indexOf(root) { return buildRepoIndex({ repoRoot: root, policy: INDEX_POLICY }); }
function pathsOf(index) { return index.entries.map((entry) => entry.path); }
function entryOf(index, repoPath) { return index.entries.find((entry) => entry.path === repoPath); }

/* ===========================================================================
 * Synthetic R2/R3/R4/R5 harness (the same shape R5's own suite uses)
 * ======================================================================== */

const SYNTHETIC_WORK_UNIT = 'SYNTH_01';
const SOURCE_PATHS = ['fixtures/canonical.json', 'src/a.json', 'src/b.json'];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":1}');
  fs.writeFileSync(path.join(root, 'fixtures', 'canonical.json'), '{"canonical":true}');
  return root;
}

function casFor(root) { return createContentAddressedStore(path.join(root, 'cas')); }
function contextFor(root) {
  return compileContext({ repoRoot: root, adapter: createGeeR2SyntheticAdapter(), workUnitId: SYNTHETIC_WORK_UNIT, sourceHead: 'SYNTHETIC_HEAD' }).json;
}
function snapshotOf(root) {
  return createSnapshot({ repoRoot: root, sources: SOURCE_PATHS.filter((entry) => fs.existsSync(path.join(root, ...entry.split('/')))).map((entry) => ({ path: entry })) });
}
function deltaOf(root, mutate = null) {
  const previousSnapshot = snapshotOf(root);
  if (mutate) mutate();
  return { previousSnapshot, currentSnapshot: snapshotOf(root) };
}
function rawNodes() {
  return [
    { evidenceId: 'e:a', content: { value: 'a' }, evidenceType: 'FACT', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: 'e:b', content: { value: 'b' }, evidenceType: 'FACT', provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/b.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: 'e:c', content: { value: 'c' }, evidenceType: 'FACT', provenance: { sourcePath: 'fixtures/canonical.json', authorityClass: 'CANONICAL' }, dependencies: ['source:fixtures/canonical.json'], authorityStatus: 'GROUNDED' }
  ];
}
function baselineGraph(root, cas) {
  const unchanged = deltaOf(root);
  const bound = bindFreshValidations({
    cas,
    nodes: rawNodes(),
    r3Delta: unchanged,
    validationResults: Object.fromEntries(rawNodes().map((node) => [node.evidenceId, PASS]))
  });
  return createEvidenceGraph({ cas, nodes: bound });
}
function verifyTask(taskId, sourcePath, evidenceId, extra = {}) {
  return { taskId, intent: 'DETERMINISTIC', sources: [sourcePath], produces: [evidenceId], requiredEvidenceIds: [evidenceId], mandatory: true, ...extra };
}
function defaultTasks() {
  return [
    verifyTask('t:a', 'src/a.json', 'e:a'),
    verifyTask('t:b', 'src/b.json', 'e:b'),
    verifyTask('t:c', 'fixtures/canonical.json', 'e:c')
  ];
}

/**
 * One synthetic work unit carried all the way through R2, R3, R4, R5 and the
 * R6 index, so every identity a checkpoint binds is a real upstream digest.
 */
function scenario({ mutate = null, tasks = defaultTasks(), repairLedger, policy } = {}) {
  const root = tempRoot();
  const cas = casFor(root);
  const graph = baselineGraph(root, cas);
  const delta = deltaOf(root, mutate ? () => mutate(root) : null);
  const plan = routeWorkUnit({
    workUnitId: SYNTHETIC_WORK_UNIT,
    tasks,
    r2Context: contextFor(root),
    r3Delta: delta,
    r4Evidence: { graph },
    cas,
    repairLedger,
    policy
  });
  const evaluated = evaluateEvidenceGraph({ graph, r3Delta: delta, cas });
  const comparison = compareSnapshots({ previous: delta.previousSnapshot, current: delta.currentSnapshot });
  const index = buildRepoIndex({ repoRoot: root, policy: { ...INDEX_POLICY, governancePrefixes: [], subsystemRules: [{ prefix: 'src/', subsystem: 'SRC' }], layerRules: [], excludedPathPrefixes: [] } });
  return {
    root,
    cas,
    plan,
    delta,
    evidenceStates: evaluated.graph.nodes,
    r3Delta: { deltas: comparison.deltas, metrics: comparison.metrics },
    index,
    inputs: {
      r2ContextSha256: plan.provenance.r2ContextSha256,
      r3DeltaSha256: plan.provenance.r3DeltaSha256,
      r4GraphSha256: plan.provenance.r4GraphSha256,
      routeSha256: plan.routeSha256,
      repoIndexSha256: index.indexSha256
    }
  };
}

function evidenceOf(evidenceStates, evidenceId) {
  return evidenceStates.find((node) => node.evidenceId === evidenceId);
}

function usageFor(state, taskId, { attempt = 1, outcome = 'COMPLETED', tokens = null } = {}) {
  const task = state.plan.tasks.find((entry) => entry.taskId === taskId);
  return {
    workUnitId: SYNTHETIC_WORK_UNIT,
    taskId,
    attempt,
    capability: task.capability,
    outcome,
    routeSha256: state.plan.routeSha256,
    bytes: { sourceProcessedBytes: task.reprocessBytes, sourceAvoidedBytes: task.avoidedBytes },
    tokens
  };
}

/** Records a completed execution and returns the ledger plus the checkpoint task. */
function execute(state, ledger, taskId) {
  const appended = appendUsageRecord(ledger, usageFor(state, taskId));
  const base = checkpointTasksFromRoutePlan(state.plan).find((task) => task.taskId === taskId);
  return {
    ledger: appended.ledger,
    usageRecordId: appended.usageRecordId,
    task: {
      ...base,
      state: 'COMPLETE',
      evidence: [...new Set([...base.produces, ...base.requiredEvidenceIds])]
        .map((evidenceId) => ({ evidenceId, reuseIdentity: evidenceOf(state.evidenceStates, evidenceId).reuseIdentity })),
      usageRecordIds: [appended.usageRecordId]
    }
  };
}

function checkpointFor(state, completedTaskIds, ledger, { previousCheckpoint = null, interrupted = true } = {}) {
  let currentLedger = ledger;
  const byId = new Map(checkpointTasksFromRoutePlan(state.plan).map((task) => [task.taskId, task]));
  for (const taskId of completedTaskIds) {
    const done = execute(state, currentLedger, taskId);
    currentLedger = done.ledger;
    byId.set(taskId, done.task);
  }
  const tasks = [...byId.values()];
  return {
    ledger: currentLedger,
    checkpoint: createCheckpoint({
      workUnitId: SYNTHETIC_WORK_UNIT,
      authority: AUTHORITY,
      baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
      inputs: state.inputs,
      tasks,
      recoveryState: recoveryStateFor(tasks, { interrupted }),
      previousCheckpoint
    })
  };
}

function resignCheckpoint(checkpoint, changes) {
  const body = { ...checkpoint, ...changes };
  return { ...body, checkpointSha256: sha256Canonical({ ...body, checkpointSha256: undefined }) };
}

function checkpointWithAlternateUsage(state, usageChanges) {
  const initial = checkpointFor(state, ['t:a'], createUsageLedger());
  const appended = appendUsageRecord(initial.ledger, {
    ...usageFor(state, 't:a'),
    attempt: 2,
    ...usageChanges
  });
  return {
    checkpoint: resignCheckpoint(initial.checkpoint, {
      tasks: initial.checkpoint.tasks.map((task) => task.taskId === 't:a'
        ? { ...task, usageRecordIds: [appended.usageRecordId] }
        : task)
    }),
    ledger: appended.ledger
  };
}

function checkpointChain(state) {
  const first = checkpointFor(state, [], createUsageLedger(), { interrupted: true }).checkpoint;
  const second = checkpointFor(state, [], createUsageLedger(), { previousCheckpoint: first, interrupted: true }).checkpoint;
  const third = checkpointFor(state, [], createUsageLedger(), { previousCheckpoint: second, interrupted: true }).checkpoint;
  return { first, second, third };
}

function recover(state, checkpoint, ledger, extra = {}) {
  return planRecovery({
    workUnitId: SYNTHETIC_WORK_UNIT,
    checkpoint,
    routePlan: state.plan,
    evidenceStates: state.evidenceStates,
    r3Delta: state.r3Delta,
    usageLedger: ledger,
    repoIndex: state.index,
    authority: AUTHORITY,
    ...extra
  });
}

function taskIn(recovery, taskId) { return recovery.tasks.find((task) => task.taskId === taskId); }

/* ===========================================================================
 * R6-I — repository index
 * ======================================================================== */

test('R6-I01 the same repository state always produces the same index digest', () => {
  const root = indexRoot();
  const first = indexOf(root);
  const second = indexOf(root);
  assert.equal(second.indexSha256, first.indexSha256);
  assert.deepEqual(pathsOf(second), pathsOf(first));
  assert.equal(validateRepoIndex(first).valid, true);
  assert.equal(first.entries.length, 4);
});

test('R6-I02 a JSON round-trip preserves the index and its digest', () => {
  const index = indexOf(indexRoot());
  const revived = JSON.parse(JSON.stringify(index));
  assert.equal(revived.indexSha256, index.indexSha256);
  assert.equal(repoIndexSha256(revived), index.indexSha256);
  assert.equal(validateRepoIndex(revived).valid, true);
  assert.deepEqual(revived.entries, index.entries);
});

test('R6-I03 a separate process reproduces the identical index digest', () => {
  const root = indexRoot();
  const index = indexOf(root);
  const runner = path.join(root, 'index-runner.mjs');
  fs.writeFileSync(runner, `
const m = await import(${JSON.stringify(moduleUrl('governance/gee-v1/index/repo-index.mjs'))});
const index = m.buildRepoIndex({ repoRoot: ${JSON.stringify(root)}, policy: ${JSON.stringify(INDEX_POLICY)} });
process.stdout.write(JSON.stringify({ indexSha256: index.indexSha256, paths: index.entries.map((entry) => entry.path), valid: m.validateRepoIndex(index).valid }));
`);
  const observed = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }));
  assert.equal(observed.indexSha256, index.indexSha256);
  assert.deepEqual(observed.paths, pathsOf(index));
  assert.equal(observed.valid, true);
});

test('R6-I04 a different locale leaves the index and its ordering untouched', () => {
  const root = indexRoot();
  const index = indexOf(root);
  // Canonical order is by UTF-16 code unit, so the uppercase name sorts FIRST.
  // An English collation would place 'src/a.json' before 'src/B.mjs'.
  assert.deepEqual(pathsOf(index), ['src/B.mjs', 'src/a.json', 'src/canonical.json', 'src/nested/c.md']);
  assert.notDeepEqual(pathsOf(index), [...pathsOf(index)].sort((a, b) => a.localeCompare(b, 'en')));

  const runner = path.join(root, 'locale-runner.mjs');
  fs.writeFileSync(runner, `
const m = await import(${JSON.stringify(moduleUrl('governance/gee-v1/index/repo-index.mjs'))});
const index = m.buildRepoIndex({ repoRoot: ${JSON.stringify(root)}, policy: ${JSON.stringify(INDEX_POLICY)} });
process.stdout.write(JSON.stringify({ indexSha256: index.indexSha256, paths: index.entries.map((entry) => entry.path) }));
`);
  for (const locale of ['tr-TR', 'de-DE']) {
    const observed = JSON.parse(execFileSync(process.execPath, [runner], {
      encoding: 'utf8',
      env: { ...process.env, LANG: `${locale}.UTF-8`, LC_ALL: `${locale}.UTF-8`, TZ: 'Asia/Tokyo' }
    }));
    assert.equal(observed.indexSha256, index.indexSha256, locale);
    assert.deepEqual(observed.paths, pathsOf(index), locale);
  }
});

test('R6-I05 one changed file moves exactly one entry identity and re-hashes only it', () => {
  const root = indexRoot();
  const before = indexOf(root);
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}');
  const { index, update } = updateRepoIndex({ repoRoot: root, previousIndex: before, policy: INDEX_POLICY, changedPaths: ['src/a.json'], changedPathsExhaustive: true });

  assert.notEqual(index.indexSha256, before.indexSha256);
  assert.deepEqual(update.changedPaths, ['src/a.json']);
  assert.deepEqual(update.addedPaths, []);
  assert.deepEqual(update.removedPaths, []);
  assert.equal(update.rehashedEntryCount, 1);
  assert.equal(update.reusedEntryCount, 3);
  for (const untouched of ['src/B.mjs', 'src/canonical.json', 'src/nested/c.md']) {
    assert.deepEqual(entryOf(index, untouched), entryOf(before, untouched), untouched);
  }
  assert.notEqual(entryOf(index, 'src/a.json').sha256, entryOf(before, 'src/a.json').sha256);
  // The incremental result is byte-identical to a full rebuild.
  assert.equal(index.indexSha256, indexOf(root).indexSha256);
});

test('R6-I06 an added file becomes a deterministic new entry', () => {
  const root = indexRoot();
  const before = indexOf(root);
  fs.writeFileSync(path.join(root, 'src', 'd.json'), '{"d":1}');
  const { index, update } = updateRepoIndex({ repoRoot: root, previousIndex: before, policy: INDEX_POLICY, changedPaths: ['src/d.json'], changedPathsExhaustive: true });
  assert.deepEqual(update.addedPaths, ['src/d.json']);
  assert.equal(update.reusedEntryCount, 4);
  assert.equal(update.rehashedEntryCount, 1);
  assert.equal(entryOf(index, 'src/d.json').kind, 'JSON');
  assert.equal(entryOf(index, 'src/d.json').subsystem, 'SRC');
  assert.equal(index.indexSha256, indexOf(root).indexSha256);
});

test('R6-I07 a removed file is deterministically dropped', () => {
  const root = indexRoot();
  const before = indexOf(root);
  fs.rmSync(path.join(root, 'src', 'nested', 'c.md'));
  const { index, update } = updateRepoIndex({ repoRoot: root, previousIndex: before, policy: INDEX_POLICY, changedPaths: ['src/nested/c.md'], changedPathsExhaustive: true });
  assert.deepEqual(update.removedPaths, ['src/nested/c.md']);
  assert.equal(entryOf(index, 'src/nested/c.md'), undefined);
  assert.equal(index.entries.length, 3);
  assert.equal(update.reusedEntryCount, 3);
  assert.equal(update.rehashedEntryCount, 0);
  assert.equal(index.indexSha256, indexOf(root).indexSha256);
});

test('R6-I08 a malformed prior index is rejected rather than repaired', () => {
  const root = indexRoot();
  const before = indexOf(root);
  for (const broken of [
    { ...before, indexSha256: '0'.repeat(64) },
    { ...before, engine: 'SOMETHING_ELSE' },
    { ...before, entries: before.entries.map((entry) => ({ ...entry, sha256: 'not-a-digest' })) },
    { ...before, policy: { ...before.policy, roots: [] } },
    null
  ]) {
    assert.throws(() => updateRepoIndex({ repoRoot: root, previousIndex: broken, policy: INDEX_POLICY, changedPaths: [] }), /INVALID_PREVIOUS|TYPE_MISMATCH|INVALID_REPO_INDEX/);
  }
});

test('R6-I09 two entries sharing one canonical path are rejected', () => {
  const index = indexOf(indexRoot());
  const duplicated = { ...index, entries: [index.entries[0], ...index.entries] };
  const withDigest = { ...duplicated, indexSha256: repoIndexSha256(duplicated) };
  const result = validateRepoIndex(withDigest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.reason === 'DUPLICATE_REPO_INDEX_PATH'));
});

test('R6-I10 a non-canonical persisted path identity is rejected, never normalized', () => {
  const index = indexOf(indexRoot());
  const decomposed = 'src/café.json';
  assert.notEqual(decomposed, decomposed.normalize('NFC'));

  for (const [badPath, reason] of [
    [decomposed, 'NON_CANONICAL_REPO_INDEX_PATH'],
    ['src\\a.json', 'NON_CANONICAL_REPO_INDEX_PATH'],
    ['/etc/passwd', 'INVALID_REPO_INDEX_PATH'],
    ['src/../escape.json', 'INVALID_REPO_INDEX_PATH']
  ]) {
    const mutated = { ...index, entries: [{ ...index.entries[0], path: badPath }, ...index.entries.slice(1)] };
    const result = validateRepoIndex({ ...mutated, indexSha256: repoIndexSha256(mutated) });
    assert.equal(result.valid, false, badPath);
    assert.ok(result.errors.some((error) => error.reason === reason), `${badPath} -> ${JSON.stringify(result.errors)}`);
  }
  // A canonical path is accepted, so the rejection is about identity and not
  // about the check refusing everything.
  assert.equal(canonicalRepoPath('src\\a.json'), 'src/a.json');
});

test('R6-I11 an excluded path never enters the canonical index', () => {
  const root = indexRoot();
  const index = indexOf(root);
  assert.equal(pathsOf(index).some((entry) => entry.includes('node_modules')), false);
  assert.equal(pathsOf(index).some((entry) => entry.startsWith('src/generated/')), false);

  // And a materialized index that smuggles one back in is rejected.
  const smuggled = { ...index, entries: [...index.entries, { path: 'src/generated/skip.json', kind: 'JSON', subsystem: 'SRC', layer: null, governanceArtifact: false, geeRelevant: true, tracked: 'UNKNOWN', bytes: 1, sha256: 'a'.repeat(64) }] };
  const result = validateRepoIndex({ ...smuggled, indexSha256: repoIndexSha256(smuggled) });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.reason === 'EXCLUDED_PATH_IN_REPO_INDEX'));
});

test('R6-I12 the same repository-relative bytes under a different absolute root are one index', () => {
  const first = indexRoot('gee-r6-index-A-');
  const second = indexRoot('gee-r6-index-B-');
  assert.notEqual(first, second);
  const indexA = indexOf(first);
  const indexB = indexOf(second);
  assert.equal(indexB.indexSha256, indexA.indexSha256);
  assert.deepEqual(indexB.entries, indexA.entries);
  // No absolute path leaks into the document at all.
  assert.equal(JSON.stringify(indexA).includes(first.split(path.sep).join('/')), false);
});

test('R6-I13 an index update with no change proof re-hashes rather than trusting stale digests', () => {
  const root = indexRoot();
  const before = indexOf(root);
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":99}');
  const { index, update } = updateRepoIndex({ repoRoot: root, previousIndex: before, policy: INDEX_POLICY });
  assert.equal(update.changeProofSupplied, false);
  assert.equal(update.reusedEntryCount, 0);
  assert.equal(index.metrics.UPDATE_MODE, 'FULL_REHASH_NO_CHANGE_PROOF');
  assert.deepEqual(update.changedPaths, ['src/a.json']);
  assert.equal(index.indexSha256, indexOf(root).indexSha256);
});

test('R6-A1-01 an empty changed-path list does not prove a same-size file unchanged', () => {
  const root = indexRoot('gee-r6-a1-01-');
  const before = indexOf(root);
  const prior = entryOf(before, 'src/a.json');
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"z":1}');
  const { index, update } = updateRepoIndex({ repoRoot: root, previousIndex: before, policy: INDEX_POLICY, changedPaths: [] });
  assert.notEqual(entryOf(index, 'src/a.json').sha256, prior.sha256);
  assert.equal(update.rehashedEntryCount, before.entries.length);
  assert.equal(update.reusedEntryCount, 0);
});

test('R6-A1-02 an explicit R3 UNCHANGED path permits reuse', () => {
  const root = indexRoot('gee-r6-a1-02-');
  const before = indexOf(root);
  const unchanged = { deltas: [{ path: 'src/a.json', kind: 'UNCHANGED' }] };
  const { update } = updateRepoIndex({ repoRoot: root, previousIndex: before, policy: INDEX_POLICY, r3Delta: unchanged });
  assert.equal(update.reusedEntryCount, 1);
  assert.equal(update.rehashedEntryCount, before.entries.length - 1);
});

test('R6-A1-03 a path absent from a partial R3 delta is rehashed', () => {
  const root = indexRoot('gee-r6-a1-03-');
  const before = indexOf(root);
  const prior = entryOf(before, 'src/B.mjs');
  fs.writeFileSync(path.join(root, 'src', 'B.mjs'), 'export const b = 2;\n');
  const { index } = updateRepoIndex({
    repoRoot: root, previousIndex: before, policy: INDEX_POLICY,
    r3Delta: { deltas: [{ path: 'src/a.json', kind: 'UNCHANGED' }] }
  });
  assert.notEqual(entryOf(index, 'src/B.mjs').sha256, prior.sha256);
});

test('R6-A1-04 an R3 CHANGED path is rehashed', () => {
  const root = indexRoot('gee-r6-a1-04-');
  const before = indexOf(root);
  const prior = entryOf(before, 'src/a.json');
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"z":1}');
  const { index, update } = updateRepoIndex({
    repoRoot: root, previousIndex: before, policy: INDEX_POLICY,
    r3Delta: { deltas: [{ path: 'src/a.json', kind: 'CHANGED' }] }
  });
  assert.notEqual(entryOf(index, 'src/a.json').sha256, prior.sha256);
  assert.equal(update.rehashedEntryCount, before.entries.length);
});

test('R6-A1-05 an incremental rebuild with complete unchanged proof equals a full rebuild', () => {
  const root = indexRoot('gee-r6-a1-05-');
  const before = indexOf(root);
  const r3Delta = { deltas: before.entries.map((entry) => ({ path: entry.path, kind: 'UNCHANGED' })) };
  const incremental = updateRepoIndex({ repoRoot: root, previousIndex: before, policy: INDEX_POLICY, r3Delta }).index;
  const full = indexOf(root);
  assert.equal(incremental.indexSha256, full.indexSha256);
  assert.equal(incremental.metrics.REHASHED_ENTRY_COUNT, 0);
});

test('R6-A1-06 genuine unchanged proof preserves incremental efficiency', () => {
  const root = indexRoot('gee-r6-a1-06-');
  const before = indexOf(root);
  const { update } = updateRepoIndex({
    repoRoot: root, previousIndex: before, policy: INDEX_POLICY,
    r3Delta: { deltas: [{ path: 'src/a.json', kind: 'UNCHANGED' }] }
  });
  assert.equal(update.reusedEntryCount, 1);
  assert.equal(update.rehashedEntryCount, before.entries.length - 1);
});

test('R6-I14 an R3 delta drives the incremental change set, and disk verification is exact', () => {
  const state = scenario({ mutate: (root) => fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":2}') });
  assert.deepEqual(changedPathsFromR3Delta(state.r3Delta), ['src/b.json']);
  const verified = verifyRepoIndexAgainstDisk({ repoRoot: state.root, index: state.index });
  assert.equal(verified.verified, true);
  assert.equal(verified.verifiedCount, state.index.entries.length);

  fs.writeFileSync(path.join(state.root, 'src', 'a.json'), '{"a":"tampered"}');
  const after = verifyRepoIndexAgainstDisk({ repoRoot: state.root, index: state.index, paths: ['src/a.json'] });
  assert.equal(after.verified, false);
  assert.deepEqual(after.reasonCodes, ['REPO_INDEX_ENTRY_DIGEST_MISMATCH']);
  assert.equal(after.mismatches[0].path, 'src/a.json');
});

test('R6-I15 a malformed index policy is rejected and tracked state is never invented', () => {
  for (const [broken, pattern] of [
    [{ ...INDEX_POLICY, roots: [] }, /ROOTS_REQUIRED/],
    [{ ...INDEX_POLICY, roots: ['src/', 'src/nested/'] }, /NESTED_ROOT/],
    [{ ...INDEX_POLICY, subsystemRules: [{ prefix: 'src/', subsystem: 'A' }, { prefix: 'src/', subsystem: 'B' }] }, /DUPLICATE_SUBSYSTEM_PREFIX/],
    [{ ...INDEX_POLICY, trackedStatusSource: 'GUESSED' }, /UNKNOWN_TRACKED_STATUS_SOURCE/],
    [{ ...INDEX_POLICY, trackedStatusSource: 'SUPPLIED' }, /TRACKED_PATHS_DIGEST_REQUIRED/],
    [{ ...INDEX_POLICY, trackedPathsSha256: 'a'.repeat(64) }, /TRACKED_PATHS_DIGEST_FORBIDDEN/]
  ]) {
    assert.throws(() => validateRepoIndexPolicy(broken), pattern);
  }
  // Rule order cannot change classification: longest prefix always wins.
  const reordered = { ...INDEX_POLICY, subsystemRules: [...INDEX_POLICY.subsystemRules].reverse() };
  const root = indexRoot();
  assert.equal(buildRepoIndex({ repoRoot: root, policy: reordered }).indexSha256, indexOf(root).indexSha256);
  assert.equal(entryOf(indexOf(root), 'src/nested/c.md').subsystem, 'NESTED');

  // A supplied tracked set is part of policy identity and must match its digest.
  const tracked = ['src/a.json'];
  const supplied = { ...INDEX_POLICY, trackedStatusSource: 'SUPPLIED', trackedPathsSha256: trackedPathsSha256(tracked) };
  const trackedIndex = buildRepoIndex({ repoRoot: root, policy: supplied, trackedPaths: tracked });
  assert.equal(entryOf(trackedIndex, 'src/a.json').tracked, 'TRACKED');
  assert.equal(entryOf(trackedIndex, 'src/B.mjs').tracked, 'UNTRACKED');
  assert.throws(() => buildRepoIndex({ repoRoot: root, policy: supplied, trackedPaths: ['src/B.mjs'] }), /TRACKED_PATHS_DIGEST_MISMATCH/);
});

test('R6-I16 the real governance scope indexes deterministically', () => {
  const first = buildRepoIndex({ repoRoot: REPO_ROOT, policy: DEFAULT_REPO_INDEX_POLICY });
  const second = buildRepoIndex({ repoRoot: REPO_ROOT, policy: DEFAULT_REPO_INDEX_POLICY });
  assert.equal(second.indexSha256, first.indexSha256);
  assert.equal(validateRepoIndex(first).valid, true);
  assert.ok(first.entries.length > 100);
  assert.equal(entryOf(first, 'governance/gee-v1/router/router-engine.mjs').layer, 'R5');
  assert.equal(entryOf(first, 'governance/gee-v1/recovery/recovery-engine.mjs').layer, 'R6');
  assert.equal(entryOf(first, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0006.json').governanceArtifact, true);
  assert.equal(verifyRepoIndexAgainstDisk({ repoRoot: REPO_ROOT, index: first, paths: ['governance/gee-v1/index/repo-index.mjs'] }).verified, true);
});

/* ===========================================================================
 * R6-R — recovery
 * ======================================================================== */

test('R6-R01 a fresh work unit with no checkpoint starts normally and claims nothing complete', () => {
  const state = scenario();
  const recovery = recover(state, null, createUsageLedger());
  assert.equal(recovery.decision, 'START_FRESH');
  assert.ok(recovery.reasonCodes.includes('NO_COMPLETION_ASSUMED'));
  assert.deepEqual(recovery.resumedTaskIds, []);
  assert.deepEqual(recovery.pendingTaskIds, ['t:a', 't:b', 't:c']);
  assert.equal(recovery.metrics.COMPLETED_BEFORE_RECOVERY, 0);
});

test('R6-R02 an interruption after one of three tasks resumes only the remaining two', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  assert.equal(checkpoint.recoveryState, 'INTERRUPTED');

  const recovery = recover(state, checkpoint, ledger);
  assert.equal(recovery.decision, 'RESUME');
  assert.deepEqual(recovery.resumedTaskIds, ['t:a']);
  assert.deepEqual(recovery.pendingTaskIds, ['t:b', 't:c']);
  assert.equal(recovery.metrics.RESTARTED_FROM_ZERO, false);

  // The next revision carries the reused completion forward untouched.
  const next = createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT,
    authority: AUTHORITY,
    baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
    inputs: state.inputs,
    tasks: checkpointTasksFromRecovery(recovery),
    recoveryState: 'PARTIAL_COMPLETE',
    previousCheckpoint: checkpoint
  });
  assert.equal(next.revision, 'R0002');
  assert.equal(next.previousCheckpointSha256, checkpoint.checkpointSha256);
  assert.equal(next.tasks.find((task) => task.taskId === 't:a').state, 'COMPLETE');
});

test('R6-R03 a completed task whose inputs did not move stays reusable', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.deepEqual(recovery.resumedTaskIds, ['t:a', 't:b']);
  assert.deepEqual(taskIn(recovery, 't:a').reasonCodes, ['COMPLETION_STILL_PROVEN']);
  assert.equal(recovery.metrics.TASKS_REVALIDATED, 0);
});

test('R6-R04 a completed task whose dependency changed returns to work, alone', () => {
  const state = scenario({ mutate: (root) => fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":2}') });
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b', 't:c'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);

  assert.equal(recovery.decision, 'REVALIDATE_SOME');
  assert.deepEqual(recovery.revalidatedTaskIds, ['t:b']);
  assert.deepEqual(recovery.resumedTaskIds, ['t:a', 't:c']);
  assert.ok(taskIn(recovery, 't:b').reasonCodes.includes('SOURCE_CHANGED:src/b.json'));
  assert.ok(taskIn(recovery, 't:b').reasonCodes.includes('EVIDENCE_INVALIDATED:e:b'));
  // Its evidence binding is dropped, so nothing stale can be re-presented later.
  assert.deepEqual(taskIn(recovery, 't:b').evidence, []);
  assert.deepEqual(taskIn(recovery, 't:b').usageRecordIds, []);
});

test('R6-R05 an unrelated repository change preserves every unaffected completion', () => {
  const state = scenario({ mutate: (root) => fs.writeFileSync(path.join(root, 'src', 'unrelated.json'), '{"noise":1}') });
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b', 't:c'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.equal(recovery.decision, 'RESUME');
  assert.deepEqual(recovery.resumedTaskIds, ['t:a', 't:b', 't:c']);
  assert.equal(recovery.metrics.RESTARTED_FROM_ZERO, false);
});

test('R6-R06 a changed route digest alone does not discard valid completions', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b'], createUsageLedger());

  // A genuinely different route over the same task semantics: one extra task
  // moves the plan digest without changing what t:a and t:b are.
  const widened = scenario({
    tasks: [...defaultTasks(), { taskId: 't:extra', intent: 'DETERMINISTIC', sources: ['src/a.json'] }]
  });
  assert.notEqual(widened.plan.routeSha256, state.plan.routeSha256);

  const recovery = planRecovery({
    workUnitId: SYNTHETIC_WORK_UNIT,
    checkpoint,
    routePlan: widened.plan,
    evidenceStates: widened.evidenceStates,
    r3Delta: widened.r3Delta,
    usageLedger: ledger,
    authority: AUTHORITY
  });
  assert.equal(recovery.routeChanged, true);
  assert.ok(recovery.reasonCodes.includes('ROUTE_IDENTITY_CHANGED_PROGRESS_EVALUATED_PER_TASK'));
  assert.deepEqual(recovery.resumedTaskIds, ['t:a', 't:b']);
  assert.equal(recovery.decision, 'RESUME');
  assert.deepEqual(recovery.pendingTaskIds, ['t:c', 't:extra']);
});

test('R6-R07 a changed route digest WITH changed task semantics invalidates that task', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b'], createUsageLedger());

  // t:a now reads a second source: same id, different contract with the world.
  const respecified = scenario({
    tasks: [
      { ...verifyTask('t:a', 'src/a.json', 'e:a'), sources: ['src/a.json', 'fixtures/canonical.json'] },
      verifyTask('t:b', 'src/b.json', 'e:b'),
      verifyTask('t:c', 'fixtures/canonical.json', 'e:c')
    ]
  });
  const recovery = planRecovery({
    workUnitId: SYNTHETIC_WORK_UNIT,
    checkpoint,
    routePlan: respecified.plan,
    evidenceStates: respecified.evidenceStates,
    r3Delta: respecified.r3Delta,
    usageLedger: ledger,
    authority: AUTHORITY
  });
  assert.equal(recovery.decision, 'REVALIDATE_SOME');
  assert.deepEqual(recovery.revalidatedTaskIds, ['t:a']);
  assert.ok(taskIn(recovery, 't:a').reasonCodes.includes('TASK_SEMANTICS_CHANGED'));
  assert.deepEqual(recovery.resumedTaskIds, ['t:b']);
});

test('R6-R08 recovery never bypasses an R5 BLOCKED task', () => {
  const state = scenario({
    tasks: [...defaultTasks(), { taskId: 't:blocked', intent: 'DETERMINISTIC', sources: [], requiredEvidenceIds: ['e:absent'] }]
  });
  assert.deepEqual(state.plan.blockedTasks, ['t:blocked']);
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  assert.equal(checkpoint.tasks.find((task) => task.taskId === 't:blocked').state, 'BLOCKED');

  const recovery = recover(state, checkpoint, ledger);
  assert.deepEqual(recovery.blockedTaskIds, ['t:blocked']);
  assert.equal(taskIn(recovery, 't:blocked').state, 'BLOCKED');
  assert.ok(taskIn(recovery, 't:blocked').reasonCodes.includes('R5_BLOCKED_STATE_PRESERVED'));
  assert.equal(recovery.pendingTaskIds.includes('t:blocked'), false);
  assert.equal(recovery.resumedTaskIds.includes('t:blocked'), false);

  // And a checkpoint cannot launder it into completion.
  assert.throws(() => createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT,
    authority: AUTHORITY,
    baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
    inputs: state.inputs,
    tasks: checkpoint.tasks.map((task) => (task.taskId === 't:blocked'
      ? { ...task, state: 'COMPLETE', usageRecordIds: ['usage:SYNTH_01#t:blocked#1'] }
      : task)),
    recoveryState: 'PARTIAL_COMPLETE'
  }), /CHECKPOINT_COMPLETION_CONTRADICTS_ROUTED_CAPABILITY/);
});

test('R6-R09 an R5 DEFERRED task stays deferred through recovery', () => {
  const state = scenario({
    tasks: [...defaultTasks(), { taskId: 't:wide', intent: 'SEMANTIC', sources: ['src/a.json'], architectureImpact: 'MULTI_LAYER' }],
    policy: { ...DEFAULT_ROUTER_POLICY, costCeiling: 'VERY_LOW' }
  });
  assert.deepEqual(state.plan.deferredTasks, ['t:wide']);
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  assert.equal(checkpoint.tasks.find((task) => task.taskId === 't:wide').state, 'DEFERRED');

  const recovery = recover(state, checkpoint, ledger);
  assert.deepEqual(recovery.deferredTaskIds, ['t:wide']);
  assert.ok(taskIn(recovery, 't:wide').reasonCodes.includes('R5_DEFERRED_STATE_PRESERVED'));
  assert.equal(recovery.pendingTaskIds.includes('t:wide'), false);
});

test('R6-R10 recovery cannot invent an owner decision', () => {
  const state = scenario({
    tasks: [...defaultTasks(), { taskId: 't:owner', intent: 'POLICY_DECISION', sources: ['src/a.json'] }]
  });
  assert.deepEqual(state.plan.ownerDecisionTasks, ['t:owner']);
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.deepEqual(recovery.ownerDecisionTaskIds, ['t:owner']);
  assert.ok(taskIn(recovery, 't:owner').reasonCodes.includes('R5_OWNER_DECISION_PRESERVED'));
  assert.equal(recovery.resumedTaskIds.includes('t:owner'), false);
  assert.equal(recovery.pendingTaskIds.includes('t:owner'), false);
});

test('R6-R11 a stopped patch cascade is preserved and no third targeted patch is scheduled', () => {
  const defect = { defectId: 'DEF-1', rootCauseClass: 'RC-STALE-BASIS' };
  const survived = (ledger) => appendRepairRecord(ledger, { ...defect, outcome: SURVIVED, evidenceRef: 'test://attempt' });
  const state = scenario({
    tasks: [...defaultTasks(), { taskId: 't:patch-3', intent: 'SEMANTIC', sources: ['src/a.json'], repair: { ...defect, incremental: true } }],
    repairLedger: survived(survived(createRepairLedger()))
  });
  assert.equal(state.plan.repairContainment.stopPatchCascade, true);
  assert.deepEqual(state.plan.blockedTasks, ['t:patch-3']);

  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.equal(recovery.stopPatchCascade, true);
  assert.ok(recovery.reasonCodes.includes('R5_REPAIR_CONTAINMENT_STOP_PRESERVED'));
  assert.deepEqual(recovery.blockedTaskIds, ['t:patch-3']);
  assert.ok(taskIn(recovery, 't:patch-3').reasonCodes.includes('R5_REPAIR_CONTAINMENT_STOP_PRESERVED'));
  assert.equal(recovery.pendingTaskIds.includes('t:patch-3'), false);
});

test('R6-R12 a malformed checkpoint is rejected', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  for (const broken of [
    { ...checkpoint, engine: 'SOMETHING_ELSE' },
    { ...checkpoint, tasks: checkpoint.tasks.map((task) => ({ ...task, state: 'MADE_UP' })) },
    { ...checkpoint, revision: 'R0007' },
    { ...checkpoint, recoveryState: 'COMPLETE' },
    { ...checkpoint, previousCheckpointSha256: 'a'.repeat(64) }
  ]) {
    assert.equal(validateCheckpoint(broken).valid, false, JSON.stringify(broken.engine || broken.revision || broken.recoveryState));
    assert.throws(() => recover(state, broken, ledger), /INVALID_CHECKPOINT/);
  }
  // A completion with no evidence and no usage record is refused at both ends.
  const unsupported = checkpoint.tasks.map((task) => (task.taskId === 't:b' ? { ...task, state: 'COMPLETE' } : task));
  assert.throws(() => createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT, authority: AUTHORITY,
    baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
    inputs: state.inputs, tasks: unsupported, recoveryState: 'PARTIAL_COMPLETE'
  }), /CHECKPOINT_COMPLETION_WITHOUT_EVIDENCE/);
});

test('R6-R13 a checkpoint carrying the wrong digest is rejected', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  const tampered = { ...checkpoint, checkpointSha256: '0'.repeat(64) };
  assert.equal(validateCheckpoint(tampered).valid, false);
  assert.ok(validateCheckpoint(tampered).errors.some((error) => error.reason === 'INVALID_CHECKPOINT_DIGEST'));
  assert.throws(() => assertCheckpoint(tampered), /INVALID_CHECKPOINT_DIGEST/);

  // Editing the body without re-signing it is caught by the same recomputation.
  const edited = { ...checkpoint, tasks: checkpoint.tasks.map((task) => ({ ...task, state: task.taskId === 't:b' ? 'COMPLETE' : task.state })) };
  assert.equal(validateCheckpoint(edited).valid, false);
  assert.throws(() => recover(state, edited, ledger), /INVALID_CHECKPOINT/);
});

test('R6-R14 a checkpoint referencing an absent usage record fails closed', () => {
  const state = scenario();
  const { checkpoint } = checkpointFor(state, ['t:a'], createUsageLedger());
  // The checkpoint survived, its proof did not.
  const recovery = recover(state, checkpoint, createUsageLedger());
  assert.equal(recovery.decision, 'BLOCKED');
  assert.ok(recovery.reasonCodes.some((code) => code.startsWith('CHECKPOINT_USAGE_RECORD_MISSING:')));
  assert.deepEqual(recovery.missingUsageRecordIds, ['usage:SYNTH_01#t:a#1']);
});

test('R6-R15 a separate process reaches the identical recovery decision', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);

  const payload = path.join(state.root, 'recovery-payload.json');
  fs.writeFileSync(payload, JSON.stringify({
    checkpoint, plan: state.plan, evidenceStates: state.evidenceStates,
    r3Delta: state.r3Delta, ledger: JSON.parse(serializeUsageLedger(ledger)),
    index: state.index, authority: AUTHORITY
  }));
  const runner = path.join(state.root, 'recovery-runner.mjs');
  fs.writeFileSync(runner, `
import fs from 'node:fs';
const recovery = await import(${JSON.stringify(moduleUrl('governance/gee-v1/recovery/recovery-engine.mjs'))});
const usage = await import(${JSON.stringify(moduleUrl('governance/gee-v1/usage/usage-ledger.mjs'))});
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, 'utf8'));
const plan = recovery.planRecovery({
  workUnitId: ${JSON.stringify(SYNTHETIC_WORK_UNIT)},
  checkpoint: payload.checkpoint,
  routePlan: payload.plan,
  evidenceStates: payload.evidenceStates,
  r3Delta: payload.r3Delta,
  usageLedger: usage.parseUsageLedger(JSON.stringify(payload.ledger)),
  repoIndex: payload.index,
  authority: payload.authority
});
process.stdout.write(JSON.stringify({ decision: plan.decision, resumed: plan.resumedTaskIds, pending: plan.pendingTaskIds, reasons: plan.reasonCodes }));
`);
  const observed = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }));
  assert.equal(observed.decision, recovery.decision);
  assert.deepEqual(observed.resumed, recovery.resumedTaskIds);
  assert.deepEqual(observed.pending, recovery.pendingTaskIds);
  assert.deepEqual(observed.reasons, recovery.reasonCodes);
});

test('R6-R16 a crash after usage but before the checkpoint never double-counts', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  // t:b executed and recorded, then the process died before the next revision.
  const orphan = appendUsageRecord(ledger, usageFor(state, 't:b'));
  const recovery = recover(state, checkpoint, orphan.ledger);

  assert.deepEqual(recovery.unreferencedUsageRecordIds, ['usage:SYNTH_01#t:b#1']);
  assert.ok(recovery.reasonCodes.includes('UNREFERENCED_EXECUTION_ARTIFACT_DETECTED'));
  // The orphan proves nothing complete: t:b is still work.
  assert.equal(recovery.resumedTaskIds.includes('t:b'), false);
  assert.ok(recovery.pendingTaskIds.includes('t:b'));

  // Replaying that exact execution adds nothing; a genuine retry is separate.
  const replay = appendUsageRecord(orphan.ledger, usageFor(state, 't:b'));
  assert.equal(replay.appended, false);
  assert.equal(aggregateUsage(replay.ledger).recordCount, 2);
  const retry = appendUsageRecord(orphan.ledger, usageFor(state, 't:b', { attempt: nextAttemptOrdinal(orphan.ledger, SYNTHETIC_WORK_UNIT, 't:b') }));
  assert.equal(retry.appended, true);
  assert.equal(aggregateUsage(retry.ledger).recordCount, 3);
  assert.equal(reconcileCheckpointWithUsage(checkpoint, orphan.ledger).consistent, true);
});

test('R6-R17 a corrupt newest revision never silently promotes an older one', () => {
  const state = scenario();
  const store = createCheckpointStore(path.join(state.root, 'recovery'));
  const first = checkpointFor(state, ['t:a'], createUsageLedger());
  store.commit({ workUnitId: SYNTHETIC_WORK_UNIT, ledger: first.ledger, checkpoint: first.checkpoint });

  const second = checkpointFor(state, ['t:a', 't:b'], createUsageLedger(), { previousCheckpoint: first.checkpoint });
  store.commit({ workUnitId: SYNTHETIC_WORK_UNIT, ledger: second.ledger, checkpoint: second.checkpoint });
  assert.deepEqual(store.listRevisions(SYNTHETIC_WORK_UNIT), ['R0001', 'R0002']);

  // Corrupt only the newest revision.
  const newestFile = path.join(store.directoryFor(SYNTHETIC_WORK_UNIT), 'R0002', 'checkpoint.json');
  fs.writeFileSync(newestFile, JSON.stringify({ ...second.checkpoint, checkpointSha256: '0'.repeat(64) }, null, 2));

  const strict = store.loadLatestValid(SYNTHETIC_WORK_UNIT);
  assert.equal(strict.checkpoint, null);
  assert.equal(strict.recoveryRequired, true);
  assert.ok(strict.reasonCodes.includes('CORRUPT_NEWEST_CHECKPOINT_REVISION'));
  assert.ok(strict.reasonCodes.includes('OLDER_VALID_CHECKPOINT_NOT_AUTHORIZED'));
  assert.deepEqual(strict.corruptRevisions, ['R0002:INVALID_CHECKPOINT_DIGEST']);

  const strictRecovery = recover(state, null, second.ledger, { corruptRevisions: strict.corruptRevisions });
  assert.equal(strictRecovery.decision, 'RECOVERY_REQUIRED');
  assert.ok(strictRecovery.reasonCodes.some((code) => code.startsWith('CORRUPT_NEWEST_CHECKPOINT_REVISION:')));

  // Only an explicit policy authorizes the older revision, and it still reports.
  const permitted = store.loadLatestValid(SYNTHETIC_WORK_UNIT, { allowOlderValidCheckpoint: true });
  assert.equal(permitted.revision, 'R0001');
  assert.ok(permitted.reasonCodes.includes('RESUMED_FROM_OLDER_VALID_CHECKPOINT'));
  const permittedRecovery = recover(state, permitted.checkpoint, second.ledger, {
    corruptRevisions: permitted.corruptRevisions, policy: { allowOlderValidCheckpoint: true }
  });
  assert.equal(permittedRecovery.decision, 'RESUME');
  assert.deepEqual(permittedRecovery.resumedTaskIds, ['t:a']);
  assert.ok(permittedRecovery.reasonCodes.some((code) => code.startsWith('RESUMED_FROM_OLDER_VALID_CHECKPOINT:')));

  // A revision is written once; history is never reopened for writing.
  assert.throws(() => store.writeCheckpoint(first.checkpoint), /CHECKPOINT_REVISION_EXISTS/);
});

test('R6-A2-01 a matching COMPLETED usage record supports completion', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.equal(recovery.decision, 'RESUME');
  assert.deepEqual(recovery.resumedTaskIds, ['t:a']);
});

test('R6-A2-02 a usage record from another task cannot support completion', () => {
  const state = scenario();
  const initial = checkpointFor(state, ['t:a'], createUsageLedger());
  const wrong = appendUsageRecord(initial.ledger, usageFor(state, 't:b'));
  const task = initial.checkpoint.tasks.find((entry) => entry.taskId === 't:a');
  const forged = resignCheckpoint(initial.checkpoint, {
    tasks: initial.checkpoint.tasks.map((entry) => entry.taskId === 't:a'
      ? { ...entry, usageRecordIds: [wrong.usageRecordId] }
      : entry)
  });
  const recovery = recover(state, forged, wrong.ledger);
  assert.equal(task.taskId, 't:a');
  assert.equal(recovery.decision, 'BLOCKED');
  assert.ok(recovery.reasonCodes.some((code) => code.startsWith('CHECKPOINT_USAGE_RECORD_SEMANTICS_INVALID')));
});

test('R6-A2-03 a FAILED usage record cannot support completion', () => {
  const state = scenario();
  const forged = checkpointWithAlternateUsage(state, { outcome: 'FAILED' });
  const recovery = recover(state, forged.checkpoint, forged.ledger);
  assert.equal(recovery.decision, 'BLOCKED');
  assert.ok(recovery.reasonCodes.some((code) => code.startsWith('CHECKPOINT_USAGE_RECORD_SEMANTICS_INVALID')));
});

test('R6-A2-04 a usage record from another work unit cannot support completion', () => {
  const state = scenario();
  const forged = checkpointWithAlternateUsage(state, { workUnitId: 'OTHER_WORK_UNIT' });
  const recovery = recover(state, forged.checkpoint, forged.ledger);
  assert.equal(recovery.decision, 'BLOCKED');
  assert.ok(recovery.reasonCodes.some((code) => code.startsWith('CHECKPOINT_USAGE_RECORD_SEMANTICS_INVALID')));
});

test('R6-A2-05 a usage record from another route cannot support completion', () => {
  const state = scenario();
  const forged = checkpointWithAlternateUsage(state, { routeSha256: 'e'.repeat(64) });
  const recovery = recover(state, forged.checkpoint, forged.ledger);
  assert.equal(recovery.decision, 'BLOCKED');
  assert.ok(recovery.reasonCodes.some((code) => code.startsWith('CHECKPOINT_USAGE_RECORD_SEMANTICS_INVALID')));
});

test('R6-A2-06 semantically wrong existing usage proof fails recovery closed', () => {
  const state = scenario();
  const forged = checkpointWithAlternateUsage(state, { outcome: 'DEFERRED' });
  const recovery = recover(state, forged.checkpoint, forged.ledger);
  assert.equal(recovery.decision, 'BLOCKED');
  assert.equal(recovery.missingUsageRecordIds.length, 0);
});

test('R6-A3-01 an unchanged required evidence identity preserves its consumer', () => {
  const consumer = verifyTask('t:consumer', 'src/a.json', 'e:b', { requiredEvidenceIds: ['e:a'] });
  const state = scenario({ tasks: [consumer] });
  const { checkpoint, ledger } = checkpointFor(state, ['t:consumer'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.equal(recovery.decision, 'RESUME');
  assert.deepEqual(recovery.resumedTaskIds, ['t:consumer']);
});

test('R6-A3-02 an invalidated required evidence revalidates its consumer', () => {
  const consumer = verifyTask('t:consumer', 'src/a.json', 'e:b', { requiredEvidenceIds: ['e:a'] });
  const state = scenario({ tasks: [consumer] });
  const { checkpoint, ledger } = checkpointFor(state, ['t:consumer'], createUsageLedger());
  const current = {
    ...state,
    evidenceStates: state.evidenceStates.map((node) => node.evidenceId === 'e:a'
      ? { ...node, state: 'INVALIDATED' }
      : node)
  };
  const recovery = recover(current, checkpoint, ledger);
  assert.equal(recovery.decision, 'RESTART_REQUIRED');
  assert.ok(taskIn(recovery, 't:consumer').reasonCodes.includes('EVIDENCE_INVALIDATED:e:a'));
});

test('R6-A3-03 a freshly revalidated required evidence still invalidates the old consumer', () => {
  const consumer = verifyTask('t:consumer', 'src/a.json', 'e:b', { requiredEvidenceIds: ['e:a'] });
  const state = scenario({ tasks: [consumer] });
  const { checkpoint, ledger } = checkpointFor(state, ['t:consumer'], createUsageLedger());
  const evidenceStates = state.evidenceStates.map((node) => node.evidenceId === 'e:a'
    ? { ...node, state: 'REUSABLE', reuseIdentity: 'f'.repeat(64) }
    : node);
  const recovery = planRecovery({
    workUnitId: SYNTHETIC_WORK_UNIT,
    checkpoint,
    routePlan: state.plan,
    evidenceStates,
    r3Delta: state.r3Delta,
    usageLedger: ledger,
    repoIndex: state.index,
    authority: AUTHORITY
  });
  assert.equal(recovery.decision, 'RESTART_REQUIRED');
  assert.ok(taskIn(recovery, 't:consumer').reasonCodes.includes('EVIDENCE_IDENTITY_CHANGED:e:a'));
});

test('R6-A3-04 a consumer rerun against the new identity is reusable', () => {
  const consumer = verifyTask('t:consumer', 'src/a.json', 'e:b', { requiredEvidenceIds: ['e:a'] });
  const state = scenario({ tasks: [consumer] });
  const evidenceStates = state.evidenceStates.map((node) => node.evidenceId === 'e:a'
    ? { ...node, state: 'REUSABLE', reuseIdentity: 'f'.repeat(64) }
    : node);
  const rerunState = { ...state, evidenceStates };
  const { checkpoint, ledger } = checkpointFor(rerunState, ['t:consumer'], createUsageLedger());
  const recovery = recover(rerunState, checkpoint, ledger);
  assert.equal(recovery.decision, 'RESUME');
  assert.deepEqual(recovery.resumedTaskIds, ['t:consumer']);
});

test('R6-A3-05 an unrelated evidence identity change preserves the consumer', () => {
  const consumer = verifyTask('t:consumer', 'src/a.json', 'e:b', { requiredEvidenceIds: ['e:a'] });
  const state = scenario({ tasks: [consumer] });
  const { checkpoint, ledger } = checkpointFor(state, ['t:consumer'], createUsageLedger());
  const evidenceStates = state.evidenceStates.map((node) => node.evidenceId === 'e:c'
    ? { ...node, state: 'REUSABLE', reuseIdentity: 'f'.repeat(64) }
    : node);
  const recovery = planRecovery({
    workUnitId: SYNTHETIC_WORK_UNIT, checkpoint, routePlan: state.plan,
    evidenceStates, r3Delta: state.r3Delta, usageLedger: ledger,
    repoIndex: state.index, authority: AUTHORITY
  });
  assert.deepEqual(recovery.resumedTaskIds, ['t:consumer']);
});

test('R6-A4-01 a valid R0001 to R0003 chain loads its latest revision', () => {
  const state = scenario();
  const { first, second, third } = checkpointChain(state);
  const store = createCheckpointStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-a4-01-')));
  store.writeCheckpoint(first);
  store.writeCheckpoint(second);
  store.writeCheckpoint(third);
  assert.equal(store.loadLatestValid(SYNTHETIC_WORK_UNIT).revision, 'R0003');
});

test('R6-A4-02 changing a predecessor while retaining a descendant breaks the chain', () => {
  const state = scenario();
  const { first, second, third } = checkpointChain(state);
  const brokenSecond = resignCheckpoint(second, { baseline: { ...second.baseline, head: 'changed' } });
  const store = createCheckpointStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-a4-02-')));
  store.writeCheckpoint(first);
  store.writeCheckpoint(brokenSecond);
  store.writeCheckpoint(third);
  const loaded = store.loadLatestValid(SYNTHETIC_WORK_UNIT);
  assert.equal(loaded.checkpoint, null);
  assert.equal(loaded.recoveryRequired, true);
  assert.ok(loaded.reasonCodes.includes('CHECKPOINT_HISTORY_CHAIN_BROKEN'));
});

test('R6-A4-03 a forged valid previous hash is rejected', () => {
  const state = scenario();
  const { first, second, third } = checkpointChain(state);
  const forgedThird = resignCheckpoint(third, { previousCheckpointSha256: 'a'.repeat(64) });
  const store = createCheckpointStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-a4-03-')));
  store.writeCheckpoint(first);
  store.writeCheckpoint(second);
  store.writeCheckpoint(forgedThird);
  assert.equal(store.loadLatestValid(SYNTHETIC_WORK_UNIT).checkpoint, null);
});

test('R6-A4-04 a missing predecessor makes its descendant an orphan', () => {
  const state = scenario();
  const { first, third } = checkpointChain(state);
  const store = createCheckpointStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-a4-04-')));
  store.writeCheckpoint(first);
  store.writeCheckpoint(third);
  const loaded = store.loadLatestValid(SYNTHETIC_WORK_UNIT);
  assert.equal(loaded.checkpoint, null);
  assert.ok(loaded.corruptRevisions.some((entry) => entry.includes('CHECKPOINT_HISTORY_CHAIN_BROKEN')));
});

test('R6-A4-05 a corrupt ancestor invalidates every descendant', () => {
  const state = scenario();
  const { first, second, third } = checkpointChain(state);
  const corruptSecond = { ...second, checkpointSha256: 'b'.repeat(64) };
  const store = createCheckpointStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-a4-05-')));
  store.writeCheckpoint(first);
  const corruptDirectory = path.join(store.directoryFor(SYNTHETIC_WORK_UNIT), 'R0002');
  fs.mkdirSync(corruptDirectory, { recursive: true });
  fs.writeFileSync(path.join(corruptDirectory, 'checkpoint.json'), `${JSON.stringify(corruptSecond)}\n`);
  store.writeCheckpoint(third);
  const loaded = store.loadLatestValid(SYNTHETIC_WORK_UNIT);
  assert.equal(loaded.checkpoint, null);
  assert.ok(loaded.corruptRevisions.some((entry) => entry.startsWith('R0003:CHECKPOINT_ANCESTRY_INVALID')));
});

test('R6-A4-06 explicit fallback selects only a checkpoint with valid ancestry', () => {
  const state = scenario();
  const { first, second, third } = checkpointChain(state);
  const brokenSecond = resignCheckpoint(second, { previousCheckpointSha256: 'c'.repeat(64) });
  const store = createCheckpointStore(fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-a4-06-')));
  store.writeCheckpoint(first);
  store.writeCheckpoint(brokenSecond);
  store.writeCheckpoint(third);
  const loaded = store.loadLatestValid(SYNTHETIC_WORK_UNIT, { allowOlderValidCheckpoint: true });
  assert.equal(loaded.revision, 'R0001');
  assert.ok(loaded.reasonCodes.includes('RESUMED_FROM_OLDER_VALID_CHECKPOINT'));
});

test('R6-R18 no valid checkpoint never fabricates completion', () => {
  const state = scenario();
  const store = createCheckpointStore(path.join(state.root, 'recovery'));

  // Nothing at all: a clean start, explicitly assuming nothing.
  const empty = store.loadLatestValid(SYNTHETIC_WORK_UNIT);
  assert.equal(empty.checkpoint, null);
  assert.equal(empty.recoveryRequired, false);
  const fresh = recover(state, null, createUsageLedger(), { corruptRevisions: empty.corruptRevisions });
  assert.equal(fresh.decision, 'START_FRESH');
  assert.deepEqual(fresh.resumedTaskIds, []);

  // A history that exists but holds nothing valid: recovery required, and still
  // nothing is assumed complete.
  const only = checkpointFor(state, ['t:a'], createUsageLedger());
  store.commit({ workUnitId: SYNTHETIC_WORK_UNIT, ledger: only.ledger, checkpoint: only.checkpoint });
  fs.writeFileSync(path.join(store.directoryFor(SYNTHETIC_WORK_UNIT), 'R0001', 'checkpoint.json'), '{ not json');
  const broken = store.loadLatestValid(SYNTHETIC_WORK_UNIT);
  assert.equal(broken.checkpoint, null);
  assert.equal(broken.recoveryRequired, true);
  assert.ok(broken.reasonCodes.includes('NO_VALID_CHECKPOINT_REVISION'));
  const required = recover(state, null, only.ledger, { corruptRevisions: broken.corruptRevisions });
  assert.equal(required.decision, 'RECOVERY_REQUIRED');
  assert.deepEqual(required.resumedTaskIds, []);
  assert.equal(required.metrics.COMPLETED_BEFORE_RECOVERY, 0);
});

test('R6-R19 a mismatched work unit or authority fails closed', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());

  const otherAuthority = { missionRevisionId: 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R5', contractSha256: 'b'.repeat(64) };
  const wrongAuthority = recover(state, checkpoint, ledger, { authority: otherAuthority });
  assert.equal(wrongAuthority.decision, 'BLOCKED');
  assert.ok(wrongAuthority.reasonCodes.some((code) => code.startsWith('CHECKPOINT_AUTHORITY_MISMATCH:')));

  // A mismatched work unit is a reported BLOCKED decision rather than a throw:
  // the caller gets the reason codes instead of an exception to swallow, and
  // no task is reported reusable either way.
  const wrongUnit = planRecovery({
    workUnitId: 'SOME_OTHER_UNIT', checkpoint, routePlan: state.plan,
    evidenceStates: state.evidenceStates, r3Delta: state.r3Delta,
    usageLedger: ledger, authority: AUTHORITY
  });
  assert.equal(wrongUnit.decision, 'BLOCKED');
  assert.ok(wrongUnit.reasonCodes.some((code) => code.startsWith('ROUTE_PLAN_WORK_UNIT_MISMATCH:')));
  assert.ok(wrongUnit.reasonCodes.some((code) => code.startsWith('CHECKPOINT_WORK_UNIT_MISMATCH:')));

  // Directory naming is collision-free and never used as proof of identity.
  assert.notEqual(workUnitDirectoryName('A/B'), workUnitDirectoryName('A_B'));
  assert.equal(workUnitDirectoryName('GATE13'), workUnitDirectoryName('GATE13'));
});

test('R6-R20 a changed baseline HEAD neither forces a restart nor is ignored', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger, { currentHead: 'f'.repeat(40) });
  assert.equal(recovery.headChanged, true);
  assert.ok(recovery.reasonCodes.includes('BASELINE_HEAD_CHANGED_PROGRESS_EVALUATED_PER_TASK'));
  // The work R3 and R4 still prove valid survives the HEAD moving.
  assert.equal(recovery.decision, 'RESUME');
  assert.deepEqual(recovery.resumedTaskIds, ['t:a', 't:b']);
  assert.equal(checkpoint.baseline.head, CANONICAL_HEAD);
});

test('R6-R21 every completed task losing its basis is the only path to a restart', () => {
  const state = scenario({
    mutate: (root) => {
      fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":9}');
      fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":9}');
    }
  });
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.equal(recovery.decision, 'RESTART_REQUIRED');
  assert.ok(recovery.reasonCodes.includes('NO_COMPLETED_TASK_REMAINS_VALID'));
  assert.deepEqual(recovery.revalidatedTaskIds, ['t:a', 't:b']);
  assert.equal(recovery.metrics.RESTARTED_FROM_ZERO, true);
});

test('R6-R22 evidence whose reuse identity moved cannot be resumed on', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  const forged = {
    ...checkpoint,
    tasks: checkpoint.tasks.map((task) => (task.taskId === 't:a'
      ? { ...task, evidence: [{ evidenceId: 'e:a', reuseIdentity: 'c'.repeat(64) }] }
      : task))
  };
  // A forged body can always be re-signed by whoever holds the file, so the
  // digest is not what protects reuse here: the recorded identity is checked
  // against R4's live identity, and a resealed forgery still fails.
  const resealed = createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT, authority: AUTHORITY,
    baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
    inputs: state.inputs, tasks: forged.tasks, recoveryState: 'INTERRUPTED'
  });
  assert.equal(validateCheckpoint(resealed).valid, true);
  const recovery = recover(state, resealed, ledger);
  assert.equal(taskIn(recovery, 't:a').state, 'REVALIDATION_REQUIRED');
  assert.ok(taskIn(recovery, 't:a').reasonCodes.includes('EVIDENCE_IDENTITY_CHANGED:e:a'));
  assert.equal(recovery.resumedTaskIds.includes('t:a'), false);
});

test('R6-R23 a non-canonical persisted identifier can never share a valid digest', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());

  // 'café' and 'café' are different runtime strings that canonical
  // JSON hashes identically, so a persisted document carrying the decomposed
  // form must be rejected rather than accepted under the composed form's digest.
  const decomposed = 't:café';
  assert.notEqual(decomposed, decomposed.normalize('NFC'));
  assert.equal(sha256Canonical(decomposed), sha256Canonical(decomposed.normalize('NFC')));

  // The builder refuses it outright.
  assert.throws(() => createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT, authority: AUTHORITY,
    baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
    inputs: state.inputs,
    tasks: [{ ...checkpoint.tasks[0], taskId: decomposed, state: 'PENDING', evidence: [], usageRecordIds: [] }],
    recoveryState: 'IN_PROGRESS'
  }), /NON_CANONICAL_TASK_ID/);

  // And a hand-written document that smuggles one in fails validation, even
  // though its digest recomputes correctly over the decomposed body.
  for (const [mutate, reason] of [
    [(cp) => ({ ...cp, workUnitId: `SYNTHé_01` }), 'NON_CANONICAL_WORK_UNIT_ID'],
    [(cp) => ({ ...cp, tasks: [{ ...cp.tasks[0], taskId: decomposed }, ...cp.tasks.slice(1)] }), 'NON_CANONICAL_TASK_ID'],
    [(cp) => ({ ...cp, tasks: cp.tasks.map((task) => (task.taskId === 't:a' ? { ...task, evidence: [{ ...task.evidence[0], evidenceId: 'e:café' }] } : task)) }), 'NON_CANONICAL_EVIDENCE_ID'],
    [(cp) => ({ ...cp, tasks: cp.tasks.map((task) => (task.taskId === 't:a' ? { ...task, usageRecordIds: ['usage:SYNTH_01#t:café#1'] } : task)) }), 'NON_CANONICAL_USAGE_RECORD_ID']
  ]) {
    const smuggled = mutate(checkpoint);
    const resigned = { ...smuggled, checkpointSha256: sha256Canonical({ ...smuggled, checkpointSha256: undefined }) };
    const result = validateCheckpoint(resigned);
    assert.equal(result.valid, false, reason);
    assert.ok(result.errors.some((error) => error.reason === reason), `${reason} -> ${JSON.stringify(result.errors.map((e) => e.reason))}`);
    assert.throws(() => recover(state, resigned, ledger), /INVALID_CHECKPOINT/);
  }
});

/* ===========================================================================
 * R6-U — usage ledger
 * ======================================================================== */

const ROUTE_A = 'a'.repeat(64);

function baseRecord(overrides = {}) {
  return {
    workUnitId: 'GATE13',
    taskId: 't:one',
    attempt: 1,
    capability: 'LOCAL_DETERMINISTIC',
    outcome: 'COMPLETED',
    routeSha256: ROUTE_A,
    bytes: { contextBytes: 10, sourceProcessedBytes: 100, sourceAvoidedBytes: 900, evidenceReusedBytes: 40, evidenceRevalidatedBytes: 5 },
    ...overrides
  };
}

function ledgerWith(...records) {
  return records.reduce((ledger, record) => appendUsageRecord(ledger, record).ledger, createUsageLedger());
}

test('R6-U01 processed bytes are recorded exactly as measured', () => {
  const ledger = ledgerWith(baseRecord(), baseRecord({ taskId: 't:two', bytes: { sourceProcessedBytes: 7 } }));
  const totals = aggregateUsage(ledger, { workUnitId: 'GATE13' });
  assert.equal(totals.processedBytes, 107);
  assert.equal(ledger.records[0].bytes.sourceProcessedBytes, 100);
  assert.equal(ledger.records[1].bytes.sourceProcessedBytes, 7);
});

test('R6-U02 avoided bytes are recorded exactly as measured', () => {
  const ledger = ledgerWith(baseRecord(), baseRecord({ taskId: 't:two', bytes: { sourceAvoidedBytes: 100 } }));
  const totals = aggregateUsage(ledger);
  assert.equal(totals.avoidedBytes, 1000);
  assert.equal(totals.evidenceReuseBytes, 40);
  assert.equal(totals.revalidationBytes, 5);
});

test('R6-U03 an unavailable token count stays explicitly unavailable', () => {
  const ledger = ledgerWith(baseRecord());
  assert.deepEqual(ledger.records[0].tokens, { measurement: 'TOKEN_COUNT_UNAVAILABLE', inputTokens: null, outputTokens: null, source: null });
  const totals = aggregateUsage(ledger);
  assert.equal(totals.unknownTokenRecordCount, 1);
  assert.equal(totals.measuredInputTokens, 0);
  assert.equal(totals.measuredTokenRecordCount, 0);
});

test('R6-U04 a measured token count is accepted only with an explicit measurement state', () => {
  const measured = ledgerWith(baseRecord({ tokens: { measurement: 'MEASURED', inputTokens: 1200, outputTokens: 300, source: 'runtime-usage-api' } }));
  assert.equal(measured.records[0].tokens.measurement, 'MEASURED');
  assert.equal(aggregateUsage(measured).measuredInputTokens, 1200);
  assert.equal(aggregateUsage(measured).measuredOutputTokens, 300);

  const estimated = ledgerWith(baseRecord({ tokens: { measurement: 'ESTIMATED', inputTokens: 999, outputTokens: 1, source: 'byte-heuristic' } }));
  // An estimate is never counted as a measurement.
  assert.equal(aggregateUsage(estimated).measuredInputTokens, 0);
  assert.equal(aggregateUsage(estimated).estimatedTokenRecordCount, 1);

  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ tokens: { measurement: 'MEASURED', inputTokens: 5, outputTokens: 5 } })), /TOKEN_MEASUREMENT_SOURCE_REQUIRED/);
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ tokens: { measurement: 'MEASURED', source: 'x' } })), /INVALID_USAGE_INPUT_TOKENS/);
});

test('R6-U05 replaying the same usage record never double-counts', () => {
  let ledger = createUsageLedger();
  const first = appendUsageRecord(ledger, baseRecord());
  ledger = first.ledger;
  const replay = appendUsageRecord(ledger, baseRecord());
  assert.equal(replay.appended, false);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.ledger.ledgerSha256, ledger.ledgerSha256);
  assert.equal(aggregateUsage(replay.ledger).recordCount, 1);
  assert.equal(aggregateUsage(replay.ledger).processedBytes, 100);
});

test('R6-U06 a genuine second attempt is counted separately', () => {
  const ledger = ledgerWith(baseRecord(), baseRecord({ attempt: 2 }));
  const totals = aggregateUsage(ledger);
  assert.equal(totals.recordCount, 2);
  assert.equal(totals.taskCount, 1);
  assert.equal(totals.retryRecordCount, 1);
  assert.equal(totals.processedBytes, 200);
  assert.equal(nextAttemptOrdinal(ledger, 'GATE13', 't:one'), 3);
  assert.deepEqual(ledger.records.map((record) => record.usageRecordId), ['usage:GATE13#t:one#1', 'usage:GATE13#t:one#2']);
});

test('R6-U07 aggregate totals derive exactly from the raw records', () => {
  const ledger = ledgerWith(
    baseRecord(),
    baseRecord({ taskId: 't:two', capability: 'STANDARD_REASONING', outcome: 'FAILED' }),
    baseRecord({ taskId: 't:three', capability: 'DEEP_REASONING', outcome: 'DEFERRED' }),
    baseRecord({ taskId: 't:four', capability: 'OWNER_DECISION_REQUIRED', outcome: 'OWNER_DECISION_REQUIRED' }),
    baseRecord({ taskId: 't:five', capability: 'NO_WORK_REQUIRED', outcome: 'AVOIDED_BY_REUSE' })
  );
  const totals = aggregateUsage(ledger);
  const manual = (field) => ledger.records.reduce((sum, record) => sum + record.bytes[field], 0);
  assert.equal(totals.processedBytes, manual('sourceProcessedBytes'));
  assert.equal(totals.avoidedBytes, manual('sourceAvoidedBytes'));
  assert.equal(totals.contextBytes, manual('contextBytes'));
  assert.equal(totals.deterministicTaskCount, 1);
  assert.equal(totals.standardReasoningTaskCount, 1);
  assert.equal(totals.deepReasoningTaskCount, 1);
  assert.equal(totals.ownerDecisionCount, 1);
  assert.equal(totals.failedCount, 1);
  assert.equal(totals.deferredCount, 1);
  assert.equal(totals.avoidedByReuseCount, 1);
  assert.equal(totals.recordCount, totals.uniqueRecordCount);
  // Nothing mutable is stored: the ledger holds records only.
  assert.equal(Object.hasOwn(ledger, 'totals'), false);
});

test('R6-U08 a provider label change preserves the historical record exactly', () => {
  let ledger = createUsageLedger();
  ledger = appendUsageRecord(ledger, baseRecord({ provider: 'agent-alpha', durationMs: 120 })).ledger;
  const stored = { ...ledger.records[0] };
  const renamed = appendUsageRecord(ledger, baseRecord({ provider: 'agent-beta', durationMs: 999 }));
  assert.equal(renamed.appended, false);
  assert.equal(renamed.ledger.records[0].provider, 'agent-alpha');
  assert.equal(renamed.ledger.records[0].durationMs, 120);
  assert.equal(renamed.ledger.records[0].usageRecordSha256, stored.usageRecordSha256);
  // Provider and duration are observations, so they are outside record identity.
  assert.equal(aggregateUsage(renamed.ledger).recordCount, 1);
});

test('R6-U09 a usage record digest is deterministic and independent of key order', () => {
  const forward = appendUsageRecord(createUsageLedger(), baseRecord()).ledger.records[0];
  const reversed = appendUsageRecord(createUsageLedger(), {
    bytes: { evidenceRevalidatedBytes: 5, evidenceReusedBytes: 40, sourceAvoidedBytes: 900, sourceProcessedBytes: 100, contextBytes: 10 },
    routeSha256: ROUTE_A, outcome: 'COMPLETED', capability: 'LOCAL_DETERMINISTIC',
    attempt: 1, taskId: 't:one', workUnitId: 'GATE13'
  }).ledger.records[0];
  assert.equal(reversed.usageRecordSha256, forward.usageRecordSha256);
  assert.equal(validateUsageRecord(forward).valid, true);
});

test('R6-U10 a usage ledger survives a JSON round-trip unchanged', () => {
  const ledger = ledgerWith(baseRecord(), baseRecord({ taskId: 't:two' }), baseRecord({ attempt: 2 }));
  const revived = parseUsageLedger(serializeUsageLedger(ledger));
  assert.equal(revived.ledgerSha256, ledger.ledgerSha256);
  assert.deepEqual(revived.records, ledger.records);
  assert.deepEqual(aggregateUsage(revived), aggregateUsage(ledger));
});

test('R6-U11 a separate process aggregates identically', () => {
  const root = tempRoot();
  const ledger = ledgerWith(baseRecord(), baseRecord({ taskId: 't:two', capability: 'DEEP_REASONING' }), baseRecord({ attempt: 2 }));
  const file = path.join(root, 'usage-ledger.json');
  fs.writeFileSync(file, serializeUsageLedger(ledger));
  const runner = path.join(root, 'usage-runner.mjs');
  fs.writeFileSync(runner, `
import fs from 'node:fs';
const usage = await import(${JSON.stringify(moduleUrl('governance/gee-v1/usage/usage-ledger.mjs'))});
const ledger = usage.parseUsageLedger(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
process.stdout.write(JSON.stringify(usage.aggregateUsage(ledger)));
`);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' })), aggregateUsage(ledger));
});

test('R6-U12 a malformed usage record is rejected', () => {
  for (const [broken, pattern] of [
    [baseRecord({ capability: 'MAGIC' }), /INVALID_USAGE_CAPABILITY/],
    [baseRecord({ outcome: 'PROBABLY_FINE' }), /INVALID_USAGE_OUTCOME/],
    [baseRecord({ routeSha256: 'not-a-digest' }), /USAGE_ROUTE_IDENTITY_REQUIRED/],
    [baseRecord({ taskId: '' }), /USAGE_TASK_ID_REQUIRED/],
    [baseRecord({ attempt: 0 }), /INVALID_USAGE_ATTEMPT/],
    [baseRecord({ bytes: { madeUpField: 1 } }), /UNKNOWN_USAGE_BYTE_FIELD/],
    [baseRecord({ taskId: 'café' }), /NON_CANONICAL_USAGE_TASK_ID/],
    [null, /USAGE_RECORD_REQUIRED/]
  ]) {
    assert.throws(() => appendUsageRecord(createUsageLedger(), broken), pattern);
  }
  // A hand-edited history fails the chain replay rather than changing a total.
  const ledger = ledgerWith(baseRecord(), baseRecord({ taskId: 't:two' }));
  const edited = { ...ledger, records: [{ ...ledger.records[0], bytes: { ...ledger.records[0].bytes, sourceProcessedBytes: 1 } }, ledger.records[1]] };
  assert.throws(() => verifyUsageLedger(edited), /USAGE_RECORD_MUTATED|USAGE_LEDGER_CHAIN_BROKEN|INVALID_USAGE_LEDGER_DIGEST/);
  const dropped = { ...ledger, records: [ledger.records[1]] };
  assert.throws(() => verifyUsageLedger(dropped), /USAGE_LEDGER_CHAIN_BROKEN/);
});

test('R6-U13 negative bytes or tokens are rejected', () => {
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ bytes: { sourceProcessedBytes: -1 } })), /INVALID_USAGE_BYTES_sourceProcessedBytes/);
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ bytes: { sourceAvoidedBytes: 1.5 } })), /INVALID_USAGE_BYTES_sourceAvoidedBytes/);
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ tokens: { measurement: 'MEASURED', inputTokens: -5, outputTokens: 0, source: 'x' } })), /INVALID_USAGE_INPUT_TOKENS/);
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ durationMs: -1 })), /INVALID_USAGE_DURATION_MS/);
});

test('R6-U14 an exact token count under an unavailable measurement state is rejected', () => {
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ tokens: { measurement: 'TOKEN_COUNT_UNAVAILABLE', inputTokens: 4096, outputTokens: 512 } })), /TOKEN_COUNT_CLAIMED_WITHOUT_MEASUREMENT/);
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ tokens: { measurement: 'TOKEN_COUNT_UNAVAILABLE', source: 'guess' } })), /TOKEN_MEASUREMENT_SOURCE_WITHOUT_MEASUREMENT/);
  assert.throws(() => appendUsageRecord(createUsageLedger(), baseRecord({ tokens: { measurement: 'INVENTED', inputTokens: 1, outputTokens: 1, source: 'x' } })), /INVALID_TOKEN_MEASUREMENT_STATE/);
});

test('R6-U15 a checkpoint references exact usage record ids, and conflicts fail closed', () => {
  const state = scenario();
  const { checkpoint, ledger } = checkpointFor(state, ['t:a', 't:b'], createUsageLedger());
  const referenced = checkpoint.tasks.flatMap((task) => task.usageRecordIds);
  assert.deepEqual(referenced, ['usage:SYNTH_01#t:a#1', 'usage:SYNTH_01#t:b#1']);
  for (const id of referenced) {
    assert.equal(id, usageRecordIdFor({ workUnitId: SYNTHETIC_WORK_UNIT, taskId: id.split('#')[1], attempt: 1 }));
    assert.ok(ledger.records.some((record) => record.usageRecordId === id));
  }
  assert.equal(reconcileCheckpointWithUsage(checkpoint, ledger).consistent, true);
  // One identity may never stand for two different executions.
  assert.throws(() => appendUsageRecord(ledger, { ...usageFor(state, 't:a'), bytes: { sourceProcessedBytes: 123456 } }), /DUPLICATE_USAGE_RECORD_IDENTITY_CONFLICT/);
});

/* ===========================================================================
 * R6-X — integration with the real R2/R3/R4/R5 layers
 * ======================================================================== */

function wheelSession({ extraTasks = [], previousRepoIndex = null, cas = null, root = null } = {}) {
  const scratch = root || fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-wheel-'));
  return {
    scratch,
    session: createWheelRecoverySession({
      repoRoot: REPO_ROOT,
      workUnitId: 'GATE13',
      cas: cas || createContentAddressedStore(path.join(scratch, 'cas')),
      sourceHead: CANONICAL_HEAD,
      missionRevisionId: R6_MISSION,
      extraTasks,
      previousRepoIndex
    })
  };
}

/** Three real deterministic tasks over three real canonical Wheel sources. */
function wheelDemoTasks(sourcePaths) {
  return [0, 1, 2].map((offset) => ({
    taskId: `gee-r6-demo:step-${offset + 1}`,
    intent: 'DETERMINISTIC',
    sources: [sourcePaths[offset % sourcePaths.length]]
  }));
}

test('R6-X01..X04 a checkpoint binds the real R2, R3, R4 and R5 identities', () => {
  const { session } = wheelSession();
  const compiled = session.compiled.json;
  assert.equal(session.inputs.r2ContextSha256, sha256Canonical(compiled));
  assert.equal(session.inputs.r3DeltaSha256, session.plan.provenance.r3DeltaSha256);
  assert.equal(session.inputs.r4GraphSha256, session.plan.provenance.r4GraphSha256);
  assert.equal(session.inputs.routeSha256, session.plan.routeSha256);
  assert.match(session.inputs.repoIndexSha256, /^[a-f0-9]{64}$/);

  const checkpoint = buildWheelCheckpoint({ session });
  assert.deepEqual(checkpoint.inputs, session.inputs);
  assert.equal(checkpoint.authority.missionRevisionId, R6_MISSION);
  assert.equal(checkpoint.baseline.head, CANONICAL_HEAD);
  assert.equal(validateCheckpoint(checkpoint).valid, true);
  // The compiled context is genuinely smaller than the sources it stands for.
  assert.ok(session.compiled.metrics.sourceBytes > session.plan.metrics.R2_CONTEXT_BYTES);
});

test('R6-X05 a fabricated R5 route is rejected before any recovery decision', () => {
  const { session } = wheelSession();
  const forged = { ...session.plan, routeSha256: '0'.repeat(64) };
  assert.throws(() => planRecovery({
    workUnitId: 'GATE13', checkpoint: null, routePlan: forged,
    evidenceStates: session.evidenceStates, r3Delta: wheelRecoveryDelta(session),
    usageLedger: createUsageLedger(), authority: session.authority
  }), /INVALID_ROUTE_PLAN_DIGEST/);

  // Relabelling avoided work as executable would be the cheapest possible lie
  // about a route, and it moves the digest the plan carries.
  assert.ok(session.plan.tasks.every((task) => task.capability === 'NO_WORK_REQUIRED'));
  const relabelled = { ...session.plan, tasks: session.plan.tasks.map((task) => ({ ...task, capability: 'LOCAL_DETERMINISTIC' })) };
  assert.throws(() => planRecovery({
    workUnitId: 'GATE13', checkpoint: null, routePlan: relabelled,
    evidenceStates: session.evidenceStates, r3Delta: wheelRecoveryDelta(session),
    usageLedger: createUsageLedger(), authority: session.authority
  }), /INVALID_ROUTE_PLAN_DIGEST/);
});

test('R6-X06 a deferred R5 task keeps its deferred state through a real checkpoint', () => {
  const { session } = wheelSession();
  const sources = session.compiled.json.relevantSources.map((source) => source.path);
  const deferring = createWheelRecoverySession({
    repoRoot: REPO_ROOT, workUnitId: 'GATE13',
    cas: createContentAddressedStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-def-')), 'cas')),
    sourceHead: CANONICAL_HEAD, missionRevisionId: R6_MISSION,
    extraTasks: [{ taskId: 'gee-r6:wide', intent: 'SEMANTIC', sources: [sources[0]], architectureImpact: 'MULTI_LAYER' }],
    policy: { ...DEFAULT_ROUTER_POLICY, costCeiling: 'VERY_LOW' }
  });
  assert.deepEqual(deferring.plan.deferredTasks, ['gee-r6:wide']);
  const checkpoint = buildWheelCheckpoint({ session: deferring });
  assert.equal(checkpoint.tasks.find((task) => task.taskId === 'gee-r6:wide').state, 'DEFERRED');
  assert.throws(() => buildWheelCheckpoint({
    session: deferring, completedTaskIds: ['gee-r6:wide'],
    executionsByTaskId: { 'gee-r6:wide': { usageRecordId: 'usage:GATE13#gee-r6:wide#1', evidence: [] } }
  }), /CHECKPOINT_COMPLETION_CONTRADICTS_DEFERRED_TASK/);
});

test('R6-X07 revalidation required by R4 cannot be marked complete without fresh evidence', () => {
  const state = scenario({ mutate: (root) => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":"moved"}') });
  assert.ok(state.plan.revalidationRequiredEvidenceIds.includes('e:a'));
  const stale = evidenceOf(state.evidenceStates, 'e:a');
  assert.equal(stale.state, 'INVALIDATED');

  // A checkpoint may still be WRITTEN claiming the old completion — files are
  // not the trust boundary — but recovery refuses to resume on it.
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  const recovery = recover(state, checkpoint, ledger);
  assert.equal(taskIn(recovery, 't:a').state, 'REVALIDATION_REQUIRED');
  assert.ok(taskIn(recovery, 't:a').reasonCodes.includes('EVIDENCE_INVALIDATED:e:a'));
  assert.equal(recovery.resumedTaskIds.includes('t:a'), false);
});

test('R6-X08 an R5 owner decision leaves the checkpoint owner-required', () => {
  const state = scenario({ tasks: [...defaultTasks(), { taskId: 't:owner', intent: 'POLICY_DECISION', sources: ['src/a.json'] }] });
  const tasks = checkpointTasksFromRoutePlan(state.plan);
  assert.equal(tasks.find((task) => task.taskId === 't:owner').state, 'OWNER_DECISION_REQUIRED');
  const checkpoint = createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT, authority: AUTHORITY,
    baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
    inputs: state.inputs, tasks, recoveryState: recoveryStateFor(tasks)
  });
  assert.equal(checkpoint.recoveryState, 'IN_PROGRESS');
  assert.throws(() => createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT, authority: AUTHORITY,
    baseline: { head: CANONICAL_HEAD, headSource: 'TEST_DECLARED' },
    inputs: state.inputs,
    tasks: tasks.map((task) => (task.taskId === 't:owner' ? { ...task, state: 'COMPLETE', usageRecordIds: ['usage:SYNTH_01#t:owner#1'] } : task)),
    recoveryState: 'PARTIAL_COMPLETE'
  }), /CHECKPOINT_COMPLETION_CONTRADICTS_ROUTED_CAPABILITY/);
});

test('R6-X09 a repair containment stop survives a checkpoint and a recovery', () => {
  const defect = { defectId: 'DEF-X9', rootCauseClass: 'RC-X9' };
  const survived = (ledger) => appendRepairRecord(ledger, { ...defect, outcome: SURVIVED, evidenceRef: 'test://x9' });
  const state = scenario({
    tasks: [...defaultTasks(), { taskId: 't:patch-3', intent: 'SEMANTIC', sources: ['src/a.json'], repair: { ...defect, incremental: true } }],
    repairLedger: survived(survived(createRepairLedger()))
  });
  const { checkpoint, ledger } = checkpointFor(state, ['t:a'], createUsageLedger());
  const store = createCheckpointStore(path.join(state.root, 'recovery'));
  store.commit({ workUnitId: SYNTHETIC_WORK_UNIT, ledger, checkpoint });

  const loaded = store.loadLatestValid(SYNTHETIC_WORK_UNIT);
  const recovery = recover(state, loaded.checkpoint, store.readUsageLedger(SYNTHETIC_WORK_UNIT));
  assert.equal(recovery.stopPatchCascade, true);
  assert.deepEqual(recovery.blockedTaskIds, ['t:patch-3']);
  assert.equal(recovery.pendingTaskIds.includes('t:patch-3'), false);
});

/* ===========================================================================
 * R6-A — authority
 * ======================================================================== */

test('R6-A01 every artifact R6 writes is inside the R0006 write scope', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0006.json'), 'utf8'));
  const written = [
    ...contract.requiredArtifacts,
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0006.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0006_SEAL.json',
    'governance/gee-v1/tests/gee-r5-router.test.mjs'
  ];
  for (const artifact of written) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, ...artifact.split('/'))), true, `exists ${artifact}`);
    assert.equal(isPathAuthorized(contract.authorizedPaths, artifact), true, `authorized ${artifact}`);
  }
  // The scope must stay narrow: no frozen R1-R5 artifact may fall inside it.
  for (const frozen of [
    'governance/gee-v1/core/work-unit-core.mjs',
    'governance/gee-v1/context/compile-context.mjs',
    'governance/gee-v1/delta/delta-engine.mjs',
    'governance/gee-v1/evidence/evidence-graph.mjs',
    'governance/gee-v1/cas/content-addressed-store.mjs',
    'governance/gee-v1/router/router-engine.mjs',
    'governance/gee-v1/router/router-policy.mjs',
    'governance/gee-v1/repair/repair-containment.mjs',
    'governance/gee-v1/adapters/wheel/router-wheel-adapter.mjs',
    'governance/gee-v1/schemas/route-plan.schema.json',
    'governance/gee-v1/schemas/context-bundle.schema.json',
    'governance/gee-v1/missions/GEE_V1_STRATEGIC_CONTRACT.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0005.json',
    'governance/gee-v1/tests/gee-r4-evidence-graph.test.mjs',
    'governance/gee-v1/tests/gee-foundation-work-unit-authority.test.mjs',
    'governance/tools/canonical-json.mjs',
    'governance/PROJECT_CONSTITUTION.json'
  ]) {
    assert.equal(isPathAuthorized(contract.authorizedPaths, frozen), false, `out of scope ${frozen}`);
  }
});

test('R6-A02 R0006 carries the R4 historical write-scope defect forward without rewriting it', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0006.json'), 'utf8'));
  assert.ok(contract.invalidationDeclarations.some((declaration) => declaration.includes('R4_HISTORICAL_WRITE_SCOPE_DEFECT')));
  assert.ok(contract.invalidationDeclarations.some((declaration) => /DEFERRED/.test(declaration)));

  // The defect itself is still exactly as R0004 recorded it: three entries that
  // are whole file names and therefore authorize nothing under prefix semantics.
  const r0004 = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004.json'), 'utf8'));
  // An entry that names a whole existing file authorizes nothing, because
  // isPathAuthorized requires a STRICT prefix. Directory and stem entries in
  // the same list are unaffected, which is why the defect is narrow.
  const inert = r0004.authorizedPaths.filter((entry) => fs.existsSync(path.join(REPO_ROOT, ...entry.split('/')))
    && fs.statSync(path.join(REPO_ROOT, ...entry.split('/'))).isFile()
    && !isPathAuthorized(r0004.authorizedPaths, entry));
  assert.deepEqual(inert, [
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004_SEAL.json',
    'governance/gee-v1/tests/gee-foundation-work-unit-authority.test.mjs'
  ]);
  // R6 authorizes no write to any R0004 byte.
  const r0006 = contract.authorizedPaths;
  assert.equal(isPathAuthorized(r0006, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004.json'), false);
  assert.equal(isPathAuthorized(r0006, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004_SEAL.json'), false);
});

test('R6-A03 R7 and later remain unauthorized', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0006.json'), 'utf8'));
  assert.equal(contract.authorizedVerdicts.some((verdict) => /^R[7-9]/.test(verdict)), false);
  assert.ok(contract.invalidationDeclarations.some((declaration) => /R7 and later remain unauthorized/.test(declaration)));
  assert.deepEqual(contract.authorizedVerdicts, [
    'R6_RECOVERY_REPO_INDEX_USAGE_LEDGER_COMPLETE',
    'R6_REPAIR_REQUIRED',
    'R6_BLOCKED_ARCHITECTURE_CONTRADICTION',
    'R6_BLOCKED_BASELINE_MISMATCH'
  ]);
  assert.equal(AUTHORITY.missionRevisionId, R6_MISSION);
  assert.match(AUTHORITY.contractSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => wheelAuthorityIdentity(REPO_ROOT, 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R7'), /UNKNOWN_MISSION_REVISION/);
});

/* ===========================================================================
 * R6-DEMO — the mandatory real interruption and cross-process resume
 * ======================================================================== */

test('R6-DEMO a real Wheel work unit is interrupted and resumed in a fresh process', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r6-demo-'));
  const casRoot = path.join(scratch, 'cas');
  const storeRoot = path.join(scratch, 'recovery');
  const probe = createWheelRecoverySession({
    repoRoot: REPO_ROOT, workUnitId: 'GATE13', cas: createContentAddressedStore(casRoot),
    sourceHead: CANONICAL_HEAD, missionRevisionId: R6_MISSION
  });
  const sources = probe.compiled.json.relevantSources.map((source) => source.path);
  const extraTasks = wheelDemoTasks(sources);
  const indexFile = path.join(scratch, 'repo-index.json');
  fs.writeFileSync(indexFile, JSON.stringify(probe.repoIndex));

  const sessionSource = `
const cas = await import(${JSON.stringify(moduleUrl('governance/gee-v1/cas/content-addressed-store.mjs'))});
const adapter = await import(${JSON.stringify(moduleUrl('governance/gee-v1/adapters/wheel/recovery-wheel-adapter.mjs'))});
const store = await import(${JSON.stringify(moduleUrl('governance/gee-v1/recovery/checkpoint-store.mjs'))});
const usage = await import(${JSON.stringify(moduleUrl('governance/gee-v1/usage/usage-ledger.mjs'))});
const extraTasks = ${JSON.stringify(extraTasks)};
const previousRepoIndex = JSON.parse(fs.readFileSync(${JSON.stringify(indexFile)}, 'utf8'));
const session = adapter.createWheelRecoverySession({
  repoRoot: ${JSON.stringify(REPO_ROOT)},
  workUnitId: 'GATE13',
  cas: cas.createContentAddressedStore(${JSON.stringify(casRoot)}),
  sourceHead: ${JSON.stringify(CANONICAL_HEAD)},
  missionRevisionId: ${JSON.stringify(R6_MISSION)},
  extraTasks,
  previousRepoIndex
});
const checkpointStore = store.createCheckpointStore(${JSON.stringify(storeRoot)});
`;

  // ---- Process 1: plan, execute two of three tasks, checkpoint, then die.
  const phaseOne = path.join(scratch, 'phase-one.mjs');
  fs.writeFileSync(phaseOne, `
import fs from 'node:fs';
${sessionSource}
let ledger = usage.createUsageLedger();
const executed = {};
for (const taskId of ['gee-r6-demo:step-1', 'gee-r6-demo:step-2']) {
  const done = adapter.recordWheelTaskExecution({ session, ledger, taskId });
  ledger = done.ledger;
  executed[taskId] = done;
}
const checkpoint = adapter.buildWheelCheckpoint({
  session, completedTaskIds: Object.keys(executed), executionsByTaskId: executed, interrupted: true
});
checkpointStore.commit({ workUnitId: 'GATE13', ledger, checkpoint });
process.stdout.write(JSON.stringify({
  plannedTasks: session.plan.tasks.map((task) => task.taskId),
  avoided: session.plan.avoidedTasks,
  completed: Object.keys(executed),
  checkpointRevision: checkpoint.revision,
  recoveryState: checkpoint.recoveryState,
  usageRecords: ledger.records.map((record) => record.usageRecordId),
  indexReused: session.repoIndex.metrics.REUSED_ENTRY_COUNT,
  indexRehashed: session.repoIndex.metrics.REHASHED_ENTRY_COUNT,
  routeSha256: session.plan.routeSha256
}));
process.exit(0);
`);
  const started = JSON.parse(execFileSync(process.execPath, [phaseOne], { encoding: 'utf8' }));

  assert.equal(started.plannedTasks.length, 5);
  assert.deepEqual(started.completed, ['gee-r6-demo:step-1', 'gee-r6-demo:step-2']);
  assert.equal(started.recoveryState, 'INTERRUPTED');
  assert.equal(started.checkpointRevision, 'R0001');
  assert.equal(started.avoided.length, 2, 'the two Wheel fact verifications are avoided by R2/R3/R4 reuse');

  // ---- Process 2: a fresh process resumes from the checkpoint alone.
  const phaseTwo = path.join(scratch, 'phase-two.mjs');
  fs.writeFileSync(phaseTwo, `
import fs from 'node:fs';
${sessionSource}
const resumed = adapter.resumeWheelWorkUnit({ session, store: checkpointStore, currentHead: ${JSON.stringify(CANONICAL_HEAD)} });
const totals = usage.aggregateUsage(resumed.ledger, { workUnitId: 'GATE13' });
const remaining = adapter.recordWheelTaskExecution({ session, ledger: resumed.ledger, taskId: 'gee-r6-demo:step-3' });
const finalTasks = resumed.recovery.tasks.map((task) => (task.taskId === 'gee-r6-demo:step-3'
  ? { ...task, state: 'COMPLETE', evidence: remaining.evidence, usageRecordIds: [remaining.usageRecordId] }
  : task));
const closing = (await import(${JSON.stringify(moduleUrl('governance/gee-v1/recovery/recovery-engine.mjs'))}));
const finalCheckpoint = closing.createCheckpoint({
  workUnitId: 'GATE13',
  authority: session.authority,
  baseline: { head: ${JSON.stringify(CANONICAL_HEAD)}, headSource: 'R2_CONTEXT_SOURCE_HEAD' },
  inputs: session.inputs,
  tasks: closing.checkpointTasksFromRecovery({ ...resumed.recovery, tasks: finalTasks }),
  recoveryState: 'COMPLETE',
  previousCheckpoint: resumed.loaded.checkpoint
});
checkpointStore.commit({ workUnitId: 'GATE13', ledger: remaining.ledger, checkpoint: finalCheckpoint });
process.stdout.write(JSON.stringify({
  decision: resumed.recovery.decision,
  reasons: resumed.recovery.reasonCodes,
  resumed: resumed.recovery.resumedTaskIds,
  revalidated: resumed.recovery.revalidatedTaskIds,
  pending: resumed.recovery.pendingTaskIds,
  avoided: resumed.recovery.avoidedTaskIds,
  metrics: resumed.recovery.metrics,
  usageRecordsPreserved: resumed.ledger.records.map((record) => record.usageRecordId),
  duplicateUsageCount: totals.recordCount - totals.uniqueRecordCount,
  indexReused: session.repoIndex.metrics.REUSED_ENTRY_COUNT,
  indexRehashed: session.repoIndex.metrics.REHASHED_ENTRY_COUNT,
  routeSha256: session.plan.routeSha256,
  finalRevision: finalCheckpoint.revision,
  finalState: finalCheckpoint.recoveryState
}));
`);
  const resumedRun = JSON.parse(execFileSync(process.execPath, [phaseTwo], { encoding: 'utf8' }));

  // The whole point: nothing already finished was redone.
  assert.equal(resumedRun.decision, 'RESUME');
  assert.deepEqual(resumedRun.resumed, ['gee-r6-demo:step-1', 'gee-r6-demo:step-2']);
  assert.deepEqual(resumedRun.revalidated, []);
  assert.deepEqual(resumedRun.pending, ['gee-r6-demo:step-3']);
  assert.equal(resumedRun.metrics.RESTARTED_FROM_ZERO, false);
  assert.equal(resumedRun.metrics.COMPLETED_BEFORE_RECOVERY, 2);
  assert.equal(resumedRun.metrics.TASKS_REUSED, 2);
  assert.equal(resumedRun.metrics.TASKS_REMAINING, 1);
  assert.equal(resumedRun.metrics.TASKS_AVOIDED_BY_UPSTREAM_REUSE, 2);
  assert.ok(resumedRun.metrics.R3_AVOIDED_REPROCESS_BYTES > 0);
  assert.ok(resumedRun.metrics.R5_TASK_AVOIDED_BYTES > 0);

  // Usage history survived the process boundary and was never double-counted.
  assert.deepEqual(resumedRun.usageRecordsPreserved, started.usageRecords);
  assert.equal(resumedRun.duplicateUsageCount, 0);
  assert.equal(resumedRun.metrics.UNREFERENCED_USAGE_RECORDS, 0);

  // The real R3 proof covers only the paths it observed. Those entries are
  // reused; every other indexed path is rehashed rather than trusted by
  // omission, and the resulting index remains byte-identical.
  assert.ok(resumedRun.indexRehashed > 0);
  assert.ok(resumedRun.indexReused > 0);
  assert.equal(resumedRun.routeSha256, started.routeSha256);

  // And the work unit closed honestly, in an immutable second revision.
  assert.equal(resumedRun.finalRevision, 'R0002');
  assert.equal(resumedRun.finalState, 'COMPLETE');
  const store = createCheckpointStore(storeRoot);
  assert.deepEqual(store.listRevisions('GATE13'), ['R0001', 'R0002']);
  const finalCheckpoint = store.read('GATE13', 'R0002');
  assert.equal(finalCheckpoint.previousCheckpointSha256, store.read('GATE13', 'R0001').checkpointSha256);
  assert.equal(finalCheckpoint.tasks.filter((task) => task.state === 'COMPLETE').length, 3);
  assert.equal(finalCheckpoint.tasks.filter((task) => task.state === 'AVOIDED').length, 2);
  assert.equal(reconcileCheckpointWithUsage(finalCheckpoint, store.readUsageLedger('GATE13')).consistent, true);
  assert.equal(aggregateUsage(store.readUsageLedger('GATE13'), { workUnitId: 'GATE13' }).recordCount, 3);
  assert.equal(aggregateUsage(store.readUsageLedger('GATE13')).unknownTokenRecordCount, 3);
});

test('R6-EFF recovery reuses rather than replays, and the numbers say so', () => {
  const { session, scratch } = wheelSession({ extraTasks: [] });
  const second = wheelSession({ previousRepoIndex: session.repoIndex, root: scratch, cas: session.cas });

  // R3 proves only its covered paths unchanged. The partial delta therefore
  // re-hashes untracked index entries while preserving genuine reuse.
  assert.ok(second.session.repoIndex.metrics.REHASHED_ENTRY_COUNT > 0);
  assert.ok(second.session.repoIndex.metrics.REUSED_ENTRY_COUNT > 0);
  assert.equal(second.session.repoIndex.indexSha256, session.repoIndex.indexSha256);

  // R5 already avoided every fact-verification task through R2/R3/R4 reuse.
  assert.equal(session.plan.routeDecision, 'NO_WORK_REQUIRED');
  assert.equal(session.plan.avoidedTasks.length, session.plan.tasks.length);
  assert.equal(session.plan.metrics.R3_REPROCESS_BYTES, 0);
  assert.ok(session.plan.metrics.R3_AVOIDED_REPROCESS_BYTES > 0);

  // Recovery over that plan claims no completion it cannot prove.
  const recovery = planRecovery({
    workUnitId: 'GATE13', checkpoint: null, routePlan: session.plan,
    evidenceStates: session.evidenceStates, r3Delta: wheelRecoveryDelta(session),
    usageLedger: createUsageLedger(), repoIndex: session.repoIndex, authority: session.authority
  });
  assert.equal(recovery.decision, 'START_FRESH');
  assert.equal(recovery.metrics.TASKS_AVOIDED_BY_UPSTREAM_REUSE, session.plan.tasks.length);
  assert.deepEqual(recovery.resumedTaskIds, []);
  assert.equal(taskSemanticSha256(session.plan.tasks[0]).length, 64);
});
