/**
 * GATE26 FULL PREBUILD — hostile contract tests (R0005 NEG-01..04, CTR-01..03).
 *
 * Every attack must fail closed with its exact code, and none may create a FULL
 * product byte. Attacks run against bounded synthetic cohorts and products under the
 * OS temp directory; repository files are only read. Forged products re-hash the
 * manifest so that each check is reached on its own, not masked by an earlier one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes } from '../../../tools/canonical-json.mjs';
import { validateStateSeal } from '../../../tools/validate-state-seal.mjs';
import { validateGateContractSuccessionLedgerBoundAuthorityShape } from '../../../gee-v1/core/gate-contract-succession-authority.mjs';
import { workUnitDirectoryName } from '../../../gee-v1/recovery/checkpoint-store.mjs';
import { installNetworkTrap } from '../implementation/mini-fixture-v1.mjs';
import { loadGate26MiniBuildAuthority } from '../implementation/predictive-ensemble-engine-v1.mjs';
import {
  FULL_BINDING_ARTIFACT_PATHS_V1, CURRENT_CONTRACT_POINTER_PATH, R0005_CONTRACT_PATH, deriveQueryCohort, evaluateR0005FullAuthorization, loadFullPrebuildAuthority, pageFileName,
} from '../implementation/full-query-cohort-v1.mjs';
import { FULL_CHECKPOINT_WORK_UNIT_V1, openFullCheckpoint } from '../implementation/full-checkpoint-v1.mjs';
import {
  FULL_MANIFEST_FILE_V1, PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1, assertNoFutureInputProof, buildSyntheticRehearsalSource, loadRehearsalSeed,
  prepareRehearsalCohort, runPagedMaterialization, simulatedCrashAt,
} from '../implementation/full-paged-materializer-v1.mjs';
import { consumeFullProductDirectory } from '../implementation/full-consumer-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const IMPLEMENTATION = path.join(ROOT, 'governance/gates/GATE26/implementation');
const CONTRACT = JSON.parse(fs.readFileSync(path.resolve(ROOT, R0005_CONTRACT_PATH), 'utf8'));
const FULL_ROOT = path.resolve(ROOT, CONTRACT.packagingRequirements.fullProductRoot);
const networkCalls = installNetworkTrap();
const WORK = path.join(os.tmpdir(), 'wheel-gee', `gate26-full-prebuild-hostiles-${process.pid}`);
const JUNCTION = path.join(WORK, 'junction', 'v1-link');
const refusesWith = (fn, code, reason = undefined) => assert.throws(fn, (error) => {
  if (error?.code !== code) return false;
  return reason === undefined || error.details?.reason === reason;
}, `expected ${code}${reason ? `/${reason}` : ''}`);
const noFullRoot = () => assert.equal(fs.existsSync(FULL_ROOT), false, 'no FULL product path may exist');

test.after(() => {
  if (fs.existsSync(JUNCTION)) { try { fs.unlinkSync(JUNCTION); } catch { fs.rmdirSync(JUNCTION); } }
  if (!fs.existsSync(JUNCTION)) fs.rmSync(WORK, { recursive: true, force: true });
});

const prepared = {};
const cohortOf = (name, queryCount = 300) => {
  prepared[name] ??= prepareRehearsalCohort({ root: ROOT, workRoot: path.join(WORK, `cohort-${name}`), queryCount, maxPrefixGroupSize: 16, retainUnits: true });
  return prepared[name];
};
const base = () => cohortOf('base');
const materialize = (runName, extra = {}, cohort = base()) => runPagedMaterialization({
  root: ROOT, sourcePath: cohort.sourcePath, cohort: cohort.cohort, producer: cohort.producer, inputBinding: cohort.seed.inputBinding,
  outputRoot: path.join(WORK, runName, 'product'), checkpointRoot: path.join(WORK, runName, 'checkpoint'), ...extra,
});
let baseRun = null;
const baseProduct = () => { baseRun ??= materialize('base'); return baseRun; };
const policy = () => loadGate26MiniBuildAuthority({ root: ROOT }).policy.combinationPolicyVersionId;
const checkpointDirectory = (runName) => path.join(WORK, runName, 'checkpoint', workUnitDirectoryName(FULL_CHECKPOINT_WORK_UNIT_V1));
const productDirectory = (runName) => path.join(WORK, runName, 'product');
const crashed = (runName, point, pageNumber) => {
  refusesWith(() => materialize(runName, { faultInjector: simulatedCrashAt(point, pageNumber) }), 'SIMULATED_CRASH');
};

/* ----------------------------------------------- R0005 authorization law */

