import fs from 'node:fs';
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

function resolveAuthority({ root, event, sourceMap, findings, lineNumber }) {
  const authorityPath = event.authorityPath;
  if (typeof authorityPath !== 'string' || !authorityPath) {
    finding(findings, 'MISSING_TRANSITION_AUTHORITY', event, lineNumber, '/authorityPath', authorityPath, 'non-empty relative path or declared external authority id', 'authorityPath + authoritySha256', 'Transition authority is absent.', 'REQ-LED-03');
    return null;
  }

  let filePath;
  let declared = null;
  const external = sourceMap?.externalAuthorities?.find((a) => a.authorityId === authorityPath);
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
  const bytes = fs.readFileSync(filePath);
  const actualSha = sha256Bytes(bytes);
  if (actualSha !== event.authoritySha256) {
    finding(findings, 'AUTHORITY_HASH_MISMATCH', event, lineNumber, '/authoritySha256', event.authoritySha256, actualSha, 'authoritySha256 recalculated from authority bytes', 'Authority hash differs from the actual authority bytes.', 'REQ-LED-03');
  }
  if (declared && declared.sha256 !== actualSha) {
    finding(findings, 'AUTHORITY_MANIFEST_HASH_MISMATCH', event, lineNumber, '/authorityPath', declared.sha256, actualSha, 'external declaration matches authority bytes', 'External authority declaration is stale or divergent.', 'REQ-LED-03');
  }

  let authorityClass = declared?.classification || 'CANONICAL_EVIDENCE';
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed && parsed.canonical === false && (parsed.generated === true || parsed.generatedFrom || parsed.generatedBy)) authorityClass = 'GENERATED';
  } catch {
    // Binary packages and text authorities are classified by the declared or path-bound class.
  }
  return { filePath, authorityClass, actualSha };
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
  if (typeof event.gateId !== 'string' || !/^GATE(0[0-9]|[1-3][0-9]|40)$/.test(event.gateId)) finding(findings, 'UNKNOWN_GATE_ID', event, lineNumber, '/gateId', event.gateId, 'gate id declared by the registry', 'registry', 'Unknown gate id.', 'REQ-LED-01');
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

export function validateLedger({ root, ledgerPath, sourceMapPath = null }) {
  const findings = [];
  const sourceMap = sourceMapPath && fs.existsSync(sourceMapPath) ? readJson(sourceMapPath) : null;
  if (!fs.existsSync(ledgerPath)) {
    finding(findings, 'MISSING_LEDGER', null, 0, '/', ledgerPath, 'existing NDJSON ledger', 'canonical ledger', 'Ledger file is missing.', 'REQ-LED-01');
    return { valid: false, findings, events: [], ledgerSha256: null, gates: [] };
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

  const registryPath = path.join(root, 'governance', 'GATE_REGISTRY_00_40.json');
  const registry = fs.existsSync(registryPath) ? readJson(registryPath) : { gates: [] };
  const knownGates = new Set((registry.gates || []).map((g) => g.gateId));
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
    const authority = resolveAuthority({ root, event, sourceMap, findings, lineNumber });
    if (authority?.authorityClass === 'GENERATED') finding(findings, 'GENERATED_AUTHORITY_CITED', event, lineNumber, '/authorityPath', event.authorityPath, 'non-generated authority class', 'transition authority classification', 'Generated view cannot be a canonical transition authority.', 'REQ-RNS-01');
    if (event.toStatus === 'COMPLETE_CONFIRMED') {
      const completeAllowed = (event.fromStatus === null && event.transitionType === 'GENESIS_IMPORT') || (event.fromStatus === 'COMPLETE_AGENT' && event.transitionType === 'EXTERNAL_CONFIRMATION');
      if (!completeAllowed) finding(findings, 'INVALID_STATUS_TRANSITION', event, lineNumber, '/toStatus', event.toStatus, 'GENESIS_IMPORT from null or EXTERNAL_CONFIRMATION from COMPLETE_AGENT', 'independent reinspection', 'COMPLETE_CONFIRMED is not reachable through this transition.', 'REQ-LED-02');
      if (authority?.authorityClass !== 'EXTERNAL_REINSPECTION_REPORT') finding(findings, 'COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION', event, lineNumber, '/authorityPath', event.authorityPath, 'EXTERNAL_REINSPECTION_REPORT', 'independent main session', 'COMPLETE_CONFIRMED requires an external reinspection report.', 'REQ-RNS-01');
      else {
        try {
          const report = JSON.parse(fs.readFileSync(authority.filePath, 'utf8'));
          if (report.VERDICT !== 'PASS' || report.document !== 'GATE12_L3_RECLOSURE_R1_EXTERNAL_REINSPECTION_REPORT') finding(findings, 'COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION', event, lineNumber, '/authorityPath', report.VERDICT, 'external report PASS with independent report identity', 'independent main session', 'External authority does not contain the required PASS report.', 'REQ-RNS-01');
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
    gates: [...currentByGate.entries()].map(([gateId, currentStatus]) => ({ gateId, currentStatus }))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const ledgerPath = path.resolve(option('--ledger', path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson')));
  const sourceMapPath = option('--source-map', null) ? path.resolve(option('--source-map')) : null;
  const report = validateLedger({ root, ledgerPath, sourceMapPath });
  const output = { valid: report.valid, ledgerPath: path.relative(root, ledgerPath).replaceAll('\\', '/'), ledgerSha256: report.ledgerSha256, eventCount: report.events.length, findings: report.findings };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
