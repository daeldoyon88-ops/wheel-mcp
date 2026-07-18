import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyBarProblems, isStrictUtcIsoInstant } from '../src/contracts/dailyBarV1.mjs';
import { validateDailyBars } from '../src/data/validateDailyBars.mjs';
import { createOrder, orderProblems } from '../src/contracts/orderV1.mjs';
import { createFill, fillProblems } from '../src/contracts/fillV1.mjs';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { assertExitQuantityAllowed } from '../src/backtest/positionState.mjs';
import { isValidCivilDate } from '../src/time/civilDate.mjs';

function validBar(overrides = {}) {
  const [bar] = normalizeDailyBars(
    [{ date: '2024-03-15T14:30:00.000Z', open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000 }],
    { symbol: 'T', source: 'test', ohlcBasis: 'RAW' }
  );
  return {
    ...bar,
    ...overrides,
    raw: { ...bar.raw, ...(overrides.raw ?? {}) },
    adjusted: { ...bar.adjusted, ...(overrides.adjusted ?? {}) },
    corporateActions: { ...bar.corporateActions, ...(overrides.corporateActions ?? {}) },
    qualityFlags: overrides.qualityFlags ?? bar.qualityFlags,
  };
}

test('V1 — validateDailyBars(null) returns a contractual error, never TypeError', () => {
  const v = validateDailyBars(null);
  assert.ok(v.problems[0].includes('not an array'));
  assert.equal(v.stats.bars, 0);
});

test('V2 — validateDailyBars(non-array) refused', () => {
  for (const bad of [undefined, {}, 'abc', 12]) {
    const v = validateDailyBars(bad);
    assert.ok(v.problems[0].includes('not an array'), String(bad));
  }
});

test('V3 — civil date 2023-02-29 refused', () => {
  assert.equal(isValidCivilDate('2023-02-29'), false);
  const bar = validBar({ sessionDate: '2023-02-29' });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('sessionDate')));
});

test('V4 — civil date 2024-02-29 accepted', () => {
  assert.equal(isValidCivilDate('2024-02-29'), true);
});

test('V5 — impossible timestamp refused', () => {
  assert.equal(isStrictUtcIsoInstant('2024-02-30T20:00:00.000Z'), false);
  const bar = validBar({ eventTime: '2024-02-30T20:00:00.000Z', availableAt: '2024-02-30T20:00:00.000Z' });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('eventTime')));
});

test('V6 — availableAt before eventTime refused', () => {
  const bar = validBar({
    eventTime: '2024-03-15T20:00:00.000Z',
    availableAt: '2024-03-15T19:00:00.000Z',
  });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('availableAt')));
});

test('V7 — zero price refused', () => {
  const bar = validBar({ raw: { close: 0 } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('strictly > 0')));
});

test('V8 — negative price refused', () => {
  const bar = validBar({ raw: { open: -1 } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('strictly > 0')));
});

test('V9 — high < low refused', () => {
  const bar = validBar({ raw: { high: 8, low: 9 } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('impossible OHLC')));
});

test('V10 — high below open/close refused', () => {
  const bar = validBar({ raw: { open: 10, high: 9.5, low: 9, close: 10.2 } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('high <')));
});

test('V11 — negative volume refused', () => {
  const bar = validBar({ raw: { volume: -1 } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('negative volume')));
});

test('V12 — splitFactor zero refused', () => {
  const bar = validBar({ corporateActions: { splitFactor: 0, cashDividend: null } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('splitFactor')));
});

test('V13 — splitFactor negative refused', () => {
  const bar = validBar({ corporateActions: { splitFactor: -2, cashDividend: null } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('splitFactor')));
});

test('V14 — cashDividend negative refused', () => {
  const bar = validBar({ corporateActions: { splitFactor: null, cashDividend: -0.1 } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('cashDividend')));
});

test('V15 — adjustmentFactor zero refused', () => {
  const bar = validBar({ adjusted: { adjustmentFactor: 0 } });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('adjustmentFactor')));
});

