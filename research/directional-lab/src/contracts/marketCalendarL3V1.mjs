/** Closed, CAS-authoritative L3 market calendars. */

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
  assertUtcInstant,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from './marketDataL3CommonV1.mjs';

export const MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION = 'MarketCalendarAuthorityPolicy/1';
export const MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION = 'MarketSessionCalendarCore/1';
export const MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION = 'MarketCalendarRegistryManifest/1';

export const MARKET_CALENDAR_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
  MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
]);
export const MARKET_VENUE_IDS = Object.freeze(['ARCX', 'XNAS', 'XNYS']);
export const MARKET_CALENDAR_SESSION_KINDS = Object.freeze(['HALF_DAY_SESSION', 'REGULAR_SESSION']);

const POLICY_FIELDS = Object.freeze([
  'schemaVersion', 'venueId', 'timeZoneRulesetId', 'allowedSessionKinds', 'calendarNamespaceVersion',
]);
const CALENDAR_FIELDS = Object.freeze([
  'schemaVersion', 'calendarAuthorityPolicyId', 'venueId', 'timeZoneRulesetId',
  'coverageFromDate', 'coverageToDateExclusive', 'sessions',
]);
const SESSION_FIELDS = Object.freeze(['sessionDate', 'sessionKind', 'openUtc', 'closeUtc', 'marketValidTime']);
const REGISTRY_FIELDS = Object.freeze([
  'schemaVersion', 'calendarAuthorityPolicyId', 'calendarCoreIds', 'supersedesCalendarRegistryManifestId',
]);

/** @param {unknown} value @param {readonly string[]} allowed @param {string} label */
function canonicalEnumSet(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a non-empty array`);
  }
  for (const item of value) assertEnum(item, allowed, label);
  if (new Set(value).size !== value.length) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be unique`);
  }
  return [...value].sort();
}

/** @param {unknown} value @param {string} label */
function canonicalIdSet(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a non-empty array`);
  }
  for (let i = 0; i < value.length; i += 1) assertCasId(value[i], `${label}[${i}]`);
  if (new Set(value).size !== value.length) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be unique`);
  }
  return [...value].sort();
}

export function normalizeMarketCalendarAuthorityPolicyV1(value) {
  const policy = assertPlainObject(value, MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION);
  assertExactFields(policy, POLICY_FIELDS);
  assertEnum(policy.venueId, MARKET_VENUE_IDS, 'venueId');
  assertCasId(policy.timeZoneRulesetId, 'timeZoneRulesetId');
  const allowedSessionKinds = canonicalEnumSet(policy.allowedSessionKinds, MARKET_CALENDAR_SESSION_KINDS, 'allowedSessionKinds');
  assertNonEmptyString(policy.calendarNamespaceVersion, 'calendarNamespaceVersion');
  return {
    schemaVersion: MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
    venueId: policy.venueId,
    timeZoneRulesetId: policy.timeZoneRulesetId,
    allowedSessionKinds,
    calendarNamespaceVersion: policy.calendarNamespaceVersion,
  };
}

export function normalizeMarketSessionCalendarCoreV1(value) {
  const calendar = assertPlainObject(value, MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION);
  assertSchemaVersion(calendar, MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION);
  assertExactFields(calendar, CALENDAR_FIELDS);
  assertCasId(calendar.calendarAuthorityPolicyId, 'calendarAuthorityPolicyId');
  assertEnum(calendar.venueId, MARKET_VENUE_IDS, 'venueId');
  assertCasId(calendar.timeZoneRulesetId, 'timeZoneRulesetId');
  assertCivilDate(calendar.coverageFromDate, 'coverageFromDate');
  assertCivilDate(calendar.coverageToDateExclusive, 'coverageToDateExclusive');
  if (calendar.coverageFromDate >= calendar.coverageToDateExclusive) {
    throw new MarketDataL3Error('MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE', 'calendar coverage must be non-empty');
  }
  if (!Array.isArray(calendar.sessions)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'sessions must be an array');
  }
  let previousDate = null;
  const sessions = calendar.sessions.map((raw, index) => {
    const session = assertPlainObject(raw, `sessions[${index}]`);
    assertExactFields(session, SESSION_FIELDS);
    assertCivilDate(session.sessionDate, `sessions[${index}].sessionDate`);
    assertEnum(session.sessionKind, MARKET_CALENDAR_SESSION_KINDS, `sessions[${index}].sessionKind`);
    assertUtcInstant(session.openUtc, `sessions[${index}].openUtc`);
    assertUtcInstant(session.closeUtc, `sessions[${index}].closeUtc`);
    assertUtcInstant(session.marketValidTime, `sessions[${index}].marketValidTime`);
    if (session.sessionDate < calendar.coverageFromDate || session.sessionDate >= calendar.coverageToDateExclusive) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE', 'session is outside calendar coverage', { sessionDate: session.sessionDate });
    }
    if (session.openUtc >= session.closeUtc) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'session openUtc must precede closeUtc');
    }
    if (session.marketValidTime !== session.closeUtc) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'marketValidTime must equal closeUtc');
    }
    if (previousDate === session.sessionDate) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_SESSION_DUPLICATE', 'calendar contains a duplicate session date', { sessionDate: session.sessionDate });
    }
    if (previousDate !== null && previousDate > session.sessionDate) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'sessions must be sorted by sessionDate');
    }
    previousDate = session.sessionDate;
    return {
      sessionDate: session.sessionDate,
      sessionKind: session.sessionKind,
      openUtc: session.openUtc,
      closeUtc: session.closeUtc,
      marketValidTime: session.marketValidTime,
    };
  });
  return {
    schemaVersion: MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
    calendarAuthorityPolicyId: calendar.calendarAuthorityPolicyId,
    venueId: calendar.venueId,
    timeZoneRulesetId: calendar.timeZoneRulesetId,
    coverageFromDate: calendar.coverageFromDate,
    coverageToDateExclusive: calendar.coverageToDateExclusive,
    sessions,
  };
}

