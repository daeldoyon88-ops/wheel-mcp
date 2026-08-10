/**
 * GEE V1 R6 recovery engine.
 *
 * The problem this solves is the one that makes long missions expensive: an
 * interruption throws away work that was genuinely finished, so the next
 * session starts from zero. The opposite failure is worse — resuming work that
 * is no longer valid, or writing COMPLETE next to something nobody ran. This
 * file exists to make the first impossible and the second unrepresentable.
 *
 * A checkpoint is EXECUTION PROGRESS, not a note. Every task it calls COMPLETE
 * must name the evidence it produced (by R4 reuse identity) and at least one
 * usage record that says the execution happened. A prose claim of completion
 * has no representation here at all.
 *
 * Reuse after interruption is PROVEN, never assumed. A completed task is
 * resumable only while four things still hold: its routed semantics are
 * unchanged, R3 says every source it read is unchanged, R4 says every evidence
 * it produced and consumed is still REUSABLE, and that evidence still carries
 * the exact reuse identity the checkpoint bound. Any one of them failing sends
 * that task — and only that task — back into revalidation.
 *
 * R5 remains in charge of what may run. BLOCKED, DEFERRED,
 * OWNER_DECISION_REQUIRED and a stopped patch cascade are evaluated before any
 * reuse question is asked, so recovery can never let prior progress smuggle a
 * task past a state the router closed. R6 observes; it never re-routes.
 *
 * Nothing here trusts memory. A checkpoint is a JSON value with a deterministic
 * digest, no WeakSet, no closure state and no process identity, so a fresh
 * process reaches the identical recovery decision from the same bytes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { verifyRoutePlanDigest } from '../router/router-engine.mjs';
import { assertRepoIndex } from '../index/repo-index.mjs';
import { verifyUsageLedger } from '../usage/usage-ledger.mjs';

export const RECOVERY_VERSION = 'GEE_V1_RECOVERY_R6';
export const CHECKPOINT_KIND = 'GEE_RECOVERY_CHECKPOINT';

/* Task states. The vocabulary is exactly as wide as the situations the router
 * can put a task in, plus the two an interruption creates. */
export const PENDING = 'PENDING';
export const IN_PROGRESS = 'IN_PROGRESS';
export const COMPLETE = 'COMPLETE';
/** R5 proved the work is unnecessary. Distinct from COMPLETE: nothing ran. */
export const AVOIDED = 'AVOIDED';
export const REVALIDATION_REQUIRED = 'REVALIDATION_REQUIRED';
export const BLOCKED = 'BLOCKED';
export const DEFERRED = 'DEFERRED';
export const OWNER_DECISION_REQUIRED = 'OWNER_DECISION_REQUIRED';
export const FAILED = 'FAILED';
export const TASK_STATES = Object.freeze([
  PENDING, IN_PROGRESS, COMPLETE, AVOIDED, REVALIDATION_REQUIRED, BLOCKED, DEFERRED, OWNER_DECISION_REQUIRED, FAILED
]);

/* Checkpoint-level states. */
export const CHECKPOINT_IN_PROGRESS = 'IN_PROGRESS';
export const CHECKPOINT_PARTIAL_COMPLETE = 'PARTIAL_COMPLETE';
export const CHECKPOINT_COMPLETE = 'COMPLETE';
export const CHECKPOINT_INTERRUPTED = 'INTERRUPTED';
export const CHECKPOINT_BLOCKED = 'BLOCKED';
export const CHECKPOINT_RECOVERY_REQUIRED = 'RECOVERY_REQUIRED';
export const CHECKPOINT_STATES = Object.freeze([
  CHECKPOINT_IN_PROGRESS, CHECKPOINT_PARTIAL_COMPLETE, CHECKPOINT_COMPLETE,
  CHECKPOINT_INTERRUPTED, CHECKPOINT_BLOCKED, CHECKPOINT_RECOVERY_REQUIRED
]);

/* Recovery decisions. The default is never restart. */
export const START_FRESH = 'START_FRESH';
export const RESUME = 'RESUME';
export const REVALIDATE_SOME = 'REVALIDATE_SOME';
export const RESTART_REQUIRED = 'RESTART_REQUIRED';
export const RECOVERY_BLOCKED = 'BLOCKED';
export const RECOVERY_REQUIRED = 'RECOVERY_REQUIRED';
export const RECOVERY_DECISIONS = Object.freeze([START_FRESH, RESUME, REVALIDATE_SOME, RESTART_REQUIRED, RECOVERY_BLOCKED, RECOVERY_REQUIRED]);

/* Per-task recovery dispositions. */
export const DISPOSITION_REUSED = 'REUSED';
export const DISPOSITION_REVALIDATE = 'REVALIDATE';
export const DISPOSITION_PENDING = 'PENDING';
export const DISPOSITION_NEW = 'NEW';
export const DISPOSITION_AVOIDED = 'AVOIDED';
export const DISPOSITION_BLOCKED = 'BLOCKED';
export const DISPOSITION_DEFERRED = 'DEFERRED';
export const DISPOSITION_OWNER_DECISION = 'OWNER_DECISION_REQUIRED';
export const DISPOSITION_OBSOLETE = 'OBSOLETE';

