export function createGeeR2SyntheticAdapter() {
  const view = {
    schemaVersion: 1, projectId: 'SYNTHETIC_LAB', workUnitId: 'SYNTH_01', workUnitType: 'EXPERIMENT',
    status: 'AUTHORIZED_NOT_STARTED', objective: 'Synthetic objective', state: { value: 'AUTHORIZED_NOT_STARTED', verified: true, identityBinding: 'BOUND', trustLevel: 'ANCHORED_APPEND_ONLY', authority: { ref: 'fixtures/canonical.json' } },
    prerequisites: [], closure: null, defectsOpenCount: 0, defectsOpenKnowledge: 'KNOWN_ZERO', evidence: [], sources: { interpreted: ['fixtures/canonical.json'], copiedAuthority: false }
  };
  return {
    projectId: 'SYNTHETIC_LAB', workUnitType: 'EXPERIMENT', listWorkUnitIds: () => ['SYNTH_01'],
    getWorkUnitView: (id) => { if (id !== 'SYNTH_01') throw new Error(`UNKNOWN_WORK_UNIT:${id}`); return view; },
    getContextInput: () => ({ mission: { id: 'SYNTHETIC_MISSION', objective: 'Synthetic objective', sourcePath: 'fixtures/canonical.json', sourceField: 'objective' }, sources: [{ path: 'fixtures/canonical.json', role: 'synthetic canonical source', relevanceReason: 'fixture authority' }], constraints: [{ ruleId: 'SYNTH_RULE', statement: 'Synthetic rule', sourcePath: 'fixtures/canonical.json' }], successConditions: ['Synthetic output is deterministic'], prohibitedActions: ['Do not treat derived output as authority'], nextAction: 'Run the synthetic mission.' })
  };
}
