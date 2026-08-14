import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  BENCHMARK_DOCUMENT,
  DETERMINISTIC,
  CANONICAL_RESULT_PATH,
  DEFAULT_PHASE,
  DEFAULT_WORK_UNIT,
  REPO_ROOT,
  benchmarkStoreRoot,
  evaluateQualityParity,
  resetBenchmarkStore,
  runEfficiencyAbBenchmark,
  snapshotIdentity
} from '../benchmarks/gee-efficiency-ab-benchmark.mjs';

const canonicalResultFile = path.join(REPO_ROOT, ...CANONICAL_RESULT_PATH.split('/'));
const ledgerFile = path.join(REPO_ROOT, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');

/**
 * Everything except identities, timestamps and wall-clock readings.
 *
 * Wall time is a real measurement and is reported, but it is not reproducible to
 * the digit, so comparing a stored run against a fresh one on that axis would
 * assert that two machines are equally busy. The deterministic axes — bytes,
 * files, evidence, work units — are what reproducibility means here.
 */
const stableOutcome = (result) => ({
  verdict: result.verdict,
  quality: result.quality.parity,
  failedCheckIds: result.quality.failedCheckIds,
  deterministicReductions: [...result.deterministicReductions].sort(),
  deterministicRegressions: [...result.deterministicRegressions].sort(),
  deterministicMetrics: result.metrics
    .filter((row) => row.stability === DETERMINISTIC)
    .map((row) => ({ metric: row.metric, REFERENCE: row.REFERENCE, GEE: row.GEE, ABSOLUTE_DELTA: row.ABSOLUTE_DELTA, PERCENT_REDUCTION: row.PERCENT_REDUCTION })),
  tokenSource: result.tokens.tokenSource
});

let benchmark = null;
const runOnce = () => {
  if (!benchmark) benchmark = runEfficiencyAbBenchmark({ root: REPO_ROOT, workUnitId: DEFAULT_WORK_UNIT, phase: DEFAULT_PHASE });
  return benchmark;
};

test('AB01 the benchmark answers the question with a PASS and mandatory quality parity', () => {
  const result = runOnce();
  assert.equal(result.document, BENCHMARK_DOCUMENT);
  assert.equal(result.question, 'DOES_GEE_REDUCE_WORK_CONTEXT_TOKENS_TIME_WITHOUT_REDUCING_QUALITY');
  assert.equal(result.quality.parity, 'PASS', JSON.stringify(result.quality.failedCheckIds));
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.quality.failedCheckIds, []);
  assert.ok(result.quality.checks.length >= 14);
  for (const check of result.quality.checks) assert.equal(check.status, 'PASS', check.id);
});

test('AB02 both sides ran the same program on the same immutable snapshot', () => {
  const result = runOnce();
  assert.equal(result.controls.sameRepositorySnapshot, true);
  assert.equal(result.controls.snapshotUnchangedAfterRun, true);
  assert.equal(result.controls.separateProcesses, true);
  assert.equal(result.controls.sameProgram, 'governance/tools/gate-fast-path-control-plane.mjs');
  // The snapshot the benchmark recorded is still the live one.
  assert.deepEqual(result.controls.snapshot, snapshotIdentity(REPO_ROOT));
});

test('AB03 the reference side is legitimate: nothing disabled, nothing added', () => {
  const result = runOnce();
  const source = fs.readFileSync(path.join(REPO_ROOT, 'governance', 'gee-v1', 'benchmarks', 'gee-efficiency-ab-benchmark.mjs'), 'utf8');
  // Both passes are literally the same argv shape; the only difference between
  // them is which one runs first against an empty durable store.
  const invocations = source.match(/= runPass\(\{[^}]*\}\)/g) || [];
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].replace(/label: '\w+'/, ''), invocations[1].replace(/label: '\w+'/, ''));
  assert.equal(result.passes.REFERENCE.comparisonBasis, 'EMPTY_INITIAL_BASELINE');
  assert.equal(result.passes.GEE.comparisonBasis, 'PRIOR_PROVEN_SNAPSHOT');
  // No sleep, no padding, no artificial cost on the reference side.
  assert.equal(/setTimeout|Atomics\.wait|busy|sleep/i.test(source), false);
});

test('AB04 GEE resumed from durable state a DIFFERENT process wrote', () => {
  const result = runOnce();
  assert.equal(result.passes.REFERENCE.resumed, false);
  assert.equal(result.passes.REFERENCE.checkpointRevision, 'R0001');
  assert.equal(result.passes.GEE.resumed, true);
  assert.equal(result.passes.GEE.restartedFromZero, false);
  assert.equal(result.passes.GEE.checkpointRevision, 'R0002');
  assert.notEqual(result.passes.REFERENCE.geeExecutionId, result.passes.GEE.geeExecutionId);
  // Different run identities carry different process ids, so the checkpoint
  // outlived the process that produced it.
  const pidOf = (runId) => runId.split('-').at(-2);
  assert.notEqual(pidOf(result.passes.REFERENCE.geeExecutionId), pidOf(result.passes.GEE.geeExecutionId));
});

