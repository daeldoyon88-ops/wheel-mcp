/**
 * GEE V1 R5: router, cost/quality policy and repair containment.
 *
 * R5-T01..R5-T28 are the mission's targeted cases; R5-H* are the additional
 * hostile, structural and end-to-end cases. Every case is deterministic, local
 * and offline.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createContentAddressedStore } from '../cas/content-addressed-store.mjs';
import { bindFreshValidations, createEvidenceGraph } from '../evidence/evidence-graph.mjs';
import { compareSnapshots, createSnapshot } from '../delta/delta-engine.mjs';
import { compileContext } from '../context/compile-context.mjs';
import { createGeeR2SyntheticAdapter } from '../fixtures/gee-r2-synthetic-adapter.mjs';
import { routePlanSha256, routeWorkUnit, validateRoutePlan, verifyRoutePlanDigest } from '../router/router-engine.mjs';
import { DEFAULT_ROUTER_POLICY, validateRouterPolicy } from '../router/router-policy.mjs';
import { createProviderMapping, resolveProviders, DEFAULT_PROVIDER_MAPPING } from '../router/provider-adapter.mjs';
import {
  appendRepairRecord, createRepairLedger, evaluateContainment, parseRepairLedger, rootCauseResolutionAssertion,
  serializeRepairLedger, verifyRepairLedger, RESOLVED, ROOT_CAUSE_ANALYSIS, STRUCTURAL, SURVIVED
} from '../repair/repair-containment.mjs';
import { routeWheelWorkUnit } from '../adapters/wheel/router-wheel-adapter.mjs';
import { createGeeMissionAuthoritySource, MISSION_WORK_UNIT_TYPE } from '../adapters/gee-mission-authority-source.mjs';
import { createExecutionAuthorityRegistry, isPathAuthorized, resolveExecutionAuthority } from '../core/work-unit-core.mjs';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CANONICAL_HEAD = 'a5e6588c1c7a80c9d567a5248b0c2308c2f2a4ce';
const PASS = Object.freeze({ validator: 'TEST_PRODUCING_VALIDATOR', result: 'PASS' });

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r5-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":1}');
  fs.writeFileSync(path.join(root, 'fixtures', 'canonical.json'), '{"canonical":true}');
  return root;
}

function casFor(root) { return createContentAddressedStore(path.join(root, 'cas')); }

function contextFor(root) {
  return compileContext({ repoRoot: root, adapter: createGeeR2SyntheticAdapter(), workUnitId: 'SYNTH_01', sourceHead: 'SYNTHETIC_HEAD' }).json;
}

const SOURCE_PATHS = ['fixtures/canonical.json', 'src/a.json', 'src/b.json'];

function snapshotOf(root) {
  return createSnapshot({ repoRoot: root, sources: SOURCE_PATHS.filter((p) => fs.existsSync(path.join(root, ...p.split('/')))).map((p) => ({ path: p })) });
}

/** Previous/current snapshot pair, optionally with a real mutation in between. */
function deltaOf(root, mutate = null) {
  const previousSnapshot = snapshotOf(root);
  if (mutate) mutate();
  return { previousSnapshot, currentSnapshot: snapshotOf(root) };
}

function rawNodes() {
  return [
    { evidenceId: 'e:a', content: { value: 'a' }, evidenceType: 'FACT', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: 'e:b', content: { value: 'b' }, evidenceType: 'FACT', provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/b.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: 'e:summary', content: { summary: 'ab' }, evidenceType: 'SUMMARY', provenance: { sourcePath: 'fixtures/canonical.json', authorityClass: 'CANONICAL' }, dependencies: ['evidence:e:a', 'evidence:e:b'], authorityStatus: 'GROUNDED' }
  ];
}

/**
 * Graph bound to an UNCHANGED basis, which is how genuine prior evidence looks:
 * it was validated when the sources were in their previous state. Evaluating it
 * against a later delta is what makes reuse or invalidation real.
 */
function baseline(root, cas) {
  const unchanged = deltaOf(root);
  const bound = bindFreshValidations({
    cas,
    nodes: rawNodes(),
    r3Delta: unchanged,
    validationResults: Object.fromEntries(rawNodes().map((node) => [node.evidenceId, PASS]))
  });
  return { unchanged, graph: createEvidenceGraph({ cas, nodes: bound }) };
}

function verifyTask(taskId, sourcePath, evidenceId, extra = {}) {
  return { taskId, intent: 'DETERMINISTIC', sources: sourcePath ? [sourcePath] : [], produces: [evidenceId], requiredEvidenceIds: [evidenceId], ...extra };
}

function defaultTasks() {
  return [
    verifyTask('t:a', 'src/a.json', 'e:a'),
    verifyTask('t:b', 'src/b.json', 'e:b'),
    verifyTask('t:summary', null, 'e:summary')
  ];
}

/**
 * Bare producers for evidence a scenario invalidates. R5 refuses to route while
 * R4 reports revalidation work no declared task can perform, so a case that is
 * about something else still has to declare who would do that work.
 */
function producersFor(...evidenceIds) {
  return evidenceIds.map((evidenceId) => ({ taskId: `t:produce:${evidenceId}`, intent: 'DETERMINISTIC', produces: [evidenceId] }));
}

/**
 * The synthetic R2 adapter compiles a context for SYNTH_01, so that is the work
 * unit these cases route: the router requires the two identities to agree.
 */
const SYNTHETIC_WORK_UNIT = 'SYNTH_01';

function route(root, cas, { tasks = defaultTasks(), delta, graph, previousGraph = null, repairLedger, policy, r2Context, workUnitId = SYNTHETIC_WORK_UNIT } = {}) {
  return routeWorkUnit({
    workUnitId,
    tasks,
    r2Context: r2Context === undefined ? contextFor(root) : r2Context,
    r3Delta: delta,
    r4Evidence: { graph, previousGraph },
    cas,
    repairLedger,
    policy
  });
}

function taskOf(plan, taskId) { return plan.tasks.find((task) => task.taskId === taskId); }

/** Unchanged-replay scenario: nothing on disk moved since the evidence was validated. */
function unchangedScenario() {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  return { root, cas, base, delta: base.unchanged, graph: base.graph };
}

/** One real source mutation after the evidence was validated. */
function mutatedBScenario() {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = deltaOf(root, () => fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":999}'));
  return { root, cas, base, delta, graph: base.graph };
}

/* ---------------------------------------------------------------- ROUTING */

test('R5-T01 all evidence reusable with no changes routes no work at all', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph });
  assert.equal(plan.routeDecision, 'NO_WORK_REQUIRED');
  assert.deepEqual(plan.avoidedTasks, ['t:a', 't:b', 't:summary']);
  assert.deepEqual(plan.deterministicTasks, []);
  assert.deepEqual(plan.reasoningTasks, []);
  assert.deepEqual(plan.deepReasoningTasks, []);
  assert.deepEqual(plan.revalidationRequiredEvidenceIds, []);
  assert.deepEqual(plan.reusableEvidenceIds, ['e:a', 'e:b', 'e:summary']);
});

test('R5-T02 one changed deterministic source routes only the affected work', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.deepEqual(plan.avoidedTasks, ['t:a']);
  assert.deepEqual(plan.deterministicTasks, ['t:b', 't:summary']);
  assert.equal(plan.routeDecision, 'LOCAL_DETERMINISTIC');
  assert.deepEqual(plan.revalidationRequiredEvidenceIds, ['e:b', 'e:summary']);
  assert.ok(taskOf(plan, 't:summary').reasonCodes.includes('EVIDENCE_REVALIDATION_REQUIRED'));
});

test('R5-T03 a small bounded semantic defect routes to standard reasoning', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [{ taskId: 't:defect', intent: 'SEMANTIC', description: 'Fix a known localized defect', sources: ['src/a.json'], uncertainty: 'LOW', architectureImpact: 'LOCAL' }]
  });
  assert.equal(plan.routeDecision, 'STANDARD_REASONING');
  assert.deepEqual(plan.reasoningTasks, ['t:defect']);
  assert.deepEqual(taskOf(plan, 't:defect').reasonCodes, ['BOUNDED_SEMANTIC_WORK']);
});

test('R5-T04 an explicit architecture contradiction routes to deep reasoning', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [{
      taskId: 't:contradiction',
      intent: 'SEMANTIC',
      sources: ['src/a.json'],
      contradiction: { statement: 'two trusted sources disagree on the canonical status', sources: ['src/a.json', 'src/b.json'] }
    }]
  });
  assert.equal(plan.routeDecision, 'DEEP_REASONING');
  assert.deepEqual(plan.deepReasoningTasks, ['t:contradiction']);
  assert.deepEqual(plan.qualityRequirements.contradictionTaskIds, ['t:contradiction']);
});

test('R5-T05 required evidence that does not exist blocks instead of passing', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [{ taskId: 't:needs-missing', intent: 'DETERMINISTIC', sources: ['src/a.json'], requiredEvidenceIds: ['e:absent'] }]
  });
  assert.equal(plan.routeDecision, 'BLOCKED');
  assert.deepEqual(plan.blockedTasks, ['t:needs-missing']);
  assert.deepEqual(taskOf(plan, 't:needs-missing').blockedBy, ['REQUIRED_EVIDENCE_MISSING:e:absent']);
  assert.equal(plan.qualityRequirements.qualityFloorEnforced, true);
});

test('R5-T06 an unrelated evidence branch stays reused when another source changes', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.ok(plan.reusableEvidenceIds.includes('e:a'));
  assert.equal(taskOf(plan, 't:a').capability, 'NO_WORK_REQUIRED');
  assert.equal(taskOf(plan, 't:a').reprocessBytes, 0);
});

test('R5-T07 identical canonical inputs produce an identical route digest', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const first = route(root, cas, { delta, graph });
  const second = route(root, cas, { delta, graph });
  assert.equal(first.routeSha256, second.routeSha256);
  // Task order supplied by the caller is not part of route identity.
  const reordered = route(root, cas, { delta, graph, tasks: [...defaultTasks()].reverse() });
  assert.equal(reordered.routeSha256, first.routeSha256);
});

test('R5-T08 a JSON round-trip of every input reproduces the same route', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const direct = route(root, cas, { delta, graph });
  const revived = route(root, cas, {
    delta: JSON.parse(JSON.stringify(delta)),
    graph: JSON.parse(JSON.stringify(graph)),
    tasks: JSON.parse(JSON.stringify(defaultTasks())),
    r2Context: JSON.parse(JSON.stringify(contextFor(root)))
  });
  assert.equal(revived.routeSha256, direct.routeSha256);
  assert.equal(routePlanSha256(JSON.parse(JSON.stringify(direct))), direct.routeSha256);
});

test('R5-T09 a separate process computes the same route digest', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const local = route(root, cas, { delta, graph });
  const payload = path.join(root, 'payload.json');
  fs.writeFileSync(payload, JSON.stringify({
    casRoot: path.join(root, 'cas'),
    workUnitId: SYNTHETIC_WORK_UNIT,
    tasks: defaultTasks(),
    r2Context: contextFor(root),
    r3Delta: delta,
    graph
  }));
  const runner = path.join(root, 'runner.mjs');
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const router = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/router/router-engine.mjs'))}).href);
const cas = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/cas/content-addressed-store.mjs'))}).href);
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, 'utf8'));
const plan = router.routeWorkUnit({
  workUnitId: payload.workUnitId,
  tasks: payload.tasks,
  r2Context: payload.r2Context,
  r3Delta: payload.r3Delta,
  r4Evidence: { graph: payload.graph },
  cas: cas.createContentAddressedStore(payload.casRoot)
});
process.stdout.write(JSON.stringify({ routeSha256: plan.routeSha256, routeDecision: plan.routeDecision, deterministicTasks: plan.deterministicTasks }));
`);
  const observed = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }));
  assert.equal(observed.routeSha256, local.routeSha256);
  assert.equal(observed.routeDecision, 'LOCAL_DETERMINISTIC');
  assert.deepEqual(observed.deterministicTasks, ['t:b', 't:summary']);
});

/* ----------------------------------------------------------- COST/QUALITY */

test('R5-T10 total reuse reports avoided work honestly and reprocesses nothing', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph });
  const totalBytes = delta.currentSnapshot.sources.reduce((sum, source) => sum + source.bytes, 0);
  assert.equal(plan.metrics.R3_REPROCESS_BYTES, 0);
  assert.equal(plan.metrics.R3_AVOIDED_REPROCESS_BYTES, totalBytes);
  assert.equal(plan.metrics.R3_UNCHANGED_BYTES, totalBytes);
  assert.equal(plan.metrics.R4_REUSABLE_NODES, 3);
  assert.equal(plan.metrics.R4_REVALIDATION_REQUIRED_NODES, 0);
  assert.equal(plan.metrics.R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE, 3);
  assert.equal(plan.metrics.R5_TASK_REPROCESS_BYTES, 0);
  assert.ok(plan.metrics.R5_TASK_AVOIDED_BYTES > 0);
});

test('R5-T11 partial invalidation counts only the affected work', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  const changedBytes = delta.currentSnapshot.sources.find((source) => source.path === 'src/b.json').bytes;
  assert.equal(plan.metrics.R3_CHANGED_BYTES, changedBytes);
  assert.equal(plan.metrics.R3_REPROCESS_BYTES, changedBytes);
  assert.equal(plan.metrics.R4_REUSABLE_NODES, 1);
  assert.equal(plan.metrics.R4_REVALIDATION_REQUIRED_NODES, 2);
  assert.equal(taskOf(plan, 't:a').reprocessBytes, 0);
  assert.equal(taskOf(plan, 't:b').reprocessBytes > 0, true);
});

test('R5-T12 no token count is fabricated anywhere in the plan', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.equal(plan.metrics.TOKEN_MEASUREMENT, 'TOKEN_COUNT_UNAVAILABLE');
  const offenders = [];
  const walk = (value, pointer) => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${pointer}/${index}`)); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/token/i.test(key) && child !== 'TOKEN_COUNT_UNAVAILABLE') offenders.push(`${pointer}/${key}`);
      walk(child, `${pointer}/${key}`);
    }
  };
  walk(plan, '');
  assert.deepEqual(offenders, []);
});

