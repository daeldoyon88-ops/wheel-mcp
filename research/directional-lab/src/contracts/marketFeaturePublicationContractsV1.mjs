/**
 * L4A-C3 closed contracts for reference-only publication of the verified
 * technical, volume/structure and seasonality feature families.
 */

import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  assertUtcInstant,
} from './marketDataL3CommonV1.mjs';
import { MARKET_DATA_CORPORATE_ACTION_TREATMENTS, MARKET_DATA_INGESTION_PRICE_BASES,
  MARKET_DATA_TEMPORAL_CAPABILITIES } from './marketDataIngestionRegistryL3V1.mjs';
import { MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS, MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION }
  from './marketTechnicalFeatureComputationL4V1.mjs';
import { MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS, MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION }
  from './marketVolumeStructureFeatureComputationL4V1.mjs';
import { MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_VERSION, MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION }
  from './marketSeasonalityFeatureComputationL4V1.mjs';

export const MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION =
  'MarketFeaturePublicationAuthorityPolicy/1';
export const MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION =
  'MarketFeaturePublicationManifest/1';
export const MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION =
  'MarketFeaturePublicationRegistryManifest/1';

export const MARKET_FEATURE_PUBLICATION_L4_SCHEMA_VERSIONS = Object.freeze([
  MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
]);

export const MARKET_FEATURE_SET_VERSION = 'MARKET_FEATURE_SET_L4A_ABC/1';
export const MARKET_TECHNICAL_FEATURE_FAMILY_CODE = 'MARKET_TECHNICAL_FEATURE_L4A_A';
export const MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE = 'MARKET_VOLUME_STRUCTURE_FEATURE_L4A_B';
export const MARKET_SEASONALITY_FEATURE_FAMILY_CODE = 'MARKET_SEASONALITY_FEATURE_L4A_C';
export const MARKET_FEATURE_PUBLICATION_FAMILY_CODES = Object.freeze([
  MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
  MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
]);

export const MARKET_FEATURE_PUBLICATION_POLICY_VERSION =
  'MARKET_FEATURE_PUBLICATION_AUTHORITY_V1';
export const MARKET_FEATURE_PUBLICATION_POLICY_VALUES = Object.freeze({
  publicationMode: 'REFERENCE_MANIFEST_ONLY',
  requiredFeatureSetVersion: MARKET_FEATURE_SET_VERSION,
  requiredFamilyCodes: MARKET_FEATURE_PUBLICATION_FAMILY_CODES,
  requiredFamilyCount: 3,
  requiredFamiliesMustBeVerified: true,
  sameInstrumentRequired: true,
  sameDatasetSnapshotBindingRequired: true,
  sameKnowledgeCutoffRequired: true,
  sameRowIdentityDigestRequired: true,
  sameSessionCoverageRequired: true,
  emptyPublicationAllowed: true,
  duplicateFamilyPolicy: 'FORBIDDEN',
  missingFamilyPolicy: 'FORBIDDEN',
  unknownFamilyPolicy: 'FORBIDDEN',
  familyOrdering: 'L4A_A_THEN_L4A_B_THEN_L4A_C',
  latestResolutionPolicy: 'FORBIDDEN',
  resolutionMode: 'EXPLICIT_AS_OF_ON_PINNED_REGISTRY',
  registryMutationPolicy: 'APPEND_ONLY_SUPERSEDING_MANIFESTS',
  registryConflictPolicy: 'REJECT_MULTIPLE_TIPS_FOR_SAME_KEY',
  registryCyclePolicy: 'FORBIDDEN',
  crossBindingPublicationPolicy: 'FORBIDDEN',
  crossInstrumentPublicationPolicy: 'FORBIDDEN',
  crossSnapshotPublicationPolicy: 'FORBIDDEN',
  crossCutoffPublicationPolicy: 'FORBIDDEN',
  rowAlignmentPolicy: 'EXACT_ORDERED_ROW_IDENTITY_DIGEST',
  reportVerificationPolicy: 'RECOMPUTE_AND_VERIFY_EACH_FAMILY',
  policyVersion: MARKET_FEATURE_PUBLICATION_POLICY_VERSION,
});

const POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MARKET_FEATURE_PUBLICATION_POLICY_VALUES),
]);
const COVERAGE_FIELDS = Object.freeze([
  'rowCount', 'firstSessionDate', 'lastSessionDate', 'orderedRowIdentityDigest',
]);
const FAMILY_FIELDS = Object.freeze([
  'familyCode', 'featureFamilyVersion', 'rowsSchemaVersion', 'reportSchemaVersion',
  'sourceBundleId', 'computationPolicyId', 'rowsId', 'reportId', 'implementationManifestId',
  'instrumentIdentityId', 'datasetSnapshotBindingId', 'datasetSnapshotManifestId',
  'normalizedMarketDataObjectId', 'calendarRegistryManifestId', 'knowledgeCutoff',
  'temporalCapability', 'priceBasis', 'corporateActionTreatment',
  'rowCount', 'firstSessionDate', 'lastSessionDate', 'orderedRowIdentityDigest',
]);
const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion', 'publicationAuthorityPolicyId', 'featureSetVersion',
  'instrumentIdentityId', 'datasetSnapshotBindingId', 'datasetSnapshotManifestId',
  'normalizedMarketDataObjectId', 'calendarRegistryManifestId', 'knowledgeCutoff',
  'temporalCapability', 'priceBasis', 'corporateActionTreatment', 'sessionCoverage', 'families',
]);
const LOGICAL_KEY_FIELDS = Object.freeze([
  'instrumentIdentityId', 'datasetSnapshotBindingId',
  'publicationAuthorityPolicyId', 'featureSetVersion',
]);
const REGISTRY_ENTRY_FIELDS = Object.freeze([
  'publicationManifestId', 'logicalKey', 'knowledgeCutoff', 'sessionCoverage',
  'supersedesPublicationManifestId',
]);
const REGISTRY_FIELDS = Object.freeze([
  'schemaVersion', 'publicationAuthorityPolicyId', 'supersedesRegistryManifestId', 'entries',
]);

function keyLabel(key) {
  if (typeof key === 'string') return key;
  const global = Symbol.keyFor(key);
  return global === undefined ? `Symbol(${key.description ?? ''})` : `Symbol.for(${JSON.stringify(global)})`;
}

/** Reject inherited records, Symbols, non-enumerable properties and accessors. */
function closedRecord(value, fields, label, code) {
  const record = assertPlainObject(value, label);
  const allowed = new Set(fields);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (!descriptor || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
      throw new MarketDataL3Error(code, `${label}.${field} must be an own enumerable data property`);
    }
  }
  const extra = Reflect.ownKeys(record)
    .filter((key) => typeof key !== 'string' || !allowed.has(key))
    .sort((left, right) => keyLabel(left).localeCompare(keyLabel(right)))[0];
  if (extra !== undefined) throw new MarketDataL3Error(code, `${label} contains unknown field ${keyLabel(extra)}`);
  return record;
}

function copyClosed(value) {
  if (Array.isArray(value)) return value.map(copyClosed);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, copyClosed(value[key])]));
  }
  return value;
}

function sameClosedValue(left, right) {
  if (Array.isArray(right)) return Array.isArray(left) && left.length === right.length
    && right.every((value, index) => sameClosedValue(left[index], value));
  if (right !== null && typeof right === 'object') {
    if (left === null || typeof left !== 'object' || Array.isArray(left)) return false;
    const keys = Object.keys(right);
    return Object.keys(left).length === keys.length
      && keys.every((key) => Object.hasOwn(left, key) && sameClosedValue(left[key], right[key]));
  }
  return left === right;
}

