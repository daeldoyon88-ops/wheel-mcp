import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLEANUP_ELIGIBLE_STATES,
  CLEANUP_PROTECTED_STATES,
  DURABLE_LIFECYCLE_ENV_VAR,
  RUN_ROOT_MANIFEST_DOCUMENT,
  RUN_ROOT_MANIFEST_FILE,
  RUN_STATE_ACTIVE,
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED_DISCARDED,
  RUN_STATE_FAILED_RETAINED,
  RUN_STATE_PAUSED,
  RUN_STATE_RESUMABLE,
  allocateRunRoot,
  ephemeralNamespaceRoot,
  ephemeralRunsRoot,
  evaluateRunRootRemoval,
  isCleanupEligible,
  listOwnedRunRoots,
  markRunRootState,
  readRunRootManifest,
  releaseRunRoot,
  removeRunRoot,
  repositoryIdentity,
  resolveDurableLifecycleRoot,
  withRunRoot
} from '../runtime/run-root-lifecycle.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNS_ROOT = ephemeralRunsRoot();
const NAMESPACE_ROOT = ephemeralNamespaceRoot();

const allocate = (overrides = {}) => allocateRunRoot({
  repoRoot: REPO_ROOT,
  workUnitId: 'GATE16',
  phase: 'LIFECYCLE_TEST',
  purpose: 'RUN_ROOT_LIFECYCLE_TEST',
  consumer: 'governance/gee-v1/tests/gee-runtime-run-root-lifecycle.test.mjs',
  failurePolicy: 'DISCARD',
  ...overrides
});

const cleanup = (run) => { try { releaseRunRoot(run, { state: RUN_STATE_COMPLETED, repoRoot: REPO_ROOT }); } catch { /* best effort */ } };

/* -------------------------------------------------------------------------
 * Namespace
 * ---------------------------------------------------------------------- */

test('RR01 the ephemeral namespace is %TEMP%/wheel-gee/runs and nothing else', () => {
  assert.equal(NAMESPACE_ROOT, path.join(os.tmpdir(), 'wheel-gee'));
  assert.equal(RUNS_ROOT, path.join(os.tmpdir(), 'wheel-gee', 'runs'));
  const run = allocate();
  try {
    assert.equal(path.dirname(run.path), RUNS_ROOT);
    assert.equal(path.basename(run.path), run.runId);
  } finally { cleanup(run); }
});

test('RR02 the durable lifecycle root is user-scoped and never inside %TEMP%', () => {
  const resolved = resolveDurableLifecycleRoot({ env: {}, platform: 'win32', homeDir: 'C:\\Users\\example', tempDir: os.tmpdir() });
  assert.equal(resolved.root, path.join('C:\\Users\\example', 'AppData', 'Local', 'wheel-gee', 'lifecycle'));
  assert.equal(resolved.ephemeral, false);

  const withLocalAppData = resolveDurableLifecycleRoot({ env: { LOCALAPPDATA: 'D:\\State' }, platform: 'win32', tempDir: os.tmpdir() });
  assert.equal(withLocalAppData.root, path.join('D:\\State', 'wheel-gee', 'lifecycle'));
  assert.equal(withLocalAppData.source, 'DEFAULT:LOCALAPPDATA');

  const posix = resolveDurableLifecycleRoot({ env: {}, platform: 'linux', homeDir: '/home/example', tempDir: '/tmp' });
  assert.equal(posix.root, path.join(path.resolve('/home/example'), '.local', 'state', 'wheel-gee', 'lifecycle'));

  // The real resolution on this machine must also land outside %TEMP%.
  const live = resolveDurableLifecycleRoot();
  assert.equal(live.ephemeral, false);
  assert.equal(path.relative(os.tmpdir(), live.root).startsWith('..'), true);
});