test('R5-T13 a cost ceiling defers discretionary work but never mandatory validation', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const policy = { ...DEFAULT_ROUTER_POLICY, costCeiling: 'VERY_LOW' };
  // Both tasks are equally expensive and equally deep. The only difference is
  // that one is a mandatory validation, so only the other may be deferred.
  const deepButDiscretionary = { intent: 'SEMANTIC', architectureImpact: 'MULTI_LAYER' };
  const plan = route(root, cas, {
    delta,
    graph,
    policy,
    tasks: [
      { taskId: 't:mandatory-deep', ...deepButDiscretionary, sources: ['src/a.json'], mandatory: true },
      { taskId: 't:optional-deep', ...deepButDiscretionary, sources: ['src/b.json'] }
    ]
  });
  const mandatory = taskOf(plan, 't:mandatory-deep');
  assert.equal(mandatory.capability, 'DEEP_REASONING');
  assert.equal(mandatory.deferred, false);
  assert.ok(mandatory.reasonCodes.includes('MANDATORY_VALIDATION_EXEMPT_FROM_COST_CEILING'));
  const optional = taskOf(plan, 't:optional-deep');
  assert.equal(optional.deferred, true);
  assert.ok(optional.reasonCodes.includes('COST_CEILING_EXCEEDED_DEFERRED'));
  assert.deepEqual(plan.deepReasoningTasks, ['t:mandatory-deep']);
  assert.deepEqual(plan.deferredTasks, ['t:optional-deep']);
});

test('R5-T14 the quality floor overrides the cheap route when required evidence is missing', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  // Everything this task produces is reusable, so the cheap route would be
  // NO_WORK_REQUIRED. A required evidence node that does not exist must win.
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [verifyTask('t:cheap-but-unproven', 'src/a.json', 'e:a', { requiredEvidenceIds: ['e:a', 'e:absent'] })]
  });
  const task = taskOf(plan, 't:cheap-but-unproven');
  assert.equal(task.capability, 'BLOCKED');
  assert.ok(task.reasonCodes.includes('QUALITY_FLOOR_BLOCKS_EXECUTION'));
  assert.deepEqual(plan.avoidedTasks, []);
  assert.equal(plan.routeDecision, 'BLOCKED');
});

test('R5-T13b a mandatory validation still runs when reuse alone would have skipped it', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, tasks: [verifyTask('t:must-run', 'src/a.json', 'e:a', { mandatory: true })] });
  const task = taskOf(plan, 't:must-run');
  assert.equal(task.capability, 'LOCAL_DETERMINISTIC');
  assert.ok(task.reasonCodes.includes('MANDATORY_VALIDATION_RUNS_DESPITE_AVAILABLE_REUSE'));
  assert.deepEqual(plan.avoidedTasks, []);
});

/* ------------------------------------------------------ REPAIR CONTAINMENT */

const DEFECT = { defectId: 'DEF-1', rootCauseClass: 'RC-UNITS-MISMATCH' };

function survived(ledger, overrides = {}) {
  return appendRepairRecord(ledger, { ...DEFECT, outcome: SURVIVED, evidenceRef: 'test://attempt', scope: ['src/a.json'], ...overrides });
}

function repairTask(taskId, overrides = {}) {
  return { taskId, intent: 'SEMANTIC', sources: ['src/a.json'], repair: { ...DEFECT, incremental: true }, ...overrides };
}

test('R5-T15 a first targeted repair attempt is allowed', () => {
  const ledger = createRepairLedger();
  const containment = evaluateContainment(ledger, DEFECT.rootCauseClass);
  assert.equal(containment.lineageState, 'NORMAL');
  assert.equal(containment.nextAttemptState, 'TARGETED_REPAIR_1');
  assert.equal(containment.nextTargetedAttemptOrdinal, 1);
  assert.equal(containment.incrementalPatchAuthorized, true);

  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [repairTask('t:patch-1')] });
  assert.equal(taskOf(plan, 't:patch-1').capability, 'STANDARD_REASONING');
  assert.equal(taskOf(plan, 't:patch-1').containmentState, 'TARGETED_REPAIR_1');
  assert.equal(plan.repairContainment.stopPatchCascade, false);
});

test('R5-T16 the same defect surviving one attempt still allows a second', () => {
  const ledger = survived(createRepairLedger());
  const containment = evaluateContainment(ledger, DEFECT.rootCauseClass);
  assert.equal(containment.survivedTargetedAttempts, 1);
  assert.equal(containment.containmentCount, 1);
  assert.equal(containment.lineageState, 'TARGETED_REPAIR_1');
  assert.equal(containment.nextAttemptState, 'TARGETED_REPAIR_2');
  assert.equal(containment.nextTargetedAttemptOrdinal, 2);
  assert.equal(containment.incrementalPatchAuthorized, true);

  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [repairTask('t:patch-2')] });
  assert.equal(taskOf(plan, 't:patch-2').capability, 'STANDARD_REASONING');
  assert.equal(taskOf(plan, 't:patch-2').containmentState, 'TARGETED_REPAIR_2');
});

test('R5-T17 the same defect surviving two attempts stops the patch cascade', () => {
  const ledger = survived(survived(createRepairLedger()));
  const containment = evaluateContainment(ledger, DEFECT.rootCauseClass);
  assert.equal(containment.survivedTargetedAttempts, 2);
  assert.equal(containment.containmentCount, 2);
  assert.equal(containment.lineageState, 'STOP_PATCH_CASCADE');
  assert.equal(containment.incrementalPatchAuthorized, false);
  // Structural repair is not authorized yet either: the stop asks for the
  // analysis first, otherwise relabelling the patch would escape containment.
  assert.equal(containment.structuralRepairAuthorized, false);
  assert.equal(containment.structuralRepairObstacle, 'ROOT_CAUSE_ANALYSIS_REQUIRED_BEFORE_STRUCTURAL_REPAIR');
  assert.equal(containment.requiredNextAction, 'ROOT_CAUSE_ANALYSIS');
  assert.equal(containment.reasonCode, 'SAME_ROOT_CAUSE_UNRESOLVED_AFTER_2_TARGETED_REPAIRS');
});

test('R5-T18 a third incremental patch for the same unresolved root cause is blocked', () => {
  const ledger = survived(survived(createRepairLedger()));
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [repairTask('t:patch-3')] });
  const task = taskOf(plan, 't:patch-3');
  assert.equal(task.capability, 'BLOCKED');
  assert.equal(task.containmentState, 'STOP_PATCH_CASCADE');
  assert.deepEqual(task.blockedBy, [`REPAIR_CONTAINMENT_STOP_PATCH_CASCADE:${DEFECT.rootCauseClass}`]);
  assert.equal(plan.routeDecision, 'BLOCKED');
  assert.equal(plan.repairContainment.stopPatchCascade, true);
});

test('R5-T19 an independent new defect is not swept into an existing cascade', () => {
  const ledger = survived(survived(createRepairLedger()));
  const independent = { defectId: 'DEF-2', rootCauseClass: 'RC-CACHE-STALENESS' };
  assert.equal(evaluateContainment(ledger, independent.rootCauseClass).lineageState, 'NORMAL');

  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: ledger,
    tasks: [repairTask('t:contained'), { taskId: 't:independent', intent: 'SEMANTIC', sources: ['src/b.json'], repair: { ...independent, incremental: true } }]
  });
  assert.equal(taskOf(plan, 't:contained').capability, 'BLOCKED');
  assert.equal(taskOf(plan, 't:independent').capability, 'STANDARD_REASONING');
  assert.equal(taskOf(plan, 't:independent').containmentState, 'TARGETED_REPAIR_1');
});

test('R5-T20 identical symptoms with distinct proven root causes stay separate lineages', () => {
  const symptom = 'weeklyYield reported as zero';
  let ledger = createRepairLedger();
  ledger = appendRepairRecord(ledger, { defectId: 'DEF-A', rootCauseClass: 'RC-FEED-UNITS', symptom, outcome: SURVIVED, evidenceRef: 'test://a1' });
  ledger = appendRepairRecord(ledger, { defectId: 'DEF-A', rootCauseClass: 'RC-FEED-UNITS', symptom, outcome: SURVIVED, evidenceRef: 'test://a2' });
  ledger = appendRepairRecord(ledger, { defectId: 'DEF-B', rootCauseClass: 'RC-GRADE-SOURCE', symptom, outcome: SURVIVED, evidenceRef: 'test://b1' });
  assert.equal(evaluateContainment(ledger, 'RC-FEED-UNITS').incrementalPatchAuthorized, false);
  assert.equal(evaluateContainment(ledger, 'RC-GRADE-SOURCE').incrementalPatchAuthorized, true);
  assert.equal(evaluateContainment(ledger, 'RC-GRADE-SOURCE').survivedTargetedAttempts, 1);
});

test('R5-T21 root-cause analysis after containment routes to deep reasoning', () => {
  const ledger = survived(survived(createRepairLedger()));
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: ledger,
    tasks: [{ taskId: 't:root-cause', intent: 'ROOT_CAUSE_ANALYSIS', sources: ['src/a.json'], repair: { ...DEFECT, incremental: false } }]
  });
  const task = taskOf(plan, 't:root-cause');
  assert.equal(task.capability, 'DEEP_REASONING');
  assert.ok(task.reasonCodes.includes('ROOT_CAUSE_ANALYSIS_REQUIRED_AFTER_CONTAINMENT'));
  assert.equal(task.containmentState, 'STOP_PATCH_CASCADE');
  assert.equal(plan.repairContainment.lineages[0].requiredNextAction, 'ROOT_CAUSE_ANALYSIS');
});

/* ------------------------------------------------- SECURITY / INTEGRITY */

test('R5-T22 a fabricated R3 delta is rejected by R3 verification', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  for (const [forged, pattern] of [
    [{ ...delta, deltas: [{ path: 'src/b.json', kind: 'UNCHANGED', previousSha256: null, currentSha256: '0'.repeat(64), bytes: 1 }] }, /FABRICATED_R3_DELTA/],
    [{ previousSnapshot: delta.previousSnapshot, currentSnapshot: { ...delta.currentSnapshot, snapshotSha256: '0'.repeat(64) } }, /INVALID_R3_INPUT/],
    [{ previousSnapshot: null, currentSnapshot: delta.currentSnapshot }, /INVALID_R3_INPUT/]
  ]) {
    assert.throws(() => route(root, cas, { delta: forged, graph }), pattern);
  }
});

test('R5-T23 a fabricated or unverified R4 graph is rejected', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  assert.throws(() => route(root, cas, { delta, graph: { ...graph, graphSha256: '0'.repeat(64) } }), /INVALID_R4_INPUT/);
  // A caller claiming everything is still reusable after a real mutation.
  assert.throws(
    () => routeWorkUnit({
      workUnitId: SYNTHETIC_WORK_UNIT,
      tasks: defaultTasks(),
      r2Context: contextFor(root),
      r3Delta: delta,
      r4Evidence: { graph, reusableNodes: graph.nodes.map((node) => node.evidenceId) },
      cas
    }),
    /FABRICATED_R4_EVALUATION/
  );
  assert.throws(() => route(root, cas, { delta, graph: undefined }), /INVALID_R4_INPUT:EVIDENCE_GRAPH_REQUIRED/);
});

test('R5-T24 duplicate canonical task or produced-evidence identifiers are rejected', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  assert.throws(() => route(root, cas, { delta, graph, tasks: [verifyTask('t:a', 'src/a.json', 'e:a'), verifyTask('t:a', 'src/b.json', 'e:b')] }), /DUPLICATE_TASK_ID:t:a/);
  assert.throws(() => route(root, cas, { delta, graph, tasks: [verifyTask('t:x', 'src/a.json', 'e:a'), verifyTask('t:y', 'src/b.json', 'e:a')] }), /DUPLICATE_PRODUCED_EVIDENCE_ID:e:a/);
});

