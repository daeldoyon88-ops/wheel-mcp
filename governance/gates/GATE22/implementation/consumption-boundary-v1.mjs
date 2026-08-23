export function authorizeConsumption({ gateId, namespace, features = [], selectionComplete = false }) {
  if (gateId === 'GATE23') return features.some((feature) => /outcome/i.test(feature)) ? { status: 'BLOCKED', code: 'GATE23_OUTCOME_FEATURE_FORBIDDEN' } : { status: 'ALLOWED' };
  if (gateId === 'GATE24') return namespace === 'GATE24' ? { status: 'ALLOWED' } : { status: 'BLOCKED', code: 'GATE24_SEPARATE_NAMESPACE_REQUIRED' };
  if (gateId === 'GATE25') return selectionComplete ? { status: 'ALLOWED' } : { status: 'BLOCKED', code: 'GATE25_SELECTION_REQUIRED' };
  return { status: 'BLOCKED', code: 'UNKNOWN_CONSUMER' };
}
