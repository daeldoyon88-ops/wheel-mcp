import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrder } from '../src/contracts/orderV1.mjs';
import { createFill } from '../src/contracts/fillV1.mjs';
import { createSignal } from '../src/contracts/signalV1.mjs';
import { sessionCloseUtc, sessionOpenUtc, isUsDst } from '../src/time/marketSession.mjs';
import { isoWeekKey, dayOfWeek, addDays, toEpochDay, fromEpochDay } from '../src/time/civilDate.mjs';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { computeFeatureSnapshots } from '../src/features/featureEngine.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('an order decided at close t cannot fill at t (same-session forbidden by construction)', () => {
  assert.throws(
    () => createOrder({ symbol: 'T', type: 'MARKET_OPEN_BUY', decisionDate: '2024-01-02', earliestFillDate: '2024-01-02' }),
    /Causality violation/
  );
  assert.throws(
    () => createOrder({ symbol: 'T', type: 'MARKET_OPEN_BUY', decisionDate: '2024-01-02', earliestFillDate: '2023-12-29' })
  );
});

test('a fill dated on or before its decision date is rejected', () => {
  assert.throws(
    () => createFill({ symbol: 'T', kind: 'OPEN_BUY', decisionDate: '2024-01-03', fillDate: '2024-01-03', quantity: 1, referencePrice: 10, fillPrice: 10.01 }),
    /Causality violation/
  );
});

test('a signal cannot be available before its decision time', () => {
  assert.throws(() => createSignal({
    symbol: 'T', intent: 'ENTER_LONG', decisionDate: '2024-01-02',
    decisionTime: '2024-01-02T21:00:00.000Z', availableAt: '2024-01-02T15:00:00.000Z',
    strategyId: 's', strategyVersion: '1',
  }));
});

test('session close times use the deterministic US DST rule, never the local timezone', () => {
  assert.equal(isUsDst('2026-01-15'), false);
  assert.equal(isUsDst('2026-07-15'), true);
  assert.equal(sessionCloseUtc('2026-01-15'), '2026-01-15T21:00:00.000Z'); // EST
  assert.equal(sessionCloseUtc('2026-07-15'), '2026-07-15T20:00:00.000Z'); // EDT
  assert.equal(sessionOpenUtc('2026-01-15'), '2026-01-15T14:30:00.000Z');
  // DST boundary 2026: starts Sunday 2026-03-08, ends Sunday 2026-11-01.
  assert.equal(isUsDst('2026-03-07'), false);
  assert.equal(isUsDst('2026-03-08'), true);
  assert.equal(isUsDst('2026-10-31'), true);
  assert.equal(isUsDst('2026-11-01'), false);
});

test('civil date arithmetic is pure UTC (epoch-day roundtrip, weekday, ISO weeks)', () => {
  assert.equal(fromEpochDay(toEpochDay('2026-07-17')), '2026-07-17');
  assert.equal(dayOfWeek('2026-07-17'), 5); // Friday
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(isoWeekKey('2024-01-08'), '2024-W02');
  assert.equal(isoWeekKey('2024-12-31'), '2025-W01'); // ISO year rollover
});

test('V1 exposes no pivot feature (pivots need future confirmation candles)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const [snapshot] = computeFeatureSnapshots({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED' });
  const names = Object.keys(snapshot.features);
  assert.ok(!names.some((n) => n.toLowerCase().includes('pivot')), `pivot-like feature found in ${names}`);
});

test('every feature availableAt is at or after the close it is computed from', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const snapshots = computeFeatureSnapshots({ symbol: 'TEST', series, priceBasis: 'SPLIT_ADJUSTED' });
  for (const s of snapshots) {
    for (const [name, fv] of Object.entries(s.features)) {
      assert.ok(fv.availableAt <= s.availableAt, `${name}: availableAt ${fv.availableAt} is after the snapshot instant ${s.availableAt}`);
    }
  }
});
