/**
 * OrderV1 — a pending simulated order. Created from a SignalV1 at close t,
 * eligible for execution no earlier than the open of the next session.
 */

export const ORDER_SCHEMA_VERSION = 'OrderV1';

export const ORDER_TYPES = Object.freeze(['MARKET_OPEN_BUY', 'MARKET_OPEN_SELL', 'STOP_SELL']);

/**
 * @typedef {Object} OrderV1
 * @property {'OrderV1'} schemaVersion
 * @property {string} symbol
 * @property {typeof ORDER_TYPES[number]} type
 * @property {string} decisionDate civil date whose close created the order
 * @property {string} earliestFillDate civil date of the first session the order may fill (must be > decisionDate)
 * @property {number|null} quantity shares; null = engine sizes at fill (all-in / full position)
 * @property {number|null} fraction for partial exits (0.25, 0.5), null otherwise
 * @property {number|null} stopLevel for STOP_SELL
 * @property {string[]} reasons
 * @property {string} strategyId
 */

/**
 * Build a validated OrderV1. Enforces the same-close prohibition:
 * earliestFillDate must be strictly after decisionDate.
 * @param {Partial<OrderV1> & {symbol: string, type: string, decisionDate: string, earliestFillDate: string}} o
 * @returns {OrderV1}
 */
export function createOrder(o) {
  if (!ORDER_TYPES.includes(o.type)) throw new Error(`Invalid order type: ${o.type}`);
  if (!(o.earliestFillDate > o.decisionDate)) {
    throw new Error(
      `Causality violation: order decided at close ${o.decisionDate} cannot fill on or before that session (earliestFillDate=${o.earliestFillDate})`
    );
  }
  if (o.type === 'STOP_SELL' && (typeof o.stopLevel !== 'number' || !Number.isFinite(o.stopLevel))) {
    throw new Error('STOP_SELL requires a finite stopLevel');
  }
  return {
    schemaVersion: ORDER_SCHEMA_VERSION,
    symbol: o.symbol,
    type: /** @type {any} */ (o.type),
    decisionDate: o.decisionDate,
    earliestFillDate: o.earliestFillDate,
    quantity: o.quantity ?? null,
    fraction: o.fraction ?? null,
    stopLevel: o.stopLevel ?? null,
    reasons: o.reasons ?? [],
    strategyId: o.strategyId ?? 'unknown',
  };
}
