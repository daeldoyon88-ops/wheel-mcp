/** L3-I2 immutable observations, correction chains and accepted publication manifest. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
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
  MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
  normalizeMarketDataReplacementValuesV1,
  verifyMarketDataCandidateSet,
  verifyMarketDataNormalizedCandidate,
  verifyMarketDataValidationReport,
} from './marketDataCandidateL3V1.mjs';

export const MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION = 'MarketDataBarObservationCore/1';
export const MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION = 'MarketDataBarCorrectionCore/1';
export const MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION = 'MarketDataAcceptedCandidatePublicationManifest/1';
export const MARKET_DATA_BAR_REVISION_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
  MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
  MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
]);
export const MARKET_DATA_CORRECTION_KINDS = Object.freeze([
  'INITIAL_ROOT', 'RESTORATION', 'SESSION_DATE_REPLACEMENT',
  'SESSION_DATE_WITHDRAWAL', 'VALUE_REVISION', 'WITHDRAWAL',
]);

const OBSERVATION_FIELDS = Object.freeze([
  'schemaVersion', 'ingestionLineageId', 'barIdentityId', 'sourceArtifactId',
  'acquisitionRecordId', 'parseResultId', 'sourceRowIndex', 'sourceRowDigest',
  'values', 'calendarRegistryManifestId', 'marketValidTime', 'knowledgeMode',
  'knowledgeTimeLowerBound', 'knowledgeTimeUpperBound',
  'sourceTimestampEvidenceId', 'providerRevisionId',
]);
const CORRECTION_FIELDS = Object.freeze([
  'schemaVersion', 'correctionKind', 'ingestionLineageId', 'barIdentityId',
  'parentCorrectionId', 'observationId', 'restoredObservationId', 'sessionDateLink',
  'sourceArtifactId', 'acquisitionRecordId', 'parseResultId', 'sourceRowIndex',
  'sourceRowDigest', 'knowledgeMode', 'knowledgeTimeLowerBound',
  'knowledgeTimeUpperBound', 'sourceTimestampEvidenceId', 'providerRevisionId',
]);
const SESSION_LINK_FIELDS = Object.freeze([
  'previousBarIdentityId', 'nextBarIdentityId', 'withdrawalCorrectionId',
]);
const PUBLICATION_FIELDS = Object.freeze([
  'schemaVersion', 'candidateSetId', 'validationReportId',
  'baseIngestionRegistryManifestId', 'expectedParentIngestionManifestId',
  'ingestionLineageId', 'publications',
]);
const PUBLICATION_ENTRY_FIELDS = Object.freeze([
  'candidateId', 'observationId', 'correctionIds',
]);

function normalizeNullableInstant(value, label) {
  if (value !== null) assertUtcInstant(value, label);
  return value;
}

/** @param {unknown} value */
export function normalizeMarketDataBarObservationCoreV1(value) {
  const observation = assertPlainObject(value, MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION);
  assertSchemaVersion(observation, MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION);
  assertExactFields(observation, OBSERVATION_FIELDS);
  for (const field of ['ingestionLineageId', 'barIdentityId', 'sourceArtifactId',
    'acquisitionRecordId', 'parseResultId', 'sourceRowDigest', 'calendarRegistryManifestId']) {
    assertCasId(observation[field], field);
  }
  assertSafeInteger(observation.sourceRowIndex, 'sourceRowIndex', { nonNegative: true });
  const values = normalizeMarketDataReplacementValuesV1(observation.values);
  assertUtcInstant(observation.marketValidTime, 'marketValidTime');
  assertEnum(observation.knowledgeMode, [
    'CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED',
    'PROVIDER_REVISION_HISTORY_ATTESTED',
  ], 'knowledgeMode', 'MARKET_DATA_KNOWLEDGE_MODE_INVALID');
  normalizeNullableInstant(observation.knowledgeTimeLowerBound, 'knowledgeTimeLowerBound');
  assertUtcInstant(observation.knowledgeTimeUpperBound, 'knowledgeTimeUpperBound');
  assertCasId(observation.sourceTimestampEvidenceId, 'sourceTimestampEvidenceId', true);
  if (observation.providerRevisionId !== null
      && (typeof observation.providerRevisionId !== 'string' || observation.providerRevisionId.length === 0)) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'providerRevisionId must be null or non-empty text');
  }
  return { ...observation, values };
}

