/**
 * Synthetic non-Wheel adapter used to prove the core is project-agnostic.
 */
export function createSyntheticAdapter() {
  const units = new Map([
    ['WU_SYNTH_01', {
      schemaVersion: 1,
      projectId: 'SYNTHETIC_LAB',
      workUnitId: 'WU_SYNTH_01',
      workUnitType: 'EXPERIMENT',
      status: 'AUTHORIZED_NOT_STARTED',
      objective: 'Synthetic work unit unknown to Wheel',
      stateRevision: null,
      contract: null,
      prerequisites: [],
      dependencies: [],
      evidence: [],
      closure: null,
      defectsOpenCount: 0,
      defectsOpenKnowledge: 'KNOWN_ZERO',
      sources: { interpreted: ['synthetic://memory'], copiedAuthority: false },
      compatibility: { synthetic: true }
    }],
    ['WU_NEVER_HARDCODED_IN_CORE', {
      schemaVersion: 1,
      projectId: 'SYNTHETIC_LAB',
      workUnitId: 'WU_NEVER_HARDCODED_IN_CORE',
      workUnitType: 'EXPERIMENT',
      status: 'NOT_STARTED',
      objective: 'Proves core accepts arbitrary workUnitId',
      stateRevision: null,
      contract: null,
      prerequisites: [],
      dependencies: [],
      evidence: [],
      closure: null,
      defectsOpenCount: 0,
      defectsOpenKnowledge: 'KNOWN_ZERO',
      sources: { interpreted: ['synthetic://memory'], copiedAuthority: false },
      compatibility: { synthetic: true }
    }]
  ]);

  return {
    projectId: 'SYNTHETIC_LAB',
    workUnitType: 'EXPERIMENT',
    listWorkUnitIds() {
      return [...units.keys()];
    },
    getWorkUnitView(id) {
      const view = units.get(id);
      if (!view) throw new Error(`UNKNOWN_WORK_UNIT:${id}`);
      return view;
    },
    resolvePrerequisite() {
      return { status: 'SATISFIED' };
    }
  };
}
