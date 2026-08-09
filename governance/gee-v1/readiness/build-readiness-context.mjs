/**
 * GEE V1 — mandatory readiness context builder.
 * RC-4 support: the single authoritative factory for a ReadinessContext.
 * evaluateReadiness's strict path accepts ONLY a context produced here — a
 * hand-built object literal is rejected by the brand check (see
 * ../readiness/evaluate-readiness.mjs). There is no optional parameter for a
 * caller to forget, because critical proofs are derived from canonical state,
 * never passed in loosely.
 *
 * Every critical proof is one of PROVEN | FAILED | UNKNOWN | NOT_APPLICABLE.
 * undefined is not representable. NOT_APPLICABLE is legal only when this
 * builder can point to the canonical fact that makes it inapplicable — never
 * from a missing argument. SKIP does not exist in this vocabulary.
 */

import { validateActivationAnchor } from '../contracts/validate-activation-anchor.mjs';

export const READINESS_CONTEXT_BRAND = Symbol.for('gee-v1.readiness-context');

const PROOF_STATES = Object.freeze(['PROVEN', 'FAILED', 'UNKNOWN', 'NOT_APPLICABLE']);
const REQUIRED_PROOF_SLOTS = Object.freeze(['AUTHORITY_STATE', 'OPEN_DEFECTS', 'ACTIVATION_ANCHOR', 'PREFLIGHT']);

function proof(state, extra = {}) {
  if (!PROOF_STATES.includes(state)) throw new Error(`INVALID_PROOF_STATE:${state}`);
  return Object.freeze({ state, ...extra });
}

function deriveAuthorityStateProof(view) {
  const auth = view?.authorityState;
  if (!auth || typeof auth !== 'object') return proof('UNKNOWN', { reason: 'AUTHORITY_STATE_ABSENT' });
  if (auth.consistent === true) return proof('PROVEN', { evidenceRef: auth.source || null });
  return proof('FAILED', { reason: auth.reason || auth.statusKnowledge || 'AUTHORITY_STATE_INCONSISTENT' });
}

function deriveOpenDefectsProof(view) {
  if (view?.defectsOpenKnowledge === 'KNOWN_ZERO') return proof('PROVEN', { value: view.defectsOpenCount });
  if (view?.defectsOpenKnowledge === 'KNOWN_NONZERO') return proof('FAILED', { value: view.defectsOpenCount, reason: 'DEFECTS_OPEN' });
  return proof('UNKNOWN', { reason: view?.defectsValidationReason || 'DEFECTS_KNOWLEDGE_UNKNOWN' });
}

/**
 * Activation is DERIVED from canonical state (view.activation), never from a
 * caller-supplied default. An activated work unit with no anchor evidence
 * yields UNKNOWN (blocks), never NOT_APPLICABLE.
 *
 * FINAL-03: a coordinated LOCAL reseal (contract + seal + activation authority
 * all recomputed together) is, by construction, internally self-consistent —
 * validateActivationAnchor alone would report INTACT for it. That local check
 * has no way to know the ledger/witness authority spine disagrees. It is
 * therefore not sufficient on its own: activation can only be PROVEN when the
 * SAME authority spine that governs closure (view.authorityState.consistent,
 * derived from the ledger) also holds. No second authority spine is
 * introduced — this reuses the one the adapter already computes.
 *
 * R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: authorityState.consistent alone is STILL not enough —
 * it only proves the ledger agrees with the work unit's generic status STRING, never WHICH
 * activation-authority bytes earned that status. A coordinated local reseal reproduces the same
 * status string (so authorityState.consistent stays true) while pinning nothing to the ledger.
 * `activation.anchor.ledgerBinding` (computed by the project adapter, see
 * wheel-project-adapter.mjs's deriveActivation) is the missing link: it is PROVEN only when a
 * canonical ledger transition for this exact work unit pins this exact activation-authority
 * artifact's live bytes. No raw "authorityState.consistent === true" reasoning is accepted here
 * on its own — see AB-series hostile tests.
 */
