#!/usr/bin/env node
/**
 * GATE_LIFECYCLE_ORCHESTRATOR — the WRITE side of the Gate fast path.
 *
 * WHAT THIS EXISTS TO CLOSE. `gate-fast-path-control-plane.mjs` compiles the real
 * R2→R3→R4→R5 chain and plans a Gate, but it is `PLAN_READ_ONLY`: it never writes
 * a ledger event, never mints a state revision, never seals anything. Every
 * mechanical lifecycle transition on GATE16 and GATE17 was therefore assembled by
 * hand — an agent computing SHA-256 values, ordinals, previousEventSha256 links
 * and sealed-member digests in its head, writing them, discovering a validator
 * rejected the result, rolling back, recomputing and retrying. That loop is the
 * single largest cost in a normal Gate, and none of it is reasoning.
 *
 * The split this file enforces:
 *
 *     an agent decides WHAT transition and WHICH cohort   (functional)
 *     this file derives every hash, ordinal, binding,     (mechanical)
 *     seal, revision and payload, and proves them
 *
 * ATOMICITY IS THE WHOLE DESIGN, AND IT IS NOT "WRITE THEN CHECK".
 *
 * The forbidden pattern is write → validate → discover invalid → roll back →
 * recompute → retry, because a rollback is only as good as the agent's memory of
 * what the bytes used to be, and a crash between write and rollback leaves the
 * canonical spine in a state nothing authorized.
 *
 * Instead every transition is derived COMPLETELY IN MEMORY, materialized into a
 * throwaway STAGING ROOT that is a full copy of `governance/`, and validated
 * THERE by the same canonical validators that guard the real tree. Only after the
 * staged candidate validates clean does anything touch the repository. A failed
 * candidate never wrote a canonical byte, so there is nothing to roll back — the
 * staging root is simply discarded.
 *
 * Copying `governance/` costs about half a second, which is what makes this
 * affordable enough to be the default rather than a ceremony reserved for
 * important transitions.
 *
 * IDEMPOTENCE IS DERIVED FROM THE LEDGER, NOT FROM A FLAG.
 *
 * The ledger already says what happened. Re-running a transition that is already
 * recorded returns ALREADY_SATISFIED after proving the recorded event is the one
 * that was asked for; a DIFFERENT event trying to repeat a transition the Gate
 * has already made is BLOCKED. Neither path can append a duplicate.
 *
 * MISSION IDENTITY IS DATA. There is no allowlist of Gate ids, mission names or
 * transition-specific branches anywhere in this file. A transition is described
 * by the caller's `transitionType`, `authorityPath` and cohort; the state machine
 * that admits it is the canonical table in `validate-status-ledger.mjs`, reused
 * rather than restated.
 *
 * NO NEW AUTHORITY. This orchestrator introduces no authority class and no
 * authority framework. It consumes the existing LOCAL_EXPLICIT_AUTHORITY
 * (`post-freeze-maintenance-authority.mjs`) and the existing gate
 * authorization/start records exactly as they already are.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import {
  MODE_FULL, TRANSITIONS, NATIVE_STATE_PIN_FIRST_ORDINAL, resolveDeclaredAuthorityIdentity, validateLedger
} from './validate-status-ledger.mjs';
import { computeSealedMembersDigest, validateStateSeal } from './validate-state-seal.mjs';
import { validateStateRevision } from './validate-state-revision.mjs';
import {
  PHASE_AUTHORIZE_PROGRAM_APPLY,
  evaluatePostFreezeMaintenanceAuthorityV2
} from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import { collectClosedStateSealMembers } from '../gee-v1/core/sealed-state-evidence.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';
import { collectPostFreezeMaintenanceObservation } from './post-freeze-maintenance-observation.mjs';
import { recoverTransaction } from './recover-governance-transaction.mjs';
import {
  createLifecycleTransactionProvenance,
  createGateLifecycleTransactionProvenance,
  createPrecontractBootstrapTransactionProvenance,
  validateLifecycleTransactionProvenance,
  LEDGER_SILENT_CASE_TYPES
} from './transaction-provenance.mjs';
import { durableReplaceFileSync, sweepPublicationResidue } from './durable-write.mjs';

export const ORCHESTRATOR_DOCUMENT = 'GATE_LIFECYCLE_ORCHESTRATOR';
export const ORCHESTRATOR_VERSION = 'R1';

export const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
export const REGISTRY_PATH = 'governance/GATE_REGISTRY_00_40.json';

/**
 * The mechanical transitions this orchestrator derives.
 *
 * Deliberately the four that a normal Gate performs and nothing else. Repair,
 * interruption, supersession and reopen are real transitions in the canonical
 * table but each carries judgement this file has no business automating; they
 * stay manual rather than being half-supported here.
 */
export const ORCHESTRATED_TRANSITIONS = Object.freeze([
  'AUTHORIZATION', 'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION'
]);
const MAINTENANCE_AUTHORITY_TRANSITIONS = new Set(['AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION']);

const GATE_RE = /^GATE[0-9]{2}$/;
const REVISION_RE = /^R[0-9]{4}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function revisionLabel(ordinal) { return `R${String(ordinal).padStart(4, '0')}`; }
function revisionOrdinal(label) { return REVISION_RE.test(label || '') ? Number.parseInt(label.slice(1), 10) : null; }

function repoPath(root, relativePath) { return path.resolve(root, ...relativePath.split('/')); }

const TRANSACTION_ROOT = 'governance/transactions';
function transactionIdFor(candidate) { return `${candidate.eventId}_TRANSACTION`; }
function transactionDirectory(candidate) { return `${TRANSACTION_ROOT}/TXN_${candidate.eventId}`; }
function transactionFile(candidate) { return `${transactionDirectory(candidate)}/TRANSACTION.json`; }
// The journal is written durably for the same reason the artifacts are: a
// half-written TRANSACTION.json is the one file recovery cannot do without, and
// truncating it in place is how a crash turns a recoverable transaction into an
// unreadable one.
function writeTransaction(root, relative, value) { const target = repoPath(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); durableReplaceFileSync(target, governedBytes(value)); }

function prepareLifecycleTransaction({ root, candidate, before, provenance }) {
  const transactionId = transactionIdFor(candidate);
  const directory = transactionDirectory(candidate);
  const stagedArtifacts = candidate.writes.map((write, index) => {
    const sourcePath = `${directory}/staged/${String(index).padStart(3, '0')}.bin`;
    const source = repoPath(root, sourcePath); fs.mkdirSync(path.dirname(source), { recursive: true }); durableReplaceFileSync(source, write.bytes);
    return { sourcePath, targetPath: write.path, sha256: write.sha256, byteLength: write.byteLength };
  });
  const transaction = {
    schemaVersion: 1, transactionId, transactionState: 'PREPARED',
    // A publisher that appends no ledger event declares its own case so recovery
    // knows not to append one for it. Everything else about the journal is
    // identical, which is the point: one journal format, one recovery path.
    //
    // The set is consulted rather than one member being special-cased. Naming only
    // MAINTENANCE_PROGRAM here silently rewrote the precontract bootstrap's case to
    // STATUS_TRANSITION, and the validator then — quite rightly — demanded of it a
    // ledger event it never had and must never have.
    //
    // An unrecognised case type still falls through to STATUS_TRANSITION, and that
    // is the fail-closed direction: STATUS_TRANSITION is the branch that REQUIRES a
    // matching ledger event, so a publisher that misdeclares itself is refused
    // rather than excused from appending.
    caseType: LEDGER_SILENT_CASE_TYPES.includes(candidate.caseType) ? candidate.caseType : 'STATUS_TRANSITION',
    gateId: candidate.gateId,
    stagedArtifacts, expectedHashes: candidate.writes.map((write) => ({ targetPath: write.path, sha256: write.sha256, byteLength: write.byteLength })),
    oldPointers: [], newPointers: [], commitOrder: candidate.writes.map((write) => write.path),
    rollbackPlan: candidate.writes.map((write) => ({ targetPath: write.path })), recoveryPlan: { mode: 'ROLL_FORWARD_FROM_STAGED_ARTIFACTS' },
    idempotencyKeys: [candidate.eventId], ledgerEvent: candidate.event ?? null, provenance, preparedAt: new Date().toISOString()
  };
  writeTransaction(root, transactionFile(candidate), transaction);
  durableReplaceFileSync(repoPath(root, `${directory}/PREPARED`), '');
  return { transaction, directory };
}

