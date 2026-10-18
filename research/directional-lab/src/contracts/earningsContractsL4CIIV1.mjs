/**
 * L4C-I2 closed earnings as-of materialization and fiscal classification
 * contracts.
 *
 * Like its L4C-I1 sibling this module is a declaration module: it owns the six
 * schema versions, their closed field orders, their closed enums and their
 * normalizers, and it holds no build or verify function. No network access, no
 * directory scan, no wall-clock read and no "latest" resolution ever happens
 * here.
 */

import { createHash } from 'node:crypto';
import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import {
  MarketDataL3Error,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertNonEmptyString,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  assertUtcInstant,
} from './marketDataL3CommonV1.mjs';
import {
  EARNINGS_ALLOWED_FORM_TYPES,
  EARNINGS_DATASET_SERIES_IDENTITY,
} from './earningsContractsL4CIV1.mjs';
import { SHA256_OBJECT_ID_PATTERN } from './datasetSnapshotV1.mjs';

export const EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION = 'EarningsAsOfResolutionPolicy/1';
export const EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION =
  'EarningsFiscalClassificationPolicy/1';
export const EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION =
  'EarningsFiscalPeriodClassificationCore/1';
export const EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION =
  'EarningsFiscalClassificationReport/1';
export const EARNINGS_DATASET_BINDING_SCHEMA_VERSION = 'EarningsDatasetBinding/1';
export const EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION =
  'EarningsAsOfMaterializationReport/1';

/** Registry order 129..134 of SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS. */
export const EARNINGS_L4C_I2_SCHEMA_VERSIONS = Object.freeze([
  EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
  EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
  EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION,
  EARNINGS_DATASET_BINDING_SCHEMA_VERSION,
  EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION,
]);

/* ------------------------------------------------------------------------- *
 * Closed enums.
 * ------------------------------------------------------------------------- */

export const EARNINGS_FISCAL_PERIOD_CLASSES = Object.freeze([
  'INSTANT', 'QUARTER', 'YEAR_TO_DATE', 'FISCAL_YEAR',
]);
export const EARNINGS_FISCAL_PERIOD_FOCUS_VALUES = Object.freeze([
  'Q1', 'Q2', 'Q3', 'Q4', 'FY',
]);
/** Focus buckets of K6.countsByFiscalPeriodFocus: the five focus values + UNDECLARED. */
export const EARNINGS_FISCAL_PERIOD_FOCUS_BUCKETS = Object.freeze([
  ...EARNINGS_FISCAL_PERIOD_FOCUS_VALUES, 'UNDECLARED',
]);
export const EARNINGS_FISCAL_CLASSIFICATION_BASIS_VALUES = Object.freeze([
  'SOURCE_ATTESTED', 'POLICY_INFERRED',
]);
export const EARNINGS_FISCAL_CLASSIFICATION_METHOD_VALUES = Object.freeze([
  'DECLARED_FOCUS', 'RELATIONAL_SPAN_ORDER', 'Q1_DUAL_ROLE',
]);
/**
 * Canonical order of K3.orderedSourceFactTags. A classification may carry an
 * ordered subset of these three tokens in exactly this order; the DEI prefix is
 * intentionally absent because the token names the attested fact, not the tag.
 */
export const EARNINGS_FISCAL_SOURCE_FACT_TAGS = Object.freeze([
  'DocumentPeriodEndDate', 'DocumentFiscalPeriodFocus', 'DocumentFiscalYearFocus',
]);
export const EARNINGS_FISCAL_METADATA_TAGS = Object.freeze([
  'dei:DocumentPeriodEndDate', 'dei:DocumentFiscalPeriodFocus',
  'dei:DocumentFiscalYearFocus', 'dei:DocumentType',
]);
export const EARNINGS_BINDING_TEMPORAL_CAPABILITIES = Object.freeze([
  'POINT_IN_TIME_PUBLIC_AVAILABLE_AT',
]);
/** The ten diagnostic codes the fiscal classifier may emit, bytewise ascending. */
export const EARNINGS_FISCAL_DIAGNOSTIC_CODES = Object.freeze([
  'EARNINGS_FISCAL_CLASSIFICATION_AMBIGUOUS',
  'EARNINGS_FISCAL_FOCUS_FORM_INCOMPATIBLE',
  'EARNINGS_FISCAL_FOCUS_INVALID',
  'EARNINGS_FISCAL_METADATA_ABSENT',
  'EARNINGS_FISCAL_METADATA_AMBIGUOUS',
  'EARNINGS_FISCAL_METADATA_DIVERGENT',
  'EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS',
  'EARNINGS_FISCAL_ROLE_UNDETERMINED',
  'EARNINGS_FISCAL_TERMINAL_QUARTER_UNPROVABLE',
  'EARNINGS_FISCAL_YEAR_FOCUS_INVALID',
]);

