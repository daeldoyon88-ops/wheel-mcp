import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { compileContext } from '../../context/compile-context.mjs';
import { createWheelContextAdapter } from './context-wheel-adapter.mjs';
import { bindFreshValidations, createEvidenceGraph, evaluateEvidenceGraph } from '../../evidence/evidence-graph.mjs';

export const WHEEL_CONTEXT_FACT = 'WHEEL_CONTEXT_FACT';

function hasGroundedR2Context(context, repoRoot) {
  if (context?.bundleKind !== 'GEE_CONTEXT_BUNDLE') return false;
  if (context.identity?.compilerVersion !== 'GEE_V1_CONTEXT_COMPILER_R2') return false;
  if (!Array.isArray(context.relevantSources) || !Array.isArray(context.facts)) return false;
  if ((context.reusableEvidenceReferences || []).some((item) => item.authorityStatus !== 'GROUNDED')) return false;
  if (typeof repoRoot !== 'string' || !context.identity?.workUnitId || !context.identity?.sourceHead) return false;
  try {
    const recomputed = compileContext({
      repoRoot,
      adapter: createWheelContextAdapter(repoRoot),
      workUnitId: context.identity.workUnitId,
      mission: { id: context.identity.mission },
      sourceHead: context.identity.sourceHead
    }).json;
    return sha256Canonical(recomputed) === sha256Canonical(context);
  } catch {
    return false;
  }
}

// The producing validation of an R2 context fact is the deterministic R2
// recompilation performed above. It is a real verification outcome, not a
// default: facts whose recompilation does not match get no validation at all.
const R2_RECOMPILATION_VALIDATION = Object.freeze({
  validator: 'GEE_V1_CONTEXT_COMPILER_R2',
  verification: 'DETERMINISTIC_R2_RECOMPILATION',
  result: 'PASS'
});

function factNode(fact, state, grounded) {
  if (!fact?.id || !fact?.provenance?.sourcePath) throw new Error('WHEEL_FACT_PROVENANCE_REQUIRED');
  return {
    evidenceId: `wheel:${fact.id}`,
    content: { factId: fact.id, value: fact.value, provenance: fact.provenance },
    evidenceType: WHEEL_CONTEXT_FACT,
    provenance: fact.provenance,
    dependencies: [`source:${fact.provenance.sourcePath}`],
    producingValidation: grounded ? R2_RECOMPILATION_VALIDATION : null,
    authorityStatus: grounded ? 'GROUNDED' : 'UNKNOWN',
    state
  };
}

export function createWheelEvidenceNodes({ context, repoRoot, evidenceItems = [], state = 'NOT_EVALUATED' } = {}) {
  if (!context || context.authorityDeclaration !== 'DERIVED / NON_AUTHORITATIVE') throw new Error('R2_CONTEXT_MUST_REMAIN_NON_AUTHORITATIVE');
  const grounded = hasGroundedR2Context(context, repoRoot);
  const facts = context.facts.map((fact) => factNode(fact, state, grounded));
  const extras = evidenceItems.map((item) => ({
    evidenceId: item.evidenceId,
    content: item.content,
    evidenceType: item.evidenceType || 'WHEEL_EVIDENCE',
    provenance: item.provenance,
    dependencies: item.dependencies || [],
    producingValidation: item.producingValidation || null,
    authorityStatus: item.authorityStatus || 'UNKNOWN',
    state: item.state || state
  }));
  return [...facts, ...extras];
}

export function createWheelEvidenceGraph({ cas, context, repoRoot, evidenceItems = [], state = 'NOT_EVALUATED', r3Delta = null } = {}) {
  const nodes = createWheelEvidenceNodes({ context, repoRoot, evidenceItems, state });
  if (!r3Delta) return createEvidenceGraph({ cas, nodes });
  // Only R2 facts whose context recompiled identically carry a producing
  // validation to bind. Caller-supplied evidence items are never bound here:
  // their producing process must bind its own outcome.
  const validationResults = Object.fromEntries(nodes
    .filter((node) => node.evidenceType === WHEEL_CONTEXT_FACT && node.authorityStatus === 'GROUNDED' && node.producingValidation)
    .map((node) => [node.evidenceId, node.producingValidation]));
  return createEvidenceGraph({ cas, nodes: bindFreshValidations({ cas, nodes, r3Delta, validationResults }) });
}

export function evaluateWheelEvidenceGraph({ cas, currentGraph, previousGraph, r3Delta } = {}) {
  return evaluateEvidenceGraph({ cas, graph: currentGraph, previousGraph, r3Delta });
}