function setTransactionState(root, candidate, transaction, state) {
  const next = { ...transaction, transactionState: state };
  if (state === 'COMMITTED') next.committedAt = new Date().toISOString();
  writeTransaction(root, transactionFile(candidate), next);
  if (state === 'COMMITTED') durableReplaceFileSync(repoPath(root, `${transactionDirectory(candidate)}/COMMITTED`), '');
  if (state === 'ABORTED') fs.rmSync(repoPath(root, `${transactionDirectory(candidate)}/PREPARED`), { force: true });
  return next;
}

function discardTerminalTransaction(root, directory) {
  fs.rmSync(repoPath(root, directory), { recursive: true, force: true });
  const base = repoPath(root, TRANSACTION_ROOT);
  if (fs.existsSync(base) && fs.readdirSync(base).length === 0) fs.rmdirSync(base);
}

export function recoverPendingLifecycleTransactions(root) {
  const base = repoPath(root, TRANSACTION_ROOT);
  if (!fs.existsSync(base)) return { recovered: [] };
  const recovered = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('TXN_')) continue;
    const transactionPath = path.join(base, entry.name, 'TRANSACTION.json');
    if (!fs.existsSync(transactionPath)) continue;
    // A transaction that already carries its COMMITTED marker is not skipped, it
    // is DISCARDED. A process killed between the marker and the cleanup used to
    // leave its directory behind for good: recoverTransaction short-circuits on
    // COMMITTED and the sweep above stepped over it, so the residue survived
    // every later recovery. It is terminal for exactly the reason a successful
    // apply discards its own — the marker is only ever written after the
    // canonical bytes have landed.
    const result = recoverTransaction({ root, transactionPath, apply: true });
    if (!result.valid) return { recovered, blocked: result };
    discardTerminalTransaction(root, `${TRANSACTION_ROOT}/${entry.name}`);
    if (result.recoveryAction !== 'NONE') recovered.push(result.transactionId);
  }
  return { recovered };
}

function readBytesOrNull(root, relativePath) {
  const resolved = repoPath(root, relativePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved);
}

function readJsonOrNull(root, relativePath) {
  const bytes = readBytesOrNull(root, relativePath);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return null; }
}

/**
 * Canonical governed-document bytes.
 *
 * Every artifact this orchestrator writes is serialized exactly one way, so a
 * re-derivation of the same transition produces the same bytes and therefore the
 * same digests. Two-space indent with a trailing newline is the shape the
 * existing governed artifacts already use.
 */
export function governedBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** One ledger line, in the canonical serialization the ledger validator demands. */
export function ledgerLineBytes(event) {
  return Buffer.from(`${canonicalize(event)}\n`, 'utf8');
}