export const EARNINGS_FISCAL_YEAR_FOCUS_PATTERN = /^[0-9]{4}$/;
export const EARNINGS_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Closed form/focus compatibility table — six entries, order is contractual. */
export const EARNINGS_FORM_FOCUS_COMPATIBILITY = Object.freeze([
  Object.freeze({ formType: '10-K', orderedAllowedFocusValues: Object.freeze(['FY']) }),
  Object.freeze({ formType: '10-K/A', orderedAllowedFocusValues: Object.freeze(['FY']) }),
  Object.freeze({ formType: '10-Q', orderedAllowedFocusValues: Object.freeze(['Q1', 'Q2', 'Q3']) }),
  Object.freeze({ formType: '10-Q/A', orderedAllowedFocusValues: Object.freeze(['Q1', 'Q2', 'Q3']) }),
  Object.freeze({ formType: '8-K', orderedAllowedFocusValues: Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'FY']) }),
  Object.freeze({ formType: '8-K/A', orderedAllowedFocusValues: Object.freeze(['Q1', 'Q2', 'Q3', 'Q4', 'FY']) }),
]);

/* ------------------------------------------------------------------------- *
 * Shared closed-record helpers.
 * ------------------------------------------------------------------------- */

function keyLabel(key) {
  if (typeof key === 'string') return key;
  const global = Symbol.keyFor(key);
  return global === undefined ? `Symbol(${key.description ?? ''})` : `Symbol.for(${JSON.stringify(global)})`;
}

/** Reject inherited records, Symbols, non-enumerable properties and accessors. */
export function closedEarningsI2Record(value, fields, label, code) {
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
  if (extra !== undefined) {
    throw new MarketDataL3Error(code, `${label} contains unknown field ${keyLabel(extra)}`);
  }
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
  if (Array.isArray(right)) {
    return Array.isArray(left) && left.length === right.length
      && right.every((value, index) => sameClosedValue(left[index], value));
  }
  if (right !== null && typeof right === 'object') {
    if (left === null || typeof left !== 'object' || Array.isArray(left)) return false;
    const keys = Object.keys(right);
    return Object.keys(left).length === keys.length
      && keys.every((key) => Object.hasOwn(left, key) && sameClosedValue(left[key], right[key]));
  }
  return left === right;
}

function pick(record, fields) {
  return Object.fromEntries(fields.map((field) => [field, record[field]]));
}

function assertDigest(value, label, code) {
  if (typeof value !== 'string' || !EARNINGS_DIGEST_PATTERN.test(value)) {
    throw new MarketDataL3Error(code, `${label} must use sha256:<64 lowercase hex>`);
  }
}

/** Bytewise sorted and strictly unique CAS id list. */
function assertSortedUniqueCasIds(value, label, code) {
  if (!Array.isArray(value)) {
    throw new MarketDataL3Error(code, `${label} must be an array`);
  }
  value.forEach((id, index) => assertCasId(id, `${label}[${index}]`));
  for (let index = 1; index < value.length; index += 1) {
    if (!(value[index - 1] < value[index])) {
      throw new MarketDataL3Error(code, `${label} must be bytewise sorted and strictly unique`);
    }
  }
  return [...value];
}

/**
 * Supersession is forbidden on every L4C-I2 object: an as-of materialization is
 * a pinned answer, never an append-only chain.
 */
function assertNoSupersession(value, label) {
  const offending = Reflect.ownKeys(assertPlainObject(value, label))
    .find((key) => typeof key === 'string' && key.startsWith('supersedes'));
  if (offending !== undefined) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_SUPERSESSION_FORBIDDEN',
      `${label} must not carry ${String(offending)}`);
  }
}

/* ------------------------------------------------------------------------- *
 * EarningsFiscalClassificationDiagnosticDigest/1
 *
 * Owner authority OWNER-L4C-I2-D01-2026-07-26 closes the preimage:
 *   UTF-8(domain) 0x0A  then, per entry, UTF-8(code) 0x00 UTF-8(token) 0x0A
 * sorted bytewise on token then code, duplicates rejected. An empty diagnostic
 * set yields the domain line alone - there is no sentinel entry.
 * ------------------------------------------------------------------------- */

export const EARNINGS_FISCAL_CLASSIFICATION_DIAGNOSTIC_DIGEST_DOMAIN =
  'EarningsFiscalClassificationDiagnosticDigest/1';
