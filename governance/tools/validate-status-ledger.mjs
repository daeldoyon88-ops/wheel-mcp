import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Canonical, sha256Bytes } from './canonical-json.mjs';
import { validateAgainstJsonSchema } from '../gee-v1/contracts/validate-against-json-schema.mjs';
import { validateStateRevision } from './validate-state-revision.mjs';
import {
  GATE_AUTHORIZATION_TRANSITION_TYPE,
  GATE_AUTHORIZATION_RECORD_KIND,
  GATE_AUTHORIZATION_FROM_STATUS,
  GATE_AUTHORIZATION_TO_STATUS,
  GATE_AUTHORIZATION_MAX_USE,
  GATE_AUTHORIZATION_FIRST_REVISION,
  GATE_AUTHORIZATION_RECORD_FIELDS,
  GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
  GATE_AUTHORIZATION_BINDING_DIGEST_FIELDS,
  GATE_AUTHORIZATION_RECORD_DERIVED_FIELDS,
  GATE_AUTHORIZATION_BINDING_IDENTITY_FIELDS,
  GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES,
  computeGateAuthorizationBindingDigest,
  gateAuthorizationRecordPath,
  gateAuthorizationAuthoritySnapshotPath,
  gateAuthorizationStateCohortPaths,
  gateAuthorizationDerivedCohortPaths,
  validateGateAuthorizationRecordShape,
  validateGateAuthorizationAuthorityShape,
  computeGateAuthorizationLocalRequestDigest,
  verifyOwnerSignature
} from '../gee-v1/core/gate-authorization-authority.mjs';
import {
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  resolveAuthorityMode
} from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import {
  GATE_START_RECORD_KIND,
  GATE_START_AUTHORITY_KIND,
  GATE_START_FROM_STATUS,
  GATE_START_TO_STATUS,
  GATE_START_TRANSITION_TYPE,
  GATE_START_MAX_USE,
  GATE_START_AUTHORITY_FIELDS,
  computeGateStartReadinessDigest,
  computeGateStartRecordDigest,
  computeGateStartBindingDigestFromDigests,
  computeGateStartLocalRequestDigest,
  gateStartRecordPath,
  gateStartAuthorityPath,
  isModernGateStartId,
  validateGateStartRecordShape,
  validateGateStartAuthorityShape,
  verifyOwnerSignature as verifyGateStartOwnerSignature
} from '../gee-v1/core/gate-start-authority.mjs';

export const STATUSES = [
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

export const CONTRACT_SUCCESSION_TRANSITION_TYPE = 'CONTRACT_SUCCESSION';

/**
 * CONTRACT_SUCCESSION class — a THIRD class, following the precedent this file
 * already set when HISTORICAL_RECONCILIATION was added as "a separate class with
 * its own, strictly narrower table".
 *
 * WHY IT IS SEPARATE AND NOT AN I2 ENTRY. The 21-entry NORMAL_EXECUTION table is
 * the closed I2 set and is not widened here: not one entry is added to it,
 * removed from it, or relaxed. Contract succession is not an execution
 * transition — it changes which contract governs the Gate while the Gate keeps
 * doing exactly what it was doing. Its status therefore does not move, which is
 * precisely why it has no place in a table whose whole subject is status change.
 *
 * WHY IT EXISTS AT ALL. Before this, advancing CURRENT_CONTRACT left no trace in
 * the append-only spine: the pointer moved and the ledger never knew. That made
 * the contract lineage unauditable from history alone and, worse, meant a state
 * revision created under a new contract had nothing in the ledger binding it.
 *
 * THE ONE ENTRY IS A SELF-TRANSITION, DELIBERATELY.
 *   IN_PROGRESS -> IN_PROGRESS
 * It cannot start a Gate, cannot close one, cannot confirm one, and cannot reach
 * any status the Gate was not already in. A succession event that changed status
 * would be an execution transition wearing a different name.
 *
 * The three tables are never consulted interchangeably, so a succession can
 * never impersonate an execution transition or a reconciliation, and neither can
 * borrow succession's permissions.
 */
export const CONTRACT_SUCCESSION_TRANSITIONS = [
  ['IN_PROGRESS', 'IN_PROGRESS', 'CONTRACT_SUCCESSION']
];

export const TRANSITION_TYPES = [
  ...NORMAL_EXECUTION_TRANSITION_TYPES,
  HISTORICAL_RECONCILIATION_TRANSITION_TYPE,
  CONTRACT_SUCCESSION_TRANSITION_TYPE
];

const REQUIRED_EVENT_FIELDS = [
  'schemaVersion', 'ordinal', 'eventId', 'gateId', 'fromStatus', 'toStatus',
  'transitionType', 'authorityPath', 'authoritySha256', 'previousEventSha256',
  'recordedAt', 'eventPayloadSha256'
];

/**
 * H4 — NATIVE STATE PIN.
 *
 * From this ordinal onward an event states, in its own bytes, which state
 * revision it leaves the Gate in and the digest of that revision's seal. Before
 * it, events did not, which is why ordinals 57 and 58 need explicit legacy
 * binding records to be interpretable at all.
 *
 * The boundary is enforced in BOTH directions and that is deliberate:
 *
 *   - events at or after 59 MUST carry the pin, so there is never a native-era
 *     event whose state binding has to be guessed, and never a reason to fall
 *     back to a migration record;
 *   - events before 59 must NOT carry it, so history stays byte-identical and
 *     no one can retroactively add a state claim to an event that never made one.
 */
export const NATIVE_STATE_PIN_FIRST_ORDINAL = 59;
export const NATIVE_STATE_PIN_FIELDS = Object.freeze(['stateRevision', 'stateRevisionSealSha256']);

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

/**
 * EVERY declaration of one authority identity, in the ONE order the canonical
 * transition-authority resolver already applies: the frozen GENESIS_IMPORT source map
 * first, then adapter-supplied policy. Returning all matches rather than the first is
 * what lets a caller that must fail closed on ambiguity — Gate-authorization dependency
 * proof — observe a competing declaration instead of silently accepting one of them.
 * `resolveAuthority` keeps taking the first match, so its behaviour is unchanged.
 */
function declaredExternalAuthorities(authorityIdentity, sourceMap, extraExternalAuthorities) {
  return [
    ...(Array.isArray(sourceMap?.externalAuthorities) ? sourceMap.externalAuthorities : []),
    ...(Array.isArray(extraExternalAuthorities) ? extraExternalAuthorities : [])
  ].filter((declaration) => declaration?.authorityId === authorityIdentity);
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
  const external = declaredExternalAuthorities(authorityPath, sourceMap, extraExternalAuthorities)[0] || null;
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

// ===========================================================================
// GATE_AUTHORIZATION proof obligations.
// ===========================================================================

/**
 * The normative field set of a GATE_AUTHORIZATION_RECORD, and the normative
 * binding-digest algorithm and per-artifact projection.
 *
 * These are RE-EXPORTS of the single implementation in
 * governance/gee-v1/core/gate-authorization-authority.mjs, not second copies.
 * Two independent copies of a digest algorithm are two things that can silently
 * drift apart, and a drifted digest would mean the pre-write decision and the
 * permanent ledger re-verification disagree about what the owner approved — the
 * exact failure this primitive exists to prevent. One implementation, two
 * consumers, no drift.
 */
export {
  GATE_AUTHORIZATION_RECORD_FIELDS as GATE_AUTHORIZATION_RECORD_REQUIRED_FIELDS,
  GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
  GATE_AUTHORIZATION_BINDING_DIGEST_FIELDS,
  computeGateAuthorizationBindingDigest
};

/** Owner PUBLIC key. In-governed-set by design: publishing it grants nothing. */
export const GATE_AUTHORIZATION_OWNER_KEY_PATH = 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json';

// Validated at runtime against the SAME schema files the schema-parity tests read, so
// "schema-invalid" and "runtime-rejected" cannot drift apart. Resolved next to this
// module — these are the tool's own contracts, never read from below the validated --root.
const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
export const GATE_AUTHORIZATION_RECORD_SCHEMA_PATH = path.join(SCHEMA_DIR, 'gate-authorization-record.schema.json');
export const GATE_AUTHORIZATION_AUTHORITY_SCHEMA_PATH = path.join(SCHEMA_DIR, 'gate-authorization-authority.schema.json');
export const GATE_START_RECORD_SCHEMA_PATH = path.join(SCHEMA_DIR, 'gate-start-record.schema.json');
export const GATE_START_AUTHORITY_SCHEMA_PATH = path.join(SCHEMA_DIR, 'gate-start-authority.schema.json');
let gateAuthorizationSchemaCache = null;
function loadGateAuthorizationSchemas() {
  gateAuthorizationSchemaCache ??= {
    record: readJson(GATE_AUTHORIZATION_RECORD_SCHEMA_PATH),
    authority: readJson(GATE_AUTHORIZATION_AUTHORITY_SCHEMA_PATH)
  };
  return gateAuthorizationSchemaCache;
}

function loadGateStartSchemas() {
  return {
    record: readJson(GATE_START_RECORD_SCHEMA_PATH),
    authority: readJson(GATE_START_AUTHORITY_SCHEMA_PATH)
  };
}

function readLiveArtifact(root, relativePath) {
  if (!safeRelativePath(relativePath)) return null;
  const abs = path.resolve(root, relativePath);
  if (!path.resolve(abs).startsWith(path.resolve(root) + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const bytes = fs.readFileSync(abs);
  return { bytes, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

/**
 * AUTHORIZATION state semantics are split deliberately:
 *
 *  - CHECKPOINT, OPEN_DEFECTS and STATE_SEAL under R0001 are immutable
 *    historical members and remain byte-pinned by event 57 forever;
 *  - CURRENT_STATE is a mutable projection which may advance to a later
 *    revision, but only through the validated state-seal lineage rooted at
 *    that exact R0001 seal.
 *
 * This is kept in the permanent ledger validator so a later CURRENT_STATE
 * cannot be accepted merely because it looks like valid JSON. The revision
 * validator supplies contiguous revision, seal-member, pointer-hash and
 * previous-seal checks; the checks below bind that result to the AUTHORIZATION
 * root and to the status replayed by the complete ledger.
 */
function validateAuthorizationStateLineage({ root, ledgerPath, event, lineNumber, record, findings }) {
  const R = (detectorId, jsonPointer, actualValue, expectedRule, message) =>
    finding(findings, detectorId, event, lineNumber, jsonPointer, actualValue, expectedRule, 'GATE_AUTHORIZATION_AUTHORITY', message, 'REQ-GAU-01');
  const statePaths = gateAuthorizationStateCohortPaths(event.gateId);
  const authorized = new Map((record.authorizedStateArtifacts || []).map((artifact) => [artifact.cohortRole, artifact]));
  const rootSeal = readLiveArtifact(root, statePaths.STATE_SEAL);
  const rootSealArtifact = authorized.get('STATE_SEAL');
  const authorizedCurrentState = authorized.get('CURRENT_STATE');
  if (!rootSeal || !rootSealArtifact || rootSeal.sha256 !== rootSealArtifact.sha256) {
    R('GATE_AUTHORIZATION_STATE_LINEAGE_ROOT_MISMATCH', '/authorizedStateArtifacts/STATE_SEAL', rootSeal?.sha256 || null, rootSealArtifact?.sha256 || null, 'The current state lineage must begin at the exact R0001 STATE_SEAL authorized by event 57.');
  }

  const current = readLiveArtifact(root, statePaths.CURRENT_STATE);
  if (!current) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_MISSING', '/authorizedStateArtifacts/CURRENT_STATE', statePaths.CURRENT_STATE, 'existing CURRENT_STATE projection', 'The mutable CURRENT_STATE projection is absent.');
    return;
  }
  let currentJson;
  try { currentJson = JSON.parse(current.bytes.toString('utf8')); }
  catch {
    R('GATE_AUTHORIZATION_CURRENT_STATE_INVALID', '/authorizedStateArtifacts/CURRENT_STATE', 'malformed JSON', 'valid CURRENT_STATE JSON', 'CURRENT_STATE is not a parsable projection.');
    return;
  }
  if (currentJson.gateId !== event.gateId) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_GATE_MISMATCH', '/authorizedStateArtifacts/CURRENT_STATE/gateId', currentJson.gateId, event.gateId, 'CURRENT_STATE must belong to the authorized Gate.');
  }
  if (!/^R[0-9]{4}$/.test(currentJson.stateRevision || '')) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_REVISION_INVALID', '/authorizedStateArtifacts/CURRENT_STATE/stateRevision', currentJson.stateRevision, 'R0001 or a later revision', 'CURRENT_STATE must identify a numbered state revision.');
  }
  const expectedRevisionPath = `governance/gates/${event.gateId}/state/revisions/${currentJson.stateRevision}`;
  if (currentJson.revisionPath !== expectedRevisionPath) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_SIDEWAYS', '/authorizedStateArtifacts/CURRENT_STATE/revisionPath', currentJson.revisionPath, expectedRevisionPath, 'CURRENT_STATE may advance only within this Gate\'s revision lineage; sideways pointers are forbidden.');
  }

  const revisionReport = validateStateRevision({
    root,
    gateId: event.gateId,
    currentStatePath: path.resolve(root, statePaths.CURRENT_STATE),
    contractPath: path.resolve(root, 'governance', 'gates', event.gateId, `contracts/EXECUTION_CONTRACT_${GATE_AUTHORIZATION_FIRST_REVISION}.json`)
  });
  if (!revisionReport.valid) {
    R('GATE_AUTHORIZATION_STATE_LINEAGE_INVALID', '/authorizedStateArtifacts/CURRENT_STATE', revisionReport.findings, 'valid contiguous state revisions with a verified seal chain rooted at R0001', 'CURRENT_STATE does not resolve to a valid descendant of the authorized R0001 state.');
  }

  if (currentJson.stateRevision === GATE_AUTHORIZATION_FIRST_REVISION && authorizedCurrentState && current.sha256 !== authorizedCurrentState.sha256) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_R0001_BYTES_CHANGED', '/authorizedStateArtifacts/CURRENT_STATE', authorizedCurrentState.sha256, current.sha256, 'When CURRENT_STATE still points to R0001, its bytes must remain the exact bytes authorized at event 57.');
  }

  const currentSealPath = `${currentJson.revisionPath}/STATE_SEAL.json`;
  const currentSeal = readLiveArtifact(root, currentSealPath);
  if (!currentSeal) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_SEAL_MISSING', '/authorizedStateArtifacts/CURRENT_STATE/stateSealSha256', currentSealPath, 'existing current revision STATE_SEAL', 'CURRENT_STATE must point to an existing seal for its current revision.');
    return;
  }
  if (currentJson.stateSealSha256 !== currentSeal.sha256) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_SEAL_MISMATCH', '/authorizedStateArtifacts/CURRENT_STATE/stateSealSha256', currentJson.stateSealSha256, currentSeal.sha256, 'CURRENT_STATE.stateSealSha256 must reproduce the exact current revision seal bytes.');
  }
  let currentSealJson;
  try { currentSealJson = JSON.parse(currentSeal.bytes.toString('utf8')); }
  catch {
    R('GATE_AUTHORIZATION_CURRENT_STATE_SEAL_INVALID', '/authorizedStateArtifacts/CURRENT_STATE/stateSealSha256', 'malformed JSON', 'valid STATE_SEAL JSON', 'The current revision seal is not parsable.');
    return;
  }
  if (currentSealJson.stateRevision !== currentJson.stateRevision || currentSealJson.gateId !== event.gateId) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_SEAL_IDENTITY_MISMATCH', '/authorizedStateArtifacts/CURRENT_STATE/stateSealSha256', currentSealJson, { gateId: event.gateId, stateRevision: currentJson.stateRevision }, 'The current seal identity must match the CURRENT_STATE projection.');
  }

  let replayedCurrentStatus = null;
  try {
    const events = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    replayedCurrentStatus = events.filter((candidate) => candidate.gateId === event.gateId).at(-1)?.toStatus || null;
  } catch {
    R('GATE_AUTHORIZATION_CURRENT_STATE_REPLAY_UNAVAILABLE', '/authorizedStateArtifacts/CURRENT_STATE', 'unreadable ledger', 'replayed current Gate status', 'CURRENT_STATE status consistency cannot be established without the complete ledger replay.');
  }
  const executionStatus = currentSealJson.payload?.executionStatus;
  if (replayedCurrentStatus !== null && executionStatus !== replayedCurrentStatus) {
    R('GATE_AUTHORIZATION_CURRENT_STATE_STATUS_MISMATCH', '/authorizedStateArtifacts/CURRENT_STATE', executionStatus, replayedCurrentStatus, 'The current revision executionStatus must equal the status replayed by the complete ledger.');
  }
}

