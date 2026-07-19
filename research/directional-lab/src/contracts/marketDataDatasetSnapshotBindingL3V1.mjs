/**
 * L3-I6 — official MarketDataDatasetSnapshotBinding + append-only binding registry.
 *
 * Closes the authoritative publication of one I5 materialization under an
 * explicitly pinned binding registry. Authority is relative to the pinned
 * registry only — never tip-of-CAS, never global "latest".
 *
 * Offline research pipeline. No network, wall clock, UUID, random, scanner,
 * dashboard, macro, Fed, features or models.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertEnum,
  assertExactFields,
  assertPlainObject,
  assertSchemaVersion,
  assertSortedUniqueStrings,
  assertStore,
  assertUtcInstant,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from './marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
  MARKET_DATA_INGESTION_PRICE_BASES,
  MARKET_DATA_TEMPORAL_CAPABILITIES,
} from './marketDataIngestionRegistryL3V1.mjs';
import {
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
} from './marketDataSnapshotMaterializationL3V1.mjs';
import {
  verifyMarketDataSnapshotMaterializationPolicy,
  verifyMarketDataSnapshotSourceBundle,
  verifyMaterializedMarketDataSnapshot,
} from '../materialization/materializeMarketDataSnapshotL3V1.mjs';
import {
  verifyMarketDataResolvedSeries,
  verifyMarketDataResolvedSeriesManifest,
} from '../resolution/resolveMarketDataAsOfL3V1.mjs';
import { verifyDatasetSnapshot } from '../data/buildDatasetSnapshot.mjs';
import { verifySnapshotDatasetManifest } from '../data/buildSnapshotDatasetManifest.mjs';
import { verifyDatasetQualityAssessment } from '../data/assessDatasetSnapshotQuality.mjs';

export const MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION = 'MarketDataDatasetSnapshotBinding/1';
export const MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION =
  'MarketDataDatasetSnapshotBindingAuthorityPolicy/1';
export const MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION =
  'MarketDataDatasetSnapshotBindingRegistryManifest/1';

export const MARKET_DATA_DATASET_SNAPSHOT_BINDING_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
]);

export const MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE = 'MARKET_DATA_SNAPSHOT_BINDING';
export const MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION =
  'INGESTION_LINEAGE_KNOWLEDGE_CUTOFF_MATERIALIZATION_POLICY_V1';
export const MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION =
  'MarketDataDatasetSnapshotBindingRegistry/1';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

const AUTHORITY_POLICY_FIELDS = Object.freeze([
  'schemaVersion',
  'registryNamespaceVersion',
  'authorityScope',
  'bindingUniquenessKeyVersion',
]);

const PUBLICATION_KEY_FIELDS = Object.freeze([
  'ingestionLineageId',
  'knowledgeCutoff',
  'materializationPolicyId',
]);

const BINDING_FIELDS = Object.freeze([
  'schemaVersion',
  'bindingPublicationKey',
  'supersedesBindingId',
  'resolvedSeriesManifestId',
  'snapshotSourceBundleId',
  'materializationPolicyId',
  'materializationReportId',
  'datasetSnapshotManifestId',
  'snapshotCoreId',
  'snapshotRecordId',
  'normalizedObjectId',
  'qualityAssessmentId',
  'qualityAssessmentCoreId',
  'ingestionRegistryManifestId',
  'ingestionLineageId',
  'knowledgeCutoff',
  'temporalCapability',
  'identityRegistryManifestId',
  'calendarRegistryManifestId',
  'corporateActionRegistryManifestId',
  'priceBasis',
  'corporateActionTreatment',
]);

const REGISTRY_FIELDS = Object.freeze([
  'schemaVersion',
  'bindingAuthorityPolicyId',
  'supersedesBindingRegistryManifestId',
  'bindingIds',
  'bindingTips',
]);

const TIP_FIELDS = Object.freeze(['bindingPublicationKey', 'tipBindingId']);

/** @param {unknown} value */
export function normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1(value) {
  const policy = assertPlainObject(value, MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION);
  assertExactFields(policy, AUTHORITY_POLICY_FIELDS);
  if (policy.registryNamespaceVersion !== MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'registryNamespaceVersion must be the closed V1 binding-registry namespace',
    );
  }
  if (policy.authorityScope !== MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE) {
    throw new MarketDataL3Error(
      'MARKET_DATA_BINDING_AUTHORITY_MISMATCH',
      'authorityScope must be MARKET_DATA_SNAPSHOT_BINDING',
    );
  }
  if (policy.bindingUniquenessKeyVersion !== MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'bindingUniquenessKeyVersion must be INGESTION_LINEAGE_KNOWLEDGE_CUTOFF_MATERIALIZATION_POLICY_V1',
    );
  }
  return {
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION,
    authorityScope: MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE,
    bindingUniquenessKeyVersion: MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION,
  };
}