/** Token used when a diagnostic is not attributable to a single raw period. */
export const EARNINGS_FISCAL_DIAGNOSTIC_NONE_SENTINEL = 'NONE';

/**
 * @param {ReadonlyArray<{code: string, rawPeriodIdToken: string}>} entries
 * @returns {string} sha256:<hex>
 */
export function earningsFiscalClassificationDiagnosticDigestV1(entries) {
  const code = 'EARNINGS_FISCAL_REPORT_INVALID';
  if (!Array.isArray(entries)) {
    throw new MarketDataL3Error(code, 'diagnostic entries must be an array');
  }
  const normalized = entries.map((entry, index) => {
    const label = `diagnostics[${index}]`;
    const record = closedEarningsI2Record(entry, ['code', 'rawPeriodIdToken'], label, code);
    assertEnum(record.code, EARNINGS_FISCAL_DIAGNOSTIC_CODES, `${label}.code`, code);
    assertNonEmptyString(record.rawPeriodIdToken, `${label}.rawPeriodIdToken`);
    // D-01: token is exactly NONE or sha256:<64 lowercase hex>. Reject double
    // prefixes, uppercase hex, wrong length, and embedded CR/LF/NUL by the same
    // closed pattern — never by a suffix heuristic.
    if (record.rawPeriodIdToken !== EARNINGS_FISCAL_DIAGNOSTIC_NONE_SENTINEL
        && !SHA256_OBJECT_ID_PATTERN.test(record.rawPeriodIdToken)) {
      throw new MarketDataL3Error(code,
        `${label}.rawPeriodIdToken must be sha256:<64 lowercase hex> or NONE`);
    }
    return { code: record.code, rawPeriodIdToken: record.rawPeriodIdToken };
  });
  normalized.sort((left, right) => {
    if (left.rawPeriodIdToken !== right.rawPeriodIdToken) {
      return left.rawPeriodIdToken < right.rawPeriodIdToken ? -1 : 1;
    }
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    return 0;
  });
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous.rawPeriodIdToken === current.rawPeriodIdToken && previous.code === current.code) {
      throw new MarketDataL3Error(code,
        `duplicate diagnostic (${current.rawPeriodIdToken}, ${current.code})`);
    }
  }
  const chunks = [Buffer.from(`${EARNINGS_FISCAL_CLASSIFICATION_DIAGNOSTIC_DIGEST_DOMAIN}\n`, 'utf8')];
  for (const entry of normalized) {
    chunks.push(Buffer.from(entry.code, 'utf8'));
    chunks.push(Buffer.from([0x00]));
    chunks.push(Buffer.from(entry.rawPeriodIdToken, 'utf8'));
    chunks.push(Buffer.from([0x0a]));
  }
  return `sha256:${createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}`;
}

/* ------------------------------------------------------------------------- *
 * K1 — EarningsAsOfResolutionPolicy/1, closed singleton.
 * ------------------------------------------------------------------------- */

export const EARNINGS_AS_OF_RESOLUTION_POLICY_VALUES = Object.freeze({
  datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
  cutoffBoundaryRule: 'PUBLIC_AVAILABLE_AT_LESS_THAN_OR_EQUAL',
  cutoffTimezonePolicy: 'UTC_INSTANT_REQUIRED',
  causalTimestampAuthority: 'REVISION_PUBLIC_AVAILABLE_AT',
  latestReferencePolicy: 'FORBIDDEN',
  networkDuringResolutionPolicy: 'FORBIDDEN',
  globalCasScanPolicy: 'FORBIDDEN',
  wallClockPolicy: 'FORBIDDEN',
  snapshotSelectionPolicy: 'EXPLICIT_PIN_ONLY',
  futureRevisionPolicy: 'IGNORE_SILENTLY',
  emptyVisibleSetPolicy: 'MATERIALIZE_EMPTY',
  asOfPolicyVersion: 'EarningsAsOfResolution/1',
});

export const EARNINGS_AS_OF_RESOLUTION_POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(EARNINGS_AS_OF_RESOLUTION_POLICY_VALUES),
]);

export function normalizeEarningsAsOfResolutionPolicyV1(value) {
  const code = 'EARNINGS_AS_OF_POLICY_INVALID';
  const policy = closedEarningsI2Record(value, EARNINGS_AS_OF_RESOLUTION_POLICY_FIELDS,
    EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(EARNINGS_AS_OF_RESOLUTION_POLICY_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `as-of policy field ${field} diverges from closed V1`);
    }
  }
  return {
    schemaVersion: EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    ...copyClosed(EARNINGS_AS_OF_RESOLUTION_POLICY_VALUES),
  };
}

