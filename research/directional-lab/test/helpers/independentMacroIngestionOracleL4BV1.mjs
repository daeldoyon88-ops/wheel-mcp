/**
 * Independent L4B-I1 oracle. This module re-derives the macro identity,
 * ordering, graph, conflict, append-only and digest semantics from first
 * principles, using ONLY node:crypto and the low-level canonicalJsonBytes
 * primitive. It must never import the L4B-I1 builders, verifiers, production
 * registries or private helpers; the oracle test enforces this isolation with
 * a static source guard.
 */

import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../../src/canonical/canonicalJsonV1.mjs';

/** sha256 CAS-style id of one canonical value. */
export function oracleCanonicalHash(value) {
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')}`;
}

/** sha256 canonical digest of an ordered list of ids. */
export function oracleOrderedDigest(ids) {
  return oracleCanonicalHash(ids);
}

/** Permanent series identity projection: hash of the full identity value. */
export function oracleSeriesIdentityId(identity) {
  return oracleCanonicalHash(identity);
}

/** Logical observation identity projection. */
export function oracleObservationIdentityId(components) {
  return oracleCanonicalHash({
    schemaVersion: 'MacroObservationIdentityCore/1',
    macroSeriesIdentityId: components.macroSeriesIdentityId,
    observationPeriodStart: components.observationPeriodStart,
    observationPeriodEnd: components.observationPeriodEnd,
    referencePeriod: components.referencePeriod,
    unit: components.unit,
    seasonalAdjustment: components.seasonalAdjustment,
  });
}

/** Temporal vintage identity projection. */
export function oracleVintageIdentityId(components) {
  return oracleCanonicalHash({
    schemaVersion: 'MacroVintageIdentityCore/1',
    observationIdentityId: components.observationIdentityId,
    availableAt: components.availableAt,
    vintageSequence: components.vintageSequence,
    sourceDocumentId: components.sourceDocumentId,
  });
}

/**
 * Total canonical vintage order:
 * series, periodStart, periodEnd, observation, availableAt, sequence,
 * vintage identity, vintage content id.
 */
export function oracleCompareVintages(left, right) {
  const fields = ['macroSeriesIdentityId', 'observationPeriodStart',
    'observationPeriodEnd', 'observationIdentityId', 'availableAt',
    'vintageSequence', 'macroVintageIdentityId', 'observationVintageId'];
  for (const field of fields) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

/**
 * Series tips: for each canonicalSeriesCode, the ACTIVE entries. Returns
 * {tips, duplicateActiveCodes} without resolving any conflict.
 */
export function oracleSeriesTips(entries) {
  const tips = new Map();
  const duplicateActiveCodes = [];
  for (const entry of entries) {
    if (entry.status !== 'ACTIVE') continue;
    if (tips.has(entry.canonicalSeriesCode)) {
      duplicateActiveCodes.push(entry.canonicalSeriesCode);
    } else {
      tips.set(entry.canonicalSeriesCode, entry.macroSeriesIdentityId);
    }
  }
  return {
    tips: Object.fromEntries([...tips.entries()].sort()),
    duplicateActiveCodes: duplicateActiveCodes.sort(),
  };
}

/** Detects replacement cycles among registry entries (supersedes edges). */
export function oracleHasReplacementCycle(entries) {
  const edges = new Map();
  for (const entry of entries) {
    if (entry.supersedesSeriesIdentityId !== null) {
      edges.set(entry.macroSeriesIdentityId, entry.supersedesSeriesIdentityId);
    }
  }
  for (const start of edges.keys()) {
    let cursor = start;
    const seen = new Set();
    while (edges.has(cursor)) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = edges.get(cursor);
    }
  }
  return false;
}

/**
 * Classifies the parent graph of ONE observation. Vintages carry
 * {macroVintageIdentityId, vintageSequence, parentVintageId, revisionKind,
 * availableAt}. Returns the first deterministic defect or null when the
 * graph is a single causal chain.
 */
export function oracleVintageGraphDefect(vintages) {
  const sorted = [...vintages].sort((l, r) => (
    l.vintageSequence - r.vintageSequence
    || (l.macroVintageIdentityId < r.macroVintageIdentityId ? -1 : 1)));
  const byId = new Map();
  for (const vintage of sorted) {
    if (byId.has(vintage.macroVintageIdentityId)) return 'DUPLICATE_IDENTITY';
    byId.set(vintage.macroVintageIdentityId, vintage);
  }
  const initials = sorted.filter((vintage) => vintage.revisionKind === 'INITIAL');
  if (initials.length > 1) return 'MULTIPLE_INITIAL';
  const sequences = new Set();
  const childrenByParent = new Map();
  for (const vintage of sorted) {
    if (sequences.has(vintage.vintageSequence)) return 'DUPLICATE_SEQUENCE';
    sequences.add(vintage.vintageSequence);
    if (vintage.parentVintageId === null) continue;
    if (vintage.parentVintageId === vintage.macroVintageIdentityId) return 'SELF_CYCLE';
    const parent = byId.get(vintage.parentVintageId);
    if (parent === undefined) return 'PARENT_MISSING';
    if (parent.vintageSequence >= vintage.vintageSequence) return 'SEQUENCE_NOT_INCREASING';
    if (parent.availableAt > vintage.availableAt) return 'AVAILABLE_AT_DECREASING';
    const children = childrenByParent.get(vintage.parentVintageId) ?? 0;
    if (children >= 1) return 'BRANCH_CONFLICT';
    childrenByParent.set(vintage.parentVintageId, children + 1);
  }
  return null;
}

/** Two contents claiming one temporal identity with different bytes. */
export function oracleHasIdentityContentConflict(contents) {
  const byIdentity = new Map();
  for (const content of contents) {
    const bytes = canonicalJsonBytes(content).toString('hex');
    const previous = byIdentity.get(content.macroVintageIdentityId);
    if (previous !== undefined && previous !== bytes) return true;
    byIdentity.set(content.macroVintageIdentityId, bytes);
  }
  return false;
}

/**
 * Append-only preservation: every parent flat entry must appear unchanged in
 * the child, and the child must only add entries.
 */
export function oracleAppendOnlyPreserved(parentFlat, childFlat) {
  if (childFlat.length < parentFlat.length) return false;
  const childBytes = new Set(
    childFlat.map((entry) => canonicalJsonBytes(entry).toString('hex')));
  return parentFlat.every(
    (entry) => childBytes.has(canonicalJsonBytes(entry).toString('hex')));
}

/** Counts and availableAt bounds from flat entries, without any clock. */
export function oracleCountsAndBounds(flatEntries) {
  const availableAts = flatEntries.map((entry) => entry.availableAt).sort();
  return {
    vintageCount: flatEntries.length,
    firstAvailableAt: availableAts.length === 0 ? null : availableAts[0],
    lastAvailableAt: availableAts.length === 0 ? null : availableAts[availableAts.length - 1],
  };
}
