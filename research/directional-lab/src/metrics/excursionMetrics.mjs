/**
 * Excursion / behavior metrics: MFE, MAE, MFE capture, giveback, false exits,
 * exposure, time in cash, turnover.
 * "False exit" is a rough post-hoc diagnostic: the close 10 sessions after the
 * exit is above the exit fill price (the market kept going without us). It is
 * an evaluation metric computed AFTER the backtest, never a feature.
 */

/** @param {number[]} xs @returns {number} */
function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const FALSE_EXIT_LOOKAHEAD = 10;

/**
 * @param {{trades: Array, closes: (number|null)[], equityCurve: Array<{quantity: number}>, initialCapital: number, totalTradedNotional: number}} input
 * @returns {{stats: Object, reasons: Record<string, string>}}
 */
export function excursionStats(input) {
  const { trades, closes, equityCurve, initialCapital, totalTradedNotional } = input;
  const reasons = {};
  const closed = trades.filter((t) => !t.open && t.returnPct !== null);
  const stats = {
    avgMfePct: null,
    avgMaePct: null,
    mfeCapturePct: null,
    avgGivebackPct: null,
    falseExits: null,
    exposurePct: null,
    timeInCashPct: null,
    turnover: null,
  };

  const withMfe = closed.filter((t) => t.mfePct !== null && t.maePct !== null);
  if (withMfe.length > 0) {
    stats.avgMfePct = mean(withMfe.map((t) => t.mfePct));
    stats.avgMaePct = mean(withMfe.map((t) => t.maePct));
  } else {
    reasons.avgMfePct = 'NO_CLOSED_TRADES_WITH_EXCURSIONS';
    reasons.avgMaePct = 'NO_CLOSED_TRADES_WITH_EXCURSIONS';
  }

  const positiveMfe = withMfe.filter((t) => t.mfePct > 0);
  if (positiveMfe.length > 0) {
    stats.mfeCapturePct = mean(positiveMfe.map((t) => (t.returnPct / t.mfePct) * 100));
    stats.avgGivebackPct = mean(positiveMfe.map((t) => t.mfePct - t.returnPct));
  } else {
    reasons.mfeCapturePct = 'NO_POSITIVE_MFE_TRADES';
    reasons.avgGivebackPct = 'NO_POSITIVE_MFE_TRADES';
  }

  const evaluable = closed.filter((t) => Number.isInteger(t.exitIndex) && t.exitIndex + FALSE_EXIT_LOOKAHEAD < closes.length);
  if (evaluable.length > 0) {
    stats.falseExits = evaluable.filter((t) => {
      const later = closes[t.exitIndex + FALSE_EXIT_LOOKAHEAD];
      return later !== null && t.exitPrice !== null && later > t.exitPrice;
    }).length;
  } else {
    reasons.falseExits = closed.length === 0 ? 'NO_CLOSED_TRADES' : 'EXITS_TOO_CLOSE_TO_END_OF_DATA';
  }

  if (equityCurve.length > 0) {
    const invested = equityCurve.filter((p) => p.quantity > 0).length;
    stats.exposurePct = (invested / equityCurve.length) * 100;
    stats.timeInCashPct = 100 - stats.exposurePct;
  } else {
    reasons.exposurePct = 'EMPTY_EQUITY_CURVE';
    reasons.timeInCashPct = 'EMPTY_EQUITY_CURVE';
  }

  if (initialCapital > 0) {
    stats.turnover = totalTradedNotional / initialCapital;
  } else {
    reasons.turnover = 'INITIAL_CAPITAL_INVALID';
  }
  return { stats, reasons };
}