function normalizeSessionDateLink(value, correctionKind) {
  if (!['SESSION_DATE_WITHDRAWAL', 'SESSION_DATE_REPLACEMENT'].includes(correctionKind)) {
    if (value !== null) throw new MarketDataL3Error('MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION', 'non-session correction requires sessionDateLink = null');
    return null;
  }
  const link = assertPlainObject(value, 'sessionDateLink');
  assertExactFields(link, SESSION_LINK_FIELDS);
  for (const field of SESSION_LINK_FIELDS) assertCasId(link[field], `sessionDateLink.${field}`, true);
  if (correctionKind === 'SESSION_DATE_WITHDRAWAL') {
    if (link.previousBarIdentityId !== null || link.nextBarIdentityId === null || link.withdrawalCorrectionId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION', 'session withdrawal link must name only nextBarIdentityId');
    }
  } else if (link.previousBarIdentityId === null || link.nextBarIdentityId !== null
      || link.withdrawalCorrectionId === null) {
    throw new MarketDataL3Error('MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION', 'session replacement link must name previous identity and withdrawal correction');
  }
  return { ...link };
}

/** @param {unknown} value */
export function normalizeMarketDataBarCorrectionCoreV1(value) {
  const correction = assertPlainObject(value, MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION);
  assertSchemaVersion(correction, MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION);
  assertExactFields(correction, CORRECTION_FIELDS);
  assertEnum(correction.correctionKind, MARKET_DATA_CORRECTION_KINDS, 'correctionKind', 'MARKET_DATA_CORRECTION_CHAIN_INVALID');
  for (const field of ['ingestionLineageId', 'barIdentityId', 'sourceArtifactId',
    'acquisitionRecordId', 'parseResultId', 'sourceRowDigest']) assertCasId(correction[field], field);
  for (const field of ['parentCorrectionId', 'observationId', 'restoredObservationId', 'sourceTimestampEvidenceId']) {
    assertCasId(correction[field], field, true);
  }
  assertSafeInteger(correction.sourceRowIndex, 'sourceRowIndex', { nonNegative: true });
  assertEnum(correction.knowledgeMode, [
    'CAPTURE_TIME_ONLY', 'PROVIDER_PUBLICATION_TIME_ATTESTED',
    'PROVIDER_REVISION_HISTORY_ATTESTED',
  ], 'knowledgeMode', 'MARKET_DATA_KNOWLEDGE_MODE_INVALID');
  normalizeNullableInstant(correction.knowledgeTimeLowerBound, 'knowledgeTimeLowerBound');
  assertUtcInstant(correction.knowledgeTimeUpperBound, 'knowledgeTimeUpperBound');
  if (correction.providerRevisionId !== null
      && (typeof correction.providerRevisionId !== 'string' || correction.providerRevisionId.length === 0)) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'providerRevisionId must be null or non-empty text');
  }
  const sessionDateLink = normalizeSessionDateLink(correction.sessionDateLink, correction.correctionKind);
  if (['VALUE_REVISION', 'WITHDRAWAL', 'RESTORATION', 'SESSION_DATE_WITHDRAWAL'].includes(correction.correctionKind)
      && correction.parentCorrectionId === null) {
    throw new MarketDataL3Error('MARKET_DATA_CORRECTION_PARENT_REQUIRED', 'parentCorrectionId is required');
  }
  const requirements = {
    INITIAL_ROOT: [false, true, false],
    VALUE_REVISION: [true, true, false],
    WITHDRAWAL: [true, false, false],
    RESTORATION: [true, false, true],
    SESSION_DATE_WITHDRAWAL: [true, false, false],
    SESSION_DATE_REPLACEMENT: [false, true, false],
  }[correction.correctionKind];
  const actual = [correction.parentCorrectionId !== null, correction.observationId !== null,
    correction.restoredObservationId !== null];
  if (!canonicalValuesEqual(requirements, actual)) {
    const code = correction.correctionKind.startsWith('SESSION_DATE_')
      ? 'MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION' : 'MARKET_DATA_CORRECTION_CHAIN_INVALID';
    throw new MarketDataL3Error(code, 'correction references do not match correctionKind');
  }
  return { ...correction, sessionDateLink };
}

