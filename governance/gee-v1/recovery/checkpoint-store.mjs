/**
 * GEE V1 R6 checkpoint store.
 *
 * Immutable revisions on a plain filesystem. There is no database, no daemon,
 * no lock manager and no transaction log — a checkpoint revision is one JSON
 * file written with the exclusive-create flag, so a revision that already
 * exists can never be silently replaced by a later, weaker claim about the same
 * moment. History is therefore append-only in the only way that survives a
 * process being killed: by never opening an existing revision for writing.
 *
 * The write ORDER is the whole atomicity design, and it is deliberately the
 * cheapest one that makes both half-written states detectable:
 *
 *   1. evidence   — already in the R4 content-addressed store
 *   2. usage      — the execution record, written before anything claims it
 *   3. checkpoint — written LAST, naming the exact record identities above
 *
 * Dying between 2 and 3 leaves a usage record no checkpoint references: real
 * history, proving nothing complete, and recovery reports it as an unreferenced
 * execution artifact rather than counting it twice or promoting it. Dying
 * between 1 and 2 leaves evidence nothing references, which the next evaluation
 * simply re-derives. The reverse — a checkpoint naming a record that does not
 * exist — cannot arise from this order, so if it is ever observed the history
 * was edited, and recovery fails closed on it.
 *
 * Reading is strict: every revision is validated on the way in, and a corrupt
 * newest revision is REPORTED rather than skipped. Silently falling back to an
 * older checkpoint would let a damaged newest revision quietly erase real
 * progress, so that fallback exists only behind an explicit policy flag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertCheckpoint, checkpointRevisionLabel, validateCheckpoint } from './recovery-engine.mjs';
import { parseUsageLedger, serializeUsageLedger, verifyUsageLedger } from '../usage/usage-ledger.mjs';

export const CHECKPOINT_STORE_VERSION = 'GEE_V1_CHECKPOINT_STORE_R6';
export const CHECKPOINT_FILE = 'checkpoint.json';
export const USAGE_FILE = 'usage-ledger.json';

const REVISION_RE = /^R\d{4}$/;

function compareIdentifiers(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * Filesystem name for a work unit.
 *
 * A work-unit id may contain characters no filesystem accepts, and two ids that
 * differ only in those characters would collide if they were merely sanitised.
 * The digest suffix removes that collision while the readable stem keeps the
 * directory identifiable by eye. The id itself is stored inside the checkpoint
 * and re-checked on read, so the directory name is a convenience, never proof.
 */
export function workUnitDirectoryName(workUnitId) {
  if (typeof workUnitId !== 'string' || !workUnitId) throw new Error('WORK_UNIT_ID_REQUIRED');
  const canonical = workUnitId.normalize('NFC');
  if (canonical !== workUnitId) throw new Error(`NON_CANONICAL_WORK_UNIT_ID:${workUnitId}`);
  const stem = canonical.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'work-unit';
  return `${stem}-${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)}`;
}

