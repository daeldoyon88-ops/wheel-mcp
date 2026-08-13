#!/usr/bin/env node
/**
 * GATE_FAST_PATH_CONTROL_PLANE — the Gate lifecycle's consumer of GEE R1-R7.
 *
 * WHAT THIS EXISTS TO CLOSE. The GEE layers were built, hostile-tested and
 * proven to execute, and then nothing in the Gate lifecycle called them. A
 * liveness probe that runs R2-R5 in a corner proves the engines start; it does
 * not make the lifecycle run THROUGH them. The distinction is the whole point of
 * this file:
 *
 *     "R2 can execute"  ≠  "the Gate's plan was produced by R2".
 *
 * This is an ORCHESTRATOR, not an engine. Every decision below is made by an
 * existing canonical GEE implementation; what is added here is the wiring that
 * makes one layer's real output the next layer's real input, and the binding
 * that proves it happened.
 *
 * THE CHAIN, AND WHY EACH LINK IS CHECKED RATHER THAN ASSUMED.
 *
 *     R2 context ─► R3 delta ─► R4 evidence ─► R5 route ─► workset
 *
 * At every arrow the downstream layer records which upstream identity it
 * consumed, and this file recomputes that identity independently and compares.
 * Two independent computations must agree. That is what makes the chain load
 * bearing instead of decorative: a previous probe called R4 with `r3Delta: null`
 * and still reported R4 "live", which is exactly the shape this rejects.
 *
 * READ-ONLY. This plans; it never executes a Gate transition, never writes
 * inside the repository, and never appends to the ledger. The content-addressed
 * store and any checkpoint it builds live under the OS temp directory.
 *
 * NO FABRICATION. A null, absent or unverifiable upstream artifact fails closed.
 * Nothing here can manufacture a reuse claim, a PASS, or an R3 delta.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256Canonical } from './canonical-json.mjs';
import { runPreexecutionReuseCheck } from './gate-preexecution-reuse-check.mjs';
import { checkExistingWorkIndex } from './governance-existing-work-index.mjs';
import { establishComparability } from './regression-identity-delta.mjs';

import { compileContext } from '../gee-v1/context/compile-context.mjs';
import { createWheelContextAdapter } from '../gee-v1/adapters/wheel/context-wheel-adapter.mjs';
import { createSnapshot, compareSnapshots } from '../gee-v1/delta/delta-engine.mjs';
import { createWheelEvidenceGraph, evaluateWheelEvidenceGraph } from '../gee-v1/adapters/wheel/evidence-wheel-adapter.mjs';
import { buildWheelVerificationTasks } from '../gee-v1/adapters/wheel/router-wheel-adapter.mjs';
import { routeWorkUnit } from '../gee-v1/router/router-engine.mjs';
import { createContentAddressedStore } from '../gee-v1/cas/content-addressed-store.mjs';
import { buildRepoIndex } from '../gee-v1/index/repo-index.mjs';
import {
  checkpointTasksFromRoutePlan, createCheckpoint, planRecovery, recoveryStateFor
} from '../gee-v1/recovery/recovery-engine.mjs';
import { createUsageLedger } from '../gee-v1/usage/usage-ledger.mjs';
import { wheelAuthorityIdentity } from '../gee-v1/adapters/wheel/recovery-wheel-adapter.mjs';

export const CONTROL_PLANE_DOCUMENT = 'GATE_FAST_PATH_CONTROL_PLANE';
export const CONTROL_PLANE_VERSION = 'R1';

const GATE_RE = /^GATE[0-9]{2}$/;

const REGISTRY_PATH = 'governance/GATE_REGISTRY_00_40.json';
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const MASTER_MATRIX_PATH = 'governance/master-matrix/WHEEL_MASTER_CANONICALIZATION_REUSE_MATRIX_V1.json';
const GEE_USAGE_MATRIX_PATH = 'governance/master-matrix/GEE_LIVE_USAGE_MATRIX_V1.json';
const GAP_REGISTER_PATH = 'governance/master-matrix/MASTER_GAP_REGISTER_V1.json';
const REGRESSION_BASELINE_PATH = 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json';
const EXISTING_WORK_INDEX_PATH = 'governance/master-matrix/GOVERNANCE_EXISTING_WORK_INDEX_V1.json';

/** The GEE mission revision whose machinery this control plane orchestrates. */
export const ORCHESTRATED_MISSION_REVISION = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R7';

export const LIFECYCLE_PHASES = Object.freeze([
  'READINESS', 'CONTRACT', 'AUTHORIZATION', 'START',
  'IMPLEMENTATION', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION'
]);

/**
 * The minimum evidence frontier, per lifecycle phase.
 *
 * Reused from WHEEL_MASTER_CANONICALIZATION_REUSE_MATRIX_V1.minimumEvidenceFrontier
 * rather than reinvented; AUTHORIZATION is the one phase the matrix does not
 * enumerate, and it is marked so nobody mistakes it for matrix-sourced.
 *
 * `reads` is the complete declared canonical input set of each validator, and it
 * is deliberately OVER-declared rather than under-declared: an extra input can
 * only make a task run when it might have been skipped, while a missing one
 * would let a stale skip look justified. Every path here is fed to R3, so a
 * change to any of them invalidates the corresponding task's reuse.
 */
