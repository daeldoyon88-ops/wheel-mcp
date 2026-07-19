/**
 * L2C — closed bitemporal corporate-action contracts.
 *
 * Economic values are decimal strings/rationals. Knowledge bounds are supplied
 * facts and are never derived from the local clock, ICU or a system timezone.
 */

import { createHash } from 'node:crypto';
import { canonicalHash, canonicalJsonBytes, assertValidUnicode } from '../canonical/canonicalJsonV1.mjs';
import { isStrictUtcIsoInstant } from './dailyBarV1.mjs';
import { isValidCivilDate } from '../time/civilDate.mjs';
import { SHA256_OBJECT_ID_PATTERN } from './datasetSnapshotV1.mjs';
import { isPlainObject, sortedUniqueStrings } from './contractPrimitivesV1.mjs';

export class CorporateActionError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'CorporateActionError';
    this.code = code;
    this.details = details;
  }
}

export const CA = Object.freeze({
  AUTHORITY: 'CorporateActionIdentityAuthorityPolicy/1',
  NORMALIZATION: 'CorporateActionNormalizationPolicy/1',
  TEMPORAL: 'CorporateActionTemporalPolicy/1',
  TIMEZONE: 'TimeZoneRuleset/1',
  ADJUDICATION_POLICY: 'CorporateActionAdjudicationPolicy/1',
  PRICE_POLICY: 'CorporateActionPriceAdjustmentPolicy/1',
  ENTITLEMENT_POLICY: 'CorporateActionEntitlementPolicy/1',
  IDENTITY: 'CorporateActionIdentityCore/1',
  PAYLOAD: 'CorporateActionSourcePayloadCore/1',
  ATTESTATION: 'CorporateActionSourceAttestationCore/1',
  OBSERVATION: 'CorporateActionObservationCore/1',
  OBSERVATION_RECORD: 'CorporateActionObservationRecord/1',
  PROVIDER_BINDING: 'ProviderCorporateActionBindingCore/1',
  PARTICIPANT: 'CorporateActionParticipantCore/1',
  REVISION: 'CorporateActionRevisionCore/1',
  ADJUDICATION: 'CorporateActionAdjudicationCore/1',
  EVENT_MANIFEST: 'CorporateActionEventManifest/1',
  LEDGER: 'InstrumentCorporateActionLedgerManifest/1',
  REGISTRY: 'CorporateActionRegistryManifest/1',
  PRICE_PLAN: 'CorporateActionPriceAdjustmentPlan/1',
  ENTITLEMENT_PLAN: 'CorporateActionEntitlementPlan/1',
  PLAN_MANIFEST: 'CorporateActionPlanManifest/1',
  SNAPSHOT_BINDING: 'DatasetSnapshotCorporateActionBinding/1',
  BINDING_AUTHORITY_POLICY: 'DatasetSnapshotCorporateActionBindingAuthorityPolicy/1',
  BINDING_REGISTRY: 'DatasetSnapshotCorporateActionBindingRegistryManifest/1',
});

export const CORPORATE_ACTION_SCHEMA_VERSIONS = Object.freeze(Object.values(CA));
export const EVENT_KINDS = Object.freeze([
  'FORWARD_SPLIT', 'REVERSE_SPLIT', 'STOCK_DIVIDEND',
  'CASH_DIVIDEND_ORDINARY', 'CASH_DIVIDEND_SPECIAL', 'RETURN_OF_CAPITAL',
  'SYMBOL_CHANGE', 'DELISTING', 'MERGER_CASH', 'MERGER_STOCK', 'MERGER_MIXED',
  'SPIN_OFF', 'CONVERSION',
]);
export const PARTICIPANT_ROLES = Object.freeze([
  'PRIMARY_SUBJECT', 'TARGET', 'ACQUIRER', 'PARENT', 'CHILD', 'SUCCESSOR',
  'CONVERTED_FROM', 'CONVERTED_TO', 'DISTRIBUTING_INSTRUMENT', 'RECEIVED_INSTRUMENT',
]);
export const REVISION_REASON_CODES = Object.freeze([
  'INITIAL_ASSERTION', 'ECONOMIC_CORRECTION', 'EVENT_KIND_RECLASSIFICATION',
  'CANCELLATION', 'RESTORATION',
]);
export const ADJUDICATION_DECISION_REASON_CODES = Object.freeze([
  'EVENT_KIND_RECLASSIFICATION_APPROVED', 'ECONOMIC_CORRECTION_APPROVED',
  'CANCELLATION_APPROVED', 'RESTORATION_APPROVED', 'SOURCE_CONFLICT_RESOLVED',
]);
export const TEMPORAL_PRECISIONS = Object.freeze(['UTC_INSTANT', 'DATE_ONLY']);
export const CONFIDENCE_LEVELS = Object.freeze(['CONFIRMED', 'PROVISIONAL', 'CONTESTED']);

const ID_FIELDS = ['schemaVersion', 'authorityPolicyId', 'corporateActionSeed'];
const TEMPORAL_FIELDS = [
  'temporalPrecision', 'availableOn', 'sourceTimeZone', 'timeZoneRulesetId',
  'knowledgeTimeLowerBound', 'knowledgeTimeUpperBound',
];
const EXECUTION_FIELDS = ['runnerId', 'runId', 'environment'];

