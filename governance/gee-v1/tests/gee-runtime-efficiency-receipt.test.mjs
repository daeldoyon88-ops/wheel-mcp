import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EFFICIENCY_RECEIPT_DOCUMENT,
  TOKEN_SOURCES,
  TOKEN_SOURCE_TO_USAGE_LEDGER_STATE,
  buildExecutionEfficiencyReceipt,
  createProcessCallCounter,
  normalizeTokenBlock,
  verifyExecutionEfficiencyReceipt
} from '../runtime/execution-efficiency-receipt.mjs';
import {
  TOKEN_COUNT_ESTIMATED, TOKEN_COUNT_MEASURED, TOKEN_COUNT_UNAVAILABLE
} from '../usage/usage-ledger.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const minimalIdentity = { workUnitId: 'GATE16', baselineHead: 'a'.repeat(40), geeExecutionId: 'GATE16-READINESS-abc-1-xyzabc' };
const build = (overrides = {}) => buildExecutionEfficiencyReceipt({
  identity: minimalIdentity,
  context: { originalConsideredBytes: 150000, compiledContextBytes: 6000 },
  delta: { classification: { ADDED: 7 }, changedBytes: 1000, unchangedBytes: 9000 },
  reuse: { evidenceAvailable: 10, evidenceReused: 8, evidenceRecomputed: 2 },
  work: { candidateWorkUnits: 5, executedWorkUnits: 1, avoidedWorkUnits: 4 },
  recovery: { resumed: true, restartedFromZero: false },
  execution: { filesConsidered: 435, filesConsumed: 7, wallTimeMs: 1200 },
  now: new Date('2026-08-14T00:00:00.000Z'),
  ...overrides
});

/* -------------------------------------------------------------------------
 * Shape and derived ratios
 * ---------------------------------------------------------------------- */

test('ER01 the receipt reports every field the mission requires', () => {
  const receipt = build();
  assert.equal(receipt.document, EFFICIENCY_RECEIPT_DOCUMENT);
  assert.equal(receipt.mode, 'OBSERVATIONAL_ONLY');
  assert.deepEqual(Object.keys(receipt.identity).sort(), ['baselineHead', 'consumer', 'geeExecutionId', 'missionId', 'missionRevisionId', 'phase', 'workUnitId']);
  assert.deepEqual(Object.keys(receipt.context).sort(), ['compiledContextBytes', 'contextBytesAvoided', 'contextReductionRatio', 'measurementSource', 'originalConsideredBytes']);
  assert.deepEqual(Object.keys(receipt.reuse).sort(), ['avoidedEvidenceBytes', 'evidenceAvailable', 'evidenceRecomputed', 'evidenceReused', 'r4ReuseRatio']);
  assert.deepEqual(Object.keys(receipt.work).sort(), ['avoidedWorkUnits', 'blockedWorkUnits', 'candidateWorkUnits', 'deferredWorkUnits', 'executedWorkUnits', 'r5ReductionRatio', 'routeDecision']);
  assert.deepEqual(Object.keys(receipt.recovery).sort(), ['checkpointRevision', 'durableStateRoot', 'durableStateRootSource', 'restartedFromZero', 'resumed']);
  assert.deepEqual(Object.keys(receipt.tokens).sort(), ['cachedInputTokens', 'estimationMethod', 'inputTokens', 'measurementSource', 'outputTokens', 'tokenSource', 'totalTokens', 'unavailableReason', 'usageLedgerMeasurementState']);
  for (const field of ['filesConsidered', 'filesConsumed', 'toolProcessCalls', 'wallTimeMs', 'r7Mode', 'qualityParity']) {
    assert.ok(field in receipt.execution, field);
  }
});

