/** Historical multi-year XNYS market-calendar contracts. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertCivilDate,
  assertEnum,
  assertExactFields,
  assertNonEmptyString,
  assertPlainObject,
  assertSchemaVersion,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from './marketDataL3CommonV1.mjs';

export const MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION = 'MarketCalendarAuthorityPolicy/2';
export const MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION = 'MarketSessionCalendarCore/2';
export const MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION = 'MarketCalendarRegistryManifest/2';
export const MARKET_CALENDAR_L3_V2_SCHEMA_VERSIONS = Object.freeze([
  MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION,
  MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION,
  MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION,
]);

const VENUES = Object.freeze(['ARCX', 'XNAS', 'XNYS']);
const SESSION_KINDS = Object.freeze(['HALF_DAY_SESSION', 'REGULAR_SESSION']);
const POLICY_FIELDS = Object.freeze([
  'schemaVersion', 'calendarNamespaceVersion', 'venueId', 'zoneId', 'rulesetFormat',
  'allowedSessionKinds', 'yearlyRulesets',
]);
const YEARLY_RULESET_FIELDS = Object.freeze(['calendarYear', 'zoneId', 'rulesetFormat', 'timeZoneRulesetId']);
const CORE_FIELDS = Object.freeze([
  'schemaVersion', 'calendarAuthorityPolicyId', 'venueId', 'timeZoneRulesetId',
  'coverageFromDate', 'coverageToDateExclusive', 'sessions',
]);
const SESSION_FIELDS = Object.freeze(['sessionDate', 'sessionKind', 'openUtc', 'closeUtc', 'marketValidTime']);
const REGISTRY_FIELDS = Object.freeze([
  'schemaVersion', 'calendarAuthorityPolicyId', 'calendarCoreIds', 'supersedesCalendarRegistryManifestId',
]);

function fail(code, message, details = {}) {
  throw new MarketDataL3Error(code, message, details);
}

function canonicalEnumSet(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) fail('MARKET_DATA_INPUT_INVALID', `${label} must be non-empty`);
  for (const item of value) assertEnum(item, allowed, label);
  if (new Set(value).size !== value.length) fail('MARKET_DATA_INPUT_INVALID', `${label} must be unique`);
  return [...value].sort();
}

function canonicalIdList(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail('MARKET_DATA_INPUT_INVALID', `${label} must be non-empty`);
  value.forEach((id, index) => assertCasId(id, `${label}[${index}]`));
  if (new Set(value).size !== value.length) fail('MARKET_DATA_INPUT_INVALID', `${label} must be unique`);
  return [...value];
}

function assertIntegerYear(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 9999) fail('MARKET_DATA_INPUT_INVALID', `${label} must be an integer year`);
}

export function normalizeMarketCalendarAuthorityPolicyV2(value) {
  const policy = assertPlainObject(value, MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION);
  assertExactFields(policy, POLICY_FIELDS);
  assertNonEmptyString(policy.calendarNamespaceVersion, 'calendarNamespaceVersion');
  assertEnum(policy.venueId, VENUES, 'venueId');
  assertNonEmptyString(policy.zoneId, 'zoneId');
  if (policy.rulesetFormat !== 'CIVIL_DATE_UTC_BOUNDS_V1') fail('MARKET_DATA_INPUT_INVALID', 'rulesetFormat is invalid');
  const allowedSessionKinds = canonicalEnumSet(policy.allowedSessionKinds, SESSION_KINDS, 'allowedSessionKinds');
  if (!Array.isArray(policy.yearlyRulesets) || policy.yearlyRulesets.length === 0) {
    fail('MARKET_DATA_INPUT_INVALID', 'yearlyRulesets must be non-empty');
  }
  let previous = 0;
  const yearlyRulesets = policy.yearlyRulesets.map((raw, index) => {
    const entry = assertPlainObject(raw, `yearlyRulesets[${index}]`);
    assertExactFields(entry, YEARLY_RULESET_FIELDS);
    assertIntegerYear(entry.calendarYear, `yearlyRulesets[${index}].calendarYear`);
    assertNonEmptyString(entry.zoneId, `yearlyRulesets[${index}].zoneId`);
    assertNonEmptyString(entry.rulesetFormat, `yearlyRulesets[${index}].rulesetFormat`);
    assertCasId(entry.timeZoneRulesetId, `yearlyRulesets[${index}].timeZoneRulesetId`);
    if (entry.calendarYear <= previous) fail('MARKET_DATA_INPUT_INVALID', 'yearlyRulesets must be strictly ascending');
    if (entry.zoneId !== policy.zoneId || entry.rulesetFormat !== policy.rulesetFormat) {
      fail('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'yearly ruleset stitch mismatch');
    }
    previous = entry.calendarYear;
    return { calendarYear: entry.calendarYear, zoneId: entry.zoneId, rulesetFormat: entry.rulesetFormat, timeZoneRulesetId: entry.timeZoneRulesetId };
  });
  return {
    schemaVersion: MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION,
    calendarNamespaceVersion: policy.calendarNamespaceVersion,
    venueId: policy.venueId,
    zoneId: policy.zoneId,
    rulesetFormat: policy.rulesetFormat,
    allowedSessionKinds,
    yearlyRulesets,
  };
}

export function normalizeMarketSessionCalendarCoreV2(value) {
  const core = assertPlainObject(value, MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION);
  assertSchemaVersion(core, MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION);
  assertExactFields(core, CORE_FIELDS);
  assertCasId(core.calendarAuthorityPolicyId, 'calendarAuthorityPolicyId');
  assertEnum(core.venueId, VENUES, 'venueId');
  assertCasId(core.timeZoneRulesetId, 'timeZoneRulesetId');
  assertCivilDate(core.coverageFromDate, 'coverageFromDate');
  assertCivilDate(core.coverageToDateExclusive, 'coverageToDateExclusive');
  if (core.coverageFromDate >= core.coverageToDateExclusive) fail('MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE', 'calendar coverage must be non-empty');
  if (!Array.isArray(core.sessions)) fail('MARKET_DATA_INPUT_INVALID', 'sessions must be an array');
  let previous = null;
  const sessions = core.sessions.map((raw, index) => {
    const session = assertPlainObject(raw, `sessions[${index}]`);
    assertExactFields(session, SESSION_FIELDS);
    assertCivilDate(session.sessionDate, `sessions[${index}].sessionDate`);
    assertEnum(session.sessionKind, SESSION_KINDS, `sessions[${index}].sessionKind`);
    for (const field of ['openUtc', 'closeUtc', 'marketValidTime']) {
      if (typeof session[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(session[field])) {
        fail('MARKET_DATA_INPUT_INVALID', `${field} must be a strict UTC instant`);
      }
    }
    if (session.sessionDate < core.coverageFromDate || session.sessionDate >= core.coverageToDateExclusive) fail('MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE', 'session outside core coverage');
    if (session.openUtc >= session.closeUtc) fail('MARKET_DATA_INPUT_INVALID', 'session openUtc must precede closeUtc');
    if (session.marketValidTime !== session.closeUtc) fail('MARKET_DATA_INPUT_INVALID', 'marketValidTime must equal closeUtc');
    if (previous === session.sessionDate) fail('MARKET_DATA_CALENDAR_SESSION_DUPLICATE', 'duplicate session date');
    if (previous !== null && previous > session.sessionDate) fail('MARKET_DATA_INPUT_INVALID', 'sessions must be sorted');
    previous = session.sessionDate;
    return { sessionDate: session.sessionDate, sessionKind: session.sessionKind, openUtc: session.openUtc, closeUtc: session.closeUtc, marketValidTime: session.marketValidTime };
  });
  return {
    schemaVersion: MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION,
    calendarAuthorityPolicyId: core.calendarAuthorityPolicyId,
    venueId: core.venueId,
    timeZoneRulesetId: core.timeZoneRulesetId,
    coverageFromDate: core.coverageFromDate,
    coverageToDateExclusive: core.coverageToDateExclusive,
    sessions,
  };
}

export function normalizeMarketCalendarRegistryManifestV2(value) {
  const registry = assertPlainObject(value, MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION);
  assertSchemaVersion(registry, MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION);
  assertExactFields(registry, REGISTRY_FIELDS);
  assertCasId(registry.calendarAuthorityPolicyId, 'calendarAuthorityPolicyId');
  const calendarCoreIds = canonicalIdList(registry.calendarCoreIds, 'calendarCoreIds');
  assertCasId(registry.supersedesCalendarRegistryManifestId, 'supersedesCalendarRegistryManifestId', true);
  return {
    schemaVersion: MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION,
    calendarAuthorityPolicyId: registry.calendarAuthorityPolicyId,
    calendarCoreIds,
    supersedesCalendarRegistryManifestId: registry.supersedesCalendarRegistryManifestId,
  };
}

function verifyRulesetShape(ruleset, entry) {
  if (!ruleset || ruleset.schemaVersion !== 'TimeZoneRuleset/1'
      || ruleset.zoneId !== entry.zoneId || ruleset.rulesetFormat !== entry.rulesetFormat
      || !Array.isArray(ruleset.civilDateBounds) || ruleset.civilDateBounds.length === 0) {
    fail('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'malformed or mismatched yearly timezone ruleset');
  }
}

function verifyPolicyReferences(store, policy) {
  const resolved = new Map();
  for (const entry of policy.yearlyRulesets) {
    const ruleset = readTypedReference(store, entry.timeZoneRulesetId, 'TimeZoneRuleset/1', 'time-zone ruleset');
    verifyRulesetShape(ruleset, entry);
    resolved.set(entry.calendarYear, ruleset);
  }
  return resolved;
}

function verifyCoreReferences(store, core) {
  const policy = readTypedReference(store, core.calendarAuthorityPolicyId, MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION, 'calendar authority policy');
  const rulesets = verifyPolicyReferences(store, policy);
  const year = Number(core.coverageFromDate.slice(0, 4));
  const entry = policy.yearlyRulesets.find((item) => item.calendarYear === year);
  if (!entry || entry.timeZoneRulesetId !== core.timeZoneRulesetId || core.venueId !== policy.venueId) {
    fail('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'core does not match policy yearly ruleset');
  }
  const ruleset = rulesets.get(year);
  if (core.coverageFromDate < ruleset.validFromDate || core.coverageToDateExclusive > ruleset.validToDateExclusive) {
    fail('MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE', 'core coverage is not contained in timezone ruleset');
  }
  for (const session of core.sessions) {
    if (!policy.allowedSessionKinds.includes(session.sessionKind)) fail('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'unauthorized session kind');
  }
  return policy;
}

function orderedRegistry(store, registry) {
  const resolved = registry.calendarCoreIds.map((id) => ({ id, core: readTypedReference(store, id, MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION, 'calendar core') }));
  resolved.sort((a, b) => a.core.coverageFromDate.localeCompare(b.core.coverageFromDate));
  for (let i = 1; i < resolved.length; i += 1) {
    if (resolved[i - 1].core.coverageFromDate === resolved[i].core.coverageFromDate) fail('MARKET_DATA_CALENDAR_OVERLAP', 'duplicate core coverageFromDate');
  }
  return { ...registry, calendarCoreIds: resolved.map((item) => item.id) };
}

function verifyRegistryGraph(store, registry, registryId, seen) {
  if (registryId !== null) {
    if (seen.has(registryId)) fail('MARKET_DATA_CALENDAR_REGISTRY_CYCLE', 'registry cycle');
    seen.add(registryId);
  }
  const policy = readTypedReference(store, registry.calendarAuthorityPolicyId, MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION, 'calendar authority policy');
  verifyPolicyReferences(store, policy);
  const calendars = registry.calendarCoreIds.map((id) => {
    const core = readTypedReference(store, id, MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION, 'calendar core');
    verifyCoreReferences(store, core);
    if (core.calendarAuthorityPolicyId !== registry.calendarAuthorityPolicyId) fail('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'foreign calendar core');
    return core;
  });
  for (let i = 1; i < calendars.length; i += 1) {
    const left = calendars[i - 1];
    const right = calendars[i];
    if (left.coverageFromDate >= right.coverageFromDate) fail('MARKET_DATA_INPUT_INVALID', 'calendarCoreIds are not ordered by coverageFromDate');
    if (left.coverageToDateExclusive < right.coverageFromDate) fail('MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE', 'calendar registry contains a coverage gap');
    if (left.coverageToDateExclusive > right.coverageFromDate) {
      const overlapFrom = right.coverageFromDate;
      const overlapTo = left.coverageToDateExclusive < right.coverageToDateExclusive ? left.coverageToDateExclusive : right.coverageToDateExclusive;
      const l = new Map(left.sessions.filter((s) => s.sessionDate >= overlapFrom && s.sessionDate < overlapTo).map((s) => [s.sessionDate, s]));
      const r = new Map(right.sessions.filter((s) => s.sessionDate >= overlapFrom && s.sessionDate < overlapTo).map((s) => [s.sessionDate, s]));
      for (const date of new Set([...l.keys(), ...r.keys()])) if (!canonicalValuesEqual(l.get(date), r.get(date))) fail('MARKET_DATA_CALENDAR_OVERLAP', 'overlapping calendars disagree', { sessionDate: date });
    }
  }
  if (registry.supersedesCalendarRegistryManifestId !== null) {
    const parentBytes = store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'snapshots', objectId: registry.supersedesCalendarRegistryManifestId }),
      expectedObjectId: registry.supersedesCalendarRegistryManifestId,
      schemaVersion: MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION,
    });
    const parent = parentBytes.value;
    if (parent.schemaVersion !== MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION) fail('MARKET_DATA_CALENDAR_APPEND_ONLY_VIOLATION', 'V1 registry parent forbidden');
    if (parent.calendarAuthorityPolicyId !== registry.calendarAuthorityPolicyId || parent.calendarCoreIds.some((id) => !registry.calendarCoreIds.includes(id))) fail('MARKET_DATA_CALENDAR_APPEND_ONLY_VIOLATION', 'registry is not append-only');
    verifyRegistryGraph(store, parent, registry.supersedesCalendarRegistryManifestId, seen);
  }
  return { policy, calendars };
}

export function buildMarketCalendarAuthorityPolicyV2(input) {
  const api = assertApiInput(input, ['policy']);
  assertStore(api.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject']);
  const policy = normalizeMarketCalendarAuthorityPolicyV2(api.policy);
  verifyPolicyReferences(api.store, policy);
  const stored = putCanonicalL3(api.store, MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION, policy);
  return { calendarAuthorityPolicyId: stored.objectId, calendarAuthorityPolicy: stored.value, object: stored };
}

export function verifyMarketCalendarAuthorityPolicyV2(input) {
  const api = assertApiInput(input, ['calendarAuthorityPolicyId']);
  const policy = readTypedReference(api.store, api.calendarAuthorityPolicyId, MARKET_CALENDAR_AUTHORITY_POLICY_V2_SCHEMA_VERSION, 'calendar authority policy');
  verifyPolicyReferences(api.store, policy);
  return { calendarAuthorityPolicyId: api.calendarAuthorityPolicyId, calendarAuthorityPolicy: policy };
}

export function buildMarketSessionCalendarV2(input) {
  const api = assertApiInput(input, ['calendar']);
  const calendar = normalizeMarketSessionCalendarCoreV2(api.calendar);
  const policy = verifyCoreReferences(api.store, calendar);
  const stored = putCanonicalL3(api.store, MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION, calendar);
  return { calendarCoreId: stored.objectId, calendarCore: stored.value, calendarAuthorityPolicy: policy, object: stored };
}

export function verifyMarketSessionCalendarV2(input) {
  const api = assertApiInput(input, ['calendarCoreId']);
  const calendar = readTypedReference(api.store, api.calendarCoreId, MARKET_SESSION_CALENDAR_CORE_V2_SCHEMA_VERSION, 'calendar core');
  const policy = verifyCoreReferences(api.store, calendar);
  return { calendarCoreId: api.calendarCoreId, calendarCore: calendar, calendarAuthorityPolicy: policy };
}

export function buildMarketCalendarRegistryV2(input) {
  const api = assertApiInput(input, ['registry']);
  const normalized = normalizeMarketCalendarRegistryManifestV2(api.registry);
  const registry = orderedRegistry(api.store, normalized);
  const resolved = verifyRegistryGraph(api.store, registry, null, new Set());
  const stored = putCanonicalL3(api.store, MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION, registry);
  return { calendarRegistryManifestId: stored.objectId, calendarRegistryManifest: stored.value, object: stored, ...resolved };
}

export function verifyMarketCalendarRegistryV2(input) {
  const api = assertApiInput(input, ['calendarRegistryManifestId']);
  const registry = readTypedReference(api.store, api.calendarRegistryManifestId, MARKET_CALENDAR_REGISTRY_MANIFEST_V2_SCHEMA_VERSION, 'calendar registry');
  const resolved = verifyRegistryGraph(api.store, registry, api.calendarRegistryManifestId, new Set());
  return { calendarRegistryManifestId: api.calendarRegistryManifestId, calendarRegistryManifest: registry, ...resolved };
}

export const recoverMarketCalendarRegistryV2 = verifyMarketCalendarRegistryV2;
