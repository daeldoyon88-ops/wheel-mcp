/**
 * B1 — MA50 baseline. Fixed parameters, no optimization.
 * Entry signal at close t: close > SMA50 and SMA50 slope > 0 -> fill open t+1.
 * Exit signal at close t: close < SMA50 -> fill open t+1.
 * PILOT_TECHNICAL_ONLY — not an investment recommendation.
 */

import { createSignal } from '../contracts/signalV1.mjs';
import { feature } from './strategyInterface.mjs';

/** @type {import('./strategyInterface.mjs').StrategyV1} */
export const ma50Baseline = {
  id: 'MA50',
  version: 'B1/1',
  defaultParams: { smaFeature: 'sma50', slopeFeature: 'sma50Slope' },
  decide(ctx) {
    const base = {
      symbol: ctx.symbol,
      decisionDate: ctx.sessionDate,
      decisionTime: ctx.decisionTime,
      strategyId: this.id,
      strategyVersion: this.version,
      parameters: ctx.params,
    };
    const sma50 = feature(ctx, 'sma50');
    const slope = feature(ctx, 'sma50Slope');

    if (!ctx.position) {
      if (typeof sma50 === 'number' && typeof slope === 'number' && ctx.close > sma50 && slope > 0) {
        return createSignal({
          ...base,
          intent: 'ENTER_LONG',
          reasons: [`close ${ctx.close} > SMA50 ${sma50}`, `SMA50 slope ${slope} > 0`],
          invalidation: 'close falls below SMA50',
        });
      }
      const reasons = sma50 === null || slope === null
        ? ['SMA50 or slope unavailable (insufficient history)']
        : ['entry conditions not met'];
      return createSignal({ ...base, intent: 'NO_ACTION', reasons, invalidation: null });
    }

    if (typeof sma50 === 'number' && ctx.close < sma50) {
      return createSignal({
        ...base,
        intent: 'EXIT',
        reasons: [`close ${ctx.close} < SMA50 ${sma50}`],
        invalidation: null,
      });
    }
    return createSignal({ ...base, intent: 'HOLD', reasons: ['close still above SMA50'], invalidation: 'close falls below SMA50' });
  },
};
