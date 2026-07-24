import {
  MARKET_MACRO_AUTHORITY_PIN_FIELDS,
  MARKET_MACRO_AUTHORITY_POLICY_VALUES,
  MARKET_MACRO_FAMILY_CODES,
  MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_MACRO_IMPLEMENTATION_PHASES,
  MARKET_MACRO_PUBLICATION_VERSION,
  MARKET_MACRO_REGISTRY_NAMESPACE_VERSION,
} from '../../src/contracts/marketMacroFeaturePublicationContractsL4BPV1.mjs';

export function sampleId(seed) {
  return `sha256:${Number(seed).toString(16).padStart(64, '0')}`;
}

export function sampleAuthorityPins() {
  return Object.fromEntries(MARKET_MACRO_AUTHORITY_PIN_FIELDS.map(
    (field, index) => [field, sampleId(index + 1)]));
}

export function sampleImplementationIdentities() {
  return MARKET_MACRO_IMPLEMENTATION_PHASES.map((phaseCode, index) => ({
    phaseCode,
    implementationManifestId: sampleId(30 + index),
  }));
}

export function sampleRegistry() {
  const entries = MARKET_MACRO_FAMILY_CODES.map((familyCode, index) => ({
    familyCode,
    phaseCode: index < 3 ? 'F1' : 'F2',
    featureVersion: index < 3
      ? 'MARKET_MACRO_FEATURE_L4B_F1/1'
      : 'MARKET_MACRO_FEATURE_L4B_F2/1',
    policyId: sampleId(index < 3 ? 40 : 41),
    sourceBundleId: sampleId(42),
    rowsId: sampleId(50 + index),
    reportId: sampleId(index < 3 ? 60 : 61),
    implementationManifestId: sampleId(index < 3 ? 32 : 33),
    availableAt: '2026-03-17T00:00:00.000Z',
    publicationStatus: 'PUBLISHED',
    temporalCapability: 'COMPLETE_POINT_IN_TIME',
    supersedesEntryIdentityDigest: null,
    withdrawalReason: null,
    entryIdentityDigest: sampleId(70 + index),
  }));
  return {
    schemaVersion: MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId: sampleId(90),
    registryNamespaceVersion: MARKET_MACRO_REGISTRY_NAMESPACE_VERSION,
    publicationVersion: MARKET_MACRO_PUBLICATION_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    availableAt: '2026-03-17T00:00:00.000Z',
    temporalCapability: 'COMPLETE_POINT_IN_TIME',
    supersedesRegistryManifestId: null,
    entries,
    orderedEntryDigest: sampleId(99),
  };
}

export function sampleCoverage() {
  return {
    schemaVersion: MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION,
    registryManifestId: sampleId(100),
    authorityPins: sampleAuthorityPins(),
    firstSessionId: sampleId(101),
    lastSessionId: sampleId(102),
    firstSessionDate: '2026-03-16',
    lastSessionDate: '2026-03-16',
    temporalCapability: 'COMPLETE_POINT_IN_TIME',
    sessionCount: 1,
    f1RowCount: 1,
    f2FullRowCount: 1,
    instrumentRowCount: 1,
    instrumentCount: 1,
    completeSessionCount: 1,
    partialSessionCount: 0,
    unavailableSessionCount: 0,
    staleResolutionCount: 0,
    withdrawnResolutionCount: 0,
    futureRejectedCount: 3,
    familyCoverage: MARKET_MACRO_FAMILY_CODES.map((familyCode) => ({
      familyCode,
      availableSessionCount: 1,
      staleSessionCount: 0,
      withdrawnSessionCount: 0,
      unavailableSessionCount: 0,
      coverageStatus: 'COMPLETE',
    })),
    projectionStatusCounts: {
      PROJECTED: 1,
      PARTIAL: 0,
      NOT_APPLICABLE: 0,
      SESSION_MISMATCH: 0,
    },
    emptyPublication: false,
    orderedSessionDigest: sampleId(110),
    orderedRowDigest: sampleId(111),
    orderedInstrumentRowDigest: sampleId(112),
    orderedProvenanceDigest: sampleId(113),
    orderedPublicationEntryDigest: sampleId(99),
  };
}

export function samplePublication() {
  const registry = sampleRegistry();
  const coverage = sampleCoverage();
  return {
    schemaVersion: MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId: registry.authorityPolicyId,
    registryManifestId: coverage.registryManifestId,
    coverageReportId: sampleId(120),
    authorityPins: sampleAuthorityPins(),
    implementationIdentities: sampleImplementationIdentities(),
    publicationVersion: MARKET_MACRO_PUBLICATION_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    availableAt: '2026-03-17T00:00:00.000Z',
    firstSessionId: coverage.firstSessionId,
    lastSessionId: coverage.lastSessionId,
    firstSessionDate: coverage.firstSessionDate,
    lastSessionDate: coverage.lastSessionDate,
    temporalCapability: coverage.temporalCapability,
    publicationStatus: 'PUBLISHED',
    supersedesPublicationManifestId: null,
    withdrawalReason: null,
    publishedEntries: registry.entries.map((entry) => ({
      familyCode: entry.familyCode,
      entryIdentityDigest: entry.entryIdentityDigest,
    })),
    orderedPublicationEntryDigest: registry.orderedEntryDigest,
  };
}

export function samplePolicy() {
  return structuredClone(MARKET_MACRO_AUTHORITY_POLICY_VALUES);
}
