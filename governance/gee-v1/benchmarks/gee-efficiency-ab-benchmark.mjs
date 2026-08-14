#!/usr/bin/env node
/**
 * GEE_EFFICIENCY_AB_BENCHMARK — does GEE actually reduce work, context and time
 * WITHOUT reducing quality?
 *
 * This is the baseline answer, measured once. It is deliberately NOT part of the
 * ordinary Gate path: the lightweight receipt emitted by every governed
 * execution is what the normal mission relies on, and this benchmark exists to
 * establish that those receipts describe a real reduction rather than a
 * bookkeeping one.
 *
 * WHAT MAKES THE COMPARISON FAIR, which is the only interesting question here.
 *
 * The reference side must be a legitimate execution, not a strawman. So both
 * sides run THE SAME PROGRAM, on THE SAME immutable repository snapshot, for THE
 * SAME work unit and phase, against THE SAME durable lifecycle store, in
 * separate processes. Nothing is disabled on the reference side and no extra
 * work is added to it. The only difference is the one being measured:
 *
 *   A  REFERENCE  runs with no prior proven evidence. Every canonical source is
 *                 ADDED, every candidate task is work, every piece of evidence
 *                 is produced. This is exactly what a governed execution does
 *                 when it cannot reuse anything — the honest "full" case.
 *
 *   B  GEE        runs against the durable R4/R6 state A left behind. R3 proves
 *                 the sources are unchanged, R4 reuses the evidence, R5 routes
 *                 only what is still required.
 *
 * The context axis is measured differently, and on purpose. R2's reduction is
 * not a cold/warm effect: it is the difference between shipping the canonical
 * SOURCE BYTES a work unit's authority is derived from and shipping the compiled
 * context. Both numbers come from R2's own compile metrics on the same run, so
 * the reference figure is a real measurement of real files, not an estimate.
 *
 * QUALITY PARITY IS MANDATORY AND IS CHECKED ON THE RESULT, NOT THE WORKSET.
 * B is supposed to do less work — that is the claim. What it may not do is reach
 * a weaker conclusion. So parity compares the conclusions: same verdict, same
 * chain bindings, same guard result, same evidence identities, and every task B
 * skipped must appear in B's own proven-reuse exclusion set. A task that simply
 * vanished, or evidence whose identity moved, fails the benchmark.
 *
 * TOKENS. Deterministic local Node execution exposes no model, tool or runtime
 * token counter. The benchmark reports UNAVAILABLE rather than an invented or
 * silently-estimated number, and every other metric is reported regardless.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { resolveDurableLifecycleRoot } from '../runtime/run-root-lifecycle.mjs';
import { verifyExecutionEfficiencyReceipt } from '../runtime/execution-efficiency-receipt.mjs';

export const BENCHMARK_DOCUMENT = 'GEE_EFFICIENCY_AB_BENCHMARK';
export const BENCHMARK_ENGINE = 'GEE_V1_EFFICIENCY_AB_BENCHMARK_R1';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_WORK_UNIT = 'GATE16';
export const DEFAULT_PHASE = 'READINESS';
export const BENCHMARK_STORE_SEGMENT = 'ab-benchmark';
export const CANONICAL_RESULT_PATH = 'governance/gee-v1/benchmarks/gee-efficiency-ab-benchmark.json';

const CONTROL_PLANE = 'governance/tools/gate-fast-path-control-plane.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Identity of the repository snapshot both sides run against.
 *
 * Captured before and after the benchmark and compared. A benchmark whose
 * subject moved underneath it is not a comparison, so a difference is fatal
 * rather than noted.
 */
export function snapshotIdentity(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const read = (relative) => fs.readFileSync(path.resolve(root, ...relative.split('/')));
  const ledger = read('governance/state/GATE_STATUS_LEDGER.ndjson');
  return {
    head,
    ledgerSha256: sha256(ledger),
    ledgerEventCount: ledger.toString('utf8').trim().split(/\r?\n/).filter(Boolean).length,
    registrySha256: sha256(read('governance/GATE_REGISTRY_00_40.json')),
    controlPlaneSha256: sha256(read(CONTROL_PLANE))
  };
}