export function createCheckpointStore(rootDirectory) {
  if (typeof rootDirectory !== 'string' || !rootDirectory) throw new Error('CHECKPOINT_STORE_ROOT_REQUIRED');
  const storeRoot = path.resolve(rootDirectory);

  const directoryFor = (workUnitId) => path.join(storeRoot, workUnitDirectoryName(workUnitId));
  const revisionDirectory = (workUnitId, revision) => path.join(directoryFor(workUnitId), revision);

  function listRevisions(workUnitId) {
    const directory = directoryFor(workUnitId);
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && REVISION_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareIdentifiers);
  }

  /**
   * Reads and validates one revision. Never repairs: a revision that does not
   * validate is returned as a fault, because silently fixing a persisted
   * checkpoint would change the document its own digest was computed over.
   */
  function readRevision(workUnitId, revision) {
    const file = path.join(revisionDirectory(workUnitId, revision), CHECKPOINT_FILE);
    if (!fs.existsSync(file)) return { checkpoint: null, revision, reason: 'CHECKPOINT_REVISION_MISSING' };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { checkpoint: null, revision, reason: 'INVALID_CHECKPOINT_JSON' };
    }
    const validation = validateCheckpoint(parsed);
    if (!validation.valid) return { checkpoint: null, revision, reason: validation.errors[0].reason };
    if (parsed.workUnitId !== workUnitId) return { checkpoint: null, revision, reason: 'CHECKPOINT_WORK_UNIT_MISMATCH' };
    if (parsed.revision !== revision) return { checkpoint: null, revision, reason: 'CHECKPOINT_REVISION_LABEL_MISMATCH' };
    return { checkpoint: parsed, revision, reason: null };
  }

  return {
    version: CHECKPOINT_STORE_VERSION,
    root: storeRoot,
    directoryFor,
    listRevisions,

    read(workUnitId, revision) {
      const result = readRevision(workUnitId, revision);
      if (!result.checkpoint) throw new Error(`INVALID_CHECKPOINT:${result.reason}:${revision}`);
      return result.checkpoint;
    },

    /**
     * Writes one revision. Exclusive create, so a revision is written once and
     * an attempt to rewrite history fails loudly instead of succeeding quietly.
     */
    writeCheckpoint(checkpoint) {
      assertCheckpoint(checkpoint);
      const directory = revisionDirectory(checkpoint.workUnitId, checkpoint.revision);
      const file = path.join(directory, CHECKPOINT_FILE);
      if (fs.existsSync(file)) throw new Error(`CHECKPOINT_REVISION_EXISTS:${checkpoint.workUnitId}:${checkpoint.revision}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' });
      return { path: file, revision: checkpoint.revision, checkpointSha256: checkpoint.checkpointSha256 };
    },

    /**
     * The usage ledger is append-only in its own right, so its file is the one
     * thing here that is rewritten — always with a ledger that verifies, and
     * always BEFORE the checkpoint that will reference its records.
     */
    writeUsageLedger(workUnitId, ledger) {
      verifyUsageLedger(ledger);
      const directory = directoryFor(workUnitId);
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, USAGE_FILE);
      fs.writeFileSync(file, serializeUsageLedger(ledger), 'utf8');
      return { path: file, ledgerSha256: ledger.ledgerSha256 };
    },

    readUsageLedger(workUnitId) {
      const file = path.join(directoryFor(workUnitId), USAGE_FILE);
      if (!fs.existsSync(file)) return null;
      return parseUsageLedger(fs.readFileSync(file, 'utf8'));
    },

    /**
     * The newest revision that actually validates, plus every newer one that
     * did not.
     *
     * A corrupt newest revision does not silently promote its predecessor: by
     * default no checkpoint is returned at all and the caller is told recovery
     * is required. Resuming from an older valid revision is available, but only
     * when the caller explicitly asks for it, and the corruption is reported
     * either way.
     */
    loadLatestValid(workUnitId, { allowOlderValidCheckpoint = false } = {}) {
      const revisions = listRevisions(workUnitId);
      const corruptRevisions = [];
      const valid = [];
      let expectedOrdinal = 1;
      let predecessor = null;
      let ancestryValid = true;
      for (const revision of revisions) {
        const result = readRevision(workUnitId, revision);
        if (!ancestryValid) {
          corruptRevisions.push(`${revision}:CHECKPOINT_ANCESTRY_INVALID`);
          continue;
        }
        if (revision !== checkpointRevisionLabel(expectedOrdinal)) {
          corruptRevisions.push(`${revision}:CHECKPOINT_HISTORY_CHAIN_BROKEN`);
          ancestryValid = false;
          continue;
        }
        if (!result.checkpoint) {
          corruptRevisions.push(`${revision}:${result.reason}`);
          ancestryValid = false;
          continue;
        }
        if (expectedOrdinal > 1 && result.checkpoint.previousCheckpointSha256 !== predecessor.checkpointSha256) {
          corruptRevisions.push(`${revision}:CHECKPOINT_HISTORY_CHAIN_BROKEN`);
          ancestryValid = false;
          continue;
        }
        valid.push(result);
        predecessor = result.checkpoint;
        expectedOrdinal += 1;
      }
      const found = valid.at(-1) || null;
      const reasonCodes = [];
      if (corruptRevisions.length) {
        reasonCodes.push('CORRUPT_NEWEST_CHECKPOINT_REVISION');
        if (corruptRevisions.some((entry) => entry.includes('CHECKPOINT_HISTORY_CHAIN_BROKEN') || entry.includes('CHECKPOINT_ANCESTRY_INVALID'))) {
          reasonCodes.push('CHECKPOINT_HISTORY_CHAIN_BROKEN');
        }
      }
      if (!found) {
        if (revisions.length) reasonCodes.push('NO_VALID_CHECKPOINT_REVISION');
        return { checkpoint: null, revision: null, corruptRevisions, reasonCodes, recoveryRequired: revisions.length > 0 };
      }
      if (corruptRevisions.length && !allowOlderValidCheckpoint) {
        reasonCodes.push('OLDER_VALID_CHECKPOINT_NOT_AUTHORIZED');
        return { checkpoint: null, revision: null, corruptRevisions, reasonCodes, recoveryRequired: true };
      }
      if (corruptRevisions.length) reasonCodes.push('RESUMED_FROM_OLDER_VALID_CHECKPOINT');
      return { checkpoint: found.checkpoint, revision: found.revision, corruptRevisions, reasonCodes, recoveryRequired: false };
    },

    /**
     * The commit unit: usage first, checkpoint last. Returns both write
     * receipts so a caller can see exactly how far a partial write got.
     */
    commit({ workUnitId, ledger, checkpoint }) {
      const usage = this.writeUsageLedger(workUnitId, ledger);
      const written = this.writeCheckpoint(checkpoint);
      return { usage, checkpoint: written };
    }
  };
}

/**
 * Cross-checks a checkpoint against a usage ledger in BOTH directions.
 *
 * Missing records mean a checkpoint outlived its own proof, which cannot happen
 * under this write order and therefore indicates an edited history.
 * Unreferenced records mean execution outlived the checkpoint that would have
 * claimed it, which is the ordinary crash and is not an error.
 */
export function reconcileCheckpointWithUsage(checkpoint, ledger) {
  assertCheckpoint(checkpoint);
  verifyUsageLedger(ledger);
  const ledgerIds = new Set(ledger.records.map((record) => record.usageRecordId));
  const referenced = new Set(checkpoint.tasks.flatMap((task) => task.usageRecordIds));
  const missingUsageRecordIds = [...referenced].filter((id) => !ledgerIds.has(id)).sort(compareIdentifiers);
  const unreferencedUsageRecordIds = ledger.records
    .filter((record) => record.workUnitId === checkpoint.workUnitId && !referenced.has(record.usageRecordId))
    .map((record) => record.usageRecordId)
    .sort(compareIdentifiers);
  return {
    consistent: missingUsageRecordIds.length === 0,
    missingUsageRecordIds,
    unreferencedUsageRecordIds,
    reasonCodes: [
      ...(missingUsageRecordIds.length ? ['CHECKPOINT_USAGE_RECORD_MISSING'] : []),
      ...(unreferencedUsageRecordIds.length ? ['UNREFERENCED_EXECUTION_ARTIFACT_DETECTED'] : [])
    ]
  };
}
