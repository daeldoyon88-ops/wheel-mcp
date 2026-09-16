/**
 * GATE26 hostile frontier H01-H21 plus the F2/F3 negative controls.
 *
 * Consumer hostiles run against the REAL serialized MINI product bytes on disk. A
 * hostile product is produced by tampering one field and then re-sealing every
 * digest an attacker could recompute, so each refusal is attributable to the one
 * check it targets. The re-seal helper is itself proven byte-faithful first.
 * Nothing here writes to the repository.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { publicationTempPath } from '../../../tools/durable-write.mjs';
import { fixtureCandidate, fixtureQuery, referenceCandidates, runFixture } from '../../GATE25/tests/gate25-foundation.test.mjs';
import { createEnsembleIdentity } from '../implementation/ensemble-identity-v1.mjs';
import { refuseProbabilityClaim } from '../implementation/combination-policy-v1.mjs';
import { assertAdmissibleHorizon, buildHorizonRecord, MULTI_HORIZON_OUTPUT_SCHEMA_V1 } from '../implementation/ensemble-record-v1.mjs';
import {
  ENSEMBLE_INDEX_PRODUCT_PATH_V1, PROVENANCE_PRODUCT_PATH_V1, appendEnsembleRecord, createEnsembleIndex, serializeEnsembleIndex,
  verifyProvenanceBinding, LFS_THRESHOLD_BYTES_V1,
} from '../implementation/ensemble-provenance-v1.mjs';
import { consumeEnsemble, consumePublishedEnsemble, refuseWheelScanInlineCompute } from '../implementation/consumption-boundary-v1.mjs';
import {
  combineFrozenSelection, loadGate26MiniBuildAuthority, readEnsembleCache, writeEnsembleCache,
} from '../implementation/predictive-ensemble-engine-v1.mjs';
import { MINI_PRODUCT_PATHS_V1, REHEARSAL_REPORT_PATH_V1 } from '../implementation/mini-fixture-v1.mjs';
import { fixtureInputBinding, mixedSelection } from './gate26-foundation.test.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const authority = loadGate26MiniBuildAuthority({ root: ROOT });
const policyVersionId = authority.policy.combinationPolicyVersionId;

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };
const refuse = (fn, code) => check(() => assert.throws(fn, (error) => error?.code === code, `expected ${code}`));

/* ------------------------------------------------------------- real product */

const indexBytes = readFileSync(resolve(ROOT, ENSEMBLE_INDEX_PRODUCT_PATH_V1));
const provenanceBytes = readFileSync(resolve(ROOT, PROVENANCE_PRODUCT_PATH_V1));
const rehearsal = readJson(REHEARSAL_REPORT_PATH_V1);
const published = JSON.parse(indexBytes.toString('utf8'));
const publishedProvenance = JSON.parse(provenanceBytes.toString('utf8'));
const declared = { expectedIndexSha256: rehearsal.publication.indexSha256, expectedProvenanceSha256: rehearsal.publication.provenanceSha256 };

/* Target records chosen from execution evidence, not from the records themselves. */
const caseRecord = (predicate) => {
  const evidence = publishedProvenance.queryCases.find(predicate);
  assert.ok(evidence?.ensembleIdentityId, 'expected a published record for the evidence case');
  return evidence.ensembleIdentityId;
};
const withAnalogues = caseRecord((item) => item.execution === 'SELECTION_COMPLETED' && item.accounting.eligibleCount >= 2);
const withoutAnalogues = caseRecord((item) => item.execution === 'SELECTION_COMPLETED' && item.accounting.eligibleCount < 2);

const clone = () => ({ index: JSON.parse(indexBytes.toString('utf8')), provenance: JSON.parse(provenanceBytes.toString('utf8')) });
const recordOf = (product, id) => product.index.records.find((record) => record.ensembleIdentityId === id);
const manifestOf = (product, id) => product.provenance.records.find((manifest) => manifest.ensembleIdentityId === id);

