import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeCsvHeader, canonicalizeCsvHeaderRow } from '../src/data/csvHeader.mjs';
import { loadCsvDaily } from '../src/data/csvDailyAdapter.mjs';

/**
 * C1-C13 — canonical CSV header normalization (BOM, case, spaces, synonyms),
 * collision/malformed-row refusal, and corporate action columns transported
 * into DailyBarV1. Temp files live under os.tmpdir() and are deleted here.
 */

function withTempCsv(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dlab-csv-'));
  const file = join(dir, 'input.csv');
  try {
    writeFileSync(file, content, 'utf8');
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function load(content, options = {}) {
  return withTempCsv(content, (file) => loadCsvDaily(file, { symbol: 'TST', ...options }));
}

test('canonicalizeCsvHeader maps the usual synonyms and rejects unknowns as null', () => {
  assert.equal(canonicalizeCsvHeader('date'), 'date');
  assert.equal(canonicalizeCsvHeader('Date'), 'date');
  assert.equal(canonicalizeCsvHeader('DATE'), 'date');
  assert.equal(canonicalizeCsvHeader('sessionDate'), 'date');
  assert.equal(canonicalizeCsvHeader('Session Date'), 'date');
  assert.equal(canonicalizeCsvHeader('session_date'), 'date');
  assert.equal(canonicalizeCsvHeader('Open'), 'open');
  assert.equal(canonicalizeCsvHeader('HIGH'), 'high');
  assert.equal(canonicalizeCsvHeader('low'), 'low');
  assert.equal(canonicalizeCsvHeader('Close'), 'close');
  assert.equal(canonicalizeCsvHeader('Volume'), 'volume');
  assert.equal(canonicalizeCsvHeader('adjclose'), 'adjclose');
  assert.equal(canonicalizeCsvHeader('adjClose'), 'adjclose');
  assert.equal(canonicalizeCsvHeader('Adj Close'), 'adjclose');
  assert.equal(canonicalizeCsvHeader('Adjusted Close'), 'adjclose');
  assert.equal(canonicalizeCsvHeader('adjusted_close'), 'adjclose');
  assert.equal(canonicalizeCsvHeader('Adj Open'), 'adjOpen');
  assert.equal(canonicalizeCsvHeader('Adj High'), 'adjHigh');
  assert.equal(canonicalizeCsvHeader('Adj Low'), 'adjLow');
  assert.equal(canonicalizeCsvHeader('Adj Volume'), 'adjVolume');
  assert.equal(canonicalizeCsvHeader('Raw Open'), 'rawOpen');
  assert.equal(canonicalizeCsvHeader('rawclose'), 'rawClose');
  assert.equal(canonicalizeCsvHeader('Split Factor'), 'splitFactor');
  assert.equal(canonicalizeCsvHeader('split_factor'), 'splitFactor');
  assert.equal(canonicalizeCsvHeader('Cash Dividend'), 'cashDividend');
  assert.equal(canonicalizeCsvHeader('cash_dividend'), 'cashDividend');
  assert.equal(canonicalizeCsvHeader('Dividend'), 'cashDividend');
  assert.equal(canonicalizeCsvHeader('﻿Date'), 'date');
  assert.equal(canonicalizeCsvHeader('  Close  '), 'close');
  assert.equal(canonicalizeCsvHeader('mystery'), null);
  assert.equal(canonicalizeCsvHeader(''), null);
});

test('C1 — standard lowercase headers load', () => {
  const { bars } = load('date,open,high,low,close,volume\n2024-03-04,100,101,99,100,1000\n');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].sessionDate, '2024-03-04');
  assert.deepEqual(bars[0].raw, { open: 100, high: 101, low: 99, close: 100, volume: 1000 });
});

test('C2 — capitalized headers (Date,Open,High,Low,Close,Volume) load identically', () => {
  const { bars } = load('Date,Open,High,Low,Close,Volume\n2024-03-04,100,101,99,100,1000\n');
  assert.equal(bars[0].sessionDate, '2024-03-04');
  assert.deepEqual(bars[0].raw, { open: 100, high: 101, low: 99, close: 100, volume: 1000 });
});

