import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { validateStateSeal } from './validate-state-seal.mjs';
import { resolveStateRevisionLineage } from '../gee-v1/core/state-revision-resolver.mjs';
import { validateGateContractSuccessionLedgerBoundAuthorityShape } from '../gee-v1/core/gate-contract-succession-authority.mjs';
import {
  CONTRACT_SUCCESSION_TRANSITION_TYPE,
  CONTRACT_SUCCESSION_TRANSITIONS
} from '../gee-v1/core/canonical-terminal-proof.mjs';

export const DEFAULT_LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
export const DEFAULT_LEGACY_BINDINGS_PATH = 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json';
export const PROTECTED_HASH_MATCH = 'PROTECTED_HASH_MATCH';
export const HISTORICAL_PROTECTED_HASH_SUPERSEDED = 'HISTORICAL_PROTECTED_HASH_SUPERSEDED';
export const HISTORICAL_LEDGER_PREFIX = 'HISTORICAL_LEDGER_PREFIX';
export const PROTECTED_HASH_MISMATCH = 'PROTECTED_HASH_MISMATCH';

const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^R[0-9]{4}$/;
const EXECUTION_CONTRACT_RE = /^EXECUTION_CONTRACT_R[0-9]{4}\.json$/;

/**
 * Parse the ledger only. This must never call validateLedger: the ledger
 * validator itself calls into this file, and re-entering it would be circular
 * validation as well as unbounded recursion.
 */
function readLedgerEvents(ledgerPath) {
  try {
    return fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

function readLegacyBindings(bindingsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingsPath, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed.bindings) ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function revisionNumber(value) {
  return REVISION_RE.test(String(value || '')) ? Number.parseInt(String(value).slice(1), 10) : null;
}

function normalizedPath(value) {
  return typeof value === 'string' ? value.split(path.sep).join('/') : null;
}

function exactFileIdentity(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const bytes = fs.readFileSync(file);
  return { bytes, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

function collectNamedFiles(root, targetName) {
  const found = [];
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return found;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name === targetName) found.push(absolute);
    }
  }
  return found.sort();
}

function collectContractPins(value, protectedPath, pins = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectContractPins(item, protectedPath, pins);
    return pins;
  }
  if (!value || typeof value !== 'object') return pins;
  if (normalizedPath(value.path) === protectedPath && SHA256_RE.test(String(value.sha256 || ''))) pins.push(value.sha256);
  const keyed = value[protectedPath];
  if (SHA256_RE.test(String(keyed || ''))) pins.push(keyed);
  else if (keyed && typeof keyed === 'object' && SHA256_RE.test(String(keyed.sha256 || ''))) pins.push(keyed.sha256);
  for (const [key, nested] of Object.entries(value)) {
    if (key === protectedPath || key === 'path' || key === 'sha256') continue;
    collectContractPins(nested, protectedPath, pins);
  }
  return pins;
}

function readLedgerDocument(ledgerPath) {
  const reasons = [];
  let bytes;
  try { bytes = fs.readFileSync(ledgerPath); } catch { return { valid: false, reasons: ['LEDGER_UNREADABLE'], bytes: null, rawLines: [], events: [] }; }
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) reasons.push('LEDGER_FINAL_LF_MISSING');
  if (text.includes('\r')) reasons.push('LEDGER_CR_FORBIDDEN');
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  if (rawLines.some((line) => line.length === 0)) reasons.push('LEDGER_EMPTY_LINE');
  const events = [];
  const ids = new Set();
  const ordinals = new Set();
  let previousPayload = null;
  let previousRecordedAt = null;
  for (const [index, raw] of rawLines.entries()) {
    let event;
    try { event = JSON.parse(raw); } catch { reasons.push(`LEDGER_JSON_INVALID:${index + 1}`); continue; }
    events.push(event);
    if (canonicalize(event) !== raw) reasons.push(`LEDGER_EVENT_NON_CANONICAL:${index + 1}`);
    if (event.ordinal !== index + 1) reasons.push(`LEDGER_ORDINAL_INVALID:${index + 1}`);
    if (ids.has(event.eventId)) reasons.push(`LEDGER_EVENT_ID_DUPLICATE:${event.eventId}`);
    if (ordinals.has(event.ordinal)) reasons.push(`LEDGER_ORDINAL_DUPLICATE:${event.ordinal}`);
    ids.add(event.eventId);
    ordinals.add(event.ordinal);
    if (event.previousEventSha256 !== previousPayload) reasons.push(`LEDGER_CHAIN_BREAK:${index + 1}`);
    const { eventPayloadSha256, ...payload } = event;
    const recomputed = sha256Canonical(payload);
    if (eventPayloadSha256 !== recomputed) reasons.push(`LEDGER_PAYLOAD_HASH_INVALID:${index + 1}`);
    previousPayload = eventPayloadSha256 ?? null;
    if (previousRecordedAt && (!event.recordedAt || Date.parse(event.recordedAt) < Date.parse(previousRecordedAt))) {
      reasons.push(`LEDGER_TIMESTAMP_REGRESSION:${index + 1}`);
    }
    previousRecordedAt = event.recordedAt ?? previousRecordedAt;
  }
  return { valid: reasons.length === 0, reasons, bytes, rawLines, events };
}

function ledgerPrefixSha256(ledger, eventCount) {
  if (!ledger || !Number.isInteger(eventCount) || eventCount < 1 || eventCount > ledger.rawLines.length) return null;
  return sha256Bytes(Buffer.from(`${ledger.rawLines.slice(0, eventCount).join('\n')}\n`, 'utf8'));
}

function protectedResult(classification, {
  gateId = null, stateRevision = null, protectedPath = null,
  expectedSha256 = null, actualSha256 = null, reasonCodes = []
} = {}) {
  return {
    classification,
    blocking: classification === PROTECTED_HASH_MISMATCH,
    gateId,
    stateRevision,
    path: protectedPath,
    expectedSha256,
    actualSha256,
    reasonCodes: [...new Set(reasonCodes)]
  };
}