test('R0005-AUTH-HOSTILES: every explicit predicate blocks for its intended cause and no R0004 fallback exists', () => {
  const requirementBinding = JSON.parse(JSON.stringify(CONTRACT.canonicalRequirements.find((entry) => entry.requirementId === 'G26-PREBUILD-04').binding));
  const packagingRequirements = JSON.parse(JSON.stringify(CONTRACT.packagingRequirements));
  const manifestBinding = JSON.parse(JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, FULL_BINDING_ARTIFACT_PATHS_V1.GATE26_FULL_MANIFEST_V1), 'utf8')).binding));
  const forbiddenReplays = [...CONTRACT.forbiddenReplays];
  const evaluate = (changes = {}) => evaluateR0005FullAuthorization({
    packagingRequirements: changes.packagingRequirements ?? packagingRequirements,
    requirementBinding: changes.requirementBinding ?? requirementBinding,
    manifestBinding: changes.manifestBinding ?? manifestBinding,
    forbiddenReplays: changes.forbiddenReplays ?? forbiddenReplays,
  });
  assert.deepEqual(evaluate(), { productFilesAuthorized: true, fullProductionAuthorized: true });
  const missingProduction = { ...requirementBinding };
  delete missingProduction.productionUnderR0005;
  refusesWith(() => evaluate({ requirementBinding: missingProduction }), 'R0005_PRODUCTION_AUTHORIZATION_MISSING');
  refusesWith(() => evaluate({ requirementBinding: { ...requirementBinding, productionUnderR0005: 'FORBIDDEN' } }), 'R0005_PRODUCTION_AUTHORIZATION_INVALID');
  const fallback = { ...missingProduction, productionUnderR0004: 'AUTHORIZED' };
  refusesWith(() => evaluate({ requirementBinding: fallback }), 'R0005_PRODUCTION_AUTHORIZATION_MISSING');
  const missingManifest = { ...manifestBinding };
  delete missingManifest.productFilesAuthorizedUnderR0005;
  refusesWith(() => evaluate({ manifestBinding: missingManifest }), 'FULL_BINDING_CROSS_CHECK_FAILED');
  refusesWith(() => evaluate({ packagingRequirements: { ...packagingRequirements, productFilesAuthorizedUnderThisRevision: false }, manifestBinding: { ...manifestBinding, productFilesAuthorizedUnderR0005: false } }), 'R0005_PRODUCT_FILES_NOT_AUTHORIZED');
  refusesWith(() => evaluate({ manifestBinding: { ...manifestBinding, productFilesAuthorizedUnderR0005: false } }), 'FULL_BINDING_CROSS_CHECK_FAILED');
  refusesWith(() => evaluate({ forbiddenReplays: [...forbiddenReplays, 'GATE26 FULL production generation'] }), 'R0005_FULL_PRODUCTION_REPLAY_FORBIDDEN');

  const fakeRoot = (name, mutate) => {
    const root = path.join(WORK, 'r0005-identity', name);
    for (const file of [CURRENT_CONTRACT_POINTER_PATH, R0005_CONTRACT_PATH, ...Object.values(FULL_BINDING_ARTIFACT_PATHS_V1)]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
    }
    const edit = (file, change) => {
      const value = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      change(value);
      fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
    };
    mutate(edit);
    return root;
  };
  refusesWith(() => loadFullPrebuildAuthority({ root: fakeRoot('wrong-revision', (edit) => edit(CURRENT_CONTRACT_POINTER_PATH, (value) => { value.contractRevision = 'R0004'; })) }), 'CURRENT_CONTRACT_NOT_R0005');
  refusesWith(() => loadFullPrebuildAuthority({ root: fakeRoot('wrong-pointer-sha', (edit) => edit(CURRENT_CONTRACT_POINTER_PATH, (value) => { value.contractSha256 = '0'.repeat(64); })) }), 'CURRENT_CONTRACT_NOT_R0005');
  refusesWith(() => loadFullPrebuildAuthority({ root: fakeRoot('wrong-contract-sha', (edit) => edit(R0005_CONTRACT_PATH, (value) => { value.contractRevision = 'R0004'; })) }), 'EXECUTION_CONTRACT_SHA256_MISMATCH');
});