export function readLedgerEvents(root, ledgerRelativePath = LEDGER_PATH) {
  const bytes = readBytesOrNull(root, ledgerRelativePath);
  if (!bytes) return [];
  return bytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** Replayed status per Gate — the ledger's own answer, never a stored summary. */
export function replayGateStatus(events) {
  const status = new Map();
  for (const event of events) if (GATE_RE.test(event.gateId || '')) status.set(event.gateId, event.toStatus);
  return status;
}

/** The status the canonical table says this transition leads to, or null. */
export function resolveTargetStatus(fromStatus, transitionType) {
  const entry = TRANSITIONS.find(([from, , type]) => from === fromStatus && type === transitionType);
  return entry ? entry[1] : null;
}

/**
 * The Gate's current state revision, taken from CURRENT_STATE.json and
 * cross-checked against the ledger's native state pin.
 *
 * Both are consulted because each can be wrong in a way the other catches: a
 * hand-edited CURRENT_STATE can point at a revision the ledger never recorded,
 * and a ledger pin can name a revision whose directory was never written.
 */
export function resolveCurrentRevision({ root, gateId, events }) {
  const currentState = readJsonOrNull(root, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  const gateEvents = events.filter((event) => event.gateId === gateId);
  const pinned = [...gateEvents].reverse().find((event) => typeof event.stateRevision === 'string')?.stateRevision ?? null;
  return {
    fromCurrentState: currentState?.stateRevision ?? null,
    fromLedgerPin: pinned,
    stateSealSha256: currentState?.stateSealSha256 ?? null,
    agree: (currentState?.stateRevision ?? null) === pinned,
    present: currentState !== null
  };
}

/* -------------------------------------------------------------------------
 * Candidate derivation — everything mechanical, entirely in memory
 * ---------------------------------------------------------------------- */

/**
 * Derives the COMPLETE candidate transition without touching the repository.
 *
 * The caller supplies only what requires judgement: which Gate, which transition,
 * which authority document, which extra artifacts belong in the seal, and the
 * checkpoint's narrative fields. Everything a validator will later check —
 * ordinals, chain links, payload digests, sealed-member hashes and byte lengths,
 * the sealed-member set digest, the revision lineage, the native state pin — is
 * derived here from real bytes.
 *
 * Returns `{ status, findings, candidate }`. `status` is DERIVED, ALREADY_SATISFIED
 * or BLOCKED. A BLOCKED result carries every independent reason, never just the
 * first: an orchestrator that reports one obstacle at a time turns a single
 * diagnosis into a sequence of retries.
 */
export function deriveCandidateTransition({
  root,
  gateId,
  transitionType,
  eventId,
  authorityPath,
  recordedAt,
  sealedAt = recordedAt,
  sealCohort = [],
  sealedMemberOrder = null,
  checkpoint = {},
  openDefects = [],
  missionId = null,
  policy = WHEEL_EXTERNAL_AUTHORITY_POLICY
}) {
  const findings = [];
  const fail = (defectClass, detail) => { findings.push({ defectClass, ...detail }); };

  if (!GATE_RE.test(gateId || '')) fail('GATE_ID_INVALID', { actual: gateId, expected: 'GATEnn' });
  if (!ORCHESTRATED_TRANSITIONS.includes(transitionType)) {
    fail('TRANSITION_NOT_ORCHESTRATED', { actual: transitionType, expected: ORCHESTRATED_TRANSITIONS.join('|') });
  }
  if (typeof eventId !== 'string' || !eventId) fail('EVENT_ID_INVALID', { actual: eventId, expected: 'non-empty string' });
  if (typeof authorityPath !== 'string' || !authorityPath) fail('AUTHORITY_PATH_INVALID', { actual: authorityPath, expected: 'non-empty string' });
  if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt || ''))) {
    fail('RECORDED_AT_INVALID', { actual: recordedAt, expected: 'ISO-8601 UTC timestamp' });
  }
  if (findings.length) return { status: 'BLOCKED', findings, candidate: null };

  const events = readLedgerEvents(root);
  const statusByGate = replayGateStatus(events);
  const fromStatus = statusByGate.get(gateId) ?? 'NOT_STARTED';
  const toStatus = resolveTargetStatus(fromStatus, transitionType);

  // ---- idempotence, decided from the ledger ------------------------------
  //
  // Asked BEFORE anything is derived, because deriving a transition the ledger
  // already contains is how duplicates get written by accident.
  const existingById = events.find((event) => event.eventId === eventId);
  const existingSameTransition = events.find((event) => event.gateId === gateId && event.transitionType === transitionType);
  if (existingById) {
    const matches = existingById.gateId === gateId
      && existingById.transitionType === transitionType
      && existingById.authorityPath === authorityPath;
    if (!matches) {
      fail('EVENT_ID_ALREADY_USED_FOR_DIFFERENT_TRANSITION', {
        path: LEDGER_PATH,
        expected: { gateId, transitionType, authorityPath },
        actual: { gateId: existingById.gateId, transitionType: existingById.transitionType, authorityPath: existingById.authorityPath }
      });
      return { status: 'BLOCKED', findings, candidate: null };
    }
    return {
      status: 'ALREADY_SATISFIED',
      findings: [],
      candidate: null,
      satisfiedBy: {
        eventId: existingById.eventId,
        ordinal: existingById.ordinal,
        toStatus: existingById.toStatus,
        stateRevision: existingById.stateRevision ?? null,
        eventPayloadSha256: existingById.eventPayloadSha256
      }
    };
  }
  if (existingSameTransition) {
    fail('DUPLICATE_TRANSITION_FOR_GATE', {
      path: LEDGER_PATH,
      expected: `at most one ${transitionType} for ${gateId}`,
      actual: { existingEventId: existingSameTransition.eventId, existingOrdinal: existingSameTransition.ordinal }
    });
    return { status: 'BLOCKED', findings, candidate: null };
  }
  if (!toStatus) {
    fail('TRANSITION_NOT_ADMITTED_BY_CANONICAL_TABLE', {
      expected: `a ${transitionType} entry whose fromStatus is ${fromStatus}`,
      actual: { fromStatus, transitionType }
    });
    return { status: 'BLOCKED', findings, candidate: null };
  }

  // ---- authority must exist and be hashable ------------------------------
  //
  // `authorityPath` is not always a repository path: an EXTERNAL_CONFIRMATION
  // cites a logical report identifier that the ledger's source map resolves. A
  // literal file is hashed from its bytes; a logical id is resolved by the
  // ledger validator during candidate validation, and its digest must be
  // supplied by the caller because this file will not invent one.
  const directAuthorityBytes = readBytesOrNull(root, authorityPath);
  const authorityResolution = directAuthorityBytes
    ? { artifact: { bytes: directAuthorityBytes }, reason: null }
    : resolveDeclaredAuthorityIdentity({ root, identity: authorityPath, policy });
  const authoritySha256 = authorityResolution.artifact ? sha256Bytes(authorityResolution.artifact.bytes) : null;
  if (!authoritySha256) {
    fail('AUTHORITY_BYTES_UNRESOLVABLE', {
      path: authorityPath,
      expected: 'existing authority document whose bytes can be hashed',
      actual: authorityResolution.reason ?? 'ABSENT'
    });
    return { status: 'BLOCKED', findings, candidate: null };
  }

  // ---- state revision lineage --------------------------------------------
  const revisionState = resolveCurrentRevision({ root, gateId, events });
  if (revisionState.present && !revisionState.agree) {
    fail('CURRENT_STATE_LEDGER_PIN_DISAGREE', {
      path: `governance/gates/${gateId}/state/CURRENT_STATE.json`,
      expected: revisionState.fromLedgerPin,
      actual: revisionState.fromCurrentState
    });
    return { status: 'BLOCKED', findings, candidate: null };
  }
  const previousRevision = revisionState.fromCurrentState;
  const nextOrdinal = previousRevision === null ? 1 : revisionOrdinal(previousRevision) + 1;
  if (!Number.isInteger(nextOrdinal) || nextOrdinal < 1) {
    fail('STATE_REVISION_LINEAGE_UNRESOLVABLE', { expected: 'Rxxxx predecessor', actual: previousRevision });
    return { status: 'BLOCKED', findings, candidate: null };
  }
  const stateRevision = revisionLabel(nextOrdinal);
  const revisionDirectory = `governance/gates/${gateId}/state/revisions/${stateRevision}`;
  if (fs.existsSync(repoPath(root, revisionDirectory))) {
    fail('STATE_REVISION_DIRECTORY_ALREADY_EXISTS', {
      path: revisionDirectory,
      expected: 'absent before the transition mints it',
      actual: 'PRESENT'
    });
    return { status: 'BLOCKED', findings, candidate: null };
  }

  const previousSealPath = previousRevision
    ? `governance/gates/${gateId}/state/revisions/${previousRevision}/STATE_SEAL.json`
    : null;
  const previousSealBytes = previousSealPath ? readBytesOrNull(root, previousSealPath) : null;
  if (previousSealPath && !previousSealBytes) {
    fail('PREVIOUS_STATE_SEAL_ABSENT', { path: previousSealPath, expected: 'existing predecessor seal', actual: 'ABSENT' });
    return { status: 'BLOCKED', findings, candidate: null };
  }
  const previousStateSealSha256 = previousSealBytes ? sha256Bytes(previousSealBytes) : null;

  const contractRelativePath = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const contract = readJsonOrNull(root, contractRelativePath);
  if (!contract) {
    fail('CURRENT_CONTRACT_ABSENT', { path: contractRelativePath, expected: 'existing gate current contract', actual: 'ABSENT' });
    return { status: 'BLOCKED', findings, candidate: null };
  }

  // ---- revision artifacts -------------------------------------------------
  const checkpointRelativePath = `${revisionDirectory}/CHECKPOINT.json`;
  const openDefectsRelativePath = `${revisionDirectory}/OPEN_DEFECTS.json`;
  const sealRelativePath = `${revisionDirectory}/STATE_SEAL.json`;
  const currentStateRelativePath = `governance/gates/${gateId}/state/CURRENT_STATE.json`;

  const checkpointDocument = {
    gateId,
    stateRevision,
    milestone: checkpoint.milestone ?? `${gateId}_${transitionType}`,
    resumePoint: checkpoint.resumePoint ?? toStatus,
    completedTasks: checkpoint.completedTasks ?? [],
    openTasks: checkpoint.openTasks ?? [],
    reusableEvidence: checkpoint.reusableEvidence ?? [],
    invalidatedEvidence: checkpoint.invalidatedEvidence ?? [],
    requiredNextActions: checkpoint.requiredNextActions ?? [],
    protectedHashes: checkpoint.protectedHashes ?? [],
    createdAt: checkpoint.createdAt ?? recordedAt
  };
  const openDefectsDocument = { gateId, stateRevision, defects: openDefects };

  const checkpointBytes = governedBytes(checkpointDocument);
  const openDefectsBytes = governedBytes(openDefectsDocument);

  // ---- sealed members -----------------------------------------------------
  //
  // The three structurally required members come first, then the caller's
  // cohort. Every hash and byte length below is computed from REAL bytes — the
  // in-memory candidate bytes for artifacts this transaction produces, the
  // on-disk bytes for everything else. Nothing here accepts a caller-supplied
  // digest, which is what makes an H2-class wrong-hash defect unrepresentable
  // rather than merely detected.
  const candidateWrites = new Map([
    [checkpointRelativePath, checkpointBytes],
    [openDefectsRelativePath, openDefectsBytes]
  ]);

  // MEMBER ORDER IS THE CALLER'S, HASHES ARE NOT.
  //
  // The order of `sealedMembers` changes the seal's bytes and therefore its
  // digest, and the historical seals are not consistent about it — GATE17 R0003
  // ends with the contract while R0004 begins with it. Order is consequently
  // treated as caller data, expressed with symbolic tokens so a caller can name
  // the structural members without having to know which revision is about to be
  // minted. What is never caller data is any hash or byte length below.
  const STRUCTURAL_MEMBERS = new Map([
    ['CURRENT_CONTRACT', contractRelativePath],
    ['CHECKPOINT', checkpointRelativePath],
    ['OPEN_DEFECTS', openDefectsRelativePath]
  ]);
  const resolveMemberToken = (token) => STRUCTURAL_MEMBERS.get(token) ?? token;
  const sealedMemberPaths = Array.isArray(sealedMemberOrder) && sealedMemberOrder.length
    ? sealedMemberOrder.filter((entry) => typeof entry === 'string').map(resolveMemberToken)
    : [
        contractRelativePath,
        ...sealCohort.filter((entry) => typeof entry === 'string').map(resolveMemberToken),
        checkpointRelativePath,
        openDefectsRelativePath
      ];
  const seenMember = new Set();
  const sealedMembers = [];
  for (const memberPath of sealedMemberPaths) {
    if (seenMember.has(memberPath)) {
      fail('SEALED_MEMBER_DUPLICATE', { path: memberPath, expected: 'unique sealed member path', actual: 'listed twice' });
      continue;
    }
    seenMember.add(memberPath);
    const bytes = candidateWrites.get(memberPath) ?? readBytesOrNull(root, memberPath);
    if (!bytes) {
      fail('SEALED_MEMBER_ABSENT', { path: memberPath, expected: 'existing regular file', actual: 'ABSENT' });
      continue;
    }
    sealedMembers.push({ repoRelativePath: memberPath, sha256: sha256Bytes(bytes), byteLength: bytes.length });
  }
  if (findings.length) return { status: 'BLOCKED', findings, candidate: null };

  const sealPayload = {
    gateId,
    stateRevision,
    executionStatus: toStatus,
    contractSha256: contract.contractSha256,
    previousStateSealSha256,
    sealedMembersDigest: computeSealedMembersDigest(sealedMembers)
  };
  const sealDocument = {
    schemaVersion: 1,
    gateId,
    stateRevision,
    sealedMembers,
    previousStateSealSha256,
    sealedAt,
    payload: sealPayload,
    payloadSha256: sha256Canonical(sealPayload)
  };
  const sealBytes = governedBytes(sealDocument);
  const stateSealSha256 = sha256Bytes(sealBytes);

  const currentStateDocument = {
    schemaVersion: 1,
    gateId,
    stateRevision,
    revisionPath: revisionDirectory,
    stateSealSha256,
    committedByTransactionId: `${eventId}_TRANSACTION`
  };
  const currentStateBytes = governedBytes(currentStateDocument);

  // ---- ledger event -------------------------------------------------------
  const ordinal = events.length + 1;
  const previousEventSha256 = events.length ? events.at(-1).eventPayloadSha256 : null;
  const eventBody = {
    authorityPath,
    authoritySha256,
    eventId,
    fromStatus,
    gateId,
    ordinal,
    previousEventSha256,
    recordedAt,
    schemaVersion: 1,
    toStatus,
    transitionType
  };
  // The native state pin is required from ordinal 59 onward and forbidden
  // before it. The boundary is read from the canonical constant rather than
  // restated, so a future change to it cannot desynchronize this file.
  if (ordinal >= NATIVE_STATE_PIN_FIRST_ORDINAL) {
    eventBody.stateRevision = stateRevision;
    eventBody.stateRevisionSealSha256 = stateSealSha256;
  }
  const event = { ...eventBody, eventPayloadSha256: sha256Canonical(eventBody) };

  const priorLedgerBytes = readBytesOrNull(root, LEDGER_PATH) ?? Buffer.alloc(0);
  const candidateLedgerBytes = Buffer.concat([priorLedgerBytes, ledgerLineBytes(event)]);

  candidateWrites.set(sealRelativePath, sealBytes);
  candidateWrites.set(currentStateRelativePath, currentStateBytes);
  candidateWrites.set(LEDGER_PATH, candidateLedgerBytes);

  return {
    status: 'DERIVED',
    findings: [],
    candidate: {
      document: ORCHESTRATOR_DOCUMENT,
      version: ORCHESTRATOR_VERSION,
      missionId,
      gateId,
      transitionType,
      eventId,
      fromStatus,
      toStatus,
      stateRevision,
      previousRevision,
      ordinal,
      event,
      seal: sealDocument,
      currentState: currentStateDocument,
      checkpointDocument,
      openDefectsDocument,
      paths: {
        ledger: LEDGER_PATH,
        seal: sealRelativePath,
        currentState: currentStateRelativePath,
        checkpoint: checkpointRelativePath,
        openDefects: openDefectsRelativePath,
        revisionDirectory
      },
      writes: [...candidateWrites.entries()].map(([relativePath, bytes]) => ({
        path: relativePath,
        sha256: sha256Bytes(bytes),
        byteLength: bytes.length,
        // Kept out of the digestible summary on purpose; carried alongside so
        // the apply step never re-derives bytes it is supposed to be writing.
        bytes
      })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
      identities: {
        eventPayloadSha256: event.eventPayloadSha256,
        previousEventSha256,
        stateSealSha256,
        previousStateSealSha256,
        sealedMembersDigest: sealPayload.sealedMembersDigest,
        sealPayloadSha256: sealDocument.payloadSha256,
        authoritySha256
      }
    }
  };
}

