import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, canonicalize } from './canonical-json.mjs';
import { validateTransaction } from './validate-transaction.mjs';

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
  if (!fs.existsSync(targetPath) || !bytes.equals(fs.readFileSync(targetPath))) fs.writeFileSync(targetPath, bytes);
}

function appendLedgerEvent(root, event) {
  if (!event || !event.eventId) throw new Error('LEDGER_EVENT_REQUIRED');
  const ledgerPath = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
  const existing = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  if (existing.split('\n').some((line) => line.includes(`"eventId":"${event.eventId}"`))) return;
  const cleanEvent = { ...event };
  if (cleanEvent.eventPayloadSha256 && !cleanEvent.previousEventSha256 && existing.trim()) throw new Error('LEDGER_APPEND_CHAIN_CONTEXT_REQUIRED');
  fs.appendFileSync(ledgerPath, canonicalize(cleanEvent) + '\n', 'utf8');
}

function updateTransactionState(transactionPath, transaction, state) {
  const next = { ...transaction, transactionState: state };
  if (state === 'COMMITTED') next.committedAt = new Date().toISOString();
  fs.writeFileSync(transactionPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
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

function recoverTransaction({ root, transactionPath, apply = false }) {
  const rootResolved = path.resolve(root);
  if (!fs.existsSync(transactionPath)) return { valid: false, recoveryAction: 'RECOVERY_REQUIRED', findings: [{ detectorId: 'MISSING_TRANSACTION_INPUT', severity: 'BLOCKING', transactionPath }] };
  const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const transactionDir = path.dirname(transactionPath);
  const committedMarker = path.join(transactionDir, 'COMMITTED');
  if (transaction.transactionState === 'COMMITTED' && fs.existsSync(committedMarker)) return { valid: true, recoveryAction: 'NONE', transactionId: transaction.transactionId, applied: false };
  const before = validateTransaction({ root: rootResolved, transactionsPath: path.dirname(transactionDir) });
  if (!apply) return { valid: false, recoveryAction: 'REPLAY_OR_ABORT', transactionId: transaction.transactionId, applied: false, preflight: before };
  try {
    updateTransactionState(transactionPath, transaction, 'COMMITTING');
    applyArtifacts(rootResolved, transactionDir, transaction);
    if (transaction.ledgerEvent) appendLedgerEvent(rootResolved, transaction.ledgerEvent);
    fs.writeFileSync(committedMarker, '', 'utf8');
    updateTransactionState(transactionPath, transaction, 'COMMITTED');
    const after = validateTransaction({ root: rootResolved, transactionsPath: path.dirname(transactionDir) });
    const findingKey = (finding) => `${finding.detectorId}|${finding.jsonPointer}|${JSON.stringify(finding.actualValue)}`;
    const baseline = new Set(before.findings.map(findingKey));
    const introduced = after.findings.filter((finding) => !baseline.has(findingKey(finding)));
    if (introduced.length) return { valid: false, recoveryAction: 'RECOVERY_REQUIRED', transactionId: transaction.transactionId, applied: true, preflight: after, introducedFindings: introduced };
    return { valid: true, recoveryAction: 'ROLL_FORWARD_COMPLETE', transactionId: transaction.transactionId, applied: true, preflight: after };
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