/** @param {unknown} value @param {string} label */
export function normalizeBindingPublicationKeyV1(value, label = 'bindingPublicationKey') {
  const key = assertPlainObject(value, label);
  assertExactFields(key, PUBLICATION_KEY_FIELDS);
  assertCasId(key.ingestionLineageId, `${label}.ingestionLineageId`);
  assertUtcInstant(key.knowledgeCutoff, `${label}.knowledgeCutoff`);
  assertCasId(key.materializationPolicyId, `${label}.materializationPolicyId`);
  return {
    ingestionLineageId: key.ingestionLineageId,
    knowledgeCutoff: key.knowledgeCutoff,
    materializationPolicyId: key.materializationPolicyId,
  };
}

/** @param {object} left @param {object} right */
export function bindingPublicationKeysEqual(left, right) {
  return left.ingestionLineageId === right.ingestionLineageId
    && left.knowledgeCutoff === right.knowledgeCutoff
    && left.materializationPolicyId === right.materializationPolicyId;
}

/** @param {object} left @param {object} right */
export function compareBindingPublicationKeys(left, right) {
  if (left.ingestionLineageId < right.ingestionLineageId) return -1;
  if (left.ingestionLineageId > right.ingestionLineageId) return 1;
  if (left.knowledgeCutoff < right.knowledgeCutoff) return -1;
  if (left.knowledgeCutoff > right.knowledgeCutoff) return 1;
  if (left.materializationPolicyId < right.materializationPolicyId) return -1;
  if (left.materializationPolicyId > right.materializationPolicyId) return 1;
  return 0;
}

/** @param {object} seriesOrBundle @param {string} materializationPolicyId */
export function deriveBindingPublicationKey(seriesOrBundle, materializationPolicyId) {
  return normalizeBindingPublicationKeyV1({
    ingestionLineageId: seriesOrBundle.ingestionLineageId,
    knowledgeCutoff: seriesOrBundle.knowledgeCutoff,
    materializationPolicyId,
  });
}

/** @param {unknown} value */
export function normalizeMarketDataDatasetSnapshotBindingV1(value) {
  const binding = assertPlainObject(value, MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION);
  assertSchemaVersion(binding, MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION);
  assertExactFields(binding, BINDING_FIELDS);
  const bindingPublicationKey = normalizeBindingPublicationKeyV1(binding.bindingPublicationKey);
  assertCasId(binding.supersedesBindingId, 'supersedesBindingId', true);
  for (const field of [
    'resolvedSeriesManifestId', 'snapshotSourceBundleId', 'materializationPolicyId',
    'materializationReportId', 'datasetSnapshotManifestId', 'snapshotCoreId',
    'snapshotRecordId', 'normalizedObjectId', 'qualityAssessmentId',
    'qualityAssessmentCoreId', 'ingestionRegistryManifestId', 'ingestionLineageId',
    'identityRegistryManifestId', 'calendarRegistryManifestId',
    'corporateActionRegistryManifestId',
  ]) {
    assertCasId(binding[field], field);
  }
  assertUtcInstant(binding.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(binding.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, 'temporalCapability');
  assertEnum(binding.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  assertEnum(binding.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS, 'corporateActionTreatment');
  if (!bindingPublicationKeysEqual(bindingPublicationKey, {
    ingestionLineageId: binding.ingestionLineageId,
    knowledgeCutoff: binding.knowledgeCutoff,
    materializationPolicyId: binding.materializationPolicyId,
  })) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'bindingPublicationKey must equal the derived lineage/cutoff/policy triple',
    );
  }
  return {
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
    bindingPublicationKey,
    supersedesBindingId: binding.supersedesBindingId,
    resolvedSeriesManifestId: binding.resolvedSeriesManifestId,
    snapshotSourceBundleId: binding.snapshotSourceBundleId,
    materializationPolicyId: binding.materializationPolicyId,
    materializationReportId: binding.materializationReportId,
    datasetSnapshotManifestId: binding.datasetSnapshotManifestId,
    snapshotCoreId: binding.snapshotCoreId,
    snapshotRecordId: binding.snapshotRecordId,
    normalizedObjectId: binding.normalizedObjectId,
    qualityAssessmentId: binding.qualityAssessmentId,
    qualityAssessmentCoreId: binding.qualityAssessmentCoreId,
    ingestionRegistryManifestId: binding.ingestionRegistryManifestId,
    ingestionLineageId: binding.ingestionLineageId,
    knowledgeCutoff: binding.knowledgeCutoff,
    temporalCapability: binding.temporalCapability,
    identityRegistryManifestId: binding.identityRegistryManifestId,
    calendarRegistryManifestId: binding.calendarRegistryManifestId,
    corporateActionRegistryManifestId: binding.corporateActionRegistryManifestId,
    priceBasis: binding.priceBasis,
    corporateActionTreatment: binding.corporateActionTreatment,
  };
}

