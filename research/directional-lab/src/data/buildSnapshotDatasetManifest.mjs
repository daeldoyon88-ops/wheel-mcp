/**
 * Build and verify SnapshotDatasetManifestV1 objects against the CAS. A
 * manifest is only published after every referenced object has been re-read,
 * re-hashed and cross-checked to target the SAME snapshot. Publishing a new
 * manifest (e.g. after adding an assessment) never mutates a previous one:
 * the CAS is append-only and each manifest content has its own ID.
 */

import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import {
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  SHA256_OBJECT_ID_PATTERN,
} from '../contracts/datasetSnapshotV1.mjs';
import {
  LEGACY_DATASET_MANIFEST_SCHEMA_VERSION,
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  SnapshotDatasetManifestError,
  normalizeLegacyDatasetManifestV1,
  normalizeSnapshotDatasetManifestV1,
} from '../contracts/snapshotDatasetManifestV1.mjs';
import { verifyDatasetSnapshot } from './buildDatasetSnapshot.mjs';
import { verifyDatasetMaterializationVerification } from './verifySnapshotMaterialization.mjs';
import { verifyDatasetQualityAssessment } from './assessDatasetSnapshotQuality.mjs';

export const SNAPSHOT_DATASET_MANIFEST_BUILDER_VERSION = 'snapshotDatasetManifestBuilder/1';

/** @param {unknown} store @param {string[]} methods */
function assertStore(store, methods) {
  for (const method of methods) {
    if (!store || typeof (/** @type {any} */ (store))[method] !== 'function') {
      throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_INVALID', `store.${method} is required`);
    }
  }
}

/** @param {unknown} value @param {string} label */
function assertObjectIdString(value, label) {
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) {
    throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_INVALID', `${label} is invalid`);
  }
}

/** @param {any} store @param {string} objectId @param {string} schemaVersion @param {string} label */
function readSnapshotObject(store, objectId, schemaVersion, label) {
  const uri = store.uriForObject({ namespace: 'snapshots', objectId });
  try {
    return store.readCanonicalObject({ uri, expectedObjectId: objectId, schemaVersion }).value;
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === 'CAS_OBJECT_CORRUPT' && /** @type {any} */ (error)?.details?.fsCode === 'ENOENT') {
      throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISSING',
        `${label} object is missing from the CAS`, { objectId, cause: error });
    }
    if (code === 'CAS_OBJECT_CORRUPT' || code === 'CAS_EXISTING_CONTENT_MISMATCH') {
      throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH',
        `${label} object failed hash or schema verification`, { objectId, cause: error });
    }
    throw error;
  }
}

/** Map failures from complete nested verifiers to the manifest contract. */
function verifyCompleteReference(label, objectId, verify) {
  try {
    return verify();
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code ?? '';
    const missing = (code === 'CAS_OBJECT_CORRUPT' && /** @type {any} */ (error)?.details?.fsCode === 'ENOENT')
      || code.includes('MISSING');
    throw new SnapshotDatasetManifestError(
      missing ? 'SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISSING' : 'SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH',
      `${label} failed complete evidence-chain verification`,
      { objectId, cause: error },
    );
  }
}

/**
 * Resolve every reference of a manifest candidate and refuse any reference
 * that targets another snapshot.
 * @param {any} store
 * @param {ReturnType<typeof normalizeSnapshotDatasetManifestV1>} manifest
 */
function resolveManifestReferences(store, manifest) {
  const record = readSnapshotObject(store, manifest.snapshotRecordId, DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION, 'snapshot record');
  if (record.snapshotCoreId !== manifest.snapshotCoreId) {
    throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH',
      'snapshot record does not reference the manifest snapshot core', {
        snapshotRecordId: manifest.snapshotRecordId,
        expectedSnapshotCoreId: manifest.snapshotCoreId,
        actualSnapshotCoreId: record.snapshotCoreId,
      });
  }
  const snapshot = verifyDatasetSnapshot({ store, snapshotRecordId: manifest.snapshotRecordId });

  let legacyManifest = null;
  if (manifest.legacyManifestObjectId !== null) {
    legacyManifest = readSnapshotObject(store, manifest.legacyManifestObjectId, LEGACY_DATASET_MANIFEST_SCHEMA_VERSION, 'legacy manifest');
  }

  const materializationVerifications = manifest.materializationVerificationIds.map((verificationId) => {
    const recovered = verifyCompleteReference('materialization verification', verificationId,
      () => verifyDatasetMaterializationVerification({ store, verificationId }));
    if (recovered.verification.snapshotCoreId !== manifest.snapshotCoreId) {
      throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH',
        'materialization verification targets another snapshot', {
          materializationVerificationId: verificationId,
          expectedSnapshotCoreId: manifest.snapshotCoreId,
          actualSnapshotCoreId: recovered.verification.snapshotCoreId,
        });
    }
    if (recovered.verification.sourceObjectId !== snapshot.core.sourceObjectId
      || recovered.verification.expectedNormalizedObjectId !== snapshot.core.normalizedObjectId) {
      throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH',
        'materialization verification source/normalized references diverge from the snapshot core', {
          materializationVerificationId: verificationId,
        });
    }
    return recovered;
  });

  const qualityAssessments = manifest.qualityAssessmentRecordIds.map((recordId) => {
    const recovered = verifyCompleteReference('quality assessment', recordId,
      () => verifyDatasetQualityAssessment({ store, qualityAssessmentRecordId: recordId }));
    if (recovered.qualityCore.snapshotCoreId !== manifest.snapshotCoreId) {
      throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_REFERENCE_MISMATCH',
        'quality assessment targets another snapshot', {
          qualityAssessmentRecordId: recordId,
          expectedSnapshotCoreId: manifest.snapshotCoreId,
          actualSnapshotCoreId: recovered.qualityCore.snapshotCoreId,
        });
    }
    return recovered;
  });

  return { snapshot, legacyManifest, materializationVerifications, qualityAssessments };
}

