import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalHash,
  canonicalJsonBytes,
  canonicalJsonText,
  parseCanonicalJsonBytes,
} from '../src/canonical/canonicalJsonV1.mjs';
import {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  normalizeCanonicalDailyBarsV1,
} from '../src/canonical/canonicalDailyBarsV1.mjs';
import { normalizeCanonicalValue } from '../src/canonical/canonicalSchemaRegistryV1.mjs';

function bar(overrides = {}) {
  return {
    sessionDate: '2026-01-05',
    eventTime: '2026-01-05T21:00:00Z',
    availableAt: '2026-01-05T21:00:00Z',
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1000,
    corporateActions: { splitFactor: null, cashDividend: null },
    qualityFlags: [],
    ...overrides,
  };
}

function bars(value) {
  return { schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION, bars: value };
}

function code(expected) {
  return (error) => error && error.code === expected;
}

test('CJ1 — insertion order does not change canonical bytes', () => {
  const a = { z: 1, a: { y: 2, x: 3 } };
  const b = { a: { x: 3, y: 2 }, z: 1 };
  assert.deepEqual(canonicalJsonBytes(a), canonicalJsonBytes(b));
});

test('CJ2 — 1 and 1.0 have the same shortest-round-trip representation', () => {
  assert.equal(canonicalJsonText({ n: 1 }), canonicalJsonText({ n: 1.0 }));
  assert.equal(canonicalJsonText({ n: 1 }), '{"n":1}\n');
});

test('CJ3 — negative zero is serialized as zero', () => {
  assert.equal(canonicalJsonText({ n: -0 }), '{"n":0}\n');
});

test('CJ4 — null and absent are distinct', () => {
  assert.notDeepEqual(canonicalJsonBytes({ n: null }), canonicalJsonBytes({}));
});

test('CJ5 — undefined is refused at every depth', () => {
  assert.throws(() => canonicalJsonBytes({ nested: [undefined] }), code('CANONICAL_UNDEFINED'));
});

test('CJ6 — NaN and infinities are refused', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalJsonBytes({ value }), code('CANONICAL_NON_FINITE_NUMBER'));
  }
});

test('CJ7 — unsafe integers are refused', () => {
  assert.throws(() => canonicalJsonBytes({ n: Number.MAX_SAFE_INTEGER + 1 }), code('CANONICAL_UNSAFE_INTEGER'));
});

test('CJ8 — isolated UTF-16 surrogates are refused', () => {
  assert.throws(() => canonicalJsonBytes({ bad: '\ud800' }), code('CANONICAL_INVALID_UNICODE'));
  assert.throws(() => canonicalJsonBytes({ bad: '\udc00' }), code('CANONICAL_INVALID_UNICODE'));
});

test('CJ9 — Unicode is not normalized implicitly', () => {
  const composed = canonicalJsonBytes({ text: '\u00e9' });
  const decomposed = canonicalJsonBytes({ text: 'e\u0301' });
  assert.notDeepEqual(composed, decomposed);
});

test('CJ10 — canonical bytes are UTF-8 without BOM and end in one LF', () => {
  const bytes = canonicalJsonBytes({ text: 'caf\u00e9' });
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.at(-1), 0x0a);
  assert.notEqual(bytes.at(-2), 0x0a);
});

test('CJ11 — a BOM-bearing canonical input is refused', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n')]);
  assert.throws(() => parseCanonicalJsonBytes(bytes), code('CANONICAL_BOM_FORBIDDEN'));
});

test('CJ12 — non-canonical whitespace, CRLF and missing LF are refused', () => {
  for (const bytes of [Buffer.from('{ "a":1 }\n'), Buffer.from('{"a":1}\r\n'), Buffer.from('{"a":1}')]) {
    assert.throws(() => parseCanonicalJsonBytes(bytes), code('CANONICAL_NON_CANONICAL_INPUT'));
  }
});

test('CJ13 — invalid UTF-8 is refused', () => {
  assert.throws(() => parseCanonicalJsonBytes(Buffer.from([0xc3, 0x28, 0x0a])), code('CANONICAL_INVALID_UNICODE'));
});

