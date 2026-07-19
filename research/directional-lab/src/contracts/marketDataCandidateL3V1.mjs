/** L3-I2 normalized candidates, candidate sets and deterministic validation. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertExactFields,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  assertSortedUniqueStrings,
  assertUtcInstant,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from './marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_KNOWLEDGE_MODES,
  MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION,
  MARKET_DATA_PRICE_BASES,
  MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
  verifyMarketDataIngestionLineage,
  verifyMarketDataSourceTemporalEvidence,
} from './marketDataSourceL3V1.mjs';
import {
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
} from './marketDataBarIdentityL3V1.mjs';
import { verifyMarketCalendarRegistry } from './marketCalendarL3V1.mjs';

export const MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION = 'MarketDataNormalizedCandidate/1';
export const MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION = 'MarketDataCandidateSetCore/1';
export const MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION = 'MarketDataValidationReport/1';
export const MARKET_DATA_CANDIDATE_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
  MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
  MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
]);

export const MARKET_DATA_CANDIDATE_KINDS = Object.freeze([
  'BAR_INITIAL_VALUE',
  'BAR_RESTORATION',
  'BAR_VALUE_REVISION',
  'BAR_WITHDRAWAL',
  'SESSION_DATE_CORRECTION',
]);
export const MARKET_DATA_VALIDATION_DISPOSITIONS = Object.freeze([
  'ACCEPTED', 'CONFLICTING', 'DUPLICATE', 'QUARANTINED', 'REJECTED',
]);
export const MARKET_DATA_I2_ERROR_CODES = Object.freeze([
  'MARKET_DATA_BAR_INITIAL_VALUE_CONFLICT',
  'MARKET_DATA_BAR_REVISION_BRANCH',
  'MARKET_DATA_CANDIDATE_DISCRIMINATION_FAILED',
  'MARKET_DATA_CANDIDATE_DUPLICATE',
  'MARKET_DATA_CANDIDATE_SHAPE_INVALID',
  'MARKET_DATA_CORRECTION_CHAIN_INVALID',
  'MARKET_DATA_CORRECTION_LINEAGE_MISMATCH',
  'MARKET_DATA_CORRECTION_PARENT_MISMATCH',
  'MARKET_DATA_CORRECTION_PARENT_REQUIRED',
  'MARKET_DATA_CORRECTION_STALE_PARENT',
  'MARKET_DATA_FUTURE_INFORMATION',
  'MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID',
  'MARKET_DATA_KNOWLEDGE_BOUNDS_REQUIRED',
  'MARKET_DATA_KNOWLEDGE_MODE_INVALID',
  'MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH',
  'MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION',
  'MARKET_DATA_SESSION_DATE_TARGET_OCCUPIED',
  'MARKET_DATA_VALIDATION_FAILED',
  'MARKET_DATA_VALIDATION_PUBLICATION_ORDER_VIOLATION',
]);

const COMMON_CANDIDATE_FIELDS = Object.freeze([
  'schemaVersion', 'candidateKind', 'ingestionLineageId', 'sourceArtifactId',
  'acquisitionRecordId', 'parseResultId', 'sourceRowIndex', 'sourceRowDigest',
  'knowledgeMode', 'knowledgeTimeLowerBound', 'knowledgeTimeUpperBound',
  'sourceTimestampEvidenceId', 'providerRevisionId', 'calendarRegistryManifestId',
  'marketValidTime',
]);
const VARIANT_FIELDS = Object.freeze({
  BAR_INITIAL_VALUE: ['barIdentityId', 'targetCorrectionId', 'replacementValues'],
  BAR_VALUE_REVISION: ['barIdentityId', 'targetCorrectionId', 'replacementValues'],
  BAR_WITHDRAWAL: ['barIdentityId', 'targetCorrectionId'],
  BAR_RESTORATION: ['barIdentityId', 'targetWithdrawalCorrectionId', 'restoredObservationId'],
  SESSION_DATE_CORRECTION: ['previousBarIdentityId', 'nextBarIdentityId', 'targetCorrectionId', 'replacementValues'],
});
const REPLACEMENT_FIELDS = Object.freeze([
  'openAtoms', 'highAtoms', 'lowAtoms', 'closeAtoms', 'priceScale',
  'volumeAtoms', 'volumeScale', 'currency', 'priceBasis',
]);
const CANDIDATE_SET_FIELDS = Object.freeze([
  'schemaVersion', 'ingestionLineageId', 'sourceArtifactId', 'acquisitionRecordId',
  'parseResultId', 'ingestionPolicyId', 'identityRegistryManifestId',
  'calendarRegistryManifestId', 'corporateActionRegistryManifestId', 'candidateIds',
]);
const VALIDATION_REPORT_FIELDS = Object.freeze([
  'schemaVersion', 'candidateSetId', 'ingestionPolicyId',
  'baseIngestionRegistryManifestId', 'expectedParentIngestionManifestId',
  'decisions', 'fatalErrors', 'warnings',
]);
const DECISION_FIELDS = Object.freeze(['candidateId', 'disposition', 'reasonCodes']);
const BASE_VIEW_FIELDS = Object.freeze([
  'baseIngestionRegistryManifestId', 'expectedParentIngestionManifestId',
  'terminalCorrectionIds', 'visibleCorrectionIds', 'occupiedBarIdentityIds',
  'publishedBarIdentityIds', 'duplicateCandidateIds',
]);

function candidateShapeError(message, cause = undefined) {
  return new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', message, cause ? { cause } : {});
}

/** @param {unknown} value @param {string} label */
function assertAtoms(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw candidateShapeError(`${label} must be a non-negative decimal atom string`);
  }
}

