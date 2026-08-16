import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createWheelContextAdapter } from '../adapters/wheel/context-wheel-adapter.mjs';
import {
  REPO_ROOT, R7_BENCHMARK_CONTEXT_PATH, runAll, runBenchmark,
  validateR7HistoricalBenchmarkContext, validateR7CurrentStateBinding
} from '../evals/gee-r7-runner.mjs';
import { RUN_STATE_COMPLETED, allocateRunRoot, releaseRunRoot } from '../runtime/run-root-lifecycle.mjs';
import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { evaluatePostFreezeMaintenanceAuthorityV2, PHASE_VERIFY_PROGRAM_CONSUMPTION } from '../core/post-freeze-maintenance-authority.mjs';
import { collectPostFreezeMaintenanceObservation, resolveMaintenancePath } from '../../tools/post-freeze-maintenance-observation.mjs';

const canonicalBenchmarkPath = path.join(REPO_ROOT, 'governance', 'gee-v1', 'benchmarks', 'gee-r7-benchmark.json');
const ledgerPath = path.join(REPO_ROOT, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Output roots for this test.
 *
 * Each `runBenchmark({ outputRoot })` below needs its own writable tree, and
 * nine of them were previously allocated with a bare `mkdtemp` and never
 * removed — a leak adjacent to the runner's own, and invisible because the
 * assertions only ever read back what had just been written. They now go
 * through the canonical run-root lifecycle and are released together in the
 * test's `finally`, so a failing assertion cannot skip the cleanup either.
 */
const allocatedOutputRuns = [];
const tempOutputRoot = () => {
  const run = allocateRunRoot({
    repoRoot: REPO_ROOT,
    workUnitId: 'GATE15',
    phase: 'R7_BENCHMARK_TEST',
    purpose: 'R7_BENCHMARK_TEST_OUTPUT',
    consumer: 'governance/gee-v1/tests/gee-r7-benchmark.test.mjs',
    failurePolicy: 'DISCARD'
  });
  allocatedOutputRuns.push(run);
  return run.scratch('work');
};
const releaseOutputRoots = () => {
  while (allocatedOutputRuns.length) {
    releaseRunRoot(allocatedOutputRuns.pop(), { state: RUN_STATE_COMPLETED, reason: 'BENCHMARK_TEST_COMPLETED', repoRoot: REPO_ROOT });
  }
};
const benchmarkPath = (root) => path.join(root, 'governance', 'gee-v1', 'benchmarks', 'gee-r7-benchmark.json');
const jsonValue = (value) => JSON.parse(JSON.stringify(value));
const clone = (value) => JSON.parse(JSON.stringify(value));
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

const fixtureBytes = () => fs.readFileSync(path.join(REPO_ROOT, ...R7_BENCHMARK_CONTEXT_PATH.split('/')));
const canonicalFixture = () => JSON.parse(fixtureBytes().toString('utf8'));
const findings = (result) => result.findings.join(',');
const AUTHORITY_DIR = path.join(REPO_ROOT, 'governance', 'sources');
const HISTORY_DIR = 'governance/historical-architecture';
const BINDING_AUTHORITY = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_R7_HISTORICAL_PERMANENCE_R1.json';

/**
 * Re-seal a tampered fixture the way a competent attacker would: recompute the
 * inner digest over the edited context, then the outer identity digest over the
 * whole body. The result is perfectly self-consistent — which is exactly why
 * self-consistency cannot be the test.
 */
const reseal = (value) => {
  value.historicalContextSha256 = sha256Canonical(value.historicalContext);
  value.contextIdentitySha256 = sha256Canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contextIdentitySha256')));
  return value;
};

/**
 * The canonical consumption verdict for one authority, composed exactly as
 * validate-post-freeze-maintenance-authority.mjs composes it. The contradiction
 * test below compares this against the historical consumer, so it must be the
 * canonical primitive and not a second opinion.
 */
const canonicalConsumption = (root, authorityDocumentPath) => {
  const authority = JSON.parse(fs.readFileSync(path.join(root, ...authorityDocumentPath.split('/')), 'utf8'));
  const collected = [];
  let manifest = null;
  let observed = {};
  let consumptionRecord = null;
  try {
    const observation = collectPostFreezeMaintenanceObservation({ root, authority, authorityDocumentPath });
    collected.push(...observation.findings);
    manifest = observation.manifest;
    observed = observation.observed;
    const consumptionPath = resolveMaintenancePath(root, authority.consumptionRecordPath);
    if (consumptionPath && fs.existsSync(consumptionPath)) consumptionRecord = JSON.parse(fs.readFileSync(consumptionPath, 'utf8'));
  } catch (error) {
    collected.push({ code: error?.message || String(error) });
  }
  const evaluation = evaluatePostFreezeMaintenanceAuthorityV2({
    authority, manifest, observed, phase: PHASE_VERIFY_PROGRAM_CONSUMPTION, consumptionRecord
  });
  const all = [...collected, ...evaluation.findings];
  return { authorized: all.length === 0 && evaluation.consumed === true, findings: all };
};

/**
 * A root carrying the whole governance tree plus a git directory whose object
 * store is the real one by `alternates`, so the canonical observation can read
 * the base commit without a 45MB copy. HEAD deliberately points at a DIFFERENT
 * commit than the authority's baseHead: consumption verification is a
 * post-publication question, so a moved HEAD must not disturb it.
 */
const bindingRoot = ({ head = null, futureLedger = false } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r7-binding-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'objects', 'info'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), `${head ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()}\n`);
  fs.writeFileSync(path.join(root, '.git', 'objects', 'info', 'alternates'), `${path.join(REPO_ROOT, '.git', 'objects')}\n`);
  if (futureLedger) {
    const target = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
    fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8').trimEnd()}\n{"eventId":"SYNTHETIC_FUTURE_EVENT","gateId":"GATE41","toStatus":"NOT_STARTED"}\n`);
  }
  return root;
};

