/**
 * L3-I3 — MarketDataIngestionManifest + append-only ingestion registry.
 *
 * Authority boundary after L3-I2: objects may exist in the CAS, but only a
 * pinned MarketDataIngestionRegistryManifest makes an ingestion authoritative.
 * No network, wall clock, UUID, random, marketSession or global "latest".
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
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from './marketDataL3CommonV1.mjs';
import {
  verifyMarketDataAcquisitionRecord,
  verifyMarketDataIngestionLineage,
  verifyMarketDataIngestionPolicy,
  verifyMarketDataIngestionRegistryAuthorityPolicy,
  verifyMarketDataParseResult,
  verifyMarketDataSourceArtifact,
  verifyMarketDataSourceAttestation,
} from './marketDataSourceL3V1.mjs';
import {
  verifyMarketDataCandidateSet,
  verifyMarketDataValidationReport,
} from './marketDataCandidateL3V1.mjs';
import {
  verifyMarketDataAcceptedCandidatePublicationManifest,
  verifyMarketDataBarCorrection,
  verifyMarketDataBarObservation,
} from './marketDataBarRevisionL3V1.mjs';
import {
  verifyNormalizedMarketDataDeltaAssemblyManifest,
} from './marketDataDeltaL3V1.mjs';

export const MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION = 'MarketDataIngestionManifest/1';
export const MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION = 'MarketDataIngestionRegistryManifest/1';

export const MARKET_DATA_INGESTION_REGISTRY_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
]);

export const MARKET_DATA_INGESTION_PRICE_BASES = Object.freeze(['RAW', 'SPLIT_ADJUSTED']);
export const MARKET_DATA_CORPORATE_ACTION_TREATMENTS = Object.freeze([
  'RAW_SOURCE_UNTRANSFORMED',
  'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
]);
export const MARKET_DATA_TEMPORAL_CAPABILITIES = Object.freeze([
  'RETROSPECTIVE_CAPTURE_ONLY',
  'POINT_IN_TIME_PUBLICATION_ATTESTED',
  'POINT_IN_TIME_REVISION_HISTORY_ATTESTED',
]);

const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion',
  'ingestionLineageId',
  'ingestionPolicyId',
  'baseIngestionRegistryManifestId',
  'expectedParentIngestionManifestId',
  'supersedesIngestionManifestId',
  'identityRegistryManifestId',
  'calendarRegistryManifestId',
  'corporateActionRegistryManifestId',
  'sourceArtifactId',
  'sourceAttestationId',
  'acquisitionRecordId',
  'parseResultId',
  'candidateSetId',
  'validationReportId',
  'acceptedCandidatePublicationManifestId',
  'deltaAssemblyManifestId',
  'newBarObservationIds',
  'newBarCorrectionIds',
  'temporalCapability',
  'priceBasis',
  'corporateActionTreatment',
]);

const REGISTRY_FIELDS = Object.freeze([
  'schemaVersion',
  'ingestionRegistryAuthorityPolicyId',
  'supersedesIngestionRegistryManifestId',
  'ingestionManifestIds',
  'lineageTips',
]);

const TIP_FIELDS = Object.freeze(['ingestionLineageId', 'tipIngestionManifestId']);

const KNOWLEDGE_TO_CAPABILITY = Object.freeze({
  CAPTURE_TIME_ONLY: 'RETROSPECTIVE_CAPTURE_ONLY',
  PROVIDER_PUBLICATION_TIME_ATTESTED: 'POINT_IN_TIME_PUBLICATION_ATTESTED',
  PROVIDER_REVISION_HISTORY_ATTESTED: 'POINT_IN_TIME_REVISION_HISTORY_ATTESTED',
});

const CAPABILITY_RANK = Object.freeze({
  RETROSPECTIVE_CAPTURE_ONLY: 0,
  POINT_IN_TIME_PUBLICATION_ATTESTED: 1,
  POINT_IN_TIME_REVISION_HISTORY_ATTESTED: 2,
});

const PRICE_BASIS_TO_TREATMENT = Object.freeze({
  RAW: 'RAW_SOURCE_UNTRANSFORMED',
  SPLIT_ADJUSTED: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
});

/** @param {unknown} value */
export function normalizeMarketDataIngestionManifestV1(value) {
  const manifest = assertPlainObject(value, MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION);
  assertSchemaVersion(manifest, MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION);
  assertExactFields(manifest, MANIFEST_FIELDS);
  for (const field of [
    'ingestionLineageId', 'ingestionPolicyId', 'baseIngestionRegistryManifestId',
    'identityRegistryManifestId', 'calendarRegistryManifestId', 'corporateActionRegistryManifestId',
    'sourceAttestationId', 'acquisitionRecordId', 'parseResultId', 'candidateSetId',
    'validationReportId', 'acceptedCandidatePublicationManifestId', 'deltaAssemblyManifestId',
  ]) {
    assertCasId(manifest[field], field);
  }
  assertCasId(manifest.expectedParentIngestionManifestId, 'expectedParentIngestionManifestId', true);
  assertCasId(manifest.supersedesIngestionManifestId, 'supersedesIngestionManifestId', true);
  assertCasId(manifest.sourceArtifactId, 'sourceArtifactId', true);
  assertSortedUniqueStrings(manifest.newBarObservationIds, 'newBarObservationIds');
  assertSortedUniqueStrings(manifest.newBarCorrectionIds, 'newBarCorrectionIds');
  for (let i = 0; i < manifest.newBarObservationIds.length; i += 1) {
    assertCasId(manifest.newBarObservationIds[i], `newBarObservationIds[${i}]`);
  }
  for (let i = 0; i < manifest.newBarCorrectionIds.length; i += 1) {
    assertCasId(manifest.newBarCorrectionIds[i], `newBarCorrectionIds[${i}]`);
  }
  if (manifest.newBarObservationIds.length + manifest.newBarCorrectionIds.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'ingestion manifest delta must be non-empty');
  }
  assertEnum(manifest.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, 'temporalCapability');
  assertEnum(manifest.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  assertEnum(manifest.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS, 'corporateActionTreatment');
  return {
    ...manifest,
    newBarObservationIds: [...manifest.newBarObservationIds],
    newBarCorrectionIds: [...manifest.newBarCorrectionIds],
  };
}

