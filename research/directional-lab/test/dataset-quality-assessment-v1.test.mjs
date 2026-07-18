import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATASET_QUALITY_CHECK_CODES,
  DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
  computeQualityChecksSummary,
  datasetQualityPolicyHash,
  defaultDatasetQualityPolicyV1,
  normalizeDatasetQualityAssessmentCoreV1,
  normalizeDatasetQualityAssessmentRecordV1,
  normalizeDatasetQualityPolicyV1,
  validateDatasetQualityAssessmentCore,
  validateDatasetQualityAssessmentRecord,
} from '../src/contracts/datasetQualityAssessmentV1.mjs';
import {
  assessDatasetSnapshotQuality,
  buildDatasetQualityAssessmentRecord,
  computeDatasetSnapshotQualityAssessment,
  verifyDatasetQualityAssessment,
} from '../src/data/assessDatasetSnapshotQuality.mjs';
import { buildDatasetMaterializationVerification } from '../src/data/verifySnapshotMaterialization.mjs';
import { normalizeDatasetMaterializationVerificationV1 } from '../src/contracts/datasetMaterializationVerificationV1.mjs';
import {
  buildSyntheticSnapshot,
  code,
  OFFICIAL_TEST_PIPELINE_ID,
  syntheticSourceBytes,
  listFiles,
  withStore,
} from './l2aSyntheticPipeline.mjs';

function assess(store, snapshot, overrides = {}) {
  return assessDatasetSnapshotQuality({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    policy: defaultDatasetQualityPolicyV1(),
    transformManifest: snapshot.manifest,
    pipelineProfile: undefined,
    ...overrides,
  });
}

function storeVerification(store, snapshot) {
  return buildDatasetMaterializationVerification({
    store,
    snapshotCore: snapshot.built.core,
    transformManifest: snapshot.manifest,
    pipelineProfileId: OFFICIAL_TEST_PIPELINE_ID,
  });
}

function recordArgs(store, qualityCoreId, overrides = {}) {
  return {
    store,
    qualityAssessmentCoreId: qualityCoreId,
    assessedAt: '2026-07-18T15:00:00Z',
    assessmentToolVersion: 'quality-tool/1',
    nodeVersion: process.version,
    executionIdentity: { runnerId: 'node:test', runId: null, environment: 'LOCAL_TEST' },
    ...overrides,
  };
}

test('QA1 — healthy snapshot with PASS materialization: every check PASS, summary PASS', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const verification = storeVerification(store, snapshot);
  const result = assess(store, snapshot, { materializationVerificationId: verification.verificationId });
  assert.deepEqual(result.qualityCore.checks.map((check) => check.code), [...DATASET_QUALITY_CHECK_CODES]);
  assert.ok(result.qualityCore.checks.every((check) => check.status === 'PASS'));
  assert.deepEqual(result.qualityCore.summary, { status: 'PASS', passCount: 12, warnCount: 0, failCount: 0, checkCount: 12 });
  assert.equal(result.qualityCore.assessmentBasis, 'OBSERVED_SERIES_ONLY');
}));

test('QA2 — nullable volume is a WARN diagnostic with separate null counts', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store, {
    rows: [['2026-04-01', 30, 32, 29, 31, null], ['2026-04-02', 31, 33, 30, 32, 1100]],
  });
  const result = assess(store, snapshot);
  const nullCheck = result.qualityCore.checks.find((check) => check.code === 'NULL_FIELD_COUNTS');
  assert.equal(nullCheck.status, 'WARN');
  assert.deepEqual(nullCheck.reasons, ['NULL_VALUES_OBSERVED']);
  assert.equal(nullCheck.metrics.volumeNullCount, 1);
  assert.equal(nullCheck.metrics.closeNullCount, 0);
  assert.equal(nullCheck.metrics.barsWithoutCorporateActionsCount, 2);
  assert.equal(result.qualityCore.summary.status, 'WARN');
}));

