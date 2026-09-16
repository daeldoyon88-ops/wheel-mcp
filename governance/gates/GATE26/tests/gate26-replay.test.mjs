/**
 * GATE26 replay and leakage over REAL canonical inputs.
 *
 * A child process, with every network surface trapped, reloads P3H, the pinned
 * calendar, the published regime foundation and the published GATE25 ANALOGUE_INDEX
 * and recomputes the MINI product bytes without writing them. The parent requires:
 *
 *   - byte identity with the products on disk (the product is exactly what the real
 *     pipeline yields, and replay across processes is deterministic);
 *   - the same universe reproduces GATE25's independently published PROVENANCE;
 *   - no input proof after its cutoff, and no AVAILABLE outcome whose horizon window
 *     ends after the query session (calendar arithmetic, not engine output);
 *   - a real-data PROCEED control, chosen by a fixed rule, is CONSUMED through the
 *     serialized boundary, so the positive path is not vacuous.
 *
 * Fast engine-level leakage refusals run in the parent on GATE25 fixture selections.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const THIS_FILE = fileURLToPath(import.meta.url);
const SUMMARY_PREFIX = 'GATE26_REPLAY_SUMMARY ';

/* ------------------------------------------------------------------------ child */

async function runChild() {
  const fixture = await import('../implementation/mini-fixture-v1.mjs');
  const networkCalls = fixture.installNetworkTrap();
  const { canonicalize, sha256Bytes } = await import('../../../tools/canonical-json.mjs');
  const gate25 = await import('../../GATE25/implementation/historical-analogue-engine-v1.mjs');
  const { indexRecordSessionDate } = await import('../../GATE25/implementation/analogue-index-v1.mjs');
  const engine = await import('../implementation/predictive-ensemble-engine-v1.mjs');
  const provenanceModule = await import('../implementation/ensemble-provenance-v1.mjs');
  const { consumeEnsemble } = await import('../implementation/consumption-boundary-v1.mjs');

  const inputs = fixture.loadMiniRealInputs({ root: ROOT });
  const built = fixture.buildMiniProducts({ root: ROOT, inputs });
  const { universe, analogueIndex, policy, gate25Authority, authority, inputBinding } = inputs;
  const sessionIndex = new Map(universe.sessions.map((session, index) => [session.sessionDate, index]));
  const productSha256 = Object.fromEntries([...built.bytes].map(([path, bytes]) => [path, sha256Bytes(bytes)]));
  const key = universe.keys.find((item) => item.acquisitionKey === built.evidence[0].derivation.queryAcquisitionKey);

  /* Every MISSING outcome of a completed anchor is forced by causality: its horizon window ends after T. */
  const anchorCausality = built.evidence.filter((item) => item.execution === 'SELECTION_COMPLETED').map((item) => {
    const t = sessionIndex.get(item.derivation.sessionDate);
    const windowsEndingByT = item.analogueIdentityIds.flatMap((id) => item.horizonAvailability.map((horizon) => (
      sessionIndex.get(indexRecordSessionDate(analogueIndex.records.get(id))) + horizon.sessionCount <= t ? 1 : 0))).reduce((a, b) => a + b, 0);
    return {
      caseId: item.caseId,
      analogueCount: item.analogueIdentityIds.length,
      availableTotal: item.horizonAvailability.reduce((sum, horizon) => sum + horizon.availableCount, 0),
      windowsEndingByT,
    };
  });

  /* Independent cross-check: the same inputs reproduce GATE25's published product selection. */
  const gate25Provenance = JSON.parse(readFileSync(resolve(ROOT, 'data/jarvise/historical-analogue/GATE25/V1/PROVENANCE.json'), 'utf8'));
  const gate25Session = universe.sessions.find((session) => session.knowledgeCutoff === gate25Provenance.knowledgeCutoff).sessionDate;
  const gate25Selection = gate25.runAnalogueSelection({
    authority: gate25Authority, policy, query: gate25.buildP3hQuery({ universe, acquisitionKey: key.acquisitionKey, sessionDate: gate25Session }),
    candidates: gate25.iterateP3hCandidates(universe), historicalOutcomeUniverse: universe, analogueIndex,
  });

  /* Positive control rule: latest AAPL session whose CORE_V1 group holds >= 2 earlier AAPL sessions, one >= 30 sessions earlier. */
  let control = null;
  for (const [signature, members] of universe.coreV1ClassifyingGroups) {
    const same = members.filter((member) => member.acquisitionKey === key.acquisitionKey).sort((left, right) => (left.sessionDate < right.sessionDate ? -1 : 1));
    same.forEach((member, position) => {
      const earlier = same.slice(0, position);
      if (earlier.length < 2 || !earlier.some((item) => sessionIndex.get(member.sessionDate) - sessionIndex.get(item.sessionDate) >= 30)) return;
      if (control === null || member.sessionDate > control.sessionDate || (member.sessionDate === control.sessionDate && signature < control.signature)) {
        control = { sessionDate: member.sessionDate, signature };
      }
    });
  }
  const controlSelection = gate25.runAnalogueSelection({
    authority: gate25Authority, policy, query: gate25.buildP3hQuery({ universe, acquisitionKey: key.acquisitionKey, sessionDate: control.sessionDate }),
    candidates: gate25.iterateP3hCandidates(universe), historicalOutcomeUniverse: universe, analogueIndex,
  });
  const controlCombined = engine.combineFrozenSelection({ authority, selection: controlSelection, inputBinding });
  const t = sessionIndex.get(control.sessionDate);
  const analogueSession = new Map(controlSelection.comparisonReport.analogues.map((entry) => [entry.analogueIdentityId, entry.sessionDate]));
  const horizonCount = new Map(controlSelection.horizonBindings.map((binding) => [binding.horizonId, binding.sessionCount]));
  const cutoffMs = Date.parse(controlSelection.query.knowledgeCutoff);
  let leakage = 0;
  let futureWindowsMissing = 0;
  for (const record of controlSelection.outcomeSet.records) {
    const windowEndsByT = sessionIndex.get(analogueSession.get(record.analogueIdentityId)) + horizonCount.get(record.horizonId) <= t;
    if (record.outcomeStatus === 'AVAILABLE' && (!windowEndsByT || Date.parse(record.outcomeAvailableAt) > cutoffMs)) leakage += 1;
    if (!windowEndsByT && record.outcomeStatus === 'MISSING') futureWindowsMissing += 1;
  }
  let controlIndex = provenanceModule.createEnsembleIndex({
    engineVersion: controlCombined.engineVersion, combinationPolicyVersionId: controlCombined.combinationPolicyVersionId,
    horizonCoverageId: controlCombined.identity.orderedMembers.find((entry) => entry.memberId === 'HorizonCoverageId').value,
  });
  controlIndex = provenanceModule.appendEnsembleRecord(controlIndex, provenanceModule.buildEnsembleIndexRecord(controlCombined));
  const controlIndexBytes = provenanceModule.serializeEnsembleIndex(controlIndex);
  const diskProvenance = JSON.parse(built.bytes.get(provenanceModule.PROVENANCE_PRODUCT_PATH_V1).toString('utf8'));
  const controlProvenanceBytes = Buffer.from(`${JSON.stringify({
    ...diskProvenance,
    queryCases: [],
    d4Coverage: [],
    records: [controlCombined.provenance],
    product: { ...diskProvenance.product, ensembleIndexSha256: sha256Bytes(controlIndexBytes), ensembleIndexByteLength: controlIndexBytes.length, recordCount: 1 },
  }, null, 2)}\n`, 'utf8');
  const controlConsumed = consumeEnsemble({
    indexBytes: controlIndexBytes, provenanceBytes: controlProvenanceBytes, ensembleIdentityId: controlCombined.identity.ensembleIdentityId,
    expectedIndexSha256: sha256Bytes(controlIndexBytes), expectedProvenanceSha256: sha256Bytes(controlProvenanceBytes),
    expectedCombinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
  });

  const proofsAfterCutoff = diskProvenance.records.flatMap((manifest) => manifest.inputProofs)
    .filter((proof) => Date.parse(proof.availableAt) > Date.parse(proof.knowledgeCutoff)).length;

  const summary = {
    productSha256,
    networkCalls,
    datasetId: inputBinding.datasetId,
    anchorCausality,
    proofsAfterCutoff,
    gate25CrossCheck: {
      queryIdentityId: gate25Selection.queryIdentity.analogueIdentityId,
      selectedAnalogueIdentityIds: gate25Selection.frozenSelection.analogues.map((entry) => entry.analogueIdentityId),
      supportReportId: gate25Selection.supportReportId,
      instrumentIdentityId: gate25Selection.query.instrumentIdentityId,
      featureDatasetId: gate25Selection.query.featureDatasetId,
      sourceBindingId: gate25Selection.query.sourceBindingId,
    },
    control: {
      sessionDate: control.sessionDate,
      eligibleCount: controlSelection.supportReport.eligibleCount,
      decision: controlCombined.decision,
      horizonAbstentions: controlCombined.horizons.map((horizon) => `${horizon.sessionCount}:${horizon.outcomeAvailability}:${horizon.abstention.decision}`),
      availableOutcomes: controlSelection.outcomeSet.records.filter((record) => record.outcomeStatus === 'AVAILABLE').length,
      leakage,
      futureWindowsMissing,
      consumerDecision: controlConsumed.decision,
      consumerDataset: controlConsumed.verification.datasetIdObservation,
      canonicalRecordBytes: Buffer.byteLength(canonicalize(controlIndex.records[0]), 'utf8'),
    },
  };
  process.stdout.write(`${SUMMARY_PREFIX}${JSON.stringify(summary)}\n`);
}