/** @param {unknown} value */
function normalizeLineageTip(value, index) {
  const tip = assertPlainObject(value, `lineageTips[${index}]`);
  assertExactFields(tip, TIP_FIELDS);
  assertCasId(tip.ingestionLineageId, 'ingestionLineageId');
  assertCasId(tip.tipIngestionManifestId, 'tipIngestionManifestId');
  return { ...tip };
}

/** @param {unknown} value */
export function normalizeMarketDataIngestionRegistryManifestV1(value) {
  const registry = assertPlainObject(value, MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION);
  assertSchemaVersion(registry, MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION);
  assertExactFields(registry, REGISTRY_FIELDS);
  assertCasId(registry.ingestionRegistryAuthorityPolicyId, 'ingestionRegistryAuthorityPolicyId');
  assertCasId(registry.supersedesIngestionRegistryManifestId, 'supersedesIngestionRegistryManifestId', true);
  assertSortedUniqueStrings(registry.ingestionManifestIds, 'ingestionManifestIds');
  for (let i = 0; i < registry.ingestionManifestIds.length; i += 1) {
    assertCasId(registry.ingestionManifestIds[i], `ingestionManifestIds[${i}]`);
  }
  if (!Array.isArray(registry.lineageTips)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'lineageTips must be an array');
  }
  const lineageTips = registry.lineageTips.map(normalizeLineageTip);
  for (let i = 1; i < lineageTips.length; i += 1) {
    if (lineageTips[i - 1].ingestionLineageId >= lineageTips[i].ingestionLineageId) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'lineageTips must be sorted uniquely by ingestionLineageId');
    }
  }
  const tipLineages = new Set(lineageTips.map((tip) => tip.ingestionLineageId));
  if (tipLineages.size !== lineageTips.length) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_BRANCH', 'lineageTips contains a duplicate lineage');
  }
  for (const tip of lineageTips) {
    if (!registry.ingestionManifestIds.includes(tip.tipIngestionManifestId)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_CHAIN_INVALID', 'tip is not listed in ingestionManifestIds');
    }
  }
  return {
    schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    ingestionRegistryAuthorityPolicyId: registry.ingestionRegistryAuthorityPolicyId,
    supersedesIngestionRegistryManifestId: registry.supersedesIngestionRegistryManifestId,
    ingestionManifestIds: [...registry.ingestionManifestIds],
    lineageTips,
  };
}

/**
 * Map knowledge modes of published objects to the persisted temporal capability.
 * One CAPTURE_TIME_ONLY object forces RETROSPECTIVE_CAPTURE_ONLY for the whole delta.
 * @param {Iterable<string>} knowledgeModes
 */