/**
 * Resolves a Gate-authorization dependency proof's authorityPath to live bytes under the
 * SAME declaration policy the canonical transition-authority resolver uses.
 *
 * The value is not free-form: it is whatever the dependency Gate's TERMINAL ledger event
 * actually records, and that may legitimately be a declared EXTERNAL AUTHORITY IDENTITY
 * (an opaque id resolved through the source map / adapter policy) rather than a governed
 * repository-relative path. Reading it unconditionally as a path made an identity that the
 * ledger itself already resolves for the dependency's own event unresolvable here, so a
 * dependency proof could never simultaneously satisfy pre-write equality and permanent
 * re-verification.
 *
 * Identity and resolved bytes stay separate concepts: the identity string is never
 * rewritten into the declaration's path — the caller still compares it verbatim.
 *
 * Fail-closed at every branch: an unknown identity, a competing declaration, missing
 * evidence, or a declaration whose own sha256 no longer reproduces its bytes all resolve
 * to nothing, leaving the dependency unproven.
 */
function resolveDependencyAuthority({ root, identity, sourceMap, extraExternalAuthorities }) {
  if (typeof identity !== 'string' || !identity) return { artifact: null, reason: 'DEPENDENCY_AUTHORITY_IDENTITY_ABSENT' };
  const declarations = declaredExternalAuthorities(identity, sourceMap, extraExternalAuthorities);
  if (declarations.length > 1) return { artifact: null, reason: 'COMPETING_EXTERNAL_AUTHORITY_DECLARATIONS' };
  if (declarations.length === 1) {
    const declared = declarations[0];
    const declaredPath = typeof declared.path === 'string' ? declared.path : '';
    if (!declaredPath) return { artifact: null, reason: 'DECLARED_EXTERNAL_AUTHORITY_PATH_INVALID' };
    const filePath = path.isAbsolute(declaredPath) ? declaredPath : path.resolve(root, declaredPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { artifact: null, reason: 'DECLARED_EXTERNAL_AUTHORITY_EVIDENCE_MISSING' };
    }
    const bytes = fs.readFileSync(filePath);
    const artifact = { bytes, sha256: sha256Bytes(bytes), byteLength: bytes.length };
    // The declaration never outranks the bytes it points at.
    if (declared.sha256 !== artifact.sha256) return { artifact: null, reason: 'DECLARED_EXTERNAL_AUTHORITY_HASH_DRIFT' };
    return { artifact, reason: null };
  }
  // Undeclared: the identity must be an ordinary governed repository-relative authority,
  // resolved exactly as before — traversal and absolute forms are refused by readLiveArtifact.
  const artifact = readLiveArtifact(root, identity);
  return artifact ? { artifact, reason: null } : { artifact: null, reason: 'DEPENDENCY_AUTHORITY_ABSENT' };
}

/**
 * Resolves a transition-authority identity through the exact same source-map and
 * adapter-policy mechanism used by permanent ledger validation.  Callers retain
 * the logical identity in the event; only the bytes used to compute its digest
 * are resolved here.
 */
export function resolveDeclaredAuthorityIdentity({ root, identity, sourceMapPath = null, policy = null }) {
  const findings = [];
  const sourceMapResolution = resolveSourceMapPath({ root, sourceMapPath });
  const sourceMap = loadSourceMap(sourceMapResolution, findings);
  if (!sourceMap) return { artifact: null, reason: findings[0]?.detectorId ?? 'SOURCE_MAP_UNRESOLVABLE' };
  return resolveDependencyAuthority({
    root,
    identity,
    sourceMap,
    extraExternalAuthorities: policy?.extraExternalAuthorities
  });
}

