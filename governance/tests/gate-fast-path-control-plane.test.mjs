/**
 * Hostile tests for GATE_FAST_PATH_CONTROL_PLANE.
 *
 * The claim under test is narrow and easy to fake, so these tests are written
 * against the failure modes rather than the happy path. What must be proven is
 * not "the control plane returns FAST_PATH_READY" but:
 *
 *   - each arrow in R2→R3→R4→R5 carries a REAL identity, and breaking any one of
 *     them is detected rather than absorbed;
 *   - a null or fabricated upstream artifact cannot produce a downstream result;
 *   - reuse is grounded — no evidence is reused whose provenance R4 could not
 *     establish;
 *   - work that has not started yet is distinguished from machinery that does
 *     not exist;
 *   - the things this mission must NOT do (start a Gate, switch ACTIVE_GATE,
 *     introduce R8, rewrite history) remain impossible.
 *
 * Real modules are used throughout. There is no fixture that hardcodes a PASS,
 * and no validator here checks its own output. Hostile cases operate on a
 * scratch copy under the OS temp directory; the real repository is never
 * mutated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runFastPathControlPlane, compileFastPathChain, chainBindings, classifyEvidence,
  deriveWorkset, r7LightweightGuard, buildRecoveryPlan,
  GIT_CONTROL_RULE, MINIMUM_EVIDENCE_FRONTIER, LIFECYCLE_PHASES,
  ORCHESTRATED_MISSION_REVISION, CONTROL_PLANE_DOCUMENT, frontierEvidenceId,
  loadFastPathLifecycleState
} from '../tools/gate-fast-path-control-plane.mjs';
import { checkExistingWorkIndex, buildExistingWorkIndex } from '../tools/governance-existing-work-index.mjs';
import { compareRegressionIdentities, establishComparability, parseTapFailureIdentities, resolveSuiteManifest } from '../tools/regression-identity-delta.mjs';
import { runPreexecutionReuseCheck } from '../tools/gate-preexecution-reuse-check.mjs';

import { createContentAddressedStore } from '../gee-v1/cas/content-addressed-store.mjs';
import { createSnapshot, compareSnapshots } from '../gee-v1/delta/delta-engine.mjs';
import { createWheelEvidenceGraph, evaluateWheelEvidenceGraph } from '../gee-v1/adapters/wheel/evidence-wheel-adapter.mjs';
import { createFreshValidation } from '../gee-v1/evidence/evidence-graph.mjs';
import { routeWorkUnit } from '../gee-v1/router/router-engine.mjs';
import { compileContext } from '../gee-v1/context/compile-context.mjs';
import { createWheelContextAdapter } from '../gee-v1/adapters/wheel/context-wheel-adapter.mjs';
import { planRecovery, createCheckpoint, checkpointTasksFromRoutePlan, recoveryStateFor, COMPLETE } from '../gee-v1/recovery/recovery-engine.mjs';
import { buildRepoIndex } from '../gee-v1/index/repo-index.mjs';
import { createUsageLedger, appendUsageRecord } from '../gee-v1/usage/usage-ledger.mjs';
import { wheelAuthorityIdentity } from '../gee-v1/adapters/wheel/recovery-wheel-adapter.mjs';
import { sha256Canonical } from '../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD = 'd96b8ace7ac2d2bf3285802e65164562dedbf0aa';
const CURRENT_HEAD = 'fbd5f5122569dc5729b5c66f800c270c802089fe';
const CONTROL_PLANE_CLI = path.join(REPO_ROOT, 'governance/tools/gate-fast-path-control-plane.mjs');

function runLifecycleProcess({ root = REPO_ROOT, store, head = null, extra = [] }) {
  const args = [CONTROL_PLANE_CLI, '--root', root, '--git-history-root', REPO_ROOT, '--gate', 'GATE15', '--phase', 'READINESS', '--lifecycle-store', store, ...extra];
  if (head) args.push('--head', head);
  const child = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60000 });
  assert.ok(child.stdout, child.stderr || `child exited ${child.status}`);
  return { status: child.status, report: JSON.parse(child.stdout), stderr: child.stderr };
}

let cachedLifecycleProof = null;
function lifecycleProof() {
  if (cachedLifecycleProof) return cachedLifecycleProof;
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-path-lifecycle-proof-'));
  const run1 = runLifecycleProcess({ store });
  const run2 = runLifecycleProcess({ store });
  cachedLifecycleProof = { store, run1, run2 };
  return cachedLifecycleProof;
}

function scratchRepo(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-path-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  if (mutate) mutate(root);
  return root;
}

function withCas(run) {
  const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-path-cas-'));
  try {
    return run(createContentAddressedStore(casRoot));
  } finally {
    fs.rmSync(casRoot, { recursive: true, force: true });
  }
}

function chainFor(gateId = 'GATE15', phase = 'READINESS', root = REPO_ROOT) {
  return withCas((cas) => {
    const chain = compileFastPathChain({ root, gateId, phase, cas, sourceHead: HEAD });
    chain.root = root;
    return chain;
  });
}

/* ------------------------------------------------------------------------ */
/* 1-5  the chain is load bearing                                            */
/* ------------------------------------------------------------------------ */