export function deriveTemporalCapabilityFromKnowledgeModes(knowledgeModes) {
  let rank = CAPABILITY_RANK.POINT_IN_TIME_REVISION_HISTORY_ATTESTED;
  let found = false;
  for (const mode of knowledgeModes) {
    const capability = KNOWLEDGE_TO_CAPABILITY[mode];
    if (capability === undefined) {
      throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_MODE_INVALID', 'unknown knowledge mode in temporal derivation', { mode });
    }
    found = true;
    rank = Math.min(rank, CAPABILITY_RANK[capability]);
  }
  if (!found) {
    throw new MarketDataL3Error('MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH', 'no contributive objects for temporal capability');
  }
  return MARKET_DATA_TEMPORAL_CAPABILITIES[rank];
}

/** @param {string} priceBasis */
export function deriveCorporateActionTreatment(priceBasis) {
  assertEnum(priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  return PRICE_BASIS_TO_TREATMENT[priceBasis];
}

/** @param {any} store @param {string[]} observationIds @param {string[]} correctionIds */
export function deriveTemporalCapabilityFromDeltaObjects(store, observationIds, correctionIds) {
  const modes = [];
  for (const observationId of observationIds) {
    const observation = verifyMarketDataBarObservation({ store, observationId }).observation;
    modes.push(observation.knowledgeMode);
  }
  for (const correctionId of correctionIds) {
    const correction = verifyMarketDataBarCorrection({ store, correctionId }).correction;
    modes.push(correction.knowledgeMode);
  }
  return deriveTemporalCapabilityFromKnowledgeModes(modes);
}

/** @param {any} registry @param {string} ingestionLineageId */
export function tipForLineage(registry, ingestionLineageId) {
  const tip = registry.lineageTips.find((entry) => entry.ingestionLineageId === ingestionLineageId);
  return tip ? tip.tipIngestionManifestId : null;
}

/**
 * Walk the supersedes chain of one ingestion manifest under a pinned registry.
 * Only manifests listed in the registry closure are visible.
 * @param {any} store @param {any} registry @param {string|null} tipId
 */
export function walkIngestionChain(store, registry, tipId) {
  const listed = new Set(registry.ingestionManifestIds);
  const chain = [];
  const seen = new Set();
  let cursor = tipId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_CHAIN_INVALID', 'ingestion supersedes chain contains a cycle');
    }
    if (!listed.has(cursor)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'parent is invisible under the pinned registry');
    }
    seen.add(cursor);
    const manifest = readTypedReference(
      store, cursor, MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION, 'ingestion manifest',
    );
    chain.push({ ingestionManifestId: cursor, ingestionManifest: manifest });
    cursor = manifest.expectedParentIngestionManifestId;
  }
  return chain;
}

/**
 * Derive the I2 baseView for one lineage tip under an explicitly pinned registry.
 * @param {any} store
 * @param {string} baseIngestionRegistryManifestId
 * @param {string} ingestionLineageId
 * @param {string|null} expectedParentIngestionManifestId
 */
