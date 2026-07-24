/**
 * Independent L4B-P oracle.
 * Deliberately no imports: no production builder, verifier, resolver or helper.
 */

const FAMILY_ORDER = [
  'RATES',
  'FOMC',
  'TREASURY_CURVE',
  'INFLATION',
  'UNEMPLOYMENT',
  'CLAIMS',
  'FULL_MACRO_STATE',
  'INSTRUMENT_PROJECTION',
];

const digestVectors = Array.from({ length: 20 }, (_, index) => ({
  name: `digest-${String(index + 1).padStart(2, '0')}`,
  kind: 'DIGEST',
  input: FAMILY_ORDER.map((familyCode, familyIndex) => ({
    familyCode,
    ordinal: familyIndex,
    revision: index,
  })),
}));

const boundaryVectors = Array.from({ length: 20 }, (_, index) => {
  const minute = String(index).padStart(2, '0');
  const availableAt = `2026-03-17T00:${minute}:00.000Z`;
  return {
    name: `boundary-${String(index + 1).padStart(2, '0')}`,
    kind: 'BOUNDARY',
    availableAt,
    before: `2026-03-17T00:${minute}:00.000Z`,
    expectedAtBoundary: 'RESOLVED',
  };
});

const statusVectors = Array.from({ length: 20 }, (_, index) => {
  const sessionCount = index % 5;
  const unavailable = index % 3 === 0 && sessionCount > 0 ? 1 : 0;
  const partial = index % 4 === 0 && sessionCount > 0 ? 1 : 0;
  return {
    name: `status-${String(index + 1).padStart(2, '0')}`,
    kind: 'STATUS',
    sessionCount,
    partial,
    unavailable,
    expected: sessionCount === 0
      ? 'EMPTY'
      : partial > 0 || unavailable > 0
        ? 'PARTIAL'
        : 'PUBLISHED',
  };
});

const orderingVectors = Array.from({ length: 20 }, (_, index) => ({
  name: `ordering-${String(index + 1).padStart(2, '0')}`,
  kind: 'ORDERING',
  input: index % 2 === 0 ? [...FAMILY_ORDER].reverse() : [...FAMILY_ORDER],
  expected: [...FAMILY_ORDER],
}));

export const MARKET_MACRO_L4BP_ORACLE_VECTORS = Object.freeze([
  ...digestVectors,
  ...boundaryVectors,
  ...statusVectors,
  ...orderingVectors,
]);

if (MARKET_MACRO_L4BP_ORACLE_VECTORS.length !== 80) {
  throw new Error('L4B-P oracle inventory must remain exactly 80');
}
