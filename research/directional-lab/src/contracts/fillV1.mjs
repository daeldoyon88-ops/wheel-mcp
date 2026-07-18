/**
 * FillV1 — a simulated execution. Always on a session strictly after the
 * decision session (same-close fills are forbidden by construction).
 */

export const FILL_SCHEMA_VERSION = 'FillV1';

export const FILL_KINDS = Object.freeze(['OPEN_BUY', 'OPEN_SELL', 'STOP', 'GAP_STOP']);

/**
 * @typedef {Object} FillV1
 * @property {'FillV1'} schemaVersion
 * @property {string} symbol
 * @property {typeof FILL_KINDS[number]} kind
 * @property {string} decisionDate
 * @property {string} fillDate civil session date of execution (> decisionDate)
 * @property {number} quantity signed shares (+buy, -sell)
 * @property {number} referencePrice price before slippage (open or stop level)
 * @property {number} fillPrice price actually applied (slippage included)
 * @property {number} slippageCost absolute cash cost of slippage (>= 0)
 * @property {number} commission absolute cash commission (>= 0)
 * @property {string[]} notes
 */

/**
 * @param {Partial<FillV1> & {symbol: string, kind: string, decisionDate: string, fillDate: string, quantity: number, referencePrice: number, fillPrice: number}} f
 * @returns {FillV1}
 */
export function createFill(f) {
  if (!FILL_KINDS.includes(f.kind)) throw new Error(`Invalid fill kind: ${f.kind}`);
  if (!(f.fillDate > f.decisionDate)) {
    throw new Error(`Causality violation: fill on ${f.fillDate} for a decision at close ${f.decisionDate}`);
  }
  for (const [k, v] of [['quantity', f.quantity], ['referencePrice', f.referencePrice], ['fillPrice', f.fillPrice]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`fill.${k} must be finite`);
  }
  if (f.quantity === 0) throw new Error('fill.quantity cannot be 0');
  return {
    schemaVersion: FILL_SCHEMA_VERSION,
    symbol: f.symbol,
    kind: /** @type {any} */ (f.kind),
    decisionDate: f.decisionDate,
    fillDate: f.fillDate,
    quantity: f.quantity,
    referencePrice: f.referencePrice,
    fillPrice: f.fillPrice,
    slippageCost: f.slippageCost ?? 0,
    commission: f.commission ?? 0,
    notes: f.notes ?? [],
  };
}
