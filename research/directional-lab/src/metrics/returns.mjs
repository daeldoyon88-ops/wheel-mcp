/**
 * Return metrics. Invalid computations return { value: null, reason } —
 * never Infinity, never an arbitrary substitute denominator.
 */

import { daysBetween } from '../time/civilDate.mjs';

/**
 * @param {{equity: number}[]} equityCurve
 * @returns {(number|null)[]} daily simple returns (null when prior equity <= 0)
 */
export function dailyReturns(equityCurve) {
  const out = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const curr = equityCurve[i].equity;
    out.push(prev > 0 ? curr / prev - 1 : null);
  }
  return out;
}

/**
 * @param {number} value
 * @returns {{value: number, reason: null}}
 */
function ok(value) {
  if (!Number.isFinite(value)) throw new Error(`metric produced non-finite value: ${value}`);
  return { value, reason: null };
}

/** @param {string} reason @returns {{value: null, reason: string}} */
function missing(reason) {
  return { value: null, reason };
}

/**
 * Net total return in percent.
 * @param {number} initialCapital @param {number} finalEquity
 */
export function totalReturnNetPct(initialCapital, finalEquity) {
  if (!(initialCapital > 0)) return missing('INITIAL_CAPITAL_INVALID');
  return ok((finalEquity / initialCapital - 1) * 100);
}

/**
 * Gross total return in percent (costs added back).
 * @param {number} initialCapital @param {number} finalEquity @param {number} totalCosts
 */
export function totalReturnGrossPct(initialCapital, finalEquity, totalCosts) {
  if (!(initialCapital > 0)) return missing('INITIAL_CAPITAL_INVALID');
  return ok(((finalEquity + totalCosts) / initialCapital - 1) * 100);
}

/**
 * CAGR in percent; null when the window is shorter than one year or equity
 * is non-positive.
 * @param {number} initialCapital @param {number} finalEquity
 * @param {string} firstDate @param {string} lastDate
 */
export function cagrPct(initialCapital, finalEquity, firstDate, lastDate) {
  if (!(initialCapital > 0)) return missing('INITIAL_CAPITAL_INVALID');
  if (!(finalEquity > 0)) return missing('NON_POSITIVE_FINAL_EQUITY');
  const days = daysBetween(firstDate, lastDate);
  if (days < 365) return missing('INSUFFICIENT_DURATION_UNDER_1Y');
  return ok((Math.pow(finalEquity / initialCapital, 365.25 / days) - 1) * 100);
}