export function deriveActivationProof({ view, executionContract, executionSeal }) {
  const activation = view?.activation;
  if (!activation || typeof activation !== 'object') {
    return proof('UNKNOWN', { reason: 'ACTIVATION_STATE_UNREADABLE' });
  }
  if (activation.activated !== true) {
    return proof('NOT_APPLICABLE', { reason: 'CONTRACT_DECLARES_INAPPLICABLE', evidenceRef: activation.source || null });
  }
  if (!activation.anchor) {
    return proof('UNKNOWN', { reason: 'ACTIVATED_WITH_NO_ANCHOR_EVIDENCE' });
  }
  const result = validateActivationAnchor({
    contract: executionContract,
    seal: executionSeal,
    activationAnchor: activation.anchor,
    activationState: 'ACTIVATED',
    requireActivationAnchor: true
  });
  if (result.status !== 'INTACT') {
    return proof('FAILED', { reason: result.status, findings: result.findings });
  }
  if (!view?.authorityState || view.authorityState.consistent !== true) {
    return proof('FAILED', {
      reason: 'ACTIVATION_ANCHOR_INTACT_BUT_LEDGER_AUTHORITY_NOT_CONSISTENT',
      findings: [view?.authorityState?.reason || 'AUTHORITY_STATE_ABSENT_OR_INCONSISTENT']
    });
  }
  const binding = activation.ledgerBinding;
  if (!binding || typeof binding !== 'object' || typeof binding.state !== 'string') {
    return proof('UNKNOWN', { reason: 'ACTIVATION_LEDGER_BINDING_UNREADABLE' });
  }
  if (binding.state === 'UNKNOWN') {
    return proof('UNKNOWN', { reason: binding.reason || 'ACTIVATION_LEDGER_BINDING_UNKNOWN' });
  }
  if (binding.state !== 'PROVEN') {
    return proof('FAILED', {
      reason: binding.reason || 'ACTIVATION_LEDGER_BINDING_MISMATCH',
      findings: [binding.reason || 'ACTIVATION_LEDGER_BINDING_MISMATCH']
    });
  }
  return proof('PROVEN', { evidenceRef: activation.anchor.activationId || null, ledgerBindingEventId: binding.eventId || null });
}

function derivePreflightProof(preflightOk) {
  if (preflightOk === true) return proof('PROVEN', {});
  if (preflightOk === false) return proof('FAILED', { reason: 'PREFLIGHT_FAILED' });
  return proof('UNKNOWN', { reason: 'PREFLIGHT_NOT_EXPLICITLY_PROVIDED' });
}

/**
 * @param {{ adapter: object, projectId?: string, workUnitId: string, preflightOk?: boolean }} input
 * @returns a frozen, branded ReadinessContext
 */
export function buildReadinessContext({ adapter, projectId, workUnitId, preflightOk }) {
  if (!adapter || typeof adapter.getWorkUnitView !== 'function') {
    throw new Error('BUILD_READINESS_CONTEXT_ADAPTER_REQUIRED');
  }
  if (typeof workUnitId !== 'string' || !workUnitId) {
    throw new Error('BUILD_READINESS_CONTEXT_WORK_UNIT_ID_REQUIRED');
  }
  const view = adapter.getWorkUnitView(workUnitId);
  if (!view || typeof view !== 'object' || view.workUnitId !== workUnitId) {
    throw new Error('BUILD_READINESS_CONTEXT_VIEW_IDENTITY_MISMATCH');
  }

  const executionContract = view.contract || null;
  // TJ-02: read the canonical execution seal the adapter derives on view.execution (a
  // deterministic seal over view.contract's own bytes, via seal-execution-contract.mjs) — never
  // hardcoded, never test-injected. null only when the adapter genuinely has no seal to offer
  // (e.g. no execution contract, or a contract that does not itself validate).
  const executionSeal = view.execution?.seal || null;
  const strategicContract = typeof adapter.loadStrategicContract === 'function' ? adapter.loadStrategicContract(workUnitId) : null;

  const prerequisiteStatuses = {};
  if (Array.isArray(executionContract?.prerequisites)) {
    for (const prereq of executionContract.prerequisites) {
      if (!prereq.critical) continue;
      const resolved = adapter.resolvePrerequisite(workUnitId, prereq);
      prerequisiteStatuses[prereq.id] = resolved.status === 'SATISFIED' ? 'SATISFIED' : 'UNSATISFIED';
    }
  }

  const proofs = {
    AUTHORITY_STATE: deriveAuthorityStateProof(view),
    OPEN_DEFECTS: deriveOpenDefectsProof(view),
    ACTIVATION_ANCHOR: deriveActivationProof({ view, executionContract, executionSeal }),
    PREFLIGHT: derivePreflightProof(preflightOk)
  };

  for (const slot of REQUIRED_PROOF_SLOTS) {
    if (!proofs[slot] || !PROOF_STATES.includes(proofs[slot].state)) {
      throw new Error(`READINESS_CONTEXT_INCOMPLETE:${slot}`);
    }
  }

  return Object.freeze({
    [READINESS_CONTEXT_BRAND]: true,
    schemaVersion: 1,
    workUnitId,
    projectId: projectId || adapter.projectId,
    strategicContract,
    executionContract,
    executionSeal,
    prerequisiteStatuses: Object.freeze(prerequisiteStatuses),
    requireSeal: Boolean(executionSeal),
    proofs: Object.freeze(proofs)
  });
}

export function isReadinessContext(value) {
  return Boolean(value) && typeof value === 'object' && value[READINESS_CONTEXT_BRAND] === true;
}
