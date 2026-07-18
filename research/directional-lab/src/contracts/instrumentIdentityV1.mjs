/**
 * L2B — permanent instrument identity contracts (synthetic fixtures only).
 *
 * A ticker is never a permanent identity. Identity is an opaque content-addressed
 * InstrumentIdentityCore/1 under an InstrumentIdentityAuthorityPolicy/1 that
 * enforces HEX_LOWERCASE seeds of fixed length. Symbols are historical aliases;
 * provider IDs are separate bindings; revocations are explicit append-only
 * objects. Corporate actions belong to L2C, not here.
 *
 * Evidence object IDs are intentionally absent from L2B: no generic verifiable
 * evidence contract exists yet, so unverifiable hash lists are not accepted.
 */

import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import { isValidCivilDate } from '../time/civilDate.mjs';
import { isStrictUtcIsoInstant } from './dailyBarV1.mjs';
import {
  EXECUTION_IDENTITY_ENVIRONMENTS,
} from './datasetQualityAssessmentV1.mjs';
import {
  checkFieldSet,
  checkNonEmptyString,
  checkNullableObjectId,
  checkObjectId,
  checkObjectIdArray,
  isPlainObject,
  sortedUniqueStrings,
  throwForProblems,
} from './contractPrimitivesV1.mjs';

export const INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION = 'InstrumentIdentityAuthorityPolicy/1';
export const INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION = 'InstrumentIdentityCore/1';
export const INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION = 'InstrumentIdentityRecord/1';
export const INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION = 'InstrumentDescriptorCore/1';
export const SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION = 'SymbolNamespacePolicy/1';
export const INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION = 'InstrumentAliasBindingCore/1';
export const PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION = 'ProviderInstrumentBindingCore/1';
export const INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION = 'InstrumentAliasRevocationCore/1';
export const PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION = 'ProviderInstrumentRevocationCore/1';
export const INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION = 'InstrumentIdentityManifest/1';
export const INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION = 'InstrumentIdentityRegistryManifest/1';
export const DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION = 'DatasetSnapshotInstrumentBinding/1';

export const INSTRUMENT_KINDS = Object.freeze([
  'EQUITY', 'ETF', 'ETN', 'INDEX', 'FUND', 'FUTURE', 'OTHER',
]);
export const INSTRUMENT_DESCRIPTOR_STATUSES = Object.freeze([
  'ACTIVE', 'DELISTED', 'MERGED', 'EXPIRED', 'INACTIVE', 'UNKNOWN',
]);
export const SYMBOL_CASE_POLICIES = Object.freeze(['ASCII_UPPERCASE', 'CASE_SENSITIVE']);
export const SYMBOL_VENUE_POLICIES = Object.freeze(['NOT_APPLICABLE', 'OPTIONAL', 'REQUIRED']);
export const SYMBOL_CURRENCY_POLICIES = Object.freeze(['FORBIDDEN', 'OPTIONAL', 'REQUIRED']);
export const SYMBOL_ALLOWED_CHARACTER_POLICIES = Object.freeze([
  'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
]);
export const ALIAS_BINDING_STATUSES = Object.freeze(['CONFIRMED', 'PROVISIONAL']);
export const PROVIDER_BINDING_STATUSES = Object.freeze(['ACTIVE']);
export const IDENTITY_SEED_FORMATS = Object.freeze(['HEX_LOWERCASE']);
export const REVOCATION_REASON_CODES = Object.freeze([
  'SUPERSEDED_BY_RENAME',
  'DATA_CORRECTION',
  'AUTHORITY_WITHDRAWAL',
  'DUPLICATE_BINDING',
  'OTHER_POLICY',
]);

