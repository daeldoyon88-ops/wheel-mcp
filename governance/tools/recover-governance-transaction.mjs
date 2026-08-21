import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, canonicalize } from './canonical-json.mjs';
import { validateTransaction } from './validate-transaction.mjs';
import { validateLifecycleTransactionProvenance } from './transaction-provenance.mjs';
import { durableReplaceFileSync, sweepPublicationResidue } from './durable-write.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveOptionPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveRootPath(root, value) {
  if (!safeRelative(value)) throw new Error('UNSAFE_TRANSACTION_PATH:' + value);
  const resolved = path.resolve(root, value);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('PATH_OUTSIDE_ROOT:' + value);
  return resolved;
}

function copyIfNeeded(root, source, target, expectedSha256 = null) {
  const sourcePath = resolveRootPath(root, source);
  const targetPath = resolveRootPath(root, target);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('STAGED_ARTIFACT_MISSING:' + source);
  const bytes = fs.readFileSync(sourcePath);
  if (expectedSha256 && sha256Bytes(bytes) !== expectedSha256) throw new Error('STAGING_ALTERED:' + source);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (!fs.existsSync(targetPath) || !bytes.equals(fs.readFileSync(targetPath))) durableReplaceFileSync(targetPath, bytes);
}

/**
 * Idempotent by the ledger's own content, and durable by replacement rather than
 * append.
 *
 * An append cannot be made atomic: a process killed part-way leaves a truncated
 * final line that every subsequent reader chokes on, which is precisely the state
 * recovery exists to prevent. The whole file is therefore composed in memory and
 * moved into place, so the ledger is either exactly what it was or exactly what
 * it was plus one complete event.
 */
function appendLedgerEvent(root, event) {
  if (!event || !event.eventId) throw new Error('LEDGER_EVENT_REQUIRED');
  const ledgerPath = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
  const existingBytes = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : Buffer.alloc(0);
  const existing = existingBytes.toString('utf8');
  if (existing.split('\n').some((line) => line.includes(`"eventId":"${event.eventId}"`))) return;
  const cleanEvent = { ...event };
  if (cleanEvent.eventPayloadSha256 && !cleanEvent.previousEventSha256 && existing.trim()) throw new Error('LEDGER_APPEND_CHAIN_CONTEXT_REQUIRED');
  durableReplaceFileSync(ledgerPath, Buffer.concat([existingBytes, Buffer.from(canonicalize(cleanEvent) + '\n', 'utf8')]));
}

function updateTransactionState(transactionPath, transaction, state) {
  const next = { ...transaction, transactionState: state };
  if (state === 'COMMITTED') next.committedAt = new Date().toISOString();
  durableReplaceFileSync(transactionPath, Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8'));
  return next;
}

function applyArtifacts(root, transactionDir, transaction) {
  for (const artifact of transaction.stagedArtifacts || []) {
    const source = artifact.sourcePath || artifact.stagingPath || artifact.path;
    const target = artifact.targetPath || artifact.publishPath || artifact.path;
    if (!source || !target) continue;
    copyIfNeeded(root, source, target, artifact.sha256 || null);
  }
  for (const pointer of transaction.newPointers || []) {
    const source = pointer.sourcePath || pointer.stagedPath;
    const target = pointer.path || pointer.pointerPath;
    if (source && target) copyIfNeeded(root, source, target, pointer.sha256 || null);
  }
}

/**
 * A RESOLVED TRANSACTION LEAVES NOTHING BEHIND.
 *
 * `recoverPendingLifecycleTransactions` discards a journal once it is terminal,
 * but the standalone recovery tool — the one an operator actually runs after a
 * hard crash, and the one every crash hostile invokes — did not. So even a fully
 * successful ROLL_FORWARD_COMPLETE left `governance/transactions/TXN_*` on disk.
 * That is not inert: `recoverTransaction` short-circuits only on a COMMITTED
 * journal that still carries its marker, so a surviving directory is residue that
 * a later reader must interpret, and the "residue 0" property the transaction
 * model claims was never actually true through this entry point.
 *
 * Discarded for the same reason the orchestrator discards its own: the marker is
 * written only after the canonical bytes have landed, so once it exists the
 * journal has no remaining evidentiary job.
 */
function discardResolvedTransaction(transactionPath) {
  const directory = path.dirname(transactionPath);
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    const base = path.dirname(directory);
    if (fs.existsSync(base) && fs.readdirSync(base).length === 0) fs.rmdirSync(base);
  } catch { /* residue left visible for the operator rather than masked */ }
}

