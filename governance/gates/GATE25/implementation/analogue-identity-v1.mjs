/**
 * GATE25 analogue identity: D1 GATE25_ANALOGUE_IDENTITY_V1.
 *
 * analogueIdentityId = sha256Canonical({ schema: 'GATE25_ANALOGUE_IDENTITY_V1', orderedMembers })
 * where orderedMembers is the closed array of exactly the eleven OD-3 members in
 * OD-3 order, each entry { memberId, value }.
 *
 * closureRule is EXACT_ONLY: no reorder, no omitted-member default, no additional
 * member, no alias backdating, no fuzzy identity. The identity names the question
 * asked, never the answer: distances, rankings, the analogue set, outcomes and
 * regime values are refused before digesting.
 *
 * Determinism: no random source, no wall clock, no ambient state.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { isStrictUtcIsoInstant } from '../../../../research/directional-lab/src/contracts/dailyBarV1.mjs';
import { isValidCivilDate } from '../../../../research/directional-lab/src/time/civilDate.mjs';

export const ANALOGUE_IDENTITY_SCHEMA_V1 = 'GATE25_ANALOGUE_IDENTITY_V1';
export const ANALOGUE_IDENTITY_SERIALIZATION_V1 = 'CanonicalJSON/1';
export const ANALOGUE_IDENTITY_CLOSURE_RULE = 'EXACT_ONLY';

/** OD-3: exactly these eleven members, in exactly this order. */
export const ANALOGUE_IDENTITY_MEMBERS_V1 = Object.freeze([
  'InstrumentIdentityId',
  'SessionDate',
  'KnowledgeCutoff',
  'FeatureVectorBindingId',
  'RegimeRecordId',
  'RegimeHorizonSpecId',
  'MacroContextBindingId',
  'SelectionPolicyVersionId',
  'EligibleHistoryPinSetId',
  'PriceBasisId',
  'MissingnessStateId',
]);
export const ANALOGUE_IDENTITY_MEMBER_COUNT = ANALOGUE_IDENTITY_MEMBERS_V1.length;

/** OD-3: SPLIT_ADJUSTED only. */
export const ADMISSIBLE_PRICE_BASIS_ID_V1 = 'SPLIT_ADJUSTED';

/** OD-3 forbiddenInIdentityDigest, as input keys. Any key starting with Outcome is refused too. */
export const FORBIDDEN_IDENTITY_KEYS_V1 = Object.freeze([
  'ticker', 'symbol', 'alias', 'temporaryAlias', 'providerSymbol', 'canonicalSymbol',
  'HorizonId', 'horizonId', 'DatasetId_outcome',
  'distance', 'distances', 'finalDistance', 'distanceComponents', 'differences',
  'rank', 'ranking', 'rankings', 'analogues', 'analogueSet',
  'classificationQuality', 'regimeVector',
  'primaryMarketRegime', 'volatilityState', 'inflationState', 'ratesState', 'yieldCurveShape', 'yieldCurveDirection',
]);
const FORBIDDEN_KEYS = new Set(FORBIDDEN_IDENTITY_KEYS_V1);

/** GATE23/GATE24 module precedent: a versioned, closed missingness vocabulary. */
export const MISSINGNESS_STATE_VERSION = 'GATE25_MissingnessState/1';
export const MISSINGNESS_STATES_V1 = Object.freeze({
  DISTANCE_FEATURE_INCOMPLETE: 'DISTANCE_FEATURE_INCOMPLETE',
  VOLATILITY_STATE_UNAVAILABLE: 'VOLATILITY_STATE_UNAVAILABLE',
  COMPLETE: 'COMPLETE',
});
export const missingnessStateId = (state) => {
  if (!Object.values(MISSINGNESS_STATES_V1).includes(state)) failClosed('MISSINGNESS_STATE_NOT_DECLARED', { state });
  return `${MISSINGNESS_STATE_VERSION}:${state}`;
};

/** First match wins, in declaration order. */
export function resolveMissingnessState({ distanceFeaturesComplete, volatilityStateClassifying }) {
  if (distanceFeaturesComplete !== true) return MISSINGNESS_STATES_V1.DISTANCE_FEATURE_INCOMPLETE;
  if (volatilityStateClassifying !== true) return MISSINGNESS_STATES_V1.VOLATILITY_STATE_UNAVAILABLE;
  return MISSINGNESS_STATES_V1.COMPLETE;
}

