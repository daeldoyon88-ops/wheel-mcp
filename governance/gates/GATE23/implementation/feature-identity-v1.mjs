/**
 * GATE23 FeatureRecordId: sha256Canonical of exactly the ordered 11-member tuple.
 * closureRule is EXACT_ONLY: no optional member, no interpretable member, no
 * implicit extension, no at-minimum reading.
 *
 * The FeatureRecordId identifies the question asked, never the answer: status,
 * value and vectorStatus are excluded by construction, which is the GATE23
 * generalization of the GATE22 identity rule.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';

export const FEATURE_RECORD_IDENTITY_VERSION = 'GATE23_FeatureRecordIdentity/1';
export const FEATURE_RECORD_ID_CLOSURE_RULE = 'EXACT_ONLY';

export const FEATURE_RECORD_ID_MEMBERS_V1 = Object.freeze([
  'InstrumentIdentityId',
  'SessionDate',
  'KnowledgeCutoff',
  'FeatureDefinitionId',
  'FormulaId',
  'FeatureWindowSpecId',
  'CalendarWindowBindingId',
  'SourceBindingId',
  'DatasetId_observation',
  'PriceBasisId',
  'MissingnessStateId',
]);

export const FEATURE_RECORD_ID_MEMBER_COUNT = FEATURE_RECORD_ID_MEMBERS_V1.length;

/**
 * Members that may never enter a GATE23 identity digest: alias vocabulary, any
 * GATE22 Outcome member, and any answer-bearing field.
 */
export const FORBIDDEN_IN_IDENTITY_DIGEST = Object.freeze([
  'ticker', 'symbol', 'alias', 'temporaryAlias',
  'ObservationId', 'OutcomeId', 'OutcomeStatus', 'OutcomeMissingReason', 'OutcomeWindowCause',
  'HorizonId', 'DatasetId_outcome', 'TaxonomyVersion',
  'featureValue', 'value', 'status', 'vectorStatus',
]);

const FORBIDDEN = new Set(FORBIDDEN_IN_IDENTITY_DIGEST);

function assertExactOnly(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('FEATURE_RECORD_ID_EXACT_ONLY');
  const keys = Object.keys(input);
  if (keys.some((key) => FORBIDDEN.has(key))) throw new Error('FEATURE_RECORD_ID_FORBIDDEN_MEMBER');
  if (keys.length !== FEATURE_RECORD_ID_MEMBER_COUNT) throw new Error('FEATURE_RECORD_ID_EXACT_ONLY');
  if (FEATURE_RECORD_ID_MEMBERS_V1.some((member) => !Object.hasOwn(input, member))) throw new Error('FEATURE_RECORD_ID_EXACT_ONLY');
  if (FEATURE_RECORD_ID_MEMBERS_V1.some((member) => typeof input[member] !== 'string' || input[member].length === 0)) {
    throw new Error('FEATURE_RECORD_ID_MEMBER_INVALID');
  }
}

/** Ordered member tuple, for disclosure and evidence. */
export function featureRecordIdentityTuple(input) {
  assertExactOnly(input);
  return Object.freeze(FEATURE_RECORD_ID_MEMBERS_V1.map((member) => input[member]));
}

export function createFeatureRecordId(input) {
  assertExactOnly(input);
  return sha256Canonical(Object.fromEntries(FEATURE_RECORD_ID_MEMBERS_V1.map((member) => [member, input[member]])));
}

/** Identity disclosure carried alongside every materialized FeatureRecord. */
export function describeFeatureRecordIdentity() {
  return Object.freeze({
    schemaVersion: FEATURE_RECORD_IDENTITY_VERSION,
    identity: 'FeatureRecordId = sha256Canonical(orderedMembers)',
    closureRule: FEATURE_RECORD_ID_CLOSURE_RULE,
    memberCount: FEATURE_RECORD_ID_MEMBER_COUNT,
    orderedMembers: FEATURE_RECORD_ID_MEMBERS_V1,
    forbiddenMembers: FORBIDDEN_IN_IDENTITY_DIGEST,
  });
}
