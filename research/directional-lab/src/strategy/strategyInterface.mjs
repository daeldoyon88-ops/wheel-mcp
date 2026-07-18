/**
 * Common strategy interface (V1, long-only, daily, no options, no Wheel).
 *
 * A strategy is a pure decision function. It receives ONLY data available at
 * the decision close (feature snapshot, regime, its own position state) and
 * returns an intention (SignalV1). It never receives future bars, never
 * executes anything itself, and never sees the order book.
 *
 * Future interfaces (short, options, Wheel) are intentionally NOT implemented
 * in Phase 1; they will extend this contract.
 */

import { INTENTS } from '../contracts/signalV1.mjs';

export { INTENTS };

/**
 * @typedef {Object} StrategyContext
 * @property {string} symbol
 * @property {number} index bar index (for diagnostics only)
 * @property {string} sessionDate civil date of the decision close
 * @property {string} decisionTime UTC ISO instant of the close
 * @property {number} close close price on the selected basis
 * @property {Record<string, import('../contracts/featureSnapshotV1.mjs').FeatureValue>} features
 * @property {import('../contracts/marketRegimeSnapshotV1.mjs').MarketRegimeSnapshotV1|null} regime
 * @property {import('../backtest/positionState.mjs').PositionStateV1|null} position
 * @property {boolean} everEntered true once the strategy has entered at least once
 * @property {Object} params
 */

/**
 * @typedef {Object} StrategyV1
 * @property {string} id
 * @property {string} version
 * @property {Object} defaultParams
 * @property {(ctx: StrategyContext) => import('../contracts/signalV1.mjs').SignalV1} decide
 */

/**
 * Validate that an object implements StrategyV1.
 * @param {unknown} strategy
 * @returns {string[]} problems
 */
export function strategyProblems(strategy) {
  const problems = [];
  if (strategy === null || typeof strategy !== 'object') return ['strategy is not an object'];
  const s = /** @type {any} */ (strategy);
  if (typeof s.id !== 'string' || !s.id) problems.push('strategy.id required');
  if (typeof s.version !== 'string' || !s.version) problems.push('strategy.version required');
  if (s.defaultParams === null || typeof s.defaultParams !== 'object') problems.push('strategy.defaultParams required');
  if (typeof s.decide !== 'function') problems.push('strategy.decide must be a function');
  return problems;
}

/**
 * Read a feature value, returning null when the feature is missing.
 * @param {StrategyContext} ctx
 * @param {string} name
 * @returns {number|boolean|string|null}
 */
export function feature(ctx, name) {
  const fv = ctx.features[name];
  return fv === undefined ? null : fv.value;
}
