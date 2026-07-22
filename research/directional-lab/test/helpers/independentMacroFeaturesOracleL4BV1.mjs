/**
 * Independent L4B-F1 oracle. Depends only on node:crypto and canonical JSON.
 */
import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../../src/canonical/canonicalJsonV1.mjs';

export const oracleDigest = (value) => `sha256:${createHash('sha256')
  .update(canonicalJsonBytes(value)).digest('hex')}`;

const K0 = '2026-03-02T21:00:00.000Z';
const K1 = '2026-03-03T21:00:00.000Z';
const K2 = '2026-03-04T21:00:00.000Z';
const K3 = '2026-03-05T21:00:00.000Z';

export function oracleSelectAtClose(vintages, sessionCloseUtc) {
  const eligible = vintages.filter((v) => v.availableAt <= sessionCloseUtc)
    .sort((a, b) => a.availableAt.localeCompare(b.availableAt)
      || a.vintageSequence - b.vintageSequence || a.id.localeCompare(b.id));
  if (!eligible.length) return { status: 'NOT_AVAILABLE', selected: null };
  const ids = new Map(eligible.map((v) => [v.id, v]));
  const children = new Map();
  for (const vintage of eligible) {
    if (vintage.parentId !== null) {
      if (!ids.has(vintage.parentId)) return { status: 'PARENT_MISSING', selected: null };
      if (children.has(vintage.parentId)) return { status: 'AMBIGUOUS', selected: null };
      children.set(vintage.parentId, vintage.id);
    }
  }
  const roots = eligible.filter((v) => v.parentId === null || !ids.has(v.parentId));
  if (roots.length !== 1) return { status: 'AMBIGUOUS', selected: null };
  let tip = roots[0];
  const seen = new Set();
  while (children.has(tip.id)) {
    if (seen.has(tip.id)) return { status: 'CYCLE', selected: null };
    seen.add(tip.id);
    tip = ids.get(children.get(tip.id));
  }
  if (tip.kind === 'WITHDRAWAL') return { status: 'WITHDRAWN', selected: tip };
  return { status: 'RESOLVED', selected: tip };
}

export function oracleCarryForwardAge(landingCloseUtc, sessionCloseUtc, orderedSessionCloses) {
  const landIndex = orderedSessionCloses.findIndex((close) => close >= landingCloseUtc);
  const currentIndex = orderedSessionCloses.findIndex((close) => close === sessionCloseUtc);
  if (currentIndex < 0 || landIndex < 0) return 0;
  return currentIndex >= landIndex ? currentIndex - landIndex : 0;
}

export function oracleStaleness(age, limit) {
  if (limit === null) return 'AVAILABLE';
  return age > limit ? 'STALE' : 'AVAILABLE';
}

export function oracleSpread(leftAtoms, rightAtoms, scale = 2) {
  return { atoms: String(BigInt(leftAtoms) - BigInt(rightAtoms)), scale };
}

export function oracleSpreadClass(spreadAtoms, flatThreshold = 10n, inversionThreshold = -10n) {
  const atoms = BigInt(spreadAtoms);
  const abs = atoms < 0n ? -atoms : atoms;
  if (abs <= flatThreshold) return 'FLAT';
  if (atoms <= inversionThreshold) return 'INVERTED';
  if (atoms > flatThreshold) return 'NORMAL';
  return 'MIXED';
}

export function oracleCurveShape(requiredClasses, partialPolicy = 'CLASSIFY_FROM_AVAILABLE_REQUIRED_SPREADS') {
  const available = requiredClasses.filter((c) => c !== null);
  if (available.length === 0) return 'NOT_AVAILABLE';
  if (available.length < requiredClasses.length && partialPolicy !== 'CLASSIFY_FROM_AVAILABLE_REQUIRED_SPREADS') {
    return 'NOT_AVAILABLE';
  }
  const unique = [...new Set(available)];
  if (unique.length === 1) return unique[0];
  if (unique.includes('INVERTED') && (unique.includes('NORMAL') || unique.includes('FLAT'))) {
    return 'PARTIALLY_INVERTED';
  }
  return 'MIXED';
}

export function oracleCurveDirection(change10y2y, change10y3m) {
  const signs = [];
  for (const change of [change10y2y, change10y3m]) {
    if (change === null || change === undefined) continue;
    const atoms = BigInt(change);
    if (atoms > 0n) signs.push('STEEPENING');
    else if (atoms < 0n) signs.push('FLATTENING');
    else signs.push('UNCHANGED');
  }
  if (signs.length === 0) return 'NOT_AVAILABLE';
  const unique = [...new Set(signs)];
  if (unique.length === 1) return unique[0];
  if (unique.includes('STEEPENING') && unique.includes('FLATTENING')) return 'MIXED';
  return unique.includes('STEEPENING') ? 'STEEPENING' : 'FLATTENING';
}

