/**
 * GATE26 PHASE D — positive proof for the real production producer.
 *
 * This file executes the real producer against the real published inputs. Nothing
 * here is mocked, stubbed or seeded: the preparation reads the frozen P3H dataset,
 * the published historical regime foundation and the 191 MB GATE25 analogue index,
 * and the equivalence case is decided by running the canonical GATE25 selection over
 * the full candidate stream and comparing it byte-for-byte with the indexed result.
 * It is slow for that reason — roughly six minutes — and that is the point: a fast
 * version of this test would be a test of a fixture, not of the producer.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE. The paged pilot's own measurements — per
 * page-pair bytes, page timings, the 536-pair projection — and the real recovery cases
 * are not restated here. They are produced by running the pilot and the recovery
 * harness against external durable evidence, and pinning their numbers in this file
 * would duplicate a proof rather than strengthen it. What this file does assert is the
 * producer itself: its identity, the boundedness of its preparation, its complexity,
 * its reproduction of the frozen support distribution, and its equivalence to the
 * canonical GATE25 selection. Nothing here substitutes a weaker proof for a stronger
 * one that lives elsewhere.
 *
 * No threshold is redefined by this test. Every limit it checks is read from the
 * published GATE26_FULL_RESOURCE_BUDGET_V1 binding rather than restated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes } from '../../../tools/canonical-json.mjs';
import { computeCodeIdentity } from '../implementation/full-checkpoint-v1.mjs';
import { installNetworkTrap } from '../implementation/mini-fixture-v1.mjs';
import { R0003_CONTRACT_PATH } from '../implementation/full-query-cohort-v1.mjs';
import { ensembleCacheSize } from '../implementation/predictive-ensemble-engine-v1.mjs';
import {
  EXPECTED_SUPPORT_DISTRIBUTION_V1, REAL_PRODUCER_CLASS_V1, REAL_PRODUCER_ID_V1,
  fullStartRamPreconditionState, loadResourceBudget, prepareRealProductionProducer, runCanonicalFullBuild, verifyProducerIdentity,
} from '../implementation/full-production-producer-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTRACT = JSON.parse(fs.readFileSync(path.resolve(ROOT, R0003_CONTRACT_PATH), 'utf8'));
const FULL_ROOT = path.resolve(ROOT, CONTRACT.packagingRequirements.fullProductRoot);
// R0006: the FULL root may hold only the exact enumerated canonical pathset; nothing a test runs may add to it.
const CANONICAL_FULL_NAMES = new Set(CONTRACT.authorizedPaths
  .filter((file) => file.startsWith(`${CONTRACT.packagingRequirements.fullProductRoot}/`))
  .map((file) => file.slice(CONTRACT.packagingRequirements.fullProductRoot.length + 1)));
const assertNoNonCanonicalFullBytes = () => {
  if (!fs.existsSync(FULL_ROOT)) return;
  for (const entry of fs.readdirSync(FULL_ROOT, { withFileTypes: true })) {
    assert.ok(entry.isFile() && CANONICAL_FULL_NAMES.has(entry.name), `no non-canonical FULL product path may exist: ${entry.name}`);
  }
};
const networkCalls = installNetworkTrap();
const LIMITS = loadResourceBudget({ root: ROOT }).limits;

/**
 * Frozen expectations of the bounded projection over the published universe. These are
 * properties of the pinned dataset, not of this machine, so they are exact.
 */
const EXPECTED_BOUNDED_PROJECTION = Object.freeze({
  foundationProjectionsComputed: 68562,
  foundationProjectionsRefused: 429,
  foundationBarReads: 793,
  retainedFoundationProjectionEntries: 0,
  foundationProjectionPassCount: 0,
  universeFullScanCount: 2,
  perQueryUniverseFullScanCount: 0,
  eligibilityAccountingCandidates: 1750766,
  indexedRecordsPrepared: 68562,
  groupCount: 18988,
});

// Prepared once. Every test below reads this same preparation, because preparing twice
// would double a six-minute cost to prove nothing new.
let producer = null;
const prepared = () => {
  producer ??= prepareRealProductionProducer({ root: ROOT, retainOracleUniverse: true, maxOracleQueries: 4 });
  return producer;
};

test('the producer is the real one, and its published binding verifies against the bytes on disk', () => {
  const identity = verifyProducerIdentity({ root: ROOT });
  assert.equal(identity.verified, true);
  assert.ok(identity.dependencies.length > 0);
  assert.ok(identity.frozenInputs.length > 0);
  // R0006 V2 successor: the same real producer, now bound to the CANONICAL_FULL intent.
  assert.equal(identity.bindings.fullGenerationAuthorized, true);
  assert.equal(identity.bindings.executionIntent, 'CANONICAL_FULL');
  assert.equal(identity.bindings.networkAuthorized, false);
  assert.equal(identity.bindings.yahooAuthorized, false);

  const p = prepared();
  assert.equal(p.producerId, REAL_PRODUCER_ID_V1);
  assert.equal(p.productionClass, REAL_PRODUCER_CLASS_V1);
  assert.equal(p.synthetic, false);
  assert.equal(p.producerCodeSha256, identity.producerIdentitySha256);
});