/* ------------------------------------------------------------------------- *
 * K2 — EarningsFiscalClassificationPolicy/1, closed singleton.
 * ------------------------------------------------------------------------- */

export const EARNINGS_FISCAL_CLASSIFICATION_POLICY_VALUES = Object.freeze({
  datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
  fiscalMetadataAuthority: 'PINNED_SEC_DOCUMENT_BYTES_DEI_V1',
  orderedFiscalMetadataTags: EARNINGS_FISCAL_METADATA_TAGS,
  fiscalPeriodClasses: EARNINGS_FISCAL_PERIOD_CLASSES,
  fiscalPeriodFocusValues: EARNINGS_FISCAL_PERIOD_FOCUS_VALUES,
  roleAssignmentPolicy: 'DECLARED_FOCUS_WITH_RELATIONAL_SPAN_ORDER_V1',
  q1DualRolePolicy: 'EMIT_QUARTER_AND_YEAR_TO_DATE',
  terminalQuarterPolicy: 'SOURCE_CONTEXT_ONLY',
  derivedPeriodPolicy: 'FORBIDDEN',
  dayTolerancePolicy: 'FORBIDDEN_EXACT_DATES_ONLY',
  calendarInferencePolicy: 'FORBIDDEN_NO_FISCAL_CALENDAR_AUTHORITY',
  comparativePeriodPolicy: 'EXCLUDED_BY_DOCUMENT_PERIOD_END_MATCH',
  multiDocumentPeriodEndPolicy: 'REQUIRE_IDENTICAL',
  orderedFormFocusCompatibility: EARNINGS_FORM_FOCUS_COMPATIBILITY,
  ambiguityPolicy: 'DIAGNOSE_AND_OMIT',
  missingMetadataPolicy: 'DIAGNOSE_AND_OMIT',
  rawPeriodMutationPolicy: 'FORBIDDEN_READ_ONLY',
  classificationPolicyVersion: 'EarningsFiscalClassification/1',
  classificationBasisValues: EARNINGS_FISCAL_CLASSIFICATION_BASIS_VALUES,
  classificationMethodValues: EARNINGS_FISCAL_CLASSIFICATION_METHOD_VALUES,
  terminalQuarterProvabilityPolicy: 'FAIL_CLOSED_UNPROVABLE',
});

export const EARNINGS_FISCAL_CLASSIFICATION_POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(EARNINGS_FISCAL_CLASSIFICATION_POLICY_VALUES),
]);

export function normalizeEarningsFiscalClassificationPolicyV1(value) {
  const code = 'EARNINGS_FISCAL_POLICY_INVALID';
  const policy = closedEarningsI2Record(value, EARNINGS_FISCAL_CLASSIFICATION_POLICY_FIELDS,
    EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(EARNINGS_FISCAL_CLASSIFICATION_POLICY_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `fiscal policy field ${field} diverges from closed V1`);
    }
  }
  return {
    schemaVersion: EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
    ...copyClosed(EARNINGS_FISCAL_CLASSIFICATION_POLICY_VALUES),
  };
}

/** Ordered focus values a pinned form type may declare, or null when unknown. */
export function allowedFocusValuesForFormType(formType) {
  const entry = EARNINGS_FORM_FOCUS_COMPATIBILITY.find((row) => row.formType === formType);
  return entry === undefined ? null : entry.orderedAllowedFocusValues;
}

/* ------------------------------------------------------------------------- *
 * K3 — EarningsFiscalPeriodClassificationCore/1.
 * ------------------------------------------------------------------------- */

export const EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS = Object.freeze([
  'schemaVersion', 'earningsRevisionIdentityId', 'financialPeriodIdentityId',
  'fiscalPeriodClass', 'fiscalPeriodFocus', 'fiscalYearFocus', 'documentPeriodEndDate',
  'sourceFormType', 'fiscalMetadataSourceDocumentBytesId', 'classificationBasis',
  'classificationMethod', 'orderedSourceFactTags',
]);

/**
 * orderedSourceFactTags must be an ordered subset of the three canonical source
 * fact tokens, in the canonical order, without duplicates or unknown tokens.
 */
function assertOrderedSourceFactTags(value, label) {
  const code = 'EARNINGS_FISCAL_SOURCE_FACT_TAGS_INVALID';
  if (!Array.isArray(value)) {
    throw new MarketDataL3Error(code, `${label} must be an array`);
  }
  let cursor = -1;
  for (const [index, token] of value.entries()) {
    const position = EARNINGS_FISCAL_SOURCE_FACT_TAGS.indexOf(token);
    if (position === -1) {
      throw new MarketDataL3Error(code, `${label}[${index}] is not a canonical source fact tag`);
    }
    if (position <= cursor) {
      throw new MarketDataL3Error(code,
        `${label} must be a duplicate-free ordered subset in canonical order`);
    }
    cursor = position;
  }
  return [...value];
}