test('RR03 a system-chosen durable root inside %TEMP% fails closed; an explicit one is flagged, not trusted', () => {
  assert.throws(
    () => resolveDurableLifecycleRoot({ env: { [DURABLE_LIFECYCLE_ENV_VAR]: path.join(os.tmpdir(), 'lifecycle') }, tempDir: os.tmpdir() }),
    /DURABLE_LIFECYCLE_ROOT_INSIDE_EPHEMERAL_TEMP/
  );
  assert.throws(
    () => resolveDurableLifecycleRoot({ env: {}, platform: 'linux', homeDir: os.tmpdir(), tempDir: os.tmpdir() }),
    /DURABLE_LIFECYCLE_ROOT_INSIDE_EPHEMERAL_TEMP/
  );
  const explicit = resolveDurableLifecycleRoot({ explicitRoot: path.join(os.tmpdir(), 'harness-store'), tempDir: os.tmpdir() });
  assert.equal(explicit.ephemeral, true);
  assert.deepEqual(explicit.reasonCodes, ['DURABLE_ROOT_SUPPLIED_INSIDE_EPHEMERAL_TEMP']);
});

/* -------------------------------------------------------------------------
 * Ownership
 * ---------------------------------------------------------------------- */

test('RR04 every run root carries an exact ownership manifest', () => {
  const run = allocate();
  try {
    const { manifest } = readRunRootManifest(run.path);
    assert.equal(manifest.document, RUN_ROOT_MANIFEST_DOCUMENT);
    assert.equal(manifest.class, 'EPHEMERAL');
    assert.equal(manifest.runId, run.runId);
    assert.equal(manifest.repositoryRoot, path.resolve(REPO_ROOT));
    assert.equal(manifest.repositoryIdentity, repositoryIdentity(REPO_ROOT));
    assert.equal(manifest.ownerPid, process.pid);
    assert.equal(manifest.state, RUN_STATE_ACTIVE);
    assert.equal(manifest.failurePolicy, 'DISCARD');
    assert.equal(manifest.workUnitId, 'GATE16');
    assert.ok(fs.existsSync(path.join(run.path, RUN_ROOT_MANIFEST_FILE)));
  } finally { cleanup(run); }
});

test('RR05 run identity reuses lifecycle identity and adds only an attempt nonce', () => {
  const run = allocate();
  try {
    const repoId = repositoryIdentity(REPO_ROOT);
    assert.ok(run.runId.startsWith(`GATE16-LIFECYCLE_TEST-${repoId}-${process.pid}-`));
    const nonce = run.runId.slice(`GATE16-LIFECYCLE_TEST-${repoId}-${process.pid}-`.length);
    assert.equal(nonce.length, 6);
  } finally { cleanup(run); }
});

test('RR06 two checkouts of the same project get different identities', () => {
  assert.notEqual(repositoryIdentity('C:\\a\\wheel'), repositoryIdentity('C:\\b\\wheel'));
  assert.equal(repositoryIdentity(REPO_ROOT), repositoryIdentity(path.join(REPO_ROOT, 'governance', '..')));
});

/* -------------------------------------------------------------------------
 * Cleanup and idempotence
 * ---------------------------------------------------------------------- */

test('RR07 an eligible root is removed and a second release is a no-op success', () => {
  const run = allocate();
  fs.writeFileSync(path.join(run.scratch('cas'), 'blob'), 'x');
  const first = releaseRunRoot(run, { state: RUN_STATE_COMPLETED, repoRoot: REPO_ROOT });
  assert.equal(first.removed, true);
  assert.equal(first.ok, true);
  assert.equal(fs.existsSync(run.path), false);
  const second = releaseRunRoot(run, { state: RUN_STATE_COMPLETED, repoRoot: REPO_ROOT });
  assert.equal(second.removed, false);
  assert.equal(second.alreadyAbsent, true);
  assert.equal(second.ok, true);
  const third = removeRunRoot(run.path, { repoRoot: REPO_ROOT });
  assert.equal(third.ok, true);
  assert.equal(third.alreadyAbsent, true);
});

