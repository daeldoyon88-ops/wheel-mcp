/**
 * SlippageModelV1 — configurable, deterministic.
 * Slippage per share = max(price * bps/10000, minPerShare), multiplied by
 * gapMultiplier when the fill happens on an adverse gap. Values are research
 * defaults, not a market truth.
 */

/**
 * @typedef {Object} SlippageConfig
 * @property {number} bps basis points of price
 * @property {number} minPerShare cash floor per share
 * @property {number} gapMultiplier multiplier applied on adverse gap fills
 */

export const DEFAULT_SLIPPAGE_CONFIG = Object.freeze({
  bps: 5,
  minPerShare: 0.01,
  gapMultiplier: 1.5,
});

/**
 * @param {Partial<SlippageConfig>} [config]
 * @returns {{config: SlippageConfig, adversePrice: (price: number, side: 'BUY'|'SELL', isGap?: boolean) => number, perShareCost: (price: number, isGap?: boolean) => number}}
 */
export function createSlippageModel(config = {}) {
  const cfg = { ...DEFAULT_SLIPPAGE_CONFIG, ...config };
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`slippage.${k} must be a non-negative finite number, got ${v}`);
    }
  }
  /** @param {number} price @param {boolean} [isGap] @returns {number} */
  function perShareCost(price, isGap = false) {
    if (!Number.isFinite(price) || price < 0) throw new Error(`slippage: invalid price ${price}`);
    const base = Math.max((price * cfg.bps) / 10000, cfg.minPerShare);
    return isGap ? base * cfg.gapMultiplier : base;
  }
  return {
    config: cfg,
    perShareCost,
    /** @param {number} price @param {'BUY'|'SELL'} side @param {boolean} [isGap] @returns {number} */
    adversePrice(price, side, isGap = false) {
      const slip = perShareCost(price, isGap);
      const filled = side === 'BUY' ? price + slip : price - slip;
      return Math.max(filled, 0);
    },
  };
}