/**
 * Routed capabilities under which no execution can have happened, so no
 * checkpoint may report COMPLETE for them. NO_WORK_REQUIRED belongs here too:
 * upstream reuse means nothing ran, and AVOIDED is the state that says so
 * honestly.
 */
const COMPLETION_FORBIDDEN_CAPABILITIES = Object.freeze(['BLOCKED', 'OWNER_DECISION_REQUIRED', 'NO_WORK_REQUIRED']);

const HEX64 = /^[a-f0-9]{64}$/;

function compareIdentifiers(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function sortedUnique(values) { return [...new Set(values)].sort(compareIdentifiers); }

function canonicalIdentifier(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field}_REQUIRED`);
  if (value !== value.normalize('NFC')) throw new Error(`NON_CANONICAL_${field}:${value}`);
  return value;
}

function requireHex(value, field) {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new Error(`${field}_REQUIRED`);
  return value;
}

/** Zero-padded revision label. A sequence ordinal, deliberately not a clock. */
export function checkpointRevisionLabel(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error(`INVALID_CHECKPOINT_REVISION_ORDINAL:${String(ordinal)}`);
  return `R${String(ordinal).padStart(4, '0')}`;
}

/**
 * WHAT A TASK IS, as opposed to how this particular route decided to run it.
 *
 * Capability, cost class and reason codes are routing OUTPUTS: they move when
 * upstream state moves, without the task itself changing. Binding them here
 * would make every route change look like a semantic change and throw away
 * valid work — the exact failure R6 exists to prevent. What is bound is the
 * task's contract with the world: what it reads, what it needs, what it
 * produces, and whether it is mandatory.
 */
export function taskSemanticSha256(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('ROUTE_TASK_REQUIRED');
  return sha256Canonical({
    taskId: canonicalIdentifier(task.taskId, 'TASK_ID'),
    intent: task.intent,
    mandatory: task.mandatory === true,
    sources: sortedUnique(task.sources || []),
    requiredEvidenceIds: sortedUnique(task.requiredEvidenceIds || []),
    produces: sortedUnique(task.produces || [])
  });
}

/* -------------------------------------------------------------------------
 * Checkpoint construction
 * ---------------------------------------------------------------------- */

function normalizeEvidence(entries, taskId) {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new Error(`INVALID_CHECKPOINT_TASK_EVIDENCE:${taskId}`);
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`INVALID_CHECKPOINT_TASK_EVIDENCE:${taskId}`);
    return {
      evidenceId: canonicalIdentifier(entry.evidenceId, 'EVIDENCE_ID'),
      reuseIdentity: requireHex(entry.reuseIdentity, 'EVIDENCE_REUSE_IDENTITY')
    };
  }).sort((a, b) => compareIdentifiers(a.evidenceId, b.evidenceId));
  const seen = new Set();
  for (const entry of normalized) {
    if (seen.has(entry.evidenceId)) throw new Error(`DUPLICATE_CHECKPOINT_EVIDENCE_ID:${taskId}:${entry.evidenceId}`);
    seen.add(entry.evidenceId);
  }
  return normalized;
}

function normalizeCheckpointTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CHECKPOINT_TASK_REQUIRED');
  const taskId = canonicalIdentifier(input.taskId, 'TASK_ID');
  if (!TASK_STATES.includes(input.state)) throw new Error(`INVALID_CHECKPOINT_TASK_STATE:${taskId}:${String(input.state)}`);
  const task = {
    taskId,
    state: input.state,
    capability: canonicalIdentifier(input.capability, 'CAPABILITY'),
    taskSemanticSha256: requireHex(input.taskSemanticSha256, 'TASK_SEMANTIC_IDENTITY'),
    sources: sortedUnique((input.sources || []).map((entry) => canonicalIdentifier(entry, 'TASK_SOURCE'))),
    requiredEvidenceIds: sortedUnique((input.requiredEvidenceIds || []).map((entry) => canonicalIdentifier(entry, 'REQUIRED_EVIDENCE_ID'))),
    produces: sortedUnique((input.produces || []).map((entry) => canonicalIdentifier(entry, 'PRODUCED_EVIDENCE_ID'))),
    evidence: normalizeEvidence(input.evidence, taskId),
    usageRecordIds: sortedUnique((input.usageRecordIds || []).map((entry) => canonicalIdentifier(entry, 'USAGE_RECORD_ID'))),
    reasonCodes: sortedUnique((input.reasonCodes || []).map((entry) => canonicalIdentifier(entry, 'TASK_REASON_CODE')))
  };
  // The completion floor. A COMPLETE task must be able to point at the evidence
  // it produced and at an execution record that says it ran; without both, the
  // claim is a prose summary wearing a state name.
  if (task.state === COMPLETE) {
    // A task the router closed cannot have been executed, so calling it
    // complete is a contradiction rather than progress. Without this, marking a
    // blocked task complete would be the one way prior "progress" could carry
    // work past a state R5 shut, which is exactly what recovery must not do.
    if (COMPLETION_FORBIDDEN_CAPABILITIES.includes(task.capability)) {
      throw new Error(`CHECKPOINT_COMPLETION_CONTRADICTS_ROUTED_CAPABILITY:${taskId}:${task.capability}`);
    }
    const produced = new Set(task.evidence.map((entry) => entry.evidenceId));
    const missing = task.produces.filter((evidenceId) => !produced.has(evidenceId));
    if (missing.length) throw new Error(`CHECKPOINT_COMPLETION_WITHOUT_EVIDENCE:${taskId}:${missing.join(',')}`);
    if (!task.usageRecordIds.length) throw new Error(`CHECKPOINT_COMPLETION_WITHOUT_USAGE_RECORD:${taskId}`);
  }
  return task;
}

function checkpointBody(checkpoint) {
  return {
    schemaVersion: checkpoint.schemaVersion,
    checkpointKind: checkpoint.checkpointKind,
    engine: checkpoint.engine,
    workUnitId: checkpoint.workUnitId,
    revision: checkpoint.revision,
    revisionOrdinal: checkpoint.revisionOrdinal,
    previousCheckpointSha256: checkpoint.previousCheckpointSha256,
    authority: checkpoint.authority,
    baseline: checkpoint.baseline,
    inputs: checkpoint.inputs,
    tasks: checkpoint.tasks,
    recoveryState: checkpoint.recoveryState
  };
}

export function checkpointSha256(checkpoint) { return sha256Canonical(checkpointBody(checkpoint)); }

/**
 * Builds one immutable checkpoint revision.
 *
 * `previousCheckpoint` is what makes history a chain rather than a mutable
 * document: the ordinal advances and the previous digest is bound, so an
 * earlier revision cannot be edited without every later one failing to verify.
 */
export function createCheckpoint({
  workUnitId, authority, baseline, inputs, tasks, recoveryState, previousCheckpoint = null
} = {}) {
  const unit = canonicalIdentifier(workUnitId, 'WORK_UNIT_ID');
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) throw new Error('CHECKPOINT_AUTHORITY_REQUIRED');
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('CHECKPOINT_BASELINE_REQUIRED');
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('CHECKPOINT_INPUTS_REQUIRED');
  if (!CHECKPOINT_STATES.includes(recoveryState)) throw new Error(`INVALID_CHECKPOINT_STATE:${String(recoveryState)}`);
  if (previousCheckpoint !== null) assertCheckpoint(previousCheckpoint, 'PREVIOUS_CHECKPOINT');
  if (previousCheckpoint !== null && previousCheckpoint.workUnitId !== unit) throw new Error(`CHECKPOINT_WORK_UNIT_MISMATCH:${unit}`);

  const normalizedTasks = (Array.isArray(tasks) ? tasks : []).map(normalizeCheckpointTask).sort((a, b) => compareIdentifiers(a.taskId, b.taskId));
  const seen = new Set();
  for (const task of normalizedTasks) {
    if (seen.has(task.taskId)) throw new Error(`DUPLICATE_CHECKPOINT_TASK_ID:${task.taskId}`);
    seen.add(task.taskId);
  }
  // COMPLETE is a statement about the whole work unit, so one open task refutes
  // it. Without this a checkpoint could report the unit finished while still
  // listing pending work, which is precisely the fabricated-completion shape.
  if (recoveryState === CHECKPOINT_COMPLETE && normalizedTasks.some((task) => task.state !== COMPLETE && task.state !== AVOIDED)) {
    throw new Error('CHECKPOINT_COMPLETE_WITH_OPEN_TASKS');
  }

  const ordinal = previousCheckpoint === null ? 1 : previousCheckpoint.revisionOrdinal + 1;
  const body = {
    schemaVersion: 1,
    checkpointKind: CHECKPOINT_KIND,
    engine: RECOVERY_VERSION,
    workUnitId: unit,
    revision: checkpointRevisionLabel(ordinal),
    revisionOrdinal: ordinal,
    previousCheckpointSha256: previousCheckpoint === null ? null : previousCheckpoint.checkpointSha256,
    authority: {
      missionRevisionId: canonicalIdentifier(authority.missionRevisionId, 'MISSION_REVISION_ID'),
      contractSha256: requireHex(authority.contractSha256, 'AUTHORITY_CONTRACT_IDENTITY')
    },
    baseline: {
      // The HEAD the work started from is recorded so a later session can see
      // that it moved. It is never a resume precondition on its own: R3 and R4
      // decide what actually became invalid.
      head: baseline.head === null || baseline.head === undefined ? null : canonicalIdentifier(baseline.head, 'BASELINE_HEAD'),
      headSource: canonicalIdentifier(baseline.headSource || 'UNAVAILABLE', 'BASELINE_HEAD_SOURCE')
    },
    inputs: {
      r2ContextSha256: requireHex(inputs.r2ContextSha256, 'R2_CONTEXT_IDENTITY'),
      r3DeltaSha256: requireHex(inputs.r3DeltaSha256, 'R3_DELTA_IDENTITY'),
      r4GraphSha256: requireHex(inputs.r4GraphSha256, 'R4_GRAPH_IDENTITY'),
      routeSha256: requireHex(inputs.routeSha256, 'R5_ROUTE_IDENTITY'),
      repoIndexSha256: requireHex(inputs.repoIndexSha256, 'R6_REPO_INDEX_IDENTITY')
    },
    tasks: normalizedTasks,
    recoveryState
  };
  return { ...body, checkpointSha256: sha256Canonical(body) };
}

/* -------------------------------------------------------------------------
 * Checkpoint validation of a MATERIALIZED document
 * ---------------------------------------------------------------------- */

const CHECKPOINT_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'recovery-checkpoint.schema.json'), 'utf8')
);

function checkpointIdentityErrors(checkpoint) {
  const errors = [];
  const push = (jsonPointer, reason, message) => errors.push({ jsonPointer, reason, message });
  const isCanonical = (value) => typeof value === 'string' && value === value.normalize('NFC');

  if (!isCanonical(checkpoint.workUnitId)) push('/workUnitId', 'NON_CANONICAL_WORK_UNIT_ID', 'work unit id must already be NFC');
  if (checkpoint.revision !== checkpointRevisionLabel(checkpoint.revisionOrdinal)) {
    push('/revision', 'CHECKPOINT_REVISION_LABEL_MISMATCH', 'revision label does not match its ordinal');
  }
  if (checkpoint.revisionOrdinal === 1 && checkpoint.previousCheckpointSha256 !== null) {
    push('/previousCheckpointSha256', 'CHECKPOINT_CHAIN_BROKEN', 'the first revision has no predecessor');
  }
  if (checkpoint.revisionOrdinal > 1 && !HEX64.test(String(checkpoint.previousCheckpointSha256))) {
    push('/previousCheckpointSha256', 'CHECKPOINT_CHAIN_BROKEN', 'a later revision must bind its predecessor');
  }

  const taskIds = new Set();
  checkpoint.tasks.forEach((task, position) => {
    const pointer = `/tasks/${position}`;
    if (!isCanonical(task.taskId)) { push(`${pointer}/taskId`, 'NON_CANONICAL_TASK_ID', 'task id must already be NFC'); return; }
    if (taskIds.has(task.taskId)) push(`${pointer}/taskId`, 'DUPLICATE_CHECKPOINT_TASK_ID', 'two tasks share one canonical identity');
    taskIds.add(task.taskId);
    if (position > 0 && compareIdentifiers(checkpoint.tasks[position - 1].taskId, task.taskId) >= 0) {
      push(pointer, 'CHECKPOINT_TASK_ORDER_NOT_CANONICAL', 'tasks must be sorted by canonical task id');
    }
    // Re-derives the completion floor on the way IN, so a hand-written
    // checkpoint cannot claim what the builder would have refused.
    if (task.state === COMPLETE) {
      if (COMPLETION_FORBIDDEN_CAPABILITIES.includes(task.capability)) {
        push(`${pointer}/state`, 'CHECKPOINT_COMPLETION_CONTRADICTS_ROUTED_CAPABILITY', 'a task the router closed cannot have been executed');
      }
      const produced = new Set(task.evidence.map((entry) => entry.evidenceId));
      if (task.produces.some((evidenceId) => !produced.has(evidenceId))) {
        push(`${pointer}/evidence`, 'CHECKPOINT_COMPLETION_WITHOUT_EVIDENCE', 'a completed task must name the evidence it produced');
      }
      if (!task.usageRecordIds.length) {
        push(`${pointer}/usageRecordIds`, 'CHECKPOINT_COMPLETION_WITHOUT_USAGE_RECORD', 'a completed task must name an execution record');
      }
    }
    task.evidence.forEach((entry, entryPosition) => {
      if (!isCanonical(entry.evidenceId)) push(`${pointer}/evidence/${entryPosition}/evidenceId`, 'NON_CANONICAL_EVIDENCE_ID', 'evidence id must already be NFC');
    });
    task.usageRecordIds.forEach((usageRecordId, entryPosition) => {
      if (!isCanonical(usageRecordId)) push(`${pointer}/usageRecordIds/${entryPosition}`, 'NON_CANONICAL_USAGE_RECORD_ID', 'usage record id must already be NFC');
    });
  });

  if (checkpoint.recoveryState === CHECKPOINT_COMPLETE && checkpoint.tasks.some((task) => task.state !== COMPLETE && task.state !== AVOIDED)) {
    push('/recoveryState', 'CHECKPOINT_COMPLETE_WITH_OPEN_TASKS', 'a complete checkpoint cannot list open work');
  }
  if (checkpoint.checkpointSha256 !== sha256Canonical(checkpointBody(checkpoint))) {
    push('/checkpointSha256', 'INVALID_CHECKPOINT_DIGEST', 'digest does not match the checkpoint body');
  }
  return errors;
}

export function validateCheckpoint(checkpoint) {
  const structural = validateAgainstJsonSchema(checkpoint, CHECKPOINT_SCHEMA);
  if (!structural.valid) return structural;
  const errors = checkpointIdentityErrors(checkpoint);
  return { valid: errors.length === 0, errors };
}

export function assertCheckpoint(checkpoint, label = 'CHECKPOINT') {
  const result = validateCheckpoint(checkpoint);
  if (!result.valid) throw new Error(`INVALID_${label}:${result.errors[0].reason}:${result.errors[0].jsonPointer}`);
  return checkpoint;
}

/* -------------------------------------------------------------------------
 * Building the task list from a verified R5 plan
 * ---------------------------------------------------------------------- */

/**
 * The initial checkpoint task list for a plan nothing has executed yet. Every
 * R5 state is carried across verbatim, so a blocked, deferred or owner-decision
 * task enters recovery already wearing the state the router gave it.
 */
export function checkpointTasksFromRoutePlan(plan) {
  verifyRoutePlanDigest(plan);
  return plan.tasks.map((task) => ({
    taskId: task.taskId,
    state: initialStateFor(task),
    capability: task.capability,
    taskSemanticSha256: taskSemanticSha256(task),
    sources: task.sources,
    requiredEvidenceIds: task.requiredEvidenceIds,
    produces: task.produces,
    evidence: [],
    usageRecordIds: [],
    reasonCodes: task.reasonCodes
  }));
}

function initialStateFor(task) {
  if (task.capability === 'BLOCKED') return BLOCKED;
  if (task.deferred) return DEFERRED;
  if (task.capability === 'OWNER_DECISION_REQUIRED') return OWNER_DECISION_REQUIRED;
  if (task.capability === 'NO_WORK_REQUIRED') return AVOIDED;
  return PENDING;
}

/** Deterministic checkpoint state for a task list. */
export function recoveryStateFor(tasks, { interrupted = false } = {}) {
  const settled = (task) => task.state === COMPLETE || task.state === AVOIDED;
  if (tasks.length && tasks.every(settled)) return CHECKPOINT_COMPLETE;
  if (tasks.some((task) => task.state === BLOCKED)) return CHECKPOINT_BLOCKED;
  if (interrupted) return CHECKPOINT_INTERRUPTED;
  if (tasks.some((task) => task.state === COMPLETE)) return CHECKPOINT_PARTIAL_COMPLETE;
  return CHECKPOINT_IN_PROGRESS;
}

/* -------------------------------------------------------------------------
 * Recovery
 * ---------------------------------------------------------------------- */

function evidenceIndex(evidenceStates) {
  if (!Array.isArray(evidenceStates)) throw new Error('R4_EVIDENCE_STATES_REQUIRED');
  return new Map(evidenceStates.map((node) => [node.evidenceId, node]));
}

function deltaIndex(r3Delta) {
  if (!r3Delta || !Array.isArray(r3Delta.deltas)) throw new Error('R3_DELTA_REQUIRED');
  return new Map(r3Delta.deltas.map((delta) => [delta.path, delta]));
}

/**
 * Why this completed task may NOT be resumed, or an empty list if it may.
 *
 * Order is irrelevant — every obstacle is reported — because a resume report
 * that names only the first reason makes the second one look like it was never
 * checked.
 */
function reuseObstacles(prior, routed, evidenceById, deltasByPath) {
  const obstacles = [];
  if (prior.taskSemanticSha256 !== taskSemanticSha256(routed)) obstacles.push('TASK_SEMANTICS_CHANGED');

  for (const sourcePath of routed.sources) {
    const delta = deltasByPath.get(sourcePath);
    // No delta means R3 cannot prove this source held still. Absence of a
    // delta is not evidence of absence of change.
    if (!delta) { obstacles.push(`SOURCE_UNTRACKED_BY_R3:${sourcePath}`); continue; }
    if (delta.kind !== 'UNCHANGED') obstacles.push(`SOURCE_${delta.kind}:${sourcePath}`);
  }

  const recordedIdentity = new Map(prior.evidence.map((entry) => [entry.evidenceId, entry.reuseIdentity]));
  for (const evidenceId of sortedUnique([...routed.produces, ...routed.requiredEvidenceIds])) {
    const node = evidenceById.get(evidenceId);
    if (!node) { obstacles.push(`EVIDENCE_MISSING:${evidenceId}`); continue; }
    if (node.tombstone) { obstacles.push(`EVIDENCE_REMOVED:${evidenceId}`); continue; }
    if (node.state !== 'REUSABLE') { obstacles.push(`EVIDENCE_INVALIDATED:${evidenceId}`); continue; }
    const bound = recordedIdentity.get(evidenceId);
    // Every trust-relevant evidence input must be bound. A consumed input that
    // was omitted from the checkpoint is not proof that the task ran against
    // the current evidence identity.
    if (bound !== undefined && bound !== node.reuseIdentity) obstacles.push(`EVIDENCE_IDENTITY_CHANGED:${evidenceId}`);
    if (bound === undefined) {
      obstacles.push(`${routed.produces.includes(evidenceId) ? 'PRODUCED' : 'REQUIRED'}_EVIDENCE_UNBOUND:${evidenceId}`);
    }
  }
  return obstacles.sort(compareIdentifiers);
}

function bytesOf(node) { return node && Number.isInteger(node.bytes) ? node.bytes : 0; }

/**
 * Decide how to continue one work unit.
 *
 * @param {object} options
 * @param {string} options.workUnitId
 * @param {object|null} options.checkpoint      latest VALID checkpoint, or null
 * @param {object} options.routePlan            current verified R5 plan
 * @param {Array}  options.evidenceStates       current R4 evaluated nodes
 * @param {object} options.r3Delta              current verified R3 delta
 * @param {object} options.usageLedger          current usage ledger
 * @param {object} [options.repoIndex]          current R6 repository index
 * @param {object} options.authority            { missionRevisionId, contractSha256 }
 * @param {string} [options.currentHead]
 * @param {string[]} [options.corruptRevisions] corrupt revisions the store found
 * @param {{allowOlderValidCheckpoint?: boolean}} [options.policy]
 */
export function planRecovery({
  workUnitId, checkpoint = null, routePlan, evidenceStates, r3Delta, usageLedger,
  repoIndex = null, authority, currentHead = null, corruptRevisions = [], policy = {}
} = {}) {
  const unit = canonicalIdentifier(workUnitId, 'WORK_UNIT_ID');
  const blockers = [];

  verifyRoutePlanDigest(routePlan);
  if (routePlan.workUnitId !== unit) blockers.push(`ROUTE_PLAN_WORK_UNIT_MISMATCH:${routePlan.workUnitId}`);
  verifyUsageLedger(usageLedger);
  if (repoIndex !== null) assertRepoIndex(repoIndex);
  if (!authority || typeof authority !== 'object') throw new Error('CHECKPOINT_AUTHORITY_REQUIRED');
  const expectedAuthority = {
    missionRevisionId: canonicalIdentifier(authority.missionRevisionId, 'MISSION_REVISION_ID'),
    contractSha256: requireHex(authority.contractSha256, 'AUTHORITY_CONTRACT_IDENTITY')
  };

  const evidenceById = evidenceIndex(evidenceStates);
  const deltasByPath = deltaIndex(r3Delta);
  const ledgerForUnit = usageLedger.records.filter((record) => record.workUnitId === unit);

  if (checkpoint !== null) {
    assertCheckpoint(checkpoint);
    if (checkpoint.workUnitId !== unit) blockers.push(`CHECKPOINT_WORK_UNIT_MISMATCH:${checkpoint.workUnitId}`);
    if (checkpoint.authority.missionRevisionId !== expectedAuthority.missionRevisionId
      || checkpoint.authority.contractSha256 !== expectedAuthority.contractSha256) {
      blockers.push(`CHECKPOINT_AUTHORITY_MISMATCH:${checkpoint.authority.missionRevisionId}`);
    }
  }

  // A checkpoint that names an execution record the ledger does not hold is a
  // half-written commit in the other direction: the claim of completion
  // survived while its proof did not.
  const ledgerIds = new Set(usageLedger.records.map((record) => record.usageRecordId));
  const usageById = new Map(usageLedger.records.map((record) => [record.usageRecordId, record]));
  const referencedIds = new Set((checkpoint?.tasks || []).flatMap((task) => task.usageRecordIds));
  const missingUsageRecordIds = [...referencedIds].filter((id) => !ledgerIds.has(id)).sort(compareIdentifiers);
  if (missingUsageRecordIds.length) blockers.push(`CHECKPOINT_USAGE_RECORD_MISSING:${missingUsageRecordIds.join(',')}`);

  const invalidCompletionProofs = (checkpoint?.tasks || [])
    .filter((task) => task.state === COMPLETE)
    .filter((task) => !task.usageRecordIds.some((usageRecordId) => {
      const record = usageById.get(usageRecordId);
      return record
        && record.workUnitId === checkpoint.workUnitId
        && record.taskId === task.taskId
        && record.outcome === 'COMPLETED'
        && record.routeSha256 === checkpoint.inputs.routeSha256;
    }))
    .map((task) => task.taskId)
    .sort(compareIdentifiers);
  if (invalidCompletionProofs.length) {
    blockers.push(`CHECKPOINT_USAGE_RECORD_SEMANTICS_INVALID:${invalidCompletionProofs.join(',')}`);
  }

  // The opposite half-written commit: execution produced a record, then the
  // process died before the checkpoint that would reference it. The record is
  // real history and is kept; it simply does not prove any task complete.
  const unreferencedUsageRecordIds = ledgerForUnit
    .filter((record) => !referencedIds.has(record.usageRecordId))
    .map((record) => record.usageRecordId)
    .sort(compareIdentifiers);

  const corrupt = [...corruptRevisions].sort(compareIdentifiers);
  const allowOlder = policy.allowOlderValidCheckpoint === true;

  const priorByTaskId = new Map((checkpoint?.tasks || []).map((task) => [task.taskId, task]));
  const planTaskIds = new Set(routePlan.tasks.map((task) => task.taskId));
  const stopPatchCascade = routePlan.repairContainment?.stopPatchCascade === true;

  const tasks = routePlan.tasks.map((routed) => {
    const prior = priorByTaskId.get(routed.taskId) || null;
    const previousState = prior ? prior.state : null;
    const base = {
      taskId: routed.taskId,
      previousState,
      capability: routed.capability,
      taskSemanticSha256: taskSemanticSha256(routed),
      sources: routed.sources,
      requiredEvidenceIds: routed.requiredEvidenceIds,
      produces: routed.produces,
      evidence: prior ? prior.evidence : [],
      usageRecordIds: prior ? prior.usageRecordIds : []
    };

    // R5 states are settled before any reuse question is asked. Prior progress
    // must never be able to carry a task past a state the router closed.
    if (routed.capability === 'BLOCKED') {
      return { ...base, state: BLOCKED, disposition: DISPOSITION_BLOCKED, evidence: [], usageRecordIds: prior ? prior.usageRecordIds : [], reasonCodes: sortedUnique(['R5_BLOCKED_STATE_PRESERVED', ...routed.blockedBy, ...(routed.containmentState === 'STOP_PATCH_CASCADE' ? ['R5_REPAIR_CONTAINMENT_STOP_PRESERVED'] : [])]) };
    }
    if (routed.deferred) {
      return { ...base, state: DEFERRED, disposition: DISPOSITION_DEFERRED, reasonCodes: sortedUnique(['R5_DEFERRED_STATE_PRESERVED', ...routed.reasonCodes]) };
    }
    if (routed.capability === 'OWNER_DECISION_REQUIRED') {
      return { ...base, state: OWNER_DECISION_REQUIRED, disposition: DISPOSITION_OWNER_DECISION, reasonCodes: sortedUnique(['R5_OWNER_DECISION_PRESERVED', ...routed.reasonCodes]) };
    }
    if (routed.capability === 'NO_WORK_REQUIRED') {
      return { ...base, state: AVOIDED, disposition: DISPOSITION_AVOIDED, reasonCodes: sortedUnique(['R5_UPSTREAM_REUSE_NO_WORK_REQUIRED', ...routed.reasonCodes]) };
    }

    if (!prior) return { ...base, state: PENDING, disposition: DISPOSITION_NEW, reasonCodes: ['TASK_NOT_IN_CHECKPOINT'] };
    if (prior.state !== COMPLETE) {
      return { ...base, state: PENDING, disposition: DISPOSITION_PENDING, reasonCodes: [`CHECKPOINT_TASK_NOT_COMPLETE:${prior.state}`] };
    }

    const obstacles = reuseObstacles(prior, routed, evidenceById, deltasByPath);
    if (obstacles.length) {
      // Only the invalidated task loses its completion. Its evidence binding is
      // dropped with it, so nothing stale can be re-presented as proof later.
      return { ...base, state: REVALIDATION_REQUIRED, disposition: DISPOSITION_REVALIDATE, evidence: [], usageRecordIds: [], reasonCodes: obstacles };
    }
    return { ...base, state: COMPLETE, disposition: DISPOSITION_REUSED, reasonCodes: ['COMPLETION_STILL_PROVEN'] };
  }).sort((a, b) => compareIdentifiers(a.taskId, b.taskId));

  const idsWhere = (predicate) => tasks.filter(predicate).map((task) => task.taskId);
  const obsoleteTaskIds = (checkpoint?.tasks || []).filter((task) => !planTaskIds.has(task.taskId)).map((task) => task.taskId).sort(compareIdentifiers);

  const priorCompleted = (checkpoint?.tasks || []).filter((task) => task.state === COMPLETE);
  const reusedTaskIds = idsWhere((task) => task.disposition === DISPOSITION_REUSED);
  const revalidatedTaskIds = idsWhere((task) => task.disposition === DISPOSITION_REVALIDATE);

  const reasonCodes = [];
  let decision;
  if (blockers.length) {
    decision = RECOVERY_BLOCKED;
    reasonCodes.push(...blockers);
  } else if (checkpoint === null && corrupt.length && !allowOlder) {
    decision = RECOVERY_REQUIRED;
    reasonCodes.push(`CORRUPT_NEWEST_CHECKPOINT_REVISION:${corrupt.join(',')}`, 'NO_VALID_CHECKPOINT_AUTHORIZED_FOR_RESUME');
  } else if (checkpoint === null) {
    decision = START_FRESH;
    reasonCodes.push('NO_CHECKPOINT_FOUND', 'NO_COMPLETION_ASSUMED');
  } else if (priorCompleted.length === 0) {
    decision = RESUME;
    reasonCodes.push('CHECKPOINT_HAS_NO_COMPLETED_WORK_TO_REUSE');
  } else if (reusedTaskIds.length === 0) {
    // Every completed task lost its basis. This is the only path to a restart,
    // and it is reached by proof rather than by the route digest moving.
    decision = RESTART_REQUIRED;
    reasonCodes.push('NO_COMPLETED_TASK_REMAINS_VALID');
  } else if (reusedTaskIds.length < priorCompleted.length) {
    decision = REVALIDATE_SOME;
    reasonCodes.push('SOME_COMPLETED_TASKS_REMAIN_VALID');
  } else {
    decision = RESUME;
    reasonCodes.push('ALL_COMPLETED_TASKS_REMAIN_VALID');
  }

  if (corrupt.length && checkpoint !== null && allowOlder) reasonCodes.push(`RESUMED_FROM_OLDER_VALID_CHECKPOINT:${corrupt.join(',')}`);
  if (unreferencedUsageRecordIds.length) reasonCodes.push('UNREFERENCED_EXECUTION_ARTIFACT_DETECTED');
  if (stopPatchCascade) reasonCodes.push('R5_REPAIR_CONTAINMENT_STOP_PRESERVED');

  const routeChanged = checkpoint !== null && checkpoint.inputs.routeSha256 !== routePlan.routeSha256;
  const headChanged = checkpoint !== null && currentHead !== null && checkpoint.baseline.head !== null && checkpoint.baseline.head !== currentHead;
  if (routeChanged) reasonCodes.push('ROUTE_IDENTITY_CHANGED_PROGRESS_EVALUATED_PER_TASK');
  if (headChanged) reasonCodes.push('BASELINE_HEAD_CHANGED_PROGRESS_EVALUATED_PER_TASK');

  const reusedEvidenceBytes = tasks
    .filter((task) => task.disposition === DISPOSITION_REUSED)
    .flatMap((task) => task.produces)
    .reduce((sum, evidenceId) => sum + bytesOf(evidenceById.get(evidenceId)), 0);

  return {
    recoveryKind: 'GEE_RECOVERY_PLAN',
    engine: RECOVERY_VERSION,
    workUnitId: unit,
    decision,
    reasonCodes: sortedUnique(reasonCodes),
    checkpointRevision: checkpoint === null ? null : checkpoint.revision,
    checkpointSha256: checkpoint === null ? null : checkpoint.checkpointSha256,
    routeSha256: routePlan.routeSha256,
    routeChanged,
    headChanged,
    corruptCheckpointRevisions: corrupt,
    stopPatchCascade,
    tasks,
    resumedTaskIds: reusedTaskIds,
    revalidatedTaskIds,
    pendingTaskIds: idsWhere((task) => task.state === PENDING),
    blockedTaskIds: idsWhere((task) => task.state === BLOCKED),
    deferredTaskIds: idsWhere((task) => task.state === DEFERRED),
    ownerDecisionTaskIds: idsWhere((task) => task.state === OWNER_DECISION_REQUIRED),
    avoidedTaskIds: idsWhere((task) => task.state === AVOIDED),
    obsoleteTaskIds,
    missingUsageRecordIds,
    unreferencedUsageRecordIds,
    metrics: {
      PLANNED_TASKS: tasks.length,
      COMPLETED_BEFORE_RECOVERY: priorCompleted.length,
      TASKS_REUSED: reusedTaskIds.length,
      TASKS_REVALIDATED: revalidatedTaskIds.length,
      TASKS_REMAINING: idsWhere((task) => task.state === PENDING || task.state === REVALIDATION_REQUIRED).length,
      TASKS_AVOIDED_BY_UPSTREAM_REUSE: idsWhere((task) => task.state === AVOIDED).length,
      REUSED_EVIDENCE_BYTES: reusedEvidenceBytes,
      R3_AVOIDED_REPROCESS_BYTES: r3Delta.metrics?.AVOIDED_REPROCESS_BYTES ?? 0,
      R5_TASK_AVOIDED_BYTES: routePlan.metrics.R5_TASK_AVOIDED_BYTES,
      USAGE_RECORDS_PRESERVED: ledgerForUnit.length,
      UNREFERENCED_USAGE_RECORDS: unreferencedUsageRecordIds.length,
      RESTARTED_FROM_ZERO: decision === RESTART_REQUIRED || decision === START_FRESH
    }
  };
}

/**
 * The task list for the NEXT checkpoint revision after a recovery decision,
 * carrying every reused completion forward untouched and returning everything
 * else to work. Nothing is upgraded here: a task the recovery did not prove
 * complete cannot become complete by passing through this function.
 */
export function checkpointTasksFromRecovery(recoveryPlan) {
  return recoveryPlan.tasks.map((task) => ({
    taskId: task.taskId,
    state: task.state === REVALIDATION_REQUIRED ? PENDING : task.state,
    capability: task.capability,
    taskSemanticSha256: task.taskSemanticSha256,
    sources: task.sources,
    requiredEvidenceIds: task.requiredEvidenceIds,
    produces: task.produces,
    evidence: task.state === COMPLETE ? task.evidence : [],
    usageRecordIds: task.state === COMPLETE ? task.usageRecordIds : [],
    reasonCodes: task.reasonCodes
  }));
}

export { checkpointBody, compareIdentifiers };