/** Re-derives every digest an attacker controls: manifest provenanceIds (optional), index bytes, product binding, both SHA-256s. */
function seal(product, { resealManifests = true } = {}) {
  if (resealManifests) {
    for (const manifest of product.provenance.records) {
      const { provenanceId: previous, ...fields } = manifest;
      manifest.provenanceId = sha256Canonical(fields);
      for (const record of product.index.records) {
        if (record.ensembleIdentityId !== manifest.ensembleIdentityId || record.provenanceId !== previous) continue;
        record.provenanceId = manifest.provenanceId;
        for (const horizon of record.horizons ?? []) {
          if (horizon?.provenanceBinding?.provenanceId === previous) horizon.provenanceBinding.provenanceId = manifest.provenanceId;
        }
      }
    }
  }
  product.index.recordCount = product.index.records.length;
  const sealedIndex = Buffer.from(`${canonicalize(product.index)}\n`, 'utf8');
  product.provenance.product.ensembleIndexSha256 = sha256Bytes(sealedIndex);
  product.provenance.product.ensembleIndexByteLength = sealedIndex.length;
  product.provenance.product.recordCount = product.index.recordCount;
  const sealedProvenance = Buffer.from(`${JSON.stringify(product.provenance, null, 2)}\n`, 'utf8');
  return { indexBytes: sealedIndex, provenanceBytes: sealedProvenance, expectedIndexSha256: sha256Bytes(sealedIndex), expectedProvenanceSha256: sha256Bytes(sealedProvenance) };
}
const consume = (sealed, ensembleIdentityId, extra = {}) => consumeEnsemble({ ...sealed, ensembleIdentityId, expectedCombinationPolicyVersionId: policyVersionId, ...extra });
const tamper = (id, mutate, options) => { const product = clone(); mutate(product, id); return seal(product, options); };

/* Baselines: the published bytes consume; an untampered re-seal is byte-identical. */
for (const record of published.records) {
  check(() => assert.ok(['CONSUME', 'ABSTAIN'].includes(consume({ indexBytes, provenanceBytes, ...declared }, record.ensembleIdentityId).decision)));
}
const faithful = seal(clone());
check(() => assert.equal(faithful.expectedIndexSha256, declared.expectedIndexSha256));
check(() => assert.equal(faithful.expectedProvenanceSha256, declared.expectedProvenanceSha256));

/* ----------------------------------------------------------- engine hostiles */

const selection = mixedSelection();
const inputBinding = fixtureInputBinding();

/* H01 missing analogue family */
check(() => assert.equal(combineFrozenSelection({ authority, selection: { ...selection, outcomeSet: null, frozenSelection: null }, inputBinding }).abstention.reason, 'PREDICTIVE_FAMILY_MISSING'));
refuse(() => combineFrozenSelection({ authority, selection: { ...selection, supportReport: null }, inputBinding }), 'DEGRADED_INPUT');

/* H02 injected conflicting family */
check(() => assert.equal(combineFrozenSelection({
  authority, selection, inputBinding, extraFamilies: [{ familyId: 'HOSTILE_SECOND_FAMILY', role: 'PREDICTIVE', signature: sha256Canonical('not-the-analogue-signature') }],
}).abstention.reason, 'REGISTERED_DISAGREEMENT'));

/* H03 eligibleCount < 2 */
check(() => assert.equal(combineFrozenSelection({
  authority, inputBinding, selection: runFixture({ candidates: [fixtureCandidate({ index: 150, w5: 0.01, w21: 0.06 })], query: fixtureQuery() }),
}).abstention.reason, 'INSUFFICIENT_SUPPORT'));

/* H04 malformed identity */
refuse(() => createEnsembleIdentity({ QueryAnalogueIdentityId: 'x' }), 'ENSEMBLE_IDENTITY_EXACT_ONLY');

/* H05 wrong engine version */
check(() => assert.equal(combineFrozenSelection({ authority, selection, inputBinding, engineVersion: 'GATE26_PredictiveEnsembleEngine/0' }).abstention.reason, 'STALE_OR_WRONG_VERSION'));

/* H06 wrong horizon */
refuse(() => assertAdmissibleHorizon(21), 'HORIZON_NOT_ADMISSIBLE');
refuse(() => combineFrozenSelection({ authority, inputBinding, selection: { ...selection, horizonBindings: selection.horizonBindings.slice(0, 3) } }), 'HORIZON_NOT_ADMISSIBLE');

/* H07 leakage: outcome before selectionComplete; outcome set bound to another selection */
refuse(() => combineFrozenSelection({ authority, inputBinding, selection: { ...selection, frozenSelection: { ...selection.frozenSelection, selectionComplete: false } } }), 'LEAKAGE_ATTEMPT');
refuse(() => combineFrozenSelection({ authority, inputBinding, selection: { ...selection, outcomeSet: { ...selection.outcomeSet, selectionDigest: '0'.repeat(64) } } }), 'LEAKAGE_ATTEMPT');

