import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEGACY_DATASET_MANIFEST_FIELDS,
  legacyDatasetManifestObjectId,
  normalizeLegacyDatasetManifestV1,
  normalizeSnapshotDatasetManifestV1,
  snapshotDatasetManifestId,
} from '../src/contracts/snapshotDatasetManifestV1.mjs';
import { datasetManifestProblems } from '../src/contracts/datasetManifestV1.mjs';
import {
  buildSnapshotDatasetManifest,
  verifySnapshotDatasetManifest,
} from '../src/data/buildSnapshotDatasetManifest.mjs';
import { buildDatasetMaterializationVerification } from '../src/data/verifySnapshotMaterialization.mjs';
import {
  assessDatasetSnapshotQuality,
  buildDatasetQualityAssessmentRecord,
} from '../src/data/assessDatasetSnapshotQuality.mjs';
import { defaultDatasetQualityPolicyV1 } from '../src/contracts/datasetQualityAssessmentV1.mjs';
import {
  buildSyntheticSnapshot,
  code,
  OFFICIAL_TEST_PIPELINE_ID,
  withStore,
} from './l2aSyntheticPipeline.mjs';

function legacyManifestFixture(overrides = {}) {
  return {
    schemaVersion: 'DatasetManifestV1',
    symbol: 'SYNTH',
    sourcePath: 'C:\\caches\\synthetic-fixture.json',
    sourceGitStatus: 'fixture',
    sourceFormat: 'SYNTHETIC_JSON_V1',
    contentHash: 'a'.repeat(64),
    firstDate: '2026-04-01',
    lastDate: '2026-04-02',
    barCount: 2,
    coverageVersion: 'coverage/1',
    rawOhlcValidBars: 2,
    rawOhlcCoveragePct: 100,
    rawOhlcAvailable: true,
    rawOhlcComplete: true,
    adjustedOhlcValidBars: 0,
    adjustedOhlcCoveragePct: 0,
    adjustedOhlcAvailable: false,
    adjustedOhlcComplete: false,
    volumeValidBars: 2,
    volumeCoveragePct: 100,
    volumeAvailable: true,
    volumeComplete: true,
    adjustedCloseAvailable: false,
    nativeAdjustmentType: null,
    splitsDocumented: false,
    qualityFlags: ['SYNTHETIC'],
    warnings: [],
    gapStats: { missingWeekdays: 0, maxConsecutiveMissingWeekdays: 0, weekendSessions: 0 },
    lineage: { builder: 'fixture/1', sourceDeclared: null, sourceSavedAt: null },
    ...overrides,
  };
}

function buildManifest(store, snapshot, overrides = {}) {
  return buildSnapshotDatasetManifest({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    snapshotRecordId: snapshot.built.snapshotRecord.objectId,
    ...overrides,
  });
}

function storeVerification(store, snapshot) {
  return buildDatasetMaterializationVerification({
    store,
    snapshotCore: snapshot.built.core,
    transformManifest: snapshot.manifest,
    pipelineProfileId: OFFICIAL_TEST_PIPELINE_ID,
  });
}

function storeAssessmentRecord(store, snapshot, { assessedAt = '2026-07-18T15:00:00Z', policy } = {}) {
  const assessment = assessDatasetSnapshotQuality({
    store,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
    policy: policy ?? defaultDatasetQualityPolicyV1(),
  });
  return buildDatasetQualityAssessmentRecord({
    store,
    qualityAssessmentCoreId: assessment.qualityCoreId,
    assessedAt,
    assessmentToolVersion: 'quality-tool/1',
    nodeVersion: process.version,
    executionIdentity: { runnerId: 'node:test', runId: null, environment: 'LOCAL_TEST' },
  });
}

test('SM1 — valid manifest without legacy: null evidence, empty sets, deterministic ID', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const manifest = buildManifest(store, snapshot);
  assert.equal(manifest.manifest.legacyManifestObjectId, null);
  assert.deepEqual(manifest.manifest.materializationVerificationIds, []);
  assert.deepEqual(manifest.manifest.qualityAssessmentRecordIds, []);
  assert.equal(snapshotDatasetManifestId(manifest.manifest), manifest.manifestId);
  const again = buildManifest(store, snapshot);
  assert.equal(again.manifestId, manifest.manifestId);
}));

test('SM2 — legacy evidence is preserved verbatim and never contaminates snapshot identity', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const windowsLegacy = legacyManifestFixture();
  const posixLegacy = legacyManifestFixture({ sourcePath: '/caches/synthetic-fixture.json' });
  const first = buildManifest(store, snapshot, { legacyManifest: windowsLegacy });
  const second = buildManifest(store, snapshot, { legacyManifest: posixLegacy });
  const recoveredFirst = verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: first.manifestId });
  assert.equal(recoveredFirst.legacyManifest.sourcePath, 'C:\\caches\\synthetic-fixture.json');
  assert.deepEqual(Object.keys(recoveredFirst.legacyManifest).sort(), [...LEGACY_DATASET_MANIFEST_FIELDS].sort());
  assert.equal(first.manifest.snapshotCoreId, second.manifest.snapshotCoreId);
  assert.notEqual(first.manifest.legacyManifestObjectId, second.manifest.legacyManifestObjectId);
  assert.notEqual(first.manifestId, second.manifestId);
  assert.equal(legacyDatasetManifestObjectId(windowsLegacy), first.manifest.legacyManifestObjectId);
}));

