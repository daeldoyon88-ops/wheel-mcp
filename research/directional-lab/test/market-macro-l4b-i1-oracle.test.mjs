/**
 * L4B-I1 independent oracle suite: 48 numbered vectors re-derive series,
 * observation and vintage identities, canonical ordering, series tips,
 * replacement and parent cycles, conflicts, append-only preservation, counts,
 * bounds and ordered digests from first principles, then compare against the
 * production outputs of the deterministic official fixture. A static guard
 * proves the oracle never imports L4B-I1 production modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  oracleAppendOnlyPreserved,
  oracleCanonicalHash,
  oracleCompareVintages,
  oracleCountsAndBounds,
  oracleHasIdentityContentConflict,
  oracleHasReplacementCycle,
  oracleObservationIdentityId,
  oracleOrderedDigest,
  oracleSeriesIdentityId,
  oracleSeriesTips,
  oracleVintageGraphDefect,
  oracleVintageIdentityId,
} from './helpers/independentMacroIngestionOracleL4BV1.mjs';
import {
  withEmptyMacroL4BI1Fixture,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';
import { macroVintageSetFlatEntriesV1 } from '../src/contracts/macroIngestionContractsL4BV1.mjs';

/** One deterministic capture of the official and empty fixtures. */
const P = withOfficialMacroL4BI1Fixture((ctx) => ({
  series: Object.fromEntries(Object.entries(ctx.series).map(([key, built]) => [
    key, { id: built.macroSeriesIdentityId, value: built.macroSeriesIdentity },
  ])),
  observations: Object.fromEntries(Object.entries(ctx.observations).map(([key, built]) => [
    key, { id: built.observationIdentityId, value: built.observationIdentity },
  ])),
  vintages: Object.fromEntries(Object.entries(ctx.vintages).map(([key, built]) => [
    key, built.observationVintage,
  ])),
  registryEntries: ctx.registry.registry.orderedSeriesEntries,
  vintageSet: ctx.vintageSet.vintageSet,
  snapshot: ctx.snapshot.datasetSnapshot,
}));
const EMPTY = withEmptyMacroL4BI1Fixture((ctx) => ({
  snapshot: ctx.snapshot.datasetSnapshot,
}));

let vectorCount = 0;
function vector(label, run) {
  vectorCount += 1;
  test(`oracle vector ${vectorCount}: ${label}`, run);
}

/* Vectors 1-5: series identity projection. */
for (const key of Object.keys(P.series)) {
  vector(`series identity projection for ${key}`, () => {
    assert.equal(oracleSeriesIdentityId(P.series[key].value), P.series[key].id);
  });
}

/* Vectors 6-10: observation identity projection. */
for (const key of Object.keys(P.observations)) {
  vector(`observation identity projection for ${key}`, () => {
    assert.equal(oracleObservationIdentityId(P.observations[key].value),
      P.observations[key].id);
  });
}

/* Vectors 11-19: vintage temporal identity projection. */
for (const key of Object.keys(P.vintages)) {
  vector(`vintage identity projection for ${key}`, () => {
    const content = P.vintages[key];
    assert.equal(oracleVintageIdentityId({
      observationIdentityId: content.observationIdentityId,
      availableAt: content.availableAt,
      vintageSequence: content.vintageSequence,
      sourceDocumentId: content.sourceDocumentId,
    }), content.macroVintageIdentityId);
  });
}

/* Vectors 20-22: ordered digests against the pinned snapshot. */
vector('ordered vintage identity digest', () => {
  const flat = macroVintageSetFlatEntriesV1(P.vintageSet.orderedObservationEntries);
  assert.equal(oracleOrderedDigest(flat.map((entry) => entry.macroVintageIdentityId)),
    P.snapshot.orderedVintageIdentityDigest);
});
vector('ordered observation identity digest', () => {
  assert.equal(oracleOrderedDigest(P.vintageSet.orderedObservationEntries
    .map((entry) => entry.observationIdentityId)),
  P.snapshot.orderedObservationIdentityDigest);
});
vector('ordered series identity digest', () => {
  assert.equal(oracleOrderedDigest(P.registryEntries
    .map((entry) => entry.macroSeriesIdentityId)),
  P.snapshot.orderedSeriesIdentityDigest);
});