test('RR08 ACTIVE, PAUSED, RESUMABLE and FAILED_RETAINED are never destroyed', () => {
  for (const state of CLEANUP_PROTECTED_STATES) {
    const run = allocate();
    try {
      if (state !== RUN_STATE_ACTIVE) markRunRootState(run.path, state, { reason: 'TEST' });
      const evaluation = evaluateRunRootRemoval(run.path, { repoRoot: REPO_ROOT });
      assert.equal(evaluation.eligible, false, state);
      assert.ok(evaluation.reasonCodes.includes(`RUN_ROOT_STATE_PROTECTED:${state}`), `${state}: ${evaluation.reasonCodes}`);
      const removal = removeRunRoot(run.path, { repoRoot: REPO_ROOT });
      assert.equal(removal.removed, false);
      assert.equal(fs.existsSync(run.path), true, `${state} must survive`);
      // Releasing INTO a protected state also retains.
      const release = releaseRunRoot(run, { state, repoRoot: REPO_ROOT });
      assert.equal(release.removed, false);
      assert.equal(release.retained, true);
      assert.equal(fs.existsSync(run.path), true);
    } finally { cleanup(run); }
  }
  assert.deepEqual([...CLEANUP_ELIGIBLE_STATES], [RUN_STATE_COMPLETED, RUN_STATE_FAILED_DISCARDED]);
  assert.deepEqual([...CLEANUP_PROTECTED_STATES], [RUN_STATE_ACTIVE, RUN_STATE_PAUSED, RUN_STATE_RESUMABLE, RUN_STATE_FAILED_RETAINED]);
});

test('RR09 a failure retains or discards according to the policy declared BEFORE the run', () => {
  const retained = [];
  assert.throws(() => withRunRoot({ ...allocateOptions('RETAIN') }, (run) => {
    retained.push(run.path);
    throw new Error('RR09_FORCED');
  }), /RR09_FORCED/);
  assert.equal(fs.existsSync(retained[0]), true);
  assert.equal(readRunRootManifest(retained[0]).manifest.state, RUN_STATE_FAILED_RETAINED);
  fs.rmSync(retained[0], { recursive: true, force: true });

  const discarded = [];
  assert.throws(() => withRunRoot({ ...allocateOptions('DISCARD') }, (run) => {
    discarded.push(run.path);
    throw new Error('RR09_FORCED');
  }), /RR09_FORCED/);
  assert.equal(fs.existsSync(discarded[0]), false);

  const ok = withRunRoot({ ...allocateOptions('DISCARD') }, (run) => run.path);
  assert.equal(ok.release.state, RUN_STATE_COMPLETED);
  assert.equal(ok.release.removed, true);
  assert.equal(fs.existsSync(ok.value), false);
});

function allocateOptions(failurePolicy) {
  return {
    repoRoot: REPO_ROOT, workUnitId: 'GATE16', phase: 'LIFECYCLE_TEST',
    purpose: 'RUN_ROOT_LIFECYCLE_TEST', consumer: 'gee-runtime-run-root-lifecycle.test.mjs', failurePolicy
  };
}

test('RR10 a root declaring it holds durable state is never eligible', () => {
  const run = allocate();
  try {
    markRunRootState(run.path, RUN_STATE_COMPLETED, { durableStateHeldHere: true });
    assert.equal(isCleanupEligible(readRunRootManifest(run.path).manifest), false);
    const removal = removeRunRoot(run.path, { repoRoot: REPO_ROOT });
    assert.equal(removal.removed, false);
    assert.ok(removal.reasonCodes.includes('RUN_ROOT_HOLDS_DURABLE_STATE'));
    assert.equal(fs.existsSync(run.path), true);
  } finally {
    markRunRootState(run.path, RUN_STATE_COMPLETED, { durableStateHeldHere: false });
    cleanup(run);
  }
});

