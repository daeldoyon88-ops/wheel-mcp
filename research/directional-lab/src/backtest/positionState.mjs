/**
 * PositionStateV1 — long position tracking.
 * MFE/MAE and all "since entry" extrema use ONLY sessions from the entry fill
 * onward; nothing before the entry leaks into them.
 */

/**
 * @typedef {Object} PositionStateV1
 * @property {string} symbol
 * @property {number} quantity
 * @property {string} entryDate
 * @property {number} entryPrice average entry fill price
 * @property {number|null} currentPrice last close seen
 * @property {number} averageCost entry price incl. per-share entry costs
 * @property {number|null} highestCloseSinceEntry
 * @property {number|null} highestHighSinceEntry
 * @property {number|null} lowestLowSinceEntry
 * @property {number|null} mfePct max favorable excursion (high-based)
 * @property {number|null} maePct max adverse excursion (low-based)
 * @property {number|null} currentReturnPct
 * @property {number|null} drawdownFromPeakPct close vs highestCloseSinceEntry
 * @property {number} realizedPnl
 * @property {number|null} unrealizedPnl
 * @property {number} commissions
 * @property {number} slippage
 * @property {Array<{date: string, quantity: number, price: number}>} partialExits
 * @property {number|null} lastStop
 * @property {'OPEN'|'CLOSED'} state
 * @property {string[]} entryReasons
 * @property {string[]} exitReasons
 * @property {number} maxQuantity
 * @property {number} barsHeld
 */

/**
 * @param {{symbol: string, quantity: number, entryDate: string, entryPrice: number, commission: number, slippagePerShare: number, entryReasons: string[]}} input
 * @returns {PositionStateV1}
 */
export function openPosition(input) {
  const { symbol, quantity, entryDate, entryPrice, commission, slippagePerShare, entryReasons } = input;
  if (!(quantity > 0)) throw new Error(`openPosition: quantity must be > 0, got ${quantity}`);
  return {
    symbol,
    quantity,
    entryDate,
    entryPrice,
    currentPrice: null,
    averageCost: entryPrice + commission / quantity,
    highestCloseSinceEntry: null,
    highestHighSinceEntry: null,
    lowestLowSinceEntry: null,
    mfePct: null,
    maePct: null,
    currentReturnPct: null,
    drawdownFromPeakPct: null,
    realizedPnl: 0,
    unrealizedPnl: null,
    commissions: commission,
    slippage: slippagePerShare * quantity,
    partialExits: [],
    lastStop: null,
    state: 'OPEN',
    entryReasons: [...entryReasons],
    exitReasons: [],
    maxQuantity: quantity,
    barsHeld: 0,
  };
}

/**
 * Update the position with a completed session (called at each close from the
 * entry session onward). Intraday extrema of the entry session are included:
 * the entry happened at that session's open.
 * @param {PositionStateV1} position
 * @param {{close: number, high: number, low: number}} bar
 * @returns {void} mutates position (single owner: the engine)
 */
export function updatePositionOnClose(position, bar) {
  position.barsHeld += 1;
  position.currentPrice = bar.close;
  if (position.highestCloseSinceEntry === null || bar.close > position.highestCloseSinceEntry) {
    position.highestCloseSinceEntry = bar.close;
  }
  if (position.highestHighSinceEntry === null || bar.high > position.highestHighSinceEntry) {
    position.highestHighSinceEntry = bar.high;
  }
  if (position.lowestLowSinceEntry === null || bar.low < position.lowestLowSinceEntry) {
    position.lowestLowSinceEntry = bar.low;
  }
  const e = position.entryPrice;
  if (e > 0) {
    position.mfePct = ((position.highestHighSinceEntry - e) / e) * 100;
    position.maePct = ((position.lowestLowSinceEntry - e) / e) * 100;
    position.currentReturnPct = ((bar.close - e) / e) * 100;
    position.drawdownFromPeakPct = position.highestCloseSinceEntry > 0
      ? ((bar.close / position.highestCloseSinceEntry) - 1) * 100
      : null;
    position.unrealizedPnl = (bar.close - position.averageCost) * position.quantity;
  }
}