/* H08 publication SHA mismatch on real bytes */
refuse(() => consume({ indexBytes, provenanceBytes, ...declared, expectedIndexSha256: sha256Canonical('stale-index') }, withAnalogues), 'PRODUCT_BYTES_IDENTITY_MISMATCH');
refuse(() => consume({ indexBytes, provenanceBytes, ...declared, expectedProvenanceSha256: sha256Canonical('stale-provenance') }, withAnalogues), 'PRODUCT_BYTES_IDENTITY_MISMATCH');

/* H09 provenance mismatch */
refuse(() => verifyProvenanceBinding({ manifest: manifestOf(clone(), withAnalogues), ensembleIdentityId: withAnalogues, analogueIdentityIds: [sha256Canonical('not-an-analogue')] }), 'PROVENANCE_MISMATCH');

/* H10 stale cache never silent hit */
refuse(() => writeEnsembleCache(sha256Canonical('old'), {}, sha256Canonical('new')), 'STALE_CACHE_SILENT_HIT_FORBIDDEN');
check(() => assert.equal(readEnsembleCache(sha256Canonical('never-written')), null));

/* H11 partial artifact */
const truncated = indexBytes.subarray(0, Math.floor(indexBytes.length / 2));
refuse(() => consume({ indexBytes: truncated, provenanceBytes, ...declared, expectedIndexSha256: sha256Bytes(truncated) }, withAnalogues), 'PARTIAL_ARTIFACT_REFUSED');
refuse(() => consume({ indexBytes: Buffer.alloc(0), provenanceBytes, ...declared, expectedIndexSha256: sha256Bytes(Buffer.alloc(0)) }, withAnalogues), 'PARTIAL_ARTIFACT_REFUSED');

/* H12 identical replay idempotent; divergent refused — on published records */
check(() => {
  const record = recordOf(clone(), withAnalogues);
  const base = createEnsembleIndex({ engineVersion: published.engineVersion, combinationPolicyVersionId: published.combinationPolicyVersionId, horizonCoverageId: published.horizonCoverageId });
  const first = appendEnsembleRecord(base, record);
  assert.equal(appendEnsembleRecord(first, JSON.parse(canonicalize(record))).recordCount, first.recordCount);
});
refuse(() => {
  const record = recordOf(clone(), withAnalogues);
  const base = appendEnsembleRecord(createEnsembleIndex({ engineVersion: published.engineVersion, combinationPolicyVersionId: published.combinationPolicyVersionId, horizonCoverageId: published.horizonCoverageId }), record);
  appendEnsembleRecord(base, { ...record, decision: record.decision === 'PROCEED' ? 'ABSTAIN' : 'PROCEED' });
}, 'DIVERGENT_REPLAY_REFUSED');

/* H13 probability claim / extra field */
refuse(() => refuseProbabilityClaim({ calibratedProbability: 0.42 }), 'PROBABILITY_CLAIM_FORBIDDEN');
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).horizons[1].supportDerivedConfidence.calibratedProbability = 0.42; }), withAnalogues), 'PROBABILITY_CLAIM_FORBIDDEN');
refuse(() => buildHorizonRecord({ ...recordOf(clone(), withAnalogues).horizons[0], schema: MULTI_HORIZON_OUTPUT_SCHEMA_V1, extra: true }), 'ENSEMBLE_RECORD_NOT_CLOSED');

/* H14 consumer version mismatch -> ABSTAIN, never CONSUME */
check(() => assert.equal(consume({ indexBytes, provenanceBytes, ...declared }, withAnalogues, { expectedEngineVersion: 'GATE26_PredictiveEnsembleEngine/0' }).abstainReason, 'CONSUMER_VERSION_MISMATCH'));
check(() => assert.equal(consume({ indexBytes, provenanceBytes, ...declared }, withAnalogues, { expectedCombinationPolicyVersionId: sha256Canonical('policy/0') }).abstainReason, 'CONSUMER_VERSION_MISMATCH'));

