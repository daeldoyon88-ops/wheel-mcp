import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './canonical-json.mjs';

const REQUIRED_FIELDS = ['schemaVersion', 'transactionId', 'transactionState', 'caseType', 'gateId', 'stagedArtifacts', 'expectedHashes', 'oldPointers', 'newPointers', 'commitOrder', 'rollbackPlan', 'recoveryPlan', 'idempotencyKeys'];
const ALLOWED_FIELDS = [...REQUIRED_FIELDS, 'ledgerEvent', 'provenance', 'preparedAt', 'committedAt'];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveOptionPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function finding(findings, detectorId, jsonPointer, actualValue, expectedRule, message, requirementId = 'REQ-TXN-01') {
  findings.push({ detectorId, severity: 'BLOCKING', jsonPointer, actualValue, expectedRule, message, requirementId });
}

function readJson(file, findings, requirementId = 'REQ-TXN-01') {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    finding(findings, 'MISSING_TRANSACTION_INPUT', '/', file, 'existing JSON file', 'Transaction input is missing.', requirementId);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    finding(findings, 'INVALID_JSON', '/', file, 'valid JSON', error.message, requirementId);
    return null;
  }
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveRootPath(root, value, findings, pointer, requirementId = 'REQ-TXN-01') {
  if (!safeRelative(value)) {
    finding(findings, 'INVALID_NORMALIZED_PATH', pointer, value, 'relative path without traversal', 'Transaction path is unsafe.', requirementId);
    return null;
  }
  const resolved = path.resolve(root, value);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    finding(findings, 'PATH_OUTSIDE_ROOT', pointer, value, 'target below governed root', 'Transaction path escapes the governed root.', requirementId);
    return null;
  }
  return resolved;
}

function validateTransactionShape(transaction, findings) {
  for (const field of REQUIRED_FIELDS) if (!Object.prototype.hasOwnProperty.call(transaction, field)) finding(findings, 'SCHEMA_VIOLATION', '/', field, 'required property', `Transaction is missing ${field}.`);
  for (const field of Object.keys(transaction)) if (!ALLOWED_FIELDS.includes(field)) finding(findings, 'SCHEMA_VIOLATION', `/${field}`, transaction[field], 'additionalProperties=false', `Transaction contains unknown field ${field}.`);
  if (!['PREPARING', 'PREPARED', 'COMMITTING', 'COMMITTED', 'ABORTED', 'RECOVERY_REQUIRED'].includes(transaction.transactionState)) finding(findings, 'SCHEMA_VIOLATION', '/transactionState', transaction.transactionState, 'transaction state enum', 'Unknown transaction state.');
  if (!['INTERNAL_REVISION', 'STATUS_TRANSITION'].includes(transaction.caseType)) finding(findings, 'SCHEMA_VIOLATION', '/caseType', transaction.caseType, 'transaction case enum', 'Unknown transaction case type.');
  if (transaction.caseType === 'INTERNAL_REVISION' && transaction.ledgerEvent !== undefined && transaction.ledgerEvent !== null) finding(findings, 'INTERNAL_REVISION_WRITES_LEDGER', '/ledgerEvent', transaction.ledgerEvent, 'null or absent for INTERNAL_REVISION', 'Internal revision contains a status event.', 'REQ-TXN-03');
  if (transaction.caseType === 'STATUS_TRANSITION' && (!transaction.ledgerEvent || typeof transaction.ledgerEvent !== 'object')) finding(findings, 'MISSING_STATUS_EVENT', '/ledgerEvent', transaction.ledgerEvent, 'event object for STATUS_TRANSITION', 'Status transaction has no ledger event.', 'REQ-TXN-03');
}

function listRevisionState(root) {
  const result = new Map();
  const gatesRoot = path.join(root, 'governance', 'gates');
  if (!fs.existsSync(gatesRoot)) return result;
  for (const gateEntry of fs.readdirSync(gatesRoot, { withFileTypes: true })) {
    if (!gateEntry.isDirectory()) continue;
    const revisionRoot = path.join(gatesRoot, gateEntry.name, 'state', 'revisions');
    const currentPath = path.join(gatesRoot, gateEntry.name, 'state', 'CURRENT_STATE.json');
    if (!fs.existsSync(revisionRoot)) continue;
    let current = null;
    if (fs.existsSync(currentPath)) {
      try { current = JSON.parse(fs.readFileSync(currentPath, 'utf8')); } catch { current = null; }
    }
    const revisions = fs.readdirSync(revisionRoot).filter((name) => /^R[0-9]{4}$/.test(name));
    result.set(gateEntry.name, { revisionRoot, currentPath, current, revisions });
  }
  return result;
}

