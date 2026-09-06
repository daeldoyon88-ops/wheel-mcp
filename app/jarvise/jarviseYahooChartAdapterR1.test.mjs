/**
 * P3 Yahoo chart adapter coverage. Every provider result in this suite is a
 * local fixture authored by the test: nothing here reaches a provider, a
 * socket or the clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CANONICAL_DAILY_BARS_SCHEMA_VERSION } from '../../research/directional-lab/src/canonical/canonicalDailyBarsV1.mjs';
import { parseCanonicalJsonBytes } from '../../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import {
  JARVISE_YAHOO_CHART_ADAPTER_VERSION,
  SOURCE_REPRESENTATION,
  canonicalProviderResultBytesR1,
  chartResultToDailyRowsR1,
  loadPinnedSessionsR1,
  normalizeJarviseYahooChartR1,
  parseCanonicalProviderResultBytesR1,
  toJsonDomainValueR1,
} from './jarviseYahooChartAdapterR1.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIRST_SESSION_DATE = '2018-01-02';
const LAST_SESSION_DATE = '2026-09-04';

/** A regular session, a half-day session with a dividend, and a split day. */
function chartFixture(overrides = {}) {
  return {
    meta: {
      symbol: 'TEST',
      currency: 'USD',
      exchangeName: 'NYQ',
      firstTradeDate: new Date('2018-01-02T14:30:00.000Z'),
      regularMarketTime: new Date('2024-12-24T18:00:00.000Z'),
    },
    quotes: [
      { date: new Date('2024-07-02T13:30:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, adjclose: 1.4 },
      { date: new Date('2024-07-03T13:30:00.000Z'), open: 2, high: 3, low: 1.5, close: 2.5, volume: 50, adjclose: 2.4 },
      { date: new Date('2024-12-24T14:30:00.000Z'), open: 3, high: 4, low: 2.5, close: 3.5, volume: 70, adjclose: 3.4 },
    ],
    events: {
      dividends: [{ amount: 0.25, date: new Date('2024-07-03T13:30:00.000Z') }],
      splits: [{ date: new Date('2024-12-24T14:30:00.000Z'), numerator: 4, denominator: 1, splitRatio: '4:1' }],
    },
    ...overrides,
  };
}

const normalizeFixture = (chart, options = {}) => normalizeJarviseYahooChartR1({
  sourceBytes: canonicalProviderResultBytesR1(chart),
  expectedSymbol: 'TEST',
  firstSessionDate: FIRST_SESSION_DATE,
  lastSessionDate: LAST_SESSION_DATE,
  root: REPOSITORY_ROOT,
  ...options,
});

test('P3-A1 canonical provider serialization is byte-deterministic and key-order independent', () => {
  const first = canonicalProviderResultBytesR1(chartFixture());
  const second = canonicalProviderResultBytesR1(chartFixture());
  assert.ok(first.equals(second));

  const reordered = chartFixture();
  const rebuilt = { events: reordered.events, quotes: reordered.quotes, meta: reordered.meta };
  assert.ok(canonicalProviderResultBytesR1(rebuilt).equals(first), 'object key order must not change the pinned bytes');

  const text = first.toString('utf8');
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'exactly one LF terminator');
  assert.ok(!text.includes('\r'), 'no CR may enter the pinned bytes');
  assert.equal(SOURCE_REPRESENTATION, 'CANONICAL_PROVIDER_RESULT_BYTES');
});

test('P3-A2 Dates become strict UTC instants and undefined members are dropped', () => {
  const projected = toJsonDomainValueR1({
    at: new Date('2024-07-03T13:30:00.000Z'),
    absent: undefined,
    kept: null,
    nested: [new Date('2018-01-02T14:30:00.000Z')],
  });
  assert.deepEqual(projected, {
    at: '2024-07-03T13:30:00.000Z',
    kept: null,
    nested: ['2018-01-02T14:30:00.000Z'],
  });
  assert.ok(!Object.hasOwn(projected, 'absent'));
});

test('P3-A3 pinned bytes round-trip and are what sourceObjectId addresses', () => {
  const bytes = canonicalProviderResultBytesR1(chartFixture());
  const recovered = parseCanonicalProviderResultBytesR1(bytes);
  assert.equal(recovered.meta.symbol, 'TEST');
  assert.equal(recovered.quotes.length, 3);
  assert.deepEqual(recovered, parseCanonicalJsonBytes(bytes));
  const objectId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.match(objectId, /^sha256:[0-9a-f]{64}$/);
});

test('P3-A4 normalization is deterministic and yields CanonicalDailyBars/1', () => {
  const first = normalizeFixture(chartFixture());
  const second = normalizeFixture(chartFixture());
  assert.equal(first.schemaVersion, CANONICAL_DAILY_BARS_SCHEMA_VERSION);
  assert.deepEqual(first, second);
  assert.equal(first.bars.length, 3);
  assert.deepEqual(first.bars.map((bar) => bar.sessionDate), ['2024-07-02', '2024-07-03', '2024-12-24']);
});

test('P3-A5 half-day timestamps stay pinned to the canonical session close', () => {
  const normalized = normalizeFixture(chartFixture());
  const byDate = new Map(normalized.bars.map((bar) => [bar.sessionDate, bar]));

  // Regular session: 21:00Z in winter, 20:00Z under EDT.
  assert.equal(byDate.get('2024-07-02').eventTime, '2024-07-02T20:00:00.000Z');

  // Half-days. A DST-derived wall-clock close would wrongly say 20:00Z here.
  assert.equal(byDate.get('2024-07-03').eventTime, '2024-07-03T17:00:00.000Z');
  assert.equal(byDate.get('2024-07-03').availableAt, '2024-07-03T17:00:00.000Z');
  assert.equal(byDate.get('2024-12-24').eventTime, '2024-12-24T18:00:00.000Z');
  assert.equal(byDate.get('2024-12-24').availableAt, '2024-12-24T18:00:00.000Z');

  const sessions = loadPinnedSessionsR1({ root: REPOSITORY_ROOT });
  for (const bar of normalized.bars) {
    const session = sessions.find((candidate) => candidate.sessionDate === bar.sessionDate);
    assert.equal(bar.eventTime, session.closeUtc, `${bar.sessionDate} must use the pinned calendar close`);
  }
});

test('P3-A6 splits and dividends are carried per bar under OD-P3-2', () => {
  const normalized = normalizeFixture(chartFixture());
  const byDate = new Map(normalized.bars.map((bar) => [bar.sessionDate, bar]));
  assert.equal(byDate.get('2024-07-03').corporateActions.cashDividend, 0.25);
  assert.equal(byDate.get('2024-12-24').corporateActions.splitFactor, 4);
  assert.equal(byDate.get('2024-07-02').corporateActions.splitFactor, null);
  assert.equal(byDate.get('2024-07-02').corporateActions.cashDividend, null);

  const extracted = chartResultToDailyRowsR1(parseCanonicalProviderResultBytesR1(canonicalProviderResultBytesR1(chartFixture())));
  assert.equal(extracted.splitCount, 1);
  assert.equal(extracted.dividendCount, 1);
});

test('P3-A7 an empty provider result fails closed and is never pinned as an empty series', () => {
  assert.throws(
    () => normalizeFixture(chartFixture({ quotes: [] })),
    (error) => error.code === 'PROVIDER_RESULT_EMPTY',
  );
});

test('P3-A8 malformed provider results fail closed', () => {
  assert.throws(() => normalizeFixture(chartFixture({ quotes: undefined })), (e) => e.code === 'PROVIDER_RESULT_MALFORMED');
  assert.throws(() => normalizeFixture(chartFixture({ meta: undefined })), (e) => e.code === 'PROVIDER_RESULT_MALFORMED');
  // A non-finite amount cannot be canonically serialized at all, so it is
  // refused before any bytes could be pinned. That is a stricter boundary than
  // extraction-time validation, not a weaker one.
  assert.throws(
    () => normalizeFixture(chartFixture({
      events: { dividends: [{ amount: Number.NaN, date: new Date('2024-07-03T13:30:00.000Z') }], splits: [] },
    })),
    (e) => e.code === 'PROVIDER_RESULT_INVALID',
  );
  // A serializable but unusable amount is refused at extraction instead.
  assert.throws(
    () => normalizeFixture(chartFixture({
      events: { dividends: [{ amount: null, date: new Date('2024-07-03T13:30:00.000Z') }], splits: [] },
    })),
    (e) => e.code === 'PROVIDER_RESULT_MALFORMED',
  );
  assert.throws(
    () => normalizeFixture(chartFixture({
      events: { dividends: [], splits: [{ date: new Date('2024-12-24T14:30:00.000Z'), numerator: 4, denominator: 0, splitRatio: 'bad' }] },
    })),
    (e) => e.code === 'PROVIDER_RESULT_MALFORMED',
  );
});

test('P3-A9 a duplicate session date fails closed', () => {
  const duplicated = chartFixture();
  duplicated.quotes = [duplicated.quotes[0], { ...duplicated.quotes[0] }];
  assert.throws(() => normalizeFixture(duplicated), (e) => e.code === 'PROVIDER_RESULT_MALFORMED');
});

test('P3-A10 a symbol the cohort did not ask for fails closed', () => {
  const other = chartFixture();
  other.meta = { ...other.meta, symbol: 'OTHER' };
  assert.throws(() => normalizeFixture(other), (e) => e.code === 'PROVIDER_SYMBOL_MISMATCH');
});

test('P3-A11 sessions outside the ratified window are refused, never silently dropped', () => {
  const beyond = chartFixture();
  beyond.quotes = [{ date: new Date('2026-09-08T13:30:00.000Z'), open: 1, high: 2, low: 1, close: 2, volume: 10 }];
  assert.throws(() => normalizeFixture(beyond), (e) => e.code === 'ADAPTER_SESSION_OUT_OF_WINDOW');
});

test('P3-A12 a session absent from pinned calendar V2 is refused', () => {
  const holiday = chartFixture();
  // 2024-07-04 is Independence Day: a weekday that is not an XNYS session.
  holiday.quotes = [{ date: new Date('2024-07-04T13:30:00.000Z'), open: 1, high: 2, low: 1, close: 2, volume: 10 }];
  holiday.events = { dividends: [], splits: [] };
  assert.throws(() => normalizeFixture(holiday), (e) => e.code === 'ADAPTER_SESSION_NOT_IN_CALENDAR');
});

test('P3-A13 the adapter reports its version and never claims a vintage', () => {
  assert.equal(JARVISE_YAHOO_CHART_ADAPTER_VERSION, 'jarviseYahooChartAdapterR1/1');
  const normalized = normalizeFixture(chartFixture());
  assert.ok(!JSON.stringify(normalized).includes('POINT_IN_TIME_VINTAGE'));
});
