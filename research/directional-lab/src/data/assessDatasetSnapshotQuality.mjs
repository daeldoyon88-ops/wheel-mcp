/**
 * Deterministic quality assessment of one stored snapshot, on the
 * OBSERVED_SERIES_ONLY basis: every fact comes from CAS objects re-read and
 * re-verified here. No official market calendar, holidays or early closes
 * are invented; no scientific admissibility is decided; no wall clock enters
 * the assessment core (the timestamped execution lives in the record).
 */

import { isDeepStrictEqual } from 'node:util';
import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import { CANONICAL_DAILY_BARS_SCHEMA_VERSION } from '../canonical/canonicalDailyBarsV1.mjs';
import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  SHA256_OBJECT_ID_PATTERN,
} from '../contracts/datasetSnapshotV1.mjs';
import { ADJUSTMENT_TYPES } from '../contracts/dailyBarV1.mjs';
import {
  DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
  DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION,
  DATASET_QUALITY_POLICY_SCHEMA_VERSION,
  QUALITY_ASSESSMENT_BASIS_OBSERVED,
  QualityAssessmentError,
  computeQualityChecksSummary,
  normalizeDatasetQualityAssessmentCoreV1,
  normalizeDatasetQualityAssessmentRecordV1,
  normalizeDatasetQualityPolicyV1,
} from '../contracts/datasetQualityAssessmentV1.mjs';
import {
  normalizeTransformImplementationManifest,
  transformImplementationManifestHash,
} from './transformImplementationManifestV2.mjs';
import { transformManifestCoverageProblems } from './transformPipelineProfilesV1.mjs';
import { verifyDatasetMaterializationVerification } from './verifySnapshotMaterialization.mjs';

/** @param {unknown} store @param {string[]} methods */
function assertStore(store, methods) {
  for (const method of methods) {
    if (!store || typeof (/** @type {any} */ (store))[method] !== 'function') {
      throw new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', `store.${method} is required`);
    }
  }
}

/** @param {unknown} error @returns {'MISSING'|'HASH_MISMATCH'|null} */
function classifyReadError(error) {
  const code = /** @type {{code?: string}} */ (error)?.code;
  if (code === 'CAS_OBJECT_CORRUPT' && /** @type {any} */ (error)?.details?.fsCode === 'ENOENT') return 'MISSING';
  if (code === 'CAS_OBJECT_CORRUPT' || code === 'CAS_EXISTING_CONTENT_MISMATCH') return 'HASH_MISMATCH';
  return null;
}

/** Inclusive UTC day span between two YYYY-MM-DD civil dates. */
function calendarSpanDays(firstDate, lastDate) {
  const [fy, fm, fd] = firstDate.split('-').map(Number);
  const [ly, lm, ld] = lastDate.split('-').map(Number);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
}

const DEPENDENCY_UNAVAILABLE = 'DEPENDENCY_UNAVAILABLE';

/**
 * @param {{
 *   store: any,
 *   snapshotCoreId: string,
 *   policy: unknown,
 *   materializationVerificationId?: string|null,
 *   transformManifest?: unknown,
 *   pipelineProfile?: unknown,
 *   requiredRoles?: readonly string[],
 * }} input
 */