/* -------------------------------------------------------------------------
 * Candidate validation — in a staging root, by the canonical validators
 * ---------------------------------------------------------------------- */

/**
 * A finding's stable identity, so the same observation about the same event is
 * recognisable across two validation runs.
 *
 * `lineNumber` is included deliberately and is safe: a transition APPENDS to the
 * ledger, so no pre-existing line moves. A finding whose line number changed is
 * therefore a finding about different bytes, and should not be forgiven as
 * pre-existing.
 */
function findingKey(item) {
  return [item.detectorId, item.eventId ?? '', item.gateId ?? '', item.jsonPointer ?? '', item.lineNumber ?? '', item.requirementId ?? ''].join('|');
}

/**
 * What the repository already looks like BEFORE the candidate.
 *
 * This exists because `validateLedger` in FULL mode is not a pass/fail gate on
 * this repository and never was: it reports 71 findings against the canonical
 * ledger at HEAD, most of them notices such as GATE_START_APPLIED and
 * HISTORICAL_RECONCILIATION_APPLIED that record that a governed thing happened.
 * Treating that output as a defect list would make every candidate look broken
 * and would hide the one finding that actually belonged to the transition.
 *
 * So the question asked of a candidate is the only one that means anything:
 * WHAT DID THIS TRANSITION INTRODUCE? Pre-existing findings are carried as a
 * baseline and subtracted. Nothing is suppressed — the baseline is reported.
 */