function inspectLedgerSealedContract({ root, event, protectedPath }) {
  const reasons = [];
  if (!event?.gateId || !REVISION_RE.test(String(event.stateRevision || '')) || !SHA256_RE.test(String(event.stateRevisionSealSha256 || ''))) {
    return { valid: false, reasons: ['CROSS_GATE_EVENT_STATE_PROOF_INVALID'], pins: [] };
  }
  const gateRoot = path.join(root, 'governance', 'gates', event.gateId);
  const sealPath = path.join(gateRoot, 'state', 'revisions', event.stateRevision, 'STATE_SEAL.json');
  const sealIdentity = exactFileIdentity(sealPath);
  const seal = sealIdentity ? readJsonQuiet(sealPath) : null;
  if (!sealIdentity || !seal || sealIdentity.sha256 !== event.stateRevisionSealSha256) reasons.push('CROSS_GATE_EVENT_SEAL_MISSING_OR_MISMATCH');
  const currentState = readJsonQuiet(path.join(gateRoot, 'state', 'CURRENT_STATE.json'));
  const sealReport = sealIdentity
    ? validateStateSeal({ root, sealPath, currentRevision: currentState?.stateRevision })
    : { valid: false };
  if (!sealReport.valid) reasons.push('CROSS_GATE_EVENT_SEAL_INVALID');

  const contractSha256 = seal?.payload?.contractSha256;
  if (!SHA256_RE.test(String(contractSha256 || ''))) reasons.push('CROSS_GATE_EVENT_CONTRACT_BINDING_INVALID');
  const contractsRoot = path.join(gateRoot, 'contracts');
  const allContracts = fs.existsSync(contractsRoot)
    ? fs.readdirSync(contractsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && EXECUTION_CONTRACT_RE.test(entry.name))
      .map((entry) => {
        const absolute = path.join(contractsRoot, entry.name);
        return { absolute, identity: exactFileIdentity(absolute), json: readJsonQuiet(absolute) };
      })
    : [];
  const contracts = allContracts.filter((entry) => entry.identity?.sha256 === contractSha256);
  if (contracts.length !== 1) reasons.push('CROSS_GATE_EVENT_CONTRACT_IDENTITY_AMBIGUOUS');
  const contract = contracts[0]?.json ?? null;
  if (contract?.gateId !== event.gateId) reasons.push('CROSS_GATE_EVENT_CONTRACT_GATE_MISMATCH');
  // Discovery remains fail-closed when the event seal is absent: an unsealed
  // gate that visibly contains a contract pin is still the earliest attempted
  // proof and may not be skipped in favour of a later, healthier gate.
  const discoveryContracts = contract
    ? [contract]
    : allContracts.map((entry) => entry.json).filter(Boolean)
      .filter((candidate) => collectContractPins(candidate, protectedPath).length > 0);
  const pins = [...new Set(discoveryContracts.flatMap((candidate) => collectContractPins(candidate, protectedPath)))];
  return { valid: reasons.length === 0, reasons, pins };
}

/**
 * Cross-gate protected-hash succession law. The first later ledger-anchored gate
 * whose sealed contract pins the protected path is the only possible successor
 * gate. That gate must have exactly one later COMPLETE_CONFIRMED proof, and the
 * contract sealed by that proof must pin the live identity. Later gates that
 * merely carry the already-succeeded identity do not create competing proofs.
 */
export function classifyCrossGateProtectedHashSuccession({
  root,
  gateId,
  stateRevision,
  protectedPath,
  expectedSha256,
  actualSha256,
  ledgerPath = null
} = {}) {
  const rootResolved = path.resolve(root || '.');
  const reasons = [];
  const resolvedLedgerPath = ledgerPath
    ? (path.isAbsolute(ledgerPath) ? ledgerPath : path.resolve(rootResolved, ledgerPath))
    : path.join(rootResolved, ...DEFAULT_LEDGER_PATH.split('/'));
  const ledger = readLedgerDocument(resolvedLedgerPath);
  if (!ledger.valid) return { proven: false, reasonCodes: ['CROSS_GATE_LEDGER_INVALID', ...ledger.reasons] };

  const sourceGateRoot = path.join(rootResolved, 'governance', 'gates', gateId);
  const sourceSealPath = path.join(sourceGateRoot, 'state', 'revisions', stateRevision, 'STATE_SEAL.json');
  const sourceSealIdentity = exactFileIdentity(sourceSealPath);
  const sourceCurrentState = readJsonQuiet(path.join(sourceGateRoot, 'state', 'CURRENT_STATE.json'));
  const sourceSealReport = sourceSealIdentity
    ? validateStateSeal({ root: rootResolved, sealPath: sourceSealPath, currentRevision: sourceCurrentState?.stateRevision })
    : { valid: false };
  if (!sourceSealIdentity || !sourceSealReport.valid) reasons.push('CROSS_GATE_SOURCE_REVISION_UNSEALED');
  const sourceAnchors = sourceSealIdentity
    ? ledger.events.filter((event) => event?.gateId === gateId
      && event?.stateRevision === stateRevision
      && event?.stateRevisionSealSha256 === sourceSealIdentity.sha256)
    : [];
  if (sourceAnchors.length !== 1) reasons.push('CROSS_GATE_SOURCE_LEDGER_ANCHOR_MISSING_OR_AMBIGUOUS');
  const sourceAnchor = sourceAnchors[0] ?? null;
  const sourceGateEvents = ledger.events.filter((event) => event?.gateId === gateId);
  if (sourceGateEvents.at(-1)?.toStatus !== 'COMPLETE_CONFIRMED') reasons.push('CROSS_GATE_SOURCE_GATE_NOT_COMPLETE_CONFIRMED');
  if (reasons.length > 0) return { proven: false, reasonCodes: reasons };

  const inspected = ledger.events
    .filter((event) => event?.gateId !== gateId && event?.stateRevision && event?.stateRevisionSealSha256)
    .map((event) => ({ event, proof: inspectLedgerSealedContract({ root: rootResolved, event, protectedPath }) }))
    .filter(({ proof }) => proof.pins.includes(actualSha256));
  const laterPins = inspected.filter(({ event }) => event.ordinal > sourceAnchor.ordinal);
  if (laterPins.length === 0) {
    reasons.push(inspected.length > 0 ? 'CROSS_GATE_PROOF_NOT_LATER' : 'CROSS_GATE_LATER_PROOF_ABSENT');
    return { proven: false, reasonCodes: reasons };
  }

  const firstPin = laterPins[0];
  if (!firstPin.proof.valid) reasons.push(...firstPin.proof.reasons);
  if (firstPin.proof.pins.length !== 1 || firstPin.proof.pins[0] !== actualSha256) reasons.push('CROSS_GATE_LATER_CONTRACT_LIVE_PIN_MISMATCH');
  const pinningGateId = firstPin.event.gateId;
  const laterProofs = ledger.events.filter((event) => event?.gateId === pinningGateId
    && event?.toStatus === 'COMPLETE_CONFIRMED'
    && event?.ordinal > sourceAnchor.ordinal);
  if (laterProofs.length !== 1) reasons.push(laterProofs.length === 0 ? 'CROSS_GATE_LATER_PROOF_ABSENT' : 'CROSS_GATE_LATER_PROOF_AMBIGUOUS');
  const laterProofEvent = laterProofs[0] ?? null;
  if (laterProofEvent && laterProofEvent.ordinal <= sourceAnchor.ordinal) reasons.push('CROSS_GATE_PROOF_NOT_LATER');
  if (laterProofEvent) {
    const completionProof = inspectLedgerSealedContract({ root: rootResolved, event: laterProofEvent, protectedPath });
    if (!completionProof.valid) reasons.push(...completionProof.reasons);
    if (completionProof.pins.length !== 1 || completionProof.pins[0] !== actualSha256) reasons.push('CROSS_GATE_LATER_CONTRACT_LIVE_PIN_MISMATCH');
  }
  const pinningGateEvents = ledger.events.filter((event) => event?.gateId === pinningGateId);
  if (pinningGateEvents.at(-1)?.toStatus !== 'COMPLETE_CONFIRMED') reasons.push('CROSS_GATE_PINNING_GATE_NOT_COMPLETE_CONFIRMED');
  if (!SHA256_RE.test(String(expectedSha256 || '')) || !SHA256_RE.test(String(actualSha256 || '')) || expectedSha256 === actualSha256) {
    reasons.push('CROSS_GATE_HASH_TRANSITION_INVALID');
  }
  return {
    proven: reasons.length === 0,
    reasonCodes: [...new Set(reasons)],
    ...(reasons.length === 0 ? { sourceEventId: sourceAnchor.eventId, pinningGateId, proofEventId: laterProofEvent.eventId } : {})
  };
}

