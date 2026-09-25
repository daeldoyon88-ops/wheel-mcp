/**
 * GATE26 FULL CHECKPOINT V1 — durable, resumable paged materialization (R0003 PREBUILD).
 *
 * Same discipline as the GEE V1 R6 checkpoint store (governance/gee-v1/recovery/
 * checkpoint-store.mjs): immutable revisions that are never opened for writing once
 * they exist, a hash chain from each revision to its predecessor, and strict reading
 * where a damaged revision is REPORTED and never skipped in favour of an older one.
 *
 * What is specific to FULL paging:
 *   - one revision per committed page PAIR, and revision N is page N, so the committed
 *     frontier is simply the length of a valid chain;
 *   - a revision is written to a temp file, fsynced, then published with an exclusive
 *     hard link, so a killed process leaves either no revision or a whole one;
 *   - RUN_IDENTITY binds the exact input, code, contract, plan and producer identities.
 *     Resuming under any different identity fails closed instead of silently starting
 *     a new run from zero next to the old one;
 *   - one writer at a time: a live lock refuses a parallel run, a lock whose owner
 *     process is gone is recovered and reported.
 *
 * The checkpoint root must lie outside the repository.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { PUBLISH_TEMP_SUFFIX, publicationTempPath } from '../../../tools/durable-write.mjs';
import { workUnitDirectoryName } from '../../../gee-v1/recovery/checkpoint-store.mjs';
import { assertClosedKeys, failClosed } from './ensemble-identity-v1.mjs';

export const FULL_CHECKPOINT_SCHEMA_V1 = 'GATE26_FULL_CHECKPOINT_V1';
export const FULL_CHECKPOINT_WORK_UNIT_V1 = 'GATE26_FULL_PAGED_MATERIALIZATION_V1';
export const RUN_IDENTITY_FILE_V1 = 'RUN_IDENTITY.json';
export const FINAL_REVISION_FILE_V1 = 'FINAL.json';
export const LOCK_FILE_V1 = 'RUN.lock';
export const REVISION_FIELDS_V1 = Object.freeze([
  'schema', 'runId', 'revision', 'revisionOrdinal', 'previousRevisionSha256', 'pair', 'revisionSha256',
]);
export const RUN_IDENTITY_FIELDS_V1 = Object.freeze(['inputIdentity', 'codeIdentity', 'contractIdentity', 'planIdentity', 'producerIdentity']);
const PAIR_FIELDS = Object.freeze(['pageNumber', 'ensemble', 'provenance']);
const DIGEST_FIELDS = Object.freeze(['sha256', 'byteLength']);
const FINAL_FIELDS = Object.freeze(['schema', 'runId', 'kind', 'committedPairCount', 'lastRevisionSha256', 'manifest', 'finalSha256']);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Every artifact whose bytes decide FULL page bytes. A different set is a different run.
 *
 * WHY THE REAL PRODUCER AND ITS TWO DOCUMENTS BELONG HERE. Run identity exists so a
 * resume cannot continue a run that would now produce different bytes. Before Phase D
 * the only producer that could reach this boundary was the synthetic PREBUILD one,
 * whose bytes live entirely in modules already listed. The real production producer
 * changes that: its selection logic lives in its own module, and two versioned
 * documents decide what it will do — the producer identity binding fixes which
 * dependency bytes it is allowed to execute over, and the resource budget fixes the
 * thresholds at which it stops. A run resumed after either document changed is not
 * the same run, so both are bound here rather than trusted to stay still.
 */
export const FULL_CODE_IDENTITY_PATHS_V1 = Object.freeze([
  'governance/gates/GATE26/implementation/full-query-cohort-v1.mjs',
  'governance/gates/GATE26/implementation/full-paged-materializer-v1.mjs',
  'governance/gates/GATE26/implementation/full-checkpoint-v1.mjs',
  'governance/gates/GATE26/implementation/full-production-producer-v1.mjs',
  'governance/gates/GATE26/implementation/consumption-boundary-v1.mjs',
  'governance/gates/GATE26/implementation/predictive-ensemble-engine-v1.mjs',
  'governance/gates/GATE26/implementation/ensemble-provenance-v1.mjs',
  'governance/gates/GATE26/implementation/ensemble-identity-v1.mjs',
  'governance/gates/GATE26/implementation/ensemble-record-v1.mjs',
  'governance/gates/GATE26/implementation/combination-policy-v1.mjs',
  // R0006: the V2 successors are the documents the real producer now executes under.
  'governance/gates/GATE26/contracts/GATE26_FULL_PRODUCTION_PRODUCER_V2.json',
  'governance/gates/GATE26/contracts/GATE26_FULL_RESOURCE_BUDGET_V2.json',
  'governance/tools/canonical-json.mjs',
  'governance/tools/durable-write.mjs',
]);