/* H15 permissive fallback: an in-memory record or missing declared identity is refused, not waved through */
refuse(() => consumeEnsemble({ record: recordOf(clone(), withAnalogues) }), 'PARTIAL_ARTIFACT_REFUSED');
refuse(() => consume({ indexBytes, provenanceBytes }, withAnalogues), 'CONSUMER_DECLARED_IDENTITY_REQUIRED');

/* H16 forced non-abstention on real evidence (K at the consumer) */
for (const id of [withAnalogues, withoutAnalogues]) {
  refuse(() => consume(tamper(id, (product, target) => {
    const record = recordOf(product, target);
    record.decision = 'PROCEED';
    record.abstention = { decision: 'PROCEED', reason: null };
    record.horizons.forEach((horizon) => { horizon.abstention = { decision: 'PROCEED', reason: null }; });
  }), id), 'FORCED_NON_ABSTENTION_FORBIDDEN');
}

/* H17 oversized non-LFS: refused at exactly the D6 threshold, accepted one byte below */
check(() => assert.equal(LFS_THRESHOLD_BYTES_V1, authority.bindings.GATE26_LFS_THRESHOLD_V1.thresholdBytes));
{
  const envelope = { schema: published.schema, engineVersion: published.engineVersion, combinationPolicyVersionId: published.combinationPolicyVersionId, horizonCoverageId: published.horizonCoverageId, recordCount: 1, records: [{ pad: '' }] };
  const overhead = Buffer.byteLength(`${canonicalize(envelope)}\n`, 'utf8');
  const atThreshold = { ...envelope, records: [{ pad: 'x'.repeat(LFS_THRESHOLD_BYTES_V1 - overhead) }] };
  refuse(() => serializeEnsembleIndex(atThreshold), 'LFS_THRESHOLD_EXCEEDED');
  check(() => assert.equal(serializeEnsembleIndex({ ...envelope, records: [{ pad: 'x'.repeat(LFS_THRESHOLD_BYTES_V1 - overhead - 1) }] }).length, LFS_THRESHOLD_BYTES_V1 - 1));
}

/* H18 interrupted build resumes from the open MINI_BUILD checkpoint, not from zero */
check(() => {
  const current = readJson('governance/gates/GATE26/state/CURRENT_STATE.json');
  const checkpoint = readJson(`${current.revisionPath}/CHECKPOINT.json`);
  assert.equal(sha256Bytes(readFileSync(resolve(ROOT, `${current.revisionPath}/STATE_SEAL.json`))), current.stateSealSha256);
  assert.equal(checkpoint.stateRevision, current.stateRevision);
  assert.ok(checkpoint.openTasks.includes('GATE26_MINI_BUILD_FUNCTIONAL'));
  assert.ok(['R0001', 'R0002'].every((revision) => existsSync(resolve(ROOT, `governance/gates/GATE26/state/revisions/${revision}/STATE_SEAL.json`))));
});

