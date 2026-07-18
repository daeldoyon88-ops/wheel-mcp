/**
 * OrderV1 — a pending simulated order. Created from a SignalV1 at close t,
 * eligible for execution no earlier than the open of the next session.
 */

import { isValidCivilDate } from '../time/civilDate.mjs';
import { isStrictUtcIsoInstant } from './dailyBarV1.mjs';

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
 * @param {unknown} order
 * @returns {string[]}
 */
export function orderProblems(order) {
  const problems = [];
  if (order === null || typeof order !== 'object') return ['order is not an object'];
  const o = /** @type {any} */ (order);
  if (o.schemaVersion !== ORDER_SCHEMA_VERSION) problems.push(`schemaVersion must be ${ORDER_SCHEMA_VERSION}`);
  if (typeof o.symbol !== 'string' || o.symbol.trim().length === 0) problems.push('symbol must be a non-empty string');
  if (!ORDER_TYPES.includes(o.type)) problems.push(`type invalid: ${JSON.stringify(o.type)}`);
  if (!isValidCivilDate(o.decisionDate)) problems.push(`decisionDate invalid: ${JSON.stringify(o.decisionDate)}`);
  if (!isValidCivilDate(o.earliestFillDate)) problems.push(`earliestFillDate invalid: ${JSON.stringify(o.earliestFillDate)}`);
  if (isValidCivilDate(o.decisionDate) && isValidCivilDate(o.earliestFillDate) && !(o.earliestFillDate > o.decisionDate)) {
    problems.push('earliestFillDate must be strictly after decisionDate');
  }
  if (o.quantity !== null && o.quantity !== undefined) {
    if (typeof o.quantity !== 'number' || !Number.isFinite(o.quantity) || !Number.isInteger(o.quantity) || o.quantity <= 0) {
      problems.push('quantity must be null or a strictly positive integer');
    }
  }
  if (o.fraction !== null && o.fraction !== undefined) {
    if (typeof o.fraction !== 'number' || !Number.isFinite(o.fraction) || !(o.fraction > 0 && o.fraction <= 1)) {
      problems.push('fraction must be null or a finite number in (0, 1]');
    }
  }
  if (o.type === 'STOP_SELL') {
    if (typeof o.stopLevel !== 'number' || !Number.isFinite(o.stopLevel) || o.stopLevel <= 0) {
      problems.push('STOP_SELL requires stopLevel finite and > 0');
    }
  } else if (o.stopLevel !== null && o.stopLevel !== undefined) {
    if (typeof o.stopLevel !== 'number' || !Number.isFinite(o.stopLevel) || o.stopLevel <= 0) {
      problems.push('stopLevel must be null or a finite number > 0');
    }
  }
  if (o.availableAt !== undefined && o.availableAt !== null && !isStrictUtcIsoInstant(o.availableAt)) {
    problems.push('availableAt must be a real UTC ISO instant when present');
  }
  if (!Array.isArray(o.reasons)) problems.push('reasons must be an array');
  if (typeof o.strategyId !== 'string') problems.push('strategyId must be a string');
  return problems;
}

/**
 * Build a validated OrderV1. Enforces the same-close prohibition:
 * earliestFillDate must be strictly after decisionDate.
 * @param {Partial<OrderV1> & {symbol: string, type: string, decisionDate: string, earliestFillDate: string}} o
 * @returns {OrderV1}
 */
export function createOrder(o) {
  if (o === null || typeof o !== 'object') throw new Error('createOrder: order is not an object');
  if (!ORDER_TYPES.includes(o.type)) throw new Error(`Invalid order type: ${o.type}`);
  if (typeof o.symbol !== 'string' || o.symbol.trim().length === 0) {
    throw new Error('createOrder: symbol must be a non-empty string');
  }
  if (!isValidCivilDate(o.decisionDate)) throw new Error(`createOrder: invalid decisionDate ${JSON.stringify(o.decisionDate)}`);
  if (!isValidCivilDate(o.earliestFillDate)) throw new Error(`createOrder: invalid earliestFillDate ${JSON.stringify(o.earliestFillDate)}`);
  if (!(o.earliestFillDate > o.decisionDate)) {
    throw new Error(
      `Causality violation: order decided at close ${o.decisionDate} cannot fill on or before that session (earliestFillDate=${o.earliestFillDate})`
    );
  }
  if (o.quantity !== null && o.quantity !== undefined) {
    if (typeof o.quantity !== 'number' || !Number.isFinite(o.quantity) || !Number.isInteger(o.quantity) || o.quantity <= 0) {
      throw new Error(`createOrder: quantity must be a strictly positive integer, got ${o.quantity}`);
    }
  }
  if (o.fraction !== null && o.fraction !== undefined) {
    if (typeof o.fraction !== 'number' || !Number.isFinite(o.fraction) || !(o.fraction > 0 && o.fraction <= 1)) {
      throw new Error(`createOrder: fraction must be in (0, 1], got ${o.fraction}`);
    }
  }
  if (o.type === 'STOP_SELL') {
    if (typeof o.stopLevel !== 'number' || !Number.isFinite(o.stopLevel) || o.stopLevel <= 0) {
      throw new Error('STOP_SELL requires a finite stopLevel > 0');
    }
  } else if (o.stopLevel !== null && o.stopLevel !== undefined) {
    if (typeof o.stopLevel !== 'number' || !Number.isFinite(o.stopLevel) || o.stopLevel <= 0) {
      throw new Error(`createOrder: stopLevel must be finite and > 0, got ${o.stopLevel}`);
    }
  }
  return {
    schemaVersion: ORDER_SCHEMA_VERSION,
    symbol: o.symbol.trim(),
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