/* -------------------------------------------------------------------------
 * Hostile deletion targets
 * ---------------------------------------------------------------------- */

test('RR11 deletion fails closed against every forbidden Windows path', () => {
  const forbidden = [
    [os.tmpdir(), 'RUN_ROOT_IS_TEMP_DIRECTORY'],
    [NAMESPACE_ROOT, 'RUN_ROOT_IS_NAMESPACE_PARENT'],
    [RUNS_ROOT, 'RUN_ROOT_IS_RUNS_NAMESPACE'],
    [path.parse(path.resolve(os.tmpdir())).root, 'RUN_ROOT_IS_FILESYSTEM_ROOT'],
    [REPO_ROOT, 'RUN_ROOT_INTERSECTS_REPOSITORY'],
    [path.join(REPO_ROOT, 'governance'), 'RUN_ROOT_INTERSECTS_REPOSITORY'],
    [path.dirname(os.tmpdir()), 'RUN_ROOT_NOT_DIRECT_CHILD_OF_RUNS_NAMESPACE'],
    [path.join(os.tmpdir(), 'some-foreign-dir'), 'RUN_ROOT_NOT_DIRECT_CHILD_OF_RUNS_NAMESPACE'],
    [path.join(RUNS_ROOT, 'a', 'nested'), 'RUN_ROOT_NOT_DIRECT_CHILD_OF_RUNS_NAMESPACE'],
    // Unnormalised traversal, passed as literal text. `path.join` would collapse
    // these before the function ever saw them, so building them with `join` here
    // would test nothing; the point is that a caller CAN hand over raw text.
    [`${RUNS_ROOT}${path.sep}..`, 'RUN_ROOT_TRAVERSAL_SEGMENT_PRESENT'],
    [`${RUNS_ROOT}${path.sep}..${path.sep}..`, 'RUN_ROOT_TRAVERSAL_SEGMENT_PRESENT'],
    [`${RUNS_ROOT}${path.sep}legit${path.sep}..${path.sep}..${path.sep}..`, 'RUN_ROOT_TRAVERSAL_SEGMENT_PRESENT'],
    [`${RUNS_ROOT}${path.sep}legit${path.sep}..${path.sep}legit`, 'RUN_ROOT_TRAVERSAL_SEGMENT_PRESENT']
  ];
  for (const [candidate, expectedCode] of forbidden) {
    const evaluation = evaluateRunRootRemoval(candidate, { repoRoot: REPO_ROOT });
    assert.equal(evaluation.eligible, false, candidate);
    assert.ok(evaluation.reasonCodes.includes(expectedCode), `${candidate} -> ${evaluation.reasonCodes}`);
    const removal = removeRunRoot(candidate, { repoRoot: REPO_ROOT });
    assert.equal(removal.removed, false, candidate);
  }
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.equal(removeRunRoot(bad, { repoRoot: REPO_ROOT }).removed, false);
  }
  // Everything above still exists.
  assert.equal(fs.existsSync(os.tmpdir()), true);
  assert.equal(fs.existsSync(REPO_ROOT), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance')), true);
});