/**
 * AUTHORIZATION proof obligations.
 *
 * Runs ONLY for transitionType === AUTHORIZATION. Such an event has already been
 * rejected unless it appears in the closed I2 execution table, which admits
 * exactly one AUTHORIZATION entry: NOT_STARTED -> AUTHORIZED_NOT_STARTED.
 *
 * This function then refuses the transition unless every one of the following
 * re-verifies live, from bytes:
 *
 *   1. the event's authority is the Gate's GATE_AUTHORIZATION_RECORD, at the exact
 *      deterministic governed path for this Gate, with its bytes pinned by the
 *      event's authoritySha256 (append-only hash chain);
 *   2. the record is schema-valid and structurally valid under the closed-world
 *      core rules (which make START and execution privilege unrepresentable);
 *   3. an owner-signed ACTIVE_GATE_AUTHORIZATION_AUTHORITY snapshot exists at the
 *      exact deterministic governed path for this Gate, is schema-valid, and its
 *      ed25519 PROJECT_OWNER signature verifies;
 *   4. the approved binding digest RECOMPUTES from the authority's own cohort —
 *      the owner approved a digest, never a description;
 *   5. record and authority agree on every identity field, the dependency proof
 *      and both artifact cohorts;
 *   6. the transition identity in the event matches the record exactly;
 *   7. the event chain pin (previousEventSha256) and the pre-ledger digest both
 *      reproduce from the real append-only prefix that precedes this event;
 *   8. the immediate dependency Gate had really reached a terminal status at this
 *      point in the replayed ledger;
 *   9. the Gate's contract and CURRENT_CONTRACT bytes still hash as approved;
 *  10. the immutable R0001 STATE members reproduce the approved sha256 and
 *      byteLength forever, while CURRENT_STATE is verified through its
 *      validated descendant seal lineage and replayed status;
 *  11. the DERIVED cohort is exactly the four approved generated views;
 *  12. the authority had not expired AS OF the event's recordedAt;
 *  13. maxUse is 1 and this is the Gate's only AUTHORIZATION event.
 *
 * Any failure is BLOCKING: the authorization fails closed and the Gate keeps
 * NOT_STARTED.
 *
 * DERIVED-COHORT PERMANENCE, stated explicitly rather than left implicit. The
 * four derived artifacts are whole-project generated views: GATE_STATUS_SNAPSHOT
 * and ACTIVE_GATE_CONTEXT legitimately change every time ANY Gate's state
 * changes. Pinning their bytes permanently would mean this Gate's authorization
 * event turns INVALID the moment the next Gate is authorized — a self-inflicted
 * future ledger break, and a direct contradiction of the constitutional rule
 * GENERATED_FILES_NON_CANONICAL. So permanence is split by what is actually
 * immutable: STATE bytes are enforced forever (10); DERIVED artifacts are
 * enforced forever as an exact PATH cohort (11), while their approved bytes
 * remain permanently recorded in the owner-signed authority and are verified
 * live, at authorization time, by the pre-write source adapter. The point-in-time
 * byte attestation is disclosed below as an INFO finding rather than silently
 * dropped.
 */
