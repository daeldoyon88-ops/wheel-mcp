/**
 * GATE26 ensemble identity: D1 GATE26_ENSEMBLE_IDENTITY_V1.
 *
 * ensembleIdentityId = sha256Canonical({ schema: 'GATE26_ENSEMBLE_IDENTITY_V1', orderedMembers })
 * over exactly ten EXACT_ONLY members. The identity names the question asked, never
 * a calibrated probability, weight or outcome value.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  isCanonicalUtcInstant,
  isExactGovernedString,
  isPlainObject,
  assertClosedKeys as assertAnalogueClosedKeys,
} from '../../GATE25/implementation/analogue-identity-v1.mjs';

export const ENSEMBLE_IDENTITY_SCHEMA_V1 = 'GATE26_ENSEMBLE_IDENTITY_V1';
export const ENSEMBLE_ENGINE_VERSION_V1 = 'GATE26_PredictiveEnsembleEngine/1';
export const ENSEMBLE_IDENTITY_MEMBER_IDS_V1 = Object.freeze([
  'QueryAnalogueIdentityId',
  'KnowledgeCutoff',
  'CombinationPolicyVersionId',
  'HorizonCoverageId',
  'AnalogueSupportReportId',
  'OutcomeSetId',
  'RegimeBindingDigest',
  'DatasetId_observation',
  'EnsembleEngineVersionId',
  'MissingnessStateId',
]);
export const ENSEMBLE_IDENTITY_MEMBER_COUNT_V1 = ENSEMBLE_IDENTITY_MEMBER_IDS_V1.length;

export class Gate26FailClosedError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'Gate26FailClosedError';
    this.code = code;
    this.details = details;
  }
}

export function failClosed(code, details = {}) {
  throw new Gate26FailClosedError(code, details);
}

export function assertClosedKeys(value, keys, code, details = {}) {
  if (!isPlainObject(value)) failClosed(code, { ...details, reason: 'NOT_A_PLAIN_OBJECT' });
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    failClosed(code, { ...details, expected: [...keys], actual });
  }
  return value;
}

const FORBIDDEN = new Set([
  'probability', 'calibratedProbability', 'weight', 'weights', 'score', 'confidenceScalar',
  'ticker', 'symbol', 'alias', 'outcomeValue',
]);

function assertMemberValue(memberId, value) {
  if (!isExactGovernedString(value)) failClosed('ENSEMBLE_IDENTITY_MEMBER_NOT_EXACT', { memberId });
  if (memberId === 'KnowledgeCutoff' && !isCanonicalUtcInstant(value)) failClosed('ENSEMBLE_IDENTITY_KNOWLEDGE_CUTOFF_INVALID', { value });
  if (memberId === 'EnsembleEngineVersionId' && value !== ENSEMBLE_ENGINE_VERSION_V1) {
    failClosed('ENSEMBLE_IDENTITY_ENGINE_VERSION_INVALID', { value });
  }
}

export function buildOrderedEnsembleMembers(members) {
  if (!isPlainObject(members)) failClosed('ENSEMBLE_IDENTITY_EXACT_ONLY', { reason: 'NOT_A_PLAIN_OBJECT' });
  const keys = Object.keys(members);
  const forbidden = keys.find((key) => FORBIDDEN.has(key) || (key !== 'OutcomeSetId' && /^outcome/i.test(key)));
  if (forbidden !== undefined) failClosed('ENSEMBLE_IDENTITY_FORBIDDEN_MEMBER', { key: forbidden });
  if (keys.length !== ENSEMBLE_IDENTITY_MEMBER_COUNT_V1
    || ENSEMBLE_IDENTITY_MEMBER_IDS_V1.some((member) => !Object.hasOwn(members, member))) {
    failClosed('ENSEMBLE_IDENTITY_EXACT_ONLY', {
      missing: ENSEMBLE_IDENTITY_MEMBER_IDS_V1.filter((member) => !Object.hasOwn(members, member)),
      extra: keys.filter((key) => !ENSEMBLE_IDENTITY_MEMBER_IDS_V1.includes(key)),
    });
  }
  for (const memberId of ENSEMBLE_IDENTITY_MEMBER_IDS_V1) assertMemberValue(memberId, members[memberId]);
  return Object.freeze(ENSEMBLE_IDENTITY_MEMBER_IDS_V1.map((memberId) => Object.freeze({ memberId, value: members[memberId] })));
}

export function createEnsembleIdentity(members) {
  const orderedMembers = buildOrderedEnsembleMembers(members);
  return Object.freeze({
    schema: ENSEMBLE_IDENTITY_SCHEMA_V1,
    orderedMembers,
    ensembleIdentityId: sha256Canonical({ schema: ENSEMBLE_IDENTITY_SCHEMA_V1, orderedMembers }),
  });
}

export function verifyEnsembleIdentity({ ensembleIdentityId, orderedMembers }) {
  if (!Array.isArray(orderedMembers) || orderedMembers.length !== ENSEMBLE_IDENTITY_MEMBER_COUNT_V1) {
    failClosed('ENSEMBLE_IDENTITY_EXACT_ONLY', { reason: 'ORDERED_MEMBERS_CARDINALITY' });
  }
  orderedMembers.forEach((entry, index) => {
    assertAnalogueClosedKeys(entry, ['memberId', 'value'], 'ENSEMBLE_IDENTITY_ORDERED_MEMBER_NOT_CLOSED', { index });
    if (entry.memberId !== ENSEMBLE_IDENTITY_MEMBER_IDS_V1[index]) {
      failClosed('ENSEMBLE_IDENTITY_MEMBER_REORDER_FORBIDDEN', { index, memberId: entry.memberId });
    }
  });
  const rebuilt = createEnsembleIdentity(Object.fromEntries(orderedMembers.map((entry) => [entry.memberId, entry.value])));
  if (rebuilt.ensembleIdentityId !== ensembleIdentityId) failClosed('ENSEMBLE_IDENTITY_DIGEST_MISMATCH');
  return rebuilt;
}

export function horizonCoverageId(sessionCounts) {
  return sha256Canonical({ coverage: 'ALL_AND_ONLY', sessionCounts: [...sessionCounts] });
}