test('ER02 ratios are derived from the measurements, and an absent basis is null not zero', () => {
  const receipt = build();
  assert.equal(receipt.context.contextReductionRatio, 25);
  assert.equal(receipt.context.contextBytesAvoided, 144000);
  assert.equal(receipt.reuse.r4ReuseRatio, 0.8);
  assert.equal(receipt.work.r5ReductionRatio, 0.8);
  assert.equal(receipt.recovery.resumed, true);
  assert.equal(receipt.recovery.restartedFromZero, false);

  const empty = build({ reuse: { evidenceAvailable: 0, evidenceReused: 0, evidenceRecomputed: 0 }, work: { candidateWorkUnits: 0, executedWorkUnits: 0, avoidedWorkUnits: 0 } });
  assert.equal(empty.reuse.r4ReuseRatio, null);
  assert.equal(empty.work.r5ReductionRatio, null);

  const unknownContext = build({ context: { originalConsideredBytes: null, compiledContextBytes: 6000 } });
  assert.equal(unknownContext.context.contextReductionRatio, null);
  assert.equal(unknownContext.context.contextBytesAvoided, null);
});

test('ER03 the digest covers the body and detects any edit', () => {
  const receipt = build();
  assert.equal(verifyExecutionEfficiencyReceipt(receipt).valid, true);
  for (const mutate of [
    (value) => { value.work.avoidedWorkUnits = 99; },
    (value) => { value.context.compiledContextBytes = 1; },
    (value) => { value.tokens.tokenSource = 'EXACT'; },
    (value) => { value.identity.workUnitId = 'GATE17'; }
  ]) {
    const copy = JSON.parse(JSON.stringify(receipt));
    mutate(copy);
    assert.equal(verifyExecutionEfficiencyReceipt(copy).valid, false);
  }
  assert.equal(verifyExecutionEfficiencyReceipt(null).valid, false);
  // Identical measurements produce an identical digest regardless of build order.
  assert.equal(build().receiptSha256, build().receiptSha256);
});

test('ER04 a negative or non-integer measurement is refused, never rounded away', () => {
  assert.throws(() => build({ work: { candidateWorkUnits: -1, executedWorkUnits: 0, avoidedWorkUnits: 0 } }), /EFFICIENCY_RECEIPT_INVALID_CANDIDATE_WORK_UNITS/);
  assert.throws(() => build({ reuse: { evidenceAvailable: 1.5, evidenceReused: 0, evidenceRecomputed: 0 } }), /EFFICIENCY_RECEIPT_INVALID_EVIDENCE_AVAILABLE/);
  assert.throws(() => build({ execution: { wallTimeMs: -5 } }), /EFFICIENCY_RECEIPT_INVALID_WALL_TIME_MS/);
  assert.throws(() => buildExecutionEfficiencyReceipt({ identity: { workUnitId: 'GATE16' } }), /EFFICIENCY_RECEIPT_BASELINE_HEAD_REQUIRED/);
  assert.throws(() => buildExecutionEfficiencyReceipt({ identity: { workUnitId: 'GATE16', baselineHead: 'a' } }), /EFFICIENCY_RECEIPT_EXECUTION_IDENTITY_REQUIRED/);
});

/* -------------------------------------------------------------------------
 * The strict token rule
 * ---------------------------------------------------------------------- */

test('ER05 a token count can never appear without a source that could have produced it', () => {
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'UNAVAILABLE', inputTokens: 100 }), /TOKEN_COUNT_WITHOUT_SOURCE/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'UNAVAILABLE', outputTokens: 1 }), /TOKEN_COUNT_WITHOUT_SOURCE/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'UNAVAILABLE', cachedInputTokens: 1 }), /TOKEN_COUNT_WITHOUT_SOURCE/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'UNAVAILABLE', measurementSource: 'invented' }), /TOKEN_METHOD_WITHOUT_COUNT/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'EXACT', inputTokens: 10, outputTokens: 2 }), /TOKEN_MEASUREMENT_SOURCE_REQUIRED/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'ESTIMATED', inputTokens: 10, outputTokens: 2 }), /TOKEN_ESTIMATION_METHOD_REQUIRED/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'EXACT', inputTokens: 10, outputTokens: 2, measurementSource: 'x', estimationMethod: 'y' }), /EXACT_TOKENS_CANNOT_DECLARE_ESTIMATION/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'EXACT', measurementSource: 'x' }), /TOKEN_COUNT_REQUIRED_FOR:EXACT/);
  assert.throws(() => normalizeTokenBlock({ tokenSource: 'GUESSED' }), /INVALID_TOKEN_SOURCE/);
});