test('R0005-CANDIDATE-HOSTILES: invalid R0006, competing authority, ledger 116 and extra path block non-vacuously', () => {
  const authorityPath = path.join(ROOT, 'governance/authority/authorizations/GATE26/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY_R0005.json');
  const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  assert.deepEqual(validateGateContractSuccessionLedgerBoundAuthorityShape(authority), { valid: true, findings: [] });
  const sealRelative = 'governance/gates/GATE26/state/revisions/R0006/STATE_SEAL.json';
  const sealPath = path.join(ROOT, sealRelative);
  assert.equal(validateStateSeal({ root: ROOT, sealPath, currentRevision: 'R0006' }).valid, true);
  const fakeRoot = path.join(WORK, 'invalid-r0006');
  for (const relative of [
    'governance/gates/GATE26/contracts/CURRENT_CONTRACT.json',
    'governance/gates/GATE26/state/revisions/R0005/STATE_SEAL.json',
    'governance/gates/GATE26/state/revisions/R0006/CHECKPOINT.json',
    'governance/gates/GATE26/state/revisions/R0006/OPEN_DEFECTS.json',
    sealRelative,
  ]) {
    fs.mkdirSync(path.dirname(path.join(fakeRoot, relative)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), path.join(fakeRoot, relative));
  }
  fs.appendFileSync(path.join(fakeRoot, 'governance/gates/GATE26/state/revisions/R0006/CHECKPOINT.json'), ' ');
  assert.equal(validateStateSeal({ root: fakeRoot, sealPath: path.join(fakeRoot, sealRelative), currentRevision: 'R0006' }).valid, false);

  const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
  const authorities = fs.readdirSync(path.dirname(authorityPath)).filter((file) => file.endsWith('.json')).map((file) => {
    try { return JSON.parse(fs.readFileSync(path.join(path.dirname(authorityPath), file), 'utf8')); } catch { return null; }
  }).filter((entry) => entry?.predecessorContractSha256 === 'eda92933595bc7f517cde4f964201c4f8b8725aa1b9d3f4a66a3ca32af111de4' && entry?.successorContractRevision === 'R0005');
  const assertUniqueAuthority = (entries) => { if (entries.length !== 1) fail('COMPETING_SUCCESSION_AUTHORITY'); };
  assert.doesNotThrow(() => assertUniqueAuthority(authorities));
  refusesWith(() => assertUniqueAuthority([...authorities, { ...authorities[0], authorityId: 'COMPETING' }]), 'COMPETING_SUCCESSION_AUTHORITY');

  const ledgerLines = fs.readFileSync(path.join(ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8').trimEnd().split(/\r?\n/);
  const assertPrepublicationLedger = (lines) => {
    if (lines.length !== 115 || lines.some((line) => line.includes('GATE26_CONTRACT_SUCCESSION_R0005_R1'))) fail('LEDGER_116_BEFORE_PUBLICATION');
  };
  assert.doesNotThrow(() => assertPrepublicationLedger(ledgerLines));
  refusesWith(() => assertPrepublicationLedger([...ledgerLines, '{"eventId":"GATE26_CONTRACT_SUCCESSION_R0005_R1"}']), 'LEDGER_116_BEFORE_PUBLICATION');

  const allowed = new Set([
    'governance/gates/GATE26/contracts/EXECUTION_CONTRACT_R0005.json',
    'governance/authority/authorizations/GATE26/GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY_R0005.json',
    'governance/gates/GATE26/state/revisions/R0006/CHECKPOINT.json',
    'governance/gates/GATE26/state/revisions/R0006/OPEN_DEFECTS.json',
    'governance/gates/GATE26/state/revisions/R0006/STATE_SEAL.json',
    'governance/gates/GATE26/contracts/CURRENT_CONTRACT.json',
    'governance/gates/GATE26/state/CURRENT_STATE.json',
    'governance/gates/GATE26/implementation/full-query-cohort-v1.mjs',
    'governance/gates/GATE26/contracts/GATE26_FULL_QUERY_COHORT_V1.json',
    'governance/gates/GATE26/contracts/GATE26_FULL_MANIFEST_V1.json',
    'governance/gates/GATE26/contracts/GATE26_FULL_ENSEMBLE_PAGE_V1.json',
    'governance/gates/GATE26/contracts/GATE26_FULL_PROVENANCE_PAGE_V1.json',
    'governance/gates/GATE26/contracts/GATE26_FULL_CHECKPOINT_V1.json',
    'governance/gates/GATE26/contracts/GATE26_FULL_PRODUCTION_PRODUCER_V1.json',
    'governance/gates/GATE26/tests/gate26-full-prebuild.test.mjs',
    'governance/gates/GATE26/tests/gate26-full-prebuild-hostiles.test.mjs',
  ]);
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(status.status, 0);
  const actual = status.stdout.trimEnd().split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replaceAll('\\', '/'));
  const assertExactPathset = (paths) => {
    if (paths.length !== allowed.size || paths.some((entry) => !allowed.has(entry))) fail('EXTRA_PATH_OUTSIDE_AUTHORITY');
  };
  assert.doesNotThrow(() => assertExactPathset(actual));
  refusesWith(() => assertExactPathset([...actual, 'governance/gates/GATE26/EXTRA']), 'EXTRA_PATH_OUTSIDE_AUTHORITY');
});

/* ------------------------------------------------------------ NEG-01: complexity */

test('NEG-01: the FULL path never sorts, never re-copies per append and never touches the universe U', () => {
  const read = (file) => fs.readFileSync(path.join(IMPLEMENTATION, file), 'utf8');
  const materializer = read('full-paged-materializer-v1.mjs');
  const marker = '/* ------------------------------------------------------- PREBUILD rehearsal */';
  assert.equal(materializer.split(marker).length, 2);
  const hotPaths = {
    'full-query-cohort-v1.mjs': read('full-query-cohort-v1.mjs'),
    'full-checkpoint-v1.mjs': read('full-checkpoint-v1.mjs'),
    'full-consumer-v1.mjs': read('full-consumer-v1.mjs'),
    'full-paged-materializer-v1.mjs#core': materializer.split(marker)[0],
  };
  for (const [file, source] of Object.entries(hotPaths)) {
    assert.doesNotMatch(source, /\.sort\(/, `${file}: sort`);
    assert.doesNotMatch(source, /(?<!Buffer)\.concat\(/, `${file}: array concat`);
    assert.doesNotMatch(source, /(\w+)\s*=\s*\[\s*\.\.\.\1\b/, `${file}: copy-on-append`);
  }
  for (const file of ['full-query-cohort-v1.mjs', 'full-checkpoint-v1.mjs', 'full-consumer-v1.mjs', 'full-paged-materializer-v1.mjs']) {
    assert.doesNotMatch(read(file), /prepareP3hHistoricalUniverse|iterateP3hCandidates|runAnalogueSelection|loadP3hDatasetBinding|historical-analogue-engine-v1/, file);
  }
});

test('NEG-01: work is exactly linear in Q and P (instrumented operation counts)', () => {
  const runs = [['linear-150', cohortOf('q150', 150)], ['linear-300', base()]];
  for (const [runName, cohort] of runs) {
    const { queryCount } = cohort.cohort;
    const { pageCount } = cohort.cohort.plan;
    const result = materialize(runName, {}, cohort);
    assert.equal(result.counters.producerCalls, queryCount);
    assert.equal(result.counters.recordValidations, queryCount);
    assert.equal(result.counters.pageSerializations, 2 * pageCount);
    assert.equal(result.counters.manifestSerializations, 1);
    assert.equal(result.counters.sha256Computations, 2 * pageCount + 1);
    assert.equal(result.counters.fileWrites, 2 * pageCount + 1);
    assert.equal(result.counters.scan.recordsScanned, queryCount);
    assert.equal(result.counters.scan.idComparisons, queryCount - 1);
    assert.equal(result.checkpointRevisionWrites, pageCount + 1);
  }
});

/* ------------------------------------------------- source corruption (fail closed) */

test('invalid, reordered, duplicated or drifting source records fail closed and are never repaired or sorted', () => {
  const cohort = base();
  const clean = cohort.fixture.sourceBytes;
  const parsed = () => JSON.parse(clean.toString('utf8'));
  const derive = (name, bytes, overrides = {}) => {
    const file = path.join(WORK, 'sources', `${name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return () => deriveQueryCohort({
      path: file, sourceLabel: 'SYNTHETIC:HOSTILE', expectedSha256: sha256Bytes(bytes), expectedQueryCount: 300,
      expectedDatasetId: cohort.seed.inputBinding.datasetId, pageSize: 128, ...overrides,
    });
  };
  const text = clean.toString('utf8');
  const swapped = parsed(); [swapped.records[0], swapped.records[1]] = [swapped.records[1], swapped.records[0]];
  const duplicated = parsed(); duplicated.records[1] = duplicated.records[0];
  const tampered = parsed(); tampered.records[0].orderedMembers[1].value = '2015-01-06';
  const counted = parsed(); counted.recordCount = 301;
  const omitted = parsed(); omitted.records.pop();
  const cases = [
    ['truncated', clean.subarray(0, clean.length - 10), 'SOURCE_TRUNCATED'],
    ['trailing', Buffer.concat([clean, Buffer.from('\n')]), 'TRAILING_BYTES_AFTER_ENVELOPE'],
    ['separator', Buffer.from(text.replace('},{"analogueIdentityId"', '}, {"analogueIdentityId"')), 'RECORD_SEPARATOR_INVALID'],
    ['non-canonical', Buffer.from(text.replace('"coreV1RegimeFactors":[', '"coreV1RegimeFactors": [')), 'RECORD_NOT_CANONICAL'],
    ['reordered', Buffer.from(canonicalize(swapped)), 'CANONICAL_ORDER_VIOLATED'],
    ['duplicated', Buffer.from(canonicalize(duplicated)), 'DUPLICATE_QUERY_IDENTITY'],
    ['tampered', Buffer.from(canonicalize(tampered)), 'RECORD_STRUCTURALLY_INVALID'],
    ['count', Buffer.from(canonicalize(counted)), 'ENVELOPE_RECORD_COUNT_MISMATCH'],
    ['omitted', Buffer.from(canonicalize(omitted)), 'ENVELOPE_RECORD_COUNT_MISMATCH'],
  ];
  for (const [name, bytes, reason] of cases) refusesWith(derive(name, bytes), 'SOURCE_PRODUCT_CORRUPTION', reason);
  refusesWith(derive('sha', clean, { expectedSha256: '0'.repeat(64) }), 'SOURCE_SHA256_MISMATCH');
  refusesWith(derive('cardinality', clean, { expectedQueryCount: 299 }), 'QUERY_CARDINALITY_MISMATCH');
  refusesWith(derive('dataset', clean, { expectedDatasetId: `sha256:${'a'.repeat(64)}` }), 'SOURCE_DATASET_MISMATCH');

  const drifting = cohortOf('drift');
  fs.writeFileSync(drifting.sourcePath, cohortOf('q150', 150).fixture.sourceBytes);
  refusesWith(() => materialize('drift', {}, drifting), 'SOURCE_DRIFT_DURING_MATERIALIZATION');
  noFullRoot();
});

/* ---------------------------------------------- CTR-01: exactly one output per query */

test('CTR-01: an omitted ABSTAIN, a second output, a foreign record or a forced PROCEED fails closed', () => {
  const cohort = base();
  const wrap = (transform) => {
    let previous = null;
    return {
      ...cohort.producer,
      produce: (unit, record) => {
        const output = cohort.producer.produce(unit, record);
        const result = transform(output, previous);
        previous = output;
        return result;
      },
    };
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    ['omit-abstain', (output) => (output.ensembleRecord.decision === 'ABSTAIN' ? null : output), 'QUERY_OUTPUT_MISSING'],
    ['two-outputs', (output) => [output, output], 'QUERY_OUTPUT_NOT_EXACTLY_ONE'],
    ['extra-key', (output) => ({ ...output, note: 'x' }), 'QUERY_OUTPUT_NOT_EXACTLY_ONE'],
    ['foreign-record', (output, previous) => previous ?? output, 'QUERY_RECORD_IDENTITY_MISMATCH'],
    ['foreign-provenance', (output, previous) => (previous ? { ensembleRecord: output.ensembleRecord, provenanceRecord: previous.provenanceRecord } : output), 'PROVENANCE_PAIRING_MISMATCH'],
    ['forced-proceed', (output) => {
      if (output.ensembleRecord.decision !== 'ABSTAIN') return output;
      const forced = clone(output.ensembleRecord);
      forced.decision = 'PROCEED';
      forced.abstention = { decision: 'PROCEED', reason: null };
      return { ensembleRecord: forced, provenanceRecord: output.provenanceRecord };
    }, 'FORCED_NON_ABSTENTION_FORBIDDEN'],
  ];
  for (const [name, transform, code] of cases) {
    refusesWith(() => materialize(`ctr01-${name}`, { producer: wrap(transform) }), code);
    assert.equal(fs.readdirSync(productDirectory(`ctr01-${name}`)).length, 0, `${name}: nothing committed`);
  }
});

test('NO_FUTURE_LEAKAGE: an analogue or input proof from after the query cutoff is refused', () => {
  refusesWith(() => assertNoFutureInputProof({
    knowledgeCutoff: '2020-01-02T20:00:00.000Z',
    inputProofs: [{ inputId: 'X', knowledgeCutoff: '2020-01-03T20:00:00.000Z', availableAt: '2020-01-03T20:00:00.000Z' }],
  }), 'FUTURE_LEAKAGE_REFUSED');
  const leaking = cohortOf('leak');
  const entries = [...leaking.fixture.cohorts.entries()].filter(([, entry]) => entry.group === 0);
  const [queryId] = entries.find(([, entry]) => entry.position === 0);
  const [futureId] = entries.find(([, entry]) => entry.position === 5);
  leaking.fixture.cohorts.get(queryId).analogues = [leaking.fixture.byId.get(futureId)];
  refusesWith(() => materialize('leak', {}, leaking), 'FUTURE_LEAKAGE_REFUSED');
});

/* ------------------------------------------------------------ checkpoint hostiles */

test('checkpoint: a tampered, non-canonical or missing revision fails closed with no silent fallback', () => {
  const tamper = (runName, change) => {
    crashed(runName, 'AFTER_PAIR_COMMIT', 2);
    change(checkpointDirectory(runName));
    return () => materialize(runName);
  };
  refusesWith(tamper('ck-digest', (directory) => {
    const file = path.join(directory, 'R0001.json');
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('"revisionSha256":"') + 18;
    fs.writeFileSync(file, `${text.slice(0, at)}${text[at] === '0' ? '1' : '0'}${text.slice(at + 1)}`);
  }), 'CHECKPOINT_REVISION_CORRUPT');
  refusesWith(tamper('ck-format', (directory) => fs.appendFileSync(path.join(directory, 'R0002.json'), ' ')), 'CHECKPOINT_REVISION_CORRUPT');
  refusesWith(tamper('ck-gap', (directory) => fs.rmSync(path.join(directory, 'R0001.json'))), 'CHECKPOINT_HISTORY_CHAIN_BROKEN');
  refusesWith(tamper('ck-identity', (directory) => {
    const file = path.join(directory, 'RUN_IDENTITY.json');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.runId = '0'.repeat(64);
    fs.writeFileSync(file, `${canonicalize(value)}\n`);
  }), 'CHECKPOINT_RUN_IDENTITY_MISMATCH');
});

test('checkpoint: identity drift and a live concurrent run fail closed; a dead owner lock is recovered', () => {
  crashed('ck-drift', 'AFTER_PAIR_COMMIT', 1);
  refusesWith(() => materialize('ck-drift', { producer: { ...base().producer, producerId: 'OTHER_PRODUCER' } }), 'CHECKPOINT_RUN_IDENTITY_MISMATCH');
  refusesWith(() => materialize('ck-drift', { cohort: cohortOf('q150', 150).cohort, sourcePath: cohortOf('q150', 150).sourcePath }), 'CHECKPOINT_RUN_IDENTITY_MISMATCH');

  crashed('ck-lock', 'AFTER_PAIR_COMMIT', 1);
  const lock = path.join(checkpointDirectory('ck-lock'), 'RUN.lock');
  fs.writeFileSync(lock, `${canonicalize({ pid: process.pid, hostname: os.hostname(), runId: 'held' })}\n`);
  refusesWith(() => materialize('ck-lock'), 'CONCURRENT_RUN_REFUSED');
  fs.writeFileSync(lock, `${canonicalize({ pid: 1, hostname: 'another-host', runId: 'held' })}\n`);
  refusesWith(() => materialize('ck-lock'), 'CONCURRENT_RUN_REFUSED');
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(lock, `${canonicalize({ pid: deadPid, hostname: os.hostname(), runId: 'held' })}\n`);
  const resumed = materialize('ck-lock');
  assert.equal(resumed.staleLockRecovered.pid, deadPid);
  assert.equal(resumed.manifestSha256, baseProduct().manifestSha256);

  const identity = { inputIdentity: { cohort: 'direct' }, codeIdentity: {}, contractIdentity: {}, planIdentity: {}, producerIdentity: {} };
  const root = path.join(WORK, 'ck-direct');
  const digest = (seed) => ({ sha256: sha256Bytes(Buffer.from(seed)), byteLength: seed.length });
  const first = openFullCheckpoint({ checkpointRoot: root, repositoryRoot: ROOT, runIdentity: identity });
  try {
    refusesWith(() => openFullCheckpoint({ checkpointRoot: root, repositoryRoot: ROOT, runIdentity: identity }), 'CONCURRENT_RUN_REFUSED');
    refusesWith(() => first.commitPair({ pageNumber: 2, ensemble: digest('e2'), provenance: digest('p2') }), 'PAIR_COMMIT_OUT_OF_ORDER');
    assert.equal(first.commitPair({ pageNumber: 1, ensemble: digest('e1'), provenance: digest('p1') }).replay, 'COMMITTED');
    assert.equal(first.commitPair({ pageNumber: 1, ensemble: digest('e1'), provenance: digest('p1') }).replay, 'IDEMPOTENT');
    refusesWith(() => first.commitPair({ pageNumber: 1, ensemble: digest('e1'), provenance: digest('pX') }), 'DIVERGENT_PAIR_REPLAY_REFUSED');
    refusesWith(() => first.finalize({ manifest: digest('m'), pageCount: 2 }), 'CHECKPOINT_FINAL_BEFORE_ALL_PAIRS');
  } finally {
    first.release();
  }
  refusesWith(() => openFullCheckpoint({ checkpointRoot: path.join(ROOT, 'governance/gates/GATE26/ck'), repositoryRoot: ROOT, runIdentity: identity }), 'CHECKPOINT_ROOT_INSIDE_REPOSITORY');
});

test('no silent overwrite: divergent frontier bytes, tampered committed pages and stray files fail closed; residue is swept', () => {
  crashed('ow-frontier', 'AFTER_ENSEMBLE_PAGE', 2);
  const frontier = path.join(productDirectory('ow-frontier'), pageFileName('ENSEMBLE', 2));
  fs.appendFileSync(frontier, 'x');
  const tamperedDigest = sha256Bytes(fs.readFileSync(frontier));
  refusesWith(() => materialize('ow-frontier'), 'DIVERGENT_PAGE_BYTES_REFUSED');
  assert.equal(sha256Bytes(fs.readFileSync(frontier)), tamperedDigest, 'the divergent page was not overwritten');

  crashed('ow-committed', 'AFTER_PAIR_COMMIT', 2);
  fs.appendFileSync(path.join(productDirectory('ow-committed'), pageFileName('PROVENANCE', 1)), 'x');
  refusesWith(() => materialize('ow-committed'), 'COMMITTED_PAGE_BYTES_DIVERGE');

  crashed('ow-stray', 'BEFORE_PAIR', 2);
  fs.writeFileSync(path.join(productDirectory('ow-stray'), 'notes.txt'), 'x');
  refusesWith(() => materialize('ow-stray'), 'UNEXPECTED_OUTPUT_FILE');
  fs.rmSync(path.join(productDirectory('ow-stray'), 'notes.txt'));
  fs.writeFileSync(path.join(productDirectory('ow-stray'), pageFileName('ENSEMBLE', 3)), 'x');
  refusesWith(() => materialize('ow-stray'), 'UNCOMMITTED_PAGE_BEYOND_FRONTIER');
  fs.rmSync(path.join(productDirectory('ow-stray'), pageFileName('ENSEMBLE', 3)));
  fs.writeFileSync(path.join(productDirectory('ow-stray'), FULL_MANIFEST_FILE_V1), 'x');
  refusesWith(() => materialize('ow-stray'), 'UNEXPECTED_OUTPUT_FILE');
  fs.rmSync(path.join(productDirectory('ow-stray'), FULL_MANIFEST_FILE_V1));

  const residue = `${pageFileName('PROVENANCE', 2)}.__publish__.tmp`;
  fs.writeFileSync(path.join(productDirectory('ow-stray'), residue), 'partial');
  fs.writeFileSync(path.join(checkpointDirectory('ow-stray'), 'R0002.json.__publish__.tmp'), 'partial');
  const resumed = materialize('ow-stray');
  assert.ok(resumed.residueRemoved.includes(residue));
  assert.ok(resumed.residueRemoved.includes('R0002.json.__publish__.tmp'));
  assert.equal(resumed.manifestSha256, baseProduct().manifestSha256);
});

/* ------------------------------------------------------- NEG-03: bounded consumer */

const copyProduct = (name) => {
  const directory = path.join(WORK, 'consumer', name);
  fs.cpSync(productDirectory('base'), directory, { recursive: true });
  return directory;
};
const pagePath = (directory, kind, pageNumber) => path.join(directory, pageFileName(kind, pageNumber));
const readPage = (directory, kind, pageNumber) => JSON.parse(fs.readFileSync(pagePath(directory, kind, pageNumber), 'utf8'));
const canonicalBytes = (value) => Buffer.from(`${canonicalize(value)}\n`, 'utf8');
/** Rewrites pages and re-hashes the manifest, as an attacker who controls the declared manifest identity would. */
function forge(directory, mutate) {
  const file = path.join(directory, FULL_MANIFEST_FILE_V1);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const setPage = (kind, pageNumber, bytes) => {
    fs.writeFileSync(pagePath(directory, kind, pageNumber), bytes);
    const entry = manifest.pages[pageNumber - 1][kind === 'ENSEMBLE' ? 'ensemble' : 'provenance'];
    entry.sha256 = sha256Bytes(bytes);
    entry.byteLength = bytes.length;
    entry.lfsOid = entry.sha256;
  };
  mutate({ manifest, setPage });
  const bytes = canonicalBytes(manifest);
  fs.writeFileSync(file, bytes);
  return sha256Bytes(bytes);
}
const consume = (directory, expectedManifestSha256, extra = {}) => () => consumeFullProductDirectory({
  productRoot: directory, expectedManifestSha256, expectedCombinationPolicyVersionId: policy(), ...extra,
});

test('NEG-03: missing, duplicate and reordered pages fail closed', () => {
  const { manifestSha256 } = baseProduct();
  const missing = copyProduct('missing');
  fs.rmSync(pagePath(missing, 'PROVENANCE', 2));
  refusesWith(consume(missing, manifestSha256), 'PAGE_MISSING');
  const dropped = copyProduct('dropped-entry');
  refusesWith(consume(dropped, forge(dropped, ({ manifest }) => { manifest.pages.pop(); })), 'MANIFEST_PAGE_PLAN_INVALID');

  const extra = copyProduct('extra');
  fs.copyFileSync(pagePath(extra, 'ENSEMBLE', 1), pagePath(extra, 'ENSEMBLE', 4));
  refusesWith(consume(extra, manifestSha256), 'UNEXPECTED_PRODUCT_FILE');
  const duplicateBytes = copyProduct('duplicate-bytes');
  fs.copyFileSync(pagePath(duplicateBytes, 'ENSEMBLE', 1), pagePath(duplicateBytes, 'ENSEMBLE', 2));
  refusesWith(consume(duplicateBytes, manifestSha256), 'PAGE_BYTES_IDENTITY_MISMATCH');
  const duplicateForged = copyProduct('duplicate-forged');
  refusesWith(consume(duplicateForged, forge(duplicateForged, ({ setPage }) => setPage('ENSEMBLE', 2, fs.readFileSync(pagePath(duplicateForged, 'ENSEMBLE', 1))))), 'PAGE_ORDER_INVALID');
  const duplicateEntry = copyProduct('duplicate-entry');
  refusesWith(consume(duplicateEntry, forge(duplicateEntry, ({ manifest }) => { manifest.pages[1] = { ...manifest.pages[0] }; })), 'MANIFEST_PAGE_ORDER_INVALID');

  const swapped = copyProduct('swapped');
  const one = fs.readFileSync(pagePath(swapped, 'ENSEMBLE', 1));
  fs.copyFileSync(pagePath(swapped, 'ENSEMBLE', 2), pagePath(swapped, 'ENSEMBLE', 1));
  fs.writeFileSync(pagePath(swapped, 'ENSEMBLE', 2), one);
  refusesWith(consume(swapped, manifestSha256), 'PAGE_BYTES_IDENTITY_MISMATCH');
  const swappedEntries = copyProduct('swapped-entries');
  refusesWith(consume(swappedEntries, forge(swappedEntries, ({ manifest }) => { [manifest.pages[0], manifest.pages[1]] = [manifest.pages[1], manifest.pages[0]]; })), 'MANIFEST_PAGE_ORDER_INVALID');
  const swappedForged = copyProduct('swapped-forged');
  refusesWith(consume(swappedForged, forge(swappedForged, ({ setPage }) => {
    const first = fs.readFileSync(pagePath(swappedForged, 'ENSEMBLE', 1));
    setPage('ENSEMBLE', 1, fs.readFileSync(pagePath(swappedForged, 'ENSEMBLE', 2)));
    setPage('ENSEMBLE', 2, first);
  })), 'PAGE_ORDER_INVALID');
});

test('NEG-03: corrupt, mixed-cohort and mixed-version pages fail closed', () => {
  const { manifestSha256 } = baseProduct();
  const flipped = copyProduct('flipped');
  const bytes = fs.readFileSync(pagePath(flipped, 'PROVENANCE', 3));
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(pagePath(flipped, 'PROVENANCE', 3), bytes);
  refusesWith(consume(flipped, manifestSha256), 'PAGE_BYTES_IDENTITY_MISMATCH');
  const truncated = copyProduct('truncated');
  refusesWith(consume(truncated, forge(truncated, ({ setPage }) => {
    const page = fs.readFileSync(pagePath(truncated, 'ENSEMBLE', 1));
    setPage('ENSEMBLE', 1, page.subarray(0, page.length - 20));
  })), 'PAGE_NOT_CLOSED');
  const record = copyProduct('record');
  refusesWith(consume(record, forge(record, ({ setPage }) => {
    const page = readPage(record, 'ENSEMBLE', 1);
    const target = page.records.find((entry) => entry.decision === 'ABSTAIN');
    target.decision = 'PROCEED';
    target.abstention = { decision: 'PROCEED', reason: null };
    const ensemble = canonicalBytes(page);
    setPage('ENSEMBLE', 1, ensemble);
    const provenance = readPage(record, 'PROVENANCE', 1);
    provenance.pairedEnsemblePage = { sha256: sha256Bytes(ensemble), byteLength: ensemble.length };
    setPage('PROVENANCE', 1, canonicalBytes(provenance));
  })), 'FORCED_NON_ABSTENTION_FORBIDDEN');

  const otherRun = materialize('other-cohort', {}, cohortOf('q150', 150));
  assert.notEqual(otherRun.manifestSha256, baseProduct().manifestSha256);
  const mixedCohort = copyProduct('mixed-cohort');
  refusesWith(consume(mixedCohort, forge(mixedCohort, ({ setPage }) => {
    setPage('ENSEMBLE', 1, fs.readFileSync(pagePath(productDirectory('other-cohort'), 'ENSEMBLE', 1)));
    setPage('PROVENANCE', 1, fs.readFileSync(pagePath(productDirectory('other-cohort'), 'PROVENANCE', 1)));
  })), 'MIXED_COHORT_PAGE_REFUSED');
  const mixedVersion = copyProduct('mixed-version');
  refusesWith(consume(mixedVersion, forge(mixedVersion, ({ setPage }) => {
    const page = readPage(mixedVersion, 'ENSEMBLE', 2);
    page.productVersion = 'GATE26_FULL_PRODUCT_V2';
    setPage('ENSEMBLE', 2, canonicalBytes(page));
  })), 'MIXED_VERSION_PAGE_REFUSED');
  const mixedEngine = copyProduct('mixed-engine');
  refusesWith(consume(mixedEngine, forge(mixedEngine, ({ setPage }) => {
    const page = readPage(mixedEngine, 'PROVENANCE', 2);
    page.engineVersion = 'GATE26_PredictiveEnsembleEngine/2';
    setPage('PROVENANCE', 2, canonicalBytes(page));
  })), 'MIXED_VERSION_PAGE_REFUSED');
});

test('NEG-03: a provenance page that does not pair exactly with its ensemble page fails closed', () => {
  const pairing = copyProduct('pairing');
  refusesWith(consume(pairing, forge(pairing, ({ manifest, setPage }) => {
    const page = readPage(pairing, 'PROVENANCE', 2);
    page.pairedEnsemblePage = { sha256: manifest.pages[0].ensemble.sha256, byteLength: manifest.pages[0].ensemble.byteLength };
    setPage('PROVENANCE', 2, canonicalBytes(page));
  })), 'PROVENANCE_PAIRING_MISMATCH');
  const swappedRecords = copyProduct('swapped-records');
  refusesWith(consume(swappedRecords, forge(swappedRecords, ({ setPage }) => {
    const page = readPage(swappedRecords, 'PROVENANCE', 2);
    [page.records[0], page.records[1]] = [page.records[1], page.records[0]];
    setPage('PROVENANCE', 2, canonicalBytes(page));
  })), 'PROVENANCE_PAIRING_MISMATCH');
  const alteredManifest = copyProduct('altered-provenance');
  refusesWith(consume(alteredManifest, forge(alteredManifest, ({ setPage }) => {
    const page = readPage(alteredManifest, 'PROVENANCE', 2);
    page.records[0].queryIdentityId = 'a'.repeat(64);
    setPage('PROVENANCE', 2, canonicalBytes(page));
  })), 'PROVENANCE_ID_MISMATCH');
  const foreignPage = copyProduct('foreign-provenance-page');
  refusesWith(consume(foreignPage, forge(foreignPage, ({ setPage }) => setPage('PROVENANCE', 2, fs.readFileSync(pagePath(foreignPage, 'PROVENANCE', 3))))), 'PAGE_ORDER_INVALID');
});

test('CTR-02: a Git LFS pointer instead of materialized bytes, or an OID that is not the content SHA-256, is refused', () => {
  const { manifestSha256 } = baseProduct();
  const pointerFor = (bytes) => Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${sha256Bytes(bytes)}\nsize ${bytes.length}\n`, 'utf8');
  const pointer = copyProduct('pointer');
  fs.writeFileSync(pagePath(pointer, 'ENSEMBLE', 1), pointerFor(fs.readFileSync(pagePath(pointer, 'ENSEMBLE', 1))));
  refusesWith(consume(pointer, manifestSha256), 'LFS_POINTER_NOT_MATERIALIZED');
  const pointerForged = copyProduct('pointer-forged');
  refusesWith(consume(pointerForged, forge(pointerForged, ({ setPage }) => setPage('PROVENANCE', 2, pointerFor(fs.readFileSync(pagePath(pointerForged, 'PROVENANCE', 2)))))), 'LFS_POINTER_NOT_MATERIALIZED');
  const manifestPointer = copyProduct('manifest-pointer');
  const manifestPointerBytes = pointerFor(fs.readFileSync(path.join(manifestPointer, FULL_MANIFEST_FILE_V1)));
  fs.writeFileSync(path.join(manifestPointer, FULL_MANIFEST_FILE_V1), manifestPointerBytes);
  refusesWith(consume(manifestPointer, sha256Bytes(manifestPointerBytes)), 'LFS_POINTER_NOT_MATERIALIZED');
  const oid = copyProduct('oid');
  refusesWith(consume(oid, forge(oid, ({ manifest }) => { manifest.pages[0].ensemble.lfsOid = '0'.repeat(64); })), 'LFS_OID_MISMATCH');
  const rule = copyProduct('rule');
  refusesWith(consume(rule, forge(rule, ({ manifest }) => { manifest.lfs.rule = 'data/jarvise/predictive-ensemble/GATE26/V1/FULL/** -text'; })), 'LFS_RULE_MISMATCH');
});

test('the manifest identity is declared, never trusted: foreign manifests fail closed, a version mismatch abstains', () => {
  const run = baseProduct();
  const directory = copyProduct('identity');
  refusesWith(consume(directory, '0'.repeat(64)), 'MANIFEST_IDENTITY_MISMATCH');
  refusesWith(consume(directory, run.manifestSha256, { expectedCohortDigest: '0'.repeat(64) }), 'MIXED_COHORT_MANIFEST_REFUSED');
  refusesWith(consume(directory, run.manifestSha256, { expectedQueryCount: 301 }), 'QUERY_CARDINALITY_MISMATCH');
  refusesWith(consume(directory, run.manifestSha256, { expectedCombinationPolicyVersionId: 'not-a-sha' }), 'CONSUMER_DECLARED_IDENTITY_REQUIRED');
  const mismatch = consume(directory, run.manifestSha256, { expectedCombinationPolicyVersionId: 'f'.repeat(64) })();
  assert.equal(mismatch.decision, 'ABSTAIN');
  assert.equal(mismatch.abstainReason, 'CONSUMER_VERSION_MISMATCH');
  assert.equal(mismatch.recordsVerified, 0);
});

/* ------------------------------------------------------------- NEG-04: isolation */

test('NEG-04: no network, no Yahoo refetch, no P3H or GATE25 regeneration during compute', () => {
  baseProduct();
  assert.deepEqual(networkCalls, [], 'no network surface was touched by any materialization');
  assert.throws(() => globalThis.fetch('https://example.invalid'), /NETWORK_FORBIDDEN/);
  assert.deepEqual(networkCalls.splice(0), ['fetch']);
  for (const file of ['full-query-cohort-v1.mjs', 'full-checkpoint-v1.mjs', 'full-consumer-v1.mjs', 'full-paged-materializer-v1.mjs', 'consumption-boundary-v1.mjs']) {
    const source = fs.readFileSync(path.join(IMPLEMENTATION, file), 'utf8');
    assert.doesNotMatch(source, /from 'node:(http|https|net|tls|dns|dgram)'/, file);
    assert.doesNotMatch(source, /(from|import\()\s*'[^']*yahoo/i, file);
  }
  for (const input of CONTRACT.requiredInputs.filter((entry) => entry.path)) {
    assert.equal(sha256Bytes(fs.readFileSync(path.resolve(ROOT, input.path))), input.sha256, `${input.path} unchanged`);
  }
  noFullRoot();
});
