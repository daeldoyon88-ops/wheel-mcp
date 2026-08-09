import { createSnapshot } from '../../delta/delta-engine.mjs';

export function createWheelDeltaSnapshot({ repoRoot, context } = {}) {
  if (!context || context.authorityDeclaration !== 'DERIVED / NON_AUTHORITATIVE') throw new Error('R2_CONTEXT_MUST_REMAIN_NON_AUTHORITATIVE');
  return createSnapshot({ repoRoot, sources: context.relevantSources.map((source) => ({ path: source.path, sha256: source.sha256, provenance: { sourcePath: source.path, authorityClass: source.role } })), facts: context.facts.map((fact) => ({ id: fact.id, value: fact.value, dependencies: [fact.provenance.sourcePath], provenance: fact.provenance })) });
}
