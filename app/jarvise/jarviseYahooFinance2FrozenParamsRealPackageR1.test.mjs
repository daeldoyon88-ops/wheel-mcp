/**
 * P3H offline real yahoo-finance2@3.14.0 frozen-param coverage.
 * Fetch sentinel only. Zero external Yahoo/HTTP/DNS.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createJarviseYahooFinance2ChartClientR1 } from './jarviseYahooFinance2ChartClientFactoryR1.mjs';
import { canonicalChartParamsR1, mutableProviderChartParamsR1 } from './jarviseYahooFetchOnceAcquirerR1.mjs';

const CANONICAL = canonicalChartParamsR1({
  period1: '2018-01-01T00:00:00.000Z',
  period2: '2026-09-05T00:00:00.000Z',
  interval: '1d',
});

function sentinelFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    const error = new Error('FETCH_BOUNDARY_REACHED');
    error.code = 'FETCH_BOUNDARY_REACHED';
    throw error;
  };
}

test('P3H-T31 real package frozen canonical params throw TypeError before fetch', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('globalThis.fetch must not be used');
  };
  try {
    const client = await createJarviseYahooFinance2ChartClientR1({ fetch: sentinelFetch(calls) });
    await assert.rejects(
      () => client.chart('AAPL', CANONICAL),
      (error) => {
        assert.equal(error instanceof TypeError, true);
        assert.match(String(error.message), /read only property|period1|period2/i);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'injected fetch must not be reached');
    assert.equal(Object.isFrozen(CANONICAL), true);
    assert.equal(CANONICAL.period1, '2018-01-01T00:00:00.000Z');
    assert.equal(CANONICAL.period2, '2026-09-05T00:00:00.000Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('P3H-T32 real package mutable shallow copy reaches injected fetch sentinel', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('globalThis.fetch must not be used');
  };
  try {
    const client = await createJarviseYahooFinance2ChartClientR1({ fetch: sentinelFetch(calls) });
    const mutable = mutableProviderChartParamsR1(CANONICAL);
    await assert.rejects(
      () => client.chart('AAPL', mutable),
      (error) => error.code === 'FETCH_BOUNDARY_REACHED' || /FETCH_BOUNDARY_REACHED/.test(error.message),
    );
    assert.equal(calls.length, 1, 'injected fetch must be reached exactly once');
    const url = calls[0];
    assert.match(url, /query2\.finance\.yahoo\.com/);
    assert.match(url, /\/v8\/finance\/chart\/AAPL/);
    assert.match(url, /period1=1514764800/);
    assert.match(url, /period2=1788566400/);
    assert.match(url, /interval=1d/);
    assert.match(url, /events=div%7Csplit|events=div\|split/);
    assert.equal(/[?&]return=/.test(url), false);
    assert.equal(Object.isFrozen(CANONICAL), true);
    assert.equal(CANONICAL.period1, '2018-01-01T00:00:00.000Z');
    assert.notEqual(mutable, CANONICAL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('P3H-T4 injected fetch never forwards and does not use original globalThis.fetch', async () => {
  const calls = [];
  let globalCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    globalCalls += 1;
    return originalFetch(...args);
  };
  try {
    const client = await createJarviseYahooFinance2ChartClientR1({ fetch: sentinelFetch(calls) });
    await assert.rejects(() => client.chart('AAPL', mutableProviderChartParamsR1(CANONICAL)));
    assert.equal(globalCalls, 0);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