const AUTHORITY_POLICY_FIELDS = Object.freeze([
  'schemaVersion', 'authorityId', 'identitySeedFormat', 'identitySeedLength',
]);
const IDENTITY_CORE_FIELDS = Object.freeze([
  'schemaVersion', 'authorityPolicyId', 'identitySeed', 'instrumentKind',
]);
const IDENTITY_RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'instrumentIdentityId', 'registeredAt', 'registrationAuthority', 'executionIdentity',
]);
const DESCRIPTOR_FIELDS = Object.freeze([
  'schemaVersion', 'instrumentIdentityId', 'legalName', 'displayName', 'instrumentKind',
  'domicileCountry', 'primaryCurrency', 'status',
]);
const NAMESPACE_POLICY_FIELDS = Object.freeze([
  'schemaVersion', 'namespaceId', 'namespaceVersion', 'providerId', 'venuePolicy', 'casePolicy',
  'allowedCharacterPolicy', 'currencyPolicy',
]);
const ALIAS_BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'instrumentIdentityId', 'namespacePolicyId', 'providerId', 'venueId',
  'symbol', 'symbolLookupKey', 'currency', 'validFrom', 'validToExclusive', 'bindingStatus',
]);
const PROVIDER_BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'instrumentIdentityId', 'providerId', 'providerInstrumentId',
  'validFrom', 'validToExclusive', 'status',
]);
const ALIAS_REVOCATION_FIELDS = Object.freeze([
  'schemaVersion', 'revokedAliasBindingCoreId', 'instrumentIdentityId', 'effectiveFrom', 'reasonCode',
]);
const PROVIDER_REVOCATION_FIELDS = Object.freeze([
  'schemaVersion', 'revokedProviderBindingCoreId', 'instrumentIdentityId', 'effectiveFrom', 'reasonCode',
]);
const IDENTITY_MANIFEST_FIELDS = Object.freeze([
  'schemaVersion', 'instrumentIdentityId', 'identityRecordIds', 'descriptorCoreIds',
  'aliasBindingCoreIds', 'providerBindingCoreIds', 'aliasRevocationCoreIds',
  'providerRevocationCoreIds', 'supersedesManifestId',
]);
const REGISTRY_MANIFEST_FIELDS = Object.freeze([
  'schemaVersion', 'authorityPolicyId', 'identityManifestIds',
  'snapshotInstrumentBindingIds', 'supersedesRegistryManifestId',
]);
const SNAPSHOT_INSTRUMENT_BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'snapshotCoreId', 'instrumentIdentityId', 'aliasBindingCoreId',
  'resolutionDate', 'canonicalSymbolObserved', 'providerId', 'providerSymbolObserved',
]);
const EXECUTION_IDENTITY_FIELDS = Object.freeze(['runnerId', 'runId', 'environment']);

const ISO_4217_RE = /^[A-Z]{3}$/;
const ISO_3166_ALPHA2_RE = /^[A-Z]{2}$/;
const ASCII_SYMBOL_RE = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_SYMBOL_RE = /[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]|:\/\/|[\\/]/;
const HEX_LOWERCASE_RE = /^[0-9a-f]+$/;

export class InstrumentIdentityError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'InstrumentIdentityError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string[]} problems */
function invalid(code, problems) {
  return new InstrumentIdentityError(code, problems.join('; '), { problems });
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
function checkCivilDate(value, label, problems) {
  if (typeof value !== 'string' || !isValidCivilDate(value)) {
    problems.push(`${label} must be a civil YYYY-MM-DD date`);
  }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
function checkNullableCivilDate(value, label, problems) {
  if (value === null) return;
  checkCivilDate(value, label, problems);
}

/** @param {unknown} from @param {unknown} toExclusive @param {string[]} problems */
function checkHalfOpenInterval(from, toExclusive, problems) {
  if (typeof from === 'string' && isValidCivilDate(from)
    && typeof toExclusive === 'string' && isValidCivilDate(toExclusive)
    && !(toExclusive > from)) {
    problems.push('validToExclusive must be strictly greater than validFrom');
  }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
function checkIso4217OrNull(value, label, problems) {
  if (value === null) return;
  if (typeof value !== 'string' || !ISO_4217_RE.test(value)) {
    problems.push(`${label} must be ISO 4217 uppercase or null`);
  }
}

/** @param {unknown} value @param {string[]} problems */
function checkExecutionIdentity(value, problems) {
  if (!isPlainObject(value)) {
    problems.push('executionIdentity must be a plain object');
    return;
  }
  const identity = /** @type {Record<string, unknown>} */ (value);
  checkFieldSet(identity, EXECUTION_IDENTITY_FIELDS, problems);
  checkNonEmptyString(identity.runnerId, 'executionIdentity.runnerId', problems);
  if (identity.runId !== null) checkNonEmptyString(identity.runId, 'executionIdentity.runId', problems);
  if (!EXECUTION_IDENTITY_ENVIRONMENTS.includes(/** @type {any} */ (identity.environment))) {
    problems.push('executionIdentity.environment must be LOCAL_TEST, LOCAL_MANUAL or CI');
  }
  for (const field of ['runnerId', 'runId']) {
    const text = identity[field];
    if (typeof text === 'string' && (text.includes('/') || text.includes('\\') || /^[A-Za-z]:/.test(text))) {
      problems.push(`executionIdentity.${field} must not contain a physical path`);
    }
  }
}

/**
 * Refuse filesystem/URL shapes while allowing logical ids with a slash separator.
 * @param {unknown} value @param {string} label @param {string[]} problems
 */
function checkNoPhysicalPath(value, label, problems) {
  if (typeof value !== 'string') return;
  if (
    value.includes('\\')
    || value.includes('\0')
    || value.includes('://')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || value.includes('/./')
    || value.includes('/../')
    || value.endsWith('/.')
    || value.endsWith('/..')
  ) {
    problems.push(`${label} must not contain a physical path or URL`);
  }
}

/** @param {unknown} value @param {string} label @param {string[]} problems */
function checkPositiveInteger(value, label, problems) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    problems.push(`${label} must be a positive integer`);
  }
}

/** @param {unknown} value @param {string[]} problems */
function checkSortedUniqueObjectIdArray(value, field, problems) {
  checkObjectIdArray(value, field, problems);
  if (!Array.isArray(value)) return;
  const unique = new Set(/** @type {string[]} */ (value));
  if (unique.size !== value.length) problems.push(`${field} must be unique`);
  const sorted = sortedUniqueStrings(/** @type {string[]} */ (value));
  if (sorted.some((id, index) => id !== value[index])) {
    problems.push(`${field} must be sorted uniquely`);
  }
}

/**
 * Whether asOfDate is inside [validFrom, validToExclusive).
 * @param {string} asOfDate
 * @param {string} validFrom
 * @param {string|null} validToExclusive
 */
export function isDateInHalfOpenInterval(asOfDate, validFrom, validToExclusive) {
  if (!isValidCivilDate(asOfDate) || !isValidCivilDate(validFrom)) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INTERVAL_INVALID', 'interval dates must be civil YYYY-MM-DD');
  }
  if (validToExclusive !== null) {
    if (!isValidCivilDate(validToExclusive) || !(validToExclusive > validFrom)) {
      throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INTERVAL_INVALID', 'validToExclusive must be > validFrom');
    }
  }
  if (asOfDate < validFrom) return false;
  if (validToExclusive !== null && asOfDate >= validToExclusive) return false;
  return true;
}