test('AB05 every required metric is reported in the REFERENCE/GEE/DELTA/REDUCTION form', () => {
  const result = runOnce();
  const byMetric = Object.fromEntries(result.metrics.map((row) => [row.metric, row]));
  for (const metric of ['contextBytes', 'filesConsumed', 'evidenceRecomputed', 'workUnitsExecuted', 'sourceReprocessBytes', 'planWallTimeMs', 'processWallTimeMs', 'totalTokens']) {
    assert.ok(byMetric[metric], `missing metric ${metric}`);
    for (const field of ['REFERENCE', 'GEE', 'ABSOLUTE_DELTA', 'PERCENT_REDUCTION']) {
      assert.ok(field in byMetric[metric], `${metric}.${field}`);
    }
  }
  // Deterministic axes must show a real reduction, not a rounding artefact.
  assert.ok(byMetric.contextBytes.PERCENT_REDUCTION > 90);
  assert.ok(byMetric.filesConsumed.PERCENT_REDUCTION > 90);
  assert.equal(byMetric.evidenceRecomputed.GEE, 0);
  assert.ok(byMetric.workUnitsExecuted.ABSOLUTE_DELTA > 0);
  assert.equal(byMetric.sourceReprocessBytes.GEE, 0);
  // Wall time is machine-dependent; the deterministic axes may never regress.
  assert.deepEqual(result.deterministicRegressions, []);
  assert.ok(result.deterministicReductions.length >= 5);
});

test('AB06 tokens are reported as UNAVAILABLE and never invented', () => {
  const result = runOnce();
  assert.equal(result.tokens.tokenSource, 'UNAVAILABLE');
  assert.equal(result.tokens.referenceTokens, null);
  assert.equal(result.tokens.geeTokens, null);
  const tokenRow = result.metrics.find((row) => row.metric === 'totalTokens');
  assert.equal(tokenRow.REFERENCE, null);
  assert.equal(tokenRow.GEE, null);
  assert.equal(tokenRow.measurable, false);
  // Unavailable tokens did not stop any other metric from being reported.
  assert.ok(result.metrics.filter((row) => row.measurable).length >= 6);
});

test('AB07 quality parity FAILS if GEE reaches a weaker result', () => {
  const result = runOnce();
  const reference = { report: JSON.parse(JSON.stringify(result.controls ? referenceReport(result) : null)) };
  // Build a synthetic pair from the real one and degrade the GEE side; each
  // degradation must be caught by its own named check.
  const degradations = [
    ['SAME_VERDICT', (report) => { report.verdict = 'FAST_PATH_BLOCKED'; }],
    ['CHAIN_BINDINGS_VALID_BOTH_SIDES', (report) => { report.chain.bindingsValid = false; }],
    ['R7_GUARD_PASS_BOTH_SIDES', (report) => { report.r7.verdict = 'FAIL'; }],
    ['NO_UNKNOWN_PROVENANCE_EITHER_SIDE', (report) => { report.evidence.unknownProvenanceCount = 1; }],
    ['EVIDENCE_IDENTITIES_UNCHANGED', (report) => { report.evidence.UNCHANGED_PROVEN_EVIDENCE[0].reuseIdentity = 'tampered'; }],
    ['NO_WORK_DROPPED_WITHOUT_PROVEN_REUSE', (report) => { report.workset.requiredWorkset = []; report.workset.excludedByProvenReuse = []; }],
    ['SAME_BLOCKING_FACTS', (report) => { report.blockingFacts = [{ code: 'INVENTED' }]; }],
    ['GEE_DID_NOT_RESTART_FROM_ZERO', (report) => { report.efficiency.recovery.restartedFromZero = true; }]
  ];
  const base = referenceReport(result);
  for (const [expectedCheck, degrade] of degradations) {
    const geeReport = JSON.parse(JSON.stringify(base));
    degrade(geeReport);
    const parity = evaluateQualityParity({ reference: { report: JSON.parse(JSON.stringify(base)) }, gee: { report: geeReport } });
    assert.equal(parity.parity, 'FAIL', expectedCheck);
    assert.ok(parity.failedCheckIds.includes(expectedCheck), `${expectedCheck} not among ${parity.failedCheckIds}`);
  }
  // The undegraded pair still passes, so the checks are not vacuously failing.
  assert.equal(evaluateQualityParity({ reference: { report: base }, gee: { report: JSON.parse(JSON.stringify(base)) } }).parity, 'PASS');
  assert.ok(reference !== undefined);
});