test('RR12 an unmanifested or malformed root inside the namespace is not a candidate', () => {
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  const bare = path.join(RUNS_ROOT, `rr12-unmanifested-${process.pid}`);
  const malformed = path.join(RUNS_ROOT, `rr12-malformed-${process.pid}`);
  const foreignDoc = path.join(RUNS_ROOT, `rr12-foreign-doc-${process.pid}`);
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(malformed, { recursive: true });
  fs.mkdirSync(foreignDoc, { recursive: true });
  fs.writeFileSync(path.join(bare, 'payload.txt'), 'keep\n');
  fs.writeFileSync(path.join(malformed, RUN_ROOT_MANIFEST_FILE), 'not json{');
  fs.writeFileSync(path.join(foreignDoc, RUN_ROOT_MANIFEST_FILE), JSON.stringify({ document: 'SOMETHING_ELSE' }));
  try {
    assert.ok(evaluateRunRootRemoval(bare, { repoRoot: REPO_ROOT }).reasonCodes.includes('RUN_ROOT_MANIFEST_MISSING'));
    assert.ok(evaluateRunRootRemoval(malformed, { repoRoot: REPO_ROOT }).reasonCodes.includes('RUN_ROOT_MANIFEST_INVALID'));
    assert.ok(evaluateRunRootRemoval(foreignDoc, { repoRoot: REPO_ROOT }).reasonCodes.includes('RUN_ROOT_MANIFEST_IDENTITY_INVALID'));
    for (const target of [bare, malformed, foreignDoc]) {
      assert.equal(removeRunRoot(target, { repoRoot: REPO_ROOT }).removed, false);
      assert.equal(fs.existsSync(target), true);
    }
    assert.equal(fs.readFileSync(path.join(bare, 'payload.txt'), 'utf8'), 'keep\n');
    // They are also invisible to the observation listing, which only reports
    // well-formed manifests — so nothing can even enumerate them as candidates.
    const listed = listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).map((entry) => entry.runId);
    for (const target of [bare, malformed, foreignDoc]) assert.equal(listed.includes(path.basename(target)), false);
  } finally {
    for (const target of [bare, malformed, foreignDoc]) fs.rmSync(target, { recursive: true, force: true });
  }
});

test('RR13 a root belonging to another repository or another run is refused', () => {
  const run = allocate();
  try {
    markRunRootState(run.path, RUN_STATE_COMPLETED);
    const otherRepo = evaluateRunRootRemoval(run.path, { repoRoot: path.join(os.homedir(), 'some-other-checkout') });
    assert.equal(otherRepo.eligible, false);
    assert.ok(otherRepo.reasonCodes.includes('RUN_ROOT_FOREIGN_REPOSITORY'));
    const otherIdentity = evaluateRunRootRemoval(run.path, { repoRoot: REPO_ROOT, expectedRepositoryIdentity: 'deadbeefcafe' });
    assert.ok(otherIdentity.reasonCodes.includes('RUN_ROOT_FOREIGN_REPOSITORY_IDENTITY'));
    const otherRun = evaluateRunRootRemoval(run.path, { repoRoot: REPO_ROOT, expectedRunId: 'GATE16-OTHER-000000000000-1-aaaaaa' });
    assert.ok(otherRun.reasonCodes.includes('RUN_ROOT_UNEXPECTED_RUN_IDENTITY'));
    assert.equal(fs.existsSync(run.path), true);
  } finally { cleanup(run); }
});