/** @param {unknown} value */
export function normalizeMarketDataAcceptedCandidatePublicationManifestV1(value) {
  const manifest = assertPlainObject(value, MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION);
  assertSchemaVersion(manifest, MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION);
  assertExactFields(manifest, PUBLICATION_FIELDS);
  for (const field of ['candidateSetId', 'validationReportId', 'baseIngestionRegistryManifestId', 'ingestionLineageId']) {
    assertCasId(manifest[field], field);
  }
  assertCasId(manifest.expectedParentIngestionManifestId, 'expectedParentIngestionManifestId', true);
  if (!Array.isArray(manifest.publications) || manifest.publications.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'publications must be non-empty');
  }
  const publications = manifest.publications.map((raw, index) => {
    const entry = assertPlainObject(raw, `publications[${index}]`);
    assertExactFields(entry, PUBLICATION_ENTRY_FIELDS);
    assertCasId(entry.candidateId, `publications[${index}].candidateId`);
    assertCasId(entry.observationId, `publications[${index}].observationId`, true);
    assertSortedUniqueStrings(entry.correctionIds, `publications[${index}].correctionIds`);
    for (let i = 0; i < entry.correctionIds.length; i += 1) assertCasId(entry.correctionIds[i], `correctionIds[${i}]`);
    if (entry.observationId === null && entry.correctionIds.length === 0) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'an accepted candidate must publish an observation or correction');
    }
    return { candidateId: entry.candidateId, observationId: entry.observationId, correctionIds: [...entry.correctionIds] };
  });
  for (let i = 1; i < publications.length; i += 1) {
    if (publications[i - 1].candidateId >= publications[i].candidateId) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'publications must be sorted and unique by candidateId');
    }
  }
  const observationIds = publications.map((entry) => entry.observationId).filter(Boolean);
  const correctionIds = publications.flatMap((entry) => entry.correctionIds);
  if (new Set(observationIds).size !== observationIds.length || new Set(correctionIds).size !== correctionIds.length) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'published objects must appear exactly once');
  }
  return { ...manifest, publications };
}

function acceptedContext(store, candidateId, candidateSetId, validationReportId) {
  const candidate = verifyMarketDataNormalizedCandidate({ store, candidateId }).candidate;
  const candidateSet = verifyMarketDataCandidateSet({ store, candidateSetId }).candidateSet;
  const report = verifyMarketDataValidationReport({ store, validationReportId }).validationReport;
  if (report.candidateSetId !== candidateSetId || !candidateSet.candidateIds.includes(candidateId)) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_PUBLICATION_ORDER_VIOLATION', 'candidate is outside the validated CandidateSet');
  }
  const decision = report.decisions.find((item) => item.candidateId === candidateId);
  if (decision?.disposition !== 'ACCEPTED' || report.fatalErrors.length > 0) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_PUBLICATION_ORDER_VIOLATION', 'only a non-fatally ACCEPTED candidate may be materialized');
  }
  return { candidate, candidateSet, report };
}

function expectedObservation(candidate) {
  if (!candidate.replacementValues) return null;
  const barIdentityId = candidate.candidateKind === 'SESSION_DATE_CORRECTION'
    ? candidate.nextBarIdentityId : candidate.barIdentityId;
  return {
    schemaVersion: MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
    ingestionLineageId: candidate.ingestionLineageId,
    barIdentityId,
    sourceArtifactId: candidate.sourceArtifactId,
    acquisitionRecordId: candidate.acquisitionRecordId,
    parseResultId: candidate.parseResultId,
    sourceRowIndex: candidate.sourceRowIndex,
    sourceRowDigest: candidate.sourceRowDigest,
    values: candidate.replacementValues,
    calendarRegistryManifestId: candidate.calendarRegistryManifestId,
    marketValidTime: candidate.marketValidTime,
    knowledgeMode: candidate.knowledgeMode,
    knowledgeTimeLowerBound: candidate.knowledgeTimeLowerBound,
    knowledgeTimeUpperBound: candidate.knowledgeTimeUpperBound,
    sourceTimestampEvidenceId: candidate.sourceTimestampEvidenceId,
    providerRevisionId: candidate.providerRevisionId,
  };
}