export function derivePinnedIngestionBaseView(
  store,
  baseIngestionRegistryManifestId,
  ingestionLineageId,
  expectedParentIngestionManifestId,
) {
  const { ingestionRegistryManifest: registry } = verifyMarketDataIngestionRegistry({
    store, ingestionRegistryManifestId: baseIngestionRegistryManifestId,
  });
  const tipId = tipForLineage(registry, ingestionLineageId);
  if (tipId !== expectedParentIngestionManifestId) {
    if (expectedParentIngestionManifestId === null && tipId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_REQUIRED', 'lineage tip exists; expected parent is required');
    }
    if (expectedParentIngestionManifestId !== null && tipId === null) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_MISMATCH', 'expected parent but lineage has no tip under the pinned registry');
    }
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_MISMATCH', 'expected parent is not the tip under the pinned registry');
  }
  const chain = walkIngestionChain(store, registry, tipId);
  const visibleCorrectionIds = [];
  const publishedBarIdentityIds = [];
  const observationById = new Map();
  const correctionById = new Map();
  for (const { ingestionManifest } of chain) {
    for (const observationId of ingestionManifest.newBarObservationIds) {
      const observation = verifyMarketDataBarObservation({ store, observationId }).observation;
      if (observation.ingestionLineageId !== ingestionLineageId) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'historical observation belongs to another lineage');
      }
      observationById.set(observationId, observation);
      publishedBarIdentityIds.push(observation.barIdentityId);
    }
    for (const correctionId of ingestionManifest.newBarCorrectionIds) {
      const correction = verifyMarketDataBarCorrection({ store, correctionId }).correction;
      if (correction.ingestionLineageId !== ingestionLineageId) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'historical correction belongs to another lineage');
      }
      correctionById.set(correctionId, correction);
      visibleCorrectionIds.push(correctionId);
      publishedBarIdentityIds.push(correction.barIdentityId);
    }
  }
  const sortedVisible = [...new Set(visibleCorrectionIds)].sort();
  const children = new Map();
  for (const [correctionId, correction] of correctionById) {
    if (correction.parentCorrectionId === null) continue;
    if (!correctionById.has(correction.parentCorrectionId)) continue;
    if (!children.has(correction.parentCorrectionId)) children.set(correction.parentCorrectionId, []);
    children.get(correction.parentCorrectionId).push(correctionId);
  }
  const terminalCorrectionIds = sortedVisible
    .filter((correctionId) => !children.has(correctionId))
    .slice()
    .sort();
  const occupiedBarIdentityIds = [];
  for (const terminalId of terminalCorrectionIds) {
    const correction = correctionById.get(terminalId);
    if (['WITHDRAWAL', 'SESSION_DATE_WITHDRAWAL'].includes(correction.correctionKind)) continue;
    occupiedBarIdentityIds.push(correction.barIdentityId);
  }
  return {
    baseIngestionRegistryManifestId,
    expectedParentIngestionManifestId,
    terminalCorrectionIds,
    visibleCorrectionIds: sortedVisible,
    occupiedBarIdentityIds: [...new Set(occupiedBarIdentityIds)].sort(),
    publishedBarIdentityIds: [...new Set(publishedBarIdentityIds)].sort(),
    duplicateCandidateIds: [],
    chain,
    correctionById,
    observationById,
  };
}