/** @param {unknown} value @param {number} index */
function normalizeBindingTip(value, index) {
  const tip = assertPlainObject(value, `bindingTips[${index}]`);
  assertExactFields(tip, TIP_FIELDS);
  return {
    bindingPublicationKey: normalizeBindingPublicationKeyV1(
      tip.bindingPublicationKey, `bindingTips[${index}].bindingPublicationKey`,
    ),
    tipBindingId: (() => {
      assertCasId(tip.tipBindingId, `bindingTips[${index}].tipBindingId`);
      return tip.tipBindingId;
    })(),
  };
}

/** @param {unknown} value */
export function normalizeMarketDataDatasetSnapshotBindingRegistryManifestV1(value) {
  const registry = assertPlainObject(
    value, MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
  );
  assertSchemaVersion(registry, MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION);
  assertExactFields(registry, REGISTRY_FIELDS);
  assertCasId(registry.bindingAuthorityPolicyId, 'bindingAuthorityPolicyId');
  assertCasId(registry.supersedesBindingRegistryManifestId, 'supersedesBindingRegistryManifestId', true);
  assertSortedUniqueStrings(registry.bindingIds, 'bindingIds');
  for (let i = 0; i < registry.bindingIds.length; i += 1) {
    assertCasId(registry.bindingIds[i], `bindingIds[${i}]`);
  }
  if (!Array.isArray(registry.bindingTips)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'bindingTips must be an array');
  }
  const bindingTips = registry.bindingTips.map(normalizeBindingTip);
  for (let i = 1; i < bindingTips.length; i += 1) {
    if (compareBindingPublicationKeys(
      bindingTips[i - 1].bindingPublicationKey,
      bindingTips[i].bindingPublicationKey,
    ) >= 0) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        'bindingTips must be sorted uniquely by bindingPublicationKey',
      );
    }
  }
  for (const tip of bindingTips) {
    if (!registry.bindingIds.includes(tip.tipBindingId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
        'tip is not listed in bindingIds',
      );
    }
  }
  return {
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
    bindingAuthorityPolicyId: registry.bindingAuthorityPolicyId,
    supersedesBindingRegistryManifestId: registry.supersedesBindingRegistryManifestId,
    bindingIds: [...registry.bindingIds],
    bindingTips,
  };
}

/** @param {any} registry @param {object} publicationKey */
export function tipForBindingPublicationKey(registry, publicationKey) {
  const tip = registry.bindingTips.find((entry) => (
    bindingPublicationKeysEqual(entry.bindingPublicationKey, publicationKey)
  ));
  return tip ? tip.tipBindingId : null;
}

/**
 * Walk the supersedes chain of one binding under a pinned registry.
 * @param {any} store @param {any} registry @param {string|null} tipId
 */
export function walkBindingChain(store, registry, tipId) {
  const listed = new Set(registry.bindingIds);
  const chain = [];
  const seen = new Set();
  let cursor = tipId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'binding supersedes chain contains a cycle',
      );
    }
    if (!listed.has(cursor)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'parent binding is invisible under the pinned registry',
      );
    }
    seen.add(cursor);
    const binding = readTypedReference(
      store, cursor, MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION, 'binding',
    );
    chain.push({ bindingId: cursor, binding });
    cursor = binding.supersedesBindingId;
  }
  return chain;
}

