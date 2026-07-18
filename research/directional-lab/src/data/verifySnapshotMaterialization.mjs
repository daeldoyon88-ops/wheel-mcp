/**
 * Deterministic source-to-normalized verification through the closed official
 * materializer registry. The public API accepts no executable callback.
 */

import { isDeepStrictEqual } from 'node:util';
import { canonicalHash, parseCanonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  normalizeCanonicalDailyBarsV1,
} from '../canonical/canonicalDailyBarsV1.mjs';
import {
  DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION,
  MaterializationVerificationError,
  normalizeDatasetMaterializationVerificationV1,
} from '../contracts/datasetMaterializationVerificationV1.mjs';
import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  SHA256_OBJECT_ID_PATTERN,
  normalizeDatasetSnapshotCoreV1,
} from '../contracts/datasetSnapshotV1.mjs';
import { TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION } from '../contracts/transformPipelineProfileV1.mjs';
import { isPlainObject } from '../contracts/contractPrimitivesV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  normalizeTransformImplementationManifest,
  transformImplementationManifestHash,
} from './transformImplementationManifestV2.mjs';
import { transformManifestCoverageProblems } from './transformPipelineProfilesV1.mjs';
import { resolveOfficialMaterializerPipeline } from './materializerRegistryV1.mjs';

const OFFICIAL_INPUT_FIELDS = Object.freeze(['store', 'snapshotCore', 'transformManifest', 'pipelineProfileId']);

const COVERAGE_CODE_TO_REASON = Object.freeze({
  TRANSFORM_PIPELINE_ROLE_MISSING: 'TRANSFORM_MANIFEST_MISSING_ROLE',
  TRANSFORM_PIPELINE_MODULE_MISSING: 'TRANSFORM_MANIFEST_MODULE_MISSING',
  TRANSFORM_PIPELINE_MODULE_HASH_MISMATCH: 'TRANSFORM_MANIFEST_MODULE_HASH_MISMATCH',
});

/** @param {unknown} store @param {string[]} methods */
function assertStore(store, methods) {
  for (const method of methods) {
    if (!store || typeof (/** @type {any} */ (store))[method] !== 'function') {
      throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_INVALID', `store.${method} is required`);
    }
  }
}

/** @param {unknown} error @returns {'SOURCE_OBJECT_MISSING'|'SOURCE_OBJECT_HASH_MISMATCH'|null} */
function classifySourceReadError(error) {
  const code = /** @type {{code?: string}} */ (error)?.code;
  if (code === 'CAS_OBJECT_CORRUPT' && /** @type {any} */ (error)?.details?.fsCode === 'ENOENT') return 'SOURCE_OBJECT_MISSING';
  if (code === 'CAS_OBJECT_CORRUPT' || code === 'CAS_EXISTING_CONTENT_MISMATCH') return 'SOURCE_OBJECT_HASH_MISMATCH';
  return null;
}

/** @param {any} store @param {string} objectId */
function readStoredTransformManifest(store, objectId) {
  const uri = store.uriForObject({ namespace: 'snapshots', objectId });
  let raw;
  try {
    raw = store.readObject({ uri, expectedObjectId: objectId });
  } catch (error) {
    const missing = /** @type {any} */ (error)?.code === 'CAS_OBJECT_CORRUPT'
      && /** @type {any} */ (error)?.details?.fsCode === 'ENOENT';
    throw new MaterializationVerificationError(
      missing ? 'MATERIALIZATION_TRANSFORM_MANIFEST_MISSING' : 'MATERIALIZATION_TRANSFORM_MANIFEST_CORRUPT',
      missing ? 'transform implementation manifest is missing' : 'transform implementation manifest failed hash verification',
      { objectId, cause: error },
    );
  }
  let parsed;
  try {
    parsed = parseCanonicalJsonBytes(raw.bytes);
  } catch (error) {
    throw new MaterializationVerificationError('MATERIALIZATION_TRANSFORM_MANIFEST_CORRUPT',
      'transform implementation manifest is not canonical JSON', { objectId, cause: error });
  }
  const schemaVersion = parsed?.schemaVersion;
  if (schemaVersion !== 'TransformImplementationManifest/1'
    && schemaVersion !== TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION) {
    throw new MaterializationVerificationError('MATERIALIZATION_TRANSFORM_MANIFEST_VERSION_UNSUPPORTED',
      `unsupported transform manifest schema: ${String(schemaVersion)}`, { objectId });
  }
  try {
    return store.readCanonicalObject({ uri, expectedObjectId: objectId, schemaVersion }).value;
  } catch (error) {
    throw new MaterializationVerificationError('MATERIALIZATION_TRANSFORM_MANIFEST_CORRUPT',
      'transform implementation manifest failed schema verification', { objectId, cause: error });
  }
}

