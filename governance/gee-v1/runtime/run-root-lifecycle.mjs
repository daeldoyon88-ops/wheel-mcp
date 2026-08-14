/**
 * GEE V1 RUN_ROOT lifecycle — the canonical separation between EPHEMERAL
 * execution scratch and DURABLE lifecycle state.
 *
 * WHY THIS EXISTS. Both classes of state were being written to the same place:
 * `os.tmpdir()`, flat, one anonymous `mkdtemp` per call site, each with its own
 * ad-hoc cleanup or none at all. That has two independent failure modes, and
 * only one of them is visible:
 *
 *   1. scratch that is never removed accumulates forever (visible, eventually)
 *   2. durable R4/R6 state that lives in a disposable directory can be erased
 *      by anything that decides %TEMP% is fair game (invisible, until a resume
 *      silently restarts from zero)
 *
 * The second is the dangerous one, and no amount of careful cleanup fixes it —
 * it is fixed by putting the two classes in different places and making the
 * boundary structural rather than remembered.
 *
 *     EPHEMERAL   %TEMP%/wheel-gee/runs/<run-id>/       disposable, per-run
 *     DURABLE     <lifecycle root>/                     survives run cleanup
 *
 * The durable root is resolved, never guessed: an explicit caller argument wins,
 * then the declared environment override, then a stable user-scoped location
 * that is NOT under %TEMP%. Resolution fails closed if the answer would land
 * inside the ephemeral namespace, because that would silently reintroduce
 * exactly the failure this file exists to remove.
 *
 * DELETION IS THE HOSTILE SURFACE, so it is bounded rather than filtered.
 * `removeRunRoot` deletes ONE exact path and only after every one of the
 * following is independently true: the path's parent is exactly the runs
 * namespace; the path is not the namespace, %TEMP%, a drive root or the
 * repository; nothing on the way to it is a symlink/junction/reparse point; a
 * well-formed manifest inside it names that exact run and this exact
 * repository; and the manifest's state says the run is finished. There is no
 * glob, no wildcard, no prefix sweep, no age-based collection, and no recursive
 * scan of %TEMP% — an unmanifested historical root is not a cleanup candidate
 * because nothing ever enumerates candidates in the first place.
 *
 * THE STATE MACHINE IS THE CONSENT MODEL. ACTIVE, PAUSED, RESUMABLE and
 * FAILED_RETAINED are all "someone may still need this", and none of them is a
 * removal target. Only a run that was explicitly finished — COMPLETED, or
 * FAILED_DISCARDED where the caller declared up front that failure scratch has
 * no diagnostic value — is eligible. "Not silently destroyed" is enforced by
 * requiring the declaration to be written into the manifest before the removal
 * is even considered.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUN_ROOT_LIFECYCLE_VERSION = 'GEE_V1_RUN_ROOT_LIFECYCLE_R1';
export const RUN_ROOT_MANIFEST_DOCUMENT = 'GEE_EPHEMERAL_RUN_ROOT_MANIFEST';
export const RUN_ROOT_MANIFEST_FILE = 'run-root-manifest.json';

/** The single namespace segment that marks a temp directory as ours. */
export const EPHEMERAL_NAMESPACE_SEGMENT = 'wheel-gee';
export const EPHEMERAL_RUNS_SEGMENT = 'runs';
export const DURABLE_LIFECYCLE_SEGMENT = 'lifecycle';
export const DURABLE_LIFECYCLE_ENV_VAR = 'WHEEL_GEE_LIFECYCLE_ROOT';

/**
 * Lifecycle states of one ephemeral run root.
 *
 * ACTIVE           the run is executing
 * COMPLETED        the run finished; its scratch is finished with it
 * PAUSED           deliberately suspended, scratch still meaningful
 * RESUMABLE        interrupted, expected to be resumed from
 * FAILED_RETAINED  failed, scratch kept on purpose for diagnosis
 * FAILED_DISCARDED failed under a caller policy that declared, BEFORE the run,
 *                  that failure scratch carries no diagnostic value
 */
