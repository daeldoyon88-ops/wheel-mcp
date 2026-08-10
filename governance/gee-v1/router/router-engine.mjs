/**
 * GEE V1 R5 router.
 *
 * R5 does not decide what is true; R2, R3 and R4 already do. R5 decides WHAT
 * STILL HAS TO BE DONE and HOW MUCH CAPABILITY that work honestly needs. It is
 * the layer that turns "these three sources changed and these eleven evidence
 * nodes are still reusable" into "run two deterministic checks, revalidate one
 * node, and stop pretending the rest is work".
 *
 * Four properties hold it together:
 *
 * 1. IT VERIFIES ITS OWN INPUTS. A caller hands over R3 snapshots and an R4
 *    graph, not conclusions about them: the delta is recomputed with R3's own
 *    compareSnapshots() and the graph is re-evaluated with R4's own
 *    evaluateEvidenceGraph(). A caller-attached claim about either is compared
 *    against the recomputation and rejected on any disagreement, so a route can
 *    never be cheap because someone said the work was already done.
 *
 * 2. THE QUALITY FLOOR IS EVALUATED FIRST. Missing, removed or unresolvable
 *    evidence blocks a task before any reuse, cheapness or cost-ceiling rule is
 *    allowed to speak. Cost is a tiebreaker among admissible routes; it is
 *    never a reason to skip a mandatory validation.
 *
 * 3. CAPABILITY, NOT PROVIDER. Canonical routing selects a capability class.
 *    Which agent serves that class lives in provider-adapter.mjs and is applied
 *    to a finished plan, so replacing a provider cannot move routeSha256.
 *
 * 4. NOTHING AMBIENT. No clock, no randomness, no locale-sensitive ordering, no
 *    absolute path and no provider availability enters the plan, so identical
 *    canonical inputs always produce the identical route digest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import { compareSnapshots } from '../delta/delta-engine.mjs';
import { evaluateEvidenceGraph } from '../evidence/evidence-graph.mjs';
import {
  ARCHITECTURE_IMPACTS, BLOCKED, CAPABILITY_RANK, DEEP_REASONING, DEFAULT_ROUTER_POLICY, LOCAL_DETERMINISTIC,
  NO_WORK_REQUIRED, OWNER_DECISION_REQUIRED, REVERSIBILITY_CLASSES, STANDARD_REASONING, UNCERTAINTY_LEVELS,
  WORK_INTENTS, costClassFor, costRank, maxCapability, routerPolicySha256, validateRouterPolicy
} from './router-policy.mjs';
import { createRepairLedger, evaluateContainment, matchesResolutionAssertion, verifyRepairLedger } from '../repair/repair-containment.mjs';

export const ROUTER_VERSION = 'GEE_V1_ROUTER_R5';
export const ROUTE_PLAN_KIND = 'GEE_ROUTE_PLAN';

/**
 * R5 has no measured token counter, so it states that rather than deriving a
 * plausible-looking number from bytes. Every quantity the plan does report is
 * something R2, R3 or R4 actually measured.
 */
export const TOKEN_MEASUREMENT = 'TOKEN_COUNT_UNAVAILABLE';

/**
 * Fields a caller may not supply. Ignoring them silently would leave the caller
 * believing their instruction was honoured, so a task carrying any of them is
 * rejected outright: the route is the engine's output, never its input.
 */
const CALLER_FORBIDDEN_TASK_FIELDS = Object.freeze([
  'capability', 'routeDecision', 'costClass', 'reasonCodes', 'route', 'deferred', 'containmentState'
]);

/**
 * R4 invalidation reasons that no amount of revalidation work can clear,
 * because the thing the evidence rested on is gone rather than merely changed.
 * Every OTHER invalidation is recoverable — it is pending work, not a dead end.
 */
const UNRESOLVABLE_EVIDENCE_REASONS = Object.freeze([
  'DIRECT_SOURCE_REMOVED', 'PROVENANCE_SOURCE_REMOVED', 'MISSING_REQUIRED_EVIDENCE',
  'DEPENDENCY_UNTRACKED', 'PROVENANCE_SOURCE_UNTRACKED', 'DEPENDENCY_CYCLE'
]);