/** Every GATE25 refusal carries an explicit code; nothing degrades silently. */
export class Gate25FailClosedError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'Gate25FailClosedError';
    this.code = code;
    this.details = details;
  }
}

export function failClosed(code, details = {}) {
  throw new Gate25FailClosedError(code, details);
}

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

/** Closed-schema check: exactly the declared keys, no more, no fewer. */
export function assertClosedKeys(value, keys, code, details = {}) {
  if (!isPlainObject(value)) failClosed(code, { ...details, reason: 'NOT_A_PLAIN_OBJECT' });
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    failClosed(code, { ...details, expected: [...keys], actual });
  }
  return value;
}

export const isCanonicalSessionDate = (value) => isValidCivilDate(value);
export const isCanonicalUtcInstant = (value) => isStrictUtcIsoInstant(value);

/** Numeric instant for causal comparison; an unparseable instant fails closed. */
export function instantMs(value, code = 'UTC_INSTANT_INVALID') {
  if (!isCanonicalUtcInstant(value)) failClosed(code, { value });
  return Date.parse(value);
}

/** An exact governed string: no normalization is ever applied on the way in. */
export function isExactGovernedString(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && value === value.normalize('NFC');
}

function assertMemberValue(memberId, value) {
  if (!isExactGovernedString(value)) failClosed('ANALOGUE_IDENTITY_MEMBER_NOT_EXACT', { memberId });
  if (memberId === 'SessionDate' && !isCanonicalSessionDate(value)) failClosed('ANALOGUE_IDENTITY_SESSION_DATE_INVALID', { value });
  if (memberId === 'KnowledgeCutoff' && !isCanonicalUtcInstant(value)) failClosed('ANALOGUE_IDENTITY_KNOWLEDGE_CUTOFF_INVALID', { value });
  if (memberId === 'PriceBasisId' && value !== ADMISSIBLE_PRICE_BASIS_ID_V1) failClosed('ANALOGUE_IDENTITY_PRICE_BASIS_NOT_ADMITTED', { value });
}

function assertExactOnlyMembers(members) {
  if (!isPlainObject(members)) failClosed('ANALOGUE_IDENTITY_EXACT_ONLY', { reason: 'NOT_A_PLAIN_OBJECT' });
  const keys = Object.keys(members);
  const forbidden = keys.find((key) => FORBIDDEN_KEYS.has(key) || /^outcome/i.test(key));
  if (forbidden !== undefined) failClosed('ANALOGUE_IDENTITY_FORBIDDEN_MEMBER', { key: forbidden });
  if (keys.length !== ANALOGUE_IDENTITY_MEMBER_COUNT
    || ANALOGUE_IDENTITY_MEMBERS_V1.some((member) => !Object.hasOwn(members, member))) {
    failClosed('ANALOGUE_IDENTITY_EXACT_ONLY', {
      missing: ANALOGUE_IDENTITY_MEMBERS_V1.filter((member) => !Object.hasOwn(members, member)),
      extra: keys.filter((key) => !ANALOGUE_IDENTITY_MEMBERS_V1.includes(key)),
    });
  }
  for (const member of ANALOGUE_IDENTITY_MEMBERS_V1) assertMemberValue(member, members[member]);
}

/** OD-3 ordered array; array order is significant under CanonicalJSON/1. */
export function buildOrderedMembers(members) {
  assertExactOnlyMembers(members);
  return Object.freeze(ANALOGUE_IDENTITY_MEMBERS_V1.map((memberId) => Object.freeze({ memberId, value: members[memberId] })));
}

export function createAnalogueIdentity(members) {
  const orderedMembers = buildOrderedMembers(members);
  return Object.freeze({
    schema: ANALOGUE_IDENTITY_SCHEMA_V1,
    orderedMembers,
    analogueIdentityId: sha256Canonical({ schema: ANALOGUE_IDENTITY_SCHEMA_V1, orderedMembers }),
  });
}

