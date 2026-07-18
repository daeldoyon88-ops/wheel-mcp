/**
 * Drawdown metrics over an equity curve.
 */

/**
 * @param {{sessionDate: string, equity: number}[]} equityCurve
 * @returns {{maxDrawdownPct: number|null, reason: string|null, peakDate: string|null, troughDate: string|null}}
 */
export function maxDrawdown(equityCurve) {
  if (!Array.isArray(equityCurve) || equityCurve.length < 2) {
    return { maxDrawdownPct: null, reason: 'INSUFFICIENT_OBSERVATIONS', peakDate: null, troughDate: null };
  }
  let peak = equityCurve[0].equity;
  let peakDate = equityCurve[0].sessionDate;
  let maxDd = 0;
  let maxDdPeakDate = null;
  let maxDdTroughDate = null;
  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
      peakDate = point.sessionDate;
    }
    if (peak > 0) {
      const dd = point.equity / peak - 1;
      if (dd < maxDd) {
        maxDd = dd;
        maxDdPeakDate = peakDate;
        maxDdTroughDate = point.sessionDate;
      }
    }
  }
  return { maxDrawdownPct: maxDd * 100, reason: null, peakDate: maxDdPeakDate, troughDate: maxDdTroughDate };
}