function compareIdentifiers(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function sortedUnique(values) { return [...new Set(values)].sort(compareIdentifiers); }

function canonicalIdentifier(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field}_REQUIRED`);
  if (value !== value.normalize('NFC')) throw new Error(`NON_CANONICAL_${field}:${value}`);
  return value;
}

function requireEnum(value, allowed, field, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (!allowed.includes(resolved)) throw new Error(`INVALID_${field}:${String(value)}`);
  return resolved;
}

/* -------------------------------------------------------------------------
 * Input verification. Each of these re-derives the upstream result instead of
 * reading a field, and wraps failures in a reason code naming the layer.
 * ---------------------------------------------------------------------- */

/**
 * Accepts either compileContext()'s return value or the bundle itself, and
 * proves it really is an R2 bundle that still declares itself non-authoritative.
 */
function verifyR2Context(r2Context) {
  const bundle = r2Context && typeof r2Context === 'object' && r2Context.json ? r2Context.json : r2Context;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('INVALID_R2_INPUT:CONTEXT_REQUIRED');
  if (bundle.bundleKind !== 'GEE_CONTEXT_BUNDLE') throw new Error('INVALID_R2_INPUT:NOT_A_CONTEXT_BUNDLE');
  if (bundle.authorityDeclaration !== 'DERIVED / NON_AUTHORITATIVE') throw new Error('INVALID_R2_INPUT:R2_CONTEXT_MUST_REMAIN_NON_AUTHORITATIVE');
  if (typeof bundle.identity?.compilerVersion !== 'string' || !bundle.identity.compilerVersion.startsWith('GEE_V1_CONTEXT_COMPILER_R2')) throw new Error('INVALID_R2_INPUT:UNKNOWN_COMPILER');
  if (!Array.isArray(bundle.relevantSources) || !bundle.relevantSources.length) throw new Error('INVALID_R2_INPUT:NO_RELEVANT_SOURCES');
  if (!Array.isArray(bundle.facts)) throw new Error('INVALID_R2_INPUT:NO_FACTS');
  return { bundle, contextSha256: sha256Canonical(bundle) };
}

/**
 * Recomputes the delta from the snapshots. A caller-supplied `deltas` array is
 * only ever used as a claim to check: if it disagrees with the recomputation,
 * the input is fabricated and the route stops here.
 */
function verifyR3Delta(r3Delta) {
  if (!r3Delta || typeof r3Delta !== 'object' || !r3Delta.previousSnapshot || !r3Delta.currentSnapshot) throw new Error('INVALID_R3_INPUT:R3_SNAPSHOTS_REQUIRED');
  let verified;
  try {
    verified = compareSnapshots({ previous: r3Delta.previousSnapshot, current: r3Delta.currentSnapshot });
  } catch (error) {
    throw new Error(`INVALID_R3_INPUT:${error.message}`);
  }
  if (r3Delta.deltas !== undefined && sha256Canonical(r3Delta.deltas) !== sha256Canonical(verified.deltas)) {
    throw new Error('FABRICATED_R3_DELTA');
  }
  return {
    verified,
    snapshots: { previousSnapshot: r3Delta.previousSnapshot, currentSnapshot: r3Delta.currentSnapshot },
    deltaSha256: sha256Canonical({
      previousSnapshotSha256: r3Delta.previousSnapshot.snapshotSha256,
      currentSnapshotSha256: r3Delta.currentSnapshot.snapshotSha256,
      deltas: verified.deltas
    })
  };
}

/**
 * Re-runs R4's evaluation over the supplied graph. Whatever evaluation metadata
 * or reusable list the caller attached is treated as a claim and compared, so
 * an "already evaluated, all reusable" graph cannot walk in unverified.
 */
function verifyR4Evidence(r4Evidence, snapshots, cas) {
  if (!r4Evidence || typeof r4Evidence !== 'object' || Array.isArray(r4Evidence)) throw new Error('INVALID_R4_INPUT:R4_EVIDENCE_REQUIRED');
  if (!r4Evidence.graph) throw new Error('INVALID_R4_INPUT:EVIDENCE_GRAPH_REQUIRED');
  let evaluated;
  try {
    evaluated = evaluateEvidenceGraph({ graph: r4Evidence.graph, previousGraph: r4Evidence.previousGraph || null, r3Delta: snapshots, cas });
  } catch (error) {
    throw new Error(`INVALID_R4_INPUT:${error.message}`);
  }
  const observedReusable = sortedUnique(evaluated.reusableNodes.map((node) => node.evidenceId));
  if (r4Evidence.reusableNodes !== undefined) {
    const claimed = sortedUnique((r4Evidence.reusableNodes || []).map((node) => (typeof node === 'string' ? node : node?.evidenceId)));
    if (sha256Canonical(claimed) !== sha256Canonical(observedReusable)) throw new Error('FABRICATED_R4_EVALUATION');
  }
  if (r4Evidence.metrics !== undefined && sha256Canonical(r4Evidence.metrics) !== sha256Canonical(evaluated.metrics)) {
    throw new Error('FABRICATED_R4_EVALUATION');
  }
  return evaluated;
}

/* -------------------------------------------------------------------------
 * Task normalization
 * ---------------------------------------------------------------------- */

function normalizeRepair(repair, taskId) {
  if (repair === undefined || repair === null) return null;
  if (typeof repair !== 'object' || Array.isArray(repair)) throw new Error(`INVALID_TASK_REPAIR:${taskId}`);
  return {
    defectId: canonicalIdentifier(repair.defectId, 'DEFECT_ID'),
    rootCauseClass: canonicalIdentifier(repair.rootCauseClass, 'ROOT_CAUSE_CLASS'),
    // An incremental repair is a targeted patch against a known root cause and
    // is what containment counts. A structural fix declares incremental:false.
    incremental: repair.incremental !== false
  };
}

function normalizeTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('ROUTE_TASK_REQUIRED');
  for (const field of CALLER_FORBIDDEN_TASK_FIELDS) {
    if (Object.hasOwn(task, field)) throw new Error(`CALLER_SUPPLIED_ROUTE_DECISION_FORBIDDEN:${field}`);
  }
  const taskId = canonicalIdentifier(task.taskId, 'TASK_ID');
  const contradiction = task.contradiction === undefined || task.contradiction === null || task.contradiction === false
    ? null
    : typeof task.contradiction === 'object' && !Array.isArray(task.contradiction)
      ? { statement: canonicalIdentifier(task.contradiction.statement, 'CONTRADICTION_STATEMENT'), sources: sortedUnique((task.contradiction.sources || []).map((entry) => canonicalIdentifier(entry, 'CONTRADICTION_SOURCE'))) }
      : (() => { throw new Error(`INVALID_TASK_CONTRADICTION:${taskId}`); })();
  return {
    taskId,
    intent: requireEnum(task.intent, WORK_INTENTS, 'TASK_INTENT'),
    description: typeof task.description === 'string' ? task.description.normalize('NFC') : null,
    sources: sortedUnique((task.sources || []).map((entry) => canonicalIdentifier(entry, 'TASK_SOURCE'))),
    requiredEvidenceIds: sortedUnique((task.requiredEvidenceIds || []).map((entry) => canonicalIdentifier(entry, 'REQUIRED_EVIDENCE_ID'))),
    produces: sortedUnique((task.produces || []).map((entry) => canonicalIdentifier(entry, 'PRODUCED_EVIDENCE_ID'))),
    mandatory: task.mandatory === true,
    reversibility: requireEnum(task.reversibility, REVERSIBILITY_CLASSES, 'TASK_REVERSIBILITY', 'REVERSIBLE'),
    architectureImpact: requireEnum(task.architectureImpact, ARCHITECTURE_IMPACTS, 'TASK_ARCHITECTURE_IMPACT', 'LOCAL'),
    uncertainty: requireEnum(task.uncertainty, UNCERTAINTY_LEVELS, 'TASK_UNCERTAINTY', 'LOW'),
    contradiction,
    // Only meaningful for POLICY_DECISION: a technical question dressed up as a
    // policy question is routed back to reasoning instead of to the owner.
    derivableFromEvidence: task.derivableFromEvidence === true,
    repair: normalizeRepair(task.repair, taskId)
  };
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) throw new Error('ROUTE_TASKS_REQUIRED');
  const normalized = tasks.map(normalizeTask).sort((a, b) => compareIdentifiers(a.taskId, b.taskId));
  const seen = new Set();
  for (const task of normalized) {
    if (seen.has(task.taskId)) throw new Error(`DUPLICATE_TASK_ID:${task.taskId}`);
    seen.add(task.taskId);
  }
  // Two tasks producing one evidence id leaves no answer to "which route
  // governs that evidence", so it is ambiguous input rather than extra work.
  const produced = new Set();
  for (const task of normalized) {
    for (const evidenceId of task.produces) {
      if (produced.has(evidenceId)) throw new Error(`DUPLICATE_PRODUCED_EVIDENCE_ID:${evidenceId}`);
      produced.add(evidenceId);
    }
  }
  // R5 is not a scheduler, and one route snapshot has exactly one repair
  // history. A second targeted attempt is only authorized once the first one's
  // outcome is known, so two targeted attempts on the same root cause in one
  // request are sequential work presented as concurrent. There is no
  // attempt-grouping concept in this model that could make them one attempt, so
  // this is ambiguous input rather than a route to compute.
  const targetedByRootCause = new Set();
  for (const task of normalized) {
    if (!task.repair?.incremental) continue;
    if (targetedByRootCause.has(task.repair.rootCauseClass)) {
      throw new Error(`MULTIPLE_TARGETED_REPAIR_ATTEMPTS_REQUIRE_SEQUENTIAL_HISTORY:${task.repair.rootCauseClass}`);
    }
    targetedByRootCause.add(task.repair.rootCauseClass);
  }
  return normalized;
}

/* -------------------------------------------------------------------------
 * Routing
 * ---------------------------------------------------------------------- */

/**
 * Quality floor. Anything reported here blocks the task, and it is computed
 * before reuse or cost is considered so no cheaper route can precede it.
 *
 * The interesting case is required evidence that is merely INVALIDATED. If the
 * task itself produces that evidence, the task IS the revalidation work and may
 * proceed. If it only consumes it, the evidence is not currently reusable and
 * R5 has no scheduler proving the producing task runs first, so the consumer is
 * not executable yet — pending, not permanently unresolvable.
 */
function qualityObstacles(task, evidenceById, deltasByPath) {
  const obstacles = [];
  const produced = new Set(task.produces);
  for (const evidenceId of task.requiredEvidenceIds) {
    const node = evidenceById.get(evidenceId);
    if (!node) { obstacles.push(`REQUIRED_EVIDENCE_MISSING:${evidenceId}`); continue; }
    if (node.tombstone) { obstacles.push(`REQUIRED_EVIDENCE_REMOVED:${evidenceId}`); continue; }
    if (node.state === 'REUSABLE') continue;
    if (UNRESOLVABLE_EVIDENCE_REASONS.includes(node.reason)) {
      obstacles.push(`REQUIRED_EVIDENCE_UNRESOLVABLE:${evidenceId}:${node.reason}`);
    } else if (!produced.has(evidenceId)) {
      obstacles.push(`REQUIRED_EVIDENCE_REVALIDATION_PENDING:${evidenceId}`);
    }
  }
  for (const sourcePath of task.sources) {
    const delta = deltasByPath.get(sourcePath);
    // An untracked source means R3 cannot prove whether it changed. Absence of
    // a delta is not evidence that nothing changed.
    if (!delta) { obstacles.push(`SOURCE_UNTRACKED_BY_R3:${sourcePath}`); continue; }
    if (delta.kind === 'REMOVED') obstacles.push(`REQUIRED_SOURCE_REMOVED:${sourcePath}`);
  }
  return obstacles.sort(compareIdentifiers);
}

/**
 * Escalations that are CONTROL OBLIGATIONS rather than merely expensive work.
 *
 * These outrank upstream reuse and outrank the owner-decision shortcut, and
 * they are attached even to a task that ends up BLOCKED. Reuse answers "has
 * this already been computed?", which is the wrong question for both of them: a
 * contradiction is a statement that the inputs disagree NOW, and the analysis a
 * stopped cascade demands is the lineage's only way out. Letting either be
 * skipped because some earlier artefact is still reusable would let the plan
 * report NO_WORK_REQUIRED over an unresolved control condition.
 */
function controlEscalations(task, containment) {
  const reasons = [];
  if (task.contradiction) reasons.push('ARCHITECTURE_CONTRADICTION');
  if (task.intent === 'ROOT_CAUSE_ANALYSIS' && containment && !containment.incrementalPatchAuthorized) {
    reasons.push('ROOT_CAUSE_ANALYSIS_REQUIRED_AFTER_CONTAINMENT');
  }
  return reasons;
}

/**
 * Escalations that only mean "this is expensive". Reuse may legitimately skip
 * these: wide, uncertain or exploratory work whose prior evidence genuinely
 * still holds does not need redoing. They deliberately do NOT apply to
 * DETERMINISTIC work either — running the deterministic check is how that
 * uncertainty gets resolved, and paying deep-reasoning cost to watch it run
 * buys nothing.
 */
function ordinaryEscalations(task, containment) {
  const reasons = [];
  if (task.intent === 'ROOT_CAUSE_ANALYSIS' && !(containment && !containment.incrementalPatchAuthorized)) reasons.push('ROOT_CAUSE_ANALYSIS_REQUESTED');
  if (task.intent !== 'DETERMINISTIC') {
    if (task.architectureImpact !== 'LOCAL') reasons.push(`ARCHITECTURE_IMPACT_${task.architectureImpact}`);
    if (task.uncertainty === 'HIGH') reasons.push('UNRESOLVED_SEMANTIC_UNCERTAINTY');
  }
  return reasons;
}

function routeTask(task, context) {
  const { evidenceById, deltasByPath, containmentByRootCause } = context;
  const reasonCodes = [];
  const containment = task.repair ? containmentByRootCause.get(task.repair.rootCauseClass) : null;
  const containmentState = containment ? (task.repair.incremental ? containment.nextAttemptState : containment.lineageState) : null;

  // Computed before anything can short-circuit, and carried into every exit
  // below, so a control obligation stays visible whatever stops the task first.
  const control = controlEscalations(task, containment);

  const obstacles = qualityObstacles(task, evidenceById, deltasByPath);
  if (obstacles.length) {
    return { capability: BLOCKED, reasonCodes: ['QUALITY_FLOOR_BLOCKS_EXECUTION', ...obstacles, ...control], containment, containmentState, blockedBy: obstacles };
  }

  if (containment && task.repair.incremental && !containment.incrementalPatchAuthorized) {
    return {
      capability: BLOCKED,
      reasonCodes: [`REPAIR_CONTAINMENT_STOP_PATCH_CASCADE:${task.repair.rootCauseClass}`, containment.reasonCode, ...control],
      containment,
      containmentState,
      blockedBy: [`REPAIR_CONTAINMENT_STOP_PATCH_CASCADE:${task.repair.rootCauseClass}`]
    };
  }

  // A stopped cascade must not be escapable by relabelling the same patch as
  // structural. The analysis the stop demanded is the prerequisite, so the
  // analysis task itself is always allowed through — otherwise the lineage
  // could never satisfy its own way out.
  if (containment && !task.repair.incremental && task.intent !== 'ROOT_CAUSE_ANALYSIS' && !containment.structuralRepairAuthorized) {
    const obstacle = `${containment.structuralRepairObstacle}:${task.repair.rootCauseClass}`;
    return { capability: BLOCKED, reasonCodes: [obstacle, containment.reasonCode, ...control], containment, containmentState, blockedBy: [obstacle] };
  }

  // Control obligations are settled before reuse and before the owner-decision
  // shortcut. This is a precedence fix, not a weakening of reuse: everything
  // below still skips work whose evidence genuinely holds.
  if (control.length) {
    return { capability: DEEP_REASONING, reasonCodes: [...reasonCodes, ...control], containment, containmentState, blockedBy: [] };
  }

  // Upstream reuse. Only claimable when R4 proved every evidence this task
  // would produce is still reusable AND R3 proved every source it reads is
  // unchanged. A mandatory task is exempt: reuse never excuses a required run.
  const producedNodes = task.produces.map((evidenceId) => evidenceById.get(evidenceId));
  const allProducedReusable = task.produces.length > 0 && producedNodes.every((node) => node && !node.tombstone && node.state === 'REUSABLE');
  const allSourcesUnchanged = task.sources.every((sourcePath) => deltasByPath.get(sourcePath)?.kind === 'UNCHANGED');
  if (!task.mandatory && allProducedReusable && allSourcesUnchanged) {
    return { capability: NO_WORK_REQUIRED, reasonCodes: ['EVIDENCE_REUSABLE_NO_WORK_REQUIRED', 'UPSTREAM_R3_SOURCES_UNCHANGED'], containment, containmentState, blockedBy: [] };
  }
  if (task.mandatory && allProducedReusable && allSourcesUnchanged) reasonCodes.push('MANDATORY_VALIDATION_RUNS_DESPITE_AVAILABLE_REUSE');

  if (task.intent === 'POLICY_DECISION') {
    if (!task.derivableFromEvidence) {
      return { capability: OWNER_DECISION_REQUIRED, reasonCodes: [...reasonCodes, 'OWNER_POLICY_DECISION_NOT_DERIVABLE'], containment, containmentState, blockedBy: [] };
    }
    reasonCodes.push('OWNER_DECISION_AVOIDABLE_TECHNICAL_QUESTION');
  }

  const escalations = ordinaryEscalations(task, containment);
  if (escalations.length) {
    return { capability: DEEP_REASONING, reasonCodes: [...reasonCodes, ...escalations], containment, containmentState, blockedBy: [] };
  }

  if (task.intent === 'DETERMINISTIC') {
    const revalidating = task.produces.some((evidenceId) => evidenceById.get(evidenceId)?.state === 'INVALIDATED');
    return {
      capability: LOCAL_DETERMINISTIC,
      reasonCodes: [...reasonCodes, 'DETERMINISTIC_WORK_LOCALLY_EXECUTABLE', ...(revalidating ? ['EVIDENCE_REVALIDATION_REQUIRED'] : [])],
      containment,
      containmentState,
      blockedBy: []
    };
  }
  return { capability: STANDARD_REASONING, reasonCodes: [...reasonCodes, 'BOUNDED_SEMANTIC_WORK'], containment, containmentState, blockedBy: [] };
}

/**
 * Reason codes that make a task quality-critical: leaving it unrouted would
 * hide something the quality floor exists to surface.
 */
const NON_DEFERRABLE_REASON_CODES = Object.freeze([
  'QUALITY_FLOOR_BLOCKS_EXECUTION',
  'ARCHITECTURE_CONTRADICTION',
  'ROOT_CAUSE_ANALYSIS_REQUIRED_AFTER_CONTAINMENT'
]);

/**
 * Why the cost ceiling may not defer this task, or null if it may.
 *
 * The ceiling stays useful precisely because this list is short: expensive but
 * discretionary work — including plain DEEP_REASONING on a wide but
 * uncontradicted change — remains deferrable. What may never be deferred is
 * work whose absence would misrepresent the state of the work unit: a mandatory
 * validation, an unresolved blocker, an architecture contradiction, or the
 * root-cause analysis that a stopped patch cascade demands.
 */
function nonDeferrableReason(task, routed) {
  if (task.mandatory) return 'MANDATORY_VALIDATION_EXEMPT_FROM_COST_CEILING';
  if (routed.capability === BLOCKED) return 'COST_CEILING_EXCEEDED_BLOCKED_TASK_RETAINED';
  // The ceiling limits model/execution effort, and an owner decision consumes
  // none: it is never given a provider. Deferring one would convert a real
  // unresolved question into NO_WORK_REQUIRED for no saving at all.
  if (routed.capability === OWNER_DECISION_REQUIRED) return 'OWNER_DECISION_EXEMPT_FROM_COST_CEILING';
  const critical = routed.reasonCodes.find((code) => NON_DEFERRABLE_REASON_CODES.includes(code));
  return critical ? `QUALITY_CRITICAL_EXEMPT_FROM_COST_CEILING:${critical}` : null;
}

/** Bytes this task would actually have to reprocess, from R3 and R4 measurements. */
function taskByteAccounting(task, evidenceById, deltasByPath) {
  let reprocessBytes = 0;
  let avoidedBytes = 0;
  for (const sourcePath of task.sources) {
    const delta = deltasByPath.get(sourcePath);
    if (!delta) continue;
    if (delta.kind === 'UNCHANGED') avoidedBytes += delta.bytes; else reprocessBytes += delta.bytes;
  }
  // Produced and required ids routinely overlap (a task that re-verifies a fact
  // both needs and reproduces it), so count each node's bytes once.
  for (const evidenceId of new Set([...task.produces, ...task.requiredEvidenceIds])) {
    const node = evidenceById.get(evidenceId);
    if (!node) continue;
    if (node.state === 'REUSABLE') avoidedBytes += node.bytes; else if (!node.tombstone) reprocessBytes += node.bytes;
  }
  return { reprocessBytes, avoidedBytes };
}

/* -------------------------------------------------------------------------
 * Plan
 * ---------------------------------------------------------------------- */

export function routeWorkUnit({ workUnitId, tasks, r2Context, r3Delta, r4Evidence, cas, repairLedger, policy } = {}) {
  const activePolicy = validateRouterPolicy(policy === undefined ? DEFAULT_ROUTER_POLICY : policy);
  const canonicalWorkUnitId = canonicalIdentifier(workUnitId, 'WORK_UNIT_ID');
  if (!cas) throw new Error('CAS_REQUIRED');
  const normalizedTasks = normalizeTasks(tasks);

  const { bundle, contextSha256 } = verifyR2Context(r2Context);
  // The plan records both identities, so they must not be allowed to disagree:
  // routing one work unit against another's compiled context would produce a
  // plan whose provenance quietly describes something else.
  if (bundle.identity?.workUnitId !== canonicalWorkUnitId) {
    throw new Error(`R2_CONTEXT_WORK_UNIT_MISMATCH:${canonicalWorkUnitId}!=${bundle.identity?.workUnitId ?? 'ABSENT'}`);
  }
  const { verified: verifiedDelta, snapshots, deltaSha256 } = verifyR3Delta(r3Delta);
  const evaluated = verifyR4Evidence(r4Evidence, snapshots, cas);

  const ledger = repairLedger === undefined || repairLedger === null ? createRepairLedger() : repairLedger;
  verifyRepairLedger(ledger);

  const deltasByPath = new Map(verifiedDelta.deltas.map((delta) => [delta.path, delta]));
  const evidenceById = new Map(evaluated.graph.nodes.map((node) => [node.evidenceId, node]));

  // Task-inventory completeness. R4 has just said which current evidence needs
  // revalidating; if no declared task can produce a piece of it, this request
  // cannot yield an honest plan — it would report the evidence as outstanding
  // and the work unit as NO_WORK_REQUIRED in the same document. Reusable
  // evidence needs no producer, and removed evidence has nothing left to
  // revalidate, so neither is required here.
  const producible = new Set(normalizedTasks.flatMap((task) => task.produces));
  const unrouted = evaluated.graph.nodes
    .filter((node) => !node.tombstone && node.state !== 'REUSABLE' && !producible.has(node.evidenceId))
    .map((node) => node.evidenceId)
    .sort(compareIdentifiers);
  if (unrouted.length) throw new Error(`UNROUTED_REVALIDATION_REQUIRED:${unrouted.join(',')}`);

  /**
   * Proof predicate for a recorded resolution claim, in two halves that are
   * both necessary and neither sufficient.
   *
   * AUTHENTICITY, from the router's own R4 re-evaluation: the named node still
   * exists, is not a tombstone, is currently REUSABLE, and carries exactly the
   * identity the record bound.
   *
   * RELEVANCE, from the node's validated content: the assertion inside it must
   * name this root cause and this defect. Without that half, any honest
   * reusable node in the graph would close any lineage — authenticity would be
   * mistaken for aboutness. Reading the content is safe and adds no new trust:
   * R4 already fetched and size-checked every node from the same CAS, and
   * reuseIdentity binds the content address, so an edited assertion changes the
   * identity and fails the first half.
   */
  const verifyResolution = (resolutionEvidence, record) => {
    const node = resolutionEvidence ? evidenceById.get(resolutionEvidence.evidenceId) : null;
    if (!node || node.tombstone || node.state !== 'REUSABLE') return false;
    if (node.reuseIdentity !== resolutionEvidence.reuseIdentity) return false;
    let assertion;
    try {
      assertion = JSON.parse(cas.get(node.contentAddress).toString('utf8'));
    } catch {
      return false;
    }
    return matchesResolutionAssertion(assertion, record);
  };

  const containmentByRootCause = new Map();
  for (const task of normalizedTasks) {
    if (task.repair && !containmentByRootCause.has(task.repair.rootCauseClass)) {
      containmentByRootCause.set(task.repair.rootCauseClass, evaluateContainment(ledger, task.repair.rootCauseClass, { verifyResolution }));
    }
  }

  const routingContext = { evidenceById, deltasByPath, containmentByRootCause };
  const routedTasks = normalizedTasks.map((task) => {
    const routed = routeTask(task, routingContext);
    const { reprocessBytes, avoidedBytes } = taskByteAccounting(task, evidenceById, deltasByPath);
    const costClass = costClassFor({ policy: activePolicy, capability: routed.capability, reprocessBytes, reversibility: task.reversibility });
    const overCeiling = costRank(costClass) > costRank(activePolicy.costCeiling);
    // The ceiling defers discretionary work only. Everything the quality floor
    // needs surfaced is exempt, so cost can never make it disappear.
    const exemption = nonDeferrableReason(task, routed);
    const deferred = overCeiling && !exemption;
    const ceilingReasons = overCeiling ? [exemption || 'COST_CEILING_EXCEEDED_DEFERRED'] : [];
    return {
      taskId: task.taskId,
      intent: task.intent,
      description: task.description,
      capability: routed.capability,
      costClass,
      deferred,
      nonDeferrable: exemption !== null,
      mandatory: task.mandatory,
      reasonCodes: sortedUnique([...routed.reasonCodes, ...ceilingReasons]),
      sources: task.sources,
      requiredEvidenceIds: task.requiredEvidenceIds,
      produces: task.produces,
      blockedBy: routed.blockedBy,
      reprocessBytes,
      avoidedBytes,
      repair: task.repair,
      containmentState: routed.containmentState
    };
  });

  const idsWhere = (predicate) => routedTasks.filter(predicate).map((task) => task.taskId);
  const active = (capability) => (task) => task.capability === capability && !task.deferred;

  const currentNodes = evaluated.graph.nodes.filter((node) => !node.tombstone);
  const reusableEvidenceIds = sortedUnique(currentNodes.filter((node) => node.state === 'REUSABLE').map((node) => node.evidenceId));
  const revalidationRequiredEvidenceIds = sortedUnique(currentNodes.filter((node) => node.state !== 'REUSABLE').map((node) => node.evidenceId));
  const removedEvidenceIds = sortedUnique(evaluated.graph.nodes.filter((node) => node.tombstone).map((node) => node.evidenceId));

  const executable = routedTasks.filter((task) => !task.deferred);
  const routeDecision = executable.reduce((highest, task) => maxCapability(highest, task.capability), NO_WORK_REQUIRED);
  // The exemption rule above already makes this unreachable. It is asserted
  // anyway, because "cost never suppresses a quality-critical task" is the
  // invariant, and an invariant that is only argued for is one bug away from
  // being false: the plan must never report NO_WORK_REQUIRED while one is open.
  if (routeDecision === NO_WORK_REQUIRED && routedTasks.some((task) => task.nonDeferrable && task.capability !== NO_WORK_REQUIRED)) {
    throw new Error('QUALITY_CRITICAL_TASK_SUPPRESSED');
  }

  const lineages = [...containmentByRootCause.values()]
    .map((containment) => ({
      rootCauseClass: containment.rootCauseClass,
      lineageState: containment.lineageState,
      nextAttemptState: containment.nextAttemptState,
      nextTargetedAttemptOrdinal: containment.nextTargetedAttemptOrdinal,
      targetedAttempts: containment.targetedAttempts,
      structuralAttempts: containment.structuralAttempts,
      rootCauseAnalyses: containment.rootCauseAnalyses,
      postContainmentRootCauseAnalyses: containment.postContainmentRootCauseAnalyses,
      survivedTargetedAttempts: containment.survivedTargetedAttempts,
      unprovenResolutionClaims: containment.unprovenResolutionClaims,
      verifiedResolutions: containment.verifiedResolutions,
      containmentCount: containment.containmentCount,
      incrementalPatchAuthorized: containment.incrementalPatchAuthorized,
      structuralRepairAuthorized: containment.structuralRepairAuthorized,
      structuralRepairObstacle: containment.structuralRepairObstacle,
      requiredNextAction: containment.requiredNextAction,
      reasonCode: containment.reasonCode
    }))
    .sort((a, b) => compareIdentifiers(a.rootCauseClass, b.rootCauseClass));

  const currentSourceBytes = snapshots.currentSnapshot.sources.reduce((sum, source) => sum + source.bytes, 0);
  // Canonical form, so the measured context size does not depend on how the
  // bundle happened to be serialised before it reached the router.
  const contextBytes = Buffer.byteLength(canonicalize(bundle), 'utf8');

  const body = {
    schemaVersion: 1,
    planKind: ROUTE_PLAN_KIND,
    engine: ROUTER_VERSION,
    workUnitId: canonicalWorkUnitId,
    routeDecision,
    routeReasonCodes: sortedUnique(routedTasks.flatMap((task) => task.reasonCodes)),
    tasks: routedTasks,
    deterministicTasks: idsWhere(active(LOCAL_DETERMINISTIC)),
    reasoningTasks: idsWhere(active(STANDARD_REASONING)),
    deepReasoningTasks: idsWhere(active(DEEP_REASONING)),
    ownerDecisionTasks: idsWhere(active(OWNER_DECISION_REQUIRED)),
    blockedTasks: idsWhere((task) => task.capability === BLOCKED),
    avoidedTasks: idsWhere(active(NO_WORK_REQUIRED)),
    deferredTasks: idsWhere((task) => task.deferred),
    reusableEvidenceIds,
    revalidationRequiredEvidenceIds,
    removedEvidenceIds,
    qualityRequirements: {
      mandatoryTaskIds: idsWhere((task) => task.mandatory),
      contradictionTaskIds: idsWhere((task) => task.reasonCodes.includes('ARCHITECTURE_CONTRADICTION')),
      nonDeferrableTaskIds: idsWhere((task) => task.nonDeferrable),
      // Blocked only until the task that produces their evidence has run, as
      // opposed to blocked by something no work in this plan can clear.
      pendingRevalidationTaskIds: idsWhere((task) => task.blockedBy.some((entry) => entry.startsWith('REQUIRED_EVIDENCE_REVALIDATION_PENDING:'))),
      unmetRequirements: sortedUnique(routedTasks.flatMap((task) => task.blockedBy)),
      qualityFloorEnforced: routedTasks.some((task) => task.blockedBy.length > 0)
    },
    repairContainment: {
      lineages,
      stopPatchCascade: lineages.some((lineage) => !lineage.incrementalPatchAuthorized)
    },
    cost: {
      policyVersion: activePolicy.policyVersion,
      costCeiling: activePolicy.costCeiling,
      byCostClass: routedTasks.reduce((counts, task) => ({ ...counts, [task.costClass]: (counts[task.costClass] || 0) + 1 }), {}),
      deterministicTaskCount: idsWhere(active(LOCAL_DETERMINISTIC)).length,
      standardReasoningTaskCount: idsWhere(active(STANDARD_REASONING)).length,
      deepReasoningTaskCount: idsWhere(active(DEEP_REASONING)).length,
      ownerDecisionTaskCount: idsWhere(active(OWNER_DECISION_REQUIRED)).length,
      blockedTaskCount: idsWhere((task) => task.capability === BLOCKED).length,
      avoidedTaskCount: idsWhere(active(NO_WORK_REQUIRED)).length,
      deferredTaskCount: idsWhere((task) => task.deferred).length
    },
    metrics: {
      TOKEN_MEASUREMENT,
      R2_CONTEXT_BYTES: contextBytes,
      R3_TOTAL_SOURCE_BYTES: currentSourceBytes,
      R3_UNCHANGED_BYTES: verifiedDelta.metrics.UNCHANGED_BYTES,
      R3_CHANGED_BYTES: verifiedDelta.metrics.CHANGED_BYTES,
      R3_REPROCESS_BYTES: verifiedDelta.metrics.REPROCESS_BYTES,
      R3_AVOIDED_REPROCESS_BYTES: verifiedDelta.metrics.AVOIDED_REPROCESS_BYTES,
      R4_CURRENT_EVIDENCE_NODES: evaluated.metrics.CURRENT_EVIDENCE_NODES,
      R4_REUSABLE_NODES: evaluated.metrics.REUSABLE_NODES,
      R4_REVALIDATION_REQUIRED_NODES: evaluated.metrics.REVALIDATION_REQUIRED_NODES,
      R4_REMOVED_EVIDENCE_NODES: evaluated.metrics.REMOVED_EVIDENCE_NODES,
      R4_AVOIDED_EVIDENCE_BYTES: evaluated.metrics.AVOIDED_EVIDENCE_BYTES,
      R5_TASKS_TOTAL: routedTasks.length,
      R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE: idsWhere(active(NO_WORK_REQUIRED)).length,
      R5_TASK_REPROCESS_BYTES: routedTasks.filter((task) => task.capability !== NO_WORK_REQUIRED && !task.deferred).reduce((sum, task) => sum + task.reprocessBytes, 0),
      R5_TASK_AVOIDED_BYTES: routedTasks.reduce((sum, task) => sum + task.avoidedBytes, 0)
    },
    provenance: {
      r2ContextSha256: contextSha256,
      r2WorkUnitId: bundle.identity?.workUnitId ?? null,
      r3DeltaSha256: deltaSha256,
      r4GraphSha256: evaluated.graph.graphSha256,
      repairLedgerSha256: ledger.ledgerSha256,
      routerPolicySha256: routerPolicySha256(activePolicy)
    }
  };
  return { ...body, routeSha256: sha256Canonical(body) };
}

/**
 * Recomputes a plan's digest over its own body. Cheap integrity check for a
 * plan that has crossed a process or file boundary; it proves the plan was not
 * edited in transit, and proves nothing at all about whether the route is right.
 */
export function routePlanSha256(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('ROUTE_PLAN_REQUIRED');
  const { routeSha256, ...body } = plan;
  return sha256Canonical(body);
}

export function verifyRoutePlanDigest(plan) {
  if (plan?.routeSha256 !== routePlanSha256(plan)) throw new Error('INVALID_ROUTE_PLAN_DIGEST');
  return true;
}

const ROUTE_PLAN_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'route-plan.schema.json'), 'utf8')
);

/** Every task-id reference list a materialized plan carries, with its pointer. */
function taskReferenceLists(plan) {
  return [
    ['/deterministicTasks', plan.deterministicTasks],
    ['/reasoningTasks', plan.reasoningTasks],
    ['/deepReasoningTasks', plan.deepReasoningTasks],
    ['/ownerDecisionTasks', plan.ownerDecisionTasks],
    ['/blockedTasks', plan.blockedTasks],
    ['/avoidedTasks', plan.avoidedTasks],
    ['/deferredTasks', plan.deferredTasks],
    ['/qualityRequirements/mandatoryTaskIds', plan.qualityRequirements?.mandatoryTaskIds],
    ['/qualityRequirements/contradictionTaskIds', plan.qualityRequirements?.contradictionTaskIds],
    ['/qualityRequirements/nonDeferrableTaskIds', plan.qualityRequirements?.nonDeferrableTaskIds],
    ['/qualityRequirements/pendingRevalidationTaskIds', plan.qualityRequirements?.pendingRevalidationTaskIds]
  ];
}

/**
 * Runtime identity of a MATERIALIZED plan.
 *
 * canonical-json hashes strings as NFC, so a plan whose task id was rewritten
 * into a Unicode-equivalent decomposed form keeps the identical routeSha256
 * while resolving to a different runtime identifier — one digest standing for
 * two different execution semantics. The engine's own builder already refuses
 * non-canonical input, so this closes the same gap on the way back IN, for a
 * plan that has crossed a file, process or network boundary.
 *
 * It REJECTS rather than normalizes: silently rewriting a caller's plan would
 * change the document the digest was computed over, and would hide the fact
 * that something upstream produced a non-canonical identifier.
 */
function canonicalIdentityErrors(plan) {
  const errors = [];
  const push = (jsonPointer, reason, message) => errors.push({ jsonPointer, reason, message });
  const isCanonical = (value) => typeof value === 'string' && value === value.normalize('NFC');
  if (!isCanonical(plan.workUnitId)) push('/workUnitId', 'NON_CANONICAL_WORK_UNIT_ID', 'work unit id must already be NFC');
  const taskIds = new Set();
  plan.tasks.forEach((task, index) => {
    if (!isCanonical(task.taskId)) {
      push(`/tasks/${index}/taskId`, 'NON_CANONICAL_TASK_ID', 'task id must already be NFC');
      return;
    }
    // Checked on canonical ids, so two ids that collapse to one canonical
    // identity can never both survive validation.
    if (taskIds.has(task.taskId)) push(`/tasks/${index}/taskId`, 'DUPLICATE_TASK_ID', 'two tasks share one canonical identity');
    taskIds.add(task.taskId);
  });
  for (const [pointer, list] of taskReferenceLists(plan)) {
    (list || []).forEach((taskId, index) => {
      if (!isCanonical(taskId)) push(`${pointer}/${index}`, 'NON_CANONICAL_TASK_REFERENCE', 'task reference must already be NFC');
      else if (!taskIds.has(taskId)) push(`${pointer}/${index}`, 'UNKNOWN_TASK_REFERENCE', 'task reference names no task in this plan');
    });
  }
  return errors;
}

/**
 * Conformance of a plan document: structure, then runtime identity. Says
 * nothing about whether the routing decisions themselves are right.
 */
export function validateRoutePlan(plan) {
  const structural = validateAgainstJsonSchema(plan, ROUTE_PLAN_SCHEMA);
  // Identity checks assume the shape is already right; a malformed document has
  // nothing stable to check identities against.
  if (!structural.valid) return structural;
  const errors = canonicalIdentityErrors(plan);
  return { valid: errors.length === 0, errors };
}

export { CALLER_FORBIDDEN_TASK_FIELDS, UNRESOLVABLE_EVIDENCE_REASONS };