/** Re-verifies a persisted identity: exact OD-3 order, closed entries, recomputed digest. */
export function verifyAnalogueIdentity({ analogueIdentityId, orderedMembers }) {
  if (!Array.isArray(orderedMembers) || orderedMembers.length !== ANALOGUE_IDENTITY_MEMBER_COUNT) {
    failClosed('ANALOGUE_IDENTITY_EXACT_ONLY', { reason: 'ORDERED_MEMBERS_CARDINALITY' });
  }
  orderedMembers.forEach((entry, index) => {
    assertClosedKeys(entry, ['memberId', 'value'], 'ANALOGUE_IDENTITY_ORDERED_MEMBER_NOT_CLOSED', { index });
    if (entry.memberId !== ANALOGUE_IDENTITY_MEMBERS_V1[index]) {
      failClosed('ANALOGUE_IDENTITY_MEMBER_REORDER_FORBIDDEN', { index, memberId: entry.memberId });
    }
  });
  const rebuilt = createAnalogueIdentity(Object.fromEntries(orderedMembers.map((entry) => [entry.memberId, entry.value])));
  if (rebuilt.analogueIdentityId !== analogueIdentityId) failClosed('ANALOGUE_IDENTITY_DIGEST_MISMATCH', { analogueIdentityId });
  return rebuilt;
}

export function identityMemberValue(orderedMembers, memberId) {
  const index = ANALOGUE_IDENTITY_MEMBERS_V1.indexOf(memberId);
  if (index < 0) failClosed('ANALOGUE_IDENTITY_MEMBER_UNKNOWN', { memberId });
  return orderedMembers[index].value;
}

/**
 * R0003 identityPolicy: RESOLVE_AT_EACH_HISTORICAL_SESSION_DATE, aliasBackdating
 * FORBIDDEN. A resolution is matchable only when it was performed at the exact
 * session date it is used for; a present-day identity projected onto an earlier
 * session is alias backdating and is never matchable.
 */
export const INSTRUMENT_IDENTITY_RESOLUTION_STATUSES_V1 = Object.freeze(['RESOLVED', 'UNRESOLVED']);

export function readHistoricalInstrumentIdentity({ resolution, sessionDate }) {
  if (!isPlainObject(resolution)) failClosed('INSTRUMENT_IDENTITY_RESOLUTION_REQUIRED');
  if (resolution.status === 'RESOLVED') {
    assertClosedKeys(resolution, ['status', 'instrumentIdentityId', 'resolvedAsOfSessionDate'], 'INSTRUMENT_IDENTITY_RESOLUTION_NOT_CLOSED');
    if (!isExactGovernedString(resolution.instrumentIdentityId)) failClosed('INSTRUMENT_IDENTITY_ID_NOT_EXACT');
  } else if (resolution.status === 'UNRESOLVED') {
    assertClosedKeys(resolution, ['status', 'code', 'resolvedAsOfSessionDate'], 'INSTRUMENT_IDENTITY_RESOLUTION_NOT_CLOSED');
    if (!isExactGovernedString(resolution.code)) failClosed('INSTRUMENT_IDENTITY_UNRESOLVED_CODE_REQUIRED');
  } else {
    failClosed('INSTRUMENT_IDENTITY_RESOLUTION_STATUS_INVALID', { status: resolution.status });
  }
  if (!isCanonicalSessionDate(resolution.resolvedAsOfSessionDate)) failClosed('INSTRUMENT_IDENTITY_RESOLUTION_DATE_INVALID');
  if (resolution.status === 'UNRESOLVED') {
    return Object.freeze({ matchable: false, instrumentIdentityId: null, code: resolution.code });
  }
  if (resolution.resolvedAsOfSessionDate !== sessionDate) {
    return Object.freeze({ matchable: false, instrumentIdentityId: null, code: 'ALIAS_BACKDATING_FORBIDDEN' });
  }
  return Object.freeze({ matchable: true, instrumentIdentityId: resolution.instrumentIdentityId, code: null });
}

export function describeAnalogueIdentity() {
  return Object.freeze({
    schema: ANALOGUE_IDENTITY_SCHEMA_V1,
    serialization: ANALOGUE_IDENTITY_SERIALIZATION_V1,
    identity: "analogueIdentityId = sha256Canonical({ schema: 'GATE25_ANALOGUE_IDENTITY_V1', orderedMembers })",
    closureRule: ANALOGUE_IDENTITY_CLOSURE_RULE,
    memberCount: ANALOGUE_IDENTITY_MEMBER_COUNT,
    orderedMembers: ANALOGUE_IDENTITY_MEMBERS_V1,
    forbiddenKeys: FORBIDDEN_IDENTITY_KEYS_V1,
    missingnessStateVersion: MISSINGNESS_STATE_VERSION,
    aliasBackdating: 'FORBIDDEN',
    fuzzyIdentity: 'FORBIDDEN',
  });
}
