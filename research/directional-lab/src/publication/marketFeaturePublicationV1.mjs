/** L4A-C3 deterministic reference-manifest builder and full verifier. */

import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import {
  MarketDataL3Error, assertApiInput, assertCasId, assertStore,
  canonicalValuesEqual, putCanonicalL3, readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import { MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION } from '../contracts/marketDataSourceL3V1.mjs';
import {
  MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
} from '../contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
} from '../contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
} from '../contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_POLICY_VALUES,
  MARKET_FEATURE_SET_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
  MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
  normalizeMarketFeaturePublicationAuthorityPolicyV1,
  normalizeMarketFeaturePublicationManifestV1,
} from '../contracts/marketFeaturePublicationContractsV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  buildTransformImplementationManifestV2,
} from '../data/transformImplementationManifestV2.mjs';
import {
  verifyMarketTechnicalFeatureComputation,
  verifyMarketTechnicalFeatureSourceBundle,
} from '../features/computeMarketTechnicalFeaturesL4V1.mjs';
import {
  verifyMarketVolumeStructureFeatureComputation,
  verifyMarketVolumeStructureFeatureSourceBundle,
} from '../features/computeMarketVolumeStructureFeaturesL4V1.mjs';
import {
  verifyMarketSeasonalityFeatureComputation,
  verifyMarketSeasonalityFeatureSourceBundle,
} from '../features/computeMarketSeasonalityFeaturesL4V1.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMPLEMENTATION_PROFILES = Object.freeze({
  [MARKET_TECHNICAL_FEATURE_FAMILY_CODE]: Object.freeze({
    runtimeContractVersion: 'MARKET_TECHNICAL_FEATURE_L4A_A/1',
    logicalPaths: Object.freeze([
      'src/contracts/marketTechnicalFeatureComputationL4V1.mjs',
      'src/features/computeMarketTechnicalFeaturesL4V1.mjs',
      'src/features/fixedPointFeatureMathL4V1.mjs',
      'src/features/returnsDrawdownFeaturesL4V1.mjs',
      'src/features/volatilityFeaturesL4V1.mjs',
      'src/features/momentumFeaturesL4V1.mjs',
      'src/features/trendRelativeStrengthFeaturesL4V1.mjs',
    ]),
  }),
  [MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE]: Object.freeze({
    runtimeContractVersion: 'MARKET_VOLUME_STRUCTURE_FEATURE_L4A_B/1',
    logicalPaths: Object.freeze([
      'src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs',
      'src/contracts/marketVolumeStructureFeaturePolicyValuesL4V1.mjs',
      'src/features/computeMarketVolumeStructureFeaturesL4V1.mjs',
      'src/features/marketVolumeStructureRuntimePolicyL4V1.mjs',
      'src/features/volumeStructureBarInputsL4V1.mjs',
      'src/features/volumeParticipationFeaturesL4V1.mjs',
      'src/features/eodVolumeWeightedPriceFeaturesL4V1.mjs',
      'src/features/confirmedPivotFeaturesL4V1.mjs',
      'src/features/supportResistanceFeaturesL4V1.mjs',
      'src/features/gapBreakoutFeaturesL4V1.mjs',
      'src/features/congestionFeaturesL4V1.mjs',
      'src/features/fibonacciStructureFeaturesL4V1.mjs',
    ]),
  }),
  [MARKET_SEASONALITY_FEATURE_FAMILY_CODE]: Object.freeze({
    runtimeContractVersion: 'MARKET_SEASONALITY_FEATURE_L4A_C2/1',
    logicalPaths: Object.freeze([
      'src/contracts/marketSeasonalityFeatureComputationL4V1.mjs',
      'src/contracts/marketSeasonalityFeaturePolicyValuesL4V1.mjs',
      'src/features/marketSeasonalityOccurrenceEngineL4V1.mjs',
      'src/features/marketSeasonalityRuntimePolicyL4V1.mjs',
      'src/features/marketSeasonalityStatisticsL4V1.mjs',
      'src/features/marketSeasonalityFeatureReportL4V1.mjs',
      'src/features/computeMarketSeasonalityFeaturesL4V1.mjs',
    ]),
  }),
});

