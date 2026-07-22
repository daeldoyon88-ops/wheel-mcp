/**
 * L4B-I1 closed macro-ingestion contracts: permanent series identities, the
 * append-only series registry, logical observation identities, the split
 * between vintage temporal identity and vintage content, the pinned vintage
 * set, the closed V1 ingestion policy and the pinned macro dataset snapshot.
 *
 * No feature is computed here. No network, no wall clock, no machine
 * timezone and no "latest" reference is ever consulted: every timestamp is
 * explicitly pinned and every derivation is pure arithmetic.
 */

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
  canonicalDigest,
} from './marketDataL3CommonV1.mjs';
import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import { addDays, dayOfWeek, toEpochDay } from '../time/civilDate.mjs';

export const MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION = 'MacroSeriesIdentityCore/1';
export const MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION = 'MacroSeriesRegistryManifest/1';
export const MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION = 'MacroObservationIdentityCore/1';
export const MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION = 'MacroVintageIdentityCore/1';
export const MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION = 'MacroObservationVintageCore/1';
export const MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION = 'MacroVintageSetManifest/1';
export const MACRO_INGESTION_POLICY_SCHEMA_VERSION = 'MacroIngestionPolicy/1';
export const MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION = 'MacroDatasetSnapshotManifest/1';

export const MACRO_INGESTION_L4B_SCHEMA_VERSIONS = Object.freeze([
  MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
  MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
  MACRO_INGESTION_POLICY_SCHEMA_VERSION,
  MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
]);

export const MACRO_JURISDICTION_CODES = Object.freeze(['UNITED_STATES']);
export const MACRO_CURRENCY_CODES = Object.freeze(['USD']);
export const MACRO_SOURCE_AUTHORITIES = Object.freeze([
  'BLS', 'FRB', 'FRED_ALFRED', 'NY_FED', 'TEST_FIXTURE', 'US_TREASURY',
]);
export const MACRO_FREQUENCIES = Object.freeze(['DAILY', 'EVENT', 'MONTHLY', 'WEEKLY']);
export const MACRO_UNITS = Object.freeze([
  'BASIS_POINTS', 'COUNT', 'EVENT_VALUE', 'INDEX', 'PERCENT', 'RATE_RANGE_BOUND',
]);
export const MACRO_SEASONAL_ADJUSTMENTS = Object.freeze([
  'NOT_APPLICABLE', 'NOT_SEASONALLY_ADJUSTED', 'SEASONALLY_ADJUSTED',
]);
export const MACRO_OBSERVATION_CONVENTIONS = Object.freeze([
  'PERIOD_AVERAGE', 'PERIOD_END', 'PERIOD_TOTAL', 'POINT_IN_TIME_EVENT',
]);
export const MACRO_REVISION_POLICIES = Object.freeze([
  'FINAL_ONLY', 'PUBLICATION_ATTESTED', 'UNUSABLE_FOR_POINT_IN_TIME',
  'VINTAGE_COMPLETE', 'VINTAGE_PARTIAL',
]);
export const MACRO_SERIES_STATUSES = Object.freeze(['ACTIVE', 'DEPRECATED', 'REPLACED']);
export const MACRO_SERIES_REPLACEMENT_REASONS = Object.freeze([
  'AUTHORITY_CHANGE', 'FREQUENCY_CHANGE', 'METHODOLOGY_CHANGE',
  'OBSERVATION_CONVENTION_CHANGE', 'SEASONAL_ADJUSTMENT_CHANGE',
  'SOURCE_CORRECTION', 'UNIT_CHANGE',
]);
export const MACRO_REVISION_KINDS = Object.freeze([
  'BENCHMARK_REVISION', 'CORRECTION', 'INITIAL', 'REVISION', 'WITHDRAWAL',
]);
export const MACRO_RELEASE_TIME_RESOLUTION_MODES = Object.freeze([
  'OFFICIAL_TIMESTAMP', 'SERIES_AUTHORITY_POLICY', 'UNKNOWN_REJECTED',
]);
export const MACRO_VINTAGE_COMPLETENESS_CLASSES = Object.freeze([
  'FINAL_ONLY', 'PUBLICATION_ATTESTED', 'RELEASE_TIME_UNKNOWN',
  'UNUSABLE_FOR_POINT_IN_TIME', 'VINTAGE_COMPLETE', 'VINTAGE_PARTIAL',
]);
export const MACRO_RELEASE_RULE_TIMEZONES = Object.freeze(['AMERICA_NEW_YORK']);

export const MACRO_SERIES_REGISTRY_POLICY_VERSION = 'MACRO_SERIES_REGISTRY_L4B_I1_V1';
export const MACRO_INGESTION_POLICY_VERSION = 'MACRO_INGESTION_L4B_I1_V1';

const CANONICAL_SERIES_CODE_PATTERN = /^US(\.[A-Z][A-Z0-9]*){2}$/;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIXED_POINT_ATOMS_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const MAX_FIXED_POINT_ATOM_CHARACTERS = 38;

/** Highest wire scale accepted for each closed unit. COUNT is integral. */
export const MACRO_UNIT_MAX_SCALE = Object.freeze({
  BASIS_POINTS: 4,
  COUNT: 0,
  EVENT_VALUE: 6,
  INDEX: 6,
  PERCENT: 6,
  RATE_RANGE_BOUND: 6,
});

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

/**
 * Macro timestamps additionally pin the millisecond wire form: one instant
 * must have exactly one encoding, otherwise two encodings of the same
 * availableAt would mint two different vintage identities.
 */
function assertMacroUtcInstant(value, label, nullable = false) {
  assertUtcInstant(value, label, nullable);
  if (value !== null && !/\.\d{3}Z$/.test(/** @type {string} */ (value))) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
      `${label} must pin the canonical millisecond UTC form`);
  }
}

function assertCanonicalSeriesCode(value, label, code) {
  assertNonEmptyString(value, label);
  if (!CANONICAL_SERIES_CODE_PATTERN.test(/** @type {string} */ (value))) {
    throw new MarketDataL3Error(code, `${label} must match the closed US canonical series code grammar`);
  }
}

