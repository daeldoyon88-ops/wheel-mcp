/**
 * DURABLE FILE REPLACEMENT — the physical primitive the R6 transaction assumed
 * it already had.
 *
 * WHAT WAS ACTUALLY WRONG. The transaction layer above this file is built on a
 * dichotomy: at every instant a canonical path holds EITHER its pre-state bytes
 * OR the candidate bytes, never anything else. `isPermittedProgress` in
 * transaction-provenance.mjs decides recovery on exactly that dichotomy — a path
 * is `atBefore` or `atCandidate`, and anything else is
 * PENDING_TRANSACTION_CANONICAL_BYTES_UNEXPECTED.
 *
 * `fs.writeFileSync` does not provide that dichotomy. It truncates the target and
 * then streams bytes into it, so a process killed mid-write leaves a THIRD state:
 * a prefix of the candidate at the canonical path. For the append-only ledger
 * that state is unrecoverable in the strong sense — every reader parses every
 * line, so the truncated final line breaks the next read, and recovery itself
 * cannot run. The transaction journal had the same exposure: a half-written
 * TRANSACTION.json is a journal nobody can parse, which is the one artifact
 * recovery needs most.
 *
 * A caught I/O exception never exposed this, because the throw happens inside a
 * live process that still runs its rollback. Only a real process death does, and
 * that is what the hostile battery now injects.
 *
 * THE REPAIR IS PHYSICAL, NOT SEMANTIC. Nothing above this file changes its idea
 * of what a legal state is. The bytes are written to a temporary file in the SAME
 * directory, forced to stable storage, and then moved onto the canonical path by
 * a single rename. A rename either happened or did not; there is no prefix of a
 * rename. The dichotomy the transaction layer already assumed becomes true under
 * hard crash instead of only under caught exceptions.
 *
 * WHY THE TEMP NAME IS DETERMINISTIC. A crash between the temp write and the
 * rename leaves the temp file behind. It carries no canonical status — it is not
 * at a governed path and nothing reads it — but residue that nobody can attribute
 * is how a repository stops being auditable. The name is derived from the target
 * so recovery can sweep exactly the files this module could have created, and the
 * existing residue assertions recognise it.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The marker that makes a stray temp file attributable to this module. */
export const PUBLISH_TEMP_INFIX = '.__publish__';
export const PUBLISH_TEMP_SUFFIX = `${PUBLISH_TEMP_INFIX}.tmp`;

/** The temp path this module would use for `targetPath`. Same directory, always. */
export function publicationTempPath(targetPath) {
  const resolved = path.resolve(targetPath);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}${PUBLISH_TEMP_SUFFIX}`);
}

export function isPublicationTempPath(value) {
  return typeof value === 'string' && path.basename(value).endsWith(PUBLISH_TEMP_SUFFIX);
}

/**
 * Directory metadata durability.
 *
 * On POSIX the rename is only guaranteed to survive a power loss once the parent
 * directory entry itself is synced. Windows does not permit opening a directory
 * as a file and answers EPERM/EISDIR/EACCES; that is a platform limitation, not a
 * failure of this operation, so it is tolerated rather than propagated. The
 * rename remains atomic with respect to PROCESS death — which is the failure this
 * repair is required to survive — on both platforms.
 */
function syncDirectory(directory) {
  let handle = null;
  try {
    handle = fs.openSync(directory, 'r');
    fs.fsyncSync(handle);
  } catch { /* platform does not permit directory fsync */ }
  finally { if (handle !== null) { try { fs.closeSync(handle); } catch { /* already gone */ } } }
}

/**
 * Replace `targetPath` with `bytes` so that no observer can ever see a partial
 * file at that path, whatever kills this process.
 *
 * The parent directory is created when absent, because a candidate write may be
 * the first artifact in a new revision directory.
 */
export function durableReplaceFileSync(targetPath, bytes) {
  const resolved = path.resolve(targetPath);
  const directory = path.dirname(resolved);
  const temporary = publicationTempPath(resolved);
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  fs.mkdirSync(directory, { recursive: true });
  let handle = null;
  try {
    handle = fs.openSync(temporary, 'w');
    fs.writeSync(handle, payload, 0, payload.length, 0);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) { try { fs.closeSync(handle); } catch { /* closed by the failure */ } }
  }
  fs.renameSync(temporary, resolved);
  syncDirectory(directory);
}

/**
 * Remove any temp file this module could have left for `targetPaths`.
 *
 * Returns the paths actually removed, so a caller can prove a sweep did
 * something rather than assuming it did.
 */
export function sweepPublicationResidue(targetPaths = []) {
  const removed = [];
  for (const target of targetPaths) {
    const temporary = publicationTempPath(target);
    if (!fs.existsSync(temporary)) continue;
    try { fs.rmSync(temporary, { force: true }); removed.push(temporary); } catch { /* left for the operator to see */ }
  }
  return removed;
}