/**
 * True when a half-open interval [from, toExclusive) contains at least one day.
 * @param {string} from @param {string|null} toExclusive
 */
export function isNonEmptyHalfOpenInterval(from, toExclusive) {
  return toExclusive === null || from < toExclusive;
}

/**
 * True when two half-open intervals [from, toExclusive) overlap.
 * Empty intervals never overlap.
 * @param {string} fromA @param {string|null} toA
 * @param {string} fromB @param {string|null} toB
 */
export function halfOpenIntervalsOverlap(fromA, toA, fromB, toB) {
  if (!isNonEmptyHalfOpenInterval(fromA, toA) || !isNonEmptyHalfOpenInterval(fromB, toB)) {
    return false;
  }
  const endA = toA ?? '\uffff';
  const endB = toB ?? '\uffff';
  return fromA < endB && fromB < endA;
}

/**
 * Cut a binding interval by the earliest revocation effectiveFrom.
 * @param {string} validFrom
 * @param {string|null} validToExclusive
 * @param {string|null} revocationEffectiveFrom
 * @returns {{validFrom: string, validToExclusive: string|null}}
 */
export function effectiveBindingInterval(validFrom, validToExclusive, revocationEffectiveFrom) {
  if (revocationEffectiveFrom === null || revocationEffectiveFrom === undefined) {
    return { validFrom, validToExclusive };
  }
  if (validToExclusive === null || revocationEffectiveFrom < validToExclusive) {
    return { validFrom, validToExclusive: revocationEffectiveFrom };
  }
  return { validFrom, validToExclusive };
}

