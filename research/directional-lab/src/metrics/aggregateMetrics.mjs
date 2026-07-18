/**
 * Aggregate all metrics for one backtest. Every unavailable metric is null
 * with an explicit reason in metricReasons — no Infinity, no NaN, no
 * substituted constants.
 */

import { dailyReturns, totalReturnNetPct, totalReturnGrossPct, cagrPct } from './returns.mjs';
import { maxDrawdown } from './drawdown.mjs';
import { annualizedVolPct, sharpeRatio, sortinoRatio, calmarRatio } from './riskMetrics.mjs';
import { closedTradeStats } from './trades.mjs';
import { excursionStats } from './excursionMetrics.mjs';

/**
 * @param {{equityCurve: Array, initialCapital: number, trades: Array, closes: (number|null)[], firstDate: string, lastDate: string, totalCommissions: number, totalSlippage: number, totalTradedNotional: number}} input
 * @returns {{metrics: Object, metricReasons: Record<string, string>}}
 */
export function computeAllMetrics(input) {
  const { equityCurve, initialCapital, trades, closes, firstDate, lastDate } = input;
  const metricReasons = {};
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
  const returns = dailyReturns(equityCurve);

  /** @param {string} name @param {{value: number|null, reason: string|null}} r @returns {number|null} */
  function take(name, r) {
    if (r.value === null && r.reason) metricReasons[name] = r.reason;
    return r.value;
  }

  const totalCosts = input.totalCommissions + input.totalSlippage;
  const net = take('totalReturnNetPct', totalReturnNetPct(initialCapital, finalEquity));
  const gross = take('totalReturnGrossPct', totalReturnGrossPct(initialCapital, finalEquity, totalCosts));
  const cagr = take('cagrPct', cagrPct(initialCapital, finalEquity, firstDate, lastDate));
  const dd = maxDrawdown(equityCurve);
  if (dd.maxDrawdownPct === null && dd.reason) metricReasons.maxDrawdownPct = dd.reason;
  if (dd.peakDate === null) metricReasons.maxDrawdownPeakDate = dd.reason ?? 'NO_DRAWDOWN';
  if (dd.troughDate === null) metricReasons.maxDrawdownTroughDate = dd.reason ?? 'NO_DRAWDOWN';
  const vol = take('annualizedVolPct', annualizedVolPct(returns));
  const sharpe = take('sharpe', sharpeRatio(returns));
  const sortino = take('sortino', sortinoRatio(returns));
  const calmar = take('calmar', calmarRatio(cagr, dd.maxDrawdownPct));

  const tradeResult = closedTradeStats(trades);
  Object.assign(metricReasons, prefixReasons('', tradeResult.reasons));
  const excursion = excursionStats({
    trades,
    closes,
    equityCurve,
    initialCapital,
    totalTradedNotional: input.totalTradedNotional,
  });
  Object.assign(metricReasons, prefixReasons('', excursion.reasons));

  const metrics = {
    totalReturnNetPct: net,
    totalReturnGrossPct: gross,
    cagrPct: cagr,
    annualizedVolPct: vol,
    maxDrawdownPct: dd.maxDrawdownPct,
    maxDrawdownPeakDate: dd.peakDate,
    maxDrawdownTroughDate: dd.troughDate,
    sharpe,
    sortino,
    calmar,
    finalEquity,
    totalCommissions: input.totalCommissions,
    totalSlippage: input.totalSlippage,
    ...tradeResult.stats,
    ...excursion.stats,
  };
  return { metrics, metricReasons };
}

/**
 * @param {string} prefix
 * @param {Record<string, string>} reasons
 * @returns {Record<string, string>}
 */
function prefixReasons(prefix, reasons) {
  if (!prefix) return reasons;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(reasons)) out[`${prefix}${k}`] = v;
  return out;
}