export const RUN_STATE_ACTIVE = 'ACTIVE';
export const RUN_STATE_COMPLETED = 'COMPLETED';
export const RUN_STATE_PAUSED = 'PAUSED';
export const RUN_STATE_RESUMABLE = 'RESUMABLE';
export const RUN_STATE_FAILED_RETAINED = 'FAILED_RETAINED';
export const RUN_STATE_FAILED_DISCARDED = 'FAILED_DISCARDED';

export const RUN_STATES = Object.freeze([
  RUN_STATE_ACTIVE, RUN_STATE_COMPLETED, RUN_STATE_PAUSED,
  RUN_STATE_RESUMABLE, RUN_STATE_FAILED_RETAINED, RUN_STATE_FAILED_DISCARDED
]);

/** The only two states whose scratch may be removed. Everything else is kept. */
export const CLEANUP_ELIGIBLE_STATES = Object.freeze([RUN_STATE_COMPLETED, RUN_STATE_FAILED_DISCARDED]);

/** States that assert someone may still need the scratch. */
export const CLEANUP_PROTECTED_STATES = Object.freeze([
  RUN_STATE_ACTIVE, RUN_STATE_PAUSED, RUN_STATE_RESUMABLE, RUN_STATE_FAILED_RETAINED
]);

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const SAFE_LABEL_RE = /[^A-Za-z0-9._-]+/g;

function sha256Hex(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

/**
 * Path identity for comparison.
 *
 * Windows compares paths case-insensitively, and a guard that missed that would
 * accept `c:\users\...\temp` as "not %TEMP%". The comparison key is therefore
 * case-folded on win32 and left exact elsewhere.
 */
function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) { return pathKey(a) === pathKey(b); }

/**
 * Containment by path SEGMENT, not by string prefix.
 *
 * `startsWith('..')` would call `Temp2` a child of `Temp` and `..escape` an
 * escape from its own parent — both wrong, and wrong in opposite directions:
 * one widens a boundary, the other narrows it. Only a leading `..` SEGMENT
 * means "outside".
 */
function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(/[\\/]/)[0] !== '..';
}

function safeLabel(value, fallback, maxLength = 32) {
  const text = String(value ?? '').normalize('NFC').replace(SAFE_LABEL_RE, '_').replace(/^_+|_+$/g, '');
  return (text || fallback).slice(0, maxLength);
}

/* -------------------------------------------------------------------------
 * Namespace resolution
 * ---------------------------------------------------------------------- */

/** `%TEMP%/wheel-gee` — the parent of the runs namespace. Never a delete target. */
export function ephemeralNamespaceRoot({ tempDir = os.tmpdir() } = {}) {
  return path.resolve(tempDir, EPHEMERAL_NAMESPACE_SEGMENT);
}

/** `%TEMP%/wheel-gee/runs` — the ONLY directory a run root may be a child of. */
export function ephemeralRunsRoot({ tempDir = os.tmpdir() } = {}) {
  return path.join(ephemeralNamespaceRoot({ tempDir }), EPHEMERAL_RUNS_SEGMENT);
}

/**
 * The durable lifecycle root: R4 CAS and R6 checkpoint/lifecycle state.
 *
 * Precedence is explicit-argument, then declared environment override, then a
 * stable user-scoped default. The default is deliberately platform-specific
 * rather than a hardcoded string at the call sites, and %TEMP% is refused at
 * every level: durable state that lives in a disposable directory is the exact
 * defect this resolver exists to make unrepresentable.
 */