/* ------------------------------------------------------------------------- *
 * Deterministic America/New_York derivation (closed 2007-2099 US DST rules).
 * ------------------------------------------------------------------------- */

function nthSundayOfMonth(year, monthIndex, nth) {
  const first = `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-01`;
  const offset = (7 - dayOfWeek(first)) % 7;
  return addDays(first, offset + (nth - 1) * 7);
}

/**
 * Closed classification of a New-York civil date under the post-2007 United
 * States daylight-saving statute: DST runs from the second Sunday of March to
 * the first Sunday of November. Purely arithmetic; never consults ICU, the
 * machine timezone or the wall clock.
 * @param {string} civilDate
 */
export function newYorkDaylightSavingBoundsV1(civilDate) {
  assertCivilDate(civilDate, 'civilDate');
  const year = Number(civilDate.slice(0, 4));
  if (year < 2007 || year > 2099) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
      'New-York derivation is closed to civil years 2007 through 2099');
  }
  return {
    dstStartDate: nthSundayOfMonth(year, 2, 2),
    dstEndDate: nthSundayOfMonth(year, 10, 1),
  };
}

/**
 * Derive the UTC instant of a pinned New-York civil time. Nonexistent local
 * times on the spring-forward date and ambiguous local times on the fall-back
 * date are rejected fail-closed.
 * @param {string} civilDate @param {string} localTime "HH:MM"
 */
