/** L4B-P closed contracts for official market-macro feature publication. */

import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertExactFields,
  assertNonEmptyString,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  assertUtcInstant,
} from './marketDataL3CommonV1.mjs';

export const MARKET_MACRO_FEATURE_AUTHORITY_POLICY_SCHEMA_VERSION =
  'MarketMacroFeatureAuthorityPolicy/1';
export const MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION =
  'MarketMacroFeaturePublicationManifest/1';
export const MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION =
  'MarketMacroFeatureRegistryManifest/1';
export const MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION =
  'MarketMacroFeatureCoverageReport/1';

export const MARKET_MACRO_FEATURE_PUBLICATION_L4BP_SCHEMA_VERSIONS = Object.freeze([
  MARKET_MACRO_FEATURE_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
]);

export const MARKET_MACRO_PUBLICATION_VERSION = 'MARKET_MACRO_FEATURE_L4B_P/1';
export const MARKET_MACRO_REGISTRY_NAMESPACE_VERSION =
  'MARKET_MACRO_FEATURE_REGISTRY_L4B_P/1';
export const MARKET_MACRO_FAMILY_CODES = Object.freeze([
  'RATES',
  'FOMC',
  'TREASURY_CURVE',
  'INFLATION',
  'UNEMPLOYMENT',
  'CLAIMS',
  'FULL_MACRO_STATE',
  'INSTRUMENT_PROJECTION',
]);
export const MARKET_MACRO_IMPLEMENTATION_PHASES = Object.freeze(['I1', 'I2', 'F1', 'F2']);
export const MARKET_MACRO_PUBLICATION_STATUSES = Object.freeze([
  'PUBLISHED',
  'PARTIAL',
  'EMPTY',
  'DEPRECATED',
  'WITHDRAWN',
]);
export const MARKET_MACRO_TEMPORAL_CAPABILITIES = Object.freeze([
  'EMPTY',
  'PARTIAL_POINT_IN_TIME',
  'COMPLETE_POINT_IN_TIME',
]);
export const MARKET_MACRO_FAMILY_COVERAGE_STATUSES = Object.freeze([
  'COMPLETE',
  'PARTIAL',
  'UNAVAILABLE',
]);

export const MARKET_MACRO_AUTHORITY_PIN_FIELDS = Object.freeze([
  'macroIngestionPolicyId',
  'macroSeriesRegistryManifestId',
  'macroVintageSetManifestId',
  'macroDatasetSnapshotManifestId',
  'macroAsOfResolutionPolicyId',
  'macroReleaseCalendarRegistryManifestId',
  'macroDatasetBindingId',
  'macroMaterializationReportId',
  'marketMacroFeatureComputationPolicyId',
  'marketMacroFeatureSourceBundleId',
  'macroStateBySessionRowsId',
  'marketMacroFeatureComputationReportId',
  'marketMacroInstrumentProjectionPolicyId',
  'marketMacroFullStateRowsId',
  'marketMacroInstrumentRowsId',
  'marketMacroFullComputationReportId',
  'marketSessionRegistryManifestId',
  'instrumentIdentityRegistryManifestId',
]);

export const MARKET_MACRO_AUTHORITY_POLICY_VALUES = Object.freeze({
  schemaVersion: MARKET_MACRO_FEATURE_AUTHORITY_POLICY_SCHEMA_VERSION,
  publicationMode: 'APPEND_ONLY_CANONICAL_REFERENCE_PUBLICATION',
  explicitPinOnly: true,
  latestPolicy: 'FORBIDDEN',
  networkPolicy: 'FORBIDDEN',
  sourceSelectionPolicy: 'EXPLICIT_CAS_REFERENCES_ONLY',
  asOfResolutionPolicy: 'PINNED_PUBLICATION_CHAIN_AT_EXPLICIT_KNOWLEDGE_CUTOFF',
  revisionPolicy: 'IMMUTABLE_PUBLICATION_WITH_EXPLICIT_SUPERSESSION',
  supersessionPolicy: 'IMMEDIATE_PARENT_REQUIRED_APPEND_ONLY',
  withdrawalPolicy: 'EXPLICIT_TOMBSTONE_HISTORY_PRESERVED',
  partialCoveragePolicy: 'EXPLICIT_PARTIAL_STATUS_REQUIRED',
  emptyPublicationPolicy: 'EXPLICIT_EMPTY_STATUS_ALLOWED',
  orderingPolicy: 'CLOSED_FAMILY_ORDER_THEN_PUBLICATION_VERSION',
  digestPolicy: 'SHA256_CANONICAL_JSON_DERIVED_ONLY',
  implementationIdentityPolicy: 'CLOSED_TRANSFORM_IMPLEMENTATION_MANIFEST_V2',
  compatibilityPolicy: 'I1_I2_F1_F2_EXACT_PIN_CLOSURE',
  publicationStatusPolicy: 'DERIVED_FROM_COVERAGE_AND_EXPLICIT_HISTORY_EVENT',
  unsupportedInstrumentPolicy: 'EXPLICIT_NOT_APPLICABLE_NO_SCORE',
  scorePolicy: 'FORBIDDEN',
  recommendationPolicy: 'FORBIDDEN',
});