test('R5-T25 a malformed cost policy is rejected instead of silently defaulted', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  for (const [policy, pattern] of [
    [{ ...DEFAULT_ROUTER_POLICY, costCeiling: 'CHEAP' }, /UNKNOWN_COST_CEILING/],
    [{ ...DEFAULT_ROUTER_POLICY, scaleBytesThresholds: [100, 10] }, /SCALE_BYTES_THRESHOLDS_NOT_ASCENDING/],
    [{ ...DEFAULT_ROUTER_POLICY, capabilityBaseCost: { LOCAL_DETERMINISTIC: 0 } }, /CAPABILITY_BASE_COST_MISSING/],
    [{ ...DEFAULT_ROUTER_POLICY, capabilityBaseCost: { ...DEFAULT_ROUTER_POLICY.capabilityBaseCost, DEEP_REASONING: -1 } }, /CAPABILITY_BASE_COST_NOT_INTEGER/],
    [{ ...DEFAULT_ROUTER_POLICY, policyVersion: '' }, /POLICY_VERSION_REQUIRED/],
    [null, /POLICY_OBJECT_REQUIRED/]
  ]) {
    assert.throws(() => route(root, cas, { delta, graph, policy }), pattern);
  }
});

test('R5-T26 a caller-supplied route decision cannot bypass the engine', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  for (const field of ['capability', 'routeDecision', 'costClass', 'reasonCodes', 'deferred', 'containmentState']) {
    assert.throws(
      () => route(root, cas, { delta, graph, tasks: [{ ...verifyTask('t:forced', 'src/a.json', 'e:a'), [field]: 'LOCAL_DETERMINISTIC' }] }),
      new RegExp(`CALLER_SUPPLIED_ROUTE_DECISION_FORBIDDEN:${field}`)
    );
  }
});

/* --------------------------------------------------- PROVIDER SEPARATION */

test('R5-T27 changing the provider mapping leaves the canonical route unchanged', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph, tasks: [...defaultTasks(), { taskId: 't:deep', intent: 'SEMANTIC', sources: ['src/a.json'], contradiction: { statement: 'x', sources: [] } }] });
  const before = resolveProviders(plan, createProviderMapping({ mappings: DEFAULT_PROVIDER_MAPPING }));
  const after = resolveProviders(plan, createProviderMapping({
    mappings: { LOCAL_DETERMINISTIC: 'some-other-local-runner', STANDARD_REASONING: 'some-other-agent', DEEP_REASONING: 'some-other-frontier-agent' }
  }));
  assert.equal(routePlanSha256(plan), plan.routeSha256);
  assert.deepEqual(before.assignments.map((a) => a.capability), after.assignments.map((a) => a.capability));
  assert.notDeepEqual(before.assignments.map((a) => a.provider), after.assignments.map((a) => a.provider));
  assert.equal(before.executable, true);
  assert.equal(after.executable, true);
});

test('R5-T28 an unavailable provider degrades execution, not route semantics', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  const digestBefore = plan.routeSha256;
  const mapping = createProviderMapping({ mappings: DEFAULT_PROVIDER_MAPPING, available: ['lower-cost-capable-agent'] });
  const resolved = resolveProviders(plan, mapping);
  assert.equal(resolved.executable, false);
  assert.deepEqual(resolved.unresolved, ['t:b', 't:summary']);
  assert.ok(resolved.assignments.every((assignment) => assignment.status !== 'ASSIGNED' || assignment.capability !== 'LOCAL_DETERMINISTIC'));
  assert.equal(plan.routeSha256, digestBefore);
  assert.equal(plan.routeDecision, 'LOCAL_DETERMINISTIC');
  assert.equal(routePlanSha256(plan), digestBefore);
});

/* ------------------------------------------- PROVIDER EXECUTION BOUNDARY */

/**
 * A plan with one genuinely executable task and one that the cost ceiling
 * defers: the exact shape where "assigned" and "deferred" must not blur.
 */
function mixedDeferralPlan() {
  const { root, cas, delta, graph } = mutatedBScenario();
  return route(root, cas, {
    delta,
    graph,
    policy: { ...DEFAULT_ROUTER_POLICY, costCeiling: 'VERY_LOW' },
    tasks: [
      verifyTask('t:b', 'src/b.json', 'e:b'),
      verifyTask('t:summary', null, 'e:summary'),
      { taskId: 't:deferred-deep', intent: 'SEMANTIC', sources: ['src/a.json'], architectureImpact: 'MULTI_LAYER' }
    ]
  });
}

function assignmentOf(resolved, taskId) { return resolved.assignments.find((assignment) => assignment.taskId === taskId); }

test('R5-C1-01 an ordinary executable task is assigned a provider', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  const resolved = resolveProviders(plan, createProviderMapping({}));
  assert.equal(assignmentOf(resolved, 't:b').status, 'ASSIGNED');
  assert.equal(assignmentOf(resolved, 't:b').provider, 'local-deterministic-tooling');
  assert.deepEqual(resolved.deferred, []);
  assert.equal(resolved.executable, true);
});

test('R5-C1-02 a deferred task is never handed a provider', () => {
  const plan = mixedDeferralPlan();
  assert.equal(taskOf(plan, 't:deferred-deep').deferred, true);
  const resolved = resolveProviders(plan, createProviderMapping({}));
  const deferredAssignment = assignmentOf(resolved, 't:deferred-deep');
  assert.equal(deferredAssignment.status, 'DEFERRED_NO_ASSIGNMENT');
  assert.equal(deferredAssignment.provider, null);
  assert.equal(deferredAssignment.capability, 'DEEP_REASONING');
  assert.deepEqual(resolved.deferred, ['t:deferred-deep']);
  // Deferral is a routing decision, not a provider failure.
  assert.deepEqual(resolved.unresolved, []);
});

test('R5-C1-03 a mixed plan assigns the active work and leaves the deferred work alone', () => {
  const resolved = resolveProviders(mixedDeferralPlan(), createProviderMapping({}));
  assert.deepEqual(resolved.assigned, ['t:b', 't:summary']);
  assert.deepEqual(resolved.deferred, ['t:deferred-deep']);
  assert.deepEqual(resolved.unresolved, []);
  assert.equal(resolved.executable, true);
});

test('R5-C1-04 an unavailable provider for an ACTIVE task still blocks execution', () => {
  const resolved = resolveProviders(mixedDeferralPlan(), createProviderMapping({ available: ['strongest-reasoning-agent'] }));
  assert.equal(assignmentOf(resolved, 't:b').status, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(resolved.unresolved, ['t:b', 't:summary']);
  assert.equal(resolved.executable, false);
});

test('R5-C1-05 an unavailable provider for a DEFERRED task is not an execution failure', () => {
  // Only the local runner is reachable; the deep provider is not. The deferred
  // deep task must not be counted as unresolved for a provider it was never
  // going to be given.
  const resolved = resolveProviders(mixedDeferralPlan(), createProviderMapping({ available: ['local-deterministic-tooling'] }));
  assert.equal(assignmentOf(resolved, 't:b').status, 'ASSIGNED');
  assert.equal(assignmentOf(resolved, 't:deferred-deep').status, 'DEFERRED_NO_ASSIGNMENT');
  assert.deepEqual(resolved.unresolved, []);
  assert.equal(resolved.executable, true);
});

test('R5-C1-06 executable means every task that should run now has a provider', () => {
  // A plan whose only outstanding work is deferred is executable AND has
  // nothing to execute. Those are different facts, so they are reported apart.
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: { ...DEFAULT_ROUTER_POLICY, costCeiling: 'VERY_LOW' },
    tasks: [{ taskId: 't:only-deferred', intent: 'SEMANTIC', sources: ['src/a.json'], architectureImpact: 'MULTI_LAYER' }]
  });
  const resolved = resolveProviders(plan, createProviderMapping({}));
  assert.equal(resolved.executable, true);
  assert.deepEqual(resolved.assigned, []);
  assert.deepEqual(resolved.deferred, ['t:only-deferred']);
  // Capabilities that need no executor stay distinct from deferral.
  const noWork = resolveProviders(route(root, cas, { delta, graph }), createProviderMapping({}));
  assert.ok(noWork.assignments.every((assignment) => assignment.status === 'NO_PROVIDER_REQUIRED'));
  assert.deepEqual(noWork.deferred, []);
});

test('R5-C2-01 an object that merely has a tasks array is not a route plan', () => {
  const mapping = createProviderMapping({});
  assert.throws(() => resolveProviders({ routeSha256: 'fake', tasks: [{ taskId: 'x', capability: 'LOCAL_DETERMINISTIC' }] }, mapping), /INVALID_ROUTE_PLAN:/);
  assert.throws(() => resolveProviders({ tasks: [] }, mapping), /INVALID_ROUTE_PLAN:/);
  assert.throws(() => resolveProviders(null, mapping), /ROUTE_PLAN_REQUIRED/);
});

test('R5-C2-02 a structurally valid plan carrying the wrong digest is rejected', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.throws(() => resolveProviders({ ...plan, routeSha256: '0'.repeat(64) }, createProviderMapping({})), /INVALID_ROUTE_PLAN_DIGEST/);
});

test('R5-C2-03 a valid untouched plan is accepted', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.equal(resolveProviders(plan, createProviderMapping({})).routeSha256, plan.routeSha256);
});

test('R5-C2-04 a JSON round-tripped plan is accepted', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  const revived = JSON.parse(JSON.stringify(plan));
  const resolved = resolveProviders(revived, createProviderMapping({}));
  assert.equal(resolved.routeSha256, plan.routeSha256);
  assert.deepEqual(resolved.assigned, ['t:b', 't:summary']);
});

test('R5-C2-05 tampering with a routed capability without recomputing the digest is rejected', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  const downgraded = { ...plan, tasks: plan.tasks.map((task) => task.taskId === 't:b' ? { ...task, capability: 'NO_WORK_REQUIRED' } : task) };
  assert.throws(() => resolveProviders(downgraded, createProviderMapping({})), /INVALID_ROUTE_PLAN_DIGEST/);
  const relabelled = { ...plan, routeDecision: 'NO_WORK_REQUIRED' };
  assert.throws(() => resolveProviders(relabelled, createProviderMapping({})), /INVALID_ROUTE_PLAN_DIGEST/);
  const undeferred = { ...plan, tasks: plan.tasks.map((task) => ({ ...task, deferred: !task.deferred })) };
  assert.throws(() => resolveProviders(undeferred, createProviderMapping({})), /INVALID_ROUTE_PLAN_DIGEST/);
});

/* ------------------------------------------------------ HOSTILE / STRUCTURE */

test('R5-H01 the produced route plan conforms to the route-plan schema', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  for (const plan of [
    route(root, cas, { delta, graph }),
    route(root, cas, { delta, graph, repairLedger: survived(createRepairLedger()), tasks: [...defaultTasks(), repairTask('t:patch')] }),
    route(root, cas, { delta, graph, tasks: [...defaultTasks(), { taskId: 't:policy', intent: 'POLICY_DECISION', sources: [] }] })
  ]) {
    const result = validateRoutePlan(plan);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
    assert.equal(verifyRoutePlanDigest(plan), true);
  }
});

test('R5-H02 repair history is append-only and a silent rewrite fails verification', () => {
  const ledger = survived(survived(createRepairLedger()));
  assert.equal(verifyRepairLedger(ledger), true);
  assert.equal(ledger.records.length, 2);
  assert.deepEqual(ledger.records.map((record) => record.attemptOrdinal), [1, 2]);

  // The original ledger is untouched by the append that produced the newer one.
  const first = survived(createRepairLedger());
  assert.equal(first.records.length, 1);
  assert.notEqual(first.ledgerSha256, ledger.ledgerSha256);

  // Relabelling a survival as a resolution is refused outright: RESOLVED is not
  // a structurally valid record without verifiable resolution evidence.
  const relabelled = { ...ledger, records: [{ ...ledger.records[0], outcome: RESOLVED }, ledger.records[1]] };
  assert.throws(() => verifyRepairLedger(relabelled), /RESOLUTION_EVIDENCE_REQUIRED/);
  // A structurally valid edit to an earlier record still breaks the chain.
  const rewritten = { ...ledger, records: [{ ...ledger.records[0], symptom: 'rewritten history' }, ledger.records[1]] };
  assert.throws(() => verifyRepairLedger(rewritten), /REPAIR_LEDGER_CHAIN_BROKEN|REPAIR_RECORD_MUTATED|INVALID_REPAIR_LEDGER_DIGEST/);
  const dropped = { ...ledger, records: [ledger.records[1]] };
  assert.throws(() => verifyRepairLedger(dropped), /REPAIR_LEDGER_CHAIN_BROKEN/);
  const backdated = { ...ledger, records: [ledger.records[0], { ...ledger.records[1], attemptOrdinal: 1 }] };
  assert.throws(() => verifyRepairLedger(backdated), /REPAIR_ATTEMPT_ORDINAL_MISMATCH/);
});

test('R5-H03 a repair ledger survives a JSON round-trip with its containment intact', () => {
  const ledger = survived(survived(createRepairLedger()));
  const revived = parseRepairLedger(serializeRepairLedger(ledger));
  assert.equal(revived.ledgerSha256, ledger.ledgerSha256);
  assert.deepEqual(evaluateContainment(revived, DEFECT.rootCauseClass), evaluateContainment(ledger, DEFECT.rootCauseClass));
  assert.throws(() => parseRepairLedger('{'), /INVALID_REPAIR_LEDGER_JSON/);
});

