/**
 * GEE V1 core — identity binding.
 * RC-1/RC-2 support: EXPECTED IDENTITY MUST MATCH PROVEN IDENTITY at every
 * authority boundary crossing. Evidence whose subject is not proven is not
 * evidence — it is discarded, never downgraded.
 *
 * Project-agnostic: the core knows only (projectId, workUnitId, subtreePrefix).
 * Adapters supply the projection (e.g. workUnitId <-> gateId <-> filesystem path).
 */

export const BOUND = 'BOUND';
export const VIOLATION = 'VIOLATION';

function normalizeSlashes(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/') : value;
}

/**
 * @param {{ projectId?: string, workUnitId: string, subtreePrefix?: string }} expected
 * @param {Array<{ source: string, projectId?: string, workUnitId?: string, path?: string }>} claims
 *   A claim asserts identity only for the fields it defines. A claim that defines
 *   none of projectId/workUnitId/path is ignored (it makes no identity assertion).
 * @returns {{ status: 'BOUND'|'VIOLATION', violations: Array<object> }}
 */
export function assertIdentityBinding(expected, claims = []) {
  if (!expected || typeof expected !== 'object' || typeof expected.workUnitId !== 'string' || !expected.workUnitId) {
    return { status: VIOLATION, violations: [{ source: 'expected', reason: 'EXPECTED_WORK_UNIT_ID_REQUIRED' }] };
  }
  if (!Array.isArray(claims)) {
    return { status: VIOLATION, violations: [{ source: 'claims', reason: 'CLAIMS_MUST_BE_ARRAY' }] };
  }

  const violations = [];
  const prefix = expected.subtreePrefix ? normalizeSlashes(expected.subtreePrefix) : null;

  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') {
      violations.push({ source: 'unknown', reason: 'CLAIM_NOT_AN_OBJECT' });
      continue;
    }
    const source = claim.source || 'unnamed-claim';
    if (claim.projectId !== undefined && expected.projectId !== undefined && claim.projectId !== expected.projectId) {
      violations.push({ source, reason: 'PROJECT_ID_MISMATCH', expected: expected.projectId, actual: claim.projectId });
    }
    if (claim.workUnitId !== undefined && claim.workUnitId !== expected.workUnitId) {
      violations.push({ source, reason: 'WORK_UNIT_ID_MISMATCH', expected: expected.workUnitId, actual: claim.workUnitId });
    }
    if (claim.path !== undefined) {
      const normalized = normalizeSlashes(claim.path);
      if (!prefix) {
        violations.push({ source, reason: 'SUBTREE_PREFIX_NOT_DECLARED', actual: normalized });
      } else if (typeof normalized !== 'string' || !normalized.startsWith(prefix)) {
        violations.push({ source, reason: 'PATH_OUTSIDE_WORK_UNIT_SUBTREE', expected: prefix, actual: normalized });
      }
    }
  }

  return violations.length === 0 ? { status: BOUND, violations: [] } : { status: VIOLATION, violations };
}