test('QA3 — a large observed move is a WARN diagnostic, never a split assertion', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store, {
    rows: [['2026-04-01', 10, 11, 9, 10, 1000], ['2026-04-02', 29, 31, 28, 30, 1000]],
  });
  const result = assess(store, snapshot);
  const moves = result.qualityCore.checks.find((check) => check.code === 'LARGE_OBSERVED_MOVES');
  assert.equal(moves.status, 'WARN');
  assert.deepEqual(moves.reasons, ['LARGE_OBSERVED_MOVE_DIAGNOSTIC']);
  assert.equal(moves.metrics.largeObservedMoveCount, 1);
  assert.deepEqual(moves.metrics.largeObservedMoveDates, ['2026-04-02']);
  assert.equal(moves.metrics.thresholdPct, 50);
  const serialized = JSON.stringify(moves);
  assert.ok(!serialized.includes('SPLIT'), 'a move diagnostic must not claim a split');
  assert.equal(result.qualityCore.summary.status, 'WARN');
}));

test('QA4 — an incoherent materialization is a blocking FAIL', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store, {
    sourceBytes: syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1001]]),
    storedFromBytes: syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1000]]),
  });
  const verification = storeVerification(store, snapshot);
  assert.equal(verification.verification.status, 'FAIL');
  const result = assess(store, snapshot, { materializationVerificationId: verification.verificationId });
  const coherence = result.qualityCore.checks.find((check) => check.code === 'SOURCE_TO_NORMALIZED_COHERENCE');
  assert.equal(coherence.status, 'FAIL');
  assert.deepEqual(coherence.reasons, ['NORMALIZED_OBJECT_MISMATCH']);
  assert.equal(result.qualityCore.summary.status, 'FAIL');
}));

test('QA5 — corrupted normalized reference fails and dependent checks degrade deterministically', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const normalizedPath = join(store.root, ...snapshot.built.normalizedObject.uri.split('/'));
  writeFileSync(normalizedPath, '{"corrupt":true}\n');
  const result = assess(store, snapshot);
  const byCode = new Map(result.qualityCore.checks.map((check) => [check.code, check]));
  assert.equal(byCode.get('NORMALIZED_OBJECT_VALID').status, 'FAIL');
  assert.deepEqual(byCode.get('NORMALIZED_OBJECT_VALID').reasons, ['NORMALIZED_OBJECT_HASH_MISMATCH']);
  assert.equal(byCode.get('SNAPSHOT_REFERENCES_VALID').status, 'FAIL');
  assert.equal(byCode.get('BARS_CHRONOLOGICAL').status, 'FAIL');
  assert.deepEqual(byCode.get('BARS_CHRONOLOGICAL').reasons, ['DEPENDENCY_UNAVAILABLE']);
  assert.equal(result.qualityCore.summary.status, 'FAIL');

  const again = assess(store, snapshot);
  assert.deepEqual(again.qualityCore, result.qualityCore);
}));

test('QA6 — same facts give the same core ID; assessedAt only changes the record ID', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const first = assess(store, snapshot);
  const second = assess(store, snapshot);
  assert.equal(first.qualityCoreId, second.qualityCoreId);
  const recordA = buildDatasetQualityAssessmentRecord(recordArgs(store, first.qualityCoreId, { assessedAt: '2026-07-18T15:00:00Z' }));
  const recordB = buildDatasetQualityAssessmentRecord(recordArgs(store, first.qualityCoreId, { assessedAt: '2026-07-18T16:30:00Z' }));
  assert.equal(recordA.record.qualityAssessmentCoreId, recordB.record.qualityAssessmentCoreId);
  assert.notEqual(recordA.recordId, recordB.recordId);
}));

