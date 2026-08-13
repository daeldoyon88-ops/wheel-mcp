import { createWheelProjectAdapter } from './wheel-project-adapter.mjs';

/**
 * The exact authority-state shape of a gate that has not started yet.
 *
 * `authorityState.consistent` answers "may this work unit's status be relied on
 * to SATISFY A PREREQUISITE for something else". A gate carrying only its
 * genesis import legitimately answers no: it has no recorded transition, so its
 * ledger trust is UNANCHORED_LEGACY. That is the normal pre-execution shape,
 * not a disagreement between authorities, and treating it as one is what made
 * R2 unable to compile a context for any future gate.
 *
 * Every clause is required and each one closes a different hole. A seal that is
 * present but invalid, a seal that disagrees with the ledger, an unverified
 * ledger, or a structurally broken canonical revision all keep `statusKnowledge`
 * away from ABSENT or `canonicalRevisionStructurallyValid` away from true, so
 * none of them can reach this branch. The reason string is matched exactly, so a
 * different or future trust deficiency is a conflict again by default.
 */
function isPreExecutionTrustLevel(view) {
  const authority = view?.authorityState;
  if (!authority || authority.consistent !== false) return false;
  return authority.reason === 'TRUST_LEVEL_BELOW_REQUIRED:UNANCHORED_LEGACY<ANCHORED_APPEND_ONLY'
    && authority.statusKnowledge === 'ABSENT'
    && authority.sealValid === false
    && authority.canonicalRevisionStructurallyValid === true
    && view.status === 'NOT_STARTED';
}

export function buildWheelContextInput(view) {
  const sources = (view.sources?.interpreted || [])
    .filter((item) => !item.includes('/generated/'))
    .filter((item) => !item.endsWith('/ACTIVE_GATE.json'))
    .map((path) => ({ path, role: path.includes('LEDGER') ? 'status authority' : 'canonical work-unit source', relevanceReason: 'required to reconstruct the selected Wheel gate context', authorityClass: path.includes('LEDGER') ? 'CANONICAL_STATUS' : 'CANONICAL' }));
  const executable = ['AUTHORIZED_NOT_STARTED', 'IN_PROGRESS'].includes(view.status);
  const contractSource = sources.find((item) => /contracts\/EXECUTION_CONTRACT_R\d{4}\.json$/.test(item.path));
  const constraints = [
    { ruleId: 'NO_FUTURE_LEAKAGE', statement: 'Do not use future or look-ahead information.', sourcePath: 'governance/PROJECT_CONSTITUTION.json', authorityClass: 'CANONICAL_RULE', selectionReason: 'applies to all governed deterministic work' },
    { ruleId: 'GIT_WRITES_FORBIDDEN_BY_DEFAULT', statement: 'Do not stage, commit, push, or otherwise write Git state.', sourcePath: 'governance/PROJECT_CONSTITUTION.json', authorityClass: 'CANONICAL_RULE', selectionReason: 'applies to autonomous execution' }
  ];
  if (executable && Array.isArray(view.contract?.authorizedPaths) && view.contract.authorizedPaths.length) {
    constraints.push({ ruleId: 'AUTHORIZED_PATHS_ONLY', statement: 'Writes must remain within the requested work-unit canonical authorized paths.', sourcePath: contractSource?.path || sources[0]?.path, sourceField: 'authorizedPaths', authorityClass: 'EXECUTION_CONTRACT', selectionReason: 'execution scope is applicable only to an executable requested work unit' });
  }
  return {
    mission: { id: `WHEEL:${view.workUnitId}`, objective: view.objective, expectedOutcome: `Operate on ${view.workUnitId} using its canonical state and contract.`, sourcePath: sources.find((item) => item.path.includes('GATE_REGISTRY'))?.path || sources[0]?.path, sourceField: 'canonicalObjective' },
    sources,
    constraints,
    // A pre-execution work unit is not an authority conflict, so it does not
    // stop compilation — but the fact is not swallowed either. It is carried
    // into the bundle as a provenance-bearing blocker, so anything reading the
    // context still sees that this gate's status cannot satisfy a prerequisite.
    authorityConflicts: view.authorityState?.consistent === false && !isPreExecutionTrustLevel(view)
      ? [view.authorityState.reason || 'AUTHORITY_STATE_INCONSISTENT']
      : [],
    blockers: isPreExecutionTrustLevel(view)
      ? [{
        code: 'PRE_EXECUTION_TRUST_LEVEL',
        detail: view.authorityState.reason,
        sourcePath: sources.find((item) => item.path.includes('LEDGER'))?.path || sources[0]?.path,
        sourceField: 'toStatus',
        authorityClass: 'CANONICAL_STATUS',
        selectionReason: 'work unit carries only its genesis import, so it cannot satisfy a prerequisite yet'
      }]
      : [],
    evidenceReferences: view.evidence || [],
    prohibitedActions: ['Do not treat this compiled context as authority.', 'Do not mutate canonical status, contracts, seals, or witnesses.', 'Do not claim capabilities not implemented by this revision.'],
    successConditions: ['Canonical status remains verified and unchanged.', 'Every selected fact retains provenance.', executable ? 'Any executable writes remain within the requested work-unit canonical authorized paths.' : 'No executable write scope is inferred for this non-executable work unit.'],
    nextAction: view.closure?.nextAction || 'Proceed with the next authorized implementation step.'
  };
}

export function createWheelContextAdapter(repoRoot) {
  const base = createWheelProjectAdapter(repoRoot);
  return {
    ...base,
    getContextInput(workUnitId) {
      return buildWheelContextInput(base.getWorkUnitView(workUnitId));
    }
  };
}