function fail(code, problems) {
  throw new CorporateActionError(code, problems.join('; '), { problems });
}
function object(value, label, problems) {
  if (!isPlainObject(value)) { problems.push(`${label} must be a plain object`); return false; }
  return true;
}
function fields(value, expected, problems) {
  for (const key of expected) if (!Object.hasOwn(value, key)) problems.push(`${key} is required`);
  for (const key of Object.keys(value)) if (!expected.includes(key)) problems.push(`unknown field: ${key}`);
}
function string(value, label, problems) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    problems.push(`${label} must be a non-empty trimmed string`); return;
  }
  try { assertValidUnicode(value); } catch { problems.push(`${label} contains invalid Unicode`); }
  if (value.includes('\\') || value.includes('\0') || value.includes('://') || value.startsWith('/')
      || /^[A-Za-z]:/.test(value) || /(^|\/)\.\.?(\/|$)/.test(value)) {
    problems.push(`${label} must not contain a physical path or URL`);
  }
}
function id(value, label, problems, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) problems.push(`${label} must be a CAS object ID`);
}
function instant(value, label, problems, nullable = false) {
  if (nullable && value === null) return;
  if (!isStrictUtcIsoInstant(value)) problems.push(`${label} must be a strict UTC instant`);
}
function date(value, label, problems, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !isValidCivilDate(value)) problems.push(`${label} must be YYYY-MM-DD`);
}
function enumValue(value, allowed, label, problems) {
  if (!allowed.includes(value)) problems.push(`${label} is invalid`);
}
function ids(value, label, problems) {
  if (!Array.isArray(value)) { problems.push(`${label} must be an array`); return; }
  value.forEach((v, i) => id(v, `${label}[${i}]`, problems));
  if (new Set(value).size !== value.length || [...value].sort().some((v, i) => v !== value[i])) {
    problems.push(`${label} must be a sorted unique set`);
  }
}
function strings(value, label, allowed, problems) {
  if (!Array.isArray(value)) { problems.push(`${label} must be an array`); return; }
  value.forEach((v) => enumValue(v, allowed, label, problems));
  if (new Set(value).size !== value.length || [...value].sort().some((v, i) => v !== value[i])) {
    problems.push(`${label} must be a sorted unique set`);
  }
}
function normalizeSet(value) { return sortedUniqueStrings(value); }
function checkSchema(value, schemaVersion, expected, code) {
  const problems = [];
  if (!object(value, schemaVersion, problems)) fail(code, problems);
  fields(value, expected, problems);
  if (value.schemaVersion !== schemaVersion) problems.push(`schemaVersion must be ${schemaVersion}`);
  return problems;
}
function finish(problems, code) {
  const unknown = problems.find((p) => p.startsWith('unknown field:'));
  if (unknown) fail('CORPORATE_ACTION_INPUT_INVALID', [unknown]);
  if (problems.length) fail(code, problems);
}

export function normalizeCorporateActionIdentityAuthorityPolicyV1(value) {
  const p = checkSchema(value, CA.AUTHORITY,
    ['schemaVersion', 'authorityId', 'identityNamespaceVersion', 'eventSeedFormat', 'eventSeedLength'],
    'CORPORATE_ACTION_INPUT_INVALID');
  string(value.authorityId, 'authorityId', p); string(value.identityNamespaceVersion, 'identityNamespaceVersion', p);
  if (value.eventSeedFormat !== 'HEX_LOWERCASE') p.push('eventSeedFormat must be HEX_LOWERCASE');
  if (value.eventSeedLength !== 64) p.push('eventSeedLength must be 64');
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID');
  return { schemaVersion: CA.AUTHORITY, authorityId: value.authorityId, identityNamespaceVersion: value.identityNamespaceVersion,
    eventSeedFormat: value.eventSeedFormat, eventSeedLength: value.eventSeedLength };
}

export function normalizeCorporateActionNormalizationPolicyV1(value) {
  const p = checkSchema(value, CA.NORMALIZATION,
    ['schemaVersion', 'normalizationVersion', 'supportedEventKinds', 'currencyCodes'], 'CORPORATE_ACTION_INPUT_INVALID');
  string(value.normalizationVersion, 'normalizationVersion', p);
  strings(value.supportedEventKinds, 'supportedEventKinds', EVENT_KINDS, p);
  if (!Array.isArray(value.currencyCodes)) p.push('currencyCodes must be an array');
  else {
    for (const c of value.currencyCodes) if (typeof c !== 'string' || !/^[A-Z]{3}$/.test(c)) p.push('currencyCodes must contain ISO uppercase codes');
    if (new Set(value.currencyCodes).size !== value.currencyCodes.length || [...value.currencyCodes].sort().some((v, i) => v !== value.currencyCodes[i])) p.push('currencyCodes must be sorted unique');
  }
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID');
  return { schemaVersion: CA.NORMALIZATION, normalizationVersion: value.normalizationVersion,
    supportedEventKinds: [...value.supportedEventKinds], currencyCodes: [...value.currencyCodes] };
}

export function normalizeCorporateActionTemporalPolicyV1(value) {
  const p = checkSchema(value, CA.TEMPORAL,
    ['schemaVersion', 'temporalPolicyVersion', 'dateOnlyLowerBoundMode', 'maxRulesetDays'], 'CORPORATE_ACTION_INPUT_INVALID');
  string(value.temporalPolicyVersion, 'temporalPolicyVersion', p);
  enumValue(value.dateOnlyLowerBoundMode, ['START_UTC', 'NULL'], 'dateOnlyLowerBoundMode', p);
  if (!Number.isInteger(value.maxRulesetDays) || value.maxRulesetDays < 1 || value.maxRulesetDays > 36600) p.push('maxRulesetDays must be 1..36600');
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID');
  return { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: value.temporalPolicyVersion,
    dateOnlyLowerBoundMode: value.dateOnlyLowerBoundMode, maxRulesetDays: value.maxRulesetDays };
}

export function normalizeCorporateActionAdjudicationPolicyV1(value) {
  const p = checkSchema(value, CA.ADJUDICATION_POLICY,
    ['schemaVersion', 'adjudicationPolicyVersion', 'requireAllVisibleObservations', 'allowContested'], 'CORPORATE_ACTION_INPUT_INVALID');
  string(value.adjudicationPolicyVersion, 'adjudicationPolicyVersion', p);
  if (typeof value.requireAllVisibleObservations !== 'boolean') p.push('requireAllVisibleObservations must be boolean');
  if (typeof value.allowContested !== 'boolean') p.push('allowContested must be boolean');
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID');
  return { ...value };
}