const AUTHORITY_POLICY_FIELDS = Object.freeze(Object.keys(MARKET_MACRO_AUTHORITY_POLICY_VALUES));
const REGISTRY_FIELDS = Object.freeze([
  'schemaVersion',
  'authorityPolicyId',
  'registryNamespaceVersion',
  'publicationVersion',
  'jurisdictionCode',
  'currencyCode',
  'availableAt',
  'temporalCapability',
  'supersedesRegistryManifestId',
  'entries',
  'orderedEntryDigest',
]);
const REGISTRY_ENTRY_FIELDS = Object.freeze([
  'familyCode',
  'phaseCode',
  'featureVersion',
  'policyId',
  'sourceBundleId',
  'rowsId',
  'reportId',
  'implementationManifestId',
  'availableAt',
  'publicationStatus',
  'temporalCapability',
  'supersedesEntryIdentityDigest',
  'withdrawalReason',
  'entryIdentityDigest',
]);
const IMPLEMENTATION_IDENTITY_FIELDS = Object.freeze([
  'phaseCode',
  'implementationManifestId',
]);
const FAMILY_COVERAGE_FIELDS = Object.freeze([
  'familyCode',
  'availableSessionCount',
  'staleSessionCount',
  'withdrawnSessionCount',
  'unavailableSessionCount',
  'coverageStatus',
]);
export const MARKET_MACRO_COVERAGE_COUNT_FIELDS = Object.freeze([
  'sessionCount',
  'f1RowCount',
  'f2FullRowCount',
  'instrumentRowCount',
  'instrumentCount',
  'completeSessionCount',
  'partialSessionCount',
  'unavailableSessionCount',
  'staleResolutionCount',
  'withdrawnResolutionCount',
  'futureRejectedCount',
]);
const COVERAGE_FIELDS = Object.freeze([
  'schemaVersion',
  'registryManifestId',
  'authorityPins',
  'firstSessionId',
  'lastSessionId',
  'firstSessionDate',
  'lastSessionDate',
  'temporalCapability',
  ...MARKET_MACRO_COVERAGE_COUNT_FIELDS,
  'familyCoverage',
  'projectionStatusCounts',
  'emptyPublication',
  'orderedSessionDigest',
  'orderedRowDigest',
  'orderedInstrumentRowDigest',
  'orderedProvenanceDigest',
  'orderedPublicationEntryDigest',
]);
const PROJECTION_STATUS_FIELDS = Object.freeze([
  'PROJECTED',
  'PARTIAL',
  'NOT_APPLICABLE',
  'SESSION_MISMATCH',
]);
const PUBLICATION_FIELDS = Object.freeze([
  'schemaVersion',
  'authorityPolicyId',
  'registryManifestId',
  'coverageReportId',
  'authorityPins',
  'implementationIdentities',
  'publicationVersion',
  'jurisdictionCode',
  'currencyCode',
  'availableAt',
  'firstSessionId',
  'lastSessionId',
  'firstSessionDate',
  'lastSessionDate',
  'temporalCapability',
  'publicationStatus',
  'supersedesPublicationManifestId',
  'withdrawalReason',
  'publishedEntries',
  'orderedPublicationEntryDigest',
]);
const PUBLISHED_ENTRY_FIELDS = Object.freeze(['familyCode', 'entryIdentityDigest']);

function invalid(message) {
  throw new MarketDataL3Error('MARKET_DATA_MACRO_PUBLICATION_INVALID', message);
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
}

function normalizeAuthorityPins(value) {
  const pins = assertPlainObject(value, 'authorityPins');
  assertExactFields(pins, MARKET_MACRO_AUTHORITY_PIN_FIELDS);
  const out = {};
  for (const field of MARKET_MACRO_AUTHORITY_PIN_FIELDS) {
    assertCasId(pins[field], `authorityPins.${field}`);
    out[field] = pins[field];
  }
  return out;
}

