/**
 * CommissionModelV1 — configurable, deterministic.
 * Default values are EXAMPLE broker-like values for research comparability,
 * documented in baseline-configs.v1.json. They are NOT a universal truth.
 */

/**
 * @typedef {Object} CommissionConfig
 * @property {number} fixedPerOrder cash per order
 * @property {number} perShare cash per share
 * @property {number} minimum minimum cash per order
 */

export const DEFAULT_COMMISSION_CONFIG = Object.freeze({
  fixedPerOrder: 0,
  perShare: 0.005,
  minimum: 1,
});

/**
 * @param {Partial<CommissionConfig>} [config]
 * @returns {{config: CommissionConfig, compute: (quantity: number) => number}}
 */
export function createCommissionModel(config = {}) {
  const cfg = { ...DEFAULT_COMMISSION_CONFIG, ...config };
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`commission.${k} must be a non-negative finite number, got ${v}`);
    }
  }
  return {
    config: cfg,
    /** @param {number} quantity @returns {number} */
    compute(quantity) {
      if (!Number.isFinite(quantity) || quantity === 0) throw new Error(`commission: invalid quantity ${quantity}`);
      return Math.max(cfg.minimum, cfg.fixedPerOrder + cfg.perShare * Math.abs(quantity));
    },
  };
}
