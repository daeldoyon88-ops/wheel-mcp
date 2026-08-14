/**
 * GEE_EXECUTION_EFFICIENCY_RECEIPT — what one governed execution actually cost,
 * measured, not asserted.
 *
 * The GEE stack claims it reduces context, work and time. Until now that claim
 * was checked by a heavy R7 benchmark that is deliberately rare, which means the
 * ordinary Gate produced no evidence about its own efficiency at all. This
 * builds a receipt from numbers the fast path ALREADY computed on its way to a
 * decision — R2's compile metrics, R3's delta, R4's evaluation, R5's plan, R6's
 * recovery — so the measurement costs one object construction and cannot drift
 * from the execution it describes.
 *
 * OBSERVATIONAL ONLY. Nothing here is read back by routing, authority, closure
 * or quality logic. A receipt that could not be built is absent; it never
 * blocks, never downgrades a verdict, and never becomes an input to one.
 *
 * THE TOKEN RULE IS THE ONLY PLACE THIS FILE IS STRICT, and it is strict in one
 * direction: a number may not appear without a source that could have produced
 * it.
 *
 *     EXACT        a real runtime counter was read; measurementSource names it
 *     ESTIMATED    no counter exists, but a declared deterministic method does
 *     UNAVAILABLE  neither; every count is null
 *
 * Declaring EXACT or ESTIMATED while carrying no source, or UNAVAILABLE while
 * carrying a count, throws. Deterministic local Node execution exposes no token
 * counter, so UNAVAILABLE is the honest and expected answer there — and it is
 * explicitly NOT a blocker for the rest of the receipt, which is the whole
 * reason tokens are a leaf field rather than a precondition.
 *
 * This vocabulary maps onto the R6 usage ledger's existing three states rather
 * than inventing a fourth: EXACT ↔ MEASURED, ESTIMATED ↔ ESTIMATED,
 * UNAVAILABLE ↔ TOKEN_COUNT_UNAVAILABLE.
 */

import { sha256Canonical } from '../../tools/canonical-json.mjs';
import {
  TOKEN_COUNT_ESTIMATED, TOKEN_COUNT_MEASURED, TOKEN_COUNT_UNAVAILABLE
} from '../usage/usage-ledger.mjs';

export const EFFICIENCY_RECEIPT_DOCUMENT = 'GEE_EXECUTION_EFFICIENCY_RECEIPT';
export const EFFICIENCY_RECEIPT_ENGINE = 'GEE_V1_EXECUTION_EFFICIENCY_RECEIPT_R1';

export const TOKEN_SOURCE_EXACT = 'EXACT';
export const TOKEN_SOURCE_ESTIMATED = 'ESTIMATED';
export const TOKEN_SOURCE_UNAVAILABLE = 'UNAVAILABLE';
export const TOKEN_SOURCES = Object.freeze([TOKEN_SOURCE_EXACT, TOKEN_SOURCE_ESTIMATED, TOKEN_SOURCE_UNAVAILABLE]);

/** The R6 usage-ledger measurement state each token source corresponds to. */
export const TOKEN_SOURCE_TO_USAGE_LEDGER_STATE = Object.freeze({
  [TOKEN_SOURCE_EXACT]: TOKEN_COUNT_MEASURED,
  [TOKEN_SOURCE_ESTIMATED]: TOKEN_COUNT_ESTIMATED,
  [TOKEN_SOURCE_UNAVAILABLE]: TOKEN_COUNT_UNAVAILABLE
});

export const R7_MODE_LIGHT = 'LIGHT';
export const R7_MODE_HEAVY = 'HEAVY';

const nullableCount = (value, field) => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`EFFICIENCY_RECEIPT_INVALID_${field}:${String(value)}`);
  return value;
};

const count = (value, field) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`EFFICIENCY_RECEIPT_INVALID_${field}:${String(value)}`);
  return value;
};

/**
 * A ratio, rounded once at the boundary so the same execution always yields the
 * same digest. A zero denominator is `null` — "no basis to compare" — never 0
 * or 1, both of which would read as a measurement.
 */
function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

/**
 * The token block. This is the receipt's only fail-closed surface.
 */