/** @param {unknown} input */
export function buildMarketDataBarObservation(input) {
  const api = assertApiInput(input, ['candidateId', 'candidateSetId', 'validationReportId', 'observation']);
  const context = acceptedContext(api.store, api.candidateId, api.candidateSetId, api.validationReportId);
  const observation = normalizeMarketDataBarObservationCoreV1(api.observation);
  const expected = expectedObservation(context.candidate);
  if (expected === null || !canonicalValuesEqual(observation, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'observation is not the lossless accepted-candidate projection');
  }
  const stored = putCanonicalL3(api.store, MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION, observation);
  return { observationId: stored.objectId, observation: stored.value, object: stored, ...context };
}

/** @param {unknown} input */
export function verifyMarketDataBarObservation(input) {
  const api = assertApiInput(input, ['observationId']);
  const observation = readTypedReference(api.store, api.observationId, MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION, 'bar observation');
  return { observationId: api.observationId, observation };
}

function expectedCorrectionCandidates(candidate, observationId, withdrawalCorrectionId = null) {
  const common = {
    schemaVersion: MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
    ingestionLineageId: candidate.ingestionLineageId,
    sourceArtifactId: candidate.sourceArtifactId,
    acquisitionRecordId: candidate.acquisitionRecordId,
    parseResultId: candidate.parseResultId,
    sourceRowIndex: candidate.sourceRowIndex,
    sourceRowDigest: candidate.sourceRowDigest,
    knowledgeMode: candidate.knowledgeMode,
    knowledgeTimeLowerBound: candidate.knowledgeTimeLowerBound,
    knowledgeTimeUpperBound: candidate.knowledgeTimeUpperBound,
    sourceTimestampEvidenceId: candidate.sourceTimestampEvidenceId,
    providerRevisionId: candidate.providerRevisionId,
  };
  if (candidate.candidateKind === 'BAR_INITIAL_VALUE') return [{ ...common,
    correctionKind: 'INITIAL_ROOT', barIdentityId: candidate.barIdentityId,
    parentCorrectionId: null, observationId, restoredObservationId: null, sessionDateLink: null }];
  if (candidate.candidateKind === 'BAR_VALUE_REVISION') return [{ ...common,
    correctionKind: 'VALUE_REVISION', barIdentityId: candidate.barIdentityId,
    parentCorrectionId: candidate.targetCorrectionId, observationId,
    restoredObservationId: null, sessionDateLink: null }];
  if (candidate.candidateKind === 'BAR_WITHDRAWAL') return [{ ...common,
    correctionKind: 'WITHDRAWAL', barIdentityId: candidate.barIdentityId,
    parentCorrectionId: candidate.targetCorrectionId, observationId: null,
    restoredObservationId: null, sessionDateLink: null }];
  if (candidate.candidateKind === 'BAR_RESTORATION') return [{ ...common,
    correctionKind: 'RESTORATION', barIdentityId: candidate.barIdentityId,
    parentCorrectionId: candidate.targetWithdrawalCorrectionId, observationId: null,
    restoredObservationId: candidate.restoredObservationId, sessionDateLink: null }];
  const withdrawal = { ...common,
    correctionKind: 'SESSION_DATE_WITHDRAWAL', barIdentityId: candidate.previousBarIdentityId,
    parentCorrectionId: candidate.targetCorrectionId, observationId: null,
    restoredObservationId: null, sessionDateLink: {
      previousBarIdentityId: null, nextBarIdentityId: candidate.nextBarIdentityId,
      withdrawalCorrectionId: null,
    } };
  const replacement = { ...common,
    correctionKind: 'SESSION_DATE_REPLACEMENT', barIdentityId: candidate.nextBarIdentityId,
    parentCorrectionId: null, observationId, restoredObservationId: null,
    sessionDateLink: {
      previousBarIdentityId: candidate.previousBarIdentityId, nextBarIdentityId: null,
      withdrawalCorrectionId,
    } };
  return [withdrawal, replacement];
}

