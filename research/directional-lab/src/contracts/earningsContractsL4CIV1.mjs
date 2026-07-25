/**
 * L4C-I1 closed SEC/XBRL earnings contracts.
 *
 * Every contract is a closed CanonicalJSON record.  The module is deliberately
 * pure: it performs no network access, directory scan, clock read or "latest"
 * resolution.
 */

import { createHash } from 'node:crypto';
import {
  CanonicalizationError,
  canonicalHash,
} from '../canonical/canonicalJsonV1.mjs';
import {
  MarketDataL3Error,
  assertCivilDate,
  assertUtcInstant,
} from './marketDataL3CommonV1.mjs';
import { deriveNewYorkUtcInstantV1 } from './macroIngestionContractsL4BV1.mjs';

export const EARNINGS_INGESTION_POLICY_SCHEMA_VERSION = 'EarningsIngestionPolicy/1';
export const EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION = 'EarningsMetricExtractionPolicy/1';
export const SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION = 'SecFilingSourceDocumentCore/1';
export const SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION = 'SecDocumentBytesCore/1';
export const EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION = 'EarningsTaxonomyBundleManifest/1';
export const XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION = 'XbrlCanonicalUnitCore/1';
export const FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION = 'FinancialPeriodIdentityCore/1';
export const EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION = 'EarningsEventIdentityCore/1';
export const EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION = 'EarningsRevisionIdentityCore/1';
export const EARNINGS_REVISION_CORE_SCHEMA_VERSION = 'EarningsRevisionCore/1';
export const EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION = 'EarningsMetricObservationCore/1';
export const EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION = 'EarningsMetricExtractionReport/1';
export const EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION = 'EarningsEventSetManifest/1';
export const EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION = 'EarningsRevisionSetManifest/1';
export const EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION = 'EarningsExtractionSetManifest/1';
export const EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION = 'EarningsDatasetSnapshotManifest/1';

export const EARNINGS_L4C_I1_SCHEMA_VERSIONS = Object.freeze([
  EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
  EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
  SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
  SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION,
  EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION,
  XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION,
  FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
  EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
  EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION,
  EARNINGS_REVISION_CORE_SCHEMA_VERSION,
  EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
  EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
  EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
  EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
  EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
  EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
]);

export const EARNINGS_DATASET_SERIES_IDENTITY = 'SEC_US_DOMESTIC_EARNINGS_RELEASE_ONLY_V1';
export const EARNINGS_ALLOWED_FORM_TYPES = Object.freeze([
  '10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A',
]);
export const EARNINGS_EPS_TAG_PRIORITY = Object.freeze([
  'us-gaap:EarningsPerShareDiluted',
  'us-gaap:EarningsPerShareBasicAndDiluted',
]);
export const EARNINGS_REVENUE_TAG_PRIORITY = Object.freeze([
  'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
  'us-gaap:Revenues',
  'us-gaap:SalesRevenueNet',
]);
export const EARNINGS_DOCUMENT_ROLES = Object.freeze([
  'PRIMARY_IXBRL', 'PRIMARY_XBRL_INSTANCE', 'EXHIBIT_XBRL', 'EXHIBIT_IXBRL',
  'EXHIBIT_OTHER', 'TAXONOMY_SCHEMA', 'TAXONOMY_LINKBASE',
]);
export const EARNINGS_STRUCTURED_DOCUMENT_ROLES = Object.freeze([
  'PRIMARY_IXBRL', 'PRIMARY_XBRL_INSTANCE', 'EXHIBIT_XBRL', 'EXHIBIT_IXBRL',
]);
export const EARNINGS_MEDIA_TYPES = Object.freeze([
  'application/xml', 'application/xhtml+xml', 'text/xml', 'application/zip',
]);
export const EARNINGS_DOCUMENT_FORMATS = Object.freeze(['IXBRL', 'XBRL_XML', 'XML', 'ZIP']);
export const EARNINGS_METRIC_CODES = Object.freeze(['EPS_DILUTED', 'REVENUE_CONSOLIDATED']);
export const EARNINGS_UNIT_CODES = Object.freeze(['USD', 'USD_PER_SHARE']);
export const EARNINGS_PERIOD_TYPES = Object.freeze(['INSTANT', 'DURATION']);
export const EARNINGS_TAXONOMY_AUTHORITY = 'US_GAAP_DEI_V1';
export const EARNINGS_ACCESSION_PATTERN = /^\d{10}-\d{2}-\d{6}$/;
export const EARNINGS_CIK_PATTERN = /^\d{1,10}$/;
export const EARNINGS_CAS_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const EARNINGS_INGESTION_POLICY_VALUES = Object.freeze({
  datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
  jurisdictionCode: 'US',
  currencyCode: 'USD',
  allowedSourceAuthority: 'SEC_EDGAR',
  latestReferencePolicy: 'FORBIDDEN',
  networkDuringComputationPolicy: 'FORBIDDEN',
  allowedFormTypes: EARNINGS_ALLOWED_FORM_TYPES,
  item202Rule: 'REQUIRED_FOR_8K_FAMILY',
  periodSelectionPolicy: 'CURRENT_REPORTED_PERIODS_ONLY',
});

export const EARNINGS_METRIC_EXTRACTION_POLICY_VALUES = Object.freeze({
  epsTagPriority: EARNINGS_EPS_TAG_PRIORITY,
  revenueTagPriority: EARNINGS_REVENUE_TAG_PRIORITY,
  extensionTagPolicy: 'REJECTED_V1',
  duplicateFactPolicy: 'DEDUP_IDENTICAL_REJECT_CONFLICTING',
  allowedStructuredDocumentRoles: EARNINGS_STRUCTURED_DOCUMENT_ROLES,
  nilFactPolicy: 'REJECT',
  dimensionPolicy: 'REJECT_SEGMENT_SCENARIO',
});