export function normalizeMarketCalendarRegistryManifestV1(value) {
  const registry = assertPlainObject(value, MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION);
  assertSchemaVersion(registry, MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION);
  assertExactFields(registry, REGISTRY_FIELDS);
  assertCasId(registry.calendarAuthorityPolicyId, 'calendarAuthorityPolicyId');
  const calendarCoreIds = canonicalIdSet(registry.calendarCoreIds, 'calendarCoreIds');
  assertCasId(registry.supersedesCalendarRegistryManifestId, 'supersedesCalendarRegistryManifestId', true);
  return {
    schemaVersion: MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    calendarAuthorityPolicyId: registry.calendarAuthorityPolicyId,
    calendarCoreIds,
    supersedesCalendarRegistryManifestId: registry.supersedesCalendarRegistryManifestId,
  };
}

/** @param {any} store @param {any} policy */
function verifyPolicyReferences(store, policy) {
  readTypedReference(store, policy.timeZoneRulesetId, 'TimeZoneRuleset/1', 'time-zone ruleset');
}

/** @param {any} store @param {any} calendar */
function verifyCalendarReferences(store, calendar) {
  const policy = readTypedReference(
    store, calendar.calendarAuthorityPolicyId,
    MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION, 'calendar authority policy',
  );
  verifyPolicyReferences(store, policy);
  if (calendar.venueId !== policy.venueId || calendar.timeZoneRulesetId !== policy.timeZoneRulesetId) {
    throw new MarketDataL3Error('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'calendar core does not match its authority policy');
  }
  for (const session of calendar.sessions) {
    if (!policy.allowedSessionKinds.includes(session.sessionKind)) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'session kind is not authorized by the calendar policy');
    }
  }
  return policy;
}

/** @param {any[]} calendars */
function verifyCalendarCoverageAndOverlaps(calendars) {
  const ordered = [...calendars].sort((a, b) => a.coverageFromDate.localeCompare(b.coverageFromDate)
    || a.coverageToDateExclusive.localeCompare(b.coverageToDateExclusive));
  let coveredTo = ordered[0]?.coverageToDateExclusive ?? null;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].coverageFromDate > coveredTo) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE', 'calendar registry contains a coverage gap');
    }
    if (ordered[i].coverageToDateExclusive > coveredTo) coveredTo = ordered[i].coverageToDateExclusive;
  }
  for (let leftIndex = 0; leftIndex < calendars.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < calendars.length; rightIndex += 1) {
      const left = calendars[leftIndex];
      const right = calendars[rightIndex];
      const overlapFrom = left.coverageFromDate > right.coverageFromDate
        ? left.coverageFromDate : right.coverageFromDate;
      const overlapToExclusive = left.coverageToDateExclusive < right.coverageToDateExclusive
        ? left.coverageToDateExclusive : right.coverageToDateExclusive;
      if (overlapFrom >= overlapToExclusive) continue;
      const leftSessions = new Map(left.sessions
        .filter((session) => session.sessionDate >= overlapFrom && session.sessionDate < overlapToExclusive)
        .map((session) => [session.sessionDate, session]));
      const rightSessions = new Map(right.sessions
        .filter((session) => session.sessionDate >= overlapFrom && session.sessionDate < overlapToExclusive)
        .map((session) => [session.sessionDate, session]));
      const dates = new Set([...leftSessions.keys(), ...rightSessions.keys()]);
      for (const sessionDate of dates) {
        if (!canonicalValuesEqual(leftSessions.get(sessionDate), rightSessions.get(sessionDate))) {
          throw new MarketDataL3Error('MARKET_DATA_CALENDAR_OVERLAP', 'overlapping calendars disagree on an open or closed session date', { sessionDate });
        }
      }
    }
  }
}

