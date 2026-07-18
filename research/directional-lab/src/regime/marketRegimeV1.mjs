/**
 * Deterministic market regime V1.
 *
 * Inputs actually used: QQQ + SPY (required), IWM + VIX (optional context).
 * No breadth, no rates, no VVIX — nothing is invented. Insufficient coverage
 * yields UNKNOWN, never a neutral regime.
 *
 * Rules (fixed, versioned):
 *  - UNKNOWN         : < 60 QQQ or SPY bars available at the date
 *  - PANIC           : VIX >= 30 (when available) OR (QQQ ret20 <= -12% AND
 *                      SPY ret20 <= -10% AND both below SMA50)
 *  - PANIC_RECOVERY  : previous state PANIC/PANIC_RECOVERY, panic condition
 *                      over, but VIX >= 25 or QQQ ret20 still negative
 *  - RISK_ON         : QQQ and SPY above SMA50 with positive SMA50 slope
 *  - RISK_OFF        : QQQ and SPY below SMA50
 *  - MIXED           : anything else
 */

import { MARKET_REGIME_SCHEMA_VERSION } from '../contracts/marketRegimeSnapshotV1.mjs';
import { smaSeries, slopeSeries } from '../features/movingAverages.mjs';
import { rocSeries } from '../features/momentum.mjs';

export const REGIME_ENGINE_VERSION = 'marketRegimeV1/1';
const MIN_BENCH_BARS = 60;

/**
 * @param {import('../data/selectPriceBasis.mjs').BasisBar[]} bars
 * @returns {Map<string, {close: number|null, aboveSma50: boolean|null, slopePositive: boolean|null, ret20: number|null, barsSoFar: number}>}
 */
function benchmarkStateByDate(bars) {
  const close = bars.map((b) => b.close);
  const sma50 = smaSeries(close, 50);
  const slope = slopeSeries(sma50, 5);
  const ret20 = rocSeries(close, 20);
  const map = new Map();
  for (let i = 0; i < bars.length; i++) {
    map.set(bars[i].sessionDate, {
      close: close[i],
      aboveSma50: close[i] !== null && sma50[i] !== null ? close[i] > sma50[i] : null,
      slopePositive: slope[i] !== null ? slope[i] > 0 : null,
      ret20: ret20[i],
      barsSoFar: i + 1,
    });
  }
  return map;
}

/**
 * Compute regime snapshots for a list of civil dates.
 * @param {{dates: string[], availableAtByDate: Map<string, string>, benchmarks: Record<string, import('../data/selectPriceBasis.mjs').BasisBar[]>}} input
 * @returns {Map<string, import('../contracts/marketRegimeSnapshotV1.mjs').MarketRegimeSnapshotV1>}
 */
export function computeRegimeByDate(input) {
  const { dates, benchmarks } = input;
  const qqq = benchmarks.QQQ ? benchmarkStateByDate(benchmarks.QQQ) : null;
  const spy = benchmarks.SPY ? benchmarkStateByDate(benchmarks.SPY) : null;
  const iwm = benchmarks.IWM ? benchmarkStateByDate(benchmarks.IWM) : null;
  const vixByDate = new Map();
  if (benchmarks.VIX) for (const b of benchmarks.VIX) if (b.close !== null) vixByDate.set(b.sessionDate, b.close);

  const out = new Map();
  let prevState = 'UNKNOWN';

  for (const date of dates) {
    const availableAt = input.availableAtByDate.get(date) ?? `${date}T23:59:59.000Z`;
    const reasons = [];
    const inputsUsed = [];
    const inputsMissing = [];
    const q = qqq ? qqq.get(date) : undefined;
    const s = spy ? spy.get(date) : undefined;
    let state = 'UNKNOWN';

    const qOk = q !== undefined && q.barsSoFar >= MIN_BENCH_BARS && q.aboveSma50 !== null && q.ret20 !== null;
    const sOk = s !== undefined && s.barsSoFar >= MIN_BENCH_BARS && s.aboveSma50 !== null && s.ret20 !== null;
    if (!qOk) inputsMissing.push('QQQ');
    if (!sOk) inputsMissing.push('SPY');

    if (!qOk || !sOk) {
      reasons.push(`insufficient coverage (need >= ${MIN_BENCH_BARS} bars of QQQ and SPY with SMA50/ret20)`);
    } else {
      inputsUsed.push('QQQ', 'SPY');
      const vix = vixByDate.get(date) ?? null;
      if (vix !== null) inputsUsed.push('VIX'); else inputsMissing.push('VIX');

      const panicByVix = vix !== null && vix >= 30;
      const panicByPrice = q.ret20 <= -12 && s.ret20 <= -10 && q.aboveSma50 === false && s.aboveSma50 === false;
      if (panicByVix || panicByPrice) {
        state = 'PANIC';
        reasons.push(panicByVix ? `VIX ${vix} >= 30` : `QQQ ret20 ${q.ret20.toFixed(1)}%, SPY ret20 ${s.ret20.toFixed(1)}%, both below SMA50`);
      } else if ((prevState === 'PANIC' || prevState === 'PANIC_RECOVERY') && ((vix !== null && vix >= 25) || q.ret20 < 0)) {
        state = 'PANIC_RECOVERY';
        reasons.push('panic condition over but stress persists (VIX >= 25 or QQQ ret20 < 0)');
      } else if (q.aboveSma50 && s.aboveSma50 && q.slopePositive && s.slopePositive) {
        state = 'RISK_ON';
        reasons.push('QQQ and SPY above rising SMA50');
      } else if (q.aboveSma50 === false && s.aboveSma50 === false) {
        state = 'RISK_OFF';
        reasons.push('QQQ and SPY below SMA50');
      } else {
        state = 'MIXED';
        reasons.push(`QQQ above=${q.aboveSma50}, SPY above=${s.aboveSma50}`);
      }
      const iw = iwm ? iwm.get(date) : undefined;
      if (iw !== undefined && iw.aboveSma50 !== null) {
        inputsUsed.push('IWM');
        reasons.push(`IWM ${iw.aboveSma50 ? 'above' : 'below'} SMA50 (context only)`);
      } else {
        inputsMissing.push('IWM');
      }
    }

    out.set(date, {
      schemaVersion: MARKET_REGIME_SCHEMA_VERSION,
      sessionDate: date,
      asOf: availableAt,
      availableAt,
      state,
      inputsUsed,
      inputsMissing,
      reasons,
      engineVersion: REGIME_ENGINE_VERSION,
    });
    prevState = state;
  }
  return out;
}