export function computeDatasetSnapshotQualityAssessment(input) {
  if (!input || typeof input !== 'object') {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', 'assessment input is required');
  }
  assertStore(input.store, ['readObject', 'readCanonicalObject', 'uriForObject']);
  if (typeof input.snapshotCoreId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(input.snapshotCoreId)) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', 'snapshotCoreId is invalid');
  }
  const policy = normalizeDatasetQualityPolicyV1(input.policy);
  const policyHash = canonicalHash(DATASET_QUALITY_POLICY_SCHEMA_VERSION, policy);

  const coreUri = input.store.uriForObject({ namespace: 'snapshots', objectId: input.snapshotCoreId });
  let snapshotCore;
  try {
    snapshotCore = input.store.readCanonicalObject({
      uri: coreUri, expectedObjectId: input.snapshotCoreId, schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    }).value;
  } catch (error) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISSING',
      'snapshot core cannot be read from the CAS', { snapshotCoreId: input.snapshotCoreId, cause: error });
  }

  let sourceState = { readable: false, reason: 'SOURCE_OBJECT_MISSING', sizeBytes: null };
  try {
    const sourceUri = input.store.uriForObject({ namespace: 'source', objectId: snapshotCore.sourceObjectId });
    const read = input.store.readObject({ uri: sourceUri, expectedObjectId: snapshotCore.sourceObjectId });
    sourceState = { readable: true, reason: null, sizeBytes: read.sizeBytes };
  } catch (error) {
    const kind = classifyReadError(error);
    if (kind === null) throw error;
    sourceState = { readable: false, reason: kind === 'MISSING' ? 'SOURCE_OBJECT_MISSING' : 'SOURCE_OBJECT_HASH_MISMATCH', sizeBytes: null };
  }

  let bars = null;
  let normalizedReason = null;
  try {
    const normalizedUri = input.store.uriForObject({ namespace: 'normalized', objectId: snapshotCore.normalizedObjectId });
    bars = input.store.readCanonicalObject({
      uri: normalizedUri, expectedObjectId: snapshotCore.normalizedObjectId, schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION,
    }).value.bars;
  } catch (error) {
    const kind = classifyReadError(error);
    if (kind === null) throw error;
    normalizedReason = kind === 'MISSING' ? 'NORMALIZED_OBJECT_MISSING' : 'NORMALIZED_OBJECT_HASH_MISMATCH';
  }

  let materializationVerification = null;
  let recoveredTransformManifest = input.transformManifest;
  let recoveredPipelineProfile = input.pipelineProfile;
  const materializationVerificationId = input.materializationVerificationId ?? null;
  if (materializationVerificationId !== null) {
    if (typeof materializationVerificationId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(materializationVerificationId)) {
      throw new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', 'materializationVerificationId is invalid');
    }
    try {
      const recovered = verifyDatasetMaterializationVerification({
        store: input.store,
        verificationId: materializationVerificationId,
      });
      materializationVerification = recovered.verification;
      recoveredTransformManifest = recovered.transformManifest;
      recoveredPipelineProfile = recovered.pipelineProfile;
    } catch (error) {
      throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISSING',
        'materialization verification cannot be read from the CAS', { materializationVerificationId, cause: error });
    }
    if (materializationVerification.snapshotCoreId !== input.snapshotCoreId) {
      throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISMATCH',
        'materialization verification targets another snapshot', {
          materializationVerificationId,
          expectedSnapshotCoreId: input.snapshotCoreId,
          actualSnapshotCoreId: materializationVerification.snapshotCoreId,
        });
    }
  }

  /** @param {string} code @returns {{code: string, status: string, metrics: object, reasons: string[]}} */
  function runCheck(code) {
    switch (code) {
      case 'SNAPSHOT_REFERENCES_VALID': {
        const reasons = [];
        if (!sourceState.readable) reasons.push(sourceState.reason);
        if (bars === null) reasons.push(normalizedReason);
        return {
          code,
          status: reasons.length === 0 ? 'PASS' : 'FAIL',
          metrics: { sourceObjectReadable: sourceState.readable, normalizedObjectReadable: bars !== null },
          reasons,
        };
      }
      case 'SOURCE_OBJECT_VALID':
        return {
          code,
          status: sourceState.readable ? 'PASS' : 'FAIL',
          metrics: { sourceSizeBytes: sourceState.sizeBytes },
          reasons: sourceState.readable ? [] : [sourceState.reason],
        };
      case 'NORMALIZED_OBJECT_VALID':
        return {
          code,
          status: bars !== null ? 'PASS' : 'FAIL',
          metrics: { barCount: bars === null ? null : bars.length },
          reasons: bars !== null ? [] : [normalizedReason],
        };
      case 'SOURCE_TO_NORMALIZED_COHERENCE': {
        if (materializationVerification === null) {
          return { code, status: 'WARN', metrics: { verificationStatus: null }, reasons: ['MATERIALIZATION_NOT_VERIFIED'] };
        }
        return {
          code,
          status: materializationVerification.status === 'PASS' ? 'PASS' : 'FAIL',
          metrics: { verificationStatus: materializationVerification.status },
          reasons: materializationVerification.status === 'PASS' ? [] : [...materializationVerification.reasons],
        };
      }
      case 'BARS_CHRONOLOGICAL': {
        if (bars === null) return { code, status: 'FAIL', metrics: {}, reasons: [DEPENDENCY_UNAVAILABLE] };
        let unsortedPairs = 0;
        for (let index = 1; index < bars.length; index++) {
          if (bars[index - 1].sessionDate >= bars[index].sessionDate) unsortedPairs++;
        }
        return {
          code,
          status: unsortedPairs === 0 ? 'PASS' : 'FAIL',
          metrics: { barCount: bars.length, unsortedPairs },
          reasons: unsortedPairs === 0 ? [] : ['BARS_OUT_OF_ORDER'],
        };
      }
      case 'DUPLICATE_SESSION_DATES': {
        if (bars === null) return { code, status: 'FAIL', metrics: {}, reasons: [DEPENDENCY_UNAVAILABLE] };
        const duplicates = bars.length - new Set(bars.map((bar) => bar.sessionDate)).size;
        return {
          code,
          status: duplicates === 0 ? 'PASS' : 'FAIL',
          metrics: { duplicateSessionDateCount: duplicates },
          reasons: duplicates === 0 ? [] : ['DUPLICATE_SESSION_DATES_PRESENT'],
        };
      }
      case 'OBSERVED_COVERAGE': {
        if (bars === null) return { code, status: 'FAIL', metrics: {}, reasons: [DEPENDENCY_UNAVAILABLE] };
        const observedDates = new Set(bars.map((bar) => bar.sessionDate));
        const firstSessionDate = bars.length > 0 ? bars[0].sessionDate : null;
        const lastSessionDate = bars.length > 0 ? bars[bars.length - 1].sessionDate : null;
        return {
          code,
          status: bars.length > 0 ? 'PASS' : 'WARN',
          metrics: {
            barCount: bars.length,
            firstSessionDate,
            lastSessionDate,
            calendarSpanDays: bars.length > 0 ? calendarSpanDays(firstSessionDate, lastSessionDate) : 0,
            observedSessionDateCount: observedDates.size,
          },
          reasons: bars.length > 0 ? [] : ['EMPTY_OBSERVED_SERIES'],
        };
      }
      case 'NULL_FIELD_COUNTS': {
        if (bars === null) return { code, status: 'FAIL', metrics: {}, reasons: [DEPENDENCY_UNAVAILABLE] };
        const counts = { open: 0, high: 0, low: 0, close: 0, volume: 0, corporateActions: 0 };
        for (const bar of bars) {
          for (const field of ['open', 'high', 'low', 'close', 'volume']) {
            if (bar[field] === null) counts[field]++;
          }
          if (bar.corporateActions.splitFactor === null && bar.corporateActions.cashDividend === null) counts.corporateActions++;
        }
        const nullValuesObserved = counts.open + counts.high + counts.low + counts.close + counts.volume > 0;
        return {
          code,
          status: nullValuesObserved ? 'WARN' : 'PASS',
          metrics: {
            openNullCount: counts.open,
            highNullCount: counts.high,
            lowNullCount: counts.low,
            closeNullCount: counts.close,
            volumeNullCount: counts.volume,
            barsWithoutCorporateActionsCount: counts.corporateActions,
          },
          reasons: nullValuesObserved ? ['NULL_VALUES_OBSERVED'] : [],
        };
      }
      case 'QUALITY_FLAG_COUNTS': {
        if (bars === null) return { code, status: 'FAIL', metrics: {}, reasons: [DEPENDENCY_UNAVAILABLE] };
        /** @type {Record<string, number>} */
        const flagCounts = {};
        for (const bar of bars) {
          for (const flag of bar.qualityFlags) flagCounts[flag] = (flagCounts[flag] ?? 0) + 1;
        }
        return { code, status: 'PASS', metrics: { flagCounts }, reasons: [] };
      }
      case 'LARGE_OBSERVED_MOVES': {
        if (bars === null) return { code, status: 'FAIL', metrics: {}, reasons: [DEPENDENCY_UNAVAILABLE] };
        const thresholdPct = policy.thresholds.largeObservedMoveWarningPct;
        const largeMoveDates = [];
        let comparedPairs = 0;
        let maxAbsObservedMovePct = null;
        for (let index = 1; index < bars.length; index++) {
          const previousClose = bars[index - 1].close;
          const close = bars[index].close;
          if (previousClose === null || close === null) continue;
          comparedPairs++;
          const movePct = Math.abs(close / previousClose - 1) * 100;
          if (maxAbsObservedMovePct === null || movePct > maxAbsObservedMovePct) maxAbsObservedMovePct = movePct;
          if (movePct > thresholdPct) largeMoveDates.push(bars[index].sessionDate);
        }
        return {
          code,
          status: largeMoveDates.length > 0 ? 'WARN' : 'PASS',
          metrics: {
            thresholdPct,
            comparedPairs,
            largeObservedMoveCount: largeMoveDates.length,
            largeObservedMoveDates: largeMoveDates.slice(0, policy.thresholds.maxReportedLargeMoveDates),
            maxAbsObservedMovePct,
          },
          // A large observed move is only a diagnostic; it is never asserted
          // to be a split or any confirmed corporate action.
          reasons: largeMoveDates.length > 0 ? ['LARGE_OBSERVED_MOVE_DIAGNOSTIC'] : [],
        };
      }
      case 'PRICE_BASIS_DECLARED': {
        const declared = ADJUSTMENT_TYPES.includes(snapshotCore.priceBasis);
        const derived = snapshotCore.priceBasis === 'DERIVED_ADJUSTED';
        return {
          code,
          status: !declared ? 'FAIL' : derived ? 'WARN' : 'PASS',
          metrics: { priceBasis: snapshotCore.priceBasis },
          reasons: !declared ? ['PRICE_BASIS_UNDECLARED'] : derived ? ['DERIVED_ADJUSTED_BASIS'] : [],
        };
      }
      case 'TRANSFORM_PIPELINE_COVERAGE': {
        if (recoveredTransformManifest === undefined || recoveredPipelineProfile === undefined) {
          return { code, status: 'WARN', metrics: {}, reasons: ['TRANSFORM_PIPELINE_NOT_EVALUATED'] };
        }
        const manifest = normalizeTransformImplementationManifest(recoveredTransformManifest);
        const manifestHash = transformImplementationManifestHash(manifest);
        const reasons = [];
        if (manifestHash !== snapshotCore.transformImplementationHash) {
          reasons.push('TRANSFORM_IMPLEMENTATION_HASH_MISMATCH');
        }
        const problems = transformManifestCoverageProblems({
          transformManifest: manifest, pipelineProfile: recoveredPipelineProfile, requiredRoles: input.requiredRoles,
        });
        for (const problem of problems) reasons.push(problem.code);
        return {
          code,
          status: reasons.length === 0 ? 'PASS' : 'FAIL',
          metrics: { moduleCount: manifest.modules.length, coverageProblemCount: problems.length },
          reasons,
        };
      }
      default:
        throw new QualityAssessmentError('QUALITY_POLICY_INVALID', `check is not implemented: ${code}`);
    }
  }

  const checks = policy.checkCodes.map(runCheck);
  const qualityCore = normalizeDatasetQualityAssessmentCoreV1({
    schemaVersion: DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
    snapshotCoreId: input.snapshotCoreId,
    qualityPolicyVersion: policy.policyVersion,
    qualityPolicyHash: policyHash,
    assessmentBasis: QUALITY_ASSESSMENT_BASIS_OBSERVED,
    materializationVerificationId,
    checks,
    summary: computeQualityChecksSummary(checks),
  });
  return {
    qualityCore,
    qualityCoreId: canonicalHash(DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION, qualityCore),
    policy,
    policyHash,
    materializationVerification,
    transformManifest: recoveredTransformManifest ?? null,
    pipelineProfile: recoveredPipelineProfile ?? null,
  };
}