export function normalizeMarketFeaturePublicationAuthorityPolicyV1(value) {
  const code = 'MARKET_DATA_FEATURE_PUBLICATION_POLICY_INVALID';
  const policy = closedRecord(value, POLICY_FIELDS,
    MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(MARKET_FEATURE_PUBLICATION_POLICY_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `policy field ${field} diverges from closed V1`);
    }
  }
  return { schemaVersion: MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
    ...copyClosed(MARKET_FEATURE_PUBLICATION_POLICY_VALUES) };
}

export function normalizeMarketFeaturePublicationSessionCoverageV1(value, label = 'sessionCoverage') {
  const code = 'MARKET_DATA_FEATURE_PUBLICATION_COVERAGE_MISMATCH';
  const coverage = closedRecord(value, COVERAGE_FIELDS, label, code);
  assertSafeInteger(coverage.rowCount, `${label}.rowCount`, { nonNegative: true });
  if (coverage.firstSessionDate !== null) assertCivilDate(coverage.firstSessionDate, `${label}.firstSessionDate`);
  if (coverage.lastSessionDate !== null) assertCivilDate(coverage.lastSessionDate, `${label}.lastSessionDate`);
  if ((coverage.firstSessionDate === null) !== (coverage.lastSessionDate === null)
      || (coverage.rowCount === 0) !== (coverage.firstSessionDate === null)
      || (coverage.firstSessionDate !== null && coverage.firstSessionDate > coverage.lastSessionDate)) {
    throw new MarketDataL3Error(code, `${label} date range diverges from rowCount`);
  }
  if (typeof coverage.orderedRowIdentityDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(coverage.orderedRowIdentityDigest)) {
    throw new MarketDataL3Error(code, `${label}.orderedRowIdentityDigest is invalid`);
  }
  return Object.fromEntries(COVERAGE_FIELDS.map((field) => [field, coverage[field]]));
}

function normalizeFamilyVersion(value, familyCode) {
  if (familyCode === MARKET_SEASONALITY_FEATURE_FAMILY_CODE) {
    if (value !== MARKET_SEASONALITY_FEATURE_FAMILY_VERSION) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH',
        'seasonality featureFamilyVersion is invalid');
    }
    return value;
  }
  const expected = familyCode === MARKET_TECHNICAL_FEATURE_FAMILY_CODE
    ? MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS : MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS;
  const record = closedRecord(value, Object.keys(expected), 'featureFamilyVersion',
    'MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH');
  if (!sameClosedValue(record, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH',
      'featureFamilyVersion diverges from the verified family report');
  }
  return copyClosed(expected);
}