/** Shared publication digest: SHA-256(CanonicalJSON([{sessionDate, subjectBarIdentityId}, ...])). */
export function computeMarketFeatureOrderedRowIdentityDigestV1(rows) {
  const projection = rows.map((row) => ({
    sessionDate: row.sessionDate,
    subjectBarIdentityId: row.subjectBarIdentityId,
  }));
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(projection)).digest('hex')}`;
}

export function deriveMarketFeatureSessionCoverageV1(rows) {
  return {
    rowCount: rows.length,
    firstSessionDate: rows.length === 0 ? null : rows[0].sessionDate,
    lastSessionDate: rows.length === 0 ? null : rows[rows.length - 1].sessionDate,
    orderedRowIdentityDigest: computeMarketFeatureOrderedRowIdentityDigestV1(rows),
  };
}

function implementationProfile(familyCode) {
  const profile = IMPLEMENTATION_PROFILES[familyCode];
  if (!profile) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_IMPLEMENTATION_MISMATCH',
      'feature family has no closed implementation profile');
  }
  return profile;
}

function expectedImplementationManifest(familyCode) {
  const profile = implementationProfile(familyCode);
  return buildTransformImplementationManifestV2({
    labRoot: LAB_ROOT,
    runtimeContractVersion: profile.runtimeContractVersion,
    logicalPaths: [...profile.logicalPaths],
  });
}

function verifyImplementationManifest(store, implementationManifestId, familyCode, label) {
  assertCasId(implementationManifestId, `${label}ImplementationManifestId`);
  const observed = readTypedReference(store, implementationManifestId,
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, `${label} implementation manifest`);
  const expected = expectedImplementationManifest(familyCode);
  if (!canonicalValuesEqual(observed, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_IMPLEMENTATION_MISMATCH',
      `${label} implementation manifest is not the closed runtime identity`);
  }
  return implementationManifestId;
}

/** Publish the closed TransformImplementationManifest/2 for one official family. */
export function buildMarketFeatureFamilyImplementationManifestV1(input) {
  const api = assertApiInput(input, ['familyCode']);
  assertStore(api.store, STORE_METHODS);
  const value = expectedImplementationManifest(api.familyCode);
  const stored = putCanonicalL3(api.store, TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, value);
  return { implementationManifestId: stored.objectId, implementationManifest: value };
}

function instrumentIdentityIdForBinding(store, binding, label) {
  const lineage = readTypedReference(store, binding.ingestionLineageId,
    MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, `${label} ingestion lineage`);
  return lineage.instrumentIdentityId;
}

function commonFamilyValue(input) {
  return {
    familyCode: input.familyCode,
    featureFamilyVersion: input.featureFamilyVersion,
    rowsSchemaVersion: input.rowsSchemaVersion,
    reportSchemaVersion: input.reportSchemaVersion,
    sourceBundleId: input.sourceBundleId,
    computationPolicyId: input.computationPolicyId,
    rowsId: input.rowsId,
    reportId: input.reportId,
    implementationManifestId: input.implementationManifestId,
    instrumentIdentityId: input.instrumentIdentityId,
    datasetSnapshotBindingId: input.bindingId,
    datasetSnapshotManifestId: input.binding.datasetSnapshotManifestId,
    normalizedMarketDataObjectId: input.binding.normalizedObjectId,
    calendarRegistryManifestId: input.binding.calendarRegistryManifestId,
    knowledgeCutoff: input.binding.knowledgeCutoff,
    temporalCapability: input.binding.temporalCapability,
    priceBasis: input.binding.priceBasis,
    corporateActionTreatment: input.binding.corporateActionTreatment,
    ...deriveMarketFeatureSessionCoverageV1(input.rows),
  };
}

function verifyTechnicalFamily(store, reportId, implementationManifestId) {
  const verified = verifyMarketTechnicalFeatureComputation({
    store, technicalFeatureComputationReportId: reportId,
  });
  const report = verified.technicalFeatureComputationReport;
  const source = verifyMarketTechnicalFeatureSourceBundle({
    store, technicalFeatureSourceBundleId: report.technicalFeatureSourceBundleId,
  });
  const binding = source.subject.binding;
  return commonFamilyValue({ familyCode: MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
    featureFamilyVersion: report.featureFamilyVersions,
    rowsSchemaVersion: MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
    reportSchemaVersion: MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    sourceBundleId: report.technicalFeatureSourceBundleId,
    computationPolicyId: report.technicalFeatureComputationPolicyId,
    rowsId: report.technicalFeatureRowsId, reportId,
    implementationManifestId: verifyImplementationManifest(store, implementationManifestId,
      MARKET_TECHNICAL_FEATURE_FAMILY_CODE, 'technical'),
    instrumentIdentityId: instrumentIdentityIdForBinding(store, binding, 'technical'),
    bindingId: source.subject.reference.bindingId, binding,
    rows: verified.technicalFeatureRows.rows });
}

function verifyVolumeFamily(store, reportId, implementationManifestId) {
  const verified = verifyMarketVolumeStructureFeatureComputation({
    store, volumeStructureFeatureComputationReportId: reportId,
  });
  const report = verified.volumeStructureFeatureComputationReport;
  const source = verifyMarketVolumeStructureFeatureSourceBundle({
    store, volumeStructureFeatureSourceBundleId: report.volumeStructureFeatureSourceBundleId,
  });
  const binding = source.subject.binding;
  return commonFamilyValue({ familyCode: MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
    featureFamilyVersion: report.featureFamilyVersions,
    rowsSchemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
    reportSchemaVersion: MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    sourceBundleId: report.volumeStructureFeatureSourceBundleId,
    computationPolicyId: report.volumeStructureFeatureComputationPolicyId,
    rowsId: report.volumeStructureFeatureRowsId, reportId,
    implementationManifestId: verifyImplementationManifest(store, implementationManifestId,
      MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE, 'volumeStructure'),
    instrumentIdentityId: instrumentIdentityIdForBinding(store, binding, 'volumeStructure'),
    bindingId: source.volumeStructureFeatureSourceBundle.subjectBindingId, binding,
    rows: verified.volumeStructureFeatureRows.rows });
}

function verifySeasonalityFamily(store, reportId) {
  const verified = verifyMarketSeasonalityFeatureComputation({
    store, seasonalityFeatureComputationReportId: reportId,
  });
  const report = verified.seasonalityFeatureComputationReport;
  const source = verifyMarketSeasonalityFeatureSourceBundle({
    store, seasonalityFeatureSourceBundleId: report.seasonalityFeatureSourceBundleId,
  });
  const bundle = source.seasonalityFeatureSourceBundle;
  const binding = {
    datasetSnapshotManifestId: bundle.datasetSnapshotManifestId,
    normalizedObjectId: bundle.normalizedMarketDataObjectId,
    calendarRegistryManifestId: bundle.calendarRegistryManifestId,
    knowledgeCutoff: bundle.knowledgeCutoff,
    temporalCapability: bundle.temporalCapability,
    priceBasis: bundle.priceBasis,
    corporateActionTreatment: bundle.corporateActionTreatment,
  };
  if (report.implementationManifestId !== bundle.implementationManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_IMPLEMENTATION_MISMATCH',
      'seasonality report and source bundle implementation identities differ');
  }
  return commonFamilyValue({ familyCode: MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
    featureFamilyVersion: report.featureFamilyVersion,
    rowsSchemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    reportSchemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    sourceBundleId: report.seasonalityFeatureSourceBundleId,
    computationPolicyId: report.seasonalityFeatureComputationPolicyId,
    rowsId: report.seasonalityFeatureRowsId, reportId,
    implementationManifestId: verifyImplementationManifest(store, report.implementationManifestId,
      MARKET_SEASONALITY_FEATURE_FAMILY_CODE, 'seasonality'),
    instrumentIdentityId: report.instrumentIdentityId,
    bindingId: report.datasetSnapshotBindingId, binding,
    rows: verified.seasonalityFeatureRows.rows });
}

function sameCoverage(left, right) {
  return ['rowCount', 'firstSessionDate', 'lastSessionDate', 'orderedRowIdentityDigest']
    .every((field) => left[field] === right[field]);
}

function assertFamilyCoherence(families) {
  const first = families[0];
  for (const family of families.slice(1)) {
    if (family.instrumentIdentityId !== first.instrumentIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_INSTRUMENT_MISMATCH',
        'feature families reference different instruments');
    }
    if (family.datasetSnapshotBindingId !== first.datasetSnapshotBindingId) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_BINDING_MISMATCH',
        'feature families reference different dataset snapshot bindings');
    }
    if (family.datasetSnapshotManifestId !== first.datasetSnapshotManifestId
        || family.normalizedMarketDataObjectId !== first.normalizedMarketDataObjectId
        || family.calendarRegistryManifestId !== first.calendarRegistryManifestId
        || family.temporalCapability !== first.temporalCapability) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_SNAPSHOT_MISMATCH',
        'feature families reference different snapshot authorities');
    }
    if (family.knowledgeCutoff !== first.knowledgeCutoff) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_KNOWLEDGE_CUTOFF_MISMATCH',
        'feature families use different knowledge cutoffs');
    }
    if (family.priceBasis !== first.priceBasis
        || family.corporateActionTreatment !== first.corporateActionTreatment) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_PRICE_BASIS_MISMATCH',
        'feature families use different price authorities');
    }
    if (!sameCoverage(family, first)) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_ROW_ALIGNMENT_MISMATCH',
        'feature families are not exactly row-aligned');
    }
  }
}

function deriveManifestValue(store, refs) {
  const families = [
    verifyTechnicalFamily(store, refs.technicalFeatureComputationReportId,
      refs.technicalImplementationManifestId),
    verifyVolumeFamily(store, refs.volumeStructureFeatureComputationReportId,
      refs.volumeStructureImplementationManifestId),
    verifySeasonalityFamily(store, refs.seasonalityFeatureComputationReportId),
  ];
  assertFamilyCoherence(families);
  const first = families[0];
  return normalizeMarketFeaturePublicationManifestV1({
    schemaVersion: MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: refs.publicationAuthorityPolicyId,
    featureSetVersion: MARKET_FEATURE_SET_VERSION,
    instrumentIdentityId: first.instrumentIdentityId,
    datasetSnapshotBindingId: first.datasetSnapshotBindingId,
    datasetSnapshotManifestId: first.datasetSnapshotManifestId,
    normalizedMarketDataObjectId: first.normalizedMarketDataObjectId,
    calendarRegistryManifestId: first.calendarRegistryManifestId,
    knowledgeCutoff: first.knowledgeCutoff,
    temporalCapability: first.temporalCapability,
    priceBasis: first.priceBasis,
    corporateActionTreatment: first.corporateActionTreatment,
    sessionCoverage: {
      rowCount: first.rowCount, firstSessionDate: first.firstSessionDate,
      lastSessionDate: first.lastSessionDate,
      orderedRowIdentityDigest: first.orderedRowIdentityDigest,
    },
    families,
  });
}

export function buildMarketFeaturePublicationAuthorityPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, STORE_METHODS);
  const policy = normalizeMarketFeaturePublicationAuthorityPolicyV1({
    schemaVersion: MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
    ...MARKET_FEATURE_PUBLICATION_POLICY_VALUES,
  });
  const stored = putCanonicalL3(api.store,
    MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION, policy);
  return { publicationAuthorityPolicyId: stored.objectId, publicationAuthorityPolicy: policy };
}

export function verifyMarketFeaturePublicationAuthorityPolicy(input) {
  const api = assertApiInput(input, ['publicationAuthorityPolicyId']);
  assertStore(api.store, STORE_METHODS);
  const policy = normalizeMarketFeaturePublicationAuthorityPolicyV1(readTypedReference(
    api.store, api.publicationAuthorityPolicyId,
    MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION, 'feature publication authority policy'));
  const expected = normalizeMarketFeaturePublicationAuthorityPolicyV1({
    schemaVersion: MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
    ...MARKET_FEATURE_PUBLICATION_POLICY_VALUES,
  });
  if (!canonicalValuesEqual(policy, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_POLICY_INVALID',
      'publication authority policy is not closed V1');
  }
  return { publicationAuthorityPolicyId: api.publicationAuthorityPolicyId,
    publicationAuthorityPolicy: policy,
    runtime: Object.freeze({ featureSetVersion: MARKET_FEATURE_SET_VERSION,
      familyCodes: Object.freeze([...policy.requiredFamilyCodes]),
      explicitAsOfRequired: true }) };
}

const MANIFEST_INPUT_FIELDS = Object.freeze([
  'publicationAuthorityPolicyId', 'technicalFeatureComputationReportId',
  'technicalImplementationManifestId', 'volumeStructureFeatureComputationReportId',
  'volumeStructureImplementationManifestId', 'seasonalityFeatureComputationReportId',
]);

export function buildMarketFeaturePublicationManifest(input) {
  const api = assertApiInput(input, MANIFEST_INPUT_FIELDS);
  assertStore(api.store, STORE_METHODS);
  for (const field of MANIFEST_INPUT_FIELDS) assertCasId(api[field], field);
  verifyMarketFeaturePublicationAuthorityPolicy({
    store: api.store, publicationAuthorityPolicyId: api.publicationAuthorityPolicyId,
  });
  const value = deriveManifestValue(api.store, api);
  const stored = putCanonicalL3(api.store, MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION, value);
  verifyMarketFeaturePublicationManifest({ store: api.store, publicationManifestId: stored.objectId });
  return { publicationManifestId: stored.objectId, publicationManifest: value };
}

export function verifyMarketFeaturePublicationManifest(input) {
  const api = assertApiInput(input, ['publicationManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.publicationManifestId, 'publicationManifestId');
  const observed = normalizeMarketFeaturePublicationManifestV1(readTypedReference(
    api.store, api.publicationManifestId, MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    'market feature publication manifest'));
  verifyMarketFeaturePublicationAuthorityPolicy({
    store: api.store, publicationAuthorityPolicyId: observed.publicationAuthorityPolicyId,
  });
  const byCode = new Map(observed.families.map((family) => [family.familyCode, family]));
  const expected = deriveManifestValue(api.store, {
    publicationAuthorityPolicyId: observed.publicationAuthorityPolicyId,
    technicalFeatureComputationReportId: byCode.get(MARKET_TECHNICAL_FEATURE_FAMILY_CODE).reportId,
    technicalImplementationManifestId:
      byCode.get(MARKET_TECHNICAL_FEATURE_FAMILY_CODE).implementationManifestId,
    volumeStructureFeatureComputationReportId:
      byCode.get(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE).reportId,
    volumeStructureImplementationManifestId:
      byCode.get(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE).implementationManifestId,
    seasonalityFeatureComputationReportId:
      byCode.get(MARKET_SEASONALITY_FEATURE_FAMILY_CODE).reportId,
  });
  assertMarketFeaturePublicationManifestMatchesV1(observed, expected);
  return { publicationManifestId: api.publicationManifestId, publicationManifest: observed };
}

/** Closed comparison seam used after the authoritative A/B/C recomputation. */
export function assertMarketFeaturePublicationManifestMatchesV1(observed, expected) {
  const normalizedObserved = normalizeMarketFeaturePublicationManifestV1(observed);
  const normalizedExpected = normalizeMarketFeaturePublicationManifestV1(expected);
  if (!canonicalValuesEqual(normalizedObserved, normalizedExpected)) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH',
      'publication manifest diverges from full family recomputation');
  }
  return normalizedObserved;
}

export function marketFeaturePublicationLogicalKeyFor(manifest) {
  return {
    instrumentIdentityId: manifest.instrumentIdentityId,
    datasetSnapshotBindingId: manifest.datasetSnapshotBindingId,
    publicationAuthorityPolicyId: manifest.publicationAuthorityPolicyId,
    featureSetVersion: manifest.featureSetVersion,
  };
}