function validateGateAuthorization({ root, ledgerPath, event, lineNumber, priorOwnEvents, priorEvents = [], replayedStatusByGate, authority, sourceMap, policy, mode = MODE_FULL, isGateHeadEvent = true, findings }) {
  // TWO DIFFERENT QUESTIONS, TWO DIFFERENT GUARDS — conflating them is a bug in
  // both directions.
  //
  //   integrityOnly   is this a historical replay? Then no present projection
  //                   may be consulted at all.
  //   pointerPinApplies  may this event's pin of a MUTABLE pointer still be
  //                   compared to live bytes? Only while this event is the HEAD
  //                   for its Gate. Once superseded, that pin is a historical
  //                   observation, and demanding it still hold is the "mutable
  //                   projection pinned forever" defect MODEL D forbids.
  //
  // The CURRENT_STATE lineage check below is present-tense but NOT a pointer
  // pin: it proves today's state still descends from the authorized R0001 root,
  // which stays meaningful long after this event stops being the head.
  const integrityOnly = mode === MODE_LEDGER_INTEGRITY;
  const pointerPinApplies = !integrityOnly && isGateHeadEvent;
  const before = findings.length;
  const R = (detectorId, jsonPointer, actualValue, expectedRule, message) =>
    finding(findings, detectorId, event, lineNumber, jsonPointer, actualValue, expectedRule, 'GATE_AUTHORIZATION_AUTHORITY', message, 'REQ-GAU-01');

  // ----- the record must be an in-repo, portable governed path at the exact template -----
  const expectedRecordPath = gateAuthorizationRecordPath(event.gateId);
  if (!safeRelativePath(event.authorityPath)) {
    R('GATE_AUTHORIZATION_UNPORTABLE_AUTHORITY_IDENTITY', '/authorityPath', event.authorityPath, 'portable repository-relative authorization record path', 'A Gate authorization record must be identified by a governed relative path, not an external or absolute locator.');
    return;
  }
  if (event.authorityPath !== expectedRecordPath) {
    R('GATE_AUTHORIZATION_RECORD_PATH_NOT_AUTHORIZED', '/authorityPath', event.authorityPath, expectedRecordPath, 'Gate authorization record is not at the exact deterministic governed path for this Gate; no other location may authorize a Gate.');
    return;
  }
  if (!authority) return; // resolveAuthority already reported the missing/invalid authority.
  if (authority.actualSha !== event.authoritySha256) {
    R('INVALID_GATE_AUTHORIZATION_RECORD', '/authoritySha256', authority.actualSha, event.authoritySha256, 'Authorization record bytes are not pinned by the event; the record is not trusted.');
    return;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(authority.filePath, 'utf8'));
  } catch (error) {
    R('INVALID_GATE_AUTHORIZATION_RECORD', '/authorityPath', event.authorityPath, 'parsable Gate authorization record', `Authorization record is not parsable JSON: ${error.message}`);
    return;
  }

  const schemas = loadGateAuthorizationSchemas();
  const recordSchemaResult = validateAgainstJsonSchema(record, schemas.record);
  if (!recordSchemaResult.valid) {
    R('INVALID_GATE_AUTHORIZATION_RECORD', '/', recordSchemaResult.errors, 'valid gate-authorization-record.schema.json document', 'Authorization record is not schema-valid.');
  }
  const recordShape = validateGateAuthorizationRecordShape(record);
  if (!recordShape.valid) {
    R('INVALID_GATE_AUTHORIZATION_RECORD', '/', recordShape.findings, 'closed-world GATE_AUTHORIZATION_RECORD structure', 'Authorization record violates the closed-world authorization structure.');
  }

  // ----- the owner-signed authority snapshot, at its own exact deterministic path -----
  const snapshotPath = gateAuthorizationAuthoritySnapshotPath(event.gateId);
  const snapshot = readLiveArtifact(root, snapshotPath);
  let ownerAuthority = null;
  if (!snapshot) {
    R('GATE_AUTHORIZATION_OWNER_AUTHORITY_MISSING', '/authorityPath', snapshotPath, 'existing owner-signed authorization snapshot', 'No byte-identical PROJECT_OWNER authorization snapshot is preserved for this Gate; the authorization is unproven.');
  } else {
    try { ownerAuthority = JSON.parse(snapshot.bytes.toString('utf8')); } catch { ownerAuthority = null; }
    const authoritySchemaResult = ownerAuthority === null || typeof ownerAuthority !== 'object' || Array.isArray(ownerAuthority)
      ? { valid: false, errors: [{ jsonPointer: '/', reason: 'NOT_A_JSON_OBJECT', message: 'owner authority is not a parsable JSON object' }] }
      : validateAgainstJsonSchema(ownerAuthority, schemas.authority);
    if (!authoritySchemaResult.valid) {
      R('GATE_AUTHORIZATION_UNAUTHORIZED', '/authorityPath', authoritySchemaResult.errors, 'valid gate-authorization-authority.schema.json document', 'Preserved owner authorization snapshot is not a schema-valid PROJECT_OWNER Gate authorization authority.');
      ownerAuthority = null;
    } else {
      const authorityShape = validateGateAuthorizationAuthorityShape(ownerAuthority, { recordedAt: record?.recordedAt ?? null });
      if (!authorityShape.valid) {
        R('GATE_AUTHORIZATION_UNAUTHORIZED', '/authorityPath', authorityShape.findings, 'closed-world ACTIVE_GATE_AUTHORIZATION_AUTHORITY structure', 'Owner authorization snapshot violates the closed-world authority structure (this includes a self-inconsistent approvedBindingDigest).');
        ownerAuthority = null;
      }
    }
  }

  if (ownerAuthority) {
    const authorityMode = resolveAuthorityMode(ownerAuthority, { defaultLegacy: false });
    if (authorityMode === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE) {
      const localRequestDigest = computeGateAuthorizationLocalRequestDigest(ownerAuthority);
      if (ownerAuthority.approvedRequestDigest !== localRequestDigest) {
        R('GATE_AUTHORIZATION_LOCAL_REQUEST_DIGEST_INVALID', '/approvedRequestDigest', ownerAuthority.approvedRequestDigest, localRequestDigest, 'LOCAL_EXPLICIT_AUTHORITY must bind its exact local authority projection; no external request is accepted.');
      }
    } else {
      // ----- ed25519 PROJECT_OWNER signature over the authority minus its signature -----
      const keyRelativePath = policy?.gateAuthorizationOwnerKeyPath || GATE_AUTHORIZATION_OWNER_KEY_PATH;
      const keyArtifact = readLiveArtifact(root, keyRelativePath);
      let ownerKey = null;
      if (keyArtifact) {
        try {
          const parsed = JSON.parse(keyArtifact.bytes.toString('utf8'));
          if (typeof parsed?.keyId === 'string' && typeof parsed?.publicKeyPem === 'string' && !/PRIVATE KEY/.test(parsed.publicKeyPem)) {
            ownerKey = { keyId: parsed.keyId, publicKeyPem: parsed.publicKeyPem };
          }
        } catch { ownerKey = null; }
      }
      if (!ownerKey) {
        R('GATE_AUTHORIZATION_UNAUTHORIZED', '/authorityPath', keyRelativePath, 'readable PROJECT_OWNER ed25519 public key', 'The PROJECT_OWNER public key is absent or unusable, so the owner signature can never be verified.');
      } else {
        const signature = verifyOwnerSignature(ownerAuthority, ownerKey);
        if (!signature.verified) {
          R('GATE_AUTHORIZATION_OWNER_SIGNATURE_INVALID', '/authorityPath', signature.reason, 'verified ed25519 PROJECT_OWNER signature', 'The owner signature over the Gate authorization authority does not verify; the authorization is forged, mutated or signed by an unknown key.');
        }
      }
    }

    // ----- the owner approved a DIGEST: recompute it, never read it -----
    const recomputed = computeGateAuthorizationBindingDigest({
      ...ownerAuthority,
      recordedAt: record?.recordedAt ?? null,
      stateArtifacts: ownerAuthority.authorizedStateArtifacts,
      derivedArtifacts: ownerAuthority.authorizedDerivedArtifacts
    });
    if (recomputed.digest === null) {
      R('GATE_AUTHORIZATION_BINDING_DIGEST_MISMATCH', '/authorityPath', recomputed.reason, `computable ${GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM} digest`, 'The approved binding cohort cannot be projected into a canonical identity.');
    } else if (ownerAuthority.approvedBindingDigest !== recomputed.digest) {
      R('GATE_AUTHORIZATION_BINDING_DIGEST_MISMATCH', '/authorityPath', ownerAuthority.approvedBindingDigest, recomputed.digest, `Declared approvedBindingDigest does not reproduce the authority's own cohort under ${GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM}; the declared digest is never trusted without recomputation.`);
    }

    // ----- record and owner authority must describe the SAME authorization -----
    if (recordShape.valid) {
      for (const field of [...GATE_AUTHORIZATION_BINDING_IDENTITY_FIELDS, 'executionAuthorized']) {
        if (field === 'recordedAt') continue; // approved through the signed binding digest above
        if (ownerAuthority[field] !== record[field]) {
          R('GATE_AUTHORIZATION_RECORD_AUTHORITY_MISMATCH', `/${field}`, record[field], ownerAuthority[field], `Authorization record and owner authority disagree on ${field}; the owner approved a different authorization than the ledger pins.`);
        }
      }
      if (resolveAuthorityMode(ownerAuthority) !== resolveAuthorityMode(record)) {
        R('GATE_AUTHORIZATION_RECORD_AUTHORITY_MISMATCH', '/authorityMode', record.authorityMode, ownerAuthority.authorityMode, 'Authorization record and authority must select the same mutually exclusive authority mode.');
      }
      for (const field of ['gateId', 'status', 'authorityPath', 'authoritySha256']) {
        if (ownerAuthority.dependencyProof?.[field] !== record.dependencyProof?.[field]) {
          R('GATE_AUTHORIZATION_RECORD_AUTHORITY_MISMATCH', `/dependencyProof/${field}`, record.dependencyProof?.[field], ownerAuthority.dependencyProof?.[field], `Authorization record and owner authority disagree on dependencyProof.${field}.`);
        }
      }
      const projectCohortKey = (cohort, fields) => canonicalize(
        (Array.isArray(cohort) ? cohort : [])
          .map((item) => {
            const row = {};
            for (const field of fields) row[field] = item?.[field];
            return canonicalize(row);
          })
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      );
      // STATE is compared on full bytes; DERIVED is compared on paths alone, because
      // the record cannot carry post-authorization derived hashes (see the note above).
      if (projectCohortKey(ownerAuthority.authorizedStateArtifacts, GATE_AUTHORIZATION_BINDING_DIGEST_FIELDS)
        !== projectCohortKey(record.authorizedStateArtifacts, GATE_AUTHORIZATION_BINDING_DIGEST_FIELDS)) {
        R('GATE_AUTHORIZATION_RECORD_AUTHORITY_MISMATCH', '/authorizedStateArtifacts', 'record cohort', 'owner-approved cohort', 'The sealed state cohort the ledger pins is not the cohort the owner approved; a substituted artifact is never authorized by an approval of different artifacts.');
      }
      if (projectCohortKey(ownerAuthority.authorizedDerivedArtifacts, GATE_AUTHORIZATION_RECORD_DERIVED_FIELDS)
        !== projectCohortKey(record.authorizedDerivedArtifacts, GATE_AUTHORIZATION_RECORD_DERIVED_FIELDS)) {
        R('GATE_AUTHORIZATION_RECORD_AUTHORITY_MISMATCH', '/authorizedDerivedArtifacts', 'record derived paths', 'owner-approved derived paths', 'The derived view cohort the ledger pins is not the cohort the owner approved.');
      }
    }

    // ----- expiry is judged AS OF the event, never against the wall clock -----
    const expiry = Date.parse(ownerAuthority.expiresAtUtc);
    const recordedAt = Date.parse(event.recordedAt);
    if (!Number.isNaN(expiry) && !Number.isNaN(recordedAt) && recordedAt > expiry) {
      R('GATE_AUTHORIZATION_EXPIRED', '/recordedAt', event.recordedAt, ownerAuthority.expiresAtUtc, 'The owner authorization had already expired when this transition was recorded.');
    }
    if (ownerAuthority.maxUse !== GATE_AUTHORIZATION_MAX_USE) {
      R('GATE_AUTHORIZATION_MAX_USE_INVALID', '/authorityPath', ownerAuthority.maxUse, GATE_AUTHORIZATION_MAX_USE, 'A Gate authorization authority is single-use by construction.');
    }
  }

  if (!recordShape.valid) {
    if (findings.length === before) R('INVALID_GATE_AUTHORIZATION_RECORD', '/', 'unusable record', 'structurally valid record', 'Authorization record is unusable.');
    return;
  }

  // ----- transition identity: the event must be exactly what the record describes -----
  if (record.gateId !== event.gateId) R('GATE_AUTHORIZATION_GATE_MISMATCH', '/gateId', record.gateId, event.gateId, 'Authorization record belongs to a different Gate than the event it authorizes.');
  if (record.fromStatus !== event.fromStatus) R('GATE_AUTHORIZATION_TRANSITION_MISMATCH', '/fromStatus', record.fromStatus, event.fromStatus, 'Record fromStatus does not match the ledger event.');
  if (record.toStatus !== event.toStatus) R('GATE_AUTHORIZATION_TRANSITION_MISMATCH', '/toStatus', record.toStatus, event.toStatus, 'Record toStatus does not match the ledger event.');
  if (record.transitionType !== event.transitionType) R('GATE_AUTHORIZATION_TRANSITION_MISMATCH', '/transitionType', record.transitionType, event.transitionType, 'Record transitionType does not match the ledger event.');
  if (record.recordedAt !== event.recordedAt) R('GATE_AUTHORIZATION_RECORDED_AT_MISMATCH', '/recordedAt', record.recordedAt, event.recordedAt, 'The owner-bound authorization timestamp in the record must exactly equal the ledger event recordedAt.');
  if (event.fromStatus !== GATE_AUTHORIZATION_FROM_STATUS || event.toStatus !== GATE_AUTHORIZATION_TO_STATUS) {
    R('GATE_AUTHORIZATION_TRANSITION_MISMATCH', '/', `${event.fromStatus}>${event.toStatus}`, `${GATE_AUTHORIZATION_FROM_STATUS}>${GATE_AUTHORIZATION_TO_STATUS}`, 'AUTHORIZATION may only carry NOT_STARTED -> AUTHORIZED_NOT_STARTED.');
  }

  // ----- exactly one AUTHORIZATION per Gate -----
  if (priorOwnEvents.some((e) => e.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE)) {
    R('DUPLICATE_GATE_AUTHORIZATION', '/gateId', event.gateId, 'at most one AUTHORIZATION per Gate', 'This Gate has already been authorized; a second authorization would re-grant a spent single-use authority.');
  }

  // ----- append-only chain pins: both reproduce from the REAL preceding prefix -----
  if (record.previousEventSha256 !== event.previousEventSha256) {
    R('GATE_AUTHORIZATION_EVENT_CHAIN_MISMATCH', '/previousEventSha256', record.previousEventSha256, event.previousEventSha256, 'The record pins a different ledger head than the event actually continues.');
  }
  if (Number.isInteger(event.ordinal) && event.ordinal > 1 && ledgerPath) {
    let prefixSha = null;
    try { prefixSha = sha256Bytes(reconstructLedgerPrefixBytes(ledgerPath, event.ordinal - 1)); } catch { prefixSha = null; }
    if (prefixSha === null) {
      R('GATE_AUTHORIZATION_PRE_LEDGER_MISMATCH', '/preLedgerSha256', 'unreconstructable', 'reproducible append-only prefix', 'The ledger prefix preceding this authorization cannot be reconstructed.');
    } else if (record.preLedgerSha256 !== prefixSha) {
      R('GATE_AUTHORIZATION_PRE_LEDGER_MISMATCH', '/preLedgerSha256', record.preLedgerSha256, prefixSha, 'The pre-ledger digest the owner approved is not the digest of the real append-only prefix this event was appended to.');
    }
  }

  // ----- the immediate dependency really was terminal at this point in the replay -----
  const dependency = record.dependencyProof;
  const dependencyStatus = replayedStatusByGate?.get(dependency?.gateId);
  if (dependency?.gateId === event.gateId) {
    R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/gateId', dependency.gateId, 'a different Gate', 'A Gate can never be its own authorization dependency.');
  } else if (dependencyStatus === undefined) {
    R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/gateId', dependency?.gateId, 'dependency Gate present in the replayed ledger', 'The declared dependency Gate has no replayed status at this point in the ledger.');
  } else if (dependencyStatus !== dependency.status) {
    R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/status', dependency.status, dependencyStatus, 'The declared dependency status is not the status the ledger actually replays for that Gate.');
  } else if (!GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES.includes(dependencyStatus)) {
    R('GATE_AUTHORIZATION_DEPENDENCY_NOT_TERMINAL', '/dependencyProof/status', dependencyStatus, GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES.join(' or '), 'The dependency Gate had not reached a terminal status, so this Gate was not authorizable.');
  }
  const dependencyResolution = resolveDependencyAuthority({
    root,
    identity: dependency?.authorityPath,
    sourceMap,
    extraExternalAuthorities: policy?.extraExternalAuthorities
  });
  const dependencyAuthority = dependencyResolution.artifact;
  if (!dependencyAuthority) {
    R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/authorityPath', dependency?.authorityPath, 'dependency authority resolvable as a governed path or a declared external authority identity', `The cited dependency authority could not be resolved to trusted evidence (${dependencyResolution.reason}).`);
  } else if (dependencyAuthority.sha256 !== dependency.authoritySha256) {
    R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/authoritySha256', dependency.authoritySha256, dependencyAuthority.sha256, 'The cited dependency authority hash does not reproduce the resolved authority bytes.');
  }

  // The proof must carry the dependency Gate's ACTUAL terminal ledger representation —
  // derived here exactly as the pre-write adapter derives it, from the replayed prefix —
  // so a stale, substituted or merely equivalent identity is refused even when it happens
  // to resolve to the right bytes. This is what keeps pre-write equality and permanent
  // re-verification answering the same question about the same value.
  const dependencyTerminalEvent = priorEvents.filter((e) => e.gateId === dependency?.gateId).at(-1) || null;
  if (!dependencyTerminalEvent) {
    R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/gateId', dependency?.gateId, 'dependency Gate with a terminal event in the replayed ledger', 'The declared dependency Gate has no terminal ledger event at this point in the ledger.');
  } else {
    if (dependencyTerminalEvent.authorityPath !== dependency.authorityPath) {
      R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/authorityPath', dependency.authorityPath, dependencyTerminalEvent.authorityPath, 'The dependency proof does not carry the authority identity the dependency Gate terminal event actually records.');
    }
    if (dependencyTerminalEvent.authoritySha256 !== dependency.authoritySha256) {
      R('GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', '/dependencyProof/authoritySha256', dependency.authoritySha256, dependencyTerminalEvent.authoritySha256, 'The dependency proof does not carry the authority hash the dependency Gate terminal event actually records.');
    }
  }

  // ----- a valid CURRENT_CONTRACT, hash-matched, must exist for this Gate -----
  const contractPath = `governance/gates/${event.gateId}/contracts/EXECUTION_CONTRACT_${GATE_AUTHORIZATION_FIRST_REVISION}.json`;
  const currentContractPath = `governance/gates/${event.gateId}/contracts/CURRENT_CONTRACT.json`;
  const contractArtifact = readLiveArtifact(root, contractPath);
  const currentContractArtifact = readLiveArtifact(root, currentContractPath);
  if (!contractArtifact) {
    R('GATE_AUTHORIZATION_CONTRACT_MISSING', '/', contractPath, 'existing Gate execution contract', 'The Gate has no execution contract, so there is nothing to authorize.');
  } else if (contractArtifact.sha256 !== record.contractSha256) {
    R('GATE_AUTHORIZATION_CONTRACT_SHA_MISMATCH', '/', record.contractSha256, contractArtifact.sha256, 'The approved contract hash does not reproduce the live Gate execution contract bytes.');
  }
  // CURRENT_CONTRACT is a MUTABLE pointer. Its live bytes answer a present-tense
  // question, so they are compared only in FULL mode; a historical replay must
  // not require yesterday's pointer to still be today's.
  if (pointerPinApplies) {
    if (!currentContractArtifact) {
      R('GATE_AUTHORIZATION_CONTRACT_MISSING', '/', currentContractPath, 'existing CURRENT_CONTRACT pointer', 'The Gate has no CURRENT_CONTRACT, so no contract revision is active.');
    } else if (currentContractArtifact.sha256 !== record.currentContractSha256) {
      R('GATE_AUTHORIZATION_CONTRACT_SHA_MISMATCH', '/', record.currentContractSha256, currentContractArtifact.sha256, 'The approved CURRENT_CONTRACT hash does not reproduce the live pointer bytes.');
    }
  }

  // ----- STATE cohort: immutable R0001 members plus mutable CURRENT_STATE lineage -----
  const expectedStatePaths = gateAuthorizationStateCohortPaths(event.gateId);
  for (const artifact of record.authorizedStateArtifacts) {
    const expectedPath = expectedStatePaths[artifact.cohortRole];
    if (artifact.repoRelativePath !== expectedPath) {
      R('GATE_AUTHORIZATION_STATE_PATH_NOT_AUTHORIZED', `/authorizedStateArtifacts/${artifact.cohortRole}`, artifact.repoRelativePath, expectedPath, 'Authorized state artifact is not at the exact R0001 path template for this Gate; an extra, cross-Gate or wildcard path is never authorized.');
      continue;
    }
    const live = readLiveArtifact(root, artifact.repoRelativePath);
    if (!live) {
      R('GATE_AUTHORIZATION_STATE_ARTIFACT_MISSING', `/authorizedStateArtifacts/${artifact.cohortRole}`, artifact.repoRelativePath, 'existing sealed state artifact', 'An authorized sealed state artifact is absent; the authorization is unproven.');
      continue;
    }
    if (artifact.cohortRole !== 'CURRENT_STATE') {
      if (live.sha256 !== artifact.sha256) {
        R('GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', `/authorizedStateArtifacts/${artifact.cohortRole}`, artifact.sha256, live.sha256, 'A sealed R0001 state artifact was changed after the owner approved it; historical revision members are immutable.');
      }
      if (live.byteLength !== artifact.byteLength) {
        R('GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', `/authorizedStateArtifacts/${artifact.cohortRole}`, artifact.byteLength, live.byteLength, 'A sealed R0001 state artifact byte length no longer matches the approved length.');
      }
    }
  }

  // The whole CURRENT_STATE lineage check is PRESENT CONSISTENCY: it reads the
  // live pointer and the live seal and compares them to the replayed head.
  // Asking it during a historical prefix replay is what made ordinal 57
  // unreplayable once ordinal 58 landed.
  if (!integrityOnly) {
    validateAuthorizationStateLineage({ root, ledgerPath, event, lineNumber, record, findings });
  }

  // ----- DERIVED cohort: exact path cohort, permanently (see the note above) -----
  const expectedDerivedPaths = gateAuthorizationDerivedCohortPaths();
  for (const artifact of record.authorizedDerivedArtifacts) {
    const expectedPath = expectedDerivedPaths[artifact.cohortRole];
    if (artifact.repoRelativePath !== expectedPath) {
      R('GATE_AUTHORIZATION_DERIVED_PATH_NOT_AUTHORIZED', `/authorizedDerivedArtifacts/${artifact.cohortRole}`, artifact.repoRelativePath, expectedPath, 'Authorized derived artifact is not one of the four approved generated views; no other path, and no wildcard, may ride along with an authorization.');
    }
  }

  if (findings.length === before) {
    finding(findings, 'GATE_AUTHORIZATION_APPLIED', event, lineNumber, '/toStatus', event.toStatus, record.authorizationId, 'owner-signed, byte-bound Gate authorization', `Gate authorized from NOT_STARTED to AUTHORIZED_NOT_STARTED under owner authority ${ownerAuthority?.authorityId ?? 'UNKNOWN'}; no execution, START or closure privilege was granted. Derived-view bytes are attested point-in-time by the owner authority, not permanently pinned, because generated views are non-canonical and legitimately regenerate.`, 'REQ-GAU-01', 'INFO');
  }
}

