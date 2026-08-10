/**
 * GEE V1 R5 provider mapping: the deliberately non-canonical half of routing.
 *
 * The canonical route says a task needs DEEP_REASONING. It does not say "Opus",
 * because which agent is strongest, cheapest or even reachable is a fact about
 * this week's infrastructure, not about the work. Keeping that fact out here
 * means the two things that would otherwise be confused stay separable:
 *
 *   - swapping every provider name leaves routeSha256 byte-identical;
 *   - a provider being unavailable degrades EXECUTION, never route semantics.
 *
 * This module is also the EXECUTION BOUNDARY, which imposes two obligations the
 * canonical router does not have.
 *
 * 1. IT MUST HONOUR `deferred`. A deferred task is the cost ceiling saying "not
 *    now". Handing it a provider anyway would let the pipeline claim a task is
 *    both postponed and assigned, which quietly cancels the ceiling.
 *
 * 2. IT MUST NOT EXECUTE A DOCUMENT THAT IS NOT A ROUTE PLAN. Anything with a
 *    `tasks` array used to be enough. Now the plan is checked against the R5
 *    route-plan schema and its own recorded digest before a single provider is
 *    handed out.
 *
 * On what that digest does and does not prove: verifyRoutePlanDigest() shows
 * only that the plan was not edited without recomputing its digest. It
 * authenticates nobody, and nothing here should be read as claiming otherwise.
 * The point is deterministic execution correctness — a corrupted or half-edited
 * plan must not be dispatched — not defence against a hostile author.
 *
 * The dependency runs one way only: this file imports router-engine, and
 * router-engine imports nothing from here. Nothing this module returns is
 * folded back into the plan; resolveProviders() takes a finished plan and
 * returns a separate assignment document.
 */

import { CAPABILITY_CLASSES, BLOCKED, NO_WORK_REQUIRED, OWNER_DECISION_REQUIRED } from './router-policy.mjs';
import { validateRoutePlan, verifyRoutePlanDigest } from './router-engine.mjs';

export const PROVIDER_MAPPING_KIND = 'GEE_PROVIDER_MAPPING';
export const PROVIDER_ASSIGNMENT_KIND = 'GEE_PROVIDER_ASSIGNMENT';

/** Nothing runs, or the thing that runs is a person. Reported, not assigned. */
export const NO_PROVIDER_REQUIRED = 'NO_PROVIDER_REQUIRED';
/** The route says not now. Intentionally unassigned, and NOT an execution failure. */
export const DEFERRED_NO_ASSIGNMENT = 'DEFERRED_NO_ASSIGNMENT';
export const ASSIGNED = 'ASSIGNED';
/** Active work whose capability class has no provider in this mapping. */
export const PROVIDER_UNMAPPED = 'PROVIDER_UNMAPPED';
/** Active work whose mapped provider is not currently reachable. */
export const PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE';

/**
 * Capability classes that never need a provider: nothing executes for them, or
 * the executor is the owner.
 */
const UNASSIGNED_CAPABILITIES = Object.freeze([NO_WORK_REQUIRED, BLOCKED, OWNER_DECISION_REQUIRED]);

/**
 * The owner's current preference, expressed as replaceable data rather than as
 * code: deterministic work runs locally, bounded work goes to a lower-cost
 * capable agent, and only genuine architecture difficulty reaches the strongest
 * one. Any of these names can change without touching a canonical route.
 */
export const DEFAULT_PROVIDER_MAPPING = Object.freeze({
  LOCAL_DETERMINISTIC: 'local-deterministic-tooling',
  STANDARD_REASONING: 'lower-cost-capable-agent',
  DEEP_REASONING: 'strongest-reasoning-agent'
});

