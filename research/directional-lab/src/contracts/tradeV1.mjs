/**
 * TradeV1 — one round trip (entry -> exit(s)), or an open position at the end
 * of the backtest window (flagged, never silently closed).
 */

export const TRADE_SCHEMA_VERSION = 'TradeV1';

/**
 * @typedef {Object} TradeV1
 * @property {'TradeV1'} schemaVersion
 * @property {string} symbol
 * @property {string} entryDate fill date of the entry
 * @property {string|null} exitDate fill date of the final exit, null if still open
 * @property {number} entryPrice average entry fill price
 * @property {number|null} exitPrice average exit fill price, null if still open
 * @property {number} maxQuantity
 * @property {number} realizedPnl net of commissions and slippage
 * @property {number} commissions
 * @property {number} slippage
 * @property {number|null} returnPct net return on entry notional, null if open
 * @property {number|null} mfePct max favorable excursion (close-based, after entry only)
 * @property {number|null} maePct max adverse excursion (close-based, after entry only)
 * @property {number} barsHeld sessions between entry fill and exit fill (or end)
 * @property {boolean} open true when the backtest window ended with the position open
 * @property {string[]} entryReasons
 * @property {string[]} exitReasons
 * @property {string} exitKind OPEN_SELL | STOP | GAP_STOP | END_OF_DATA_OPEN
 */

export function emptyTradeShape() {
  return {
    schemaVersion: TRADE_SCHEMA_VERSION,
    symbol: '',
    entryDate: '',
    exitDate: null,
    entryPrice: 0,
    exitPrice: null,
    maxQuantity: 0,
    realizedPnl: 0,
    commissions: 0,
    slippage: 0,
    returnPct: null,
    mfePct: null,
    maePct: null,
    barsHeld: 0,
    open: false,
    entryReasons: [],
    exitReasons: [],
    exitKind: 'OPEN_SELL',
  };
}