/** Permanent proof for modern START events (GATE14-GATE40). */
function validateModernGateStart({ root, ledgerPath, event, lineNumber, priorEvents = [], authority, policy = null, mode = MODE_FULL, isGateHeadEvent = true, findings }) {
  const before = findings.length;
  // Same split as AUTHORIZATION: a superseded START's pointer pin is history,
  // but its immutable bindings are checked in every mode.
  const integrityOnly = mode === MODE_LEDGER_INTEGRITY;
  const pointerPinApplies = !integrityOnly && isGateHeadEvent;
  const R = (detectorId, pointer, actual, expected, message) =>
    finding(findings, detectorId, event, lineNumber, pointer, actual, expected, 'GATE_START_AUTHORITY', message, 'REQ-GSA-01');
  const expectedRecordPath = gateStartRecordPath(event.gateId);
  const expectedAuthorityPath = gateStartAuthorityPath(event.gateId);
  if (!isModernGateStartId(event.gateId)) {
    R('GATE_START_GATE_OUT_OF_SCOPE', '/gateId', event.gateId, 'GATE14-GATE40 modern scope', 'Modern START authority is not defined for this Gate.');
    return;
  }
  if (event.authorityPath !== expectedRecordPath) {
    R('GATE_START_RECORD_PATH_NOT_AUTHORIZED', '/authorityPath', event.authorityPath, expectedRecordPath, 'Modern START must cite the exact canonical GATE_START_RECORD path.');
    return;
  }
  if (!authority || authority.actualSha !== event.authoritySha256) return;
  let record;
  try { record = JSON.parse(fs.readFileSync(authority.filePath, 'utf8')); }
  catch { R('GATE_START_RECORD_MALFORMED', '/', event.authorityPath, 'JSON object', 'START record is not parsable JSON.'); return; }
  const schemas = loadGateStartSchemas();
  const schema = validateAgainstJsonSchema(record, schemas.record);
  if (!schema.valid) R('GATE_START_RECORD_SCHEMA_INVALID', '/', schema.errors, 'gate-start-record.schema.json', 'START record violates its closed schema.');
  const shape = validateGateStartRecordShape(record);
  if (!shape.valid) R('GATE_START_RECORD_INVALID', '/', shape.findings, 'closed GATE_START_RECORD', 'START record violates the primitive shape.');
  if (record.recordDigest !== computeGateStartRecordDigest(record)) R('GATE_START_RECORD_DIGEST_INVALID', '/recordDigest', record.recordDigest, computeGateStartRecordDigest(record), 'START record digest is not reproducible.');

  const ownerSnapshot = readLiveArtifact(root, expectedAuthorityPath);
  if (!ownerSnapshot) {
    R('GATE_START_OWNER_AUTHORITY_MISSING', '/authorityPath', expectedAuthorityPath, 'owner authority snapshot', 'The signed owner START authority is absent.');
    return;
  }
  let ownerAuthority;
  try { ownerAuthority = JSON.parse(ownerSnapshot.bytes.toString('utf8')); }
  catch { R('GATE_START_OWNER_AUTHORITY_MALFORMED', '/', expectedAuthorityPath, 'JSON object', 'Owner START authority is not parsable JSON.'); return; }
  const authoritySchema = validateAgainstJsonSchema(ownerAuthority, schemas.authority);
  if (!authoritySchema.valid) R('GATE_START_OWNER_AUTHORITY_SCHEMA_INVALID', '/', authoritySchema.errors, 'gate-start-authority.schema.json', 'Owner START authority violates its closed schema.');
  const authorityShape = validateGateStartAuthorityShape(ownerAuthority);
  if (!authorityShape.valid) R('GATE_START_OWNER_AUTHORITY_INVALID', '/', authorityShape.findings, 'closed PROJECT_OWNER_GATE_START_AUTHORITY', 'Owner START authority violates the primitive shape.');
  const authorityMode = resolveAuthorityMode(ownerAuthority, { defaultLegacy: false });
  if (ownerAuthority.recordDigest !== record.recordDigest) R('GATE_START_RECORD_AUTHORITY_MISMATCH', '/recordDigest', ownerAuthority.recordDigest, record.recordDigest, 'Owner authority does not approve the ledger-pinned START record.');
  if (ownerAuthority.bindingDigest !== computeGateStartBindingDigestFromDigests({ requestDigest: ownerAuthority.requestDigest, recordDigest: record.recordDigest })) R('GATE_START_BINDING_DIGEST_INVALID', '/bindingDigest', ownerAuthority.bindingDigest, 'recomputed request+record binding digest', 'Owner authority binding is not reproducible.');
  for (const field of ['authorityMode', 'projectId', 'gateId', 'purpose', 'eventId', 'transitionType', 'fromStatus', 'toStatus', 'recordedAt', 'baseCommit', 'preStartLedgerSha256', 'previousEventSha256', 'contractSha256', 'currentContractSha256', 'preStateRevision', 'preCurrentStateSha256', 'preStateSealSha256', 'readinessDigest', 'ownerKeyId', 'expiresAtUtc', 'maxUse', 'startAuthorized', 'executionAuthorized']) {
    if (ownerAuthority[field] !== record[field]) R('GATE_START_RECORD_AUTHORITY_MISMATCH', `/${field}`, ownerAuthority[field], record[field], `Owner authority disagrees with the ledger-pinned START record on ${field}.`);
  }
  for (const field of ['dependencyProof', 'activeGatePreState', 'authorizedStartWritePaths', 'functionalExecutionScope', 'prohibitedOperations']) {
    if (canonicalize(ownerAuthority[field]) !== canonicalize(record[field])) R('GATE_START_RECORD_AUTHORITY_MISMATCH', `/${field}`, ownerAuthority[field], record[field], `Owner authority disagrees with the ledger-pinned START record on ${field}.`);
  }
  if (authorityMode === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE) {
    const localRequestDigest = computeGateStartLocalRequestDigest(ownerAuthority);
    if (ownerAuthority.requestDigest !== localRequestDigest) R('GATE_START_LOCAL_REQUEST_DIGEST_INVALID', '/requestDigest', ownerAuthority.requestDigest, localRequestDigest, 'LOCAL_EXPLICIT_AUTHORITY must bind the exact START record without an external request.');
  } else {
    let key;
    try {
      const keyPath = policy?.gateStartOwnerKeyPath || GATE_AUTHORIZATION_OWNER_KEY_PATH;
      key = JSON.parse(fs.readFileSync(path.isAbsolute(keyPath) ? keyPath : path.resolve(root, keyPath), 'utf8'));
    }
    catch { key = null; }
    const signature = verifyGateStartOwnerSignature(ownerAuthority, key);
    if (!signature.verified) R('GATE_START_OWNER_SIGNATURE_INVALID', '/signature', signature.reason, 'verified PROJECT_OWNER Ed25519 signature', 'START authority signature is invalid.');
  }

  for (const field of ['gateId', 'eventId', 'transitionType', 'fromStatus', 'toStatus', 'recordedAt']) {
    if (record[field] !== event[field]) R(`GATE_START_${field.toUpperCase()}_MISMATCH`, `/${field}`, record[field], event[field], `START record ${field} does not match the ledger event.`);
  }
  if (record.fromStatus !== GATE_START_FROM_STATUS || record.toStatus !== GATE_START_TO_STATUS || record.transitionType !== GATE_START_TRANSITION_TYPE) R('GATE_START_TRANSITION_INVALID', '/', `${record.fromStatus}>${record.toStatus}:${record.transitionType}`, 'AUTHORIZED_NOT_STARTED>IN_PROGRESS:START', 'Modern START has one fixed transition.');
  if (record.maxUse !== GATE_START_MAX_USE) R('GATE_START_MAX_USE_INVALID', '/maxUse', record.maxUse, GATE_START_MAX_USE, 'START authority is single-use.');
  if (Date.parse(ownerAuthority.expiresAtUtc) < Date.parse(event.recordedAt)) R('GATE_START_EXPIRED', '/expiresAtUtc', ownerAuthority.expiresAtUtc, event.recordedAt, 'START authority was expired at the ledger event time.');
  if (priorEvents.some((item) => item.gateId === event.gateId && item.transitionType === GATE_START_TRANSITION_TYPE)) R('GATE_START_AUTHORITY_REPLAYED', '/gateId', event.gateId, 'one START per Gate', 'A second START would replay a single-use authority.');

  let prefixSha = null;
  try { prefixSha = sha256Bytes(reconstructLedgerPrefixBytes(ledgerPath, event.ordinal - 1)); } catch { /* reported below */ }
  if (record.preStartLedgerSha256 !== prefixSha) R('GATE_START_PRE_LEDGER_MISMATCH', '/preStartLedgerSha256', record.preStartLedgerSha256, prefixSha, 'The pre-START ledger digest is not the exact append-only prefix.');
  if (record.previousEventSha256 !== event.previousEventSha256) R('GATE_START_PREVIOUS_EVENT_MISMATCH', '/previousEventSha256', record.previousEventSha256, event.previousEventSha256, 'START record continues a different ledger head.');

  const contractPath = `governance/gates/${event.gateId}/contracts/EXECUTION_CONTRACT_R0001.json`;
  const currentContractPath = `governance/gates/${event.gateId}/contracts/CURRENT_CONTRACT.json`;
  const contract = readLiveArtifact(root, contractPath);
  const currentContract = readLiveArtifact(root, currentContractPath);
  // EXECUTION_CONTRACT_R0001 is IMMUTABLE, so its bytes are checked in both modes.
  if (!contract || contract.sha256 !== record.contractSha256) R('GATE_START_CONTRACT_SHA_MISMATCH', '/contractSha256', record.contractSha256, contract?.sha256 || null, 'START authority does not bind the live execution contract.');
  // CURRENT_CONTRACT is MUTABLE. Comparing it here in integrity mode is exactly
  // what would make event 58 permanently unreplayable after a lawful contract
  // succession advances the pointer.
  if (pointerPinApplies && (!currentContract || currentContract.sha256 !== record.currentContractSha256)) R('GATE_START_CURRENT_CONTRACT_SHA_MISMATCH', '/currentContractSha256', record.currentContractSha256, currentContract?.sha256 || null, 'START authority does not bind the live CURRENT_CONTRACT pointer.');
  let contractJson = null;
  try { contractJson = JSON.parse(contract.bytes.toString('utf8')); } catch { /* hash finding above is sufficient */ }
  if (contractJson && (!Array.isArray(record.functionalExecutionScope) || record.functionalExecutionScope.length !== contractJson.authorizedPaths?.length || [...record.functionalExecutionScope].sort().some((p, i) => p !== [...contractJson.authorizedPaths].sort()[i]))) R('GATE_START_FUNCTIONAL_SCOPE_MISMATCH', '/functionalExecutionScope', record.functionalExecutionScope, contractJson.authorizedPaths, 'Functional execution is limited to the exact current contract scope.');
  // ACTIVE_GATE is a MUTABLE lifecycle pointer. In FULL mode we assert it was
  // not switched by this START; in integrity mode the historical claim is
  // verified by reconstructing ACTIVE_GATE at this ordinal (see H1), not by
  // reading whatever the pointer says today.
  if (!integrityOnly) {
    const active = readLiveArtifact(root, 'governance/active/ACTIVE_GATE.json');
    let activeJson = null; try { activeJson = active ? JSON.parse(active.bytes.toString('utf8')) : null; } catch { /* reported below */ }
    if (!active || !activeJson || activeJson.activeGate !== record.activeGatePreState?.activeGate) R('GATE_START_ACTIVE_GATE_MUTATION', '/activeGatePreState', activeJson?.activeGate || null, record.activeGatePreState?.activeGate, 'START must not switch ACTIVE_GATE.');
  }

  const preSeal = readLiveArtifact(root, `governance/gates/${event.gateId}/state/revisions/${record.preStateRevision}/STATE_SEAL.json`);
  const preDefects = readLiveArtifact(root, `governance/gates/${event.gateId}/state/revisions/${record.preStateRevision}/OPEN_DEFECTS.json`);
  let defectsKnowledge = 'UNKNOWN';
  try { const defects = JSON.parse(preDefects.bytes.toString('utf8')); defectsKnowledge = Array.isArray(defects.defects) ? (defects.defects.length === 0 ? 'KNOWN_ZERO' : 'KNOWN_NONZERO') : 'UNKNOWN'; } catch { /* unknown remains blocking */ }
  // The readiness digest must reproduce identically in both modes, or a historical
  // replay would report a digest mismatch for a record that was correct when
  // written. In integrity mode the MUTABLE pointer term is taken from the
  // record's own immutable bytes (self-consistency) rather than from the live
  // file; every IMMUTABLE term is still checked against real bytes.
  const currentContractTerm = pointerPinApplies ? currentContract?.sha256 : record.currentContractSha256;
  const readinessVerdict = prefixSha && record.preStateRevision === 'R0001' && preSeal?.sha256 === record.preStateSealSha256 && defectsKnowledge === 'KNOWN_ZERO' && contract?.sha256 === record.contractSha256 && currentContractTerm === record.currentContractSha256 && event.fromStatus === 'AUTHORIZED_NOT_STARTED' ? 'READY' : 'BLOCKED';
  const readiness = computeGateStartReadinessDigest({
    projectId: record.projectId, gateId: record.gateId, status: event.fromStatus,
    preStartLedgerSha256: record.preStartLedgerSha256, previousEventSha256: record.previousEventSha256,
    preStateRevision: record.preStateRevision, preCurrentStateSha256: record.preCurrentStateSha256,
    preStateSealSha256: record.preStateSealSha256, openDefectsKnowledge: defectsKnowledge,
    contractSha256: record.contractSha256, currentContractSha256: record.currentContractSha256,
    dependencyProof: record.dependencyProof, readinessVerdict
  });
  if (readiness !== record.readinessDigest) R('GATE_START_READINESS_DIGEST_MISMATCH', '/readinessDigest', record.readinessDigest, readiness, 'Readiness identity does not reproduce from validated pre-START inputs.');
  if (readinessVerdict !== 'READY') R('GATE_START_READINESS_BLOCKED', '/readinessDigest', readinessVerdict, 'READY', 'A START authority cannot be applied to a blocked or unknown readiness state.');
  if (findings.length === before) finding(findings, 'GATE_START_APPLIED', event, lineNumber, '/toStatus', event.toStatus, 'owner-signed modern START authority', 'GATE_START_AUTHORITY', 'Modern START authority was verified and consumed.', 'REQ-GSA-01', 'INFO');
}