export function computeCodeIdentity({ root }) {
  const files = FULL_CODE_IDENTITY_PATHS_V1.map((file) => {
    // A missing member is a governed failure, not an ENOENT stack: the set is the
    // run's identity, so an absent member means identity cannot be computed at all.
    let bytes;
    try { bytes = fs.readFileSync(path.resolve(root, file)); }
    catch (cause) { failClosed('FULL_CODE_IDENTITY_MEMBER_ABSENT', { path: file, cause: cause.code ?? cause.message }); }
    return { path: file, sha256: sha256Bytes(bytes) };
  });
  return Object.freeze({ sha256: sha256Canonical(files), files: Object.freeze(files) });
}

export const checkpointRevisionName = (ordinal) => `R${String(ordinal).padStart(4, '0')}`;

/* -------------------------------------------------------------- containment */

const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

export function isPathInside(parent, child) {
  const relative = path.relative(comparable(path.resolve(parent)), comparable(path.resolve(child)));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Real path of `target`, resolving links through its nearest existing ancestor. */
export function realPathOf(target) {
  let existing = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...tail);
}

/** True when `target` lies inside `root`, lexically or once links are resolved. */
export function resolvesInside(root, target) {
  return isPathInside(root, target) || isPathInside(realPathOf(root), realPathOf(target));
}

/* ------------------------------------------------------------ atomic publish */

function syncDirectory(directory) {
  let handle = null;
  try { handle = fs.openSync(directory, 'r'); fs.fsyncSync(handle); } catch { /* platform does not permit directory fsync */ }
  finally { if (handle !== null) { try { fs.closeSync(handle); } catch { /* already closed */ } } }
}

/** Temp write + fsync + exclusive hard link: the target appears whole or not at all, and never twice. */
function publishExclusive(target, bytes) {
  const temporary = publicationTempPath(target);
  let handle = null;
  try {
    handle = fs.openSync(temporary, 'w');
    fs.writeSync(handle, bytes, 0, bytes.length, 0);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch { /* closed by the failure */ } }
  }
  try {
    fs.linkSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (error.code === 'EEXIST') failClosed('CHECKPOINT_REVISION_EXISTS', { file: path.basename(target) });
    throw error;
  }
  fs.rmSync(temporary, { force: true });
  syncDirectory(path.dirname(target));
}

const jsonBytes = (value) => Buffer.from(`${canonicalize(value)}\n`, 'utf8');

function readCanonicalJson(file, code) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (cause) { failClosed(code, { file: path.basename(file), reason: cause.code }); }
  let parsed;
  try { parsed = JSON.parse(text); } catch { failClosed(code, { file: path.basename(file), reason: 'NOT_JSON' }); }
  if (`${canonicalize(parsed)}\n` !== text) failClosed(code, { file: path.basename(file), reason: 'NOT_CANONICAL' });
  return parsed;
}

function assertDigest(value, code, details) {
  assertClosedKeys(value, DIGEST_FIELDS, code, details);
  if (!SHA256_HEX.test(value.sha256) || !Number.isInteger(value.byteLength) || value.byteLength < 1) failClosed(code, details);
}

/* -------------------------------------------------------------------- lock */

export function defaultIsProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function acquireLock(directory, owner, isProcessAlive) {
  const file = path.join(directory, LOCK_FILE_V1);
  const body = jsonBytes(owner);
  let staleLockRecovered = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return { file, staleLockRecovered };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let held;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { failClosed('CHECKPOINT_LOCK_UNREADABLE'); }
    if (held.hostname !== owner.hostname) failClosed('CONCURRENT_RUN_REFUSED', { holderPid: held.pid, holderHost: held.hostname });
    if (isProcessAlive(held.pid)) failClosed('CONCURRENT_RUN_REFUSED', { holderPid: held.pid });
    fs.rmSync(file, { force: true });
    staleLockRecovered = { pid: held.pid, runId: held.runId ?? null };
  }
  failClosed('CONCURRENT_RUN_REFUSED', { reason: 'LOCK_CONTENDED' });
}