export function normalizeTokenBlock(input) {
  const supplied = input === undefined || input === null ? { tokenSource: TOKEN_SOURCE_UNAVAILABLE } : input;
  if (typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('EFFICIENCY_RECEIPT_INVALID_TOKENS');
  const tokenSource = supplied.tokenSource ?? TOKEN_SOURCE_UNAVAILABLE;
  if (!TOKEN_SOURCES.includes(tokenSource)) throw new Error(`EFFICIENCY_RECEIPT_INVALID_TOKEN_SOURCE:${String(tokenSource)}`);
  const inputTokens = nullableCount(supplied.inputTokens, 'INPUT_TOKENS');
  const cachedInputTokens = nullableCount(supplied.cachedInputTokens, 'CACHED_INPUT_TOKENS');
  const outputTokens = nullableCount(supplied.outputTokens, 'OUTPUT_TOKENS');
  const measurementSource = typeof supplied.measurementSource === 'string' && supplied.measurementSource ? supplied.measurementSource : null;
  const estimationMethod = typeof supplied.estimationMethod === 'string' && supplied.estimationMethod ? supplied.estimationMethod : null;

  if (tokenSource === TOKEN_SOURCE_UNAVAILABLE) {
    if (inputTokens !== null || cachedInputTokens !== null || outputTokens !== null) {
      throw new Error('EFFICIENCY_RECEIPT_TOKEN_COUNT_WITHOUT_SOURCE');
    }
    if (measurementSource !== null || estimationMethod !== null) throw new Error('EFFICIENCY_RECEIPT_TOKEN_METHOD_WITHOUT_COUNT');
    return {
      inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null,
      tokenSource, measurementSource: null, estimationMethod: null,
      usageLedgerMeasurementState: TOKEN_SOURCE_TO_USAGE_LEDGER_STATE[tokenSource],
      unavailableReason: typeof supplied.unavailableReason === 'string' && supplied.unavailableReason
        ? supplied.unavailableReason
        : 'NO_RUNTIME_TOKEN_COUNTER_EXPOSED'
    };
  }
  if (inputTokens === null || outputTokens === null) throw new Error(`EFFICIENCY_RECEIPT_TOKEN_COUNT_REQUIRED_FOR:${tokenSource}`);
  if (tokenSource === TOKEN_SOURCE_EXACT && measurementSource === null) throw new Error('EFFICIENCY_RECEIPT_TOKEN_MEASUREMENT_SOURCE_REQUIRED');
  if (tokenSource === TOKEN_SOURCE_ESTIMATED && estimationMethod === null) throw new Error('EFFICIENCY_RECEIPT_TOKEN_ESTIMATION_METHOD_REQUIRED');
  if (tokenSource === TOKEN_SOURCE_EXACT && estimationMethod !== null) throw new Error('EFFICIENCY_RECEIPT_EXACT_TOKENS_CANNOT_DECLARE_ESTIMATION');
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    tokenSource,
    measurementSource,
    estimationMethod,
    usageLedgerMeasurementState: TOKEN_SOURCE_TO_USAGE_LEDGER_STATE[tokenSource],
    unavailableReason: null
  };
}

/**
 * Builds the receipt from an execution's own measurements.
 *
 * Every argument is a number the caller already had. Nothing is recomputed
 * here, and nothing is derived from a second traversal of the repository — the
 * receipt must stay cheap enough that emitting it on every governed execution
 * is never a reason not to.
 */