test('C3 — Yahoo format: Adj Close is transported as the adjusted close, never mixed', () => {
  const { bars } = load('Date,Open,High,Low,Close,Adj Close,Volume\n2024-03-04,100,101,99,100,50,1000\n');
  assert.equal(bars[0].raw.close, 100);
  assert.equal(bars[0].adjusted.close, 50);
  assert.equal(bars[0].adjusted.adjustmentType, 'TOTAL_RETURN_ADJUSTED');
});

test('C4 — UTF-8 BOM on the first header is stripped', () => {
  const { bars } = load('﻿Date,Open,High,Low,Close,Volume\n2024-03-04,100,101,99,100,1000\n');
  assert.equal(bars[0].sessionDate, '2024-03-04');
});

test('C5 — headers and cells with surrounding spaces load', () => {
  const { bars } = load(' Date , Open , High , Low , Close , Volume \n 2024-03-04 , 100 , 101 , 99 , 100 , 1000 \n');
  assert.equal(bars[0].sessionDate, '2024-03-04');
  assert.equal(bars[0].raw.close, 100);
});

test('C6 — snake_case headers (session_date, adjusted_close, split_factor, cash_dividend)', () => {
  const { bars } = load(
    'session_date,open,high,low,close,volume,adjusted_close,split_factor,cash_dividend\n' +
    '2024-03-04,100,101,99,100,1000,50,2,0.75\n'
  );
  assert.equal(bars[0].sessionDate, '2024-03-04');
  assert.equal(bars[0].adjusted.close, 50);
  assert.equal(bars[0].corporateActions.splitFactor, 2);
  assert.equal(bars[0].corporateActions.cashDividend, 0.75);
});

test('C7 — unknown columns are reported in ignoredColumns, never interpreted', () => {
  const { bars, sourceMeta } = load('date,open,high,low,close,volume,mystery\n2024-03-04,100,101,99,100,1000,42\n');
  assert.deepEqual(sourceMeta.ignoredColumns, ['mystery']);
  assert.deepEqual(bars[0].raw, { open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  assert.deepEqual(bars[0].corporateActions, { splitFactor: null, cashDividend: null });
});

test('C8 — two columns normalizing to the same canonical name are refused (CSV_HEADER_COLLISION)', () => {
  assert.throws(
    () => load('date,open,high,low,Close,close\n2024-03-04,100,101,99,100,100\n'),
    /CSV_HEADER_COLLISION/
  );
  assert.throws(() => canonicalizeCsvHeaderRow(['Close', 'close']), /CSV_HEADER_COLLISION/);
});

test('C9 — a missing required column is a clear error', () => {
  assert.throws(
    () => load('date,open,high,low,volume\n2024-03-04,100,101,99,1000\n'),
    /missing required column "close"/
  );
});

test('C10 — a row with the wrong cell count is refused with its line number', () => {
  assert.throws(
    () => load('date,open,high,low,close,volume\n2024-03-04,100,101,99,100,1000\n2024-03-05,100,101,99,100\n'),
    /line 3 has 5 cell\(s\) but the header has 6 column\(s\)/
  );
});

test('C11 — an empty field stays null (volume missing, never 0)', () => {
  const { bars } = load('date,open,high,low,close,volume\n2024-03-04,100,101,99,100,\n');
  assert.equal(bars[0].raw.volume, null);
  assert.ok(bars[0].qualityFlags.includes('VOLUME_MISSING'));
});

test('C12 — quoted fields are explicitly out of scope', () => {
  assert.throws(
    () => load('date,open,high,low,close,volume\n"2024-03-04",100,101,99,100,1000\n'),
    /Quoted CSV fields are not supported/
  );
});

test('C13 — splitFactor and cashDividend columns land in DailyBarV1.corporateActions', () => {
  const { bars } = load(
    'date,open,high,low,close,volume,splitFactor,cashDividend\n' +
    '2024-03-04,100,101,99,100,1000,,\n' +
    '2024-03-05,50,51,49,50,2000,0.5,\n' +
    '2024-03-06,50,51,49,50,2000,,0.25\n'
  );
  assert.deepEqual(bars[0].corporateActions, { splitFactor: null, cashDividend: null });
  assert.deepEqual(bars[1].corporateActions, { splitFactor: 0.5, cashDividend: null });
  assert.deepEqual(bars[2].corporateActions, { splitFactor: null, cashDividend: 0.25 });
});
