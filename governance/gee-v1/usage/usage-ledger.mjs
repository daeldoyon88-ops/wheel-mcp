/**
 * GEE V1 R6 usage ledger.
 *
 * This records WHAT EXECUTION ACTUALLY CONSUMED and WHAT REUSE ACTUALLY
 * AVOIDED. It is not a billing system and not a second governance event log:
 * it is a plain append-only value, serialisable to one JSON document, that a
 * caller stores wherever it already stores its own state.
 *
 * Three rules do all the work.
 *
 * 1. TOKENS ARE NEVER INVENTED. A runtime that supplies no token count is
 *    recorded as TOKEN_COUNT_UNAVAILABLE, and a record that declares that state
 *    while also carrying an exact count is rejected. MEASURED and ESTIMATED are
 *    separate states, each requiring an explicit measurement source, so an
 *    estimate can never be read back as a measurement.
 *
 * 2. IDENTITY SEPARATES REPLAY FROM RETRY. A record's identity is
 *    (workUnitId, taskId, attempt). Re-appending the same execution is a replay
 *    and adds nothing; a genuine second attempt carries attempt+1 and is a
 *    different record that counts separately. Two records claiming one identity
 *    with different content is a contradiction and fails closed rather than
 *    letting append order decide which one history keeps.
 *
 * 3. UNSTABLE RUNTIME LABELS STAY OUT OF IDENTITY. Which provider served a task
 *    and how many milliseconds it took are observations, not identity, so
 *    renaming a provider cannot fork one execution into two records — the
 *    historical record is preserved exactly as first written.
 *
 * History is append-only in a way that survives a hostile edit: every record
 * carries the digest of the ledger as it stood immediately before the append,
 * so rewriting or deleting an earlier record breaks the chain of every later
 * one. Totals are never stored; aggregateUsage() recomputes them from the raw
 * records, so no aggregate can drift away from the history it summarises.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { CAPABILITY_CLASSES } from '../router/router-policy.mjs';

export const USAGE_LEDGER_VERSION = 'GEE_V1_USAGE_LEDGER_R6';
export const USAGE_LEDGER_KIND = 'GEE_USAGE_LEDGER';
export const USAGE_RECORD_KIND = 'GEE_USAGE_RECORD';

/** What happened to the task this record describes. */
export const COMPLETED = 'COMPLETED';
export const FAILED = 'FAILED';
export const BLOCKED = 'BLOCKED';
export const DEFERRED = 'DEFERRED';
export const OWNER_DECISION_REQUIRED = 'OWNER_DECISION_REQUIRED';
export const AVOIDED_BY_REUSE = 'AVOIDED_BY_REUSE';
export const USAGE_OUTCOMES = Object.freeze([COMPLETED, FAILED, BLOCKED, DEFERRED, OWNER_DECISION_REQUIRED, AVOIDED_BY_REUSE]);

/** The three honest states a token count can be in. Never mixed, never implied. */
export const TOKEN_COUNT_UNAVAILABLE = 'TOKEN_COUNT_UNAVAILABLE';
export const TOKEN_COUNT_MEASURED = 'MEASURED';
export const TOKEN_COUNT_ESTIMATED = 'ESTIMATED';
export const TOKEN_MEASUREMENT_STATES = Object.freeze([TOKEN_COUNT_UNAVAILABLE, TOKEN_COUNT_MEASURED, TOKEN_COUNT_ESTIMATED]);

const BYTE_FIELDS = Object.freeze([
  'contextBytes', 'sourceProcessedBytes', 'sourceAvoidedBytes', 'evidenceReusedBytes', 'evidenceRevalidatedBytes'
]);

function compareIdentifiers(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function canonicalIdentifier(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`USAGE_${field}_REQUIRED`);
  if (value !== value.normalize('NFC')) throw new Error(`NON_CANONICAL_USAGE_${field}:${value}`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`INVALID_USAGE_${field}:${String(value)}`);
  return value;
}