/**
 * A GATE_AUTHORIZATION_RECORD authorizes exactly one transitionType. Citing one
 * as the authority for a START, AGENT_CLOSURE, or any other transition is an
 * attempt to spend an authorization privilege on a privilege it never granted.
 * Detected structurally, from the cited document's own self-declared kind.
 */
/**
 * Proof obligations for a CONTRACT_SUCCESSION event.
 *
 * The event is only the RECORD of a succession; the succession itself is
 * authorized by a single-use local authority document, which this event cites
 * by path and digest exactly as every other transition class does. Everything
 * below is checked against real bytes:
 *
 *   - the cited authority is a contract succession authority for THIS Gate;
 *   - the predecessor contract it names still hashes as it says;
 *   - the successor contract exists, hashes as declared, and declares its own
 *     predecessor lineage back to that same predecessor;
 *   - the successor revision is exactly one greater than the predecessor's;
 *   - the event's native state pin names a real, sealed revision whose seal
 *     chains to the state that existed before the succession.
 *
 * NO DIGEST CYCLE: the seal the event pins is computed from the contract and the
 * previous seal, never from the event, so the event can bind the seal without
 * the seal needing to know the event.
 */
function validateContractSuccession({ root, event, lineNumber, authority, mode = MODE_FULL, findings }) {
  const before = findings.length;
  const R = (detectorId, pointer, actual, expected, message) =>
    finding(findings, detectorId, event, lineNumber, pointer, actual, expected, 'GATE_CONTRACT_SUCCESSION_AUTHORITY', message, 'REQ-CSU-01');
  if (!authority || authority.actualSha !== event.authoritySha256) {
    R('CONTRACT_SUCCESSION_AUTHORITY_UNRESOLVED', '/authoritySha256', event.authoritySha256, 'resolvable cited authority', 'The succession authority cited by this event cannot be resolved to its exact bytes.');
    return;
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(authority.filePath, 'utf8')); }
  catch { R('CONTRACT_SUCCESSION_AUTHORITY_MALFORMED', '/', event.authorityPath, 'JSON object', 'Succession authority is not parsable JSON.'); return; }

  if (record.documentKind !== 'GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY') R('CONTRACT_SUCCESSION_AUTHORITY_KIND_INVALID', '/', record.documentKind, 'GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY', 'Cited document is not a contract succession authority.');
  if (record.gateId !== event.gateId) R('CONTRACT_SUCCESSION_GATE_MISMATCH', '/gateId', record.gateId, event.gateId, 'Succession authority belongs to another Gate.');
  if (record.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY') R('CONTRACT_SUCCESSION_MODE_INVALID', '/authorityMode', record.authorityMode, 'LOCAL_EXPLICIT_AUTHORITY', 'Unsupported succession authority mode.');
  if (record.maxUse !== 1) R('CONTRACT_SUCCESSION_MAX_USE_INVALID', '/maxUse', record.maxUse, 1, 'A succession authority is single use.');

  const predecessor = readLiveArtifact(root, record.predecessorContractPath);
  const successor = readLiveArtifact(root, record.successorContractPath);
  if (!predecessor || predecessor.sha256 !== record.predecessorContractSha256) {
    R('CONTRACT_SUCCESSION_PREDECESSOR_MISMATCH', '/predecessorContractSha256', record.predecessorContractSha256, predecessor?.sha256 ?? null, 'The predecessor contract bytes do not reproduce the authorized digest.');
  }
  if (!successor || successor.sha256 !== record.successorContractSha256) {
    R('CONTRACT_SUCCESSION_SUCCESSOR_MISMATCH', '/successorContractSha256', record.successorContractSha256, successor?.sha256 ?? null, 'The successor contract bytes do not reproduce the authorized digest.');
  }
  if (record.successorContractPath === record.predecessorContractPath) {
    R('CONTRACT_SUCCESSION_PREDECESSOR_MUTATION_FORBIDDEN', '/successorContractPath', record.successorContractPath, 'a new immutable contract path', 'A succession may never overwrite its predecessor.');
  }
  let successorJson = null;
  try { successorJson = successor ? JSON.parse(successor.bytes.toString('utf8')) : null; } catch { successorJson = null; }
  if (successorJson) {
    if (successorJson.gateId !== event.gateId) R('CONTRACT_SUCCESSION_SUCCESSOR_GATE_MISMATCH', '/gateId', successorJson.gateId, event.gateId, 'Successor contract belongs to another Gate.');
    if (successorJson.previousContractPath !== record.predecessorContractPath || successorJson.previousContractSha256 !== record.predecessorContractSha256) {
      R('CONTRACT_SUCCESSION_LINEAGE_MISMATCH', '/previousContractSha256', successorJson.previousContractSha256 ?? null, record.predecessorContractSha256, 'The successor contract must declare the exact predecessor it succeeds.');
    }
    const predecessorRevision = Number.parseInt(String(record.predecessorContractRevision || '').slice(1), 10);
    const successorRevision = Number.parseInt(String(successorJson.contractRevision || '').slice(1), 10);
    if (!Number.isInteger(predecessorRevision) || !Number.isInteger(successorRevision) || successorRevision !== predecessorRevision + 1) {
      R('CONTRACT_SUCCESSION_REVISION_GAP', '/contractRevision', successorJson.contractRevision, `R${String(predecessorRevision + 1).padStart(4, '0')}`, 'Contract revisions advance by exactly one.');
    }
  }

  // The native state pin must name a real sealed revision for this Gate.
  const sealPath = `governance/gates/${event.gateId}/state/revisions/${event.stateRevision}/STATE_SEAL.json`;
  const seal = readLiveArtifact(root, sealPath);
  if (!seal || seal.sha256 !== event.stateRevisionSealSha256) {
    R('CONTRACT_SUCCESSION_STATE_PIN_MISMATCH', '/stateRevisionSealSha256', event.stateRevisionSealSha256, seal?.sha256 ?? null, 'The native state pin does not reproduce the sealed revision it names.');
  } else {
    let sealJson = null;
    try { sealJson = JSON.parse(seal.bytes.toString('utf8')); } catch { sealJson = null; }
    if (sealJson) {
      if (sealJson.gateId !== event.gateId || sealJson.stateRevision !== event.stateRevision) {
        R('CONTRACT_SUCCESSION_STATE_IDENTITY_MISMATCH', '/stateRevision', sealJson.stateRevision, event.stateRevision, 'The pinned seal does not identify the pinned revision.');
      }
      if (sealJson.payload?.executionStatus !== event.toStatus) {
        R('CONTRACT_SUCCESSION_STATE_STATUS_MISMATCH', '/toStatus', sealJson.payload?.executionStatus, event.toStatus, 'The new revision must record the status the Gate is actually in.');
      }
      if (sealJson.previousStateSealSha256 !== record.previousStateSealSha256) {
        R('CONTRACT_SUCCESSION_STATE_CHAIN_MISMATCH', '/previousStateSealSha256', sealJson.previousStateSealSha256, record.previousStateSealSha256, 'The new revision seal must chain to the state that existed before the succession.');
      }
    }
  }

  if (findings.length === before) {
    finding(findings, 'CONTRACT_SUCCESSION_APPLIED', event, lineNumber, '/toStatus', event.toStatus, 'single-use local contract succession authority', 'GATE_CONTRACT_SUCCESSION_AUTHORITY', 'Contract succession authority was verified and consumed.', 'REQ-CSU-01', 'INFO');
  }
}

