/**
 * MarketRegimeSnapshotV1 — deterministic market regime for one civil date.
 * Missing coverage is NEVER mapped to a neutral regime: it becomes UNKNOWN.
 */

export const MARKET_REGIME_SCHEMA_VERSION = 'MarketRegimeSnapshotV1';

export const REGIME_STATES = Object.freeze([
  'RISK_ON',
  'MIXED',
  'RISK_OFF',
  'PANIC',
  'PANIC_RECOVERY',
  'UNKNOWN',
]);

/**
 * @typedef {Object} MarketRegimeSnapshotV1
 * @property {'MarketRegimeSnapshotV1'} schemaVersion
 * @property {string} sessionDate
 * @property {string} asOf
 * @property {string} availableAt
 * @property {typeof REGIME_STATES[number]} state
 * @property {string[]} inputsUsed benchmarks actually used (e.g. QQQ, SPY, VIX)
 * @property {string[]} inputsMissing benchmarks unavailable at this date
 * @property {string[]} reasons rule trail that produced the state
 * @property {string} engineVersion
 */

/**
 * @param {unknown} snapshot
 * @returns {string[]} problems, empty when valid
 */
export function marketRegimeSnapshotProblems(snapshot) {
  const problems = [];
  if (snapshot === null || typeof snapshot !== 'object') return ['snapshot is not an object'];
  const s = /** @type {any} */ (snapshot);
  if (s.schemaVersion !== MARKET_REGIME_SCHEMA_VERSION) problems.push(`schemaVersion must be ${MARKET_REGIME_SCHEMA_VERSION}`);
  if (!REGIME_STATES.includes(s.state)) problems.push(`state invalid: ${JSON.stringify(s.state)}`);
  if (typeof s.sessionDate !== 'string') problems.push('sessionDate required');
  if (typeof s.availableAt !== 'string') problems.push('availableAt required');
  if (!Array.isArray(s.inputsUsed)) problems.push('inputsUsed must be an array');
  if (!Array.isArray(s.reasons)) problems.push('reasons must be an array');
  return problems;
}