test('R5-H05 a repair outcome without evidence, or an unknown outcome, is refused', () => {
  const ledger = createRepairLedger();
  assert.throws(() => appendRepairRecord(ledger, { ...DEFECT, outcome: SURVIVED }), /REPAIR_OUTCOME_EVIDENCE_REQUIRED/);
  assert.throws(() => appendRepairRecord(ledger, { ...DEFECT, outcome: 'PROBABLY_FIXED', evidenceRef: 'x' }), /INVALID_REPAIR_OUTCOME/);
  assert.throws(() => appendRepairRecord(ledger, { defectId: 'D', outcome: SURVIVED, evidenceRef: 'x' }), /REPAIR_ROOT_CAUSE_CLASS_REQUIRED/);
  assert.throws(() => appendRepairRecord(ledger, { ...DEFECT, outcome: SURVIVED, evidenceRef: 'x', repairClass: 'MOSTLY_STRUCTURAL' }), /INVALID_REPAIR_CLASS/);
  assert.throws(() => appendRepairRecord(ledger, { ...DEFECT, recordKind: ROOT_CAUSE_ANALYSIS, outcome: SURVIVED, evidenceRef: 'x', repairClass: STRUCTURAL }), /REPAIR_CLASS_ONLY_FOR_REPAIR_ATTEMPT/);
});

test('R5-H06 an invalid or authoritative-looking R2 context is refused', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const context = contextFor(root);
  assert.throws(() => routeWorkUnit({ workUnitId: 'WU-R5', tasks: [], r3Delta: delta, r4Evidence: { graph }, cas }), /INVALID_R2_INPUT:CONTEXT_REQUIRED/);
  for (const [broken, pattern] of [
    [null, /INVALID_R2_INPUT:CONTEXT_REQUIRED/],
    [{ ...context, bundleKind: 'SOMETHING_ELSE' }, /NOT_A_CONTEXT_BUNDLE/],
    [{ ...context, authorityDeclaration: 'CANONICAL' }, /R2_CONTEXT_MUST_REMAIN_NON_AUTHORITATIVE/],
    [{ ...context, identity: { ...context.identity, compilerVersion: 'HAND_WRITTEN' } }, /UNKNOWN_COMPILER/],
    [{ ...context, relevantSources: [] }, /NO_RELEVANT_SOURCES/]
  ]) {
    assert.throws(() => route(root, cas, { delta, graph, r2Context: broken }), pattern);
  }
});

test('R5-H07 a removed or R3-untracked source blocks rather than routing cheaply', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const removal = deltaOf(root, () => fs.rmSync(path.join(root, 'src', 'b.json')));
  const plan = route(root, cas, { delta: removal, graph: base.graph });
  assert.equal(taskOf(plan, 't:b').capability, 'BLOCKED');
  assert.ok(taskOf(plan, 't:b').blockedBy.includes('REQUIRED_SOURCE_REMOVED:src/b.json'));

  const untracked = route(root, cas, {
    delta: base.unchanged,
    graph: base.graph,
    tasks: [{ taskId: 't:untracked', intent: 'DETERMINISTIC', sources: ['src/never-tracked.json'] }]
  });
  assert.deepEqual(taskOf(untracked, 't:untracked').blockedBy, ['SOURCE_UNTRACKED_BY_R3:src/never-tracked.json']);
});

test('R5-H08 an owner decision is required only when evidence cannot settle it', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [
      { taskId: 't:owner', intent: 'POLICY_DECISION', sources: ['src/a.json'] },
      { taskId: 't:technical', intent: 'POLICY_DECISION', sources: ['src/b.json'], derivableFromEvidence: true }
    ]
  });
  assert.deepEqual(plan.ownerDecisionTasks, ['t:owner']);
  assert.ok(taskOf(plan, 't:owner').reasonCodes.includes('OWNER_POLICY_DECISION_NOT_DERIVABLE'));
  assert.equal(taskOf(plan, 't:technical').capability, 'STANDARD_REASONING');
  assert.ok(taskOf(plan, 't:technical').reasonCodes.includes('OWNER_DECISION_AVOIDABLE_TECHNICAL_QUESTION'));
  assert.equal(plan.routeDecision, 'OWNER_DECISION_REQUIRED');
});

test('R5-H09 mechanical work stays local even when it is uncertain or wide', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [{ taskId: 't:hash-sweep', intent: 'DETERMINISTIC', sources: ['src/b.json'], produces: ['e:b'], uncertainty: 'HIGH', architectureImpact: 'FROZEN_LAYER' }, ...producersFor('e:summary')]
  });
  assert.equal(taskOf(plan, 't:hash-sweep').capability, 'LOCAL_DETERMINISTIC');
  // A contradiction is the one thing that escalates mechanical work, because it
  // has to be interpreted before any mechanical result means anything.
  const contradictory = route(root, cas, {
    delta,
    graph,
    tasks: [{ taskId: 't:hash-sweep', intent: 'DETERMINISTIC', sources: ['src/b.json'], produces: ['e:b'], contradiction: { statement: 'manifest and ledger disagree', sources: [] } }, ...producersFor('e:summary')]
  });
  assert.equal(taskOf(contradictory, 't:hash-sweep').capability, 'DEEP_REASONING');
});

test('R5-H10 an edited route plan fails its own digest check', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.equal(verifyRoutePlanDigest(plan), true);
  assert.throws(() => verifyRoutePlanDigest({ ...plan, routeDecision: 'NO_WORK_REQUIRED' }), /INVALID_ROUTE_PLAN_DIGEST/);
  assert.throws(() => verifyRoutePlanDigest({ ...plan, deterministicTasks: [] }), /INVALID_ROUTE_PLAN_DIGEST/);
});

test('R5-H11 route identity binds every upstream input and the policy', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.match(plan.provenance.r2ContextSha256, /^[a-f0-9]{64}$/);
  assert.match(plan.provenance.r3DeltaSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.provenance.r4GraphSha256.length, 64);
  assert.equal(plan.provenance.repairLedgerSha256, createRepairLedger().ledgerSha256);
  assert.equal(plan.provenance.routerPolicySha256, validateRouterPolicy(DEFAULT_ROUTER_POLICY) && plan.provenance.routerPolicySha256);

  // Changing any single bound input changes the route identity.
  const otherLedger = survived(createRepairLedger());
  assert.notEqual(route(root, cas, { delta, graph, repairLedger: otherLedger }).routeSha256, plan.routeSha256);
  assert.notEqual(route(root, cas, { delta, graph, policy: { ...DEFAULT_ROUTER_POLICY, policyVersion: 'OTHER' } }).routeSha256, plan.routeSha256);
  const { delta: unchangedDelta, graph: unchangedGraph, root: otherRoot, cas: otherCas } = unchangedScenario();
  assert.notEqual(route(otherRoot, otherCas, { delta: unchangedDelta, graph: unchangedGraph }).routeSha256, plan.routeSha256);
});

test('R5-H12 removed evidence is reported as a tombstone and blocks work that needs it', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const survivingNodes = bindFreshValidations({
    cas,
    nodes: rawNodes().filter((node) => node.evidenceId === 'e:a'),
    r3Delta: base.unchanged,
    validationResults: { 'e:a': PASS }
  });
  const plan = route(root, cas, {
    delta: base.unchanged,
    graph: createEvidenceGraph({ cas, nodes: survivingNodes }),
    previousGraph: base.graph,
    tasks: [verifyTask('t:a', 'src/a.json', 'e:a'), verifyTask('t:b', 'src/b.json', 'e:b')]
  });
  assert.deepEqual(plan.removedEvidenceIds, ['e:b', 'e:summary']);
  assert.equal(taskOf(plan, 't:a').capability, 'NO_WORK_REQUIRED');
  assert.equal(taskOf(plan, 't:b').capability, 'BLOCKED');
  assert.deepEqual(taskOf(plan, 't:b').blockedBy, ['REQUIRED_EVIDENCE_REMOVED:e:b']);
});

/* ---------------------------------------------- COMPOUNDED R2+R3+R4 DEMO */

test('R5-H13 a real Wheel work unit routes no work when R2/R3/R4 prove nothing changed', () => {
  const cas = casFor(tempRoot());
  const { plan, compiled, currentSnapshot } = routeWheelWorkUnit({ repoRoot: REPO_ROOT, workUnitId: 'GATE13', cas, sourceHead: CANONICAL_HEAD });
  assert.equal(plan.routeDecision, 'NO_WORK_REQUIRED');
  assert.ok(plan.tasks.length > 0);
  assert.equal(plan.avoidedTasks.length, plan.tasks.length);
  assert.deepEqual(plan.blockedTasks, []);
  assert.deepEqual(plan.revalidationRequiredEvidenceIds, []);
  assert.equal(plan.metrics.R4_REUSABLE_NODES, plan.metrics.R4_CURRENT_EVIDENCE_NODES);
  assert.equal(plan.metrics.R3_REPROCESS_BYTES, 0);
  // Compounding is real: the compiled context is a fraction of the sources it
  // stands for, and none of those sources has to be reread.
  const sourceBytes = currentSnapshot.sources.reduce((sum, source) => sum + source.bytes, 0);
  assert.equal(plan.metrics.R3_TOTAL_SOURCE_BYTES, sourceBytes);
  assert.equal(plan.metrics.R3_AVOIDED_REPROCESS_BYTES, sourceBytes);
  assert.ok(compiled.metrics.sourceBytes > plan.metrics.R2_CONTEXT_BYTES);
  assert.equal(validateRoutePlan(plan).valid, true);
});

/**
 * Mirrors the canonical sources of a Wheel work unit into a scratch tree and
 * changes exactly one of them. The result is a GENUINE snapshot — every digest
 * is the real hash of real bytes on disk — so the delta below is a real R3
 * comparison rather than a hand-written claim, and the repository itself is
 * never touched.
 */
function mirrorWithOneChangedSource(snapshot, changedPath) {
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r5-mirror-'));
  for (const source of snapshot.sources) {
    const target = path.join(mirror, ...source.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, ...source.path.split('/')), target);
  }
  fs.appendFileSync(path.join(mirror, ...changedPath.split('/')), '\n');
  return createSnapshot({ repoRoot: mirror, sources: snapshot.sources.map((source) => ({ path: source.path })) });
}

test('R5-H14 a real Wheel source change routes only the facts that depend on it', () => {
  const cas = casFor(tempRoot());
  const prior = routeWheelWorkUnit({ repoRoot: REPO_ROOT, workUnitId: 'GATE13', cas, sourceHead: CANONICAL_HEAD });
  const context = prior.compiled.json;
  const changedPath = context.facts.find((fact) => fact.id === 'active-status').provenance.sourcePath;
  const unchangedPath = context.facts.find((fact) => fact.id === 'mission-objective').provenance.sourcePath;
  assert.notEqual(changedPath, unchangedPath);

  const plan = routeWorkUnit({
    workUnitId: 'GATE13',
    tasks: prior.plan.tasks.map((task) => ({ taskId: task.taskId, intent: task.intent, sources: task.sources, produces: task.produces, requiredEvidenceIds: task.requiredEvidenceIds })),
    r2Context: context,
    // Prior evidence, validated when the sources were as the repository has
    // them, compared against a world where exactly one of them moved.
    r3Delta: { previousSnapshot: prior.currentSnapshot, currentSnapshot: mirrorWithOneChangedSource(prior.currentSnapshot, changedPath) },
    r4Evidence: { graph: prior.graph },
    cas
  });

  assert.equal(plan.routeDecision, 'LOCAL_DETERMINISTIC');
  assert.deepEqual(plan.deterministicTasks, ['wheel-verify-fact:active-status']);
  assert.deepEqual(plan.avoidedTasks, ['wheel-verify-fact:mission-objective']);
  assert.deepEqual(plan.reusableEvidenceIds, ['wheel:mission-objective']);
  assert.deepEqual(plan.revalidationRequiredEvidenceIds, ['wheel:active-status']);
  // Only the changed source is reprocessed; every other canonical byte is not.
  const changedBytes = prior.currentSnapshot.sources.find((source) => source.path === changedPath).bytes;
  assert.equal(plan.metrics.R3_CHANGED_BYTES > 0, true);
  assert.equal(plan.metrics.R3_AVOIDED_REPROCESS_BYTES, plan.metrics.R3_TOTAL_SOURCE_BYTES - plan.metrics.R3_REPROCESS_BYTES);
  assert.ok(plan.metrics.R3_REPROCESS_BYTES < changedBytes + plan.metrics.R3_TOTAL_SOURCE_BYTES);
  assert.equal(validateRoutePlan(plan).valid, true);
});

/* ============================================================================
 * R1 reinspection repairs.
 * A1 cost ceiling vs quality, A2 pending revalidation, A3/A3b repair classes
 * and verified resolution, A4 write-scope recognition, R2 identity binding.
 * ========================================================================== */

const VERY_LOW_CEILING = { ...DEFAULT_ROUTER_POLICY, costCeiling: 'VERY_LOW' };
const CONTRADICTION = Object.freeze({ statement: 'two trusted sources disagree', sources: ['src/a.json'] });

