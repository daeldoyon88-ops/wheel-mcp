/**
 * B2 — EMA21/EMA50 baseline. Fixed parameters, no optimization.
 * Entry at close t: EMA21 > EMA50 and close > EMA21 -> fill open t+1.
 * Exit at close t: close < EMA21 or EMA21 < EMA50 -> fill open t+1.
 * PILOT_TECHNICAL_ONLY — not an investment recommendation.
 */

import { createSignal } from '../contracts/signalV1.mjs';
import { feature } from './strategyInterface.mjs';

/** @type {import('./strategyInterface.mjs').StrategyV1} */
export const ema21Ema50Baseline = {
  id: 'EMA21_EMA50',
  version: 'B2/1',
  defaultParams: {},
  decide(ctx) {
    const base = {
      symbol: ctx.symbol,
      decisionDate: ctx.sessionDate,
      decisionTime: ctx.decisionTime,
      strategyId: this.id,
      strategyVersion: this.version,
      parameters: ctx.params,
    };
    const ema21 = feature(ctx, 'ema21');
    const ema50 = feature(ctx, 'ema50');
    const ready = typeof ema21 === 'number' && typeof ema50 === 'number';

    if (!ctx.position) {
      if (ready && ema21 > ema50 && ctx.close > ema21) {
        return createSignal({
          ...base,
          intent: 'ENTER_LONG',
          reasons: [`EMA21 ${ema21} > EMA50 ${ema50}`, `close ${ctx.close} > EMA21`],
          invalidation: 'close < EMA21 or EMA21 < EMA50',
        });
      }
      return createSignal({
        ...base,
        intent: 'NO_ACTION',
        reasons: [ready ? 'entry conditions not met' : 'EMA21/EMA50 unavailable (insufficient history)'],
        invalidation: null,
      });
    }

    if (ready && (ctx.close < ema21 || ema21 < ema50)) {
      return createSignal({
        ...base,
        intent: 'EXIT',
        reasons: [ctx.close < ema21 ? `close ${ctx.close} < EMA21 ${ema21}` : `EMA21 ${ema21} < EMA50 ${ema50}`],
        invalidation: null,
      });
    }
    return createSignal({ ...base, intent: 'HOLD', reasons: ['trend conditions intact'], invalidation: 'close < EMA21 or EMA21 < EMA50' });
  },
};