export function normalizeEarningsFiscalPeriodClassificationCoreV1(value) {
  const code = 'EARNINGS_FISCAL_CLASSIFICATION_INVALID';
  assertNoSupersession(value, EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION);
  const core = closedEarningsI2Record(value, EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS,
    EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION, code);
  assertSchemaVersion(core, EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION);
  assertCasId(core.earningsRevisionIdentityId, 'earningsRevisionIdentityId');
  assertCasId(core.financialPeriodIdentityId, 'financialPeriodIdentityId');
  assertEnum(core.fiscalPeriodClass, EARNINGS_FISCAL_PERIOD_CLASSES, 'fiscalPeriodClass', code);
  if (core.fiscalPeriodFocus !== null) {
    assertEnum(core.fiscalPeriodFocus, EARNINGS_FISCAL_PERIOD_FOCUS_VALUES, 'fiscalPeriodFocus', code);
  }
  if (core.fiscalYearFocus !== null) {
    assertNonEmptyString(core.fiscalYearFocus, 'fiscalYearFocus');
    if (!EARNINGS_FISCAL_YEAR_FOCUS_PATTERN.test(core.fiscalYearFocus)) {
      throw new MarketDataL3Error('EARNINGS_FISCAL_YEAR_FOCUS_INVALID',
        'fiscalYearFocus must be exactly four digits');
    }
  }
  assertCivilDate(core.documentPeriodEndDate, 'documentPeriodEndDate');
  assertEnum(core.sourceFormType, EARNINGS_ALLOWED_FORM_TYPES, 'sourceFormType', code);
  assertCasId(core.fiscalMetadataSourceDocumentBytesId, 'fiscalMetadataSourceDocumentBytesId');
  assertEnum(core.classificationBasis, EARNINGS_FISCAL_CLASSIFICATION_BASIS_VALUES,
    'classificationBasis', code);
  assertEnum(core.classificationMethod, EARNINGS_FISCAL_CLASSIFICATION_METHOD_VALUES,
    'classificationMethod', code);
  const orderedSourceFactTags = assertOrderedSourceFactTags(core.orderedSourceFactTags,
    'orderedSourceFactTags');
  return {
    ...pick(core, EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS),
    schemaVersion: EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
    orderedSourceFactTags,
  };
}

export function earningsFiscalPeriodClassificationCoreIdFor(value) {
  return canonicalHash(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
    normalizeEarningsFiscalPeriodClassificationCoreV1(value));
}

/* ------------------------------------------------------------------------- *
 * K4 — EarningsFiscalClassificationReport/1.
 * ------------------------------------------------------------------------- */

export const EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS = Object.freeze([
  'schemaVersion', 'earningsRevisionIdentityId', 'earningsFiscalClassificationPolicyId',
  'transformImplementationManifestId', 'sourceFilingDocumentId', 'documentPeriodEndDate',
  'declaredFiscalPeriodFocus', 'declaredFiscalYearFocus', 'orderedFiscalPeriodClassificationIds',
  'classifiedRawPeriodCount', 'unclassifiedRawPeriodCount', 'diagnosticCount',
  'orderedDiagnosticDigest', 'sourceAttestedClassificationCount',
  'policyInferredClassificationCount',
]);

