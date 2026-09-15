/**
 * GATE25 reports: D2 GATE25_ANALOGUE_COMPARISON_REPORT_V1 and
 * D3 GATE25_ANALOGUE_SUPPORT_REPORT_V1.
 *
 * Both reports are closed and deterministic. Support is a reporting state only:
 *   eligibleCount < 2  -> INSUFFICIENT_SUPPORT / ABSTAIN / INSUFFICIENT_SUPPORT
 *   eligibleCount >= 2 -> SUFFICIENT_SUPPORT / PROCEED / null
 * SUFFICIENT_SUPPORT is never emitted with structuralGatesPass false; that
 * condition fails closed. Sufficiency never truncates, re-ranks or narrows the
 * analogue set. No ESS, confidence score, probability, significance claim or
 * generated prose is ever emitted.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { assertClosedKeys, failClosed, isExactGovernedString, isPlainObject } from './analogue-identity-v1.mjs';
import { CORE_V1_DIMENSIONS_V1, ELIGIBILITY_EXCLUSION_REASONS_V1 } from './analogue-eligibility-v1.mjs';
import { DISTANCE_FEATURE_IDS_V1 } from './analogue-distance-v1.mjs';
import { compareQueryResults } from './analogue-index-v1.mjs';

export const SUPPORT_REPORT_SCHEMA_V1 = 'GATE25_ANALOGUE_SUPPORT_REPORT_V1';
export const COMPARISON_REPORT_SCHEMA_V1 = 'GATE25_ANALOGUE_COMPARISON_REPORT_V1';

export const SUPPORT_STATUS_V1 = Object.freeze({ INSUFFICIENT_SUPPORT: 'INSUFFICIENT_SUPPORT', SUFFICIENT_SUPPORT: 'SUFFICIENT_SUPPORT' });
export const DECISION_V1 = Object.freeze({ ABSTAIN: 'ABSTAIN', PROCEED: 'PROCEED' });
/** D3 rules: the boundary between the two closed rules. */
export const SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1 = 2;

export const SUPPORT_REPORT_FIELDS_V1 = Object.freeze([
  'schema', 'universeCount', 'eligibleCount', 'excludedCount', 'exclusionCountsByReason',
  'structuralGatesPass', 'supportStatus', 'decision', 'abstainReason',
]);
export const COMPARISON_REPORT_FIELDS_V1 = Object.freeze([
  'schema', 'queryIdentityId', 'datasetId', 'selectionPolicyVersionId', 'knowledgeCutoff',
  'eligibleCount', 'supportStatus', 'decision', 'analogues',
]);
export const ANALOGUE_ENTRY_FIELDS_V1 = Object.freeze([
  'rank', 'analogueIdentityId', 'sessionDate', 'finalDistance', 'distanceComponents', 'commonFactors', 'differences',
]);
export const DIFFERENCES_ENTRY_FIELDS_V1 = Object.freeze([
  'featureId', 'queryRawValue', 'candidateRawValue', 'min', 'max',
  'queryNormalizedValue', 'candidateNormalizedValue', 'absoluteNormalizedDelta',
]);
export const DISTANCE_COMPONENT_FIELDS_V1 = Object.freeze(['featureId', 'componentDistance', 'zeroRange']);

/** D3 forbidden outputs, plus D2 aiGeneratedProse FORBIDDEN. */
export const FORBIDDEN_REPORT_FIELDS_V1 = Object.freeze([
  'ess', 'ESS', 'effectiveSampleSize', 'confidence', 'confidenceScore', 'confidencePercentage',
  'probability', 'probabilities', 'score', 'pValue', 'statisticalSignificance', 'significance',
  'prose', 'narrative', 'explanation', 'summaryText', 'commentary',
]);
const FORBIDDEN = new Set(FORBIDDEN_REPORT_FIELDS_V1);

export function assertNoForbiddenReportField(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 32) return true;
  if (Array.isArray(node)) return node.every((item) => assertNoForbiddenReportField(item, depth + 1));
  for (const key of Object.keys(node)) {
    if (FORBIDDEN.has(key)) failClosed('REPORT_FORBIDDEN_FIELD', { key });
    assertNoForbiddenReportField(node[key], depth + 1);
  }
  return true;
}

const nonNegativeInteger = (value, code) => {
  if (!Number.isInteger(value) || value < 0) failClosed(code, { value });
  return value;
};

/* ------------------------------------------------------------------------ support */

