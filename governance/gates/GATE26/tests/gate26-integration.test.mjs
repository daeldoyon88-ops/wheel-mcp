/**
 * GATE26 integration: VERIFICATION ONLY. Reads the materialized MINI product bytes,
 * never writes or rebuilds them (materialization is the explicit
 * `mini-fixture-v1.mjs --materialize` command; recomputation is gate26-replay).
 *
 * Expectations are re-derived here from independent sources: the P3H finalization
 * bytes and the GATE25 mandate pin set, the GATE25 published PROVENANCE, the
 * historical calendar binding, the official instrument-identity resolver, the GATE22
 * horizon contract and the R0002 contract bindings. Every published record is
 * consumed from its serialized bytes through GATE26_CONSUMPTION_BOUNDARY_V1.
 */

import assert from 'node:assert/strict';
import { openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes } from '../../../tools/canonical-json.mjs';
import { computeJarviseHistoricalCalendarBindingR1, loadJarviseHistoricalCalendarR1 } from '../../../../app/jarvise/jarviseHistoricalCalendarBindingR1.mjs';
import { createContentAddressedStore } from '../../../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { resolveInstrumentIdentityAsOf } from '../../../../research/directional-lab/src/data/buildInstrumentIdentity.mjs';
import {
  ENSEMBLE_INDEX_PRODUCT_PATH_V1, PROVENANCE_PRODUCT_PATH_V1, createEnsembleIndex, serializeEnsembleIndex,
} from '../implementation/ensemble-provenance-v1.mjs';
import { consumePublishedEnsemble } from '../implementation/consumption-boundary-v1.mjs';
import { EXECUTION_CONTRACT_PATH, loadGate26MiniBuildAuthority } from '../implementation/predictive-ensemble-engine-v1.mjs';
import { REHEARSAL_REPORT_PATH_V1, SIZE_MEASUREMENT_PATH_V1 } from '../implementation/mini-fixture-v1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bytesOf = (path) => readFileSync(resolve(ROOT, path));
const readJson = (path) => JSON.parse(bytesOf(path).toString('utf8'));

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

const contract = readJson(EXECUTION_CONTRACT_PATH);
const pinned = (role) => contract.requiredInputs.find((input) => input.role === role);
const binding = (bindingId) => contract.canonicalRequirements.find((item) => item.bindingId === bindingId).binding;
const authority = loadGate26MiniBuildAuthority({ root: ROOT });

const indexBytes = bytesOf(ENSEMBLE_INDEX_PRODUCT_PATH_V1);
const provenanceBytes = bytesOf(PROVENANCE_PRODUCT_PATH_V1);
const index = JSON.parse(indexBytes.toString('utf8'));
const provenance = JSON.parse(provenanceBytes.toString('utf8'));
const size = readJson(SIZE_MEASUREMENT_PATH_V1);
const rehearsal = readJson(REHEARSAL_REPORT_PATH_V1);
const cases = provenance.queryCases;
const byRole = (role) => cases.find((item) => item.derivation.role === role);

/* ---- Publication identity: the bytes on disk are the bytes every declaration names. */
check(() => assert.equal(sha256Bytes(indexBytes), rehearsal.publication.indexSha256));
check(() => assert.equal(sha256Bytes(indexBytes), provenance.product.ensembleIndexSha256));
check(() => assert.equal(indexBytes.length, provenance.product.ensembleIndexByteLength));
check(() => assert.equal(sha256Bytes(provenanceBytes), rehearsal.publication.provenanceSha256));
check(() => assert.equal(`${canonicalize(index)}\n`, indexBytes.toString('utf8')));