/** @param {unknown} input */
export function buildMarketDataDatasetSnapshotBindingAuthorityPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, STORE_METHODS);
  const policy = normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1({
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
    registryNamespaceVersion: MARKET_DATA_SNAPSHOT_BINDING_REGISTRY_NAMESPACE_VERSION,
    authorityScope: MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE,
    bindingUniquenessKeyVersion: MARKET_DATA_SNAPSHOT_BINDING_UNIQUENESS_KEY_VERSION,
  });
  const stored = putCanonicalL3(
    api.store, MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION, policy,
  );
  return {
    bindingAuthorityPolicyId: stored.objectId,
    bindingAuthorityPolicy: stored.value,
    object: stored,
  };
}

/** @param {unknown} input */
export function verifyMarketDataDatasetSnapshotBindingAuthorityPolicy(input) {
  const api = assertApiInput(input, ['bindingAuthorityPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.bindingAuthorityPolicyId, 'bindingAuthorityPolicyId');
  const policy = normalizeMarketDataDatasetSnapshotBindingAuthorityPolicyV1(
    readTypedReference(
      api.store,
      api.bindingAuthorityPolicyId,
      MARKET_DATA_DATASET_SNAPSHOT_BINDING_AUTHORITY_POLICY_SCHEMA_VERSION,
      'binding authority policy',
    ),
  );
  return {
    bindingAuthorityPolicyId: api.bindingAuthorityPolicyId,
    bindingAuthorityPolicy: policy,
  };
}

/**
 * Close report → source bundle → resolved series → L1 snapshot → L2A quality
 * and derive the exact binding value. Does not consult tip-of-CAS.
 * @param {any} store
 * @param {string} materializationReportId
 * @param {string} qualityAssessmentId
 * @param {string|null} supersedesBindingId
 */
function deriveBindingValue(store, materializationReportId, qualityAssessmentId, supersedesBindingId) {
  assertCasId(materializationReportId, 'materializationReportId');
  if (qualityAssessmentId === null || qualityAssessmentId === undefined) {
    throw new MarketDataL3Error(
      'MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED',
      'official snapshot binding requires a verifiable L2A quality assessment',
    );
  }
  assertCasId(qualityAssessmentId, 'qualityAssessmentId');
  assertCasId(supersedesBindingId, 'supersedesBindingId', true);

  const report = readTypedReference(
    store,
    materializationReportId,
    MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    'materialization report',
  );
  const prefixId = readTypedReference(
    store,
    report.snapshotSourceBundleId,
    MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
    'snapshot source bundle',
  ).contributingRegistryPrefixId;

  const materialized = verifyMaterializedMarketDataSnapshot({
    store,
    ingestionRegistryManifestId: prefixId,
    materializationReportId,
  });
  const { snapshotSourceBundle, resolvedSeriesManifest } = verifyMarketDataSnapshotSourceBundle({
    store,
    snapshotSourceBundleId: materialized.snapshotSourceBundleId,
    ingestionRegistryManifestId: prefixId,
  });
  verifyMarketDataResolvedSeries({
    store,
    resolvedSeriesManifestId: materialized.resolvedSeriesManifestId,
    ingestionRegistryManifestId: prefixId,
  });
  verifyMarketDataResolvedSeriesManifest({
    store,
    resolvedSeriesManifestId: materialized.resolvedSeriesManifestId,
  });
  verifyMarketDataSnapshotMaterializationPolicy({
    store,
    materializationPolicyId: report.materializationPolicyId,
  });

  const datasetManifest = verifySnapshotDatasetManifest({
    store,
    snapshotDatasetManifestId: materialized.datasetSnapshotManifestId,
  });
  const snapshot = verifyDatasetSnapshot({
    store,
    snapshotRecordId: datasetManifest.manifest.snapshotRecordId,
  });
  // L1 sourceObjectId is the content-addressed hash of the materialized row
  // bytes (source namespace), not the MarketDataSnapshotSourceBundle id.
  // Closure already ties the report → bundle → L1 manifest via I5 verify.
  const normalizedObjectId = snapshot.core.normalizedObjectId;
  if (datasetManifest.manifest.snapshotCoreId !== snapshot.record.snapshotCoreId
      || datasetManifest.manifest.snapshotRecordId !== snapshot.snapshotRecordId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'dataset snapshot manifest diverges from the verified L1 snapshot',
    );
  }

  let quality;
  try {
    quality = verifyDatasetQualityAssessment({
      store,
      qualityAssessmentRecordId: qualityAssessmentId,
    });
  } catch (cause) {
    const code = /** @type {{code?: string}} */ (cause)?.code ?? '';
    if (code.includes('MISSING') || code === 'QUALITY_ASSESSMENT_INVALID') {
      throw new MarketDataL3Error(
        'MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED',
        'quality assessment is missing or not a verifiable L2A record',
        { cause },
      );
    }
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'quality assessment failed L2A verification',
      { cause },
    );
  }
  if (quality.qualityCore.snapshotCoreId !== datasetManifest.manifest.snapshotCoreId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'quality assessment targets another snapshot',
      {
        qualitySnapshotCoreId: quality.qualityCore.snapshotCoreId,
        bindingSnapshotCoreId: datasetManifest.manifest.snapshotCoreId,
      },
    );
  }
  if (quality.materializationVerification !== null
      && quality.materializationVerification.snapshotCoreId !== datasetManifest.manifest.snapshotCoreId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'quality materialization verification targets another snapshot',
    );
  }

  const publicationKey = deriveBindingPublicationKey(
    resolvedSeriesManifest, report.materializationPolicyId,
  );
  if (resolvedSeriesManifest.contributingRegistryPrefixId !== snapshotSourceBundle.contributingRegistryPrefixId
      || resolvedSeriesManifest.ingestionLineageId !== snapshotSourceBundle.ingestionLineageId
      || resolvedSeriesManifest.knowledgeCutoff !== snapshotSourceBundle.knowledgeCutoff
      || resolvedSeriesManifest.temporalCapability !== snapshotSourceBundle.temporalCapability
      || resolvedSeriesManifest.priceBasis !== snapshotSourceBundle.priceBasis
      || resolvedSeriesManifest.corporateActionTreatment !== snapshotSourceBundle.corporateActionTreatment
      || resolvedSeriesManifest.identityRegistryManifestId !== snapshotSourceBundle.identityRegistryManifestId
      || resolvedSeriesManifest.calendarRegistryManifestId !== snapshotSourceBundle.calendarRegistryManifestId
      || resolvedSeriesManifest.corporateActionRegistryManifestId
        !== snapshotSourceBundle.corporateActionRegistryManifestId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'source bundle diverges from the resolved-series provenance surface',
    );
  }
  if (resolvedSeriesManifest.priceBasis !== snapshot.core.priceBasis) {
    throw new MarketDataL3Error(
      'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH',
      'snapshot priceBasis diverges from resolved-series',
    );
  }

  return normalizeMarketDataDatasetSnapshotBindingV1({
    schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
    bindingPublicationKey: publicationKey,
    supersedesBindingId,
    resolvedSeriesManifestId: materialized.resolvedSeriesManifestId,
    snapshotSourceBundleId: materialized.snapshotSourceBundleId,
    materializationPolicyId: report.materializationPolicyId,
    materializationReportId,
    datasetSnapshotManifestId: materialized.datasetSnapshotManifestId,
    snapshotCoreId: datasetManifest.manifest.snapshotCoreId,
    snapshotRecordId: datasetManifest.manifest.snapshotRecordId,
    normalizedObjectId,
    qualityAssessmentId,
    qualityAssessmentCoreId: quality.record.qualityAssessmentCoreId,
    ingestionRegistryManifestId: resolvedSeriesManifest.contributingRegistryPrefixId,
    ingestionLineageId: resolvedSeriesManifest.ingestionLineageId,
    knowledgeCutoff: resolvedSeriesManifest.knowledgeCutoff,
    temporalCapability: resolvedSeriesManifest.temporalCapability,
    identityRegistryManifestId: resolvedSeriesManifest.identityRegistryManifestId,
    calendarRegistryManifestId: resolvedSeriesManifest.calendarRegistryManifestId,
    corporateActionRegistryManifestId: resolvedSeriesManifest.corporateActionRegistryManifestId,
    priceBasis: resolvedSeriesManifest.priceBasis,
    corporateActionTreatment: resolvedSeriesManifest.corporateActionTreatment,
  });
}

