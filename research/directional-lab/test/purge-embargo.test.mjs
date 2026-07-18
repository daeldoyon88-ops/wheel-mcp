import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPurgeEmbargo } from '../src/time/purgeEmbargo.mjs';

const train = [
  '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05',
  '2024-01-08', '2024-01-09', '2024-01-10',
  // (test window would sit here: 2024-01-11 .. 2024-01-17)
  '2024-01-18', '2024-01-19', '2024-01-22', '2024-01-23',
];

test('purge removes train dates within purgeDays before the test start', () => {
  const { kept, purged, embargoed } = applyPurgeEmbargo({
    trainDates: train, testStart: '2024-01-11', testEnd: '2024-01-17', purgeDays: 3, embargoDays: 0,
  });
  // 2024-01-08/09/10 are within 3 civil days of 2024-01-11.
  assert.deepEqual(purged, ['2024-01-08', '2024-01-09', '2024-01-10']);
  assert.ok(!kept.includes('2024-01-10'));
  assert.deepEqual(embargoed, []);
  assert.equal(kept.length + purged.length + embargoed.length, train.length);
});

test('embargo removes train dates within embargoDays after the test end', () => {
  const { kept, purged, embargoed } = applyPurgeEmbargo({
    trainDates: train, testStart: '2024-01-11', testEnd: '2024-01-17', purgeDays: 0, embargoDays: 2,
  });
  assert.deepEqual(embargoed, ['2024-01-18', '2024-01-19']);
  assert.ok(!kept.includes('2024-01-18'));
  assert.deepEqual(purged, []);
});

test('train dates inside the test window are always removed', () => {
  const { kept, purged } = applyPurgeEmbargo({
    trainDates: ['2024-01-10', '2024-01-12', '2024-01-20'], testStart: '2024-01-11', testEnd: '2024-01-17',
  });
  assert.deepEqual(purged, ['2024-01-12']);
  assert.deepEqual(kept, ['2024-01-10', '2024-01-20']);
});

test('kept/purged/embargoed are disjoint and exhaustive', () => {
  const { kept, purged, embargoed } = applyPurgeEmbargo({
    trainDates: train, testStart: '2024-01-11', testEnd: '2024-01-17', purgeDays: 5, embargoDays: 5,
  });
  const union = [...kept, ...purged, ...embargoed].sort();
  assert.deepEqual(union, [...train].sort());
  const overlap = kept.filter((d) => purged.includes(d) || embargoed.includes(d));
  assert.deepEqual(overlap, []);
});

test('invalid ranges are rejected', () => {
  assert.throws(() => applyPurgeEmbargo({ trainDates: [], testStart: '2024-01-17', testEnd: '2024-01-11' }));
  assert.throws(() => applyPurgeEmbargo({ trainDates: [], testStart: '2024-01-11', testEnd: '2024-01-17', purgeDays: -1 }));
});