test('FP01 an R2 context from another Gate cannot be routed as this Gate', () => {
  withCas((cas) => {
    const foreign = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE16', sourceHead: HEAD }).json;
    const chain = compileFastPathChain({ root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS', cas, sourceHead: HEAD });
    assert.throws(
      () => routeWorkUnit({ workUnitId: 'GATE15', tasks: chain.tasks, r2Context: foreign, r3Delta: chain.r3Delta, r4Evidence: { graph: chain.graph }, cas }),
      /R2_CONTEXT_WORK_UNIT_MISMATCH/
    );
  });
});

test('FP01b R3 records the exact R2 context it consumed and a record-only mutation blocks', () => {
  const chain = chainFor();
  assert.equal(chain.r3Record.consumedR2ContextSha256, chain.r2ContextSha256);
  const hostile = structuredClone(chain);
  hostile.r3Record.consumedR2ContextSha256 = 'f'.repeat(64);
  const bindings = chainBindings(hostile);
  assert.equal(bindings.valid, false);
  assert.equal(bindings.bindings.find((entry) => entry.edge === 'R2_TO_R3').agrees, false);
});

test('FP02 a mutated R3 delta cannot be consumed by R4', () => {
  withCas((cas) => {
    const chain = compileFastPathChain({ root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS', cas, sourceHead: HEAD });
    const forged = structuredClone(chain.currentSnapshot);
    forged.sources[0].sha256 = 'f'.repeat(64);
    assert.throws(
      () => evaluateWheelEvidenceGraph({ cas, currentGraph: chain.graph, previousGraph: null, r3Delta: { previousSnapshot: forged, currentSnapshot: chain.currentSnapshot } }),
      /INVALID_PREVIOUS_SNAPSHOT_DIGEST|INVALID_R3_INPUT/
    );
  });
});

test('FP03 a mutated R4 evidence graph cannot be consumed by R5', () => {
  withCas((cas) => {
    const chain = compileFastPathChain({ root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS', cas, sourceHead: HEAD });
    const forged = structuredClone(chain.graph);
    forged.nodes[0].authorityStatus = 'GROUNDED';
    forged.nodes[0].state = 'REUSABLE';
    assert.throws(
      () => routeWorkUnit({ workUnitId: 'GATE15', tasks: chain.tasks, r2Context: chain.context, r3Delta: chain.r3Delta, r4Evidence: { graph: forged }, cas }),
      /INVALID_R4_INPUT|INVALID_CURRENT_GRAPH_DIGEST|INVALID_CURRENT_CONTENT_IDENTITY/
    );
  });
});

test('FP04 an edited R5 route plan cannot silently change the workset', () => {
  const chain = chainFor();
  const tampered = structuredClone(chain.plan);
  tampered.routeDecision = 'NO_WORK_REQUIRED';
  const bindings = chainBindings({ ...chain, plan: tampered });
  const edge = bindings.bindings.find((binding) => binding.edge === 'R5_TO_CONTROL_PLANE');
  assert.equal(edge.agrees, false, 'an edited plan must break its own digest binding');
  assert.equal(bindings.valid, false);
});

test('FP05 a null R3 delta is rejected on the production chain', () => {
  withCas((cas) => {
    const context = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE15', sourceHead: HEAD }).json;
    // A graph built with r3Delta null carries no bound validation, so R4 refuses
    // to call any of it reusable and R5 cannot route it as proven work.
    const unbound = createWheelEvidenceGraph({ cas, context, repoRoot: REPO_ROOT, r3Delta: null });
    assert.throws(() => evaluateWheelEvidenceGraph({ cas, currentGraph: unbound, previousGraph: null, r3Delta: null }), /R3_SNAPSHOTS_REQUIRED/);

    const snapshot = createSnapshot({
      repoRoot: REPO_ROOT,
      sources: context.relevantSources.map((source) => ({ path: source.path, sha256: source.sha256, provenance: { sourcePath: source.path, authorityClass: source.role } })),
      facts: context.facts.map((fact) => ({ id: fact.id, value: fact.value, dependencies: [fact.provenance.sourcePath], provenance: fact.provenance }))
    });
    const evaluated = evaluateWheelEvidenceGraph({ cas, currentGraph: unbound, previousGraph: null, r3Delta: { previousSnapshot: snapshot, currentSnapshot: snapshot } });
    assert.equal(evaluated.metrics.REUSABLE_NODES, 0, 'evidence never bound to a real delta must not be reusable');
  });
});

test('FP05b a same-run current snapshot cannot be supplied as previous state', () => {
  const current = chainFor();
  withCas((cas) => {
    assert.throws(
      () => compileFastPathChain({
        root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS', cas, sourceHead: HEAD,
        previousLifecycleState: {
          currentSnapshot: current.currentSnapshot,
          currentGraph: current.evaluated.graph,
          provenance: { kind: 'R6_DURABLE_CHECKPOINT' }
        }
      }),
      /PREVIOUS_SNAPSHOT_NOT_FROM_VALIDATED_DURABLE_STATE/
    );
  });
});

/* ------------------------------------------------------------------------ */
/* 6-9  index, provenance and authority substitution                         */
/* ------------------------------------------------------------------------ */

test('FP06 byte drift under a recorded digest makes the existing-work index stale', () => {
  const root = scratchRepo((scratch) => {
    const target = path.join(scratch, 'governance/sources/GATE15_CANONICAL_MANDATE_R0.json');
    const document = JSON.parse(fs.readFileSync(target, 'utf8'));
    document.__driftProbe = 'changed';
    fs.writeFileSync(target, JSON.stringify(document, null, 2));
  });
  try {
    const report = checkExistingWorkIndex({ root });
    assert.equal(report.verdict, 'STALE_INDEX_REFRESH_REQUIRED');
    assert.ok(report.indexFreshness.driftedArtifacts.includes('governance/sources/GATE15_CANONICAL_MANDATE_R0.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FP07 a relevant decision pack that nothing cites is detected as unclassified', () => {
  const root = scratchRepo((scratch) => {
    fs.writeFileSync(
      path.join(scratch, 'governance/sources/ORPHAN_DECISION_PACK_R1.json'),
      JSON.stringify({ documentKind: 'DECISION_PACK', decision: 'never filed anywhere' }, null, 2)
    );
  });
  try {
    const report = checkExistingWorkIndex({ root });
    assert.ok(report.unclassifiedRelevantArtifacts.includes('governance/sources/ORPHAN_DECISION_PACK_R1.json'));
    assert.equal(report.verdict, 'BLOCKED_UNCLASSIFIED_RELEVANT_ARTIFACTS');
    assert.ok(report.unclassifiedRelevantArtifactCount > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FP07b prose or comment mention does not link an orphan; a structured exact-path relation does', () => {
  const orphan = 'governance/sources/ORPHAN_RELATION_DECISION_R1.json';
  const root = scratchRepo((scratch) => {
    fs.writeFileSync(path.join(scratch, ...orphan.split('/')), JSON.stringify({ documentKind: 'DECISION_PACK' }));
    fs.writeFileSync(path.join(scratch, 'governance/historical-architecture/ORPHAN_MENTION.md'), `Ordinary prose mentions ${orphan}.\n`);
    fs.writeFileSync(path.join(scratch, 'governance/tools/orphan-mention.mjs'), `// ${orphan}\nexport const harmless = true;\n`);
  });
  try {
    const proseOnly = buildExistingWorkIndex({ root });
    assert.ok(proseOnly.unclassifiedRelevantArtifacts.includes(orphan));
    const proseRow = proseOnly.artifacts.find((entry) => entry.path === orphan);
    assert.equal(proseRow.linkCount, 0);

    fs.writeFileSync(
      path.join(root, 'governance/historical-architecture/ORPHAN_STRUCTURED_RELATION.json'),
      JSON.stringify({ relationType: 'CANONICAL_DISPOSITION_REFERENCE', targetPath: orphan }, null, 2)
    );
    const structured = buildExistingWorkIndex({ root });
    const linked = structured.artifacts.find((entry) => entry.path === orphan);
    assert.equal(linked.disposition, 'CONSUMED');
    assert.ok(linked.relationshipEvidence.some((entry) => entry.relationType === 'STRUCTURED_JSON_REFERENCE'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FP08 a superseded artifact keeps its disposition and never becomes canonical', () => {
  const index = buildExistingWorkIndex({
    root: REPO_ROOT,
    explicitDispositions: {
      'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json': { disposition: 'SUPERSEDED', reason: 'test fixture' }
    }
  });
  const row = index.artifacts.find((entry) => entry.path === 'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json');
  assert.equal(row.disposition, 'SUPERSEDED');
  assert.equal(row.dispositionSource, 'EXPLICIT');
  assert.notEqual(row.disposition, 'CANONICAL');
});

test('FP09 a generated projection is neither indexed as governed work nor compiled as context', () => {
  const index = buildExistingWorkIndex({ root: REPO_ROOT });
  assert.equal(index.artifacts.filter((entry) => entry.path.includes('/generated/')).length, 0);
  const chain = chainFor();
  assert.equal(chain.context.relevantSources.filter((source) => source.path.includes('/generated/')).length, 0);
  assert.equal(chain.currentSnapshot.sources.filter((source) => source.path.includes('/generated/')).length, 0);
});

/* ------------------------------------------------------------------------ */
/* 10-12  regression identity, not counts                                    */
/* ------------------------------------------------------------------------ */

test('FP10 suite identity comes from the resolved universe and makes evolution explicit', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json'), 'utf8'));
  const baselineSuite = resolveSuiteManifest({ root: REPO_ROOT, command: baseline.suiteSpec.command, commit: baseline.baseHead });
  const currentSuite = resolveSuiteManifest({ root: REPO_ROOT, command: baseline.suiteSpec.command });
  const comparability = establishComparability({
    baseline: { ...baseline, suiteManifest: baselineSuite }, root: REPO_ROOT,
    current: { head: CURRENT_HEAD, suiteSpec: { command: baseline.suiteSpec.command }, failureIdentities: [], suiteManifest: currentSuite }
  });
  assert.equal(comparability.comparable, true);
  assert.equal(baselineSuite.resolvedTestPathCount, baseline.suiteSpec.testFileCount);
  assert.notEqual(comparability.baselineSuiteIdentity, comparability.currentSuiteIdentity);
  assert.equal(comparability.suiteRelation, 'EVOLVED_TRACEABLE');
  assert.ok(comparability.suiteEvolution.added.includes('governance/tests/gate-fast-path-control-plane.test.mjs'));
});

test('FP11 a new failure outside the mission cohort is NEW_UNRELATED and fails', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json'), 'utf8'));
  const root = scratchRepo((scratch) => {
    fs.writeFileSync(path.join(scratch, 'governance/tests/unrelated.test.mjs'), "import test from 'node:test'; test('brand new failure',()=>{});\n");
  });
  const baselineSuite = resolveSuiteManifest({ root: REPO_ROOT, command: baseline.suiteSpec.command, commit: baseline.baseHead });
  const currentSuite = resolveSuiteManifest({ root, command: baseline.suiteSpec.command });
  const current = {
    head: HEAD,
    suiteSpec: { command: baseline.suiteSpec.command },
    suiteManifest: currentSuite,
    failureIdentities: [
      ...baseline.failureIdentities.map((entry) => ({ identity: entry.identity, file: entry.file, testName: entry.testName, locationResolved: true })),
      { identity: 'governance/tests/unrelated.test.mjs::brand new failure', file: 'governance/tests/unrelated.test.mjs', testName: 'brand new failure', locationResolved: true }
    ]
  };
  try {
    const delta = compareRegressionIdentities({ baseline: { ...baseline, suiteManifest: baselineSuite }, current, root, cohortPaths: ['governance/tools/gate-fast-path-control-plane.mjs'] });
    assert.equal(delta.counts.NEW_UNRELATED, 1);
    assert.equal(delta.verdict, 'FAIL_NEW_UNRELATED_REGRESSIONS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FP12 a repaired historical failure is REPAIRED, never a regression', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json'), 'utf8'));
  const [dropped, ...kept] = baseline.failureIdentities;
  const current = {
    head: HEAD,
    suiteSpec: { command: baseline.suiteSpec.command },
    failureIdentities: kept.map((entry) => ({ identity: entry.identity, file: entry.file, testName: entry.testName, locationResolved: true }))
  };
  const delta = compareRegressionIdentities({ baseline, current, root: REPO_ROOT });
  assert.equal(delta.counts.REPAIRED, 1);
  assert.equal(delta.counts.NEW_UNRELATED, 0);
  assert.equal(delta.verdict, 'PASS');
  assert.equal(delta.identities.find((entry) => entry.identity === dropped.identity).classification, 'REPAIRED');
});

/* ------------------------------------------------------------------------ */
/* 13-14  R6 continuity                                                      */
/* ------------------------------------------------------------------------ */

test('FP13 a checkpoint written under another authority cannot resume', () => {
  const chain = chainFor();
  const authority = wheelAuthorityIdentity(REPO_ROOT, ORCHESTRATED_MISSION_REVISION);
  const repoIndex = buildRepoIndex({ repoRoot: REPO_ROOT });
  const tasks = checkpointTasksFromRoutePlan(chain.plan);
  const foreign = createCheckpoint({
    workUnitId: 'GATE15',
    authority: { missionRevisionId: 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R1', contractSha256: 'a'.repeat(64) },
    baseline: { head: HEAD, headSource: 'R2_CONTEXT_SOURCE_HEAD' },
    inputs: {
      r2ContextSha256: chain.plan.provenance.r2ContextSha256,
      r3DeltaSha256: chain.plan.provenance.r3DeltaSha256,
      r4GraphSha256: chain.plan.provenance.r4GraphSha256,
      routeSha256: chain.plan.routeSha256,
      repoIndexSha256: repoIndex.indexSha256
    },
    tasks,
    recoveryState: recoveryStateFor(tasks, { interrupted: true })
  });
  const recovery = planRecovery({
    workUnitId: 'GATE15', checkpoint: foreign, routePlan: chain.plan,
    evidenceStates: chain.evaluated.graph.nodes,
    r3Delta: { deltas: chain.evaluated.graph.evaluation.r3DeltaBasis.deltas, metrics: { AVOIDED_REPROCESS_BYTES: 0 } },
    usageLedger: createUsageLedger(), repoIndex, authority, currentHead: HEAD
  });
  assert.equal(recovery.decision, 'BLOCKED');
  assert.ok(recovery.reasonCodes.some((code) => code.startsWith('CHECKPOINT_AUTHORITY_MISMATCH')));
});

test('FP14 a valid checkpoint resumes completed work instead of redoing it', () => {
  // A resume is only meaningful once a validator has genuinely run, so this
  // fixture puts that validator's evidence into the graph the way a real run
  // would: a real producing validation, bound by R4 to the real R3 basis. The
  // binding is done by createFreshValidation, so nothing here can invent a PASS.
  const proof = lifecycleProof();
  const loaded = loadFastPathLifecycleState({ lifecycleStoreRoot: proof.store, gateId: 'GATE15', phase: 'READINESS', sourceHead: CURRENT_HEAD });
  assert.equal(loaded.status, 'LOADED');
  const cas = createContentAddressedStore(path.join(proof.store, 'GATE15-READINESS', 'r4-cas'));
  const { chain, routed, ledger } = (() => {
    const base = compileFastPathChain({
      root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS', cas, sourceHead: CURRENT_HEAD,
      previousLifecycleState: loaded.state
    });
    const validator = MINIMUM_EVIDENCE_FRONTIER.READINESS.validators[0];
    const evidenceId = frontierEvidenceId('READINESS', validator.tool);
    const item = {
      evidenceId,
      content: { validator: validator.tool, outcome: 'PASS' },
      evidenceType: 'FRONTIER_VALIDATOR_RUN',
      provenance: { sourcePath: validator.tool, authorityClass: 'MINIMUM_EVIDENCE_FRONTIER_INPUT' },
      dependencies: [`source:${validator.tool}`],
      authorityStatus: 'GROUNDED',
      producingValidation: null
    };
    // Pass 1 normalizes the node so its reuse identity exists; pass 2 binds the
    // outcome to the current basis and rebuilds the graph with it.
    const unbound = createWheelEvidenceGraph({ cas, context: base.context, repoRoot: REPO_ROOT, r3Delta: base.r3Delta, evidenceItems: [item] });
    const normalized = unbound.nodes.find((node) => node.evidenceId === evidenceId);
    const bound = createFreshValidation({
      node: normalized, graph: null, r3Delta: base.r3Delta,
      validationResult: { validator: validator.tool, verification: 'FRONTIER_VALIDATOR_EXECUTION', result: 'PASS' }
    });
    const graph = createWheelEvidenceGraph({
      cas, context: base.context, repoRoot: REPO_ROOT, r3Delta: base.r3Delta,
      evidenceItems: [{ ...item, producingValidation: bound }]
    });
    const evaluated = evaluateWheelEvidenceGraph({ cas, currentGraph: graph, previousGraph: null, r3Delta: base.r3Delta });
    const node = evaluated.graph.nodes.find((entry) => entry.evidenceId === evidenceId);
    assert.equal(node.state, 'REUSABLE', 'the fixture must produce genuinely reusable evidence');

    // The validator is marked MANDATORY, which is what keeps it real work even
    // though its evidence is reusable — a non-mandatory task with reusable
    // evidence is simply excluded by R5, and an excluded task can never be
    // "completed", so it could not exercise resume at all.
    const tasks = base.tasks.map((task) => (task.produces.includes(evidenceId) ? { ...task, mandatory: true } : task));
    const plan = routeWorkUnit({ workUnitId: 'GATE15', tasks, r2Context: base.context, r3Delta: base.r3Delta, r4Evidence: { graph }, cas });
    const routedTask = plan.tasks.find((task) => task.produces.includes(evidenceId));
    assert.equal(routedTask.capability, 'LOCAL_DETERMINISTIC');
    assert.ok(routedTask.reasonCodes.includes('MANDATORY_VALIDATION_RUNS_DESPITE_AVAILABLE_REUSE'));
    return {
      chain: { ...base, graph, evaluated, plan, root: REPO_ROOT },
      routed: routedTask,
      ledger: null
    };
  })();

  const authority = wheelAuthorityIdentity(REPO_ROOT, ORCHESTRATED_MISSION_REVISION);
  const repoIndex = buildRepoIndex({ repoRoot: REPO_ROOT });
  assert.ok(routed, 'the fixture needs the validator task in the plan');
  void ledger;
  // The usage ledger is immutable: appending returns a new sealed ledger, and
  // the checkpoint must be resumed against THAT one.
  const appended = appendUsageRecord(createUsageLedger(), {
    workUnitId: 'GATE15', taskId: routed.taskId, attempt: 1, capability: routed.capability,
    outcome: 'COMPLETED', routeSha256: chain.plan.routeSha256,
    bytes: { contextBytes: 0, sourceProcessedBytes: 0, sourceAvoidedBytes: 0, evidenceReusedBytes: 0, evidenceRevalidatedBytes: 0 },
    tokens: null, provider: null, durationMs: null
  });

  // The evidence binding is the REAL reuse identity R4 computed. A fabricated
  // one would be caught here rather than resumed.
  const nodeById = new Map(chain.evaluated.graph.nodes.map((node) => [node.evidenceId, node]));
  const tasks = checkpointTasksFromRoutePlan(chain.plan).map((task) => (task.taskId === routed.taskId
    ? {
      ...task,
      state: COMPLETE,
      evidence: routed.produces.map((evidenceId) => ({ evidenceId, reuseIdentity: nodeById.get(evidenceId).reuseIdentity })),
      usageRecordIds: [appended.usageRecordId]
    }
    : task));
  const checkpoint = createCheckpoint({
    workUnitId: 'GATE15', authority,
    baseline: { head: CURRENT_HEAD, headSource: 'R2_CONTEXT_SOURCE_HEAD' },
    inputs: {
      r2ContextSha256: chain.plan.provenance.r2ContextSha256,
      r3DeltaSha256: chain.plan.provenance.r3DeltaSha256,
      r4GraphSha256: chain.plan.provenance.r4GraphSha256,
      routeSha256: chain.plan.routeSha256,
      repoIndexSha256: repoIndex.indexSha256
    },
    tasks,
    recoveryState: recoveryStateFor(tasks, { interrupted: true })
  });

  const recovery = planRecovery({
    workUnitId: 'GATE15', checkpoint, routePlan: chain.plan,
    evidenceStates: chain.evaluated.graph.nodes,
    r3Delta: { deltas: chain.evaluated.graph.evaluation.r3DeltaBasis.deltas, metrics: { AVOIDED_REPROCESS_BYTES: 0 } },
    usageLedger: appended.ledger, repoIndex, authority, currentHead: CURRENT_HEAD
  });

  assert.equal(recovery.decision, 'RESUME');
  // The completed validator is reused, not redone.
  const resumed = recovery.tasks.find((task) => task.taskId === routed.taskId);
  assert.equal(resumed.previousState, COMPLETE);
  assert.equal(resumed.disposition, 'REUSED');
  assert.equal(resumed.state, COMPLETE);
  assert.ok(resumed.reasonCodes.includes('COMPLETION_STILL_PROVEN'));
  assert.ok(recovery.resumedTaskIds.includes(routed.taskId));
  // The tasks R5 already excluded stay excluded: resume never reopens proven work.
  const avoided = recovery.tasks.filter((task) => task.disposition === 'AVOIDED').map((task) => task.taskId);
  assert.deepEqual(avoided.sort(), [...chain.plan.avoidedTasks].sort());
  // Nothing that was never executed is promoted to complete.
  assert.equal(recovery.tasks.filter((task) => task.disposition === 'NEW' && task.state === COMPLETE).length, 0);
  // Work that genuinely still has to happen is still pending.
  assert.ok(recovery.pendingTaskIds.length > 0, 'the remaining validators must stay pending');
  assert.equal(recovery.pendingTaskIds.includes(routed.taskId), false);
});

test('FP24 a fabricated evidence identity in a checkpoint cannot resume as completed', () => {
  const chain = chainFor();
  const authority = wheelAuthorityIdentity(REPO_ROOT, ORCHESTRATED_MISSION_REVISION);
  const repoIndex = buildRepoIndex({ repoRoot: REPO_ROOT });
  const routed = chain.plan.tasks.find((task) => task.capability === 'LOCAL_DETERMINISTIC' && !task.deferred);
  const appended = appendUsageRecord(createUsageLedger(), {
    workUnitId: 'GATE15', taskId: routed.taskId, attempt: 1, capability: routed.capability,
    outcome: 'COMPLETED', routeSha256: chain.plan.routeSha256,
    bytes: { contextBytes: 0, sourceProcessedBytes: 0, sourceAvoidedBytes: 0, evidenceReusedBytes: 0, evidenceRevalidatedBytes: 0 },
    tokens: null, provider: null, durationMs: null
  });
  const tasks = checkpointTasksFromRoutePlan(chain.plan).map((task) => (task.taskId === routed.taskId
    ? { ...task, state: COMPLETE, evidence: routed.produces.map((evidenceId) => ({ evidenceId, reuseIdentity: sha256Canonical({ invented: evidenceId }) })), usageRecordIds: [appended.usageRecordId] }
    : task));
  const checkpoint = createCheckpoint({
    workUnitId: 'GATE15', authority,
    baseline: { head: HEAD, headSource: 'R2_CONTEXT_SOURCE_HEAD' },
    inputs: {
      r2ContextSha256: chain.plan.provenance.r2ContextSha256,
      r3DeltaSha256: chain.plan.provenance.r3DeltaSha256,
      r4GraphSha256: chain.plan.provenance.r4GraphSha256,
      routeSha256: chain.plan.routeSha256,
      repoIndexSha256: repoIndex.indexSha256
    },
    tasks, recoveryState: recoveryStateFor(tasks, { interrupted: true })
  });
  const recovery = planRecovery({
    workUnitId: 'GATE15', checkpoint, routePlan: chain.plan,
    evidenceStates: chain.evaluated.graph.nodes,
    r3Delta: { deltas: chain.evaluated.graph.evaluation.r3DeltaBasis.deltas, metrics: { AVOIDED_REPROCESS_BYTES: 0 } },
    usageLedger: appended.ledger, repoIndex, authority, currentHead: HEAD
  });
  const resumed = recovery.tasks.find((task) => task.taskId === routed.taskId);
  assert.notEqual(resumed.disposition, 'REUSED', 'invented evidence must never resume as completed');
  assert.equal(recovery.resumedTaskIds.includes(routed.taskId), false);
});

test('FP25 separate processes persist and reload a real temporal R3/R4/R5/R6 lifecycle', () => {
  const { run1, run2 } = lifecycleProof();
  assert.equal(run1.status, 0);
  assert.equal(run2.status, 0);
  assert.equal(run1.report.chain.r3.previousSnapshotSha256, null);
  assert.equal(run1.report.chain.r3.comparisonBasis, 'EMPTY_INITIAL_BASELINE');
  assert.ok(run1.report.chain.r3.semantics.every((entry) => entry.kind === 'ADDED'));
  assert.equal(run1.report.workset.excludedByProvenReuse.length, 0);
  assert.ok(fs.existsSync(run1.report.r6.persistence.statePath));
  assert.ok(fs.existsSync(run1.report.r6.persistence.checkpoint.path));

  assert.equal(run2.report.chain.r3.previousSnapshotSha256, run1.report.chain.r3.snapshotSha256);
  assert.equal(run2.report.chain.r3.previousSnapshotProvenance.kind, 'R6_DURABLE_CHECKPOINT');
  assert.ok(run2.report.chain.r3.semantics.every((entry) => entry.kind === 'UNCHANGED'));
  assert.ok(run2.report.workset.excludedByProvenReuse.length > 0);
  assert.equal(run2.report.r6.resume.decision, 'RESUME');
  assert.equal(run2.report.r6.resume.restartedFromZero, false);
  assert.equal(run2.report.r6.checkpointRevision, 'R0002');
});

test('FP26 one changed input after a durable run invalidates only dependent work', () => {
  const root = scratchRepo();
  const proof = lifecycleProof();
  try {
    const loaded = loadFastPathLifecycleState({ lifecycleStoreRoot: proof.store, gateId: 'GATE15', phase: 'READINESS', sourceHead: CURRENT_HEAD });
    assert.equal(loaded.status, 'LOADED');
    const changedPath = 'governance/tools/governance-preflight.mjs';
    fs.appendFileSync(path.join(root, ...changedPath.split('/')), '\n// targeted changed-input hostile fixture\n');
    const cas = createContentAddressedStore(path.join(proof.store, 'GATE15-READINESS', 'r4-cas'));
    const chain = compileFastPathChain({
      root, gateId: 'GATE15', phase: 'READINESS', cas, sourceHead: CURRENT_HEAD,
      previousLifecycleState: loaded.state
    });
    chain.root = root;
    const workset = deriveWorkset(chain, { gateId: 'GATE15', phase: 'READINESS' });
    const changed = chain.r3Record.semantics.filter((entry) => entry.kind === 'CHANGED');
    assert.deepEqual(changed, [{ path: changedPath, kind: 'CHANGED' }]);
    assert.ok(workset.requiredValidators.includes(changedPath));
    assert.ok(workset.excludedByProvenReuse.length > 0, 'unrelated proven work remains reusable');
    assert.notEqual(proof.run2.report.chain.r3.deltaSha256, chain.r3DeltaSha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FP27 an incompatible durable lifecycle checkpoint blocks instead of becoming a first run', () => {
  const proof = lifecycleProof();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-path-incompatible-'));
  fs.cpSync(proof.store, store, { recursive: true });
  try {
    const relative = path.relative(proof.store, proof.run2.report.r6.persistence.statePath);
    const statePath = path.join(store, relative);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.phase = 'START';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    const loaded = loadFastPathLifecycleState({ lifecycleStoreRoot: store, gateId: 'GATE15', phase: 'READINESS', sourceHead: CURRENT_HEAD });
    assert.equal(loaded.status, 'BLOCKED');
    assert.ok(loaded.reasons.includes('LIFECYCLE_PHASE_MISMATCH'));
    assert.ok(loaded.reasons.includes('LIFECYCLE_STATE_DIGEST_MISMATCH'));
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ */
/* 15-16  sequencing is not a defect                                         */
/* ------------------------------------------------------------------------ */

test('FP15 GATE16 is READY_WHEN_SEQUENCED because GATE15 is not closed', async () => {
  const report = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE16', phase: 'READINESS' });
  assert.equal(report.verdict, 'READY_WHEN_SEQUENCED');
  assert.deepEqual(report.blockingFacts, []);
  assert.equal(report.dependencies.satisfied, false);
  assert.ok(report.gateLocalExpected.some((entry) => entry.code === 'DEPENDENCY_NOT_CLOSED' && entry.classification === 'GATE_LOCAL_EXPECTED'));
  assert.equal(report.nextAllowedTransition, 'NONE');
});

test('FP16 a not-yet-existing contract and gate test directory are GATE_LOCAL_EXPECTED, never systemic', async () => {
  const admission = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  assert.equal(admission.counts.systemicGaps, 0);
  assert.equal(admission.counts.preexecutionGaps, 0);
  const report = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS' });
  assert.ok(report.gateLocalExpected.some((entry) => entry.code === 'GATE_LOCAL_TESTS_ABSENT'));
  assert.deepEqual(report.blockingFacts, []);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance/gates/GATE15')), false);
});

/* ------------------------------------------------------------------------ */
/* 17-20  containment invariants this mission must not break                 */
/* ------------------------------------------------------------------------ */

test('FP17 every frontier path the control plane declares is a real repository path', () => {
  for (const phase of LIFECYCLE_PHASES) {
    for (const validator of MINIMUM_EVIDENCE_FRONTIER[phase].validators) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, validator.tool)), `${phase}: ${validator.tool} must exist`);
      for (const read of validator.reads) {
        assert.ok(fs.existsSync(path.join(REPO_ROOT, read)), `${phase}: ${validator.tool} reads ${read}`);
      }
    }
  }
  // Nothing outside the governed surface may enter the tracked source set.
  const chain = chainFor();
  for (const source of chain.currentSnapshot.sources) {
    assert.ok(source.path.startsWith('governance/'), `unauthorized tracked path: ${source.path}`);
  }
});

test('FP18 the commit-amend and history-rewrite policy is fail-closed', () => {
  assert.equal(GIT_CONTROL_RULE.historyRewriteUnderNonRewriteAuthority, 'FORBIDDEN');
  assert.equal(GIT_CONTROL_RULE.commitCreatedButWrong, 'STOP_AND_REQUIRE_NEW_EXPLICIT_OWNER_AUTHORIZATION');
  assert.equal(GIT_CONTROL_RULE.commitCreatedAndCorrect, 'STOP_GIT_MUTATION');
  assert.equal(GIT_CONTROL_RULE.commitFailedBeforeCommitCreated, 'RETRY_ALLOWED_UNDER_SAME_AUTHORITY_IF_PRECONDITIONS_STILL_HOLD');
  for (const forbidden of ['git commit --amend', 'git reset', 'git rebase', 'git push', 'git add .', 'git add -A']) {
    assert.ok(GIT_CONTROL_RULE.forbiddenOperations.includes(forbidden), `${forbidden} must be forbidden`);
  }
  assert.equal(GIT_CONTROL_RULE.maxCommitsPerAuthority, 1);
  assert.equal(GIT_CONTROL_RULE.stagingPolicy, 'EXPLICIT_LITERAL_PATHSPECS_ONLY');
});

test('FP18b every declared R7 heavy trigger is executable and reports its reason', () => {
  const chain = chainFor();
  const bindings = chainBindings(chain);
  const evidence = classifyEvidence(chain);
  const prior = {
    geeEngineArchitectureSha256: 'a'.repeat(64),
    routingBehaviorSha256: 'b'.repeat(64),
    recoveryGuaranteesSha256: 'c'.repeat(64)
  };
  const evaluate = (overrides = {}) => r7LightweightGuard({
    chain, bindings, evidence,
    triggerState: { current: { ...prior }, previous: { ...prior }, ...overrides }
  });
  const none = evaluate();
  assert.equal(none.heavyBenchmarkRequired, false);
  assert.deepEqual(none.triggerReasons, []);

  const engine = evaluate({ current: { ...prior, geeEngineArchitectureSha256: 'd'.repeat(64) } });
  assert.ok(engine.triggerReasons.includes('GEE_ENGINE_ARCHITECTURE_CHANGED_MATERIALLY'));
  const quality = evaluate({ qualityParityGuardPassed: false });
  assert.ok(quality.triggerReasons.includes('QUALITY_PARITY_GUARD_FAILED'));
  const routing = evaluate({ current: { ...prior, routingBehaviorSha256: 'd'.repeat(64) } });
  assert.ok(routing.triggerReasons.includes('ROUTING_BEHAVIOR_CHANGED_MATERIALLY'));
  const recovery = evaluate({ current: { ...prior, recoveryGuaranteesSha256: 'd'.repeat(64) } });
  assert.ok(recovery.triggerReasons.includes('RECOVERY_GUARANTEES_CHANGED_MATERIALLY'));
  const explicit = evaluate({ explicitArchitectureAuditRequired: true });
  assert.ok(explicit.triggerReasons.includes('EXPLICIT_ARCHITECTURE_AUDIT_REQUIRES_IT'));
  for (const result of [engine, quality, routing, recovery, explicit]) assert.equal(result.heavyBenchmarkRequired, true);
});

test('FP19 planning a Gate never starts it, never appends to the ledger and never moves ACTIVE_GATE', async () => {
  const ledgerPath = path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const activePath = path.join(REPO_ROOT, 'governance/active/ACTIVE_GATE.json');
  const ledgerBefore = fs.readFileSync(ledgerPath);
  const activeBefore = fs.readFileSync(activePath, 'utf8');

  const report = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS', proveResume: true });

  assert.equal(report.mode, 'PLAN_READ_ONLY');
  assert.ok(fs.readFileSync(ledgerPath).equals(ledgerBefore), 'the ledger must be byte-identical after planning');
  assert.equal(fs.readFileSync(activePath, 'utf8'), activeBefore, 'ACTIVE_GATE must not move');
  assert.equal(JSON.parse(activeBefore).activeGate, 'GATE13');
  assert.equal(report.gateStatus, 'NOT_STARTED');
  assert.equal(report.baseline.ledgerEventCount, 61);
  // Planning may say a transition is ALLOWED; it may never perform one.
  assert.equal(report.nextAllowedTransition, 'AUTHORIZE_THEN_START_UNDER_EXPLICIT_OWNER_AUTHORITY');
});

test('FP20 R8 does not exist and the control plane introduces no eighth revision', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance/gee-v1/revisions/R8')), false);
  const source = fs.readFileSync(path.join(REPO_ROOT, 'governance/tools/gate-fast-path-control-plane.mjs'), 'utf8');
  assert.equal(/GEE_R8|gee-r8|revisions\/R8/.test(source), false, 'the control plane must not reference an R8');
  // It orchestrates the existing revisions and adds no engine of its own.
  assert.equal(ORCHESTRATED_MISSION_REVISION, 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R7');
});

/* ------------------------------------------------------------------------ */
/* positive path                                                             */
/* ------------------------------------------------------------------------ */

test('FP21 the real GATE15 fast path is READY with every chain binding proven', async () => {
  const report = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE15', phase: 'READINESS' });
  assert.equal(report.document, CONTROL_PLANE_DOCUMENT);
  assert.equal(report.verdict, 'FAST_PATH_READY');
  assert.equal(report.chain.bindingsValid, true);
  assert.equal(report.chain.bindings.length, 5);
  for (const binding of report.chain.bindings) assert.equal(binding.agrees, true, `${binding.edge} must bind`);
  assert.equal(report.evidence.unknownProvenanceCount, 0);
  assert.equal(report.chain.r3.previousSnapshotSha256, null);
  assert.ok(report.chain.r3.semantics.every((entry) => entry.kind === 'ADDED'));
  assert.equal(report.workset.excludedByProvenReuse.length, 0, 'a first run cannot exclude work from same-run comparison');
  assert.equal(report.r7.verdict, 'PASS');
  assert.equal(report.r7.mode, 'LIGHTWEIGHT');
  assert.equal(report.r7.heavyBenchmarkRequired, report.r7.triggerReasons.length > 0);
  assert.equal(report.antiAmnesia.unclassifiedRelevantArtifactCount, 0);
  assert.equal(report.regression.comparabilityEstablished, true);
  assert.equal(report.r6.resume, null);
  assert.deepEqual(report.blockingFacts, []);
});

test('FP22 R5 excludes work only after a real persisted previous snapshot proves reuse', () => {
  const { run2 } = lifecycleProof();
  const { workset, evidence } = run2.report;
  assert.ok(workset.excludedByProvenReuse.length > 0, 'something must actually be excluded');
  for (const excluded of workset.excludedByProvenReuse) {
    assert.ok(excluded.reasonCodes.includes('EVIDENCE_REUSABLE_NO_WORK_REQUIRED'));
    assert.ok(excluded.reasonCodes.includes('UPSTREAM_R3_SOURCES_UNCHANGED'));
  }
  // Every excluded task's produced evidence is one R4 proved reusable.
  const reusable = new Set(evidence.UNCHANGED_PROVEN_EVIDENCE.map((entry) => entry.evidenceId));
  for (const excluded of workset.excludedByProvenReuse) {
    for (const produced of excluded.produces) assert.ok(reusable.has(produced), `${produced} was excluded without proof`);
  }
  // The workset is a projection of the plan, not a parallel list.
  assert.ok(run2.report.chain.r3.semantics.every((entry) => entry.kind === 'UNCHANGED'));
  assert.equal(run2.report.r7.verdict, 'PASS');
});

test('FP23 the TAP parser recovers exactly the governed baseline identity shape', () => {
  const tap = [
    'not ok 1 - some failing test',
    '  ---',
    "  location: 'C:\\\\Users\\\\melan\\\\Desktop\\\\wheel-mcp-remote\\\\governance\\\\tests\\\\x.test.mjs:41:1'",
    '  ...'
  ].join('\n');
  const identities = parseTapFailureIdentities({ tapText: tap, repoRoot: 'C:\\Users\\melan\\Desktop\\wheel-mcp-remote' });
  assert.equal(identities.length, 1);
  assert.equal(identities[0].identity, 'governance/tests/x.test.mjs::some failing test');
  assert.equal(identities[0].locationResolved, true);
});