/** Recompute every binding edge from CAS references. */
function verifyBindingClosure(store, binding, bindingId = null) {
  const derived = deriveBindingValue(
    store,
    binding.materializationReportId,
    binding.qualityAssessmentId,
    binding.supersedesBindingId,
  );
  if (!canonicalValuesEqual(binding, derived)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'binding diverges from recomputed closure',
      { bindingId },
    );
  }
  if (binding.supersedesBindingId !== null) {
    const parent = readTypedReference(
      store,
      binding.supersedesBindingId,
      MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
      'superseded binding',
    );
    if (!bindingPublicationKeysEqual(parent.bindingPublicationKey, binding.bindingPublicationKey)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'supersedesBindingId belongs to another publication key',
      );
    }
  }
  return { binding, derived };
}

/** @param {unknown} input */
export function buildMarketDataDatasetSnapshotBinding(input) {
  const api = assertApiInput(input, [
    'baseBindingRegistryManifestId',
    'expectedParentBindingId',
    'materializationReportId',
    'qualityAssessmentId',
  ]);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.baseBindingRegistryManifestId, 'baseBindingRegistryManifestId');
  assertCasId(api.expectedParentBindingId, 'expectedParentBindingId', true);
  assertCasId(api.materializationReportId, 'materializationReportId');
  if (api.qualityAssessmentId === null || api.qualityAssessmentId === undefined) {
    throw new MarketDataL3Error(
      'MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED',
      'official snapshot binding requires a verifiable L2A quality assessment',
    );
  }
  assertCasId(api.qualityAssessmentId, 'qualityAssessmentId');

  const { bindingRegistryManifest: base } = verifyMarketDataDatasetSnapshotBindingRegistry({
    store: api.store,
    bindingRegistryManifestId: api.baseBindingRegistryManifestId,
  });
  const provisional = deriveBindingValue(
    api.store,
    api.materializationReportId,
    api.qualityAssessmentId,
    api.expectedParentBindingId,
  );
  const tipId = tipForBindingPublicationKey(base, provisional.bindingPublicationKey);
  if (tipId !== api.expectedParentBindingId) {
    if (api.expectedParentBindingId === null && tipId !== null) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'publication key already has a tip; expectedParentBindingId is required',
      );
    }
    if (api.expectedParentBindingId !== null && tipId === null) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'expected parent but publication key has no tip under the pinned registry',
      );
    }
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
      'expectedParentBindingId is not the tip under the pinned registry',
    );
  }
  if (api.expectedParentBindingId !== null) {
    let parent;
    try {
      parent = readTypedReference(
        api.store,
        api.expectedParentBindingId,
        MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
        'expected parent binding',
      );
    } catch (cause) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'expected parent binding is missing or wrong type',
        { cause },
      );
    }
    if (!bindingPublicationKeysEqual(parent.bindingPublicationKey, provisional.bindingPublicationKey)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'expected parent belongs to another publication key',
      );
    }
    if (!base.bindingIds.includes(api.expectedParentBindingId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'expected parent is invisible under the pinned registry',
      );
    }
  }

  const stored = putCanonicalL3(
    api.store, MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION, provisional,
  );
  verifyBindingClosure(api.store, stored.value, stored.objectId);
  return {
    bindingId: stored.objectId,
    binding: stored.value,
    object: stored,
  };
}