test('R5-A1-01 a contradiction is never cost-deferred and never collapses the route', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: VERY_LOW_CEILING,
    tasks: [{ taskId: 't:only-contradiction', intent: 'SEMANTIC', sources: ['src/a.json'], contradiction: CONTRADICTION }]
  });
  const task = taskOf(plan, 't:only-contradiction');
  assert.equal(task.capability, 'DEEP_REASONING');
  assert.equal(task.deferred, false);
  assert.equal(task.nonDeferrable, true);
  assert.ok(task.reasonCodes.includes('QUALITY_CRITICAL_EXEMPT_FROM_COST_CEILING:ARCHITECTURE_CONTRADICTION'));
  assert.equal(plan.routeDecision, 'DEEP_REASONING');
  assert.deepEqual(plan.deferredTasks, []);
  assert.deepEqual(plan.qualityRequirements.nonDeferrableTaskIds, ['t:only-contradiction']);
});

test('R5-A1-02 root-cause analysis demanded by a stopped cascade is never cost-deferred', () => {
  const ledger = survived(survived(createRepairLedger()));
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: VERY_LOW_CEILING,
    repairLedger: ledger,
    tasks: [{ taskId: 't:root-cause', intent: 'ROOT_CAUSE_ANALYSIS', sources: ['src/a.json'], repair: { ...DEFECT, incremental: false } }]
  });
  const task = taskOf(plan, 't:root-cause');
  assert.equal(task.capability, 'DEEP_REASONING');
  assert.equal(task.deferred, false);
  assert.ok(task.reasonCodes.includes('QUALITY_CRITICAL_EXEMPT_FROM_COST_CEILING:ROOT_CAUSE_ANALYSIS_REQUIRED_AFTER_CONTAINMENT'));
  assert.equal(plan.routeDecision, 'DEEP_REASONING');
});

test('R5-A1-03 expensive but discretionary deep work may still be deferred', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: VERY_LOW_CEILING,
    // Wide, uncertain, and genuinely deep — but nothing the quality floor says
    // must be surfaced, so the ceiling keeps its purpose.
    tasks: [{ taskId: 't:wide-refactor', intent: 'SEMANTIC', sources: ['src/a.json'], architectureImpact: 'MULTI_LAYER', uncertainty: 'HIGH' }]
  });
  const task = taskOf(plan, 't:wide-refactor');
  assert.equal(task.capability, 'DEEP_REASONING');
  assert.equal(task.deferred, true);
  assert.equal(task.nonDeferrable, false);
  assert.ok(task.reasonCodes.includes('COST_CEILING_EXCEEDED_DEFERRED'));
  assert.deepEqual(plan.deferredTasks, ['t:wide-refactor']);
});

test('R5-A1-04 a blocked task is retained under the ceiling and mandatory stays exempt', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: VERY_LOW_CEILING,
    tasks: [
      { taskId: 't:blocked', intent: 'SEMANTIC', sources: ['src/a.json'], requiredEvidenceIds: ['e:absent'], contradiction: CONTRADICTION },
      { taskId: 't:mandatory', intent: 'SEMANTIC', sources: ['src/b.json'], architectureImpact: 'MULTI_LAYER', mandatory: true }
    ]
  });
  assert.equal(taskOf(plan, 't:blocked').capability, 'BLOCKED');
  assert.equal(taskOf(plan, 't:blocked').deferred, false);
  assert.equal(taskOf(plan, 't:mandatory').deferred, false);
  assert.ok(taskOf(plan, 't:mandatory').reasonCodes.includes('MANDATORY_VALIDATION_EXEMPT_FROM_COST_CEILING'));
  assert.equal(plan.routeDecision, 'BLOCKED');
});

test('R5-A2-01 a task that produces its own invalidated evidence is the revalidation work', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph, tasks: [verifyTask('t:revalidate-b', 'src/b.json', 'e:b'), ...producersFor('e:summary')] });
  const task = taskOf(plan, 't:revalidate-b');
  assert.equal(task.capability, 'LOCAL_DETERMINISTIC');
  assert.deepEqual(task.blockedBy, []);
  assert.ok(task.reasonCodes.includes('EVIDENCE_REVALIDATION_REQUIRED'));
});

test('R5-A2-02 a consumer of invalidated evidence it does not produce is not executable yet', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [verifyTask('t:revalidate-b', 'src/b.json', 'e:b'), { taskId: 't:consume-b', intent: 'SEMANTIC', requiredEvidenceIds: ['e:b'] }, ...producersFor('e:summary')]
  });
  const consumer = taskOf(plan, 't:consume-b');
  assert.notEqual(consumer.capability, 'STANDARD_REASONING');
  assert.equal(consumer.capability, 'BLOCKED');
  assert.deepEqual(consumer.blockedBy, ['REQUIRED_EVIDENCE_REVALIDATION_PENDING:e:b']);
  assert.deepEqual(plan.qualityRequirements.pendingRevalidationTaskIds, ['t:consume-b']);
  assert.equal(plan.routeDecision, 'BLOCKED');
});

test('R5-A2-03 the same consumer routes normally once its evidence is genuinely reusable', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, tasks: [{ taskId: 't:consume-b', intent: 'SEMANTIC', requiredEvidenceIds: ['e:b'] }] });
  const consumer = taskOf(plan, 't:consume-b');
  assert.equal(consumer.capability, 'STANDARD_REASONING');
  assert.deepEqual(consumer.blockedBy, []);
  assert.deepEqual(plan.qualityRequirements.pendingRevalidationTaskIds, []);
});

test('R5-A2-04 permanently unresolvable evidence stays blocked, not merely pending', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const removal = deltaOf(root, () => fs.rmSync(path.join(root, 'src', 'b.json')));
  const plan = route(root, cas, {
    delta: removal,
    graph: base.graph,
    tasks: [{ taskId: 't:consume-b', intent: 'SEMANTIC', requiredEvidenceIds: ['e:b'] }, ...producersFor('e:b', 'e:summary')]
  });
  assert.deepEqual(taskOf(plan, 't:consume-b').blockedBy, ['REQUIRED_EVIDENCE_UNRESOLVABLE:e:b:DIRECT_SOURCE_REMOVED']);
  assert.deepEqual(plan.qualityRequirements.pendingRevalidationTaskIds, []);
});

test('R5-A2-05 one invalidated branch does not block a consumer of an unrelated branch', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [
      { taskId: 't:consume-a', intent: 'SEMANTIC', requiredEvidenceIds: ['e:a'] },
      { taskId: 't:consume-b', intent: 'SEMANTIC', requiredEvidenceIds: ['e:b'] },
      ...producersFor('e:b', 'e:summary')
    ]
  });
  assert.equal(taskOf(plan, 't:consume-a').capability, 'STANDARD_REASONING');
  assert.equal(taskOf(plan, 't:consume-b').capability, 'BLOCKED');
});

/** A structural correction: not a targeted patch, so containment never counts it. */
function structural(ledger, overrides = {}) {
  return appendRepairRecord(ledger, { ...DEFECT, repairClass: STRUCTURAL, outcome: SURVIVED, evidenceRef: 'test://structural', ...overrides });
}

/** Genuine resolution evidence: the identity a node really carries in the graph. */
function resolutionEvidenceFor(graph, evidenceId) {
  return { evidenceId, reuseIdentity: graph.nodes.find((node) => node.evidenceId === evidenceId).reuseIdentity };
}

/**
 * An R4 evidence node whose validated CONTENT asserts that one specific root
 * cause and defect are resolved. This is what makes a resolution claim about
 * something rather than merely authentic.
 */
function resolutionNode(evidenceId, { rootCauseClass, defectId }, sourcePath = 'src/a.json') {
  return {
    evidenceId,
    content: rootCauseResolutionAssertion({ rootCauseClass, defectId }),
    evidenceType: 'ROOT_CAUSE_RESOLUTION',
    provenance: { sourcePath, authorityClass: 'CANONICAL' },
    dependencies: [`source:${sourcePath}`],
    authorityStatus: 'GROUNDED'
  };
}

/** Baseline scenario plus extra evidence nodes, optionally with a real mutation after validation. */
function scenarioWith(extraNodes, mutate = null) {
  const root = tempRoot();
  const cas = casFor(root);
  const nodes = [...rawNodes(), ...extraNodes];
  const unchanged = deltaOf(root);
  const bound = bindFreshValidations({
    cas,
    nodes,
    r3Delta: unchanged,
    validationResults: Object.fromEntries(nodes.map((node) => [node.evidenceId, PASS]))
  });
  return { root, cas, graph: createEvidenceGraph({ cas, nodes: bound }), delta: mutate ? deltaOf(root, mutate) : unchanged };
}

/** Two unresolved targeted attempts, then the analysis the stop demands. */
function analysed(ledger, overrides = {}) {
  return appendRepairRecord(ledger, { ...DEFECT, recordKind: ROOT_CAUSE_ANALYSIS, outcome: SURVIVED, evidenceRef: 'test://analysis', ...overrides });
}

function resolvedBy(ledger, graph, evidenceId, overrides = {}) {
  return appendRepairRecord(ledger, {
    ...DEFECT,
    repairClass: STRUCTURAL,
    outcome: RESOLVED,
    evidenceRef: 'test://structural-fix-validated',
    resolutionEvidence: resolutionEvidenceFor(graph, evidenceId),
    ...overrides
  });
}

test('R5-A3-01 one unresolved targeted attempt still authorizes the second', () => {
  const containment = evaluateContainment(survived(createRepairLedger()), DEFECT.rootCauseClass);
  assert.equal(containment.targetedAttempts, 1);
  assert.equal(containment.containmentCount, 1);
  assert.equal(containment.incrementalPatchAuthorized, true);
  assert.equal(containment.nextAttemptState, 'TARGETED_REPAIR_2');
});

test('R5-A3-02 a structural repair is not counted as a second targeted survival', () => {
  const ledger = structural(survived(createRepairLedger()));
  const containment = evaluateContainment(ledger, DEFECT.rootCauseClass);
  assert.equal(containment.targetedAttempts, 1);
  assert.equal(containment.structuralAttempts, 1);
  assert.equal(containment.containmentCount, 1);
  assert.equal(containment.lineageState, 'TARGETED_REPAIR_1');
  assert.equal(containment.incrementalPatchAuthorized, true);
  // Each class carries its own lifetime ordinal, so neither shifts the other.
  assert.deepEqual(ledger.records.map((record) => [record.repairClass, record.attemptOrdinal]), [['TARGETED_INCREMENTAL', 1], ['STRUCTURAL', 1]]);
});

test('R5-A3-03 two unresolved targeted attempts stop the patch cascade', () => {
  const containment = evaluateContainment(survived(survived(createRepairLedger())), DEFECT.rootCauseClass);
  assert.equal(containment.containmentCount, 2);
  assert.equal(containment.lineageState, 'STOP_PATCH_CASCADE');
  assert.equal(containment.incrementalPatchAuthorized, false);
});

test('R5-A3-04 a third targeted incremental patch is blocked', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, repairLedger: survived(survived(createRepairLedger())), tasks: [repairTask('t:patch-3')] });
  assert.equal(taskOf(plan, 't:patch-3').capability, 'BLOCKED');
  assert.deepEqual(taskOf(plan, 't:patch-3').blockedBy, [`REPAIR_CONTAINMENT_STOP_PATCH_CASCADE:${DEFECT.rootCauseClass}`]);
});

test('R5-A3-05 root-cause analysis after a stop is allowed and routes deep', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: survived(survived(createRepairLedger())),
    tasks: [{ taskId: 't:analysis', intent: 'ROOT_CAUSE_ANALYSIS', sources: ['src/a.json'], repair: { ...DEFECT, incremental: false } }]
  });
  assert.equal(taskOf(plan, 't:analysis').capability, 'DEEP_REASONING');
  assert.deepEqual(taskOf(plan, 't:analysis').blockedBy, []);
});

test('R5-A3-06 a structural correction is allowed even while incremental patching is stopped', () => {
  const ledger = appendRepairRecord(survived(survived(createRepairLedger())), { ...DEFECT, recordKind: ROOT_CAUSE_ANALYSIS, outcome: SURVIVED, evidenceRef: 'test://analysis' });
  const containment = evaluateContainment(ledger, DEFECT.rootCauseClass);
  assert.equal(containment.rootCauseAnalyses, 1);
  // Analysis is not a patch: it neither consumes a targeted attempt nor lifts the stop.
  assert.equal(containment.nextTargetedAttemptOrdinal, 3);
  assert.equal(containment.incrementalPatchAuthorized, false);
  assert.equal(containment.structuralRepairAuthorized, true);

  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: ledger,
    tasks: [{ taskId: 't:structural-fix', intent: 'SEMANTIC', sources: ['src/a.json'], repair: { ...DEFECT, incremental: false } }]
  });
  assert.equal(taskOf(plan, 't:structural-fix').capability, 'STANDARD_REASONING');
  assert.deepEqual(taskOf(plan, 't:structural-fix').blockedBy, []);
  assert.equal(taskOf(plan, 't:structural-fix').containmentState, 'STOP_PATCH_CASCADE');
});

