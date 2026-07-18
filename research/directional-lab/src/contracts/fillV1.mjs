/**
 * FillV1 — a simulated execution. Always on a session strictly after the
 * decision session (same-close fills are forbidden by construction).
 */

import { isValidCivilDate } from '../time/civilDate.mjs';

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
 * @param {unknown} fill
 * @returns {string[]}
 */
export function fillProblems(fill) {
  const problems = [];
  if (fill === null || typeof fill !== 'object') return ['fill is not an object'];
  const f = /** @type {any} */ (fill);
  if (f.schemaVersion !== FILL_SCHEMA_VERSION) problems.push(`schemaVersion must be ${FILL_SCHEMA_VERSION}`);
  if (typeof f.symbol !== 'string' || f.symbol.trim().length === 0) problems.push('symbol must be a non-empty string');
  if (!FILL_KINDS.includes(f.kind)) problems.push(`kind invalid: ${JSON.stringify(f.kind)}`);
  if (!isValidCivilDate(f.decisionDate)) problems.push(`decisionDate invalid: ${JSON.stringify(f.decisionDate)}`);
  if (!isValidCivilDate(f.fillDate)) problems.push(`fillDate invalid: ${JSON.stringify(f.fillDate)}`);
  if (isValidCivilDate(f.decisionDate) && isValidCivilDate(f.fillDate) && !(f.fillDate > f.decisionDate)) {
    problems.push('fillDate must be strictly after decisionDate');
  }
  if (typeof f.quantity !== 'number' || !Number.isFinite(f.quantity) || !Number.isInteger(f.quantity) || f.quantity === 0) {
    problems.push('quantity must be a non-zero integer');
  }
  for (const name of ['referencePrice', 'fillPrice']) {
    const v = f[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      problems.push(`${name} must be a finite number > 0`);
    }
  }
  if (typeof f.commission !== 'number' || !Number.isFinite(f.commission) || f.commission < 0) {
    problems.push('commission must be a finite number >= 0');
  }
  if (typeof f.slippageCost !== 'number' || !Number.isFinite(f.slippageCost) || f.slippageCost < 0) {
    problems.push('slippageCost must be a finite number >= 0');
  }
  if (!Array.isArray(f.notes)) problems.push('notes must be an array');
  return problems;
}

/**
 * @param {Partial<FillV1> & {symbol: string, kind: string, decisionDate: string, fillDate: string, quantity: number, referencePrice: number, fillPrice: number}} f
 * @returns {FillV1}
 */
export function createFill(f) {
  if (f === null || typeof f !== 'object') throw new Error('createFill: fill is not an object');
  if (!FILL_KINDS.includes(f.kind)) throw new Error(`Invalid fill kind: ${f.kind}`);
  if (typeof f.symbol !== 'string' || f.symbol.trim().length === 0) {
    throw new Error('createFill: symbol must be a non-empty string');
  }
  if (!isValidCivilDate(f.decisionDate) || !isValidCivilDate(f.fillDate)) {
    throw new Error('createFill: decisionDate and fillDate must be valid civil dates');
  }
  if (!(f.fillDate > f.decisionDate)) {
    throw new Error(`Causality violation: fill on ${f.fillDate} for a decision at close ${f.decisionDate}`);
  }
  if (typeof f.quantity !== 'number' || !Number.isFinite(f.quantity) || !Number.isInteger(f.quantity) || f.quantity === 0) {
    throw new Error(`fill.quantity must be a non-zero integer, got ${f.quantity}`);
  }
  for (const [k, v] of [['referencePrice', f.referencePrice], ['fillPrice', f.fillPrice]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`fill.${k} must be finite and > 0, got ${v}`);
    }
  }
  const slippageCost = f.slippageCost ?? 0;
  const commission = f.commission ?? 0;
  if (typeof slippageCost !== 'number' || !Number.isFinite(slippageCost) || slippageCost < 0) {
    throw new Error(`fill.slippageCost must be >= 0, got ${slippageCost}`);
  }
  if (typeof commission !== 'number' || !Number.isFinite(commission) || commission < 0) {
    throw new Error(`fill.commission must be >= 0, got ${commission}`);
  }
  return {
    schemaVersion: FILL_SCHEMA_VERSION,
    symbol: f.symbol.trim(),
    kind: /** @type {any} */ (f.kind),
    decisionDate: f.decisionDate,
    fillDate: f.fillDate,
    quantity: f.quantity,
    referencePrice: f.referencePrice,
    fillPrice: f.fillPrice,
    slippageCost,
    commission,
    notes: f.notes ?? [],
  };
}