export function normalizeEarningsFiscalClassificationReportV1(value) {
  const code = 'EARNINGS_FISCAL_REPORT_INVALID';
  assertNoSupersession(value, EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION);
  const report = closedEarningsI2Record(value, EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS,
    EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION, code);
  assertSchemaVersion(report, EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION);
  assertCasId(report.earningsRevisionIdentityId, 'earningsRevisionIdentityId');
  assertCasId(report.earningsFiscalClassificationPolicyId, 'earningsFiscalClassificationPolicyId');
  assertCasId(report.transformImplementationManifestId, 'transformImplementationManifestId');
  assertCasId(report.sourceFilingDocumentId, 'sourceFilingDocumentId');
  assertCivilDate(report.documentPeriodEndDate, 'documentPeriodEndDate');
  if (report.declaredFiscalPeriodFocus !== null) {
    assertEnum(report.declaredFiscalPeriodFocus, EARNINGS_FISCAL_PERIOD_FOCUS_VALUES,
      'declaredFiscalPeriodFocus', code);
  }
  if (report.declaredFiscalYearFocus !== null) {
    assertNonEmptyString(report.declaredFiscalYearFocus, 'declaredFiscalYearFocus');
    if (!EARNINGS_FISCAL_YEAR_FOCUS_PATTERN.test(report.declaredFiscalYearFocus)) {
      throw new MarketDataL3Error('EARNINGS_FISCAL_YEAR_FOCUS_INVALID',
        'declaredFiscalYearFocus must be exactly four digits');
    }
  }
  let orderedFiscalPeriodClassificationIds;
  try {
    orderedFiscalPeriodClassificationIds = assertSortedUniqueCasIds(
      report.orderedFiscalPeriodClassificationIds, 'orderedFiscalPeriodClassificationIds',
      'EARNINGS_FISCAL_CLASSIFICATION_ORDER_INVALID');
  } catch (error) {
    if (error instanceof MarketDataL3Error
      && error.code === 'EARNINGS_FISCAL_CLASSIFICATION_ORDER_INVALID') throw error;
    throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_ORDER_INVALID',
      'orderedFiscalPeriodClassificationIds is invalid', { cause: error });
  }
  for (const field of ['classifiedRawPeriodCount', 'unclassifiedRawPeriodCount', 'diagnosticCount',
    'sourceAttestedClassificationCount', 'policyInferredClassificationCount']) {
    assertSafeInteger(report[field], field, { nonNegative: true });
  }
  assertDigest(report.orderedDiagnosticDigest, 'orderedDiagnosticDigest', code);
  return {
    ...pick(report, EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS),
    schemaVersion: EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION,
    orderedFiscalPeriodClassificationIds,
  };
}

/* ------------------------------------------------------------------------- *
 * K5 — EarningsDatasetBinding/1.
 * ------------------------------------------------------------------------- */

export const EARNINGS_DATASET_BINDING_POLICY_VERSION = 'EarningsDatasetBinding/1';

export const EARNINGS_DATASET_BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'earningsDatasetSnapshotManifestId', 'earningsEventSetManifestId',
  'earningsRevisionSetManifestId', 'earningsExtractionSetManifestId', 'earningsIngestionPolicyId',
  'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
  'earningsAsOfResolutionPolicyId', 'earningsFiscalClassificationPolicyId',
  'transformImplementationManifestId', 'datasetSeriesIdentity', 'jurisdictionCode',
  'currencyCode', 'knowledgeCutoff', 'temporalCapability', 'bindingPolicyVersion',
]);

const EARNINGS_BINDING_REFERENCE_FIELDS = Object.freeze([
  'earningsDatasetSnapshotManifestId', 'earningsEventSetManifestId',
  'earningsRevisionSetManifestId', 'earningsExtractionSetManifestId', 'earningsIngestionPolicyId',
  'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
  'earningsAsOfResolutionPolicyId', 'earningsFiscalClassificationPolicyId',
  'transformImplementationManifestId',
]);

export function normalizeEarningsDatasetBindingV1(value) {
  const code = 'EARNINGS_BINDING_INVALID';
  assertNoSupersession(value, EARNINGS_DATASET_BINDING_SCHEMA_VERSION);
  const binding = closedEarningsI2Record(value, EARNINGS_DATASET_BINDING_FIELDS,
    EARNINGS_DATASET_BINDING_SCHEMA_VERSION, code);
  assertSchemaVersion(binding, EARNINGS_DATASET_BINDING_SCHEMA_VERSION);
  for (const field of EARNINGS_BINDING_REFERENCE_FIELDS) assertCasId(binding[field], field);
  if (binding.datasetSeriesIdentity !== EARNINGS_DATASET_SERIES_IDENTITY) {
    throw new MarketDataL3Error(code, 'datasetSeriesIdentity is foreign to L4C');
  }
  if (binding.jurisdictionCode !== 'US') {
    throw new MarketDataL3Error(code, 'jurisdictionCode must be US');
  }
  if (binding.currencyCode !== 'USD') {
    throw new MarketDataL3Error(code, 'currencyCode must be USD');
  }
  try {
    assertUtcInstant(binding.knowledgeCutoff, 'knowledgeCutoff');
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_KNOWLEDGE_CUTOFF_INVALID',
      'knowledgeCutoff must be a strict UTC instant', { cause });
  }
  assertEnum(binding.temporalCapability, EARNINGS_BINDING_TEMPORAL_CAPABILITIES,
    'temporalCapability', code);
  if (binding.bindingPolicyVersion !== EARNINGS_DATASET_BINDING_POLICY_VERSION) {
    throw new MarketDataL3Error(code, 'bindingPolicyVersion diverges from the closed V1 value');
  }
  return {
    ...pick(binding, EARNINGS_DATASET_BINDING_FIELDS),
    schemaVersion: EARNINGS_DATASET_BINDING_SCHEMA_VERSION,
  };
}