export function oraclePolicyDirection(midpointChange) {
  if (midpointChange === null || midpointChange === undefined) return 'NOT_AVAILABLE';
  const atoms = BigInt(midpointChange);
  if (atoms < 0n) return 'EASING';
  if (atoms > 0n) return 'TIGHTENING';
  return 'UNCHANGED';
}

export function oracleFomcDecision(lowerChange, upperChange, midpointChange, withdrawn = false) {
  if (withdrawn) return 'WITHDRAWN';
  if (midpointChange === null || lowerChange === null || upperChange === null) return 'NOT_AVAILABLE';
  const mid = BigInt(midpointChange);
  const lower = BigInt(lowerChange);
  const upper = BigInt(upperChange);
  const widthChanged = lower !== upper || (lower !== 0n || upper !== 0n);
  const midZero = mid === 0n;
  const asymmetric = lower !== upper;
  if ((widthChanged && midZero) || (asymmetric && midZero && (lower !== 0n || upper !== 0n))) {
    return 'RANGE_RESTRUCTURE';
  }
  if (mid > 0n) return 'HIKE';
  if (mid < 0n) return 'CUT';
  if (lower === 0n && upper === 0n) return 'HOLD';
  if (asymmetric) return 'RANGE_RESTRUCTURE';
  return 'HOLD';
}

export function oracleCalendarTip(versions, knowledgeCutoff) {
  const eligible = versions.filter((v) => v.calendarKnowledgeAvailableAt <= knowledgeCutoff)
    .sort((a, b) => a.calendarKnowledgeAvailableAt.localeCompare(b.calendarKnowledgeAvailableAt)
      || a.id.localeCompare(b.id));
  if (!eligible.length) return { status: 'NOT_AVAILABLE', selected: null };
  const ids = new Map(eligible.map((v) => [v.id, v]));
  const children = new Map();
  for (const version of eligible) {
    if (version.parentId !== null) {
      if (!ids.has(version.parentId)) return { status: 'PARENT_MISSING', selected: null };
      if (children.has(version.parentId)) return { status: 'CONFLICT', selected: null };
      children.set(version.parentId, version.id);
    }
  }
  const roots = eligible.filter((v) => v.parentId === null || !ids.has(v.parentId));
  if (roots.length !== 1) return { status: 'CONFLICT', selected: null };
  let tip = roots[0];
  while (children.has(tip.id)) tip = ids.get(children.get(tip.id));
  if (tip.status === 'CANCELLED') return { status: 'CANCELLED', selected: tip };
  return { status: 'RESOLVED', selected: tip };
}