export function resolveSupport({ eligibleCount, structuralGatesPass }) {
  nonNegativeInteger(eligibleCount, 'SUPPORT_ELIGIBLE_COUNT_INVALID');
  if (typeof structuralGatesPass !== 'boolean') failClosed('SUPPORT_STRUCTURAL_GATES_REQUIRED');
  if (eligibleCount < SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1) {
    return Object.freeze({
      supportStatus: SUPPORT_STATUS_V1.INSUFFICIENT_SUPPORT,
      decision: DECISION_V1.ABSTAIN,
      abstainReason: SUPPORT_STATUS_V1.INSUFFICIENT_SUPPORT,
    });
  }
  if (structuralGatesPass !== true) failClosed('SUFFICIENT_SUPPORT_WITH_STRUCTURAL_GATES_FAILED_REFUSED', { eligibleCount });
  return Object.freeze({ supportStatus: SUPPORT_STATUS_V1.SUFFICIENT_SUPPORT, decision: DECISION_V1.PROCEED, abstainReason: null });
}

function assertExclusionCounts(exclusionCountsByReason, excludedCount) {
  if (!Array.isArray(exclusionCountsByReason) || exclusionCountsByReason.length !== ELIGIBILITY_EXCLUSION_REASONS_V1.length) {
    failClosed('EXCLUSION_COUNTS_VOCABULARY_INVALID');
  }
  let total = 0;
  exclusionCountsByReason.forEach((entry, index) => {
    assertClosedKeys(entry, ['reasonId', 'count'], 'EXCLUSION_COUNT_ENTRY_NOT_CLOSED', { index });
    if (entry.reasonId !== ELIGIBILITY_EXCLUSION_REASONS_V1[index]) failClosed('EXCLUSION_COUNTS_ORDER_INVALID', { index });
    nonNegativeInteger(entry.count, 'EXCLUSION_COUNT_INVALID');
    if (entry.count > excludedCount) failClosed('EXCLUSION_COUNT_EXCEEDS_EXCLUDED', { reasonId: entry.reasonId });
    total += entry.count;
  });
  /* Every excluded candidate carries at least one reason; no reason exists without an exclusion. */
  if ((excludedCount === 0) !== (total === 0) || total < excludedCount) failClosed('EXCLUSION_COUNTS_ARITHMETIC_INCONSISTENT');
}

export function buildSupportReport({ universeCount, eligibleCount, excludedCount, exclusionCountsByReason, structuralGatesPass }) {
  nonNegativeInteger(universeCount, 'SUPPORT_UNIVERSE_COUNT_INVALID');
  nonNegativeInteger(eligibleCount, 'SUPPORT_ELIGIBLE_COUNT_INVALID');
  nonNegativeInteger(excludedCount, 'SUPPORT_EXCLUDED_COUNT_INVALID');
  if (universeCount !== eligibleCount + excludedCount) failClosed('SUPPORT_UNIVERSE_ARITHMETIC_INCONSISTENT');
  assertExclusionCounts(exclusionCountsByReason, excludedCount);
  const support = resolveSupport({ eligibleCount, structuralGatesPass });
  const report = {
    schema: SUPPORT_REPORT_SCHEMA_V1,
    universeCount,
    eligibleCount,
    excludedCount,
    exclusionCountsByReason: exclusionCountsByReason.map((entry) => ({ reasonId: entry.reasonId, count: entry.count })),
    structuralGatesPass,
    supportStatus: support.supportStatus,
    decision: support.decision,
    abstainReason: support.abstainReason,
  };
  assertNoForbiddenReportField(report);
  return Object.freeze({ report: deepFreeze(report), supportReportId: sha256Canonical(report) });
}

/* --------------------------------------------------------------------- comparison */