/* ------------------------------------------------------------------------- *
 * K6 — EarningsAsOfMaterializationReport/1.
 * ------------------------------------------------------------------------- */

/** Section 15 authority: the single, constant report policy version. */
export const EARNINGS_AS_OF_MATERIALIZATION_REPORT_POLICY_VERSION =
  'EarningsAsOfMaterializationReport/1';

export const EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS = Object.freeze([
  'schemaVersion', 'earningsDatasetBindingId', 'earningsDatasetSnapshotManifestId',
  'earningsAsOfResolutionPolicyId', 'earningsFiscalClassificationPolicyId',
  'transformImplementationManifestId', 'earningsIngestionPolicyId',
  'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
  'datasetSeriesIdentity', 'jurisdictionCode', 'currencyCode', 'knowledgeCutoff',
  'sourceSnapshotEmpty', 'emptyMaterialization', 'visibleEventCount', 'visibleRevisionCount',
  'visibleExtractionReportCount', 'visibleMetricObservationCount', 'visibleRawPeriodCount',
  'fiscalClassificationCount', 'classifiedRawPeriodCount', 'unclassifiedRawPeriodCount',
  'dualRoleRawPeriodCount', 'classificationDiagnosticCount', 'earliestVisiblePublicAvailableAt',
  'latestVisiblePublicAvailableAt', 'countsByFiscalPeriodClass', 'countsByFiscalPeriodFocus',
  'orderedVisibleEventIdentityIds', 'orderedVisibleRevisionIdentityIds',
  'orderedVisibleExtractionReportIds', 'orderedVisibleMetricObservationIds',
  'orderedVisibleRawPeriodIds', 'orderedFiscalClassificationIds',
  'orderedFiscalClassificationReportIds', 'orderedVisibleEventIdentityDigest',
  'orderedVisibleRevisionIdentityDigest', 'orderedVisibleExtractionReportDigest',
  'orderedVisibleMetricObservationDigest', 'orderedVisibleRawPeriodDigest',
  'orderedFiscalClassificationDigest', 'orderedClassificationDiagnosticDigest',
  'materializationFunctionalFingerprint', 'reportPolicyVersion',
  'sourceAttestedClassificationCount', 'policyInferredClassificationCount',
]);

const MATERIALIZATION_COUNT_FIELDS = Object.freeze([
  'visibleEventCount', 'visibleRevisionCount', 'visibleExtractionReportCount',
  'visibleMetricObservationCount', 'visibleRawPeriodCount', 'fiscalClassificationCount',
  'classifiedRawPeriodCount', 'unclassifiedRawPeriodCount', 'dualRoleRawPeriodCount',
  'classificationDiagnosticCount', 'sourceAttestedClassificationCount',
  'policyInferredClassificationCount',
]);

const MATERIALIZATION_ORDERED_ID_FIELDS = Object.freeze([
  'orderedVisibleEventIdentityIds', 'orderedVisibleRevisionIdentityIds',
  'orderedVisibleExtractionReportIds', 'orderedVisibleMetricObservationIds',
  'orderedVisibleRawPeriodIds', 'orderedFiscalClassificationIds',
  'orderedFiscalClassificationReportIds',
]);

const MATERIALIZATION_DIGEST_FIELDS = Object.freeze([
  'orderedVisibleEventIdentityDigest', 'orderedVisibleRevisionIdentityDigest',
  'orderedVisibleExtractionReportDigest', 'orderedVisibleMetricObservationDigest',
  'orderedVisibleRawPeriodDigest', 'orderedFiscalClassificationDigest',
  'orderedClassificationDiagnosticDigest', 'materializationFunctionalFingerprint',
]);

const MATERIALIZATION_REFERENCE_FIELDS = Object.freeze([
  'earningsDatasetBindingId', 'earningsDatasetSnapshotManifestId',
  'earningsAsOfResolutionPolicyId', 'earningsFiscalClassificationPolicyId',
  'transformImplementationManifestId', 'earningsIngestionPolicyId',
  'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
]);

function normalizeClosedCountRecord(value, buckets, label, code) {
  const record = closedEarningsI2Record(value, buckets, label, code);
  for (const bucket of buckets) {
    assertSafeInteger(record[bucket], `${label}.${bucket}`, { nonNegative: true });
  }
  return pick(record, buckets);
}