export function oracleSessionOrder(left, right) {
  for (const field of ['sessionDate', 'sessionOpenUtc', 'sessionCloseUtc', 'sessionId']) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

export function oracleCompleteness(available, required) {
  if (required === 0) return 'UNAVAILABLE';
  if (available === required) return 'COMPLETE';
  if (available === 0) return 'UNAVAILABLE';
  return 'PARTIAL';
}

const v = (id, availableAt, vintageSequence, parentId = null, kind = 'INITIAL') =>
  ({ id, availableAt, vintageSequence, parentId, kind });
const c = (id, calendarKnowledgeAvailableAt, parentId = null, status = 'SCHEDULED') =>
  ({ id, calendarKnowledgeAvailableAt, parentId, status });

export const ORACLE_VECTORS = Object.freeze([
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `close-cutoff-${i + 1}`, kind: 'atClose',
    input: { vintages: [v('a', K1, 0)], sessionCloseUtc: i % 2 ? K0 : K1 },
    expected: i % 2 ? 'NOT_AVAILABLE' : 'RESOLVED',
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `future-exclusion-${i + 1}`, kind: 'atClose',
    input: { vintages: [v('a', K3, 0)], sessionCloseUtc: K1 },
    expected: 'NOT_AVAILABLE',
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `carry-forward-${i + 1}`, kind: 'carryAge',
    input: {
      landingCloseUtc: K0,
      sessionCloseUtc: [K0, K1, K2, K3][i % 4],
      orderedSessionCloses: [K0, K1, K2, K3],
    },
    expected: [0, 1, 2, 3][i % 4],
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `staleness-${i + 1}`, kind: 'staleness',
    input: { age: i, limit: 5 },
    expected: i > 5 ? 'STALE' : 'AVAILABLE',
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `spread-${i + 1}`, kind: 'spread',
    input: { leftAtoms: 420 + i, rightAtoms: 400 },
    expected: { atoms: String(20 + i), scale: 2 },
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `spread-class-${i + 1}`, kind: 'spreadClass',
    input: { spreadAtoms: [-15 + i * 5] },
    expected: oracleSpreadClass(-15 + i * 5),
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `curve-shape-${i + 1}`, kind: 'curveShape',
    input: { requiredClasses: i % 2 ? ['FLAT', 'FLAT'] : ['NORMAL', 'INVERTED'] },
    expected: i % 2 ? 'FLAT' : 'PARTIALLY_INVERTED',
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `curve-direction-${i + 1}`, kind: 'curveDirection',
    input: { change10y2y: i % 2 ? 5 : -5, change10y3m: i < 2 ? 3 : -3 },
    expected: ['MIXED', 'STEEPENING', 'FLATTENING', 'MIXED'][i],
  })),
  { id: 'policy-hike', kind: 'policyDirection', input: { midpointChange: 25 }, expected: 'TIGHTENING' },
  { id: 'policy-cut', kind: 'policyDirection', input: { midpointChange: -25 }, expected: 'EASING' },
  { id: 'policy-hold', kind: 'policyDirection', input: { midpointChange: 0 }, expected: 'UNCHANGED' },
  { id: 'policy-na', kind: 'policyDirection', input: { midpointChange: null }, expected: 'NOT_AVAILABLE' },
  { id: 'fomc-hike', kind: 'fomc', input: { lowerChange: 25, upperChange: 25, midpointChange: 25 }, expected: 'HIKE' },
  { id: 'fomc-cut', kind: 'fomc', input: { lowerChange: -25, upperChange: -25, midpointChange: -25 }, expected: 'CUT' },
  { id: 'fomc-hold', kind: 'fomc', input: { lowerChange: 0, upperChange: 0, midpointChange: 0 }, expected: 'HOLD' },
  { id: 'fomc-restructure', kind: 'fomc', input: { lowerChange: 0, upperChange: 25, midpointChange: 0 }, expected: 'RANGE_RESTRUCTURE' },
  { id: 'fomc-withdrawn', kind: 'fomc', input: { lowerChange: 0, upperChange: 0, midpointChange: 0, withdrawn: true }, expected: 'WITHDRAWN' },
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `calendar-${i + 1}`, kind: 'calendar',
    input: { versions: [c('s', K1), c('r', K2, 's')], knowledgeCutoff: K3 },
    expected: 'RESOLVED', selected: 'r',
  })),
  { id: 'calendar-cancel', kind: 'calendar',
    input: { versions: [c('a', K0), c('x', K1, 'a', 'CANCELLED')], knowledgeCutoff: K2 },
    expected: 'CANCELLED', selected: 'x' },
  { id: 'calendar-future', kind: 'calendar',
    input: { versions: [c('f', K3)], knowledgeCutoff: K1 },
    expected: 'NOT_AVAILABLE' },
  { id: 'completeness-full', kind: 'completeness', input: { available: 3, required: 3 }, expected: 'COMPLETE' },
  { id: 'completeness-partial', kind: 'completeness', input: { available: 2, required: 3 }, expected: 'PARTIAL' },
  { id: 'completeness-empty', kind: 'completeness', input: { available: 0, required: 3 }, expected: 'UNAVAILABLE' },
  { id: 'digest-empty', kind: 'digest', input: [], expected: oracleDigest([]) },
  { id: 'digest-order', kind: 'digest', input: ['a', 'b'], expected: oracleDigest(['a', 'b']) },
  { id: 'digest-prefix-invariant', kind: 'digestPrefix',
    input: { base: ['x'], extended: ['x', 'y'] },
    expected: 'different' },
  { id: 'session-order', kind: 'sessionOrder',
    input: {
      left: { sessionDate: '2026-03-02', sessionOpenUtc: K0, sessionCloseUtc: K0, sessionId: 'a' },
      right: { sessionDate: '2026-03-03', sessionOpenUtc: K1, sessionCloseUtc: K1, sessionId: 'b' },
    },
    expected: -1 },
  { id: 'withdrawal-at-close', kind: 'atClose',
    input: { vintages: [v('a', K0, 0), v('w', K1, 1, 'a', 'WITHDRAWAL')], sessionCloseUtc: K2 },
    expected: 'WITHDRAWN', selected: 'w' },
  { id: 'staleness-null-limit', kind: 'staleness', input: { age: 99, limit: null }, expected: 'AVAILABLE' },
  { id: 'spread-sixth', kind: 'spread', input: { leftAtoms: 440, rightAtoms: 380 }, expected: { atoms: '60', scale: 2 } },
]);
