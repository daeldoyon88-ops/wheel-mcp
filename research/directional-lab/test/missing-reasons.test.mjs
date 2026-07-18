import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { computeFeatureSnapshots } from '../src/features/featureEngine.mjs';
import {
  MISSING_REASONS,
  isCanonicalMissingReason,
  reasonForTrailingWindow,
  pickMissingReason,
} from '../src/contracts/missingReasonsV1.mjs';
import { featureValue } from '../src/contracts/featureSnapshotV1.mjs';
import { smaSeries } from '../src/features/movingAverages.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function volumeSeries(n, { nullAt = [] } = {}) {
  const nullSet = new Set(nullAt);
  const rows = [];
  let d = Date.UTC(2024, 0, 2);
  for (let i = 0; i < n; i++) {
    while (new Date(d).getUTCDay() === 0 || new Date(d).getUTCDay() === 6) d += 86400000;
    const iso = new Date(d).toISOString();
    rows.push({
      date: iso,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: nullSet.has(i) ? null : 1000 + i,
    });
    d += 86400000;
  }
  const bars = normalizeDailyBars(rows, { symbol: 'V', source: 'inline', ohlcBasis: 'RAW' });
  return selectPriceBasis(bars, 'RAW').series;
}

test('R1 — volume SMA20 at day 5 with volumes present: INSUFFICIENT_HISTORY', () => {
  const series = volumeSeries(5);
  const snaps = computeFeatureSnapshots({ symbol: 'V', series, priceBasis: 'RAW' });
  assert.equal(snaps[4].features.volumeSma20.value, null);
  assert.equal(snaps[4].features.volumeSma20.missingReason, MISSING_REASONS.INSUFFICIENT_HISTORY);
});

test('R2 — 20 bars with a null volume in the window: VOLUME_MISSING', () => {
  const series = volumeSeries(20, { nullAt: [10] });
  const snaps = computeFeatureSnapshots({ symbol: 'V', series, priceBasis: 'RAW' });
  assert.equal(snaps[19].features.volumeSma20.value, null);
  assert.equal(snaps[19].features.volumeSma20.missingReason, MISSING_REASONS.VOLUME_MISSING);
});

test('R3 — benchmark series absent: BENCHMARK_UNAVAILABLE', () => {
  const series = volumeSeries(30);
  const snaps = computeFeatureSnapshots({ symbol: 'V', series, priceBasis: 'RAW' });
  assert.equal(snaps[29].features.rsRatioBenchmark.missingReason, MISSING_REASONS.BENCHMARK_UNAVAILABLE);
});

test('R4 — benchmark provided but date absent: BENCHMARK_DATE_MISSING', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'multi-symbol-bars.json'), 'utf8'));
  const opts = (s) => ({ symbol: s, source: 'fixture', ohlcBasis: 'SPLIT_ADJUSTED' });
  const tick = selectPriceBasis(normalizeDailyBars(fixture.symbols.TICK, opts('TICK')), 'SPLIT_ADJUSTED').series;
  const qqq = selectPriceBasis(normalizeDailyBars(fixture.symbols.QQQ, opts('QQQ')), 'SPLIT_ADJUSTED').series;
  const snaps = computeFeatureSnapshots({
    symbol: 'TICK',
    series: tick,
    priceBasis: 'SPLIT_ADJUSTED',
    benchmarks: { QQQ: qqq },
  });
  assert.equal(snaps[30].features.rsRatioBenchmark.missingReason, MISSING_REASONS.BENCHMARK_DATE_MISSING);
});

test('R5 — generic input missing: INPUT_MISSING', () => {
  assert.equal(
    reasonForTrailingWindow([1, null, 3], 3, 2, { nullReason: MISSING_REASONS.INPUT_MISSING }),
    MISSING_REASONS.INPUT_MISSING
  );
});

test('R6 — infinite input: INVALID_INPUT', () => {
  assert.equal(
    reasonForTrailingWindow([1, Infinity, 3], 3, 2),
    MISSING_REASONS.INVALID_INPUT
  );
  assert.throws(() => featureValue(Infinity, {
    asOf: '2024-01-02T21:00:00.000Z',
    availableAt: '2024-01-02T21:00:00.000Z',
    source: 't',
  }));
});

test('R7 — window with no valid observations: NO_VALID_OBSERVATIONS', () => {
  assert.equal(
    reasonForTrailingWindow([null, null, null], 3, 2),
    MISSING_REASONS.NO_VALID_OBSERVATIONS
  );
});

test('R8 — computed value has missingReason null', () => {
  const series = volumeSeries(25);
  const snaps = computeFeatureSnapshots({ symbol: 'V', series, priceBasis: 'RAW' });
  const fv = snaps[24].features.volumeSma20;
  assert.equal(typeof fv.value, 'number');
  assert.equal(fv.missingReason, null);
});

test('R9 — null without reason forbidden', () => {
  assert.throws(() => featureValue(null, {
    asOf: '2024-01-02T21:00:00.000Z',
    availableAt: '2024-01-02T21:00:00.000Z',
    source: 't',
  }));
});

test('R10 — unknown reason forbidden', () => {
  assert.equal(isCanonicalMissingReason('WEIRD'), false);
  assert.throws(() => featureValue(null, {
    asOf: '2024-01-02T21:00:00.000Z',
    availableAt: '2024-01-02T21:00:00.000Z',
    source: 't',
    missingReason: 'WEIRD',
  }));
});

test('R11 — reasons deterministic across two runs', () => {
  const series = volumeSeries(20, { nullAt: [5] });
  const a = computeFeatureSnapshots({ symbol: 'V', series, priceBasis: 'RAW' });
  const b = computeFeatureSnapshots({ symbol: 'V', series, priceBasis: 'RAW' });
  assert.equal(a[19].features.volumeSma20.missingReason, b[19].features.volumeSma20.missingReason);
  assert.equal(a[4].features.volumeSma20.missingReason, b[4].features.volumeSma20.missingReason);
});

test('R12 — numeric feature outputs unchanged on complete data', () => {
  const series = volumeSeries(30);
  const closes = series.map((b) => b.close);
  const expectedSma = smaSeries(closes, 20);
  const snaps = computeFeatureSnapshots({ symbol: 'V', series, priceBasis: 'RAW' });
  for (let i = 0; i < series.length; i++) {
    assert.equal(snaps[i].features.sma20.value, expectedSma[i]);
  }
});

test('precedence helper prefers INVALID_INPUT over INSUFFICIENT_HISTORY', () => {
  assert.equal(
    pickMissingReason([MISSING_REASONS.INSUFFICIENT_HISTORY, MISSING_REASONS.INVALID_INPUT]),
    MISSING_REASONS.INVALID_INPUT
  );
});