/* ---- B: the actual P3H / GATE25 input identities, re-derived from their own bytes. */
const gate25Mandate = readJson('governance/sources/GATE25_CANONICAL_MANDATE_R0.json');
const p3hBytes = readFileSync(gate25Mandate.historyPolicy.pinSet.artifactPath);
const p3hSha256 = sha256Bytes(p3hBytes);
const gate25ProvenanceInput = pinned('GATE25_ANALOGUE_PROVENANCE_READ_ONLY');
const gate25ProvenanceBytes = bytesOf(gate25ProvenanceInput.path);
const gate25Provenance = JSON.parse(gate25ProvenanceBytes.toString('utf8'));
const analogueIndexBytes = bytesOf('data/jarvise/historical-analogue/GATE25/V1/ANALOGUE_INDEX.json');
const horizonInput = pinned('HORIZON_AUTHORITY_ALL_AND_ONLY');
const gate25Pointer = readJson('governance/gates/GATE25/contracts/CURRENT_CONTRACT.json');
const input = provenance.inputBinding;
check(() => assert.equal(`sha256:${p3hSha256}`, gate25Mandate.historyPolicy.pinSet.datasetIdentity));
check(() => assert.equal(input.datasetSha256, p3hSha256));
check(() => assert.equal(input.datasetId, gate25Mandate.historyPolicy.pinSet.datasetIdentity));
check(() => assert.equal(input.admittedKeyDigest, gate25Mandate.historyPolicy.pinSet.admittedKeyDigest));
check(() => assert.equal(input.exclusionDigest, gate25Mandate.historyPolicy.pinSet.exclusionDigest));
check(() => assert.equal(sha256Bytes(gate25ProvenanceBytes), gate25ProvenanceInput.sha256));
check(() => assert.equal(input.gate25ProvenanceSha256, gate25ProvenanceInput.sha256));
check(() => assert.equal(sha256Bytes(analogueIndexBytes), gate25Provenance.analogueIndexSha256));
check(() => assert.equal(input.analogueIndexSha256, gate25Provenance.analogueIndexSha256));
check(() => assert.equal(input.selectionPolicyVersionId, gate25Provenance.selectionPolicyVersionId));
check(() => assert.equal(input.gate25ExecutionContractSha256, sha256Bytes(bytesOf(gate25Pointer.contractPath))));
check(() => assert.equal(input.horizonContractSha256, sha256Bytes(bytesOf(horizonInput.path))));
check(() => assert.equal(input.horizonContractSha256, horizonInput.sha256));
check(() => assert.equal(input.calendarRegistryManifestId, computeJarviseHistoricalCalendarBindingR1({ root: ROOT }).calendarRegistryManifestId));
for (const record of index.records) {
  check(() => assert.equal(record.orderedMembers.find((entry) => entry.memberId === 'DatasetId_observation').value, `sha256:${p3hSha256}`));
}
for (const manifest of provenance.records) {
  check(() => assert.equal(canonicalize(manifest.inputBinding), canonicalize(input)));
  check(() => assert.ok(manifest.inputProofs.length > 0 && manifest.inputProofs.every((proof) => /^[0-9a-f]{64}$/.test(proof.sourceArtifactSha256) && proof.availableByCutoff === true)));
}

/* ---- A: the three D4 AAPL anchors ran on the real universe. */
const anchorIds = binding('GATE26_MINI_FIXTURE_SELECTION_V1').queryCases.filter((id) => /_\d{4}-\d{2}-\d{2}$/.test(id));
check(() => assert.deepEqual(cases.map((item) => item.caseId), anchorIds));
const window = readJson(gate25Pointer.contractPath).canonicalRequirements.find((item) => item.requirementId === 'G25-BUILD-02').observationAdmissionScope.historicalObservationWindow;
const sessions = loadJarviseHistoricalCalendarR1({ root: ROOT }).sessions
  .filter((session) => session.sessionDate >= window.startSessionInclusive && session.sessionDate <= window.endSessionInclusive);