function normalizeBytes(input) {
  if (input === undefined || input === null) return Object.fromEntries(BYTE_FIELDS.map((field) => [field, 0]));
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_USAGE_BYTES');
  for (const field of Object.keys(input)) {
    if (!BYTE_FIELDS.includes(field)) throw new Error(`UNKNOWN_USAGE_BYTE_FIELD:${field}`);
  }
  return Object.fromEntries(BYTE_FIELDS.map((field) => [field, nonNegativeInteger(input[field] === undefined ? 0 : input[field], `BYTES_${field}`)]));
}

/**
 * The token block, and the only place a token count may enter the ledger.
 *
 * The asymmetry is deliberate. An absent count is a fact about the runtime and
 * is recorded as such; a present count must say where it came from and whether
 * it was measured or estimated. Declaring UNAVAILABLE while carrying a number
 * is the exact shape of a fabricated exact count, so it is refused.
 */
function normalizeTokens(input) {
  const supplied = input === undefined || input === null ? { measurement: TOKEN_COUNT_UNAVAILABLE } : input;
  if (typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('INVALID_USAGE_TOKENS');
  for (const field of Object.keys(supplied)) {
    if (!['measurement', 'inputTokens', 'outputTokens', 'source'].includes(field)) throw new Error(`UNKNOWN_USAGE_TOKEN_FIELD:${field}`);
  }
  const measurement = supplied.measurement === undefined ? TOKEN_COUNT_UNAVAILABLE : supplied.measurement;
  if (!TOKEN_MEASUREMENT_STATES.includes(measurement)) throw new Error(`INVALID_TOKEN_MEASUREMENT_STATE:${String(measurement)}`);
  const inputTokens = supplied.inputTokens === undefined ? null : supplied.inputTokens;
  const outputTokens = supplied.outputTokens === undefined ? null : supplied.outputTokens;
  const source = supplied.source === undefined ? null : supplied.source;
  if (measurement === TOKEN_COUNT_UNAVAILABLE) {
    if (inputTokens !== null || outputTokens !== null) throw new Error('TOKEN_COUNT_CLAIMED_WITHOUT_MEASUREMENT');
    if (source !== null) throw new Error('TOKEN_MEASUREMENT_SOURCE_WITHOUT_MEASUREMENT');
    return { measurement, inputTokens: null, outputTokens: null, source: null };
  }
  nonNegativeInteger(inputTokens, 'INPUT_TOKENS');
  nonNegativeInteger(outputTokens, 'OUTPUT_TOKENS');
  if (typeof source !== 'string' || !source) throw new Error('TOKEN_MEASUREMENT_SOURCE_REQUIRED');
  return { measurement, inputTokens, outputTokens, source: canonicalIdentifier(source, 'TOKEN_MEASUREMENT_SOURCE') };
}

/** Canonical identity of one execution attempt. */
export function usageRecordIdFor({ workUnitId, taskId, attempt } = {}) {
  const unit = canonicalIdentifier(workUnitId, 'WORK_UNIT_ID');
  const task = canonicalIdentifier(taskId, 'TASK_ID');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`INVALID_USAGE_ATTEMPT:${String(attempt)}`);
  return `usage:${unit}#${task}#${attempt}`;
}

/**
 * Fields that identify the execution, as opposed to fields that merely observe
 * it. provider, durationMs and observedAt are excluded on purpose: they are
 * runtime labels and wall-clock readings, and letting them into identity would
 * make one execution hash differently on a rename or a slower machine.
 */
function identityBody(record) {
  return {
    recordKind: USAGE_RECORD_KIND,
    engine: USAGE_LEDGER_VERSION,
    schemaVersion: 1,
    workUnitId: record.workUnitId,
    taskId: record.taskId,
    attempt: record.attempt,
    capability: record.capability,
    outcome: record.outcome,
    routeSha256: record.routeSha256,
    bytes: record.bytes,
    tokens: record.tokens
  };
}

export function usageRecordSha256(record) { return sha256Canonical(identityBody(record)); }