test('RR14 a manifest renamed onto a different directory is refused', () => {
  const donor = allocate();
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  const impostor = path.join(RUNS_ROOT, `rr14-impostor-${process.pid}`);
  fs.mkdirSync(impostor, { recursive: true });
  try {
    // The manifest is valid and COMPLETED — but it names the donor, not this
    // directory, so identity fails even though every structural check passes.
    const manifest = { ...readRunRootManifest(donor.path).manifest, state: RUN_STATE_COMPLETED };
    fs.writeFileSync(path.join(impostor, RUN_ROOT_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    const evaluation = evaluateRunRootRemoval(impostor, { repoRoot: REPO_ROOT });
    assert.equal(evaluation.eligible, false);
    assert.ok(evaluation.reasonCodes.includes('RUN_ROOT_MANIFEST_IDENTITY_MISMATCH'));
    assert.equal(removeRunRoot(impostor, { repoRoot: REPO_ROOT }).removed, false);
    assert.equal(fs.existsSync(impostor), true);
  } finally {
    fs.rmSync(impostor, { recursive: true, force: true });
    cleanup(donor);
  }
});

test('RR15 a junction or symlink standing in for a run root cannot redirect the removal', (t) => {
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  const victim = path.join(os.tmpdir(), `rr15-victim-${process.pid}`);
  const link = path.join(RUNS_ROOT, `rr15-link-${process.pid}`);
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'precious.txt'), 'DO_NOT_DELETE\n');
  // A manifest inside the victim, reachable through the link, that claims the
  // link's own name and a removable state: the most favourable possible setup
  // for an escape.
  fs.writeFileSync(path.join(victim, RUN_ROOT_MANIFEST_FILE), JSON.stringify({
    document: RUN_ROOT_MANIFEST_DOCUMENT, schemaVersion: 1, engine: 'GEE_V1_RUN_ROOT_LIFECYCLE_R1',
    runId: path.basename(link), class: 'EPHEMERAL', repositoryRoot: path.resolve(REPO_ROOT),
    repositoryIdentity: repositoryIdentity(REPO_ROOT), state: RUN_STATE_COMPLETED, durableStateHeldHere: false
  }, null, 2));
  try {
    try {
      fs.symlinkSync(victim, link, 'junction');
    } catch {
      t.skip('this environment does not permit creating a junction');
      return;
    }
    const evaluation = evaluateRunRootRemoval(link, { repoRoot: REPO_ROOT });
    assert.equal(evaluation.eligible, false);
    assert.ok(
      evaluation.reasonCodes.some((code) => ['RUN_ROOT_IS_SYMLINK', 'RUN_ROOT_REPARSE_TARGET_DIFFERS', 'RUN_ROOT_REAL_PARENT_MISMATCH'].includes(code)),
      evaluation.reasonCodes.join(',')
    );
    assert.equal(removeRunRoot(link, { repoRoot: REPO_ROOT }).removed, false);
    assert.equal(fs.readFileSync(path.join(victim, 'precious.txt'), 'utf8'), 'DO_NOT_DELETE\n');
  } finally {
    try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* link may not exist */ }
    fs.rmSync(victim, { recursive: true, force: true });
  }
});

test('RR16 scratch cannot escape its run root', () => {
  const run = allocate();
  try {
    // Separators and drive letters are flattened into one safe segment, so the
    // result is always a direct child.
    for (const name of ['../escape', '..\\escape', '/etc', 'C:\\Windows', 'cas', 'r4-cas-ephemeral']) {
      const produced = run.scratch(name);
      assert.equal(path.dirname(produced), run.path, `${name} -> ${produced}`);
      assert.equal(produced.startsWith(run.path + path.sep), true);
      assert.equal(fs.statSync(produced).isDirectory(), true);
    }
    // Names that survive flattening AS traversal are refused rather than
    // silently rewritten into something the caller did not ask for.
    for (const name of ['.', '..']) {
      assert.throws(() => run.scratch(name), /RUN_ROOT_SCRATCH_ESCAPES_RUN_ROOT/, name);
    }
    // Nothing above created anything outside the run root.
    assert.equal(fs.existsSync(path.join(RUNS_ROOT, 'escape')), false);
    assert.equal(fs.existsSync(path.join(RUNS_ROOT, 'etc')), false);
  } finally { cleanup(run); }
});

test('RR16b containment is decided by path segment, not string prefix', () => {
  // A sibling whose name merely starts with the namespace name is outside it,
  // and a scratch name that merely starts with ".." is inside its run root.
  const sibling = `${RUNS_ROOT}-sibling`;
  const evaluation = evaluateRunRootRemoval(sibling, { repoRoot: REPO_ROOT });
  assert.equal(evaluation.eligible, false);
  assert.ok(evaluation.reasonCodes.includes('RUN_ROOT_NOT_DIRECT_CHILD_OF_RUNS_NAMESPACE'));
  // A durable root beside %TEMP%, not under it, resolves without the flag.
  const beside = resolveDurableLifecycleRoot({ explicitRoot: `${os.tmpdir()}-durable`, tempDir: os.tmpdir() });
  assert.equal(beside.ephemeral, false);
  assert.deepEqual(beside.reasonCodes, []);
});