const end = byRole('END');
const mid = byRole('MID');
const preAlias = byRole('PRE_ALIAS');
check(() => assert.equal(end.derivation.sessionDate, /(\d{4}-\d{2}-\d{2})$/.exec(end.caseId)[1]));
check(() => assert.equal(mid.derivation.sessionDate, sessions.find((session) => session.sessionDate >= /(\d{4}-\d{2}-\d{2})$/.exec(mid.caseId)[1]).sessionDate));
check(() => assert.equal(preAlias.derivation.sessionDate, /(\d{4}-\d{2}-\d{2})$/.exec(preAlias.caseId)[1]));
const universeCount = (gate25Mandate.historyPolicy.pinSet.admittedKeyCount + gate25Mandate.historyPolicy.pinSet.exclusionCount) * sessions.length;
for (const item of [end, mid]) {
  check(() => assert.equal(item.execution, 'SELECTION_COMPLETED'));
  check(() => assert.equal(item.accounting.universeCount, universeCount));
  check(() => assert.equal(item.accounting.eligibleCount + item.accounting.excludedCount, universeCount));
  check(() => assert.equal(item.analogueIdentityIds.length, item.accounting.eligibleCount));
  check(() => assert.match(item.accounting.decisionDigest, /^[0-9a-f]{64}$/));
  check(() => assert.deepEqual(item.horizonAvailability.map((horizon) => horizon.sessionCount), binding('GATE26_MULTI_HORIZON_OUTPUT_V1').sessionCounts));
  check(() => assert.ok(item.horizonAvailability.every((horizon) => horizon.analogueCount === item.accounting.eligibleCount)));
}
check(() => assert.equal(preAlias.execution, 'QUERY_REFUSED'));
check(() => assert.equal(preAlias.refusalCode, 'QUERY_INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE'));
check(() => assert.equal(preAlias.decision, 'ABSTAIN'));
check(() => assert.equal(preAlias.abstainReason, 'QUERY_NOT_COMPARABLE'));
check(() => assert.equal(preAlias.ensembleIdentityId, null));

/* Query identity status agrees with the official as-of resolver, which GATE26 does not call. */
{
  const identityProvenance = readJson('data/jarvise/instrument-identity/PROVENANCE.json');
  const namespace = readJson('data/jarvise/instrument-identity/symbol-namespace-policy.json');
  const store = createContentAddressedStore({ root: resolve(ROOT, 'data/jarvise/instrument-identity/cas') });
  const official = (symbol, asOfDate) => {
    try {
      return { status: 'RESOLVED', instrumentIdentityId: resolveInstrumentIdentityAsOf({ store, registryManifestId: identityProvenance.registryManifestId, namespacePolicyId: identityProvenance.namespacePolicyId, providerId: namespace.providerId, venueId: null, symbol, currency: 'USD', asOfDate }).instrumentIdentityId };
    } catch { return { status: 'UNRESOLVED', instrumentIdentityId: null }; }
  };
  for (const item of cases) {
    const expected = official(item.derivation.querySymbol, item.derivation.sessionDate);
    check(() => assert.equal(item.queryInstrumentIdentity.status, expected.status));
    check(() => assert.equal(item.queryInstrumentIdentity.instrumentIdentityId, expected.instrumentIdentityId));
  }
}

/* ---- D4 coverage, recomputed here from execution evidence. */
const completed = cases.filter((item) => item.execution === 'SELECTION_COMPLETED');
check(() => assert.ok(completed.some((item) => item.accounting.eligibleCount < 2 && item.abstainReason === 'INSUFFICIENT_SUPPORT')));
check(() => assert.ok(completed.some((item) => item.horizonAvailability.some((horizon) => horizon.availableCount === 0))));
check(() => assert.ok(new Set(completed.map((item) => item.queryCoreV1SignatureDigest).filter((digest) => digest !== null)).size >= 2));

/* ---- K / N1 on real evidence: no usable outcome at any horizon never PROCEEDs. */
const noOutcome = completed.filter((item) => item.accounting.eligibleCount >= 2 && item.horizonAvailability.every((horizon) => horizon.availableCount === 0));
check(() => assert.ok(noOutcome.length > 0));
for (const item of noOutcome) {
  check(() => assert.equal(item.decision, 'ABSTAIN'));
  check(() => assert.equal(item.abstainReason, 'PREDICTIVE_FAMILY_MISSING'));
}

