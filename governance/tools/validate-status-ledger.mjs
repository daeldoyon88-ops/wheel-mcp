import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Canonical, sha256Bytes } from './canonical-json.mjs';
import { validateAgainstJsonSchema } from '../gee-v1/contracts/validate-against-json-schema.mjs';

const STATUSES = [
  'NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'IN_PROGRESS', 'REPAIR_REQUIRED',
  'BLOCKED_GOVERNANCE', 'INTERRUPTED_RESUMABLE', 'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED', 'SUPERSEDED', 'REOPENED_AUTHORIZED'
];

// This is the single normative implementation of the 21 transitions extracted from I2.
// NORMAL_EXECUTION_TRANSITION class. Nothing below has been added to, removed from or relaxed in
// this table: historical reconciliation is a separate class with its own, strictly narrower table
// (HISTORICAL_RECONCILIATION_TRANSITIONS) and its own mandatory proof obligations. The two tables
// are never consulted interchangeably, so a reconciliation can never impersonate an execution
// transition and an execution transition can never borrow reconciliation permissions.
export const TRANSITIONS = [
  [null, 'NOT_STARTED', 'GENESIS_IMPORT'],
  [null, 'AUTHORIZED_NOT_STARTED', 'GENESIS_IMPORT'],
  [null, 'COMPLETE_CONFIRMED', 'GENESIS_IMPORT'],
  [null, 'IN_PROGRESS', 'GENESIS_IMPORT'],
  [null, 'BLOCKED_GOVERNANCE', 'GENESIS_IMPORT'],
  ['NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'AUTHORIZATION'],
  ['AUTHORIZED_NOT_STARTED', 'IN_PROGRESS', 'START'],
  ['IN_PROGRESS', 'INTERRUPTED_RESUMABLE', 'INTERRUPTION'],
  ['INTERRUPTED_RESUMABLE', 'IN_PROGRESS', 'RESUME'],
  ['IN_PROGRESS', 'REPAIR_REQUIRED', 'DEFECT_OPENED'],
  ['REPAIR_REQUIRED', 'IN_PROGRESS', 'REPAIR_ACCEPTED'],
  ['IN_PROGRESS', 'BLOCKED_GOVERNANCE', 'GOVERNANCE_BLOCK'],
  ['REPAIR_REQUIRED', 'BLOCKED_GOVERNANCE', 'GOVERNANCE_BLOCK'],
  ['BLOCKED_GOVERNANCE', 'IN_PROGRESS', 'GOVERNANCE_UNBLOCK'],
  ['IN_PROGRESS', 'COMPLETE_AGENT', 'AGENT_CLOSURE'],
  ['COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'EXTERNAL_CONFIRMATION'],
  ['COMPLETE_AGENT', 'REPAIR_REQUIRED', 'EXTERNAL_REJECTION'],
  ['COMPLETE_CONFIRMED', 'REOPENED_AUTHORIZED', 'AUTHORIZED_REOPEN'],
  ['REOPENED_AUTHORIZED', 'IN_PROGRESS', 'RESUME_AFTER_REOPEN'],
  ['COMPLETE_CONFIRMED', 'SUPERSEDED', 'SUPERSESSION'],
  ['COMPLETE_AGENT', 'SUPERSEDED', 'SUPERSESSION']
];

export const NORMAL_EXECUTION_TRANSITION_TYPES = [
  'GENESIS_IMPORT', 'AUTHORIZATION', 'START', 'INTERRUPTION', 'RESUME', 'DEFECT_OPENED',
  'REPAIR_ACCEPTED', 'GOVERNANCE_BLOCK', 'GOVERNANCE_UNBLOCK', 'AGENT_CLOSURE',
  'EXTERNAL_CONFIRMATION', 'EXTERNAL_REJECTION', 'AUTHORIZED_REOPEN', 'RESUME_AFTER_REOPEN',
  'SUPERSESSION'
];

export const HISTORICAL_RECONCILIATION_TRANSITION_TYPE = 'HISTORICAL_RECONCILIATION';

// HISTORICAL_RECONCILIATION class. Deliberately only two entries, both starting from the
// conservative genesis fallback status. There is no entry to COMPLETE_CONFIRMED, no entry from
// IN_PROGRESS, and no entry that could substitute for AUTHORIZATION, START or AGENT_CLOSURE.
export const HISTORICAL_RECONCILIATION_TRANSITIONS = [
  ['NOT_STARTED', 'COMPLETE_AGENT', 'HISTORICAL_RECONCILIATION'],
  ['NOT_STARTED', 'INTERRUPTED_RESUMABLE', 'HISTORICAL_RECONCILIATION']
];

export const TRANSITION_TYPES = [...NORMAL_EXECUTION_TRANSITION_TYPES, HISTORICAL_RECONCILIATION_TRANSITION_TYPE];

const REQUIRED_EVENT_FIELDS = [
  'schemaVersion', 'ordinal', 'eventId', 'gateId', 'fromStatus', 'toStatus',
  'transitionType', 'authorityPath', 'authoritySha256', 'previousEventSha256',
  'recordedAt', 'eventPayloadSha256'
];

// A reconciliation event carries NO new event field: its authorityPath/authoritySha256 already pin
// the reconciliation record byte-exactly inside the existing hash chain, and the record carries the
// provenance, the reason and the owner-authority binding. That keeps the append-only event shape,
// and therefore every existing event, byte-identical.
export const HISTORICAL_RECONCILIATION_RECORD_REQUIRED_FIELDS = [
  'schemaVersion', 'document', 'reconciliationId', 'gateId', 'recordedAt',
  'supersededGenesisEventId', 'supersededGenesisEventPayloadSha256',
  'originalImportedStatus', 'originalStatusBasis', 'originalStatusBasisSourcePath',
  'originalStatusBasisSourceSha256', 'historicalDisposition', 'canonicalCurrentStatus',
  'newExecutionOccurred', 'externalConfirmationEstablished',
  'ownerAuthorizationPath', 'ownerAuthorizationSha256', 'authorityCohort',
  'evidenceCohortDigest', 'reason'
];
export const HISTORICAL_RECONCILIATION_RECORD_OPTIONAL_FIELDS = ['residualObligation'];
const HISTORICAL_RECONCILIATION_COHORT_REQUIRED_FIELDS = ['gateId', 'evidenceRole', 'historicalLocator', 'governedPath', 'byteLength', 'sha256'];
const HISTORICAL_RECONCILIATION_RESIDUAL_REQUIRED_FIELDS = ['description', 'evidenceGovernedPath', 'evidenceSha256'];
// The cohort item that actually establishes the recovered historical disposition. Without one, a
// cohort is just a pile of bytes and proves nothing about the target status.
const STATUS_DISPOSITION_AUTHORITY_ROLE = 'STATUS_DISPOSITION_AUTHORITY';
// Historical word -> governed status. Kept as an explicit two-way mapping so PARTIAL can never be
// promoted to COMPLETE_AGENT and COMPLETE can never be quietly downgraded.
const HISTORICAL_DISPOSITION_TO_STATUS = new Map([
  ['COMPLETE', 'COMPLETE_AGENT'],
  ['PARTIAL', 'INTERRUPTED_RESUMABLE']
]);

// The ONLY repository root under which recovered historical evidence may claim a permanent
// canonical identity. Narrower than "any repository-relative path": product source, dashboards,
// research trees and repo-root manifests such as package.json are ordinary working files that a
// reconciliation must never be able to nominate as historical status authority.
export const HISTORICAL_EVIDENCE_GOVERNED_ROOT = 'governance/authority/historical';

/**
 * Host-independent classification of a declared historical-evidence identity.
 *
 * Deliberately NOT `path.isAbsolute`: that is platform-native, so a POSIX runner would happily
 * accept "D:\archive\report.md" and a Windows runner would accept "/etc/passwd". Both forms are
 * refused on every host here, as are drive-relative forms ("C:report.md"), UNC roots, empty,
 * "." and ".." segments, doubled separators and mixed-separator escapes.
 *
 * @returns {'OK'|'UNPORTABLE'|'OUTSIDE_ROOT'}
 */
export function classifyHistoricalEvidencePath(value) {
  if (typeof value !== 'string' || !value) return 'UNPORTABLE';
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return 'UNPORTABLE';
  // Backslashes are folded first so a mixed-separator traversal ("historical/GATE00/..\..\x")
  // cannot hide a ".." segment from a POSIX host, where "\" is an ordinary filename character.
  const slashed = value.replaceAll('\\', '/');
  const segments = slashed.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'UNPORTABLE';
  // Normalization-safety, stated explicitly: a governed identity must already BE its canonical form,
  // so no two spellings of the same path can produce two different cohort digests.
  if (path.posix.normalize(slashed) !== slashed) return 'UNPORTABLE';
  const rootSegments = HISTORICAL_EVIDENCE_GOVERNED_ROOT.split('/');
  if (segments.length <= rootSegments.length) return 'OUTSIDE_ROOT';
  if (!rootSegments.every((segment, i) => segments[i] === segment)) return 'OUTSIDE_ROOT';
  return 'OK';
}

export function isCanonicalGovernedPathUnicode(pathString) {
  return typeof pathString === 'string' && pathString.normalize('NFC') === pathString;
}

// One canonical algorithm, named so a future change of canonicalization is a visible, breaking
// change of identity rather than a silent reinterpretation of an old owner approval.
export const EVIDENCE_COHORT_DIGEST_ALGORITHM = 'SHA256_CANONICAL_JSON_SORTED_COHORT_V1';

// historicalLocator is deliberately EXCLUDED: it is machine-specific provenance (a Temp or archive
// root that differs per recovery host) and can never take part in a permanent, portable identity.
const EVIDENCE_COHORT_DIGEST_FIELDS = ['gateId', 'evidenceRole', 'governedPath', 'byteLength', 'sha256'];

/**
 * SHA256_CANONICAL_JSON_SORTED_COHORT_V1 — the deterministic identity of an evidence cohort.
 *
 * Canonicalization, exactly:
 *   1. project every cohort item onto {gateId, evidenceRole, governedPath, byteLength, sha256};
 *   2. serialize each projection with the repository's canonical JSON (sorted keys, NFC strings);
 *   3. sort those serializations by UTF-16 code unit (locale-independent, never localeCompare);
 *   4. reject any two identical serializations (a duplicated cohort entry is never an identity);
 *   5. digest = SHA-256 over the UTF-8 bytes of "[" + entries.join(",") + "]", which is by
 *      construction the canonical JSON of the sorted projection array.
 *
 * Consequences, all intended: cohort iteration order does not change identity, while any change of
 * gate, role, governed path, byte length or content hash does.
 *
 * @returns {{ digest: string|null, reason: string|null }}
 */
export function computeEvidenceCohortDigest(cohort) {
  if (!Array.isArray(cohort) || cohort.length === 0) return { digest: null, reason: 'EMPTY_OR_NOT_AN_ARRAY' };
  const entries = [];
  for (const item of cohort) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { digest: null, reason: 'MALFORMED_COHORT_ITEM' };
    const projection = {};
    for (const field of EVIDENCE_COHORT_DIGEST_FIELDS) {
      const value = item[field];
      const wellTyped = field === 'byteLength' ? Number.isInteger(value) : (typeof value === 'string' && value.length > 0);
      if (!wellTyped) return { digest: null, reason: 'MALFORMED_COHORT_ITEM' };
      if (field === 'governedPath' && !isCanonicalGovernedPathUnicode(value)) return { digest: null, reason: 'NON_CANONICAL_GOVERNED_PATH_UNICODE' };
      projection[field] = value;
    }
    entries.push(canonicalize(projection));
  }
  entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i] === entries[i - 1]) return { digest: null, reason: 'DUPLICATE_COHORT_ENTRY' };
  }
  return { digest: sha256Bytes(Buffer.from(`[${entries.join(',')}]`, 'utf8')), reason: null };
}

