/**
 * Minimal extension-point declarations for R2+.
 * These are interfaces only — no engine implementation in R1.
 */

export const EXTENSION_POINTS = Object.freeze({
  contextCompilation: {
    id: 'CONTEXT_COMPILATION',
    status: 'DECLARED_NOT_IMPLEMENTED',
    targetRevision: 'R2'
  },
  evidence: {
    id: 'EVIDENCE_GRAPH',
    status: 'DECLARED_NOT_IMPLEMENTED',
    targetRevision: 'R4'
  },
  delta: {
    id: 'DELTA_ENGINE',
    status: 'DECLARED_NOT_IMPLEMENTED',
    targetRevision: 'R3'
  },
  routing: {
    id: 'ADAPTIVE_MODEL_ROUTER',
    status: 'DECLARED_NOT_IMPLEMENTED',
    targetRevision: 'R5'
  },
  recovery: {
    id: 'FAILURE_RECOVERY',
    status: 'DECLARED_NOT_IMPLEMENTED',
    targetRevision: 'R6'
  }
});

export function getExtensionPoint(id) {
  return Object.values(EXTENSION_POINTS).find((point) => point.id === id) || null;
}

export function assertNoEngineImplementation(moduleExports = {}) {
  const forbidden = ['compileMissionContext', 'buildEvidenceGraph', 'classifyDelta', 'routeModel', 'resumeFromFailure'];
  for (const name of forbidden) {
    if (typeof moduleExports[name] === 'function') {
      throw new Error(`R2_PLUS_ENGINE_FORBIDDEN:${name}`);
    }
  }
  return true;
}
