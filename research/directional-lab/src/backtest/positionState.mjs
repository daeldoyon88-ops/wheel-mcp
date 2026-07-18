/**
 * PositionStateV1 — long position tracking.
 * MFE/MAE and all "since entry" extrema use ONLY sessions from the entry fill
 * onward; nothing before the entry leaks into them.
 */

import {
  SPLIT_QUANTITY_TOLERANCE,
  ERROR_FRACTIONAL_SPLIT_RESULT_UNSUPPORTED,
} from '../data/corporateActionPolicy.mjs';

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

/**
 * Refuse a sell that would exceed the open position (whole shares, long-only).
 * @param {number} sellQuantity positive shares to sell
 * @param {number} positionQuantity shares currently held
 * @param {string} symbol
 */
export function assertExitQuantityAllowed(sellQuantity, positionQuantity, symbol) {
  if (!(Number.isInteger(sellQuantity) && sellQuantity > 0)) {
    throw new Error(`SELL_INVALID_QUANTITY: ${symbol} exit quantity must be a positive integer, got ${sellQuantity}`);
  }
  if (!(Number.isInteger(positionQuantity) && positionQuantity >= 0)) {
    throw new Error(`SELL_INVALID_POSITION: ${symbol} position quantity invalid: ${positionQuantity}`);
  }
  if (sellQuantity > positionQuantity) {
    throw new Error(
      `SELL_EXCEEDS_POSITION: ${symbol} attempted to sell ${sellQuantity} share(s) but only ${positionQuantity} available`
    );
  }
}

/**
 * Convert a whole-share quantity through a split factor. Refuses fractional
 * results (V1 supports whole shares only and has no cash-in-lieu policy) —
 * never rounds silently.
 * @param {number} quantity
 * @param {number} splitFactor shares after / shares before, > 0
 * @param {string} context label for the error message
 * @returns {number} the exact whole-share result
 */
export function scaleWholeQuantity(quantity, splitFactor, context) {
  const scaled = quantity * splitFactor;
  const rounded = Math.round(scaled);
  if (rounded <= 0 || Math.abs(scaled - rounded) > SPLIT_QUANTITY_TOLERANCE * Math.max(1, Math.abs(rounded))) {
    throw new Error(
      `${ERROR_FRACTIONAL_SPLIT_RESULT_UNSUPPORTED}: ${context}: ${quantity} share(s) x splitFactor ${splitFactor} = ${scaled} ` +
      'is not a whole number of shares; V1 has no cash-in-lieu policy and never rounds silently'
    );
  }
  return rounded;
}

/**
 * Apply a RAW split to an open position, effective before the session open.
 * Economic value is preserved: quantity x splitFactor, every per-share price
 * reference / splitFactor. Dollar aggregates (realizedPnl, unrealizedPnl,
 * commissions, slippage) and percentage extrema (mfePct, maePct, ...) are
 * scale-invariant and stay untouched. Historical partialExits records are
 * never rewritten. Cash is never touched by a split.
 * @param {PositionStateV1} position
 * @param {number} splitFactor shares after / shares before, > 0
 * @returns {{quantityBefore: number, quantityAfter: number, averageCostBefore: number, averageCostAfter: number}}
 */
export function applySplitToPosition(position, splitFactor) {
  if (!(Number.isFinite(splitFactor) && splitFactor > 0)) {
    throw new Error(`applySplitToPosition: splitFactor must be finite and > 0, got ${splitFactor}`);
  }
  const quantityBefore = position.quantity;
  const averageCostBefore = position.averageCost;
  position.quantity = scaleWholeQuantity(quantityBefore, splitFactor, 'position.quantity');
  position.maxQuantity = scaleWholeQuantity(position.maxQuantity, splitFactor, 'position.maxQuantity');
  position.averageCost = position.averageCost / splitFactor;
  position.entryPrice = position.entryPrice / splitFactor;
  for (const field of ['currentPrice', 'highestCloseSinceEntry', 'highestHighSinceEntry', 'lowestLowSinceEntry', 'lastStop']) {
    if (position[field] !== null) position[field] = position[field] / splitFactor;
  }
  return {
    quantityBefore,
    quantityAfter: position.quantity,
    averageCostBefore,
    averageCostAfter: position.averageCost,
  };
}