test('the foundation projection is bounded: nothing is retained, and bars are read once per key', () => {
  const c = prepared().counters;
  // The repair this asserts: the projection is computed on demand and released, so the
  // count of retained projected entries is zero rather than one per admitted pair.
  assert.equal(c.retainedFoundationProjectionEntries, EXPECTED_BOUNDED_PROJECTION.retainedFoundationProjectionEntries);
  assert.equal(c.foundationProjectionPassCount, EXPECTED_BOUNDED_PROJECTION.foundationProjectionPassCount);
  assert.equal(c.foundationProjectionsComputed, EXPECTED_BOUNDED_PROJECTION.foundationProjectionsComputed);
  assert.equal(c.foundationProjectionsRefused, EXPECTED_BOUNDED_PROJECTION.foundationProjectionsRefused);
  // One bar read per admitted key, not one per (key, session): the single-entry cache
  // reproduces exactly the reuse the original inner loop had.
  assert.equal(c.foundationBarReads, EXPECTED_BOUNDED_PROJECTION.foundationBarReads);
  assert.ok(c.foundationBarReads * 50 < c.foundationProjectionsComputed,
    'bar reads must be orders of magnitude below projections, or the cache is not reusing');
});

test('preparation stays inside every accepted memory limit, without depending on forced GC', () => {
  const c = prepared().counters;
  assert.equal(typeof global.gc, 'undefined', 'this proof must hold with no --expose-gc');

  // The startup RAM question is anchored to preparation entry, so it is answered by
  // the time preparation returns, exactly once, for every caller regardless of when
  // that caller builds its first resource guard.
  const startup = fullStartRamPreconditionState();
  assert.ok(startup !== null, 'preparation must have evaluated the startup precondition');
  assert.equal(startup.evaluated, true);
  assert.equal(startup.minimumBytes, LIMITS.minimumRamFreeAtFullStartBytes);
  assert.ok(startup.observedBytes >= LIMITS.minimumRamFreeAtFullStartBytes);
  assert.ok(c.rssPeakBytes > 0 && c.heapUsedPeakBytes > 0);
  assert.ok(c.rssPeakBytes <= LIMITS.maximumRssBeforeNextPairBytes,
    `peak RSS ${c.rssPeakBytes} exceeds ${LIMITS.maximumRssBeforeNextPairBytes}`);
  assert.ok(c.heapUsedPeakBytes <= LIMITS.maximumHeapUsedBytes,
    `peak heap ${c.heapUsedPeakBytes} exceeds ${LIMITS.maximumHeapUsedBytes}`);
  assert.ok(c.externalPeakBytes <= LIMITS.maximumExternalBytes,
    `peak external ${c.externalPeakBytes} exceeds ${LIMITS.maximumExternalBytes}`);
  assert.ok(ensembleCacheSize() <= LIMITS.maximumEngineCacheEntries);
});

test('complexity is bounded: no per-query universe scan, and setup stays inside its scan budget', () => {
  const c = prepared().counters;
  assert.equal(c.perQueryUniverseFullScanCount, EXPECTED_BOUNDED_PROJECTION.perQueryUniverseFullScanCount);
  assert.equal(c.universeFullScanCount, EXPECTED_BOUNDED_PROJECTION.universeFullScanCount);
  assert.ok(c.universeFullScanCount <= LIMITS.maximumUniverseFullScanCount);
  assert.equal(c.publishedIndexFullPassCount, 1);
  assert.equal(c.eligibilityAccountingCandidates, EXPECTED_BOUNDED_PROJECTION.eligibilityAccountingCandidates);
  assert.equal(c.indexedRecordsPrepared, EXPECTED_BOUNDED_PROJECTION.indexedRecordsPrepared);
  assert.equal(c.groupCount, EXPECTED_BOUNDED_PROJECTION.groupCount);

  // Querying does not scan: a handful of queries must not move the universe counters.
  const before = { universe: c.universeFullScanCount, perQuery: c.perQueryUniverseFullScanCount };
  for (const record of prepared().orderedRecords.slice(0, 64)) prepared().produceDetailed(record);
  assert.equal(c.universeFullScanCount, before.universe);
  assert.equal(c.perQueryUniverseFullScanCount, before.perQuery);
});

test('the measured support distribution reproduces the frozen expectation exactly', () => {
  const s = prepared().supportDistribution;
  const e = EXPECTED_SUPPORT_DISTRIBUTION_V1;
  for (const field of ['queryCount', 'zero', 'one', 'belowTwo', 'median', 'p95', 'p99', 'max']) {
    assert.equal(s[field], e[field], `support distribution drifted at ${field}`);
  }
  assert.equal(s.pages.length, 536);
  assert.equal(s.pages[e.worstPageNumber - 1].supportSum, e.worstPageSupportSum);
  // The structural ABSTAIN share is a property of the data, not a policy choice.
  assert.equal(s.zero + s.one, s.belowTwo);
});