/** Persist the policy and quality core only after the read-only computation. */
export function assessDatasetSnapshotQuality(input) {
  const result = computeDatasetSnapshotQualityAssessment(input);
  assertStore(input?.store, ['putCanonicalObject']);
  const policyObject = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: DATASET_QUALITY_POLICY_SCHEMA_VERSION, value: result.policy,
  });
  const qualityCoreObject = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION, value: result.qualityCore,
  });
  return {
    ...result,
    qualityCoreId: qualityCoreObject.objectId,
    qualityCoreObject,
    policyObject,
  };
}

/**
 * Persist one timestamped execution of an assessment core. `assessedAt` and
 * `nodeVersion` are always injected by the caller; nothing is read from the
 * wall clock here.
 * @param {{
 *   store: any,
 *   qualityAssessmentCoreId: string,
 *   assessedAt: string,
 *   assessmentToolVersion: string,
 *   nodeVersion: string,
 *   executionIdentity: object,
 * }} input
 */
export function buildDatasetQualityAssessmentRecord(input) {
  if (!input || typeof input !== 'object') {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', 'record build input is required');
  }
  assertStore(input.store, ['readCanonicalObject', 'putCanonicalObject', 'uriForObject']);
  if (typeof input.qualityAssessmentCoreId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(input.qualityAssessmentCoreId)) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', 'qualityAssessmentCoreId is invalid');
  }
  const coreUri = input.store.uriForObject({ namespace: 'snapshots', objectId: input.qualityAssessmentCoreId });
  try {
    input.store.readCanonicalObject({
      uri: coreUri, expectedObjectId: input.qualityAssessmentCoreId, schemaVersion: DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
    });
  } catch (error) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISSING',
      'quality assessment core cannot be read from the CAS', { qualityAssessmentCoreId: input.qualityAssessmentCoreId, cause: error });
  }
  const record = normalizeDatasetQualityAssessmentRecordV1({
    schemaVersion: DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION,
    qualityAssessmentCoreId: input.qualityAssessmentCoreId,
    assessedAt: input.assessedAt,
    assessmentToolVersion: input.assessmentToolVersion,
    nodeVersion: input.nodeVersion,
    executionIdentity: input.executionIdentity,
  });
  const recordObject = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION, value: record,
  });
  return { record, recordId: recordObject.objectId, recordObject };
}

