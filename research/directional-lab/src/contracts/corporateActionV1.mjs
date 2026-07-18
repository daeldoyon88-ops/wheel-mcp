/**
 * CorporateActionV1 — split / dividend event, kept separate from price bars.
 * Events are never forward-filled and never merged silently into prices.
 */

import { isValidCivilDate } from '../time/civilDate.mjs';

export const CORPORATE_ACTION_SCHEMA_VERSION = 'CorporateActionV1';

export const CORPORATE_ACTION_TYPES = Object.freeze(['SPLIT', 'CASH_DIVIDEND']);

/**
 * @typedef {Object} CorporateActionV1
 * @property {'CorporateActionV1'} schemaVersion
 * @property {string} symbol
 * @property {'SPLIT'|'CASH_DIVIDEND'} type
 * @property {string} effectiveDate civil date the action applies (ex-date)
 * @property {number|null} splitFactor shares multiplier (2 for a 2:1 split), null for dividends
 * @property {number|null} cashAmount per-share cash, null for splits
 * @property {string} source
 */

/**
 * @param {unknown} action
 * @returns {string[]} problems, empty when valid
 */
export function corporateActionProblems(action) {
  const problems = [];
  if (action === null || typeof action !== 'object') return ['action is not an object'];
  const a = /** @type {any} */ (action);
  if (a.schemaVersion !== CORPORATE_ACTION_SCHEMA_VERSION) problems.push(`schemaVersion must be ${CORPORATE_ACTION_SCHEMA_VERSION}`);
  if (typeof a.symbol !== 'string' || !a.symbol) problems.push('symbol required');
  if (!CORPORATE_ACTION_TYPES.includes(a.type)) problems.push(`type must be one of ${CORPORATE_ACTION_TYPES.join(', ')}`);
  if (!isValidCivilDate(a.effectiveDate)) problems.push('effectiveDate must be a civil date');
  if (a.type === 'SPLIT') {
    if (typeof a.splitFactor !== 'number' || !Number.isFinite(a.splitFactor) || a.splitFactor <= 0) {
      problems.push('SPLIT requires a positive finite splitFactor');
    }
  }
  if (a.type === 'CASH_DIVIDEND') {
    if (typeof a.cashAmount !== 'number' || !Number.isFinite(a.cashAmount) || a.cashAmount < 0) {
      problems.push('CASH_DIVIDEND requires a non-negative finite cashAmount');
    }
  }
  if (typeof a.source !== 'string' || !a.source) problems.push('source required');
  return problems;
}
