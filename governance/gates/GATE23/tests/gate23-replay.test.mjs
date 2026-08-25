/**
 * GATE23 replay identity tests.
 *
 * Identical inputs replay to identical FeatureRecordIds, values and store digests.
 * A drift in any single identity-bearing binding moves the identity; a drift that
 * touches no identity member leaves it exactly where it was.
 */

import assert from 'node:assert/strict';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { materializeFeatureRecords } from '../implementation/feature-materializer-v1.mjs';
import { createFeatureStore, appendFeatureRecords, storeDigest } from '../implementation/feature-store-v1.mjs';
import { createFeatureRecordId } from '../implementation/feature-identity-v1.mjs';
import { memberKey } from '../implementation/feature-families-v1.mjs';
import { materializeFixture, buildFixtureInput } from '../fixtures/causal-window-fixture.mjs';
import { DRIFT_CASES } from '../fixtures/provenance-drift-fixture.mjs';

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

const first = materializeFixture();
const second = materializeFixture();
const ids = (result) => result.records.map((record) => record.featureRecordId);

/* Deterministic rematerialization. */
check(() => assert.deepEqual(ids(first), ids(second)));
check(() => assert.deepEqual(first.records.map((r) => r.value), second.records.map((r) => r.value)));
check(() => assert.deepEqual(first.records.map((r) => r.status), second.records.map((r) => r.status)));
check(() => assert.equal(first.knowledgeCutoff, second.knowledgeCutoff));
check(() => assert.equal(sha256Canonical(first.records.map((r) => r.identity)), sha256Canonical(second.records.map((r) => r.identity))));

/* Store digests replay identically and appending the same records twice is idempotent. */
const storeA = appendFeatureRecords(createFeatureStore(), first.records);
const storeB = appendFeatureRecords(createFeatureStore(), second.records);
check(() => assert.equal(storeDigest(storeA), storeDigest(storeB)));
check(() => assert.equal(storeA.records.length, first.records.length));
check(() => assert.equal(appendFeatureRecords(storeA, second.records).records.length, first.records.length));
check(() => assert.equal(storeDigest(appendFeatureRecords(storeA, second.records)), storeDigest(storeA)));

/* The digest is canonical: member insertion order never changes the identity. */
const identity = first.records[0].identity;
const reordered = Object.fromEntries([...Object.entries(identity)].reverse());
check(() => assert.equal(createFeatureRecordId(reordered), createFeatureRecordId(identity)));
check(() => assert.equal(createFeatureRecordId(identity), first.records[0].featureRecordId));

/* Identity moves only for a drift in an identity member. */
const baseline = new Map(first.records.map((record) => [memberKey(record), record.featureRecordId]));
for (const driftCase of DRIFT_CASES) {
  const drifted = materializeFeatureRecords(driftCase.build());
  check(() => assert.ok(drifted.records.length > 0, driftCase.id));
  for (const record of drifted.records) {
    const before = baseline.get(memberKey(record));
    check(() => (driftCase.identityMoves
      ? assert.notEqual(record.featureRecordId, before, `${driftCase.id} should move the identity`)
      : assert.equal(record.featureRecordId, before, `${driftCase.id} should preserve the identity`)));
  }
}

/* A drift in the observed values alone never moves the identity, only the content. */
const restated = materializeFeatureRecords(buildFixtureInput({}));
check(() => assert.deepEqual(ids(restated), ids(first)));

console.log(`GATE23_REPLAY_PASS ${assertions}`);