test('ER06 UNAVAILABLE is the default and records why, with every count null', () => {
  const absent = normalizeTokenBlock(null);
  assert.equal(absent.tokenSource, 'UNAVAILABLE');
  assert.equal(absent.inputTokens, null);
  assert.equal(absent.cachedInputTokens, null);
  assert.equal(absent.outputTokens, null);
  assert.equal(absent.totalTokens, null);
  assert.equal(absent.unavailableReason, 'NO_RUNTIME_TOKEN_COUNTER_EXPOSED');
  const stated = normalizeTokenBlock({ tokenSource: 'UNAVAILABLE', unavailableReason: 'DETERMINISTIC_LOCAL_EXECUTION_EXPOSES_NO_TOKEN_COUNTER' });
  assert.equal(stated.unavailableReason, 'DETERMINISTIC_LOCAL_EXECUTION_EXPOSES_NO_TOKEN_COUNTER');
});

test('ER07 EXACT and ESTIMATED are distinct states that map onto the R6 usage ledger vocabulary', () => {
  const exact = normalizeTokenBlock({ tokenSource: 'EXACT', inputTokens: 1200, cachedInputTokens: 900, outputTokens: 300, measurementSource: 'ANTHROPIC_API_USAGE_BLOCK' });
  assert.equal(exact.totalTokens, 1500);
  assert.equal(exact.usageLedgerMeasurementState, TOKEN_COUNT_MEASURED);
  assert.equal(exact.estimationMethod, null);

  const estimated = normalizeTokenBlock({ tokenSource: 'ESTIMATED', inputTokens: 1000, outputTokens: 100, estimationMethod: 'BYTES_DIV_4_DETERMINISTIC' });
  assert.equal(estimated.usageLedgerMeasurementState, TOKEN_COUNT_ESTIMATED);
  assert.equal(estimated.measurementSource, null);
  // An estimate can never be read back as a measurement.
  assert.notEqual(estimated.usageLedgerMeasurementState, exact.usageLedgerMeasurementState);

  assert.deepEqual(TOKEN_SOURCES, ['EXACT', 'ESTIMATED', 'UNAVAILABLE']);
  assert.deepEqual(TOKEN_SOURCE_TO_USAGE_LEDGER_STATE, {
    EXACT: TOKEN_COUNT_MEASURED, ESTIMATED: TOKEN_COUNT_ESTIMATED, UNAVAILABLE: TOKEN_COUNT_UNAVAILABLE
  });
});

test('ER08 unavailable tokens never block the rest of the receipt', () => {
  const receipt = build({ tokens: { tokenSource: 'UNAVAILABLE' } });
  assert.equal(receipt.tokens.tokenSource, 'UNAVAILABLE');
  assert.equal(receipt.context.contextReductionRatio, 25);
  assert.equal(receipt.work.r5ReductionRatio, 0.8);
  assert.equal(receipt.execution.filesConsidered, 435);
  assert.equal(verifyExecutionEfficiencyReceipt(receipt).valid, true);
});

test('ER09 the process-call counter reports only what its own scope observed', () => {
  const counter = createProcessCallCounter('GATE_FAST_PATH_CONTROL_PLANE');
  assert.equal(counter.count, 0);
  counter.record();
  counter.record();
  assert.deepEqual(counter.snapshot(), { toolProcessCalls: 2, toolProcessCallScope: 'GATE_FAST_PATH_CONTROL_PLANE' });
  // A caller with nothing it can honestly count reports null, not zero.
  const unknown = build({ execution: { toolProcessCalls: null } });
  assert.equal(unknown.execution.toolProcessCalls, null);
});

/* -------------------------------------------------------------------------
 * Live emission and observational-only guarantee
 * ---------------------------------------------------------------------- */