test('CJ14 — canonical parser round-trips exact bytes', () => {
  const bytes = canonicalJsonBytes({ z: [1, null], a: 'ok' });
  assert.deepEqual(parseCanonicalJsonBytes(bytes), { a: 'ok', z: [1, null] });
});

test('CDB1 — timestamp milliseconds, bar order, sets and -0 are normalized', () => {
  const normalized = normalizeCanonicalDailyBarsV1(bars([
    bar({ sessionDate: '2026-01-06', eventTime: '2026-01-06T21:00:00Z', availableAt: '2026-01-06T21:00:01Z', qualityFlags: ['Z', 'A', 'Z'] }),
    bar({ open: null, high: null, low: null, close: null, volume: -0, qualityFlags: ['NULL_PRICE'] }),
  ]));
  assert.deepEqual(normalized.bars.map((item) => item.sessionDate), ['2026-01-05', '2026-01-06']);
  assert.equal(normalized.bars[0].volume, 0);
  assert.equal(normalized.bars[1].availableAt, '2026-01-06T21:00:01.000Z');
  assert.deepEqual(normalized.bars[1].qualityFlags, ['A', 'Z']);
});

test('CDB2 — duplicate session dates are refused', () => {
  assert.throws(() => normalizeCanonicalDailyBarsV1(bars([bar(), bar()])), code('CANONICAL_DUPLICATE_SESSION_DATE'));
});

test('CDB3 — unknown fields are refused with a stable code', () => {
  assert.throws(() => normalizeCanonicalDailyBarsV1(bars([{ ...bar(), surprise: true }])), code('CANONICAL_UNKNOWN_FIELD'));
});

test('CDB4 — invalid civil dates and timestamps are refused', () => {
  assert.throws(() => normalizeCanonicalDailyBarsV1(bars([bar({ sessionDate: '2026-02-30' })])), code('CANONICAL_INVALID_DATE'));
  assert.throws(() => normalizeCanonicalDailyBarsV1(bars([bar({ availableAt: 'not-a-date' })])), code('CANONICAL_INVALID_DATE'));
});

test('CDB5 — nullable OHLC/actions stay null, never zero', () => {
  const normalized = normalizeCanonicalDailyBarsV1(bars([bar({
    open: null, high: null, low: null, close: null, volume: null,
    corporateActions: { splitFactor: null, cashDividend: null },
  })]));
  assert.equal(normalized.bars[0].close, null);
  assert.equal(normalized.bars[0].volume, null);
});

test('CDB6 — registry refuses unknown schemas', () => {
  assert.throws(() => normalizeCanonicalValue('Unknown/1', {}), code('CANONICAL_SCHEMA_UNKNOWN'));
});

test('CDB7 — golden vector is platform-independent compact UTF-8', () => {
  const normalized = normalizeCanonicalDailyBarsV1(bars([bar()]));
  const expected = '{"bars":[{"availableAt":"2026-01-05T21:00:00.000Z","close":11,"corporateActions":{"cashDividend":null,"splitFactor":null},"eventTime":"2026-01-05T21:00:00.000Z","high":12,"low":9,"open":10,"qualityFlags":[],"sessionDate":"2026-01-05","volume":1000}],"schemaVersion":"CanonicalDailyBars/1"}\n';
  assert.equal(canonicalJsonText(normalized), expected);
  assert.match(canonicalHash(CANONICAL_DAILY_BARS_SCHEMA_VERSION, normalized), /^sha256:[0-9a-f]{64}$/);
});

test('CDB8 — tracked fixture is synthetic, sorted, deduplicated and keeps permitted nulls/actions', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/cas/canonical-daily-bars-v1.input.json', import.meta.url), 'utf8'));
  const normalized = normalizeCanonicalDailyBarsV1(fixture);
  assert.deepEqual(normalized.bars.map((item) => item.sessionDate), ['2026-04-01', '2026-04-02', '2026-04-03']);
  assert.deepEqual(normalized.bars[0].qualityFlags, ['SYNTHETIC', 'SYNTHETIC_SPLIT']);
  assert.equal(normalized.bars[0].corporateActions.splitFactor, 2);
  assert.equal(normalized.bars[1].close, null);
  assert.equal(normalized.bars[2].corporateActions.cashDividend, 0.25);
});
