import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { computeFeatureSnapshots, lastCompletedWeekSeries } from '../src/features/featureEngine.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.5: on Monday..Friday BEFORE the week is finished, the
 * weekly feature must come from the LAST COMPLETED week; the current week is
 * forbidden — including its own Friday close.
 *
 * Fixture weeks (Friday closes): W02=105, W03=110, W04=115, W05=120.
 */
test('every day of a week uses the previous completed week close', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'weekly-boundary-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const snapshots = computeFeatureSnapshots({ symbol: 'WKLY', series, priceBasis: 'SPLIT_ADJUSTED' });
  const byDate = new Map(snapshots.map((s) => [s.sessionDate, s.features.weeklyLastCompletedClose]));

  // First week: no completed week yet.
  for (const d of ['2024-01-08', '2024-01-10', '2024-01-12']) {
    assert.equal(byDate.get(d).value, null, d);
    assert.equal(byDate.get(d).missingReason, 'NO_COMPLETED_WEEK', d);
  }
  // Second week (Mon..Fri): must see week 1's Friday close, even on its own Friday.
  for (const d of ['2024-01-15', '2024-01-16', '2024-01-17', '2024-01-18', '2024-01-19']) {
    assert.equal(byDate.get(d).value, 105, d);
  }
  // Third week: sees week 2's close.
  for (const d of ['2024-01-22', '2024-01-24', '2024-01-26']) {
    assert.equal(byDate.get(d).value, 110, d);
  }
  // Fourth week: sees week 3's close.
  for (const d of ['2024-01-29', '2024-02-02']) {
    assert.equal(byDate.get(d).value, 115, d);
  }
});

test('the weekly feature availableAt is the completing bar of the PREVIOUS week', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'weekly-boundary-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const snapshots = computeFeatureSnapshots({ symbol: 'WKLY', series, priceBasis: 'SPLIT_ADJUSTED' });
  const wednesdayW3 = snapshots.find((s) => s.sessionDate === '2024-01-24');
  const fv = wednesdayW3.features.weeklyLastCompletedClose;
  assert.ok(fv.availableAt.startsWith('2024-01-19'), `weekly availableAt ${fv.availableAt} should be Friday of the completed week`);
  assert.ok(fv.availableAt < wednesdayW3.availableAt);
});

test('a partial current week never leaks (mid-week truncation)', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'weekly-boundary-bars.json'));
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  // Truncate to Wednesday of week 4: the last completed week is still week 3.
  const truncated = series.filter((b) => b.sessionDate <= '2024-01-31');
  const weekly = lastCompletedWeekSeries(truncated);
  const last = weekly[weekly.length - 1];
  assert.equal(last.close, 115);
  assert.equal(last.weekKey, '2024-W04');
});
