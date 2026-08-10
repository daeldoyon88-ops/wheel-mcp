import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveBenchmarkMetrics,
  deriveEfficiencyPredicate,
  evaluateHostileOutcome,
  evaluateR7Closure,
  evaluateRouteExpectation,
  qualityParity
} from '../evals/gee-r7-runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(ROOT, ...relativePath.split('/')), 'utf8'));

const evalArtifact = () => readJson('governance/gee-v1/evals/gee-r7-eval-suite.json');
const benchmarkArtifact = () => readJson('governance/gee-v1/benchmarks/gee-r7-benchmark.json');
const recoveryArtifact = () => readJson('governance/gee-v1/benchmarks/gee-r7-recovery-stress.json');
const hostileArtifact = () => readJson('governance/gee-v1/benchmarks/gee-r7-hostile-audit.json');
const closureArtifact = () => readJson('governance/gee-v1/benchmarks/gee-r7-closure.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function benchmarkWithRaw(changes) {
  const benchmark = clone(benchmarkArtifact());
  const raw = { ...benchmark.rawMetrics, ...changes };
  benchmark.rawMetrics = raw;
  benchmark.baseline = {
    ...benchmark.baseline,
    contextBytes: raw.baseline_context_bytes,
    sourceBytesProcessed: raw.baseline_source_bytes_processed,
    filesProcessed: raw.baseline_files_processed,
    tasksExecuted: raw.baseline_tasks_executed,
    evidenceReused: raw.baseline_evidence_reused,
    revalidationWork: raw.baseline_revalidation_work
  };
  benchmark.gee = {
    ...benchmark.gee,
    contextBytes: raw.gee_context_bytes,
    sourceBytesProcessed: raw.gee_source_bytes_processed,
    filesProcessed: raw.gee_files_processed,
    tasksExecuted: raw.gee_tasks_executed,
    evidenceReused: raw.gee_evidence_reused,
    revalidationWork: raw.gee_revalidation_work
  };
  benchmark.metrics = deriveBenchmarkMetrics(raw, {
    routingEfficiency: benchmark.routing?.NO_WORK_REQUIRED === 1,
    qualityParityResult: benchmark.quality?.parity === true
  });
  return benchmark;
}

test('A1-01/A1-02 expected and observed routes are enforced', () => {
  assert.equal(evaluateRouteExpectation({ expectedRoute: 'LOCAL_DETERMINISTIC', observedRoute: 'NO_WORK_REQUIRED' }).pass, false);
  assert.equal(evaluateRouteExpectation({ expectedRoute: 'LOCAL_DETERMINISTIC', observedRoute: 'LOCAL_DETERMINISTIC' }).pass, true);
});

test('A1-03/A1-04/A1-05 E07 records real execution and derives its verdict', () => {
  const e07 = evalArtifact().evals.find((entry) => entry.id === 'E07');
  assert.equal(e07.verdict, 'PASS');
  assert.equal(e07.routeExpectation, true);
  assert.ok(e07.usage.tasksExecuted > 0);
  assert.equal(e07.quality.observed.avoidedNotExecuted, true);
  assert.equal(evaluateRouteExpectation({ expectedRoute: e07.expectedRoute, observedRoute: 'NO_WORK_REQUIRED', observedPass: true, qualityPass: true }).pass, false);
});

test('A2-01..A2-06 recovery reports canonical R6 semantics', () => {
  const recovery = recoveryArtifact();
  assert.ok(recovery.completedBeforeInterrupt > 0);
  assert.ok(recovery.completedPreserved > 0);
  assert.ok(recovery.tasksInvalidated > 0);
  assert.equal(recovery.avoidedNotCountedAsPreserved, true);
  assert.equal(recovery.decision, recovery.canonicalDecision);
  assert.equal(recovery.restartedFromZero, recovery.canonicalRestartedFromZero);
  assert.equal(recovery.unrelatedChangePreserved, true);
  assert.equal(recovery.usageDuplicates, 0);
});