/* -------------------------------------------------------------------------
 * Concurrency and durability
 * ---------------------------------------------------------------------- */

test('RR17 simultaneous identical runs stay isolated and clean up independently', () => {
  const runs = Array.from({ length: 8 }, () => allocate());
  try {
    const ids = new Set(runs.map((run) => run.runId));
    assert.equal(ids.size, runs.length);
    runs.forEach((run, index) => fs.writeFileSync(path.join(run.scratch('cas'), 'blob'), String(index)));
    runs.forEach((run, index) => assert.equal(fs.readFileSync(path.join(run.path, 'cas', 'blob'), 'utf8'), String(index)));
    // Releasing one leaves every other one untouched.
    const released = releaseRunRoot(runs[3], { state: RUN_STATE_COMPLETED, repoRoot: REPO_ROOT });
    assert.equal(released.removed, true);
    runs.forEach((run, index) => assert.equal(fs.existsSync(run.path), index !== 3, run.runId));
  } finally { runs.forEach(cleanup); }
});

test('RR18 an ACTIVE run of another process is not collectable by this one', () => {
  const run = allocate();
  try {
    markRunRootState(run.path, RUN_STATE_ACTIVE, { reason: 'STILL_RUNNING_ELSEWHERE' });
    const manifest = readRunRootManifest(run.path).manifest;
    fs.writeFileSync(path.join(run.path, RUN_ROOT_MANIFEST_FILE), JSON.stringify({ ...manifest, ownerPid: process.pid + 100000 }, null, 2));
    const removal = removeRunRoot(run.path, { repoRoot: REPO_ROOT });
    assert.equal(removal.removed, false);
    assert.ok(removal.reasonCodes.includes(`RUN_ROOT_STATE_PROTECTED:${RUN_STATE_ACTIVE}`));
    assert.equal(fs.existsSync(run.path), true);
  } finally { cleanup(run); }
});