test('QA7 — no wall clock, physical path or human note can enter the deterministic core', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const result = assess(store, snapshot);
  const serialized = JSON.stringify(result.qualityCore);
  assert.ok(!serialized.includes('assessedAt'));
  assert.ok(!/[A-Za-z]:\\/.test(serialized), 'no windows drive path in the core');
  assert.ok(!serialized.toLowerCase().includes('"note'));
  assert.throws(() => normalizeDatasetQualityAssessmentCoreV1({ ...result.qualityCore, assessedAt: '2026-07-18T15:00:00Z' }),
    code('CANONICAL_UNKNOWN_FIELD'));
  assert.throws(() => buildDatasetQualityAssessmentRecord({
    ...recordArgs(store, result.qualityCoreId), assessedAt: undefined,
  }), code('QUALITY_ASSESSMENT_INVALID'));
}));

test('QA8 — summary must match the checks; no score out of 100; no admissibleFor', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const result = assess(store, snapshot);
  assert.throws(() => normalizeDatasetQualityAssessmentCoreV1({
    ...result.qualityCore,
    summary: { ...result.qualityCore.summary, passCount: result.qualityCore.summary.passCount - 1, warnCount: 1 },
  }), code('QUALITY_ASSESSMENT_SUMMARY_MISMATCH'));
  assert.throws(() => normalizeDatasetQualityAssessmentCoreV1({ ...result.qualityCore, score: 62 }), code('CANONICAL_UNKNOWN_FIELD'));
  assert.throws(() => normalizeDatasetQualityAssessmentCoreV1({ ...result.qualityCore, admissibleFor: ['DEV'] }), code('CANONICAL_UNKNOWN_FIELD'));
  const serialized = JSON.stringify(result.qualityCore);
  assert.ok(!serialized.includes('score'));
  assert.ok(!serialized.includes('admissibleFor'));
  assert.deepEqual(Object.keys(result.qualityCore.summary).sort(), ['checkCount', 'failCount', 'passCount', 'status', 'warnCount']);
}));

test('QA9 — the quality policy is versioned, hashed and strictly validated', () => {
  const policy = defaultDatasetQualityPolicyV1();
  assert.equal(policy.policyVersion, 'dataset-quality-policy/1');
  assert.equal(datasetQualityPolicyHash(policy), datasetQualityPolicyHash(defaultDatasetQualityPolicyV1()));
  const stricter = { ...policy, thresholds: { ...policy.thresholds, largeObservedMoveWarningPct: 25 } };
  assert.notEqual(datasetQualityPolicyHash(stricter), datasetQualityPolicyHash(policy));
  assert.throws(() => normalizeDatasetQualityPolicyV1({
    ...policy, thresholds: { ...policy.thresholds, largeObservedMoveWarningPct: -5 },
  }), code('QUALITY_POLICY_INVALID'));
  assert.throws(() => normalizeDatasetQualityPolicyV1({
    ...policy, checkCodes: [...policy.checkCodes, 'OFFICIAL_CALENDAR_GAPS'],
  }), code('QUALITY_POLICY_INVALID'));
  assert.throws(() => normalizeDatasetQualityPolicyV1({ ...policy, admissibleFor: ['DEV'] }), code('CANONICAL_UNKNOWN_FIELD'));
});

test('QA10 — observed coverage reports only observed facts, no invented official calendar', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store, {
    rows: [['2026-04-01', 30, 32, 29, 31, 1000], ['2026-04-08', 31, 33, 30, 32, 1100]],
  });
  const result = assess(store, snapshot);
  const coverage = result.qualityCore.checks.find((check) => check.code === 'OBSERVED_COVERAGE');
  assert.equal(coverage.status, 'PASS');
  assert.deepEqual(coverage.metrics, {
    barCount: 2,
    firstSessionDate: '2026-04-01',
    lastSessionDate: '2026-04-08',
    calendarSpanDays: 8,
    observedSessionDateCount: 2,
  });
  const serialized = JSON.stringify(result.qualityCore);
  for (const invented of ['expectedSessions', 'officialSessions', 'holiday', 'earlyClose', 'missingSessions']) {
    assert.ok(!serialized.includes(invented), `no invented calendar fact: ${invented}`);
  }
}));

