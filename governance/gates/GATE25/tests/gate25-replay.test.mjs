/**
 * GATE25 replay tests.
 *
 * Identical inputs replay to identical identities, reports, selections, outcome
 * sets, index bytes and provenance bytes. The canonical index is byte-stable and
 * append-only, provenance binds the exact index SHA-256, page ordering is stable
 * whatever order results arrive in, and outcomes are attached only after selection
 * and never alter the selected analogue set. No randomness, no wall clock.
 */

import assert from 'node:assert/strict';

import { sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  analogueIndexSha256,
  appendIndexRecord,
  mergeAnalogueIndexBytes,
  paginateQueryResults,
  parseAnalogueIndex,
  rankQueryResults,
  serializeAnalogueIndex,
} from '../implementation/analogue-index-v1.mjs';
import { verifyProvenanceIndexBinding } from '../implementation/analogue-provenance-v1.mjs';
import {
  buildAnalogueIndexFromCandidates,
  buildSelectionProvenance,
  materializeCanonicalProducts,
} from '../implementation/historical-analogue-engine-v1.mjs';
import {
  canonicalOrder,
  fail,
  fixtureCandidate,
  fixtureOutcomeSource,
  fixturePolicy,
  referenceCandidates,
  runFixture,
} from './gate25-foundation.test.mjs';

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

/** Full product replay from freshly built inputs: selection, index, provenance. */
function replayOnce(candidateFactory, outcomeSource = fixtureOutcomeSource()) {
  const candidates = candidateFactory();
  const selection = runFixture({ candidates, outcomeSource });
  const built = buildAnalogueIndexFromCandidates({ policy: fixturePolicy(), candidates: canonicalOrder(candidateFactory()) });
  const indexText = serializeAnalogueIndex(built.index);
  const provenance = buildSelectionProvenance({ selection, policy: fixturePolicy(), indexText });
  return { selection, built, indexText, provenance };
}

/* ------------------------------------------------------------------ T1 identical replay */

const first = replayOnce(referenceCandidates);
const second = replayOnce(referenceCandidates);
check(() => assert.equal(first.selection.queryIdentity.analogueIdentityId, second.selection.queryIdentity.analogueIdentityId));
check(() => assert.equal(first.selection.supportReportId, second.selection.supportReportId));
check(() => assert.equal(first.selection.comparisonReportId, second.selection.comparisonReportId));
check(() => assert.equal(first.selection.frozenSelection.selectionDigest, second.selection.frozenSelection.selectionDigest));
check(() => assert.equal(first.selection.outcomeSet.outcomeSetId, second.selection.outcomeSet.outcomeSetId));
check(() => assert.equal(first.selection.accounting.decisionDigest, second.selection.accounting.decisionDigest));
check(() => assert.deepEqual(first.selection.comparisonReport, second.selection.comparisonReport));
check(() => assert.deepEqual(first.selection.supportReport, second.selection.supportReport));
check(() => assert.equal(sha256Canonical(first.selection.analogueIndexRecords), sha256Canonical(second.selection.analogueIndexRecords)));
check(() => assert.equal(first.indexText, second.indexText));
check(() => assert.equal(first.provenance.text, second.provenance.text));
check(() => assert.equal(sha256Bytes(Buffer.from(first.provenance.text, 'utf8')), sha256Bytes(Buffer.from(second.provenance.text, 'utf8'))));
/* Independent recomputation of the published digests. */
check(() => assert.equal(first.selection.supportReportId, sha256Canonical(first.selection.supportReport)));
check(() => assert.equal(first.selection.comparisonReportId, sha256Canonical(first.selection.comparisonReport)));

/* ------------------------------------------------------------ canonical index bytes */