/* Vectors 23-24: empty digests. */
vector('empty observation digest equals the digest of []', () => {
  assert.equal(oracleOrderedDigest([]), EMPTY.snapshot.orderedObservationIdentityDigest);
});
vector('empty vintage digest equals the digest of []', () => {
  assert.equal(oracleOrderedDigest([]), EMPTY.snapshot.orderedVintageIdentityDigest);
});

/* Vectors 25-27: counts and availableAt bounds. */
{
  const flat = macroVintageSetFlatEntriesV1(P.vintageSet.orderedObservationEntries);
  const recomputed = oracleCountsAndBounds(flat);
  vector('vintage count', () => {
    assert.equal(recomputed.vintageCount, P.snapshot.vintageCount);
  });
  vector('firstAvailableAt bound', () => {
    assert.equal(recomputed.firstAvailableAt, P.snapshot.firstAvailableAt);
  });
  vector('lastAvailableAt bound', () => {
    assert.equal(recomputed.lastAvailableAt, P.snapshot.lastAvailableAt);
  });
}

/* Vector 28: canonical total ordering reproduces the pinned order. */
vector('canonical ordering of shuffled flat entries', () => {
  const flat = macroVintageSetFlatEntriesV1(P.vintageSet.orderedObservationEntries);
  const shuffled = [...flat].reverse();
  const middle = shuffled.splice(Math.floor(shuffled.length / 2), 1);
  shuffled.unshift(...middle);
  const ordered = shuffled.sort(oracleCompareVintages);
  assert.deepEqual(ordered.map((entry) => entry.observationVintageId),
    P.vintageSet.orderedVintageIds);
});

/* Vectors 29-30: series tips. */
vector('series tips of the official registry', () => {
  const { tips, duplicateActiveCodes } = oracleSeriesTips(P.registryEntries);
  assert.deepEqual(duplicateActiveCodes, []);
  assert.deepEqual(tips, Object.fromEntries(P.registryEntries
    .filter((entry) => entry.status === 'ACTIVE')
    .map((entry) => [entry.canonicalSeriesCode, entry.macroSeriesIdentityId])
    .sort()));
});
vector('duplicate ACTIVE tips are surfaced', () => {
  const twin = { ...P.registryEntries[0], macroSeriesIdentityId: `sha256:${'a'.repeat(64)}` };
  const { duplicateActiveCodes } = oracleSeriesTips([...P.registryEntries, twin]);
  assert.deepEqual(duplicateActiveCodes, [P.registryEntries[0].canonicalSeriesCode]);
});

/* Vectors 31-34: replacement cycles. */
const ID = (letter) => `sha256:${letter.repeat(64)}`;
function replacementEntry(id, supersedes) {
  return { macroSeriesIdentityId: ID(id), canonicalSeriesCode: `US.TEST.${id.toUpperCase()}`,
    status: 'REPLACED', supersedesSeriesIdentityId: supersedes === null ? null : ID(supersedes),
    replacementReason: 'METHODOLOGY_CHANGE' };
}
vector('acyclic replacement chain is accepted', () => {
  assert.equal(oracleHasReplacementCycle([
    replacementEntry('a', 'b'), replacementEntry('b', 'c'), replacementEntry('c', null),
  ]), false);
});
vector('self replacement is a cycle', () => {
  assert.equal(oracleHasReplacementCycle([replacementEntry('a', 'a')]), true);
});
vector('replacement cycle of length 2', () => {
  assert.equal(oracleHasReplacementCycle([
    replacementEntry('a', 'b'), replacementEntry('b', 'a'),
  ]), true);
});
vector('replacement cycle of length 3', () => {
  assert.equal(oracleHasReplacementCycle([
    replacementEntry('a', 'b'), replacementEntry('b', 'c'), replacementEntry('c', 'a'),
  ]), true);
});

