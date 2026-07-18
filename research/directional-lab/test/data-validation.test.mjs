import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { loadJsonDaily } from '../src/data/jsonDailyAdapter.mjs';
import { validateDailyBars } from '../src/data/validateDailyBars.mjs';
import { buildDatasetManifest } from '../src/data/buildDatasetManifest.mjs';
import { validateDatasetManifest } from '../src/data/validateDatasetManifest.mjs';
import { discoverLocalDailyFiles } from '../src/data/localCacheDiscovery.mjs';
import { normalizeDailyBars } from '../src/data/normalizeDailyBars.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function bars(rows) {
  return normalizeDailyBars(rows, { symbol: 'T', source: 'test', ohlcBasis: 'SPLIT_ADJUSTED' });
}
const mk = (date, close) => ({ date: `${date}T14:30:00.000Z`, open: close, high: close + 1, low: close - 1, close, volume: 100 });

test('missing-bars fixture: gap warning, null volumes counted, still admissible', () => {
  const { bars: fixtureBars } = loadJsonDaily(join(FIXTURES, 'missing-bars.json'));
  const v = validateDailyBars(fixtureBars);
  assert.deepEqual(v.problems, []);
  assert.ok(v.warnings.some((w) => w.includes('gap of 10 weekdays')));
  assert.equal(v.stats.barsWithNullVolume, 5);
});

test('duplicate dates are a blocking problem', () => {
  const v = validateDailyBars(bars([mk('2024-01-02', 10), mk('2024-01-02', 11)]));
  assert.ok(v.problems.some((p) => p.includes('not after')));
});

test('unsorted dates are a blocking problem', () => {
  const v = validateDailyBars(bars([mk('2024-01-03', 10), mk('2024-01-02', 11)]));
  assert.ok(v.problems.some((p) => p.includes('unsorted') || p.includes('not after')));
});

test('undocumented 50%+ jump is flagged as probable split', () => {
  const v = validateDailyBars(bars([mk('2024-01-02', 100), mk('2024-01-03', 100.5), mk('2024-01-04', 49)]));
  assert.ok(v.warnings.some((w) => w.includes('probable undocumented split')));
  assert.deepEqual(v.stats.splitSuspects, ['2024-01-04']);
});

test('manifest: hash, coverage, flags; hash verification detects source mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dlab-'));
  const p = join(dir, 'sample.json');
  writeFileSync(p, readFileSync(join(FIXTURES, 'causal-bars.json')));
  const loaded = loadJsonDaily(p);
  const { manifest } = buildDatasetManifest({ sourcePath: p, symbol: 'TEST', format: 'OHLC_CACHE_JSON_V1', bars: loaded.bars });
  assert.equal(manifest.barCount, 130);
  assert.equal(manifest.firstDate, '2024-01-02');
  assert.match(manifest.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(manifest.rawOhlcAvailable, false);
  assert.equal(manifest.adjustedOhlcAvailable, true);
  assert.deepEqual(validateDatasetManifest(manifest, { verifyHash: true }).problems, []);
  // Mutate the copy -> hash check must fail (silent mutation detection).
  writeFileSync(p, readFileSync(p, 'utf8').replace('"TEST"', '"TAMPERED"'));
  const after = validateDatasetManifest(manifest, { verifyHash: true });
  assert.equal(after.hashVerified, false);
});

test('discovery requires an explicit allowlist and never guesses', () => {
  assert.throws(() => discoverLocalDailyFiles({ allowedPaths: [] }));
  const { candidates } = discoverLocalDailyFiles({ allowedPaths: [FIXTURES] });
  const formats = new Set(candidates.map((c) => c.format));
  assert.ok(formats.has('OHLC_CACHE_JSON_V1'));
  const causal = candidates.find((c) => c.path.endsWith('causal-bars.json'));
  assert.equal(causal.symbol, 'TEST');
});