/**
 * Recover a full assessment (record → core → policy → snapshot core) from the
 * CAS, re-verifying every hash and relation.
 * @param {{store: any, qualityAssessmentRecordId: string}} input
 */
export function verifyDatasetQualityAssessment(input) {
  assertStore(input?.store, ['readObject', 'readCanonicalObject', 'uriForObject']);
  if (typeof input?.qualityAssessmentRecordId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(input.qualityAssessmentRecordId)) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_INVALID', 'qualityAssessmentRecordId is invalid');
  }
  const recordUri = input.store.uriForObject({ namespace: 'snapshots', objectId: input.qualityAssessmentRecordId });
  const record = input.store.readCanonicalObject({
    uri: recordUri, expectedObjectId: input.qualityAssessmentRecordId, schemaVersion: DATASET_QUALITY_ASSESSMENT_RECORD_SCHEMA_VERSION,
  }).value;
  const coreUri = input.store.uriForObject({ namespace: 'snapshots', objectId: record.qualityAssessmentCoreId });
  const qualityCore = input.store.readCanonicalObject({
    uri: coreUri, expectedObjectId: record.qualityAssessmentCoreId, schemaVersion: DATASET_QUALITY_ASSESSMENT_CORE_SCHEMA_VERSION,
  }).value;
  const policyUri = input.store.uriForObject({ namespace: 'snapshots', objectId: qualityCore.qualityPolicyHash });
  const policy = input.store.readCanonicalObject({
    uri: policyUri, expectedObjectId: qualityCore.qualityPolicyHash, schemaVersion: DATASET_QUALITY_POLICY_SCHEMA_VERSION,
  }).value;
  if (policy.policyVersion !== qualityCore.qualityPolicyVersion) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISMATCH',
      'stored policy version does not match the assessment core', { qualityAssessmentRecordId: input.qualityAssessmentRecordId });
  }
  if (policy.assessmentBasis !== qualityCore.assessmentBasis) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISMATCH',
      'stored policy assessment basis does not match the assessment core');
  }
  const expectedPolicyHash = canonicalHash(DATASET_QUALITY_POLICY_SCHEMA_VERSION, policy);
  if (expectedPolicyHash !== qualityCore.qualityPolicyHash) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISMATCH',
      'stored policy hash does not match the assessment core');
  }
  const coreCheckCodes = qualityCore.checks.map((check) => check.code).sort();
  if (!isDeepStrictEqual(coreCheckCodes, [...policy.checkCodes].sort())) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_SEMANTIC_MISMATCH',
      'quality core check codes do not exactly match the policy');
  }
  const snapshotCoreUri = input.store.uriForObject({ namespace: 'snapshots', objectId: qualityCore.snapshotCoreId });
  const snapshotCore = input.store.readCanonicalObject({
    uri: snapshotCoreUri, expectedObjectId: qualityCore.snapshotCoreId, schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  }).value;
  let materializationVerification = null;
  let transformManifest = null;
  let pipelineProfile = null;
  if (qualityCore.materializationVerificationId !== null) {
    const recovered = verifyDatasetMaterializationVerification({
      store: input.store,
      verificationId: qualityCore.materializationVerificationId,
    });
    materializationVerification = recovered.verification;
    transformManifest = recovered.transformManifest;
    pipelineProfile = recovered.pipelineProfile;
    if (materializationVerification.snapshotCoreId !== qualityCore.snapshotCoreId) {
      throw new QualityAssessmentError('QUALITY_ASSESSMENT_REFERENCE_MISMATCH',
        'referenced materialization verification targets another snapshot', {
          qualityAssessmentRecordId: input.qualityAssessmentRecordId,
        });
    }
  }
  const recomputed = computeDatasetSnapshotQualityAssessment({
    store: input.store,
    snapshotCoreId: qualityCore.snapshotCoreId,
    policy,
    materializationVerificationId: qualityCore.materializationVerificationId,
  });
  if (recomputed.qualityCoreId !== record.qualityAssessmentCoreId
    || !isDeepStrictEqual(recomputed.qualityCore, qualityCore)) {
    throw new QualityAssessmentError('QUALITY_ASSESSMENT_SEMANTIC_MISMATCH',
      'stored quality core differs from the deterministic recomputation', {
        qualityAssessmentRecordId: input.qualityAssessmentRecordId,
        storedQualityCoreId: record.qualityAssessmentCoreId,
        recomputedQualityCoreId: recomputed.qualityCoreId,
      });
  }
  return {
    qualityAssessmentRecordId: input.qualityAssessmentRecordId,
    record,
    qualityCore,
    policy,
    snapshotCore,
    materializationVerification,
    transformManifest,
    pipelineProfile,
  };
}
