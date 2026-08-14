import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EPHEMERAL_ROOT_PREFIX,
  REPO_ROOT,
  allocateEphemeralRoot,
  isRunnerOwnedEphemeralRoot,
  runAuthorityAndScope,
  runHostileAudit,
  runRecoveryStress,
  withEphemeralRootScope
} from '../evals/gee-r7-runner.mjs';
import {
  ephemeralNamespaceRoot, ephemeralRunsRoot, listOwnedRunRoots
} from '../runtime/run-root-lifecycle.mjs';

/**
 * Containment proof for the R7 runner temp leak.
 *
 * The runner allocates ephemeral execution scratch under the canonical run-root
 * namespace. Those roots are disposable per-run data, not the durable R4 CAS or
 * R6 lifecycle store, and must be removed when their producing operation ends —
 * on success and on throw. These tests measure runner-owned roots around real
 * runner workloads and prove the removal is bounded to exactly what the run
 * allocated.
 *
 * Two things stay explicitly out of scope and are asserted PRESERVED, never
 * collected: roots left by earlier runs, and anything in %TEMP% that is not a
 * manifested run root of this repository.
 */
const RUNS_ROOT = ephemeralRunsRoot();

const runnerOwnedRoots = () => new Set(listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).map((entry) => entry.runId));

function aroundWorkload(workload) {
  const before = runnerOwnedRoots();
  let outcome = 'COMPLETED';
  let value = null;
  try {
    value = workload();
  } catch (error) {
    outcome = 'THREW';
    value = error;
  }
  const after = runnerOwnedRoots();
  return {
    outcome,
    value,
    before,
    after,
    leaked: [...after].filter((name) => !before.has(name)),
    removedPreExisting: [...before].filter((name) => !after.has(name))
  };
}

test('successful runner execution leaves no new runner-owned temp root', () => {
  const measured = aroundWorkload(() => runHostileAudit());
  assert.equal(measured.outcome, 'COMPLETED');
  assert.deepEqual(measured.leaked, []);
  assert.deepEqual(measured.removedPreExisting, []);
});

test('a runner path that throws still cleans the roots it owned', () => {
  const allocated = [];
  const boom = new Error('R7_TEMP_LEAK_CONTAINMENT_FORCED_FAILURE');
  assert.throws(() => withEphemeralRootScope(() => {
    allocated.push(allocateEphemeralRoot('gee-r7-containment-throw-a-'));
    allocated.push(allocateEphemeralRoot('gee-r7-containment-throw-b-'));
    for (const root of allocated) fs.writeFileSync(path.join(root, 'scratch.json'), '{"scratch":true}\n');
    assert.ok(allocated.every((root) => fs.existsSync(root)));
    throw boom;
  }), /R7_TEMP_LEAK_CONTAINMENT_FORCED_FAILURE/);
  assert.equal(allocated.length, 2);
  // Both the work directory handed to the caller and the run root that owns it
  // are gone; a removal that stopped at the work directory would leave a
  // manifested husk behind.
  for (const root of allocated) {
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(path.dirname(root)), false);
  }
});

test('a real runner entry point leaks nothing whether it completes or throws', () => {
  // runRecoveryStress currently throws on pre-existing CONFLICTING_AUTHORITY debt
  // at some HEADs. Either outcome is acceptable here; leaking a root is not.
  const measured = aroundWorkload(() => runRecoveryStress());
  assert.ok(['COMPLETED', 'THREW'].includes(measured.outcome));
  assert.deepEqual(measured.leaked, []);
  assert.deepEqual(measured.removedPreExisting, []);
});