/** @param {unknown} value */
export function normalizeMarketDataReplacementValuesV1(value) {
  try {
    const values = assertPlainObject(value, 'replacementValues');
    assertExactFields(values, REPLACEMENT_FIELDS);
    for (const field of ['openAtoms', 'highAtoms', 'lowAtoms', 'closeAtoms']) assertAtoms(values[field], field);
    if (BigInt(values.openAtoms) <= 0n || BigInt(values.highAtoms) <= 0n
        || BigInt(values.lowAtoms) <= 0n || BigInt(values.closeAtoms) <= 0n) {
      throw candidateShapeError('OHLC price atoms must be strictly positive');
    }
    const open = BigInt(values.openAtoms);
    const high = BigInt(values.highAtoms);
    const low = BigInt(values.lowAtoms);
    const close = BigInt(values.closeAtoms);
    if (high < open || high < close || high < low || low > open || low > close) {
      throw candidateShapeError('replacementValues OHLC ordering is incoherent');
    }
    if (!Number.isInteger(values.priceScale) || values.priceScale < 0 || values.priceScale > 18) {
      throw candidateShapeError('priceScale must be an integer from 0 through 18');
    }
    if ((values.volumeAtoms === null) !== (values.volumeScale === null)) {
      throw candidateShapeError('volumeAtoms and volumeScale must both be null or both be present');
    }
    if (values.volumeAtoms !== null) {
      assertAtoms(values.volumeAtoms, 'volumeAtoms');
      if (!Number.isInteger(values.volumeScale) || values.volumeScale < 0 || values.volumeScale > 18) {
        throw candidateShapeError('volumeScale must be an integer from 0 through 18');
      }
    }
    if (typeof values.currency !== 'string' || !/^[A-Z]{3}$/.test(values.currency)) {
      throw candidateShapeError('currency must be an ISO 4217 uppercase code');
    }
    assertEnum(values.priceBasis, MARKET_DATA_PRICE_BASES, 'priceBasis', 'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
    return { ...values };
  } catch (cause) {
    if (cause instanceof MarketDataL3Error
        && ['MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED'].includes(cause.code)) throw cause;
    throw candidateShapeError('replacementValues is invalid', cause);
  }
}

function validateCandidateCommon(candidate) {
  for (const field of ['ingestionLineageId', 'sourceArtifactId', 'acquisitionRecordId', 'parseResultId',
    'sourceRowDigest', 'calendarRegistryManifestId']) assertCasId(candidate[field], field);
  assertSafeInteger(candidate.sourceRowIndex, 'sourceRowIndex', { nonNegative: true });
  assertEnum(candidate.knowledgeMode, MARKET_DATA_KNOWLEDGE_MODES, 'knowledgeMode', 'MARKET_DATA_KNOWLEDGE_MODE_INVALID');
  if (candidate.knowledgeTimeLowerBound !== null) assertUtcInstant(candidate.knowledgeTimeLowerBound, 'knowledgeTimeLowerBound');
  assertUtcInstant(candidate.knowledgeTimeUpperBound, 'knowledgeTimeUpperBound');
  assertCasId(candidate.sourceTimestampEvidenceId, 'sourceTimestampEvidenceId', true);
  if (candidate.providerRevisionId !== null
      && (typeof candidate.providerRevisionId !== 'string' || candidate.providerRevisionId.length === 0)) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'providerRevisionId must be null or non-empty text');
  }
  assertUtcInstant(candidate.marketValidTime, 'marketValidTime');
}