function checkGateAuthorizationRecordNotBorrowed({ event, lineNumber, authority, findings }) {
  if (event.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE || !authority) return;
  let cited;
  try { cited = JSON.parse(fs.readFileSync(authority.filePath, 'utf8')); } catch { return; }
  if (cited?.document !== GATE_AUTHORIZATION_RECORD_KIND) return;
  finding(findings, 'GATE_AUTHORIZATION_RECORD_TRANSITION_BORROWED', event, lineNumber, '/transitionType', event.transitionType, GATE_AUTHORIZATION_TRANSITION_TYPE, 'GATE_AUTHORIZATION_AUTHORITY', `A GATE_AUTHORIZATION_RECORD authorizes only the AUTHORIZATION transition; it can never authorize ${event.transitionType}. START and execution privilege must come from their own authority.`, 'REQ-GAU-01');
}

function checkGateStartRecordNotBorrowed({ event, lineNumber, authority, findings }) {
  if (event.transitionType === GATE_START_TRANSITION_TYPE || !authority) return;
  let cited;
  try { cited = JSON.parse(fs.readFileSync(authority.filePath, 'utf8')); } catch { return; }
  if (cited?.document !== GATE_START_RECORD_KIND) return;
  finding(findings, 'GATE_START_RECORD_TRANSITION_BORROWED', event, lineNumber, '/transitionType', event.transitionType, GATE_START_TRANSITION_TYPE, 'GATE_START_AUTHORITY', `A GATE_START_RECORD authorizes only START; it can never authorize ${event.transitionType}.`, 'REQ-GSA-01');
}

function checkEventShape(event, findings, lineNumber) {
  const keys = Object.keys(event);
  const nativeEra = Number.isInteger(event.ordinal) && event.ordinal >= NATIVE_STATE_PIN_FIRST_ORDINAL;
  const allowedFields = nativeEra ? [...REQUIRED_EVENT_FIELDS, ...NATIVE_STATE_PIN_FIELDS] : REQUIRED_EVENT_FIELDS;
  const missing = REQUIRED_EVENT_FIELDS.filter((key) => !Object.prototype.hasOwnProperty.call(event, key));
  const extra = keys.filter((key) => !allowedFields.includes(key));
  if (nativeEra) {
    for (const key of NATIVE_STATE_PIN_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(event, key)) {
        finding(findings, 'NATIVE_STATE_PIN_MISSING', event, lineNumber, `/${key}`, undefined, `required from ordinal ${NATIVE_STATE_PIN_FIRST_ORDINAL}`, 'event schema', `Native-era events must pin their resulting state revision; ${key} is missing.`, 'REQ-LED-01');
      }
    }
    if (Object.hasOwn(event, 'stateRevision') && !/^R[0-9]{4}$/.test(String(event.stateRevision))) {
      finding(findings, 'NATIVE_STATE_PIN_INVALID', event, lineNumber, '/stateRevision', event.stateRevision, 'Rxxxx', 'event schema', 'Native state pin revision is malformed.', 'REQ-LED-01');
    }
    if (Object.hasOwn(event, 'stateRevisionSealSha256') && !/^[a-f0-9]{64}$/.test(String(event.stateRevisionSealSha256))) {
      finding(findings, 'NATIVE_STATE_PIN_INVALID', event, lineNumber, '/stateRevisionSealSha256', event.stateRevisionSealSha256, 'SHA-256 hex', 'event schema', 'Native state pin seal digest is malformed.', 'REQ-LED-01');
    }
  }
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

/**
 * H4 — LEDGER INTEGRITY and PRESENT CONSISTENCY are two different questions.
 *
 *   LEDGER_INTEGRITY  "was this history validly written?"  Answered from the
 *                     event bytes, the chain, the authorities and the IMMUTABLE
 *                     artifacts those events pinned. Must be answerable about
 *                     ordinal N using only what existed at ordinal N.
 *
 *   PRESENT_CONSISTENCY  "do today's mutable projections agree with the ledger
 *                     HEAD?" Answered from CURRENT_STATE, CURRENT_CONTRACT and
 *                     ACTIVE_GATE as they are right now.
 *
 * They were fused, and that fusion was a real defect with two consequences:
 *
 *   1. Replaying ordinal 57 compared the status replayed at 57
 *      (AUTHORIZED_NOT_STARTED) against the CURRENT seal (IN_PROGRESS, R0002)
 *      and blocked. History could not be replayed once history moved on.
 *
 *   2. Worse and still latent: event 58 pins currentContractSha256, the bytes of
 *      a MUTABLE pointer. The moment a contract succession advances that
 *      pointer, the pin can never hold again and event 58 would become
 *      permanently unreplayable. Fusing the two questions makes lawful forward
 *      progress destroy verifiable history.
 *
 * In LEDGER_INTEGRITY mode, claims a record makes about mutable projections are
 * verified for SELF-CONSISTENCY against the record's own immutable bytes, not
 * against today's files. The immutable artifacts stay fully byte-checked in both
 * modes — nothing is relaxed except the question being asked.
 */
