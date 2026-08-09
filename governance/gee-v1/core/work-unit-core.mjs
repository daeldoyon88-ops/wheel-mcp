/**
 * GEE V1 project-agnostic work-unit core.
 * FORBIDDEN: hardcoding project-specific work-unit IDs or domain facts.
 */

export function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('ADAPTER_REQUIRED');
  }
  if (typeof adapter.projectId !== 'string' || adapter.projectId.length === 0) {
    throw new Error('ADAPTER_PROJECT_ID_REQUIRED');
  }
  if (typeof adapter.listWorkUnitIds !== 'function') {
    throw new Error('ADAPTER_LIST_REQUIRED');
  }
  if (typeof adapter.getWorkUnitView !== 'function') {
    throw new Error('ADAPTER_GET_REQUIRED');
  }
  if (typeof adapter.resolvePrerequisite !== 'function') {
    throw new Error('ADAPTER_PREREQ_REQUIRED');
  }
}

export function createProjectSession(adapter) {
  assertAdapter(adapter);
  return {
    projectId: adapter.projectId,
    workUnitType: adapter.workUnitType || 'WORK_UNIT',
    listWorkUnitIds() {
      const ids = adapter.listWorkUnitIds();
      if (!Array.isArray(ids)) throw new Error('ADAPTER_LIST_MUST_RETURN_ARRAY');
      return ids.map(String);
    },
    getWorkUnit(workUnitId) {
      if (typeof workUnitId !== 'string' || workUnitId.length === 0) {
        throw new Error('WORK_UNIT_ID_REQUIRED');
      }
      const view = adapter.getWorkUnitView(workUnitId);
      if (!view || typeof view !== 'object') throw new Error('WORK_UNIT_VIEW_MISSING');
      if (view.workUnitId !== workUnitId) throw new Error('WORK_UNIT_ID_MISMATCH');
      if (view.projectId !== adapter.projectId) throw new Error('PROJECT_ID_MISMATCH');
      if (view.sources?.copiedAuthority === true) throw new Error('SECOND_AUTHORITY_FORBIDDEN');
      return view;
    },
    resolvePrerequisite(workUnitId, prerequisite) {
      return adapter.resolvePrerequisite(workUnitId, prerequisite);
    }
  };
}

/* ---------------------------------------------------------------------------
 * Execution-authority resolution (PROJECT -> WORK_UNIT).
 *
 * Before this layer existed, execution authority was resolved by exactly one
 * project-specific pointer, so only one work-unit type could ever be
 * authorized and every other kind of work unit had to impersonate it. The
 * resolution below is the generic half: it ROUTES a requested work unit to
 * exactly one authority source and then applies the fail-closed rules that
 * hold for EVERY work-unit type, whatever the project.
 *
 * What it deliberately does NOT do is interpret contracts. Two work-unit types
 * of the same project may carry entirely different contract documents,
 * integrity mechanisms and prerequisite vocabularies; interpreting them is the
 * adapter's job, exactly as getWorkUnitView already is. The core therefore
 * requires each source to report its evidence as an explicit four-state proof
 * and refuses to upgrade anything by absence.
 * ------------------------------------------------------------------------- */

export const AUTHORITY_AUTHORIZED = 'AUTHORIZED';
export const AUTHORITY_BLOCKED = 'BLOCKED';

/**
 * The proofs every authority source must report, whatever the project or the
 * work-unit type. A source that omits one leaves it UNKNOWN, which is BLOCKED.
 * NOT_APPLICABLE is honoured only when the source also states a reason — an
 * unexplained NOT_APPLICABLE is indistinguishable from a forgotten check.
 */
export const REQUIRED_AUTHORITY_PROOFS = Object.freeze([
  'EXECUTION_CONTRACT',
  'CONTRACT_INTEGRITY',
  'PREREQUISITES',
  'WORK_UNIT_EXECUTABLE'
]);

const PROOF_STATES = Object.freeze(['PROVEN', 'FAILED', 'UNKNOWN', 'NOT_APPLICABLE']);

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function assertAuthoritySource(source) {
  return Boolean(
    source
    && typeof source === 'object'
    && typeof source.projectId === 'string' && source.projectId
    && typeof source.workUnitType === 'string' && source.workUnitType
    && typeof source.resolveWorkUnitAuthority === 'function'
  );
}

/**
 * Holds every authority source known to a session. Duplicates are NOT rejected
 * at construction time on purpose: two components each claiming authority over
 * the same work-unit type is precisely the "two contradictory authorities"
 * condition, and it must surface as a BLOCKED resolution with a named finding
 * rather than as a constructor throw that a caller might catch and ignore.
 */
export function createExecutionAuthorityRegistry(sources = []) {
  const list = Array.isArray(sources) ? sources : [];
  const malformed = list.filter((source) => !assertAuthoritySource(source));
  return {
    sources: list,
    malformedCount: malformed.length,
    listWorkUnitTypes() {
      return [...new Set(list.filter(assertAuthoritySource).map((source) => `${source.projectId}:${source.workUnitType}`))];
    },
    match(projectId, workUnitType) {
      return list.filter(
        (source) => assertAuthoritySource(source) && source.projectId === projectId && source.workUnitType === workUnitType
      );
    }
  };
}

