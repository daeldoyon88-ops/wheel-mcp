/**
 * Independent L4B-I2 oracle.  This file deliberately depends only on SHA-256
 * and canonical JSON; production builders and resolvers are not imported.
 */
import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../../src/canonical/canonicalJsonV1.mjs';

export const oracleDigest = (value) => `sha256:${createHash('sha256')
  .update(canonicalJsonBytes(value)).digest('hex')}`;
export const oracleOrderedDigest = (ids) => oracleDigest(ids);
export const oracleEmptyDigest = () => oracleDigest([]);

export function oracleSelectVintageAsOf(vintages, knowledgeCutoff) {
  const eligible = vintages.filter((v) => v.availableAt <= knowledgeCutoff)
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
  if (eligible.some((v) => v.kind === 'WITHDRAWAL'
      && (v.availableAt < tip.availableAt
        || (v.availableAt === tip.availableAt && v.vintageSequence < tip.vintageSequence)))) {
    return { status: 'AMBIGUOUS', selected: null };
  }
  return { status: 'RESOLVED', selected: tip };
}

export function oracleSelectCalendarAsOf(versions, knowledgeCutoff) {
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
  return { status: 'RESOLVED', selected: tip };
}

export function oracleHasCycle(nodes, parentField = 'parentId') {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const seen = new Set();
    let cursor = node;
    while (cursor?.[parentField] !== null && cursor?.[parentField] !== undefined) {
      if (seen.has(cursor.id)) return true;
      seen.add(cursor.id);
      cursor = byId.get(cursor[parentField]);
    }
  }
  return false;
}
export function oracleHasConflict(nodes, parentField = 'parentId') {
  const parents = new Set();
  for (const node of nodes) {
    if (node[parentField] === null) continue;
    if (parents.has(node[parentField])) return true;
    parents.add(node[parentField]);
  }
  return false;
}

const v = (id, availableAt, vintageSequence, parentId = null, kind = 'INITIAL') =>
  ({ id, availableAt, vintageSequence, parentId, kind });
const c = (id, calendarKnowledgeAvailableAt, parentId = null, status = 'SCHEDULED') =>
  ({ id, calendarKnowledgeAvailableAt, parentId, status });
const K0 = '2026-01-01T00:00:00.000Z';
const K1 = '2026-01-02T00:00:00.000Z';
const K2 = '2026-01-03T00:00:00.000Z';

export const ORACLE_VECTORS = Object.freeze([
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `vintage-boundary-${i + 1}`, kind: 'vintage',
    input: { vintages: [v('a', K1, i)], knowledgeCutoff: i % 2 ? K0 : K1 },
    expected: i % 2 ? 'NOT_AVAILABLE' : 'RESOLVED',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `vintage-chain-${i + 1}`, kind: 'vintage',
    input: { vintages: [v('a', K0, 0), v('b', K1, i + 1, 'a', 'REVISION')], knowledgeCutoff: K2 },
    expected: 'RESOLVED', selected: 'b',
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `withdrawal-${i + 1}`, kind: 'vintage',
    input: { vintages: [v('a', K0, 0), v('w', K1, i + 1, 'a', 'WITHDRAWAL')], knowledgeCutoff: K2 },
    expected: 'WITHDRAWN', selected: 'w',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `calendar-boundary-${i + 1}`, kind: 'calendar',
    input: { versions: [c('s', K1)], knowledgeCutoff: i % 2 ? K0 : K1 },
    expected: i % 2 ? 'NOT_AVAILABLE' : 'RESOLVED',
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `calendar-chain-${i + 1}`, kind: 'calendar',
    input: { versions: [c('s', K0), c('r', K1, 's', i % 2 ? 'DELAYED' : 'RESCHEDULED')], knowledgeCutoff: K2 },
    expected: 'RESOLVED', selected: 'r',
  })),
  { id: 'vintage-branch', kind: 'vintage', input: { vintages: [v('a', K0, 0), v('b', K1, 1, 'a'), v('c', K2, 2, 'a')], knowledgeCutoff: K2 }, expected: 'AMBIGUOUS' },
  { id: 'calendar-branch', kind: 'calendar', input: { versions: [c('a', K0), c('b', K1, 'a'), c('d', K2, 'a')], knowledgeCutoff: K2 }, expected: 'CONFLICT' },
  { id: 'digest-empty', kind: 'digest', input: [], expected: oracleDigest([]) },
  { id: 'digest-order', kind: 'digest', input: ['a', 'b'], expected: oracleDigest(['a', 'b']) },
  { id: 'cycle-true', kind: 'cycle', input: [v('a', K0, 0, 'b'), v('b', K1, 1, 'a')], expected: true },
  { id: 'cycle-false', kind: 'cycle', input: [v('a', K0, 0), v('b', K1, 1, 'a')], expected: false },
  { id: 'conflict-true', kind: 'conflict', input: [v('a', K0, 0), v('b', K1, 1, 'a'), v('c', K2, 2, 'a')], expected: true },
  { id: 'conflict-false', kind: 'conflict', input: [v('a', K0, 0), v('b', K1, 1, 'a')], expected: false },
]);