check(() => assert.equal(first.built.accounting.indexedCount, 5));
check(() => assert.equal(first.built.accounting.notFormableCount, 0));
check(() => assert.equal(serializeAnalogueIndex(parseAnalogueIndex(first.indexText)), first.indexText));
check(() => assert.equal(mergeAnalogueIndexBytes({ existingText: first.indexText, index: second.built.index }), first.indexText));
check(() => assert.equal(mergeAnalogueIndexBytes({ existingText: null, index: first.built.index }), first.indexText));
const parsedIndex = JSON.parse(first.indexText);
check(() => assert.deepEqual(Object.keys(parsedIndex).sort(), ['datasetId', 'pageSize', 'recordCount', 'records', 'schema', 'selectionPolicyVersionId']));
check(() => assert.equal(parsedIndex.pageSize, 100));
check(() => assert.equal(parsedIndex.recordCount, 5));
check(() => assert.deepEqual(parsedIndex.records.map((record) => record.analogueIdentityId), [...parsedIndex.records.map((record) => record.analogueIdentityId)].sort()));
check(() => assert.ok(!first.indexText.includes('\n')));
/* Selection-time analogue records are byte-identical to the persisted index records. */
check(() => assert.equal(sha256Canonical(first.selection.analogueIndexRecords), sha256Canonical(parsedIndex.records)));
/* Append-only growth: new records append, existing bytes are preserved record by record. */
const grownIndex = buildAnalogueIndexFromCandidates({ policy: fixturePolicy(), candidates: canonicalOrder([...referenceCandidates(), fixtureCandidate({ index: 120, w5: 0.03, w21: 0.07 })]) });
const mergedText = mergeAnalogueIndexBytes({ existingText: first.indexText, index: grownIndex.index });
const merged = JSON.parse(mergedText);
check(() => assert.equal(merged.recordCount, 6));
check(() => assert.ok(parsedIndex.records.every((record) => merged.records.some((item) => sha256Canonical(item) === sha256Canonical(record)))));
check(() => assert.equal(mergeAnalogueIndexBytes({ existingText: mergedText, index: first.built.index }), mergedText));
/* Divergent replacement of the same governed identity fails closed. */
const divergent = { ...parsedIndex.records[0], p3hKeyId: 'GATE25_FIXTURE_P3H/INSTRUMENT_B' };
check(() => fail(() => appendIndexRecord(first.built.index, divergent), 'INDEX_DIVERGENT_REPLACEMENT_REFUSED'));

/* ------------------------------------------------------- provenance index SHA binding */

check(() => assert.equal(first.provenance.manifest.analogueIndexSha256, analogueIndexSha256(first.indexText)));
check(() => assert.equal(first.provenance.manifest.analogueIndexSha256, sha256Bytes(Buffer.from(first.indexText, 'utf8'))));
check(() => assert.equal(verifyProvenanceIndexBinding({ provenanceText: first.provenance.text, indexText: first.indexText }).index.records.size, 5));
check(() => fail(() => verifyProvenanceIndexBinding({ provenanceText: first.provenance.text, indexText: mergedText }), 'PROVENANCE_INDEX_SHA256_MISMATCH'));
check(() => assert.equal(first.provenance.manifest.eligibleUniverseCount, first.selection.supportReport.eligibleCount));
check(() => assert.equal(first.provenance.manifest.supportReportId, first.selection.supportReportId));

const memoryStore = () => {
  const files = new Map();
  return { files, read: (path) => files.get(path) ?? null, write: (path, text) => files.set(path, text) };
};
const store = memoryStore();
const productsA = materializeCanonicalProducts({ store, index: first.built.index, selection: first.selection, policy: fixturePolicy() });
const productsB = materializeCanonicalProducts({ store, index: second.built.index, selection: second.selection, policy: fixturePolicy() });
check(() => assert.equal(productsA.indexText, productsB.indexText));
check(() => assert.equal(productsA.provenanceText, productsB.provenanceText));
check(() => assert.equal(productsA.analogueIndexSha256, productsB.analogueIndexSha256));
check(() => assert.equal(productsA.provenanceSha256, productsB.provenanceSha256));
check(() => assert.deepEqual([...store.files.keys()].sort(), ['data/jarvise/historical-analogue/GATE25/V1/ANALOGUE_INDEX.json', 'data/jarvise/historical-analogue/GATE25/V1/PROVENANCE.json']));

/* -------------------------------------------------------------- page ordering stability */

const synthetic = Array.from({ length: 250 }, (_, index) => ({
  analogueIdentityId: sha256Canonical({ entry: index }),
  sessionDate: `2025-01-${String((index % 28) + 1).padStart(2, '0')}`,
  finalDistance: (index % 7) / 7,
}));
const permutations = [
  synthetic,
  [...synthetic].reverse(),
  [...synthetic.slice(125), ...synthetic.slice(0, 125)],
  synthetic.filter((_, index) => index % 2 === 0).concat(synthetic.filter((_, index) => index % 2 === 1)),
];
const rankedViews = permutations.map((entries) => rankQueryResults(entries));
for (const view of rankedViews.slice(1)) check(() => assert.deepEqual(view, rankedViews[0]));
const pages = [0, 1, 2].map((pageIndex) => paginateQueryResults(rankedViews[0], pageIndex));
check(() => assert.deepEqual(pages.map((page) => page.entries.length), [100, 100, 50]));
check(() => assert.ok(pages.every((page) => page.pageCount === 3 && page.totalCount === 250 && page.pageSize === 100)));
check(() => assert.deepEqual(pages.flatMap((page) => page.entries), [...rankedViews[0]]));
check(() => assert.deepEqual(pages[1].entries.map((entry) => entry.rank), Array.from({ length: 100 }, (_, index) => 101 + index)));
check(() => fail(() => paginateQueryResults(rankedViews[0], 3), 'PAGE_INDEX_OUT_OF_RANGE'));