test('R5-A3-07 only a VERIFIED structural resolution closes the lineage', () => {
  const { root, cas, delta, graph } = scenarioWith([resolutionNode('e:fixed', DEFECT)]);
  const contained = analysed(survived(survived(createRepairLedger())));
  const resolved = resolvedBy(contained, graph, 'e:fixed');

  // Without a verifier the claim is recorded and changes nothing.
  const unverified = evaluateContainment(resolved, DEFECT.rootCauseClass);
  assert.equal(unverified.incrementalPatchAuthorized, false);
  assert.equal(unverified.unprovenResolutionClaims, 1);
  assert.equal(unverified.verifiedResolutions, 0);

  // Through the router, whose verifier is the real R4 re-evaluation, it closes.
  const plan = route(root, cas, { delta, graph, repairLedger: resolved, tasks: [repairTask('t:next-patch')] });
  const lineage = plan.repairContainment.lineages[0];
  assert.equal(lineage.verifiedResolutions, 1);
  assert.equal(lineage.containmentCount, 0);
  assert.equal(lineage.lineageState, 'NORMAL');
  assert.equal(lineage.incrementalPatchAuthorized, true);
  assert.equal(plan.repairContainment.stopPatchCascade, false);
  assert.equal(taskOf(plan, 't:next-patch').capability, 'STANDARD_REASONING');
  // The structural correction never pretended to be a third targeted patch.
  assert.equal(lineage.nextTargetedAttemptOrdinal, 3);
  assert.equal(resolved.records.at(-1).attemptOrdinal, 1);
});

test('R5-A3-08 a recurrence after a proven closure opens a fresh window', () => {
  const { root, cas, delta, graph } = scenarioWith([resolutionNode('e:fixed', DEFECT)]);
  let ledger = resolvedBy(analysed(survived(survived(createRepairLedger()))), graph, 'e:fixed');
  ledger = survived(ledger, { evidenceRef: 'test://recurrence' });
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [repairTask('t:patch-after-recurrence')] });
  const lineage = plan.repairContainment.lineages[0];
  assert.equal(lineage.containmentCount, 1);
  assert.equal(lineage.lineageState, 'TARGETED_REPAIR_1');
  assert.equal(lineage.incrementalPatchAuthorized, true);
  assert.equal(taskOf(plan, 't:patch-after-recurrence').containmentState, 'TARGETED_REPAIR_2');
});

test('R5-A3-09 an independent root cause keeps its own window under all of this', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const independent = { defectId: 'DEF-9', rootCauseClass: 'RC-UNRELATED' };
  const ledger = appendRepairRecord(structural(survived(survived(createRepairLedger()))), { ...independent, outcome: SURVIVED, evidenceRef: 'test://independent' });
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: ledger,
    tasks: [repairTask('t:contained'), { taskId: 't:independent', intent: 'SEMANTIC', sources: ['src/b.json'], repair: { ...independent, incremental: true } }]
  });
  assert.equal(taskOf(plan, 't:contained').capability, 'BLOCKED');
  assert.equal(taskOf(plan, 't:independent').capability, 'STANDARD_REASONING');
  const byClass = Object.fromEntries(plan.repairContainment.lineages.map((lineage) => [lineage.rootCauseClass, lineage]));
  assert.equal(byClass['RC-UNRELATED'].containmentCount, 1);
  assert.equal(byClass[DEFECT.rootCauseClass].containmentCount, 2);
});

test('R5-A3b fabricated resolution evidence never lifts a stopped cascade', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const contained = survived(survived(createRepairLedger()));

  const forged = (resolutionEvidence) => appendRepairRecord(contained, {
    ...DEFECT, repairClass: STRUCTURAL, outcome: RESOLVED, evidenceRef: 'test://forged', resolutionEvidence
  });
  for (const [label, resolutionEvidence] of [
    // A well-formed but fabricated identity for a node that really exists.
    ['forged identity', { evidenceId: 'e:a', reuseIdentity: '0'.repeat(64) }],
    // A reference to evidence that is not in the graph at all.
    ['absent node', { evidenceId: 'e:invented', reuseIdentity: '1'.repeat(64) }],
    // A real identity, but borrowed from a different node than the one named.
    ['mismatched node', { evidenceId: 'e:a', reuseIdentity: resolutionEvidenceFor(graph, 'e:b').reuseIdentity }]
  ]) {
    const plan = route(root, cas, { delta, graph, repairLedger: forged(resolutionEvidence), tasks: [repairTask('t:patch-3')] });
    assert.equal(plan.repairContainment.lineages[0].verifiedResolutions, 0, label);
    assert.equal(plan.repairContainment.lineages[0].incrementalPatchAuthorized, false, label);
    assert.equal(taskOf(plan, 't:patch-3').capability, 'BLOCKED', label);
  }

  // Evidence that is real but NOT currently reusable proves nothing either.
  const mutated = mutatedBScenario();
  const staleResolution = appendRepairRecord(contained, {
    ...DEFECT, repairClass: STRUCTURAL, outcome: RESOLVED, evidenceRef: 'test://stale', resolutionEvidence: resolutionEvidenceFor(mutated.graph, 'e:b')
  });
  const stalePlan = route(mutated.root, mutated.cas, { delta: mutated.delta, graph: mutated.graph, repairLedger: staleResolution, tasks: [repairTask('t:patch-3'), ...producersFor('e:b', 'e:summary')] });
  assert.equal(stalePlan.repairContainment.lineages[0].verifiedResolutions, 0);
  assert.equal(stalePlan.repairContainment.lineages[0].incrementalPatchAuthorized, false);
  assert.equal(taskOf(stalePlan, 't:patch-3').capability, 'BLOCKED');

  // And an unverifiable free-text resolution cannot even be recorded.
  assert.throws(() => appendRepairRecord(contained, { ...DEFECT, outcome: RESOLVED, evidenceRef: 'trust me' }), /RESOLUTION_EVIDENCE_REQUIRED/);
  assert.throws(() => appendRepairRecord(contained, { ...DEFECT, outcome: RESOLVED, evidenceRef: 'x', resolutionEvidence: { evidenceId: 'e:a', reuseIdentity: 'not-a-digest' } }), /RESOLUTION_EVIDENCE_IDENTITY_REQUIRED/);
  assert.throws(() => appendRepairRecord(contained, { ...DEFECT, outcome: SURVIVED, evidenceRef: 'x', resolutionEvidence: resolutionEvidenceFor(graph, 'e:a') }), /RESOLUTION_EVIDENCE_ONLY_FOR_RESOLVED/);
});

/* ============================================================================
 * R2 reinspection repairs.
 * B1 root-cause analysis is a prerequisite of structural repair after a stop.
 * B2 resolution evidence must be about the root cause it claims to close.
 * ========================================================================== */

const CONTAINED = () => survived(survived(createRepairLedger()));

function structuralTask(taskId, overrides = {}) {
  return { taskId, intent: 'SEMANTIC', sources: ['src/a.json'], repair: { ...DEFECT, incremental: false }, ...overrides };
}

test('R5-B1-01 a structural repair cannot escape a stopped cascade without the analysis', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, repairLedger: CONTAINED(), tasks: [structuralTask('t:relabelled-as-structural')] });
  const task = taskOf(plan, 't:relabelled-as-structural');
  assert.equal(task.capability, 'BLOCKED');
  assert.deepEqual(task.blockedBy, [`ROOT_CAUSE_ANALYSIS_REQUIRED_BEFORE_STRUCTURAL_REPAIR:${DEFECT.rootCauseClass}`]);
  const lineage = plan.repairContainment.lineages[0];
  assert.equal(lineage.rootCauseAnalyses, 0);
  assert.equal(lineage.structuralRepairAuthorized, false);
  assert.equal(lineage.structuralRepairObstacle, 'ROOT_CAUSE_ANALYSIS_REQUIRED_BEFORE_STRUCTURAL_REPAIR');
  assert.equal(plan.routeDecision, 'BLOCKED');
});

test('R5-B1-02 the root-cause analysis task itself is always allowed through', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: CONTAINED(),
    tasks: [{ taskId: 't:analysis', intent: 'ROOT_CAUSE_ANALYSIS', sources: ['src/a.json'], repair: { ...DEFECT, incremental: false } }]
  });
  const task = taskOf(plan, 't:analysis');
  assert.equal(task.capability, 'DEEP_REASONING');
  assert.deepEqual(task.blockedBy, []);
  assert.ok(task.reasonCodes.includes('ROOT_CAUSE_ANALYSIS_REQUIRED_AFTER_CONTAINMENT'));
});

test('R5-B1-03 a structural repair is authorized once the analysis is recorded', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, repairLedger: analysed(CONTAINED()), tasks: [structuralTask('t:structural-fix')] });
  const task = taskOf(plan, 't:structural-fix');
  assert.equal(task.capability, 'STANDARD_REASONING');
  assert.deepEqual(task.blockedBy, []);
  assert.equal(plan.repairContainment.lineages[0].structuralRepairAuthorized, true);
  assert.equal(plan.repairContainment.lineages[0].structuralRepairObstacle, null);
  // Incremental patching is still stopped: the analysis unblocked the fix, not the patch.
  assert.equal(plan.repairContainment.lineages[0].incrementalPatchAuthorized, false);
});

test('R5-B1-04 an analysis of a different root cause authorizes nothing here', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const elsewhere = analysed(CONTAINED(), { defectId: 'DEF-OTHER', rootCauseClass: 'RC-SOMETHING-ELSE', evidenceRef: 'test://other-analysis' });
  const plan = route(root, cas, { delta, graph, repairLedger: elsewhere, tasks: [structuralTask('t:structural-fix')] });
  assert.equal(taskOf(plan, 't:structural-fix').capability, 'BLOCKED');
  assert.equal(plan.repairContainment.lineages[0].rootCauseAnalyses, 0);
});

test('R5-B1-05 an analysis from a closed window does not authorize a later recurrence', () => {
  const { root, cas, delta, graph } = scenarioWith([resolutionNode('e:fixed', DEFECT)]);
  // Analysis -> verified structural resolution closes the window.
  let ledger = resolvedBy(analysed(CONTAINED()), graph, 'e:fixed');
  // The same root cause comes back and survives two fresh targeted attempts.
  ledger = survived(survived(ledger, { evidenceRef: 'test://recurrence-1' }), { evidenceRef: 'test://recurrence-2' });
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [structuralTask('t:structural-fix')] });
  const lineage = plan.repairContainment.lineages[0];
  assert.equal(lineage.containmentCount, 2);
  assert.equal(lineage.rootCauseAnalyses, 0, 'the earlier analysis belongs to the closed window');
  assert.equal(lineage.structuralRepairAuthorized, false);
  assert.equal(taskOf(plan, 't:structural-fix').capability, 'BLOCKED');
});

const OTHER_DEFECT = Object.freeze({ defectId: 'DEF-2', rootCauseClass: 'RC-CACHE-STALENESS' });

/** Routes a contained lineage that carries one structural RESOLVED claim. */
function resolutionOutcome({ nodes, evidenceId, resolutionEvidence }) {
  const { root, cas, delta, graph } = scenarioWith(nodes);
  const ledger = resolvedBy(analysed(CONTAINED()), graph, evidenceId, resolutionEvidence ? { resolutionEvidence: resolutionEvidence(graph) } : {});
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [repairTask('t:patch-3')] });
  return { plan, lineage: plan.repairContainment.lineages[0], task: taskOf(plan, 't:patch-3') };
}

test('R5-B2-01 evidence that really is about this root cause closes the lineage', () => {
  const { lineage, task } = resolutionOutcome({ nodes: [resolutionNode('e:fixed', DEFECT)], evidenceId: 'e:fixed' });
  assert.equal(lineage.verifiedResolutions, 1);
  assert.equal(lineage.containmentCount, 0);
  assert.equal(lineage.lineageState, 'NORMAL');
  assert.equal(task.capability, 'STANDARD_REASONING');
});

test('R5-B2-02 authentic evidence about a DIFFERENT root cause is refused', () => {
  const { lineage, task } = resolutionOutcome({ nodes: [resolutionNode('e:fixed', OTHER_DEFECT)], evidenceId: 'e:fixed' });
  assert.equal(lineage.verifiedResolutions, 0);
  assert.equal(lineage.incrementalPatchAuthorized, false);
  assert.equal(task.capability, 'BLOCKED');
});

test('R5-B2-03 an ordinary unrelated reusable node is refused', () => {
  // e:a is genuine, current and reusable — and says nothing about any root cause.
  const { lineage, task } = resolutionOutcome({ nodes: [], evidenceId: 'e:a' });
  assert.equal(lineage.verifiedResolutions, 0);
  assert.equal(lineage.lineageState, 'STOP_PATCH_CASCADE');
  assert.equal(task.capability, 'BLOCKED');
});

test('R5-B2-04 correct resolution content with a forged identity is refused', () => {
  const { lineage, task } = resolutionOutcome({
    nodes: [resolutionNode('e:fixed', DEFECT)],
    evidenceId: 'e:fixed',
    resolutionEvidence: () => ({ evidenceId: 'e:fixed', reuseIdentity: '0'.repeat(64) })
  });
  assert.equal(lineage.verifiedResolutions, 0);
  assert.equal(task.capability, 'BLOCKED');
});