/* ----------------------------------------------------------------------- parent */

function spawnChild() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=10240', THIS_FILE, '--child'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((item) => item.startsWith(SUMMARY_PREFIX));
      if (code !== 0 || line === undefined) reject(new Error(`CHILD_FAILED ${code}\n${stderr}\n${stdout}`));
      else resolvePromise(JSON.parse(line.slice(SUMMARY_PREFIX.length)));
    });
  });
}

async function runParent() {
  let assertions = 0;
  const check = (fn) => { fn(); assertions += 1; };
  const refuse = (fn, code) => check(() => assert.throws(fn, (error) => error?.code === code, `expected ${code}`));
  const { sha256Bytes, sha256Canonical } = await import('../../../tools/canonical-json.mjs');
  const { referenceCandidates, runFixture, fixtureOutcomeSource } = await import('../../GATE25/tests/gate25-foundation.test.mjs');
  const { combineFrozenSelection, loadGate26MiniBuildAuthority } = await import('../implementation/predictive-ensemble-engine-v1.mjs');
  const { fixtureInputBinding } = await import('./gate26-foundation.test.mjs');
  const { MINI_PRODUCT_PATHS_V1 } = await import('../implementation/mini-fixture-v1.mjs');

  /* Engine-level replay and leakage on fixture selections. */
  const authority = loadGate26MiniBuildAuthority({ root: ROOT });
  const inputBinding = fixtureInputBinding();
  const base = runFixture({ candidates: referenceCandidates() });
  const first = combineFrozenSelection({ authority, selection: base, inputBinding });
  const second = combineFrozenSelection({ authority, selection: runFixture({ candidates: referenceCandidates() }), inputBinding });
  check(() => assert.equal(first.identity.ensembleIdentityId, second.identity.ensembleIdentityId));
  check(() => assert.equal(sha256Canonical(first.horizons), sha256Canonical(second.horizons)));
  check(() => assert.equal(first.provenance.provenanceId, second.provenance.provenanceId));
  refuse(() => combineFrozenSelection({ authority, inputBinding, selection: { ...base, frozenSelection: { ...base.frozenSelection, selectionDigest: '0'.repeat(64), selectionComplete: true } } }), 'LEAKAGE_ATTEMPT');
  refuse(() => combineFrozenSelection({ authority, inputBinding, selection: { ...base, frozenSelection: { ...base.frozenSelection, selectionComplete: false } } }), 'LEAKAGE_ATTEMPT');
  /* An outcome that becomes available one millisecond after the cutoff is MISSING and cannot turn ABSTAIN into PROCEED. */
  const late = new Date(Date.parse(base.query.knowledgeCutoff) + 1).toISOString();
  const values = new Map(base.frozenSelection.analogues.flatMap((analogue) => base.horizonBindings.map((binding) => [`${analogue.analogueIdentityId}|${binding.horizonId}`, 0.05])));
  const future = runFixture({ candidates: referenceCandidates(), outcomeSource: fixtureOutcomeSource({ values, availableAt: late }) });
  check(() => assert.equal(future.outcomeSet.records.filter((record) => record.outcomeStatus === 'AVAILABLE').length, 0));
  check(() => assert.equal(combineFrozenSelection({ authority, selection: future, inputBinding }).decision, 'ABSTAIN'));
  const onTime = runFixture({ candidates: referenceCandidates(), outcomeSource: fixtureOutcomeSource({ values, availableAt: base.query.knowledgeCutoff }) });
  check(() => assert.equal(combineFrozenSelection({ authority, selection: onTime, inputBinding }).decision, 'PROCEED'));
  const proofWithFutureInput = { ...base, inputProofs: base.inputProofs.map((proof, index) => (index === 0 ? { ...proof, availableAt: late, availableByCutoff: false } : proof)) };
  refuse(() => combineFrozenSelection({ authority, selection: proofWithFutureInput, inputBinding }), 'LEAKAGE_ATTEMPT');

  /* Real-data replay. */
  const summary = await spawnChild();
  check(() => assert.deepEqual(summary.networkCalls, []));
  for (const path of MINI_PRODUCT_PATHS_V1) {
    check(() => assert.equal(summary.productSha256[path], sha256Bytes(readFileSync(resolve(ROOT, path))), path));
  }
  const gate25Mandate = JSON.parse(readFileSync(resolve(ROOT, 'governance/sources/GATE25_CANONICAL_MANDATE_R0.json'), 'utf8'));
  check(() => assert.equal(summary.datasetId, `sha256:${sha256Bytes(readFileSync(gate25Mandate.historyPolicy.pinSet.artifactPath))}`));
  check(() => assert.equal(summary.proofsAfterCutoff, 0));
  for (const item of summary.anchorCausality) {
    check(() => assert.ok(item.availableTotal <= item.windowsEndingByT, item.caseId));
  }
  /* The all-horizons-MISSING anchor is explained by causality alone: no analogue horizon window ends by T. */
  check(() => assert.ok(summary.anchorCausality.some((item) => item.analogueCount >= 2 && item.availableTotal === 0 && item.windowsEndingByT === 0)));

  const gate25Provenance = JSON.parse(readFileSync(resolve(ROOT, 'data/jarvise/historical-analogue/GATE25/V1/PROVENANCE.json'), 'utf8'));
  check(() => assert.equal(summary.gate25CrossCheck.queryIdentityId, gate25Provenance.queryIdentityId));
  check(() => assert.deepEqual(summary.gate25CrossCheck.selectedAnalogueIdentityIds, gate25Provenance.selectedAnalogueIdentityIds));
  check(() => assert.equal(summary.gate25CrossCheck.supportReportId, gate25Provenance.supportReportId));
  check(() => assert.equal(summary.gate25CrossCheck.instrumentIdentityId, gate25Provenance.instrumentIdentityId));
  check(() => assert.equal(summary.gate25CrossCheck.featureDatasetId, gate25Provenance.featureDatasetId));
  check(() => assert.equal(summary.gate25CrossCheck.sourceBindingId, gate25Provenance.sourceBindingId));

  check(() => assert.ok(summary.control.eligibleCount >= 2));
  check(() => assert.ok(summary.control.availableOutcomes > 0));
  check(() => assert.equal(summary.control.leakage, 0));
  check(() => assert.ok(summary.control.futureWindowsMissing > 0));
  check(() => assert.equal(summary.control.decision, 'PROCEED'));
  check(() => assert.equal(summary.control.consumerDecision, 'CONSUME'));
  check(() => assert.equal(summary.control.consumerDataset, summary.datasetId));

  console.log(`GATE26_REPLAY_PASS ${assertions} control=${summary.control.sessionDate} ${summary.control.horizonAbstentions.join(',')}`);
}

if (process.argv.includes('--child')) await runChild();
else await runParent();