export function resolveDurableLifecycleRoot({
  explicitRoot = null,
  env = process.env,
  platform = process.platform,
  tempDir = os.tmpdir(),
  homeDir = os.homedir()
} = {}) {
  // An EXPLICIT argument is the caller's own choice and is honoured even when it
  // lands under %TEMP% — an isolated harness legitimately wants a throwaway
  // durable store, and refusing it would only push callers back to building
  // paths by hand. It is flagged rather than trusted, so a caller that
  // accidentally made real lifecycle state disposable can see that it did.
  // The ENV override and the DEFAULT are system choices and fail closed: those
  // are the paths a real Gate resumes from.
  if (typeof explicitRoot === 'string' && explicitRoot.length > 0) {
    const root = path.resolve(explicitRoot);
    const ephemeral = isInside(root, tempDir);
    return {
      root,
      source: 'EXPLICIT_ARGUMENT',
      ephemeral,
      reasonCodes: ephemeral ? ['DURABLE_ROOT_SUPPLIED_INSIDE_EPHEMERAL_TEMP'] : []
    };
  }
  const fromEnv = env?.[DURABLE_LIFECYCLE_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return assertDurableRootOutsideEphemeral({ root: path.resolve(fromEnv), source: `ENV:${DURABLE_LIFECYCLE_ENV_VAR}`, tempDir });
  }
  let base;
  let source;
  if (platform === 'win32') {
    base = env?.LOCALAPPDATA ? path.resolve(env.LOCALAPPDATA) : path.join(path.resolve(homeDir), 'AppData', 'Local');
    source = env?.LOCALAPPDATA ? 'DEFAULT:LOCALAPPDATA' : 'DEFAULT:HOME_APPDATA_LOCAL';
  } else if (env?.XDG_STATE_HOME) {
    base = path.resolve(env.XDG_STATE_HOME);
    source = 'DEFAULT:XDG_STATE_HOME';
  } else {
    base = path.join(path.resolve(homeDir), '.local', 'state');
    source = 'DEFAULT:HOME_LOCAL_STATE';
  }
  const root = path.join(base, EPHEMERAL_NAMESPACE_SEGMENT, DURABLE_LIFECYCLE_SEGMENT);
  return assertDurableRootOutsideEphemeral({ root, source, tempDir });
}

function assertDurableRootOutsideEphemeral({ root, source, tempDir }) {
  if (isInside(root, tempDir)) throw new Error(`DURABLE_LIFECYCLE_ROOT_INSIDE_EPHEMERAL_TEMP:${root}`);
  return { root, source, ephemeral: false, reasonCodes: [] };
}

/* -------------------------------------------------------------------------
 * Allocation
 * ---------------------------------------------------------------------- */

/**
 * Stable identity of a repository checkout, used so two checkouts of the same
 * project never share or delete each other's run roots.
 */
export function repositoryIdentity(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('RUN_ROOT_REPO_ROOT_REQUIRED');
  return sha256Hex(pathKey(repoRoot)).slice(0, 12);
}

/**
 * Allocates ONE ephemeral run root for one governed execution.
 *
 * The readable stem carries the identity the lifecycle already has — work unit,
 * phase, repository, process — so a leftover root can be attributed by eye. The
 * only thing invented is the attempt nonce, and it is the minimum one that
 * works: `mkdtemp`'s own six characters, which the OS guarantees unique against
 * every concurrent caller without a lock, a registry or a clock.
 */