export function normalizeUsageRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('USAGE_RECORD_REQUIRED');
  const workUnitId = canonicalIdentifier(input.workUnitId, 'WORK_UNIT_ID');
  const taskId = canonicalIdentifier(input.taskId, 'TASK_ID');
  const attempt = input.attempt === undefined ? 1 : input.attempt;
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`INVALID_USAGE_ATTEMPT:${String(attempt)}`);
  if (!CAPABILITY_CLASSES.includes(input.capability)) throw new Error(`INVALID_USAGE_CAPABILITY:${String(input.capability)}`);
  if (!USAGE_OUTCOMES.includes(input.outcome)) throw new Error(`INVALID_USAGE_OUTCOME:${String(input.outcome)}`);
  if (typeof input.routeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.routeSha256)) throw new Error('USAGE_ROUTE_IDENTITY_REQUIRED');
  const durationMs = input.durationMs === undefined || input.durationMs === null ? null : nonNegativeInteger(input.durationMs, 'DURATION_MS');
  const provider = input.provider === undefined || input.provider === null ? null : canonicalIdentifier(input.provider, 'PROVIDER');
  const observedAt = input.observedAt === undefined || input.observedAt === null ? null : canonicalIdentifier(input.observedAt, 'OBSERVED_AT');
  const record = {
    recordKind: USAGE_RECORD_KIND,
    engine: USAGE_LEDGER_VERSION,
    schemaVersion: 1,
    workUnitId,
    taskId,
    attempt,
    capability: input.capability,
    outcome: input.outcome,
    routeSha256: input.routeSha256,
    bytes: normalizeBytes(input.bytes),
    tokens: normalizeTokens(input.tokens),
    provider,
    durationMs,
    observedAt,
    usageRecordId: usageRecordIdFor({ workUnitId, taskId, attempt })
  };
  return { ...record, usageRecordSha256: usageRecordSha256(record) };
}

const USAGE_RECORD_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'usage-record.schema.json'), 'utf8')
);

/**
 * Conformance of a MATERIALIZED usage record: structure, then identity.
 *
 * Structure alone would accept a record whose declared id or digest describes a
 * different execution than its own fields do, which is exactly what a hand-
 * edited history looks like, so both are recomputed and compared.
 */
