import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createWheelContextAdapter } from '../adapters/wheel/context-wheel-adapter.mjs';
import { REPO_ROOT, runAll, runBenchmark } from '../evals/gee-r7-runner.mjs';

const canonicalBenchmarkPath = path.join(REPO_ROOT, 'governance', 'gee-v1', 'benchmarks', 'gee-r7-benchmark.json');
const ledgerPath = path.join(REPO_ROOT, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tempOutputRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r7-benchmark-test-'));
const benchmarkPath = (root) => path.join(root, 'governance', 'gee-v1', 'benchmarks', 'gee-r7-benchmark.json');
const jsonValue = (value) => JSON.parse(JSON.stringify(value));
const writeWitness = (root, pinnedLedgerSha256, ref) => {
  const witnessPath = path.join(root, `${ref}.json`);
  fs.writeFileSync(witnessPath, JSON.stringify({ witnesses: [{ kind: 'PROJECT_OWNER_DOCUMENT', verified: true, pinnedLedgerSha256, ref }] }, null, 2));
  return witnessPath;
};
const envState = () => ({
  present: Object.prototype.hasOwnProperty.call(process.env, 'GEE_HEAD_WITNESS_SOURCE'),
  value: process.env.GEE_HEAD_WITNESS_SOURCE
});
const assertEnvState = (expected) => assert.deepEqual(envState(), expected);
const stableBenchmarkOutcomes = (value) => ({
  metrics: value.metrics,
  routing: value.routing,
  quality: {
    parity: value.quality?.parity,
    baseline: {
      activeDefectsOrBlockers: value.quality?.baseline?.activeDefectsOrBlockers,
      successConditions: value.quality?.baseline?.successConditions,
      qualityRequirements: value.quality?.baseline?.qualityRequirements
    },
    gee: {
      activeDefectsOrBlockers: value.quality?.gee?.activeDefectsOrBlockers,
      successConditions: value.quality?.gee?.successConditions,
      qualityRequirements: value.quality?.gee?.qualityRequirements
    }
  }
});

test('R7 before-after benchmark measures unchanged, relevant, unrelated, routing and quality scenarios', () => {
  const canonicalBefore = hashFile(canonicalBenchmarkPath);
  const originalEnv = envState();
  const witnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r7-witness-test-'));
  try {
    delete process.env.GEE_HEAD_WITNESS_SOURCE;
    const noWitnessRoot = tempOutputRoot();
    const noWitness = runBenchmark({ outputRoot: noWitnessRoot });
    const noWitnessHash = hashFile(benchmarkPath(noWitnessRoot));
    assert.equal(noWitness.benchmarkEnvironment.headWitnessSource, 'NEUTRALIZED_FOR_CANONICAL_BENCHMARK');
    assertEnvState({ present: false, value: undefined });

    const validWitnessPath = writeWitness(witnessRoot, hashFile(ledgerPath), 'R7_VALID_EXTERNAL');
    process.env.GEE_HEAD_WITNESS_SOURCE = validWitnessPath;
    const externalView = createWheelContextAdapter(REPO_ROOT).getWorkUnitView('GATE13');
    assert.equal(externalView.state.trustLevel, 'ANCHORED_EXTERNAL');
    assert.equal(externalView.closure.gateCompleteConfirmed, true);
    const validRoot = tempOutputRoot();
    const validWitness = runBenchmark({ outputRoot: validRoot });
    assert.deepEqual(jsonValue(validWitness), jsonValue(noWitness));
    assert.equal(hashFile(benchmarkPath(validRoot)), noWitnessHash);
    assertEnvState({ present: true, value: validWitnessPath });

    const staleWitnessPath = writeWitness(witnessRoot, '0'.repeat(64), 'R7_STALE_EXTERNAL');
    process.env.GEE_HEAD_WITNESS_SOURCE = staleWitnessPath;
    const staleRoot = tempOutputRoot();
    const staleWitness = runBenchmark({ outputRoot: staleRoot });
    assert.deepEqual(jsonValue(staleWitness), jsonValue(noWitness));
    assert.equal(hashFile(benchmarkPath(staleRoot)), noWitnessHash);
    assertEnvState({ present: true, value: staleWitnessPath });

    delete process.env.GEE_HEAD_WITNESS_SOURCE;
    const result = runBenchmark();
    const second = runBenchmark();
    assert.deepEqual(second, result);
    if (result.metrics.qualityParity !== true) throw new Error('R7_QUALITY_PARITY_FAILURE');
    if (result.baseline.tasksExecuted <= result.gee.tasksExecuted) throw new Error('R7_NO_TASK_REDUCTION');
    if (result.scenarios.B2_SMALL_RELEVANT_MUTATION.tasksAvoided <= 0) throw new Error('R7_NO_SELECTIVE_REUSE');
    if (result.scenarios.B3_UNRELATED_MUTATION.tasksExecuted !== 0) throw new Error('R7_UNRELATED_MUTATION_IMPACT');
    assertEnvState({ present: false, value: undefined });

    const temporaryRoot = tempOutputRoot();
    const temporaryResult = runBenchmark({ outputRoot: temporaryRoot });
    assert.deepEqual(JSON.parse(fs.readFileSync(benchmarkPath(temporaryRoot), 'utf8')), jsonValue(temporaryResult));
    assert.equal(hashFile(canonicalBenchmarkPath), canonicalBefore);

    const allRoot = tempOutputRoot();
    runAll({ outputRoot: allRoot });
    assert.deepEqual(JSON.parse(fs.readFileSync(benchmarkPath(allRoot), 'utf8')), jsonValue(result));

    const childRoot = tempOutputRoot();
    const runnerUrl = pathToFileURL(path.join(REPO_ROOT, 'governance', 'gee-v1', 'evals', 'gee-r7-runner.mjs')).href;
    const childSource = `import { runBenchmark } from ${JSON.stringify(runnerUrl)}; runBenchmark({ outputRoot: process.argv[1] });`;
    const childWithoutWitnessEnv = { ...process.env };
    delete childWithoutWitnessEnv.GEE_HEAD_WITNESS_SOURCE;
    execFileSync(process.execPath, ['--input-type=module', '-e', childSource, childRoot], { cwd: REPO_ROOT, env: childWithoutWitnessEnv, stdio: 'pipe' });
    assert.deepEqual(JSON.parse(fs.readFileSync(benchmarkPath(childRoot), 'utf8')), jsonValue(result));

    const validChildRoot = tempOutputRoot();
    execFileSync(process.execPath, ['--input-type=module', '-e', childSource, validChildRoot], { cwd: REPO_ROOT, env: { ...process.env, GEE_HEAD_WITNESS_SOURCE: validWitnessPath }, stdio: 'pipe' });
    assert.equal(hashFile(benchmarkPath(validChildRoot)), hashFile(benchmarkPath(childRoot)));

    const canonicalValue = JSON.parse(fs.readFileSync(canonicalBenchmarkPath, 'utf8'));
    // The frozen artifact remains historical. Current replay provenance legitimately binds the
    // 56-event ledger, so compare only stable benchmark outcomes and quality conclusions.
    assert.deepEqual(stableBenchmarkOutcomes(canonicalValue), stableBenchmarkOutcomes(result));
    assert.equal(hashFile(canonicalBenchmarkPath), canonicalBefore);

    const failedRoot = tempOutputRoot();
    assert.throws(() => {
      const failedResult = runBenchmark({ outputRoot: failedRoot });
      assert.equal(failedResult.metrics.taskReuse, -1);
    });
    assert.equal(hashFile(canonicalBenchmarkPath), canonicalBefore);
  } finally {
    if (originalEnv.present) process.env.GEE_HEAD_WITNESS_SOURCE = originalEnv.value;
    else delete process.env.GEE_HEAD_WITNESS_SOURCE;
    assertEnvState(originalEnv);
    fs.rmSync(witnessRoot, { recursive: true, force: true });
  }
});