/**
 * Official read-only API. Same store contents and same four inputs produce the
 * same verification object and ID.
 * @param {{store: any, snapshotCore: unknown, transformManifest: unknown, pipelineProfileId: string}} input
 */
export function verifySnapshotMaterialization(input) {
  if (!isPlainObject(input)) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_INVALID', 'verification input is required');
  }
  const unknownField = Object.keys(input).find((field) => !OFFICIAL_INPUT_FIELDS.includes(field));
  if (unknownField) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_INVALID', `unknown official API field: ${unknownField}`);
  }
  assertStore(input.store, ['readObject', 'uriForObject']);
  const core = normalizeDatasetSnapshotCoreV1(input.snapshotCore);
  const snapshotCoreId = canonicalHash(DATASET_SNAPSHOT_CORE_SCHEMA_VERSION, core);
  const manifest = normalizeTransformImplementationManifest(input.transformManifest);
  if (manifest.schemaVersion !== TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION) {
    throw new MaterializationVerificationError('MATERIALIZATION_TRANSFORM_MANIFEST_VERSION_UNSUPPORTED',
      'official L2A materialization requires TransformImplementationManifest/2');
  }
  const manifestHash = transformImplementationManifestHash(manifest);

  let resolved;
  try {
    resolved = resolveOfficialMaterializerPipeline({
      pipelineProfileId: input.pipelineProfileId,
      transformManifest: manifest,
    });
  } catch (error) {
    throw new MaterializationVerificationError('MATERIALIZATION_PIPELINE_UNKNOWN',
      `official pipeline cannot be resolved: ${String(input.pipelineProfileId)}`, { cause: error });
  }
  const profile = resolved.pipelineProfile;
  const profileHash = canonicalHash(TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION, profile);
  const reasons = new Set();

  if (manifestHash !== core.transformImplementationHash) reasons.add('SNAPSHOT_CORE_MISMATCH');
  for (const problem of transformManifestCoverageProblems({
    transformManifest: manifest,
    pipelineProfile: profile,
    requiredRoles: resolved.requiredRoles,
  })) reasons.add(COVERAGE_CODE_TO_REASON[problem.code]);

  let sourceBytes = null;
  try {
    const sourceUri = input.store.uriForObject({ namespace: 'source', objectId: core.sourceObjectId });
    sourceBytes = input.store.readObject({ uri: sourceUri, expectedObjectId: core.sourceObjectId }).bytes;
  } catch (error) {
    const reason = classifySourceReadError(error);
    if (reason === null) throw error;
    reasons.add(reason);
  }

  let recomputedNormalizedObjectId = null;
  if (sourceBytes !== null) {
    try {
      const materialized = resolved.materialize({ sourceBytes, snapshotCore: core });
      const canonicalBars = normalizeCanonicalDailyBarsV1(materialized);
      recomputedNormalizedObjectId = canonicalHash(CANONICAL_DAILY_BARS_SCHEMA_VERSION, canonicalBars);
    } catch (error) {
      reasons.add(/** @type {any} */ (error)?.materializationStage === 'NORMALIZER'
        ? 'NORMALIZER_FAILED'
        : 'ADAPTER_FAILED');
    }
    if (recomputedNormalizedObjectId !== null && recomputedNormalizedObjectId !== core.normalizedObjectId) {
      reasons.add('NORMALIZED_OBJECT_MISMATCH');
    }
  }

  const status = reasons.size === 0 ? 'PASS' : 'FAIL';
  const verification = normalizeDatasetMaterializationVerificationV1({
    schemaVersion: DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION,
    snapshotCoreId,
    pipelineProfileId: profile.pipelineProfileId,
    pipelineProfileHash: profileHash,
    transformImplementationHash: manifestHash,
    sourceObjectId: core.sourceObjectId,
    expectedNormalizedObjectId: core.normalizedObjectId,
    recomputedNormalizedObjectId,
    status,
    reasons: status === 'PASS' ? ['MATERIALIZATION_MATCH'] : [...reasons],
  });
  return {
    verification,
    verificationId: canonicalHash(DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION, verification),
    snapshotCoreId,
    pipelineProfile: profile,
    pipelineProfileHash: profileHash,
    transformManifest: manifest,
    transformImplementationHash: manifestHash,
  };
}