/* Vectors 35-43: vintage parent graph classification. */
function graphVintage(sequence, parentSequence, overrides = {}) {
  return {
    macroVintageIdentityId: ID(String(sequence)),
    vintageSequence: sequence,
    parentVintageId: parentSequence === null ? null : ID(String(parentSequence)),
    revisionKind: sequence === 0 ? 'INITIAL' : 'REVISION',
    availableAt: `2026-0${1 + (sequence % 8)}-06T14:00:00.000Z`,
    ...overrides,
  };
}
vector('a single causal chain has no defect', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, 0), graphVintage(2, 1),
  ]), null);
});
vector('two INITIAL vintages are refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, null, { revisionKind: 'INITIAL' }),
  ]), 'MULTIPLE_INITIAL');
});
vector('duplicate identity is refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, 0, { macroVintageIdentityId: ID('0') }),
  ]), 'DUPLICATE_IDENTITY');
});
vector('duplicate sequence is refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, 0),
    graphVintage(1, 0, { macroVintageIdentityId: ID('e') }),
  ]), 'DUPLICATE_SEQUENCE');
});
vector('self parent is refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, 1),
  ]), 'SELF_CYCLE');
});
vector('missing parent is refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, 7),
  ]), 'PARENT_MISSING');
});
vector('non-increasing sequence is refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, 2), graphVintage(2, 1),
  ]), 'SEQUENCE_NOT_INCREASING');
});
vector('decreasing availableAt is refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null, { availableAt: '2026-03-06T14:00:00.000Z' }),
    graphVintage(1, 0, { availableAt: '2026-02-06T14:00:00.000Z' }),
  ]), 'AVAILABLE_AT_DECREASING');
});
vector('two branches from one parent are refused', () => {
  assert.equal(oracleVintageGraphDefect([
    graphVintage(0, null), graphVintage(1, 0), graphVintage(2, 0),
  ]), 'BRANCH_CONFLICT');
});

/* Vectors 44-45: identity/content conflicts. */
vector('two different contents under one identity is a conflict', () => {
  const base = P.vintages.effrInitial;
  assert.equal(oracleHasIdentityContentConflict([
    base, { ...base, value: { atoms: '499', scale: 2 } },
  ]), true);
});
vector('byte-identical duplicates are not a semantic conflict', () => {
  const base = P.vintages.effrInitial;
  assert.equal(oracleHasIdentityContentConflict([base, { ...base }]), false);
});

/* Vectors 46-48: append-only preservation. */
{
  const flat = macroVintageSetFlatEntriesV1(P.vintageSet.orderedObservationEntries);
  vector('a superset preserving history is append-only', () => {
    const extended = [...flat, { ...flat[0], observationVintageId: ID('f'),
      macroVintageIdentityId: ID('e'), vintageSequence: 9 }];
    assert.equal(oracleAppendOnlyPreserved(flat, extended), true);
  });
  vector('deleting one historical entry violates append-only', () => {
    assert.equal(oracleAppendOnlyPreserved(flat, [...flat.slice(1), flat[0], flat[0]]), true);
    assert.equal(oracleAppendOnlyPreserved(flat, flat.slice(1)), false);
  });
  vector('mutating one historical entry violates append-only', () => {
    const mutated = flat.map((entry, index) => (index === 0
      ? { ...entry, availableAt: '2030-01-01T00:00:00.000Z' } : entry));
    assert.equal(oracleAppendOnlyPreserved(flat, mutated), false);
  });
}

/* Static isolation guard. */
test('oracle static isolation guard: no production L4B-I1 imports', () => {
  const source = readFileSync(
    new URL('./helpers/independentMacroIngestionOracleL4BV1.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['src/macro/', 'macroIngestionContractsL4BV1',
    'macroIngestionL4BSyntheticFixture', 'contentAddressedStoreV1',
    'canonicalSchemaRegistryV1', 'import(']) {
    assert.equal(source.includes(forbidden), false,
      `oracle must not reference ${forbidden}`);
  }
  const imports = source.match(/from '[^']+'/g) ?? [];
  assert.deepEqual(imports.sort(), [
    "from '../../src/canonical/canonicalJsonV1.mjs'",
    "from 'node:crypto'",
  ]);
});

test('oracle vector count is exactly 48', () => {
  assert.equal(vectorCount, 48);
});

/* Silence the unused-helper warning surface: hash primitive sanity. */
test('oracle hash primitive matches the CAS sha256 convention', () => {
  assert.match(oracleCanonicalHash({ schemaVersion: 'X/1' }), /^sha256:[0-9a-f]{64}$/);
});
