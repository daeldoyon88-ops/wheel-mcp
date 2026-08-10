/**
 * GEE V1 R5 routing policy: the capability vocabulary and the cost model.
 *
 * Two things are deliberately kept out of this file.
 *
 * 1. NO PROVIDER NAMES. A capability class states how much reasoning the work
 *    genuinely needs. Which agent or model serves that class is a runtime
 *    question answered by provider-adapter.mjs, so swapping providers cannot
 *    move a canonical route.
 *
 * 2. NO FABRICATED TOKENS. Cost is an ordinal class derived from the capability
 *    the work needs and from bytes that were actually measured by R2/R3/R4.
 *    Nothing here estimates a token count, and TOKEN_MEASUREMENT stays
 *    TOKEN_COUNT_UNAVAILABLE rather than being filled with a plausible number.
 */

import { sha256Canonical } from '../../tools/canonical-json.mjs';

export const ROUTER_POLICY_VERSION = 'GEE_V1_ROUTER_POLICY_R5';

/** Nothing left to do, because upstream reuse already proved the answer. */
export const NO_WORK_REQUIRED = 'NO_WORK_REQUIRED';
/** Mechanical work: hashes, manifests, canonical JSON, deterministic tests. */
export const LOCAL_DETERMINISTIC = 'LOCAL_DETERMINISTIC';
/** Bounded interpretation: a known defect, a localized diff, a focused test. */
export const STANDARD_REASONING = 'STANDARD_REASONING';
/** Exceptional: contradiction, unclear root cause, multi-layer consequence. */
export const DEEP_REASONING = 'DEEP_REASONING';
/** Genuinely a product decision, not something code or evidence can settle. */
export const OWNER_DECISION_REQUIRED = 'OWNER_DECISION_REQUIRED';
/** Cannot proceed: the inputs the work needs are missing or contained. */
export const BLOCKED = 'BLOCKED';

export const CAPABILITY_CLASSES = Object.freeze([
  NO_WORK_REQUIRED, LOCAL_DETERMINISTIC, STANDARD_REASONING, DEEP_REASONING, OWNER_DECISION_REQUIRED, BLOCKED
]);

/**
 * Escalation order. A work unit routes at the highest class any of its tasks
 * needs, so one blocked or contradictory task is never averaged away by a pile
 * of cheap deterministic ones.
 */
export const CAPABILITY_RANK = Object.freeze({
  [NO_WORK_REQUIRED]: 0,
  [LOCAL_DETERMINISTIC]: 1,
  [STANDARD_REASONING]: 2,
  [DEEP_REASONING]: 3,
  [OWNER_DECISION_REQUIRED]: 4,
  [BLOCKED]: 5
});