/** @param {unknown} value @returns {string[]} */
export function instrumentIdentityAuthorityPolicyProblems(value) {
  if (!isPlainObject(value)) return ['authority policy must be a plain object'];
  const policy = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(policy, AUTHORITY_POLICY_FIELDS, problems);
  if (policy.schemaVersion !== INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION}`);
  }
  checkNonEmptyString(policy.authorityId, 'authorityId', problems);
  checkNoPhysicalPath(policy.authorityId, 'authorityId', problems);
  if (!IDENTITY_SEED_FORMATS.includes(/** @type {any} */ (policy.identitySeedFormat))) {
    problems.push('identitySeedFormat is invalid');
  }
  if (policy.identitySeedLength !== 64) {
    problems.push('identitySeedLength must be 64 for HEX_LOWERCASE');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentIdentityAuthorityPolicyV1(value) {
  const problems = instrumentIdentityAuthorityPolicyProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_AUTHORITY_POLICY_INVALID', all));
  const policy = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
    authorityId: policy.authorityId,
    identitySeedFormat: policy.identitySeedFormat,
    identitySeedLength: policy.identitySeedLength,
  };
}

/** @param {unknown} value */
export function validateInstrumentIdentityAuthorityPolicy(value) {
  const problems = instrumentIdentityAuthorityPolicyProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentIdentityAuthorityPolicyId(value) {
  return canonicalHash(
    INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
    normalizeInstrumentIdentityAuthorityPolicyV1(value),
  );
}

/**
 * Validate an identity seed against an authority policy object.
 * @param {{identitySeedFormat: string, identitySeedLength: number}} policy
 * @param {unknown} seed
 * @returns {string[]}
 */
export function identitySeedProblems(policy, seed) {
  const problems = [];
  if (typeof seed !== 'string') {
    problems.push('identitySeed must be a string');
    return problems;
  }
  if (policy.identitySeedFormat === 'HEX_LOWERCASE') {
    if (seed.length !== policy.identitySeedLength) {
      problems.push(`identitySeed must be exactly ${policy.identitySeedLength} lowercase hex characters`);
    }
    if (!HEX_LOWERCASE_RE.test(seed)) {
      problems.push('identitySeed must be lowercase hexadecimal');
    }
  } else {
    problems.push('identitySeedFormat is unsupported');
  }
  return problems;
}

/** @param {unknown} value @returns {string[]} */
export function instrumentIdentityCoreProblems(value) {
  if (!isPlainObject(value)) return ['identity core must be a plain object'];
  const core = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(core, IDENTITY_CORE_FIELDS, problems);
  if (core.schemaVersion !== INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(core.authorityPolicyId, 'authorityPolicyId', problems);
  checkNonEmptyString(core.identitySeed, 'identitySeed', problems);
  checkNoPhysicalPath(core.identitySeed, 'identitySeed', problems);
  if (typeof core.identitySeed === 'string') {
    // Structural hex check without policy length (policy re-check happens in builders).
    if (!HEX_LOWERCASE_RE.test(core.identitySeed) || core.identitySeed.length !== 64) {
      problems.push('identitySeed must be exactly 64 lowercase hex characters');
    }
  }
  if (!INSTRUMENT_KINDS.includes(/** @type {any} */ (core.instrumentKind))) {
    problems.push('instrumentKind is invalid');
  }
  for (const forbidden of [
    'ticker', 'symbol', 'providerId', 'venueId', 'legalName', 'displayName',
    'instrumentIdentityId', 'authorityId',
  ]) {
    if (Object.hasOwn(core, forbidden)) problems.push(`unknown field: ${forbidden}`);
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentIdentityCoreV1(value) {
  const problems = instrumentIdentityCoreProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_IDENTITY_INVALID', all));
  const core = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
    authorityPolicyId: core.authorityPolicyId,
    identitySeed: core.identitySeed,
    instrumentKind: core.instrumentKind,
  };
}

/** @param {unknown} value */
export function validateInstrumentIdentityCore(value) {
  const problems = instrumentIdentityCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentIdentityCoreId(value) {
  return canonicalHash(INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION, normalizeInstrumentIdentityCoreV1(value));
}

/** @param {unknown} value @returns {string[]} */
export function instrumentIdentityRecordProblems(value) {
  if (!isPlainObject(value)) return ['identity record must be a plain object'];
  const record = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(record, IDENTITY_RECORD_FIELDS, problems);
  if (record.schemaVersion !== INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION}`);
  }
  checkObjectId(record.instrumentIdentityId, 'instrumentIdentityId', problems);
  if (!isStrictUtcIsoInstant(record.registeredAt)) {
    problems.push('registeredAt must be a real UTC ISO instant supplied by the caller');
  }
  checkNonEmptyString(record.registrationAuthority, 'registrationAuthority', problems);
  checkNoPhysicalPath(record.registrationAuthority, 'registrationAuthority', problems);
  checkExecutionIdentity(record.executionIdentity, problems);
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentIdentityRecordV1(value) {
  const problems = instrumentIdentityRecordProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_IDENTITY_RECORD_INVALID', all));
  const record = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION,
    instrumentIdentityId: record.instrumentIdentityId,
    registeredAt: new Date(record.registeredAt).toISOString(),
    registrationAuthority: record.registrationAuthority,
    executionIdentity: {
      runnerId: record.executionIdentity.runnerId,
      runId: record.executionIdentity.runId,
      environment: record.executionIdentity.environment,
    },
  };
}