function validateTransaction({ root, transactionsPath }) {
  const findings = [];
  const rootResolved = path.resolve(root);
  const txRoot = transactionsPath || path.join(rootResolved, 'governance', 'transactions');
  const transactions = [];
  if (fs.existsSync(txRoot) && fs.statSync(txRoot).isDirectory()) {
    for (const entry of fs.readdirSync(txRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^TXN_[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      const dir = path.join(txRoot, entry.name);
      const transaction = readJson(path.join(dir, 'TRANSACTION.json'), findings);
      if (transaction) transactions.push({ dir, transaction });
    }
  }
  const committed = new Set();
  for (const item of transactions) {
    const { dir, transaction } = item;
    validateTransactionShape(transaction, findings);
    const hasPrepared = fs.existsSync(path.join(dir, 'PREPARED'));
    const hasCommitted = fs.existsSync(path.join(dir, 'COMMITTED'));
    if (hasCommitted) committed.add(transaction.transactionId);
    if (hasPrepared && !hasCommitted) finding(findings, 'INCOMPLETE_TRANSACTION', '/', transaction.transactionId, 'PREPARED must reach COMMITTED or explicit recovery', 'Transaction is left PREPARED without COMMITTED.', 'REQ-TXN-01');
    if (transaction.transactionState === 'COMMITTED' && !hasCommitted) finding(findings, 'INCOMPLETE_TRANSACTION', '/transactionState', transaction.transactionState, 'COMMITTED marker present', 'Transaction claims COMMITTED without the final marker.', 'REQ-TXN-01');
    if (hasCommitted && transaction.transactionState !== 'COMMITTED') finding(findings, 'TRANSACTION_STATE_MISMATCH', '/transactionState', transaction.transactionState, 'COMMITTED', 'COMMITTED marker disagrees with transaction state.', 'REQ-TXN-01');
    for (const [index, expected] of (transaction.expectedHashes || []).entries()) {
      const targetPath = expected.targetPath || expected.path || expected.repoRelativePath;
      const target = targetPath && resolveRootPath(rootResolved, targetPath, findings, `/expectedHashes/${index}/targetPath`);
      if (!target || !fs.existsSync(target)) {
        if (hasCommitted) finding(findings, 'TRANSACTION_HASH_MISMATCH', `/expectedHashes/${index}`, expected, 'published artifact exists with expected hash', 'Expected transaction artifact is absent.', 'REQ-TXN-03');
        continue;
      }
      const actual = sha256Bytes(fs.readFileSync(target));
      if (expected.sha256 && actual !== expected.sha256) finding(findings, 'TRANSACTION_HASH_MISMATCH', `/expectedHashes/${index}/sha256`, expected.sha256, actual, 'expected hash equals real artifact bytes.', 'REQ-TXN-03');
    }
    for (const [index, pointer] of (transaction.newPointers || []).entries()) {
      const targetPath = pointer.targetPath || pointer.revisionPath || pointer.contractPath;
      if (!targetPath) continue;
      const target = resolveRootPath(rootResolved, targetPath, findings, `/newPointers/${index}/targetPath`);
      if (!hasCommitted) finding(findings, 'POINTER_TO_UNCOMMITTED', `/newPointers/${index}`, targetPath, 'pointers only become active after COMMITTED', 'A non-committed transaction defines an active pointer target.', 'REQ-TXN-03');
      if (target && !fs.existsSync(target)) finding(findings, 'POINTER_TO_UNCOMMITTED', `/newPointers/${index}`, targetPath, 'existing published target', 'New pointer target is absent.', 'REQ-TXN-03');
    }
    if (transaction.ledgerEvent && !hasCommitted) finding(findings, 'UNREFERENCED_EVENT', '/ledgerEvent', transaction.ledgerEvent.eventId, 'event belongs to a COMMITTED transaction', 'Ledger event is present in an uncommitted transaction.', 'REQ-TXN-02');
    if (transaction.transactionState === 'COMMITTING' && !hasCommitted) finding(findings, 'PARTIALLY_PUBLISHED', '/transactionState', transaction.transactionState, 'complete commit or RECOVERY_REQUIRED', 'Transaction is partially published and not marked for recovery.', 'REQ-TXN-01');
  }
  for (const [gateId, state] of listRevisionState(rootResolved)) {
    const currentNumber = Number.parseInt(state.current?.stateRevision?.slice(1), 10) || 0;
    for (const revision of state.revisions) {
      const number = Number.parseInt(revision.slice(1), 10);
      if (number > currentNumber) finding(findings, 'ORPHAN_REVISION', `/gates/${gateId}/state/revisions/${revision}`, revision, 'revision referenced by CURRENT_STATE or a later committed seal', 'Published revision is not connected to the current state.', 'REQ-TXN-02');
    }
    if (state.current?.committedByTransactionId && !committed.has(state.current.committedByTransactionId)) finding(findings, 'POINTER_TO_UNCOMMITTED', `/gates/${gateId}/state/CURRENT_STATE.json`, state.current.committedByTransactionId, 'committed transaction id', 'CURRENT_STATE points to a transaction that is not COMMITTED.', 'REQ-TXN-03');
  }
  for (const item of transactions) {
    if (!item.transaction.ledgerEvent || !committed.has(item.transaction.transactionId)) continue;
    const ledgerPath = path.join(rootResolved, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
    if (fs.existsSync(ledgerPath)) {
      const found = fs.readFileSync(ledgerPath, 'utf8').split('\n').some((line) => line.includes(`"eventId":"${item.transaction.ledgerEvent.eventId}"`));
      if (!found) finding(findings, 'UNREFERENCED_EVENT', '/ledgerEvent/eventId', item.transaction.ledgerEvent.eventId, 'event present in canonical ledger', 'Committed status event is not present in the ledger.', 'REQ-TXN-02');
    }
  }
  return { valid: findings.length === 0, blockingCount: findings.length, findings, transactionCount: transactions.length, committedTransactionCount: committed.size };
}

export { validateTransaction };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const report = validateTransaction({ root, transactionsPath: option('--transactions', null) ? resolveOptionPath(root, option('--transactions')) : null });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