/** @param {any} store @param {any} manifest @param {string|null} ingestionManifestId */
function verifyIngestionManifestClosure(store, manifest, ingestionManifestId = null) {
  const policy = verifyMarketDataIngestionPolicy({
    store, ingestionPolicyId: manifest.ingestionPolicyId,
  }).ingestionPolicy;
  const lineage = verifyMarketDataIngestionLineage({
    store,
    ingestionLineageId: manifest.ingestionLineageId,
    ingestionPolicyId: manifest.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: manifest.identityRegistryManifestId,
    calendarRegistryManifestId: manifest.calendarRegistryManifestId,
    corporateActionRegistryManifestId: manifest.corporateActionRegistryManifestId,
  }).ingestionLineage;

  const { ingestionRegistryManifest: baseRegistry } = verifyMarketDataIngestionRegistry({
    store, ingestionRegistryManifestId: manifest.baseIngestionRegistryManifestId,
  });
  const tipId = tipForLineage(baseRegistry, manifest.ingestionLineageId);

  if (manifest.expectedParentIngestionManifestId !== manifest.supersedesIngestionManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_CHAIN_INVALID', 'supersedes must equal expected parent');
  }
  if (tipId !== manifest.expectedParentIngestionManifestId) {
    if (manifest.expectedParentIngestionManifestId === null && tipId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_REQUIRED', 'first ingestion omitted required null parent while tip exists');
    }
    if (manifest.expectedParentIngestionManifestId !== null && tipId === null) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'expected parent is absent from the pinned registry tip');
    }
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_MISMATCH', 'expected parent is not the tip under the pinned registry');
  }
  if (manifest.expectedParentIngestionManifestId !== null) {
    let parent;
    try {
      parent = readTypedReference(
        store, manifest.expectedParentIngestionManifestId,
        MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION, 'expected parent ingestion manifest',
      );
    } catch (cause) {
      if (cause instanceof MarketDataL3Error && cause.code === 'MARKET_DATA_WRONG_REFERENCE_TYPE') throw cause;
      if (cause instanceof MarketDataL3Error && cause.code === 'MARKET_DATA_REFERENCE_MISSING') {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'expected parent is missing from CAS', { cause });
      }
      throw cause;
    }
    if (parent.ingestionLineageId !== manifest.ingestionLineageId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'expected parent belongs to another lineage');
    }
    if (parent.ingestionPolicyId !== manifest.ingestionPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'expected parent uses another ingestion policy');
    }
    if (!baseRegistry.ingestionManifestIds.includes(manifest.expectedParentIngestionManifestId)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'expected parent is invisible under the pinned registry');
    }
  }

  const attestation = verifyMarketDataSourceAttestation({
    store, sourceAttestationId: manifest.sourceAttestationId,
  }).sourceAttestation;
  if (attestation.ingestionLineageId !== manifest.ingestionLineageId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'attestation belongs to another lineage');
  }
  if (manifest.sourceArtifactId !== null) {
    const artifact = verifyMarketDataSourceArtifact({
      store, sourceArtifactId: manifest.sourceArtifactId, ingestionPolicyId: manifest.ingestionPolicyId,
    }).sourceArtifact;
    if (artifact.ingestionLineageId !== manifest.ingestionLineageId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'source artifact belongs to another lineage');
    }
    if (attestation.attestationMode === 'EMBEDDED_ARTIFACT'
        && attestation.embeddedArtifactId !== manifest.sourceArtifactId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'source artifact does not match embedded attestation');
    }
  } else if (attestation.attestationMode !== 'DIGEST_ONLY') {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_EMBEDDED_REQUIRED', 'null sourceArtifactId requires DIGEST_ONLY attestation');
  }

  const acquisition = verifyMarketDataAcquisitionRecord({
    store, acquisitionRecordId: manifest.acquisitionRecordId,
  }).acquisitionRecord;
  if (acquisition.ingestionLineageId !== manifest.ingestionLineageId
      || acquisition.sourceAttestationId !== manifest.sourceAttestationId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'acquisition does not match lineage or attestation');
  }

  const parseResult = verifyMarketDataParseResult({
    store, parseResultId: manifest.parseResultId,
  }).parseResult;
  if (parseResult.ingestionPolicyId !== manifest.ingestionPolicyId
      || parseResult.acquisitionRecordId !== manifest.acquisitionRecordId
      || (manifest.sourceArtifactId !== null && parseResult.sourceArtifactId !== manifest.sourceArtifactId)) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'ParseResult is foreign to this ingestion');
  }

  const candidateSet = verifyMarketDataCandidateSet({
    store, candidateSetId: manifest.candidateSetId,
  }).candidateSet;
  if (candidateSet.ingestionLineageId !== manifest.ingestionLineageId
      || candidateSet.ingestionPolicyId !== manifest.ingestionPolicyId
      || candidateSet.acquisitionRecordId !== manifest.acquisitionRecordId
      || candidateSet.parseResultId !== manifest.parseResultId
      || candidateSet.identityRegistryManifestId !== manifest.identityRegistryManifestId
      || candidateSet.calendarRegistryManifestId !== manifest.calendarRegistryManifestId
      || candidateSet.corporateActionRegistryManifestId !== manifest.corporateActionRegistryManifestId
      || (manifest.sourceArtifactId !== null && candidateSet.sourceArtifactId !== manifest.sourceArtifactId)) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'CandidateSet is foreign to this ingestion');
  }

  const report = verifyMarketDataValidationReport({
    store, validationReportId: manifest.validationReportId,
  }).validationReport;
  if (report.candidateSetId !== manifest.candidateSetId
      || report.ingestionPolicyId !== manifest.ingestionPolicyId
      || report.baseIngestionRegistryManifestId !== manifest.baseIngestionRegistryManifestId
      || report.expectedParentIngestionManifestId !== manifest.expectedParentIngestionManifestId
      || report.fatalErrors.length > 0) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'ValidationReport is foreign or fatal');
  }

  const publication = verifyMarketDataAcceptedCandidatePublicationManifest({
    store, publicationManifestId: manifest.acceptedCandidatePublicationManifestId,
  }).publicationManifest;
  if (publication.candidateSetId !== manifest.candidateSetId
      || publication.validationReportId !== manifest.validationReportId
      || publication.ingestionLineageId !== manifest.ingestionLineageId
      || publication.baseIngestionRegistryManifestId !== manifest.baseIngestionRegistryManifestId
      || publication.expectedParentIngestionManifestId !== manifest.expectedParentIngestionManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'publication manifest is foreign to this ingestion');
  }

  const assembly = verifyNormalizedMarketDataDeltaAssemblyManifest({
    store, deltaAssemblyManifestId: manifest.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  if (assembly.ingestionLineageId !== manifest.ingestionLineageId
      || assembly.candidateSetId !== manifest.candidateSetId
      || assembly.validationReportId !== manifest.validationReportId
      || assembly.publicationManifestId !== manifest.acceptedCandidatePublicationManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'delta assembly is foreign to this ingestion');
  }

  const publishedObservationIds = publication.publications
    .map((entry) => entry.observationId).filter(Boolean).slice().sort();
  const publishedCorrectionIds = publication.publications
    .flatMap((entry) => entry.correctionIds).slice().sort();
  const assemblyObservationIds = [...assembly.acceptedObservationIds].sort();
  const assemblyCorrectionIds = [...assembly.acceptedCorrectionIds].sort();
  if (!canonicalValuesEqual(manifest.newBarObservationIds, publishedObservationIds)
      || !canonicalValuesEqual(manifest.newBarObservationIds, assemblyObservationIds)) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'newBarObservationIds must equal publication and assembly unions');
  }
  if (!canonicalValuesEqual(manifest.newBarCorrectionIds, publishedCorrectionIds)
      || !canonicalValuesEqual(manifest.newBarCorrectionIds, assemblyCorrectionIds)) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'newBarCorrectionIds must equal publication and assembly unions');
  }

  const historicalObservationIds = new Set();
  const historicalCorrectionIds = new Set();
  if (manifest.expectedParentIngestionManifestId !== null) {
    const parentChain = walkIngestionChain(store, baseRegistry, manifest.expectedParentIngestionManifestId);
    for (const { ingestionManifest } of parentChain) {
      for (const id of ingestionManifest.newBarObservationIds) historicalObservationIds.add(id);
      for (const id of ingestionManifest.newBarCorrectionIds) historicalCorrectionIds.add(id);
    }
  }
  for (const observationId of manifest.newBarObservationIds) {
    if (historicalObservationIds.has(observationId)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'historical observation added to delta');
    }
    const observation = verifyMarketDataBarObservation({ store, observationId }).observation;
    if (observation.ingestionLineageId !== manifest.ingestionLineageId
        || observation.sourceArtifactId !== (manifest.sourceArtifactId ?? observation.sourceArtifactId)
        || observation.acquisitionRecordId !== manifest.acquisitionRecordId
        || observation.parseResultId !== manifest.parseResultId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'observation is foreign to this ingestion');
    }
  }
  for (const correctionId of manifest.newBarCorrectionIds) {
    if (historicalCorrectionIds.has(correctionId)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'historical correction added to delta');
    }
    const correction = verifyMarketDataBarCorrection({ store, correctionId }).correction;
    if (correction.ingestionLineageId !== manifest.ingestionLineageId
        || correction.acquisitionRecordId !== manifest.acquisitionRecordId
        || correction.parseResultId !== manifest.parseResultId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'correction is foreign to this ingestion');
    }
    if (correction.parentCorrectionId !== null
        && !manifest.newBarCorrectionIds.includes(correction.parentCorrectionId)
        && !historicalCorrectionIds.has(correction.parentCorrectionId)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'correction parent is foreign to the pinned chain');
    }
  }

  const derivedCapability = deriveTemporalCapabilityFromDeltaObjects(
    store, manifest.newBarObservationIds, manifest.newBarCorrectionIds,
  );
  if (manifest.temporalCapability !== derivedCapability) {
    throw new MarketDataL3Error(
      'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH',
      'temporalCapability diverges from contributive objects',
      { expected: derivedCapability, actual: manifest.temporalCapability },
    );
  }
  if (manifest.priceBasis !== lineage.priceBasis) {
    throw new MarketDataL3Error('MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH', 'priceBasis diverges from lineage');
  }
  const expectedTreatment = deriveCorporateActionTreatment(lineage.priceBasis);
  if (manifest.corporateActionTreatment !== expectedTreatment) {
    throw new MarketDataL3Error('MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH', 'corporateActionTreatment is inconsistent with priceBasis');
  }
  for (const observationId of manifest.newBarObservationIds) {
    const observation = verifyMarketDataBarObservation({ store, observationId }).observation;
    if (observation.values.priceBasis !== manifest.priceBasis) {
      throw new MarketDataL3Error('MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH', 'observation priceBasis diverges from manifest');
    }
  }

  return {
    policy,
    lineage,
    baseRegistry,
    attestation,
    acquisition,
    parseResult,
    candidateSet,
    report,
    publication,
    assembly,
    ingestionManifestId,
  };
}