/** @param {unknown} value */
export function normalizeMarketDataNormalizedCandidateV1(value) {
  const candidate = assertPlainObject(value, MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION);
  assertSchemaVersion(candidate, MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION);
  if (!MARKET_DATA_CANDIDATE_KINDS.includes(candidate.candidateKind)) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_DISCRIMINATION_FAILED', 'candidateKind is missing or invalid');
  }
  const requiredParentField = candidate.candidateKind === 'BAR_RESTORATION'
    ? 'targetWithdrawalCorrectionId'
    : ['BAR_VALUE_REVISION', 'BAR_WITHDRAWAL', 'SESSION_DATE_CORRECTION'].includes(candidate.candidateKind)
      ? 'targetCorrectionId' : null;
  if (requiredParentField !== null
      && (!Object.hasOwn(candidate, requiredParentField) || candidate[requiredParentField] === null)) {
    throw new MarketDataL3Error('MARKET_DATA_CORRECTION_PARENT_REQUIRED', `${requiredParentField} is required`);
  }
  try {
    assertExactFields(candidate, [...COMMON_CANDIDATE_FIELDS, ...VARIANT_FIELDS[candidate.candidateKind]]);
    validateCandidateCommon(candidate);
    if (candidate.candidateKind === 'SESSION_DATE_CORRECTION') {
      assertCasId(candidate.previousBarIdentityId, 'previousBarIdentityId');
      assertCasId(candidate.nextBarIdentityId, 'nextBarIdentityId');
      if (candidate.previousBarIdentityId === candidate.nextBarIdentityId) {
        throw candidateShapeError('session-date correction identities must differ');
      }
      assertCasId(candidate.targetCorrectionId, 'targetCorrectionId');
      return { ...candidate, replacementValues: normalizeMarketDataReplacementValuesV1(candidate.replacementValues) };
    }
    assertCasId(candidate.barIdentityId, 'barIdentityId');
    if (candidate.candidateKind === 'BAR_INITIAL_VALUE') {
      if (candidate.targetCorrectionId !== null) throw candidateShapeError('BAR_INITIAL_VALUE requires targetCorrectionId = null');
      return { ...candidate, replacementValues: normalizeMarketDataReplacementValuesV1(candidate.replacementValues) };
    }
    if (candidate.candidateKind === 'BAR_VALUE_REVISION') {
      assertCasId(candidate.targetCorrectionId, 'targetCorrectionId');
      return { ...candidate, replacementValues: normalizeMarketDataReplacementValuesV1(candidate.replacementValues) };
    }
    if (candidate.candidateKind === 'BAR_WITHDRAWAL') {
      assertCasId(candidate.targetCorrectionId, 'targetCorrectionId');
      return { ...candidate };
    }
    assertCasId(candidate.targetWithdrawalCorrectionId, 'targetWithdrawalCorrectionId');
    assertCasId(candidate.restoredObservationId, 'restoredObservationId');
    return { ...candidate };
  } catch (cause) {
    if (cause instanceof MarketDataL3Error
        && ['MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'MARKET_DATA_KNOWLEDGE_BOUNDS_REQUIRED',
          'MARKET_DATA_KNOWLEDGE_MODE_INVALID', 'MARKET_DATA_CANDIDATE_SHAPE_INVALID'].includes(cause.code)) throw cause;
    throw candidateShapeError('candidate variant shape is invalid', cause);
  }
}

/** @param {unknown} value */
export function normalizeMarketDataCandidateSetCoreV1(value) {
  const set = assertPlainObject(value, MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION);
  assertSchemaVersion(set, MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION);
  assertExactFields(set, CANDIDATE_SET_FIELDS);
  for (const field of CANDIDATE_SET_FIELDS.filter((field) => field.endsWith('Id'))) assertCasId(set[field], field);
  assertSortedUniqueStrings(set.candidateIds, 'candidateIds', { nonEmpty: true });
  for (let i = 0; i < set.candidateIds.length; i += 1) assertCasId(set.candidateIds[i], `candidateIds[${i}]`);
  return { ...set, candidateIds: [...set.candidateIds] };
}

function normalizeDiagnosticCodes(value, label) {
  assertSortedUniqueStrings(value, label);
  for (const code of value) assertEnum(code, MARKET_DATA_I2_ERROR_CODES, label, 'MARKET_DATA_VALIDATION_FAILED');
  return [...value];
}

/** @param {unknown} value */
export function normalizeMarketDataValidationReportV1(value) {
  const report = assertPlainObject(value, MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION);
  assertSchemaVersion(report, MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION);
  assertExactFields(report, VALIDATION_REPORT_FIELDS);
  assertCasId(report.candidateSetId, 'candidateSetId');
  assertCasId(report.ingestionPolicyId, 'ingestionPolicyId');
  assertCasId(report.baseIngestionRegistryManifestId, 'baseIngestionRegistryManifestId');
  assertCasId(report.expectedParentIngestionManifestId, 'expectedParentIngestionManifestId', true);
  if (!Array.isArray(report.decisions)) throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'decisions must be an array');
  const decisions = report.decisions.map((raw, index) => {
    const decision = assertPlainObject(raw, `decisions[${index}]`);
    assertExactFields(decision, DECISION_FIELDS);
    assertCasId(decision.candidateId, `decisions[${index}].candidateId`);
    assertEnum(decision.disposition, MARKET_DATA_VALIDATION_DISPOSITIONS, 'disposition', 'MARKET_DATA_VALIDATION_FAILED');
    const reasonCodes = normalizeDiagnosticCodes(decision.reasonCodes, `decisions[${index}].reasonCodes`);
    if ((decision.disposition === 'ACCEPTED') !== (reasonCodes.length === 0)) {
      throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'only ACCEPTED decisions have no reason code');
    }
    return { candidateId: decision.candidateId, disposition: decision.disposition, reasonCodes };
  });
  for (let i = 1; i < decisions.length; i += 1) {
    if (decisions[i - 1].candidateId >= decisions[i].candidateId) {
      throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'decisions must be sorted and unique by candidateId');
    }
  }
  const fatalErrors = normalizeDiagnosticCodes(report.fatalErrors, 'fatalErrors');
  const warnings = normalizeDiagnosticCodes(report.warnings, 'warnings');
  assertFatalErrorsExcludeAccepted(decisions, fatalErrors);
  return {
    ...report,
    decisions,
    fatalErrors,
    warnings,
  };
}

