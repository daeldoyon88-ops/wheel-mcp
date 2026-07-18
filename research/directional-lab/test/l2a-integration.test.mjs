import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LEGACY_DATASET_MANIFEST_SCHEMA_VERSION,
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  legacyDatasetManifestObjectId,
  snapshotDatasetManifestId,
} from '../src/contracts/snapshotDatasetManifestV1.mjs';
import { defaultDatasetQualityPolicyV1 } from '../src/contracts/datasetQualityAssessmentV1.mjs';
import { verifyDatasetSnapshot } from '../src/data/buildDatasetSnapshot.mjs';
import {
  buildDatasetMaterializationVerification,
  verifyDatasetMaterializationVerification,
} from '../src/data/verifySnapshotMaterialization.mjs';
import {
  assessDatasetSnapshotQuality,
  buildDatasetQualityAssessmentRecord,
  verifyDatasetQualityAssessment,
} from '../src/data/assessDatasetSnapshotQuality.mjs';
import {
  buildSnapshotDatasetManifest,
  verifySnapshotDatasetManifest,
} from '../src/data/buildSnapshotDatasetManifest.mjs';
import {
  buildSyntheticSnapshot,
  code,
  listFiles,
  OFFICIAL_TEST_PIPELINE_ID,
  withStore,
} from './l2aSyntheticPipeline.mjs';

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const L2A_SOURCE_FILES = [
  'src/contracts/contractPrimitivesV1.mjs',
  'src/contracts/transformPipelineProfileV1.mjs',
  'src/contracts/datasetMaterializationVerificationV1.mjs',
  'src/contracts/datasetQualityAssessmentV1.mjs',
  'src/contracts/snapshotDatasetManifestV1.mjs',
  'src/data/transformPipelineProfilesV1.mjs',
  'src/data/transformImplementationManifestV2.mjs',
  'src/data/materializerRegistryV1.mjs',
  'src/data/verifySnapshotMaterialization.mjs',
  'src/data/assessDatasetSnapshotQuality.mjs',
  'src/data/buildSnapshotDatasetManifest.mjs',
];

function fullChain(store) {
  const snapshot = buildSyntheticSnapshot(store);
  const verification = buildDatasetMaterializationVerification({
    store,
    snapshotCore: snapshot.built.core,
    transformManifest: snapshot.manifest,
    pipelineProfileId: OFFICIAL_TEST_PIPELINE_ID,
  });
  const assessment = assessDatasetSnapshotQuality({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    policy: defaultDatasetQualityPolicyV1(),
    materializationVerificationId: verification.verificationId,
  });
  const record = buildDatasetQualityAssessmentRecord({
    store,
    qualityAssessmentCoreId: assessment.qualityCoreId,
    assessedAt: '2026-07-18T15:00:00Z',
    assessmentToolVersion: 'quality-tool/1',
    nodeVersion: process.version,
    executionIdentity: { runnerId: 'node:test', runId: null, environment: 'LOCAL_TEST' },
  });
  return { snapshot, verification, assessment, record };
}

function legacyManifestFixture() {
  return {
    schemaVersion: 'DatasetManifestV1', symbol: 'SYNTH', sourcePath: 'fixture-only.json',
    sourceGitStatus: 'fixture', sourceFormat: 'SYNTHETIC_JSON_V1', contentHash: 'a'.repeat(64),
    firstDate: '2026-04-01', lastDate: '2026-04-02', barCount: 2, coverageVersion: 'coverage/1',
    rawOhlcValidBars: 2, rawOhlcCoveragePct: 100, rawOhlcAvailable: true, rawOhlcComplete: true,
    adjustedOhlcValidBars: 0, adjustedOhlcCoveragePct: 0, adjustedOhlcAvailable: false, adjustedOhlcComplete: false,
    volumeValidBars: 2, volumeCoveragePct: 100, volumeAvailable: true, volumeComplete: true,
    adjustedCloseAvailable: false, nativeAdjustmentType: null, splitsDocumented: false,
    qualityFlags: ['SYNTHETIC'], warnings: [],
    gapStats: { missingWeekdays: 0, maxConsecutiveMissingWeekdays: 0, weekendSessions: 0 },
    lineage: { builder: 'fixture/1', sourceDeclared: null, sourceSavedAt: null },
  };
}