test('A3A-01..A3A-05 benchmark raw measurements and percentages are reproducible', () => {
  const benchmark = benchmarkArtifact();
  const raw = benchmark.rawMetrics;
  assert.equal(benchmark.measurements.baseline.contextBytes.source, 'R6_USAGE_LEDGER_AGGREGATE');
  assert.equal(benchmark.measurements.gee.contextBytes.source, 'R6_USAGE_LEDGER_AGGREGATE');
  assert.equal(benchmark.measurements.baseline.contextBytes.source, benchmark.measurements.gee.contextBytes.source);
  assert.notEqual(raw.baseline_context_bytes, raw.gee_context_bytes * raw.baseline_tasks_executed);
  assert.deepEqual(deriveBenchmarkMetrics(raw, { routingEfficiency: true, qualityParityResult: true }), benchmark.metrics);
  assert.equal(deriveBenchmarkMetrics({ ...raw, baseline_context_bytes: 0, gee_context_bytes: 0 }, { routingEfficiency: true, qualityParityResult: true }).contextReduction, null);
  assert.equal(raw.tokens, 'TOKEN_COUNT_UNAVAILABLE');
});

test('A3B-01..A3B-05 quality parity compares canonical content and outcomes', () => {
  const benchmark = benchmarkArtifact();
  const base = benchmark.quality.baseline;
  assert.equal(qualityParity(base, benchmark.quality.gee), true);

  const changedFact = clone(base); changedFact.facts[0].value = 'CHANGED';
  const changedEvidence = clone(base); changedEvidence.evidence[0].reuseIdentity = '0'.repeat(64);
  const changedValidation = clone(base); changedValidation.evidence[0].producingValidation.result = 'FAIL';
  const missingDefectDetection = clone(base); missingDefectDetection.activeDefectsOrBlockers = null;
  assert.equal(qualityParity(base, changedFact), false);
  assert.equal(qualityParity(base, changedEvidence), false);
  assert.equal(qualityParity(base, changedValidation), false);
  assert.equal(qualityParity(base, missingDefectDetection), false);
  assert.equal(qualityParity(base, clone(base)), true);
});

test('A4 hostile verdicts require both invariant preservation and intended reason', () => {
  const hostile = hostileArtifact();
  for (const id of ['H03', 'H04', 'H06', 'H07', 'H08', 'H14', 'H15', 'H18']) {
    const attack = hostile.attacks.find((entry) => entry.id === id);
    assert.equal(attack.verdict, 'PASS');
    assert.equal(attack.invariantPreserved, true);
    assert.equal(attack.reasonMatches, true);
  }
  assert.equal(evaluateHostileOutcome({ invariantPreserved: true, reasonMatches: false }), false);
});

test('A5-01..A5-08 closure predicates are derived and fail closed', () => {
  const closure = closureArtifact();
  const inputs = {
    authority: closure.authorityScope.authority,
    evals: evalArtifact(),
    benchmark: benchmarkArtifact(),
    recovery: recoveryArtifact(),
    hostile: hostileArtifact(),
    artifactsPresent: true
  };
  assert.equal(evaluateR7Closure(inputs).readyToFreeze, true);

  const evalFailure = clone(inputs); evalFailure.evals.evals[0].verdict = 'FAIL'; evalFailure.evals.pass = 9; evalFailure.evals.fail = 1;
  const hostileInvalid = clone(inputs); hostileInvalid.hostile.attacks[0].reasonMatches = false; hostileInvalid.hostile.attacks[0].verdict = 'FAIL'; hostileInvalid.hostile.invalid = 1; hostileInvalid.hostile.fail = 1;
  const qualityFailure = clone(inputs); qualityFailure.benchmark.quality.parity = false;
  const recoveryContradiction = clone(inputs); recoveryContradiction.recovery.restartedFromZero = true;
  const benchmarkTamper = clone(inputs); benchmarkTamper.benchmark.rawMetrics.baseline_context_bytes += 1;
  const materialDefect = clone(inputs); materialDefect.hostile.materialDefects = ['MATERIAL_DEFECT'];
  assert.equal(evaluateR7Closure(evalFailure).readyToFreeze, false);
  assert.equal(evaluateR7Closure(hostileInvalid).readyToFreeze, false);
  assert.equal(evaluateR7Closure(qualityFailure).readyToFreeze, false);
  assert.equal(evaluateR7Closure(recoveryContradiction).readyToFreeze, false);
  assert.equal(evaluateR7Closure(benchmarkTamper).readyToFreeze, false);
  assert.equal(evaluateR7Closure({ ...inputs, artifactsPresent: false }).readyToFreeze, false);
  assert.equal(evaluateR7Closure(materialDefect).readyToFreeze, false);
});

