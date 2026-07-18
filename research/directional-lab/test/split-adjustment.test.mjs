import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { selectPriceBasis } from '../src/data/selectPriceBasis.mjs';
import { validateDailyBars } from '../src/data/validateDailyBars.mjs';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';
import { runBacktest } from '../src/backtest/backtestEngine.mjs';
import { buyAndHoldBaseline } from '../src/strategy/buyAndHoldBaseline.mjs';
import { drawdownFromCausalPeakSeries } from '../src/features/structure.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Anti-look-ahead 20.8 + 20.9: split continuity on the adjusted basis, fake
 * drawdown/stop on the raw basis, and refusal of incoherent raw/adjusted mixes.
 */

function loadFixture() {
  return loadJsonDaily(join(FIXTURES, 'split-bars.json'));
}

test('adjusted basis is economically continuous through the split (no fake drawdown)', () => {
  const { bars } = loadFixture();
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const closes = series.map((b) => b.close);
  const dd = drawdownFromCausalPeakSeries(closes);
  const worst = Math.min(...dd.filter((d) => d !== null));
  assert.ok(worst > -2, `adjusted series shows a fake drawdown of ${worst}%`);
});

test('raw basis across the split shows the mechanical -50% jump (why raw must not be used blindly)', () => {
  const { bars } = loadFixture();
  const { series } = selectPriceBasis(bars, 'RAW');
  const closes = series.map((b) => b.close);
  const dd = drawdownFromCausalPeakSeries(closes);
  const worst = Math.min(...dd.filter((d) => d !== null));
  assert.ok(worst < -45, `raw series should show ~-50% at the split, got ${worst}%`);
});

test('the documented split suppresses the SPLIT_SUSPECT warning; undocumented raw jump raises it', () => {
  const { bars } = loadFixture();
  // Documented (splitFactor present on the split bar): raw continuity check accepts it.
  const rawBars = bars.map((b) => ({ ...b, adjusted: { ...b.adjusted, open: null, high: null, low: null, close: null, volume: null, adjustmentType: null } }));
  // The 2:1 jump is ~-49.8%, so probe with a 45% threshold on both sides.
  const documented = validateDailyBars(rawBars, { splitSuspectThreshold: 0.45 });
  assert.ok(!documented.warnings.some((w) => w.includes('probable undocumented split')), documented.warnings.join('; '));

  // Undocumented: strip the split factor -> the -50% raw jump must be flagged.
  const undocumented = rawBars.map((b) => ({ ...b, corporateActions: { splitFactor: null, cashDividend: null } }));
  const v = validateDailyBars(undocumented, { splitSuspectThreshold: 0.45 });
  assert.ok(v.warnings.some((w) => w.includes('probable undocumented split')));
});

test('quantities and equity stay continuous on the adjusted basis (no fake stop, B0 return matches the smooth path)', () => {
  const { bars } = loadFixture();
  const { series } = selectPriceBasis(bars, 'SPLIT_ADJUSTED');
  const result = runBacktest({
    symbol: 'SPLT', series, priceBasis: 'SPLIT_ADJUSTED', strategy: buyAndHoldBaseline,
    commission: { fixedPerOrder: 0, perShare: 0, minimum: 0 }, slippage: { bps: 0, minPerShare: 0, gapMultiplier: 1 },
  });
  // Economic path is +~19% over the window; equity must never crater at the split bar.
  const equities = result.equityCurve.map((p) => p.equity);
  for (let i = 1; i < equities.length; i++) {
    const change = equities[i] / equities[i - 1] - 1;
    assert.ok(Math.abs(change) < 0.05, `equity jump of ${(change * 100).toFixed(1)}% at ${result.equityCurve[i].sessionDate} (fake split effect)`);
  }
  assert.ok(result.metrics.totalReturnNetPct > 15);
});

test('DERIVED_ADJUSTED must be explicit, flagged, and refused in strict mode (no silent raw/adjusted mixing)', () => {
  const rows = [
    { date: '2024-01-02T14:30:00.000Z', open: 100, high: 101, low: 99, close: 100, volume: 10, adjclose: 50 },
    { date: '2024-01-03T14:30:00.000Z', open: 100, high: 102, low: 99, close: 101, volume: 10, adjclose: 50.5 },
  ];
  const bars = normalizeDailyBars(rows, { symbol: 'MIX', source: 'test', ohlcBasis: 'RAW' });
  // TOTAL_RETURN_ADJUSTED OHLC does not exist natively -> refused.
  assert.throws(() => selectPriceBasis(bars, 'TOTAL_RETURN_ADJUSTED'), /incoherent|incomplete/);
  // Strict mode refuses the derived series entirely.
  assert.throws(() => selectPriceBasis(bars, 'DERIVED_ADJUSTED', { strict: true }), /Strict mode/);
  // Explicit derived mode works and marks every bar as transformed, keeping the ratio.
  const rawBars = normalizeDailyBars(rows, { symbol: 'MIX', source: 'test', ohlcBasis: 'RAW' });
  rawBars.forEach((b) => { b.lineage.totalReturnClose = b.adjusted.close; });
  const { series, warnings } = selectPriceBasis(rawBars, 'DERIVED_ADJUSTED');
  assert.ok(series[0].qualityFlags.includes('DERIVED_FROM_CLOSE_RATIO'));
  assert.ok(series[0].qualityFlags.some((f) => f.startsWith('ratio=')));
  assert.ok(warnings.some((w) => w.includes('DERIVED_ADJUSTED')));
  assert.equal(series[0].close, 50);
  assert.equal(series[0].open, 50); // open scaled by the same declared ratio
});

test('requesting RAW when the source provides only adjusted OHLC is refused with a clear error', () => {
  const { bars } = loadJsonDaily(join(FIXTURES, 'causal-bars.json'));
  assert.throws(() => selectPriceBasis(bars, 'RAW'), /refusing to substitute adjusted prices silently/);
});