function isStrictlyInsideRealRoot(realRoot, realCandidate) {
  const relative = path.relative(realRoot, realCandidate);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

const REAL_HISTORICAL_EVIDENCE_FS_OPS = Object.freeze({
  lstatSync: (...args) => fs.lstatSync(...args),
  realpathSync: (...args) => fs.realpathSync.native(...args)
});

function resolveCanonicalHistoricalRoot({ root, fsOps }) {
  const lexicalRepositoryRoot = path.resolve(root);
  const canonicalComponents = [
    { name: 'repository', lexicalPath: lexicalRepositoryRoot, parentRealPath: null },
    { name: 'governance', lexicalPath: path.join(lexicalRepositoryRoot, 'governance') },
    { name: 'authority', lexicalPath: path.join(lexicalRepositoryRoot, 'governance', 'authority') },
    { name: 'historical', lexicalPath: path.join(lexicalRepositoryRoot, HISTORICAL_EVIDENCE_GOVERNED_ROOT) }
  ];
  let parentRealPath = null;
  const realChain = [];
  for (const component of canonicalComponents) {
    const stats = fsOps.lstatSync(component.lexicalPath);
    let realPath;
    try {
      realPath = fsOps.realpathSync(component.lexicalPath);
    } catch (error) {
      if (stats.isSymbolicLink()) {
        return { status: 'INDIRECTION', component: component.lexicalPath, error: error?.code || error?.message || String(error) };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      return { status: 'INDIRECTION', component: component.lexicalPath, realPath };
    }
    if (!stats.isDirectory()) {
      return { status: 'INVALID_ROOT_COMPONENT', component: component.lexicalPath, realPath };
    }
    if (parentRealPath !== null) {
      const expectedRealPath = path.join(parentRealPath, component.name);
      if (path.relative(expectedRealPath, realPath) !== '') {
        return { status: 'ESCAPE', component: component.lexicalPath, realPath, expectedRealPath };
      }
    }
    realChain.push({ lexicalPath: component.lexicalPath, realPath });
    parentRealPath = realPath;
  }
  return {
    status: 'OK',
    lexicalRoot: canonicalComponents.at(-1).lexicalPath,
    realRoot: parentRealPath,
    realChain
  };
}

export function resolveHistoricalEvidenceFilesystemPath({ root, governedPath, fsOps = REAL_HISTORICAL_EVIDENCE_FS_OPS }) {
  const effectiveFsOps = fsOps ?? REAL_HISTORICAL_EVIDENCE_FS_OPS;
  const lexicalRoot = path.resolve(root, HISTORICAL_EVIDENCE_GOVERNED_ROOT);
  const lexicalCandidate = path.resolve(root, governedPath);
  try {
    const canonicalRoot = resolveCanonicalHistoricalRoot({ root, fsOps: effectiveFsOps });
    if (canonicalRoot.status !== 'OK') return { ...canonicalRoot, lexicalCandidate };
    const { realRoot } = canonicalRoot;
    const lexicalRelative = path.relative(lexicalRoot, lexicalCandidate);
    if (lexicalRelative === '' || path.isAbsolute(lexicalRelative) || lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`)) {
      return { status: 'ESCAPE', lexicalRoot, lexicalCandidate };
    }
    let cursor = lexicalRoot;
    const relativeSegments = lexicalRelative.split(path.sep);
    for (const segment of relativeSegments.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      const stats = effectiveFsOps.lstatSync(cursor);
      if (stats.isSymbolicLink()) return { status: 'INDIRECTION', lexicalRoot, lexicalCandidate, realRoot, component: cursor };
      const realComponent = effectiveFsOps.realpathSync(cursor);
      if (!isStrictlyInsideRealRoot(realRoot, realComponent)) {
        return { status: 'ESCAPE', lexicalRoot, lexicalCandidate, realRoot, realComponent, component: cursor };
      }
    }
    const candidateStats = effectiveFsOps.lstatSync(lexicalCandidate);
    if (candidateStats.isSymbolicLink()) {
      let realCandidate;
      try {
        realCandidate = effectiveFsOps.realpathSync(lexicalCandidate);
      } catch {
        return { status: 'INDIRECTION', lexicalRoot, lexicalCandidate, realRoot, component: lexicalCandidate };
      }
      return { status: 'INDIRECTION', lexicalRoot, lexicalCandidate, realRoot, realCandidate, component: lexicalCandidate };
    }
    if (!candidateStats.isFile()) return { status: 'MISSING', lexicalRoot, lexicalCandidate, realRoot };
    const realCandidate = effectiveFsOps.realpathSync(lexicalCandidate);
    if (!isStrictlyInsideRealRoot(realRoot, realCandidate)) {
      return { status: 'ESCAPE', lexicalRoot, lexicalCandidate, realRoot, realCandidate };
    }
    return { status: 'OK', lexicalRoot, lexicalCandidate, realRoot, realCandidate };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { status: 'MISSING', lexicalRoot, lexicalCandidate, error: error.code };
    }
    return { status: 'RESOLUTION_FAILED', lexicalRoot, lexicalCandidate, error: error?.code || error?.message || String(error) };
  }
}

// The owner authorization is validated at runtime against the SAME schema file the schema-parity
// tests read, so "schema-invalid" and "runtime-rejected" cannot drift apart. It is the tool's own
// contract, so it is resolved next to this module and never below the validated --root.
export const HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION_SCHEMA_PATH =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'historical-reconciliation-owner-authorization.schema.json');
let ownerAuthorizationSchemaCache = null;
function loadOwnerAuthorizationSchema() {
  ownerAuthorizationSchemaCache ??= readJson(HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION_SCHEMA_PATH);
  return ownerAuthorizationSchemaCache;
}

function option(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function finding(findings, detectorId, event, lineNumber, jsonPointer, actualValue, expectedRule, authorityRequirement, message, requirementId, severity = 'BLOCKING') {
  findings.push({
    detectorId, severity, ledgerPath: event?.ledgerPath || null, lineNumber,
    eventId: event?.eventId || null, gateId: event?.gateId || null, jsonPointer,
    actualValue, expectedRule, authorityRequirement, message, requirementId
  });
}

function isDateTime(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.includes('T');
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.split('/').includes('..') && !normalized.startsWith('/');
}

export const DEFAULT_REGISTRY_AUTHORITY_MIGRATIONS_PATH = 'governance/authority/REGISTRY_AUTHORITY_MIGRATIONS.ndjson';

// Append-only, hash-chained log of historical-authority migrations. A migration record lets the
// validator resolve a GENESIS_IMPORT event's authority to an immutable, content-addressed snapshot
// instead of the live mutable file at authorityPath, but ONLY for the exact (path, historical hash)
// pair a chain-verified, independently-authorized record names. It never forgives an arbitrary hash,
// never touches ledger event bytes, and any tampering (broken chain, mutated snapshot, unauthorized
// record) degrades back to the original fail-closed AUTHORITY_HASH_MISMATCH.
function loadRegistryAuthorityMigrations({ root, findings }) {
  const migrationsPath = path.resolve(root, DEFAULT_REGISTRY_AUTHORITY_MIGRATIONS_PATH);
  const map = new Map();
  if (!fs.existsSync(migrationsPath)) return map;
  const text = fs.readFileSync(migrationsPath, 'utf8');
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const REQUIRED_MIGRATION_FIELDS = ['schemaVersion', 'migrationId', 'recordedAt', 'originalAuthorityPath', 'originalAuthoritySha256', 'snapshotPath', 'snapshotSha256', 'authorizedByPath', 'authorizedBySha256', 'previousMigrationSha256', 'migrationPayloadSha256'];
  let previousPayloadSha = null;
  const seenIds = new Set();
  for (let i = 0; i < rawLines.length; i += 1) {
    const lineNumber = i + 1;
    const raw = rawLines[i];
    let record;
    try { record = JSON.parse(raw); } catch {
      finding(findings, 'INVALID_MIGRATION_RECORD', null, lineNumber, '/', raw, 'one valid JSON object per line', DEFAULT_REGISTRY_AUTHORITY_MIGRATIONS_PATH, 'Migration log line is not valid JSON.', 'REQ-RAM-01');
      continue;
    }
    const missing = REQUIRED_MIGRATION_FIELDS.filter((k) => !Object.prototype.hasOwnProperty.call(record, k));
    const extra = Object.keys(record).filter((k) => !REQUIRED_MIGRATION_FIELDS.includes(k));
    let structurallyValid = missing.length === 0 && extra.length === 0;
    if (!structurallyValid) finding(findings, 'INVALID_MIGRATION_RECORD', null, lineNumber, '/', { missing, extra }, 'exact migration record schema', DEFAULT_REGISTRY_AUTHORITY_MIGRATIONS_PATH, 'Migration record has missing or unknown fields.', 'REQ-RAM-01');
    if (typeof record.migrationId === 'string' && seenIds.has(record.migrationId)) { finding(findings, 'DUPLICATE_MIGRATION_ID', null, lineNumber, '/migrationId', record.migrationId, 'unique migrationId', DEFAULT_REGISTRY_AUTHORITY_MIGRATIONS_PATH, 'Duplicate migrationId.', 'REQ-RAM-01'); structurallyValid = false; }
    if (typeof record.migrationId === 'string') seenIds.add(record.migrationId);
    if (canonicalize(record) !== raw) { finding(findings, 'NON_CANONICAL_MIGRATION_RECORD', null, lineNumber, '/', raw, 'canonical JSON serialization', DEFAULT_REGISTRY_AUTHORITY_MIGRATIONS_PATH, 'Migration record bytes are not canonical JSON.', 'REQ-RAM-01'); structurallyValid = false; }
    if (structurallyValid) {
      const payloadOnly = { ...record }; delete payloadOnly.migrationPayloadSha256;
      const expectedPayloadHash = sha256Canonical(payloadOnly);
      if (record.migrationPayloadSha256 !== expectedPayloadHash) { finding(findings, 'MIGRATION_PAYLOAD_HASH_MISMATCH', null, lineNumber, '/migrationPayloadSha256', record.migrationPayloadSha256, expectedPayloadHash, 'sha256(canonicalize(record without migrationPayloadSha256))', 'Migration payload hash is not recalculable.', 'REQ-RAM-01'); structurallyValid = false; }
      if (record.previousMigrationSha256 !== previousPayloadSha) { finding(findings, 'MIGRATION_CHAIN_BREAK', null, lineNumber, '/previousMigrationSha256', record.previousMigrationSha256, previousPayloadSha, 'previousMigrationSha256 chains the preceding record', 'Migration chain is broken.', 'REQ-RAM-01'); structurallyValid = false; }
    }
    if (structurallyValid) {
      const snapshotAbs = path.resolve(root, record.snapshotPath);
      const snapshotOk = safeRelativePath(record.snapshotPath) && fs.existsSync(snapshotAbs) && fs.statSync(snapshotAbs).isFile();
      const snapshotActualSha = snapshotOk ? sha256Bytes(fs.readFileSync(snapshotAbs)) : null;
      if (!snapshotOk || snapshotActualSha !== record.snapshotSha256) { finding(findings, 'SNAPSHOT_TAMPERED', null, lineNumber, '/snapshotPath', record.snapshotPath, record.snapshotSha256, 'live snapshot bytes hash to the declared snapshotSha256', 'Immutable historical-authority snapshot is missing, moved, or its bytes were altered.', 'REQ-RAM-01'); structurallyValid = false; }
      else if (snapshotActualSha !== record.originalAuthoritySha256) { finding(findings, 'SNAPSHOT_DOES_NOT_MATCH_HISTORICAL_HASH', null, lineNumber, '/snapshotPath', snapshotActualSha, record.originalAuthoritySha256, 'snapshot bytes hash to the exact historical authoritySha256 it claims to preserve', 'Snapshot does not reproduce the historical bytes it is meant to freeze.', 'REQ-RAM-01'); structurallyValid = false; }

      const authAbs = path.resolve(root, record.authorizedByPath);
      const authOk = safeRelativePath(record.authorizedByPath) && fs.existsSync(authAbs) && fs.statSync(authAbs).isFile();
      const authActualSha = authOk ? sha256Bytes(fs.readFileSync(authAbs)) : null;
      if (!authOk || authActualSha !== record.authorizedBySha256) { finding(findings, 'MIGRATION_UNAUTHORIZED', null, lineNumber, '/authorizedByPath', record.authorizedByPath, record.authorizedBySha256, 'live authorizing document bytes hash to the declared authorizedBySha256', 'Migration is not backed by a real, hash-matching PROJECT_OWNER authority document.', 'REQ-RAM-01'); structurallyValid = false; }
    }
    if (structurallyValid) {
      previousPayloadSha = record.migrationPayloadSha256;
      const key = `${record.originalAuthorityPath}::${record.originalAuthoritySha256}`;
      if (map.has(key)) { finding(findings, 'DUPLICATE_MIGRATION_KEY', null, lineNumber, '/originalAuthoritySha256', key, 'exactly one valid migration per (path, historical hash) pair', DEFAULT_REGISTRY_AUTHORITY_MIGRATIONS_PATH, 'More than one migration record claims the same historical authority pin; refusing to pick one arbitrarily.', 'REQ-RAM-01'); map.delete(key); }
      else map.set(key, record);
    }
  }
  return map;
}

function resolveAuthority({ root, event, sourceMap, migrations, extraExternalAuthorities, findings, lineNumber }) {
  const authorityPath = event.authorityPath;
  if (typeof authorityPath !== 'string' || !authorityPath) {
    finding(findings, 'MISSING_TRANSITION_AUTHORITY', event, lineNumber, '/authorityPath', authorityPath, 'non-empty relative path or declared external authority id', 'authorityPath + authoritySha256', 'Transition authority is absent.', 'REQ-LED-03');
    return null;
  }

  let filePath;
  let declared = null;
  // RC-3 de-Wheelification: additional external authorities may be declared by an
  // adapter-supplied policy (see governance/gee-v1/adapters/*/external-authority-policy.mjs),
  // separate from the frozen, untouched GENESIS_IMPORT_SOURCE_MAP.json. Both lists are consulted
  // identically; neither is trusted structurally more than the other — both require live bytes to
  // hash-match the declaration below.
  const external = sourceMap?.externalAuthorities?.find((a) => a.authorityId === authorityPath)
    || (Array.isArray(extraExternalAuthorities) ? extraExternalAuthorities.find((a) => a.authorityId === authorityPath) : null);
  if (external) {
    declared = external;
    filePath = path.isAbsolute(external.path) ? external.path : path.resolve(root, external.path);
  } else {
    if (!safeRelativePath(authorityPath)) {
      finding(findings, 'INVALID_AUTHORITY_PATH', event, lineNumber, '/authorityPath', authorityPath, 'normalized relative path or declared external authority id', 'authorityPath + authoritySha256', 'Authority path escapes the governed root or is not declared.', 'REQ-LED-03');
      return null;
    }
    filePath = path.resolve(root, authorityPath);
    const rootPrefix = path.resolve(root) + path.sep;
    if (!filePath.startsWith(rootPrefix)) {
      finding(findings, 'INVALID_AUTHORITY_PATH', event, lineNumber, '/authorityPath', authorityPath, 'path resolved below governed root', 'authorityPath + authoritySha256', 'Authority path resolves outside the governed root.', 'REQ-LED-03');
      return null;
    }
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    finding(findings, 'MISSING_TRANSITION_AUTHORITY', event, lineNumber, '/authorityPath', authorityPath, 'existing regular authority file', 'authorityPath + authoritySha256', 'Transition authority does not exist.', 'REQ-LED-03');
    return null;
  }
  const liveBytes = fs.readFileSync(filePath);
  let actualSha = sha256Bytes(liveBytes);
  let classificationBytes = liveBytes;
  if (actualSha !== event.authoritySha256) {
    const migrationKey = `${authorityPath}::${event.authoritySha256}`;
    const migration = migrations?.get(migrationKey);
    if (migration) {
      // Chain integrity, snapshot integrity and authorization were already verified when the
      // migration log was loaded; re-derive the snapshot hash live so nothing here trusts a
      // precomputed verdict. Resolution succeeds only for this exact historical (path, hash) pin.
      const snapshotAbs = path.resolve(root, migration.snapshotPath);
      const snapshotBytes = fs.existsSync(snapshotAbs) ? fs.readFileSync(snapshotAbs) : null;
      const snapshotSha = snapshotBytes ? sha256Bytes(snapshotBytes) : null;
      if (snapshotSha === event.authoritySha256 && migration.snapshotSha256 === event.authoritySha256) {
        actualSha = snapshotSha;
        classificationBytes = snapshotBytes;
        finding(findings, 'MIGRATED_HISTORICAL_AUTHORITY', event, lineNumber, '/authoritySha256', event.authoritySha256, migration.migrationId, 'resolved via chain-verified REGISTRY_AUTHORITY_MIGRATIONS record', 'Historical authority resolved to an immutable snapshot instead of the live mutable file.', 'REQ-RAM-01', 'INFO');
      } else {
        finding(findings, 'AUTHORITY_HASH_MISMATCH', event, lineNumber, '/authoritySha256', event.authoritySha256, actualSha, 'authoritySha256 recalculated from authority bytes', 'Authority hash differs from the actual authority bytes, and the matching migration record failed live re-verification.', 'REQ-LED-03');
      }
    } else {
      finding(findings, 'AUTHORITY_HASH_MISMATCH', event, lineNumber, '/authoritySha256', event.authoritySha256, actualSha, 'authoritySha256 recalculated from authority bytes', 'Authority hash differs from the actual authority bytes.', 'REQ-LED-03');
    }
  }
  if (declared && declared.sha256 !== actualSha) {
    finding(findings, 'AUTHORITY_MANIFEST_HASH_MISMATCH', event, lineNumber, '/authorityPath', declared.sha256, actualSha, 'external declaration matches authority bytes', 'External authority declaration is stale or divergent.', 'REQ-LED-03');
  }

  let authorityClass = declared?.classification || 'CANONICAL_EVIDENCE';
  try {
    const parsed = JSON.parse(classificationBytes.toString('utf8'));
    if (parsed && parsed.canonical === false && (parsed.generated === true || parsed.generatedFrom || parsed.generatedBy)) authorityClass = 'GENERATED';
  } catch {
    // Binary packages and text authorities are classified by the declared or path-bound class.
  }
  return { filePath, authorityClass, actualSha };
}

export const DEFAULT_GENESIS_IMPORT_SOURCE_MAP_PATH = 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json';

// The default map is always resolved below --root, never below the terminal working directory.
export function resolveSourceMapPath({ root, sourceMapPath = null }) {
  const rootResolved = path.resolve(root);
  if (sourceMapPath === null || sourceMapPath === undefined) {
    return {
      origin: 'CANONICAL_DEFAULT',
      declaredPath: DEFAULT_GENESIS_IMPORT_SOURCE_MAP_PATH,
      resolvedPath: path.resolve(rootResolved, DEFAULT_GENESIS_IMPORT_SOURCE_MAP_PATH)
    };
  }
  const declared = String(sourceMapPath);
  return {
    origin: 'EXPLICIT_OVERRIDE',
    declaredPath: declared,
    resolvedPath: path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(rootResolved, declared)
  };
}

// Fail-closed: an explicit override never silently degrades to the canonical default.
function loadSourceMap({ origin, declaredPath, resolvedPath }, findings) {
  const authorityRequirement = origin === 'EXPLICIT_OVERRIDE'
    ? 'explicit --source-map override'
    : DEFAULT_GENESIS_IMPORT_SOURCE_MAP_PATH;
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    finding(findings, 'MISSING_GENESIS_IMPORT_SOURCE_MAP', null, 0, '/sourceMap', declaredPath, 'existing GENESIS_IMPORT source map file', authorityRequirement, origin === 'EXPLICIT_OVERRIDE' ? 'Explicit --source-map override does not resolve to a file; the canonical default is never substituted.' : 'Canonical GENESIS_IMPORT source map is absent below --root.', 'REQ-BST-01');
    return null;
  }
  let parsed;
  try {
    parsed = readJson(resolvedPath);
  } catch (error) {
    finding(findings, 'INVALID_GENESIS_IMPORT_SOURCE_MAP', null, 0, '/sourceMap', declaredPath, 'parsable canonical JSON source map', authorityRequirement, `GENESIS_IMPORT source map is not parsable JSON: ${error.message}`, 'REQ-BST-01');
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    finding(findings, 'INVALID_GENESIS_IMPORT_SOURCE_MAP', null, 0, '/sourceMap', declaredPath, 'JSON object source map', authorityRequirement, 'GENESIS_IMPORT source map is not a JSON object.', 'REQ-BST-01');
    return null;
  }
  return parsed;
}

/**
 * HISTORICAL_RECONCILIATION proof obligations.
 *
 * Normal execution transitions are unaffected by anything in this function: it runs ONLY for
 * transitionType === HISTORICAL_RECONCILIATION, and such an event has already been rejected unless
 * it appears in the two-entry HISTORICAL_RECONCILIATION_TRANSITIONS table. This function then
 * refuses the transition unless every one of the following re-verifies live, from bytes:
 *
 *   1. the record's own bytes are pinned by the event's authoritySha256 (append-only hash chain);
 *   2. the gate's ONLY prior event is the GENESIS_IMPORT the record names, pinned by its
 *      eventPayloadSha256 — so no synthetic AUTHORIZATION/START/EXECUTION chronology may precede
 *      it, and editing the old genesis event breaks the binding instead of re-basing it;
 *   3. the GENESIS_IMPORT source map independently documents this gate's imported status as an
 *      UNRESOLVED_STATUS_FALLBACK — the record's own assertion is never sufficient;
 *   4. a PROJECT_OWNER authorization document, itself valid against
 *      historical-reconciliation-owner-authorization.schema.json, explicitly allow-lists this exact
 *      (reconciliationId, gateId, historicalDisposition, canonicalCurrentStatus,
 *      evidenceCohortDigest) tuple — so the record never chooses its own evidence cohort, and an
 *      unapproved substitute file cannot be smuggled in behind an approved-looking role;
 *   5. every evidence-cohort item belongs to THIS gate, lives at a portable governed path BELOW
 *      governance/authority/historical/, and its live bytes reproduce the declared byteLength and
 *      SHA-256;
 *   6. at least one cohort item carries the STATUS_DISPOSITION_AUTHORITY role, so the cohort
 *      actually proves the disposition it claims;
 *   7. PARTIAL maps only to INTERRUPTED_RESUMABLE and keeps an evidence-bound residual obligation;
 *   8. COMPLETE_CONFIRMED is unreachable, leaving separate-session external reinspection as the
 *      only path to it.
 *
 * Any failure is BLOCKING: the reconciliation fails closed and the gate keeps its imported status.
 */
function validateHistoricalReconciliation({ root, event, lineNumber, priorOwnEvents, sourceMap, sourceMapResolution, authority, findings }) {
  const before = findings.length;
  const R = (detectorId, jsonPointer, actualValue, expectedRule, message) =>
    finding(findings, detectorId, event, lineNumber, jsonPointer, actualValue, expectedRule, 'HISTORICAL_RECONCILIATION_AUTHORITY', message, 'REQ-HRC-01');

  // COMPLETE_CONFIRMED is already unreachable via the reconciliation table and the existing
  // external-reinspection rule; this is an explicit, independently testable third guard.
  if (event.toStatus === 'COMPLETE_CONFIRMED') {
    R('HISTORICAL_RECONCILIATION_CANNOT_CONFIRM', '/toStatus', event.toStatus, 'COMPLETE_AGENT or INTERRUPTED_RESUMABLE', 'Historical reconciliation can never establish COMPLETE_CONFIRMED; that requires separate-session external confirmation authority.');
  }

  // The record must be an in-repo, portable governed path — never an external authority id that
  // could resolve to a machine-specific absolute location.
  if (!safeRelativePath(event.authorityPath)) {
    R('HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY', '/authorityPath', event.authorityPath, 'portable repository-relative reconciliation record path', 'A historical reconciliation record must be identified by a governed relative path, not an external or absolute locator.');
    return;
  }
  if (!authority) return; // resolveAuthority already reported the missing/invalid authority.
  if (authority.actualSha !== event.authoritySha256) {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/authoritySha256', authority.actualSha, event.authoritySha256, 'Reconciliation record bytes are not pinned by the event; the record is not trusted.');
    return;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(authority.filePath, 'utf8'));
  } catch (error) {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/authorityPath', event.authorityPath, 'parsable historical reconciliation record', `Reconciliation record is not parsable JSON: ${error.message}`);
    return;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/', typeof record, 'JSON object record', 'Reconciliation record is not a JSON object.');
    return;
  }

  const allowedFields = [...HISTORICAL_RECONCILIATION_RECORD_REQUIRED_FIELDS, ...HISTORICAL_RECONCILIATION_RECORD_OPTIONAL_FIELDS];
  const missing = HISTORICAL_RECONCILIATION_RECORD_REQUIRED_FIELDS.filter((k) => !Object.prototype.hasOwnProperty.call(record, k));
  const extra = Object.keys(record).filter((k) => !allowedFields.includes(k));
  if (missing.length || extra.length) {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/', { missing, extra }, 'exact historical-reconciliation.schema.json field set', 'Reconciliation record has missing or unknown fields.');
    return;
  }
  if (record.schemaVersion !== 1) R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/schemaVersion', record.schemaVersion, 'const 1', 'Unsupported reconciliation record schema version.');
  if (record.document !== 'HISTORICAL_RECONCILIATION_RECORD') R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/document', record.document, 'HISTORICAL_RECONCILIATION_RECORD', 'Record does not declare itself a historical reconciliation record.');
  if (typeof record.reconciliationId !== 'string' || !/^HISTORICAL_RECONCILIATION_[A-Z0-9_]{3,64}$/.test(record.reconciliationId)) R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/reconciliationId', record.reconciliationId, 'HISTORICAL_RECONCILIATION_<ID>', 'Invalid reconciliationId.');
  if (!isDateTime(record.recordedAt)) R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/recordedAt', record.recordedAt, 'ISO date-time', 'Invalid reconciliation recordedAt.');
  if (typeof record.reason !== 'string' || !record.reason.trim()) R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/reason', record.reason, 'non-empty reason', 'Reconciliation must state why the correction is truthful.');
  if (record.newExecutionOccurred !== false) R('HISTORICAL_RECONCILIATION_FABRICATED_CHRONOLOGY', '/newExecutionOccurred', record.newExecutionOccurred, 'const false', 'A reconciliation that claims new execution occurred is not a reconciliation.');
  if (record.externalConfirmationEstablished !== false) R('HISTORICAL_RECONCILIATION_CANNOT_CONFIRM', '/externalConfirmationEstablished', record.externalConfirmationEstablished, 'const false', 'A reconciliation can never assert external confirmation.');

  // ----- gate + target binding (evidence and correction must belong to THIS work unit) -----
  if (record.gateId !== event.gateId) R('HISTORICAL_RECONCILIATION_GATE_MISMATCH', '/gateId', record.gateId, event.gateId, 'Reconciliation record belongs to a different gate than the event it authorizes.');
  if (record.canonicalCurrentStatus !== event.toStatus) R('HISTORICAL_RECONCILIATION_TARGET_MISMATCH', '/canonicalCurrentStatus', record.canonicalCurrentStatus, event.toStatus, 'Record target status does not match the ledger event toStatus.');
  if (record.originalImportedStatus !== event.fromStatus) R('HISTORICAL_RECONCILIATION_TARGET_MISMATCH', '/originalImportedStatus', record.originalImportedStatus, event.fromStatus, 'Record original status does not match the ledger event fromStatus.');

  // ----- historical disposition is provenance, not a status: enforce the exact mapping -----
  const expectedStatus = HISTORICAL_DISPOSITION_TO_STATUS.get(record.historicalDisposition);
  if (expectedStatus === undefined) {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/historicalDisposition', record.historicalDisposition, 'COMPLETE or PARTIAL', 'Unknown recovered historical disposition.');
  } else if (record.canonicalCurrentStatus !== expectedStatus) {
    const detectorId = record.historicalDisposition === 'PARTIAL' ? 'HISTORICAL_RECONCILIATION_PARTIAL_OVERREACH' : 'HISTORICAL_RECONCILIATION_DISPOSITION_STATUS_MISMATCH';
    R(detectorId, '/canonicalCurrentStatus', record.canonicalCurrentStatus, expectedStatus, `Recovered historical disposition ${record.historicalDisposition} maps only to ${expectedStatus}.`);
  }

  // ----- the original status must independently be a documented genesis fallback -----
  if (record.originalStatusBasis !== 'UNRESOLVED_STATUS_FALLBACK') {
    R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/originalStatusBasis', record.originalStatusBasis, 'UNRESOLVED_STATUS_FALLBACK', 'Only a documented unresolved-status genesis fallback may be reconciled.');
  }
  const gateSource = sourceMap ? (sourceMap.gates || []).find((g) => g.gateId === event.gateId) : null;
  if (!gateSource) {
    R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/gateId', event.gateId, 'gate present in the active GENESIS_IMPORT source map', 'The active source map does not document this gate, so no fallback basis is proven.');
  } else {
    if (gateSource.confidenceClass !== 'UNRESOLVED_STATUS_FALLBACK') R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/originalStatusBasis', gateSource.confidenceClass, 'UNRESOLVED_STATUS_FALLBACK', 'Source map does not classify this gate as an unresolved-status fallback; its imported status is not a fallback to correct.');
    if (gateSource.importedStatus !== event.fromStatus) R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/originalImportedStatus', gateSource.importedStatus, event.fromStatus, 'Source map imported status does not match the status being corrected.');
  }
  if (!safeRelativePath(record.originalStatusBasisSourcePath)) {
    R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/originalStatusBasisSourcePath', record.originalStatusBasisSourcePath, 'portable repository-relative source map path', 'Fallback basis source must be identified by a governed relative path.');
  } else {
    const basisAbs = path.resolve(root, record.originalStatusBasisSourcePath);
    if (basisAbs !== path.resolve(sourceMapResolution.resolvedPath)) {
      R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/originalStatusBasisSourcePath', record.originalStatusBasisSourcePath, sourceMapResolution.declaredPath, 'Fallback basis must cite the GENESIS_IMPORT source map actually active for this validation, not a substituted one.');
    } else if (!fs.existsSync(basisAbs) || !fs.statSync(basisAbs).isFile()) {
      R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/originalStatusBasisSourcePath', record.originalStatusBasisSourcePath, 'existing source map file', 'Fallback basis source map is absent.');
    } else if (sha256Bytes(fs.readFileSync(basisAbs)) !== record.originalStatusBasisSourceSha256) {
      R('HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS', '/originalStatusBasisSourceSha256', record.originalStatusBasisSourceSha256, sha256Bytes(fs.readFileSync(basisAbs)), 'Fallback basis source map hash does not reproduce its live bytes.');
    }
  }

  // ----- no fabricated chronology: the only prior event for this gate is the pinned genesis -----
  if (priorOwnEvents.some((e) => e.transitionType === HISTORICAL_RECONCILIATION_TRANSITION_TYPE)) {
    R('DUPLICATE_HISTORICAL_RECONCILIATION', '/gateId', event.gateId, 'at most one historical reconciliation per gate', 'This gate has already been reconciled; a second reconciliation would restate history.');
  }
  if (priorOwnEvents.length !== 1 || priorOwnEvents[0].transitionType !== 'GENESIS_IMPORT') {
    R('HISTORICAL_RECONCILIATION_FABRICATED_CHRONOLOGY', '/fromStatus', priorOwnEvents.map((e) => e.transitionType), 'exactly one preceding GENESIS_IMPORT event for this gate', 'Historical reconciliation may only follow the genesis fallback directly; intervening authorization, start or execution chronology would be fabricated.');
  } else {
    const genesis = priorOwnEvents[0];
    if (genesis.eventId !== record.supersededGenesisEventId) R('HISTORICAL_RECONCILIATION_GENESIS_BINDING_MISMATCH', '/supersededGenesisEventId', record.supersededGenesisEventId, genesis.eventId, 'Record supersedes a different genesis event than this gate actually has.');
    // The pin binds the genesis event's ACTUAL bytes, recomputed here, not the hash that event
    // declares about itself. Otherwise editing a historical event and leaving its self-declared
    // hash in place would keep the reconciliation "bound" to history that no longer exists.
    const { eventPayloadSha256: declaredGenesisPayloadSha, ...genesisPayload } = genesis;
    const recomputedGenesisPayloadSha = sha256Canonical(genesisPayload);
    if (recomputedGenesisPayloadSha !== record.supersededGenesisEventPayloadSha256) R('HISTORICAL_RECONCILIATION_GENESIS_BINDING_MISMATCH', '/supersededGenesisEventPayloadSha256', record.supersededGenesisEventPayloadSha256, recomputedGenesisPayloadSha, 'Pinned genesis event payload hash does not match the recomputed bytes of the preserved genesis event; the historical event was altered or the pin is wrong.');
    else if (declaredGenesisPayloadSha !== recomputedGenesisPayloadSha) R('HISTORICAL_RECONCILIATION_GENESIS_BINDING_MISMATCH', '/supersededGenesisEventPayloadSha256', declaredGenesisPayloadSha, recomputedGenesisPayloadSha, 'Preserved genesis event does not recompute its own payload hash; historical history is not byte-intact.');
    if (genesis.toStatus !== event.fromStatus) R('HISTORICAL_RECONCILIATION_GENESIS_BINDING_MISMATCH', '/originalImportedStatus', genesis.toStatus, event.fromStatus, 'Genesis event status and the corrected status do not agree.');
  }

  // ----- the cohort's canonical identity, RECOMPUTED, never taken on the record's word -----
  // This runs before the owner check because the owner approves a DIGEST, not a description: the
  // record supplies the cohort, the validator derives its identity, and the owner decides whether
  // that exact identity was ever approved.
  const nonCanonicalGovernedPath = Array.isArray(record.authorityCohort)
    ? record.authorityCohort.find((item) => item && typeof item === 'object' && !Array.isArray(item) && !isCanonicalGovernedPathUnicode(item.governedPath))
    : null;
  if (nonCanonicalGovernedPath) {
    R('HISTORICAL_RECONCILIATION_NON_CANONICAL_GOVERNED_PATH', '/authorityCohort', nonCanonicalGovernedPath.governedPath, 'governedPath already normalized to Unicode NFC', 'Permanent governedPath identity must be supplied in canonical NFC form; equivalent NFD spellings are rejected before digest and owner matching.');
  }
  const cohortDigest = nonCanonicalGovernedPath
    ? { digest: null, reason: 'NON_CANONICAL_GOVERNED_PATH_UNICODE' }
    : computeEvidenceCohortDigest(record.authorityCohort);
  if (cohortDigest.reason === 'DUPLICATE_COHORT_ENTRY') {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/authorityCohort', 'duplicate cohort entry', 'distinct cohort entries', 'The evidence cohort repeats an identical entry; a duplicated item is never additional proof.');
  }
  if (cohortDigest.digest !== null && record.evidenceCohortDigest !== cohortDigest.digest) {
    R('HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_DIGEST_MISMATCH', '/evidenceCohortDigest', record.evidenceCohortDigest, cohortDigest.digest, `Declared evidenceCohortDigest does not reproduce the record's own authorityCohort under ${EVIDENCE_COHORT_DIGEST_ALGORITHM}; the declared digest is never trusted without recomputation.`);
  }

  // ----- explicit PROJECT_OWNER authorization for this exact reconciliation and exact cohort -----
  if (!safeRelativePath(record.ownerAuthorizationPath)) {
    R('HISTORICAL_RECONCILIATION_UNAUTHORIZED', '/ownerAuthorizationPath', record.ownerAuthorizationPath, 'portable repository-relative owner authorization path', 'Owner authorization must be identified by a governed relative path.');
  } else {
    const ownerAbs = path.resolve(root, record.ownerAuthorizationPath);
    if (!fs.existsSync(ownerAbs) || !fs.statSync(ownerAbs).isFile()) {
      R('HISTORICAL_RECONCILIATION_UNAUTHORIZED', '/ownerAuthorizationPath', record.ownerAuthorizationPath, 'existing owner authorization document', 'Owner authorization document does not exist.');
    } else if (sha256Bytes(fs.readFileSync(ownerAbs)) !== record.ownerAuthorizationSha256) {
      R('HISTORICAL_RECONCILIATION_UNAUTHORIZED', '/ownerAuthorizationSha256', record.ownerAuthorizationSha256, sha256Bytes(fs.readFileSync(ownerAbs)), 'Owner authorization hash does not reproduce its live bytes.');
    } else {
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(ownerAbs, 'utf8')); } catch { owner = null; }
      // Runtime trust and schema validity are the SAME judgement, evaluated by the canonical
      // repository schema validator against the canonical schema file. There is no hand-rolled
      // subset of the schema here to drift out of parity with it: a document the schema rejects
      // (missing authorityId, missing issuedAtUtc, unknown property, wrong const, malformed nested
      // authorizedReconciliations entry, ...) can never authorize a status correction.
      const ownerSchemaResult = owner === null || typeof owner !== 'object' || Array.isArray(owner)
        ? { valid: false, errors: [{ jsonPointer: '/', reason: 'NOT_A_JSON_OBJECT', message: 'owner authorization is not a parsable JSON object' }] }
        : validateAgainstJsonSchema(owner, loadOwnerAuthorizationSchema());
      if (!ownerSchemaResult.valid) {
        R('HISTORICAL_RECONCILIATION_UNAUTHORIZED', '/ownerAuthorizationPath', ownerSchemaResult.errors, 'valid historical-reconciliation-owner-authorization.schema.json document', 'Cited document is not a schema-valid PROJECT_OWNER historical reconciliation authorization; an unrelated or malformed hash-matching file never authorizes a status correction.');
      } else {
        // Identity first, then cohort. Splitting the two makes "the owner never approved this
        // reconciliation at all" and "the owner approved this reconciliation over DIFFERENT
        // evidence" independently observable instead of collapsing into one opaque refusal.
        const identityMatches = owner.authorizedReconciliations.filter((a) =>
          a.reconciliationId === record.reconciliationId
          && a.gateId === event.gateId
          && a.historicalDisposition === record.historicalDisposition
          && a.canonicalCurrentStatus === event.toStatus);
        if (identityMatches.length === 0) {
          R('HISTORICAL_RECONCILIATION_TARGET_NOT_AUTHORIZED', '/canonicalCurrentStatus', { reconciliationId: record.reconciliationId, gateId: event.gateId, historicalDisposition: record.historicalDisposition, canonicalCurrentStatus: event.toStatus }, 'tuple present in owner authorizedReconciliations', 'The owner has not explicitly authorized this reconciliation id, gate, disposition and target status.');
        } else if (cohortDigest.digest === null || !identityMatches.some((a) => a.evidenceCohortDigest === cohortDigest.digest)) {
          R('HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_NOT_AUTHORIZED', '/authorityCohort', { recomputed: cohortDigest.digest, reason: cohortDigest.reason, authorized: identityMatches.map((a) => a.evidenceCohortDigest) }, 'recomputed evidenceCohortDigest present in the owner-authorized tuple', 'The evidence cohort actually used is not the cohort the owner approved for this reconciliation; a substituted file, role or governed path is never authorized by an approval of different evidence.');
        }
      }
    }
  }

  // ----- byte-authentic evidence cohort, portable identity, this gate only -----
  const cohort = record.authorityCohort;
  const roles = new Set();
  const cohortByGovernedPath = new Map();
  if (!Array.isArray(cohort) || cohort.length === 0) {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/authorityCohort', Array.isArray(cohort) ? cohort.length : typeof cohort, 'non-empty authority cohort array', 'A reconciliation must bind at least one imported historical authority.');
  } else {
    for (let k = 0; k < cohort.length; k += 1) {
      const item = cohort[k];
      const pointer = `/authorityCohort/${k}`;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        R('INVALID_HISTORICAL_RECONCILIATION_RECORD', pointer, typeof item, 'cohort item object', 'Authority cohort item is not an object.');
        continue;
      }
      const itemMissing = HISTORICAL_RECONCILIATION_COHORT_REQUIRED_FIELDS.filter((k2) => !Object.prototype.hasOwnProperty.call(item, k2));
      const itemExtra = Object.keys(item).filter((k2) => !HISTORICAL_RECONCILIATION_COHORT_REQUIRED_FIELDS.includes(k2));
      if (itemMissing.length || itemExtra.length) {
        R('INVALID_HISTORICAL_RECONCILIATION_RECORD', pointer, { missing: itemMissing, extra: itemExtra }, 'exact cohort item field set', 'Authority cohort item has missing or unknown fields.');
        continue;
      }
      if (typeof item.evidenceRole !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(item.evidenceRole)) R('INVALID_HISTORICAL_RECONCILIATION_RECORD', `${pointer}/evidenceRole`, item.evidenceRole, 'uppercase evidence role token', 'Invalid cohort evidenceRole.');
      else roles.add(item.evidenceRole);
      // The original recovery location is provenance only; it must be present but is never identity.
      if (typeof item.historicalLocator !== 'string' || !item.historicalLocator.trim()) R('INVALID_HISTORICAL_RECONCILIATION_RECORD', `${pointer}/historicalLocator`, item.historicalLocator, 'non-empty historical locator', 'Cohort item must retain the original historical locator as provenance.');
      if (item.gateId !== event.gateId) R('HISTORICAL_RECONCILIATION_GATE_MISMATCH', `${pointer}/gateId`, item.gateId, event.gateId, 'Authority cohort item belongs to another gate and can never support this reconciliation.');
      const pathClass = classifyHistoricalEvidencePath(item.governedPath);
      if (pathClass === 'UNPORTABLE') {
        R('HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY', `${pointer}/governedPath`, item.governedPath, 'portable, normalization-safe repository-relative governed path', 'A machine-specific absolute, non-normalized or escaping location can never be the permanent canonical identity of imported evidence.');
        continue;
      }
      if (pathClass === 'OUTSIDE_ROOT') {
        R('HISTORICAL_RECONCILIATION_EVIDENCE_OUTSIDE_GOVERNED_ROOT', `${pointer}/governedPath`, item.governedPath, `path below ${HISTORICAL_EVIDENCE_GOVERNED_ROOT}/`, 'Recovered historical evidence must live in permanent governed historical storage; an ordinary working file elsewhere in the repository is never historical status authority.');
        continue;
      }
      if (cohortByGovernedPath.has(item.governedPath)) R('INVALID_HISTORICAL_RECONCILIATION_RECORD', `${pointer}/governedPath`, item.governedPath, 'unique governedPath per cohort', 'Duplicate cohort governedPath.');
      cohortByGovernedPath.set(item.governedPath, item);
      const filesystemPath = resolveHistoricalEvidenceFilesystemPath({ root, governedPath: item.governedPath });
      if (filesystemPath.status === 'MISSING') {
        R('HISTORICAL_RECONCILIATION_AUTHORITY_MISSING', `${pointer}/governedPath`, item.governedPath, 'existing imported evidence file', 'Imported historical authority is absent; the reconciliation is unproven.');
        continue;
      }
      if (filesystemPath.status !== 'OK') {
        R('HISTORICAL_RECONCILIATION_EVIDENCE_FILESYSTEM_SECURITY', `${pointer}/governedPath`, filesystemPath, 'regular file physically and strictly inside the real historical root', 'Historical authority evidence uses a symlink, junction, reparse indirection, realpath escape or an unresolvable filesystem boundary; the evidence is rejected fail-closed.');
        continue;
      }
      const itemBytes = fs.readFileSync(filesystemPath.realCandidate);
      if (!Number.isInteger(item.byteLength) || item.byteLength !== itemBytes.length) {
        R('HISTORICAL_RECONCILIATION_AUTHORITY_HASH_MISMATCH', `${pointer}/byteLength`, item.byteLength, itemBytes.length, 'Imported evidence byte length does not match the declared length.');
      }
      const itemSha = sha256Bytes(itemBytes);
      if (itemSha !== item.sha256) {
        R('HISTORICAL_RECONCILIATION_AUTHORITY_HASH_MISMATCH', `${pointer}/sha256`, item.sha256, itemSha, 'Imported evidence bytes do not hash to the declared SHA-256; a regenerated or substituted artifact is never accepted as historical authority.');
      }
    }
    if (!roles.has(STATUS_DISPOSITION_AUTHORITY_ROLE)) {
      R('HISTORICAL_RECONCILIATION_DISPOSITION_NOT_PROVEN', '/authorityCohort', [...roles], `at least one ${STATUS_DISPOSITION_AUTHORITY_ROLE} cohort item`, 'No cohort item establishes the recovered historical disposition, so the target status is unproven.');
    }
  }

  // ----- PARTIAL keeps its residual obligation, evidence-bound -----
  if (record.historicalDisposition === 'PARTIAL') {
    const residual = record.residualObligation;
    if (residual === null || typeof residual !== 'object' || Array.isArray(residual)) {
      R('HISTORICAL_RECONCILIATION_RESIDUAL_OBLIGATION_DROPPED', '/residualObligation', residual === undefined ? 'absent' : typeof residual, 'residual obligation object', 'A partially completed history must carry its residual obligation forward; dropping it would silently discharge unfinished work.');
    } else {
      const residualMissing = HISTORICAL_RECONCILIATION_RESIDUAL_REQUIRED_FIELDS.filter((k) => !Object.prototype.hasOwnProperty.call(residual, k));
      const residualExtra = Object.keys(residual).filter((k) => !HISTORICAL_RECONCILIATION_RESIDUAL_REQUIRED_FIELDS.includes(k));
      if (residualMissing.length || residualExtra.length) {
        R('HISTORICAL_RECONCILIATION_RESIDUAL_OBLIGATION_DROPPED', '/residualObligation', { missing: residualMissing, extra: residualExtra }, 'exact residual obligation field set', 'Residual obligation has missing or unknown fields.');
      } else {
        if (typeof residual.description !== 'string' || !residual.description.trim()) R('HISTORICAL_RECONCILIATION_RESIDUAL_OBLIGATION_DROPPED', '/residualObligation/description', residual.description, 'non-empty description', 'Residual obligation must state what remains unfinished.');
        const bound = cohortByGovernedPath.get(residual.evidenceGovernedPath);
        if (!bound || bound.sha256 !== residual.evidenceSha256) {
          R('HISTORICAL_RECONCILIATION_RESIDUAL_OBLIGATION_DROPPED', '/residualObligation/evidenceGovernedPath', residual.evidenceGovernedPath, 'authority cohort item with matching sha256', 'Residual obligation is not bound to a byte-verified cohort item.');
        }
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(record, 'residualObligation')) {
    R('INVALID_HISTORICAL_RECONCILIATION_RECORD', '/residualObligation', 'present', 'absent unless historicalDisposition is PARTIAL', 'A fully complete recovered history cannot carry a residual obligation.');
  }

  if (findings.length === before) {
    finding(findings, 'HISTORICAL_RECONCILIATION_APPLIED', event, lineNumber, '/toStatus', event.toStatus, record.reconciliationId, 'owner-authorized, evidence-bound historical reconciliation', `Canonical status corrected from an UNRESOLVED_STATUS_FALLBACK genesis import using recovered historical authority (historicalDisposition=${record.historicalDisposition}); no gate execution occurred.`, 'REQ-HRC-01', 'INFO');
  }
}

function checkEventShape(event, findings, lineNumber) {
  const keys = Object.keys(event);
  const missing = REQUIRED_EVENT_FIELDS.filter((key) => !Object.prototype.hasOwnProperty.call(event, key));
  const extra = keys.filter((key) => !REQUIRED_EVENT_FIELDS.includes(key));
  for (const key of missing) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/', undefined, `required field ${key}`, 'event schema', `Required event field ${key} is missing.`, 'REQ-LED-01');
  for (const key of extra) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, `/${key}`, event[key], 'additionalProperties=false', 'event schema', `Unknown event field ${key} is forbidden.`, 'REQ-LED-01');
  if (event.schemaVersion !== 1) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/schemaVersion', event.schemaVersion, 'const 1', 'event schema', 'Unsupported event schema version.', 'REQ-LED-01');
  if (!Number.isInteger(event.ordinal) || event.ordinal < 1) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/ordinal', event.ordinal, 'integer >= 1', 'event schema', 'Invalid ordinal.', 'REQ-LED-01');
  if (typeof event.eventId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(event.eventId)) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/eventId', event.eventId, 'deterministic safe event id', 'event schema', 'Invalid event id.', 'REQ-LED-01');
  // RC-1/RC-5 de-Wheelification: gate-id FORMAT is no longer bounded by a GATE00-40 regex here.
  // The real, generalizing check is REGISTRY MEMBERSHIP (validateLedger, below), which scales to
  // GATE41+ automatically because it reads whatever the registry actually declares.
  if (typeof event.gateId !== 'string' || !event.gateId) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/gateId', event.gateId, 'non-empty string work-unit id', 'event schema', 'gateId must be a non-empty string.', 'REQ-LED-01');
  if (!(event.fromStatus === null || STATUSES.includes(event.fromStatus))) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/fromStatus', event.fromStatus, 'null or status enum', 'event schema', 'Invalid fromStatus.', 'REQ-LED-01');
  if (!STATUSES.includes(event.toStatus)) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/toStatus', event.toStatus, 'status enum', 'event schema', 'Invalid toStatus.', 'REQ-LED-01');
  if (typeof event.transitionType !== 'string' || !TRANSITION_TYPES.includes(event.transitionType)) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/transitionType', event.transitionType, 'transition type enum', 'event schema', 'Invalid transition type.', 'REQ-LED-02');
  if (event.transitionType === 'GENESIS_IMPORT' && event.fromStatus !== null) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/fromStatus', event.fromStatus, 'null for GENESIS_IMPORT', 'IMPORTED_EVIDENCE', 'GENESIS_IMPORT cannot continue a fabricated historical sequence.', 'REQ-LED-02');
  if (event.transitionType !== 'GENESIS_IMPORT' && event.fromStatus === null) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/fromStatus', event.fromStatus, 'non-null for non-GENESIS transition', 'transition table', 'Non-GENESIS transition must name its prior status.', 'REQ-LED-02');
  if (typeof event.authoritySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(event.authoritySha256)) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/authoritySha256', event.authoritySha256, 'lowercase SHA-256', 'event schema', 'Invalid authority hash.', 'REQ-LED-03');
  if (!(event.previousEventSha256 === null || (typeof event.previousEventSha256 === 'string' && /^[a-f0-9]{64}$/.test(event.previousEventSha256)))) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/previousEventSha256', event.previousEventSha256, 'null or lowercase SHA-256', 'event schema', 'Invalid previous event hash.', 'REQ-LED-01');
  if (!isDateTime(event.recordedAt)) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/recordedAt', event.recordedAt, 'ISO date-time', 'event schema', 'Invalid recordedAt.', 'REQ-LED-01');
  if (typeof event.eventPayloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(event.eventPayloadSha256)) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/eventPayloadSha256', event.eventPayloadSha256, 'lowercase SHA-256', 'event schema', 'Invalid event payload hash.', 'REQ-LED-01');
}

// FINAL-07 (generic-core de-Wheelification): this generic, project-agnostic core validator must
// contain NO project-specific report-id/document-shape literal. A COMPLETE_CONFIRMED transition
// always requires an EXTERNAL_REINSPECTION_REPORT-classified authority (checked above,
// independently of this policy); whether that authority's live bytes actually CONSTITUTE a PASS
// for a given event.gateId is entirely delegated to a project-supplied `policy` passed into
// `validateLedger`. Every real caller in this repo (the Wheel adapter, the CLI bootstrap block,
// generate-status-snapshot.mjs, validate-active-gate.mjs) already supplies its own policy — see
// governance/gee-v1/adapters/wheel/external-authority-policy.mjs for the Wheel-specific rule
// (including the legacy GATE12 report shape, preserved there unchanged). Fail-closed default: no
// policy supplied means no reinspection verdict can ever be asserted PASS.
const DEFAULT_POLICY = Object.freeze({
  extraExternalAuthorities: [],
  assertExternalReinspectionVerdict() {
    return false;
  }
});

export function validateLedger({ root, ledgerPath, sourceMapPath = null, registryPath = null, policy = null }) {
  const effectivePolicy = { ...DEFAULT_POLICY, ...(policy || {}) };
  const findings = [];
  const sourceMapResolution = resolveSourceMapPath({ root, sourceMapPath });
  const sourceMap = loadSourceMap(sourceMapResolution, findings);
  const sourceMapReport = {
    origin: sourceMapResolution.origin,
    declaredPath: sourceMapResolution.declaredPath,
    resolvedPath: path.relative(path.resolve(root), sourceMapResolution.resolvedPath).replaceAll('\\', '/'),
    loaded: sourceMap !== null
  };
  if (!fs.existsSync(ledgerPath)) {
    finding(findings, 'MISSING_LEDGER', null, 0, '/', ledgerPath, 'existing NDJSON ledger', 'canonical ledger', 'Ledger file is missing.', 'REQ-LED-01');
    return { valid: false, findings, events: [], ledgerSha256: null, gates: [], sourceMap: sourceMapReport };
  }
  const bytes = fs.readFileSync(ledgerPath);
  const text = bytes.toString('utf8');
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  const events = [];
  const seenIds = new Set();
  const seenOrdinals = new Set();
  let previousRecordedAt = null;
  for (let i = 0; i < rawLines.length; i += 1) {
    const lineNumber = i + 1;
    const raw = rawLines[i];
    if (raw.endsWith('\r')) finding(findings, 'NON_CANONICAL_EVENT', null, lineNumber, '/', 'CRLF', 'LF line ending', 'canonical ledger', 'Ledger must use LF line endings.', 'REQ-LED-01');
    let event;
    try { event = JSON.parse(raw.replace(/\r$/, '')); } catch {
      finding(findings, 'NDJSON_PARSE_ERROR', null, lineNumber, '/', raw, 'one valid JSON object per line', 'canonical ledger', 'Ledger line is not valid JSON.', 'REQ-LED-01');
      continue;
    }
    checkEventShape(event, findings, lineNumber);
    const cleanEvent = { ...event };
    if (canonicalize(cleanEvent) !== raw.replace(/\r$/, '')) finding(findings, 'NON_CANONICAL_EVENT', event, lineNumber, '/', raw, 'canonical JSON serialization', 'canonical ledger', 'Event bytes are not canonical JSON.', 'REQ-LED-01');
    if (seenIds.has(event.eventId)) finding(findings, 'LEDGER_DUPLICATE_EVENT_ID', event, lineNumber, '/eventId', event.eventId, 'unique eventId', 'canonical ledger', 'Duplicate eventId.', 'REQ-LED-01');
    if (seenOrdinals.has(event.ordinal)) finding(findings, 'LEDGER_DUPLICATE_ORDINAL', event, lineNumber, '/ordinal', event.ordinal, 'unique ordinal', 'canonical ledger', 'Duplicate ordinal.', 'REQ-LED-01');
    seenIds.add(event.eventId); seenOrdinals.add(event.ordinal);
    if (event.ordinal !== lineNumber) finding(findings, 'LEDGER_ORDINAL_GAP', event, lineNumber, '/ordinal', event.ordinal, `ordinal ${lineNumber}`, 'canonical ledger', 'Ordinal is not continuous and line-ordered.', 'REQ-LED-01');
    const expectedPrevious = i === 0 ? null : events[i - 1]?.eventPayloadSha256;
    if (event.previousEventSha256 !== expectedPrevious) finding(findings, 'LEDGER_CHAIN_BREAK', event, lineNumber, '/previousEventSha256', event.previousEventSha256, expectedPrevious, 'previousEventSha256 chain', 'Previous event hash does not chain the preceding line.', 'REQ-LED-01');
    const payload = { ...cleanEvent }; delete payload.eventPayloadSha256;
    const expectedPayloadHash = sha256Canonical(payload);
    if (event.eventPayloadSha256 !== expectedPayloadHash) finding(findings, 'LEDGER_CHAIN_BREAK', event, lineNumber, '/eventPayloadSha256', event.eventPayloadSha256, expectedPayloadHash, 'sha256(canonicalize(event without eventPayloadSha256))', 'Event payload hash is not recalculable.', 'REQ-LED-01');
    if (previousRecordedAt && isDateTime(event.recordedAt) && Date.parse(event.recordedAt) < Date.parse(previousRecordedAt)) finding(findings, 'LEDGER_TIMESTAMP_REGRESSION', event, lineNumber, '/recordedAt', event.recordedAt, `>= ${previousRecordedAt}`, 'monotonic recordedAt', 'recordedAt regresses.', 'REQ-LED-01');
    previousRecordedAt = event.recordedAt;
    events.push(event);
  }

  const resolvedRegistryPath = registryPath || path.join(root, 'governance', 'GATE_REGISTRY_00_40.json');
  const registry = fs.existsSync(resolvedRegistryPath) ? readJson(resolvedRegistryPath) : { gates: [] };
  const knownGates = new Set((registry.gates || []).map((g) => g.gateId));
  const migrations = loadRegistryAuthorityMigrations({ root, findings });
  const currentByGate = new Map();
  const genesisCount = new Map();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const lineNumber = i + 1;
    if (!knownGates.has(event.gateId)) finding(findings, 'UNKNOWN_GATE_ID', event, lineNumber, '/gateId', event.gateId, 'gateId in GATE_REGISTRY_00_40.json', 'registry', 'Gate is absent from the real registry.', 'REQ-LED-01');
    const key = `${event.fromStatus ?? 'null'}>${event.toStatus}:${event.transitionType}`;
    // Class separation: a HISTORICAL_RECONCILIATION event is checked ONLY against the two-entry
    // reconciliation table, and every other transition type ONLY against the closed I2 execution
    // table. Neither class can borrow the other's permissions, so normal execution semantics are
    // exactly what they were before reconciliation existed.
    const isHistoricalReconciliation = event.transitionType === HISTORICAL_RECONCILIATION_TRANSITION_TYPE;
    const table = isHistoricalReconciliation ? HISTORICAL_RECONCILIATION_TRANSITIONS : TRANSITIONS;
    const allowed = table.some(([from, to, type]) => `${from ?? 'null'}>${to}:${type}` === key);
    if (!allowed) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/', key, isHistoricalReconciliation ? 'transition in the narrow historical reconciliation table' : 'transition in closed I2 table', 'transition table', isHistoricalReconciliation ? 'Transition is not an authorized historical reconciliation.' : 'Transition is not present in the closed state machine.', 'REQ-LED-02');
    if (event.fromStatus === null) genesisCount.set(event.gateId, (genesisCount.get(event.gateId) || 0) + 1);
    const current = currentByGate.get(event.gateId);
    if (current !== undefined && event.fromStatus !== current) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/fromStatus', event.fromStatus, current, 'fromStatus equals replayed current status', 'fromStatus does not match the replayed gate state.', 'REQ-LED-02');
    currentByGate.set(event.gateId, event.toStatus);
    const authority = resolveAuthority({ root, event, sourceMap, migrations, extraExternalAuthorities: effectivePolicy.extraExternalAuthorities, findings, lineNumber });
    if (authority?.authorityClass === 'GENERATED') finding(findings, 'GENERATED_AUTHORITY_CITED', event, lineNumber, '/authorityPath', event.authorityPath, 'non-generated authority class', 'transition authority classification', 'Generated view cannot be a canonical transition authority.', 'REQ-RNS-01');
    if (isHistoricalReconciliation) {
      validateHistoricalReconciliation({
        root,
        event,
        lineNumber,
        priorOwnEvents: events.slice(0, i).filter((e) => e.gateId === event.gateId),
        sourceMap,
        sourceMapResolution,
        authority,
        findings
      });
    }
    if (event.toStatus === 'COMPLETE_CONFIRMED') {
      const completeAllowed = (event.fromStatus === null && event.transitionType === 'GENESIS_IMPORT') || (event.fromStatus === 'COMPLETE_AGENT' && event.transitionType === 'EXTERNAL_CONFIRMATION');
      if (!completeAllowed) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/toStatus', event.toStatus, 'GENESIS_IMPORT from null or EXTERNAL_CONFIRMATION from COMPLETE_AGENT', 'independent reinspection', 'COMPLETE_CONFIRMED is not reachable through this transition.', 'REQ-LED-02');
      if (authority?.authorityClass !== 'EXTERNAL_REINSPECTION_REPORT') finding(findings, 'COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION', event, lineNumber, '/authorityPath', event.authorityPath, 'EXTERNAL_REINSPECTION_REPORT', 'independent main session', 'COMPLETE_CONFIRMED requires an external reinspection report.', 'REQ-RNS-01');
      else {
        try {
          const report = JSON.parse(fs.readFileSync(authority.filePath, 'utf8'));
          if (!effectivePolicy.assertExternalReinspectionVerdict({ event, report, authorityId: event.authorityPath })) {
            finding(findings, 'COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION', event, lineNumber, '/authorityPath', report.VERDICT, 'policy-asserted PASS bound to this gateId', 'independent main session', 'External authority does not satisfy the reinspection-verdict policy for this work unit.', 'REQ-RNS-01');
          }
        } catch { finding(findings, 'COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION', event, lineNumber, '/authorityPath', event.authorityPath, 'readable external report', 'independent main session', 'External report cannot be read.', 'REQ-RNS-01'); }
      }
    }
  }
  if (sourceMap) {
    const sourceByGate = new Map((sourceMap.gates || []).map((g) => [g.gateId, g]));
    for (const gate of registry.gates || []) {
      const source = sourceByGate.get(gate.gateId);
      const count = genesisCount.get(gate.gateId) || 0;
      if (!source || count !== 1) finding(findings, 'FABRICATED_HISTORY', null, 0, `/gates/${gate.gateId}`, count, 'exactly one GENESIS_IMPORT per gate', 'GENESIS_IMPORT source map', 'Bootstrap cardinality is not exactly one event per gate.', 'REQ-BST-01');
      if (source && source.historicalDetailCompleteness === 'FULL') finding(findings, 'FABRICATED_HISTORY', null, 0, `/gates/${gate.gateId}/historicalDetailCompleteness`, 'FULL', 'FULL forbidden at bootstrap', 'GENESIS_IMPORT source map', 'Full historical detail is not proven.', 'REQ-BST-01');
      if (source && source.fabricatedTransitionCount !== 0) finding(findings, 'FABRICATED_HISTORY', null, 0, `/gates/${gate.gateId}/fabricatedTransitionCount`, source.fabricatedTransitionCount, 0, 'GENESIS_IMPORT source map', 'Source map records fabricated historical transitions.', 'REQ-BST-01');
    }
    if ((sourceMap.gates || []).some((g) => g.importedStatus === 'COMPLETE_CONFIRMED' && g.historicalDetailCompleteness === 'FULL')) finding(findings, 'FABRICATED_HISTORY', null, 0, '/', 'FULL', 'FULL forbidden at bootstrap', 'GENESIS_IMPORT source map', 'Bootstrap contains unsupported full historical detail.', 'REQ-BST-01');
  }
  const ledgerRelativePath = path.relative(root, ledgerPath).replaceAll('\\', '/');
  for (const item of findings) item.ledgerPath ??= ledgerRelativePath;
  const blocking = findings.filter((f) => f.severity === 'BLOCKING');
  return {
    valid: blocking.length === 0,
    findings,
    events: events.map(({ ledgerPath, ...event }) => event),
    ledgerSha256: sha256Bytes(bytes),
    gates: [...currentByGate.entries()].map(([gateId, currentStatus]) => ({ gateId, currentStatus })),
    sourceMap: sourceMapReport
  };
}

