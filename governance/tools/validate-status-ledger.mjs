import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Canonical, sha256Bytes } from './canonical-json.mjs';

const STATUSES = [
  'NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'IN_PROGRESS', 'REPAIR_REQUIRED',
  'BLOCKED_GOVERNANCE', 'INTERRUPTED_RESUMABLE', 'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED', 'SUPERSEDED', 'REOPENED_AUTHORIZED'
];

// This is the single normative implementation of the 21 transitions extracted from I2.
const TRANSITIONS = [
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

const REQUIRED_EVENT_FIELDS = [
  'schemaVersion', 'ordinal', 'eventId', 'gateId', 'fromStatus', 'toStatus',
  'transitionType', 'authorityPath', 'authoritySha256', 'previousEventSha256',
  'recordedAt', 'eventPayloadSha256'
];

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
  if (typeof event.transitionType !== 'string' || !['GENESIS_IMPORT', 'AUTHORIZATION', 'START', 'INTERRUPTION', 'RESUME', 'DEFECT_OPENED', 'REPAIR_ACCEPTED', 'GOVERNANCE_BLOCK', 'GOVERNANCE_UNBLOCK', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'EXTERNAL_REJECTION', 'AUTHORIZED_REOPEN', 'RESUME_AFTER_REOPEN', 'SUPERSESSION'].includes(event.transitionType)) finding(findings, 'SCHEMA_VIOLATION', event, lineNumber, '/transitionType', event.transitionType, 'transition type enum', 'event schema', 'Invalid transition type.', 'REQ-LED-02');
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
    const allowed = TRANSITIONS.some(([from, to, type]) => `${from ?? 'null'}>${to}:${type}` === key);
    if (!allowed) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/', key, 'transition in closed I2 table', 'transition table', 'Transition is not present in the closed state machine.', 'REQ-LED-02');
    if (event.fromStatus === null) genesisCount.set(event.gateId, (genesisCount.get(event.gateId) || 0) + 1);
    const current = currentByGate.get(event.gateId);
    if (current !== undefined && event.fromStatus !== current) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/fromStatus', event.fromStatus, current, 'fromStatus equals replayed current status', 'fromStatus does not match the replayed gate state.', 'REQ-LED-02');
    currentByGate.set(event.gateId, event.toStatus);
    const authority = resolveAuthority({ root, event, sourceMap, migrations, extraExternalAuthorities: effectivePolicy.extraExternalAuthorities, findings, lineNumber });
    if (authority?.authorityClass === 'GENERATED') finding(findings, 'GENERATED_AUTHORITY_CITED', event, lineNumber, '/authorityPath', event.authorityPath, 'non-generated authority class', 'transition authority classification', 'Generated view cannot be a canonical transition authority.', 'REQ-RNS-01');
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
