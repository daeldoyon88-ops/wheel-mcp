/**
 * Closed-trade statistics. Open trades are excluded (they are flagged in the
 * trade list and included in equity metrics via mark-to-market).
 */

/** @param {number[]} xs @returns {number} */
function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * @param {Array<{open: boolean, returnPct: number|null, realizedPnl: number, barsHeld: number}>} trades
 * @returns {{stats: Object, reasons: Record<string, string>}}
 */
export function closedTradeStats(trades) {
  const closed = trades.filter((t) => !t.open && t.returnPct !== null);
  const reasons = {};
  const stats = {
    tradeCount: closed.length,
    openTradeCount: trades.filter((t) => t.open).length,
    winRatePct: null,
    avgWinPct: null,
    avgLossPct: null,
    expectancyPct: null,
    profitFactor: null,
    avgBarsHeld: null,
  };
  if (closed.length === 0) {
    for (const k of ['winRatePct', 'avgWinPct', 'avgLossPct', 'expectancyPct', 'profitFactor', 'avgBarsHeld']) {
      reasons[k] = 'NO_CLOSED_TRADES';
    }
    return { stats, reasons };
  }
  const wins = closed.filter((t) => t.returnPct > 0);
  const losses = closed.filter((t) => t.returnPct <= 0);
  stats.winRatePct = (wins.length / closed.length) * 100;
  stats.expectancyPct = mean(closed.map((t) => t.returnPct));
  stats.avgBarsHeld = mean(closed.map((t) => t.barsHeld));
  if (wins.length > 0) stats.avgWinPct = mean(wins.map((t) => t.returnPct));
  else reasons.avgWinPct = 'NO_WINNING_TRADES';
  if (losses.length > 0) stats.avgLossPct = mean(losses.map((t) => t.returnPct));
  else reasons.avgLossPct = 'NO_LOSING_TRADES';
  const grossWin = wins.reduce((a, t) => a + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.realizedPnl, 0));
  if (grossLoss > 0) stats.profitFactor = grossWin / grossLoss;
  else reasons.profitFactor = 'NO_LOSSES';
  return { stats, reasons };
}