/**
 * FINAL-08: reconstruct the exact byte prefix of an append-only NDJSON ledger
 * through (and including) `throughOrdinal` lines. Pure, read-only, no
 * temp-file side effects.
 */
export function reconstructLedgerPrefixBytes(ledgerPath, throughOrdinal) {
  const bytes = fs.readFileSync(ledgerPath);
  const text = bytes.toString('utf8');
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  if (!Number.isInteger(throughOrdinal) || throughOrdinal < 1 || throughOrdinal > rawLines.length) {
    throw new Error(`INVALID_ORDINAL:${throughOrdinal}`);
  }
  return Buffer.from(`${rawLines.slice(0, throughOrdinal).join('\n')}\n`, 'utf8');
}

/**
 * FINAL-08: validate a HISTORICAL PREFIX of the ledger independently of the
 * live full-file hash. An append-only ledger legitimately grows over time; a
 * historical proof pinned "as of ordinal N" must stay reproducible without
 * requiring the live file to stop growing and without ever mutating it.
 *
 * Reconstructs the exact byte prefix through `throughOrdinal`, re-runs the
 * SAME canonical `validateLedger` chain/transition/authority validation
 * against that prefix alone (via a throwaway temp file created OUTSIDE the
 * governed set — never under governance/, always deleted before returning),
 * and — when `expectedPrefixSha256` is supplied — reports whether the
 * reconstructed prefix reproduces the previously pinned historical digest.
 *
 * This is intentionally a pure ADDITION: it never changes what `validateLedger`
 * itself accepts, rejects, or returns for the live ledger.
 */
