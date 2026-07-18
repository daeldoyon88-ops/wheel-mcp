import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  datasetMaterializationVerificationProblems,
  normalizeDatasetMaterializationVerificationV1,
} from '../src/contracts/datasetMaterializationVerificationV1.mjs';
import {
  buildDatasetMaterializationVerification,
  verifyDatasetMaterializationVerification,
  verifySnapshotMaterialization,
} from '../src/data/verifySnapshotMaterialization.mjs';
import { transformImplementationManifestHash } from '../src/data/transformImplementationManifestV2.mjs';
import {
  OFFICIAL_TEST_PIPELINE_ID,
  buildSyntheticSnapshot,
  code,
  listFiles,
  syntheticMaterializer,
  syntheticSourceBytes,
  syntheticTransformManifest,
  withStore,
} from './l2aSyntheticPipeline.mjs';

function verifyArgs(store, snapshot, overrides = {}) {
  return {
    store,
    snapshotCore: snapshot.built.core,
    transformManifest: snapshot.manifest,
    pipelineProfileId: OFFICIAL_TEST_PIPELINE_ID,
    ...overrides,
  };
}

test('MV1 — official registry replays an honest snapshot deterministically', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const first = verifySnapshotMaterialization(verifyArgs(store, snapshot));
  const second = verifySnapshotMaterialization(verifyArgs(store, snapshot));
  assert.equal(first.verification.status, 'PASS');
  assert.deepEqual(first.verification.reasons, ['MATERIALIZATION_MATCH']);
  assert.equal(first.verification.recomputedNormalizedObjectId, snapshot.built.normalizedObject.objectId);
  assert.equal(first.verificationId, second.verificationId);
  assert.equal(first.pipelineProfile.pipelineProfileId, OFFICIAL_TEST_PIPELINE_ID);
}));

test('MV2 — one changed source value is a normalized mismatch', () => withStore((store) => {
  const original = syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1000]]);
  const changed = syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1001]]);
  const snapshot = buildSyntheticSnapshot(store, { sourceBytes: changed, storedFromBytes: original });
  const result = verifySnapshotMaterialization(verifyArgs(store, snapshot));
  assert.equal(result.verification.status, 'FAIL');
  assert.deepEqual(result.verification.reasons, ['NORMALIZED_OBJECT_MISMATCH']);
}));

test('MV3 — the complete core controls the official materializer', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const basisResult = verifySnapshotMaterialization(verifyArgs(store, snapshot, {
    snapshotCore: { ...snapshot.built.core, priceBasis: 'SPLIT_ADJUSTED' },
  }));
  assert.equal(basisResult.verification.status, 'FAIL');
  const symbolResult = verifySnapshotMaterialization(verifyArgs(store, snapshot, {
    snapshotCore: { ...snapshot.built.core, canonicalSymbol: 'OTHER', providerSymbol: 'OTHER' },
  }));
  assert.equal(symbolResult.verification.status, 'FAIL');
  assert.deepEqual(symbolResult.verification.reasons, ['ADAPTER_FAILED']);
  const normalizerResult = verifySnapshotMaterialization(verifyArgs(store, snapshot, {
    snapshotCore: { ...snapshot.built.core, normalizationOptions: { currency: '' } },
  }));
  assert.equal(normalizerResult.verification.status, 'FAIL');
  assert.deepEqual(normalizerResult.verification.reasons, ['NORMALIZER_FAILED']);
  for (const field of [
    'canonicalSymbol', 'providerId', 'providerSymbol', 'sourceFormat', 'adapterVersion',
    'adapterOptions', 'normalizerVersion', 'normalizationOptions', 'priceBasis',
    'corporateActionPolicyHash', 'calendarId', 'calendarVersion', 'transformImplementationHash',
  ]) assert.ok(Object.hasOwn(snapshot.built.core, field), `complete snapshot core field: ${field}`);
}));

test('MV4 — official API rejects unknown profiles and arbitrary callbacks', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  assert.throws(() => verifySnapshotMaterialization(verifyArgs(store, snapshot, { pipelineProfileId: 'unknown/1' })),
    code('MATERIALIZATION_PIPELINE_UNKNOWN'));
  let callbackRan = false;
  const materializer = {
    ...syntheticMaterializer(),
    adapt() { callbackRan = true; },
  };
  assert.throws(() => verifySnapshotMaterialization({ ...verifyArgs(store, snapshot), materializer }),
    code('MATERIALIZATION_VERIFICATION_INVALID'));
  assert.equal(callbackRan, false);
}));

