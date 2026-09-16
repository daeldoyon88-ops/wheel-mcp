/**
 * GATE26 foundation: every expectation is read from an independent source — the
 * pinned R0002 contract, its CURRENT_CONTRACT pointer, the GATE22 horizon contract
 * bytes and the ratified mandate — never from the implementation constant under test.
 *
 * Engine controls run on GATE25 same-pipeline selections over GATE25's synthetic
 * candidates (unit scope only; the MINI product itself is built from real P3H data
 * and verified in gate26-replay / gate26-integration). Nothing here writes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  FIXTURE_DATASET_ID, FIXTURE_DATASET_SHA256, fixtureCandidate, fixtureOutcomeSource, fixturePolicy, fixtureQuery, referenceCandidates, runFixture,
} from '../../GATE25/tests/gate25-foundation.test.mjs';
import { createEnsembleIdentity, ENSEMBLE_IDENTITY_MEMBER_IDS_V1, verifyEnsembleIdentity } from '../implementation/ensemble-identity-v1.mjs';
import { ABSTAIN_REASONS_V1, FAMILIES_V1 } from '../implementation/combination-policy-v1.mjs';
import { ADMISSIBLE_SESSION_COUNTS_V1, ENSEMBLE_RECORD_FIELDS_V1 } from '../implementation/ensemble-record-v1.mjs';
import { LFS_THRESHOLD_BYTES_V1 } from '../implementation/ensemble-provenance-v1.mjs';
import {
  EXECUTION_CONTRACT_PATH, EXECUTION_CONTRACT_SHA256, abstainForRefusedQuery, combineFrozenSelection, loadGate26MiniBuildAuthority,
} from '../implementation/predictive-ensemble-engine-v1.mjs';
import { MINI_PRODUCT_PATHS_V1, deriveD4AnchorCases } from '../implementation/mini-fixture-v1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };
const refuse = (fn, code) => check(() => assert.throws(fn, (error) => error?.code === code, `expected ${code}`));

/** Declared input binding for a GATE25 fixture selection, taken from the fixture policy, not from the selection. */
export function fixtureInputBinding(overrides = {}) {
  const policy = fixturePolicy();
  return {
    datasetId: FIXTURE_DATASET_ID,
    datasetSha256: FIXTURE_DATASET_SHA256,
    admittedKeyDigest: sha256Canonical('fixture-admitted-keys'),
    exclusionDigest: sha256Canonical('fixture-exclusions'),
    selectionPolicyVersionId: policy.selectionPolicyVersionId,
    gate25ExecutionContractSha256: sha256Canonical('fixture-gate25-contract'),
    calendarRegistryManifestId: policy.outcomeCalendarRegistryManifestId,
    analogueIndexSha256: sha256Canonical('fixture-analogue-index'),
    gate25ProvenanceSha256: sha256Canonical('fixture-gate25-provenance'),
    horizonContractSha256: sha256Canonical('fixture-horizon-contract'),
    ...overrides,
  };
}

/** A reference selection whose first horizon has an outcome available at the query cutoff. */
export function mixedSelection() {
  const base = runFixture({ candidates: referenceCandidates() });
  const values = new Map(base.frozenSelection.analogues.map((analogue) => [`${analogue.analogueIdentityId}|${base.horizonBindings[0].horizonId}`, 0.01]));
  return runFixture({ candidates: referenceCandidates(), outcomeSource: fixtureOutcomeSource({ values, availableAt: base.query.knowledgeCutoff }) });
}