/** @param {unknown} input */
export function verifyMarketDataDatasetSnapshotBinding(input) {
  const api = assertApiInput(input, ['bindingId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.bindingId, 'bindingId');
  const binding = normalizeMarketDataDatasetSnapshotBindingV1(
    readTypedReference(
      api.store,
      api.bindingId,
      MARKET_DATA_DATASET_SNAPSHOT_BINDING_SCHEMA_VERSION,
      'binding',
    ),
  );
  verifyBindingClosure(api.store, binding, api.bindingId);
  return {
    bindingId: api.bindingId,
    binding,
  };
}

/** @param {any} store @param {any} registry @param {string|null} registryId @param {Set<string>} seen */
function verifyBindingRegistryGraph(store, registry, registryId, seen) {
  const { bindingAuthorityPolicy: authority } = verifyMarketDataDatasetSnapshotBindingAuthorityPolicy({
    store,
    bindingAuthorityPolicyId: registry.bindingAuthorityPolicyId,
  });
  if (authority.authorityScope !== MARKET_DATA_SNAPSHOT_BINDING_AUTHORITY_SCOPE) {
    throw new MarketDataL3Error(
      'MARKET_DATA_BINDING_AUTHORITY_MISMATCH',
      'authorityScope must be MARKET_DATA_SNAPSHOT_BINDING',
    );
  }

  const bindings = new Map();
  for (const bindingId of registry.bindingIds) {
    const { binding } = verifyMarketDataDatasetSnapshotBinding({ store, bindingId });
    bindings.set(bindingId, binding);
  }

  for (const tip of registry.bindingTips) {
    const tipBinding = bindings.get(tip.tipBindingId);
    if (!tipBinding) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
        'tip missing from bindingIds',
      );
    }
    if (!bindingPublicationKeysEqual(tipBinding.bindingPublicationKey, tip.bindingPublicationKey)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'tip targets a binding of another publication key',
      );
    }
  }

  const tipByKey = new Map(
    registry.bindingTips.map((tip) => [
      `${tip.bindingPublicationKey.ingestionLineageId}\0${tip.bindingPublicationKey.knowledgeCutoff}\0${tip.bindingPublicationKey.materializationPolicyId}`,
      tip.tipBindingId,
    ]),
  );
  const reachable = new Set();
  for (const [keyToken, tipId] of tipByKey) {
    let cursor = tipId;
    const chainSeen = new Set();
    while (cursor !== null) {
      if (chainSeen.has(cursor)) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
          'binding chain cycle under tip',
        );
      }
      chainSeen.add(cursor);
      reachable.add(cursor);
      const binding = bindings.get(cursor);
      if (!binding) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
          'tip chain references a binding absent from the registry list',
        );
      }
      const token = `${binding.bindingPublicationKey.ingestionLineageId}\0${binding.bindingPublicationKey.knowledgeCutoff}\0${binding.bindingPublicationKey.materializationPolicyId}`;
      if (token !== keyToken) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
          'binding chain crosses publication keys',
        );
      }
      const parentId = binding.supersedesBindingId;
      if (parentId === null) break;
      if (!bindings.has(parentId)) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
          'parent is not listed in this registry',
        );
      }
      const siblings = [...bindings.entries()]
        .filter(([, other]) => (
          bindingPublicationKeysEqual(other.bindingPublicationKey, binding.bindingPublicationKey)
          && other.supersedesBindingId === parentId
        ))
        .map(([id]) => id);
      if (siblings.length > 1) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
          'visible binding chain contains a branch',
        );
      }
      cursor = parentId;
    }
  }
  for (const bindingId of registry.bindingIds) {
    if (!reachable.has(bindingId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'listed binding is unreachable from binding tips',
      );
    }
  }

  if (registry.supersedesBindingRegistryManifestId !== null) {
    if (registry.supersedesBindingRegistryManifestId === registryId
        || seen.has(registry.supersedesBindingRegistryManifestId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_BINDING_REGISTRY_CYCLE',
        'binding registry supersedes chain contains a cycle',
      );
    }
    seen.add(registry.supersedesBindingRegistryManifestId);
    const parent = readTypedReference(
      store,
      registry.supersedesBindingRegistryManifestId,
      MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
      'superseded binding registry',
    );
    if (parent.bindingAuthorityPolicyId !== registry.bindingAuthorityPolicyId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_BINDING_AUTHORITY_MISMATCH',
        'registry successor changed authority policy',
      );
    }
    if (parent.bindingIds.some((id) => !registry.bindingIds.includes(id))) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
        'registry removed historical bindings',
      );
    }
    verifyBindingRegistryGraph(
      store, parent, registry.supersedesBindingRegistryManifestId, seen,
    );
  }
  return { authority, bindings };
}

