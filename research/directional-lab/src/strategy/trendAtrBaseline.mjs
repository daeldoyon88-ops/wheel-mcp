/**
 * B3 — Trend + ATR trailing stop baseline. Fixed k=2.5, no optimization
 * (1.5/2/3 variants are explicitly out of scope in Phase 1).
 *
 * Entry at close t: close > SMA50 and SMA50 slope > 0 -> fill open t+1.
 * While in position, at each close t the stop ratchets:
 *   stop_t = max(stop_{t-1}, highestCloseSinceEntry_t - k * ATR14_t)
 * The stop becomes active on the NEXT session (never same-session), and a gap
 * below the stop fills at the open — a stop does NOT protect against
 * overnight gaps. Stop execution itself is handled by the engine.
 * PILOT_TECHNICAL_ONLY — not an investment recommendation.
 */

import { createSignal } from '../contracts/signalV1.mjs';
import { feature } from './strategyInterface.mjs';

/** @type {import('./strategyInterface.mjs').StrategyV1} */
export const trendAtrBaseline = {
  id: 'TREND_ATR',
  version: 'B3/1',
  defaultParams: { k: 2.5 },
  decide(ctx) {
    const base = {
      symbol: ctx.symbol,
      decisionDate: ctx.sessionDate,
      decisionTime: ctx.decisionTime,
      strategyId: this.id,
      strategyVersion: this.version,
      parameters: ctx.params,
    };
    const k = typeof ctx.params.k === 'number' ? ctx.params.k : 2.5;
    const sma50 = feature(ctx, 'sma50');
    const slope = feature(ctx, 'sma50Slope');
    const atr14 = feature(ctx, 'atr14');

    if (!ctx.position) {
      if (typeof sma50 === 'number' && typeof slope === 'number' && ctx.close > sma50 && slope > 0) {
        return createSignal({
          ...base,
          intent: 'ENTER_LONG',
          reasons: [`close ${ctx.close} > SMA50 ${sma50}`, `SMA50 slope ${slope} > 0`],
          invalidation: `trailing stop at highestCloseSinceEntry - ${k} x ATR14`,
        });
      }
      return createSignal({ ...base, intent: 'NO_ACTION', reasons: ['entry conditions not met or history insufficient'], invalidation: null });
    }

    const prevStop = ctx.position.lastStop;
    let stopLevel = prevStop;
    if (typeof atr14 === 'number' && ctx.position.highestCloseSinceEntry !== null) {
      const candidate = ctx.position.highestCloseSinceEntry - k * atr14;
      stopLevel = prevStop === null ? candidate : Math.max(prevStop, candidate);
    }
    // ATR unavailable -> keep the previous stop unchanged (never invent one).
    return createSignal({
      ...base,
      intent: 'HOLD',
      reasons: stopLevel === null
        ? ['in position, ATR14 unavailable, no stop yet']
        : [`trailing stop ratchet at ${stopLevel} (k=${k})`],
      invalidation: 'stop hit (gap-aware, active from next session)',
      stopLevel,
    });
  },
};