/**
 * FC-02 shared law. A stale protected hash is disclosed as historical succession
 * only when the complete successor chain is reproduced from live bytes. Every
 * missing, ambiguous or malformed proof component is fail-closed.
 *
 * `historicalLedgerPrefixProven` is deliberately an input: the full ledger
 * validator calls this module, so this module must never call it back. The Wheel
 * adapter may supply the already-existing exact-prefix proof without creating a
 * validation cycle. Protected-hash succession itself is proven entirely here.
 */
export function classifyProtectedHashLiveCheck({
  root,
  gateId,
  stateRevision,
  protectedHash,
  currentStatePath = null,
  ledgerPath = null,
  legacyBindingsPath = null,
  historicalLedgerPrefixProven = false
} = {}) {
  const rootResolved = path.resolve(root || '.');
  const protectedPath = normalizedPath(protectedHash?.path);
  const expectedSha256 = protectedHash?.sha256;
  const base = { gateId, stateRevision, protectedPath, expectedSha256 };
  const early = [];
  if (!gateId || !REVISION_RE.test(String(stateRevision || ''))) early.push('PROTECTED_REVISION_ID_INVALID');
  if (!safeRelative(protectedPath)) early.push('PROTECTED_PATH_INVALID');
  if (!SHA256_RE.test(String(expectedSha256 || ''))) early.push('PROTECTED_SHA256_INVALID');
  if (early.length > 0) return protectedResult(PROTECTED_HASH_MISMATCH, { ...base, reasonCodes: early });

  const protectedAbsolute = path.resolve(rootResolved, ...protectedPath.split('/'));
  const live = exactFileIdentity(protectedAbsolute);
  const actualSha256 = live?.sha256 ?? null;
  const gateRoot = path.join(rootResolved, 'governance', 'gates', gateId);
  const revisionRoot = path.join(gateRoot, 'state', 'revisions');
  const targetCheckpointPath = path.join(revisionRoot, stateRevision, 'CHECKPOINT.json');
  const targetCheckpoint = readJsonQuiet(targetCheckpointPath);
  const targetEntries = Array.isArray(targetCheckpoint?.protectedHashes)
    ? targetCheckpoint.protectedHashes.filter((entry) => normalizedPath(entry?.path) === protectedPath)
    : [];
  if (targetEntries.length !== 1) early.push(targetEntries.length > 1 ? 'DUPLICATE_PROTECTED_PATH' : 'PREDECESSOR_PROTECTED_PATH_MISSING');
  if (targetCheckpoint?.gateId !== gateId || targetCheckpoint?.stateRevision !== stateRevision) early.push('PREDECESSOR_CHECKPOINT_IDENTITY_INVALID');
  if (targetEntries.length === 1 && targetEntries[0].sha256 !== expectedSha256) early.push('PREDECESSOR_PROTECTED_HASH_BINDING_MISMATCH');
  if (live && actualSha256 === expectedSha256 && early.length === 0) {
    return protectedResult(PROTECTED_HASH_MATCH, { ...base, actualSha256 });
  }

  const currentPath = currentStatePath || path.join(gateRoot, 'state', 'CURRENT_STATE.json');
  const currentState = readJsonQuiet(currentPath);
  const currentRevision = currentState?.stateRevision;
  if (historicalLedgerPrefixProven === true
      && protectedPath === DEFAULT_LEDGER_PATH
      && REVISION_RE.test(String(currentRevision || ''))
      && early.length === 0) {
    return protectedResult(HISTORICAL_LEDGER_PREFIX, { ...base, actualSha256 });
  }

  const crossGate = classifyCrossGateProtectedHashSuccession({
    root: rootResolved,
    gateId,
    stateRevision,
    protectedPath,
    expectedSha256,
    actualSha256,
    ledgerPath
  });
  if (crossGate.proven) {
    return protectedResult(HISTORICAL_PROTECTED_HASH_SUPERSEDED, { ...base, actualSha256 });
  }

  const reasons = [...early];
  if (!live) reasons.push('PROTECTED_HASH_TARGET_ABSENT');
  if (!currentState || currentState.gateId !== gateId || !REVISION_RE.test(String(currentRevision || ''))) reasons.push('CURRENT_STATE_INVALID');
  if (currentRevision === stateRevision) reasons.push('EXCEPTION_CURRENT_REVISION_FORBIDDEN');

  const revisionNames = fs.existsSync(revisionRoot)
    ? fs.readdirSync(revisionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && REVISION_RE.test(entry.name))
      .map((entry) => entry.name).sort()
    : [];
  const numbers = revisionNames.map(revisionNumber);
  if (numbers.some((number, index) => number !== index + 1)) reasons.push('REVISION_SEQUENCE_GAP');
  const targetIndex = revisionNames.indexOf(stateRevision);
  const currentIndex = revisionNames.indexOf(currentRevision);
  if (targetIndex < 0) reasons.push('PREDECESSOR_REVISION_ABSENT');
  if (currentIndex < 0) reasons.push('CURRENT_REVISION_ABSENT');
  if (targetIndex >= 0 && currentIndex >= 0 && targetIndex >= currentIndex) reasons.push('SUCCESSOR_NOT_CURRENT');
  if (currentIndex >= 0 && currentIndex !== revisionNames.length - 1) reasons.push('CURRENT_REVISION_NOT_UNIQUE_HEAD');

  const currentStatePointers = collectNamedFiles(gateRoot, 'CURRENT_STATE.json');
  const canonicalCurrentState = path.join(gateRoot, 'state', 'CURRENT_STATE.json');
  if (currentStatePointers.length !== 1 || path.resolve(currentStatePointers[0] || '') !== path.resolve(canonicalCurrentState)) reasons.push('PARALLEL_CURRENT_STATE_POINTER');
  const currentContractPointers = collectNamedFiles(gateRoot, 'CURRENT_CONTRACT.json');
  const canonicalCurrentContract = path.join(gateRoot, 'contracts', 'CURRENT_CONTRACT.json');
  if (currentContractPointers.length !== 1 || path.resolve(currentContractPointers[0] || '') !== path.resolve(canonicalCurrentContract)) reasons.push('PARALLEL_CURRENT_CONTRACT_POINTER');

  const records = new Map();
  const seals = new Map();
  for (const revisionName of revisionNames) {
    const revisionDir = path.join(revisionRoot, revisionName);
    const checkpointPath = path.join(revisionDir, 'CHECKPOINT.json');
    const defectsPath = path.join(revisionDir, 'OPEN_DEFECTS.json');
    const sealPath = path.join(revisionDir, 'STATE_SEAL.json');
    const checkpointIdentity = exactFileIdentity(checkpointPath);
    const defectsIdentity = exactFileIdentity(defectsPath);
    const sealIdentity = exactFileIdentity(sealPath);
    const checkpoint = checkpointIdentity ? readJsonQuiet(checkpointPath) : null;
    const defects = defectsIdentity ? readJsonQuiet(defectsPath) : null;
    const seal = sealIdentity ? readJsonQuiet(sealPath) : null;
    const sealReport = sealIdentity ? validateStateSeal({ root: rootResolved, sealPath, currentRevision }) : { valid: false, findings: [] };
    records.set(revisionName, { revisionName, revisionDir, checkpointPath, defectsPath, sealPath, checkpointIdentity, defectsIdentity, sealIdentity, checkpoint, defects, seal, sealReport });
    if (sealIdentity && seal) seals.set(revisionName, { sha256: sealIdentity.sha256, gateId: seal.gateId, stateRevision: seal.stateRevision, previousStateSealSha256: seal.previousStateSealSha256 });
  }

  if (targetIndex >= 0 && currentIndex >= 0 && targetIndex < currentIndex) {
    const chain = revisionNames.slice(targetIndex, currentIndex + 1).map((name) => records.get(name));
    const hashes = [];
    for (const [offset, record] of chain.entries()) {
      if (!record?.checkpoint || record.checkpoint.gateId !== gateId || record.checkpoint.stateRevision !== record.revisionName) reasons.push(`CHECKPOINT_IDENTITY_INVALID:${record?.revisionName}`);
      if (!record?.defects || record.defects.gateId !== gateId || record.defects.stateRevision !== record.revisionName) reasons.push(`OPEN_DEFECTS_IDENTITY_INVALID:${record?.revisionName}`);
      if (!record?.sealIdentity) reasons.push(offset === 0 ? 'PREDECESSOR_UNSEALED' : 'SUCCESSOR_UNSEALED');
      else if (!record.sealReport.valid) reasons.push(offset === 0 ? 'PREDECESSOR_SEAL_INVALID' : 'SUCCESSOR_SEAL_INVALID');
      const entries = Array.isArray(record?.checkpoint?.protectedHashes)
        ? record.checkpoint.protectedHashes.filter((entry) => normalizedPath(entry?.path) === protectedPath)
        : [];
      if (entries.length === 0) reasons.push(offset === 0 ? 'PREDECESSOR_PROTECTED_PATH_MISSING' : 'SUCCESSOR_PROTECTED_PATH_MISSING');
      if (entries.length > 1) reasons.push('DUPLICATE_PROTECTED_PATH');
      hashes.push(entries.length === 1 ? entries[0].sha256 : null);

      const checkpointRelative = `governance/gates/${gateId}/state/revisions/${record.revisionName}/CHECKPOINT.json`;
      const defectsRelative = `governance/gates/${gateId}/state/revisions/${record.revisionName}/OPEN_DEFECTS.json`;
      for (const [role, relativePath, identity] of [
        ['CHECKPOINT', checkpointRelative, record.checkpointIdentity],
        ['OPEN_DEFECTS', defectsRelative, record.defectsIdentity]
      ]) {
        const members = Array.isArray(record?.seal?.sealedMembers)
          ? record.seal.sealedMembers.filter((member) => normalizedPath(member?.repoRelativePath) === relativePath)
          : [];
        if (members.length !== 1 || !identity || members[0].sha256 !== identity.sha256 || members[0].byteLength !== identity.byteLength) reasons.push(`${role}_SEAL_BINDING_INVALID:${record.revisionName}`);
      }
    }
    if (hashes[0] !== expectedSha256) reasons.push('PREDECESSOR_PROTECTED_HASH_BINDING_MISMATCH');
    if (hashes.at(-1) !== actualSha256) reasons.push('CURRENT_PROTECTED_HASH_LIVE_MISMATCH');
    if (hashes.slice(0, -1).some((hash) => hash !== expectedSha256) || hashes.at(-1) === expectedSha256) reasons.push('CARRIED_FORWARD_REPLACEMENT_AMBIGUOUS');
    for (let index = 1; index < chain.length; index += 1) {
      if (!chain[index - 1]?.sealIdentity || chain[index]?.seal?.previousStateSealSha256 !== chain[index - 1].sealIdentity.sha256) reasons.push(`STATE_SEAL_PREVIOUS_LINK_INVALID:${chain[index]?.revisionName}`);
    }
  }

  const resolvedLedgerPath = ledgerPath
    ? (path.isAbsolute(ledgerPath) ? ledgerPath : path.resolve(rootResolved, ledgerPath))
    : path.join(rootResolved, ...DEFAULT_LEDGER_PATH.split('/'));
  const resolvedBindingsPath = legacyBindingsPath
    ? (path.isAbsolute(legacyBindingsPath) ? legacyBindingsPath : path.resolve(rootResolved, legacyBindingsPath))
    : path.join(rootResolved, ...DEFAULT_LEGACY_BINDINGS_PATH.split('/'));
  const ledger = readLedgerDocument(resolvedLedgerPath);
  reasons.push(...ledger.reasons);
  const legacy = readLegacyBindings(resolvedBindingsPath);
  const lineage = resolveStateRevisionLineage({
    gateId,
    events: ledger.events,
    legacyBindings: legacy?.bindings ?? [],
    legacyEraMaxOrdinal: legacy?.legacyEraMaxOrdinal ?? undefined,
    seals,
    presentRevisions: revisionNames
  });
  if (lineage.resolved !== currentRevision || lineage.anchorState !== 'LEDGER_ANCHORED') reasons.push('CURRENT_NOT_LEDGER_ANCHORED');
  reasons.push(...lineage.findings.map((item) => `LINEAGE_${item.code}`));
  const currentRecord = records.get(currentRevision);
  const predecessorRecord = currentIndex > 0 ? records.get(revisionNames[currentIndex - 1]) : null;
  if (!currentRecord?.sealIdentity || currentState?.stateSealSha256 !== currentRecord.sealIdentity.sha256) reasons.push('CURRENT_STATE_SEAL_BINDING_INVALID');

  const contractsRoot = path.join(gateRoot, 'contracts');
  const contracts = fs.existsSync(contractsRoot)
    ? fs.readdirSync(contractsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && EXECUTION_CONTRACT_RE.test(entry.name))
      .map((entry) => {
        const absolute = path.join(contractsRoot, entry.name);
        const identity = exactFileIdentity(absolute);
        return { path: `governance/gates/${gateId}/contracts/${entry.name}`, absolute, identity, json: readJsonQuiet(absolute) };
      })
    : [];
  const predecessorContractMatches = contracts.filter((entry) => entry.identity?.sha256 === predecessorRecord?.seal?.payload?.contractSha256);
  const currentContractMatches = contracts.filter((entry) => entry.identity?.sha256 === currentRecord?.seal?.payload?.contractSha256);
  if (predecessorContractMatches.length !== 1) reasons.push('PREDECESSOR_CONTRACT_IDENTITY_AMBIGUOUS');
  if (currentContractMatches.length !== 1) reasons.push('CURRENT_CONTRACT_IDENTITY_AMBIGUOUS');
  const predecessorContract = predecessorContractMatches[0];
  const currentContract = currentContractMatches[0];
  if (predecessorContract?.json?.gateId !== gateId || currentContract?.json?.gateId !== gateId) reasons.push('CONTRACT_GATE_MISMATCH');
  if (currentContract && predecessorContract) {
    if (currentContract.json?.previousContractPath !== predecessorContract.path
        || currentContract.json?.previousContractSha256 !== predecessorContract.identity.sha256
        || revisionNumber(currentContract.json?.contractRevision) !== revisionNumber(predecessorContract.json?.contractRevision) + 1) reasons.push('CONTRACT_LINEAGE_MISMATCH');
    const predecessorPins = [...new Set(collectContractPins(predecessorContract.json, protectedPath))];
    const currentPins = [...new Set(collectContractPins(currentContract.json, protectedPath))];
    if (predecessorPins.length > 0 || currentPins.length > 0) {
      if (predecessorPins.length !== 1 || predecessorPins[0] !== expectedSha256) reasons.push('PREDECESSOR_CONTRACT_PIN_MISMATCH');
      if (currentPins.length !== 1 || currentPins[0] !== actualSha256) reasons.push('CURRENT_CONTRACT_PIN_MISMATCH');
    }
    const competingContracts = contracts.filter((entry) => entry.json?.previousContractPath === predecessorContract.path && entry.json?.previousContractSha256 === predecessorContract.identity.sha256);
    if (competingContracts.length !== 1 || competingContracts[0].path !== currentContract.path) reasons.push('COMPETING_CONTRACT_SUCCESSOR');
  }

  const currentContractPointer = readJsonQuiet(canonicalCurrentContract);
  const currentContractPointerIdentity = exactFileIdentity(canonicalCurrentContract);
  if (!currentContract || currentContractPointer?.gateId !== gateId
      || currentContractPointer?.contractRevision !== currentContract.json?.contractRevision
      || currentContractPointer?.contractPath !== currentContract.path
      || currentContractPointer?.contractSha256 !== currentContract.identity.sha256) reasons.push('CURRENT_CONTRACT_POINTER_BINDING_INVALID');

  const successionEvents = ledger.events.filter((event) => event?.gateId === gateId
    && event?.transitionType === CONTRACT_SUCCESSION_TRANSITION_TYPE
    && event?.stateRevision === currentRevision);
  if (successionEvents.length !== 1) reasons.push('CONTRACT_SUCCESSION_EVENT_MISSING_OR_COMPETING');
  const successionEvent = successionEvents[0];
  const gateEvents = ledger.events.filter((event) => event?.gateId === gateId);
  if (successionEvent && gateEvents.at(-1) !== successionEvent) reasons.push('CONTRACT_SUCCESSION_NOT_GATE_HEAD');
  if (successionEvent && !CONTRACT_SUCCESSION_TRANSITIONS.some(([from, to, type]) => from === successionEvent.fromStatus && to === successionEvent.toStatus && type === successionEvent.transitionType)) reasons.push('CONTRACT_SUCCESSION_TRANSITION_INVALID');
  if (successionEvent && currentRecord?.sealIdentity && successionEvent.stateRevisionSealSha256 !== currentRecord.sealIdentity.sha256) reasons.push('CONTRACT_SUCCESSION_STATE_PIN_MISMATCH');

  let successionAuthority = null;
  let successionAuthorityIdentity = null;
  if (successionEvent && safeRelative(successionEvent.authorityPath)) {
    const authorityAbsolute = path.resolve(rootResolved, ...successionEvent.authorityPath.split('/'));
    successionAuthorityIdentity = exactFileIdentity(authorityAbsolute);
    successionAuthority = successionAuthorityIdentity ? readJsonQuiet(authorityAbsolute) : null;
  }
  if (!successionAuthority || !successionAuthorityIdentity || successionAuthorityIdentity.sha256 !== successionEvent?.authoritySha256) reasons.push('CONTRACT_SUCCESSION_AUTHORITY_MISSING_OR_MISMATCH');
  else {
    const authorityShape = validateGateContractSuccessionLedgerBoundAuthorityShape(successionAuthority);
    if (!authorityShape.valid) reasons.push(...authorityShape.findings.map((item) => `CONTRACT_SUCCESSION_AUTHORITY_${item.code}`));
    if (!predecessorContract || successionAuthority.predecessorContractPath !== predecessorContract.path
        || successionAuthority.predecessorContractSha256 !== predecessorContract.identity.sha256
        || successionAuthority.predecessorContractRevision !== predecessorContract.json?.contractRevision) reasons.push('CONTRACT_SUCCESSION_PREDECESSOR_BINDING_INVALID');
    if (!currentContract || successionAuthority.successorContractPath !== currentContract.path
        || successionAuthority.successorContractSha256 !== currentContract.identity.sha256
        || successionAuthority.successorContractRevision !== currentContract.json?.contractRevision) reasons.push('CONTRACT_SUCCESSION_SUCCESSOR_BINDING_INVALID');
    if (successionAuthority.currentContractPointerPath !== `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`
        || successionAuthority.successorCurrentContractSha256 !== currentContractPointerIdentity?.sha256) reasons.push('CONTRACT_SUCCESSION_POINTER_BINDING_INVALID');
    if (successionAuthority.previousStateSealSha256 !== predecessorRecord?.sealIdentity?.sha256
        || successionAuthority.successorStateRevision !== currentRevision) reasons.push('CONTRACT_SUCCESSION_STATE_CHAIN_BINDING_INVALID');
    if (successionAuthority.preLedgerEventCount !== successionEvent.ordinal - 1
        || successionAuthority.preLedgerPrefixSha256 !== ledgerPrefixSha256(ledger, successionAuthority.preLedgerEventCount)) reasons.push('CONTRACT_SUCCESSION_LEDGER_PREFIX_BINDING_INVALID');
    if (Object.hasOwn(successionAuthority, 'ledgerHeadEventId')) {
      const predecessorEvent = ledger.events[successionAuthority.preLedgerEventCount - 1];
      if (successionAuthority.ledgerHeadEventId !== predecessorEvent?.eventId
          || successionAuthority.ledgerHeadEventPayloadSha256 !== predecessorEvent?.eventPayloadSha256) reasons.push('CONTRACT_SUCCESSION_LEDGER_HEAD_BINDING_INVALID');
    }
  }

  if (predecessorRecord?.sealIdentity) {
    const competingStateSuccessors = [...records.values()].filter((record) => record.seal?.previousStateSealSha256 === predecessorRecord.sealIdentity.sha256);
    if (competingStateSuccessors.length !== 1 || competingStateSuccessors[0].revisionName !== currentRevision) reasons.push('COMPETING_STATE_SUCCESSOR');
  }

  return protectedResult(reasons.length === 0 ? HISTORICAL_PROTECTED_HASH_SUPERSEDED : PROTECTED_HASH_MISMATCH, {
    ...base,
    actualSha256,
    reasonCodes: [...reasons, ...crossGate.reasonCodes]
  });
}

