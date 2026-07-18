import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';
import { loadCsvDaily } from '../src/data/csvDailyAdapter.mjs';
import {
  findForbiddenMemoryMarkers,
  normalizeScanText,
} from './memoryScan.mjs';

const NO_COSTS = Object.freeze({
  commission: Object.freeze({ fixedPerOrder: 0, perShare: 0, minimum: 0 }),
  slippage: Object.freeze({ bps: 0, minPerShare: 0, gapMultiplier: 1 }),
});

function toRows(specs) {
  return specs.map(([date, open, high, low, close, volume, splitFactor, cashDividend]) => {
    const row = { date, open, high, low, close, volume };
    if (splitFactor !== undefined) row.splitFactor = splitFactor;
    if (cashDividend !== undefined) row.cashDividend = cashDividend;
    return row;
  });
}

function seriesFor(specs, { ohlcBasis = 'RAW', basis = 'RAW' } = {}) {
  const bars = normalizeDailyBars(toRows(specs), { symbol: 'TST', source: 'inline-fixture', ohlcBasis });
  return selectPriceBasis(bars, basis).series;
}

function scripted(script) {
  return {
    id: 'SCRIPTED_TEST',
    version: 'test/1',
    defaultParams: {},
    decide(ctx) {
      const d = script[ctx.sessionDate];
      return { intent: d?.intent ?? 'HOLD', stopLevel: d?.stopLevel ?? null, reasons: ['scripted'] };
    },
  };
}

function run(series, { script, priceBasis = 'RAW', initialCapital = 10000 } = {}) {
  return runBacktest({
    symbol: 'TST',
    series,
    priceBasis,
    strategy: scripted(script),
    initialCapital,
    ...NO_COSTS,
  });
}

const SPLIT_DIV_SAME_DAY = [
  ['2024-03-04', 100, 101, 99, 100, 1000],
  ['2024-03-05', 100, 101, 99, 100, 1000],
  ['2024-03-06', 50, 51, 49, 50, 2000, 2, 0.75],
  ['2024-03-07', 50, 51, 49, 50, 2000],
];

test('P2-1 — RAW split + dividend: CORPORATE_ACTION_ORDER_AMBIGUOUS', () => {
  const series = seriesFor(SPLIT_DIV_SAME_DAY, { ohlcBasis: 'RAW', basis: 'RAW' });
  assert.throws(
    () => run(series, { script: { '2024-03-04': { intent: 'ENTER_LONG' } }, priceBasis: 'RAW' }),
    /CORPORATE_ACTION_ORDER_AMBIGUOUS/
  );
});

test('P2-2 — SPLIT_ADJUSTED split + dividend: allowed, embedded split, dividend credited, qty unchanged', () => {
  const series = seriesFor(SPLIT_DIV_SAME_DAY, { ohlcBasis: 'SPLIT_ADJUSTED', basis: 'SPLIT_ADJUSTED' });
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' } },
    priceBasis: 'SPLIT_ADJUSTED',
  });
  // Entry at open 2024-03-05 @ 100 -> 100 shares.
  assert.equal(result.equityCurve[1].quantity, 100);
  assert.equal(result.equityCurve[2].quantity, 100); // no rescale on SPLIT_ADJUSTED
  assert.equal(result.totalDividendsCash, 75);
  const types = result.corporateActionEvents.map((e) => e.type);
  assert.ok(types.includes('SPLIT_ALREADY_EMBEDDED'));
  assert.ok(types.includes('CASH_DIVIDEND'));
  const div = result.corporateActionEvents.find((e) => e.type === 'CASH_DIVIDEND');
  assert.equal(div.eligibleQuantity, 100);
  assert.equal(div.cashImpact, 75);
});

test('P2-3 — TOTAL_RETURN split + dividend: allowed, no separate cash, informative events', () => {
  const series = seriesFor(SPLIT_DIV_SAME_DAY, {
    ohlcBasis: 'TOTAL_RETURN_ADJUSTED',
    basis: 'TOTAL_RETURN_ADJUSTED',
  });
  const result = run(series, {
    script: { '2024-03-04': { intent: 'ENTER_LONG' } },
    priceBasis: 'TOTAL_RETURN_ADJUSTED',
  });
  assert.equal(result.totalDividendsCash, 0);
  assert.equal(result.equityCurve[2].quantity, 100);
  const types = result.corporateActionEvents.map((e) => e.type);
  assert.ok(types.includes('SPLIT_ALREADY_EMBEDDED'));
  assert.ok(types.includes('CASH_DIVIDEND_ALREADY_EMBEDDED'));
});

