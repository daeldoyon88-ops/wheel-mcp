/**
 * PortfolioStateV1 — single-symbol cash + position accounting for V1.
 * No margin, no shorting, no extra leverage.
 */

/**
 * @typedef {Object} PortfolioStateV1
 * @property {number} initialCapital
 * @property {number} cash
 * @property {import('./positionState.mjs').PositionStateV1|null} position
 * @property {Array} fills
 * @property {Array} trades
 * @property {Array<{sessionDate: string, equity: number, cash: number, quantity: number}>} equityCurve
 * @property {number} totalCommissions
 * @property {number} totalSlippage
 * @property {number} totalTradedNotional
 * @property {number} totalDividendsCash sum of cash dividends credited (kept separate from trade PnL)
 * @property {Array} corporateActionEvents deterministic audit trail (SPLIT, CASH_DIVIDEND, ...)
 * @property {boolean} everEntered
 * @property {string[]} warnings
 */

/**
 * @param {number} initialCapital
 * @returns {PortfolioStateV1}
 */
export function createPortfolio(initialCapital) {
  if (!(initialCapital > 0)) throw new Error(`initialCapital must be > 0, got ${initialCapital}`);
  return {
    initialCapital,
    cash: initialCapital,
    position: null,
    fills: [],
    trades: [],
    equityCurve: [],
    totalCommissions: 0,
    totalSlippage: 0,
    totalTradedNotional: 0,
    totalDividendsCash: 0,
    corporateActionEvents: [],
    everEntered: false,
    warnings: [],
  };
}

/**
 * Mark equity at a close.
 * @param {PortfolioStateV1} portfolio
 * @param {{sessionDate: string, close: number}} bar
 * @returns {void}
 */
export function markEquity(portfolio, bar) {
  const quantity = portfolio.position ? portfolio.position.quantity : 0;
  portfolio.equityCurve.push({
    sessionDate: bar.sessionDate,
    equity: portfolio.cash + quantity * bar.close,
    cash: portfolio.cash,
    quantity,
  });
}