export function normalizeCorporateActionPriceAdjustmentPolicyV1(value) {
  const p = checkSchema(value, CA.PRICE_POLICY,
    ['schemaVersion', 'policyVersion', 'supportedPriceBases'], 'CORPORATE_ACTION_INPUT_INVALID');
  string(value.policyVersion, 'policyVersion', p);
  strings(value.supportedPriceBases, 'supportedPriceBases', ['PROVIDER_ADJUSTED', 'RAW', 'SPLIT_ADJUSTED'], p);
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return { ...value, supportedPriceBases: [...value.supportedPriceBases] };
}

export function normalizeCorporateActionEntitlementPolicyV1(value) {
  const p = checkSchema(value, CA.ENTITLEMENT_POLICY,
    ['schemaVersion', 'policyVersion', 'roundingRule', 'fractionalShareRule'], 'CORPORATE_ACTION_INPUT_INVALID');
  string(value.policyVersion, 'policyVersion', p);
  enumValue(value.roundingRule, ['EXACT_ONLY'], 'roundingRule', p);
  enumValue(value.fractionalShareRule, ['FAIL_CLOSED'], 'fractionalShareRule', p);
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return { ...value };
}

export function normalizeTimeZoneRulesetV1(value) {
  const p = checkSchema(value, CA.TIMEZONE,
    ['schemaVersion', 'rulesetFormat', 'zoneId', 'validFromDate', 'validToDateExclusive', 'civilDateBounds'],
    'CORPORATE_ACTION_INPUT_INVALID');
  if (value.rulesetFormat !== 'CIVIL_DATE_UTC_BOUNDS_V1') p.push('rulesetFormat is invalid');
  string(value.zoneId, 'zoneId', p); date(value.validFromDate, 'validFromDate', p); date(value.validToDateExclusive, 'validToDateExclusive', p);
  if (!(value.validToDateExclusive > value.validFromDate)) p.push('ruleset range must be non-empty');
  if (!Array.isArray(value.civilDateBounds) || value.civilDateBounds.length === 0) p.push('civilDateBounds must be non-empty');
  else {
    let previous = null;
    for (const b of value.civilDateBounds) {
      if (!object(b, 'civilDateBound', p)) continue;
      fields(b, ['civilDate', 'startUtc', 'endUtcExclusive'], p);
      date(b.civilDate, 'civilDate', p); instant(b.startUtc, 'startUtc', p); instant(b.endUtcExclusive, 'endUtcExclusive', p);
      if (isStrictUtcIsoInstant(b.startUtc) && isStrictUtcIsoInstant(b.endUtcExclusive)) {
        const duration = Date.parse(b.endUtcExclusive) - Date.parse(b.startUtc);
        if (![23, 24, 25].includes(duration / 3600000)) p.push('civil bound duration must be 23, 24 or 25 hours');
      }
      if (previous && (b.civilDate <= previous.civilDate || b.startUtc !== previous.endUtcExclusive)) p.push('civilDateBounds must be sorted, unique and UTC-contiguous');
      previous = b;
    }
    if (value.civilDateBounds[0]?.civilDate !== value.validFromDate) p.push('ruleset must start at validFromDate');
    const last = value.civilDateBounds.at(-1);
    if (last && nextCivilDate(last.civilDate) !== value.validToDateExclusive) p.push('ruleset must cover through validToDateExclusive');
    for (let i = 1; i < value.civilDateBounds.length; i++) if (nextCivilDate(value.civilDateBounds[i - 1].civilDate) !== value.civilDateBounds[i].civilDate) p.push('civil date coverage must be contiguous');
  }
  finish(p, 'CORPORATE_ACTION_TEMPORAL_BOUNDS_INCONSISTENT');
  return { ...value, civilDateBounds: value.civilDateBounds.map((b) => ({ ...b })) };
}