test('ER10 the real fast path emits a valid receipt automatically', async () => {
  const { runFastPathControlPlane } = await import('../../tools/gate-fast-path-control-plane.mjs');
  const report = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE16', phase: 'READINESS' });
  const receipt = report.efficiency;
  assert.ok(receipt, 'a receipt must be emitted without being asked for');
  assert.equal(verifyExecutionEfficiencyReceipt(receipt).valid, true);

  // The receipt describes THIS execution, not a template.
  assert.equal(receipt.identity.workUnitId, 'GATE16');
  assert.equal(receipt.identity.baselineHead, report.baseline.currentHead);
  assert.equal(receipt.identity.geeExecutionId, report.runtime.ephemeralRunRoot.runId);
  assert.equal(receipt.context.originalConsideredBytes, report.chain.r2.sourceBytes);
  assert.equal(receipt.context.compiledContextBytes, report.chain.r2.compiledJsonBytes);
  assert.equal(receipt.reuse.evidenceAvailable, report.chain.r4.nodeCount);
  assert.equal(receipt.work.candidateWorkUnits, report.chain.r5.taskCount);
  assert.equal(receipt.work.executedWorkUnits, report.workset.requiredWorkset.length);
  assert.equal(receipt.work.avoidedWorkUnits, report.workset.excludedByProvenReuse.length);
  assert.equal(receipt.execution.filesConsumed, report.chain.r2.relevantSourceCount + report.chain.r3.frontierTrackedPaths.length);
  assert.ok(receipt.execution.filesConsidered > receipt.execution.filesConsumed);
  assert.ok(receipt.context.contextReductionRatio > 1);

  // Tokens are UNAVAILABLE here, and honestly so.
  assert.equal(receipt.tokens.tokenSource, 'UNAVAILABLE');
  assert.equal(receipt.tokens.totalTokens, null);
  assert.equal(receipt.tokens.unavailableReason, 'DETERMINISTIC_LOCAL_EXECUTION_EXPOSES_NO_TOKEN_COUNTER');

  // Measurement is cheap: building the receipt is a small fraction of the run.
  assert.ok(report.runtime.efficiencyReceiptOverheadMs <= 100, `overhead ${report.runtime.efficiencyReceiptOverheadMs}ms`);
  assert.ok(report.runtime.efficiencyReceiptOverheadMs * 20 < receipt.execution.wallTimeMs);
});

test('ER11 the receipt is observational: no decision surface reads it', () => {
  // A decision that consulted the receipt would have to name it. The control
  // plane writes `report.efficiency` exactly once and never reads it back, and
  // no verdict, routing, authority or closure surface imports this module.
  const controlPlane = fs.readFileSync(path.join(REPO_ROOT, 'governance', 'tools', 'gate-fast-path-control-plane.mjs'), 'utf8');
  // `\b` keeps `report.efficiencyInputs` — a different, internal field — out of
  // both counts.
  const writes = controlPlane.match(/report\.efficiency\b\s*=/g) || [];
  const reads = controlPlane.match(/report\.efficiency\b(?!\s*=)/g) || [];
  assert.equal(writes.length, 1, 'the receipt is written exactly once');
  assert.deepEqual(reads, [], 'the receipt is never read back');
  assert.equal(/blockingFacts\.push\([^)]*efficiency/i.test(controlPlane), false);
  assert.equal(/verdict[^\n]*efficiency/i.test(controlPlane), false);

  for (const decisionSurface of [
    'governance/gee-v1/router/router-engine.mjs',
    'governance/gee-v1/router/router-policy.mjs',
    'governance/gee-v1/recovery/recovery-engine.mjs',
    'governance/gee-v1/evidence/evidence-graph.mjs',
    'governance/gee-v1/delta/delta-engine.mjs',
    'governance/gee-v1/context/compile-context.mjs',
    'governance/gee-v1/core/work-unit-core.mjs'
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, ...decisionSurface.split('/')), 'utf8');
    assert.equal(source.includes('execution-efficiency-receipt'), false, decisionSurface);
  }
});

test('ER12 the same execution measured twice reports the same efficiency facts', async () => {
  const { runFastPathControlPlane } = await import('../../tools/gate-fast-path-control-plane.mjs');
  const first = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE16', phase: 'READINESS' });
  const second = await runFastPathControlPlane({ root: REPO_ROOT, gateId: 'GATE16', phase: 'READINESS' });
  const stable = (receipt) => ({ context: receipt.context, delta: receipt.delta, reuse: receipt.reuse, work: receipt.work, tokens: receipt.tokens, filesConsidered: receipt.execution.filesConsidered, filesConsumed: receipt.execution.filesConsumed });
  assert.deepEqual(stable(first.efficiency), stable(second.efficiency));
  // Only the run identity, wall time and timestamps differ.
  assert.notEqual(first.efficiency.identity.geeExecutionId, second.efficiency.identity.geeExecutionId);
});