function assertClosedOrder(items, expected, label, key) {
  if (!Array.isArray(items) || items.length !== expected.length) {
    invalid(`${label} must contain exactly ${expected.length} entries`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (items[index]?.[key] !== expected[index]) {
      invalid(`${label} must follow the closed ${key} order`);
    }
  }
}

function normalizeNullableReason(value, status, label) {
  if (status === 'WITHDRAWN' || status === 'DEPRECATED') {
    assertNonEmptyString(value, label);
    return value;
  }
  if (value !== null) invalid(`${label} must be null outside WITHDRAWN/DEPRECATED`);
  return null;
}

export function normalizeMarketMacroFeatureAuthorityPolicyV1(value) {
  const policy = assertPlainObject(value, 'market macro publication authority policy');
  assertExactFields(policy, AUTHORITY_POLICY_FIELDS);
  assertSchemaVersion(policy, MARKET_MACRO_FEATURE_AUTHORITY_POLICY_SCHEMA_VERSION);
  for (const field of AUTHORITY_POLICY_FIELDS) {
    const expected = MARKET_MACRO_AUTHORITY_POLICY_VALUES[field];
    if (policy[field] !== expected) invalid(`authority policy ${field} diverges from closed value`);
  }
  return { ...MARKET_MACRO_AUTHORITY_POLICY_VALUES };
}

export function normalizeMarketMacroFeatureRegistryEntryV1(value, label = 'registry entry') {
  const entry = assertPlainObject(value, label);
  assertExactFields(entry, REGISTRY_ENTRY_FIELDS);
  assertEnum(entry.familyCode, MARKET_MACRO_FAMILY_CODES, `${label}.familyCode`);
  assertEnum(entry.phaseCode, ['F1', 'F2'], `${label}.phaseCode`);
  assertNonEmptyString(entry.featureVersion, `${label}.featureVersion`);
  for (const field of ['policyId', 'rowsId', 'reportId', 'implementationManifestId',
    'entryIdentityDigest']) {
    assertCasId(entry[field], `${label}.${field}`);
  }
  assertCasId(entry.sourceBundleId, `${label}.sourceBundleId`, true);
  assertUtcInstant(entry.availableAt, `${label}.availableAt`);
  assertEnum(entry.publicationStatus, MARKET_MACRO_PUBLICATION_STATUSES,
    `${label}.publicationStatus`);
  assertEnum(entry.temporalCapability, MARKET_MACRO_TEMPORAL_CAPABILITIES,
    `${label}.temporalCapability`);
  assertCasId(entry.supersedesEntryIdentityDigest,
    `${label}.supersedesEntryIdentityDigest`, true);
  const withdrawalReason = normalizeNullableReason(entry.withdrawalReason,
    entry.publicationStatus, `${label}.withdrawalReason`);
  return {
    familyCode: entry.familyCode,
    phaseCode: entry.phaseCode,
    featureVersion: entry.featureVersion,
    policyId: entry.policyId,
    sourceBundleId: entry.sourceBundleId,
    rowsId: entry.rowsId,
    reportId: entry.reportId,
    implementationManifestId: entry.implementationManifestId,
    availableAt: entry.availableAt,
    publicationStatus: entry.publicationStatus,
    temporalCapability: entry.temporalCapability,
    supersedesEntryIdentityDigest: entry.supersedesEntryIdentityDigest,
    withdrawalReason,
    entryIdentityDigest: entry.entryIdentityDigest,
  };
}

export function normalizeMarketMacroFeatureRegistryManifestV1(value) {
  const registry = assertPlainObject(value, 'market macro feature registry manifest');
  assertExactFields(registry, REGISTRY_FIELDS);
  assertSchemaVersion(registry, MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION);
  assertCasId(registry.authorityPolicyId, 'authorityPolicyId');
  if (registry.registryNamespaceVersion !== MARKET_MACRO_REGISTRY_NAMESPACE_VERSION) {
    invalid('registryNamespaceVersion diverges from closed value');
  }
  if (registry.publicationVersion !== MARKET_MACRO_PUBLICATION_VERSION) {
    invalid('publicationVersion diverges from closed value');
  }
  if (registry.jurisdictionCode !== 'UNITED_STATES' || registry.currencyCode !== 'USD') {
    invalid('registry jurisdiction/currency must be UNITED_STATES/USD');
  }
  assertUtcInstant(registry.availableAt, 'availableAt');
  assertEnum(registry.temporalCapability, MARKET_MACRO_TEMPORAL_CAPABILITIES,
    'temporalCapability');
  assertCasId(registry.supersedesRegistryManifestId, 'supersedesRegistryManifestId', true);
  assertClosedOrder(registry.entries, MARKET_MACRO_FAMILY_CODES, 'entries', 'familyCode');
  const entries = registry.entries.map((entry, index) =>
    normalizeMarketMacroFeatureRegistryEntryV1(entry, `entries[${index}]`));
  assertCasId(registry.orderedEntryDigest, 'orderedEntryDigest');
  return {
    schemaVersion: MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId: registry.authorityPolicyId,
    registryNamespaceVersion: MARKET_MACRO_REGISTRY_NAMESPACE_VERSION,
    publicationVersion: MARKET_MACRO_PUBLICATION_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    availableAt: registry.availableAt,
    temporalCapability: registry.temporalCapability,
    supersedesRegistryManifestId: registry.supersedesRegistryManifestId,
    entries,
    orderedEntryDigest: registry.orderedEntryDigest,
  };
}

function normalizeImplementationIdentities(value) {
  assertClosedOrder(value, MARKET_MACRO_IMPLEMENTATION_PHASES,
    'implementationIdentities', 'phaseCode');
  return value.map((item, index) => {
    const identity = assertPlainObject(item, `implementationIdentities[${index}]`);
    assertExactFields(identity, IMPLEMENTATION_IDENTITY_FIELDS);
    assertCasId(identity.implementationManifestId,
      `implementationIdentities[${index}].implementationManifestId`);
    return {
      phaseCode: identity.phaseCode,
      implementationManifestId: identity.implementationManifestId,
    };
  });
}

function normalizeFamilyCoverage(value) {
  assertClosedOrder(value, MARKET_MACRO_FAMILY_CODES, 'familyCoverage', 'familyCode');
  return value.map((item, index) => {
    const coverage = assertPlainObject(item, `familyCoverage[${index}]`);
    assertExactFields(coverage, FAMILY_COVERAGE_FIELDS);
    for (const field of ['availableSessionCount', 'staleSessionCount',
      'withdrawnSessionCount', 'unavailableSessionCount']) {
      assertSafeInteger(coverage[field], `familyCoverage[${index}].${field}`, { nonNegative: true });
    }
    assertEnum(coverage.coverageStatus, MARKET_MACRO_FAMILY_COVERAGE_STATUSES,
      `familyCoverage[${index}].coverageStatus`);
    return { ...coverage };
  });
}

function normalizeProjectionStatusCounts(value) {
  const counts = assertPlainObject(value, 'projectionStatusCounts');
  assertExactFields(counts, PROJECTION_STATUS_FIELDS);
  const out = {};
  for (const field of PROJECTION_STATUS_FIELDS) {
    assertSafeInteger(counts[field], `projectionStatusCounts.${field}`, { nonNegative: true });
    out[field] = counts[field];
  }
  return out;
}

export function normalizeMarketMacroFeatureCoverageReportV1(value) {
  const report = assertPlainObject(value, 'market macro feature coverage report');
  assertExactFields(report, COVERAGE_FIELDS);
  assertSchemaVersion(report, MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION);
  assertCasId(report.registryManifestId, 'registryManifestId');
  const authorityPins = normalizeAuthorityPins(report.authorityPins);
  assertCasId(report.firstSessionId, 'firstSessionId', true);
  assertCasId(report.lastSessionId, 'lastSessionId', true);
  if (report.firstSessionDate !== null) assertCivilDate(report.firstSessionDate, 'firstSessionDate');
  if (report.lastSessionDate !== null) assertCivilDate(report.lastSessionDate, 'lastSessionDate');
  assertEnum(report.temporalCapability, MARKET_MACRO_TEMPORAL_CAPABILITIES,
    'temporalCapability');
  for (const field of MARKET_MACRO_COVERAGE_COUNT_FIELDS) {
    assertSafeInteger(report[field], field, { nonNegative: true });
  }
  if ((report.sessionCount === 0) !== (report.firstSessionId === null)
      || (report.firstSessionId === null) !== (report.lastSessionId === null)
      || (report.firstSessionDate === null) !== (report.lastSessionDate === null)
      || (report.firstSessionId === null) !== (report.firstSessionDate === null)) {
    invalid('coverage empty bounds diverge from sessionCount');
  }
  assertBoolean(report.emptyPublication, 'emptyPublication');
  if (report.emptyPublication !== (report.sessionCount === 0)) {
    invalid('emptyPublication diverges from sessionCount');
  }
  const familyCoverage = normalizeFamilyCoverage(report.familyCoverage);
  const projectionStatusCounts = normalizeProjectionStatusCounts(report.projectionStatusCounts);
  for (const field of ['orderedSessionDigest', 'orderedRowDigest',
    'orderedInstrumentRowDigest', 'orderedProvenanceDigest',
    'orderedPublicationEntryDigest']) {
    assertCasId(report[field], field);
  }
  return {
    schemaVersion: MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION,
    registryManifestId: report.registryManifestId,
    authorityPins,
    firstSessionId: report.firstSessionId,
    lastSessionId: report.lastSessionId,
    firstSessionDate: report.firstSessionDate,
    lastSessionDate: report.lastSessionDate,
    temporalCapability: report.temporalCapability,
    ...Object.fromEntries(MARKET_MACRO_COVERAGE_COUNT_FIELDS.map((field) => [field, report[field]])),
    familyCoverage,
    projectionStatusCounts,
    emptyPublication: report.emptyPublication,
    orderedSessionDigest: report.orderedSessionDigest,
    orderedRowDigest: report.orderedRowDigest,
    orderedInstrumentRowDigest: report.orderedInstrumentRowDigest,
    orderedProvenanceDigest: report.orderedProvenanceDigest,
    orderedPublicationEntryDigest: report.orderedPublicationEntryDigest,
  };
}

export function normalizeMarketMacroFeaturePublicationManifestV1(value) {
  const manifest = assertPlainObject(value, 'market macro feature publication manifest');
  assertExactFields(manifest, PUBLICATION_FIELDS);
  assertSchemaVersion(manifest, MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION);
  for (const field of ['authorityPolicyId', 'registryManifestId', 'coverageReportId']) {
    assertCasId(manifest[field], field);
  }
  const authorityPins = normalizeAuthorityPins(manifest.authorityPins);
  const implementationIdentities = normalizeImplementationIdentities(
    manifest.implementationIdentities);
  if (manifest.publicationVersion !== MARKET_MACRO_PUBLICATION_VERSION) {
    invalid('publicationVersion diverges from closed value');
  }
  if (manifest.jurisdictionCode !== 'UNITED_STATES' || manifest.currencyCode !== 'USD') {
    invalid('publication jurisdiction/currency must be UNITED_STATES/USD');
  }
  assertUtcInstant(manifest.availableAt, 'availableAt');
  assertCasId(manifest.firstSessionId, 'firstSessionId', true);
  assertCasId(manifest.lastSessionId, 'lastSessionId', true);
  if (manifest.firstSessionDate !== null) assertCivilDate(manifest.firstSessionDate, 'firstSessionDate');
  if (manifest.lastSessionDate !== null) assertCivilDate(manifest.lastSessionDate, 'lastSessionDate');
  assertEnum(manifest.temporalCapability, MARKET_MACRO_TEMPORAL_CAPABILITIES,
    'temporalCapability');
  assertEnum(manifest.publicationStatus, MARKET_MACRO_PUBLICATION_STATUSES,
    'publicationStatus');
  assertCasId(manifest.supersedesPublicationManifestId,
    'supersedesPublicationManifestId', true);
  const withdrawalReason = normalizeNullableReason(manifest.withdrawalReason,
    manifest.publicationStatus, 'withdrawalReason');
  assertClosedOrder(manifest.publishedEntries, MARKET_MACRO_FAMILY_CODES,
    'publishedEntries', 'familyCode');
  const publishedEntries = manifest.publishedEntries.map((item, index) => {
    const entry = assertPlainObject(item, `publishedEntries[${index}]`);
    assertExactFields(entry, PUBLISHED_ENTRY_FIELDS);
    assertCasId(entry.entryIdentityDigest,
      `publishedEntries[${index}].entryIdentityDigest`);
    return { familyCode: entry.familyCode, entryIdentityDigest: entry.entryIdentityDigest };
  });
  assertCasId(manifest.orderedPublicationEntryDigest, 'orderedPublicationEntryDigest');
  return {
    schemaVersion: MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId: manifest.authorityPolicyId,
    registryManifestId: manifest.registryManifestId,
    coverageReportId: manifest.coverageReportId,
    authorityPins,
    implementationIdentities,
    publicationVersion: MARKET_MACRO_PUBLICATION_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    availableAt: manifest.availableAt,
    firstSessionId: manifest.firstSessionId,
    lastSessionId: manifest.lastSessionId,
    firstSessionDate: manifest.firstSessionDate,
    lastSessionDate: manifest.lastSessionDate,
    temporalCapability: manifest.temporalCapability,
    publicationStatus: manifest.publicationStatus,
    supersedesPublicationManifestId: manifest.supersedesPublicationManifestId,
    withdrawalReason,
    publishedEntries,
    orderedPublicationEntryDigest: manifest.orderedPublicationEntryDigest,
  };
}