test('the indexed producer is semantically identical to the canonical GATE25 slow oracle', () => {
  const p = prepared();
  // A PROCEED case at median support, so the comparison covers a real selection with
  // attached outcomes rather than two abstentions agreeing trivially.
  const record = p.orderedRecords.find((r) => p.supportCountById.get(r.analogueIdentityId) === 2);
  assert.ok(record, 'a median-support query must exist');

  const indexed = p.produceDetailed(record);
  const oracle = p.produceSlowOracle(record);

  assert.equal(indexed.combined.decision, oracle.combined.decision);
  assert.equal(canonicalize(indexed.supportReport), canonicalize(oracle.selection.supportReport));
  assert.equal(canonicalize(indexed.comparisonReport), canonicalize(oracle.selection.comparisonReport));
  assert.equal(canonicalize(indexed.outcomeSet), canonicalize(oracle.selection.outcomeSet));
  assert.equal(canonicalize(indexed.output.ensembleRecord), canonicalize(oracle.output.ensembleRecord));
  assert.equal(canonicalize(indexed.output.provenanceRecord), canonicalize(oracle.output.provenanceRecord));
  assert.equal(canonicalize(indexed.output), canonicalize(oracle.output));

  // The oracle is the slow path by construction; it must have scanned, and the indexed
  // path must not have.
  assert.ok(p.counters.boundedOracleUniverseScans >= 1);
  assert.equal(p.counters.perQueryUniverseFullScanCount, 0);
});

test('G26-POSTBUILD-NEG-01: the consumed R0006 authority admits no second canonical FULL build; the unchanged producer refuses it before writing', async () => {
  const pointer = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'governance/gates/GATE26/contracts/CURRENT_CONTRACT.json'), 'utf8'));
  const postbuild = JSON.parse(fs.readFileSync(path.resolve(ROOT, pointer.contractPath), 'utf8'))
    .canonicalRequirements.find((entry) => entry.requirementId === 'G26-POSTBUILD-01').binding;
  // R0008 carries G26-POSTBUILD-01 byte-identically from R0007.
  assert.equal(pointer.contractRevision, 'R0008');
  assert.deepEqual([postbuild.canonicalFullBuildsConsumed, postbuild.remainingCanonicalFullBuilds, postbuild.fullGenerationAuthorized], [1, 0, false]);
  const manifestBefore = sha256Bytes(fs.readFileSync(path.resolve(ROOT, postbuild.manifestPath)));
  const namesBefore = fs.readdirSync(FULL_ROOT).sort();
  const work = path.join(os.tmpdir(), 'wheel-gee', `gate26-postbuild-second-build-${process.pid}`);
  const roots = { checkpointRoot: path.join(work, 'checkpoint'), evidenceRoot: path.join(work, 'evidence') };
  for (const resume of [false, true]) {
    await assert.rejects(runCanonicalFullBuild({ root: ROOT, ...roots, resume }), (error) => error?.code === postbuild.expectedReplayRefusalCode, `resume=${resume}`);
  }
  assert.ok(!fs.existsSync(work), 'a refused second build writes no checkpoint or evidence');
  assert.equal(manifestBefore, postbuild.manifestSha256);
  assert.equal(sha256Bytes(fs.readFileSync(path.resolve(ROOT, postbuild.manifestPath))), manifestBefore);
  assert.deepEqual(fs.readdirSync(FULL_ROOT).sort(), namesBefore);
  assert.equal(namesBefore.length, postbuild.fullProductPathCount);
  // The audited code identity is still the one that produced the product.
  assert.equal(computeCodeIdentity({ root: ROOT }).sha256, postbuild.auditedCodeIdentitySha256);
  assert.equal(JSON.parse(fs.readFileSync(path.resolve(ROOT, postbuild.manifestPath), 'utf8')).producedUnder.codeIdentitySha256, postbuild.auditedCodeIdentitySha256);
});

test('no non-canonical FULL byte exists and no network or Yahoo call was attempted', () => {
  assertNoNonCanonicalFullBytes();
  assert.deepEqual(networkCalls, []);
  const budget = loadResourceBudget({ root: ROOT });
  assert.equal(budget.fullGenerationAuthorized, true);
  // Authorizing FULL loosened nothing: every limit is the byte-immutable V1 value.
  const v1 = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'governance/gates/GATE26/contracts/GATE26_FULL_RESOURCE_BUDGET_V1.json'), 'utf8'));
  assert.deepEqual(budget.limits, v1.limits);
  assert.equal(v1.fullGenerationAuthorized, false);
});