test('L2A1 — end-to-end: snapshot → verification → assessment → manifest → full recovery', () => withStore((store) => {
  const { snapshot, verification, assessment, record } = fullChain(store);
  assert.equal(verification.verification.status, 'PASS');
  assert.equal(assessment.qualityCore.summary.status, 'PASS');
  const manifest = buildSnapshotDatasetManifest({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    snapshotRecordId: snapshot.built.snapshotRecord.objectId,
    materializationVerificationIds: [verification.verificationId],
    qualityAssessmentRecordIds: [record.recordId],
  });
  const recovered = verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: manifest.manifestId });
  assert.deepEqual(recovered.snapshot.normalizedDailyBars, snapshot.built.normalizedObject.value);
  assert.deepEqual(recovered.snapshot.sourceBytes, snapshot.sourceBytes);
  assert.equal(recovered.materializationVerifications[0].verification.status, 'PASS');
  assert.equal(recovered.materializationVerifications[0].transformManifest.schemaVersion, 'TransformImplementationManifest/2');
  assert.equal(recovered.materializationVerifications[0].pipelineProfile.pipelineProfileId, OFFICIAL_TEST_PIPELINE_ID);
  assert.equal(recovered.qualityAssessments[0].qualityCore.summary.status, 'PASS');
  assert.equal(recovered.qualityAssessments[0].policy.policyVersion, 'dataset-quality-policy/1');
  assert.equal(recovered.qualityAssessments[0].transformManifest.schemaVersion, 'TransformImplementationManifest/2');
  assert.equal(recovered.qualityAssessments[0].record.assessedAt, '2026-07-18T15:00:00.000Z');
}));

test('L2A5 — every missing intermediate object blocks manifest-ID recovery', () => {
  for (const missing of ['transform manifest', 'pipeline profile', 'quality policy', 'quality core', 'materialization verification']) {
    withStore((store) => {
      const chain = fullChain(store);
      const manifest = buildSnapshotDatasetManifest({
        store,
        snapshotCoreId: chain.snapshot.built.snapshotCore.objectId,
        snapshotRecordId: chain.snapshot.built.snapshotRecord.objectId,
        materializationVerificationIds: [chain.verification.verificationId],
        qualityAssessmentRecordIds: [chain.record.recordId],
      });
      const objectByLabel = {
        'transform manifest': chain.verification.transformManifestObject,
        'pipeline profile': chain.verification.pipelineProfileObject,
        'quality policy': chain.assessment.policyObject,
        'quality core': chain.assessment.qualityCoreObject,
        'materialization verification': chain.verification.verificationObject,
      };
      rmSync(join(store.root, ...objectByLabel[missing].uri.split('/')));
      assert.throws(() => verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: manifest.manifestId }),
        code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISSING'), missing);
    });
  }
});