test('unrelated temp entries survive a runner workload byte-identical', () => {
  const sentinelBytes = Buffer.from('R7_TEMP_SENTINEL_DO_NOT_DELETE\n', 'utf8');
  const sentinelFile = path.join(os.tmpdir(), `r7-containment-sentinel-${process.pid}.txt`);
  const unrelatedDir = path.join(os.tmpdir(), `r7-containment-unrelated-${process.pid}`);
  // A decoy carrying the historical runner prefix, in the historical location:
  // the old ownership test would have called this "ours". Nothing may reach it.
  const legacyDecoy = path.join(os.tmpdir(), `${EPHEMERAL_ROOT_PREFIX}containment-decoy-${process.pid}`);
  // A decoy INSIDE the namespace but never allocated by this run, and with no
  // manifest: still not a removal candidate, because nothing enumerates
  // candidates by name.
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  const namespaceDecoy = path.join(RUNS_ROOT, `containment-decoy-unmanifested-${process.pid}`);
  fs.writeFileSync(sentinelFile, sentinelBytes);
  fs.mkdirSync(unrelatedDir, { recursive: true });
  fs.mkdirSync(legacyDecoy, { recursive: true });
  fs.mkdirSync(namespaceDecoy, { recursive: true });
  fs.writeFileSync(path.join(legacyDecoy, 'keep.txt'), 'decoy\n');
  fs.writeFileSync(path.join(namespaceDecoy, 'keep.txt'), 'decoy\n');
  try {
    runHostileAudit();
    assert.deepEqual(fs.readFileSync(sentinelFile), sentinelBytes);
    assert.equal(fs.existsSync(unrelatedDir), true);
    assert.equal(fs.existsSync(legacyDecoy), true);
    assert.equal(fs.readFileSync(path.join(legacyDecoy, 'keep.txt'), 'utf8'), 'decoy\n');
    assert.equal(fs.existsSync(namespaceDecoy), true);
    assert.equal(fs.readFileSync(path.join(namespaceDecoy, 'keep.txt'), 'utf8'), 'decoy\n');
    assert.equal(fs.existsSync(os.tmpdir()), true);
    assert.equal(fs.existsSync(RUNS_ROOT), true);
    assert.equal(fs.existsSync(ephemeralNamespaceRoot()), true);
  } finally {
    fs.rmSync(sentinelFile, { force: true });
    fs.rmSync(unrelatedDir, { recursive: true, force: true });
    fs.rmSync(legacyDecoy, { recursive: true, force: true });
    fs.rmSync(namespaceDecoy, { recursive: true, force: true });
  }
});

test('ownership is allocation, not name matching', () => {
  assert.equal(isRunnerOwnedEphemeralRoot(os.tmpdir()), false);
  assert.equal(isRunnerOwnedEphemeralRoot(path.join(os.tmpdir(), '..')), false);
  assert.equal(isRunnerOwnedEphemeralRoot(path.dirname(os.tmpdir())), false);
  assert.equal(isRunnerOwnedEphemeralRoot(path.join(os.tmpdir(), 'unrelated-dir')), false);
  assert.equal(isRunnerOwnedEphemeralRoot(RUNS_ROOT), false);
  assert.equal(isRunnerOwnedEphemeralRoot(ephemeralNamespaceRoot()), false);
  // A name that looks exactly like an allocation but never was one.
  assert.equal(isRunnerOwnedEphemeralRoot(path.join(RUNS_ROOT, `${EPHEMERAL_ROOT_PREFIX}owned`, 'work')), false);
  assert.equal(isRunnerOwnedEphemeralRoot(path.join(os.tmpdir(), `${EPHEMERAL_ROOT_PREFIX}owned`)), false);
  assert.equal(isRunnerOwnedEphemeralRoot(''), false);
  assert.equal(isRunnerOwnedEphemeralRoot(null), false);
  // Only a path this process actually allocated is owned, and only while it is.
  withEphemeralRootScope(() => {
    const allocated = allocateEphemeralRoot('gee-r7-ownership-');
    assert.equal(isRunnerOwnedEphemeralRoot(allocated), true);
  });
});

test('durable lifecycle state is never a cleanup target and survives runner workloads', () => {
  const durable = [
    path.join(REPO_ROOT, 'governance', 'gee-v1', 'cas'),
    path.join(REPO_ROOT, 'governance', 'gee-v1', 'recovery'),
    path.join(REPO_ROOT, 'governance', 'state'),
    path.join(REPO_ROOT, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson')
  ];
  for (const target of durable) assert.equal(isRunnerOwnedEphemeralRoot(target), false);
  const ledgerPath = path.join(REPO_ROOT, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
  const ledgerBefore = fs.readFileSync(ledgerPath);
  runHostileAudit();
  for (const target of durable) assert.equal(fs.existsSync(target), true);
  assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBefore);
});

test('repeated runner execution does not monotonically grow runner-owned roots', () => {
  const counts = [];
  counts.push(runnerOwnedRoots().size);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    runHostileAudit();
    counts.push(runnerOwnedRoots().size);
  }
  assert.equal(counts.length, 4);
  for (const count of counts) assert.equal(count, counts[0]);
});

test('R7 functional results are preserved by the containment change', () => {
  const hostile = runHostileAudit();
  assert.equal(hostile.audit, 'GEE_V1_R7_HOSTILE_AUDIT');
  assert.equal(hostile.fail, 0);
  assert.equal(hostile.invalid, 0);
  assert.deepEqual(hostile.materialDefects, []);
  assert.equal(hostile.pass, hostile.total);
  assert.ok(hostile.total > 0);

  const scope = runAuthorityAndScope();
  assert.equal(scope.r8, 'UNKNOWN / UNAUTHORIZED');
  assert.ok(Object.values(scope.positive).every((value) => value === true));
  assert.ok(Object.values(scope.negative).every((value) => value === false));
});