/** @param {unknown} input */
export function buildMarketDataIngestionManifest(input) {
  const api = assertApiInput(input, ['manifest']);
  assertStore(api.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject']);
  const manifest = normalizeMarketDataIngestionManifestV1(api.manifest);
  const resolved = verifyIngestionManifestClosure(api.store, manifest, null);
  const stored = putCanonicalL3(api.store, MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION, manifest);
  return {
    ...resolved,
    ingestionManifestId: stored.objectId,
    ingestionManifest: stored.value,
    object: stored,
  };
}

/** @param {unknown} input */
export function verifyMarketDataIngestionManifest(input) {
  const api = assertApiInput(input, ['ingestionManifestId']);
  const manifest = readTypedReference(
    api.store, api.ingestionManifestId, MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION, 'ingestion manifest',
  );
  const resolved = verifyIngestionManifestClosure(api.store, manifest, api.ingestionManifestId);
  return {
    ingestionManifestId: api.ingestionManifestId,
    ingestionManifest: manifest,
    ...resolved,
  };
}

/** @param {any} store @param {any} registry @param {string|null} registryId @param {Set<string>} seen */
function verifyRegistryGraph(store, registry, registryId, seen) {
  const authority = verifyMarketDataIngestionRegistryAuthorityPolicy({
    store, ingestionRegistryAuthorityPolicyId: registry.ingestionRegistryAuthorityPolicyId,
  }).ingestionRegistryAuthorityPolicy;
  if (authority.authorityScope !== 'MARKET_DATA_INGESTION') {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_AUTHORITY_MISMATCH', 'authorityScope must be MARKET_DATA_INGESTION');
  }

  const manifests = new Map();
  for (const ingestionManifestId of registry.ingestionManifestIds) {
    const manifest = readTypedReference(
      store, ingestionManifestId, MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION, 'registry ingestion manifest',
    );
    manifests.set(ingestionManifestId, manifest);
  }

  // Tips must resolve to the correct lineage and be terminal under the listed set.
  for (const tip of registry.lineageTips) {
    const tipManifest = manifests.get(tip.tipIngestionManifestId);
    if (!tipManifest) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_CHAIN_INVALID', 'tip missing from ingestionManifestIds');
    }
    if (tipManifest.ingestionLineageId !== tip.ingestionLineageId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'tip targets a manifest of another lineage');
    }
  }

  // Every listed manifest must belong to a tip chain (no orphan branches in the listed set for its lineage).
  const tipByLineage = new Map(registry.lineageTips.map((tip) => [tip.ingestionLineageId, tip.tipIngestionManifestId]));
  const reachable = new Set();
  for (const [lineageId, tipId] of tipByLineage) {
    let cursor = tipId;
    const chainSeen = new Set();
    while (cursor !== null) {
      if (chainSeen.has(cursor)) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_CHAIN_INVALID', 'ingestion chain cycle under tip');
      }
      chainSeen.add(cursor);
      reachable.add(cursor);
      const manifest = manifests.get(cursor);
      if (!manifest) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'tip chain references a manifest absent from the registry list');
      }
      if (manifest.ingestionLineageId !== lineageId) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'chain crosses lineages');
      }
      if (manifest.expectedParentIngestionManifestId !== manifest.supersedesIngestionManifestId) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_CHAIN_INVALID', 'supersedes must equal expected parent');
      }
      const parentId = manifest.expectedParentIngestionManifestId;
      if (parentId === null) break;
      if (!manifests.has(parentId)) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'parent is not listed in this registry');
      }
      // Detect a second child of the same parent within the listed set (branch).
      const siblings = [...manifests.entries()]
        .filter(([, other]) => other.ingestionLineageId === lineageId
          && other.expectedParentIngestionManifestId === parentId)
        .map(([id]) => id);
      if (siblings.length > 1) {
        throw new MarketDataL3Error('MARKET_DATA_INGESTION_BRANCH', 'visible ingestion chain contains a branch');
      }
      cursor = parentId;
    }
  }
  for (const ingestionManifestId of registry.ingestionManifestIds) {
    if (!reachable.has(ingestionManifestId)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_BRANCH', 'listed ingestion manifest is unreachable from lineage tips');
    }
  }

  if (registry.supersedesIngestionRegistryManifestId !== null) {
    if (registry.supersedesIngestionRegistryManifestId === registryId
        || seen.has(registry.supersedesIngestionRegistryManifestId)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_REGISTRY_CYCLE', 'ingestion registry supersedes chain contains a cycle');
    }
    seen.add(registry.supersedesIngestionRegistryManifestId);
    const parent = readTypedReference(
      store, registry.supersedesIngestionRegistryManifestId,
      MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION, 'superseded ingestion registry',
    );
    if (parent.ingestionRegistryAuthorityPolicyId !== registry.ingestionRegistryAuthorityPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_AUTHORITY_MISMATCH', 'registry successor changed authority policy');
    }
    if (parent.ingestionManifestIds.some((id) => !registry.ingestionManifestIds.includes(id))) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_APPEND_ONLY_VIOLATION', 'registry removed historical ingestion manifests');
    }
    verifyRegistryGraph(store, parent, registry.supersedesIngestionRegistryManifestId, seen);
  }
  return { authority, manifests };
}