test('QA11 — full round-trip from record ID; cross-snapshot references are refused', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const verification = storeVerification(store, snapshot);
  const result = assess(store, snapshot, { materializationVerificationId: verification.verificationId });
  const record = buildDatasetQualityAssessmentRecord(recordArgs(store, result.qualityCoreId));
  const recovered = verifyDatasetQualityAssessment({ store, qualityAssessmentRecordId: record.recordId });
  assert.deepEqual(recovered.qualityCore, result.qualityCore);
  assert.deepEqual(recovered.policy, result.policy);
  assert.equal(recovered.snapshotCore.sourceObjectId, snapshot.built.sourceObject.objectId);
  assert.equal(recovered.materializationVerification.status, 'PASS');

  const other = buildSyntheticSnapshot(store, { rows: [['2026-05-01', 10, 11, 9, 10, 500]] });
  assert.throws(() => assess(store, other, { materializationVerificationId: verification.verificationId }),
    code('QUALITY_ASSESSMENT_REFERENCE_MISMATCH'));
}));

test('QA12 — compute is read-only and persistence is separate', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const verification = storeVerification(store, snapshot);
  const before = listFiles(store.root);
  const computed = computeDatasetSnapshotQualityAssessment({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    policy: defaultDatasetQualityPolicyV1(),
    materializationVerificationId: verification.verificationId,
  });
  assert.deepEqual(listFiles(store.root), before);
  const persisted = assessDatasetSnapshotQuality({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    policy: defaultDatasetQualityPolicyV1(),
    materializationVerificationId: verification.verificationId,
  });
  assert.equal(persisted.qualityCoreId, computed.qualityCoreId);
  assert.ok(listFiles(store.root).length > before.length);
}));

test('QA13 — canonical hash-valid quality forgeries are rejected by recomputation', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const verification = storeVerification(store, snapshot);
  const honest = assess(store, snapshot, { materializationVerificationId: verification.verificationId });
  const mutations = [
    (checks) => checks.map((check) => check.code === 'NULL_FIELD_COUNTS'
      ? { ...check, metrics: { ...check.metrics, volumeNullCount: 999 } } : check),
    (checks) => checks.map((check) => check.code === 'PRICE_BASIS_DECLARED'
      ? { ...check, reasons: ['FORGED_REASON'] } : check),
    (checks) => checks.map((check) => check.code === 'OBSERVED_COVERAGE'
      ? { ...check, status: 'WARN', reasons: ['FORGED_WARN'] } : check),
    (checks) => checks.filter((check) => check.code !== 'QUALITY_FLAG_COUNTS'),
  ];
  mutations.forEach((mutate, index) => {
    const checks = mutate(honest.qualityCore.checks);
    const forgedCore = normalizeDatasetQualityAssessmentCoreV1({
      ...honest.qualityCore,
      checks,
      summary: computeQualityChecksSummary(checks),
    });
    const forgedObject = store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
      value: forgedCore,
    });
    const record = buildDatasetQualityAssessmentRecord(recordArgs(store, forgedObject.objectId, {
      assessedAt: `2026-07-18T15:0${index}:00Z`,
    }));
    assert.throws(() => verifyDatasetQualityAssessment({ store, qualityAssessmentRecordId: record.recordId }),
      code('QUALITY_ASSESSMENT_SEMANTIC_MISMATCH'));
  });
}));