export function validateUsageRecord(record) {
  const structural = validateAgainstJsonSchema(record, USAGE_RECORD_SCHEMA);
  if (!structural.valid) return structural;
  const errors = [];
  let normalized;
  try {
    const { previousLedgerSha256, ...body } = record;
    normalized = normalizeUsageRecord(body);
  } catch (error) {
    return { valid: false, errors: [{ jsonPointer: '/', reason: 'INVALID_USAGE_RECORD', message: error.message }] };
  }
  if (normalized.usageRecordId !== record.usageRecordId) {
    errors.push({ jsonPointer: '/usageRecordId', reason: 'USAGE_RECORD_ID_MISMATCH', message: 'declared id does not describe this record' });
  }
  if (normalized.usageRecordSha256 !== record.usageRecordSha256) {
    errors.push({ jsonPointer: '/usageRecordSha256', reason: 'INVALID_USAGE_RECORD_DIGEST', message: 'digest does not match the record body' });
  }
  return { valid: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------
 * Ledger
 * ---------------------------------------------------------------------- */

function ledgerBody(records) {
  return { schemaVersion: 1, ledgerKind: USAGE_LEDGER_KIND, engine: USAGE_LEDGER_VERSION, records };
}

function sealLedger(records) {
  const body = ledgerBody(records);
  return Object.freeze({ ...body, records: Object.freeze(records.map((record) => Object.freeze({ ...record }))), ledgerSha256: sha256Canonical(body) });
}

export function createUsageLedger() { return sealLedger([]); }

/**
 * Appends one record and returns a NEW ledger. The supplied ledger is never
 * mutated, and it is verified first so a tampered history cannot be extended
 * into a clean-looking one.
 *
 * Replay is idempotent: an identical record already in history returns the same
 * ledger with appended:false, which is what makes a crash-and-resume unable to
 * double-count. A record reusing an existing identity with different content is
 * a contradiction, not an update, and throws.
 *
 * @returns {{ ledger: object, appended: boolean, deduplicated: boolean, usageRecordId: string }}
 */
export function appendUsageRecord(ledger, input) {
  verifyUsageLedger(ledger);
  const record = normalizeUsageRecord(input);
  const existing = ledger.records.find((entry) => entry.usageRecordId === record.usageRecordId);
  if (existing) {
    if (existing.usageRecordSha256 !== record.usageRecordSha256) {
      throw new Error(`DUPLICATE_USAGE_RECORD_IDENTITY_CONFLICT:${record.usageRecordId}`);
    }
    return { ledger, appended: false, deduplicated: true, usageRecordId: record.usageRecordId };
  }
  const records = ledger.records.map((entry) => ({ ...entry }));
  const appendedRecord = { ...record, previousLedgerSha256: ledger.ledgerSha256 };
  return { ledger: sealLedger([...records, appendedRecord]), appended: true, deduplicated: false, usageRecordId: record.usageRecordId };
}

/**
 * Replays the ledger from empty. Structure, chain, normalization and record
 * identity are all recomputed, so an edited, reordered, deleted or invented
 * record fails here rather than quietly changing a total.
 */
export function verifyUsageLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new Error('USAGE_LEDGER_REQUIRED');
  if (ledger.schemaVersion !== 1 || ledger.ledgerKind !== USAGE_LEDGER_KIND || ledger.engine !== USAGE_LEDGER_VERSION) throw new Error('INVALID_USAGE_LEDGER_IDENTITY');
  if (!Array.isArray(ledger.records)) throw new Error('INVALID_USAGE_LEDGER_STRUCTURE');
  const replay = [];
  const seen = new Set();
  for (const record of ledger.records) {
    const expectedPrevious = sealLedger(replay.map((entry) => ({ ...entry }))).ledgerSha256;
    if (record?.previousLedgerSha256 !== expectedPrevious) throw new Error(`USAGE_LEDGER_CHAIN_BROKEN:${record?.usageRecordId ?? 'UNKNOWN'}`);
    const { previousLedgerSha256, ...body } = record;
    const normalized = normalizeUsageRecord(body);
    if (sha256Canonical(normalized) !== sha256Canonical(body)) throw new Error(`USAGE_RECORD_MUTATED:${body.usageRecordId ?? 'UNKNOWN'}`);
    if (seen.has(normalized.usageRecordId)) throw new Error(`DUPLICATE_USAGE_RECORD_ID:${normalized.usageRecordId}`);
    seen.add(normalized.usageRecordId);
    replay.push({ ...normalized, previousLedgerSha256 });
  }
  if (ledger.ledgerSha256 !== sealLedger(replay).ledgerSha256) throw new Error('INVALID_USAGE_LEDGER_DIGEST');
  return true;
}

export function usageLedgerSha256(ledger) {
  verifyUsageLedger(ledger);
  return ledger.ledgerSha256;
}

export function serializeUsageLedger(ledger) {
  verifyUsageLedger(ledger);
  return `${JSON.stringify(ledgerBody(ledger.records.map((record) => ({ ...record }))), null, 2)}\n`;
}

export function parseUsageLedger(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('INVALID_USAGE_LEDGER_JSON');
  }
  if (!parsed || !Array.isArray(parsed.records)) throw new Error('INVALID_USAGE_LEDGER_STRUCTURE');
  const ledger = sealLedger(parsed.records.map((record) => ({ ...record })));
  if (ledger.schemaVersion !== parsed.schemaVersion || ledger.ledgerKind !== parsed.ledgerKind || ledger.engine !== parsed.engine) throw new Error('INVALID_USAGE_LEDGER_IDENTITY');
  verifyUsageLedger(ledger);
  return ledger;
}

export function findUsageRecord(ledger, usageRecordId) {
  return ledger.records.find((record) => record.usageRecordId === usageRecordId) || null;
}

