/**
 * testTheoryPricingService.mjs
 *
 * Lightweight test script for the isolated Black-Scholes CC pricing engine.
 * Run: node scripts/testTheoryPricingService.mjs
 *
 * Exit 0 = all tests passed.
 * Exit 1 = at least one test failed.
 */

import {
  normalCdf,
  blackScholesCall,
  estimateCoveredCallPremium,
  computeCcYield,
  computeCcThresholds,
  requiredPremiumForThreshold,
  chooseVolatilityForCc,
} from '../app/theory/theoryPricingService.js';

// ─── helpers ────────────────────────────────

let passed = 0;
let failed = 0;

function approx(actual, expected, tolerance = 0.001) {
  return Math.abs(actual - expected) <= tolerance;
}

function assert(condition, label, extra = '') {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}${extra ? ' — ' + extra : ''}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n══════ ${name} ══════`);
}

// ─── 1. normalCdf ───────────────────────────

section('normalCdf');
assert(approx(normalCdf(0),  0.5,    0.001), 'normalCdf(0)  ≈ 0.5');
assert(approx(normalCdf(1),  0.8413, 0.001), 'normalCdf(1)  ≈ 0.8413');
assert(approx(normalCdf(-1), 0.1587, 0.001), 'normalCdf(-1) ≈ 0.1587');
assert(approx(normalCdf(2),  0.9772, 0.001), 'normalCdf(2)  ≈ 0.9772');
assert(normalCdf(10) > 0.999,               'normalCdf(10) → nearly 1');
assert(normalCdf(-10) < 0.001,              'normalCdf(-10) → nearly 0');

// ─── 2. blackScholesCall — ATM simple ───────

section('blackScholesCall — ATM case (S=100 K=100 dte=7 vol=0.5)');
const bsAtm = blackScholesCall({ spot: 100, strike: 100, dte: 7, volatility: 0.5 });
console.log('  Result:', JSON.stringify(bsAtm, null, 2));

assert(bsAtm.ok === true,               'ok === true');
assert(bsAtm.premium > 0,              'premium > 0');
assert(bsAtm.premium < 5,              'premium < 5 (ATM 7dte, sanity check)');
assert(Number.isFinite(bsAtm.d1),      'd1 is finite');
assert(Number.isFinite(bsAtm.d2),      'd2 is finite');

// ─── 3. blackScholesCall — invalid inputs ───

section('blackScholesCall — invalid inputs');
const bsBadSpot = blackScholesCall({ spot: -5, strike: 100, dte: 7, volatility: 0.5 });
assert(bsBadSpot.ok === false, 'negative spot → ok:false');
assert(typeof bsBadSpot.error === 'string', 'error string returned');

const bsBadVol = blackScholesCall({ spot: 100, strike: 100, dte: 7, volatility: 0 });
assert(bsBadVol.ok === false, 'zero volatility → ok:false');

const bsBadDte = blackScholesCall({ spot: 100, strike: 100, dte: -1, volatility: 0.5 });
assert(bsBadDte.ok === false, 'negative dte → ok:false');

// ─── 4. chooseVolatilityForCc ────────────────

section('chooseVolatilityForCc');
const v1 = chooseVolatilityForCc({ hv30: 0.9, atmIv: 1.1 });
assert(v1.volatilityUsed   === 1.1,              'max(hv30=0.9, atmIv=1.1) = 1.1');
assert(v1.volatilitySource === 'max_hv30_atm_iv', 'source = max_hv30_atm_iv');

const v2 = chooseVolatilityForCc({ hv30: 0.6 });
assert(v2.volatilityUsed   === 0.6,   'only hv30 → uses hv30');
assert(v2.volatilitySource === 'hv30', 'source = hv30');

const v3 = chooseVolatilityForCc({ atmIv: 0.8 });
assert(v3.volatilityUsed   === 0.8,     'only atmIv → uses atmIv');
assert(v3.volatilitySource === 'atm_iv', 'source = atm_iv');

const v4 = chooseVolatilityForCc({ safeStrikeIv: 0.7 });
assert(v4.volatilityUsed   === 0.7,            'safeStrikeIv fallback');
assert(v4.volatilitySource === 'safe_strike_iv', 'source = safe_strike_iv');

const v5 = chooseVolatilityForCc({});
assert(v5.volatilityUsed   === 0.4,      'no inputs → uses default 0.4');
assert(v5.volatilitySource === 'fallback', 'source = fallback');

const v6 = chooseVolatilityForCc({ hv30: 64 });  // 6400% — treated as invalid
assert(v6.volatilitySource !== 'hv30', 'hv30=64 (>5) rejected as invalid');

// ─── 5. computeCcYield & computeCcThresholds ─

section('computeCcYield / computeCcThresholds');
const yieldPct = computeCcYield({ premium: 0.43, strike: 43 });
assert(approx(yieldPct, 1.0, 0.01), 'premium 0.43 on strike 43 → 1%');

const req = requiredPremiumForThreshold({ strike: 43, thresholdPct: 1 });
assert(approx(req, 0.43, 0.001), 'requiredPremium for 1% on 43 = 0.43');

const thresholds = computeCcThresholds({ premium: 0.43, strike: 43 });
const t05  = thresholds.find(t => t.thresholdPct === 0.5);
const t1   = thresholds.find(t => t.thresholdPct === 1.0);
const t15  = thresholds.find(t => t.thresholdPct === 1.5);
const t6   = thresholds.find(t => t.thresholdPct === 6.0);

assert(t05  && t05.reached  === true,  '0.5% threshold reached (premium 0.43 on 43)');
assert(t1   && t1.reached   === true,  '1.0% threshold reached (0.43 = exactly 1%)');
assert(t15  && t15.reached  === false, '1.5% threshold NOT reached');
assert(t6   && t6.reached   === false, '6.0% threshold NOT reached');

// ─── 6. estimateCoveredCallPremium — APLD theoretical ─

section('estimateCoveredCallPremium — APLD theoretical (spot=39.41 ccStrike=43 dte=4)');
const apld = estimateCoveredCallPremium({
  spot:             39.41,
  assignmentStrike: 43,
  ccStrike:         43,
  dte:              4,
  hv30:             0.9,
  atmIv:            1.1,
  safeStrikeIv:     1.0,
  conservativeFactor: 0.8,
});

console.log('\n  APLD result:');
console.log('  source              :', apld.source);
console.log('  volatilityUsed      :', apld.volatilityUsed, '→', apld.volatilitySource);
console.log('  bsPremium           :', apld.bsPremium?.toFixed(4));
console.log('  premiumConservative :', apld.premiumConservative?.toFixed(4));
console.log('  ccYieldPct          :', apld.ccYieldPct?.toFixed(4), '%');
console.log('  ccYieldConsPct      :', apld.ccYieldConservativePct?.toFixed(4), '%');
console.log('  d1                  :', apld.bsDetail?.d1?.toFixed(4));
console.log('  d2                  :', apld.bsDetail?.d2?.toFixed(4));
console.log('\n  Thresholds:');
for (const t of apld.thresholds ?? []) {
  const marker = t.reached ? '✓' : '✗';
  console.log(
    `    [${marker}] ${String(t.thresholdPct).padEnd(4)}%`
    + `  required=$${t.requiredPremium.toFixed(4)}`
    + `  actual=$${t.premium.toFixed(4)}`
  );
}

assert(apld.ok === true,                  'ok === true');
assert(apld.bsPremium > 0,               'bsPremium > 0');
assert(apld.premiumConservative > 0,     'premiumConservative > 0');
assert(apld.premiumConservative < apld.bsPremium + 0.0001, 'conservative ≤ bs (haircut applied)');
assert(Number.isFinite(apld.ccYieldPct), 'ccYieldPct is a number');
assert(Array.isArray(apld.thresholds) && apld.thresholds.length === 10, '10 thresholds computed');

const hasPct = (pct) => apld.thresholds.some(t => t.thresholdPct === pct);
assert(hasPct(0.5),  'threshold 0.5% present');
assert(hasPct(1.0),  'threshold 1.0% present');
assert(hasPct(1.5),  'threshold 1.5% present');
assert(hasPct(2.0),  'threshold 2.0% present');
assert(hasPct(5.0),  'threshold 5.0% present');
assert(hasPct(6.0),  'threshold 6.0% present');

// ─── 7. ccStrike < assignmentStrike → rejected ─

section('estimateCoveredCallPremium — ccStrike below assignment (must fail)');
const badStrike = estimateCoveredCallPremium({
  spot:             39.41,
  assignmentStrike: 43,
  ccStrike:         42,   // ← below assignment
  dte:              4,
  hv30:             0.9,
});

console.log('  Error returned:', badStrike.error);
assert(badStrike.ok    === false,                       'ok === false');
assert(typeof badStrike.error === 'string',              'error is a string');
assert(badStrike.error.includes('42'),                  'error mentions ccStrike (42)');
assert(badStrike.error.includes('43'),                  'error mentions assignmentStrike (43)');

// ─── Summary ────────────────────────────────

section('RESULTS');
console.log(`\n  Passed : ${passed}`);
console.log(`  Failed : ${failed}`);
console.log('');

if (failed > 0) {
  console.error(`  ${failed} test(s) FAILED.`);
  process.exit(1);
}

console.log('  All tests passed.');
process.exit(0);
