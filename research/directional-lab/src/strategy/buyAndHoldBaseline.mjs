/**
 * B0 — Buy and Hold baseline.
 * Enters at the first admissible open (t+1 after the first decision close),
 * holds to the end. No optimization. Costs applied by the engine. Dividends
 * are included only when per-bar dividend data exists (see engine warnings).
 * PILOT_TECHNICAL_ONLY — not an investment recommendation.
 */

import { createSignal } from '../contracts/signalV1.mjs';

/** @type {import('./strategyInterface.mjs').StrategyV1} */
export const buyAndHoldBaseline = {
  id: 'BUY_HOLD',
  version: 'B0/1',
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
    if (!ctx.position && !ctx.everEntered) {
      return createSignal({
        ...base,
        intent: 'ENTER_LONG',
        reasons: ['first admissible session: buy and hold'],
        invalidation: 'never (holds to end of data)',
      });
    }
    return createSignal({ ...base, intent: ctx.position ? 'HOLD' : 'NO_ACTION', reasons: ['buy and hold'], invalidation: null });
  },
};