/** Fatal diagnostics and ACCEPTED dispositions are mutually exclusive. */
function assertFatalErrorsExcludeAccepted(decisions, fatalErrors) {
  if (fatalErrors.length > 0
      && decisions.some((decision) => decision.disposition === 'ACCEPTED')) {
    throw new MarketDataL3Error(
      'MARKET_DATA_VALIDATION_FAILED',
      'fatalErrors prohibit ACCEPTED decisions',
    );
  }
}

function findCalendarSession(calendarRegistry, sessionDate) {
  const matches = calendarRegistry.calendars.flatMap((calendar) => calendar.sessions)
    .filter((session) => session.sessionDate === sessionDate);
  if (matches.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'bar session is absent from the pinned calendar', { sessionDate });
  }
  const first = matches[0];
  if (matches.some((session) => !canonicalValuesEqual(session, first))) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'pinned calendars disagree on the bar session', { sessionDate });
  }
  return first;
}

function verifyKnowledge(store, candidate, acquisition, policy) {
  if (!policy.knowledgeModes.includes(candidate.knowledgeMode)) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_MODE_INVALID', 'candidate knowledgeMode is not authorized by policy');
  }
  if (candidate.knowledgeMode === 'CAPTURE_TIME_ONLY') {
    if (candidate.knowledgeTimeLowerBound !== null
        || candidate.knowledgeTimeUpperBound !== acquisition.acquisitionTimeUtc
        || candidate.sourceTimestampEvidenceId !== null || candidate.providerRevisionId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'capture-only knowledge must use the acquisition upper bound and no provider evidence');
    }
  } else {
    if (candidate.knowledgeTimeLowerBound === null || candidate.sourceTimestampEvidenceId === null) {
      throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_REQUIRED', 'attested knowledge requires equal bounds and evidence');
    }
    const evidence = verifyMarketDataSourceTemporalEvidence({
      store, sourceTemporalEvidenceId: candidate.sourceTimestampEvidenceId,
    }).sourceTemporalEvidence;
    if (evidence.sourceArtifactId !== candidate.sourceArtifactId
        || evidence.acquisitionRecordId !== candidate.acquisitionRecordId
        || evidence.parseResultId !== candidate.parseResultId
        || evidence.sourceRowIndex !== candidate.sourceRowIndex) {
      throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'temporal evidence belongs to another source row');
    }
    if (candidate.knowledgeTimeLowerBound !== evidence.normalizedTimestampUtc
        || candidate.knowledgeTimeUpperBound !== evidence.normalizedTimestampUtc) {
      throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'attested bounds must equal the evidence timestamp');
    }
    if (candidate.knowledgeMode === 'PROVIDER_REVISION_HISTORY_ATTESTED') {
      if (evidence.evidenceKind !== 'PROVIDER_REVISION_TIMESTAMP'
          || candidate.providerRevisionId !== evidence.providerRevisionId) {
        throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'revision-history knowledge requires matching revision evidence');
      }
    } else if (evidence.evidenceKind !== 'PROVIDER_PUBLICATION_TIMESTAMP'
        || candidate.providerRevisionId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'publication-time knowledge cannot carry a provider revision');
    }
  }
  if (candidate.knowledgeTimeUpperBound < candidate.marketValidTime
      || candidate.knowledgeTimeUpperBound > acquisition.acquisitionTimeUtc) {
    throw new MarketDataL3Error('MARKET_DATA_FUTURE_INFORMATION', 'candidate knowledge interval leaks unavailable or future information');
  }
}

function candidateBarIdentityIds(candidate) {
  return candidate.candidateKind === 'SESSION_DATE_CORRECTION'
    ? [candidate.previousBarIdentityId, candidate.nextBarIdentityId]
    : [candidate.barIdentityId];
}

