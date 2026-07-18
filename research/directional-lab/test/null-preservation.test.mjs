import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { computeFeatureSnapshots } from '../src/features/featureEngine.mjs';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { rollingMean } from '../src/features/rolling.mjs';
import { atrSeries } from '../src/features/volatility.mjs';
import { computeRegimeByDate } from '../src/regime/marketRegimeV1.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.7: null volume, null benchmark, unavailable ATR stay
 * null with a reason — never 0, never a neutral substitute.
 */

test('null volume propagates as null through volume features, with VOLUME_MISSING reason', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'missing-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const snapshots = computeFeatureSnapshots({ symbol: 'MISS', series, priceBasis: 'SPLIT_ADJUSTED' });
  const i = 7; // inside the null-volume run (indices 5..9)
  assert.equal(series[i].volume, null);
  const relVol = snapshots[i].features.relativeVolume;
  assert.equal(relVol.value, null);
  // Current observation volume is null -> VOLUME_MISSING (precedence over short history).
  assert.equal(relVol.missingReason, 'VOLUME_MISSING');
  // volumeSma20 before a full window is INSUFFICIENT_HISTORY when the series is simply too short.
  assert.equal(snapshots[i].features.volumeSma20.missingReason, 'INSUFFICIENT_HISTORY');
  // Once 20 bars exist, a null inside the window is VOLUME_MISSING.
  const fullWindow = snapshots[19].features.volumeSma20;
  assert.equal(fullWindow.value, null);
  assert.equal(fullWindow.missingReason, 'VOLUME_MISSING');
  // A null inside the window also nullifies the rolling average (no forward-fill).
  assert.equal(snapshots[12].features.volumeSma20.value, null);
});

test('rolling helpers return null for any window containing a null', () => {
  const out = rollingMean([1, 2, null, 4, 5, 6], 3);
  assert.deepEqual(out, [null, null, null, null, null, 5]);
});

test('ATR is null before enough history exists (INSUFFICIENT_HISTORY, never 0)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const snapshots = computeFeatureSnapshots({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED' });
  const early = snapshots[5].features.atr14;
  assert.equal(early.value, null);
  assert.equal(early.missingReason, 'INSUFFICIENT_HISTORY');
  assert.equal(atrSeries([null, null, null], 14).every((v) => v === null), true);
});

test('missing benchmark dates yield BENCHMARK_DATE_MISSING; absent series yields BENCHMARK_UNAVAILABLE', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'multi-symbol-bars.json'), 'utf8'));
  const opts = (s) => ({ symbol: s, source: 'fixture', ohlcBasis: 'SPLIT_ADJUSTED' });
  const tick = selectPriceBasis(normalizeDailyBars(fixture.symbols.TICK, opts('TICK')), 'SPLIT_ADJUSTED').series;
  const qqq = selectPriceBasis(normalizeDailyBars(fixture.symbols.QQQ, opts('QQQ')), 'SPLIT_ADJUSTED').series;
  const snapshots = computeFeatureSnapshots({ symbol: 'TICK', series: tick, priceBasis: 'SPLIT_ADJUSTED', benchmarks: { QQQ: qqq } });
  // Indices 30..32 exist for TICK but are absent from QQQ in the fixture.
  for (const i of [30, 31, 32]) {
    const rs = snapshots[i].features.rsRatioBenchmark;
    assert.equal(rs.value, null);
    assert.equal(rs.missingReason, 'BENCHMARK_DATE_MISSING');
  }
  // With no benchmark at all, every RS feature is null with BENCHMARK_UNAVAILABLE.
  const noBench = computeFeatureSnapshots({ symbol: 'TICK', series: tick, priceBasis: 'SPLIT_ADJUSTED' });
  const last = noBench[noBench.length - 1].features;
  for (const name of ['rsRatioBenchmark', 'relReturn20', 'relReturn60', 'rsRatioSlope20']) {
    assert.equal(last[name].value, null, name);
    assert.equal(last[name].missingReason, 'BENCHMARK_UNAVAILABLE', name);
  }
});

test('insufficient regime coverage yields UNKNOWN, never a neutral regime', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'multi-symbol-bars.json'), 'utf8'));
  const opts = (s) => ({ symbol: s, source: 'fixture', ohlcBasis: 'SPLIT_ADJUSTED' });
  const qqq = selectPriceBasis(normalizeDailyBars(fixture.symbols.QQQ, opts('QQQ')), 'SPLIT_ADJUSTED').series;
  const spy = selectPriceBasis(normalizeDailyBars(fixture.symbols.SPY, opts('SPY')), 'SPLIT_ADJUSTED').series;
  const dates = spy.map((b) => b.sessionDate);
  const availableAtByDate = new Map(spy.map((b) => [b.sessionDate, b.availableAt]));
  const regimes = computeRegimeByDate({ dates, availableAtByDate, benchmarks: { QQQ: qqq, SPY: spy } });
  assert.equal(regimes.get(dates[10]).state, 'UNKNOWN');
  assert.ok(regimes.get(dates[10]).reasons[0].includes('insufficient coverage'));
  // Missing VIX is reported as missing input, not silently defaulted.
  const late = regimes.get(dates[100]);
  assert.ok(late.inputsMissing.includes('VIX'));
});
