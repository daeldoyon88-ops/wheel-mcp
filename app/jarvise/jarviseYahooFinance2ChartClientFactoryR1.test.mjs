/**
 * P3E Yahoo Finance 2 chart-client factory coverage.
 *
 * Every loader and client in this suite is a local fake. The production
 * dynamic import of yahoo-finance2 is never executed here. No nock, no HTTP,
 * no fetch, no socket.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyAcquisitionFailureR1 } from './jarviseYahooFetchOnceAcquirerR1.mjs';
import {
  JARVISE_YAHOO_FINANCE2_CHART_CLIENT_FACTORY_VERSION,
  asYahooFinance2HttpStatusR1,
  createJarviseYahooFinance2ChartClientR1,
  isYahooFinance2HttpErrorR1,
  projectYahooFinance2HttpErrorR1,
} from './jarviseYahooFinance2ChartClientFactoryR1.mjs';

const FACTORY_MODULE_PATH = fileURLToPath(new URL('./jarviseYahooFinance2ChartClientFactoryR1.mjs', import.meta.url));
const RUNNER_MODULE_PATH = fileURLToPath(new URL('../../scripts/runJarviseHistoricalFetchOnceR1.mjs', import.meta.url));
const ACQUIRER_MODULE_PATH = fileURLToPath(new URL('./jarviseYahooFetchOnceAcquirerR1.mjs', import.meta.url));

function httpError(code, message = `stub HTTP ${code}`) {
  const error = new Error(message);
  error.name = 'HTTPError';
  error.code = code;
  return error;
}

function fakeYahooFinanceClass({ chart } = {}) {
  return class FakeYahooFinance {
    constructor(options) {
      this.options = options;
      this.chartCalls = [];
    }

    async chart(symbol, params) {
      this.chartCalls.push({ symbol, params });
      if (typeof chart === 'function') return chart(symbol, params);
      return { meta: { symbol }, quotes: [{ close: 1 }], events: { dividends: [], splits: [] } };
    }
  };
}

test('P3E-T1 importing the factory and runner contacts neither Yahoo nor the network', async () => {
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetchCalls.push(args);
    throw new Error('P3E tests must not fetch');
  };
  try {
    const factoryNs = await import('./jarviseYahooFinance2ChartClientFactoryR1.mjs');
    const runnerNs = await import('../../scripts/runJarviseHistoricalFetchOnceR1.mjs');
    assert.equal(typeof factoryNs.createJarviseYahooFinance2ChartClientR1, 'function');
    assert.equal(typeof runnerNs.runJarviseHistoricalFetchOnceR1, 'function');
    assert.equal(typeof runnerNs.parseJarviseHistoricalFetchOnceArgsR1, 'function');
    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('P3E-T16 factory module evaluation does not load yahoo-finance2', () => {
  const source = readFileSync(FACTORY_MODULE_PATH, 'utf8');
  assert.equal(/^\s*import\s+.*yahoo-finance2/m.test(source), false, 'no static yahoo-finance2 import');
  assert.equal(/require\(\s*['"]yahoo-finance2['"]\s*\)/.test(source), false);
  assert.match(source, /import\('yahoo-finance2'\)/);
  assert.match(source, /async function defaultLoadYahooFinance2/);
  assert.equal(/from\s+['"].*yahooMarketDataProvider/.test(source), false);
  assert.equal(/from\s+['"].*createMarketDataProvider/.test(source), false);
  assert.equal(/require\(\s*['"].*yahooMarketDataProvider/.test(source), false);
});

test('P3E-T15/T17 factory construction uses an injected fake loader only', async () => {
  let loaderCalls = 0;
  let constructed = 0;
  let chartCalls = 0;
  const FakeYahooFinance = fakeYahooFinanceClass({
    chart: async (symbol, params) => {
      chartCalls += 1;
      return { meta: { symbol }, quotes: [], events: { dividends: [], splits: [] }, params };
    },
  });
  const original = FakeYahooFinance;
  class CountingYahooFinance extends original {
    constructor(options) {
      constructed += 1;
      super(options);
    }
  }
  const client = await createJarviseYahooFinance2ChartClientR1({
    loadYahooFinance2: async () => {
      loaderCalls += 1;
      return { default: CountingYahooFinance };
    },
  });
  assert.equal(loaderCalls, 1);
  assert.equal(constructed, 1);
  assert.equal(chartCalls, 0, 'factory construction must not invoke chart');
  assert.equal(typeof client.chart, 'function');
  assert.deepEqual(Object.keys(client), ['chart']);
});

test('P3E production construction uses suppressNotices yahooSurvey', async () => {
  let seenOptions = null;
  const FakeYahooFinance = class {
    constructor(options) {
      seenOptions = options;
    }
    async chart() {
      return { quotes: [] };
    }
  };
  await createJarviseYahooFinance2ChartClientR1({
    loadYahooFinance2: async () => ({ default: FakeYahooFinance }),
  });
  assert.deepEqual(seenOptions, { suppressNotices: ['yahooSurvey'] });
});

test('P3E-T9 timeout-style errors remain TIMEOUT and are not projected as HTTP', () => {
  const timeout = new Error('request timed out');
  timeout.code = 'ETIMEDOUT';
  const projected = projectYahooFinance2HttpErrorR1(timeout);
  assert.equal(projected, timeout);
  assert.equal(projected.status, undefined);
  assert.equal(classifyAcquisitionFailureR1(projected).condition, 'TIMEOUT');
  assert.equal(classifyAcquisitionFailureR1(projected).retryEligible, true);

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(classifyAcquisitionFailureR1(projectYahooFinance2HttpErrorR1(abort)).condition, 'TIMEOUT');

  const und = new Error('headers timeout');
  und.code = 'UND_ERR_HEADERS_TIMEOUT';
  assert.equal(classifyAcquisitionFailureR1(projectYahooFinance2HttpErrorR1(und)).condition, 'TIMEOUT');
});

test('P3E-T10 HTTPError numeric 429 is projected to status and classified PROVIDER_RATE_LIMITED', () => {
  const error = httpError(429);
  const projected = projectYahooFinance2HttpErrorR1(error);
  assert.equal(projected.status, 429);
  assert.equal(projected.code, 429);
  assert.equal(projected.name, 'HTTPError');
  const classified = classifyAcquisitionFailureR1(projected);
  assert.equal(classified.condition, 'PROVIDER_RATE_LIMITED');
  assert.equal(classified.retryEligible, true);
});

test('P3E-T11 HTTPError numeric 5xx is projected to status and classified PROVIDER_SERVER_ERROR', () => {
  for (const code of [500, 502, 503]) {
    const error = httpError(code);
    const projected = projectYahooFinance2HttpErrorR1(error);
    assert.equal(projected.status, code);
    const classified = classifyAcquisitionFailureR1(projected);
    assert.equal(classified.condition, 'PROVIDER_SERVER_ERROR');
    assert.equal(classified.retryEligible, true);
  }
});

test('P3E numeric non-HTTPError codes are not made retryable', () => {
  const error = new Error('opaque numeric');
  error.code = 429;
  const projected = projectYahooFinance2HttpErrorR1(error);
  assert.equal(projected.status, undefined);
  const classified = classifyAcquisitionFailureR1(projected);
  assert.equal(classified.condition, 'MALFORMED_PROVIDER_RESULT');
  assert.equal(classified.retryEligible, false);
});

test('P3E HTTPError without a valid HTTP status is not projected', () => {
  const error = httpError('ENOTFOUND');
  const projected = projectYahooFinance2HttpErrorR1(error);
  assert.equal(projected.status, undefined);
  assert.equal(asYahooFinance2HttpStatusR1('ENOTFOUND'), null);
  assert.equal(isYahooFinance2HttpErrorR1(error), true);
  assert.equal(classifyAcquisitionFailureR1(projected).retryEligible, false);
});

test('P3E-T12/T13 factory chart wrapper does not rewrite malformed or empty results', async () => {
  const malformed = { not: 'a chart' };
  const empty = { meta: { symbol: 'X' }, quotes: [] };
  const FakeYahooFinance = fakeYahooFinanceClass({
    chart: async (_symbol, params) => (params?.empty ? empty : malformed),
  });
  const client = await createJarviseYahooFinance2ChartClientR1({
    loadYahooFinance2: async () => ({ default: FakeYahooFinance }),
  });
  assert.equal(await client.chart('X', {}), malformed);
  assert.equal(await client.chart('X', { empty: true }), empty);
});

test('P3E factory chart wrapper projects HTTPError thrown by the fake client', async () => {
  const FakeYahooFinance = fakeYahooFinanceClass({
    chart: async () => {
      throw httpError(429);
    },
  });
  const client = await createJarviseYahooFinance2ChartClientR1({
    loadYahooFinance2: async () => ({ default: FakeYahooFinance }),
  });
  await assert.rejects(
    () => client.chart('SOXL', { interval: '1d' }),
    (error) => error.name === 'HTTPError' && error.code === 429 && error.status === 429,
  );
});

test('P3E factory does not add, remove or override chart query identity fields', async () => {
  let seen = null;
  const FakeYahooFinance = fakeYahooFinanceClass({
    chart: async (symbol, params) => {
      seen = { symbol, params };
      return { meta: { symbol }, quotes: [{ close: 1 }] };
    },
  });
  const client = await createJarviseYahooFinance2ChartClientR1({
    loadYahooFinance2: async () => ({ default: FakeYahooFinance }),
  });
  const params = Object.freeze({
    period1: '2018-01-01T00:00:00.000Z',
    period2: '2026-09-05T00:00:00.000Z',
    interval: '1d',
    events: 'div|split',
    return: 'array',
  });
  await client.chart('AAPL', params);
  assert.equal(seen.symbol, 'AAPL');
  assert.equal(seen.params, params);
  assert.deepEqual(seen.params, {
    period1: '2018-01-01T00:00:00.000Z',
    period2: '2026-09-05T00:00:00.000Z',
    interval: '1d',
    events: 'div|split',
    return: 'array',
  });
});

test('P3E runner CLI path is the only production factory injection', () => {
  const runnerSource = readFileSync(RUNNER_MODULE_PATH, 'utf8');
  const acquirerSource = readFileSync(ACQUIRER_MODULE_PATH, 'utf8');
  assert.match(runnerSource, /createJarviseYahooFinance2ChartClientR1/);
  assert.match(runnerSource, /createProviderClient:\s*createJarviseYahooFinance2ChartClientR1/);
  assert.match(runnerSource, /const invokedDirectly/);
  assert.equal(
    runnerSource.includes('createProviderClient: options.createProviderClient'),
    true,
    'programmatic runJarviseHistoricalFetchOnceR1 must keep the injected factory optional',
  );
  assert.doesNotMatch(
    runnerSource.replace(/if \(invokedDirectly\) \{[\s\S]*$/, ''),
    /createProviderClient:\s*createJarviseYahooFinance2ChartClientR1/,
    'programmatic API must not auto-default to the real factory',
  );
  assert.equal(/^\s*import\s+.*yahoo-finance2/m.test(acquirerSource), false);
  assert.equal(/createJarviseYahooFinance2ChartClientR1/.test(acquirerSource), false);
  assert.equal(JARVISE_YAHOO_FINANCE2_CHART_CLIENT_FACTORY_VERSION, 'jarviseYahooFinance2ChartClientFactoryR1/1');
});