export function createProviderMapping({ mappings = DEFAULT_PROVIDER_MAPPING, available = null } = {}) {
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error('PROVIDER_MAPPING_REQUIRED');
  for (const [capability, provider] of Object.entries(mappings)) {
    if (!CAPABILITY_CLASSES.includes(capability)) throw new Error(`UNKNOWN_CAPABILITY_CLASS:${capability}`);
    if (typeof provider !== 'string' || !provider) throw new Error(`INVALID_PROVIDER_NAME:${capability}`);
  }
  if (available !== null && !Array.isArray(available)) throw new Error('PROVIDER_AVAILABILITY_MUST_BE_ARRAY');
  return Object.freeze({
    kind: PROVIDER_MAPPING_KIND,
    mappings: Object.freeze({ ...mappings }),
    // null means "availability unknown, do not pretend to check it".
    available: available === null ? null : Object.freeze([...available])
  });
}

/**
 * Structural and integrity gate for the execution boundary. Reuses the R5
 * schema and the R5 digest verifier rather than inventing a second notion of
 * what a route plan is.
 */
function assertExecutableRoutePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('ROUTE_PLAN_REQUIRED');
  const validation = validateRoutePlan(plan);
  if (!validation.valid) {
    const [first] = validation.errors;
    throw new Error(`INVALID_ROUTE_PLAN:${first.jsonPointer || '/'}:${first.reason}`);
  }
  // Throws INVALID_ROUTE_PLAN_DIGEST. Detects an edited or truncated plan; it
  // says nothing about who produced it.
  verifyRoutePlanDigest(plan);
  return plan;
}

function assignmentFor(task, mapping) {
  // Deferral is checked before capability, because "do not run this now" holds
  // whatever the task would otherwise have needed.
  if (task.deferred === true) return { taskId: task.taskId, capability: task.capability, provider: null, status: DEFERRED_NO_ASSIGNMENT };
  if (UNASSIGNED_CAPABILITIES.includes(task.capability)) return { taskId: task.taskId, capability: task.capability, provider: null, status: NO_PROVIDER_REQUIRED };
  const provider = mapping.mappings[task.capability] || null;
  if (!provider) return { taskId: task.taskId, capability: task.capability, provider: null, status: PROVIDER_UNMAPPED };
  if (mapping.available && !mapping.available.includes(provider)) {
    // Runtime degradation only. The canonical route still says this task needs
    // this capability; what is missing is somebody to run it.
    return { taskId: task.taskId, capability: task.capability, provider, status: PROVIDER_UNAVAILABLE };
  }
  return { taskId: task.taskId, capability: task.capability, provider, status: ASSIGNED };
}

/**
 * Assigns providers to a finished plan. The plan is read, never modified: the
 * returned document is separate, and `routeSha256` is echoed only so a caller
 * can prove which canonical route an assignment belongs to.
 *
 * `executable` means exactly one thing: every task the route says should run
 * NOW has a provider to run it. Deferred tasks are excluded by design and can
 * never make it false — a plan whose only outstanding work is deferred is
 * executable and has nothing to execute, which is why `deferred` is reported
 * separately rather than folded into `unresolved`.
 */
export function resolveProviders(plan, mapping) {
  assertExecutableRoutePlan(plan);
  if (!mapping || mapping.kind !== PROVIDER_MAPPING_KIND) throw new Error('PROVIDER_MAPPING_REQUIRED');
  const assignments = plan.tasks.map((task) => assignmentFor(task, mapping));
  const idsWithStatus = (...statuses) => assignments.filter((assignment) => statuses.includes(assignment.status)).map((assignment) => assignment.taskId);
  const unresolved = idsWithStatus(PROVIDER_UNAVAILABLE, PROVIDER_UNMAPPED);
  return {
    kind: PROVIDER_ASSIGNMENT_KIND,
    routeSha256: plan.routeSha256,
    assignments,
    assigned: idsWithStatus(ASSIGNED),
    deferred: idsWithStatus(DEFERRED_NO_ASSIGNMENT),
    unresolved,
    executable: unresolved.length === 0
  };
}
