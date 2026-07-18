import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { buildDatasetManifest } from '../src/data/buildDatasetManifest.mjs';
import { computeCoverageMetrics, coveragePercent } from '../src/data/coverageMetrics.mjs';
import { datasetManifestProblems } from '../src/contracts/datasetManifestV1.mjs';
import { buildQualityReport } from '../src/data/qualityReport.mjs';
import { validateDailyBars } from '../src/data/validateDailyBars.mjs';

function withTempSource(bars, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dlab-cov-'));
  const sourcePath = join(dir, 'src.json');
  writeFileSync(sourcePath, JSON.stringify({ rows: [] }));
  try {
    return fn(sourcePath, bars);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bar(date, { open = 10, high = 11, low = 9, close = 10.5, volume = 1000, raw = false } = {}) {
  const row = { date, open, high, low, close, volume };
  return row;
}

function barsFrom(specs, ohlcBasis = 'RAW') {
  return normalizeDailyBars(specs.map((s) => (typeof s === 'string' ? bar(s) : bar(s.date, s))), {
    symbol: 'COV',
    source: 'inline',
    ohlcBasis,
  });
}

test('M1 — RAW complete on every bar: coverage 100, available true, complete true', () => {
  const bars = barsFrom(['2024-01-02', '2024-01-03', '2024-01-04']);
  const c = computeCoverageMetrics(bars);
  assert.equal(c.rawOhlcValidBars, 3);
  assert.equal(c.rawOhlcCoveragePct, 100);
  assert.equal(c.rawOhlcAvailable, true);
  assert.equal(c.rawOhlcComplete, true);
});

test('M2 — RAW partial (one bar missing high): available true, complete false', () => {
  const bars = barsFrom([
    { date: '2024-01-02' },
    { date: '2024-01-03', high: null },
    { date: '2024-01-04' },
  ]);
  // force null high after normalize by patching
  bars[1].raw.high = null;
  const c = computeCoverageMetrics(bars);
  assert.equal(c.rawOhlcValidBars, 2);
  assert.ok(c.rawOhlcCoveragePct < 100);
  assert.equal(c.rawOhlcAvailable, true);
  assert.equal(c.rawOhlcComplete, false);
});

test('M3 — close alone never counts as complete OHLC', () => {
  const bars = barsFrom([{ date: '2024-01-02' }, { date: '2024-01-03' }]);
  for (const b of bars) {
    b.raw.open = null;
    b.raw.high = null;
    b.raw.low = null;
    // close remains
  }
  const c = computeCoverageMetrics(bars);
  assert.equal(c.rawOhlcValidBars, 0);
  assert.equal(c.rawOhlcAvailable, false);
  assert.equal(c.rawOhlcComplete, false);
  assert.equal(c.rawOhlcCoveragePct, 0);
});

test('M4 — adjusted complete', () => {
  const bars = barsFrom(['2024-01-02', '2024-01-03'], 'SPLIT_ADJUSTED');
  const c = computeCoverageMetrics(bars);
  assert.equal(c.adjustedOhlcComplete, true);
  assert.equal(c.adjustedOhlcAvailable, true);
  assert.equal(c.adjustedOhlcCoveragePct, 100);
});

test('M5 — adjusted close alone is not complete', () => {
  const bars = barsFrom(['2024-01-02', '2024-01-03'], 'SPLIT_ADJUSTED');
  for (const b of bars) {
    b.adjusted.open = null;
    b.adjusted.high = null;
    b.adjusted.low = null;
  }
  const c = computeCoverageMetrics(bars);
  assert.equal(c.adjustedOhlcValidBars, 0);
  assert.equal(c.adjustedOhlcComplete, false);
  assert.equal(c.adjustedOhlcAvailable, false);
});

test('M6 — volume complete', () => {
  const bars = barsFrom(['2024-01-02', '2024-01-03', '2024-01-04']);
  const c = computeCoverageMetrics(bars);
  assert.equal(c.volumeComplete, true);
  assert.equal(c.volumeAvailable, true);
  assert.equal(c.volumeCoveragePct, 100);
});

test('M7 — single volume among several bars: available true, complete false, exact coverage', () => {
  const bars = barsFrom(['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']);
  bars[0].raw.volume = null;
  bars[1].raw.volume = null;
  bars[2].raw.volume = null;
  // bars[3] keeps volume
  const c = computeCoverageMetrics(bars);
  assert.equal(c.volumeValidBars, 1);
  assert.equal(c.volumeCoveragePct, 25);
  assert.equal(c.volumeAvailable, true);
  assert.equal(c.volumeComplete, false);
});

test('M8 — no volume: available false, complete false, coverage 0', () => {
  const bars = barsFrom(['2024-01-02', '2024-01-03']);
  for (const b of bars) b.raw.volume = null;
  const c = computeCoverageMetrics(bars);
  assert.equal(c.volumeValidBars, 0);
  assert.equal(c.volumeCoveragePct, 0);
  assert.equal(c.volumeAvailable, false);
  assert.equal(c.volumeComplete, false);
});

test('M9 — empty dataset is not silently admissible / never complete', () => {
  withTempSource([], (sourcePath, bars) => {
    const { manifest, validation } = buildDatasetManifest({
      sourcePath,
      symbol: 'EMPTY',
      format: 'CSV_DAILY_V1',
      bars,
    });
    assert.equal(manifest.barCount, 0);
    assert.equal(manifest.rawOhlcComplete, false);
    assert.equal(manifest.adjustedOhlcComplete, false);
    assert.equal(manifest.volumeComplete, false);
    assert.ok(manifest.qualityFlags.includes('EMPTY_DATASET'));
    const report = buildQualityReport({ manifest, validation });
    assert.equal(report.admissible, false);
  });
});

test('M10 — percentages and counts stay coherent on the manifest', () => {
  withTempSource(barsFrom(['2024-01-02', '2024-01-03', '2024-01-04']), (sourcePath, bars) => {
    bars[1].raw.high = null;
    const { manifest } = buildDatasetManifest({
      sourcePath,
      symbol: 'COV',
      format: 'CSV_DAILY_V1',
      bars,
    });
    assert.deepEqual(datasetManifestProblems(manifest), []);
    assert.equal(manifest.rawOhlcValidBars, 2);
    assert.equal(manifest.rawOhlcCoveragePct, coveragePercent(2, 3));
    assert.equal(manifest.rawOhlcAvailable, true);
    assert.equal(manifest.rawOhlcComplete, false);
  });
});

test('M11 — deterministic coverage percent with non-integer fraction', () => {
  assert.equal(coveragePercent(1, 3), 33.333333);
  assert.equal(coveragePercent(2, 3), 66.666667);
  assert.equal(coveragePercent(0, 0), 0);
});

test('M12 — incoherent manifest is refused', () => {
  const bad = {
    schemaVersion: 'DatasetManifestV1',
    symbol: 'X',
    sourcePath: '/tmp/x',
    sourceGitStatus: 'fixture',
    sourceFormat: 'CSV_DAILY_V1',
    contentHash: 'a'.repeat(64),
    firstDate: '2024-01-02',
    lastDate: '2024-01-03',
    barCount: 2,
    coverageVersion: 'coverage/1',
    rawOhlcValidBars: 2,
    rawOhlcCoveragePct: 50, // inconsistent
    rawOhlcAvailable: true,
    rawOhlcComplete: true,
    adjustedOhlcValidBars: 2,
    adjustedOhlcCoveragePct: 100,
    adjustedOhlcAvailable: true,
    adjustedOhlcComplete: true,
    volumeValidBars: 2,
    volumeCoveragePct: 100,
    volumeAvailable: true,
    volumeComplete: true,
    adjustedCloseAvailable: true,
    nativeAdjustmentType: 'RAW',
    splitsDocumented: false,
    qualityFlags: [],
    warnings: [],
    gapStats: {},
    lineage: {},
  };
  const problems = datasetManifestProblems(bad);
  assert.ok(problems.some((p) => p.includes('rawOhlcCoveragePct')));
});

test('validateDailyBars still reports series stats for coverage builders', () => {
  const bars = barsFrom(['2024-01-02', '2024-01-03']);
  const v = validateDailyBars(bars);
  assert.equal(v.stats.bars, 2);
  assert.deepEqual(v.problems, []);
});