/* ---- J: every published record is consumable from its serialized bytes through the real boundary. */
check(() => assert.equal(index.recordCount, cases.filter((item) => item.ensembleIdentityId !== null).length));
for (const item of cases.filter((entry) => entry.ensembleIdentityId !== null)) {
  const consumed = consumePublishedEnsemble({
    root: ROOT,
    ensembleIdentityId: item.ensembleIdentityId,
    expectedIndexSha256: rehearsal.publication.indexSha256,
    expectedProvenanceSha256: rehearsal.publication.provenanceSha256,
    expectedCombinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
  });
  check(() => assert.equal(consumed.decision, item.decision === 'PROCEED' ? 'CONSUME' : 'ABSTAIN'));
  check(() => assert.equal(consumed.abstainReason, item.abstainReason));
  check(() => assert.equal(consumed.verification.datasetIdObservation, `sha256:${p3hSha256}`));
  check(() => assert.deepEqual(
    rehearsal.consumption.results.find((result) => result.ensembleIdentityId === item.ensembleIdentityId),
    { ensembleIdentityId: item.ensembleIdentityId, decision: consumed.decision, abstainReason: consumed.abstainReason, provenanceId: consumed.verification.provenanceId },
  ));
}

/* ---- Size / LFS: recomputed from the bytes on disk with the documented method. */
{
  const threshold = binding('GATE26_LFS_THRESHOLD_V1').thresholdBytes;
  const envelope = serializeEnsembleIndex(createEnsembleIndex({ engineVersion: index.engineVersion, combinationPolicyVersionId: index.combinationPolicyVersionId, horizonCoverageId: index.horizonCoverageId })).length;
  const rowMax = Math.max(...index.records.map((record) => Buffer.byteLength(canonicalize(record), 'utf8')));
  const provenanceRowMax = Math.max(...provenance.records.map((manifest) => Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8')));
  const head = Buffer.alloc(256);
  const handle = openSync(resolve(ROOT, 'data/jarvise/historical-analogue/GATE25/V1/ANALOGUE_INDEX.json'), 'r');
  try { readSync(handle, head, 0, head.length, 0); } finally { closeSync(handle); }
  const rowCount = Number(/"recordCount":(\d+)/.exec(head.toString('utf8'))[1]);
  const projectedIndex = envelope + rowCount * (rowMax + 1);
  const projectedProvenance = rowCount * (provenanceRowMax + 2);
  check(() => assert.equal(size.measured.indexByteLength, indexBytes.length));
  check(() => assert.equal(size.measured.provenanceByteLength, provenanceBytes.length));
  check(() => assert.equal(size.measured.indexEnvelopeByteLength, envelope));
  check(() => assert.equal(size.measured.indexRowBytesMax, rowMax));
  check(() => assert.equal(size.measured.provenanceRowBytesMax, provenanceRowMax));
  check(() => assert.equal(size.fullBuildProjection.rowCount, rowCount));
  check(() => assert.equal(size.fullBuildProjection.projectedEnsembleIndexBytes, projectedIndex));
  check(() => assert.equal(size.fullBuildProjection.projectedEnsembleIndexClass, projectedIndex >= threshold ? 'LFS_REQUIRED' : 'NORMAL_GIT_ELIGIBLE'));
  check(() => assert.equal(size.fullBuildProjection.projectedProvenanceBytesAtMiniMaxAnalogueCount, projectedProvenance));
  check(() => assert.equal(size.lfsThresholdBytes, threshold));
  check(() => assert.equal(size.miniClass, indexBytes.length < threshold && provenanceBytes.length < threshold ? 'NORMAL_GIT' : 'LFS_REQUIRED'));
}

/* ---- Closure-readiness rehearsal only; nothing closed or confirmed. */
check(() => assert.equal(rehearsal.closure.agentClosureExecuted, false));
check(() => assert.equal(rehearsal.closure.externalConfirmationExecuted, false));
check(() => assert.equal(rehearsal.closure.independentAuditPassAssigned, false));
check(() => assert.equal(rehearsal.consumption.boundary.input, 'SERIALIZED_PRODUCT_BYTES'));

/* ---- Upstream immutability against the R0002 pins. */
for (const required of contract.requiredInputs) {
  check(() => assert.equal(sha256Bytes(bytesOf(required.path)), required.sha256, required.path));
}

console.log(`GATE26_INTEGRATION_PASS ${assertions}`);