function normalizeFamily(value, index) {
  const label = `families[${index}]`;
  const family = closedRecord(value, FAMILY_FIELDS, label,
    'MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH');
  assertEnum(family.familyCode, MARKET_FEATURE_PUBLICATION_FAMILY_CODES, `${label}.familyCode`,
    'MARKET_DATA_FEATURE_PUBLICATION_FAMILY_UNKNOWN');
  for (const field of [
    'sourceBundleId', 'computationPolicyId', 'rowsId', 'reportId', 'implementationManifestId',
    'instrumentIdentityId', 'datasetSnapshotBindingId', 'datasetSnapshotManifestId',
    'normalizedMarketDataObjectId', 'calendarRegistryManifestId',
  ]) assertCasId(family[field], `${label}.${field}`);
  const expectedSchemas = family.familyCode === MARKET_TECHNICAL_FEATURE_FAMILY_CODE
    ? [MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION, MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION]
    : family.familyCode === MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE
      ? [MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
        MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION]
      : [MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
        MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION];
  if (family.rowsSchemaVersion !== expectedSchemas[0] || family.reportSchemaVersion !== expectedSchemas[1]) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH',
      `${label} schema versions diverge from familyCode`);
  }
  assertUtcInstant(family.knowledgeCutoff, `${label}.knowledgeCutoff`);
  assertEnum(family.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, `${label}.temporalCapability`);
  assertEnum(family.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, `${label}.priceBasis`);
  assertEnum(family.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
    `${label}.corporateActionTreatment`);
  const coverage = normalizeMarketFeaturePublicationSessionCoverageV1({
    rowCount: family.rowCount, firstSessionDate: family.firstSessionDate,
    lastSessionDate: family.lastSessionDate, orderedRowIdentityDigest: family.orderedRowIdentityDigest,
  }, label);
  return { familyCode: family.familyCode,
    featureFamilyVersion: normalizeFamilyVersion(family.featureFamilyVersion, family.familyCode),
    rowsSchemaVersion: family.rowsSchemaVersion, reportSchemaVersion: family.reportSchemaVersion,
    sourceBundleId: family.sourceBundleId, computationPolicyId: family.computationPolicyId,
    rowsId: family.rowsId, reportId: family.reportId,
    implementationManifestId: family.implementationManifestId,
    instrumentIdentityId: family.instrumentIdentityId,
    datasetSnapshotBindingId: family.datasetSnapshotBindingId,
    datasetSnapshotManifestId: family.datasetSnapshotManifestId,
    normalizedMarketDataObjectId: family.normalizedMarketDataObjectId,
    calendarRegistryManifestId: family.calendarRegistryManifestId,
    knowledgeCutoff: family.knowledgeCutoff, temporalCapability: family.temporalCapability,
    priceBasis: family.priceBasis, corporateActionTreatment: family.corporateActionTreatment,
    ...coverage };
}

export function normalizeMarketFeaturePublicationManifestV1(value) {
  const code = 'MARKET_DATA_FEATURE_PUBLICATION_MANIFEST_MISMATCH';
  const manifest = closedRecord(value, MANIFEST_FIELDS,
    MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION, code);
  assertSchemaVersion(manifest, MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION);
  for (const field of ['publicationAuthorityPolicyId', 'instrumentIdentityId',
    'datasetSnapshotBindingId', 'datasetSnapshotManifestId', 'normalizedMarketDataObjectId',
    'calendarRegistryManifestId']) assertCasId(manifest[field], field);
  if (manifest.featureSetVersion !== MARKET_FEATURE_SET_VERSION) {
    throw new MarketDataL3Error(code, 'featureSetVersion is invalid');
  }
  assertUtcInstant(manifest.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(manifest.temporalCapability, MARKET_DATA_TEMPORAL_CAPABILITIES, 'temporalCapability');
  assertEnum(manifest.priceBasis, MARKET_DATA_INGESTION_PRICE_BASES, 'priceBasis');
  assertEnum(manifest.corporateActionTreatment, MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
    'corporateActionTreatment');
  if (!Array.isArray(manifest.families)) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_FAMILY_MISSING', 'families must be an array');
  }
  if (manifest.families.length !== MARKET_FEATURE_PUBLICATION_FAMILY_CODES.length) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_FAMILY_MISSING', 'exactly three families are required');
  }
  const families = manifest.families.map(normalizeFamily);
  const seen = new Set();
  for (let index = 0; index < families.length; index += 1) {
    if (seen.has(families[index].familyCode)) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_FAMILY_DUPLICATE', 'family is duplicated');
    }
    seen.add(families[index].familyCode);
    if (families[index].familyCode !== MARKET_FEATURE_PUBLICATION_FAMILY_CODES[index]) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_FAMILY_ORDER_MISMATCH',
        'families must use canonical A/B/C ordering');
    }
  }
  return { schemaVersion: MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: manifest.publicationAuthorityPolicyId,
    featureSetVersion: MARKET_FEATURE_SET_VERSION, instrumentIdentityId: manifest.instrumentIdentityId,
    datasetSnapshotBindingId: manifest.datasetSnapshotBindingId,
    datasetSnapshotManifestId: manifest.datasetSnapshotManifestId,
    normalizedMarketDataObjectId: manifest.normalizedMarketDataObjectId,
    calendarRegistryManifestId: manifest.calendarRegistryManifestId,
    knowledgeCutoff: manifest.knowledgeCutoff, temporalCapability: manifest.temporalCapability,
    priceBasis: manifest.priceBasis, corporateActionTreatment: manifest.corporateActionTreatment,
    sessionCoverage: normalizeMarketFeaturePublicationSessionCoverageV1(manifest.sessionCoverage),
    families };
}