/**
 * The ordinal a genuine NEXT attempt at this task must carry. Lifetime count,
 * so a retry after a restart can never reuse the identity of the attempt that
 * was interrupted — which is what keeps replay and retry distinguishable.
 */
export function nextAttemptOrdinal(ledger, workUnitId, taskId) {
  verifyUsageLedger(ledger);
  const unit = canonicalIdentifier(workUnitId, 'WORK_UNIT_ID');
  const task = canonicalIdentifier(taskId, 'TASK_ID');
  return ledger.records.filter((record) => record.workUnitId === unit && record.taskId === task).length + 1;
}

/* -------------------------------------------------------------------------
 * Aggregation. Derived on demand, never stored.
 * ---------------------------------------------------------------------- */

function countBy(records, field) {
  const counts = {};
  for (const record of records) counts[record[field]] = (counts[record[field]] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => compareIdentifiers(a[0], b[0])));
}

export function aggregateUsage(ledger, { workUnitId = null } = {}) {
  verifyUsageLedger(ledger);
  const unit = workUnitId === null ? null : canonicalIdentifier(workUnitId, 'WORK_UNIT_ID');
  const records = unit === null ? [...ledger.records] : ledger.records.filter((record) => record.workUnitId === unit);
  const sum = (field) => records.reduce((total, record) => total + record.bytes[field], 0);
  const measured = records.filter((record) => record.tokens.measurement === TOKEN_COUNT_MEASURED);
  const estimated = records.filter((record) => record.tokens.measurement === TOKEN_COUNT_ESTIMATED);
  const outcomeCount = (outcome) => records.filter((record) => record.outcome === outcome).length;
  const capabilityCount = (capability) => records.filter((record) => record.capability === capability).length;
  return {
    aggregateKind: 'GEE_USAGE_AGGREGATE',
    engine: USAGE_LEDGER_VERSION,
    workUnitId: unit,
    recordCount: records.length,
    // Identity already forbids two records sharing one id, so these agree by
    // construction; reporting both makes a future divergence visible instead of
    // silent.
    uniqueRecordCount: new Set(records.map((record) => record.usageRecordId)).size,
    taskCount: new Set(records.map((record) => record.taskId)).size,
    retryRecordCount: records.filter((record) => record.attempt > 1).length,
    byCapability: countBy(records, 'capability'),
    byOutcome: countBy(records, 'outcome'),
    contextBytes: sum('contextBytes'),
    processedBytes: sum('sourceProcessedBytes'),
    avoidedBytes: sum('sourceAvoidedBytes'),
    evidenceReuseBytes: sum('evidenceReusedBytes'),
    revalidationBytes: sum('evidenceRevalidatedBytes'),
    measuredInputTokens: measured.reduce((total, record) => total + record.tokens.inputTokens, 0),
    measuredOutputTokens: measured.reduce((total, record) => total + record.tokens.outputTokens, 0),
    measuredTokenRecordCount: measured.length,
    estimatedTokenRecordCount: estimated.length,
    unknownTokenRecordCount: records.filter((record) => record.tokens.measurement === TOKEN_COUNT_UNAVAILABLE).length,
    deterministicTaskCount: capabilityCount('LOCAL_DETERMINISTIC'),
    standardReasoningTaskCount: capabilityCount('STANDARD_REASONING'),
    deepReasoningTaskCount: capabilityCount('DEEP_REASONING'),
    ownerDecisionCount: capabilityCount('OWNER_DECISION_REQUIRED'),
    completedCount: outcomeCount(COMPLETED),
    failedCount: outcomeCount(FAILED),
    blockedCount: outcomeCount(BLOCKED),
    deferredCount: outcomeCount(DEFERRED),
    ownerDecisionOutcomeCount: outcomeCount(OWNER_DECISION_REQUIRED),
    avoidedByReuseCount: outcomeCount(AVOIDED_BY_REUSE),
    ledgerSha256: ledger.ledgerSha256
  };
}

export { identityBody, BYTE_FIELDS };