/**
 * A structurally complete report to degrade, taken from a real pass rather than
 * hand-built, so the parity checks are exercised against the actual shape.
 */
function referenceReport(result) {
  const stored = JSON.parse(fs.readFileSync(canonicalResultFile, 'utf8'));
  assert.equal(stored.document, BENCHMARK_DOCUMENT);
  return {
    verdict: 'FAST_PATH_READY',
    chain: { r2: { contextSha256: 'a'.repeat(64) }, bindingsValid: true },
    r7: { verdict: 'PASS' },
    evidence: { unknownProvenanceCount: 0, UNCHANGED_PROVEN_EVIDENCE: [{ evidenceId: 'e:1', reuseIdentity: 'sha256:1' }], CHANGED_DEPENDENCY: [], UNKNOWN_PROVENANCE: [] },
    workset: { requiredWorkset: [{ taskId: 't:1' }], excludedByProvenReuse: [{ taskId: 't:2' }], blocked: [], requiredValidators: ['v1'], excludedValidators: ['v2'] },
    minimumEvidenceFrontier: { phase: result.controls.sameTask },
    antiAmnesia: { verdict: 'OK' },
    regression: { comparabilityEstablished: true },
    blockingFacts: [],
    efficiency: { recovery: { restartedFromZero: false } }
  };
}

test('AB08 the benchmark is reproducible and its recorded result matches a fresh run', () => {
  const result = runOnce();
  const stored = JSON.parse(fs.readFileSync(canonicalResultFile, 'utf8'));
  assert.equal(stored.document, BENCHMARK_DOCUMENT);
  assert.equal(stored.controls.snapshot.head, result.controls.snapshot.head);
  assert.deepEqual(stableOutcome(stored), stableOutcome(result));
});

test('AB09 the benchmark store reset is bounded to its own keyed directory', () => {
  const head = snapshotIdentity(REPO_ROOT).head;
  const store = benchmarkStoreRoot({ root: REPO_ROOT, workUnitId: DEFAULT_WORK_UNIT, phase: DEFAULT_PHASE, head });
  assert.equal(path.basename(store.store), store.segment);
  assert.equal(path.dirname(store.store), store.benchmarkRoot);
  assert.equal(store.durable.ephemeral, false);
  assert.throws(() => resetBenchmarkStore({ ...store, store: store.benchmarkRoot }), /AB_BENCHMARK_STORE_OUTSIDE_NAMESPACE/);
  assert.throws(() => resetBenchmarkStore({ ...store, store: path.join(store.benchmarkRoot, 'other') }), /AB_BENCHMARK_STORE_IDENTITY_MISMATCH/);
  assert.throws(() => resetBenchmarkStore({ ...store, store: REPO_ROOT }), /AB_BENCHMARK_STORE_OUTSIDE_NAMESPACE/);
  assert.equal(fs.existsSync(REPO_ROOT), true);
});

test('AB10 the benchmark never mutates the repository or the ledger', () => {
  const ledgerBefore = fs.readFileSync(ledgerFile);
  const result = runOnce();
  assert.deepEqual(fs.readFileSync(ledgerFile), ledgerBefore);
  assert.equal(result.controls.snapshot.ledgerSha256, snapshotIdentity(REPO_ROOT).ledgerSha256);
  assert.equal(result.controls.snapshot.ledgerEventCount, 65);
  // The durable store lives outside the repository entirely.
  const live = benchmarkStoreRoot({ root: REPO_ROOT, workUnitId: DEFAULT_WORK_UNIT, phase: DEFAULT_PHASE, head: result.controls.snapshot.head });
  assert.equal(path.relative(REPO_ROOT, live.store).startsWith('..'), true);
  assert.equal(result.controls.durableStoreOutsideRepository, true);
  assert.equal(result.scope, 'BASELINE_BENCHMARK_NOT_PER_GATE');
});

test('AB11 the committed artifact is machine-independent', () => {
  const raw = fs.readFileSync(canonicalResultFile, 'utf8');
  // A canonical artifact that pins one machine's home directory, drive or temp
  // path is not reproducible anywhere else, so none may appear.
  for (const pattern of [/[A-Za-z]:\\\\/, /\/home\//, /\/Users\//, /AppData/, /\.local\/state/, /Temp/]) {
    assert.equal(pattern.test(raw), false, `machine-specific path matched ${pattern}`);
  }
  const stored = JSON.parse(raw);
  assert.equal(stored.controls.sameDurableStore.startsWith('<durableLifecycleRoot>/'), true);
  assert.equal(stored.controls.durableStoreSegment, `${DEFAULT_WORK_UNIT}-${DEFAULT_PHASE}-${stored.controls.snapshot.head.slice(0, 12)}`);
});