export function runFoundation() {
  const authority = loadGate26MiniBuildAuthority({ root: ROOT });
  const contractBytes = readFileSync(resolve(ROOT, EXECUTION_CONTRACT_PATH));
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const pointer = readJson('governance/gates/GATE26/contracts/CURRENT_CONTRACT.json');
  const requirement = (bindingId) => contract.canonicalRequirements.find((item) => item.bindingId === bindingId).binding;

  /* Contract identity: the pointer, the bytes and the engine pin agree. */
  check(() => assert.equal(pointer.contractPath, EXECUTION_CONTRACT_PATH));
  check(() => assert.equal(pointer.contractSha256, sha256Bytes(contractBytes)));
  check(() => assert.equal(EXECUTION_CONTRACT_SHA256, pointer.contractSha256));

  /* The exact 22-path workset covers every path the MINI and the D5 layout name. */
  check(() => assert.equal(new Set(contract.authorizedPaths).size, 22));
  check(() => assert.ok(MINI_PRODUCT_PATHS_V1.every((path) => contract.authorizedPaths.includes(path))));
  check(() => assert.ok(requirement('GATE26_TEST_LAYOUT_V1').files.every((path) => contract.authorizedPaths.includes(path))));

  /* D1 identity members, D2 families, D3 horizons and closed fields, D6 threshold: implementation equals binding. */
  check(() => assert.deepEqual([...ENSEMBLE_IDENTITY_MEMBER_IDS_V1], requirement('GATE26_ENSEMBLE_IDENTITY_V1').orderedMemberIds));
  check(() => assert.equal(ENSEMBLE_IDENTITY_MEMBER_IDS_V1.length, requirement('GATE26_ENSEMBLE_IDENTITY_V1').memberCount));
  check(() => assert.deepEqual([...FAMILIES_V1], requirement('GATE26_COMBINATION_POLICY_V1').familiesV1));
  const horizonInput = contract.requiredInputs.find((input) => input.role === 'HORIZON_AUTHORITY_ALL_AND_ONLY');
  const horizonBytes = readFileSync(resolve(ROOT, horizonInput.path));
  check(() => assert.equal(sha256Bytes(horizonBytes), horizonInput.sha256));
  const gate22Counts = JSON.parse(horizonBytes.toString('utf8')).mandateProjection.sessionCountingRules.horizonsV1;
  check(() => assert.deepEqual([...ADMISSIBLE_SESSION_COUNTS_V1], gate22Counts));
  check(() => assert.deepEqual(requirement('GATE26_MULTI_HORIZON_OUTPUT_V1').sessionCounts, gate22Counts));
  check(() => assert.deepEqual([...ENSEMBLE_RECORD_FIELDS_V1], requirement('GATE26_MULTI_HORIZON_OUTPUT_V1').closedFields));
  check(() => assert.equal(LFS_THRESHOLD_BYTES_V1, requirement('GATE26_LFS_THRESHOLD_V1').thresholdBytes));
  check(() => assert.ok(authority.mandate.v1DefinitionFreeze.abstention.reasons.every((reason) => ABSTAIN_REASONS_V1.includes(reason))));

  /* D4 anchors are parsed from the binding's own case ids; an unknown case fails closed. */
  const anchors = deriveD4AnchorCases(authority);
  check(() => assert.deepEqual(anchors.map((anchor) => anchor.caseId), requirement('GATE26_MINI_FIXTURE_SELECTION_V1').queryCases.filter((id) => /_\d{4}-\d{2}-\d{2}$/.test(id))));
  check(() => assert.ok(anchors.every((anchor) => anchor.caseId.endsWith(anchor.anchorDate) && anchor.caseId.startsWith(`${anchor.querySymbol}_`))));
  refuse(() => deriveD4AnchorCases({ bindings: { GATE26_MINI_FIXTURE_SELECTION_V1: { queryCases: [...requirement('GATE26_MINI_FIXTURE_SELECTION_V1').queryCases, 'AAPL_LATEST'] } } }), 'D4_QUERY_CASE_UNRECOGNIZED');

  /* PROCEED with evidence: per-horizon abstention follows per-horizon availability. */
  const mixed = mixedSelection();
  const availableByHorizon = mixed.horizonBindings.map((binding) => mixed.outcomeSet.records.filter((row) => row.horizonId === binding.horizonId && row.outcomeStatus === 'AVAILABLE').length);
  check(() => assert.ok(availableByHorizon[0] > 0 && availableByHorizon.slice(1).every((count) => count === 0)));
  const proceed = combineFrozenSelection({ authority, selection: mixed, inputBinding: fixtureInputBinding() });
  check(() => assert.equal(proceed.decision, 'PROCEED'));
  check(() => assert.deepEqual(proceed.horizons.map((horizon) => horizon.sessionCount), gate22Counts));
  check(() => assert.deepEqual(proceed.horizons.map((horizon) => horizon.abstention.decision), availableByHorizon.map((count) => (count > 0 ? 'PROCEED' : 'ABSTAIN'))));
  check(() => assert.ok(proceed.horizons.every((horizon) => horizon.supportDerivedConfidence.calibratedProbability === null)));
  check(() => assert.ok(proceed.horizons.every((horizon) => horizon.combinationTrace.some((step) => step.weights === 'FORBIDDEN'))));
  check(() => assert.equal(verifyEnsembleIdentity(proceed.identity).ensembleIdentityId, proceed.identity.ensembleIdentityId));
  check(() => assert.equal(proceed.identity.orderedMembers.find((entry) => entry.memberId === 'DatasetId_observation').value, FIXTURE_DATASET_ID));
  check(() => assert.equal(proceed.provenance.inputBinding.datasetId, FIXTURE_DATASET_ID));
  check(() => assert.ok(proceed.provenance.inputProofs.length > 0 && proceed.provenance.inputProofs.every((proof) => /^[0-9a-f]{64}$/.test(proof.sourceArtifactSha256))));

  /* K — all four horizons without a usable outcome can never PROCEED. */
  const unavailable = runFixture({ candidates: referenceCandidates() });
  check(() => assert.ok(unavailable.supportReport.eligibleCount >= 2));
  check(() => assert.equal(unavailable.outcomeSet.records.filter((row) => row.outcomeStatus === 'AVAILABLE').length, 0));
  const allMissing = combineFrozenSelection({ authority, selection: unavailable, inputBinding: fixtureInputBinding() });
  check(() => assert.equal(allMissing.decision, 'ABSTAIN'));
  check(() => assert.equal(allMissing.abstention.reason, 'PREDICTIVE_FAMILY_MISSING'));
  check(() => assert.ok(allMissing.horizons.length === 4 && allMissing.horizons.every((horizon) => horizon.abstention.decision === 'ABSTAIN')));

  /* Insufficient support abstains with a formable identity. */
  const insufficient = combineFrozenSelection({
    authority,
    selection: runFixture({ candidates: [fixtureCandidate({ index: 150, w5: 0.01, w21: 0.06 })], query: fixtureQuery() }),
    inputBinding: fixtureInputBinding(),
  });
  check(() => assert.equal(insufficient.abstention.reason, 'INSUFFICIENT_SUPPORT'));
  check(() => assert.match(insufficient.identity.ensembleIdentityId, /^[0-9a-f]{64}$/));

  /* C — DatasetId_observation is derived from the selection; any declared mismatch fails closed. */
  const otherSha = sha256Canonical('some-other-dataset');
  refuse(() => combineFrozenSelection({ authority, selection: mixed, inputBinding: fixtureInputBinding({ datasetId: `sha256:${otherSha}`, datasetSha256: otherSha }) }), 'DATASET_IDENTITY_MISMATCH');
  refuse(() => combineFrozenSelection({ authority, selection: mixed, inputBinding: fixtureInputBinding({ datasetSha256: otherSha }) }), 'DATASET_IDENTITY_MISMATCH');
  refuse(() => combineFrozenSelection({ authority, selection: mixed, inputBinding: fixtureInputBinding({ selectionPolicyVersionId: otherSha }) }), 'SELECTION_POLICY_BINDING_MISMATCH');
  refuse(() => combineFrozenSelection({ authority, selection: mixed, inputBinding: fixtureInputBinding({ calendarRegistryManifestId: `sha256:${otherSha}` }) }), 'HORIZON_CALENDAR_BINDING_MISMATCH');
  refuse(() => combineFrozenSelection({ authority, selection: mixed }), 'INPUT_BINDING_NOT_CLOSED');
  refuse(() => combineFrozenSelection({
    authority,
    selection: { ...mixed, comparisonReport: { ...mixed.comparisonReport, datasetId: `sha256:${otherSha}` } },
    inputBinding: fixtureInputBinding(),
  }), 'DATASET_IDENTITY_MISMATCH');

  /* D — malformed provenance SHA-256 values fail closed. */
  const withProof = (patch) => ({ ...mixed, inputProofs: mixed.inputProofs.map((proof, index) => (index === 0 ? patch(proof) : proof)) });
  for (const bad of ['fixture', '', 'A'.repeat(64), 'a'.repeat(63), null]) {
    refuse(() => combineFrozenSelection({ authority, selection: withProof((proof) => ({ ...proof, sourceArtifactSha256: bad })), inputBinding: fixtureInputBinding() }), 'PROVENANCE_SOURCE_SHA256_INVALID');
  }
  refuse(() => combineFrozenSelection({ authority, selection: withProof(({ sourceArtifactSha256, ...rest }) => rest), inputBinding: fixtureInputBinding() }), 'PROVENANCE_INPUT_PROOF_NOT_CLOSED');
  refuse(() => combineFrozenSelection({ authority, selection: { ...mixed, inputProofs: [] }, inputBinding: fixtureInputBinding() }), 'PROVENANCE_INPUT_PROOFS_REQUIRED');
  refuse(() => combineFrozenSelection({ authority, selection: mixed, inputBinding: fixtureInputBinding({ analogueIndexSha256: 'fixture' }) }), 'PROVENANCE_SOURCE_SHA256_INVALID');

  /* Query refusals: only not-comparable refusals abstain; anything else is rethrown. */
  const refused = abstainForRefusedQuery({ authority, refusal: Object.assign(new Error('x'), { code: 'QUERY_INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE' }) });
  check(() => assert.equal(refused.abstention.reason, 'QUERY_NOT_COMPARABLE'));
  check(() => assert.equal(refused.identity, null));
  refuse(() => abstainForRefusedQuery({ authority, refusal: Object.assign(new Error('x'), { code: 'QUERY_INPUT_AFTER_KNOWLEDGE_CUTOFF' }) }), 'QUERY_INPUT_AFTER_KNOWLEDGE_CUTOFF');

  refuse(() => createEnsembleIdentity({ ...Object.fromEntries(proceed.identity.orderedMembers.map((entry) => [entry.memberId, entry.value])), ticker: 'AAPL' }), 'ENSEMBLE_IDENTITY_FORBIDDEN_MEMBER');
  console.log(`GATE26_FOUNDATION_PASS ${assertions}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runFoundation();
