export const OUTCOME_STATUSES = Object.freeze(['RESOLVED', 'INSUFFICIENT_DATA', 'FAIL_CLOSED']);
export function createOutcomeRecord({ asOf, now, outcomeId, status, reason = null, payload = null }) {
  if (!asOf || !now || now < asOf) return null;
  if (!outcomeId || !OUTCOME_STATUSES.includes(status)) throw new Error('OUTCOME_TERMINAL_RECORD_INVALID');
  if ((status === 'RESOLVED') !== (reason === null)) throw new Error('OUTCOME_REASON_INVARIANT');
  return Object.freeze({ outcomeId, status, reason, payload });
}
export function appendOutcome(store, record) {
  if (!record) return store;
  if (!Array.isArray(store) || store.some((item) => item.outcomeId === record.outcomeId)) throw new Error('OUTCOME_APPEND_ONLY');
  return Object.freeze([...store, record]);
}