export function collectBaselineIntegrity(root, policy = WHEEL_EXTERNAL_AUTHORITY_POLICY) {
  const ledgerReport = validateLedger({
    root,
    ledgerPath: repoPath(root, LEDGER_PATH),
    mode: MODE_FULL,
    policy
  });
  const sealValidity = new Map();
  const gatesRoot = repoPath(root, 'governance/gates');
  if (fs.existsSync(gatesRoot)) {
    for (const gateEntry of fs.readdirSync(gatesRoot, { withFileTypes: true })) {
      if (!gateEntry.isDirectory() || !GATE_RE.test(gateEntry.name)) continue;
      const gateRevisions = path.join(gatesRoot, gateEntry.name, 'state', 'revisions');
      if (!fs.existsSync(gateRevisions)) continue;
      for (const revision of fs.readdirSync(gateRevisions, { withFileTypes: true })) {
        if (!revision.isDirectory() || !REVISION_RE.test(revision.name)) continue;
        const sealFile = path.join(gateRevisions, revision.name, 'STATE_SEAL.json');
        if (!fs.existsSync(sealFile)) continue;
        const relative = `governance/gates/${gateEntry.name}/state/revisions/${revision.name}/STATE_SEAL.json`;
        sealValidity.set(relative, validateStateSeal({ root, sealPath: sealFile }).valid);
      }
    }
  }
  return {
    ledgerFindingKeys: new Set(ledgerReport.findings.map(findingKey)),
    ledgerFindingCount: ledgerReport.findings.length,
    ledgerEventCount: ledgerReport.events.length,
    sealValidity
  };
}

function isGovernedRelativePath(value) {
  return typeof value === 'string' && value.startsWith('governance/')
    && !value.includes('\\') && !value.split('/').some((part) => !part || part === '.' || part === '..');
}

function replaceCandidateWrite(candidate, relativePath, bytes) {
  const write = { path: relativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length, bytes };
  const index = candidate.writes.findIndex((entry) => entry.path === relativePath);
  if (index >= 0) candidate.writes[index] = write;
  else candidate.writes.push(write);
  candidate.writes.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return write;
}

/**
 * Projection selection is contract-driven: every lifecycle transition refreshes
 * the global status snapshot, plus the deterministic generators declared by
 * the target Gate's current contract.  Generators operate only on staging.
 */