export function allocateRunRoot({
  repoRoot,
  workUnitId,
  phase = 'UNSPECIFIED',
  purpose = 'GOVERNED_EXECUTION',
  consumer,
  missionRevisionId = null,
  tempDir = os.tmpdir(),
  now = new Date(),
  failurePolicy = 'RETAIN'
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('RUN_ROOT_REPO_ROOT_REQUIRED');
  if (typeof consumer !== 'string' || !consumer) throw new Error('RUN_ROOT_CONSUMER_REQUIRED');
  if (!['RETAIN', 'DISCARD'].includes(failurePolicy)) throw new Error(`RUN_ROOT_FAILURE_POLICY_INVALID:${String(failurePolicy)}`);
  const runsRoot = ephemeralRunsRoot({ tempDir });
  fs.mkdirSync(runsRoot, { recursive: true });
  const repoId = repositoryIdentity(repoRoot);
  const stem = `${safeLabel(workUnitId, 'work-unit', 24)}-${safeLabel(phase, 'phase', 20)}-${repoId}-${process.pid}-`;
  const runRoot = fs.mkdtempSync(path.join(runsRoot, stem));
  const runId = path.basename(runRoot);
  if (!RUN_ID_RE.test(runId)) {
    // Unreachable with the sanitised stem above; if it ever is reached the root
    // is removed immediately rather than left as an unattributable directory.
    fs.rmSync(runRoot, { recursive: true, force: true });
    throw new Error(`RUN_ROOT_ID_INVALID:${runId}`);
  }
  const manifest = {
    document: RUN_ROOT_MANIFEST_DOCUMENT,
    schemaVersion: 1,
    engine: RUN_ROOT_LIFECYCLE_VERSION,
    runId,
    class: 'EPHEMERAL',
    purpose,
    consumer,
    workUnitId: workUnitId ?? null,
    phase,
    missionRevisionId,
    repositoryRoot: path.resolve(repoRoot),
    repositoryIdentity: repoId,
    ownerPid: process.pid,
    createdAt: now.toISOString(),
    state: RUN_STATE_ACTIVE,
    stateReason: 'ALLOCATED',
    stateChangedAt: now.toISOString(),
    failurePolicy,
    durableStateHeldHere: false
  };
  writeManifest(runRoot, manifest);
  return {
    runId,
    path: runRoot,
    manifestPath: path.join(runRoot, RUN_ROOT_MANIFEST_FILE),
    manifest,
    runsRoot,
    /** A named subdirectory of this run root. Never escapes it. */
    scratch(name) {
      const label = safeLabel(name, 'scratch', 48);
      const target = path.join(runRoot, label);
      if (!isInside(target, runRoot) || samePath(target, runRoot)) throw new Error(`RUN_ROOT_SCRATCH_ESCAPES_RUN_ROOT:${String(name)}`);
      fs.mkdirSync(target, { recursive: true });
      return target;
    }
  };
}

function writeManifest(runRoot, manifest) {
  fs.writeFileSync(path.join(runRoot, RUN_ROOT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function readRunRootManifest(runRoot) {
  const file = path.join(path.resolve(runRoot), RUN_ROOT_MANIFEST_FILE);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { manifest: null, reason: fs.existsSync(file) ? 'RUN_ROOT_MANIFEST_INVALID' : 'RUN_ROOT_MANIFEST_MISSING' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { manifest: null, reason: 'RUN_ROOT_MANIFEST_INVALID' };
  if (parsed.document !== RUN_ROOT_MANIFEST_DOCUMENT || parsed.engine !== RUN_ROOT_LIFECYCLE_VERSION) {
    return { manifest: null, reason: 'RUN_ROOT_MANIFEST_IDENTITY_INVALID' };
  }
  if (!RUN_STATES.includes(parsed.state)) return { manifest: null, reason: 'RUN_ROOT_MANIFEST_STATE_INVALID' };
  if (typeof parsed.runId !== 'string' || !RUN_ID_RE.test(parsed.runId)) return { manifest: null, reason: 'RUN_ROOT_MANIFEST_RUN_ID_INVALID' };
  return { manifest: parsed, reason: null };
}

/**
 * Records a state transition in the manifest.
 *
 * This is the ONLY way a run root becomes eligible for removal, and it writes
 * the declaration to disk before anything acts on it. That is what makes
 * "eligible" an audited fact rather than an in-memory assumption that a crashed
 * process takes with it.
 */
export function markRunRootState(runRoot, state, { reason = null, now = new Date(), durableStateHeldHere = null } = {}) {
  if (!RUN_STATES.includes(state)) throw new Error(`RUN_ROOT_STATE_INVALID:${String(state)}`);
  const { manifest, reason: readReason } = readRunRootManifest(runRoot);
  if (!manifest) throw new Error(`RUN_ROOT_MANIFEST_UNUSABLE:${readReason}`);
  const next = {
    ...manifest,
    state,
    stateReason: reason ?? state,
    stateChangedAt: now.toISOString(),
    ...(durableStateHeldHere === null ? {} : { durableStateHeldHere: Boolean(durableStateHeldHere) })
  };
  writeManifest(path.resolve(runRoot), next);
  return next;
}

export function isCleanupEligible(manifest) {
  return Boolean(manifest) && CLEANUP_ELIGIBLE_STATES.includes(manifest.state) && manifest.durableStateHeldHere !== true;
}

/* -------------------------------------------------------------------------
 * Bounded removal
 * ---------------------------------------------------------------------- */

/**
 * Every reason a removal is refused. Each one is checked independently; the
 * function returns the complete set rather than the first, so a hostile path
 * cannot pass by satisfying whichever check happened to run first.
 */
export function evaluateRunRootRemoval(candidate, {
  repoRoot = null,
  tempDir = os.tmpdir(),
  expectedRunId = null,
  expectedRepositoryIdentity = null
} = {}) {
  const reasonCodes = [];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { eligible: false, absent: false, resolved: null, manifest: null, reasonCodes: ['RUN_ROOT_PATH_INVALID'] };
  }
  const resolved = path.resolve(candidate);
  const runsRoot = ephemeralRunsRoot({ tempDir });
  const namespaceRoot = ephemeralNamespaceRoot({ tempDir });
  const filesystemRoot = path.parse(resolved).root;

  // Structural position. A run root is a DIRECT child of the runs namespace and
  // nothing else — which alone rules out %TEMP% itself, the wheel-gee parent,
  // any nested path, any sibling namespace and every foreign temp entry.
  if (!samePath(path.dirname(resolved), runsRoot)) reasonCodes.push('RUN_ROOT_NOT_DIRECT_CHILD_OF_RUNS_NAMESPACE');
  for (const [forbidden, code] of [
    [runsRoot, 'RUN_ROOT_IS_RUNS_NAMESPACE'],
    [namespaceRoot, 'RUN_ROOT_IS_NAMESPACE_PARENT'],
    [tempDir, 'RUN_ROOT_IS_TEMP_DIRECTORY'],
    [filesystemRoot, 'RUN_ROOT_IS_FILESYSTEM_ROOT']
  ]) {
    if (samePath(resolved, forbidden)) reasonCodes.push(code);
  }
  if (repoRoot && (samePath(resolved, repoRoot) || isInside(repoRoot, resolved) || isInside(resolved, repoRoot))) {
    reasonCodes.push('RUN_ROOT_INTERSECTS_REPOSITORY');
  }
  // Traversal: the literal text must already be the normalised path. `..` that
  // happens to land back inside is still refused — a caller that needs this
  // path can name it directly.
  const basename = path.basename(resolved);
  if (basename === '' || basename === '.' || basename === '..') reasonCodes.push('RUN_ROOT_BASENAME_INVALID');
  if (String(candidate).split(/[\\/]+/).includes('..')) reasonCodes.push('RUN_ROOT_TRAVERSAL_SEGMENT_PRESENT');
  if (!RUN_ID_RE.test(basename)) reasonCodes.push('RUN_ROOT_ID_INVALID');

  let stat = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    // Absent is the idempotent case: a second release of the same root is a
    // no-op success, not a failure and not a reason to look elsewhere.
    return { eligible: false, absent: true, resolved, manifest: null, reasonCodes: [...new Set([...reasonCodes, 'RUN_ROOT_ALREADY_ABSENT'])] };
  }
  if (stat.isSymbolicLink()) reasonCodes.push('RUN_ROOT_IS_SYMLINK');
  if (!stat.isDirectory()) reasonCodes.push('RUN_ROOT_NOT_A_DIRECTORY');

  // Reparse/junction escape: the real path of the candidate AND of the runs
  // namespace must both be what they claim, and the candidate must still be a
  // direct child after resolution. A junction placed at the run-root name would
  // otherwise let a removal reach an arbitrary directory.
  try {
    const realCandidate = fs.realpathSync(resolved);
    if (!samePath(realCandidate, resolved)) reasonCodes.push('RUN_ROOT_REPARSE_TARGET_DIFFERS');
    const realRunsRoot = fs.realpathSync(runsRoot);
    if (!samePath(path.dirname(realCandidate), realRunsRoot)) reasonCodes.push('RUN_ROOT_REAL_PARENT_MISMATCH');
  } catch {
    reasonCodes.push('RUN_ROOT_REALPATH_UNRESOLVABLE');
  }

  const { manifest, reason: manifestReason } = readRunRootManifest(resolved);
  if (!manifest) {
    reasonCodes.push(manifestReason);
    return { eligible: false, absent: false, resolved, manifest: null, reasonCodes: [...new Set(reasonCodes)] };
  }
  if (manifest.runId !== basename) reasonCodes.push('RUN_ROOT_MANIFEST_IDENTITY_MISMATCH');
  if (manifest.class !== 'EPHEMERAL') reasonCodes.push('RUN_ROOT_NOT_EPHEMERAL_CLASS');
  if (expectedRunId && manifest.runId !== expectedRunId) reasonCodes.push('RUN_ROOT_UNEXPECTED_RUN_IDENTITY');
  if (repoRoot && !samePath(manifest.repositoryRoot ?? '', repoRoot)) reasonCodes.push('RUN_ROOT_FOREIGN_REPOSITORY');
  if (expectedRepositoryIdentity && manifest.repositoryIdentity !== expectedRepositoryIdentity) reasonCodes.push('RUN_ROOT_FOREIGN_REPOSITORY_IDENTITY');
  if (manifest.durableStateHeldHere === true) reasonCodes.push('RUN_ROOT_HOLDS_DURABLE_STATE');
  if (CLEANUP_PROTECTED_STATES.includes(manifest.state)) reasonCodes.push(`RUN_ROOT_STATE_PROTECTED:${manifest.state}`);
  else if (!CLEANUP_ELIGIBLE_STATES.includes(manifest.state)) reasonCodes.push(`RUN_ROOT_STATE_NOT_ELIGIBLE:${manifest.state}`);

  return { eligible: reasonCodes.length === 0, absent: false, resolved, manifest, reasonCodes: [...new Set(reasonCodes)] };
}

/**
 * Removes exactly one eligible run root. Idempotent, bounded, never widened.
 *
 * A failed removal is reported, never retried against a broader target — the
 * one thing a cleanup routine must never do when it cannot delete a directory
 * is try its parent.
 */
export function removeRunRoot(candidate, options = {}) {
  const evaluation = evaluateRunRootRemoval(candidate, options);
  if (evaluation.absent) return { removed: false, alreadyAbsent: true, ok: true, reasonCodes: evaluation.reasonCodes, resolved: evaluation.resolved };
  if (!evaluation.eligible) return { removed: false, alreadyAbsent: false, ok: false, reasonCodes: evaluation.reasonCodes, resolved: evaluation.resolved };
  try {
    fs.rmSync(evaluation.resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
  } catch (error) {
    return { removed: false, alreadyAbsent: false, ok: false, reasonCodes: [`RUN_ROOT_REMOVAL_FAILED:${error.code || 'UNKNOWN'}`], resolved: evaluation.resolved };
  }
  return { removed: true, alreadyAbsent: false, ok: true, reasonCodes: [], resolved: evaluation.resolved };
}

/**
 * Finalises a run: writes the terminal state, then removes the scratch if that
 * state makes it eligible. The manifest write happens first on purpose, so a
 * process that dies mid-finalisation leaves a root whose recorded state already
 * explains what should happen to it.
 */
export function releaseRunRoot(run, {
  state = RUN_STATE_COMPLETED,
  reason = null,
  repoRoot = null,
  tempDir = os.tmpdir(),
  now = new Date()
} = {}) {
  const runRoot = typeof run === 'string' ? run : run?.path;
  const runId = typeof run === 'string' ? path.basename(path.resolve(run)) : run?.runId;
  if (typeof runRoot !== 'string' || !runRoot) throw new Error('RUN_ROOT_REQUIRED');
  if (!fs.existsSync(runRoot)) {
    return { runId, path: path.resolve(runRoot), state, removed: false, alreadyAbsent: true, retained: false, ok: true, reasonCodes: ['RUN_ROOT_ALREADY_ABSENT'] };
  }
  let manifest = null;
  try {
    manifest = markRunRootState(runRoot, state, { reason, now });
  } catch (error) {
    return { runId, path: path.resolve(runRoot), state, removed: false, alreadyAbsent: false, retained: true, ok: false, reasonCodes: [`RUN_ROOT_STATE_NOT_RECORDED:${error.message}`] };
  }
  if (!isCleanupEligible(manifest)) {
    return { runId, path: path.resolve(runRoot), state: manifest.state, removed: false, alreadyAbsent: false, retained: true, ok: true, reasonCodes: [`RUN_ROOT_RETAINED_BY_STATE:${manifest.state}`] };
  }
  const removal = removeRunRoot(runRoot, { repoRoot: repoRoot ?? manifest.repositoryRoot, tempDir, expectedRunId: manifest.runId });
  return {
    runId, path: path.resolve(runRoot), state: manifest.state,
    removed: removal.removed, alreadyAbsent: removal.alreadyAbsent,
    retained: !removal.removed && !removal.alreadyAbsent, ok: removal.ok, reasonCodes: removal.reasonCodes
  };
}

/**
 * Allocate → run → finalise, with the terminal state chosen by what happened.
 *
 * Success is COMPLETED and the scratch goes. Failure follows the failure policy
 * the caller declared at allocation time: RETAIN keeps the root as
 * FAILED_RETAINED for diagnosis, DISCARD records FAILED_DISCARDED and removes
 * it. Either way the decision was made before the failure, and it is written
 * into the manifest — a failure never quietly decides its own fate.
 */
export function withRunRoot(options, callback) {
  const run = allocateRunRoot(options);
  const finalize = (state, reason) => releaseRunRoot(run, {
    state, reason, repoRoot: options.repoRoot, tempDir: options.tempDir ?? os.tmpdir()
  });
  let result;
  try {
    result = callback(run);
  } catch (error) {
    const failureState = run.manifest.failurePolicy === 'DISCARD' ? RUN_STATE_FAILED_DISCARDED : RUN_STATE_FAILED_RETAINED;
    const release = finalize(failureState, `EXECUTION_THREW:${error?.message ?? 'UNKNOWN'}`);
    error.runRootRelease = release;
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => ({ value, release: finalize(RUN_STATE_COMPLETED, 'EXECUTION_COMPLETED') }),
      (error) => {
        const failureState = run.manifest.failurePolicy === 'DISCARD' ? RUN_STATE_FAILED_DISCARDED : RUN_STATE_FAILED_RETAINED;
        error.runRootRelease = finalize(failureState, `EXECUTION_REJECTED:${error?.message ?? 'UNKNOWN'}`);
        throw error;
      }
    );
  }
  return { value: result, release: finalize(RUN_STATE_COMPLETED, 'EXECUTION_COMPLETED') };
}

/**
 * Run roots this repository owns, for observation only.
 *
 * Nothing in this module consumes the listing to decide what to delete — that
 * would be the prefix sweep this design refuses. It exists so a test or an
 * operator can MEASURE leakage, which is a different act from collecting it.
 *
 * `ownerPid` narrows the listing to one process. Measuring leakage repository-
 * wide is only meaningful when nothing else is running; concurrent test files,
 * or a real second mission, legitimately hold roots of their own, and counting
 * those as leakage would make a correct process look wrong.
 */
export function listOwnedRunRoots({ repoRoot = null, ownerPid = null, tempDir = os.tmpdir() } = {}) {
  const runsRoot = ephemeralRunsRoot({ tempDir });
  let entries = [];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const wantedIdentity = repoRoot ? repositoryIdentity(repoRoot) : null;
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(runsRoot, entry.name);
      const { manifest } = readRunRootManifest(full);
      return { runId: entry.name, path: full, manifest };
    })
    .filter((entry) => entry.manifest !== null)
    .filter((entry) => wantedIdentity === null || entry.manifest.repositoryIdentity === wantedIdentity)
    .filter((entry) => ownerPid === null || entry.manifest.ownerPid === ownerPid)
    .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
}
