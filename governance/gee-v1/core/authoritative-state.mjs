/**
 * GEE V1 core — authoritative state.
 * RC-2/RC-6 support: status is never a bare scalar. There is no raw-status
 * accessor contract in this module — every decision must go through
 * requireVerifiedState, which forces verified:false to UNKNOWN and demands
 * identity binding + a sufficient trust level before a value can satisfy
 * anything.
 */

export const TRUST_LEVELS = Object.freeze(['BROKEN', 'UNANCHORED_LEGACY', 'ANCHORED_APPEND_ONLY', 'ANCHORED_EXTERNAL']);
const RANK = new Map(TRUST_LEVELS.map((level, index) => [level, index]));

export function trustLevelRank(level) {
  return RANK.has(level) ? RANK.get(level) : -1;
}

export function meetsTrustLevel(actual, required) {
  return trustLevelRank(actual) >= trustLevelRank(required);
}

/**
 * @param {{
 *   value: string, verified: boolean, trustLevel: string,
 *   authority?: {kind:string, ref:string, sha256?:string},
 *   evidenceRef?: string[], identityBinding: 'BOUND'|'VIOLATION'
 * }} input
 */
export function createAuthoritativeState({ value, verified, trustLevel, authority = null, evidenceRef = [], identityBinding }) {
  const isVerified = verified === true;
  return Object.freeze({
    value: isVerified ? value : 'UNKNOWN',
    verified: isVerified,
    trustLevel: TRUST_LEVELS.includes(trustLevel) ? trustLevel : 'BROKEN',
    authority: authority && typeof authority === 'object' ? Object.freeze({ ...authority }) : null,
    evidenceRef: Object.freeze(Array.isArray(evidenceRef) ? [...evidenceRef] : []),
    identityBinding: identityBinding === 'BOUND' ? 'BOUND' : 'VIOLATION'
  });
}

/**
 * The sanctioned way to turn an AuthoritativeState into a decision.
 * verified !== true -> UNSATISFIED (value is already forced to UNKNOWN).
 * identityBinding !== BOUND -> UNSATISFIED, regardless of value.
 * trustLevel below required -> UNSATISFIED.
 * value not in allow -> UNSATISFIED.
 */
export function requireVerifiedState(state, { allow = [], minTrustLevel = 'ANCHORED_APPEND_ONLY' } = {}) {
  if (!state || typeof state !== 'object') {
    return { satisfied: false, value: 'UNKNOWN', reason: 'STATE_ABSENT' };
  }
  if (state.verified !== true) {
    return { satisfied: false, value: 'UNKNOWN', reason: 'NOT_VERIFIED' };
  }
  if (state.identityBinding !== 'BOUND') {
    return { satisfied: false, value: 'UNKNOWN', reason: 'IDENTITY_NOT_BOUND' };
  }
  if (!meetsTrustLevel(state.trustLevel, minTrustLevel)) {
    return { satisfied: false, value: state.value, reason: `TRUST_LEVEL_BELOW_REQUIRED:${state.trustLevel}<${minTrustLevel}` };
  }
  if (!Array.isArray(allow) || !allow.includes(state.value)) {
    return { satisfied: false, value: state.value, reason: `VALUE_NOT_IN_ALLOWLIST:${state.value}` };
  }
  return { satisfied: true, value: state.value, reason: null };
}