/**
 * Verify every reference, then publish the manifest as the LAST CAS write.
 * If any earlier step throws, already-written objects simply remain as CAS
 * orphans (documented behavior): no partial manifest is ever published and
 * nothing is cleaned up silently.
 * @param {{
 *   store: any,
 *   snapshotCoreId: string,
 *   snapshotRecordId: string,
 *   legacyManifest?: unknown,
 *   legacyManifestObjectId?: string|null,
 *   materializationVerificationIds?: readonly string[],
 *   qualityAssessmentRecordIds?: readonly string[],
 *   createdByVersion?: string,
 * }} input
 */
export function buildSnapshotDatasetManifest(input) {
  if (!input || typeof input !== 'object') {
    throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_INVALID', 'manifest build input is required');
  }
  assertStore(input.store, ['readObject', 'readCanonicalObject', 'putCanonicalObject', 'uriForObject']);
  assertObjectIdString(input.snapshotCoreId, 'snapshotCoreId');
  assertObjectIdString(input.snapshotRecordId, 'snapshotRecordId');
  if (input.legacyManifest !== undefined && input.legacyManifestObjectId !== undefined) {
    throw new SnapshotDatasetManifestError('SNAPSHOT_DATASET_MANIFEST_INVALID',
      'provide either legacyManifest or legacyManifestObjectId, not both');
  }

  let legacyManifestObjectId = input.legacyManifestObjectId ?? null;
  if (input.legacyManifest !== undefined && input.legacyManifest !== null) {
    const legacy = normalizeLegacyDatasetManifestV1(input.legacyManifest);
    legacyManifestObjectId = input.store.putCanonicalObject({
      namespace: 'snapshots', schemaVersion: LEGACY_DATASET_MANIFEST_SCHEMA_VERSION, value: legacy,
    }).objectId;
  }

  const manifest = normalizeSnapshotDatasetManifestV1({
    schemaVersion: SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
    snapshotCoreId: input.snapshotCoreId,
    snapshotRecordId: input.snapshotRecordId,
    legacyManifestObjectId,
    materializationVerificationIds: input.materializationVerificationIds ?? [],
    qualityAssessmentRecordIds: input.qualityAssessmentRecordIds ?? [],
    createdByVersion: input.createdByVersion ?? SNAPSHOT_DATASET_MANIFEST_BUILDER_VERSION,
  });
  const references = resolveManifestReferences(input.store, manifest);
  const manifestObject = input.store.putCanonicalObject({
    namespace: 'snapshots', schemaVersion: SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION, value: manifest,
  });
  return {
    manifest,
    manifestId: manifestObject.objectId,
    manifestObject,
    ...references,
  };
}

/**
 * Recover a published manifest from its ID alone and re-verify the complete
 * evidence chain (snapshot, legacy evidence, verifications, assessments).
 * @param {{store: any, snapshotDatasetManifestId: string}} input
 */
export function verifySnapshotDatasetManifest(input) {
  assertStore(input?.store, ['readObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectIdString(input?.snapshotDatasetManifestId, 'snapshotDatasetManifestId');
  const manifest = readSnapshotObject(
    input.store, input.snapshotDatasetManifestId, SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION, 'snapshot dataset manifest',
  );
  const manifestId = canonicalHash(SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION, manifest);
  const references = resolveManifestReferences(input.store, manifest);
  return {
    snapshotDatasetManifestId: manifestId,
    manifest,
    ...references,
  };
}