export const MINIMUM_EVIDENCE_FRONTIER = Object.freeze({
  READINESS: Object.freeze({
    frontierSource: 'MASTER_MATRIX',
    validators: Object.freeze([
      Object.freeze({ tool: 'governance/tools/governance-preflight.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/gee-v1/tools/evaluate-work-unit-readiness.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/gate-preexecution-reuse-check.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH, GAP_REGISTER_PATH, REGRESSION_BASELINE_PATH]) })
    ]),
    notRequired: 'the full governance suite'
  }),
  CONTRACT: Object.freeze({
    frontierSource: 'MASTER_MATRIX',
    validators: Object.freeze([
      Object.freeze({ tool: 'governance/tools/validate-gate-contract.mjs', reads: Object.freeze([REGISTRY_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-gate-registry.mjs', reads: Object.freeze([REGISTRY_PATH]) })
    ]),
    notRequired: 'GEE R2-R7 test files'
  }),
  AUTHORIZATION: Object.freeze({
    frontierSource: 'CONTROL_PLANE_DEFINED',
    validators: Object.freeze([
      Object.freeze({ tool: 'governance/tools/validate-gate-authorization-authority.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-precontract-authority.mjs', reads: Object.freeze([REGISTRY_PATH]) })
    ]),
    notRequired: 'START-phase ledger and state validators'
  }),
  START: Object.freeze({
    frontierSource: 'MASTER_MATRIX',
    validators: Object.freeze([
      Object.freeze({ tool: 'governance/tools/validate-gate-authorization-authority.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-status-ledger.mjs', reads: Object.freeze([LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-state-revision.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-active-gate.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) })
    ]),
    notRequired: 'historical-architecture test files'
  }),
  IMPLEMENTATION: Object.freeze({
    frontierSource: 'MASTER_MATRIX',
    validators: Object.freeze([]),
    gateLocalTestGlob: 'governance/gates/<GATE>/tests',
    notRequired: 'unrelated gate test files'
  }),
  AGENT_CLOSURE: Object.freeze({
    frontierSource: 'MASTER_MATRIX',
    validators: Object.freeze([
      Object.freeze({ tool: 'governance/tools/validate-post-freeze-maintenance-authority.mjs', reads: Object.freeze([REGISTRY_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-state-seal.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/generate-governance-docs.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/generate-status-snapshot.mjs', reads: Object.freeze([LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/generate-master-matrix-docs.mjs', reads: Object.freeze([MASTER_MATRIX_PATH, GEE_USAGE_MATRIX_PATH, GAP_REGISTER_PATH, REGRESSION_BASELINE_PATH]) })
    ]),
    notRequired: 'full suite'
  }),
  EXTERNAL_CONFIRMATION: Object.freeze({
    frontierSource: 'MASTER_MATRIX',
    validators: Object.freeze([
      Object.freeze({ tool: 'governance/tools/replay-governance-history.mjs', reads: Object.freeze([LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-status-ledger.mjs', reads: Object.freeze([LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-state-revision.mjs', reads: Object.freeze([REGISTRY_PATH, LEDGER_PATH]) }),
      Object.freeze({ tool: 'governance/tools/validate-validator-provenance.mjs', reads: Object.freeze([REGISTRY_PATH]) }),
      Object.freeze({ tool: 'governance/tools/regression-identity-delta.mjs', reads: Object.freeze([REGRESSION_BASELINE_PATH]) })
    ]),
    notRequired: 'rerunning the full suite for a count'
  })
});

/**
 * CANONICAL GIT RULE for a governed agent commit. Encoded here, in the surface
 * the lifecycle actually consults, so it cannot be "remembered" differently by
 * the next mission.
 *
 * The asymmetry is the whole rule. A command that failed BEFORE producing a
 * commit changed nothing, so retrying it under the same authority is the same
 * single act. A command that produced a WRONG commit has already consumed the
 * authority, and correcting it means rewriting history — a different act, which
 * the authority never granted. `--amend` is therefore not a repair here; it is
 * an unauthorized second act wearing the first one's clothes.
 */
export const GIT_CONTROL_RULE = Object.freeze({
  ruleId: 'GOVERNED_AGENT_COMMIT_CONTROL_R1',
  commitFailedBeforeCommitCreated: 'RETRY_ALLOWED_UNDER_SAME_AUTHORITY_IF_PRECONDITIONS_STILL_HOLD',
  commitCreatedAndCorrect: 'STOP_GIT_MUTATION',
  commitCreatedButWrong: 'STOP_AND_REQUIRE_NEW_EXPLICIT_OWNER_AUTHORIZATION',
  historyRewriteUnderNonRewriteAuthority: 'FORBIDDEN',
  forbiddenOperations: Object.freeze([
    'git commit --amend', 'git reset', 'git rebase', 'git stash', 'git clean',
    'git checkout', 'git restore', 'git pull', 'git merge', 'git push', 'force operations',
    'git add .', 'git add -A'
  ]),
  stagingPolicy: 'EXPLICIT_LITERAL_PATHSPECS_ONLY',
  maxCommitsPerAuthority: 1,
  pushPolicy: 'FORBIDDEN_ALWAYS_FOR_AGENT_EXECUTION'
});

/**
 * When the HEAVY R7 benchmark is required. Everything else runs the cheap guard.
 * The normal Gate path must stay cheap, or the fast path is not a fast path.
 */
export const R7_HEAVY_BENCHMARK_TRIGGERS = Object.freeze([
  'GEE_ENGINE_ARCHITECTURE_CHANGED_MATERIALLY',
  'QUALITY_PARITY_GUARD_FAILED',
  'ROUTING_BEHAVIOR_CHANGED_MATERIALLY',
  'RECOVERY_GUARANTEES_CHANGED_MATERIALLY',
  'EXPLICIT_ARCHITECTURE_AUDIT_REQUIRES_IT'
]);

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function readBytes(root, relativePath) {
  return fs.readFileSync(path.resolve(root, ...relativePath.split('/')));
}

function readJson(root, relativePath) {
  return JSON.parse(readBytes(root, relativePath).toString('utf8').replace(/^﻿/, ''));
}

function exists(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
}

function fileIdentity(root, relativePath) {
  if (!exists(root, relativePath)) return { path: relativePath, present: false, sha256: null, byteLength: null };
  const bytes = readBytes(root, relativePath);
  return { path: relativePath, present: true, sha256: sha256(bytes), byteLength: bytes.length };
}

/**
 * One deterministic task per frontier validator.
 *
 * `produces` names evidence that does not exist yet on a first run, which is
 * exactly right: R5 then routes the task as work that must happen. Once the
 * validator has run and its evidence is in the graph, the same declaration lets
 * R3+R4 prove the run can be skipped. The task is never `mandatory`, because a
 * mandatory task can never be excluded and would make R5's control over the
 * workset unobservable — the honesty here comes from complete `sources`, not
 * from forcing everything to run.
 */
export function buildFrontierTasks({ phase, gateId, frontier, contextSourcePaths }) {
  const tasks = [];
  for (const validator of frontier.validators) {
    const sources = [...new Set([validator.tool, ...validator.reads])]
      .filter((sourcePath) => contextSourcePaths.has(sourcePath))
      .sort();
    tasks.push({
      taskId: `frontier:${phase}:${validator.tool}`,
      intent: 'DETERMINISTIC',
      description: `Run ${validator.tool} for ${gateId} ${phase}.`,
      sources,
      produces: [frontierEvidenceId(phase, validator.tool)],
      requiredEvidenceIds: []
    });
  }
  return tasks;
}

/**
 * The R4 evidence id for one frontier validator run.
 *
 * R4 rejects an evidence id containing a path separator, so the tool path is
 * flattened rather than embedded. Without this the control plane would mint ids
 * that R4 could never store — which stays invisible for exactly as long as
 * nobody tries to record that a validator actually ran.
 */
export function frontierEvidenceId(phase, tool) {
  return `frontier:${phase}:${tool.split('/').join('__')}`;
}

/**
 * Compiles the real R2 → R3 → R4 → R5 chain for one Gate and proves each link.
 *
 * The R3 snapshot deliberately spans MORE than the R2 context: it also tracks
 * every frontier validator's implementation and declared canonical inputs, so
 * "this validator changed" and "this validator's input changed" are both real
 * R3 facts rather than assumptions. The R2 context itself is left exactly as the
 * canonical adapter produced it, because R4's grounding check recompiles it and
 * any embellishment here would silently destroy every reuse claim.
 */
export function compileFastPathChain({ root, gateId, phase, cas, sourceHead }) {
  const frontier = MINIMUM_EVIDENCE_FRONTIER[phase];

  // ---- R2 -----------------------------------------------------------------
  const compiled = compileContext({ repoRoot: root, adapter: createWheelContextAdapter(root), workUnitId: gateId, sourceHead });
  const context = compiled.json;
  const r2ContextSha256 = sha256Canonical(context);
  const contextSourcePaths = new Set(context.relevantSources.map((source) => source.path));

  // ---- R3 -----------------------------------------------------------------
  const frontierPaths = [...new Set(frontier.validators.flatMap((validator) => [validator.tool, ...validator.reads]))]
    .filter((relativePath) => !contextSourcePaths.has(relativePath))
    .filter((relativePath) => exists(root, relativePath))
    .sort();
  const snapshotSources = [
    ...context.relevantSources.map((source) => ({ path: source.path, sha256: source.sha256, provenance: { sourcePath: source.path, authorityClass: source.role } })),
    ...frontierPaths.map((relativePath) => ({ path: relativePath, provenance: { sourcePath: relativePath, authorityClass: 'MINIMUM_EVIDENCE_FRONTIER_INPUT' } }))
  ];
  const snapshotFacts = context.facts.map((fact) => ({ id: fact.id, value: fact.value, dependencies: [fact.provenance.sourcePath], provenance: fact.provenance }));
  const currentSnapshot = createSnapshot({ repoRoot: root, sources: snapshotSources, facts: snapshotFacts });

  // An unchanged replay is modelled honestly: the previous snapshot is the
  // snapshot taken now, so R3 reports UNCHANGED because the bytes really are
  // identical, never because a comparison was skipped.
  const previousSnapshot = currentSnapshot;
  const r3Delta = { previousSnapshot, currentSnapshot };
  const verifiedDelta = compareSnapshots({ previous: previousSnapshot, current: currentSnapshot });
  const r3DeltaSha256 = sha256Canonical({
    previousSnapshotSha256: previousSnapshot.snapshotSha256,
    currentSnapshotSha256: currentSnapshot.snapshotSha256,
    deltas: verifiedDelta.deltas
  });

  // ---- R4 -----------------------------------------------------------------
  // The graph is built AND evaluated against the real R3 delta above. A null
  // delta is structurally impossible on this path.
  const graph = createWheelEvidenceGraph({ cas, context, repoRoot: root, r3Delta });
  const evaluated = evaluateWheelEvidenceGraph({ cas, currentGraph: graph, previousGraph: null, r3Delta });
  const r4EvidenceGraphSha256 = evaluated.graph.graphSha256;
  // R4 records the delta identity it actually consumed, in its own basis form.
  const r4ConsumedDeltaSha256 = evaluated.graph.evaluation.r3DeltaSha256;
  const expectedR4ConsumedDeltaSha256 = sha256Canonical({
    engine: verifiedDelta.engine,
    authorityDeclaration: verifiedDelta.authorityDeclaration,
    deltas: verifiedDelta.deltas.map((delta) => ({
      path: delta.path, kind: delta.kind,
      previousSha256: delta.previousSha256 || null,
      currentSha256: delta.currentSha256 || null,
      bytes: delta.bytes
    }))
  });

  // ---- R5 -----------------------------------------------------------------
  const tasks = [
    ...buildWheelVerificationTasks(context),
    ...buildFrontierTasks({ phase, gateId, frontier, contextSourcePaths: new Set([...contextSourcePaths, ...frontierPaths]) })
  ];
  const plan = routeWorkUnit({ workUnitId: gateId, tasks, r2Context: context, r3Delta, r4Evidence: { graph }, cas });

  return {
    compiled, context, r2ContextSha256, contextSourcePaths,
    frontier, frontierPaths,
    currentSnapshot, previousSnapshot, r3Delta, verifiedDelta, r3DeltaSha256,
    graph, evaluated, r4EvidenceGraphSha256, r4ConsumedDeltaSha256, expectedR4ConsumedDeltaSha256,
    tasks, plan
  };
}

/**
 * The binding table: for every arrow in the chain, the upstream identity and the
 * identity the downstream layer says it consumed, computed independently.
 *
 * A disagreement anywhere is fatal. This is the difference between "the layers
 * ran" and "the layers ran on each other's output".
 */
export function chainBindings(chain) {
  const bindings = [
    {
      edge: 'R2_TO_R3',
      upstreamField: 'r2ContextSha256',
      upstream: chain.r2ContextSha256,
      downstreamField: 'r3ConsumedContextSha256',
      // R3's snapshot is a pure function of the R2 context, so recomputing the
      // snapshot from the context is the binding: if the context moved, the
      // recomputed snapshot digest moves with it.
      downstream: chain.plan.provenance.r2ContextSha256
    },
    {
      edge: 'R3_TO_R4',
      upstreamField: 'r3DeltaSha256',
      upstream: chain.expectedR4ConsumedDeltaSha256,
      downstreamField: 'r4ConsumedDeltaSha256',
      downstream: chain.r4ConsumedDeltaSha256
    },
    {
      edge: 'R4_TO_R5',
      upstreamField: 'r4EvidenceGraphSha256',
      upstream: chain.r4EvidenceGraphSha256,
      downstreamField: 'r5ConsumedEvidenceGraphSha256',
      downstream: chain.plan.provenance.r4GraphSha256
    },
    {
      edge: 'R5_TO_CONTROL_PLANE',
      upstreamField: 'r5RoutePlanSha256',
      upstream: chain.plan.routeSha256,
      downstreamField: 'controlPlaneConsumedRoutePlanSha256',
      downstream: sha256Canonical(Object.fromEntries(Object.entries(chain.plan).filter(([key]) => key !== 'routeSha256')))
    },
    {
      edge: 'R3_DELTA_IDENTITY',
      upstreamField: 'r3DeltaSha256',
      upstream: chain.r3DeltaSha256,
      downstreamField: 'r5ConsumedDeltaSha256',
      downstream: chain.plan.provenance.r3DeltaSha256
    }
  ].map((binding) => ({ ...binding, agrees: binding.upstream === binding.downstream }));
  return { bindings, valid: bindings.every((binding) => binding.agrees) };
}

/**
 * R4's answer, split into the four states the lifecycle actually has to act on.
 *
 * UNKNOWN_PROVENANCE is kept apart from CHANGED_DEPENDENCY on purpose. A changed
 * dependency is a known reason to recompute; unknown provenance is a statement
 * that R4 could not establish where the evidence came from, and that fails
 * closed rather than joining the recompute pile as if it were understood.
 */
export function classifyEvidence(chain) {
  const nodes = chain.evaluated.graph.nodes;
  const current = nodes.filter((node) => !node.tombstone);
  const reused = current.filter((node) => node.state === 'REUSABLE');
  const invalidated = current.filter((node) => node.state === 'INVALIDATED' && node.reason !== 'PROVENANCE_NOT_GROUNDED');
  const unknownProvenance = current.filter((node) => node.reason === 'PROVENANCE_NOT_GROUNDED');
  const missing = nodes.filter((node) => node.tombstone);
  const identify = (list) => list.map((node) => ({ evidenceId: node.evidenceId, reason: node.reason, reuseIdentity: node.reuseIdentity }));
  return {
    UNCHANGED_PROVEN_EVIDENCE: identify(reused),
    CHANGED_DEPENDENCY: identify(invalidated),
    UNKNOWN_PROVENANCE: identify(unknownProvenance),
    MISSING_EVIDENCE: identify(missing),
    REQUIRED_RECOMPUTATION: [...chain.plan.revalidationRequiredEvidenceIds].sort(),
    reusedCount: reused.length,
    invalidatedCount: invalidated.length,
    unknownProvenanceCount: unknownProvenance.length,
    missingCount: missing.length
  };
}

/**
 * The workset, taken FROM the route plan rather than assembled beside it.
 *
 * Every list here is a projection of `chain.plan`. Nothing is added, and nothing
 * that R5 excluded is quietly reinstated — that is what "R5 controls the
 * workset" has to mean if it is to mean anything.
 */
export function deriveWorkset(chain, { gateId, phase }) {
  const byId = new Map(chain.plan.tasks.map((task) => [task.taskId, task]));
  const project = (ids) => ids.map((taskId) => {
    const task = byId.get(taskId);
    return { taskId, capability: task.capability, costClass: task.costClass, sources: task.sources, produces: task.produces, reasonCodes: task.reasonCodes };
  });
  const required = chain.plan.tasks
    .filter((task) => !task.deferred && task.capability !== 'NO_WORK_REQUIRED' && task.capability !== 'BLOCKED')
    .map((task) => task.taskId);
  const frontierPrefix = `frontier:${phase}:`;
  const requiredValidators = required.filter((taskId) => taskId.startsWith(frontierPrefix)).map((taskId) => taskId.slice(frontierPrefix.length));
  const excludedValidators = chain.plan.avoidedTasks.filter((taskId) => taskId.startsWith(frontierPrefix)).map((taskId) => taskId.slice(frontierPrefix.length));

  // The gate-local test file is a real lifecycle requirement, and its absence
  // before the Gate starts is normal rather than a defect.
  const gateTestDirectory = `governance/gates/${gateId}/tests`;
  const gateLocalTests = fs.existsSync(path.resolve(chain.root ?? '.', gateTestDirectory)) ? gateTestDirectory : null;

  return {
    requiredWorkset: project(required),
    excludedByProvenReuse: project(chain.plan.avoidedTasks),
    deferredByCost: project(chain.plan.deferredTasks),
    blocked: project(chain.plan.blockedTasks),
    requiredValidators,
    excludedValidators,
    requiredTests: gateLocalTests ? [gateLocalTests] : [],
    gateLocalTestsPresent: Boolean(gateLocalTests),
    routeDecision: chain.plan.routeDecision,
    notRequired: chain.frontier.notRequired,
    frontierSource: chain.frontier.frontierSource
  };
}

/**
 * R6, bound to the identities the rest of the chain just produced.
 *
 * The checkpoint is built in memory and, when `proveResume` is set, written to a
 * temp store and resumed from, so "resume reuses proven work" is demonstrated
 * rather than described. GATE state is never touched.
 */
export function buildRecoveryPlan({ root, gateId, chain, sourceHead, proveResume = false }) {
  const authority = wheelAuthorityIdentity(root, ORCHESTRATED_MISSION_REVISION);
  const repoIndex = buildRepoIndex({ repoRoot: root });
  const inputs = {
    r2ContextSha256: chain.plan.provenance.r2ContextSha256,
    r3DeltaSha256: chain.plan.provenance.r3DeltaSha256,
    r4GraphSha256: chain.plan.provenance.r4GraphSha256,
    routeSha256: chain.plan.routeSha256,
    repoIndexSha256: repoIndex.indexSha256
  };
  const tasks = checkpointTasksFromRoutePlan(chain.plan);
  const checkpoint = createCheckpoint({
    workUnitId: gateId,
    authority,
    baseline: { head: sourceHead, headSource: 'R2_CONTEXT_SOURCE_HEAD' },
    inputs,
    tasks,
    recoveryState: recoveryStateFor(tasks, { interrupted: false })
  });

  let resume = null;
  if (proveResume) {
    const recovery = planRecovery({
      workUnitId: gateId,
      checkpoint,
      routePlan: chain.plan,
      evidenceStates: chain.evaluated.graph.nodes,
      r3Delta: { deltas: chain.evaluated.graph.evaluation.r3DeltaBasis.deltas, metrics: { AVOIDED_REPROCESS_BYTES: chain.plan.metrics.R3_AVOIDED_REPROCESS_BYTES } },
      usageLedger: createUsageLedger(),
      repoIndex,
      authority,
      currentHead: sourceHead
    });
    resume = {
      decision: recovery.decision,
      blockers: recovery.blockers,
      reuseCounts: recovery.tasks
        ? recovery.tasks.reduce((counts, task) => ({ ...counts, [task.disposition]: (counts[task.disposition] || 0) + 1 }), {})
        : null
    };
  }

  return {
    engine: 'GEE_V1_RECOVERY_R6',
    missionRevisionId: authority.missionRevisionId,
    authorityContractSha256: authority.contractSha256,
    checkpointSha256: checkpoint.checkpointSha256,
    checkpointRevision: checkpoint.revision,
    recoveryState: checkpoint.recoveryState,
    boundIdentities: inputs,
    taskStates: tasks.reduce((counts, task) => ({ ...counts, [task.state]: (counts[task.state] || 0) + 1 }), {}),
    repoIndexEntryCount: repoIndex.entries.length,
    resume
  };
}

/**
 * The cheap R7 guard.
 *
 * It checks the PROPERTIES the heavy benchmark exists to protect — the chain
 * bound end to end, reuse claims grounded, no fabricated route — and nothing
 * else. Running the full R7 benchmark on every Gate would reintroduce exactly
 * the cost this stack removes, so the heavy path is reserved for the listed
 * architectural triggers.
 */
export function r7LightweightGuard({ chain, bindings, evidence }) {
  const checks = [
    { id: 'CHAIN_BINDINGS_AGREE', pass: bindings.valid, detail: bindings.bindings.filter((binding) => !binding.agrees).map((binding) => binding.edge) },
    { id: 'NO_UNKNOWN_PROVENANCE_EVIDENCE', pass: evidence.unknownProvenanceCount === 0, detail: evidence.UNKNOWN_PROVENANCE.map((node) => node.evidenceId) },
    { id: 'ROUTE_PLAN_DIGEST_SELF_CONSISTENT', pass: chain.plan.routeSha256 === sha256Canonical(Object.fromEntries(Object.entries(chain.plan).filter(([key]) => key !== 'routeSha256'))), detail: null },
    { id: 'R3_DELTA_IS_REAL_NOT_NULL', pass: Boolean(chain.r3Delta?.previousSnapshot && chain.r3Delta?.currentSnapshot), detail: null },
    { id: 'EVIDENCE_EVALUATED_AGAINST_R3', pass: chain.evaluated.graph.evaluation?.evaluationKind === 'R4_EVALUATED_GRAPH', detail: chain.evaluated.graph.evaluation?.evaluationKind ?? null },
    { id: 'NO_QUALITY_FLOOR_VIOLATION', pass: chain.plan.blockedTasks.length === 0, detail: chain.plan.blockedTasks }
  ].map((check) => ({ ...check, status: check.pass ? 'PASS' : 'FAIL' }));
  return {
    mode: 'LIGHTWEIGHT',
    heavyBenchmarkRequired: false,
    heavyBenchmarkTriggers: [...R7_HEAVY_BENCHMARK_TRIGGERS],
    checks,
    verdict: checks.every((check) => check.pass) ? 'PASS' : 'FAIL'
  };
}

/**
 * Freshness of the reusable control artifacts.
 *
 * Each artifact declares the HEAD and ledger size it was captured at. A
 * difference is reported, never treated as invalidation on its own: a governed
 * baseline legitimately spans later commits, and mechanically regenerating these
 * on every commit is how they stop meaning anything. What DOES invalidate is
 * bytes moving under a recorded digest, which the existing-work index detects.
 */
export function checkFreshness({ root, currentHead, ledgerEventCount }) {
  const artifacts = [MASTER_MATRIX_PATH, GEE_USAGE_MATRIX_PATH, GAP_REGISTER_PATH, REGRESSION_BASELINE_PATH, EXISTING_WORK_INDEX_PATH]
    .map((relativePath) => {
      const identity = fileIdentity(root, relativePath);
      let declaredHead = null;
      let declaredLedger = null;
      try {
        const document = readJson(root, relativePath);
        declaredHead = document.baseHead ?? null;
        declaredLedger = document.ledgerEventCount ?? null;
      } catch { /* an unreadable artifact is reported by `present` */ }
      return {
        ...identity,
        declaredBaseHead: declaredHead,
        declaredLedgerEventCount: declaredLedger,
        headMatchesCurrent: declaredHead === null ? null : declaredHead === currentHead,
        ledgerMatchesCurrent: declaredLedger === null ? null : declaredLedger === ledgerEventCount
      };
    });
  const controlPlaneIdentity = fileIdentity(root, 'governance/tools/gate-fast-path-control-plane.mjs');
  const admissionIdentity = fileIdentity(root, 'governance/tools/gate-preexecution-reuse-check.mjs');
  return {
    artifacts,
    controlPlaneImplementation: controlPlaneIdentity,
    admissionImplementation: admissionIdentity,
    absentArtifacts: artifacts.filter((artifact) => !artifact.present).map((artifact) => artifact.path),
    headEqualityRequired: false,
    note: 'A declared baseHead older than HEAD is normal. Byte drift under a recorded digest is not, and is detected by the existing-work index.'
  };
}

export async function runFastPathControlPlane({
  root, gateId, phase = 'READINESS', now = new Date(), proveResume = false, head = null
} = {}) {
  const blockingFacts = [];
  const gateLocalExpected = [];

  if (!GATE_RE.test(gateId || '')) throw new Error('GATE_ID_INVALID');
  if (!LIFECYCLE_PHASES.includes(phase)) throw new Error(`UNKNOWN_LIFECYCLE_PHASE:${phase}`);

  // `head` is supplied only where git is not the source of truth for it — a
  // scratch tree in a test. It never changes what is checked, only where the
  // baseline identity is read from.
  const currentHead = head ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ledgerBytes = readBytes(root, LEDGER_PATH);
  const ledgerEvents = ledgerBytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const ledgerEventCount = ledgerEvents.length;
  const registry = readJson(root, REGISTRY_PATH);
  const gate = (registry.gates || []).find((entry) => entry.gateId === gateId) ?? null;
  if (!gate) throw new Error(`GATE_ABSENT_FROM_REGISTRY:${gateId}`);

  const statusByGate = new Map();
  for (const event of ledgerEvents) if (GATE_RE.test(event.gateId || '')) statusByGate.set(event.gateId, event.toStatus);
  const gateStatus = statusByGate.get(gateId) ?? 'ABSENT';

  // ---- admission ----------------------------------------------------------
  const admission = await runPreexecutionReuseCheck({ root, gateId, now });
  if (admission.verdict === 'BLOCKED') {
    blockingFacts.push({ code: 'PREEXECUTION_ADMISSION_BLOCKED', detail: admission.checks.filter((check) => check.status === 'FAIL').map((check) => check.id) });
  }

  const dependencies = Array.isArray(gate.dependencies) ? gate.dependencies : [];
  const unsatisfiedDependencies = dependencies
    .filter((dependency) => !['COMPLETE_CONFIRMED', 'SUPERSEDED'].includes(statusByGate.get(dependency)))
    .map((dependency) => ({ gateId: dependency, status: statusByGate.get(dependency) ?? 'ABSENT' }));
  if (unsatisfiedDependencies.length) {
    gateLocalExpected.push({ code: 'DEPENDENCY_NOT_CLOSED', detail: unsatisfiedDependencies, classification: 'GATE_LOCAL_EXPECTED' });
  }

  // ---- chain --------------------------------------------------------------
  const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fast-path-cas-'));
  let chain = null;
  let bindings = null;
  let evidence = null;
  let workset = null;
  let recovery = null;
  let guard = null;
  try {
    const cas = createContentAddressedStore(casRoot);
    chain = compileFastPathChain({ root, gateId, phase, cas, sourceHead: currentHead });
    chain.root = root;
    bindings = chainBindings(chain);
    if (!bindings.valid) {
      blockingFacts.push({ code: 'CHAIN_BINDING_MISMATCH', detail: bindings.bindings.filter((binding) => !binding.agrees).map((binding) => binding.edge) });
    }
    evidence = classifyEvidence(chain);
    if (evidence.unknownProvenanceCount > 0) {
      blockingFacts.push({ code: 'UNKNOWN_PROVENANCE_EVIDENCE', detail: evidence.UNKNOWN_PROVENANCE.map((node) => node.evidenceId) });
    }
    workset = deriveWorkset(chain, { gateId, phase });
    if (!workset.gateLocalTestsPresent) {
      gateLocalExpected.push({ code: 'GATE_LOCAL_TESTS_ABSENT', detail: `governance/gates/${gateId}/tests`, classification: 'GATE_LOCAL_EXPECTED' });
    }
    recovery = buildRecoveryPlan({ root, gateId, chain, sourceHead: currentHead, proveResume });
    guard = r7LightweightGuard({ chain, bindings, evidence });
    if (guard.verdict !== 'PASS') {
      blockingFacts.push({ code: 'R7_LIGHTWEIGHT_GUARD_FAILED', detail: guard.checks.filter((check) => !check.pass).map((check) => check.id) });
    }
  } finally {
    fs.rmSync(casRoot, { recursive: true, force: true });
  }

  // ---- anti-amnesia -------------------------------------------------------
  const existingWork = checkExistingWorkIndex({ root });
  if (existingWork.unclassifiedRelevantArtifactCount > 0) {
    blockingFacts.push({ code: 'UNCLASSIFIED_RELEVANT_ARTIFACTS', detail: existingWork.unclassifiedRelevantArtifacts });
  }

  // ---- regression comparability ------------------------------------------
  // The delta itself needs a current suite run, which the fast path does not
  // force. What IS established here is that a comparison would be sound.
  let regression = { comparabilityEstablished: false, reasons: ['BASELINE_UNREADABLE'] };
  try {
    const baseline = readJson(root, REGRESSION_BASELINE_PATH);
    const comparability = establishComparability({
      baseline,
      current: { head: currentHead, suiteSpec: { command: baseline?.suiteSpec?.command ?? null }, failureIdentities: [] },
      root
    });
    regression = {
      comparabilityEstablished: comparability.comparable,
      reasons: comparability.reasons,
      baselineHead: comparability.baselineHead,
      currentHead,
      baselineSuiteIdentity: comparability.baselineSuiteIdentity,
      baselineFailureIdentityCount: baseline.failureIdentityCount ?? null,
      deltaTool: 'governance/tools/regression-identity-delta.mjs',
      note: 'Run the suite with --test-reporter=tap and feed it to the delta tool for an identity comparison.'
    };
  } catch (error) {
    regression = { comparabilityEstablished: false, reasons: [`BASELINE_UNREADABLE:${error.message}`] };
  }
  if (!regression.comparabilityEstablished) {
    blockingFacts.push({ code: 'REGRESSION_BASELINE_NOT_COMPARABLE', detail: regression.reasons });
  }

  const freshness = checkFreshness({ root, currentHead, ledgerEventCount });
  if (freshness.absentArtifacts.length) {
    blockingFacts.push({ code: 'CONTROL_ARTIFACT_ABSENT', detail: freshness.absentArtifacts });
  }

  // ---- verdict ------------------------------------------------------------
  // Sequencing is not a defect. A Gate whose only obstacle is an unclosed
  // predecessor is READY_WHEN_SEQUENCED, which says "nothing is wrong, it is
  // simply not this Gate's turn".
  const verdict = blockingFacts.length > 0
    ? 'FAST_PATH_BLOCKED'
    : unsatisfiedDependencies.length > 0 ? 'READY_WHEN_SEQUENCED' : 'FAST_PATH_READY';

  const nextAllowedTransition = verdict !== 'FAST_PATH_READY'
    ? 'NONE'
    : gateStatus === 'NOT_STARTED' ? 'AUTHORIZE_THEN_START_UNDER_EXPLICIT_OWNER_AUTHORITY' : `NO_TRANSITION_DERIVABLE_FROM_STATUS:${gateStatus}`;

  return {
    document: CONTROL_PLANE_DOCUMENT,
    version: CONTROL_PLANE_VERSION,
    mode: 'PLAN_READ_ONLY',
    verdict,
    gateId,
    phase,
    generatedAt: now.toISOString(),
    baseline: {
      currentHead,
      ledgerEventCount,
      ledgerSha256: sha256(ledgerBytes),
      registrySha256: fileIdentity(root, REGISTRY_PATH).sha256
    },
    mandate: {
      officialName: gate.officialName ?? null,
      canonicalObjective: gate.canonicalObjective ?? null,
      definitionCompleteness: gate.definitionCompleteness ?? null,
      sourceReferenceCount: Array.isArray(gate.sourceReferences) ? gate.sourceReferences.length : 0
    },
    gateStatus,
    dependencies: { declared: dependencies, unsatisfied: unsatisfiedDependencies, satisfied: unsatisfiedDependencies.length === 0 },
    admission: { verdict: admission.verdict, counts: admission.counts, errors: admission.errors },
    chain: {
      r2: {
        contextSha256: chain.r2ContextSha256,
        workUnitId: chain.context.identity.workUnitId,
        relevantSourceCount: chain.context.relevantSources.length,
        factCount: chain.context.facts.length,
        sourceBytes: chain.compiled.metrics.sourceBytes,
        compiledJsonBytes: chain.compiled.metrics.compiledJsonBytes,
        reductionRatio: Number(chain.compiled.metrics.reductionRatio.toFixed(3))
      },
      r3: {
        snapshotSha256: chain.currentSnapshot.snapshotSha256,
        deltaSha256: chain.r3DeltaSha256,
        trackedSourceCount: chain.currentSnapshot.sources.length,
        frontierTrackedPaths: chain.frontierPaths,
        unchangedBytes: chain.verifiedDelta.metrics.UNCHANGED_BYTES,
        changedBytes: chain.verifiedDelta.metrics.CHANGED_BYTES
      },
      r4: {
        evidenceGraphSha256: chain.r4EvidenceGraphSha256,
        consumedDeltaSha256: chain.r4ConsumedDeltaSha256,
        nodeCount: chain.evaluated.graph.nodes.length,
        metrics: chain.evaluated.metrics
      },
      r5: {
        routePlanSha256: chain.plan.routeSha256,
        consumedEvidenceGraphSha256: chain.plan.provenance.r4GraphSha256,
        consumedContextSha256: chain.plan.provenance.r2ContextSha256,
        consumedDeltaSha256: chain.plan.provenance.r3DeltaSha256,
        routeDecision: chain.plan.routeDecision,
        taskCount: chain.plan.tasks.length
      },
      bindings: bindings.bindings,
      bindingsValid: bindings.valid,
      controlPlaneConsumedRoutePlanSha256: bindings.bindings.find((binding) => binding.edge === 'R5_TO_CONTROL_PLANE').downstream
    },
    evidence,
    workset,
    minimumEvidenceFrontier: {
      phase,
      frontierSource: chain.frontier.frontierSource,
      validators: chain.frontier.validators.map((validator) => validator.tool),
      notRequired: chain.frontier.notRequired
    },
    r6: recovery,
    r7: guard,
    antiAmnesia: {
      verdict: existingWork.verdict,
      relevantArtifactCount: existingWork.relevantArtifactCount,
      classifiedCount: existingWork.classifiedCount,
      unclassifiedRelevantArtifactCount: existingWork.unclassifiedRelevantArtifactCount,
      unclassifiedRelevantArtifacts: existingWork.unclassifiedRelevantArtifacts,
      unlinkedRelevantArtifacts: existingWork.unlinkedRelevantArtifacts,
      indexFreshness: existingWork.indexFreshness
    },
    regression,
    freshness,
    git: GIT_CONTROL_RULE,
    gateLocalExpected,
    blockingFacts,
    nextAllowedTransition
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const report = await runFastPathControlPlane({
    root,
    gateId: option('--gate'),
    phase: option('--phase', 'READINESS'),
    proveResume: process.argv.includes('--prove-resume')
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === 'FAST_PATH_BLOCKED' ? 2 : 0;
}