/** @param {unknown} value */
export function validateInstrumentIdentityRecord(value) {
  const problems = instrumentIdentityRecordProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentIdentityRecordId(value) {
  return canonicalHash(INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION, normalizeInstrumentIdentityRecordV1(value));
}

/** @param {unknown} value @returns {string[]} */
export function instrumentDescriptorCoreProblems(value) {
  if (!isPlainObject(value)) return ['descriptor must be a plain object'];
  const descriptor = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(descriptor, DESCRIPTOR_FIELDS, problems);
  if (descriptor.schemaVersion !== INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(descriptor.instrumentIdentityId, 'instrumentIdentityId', problems);
  checkNonEmptyString(descriptor.legalName, 'legalName', problems);
  checkNonEmptyString(descriptor.displayName, 'displayName', problems);
  if (!INSTRUMENT_KINDS.includes(/** @type {any} */ (descriptor.instrumentKind))) {
    problems.push('instrumentKind is invalid');
  }
  if (typeof descriptor.domicileCountry !== 'string' || !ISO_3166_ALPHA2_RE.test(descriptor.domicileCountry)) {
    if (descriptor.domicileCountry !== 'UNKNOWN') {
      problems.push('domicileCountry must be ISO 3166-1 alpha-2 or UNKNOWN');
    }
  }
  if (typeof descriptor.primaryCurrency !== 'string' || !ISO_4217_RE.test(descriptor.primaryCurrency)) {
    if (descriptor.primaryCurrency !== 'UNKNOWN') {
      problems.push('primaryCurrency must be ISO 4217 uppercase or UNKNOWN');
    }
  }
  if (!INSTRUMENT_DESCRIPTOR_STATUSES.includes(/** @type {any} */ (descriptor.status))) {
    problems.push('status is invalid');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentDescriptorCoreV1(value) {
  const problems = instrumentDescriptorCoreProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_DESCRIPTOR_INVALID', all));
  const descriptor = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION,
    instrumentIdentityId: descriptor.instrumentIdentityId,
    legalName: descriptor.legalName,
    displayName: descriptor.displayName,
    instrumentKind: descriptor.instrumentKind,
    domicileCountry: descriptor.domicileCountry,
    primaryCurrency: descriptor.primaryCurrency,
    status: descriptor.status,
  };
}

/** @param {unknown} value */
export function validateInstrumentDescriptorCore(value) {
  const problems = instrumentDescriptorCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentDescriptorCoreId(value) {
  return canonicalHash(INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION, normalizeInstrumentDescriptorCoreV1(value));
}

/** @param {unknown} value @returns {string[]} */
export function symbolNamespacePolicyProblems(value) {
  if (!isPlainObject(value)) return ['namespace policy must be a plain object'];
  const policy = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(policy, NAMESPACE_POLICY_FIELDS, problems);
  if (policy.schemaVersion !== SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION}`);
  }
  checkNonEmptyString(policy.namespaceId, 'namespaceId', problems);
  checkNoPhysicalPath(policy.namespaceId, 'namespaceId', problems);
  checkPositiveInteger(policy.namespaceVersion, 'namespaceVersion', problems);
  checkNonEmptyString(policy.providerId, 'providerId', problems);
  checkNoPhysicalPath(policy.providerId, 'providerId', problems);
  if (!SYMBOL_VENUE_POLICIES.includes(/** @type {any} */ (policy.venuePolicy))) {
    problems.push('venuePolicy is invalid');
  }
  if (!SYMBOL_CASE_POLICIES.includes(/** @type {any} */ (policy.casePolicy))) {
    problems.push('casePolicy is invalid');
  }
  if (!SYMBOL_ALLOWED_CHARACTER_POLICIES.includes(/** @type {any} */ (policy.allowedCharacterPolicy))) {
    problems.push('allowedCharacterPolicy is invalid');
  }
  if (!SYMBOL_CURRENCY_POLICIES.includes(/** @type {any} */ (policy.currencyPolicy))) {
    problems.push('currencyPolicy is invalid');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeSymbolNamespacePolicyV1(value) {
  const problems = symbolNamespacePolicyProblems(value);
  throwForProblems(problems, (all) => invalid('SYMBOL_NAMESPACE_POLICY_INVALID', all));
  const policy = /** @type {any} */ (value);
  return {
    schemaVersion: SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION,
    namespaceId: policy.namespaceId,
    namespaceVersion: policy.namespaceVersion,
    providerId: policy.providerId,
    venuePolicy: policy.venuePolicy,
    casePolicy: policy.casePolicy,
    allowedCharacterPolicy: policy.allowedCharacterPolicy,
    currencyPolicy: policy.currencyPolicy,
  };
}

/** @param {unknown} value */
export function validateSymbolNamespacePolicy(value) {
  const problems = symbolNamespacePolicyProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function symbolNamespacePolicyId(value) {
  return canonicalHash(SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION, normalizeSymbolNamespacePolicyV1(value));
}

/**
 * Derive the lookup key from an official symbol and a namespace policy.
 * @param {{casePolicy: string, allowedCharacterPolicy: string}} policy
 * @param {string} symbol
 */
export function computeSymbolLookupKey(policy, symbol) {
  if (typeof symbol !== 'string' || symbol.length === 0 || symbol !== symbol.trim()) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID', 'symbol must be a non-empty trimmed string');
  }
  if (FORBIDDEN_SYMBOL_RE.test(symbol)) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID', 'symbol contains forbidden characters');
  }
  if (policy.allowedCharacterPolicy === 'ASCII_ALNUM_DOT_DASH_UNDERSCORE' && !ASCII_SYMBOL_RE.test(symbol)) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID', 'symbol violates allowedCharacterPolicy');
  }
  if (policy.casePolicy === 'ASCII_UPPERCASE') {
    if (/[^A-Za-z0-9._-]/.test(symbol)) {
      throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID', 'symbol is not ASCII-safe for ASCII_UPPERCASE');
    }
    return symbol.toUpperCase();
  }
  if (policy.casePolicy === 'CASE_SENSITIVE') return symbol;
  throw new InstrumentIdentityError('SYMBOL_NAMESPACE_POLICY_INVALID', 'casePolicy is invalid');
}

/** @param {unknown} value @returns {string[]} */
export function instrumentAliasBindingCoreProblems(value) {
  if (!isPlainObject(value)) return ['alias binding must be a plain object'];
  const binding = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(binding, ALIAS_BINDING_FIELDS, problems);
  if (binding.schemaVersion !== INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(binding.instrumentIdentityId, 'instrumentIdentityId', problems);
  checkObjectId(binding.namespacePolicyId, 'namespacePolicyId', problems);
  checkNonEmptyString(binding.providerId, 'providerId', problems);
  checkNoPhysicalPath(binding.providerId, 'providerId', problems);
  if (binding.venueId !== null) {
    checkNonEmptyString(binding.venueId, 'venueId', problems);
    checkNoPhysicalPath(binding.venueId, 'venueId', problems);
  }
  checkNonEmptyString(binding.symbol, 'symbol', problems);
  if (typeof binding.symbol === 'string' && FORBIDDEN_SYMBOL_RE.test(binding.symbol)) {
    problems.push('symbol contains forbidden characters');
  }
  checkNonEmptyString(binding.symbolLookupKey, 'symbolLookupKey', problems);
  checkIso4217OrNull(binding.currency, 'currency', problems);
  checkCivilDate(binding.validFrom, 'validFrom', problems);
  checkNullableCivilDate(binding.validToExclusive, 'validToExclusive', problems);
  checkHalfOpenInterval(binding.validFrom, binding.validToExclusive, problems);
  if (!ALIAS_BINDING_STATUSES.includes(/** @type {any} */ (binding.bindingStatus))) {
    problems.push('bindingStatus is invalid');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentAliasBindingCoreV1(value) {
  const problems = instrumentAliasBindingCoreProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_ALIAS_INVALID', all));
  const binding = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION,
    instrumentIdentityId: binding.instrumentIdentityId,
    namespacePolicyId: binding.namespacePolicyId,
    providerId: binding.providerId,
    venueId: binding.venueId,
    symbol: binding.symbol,
    symbolLookupKey: binding.symbolLookupKey,
    currency: binding.currency,
    validFrom: binding.validFrom,
    validToExclusive: binding.validToExclusive,
    bindingStatus: binding.bindingStatus,
  };
}

/** @param {unknown} value */
export function validateInstrumentAliasBindingCore(value) {
  const problems = instrumentAliasBindingCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentAliasBindingCoreId(value) {
  return canonicalHash(INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION, normalizeInstrumentAliasBindingCoreV1(value));
}

/** @param {unknown} value @returns {string[]} */
export function providerInstrumentBindingCoreProblems(value) {
  if (!isPlainObject(value)) return ['provider binding must be a plain object'];
  const binding = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(binding, PROVIDER_BINDING_FIELDS, problems);
  if (binding.schemaVersion !== PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(binding.instrumentIdentityId, 'instrumentIdentityId', problems);
  checkNonEmptyString(binding.providerId, 'providerId', problems);
  checkNoPhysicalPath(binding.providerId, 'providerId', problems);
  checkNonEmptyString(binding.providerInstrumentId, 'providerInstrumentId', problems);
  checkNoPhysicalPath(binding.providerInstrumentId, 'providerInstrumentId', problems);
  checkCivilDate(binding.validFrom, 'validFrom', problems);
  checkNullableCivilDate(binding.validToExclusive, 'validToExclusive', problems);
  checkHalfOpenInterval(binding.validFrom, binding.validToExclusive, problems);
  if (!PROVIDER_BINDING_STATUSES.includes(/** @type {any} */ (binding.status))) {
    problems.push('status is invalid');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeProviderInstrumentBindingCoreV1(value) {
  const problems = providerInstrumentBindingCoreProblems(value);
  throwForProblems(problems, (all) => invalid('PROVIDER_INSTRUMENT_BINDING_INVALID', all));
  const binding = /** @type {any} */ (value);
  return {
    schemaVersion: PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION,
    instrumentIdentityId: binding.instrumentIdentityId,
    providerId: binding.providerId,
    providerInstrumentId: binding.providerInstrumentId,
    validFrom: binding.validFrom,
    validToExclusive: binding.validToExclusive,
    status: binding.status,
  };
}

/** @param {unknown} value */
export function validateProviderInstrumentBindingCore(value) {
  const problems = providerInstrumentBindingCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function providerInstrumentBindingCoreId(value) {
  return canonicalHash(
    PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION,
    normalizeProviderInstrumentBindingCoreV1(value),
  );
}

/** @param {unknown} value @returns {string[]} */
export function instrumentAliasRevocationCoreProblems(value) {
  if (!isPlainObject(value)) return ['alias revocation must be a plain object'];
  const revocation = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(revocation, ALIAS_REVOCATION_FIELDS, problems);
  if (revocation.schemaVersion !== INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(revocation.revokedAliasBindingCoreId, 'revokedAliasBindingCoreId', problems);
  checkObjectId(revocation.instrumentIdentityId, 'instrumentIdentityId', problems);
  checkCivilDate(revocation.effectiveFrom, 'effectiveFrom', problems);
  if (!REVOCATION_REASON_CODES.includes(/** @type {any} */ (revocation.reasonCode))) {
    problems.push('reasonCode is invalid');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentAliasRevocationCoreV1(value) {
  const problems = instrumentAliasRevocationCoreProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_ALIAS_REVOCATION_INVALID', all));
  const revocation = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION,
    revokedAliasBindingCoreId: revocation.revokedAliasBindingCoreId,
    instrumentIdentityId: revocation.instrumentIdentityId,
    effectiveFrom: revocation.effectiveFrom,
    reasonCode: revocation.reasonCode,
  };
}

/** @param {unknown} value */
export function validateInstrumentAliasRevocationCore(value) {
  const problems = instrumentAliasRevocationCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentAliasRevocationCoreId(value) {
  return canonicalHash(
    INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION,
    normalizeInstrumentAliasRevocationCoreV1(value),
  );
}

/** @param {unknown} value @returns {string[]} */
export function providerInstrumentRevocationCoreProblems(value) {
  if (!isPlainObject(value)) return ['provider revocation must be a plain object'];
  const revocation = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(revocation, PROVIDER_REVOCATION_FIELDS, problems);
  if (revocation.schemaVersion !== PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION}`);
  }
  checkObjectId(revocation.revokedProviderBindingCoreId, 'revokedProviderBindingCoreId', problems);
  checkObjectId(revocation.instrumentIdentityId, 'instrumentIdentityId', problems);
  checkCivilDate(revocation.effectiveFrom, 'effectiveFrom', problems);
  if (!REVOCATION_REASON_CODES.includes(/** @type {any} */ (revocation.reasonCode))) {
    problems.push('reasonCode is invalid');
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeProviderInstrumentRevocationCoreV1(value) {
  const problems = providerInstrumentRevocationCoreProblems(value);
  throwForProblems(problems, (all) => invalid('PROVIDER_INSTRUMENT_REVOCATION_INVALID', all));
  const revocation = /** @type {any} */ (value);
  return {
    schemaVersion: PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION,
    revokedProviderBindingCoreId: revocation.revokedProviderBindingCoreId,
    instrumentIdentityId: revocation.instrumentIdentityId,
    effectiveFrom: revocation.effectiveFrom,
    reasonCode: revocation.reasonCode,
  };
}

/** @param {unknown} value */
export function validateProviderInstrumentRevocationCore(value) {
  const problems = providerInstrumentRevocationCoreProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function providerInstrumentRevocationCoreId(value) {
  return canonicalHash(
    PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION,
    normalizeProviderInstrumentRevocationCoreV1(value),
  );
}

/** @param {unknown} value @returns {string[]} */
export function instrumentIdentityManifestProblems(value) {
  if (!isPlainObject(value)) return ['identity manifest must be a plain object'];
  const manifest = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(manifest, IDENTITY_MANIFEST_FIELDS, problems);
  if (manifest.schemaVersion !== INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION}`);
  }
  checkObjectId(manifest.instrumentIdentityId, 'instrumentIdentityId', problems);
  for (const field of [
    'identityRecordIds', 'descriptorCoreIds', 'aliasBindingCoreIds', 'providerBindingCoreIds',
    'aliasRevocationCoreIds', 'providerRevocationCoreIds',
  ]) {
    checkSortedUniqueObjectIdArray(manifest[field], field, problems);
  }
  checkNullableObjectId(manifest.supersedesManifestId, 'supersedesManifestId', problems);
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentIdentityManifestV1(value) {
  const problems = instrumentIdentityManifestProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_IDENTITY_MANIFEST_INVALID', all));
  const manifest = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION,
    instrumentIdentityId: manifest.instrumentIdentityId,
    identityRecordIds: sortedUniqueStrings(manifest.identityRecordIds),
    descriptorCoreIds: sortedUniqueStrings(manifest.descriptorCoreIds),
    aliasBindingCoreIds: sortedUniqueStrings(manifest.aliasBindingCoreIds),
    providerBindingCoreIds: sortedUniqueStrings(manifest.providerBindingCoreIds),
    aliasRevocationCoreIds: sortedUniqueStrings(manifest.aliasRevocationCoreIds),
    providerRevocationCoreIds: sortedUniqueStrings(manifest.providerRevocationCoreIds),
    supersedesManifestId: manifest.supersedesManifestId,
  };
}

/** @param {unknown} value */
export function validateInstrumentIdentityManifest(value) {
  const problems = instrumentIdentityManifestProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentIdentityManifestId(value) {
  return canonicalHash(INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION, normalizeInstrumentIdentityManifestV1(value));
}

/** @param {unknown} value @returns {string[]} */
export function instrumentIdentityRegistryManifestProblems(value) {
  if (!isPlainObject(value)) return ['registry manifest must be a plain object'];
  const registry = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(registry, REGISTRY_MANIFEST_FIELDS, problems);
  if (registry.schemaVersion !== INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION}`);
  }
  checkObjectId(registry.authorityPolicyId, 'authorityPolicyId', problems);
  checkSortedUniqueObjectIdArray(registry.identityManifestIds, 'identityManifestIds', problems);
  if (Array.isArray(registry.identityManifestIds) && registry.identityManifestIds.length === 0) {
    problems.push('identityManifestIds must be non-empty');
  }
  checkSortedUniqueObjectIdArray(registry.snapshotInstrumentBindingIds, 'snapshotInstrumentBindingIds', problems);
  checkNullableObjectId(registry.supersedesRegistryManifestId, 'supersedesRegistryManifestId', problems);
  return problems;
}

/** @param {unknown} value */
export function normalizeInstrumentIdentityRegistryManifestV1(value) {
  const problems = instrumentIdentityRegistryManifestProblems(value);
  throwForProblems(problems, (all) => invalid('INSTRUMENT_IDENTITY_REGISTRY_INVALID', all));
  const registry = /** @type {any} */ (value);
  return {
    schemaVersion: INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId: registry.authorityPolicyId,
    identityManifestIds: sortedUniqueStrings(registry.identityManifestIds),
    snapshotInstrumentBindingIds: sortedUniqueStrings(registry.snapshotInstrumentBindingIds),
    supersedesRegistryManifestId: registry.supersedesRegistryManifestId,
  };
}

/** @param {unknown} value */
export function validateInstrumentIdentityRegistryManifest(value) {
  const problems = instrumentIdentityRegistryManifestProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function instrumentIdentityRegistryManifestId(value) {
  return canonicalHash(
    INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
    normalizeInstrumentIdentityRegistryManifestV1(value),
  );
}

/** @param {unknown} value @returns {string[]} */
export function datasetSnapshotInstrumentBindingProblems(value) {
  if (!isPlainObject(value)) return ['snapshot instrument binding must be a plain object'];
  const binding = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(binding, SNAPSHOT_INSTRUMENT_BINDING_FIELDS, problems);
  if (binding.schemaVersion !== DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION}`);
  }
  checkObjectId(binding.snapshotCoreId, 'snapshotCoreId', problems);
  checkObjectId(binding.instrumentIdentityId, 'instrumentIdentityId', problems);
  checkObjectId(binding.aliasBindingCoreId, 'aliasBindingCoreId', problems);
  checkCivilDate(binding.resolutionDate, 'resolutionDate', problems);
  checkNonEmptyString(binding.canonicalSymbolObserved, 'canonicalSymbolObserved', problems);
  checkNonEmptyString(binding.providerId, 'providerId', problems);
  checkNonEmptyString(binding.providerSymbolObserved, 'providerSymbolObserved', problems);
  return problems;
}

/** @param {unknown} value */
export function normalizeDatasetSnapshotInstrumentBindingV1(value) {
  const problems = datasetSnapshotInstrumentBindingProblems(value);
  throwForProblems(problems, (all) => invalid('SNAPSHOT_INSTRUMENT_BINDING_INVALID', all));
  const binding = /** @type {any} */ (value);
  return {
    schemaVersion: DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
    snapshotCoreId: binding.snapshotCoreId,
    instrumentIdentityId: binding.instrumentIdentityId,
    aliasBindingCoreId: binding.aliasBindingCoreId,
    resolutionDate: binding.resolutionDate,
    canonicalSymbolObserved: binding.canonicalSymbolObserved,
    providerId: binding.providerId,
    providerSymbolObserved: binding.providerSymbolObserved,
  };
}

/** @param {unknown} value */
export function validateDatasetSnapshotInstrumentBinding(value) {
  const problems = datasetSnapshotInstrumentBindingProblems(value);
  return { valid: problems.length === 0, problems };
}

/** @param {unknown} value */
export function datasetSnapshotInstrumentBindingId(value) {
  return canonicalHash(
    DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
    normalizeDatasetSnapshotInstrumentBindingV1(value),
  );
}

/**
 * Apply venue/currency policy rules against an alias candidate.
 * @param {ReturnType<typeof normalizeSymbolNamespacePolicyV1>} policy
 * @param {{venueId: string|null, currency: string|null, providerId: string}} candidate
 * @returns {string[]}
 */
export function namespacePolicyBindingProblems(policy, candidate) {
  const problems = [];
  if (candidate.providerId !== policy.providerId) {
    problems.push('providerId does not match namespace policy providerId');
  }
  if (policy.venuePolicy === 'REQUIRED') {
    if (candidate.venueId === null || typeof candidate.venueId !== 'string' || candidate.venueId.length === 0) {
      problems.push('venueId is required by namespace policy');
    }
  } else if (policy.venuePolicy === 'NOT_APPLICABLE') {
    if (candidate.venueId !== null) problems.push('venueId must be null when venuePolicy is NOT_APPLICABLE');
  }
  if (policy.currencyPolicy === 'REQUIRED') {
    if (typeof candidate.currency !== 'string' || !ISO_4217_RE.test(candidate.currency)) {
      problems.push('currency is required by namespace policy');
    }
  } else if (policy.currencyPolicy === 'FORBIDDEN') {
    if (candidate.currency !== null) problems.push('currency must be null when currencyPolicy is FORBIDDEN');
  } else if (candidate.currency !== null && (typeof candidate.currency !== 'string' || !ISO_4217_RE.test(candidate.currency))) {
    problems.push('currency must be ISO 4217 uppercase or null');
  }
  return problems;
}

/**
 * True when setA is a subset of setB (by string id).
 * @param {string[]} setA @param {string[]} setB
 */
export function isSortedIdSubset(setA, setB) {
  const allowed = new Set(setB);
  return setA.every((id) => allowed.has(id));
}
