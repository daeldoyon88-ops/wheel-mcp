/**
 * Risk-adjusted metrics. Risk-free rate is assumed 0 (documented). Invalid
 * denominators yield null with a reason, never Infinity or a made-up constant.
 */

const TRADING_DAYS = 252;
const MIN_OBS = 20;

/** @param {(number|null)[]} returns @returns {number[]} */
function cleanReturns(returns) {
  return returns.filter((r) => r !== null && Number.isFinite(r));
}

/** @param {number[]} xs @returns {number} */
function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** @param {number[]} xs @returns {number} sample std */
function std(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/**
 * @param {(number|null)[]} returns daily returns
 * @returns {{value: number|null, reason: string|null}}
 */
export function annualizedVolPct(returns) {
  const xs = cleanReturns(returns);
  if (xs.length < MIN_OBS) return { value: null, reason: 'INSUFFICIENT_OBSERVATIONS' };
  return { value: std(xs) * Math.sqrt(TRADING_DAYS) * 100, reason: null };
}

/**
 * Sharpe ratio (rf = 0, annualized).
 * @param {(number|null)[]} returns
 * @returns {{value: number|null, reason: string|null}}
 */
export function sharpeRatio(returns) {
  const xs = cleanReturns(returns);
  if (xs.length < MIN_OBS) return { value: null, reason: 'INSUFFICIENT_OBSERVATIONS' };
  const s = std(xs);
  if (s === 0) return { value: null, reason: 'ZERO_VOLATILITY' };
  return { value: (mean(xs) / s) * Math.sqrt(TRADING_DAYS), reason: null };
}

/**
 * Sortino ratio (rf = 0, annualized, downside deviation of negative returns).
 * @param {(number|null)[]} returns
 * @returns {{value: number|null, reason: string|null}}
 */
export function sortinoRatio(returns) {
  const xs = cleanReturns(returns);
  if (xs.length < MIN_OBS) return { value: null, reason: 'INSUFFICIENT_OBSERVATIONS' };
  const downside = xs.filter((r) => r < 0);
  if (downside.length < 2) return { value: null, reason: 'NO_DOWNSIDE_OBSERVATIONS' };
  const downsideDev = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length);
  if (downsideDev === 0) return { value: null, reason: 'ZERO_DOWNSIDE_DEVIATION' };
  return { value: (mean(xs) / downsideDev) * Math.sqrt(TRADING_DAYS), reason: null };
}

/**
 * Calmar = CAGR / |max drawdown|.
 * @param {number|null} cagrPctValue
 * @param {number|null} maxDrawdownPctValue
 * @returns {{value: number|null, reason: string|null}}
 */
export function calmarRatio(cagrPctValue, maxDrawdownPctValue) {
  if (cagrPctValue === null) return { value: null, reason: 'CAGR_UNAVAILABLE' };
  if (maxDrawdownPctValue === null) return { value: null, reason: 'MAX_DRAWDOWN_UNAVAILABLE' };
  if (maxDrawdownPctValue === 0) return { value: null, reason: 'NO_DRAWDOWN' };
  return { value: cagrPctValue / Math.abs(maxDrawdownPctValue), reason: null };
}
