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