test('R5-B2-05 correct content and identity on an INVALIDATED node is refused', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const nodes = [...rawNodes(), resolutionNode('e:fixed', DEFECT, 'src/b.json')];
  const unchanged = deltaOf(root);
  const bound = bindFreshValidations({ cas, nodes, r3Delta: unchanged, validationResults: Object.fromEntries(nodes.map((node) => [node.evidenceId, PASS])) });
  const graph = createEvidenceGraph({ cas, nodes: bound });
  const delta = deltaOf(root, () => fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":999}'));
  const ledger = resolvedBy(analysed(CONTAINED()), graph, 'e:fixed');
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [repairTask('t:patch-3'), ...producersFor('e:b', 'e:summary', 'e:fixed')] });
  assert.equal(plan.revalidationRequiredEvidenceIds.includes('e:fixed'), true);
  assert.equal(plan.repairContainment.lineages[0].verifiedResolutions, 0);
  assert.equal(taskOf(plan, 't:patch-3').capability, 'BLOCKED');
});

test('R5-B2-06 the right root cause but the wrong defect is refused', () => {
  const { lineage, task } = resolutionOutcome({
    nodes: [resolutionNode('e:fixed', { rootCauseClass: DEFECT.rootCauseClass, defectId: 'DEF-SOMEONE-ELSE' })],
    evidenceId: 'e:fixed'
  });
  assert.equal(lineage.verifiedResolutions, 0);
  assert.equal(task.capability, 'BLOCKED');
});

test('R5-B2-07 analysis then verified structural resolution closes the active lineage', () => {
  const { root, cas, delta, graph } = scenarioWith([resolutionNode('e:fixed', DEFECT)]);
  const analysedLedger = analysed(CONTAINED());
  const beforeFix = route(root, cas, { delta, graph, repairLedger: analysedLedger, tasks: [structuralTask('t:structural-fix')] });
  assert.equal(taskOf(beforeFix, 't:structural-fix').capability, 'STANDARD_REASONING');
  assert.equal(beforeFix.repairContainment.lineages[0].lineageState, 'STOP_PATCH_CASCADE');

  const afterFix = route(root, cas, { delta, graph, repairLedger: resolvedBy(analysedLedger, graph, 'e:fixed'), tasks: [repairTask('t:next-patch')] });
  assert.equal(afterFix.repairContainment.lineages[0].lineageState, 'NORMAL');
  assert.equal(afterFix.repairContainment.stopPatchCascade, false);
  assert.equal(taskOf(afterFix, 't:next-patch').capability, 'STANDARD_REASONING');
});

test('R5-B2-08 a recurrence after a verified closure starts a fresh containment window', () => {
  const { root, cas, delta, graph } = scenarioWith([resolutionNode('e:fixed', DEFECT)]);
  const closed = resolvedBy(analysed(CONTAINED()), graph, 'e:fixed');
  const recurred = survived(closed, { evidenceRef: 'test://recurrence' });
  const plan = route(root, cas, { delta, graph, repairLedger: recurred, tasks: [repairTask('t:patch-in-new-window')] });
  const lineage = plan.repairContainment.lineages[0];
  assert.equal(lineage.containmentCount, 1);
  assert.equal(lineage.lineageState, 'TARGETED_REPAIR_1');
  assert.equal(lineage.incrementalPatchAuthorized, true);
  assert.equal(taskOf(plan, 't:patch-in-new-window').containmentState, 'TARGETED_REPAIR_2');
  // Lifetime ordinals keep counting; only the containment window restarted.
  assert.equal(lineage.nextTargetedAttemptOrdinal, 4);
});

/* ============================================================================
 * Final baseline reinspection repairs.
 * D1 route precedence, D2 owner non-deferral, D3 task-inventory completeness,
 * D4 containment sequencing, D5 materialized route-plan canonical identity.
 * ========================================================================== */

const DISAGREEMENT = Object.freeze({ statement: 'two trusted sources disagree', sources: ['src/a.json'] });

/** A task whose produced evidence is reusable and whose source is unchanged — the shape reuse would otherwise skip. */
function reusableTask(taskId, extra = {}) {
  return { taskId, sources: ['src/a.json'], produces: ['e:a'], requiredEvidenceIds: ['e:a'], ...extra };
}

for (const intent of ['DETERMINISTIC', 'SEMANTIC', 'POLICY_DECISION']) {
  const label = { DETERMINISTIC: 'D1-01', SEMANTIC: 'D1-02', POLICY_DECISION: 'D1-04' }[intent];
  test(`R5-${label} a contradiction outranks upstream reuse for ${intent} work`, () => {
    const { root, cas, delta, graph } = unchangedScenario();
    const plan = route(root, cas, { delta, graph, tasks: [reusableTask('t:contradiction', { intent, contradiction: DISAGREEMENT })] });
    const task = taskOf(plan, 't:contradiction');
    assert.equal(task.capability, 'DEEP_REASONING');
    assert.deepEqual(task.reasonCodes, ['ARCHITECTURE_CONTRADICTION']);
    assert.equal(plan.routeDecision, 'DEEP_REASONING');
    assert.deepEqual(plan.avoidedTasks, []);
    assert.deepEqual(plan.qualityRequirements.contradictionTaskIds, ['t:contradiction']);
  });
}

test('R5-D1-03 a policy decision carrying a contradiction is analysed before it is escalated to the owner', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [{ taskId: 't:policy', intent: 'POLICY_DECISION', sources: ['src/a.json'], contradiction: DISAGREEMENT }]
  });
  assert.equal(taskOf(plan, 't:policy').capability, 'DEEP_REASONING');
  assert.deepEqual(plan.ownerDecisionTasks, []);
  assert.ok(taskOf(plan, 't:policy').reasonCodes.includes('ARCHITECTURE_CONTRADICTION'));
});

test('R5-D1-05 root-cause analysis required by a stopped cascade is never skipped by reuse', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: CONTAINED(),
    tasks: [reusableTask('t:rca', { intent: 'ROOT_CAUSE_ANALYSIS', repair: { ...DEFECT, incremental: false } })]
  });
  const task = taskOf(plan, 't:rca');
  assert.equal(task.capability, 'DEEP_REASONING');
  assert.ok(task.reasonCodes.includes('ROOT_CAUSE_ANALYSIS_REQUIRED_AFTER_CONTAINMENT'));
  assert.equal(plan.routeDecision, 'DEEP_REASONING');
  assert.deepEqual(plan.avoidedTasks, []);
  // The plan can no longer say "root-cause analysis required" and "no work" at once.
  const lineage = plan.repairContainment.lineages[0];
  assert.equal(lineage.requiredNextAction, 'ROOT_CAUSE_ANALYSIS');
  assert.equal(lineage.structuralRepairAuthorized, false);
});

test('R5-D1-06 ordinary expensive work with genuinely reusable evidence is still skipped', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [
      reusableTask('t:wide', { intent: 'SEMANTIC', architectureImpact: 'MULTI_LAYER', uncertainty: 'HIGH' }),
      { taskId: 't:exploratory', intent: 'ROOT_CAUSE_ANALYSIS', sources: ['src/b.json'], produces: ['e:b'], requiredEvidenceIds: ['e:b'] }
    ]
  });
  assert.deepEqual(plan.avoidedTasks, ['t:exploratory', 't:wide']);
  assert.equal(plan.routeDecision, 'NO_WORK_REQUIRED');
});

test('R5-D1-07 a contradiction on a blocked task stays visible instead of disappearing', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [{ taskId: 't:blocked-contradiction', intent: 'SEMANTIC', sources: ['src/a.json'], requiredEvidenceIds: ['e:absent'], contradiction: DISAGREEMENT }]
  });
  const task = taskOf(plan, 't:blocked-contradiction');
  assert.equal(task.capability, 'BLOCKED');
  assert.ok(task.reasonCodes.includes('ARCHITECTURE_CONTRADICTION'));
  assert.deepEqual(plan.qualityRequirements.contradictionTaskIds, ['t:blocked-contradiction']);
  assert.deepEqual(task.blockedBy, ['REQUIRED_EVIDENCE_MISSING:e:absent']);
});

test('R5-D2-01 an owner decision is never cost-deferred', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: VERY_LOW_CEILING,
    tasks: [{ taskId: 't:owner', intent: 'POLICY_DECISION', sources: ['src/a.json'] }]
  });
  const task = taskOf(plan, 't:owner');
  assert.equal(task.capability, 'OWNER_DECISION_REQUIRED');
  assert.equal(task.deferred, false);
  assert.equal(task.nonDeferrable, true);
  assert.ok(task.reasonCodes.includes('OWNER_DECISION_EXEMPT_FROM_COST_CEILING'));
  assert.equal(plan.routeDecision, 'OWNER_DECISION_REQUIRED');
  assert.deepEqual(plan.ownerDecisionTasks, ['t:owner']);
  assert.deepEqual(plan.deferredTasks, []);
});

test('R5-D2-02 ordinary model work above the same ceiling is still deferred', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: VERY_LOW_CEILING,
    tasks: [
      { taskId: 't:owner', intent: 'POLICY_DECISION', sources: ['src/a.json'] },
      { taskId: 't:wide', intent: 'SEMANTIC', sources: ['src/b.json'], architectureImpact: 'MULTI_LAYER' }
    ]
  });
  assert.deepEqual(plan.deferredTasks, ['t:wide']);
  assert.deepEqual(plan.ownerDecisionTasks, ['t:owner']);
});

test('R5-D2-03 the provider adapter needs no provider for an owner decision', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    policy: VERY_LOW_CEILING,
    tasks: [{ taskId: 't:owner', intent: 'POLICY_DECISION', sources: ['src/a.json'] }]
  });
  const resolved = resolveProviders(plan, createProviderMapping({ available: [] }));
  assert.equal(assignmentOf(resolved, 't:owner').status, 'NO_PROVIDER_REQUIRED');
  assert.equal(assignmentOf(resolved, 't:owner').provider, null);
  assert.deepEqual(resolved.unresolved, []);
  assert.deepEqual(resolved.deferred, []);
  assert.equal(resolved.executable, true);
});

test('R5-D3-01 revalidation work with no task able to produce it fails closed', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  assert.throws(() => route(root, cas, { delta, graph, tasks: [] }), /UNROUTED_REVALIDATION_REQUIRED:e:b,e:summary/);
});

test('R5-D3-02 a task that produces the invalidated evidence routes normally', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph, tasks: [verifyTask('t:b', 'src/b.json', 'e:b'), ...producersFor('e:summary')] });
  assert.equal(plan.routeDecision, 'LOCAL_DETERMINISTIC');
  assert.ok(plan.deterministicTasks.includes('t:b'));
});

test('R5-D3-03 partial coverage names exactly the uncovered evidence', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  assert.throws(
    () => route(root, cas, { delta, graph, tasks: [verifyTask('t:b', 'src/b.json', 'e:b')] }),
    /UNROUTED_REVALIDATION_REQUIRED:e:summary$/
  );
});

test('R5-D3-04 full coverage leaves existing behaviour unchanged', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.deepEqual(plan.deterministicTasks, ['t:b', 't:summary']);
  assert.deepEqual(plan.avoidedTasks, ['t:a']);
});

test('R5-D3-05 removed evidence needs no producer', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const surviving = bindFreshValidations({
    cas,
    nodes: rawNodes().filter((node) => node.evidenceId === 'e:a'),
    r3Delta: base.unchanged,
    validationResults: { 'e:a': PASS }
  });
  // e:b and e:summary are gone, so there is nothing left to revalidate for them.
  const plan = route(root, cas, {
    delta: base.unchanged,
    graph: createEvidenceGraph({ cas, nodes: surviving }),
    previousGraph: base.graph,
    tasks: []
  });
  assert.deepEqual(plan.removedEvidenceIds, ['e:b', 'e:summary']);
  assert.equal(plan.routeDecision, 'NO_WORK_REQUIRED');
});

test('R5-D3-06 an all-reusable graph with no tasks is still a valid empty route', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, tasks: [] });
  assert.equal(plan.routeDecision, 'NO_WORK_REQUIRED');
  assert.deepEqual(plan.revalidationRequiredEvidenceIds, []);
  assert.deepEqual(plan.tasks, []);
});

test('R5-D4-A01 an analysis before the containment-triggering failure does not satisfy the stop', () => {
  // targeted #1 survived -> analysis -> targeted #2 survived -> STOP
  const ledger = survived(analysed(survived(createRepairLedger())));
  const containment = evaluateContainment(ledger, DEFECT.rootCauseClass);
  assert.equal(containment.lineageState, 'STOP_PATCH_CASCADE');
  assert.equal(containment.rootCauseAnalyses, 1, 'the analysis is still in the active window');
  assert.equal(containment.postContainmentRootCauseAnalyses, 0, 'but it predates the stop');
  assert.equal(containment.structuralRepairAuthorized, false);
  assert.equal(containment.structuralRepairObstacle, 'ROOT_CAUSE_ANALYSIS_REQUIRED_BEFORE_STRUCTURAL_REPAIR');

  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [structuralTask('t:structural-fix')] });
  assert.equal(taskOf(plan, 't:structural-fix').capability, 'BLOCKED');
});

test('R5-D4-A02 an analysis after the stop does satisfy it', () => {
  const containment = evaluateContainment(analysed(CONTAINED()), DEFECT.rootCauseClass);
  assert.equal(containment.postContainmentRootCauseAnalyses, 1);
  assert.equal(containment.structuralRepairAuthorized, true);
  assert.equal(containment.structuralRepairObstacle, null);
});