function nextCivilDate(d) { const x = new Date(`${d}T00:00:00.000Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

export function temporalProblems(value) {
  const p = [];
  enumValue(value.temporalPrecision, TEMPORAL_PRECISIONS, 'temporalPrecision', p);
  instant(value.knowledgeTimeUpperBound, 'knowledgeTimeUpperBound', p);
  if (value.temporalPrecision === 'UTC_INSTANT') {
    if (value.availableOn !== null || value.sourceTimeZone !== null || value.timeZoneRulesetId !== null) p.push('UTC_INSTANT date-only fields must be null');
    instant(value.knowledgeTimeLowerBound, 'knowledgeTimeLowerBound', p);
    if (value.knowledgeTimeLowerBound !== value.knowledgeTimeUpperBound) p.push('UTC_INSTANT bounds must be equal');
  } else if (value.temporalPrecision === 'DATE_ONLY') {
    date(value.availableOn, 'availableOn', p); string(value.sourceTimeZone, 'sourceTimeZone', p);
    id(value.timeZoneRulesetId, 'timeZoneRulesetId', p); instant(value.knowledgeTimeLowerBound, 'knowledgeTimeLowerBound', p, true);
  }
  return p;
}
function temporalCopy(value) { return Object.fromEntries(TEMPORAL_FIELDS.map((k) => [k, value[k]])); }

export function normalizeCorporateActionIdentityCoreV1(value) {
  const p = checkSchema(value, CA.IDENTITY, ID_FIELDS, 'CORPORATE_ACTION_INPUT_INVALID');
  id(value.authorityPolicyId, 'authorityPolicyId', p);
  if (typeof value.corporateActionSeed !== 'string' || !/^[0-9a-f]{64}$/.test(value.corporateActionSeed)) p.push('corporateActionSeed must be exactly 64 lowercase hex characters');
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return { schemaVersion: CA.IDENTITY, authorityPolicyId: value.authorityPolicyId, corporateActionSeed: value.corporateActionSeed };
}

export function normalizeCorporateActionSourcePayloadCoreV1(value) {
  const p = checkSchema(value, CA.PAYLOAD,
    ['schemaVersion', 'provenanceMode', 'payloadFormat', 'mediaType', 'payloadValue', 'payloadDigest', 'payloadByteLength'],
    'CORPORATE_ACTION_PROVENANCE_MODE_INVALID');
  if (value.provenanceMode !== 'EMBEDDED_CANONICAL_PAYLOAD') p.push('provenanceMode must be EMBEDDED_CANONICAL_PAYLOAD');
  enumValue(value.payloadFormat, ['CANONICAL_JSON', 'UTF8_TEXT'], 'payloadFormat', p); string(value.mediaType, 'mediaType', p);
  if (value.payloadFormat === 'UTF8_TEXT') string(value.payloadValue, 'payloadValue', p);
  else if (value.payloadValue === undefined) p.push('payloadValue is required');
  if (typeof value.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.payloadDigest)) p.push('payloadDigest must be lowercase SHA256');
  if (!Number.isInteger(value.payloadByteLength) || value.payloadByteLength < 0 || value.payloadByteLength > 1048576) p.push('payloadByteLength is invalid');
  finish(p, 'CORPORATE_ACTION_PROVENANCE_MODE_INVALID');
  const payloadValue = value.payloadFormat === 'CANONICAL_JSON' ? normalizeJson(value.payloadValue, 'payloadValue') : value.payloadValue;
  const bytes = value.payloadFormat === 'CANONICAL_JSON' ? canonicalJsonBytes(payloadValue) : Buffer.from(payloadValue, 'utf8');
  if (bytes.length > 1048576 || bytes.length !== value.payloadByteLength || createHash('sha256').update(bytes).digest('hex') !== value.payloadDigest) fail('CORPORATE_ACTION_PROVENANCE_MODE_INVALID', ['payload digest or byte length mismatch']);
  forbidSecret(bytes.toString('utf8'));
  return { ...value, payloadValue };
}

/**
 * Best-effort known-pattern screening of embedded payload text.
 * This is not a cryptographic or exhaustive proof that an arbitrary payload
 * contains no sensitive information. Structured contract fields separately
 * forbid paths, signed URLs, auth headers, cookies and tokens.
 */
function forbidSecret(text) {
  if (/\uFEFF|authorization\s*:|bearer\s+[A-Za-z0-9._-]+|api[_-]?key|secret\s*[=:]|https?:\/\/[^\s]*[?&](token|signature|key)=|[A-Za-z]:\\|\/Users\//i.test(text)) {
    fail('CORPORATE_ACTION_PROVENANCE_SECRET_FORBIDDEN', ['payload matches a known sensitive pattern (best-effort screening)']);
  }
}
function normalizeJson(value, label) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { try { assertValidUnicode(value); } catch { fail('CORPORATE_ACTION_INPUT_INVALID', [`${label} invalid Unicode`]); } return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail('CORPORATE_ACTION_INPUT_INVALID', [`${label} numbers must be safe integers`]); return Object.is(value, -0) ? 0 : value; }
  if (Array.isArray(value)) return value.map((v, i) => normalizeJson(v, `${label}[${i}]`));
  if (!isPlainObject(value)) fail('CORPORATE_ACTION_INPUT_INVALID', [`${label} must be canonical JSON`]);
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalizeJson(value[k], `${label}.${k}`)]));
}

export function normalizeCorporateActionSourceAttestationCoreV1(value) {
  const expected = ['schemaVersion', 'provenanceMode', 'embeddedPayloadId', 'digestAlgorithm', 'payloadDigest', 'payloadByteLength', 'sourceKind', 'providerId', 'observedAt', ...TEMPORAL_FIELDS];
  const p = checkSchema(value, CA.ATTESTATION, expected, 'CORPORATE_ACTION_PROVENANCE_MODE_INVALID');
  enumValue(value.provenanceMode, ['EMBEDDED_CANONICAL_PAYLOAD', 'DIGEST_ONLY_ATTESTATION'], 'provenanceMode', p);
  if (value.provenanceMode === 'EMBEDDED_CANONICAL_PAYLOAD') {
    id(value.embeddedPayloadId, 'embeddedPayloadId', p);
    for (const k of ['digestAlgorithm', 'payloadDigest', 'payloadByteLength', 'sourceKind', 'providerId']) if (value[k] !== null) p.push(`${k} must be null in embedded mode`);
  } else {
    if (value.embeddedPayloadId !== null) p.push('embeddedPayloadId must be null in digest-only mode');
    if (value.digestAlgorithm !== 'SHA256' || typeof value.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.payloadDigest)) p.push('digest-only SHA256 fields are invalid');
    if (!Number.isInteger(value.payloadByteLength) || value.payloadByteLength < 0) p.push('payloadByteLength is invalid');
    string(value.sourceKind, 'sourceKind', p); string(value.providerId, 'providerId', p);
  }
  instant(value.observedAt, 'observedAt', p); p.push(...temporalProblems(value));
  finish(p, 'CORPORATE_ACTION_PROVENANCE_MODE_INVALID'); return { ...value };
}

function ratioProblems(value, label, p) {
  if (!object(value, label, p)) return;
  fields(value, ['numerator', 'denominator'], p);
  for (const k of ['numerator', 'denominator']) if (typeof value[k] !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value[k])) p.push(`${label}.${k} is invalid`);
  if (/^[1-9][0-9]{0,77}$/.test(value.numerator ?? '') && /^[1-9][0-9]{0,77}$/.test(value.denominator ?? '')) {
    if (gcd(BigInt(value.numerator), BigInt(value.denominator)) !== 1n) p.push(`${label} must be reduced`);
  }
}
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function amountProblems(value, label, p, currencies = null) {
  if (!object(value, label, p)) return;
  fields(value, ['amountAtoms', 'scale', 'currency'], p);
  if (typeof value.amountAtoms !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value.amountAtoms)) p.push(`${label}.amountAtoms is invalid`);
  if (!Number.isInteger(value.scale) || value.scale < 0 || value.scale > 18) p.push(`${label}.scale is invalid`);
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || (currencies && !currencies.includes(value.currency))) p.push(`${label}.currency is invalid`);
}
function economicPayloadProblems(value, eventKind, p) {
  if (!object(value, 'economicPayload', p)) return;
  if (eventKind === 'SYMBOL_CHANGE') {
    fields(value, ['effectiveDate', 'previousAliasBindingCoreId', 'nextAliasBindingCoreId'], p);
    date(value.effectiveDate, 'effectiveDate', p);
    id(value.previousAliasBindingCoreId, 'previousAliasBindingCoreId', p);
    id(value.nextAliasBindingCoreId, 'nextAliasBindingCoreId', p);
    if (value.previousAliasBindingCoreId === value.nextAliasBindingCoreId) {
      p.push('SYMBOL_CHANGE aliases must be distinct');
    }
    return;
  }
  fields(value, ['effectiveDate', 'ratio', 'cashAmount'], p); date(value.effectiveDate, 'effectiveDate', p);
  const ratioKinds = ['FORWARD_SPLIT', 'REVERSE_SPLIT', 'STOCK_DIVIDEND', 'MERGER_STOCK', 'MERGER_MIXED', 'SPIN_OFF', 'CONVERSION'];
  const cashKinds = ['CASH_DIVIDEND_ORDINARY', 'CASH_DIVIDEND_SPECIAL', 'RETURN_OF_CAPITAL', 'MERGER_CASH', 'MERGER_MIXED'];
  if (ratioKinds.includes(eventKind)) ratioProblems(value.ratio, 'ratio', p); else if (value.ratio !== null) p.push('ratio must be null for eventKind');
  if (cashKinds.includes(eventKind)) amountProblems(value.cashAmount, 'cashAmount', p); else if (value.cashAmount !== null) p.push('cashAmount must be null for eventKind');
}

export function normalizeCorporateActionObservationCoreV1(value) {
  const expected = ['schemaVersion', 'corporateActionIdentityId', 'normalizationPolicyId', 'sourceAttestationId', 'claim', ...TEMPORAL_FIELDS];
  const p = checkSchema(value, CA.OBSERVATION, expected, 'CORPORATE_ACTION_INPUT_INVALID');
  id(value.corporateActionIdentityId, 'corporateActionIdentityId', p); id(value.normalizationPolicyId, 'normalizationPolicyId', p); id(value.sourceAttestationId, 'sourceAttestationId', p, true);
  if (object(value.claim, 'claim', p)) { fields(value.claim, ['eventKind', 'economicPayload'], p); enumValue(value.claim.eventKind, EVENT_KINDS, 'eventKind', p); economicPayloadProblems(value.claim.economicPayload, value.claim.eventKind, p); }
  p.push(...temporalProblems(value)); finish(p, 'CORPORATE_ACTION_INPUT_INVALID');
  return { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: value.corporateActionIdentityId, normalizationPolicyId: value.normalizationPolicyId,
    sourceAttestationId: value.sourceAttestationId, claim: { eventKind: value.claim.eventKind, economicPayload: cloneEconomic(value.claim.economicPayload, value.claim.eventKind) }, ...temporalCopy(value) };
}
function cloneEconomic(v, eventKind) {
  if (eventKind === 'SYMBOL_CHANGE') {
    return {
      effectiveDate: v.effectiveDate,
      previousAliasBindingCoreId: v.previousAliasBindingCoreId,
      nextAliasBindingCoreId: v.nextAliasBindingCoreId,
    };
  }
  return {
    effectiveDate: v.effectiveDate,
    ratio: v.ratio === null ? null : { ...v.ratio },
    cashAmount: v.cashAmount === null ? null : { ...v.cashAmount },
  };
}

export function normalizeCorporateActionObservationRecordV1(value) {
  const p = checkSchema(value, CA.OBSERVATION_RECORD, ['schemaVersion', 'observationCoreId', 'observedAt', 'executionIdentity'], 'CORPORATE_ACTION_INPUT_INVALID');
  id(value.observationCoreId, 'observationCoreId', p); instant(value.observedAt, 'observedAt', p);
  if (object(value.executionIdentity, 'executionIdentity', p)) {
    fields(value.executionIdentity, EXECUTION_FIELDS, p); string(value.executionIdentity.runnerId, 'runnerId', p);
    if (value.executionIdentity.runId !== null) string(value.executionIdentity.runId, 'runId', p);
    enumValue(value.executionIdentity.environment, ['CI', 'LOCAL_MANUAL', 'LOCAL_TEST'], 'environment', p);
  }
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return { ...value, executionIdentity: { ...value.executionIdentity } };
}

export function normalizeProviderCorporateActionBindingCoreV1(value) {
  const p = checkSchema(value, CA.PROVIDER_BINDING,
    ['schemaVersion', 'providerId', 'providerEventId', 'corporateActionIdentityId', 'validFrom', 'validToExclusive'], 'CORPORATE_ACTION_INPUT_INVALID');
  string(value.providerId, 'providerId', p); string(value.providerEventId, 'providerEventId', p); id(value.corporateActionIdentityId, 'corporateActionIdentityId', p);
  instant(value.validFrom, 'validFrom', p); instant(value.validToExclusive, 'validToExclusive', p, true);
  if (value.validToExclusive !== null && value.validToExclusive <= value.validFrom) p.push('binding interval must be non-empty');
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return { ...value };
}

export function normalizeCorporateActionParticipantCoreV1(value) {
  const p = checkSchema(value, CA.PARTICIPANT,
    ['schemaVersion', 'corporateActionIdentityId', 'instrumentIdentityId', 'participantRole', 'validFrom', 'validToExclusive'], 'CORPORATE_ACTION_PARTICIPANT_INVALID');
  id(value.corporateActionIdentityId, 'corporateActionIdentityId', p); id(value.instrumentIdentityId, 'instrumentIdentityId', p);
  enumValue(value.participantRole, PARTICIPANT_ROLES, 'participantRole', p); instant(value.validFrom, 'validFrom', p); instant(value.validToExclusive, 'validToExclusive', p, true);
  if (value.validToExclusive !== null && value.validToExclusive <= value.validFrom) p.push('participant interval must be non-empty');
  finish(p, 'CORPORATE_ACTION_PARTICIPANT_INVALID'); return { ...value };
}

export function normalizeCorporateActionRevisionCoreV1(value) {
  const expected = ['schemaVersion', 'corporateActionIdentityId', 'eventKind', 'economicPayload', 'participantCoreIds', 'revisionDisposition', 'revisionReasonCode', 'supersedesRevisionId', ...TEMPORAL_FIELDS];
  const p = checkSchema(value, CA.REVISION, expected, 'CORPORATE_ACTION_INPUT_INVALID');
  id(value.corporateActionIdentityId, 'corporateActionIdentityId', p); enumValue(value.eventKind, EVENT_KINDS, 'eventKind', p);
  economicPayloadProblems(value.economicPayload, value.eventKind, p); ids(value.participantCoreIds, 'participantCoreIds', p);
  enumValue(value.revisionDisposition, ['ASSERTED', 'CANCELS_EVENT'], 'revisionDisposition', p);
  enumValue(value.revisionReasonCode, REVISION_REASON_CODES, 'revisionReasonCode', p);
  id(value.supersedesRevisionId, 'supersedesRevisionId', p, true);
  p.push(...temporalProblems(value)); finish(p, 'CORPORATE_ACTION_INPUT_INVALID');
  return { ...value, economicPayload: cloneEconomic(value.economicPayload, value.eventKind), participantCoreIds: [...value.participantCoreIds] };
}

export function normalizeCorporateActionAdjudicationCoreV1(value) {
  const expected = ['schemaVersion', 'corporateActionIdentityId', 'selectedRevisionId', 'adjudicationPolicyId', 'confidence', 'decisionReasonCodes', 'consideredObservationIds', 'acceptedObservationIds', 'rejectedObservationIds', 'conflictObservationIds', 'supersedesAdjudicationId', ...TEMPORAL_FIELDS];
  const p = checkSchema(value, CA.ADJUDICATION, expected, 'CORPORATE_ACTION_INPUT_INVALID');
  id(value.corporateActionIdentityId, 'corporateActionIdentityId', p); id(value.selectedRevisionId, 'selectedRevisionId', p); id(value.adjudicationPolicyId, 'adjudicationPolicyId', p);
  enumValue(value.confidence, CONFIDENCE_LEVELS, 'confidence', p);
  strings(value.decisionReasonCodes, 'decisionReasonCodes', ADJUDICATION_DECISION_REASON_CODES, p);
  for (const k of ['consideredObservationIds', 'acceptedObservationIds', 'rejectedObservationIds', 'conflictObservationIds']) ids(value[k], k, p);
  id(value.supersedesAdjudicationId, 'supersedesAdjudicationId', p, true); p.push(...temporalProblems(value));
  if (Array.isArray(value.consideredObservationIds)) {
    const partitions = [...(value.acceptedObservationIds ?? []), ...(value.rejectedObservationIds ?? []), ...(value.conflictObservationIds ?? [])];
    if (new Set(partitions).size !== partitions.length || normalizeSet(partitions).join('|') !== value.consideredObservationIds.join('|')) p.push('observation classification must exactly partition consideredObservationIds');
  }
  finish(p, 'CORPORATE_ACTION_ADJUDICATION_PARTITION_INVALID'); return { ...value,
    decisionReasonCodes: [...value.decisionReasonCodes],
    consideredObservationIds: [...value.consideredObservationIds], acceptedObservationIds: [...value.acceptedObservationIds], rejectedObservationIds: [...value.rejectedObservationIds], conflictObservationIds: [...value.conflictObservationIds] };
}

function normalizeManifest(value, schema, scalarFields, setFields, nullableIdField, code) {
  const expected = ['schemaVersion', ...scalarFields, ...setFields, nullableIdField];
  const p = checkSchema(value, schema, expected, code);
  for (const k of scalarFields) id(value[k], k, p);
  for (const k of setFields) ids(value[k], k, p);
  id(value[nullableIdField], nullableIdField, p, true); finish(p, code);
  const out = { schemaVersion: schema };
  for (const k of scalarFields) out[k] = value[k];
  for (const k of setFields) out[k] = [...value[k]];
  out[nullableIdField] = value[nullableIdField]; return out;
}

export function normalizeCorporateActionEventManifestV1(value) {
  return normalizeManifest(value, CA.EVENT_MANIFEST, ['corporateActionIdentityId'],
    ['observationCoreIds', 'observationRecordIds', 'sourcePayloadIds', 'sourceAttestationIds', 'providerBindingCoreIds', 'participantCoreIds', 'revisionCoreIds', 'adjudicationCoreIds'],
    'supersedesEventManifestId', 'CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION');
}
export function normalizeInstrumentCorporateActionLedgerManifestV1(value) {
  return normalizeManifest(value, CA.LEDGER, ['instrumentIdentityId'], ['eventManifestIds'], 'supersedesLedgerManifestId', 'CORPORATE_ACTION_LEDGER_APPEND_ONLY_VIOLATION');
}

export function normalizeCorporateActionRegistryManifestV1(value) {
  return normalizeManifest(value, CA.REGISTRY,
    ['authorityPolicyId', 'normalizationPolicyId', 'temporalPolicyId', 'adjudicationPolicyId', 'priceAdjustmentPolicyId', 'entitlementPolicyId', 'instrumentIdentityRegistryManifestId'],
    ['instrumentLedgerManifestIds'], 'supersedesRegistryManifestId', 'CORPORATE_ACTION_REGISTRY_APPEND_ONLY_VIOLATION');
}

function economicRange(value, p, nullable = false) {
  if (nullable && value === null) return;
  if (!object(value, 'economicRange', p)) return; fields(value, ['fromDate', 'toDateExclusive'], p);
  date(value.fromDate, 'fromDate', p); date(value.toDateExclusive, 'toDateExclusive', p);
  if (value.toDateExclusive <= value.fromDate) p.push('economicRange must be non-empty');
}
function ratioArray(value, label, p) {
  if (!Array.isArray(value)) { p.push(`${label} must be an array`); return; }
  for (const x of value) {
    if (!object(x, label, p)) continue;
    fields(x, ['corporateActionIdentityId', 'effectiveDate', 'ohlcFactor', 'volumeFactor', 'sharesFactor'], p);
    id(x.corporateActionIdentityId, 'corporateActionIdentityId', p); date(x.effectiveDate, 'effectiveDate', p);
    ratioProblems(x.ohlcFactor, 'ohlcFactor', p); ratioProblems(x.volumeFactor, 'volumeFactor', p); ratioProblems(x.sharesFactor, 'sharesFactor', p);
  }
}

export function normalizeCorporateActionPriceAdjustmentPlanV1(value) {
  const p = checkSchema(value, CA.PRICE_PLAN,
    ['schemaVersion', 'registryManifestId', 'priceAdjustmentPolicyId', 'knowledgeCutoff', 'instrumentIdentityId', 'economicRange', 'priceBasis', 'providerAdjustmentDeclaration', 'adjustments', 'influencingEventIds'],
    'CORPORATE_ACTION_INPUT_INVALID');
  id(value.registryManifestId, 'registryManifestId', p); id(value.priceAdjustmentPolicyId, 'priceAdjustmentPolicyId', p); instant(value.knowledgeCutoff, 'knowledgeCutoff', p);
  id(value.instrumentIdentityId, 'instrumentIdentityId', p, true); economicRange(value.economicRange, p, true);
  enumValue(value.priceBasis, ['PROVIDER_ADJUSTED', 'RAW', 'SPLIT_ADJUSTED'], 'priceBasis', p); ids(value.influencingEventIds, 'influencingEventIds', p); ratioArray(value.adjustments, 'adjustments', p);
  if (value.priceBasis === 'PROVIDER_ADJUSTED') {
    const d = value.providerAdjustmentDeclaration;
    if (object(d, 'providerAdjustmentDeclaration', p)) {
      fields(d, ['providerId', 'splitsIncluded', 'dividendsIncluded', 'volumeAdjusted', 'retroactiveCorrectionsPossible', 'providerCutoff', 'providerPolicyId'], p);
      string(d.providerId, 'providerId', p); for (const k of ['splitsIncluded', 'dividendsIncluded', 'volumeAdjusted', 'retroactiveCorrectionsPossible']) if (typeof d[k] !== 'boolean') p.push(`${k} must be boolean`);
      instant(d.providerCutoff, 'providerCutoff', p); id(d.providerPolicyId, 'providerPolicyId', p);
    }
  } else if (value.providerAdjustmentDeclaration !== null) p.push('providerAdjustmentDeclaration must be null');
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return structuredClone(value);
}

export function normalizeCorporateActionEntitlementPlanV1(value) {
  const p = checkSchema(value, CA.ENTITLEMENT_PLAN,
    ['schemaVersion', 'registryManifestId', 'entitlementPolicyId', 'knowledgeCutoff', 'instrumentIdentityId', 'economicRange', 'entitlements', 'influencingEventIds'], 'CORPORATE_ACTION_INPUT_INVALID');
  id(value.registryManifestId, 'registryManifestId', p); id(value.entitlementPolicyId, 'entitlementPolicyId', p); instant(value.knowledgeCutoff, 'knowledgeCutoff', p);
  id(value.instrumentIdentityId, 'instrumentIdentityId', p, true); economicRange(value.economicRange, p, true); ids(value.influencingEventIds, 'influencingEventIds', p);
  if (!Array.isArray(value.entitlements)) p.push('entitlements must be an array');
  else for (const e of value.entitlements) {
    if (!object(e, 'entitlement', p)) continue; fields(e, ['corporateActionIdentityId', 'effectiveDate', 'entitlementKind', 'ratio', 'cashAmount'], p);
    id(e.corporateActionIdentityId, 'corporateActionIdentityId', p); date(e.effectiveDate, 'effectiveDate', p);
    enumValue(e.entitlementKind, ['CASH', 'QUANTITY'], 'entitlementKind', p);
    if (e.entitlementKind === 'CASH') { amountProblems(e.cashAmount, 'cashAmount', p); if (e.ratio !== null) p.push('cash entitlement ratio must be null'); }
    else { ratioProblems(e.ratio, 'ratio', p); if (e.cashAmount !== null) p.push('quantity entitlement cashAmount must be null'); }
  }
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return structuredClone(value);
}

export function normalizeCorporateActionPlanManifestV1(value) {
  const expected = ['schemaVersion', 'registryManifestId', 'knowledgeCutoff', 'priceAdjustmentPlanIds', 'entitlementPlanIds', 'supersedesPlanManifestId'];
  const p = checkSchema(value, CA.PLAN_MANIFEST, expected, 'CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION');
  id(value.registryManifestId, 'registryManifestId', p); instant(value.knowledgeCutoff, 'knowledgeCutoff', p); ids(value.priceAdjustmentPlanIds, 'priceAdjustmentPlanIds', p); ids(value.entitlementPlanIds, 'entitlementPlanIds', p); id(value.supersedesPlanManifestId, 'supersedesPlanManifestId', p, true);
  finish(p, 'CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION'); return { ...value, priceAdjustmentPlanIds: [...value.priceAdjustmentPlanIds], entitlementPlanIds: [...value.entitlementPlanIds] };
}

export function normalizeDatasetSnapshotCorporateActionBindingV1(value) {
  const p = checkSchema(value, CA.SNAPSHOT_BINDING,
    ['schemaVersion', 'snapshotCoreId', 'registryManifestId', 'priceAdjustmentPlanId', 'entitlementPlanId', 'knowledgeCutoff', 'influencingEventIds'], 'CORPORATE_ACTION_INPUT_INVALID');
  for (const k of ['snapshotCoreId', 'registryManifestId']) id(value[k], k, p);
  id(value.priceAdjustmentPlanId, 'priceAdjustmentPlanId', p, true); id(value.entitlementPlanId, 'entitlementPlanId', p, true); instant(value.knowledgeCutoff, 'knowledgeCutoff', p); ids(value.influencingEventIds, 'influencingEventIds', p);
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID'); return { ...value, influencingEventIds: [...value.influencingEventIds] };
}

export function normalizeDatasetSnapshotCorporateActionBindingAuthorityPolicyV1(value) {
  const p = checkSchema(value, CA.BINDING_AUTHORITY_POLICY,
    ['schemaVersion', 'authorityId', 'registryNamespaceVersion'], 'CORPORATE_ACTION_INPUT_INVALID');
  string(value.authorityId, 'authorityId', p);
  string(value.registryNamespaceVersion, 'registryNamespaceVersion', p);
  finish(p, 'CORPORATE_ACTION_INPUT_INVALID');
  return {
    schemaVersion: CA.BINDING_AUTHORITY_POLICY,
    authorityId: value.authorityId,
    registryNamespaceVersion: value.registryNamespaceVersion,
  };
}

export function normalizeDatasetSnapshotCorporateActionBindingRegistryManifestV1(value) {
  return normalizeManifest(value, CA.BINDING_REGISTRY, ['bindingAuthorityPolicyId'], ['bindingIds'],
    'supersedesBindingRegistryManifestId', 'CORPORATE_ACTION_BINDING_REGISTRY_APPEND_ONLY_VIOLATION');
}

export const CORPORATE_ACTION_SCHEMA_NORMALIZERS = Object.freeze(new Map([
  [CA.AUTHORITY, normalizeCorporateActionIdentityAuthorityPolicyV1],
  [CA.NORMALIZATION, normalizeCorporateActionNormalizationPolicyV1],
  [CA.TEMPORAL, normalizeCorporateActionTemporalPolicyV1],
  [CA.TIMEZONE, normalizeTimeZoneRulesetV1],
  [CA.ADJUDICATION_POLICY, normalizeCorporateActionAdjudicationPolicyV1],
  [CA.PRICE_POLICY, normalizeCorporateActionPriceAdjustmentPolicyV1],
  [CA.ENTITLEMENT_POLICY, normalizeCorporateActionEntitlementPolicyV1],
  [CA.IDENTITY, normalizeCorporateActionIdentityCoreV1],
  [CA.PAYLOAD, normalizeCorporateActionSourcePayloadCoreV1],
  [CA.ATTESTATION, normalizeCorporateActionSourceAttestationCoreV1],
  [CA.OBSERVATION, normalizeCorporateActionObservationCoreV1],
  [CA.OBSERVATION_RECORD, normalizeCorporateActionObservationRecordV1],
  [CA.PROVIDER_BINDING, normalizeProviderCorporateActionBindingCoreV1],
  [CA.PARTICIPANT, normalizeCorporateActionParticipantCoreV1],
  [CA.REVISION, normalizeCorporateActionRevisionCoreV1],
  [CA.ADJUDICATION, normalizeCorporateActionAdjudicationCoreV1],
  [CA.EVENT_MANIFEST, normalizeCorporateActionEventManifestV1],
  [CA.LEDGER, normalizeInstrumentCorporateActionLedgerManifestV1],
  [CA.REGISTRY, normalizeCorporateActionRegistryManifestV1],
  [CA.PRICE_PLAN, normalizeCorporateActionPriceAdjustmentPlanV1],
  [CA.ENTITLEMENT_PLAN, normalizeCorporateActionEntitlementPlanV1],
  [CA.PLAN_MANIFEST, normalizeCorporateActionPlanManifestV1],
  [CA.SNAPSHOT_BINDING, normalizeDatasetSnapshotCorporateActionBindingV1],
  [CA.BINDING_AUTHORITY_POLICY, normalizeDatasetSnapshotCorporateActionBindingAuthorityPolicyV1],
  [CA.BINDING_REGISTRY, normalizeDatasetSnapshotCorporateActionBindingRegistryManifestV1],
]));

export function normalizeCorporateActionCanonicalValue(schemaVersion, value) {
  const normalize = CORPORATE_ACTION_SCHEMA_NORMALIZERS.get(schemaVersion);
  if (!normalize) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `unknown corporate-action schema: ${String(schemaVersion)}`);
  return normalize(value);
}
export function corporateActionObjectId(schemaVersion, value) {
  return canonicalHash(schemaVersion, normalizeCorporateActionCanonicalValue(schemaVersion, value));
}
export function isSortedIdSubset(a, b) { return a.every((x) => b.includes(x)); }
export function intervalsOverlap(aFrom, aTo, bFrom, bTo) { return aFrom < (bTo ?? '\uffff') && bFrom < (aTo ?? '\uffff'); }