function refreshCandidateProjections({ stagingRoot, candidate, fail, projectionPolicyModulePath = null }) {
  const generatedOutputs = new Set(['governance/state/generated/GATE_STATUS_SNAPSHOT.json']);
  const run = (generatorPath) => {
    try {
      const args = [path.join(stagingRoot, ...generatorPath.split('/')), '--root', stagingRoot];
      if (generatorPath === 'governance/tools/generate-status-snapshot.mjs' && projectionPolicyModulePath) {
        args.push('--policy-module', projectionPolicyModulePath);
      }
      execFileSync(process.execPath, args, {
        cwd: stagingRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      fail('CANDIDATE_PROJECTION_REGENERATION_FAILED', {
        path: generatorPath,
        expected: 'existing deterministic generator completes against the candidate staging root',
        actual: error.stderr?.toString('utf8') || error.message
      });
    }
  };

  run('governance/tools/generate-status-snapshot.mjs');
  const currentContract = readJsonOrNull(stagingRoot, `governance/gates/${candidate.gateId}/contracts/CURRENT_CONTRACT.json`);
  const contractPath = currentContract?.contractPath;
  if (isGovernedRelativePath(contractPath)) {
    const contract = readJsonOrNull(stagingRoot, contractPath);
    for (const output of Array.isArray(contract?.requiredOutputs) ? contract.requiredOutputs : []) {
      if (isGovernedRelativePath(output?.path) && output.path.startsWith('governance/generated/')) generatedOutputs.add(output.path);
      if (isGovernedRelativePath(output?.path) && output.path.endsWith('.mjs') && /deterministic.*generator/i.test(output.role ?? '')) run(output.path);
    }
  }

  const writes = [];
  for (const relativePath of [...generatedOutputs].sort()) {
    const bytes = readBytesOrNull(stagingRoot, relativePath);
    if (!bytes) {
      fail('CANDIDATE_PROJECTION_ABSENT', { path: relativePath, expected: 'generator-produced output', actual: 'ABSENT' });
      continue;
    }
    writes.push(replaceCandidateWrite(candidate, relativePath, bytes));
  }
  return writes;
}

/**
 * Materializes the candidate into a disposable full copy of `governance/` and
 * validates it with the same tools that guard the real tree.
 *
 * The staging root is a real directory, not a mock, because the validators read
 * real files: seals resolve members from disk, the ledger validator resolves
 * authority documents, and the revision validator walks revision directories.
 * Validating a candidate against anything less than a materialized tree would
 * prove something about a model of the transition rather than the transition.
 */
export function validateCandidateInStagingRoot({ root, candidate, stagingRoot, baseline = null, now = new Date(), policy = WHEEL_EXTERNAL_AUTHORITY_POLICY, projectionPolicyModulePath = null }) {
  const findings = [];
  const fail = (defectClass, detail) => { findings.push({ defectClass, ...detail }); };

  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.cpSync(repoPath(root, 'governance'), path.join(stagingRoot, 'governance'), { recursive: true });

  for (const write of candidate.writes) {
    const target = path.join(stagingRoot, ...write.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, write.bytes);
  }

  const projectionWrites = refreshCandidateProjections({ stagingRoot, candidate, fail, projectionPolicyModulePath });

  // ---- ledger, in full, DIFFERENTIALLY ------------------------------------
  const effectiveBaseline = baseline ?? collectBaselineIntegrity(root, policy);
  const ledgerReport = validateLedger({
    root: stagingRoot,
    ledgerPath: path.join(stagingRoot, ...LEDGER_PATH.split('/')),
    mode: MODE_FULL,
    policy
  });
  const introducedLedgerFindings = ledgerReport.findings
    .filter((item) => !effectiveBaseline.ledgerFindingKeys.has(findingKey(item)));
  const introducedBlockingLedgerFindings = introducedLedgerFindings.filter((item) => item.severity !== 'INFO');
  const introducedInformationalLedgerFindings = introducedLedgerFindings.filter((item) => item.severity === 'INFO');
  for (const item of introducedBlockingLedgerFindings) {
    fail('CANDIDATE_LEDGER_INVALID', {
      path: LEDGER_PATH,
      detectorId: item.detectorId,
      eventId: item.eventId ?? null,
      jsonPointer: item.jsonPointer,
      expected: item.expectedRule ?? null,
      actual: item.actualValue ?? null,
      message: item.message
    });
  }

  // ---- the new seal -------------------------------------------------------
  const sealReport = validateStateSeal({
    root: stagingRoot,
    sealPath: path.join(stagingRoot, ...candidate.paths.seal.split('/'))
  });
  if (!sealReport.valid) {
    for (const item of sealReport.findings) {
      fail('CANDIDATE_STATE_SEAL_INVALID', {
        path: candidate.paths.seal,
        detectorId: item.detectorId,
        jsonPointer: item.jsonPointer,
        expected: item.expectedRule ?? null,
        actual: item.actualValue ?? null,
        message: item.message
      });
    }
  }

  // ---- revision lineage ---------------------------------------------------
  let revisionReport = null;
  try {
    revisionReport = validateStateRevision({
      root: stagingRoot,
      gateId: candidate.gateId,
      currentStatePath: path.join(stagingRoot, ...candidate.paths.currentState.split('/')),
      contractPath: path.join(stagingRoot, 'governance', 'gates', candidate.gateId, 'contracts', 'CURRENT_CONTRACT.json')
    });
    if (revisionReport && revisionReport.valid === false) {
      for (const item of revisionReport.findings || []) {
        fail('CANDIDATE_STATE_REVISION_INVALID', {
          path: candidate.paths.currentState,
          detectorId: item.detectorId ?? null,
          expected: item.expectedRule ?? null,
          actual: item.actualValue ?? null,
          message: item.message ?? null
        });
      }
    }
  } catch (error) {
    fail('CANDIDATE_STATE_REVISION_UNVALIDATABLE', {
      path: candidate.paths.currentState, expected: 'validate-state-revision completes', actual: error.message
    });
  }

  // ---- every OTHER seal in the repository must still validate -------------
  //
  // A transition may not disturb a seal it did not create. This is what turns
  // "we did not mean to touch history" into a checked property.
  const otherSeals = [];
  const revisionsRoot = path.join(stagingRoot, 'governance', 'gates');
  if (fs.existsSync(revisionsRoot)) {
    for (const gateEntry of fs.readdirSync(revisionsRoot, { withFileTypes: true })) {
      if (!gateEntry.isDirectory() || !GATE_RE.test(gateEntry.name)) continue;
      const gateRevisions = path.join(revisionsRoot, gateEntry.name, 'state', 'revisions');
      if (!fs.existsSync(gateRevisions)) continue;
      for (const revision of fs.readdirSync(gateRevisions, { withFileTypes: true })) {
        if (!revision.isDirectory() || !REVISION_RE.test(revision.name)) continue;
        const sealFile = path.join(gateRevisions, revision.name, 'STATE_SEAL.json');
        if (!fs.existsSync(sealFile)) continue;
        const relative = `governance/gates/${gateEntry.name}/state/revisions/${revision.name}/STATE_SEAL.json`;
        if (relative === candidate.paths.seal) continue;
        otherSeals.push({ relative, sealFile });
      }
    }
  }
  for (const { relative, sealFile } of otherSeals) {
    const report = validateStateSeal({ root: stagingRoot, sealPath: sealFile });
    // Differential here too: a seal that was already invalid before the
    // transition is a pre-existing condition this transition did not cause, and
    // blaming the transition for it would make every candidate unlaunchable.
    // A seal that was valid and is no longer is exactly what must block.
    const wasValid = effectiveBaseline.sealValidity.get(relative);
    if (!report.valid && wasValid !== false) {
      fail('CANDIDATE_DISTURBS_EXISTING_SEAL', {
        path: relative,
        expected: 'seal still validates after the candidate transition',
        actual: report.findings.map((item) => item.detectorId).join(',')
      });
    }
  }

  // ---- sealed-member immutability ----------------------------------------
  //
  // PRESTATE / SUCCESSOR SEMANTICS, exactly as proven on GATE16/GATE17: a member
  // sealed BEFORE this transaction is immutable, while an artifact this
  // transaction produced and its own successor revision sealed is a transaction
  // product and is NOT a pre-existing sealed-member mutation. The inventory is
  // taken from the REAL root — the state as it stood before the candidate — so a
  // successor-only member cannot appear in it by construction.
  const preStateSealed = collectClosedStateSealMembers(root);
  const preStateByPath = new Map(
    (preStateSealed.members || []).map((member) => [member.repoRelativePath, member])
  );
  for (const write of candidate.writes) {
    const sealedBefore = preStateByPath.get(write.path);
    if (!sealedBefore) continue;
    if (sealedBefore.sha256 === write.sha256 && sealedBefore.byteLength === write.byteLength) continue;
    fail('SEALED_MEMBER_MUTATION_AT_PRESTATE', {
      path: write.path,
      expected: { sha256: sealedBefore.sha256, byteLength: sealedBefore.byteLength },
      actual: { sha256: write.sha256, byteLength: write.byteLength }
    });
  }

  return {
    valid: findings.length === 0,
    findings,
    reports: {
      ledgerEventCount: ledgerReport.events.length,
      baselineLedgerFindingCount: effectiveBaseline.ledgerFindingCount,
      candidateLedgerFindingCount: ledgerReport.findings.length,
      introducedLedgerFindingCount: introducedLedgerFindings.length,
      introducedBlockingLedgerFindingCount: introducedBlockingLedgerFindings.length,
      introducedInformationalLedgerFindingCount: introducedInformationalLedgerFindings.length,
      projectionWriteCount: projectionWrites.length,
      sealValid: sealReport.valid,
      revisionValid: revisionReport?.valid ?? null,
      otherSealsChecked: otherSeals.length,
      preStateSealedMemberCount: preStateByPath.size
    },
    stagingRoot,
    validatedAt: now.toISOString()
  };
}

/**
 * The existing LOCAL_EXPLICIT_AUTHORITY check, consumed rather than reimplemented.
 *
 * Only meaningful for transitions governed by a post-freeze maintenance authority
 * (AGENT_CLOSURE, EXTERNAL_CONFIRMATION). Where no such authority governs the
 * transition the result is NOT_APPLICABLE, which is a statement that this class
 * of authority does not apply — never a pass by absence.
 */
export function evaluateTransitionAuthority({ root, candidate, authorityDocumentPath = null, now = new Date() }) {
  if (!authorityDocumentPath) {
    if (MAINTENANCE_AUTHORITY_TRANSITIONS.has(candidate.transitionType)) {
      return { applicable: true, decision: 'BLOCKED', reason: 'MAINTENANCE_AUTHORITY_REQUIRED', findings: [{ code: 'MAINTENANCE_AUTHORITY_REQUIRED', detail: candidate.transitionType }] };
    }
    return { applicable: false, decision: 'NOT_APPLICABLE', findings: [], reason: 'NO_MAINTENANCE_AUTHORITY_DECLARED' };
  }
  const authority = readJsonOrNull(root, authorityDocumentPath);
  if (!authority) {
    return {
      applicable: true, decision: 'BLOCKED', reason: 'AUTHORITY_ABSENT',
      findings: [{ code: 'AUTHORITY_ABSENT', detail: authorityDocumentPath }]
    };
  }
  const observation = collectPostFreezeMaintenanceObservation({
    root, authority,
    requestedPaths: candidate.writes.map((write) => write.path),
    requestedOperationClasses: [candidate.transitionType],
    candidateWrites: candidate.writes
  });
  const result = evaluatePostFreezeMaintenanceAuthorityV2({
    authority, manifest: observation.manifest, observed: observation.observed, phase: PHASE_AUTHORIZE_PROGRAM_APPLY, now
  });
  return { applicable: true, decision: observation.valid ? result.decision : 'BLOCKED', findings: [...observation.findings, ...result.findings], authorizedPaths: result.authorizedPaths, observed: observation.observed };
}

/* -------------------------------------------------------------------------
 * Apply — the only place canonical bytes move
 * ---------------------------------------------------------------------- */

/**
 * Writes the validated candidate. Reached ONLY after the staged candidate has
 * validated clean, so this function contains no validation, no repair and no
 * fallback: by the time control arrives here the decision has already been made.
 *
 * WHAT `requireRecoverableProvenance` CLOSES. The journal this function writes is
 * the only thing a fresh process has to work from after a hard crash, and
 * `recoverTransaction` refuses a journal whose provenance it cannot re-prove. A
 * publisher that prepared a transaction with provenance the recovery validator
 * would reject was therefore arming a state nothing could resolve: COMMITTING,
 * staged artifact present, provenance unusable. Callers that publish under a
 * durable-recovery contract set this flag, and the check is run WITH THE VERY
 * VALIDATOR RECOVERY USES — not a second model of it — before the transaction is
 * allowed to leave PREPARED. A transaction that cannot be recovered is refused
 * before it can need recovering.
 *
 * `writeFile` defaults to a durable atomic replacement rather than a plain
 * truncate-and-stream, so a process killed mid-publication leaves each canonical
 * path holding either its pre-state bytes or the candidate bytes — the dichotomy
 * the recovery validator has always assumed and that `fs.writeFileSync` never
 * actually provided.
 */
export function applyCandidate({
  root, candidate, authorityDocumentPath = null, authority = null, authorization = null, provenance = null,
  requireRecoverableProvenance = true,
  writeFile = durableReplaceFileSync, rollbackWriteFile = durableReplaceFileSync, rollbackRemoveFile = fs.rmSync
}) {
  const before = candidate.writes.map((write) => {
    const target = repoPath(root, write.path);
    const existed = fs.existsSync(target);
    return { write, target, existed, bytes: existed ? fs.readFileSync(target) : null };
  });
  // WHICH AUTHORITY GOVERNS THIS TRANSITION IS DERIVED, NOT REMEMBERED. Requiring
  // each caller to construct the right provenance is what produced the defect:
  // three publishers simply did not, and passed `provenance: null` into a
  // requirement that was opt-in. The class is resolved here from the transition
  // itself, so a publisher cannot arm an unrecoverable transaction by omission —
  // and a transition whose authority genuinely cannot be resolved gets null, which
  // the invariant below turns into a refusal rather than into a silent proceed.
  const resolvedProvenance = provenance
    ?? createLifecycleTransactionProvenance({ root, candidate, before, authorityDocumentPath, authority })
    ?? createGateLifecycleTransactionProvenance({ root, candidate, before })
    ?? createPrecontractBootstrapTransactionProvenance({ root, candidate, before, authorityDocumentPath, authorization });
  const prepared = prepareLifecycleTransaction({ root, candidate, before, provenance: resolvedProvenance });
  let transaction = prepared.transaction;
  if (requireRecoverableProvenance) {
    const recoverable = validateLifecycleTransactionProvenance({ root, transaction });
    if (!recoverable.valid) {
      // Nothing canonical has moved yet: only the journal and its staged copy
      // exist, and both are discarded here. The refusal is therefore free of
      // consequence, which is exactly why it belongs at this instant.
      setTransactionState(root, candidate, transaction, 'ABORTED');
      discardTerminalTransaction(root, prepared.directory);
      const error = new Error(`CANDIDATE_APPLY_PROVENANCE_UNRECOVERABLE:${recoverable.findings.map((item) => item.detail ? item.code+"("+item.detail+")" : item.code).join(',')}`);
      error.recovered = true;
      error.provenanceFindings = recoverable.findings;
      error.rollbackFailures = [];
      error.verificationFailures = [];
      throw error;
    }
  }
  const written = [];
  try {
    transaction = setTransactionState(root, candidate, transaction, 'COMMITTING');
    for (const entry of before) {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      writeFile(entry.target, entry.write.bytes);
      written.push({ path: entry.write.path, sha256: entry.write.sha256, byteLength: entry.write.byteLength });
    }
    setTransactionState(root, candidate, transaction, 'COMMITTED');
    discardTerminalTransaction(root, prepared.directory);
    return written;
  } catch (cause) {
    // Restore bytes and path presence before returning control.  This is not a
    // second transaction scheme: it is the local rollback required to make the
    // already-validated publication boundary failure-atomic.
    const rollbackFailures = [];
    for (const entry of [...before].reverse()) {
      try {
        if (entry.existed) {
          fs.mkdirSync(path.dirname(entry.target), { recursive: true });
          rollbackWriteFile(entry.target, entry.bytes);
        } else {
          rollbackRemoveFile(entry.target, { force: true });
        }
      } catch (rollbackError) { rollbackFailures.push({ path: entry.write.path, error: rollbackError.message }); }
    }
    // A publication that died between its temp write and its rename leaves that
    // temp behind. It is not canonical and nothing reads it, but unattributable
    // residue is how a repository stops being auditable, so it is swept with the
    // bytes it belonged to.
    sweepPublicationResidue(before.map((entry) => entry.target));
    const revisionDirectory = candidate.paths?.revisionDirectory && repoPath(root, candidate.paths.revisionDirectory);
    if (revisionDirectory && !fs.existsSync(revisionDirectory)) {
      // Nothing to remove; keeping this branch documents the expected normal case.
    } else if (revisionDirectory && !before.some((entry) => entry.target.startsWith(revisionDirectory) && entry.existed)) {
      try { fs.rmSync(revisionDirectory, { recursive: true, force: true }); } catch (rollbackError) { rollbackFailures.push({ path: candidate.paths.revisionDirectory, error: rollbackError.message }); }
    }
    const verificationFailures = before.filter((entry) => {
      const present = fs.existsSync(entry.target);
      if (present !== entry.existed) return true;
      return present && !fs.readFileSync(entry.target).equals(entry.bytes);
    }).map((entry) => entry.write.path);
    const recovered = rollbackFailures.length === 0 && verificationFailures.length === 0;
    setTransactionState(root, candidate, transaction, recovered ? 'ABORTED' : 'RECOVERY_REQUIRED');
    // A transaction that rolled back CLEANLY has nothing left to recover, and
    // leaving its directory behind is not inert: recoverTransaction short-circuits
    // only on COMMITTED, so a surviving ABORTED journal is eligible for
    // ROLL_FORWARD_FROM_STAGED_ARTIFACTS and would re-apply — re-appending its
    // ledger event — the very operation that was just undone. It is discarded for
    // the same reason a committed one is. A transaction that did NOT roll back
    // cleanly is RECOVERY_REQUIRED and is kept, because that is exactly the case
    // where the journal is the only remaining evidence of what was in flight.
    if (recovered) discardTerminalTransaction(root, prepared.directory);
    const error = new Error(`${recovered ? 'CANDIDATE_APPLY_FAILED_ROLLED_BACK' : 'CANDIDATE_APPLY_RECOVERY_REQUIRED'}:${cause.message}`);
    error.cause = cause;
    error.recovered = recovered;
    error.rollbackFailures = rollbackFailures;
    error.verificationFailures = verificationFailures;
    throw error;
  }
}

/**
 * The entry point: derive → stage → validate → apply, or stop before writing.
 *
 * `dryRun` stops after validation. It is the mode a caller uses to find out
 * whether a transition WOULD be admitted, and it is exactly the same code path
 * up to that point — a dry run that took a different route would prove nothing
 * about the real one.
 */
export function runLifecycleTransition({
  root,
  stagingRoot,
  dryRun = false,
  now = new Date(),
  authorityDocumentPath = null,
  baseline = null,
  // DURABLE BY DEFAULT, AT EVERY LAYER. applyCandidate has defaulted to a durable
  // atomic replacement since the R6 repair, but a default is only reached when the
  // caller stays silent — and this function did not: it declared its own
  // fs.writeFileSync defaults and passed them down on every call. The durable
  // primitive was therefore live in exactly one publisher (the anchor) and dead in
  // the entire normal lifecycle, which is the opposite of what the repair claimed.
  // A default that a wrapper silently overrides is not a default; it is a comment.
  writeFile = durableReplaceFileSync,
  rollbackWriteFile = durableReplaceFileSync,
  rollbackRemoveFile = fs.rmSync,
  policy = WHEEL_EXTERNAL_AUTHORITY_POLICY,
  projectionPolicyModulePath = null,
  ...request
}) {
  const startedMs = Date.now();
  const recovery = recoverPendingLifecycleTransactions(root);
  if (recovery.blocked) return { document: ORCHESTRATOR_DOCUMENT, version: ORCHESTRATOR_VERSION, result: 'BLOCKED', gateId: request.gateId, transitionType: request.transitionType, findings: [{ defectClass: recovery.blocked.recoveryAction === 'PENDING_TRANSACTION_PROVENANCE_INVALID' ? 'PENDING_TRANSACTION_PROVENANCE_INVALID' : 'RECOVERY_REQUIRED', actual: recovery.blocked }], applied: [], canonicalBytesUnchanged: false, timings: { deriveMs: 0, validateMs: 0, applyMs: 0, totalMs: Date.now() - startedMs } };
  const derivation = deriveCandidateTransition({ root, policy, ...request });
  const deriveMs = Date.now() - startedMs;

  if (derivation.status === 'ALREADY_SATISFIED') {
    return {
      document: ORCHESTRATOR_DOCUMENT,
      version: ORCHESTRATOR_VERSION,
      result: 'ALREADY_SATISFIED',
      gateId: request.gateId,
      transitionType: request.transitionType,
      satisfiedBy: derivation.satisfiedBy,
      findings: [],
      applied: [],
      timings: { deriveMs, validateMs: 0, applyMs: 0, totalMs: Date.now() - startedMs }
    };
  }
  if (derivation.status === 'BLOCKED') {
    return {
      document: ORCHESTRATOR_DOCUMENT,
      version: ORCHESTRATOR_VERSION,
      result: 'BLOCKED',
      gateId: request.gateId,
      transitionType: request.transitionType,
      findings: derivation.findings,
      applied: [],
      timings: { deriveMs, validateMs: 0, applyMs: 0, totalMs: Date.now() - startedMs }
    };
  }

  const candidate = derivation.candidate;
  const staging = stagingRoot ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gate-lifecycle-'));
  const validateStartedMs = Date.now();
  let validation;
  let authority;
  try {
    validation = validateCandidateInStagingRoot({ root, candidate, stagingRoot: staging, baseline, now, policy, projectionPolicyModulePath });
    authority = evaluateTransitionAuthority({ root, candidate, authorityDocumentPath, now });
  } finally {
    if (!stagingRoot) fs.rmSync(staging, { recursive: true, force: true });
  }
  const validateMs = Date.now() - validateStartedMs;

  const authorityFindings = !dryRun && authority.decision === 'BLOCKED'
    ? authority.findings.map((item) => ({ defectClass: 'TRANSITION_AUTHORITY_BLOCKED', code: item.code, detail: item.detail ?? null }))
    : [];
  const findings = [...validation.findings, ...authorityFindings];

  if (findings.length || dryRun) {
    return {
      document: ORCHESTRATOR_DOCUMENT,
      version: ORCHESTRATOR_VERSION,
      result: findings.length ? 'BLOCKED' : 'CANDIDATE_VALID',
      gateId: candidate.gateId,
      transitionType: candidate.transitionType,
      candidateSummary: summarizeCandidate(candidate),
      authority: { applicable: authority.applicable, decision: authority.decision },
      validationReports: validation.reports,
      findings,
      applied: [],
      canonicalBytesUnchanged: true,
      timings: { deriveMs, validateMs, applyMs: 0, totalMs: Date.now() - startedMs }
    };
  }

  const applyStartedMs = Date.now();
  let applied;
  try {
    applied = applyCandidate({ root, candidate, authorityDocumentPath, authority, writeFile, rollbackWriteFile, rollbackRemoveFile });
  } catch (error) {
    const recoveryRequired = error.recovered === false;
    return {
      document: ORCHESTRATOR_DOCUMENT,
      version: ORCHESTRATOR_VERSION,
      result: 'BLOCKED',
      gateId: candidate.gateId,
      transitionType: candidate.transitionType,
      candidateSummary: summarizeCandidate(candidate),
      authority: { applicable: authority.applicable, decision: authority.decision },
      validationReports: validation.reports,
      findings: [{ defectClass: recoveryRequired ? 'CANDIDATE_APPLY_RECOVERY_REQUIRED' : 'CANDIDATE_APPLY_FAILED_ROLLED_BACK', path: null, actual: error.message, rollbackFailures: error.rollbackFailures ?? [], verificationFailures: error.verificationFailures ?? [] }],
      applied: [],
      canonicalBytesUnchanged: recoveryRequired ? false : true,
      timings: { deriveMs, validateMs, applyMs: Date.now() - applyStartedMs, totalMs: Date.now() - startedMs }
    };
  }
  const applyMs = Date.now() - applyStartedMs;

  return {
    document: ORCHESTRATOR_DOCUMENT,
    version: ORCHESTRATOR_VERSION,
    result: 'APPLIED',
    gateId: candidate.gateId,
    transitionType: candidate.transitionType,
    candidateSummary: summarizeCandidate(candidate),
    authority: { applicable: authority.applicable, decision: authority.decision },
    validationReports: validation.reports,
    findings: [],
    applied,
    canonicalBytesUnchanged: false,
    timings: { deriveMs, validateMs, applyMs, totalMs: Date.now() - startedMs }
  };
}

/** The candidate without its bytes — safe to serialize into a report. */
export function summarizeCandidate(candidate) {
  return {
    gateId: candidate.gateId,
    transitionType: candidate.transitionType,
    eventId: candidate.eventId,
    fromStatus: candidate.fromStatus,
    toStatus: candidate.toStatus,
    stateRevision: candidate.stateRevision,
    previousRevision: candidate.previousRevision,
    ordinal: candidate.ordinal,
    identities: candidate.identities,
    writes: candidate.writes.map((write) => ({ path: write.path, sha256: write.sha256, byteLength: write.byteLength }))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const report = runLifecycleTransition({
    root,
    gateId: option('--gate'),
    transitionType: option('--transition'),
    eventId: option('--event-id'),
    authorityPath: option('--authority'),
    authorityDocumentPath: option('--maintenance-authority'),
    recordedAt: option('--recorded-at', new Date().toISOString()),
    sealCohort: (option('--seal-cohort', '') || '').split(',').filter(Boolean),
    missionId: option('--mission'),
    stagingRoot: option('--staging-root'),
    dryRun: !process.argv.includes('--apply')
  });
  process.stdout.write(`${JSON.stringify(report, (key, value) => (key === 'bytes' ? undefined : value), 2)}\n`);
  process.exitCode = report.result === 'BLOCKED' ? 2 : 0;
}