/* H19 partial publication is not closable: the ledger keeps GATE26 IN_PROGRESS with no closure event */
check(() => {
  const events = readFileSync(resolve(ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const gate26 = events.filter((event) => event.gateId === 'GATE26');
  assert.ok(gate26.length > 0);
  assert.equal(gate26.at(-1).toStatus, 'IN_PROGRESS');
  assert.ok(gate26.every((event) => !['AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION'].includes(event.transitionType ?? event.eventType)));
  assert.equal(rehearsal.closure.agentClosureExecuted, false);
  assert.equal(rehearsal.closure.independentAuditPassAssigned, false);
});

/* H20 transaction residue detectable: no durable-write temp beside any MINI product; any TXN residue classifiable */
check(() => {
  assert.ok(MINI_PRODUCT_PATHS_V1.every((path) => !existsSync(publicationTempPath(resolve(ROOT, path)))));
  const txnRoot = resolve(ROOT, 'governance/transactions');
  const leftover = existsSync(txnRoot) ? readdirSync(txnRoot).filter((name) => name.startsWith('TXN_')) : [];
  leftover.forEach((name) => assert.ok(existsSync(resolve(txnRoot, name, 'PREPARED')) || existsSync(resolve(txnRoot, name, 'COMMITTED')), `residue ${name}`));
});

/* H21 no future pin: succession bound the ledger head that preceded it, and every product input was available by its cutoff */
check(() => {
  const events = readFileSync(resolve(ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const authorityDoc = readJson('governance/authority/authorizations/GATE26/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY.json');
  const position = events.findIndex((event) => event.eventId === 'GATE26_CONTRACT_SUCCESSION_R0002_R1');
  assert.ok(position > 0);
  assert.equal(authorityDoc.ledgerHeadEventId, events[position - 1].eventId);
  assert.equal(authorityDoc.preLedgerEventCount, position);
  for (const manifest of publishedProvenance.records) {
    assert.ok(manifest.inputProofs.every((proof) => Date.parse(proof.availableAt) <= Date.parse(manifest.knowledgeCutoff)));
  }
});

refuse(() => refuseWheelScanInlineCompute(), 'WHEEL_SCAN_INLINE_COMPUTE_FORBIDDEN');

/* --------------------------------------------- F2 / F3 negative controls (real bytes) */

/* C — wrong dataset identity, consistently re-sealed */
refuse(() => consume(tamper(withAnalogues, (product, id) => {
  const other = sha256Canonical('another-dataset');
  for (const binding of [manifestOf(product, id).inputBinding, product.provenance.inputBinding]) { binding.datasetId = `sha256:${other}`; binding.datasetSha256 = other; }
  for (const manifest of product.provenance.records) Object.assign(manifest.inputBinding, product.provenance.inputBinding);
}), withAnalogues), 'DATASET_IDENTITY_MISMATCH');
refuse(() => consume(tamper(withAnalogues, (product, id) => { manifestOf(product, id).inputBinding.datasetSha256 = sha256Canonical('x'); }), withAnalogues), 'DATASET_IDENTITY_MISMATCH');

/* D — malformed provenance SHA */
for (const bad of ['fixture', 'F'.repeat(64), 'f'.repeat(63)]) {
  refuse(() => consume(tamper(withAnalogues, (product, id) => { manifestOf(product, id).inputProofs[0].sourceArtifactSha256 = bad; }), withAnalogues), 'PROVENANCE_SOURCE_SHA256_INVALID');
}
refuse(() => consume(tamper(withAnalogues, (product, id) => { delete manifestOf(product, id).inputProofs[0].sourceArtifactSha256; }), withAnalogues), 'PROVENANCE_INPUT_PROOF_NOT_CLOSED');
refuse(() => consume(tamper(withAnalogues, (product) => { product.provenance.inputBinding.gate25ProvenanceSha256 = 'fixture'; }), withAnalogues), 'PROVENANCE_SOURCE_SHA256_INVALID');

/* E — stale identity */
refuse(() => consume({ indexBytes, provenanceBytes, ...declared }, '1fe1ca5fba6b752cd39ae6d69a71601c7f02db7ffeb8e61728f68a6bae76bd54'), 'ENSEMBLE_IDENTITY_NOT_PUBLISHED');
refuse(() => consume(tamper(withAnalogues, (product, id) => {
  const cutoff = recordOf(product, id).orderedMembers.find((entry) => entry.memberId === 'KnowledgeCutoff');
  cutoff.value = new Date(Date.parse(cutoff.value) + 86400000).toISOString();
}), withAnalogues), 'ENSEMBLE_IDENTITY_DIGEST_MISMATCH');
refuse(() => consume(tamper(withAnalogues, (product, id) => {
  recordOf(product, id).orderedMembers.find((entry) => entry.memberId === 'EnsembleEngineVersionId').value = 'GATE26_PredictiveEnsembleEngine/0';
}), withAnalogues), 'ENSEMBLE_IDENTITY_ENGINE_VERSION_INVALID');

/* F — tampered provenanceId */
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).provenanceId = sha256Canonical('forged'); }, { resealManifests: false }), withAnalogues), 'PROVENANCE_ID_MISMATCH');
refuse(() => consume(tamper(withAnalogues, (product, id) => { manifestOf(product, id).provenanceId = sha256Canonical('forged'); }, { resealManifests: false }), withAnalogues), 'PROVENANCE_ID_MISMATCH');

/* G — tampered provenance binding */
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).horizons[2].provenanceBinding.selectionDigest = sha256Canonical('other-selection'); }), withAnalogues), 'PROVENANCE_BINDING_MISMATCH');
refuse(() => consume(tamper(withAnalogues, (product, id) => { manifestOf(product, id).supportReportId = sha256Canonical('other-support'); }), withAnalogues), 'PROVENANCE_BINDING_MISMATCH');
refuse(() => consume(tamper(withAnalogues, (product, id) => { manifestOf(product, id).queryIdentityId = sha256Canonical('other-query'); }), withAnalogues), 'PROVENANCE_BINDING_MISMATCH');

