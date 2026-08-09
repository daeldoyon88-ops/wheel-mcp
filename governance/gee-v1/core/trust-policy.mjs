/**
 * GEE V1 core — trust policy.
 * FINAL-02 support: a single, named policy for "how much trust does action X
 * require", replacing scattered `minTrustLevel: 'ANCHORED_APPEND_ONLY'`
 * literals across the adapter and CLI. Adding a new action or changing a
 * threshold happens in exactly one place.
 *
 * Binding rule (architecture 10_RECOMMENDED_ARCHITECTURE.md): closure
 * requires ANCHORED_EXTERNAL. Readiness/prerequisite satisfaction may proceed
 * at ANCHORED_APPEND_ONLY. Legacy/display reads tolerate UNANCHORED_LEGACY.
 */

import { TRUST_LEVELS, meetsTrustLevel } from './authoritative-state.mjs';

export { TRUST_LEVELS };

export const TRUST_POLICY_ACTIONS = Object.freeze([
  'READ_LEGACY_STATE',
  'READ_AUTHORITATIVE_STATE',
  'SATISFY_PREREQUISITE',
  'MODERN_FINAL_CLOSURE'
]);

const ACTION_MIN_TRUST = Object.freeze({
  READ_LEGACY_STATE: 'UNANCHORED_LEGACY',
  READ_AUTHORITATIVE_STATE: 'UNANCHORED_LEGACY',
  SATISFY_PREREQUISITE: 'ANCHORED_APPEND_ONLY',
  MODERN_FINAL_CLOSURE: 'ANCHORED_EXTERNAL'
});

export function minTrustLevelFor(action) {
  const required = ACTION_MIN_TRUST[action];
  if (!required) throw new Error(`UNKNOWN_TRUST_POLICY_ACTION:${action}`);
  return required;
}

export function isTrustSufficientFor(action, trustLevel) {
  return meetsTrustLevel(trustLevel, minTrustLevelFor(action));
}