test('RR19 durable R4/R6 state survives ephemeral cleanup across processes', () => {
  const durableRoot = path.join(resolveDurableLifecycleRoot().root, 'tests', `rr19-${process.pid}`);
  fs.mkdirSync(durableRoot, { recursive: true });
  const run = allocate();
  try {
    // A child process writes durable state and allocates its own ephemeral root.
    const source = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { RUN_STATE_COMPLETED, allocateRunRoot, releaseRunRoot } from ${JSON.stringify(new URL('../runtime/run-root-lifecycle.mjs', import.meta.url).href)};
      const durable = process.argv[1];
      fs.writeFileSync(path.join(durable, 'r4-cas.json'), '{"evidence":"durable"}');
      fs.writeFileSync(path.join(durable, 'r6-checkpoint.json'), '{"revision":"R0001"}');
      const child = allocateRunRoot({ repoRoot: ${JSON.stringify(REPO_ROOT)}, workUnitId: 'GATE16', phase: 'RR19_CHILD', purpose: 'TEST', consumer: 'rr19', failurePolicy: 'DISCARD' });
      fs.writeFileSync(path.join(child.scratch('cas'), 'ephemeral'), 'gone');
      const release = releaseRunRoot(child, { state: RUN_STATE_COMPLETED, repoRoot: ${JSON.stringify(REPO_ROOT)} });
      process.stdout.write(JSON.stringify({ childRoot: child.path, removed: release.removed }));
    `;
    const childResult = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, durableRoot], { cwd: REPO_ROOT, encoding: 'utf8' }));
    assert.equal(childResult.removed, true);
    assert.equal(fs.existsSync(childResult.childRoot), false);

    // This process releases its own root. Neither release touched the durable state.
    assert.equal(releaseRunRoot(run, { state: RUN_STATE_COMPLETED, repoRoot: REPO_ROOT }).removed, true);
    assert.equal(fs.readFileSync(path.join(durableRoot, 'r4-cas.json'), 'utf8'), '{"evidence":"durable"}');
    assert.equal(fs.readFileSync(path.join(durableRoot, 'r6-checkpoint.json'), 'utf8'), '{"revision":"R0001"}');
    // And the durable root is structurally outside every removal boundary.
    assert.equal(evaluateRunRootRemoval(durableRoot, { repoRoot: REPO_ROOT }).eligible, false);
  } finally {
    cleanup(run);
    fs.rmSync(durableRoot, { recursive: true, force: true });
  }
});

test('RR20 no API in this module collects roots by age, prefix or sweep', async () => {
  const source = fs.readFileSync(new URL('../runtime/run-root-lifecycle.mjs', import.meta.url), 'utf8');
  // The only rmSync in the module is the single bounded one inside removeRunRoot,
  // plus the unreachable self-cleanup of a malformed allocation.
  assert.equal((source.match(/fs\.rmSync/g) || []).length, 2);
  assert.equal(/mtime|birthtime|atime|olderThan|maxAge/.test(source), false);
  assert.equal(/readdirSync/.test(source.split('export function listOwnedRunRoots')[0]), false);
  // listOwnedRunRoots is observation only: it never removes anything.
  const before = listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length;
  const run = allocate();
  try {
    assert.equal(listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length, before + 1);
    assert.equal(fs.existsSync(run.path), true);
  } finally { cleanup(run); }
});

/* -------------------------------------------------------------------------
 * Live consumption
 * ---------------------------------------------------------------------- */

test('RR21 the real fast-path control plane allocates, consumes and releases a run root', async () => {
  const { runFastPathControlPlane } = await import('../../tools/gate-fast-path-control-plane.mjs');
  const before = listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length;
  const report = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE16', phase: 'READINESS' });

  // Allocated inside the canonical namespace, for this Gate and this repository.
  assert.equal(path.dirname(report.runtime.ephemeralRunRoot.path), RUNS_ROOT);
  assert.equal(report.runtime.ephemeralRunRoot.class, 'EPHEMERAL');
  // Actually consumed: the R4 CAS the chain used lived inside it.
  assert.equal(report.runtime.r4CasClass, 'EPHEMERAL');
  assert.equal(report.runtime.r4CasRoot.startsWith(report.runtime.ephemeralRunRoot.path + path.sep), true);
  // Released and removed, with nothing left behind.
  assert.equal(report.runtime.ephemeralRunRootRelease.state, RUN_STATE_COMPLETED);
  assert.equal(report.runtime.ephemeralRunRootRelease.removed, true);
  assert.equal(fs.existsSync(report.runtime.ephemeralRunRoot.path), false);
  assert.equal(listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length, before);
});

test('RR22 a control-plane run that throws still leaves no run root', async () => {
  const { runFastPathControlPlane } = await import('../../tools/gate-fast-path-control-plane.mjs');
  const before = listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length;
  // GATE13 carries pre-existing CONFLICTING_AUTHORITY:SEAL_INVALID debt at this
  // HEAD, which makes it a real throwing path rather than a simulated one.
  await assert.rejects(() => runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE13', phase: 'READINESS' }), (error) => {
    assert.equal(error.runRootRelease.state, RUN_STATE_FAILED_DISCARDED);
    assert.equal(error.runRootRelease.removed, true);
    return true;
  });
  assert.equal(listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length, before);
});

test('RR23 the preexecution reuse check releases its probe scratch', async () => {
  const { runPreexecutionReuseCheck } = await import('../../tools/gate-preexecution-reuse-check.mjs');
  const before = listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length;
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE16' });
  const release = report.geeLiveness?.ephemeralRunRootRelease ?? null;
  if (release) {
    assert.equal(release.state, RUN_STATE_COMPLETED);
    assert.ok(release.removed || release.alreadyAbsent);
  }
  assert.equal(listOwnedRunRoots({ repoRoot: REPO_ROOT, ownerPid: process.pid }).length, before);
});