/** @param {unknown} input */
export function buildMarketDataIngestionRegistryManifest(input) {
  const api = assertApiInput(input, ['registry']);
  assertStore(api.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject']);
  const registry = normalizeMarketDataIngestionRegistryManifestV1(api.registry);
  const resolved = verifyRegistryGraph(api.store, registry, null, new Set());
  const stored = putCanonicalL3(api.store, MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION, registry);
  return {
    ingestionRegistryManifestId: stored.objectId,
    ingestionRegistryManifest: stored.value,
    object: stored,
    ...resolved,
  };
}

/** @param {unknown} input */
export function verifyMarketDataIngestionRegistry(input) {
  const api = assertApiInput(input, ['ingestionRegistryManifestId']);
  const registry = readTypedReference(
    api.store, api.ingestionRegistryManifestId,
    MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION, 'ingestion registry',
  );
  const resolved = verifyRegistryGraph(api.store, registry, api.ingestionRegistryManifestId, new Set());
  return {
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
    ingestionRegistryManifest: registry,
    ...resolved,
  };
}

/**
 * Append exactly one verified ingestion manifest onto an explicitly pinned base registry.
 * expectedParentIngestionManifestId is mandatory (null for the first tip of a lineage).
 * @param {unknown} input
 */
export function appendMarketDataIngestionRegistry(input) {
  const api = assertApiInput(input, [
    'baseIngestionRegistryManifestId',
    'expectedParentIngestionManifestId',
    'ingestionManifestId',
  ]);
  assertStore(api.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject']);
  assertCasId(api.baseIngestionRegistryManifestId, 'baseIngestionRegistryManifestId');
  assertCasId(api.expectedParentIngestionManifestId, 'expectedParentIngestionManifestId', true);
  assertCasId(api.ingestionManifestId, 'ingestionManifestId');

  const { ingestionRegistryManifest: base } = verifyMarketDataIngestionRegistry({
    store: api.store, ingestionRegistryManifestId: api.baseIngestionRegistryManifestId,
  });
  const { ingestionManifest: manifest } = verifyMarketDataIngestionManifest({
    store: api.store, ingestionManifestId: api.ingestionManifestId,
  });

  if (manifest.baseIngestionRegistryManifestId !== api.baseIngestionRegistryManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'ingestion manifest was built against another base registry');
  }
  if (manifest.expectedParentIngestionManifestId !== api.expectedParentIngestionManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_MISMATCH', 'append expected parent diverges from ingestion manifest');
  }

  const tipId = tipForLineage(base, manifest.ingestionLineageId);
  if (tipId !== api.expectedParentIngestionManifestId) {
    if (api.expectedParentIngestionManifestId === null && tipId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_REQUIRED', 'lineage tip exists under the pinned registry');
    }
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_MISMATCH', 'expected parent is not the current tip');
  }
  if (base.ingestionManifestIds.includes(api.ingestionManifestId)) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_APPEND_ONLY_VIOLATION', 'ingestion manifest is already present in the base registry');
  }

  const ingestionManifestIds = [...base.ingestionManifestIds, api.ingestionManifestId].sort();
  const lineageTips = base.lineageTips
    .filter((tip) => tip.ingestionLineageId !== manifest.ingestionLineageId)
    .concat([{
      ingestionLineageId: manifest.ingestionLineageId,
      tipIngestionManifestId: api.ingestionManifestId,
    }])
    .sort((left, right) => left.ingestionLineageId.localeCompare(right.ingestionLineageId));

  return buildMarketDataIngestionRegistryManifest({
    store: api.store,
    registry: {
      schemaVersion: MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      ingestionRegistryAuthorityPolicyId: base.ingestionRegistryAuthorityPolicyId,
      supersedesIngestionRegistryManifestId: api.baseIngestionRegistryManifestId,
      ingestionManifestIds,
      lineageTips,
    },
  });
}

export const recoverMarketDataIngestionManifest = verifyMarketDataIngestionManifest;
export const recoverMarketDataIngestionRegistry = verifyMarketDataIngestionRegistry;