/* ------------------------------------------------------------------- store */

/**
 * Opens (or creates) the checkpoint for one FULL materialization run and takes the
 * single-writer lock. Returns the verified committed chain plus the commit surface.
 */
export function openFullCheckpoint({
  checkpointRoot, repositoryRoot, runIdentity, owner = { pid: process.pid, hostname: os.hostname() }, isProcessAlive = defaultIsProcessAlive,
}) {
  if (typeof checkpointRoot !== 'string' || !checkpointRoot) failClosed('CHECKPOINT_ROOT_REQUIRED');
  if (resolvesInside(repositoryRoot, checkpointRoot)) failClosed('CHECKPOINT_ROOT_INSIDE_REPOSITORY');
  assertClosedKeys(runIdentity, RUN_IDENTITY_FIELDS_V1, 'CHECKPOINT_RUN_IDENTITY_NOT_CLOSED');
  const runId = sha256Canonical(runIdentity);
  const directory = path.join(path.resolve(checkpointRoot), workUnitDirectoryName(FULL_CHECKPOINT_WORK_UNIT_V1));
  fs.mkdirSync(directory, { recursive: true });
  const lock = acquireLock(directory, { ...owner, runId }, isProcessAlive);
  const release = () => {
    try {
      const held = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
      if (held.pid === owner.pid && held.runId === runId) fs.rmSync(lock.file, { force: true });
    } catch { /* already released */ }
  };
  try {
    const residueRemoved = [];
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith(PUBLISH_TEMP_SUFFIX)) continue;
      fs.rmSync(path.join(directory, entry), { force: true });
      residueRemoved.push(entry);
    }

    const identityFile = path.join(directory, RUN_IDENTITY_FILE_V1);
    if (fs.existsSync(identityFile)) {
      const stored = readCanonicalJson(identityFile, 'CHECKPOINT_RUN_IDENTITY_CORRUPT');
      if (stored.runId !== runId || sha256Canonical(stored.runIdentity) !== runId) {
        failClosed('CHECKPOINT_RUN_IDENTITY_MISMATCH', { storedRunId: stored.runId ?? null, runId });
      }
    } else {
      publishExclusive(identityFile, jsonBytes({ schema: FULL_CHECKPOINT_SCHEMA_V1, runId, runIdentity }));
    }

    const revisionFiles = fs.readdirSync(directory).filter((entry) => /^R\d{4}\.json$/.test(entry));
    const committed = new Array(revisionFiles.length);
    let previousRevisionSha256 = null;
    for (let ordinal = 1; ordinal <= revisionFiles.length; ordinal += 1) {
      const name = checkpointRevisionName(ordinal);
      const file = path.join(directory, `${name}.json`);
      if (!fs.existsSync(file)) failClosed('CHECKPOINT_HISTORY_CHAIN_BROKEN', { missing: name });
      const revision = readCanonicalJson(file, 'CHECKPOINT_REVISION_CORRUPT');
      assertClosedKeys(revision, REVISION_FIELDS_V1, 'CHECKPOINT_REVISION_CORRUPT', { revision: name });
      const { revisionSha256, ...body } = revision;
      if (revision.schema !== FULL_CHECKPOINT_SCHEMA_V1 || revision.runId !== runId || revision.revision !== name
        || revision.revisionOrdinal !== ordinal || revision.previousRevisionSha256 !== previousRevisionSha256
        || revisionSha256 !== sha256Canonical(body)) {
        failClosed('CHECKPOINT_REVISION_CORRUPT', { revision: name });
      }
      assertClosedKeys(revision.pair, PAIR_FIELDS, 'CHECKPOINT_REVISION_CORRUPT', { revision: name });
      if (revision.pair.pageNumber !== ordinal) failClosed('CHECKPOINT_REVISION_CORRUPT', { revision: name, field: 'pageNumber' });
      assertDigest(revision.pair.ensemble, 'CHECKPOINT_REVISION_CORRUPT', { revision: name, field: 'ensemble' });
      assertDigest(revision.pair.provenance, 'CHECKPOINT_REVISION_CORRUPT', { revision: name, field: 'provenance' });
      committed[ordinal - 1] = revision;
      previousRevisionSha256 = revisionSha256;
    }

    let final = null;
    const finalFile = path.join(directory, FINAL_REVISION_FILE_V1);
    if (fs.existsSync(finalFile)) {
      final = readCanonicalJson(finalFile, 'CHECKPOINT_FINAL_CORRUPT');
      assertClosedKeys(final, FINAL_FIELDS, 'CHECKPOINT_FINAL_CORRUPT');
      const { finalSha256, ...finalBody } = final;
      if (final.schema !== FULL_CHECKPOINT_SCHEMA_V1 || final.runId !== runId || final.kind !== 'FINAL'
        || final.committedPairCount !== committed.length || final.lastRevisionSha256 !== previousRevisionSha256
        || finalSha256 !== sha256Canonical(finalBody)) {
        failClosed('CHECKPOINT_FINAL_CORRUPT');
      }
      assertDigest(final.manifest, 'CHECKPOINT_FINAL_CORRUPT', { field: 'manifest' });
    }

    const handle = {
      runId,
      directory,
      committed,
      get final() { return final; },
      staleLockRecovered: lock.staleLockRecovered,
      residueRemoved,
      revisionWrites: 0,

      /** Commits page pair N as revision N. Identical replay is a no-op; divergent replay fails closed. */
      commitPair(pair) {
        assertClosedKeys(pair, PAIR_FIELDS, 'CHECKPOINT_PAIR_NOT_CLOSED');
        assertDigest(pair.ensemble, 'CHECKPOINT_PAIR_NOT_CLOSED', { field: 'ensemble' });
        assertDigest(pair.provenance, 'CHECKPOINT_PAIR_NOT_CLOSED', { field: 'provenance' });
        if (final !== null) failClosed('CHECKPOINT_ALREADY_FINAL');
        if (Number.isInteger(pair.pageNumber) && pair.pageNumber >= 1 && pair.pageNumber <= committed.length) {
          if (canonicalize(committed[pair.pageNumber - 1].pair) === canonicalize(pair)) return { replay: 'IDEMPOTENT', revision: committed[pair.pageNumber - 1] };
          failClosed('DIVERGENT_PAIR_REPLAY_REFUSED', { pageNumber: pair.pageNumber });
        }
        if (pair.pageNumber !== committed.length + 1) failClosed('PAIR_COMMIT_OUT_OF_ORDER', { pageNumber: pair.pageNumber, frontier: committed.length });
        const ordinal = committed.length + 1;
        const body = {
          schema: FULL_CHECKPOINT_SCHEMA_V1,
          runId,
          revision: checkpointRevisionName(ordinal),
          revisionOrdinal: ordinal,
          previousRevisionSha256: ordinal === 1 ? null : committed[ordinal - 2].revisionSha256,
          pair: { pageNumber: pair.pageNumber, ensemble: { ...pair.ensemble }, provenance: { ...pair.provenance } },
        };
        const revision = { ...body, revisionSha256: sha256Canonical(body) };
        publishExclusive(path.join(directory, `${body.revision}.json`), jsonBytes(revision));
        committed.push(revision);
        handle.revisionWrites += 1;
        return { replay: 'COMMITTED', revision };
      },

      /** Seals the run once every pair and the manifest exist. */
      finalize({ manifest, pageCount }) {
        assertDigest(manifest, 'CHECKPOINT_FINAL_INVALID', { field: 'manifest' });
        if (committed.length !== pageCount) failClosed('CHECKPOINT_FINAL_BEFORE_ALL_PAIRS', { committed: committed.length, pageCount });
        const body = {
          schema: FULL_CHECKPOINT_SCHEMA_V1,
          runId,
          kind: 'FINAL',
          committedPairCount: committed.length,
          lastRevisionSha256: committed.length === 0 ? null : committed[committed.length - 1].revisionSha256,
          manifest: { ...manifest },
        };
        const sealed = { ...body, finalSha256: sha256Canonical(body) };
        if (final !== null) {
          if (canonicalize(final) === canonicalize(sealed)) return { replay: 'IDEMPOTENT', final };
          failClosed('DIVERGENT_FINAL_REFUSED');
        }
        publishExclusive(finalFile, jsonBytes(sealed));
        final = sealed;
        handle.revisionWrites += 1;
        return { replay: 'COMMITTED', final };
      },

      release,
    };
    return handle;
  } catch (error) {
    release();
    throw error;
  }
}
