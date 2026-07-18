/**
 * SignalV1 — a strategy decision (an intention, never an executed trade).
 * A decision made at close t is executable at the earliest at open t+1.
 */

export const SIGNAL_SCHEMA_VERSION = 'SignalV1';

export const INTENTS = Object.freeze([
  'ENTER_LONG',
  'HOLD',
  'REDUCE_25',
  'REDUCE_50',
  'EXIT',
  'NO_ACTION',
]);

/**
 * @typedef {Object} SignalV1
 * @property {'SignalV1'} schemaVersion
 * @property {string} symbol
 * @property {typeof INTENTS[number]} intent
 * @property {string} decisionDate civil session date whose close produced the decision
 * @property {string} decisionTime UTC ISO instant (close of decisionDate)
 * @property {string} availableAt UTC ISO instant the decision could be acted on
 * @property {string[]} reasons
 * @property {string|null} invalidation human-readable invalidation condition
 * @property {number|null} confidence optional 0..1
 * @property {string} strategyId
 * @property {string} strategyVersion
 * @property {Object} parameters
 * @property {number|null} stopLevel trailing/protective stop active from next session
 */

/**
 * Build a validated SignalV1.
 * @param {Partial<SignalV1> & {symbol: string, intent: string, decisionDate: string, decisionTime: string, strategyId: string, strategyVersion: string}} s
 * @returns {SignalV1}
 */
export function createSignal(s) {
  if (!INTENTS.includes(s.intent)) throw new Error(`Invalid intent: ${s.intent}`);
  if (typeof s.decisionDate !== 'string') throw new Error('decisionDate required');
  if (typeof s.decisionTime !== 'string') throw new Error('decisionTime required');
  const availableAt = s.availableAt ?? s.decisionTime;
  if (availableAt < s.decisionTime) throw new Error('availableAt cannot precede decisionTime');
  if (s.confidence !== undefined && s.confidence !== null) {
    if (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1) {
      throw new Error('confidence must be null or in [0,1]');
    }
  }
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    symbol: s.symbol,
    intent: /** @type {any} */ (s.intent),
    decisionDate: s.decisionDate,
    decisionTime: s.decisionTime,
    availableAt,
    reasons: s.reasons ?? [],
    invalidation: s.invalidation ?? null,
    confidence: s.confidence ?? null,
    strategyId: s.strategyId,
    strategyVersion: s.strategyVersion,
    parameters: s.parameters ?? {},
    stopLevel: s.stopLevel ?? null,
  };
}
