import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dailyBarProblems } from '../src/contracts/dailyBarV1.mjs';
import { corporateActionProblems } from '../src/contracts/corporateActionV1.mjs';
import { normalizeDailyBars, sessionDateFromRowDate } from '../src/data/normalizeDailyBars.mjs';
import { loadJsonDaily, parseSplitRatio } from '../src/data/jsonDailyAdapter.mjs';
import { featureValue } from '../src/contracts/featureSnapshotV1.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function validBar() {
  return normalizeDailyBars(
    [{ date: '2024-03-15T14:30:00.000Z', open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000 }],
    { symbol: 'T', source: 'test', ohlcBasis: 'SPLIT_ADJUSTED' }
  )[0];
}

test('valid normalized bar passes the contract', () => {
  assert.deepEqual(dailyBarProblems(validBar()), []);
});

test('sessionDate comes from the civil part of the UTC date, no local timezone', () => {
  assert.equal(sessionDateFromRowDate('2024-03-15T14:30:00.000Z'), '2024-03-15');
  assert.equal(sessionDateFromRowDate('2024-11-03'), '2024-11-03');
  assert.throws(() => sessionDateFromRowDate('15/03/2024'));
});

test('negative price and negative volume are rejected', () => {
  const bar = validBar();
  bar.adjusted.low = -1;
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('strictly > 0')));
  const bar2 = validBar();
  bar2.adjusted.volume = -5;
  assert.ok(dailyBarProblems(bar2).some((p) => p.includes('negative volume')));
});

test('impossible OHLC (high < low/open/close) is rejected', () => {
  const bar = validBar();
  bar.adjusted.high = 9.0; // below low 9.5
  const problems = dailyBarProblems(bar);
  assert.ok(problems.some((p) => p.includes('impossible OHLC')));
});

test('availableAt cannot precede eventTime', () => {
  const bar = validBar();
  bar.availableAt = '2024-03-15T00:00:00.000Z';
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('availableAt')));
});

test('null volume stays null and is flagged, never coerced to 0', () => {
  const [bar] = normalizeDailyBars(
    [{ date: '2024-03-15T14:30:00.000Z', open: 10, high: 11, low: 9.5, close: 10.5, volume: null }],
    { symbol: 'T', source: 'test', ohlcBasis: 'SPLIT_ADJUSTED' }
  );
  assert.equal(bar.adjusted.volume, null);
  assert.ok(bar.qualityFlags.includes('VOLUME_MISSING'));
});

test('raw and adjusted blocks stay separate; raw missing is flagged, not fabricated', () => {
  const [bar] = normalizeDailyBars(
    [{ date: '2024-03-15T14:30:00.000Z', open: 10, high: 11, low: 9.5, close: 10.5, volume: 1 }],
    { symbol: 'T', source: 'test', ohlcBasis: 'SPLIT_ADJUSTED' }
  );
  assert.equal(bar.raw.close, null);
  assert.equal(bar.adjusted.close, 10.5);
  assert.equal(bar.adjusted.adjustmentType, 'SPLIT_ADJUSTED');
  assert.ok(bar.qualityFlags.includes('RAW_OHLC_MISSING'));
});

test('normalize rejects an unknown ohlcBasis', () => {
  assert.throws(() => normalizeDailyBars([], { symbol: 'T', source: 'test', ohlcBasis: 'MYSTERY' }));
});

test('json adapter loads a fixture and refuses a symbol mismatch', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  assert.equal(bars[0].symbol, 'TEST');
  assert.equal(bars[0].sessionDate, '2024-01-02');
  assert.throws(() => loadJsonDaily(join(FIXTURES, 'causal-bars.json'), { symbol: 'OTHER' }));
});

test('split ratio parsing', () => {
  assert.equal(parseSplitRatio('2:1'), 2);
  assert.equal(parseSplitRatio('1:6'), 1 / 6);
  assert.equal(parseSplitRatio('garbage'), null);
});

test('corporate action contract validates splits and dividends', () => {
  assert.deepEqual(corporateActionProblems({
    schemaVersion: 'CorporateActionV1', symbol: 'T', type: 'SPLIT', effectiveDate: '2024-01-05', splitFactor: 2, cashAmount: null, source: 'test',
  }), []);
  assert.ok(corporateActionProblems({
    schemaVersion: 'CorporateActionV1', symbol: 'T', type: 'SPLIT', effectiveDate: '2024-01-05', splitFactor: -2, cashAmount: null, source: 'test',
  }).length > 0);
});

test('featureValue enforces null <-> missingReason pairing and refuses NaN', () => {
  const meta = { asOf: 'x', availableAt: 'x', source: 'test' };
  assert.throws(() => featureValue(null, meta));
  assert.throws(() => featureValue(5, { ...meta, missingReason: 'WHY' }));
  assert.throws(() => featureValue(NaN, meta));
  assert.equal(featureValue(null, { ...meta, missingReason: 'INPUT_MISSING' }).missingReason, 'INPUT_MISSING');
  assert.throws(() => featureValue(null, { ...meta, missingReason: 'NO_DATA' }));
});
