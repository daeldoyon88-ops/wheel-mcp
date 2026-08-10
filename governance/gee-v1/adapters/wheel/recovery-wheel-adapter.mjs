/**
 * Wheel adapter for R6 recovery, indexing and usage.
 *
 * Everything Wheel-shaped lives here so the R6 core never learns what a gate, a
 * mission revision or a Wheel canonical source is. The adapter's whole job is
 * to assemble one Wheel work unit into the five generic inputs R6 understands —
 * repository index, verified R5 plan, evaluated R4 nodes, verified R3 delta and
 * usage ledger — and then get out of the way. No recovery decision, completion
 * rule or dedup rule is made in this file.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. IT NEVER INVENTS A MEASUREMENT. Every byte figure it puts into a usage
 *    record is copied from something R2, R3, R4 or R5 already measured, and
 *    tokens default to TOKEN_COUNT_UNAVAILABLE because this runtime supplies
 *    none. Nothing here turns bytes into a plausible-looking token count.
 *
 * 2. IT NEVER DECIDES AN ATTEMPT IS NEW. A first execution is attempt 1, which
 *    makes replaying it idempotent by default. A genuine retry has to ask for
 *    the next ordinal explicitly, because "is this the same execution or a new
 *    one?" is a question only the caller can answer honestly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { evaluateWheelEvidenceGraph } from './evidence-wheel-adapter.mjs';
import { routeWheelWorkUnit } from './router-wheel-adapter.mjs';
import { buildRepoIndex, updateRepoIndex } from '../../index/repo-index.mjs';
import {
  checkpointTasksFromRoutePlan, createCheckpoint, planRecovery, recoveryStateFor,
  COMPLETE, PENDING
} from '../../recovery/recovery-engine.mjs';
import { appendUsageRecord, createUsageLedger, nextAttemptOrdinal, COMPLETED } from '../../usage/usage-ledger.mjs';
import { MISSIONS_DIR } from '../gee-mission-authority-source.mjs';

export const WHEEL_RECOVERY_ADAPTER_VERSION = 'GEE_V1_RECOVERY_WHEEL_ADAPTER_R6';

const CONTRACT_FILE_RE = /^GEE_V1_EXECUTION_CONTRACT_R\d{4}\.json$/;

/**
 * The authority a checkpoint binds: which mission revision authorized this work
 * and the exact bytes of its contract. Recomputed from the contract itself, so
 * a checkpoint written under one authority cannot be resumed under another.
 */
export function wheelAuthorityIdentity(repoRoot, missionRevisionId) {
  const directory = path.join(path.resolve(repoRoot), ...MISSIONS_DIR.split('/'));
  for (const entry of fs.readdirSync(directory).sort()) {
    if (!CONTRACT_FILE_RE.test(entry)) continue;
    let contract;
    try {
      contract = JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8').replace(/^﻿/, ''));
    } catch {
      continue;
    }
    if (contract?.id === missionRevisionId) {
      return { missionRevisionId, contractSha256: sha256Canonical(contract) };
    }
  }
  throw new Error(`UNKNOWN_MISSION_REVISION:${missionRevisionId}`);
}

/**
 * Assembles one Wheel work unit into everything R6 needs.
 *
 * The R4 graph is re-evaluated here with R4's own evaluator rather than being
 * read off the plan: recovery reasons about node STATES and reuse identities,
 * and those must come from the same function the router verified against, not
 * from a summary of it.
 */