export const MODE_LEDGER_INTEGRITY = 'LEDGER_INTEGRITY';
export const MODE_FULL = 'FULL';

export function validateLedger({ root, ledgerPath, sourceMapPath = null, registryPath = null, policy = null, mode = MODE_FULL }) {
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
    const isContractSuccession = event.transitionType === CONTRACT_SUCCESSION_TRANSITION_TYPE;
    const table = isHistoricalReconciliation ? HISTORICAL_RECONCILIATION_TRANSITIONS
      : isContractSuccession ? CONTRACT_SUCCESSION_TRANSITIONS
      : TRANSITIONS;
    const tableName = isHistoricalReconciliation ? 'transition in the narrow historical reconciliation table'
      : isContractSuccession ? 'transition in the single-entry contract succession table'
      : 'transition in closed I2 table';
    const allowed = table.some(([from, to, type]) => `${from ?? 'null'}>${to}:${type}` === key);
    if (!allowed) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/', key, tableName, 'transition table', isHistoricalReconciliation ? 'Transition is not an authorized historical reconciliation.' : isContractSuccession ? 'Transition is not an authorized contract succession.' : 'Transition is not present in the closed state machine.', 'REQ-LED-02');
    if (event.fromStatus === null) genesisCount.set(event.gateId, (genesisCount.get(event.gateId) || 0) + 1);
    const current = currentByGate.get(event.gateId);
    if (current !== undefined && event.fromStatus !== current) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/fromStatus', event.fromStatus, current, 'fromStatus equals replayed current status', 'fromStatus does not match the replayed gate state.', 'REQ-LED-02');
    // Snapshot of the replay BEFORE this event is applied, so an AUTHORIZATION's dependency proof
    // is judged against history as it actually stood at that point, never against how it ends up.
    // Materialized only for the transition that needs it, so the common path stays allocation-free.
    const statusBeforeEvent = event.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE ? new Map(currentByGate) : null;
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
    // AUTHORIZATION is a NORMAL execution transition already admitted by exactly one entry of the
    // closed I2 table (NOT_STARTED -> AUTHORIZED_NOT_STARTED). This adds its owner-signature and
    // byte-binding proof obligations on top; it neither widens nor narrows the transition table.
    // `replayedStatusByGate` is a snapshot of the replay BEFORE this event, so the dependency
    // check reads history as it actually stood, never as it ends up.
    if (event.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE) {
      validateGateAuthorization({
        root,
        ledgerPath,
        event,
        lineNumber,
        priorOwnEvents: events.slice(0, i).filter((e) => e.gateId === event.gateId),
        priorEvents: events.slice(0, i),
        replayedStatusByGate: statusBeforeEvent,
        authority,
        sourceMap,
        policy: effectivePolicy,
        mode,
        isGateHeadEvent: !events.slice(i + 1).some((later) => later.gateId === event.gateId),
        findings
      });
    }
    if (event.transitionType === GATE_START_TRANSITION_TYPE) {
      const isExactGATE13Legacy = event.gateId === 'GATE13'
        && event.eventId === 'GATE13_START_R1'
        && event.ordinal === 42
        && event.authorityPath === 'governance/sources/GATE13_CANONICAL_MANDATE_AND_EXECUTION_AUTHORITY_R1.json'
        && event.authoritySha256 === 'f67aed86fcea61dc7c49b56ec36b461b335e55973e4be1aaffaf7e3db766442e';
      if (!isExactGATE13Legacy && isModernGateStartId(event.gateId)) {
        validateModernGateStart({
          root,
          ledgerPath,
          event,
          lineNumber,
          priorEvents: events.slice(0, i),
          authority,
          policy: effectivePolicy,
          mode,
          isGateHeadEvent: !events.slice(i + 1).some((later) => later.gateId === event.gateId),
          findings
        });
      }
    }
    if (event.transitionType === CONTRACT_SUCCESSION_TRANSITION_TYPE) {
      validateContractSuccession({ root, event, lineNumber, authority, mode, findings });
    }
    checkGateAuthorizationRecordNotBorrowed({ event, lineNumber, authority, findings });
    checkGateStartRecordNotBorrowed({ event, lineNumber, authority, findings });
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
 * Resolve a canonical historical pre-state directly from the live append-only
 * ledger. The returned prefix bytes are an exact slice of the current file;
 * no temporary ledger is created and no canonical bytes are rewritten.
 */
export function resolveCanonicalLedgerPrefix({ ledgerPath, eventCount, expectedSha256 }) {
  const findings = [];
  let bytes = null;
  try { bytes = fs.readFileSync(ledgerPath); } catch (error) {
    findings.push({ code: 'LEDGER_UNREADABLE', detail: error?.message || String(error) });
  }
  if (!Number.isInteger(eventCount) || eventCount < 1) findings.push({ code: 'PRESTATE_EVENT_COUNT_INVALID' });
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) findings.push({ code: 'PRESTATE_EXPECTED_SHA_INVALID' });
  if (!bytes || findings.length) return { valid: false, findings, availableEventCount: null, prefixBytes: null, prefixSha256: null };

  const lineEnds = [];
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0x0a) lineEnds.push(index + 1);
  const lastCompleteEnd = lineEnds.at(-1) ?? 0;
  if (lastCompleteEnd < bytes.length) lineEnds.push(bytes.length);
  const availableEventCount = lineEnds.length;
  if (availableEventCount < eventCount) findings.push({ code: 'PRESTATE_LEDGER_TOO_SHORT', detail: { eventCount, availableEventCount } });

  const prefixEnd = availableEventCount >= eventCount ? lineEnds[eventCount - 1] : null;
  const prefixBytes = prefixEnd === null ? null : Buffer.from(bytes.subarray(0, prefixEnd));
  let prefixSha256 = prefixBytes ? sha256Bytes(prefixBytes) : null;
  if (prefixBytes && prefixSha256 !== expectedSha256) findings.push({ code: 'PRESTATE_PREFIX_SHA_MISMATCH', detail: { expectedSha256, prefixSha256 } });

  if (prefixBytes) {
    const lines = prefixBytes.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    let previousEventPayloadSha256 = null;
    for (let index = 0; index < lines.length; index += 1) {
      let event;
      try { event = JSON.parse(lines[index]); } catch (error) {
        findings.push({ code: 'PRESTATE_EVENT_JSON_INVALID', detail: { ordinal: index + 1, error: error?.message || String(error) } });
        continue;
      }
      if (event.ordinal !== index + 1) findings.push({ code: 'PRESTATE_ORDINAL_INVALID', detail: { expected: index + 1, actual: event.ordinal } });
      if (event.previousEventSha256 !== previousEventPayloadSha256) {
        findings.push({ code: 'PRESTATE_PREVIOUS_EVENT_CHAIN_INVALID', detail: { ordinal: index + 1, expected: previousEventPayloadSha256, actual: event.previousEventSha256 } });
      }
      const { eventPayloadSha256, ...eventPayload } = event;
      const recomputedEventPayloadSha256 = sha256Canonical(eventPayload);
      if (eventPayloadSha256 !== recomputedEventPayloadSha256) {
        findings.push({ code: 'PRESTATE_EVENT_PAYLOAD_HASH_INVALID', detail: { ordinal: index + 1, expected: recomputedEventPayloadSha256, actual: eventPayloadSha256 } });
      }
      previousEventPayloadSha256 = eventPayloadSha256 ?? null;
    }
  }
  return {
    valid: findings.length === 0,
    findings,
    availableEventCount,
    prefixBytes,
    prefixSha256,
    eventCount,
    expectedSha256
  };
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
export function validateLedgerPrefix({ root, ledgerPath, throughOrdinal, expectedPrefixSha256 = null, sourceMapPath = null, registryPath = null, policy = null, mode = MODE_LEDGER_INTEGRITY }) {
  const prefixBytes = reconstructLedgerPrefixBytes(ledgerPath, throughOrdinal);
  const prefixSha256 = sha256Bytes(prefixBytes);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-ledger-prefix-'));
  const tmpLedgerPath = path.join(tmpDir, 'GATE_STATUS_LEDGER.prefix.ndjson');
  let prefixReport;
  try {
    fs.writeFileSync(tmpLedgerPath, prefixBytes);
    // Historical replay defaults to LEDGER_INTEGRITY: asking a past ordinal to
    // agree with today's mutable projections is the defect, not the check.
    prefixReport = validateLedger({ root, ledgerPath: tmpLedgerPath, sourceMapPath, registryPath, policy, mode });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return {
    throughOrdinal,
    mode,
    prefixSha256,
    expectedPrefixSha256,
    matchesExpectedHistoricalDigest: expectedPrefixSha256 === null ? null : prefixSha256 === expectedPrefixSha256,
    prefixChainValid: prefixReport.valid,
    prefixFindings: prefixReport.findings,
    liveLedgerPath: path.relative(path.resolve(root), path.resolve(ledgerPath)).replaceAll('\\', '/')
  };
}

/**
 * PRESENT CONSISTENCY — the other half of the split.
 *
 * Asks only whether today's mutable projections agree with the ledger HEAD.
 * This is deliberately a separate entry point: it is meaningful only at the
 * head, and it must never be mistaken for, or mixed into, a claim about history.
 */
export function validatePresentConsistency({ root, ledgerPath, sourceMapPath = null, registryPath = null, policy = null }) {
  const full = validateLedger({ root, ledgerPath, sourceMapPath, registryPath, policy, mode: MODE_FULL });
  const integrity = validateLedger({ root, ledgerPath, sourceMapPath, registryPath, policy, mode: MODE_LEDGER_INTEGRITY });
  const integrityCodes = new Set(integrity.findings.map((f) => `${f.detectorId}:${f.lineNumber}`));
  // Whatever FULL reports that INTEGRITY does not is, by construction, a
  // present-tense disagreement rather than a defect in the written history.
  const presentFindings = full.findings.filter((f) => !integrityCodes.has(`${f.detectorId}:${f.lineNumber}`));
  return {
    ledgerIntegrityValid: integrity.valid,
    presentConsistent: presentFindings.filter((f) => f.severity === 'BLOCKING').length === 0,
    eventCount: full.events.length,
    ledgerSha256: full.ledgerSha256,
    integrityFindings: integrity.findings,
    presentFindings
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