const consumptionRecordsIn = (root) => {
  const dir = path.join(root, ...HISTORY_DIR.split('/'));
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => ({ file: path.join(dir, name), value: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }))
    .filter((entry) => entry.value?.documentKind === 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION');
};

const rewriteJson = (file, mutate) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
};

test('R7 historical fixture binds only to a canonically valid maintenance authority', () => {
  const roots = [];
  const track = (root) => { roots.push(root); return root; };
  try {
    /* A — the original final bytes validate, replay the certified scenario, and
       name the authority that bound them. */
    const original = validateR7HistoricalBenchmarkContext({ repoRoot: REPO_ROOT });
    assert.equal(original.valid, true, findings(original));
    assert.equal(original.context.fixtureSha256, crypto.createHash('sha256').update(fixtureBytes()).digest('hex'));
    assert.equal(original.context.boundAuthorityId, 'R7_HISTORICAL_PERMANENCE_LOCAL_AUTHORITY_R1');
    assert.equal(original.context.compiled.activeState.canonicalStatus, 'NOT_STARTED');
    assert.ok(original.context.compiled.activeDefectsOrBlockers.some((entry) => entry.code === 'PRE_EXECUTION_TRUST_LEVEL'));
    assert.deepEqual(
      original.context.compiled.relevantSources.map((entry) => entry.path).sort(),
      ['governance/GATE_REGISTRY_00_40.json', 'governance/state/GATE_STATUS_LEDGER.ndjson']
    );

    /* THE CONTRADICTION TEST. Acceptance by the historical consumer must imply
       the canonical validator's own AUTHORIZED verdict for the very authority
       that did the binding. These two must never disagree about the same bytes. */
    const bindingVerdict = canonicalConsumption(REPO_ROOT, BINDING_AUTHORITY);
    assert.equal(bindingVerdict.authorized, true, JSON.stringify(bindingVerdict.findings));

    /* B — semantic forgery, every self-hash correctly recomputed. */
    const forgedStatus = clone(canonicalFixture());
    forgedStatus.historicalContext.activeState.canonicalStatus = 'COMPLETE_CONFIRMED';
    const statusFact = forgedStatus.historicalContext.facts.find((entry) => entry.id === 'active-status');
    assert.ok(statusFact, 'the certified context must carry an active-status fact for this forgery to be meaningful');
    statusFact.value = 'COMPLETE_CONFIRMED';
    reseal(forgedStatus);
    assert.equal(forgedStatus.historicalContextSha256, sha256Canonical(forgedStatus.historicalContext));
    const forgedStatusResult = validateR7HistoricalBenchmarkContext({ repoRoot: REPO_ROOT, fixture: forgedStatus });
    assert.equal(forgedStatusResult.valid, false);
    assert.ok(forgedStatusResult.findings.some((entry) => entry.startsWith('BENCHMARK_CONTEXT_EXTERNAL_BINDING_SHA256_MISMATCH:')), findings(forgedStatusResult));

    /* C — source digest forgery, re-bound coherently across historicalState and
       relevantSources so the internal binding agrees with itself. */
    const forgedSource = clone(canonicalFixture());
    const forgedDigest = 'c'.repeat(64);
    forgedSource.historicalState.find((entry) => entry.path === 'governance/state/GATE_STATUS_LEDGER.ndjson').sha256 = forgedDigest;
    forgedSource.historicalContext.relevantSources.find((entry) => entry.path === 'governance/state/GATE_STATUS_LEDGER.ndjson').sha256 = forgedDigest;
    reseal(forgedSource);
    const forgedSourceResult = validateR7HistoricalBenchmarkContext({ repoRoot: REPO_ROOT, fixture: forgedSource });
    assert.equal(forgedSourceResult.valid, false);
    assert.ok(forgedSourceResult.findings.some((entry) => entry.startsWith('BENCHMARK_CONTEXT_EXTERNAL_BINDING_SHA256_MISMATCH:')), findings(forgedSourceResult));
    assert.ok(!forgedSourceResult.findings.some((entry) => entry.startsWith('BENCHMARK_CONTEXT_COMPILED_SOURCE_UNBOUND:')),
      'the internal binding is deliberately satisfied here, so the block must come from outside');

    /* D — the authority's predecessor digest falsified and nothing else. The
       authority's own bytes now disagree with the digest its consumption
       certified, so the authority is not canonically valid. */
    const predecessorOnly = track(bindingRoot());
    rewriteJson(path.join(predecessorOnly, ...BINDING_AUTHORITY.split('/')), (value) => { value.authorityPredecessor.sha256 = 'a'.repeat(64); });
    const predecessorOnlyResult = validateR7HistoricalBenchmarkContext({ repoRoot: predecessorOnly });
    assert.equal(predecessorOnlyResult.valid, false);
    assert.ok(predecessorOnlyResult.findings.some((entry) => entry.startsWith('BENCHMARK_CONTEXT_EXTERNAL_AUTHORITY_NOT_CANONICALLY_VALID:')), findings(predecessorOnlyResult));

    /* E — THE P1 CASE. Predecessor falsified, the authority's own digest
       recomputed, AND the cohort entry that names it updated to match, so every
       digest in the chain is self-consistent. The partial reimplementation this
       repair removed accepted exactly this. It must now be refused, and the
       canonical validator must independently agree, naming the predecessor. */
    const resealedAuthority = track(bindingRoot());
    const forgedAuthoritySha = rewriteJson(path.join(resealedAuthority, ...BINDING_AUTHORITY.split('/')), (value) => { value.authorityPredecessor.sha256 = 'a'.repeat(64); });
    const forgedAuthorityBytes = fs.statSync(path.join(resealedAuthority, ...BINDING_AUTHORITY.split('/'))).size;
    let rebound = false;
    for (const record of consumptionRecordsIn(resealedAuthority)) {
      const entry = (record.value.cohort || []).find((item) => item?.path === BINDING_AUTHORITY);
      if (!entry) continue;
      rewriteJson(record.file, (value) => {
        const target = value.cohort.find((item) => item.path === BINDING_AUTHORITY);
        target.sha256 = forgedAuthoritySha;
        target.byteLength = forgedAuthorityBytes;
      });
      rebound = true;
    }
    assert.ok(rebound, 'the forgery must actually re-bind the cohort entry, otherwise it is only case D again');
    const resealedResult = validateR7HistoricalBenchmarkContext({ repoRoot: resealedAuthority });
    assert.equal(resealedResult.valid, false, 'a fully re-sealed authority forgery must not be accepted');
    assert.ok(resealedResult.findings.some((entry) => entry.startsWith('BENCHMARK_CONTEXT_EXTERNAL_AUTHORITY_NOT_CANONICALLY_VALID:')), findings(resealedResult));
    const resealedCanonical = canonicalConsumption(resealedAuthority, BINDING_AUTHORITY);
    assert.equal(resealedCanonical.authorized, false);
    assert.ok(resealedCanonical.findings.some((entry) => entry.code === 'AUTHORITY_PREDECESSOR_MISMATCH'),
      `the block must originate in canonical authority validity: ${JSON.stringify(resealedCanonical.findings)}`);

    /* F — authority bytes modified while the consumption cohort stays stale. */
    const staleCohort = track(bindingRoot());
    rewriteJson(path.join(staleCohort, ...BINDING_AUTHORITY.split('/')), (value) => { value.resumePoint = `${value.resumePoint}-TAMPERED`; });
    const staleCohortResult = validateR7HistoricalBenchmarkContext({ repoRoot: staleCohort });
    assert.equal(staleCohortResult.valid, false);
    assert.ok(staleCohortResult.findings.some((entry) => entry.startsWith('BENCHMARK_CONTEXT_EXTERNAL_AUTHORITY_NOT_CANONICALLY_VALID:')), findings(staleCohortResult));

    /* G — no authority at all. Authorization does not travel inside the fixture. */
    const noAuthority = track(bindingRoot());
    fs.rmSync(path.join(noAuthority, 'governance', 'sources'), { recursive: true, force: true });
    const noAuthorityResult = validateR7HistoricalBenchmarkContext({ repoRoot: noAuthority });
    assert.equal(noAuthorityResult.valid, false);
    assert.ok(noAuthorityResult.findings.includes('BENCHMARK_CONTEXT_EXTERNAL_BINDING_ABSENT'));

    /* H — consumption removed. An authority never consumed describes work that
       did not happen. */
    const noConsumption = track(bindingRoot());
    for (const record of consumptionRecordsIn(noConsumption)) fs.rmSync(record.file, { force: true });
    const noConsumptionResult = validateR7HistoricalBenchmarkContext({ repoRoot: noConsumption });
    assert.equal(noConsumptionResult.valid, false);
    assert.ok(noConsumptionResult.findings.includes('BENCHMARK_CONTEXT_EXTERNAL_BINDING_ABSENT'));

    /* I — only the superseded Fast-Path authority remains. It authorized this
       path once and certified the ORIGINAL v1 digest, so it must never
       fail-open onto today's fixture. */
    const fastPathOnly = track(bindingRoot());
    for (const name of fs.readdirSync(path.join(fastPathOnly, 'governance', 'sources'))) {
      if (name.includes('R7_HISTORICAL_PERMANENCE') || name.includes('R7_EXTERNAL_BINDING_REPAIR') || name.includes('R7_CONSUMPTION_REISSUE')) {
        fs.rmSync(path.join(fastPathOnly, 'governance', 'sources', name), { force: true });
      }
    }
    const fastPathResult = validateR7HistoricalBenchmarkContext({ repoRoot: fastPathOnly });
    assert.equal(fastPathResult.valid, false, 'the superseded Fast-Path authority must never bind the current fixture');
    assert.ok(fastPathResult.findings.length > 0);

    /* J — future ledger and a HEAD that is NOT the authority's baseHead, with
       the fixture and its binding untouched. Consumption verification is a
       post-publication question, so both must leave the verdict alone. */
    const priorHead = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const future = track(bindingRoot({ head: priorHead, futureLedger: true }));
    assert.notEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: future, encoding: 'utf8' }).trim(), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim());
    const futureResult = validateR7HistoricalBenchmarkContext({ repoRoot: future });
    assert.equal(futureResult.valid, true, findings(futureResult));
    assert.deepEqual(jsonValue(futureResult.context.compiled), jsonValue(original.context.compiled));
    // and the contradiction test still holds under the moved HEAD and grown ledger
    assert.equal(canonicalConsumption(future, BINDING_AUTHORITY).authorized, true);

    /* The current-state lane remains an independent, caller-parameterised,
       fail-closed detector. */
    const liveExpectation = canonicalFixture().historicalState
      .map((entry) => ({ ...entry, sha256: hashFile(path.join(REPO_ROOT, ...entry.path.split('/'))) }));
    assert.equal(validateR7CurrentStateBinding({ repoRoot: REPO_ROOT, expected: liveExpectation }).valid, true);
    const staleExpectation = clone(liveExpectation);
    staleExpectation.find((entry) => entry.path === 'governance/state/GATE_STATUS_LEDGER.ndjson').sha256 = 'b'.repeat(64);
    const staleCurrent = validateR7CurrentStateBinding({ repoRoot: REPO_ROOT, expected: staleExpectation });
    assert.equal(staleCurrent.valid, false);
    assert.ok(staleCurrent.findings.includes('CURRENT_STATE_SHA256_MISMATCH:governance/state/GATE_STATUS_LEDGER.ndjson'));
    assert.equal(validateR7CurrentStateBinding({ repoRoot: REPO_ROOT }).valid, false);
    assert.equal(validateR7CurrentStateBinding({ repoRoot: REPO_ROOT, expected: [] }).valid, false);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
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
    releaseOutputRoots();
  }
});
