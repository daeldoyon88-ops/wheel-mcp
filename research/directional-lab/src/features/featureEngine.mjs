/**
 * Causal feature engine: builds one FeatureSnapshotV1 per session.
 *
 * Causality guarantees:
 *  - every underlying series is a trailing computation (prefix-only);
 *  - the weekly feature uses ONLY the last fully completed ISO week;
 *  - benchmark/relative features are null (with reason) when the benchmark
 *    has no data for a date — never a fabricated neutral value;
 *  - V1 exposes NO pivot features (pivots need future confirmation candles;
 *    deferred with availableAt semantics to a later phase).
 */

import { featureValue, FEATURE_SNAPSHOT_SCHEMA_VERSION } from '../contracts/featureSnapshotV1.mjs';
import { isoWeekKey } from '../time/civilDate.mjs';
import { smaSeries, emaSeries, slopeSeries, countAboveSeries } from './movingAverages.mjs';
import { rsiSeries, macdSeries, rocSeries } from './momentum.mjs';
import {
  trueRangeSeries, atrSeries, atrPctSeries, realizedVolSeries,
  realizedVolPercentileSeries, distanceFromPeakAtrSeries,
} from './volatility.mjs';
import { volumeSmaSeries, relativeVolumeSeries, volumePercentileSeries } from './volume.mjs';
import {
  prevHighestCloseSeries, prevLowestCloseSeries, breakoutSeries,
  drawdownFromCausalPeakSeries, higherHighSeries, higherLowSeries,
} from './structure.mjs';
import { relativeStrengthSeries } from './relativeStrength.mjs';
import { diffSeries } from './rolling.mjs';

export const FEATURE_ENGINE_VERSION = 'featureEngine/1';

/**
 * Last fully completed ISO week's close, per index.
 * Week w is usable at session t only when isoWeek(t) > w (the current week is
 * always forbidden, including its own Friday close).
 * @param {{sessionDate: string, close: number|null, availableAt: string}[]} series
 * @returns {({weekKey: string, close: number|null, availableAt: string}|null)[]}
 */
export function lastCompletedWeekSeries(series) {
  const out = new Array(series.length).fill(null);
  /** @type {{weekKey: string, close: number|null, availableAt: string}|null} */
  let lastCompleted = null;
  /** @type {{weekKey: string, close: number|null, availableAt: string}|null} */
  let currentWeek = null;
  for (let i = 0; i < series.length; i++) {
    const bar = series[i];
    const week = isoWeekKey(bar.sessionDate);
    if (currentWeek !== null && currentWeek.weekKey !== week) {
      lastCompleted = currentWeek;
      currentWeek = null;
    }
    out[i] = lastCompleted;
    currentWeek = { weekKey: week, close: bar.close, availableAt: bar.availableAt };
  }
  return out;
}

/**
 * @typedef {Object} FeatureEngineInput
 * @property {string} symbol
 * @property {import('../data/selectPriceBasis.mjs').BasisBar[]} series selected coherent price basis
 * @property {string} priceBasis
 * @property {Record<string, import('../data/selectPriceBasis.mjs').BasisBar[]>} [benchmarks] e.g. {QQQ, SPY, IWM, VIX}
 * @property {{rsBenchmark?: string}} [config]
 */

/**
 * Compute one FeatureSnapshotV1 per bar of the series.
 * @param {FeatureEngineInput} input
 * @returns {import('../contracts/featureSnapshotV1.mjs').FeatureSnapshotV1[]}
 */
