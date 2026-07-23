/**
 * Independent L4B-F2 oracle vectors. This module deliberately has no imports:
 * expected values are produced with a separate BigInt/calendar implementation,
 * not with production builders, verifiers, feature computers or test helpers.
 */

function pow10(exponent) {
  let value = 1n;
  for (let index = 0; index < exponent; index += 1) value *= 10n;
  return value;
}

function divideHalfEven(numerator, denominator) {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  const remainder = n % d;
  const doubled = remainder * 2n;
  if (doubled > d || (doubled === d && quotient % 2n !== 0n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function ratioExpected(numerator, denominator, outputScale = 6) {
  const scaledNumerator = BigInt(numerator.atoms) * pow10(denominator.scale + outputScale);
  const scaledDenominator = BigInt(denominator.atoms) * pow10(numerator.scale);
  const quotient = divideHalfEven(scaledNumerator, scaledDenominator);
  return { atoms: String(quotient - pow10(outputScale)), scale: outputScale };
}

function deltaExpected(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const a = BigInt(left.atoms) * pow10(scale - left.scale);
  const b = BigInt(right.atoms) * pow10(scale - right.scale);
  return { atoms: String(a - b), scale };
}

function averageExpected(values, outputScale) {
  let sum = 0n;
  for (const value of values) {
    const atoms = BigInt(value.atoms);
    if (value.scale <= outputScale) sum += atoms * pow10(outputScale - value.scale);
    else sum += divideHalfEven(atoms, pow10(value.scale - outputScale));
  }
  return { atoms: String(divideHalfEven(sum, BigInt(values.length))), scale: outputScale };
}

function addMonthsExpected(monthKey, delta) {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const total = year * 12 + month - 1 + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = total - nextYear * 12 + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

const ratioSeeds = [
  [1000001, 1000000, 6, 6], [1000000, 1000000, 6, 6], [999999, 1000000, 6, 6],
  [101, 100, 0, 0], [99, 100, 0, 0], [307400, 307200, 3, 3],
  [307400, 300000, 3, 3], [1, 3, 0, 0], [2, 3, 0, 0],
  [10000005, 10000000, 7, 7], [10000015, 10000000, 7, 7],
  [123456789012345, 123450000000000, 3, 3], [25, 20, 1, 1], [15, 20, 1, 1],
  [1005, 1000, 2, 3], [1000, 1005, 3, 2], [42, 41, 1, 1], [41, 42, 1, 1],
  [400001, 400000, 0, 0], [399999, 400000, 0, 0], [7, 8, 0, 0], [9, 8, 0, 0],
  [314159265, 271828182, 8, 8], [271828182, 314159265, 8, 8],
  [922337203685477n, 922337203685000n, 4, 4],
  [500000000000001n, 500000000000000n, 6, 6],
  [100, 250, 2, 3], [250, 100, 3, 2], [-50, 100, 0, 0], [-100, 100, 0, 0],
  [1, 2000000, 0, 0], [1999999, 2000000, 0, 0],
];

const ratioVectors = ratioSeeds.map(([n, d, ns, ds], index) => {
  const numerator = { atoms: String(n), scale: ns };
  const denominator = { atoms: String(d), scale: ds };
  return {
    name: `ratio-${String(index + 1).padStart(2, '0')}`,
    kind: 'RATIO', numerator, denominator,
    expected: ratioExpected(numerator, denominator),
  };
});

const monthSeeds = [
  ['2026-01', -1], ['2026-01', -13], ['2025-12', 1], ['2024-02', 12],
  ['2024-02', -12], ['2000-01', 240], ['2030-12', -240], ['2025-06', 0],
  ['2025-03', -3], ['2025-10', 15], ['1999-12', 2], ['2100-01', -1],
];
const monthVectors = monthSeeds.map(([monthKey, delta], index) => ({
  name: `month-${String(index + 1).padStart(2, '0')}`,
  kind: 'MONTH', monthKey, delta, expected: addMonthsExpected(monthKey, delta),
}));

const deltaSeeds = [
  [{ atoms: '44', scale: 1 }, { atoms: '43', scale: 1 }],
  [{ atoms: '42', scale: 1 }, { atoms: '44', scale: 1 }],
  [{ atoms: '0', scale: 0 }, { atoms: '0', scale: 4 }],
  [{ atoms: '220000', scale: 0 }, { atoms: '210000', scale: 0 }],
  [{ atoms: '-10', scale: 1 }, { atoms: '5', scale: 2 }],
  [{ atoms: '999999999999999', scale: 6 }, { atoms: '1', scale: 0 }],
  [{ atoms: '1', scale: 6 }, { atoms: '9', scale: 7 }],
  [{ atoms: '-1', scale: 6 }, { atoms: '-10', scale: 7 }],
];
const deltaVectors = deltaSeeds.map(([left, right], index) => ({
  name: `delta-${String(index + 1).padStart(2, '0')}`,
  kind: 'DELTA', left, right, expected: deltaExpected(left, right),
}));

const averageSeeds = [
  [200000, 210000, 220000, 230000], [420000, 250000, 240000, 230000],
  [1, 2, 3, 4], [0, 0, 0, 0], [-4, -3, -2, -1],
  [1000000000, 1000000001, 1000000002, 1000000003],
  [299999, 300000, 399999, 400000], [7, 7, 8, 8],
];
const averageVectors = averageSeeds.map((atoms, index) => {
  const values = atoms.map((value) => ({ atoms: String(value), scale: 0 }));
  return {
    name: `average-${String(index + 1).padStart(2, '0')}`,
    kind: 'AVERAGE', values, expected: averageExpected(values, 0),
  };
});

const asOfVectors = [
  { name: 'asof-before-initial', kind: 'AS_OF', cutoff: '2026-01-01T00:00:00.000Z', expectedStatus: 'NOT_AVAILABLE', expectedAtoms: null },
  { name: 'asof-at-initial', kind: 'AS_OF', cutoff: '2026-01-10T13:30:00.000Z', expectedStatus: 'RESOLVED', expectedAtoms: '100' },
  { name: 'asof-before-revision', kind: 'AS_OF', cutoff: '2026-01-19T23:59:59.999Z', expectedStatus: 'RESOLVED', expectedAtoms: '100' },
  { name: 'asof-at-revision', kind: 'AS_OF', cutoff: '2026-01-20T13:30:00.000Z', expectedStatus: 'RESOLVED', expectedAtoms: '105' },
  { name: 'asof-before-withdrawal', kind: 'AS_OF', cutoff: '2026-01-29T23:59:59.999Z', expectedStatus: 'RESOLVED', expectedAtoms: '105' },
  { name: 'asof-at-withdrawal', kind: 'AS_OF', cutoff: '2026-01-30T13:30:00.000Z', expectedStatus: 'WITHDRAWN', expectedAtoms: null },
];

const claimsVectors = [
  { name: 'claims-normal-upper-edge', kind: 'CLAIMS_BAND', atoms: 299999, expected: 'NORMAL' },
  { name: 'claims-elevated-lower-edge', kind: 'CLAIMS_BAND', atoms: 300000, expected: 'ELEVATED' },
  { name: 'claims-elevated-upper-edge', kind: 'CLAIMS_BAND', atoms: 399999, expected: 'ELEVATED' },
  { name: 'claims-spike-lower-edge', kind: 'CLAIMS_BAND', atoms: 400000, expected: 'SPIKE' },
];

const compositeVectors = [
  { name: 'composite-disinflationary-easing', kind: 'COMPOSITE', inflation: 'FALLING', policy: 'EASING', labor: 'STABLE', expected: 'DISINFLATIONARY_EASING' },
  { name: 'composite-disinflationary-tight', kind: 'COMPOSITE', inflation: 'UNCHANGED', policy: 'TIGHTENING', labor: 'STABLE', expected: 'DISINFLATIONARY_TIGHT' },
  { name: 'composite-reflationary', kind: 'COMPOSITE', inflation: 'RISING', policy: 'UNCHANGED', labor: 'STABLE', expected: 'REFLATIONARY' },
  { name: 'composite-inflationary-tightening', kind: 'COMPOSITE', inflation: 'RISING', policy: 'TIGHTENING', labor: 'STABLE', expected: 'INFLATIONARY_TIGHTENING' },
  { name: 'composite-labor-weakening', kind: 'COMPOSITE', inflation: 'FALLING', policy: 'EASING', labor: 'DETERIORATING', expected: 'LABOR_WEAKENING' },
  { name: 'composite-insufficient', kind: 'COMPOSITE', inflation: 'NOT_AVAILABLE', policy: 'EASING', labor: 'STABLE', expected: 'INSUFFICIENT_DATA' },
];

const projectionVectors = [
  { name: 'projection-empty', kind: 'PROJECTION', empty: true, domicile: 'US', currency: 'USD', listed: true, completeness: 'COMPLETE', expected: 'EMPTY' },
  { name: 'projection-not-applicable', kind: 'PROJECTION', empty: false, domicile: 'CA', currency: 'CAD', listed: true, completeness: 'COMPLETE', expected: 'NOT_APPLICABLE' },
  { name: 'projection-session-mismatch', kind: 'PROJECTION', empty: false, domicile: 'US', currency: 'USD', listed: false, completeness: 'COMPLETE', expected: 'SESSION_MISMATCH' },
  { name: 'projection-partial', kind: 'PROJECTION', empty: false, domicile: 'US', currency: 'USD', listed: true, completeness: 'PARTIAL', expected: 'PARTIAL' },
];

export const MACRO_FULL_L4B_F2_ORACLE_VECTORS = Object.freeze([
  ...ratioVectors, ...monthVectors, ...deltaVectors, ...averageVectors,
  ...asOfVectors, ...claimsVectors, ...compositeVectors, ...projectionVectors,
]);

if (MACRO_FULL_L4B_F2_ORACLE_VECTORS.length !== 80) {
  throw new Error('L4B-F2 oracle vector inventory must remain exactly 80');
}