export function normalizeMarketFeaturePublicationLogicalKeyV1(value, label = 'logicalKey') {
  const key = closedRecord(value, LOGICAL_KEY_FIELDS, label,
    'MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH');
  for (const field of ['instrumentIdentityId', 'datasetSnapshotBindingId', 'publicationAuthorityPolicyId']) {
    assertCasId(key[field], `${label}.${field}`);
  }
  if (key.featureSetVersion !== MARKET_FEATURE_SET_VERSION) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
      `${label}.featureSetVersion is invalid`);
  }
  return Object.fromEntries(LOGICAL_KEY_FIELDS.map((field) => [field, key[field]]));
}

export function marketFeaturePublicationLogicalKeysEqual(left, right) {
  return LOGICAL_KEY_FIELDS.every((field) => left[field] === right[field]);
}

export function compareMarketFeaturePublicationLogicalKeys(left, right) {
  for (const field of LOGICAL_KEY_FIELDS) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

function normalizeRegistryEntry(value, index) {
  const label = `entries[${index}]`;
  const entry = closedRecord(value, REGISTRY_ENTRY_FIELDS, label,
    'MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH');
  assertCasId(entry.publicationManifestId, `${label}.publicationManifestId`);
  assertCasId(entry.supersedesPublicationManifestId,
    `${label}.supersedesPublicationManifestId`, true);
  assertUtcInstant(entry.knowledgeCutoff, `${label}.knowledgeCutoff`);
  return { publicationManifestId: entry.publicationManifestId,
    logicalKey: normalizeMarketFeaturePublicationLogicalKeyV1(entry.logicalKey, `${label}.logicalKey`),
    knowledgeCutoff: entry.knowledgeCutoff,
    sessionCoverage: normalizeMarketFeaturePublicationSessionCoverageV1(
      entry.sessionCoverage, `${label}.sessionCoverage`),
    supersedesPublicationManifestId: entry.supersedesPublicationManifestId };
}

export function compareMarketFeaturePublicationRegistryEntries(left, right) {
  const key = compareMarketFeaturePublicationLogicalKeys(left.logicalKey, right.logicalKey);
  if (key !== 0) return key;
  if (left.knowledgeCutoff < right.knowledgeCutoff) return -1;
  if (left.knowledgeCutoff > right.knowledgeCutoff) return 1;
  return left.publicationManifestId < right.publicationManifestId ? -1
    : left.publicationManifestId > right.publicationManifestId ? 1 : 0;
}

export function normalizeMarketFeaturePublicationRegistryManifestV1(value) {
  const code = 'MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH';
  const registry = closedRecord(value, REGISTRY_FIELDS,
    MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION, code);
  assertSchemaVersion(registry, MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION);
  assertCasId(registry.publicationAuthorityPolicyId, 'publicationAuthorityPolicyId');
  assertCasId(registry.supersedesRegistryManifestId, 'supersedesRegistryManifestId', true);
  if (!Array.isArray(registry.entries)) throw new MarketDataL3Error(code, 'entries must be an array');
  const entries = registry.entries.map(normalizeRegistryEntry);
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && compareMarketFeaturePublicationRegistryEntries(entries[index - 1], entries[index]) >= 0) {
      throw new MarketDataL3Error(code, 'entries must be canonically sorted and unique');
    }
  }
  return { schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: registry.publicationAuthorityPolicyId,
    supersedesRegistryManifestId: registry.supersedesRegistryManifestId, entries };
}