test('P2-4 — DERIVED split + dividend: explicit refuse', () => {
  const rows = [
    { date: '2024-03-04', open: 100, high: 101, low: 99, close: 100, volume: 1000, adjclose: 100 },
    { date: '2024-03-05', open: 100, high: 101, low: 99, close: 100, volume: 1000, adjclose: 100 },
    { date: '2024-03-06', open: 50, high: 51, low: 49, close: 50, volume: 2000, adjclose: 100, splitFactor: 2, cashDividend: 0.75 },
    { date: '2024-03-07', open: 50, high: 51, low: 49, close: 50, volume: 2000, adjclose: 100 },
  ];
  const bars = normalizeDailyBars(rows, { symbol: 'TST', source: 'inline-fixture', ohlcBasis: 'RAW' });
  bars.forEach((b) => { b.lineage.totalReturnClose = b.adjusted.close; });
  const { series } = selectPriceBasis(bars, 'DERIVED_ADJUSTED');
  assert.throws(
    () => run(series, { script: { '2024-03-04': { intent: 'ENTER_LONG' } }, priceBasis: 'DERIVED_ADJUSTED' }),
    /CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED/
  );
});

test('P2-5 — RAW dividend without position: CASH_DIVIDEND_NOT_ENTITLED, cashImpact 0', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000, undefined, 0.5],
    ['2024-03-06', 100, 101, 99, 100, 1000],
  ]);
  const result = run(series, { script: {}, priceBasis: 'RAW' });
  assert.equal(result.totalDividendsCash, 0);
  assert.equal(result.corporateActionEvents.length, 1);
  assert.equal(result.corporateActionEvents[0].type, 'CASH_DIVIDEND_NOT_ENTITLED');
  assert.equal(result.corporateActionEvents[0].cashImpact, 0);
  assert.equal(result.corporateActionEvents[0].eligibleQuantity, 0);
});

test('P2-6 — SPLIT_ADJUSTED dividend without position: same behaviour', () => {
  const series = seriesFor([
    ['2024-03-04', 100, 101, 99, 100, 1000],
    ['2024-03-05', 100, 101, 99, 100, 1000, undefined, 0.5],
    ['2024-03-06', 100, 101, 99, 100, 1000],
  ], { ohlcBasis: 'SPLIT_ADJUSTED', basis: 'SPLIT_ADJUSTED' });
  const result = run(series, { script: {}, priceBasis: 'SPLIT_ADJUSTED' });
  assert.equal(result.totalDividendsCash, 0);
  assert.equal(result.corporateActionEvents[0].type, 'CASH_DIVIDEND_NOT_ENTITLED');
  assert.equal(result.corporateActionEvents[0].cashImpact, 0);
});

test('P2-7 — anti-memory scan is case-insensitive', () => {
  assert.ok(findForbiddenMemoryMarkers('MEMORY' + '.md').length > 0);
  assert.ok(findForbiddenMemoryMarkers('Memory' + '.md').length > 0);
  assert.ok(findForbiddenMemoryMarkers('memory' + '.md').length > 0);
});

test('P2-8 — anti-memory scan normalizes Windows and POSIX separators', () => {
  assert.ok(findForbiddenMemoryMarkers('C:\\Users\\x\\.' + 'claude\\memory').length > 0);
  assert.ok(findForbiddenMemoryMarkers('C:/Users/x/.' + 'CLAUDE/memory').length > 0);
  assert.equal(normalizeScanText('A\\B'), 'a/b');
});

test('P2-9 — CSV header-only refused with CSV_NO_DATA_ROWS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlab-csv-'));
  const p = join(dir, 'empty.csv');
  writeFileSync(p, 'date,open,high,low,close,volume\n');
  try {
    assert.throws(() => loadCsvDaily(p, { symbol: 'X' }), /CSV_NO_DATA_ROWS/);
    writeFileSync(p, 'date,open,high,low,close,volume\n\n\n');
    assert.throws(() => loadCsvDaily(p, { symbol: 'X' }), /CSV_NO_DATA_ROWS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P2-10 — CSV with blank lines between data rows is accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlab-csv-'));
  const p = join(dir, 'gaps.csv');
  writeFileSync(
    p,
    [
      'date,open,high,low,close,volume',
      '2024-01-02,10,11,9,10.5,1000',
      '',
      '2024-01-03,10.5,11.5,10,11,1100',
      '',
      '',
      '2024-01-04,11,12,10.5,11.5,1200',
    ].join('\n')
  );
  try {
    const { bars } = loadCsvDaily(p, { symbol: 'X' });
    assert.equal(bars.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
