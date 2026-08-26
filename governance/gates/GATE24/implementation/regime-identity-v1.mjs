/**
 * GATE24 RegimeRecordId: sha256Canonical of exactly the ordered ELEVEN-member tuple.
 *
 * closureRule is EXACT_ONLY: no optional member, no interpretable member, no
 * implicit extension, no at-minimum reading. The member count is ELEVEN per
 * G24-BUILD-08, which records that the mandate string /deferredToContract[3]
 * ("ten required members") is pre-REPAIR_4 prose superseded by
 * /regimeRecordIdentity/requiredMemberCount = 11.
 *
 * The RegimeRecordId identifies the question asked, never the answer: the
 * resolved RegimeVector, classificationQuality and evidenceSetId are excluded by
 * construction, which is the GATE24 generalization of the GATE23 identity rule.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';

export const REGIME_RECORD_IDENTITY_VERSION = 'GATE24_RegimeRecordIdentity/1';
export const REGIME_RECORD_ID_CLOSURE_RULE = 'EXACT_ONLY';

/** G24-BUILD-08: exactly these eleven members, in exactly this order. */
export const REGIME_RECORD_ID_MEMBERS_V1 = Object.freeze([
  'InstrumentIdentityId',
  'SessionDate',
  'KnowledgeCutoff',
  'RegimeHorizonSpecId',
  'FeatureVectorBindingId',
  'MacroContextBindingId',
  'RegimeTaxonomyVersionId',
  'ClassifierVersionId',
  'ParameterSetId',
  'DatasetId_feature',
  'MissingnessStateId',
]);

export const REGIME_RECORD_ID_MEMBER_COUNT = REGIME_RECORD_ID_MEMBERS_V1.length;

export const FEATURE_VECTOR_BINDING_VERSION = 'GATE24_FeatureVectorBinding/1';

/**
 * Members that may never enter a GATE24 identity digest: alias vocabulary, any
 * GATE22 Outcome member, and any answer-bearing field.
 */
export const FORBIDDEN_IN_IDENTITY_DIGEST = Object.freeze([
  'ticker', 'symbol', 'alias', 'temporaryAlias',
  'ObservationId', 'OutcomeId', 'OutcomeStatus', 'OutcomeMissingReason', 'OutcomeWindowCause',
  'HorizonId', 'DatasetId_outcome', 'TaxonomyVersion',
  'featureValue', 'value', 'status', 'vectorStatus',
  'regimeVector', 'primaryMarketRegime', 'volatilityState', 'inflationState',
  'ratesState', 'yieldCurveShape', 'yieldCurveDirection',
  'classificationQuality', 'classificationEvidence', 'evidenceSetId',
  'transitionType', 'changedDimensions', 'regimeAgeSessions', 'lastTransitionSession',
]);

const FORBIDDEN = new Set(FORBIDDEN_IN_IDENTITY_DIGEST);

function assertExactOnly(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('REGIME_RECORD_ID_EXACT_ONLY');
  const keys = Object.keys(input);
  if (keys.some((key) => FORBIDDEN.has(key))) throw new Error('REGIME_RECORD_ID_FORBIDDEN_MEMBER');
  if (keys.length !== REGIME_RECORD_ID_MEMBER_COUNT) throw new Error('REGIME_RECORD_ID_EXACT_ONLY');
  if (REGIME_RECORD_ID_MEMBERS_V1.some((member) => !Object.hasOwn(input, member))) throw new Error('REGIME_RECORD_ID_EXACT_ONLY');
  if (REGIME_RECORD_ID_MEMBERS_V1.some((member) => typeof input[member] !== 'string' || input[member].length === 0)) {
    throw new Error('REGIME_RECORD_ID_MEMBER_INVALID');
  }
}

/** Ordered member tuple, for disclosure and evidence. */
export function regimeRecordIdentityTuple(input) {
  assertExactOnly(input);
  return Object.freeze(REGIME_RECORD_ID_MEMBERS_V1.map((member) => input[member]));
}

export function createRegimeRecordId(input) {
  assertExactOnly(input);
  return sha256Canonical(Object.fromEntries(REGIME_RECORD_ID_MEMBERS_V1.map((member) => [member, input[member]])));
}

/**
 * FeatureVectorBindingId binds the exact GATE23 FeatureSet a RegimeRecord consumed.
 *
 * It is the reference through which G24-BUILD-06 resolves calendarWindowBindingId:
 * GATE24 never reconstructs a CalendarWindowBinding payload, it reads the binding
 * id that the bound FeatureSet already carries.
 */
export function createFeatureVectorBinding({ featureSet }) {
  const records = featureSet?.records;
  if (!Array.isArray(records) || records.length === 0) throw new Error('FEATURE_SET_REQUIRED');
  if (records.some((record) => typeof record?.featureRecordId !== 'string' || record.featureRecordId.length === 0)) {
    throw new Error('FEATURE_SET_RECORD_INVALID');
  }
  const calendarWindowBindingIds = [...new Set(records.map((record) => record.identity?.CalendarWindowBindingId))];
  const payload = {
    schemaVersion: FEATURE_VECTOR_BINDING_VERSION,
    instrumentIdentityId: featureSet.instrumentIdentityId,
    sessionDate: featureSet.sessionDate,
    knowledgeCutoff: featureSet.knowledgeCutoff,
    datasetIdFeature: featureSet.datasetIdFeature,
    featureRecordIds: [...records.map((record) => record.featureRecordId)].sort(),
    featureWindowSpecIds: [...new Set(records.map((record) => record.featureWindowSpecId))].sort(),
    calendarWindowBindingIds: [...calendarWindowBindingIds].sort(),
  };
  if (Object.values(payload).some((value) => value === undefined || value === null)) {
    throw new Error('FEATURE_VECTOR_BINDING_INCOMPLETE');
  }
  return Object.freeze({
    ...payload,
    featureVectorBindingId: sha256Canonical(payload),
  });
}

/** Identity disclosure carried alongside every emitted RegimeRecord. */
export function describeRegimeRecordIdentity() {
  return Object.freeze({
    schemaVersion: REGIME_RECORD_IDENTITY_VERSION,
    identity: 'RegimeRecordId = sha256Canonical(orderedMembers)',
    closureRule: REGIME_RECORD_ID_CLOSURE_RULE,
    memberCount: REGIME_RECORD_ID_MEMBER_COUNT,
    orderedMembers: REGIME_RECORD_ID_MEMBERS_V1,
    forbiddenMembers: FORBIDDEN_IN_IDENTITY_DIGEST,
    canonicalization: 'governance/tools/canonical-json.mjs::sha256Canonical',
  });
}
