/**
 * GATE26 FULL PREBUILD — positive contract tests (R0003 G26-PREBUILD-POS-01..03).
 *
 * Expectations are read from independent sources: the R0003 contract bytes, the pinned
 * GATE25 index parsed here without the module under test, .gitattributes and the
 * published MINI report. Materialization runs only on bounded synthetic cohorts under
 * the OS temp directory. Nothing here writes inside the repository, no FULL product
 * byte is created and every network surface is trapped for the whole run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256Bytes } from '../../../tools/canonical-json.mjs';
import { installNetworkTrap } from '../implementation/mini-fixture-v1.mjs';
import { loadGate26MiniBuildAuthority } from '../implementation/predictive-ensemble-engine-v1.mjs';
import { consumePublishedEnsemble } from '../implementation/consumption-boundary-v1.mjs';
import {
  CURRENT_CONTRACT_POINTER_PATH, FULL_BINDING_ARTIFACT_PATHS_V1, PREBUILD_REHEARSAL_REPORT_PATH_V1, R0003_CONTRACT_PATH, SOURCE_CHUNK_BYTES_V1,
  deriveCanonicalFullQueryCohort, loadFullPrebuildAuthority, pageFileName,
} from '../implementation/full-query-cohort-v1.mjs';
import {
  FAULT_POINTS_V1, FULL_LFS_RULE_V1, FULL_MANIFEST_FILE_V1, PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1, assertFullBindingsMatchCode,
  prepareRehearsalCohort, runPagedMaterialization, simulatedCrashAt,
} from '../implementation/full-paged-materializer-v1.mjs';
import {
  consumeFullProductDirectory, describeFullConsumer, lookupFullQuery, openFullProductDirectory, refuseWheelScanFullParse,
} from '../implementation/full-consumer-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
const CONTRACT_BYTES = fs.readFileSync(path.resolve(ROOT, R0003_CONTRACT_PATH));
const CONTRACT = JSON.parse(CONTRACT_BYTES.toString('utf8'));
const requirement = (id) => CONTRACT.canonicalRequirements.find((entry) => entry.requirementId === id).binding;
const FULL_ROOT = path.resolve(ROOT, CONTRACT.packagingRequirements.fullProductRoot);
const networkCalls = installNetworkTrap();
const WORK = path.join(os.tmpdir(), 'wheel-gee', `gate26-full-prebuild-test-${process.pid}`);
const refusesWith = (fn, code) => assert.throws(fn, (error) => error?.code === code, `expected ${code}`);

test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));

let shared = null;
const cohort = () => {
  shared ??= prepareRehearsalCohort({ root: ROOT, workRoot: path.join(WORK, 'cohort'), queryCount: 300, maxPrefixGroupSize: 16, retainUnits: true });
  return shared;
};
const materialize = (runName, extra = {}, prepared = cohort()) => runPagedMaterialization({
  root: ROOT, sourcePath: prepared.sourcePath, cohort: prepared.cohort, producer: prepared.producer, inputBinding: prepared.seed.inputBinding,
  outputRoot: path.join(WORK, runName, 'product'), checkpointRoot: path.join(WORK, runName, 'checkpoint'), ...extra,
});
const productDigests = (runName) => {
  const directory = path.join(WORK, runName, 'product');
  return Object.fromEntries(fs.readdirSync(directory).map((file) => [file, sha256Bytes(fs.readFileSync(path.join(directory, file)))]));
};
let continuousRun = null;
const continuous = () => { continuousRun ??= materialize('continuous'); return continuousRun; };
const policyVersionId = () => loadGate26MiniBuildAuthority({ root: ROOT }).policy.combinationPolicyVersionId;

test('POS-01: the exact 68562-query cohort derives from the canonical ordered GATE25 records in one bounded stream', () => {
  const r02 = requirement('G26-PREBUILD-02');
  const r04 = requirement('G26-PREBUILD-04');
  const indexInput = CONTRACT.requiredInputs.find((input) => input.role === 'CANONICAL_G25_QUERY_COHORT_LFS_CONTENT');
  const counters = {};
  const derived = deriveCanonicalFullQueryCohort({ root: ROOT, counters });
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  assert.ok(peakRssBytes < derived.sourceByteLength, `streaming derivation peak RSS ${peakRssBytes} must stay below the ${derived.sourceByteLength}-byte source`);

  const bytes = fs.readFileSync(path.resolve(ROOT, indexInput.path));
  assert.equal(sha256Bytes(bytes), indexInput.sha256);
  assert.equal(derived.sourceSha256, indexInput.sha256);
  const ids = JSON.parse(bytes.toString('utf8')).records.map((record) => record.analogueIdentityId);
  assert.equal(ids.length, r02.queryCount);
  assert.equal(derived.queryCount, r02.queryCount);
  for (let index = 1; index < ids.length; index += 1) assert.ok(ids[index] > ids[index - 1], `strict ascending order at ${index}`);
  const digest = createHash('sha256').update('GATE26_FULL_QUERY_COHORT_V1\n', 'utf8');
  for (const id of ids) digest.update(`${id}\n`, 'utf8');
  assert.equal(derived.cohortDigest, digest.digest('hex'));
  assert.equal(derived.firstAnalogueIdentityId, ids[0]);
  assert.equal(derived.lastAnalogueIdentityId, ids.at(-1));

  assert.equal(derived.plan.pageSize, r04.pageSize);
  assert.equal(derived.plan.pageCount, r04.ensemblePageCount);
  assert.equal(derived.plan.pageCount, r04.provenancePageCount);
  assert.equal(derived.plan.lastPageRecordCount, r02.queryCount - (r04.ensemblePageCount - 1) * r04.pageSize);
  assert.equal(derived.plan.lastPageRecordCount, 82);
  let nextOrdinal = 1;
  for (const page of derived.plan.pages) {
    assert.equal(page.firstQueryOrdinal, nextOrdinal);
    assert.ok(page.recordCount >= 1 && page.recordCount <= r04.pageSize);
    assert.equal(page.lastQueryOrdinal, page.firstQueryOrdinal + page.recordCount - 1);
    assert.equal(page.firstAnalogueIdentityId, ids[page.firstQueryOrdinal - 1]);
    assert.equal(page.lastAnalogueIdentityId, ids[page.lastQueryOrdinal - 1]);
    nextOrdinal = page.lastQueryOrdinal + 1;
  }
  assert.equal(nextOrdinal - 1, r02.queryCount, 'pages partition 1..Q exactly once');
  const slots = derived.plan.pages.reduce((sum, page) => sum + page.recordCount, 0);
  assert.equal(slots, r04.ensembleRecordCount, 'one ensemble slot per query');
  assert.equal(slots, r04.provenanceRecordCount, 'one provenance slot per query');
  assert.equal(1 + 2 * derived.plan.pageCount, r04.futureFullProductFileCount);

  assert.deepEqual({ ...counters }, {
    bytesRead: bytes.length, chunks: Math.ceil(bytes.length / SOURCE_CHUNK_BYTES_V1), recordsScanned: r02.queryCount,
    idComparisons: r02.queryCount - 1, recordVerifications: r02.queryCount, digestUpdates: r02.queryCount,
  });
  assert.equal(fs.existsSync(FULL_ROOT), false);
});

test('R0003 is the read authority: PREBUILD-only, 13 exact paths, bindings bound to its bytes', () => {
  const authority = loadFullPrebuildAuthority({ root: ROOT });
  assert.equal(authority.contract.sha256, sha256Bytes(CONTRACT_BYTES));
  assert.equal(readJson(CURRENT_CONTRACT_POINTER_PATH).contractSha256, sha256Bytes(CONTRACT_BYTES));
  assert.deepEqual([...authority.authorizedPaths], CONTRACT.authorizedPaths);
  assert.equal(CONTRACT.authorizedPaths.length, 13);
  assert.equal(authority.productFilesAuthorized, false);
  assert.equal(authority.productFilesAuthorized, CONTRACT.packagingRequirements.productFilesAuthorizedUnderThisRevision);
  assert.equal(authority.fullProductionAuthorized, false);
  assert.ok(CONTRACT.forbiddenReplays.includes('GATE26 FULL production generation'));
  assert.equal(requirement('G26-PREBUILD-04').productionUnderR0003, 'FORBIDDEN');
  assert.ok(assertFullBindingsMatchCode(authority));
  for (const file of Object.values(FULL_BINDING_ARTIFACT_PATHS_V1)) {
    assert.ok(CONTRACT.authorizedPaths.includes(file), file);
    assert.equal(readJson(file).authority.executionContractSha256, sha256Bytes(CONTRACT_BYTES));
  }
  for (const file of [
    'governance/gates/GATE26/implementation/full-query-cohort-v1.mjs', 'governance/gates/GATE26/implementation/full-paged-materializer-v1.mjs',
    'governance/gates/GATE26/implementation/full-checkpoint-v1.mjs', 'governance/gates/GATE26/implementation/full-consumer-v1.mjs',
    'governance/gates/GATE26/tests/gate26-full-prebuild.test.mjs', 'governance/gates/GATE26/tests/gate26-full-prebuild-hostiles.test.mjs',
    PREBUILD_REHEARSAL_REPORT_PATH_V1,
  ]) {
    assert.ok(CONTRACT.authorizedPaths.includes(file), file);
  }
  assert.ok(CONTRACT.validators.some((command) => command.includes('gate26-full-prebuild.test.mjs') && command.includes('gate26-full-prebuild-hostiles.test.mjs')));
  assert.equal(FULL_LFS_RULE_V1, CONTRACT.packagingRequirements.lfsRule);
});

test('POS-02: paired pages cover every query exactly once, ABSTAIN retained, identities deterministic', () => {
  const prepared = cohort();
  const first = continuous();
  const second = materialize('second');
  assert.equal(first.target, 'OFF_REPOSITORY_REHEARSAL');
  assert.equal(first.cohortKind, 'PREBUILD_REHEARSAL');
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.deepEqual(productDigests('second'), productDigests('continuous'));
  const files = productDigests('continuous');
  assert.equal(Object.keys(files).length, 1 + 2 * prepared.cohort.plan.pageCount);
  assert.equal(first.counters.producerCalls, prepared.cohort.queryCount);
  assert.equal(first.counters.recordValidations, prepared.cohort.queryCount);
  assert.equal(first.counters.pageSerializations, 2 * prepared.cohort.plan.pageCount);

  const consumed = consumeFullProductDirectory({
    productRoot: path.join(WORK, 'continuous', 'product'), expectedManifestSha256: first.manifestSha256, expectedCombinationPolicyVersionId: policyVersionId(),
    expectedCohortDigest: prepared.cohort.cohortDigest, expectedQueryCount: prepared.cohort.queryCount, collectQueryIds: true,
  });
  assert.deepEqual(consumed.queryIds, prepared.cohort.units.map((unit) => unit.analogueIdentityId));
  assert.equal(new Set(consumed.ensembleIdentityIds).size, prepared.cohort.queryCount);
  assert.ok(consumed.decisions['ABSTAIN:INSUFFICIENT_SUPPORT'] > 0);
  assert.ok(consumed.decisions['ABSTAIN:PREDICTIVE_FAMILY_MISSING'] > 0);
  assert.ok(consumed.decisions['CONSUME:NONE'] > 0);
  assert.equal(Object.values(consumed.decisions).reduce((sum, count) => sum + count, 0), prepared.cohort.queryCount);

  const manifest = JSON.parse(fs.readFileSync(path.join(WORK, 'continuous', 'product', FULL_MANIFEST_FILE_V1), 'utf8'));
  assert.equal(manifest.producedUnder.contractRevision, 'R0003');
  assert.equal(manifest.producedUnder.contractSha256, sha256Bytes(CONTRACT_BYTES));
  for (const entry of manifest.pages) {
    assert.equal(files[entry.ensemble.path], entry.ensemble.sha256);
    assert.equal(files[entry.provenance.path], entry.provenance.sha256);
    assert.equal(entry.ensemble.lfsOid, entry.ensemble.sha256);
    assert.equal(entry.provenance.lfsOid, entry.provenance.sha256);
  }
});

test('POS-02: a crash at every fault point resumes from the durable checkpoint, never from zero, byte-identical', () => {
  const prepared = cohort();
  const { plan } = prepared.cohort;
  const reference = productDigests('continuous');
  const recordsBefore = (pages) => plan.pages.slice(0, pages).reduce((sum, page) => sum + page.recordCount, 0);
  const cases = [
    ['BEFORE_PAIR', 2, 1], ['AFTER_ENSEMBLE_PAGE', 2, 1], ['AFTER_PROVENANCE_PAGE', 2, 1], ['AFTER_PAIR_COMMIT', 2, 2],
    ['BEFORE_MANIFEST', plan.pageCount, plan.pageCount], ['AFTER_MANIFEST', plan.pageCount, plan.pageCount],
  ];
  assert.deepEqual(cases.map(([point]) => point), [...FAULT_POINTS_V1]);
  for (const [point, pageNumber, committedAtStart] of cases) {
    const runName = `crash-${point}`;
    refusesWith(() => materialize(runName, { faultInjector: simulatedCrashAt(point, pageNumber) }), 'SIMULATED_CRASH');
    const resumed = materialize(runName);
    assert.equal(resumed.committedAtStart, committedAtStart, point);
    assert.equal(resumed.counters.producerCalls, prepared.cohort.queryCount - recordsBefore(committedAtStart), `${point}: only uncommitted pages are produced`);
    assert.equal(resumed.counters.committedPagesReverified, committedAtStart);
    if (['AFTER_ENSEMBLE_PAGE', 'AFTER_PROVENANCE_PAGE', 'AFTER_MANIFEST'].includes(point)) assert.ok(resumed.counters.existingVerified >= 1, `${point}: frontier bytes reused only because identical`);
    assert.equal(resumed.manifestSha256, continuous().manifestSha256, point);
    assert.deepEqual(productDigests(runName), reference, point);
  }
});

test('POS-02: a killed process (reboot) resumes in a new process from its durable checkpoint', () => {
  const prepared = cohort();
  const child = path.join(WORK, 'reboot-child.mjs');
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(child, [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'const [root, workRoot, runRoot] = process.argv.slice(2);',
    "const m = await import(pathToFileURL(path.join(root, 'governance/gates/GATE26/implementation/full-paged-materializer-v1.mjs')).href);",
    'const p = m.prepareRehearsalCohort({ root, workRoot, queryCount: 300, maxPrefixGroupSize: 16 });',
    "m.runPagedMaterialization({ root, sourcePath: p.sourcePath, cohort: p.cohort, producer: p.producer, inputBinding: p.seed.inputBinding, outputRoot: path.join(runRoot, 'product'), checkpointRoot: path.join(runRoot, 'checkpoint'), faultInjector: (point, page) => { if (point === 'AFTER_ENSEMBLE_PAGE' && page === 2) process.exit(137); } });",
  ].join('\n'));
  const killed = spawnSync(process.execPath, [child, ROOT, path.join(WORK, 'reboot-cohort'), path.join(WORK, 'reboot')], { encoding: 'utf8' });
  assert.equal(killed.status, 137, killed.stderr);
  const resumed = materialize('reboot');
  assert.equal(resumed.staleLockRecovered?.pid, killed.pid);
  assert.equal(resumed.committedAtStart, 1);
  assert.ok(resumed.counters.existingVerified >= 1);
  assert.equal(resumed.counters.producerCalls, prepared.cohort.queryCount - prepared.cohort.plan.pages[0].recordCount);
  assert.deepEqual(productDigests('reboot'), productDigests('continuous'));
});

test('POS-02: a duplicate resume after completion re-verifies and writes nothing', () => {
  continuous();
  const directory = path.join(WORK, 'continuous', 'product');
  const before = Object.fromEntries(fs.readdirSync(directory).map((file) => [file, fs.statSync(path.join(directory, file)).mtimeMs]));
  const again = materialize('continuous');
  assert.equal(again.alreadyFinal, true);
  assert.equal(again.counters.fileWrites, 0);
  assert.equal(again.counters.producerCalls, 0);
  assert.equal(again.checkpointRevisionWrites, 0);
  assert.equal(again.manifestSha256, continuous().manifestSha256);
  const after = Object.fromEntries(fs.readdirSync(directory).map((file) => [file, fs.statSync(path.join(directory, file)).mtimeMs]));
  assert.deepEqual(after, before);
});

test('POS-03: the bounded consumer verifies the manifest first and serves a query from exactly one page pair', () => {
  const prepared = cohort();
  const run = continuous();
  const productRoot = path.join(WORK, 'continuous', 'product');
  const expected = { expectedManifestSha256: run.manifestSha256, expectedCombinationPolicyVersionId: policyVersionId() };
  const { opened, readPagePair } = openFullProductDirectory({ productRoot, ...expected });
  let reads = 0;
  const counting = (pageNumber) => { reads += 1; return readPagePair(pageNumber); };
  for (const unit of [prepared.cohort.units[0], prepared.cohort.units[150], prepared.cohort.units.at(-1)]) {
    reads = 0;
    const hit = lookupFullQuery({ opened, analogueIdentityId: unit.analogueIdentityId, readPagePair: counting });
    assert.equal(reads, 1);
    assert.equal(hit.queryAnalogueIdentityId, unit.analogueIdentityId);
    assert.equal(hit.pageNumber, Math.ceil(unit.ordinal / prepared.cohort.plan.pageSize));
  }
  refusesWith(() => lookupFullQuery({ opened, analogueIdentityId: '0'.repeat(64), readPagePair: counting }), 'QUERY_NOT_IN_COHORT');

  const consumed = consumeFullProductDirectory({ productRoot, ...expected });
  const totalBytes = fs.readdirSync(productRoot).reduce((sum, file) => sum + fs.statSync(path.join(productRoot, file)).size, 0);
  const manifestBytes = fs.statSync(path.join(productRoot, FULL_MANIFEST_FILE_V1)).size;
  assert.equal(consumed.maxBytesHeldAtOnce, consumed.largestPagePairBytes + manifestBytes);
  assert.ok(consumed.maxBytesHeldAtOnce < totalBytes, 'never more than one page pair plus the manifest');
  assert.equal(describeFullConsumer().wholeProductParse, 'FORBIDDEN');
  refusesWith(() => refuseWheelScanFullParse(), 'WHEEL_SCAN_FULL_PARSE_FORBIDDEN');
});

test('LFS transport invariants: one exact rule, OID is the content SHA-256, no pointer is ever written', () => {
  const r09 = requirement('G26-PREBUILD-09');
  const gitattributes = fs.readFileSync(path.resolve(ROOT, '.gitattributes'));
  assert.equal(sha256Bytes(gitattributes), r09.gitattributesSha256);
  const rules = gitattributes.toString('utf8').split(/\r?\n/).filter((line) => line.trim() === FULL_LFS_RULE_V1);
  assert.equal(rules.length, r09.transportRuleCount);
  const attributes = execFileSync('git', ['-C', ROOT, 'check-attr', 'filter', '--', `${CONTRACT.packagingRequirements.fullProductRoot}/${pageFileName('ENSEMBLE', 1)}`], { encoding: 'utf8' });
  assert.match(attributes, /filter: lfs/);
  const productRoot = path.join(WORK, 'continuous', 'product');
  continuous();
  for (const file of fs.readdirSync(productRoot)) {
    assert.ok(!fs.readFileSync(path.join(productRoot, file)).subarray(0, 40).toString('utf8').startsWith('version https://git-lfs'), file);
  }
});

test('consumption-boundary extraction preserves the published MINI consumption results', () => {
  const report = readJson('data/jarvise/predictive-ensemble/GATE26/V1/MINI/REHEARSAL_REPORT.json');
  assert.equal(report.consumption.results.length, 2);
  for (const expected of report.consumption.results) {
    const consumed = consumePublishedEnsemble({
      root: ROOT, ensembleIdentityId: expected.ensembleIdentityId, expectedIndexSha256: report.publication.indexSha256,
      expectedProvenanceSha256: report.publication.provenanceSha256, expectedCombinationPolicyVersionId: policyVersionId(),
    });
    assert.equal(consumed.decision, expected.decision);
    assert.equal(consumed.abstainReason, expected.abstainReason);
    assert.equal(consumed.verification.provenanceId, expected.provenanceId);
  }
});

test('the PREBUILD rehearsal report is bounded, synthetic, resumable and PREBUILD-only', () => {
  const report = readJson(PREBUILD_REHEARSAL_REPORT_PATH_V1);
  assert.equal(report.schema, 'GATE26_FULL_PREBUILD_REHEARSAL_REPORT_V1');
  assert.equal(report.authority.contractSha256, sha256Bytes(CONTRACT_BYTES));
  assert.equal(report.authority.productFilesAuthorized, false);
  assert.equal(report.authority.fullProductionAuthorized, false);
  assert.equal(report.authority.fullProductBytesCreated, false);
  assert.equal(report.rehearsalInput.kind, 'BOUNDED_SYNTHETIC_SEEDED_BY_EXISTING_MINI_EVIDENCE');
  assert.equal(report.rehearsalInput.publishedGate25AnalogueIndexRead, false);
  assert.equal(report.rehearsalInput.yahoo, false);
  assert.equal(report.rehearsalInput.network.trapInstalled, true);
  assert.deepEqual(report.rehearsalInput.network.attemptedCalls, []);
  for (const evidence of report.rehearsalInput.miniEvidence) assert.equal(sha256Bytes(fs.readFileSync(path.resolve(ROOT, evidence.path))), evidence.sha256);
  assert.ok(report.syntheticCohort.queryCount <= PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1);
  assert.equal(report.syntheticCohort.pageCount, Math.ceil(report.syntheticCohort.queryCount / requirement('G26-PREBUILD-04').pageSize));
  assert.equal(report.determinism.continuousVsResumedByteIdentical, true);
  assert.ok(report.determinism.resumedFromCommittedPairs > 0);
  assert.equal(report.determinism.duplicateResume.fileWrites, 0);
  assert.equal(report.consumption.everyQueryExactlyOnceInCohortOrder, true);
  assert.equal(report.consumption.recordsVerified, report.syntheticCohort.queryCount);
  assert.equal(report.lfs.pointerOidEqualsContentSha256, true);
  const times = report.performance.pagePairTimeMs;
  assert.ok(times.p50 > 0 && times.p50 <= times.p95 && times.p95 <= times.max);
  assert.ok(report.performance.peakRssBytes > 0);
  assert.equal(report.residue.workRootRemoved, true);
  assert.deepEqual(report.closure, { agentClosureExecuted: false, externalConfirmationExecuted: false, independentAuditPassAssigned: false, phaseDAuthorized: false });
});

test('no FULL product path exists and no network call was attempted', () => {
  assert.equal(fs.existsSync(FULL_ROOT), false);
  assert.deepEqual(networkCalls, []);
});