function verifyCorrectionReferences(store, correction, correctionId = null) {
  if (correction.parentCorrectionId !== null) {
    const parent = readTypedReference(store, correction.parentCorrectionId, MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, 'parent correction');
    if (parent.ingestionLineageId !== correction.ingestionLineageId) {
      throw new MarketDataL3Error('MARKET_DATA_CORRECTION_LINEAGE_MISMATCH', 'parent correction belongs to another lineage');
    }
    if (parent.barIdentityId !== correction.barIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_CORRECTION_PARENT_MISMATCH', 'parent correction belongs to another bar');
    }
    const seen = new Set(correctionId === null ? [] : [correctionId]);
    let cursorId = correction.parentCorrectionId;
    let cursor = parent;
    while (cursorId !== null) {
      if (seen.has(cursorId)) {
        throw new MarketDataL3Error('MARKET_DATA_CORRECTION_CHAIN_INVALID', 'correction parent chain contains a cycle');
      }
      seen.add(cursorId);
      cursorId = cursor.parentCorrectionId;
      if (cursorId !== null) {
        cursor = readTypedReference(store, cursorId, MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, 'ancestor correction');
        if (cursor.ingestionLineageId !== correction.ingestionLineageId
            || cursor.barIdentityId !== correction.barIdentityId) {
          throw new MarketDataL3Error('MARKET_DATA_CORRECTION_CHAIN_INVALID', 'correction ancestor leaves its lineage or bar');
        }
      }
    }
  }
  if (correction.observationId !== null) {
    const observation = readTypedReference(store, correction.observationId, MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION, 'bar observation');
    if (observation.ingestionLineageId !== correction.ingestionLineageId || observation.barIdentityId !== correction.barIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_CORRECTION_PARENT_MISMATCH', 'correction observation belongs to another lineage or bar');
    }
  }
  if (correction.restoredObservationId !== null) {
    const restored = readTypedReference(store, correction.restoredObservationId, MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION, 'restored observation');
    if (restored.ingestionLineageId !== correction.ingestionLineageId || restored.barIdentityId !== correction.barIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_CORRECTION_PARENT_MISMATCH', 'restored observation belongs to another lineage or bar');
    }
  }
  if (correction.correctionKind === 'SESSION_DATE_REPLACEMENT') {
    const withdrawal = readTypedReference(store, correction.sessionDateLink.withdrawalCorrectionId,
      MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, 'session-date withdrawal');
    if (withdrawal.correctionKind !== 'SESSION_DATE_WITHDRAWAL'
        || withdrawal.sessionDateLink.nextBarIdentityId !== correction.barIdentityId
        || withdrawal.barIdentityId !== correction.sessionDateLink.previousBarIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION', 'session-date correction pair is incoherent');
    }
  }
}

/** @param {unknown} input */
export function buildMarketDataBarCorrection(input) {
  const api = assertApiInput(input, ['candidateId', 'candidateSetId', 'validationReportId', 'correction']);
  const context = acceptedContext(api.store, api.candidateId, api.candidateSetId, api.validationReportId);
  const correction = normalizeMarketDataBarCorrectionCoreV1(api.correction);
  const expected = expectedCorrectionCandidates(
    context.candidate,
    correction.observationId,
    correction.correctionKind === 'SESSION_DATE_REPLACEMENT'
      ? correction.sessionDateLink.withdrawalCorrectionId : null,
  );
  if (!expected.some((item) => canonicalValuesEqual(item, correction))) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'correction is not the accepted-candidate projection');
  }
  verifyCorrectionReferences(api.store, correction);
  const stored = putCanonicalL3(api.store, MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, correction);
  return { correctionId: stored.objectId, correction: stored.value, object: stored, ...context };
}

/** @param {unknown} input */
export function verifyMarketDataBarCorrection(input) {
  const api = assertApiInput(input, ['correctionId']);
  const correction = readTypedReference(api.store, api.correctionId, MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, 'bar correction');
  verifyCorrectionReferences(api.store, correction, api.correctionId);
  return { correctionId: api.correctionId, correction };
}

