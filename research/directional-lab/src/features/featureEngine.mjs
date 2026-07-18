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
import {
  MISSING_REASONS,
  reasonForTrailingWindow,
  pickMissingReason,
} from '../contracts/missingReasonsV1.mjs';
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

export const FEATURE_ENGINE_VERSION = 'featureEngine/2';

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
 * @param {number|null} value
 * @param {(number|null)[]} source
 * @param {number} window
 * @param {number} index
 * @param {{nullReason?: string, fallback?: string}} [opts]
 * @returns {string|null}
 */
function reasonIfNull(value, source, window, index, opts = {}) {
  if (value !== null) return null;
  const diagnosed = reasonForTrailingWindow(source, window, index, {
    nullReason: opts.nullReason ?? MISSING_REASONS.INPUT_MISSING,
  });
  return diagnosed ?? opts.fallback ?? MISSING_REASONS.INSUFFICIENT_HISTORY;
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
  /** @type {Record<string, boolean>} */
  const benchSeriesPresent = {};
  for (const name of ['QQQ', 'SPY', 'IWM']) {
    const b = benchmarks[name];
    benchSeriesPresent[name] = Array.isArray(b) && b.length > 0;
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
  const vixPresent = Array.isArray(benchmarks.VIX) && benchmarks.VIX.length > 0;
  if (benchmarks.VIX) for (const b of benchmarks.VIX) if (b.close !== null) vixByDate.set(b.sessionDate, b.close);

  const weekly = lastCompletedWeekSeries(series);

  return series.map((bar, i) => {
    const meta = { asOf: bar.eventTime, availableAt: bar.availableAt, source };
    /** @param {number|boolean|string|null} v @param {string} reason */
    const f = (v, reason) => featureValue(v, v === null ? { ...meta, missingReason: reason } : meta);

    const closeVsSma50 = close[i] !== null && sma50[i] !== null && sma50[i] !== 0
      ? (close[i] / sma50[i] - 1) * 100 : null;
    const closeVsEma21 = close[i] !== null && ema21[i] !== null && ema21[i] !== 0
      ? (close[i] / ema21[i] - 1) * 100 : null;
    const ema21DistAtr = close[i] !== null && ema21[i] !== null && atr14[i] !== null && atr14[i] !== 0
      ? (close[i] - ema21[i]) / atr14[i] : null;
    const emaOrder = ema21[i] !== null && ema50[i] !== null ? ema21[i] > ema50[i] : null;

    const w = weekly[i];
    const weeklyFeature = w === null || w.close === null
      ? featureValue(null, { ...meta, missingReason: MISSING_REASONS.NO_COMPLETED_WEEK })
      : featureValue(w.close, { asOf: w.availableAt, availableAt: w.availableAt, source: `${source}:weekly:${w.weekKey}` });

    const trend = {};
    for (const name of ['QQQ', 'SPY', 'IWM']) {
      const map = benchTrendByDate[name];
      const v = map ? map.get(bar.sessionDate) ?? null : null;
      const reason = !benchSeriesPresent[name]
        ? MISSING_REASONS.BENCHMARK_UNAVAILABLE
        : MISSING_REASONS.BENCHMARK_DATE_MISSING;
      trend[`market${name}Trend`] = f(v, reason);
    }
    const vix = vixByDate.get(bar.sessionDate) ?? null;
    const vixReason = !vixPresent
      ? MISSING_REASONS.BENCHMARK_UNAVAILABLE
      : MISSING_REASONS.BENCHMARK_DATE_MISSING;

    const volSmaReason = reasonIfNull(volSma20[i], volume, 20, i, {
      nullReason: MISSING_REASONS.VOLUME_MISSING,
    });
    const volPctReason = reasonIfNull(volPctile[i], volume, 60, i, {
      nullReason: MISSING_REASONS.VOLUME_MISSING,
    });
    let relVolReason = null;
    if (relVol[i] === null) {
      relVolReason = pickMissingReason([
        volume[i] === null || volume[i] === undefined ? MISSING_REASONS.VOLUME_MISSING : null,
        volSmaReason,
        MISSING_REASONS.VOLUME_MISSING,
      ]);
    }

    const rsBenchReason = rs.benchmarkMissingReason[i];
    const rsRatioReason = rs.ratio[i] === null
      ? (rsBenchReason ?? reasonIfNull(null, close, 1, i) ?? MISSING_REASONS.INSUFFICIENT_HISTORY)
      : null;
    const rel20Reason = rs.relReturn20[i] === null
      ? pickMissingReason([
        rsBenchReason,
        reasonForTrailingWindow(close, 21, i),
        MISSING_REASONS.INSUFFICIENT_HISTORY,
      ])
      : null;
    const rel60Reason = rs.relReturn60[i] === null
      ? pickMissingReason([
        rsBenchReason,
        reasonForTrailingWindow(close, 61, i),
        MISSING_REASONS.INSUFFICIENT_HISTORY,
      ])
      : null;
    const rsSlopeReason = rs.ratioSlope20[i] === null
      ? pickMissingReason([
        rsBenchReason,
        reasonForTrailingWindow(rs.ratio, 20, i, { nullReason: MISSING_REASONS.INPUT_MISSING }),
        MISSING_REASONS.INSUFFICIENT_HISTORY,
      ])
      : null;

    return {
      schemaVersion: FEATURE_SNAPSHOT_SCHEMA_VERSION,
      symbol,
      sessionDate: bar.sessionDate,
      asOf: bar.eventTime,
      availableAt: bar.availableAt,
      priceBasis,
      features: {
        // Trend
        sma20: f(sma20[i], reasonIfNull(sma20[i], close, 20, i)),
        sma50: f(sma50[i], reasonIfNull(sma50[i], close, 50, i)),
        sma50Slope: f(sma50Slope[i], reasonIfNull(sma50Slope[i], sma50, 5, i)),
        ema21: f(ema21[i], reasonIfNull(ema21[i], close, 21, i)),
        ema50: f(ema50[i], reasonIfNull(ema50[i], close, 50, i)),
        closeVsSma50Pct: f(closeVsSma50, reasonIfNull(closeVsSma50, close, 50, i)),
        closeVsEma21Pct: f(closeVsEma21, reasonIfNull(closeVsEma21, close, 21, i)),
        ema21DistanceAtr: f(ema21DistAtr, reasonIfNull(ema21DistAtr, atr14, 14, i)),
        ema21AboveEma50: f(emaOrder, reasonIfNull(emaOrder, close, 50, i)),
        closesAboveSma50Count20: f(closesAbove50[i], reasonIfNull(closesAbove50[i], close, 50, i)),
        // Momentum
        rsi14: f(rsi14[i], reasonIfNull(rsi14[i], close, 15, i)),
        macdLine: f(macdLine[i], reasonIfNull(macdLine[i], close, 26, i)),
        macdSignal: f(signalLine[i], reasonIfNull(signalLine[i], close, 35, i)),
        macdHistogram: f(histogram[i], reasonIfNull(histogram[i], close, 35, i)),
        macdHistogramDelta: f(histDelta[i], reasonIfNull(histDelta[i], histogram, 2, i)),
        roc20: f(roc20[i], reasonIfNull(roc20[i], close, 21, i)),
        // Volatility
        trueRange: f(tr[i], reasonIfNull(tr[i], close, 1, i)),
        atr14: f(atr14[i], reasonIfNull(atr14[i], tr, 14, i)),
        atrPct: f(atrPct[i], reasonIfNull(atrPct[i], atr14, 14, i)),
        realizedVol20: f(rv20[i], reasonIfNull(rv20[i], close, 21, i)),
        realizedVol20Pctile: f(rv20Pctile[i], reasonIfNull(rv20Pctile[i], rv20, 126, i)),
        distanceFromPeakAtr: f(distPeakAtr[i], reasonIfNull(distPeakAtr[i], atr14, 14, i)),
        // Volume
        volumeSma20: f(volSma20[i], volSmaReason),
        relativeVolume: f(relVol[i], relVolReason),
        volumePctile60: f(volPctile[i], volPctReason),
        // Structure
        prevHighestClose20: f(prevHigh20[i], reasonIfNull(prevHigh20[i], close, 20, i)),
        prevLowestClose20: f(prevLow20[i], reasonIfNull(prevLow20[i], close, 20, i)),
        breakout20: f(breakout20[i], reasonIfNull(breakout20[i], close, 21, i)),
        drawdownFromCausalPeakPct: f(ddFromPeak[i], reasonIfNull(ddFromPeak[i], close, 1, i)),
        higherHigh: f(hh[i], reasonIfNull(hh[i], high, 2, i)),
        higherLow: f(hl[i], reasonIfNull(hl[i], low, 2, i)),
        // Weekly (last completed week only)
        weeklyLastCompletedClose: weeklyFeature,
        // Relative strength
        rsRatioBenchmark: f(rs.benchmarkMissing[i] ? null : rs.ratio[i], rsRatioReason ?? MISSING_REASONS.INSUFFICIENT_HISTORY),
        relReturn20: f(rs.relReturn20[i], rel20Reason ?? MISSING_REASONS.INSUFFICIENT_HISTORY),
        relReturn60: f(rs.relReturn60[i], rel60Reason ?? MISSING_REASONS.INSUFFICIENT_HISTORY),
        rsRatioSlope20: f(rs.ratioSlope20[i], rsSlopeReason ?? MISSING_REASONS.INSUFFICIENT_HISTORY),
        // Market context
        ...trend,
        vixClose: f(vix, vixReason),
      },
    };
  });
}