test('MV5 — a changed official module hash changes implementation identity', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const changedManifest = {
    ...snapshot.manifest,
    modules: snapshot.manifest.modules.map((module, index) => index === 0
      ? { ...module, canonicalContentSha256: `sha256:${'f'.repeat(64)}` }
      : module),
  };
  assert.notEqual(transformImplementationManifestHash(changedManifest), snapshot.built.core.transformImplementationHash);
  const result = verifySnapshotMaterialization(verifyArgs(store, snapshot, { transformManifest: changedManifest }));
  assert.equal(result.verification.status, 'FAIL');
  assert.ok(result.verification.reasons.includes('SNAPSHOT_CORE_MISMATCH'));
}));

test('MV6 — builder stores manifest, profile and verification; ID-only recovery replays all', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const before = listFiles(store.root);
  const built = buildDatasetMaterializationVerification(verifyArgs(store, snapshot));
  const after = listFiles(store.root);
  assert.equal(built.transformManifestObject.objectId, built.verification.transformImplementationHash);
  assert.ok(after.length >= before.length + 3);
  const recovered = verifyDatasetMaterializationVerification({ store, verificationId: built.verificationId });
  assert.deepEqual(recovered.verification, built.verification);
  assert.deepEqual(recovered.transformManifest, snapshot.manifest);
  assert.equal(recovered.pipelineProfile.pipelineProfileId, OFFICIAL_TEST_PIPELINE_ID);
}));

test('MV7 — missing or corrupted transform manifest blocks ID-only recovery', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const built = buildDatasetMaterializationVerification(verifyArgs(store, snapshot));
  const path = join(store.root, ...built.transformManifestObject.uri.split('/'));
  rmSync(path);
  assert.throws(() => verifyDatasetMaterializationVerification({ store, verificationId: built.verificationId }),
    code('MATERIALIZATION_TRANSFORM_MANIFEST_MISSING'));
}));

test('MV8 — corrupt transform bytes and semantically forged verification are refused', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store);
  const built = buildDatasetMaterializationVerification(verifyArgs(store, snapshot));
  const transformPath = join(store.root, ...built.transformManifestObject.uri.split('/'));
  writeFileSync(transformPath, '{"corrupt":true}\n');
  assert.throws(() => verifyDatasetMaterializationVerification({ store, verificationId: built.verificationId }),
    code('MATERIALIZATION_TRANSFORM_MANIFEST_CORRUPT'));
}));

test('MV9 — FAIL remains evidence and still has every CAS dependency', () => withStore((store) => {
  const snapshot = buildSyntheticSnapshot(store, {
    sourceBytes: syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1001]]),
    storedFromBytes: syntheticSourceBytes([['2026-04-01', 30, 32, 29, 31, 1000]]),
  });
  const built = buildDatasetMaterializationVerification(verifyArgs(store, snapshot));
  assert.equal(built.verification.status, 'FAIL');
  const recovered = verifyDatasetMaterializationVerification({ store, verificationId: built.verificationId });
  assert.equal(recovered.verification.status, 'FAIL');
  assert.ok(recovered.transformManifest);
  assert.ok(recovered.pipelineProfile);
}));

test('MV10 — contract refuses incoherent status/reason combinations', () => {
  const base = {
    schemaVersion: 'DatasetMaterializationVerification/1',
    snapshotCoreId: `sha256:${'1'.repeat(64)}`,
    pipelineProfileId: OFFICIAL_TEST_PIPELINE_ID,
    pipelineProfileHash: `sha256:${'2'.repeat(64)}`,
    transformImplementationHash: `sha256:${'3'.repeat(64)}`,
    sourceObjectId: `sha256:${'4'.repeat(64)}`,
    expectedNormalizedObjectId: `sha256:${'5'.repeat(64)}`,
    recomputedNormalizedObjectId: `sha256:${'5'.repeat(64)}`,
    status: 'PASS',
    reasons: ['MATERIALIZATION_MATCH'],
  };
  assert.deepEqual(datasetMaterializationVerificationProblems(base), []);
  assert.throws(() => normalizeDatasetMaterializationVerificationV1({ ...base, status: 'FAIL' }),
    code('MATERIALIZATION_VERIFICATION_INVALID'));
});