test('V16 — duplicate qualityFlags refused', () => {
  const bar = validBar({ qualityFlags: ['A', 'A'] });
  assert.ok(dailyBarProblems(bar).some((p) => p.includes('duplicate')));
});

test('V17 — order quantity zero refused', () => {
  assert.throws(() => createOrder({
    symbol: 'T', type: 'MARKET_OPEN_BUY', decisionDate: '2024-01-02', earliestFillDate: '2024-01-03', quantity: 0,
  }));
});

test('V18 — fractional order quantity refused', () => {
  assert.throws(() => createOrder({
    symbol: 'T', type: 'MARKET_OPEN_BUY', decisionDate: '2024-01-02', earliestFillDate: '2024-01-03', quantity: 1.5,
  }));
});

test('V19 — reduce fraction 0 refused', () => {
  assert.throws(() => createOrder({
    symbol: 'T', type: 'MARKET_OPEN_SELL', decisionDate: '2024-01-02', earliestFillDate: '2024-01-03', fraction: 0,
  }));
});

test('V20 — reduce fraction > 1 refused', () => {
  assert.throws(() => createOrder({
    symbol: 'T', type: 'MARKET_OPEN_SELL', decisionDate: '2024-01-02', earliestFillDate: '2024-01-03', fraction: 1.1,
  }));
});

test('V21 — stop <= 0 refused', () => {
  assert.throws(() => createOrder({
    symbol: 'T', type: 'STOP_SELL', decisionDate: '2024-01-02', earliestFillDate: '2024-01-03', stopLevel: 0,
  }));
});

test('V22 — fill price <= 0 refused', () => {
  assert.throws(() => createFill({
    symbol: 'T', kind: 'OPEN_BUY', decisionDate: '2024-01-02', fillDate: '2024-01-03',
    quantity: 1, referencePrice: 10, fillPrice: 0,
  }));
});

test('V23 — negative commission refused', () => {
  assert.throws(() => createFill({
    symbol: 'T', kind: 'OPEN_BUY', decisionDate: '2024-01-02', fillDate: '2024-01-03',
    quantity: 1, referencePrice: 10, fillPrice: 10.1, commission: -1,
  }));
});

test('V24 — negative slippage refused', () => {
  assert.throws(() => createFill({
    symbol: 'T', kind: 'OPEN_BUY', decisionDate: '2024-01-02', fillDate: '2024-01-03',
    quantity: 1, referencePrice: 10, fillPrice: 10.1, slippageCost: -0.01,
  }));
});

test('V25 — engine refuses sell quantity above the open position', () => {
  assert.throws(
    () => assertExitQuantityAllowed(11, 10, 'T'),
    /SELL_EXCEEDS_POSITION/
  );
  assert.doesNotThrow(() => assertExitQuantityAllowed(10, 10, 'T'));
  assert.doesNotThrow(() => assertExitQuantityAllowed(3, 10, 'T'));
});

test('V26 — NaN and Infinity refused on order/fill', () => {
  assert.throws(() => createOrder({
    symbol: 'T', type: 'STOP_SELL', decisionDate: '2024-01-02', earliestFillDate: '2024-01-03', stopLevel: NaN,
  }));
  assert.throws(() => createFill({
    symbol: 'T', kind: 'OPEN_BUY', decisionDate: '2024-01-02', fillDate: '2024-01-03',
    quantity: 1, referencePrice: Infinity, fillPrice: 10,
  }));
});

test('V27 — valid order and fill contracts unchanged', () => {
  const order = createOrder({
    symbol: 'T', type: 'MARKET_OPEN_BUY', decisionDate: '2024-01-02', earliestFillDate: '2024-01-03',
  });
  assert.deepEqual(orderProblems(order), []);
  const fill = createFill({
    symbol: 'T', kind: 'OPEN_BUY', decisionDate: '2024-01-02', fillDate: '2024-01-03',
    quantity: 10, referencePrice: 100, fillPrice: 100.1, commission: 1, slippageCost: 1,
  });
  assert.deepEqual(fillProblems(fill), []);
});