/** @param {any} store @param {any} registry @param {string|null} registryId @param {Set<string>} seen */
function verifyRegistryGraph(store, registry, registryId, seen) {
  if (registryId !== null) {
    if (seen.has(registryId)) throw new MarketDataL3Error('MARKET_DATA_CALENDAR_REGISTRY_CYCLE', 'calendar registry chain contains a cycle');
    seen.add(registryId);
  }
  const policy = readTypedReference(
    store, registry.calendarAuthorityPolicyId,
    MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION, 'calendar authority policy',
  );
  verifyPolicyReferences(store, policy);
  const calendars = registry.calendarCoreIds.map((calendarCoreId) => {
    const calendar = readTypedReference(store, calendarCoreId, MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION, 'calendar core');
    verifyCalendarReferences(store, calendar);
    if (calendar.calendarAuthorityPolicyId !== registry.calendarAuthorityPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'calendar registry contains a foreign calendar core');
    }
    return calendar;
  });
  verifyCalendarCoverageAndOverlaps(calendars);
  if (registry.supersedesCalendarRegistryManifestId !== null) {
    if (registry.supersedesCalendarRegistryManifestId === registryId || seen.has(registry.supersedesCalendarRegistryManifestId)) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_REGISTRY_CYCLE', 'calendar registry chain contains a cycle');
    }
    const parent = readTypedReference(
      store, registry.supersedesCalendarRegistryManifestId,
      MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, 'superseded calendar registry',
    );
    if (parent.calendarAuthorityPolicyId !== registry.calendarAuthorityPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_AUTHORITY_MISMATCH', 'calendar registry parent uses another authority policy');
    }
    if (parent.calendarCoreIds.some((id) => !registry.calendarCoreIds.includes(id))) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_APPEND_ONLY_VIOLATION', 'calendar registry removed historical calendar cores');
    }
    verifyRegistryGraph(store, parent, registry.supersedesCalendarRegistryManifestId, seen);
  }
  return { policy, calendars };
}

/** @param {unknown} input */
export function buildMarketCalendarAuthorityPolicy(input) {
  const api = assertApiInput(input, ['policy']);
  assertStore(api.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject']);
  const policy = normalizeMarketCalendarAuthorityPolicyV1(api.policy);
  verifyPolicyReferences(api.store, policy);
  const stored = putCanonicalL3(api.store, MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION, policy);
  return { calendarAuthorityPolicyId: stored.objectId, calendarAuthorityPolicy: stored.value, object: stored };
}

/** @param {unknown} input */
export function verifyMarketCalendarAuthorityPolicy(input) {
  const api = assertApiInput(input, ['calendarAuthorityPolicyId']);
  const policy = readTypedReference(api.store, api.calendarAuthorityPolicyId, MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION, 'calendar authority policy');
  verifyPolicyReferences(api.store, policy);
  return { calendarAuthorityPolicyId: api.calendarAuthorityPolicyId, calendarAuthorityPolicy: policy };
}

/** @param {unknown} input */
export function buildMarketSessionCalendar(input) {
  const api = assertApiInput(input, ['calendar']);
  const calendar = normalizeMarketSessionCalendarCoreV1(api.calendar);
  const policy = verifyCalendarReferences(api.store, calendar);
  const stored = putCanonicalL3(api.store, MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION, calendar);
  return { calendarCoreId: stored.objectId, calendarCore: stored.value, calendarAuthorityPolicy: policy, object: stored };
}

/** @param {unknown} input */
export function verifyMarketSessionCalendar(input) {
  const api = assertApiInput(input, ['calendarCoreId']);
  const calendar = readTypedReference(api.store, api.calendarCoreId, MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION, 'calendar core');
  const policy = verifyCalendarReferences(api.store, calendar);
  return { calendarCoreId: api.calendarCoreId, calendarCore: calendar, calendarAuthorityPolicy: policy };
}

/** @param {unknown} input */
export function buildMarketCalendarRegistry(input) {
  const api = assertApiInput(input, ['registry']);
  const registry = normalizeMarketCalendarRegistryManifestV1(api.registry);
  const resolved = verifyRegistryGraph(api.store, registry, null, new Set());
  const stored = putCanonicalL3(api.store, MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, registry);
  return { calendarRegistryManifestId: stored.objectId, calendarRegistryManifest: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyMarketCalendarRegistry(input) {
  const api = assertApiInput(input, ['calendarRegistryManifestId']);
  const registry = readTypedReference(api.store, api.calendarRegistryManifestId, MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, 'calendar registry');
  const resolved = verifyRegistryGraph(api.store, registry, api.calendarRegistryManifestId, new Set());
  return { calendarRegistryManifestId: api.calendarRegistryManifestId, calendarRegistryManifest: registry, ...resolved };
}

export const recoverMarketCalendarRegistry = verifyMarketCalendarRegistry;