function verifyAnalogueEntry(entry, index) {
  assertClosedKeys(entry, ANALOGUE_ENTRY_FIELDS_V1, 'ANALOGUE_ENTRY_NOT_CLOSED', { index });
  if (entry.rank !== index + 1) failClosed('ANALOGUE_RANK_NOT_CONTIGUOUS', { index });
  if (!isExactGovernedString(entry.analogueIdentityId) || !isExactGovernedString(entry.sessionDate)) failClosed('ANALOGUE_ENTRY_KEY_INVALID', { index });
  if (typeof entry.finalDistance !== 'number' || !Number.isFinite(entry.finalDistance)) failClosed('ANALOGUE_FINAL_DISTANCE_INVALID', { index });
  if (!Array.isArray(entry.commonFactors) || entry.commonFactors.length !== CORE_V1_DIMENSIONS_V1.length) failClosed('COMMON_FACTORS_INVALID', { index });
  entry.commonFactors.forEach((factor, position) => {
    assertClosedKeys(factor, ['dimensionId', 'value'], 'COMMON_FACTOR_NOT_CLOSED', { index, position });
    if (factor.dimensionId !== CORE_V1_DIMENSIONS_V1[position]) failClosed('COMMON_FACTORS_ORDER_INVALID', { index, position });
  });
  for (const [field, fields] of [['distanceComponents', DISTANCE_COMPONENT_FIELDS_V1], ['differences', DIFFERENCES_ENTRY_FIELDS_V1]]) {
    if (!Array.isArray(entry[field]) || entry[field].length !== DISTANCE_FEATURE_IDS_V1.length) failClosed('DISTANCE_EVIDENCE_CARDINALITY_INVALID', { index, field });
    entry[field].forEach((item, position) => {
      assertClosedKeys(item, fields, 'DISTANCE_EVIDENCE_NOT_CLOSED', { index, field, position });
      if (item.featureId !== DISTANCE_FEATURE_IDS_V1[position]) failClosed('DISTANCE_EVIDENCE_ORDER_INVALID', { index, field, position });
    });
  }
}

/**
 * The complete ranked eligible set; rank order must agree with the D4 query-result
 * ordering and the analogue count must equal eligibleCount exactly.
 */
export function buildComparisonReport({ queryIdentityId, datasetId, selectionPolicyVersionId, knowledgeCutoff, supportReport, rankedAnalogues }) {
  for (const [field, value] of Object.entries({ queryIdentityId, datasetId, selectionPolicyVersionId, knowledgeCutoff })) {
    if (!isExactGovernedString(value)) failClosed('COMPARISON_REPORT_FIELD_REQUIRED', { field });
  }
  if (!isPlainObject(supportReport) || supportReport.schema !== SUPPORT_REPORT_SCHEMA_V1) failClosed('SUPPORT_REPORT_REQUIRED');
  if (!Array.isArray(rankedAnalogues) || rankedAnalogues.length !== supportReport.eligibleCount) {
    failClosed('ANALOGUE_SET_TRUNCATED_OR_EXPANDED', { eligibleCount: supportReport.eligibleCount, analogueCount: rankedAnalogues?.length ?? null });
  }
  const analogues = rankedAnalogues.map((entry) => ({
    rank: entry.rank,
    analogueIdentityId: entry.analogueIdentityId,
    sessionDate: entry.sessionDate,
    finalDistance: entry.finalDistance,
    distanceComponents: entry.distanceComponents.map((item) => ({ ...item })),
    commonFactors: entry.commonFactors.map((item) => ({ ...item })),
    differences: entry.differences.map((item) => ({ ...item })),
  }));
  analogues.forEach(verifyAnalogueEntry);
  analogues.forEach((entry, index) => {
    if (index > 0 && compareQueryResults(analogues[index - 1], entry) >= 0) failClosed('ANALOGUE_RANK_ORDER_INVALID', { index });
  });
  const report = {
    schema: COMPARISON_REPORT_SCHEMA_V1,
    queryIdentityId,
    datasetId,
    selectionPolicyVersionId,
    knowledgeCutoff,
    eligibleCount: supportReport.eligibleCount,
    supportStatus: supportReport.supportStatus,
    decision: supportReport.decision,
    analogues,
  };
  assertNoForbiddenReportField(report);
  return Object.freeze({ report: deepFreeze(report), comparisonReportId: sha256Canonical(report) });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function describeReports() {
  return Object.freeze({
    supportReportSchema: SUPPORT_REPORT_SCHEMA_V1,
    supportReportFields: SUPPORT_REPORT_FIELDS_V1,
    comparisonReportSchema: COMPARISON_REPORT_SCHEMA_V1,
    comparisonReportFields: COMPARISON_REPORT_FIELDS_V1,
    analogueEntryFields: ANALOGUE_ENTRY_FIELDS_V1,
    differencesEntryFields: DIFFERENCES_ENTRY_FIELDS_V1,
    forbiddenFields: FORBIDDEN_REPORT_FIELDS_V1,
    aiGeneratedProse: 'FORBIDDEN',
  });
}