/** Materializes one ACCEPTED candidate without granting authority. @param {unknown} input */
export function materializeAcceptedMarketDataCandidate(input) {
  const api = assertApiInput(input, ['candidateId', 'candidateSetId', 'validationReportId']);
  const context = acceptedContext(api.store, api.candidateId, api.candidateSetId, api.validationReportId);
  const expectedObs = expectedObservation(context.candidate);
  let observationId = null;
  if (expectedObs !== null) {
    observationId = buildMarketDataBarObservation({
      store: api.store, candidateId: api.candidateId, candidateSetId: api.candidateSetId,
      validationReportId: api.validationReportId, observation: expectedObs,
    }).observationId;
  }
  const correctionIds = [];
  const firstPass = expectedCorrectionCandidates(context.candidate, observationId, null);
  const first = buildMarketDataBarCorrection({
    store: api.store, candidateId: api.candidateId, candidateSetId: api.candidateSetId,
    validationReportId: api.validationReportId, correction: firstPass[0],
  });
  correctionIds.push(first.correctionId);
  if (context.candidate.candidateKind === 'SESSION_DATE_CORRECTION') {
    const second = expectedCorrectionCandidates(context.candidate, observationId, first.correctionId)[1];
    correctionIds.push(buildMarketDataBarCorrection({
      store: api.store, candidateId: api.candidateId, candidateSetId: api.candidateSetId,
      validationReportId: api.validationReportId, correction: second,
    }).correctionId);
  }
  correctionIds.sort();
  return { candidateId: api.candidateId, observationId, correctionIds };
}

function verifyPublicationReferences(store, manifest) {
  const candidateSet = verifyMarketDataCandidateSet({ store, candidateSetId: manifest.candidateSetId }).candidateSet;
  const report = verifyMarketDataValidationReport({ store, validationReportId: manifest.validationReportId }).validationReport;
  if (report.candidateSetId !== manifest.candidateSetId
      || report.baseIngestionRegistryManifestId !== manifest.baseIngestionRegistryManifestId
      || report.expectedParentIngestionManifestId !== manifest.expectedParentIngestionManifestId
      || candidateSet.ingestionLineageId !== manifest.ingestionLineageId || report.fatalErrors.length > 0) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_PUBLICATION_ORDER_VIOLATION', 'publication manifest does not follow its pinned validation report');
  }
  const acceptedIds = report.decisions.filter((decision) => decision.disposition === 'ACCEPTED')
    .map((decision) => decision.candidateId);
  if (!canonicalValuesEqual(acceptedIds, manifest.publications.map((entry) => entry.candidateId))) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'publication entries must equal ACCEPTED candidates');
  }
  for (const entry of manifest.publications) {
    const candidate = readTypedReference(store, entry.candidateId, MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION, 'normalized candidate');
    const observation = entry.observationId === null ? null
      : readTypedReference(store, entry.observationId, MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION, 'bar observation');
    if (!canonicalValuesEqual(observation, expectedObservation(candidate))) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'published observation does not match candidate');
    }
    const corrections = entry.correctionIds.map((correctionId) => readTypedReference(
      store, correctionId, MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, 'bar correction',
    ));
    corrections.forEach((correction, index) => verifyCorrectionReferences(store, correction, entry.correctionIds[index]));
    const withdrawalId = corrections.find((item) => item.correctionKind === 'SESSION_DATE_WITHDRAWAL')
      ? entry.correctionIds[corrections.findIndex((item) => item.correctionKind === 'SESSION_DATE_WITHDRAWAL')] : null;
    const expected = expectedCorrectionCandidates(candidate, entry.observationId, withdrawalId);
    if (expected.length !== corrections.length
        || expected.some((item) => !corrections.some((actual) => canonicalValuesEqual(item, actual)))) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'published corrections do not match candidate');
    }
  }
  return { candidateSet, validationReport: report };
}

/** @param {unknown} input */
export function buildMarketDataAcceptedCandidatePublicationManifest(input) {
  const api = assertApiInput(input, ['manifest']);
  const manifest = normalizeMarketDataAcceptedCandidatePublicationManifestV1(api.manifest);
  const resolved = verifyPublicationReferences(api.store, manifest);
  const stored = putCanonicalL3(api.store, MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION, manifest);
  return { publicationManifestId: stored.objectId, publicationManifest: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyMarketDataAcceptedCandidatePublicationManifest(input) {
  const api = assertApiInput(input, ['publicationManifestId']);
  const manifest = readTypedReference(api.store, api.publicationManifestId,
    MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION, 'accepted-candidate publication manifest');
  const resolved = verifyPublicationReferences(api.store, manifest);
  return { publicationManifestId: api.publicationManifestId, publicationManifest: manifest, ...resolved };
}

export const recoverMarketDataBarObservation = verifyMarketDataBarObservation;
export const recoverMarketDataBarCorrection = verifyMarketDataBarCorrection;
export const recoverMarketDataAcceptedCandidatePublicationManifest = verifyMarketDataAcceptedCandidatePublicationManifest;