test('L2A2 — a failure before manifest publication leaves verifiable CAS orphans and no cleanup', () => withStore((store) => {
  assert.ok(!relative(tmpdir(), store.root).startsWith('..'), 'test store must live under os.tmpdir()');
  const { snapshot, verification, record } = fullChain(store);
  const failingStore = {
    ...store,
    putCanonicalObject(input) {
      if (input.schemaVersion === SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION) {
        throw new Error('injected publication failure');
      }
      return store.putCanonicalObject(input);
    },
  };
  const filesBefore = listFiles(store.root);
  const legacyManifest = legacyManifestFixture();
  const expectedLegacyObjectId = legacyDatasetManifestObjectId(legacyManifest);
  assert.throws(() => buildSnapshotDatasetManifest({
    store: failingStore,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    snapshotRecordId: snapshot.built.snapshotRecord.objectId,
    materializationVerificationIds: [verification.verificationId],
    qualityAssessmentRecordIds: [record.recordId],
    legacyManifest,
  }), /injected publication failure/);
  const filesAfter = listFiles(store.root);

  const newFiles = filesAfter.filter((file) => !filesBefore.includes(file));
  assert.equal(newFiles.length, 1, 'exactly one new intermediate legacy object remains');
  assert.ok(filesBefore.every((file) => filesAfter.includes(file)), 'no object was deleted');
  const legacyUri = store.uriForObject({ namespace: 'snapshots', objectId: expectedLegacyObjectId });
  assert.deepEqual(store.readCanonicalObject({
    uri: legacyUri,
    expectedObjectId: expectedLegacyObjectId,
    schemaVersion: LEGACY_DATASET_MANIFEST_SCHEMA_VERSION,
  }).value, legacyManifest);
  const wouldBeManifestId = snapshotDatasetManifestId({
    schemaVersion: SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    snapshotRecordId: snapshot.built.snapshotRecord.objectId,
    legacyManifestObjectId: expectedLegacyObjectId,
    materializationVerificationIds: [verification.verificationId],
    qualityAssessmentRecordIds: [record.recordId],
    createdByVersion: 'snapshotDatasetManifestBuilder/1',
  });
  assert.throws(() => verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: wouldBeManifestId }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISSING'));

  const recoveredSnapshot = verifyDatasetSnapshot({ store, snapshotRecordId: snapshot.built.snapshotRecord.objectId });
  assert.deepEqual(recoveredSnapshot.core, snapshot.built.core);
  assert.equal(verifyDatasetMaterializationVerification({ store, verificationId: verification.verificationId }).verification.status, 'PASS');
  assert.equal(verifyDatasetQualityAssessment({ store, qualityAssessmentRecordId: record.recordId }).qualityCore.summary.status, 'PASS');

  const published = buildSnapshotDatasetManifest({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    snapshotRecordId: snapshot.built.snapshotRecord.objectId,
    materializationVerificationIds: [verification.verificationId],
    qualityAssessmentRecordIds: [record.recordId],
    legacyManifest,
  });
  assert.equal(published.manifestId, wouldBeManifestId, 'the orphaned intermediates are reusable as-is');
}));

test('L2A3 — several assessments of the same snapshot coexist in one manifest', () => withStore((store) => {
  const { snapshot, record } = fullChain(store);
  const stricter = {
    ...defaultDatasetQualityPolicyV1(),
    policyVersion: 'dataset-quality-policy/1-stricter',
    thresholds: { largeObservedMoveWarningPct: 1, maxReportedLargeMoveDates: 10 },
  };
  const stricterAssessment = assessDatasetSnapshotQuality({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    policy: stricter,
  });
  assert.equal(stricterAssessment.qualityCore.summary.status, 'WARN', 'the 3.2% observed move now exceeds 1%');
  const stricterRecord = buildDatasetQualityAssessmentRecord({
    store,
    qualityAssessmentCoreId: stricterAssessment.qualityCoreId,
    assessedAt: '2026-07-18T16:00:00Z',
    assessmentToolVersion: 'quality-tool/1',
    nodeVersion: process.version,
    executionIdentity: { runnerId: 'node:test', runId: null, environment: 'LOCAL_TEST' },
  });
  const manifest = buildSnapshotDatasetManifest({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    snapshotRecordId: snapshot.built.snapshotRecord.objectId,
    qualityAssessmentRecordIds: [stricterRecord.recordId, record.recordId],
  });
  assert.deepEqual(manifest.manifest.qualityAssessmentRecordIds, [record.recordId, stricterRecord.recordId].sort());
  const recovered = verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: manifest.manifestId });
  const statuses = recovered.qualityAssessments.map((assessment) => assessment.qualityCore.summary.status).sort();
  assert.deepEqual(statuses, ['PASS', 'WARN']);
}));

test('L2A4 — L2A deterministic modules contain no wall clock, randomness or debug coupling', () => {
  for (const file of L2A_SOURCE_FILES) {
    const path = join(LAB_ROOT, ...file.split('/'));
    assert.ok(existsSync(path), `${file} must exist`);
    const text = readFileSync(path, 'utf8');
    assert.ok(!/Date\.now\s*\(/.test(text), `${file}: Date.now() is forbidden in deterministic L2A modules`);
    assert.ok(!/new Date\(\)/.test(text), `${file}: wall-clock new Date() is forbidden`);
    assert.ok(!/Math\.random/.test(text), `${file}: randomness is forbidden`);
    assert.ok(!/process\.hrtime/.test(text), `${file}: timers are forbidden`);
    assert.ok(!text.includes('debug' + '/'), `${file}: no coupling to repo debug caches`);
  }
});