/** @param {any} store @param {any} candidate */
function verifyCandidateReferences(store, candidate) {
  const lineage = readTypedReference(store, candidate.ingestionLineageId, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, 'ingestion lineage');
  const artifact = readTypedReference(store, candidate.sourceArtifactId, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, 'source artifact');
  const acquisition = readTypedReference(store, candidate.acquisitionRecordId, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, 'acquisition record');
  const parseResult = readTypedReference(store, candidate.parseResultId, MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION, 'parse result');
  const policy = readTypedReference(store, parseResult.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy');
  if (artifact.ingestionLineageId !== candidate.ingestionLineageId
      || acquisition.ingestionLineageId !== candidate.ingestionLineageId
      || parseResult.sourceArtifactId !== candidate.sourceArtifactId
      || parseResult.acquisitionRecordId !== candidate.acquisitionRecordId) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'candidate source closure is incoherent');
  }
  const row = parseResult.rows[candidate.sourceRowIndex];
  if (!row || row.rowDigest !== candidate.sourceRowDigest) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'candidate source row is absent or has another digest');
  }
  const calendarRegistry = verifyMarketCalendarRegistry({
    store, calendarRegistryManifestId: candidate.calendarRegistryManifestId,
  });
  if (calendarRegistry.policy.venueId !== lineage.venueId) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'candidate calendar venue differs from lineage');
  }
  const identities = candidateBarIdentityIds(candidate).map((barIdentityId) => {
    const identity = readTypedReference(store, barIdentityId, MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION, 'bar identity');
    if (identity.instrumentIdentityId !== lineage.instrumentIdentityId
        || identity.frequency !== lineage.frequency || identity.venueId !== lineage.venueId) {
      throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'bar identity differs from ingestion lineage');
    }
    return identity;
  });
  const effectiveIdentity = identities.at(-1);
  const session = findCalendarSession(calendarRegistry, effectiveIdentity.sessionDate);
  if (candidate.marketValidTime !== session.marketValidTime) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'marketValidTime differs from the pinned calendar session');
  }
  if (candidate.replacementValues && candidate.replacementValues.priceBasis !== lineage.priceBasis) {
    throw new MarketDataL3Error('MARKET_DATA_CANDIDATE_SHAPE_INVALID', 'replacement price basis differs from lineage');
  }
  verifyKnowledge(store, candidate, acquisition, policy);
  return { lineage, artifact, acquisition, parseResult, policy, calendarRegistry, identities };
}

/** @param {unknown} input */
export function buildMarketDataNormalizedCandidate(input) {
  const api = assertApiInput(input, ['candidate']);
  const candidate = normalizeMarketDataNormalizedCandidateV1(api.candidate);
  const resolved = verifyCandidateReferences(api.store, candidate);
  const stored = putCanonicalL3(api.store, MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION, candidate);
  return { candidateId: stored.objectId, candidate: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyMarketDataNormalizedCandidate(input) {
  const api = assertApiInput(input, ['candidateId']);
  const candidate = readTypedReference(api.store, api.candidateId, MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION, 'normalized candidate');
  const resolved = verifyCandidateReferences(api.store, candidate);
  return { candidateId: api.candidateId, candidate, ...resolved };
}

function verifyCandidateSetReferences(store, set) {
  const lineage = verifyMarketDataIngestionLineage({
    store,
    ingestionLineageId: set.ingestionLineageId,
    ingestionPolicyId: set.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: set.identityRegistryManifestId,
    calendarRegistryManifestId: set.calendarRegistryManifestId,
    corporateActionRegistryManifestId: set.corporateActionRegistryManifestId,
  }).ingestionLineage;
  const candidates = set.candidateIds.map((candidateId) => verifyMarketDataNormalizedCandidate({ store, candidateId }).candidate);
  for (const candidate of candidates) {
    if (candidate.ingestionLineageId !== set.ingestionLineageId
        || candidate.sourceArtifactId !== set.sourceArtifactId
        || candidate.acquisitionRecordId !== set.acquisitionRecordId
        || candidate.parseResultId !== set.parseResultId
        || candidate.calendarRegistryManifestId !== set.calendarRegistryManifestId) {
      throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'candidate does not belong to the CandidateSet closure');
    }
  }
  const parseResult = readTypedReference(store, set.parseResultId, MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION, 'parse result');
  if (parseResult.ingestionPolicyId !== set.ingestionPolicyId) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'CandidateSet policy differs from ParseResult policy');
  }
  return { lineage, candidates };
}

/** @param {unknown} input */
export function buildMarketDataCandidateSet(input) {
  const api = assertApiInput(input, ['candidateSet']);
  const candidateSet = normalizeMarketDataCandidateSetCoreV1(api.candidateSet);
  const resolved = verifyCandidateSetReferences(api.store, candidateSet);
  const stored = putCanonicalL3(api.store, MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION, candidateSet);
  return { candidateSetId: stored.objectId, candidateSet: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyMarketDataCandidateSet(input) {
  const api = assertApiInput(input, ['candidateSetId']);
  const candidateSet = readTypedReference(api.store, api.candidateSetId, MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION, 'candidate set');
  const resolved = verifyCandidateSetReferences(api.store, candidateSet);
  return { candidateSetId: api.candidateSetId, candidateSet, ...resolved };
}

function verifyReportPartition(store, report) {
  const candidateSet = verifyMarketDataCandidateSet({ store, candidateSetId: report.candidateSetId }).candidateSet;
  if (candidateSet.ingestionPolicyId !== report.ingestionPolicyId) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'ValidationReport policy differs from CandidateSet');
  }
  const reportIds = report.decisions.map((decision) => decision.candidateId);
  if (!canonicalValuesEqual(reportIds, candidateSet.candidateIds)) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'decisions must partition the CandidateSet exactly');
  }
  assertFatalErrorsExcludeAccepted(report.decisions, report.fatalErrors);
  return candidateSet;
}