/**
 * Is `repoRelativePath` inside the write scope an authority actually granted?
 *
 * Prefix semantics, because that is what the existing authorizedPaths
 * vocabulary already is: an entry ending in "/" scopes a directory, any other
 * entry scopes a filename prefix. Separator style is normalised; absolute
 * paths and traversal are rejected before matching, so no candidate can escape
 * its own scope by spelling.
 */
export function isPathAuthorized(authorizedPaths, repoRelativePath) {
  if (typeof repoRelativePath !== 'string' || repoRelativePath.length === 0) return false;
  const candidate = repoRelativePath.split('\\').join('/');
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return false;
  if (candidate.split('/').includes('..')) return false;
  if (!Array.isArray(authorizedPaths) || authorizedPaths.length === 0) return false;
  return authorizedPaths.some((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) return false;
    const scope = entry.split('\\').join('/');
    return candidate.startsWith(scope) && candidate.length > scope.length;
  });
}

/**
 * Resolve whether a REQUESTED work unit authorizes execution.
 *
 * The request is explicit and reproducible: nothing here inspects an "active"
 * pointer, an environment variable or any ambient state to guess what the
 * caller meant. An unrecognised work-unit type is BLOCKED, never redirected to
 * whichever type happens to have a default.
 */
export function resolveExecutionAuthority({ projectId, workUnitType, workUnitId, registry } = {}) {
  const findings = [];
  const blocked = (extra = {}) => ({
    schemaVersion: 1,
    projectId: projectId ?? null,
    workUnitType: workUnitType ?? null,
    workUnitId: workUnitId ?? null,
    decision: AUTHORITY_BLOCKED,
    executionAuthorized: false,
    findings,
    proofs: {},
    authorizedPaths: [],
    contract: null,
    authoritySource: null,
    ...extra
  });

  if (typeof projectId !== 'string' || !projectId) finding(findings, 'PROJECT_ID_REQUIRED');
  if (typeof workUnitType !== 'string' || !workUnitType) finding(findings, 'WORK_UNIT_TYPE_REQUIRED');
  if (typeof workUnitId !== 'string' || !workUnitId) finding(findings, 'WORK_UNIT_ID_REQUIRED');
  if (!registry || typeof registry.match !== 'function') finding(findings, 'AUTHORITY_REGISTRY_REQUIRED');
  if (findings.length) return blocked();

  const matches = registry.match(projectId, workUnitType);
  if (matches.length === 0) {
    finding(findings, 'UNKNOWN_WORK_UNIT_TYPE', `${projectId}:${workUnitType}`);
    return blocked();
  }
  if (matches.length > 1) {
    finding(findings, 'CONFLICTING_AUTHORITY', `${matches.length} sources claim ${projectId}:${workUnitType}`);
    return blocked();
  }

  const source = matches[0];
  const sourceId = source.sourceId || `${projectId}:${workUnitType}`;
  let resolved;
  try {
    resolved = source.resolveWorkUnitAuthority(workUnitId);
  } catch (error) {
    finding(findings, 'AUTHORITY_SOURCE_ERROR', error?.message || String(error));
    return blocked({ authoritySource: sourceId });
  }

  if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
    finding(findings, 'UNKNOWN_WORK_UNIT_ID', workUnitId);
    return blocked({ authoritySource: sourceId });
  }
  if (resolved.workUnitId !== workUnitId) {
    finding(findings, 'WORK_UNIT_ID_MISMATCH', String(resolved.workUnitId));
    return blocked({ authoritySource: sourceId });
  }
  for (const reported of Array.isArray(resolved.findings) ? resolved.findings : []) {
    findings.push(typeof reported === 'string' ? { code: reported } : reported);
  }

  const proofs = {};
  for (const proofId of REQUIRED_AUTHORITY_PROOFS) {
    const reported = (resolved.proofs || {})[proofId];
    const state = PROOF_STATES.includes(reported?.state) ? reported.state : 'UNKNOWN';
    const reason = typeof reported?.reason === 'string' && reported.reason ? reported.reason : null;
    proofs[proofId] = { state, reason };
    if (state === 'PROVEN') continue;
    if (state === 'NOT_APPLICABLE' && reason) continue;
    if (state === 'NOT_APPLICABLE') finding(findings, 'PROOF_NOT_APPLICABLE_WITHOUT_REASON', proofId);
    else finding(findings, `PROOF_${state}`, reason ? `${proofId}: ${reason}` : proofId);
  }

  const authorizedPaths = Array.isArray(resolved.authorizedPaths) ? resolved.authorizedPaths.filter((p) => typeof p === 'string' && p) : [];
  if (authorizedPaths.length === 0) finding(findings, 'WRITE_SCOPE_UNDECLARED', workUnitId);

  const decision = findings.length === 0 ? AUTHORITY_AUTHORIZED : AUTHORITY_BLOCKED;
  return {
    schemaVersion: 1,
    projectId,
    workUnitType,
    workUnitId,
    decision,
    executionAuthorized: decision === AUTHORITY_AUTHORIZED,
    findings,
    proofs,
    authorizedPaths,
    contract: resolved.contract || null,
    authoritySource: sourceId
  };
}
