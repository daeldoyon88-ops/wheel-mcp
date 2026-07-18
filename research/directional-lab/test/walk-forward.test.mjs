import test from 'node:test';
import assert from 'node:assert/strict';
import { chronologicalSplit } from '../src/time/chronologicalSplit.mjs';
import { expandingWindows, rollingWindows, validateWindows, windowTrainDatesWithPurge } from '../src/backtest/walkForward.mjs';

function makeDates(n) {
  const dates = [];
  let day = Date.UTC(2024, 0, 1);
  while (dates.length < n) {
    const d = new Date(day);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) dates.push(d.toISOString().slice(0, 10));
    day += 86400000;
  }
  return dates;
}

test('chronological split is contiguous, disjoint and ordered (test never influences train)', () => {
  const dates = makeDates(100);
  const { train, validation, test: testSet } = chronologicalSplit(dates, { trainFraction: 0.6, validationFraction: 0.2 });
  assert.equal(train.length + validation.length + testSet.length, 100);
  assert.ok(train[train.length - 1] < validation[0], 'train must end before validation starts');
  assert.ok(validation[validation.length - 1] < testSet[0], 'validation must end before test starts');
  const all = new Set([...train, ...validation, ...testSet]);
  assert.equal(all.size, 100, 'no date may appear in two segments');
});

test('chronological split rejects unsorted dates and bad fractions', () => {
  assert.throws(() => chronologicalSplit(['2024-01-03', '2024-01-02']));
  assert.throws(() => chronologicalSplit(makeDates(10), { trainFraction: 0.8, validationFraction: 0.3 }));
});

test('expanding windows: train grows, always ends before test, tests advance without overlap', () => {
  const dates = makeDates(120);
  const windows = expandingWindows(dates, { initialTrainSize: 60, testSize: 20, step: 20 });
  assert.deepEqual(validateWindows(windows), []);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].train.indices[0], 0);
  assert.equal(windows[2].train.indices[0], 0);
  assert.ok(windows[1].train.indices[1] > windows[0].train.indices[1], 'expanding train must grow');
  // Test windows must not overlap each other.
  for (let i = 1; i < windows.length; i++) {
    assert.ok(windows[i].test.indices[0] > windows[i - 1].test.indices[1]);
  }
});

test('rolling windows: fixed train length sliding forward', () => {
  const dates = makeDates(120);
  const windows = rollingWindows(dates, { trainSize: 60, testSize: 20, step: 20 });
  assert.deepEqual(validateWindows(windows), []);
  for (const w of windows) {
    assert.equal(w.train.indices[1] - w.train.indices[0] + 1, 60);
    assert.ok(w.train.end < w.test.start);
  }
});

test('validation/test windows never see the future: every test index is after every train index', () => {
  const dates = makeDates(120);
  for (const w of expandingWindows(dates, { initialTrainSize: 60, testSize: 20 })) {
    assert.ok(Math.max(...w.train.indices) < Math.min(...w.test.indices));
  }
});

test('purge inside walk-forward removes the tail of train next to the test window', () => {
  const dates = makeDates(120);
  const [w] = expandingWindows(dates, { initialTrainSize: 60, testSize: 20 });
  const { kept, purged } = windowTrainDatesWithPurge(w, dates, { purgeDays: 7 });
  assert.ok(purged.length >= 5, `expected ~5 weekdays purged in 7 civil days, got ${purged.length}`);
  assert.ok(kept.every((d) => d < w.test.start));
  assert.equal(kept.length + purged.length, 60);
});
