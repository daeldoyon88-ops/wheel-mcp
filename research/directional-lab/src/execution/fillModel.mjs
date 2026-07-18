/**
 * FillModelV1 — market-on-open fills for orders decided at the previous close.
 * Whole shares only, cash-limited, no margin, no portfolio leverage in V1
 * (leveraged ETFs remain leveraged instruments, but the lab portfolio adds
 * no extra leverage on top).
 */

/**
 * Size a cash-limited whole-share buy so that notional + commission <= cash.
 * @param {{cash: number, fillPrice: number, commissionModel: {compute: (q: number) => number}}} input
 * @returns {{quantity: number, commission: number}|null} null when not even 1 share is affordable
 */
export function sizeAllInBuy(input) {
  const { cash, fillPrice, commissionModel } = input;
  if (!(fillPrice > 0)) throw new Error(`sizeAllInBuy: fillPrice must be > 0, got ${fillPrice}`);
  let quantity = Math.floor(cash / fillPrice);
  while (quantity > 0) {
    const commission = commissionModel.compute(quantity);
    if (quantity * fillPrice + commission <= cash) return { quantity, commission };
    quantity--;
  }
  return null;
}

/**
 * Compute an open fill price for a market order.
 * @param {{open: number, side: 'BUY'|'SELL', slippageModel: {adversePrice: (p: number, s: 'BUY'|'SELL', g?: boolean) => number, perShareCost: (p: number, g?: boolean) => number}}} input
 * @returns {{referencePrice: number, fillPrice: number, slippagePerShare: number}}
 */
export function marketOpenFill(input) {
  const { open, side, slippageModel } = input;
  if (!Number.isFinite(open) || open <= 0) throw new Error(`marketOpenFill: invalid open ${open}`);
  const fillPrice = slippageModel.adversePrice(open, side, false);
  return { referencePrice: open, fillPrice, slippagePerShare: slippageModel.perShareCost(open, false) };
}