/** @param {unknown} input */
export function buildMarketDataValidationReport(input) {
  const api = assertApiInput(input, ['report']);
  const report = normalizeMarketDataValidationReportV1(api.report);
  const candidateSet = verifyReportPartition(api.store, report);
  const stored = putCanonicalL3(api.store, MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION, report);
  return { validationReportId: stored.objectId, validationReport: stored.value, candidateSet, object: stored };
}

/** @param {unknown} input */
export function verifyMarketDataValidationReport(input) {
  const api = assertApiInput(input, ['validationReportId']);
  const report = readTypedReference(api.store, api.validationReportId, MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION, 'validation report');
  const candidateSet = verifyReportPartition(api.store, report);
  return { validationReportId: api.validationReportId, validationReport: report, candidateSet };
}

function normalizeBaseView(value) {
  const view = assertPlainObject(value, 'baseView');
  assertExactFields(view, BASE_VIEW_FIELDS);
  assertCasId(view.baseIngestionRegistryManifestId, 'baseIngestionRegistryManifestId');
  assertCasId(view.expectedParentIngestionManifestId, 'expectedParentIngestionManifestId', true);
  for (const field of BASE_VIEW_FIELDS.slice(2)) {
    assertSortedUniqueStrings(view[field], field);
    for (let i = 0; i < view[field].length; i += 1) assertCasId(view[field][i], `${field}[${i}]`);
  }
  if (view.terminalCorrectionIds.some((id) => !view.visibleCorrectionIds.includes(id))) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'terminal corrections must be visible in the pinned base view');
  }
  return { ...view };
}

function candidateParentId(candidate) {
  if (candidate.candidateKind === 'BAR_RESTORATION') return candidate.targetWithdrawalCorrectionId;
  if (['BAR_VALUE_REVISION', 'BAR_WITHDRAWAL', 'SESSION_DATE_CORRECTION'].includes(candidate.candidateKind)) return candidate.targetCorrectionId;
  return null;
}

function candidatePrimaryBarId(candidate) {
  return candidate.candidateKind === 'SESSION_DATE_CORRECTION'
    ? candidate.previousBarIdentityId : candidate.barIdentityId;
}

function baseContainsCycle(corrections) {
  for (const correctionId of corrections.keys()) {
    const seen = new Set();
    let cursor = correctionId;
    while (cursor !== null && corrections.has(cursor)) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = corrections.get(cursor).parentCorrectionId;
    }
  }
  return false;
}

/**
 * Effective observation immediately at one correction node.
 * WITHDRAWAL / SESSION_DATE_WITHDRAWAL yield null (no live observation).
 * @param {any} correction
 */
function effectiveObservationIdAt(correction) {
  if (['INITIAL_ROOT', 'VALUE_REVISION', 'SESSION_DATE_REPLACEMENT'].includes(correction.correctionKind)) {
    return correction.observationId;
  }
  if (correction.correctionKind === 'RESTORATION') return correction.restoredObservationId;
  return null;
}

/**
 * Derive the visible correction graph and its true terminal leaves.
 * Caller-supplied terminalCorrectionIds never grant authority; they must match.
 * @param {any} store @param {any} view
 */
function deriveVisibleCorrectionGraph(store, view) {
  const corrections = new Map();
  const fatal = new Set();
  for (const correctionId of view.visibleCorrectionIds) {
    try {
      corrections.set(correctionId, readTypedReference(
        store, correctionId, 'MarketDataBarCorrectionCore/1', 'base correction',
      ));
    } catch {
      fatal.add('MARKET_DATA_CORRECTION_CHAIN_INVALID');
    }
  }
  const visibleChildrenByParent = new Map();
  for (const [correctionId, correction] of corrections) {
    const parentId = correction.parentCorrectionId;
    if (parentId === null) continue;
    if (!corrections.has(parentId)) {
      fatal.add('MARKET_DATA_CORRECTION_PARENT_MISMATCH');
      continue;
    }
    const parent = corrections.get(parentId);
    if (parent.ingestionLineageId !== correction.ingestionLineageId) {
      fatal.add('MARKET_DATA_CORRECTION_LINEAGE_MISMATCH');
    }
    if (parent.barIdentityId !== correction.barIdentityId) {
      fatal.add('MARKET_DATA_CORRECTION_PARENT_MISMATCH');
    }
    if (!visibleChildrenByParent.has(parentId)) visibleChildrenByParent.set(parentId, []);
    visibleChildrenByParent.get(parentId).push(correctionId);
  }
  for (const childIds of visibleChildrenByParent.values()) {
    if (childIds.length > 1 || new Set(childIds).size !== childIds.length) {
      fatal.add('MARKET_DATA_BAR_REVISION_BRANCH');
    }
  }
  if (baseContainsCycle(corrections)) fatal.add('MARKET_DATA_CORRECTION_CHAIN_INVALID');
  const derivedTerminalIds = view.visibleCorrectionIds
    .filter((correctionId) => corrections.has(correctionId) && !visibleChildrenByParent.has(correctionId))
    .slice()
    .sort();
  const suppliedTerminalIds = [...view.terminalCorrectionIds].sort();
  if (!canonicalValuesEqual(derivedTerminalIds, suppliedTerminalIds)) {
    for (const terminalId of suppliedTerminalIds) {
      if (visibleChildrenByParent.has(terminalId)) fatal.add('MARKET_DATA_BAR_REVISION_BRANCH');
      else fatal.add('MARKET_DATA_CORRECTION_CHAIN_INVALID');
    }
    for (const terminalId of derivedTerminalIds) {
      if (!suppliedTerminalIds.includes(terminalId)) fatal.add('MARKET_DATA_CORRECTION_CHAIN_INVALID');
    }
    if (fatal.size === 0) fatal.add('MARKET_DATA_CORRECTION_CHAIN_INVALID');
  }
  return {
    corrections,
    visibleChildrenByParent,
    derivedTerminalIds,
    fatalErrors: [...fatal].sort(),
  };
}

