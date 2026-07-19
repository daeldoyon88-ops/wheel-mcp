import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { computeReturnsDrawdownFeatures } from '../src/features/returnsDrawdownFeaturesL4V1.mjs';
import { makeInternalBars } from './marketFeaturesL4SyntheticPipeline.mjs';

function closes(length, start = 100n, step = 1n) {
  return Array.from({ length }, (_, index) => start + BigInt(index) * step);
}

test('L4A-A1 return1 uses observed sessions and exact fixed-point division', () => {
  const result = computeReturnsDrawdownFeatures(makeInternalBars([100n, 110n]));
  assert.deepEqual(result[1].return1, {
    value: { atoms: '100000000000', scale: 12 }, availability: 'AVAILABLE',
  });
});

for (const period of [3, 5, 10, 20, 60]) {
  test(`L4A-A1 return${period} uses exactly ${period} observed sessions`, () => {
    const values = closes(period + 1, 100n, 1n);
    const result = computeReturnsDrawdownFeatures(makeInternalBars(values));
    assert.equal(result[period][`return${period}`].value.atoms, (BigInt(period) * 10000000000n).toString());
    assert.equal(result[period][`return${period}`].availability, 'AVAILABLE');
  });
}

test('L4A-A1 insufficient history remains null with its reason', () => {
  const first = computeReturnsDrawdownFeatures(makeInternalBars([100n]))[0];
  assert.deepEqual(first.return1, { value: null, availability: 'INSUFFICIENT_HISTORY' });
  assert.deepEqual(first.return60, { value: null, availability: 'INSUFFICIENT_HISTORY' });
});

test('L4A-A1 division by a zero reference is unavailable, never fabricated as zero', () => {
  const result = computeReturnsDrawdownFeatures(makeInternalBars([0n, 10n], { spread: 0n }));
  assert.deepEqual(result[1].return1, { value: null, availability: 'DIVISION_BY_ZERO' });
});

test('L4A-A1 running drawdown never uses a future peak', () => {
  const result = computeReturnsDrawdownFeatures(makeInternalBars([100n, 80n, 200n]));
  assert.equal(result[1].drawdownFromRunningPeak.value.atoms, '-200000000000');
  assert.equal(result[1].sessionsSinceRunningPeak.value, 1);
  assert.equal(result[2].drawdownFromRunningPeak.value.atoms, '0');
});

test('L4A-A1 equal peaks choose the most recent session deterministically', () => {
  const result = computeReturnsDrawdownFeatures(makeInternalBars([100n, 90n, 100n, 80n]));
  assert.equal(result[2].sessionsSinceRunningPeak.value, 0);
  assert.equal(result[3].sessionsSinceRunningPeak.value, 1);
});

for (const period of [20, 60, 252]) {
  test(`L4A-A1 trailing ${period}-session peak requires its complete window`, () => {
    const result = computeReturnsDrawdownFeatures(makeInternalBars(closes(period, 100n, 1n)));
    const name = `drawdownFrom${period}SessionPeak`;
    assert.equal(result[period - 2][name].availability, 'INSUFFICIENT_HISTORY');
    assert.equal(result[period - 1][name].availability, 'AVAILABLE');
    assert.equal(result[period - 1][name].value.atoms, '0');
  });
}

test('L4A-A1 prefix bytes are invariant after ten synthetic future years', () => {
  const prefixBars = makeInternalBars(closes(80, 100n, 1n));
  const fullBars = makeInternalBars([...closes(80, 100n, 1n), ...closes(2520, 1000n, -1n)]);
  const prefix = computeReturnsDrawdownFeatures(prefixBars);
  const fullPrefix = computeReturnsDrawdownFeatures(fullBars).slice(0, 80);
  assert.ok(canonicalJsonBytes(prefix).equals(canonicalJsonBytes(fullPrefix)));
});