test('R2-A5 efficiency closure rejects absent or non-selective measured gains', () => {
  const closure = closureArtifact();
  const inputs = {
    authority: closure.authorityScope.authority,
    evals: evalArtifact(),
    benchmark: benchmarkArtifact(),
    recovery: recoveryArtifact(),
    hostile: hostileArtifact(),
    artifactsPresent: true
  };
  assert.equal(deriveEfficiencyPredicate(inputs.benchmark), true);
  assert.equal(evaluateR7Closure(inputs).predicates.efficiencyDerived, true);

  const equalBaselineGee = benchmarkWithRaw({
    gee_context_bytes: inputs.benchmark.rawMetrics.baseline_context_bytes,
    gee_source_bytes_processed: inputs.benchmark.rawMetrics.baseline_source_bytes_processed,
    gee_files_processed: inputs.benchmark.rawMetrics.baseline_files_processed,
    gee_tasks_executed: inputs.benchmark.rawMetrics.baseline_tasks_executed,
    gee_revalidation_work: inputs.benchmark.rawMetrics.baseline_revalidation_work,
    gee_evidence_reused: inputs.benchmark.rawMetrics.baseline_evidence_reused
  });
  assert.equal(evaluateR7Closure({ ...inputs, benchmark: equalBaselineGee }).readyToFreeze, false);

  const allZero = benchmarkWithRaw({
    baseline_context_bytes: 0,
    gee_context_bytes: 0,
    baseline_source_bytes_processed: 0,
    gee_source_bytes_processed: 0,
    baseline_files_processed: 0,
    gee_files_processed: 0,
    baseline_tasks_executed: 0,
    gee_tasks_executed: 0,
    baseline_evidence_reused: 0,
    gee_evidence_reused: 0,
    baseline_revalidation_work: 0,
    gee_revalidation_work: 0
  });
  assert.equal(allZero.metrics.contextReduction, null);
  assert.equal(evaluateR7Closure({ ...inputs, benchmark: allZero }).readyToFreeze, false);

  const processingUnchanged = benchmarkWithRaw({
    gee_source_bytes_processed: inputs.benchmark.rawMetrics.baseline_source_bytes_processed
  });
  assert.equal(evaluateR7Closure({ ...inputs, benchmark: processingUnchanged }).readyToFreeze, false);

  const tasksUnchanged = benchmarkWithRaw({
    gee_tasks_executed: inputs.benchmark.rawMetrics.baseline_tasks_executed
  });
  assert.equal(evaluateR7Closure({ ...inputs, benchmark: tasksUnchanged }).readyToFreeze, false);

  const noB2Selectivity = clone(inputs.benchmark);
  noB2Selectivity.scenarios.B2_SMALL_RELEVANT_MUTATION.tasksAvoided = 0;
  assert.equal(evaluateR7Closure({ ...inputs, benchmark: noB2Selectivity }).readyToFreeze, false);

  const b3ExecutesWork = clone(inputs.benchmark);
  b3ExecutesWork.scenarios.B3_UNRELATED_MUTATION.tasksExecuted = 1;
  assert.equal(evaluateR7Closure({ ...inputs, benchmark: b3ExecutesWork }).readyToFreeze, false);

  const qualityWithoutEfficiency = benchmarkWithRaw({
    gee_context_bytes: inputs.benchmark.rawMetrics.baseline_context_bytes,
    gee_source_bytes_processed: inputs.benchmark.rawMetrics.baseline_source_bytes_processed,
    gee_files_processed: inputs.benchmark.rawMetrics.baseline_files_processed,
    gee_tasks_executed: inputs.benchmark.rawMetrics.baseline_tasks_executed,
    gee_revalidation_work: inputs.benchmark.rawMetrics.baseline_revalidation_work,
    gee_evidence_reused: inputs.benchmark.rawMetrics.baseline_evidence_reused
  });
  assert.equal(qualityWithoutEfficiency.quality.parity, true);
  assert.equal(evaluateR7Closure({ ...inputs, benchmark: qualityWithoutEfficiency }).readyToFreeze, false);
});