test('QA14 — execution identity is closed and physical paths are refused', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const assessment = assess(store, snapshot);
  const valid = buildDatasetQualityAssessmentRecord(recordArgs(store, assessment.qualityCoreId));
  assert.equal(validateDatasetQualityAssessmentRecord(valid.record).valid, true);
  assert.doesNotThrow(() => normalizeDatasetQualityAssessmentRecordV1(valid.record));
  for (const executionIdentity of [
    { runnerId: 'node:test', runId: null, environment: 'LOCAL_TEST', cwd: 'C:\\repo' },
    { runnerId: 'C:\\node.exe', runId: null, environment: 'LOCAL_TEST' },
    { runnerId: 'node:test', runId: '/tmp/run', environment: 'LOCAL_TEST' },
    { runnerId: 'node:test', runId: null, environment: 'UNKNOWN' },
  ]) {
    assert.throws(() => buildDatasetQualityAssessmentRecord(recordArgs(store, assessment.qualityCoreId, { executionIdentity })),
      (error) => error.code === 'CANONICAL_UNKNOWN_FIELD' || error.code === 'QUALITY_ASSESSMENT_INVALID');
  }
}));

test('QA15 — validate true implies normalize succeeds; invalid JSON metrics are refused', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const assessment = assess(store, snapshot);
  assert.equal(validateDatasetQualityAssessmentCore(assessment.qualityCore).valid, true);
  assert.doesNotThrow(() => normalizeDatasetQualityAssessmentCoreV1(assessment.qualityCore));
  const invalidValues = [undefined, NaN, Infinity, -Infinity, 2 ** 53, new Date(), () => {}, Symbol('x'), 1n];
  for (const invalid of invalidValues) {
    const checks = assessment.qualityCore.checks.map((check, index) => index === 0
      ? { ...check, metrics: { invalid } } : check);
    const candidate = { ...assessment.qualityCore, checks, summary: computeQualityChecksSummary(checks) };
    assert.equal(validateDatasetQualityAssessmentCore(candidate).valid, false);
    assert.throws(() => normalizeDatasetQualityAssessmentCoreV1(candidate));
  }
  const symbolKeyMetrics = { valid: true };
  symbolKeyMetrics[Symbol('hidden')] = true;
  const symbolChecks = assessment.qualityCore.checks.map((check, index) => index === 0
    ? { ...check, metrics: symbolKeyMetrics } : check);
  const symbolCandidate = { ...assessment.qualityCore, checks: symbolChecks, summary: computeQualityChecksSummary(symbolChecks) };
  assert.equal(validateDatasetQualityAssessmentCore(symbolCandidate).valid, false);
  assert.throws(() => normalizeDatasetQualityAssessmentCoreV1(symbolCandidate));
}));

test('QA16 — a forged PASS materialization declaration cannot validate quality', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store, {
    sourceBytes: syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1001]]),
    storedFromBytes: syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1000]]),
  });
  const actual = storeVerification(store, snapshot);
  assert.equal(actual.verification.status, 'FAIL');
  const forgedVerification = normalizeDatasetMaterializationVerificationV1({
    ...actual.verification,
    recomputedNormalizedObjectId: actual.verification.expectedNormalizedObjectId,
    status: 'PASS',
    reasons: ['MATERIALIZATION_MATCH'],
  });
  const forgedVerificationObject = store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: 'DatasetMaterializationVerification/1', value: forgedVerification,
  });
  const actualAssessment = assess(store, snapshot, { materializationVerificationId: actual.verificationId });
  const checks = actualAssessment.qualityCore.checks.map((check) => check.code === 'SOURCE_TO_NORMALIZED_COHERENCE'
    ? { ...check, status: 'PASS', metrics: { verificationStatus: 'PASS' }, reasons: [] }
    : check);
  const forgedCore = normalizeDatasetQualityAssessmentCoreV1({
    ...actualAssessment.qualityCore,
    materializationVerificationId: forgedVerificationObject.objectId,
    checks,
    summary: computeQualityChecksSummary(checks),
  });
  const forgedCoreObject = store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION, value: forgedCore,
  });
  const record = buildDatasetQualityAssessmentRecord(recordArgs(store, forgedCoreObject.objectId));
  assert.throws(() => verifyDatasetQualityAssessment({ store, qualityAssessmentRecordId: record.recordId }),
    code('MATERIALIZATION_VERIFICATION_SEMANTIC_MISMATCH'));
}));
