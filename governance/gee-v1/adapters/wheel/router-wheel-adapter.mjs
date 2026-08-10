/**
 * Wheel adapter for the R5 router.
 *
 * Everything Wheel-shaped lives here so the router core never learns what a
 * gate, a registry or a ledger is. The adapter's whole job is to turn one Wheel
 * work unit into the four generic inputs the core understands — compiled
 * context, source delta, evidence graph, task list — and then get out of the
 * way. No routing decision, capability class or containment rule is made in
 * this file.
 *
 * The task derivation is the interesting part. A naive execution would re-read
 * every canonical source and re-verify every fact on every run. Here each R2
 * fact becomes one DETERMINISTIC task that declares exactly the source it reads
 * and the evidence it would produce, which is what lets the core drop it when
 * R3 says the source is unchanged and R4 says the evidence is still reusable.
 */

import { compileContext } from '../../context/compile-context.mjs';
import { createWheelContextAdapter } from './context-wheel-adapter.mjs';
import { createWheelDeltaSnapshot } from './delta-wheel-adapter.mjs';
import { createWheelEvidenceGraph } from './evidence-wheel-adapter.mjs';
import { routeWorkUnit } from '../../router/router-engine.mjs';

export const WHEEL_ROUTER_ADAPTER_VERSION = 'GEE_V1_ROUTER_WHEEL_ADAPTER_R5';

/** Evidence id minted by evidence-wheel-adapter for an R2 context fact. */
function evidenceIdForFact(factId) { return `wheel:${factId}`; }

/**
 * One deterministic re-verification task per compiled fact. `sources` and
 * `produces` are what make the task droppable: they are the claim the core
 * checks against R3 and R4 before deciding the work still has to happen.
 */
export function buildWheelVerificationTasks(context) {
  if (!context || context.authorityDeclaration !== 'DERIVED / NON_AUTHORITATIVE') throw new Error('R2_CONTEXT_MUST_REMAIN_NON_AUTHORITATIVE');
  return context.facts.map((fact) => ({
    taskId: `wheel-verify-fact:${fact.id}`,
    intent: 'DETERMINISTIC',
    description: `Re-verify Wheel context fact ${fact.id} against its canonical source.`,
    sources: [fact.provenance.sourcePath],
    produces: [evidenceIdForFact(fact.id)],
    requiredEvidenceIds: [evidenceIdForFact(fact.id)]
  }));
}

/**
 * Assembles the generic router inputs for one Wheel work unit.
 *
 * `previousSnapshot` defaults to the snapshot taken right now, which models an
 * unchanged replay honestly: R3 then reports UNCHANGED because the bytes really
 * are the same, not because the comparison was skipped.
 */
export function createWheelRouteRequest({ repoRoot, workUnitId, cas, sourceHead, previousSnapshot = null, previousGraph = null, extraTasks = [] } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('REPO_ROOT_REQUIRED');
  if (!cas) throw new Error('CAS_REQUIRED');
  const compiled = compileContext({ repoRoot, adapter: createWheelContextAdapter(repoRoot), workUnitId, sourceHead });
  const context = compiled.json;
  const currentSnapshot = createWheelDeltaSnapshot({ repoRoot, context });
  const r3Delta = { previousSnapshot: previousSnapshot || currentSnapshot, currentSnapshot };
  const graph = createWheelEvidenceGraph({ cas, context, repoRoot, r3Delta });
  return {
    workUnitId,
    tasks: [...buildWheelVerificationTasks(context), ...extraTasks],
    r2Context: context,
    r3Delta,
    r4Evidence: { graph, previousGraph },
    cas,
    compiled,
    currentSnapshot
  };
}

export function routeWheelWorkUnit({ repairLedger = null, policy, ...request } = {}) {
  const { compiled, currentSnapshot, ...routerInputs } = createWheelRouteRequest(request);
  return {
    plan: routeWorkUnit({ ...routerInputs, repairLedger, policy }),
    compiled,
    currentSnapshot,
    graph: routerInputs.r4Evidence.graph
  };
}

export { evidenceIdForFact };