/**
 * Restoration may only revive the observation that was effective immediately
 * before the targeted WITHDRAWAL.
 * @param {any} candidate @param {any} withdrawal @param {Map<string, any>} corrections
 */
function restorationReasonCodes(candidate, withdrawal, corrections) {
  if (withdrawal.correctionKind !== 'WITHDRAWAL') {
    return ['MARKET_DATA_CORRECTION_CHAIN_INVALID'];
  }
  if (withdrawal.ingestionLineageId !== candidate.ingestionLineageId
      || withdrawal.barIdentityId !== candidate.barIdentityId) {
    return ['MARKET_DATA_CORRECTION_PARENT_MISMATCH'];
  }
  const priorId = withdrawal.parentCorrectionId;
  if (priorId === null || !corrections.has(priorId)) {
    return ['MARKET_DATA_CORRECTION_CHAIN_INVALID'];
  }
  const prior = corrections.get(priorId);
  if (prior.ingestionLineageId !== candidate.ingestionLineageId
      || prior.barIdentityId !== candidate.barIdentityId) {
    return ['MARKET_DATA_CORRECTION_LINEAGE_MISMATCH'];
  }
  const effective = effectiveObservationIdAt(prior);
  if (effective === null || effective !== candidate.restoredObservationId) {
    return ['MARKET_DATA_CORRECTION_CHAIN_INVALID'];
  }
  return [];
}

/**
 * Single deterministic authority for economic dispositions.
 * Builder, publisher revalidation and tests must all use this path.
 * @param {any} store @param {any} candidateSet @param {any[]} candidates @param {any} view
 */
export function deriveMarketDataValidationEconomics(store, candidateSet, candidates, view) {
  const graph = deriveVisibleCorrectionGraph(store, view);
  const fatalErrors = [...graph.fatalErrors];
  const candidateChildrenByParent = new Map();
  candidates.forEach((candidate, index) => {
    const parentId = candidateParentId(candidate);
    if (parentId === null) return;
    if (!candidateChildrenByParent.has(parentId)) candidateChildrenByParent.set(parentId, []);
    candidateChildrenByParent.get(parentId).push(candidateSet.candidateIds[index]);
  });
  const decisions = candidateSet.candidateIds.map((candidateId, index) => {
    const candidate = candidates[index];
    if (view.duplicateCandidateIds.includes(candidateId)) {
      return { candidateId, disposition: 'DUPLICATE', reasonCodes: ['MARKET_DATA_CANDIDATE_DUPLICATE'] };
    }
    if (fatalErrors.length > 0) {
      return { candidateId, disposition: 'REJECTED', reasonCodes: [fatalErrors[0]] };
    }
    if (candidate.candidateKind === 'BAR_INITIAL_VALUE') {
      if (view.occupiedBarIdentityIds.includes(candidate.barIdentityId)) {
        return { candidateId, disposition: 'CONFLICTING', reasonCodes: ['MARKET_DATA_BAR_INITIAL_VALUE_CONFLICT'] };
      }
      return { candidateId, disposition: 'ACCEPTED', reasonCodes: [] };
    }
    if (candidate.candidateKind === 'SESSION_DATE_CORRECTION') {
      if (!view.publishedBarIdentityIds.includes(candidate.nextBarIdentityId)) {
        return { candidateId, disposition: 'REJECTED', reasonCodes: ['MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION'] };
      }
      if (view.occupiedBarIdentityIds.includes(candidate.nextBarIdentityId)) {
        return { candidateId, disposition: 'REJECTED', reasonCodes: ['MARKET_DATA_SESSION_DATE_TARGET_OCCUPIED'] };
      }
    }
    const parentId = candidateParentId(candidate);
    const parent = graph.corrections.get(parentId);
    if (!parent) {
      return { candidateId, disposition: 'REJECTED', reasonCodes: ['MARKET_DATA_CORRECTION_PARENT_MISMATCH'] };
    }
    if (parent.ingestionLineageId !== candidate.ingestionLineageId) {
      return { candidateId, disposition: 'REJECTED', reasonCodes: ['MARKET_DATA_CORRECTION_LINEAGE_MISMATCH'] };
    }
    if (parent.barIdentityId !== candidatePrimaryBarId(candidate)) {
      return { candidateId, disposition: 'REJECTED', reasonCodes: ['MARKET_DATA_CORRECTION_PARENT_MISMATCH'] };
    }
    const visibleKids = graph.visibleChildrenByParent.get(parentId) || [];
    const candidateKids = candidateChildrenByParent.get(parentId) || [];
    if (visibleKids.length > 0 || candidateKids.length > 1) {
      return { candidateId, disposition: 'CONFLICTING', reasonCodes: ['MARKET_DATA_BAR_REVISION_BRANCH'] };
    }
    if (!graph.derivedTerminalIds.includes(parentId)) {
      return { candidateId, disposition: 'REJECTED', reasonCodes: ['MARKET_DATA_CORRECTION_STALE_PARENT'] };
    }
    if (candidate.candidateKind === 'BAR_RESTORATION') {
      const reasonCodes = restorationReasonCodes(candidate, parent, graph.corrections);
      if (reasonCodes.length > 0) {
        return { candidateId, disposition: 'REJECTED', reasonCodes };
      }
    }
    return { candidateId, disposition: 'ACCEPTED', reasonCodes: [] };
  });
  return { decisions, fatalErrors, warnings: [], derivedTerminalIds: graph.derivedTerminalIds };
}