export const COST_CLASSES = Object.freeze(['VERY_LOW', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH']);

/** What kind of work a task is, independent of who executes it. */
export const WORK_INTENTS = Object.freeze(['DETERMINISTIC', 'SEMANTIC', 'ROOT_CAUSE_ANALYSIS', 'POLICY_DECISION']);
export const ARCHITECTURE_IMPACTS = Object.freeze(['LOCAL', 'MULTI_LAYER', 'FROZEN_LAYER']);
export const UNCERTAINTY_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const REVERSIBILITY_CLASSES = Object.freeze(['REVERSIBLE', 'IRREVERSIBLE']);

export const DEFAULT_ROUTER_POLICY = Object.freeze({
  policyVersion: ROUTER_POLICY_VERSION,
  // Base cost index per capability class, before any measured scale is added.
  capabilityBaseCost: Object.freeze({
    [NO_WORK_REQUIRED]: 0,
    [LOCAL_DETERMINISTIC]: 0,
    [STANDARD_REASONING]: 1,
    [DEEP_REASONING]: 3,
    [OWNER_DECISION_REQUIRED]: 1,
    [BLOCKED]: 0
  }),
  // Ascending byte thresholds. Each threshold a task's measured reprocess bytes
  // crosses adds one cost step, so scale comes from R3/R4 measurement rather
  // than from a guess about how big the job feels.
  scaleBytesThresholds: Object.freeze([4096, 65536]),
  // Irreversible work is worth more care even when it is small.
  irreversibleCostBump: 1,
  // Non-mandatory work above this class is reported as deferred rather than
  // routed. Mandatory validation is never subject to it.
  costCeiling: 'VERY_HIGH'
});

function fail(reason) { throw new Error(`INVALID_ROUTE_POLICY:${reason}`); }

function requireNonNegativeInteger(value, reason) {
  if (!Number.isInteger(value) || value < 0) fail(reason);
  return value;
}

/**
 * Validates and normalizes a policy. A malformed cost policy is rejected rather
 * than silently repaired with defaults: a caller who ships a broken policy must
 * find out, not receive a route computed under a policy they never wrote.
 */
export function validateRouterPolicy(policy = DEFAULT_ROUTER_POLICY) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('POLICY_OBJECT_REQUIRED');
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion) fail('POLICY_VERSION_REQUIRED');
  const base = policy.capabilityBaseCost;
  if (!base || typeof base !== 'object' || Array.isArray(base)) fail('CAPABILITY_BASE_COST_REQUIRED');
  const capabilityBaseCost = {};
  for (const capability of CAPABILITY_CLASSES) {
    if (!Object.hasOwn(base, capability)) fail(`CAPABILITY_BASE_COST_MISSING:${capability}`);
    capabilityBaseCost[capability] = requireNonNegativeInteger(base[capability], `CAPABILITY_BASE_COST_NOT_INTEGER:${capability}`);
  }
  for (const capability of Object.keys(base)) {
    if (!CAPABILITY_CLASSES.includes(capability)) fail(`UNKNOWN_CAPABILITY_CLASS:${capability}`);
  }
  const thresholds = policy.scaleBytesThresholds;
  if (!Array.isArray(thresholds) || thresholds.length === 0) fail('SCALE_BYTES_THRESHOLDS_REQUIRED');
  thresholds.forEach((threshold, index) => {
    requireNonNegativeInteger(threshold, `SCALE_BYTES_THRESHOLD_NOT_INTEGER:${index}`);
    if (index > 0 && threshold <= thresholds[index - 1]) fail(`SCALE_BYTES_THRESHOLDS_NOT_ASCENDING:${index}`);
  });
  const irreversibleCostBump = requireNonNegativeInteger(policy.irreversibleCostBump, 'IRREVERSIBLE_COST_BUMP_NOT_INTEGER');
  if (!COST_CLASSES.includes(policy.costCeiling)) fail(`UNKNOWN_COST_CEILING:${String(policy.costCeiling)}`);
  return Object.freeze({
    policyVersion: policy.policyVersion,
    capabilityBaseCost: Object.freeze(capabilityBaseCost),
    scaleBytesThresholds: Object.freeze([...thresholds]),
    irreversibleCostBump,
    costCeiling: policy.costCeiling
  });
}

export function routerPolicySha256(policy) { return sha256Canonical(validateRouterPolicy(policy)); }

/**
 * Cost class of one task: capability base, plus one step per measured byte
 * threshold crossed, plus the irreversibility bump. Clamped into COST_CLASSES.
 */
export function costClassFor({ policy, capability, reprocessBytes = 0, reversibility = 'REVERSIBLE' }) {
  if (!CAPABILITY_CLASSES.includes(capability)) throw new Error(`UNKNOWN_CAPABILITY_CLASS:${String(capability)}`);
  if (!Number.isInteger(reprocessBytes) || reprocessBytes < 0) throw new Error('REPROCESS_BYTES_MUST_BE_NON_NEGATIVE_INTEGER');
  // Work that is not going to run has no cost to classify.
  if (capability === NO_WORK_REQUIRED || capability === BLOCKED) return COST_CLASSES[0];
  const scale = policy.scaleBytesThresholds.filter((threshold) => reprocessBytes >= threshold).length;
  const bump = reversibility === 'IRREVERSIBLE' ? policy.irreversibleCostBump : 0;
  const index = policy.capabilityBaseCost[capability] + scale + bump;
  return COST_CLASSES[Math.min(index, COST_CLASSES.length - 1)];
}

export function costRank(costClass) { return COST_CLASSES.indexOf(costClass); }
export function maxCapability(a, b) { return CAPABILITY_RANK[a] >= CAPABILITY_RANK[b] ? a : b; }