/** Persist manifest, profile and verification. FAIL is valid evidence too. */
export function buildDatasetMaterializationVerification(input) {
  const result = verifySnapshotMaterialization(input);
  assertStore(input.store, ['putCanonicalObject']);
  const transformManifestObject = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: result.transformManifest.schemaVersion, value: result.transformManifest,
  });
  if (transformManifestObject.objectId !== result.transformImplementationHash) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_REFERENCE_MISMATCH',
      'stored transform manifest object ID differs from its expected implementation hash');
  }
  const pipelineProfileObject = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION, value: result.pipelineProfile,
  });
  const verificationObject = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION, value: result.verification,
  });
  return { ...result, transformManifestObject, pipelineProfileObject, verificationObject };
}

/** Recover every dependency and semantically replay the stored fact. */
export function verifyDatasetMaterializationVerification(input) {
  assertStore(input?.store, ['readObject', 'readCanonicalObject', 'uriForObject']);
  if (typeof input?.verificationId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(input.verificationId)) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_INVALID', 'verificationId is invalid');
  }
  const uri = input.store.uriForObject({ namespace: 'snapshots', objectId: input.verificationId });
  const verification = input.store.readCanonicalObject({
    uri, expectedObjectId: input.verificationId, schemaVersion: DATASET_MATERIALIZATION_VERIFICATION_SCHEMA_VERSION,
  }).value;
  const coreUri = input.store.uriForObject({ namespace: 'snapshots', objectId: verification.snapshotCoreId });
  const snapshotCore = input.store.readCanonicalObject({
    uri: coreUri, expectedObjectId: verification.snapshotCoreId, schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  }).value;
  if (snapshotCore.sourceObjectId !== verification.sourceObjectId
    || snapshotCore.normalizedObjectId !== verification.expectedNormalizedObjectId) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_REFERENCE_MISMATCH',
      'verification source or normalized reference does not match the snapshot core');
  }
  const profileUri = input.store.uriForObject({ namespace: 'snapshots', objectId: verification.pipelineProfileHash });
  const pipelineProfile = input.store.readCanonicalObject({
    uri: profileUri, expectedObjectId: verification.pipelineProfileHash, schemaVersion: TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION,
  }).value;
  if (pipelineProfile.pipelineProfileId !== verification.pipelineProfileId) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_REFERENCE_MISMATCH',
      'stored pipeline profile ID does not match the verification');
  }
  const transformManifest = readStoredTransformManifest(input.store, verification.transformImplementationHash);
  const actualTransformHash = transformImplementationManifestHash(transformManifest);
  if (actualTransformHash !== verification.transformImplementationHash) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_REFERENCE_MISMATCH',
      'transform manifest object ID does not match the verification');
  }
  if (transformManifest.schemaVersion !== TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION) {
    throw new MaterializationVerificationError('MATERIALIZATION_TRANSFORM_MANIFEST_VERSION_UNSUPPORTED',
      'stored L2A verification does not reference TransformImplementationManifest/2');
  }
  const resolved = resolveOfficialMaterializerPipeline({
    pipelineProfileId: verification.pipelineProfileId,
    transformManifest,
  });
  const expectedProfileHash = canonicalHash(TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION, resolved.pipelineProfile);
  if (expectedProfileHash !== verification.pipelineProfileHash
    || !isDeepStrictEqual(resolved.pipelineProfile, pipelineProfile)) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_REFERENCE_MISMATCH',
      'stored pipeline profile is not the official profile covered by the transform manifest');
  }
  const replayed = verifySnapshotMaterialization({
    store: input.store,
    snapshotCore,
    transformManifest,
    pipelineProfileId: verification.pipelineProfileId,
  });
  if (replayed.verificationId !== input.verificationId
    || !isDeepStrictEqual(replayed.verification, verification)) {
    throw new MaterializationVerificationError('MATERIALIZATION_VERIFICATION_SEMANTIC_MISMATCH',
      'stored verification differs from the deterministic materialization replay');
  }
  return {
    verificationId: input.verificationId,
    verification,
    snapshotCore,
    pipelineProfile,
    transformManifest,
  };
}