export function validateLedgerPrefix({ root, ledgerPath, throughOrdinal, expectedPrefixSha256 = null, sourceMapPath = null, registryPath = null, policy = null }) {
  const prefixBytes = reconstructLedgerPrefixBytes(ledgerPath, throughOrdinal);
  const prefixSha256 = sha256Bytes(prefixBytes);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-ledger-prefix-'));
  const tmpLedgerPath = path.join(tmpDir, 'GATE_STATUS_LEDGER.prefix.ndjson');
  let prefixReport;
  try {
    fs.writeFileSync(tmpLedgerPath, prefixBytes);
    prefixReport = validateLedger({ root, ledgerPath: tmpLedgerPath, sourceMapPath, registryPath, policy });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return {
    throughOrdinal,
    prefixSha256,
    expectedPrefixSha256,
    matchesExpectedHistoricalDigest: expectedPrefixSha256 === null ? null : prefixSha256 === expectedPrefixSha256,
    prefixChainValid: prefixReport.valid,
    prefixFindings: prefixReport.findings,
    liveLedgerPath: path.relative(path.resolve(root), path.resolve(ledgerPath)).replaceAll('\\', '/')
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const ledgerPath = path.resolve(option('--ledger', path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson')));
  const sourceMapFlagIndex = process.argv.indexOf('--source-map');
  const sourceMapPath = sourceMapFlagIndex >= 0 ? process.argv[sourceMapFlagIndex + 1] ?? '' : null;
  // CLI default is the Wheel project's own policy (this file stays project-agnostic; only this
  // bootstrap block, analogous to every other tool's CLI default, is Wheel-flavored).
  let policy;
  try {
    ({ WHEEL_EXTERNAL_AUTHORITY_POLICY: policy } = await import('../gee-v1/adapters/wheel/external-authority-policy.mjs'));
  } catch {
    policy = null;
  }
  const report = validateLedger({ root, ledgerPath, sourceMapPath, policy });
  const output = { valid: report.valid, ledgerPath: path.relative(root, ledgerPath).replaceAll('\\', '/'), ledgerSha256: report.ledgerSha256, eventCount: report.events.length, sourceMap: report.sourceMap, findings: report.findings };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