/* Invalid regime binding */
refuse(() => consume(tamper(withAnalogues, (product, id) => {
  const factor = manifestOf(product, id).regimeBinding.factors[0].commonFactors[0];
  factor.value = `${factor.value}_RECLASSIFIED`;
}), withAnalogues), 'REGIME_BINDING_INVALID');

/* H — missing families */
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).families = ['ANALOGUE_SUPPORT_FAMILY', 'REGIME_BINDING_FAMILY']; }), withAnalogues), 'PREDICTIVE_FAMILY_MISSING');
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).families = ['ANALOGUE_OUTCOME_FAMILY', 'REGIME_BINDING_FAMILY']; }), withAnalogues), 'DEGRADED_INPUT');

/* I — missing, extra and empty horizons */
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).horizons.pop(); }), withAnalogues), 'HORIZON_REQUIRED_MISSING');
refuse(() => consume(tamper(withAnalogues, (product, id) => { const record = recordOf(product, id); record.horizons.push(JSON.parse(JSON.stringify(record.horizons[3]))); }), withAnalogues), 'HORIZON_NOT_ADMISSIBLE');
refuse(() => consume(tamper(withAnalogues, (product, id) => { const record = recordOf(product, id); record.horizons.push({ ...JSON.parse(JSON.stringify(record.horizons[0])), sessionCount: 21 }); }), withAnalogues), 'HORIZON_NOT_ADMISSIBLE');
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).horizons = []; }), withAnalogues), 'HORIZON_COVERAGE_EMPTY');

/* Current bytes not matching declared identity; provenance not binding the index; incompatible record */
refuse(() => consume({ indexBytes: Buffer.concat([indexBytes, Buffer.from(' ')]), provenanceBytes, ...declared }, withAnalogues), 'PRODUCT_BYTES_IDENTITY_MISMATCH');
refuse(() => {
  const product = clone();
  const sealed = seal(product);
  product.provenance.product.ensembleIndexSha256 = declared.expectedIndexSha256 === sealed.expectedIndexSha256 ? sha256Canonical('stale') : declared.expectedIndexSha256;
  const staleProvenance = Buffer.from(`${JSON.stringify(product.provenance, null, 2)}\n`, 'utf8');
  consume({ ...sealed, provenanceBytes: staleProvenance, expectedProvenanceSha256: sha256Bytes(staleProvenance) }, withAnalogues);
}, 'PRODUCT_IDENTITY_NOT_BOUND_BY_PROVENANCE');
refuse(() => consume(tamper(withAnalogues, (product, id) => { recordOf(product, id).extra = true; }), withAnalogues), 'INCOMPATIBLE_PUBLISHED_RECORD');
refuse(() => {
  const pretty = Buffer.from(`${JSON.stringify(published, null, 2)}\n`, 'utf8');
  const product = clone();
  product.provenance.product.ensembleIndexSha256 = sha256Bytes(pretty);
  product.provenance.product.ensembleIndexByteLength = pretty.length;
  const bytes = Buffer.from(`${JSON.stringify(product.provenance, null, 2)}\n`, 'utf8');
  consume({ indexBytes: pretty, provenanceBytes: bytes, expectedIndexSha256: sha256Bytes(pretty), expectedProvenanceSha256: sha256Bytes(bytes) }, withAnalogues);
}, 'ENSEMBLE_INDEX_NOT_CANONICAL');
refuse(() => consume(tamper(withoutAnalogues, (product, id) => { recordOf(product, id).abstention = { decision: 'ABSTAIN', reason: 'INSUFFICIENT_EVIDENCE' }; recordOf(product, id).horizons.forEach((horizon) => { horizon.abstention = { decision: 'ABSTAIN', reason: 'INSUFFICIENT_EVIDENCE' }; }); }), withoutAnalogues), 'ABSTENTION_INCONSISTENT');

/* The published product is reachable only through the same boundary from disk. */
check(() => assert.equal(consumePublishedEnsemble({ root: ROOT, ensembleIdentityId: withAnalogues, ...declared, expectedCombinationPolicyVersionId: policyVersionId }).verification.indexSha256, declared.expectedIndexSha256));

console.log(`GATE26_HOSTILES_PASS ${assertions}`);