export function normalizeEarningsAsOfMaterializationReportV1(value) {
  const code = 'EARNINGS_MATERIALIZATION_INVALID';
  assertNoSupersession(value, EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION);
  const report = closedEarningsI2Record(value, EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS,
    EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION, code);
  assertSchemaVersion(report, EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION);
  for (const field of MATERIALIZATION_REFERENCE_FIELDS) assertCasId(report[field], field);
  if (report.datasetSeriesIdentity !== EARNINGS_DATASET_SERIES_IDENTITY) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_FOREIGN_DATASET',
      'datasetSeriesIdentity is foreign to L4C');
  }
  if (report.jurisdictionCode !== 'US') {
    throw new MarketDataL3Error(code, 'jurisdictionCode must be US');
  }
  if (report.currencyCode !== 'USD') {
    throw new MarketDataL3Error(code, 'currencyCode must be USD');
  }
  try {
    assertUtcInstant(report.knowledgeCutoff, 'knowledgeCutoff');
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_KNOWLEDGE_CUTOFF_INVALID',
      'knowledgeCutoff must be a strict UTC instant', { cause });
  }
  for (const field of ['sourceSnapshotEmpty', 'emptyMaterialization']) {
    if (typeof report[field] !== 'boolean') {
      throw new MarketDataL3Error(code, `${field} must be a boolean`);
    }
  }
  for (const field of MATERIALIZATION_COUNT_FIELDS) {
    assertSafeInteger(report[field], field, { nonNegative: true });
  }
  assertUtcInstant(report.earliestVisiblePublicAvailableAt, 'earliestVisiblePublicAvailableAt', true);
  assertUtcInstant(report.latestVisiblePublicAvailableAt, 'latestVisiblePublicAvailableAt', true);
  // The empty materialization is exactly the null-window case: the two bounds
  // are null if and only if no revision is visible.
  const boundsNull = report.earliestVisiblePublicAvailableAt === null
    && report.latestVisiblePublicAvailableAt === null;
  const boundsMixed = (report.earliestVisiblePublicAvailableAt === null)
    !== (report.latestVisiblePublicAvailableAt === null);
  if (boundsMixed) {
    throw new MarketDataL3Error(code,
      'earliest and latest visible publicAvailableAt must be null together');
  }
  if (report.emptyMaterialization !== (report.visibleRevisionCount === 0)) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_COUNT_MISMATCH',
      'emptyMaterialization must equal visibleRevisionCount === 0');
  }
  if (boundsNull !== (report.visibleRevisionCount === 0)) {
    throw new MarketDataL3Error(code,
      'visible publicAvailableAt bounds must be null exactly when the materialization is empty');
  }
  if (!boundsNull
    && report.earliestVisiblePublicAvailableAt > report.latestVisiblePublicAvailableAt) {
    throw new MarketDataL3Error(code, 'visible publicAvailableAt window is inverted');
  }
  const countsByFiscalPeriodClass = normalizeClosedCountRecord(report.countsByFiscalPeriodClass,
    EARNINGS_FISCAL_PERIOD_CLASSES, 'countsByFiscalPeriodClass', code);
  const countsByFiscalPeriodFocus = normalizeClosedCountRecord(report.countsByFiscalPeriodFocus,
    EARNINGS_FISCAL_PERIOD_FOCUS_BUCKETS, 'countsByFiscalPeriodFocus', code);
  const orderedLists = {};
  for (const field of MATERIALIZATION_ORDERED_ID_FIELDS) {
    orderedLists[field] = assertSortedUniqueCasIds(report[field], field,
      'EARNINGS_MATERIALIZATION_ORDER_INVALID');
  }
  for (const field of MATERIALIZATION_DIGEST_FIELDS) assertDigest(report[field], field, code);
  if (report.reportPolicyVersion !== EARNINGS_AS_OF_MATERIALIZATION_REPORT_POLICY_VERSION) {
    throw new MarketDataL3Error(code, 'reportPolicyVersion diverges from the closed V1 value');
  }
  return {
    ...pick(report, EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS),
    schemaVersion: EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    countsByFiscalPeriodClass,
    countsByFiscalPeriodFocus,
    ...orderedLists,
  };
}

export {
  MATERIALIZATION_COUNT_FIELDS as EARNINGS_MATERIALIZATION_COUNT_FIELDS,
  MATERIALIZATION_ORDERED_ID_FIELDS as EARNINGS_MATERIALIZATION_ORDERED_ID_FIELDS,
  MATERIALIZATION_DIGEST_FIELDS as EARNINGS_MATERIALIZATION_DIGEST_FIELDS,
  MATERIALIZATION_REFERENCE_FIELDS as EARNINGS_MATERIALIZATION_REFERENCE_FIELDS,
};