const CHECKPOINT_FIELDS = ['gateId', 'stateRevision', 'milestone', 'resumePoint', 'completedTasks', 'openTasks', 'reusableEvidence', 'invalidatedEvidence', 'requiredNextActions', 'protectedHashes', 'createdAt'];
const DEFECT_FIELDS = ['defectId', 'severity', 'status', 'description', 'affectedRequirements', 'evidence', 'detector', 'repairScope', 'blockingProgression', 'openedAt', 'closedAt', 'closureEvidence'];
const POINTER_FIELDS = ['schemaVersion', 'gateId', 'stateRevision', 'revisionPath', 'stateSealSha256', 'committedByTransactionId'];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveOptionPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function finding(findings, detectorId, jsonPointer, actualValue, expectedRule, message, requirementId = 'REQ-REV-01') {
  findings.push({ detectorId, severity: 'BLOCKING', jsonPointer, actualValue, expectedRule, message, requirementId });
}

function readJson(file, findings, requirementId) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    finding(findings, 'MISSING_REVISION_INPUT', '/', file, 'existing JSON file', 'Required revision input is missing.', requirementId);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    finding(findings, 'INVALID_JSON', '/', file, 'valid JSON', error.message, requirementId);
    return null;
  }
}

function checkObject(value, required, allowed, findings, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    finding(findings, 'SCHEMA_VIOLATION', '/', value, 'object', `${label} must be an object.`);
    return;
  }
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) finding(findings, 'SCHEMA_VIOLATION', '/', key, 'required property', `${label} is missing ${key}.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) finding(findings, 'SCHEMA_VIOLATION', `/${key}`, value[key], 'additionalProperties=false', `${label} contains unknown field ${key}.`);
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveUnderRoot(root, relativePath, findings, pointer, requirementId = 'REQ-REV-02') {
  if (!safeRelative(relativePath)) {
    finding(findings, 'INVALID_NORMALIZED_PATH', pointer, relativePath, 'relative slash-separated path without traversal', 'Pointer path is unsafe.', requirementId);
    return null;
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    finding(findings, 'PATH_OUTSIDE_ROOT', pointer, relativePath, 'target below governed root', 'Pointer path escapes the governed root.', requirementId);
    return null;
  }
  return resolved;
}

function allowedMilestones(contract) {
  const policy = contract?.checkpointPolicy;
  if (Array.isArray(policy)) return policy;
  if (policy && Array.isArray(policy.milestones)) return policy.milestones;
  if (policy && Array.isArray(policy.allowedMilestones)) return policy.allowedMilestones;
  return [];
}

function validateDefects(defects, previous, findings) {
  const priorOpen = new Map((previous?.defects || []).filter((defect) => defect.status === 'OPEN').map((defect) => [defect.defectId, defect]));
  const currentIds = new Set();
  for (const [index, defect] of (defects || []).entries()) {
    const pointer = `/defects/${index}`;
    checkObject(defect, DEFECT_FIELDS, DEFECT_FIELDS, findings, 'Defect');
    if (currentIds.has(defect?.defectId)) finding(findings, 'DUPLICATE_DEFECT_ID', `${pointer}/defectId`, defect?.defectId, 'unique defectId', 'Defect id is duplicated.');
    currentIds.add(defect?.defectId);
    if (defect?.status === 'CLOSED' && (!defect.closedAt || !defect.closureEvidence)) finding(findings, 'DEFECT_CLOSED_WITHOUT_EVIDENCE', pointer, defect, 'closedAt and closureEvidence are non-empty', 'A defect was closed without executed closure evidence.', 'REQ-DEF-01');
  }
  for (const defectId of priorOpen.keys()) if (!currentIds.has(defectId)) finding(findings, 'DEFECT_DROPPED', '/defects', defectId, 'all prior OPEN defects carried forward', 'An OPEN defect disappeared without a CLOSED transition.', 'REQ-DEF-01');
}

function validateStateRevision({ root, gateId, currentStatePath, contractPath, ledgerPath = null, legacyBindingsPath = null }) {
  const findings = [];
  const protectedHashChecks = [];
  const rootResolved = path.resolve(root);
  const gateRoot = path.join(rootResolved, 'governance', 'gates', gateId);
  const revisionRoot = path.join(gateRoot, 'state', 'revisions');
  const currentPath = currentStatePath || path.join(gateRoot, 'state', 'CURRENT_STATE.json');
  const contract = contractPath && fs.existsSync(contractPath) ? readJson(contractPath, findings, 'REQ-CHK-01') : null;
  const current = readJson(currentPath, findings, 'REQ-REV-02');
  if (current) {
    checkObject(current, POINTER_FIELDS, POINTER_FIELDS, findings, 'CURRENT_STATE pointer');
    if (current.gateId !== gateId) finding(findings, 'POINTER_TARGET_MISMATCH', '/gateId', current.gateId, gateId, 'CURRENT_STATE gateId differs from requested gate.', 'REQ-REV-02');
  }
  if (!fs.existsSync(revisionRoot) || !fs.statSync(revisionRoot).isDirectory()) finding(findings, 'MISSING_REVISION_ROOT', '/', revisionRoot, 'existing revisions/Rxxxx directory', 'Revision root is missing.', 'REQ-REV-01');
  const revisionNames = fs.existsSync(revisionRoot) ? fs.readdirSync(revisionRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^R[0-9]{4}$/.test(entry.name)).map((entry) => entry.name).sort() : [];
  const revisionNumbers = revisionNames.map((name) => Number.parseInt(name.slice(1), 10));
  for (let index = 0; index < revisionNumbers.length; index += 1) if (revisionNumbers[index] !== index + 1) finding(findings, 'REVISION_SEQUENCE_GAP', '/stateRevision', revisionNumbers, 'R0001..Rxxxx without gaps', 'Revision sequence is not contiguous.', 'REQ-REV-01');
  const revisions = [];
  for (const revisionName of revisionNames) {
    const revisionDir = path.join(revisionRoot, revisionName);
    const checkpointPath = path.join(revisionDir, 'CHECKPOINT.json');
    const defectsPath = path.join(revisionDir, 'OPEN_DEFECTS.json');
    const sealPath = path.join(revisionDir, 'STATE_SEAL.json');
    const checkpoint = readJson(checkpointPath, findings, 'REQ-REV-01');
    const defects = readJson(defectsPath, findings, 'REQ-DEF-01');
    checkObject(checkpoint, CHECKPOINT_FIELDS, CHECKPOINT_FIELDS, findings, 'CHECKPOINT');
    checkObject(defects, ['gateId', 'stateRevision', 'defects'], ['gateId', 'stateRevision', 'defects'], findings, 'OPEN_DEFECTS');
    if (checkpoint && (checkpoint.gateId !== gateId || checkpoint.stateRevision !== revisionName)) finding(findings, 'REVISION_ID_MISMATCH', '/stateRevision', checkpoint.stateRevision, revisionName, 'Checkpoint identity differs from its directory.', 'REQ-REV-01');
    if (defects && (defects.gateId !== gateId || defects.stateRevision !== revisionName)) finding(findings, 'REVISION_ID_MISMATCH', '/stateRevision', defects.stateRevision, revisionName, 'Defect identity differs from its directory.', 'REQ-DEF-01');
    if (checkpoint && (!checkpoint.resumePoint || typeof checkpoint.resumePoint !== 'string')) finding(findings, 'EMPTY_RESUME_POINT', '/resumePoint', checkpoint.resumePoint, 'non-empty actionable next action', 'Checkpoint has no actionable resume point.', 'REQ-RSM-01');
    const milestones = allowedMilestones(contract);
    if (checkpoint && milestones.length > 0 && !milestones.includes(checkpoint.milestone)) finding(findings, 'MILESTONE_NOT_AUTHORIZED', '/milestone', checkpoint.milestone, milestones, 'Checkpoint milestone is outside contract checkpointPolicy.', 'REQ-CHK-01');
    validateDefects(defects?.defects, revisions.at(-1)?.defects?.defects ? { defects: revisions.at(-1).defects.defects } : null, findings);
    const sealReport = validateStateSeal({ root: rootResolved, sealPath });
    for (const sealFinding of sealReport.findings) findings.push({ ...sealFinding, jsonPointer: `${revisionName}${sealFinding.jsonPointer}` });
    revisions.push({ name: revisionName, number: Number.parseInt(revisionName.slice(1), 10), checkpoint, defects, sealPath });
    const protectedHashes = checkpoint?.protectedHashes || [];
    for (const [index, protectedHash] of protectedHashes.entries()) {
      const check = classifyProtectedHashLiveCheck({
        root: rootResolved,
        gateId,
        stateRevision: revisionName,
        protectedHash,
        currentStatePath: currentPath,
        ledgerPath,
        legacyBindingsPath
      });
      protectedHashChecks.push(check);
      if (check.classification === PROTECTED_HASH_MATCH) continue;
      if ([HISTORICAL_PROTECTED_HASH_SUPERSEDED, HISTORICAL_LEDGER_PREFIX].includes(check.classification)) {
        findings.push({
          detectorId: check.classification,
          severity: 'DISCLOSED',
          jsonPointer: `/${revisionName}/protectedHashes/${index}`,
          actualValue: protectedHash,
          expectedRule: 'historical protected identity is superseded only by a fully proven current successor',
          message: check.classification === HISTORICAL_PROTECTED_HASH_SUPERSEDED
            ? 'Historical protected identity was lawfully superseded and remains disclosed as historical.'
            : 'Historical ledger pin reproduces an independently proven append-only prefix.',
          requirementId: 'REQ-REV-01',
          protectedHashCheck: check
        });
      } else {
        findings.push({
          detectorId: PROTECTED_HASH_MISMATCH,
          severity: 'BLOCKING',
          jsonPointer: `/${revisionName}/protectedHashes/${index}`,
          actualValue: protectedHash,
          expectedRule: 'hash of protected real bytes or complete lawful successor proof',
          message: `Protected authority changed without a complete successor proof: ${check.reasonCodes.join(', ') || 'unclassified mismatch'}.`,
          requirementId: 'REQ-REV-01',
          protectedHashCheck: check
        });
      }
    }
  }
  for (let index = 1; index < revisions.length; index += 1) {
    const prior = revisions[index - 1].checkpoint;
    const currentCheckpoint = revisions[index].checkpoint;
    for (const action of prior?.requiredNextActions || []) if (!(currentCheckpoint?.completedTasks || []).includes(action)) finding(findings, 'RESTART_FROM_ZERO_DETECTED', `/${revisions[index].name}/completedTasks`, currentCheckpoint?.completedTasks, action, 'Next revision does not consume the prior checkpoint resume contract.', 'REQ-RSM-01');
  }
  // H2 — the authoritative current revision comes from the append-only ledger,
  // never from the highest directory name. `revisions` above is still read, but
  // only to supply seal bytes and to notice revisions the ledger never bound.
  const resolvedLedgerPath = ledgerPath
    ? (path.isAbsolute(ledgerPath) ? ledgerPath : path.resolve(rootResolved, ledgerPath))
    : path.join(rootResolved, ...DEFAULT_LEDGER_PATH.split('/'));
  const resolvedBindingsPath = legacyBindingsPath
    ? (path.isAbsolute(legacyBindingsPath) ? legacyBindingsPath : path.resolve(rootResolved, legacyBindingsPath))
    : path.join(rootResolved, ...DEFAULT_LEGACY_BINDINGS_PATH.split('/'));
  const events = readLedgerEvents(resolvedLedgerPath);
  const legacyDocument = readLegacyBindings(resolvedBindingsPath);
  const ledgerAvailable = Array.isArray(events);
  let lineage = null;
  {
    // A gate subtree with no ledger (isolated fixtures, standalone checks) is
    // resolved from the seal chain and REPORTED as unanchored, rather than
    // being failed. Ledger presence and integrity are enforced by the ledger
    // layer and by preflight; this tool validates revision structure and says
    // honestly how strong its anchor was.
    const seals = new Map();
    for (const revision of revisions) {
      const sealFile = path.join(revisionRoot, revision.name, 'STATE_SEAL.json');
      if (!fs.existsSync(sealFile)) continue;
      const bytes = fs.readFileSync(sealFile);
      let sealJson;
      try { sealJson = JSON.parse(bytes.toString('utf8')); } catch { continue; }
      seals.set(revision.name, {
        sha256: sha256Bytes(bytes),
        gateId: sealJson.gateId,
        stateRevision: sealJson.stateRevision,
        previousStateSealSha256: sealJson.previousStateSealSha256
      });
    }
    lineage = resolveStateRevisionLineage({
      gateId,
      events: ledgerAvailable ? events : [],
      legacyBindings: legacyDocument?.bindings ?? [],
      legacyEraMaxOrdinal: legacyDocument?.legacyEraMaxOrdinal ?? undefined,
      seals,
      presentRevisions: revisionNames
    });
    for (const lineageFinding of lineage.findings) {
      finding(findings, lineageFinding.code, '/stateRevision', lineageFinding.detail ?? null, 'ledger-anchored revision lineage', 'Revision lineage is not anchored by the append-only ledger.', 'REQ-REV-02');
    }
  }

  if (current) {
    const target = resolveUnderRoot(rootResolved, current.revisionPath, findings, '/revisionPath');
    if (!target || !fs.existsSync(target)) finding(findings, 'POINTER_TARGET_MISSING', '/revisionPath', current.revisionPath, 'existing revision directory', 'CURRENT_STATE target is absent.', 'REQ-REV-02');
    if (lineage?.resolved && current.stateRevision !== lineage.resolved) {
      finding(findings, 'POINTER_NOT_LEDGER_ANCHORED', '/stateRevision', current.stateRevision, lineage.resolved, 'CURRENT_STATE must name the revision the ledger last bound.', 'REQ-REV-02');
    }
    if (target && fs.existsSync(path.join(target, 'STATE_SEAL.json')) && sha256Bytes(fs.readFileSync(path.join(target, 'STATE_SEAL.json'))) !== current.stateSealSha256) finding(findings, 'POINTER_HASH_MISMATCH', '/stateSealSha256', current.stateSealSha256, sha256Bytes(fs.readFileSync(path.join(target, 'STATE_SEAL.json'))), 'CURRENT_STATE hash matches its seal bytes.', 'REQ-REV-02');
  }
  const blockingCount = findings.filter((item) => item.severity === 'BLOCKING').length;
  return {
    valid: blockingCount === 0,
    blockingCount,
    findings,
    protectedHashChecks,
    gateId,
    revisionCount: revisions.length,
    resolvedRevision: lineage?.resolved ?? null,
    resolvedBy: lineage?.decidedBy ?? null,
    anchorState: lineage?.anchorState ?? null,
    ledgerAvailable,
    sealChain: lineage?.sealChain ?? [],
    orphanRevisions: lineage?.orphans ?? [],
    currentStatePath: path.relative(rootResolved, currentPath).replaceAll('\\', '/')
  };
}

export { validateStateRevision };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const gateId = option('--gate-id', 'GATE13');
  const gateRoot = path.join(root, 'governance', 'gates', gateId);
  const report = validateStateRevision({
    root,
    gateId,
    currentStatePath: resolveOptionPath(root, option('--current-state', path.join(gateRoot, 'state/CURRENT_STATE.json'))),
    contractPath: resolveOptionPath(root, option('--contract', path.join(gateRoot, 'contracts/EXECUTION_CONTRACT_R0001.json')))
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