function recoverTransaction({ root, transactionPath, apply = false }) {
  const rootResolved = path.resolve(root);
  if (!fs.existsSync(transactionPath)) return { valid: false, recoveryAction: 'RECOVERY_REQUIRED', findings: [{ detectorId: 'MISSING_TRANSACTION_INPUT', severity: 'BLOCKING', transactionPath }] };
  // A journal that will not parse is a BLOCK, never a throw. Recovery is the last
  // thing standing between a crashed publication and an operator; if it dies on
  // the tampered or truncated file it was called to judge, there is nothing left
  // to report the problem.
  let transaction = null;
  try { transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8')); } catch (error) {
    return { valid: false, recoveryAction: 'TRANSACTION_JOURNAL_UNPARSEABLE', applied: false, findings: [{ detectorId: 'TRANSACTION_JOURNAL_UNPARSEABLE', severity: 'BLOCKING', transactionPath, message: error.message }] };
  }
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    return { valid: false, recoveryAction: 'TRANSACTION_JOURNAL_UNPARSEABLE', applied: false, findings: [{ detectorId: 'TRANSACTION_JOURNAL_UNPARSEABLE', severity: 'BLOCKING', transactionPath, message: 'journal is not a JSON object' }] };
  }
  const transactionDir = path.dirname(transactionPath);
  const committedMarker = path.join(transactionDir, 'COMMITTED');
  if (transaction.transactionState === 'COMMITTED' && fs.existsSync(committedMarker)) {
    if (apply) discardResolvedTransaction(transactionPath);
    return { valid: true, recoveryAction: 'NONE', transactionId: transaction.transactionId, applied: false, residueSwept: apply };
  }
  const before = validateTransaction({ root: rootResolved, transactionsPath: path.dirname(transactionDir) });
  const provenance = validateLifecycleTransactionProvenance({ root: rootResolved, transaction });
  if (!provenance.valid) return { valid: false, recoveryAction: 'PENDING_TRANSACTION_PROVENANCE_INVALID', transactionId: transaction.transactionId, applied: false, findings: provenance.findings, preflight: before };
  if (!apply) return { valid: false, recoveryAction: 'REPLAY_OR_ABORT', transactionId: transaction.transactionId, applied: false, preflight: before };
  try {
    updateTransactionState(transactionPath, transaction, 'COMMITTING');
    applyArtifacts(rootResolved, transactionDir, transaction);
    if (transaction.ledgerEvent) appendLedgerEvent(rootResolved, transaction.ledgerEvent);
    // Whatever the interrupted publication left half-moved is swept once the
    // canonical bytes are settled, so a completed recovery leaves no residue for
    // a later reader to have to interpret.
    sweepPublicationResidue((transaction.stagedArtifacts || [])
      .map((artifact) => artifact.targetPath)
      .filter((value) => typeof value === 'string' && safeRelative(value))
      .map((value) => path.resolve(rootResolved, value)));
    durableReplaceFileSync(committedMarker, '');
    updateTransactionState(transactionPath, transaction, 'COMMITTED');
    const after = validateTransaction({ root: rootResolved, transactionsPath: path.dirname(transactionDir) });
    const findingKey = (finding) => `${finding.detectorId}|${finding.jsonPointer}|${JSON.stringify(finding.actualValue)}`;
    const baseline = new Set(before.findings.map(findingKey));
    const introduced = after.findings.filter((finding) => !baseline.has(findingKey(finding)));
    if (introduced.length) return { valid: false, recoveryAction: 'RECOVERY_REQUIRED', transactionId: transaction.transactionId, applied: true, preflight: after, introducedFindings: introduced };
    // Only now — the canonical bytes are settled and the post-state introduced no
    // finding the pre-state did not already carry.
    discardResolvedTransaction(transactionPath);
    return { valid: true, recoveryAction: 'ROLL_FORWARD_COMPLETE', transactionId: transaction.transactionId, applied: true, preflight: after, residueSwept: true };
  } catch (error) {
    try { updateTransactionState(transactionPath, transaction, 'RECOVERY_REQUIRED'); } catch { /* preserve original recovery error */ }
    return { valid: false, recoveryAction: 'RECOVERY_REQUIRED', transactionId: transaction.transactionId, applied: true, error: error.message };
  }
}

export { recoverTransaction };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const transactionPath = resolveOptionPath(root, option('--transaction', path.join(root, 'governance/transactions/TXN_000001/TRANSACTION.json')));
  const report = recoverTransaction({ root, transactionPath, apply: process.argv.includes('--apply') });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