const CONTRACT_FIELDS = Object.freeze({
  [EARNINGS_INGESTION_POLICY_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'datasetSeriesIdentity', 'jurisdictionCode', 'currencyCode',
    'allowedSourceAuthority', 'latestReferencePolicy', 'networkDuringComputationPolicy',
    'allowedFormTypes', 'item202Rule', 'periodSelectionPolicy',
  ]),
  [EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'epsTagPriority', 'revenueTagPriority', 'extensionTagPolicy',
    'duplicateFactPolicy', 'allowedStructuredDocumentRoles', 'nilFactPolicy', 'dimensionPolicy',
  ]),
  [SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'filerCik', 'accessionNumber', 'formType', 'items',
    'acceptanceDatetimeRaw', 'publicAvailableAt', 'sourceAuthority', 'amendmentFlag',
    'amendsFilingAccessionNumber', 'orderedDocuments',
  ]),
  [SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'documentObjectId', 'sha256', 'byteLength', 'mediaType',
    'documentFormat', 'documentRole',
  ]),
  [EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'taxonomyAuthority', 'orderedComponentDocumentIds', 'orderedComponentDigest',
  ]),
  [XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION]: Object.freeze(['schemaVersion', 'unitCode']),
  [FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'periodType', 'periodStart', 'periodEnd',
  ]),
  [EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'filerCik', 'accessionNumber',
  ]),
  [EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'eventIdentityId', 'publicAvailableAt', 'sourceFilingDocumentId',
  ]),
  [EARNINGS_REVISION_CORE_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'earningsRevisionIdentityId', 'eventIdentityId', 'publicAvailableAt',
    'sourceFilingDocumentId', 'revisionKind', 'parentRevisionIdentityId',
  ]),
  [EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'earningsRevisionIdentityId', 'financialPeriodIdentityId',
    'xbrlCanonicalUnitId', 'metricCode', 'atoms', 'scale', 'shareBasis', 'accountingBasis',
  ]),
  [EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'earningsRevisionIdentityId', 'transformImplementationManifestId',
    'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
    'orderedObservationIds', 'diagnosticCount', 'orderedDiagnosticDigest',
  ]),
  [EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'orderedEventEntries', 'eventCount', 'orderedEventIdentityDigest',
  ]),
  [EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'orderedEventChains', 'revisionCount', 'orderedRevisionIdentityDigest',
  ]),
  [EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'earningsRevisionSetManifestId', 'transformImplementationManifestId',
    'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
    'orderedRevisionExtractionEntries', 'extractionReportCount', 'metricObservationCount',
    'orderedExtractionReportDigest', 'orderedMetricObservationDigest',
  ]),
  [EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION]: Object.freeze([
    'schemaVersion', 'datasetSeriesIdentity', 'earningsIngestionPolicyId',
    'earningsMetricExtractionPolicyId', 'earningsEventSetManifestId',
    'earningsRevisionSetManifestId', 'earningsExtractionSetManifestId',
    'transformImplementationManifestId', 'earningsTaxonomyBundleManifestId',
    'jurisdictionCode', 'currencyCode', 'eventCount', 'revisionCount',
    'extractionReportCount', 'metricObservationCount', 'firstPublicAvailableAt',
    'lastPublicAvailableAt', 'emptySnapshot', 'orderedEventIdentityDigest',
    'orderedRevisionIdentityDigest', 'orderedExtractionReportDigest',
    'orderedMetricObservationDigest', 'orderedMetricObservationIdentityDigest',
    'supersedesEarningsDatasetSnapshotManifestId',
  ]),
});

function keyLabel(key) {
  if (typeof key === 'string') return key;
  return `Symbol(${String(key.description ?? '')})`;
}

/** Unknown fields are canonicalization failures; domain failures remain coded L3 errors. */
export function closedEarningsRecordV1(value, fields, label, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MarketDataL3Error(code, `${label} must be a plain record`);
  }
  const allowed = new Set(fields);
  const extra = Reflect.ownKeys(value)
    .filter((key) => typeof key !== 'string' || !allowed.has(key))
    .sort((a, b) => keyLabel(a).localeCompare(keyLabel(b)))[0];
  if (extra !== undefined) {
    throw new CanonicalizationError('CANONICAL_UNKNOWN_FIELD',
      `${label} contains unknown field ${keyLabel(extra)}`);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
      throw new MarketDataL3Error(code, `${label}.${field} is required as an own enumerable data property`);
    }
  }
  return value;
}

function normalizedRecord(record, fields) {
  return Object.fromEntries(fields.map((field) => [field, cloneValue(record[field])]));
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, cloneValue(value[key])]));
  }
  return value;
}

function fail(code, message, details = {}) {
  throw new MarketDataL3Error(code, message, details);
}

function schema(record, expected, code) {
  if (record.schemaVersion !== expected) fail(code, `schemaVersion must be ${expected}`);
}

function exact(value, expected, code, label) {
  if (value !== expected) fail(code, `${label} must be ${expected}`);
}

function exactArray(value, expected, code, label) {
  if (!Array.isArray(value) || value.length !== expected.length
      || expected.some((item, index) => value[index] !== item)) {
    fail(code, `${label} diverges from the closed V1 order`);
  }
}

function casId(value, code, label, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !EARNINGS_CAS_ID_PATTERN.test(value)) {
    fail(code, `${label} must be a lowercase sha256 CAS id`);
  }
}

function nonNegativeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} must be a non-negative safe integer`);
}

function stringArray(value, code, label, options = {}) {
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)
      || value.some((item) => typeof item !== 'string' || item.length === 0 || item !== item.trim())) {
    fail(code, `${label} must be${options.nonEmpty ? ' a non-empty' : ' an'} string array`);
  }
  if (options.sortedUnique) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index - 1] >= value[index]) fail(code, `${label} must be bytewise sorted and unique`);
    }
  }
}

function idArray(value, code, label, options = {}) {
  stringArray(value, code, label, options);
  for (const [index, id] of value.entries()) casId(id, code, `${label}[${index}]`);
}

function civilDate(value, code, label) {
  try { assertCivilDate(value, label); } catch (cause) { fail(code, `${label} must be an exact civil date`, { cause }); }
}

function utc(value, code, label, nullable = false) {
  try { assertUtcInstant(value, label, nullable); } catch (cause) { fail(code, `${label} must be a UTC instant`, { cause }); }
}

export function secAcceptanceDatetimeToUtcV1(raw) {
  if (typeof raw !== 'string' || !/^\d{14}$/.test(raw)) {
    fail('EARNINGS_ACCEPTANCE_DATETIME_INVALID', 'acceptanceDatetimeRaw must be YYYYMMDDHHMMSS');
  }
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  civilDate(date, 'EARNINGS_ACCEPTANCE_DATETIME_INVALID', 'acceptance date');
  const base = deriveNewYorkUtcInstantV1(date, `${raw.slice(8, 10)}:${raw.slice(10, 12)}`);
  const seconds = Number(raw.slice(12, 14));
  if (seconds > 59) fail('EARNINGS_ACCEPTANCE_DATETIME_INVALID', 'acceptance seconds are invalid');
  return new Date(Date.parse(base) + seconds * 1000).toISOString();
}

function normalizeDocumentEntry(value, index) {
  const fields = ['secDocumentBytesId', 'documentRole'];
  const entry = closedEarningsRecordV1(value, fields, `orderedDocuments[${index}]`,
    'EARNINGS_SOURCE_DOCUMENT_INVALID');
  casId(entry.secDocumentBytesId, 'EARNINGS_SOURCE_BYTES_MISSING',
    `orderedDocuments[${index}].secDocumentBytesId`);
  if (!EARNINGS_DOCUMENT_ROLES.includes(entry.documentRole)) {
    fail('EARNINGS_DOCUMENT_ROLE_INVALID', `orderedDocuments[${index}].documentRole is invalid`);
  }
  return normalizedRecord(entry, fields);
}

export function normalizeEarningsIngestionPolicyV1(value) {
  const code = 'EARNINGS_POLICY_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_INGESTION_POLICY_SCHEMA_VERSION];
  const policy = closedEarningsRecordV1(value, fields, EARNINGS_INGESTION_POLICY_SCHEMA_VERSION, code);
  schema(policy, EARNINGS_INGESTION_POLICY_SCHEMA_VERSION, code);
  const checks = [
    ['datasetSeriesIdentity', EARNINGS_DATASET_SERIES_IDENTITY, 'EARNINGS_DATASET_SERIES_IDENTITY_INVALID'],
    ['jurisdictionCode', 'US', 'EARNINGS_JURISDICTION_REJECTED'],
    ['currencyCode', 'USD', 'EARNINGS_CURRENCY_REJECTED_V1'],
    ['allowedSourceAuthority', 'SEC_EDGAR', 'EARNINGS_SOURCE_AUTHORITY_REJECTED'],
    ['latestReferencePolicy', 'FORBIDDEN', 'EARNINGS_POLICY_LATEST_FORBIDDEN'],
    ['networkDuringComputationPolicy', 'FORBIDDEN', 'EARNINGS_POLICY_NETWORK_FORBIDDEN'],
    ['item202Rule', 'REQUIRED_FOR_8K_FAMILY', 'EARNINGS_ITEM_2_02_ABSENT'],
    ['periodSelectionPolicy', 'CURRENT_REPORTED_PERIODS_ONLY', code],
  ];
  for (const [field, expected, error] of checks) exact(policy[field], expected, error, field);
  exactArray(policy.allowedFormTypes, EARNINGS_ALLOWED_FORM_TYPES, 'EARNINGS_FORM_REJECTED_V1',
    'allowedFormTypes');
  return normalizedRecord(policy, fields);
}

export function normalizeEarningsMetricExtractionPolicyV1(value) {
  const code = 'EARNINGS_EXTRACTION_POLICY_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION];
  const policy = closedEarningsRecordV1(value, fields,
    EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION, code);
  schema(policy, EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION, code);
  exactArray(policy.epsTagPriority, EARNINGS_EPS_TAG_PRIORITY, 'EARNINGS_EPS_TAG_REJECTED',
    'epsTagPriority');
  exactArray(policy.revenueTagPriority, EARNINGS_REVENUE_TAG_PRIORITY,
    'EARNINGS_REVENUE_SEMANTIC_INVALID', 'revenueTagPriority');
  exact(policy.extensionTagPolicy, 'REJECTED_V1', 'EARNINGS_EXTENSION_TAG_REJECTED',
    'extensionTagPolicy');
  exact(policy.duplicateFactPolicy, 'DEDUP_IDENTICAL_REJECT_CONFLICTING',
    'EARNINGS_DUPLICATE_FACT_POLICY_VIOLATION', 'duplicateFactPolicy');
  exactArray(policy.allowedStructuredDocumentRoles, EARNINGS_STRUCTURED_DOCUMENT_ROLES,
    'EARNINGS_UNSTRUCTURED_SOURCE_REJECTED', 'allowedStructuredDocumentRoles');
  exact(policy.nilFactPolicy, 'REJECT', 'EARNINGS_FACT_NIL_REJECTED', 'nilFactPolicy');
  exact(policy.dimensionPolicy, 'REJECT_SEGMENT_SCENARIO',
    'EARNINGS_CONTEXT_DIMENSION_REJECTED', 'dimensionPolicy');
  return normalizedRecord(policy, fields);
}

export function normalizeSecFilingSourceDocumentCoreV1(value) {
  const code = 'EARNINGS_SOURCE_DOCUMENT_INVALID';
  const fields = CONTRACT_FIELDS[SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION];
  const filing = closedEarningsRecordV1(value, fields, SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION, code);
  schema(filing, SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION, code);
  if (typeof filing.filerCik !== 'string' || !EARNINGS_CIK_PATTERN.test(filing.filerCik)) {
    fail('EARNINGS_CIK_INVALID', 'filerCik must contain 1 through 10 digits');
  }
  if (typeof filing.accessionNumber !== 'string'
      || !EARNINGS_ACCESSION_PATTERN.test(filing.accessionNumber)) {
    fail('EARNINGS_ACCESSION_INVALID', 'accessionNumber is invalid');
  }
  if (filing.accessionNumber.slice(0, 10) !== filing.filerCik.padStart(10, '0')) {
    fail('EARNINGS_CIK_INVALID', 'filerCik must match the accession-number CIK');
  }
  if (!EARNINGS_ALLOWED_FORM_TYPES.includes(filing.formType)) {
    fail('EARNINGS_FORM_REJECTED_V1', 'formType is outside the closed domestic set');
  }
  stringArray(filing.items, code, 'items');
  const expectedPublic = secAcceptanceDatetimeToUtcV1(filing.acceptanceDatetimeRaw);
  utc(filing.publicAvailableAt, 'EARNINGS_ACCEPTANCE_DATETIME_INVALID', 'publicAvailableAt');
  if (filing.publicAvailableAt !== expectedPublic) {
    fail('EARNINGS_ACCEPTANCE_DATETIME_MISMATCH',
      'publicAvailableAt diverges from the SEC New-York acceptance time');
  }
  exact(filing.sourceAuthority, 'SEC_EDGAR', 'EARNINGS_SOURCE_AUTHORITY_REJECTED', 'sourceAuthority');
  const amended = filing.formType.endsWith('/A');
  if (typeof filing.amendmentFlag !== 'boolean' || filing.amendmentFlag !== amended) {
    fail('EARNINGS_AMENDMENT_FLAG_INVALID', 'amendmentFlag must match the /A form suffix');
  }
  if (amended) {
    if (filing.amendsFilingAccessionNumber !== null
        && (typeof filing.amendsFilingAccessionNumber !== 'string'
          || !EARNINGS_ACCESSION_PATTERN.test(filing.amendsFilingAccessionNumber))) {
      fail('EARNINGS_AMENDMENT_FLAG_INVALID', 'amendsFilingAccessionNumber is invalid');
    }
  } else if (filing.amendsFilingAccessionNumber !== null) {
    fail('EARNINGS_AMENDMENT_FLAG_INVALID', 'non-amendments must pin a null amended accession');
  }
  if (!Array.isArray(filing.orderedDocuments) || filing.orderedDocuments.length === 0) {
    fail(code, 'orderedDocuments must be non-empty');
  }
  return {
    ...normalizedRecord(filing, fields.slice(0, -1)),
    orderedDocuments: filing.orderedDocuments.map(normalizeDocumentEntry),
  };
}

export function normalizeSecDocumentBytesCoreV1(value) {
  const code = 'EARNINGS_DOCUMENT_BYTES_INVALID';
  const fields = CONTRACT_FIELDS[SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION];
  const document = closedEarningsRecordV1(value, fields, SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION, code);
  schema(document, SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION, code);
  casId(document.documentObjectId, 'EARNINGS_SOURCE_BYTES_MISSING', 'documentObjectId');
  casId(document.sha256, 'EARNINGS_SOURCE_BYTES_MISMATCH', 'sha256');
  if (!Number.isSafeInteger(document.byteLength) || document.byteLength < 1) {
    fail('EARNINGS_SOURCE_BYTES_INVALID', 'byteLength must be a positive safe integer');
  }
  if (!EARNINGS_MEDIA_TYPES.includes(document.mediaType)) {
    fail('EARNINGS_MEDIA_TYPE_INVALID', 'mediaType is invalid');
  }
  if (!EARNINGS_DOCUMENT_FORMATS.includes(document.documentFormat)) {
    fail('EARNINGS_DOCUMENT_FORMAT_INVALID', 'documentFormat is invalid');
  }
  if (!EARNINGS_DOCUMENT_ROLES.includes(document.documentRole)) {
    fail('EARNINGS_DOCUMENT_ROLE_INVALID', 'documentRole is invalid');
  }
  return normalizedRecord(document, fields);
}

export function normalizeEarningsTaxonomyBundleManifestV1(value) {
  const code = 'EARNINGS_TAXONOMY_BUNDLE_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION];
  const bundle = closedEarningsRecordV1(value, fields,
    EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION, code);
  schema(bundle, EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION, code);
  exact(bundle.taxonomyAuthority, EARNINGS_TAXONOMY_AUTHORITY,
    'EARNINGS_TAXONOMY_REJECTED_V1', 'taxonomyAuthority');
  idArray(bundle.orderedComponentDocumentIds, 'EARNINGS_TAXONOMY_BUNDLE_MISSING',
    'orderedComponentDocumentIds');
  casId(bundle.orderedComponentDigest, 'EARNINGS_TAXONOMY_DIGEST_MISMATCH',
    'orderedComponentDigest');
  return normalizedRecord(bundle, fields);
}

export function normalizeXbrlCanonicalUnitCoreV1(value) {
  const code = 'EARNINGS_UNIT_INVALID';
  const fields = CONTRACT_FIELDS[XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION];
  const unit = closedEarningsRecordV1(value, fields, XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, code);
  schema(unit, XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, code);
  if (!EARNINGS_UNIT_CODES.includes(unit.unitCode)) fail('EARNINGS_UNIT_REJECTED', 'unitCode is invalid');
  return normalizedRecord(unit, fields);
}

export function normalizeFinancialPeriodIdentityCoreV1(value) {
  const code = 'EARNINGS_PERIOD_INVALID';
  const fields = CONTRACT_FIELDS[FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION];
  const period = closedEarningsRecordV1(value, fields,
    FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION, code);
  schema(period, FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION, code);
  if (!EARNINGS_PERIOD_TYPES.includes(period.periodType)) {
    fail('EARNINGS_PERIOD_TYPE_INVALID', 'periodType must be INSTANT or DURATION');
  }
  civilDate(period.periodEnd, code, 'periodEnd');
  if (period.periodType === 'INSTANT') {
    if (period.periodStart !== null) fail(code, 'INSTANT requires periodStart=null');
  } else {
    civilDate(period.periodStart, code, 'periodStart');
    if (period.periodStart >= period.periodEnd) fail(code, 'DURATION requires periodStart < periodEnd');
  }
  return normalizedRecord(period, fields);
}

function validateCikAccession(record) {
  if (typeof record.filerCik !== 'string' || !EARNINGS_CIK_PATTERN.test(record.filerCik)) {
    fail('EARNINGS_CIK_INVALID', 'filerCik must contain 1 through 10 digits');
  }
  if (typeof record.accessionNumber !== 'string'
      || !EARNINGS_ACCESSION_PATTERN.test(record.accessionNumber)) {
    fail('EARNINGS_ACCESSION_INVALID', 'accessionNumber is invalid');
  }
  if (record.accessionNumber.slice(0, 10) !== record.filerCik.padStart(10, '0')) {
    fail('EARNINGS_CIK_INVALID', 'filerCik must match the accession-number CIK');
  }
}

export function normalizeEarningsEventIdentityCoreV1(value) {
  const code = 'EARNINGS_EVENT_IDENTITY_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION];
  const identity = closedEarningsRecordV1(value, fields,
    EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION, code);
  schema(identity, EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION, code);
  validateCikAccession(identity);
  return normalizedRecord(identity, fields);
}

export function normalizeEarningsRevisionIdentityCoreV1(value) {
  const code = 'EARNINGS_REVISION_IDENTITY_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION];
  const identity = closedEarningsRecordV1(value, fields,
    EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION, code);
  schema(identity, EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION, code);
  casId(identity.eventIdentityId, 'EARNINGS_EVENT_IDENTITY_MISSING', 'eventIdentityId');
  utc(identity.publicAvailableAt, 'EARNINGS_ACCEPTANCE_DATETIME_INVALID', 'publicAvailableAt');
  casId(identity.sourceFilingDocumentId, 'EARNINGS_SOURCE_DOCUMENT_MISSING',
    'sourceFilingDocumentId');
  return normalizedRecord(identity, fields);
}

export function normalizeEarningsRevisionCoreV1(value) {
  const code = 'EARNINGS_REVISION_CORE_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_REVISION_CORE_SCHEMA_VERSION];
  const revision = closedEarningsRecordV1(value, fields, EARNINGS_REVISION_CORE_SCHEMA_VERSION, code);
  schema(revision, EARNINGS_REVISION_CORE_SCHEMA_VERSION, code);
  casId(revision.earningsRevisionIdentityId, 'EARNINGS_REVISION_IDENTITY_MISSING',
    'earningsRevisionIdentityId');
  casId(revision.eventIdentityId, 'EARNINGS_EVENT_IDENTITY_MISSING', 'eventIdentityId');
  utc(revision.publicAvailableAt, 'EARNINGS_ACCEPTANCE_DATETIME_INVALID', 'publicAvailableAt');
  casId(revision.sourceFilingDocumentId, 'EARNINGS_SOURCE_DOCUMENT_MISSING',
    'sourceFilingDocumentId');
  exact(revision.revisionKind, 'INITIAL', 'EARNINGS_REVISION_KIND_FORBIDDEN_V1', 'revisionKind');
  if (revision.parentRevisionIdentityId !== null) {
    fail('EARNINGS_REVISION_PARENT_FORBIDDEN_V1', 'parentRevisionIdentityId must be null');
  }
  return normalizedRecord(revision, fields);
}

export function normalizeEarningsMetricObservationCoreV1(value) {
  const code = 'EARNINGS_OBSERVATION_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION];
  const observation = closedEarningsRecordV1(value, fields,
    EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION, code);
  schema(observation, EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION, code);
  casId(observation.earningsRevisionIdentityId, 'EARNINGS_REVISION_IDENTITY_MISSING',
    'earningsRevisionIdentityId');
  casId(observation.financialPeriodIdentityId, 'EARNINGS_PERIOD_MISSING',
    'financialPeriodIdentityId');
  casId(observation.xbrlCanonicalUnitId, 'EARNINGS_UNIT_MISSING', 'xbrlCanonicalUnitId');
  if (!EARNINGS_METRIC_CODES.includes(observation.metricCode)) {
    fail('EARNINGS_METRIC_CODE_INVALID', 'metricCode is invalid');
  }
  if (typeof observation.atoms !== 'string'
      || !/^-?(?:0|[1-9]\d*)$/.test(observation.atoms) || observation.atoms === '-0') {
    fail('EARNINGS_FIXED_POINT_INVALID', 'atoms must be a canonical integer string');
  }
  const maxScale = observation.metricCode === 'EPS_DILUTED' ? 6 : 2;
  if (!Number.isSafeInteger(observation.scale) || observation.scale < 0
      || observation.scale > maxScale || (observation.scale > 0 && observation.atoms.endsWith('0'))) {
    fail('EARNINGS_FIXED_POINT_SCALE_INVALID', 'scale is out of range or not minimal');
  }
  if (observation.metricCode === 'EPS_DILUTED') {
    if (observation.shareBasis !== 'DILUTED' || observation.accountingBasis !== 'GAAP') {
      fail('EARNINGS_EPS_SEMANTIC_INVALID', 'EPS requires DILUTED and GAAP semantics');
    }
  } else if (observation.shareBasis !== null || observation.accountingBasis !== null) {
    fail('EARNINGS_EPS_SEMANTIC_INVALID', 'revenue requires null EPS semantic fields');
  }
  return normalizedRecord(observation, fields);
}

export function normalizeEarningsMetricExtractionReportV1(value) {
  const code = 'EARNINGS_REPORT_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION];
  const report = closedEarningsRecordV1(value, fields,
    EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION, code);
  schema(report, EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION, code);
  casId(report.earningsRevisionIdentityId, 'EARNINGS_REPORT_REVISION_MISSING',
    'earningsRevisionIdentityId');
  casId(report.transformImplementationManifestId,
    'EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH', 'transformImplementationManifestId');
  casId(report.earningsMetricExtractionPolicyId,
    'EARNINGS_EXTRACTION_POLICY_ID_MISMATCH', 'earningsMetricExtractionPolicyId');
  casId(report.earningsTaxonomyBundleManifestId,
    'EARNINGS_TAXONOMY_BUNDLE_ID_MISMATCH', 'earningsTaxonomyBundleManifestId');
  idArray(report.orderedObservationIds, 'EARNINGS_EXTRACTION_REPORT_OBS_MISMATCH',
    'orderedObservationIds', { sortedUnique: true });
  nonNegativeInteger(report.diagnosticCount, 'EARNINGS_REPORT_COUNT_MISMATCH', 'diagnosticCount');
  casId(report.orderedDiagnosticDigest, 'EARNINGS_REPORT_DIGEST_MISMATCH',
    'orderedDiagnosticDigest');
  return normalizedRecord(report, fields);
}

function eventEntry(value, index) {
  const fields = ['eventIdentityId'];
  const entry = closedEarningsRecordV1(value, fields, `orderedEventEntries[${index}]`,
    'EARNINGS_EVENT_SET_INVALID');
  casId(entry.eventIdentityId, 'EARNINGS_EVENT_IDENTITY_MISSING',
    `orderedEventEntries[${index}].eventIdentityId`);
  return normalizedRecord(entry, fields);
}

export function normalizeEarningsEventSetManifestV1(value) {
  const code = 'EARNINGS_EVENT_SET_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION];
  const manifest = closedEarningsRecordV1(value, fields, EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION, code);
  schema(manifest, EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION, code);
  if (!Array.isArray(manifest.orderedEventEntries)) fail(code, 'orderedEventEntries must be an array');
  const entries = manifest.orderedEventEntries.map(eventEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].eventIdentityId >= entries[index].eventIdentityId) {
      fail('EARNINGS_EVENT_SET_ORDER_INVALID', 'orderedEventEntries must be bytewise sorted and unique');
    }
  }
  if (manifest.eventCount !== entries.length) {
    fail('EARNINGS_EVENT_SET_COUNT_MISMATCH', 'eventCount diverges from entries');
  }
  if (manifest.orderedEventIdentityDigest
      !== earningsOrderedEventIdentityDigestV1(entries.map((entry) => entry.eventIdentityId))) {
    fail('EARNINGS_EVENT_SET_DIGEST_MISMATCH', 'orderedEventIdentityDigest diverges');
  }
  return { schemaVersion: EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
    orderedEventEntries: entries, eventCount: entries.length,
    orderedEventIdentityDigest: manifest.orderedEventIdentityDigest };
}

function revisionEntry(value, label) {
  const fields = ['earningsRevisionIdentityId', 'earningsRevisionId', 'parentRevisionIdentityId'];
  const entry = closedEarningsRecordV1(value, fields, label, 'EARNINGS_REVISION_SET_INVALID');
  casId(entry.earningsRevisionIdentityId, 'EARNINGS_REVISION_IDENTITY_MISSING',
    `${label}.earningsRevisionIdentityId`);
  casId(entry.earningsRevisionId, 'EARNINGS_REVISION_CORE_MISSING', `${label}.earningsRevisionId`);
  if (entry.parentRevisionIdentityId !== null) {
    fail('EARNINGS_REVISION_PARENT_FORBIDDEN_V1', `${label}.parentRevisionIdentityId must be null`);
  }
  return normalizedRecord(entry, fields);
}

function eventChain(value, index) {
  const label = `orderedEventChains[${index}]`;
  const fields = ['eventIdentityId', 'orderedRevisions'];
  const chain = closedEarningsRecordV1(value, fields, label, 'EARNINGS_REVISION_SET_INVALID');
  casId(chain.eventIdentityId, 'EARNINGS_EVENT_IDENTITY_MISSING', `${label}.eventIdentityId`);
  if (!Array.isArray(chain.orderedRevisions) || chain.orderedRevisions.length !== 1) {
    fail('EARNINGS_REVISION_COUNT_PER_EVENT_INVALID',
      `${label}.orderedRevisions must contain exactly one INITIAL`);
  }
  return {
    eventIdentityId: chain.eventIdentityId,
    orderedRevisions: [revisionEntry(chain.orderedRevisions[0], `${label}.orderedRevisions[0]`)],
  };
}

export function normalizeEarningsRevisionSetManifestV1(value) {
  const code = 'EARNINGS_REVISION_SET_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION];
  const manifest = closedEarningsRecordV1(value, fields,
    EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION, code);
  schema(manifest, EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION, code);
  if (!Array.isArray(manifest.orderedEventChains)) fail(code, 'orderedEventChains must be an array');
  const chains = manifest.orderedEventChains.map(eventChain);
  const revisionIds = chains.map(
    (chain) => chain.orderedRevisions[0].earningsRevisionIdentityId);
  if (new Set(revisionIds).size !== revisionIds.length) {
    fail(code, 'a revision identity cannot appear under two events');
  }
  for (let index = 1; index < chains.length; index += 1) {
    if (chains[index - 1].eventIdentityId >= chains[index].eventIdentityId) {
      fail('EARNINGS_REVISION_SET_ORDER_INVALID',
        'orderedEventChains must be bytewise sorted and unique');
    }
  }
  if (manifest.revisionCount !== chains.length) {
    fail('EARNINGS_REVISION_SET_COUNT_MISMATCH', 'revisionCount must equal eventCount');
  }
  if (manifest.orderedRevisionIdentityDigest
      !== earningsOrderedRevisionIdentityDigestV1(revisionIds)) {
    fail('EARNINGS_REVISION_SET_DIGEST_MISMATCH', 'orderedRevisionIdentityDigest diverges');
  }
  return { schemaVersion: EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
    orderedEventChains: chains, revisionCount: chains.length,
    orderedRevisionIdentityDigest: manifest.orderedRevisionIdentityDigest };
}

function extractionEntry(value, index) {
  const label = `orderedRevisionExtractionEntries[${index}]`;
  const fields = ['earningsRevisionIdentityId', 'earningsMetricExtractionReportId',
    'orderedMetricObservationIds'];
  const entry = closedEarningsRecordV1(value, fields, label, 'EARNINGS_EXTRACTION_SET_INVALID');
  casId(entry.earningsRevisionIdentityId, 'EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION',
    `${label}.earningsRevisionIdentityId`);
  casId(entry.earningsMetricExtractionReportId, 'EARNINGS_EXTRACTION_REPORT_MISSING',
    `${label}.earningsMetricExtractionReportId`);
  if (!Array.isArray(entry.orderedMetricObservationIds)) {
    fail('EARNINGS_EXTRACTION_SET_INVALID',
      `${label}.orderedMetricObservationIds must be an array`);
  }
  const seen = new Set();
  for (const [observationIndex, id] of entry.orderedMetricObservationIds.entries()) {
    casId(id, 'EARNINGS_METRIC_ORPHAN',
      `${label}.orderedMetricObservationIds[${observationIndex}]`);
    if (seen.has(id)) {
      fail('EARNINGS_EXTRACTION_OBSERVATION_DUPLICATE',
        `${label}.orderedMetricObservationIds contains a duplicate`);
    }
    seen.add(id);
    if (observationIndex > 0
        && entry.orderedMetricObservationIds[observationIndex - 1] > id) {
      fail('EARNINGS_EXTRACTION_OBSERVATION_ORDER_INVALID',
        `${label}.orderedMetricObservationIds must be bytewise sorted`);
    }
  }
  return normalizedRecord(entry, fields);
}

export function normalizeEarningsExtractionSetManifestV1(value) {
  const code = 'EARNINGS_EXTRACTION_SET_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION];
  const manifest = closedEarningsRecordV1(value, fields,
    EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION, code);
  schema(manifest, EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION, code);
  for (const [field, error] of [
    ['earningsRevisionSetManifestId', 'EARNINGS_REVISION_SET_ID_MISMATCH'],
    ['transformImplementationManifestId', 'EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH'],
    ['earningsMetricExtractionPolicyId', 'EARNINGS_EXTRACTION_POLICY_ID_MISMATCH'],
    ['earningsTaxonomyBundleManifestId', 'EARNINGS_TAXONOMY_BUNDLE_ID_MISMATCH'],
  ]) casId(manifest[field], error, field);
  if (!Array.isArray(manifest.orderedRevisionExtractionEntries)) {
    fail(code, 'orderedRevisionExtractionEntries must be an array');
  }
  const entries = manifest.orderedRevisionExtractionEntries.map(extractionEntry);
  const revisionIds = entries.map((entry) => entry.earningsRevisionIdentityId);
  if (new Set(revisionIds).size !== revisionIds.length) {
    fail('EARNINGS_EXTRACTION_ENTRY_DUPLICATE', 'duplicate revision extraction entry');
  }
  const observationCount = entries.reduce(
    (count, entry) => count + entry.orderedMetricObservationIds.length, 0);
  if (manifest.extractionReportCount !== entries.length
      || manifest.metricObservationCount !== observationCount) {
    fail('EARNINGS_EXTRACTION_SET_COUNT_MISMATCH', 'extraction set counters diverge');
  }
  const reportDigest = earningsOrderedExtractionReportDigestV1(
    entries.map((entry) => entry.earningsMetricExtractionReportId));
  const observationDigest = earningsGroupedMetricObservationDigestV1(entries);
  if (manifest.orderedExtractionReportDigest !== reportDigest
      || manifest.orderedMetricObservationDigest !== observationDigest) {
    fail('EARNINGS_EXTRACTION_SET_DIGEST_MISMATCH', 'extraction set digest diverges');
  }
  return {
    schemaVersion: EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
    earningsRevisionSetManifestId: manifest.earningsRevisionSetManifestId,
    transformImplementationManifestId: manifest.transformImplementationManifestId,
    earningsMetricExtractionPolicyId: manifest.earningsMetricExtractionPolicyId,
    earningsTaxonomyBundleManifestId: manifest.earningsTaxonomyBundleManifestId,
    orderedRevisionExtractionEntries: entries,
    extractionReportCount: entries.length,
    metricObservationCount: observationCount,
    orderedExtractionReportDigest: reportDigest,
    orderedMetricObservationDigest: observationDigest,
  };
}

export function normalizeEarningsDatasetSnapshotManifestV1(value) {
  const code = 'EARNINGS_SNAPSHOT_INVALID';
  const fields = CONTRACT_FIELDS[EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION];
  if (value !== null && typeof value === 'object'
      && !Object.hasOwn(value, 'datasetSeriesIdentity')) {
    fail('EARNINGS_DATASET_SERIES_IDENTITY_INVALID',
      'datasetSeriesIdentity is required');
  }
  const snapshot = closedEarningsRecordV1(value, fields,
    EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION, code);
  schema(snapshot, EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION, code);
  exact(snapshot.datasetSeriesIdentity, EARNINGS_DATASET_SERIES_IDENTITY,
    'EARNINGS_DATASET_SERIES_IDENTITY_INVALID', 'datasetSeriesIdentity');
  for (const field of ['earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
    'earningsEventSetManifestId', 'earningsRevisionSetManifestId',
    'earningsExtractionSetManifestId', 'transformImplementationManifestId',
    'earningsTaxonomyBundleManifestId']) casId(snapshot[field], code, field);
  exact(snapshot.jurisdictionCode, 'US', 'EARNINGS_JURISDICTION_REJECTED', 'jurisdictionCode');
  exact(snapshot.currencyCode, 'USD', 'EARNINGS_CURRENCY_REJECTED_V1', 'currencyCode');
  for (const field of ['eventCount', 'revisionCount', 'extractionReportCount',
    'metricObservationCount']) nonNegativeInteger(snapshot[field], code, field);
  utc(snapshot.firstPublicAvailableAt, code, 'firstPublicAvailableAt', true);
  utc(snapshot.lastPublicAvailableAt, code, 'lastPublicAvailableAt', true);
  if ((snapshot.firstPublicAvailableAt === null) !== (snapshot.lastPublicAvailableAt === null)
      || (snapshot.eventCount === 0) !== (snapshot.firstPublicAvailableAt === null)
      || (snapshot.firstPublicAvailableAt !== null
        && snapshot.firstPublicAvailableAt > snapshot.lastPublicAvailableAt)) {
    fail(code, 'publicAvailableAt bounds diverge from eventCount');
  }
  if (snapshot.revisionCount !== snapshot.eventCount) {
    fail('EARNINGS_SNAPSHOT_COUNT_MISMATCH', 'revisionCount must equal eventCount');
  }
  if (typeof snapshot.emptySnapshot !== 'boolean'
      || snapshot.emptySnapshot !== (snapshot.eventCount === 0)) {
    fail(code, 'emptySnapshot diverges from eventCount');
  }
  for (const field of ['orderedEventIdentityDigest', 'orderedRevisionIdentityDigest',
    'orderedExtractionReportDigest', 'orderedMetricObservationDigest',
    'orderedMetricObservationIdentityDigest']) casId(snapshot[field], code, field);
  casId(snapshot.supersedesEarningsDatasetSnapshotManifestId,
    'EARNINGS_SNAPSHOT_SUPERSESSION_CYCLE',
    'supersedesEarningsDatasetSnapshotManifestId', true);
  return normalizedRecord(snapshot, fields);
}

function idFor(schemaVersion, normalize, value) {
  return canonicalHash(schemaVersion, normalize(value));
}

export const earningsIngestionPolicyIdFor = (value) =>
  idFor(EARNINGS_INGESTION_POLICY_SCHEMA_VERSION, normalizeEarningsIngestionPolicyV1, value);
export const earningsMetricExtractionPolicyIdFor = (value) =>
  idFor(EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
    normalizeEarningsMetricExtractionPolicyV1, value);
export const secFilingSourceDocumentIdFor = (value) =>
  idFor(SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
    normalizeSecFilingSourceDocumentCoreV1, value);
export const secDocumentBytesIdFor = (value) =>
  idFor(SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION, normalizeSecDocumentBytesCoreV1, value);
export const earningsTaxonomyBundleManifestIdFor = (value) =>
  idFor(EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION,
    normalizeEarningsTaxonomyBundleManifestV1, value);
export const xbrlCanonicalUnitIdFor = (value) =>
  idFor(XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, normalizeXbrlCanonicalUnitCoreV1, value);
export const financialPeriodIdentityIdFor = (value) =>
  idFor(FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
    normalizeFinancialPeriodIdentityCoreV1, value);
export const earningsEventIdentityIdFor = (value) =>
  idFor(EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
    normalizeEarningsEventIdentityCoreV1, value);
export const earningsRevisionIdentityIdFor = (value) =>
  idFor(EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION,
    normalizeEarningsRevisionIdentityCoreV1, value);
export const earningsRevisionIdFor = (value) =>
  idFor(EARNINGS_REVISION_CORE_SCHEMA_VERSION, normalizeEarningsRevisionCoreV1, value);
export const earningsMetricObservationIdFor = (value) =>
  idFor(EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
    normalizeEarningsMetricObservationCoreV1, value);
export const earningsMetricExtractionReportIdFor = (value) =>
  idFor(EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
    normalizeEarningsMetricExtractionReportV1, value);
export const earningsEventSetManifestIdFor = (value) =>
  idFor(EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
    normalizeEarningsEventSetManifestV1, value);
export const earningsRevisionSetManifestIdFor = (value) =>
  idFor(EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
    normalizeEarningsRevisionSetManifestV1, value);
export const earningsExtractionSetManifestIdFor = (value) =>
  idFor(EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
    normalizeEarningsExtractionSetManifestV1, value);
export const earningsDatasetSnapshotManifestIdFor = (value) =>
  idFor(EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    normalizeEarningsDatasetSnapshotManifestV1, value);

function binaryDigest(parts) {
  return `sha256:${createHash('sha256').update(Buffer.concat(parts.map((part) =>
    Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8')))).digest('hex')}`;
}

function domainListDigest(domain, ids) {
  return binaryDigest([`${domain}\n`, ...ids.map((id) => `${id}\n`)]);
}

export function earningsDatasetIdentityKeyV1(value) {
  return binaryDigest([
    'EarningsDatasetIdentityKey/1\n',
    `${value.datasetSeriesIdentity}\n`,
    `${value.jurisdictionCode}\n`,
    `${value.currencyCode}\n`,
    `${value.allowedSourceAuthority}\n`,
  ]);
}

export const EARNINGS_FUNCTIONAL_SNAPSHOT_FIELDS = Object.freeze([
  'datasetSeriesIdentity', 'earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
  'earningsEventSetManifestId', 'earningsRevisionSetManifestId',
  'earningsExtractionSetManifestId', 'transformImplementationManifestId',
  'earningsTaxonomyBundleManifestId', 'jurisdictionCode', 'currencyCode', 'eventCount',
  'revisionCount', 'extractionReportCount', 'metricObservationCount',
  'firstPublicAvailableAt', 'lastPublicAvailableAt', 'emptySnapshot',
  'orderedEventIdentityDigest', 'orderedRevisionIdentityDigest',
  'orderedExtractionReportDigest', 'orderedMetricObservationDigest',
  'orderedMetricObservationIdentityDigest',
]);

function scalarEncoding(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string') return value;
  fail('EARNINGS_SNAPSHOT_INVALID', 'functional fingerprint only accepts closed scalar values');
}

export function earningsFunctionalSnapshotFingerprintV1(value) {
  const parts = ['EarningsDatasetFunctionalFingerprint/1\n'];
  for (const field of EARNINGS_FUNCTIONAL_SNAPSHOT_FIELDS) {
    if (!Object.hasOwn(value, field)) fail('EARNINGS_SNAPSHOT_INVALID', `${field} is required`);
    parts.push(field, Buffer.from([0]), `${scalarEncoding(value[field])}\n`);
  }
  return binaryDigest(parts);
}

export function earningsGroupedMetricObservationDigestV1(entries) {
  const parts = ['EarningsMetricObservationGroups/1\n'];
  for (const entry of entries) {
    const ids = entry.orderedMetricObservationIds;
    parts.push(entry.earningsRevisionIdentityId, Buffer.from([0]), `${ids.length}\n`);
    for (const id of ids) parts.push(`${id}\n`);
  }
  return binaryDigest(parts);
}

export function earningsOrderedMetricObservationIdentityDigestV1(ids) {
  return domainListDigest('EarningsMetricObservationIdentityDigest/1', [...ids].sort());
}

export function earningsOrderedEventIdentityDigestV1(ids) {
  return domainListDigest(EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION, ids);
}

export function earningsOrderedRevisionIdentityDigestV1(ids) {
  return domainListDigest(EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION, ids);
}

export function earningsOrderedExtractionReportDigestV1(ids) {
  return domainListDigest(EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION, ids);
}

export function earningsOrderedDiagnosticDigestV1(diagnostics) {
  return domainListDigest(EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION, diagnostics);
}

export function earningsOrderedTaxonomyComponentDigestV1(ids) {
  return domainListDigest(EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION, ids);
}