/**
 * The durable store both passes share.
 *
 * It lives under the canonical durable lifecycle root, in a directory keyed by
 * the exact snapshot and work unit, and is reset before pass A so the benchmark
 * is reproducible instead of depending on whatever a previous run left. The
 * reset is bounded to that one keyed path: it refuses to act on anything that is
 * not a direct child of the benchmark segment.
 */
export function benchmarkStoreRoot({ root = REPO_ROOT, workUnitId, phase, head } = {}) {
  const durable = resolveDurableLifecycleRoot();
  const segment = `${workUnitId}-${phase}-${head.slice(0, 12)}`;
  const benchmarkRoot = path.join(durable.root, BENCHMARK_STORE_SEGMENT);
  const store = path.join(benchmarkRoot, segment);
  return { durable, benchmarkRoot, store, segment, repoRoot: root };
}

export function resetBenchmarkStore({ benchmarkRoot, store, segment }) {
  const resolved = path.resolve(store);
  if (path.dirname(resolved) !== path.resolve(benchmarkRoot)) throw new Error(`AB_BENCHMARK_STORE_OUTSIDE_NAMESPACE:${resolved}`);
  if (path.basename(resolved) !== segment) throw new Error(`AB_BENCHMARK_STORE_IDENTITY_MISMATCH:${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * One pass, in its own process.
 *
 * A separate process is not ceremony: it is what proves the durable R4/R6 state
 * survives the process that wrote it, which is the entire premise of pass B.
 */
export function runPass({ root = REPO_ROOT, workUnitId, phase, store, label }) {
  const startedMs = Date.now();
  const stdout = execFileSync(process.execPath, [
    path.join(root, ...CONTROL_PLANE.split('/')),
    '--root', root, '--gate', workUnitId, '--phase', phase, '--lifecycle-store', store
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const processWallTimeMs = Date.now() - startedMs;
  const report = JSON.parse(stdout);
  if (!report.efficiency) throw new Error(`AB_BENCHMARK_PASS_EMITTED_NO_RECEIPT:${label}`);
  const receiptCheck = verifyExecutionEfficiencyReceipt(report.efficiency);
  if (!receiptCheck.valid) throw new Error(`AB_BENCHMARK_PASS_RECEIPT_INVALID:${label}:${receiptCheck.reasonCodes.join(',')}`);
  return { label, report, receipt: report.efficiency, processWallTimeMs };
}

/**
 * REFERENCE, GEE, ABSOLUTE_DELTA, PERCENT_REDUCTION for one metric.
 *
 * `stability` separates what the benchmark can CLAIM from what it merely
 * OBSERVES. Bytes, files, evidence nodes and work units are recomputed
 * identically on any machine. Wall time is one sample of a process whose cost
 * here is dominated by fixed overhead — node startup, git subprocesses, a
 * repository index over several hundred files — and a small routing saving sits
 * well inside its run-to-run variance. Reporting it as a headline reduction
 * would be overclaiming, so it is reported and labelled, and the verdict does
 * not rest on it.
 */
export const DETERMINISTIC = 'DETERMINISTIC';
export const WALL_CLOCK_SINGLE_SAMPLE = 'WALL_CLOCK_SINGLE_SAMPLE';

function metricRow({ metric, unit, reference, gee, lowerIsBetter = true, basis, stability = DETERMINISTIC, note = null }) {
  const measurable = Number.isFinite(reference) && Number.isFinite(gee);
  const absoluteDelta = measurable ? reference - gee : null;
  const percentReduction = measurable && reference !== 0 ? Number(((absoluteDelta / reference) * 100).toFixed(3)) : null;
  return {
    metric, unit, basis, stability, note,
    REFERENCE: measurable ? reference : null,
    GEE: measurable ? gee : null,
    ABSOLUTE_DELTA: absoluteDelta,
    PERCENT_REDUCTION: percentReduction,
    direction: lowerIsBetter ? 'LOWER_IS_BETTER' : 'HIGHER_IS_BETTER',
    measurable
  };
}

/**
 * Quality parity. Every check must hold; any failure is a benchmark FAIL, no
 * matter how large the resource reduction.
 */
export function evaluateQualityParity({ reference, gee }) {
  const a = reference.report;
  const b = gee.report;
  const evidenceIdentity = (report) => Object.fromEntries(
    [...report.evidence.UNCHANGED_PROVEN_EVIDENCE, ...report.evidence.CHANGED_DEPENDENCY, ...report.evidence.UNKNOWN_PROVENANCE]
      .map((node) => [node.evidenceId, node.reuseIdentity ?? null])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  );
  const taskIds = (list) => new Set(list.map((task) => task.taskId));
  const referenceExecuted = taskIds(a.workset.requiredWorkset);
  const geeExecuted = taskIds(b.workset.requiredWorkset);
  const geeProvenReuse = taskIds(b.workset.excludedByProvenReuse);
  const droppedWithoutProof = [...referenceExecuted].filter((taskId) => !geeExecuted.has(taskId) && !geeProvenReuse.has(taskId)).sort();
  const validatorUniverse = (report) => [...new Set([...report.workset.requiredValidators, ...report.workset.excludedValidators])].sort();

  const checks = [
    { id: 'SAME_VERDICT', pass: a.verdict === b.verdict, detail: { reference: a.verdict, gee: b.verdict } },
    { id: 'SAME_R2_CONTEXT_IDENTITY', pass: a.chain.r2.contextSha256 === b.chain.r2.contextSha256, detail: { reference: a.chain.r2.contextSha256, gee: b.chain.r2.contextSha256 } },
    { id: 'CHAIN_BINDINGS_VALID_BOTH_SIDES', pass: a.chain.bindingsValid === true && b.chain.bindingsValid === true, detail: { reference: a.chain.bindingsValid, gee: b.chain.bindingsValid } },
    { id: 'R7_GUARD_PASS_BOTH_SIDES', pass: a.r7.verdict === 'PASS' && b.r7.verdict === 'PASS', detail: { reference: a.r7.verdict, gee: b.r7.verdict } },
    { id: 'NO_UNKNOWN_PROVENANCE_EITHER_SIDE', pass: a.evidence.unknownProvenanceCount === 0 && b.evidence.unknownProvenanceCount === 0, detail: { reference: a.evidence.unknownProvenanceCount, gee: b.evidence.unknownProvenanceCount } },
    { id: 'NO_BLOCKED_WORK_EITHER_SIDE', pass: a.workset.blocked.length === 0 && b.workset.blocked.length === 0, detail: { reference: a.workset.blocked.length, gee: b.workset.blocked.length } },
    { id: 'EVIDENCE_IDENTITIES_UNCHANGED', pass: sha256Canonical(evidenceIdentity(a)) === sha256Canonical(evidenceIdentity(b)), detail: { reference: evidenceIdentity(a), gee: evidenceIdentity(b) } },
    { id: 'NO_WORK_DROPPED_WITHOUT_PROVEN_REUSE', pass: droppedWithoutProof.length === 0, detail: droppedWithoutProof },
    { id: 'SAME_VALIDATOR_UNIVERSE', pass: sha256Canonical(validatorUniverse(a)) === sha256Canonical(validatorUniverse(b)), detail: { reference: validatorUniverse(a), gee: validatorUniverse(b) } },
    { id: 'SAME_MINIMUM_EVIDENCE_FRONTIER', pass: sha256Canonical(a.minimumEvidenceFrontier) === sha256Canonical(b.minimumEvidenceFrontier), detail: null },
    { id: 'SAME_ANTI_AMNESIA_RESULT', pass: sha256Canonical(a.antiAmnesia) === sha256Canonical(b.antiAmnesia), detail: null },
    { id: 'SAME_REGRESSION_COMPARABILITY', pass: a.regression.comparabilityEstablished === b.regression.comparabilityEstablished, detail: { reference: a.regression.comparabilityEstablished, gee: b.regression.comparabilityEstablished } },
    { id: 'SAME_BLOCKING_FACTS', pass: sha256Canonical(a.blockingFacts) === sha256Canonical(b.blockingFacts), detail: { reference: a.blockingFacts, gee: b.blockingFacts } },
    // Only the decision fields; the recovery block also carries the absolute
    // durable root, which must not reach a committed artifact.
    { id: 'GEE_DID_NOT_RESTART_FROM_ZERO', pass: b.efficiency.recovery.restartedFromZero === false, detail: { resumed: b.efficiency.recovery.resumed, restartedFromZero: b.efficiency.recovery.restartedFromZero, checkpointRevision: b.efficiency.recovery.checkpointRevision } }
  ].map((check) => ({ ...check, status: check.pass ? 'PASS' : 'FAIL' }));

  return { parity: checks.every((check) => check.pass) ? 'PASS' : 'FAIL', checks, failedCheckIds: checks.filter((check) => !check.pass).map((check) => check.id) };
}

export function runEfficiencyAbBenchmark({
  root = REPO_ROOT, workUnitId = DEFAULT_WORK_UNIT, phase = DEFAULT_PHASE, now = new Date()
} = {}) {
  const snapshotBefore = snapshotIdentity(root);
  const store = benchmarkStoreRoot({ root, workUnitId, phase, head: snapshotBefore.head });
  resetBenchmarkStore(store);

  const reference = runPass({ root, workUnitId, phase, store: store.store, label: 'REFERENCE' });
  const gee = runPass({ root, workUnitId, phase, store: store.store, label: 'GEE' });

  const snapshotAfter = snapshotIdentity(root);
  if (sha256Canonical(snapshotBefore) !== sha256Canonical(snapshotAfter)) {
    throw new Error('AB_BENCHMARK_SNAPSHOT_MUTATED_DURING_RUN');
  }

  const a = reference.receipt;
  const b = gee.receipt;
  const metrics = [
    // Context: canonical source bytes an execution without R2 must carry, vs the
    // compiled context. Same run, same files, R2's own measurement.
    metricRow({ metric: 'contextBytes', unit: 'bytes', reference: a.context.originalConsideredBytes, gee: a.context.compiledContextBytes, basis: 'R2_COMPILE_METRICS_SOURCE_BYTES_VS_COMPILED_BYTES' }),
    metricRow({ metric: 'filesConsumed', unit: 'files', reference: a.execution.filesConsidered, gee: a.execution.filesConsumed, basis: 'R6_REPO_INDEX_ENTRIES_VS_R2_R3_CONSUMED_PATHS' }),
    // Work and evidence: cold reference pass vs warm GEE pass.
    metricRow({ metric: 'evidenceRecomputed', unit: 'nodes', reference: a.reuse.evidenceAvailable, gee: b.reuse.evidenceRecomputed, basis: 'REFERENCE_PRODUCES_ALL_EVIDENCE_VS_GEE_REVALIDATION_SET' }),
    metricRow({ metric: 'workUnitsExecuted', unit: 'tasks', reference: a.work.executedWorkUnits, gee: b.work.executedWorkUnits, basis: 'R5_ROUTE_PLAN_REQUIRED_WORKSET' }),
    metricRow({ metric: 'sourceReprocessBytes', unit: 'bytes', reference: a.delta.changedBytes, gee: b.delta.changedBytes, basis: 'R3_DELTA_CHANGED_BYTES' }),
    metricRow({
      metric: 'planWallTimeMs', unit: 'ms', reference: a.execution.wallTimeMs, gee: b.execution.wallTimeMs,
      basis: 'CONTROL_PLANE_MEASURED_PLAN_DURATION', stability: WALL_CLOCK_SINGLE_SAMPLE,
      note: 'Dominated by fixed per-process cost. The saving from avoiding 2 of 5 tasks is inside this measurement’s run-to-run variance, so its sign is not a claim.'
    }),
    metricRow({
      metric: 'processWallTimeMs', unit: 'ms', reference: reference.processWallTimeMs, gee: gee.processWallTimeMs,
      basis: 'PARENT_MEASURED_CHILD_PROCESS_DURATION', stability: WALL_CLOCK_SINGLE_SAMPLE,
      note: 'Includes node startup on both sides. Reported for completeness, not relied on.'
    }),
    metricRow({ metric: 'totalTokens', unit: 'tokens', reference: null, gee: null, basis: 'NO_RUNTIME_TOKEN_COUNTER_EXPOSED' })
  ];

  const quality = evaluateQualityParity({ reference, gee });
  const changed = (sign) => metrics.filter((row) => row.measurable && Math.sign(row.ABSOLUTE_DELTA) === sign);
  const reducedMetrics = changed(1).map((row) => row.metric);
  const regressedMetrics = changed(-1).map((row) => row.metric);
  const deterministicReductions = changed(1).filter((row) => row.stability === DETERMINISTIC).map((row) => row.metric);
  const deterministicRegressions = changed(-1).filter((row) => row.stability === DETERMINISTIC).map((row) => row.metric);

  // A resource reduction bought with weaker evidence is a failure, not a win —
  // and the reduction must be on an axis that reproduces, not on a wall clock.
  const verdict = quality.parity !== 'PASS'
    ? 'FAIL_QUALITY_PARITY'
    : deterministicRegressions.length > 0
      ? 'FAIL_DETERMINISTIC_REGRESSION'
      : deterministicReductions.length === 0 ? 'FAIL_NO_MEASURED_REDUCTION' : 'PASS';

  return {
    document: BENCHMARK_DOCUMENT,
    schemaVersion: 1,
    engine: BENCHMARK_ENGINE,
    generatedAt: now.toISOString(),
    verdict,
    question: 'DOES_GEE_REDUCE_WORK_CONTEXT_TOKENS_TIME_WITHOUT_REDUCING_QUALITY',
    scope: 'BASELINE_BENCHMARK_NOT_PER_GATE',
    controls: {
      sameRepositorySnapshot: true,
      snapshot: snapshotBefore,
      snapshotUnchangedAfterRun: true,
      sameTask: `${workUnitId}/${phase} minimum-evidence-frontier plan`,
      sameProgram: CONTROL_PLANE,
      // Recorded as a machine-independent descriptor, never as an absolute path.
      // This artifact is committed, and a canonical artifact that pins one
      // machine's home directory stops being reproducible on any other.
      sameDurableStore: `<durableLifecycleRoot>/${BENCHMARK_STORE_SEGMENT}/${store.segment}`,
      durableStoreSource: store.durable.source,
      durableStoreSegment: store.segment,
      durableStoreOutsideRepository: true,
      separateProcesses: true,
      referenceLegitimacy: 'REFERENCE_IS_THE_SAME_PROGRAM_WITH_NO_PRIOR_PROVEN_EVIDENCE_NOTHING_DISABLED_OR_ADDED'
    },
    passes: {
      REFERENCE: {
        geeExecutionId: a.identity.geeExecutionId,
        comparisonBasis: a.delta.comparisonBasis,
        resumed: a.recovery.resumed,
        checkpointRevision: a.recovery.checkpointRevision,
        receiptSha256: a.receiptSha256
      },
      GEE: {
        geeExecutionId: b.identity.geeExecutionId,
        comparisonBasis: b.delta.comparisonBasis,
        resumed: b.recovery.resumed,
        restartedFromZero: b.recovery.restartedFromZero,
        checkpointRevision: b.recovery.checkpointRevision,
        receiptSha256: b.receiptSha256
      }
    },
    metrics,
    reducedMetrics,
    regressedMetrics,
    deterministicReductions,
    deterministicRegressions,
    claimBasis: 'THE VERDICT RESTS ON THE DETERMINISTIC AXES ONLY. Wall-clock rows are single samples dominated by fixed per-process cost and are reported without being relied on.',
    tokens: {
      tokenSource: 'UNAVAILABLE',
      unavailableReason: 'DETERMINISTIC_LOCAL_EXECUTION_EXPOSES_NO_TOKEN_COUNTER',
      referenceTokens: null,
      geeTokens: null,
      note: 'Neither pass invokes a model. No counter was fabricated or estimated; every other metric is reported regardless.'
    },
    quality,
    reproduction: `node ${CANONICAL_RESULT_PATH.replace('.json', '.mjs')} --gate ${workUnitId} --phase ${phase}`
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const result = runEfficiencyAbBenchmark({
    root: path.resolve(option('--root', REPO_ROOT)),
    workUnitId: option('--gate', DEFAULT_WORK_UNIT),
    phase: option('--phase', DEFAULT_PHASE)
  });
  if (process.argv.includes('--write')) {
    const target = path.join(REPO_ROOT, ...CANONICAL_RESULT_PATH.split('/'));
    fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.verdict === 'PASS' ? 0 : 2;
}