export function deriveNewYorkUtcInstantV1(civilDate, localTime) {
  if (typeof localTime !== 'string' || !LOCAL_TIME_PATTERN.test(localTime)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
      'localTime must be a closed HH:MM civil time');
  }
  const { dstStartDate, dstEndDate } = newYorkDaylightSavingBoundsV1(civilDate);
  let daylight;
  if (civilDate === dstStartDate) {
    if (localTime >= '02:00' && localTime < '03:00') {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
        'local time does not exist on the spring-forward date');
    }
    daylight = localTime >= '03:00';
  } else if (civilDate === dstEndDate) {
    if (localTime >= '01:00' && localTime < '02:00') {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
        'local time is ambiguous on the fall-back date');
    }
    daylight = localTime < '01:00';
  } else {
    daylight = civilDate > dstStartDate && civilDate < dstEndDate;
  }
  const offsetMinutes = daylight ? 240 : 300;
  const localMinutes = Number(localTime.slice(0, 2)) * 60 + Number(localTime.slice(3, 5));
  const utcMs = (toEpochDay(civilDate) * 1440 + localMinutes + offsetMinutes) * 60000;
  const utcDay = Math.floor(utcMs / 86400000);
  const dayMinutes = (utcMs - utcDay * 86400000) / 60000;
  const date = addDays('1970-01-01', utcDay);
  const hh = String(Math.floor(dayMinutes / 60)).padStart(2, '0');
  const mm = String(dayMinutes % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:00.000Z`;
}

/* ------------------------------------------------------------------------- *
 * MacroSeriesIdentityCore/1
 * ------------------------------------------------------------------------- */

const SERIES_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'jurisdictionCode', 'currencyCode', 'sourceAuthority',
  'canonicalSeriesCode', 'frequency', 'units', 'seasonalAdjustment',
  'observationConvention', 'revisionPolicy', 'releaseAuthority',
  'methodologyVersionId', 'validFrom', 'validThrough',
]);

/**
 * Permanent series identity. Display titles and mutable provider codes are
 * deliberately absent: they must never influence the permanent identity, so
 * they belong to a future descriptor object, not to this core.
 */
export function normalizeMacroSeriesIdentityCoreV1(value) {
  const code = 'MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID';
  const identity = closedRecord(value, SERIES_IDENTITY_FIELDS,
    MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION, code);
  assertSchemaVersion(identity, MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION);
  assertEnum(identity.jurisdictionCode, MACRO_JURISDICTION_CODES, 'jurisdictionCode', code);
  assertEnum(identity.currencyCode, MACRO_CURRENCY_CODES, 'currencyCode', code);
  assertEnum(identity.sourceAuthority, MACRO_SOURCE_AUTHORITIES, 'sourceAuthority', code);
  assertCanonicalSeriesCode(identity.canonicalSeriesCode, 'canonicalSeriesCode', code);
  assertEnum(identity.frequency, MACRO_FREQUENCIES, 'frequency', code);
  assertEnum(identity.units, MACRO_UNITS, 'units', code);
  assertEnum(identity.seasonalAdjustment, MACRO_SEASONAL_ADJUSTMENTS, 'seasonalAdjustment', code);
  assertEnum(identity.observationConvention, MACRO_OBSERVATION_CONVENTIONS, 'observationConvention', code);
  assertEnum(identity.revisionPolicy, MACRO_REVISION_POLICIES, 'revisionPolicy', code);
  assertEnum(identity.releaseAuthority, MACRO_SOURCE_AUTHORITIES, 'releaseAuthority', code);
  assertCasId(identity.methodologyVersionId, 'methodologyVersionId');
  assertCivilDate(identity.validFrom, 'validFrom');
  if (identity.validThrough !== null) {
    assertCivilDate(identity.validThrough, 'validThrough');
    if (identity.validThrough < identity.validFrom) {
      throw new MarketDataL3Error(code, 'validThrough cannot precede validFrom');
    }
  }
  return Object.fromEntries(SERIES_IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

/** @param {unknown} value */
export function macroSeriesIdentityIdFor(value) {
  const normalized = normalizeMacroSeriesIdentityCoreV1(value);
  return canonicalHash(MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION, normalized);
}

/* ------------------------------------------------------------------------- *
 * MacroSeriesRegistryManifest/1
 * ------------------------------------------------------------------------- */

const SERIES_REGISTRY_FIELDS = Object.freeze([
  'schemaVersion', 'registryPolicyVersion', 'supersedesRegistryManifestId',
  'orderedSeriesEntries',
]);
const SERIES_REGISTRY_ENTRY_FIELDS = Object.freeze([
  'macroSeriesIdentityId', 'canonicalSeriesCode', 'status',
  'supersedesSeriesIdentityId', 'replacementReason',
]);

export function compareMacroSeriesRegistryEntries(left, right) {
  if (left.canonicalSeriesCode < right.canonicalSeriesCode) return -1;
  if (left.canonicalSeriesCode > right.canonicalSeriesCode) return 1;
  return left.macroSeriesIdentityId < right.macroSeriesIdentityId ? -1
    : left.macroSeriesIdentityId > right.macroSeriesIdentityId ? 1 : 0;
}

function normalizeSeriesRegistryEntry(value, index) {
  const label = `orderedSeriesEntries[${index}]`;
  const code = 'MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID';
  const entry = closedRecord(value, SERIES_REGISTRY_ENTRY_FIELDS, label, code);
  assertCasId(entry.macroSeriesIdentityId, `${label}.macroSeriesIdentityId`);
  assertCanonicalSeriesCode(entry.canonicalSeriesCode, `${label}.canonicalSeriesCode`, code);
  assertEnum(entry.status, MACRO_SERIES_STATUSES, `${label}.status`, code);
  assertCasId(entry.supersedesSeriesIdentityId, `${label}.supersedesSeriesIdentityId`, true);
  if (entry.supersedesSeriesIdentityId === null) {
    if (entry.replacementReason !== null) {
      throw new MarketDataL3Error(code, `${label}.replacementReason requires a replaced identity`);
    }
  } else {
    assertEnum(entry.replacementReason, MACRO_SERIES_REPLACEMENT_REASONS,
      `${label}.replacementReason`, code);
  }
  return Object.fromEntries(SERIES_REGISTRY_ENTRY_FIELDS.map((field) => [field, entry[field]]));
}

/**
 * Structural + graph validation of one registry manifest: canonical order,
 * unique identities, single active tip per canonical code, total replacement
 * chains without self-references, branches or cycles.
 */
export function normalizeMacroSeriesRegistryManifestV1(value) {
  const code = 'MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID';
  const registry = closedRecord(value, SERIES_REGISTRY_FIELDS,
    MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION, code);
  assertSchemaVersion(registry, MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION);
  if (registry.registryPolicyVersion !== MACRO_SERIES_REGISTRY_POLICY_VERSION) {
    throw new MarketDataL3Error(code, 'registryPolicyVersion diverges from the closed V1');
  }
  assertCasId(registry.supersedesRegistryManifestId, 'supersedesRegistryManifestId', true);
  if (!Array.isArray(registry.orderedSeriesEntries)) {
    throw new MarketDataL3Error(code, 'orderedSeriesEntries must be an array');
  }
  const entries = registry.orderedSeriesEntries.map(normalizeSeriesRegistryEntry);
  const byId = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    if (index > 0 && compareMacroSeriesRegistryEntries(entries[index - 1], entries[index]) >= 0) {
      throw new MarketDataL3Error(code, 'orderedSeriesEntries must be canonically sorted and unique');
    }
    if (byId.has(entries[index].macroSeriesIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CONFLICT',
        'series identity appears more than once');
    }
    byId.set(entries[index].macroSeriesIdentityId, entries[index]);
  }
  const activeByCode = new Map();
  for (const entry of entries) {
    if (entry.status !== 'ACTIVE') continue;
    if (activeByCode.has(entry.canonicalSeriesCode)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_DUPLICATE_ACTIVE_CODE',
        'a canonical series code cannot have two active tips');
    }
    activeByCode.set(entry.canonicalSeriesCode, entry);
  }
  const replacerByTarget = new Map();
  for (const entry of entries) {
    const target = entry.supersedesSeriesIdentityId;
    if (target === null) continue;
    if (target === entry.macroSeriesIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE',
        'a series cannot replace itself');
    }
    const replaced = byId.get(target);
    if (!replaced) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REFERENCE_MISMATCH',
        'replaced series identity is absent from the registry');
    }
    if (replaced.status !== 'REPLACED') {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CONFLICT',
        'replaced series entry must carry the REPLACED status');
    }
    if (replacerByTarget.has(target)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CONFLICT',
        'two series replace the same identity');
    }
    replacerByTarget.set(target, entry.macroSeriesIdentityId);
  }
  for (const entry of entries) {
    if (entry.status === 'REPLACED' && !replacerByTarget.has(entry.macroSeriesIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CONFLICT',
        'a REPLACED series must have exactly one replacing entry');
    }
  }
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE',
        'series replacement graph contains a cycle');
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    const target = byId.get(id).supersedesSeriesIdentityId;
    if (target !== null) visit(target);
    state.set(id, 2);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return {
    schemaVersion: MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registryPolicyVersion: MACRO_SERIES_REGISTRY_POLICY_VERSION,
    supersedesRegistryManifestId: registry.supersedesRegistryManifestId,
    orderedSeriesEntries: entries,
  };
}

const SERIES_STATUS_TRANSITIONS = Object.freeze({
  ACTIVE: Object.freeze(['ACTIVE', 'DEPRECATED', 'REPLACED']),
  DEPRECATED: Object.freeze(['DEPRECATED']),
  REPLACED: Object.freeze(['REPLACED']),
});

/**
 * Append-only verification of a fully read registry chain ordered from
 * genesis to tip. Historical entries are immutable except for the closed
 * monotone status transitions (explicit deprecation and explicit
 * replacement); removal, mutation and resurrection are refused.
 */
export function verifyMacroSeriesRegistryChainV1(chain) {
  const code = 'MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION';
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new MarketDataL3Error(code, 'registry chain must contain a genesis');
  }
  if (chain[0].registry.supersedesRegistryManifestId !== null) {
    throw new MarketDataL3Error(code, 'genesis registry cannot supersede another registry');
  }
  for (let index = 1; index < chain.length; index += 1) {
    const parent = chain[index - 1];
    const child = chain[index].registry;
    if (child.supersedesRegistryManifestId !== parent.registryManifestId) {
      throw new MarketDataL3Error(code, 'registry child does not reference its immediate parent');
    }
    const childById = new Map(child.orderedSeriesEntries
      .map((entry) => [entry.macroSeriesIdentityId, entry]));
    for (const parentEntry of parent.registry.orderedSeriesEntries) {
      const preserved = childById.get(parentEntry.macroSeriesIdentityId);
      if (!preserved) {
        throw new MarketDataL3Error(code, 'registry child removed a historical series entry');
      }
      if (preserved.canonicalSeriesCode !== parentEntry.canonicalSeriesCode
          || preserved.supersedesSeriesIdentityId !== parentEntry.supersedesSeriesIdentityId
          || preserved.replacementReason !== parentEntry.replacementReason) {
        throw new MarketDataL3Error(code, 'registry child mutated a historical series entry');
      }
      if (!SERIES_STATUS_TRANSITIONS[parentEntry.status].includes(preserved.status)) {
        throw new MarketDataL3Error(code,
          `series status cannot transition ${parentEntry.status} -> ${preserved.status}`);
      }
    }
  }
  return chain;
}

/* ------------------------------------------------------------------------- *
 * MacroObservationIdentityCore/1
 * ------------------------------------------------------------------------- */

const OBSERVATION_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'macroSeriesIdentityId', 'observationPeriodStart',
  'observationPeriodEnd', 'referencePeriod', 'unit', 'seasonalAdjustment',
]);

function lastDayOfMonth(monthKey) {
  const firstOfMonth = `${monthKey}-01`;
  const nextMonth = monthKey.slice(5, 7) === '12'
    ? `${String(Number(monthKey.slice(0, 4)) + 1).padStart(4, '0')}-01-01`
    : `${monthKey.slice(0, 4)}-${String(Number(monthKey.slice(5, 7)) + 1).padStart(2, '0')}-01`;
  assertCivilDate(firstOfMonth, 'referencePeriod month');
  return addDays(nextMonth, -1);
}

/**
 * Validate the period shape of one logical observation against the closed
 * frequency conventions. The identity never contains a value, a release
 * timestamp, a vintage order or any physical location.
 * @param {string} frequency
 */
export function assertMacroObservationPeriodShapeV1(frequency, periodStart, periodEnd, referencePeriod) {
  const code = 'MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID';
  assertCivilDate(periodStart, 'observationPeriodStart');
  assertCivilDate(periodEnd, 'observationPeriodEnd');
  if (periodEnd < periodStart) {
    throw new MarketDataL3Error(code, 'observationPeriodEnd cannot precede observationPeriodStart');
  }
  if (frequency === 'DAILY' || frequency === 'EVENT') {
    if (periodStart !== periodEnd || referencePeriod !== periodStart) {
      throw new MarketDataL3Error(code, `${frequency} observations pin exactly one civil date`);
    }
    return;
  }
  if (frequency === 'WEEKLY') {
    if (addDays(periodStart, 6) !== periodEnd || referencePeriod !== periodEnd) {
      throw new MarketDataL3Error(code, 'WEEKLY observations pin a seven-day period keyed by its end date');
    }
    return;
  }
  if (frequency === 'MONTHLY') {
    if (typeof referencePeriod !== 'string' || !/^\d{4}-\d{2}$/.test(referencePeriod)
        || periodStart !== `${referencePeriod}-01`
        || periodEnd !== lastDayOfMonth(referencePeriod)) {
      throw new MarketDataL3Error(code, 'MONTHLY observations pin one calendar month keyed YYYY-MM');
    }
    return;
  }
  throw new MarketDataL3Error('MARKET_DATA_MACRO_FREQUENCY_MISMATCH',
    'frequency has no closed observation period convention');
}

export function normalizeMacroObservationIdentityCoreV1(value) {
  const code = 'MARKET_DATA_MACRO_OBSERVATION_IDENTITY_INVALID';
  const identity = closedRecord(value, OBSERVATION_IDENTITY_FIELDS,
    MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION, code);
  assertSchemaVersion(identity, MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION);
  assertCasId(identity.macroSeriesIdentityId, 'macroSeriesIdentityId');
  assertCivilDate(identity.observationPeriodStart, 'observationPeriodStart');
  assertCivilDate(identity.observationPeriodEnd, 'observationPeriodEnd');
  if (identity.observationPeriodEnd < identity.observationPeriodStart) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID',
      'observationPeriodEnd cannot precede observationPeriodStart');
  }
  assertNonEmptyString(identity.referencePeriod, 'referencePeriod');
  if (!/^\d{4}(-\d{2}){1,2}$/.test(identity.referencePeriod)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID',
      'referencePeriod must be a closed YYYY-MM or YYYY-MM-DD key');
  }
  assertEnum(identity.unit, MACRO_UNITS, 'unit', code);
  assertEnum(identity.seasonalAdjustment, MACRO_SEASONAL_ADJUSTMENTS, 'seasonalAdjustment', code);
  return Object.fromEntries(OBSERVATION_IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

/** @param {unknown} value */
export function macroObservationIdentityIdFor(value) {
  const normalized = normalizeMacroObservationIdentityCoreV1(value);
  return canonicalHash(MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION, normalized);
}

/* ------------------------------------------------------------------------- *
 * MacroVintageIdentityCore/1 — the temporal identity of one vintage.
 * ------------------------------------------------------------------------- */

const VINTAGE_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'observationIdentityId', 'availableAt', 'vintageSequence',
  'sourceDocumentId',
]);

export function normalizeMacroVintageIdentityCoreV1(value) {
  const code = 'MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID';
  const identity = closedRecord(value, VINTAGE_IDENTITY_FIELDS,
    MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION, code);
  assertSchemaVersion(identity, MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION);
  assertCasId(identity.observationIdentityId, 'observationIdentityId');
  assertMacroUtcInstant(identity.availableAt, 'availableAt');
  assertSafeInteger(identity.vintageSequence, 'vintageSequence', { nonNegative: true });
  assertCasId(identity.sourceDocumentId, 'sourceDocumentId');
  return Object.fromEntries(VINTAGE_IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

/**
 * The vintage temporal identity is derived from exactly these four pinned
 * components — never from the value: two contradictory contents for the same
 * temporal identity must collide, not coexist.
 */
export function macroVintageIdentityFor(components) {
  return normalizeMacroVintageIdentityCoreV1({
    schemaVersion: MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION,
    observationIdentityId: components.observationIdentityId,
    availableAt: components.availableAt,
    vintageSequence: components.vintageSequence,
    sourceDocumentId: components.sourceDocumentId,
  });
}

/** @param {unknown} components */
export function macroVintageIdentityIdFor(components) {
  return canonicalHash(MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION,
    macroVintageIdentityFor(components));
}

/* ------------------------------------------------------------------------- *
 * MacroObservationVintageCore/1 — the content of one vintage.
 * ------------------------------------------------------------------------- */

const VINTAGE_CONTENT_FIELDS = Object.freeze([
  'schemaVersion', 'macroVintageIdentityId', 'observationIdentityId',
  'releaseTimestamp', 'availableAt', 'vintageSequence', 'value', 'revisionKind',
  'parentVintageId', 'vintageCompletenessClass', 'releaseTimeResolutionMode',
  'sourceDocumentId',
]);
const FIXED_POINT_FIELDS = Object.freeze(['atoms', 'scale']);

/** Closed lossless fixed-point wire value: {atoms: canonical string, scale}. */
export function normalizeMacroFixedPointValueV1(value, label = 'value') {
  const code = 'MARKET_DATA_MACRO_VINTAGE_INVALID';
  const fixed = closedRecord(value, FIXED_POINT_FIELDS, label, code);
  if (typeof fixed.atoms !== 'string' || !FIXED_POINT_ATOMS_PATTERN.test(fixed.atoms)
      || fixed.atoms === '-0' || fixed.atoms.length > MAX_FIXED_POINT_ATOM_CHARACTERS) {
    throw new MarketDataL3Error(code, `${label}.atoms must be a canonical bounded integer string`);
  }
  if (!Number.isSafeInteger(fixed.scale) || fixed.scale < 0 || fixed.scale > 12) {
    throw new MarketDataL3Error(code, `${label}.scale must be a safe integer between 0 and 12`);
  }
  return { atoms: fixed.atoms, scale: fixed.scale };
}

export function normalizeMacroObservationVintageCoreV1(value) {
  const code = 'MARKET_DATA_MACRO_VINTAGE_INVALID';
  const vintage = closedRecord(value, VINTAGE_CONTENT_FIELDS,
    MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION, code);
  assertSchemaVersion(vintage, MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION);
  assertCasId(vintage.macroVintageIdentityId, 'macroVintageIdentityId');
  assertCasId(vintage.observationIdentityId, 'observationIdentityId');
  assertMacroUtcInstant(vintage.releaseTimestamp, 'releaseTimestamp', true);
  assertMacroUtcInstant(vintage.availableAt, 'availableAt');
  assertSafeInteger(vintage.vintageSequence, 'vintageSequence', { nonNegative: true });
  assertEnum(vintage.revisionKind, MACRO_REVISION_KINDS, 'revisionKind', code);
  assertCasId(vintage.parentVintageId, 'parentVintageId', true);
  assertEnum(vintage.vintageCompletenessClass, MACRO_VINTAGE_COMPLETENESS_CLASSES,
    'vintageCompletenessClass', 'MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN');
  assertEnum(vintage.releaseTimeResolutionMode, MACRO_RELEASE_TIME_RESOLUTION_MODES,
    'releaseTimeResolutionMode', code);
  if (vintage.releaseTimeResolutionMode === 'UNKNOWN_REJECTED') {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_TIMESTAMP_UNKNOWN',
      'a vintage with an unknown release time cannot be stored as available');
  }
  if (vintage.releaseTimeResolutionMode === 'OFFICIAL_TIMESTAMP') {
    if (vintage.releaseTimestamp === null) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_TIMESTAMP_UNKNOWN',
        'OFFICIAL_TIMESTAMP requires the official release timestamp');
    }
    if (vintage.availableAt !== vintage.releaseTimestamp) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
        'availableAt must equal the normalized official release timestamp');
    }
  } else if (vintage.releaseTimestamp !== null
      && vintage.availableAt < vintage.releaseTimestamp) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
      'availableAt cannot precede the official release timestamp');
  }
  if (vintage.revisionKind === 'INITIAL') {
    if (vintage.parentVintageId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH',
        'INITIAL vintages cannot reference a parent vintage');
    }
    if (vintage.vintageSequence !== 0) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID',
        'INITIAL vintages pin sequence zero');
    }
  } else {
    if (vintage.parentVintageId === null) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH',
        `${vintage.revisionKind} vintages require a parent vintage`);
    }
    if (vintage.parentVintageId === vintage.macroVintageIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CYCLE',
        'a vintage cannot be its own parent');
    }
    if (vintage.vintageSequence === 0) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID',
        'non-initial vintages require a strictly positive sequence');
    }
  }
  const normalizedValue = vintage.revisionKind === 'WITHDRAWAL'
    ? (() => {
      if (vintage.value !== null) {
        throw new MarketDataL3Error(code, 'WITHDRAWAL pins the closed null value representation');
      }
      return null;
    })()
    : normalizeMacroFixedPointValueV1(vintage.value);
  assertCasId(vintage.sourceDocumentId, 'sourceDocumentId');
  const expectedIdentityId = macroVintageIdentityIdFor({
    observationIdentityId: vintage.observationIdentityId,
    availableAt: vintage.availableAt,
    vintageSequence: vintage.vintageSequence,
    sourceDocumentId: vintage.sourceDocumentId,
  });
  if (vintage.macroVintageIdentityId !== expectedIdentityId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_IDENTITY_INVALID',
      'macroVintageIdentityId diverges from the recomputed temporal identity');
  }
  return {
    schemaVersion: MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
    macroVintageIdentityId: vintage.macroVintageIdentityId,
    observationIdentityId: vintage.observationIdentityId,
    releaseTimestamp: vintage.releaseTimestamp,
    availableAt: vintage.availableAt,
    vintageSequence: vintage.vintageSequence,
    value: normalizedValue,
    revisionKind: vintage.revisionKind,
    parentVintageId: vintage.parentVintageId,
    vintageCompletenessClass: vintage.vintageCompletenessClass,
    releaseTimeResolutionMode: vintage.releaseTimeResolutionMode,
    sourceDocumentId: vintage.sourceDocumentId,
  };
}

/* ------------------------------------------------------------------------- *
 * MacroIngestionPolicy/1 — the closed, non-permissive V1 singleton.
 * ------------------------------------------------------------------------- */

const RELEASE_TIME_RULE_FIELDS = Object.freeze([
  'sourceAuthority', 'canonicalSeriesCode', 'localTime', 'timezone',
  'effectiveFrom', 'effectiveThrough', 'resolutionMode',
]);

function releaseRule(sourceAuthority, canonicalSeriesCode, localTime) {
  return Object.freeze({
    sourceAuthority,
    canonicalSeriesCode,
    localTime,
    timezone: 'AMERICA_NEW_YORK',
    effectiveFrom: '2007-01-01',
    effectiveThrough: null,
    resolutionMode: 'SERIES_AUTHORITY_POLICY',
  });
}

export const MACRO_INGESTION_POLICY_VALUES = Object.freeze({
  policyVersion: MACRO_INGESTION_POLICY_VERSION,
  jurisdictionCode: 'UNITED_STATES',
  currencyCode: 'USD',
  allowedSourceAuthorities: Object.freeze(['BLS', 'FRB', 'FRED_ALFRED', 'NY_FED', 'US_TREASURY']),
  allowedSeriesCodes: Object.freeze([
    'US.BLS.CPIAUCSL', 'US.BLS.ICSA', 'US.BLS.UNRATE', 'US.FOMC.DECISION',
    'US.FRB.DFEDTARL', 'US.FRB.DFEDTARU', 'US.NYFED.EFFR', 'US.NYFED.SOFR',
    'US.TREAS.DGS10', 'US.TREAS.DGS2', 'US.TREAS.DGS30', 'US.TREAS.DGS3MO',
    'US.TREAS.DGS5',
  ]),
  allowedFrequencies: Object.freeze(['DAILY', 'EVENT', 'MONTHLY', 'WEEKLY']),
  allowedUnits: Object.freeze([
    'BASIS_POINTS', 'COUNT', 'EVENT_VALUE', 'INDEX', 'PERCENT', 'RATE_RANGE_BOUND',
  ]),
  allowedSeasonalAdjustments: Object.freeze([
    'NOT_APPLICABLE', 'NOT_SEASONALLY_ADJUSTED', 'SEASONALLY_ADJUSTED',
  ]),
  allowedRevisionKinds: Object.freeze([
    'BENCHMARK_REVISION', 'CORRECTION', 'INITIAL', 'REVISION', 'WITHDRAWAL',
  ]),
  allowedCompletenessClasses: Object.freeze([
    'FINAL_ONLY', 'PUBLICATION_ATTESTED', 'VINTAGE_COMPLETE', 'VINTAGE_PARTIAL',
  ]),
  revisionSensitiveSeriesCodes: Object.freeze([
    'US.BLS.CPIAUCSL', 'US.BLS.ICSA', 'US.BLS.UNRATE',
  ]),
  publicationAttestedSeriesCodes: Object.freeze(['US.FOMC.DECISION']),
  releaseTimeRules: Object.freeze([
    releaseRule('BLS', 'US.BLS.CPIAUCSL', '08:30'),
    releaseRule('BLS', 'US.BLS.ICSA', '08:30'),
    releaseRule('BLS', 'US.BLS.UNRATE', '08:30'),
    releaseRule('FRB', 'US.FOMC.DECISION', '14:00'),
    releaseRule('FRB', 'US.FRB.DFEDTARL', '14:00'),
    releaseRule('FRB', 'US.FRB.DFEDTARU', '14:00'),
    releaseRule('NY_FED', 'US.NYFED.EFFR', '09:00'),
    releaseRule('NY_FED', 'US.NYFED.SOFR', '08:00'),
    releaseRule('US_TREASURY', 'US.TREAS.DGS10', '16:00'),
    releaseRule('US_TREASURY', 'US.TREAS.DGS2', '16:00'),
    releaseRule('US_TREASURY', 'US.TREAS.DGS30', '16:00'),
    releaseRule('US_TREASURY', 'US.TREAS.DGS3MO', '16:00'),
    releaseRule('US_TREASURY', 'US.TREAS.DGS5', '16:00'),
  ]),
  unknownReleaseTimePolicy: 'REJECT',
  latestReferencePolicy: 'FORBIDDEN',
  networkDuringComputationPolicy: 'FORBIDDEN',
  registryMutationPolicy: 'APPEND_ONLY',
  vintageConflictPolicy: 'REJECT',
  vintageCyclePolicy: 'FORBIDDEN',
  duplicateObservationPolicy: 'REJECT',
  fixedPointPolicy: 'CANONICAL_ATOMS_SCALE',
  canonicalOrderingPolicy: 'SERIES_OBSERVATION_AVAILABLE_AT_SEQUENCE_ID',
});

const POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MACRO_INGESTION_POLICY_VALUES),
]);

/**
 * The V1 policy is a fully closed singleton: every permissive mutation
 * (wildcard release rule, generic default hour, allowed latest, allowed
 * network, mutable registry, tolerated conflicts or cycles) diverges from the
 * closed values and is rejected byte-for-byte.
 */
export function normalizeMacroIngestionPolicyV1(value) {
  const code = 'MARKET_DATA_MACRO_POLICY_INVALID';
  const policy = closedRecord(value, POLICY_FIELDS, MACRO_INGESTION_POLICY_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, MACRO_INGESTION_POLICY_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(MACRO_INGESTION_POLICY_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `policy field ${field} diverges from closed V1`);
    }
  }
  for (const [index, rule] of policy.releaseTimeRules.entries()) {
    closedRecord(rule, RELEASE_TIME_RULE_FIELDS, `releaseTimeRules[${index}]`, code);
  }
  return {
    schemaVersion: MACRO_INGESTION_POLICY_SCHEMA_VERSION,
    ...copyClosed(MACRO_INGESTION_POLICY_VALUES),
  };
}

/**
 * Deterministic lookup of the single release rule pinned for one authority +
 * canonical code whose effectivity covers the civil date. Fail-closed: no
 * generic fallback rule exists.
 */
export function findMacroReleaseTimeRuleV1(policy, sourceAuthority, canonicalSeriesCode, civilDate) {
  const matches = policy.releaseTimeRules.filter((rule) =>
    rule.sourceAuthority === sourceAuthority
    && rule.canonicalSeriesCode === canonicalSeriesCode
    && rule.effectiveFrom <= civilDate
    && (rule.effectiveThrough === null || civilDate <= rule.effectiveThrough));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_POLICY_INVALID',
      'overlapping release time rules for one series');
  }
  return matches[0];
}

/* ------------------------------------------------------------------------- *
 * Canonical vintage ordering and manifests.
 * ------------------------------------------------------------------------- */

/**
 * Total canonical vintage order:
 * series, periodStart, periodEnd, observationId, availableAt, sequence,
 * vintage identity id, vintage content id.
 */
export function compareMacroVintageOrderKeys(left, right) {
  for (const field of ['macroSeriesIdentityId', 'observationPeriodStart',
    'observationPeriodEnd', 'observationIdentityId', 'availableAt']) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  if (left.vintageSequence !== right.vintageSequence) {
    return left.vintageSequence < right.vintageSequence ? -1 : 1;
  }
  for (const field of ['macroVintageIdentityId', 'observationVintageId']) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

const VINTAGE_SET_FIELDS = Object.freeze([
  'schemaVersion', 'macroSeriesRegistryManifestId', 'macroIngestionPolicyId',
  'supersedesVintageSetManifestId', 'orderedObservationEntries',
  'orderedVintageIds', 'observationCount', 'vintageCount', 'firstAvailableAt',
  'lastAvailableAt', 'orderedVintageIdentityDigest',
]);
const OBSERVATION_ENTRY_FIELDS = Object.freeze([
  'observationIdentityId', 'macroSeriesIdentityId', 'observationPeriodStart',
  'observationPeriodEnd', 'orderedVintages',
]);
const VINTAGE_ENTRY_FIELDS = Object.freeze([
  'observationVintageId', 'macroVintageIdentityId', 'availableAt', 'vintageSequence',
]);

function normalizeVintageEntry(value, label) {
  const code = 'MARKET_DATA_MACRO_VINTAGE_INVALID';
  const entry = closedRecord(value, VINTAGE_ENTRY_FIELDS, label, code);
  assertCasId(entry.observationVintageId, `${label}.observationVintageId`);
  assertCasId(entry.macroVintageIdentityId, `${label}.macroVintageIdentityId`);
  assertMacroUtcInstant(entry.availableAt, `${label}.availableAt`);
  assertSafeInteger(entry.vintageSequence, `${label}.vintageSequence`, { nonNegative: true });
  return Object.fromEntries(VINTAGE_ENTRY_FIELDS.map((field) => [field, entry[field]]));
}

function normalizeObservationEntry(value, index) {
  const label = `orderedObservationEntries[${index}]`;
  const code = 'MARKET_DATA_MACRO_VINTAGE_INVALID';
  const entry = closedRecord(value, OBSERVATION_ENTRY_FIELDS, label, code);
  assertCasId(entry.observationIdentityId, `${label}.observationIdentityId`);
  assertCasId(entry.macroSeriesIdentityId, `${label}.macroSeriesIdentityId`);
  assertCivilDate(entry.observationPeriodStart, `${label}.observationPeriodStart`);
  assertCivilDate(entry.observationPeriodEnd, `${label}.observationPeriodEnd`);
  if (!Array.isArray(entry.orderedVintages) || entry.orderedVintages.length === 0) {
    throw new MarketDataL3Error(code, `${label}.orderedVintages must be a non-empty array`);
  }
  const vintages = entry.orderedVintages
    .map((vintage, vintageIndex) => normalizeVintageEntry(vintage, `${label}.orderedVintages[${vintageIndex}]`));
  return {
    observationIdentityId: entry.observationIdentityId,
    macroSeriesIdentityId: entry.macroSeriesIdentityId,
    observationPeriodStart: entry.observationPeriodStart,
    observationPeriodEnd: entry.observationPeriodEnd,
    orderedVintages: vintages,
  };
}

/** Flatten observation entries into total canonical order keys. */
export function macroVintageSetFlatEntriesV1(observationEntries) {
  const flat = [];
  for (const observation of observationEntries) {
    for (const vintage of observation.orderedVintages) {
      flat.push({
        macroSeriesIdentityId: observation.macroSeriesIdentityId,
        observationPeriodStart: observation.observationPeriodStart,
        observationPeriodEnd: observation.observationPeriodEnd,
        observationIdentityId: observation.observationIdentityId,
        availableAt: vintage.availableAt,
        vintageSequence: vintage.vintageSequence,
        macroVintageIdentityId: vintage.macroVintageIdentityId,
        observationVintageId: vintage.observationVintageId,
      });
    }
  }
  return flat;
}

/** sha256 canonical digest of the ordered vintage temporal identities. */
export function macroOrderedVintageIdentityDigestV1(flatEntries) {
  return canonicalDigest(flatEntries.map((entry) => entry.macroVintageIdentityId));
}

/** sha256 canonical digest of the ordered observation identities. */
export function macroOrderedObservationIdentityDigestV1(observationEntries) {
  return canonicalDigest(observationEntries.map((entry) => entry.observationIdentityId));
}

/** sha256 canonical digest of the ordered series identities. */
export function macroOrderedSeriesIdentityDigestV1(seriesEntries) {
  return canonicalDigest(seriesEntries.map((entry) => entry.macroSeriesIdentityId));
}

/**
 * Structural validation of one vintage set manifest. Counters, bounds and the
 * ordered digest are always recomputed from the entries and never trusted.
 */
export function normalizeMacroVintageSetManifestV1(value) {
  const code = 'MARKET_DATA_MACRO_VINTAGE_INVALID';
  const manifest = closedRecord(value, VINTAGE_SET_FIELDS,
    MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION, code);
  assertSchemaVersion(manifest, MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION);
  assertCasId(manifest.macroSeriesRegistryManifestId, 'macroSeriesRegistryManifestId');
  assertCasId(manifest.macroIngestionPolicyId, 'macroIngestionPolicyId');
  assertCasId(manifest.supersedesVintageSetManifestId, 'supersedesVintageSetManifestId', true);
  if (!Array.isArray(manifest.orderedObservationEntries)) {
    throw new MarketDataL3Error(code, 'orderedObservationEntries must be an array');
  }
  const observationEntries = manifest.orderedObservationEntries.map(normalizeObservationEntry);
  const flat = macroVintageSetFlatEntriesV1(observationEntries);
  for (let index = 1; index < flat.length; index += 1) {
    if (compareMacroVintageOrderKeys(flat[index - 1], flat[index]) >= 0) {
      throw new MarketDataL3Error(code, 'vintage entries must follow the total canonical order');
    }
  }
  const seenObservations = new Set();
  for (const entry of observationEntries) {
    if (seenObservations.has(entry.observationIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CONFLICT',
        'observation identity appears in two observation entries');
    }
    seenObservations.add(entry.observationIdentityId);
  }
  if (!Array.isArray(manifest.orderedVintageIds)
      || manifest.orderedVintageIds.length !== flat.length
      || flat.some((entry, index) => manifest.orderedVintageIds[index] !== entry.observationVintageId)) {
    throw new MarketDataL3Error(code, 'orderedVintageIds diverge from the ordered observation entries');
  }
  if (manifest.observationCount !== observationEntries.length
      || manifest.vintageCount !== flat.length) {
    throw new MarketDataL3Error(code, 'vintage set counters diverge from the recomputed entries');
  }
  const availableAts = flat.map((entry) => entry.availableAt).sort();
  const expectedFirst = availableAts.length === 0 ? null : availableAts[0];
  const expectedLast = availableAts.length === 0 ? null : availableAts[availableAts.length - 1];
  if (manifest.firstAvailableAt !== expectedFirst || manifest.lastAvailableAt !== expectedLast) {
    throw new MarketDataL3Error(code, 'availableAt bounds diverge from the recomputed entries');
  }
  if (manifest.orderedVintageIdentityDigest !== macroOrderedVintageIdentityDigestV1(flat)) {
    throw new MarketDataL3Error(code, 'orderedVintageIdentityDigest diverges from the recomputed digest');
  }
  return {
    schemaVersion: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
    macroSeriesRegistryManifestId: manifest.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: manifest.macroIngestionPolicyId,
    supersedesVintageSetManifestId: manifest.supersedesVintageSetManifestId,
    orderedObservationEntries: observationEntries,
    orderedVintageIds: flat.map((entry) => entry.observationVintageId),
    observationCount: observationEntries.length,
    vintageCount: flat.length,
    firstAvailableAt: expectedFirst,
    lastAvailableAt: expectedLast,
    orderedVintageIdentityDigest: macroOrderedVintageIdentityDigestV1(flat),
  };
}

/* ------------------------------------------------------------------------- *
 * MacroDatasetSnapshotManifest/1
 * ------------------------------------------------------------------------- */

const DATASET_SNAPSHOT_FIELDS = Object.freeze([
  'schemaVersion', 'macroIngestionPolicyId', 'macroSeriesRegistryManifestId',
  'macroVintageSetManifestId', 'jurisdictionCode', 'currencyCode', 'seriesCount',
  'observationCount', 'vintageCount', 'firstAvailableAt', 'lastAvailableAt',
  'emptySnapshot', 'orderedSeriesIdentityDigest',
  'orderedObservationIdentityDigest', 'orderedVintageIdentityDigest',
]);

export function normalizeMacroDatasetSnapshotManifestV1(value) {
  const code = 'MARKET_DATA_MACRO_SNAPSHOT_INVALID';
  const snapshot = closedRecord(value, DATASET_SNAPSHOT_FIELDS,
    MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION, code);
  assertSchemaVersion(snapshot, MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION);
  for (const field of ['macroIngestionPolicyId', 'macroSeriesRegistryManifestId',
    'macroVintageSetManifestId']) assertCasId(snapshot[field], field);
  assertEnum(snapshot.jurisdictionCode, MACRO_JURISDICTION_CODES, 'jurisdictionCode', code);
  assertEnum(snapshot.currencyCode, MACRO_CURRENCY_CODES, 'currencyCode', code);
  for (const field of ['seriesCount', 'observationCount', 'vintageCount']) {
    assertSafeInteger(snapshot[field], field, { nonNegative: true });
  }
  assertMacroUtcInstant(snapshot.firstAvailableAt, 'firstAvailableAt', true);
  assertMacroUtcInstant(snapshot.lastAvailableAt, 'lastAvailableAt', true);
  if ((snapshot.firstAvailableAt === null) !== (snapshot.lastAvailableAt === null)
      || (snapshot.vintageCount === 0) !== (snapshot.firstAvailableAt === null)
      || (snapshot.firstAvailableAt !== null
        && snapshot.firstAvailableAt > snapshot.lastAvailableAt)) {
    throw new MarketDataL3Error(code, 'availableAt bounds diverge from vintageCount');
  }
  if (typeof snapshot.emptySnapshot !== 'boolean'
      || snapshot.emptySnapshot !== (snapshot.vintageCount === 0)) {
    throw new MarketDataL3Error(code, 'emptySnapshot flag diverges from vintageCount');
  }
  for (const field of ['orderedSeriesIdentityDigest', 'orderedObservationIdentityDigest',
    'orderedVintageIdentityDigest']) assertCasId(snapshot[field], field);
  return Object.fromEntries(DATASET_SNAPSHOT_FIELDS.map((field) => [field, snapshot[field]]));
}