test('SM3 — reference sets are sorted and unique whatever the input order', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const verification = storeVerification(store, snapshot);
  const recordA = storeAssessmentRecord(store, snapshot, { assessedAt: '2026-07-18T15:00:00Z' });
  const recordB = storeAssessmentRecord(store, snapshot, { assessedAt: '2026-07-18T16:00:00Z' });
  const ids = [recordB.recordId, recordA.recordId, recordB.recordId];
  const manifest = buildManifest(store, snapshot, {
    materializationVerificationIds: [verification.verificationId, verification.verificationId],
    qualityAssessmentRecordIds: ids,
  });
  assert.deepEqual(manifest.manifest.materializationVerificationIds, [verification.verificationId]);
  assert.deepEqual(manifest.manifest.qualityAssessmentRecordIds, [...new Set(ids)].sort());
  const permuted = buildManifest(store, snapshot, {
    materializationVerificationIds: [verification.verificationId],
    qualityAssessmentRecordIds: [recordA.recordId, recordB.recordId],
  });
  assert.equal(permuted.manifestId, manifest.manifestId);
}));

test('SM4 — wrong record, missing objects and cross-snapshot references are refused', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const other = buildSyntheticSnapshot(store, { rows: [['2026-05-01', 10, 11, 9, 10, 500]] });
  assert.throws(() => buildManifest(store, snapshot, { snapshotRecordId: other.built.snapshotRecord.objectId }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH'));
  assert.throws(() => buildManifest(store, snapshot, { snapshotRecordId: `sha256:${'9'.repeat(64)}` }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISSING'));
  const otherVerification = storeVerification(store, other);
  assert.throws(() => buildManifest(store, snapshot, { materializationVerificationIds: [otherVerification.verificationId] }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH'));
  const otherAssessment = storeAssessmentRecord(store, other);
  assert.throws(() => buildManifest(store, snapshot, { qualityAssessmentRecordIds: [otherAssessment.recordId] }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH'));
  assert.throws(() => buildManifest(store, snapshot, { qualityAssessmentRecordIds: [`sha256:${'8'.repeat(64)}`] }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISSING'));
}));

test('SM5 — unknown fields and tampered manifest bytes are refused', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const manifest = buildManifest(store, snapshot);
  assert.throws(() => normalizeSnapshotDatasetManifestV1({ ...manifest.manifest, qualityScore: 62 }), code('CANONICAL_UNKNOWN_FIELD'));
  const manifestPath = join(store.root, ...manifest.manifestObject.uri.split('/'));
  writeFileSync(manifestPath, '{"tampered":true}\n');
  assert.throws(() => verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: manifest.manifestId }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH'));
  rmSync(manifestPath);
  assert.throws(() => verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: manifest.manifestId }),
    code('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISSING'));
}));

test('SM6 — adding an assessment publishes a NEW manifest; the previous one stays intact', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const before = buildManifest(store, snapshot, { legacyManifest: legacyManifestFixture() });
  const assessment = storeAssessmentRecord(store, snapshot);
  const after = buildManifest(store, snapshot, {
    legacyManifestObjectId: before.manifest.legacyManifestObjectId,
    qualityAssessmentRecordIds: [assessment.recordId],
  });
  assert.notEqual(after.manifestId, before.manifestId);
  const recoveredBefore = verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: before.manifestId });
  assert.deepEqual(recoveredBefore.manifest.qualityAssessmentRecordIds, []);
  assert.equal(recoveredBefore.legacyManifest.sourcePath, 'C:\\caches\\synthetic-fixture.json');
  const recoveredAfter = verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: after.manifestId });
  assert.deepEqual(recoveredAfter.manifest.qualityAssessmentRecordIds, [assessment.recordId]);
  assert.equal(recoveredAfter.qualityAssessments[0].qualityCore.snapshotCoreId, snapshot.built.snapshotCore.objectId);
}));

test('SM7 — the untouched V1 validator drives legacy acceptance', () => {
  assert.deepEqual(datasetManifestProblems(legacyManifestFixture()), []);
  const incoherent = legacyManifestFixture({ rawOhlcCoveragePct: 50 });
  assert.throws(() => normalizeLegacyDatasetManifestV1(incoherent), (error) => {
    assert.equal(error.code, 'LEGACY_MANIFEST_INVALID');
    assert.ok(error.message.includes('rawOhlcCoveragePct'), 'the V1 problem text is surfaced');
    return true;
  });
  assert.throws(() => normalizeLegacyDatasetManifestV1(legacyManifestFixture({ admissibleFor: ['DEV'] })),
    code('CANONICAL_UNKNOWN_FIELD'));
  const normalized = normalizeLegacyDatasetManifestV1(legacyManifestFixture());
  assert.deepEqual(Object.keys(normalized).sort(), [...LEGACY_DATASET_MANIFEST_FIELDS].sort());
  assert.equal(normalized.sourcePath, 'C:\\caches\\synthetic-fixture.json');
});