export function computeFeatureSnapshots(input) {
  const { symbol, series, priceBasis } = input;
  const benchmarks = input.benchmarks ?? {};
  const rsBenchmarkName = input.config?.rsBenchmark ?? 'QQQ';
  const source = `${FEATURE_ENGINE_VERSION}:${priceBasis}`;

  const close = series.map((b) => b.close);
  const high = series.map((b) => b.high);
  const low = series.map((b) => b.low);
  const volume = series.map((b) => b.volume);

  // Trend
  const sma20 = smaSeries(close, 20);
  const sma50 = smaSeries(close, 50);
  const sma50Slope = slopeSeries(sma50, 5);
  const ema21 = emaSeries(close, 21);
  const ema50 = emaSeries(close, 50);
  const closesAbove50 = countAboveSeries(close, sma50, 20);

  // Momentum
  const rsi14 = rsiSeries(close, 14);
  const { macdLine, signalLine, histogram } = macdSeries(close, 12, 26, 9);
  const histDelta = diffSeries(histogram, 1);
  const roc20 = rocSeries(close, 20);

  // Volatility
  const tr = trueRangeSeries(high, low, close);
  const atr14 = atrSeries(tr, 14);
  const atrPct = atrPctSeries(atr14, close);
  const rv20 = realizedVolSeries(close, 20);
  const rv20Pctile = realizedVolPercentileSeries(rv20, 126);
  const distPeakAtr = distanceFromPeakAtrSeries(close, atr14);

  // Volume
  const volSma20 = volumeSmaSeries(volume, 20);
  const relVol = relativeVolumeSeries(volume, volSma20);
  const volPctile = volumePercentileSeries(volume, 60);

  // Structure
  const prevHigh20 = prevHighestCloseSeries(close, 20);
  const prevLow20 = prevLowestCloseSeries(close, 20);
  const breakout20 = breakoutSeries(close, 20);
  const ddFromPeak = drawdownFromCausalPeakSeries(close);
  const hh = higherHighSeries(high);
  const hl = higherLowSeries(low);

  // Relative strength
  const rsBench = benchmarks[rsBenchmarkName] ?? null;
  const rs = relativeStrengthSeries(series, rsBench);

  // Market benchmark trends (close > SMA50 with positive slope -> UP, etc.)
  /** @type {Record<string, Map<string, string>>} */
  const benchTrendByDate = {};
  for (const name of ['QQQ', 'SPY', 'IWM']) {
    const b = benchmarks[name];
    if (!b) continue;
    const bClose = b.map((x) => x.close);
    const bSma50 = smaSeries(bClose, 50);
    const bSlope = slopeSeries(bSma50, 5);
    const map = new Map();
    for (let i = 0; i < b.length; i++) {
      const c = bClose[i];
      const s = bSma50[i];
      const sl = bSlope[i];
      if (c === null || s === null || sl === null) continue;
      map.set(b[i].sessionDate, c > s ? (sl > 0 ? 'UP' : 'UP_FLAT') : (sl < 0 ? 'DOWN' : 'DOWN_FLAT'));
    }
    benchTrendByDate[name] = map;
  }
  const vixByDate = new Map();
  if (benchmarks.VIX) for (const b of benchmarks.VIX) if (b.close !== null) vixByDate.set(b.sessionDate, b.close);

  const weekly = lastCompletedWeekSeries(series);

  return series.map((bar, i) => {
    const meta = { asOf: bar.eventTime, availableAt: bar.availableAt, source };
    /** @param {number|boolean|string|null} v @param {string} reason */
    const f = (v, reason) => featureValue(v, v === null ? { ...meta, missingReason: reason } : meta);

    const H = 'INSUFFICIENT_HISTORY';
    const V = 'VOLUME_MISSING';
    const B = 'BENCHMARK_UNAVAILABLE';

    const closeVsSma50 = close[i] !== null && sma50[i] !== null && sma50[i] !== 0
      ? (close[i] / sma50[i] - 1) * 100 : null;
    const closeVsEma21 = close[i] !== null && ema21[i] !== null && ema21[i] !== 0
      ? (close[i] / ema21[i] - 1) * 100 : null;
    const ema21DistAtr = close[i] !== null && ema21[i] !== null && atr14[i] !== null && atr14[i] !== 0
      ? (close[i] - ema21[i]) / atr14[i] : null;
    const emaOrder = ema21[i] !== null && ema50[i] !== null ? ema21[i] > ema50[i] : null;

    const w = weekly[i];
    const weeklyFeature = w === null || w.close === null
      ? featureValue(null, { ...meta, missingReason: 'NO_COMPLETED_WEEK' })
      : featureValue(w.close, { asOf: w.availableAt, availableAt: w.availableAt, source: `${source}:weekly:${w.weekKey}` });

    const trend = {};
    for (const name of ['QQQ', 'SPY', 'IWM']) {
      const map = benchTrendByDate[name];
      const v = map ? map.get(bar.sessionDate) ?? null : null;
      trend[`market${name}Trend`] = f(v, B);
    }
    const vix = vixByDate.get(bar.sessionDate) ?? null;

    return {
      schemaVersion: FEATURE_SNAPSHOT_SCHEMA_VERSION,
      symbol,
      sessionDate: bar.sessionDate,
      asOf: bar.eventTime,
      availableAt: bar.availableAt,
      priceBasis,
      features: {
        // Trend
        sma20: f(sma20[i], H),
        sma50: f(sma50[i], H),
        sma50Slope: f(sma50Slope[i], H),
        ema21: f(ema21[i], H),
        ema50: f(ema50[i], H),
        closeVsSma50Pct: f(closeVsSma50, H),
        closeVsEma21Pct: f(closeVsEma21, H),
        ema21DistanceAtr: f(ema21DistAtr, H),
        ema21AboveEma50: f(emaOrder, H),
        closesAboveSma50Count20: f(closesAbove50[i], H),
        // Momentum
        rsi14: f(rsi14[i], H),
        macdLine: f(macdLine[i], H),
        macdSignal: f(signalLine[i], H),
        macdHistogram: f(histogram[i], H),
        macdHistogramDelta: f(histDelta[i], H),
        roc20: f(roc20[i], H),
        // Volatility
        trueRange: f(tr[i], H),
        atr14: f(atr14[i], H),
        atrPct: f(atrPct[i], H),
        realizedVol20: f(rv20[i], H),
        realizedVol20Pctile: f(rv20Pctile[i], H),
        distanceFromPeakAtr: f(distPeakAtr[i], H),
        // Volume
        volumeSma20: f(volSma20[i], V),
        relativeVolume: f(relVol[i], V),
        volumePctile60: f(volPctile[i], V),
        // Structure
        prevHighestClose20: f(prevHigh20[i], H),
        prevLowestClose20: f(prevLow20[i], H),
        breakout20: f(breakout20[i], H),
        drawdownFromCausalPeakPct: f(ddFromPeak[i], H),
        higherHigh: f(hh[i], H),
        higherLow: f(hl[i], H),
        // Weekly (last completed week only)
        weeklyLastCompletedClose: weeklyFeature,
        // Relative strength
        rsRatioBenchmark: f(rs.benchmarkMissing[i] ? null : rs.ratio[i], rs.benchmarkMissing[i] ? B : H),
        relReturn20: f(rs.relReturn20[i], rs.benchmarkMissing[i] ? B : H),
        relReturn60: f(rs.relReturn60[i], rs.benchmarkMissing[i] ? B : H),
        rsRatioSlope20: f(rs.ratioSlope20[i], rs.benchmarkMissing[i] ? B : H),
        // Market context
        ...trend,
        vixClose: f(vix, B),
      },
    };
  });
}
