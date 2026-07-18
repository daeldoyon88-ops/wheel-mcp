/**
 * BacktestResultV1 — the full deterministic output of one backtest run.
 * Contains no wall-clock timestamps so that two identical runs hash equal.
 */

import { createHash } from 'node:crypto';

export const BACKTEST_RESULT_SCHEMA_VERSION = 'BacktestResultV1';

/**
 * @typedef {Object} BacktestResultV1
 * @property {'BacktestResultV1'} schemaVersion
 * @property {string} symbol
 * @property {string} strategyId
 * @property {string} strategyVersion
 * @property {Object} parameters
 * @property {string} priceBasis
 * @property {Object} costsConfig
 * @property {string|null} firstDate
 * @property {string|null} lastDate
 * @property {number} bars
 * @property {Array} trades
 * @property {Array} fills
 * @property {Array<{sessionDate: string, equity: number, cash: number, quantity: number}>} equityCurve
 * @property {number} totalDividendsCash cash dividends credited, kept separate from trade PnL/commissions/slippage
 * @property {Array} corporateActionEvents deterministic audit trail (SPLIT, CASH_DIVIDEND, *_ALREADY_EMBEDDED)
 * @property {Object} metrics
 * @property {string[]} warnings
 * @property {string} resultHash sha256 of the stable serialization (excluding itself)
 */

/**
 * Deterministic JSON: keys sorted at every level, arrays kept in order.
 * Throws on NaN/Infinity so they can never be serialized.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

/** @param {unknown} v @returns {unknown} */
function sortValue(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) {
    throw new Error(`Non-finite number cannot be serialized: ${v}`);
  }
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(v).sort()) out[key] = sortValue(/** @type {any} */ (v)[key]);
    return out;
  }
  return v;
}

/**
 * sha256 of the stable serialization of a value.
 * @param {unknown} value
 * @returns {string}
 */
export function stableHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Attach the deterministic resultHash to a result object.
 * @param {Object} result BacktestResultV1 without resultHash
 * @returns {Object} the same object with resultHash set
 */
export function withResultHash(result) {
  const { resultHash: _ignored, ...rest } = /** @type {any} */ (result);
  return { ...rest, resultHash: stableHash(rest) };
}