/* Engine-level: more than one page of real selections, stable across two runs. */
const manyCandidates = () => Array.from({ length: 130 }, (_, offset) => fixtureCandidate({
  index: 60 + offset,
  w5: ((offset * 37) % 101) / 1000,
  w21: 0.05 + ((offset * 53) % 97) / 1000,
}));
const manyA = runFixture({ candidates: manyCandidates() });
const manyB = runFixture({ candidates: manyCandidates() });
check(() => assert.equal(manyA.supportReport.eligibleCount, 130));
check(() => assert.equal(manyA.comparisonReport.analogues.length, 130));
const enginePagesA = [0, 1].map((pageIndex) => paginateQueryResults(manyA.comparisonReport.analogues, pageIndex));
const enginePagesB = [0, 1].map((pageIndex) => paginateQueryResults(manyB.comparisonReport.analogues, pageIndex));
check(() => assert.deepEqual(enginePagesA, enginePagesB));
check(() => assert.deepEqual(enginePagesA.map((page) => page.entries.length), [100, 30]));
check(() => assert.equal(enginePagesA[1].entries[0].rank, 101));

/* ------------------------------------------ outcomes attached only after selection */

const ids = first.selection.comparisonReport.analogues.map((entry) => entry.analogueIdentityId);
const horizonIds = first.selection.horizonBindings.map((binding) => binding.horizonId);
const valuesHigh = new Map(ids.flatMap((id) => horizonIds.map((horizonId) => [`${id}|${horizonId}`, 0.5])));
const valuesLow = new Map(ids.flatMap((id, rank) => horizonIds.map((horizonId) => [`${id}|${horizonId}`, -0.5 - rank])));
const sourceHigh = fixtureOutcomeSource({ values: valuesHigh });
const sourceLow = fixtureOutcomeSource({ values: valuesLow });
const withHigh = runFixture({ candidates: referenceCandidates(), outcomeSource: sourceHigh });
const withLow = runFixture({ candidates: referenceCandidates(), outcomeSource: sourceLow });
const withNone = runFixture({ candidates: referenceCandidates(), outcomeSource: fixtureOutcomeSource() });
for (const [name, run] of [['high', withHigh], ['low', withLow], ['none', withNone]]) {
  check(() => assert.equal(run.frozenSelection.selectionDigest, first.selection.frozenSelection.selectionDigest, name));
  check(() => assert.equal(run.comparisonReportId, first.selection.comparisonReportId, name));
  check(() => assert.equal(run.supportReportId, first.selection.supportReportId, name));
  check(() => assert.equal(run.accounting.decisionDigest, first.selection.accounting.decisionDigest, name));
  check(() => assert.deepEqual(run.normalizationBounds, first.selection.normalizationBounds, name));
  check(() => assert.equal(sha256Canonical(run.analogueIndexRecords), sha256Canonical(first.selection.analogueIndexRecords), name));
}
check(() => assert.notEqual(withHigh.outcomeSet.outcomeSetId, withLow.outcomeSet.outcomeSetId));
check(() => assert.ok(withHigh.outcomeSet.records.every((record) => record.outcomeStatus === 'AVAILABLE' && record.outcomeValue === 0.5)));
check(() => assert.ok(withNone.outcomeSet.records.every((record) => record.outcomeStatus === 'MISSING' && record.outcomeValue === null)));
check(() => assert.equal(withHigh.outcomeSet.selectionDigest, withHigh.frozenSelection.selectionDigest));
/* Lookups happen once per frozen analogue per admissible horizon, in rank then horizon order. */
check(() => assert.deepEqual(sourceHigh.calls, ids.flatMap((id) => horizonIds.map((horizonId) => `${id}|${horizonId}`))));
check(() => assert.equal(Object.isFrozen(withHigh.frozenSelection), true));
check(() => assert.equal(withHigh.frozenSelection.selectionComplete, true));
check(() => assert.ok(withHigh.outcomeSet.records.every((record) => record.selectionComplete === true)));

console.log(`GATE25_REPLAY_PASS ${assertions}`);