export function createWheelRecoverySession({
  repoRoot, workUnitId, cas, sourceHead, missionRevisionId,
  previousSnapshot = null, previousGraph = null, extraTasks = [],
  indexPolicy, previousRepoIndex = null, repairLedger = null, policy
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('REPO_ROOT_REQUIRED');
  if (!cas) throw new Error('CAS_REQUIRED');
  const routed = routeWheelWorkUnit({ repoRoot, workUnitId, cas, sourceHead, previousSnapshot, previousGraph, extraTasks, repairLedger, policy });
  const r3Delta = { previousSnapshot: previousSnapshot || routed.currentSnapshot, currentSnapshot: routed.currentSnapshot };
  const evaluated = evaluateWheelEvidenceGraph({ cas, currentGraph: routed.graph, previousGraph, r3Delta });

  // The index is rebuilt incrementally when a prior one is available, using
  // the exact R3 delta already recomputed by R4. A bare changed-path array is
  // not a proof that every omitted repository path stayed unchanged.
  const repoIndex = previousRepoIndex === null
    ? buildRepoIndex({ repoRoot, policy: indexPolicy })
    : updateRepoIndex({
      repoRoot,
      previousIndex: previousRepoIndex,
      policy: indexPolicy,
      r3Delta: { deltas: evaluated.graph.evaluation.r3DeltaBasis.deltas }
    }).index;

  return {
    engine: WHEEL_RECOVERY_ADAPTER_VERSION,
    repoRoot,
    workUnitId,
    cas,
    plan: routed.plan,
    compiled: routed.compiled,
    graph: routed.graph,
    currentSnapshot: routed.currentSnapshot,
    r3Delta,
    evaluated,
    evidenceStates: evaluated.graph.nodes,
    repoIndex,
    authority: wheelAuthorityIdentity(repoRoot, missionRevisionId),
    inputs: {
      r2ContextSha256: routed.plan.provenance.r2ContextSha256,
      r3DeltaSha256: routed.plan.provenance.r3DeltaSha256,
      r4GraphSha256: routed.plan.provenance.r4GraphSha256,
      routeSha256: routed.plan.routeSha256,
      repoIndexSha256: repoIndex.indexSha256
    }
  };
}

/** The R3 delta shape planRecovery consumes, taken from the evaluated graph. */
export function wheelRecoveryDelta(session) {
  return {
    deltas: session.evaluated.graph.evaluation.r3DeltaBasis.deltas,
    metrics: { AVOIDED_REPROCESS_BYTES: session.plan.metrics.R3_AVOIDED_REPROCESS_BYTES }
  };
}

function evidenceNode(session, evidenceId) {
  return session.evidenceStates.find((node) => node.evidenceId === evidenceId) || null;
}

/**
 * Byte accounting for one task, copied from measurements R3, R4 and R5 already
 * made. contextBytes is per EXECUTION, not per work unit: each execution is fed
 * the compiled context, so the aggregate is total context consumed rather than
 * the size of a single context.
 */
export function wheelUsageBytes(session, taskId) {
  const task = session.plan.tasks.find((entry) => entry.taskId === taskId);
  if (!task) throw new Error(`UNKNOWN_ROUTE_TASK:${taskId}`);
  let evidenceReusedBytes = 0;
  let evidenceRevalidatedBytes = 0;
  for (const evidenceId of new Set([...task.produces, ...task.requiredEvidenceIds])) {
    const node = evidenceNode(session, evidenceId);
    if (!node || node.tombstone) continue;
    if (node.state === 'REUSABLE') evidenceReusedBytes += node.bytes; else evidenceRevalidatedBytes += node.bytes;
  }
  return {
    contextBytes: session.plan.metrics.R2_CONTEXT_BYTES,
    sourceProcessedBytes: task.reprocessBytes,
    sourceAvoidedBytes: task.avoidedBytes,
    evidenceReusedBytes,
    evidenceRevalidatedBytes
  };
}

/** The evidence one task produced, bound by R4's own reuse identity. */
export function wheelTaskEvidence(session, taskId) {
  const task = session.plan.tasks.find((entry) => entry.taskId === taskId);
  if (!task) throw new Error(`UNKNOWN_ROUTE_TASK:${taskId}`);
  return [...new Set([...task.produces, ...task.requiredEvidenceIds])].sort().map((evidenceId) => {
    const node = evidenceNode(session, evidenceId);
    if (!node) throw new Error(`PRODUCED_EVIDENCE_ABSENT_FROM_GRAPH:${taskId}:${evidenceId}`);
    return { evidenceId, reuseIdentity: node.reuseIdentity };
  });
}

/**
 * Records one task execution: usage record first, evidence binding returned for
 * the checkpoint that will be written after it.
 *
 * `attempt` defaults to 1 so that re-submitting the same execution deduplicates
 * instead of inflating a total. A caller who genuinely retried passes
 * `attempt: nextAttemptOrdinal(ledger, workUnitId, taskId)`.
 */
export function recordWheelTaskExecution({
  session, ledger, taskId, attempt = 1, outcome = COMPLETED,
  tokens = null, provider = null, durationMs = null
} = {}) {
  const task = session.plan.tasks.find((entry) => entry.taskId === taskId);
  if (!task) throw new Error(`UNKNOWN_ROUTE_TASK:${taskId}`);
  const appended = appendUsageRecord(ledger, {
    workUnitId: session.workUnitId,
    taskId,
    attempt,
    capability: task.capability,
    outcome,
    routeSha256: session.plan.routeSha256,
    bytes: wheelUsageBytes(session, taskId),
    tokens,
    provider,
    durationMs
  });
  return { ...appended, evidence: wheelTaskEvidence(session, taskId) };
}

/**
 * A checkpoint for this session, with the named tasks marked complete.
 *
 * `completedTaskIds` is a claim the caller has to back: every id must have both
 * a usage record and its produced evidence, otherwise the checkpoint builder
 * refuses it. Nothing is upgraded here.
 */
export function buildWheelCheckpoint({
  session, completedTaskIds = [], executionsByTaskId = {}, previousCheckpoint = null, interrupted = false, recoveryState = null
} = {}) {
  const completed = new Set(completedTaskIds);
  // Deferral is not a capability, so the core cannot see it on a checkpoint
  // task. It is refused here instead, alongside the capability contradictions
  // the core already refuses, so no route state can be lost by being marked
  // complete.
  const deferred = new Set(session.plan.deferredTasks);
  const tasks = checkpointTasksFromRoutePlan(session.plan).map((task) => {
    if (!completed.has(task.taskId)) return task;
    if (deferred.has(task.taskId)) throw new Error(`CHECKPOINT_COMPLETION_CONTRADICTS_DEFERRED_TASK:${task.taskId}`);
    const execution = executionsByTaskId[task.taskId];
    if (!execution) throw new Error(`CHECKPOINT_COMPLETION_WITHOUT_USAGE_RECORD:${task.taskId}`);
    const expectedPrefix = `usage:${session.workUnitId}#${task.taskId}#`;
    if (typeof execution.usageRecordId !== 'string' || !execution.usageRecordId.startsWith(expectedPrefix)
      || !/^[1-9][0-9]*$/.test(execution.usageRecordId.slice(expectedPrefix.length))) {
      throw new Error(`CHECKPOINT_USAGE_RECORD_TASK_MISMATCH:${task.taskId}`);
    }
    return {
      ...task,
      state: COMPLETE,
      evidence: execution.evidence,
      usageRecordIds: [execution.usageRecordId],
      reasonCodes: [...task.reasonCodes, 'EXECUTED_AND_RECORDED']
    };
  });
  return createCheckpoint({
    workUnitId: session.workUnitId,
    authority: session.authority,
    baseline: { head: session.compiled.json.identity.sourceHead, headSource: 'R2_CONTEXT_SOURCE_HEAD' },
    inputs: session.inputs,
    tasks,
    recoveryState: recoveryState || recoveryStateFor(tasks, { interrupted }),
    previousCheckpoint
  });
}

/**
 * Full resume path for one Wheel work unit: rebuild the session from current
 * repository state, load the latest valid checkpoint and the preserved usage
 * ledger, and let the R6 core decide what may be reused.
 */
export function resumeWheelWorkUnit({
  session, store, allowOlderValidCheckpoint = false, currentHead = null
} = {}) {
  const loaded = store.loadLatestValid(session.workUnitId, { allowOlderValidCheckpoint });
  const ledger = store.readUsageLedger(session.workUnitId) || createUsageLedger();
  const recovery = planRecovery({
    workUnitId: session.workUnitId,
    checkpoint: loaded.checkpoint,
    routePlan: session.plan,
    evidenceStates: session.evidenceStates,
    r3Delta: wheelRecoveryDelta(session),
    usageLedger: ledger,
    repoIndex: session.repoIndex,
    authority: session.authority,
    currentHead,
    corruptRevisions: loaded.corruptRevisions,
    policy: { allowOlderValidCheckpoint }
  });
  return { recovery, ledger, loaded };
}

export { nextAttemptOrdinal, PENDING };
