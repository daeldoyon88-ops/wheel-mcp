import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentAddressedStore } from '../cas/content-addressed-store.mjs';
import { createSnapshot } from '../delta/delta-engine.mjs';
import { createCheckpointStore } from '../recovery/checkpoint-store.mjs';
import { createWheelRecoverySession, recordWheelTaskExecution, buildWheelCheckpoint, resumeWheelWorkUnit } from '../adapters/wheel/recovery-wheel-adapter.mjs';
import { createUsageLedger } from '../usage/usage-ledger.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HEAD = '7a9936c91768e9a2a5c886c6a6da9564905c6a6c';
const MISSION = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R7';
const WORK_UNIT = 'GATE13';
const RECOVERY_TASKS = [
  { taskId: 'r7-recovery:ledger', intent: 'DETERMINISTIC', sources: ['governance/state/GATE_STATUS_LEDGER.ndjson'], mandatory: true },
  { taskId: 'r7-recovery:registry', intent: 'DETERMINISTIC', sources: ['governance/GATE_REGISTRY_00_40.json'], mandatory: true }
];

const phase = process.argv[2];
const root = process.argv[3];
const stateDir = process.argv[4];
if (!phase || !root || !stateDir) throw new Error('R7_RECOVERY_CHILD_ARGS_REQUIRED');

const cas = createContentAddressedStore(path.join(stateDir, 'cas'));
const store = createCheckpointStore(stateDir);

function session(options = {}) {
  return createWheelRecoverySession({ repoRoot: root, workUnitId: WORK_UNIT, cas, sourceHead: HEAD, missionRevisionId: MISSION, extraTasks: RECOVERY_TASKS, ...options });
}

if (phase === 'interrupt') {
  const empty = createSnapshot({ repoRoot: root, sources: [] });
  const current = session({ previousSnapshot: empty });
  const selectedTasks = RECOVERY_TASKS.map(({ taskId }) => current.plan.tasks.find((task) => task.taskId === taskId)).filter(Boolean);
  let ledger = createUsageLedger();
  const executionsByTaskId = {};
  for (const task of selectedTasks) {
    const execution = recordWheelTaskExecution({ session: current, ledger, taskId: task.taskId });
    ledger = execution.ledger;
    executionsByTaskId[task.taskId] = execution;
  }
  const checkpoint = buildWheelCheckpoint({ session: current, completedTaskIds: selectedTasks.map((task) => task.taskId), executionsByTaskId, interrupted: true });
  store.commit({ workUnitId: WORK_UNIT, ledger, checkpoint });
  fs.writeFileSync(path.join(stateDir, 'r7-input.json'), JSON.stringify({ previousSnapshot: current.currentSnapshot, previousGraph: current.evaluated.graph, previousRepoIndex: current.repoIndex, completedBeforeInterrupt: selectedTasks.length }, null, 2));
  process.stdout.write(JSON.stringify({
    phase,
    route: current.plan.routeDecision,
    completedBeforeInterrupt: selectedTasks.length,
    executedTaskIds: selectedTasks.map((task) => task.taskId),
    avoidedTaskIds: current.plan.avoidedTasks,
    checkpointState: checkpoint.recoveryState,
    sourceBytesProcessed: ledger.records.reduce((sum, record) => sum + record.bytes.sourceProcessedBytes, 0),
    usageRecords: ledger.records.map((record) => record.usageRecordId)
  }));
} else if (phase === 'resume') {
  const input = JSON.parse(fs.readFileSync(path.join(stateDir, 'r7-input.json'), 'utf8'));
  const current = session({ previousSnapshot: input.previousSnapshot, previousGraph: input.previousGraph, previousRepoIndex: input.previousRepoIndex });
  const resumed = resumeWheelWorkUnit({ session: current, store, currentHead: HEAD });
  const tasks = resumed.recovery.tasks || [];
  const reused = resumed.recovery.resumedTaskIds.length;
  const revalidated = tasks.filter((task) => task.disposition === 'REVALIDATE').length;
  const restarted = tasks.filter((task) => task.disposition === 'NEW' || task.disposition === 'PENDING').length;
  const deltas = current.evaluated.graph.evaluation.r3DeltaBasis.deltas;
  const sourceRehashed = deltas.filter((delta) => delta.kind !== 'UNCHANGED').length;
  const sourceReused = deltas.filter((delta) => delta.kind === 'UNCHANGED').length;
  const unrelatedChangeImpact = deltas.some((delta) => delta.path === 'unrelated-root-file.txt') ? 1 : 0;
  const result = {
    phase,
    decision: resumed.recovery.decision,
    tasks,
    completedPreserved: reused,
    resumedTaskIds: resumed.recovery.resumedTaskIds,
    avoidedTaskIds: resumed.recovery.avoidedTaskIds,
    tasksInvalidated: revalidated,
    tasksRevalidated: revalidated,
    tasksRestarted: restarted,
    filesRehashed: sourceRehashed,
    filesReused: sourceReused,
    bytesAvoided: current.plan.metrics.R3_AVOIDED_REPROCESS_BYTES,
    usageDuplicates: resumed.ledger.records.length - new Set(resumed.ledger.records.map((record) => record.usageRecordId)).size,
    restartedFromZero: resumed.recovery.metrics.RESTARTED_FROM_ZERO,
    canonicalRestartedFromZero: resumed.recovery.metrics.RESTARTED_FROM_ZERO,
    unrelatedChangeImpact,
    unrelatedChangePreserved: unrelatedChangeImpact === 0 && resumed.recovery.metrics.RESTARTED_FROM_ZERO === false,
    recoveryMetrics: resumed.recovery.metrics,
    reasonCodes: resumed.recovery.reasonCodes
  };
  process.stdout.write(JSON.stringify(result));
} else {
  throw new Error(`UNKNOWN_R7_RECOVERY_PHASE:${phase}`);
}