test('R5-D4-A03 an analysis from a closed window cannot authorize a recurrence', () => {
  const { root, cas, delta, graph } = scenarioWith([resolutionNode('e:fixed', DEFECT)]);
  let ledger = resolvedBy(analysed(CONTAINED()), graph, 'e:fixed');
  ledger = survived(survived(ledger, { evidenceRef: 'test://r1' }), { evidenceRef: 'test://r2' });
  const plan = route(root, cas, { delta, graph, repairLedger: ledger, tasks: [structuralTask('t:structural-fix')] });
  const lineage = plan.repairContainment.lineages[0];
  assert.equal(lineage.rootCauseAnalyses, 0);
  assert.equal(lineage.postContainmentRootCauseAnalyses, 0);
  assert.equal(taskOf(plan, 't:structural-fix').capability, 'BLOCKED');
});

test('R5-D4-A04 an analysis of another root cause is still rejected', () => {
  const elsewhere = analysed(CONTAINED(), { defectId: 'DEF-OTHER', rootCauseClass: 'RC-SOMETHING-ELSE', evidenceRef: 'test://other' });
  const containment = evaluateContainment(elsewhere, DEFECT.rootCauseClass);
  assert.equal(containment.postContainmentRootCauseAnalyses, 0);
  assert.equal(containment.structuralRepairAuthorized, false);
});

test('R5-D4-B01 two targeted attempts on one root cause in one request are rejected', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  assert.throws(
    () => route(root, cas, { delta, graph, tasks: [repairTask('t:1'), repairTask('t:2', { sources: ['src/b.json'] })] }),
    new RegExp(`MULTIPLE_TARGETED_REPAIR_ATTEMPTS_REQUIRE_SEQUENTIAL_HISTORY:${DEFECT.rootCauseClass}`)
  );
});

test('R5-D4-B02 the same rejection applies after one survived attempt', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  assert.throws(
    () => route(root, cas, { delta, graph, repairLedger: survived(createRepairLedger()), tasks: [repairTask('t:1'), repairTask('t:2', { sources: ['src/b.json'] })] }),
    /MULTIPLE_TARGETED_REPAIR_ATTEMPTS_REQUIRE_SEQUENTIAL_HISTORY/
  );
  // One attempt at a time remains perfectly routable.
  const plan = route(root, cas, { delta, graph, repairLedger: survived(createRepairLedger()), tasks: [repairTask('t:1')] });
  assert.equal(taskOf(plan, 't:1').containmentState, 'TARGETED_REPAIR_2');
});

test('R5-D4-B03 targeted attempts on independent root causes remain allowed together', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    tasks: [repairTask('t:1'), { taskId: 't:2', intent: 'SEMANTIC', sources: ['src/b.json'], repair: { defectId: 'DEF-2', rootCauseClass: 'RC-OTHER', incremental: true } }]
  });
  assert.equal(taskOf(plan, 't:1').capability, 'STANDARD_REASONING');
  assert.equal(taskOf(plan, 't:2').capability, 'STANDARD_REASONING');
  assert.equal(plan.repairContainment.lineages.length, 2);
});

test('R5-D4-B04 non-repair tasks are unaffected by the sequencing rule', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.deepEqual(plan.deterministicTasks, ['t:b', 't:summary']);
});

test('R5-D4-B05 several structural tasks for one root cause are not targeted attempts', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  const plan = route(root, cas, {
    delta,
    graph,
    repairLedger: analysed(CONTAINED()),
    tasks: [structuralTask('t:structural-1'), structuralTask('t:structural-2', { sources: ['src/b.json'] })]
  });
  assert.equal(taskOf(plan, 't:structural-1').capability, 'STANDARD_REASONING');
  assert.equal(taskOf(plan, 't:structural-2').capability, 'STANDARD_REASONING');
  assert.equal(plan.repairContainment.lineages[0].incrementalPatchAuthorized, false);
});

/** A canonical NFC id and the Unicode-equivalent decomposed form of the same text. */
const NFC_TASK_ID = 't:\u00e9';
const NFD_TASK_ID = 't:e\u0301';

function nonAsciiPlan() {
  const { root, cas, delta, graph } = unchangedScenario();
  return { root, cas, delta, graph, plan: route(root, cas, { delta, graph, tasks: [reusableTask(NFC_TASK_ID, { intent: 'DETERMINISTIC' })] }) };
}

test('R5-D5-01 a canonical non-ASCII task id is valid', () => {
  const { plan } = nonAsciiPlan();
  assert.equal(validateRoutePlan(plan).valid, true);
  assert.deepEqual(plan.avoidedTasks, [NFC_TASK_ID]);
  assert.equal(verifyRoutePlanDigest(plan), true);
});

test('R5-D5-02 a decomposed runtime task id is rejected even though the digest still verifies', () => {
  const { plan } = nonAsciiPlan();
  const mutated = { ...plan, tasks: [{ ...plan.tasks[0], taskId: NFD_TASK_ID }] };
  // The digest cannot see the difference: canonical-json hashes both as NFC.
  assert.equal(verifyRoutePlanDigest(mutated), true);
  assert.equal(routePlanSha256(mutated), plan.routeSha256);
  // Validation can, and must.
  const result = validateRoutePlan(mutated);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.reason === 'NON_CANONICAL_TASK_ID'));
});

test('R5-D5-03 the provider boundary rejects the same plan before assigning anything', () => {
  const { plan } = nonAsciiPlan();
  const mutated = { ...plan, tasks: [{ ...plan.tasks[0], taskId: NFD_TASK_ID }] };
  assert.throws(() => resolveProviders(mutated, createProviderMapping({})), /INVALID_ROUTE_PLAN:\/tasks\/0\/taskId:NON_CANONICAL_TASK_ID/);
});

test('R5-D5-04 a non-canonical or dangling top-level task reference is rejected', () => {
  const { plan } = nonAsciiPlan();
  const decomposedReference = { ...plan, avoidedTasks: [NFD_TASK_ID] };
  assert.ok(validateRoutePlan(decomposedReference).errors.some((error) => error.reason === 'NON_CANONICAL_TASK_REFERENCE'));
  const dangling = { ...plan, deterministicTasks: ['t:nowhere'] };
  assert.ok(validateRoutePlan(dangling).errors.some((error) => error.reason === 'UNKNOWN_TASK_REFERENCE'));
});

test('R5-D5-05 two task ids collapsing to one canonical identity are rejected', () => {
  const { plan } = nonAsciiPlan();
  const collapsing = { ...plan, tasks: [plan.tasks[0], { ...plan.tasks[0], taskId: NFD_TASK_ID }] };
  assert.equal(validateRoutePlan(collapsing).valid, false);
  const duplicated = { ...plan, tasks: [plan.tasks[0], { ...plan.tasks[0] }] };
  assert.ok(validateRoutePlan(duplicated).errors.some((error) => error.reason === 'DUPLICATE_TASK_ID'));
});

test('R5-D5-06 an untouched canonical non-ASCII plan survives a JSON round-trip', () => {
  const { plan } = nonAsciiPlan();
  const revived = JSON.parse(JSON.stringify(plan));
  assert.equal(validateRoutePlan(revived).valid, true);
  assert.equal(routePlanSha256(revived), plan.routeSha256);
  assert.deepEqual(resolveProviders(revived, createProviderMapping({})).assignments.map((assignment) => assignment.taskId), [NFC_TASK_ID]);
});

test('R5-D5-07 a separate process reproduces the same non-ASCII task identity and digest', () => {
  const { root, cas, delta, graph, plan } = nonAsciiPlan();
  const payload = path.join(root, 'nfc-payload.json');
  fs.writeFileSync(payload, JSON.stringify({
    casRoot: path.join(root, 'cas'),
    workUnitId: SYNTHETIC_WORK_UNIT,
    tasks: [reusableTask(NFC_TASK_ID, { intent: 'DETERMINISTIC' })],
    r2Context: contextFor(root),
    r3Delta: delta,
    graph
  }));
  const runner = path.join(root, 'nfc-runner.mjs');
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const router = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/router/router-engine.mjs'))}).href);
const cas = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/cas/content-addressed-store.mjs'))}).href);
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, 'utf8'));
const plan = router.routeWorkUnit({
  workUnitId: payload.workUnitId,
  tasks: payload.tasks,
  r2Context: payload.r2Context,
  r3Delta: payload.r3Delta,
  r4Evidence: { graph: payload.graph },
  cas: cas.createContentAddressedStore(payload.casRoot)
});
process.stdout.write(JSON.stringify({ routeSha256: plan.routeSha256, taskIds: plan.tasks.map((task) => task.taskId), valid: router.validateRoutePlan(plan).valid }));
`);
  const observed = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }));
  assert.equal(observed.routeSha256, plan.routeSha256);
  assert.deepEqual(observed.taskIds, [NFC_TASK_ID]);
  assert.equal(observed.valid, true);
});

test('R5-D5-08 ASCII plans and the C1/C2 boundary behave exactly as before', () => {
  const { root, cas, delta, graph } = mutatedBScenario();
  const plan = route(root, cas, { delta, graph });
  assert.equal(validateRoutePlan(plan).valid, true);
  const resolved = resolveProviders(plan, createProviderMapping({}));
  assert.deepEqual(resolved.assigned, ['t:b', 't:summary']);
  assert.deepEqual(resolved.deferred, []);
  assert.equal(resolved.executable, true);
  assert.throws(() => resolveProviders({ ...plan, routeSha256: '0'.repeat(64) }, createProviderMapping({})), /INVALID_ROUTE_PLAN_DIGEST/);
});

test('R5-A4 every artifact R5 writes is inside the R0005 write scope', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0005.json'), 'utf8'));
  // Derived from the contract itself, plus the artifacts a contract cannot list
  // among its own requiredArtifacts.
  const written = [
    ...contract.requiredArtifacts,
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0005.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0005_SEAL.json',
    'governance/gee-v1/tests/gee-foundation-work-unit-authority.test.mjs',
    'governance/gee-v1/tests/gee-r4-evidence-graph.test.mjs'
  ];
  for (const artifact of written) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, ...artifact.split('/'))), true, `exists ${artifact}`);
    assert.equal(isPathAuthorized(contract.authorizedPaths, artifact), true, `authorized ${artifact}`);
  }
  // The scope must stay narrow: no frozen R1-R4 artifact may fall inside it.
  for (const frozen of [
    'governance/gee-v1/core/work-unit-core.mjs',
    'governance/gee-v1/context/compile-context.mjs',
    'governance/gee-v1/delta/delta-engine.mjs',
    'governance/gee-v1/evidence/evidence-graph.mjs',
    'governance/gee-v1/cas/content-addressed-store.mjs',
    'governance/gee-v1/schemas/context-bundle.schema.json',
    'governance/gee-v1/missions/GEE_V1_STRATEGIC_CONTRACT.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004.json',
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0004_SEAL.json',
    'governance/gee-v1/tests/gee-r3-delta-engine.test.mjs',
    'governance/gee-v1/tests/gee-r2-context-compiler.test.mjs'
  ]) {
    assert.equal(isPathAuthorized(contract.authorizedPaths, frozen), false, `out of scope ${frozen}`);
  }
});

test('R5-R2B the routed work unit and the compiled context must name the same work unit', () => {
  const { root, cas, delta, graph } = unchangedScenario();
  assert.equal(route(root, cas, { delta, graph }).provenance.r2WorkUnitId, SYNTHETIC_WORK_UNIT);
  assert.throws(
    () => route(root, cas, { delta, graph, workUnitId: 'SOME_OTHER_WORK_UNIT' }),
    /R2_CONTEXT_WORK_UNIT_MISMATCH:SOME_OTHER_WORK_UNIT!=SYNTH_01/
  );
  const context = contextFor(root);
  assert.throws(
    () => route(root, cas, { delta, graph, r2Context: { ...context, identity: { ...context.identity, workUnitId: 'RENAMED' } } }),
    /R5-R2B|R2_CONTEXT_WORK_UNIT_MISMATCH/
  );
});

test('R5-H15 R6 and later remain unauthorized while R5 is the sealed frontier', () => {
  const wheelAdapter = createWheelProjectAdapter(REPO_ROOT);
  const registry = createExecutionAuthorityRegistry([
    createGeeMissionAuthoritySource(REPO_ROOT, {
      projectId: 'WHEEL',
      prerequisiteResolvers: { 'wheel-adapter-status': (prerequisite) => wheelAdapter.resolvePrerequisite(prerequisite.id, prerequisite) }
    })
  ]);
  const r5 = resolveExecutionAuthority({ projectId: 'WHEEL', workUnitType: MISSION_WORK_UNIT_TYPE, workUnitId: 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R5', registry });
  assert.equal(r5.executionAuthorized, true);
  assert.equal(r5.decision, 'AUTHORIZED');
  for (const later of ['R6', 'R7', 'R8']) {
    const result = resolveExecutionAuthority({ projectId: 'WHEEL', workUnitType: MISSION_WORK_UNIT_TYPE, workUnitId: `GOVERNANCE_EXECUTION_EFFICIENCY_V1_${later}`, registry });
    assert.equal(result.executionAuthorized, false, later);
    assert.ok(result.findings.some((finding) => finding.code === 'UNKNOWN_WORK_UNIT_ID'), later);
  }
});
