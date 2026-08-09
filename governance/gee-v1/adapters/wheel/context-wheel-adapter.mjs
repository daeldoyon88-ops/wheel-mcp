import { createWheelProjectAdapter } from './wheel-project-adapter.mjs';

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
    authorityConflicts: view.authorityState?.consistent === false ? [view.authorityState.reason || 'AUTHORITY_STATE_INCONSISTENT'] : [],
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