const VALIDATION_REPORT_COMPARE_FIELDS = Object.freeze([
  'candidateSetId', 'ingestionPolicyId', 'baseIngestionRegistryManifestId',
  'expectedParentIngestionManifestId', 'decisions', 'fatalErrors', 'warnings',
]);

/**
 * Recompute the deterministic ValidationReport for a pinned base view and
 * refuse any stored report that diverges. Stored dispositions are never authority.
 * @param {unknown} input
 */
export function assertDeterministicValidationReport(input) {
  const api = assertApiInput(input, ['candidateSetId', 'validationReportId', 'baseView']);
  const view = normalizeBaseView(api.baseView);
  const provided = verifyMarketDataValidationReport({
    store: api.store, validationReportId: api.validationReportId,
  }).validationReport;
  if (provided.candidateSetId !== api.candidateSetId) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'validation report belongs to another CandidateSet');
  }
  if (provided.baseIngestionRegistryManifestId !== view.baseIngestionRegistryManifestId
      || provided.expectedParentIngestionManifestId !== view.expectedParentIngestionManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'base view pins diverge from the validation report');
  }
  assertFatalErrorsExcludeAccepted(provided.decisions, provided.fatalErrors);
  const expected = validateMarketDataCandidateSet({
    store: api.store, candidateSetId: api.candidateSetId, baseView: view,
  }).validationReport;
  for (const field of VALIDATION_REPORT_COMPARE_FIELDS) {
    if (!canonicalValuesEqual(provided[field], expected[field])) {
      throw new MarketDataL3Error(
        'MARKET_DATA_VALIDATION_FAILED',
        'stored ValidationReport diverges from deterministic recomputation',
        { field },
      );
    }
  }
  return { validationReport: provided, expectedValidationReport: expected, baseView: view };
}

/** Deterministic validation against one explicitly supplied, pinned base view. @param {unknown} input */
export function validateMarketDataCandidateSet(input) {
  const api = assertApiInput(input, ['candidateSetId', 'baseView']);
  const resolved = verifyMarketDataCandidateSet({ store: api.store, candidateSetId: api.candidateSetId });
  const view = normalizeBaseView(api.baseView);
  const economics = deriveMarketDataValidationEconomics(
    api.store, resolved.candidateSet, resolved.candidates, view,
  );
  return buildMarketDataValidationReport({
    store: api.store,
    report: {
      schemaVersion: MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
      candidateSetId: api.candidateSetId,
      ingestionPolicyId: resolved.candidateSet.ingestionPolicyId,
      baseIngestionRegistryManifestId: view.baseIngestionRegistryManifestId,
      expectedParentIngestionManifestId: view.expectedParentIngestionManifestId,
      decisions: economics.decisions,
      fatalErrors: economics.fatalErrors,
      warnings: economics.warnings,
    },
  });
}

export const recoverMarketDataNormalizedCandidate = verifyMarketDataNormalizedCandidate;
export const recoverMarketDataCandidateSet = verifyMarketDataCandidateSet;
export const recoverMarketDataValidationReport = verifyMarketDataValidationReport;