export function buildExecutionEfficiencyReceipt({
  identity,
  context,
  delta,
  reuse,
  work,
  recovery,
  execution,
  tokens = null,
  now = new Date()
} = {}) {
  if (!identity || typeof identity !== 'object') throw new Error('EFFICIENCY_RECEIPT_IDENTITY_REQUIRED');
  if (typeof identity.workUnitId !== 'string' || !identity.workUnitId) throw new Error('EFFICIENCY_RECEIPT_WORK_UNIT_REQUIRED');
  if (typeof identity.baselineHead !== 'string' || !identity.baselineHead) throw new Error('EFFICIENCY_RECEIPT_BASELINE_HEAD_REQUIRED');
  if (typeof identity.geeExecutionId !== 'string' || !identity.geeExecutionId) throw new Error('EFFICIENCY_RECEIPT_EXECUTION_IDENTITY_REQUIRED');

  const consideredBytes = nullableCount(context?.originalConsideredBytes, 'ORIGINAL_CONSIDERED_BYTES');
  const compiledBytes = count(context?.compiledContextBytes ?? 0, 'COMPILED_CONTEXT_BYTES');

  const evidenceAvailable = count(reuse?.evidenceAvailable ?? 0, 'EVIDENCE_AVAILABLE');
  const evidenceReused = count(reuse?.evidenceReused ?? 0, 'EVIDENCE_REUSED');
  const evidenceRecomputed = count(reuse?.evidenceRecomputed ?? 0, 'EVIDENCE_RECOMPUTED');

  const candidateWorkUnits = count(work?.candidateWorkUnits ?? 0, 'CANDIDATE_WORK_UNITS');
  const executedWorkUnits = count(work?.executedWorkUnits ?? 0, 'EXECUTED_WORK_UNITS');
  const avoidedWorkUnits = count(work?.avoidedWorkUnits ?? 0, 'AVOIDED_WORK_UNITS');

  const body = {
    document: EFFICIENCY_RECEIPT_DOCUMENT,
    schemaVersion: 1,
    engine: EFFICIENCY_RECEIPT_ENGINE,
    mode: 'OBSERVATIONAL_ONLY',
    generatedAt: now.toISOString(),
    identity: {
      workUnitId: identity.workUnitId,
      missionId: identity.missionId ?? null,
      phase: identity.phase ?? null,
      baselineHead: identity.baselineHead,
      geeExecutionId: identity.geeExecutionId,
      missionRevisionId: identity.missionRevisionId ?? null,
      consumer: identity.consumer ?? null
    },
    context: {
      // "Considered" is the byte total of the canonical sources the work unit's
      // authority is derived from — what an execution without R2 would have to
      // carry. Absent rather than guessed when the compiler could not report it.
      originalConsideredBytes: consideredBytes,
      compiledContextBytes: compiledBytes,
      contextReductionRatio: ratio(consideredBytes, compiledBytes),
      contextBytesAvoided: consideredBytes === null ? null : Math.max(0, consideredBytes - compiledBytes),
      measurementSource: context?.measurementSource ?? 'R2_COMPILE_CONTEXT_METRICS'
    },
    delta: {
      classification: delta?.classification ?? {},
      comparisonBasis: delta?.comparisonBasis ?? null,
      changedBytes: nullableCount(delta?.changedBytes, 'CHANGED_BYTES'),
      unchangedBytes: nullableCount(delta?.unchangedBytes, 'UNCHANGED_BYTES'),
      avoidedReprocessBytes: nullableCount(delta?.avoidedReprocessBytes, 'AVOIDED_REPROCESS_BYTES')
    },
    reuse: {
      evidenceAvailable,
      evidenceReused,
      evidenceRecomputed,
      r4ReuseRatio: ratio(evidenceReused, evidenceAvailable),
      avoidedEvidenceBytes: nullableCount(reuse?.avoidedEvidenceBytes, 'AVOIDED_EVIDENCE_BYTES')
    },
    work: {
      candidateWorkUnits,
      executedWorkUnits,
      avoidedWorkUnits,
      deferredWorkUnits: count(work?.deferredWorkUnits ?? 0, 'DEFERRED_WORK_UNITS'),
      blockedWorkUnits: count(work?.blockedWorkUnits ?? 0, 'BLOCKED_WORK_UNITS'),
      r5ReductionRatio: ratio(avoidedWorkUnits, candidateWorkUnits),
      routeDecision: work?.routeDecision ?? null
    },
    recovery: {
      resumed: recovery?.resumed === true,
      restartedFromZero: recovery?.restartedFromZero === true,
      checkpointRevision: recovery?.checkpointRevision ?? null,
      durableStateRoot: recovery?.durableStateRoot ?? null,
      durableStateRootSource: recovery?.durableStateRootSource ?? null
    },
    execution: {
      filesConsidered: nullableCount(execution?.filesConsidered, 'FILES_CONSIDERED'),
      filesConsumed: nullableCount(execution?.filesConsumed, 'FILES_CONSUMED'),
      // Only calls this process can count itself. A null here means "not
      // deterministically observable", which is a fact, not a gap to fill.
      toolProcessCalls: nullableCount(execution?.toolProcessCalls, 'TOOL_PROCESS_CALLS'),
      toolProcessCallScope: execution?.toolProcessCallScope ?? null,
      wallTimeMs: nullableCount(execution?.wallTimeMs, 'WALL_TIME_MS'),
      r7Mode: execution?.r7Mode === R7_MODE_HEAVY ? R7_MODE_HEAVY : R7_MODE_LIGHT,
      r7HeavyBenchmarkRequired: execution?.r7HeavyBenchmarkRequired === true,
      qualityParity: execution?.qualityParity ?? 'NOT_APPLICABLE',
      ephemeralRunRoot: execution?.ephemeralRunRoot ?? null,
      ephemeralRunRootReleased: execution?.ephemeralRunRootReleased ?? null
    },
    tokens: normalizeTokenBlock(tokens)
  };
  return { ...body, receiptSha256: sha256Canonical(body) };
}

/** Recomputes the digest over the receipt body. */
export function verifyExecutionEfficiencyReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return { valid: false, reasonCodes: ['RECEIPT_REQUIRED'] };
  const reasonCodes = [];
  if (receipt.document !== EFFICIENCY_RECEIPT_DOCUMENT) reasonCodes.push('RECEIPT_DOCUMENT_INVALID');
  if (receipt.engine !== EFFICIENCY_RECEIPT_ENGINE) reasonCodes.push('RECEIPT_ENGINE_INVALID');
  if (receipt.mode !== 'OBSERVATIONAL_ONLY') reasonCodes.push('RECEIPT_MODE_INVALID');
  if (!TOKEN_SOURCES.includes(receipt.tokens?.tokenSource)) reasonCodes.push('RECEIPT_TOKEN_SOURCE_INVALID');
  const { receiptSha256, ...body } = receipt;
  if (sha256Canonical(body) !== receiptSha256) reasonCodes.push('RECEIPT_DIGEST_MISMATCH');
  return { valid: reasonCodes.length === 0, reasonCodes };
}

/**
 * A counter for process spawns a caller can observe in its own code.
 *
 * Deliberately minimal: it counts what the calling module invokes directly and
 * says so in `scope`. Anything spawned deeper is NOT attributed to it, because
 * a number that quietly under-counts is worse than an honest null.
 */
export function createProcessCallCounter(scope) {
  let calls = 0;
  return {
    scope,
    record() { calls += 1; return calls; },
    get count() { return calls; },
    snapshot() { return { toolProcessCalls: calls, toolProcessCallScope: scope }; }
  };
}