/** @param {unknown} input */
export function buildMarketDataDatasetSnapshotBindingRegistryManifest(input) {
  const api = assertApiInput(input, ['registry']);
  assertStore(api.store, STORE_METHODS);
  const registry = normalizeMarketDataDatasetSnapshotBindingRegistryManifestV1(api.registry);
  const resolved = verifyBindingRegistryGraph(api.store, registry, null, new Set());
  const stored = putCanonicalL3(
    api.store,
    MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registry,
  );
  return {
    bindingRegistryManifestId: stored.objectId,
    bindingRegistryManifest: stored.value,
    object: stored,
    ...resolved,
  };
}

/** @param {unknown} input */
export function buildRootMarketDataDatasetSnapshotBindingRegistry(input) {
  const api = assertApiInput(input, ['bindingAuthorityPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.bindingAuthorityPolicyId, 'bindingAuthorityPolicyId');
  verifyMarketDataDatasetSnapshotBindingAuthorityPolicy({
    store: api.store,
    bindingAuthorityPolicyId: api.bindingAuthorityPolicyId,
  });
  return buildMarketDataDatasetSnapshotBindingRegistryManifest({
    store: api.store,
    registry: {
      schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
      bindingAuthorityPolicyId: api.bindingAuthorityPolicyId,
      supersedesBindingRegistryManifestId: null,
      bindingIds: [],
      bindingTips: [],
    },
  });
}

/** @param {unknown} input */
export function verifyMarketDataDatasetSnapshotBindingRegistry(input) {
  const api = assertApiInput(input, ['bindingRegistryManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.bindingRegistryManifestId, 'bindingRegistryManifestId');
  const registry = normalizeMarketDataDatasetSnapshotBindingRegistryManifestV1(
    readTypedReference(
      api.store,
      api.bindingRegistryManifestId,
      MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
      'binding registry',
    ),
  );
  if (registry.supersedesBindingRegistryManifestId === null) {
    if (registry.bindingIds.length !== 0 || registry.bindingTips.length !== 0) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
        'root binding registry must be empty',
      );
    }
  }
  const resolved = verifyBindingRegistryGraph(
    api.store, registry, api.bindingRegistryManifestId, new Set(),
  );
  return {
    bindingRegistryManifestId: api.bindingRegistryManifestId,
    bindingRegistryManifest: registry,
    ...resolved,
  };
}

/**
 * Append exactly one verified binding onto an explicitly pinned base registry.
 * expectedParentBindingId is mandatory (null for the first tip of a key).
 * @param {unknown} input
 */
export function appendMarketDataDatasetSnapshotBindingRegistry(input) {
  const api = assertApiInput(input, [
    'baseBindingRegistryManifestId',
    'expectedParentBindingId',
    'bindingId',
  ]);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.baseBindingRegistryManifestId, 'baseBindingRegistryManifestId');
  assertCasId(api.expectedParentBindingId, 'expectedParentBindingId', true);
  assertCasId(api.bindingId, 'bindingId');

  const { bindingRegistryManifest: base } = verifyMarketDataDatasetSnapshotBindingRegistry({
    store: api.store,
    bindingRegistryManifestId: api.baseBindingRegistryManifestId,
  });
  const { binding } = verifyMarketDataDatasetSnapshotBinding({
    store: api.store,
    bindingId: api.bindingId,
  });

  if (binding.supersedesBindingId !== api.expectedParentBindingId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
      'append expected parent diverges from binding.supersedesBindingId',
    );
  }

  const tipId = tipForBindingPublicationKey(base, binding.bindingPublicationKey);
  // Idempotent no-op: binding already exactly authoritative under this pin.
  if (tipId === api.bindingId && base.bindingIds.includes(api.bindingId)) {
    return {
      bindingRegistryManifestId: api.baseBindingRegistryManifestId,
      bindingRegistryManifest: base,
      bindingId: api.bindingId,
      noop: true,
    };
  }
  if (tipId !== api.expectedParentBindingId) {
    if (api.expectedParentBindingId === null && tipId !== null) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'publication key tip exists under the pinned registry',
      );
    }
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
      'expected parent is not the current tip',
    );
  }
  if (base.bindingIds.includes(api.bindingId)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
      'binding is already present in the base registry but is not the tip',
    );
  }

  const bindingIds = [...base.bindingIds, api.bindingId].sort();
  const bindingTips = base.bindingTips
    .filter((tip) => !bindingPublicationKeysEqual(tip.bindingPublicationKey, binding.bindingPublicationKey))
    .concat([{
      bindingPublicationKey: binding.bindingPublicationKey,
      tipBindingId: api.bindingId,
    }])
    .sort((left, right) => compareBindingPublicationKeys(
      left.bindingPublicationKey, right.bindingPublicationKey,
    ));

  return buildMarketDataDatasetSnapshotBindingRegistryManifest({
    store: api.store,
    registry: {
      schemaVersion: MARKET_DATA_DATASET_SNAPSHOT_BINDING_REGISTRY_MANIFEST_SCHEMA_VERSION,
      bindingAuthorityPolicyId: base.bindingAuthorityPolicyId,
      supersedesBindingRegistryManifestId: api.baseBindingRegistryManifestId,
      bindingIds,
      bindingTips,
    },
  });
}

export const recoverMarketDataDatasetSnapshotBinding = verifyMarketDataDatasetSnapshotBinding;
export const recoverMarketDataDatasetSnapshotBindingRegistry = verifyMarketDataDatasetSnapshotBindingRegistry;
