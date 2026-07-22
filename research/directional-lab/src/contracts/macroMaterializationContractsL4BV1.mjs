/**
 * L4B-I2 closed macro materialization contracts: as-of resolution policy,
 * append-only release calendar registry, dataset binding and materialization
 * report. No macro features are computed here. No network, no wall clock, no
 * machine timezone and no "latest" reference is ever consulted.
 */

import {
  MarketDataL3Error,
  assertCasId,
  assertEnum,
  assertNonEmptyString,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  assertUtcInstant,
  canonicalDigest,
} from './marketDataL3CommonV1.mjs';
import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import {
  MACRO_CURRENCY_CODES,
  MACRO_JURISDICTION_CODES,
  MACRO_SOURCE_AUTHORITIES,
} from './macroIngestionContractsL4BV1.mjs';

export const MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION = 'MacroAsOfResolutionPolicy/1';
export const MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION =
  'MacroReleaseCalendarRegistryManifest/1';
export const MACRO_DATASET_BINDING_SCHEMA_VERSION = 'MacroDatasetBinding/1';
export const MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION = 'MacroMaterializationReport/1';

export const MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS = Object.freeze([
  MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_DATASET_BINDING_SCHEMA_VERSION,
  MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
]);

export const MACRO_AS_OF_RESOLUTION_POLICY_VERSION = 'MACRO_AS_OF_RESOLUTION_L4B_I2_V1';
export const MACRO_RELEASE_CALENDAR_REGISTRY_POLICY_VERSION = 'MACRO_RELEASE_CALENDAR_L4B_I2_V1';
export const MACRO_DATASET_BINDING_POLICY_VERSION = 'MACRO_DATASET_BINDING_L4B_I2_V1';

/** Logical identity projection label — not a snapshots-namespace schema. */
export const MACRO_RELEASE_EVENT_IDENTITY_PROJECTION = 'MacroReleaseEventIdentityProjection/1';

export const MACRO_AS_OF_RESOLUTION_STATUSES = Object.freeze([
  'NOT_AVAILABLE', 'RESOLVED', 'WITHDRAWN',
]);
export const MACRO_RELEASE_EVENT_STATUSES = Object.freeze([
  'CANCELLED', 'DELAYED', 'RELEASED', 'RESCHEDULED', 'SCHEDULED',
]);
export const MACRO_RELEASE_KINDS = Object.freeze([
  'BENCHMARK', 'PRELIMINARY', 'REGULAR', 'SPECIAL',
]);
export const MACRO_BINDING_TEMPORAL_CAPABILITIES = Object.freeze([
  'POINT_IN_TIME_VINTAGE_COMPLETE',
  'POINT_IN_TIME_VINTAGE_PARTIAL',
]);
export const MACRO_CALENDAR_UPDATE_REASONS = Object.freeze([
  'ACTUAL_RELEASE', 'CANCELLATION', 'DELAY', 'INITIAL_SCHEDULE', 'RESCHEDULE',
]);

function keyLabel(key) {
  if (typeof key === 'string') return key;
  const global = Symbol.keyFor(key);
  return global === undefined ? `Symbol(${key.description ?? ''})` : `Symbol.for(${JSON.stringify(global)})`;
}

/** Reject inherited records, Symbols, non-enumerable properties and accessors. */
export function closedMacroRecord(value, fields, label, code) {
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

/**
 * Macro timestamps additionally pin the millisecond wire form.
 * @param {unknown} value @param {string} label @param {boolean} [nullable]
 */
export function assertMacroMaterializationUtcInstant(value, label, nullable = false) {
  assertUtcInstant(value, label, nullable);
  if (value !== null && !/\.\d{3}Z$/.test(/** @type {string} */ (value))) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_KNOWLEDGE_CUTOFF_INVALID',
      `${label} must pin the canonical millisecond UTC form`);
  }
}

/* ------------------------------------------------------------------------- *
 * MacroAsOfResolutionPolicy/1 — closed singleton.
 * ------------------------------------------------------------------------- */

export const MACRO_AS_OF_RESOLUTION_POLICY_VALUES = Object.freeze({
  policyVersion: MACRO_AS_OF_RESOLUTION_POLICY_VERSION,
  resolutionMode: 'EXPLICIT_AS_OF_ON_PINNED_VINTAGE_SET',
  registrySelectionPolicy: 'EXPLICIT_PIN_ONLY',
  vintageSelectionPolicy: 'MAX_AVAILABLE_AT_THEN_SEQUENCE_ON_SINGLE_CAUSAL_CHAIN',
  cutoffComparison: 'AVAILABLE_AT_LESS_THAN_OR_EQUAL',
  conflictPolicy: 'REJECT',
  cyclePolicy: 'FORBIDDEN',
  missingVintagePolicy: 'RETURN_NOT_AVAILABLE',
  withdrawalPolicy: 'WITHDRAWAL_REMOVES_AVAILABILITY_FROM_ITS_AVAILABLE_AT',
  restorationAfterWithdrawalPolicy: 'FORBIDDEN_IN_V1',
  sameTimestampTiePolicy: 'HIGHER_SEQUENCE_ONLY_IF_SAME_CAUSAL_CHAIN',
  latestReferencePolicy: 'FORBIDDEN',
  futureObjectPolicy: 'IGNORE_UNPINNED_AND_POST_CUTOFF',
  canonicalOrderingPolicy: 'AVAILABLE_AT_SEQUENCE_ID',
});

const AS_OF_POLICY_FIELDS = Object.freeze([
  'schemaVersion', ...Object.keys(MACRO_AS_OF_RESOLUTION_POLICY_VALUES),
]);

export function normalizeMacroAsOfResolutionPolicyV1(value) {
  const code = 'MARKET_DATA_MACRO_AS_OF_POLICY_INVALID';
  const policy = closedMacroRecord(value, AS_OF_POLICY_FIELDS,
    MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(MACRO_AS_OF_RESOLUTION_POLICY_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `policy field ${field} diverges from closed V1`);
    }
  }
  return {
    schemaVersion: MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
    ...copyClosed(MACRO_AS_OF_RESOLUTION_POLICY_VALUES),
  };
}

/* ------------------------------------------------------------------------- *
 * Release event logical identity (projection, not a snapshots schema).
 * ------------------------------------------------------------------------- */

const RELEASE_EVENT_IDENTITY_FIELDS = Object.freeze([
  'schemaVersion', 'macroSeriesIdentityId', 'referencePeriod', 'releaseKind',
  'releaseOrdinal', 'releaseAuthority',
]);

export function normalizeMacroReleaseEventIdentityProjectionV1(value) {
  const code = 'MARKET_DATA_MACRO_RELEASE_EVENT_IDENTITY_MISMATCH';
  const identity = closedMacroRecord(value, RELEASE_EVENT_IDENTITY_FIELDS,
    MACRO_RELEASE_EVENT_IDENTITY_PROJECTION, code);
  assertSchemaVersion(identity, MACRO_RELEASE_EVENT_IDENTITY_PROJECTION);
  assertCasId(identity.macroSeriesIdentityId, 'macroSeriesIdentityId');
  assertNonEmptyString(identity.referencePeriod, 'referencePeriod');
  if (!/^\d{4}(-\d{2}){1,2}$/.test(identity.referencePeriod)) {
    throw new MarketDataL3Error(code, 'referencePeriod must be a closed YYYY-MM or YYYY-MM-DD key');
  }
  assertEnum(identity.releaseKind, MACRO_RELEASE_KINDS, 'releaseKind', code);
  assertSafeInteger(identity.releaseOrdinal, 'releaseOrdinal', { nonNegative: true });
  assertEnum(identity.releaseAuthority, MACRO_SOURCE_AUTHORITIES, 'releaseAuthority', code);
  return Object.fromEntries(RELEASE_EVENT_IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

/** Logical release-event identity id — schedule timestamp is intentionally absent. */
export function macroReleaseEventIdentityIdFor(components) {
  return canonicalHash(MACRO_RELEASE_EVENT_IDENTITY_PROJECTION,
    normalizeMacroReleaseEventIdentityProjectionV1({
      schemaVersion: MACRO_RELEASE_EVENT_IDENTITY_PROJECTION,
      macroSeriesIdentityId: components.macroSeriesIdentityId,
      referencePeriod: components.referencePeriod,
      releaseKind: components.releaseKind,
      releaseOrdinal: components.releaseOrdinal,
      releaseAuthority: components.releaseAuthority,
    }));
}

/* ------------------------------------------------------------------------- *
 * MacroReleaseCalendarRegistryManifest/1
 * ------------------------------------------------------------------------- */

const CALENDAR_REGISTRY_FIELDS = Object.freeze([
  'schemaVersion', 'registryPolicyVersion', 'macroSeriesRegistryManifestId',
  'jurisdictionCode', 'currencyCode', 'supersedesRegistryManifestId',
  'orderedReleaseEventVersions', 'eventVersionCount',
  'orderedReleaseEventVersionDigest',
]);

const RELEASE_EVENT_VERSION_FIELDS = Object.freeze([
  'releaseEventVersionId', 'releaseEventIdentityId', 'macroSeriesIdentityId',
  'referencePeriod', 'releaseKind', 'releaseOrdinal', 'releaseAuthority',
  'eventStatus', 'scheduledReleaseTimestamp', 'actualReleaseTimestamp',
  'availableAt', 'calendarKnowledgeAvailableAt', 'sourceDocumentId',
  'supersedesReleaseEventVersionId', 'updateReason',
]);

export function compareMacroReleaseEventVersions(left, right) {
  for (const field of ['macroSeriesIdentityId', 'referencePeriod', 'releaseKind']) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  if (left.releaseOrdinal !== right.releaseOrdinal) {
    return left.releaseOrdinal < right.releaseOrdinal ? -1 : 1;
  }
  if (left.releaseEventIdentityId < right.releaseEventIdentityId) return -1;
  if (left.releaseEventIdentityId > right.releaseEventIdentityId) return 1;
  if (left.calendarKnowledgeAvailableAt < right.calendarKnowledgeAvailableAt) return -1;
  if (left.calendarKnowledgeAvailableAt > right.calendarKnowledgeAvailableAt) return 1;
  if (left.releaseEventVersionId < right.releaseEventVersionId) return -1;
  if (left.releaseEventVersionId > right.releaseEventVersionId) return 1;
  return 0;
}

function expectedReleaseEventVersionId(version) {
  const payload = {
    releaseEventIdentityId: version.releaseEventIdentityId,
    macroSeriesIdentityId: version.macroSeriesIdentityId,
    referencePeriod: version.referencePeriod,
    releaseKind: version.releaseKind,
    releaseOrdinal: version.releaseOrdinal,
    releaseAuthority: version.releaseAuthority,
    eventStatus: version.eventStatus,
    scheduledReleaseTimestamp: version.scheduledReleaseTimestamp,
    actualReleaseTimestamp: version.actualReleaseTimestamp,
    availableAt: version.availableAt,
    calendarKnowledgeAvailableAt: version.calendarKnowledgeAvailableAt,
    sourceDocumentId: version.sourceDocumentId,
    supersedesReleaseEventVersionId: version.supersedesReleaseEventVersionId,
    updateReason: version.updateReason,
  };
  return canonicalDigest(payload);
}

function normalizeReleaseEventVersion(value, index) {
  const label = `orderedReleaseEventVersions[${index}]`;
  const code = 'MARKET_DATA_MACRO_RELEASE_CALENDAR_INVALID';
  const entry = closedMacroRecord(value, RELEASE_EVENT_VERSION_FIELDS, label, code);
  assertCasId(entry.releaseEventVersionId, `${label}.releaseEventVersionId`);
  assertCasId(entry.releaseEventIdentityId, `${label}.releaseEventIdentityId`);
  assertCasId(entry.macroSeriesIdentityId, `${label}.macroSeriesIdentityId`);
  assertNonEmptyString(entry.referencePeriod, `${label}.referencePeriod`);
  assertEnum(entry.releaseKind, MACRO_RELEASE_KINDS, `${label}.releaseKind`, code);
  assertSafeInteger(entry.releaseOrdinal, `${label}.releaseOrdinal`, { nonNegative: true });
  assertEnum(entry.releaseAuthority, MACRO_SOURCE_AUTHORITIES, `${label}.releaseAuthority`, code);
  assertEnum(entry.eventStatus, MACRO_RELEASE_EVENT_STATUSES, `${label}.eventStatus`, code);
  assertMacroMaterializationUtcInstant(entry.scheduledReleaseTimestamp,
    `${label}.scheduledReleaseTimestamp`);
  assertMacroMaterializationUtcInstant(entry.actualReleaseTimestamp,
    `${label}.actualReleaseTimestamp`, true);
  assertMacroMaterializationUtcInstant(entry.availableAt, `${label}.availableAt`, true);
  assertMacroMaterializationUtcInstant(entry.calendarKnowledgeAvailableAt,
    `${label}.calendarKnowledgeAvailableAt`);
  assertCasId(entry.sourceDocumentId, `${label}.sourceDocumentId`);
  assertCasId(entry.supersedesReleaseEventVersionId,
    `${label}.supersedesReleaseEventVersionId`, true);
  assertEnum(entry.updateReason, MACRO_CALENDAR_UPDATE_REASONS, `${label}.updateReason`, code);

  const expectedIdentityId = macroReleaseEventIdentityIdFor(entry);
  if (entry.releaseEventIdentityId !== expectedIdentityId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_EVENT_IDENTITY_MISMATCH',
      `${label}.releaseEventIdentityId diverges from the recomputed logical identity`);
  }

  if (entry.eventStatus === 'SCHEDULED') {
    if (entry.actualReleaseTimestamp !== null || entry.availableAt !== null) {
      throw new MarketDataL3Error(code,
        `${label} SCHEDULED versions cannot claim actual release or availability`);
    }
    if (entry.updateReason !== 'INITIAL_SCHEDULE' && entry.supersedesReleaseEventVersionId === null) {
      throw new MarketDataL3Error(code, `${label} genesis SCHEDULED requires INITIAL_SCHEDULE`);
    }
  }
  if (entry.eventStatus === 'RELEASED') {
    if (entry.actualReleaseTimestamp === null || entry.availableAt === null) {
      throw new MarketDataL3Error(code,
        `${label} RELEASED versions require actualReleaseTimestamp and availableAt`);
    }
    if (entry.availableAt < entry.actualReleaseTimestamp) {
      throw new MarketDataL3Error(code,
        `${label} availableAt cannot precede actualReleaseTimestamp`);
    }
    if (entry.updateReason !== 'ACTUAL_RELEASE') {
      throw new MarketDataL3Error(code, `${label} RELEASED requires ACTUAL_RELEASE`);
    }
  }
  if (entry.eventStatus === 'RESCHEDULED' && entry.updateReason !== 'RESCHEDULE') {
    throw new MarketDataL3Error(code, `${label} RESCHEDULED requires RESCHEDULE`);
  }
  if (entry.eventStatus === 'DELAYED' && entry.updateReason !== 'DELAY') {
    throw new MarketDataL3Error(code, `${label} DELAYED requires DELAY`);
  }
  if (entry.eventStatus === 'CANCELLED' && entry.updateReason !== 'CANCELLATION') {
    throw new MarketDataL3Error(code, `${label} CANCELLED requires CANCELLATION`);
  }
  if (entry.supersedesReleaseEventVersionId === null && entry.updateReason !== 'INITIAL_SCHEDULE') {
    throw new MarketDataL3Error(code,
      `${label} non-superseding versions must use INITIAL_SCHEDULE`);
  }
  if (entry.supersedesReleaseEventVersionId === entry.releaseEventVersionId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_CYCLE',
      `${label} cannot supersede itself`);
  }

  const expectedVersionId = expectedReleaseEventVersionId(entry);
  if (entry.releaseEventVersionId !== expectedVersionId) {
    throw new MarketDataL3Error(code,
      `${label}.releaseEventVersionId diverges from the recomputed content digest`);
  }

  return Object.fromEntries(RELEASE_EVENT_VERSION_FIELDS.map((field) => [field, entry[field]]));
}

export function macroOrderedReleaseEventVersionDigestV1(versions) {
  return canonicalDigest(versions.map((entry) => entry.releaseEventVersionId));
}

/**
 * Structural + graph validation of one release-calendar registry. Counters and
 * digests are always recomputed. scheduledReleaseTimestamp is never treated as
 * proof of data availability.
 */
export function normalizeMacroReleaseCalendarRegistryManifestV1(value) {
  const code = 'MARKET_DATA_MACRO_RELEASE_CALENDAR_INVALID';
  const registry = closedMacroRecord(value, CALENDAR_REGISTRY_FIELDS,
    MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, code);
  assertSchemaVersion(registry, MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION);
  if (registry.registryPolicyVersion !== MACRO_RELEASE_CALENDAR_REGISTRY_POLICY_VERSION) {
    throw new MarketDataL3Error(code, 'registryPolicyVersion diverges from the closed V1');
  }
  assertCasId(registry.macroSeriesRegistryManifestId, 'macroSeriesRegistryManifestId');
  assertEnum(registry.jurisdictionCode, MACRO_JURISDICTION_CODES, 'jurisdictionCode', code);
  assertEnum(registry.currencyCode, MACRO_CURRENCY_CODES, 'currencyCode', code);
  assertCasId(registry.supersedesRegistryManifestId, 'supersedesRegistryManifestId', true);
  if (!Array.isArray(registry.orderedReleaseEventVersions)) {
    throw new MarketDataL3Error(code, 'orderedReleaseEventVersions must be an array');
  }
  const versions = registry.orderedReleaseEventVersions.map(normalizeReleaseEventVersion);
  for (let index = 1; index < versions.length; index += 1) {
    if (compareMacroReleaseEventVersions(versions[index - 1], versions[index]) >= 0) {
      throw new MarketDataL3Error(code,
        'orderedReleaseEventVersions must be canonically sorted and unique');
    }
  }
  const byVersionId = new Map();
  for (const version of versions) {
    if (byVersionId.has(version.releaseEventVersionId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_CONFLICT',
        'release event version appears more than once');
    }
    byVersionId.set(version.releaseEventVersionId, version);
  }

  const childrenByParent = new Map();
  for (const version of versions) {
    const parentId = version.supersedesReleaseEventVersionId;
    if (parentId === null) continue;
    const parent = byVersionId.get(parentId);
    if (!parent) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_INVALID',
        'superseded release event version is absent from the registry');
    }
    if (parent.releaseEventIdentityId !== version.releaseEventIdentityId
        || parent.macroSeriesIdentityId !== version.macroSeriesIdentityId
        || parent.referencePeriod !== version.referencePeriod
        || parent.releaseKind !== version.releaseKind
        || parent.releaseOrdinal !== version.releaseOrdinal
        || parent.releaseAuthority !== version.releaseAuthority) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_EVENT_IDENTITY_MISMATCH',
        'calendar supersession cannot mutate the logical release event identity');
    }
    if (childrenByParent.has(parentId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_CONFLICT',
        'two calendar versions branch from the same parent');
    }
    childrenByParent.set(parentId, version.releaseEventVersionId);
  }
  const tipsByIdentity = new Map();
  for (const version of versions) {
    if (childrenByParent.has(version.releaseEventVersionId)) continue;
    if (tipsByIdentity.has(version.releaseEventIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_CONFLICT',
        'a release event identity cannot have two active tips');
    }
    tipsByIdentity.set(version.releaseEventIdentityId, version.releaseEventVersionId);
  }

  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_CYCLE',
        'release calendar supersession graph contains a cycle');
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    const parentId = byVersionId.get(id).supersedesReleaseEventVersionId;
    if (parentId !== null) visit(parentId);
    state.set(id, 2);
  };
  for (const id of [...byVersionId.keys()].sort()) visit(id);

  if (registry.eventVersionCount !== versions.length) {
    throw new MarketDataL3Error(code, 'eventVersionCount diverges from the recomputed entries');
  }
  const digest = macroOrderedReleaseEventVersionDigestV1(versions);
  if (registry.orderedReleaseEventVersionDigest !== digest) {
    throw new MarketDataL3Error(code,
      'orderedReleaseEventVersionDigest diverges from the recomputed digest');
  }
  return {
    schemaVersion: MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registryPolicyVersion: MACRO_RELEASE_CALENDAR_REGISTRY_POLICY_VERSION,
    macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    jurisdictionCode: registry.jurisdictionCode,
    currencyCode: registry.currencyCode,
    supersedesRegistryManifestId: registry.supersedesRegistryManifestId,
    orderedReleaseEventVersions: versions,
    eventVersionCount: versions.length,
    orderedReleaseEventVersionDigest: digest,
  };
}

/**
 * Append-only verification of a fully read calendar registry chain ordered
 * from genesis to tip. Historical event versions are immutable; removal and
 * mutation are refused.
 */
export function verifyMacroReleaseCalendarRegistryChainV1(chain) {
  const code = 'MARKET_DATA_MACRO_RELEASE_CALENDAR_APPEND_ONLY_VIOLATION';
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new MarketDataL3Error(code, 'calendar registry chain must contain a genesis');
  }
  if (chain[0].registry.supersedesRegistryManifestId !== null) {
    throw new MarketDataL3Error(code, 'genesis calendar registry cannot supersede another registry');
  }
  for (let index = 1; index < chain.length; index += 1) {
    const parent = chain[index - 1];
    const child = chain[index].registry;
    if (child.supersedesRegistryManifestId !== parent.registryManifestId) {
      throw new MarketDataL3Error(code, 'calendar registry child does not reference its immediate parent');
    }
    if (child.macroSeriesRegistryManifestId !== parent.registry.macroSeriesRegistryManifestId
        || child.jurisdictionCode !== parent.registry.jurisdictionCode
        || child.currencyCode !== parent.registry.currencyCode) {
      throw new MarketDataL3Error(code, 'calendar registry child mutated pinned authority fields');
    }
    const childById = new Map(child.orderedReleaseEventVersions
      .map((entry) => [entry.releaseEventVersionId, entry]));
    for (const parentEntry of parent.registry.orderedReleaseEventVersions) {
      const preserved = childById.get(parentEntry.releaseEventVersionId);
      if (!preserved) {
        throw new MarketDataL3Error(code, 'calendar registry child removed a historical event version');
      }
      if (!sameClosedValue(preserved, parentEntry)) {
        throw new MarketDataL3Error(code, 'calendar registry child mutated a historical event version');
      }
    }
  }
  return chain;
}

/** Build a release-event version record with recomputed identity and version ids. */
export function buildMacroReleaseEventVersionRecordV1(components) {
  const identityId = macroReleaseEventIdentityIdFor(components);
  const draft = {
    releaseEventVersionId: 'sha256:' + '0'.repeat(64),
    releaseEventIdentityId: identityId,
    macroSeriesIdentityId: components.macroSeriesIdentityId,
    referencePeriod: components.referencePeriod,
    releaseKind: components.releaseKind,
    releaseOrdinal: components.releaseOrdinal,
    releaseAuthority: components.releaseAuthority,
    eventStatus: components.eventStatus,
    scheduledReleaseTimestamp: components.scheduledReleaseTimestamp,
    actualReleaseTimestamp: components.actualReleaseTimestamp ?? null,
    availableAt: components.availableAt ?? null,
    calendarKnowledgeAvailableAt: components.calendarKnowledgeAvailableAt,
    sourceDocumentId: components.sourceDocumentId,
    supersedesReleaseEventVersionId: components.supersedesReleaseEventVersionId ?? null,
    updateReason: components.updateReason,
  };
  draft.releaseEventVersionId = expectedReleaseEventVersionId(draft);
  return normalizeReleaseEventVersion(draft, 0);
}

/* ------------------------------------------------------------------------- *
 * MacroDatasetBinding/1
 * ------------------------------------------------------------------------- */

const BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'macroDatasetSnapshotManifestId', 'macroVintageSetManifestId',
  'macroSeriesRegistryManifestId', 'macroIngestionPolicyId',
  'macroAsOfResolutionPolicyId', 'macroReleaseCalendarRegistryManifestId',
  'jurisdictionCode', 'currencyCode', 'knowledgeCutoff', 'temporalCapability',
  'bindingPolicyVersion',
]);

export function normalizeMacroDatasetBindingV1(value) {
  const code = 'MARKET_DATA_MACRO_BINDING_INVALID';
  const binding = closedMacroRecord(value, BINDING_FIELDS,
    MACRO_DATASET_BINDING_SCHEMA_VERSION, code);
  assertSchemaVersion(binding, MACRO_DATASET_BINDING_SCHEMA_VERSION);
  for (const field of [
    'macroDatasetSnapshotManifestId', 'macroVintageSetManifestId',
    'macroSeriesRegistryManifestId', 'macroIngestionPolicyId',
    'macroAsOfResolutionPolicyId', 'macroReleaseCalendarRegistryManifestId',
  ]) assertCasId(binding[field], field);
  assertEnum(binding.jurisdictionCode, MACRO_JURISDICTION_CODES, 'jurisdictionCode', code);
  assertEnum(binding.currencyCode, MACRO_CURRENCY_CODES, 'currencyCode', code);
  assertMacroMaterializationUtcInstant(binding.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(binding.temporalCapability, MACRO_BINDING_TEMPORAL_CAPABILITIES,
    'temporalCapability', 'MARKET_DATA_MACRO_TEMPORAL_CAPABILITY_MISMATCH');
  if (binding.bindingPolicyVersion !== MACRO_DATASET_BINDING_POLICY_VERSION) {
    throw new MarketDataL3Error(code, 'bindingPolicyVersion diverges from the closed V1');
  }
  return Object.fromEntries(BINDING_FIELDS.map((field) => [field, binding[field]]));
}

/* ------------------------------------------------------------------------- *
 * MacroMaterializationReport/1
 * ------------------------------------------------------------------------- */

const REPORT_FIELDS = Object.freeze([
  'schemaVersion', 'macroDatasetBindingId', 'macroDatasetSnapshotManifestId',
  'macroVintageSetManifestId', 'macroSeriesRegistryManifestId',
  'macroReleaseCalendarRegistryManifestId', 'macroIngestionPolicyId',
  'macroAsOfResolutionPolicyId', 'knowledgeCutoff', 'jurisdictionCode',
  'currencyCode', 'seriesCount', 'observationCount', 'resolvedObservationCount',
  'notAvailableObservationCount', 'withdrawnObservationCount',
  'futureVintageRejectedCount', 'revisionCountUsed', 'correctionCountUsed',
  'benchmarkRevisionCountUsed', 'releaseCalendarEventCount',
  'scheduledEventCount', 'rescheduledEventCount', 'releasedEventCount',
  'cancelledEventCount', 'delayedEventCount', 'earliestResolvedAvailableAt',
  'latestResolvedAvailableAt', 'countsByResolutionStatus',
  'countsByCompletenessClass', 'countsByRevisionKind',
  'orderedResolvedVintageIdentityDigest', 'orderedResolvedObservationDigest',
  'orderedCalendarStateDigest', 'emptyMaterialization',
]);

const COUNT_MAP_RESOLUTION_FIELDS = Object.freeze([
  'NOT_AVAILABLE', 'RESOLVED', 'WITHDRAWN',
]);

function normalizeCountMap(value, allowedKeys, label, code) {
  const record = closedMacroRecord(value, allowedKeys, label, code);
  const out = {};
  for (const key of allowedKeys) {
    assertSafeInteger(record[key], `${label}.${key}`, { nonNegative: true });
    out[key] = record[key];
  }
  return out;
}

function normalizeDynamicCountMap(value, label, code) {
  const record = assertPlainObject(value, label);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') {
      throw new MarketDataL3Error(code, `${label} contains unknown field ${keyLabel(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
      throw new MarketDataL3Error(code, `${label}.${key} must be an own enumerable data property`);
    }
    assertSafeInteger(record[key], `${label}.${key}`, { nonNegative: true });
  }
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

export function normalizeMacroMaterializationReportV1(value) {
  const code = 'MARKET_DATA_MACRO_MATERIALIZATION_REPORT_INVALID';
  const report = closedMacroRecord(value, REPORT_FIELDS,
    MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, code);
  assertSchemaVersion(report, MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION);
  for (const field of [
    'macroDatasetBindingId', 'macroDatasetSnapshotManifestId',
    'macroVintageSetManifestId', 'macroSeriesRegistryManifestId',
    'macroReleaseCalendarRegistryManifestId', 'macroIngestionPolicyId',
    'macroAsOfResolutionPolicyId',
  ]) assertCasId(report[field], field);
  assertMacroMaterializationUtcInstant(report.knowledgeCutoff, 'knowledgeCutoff');
  assertEnum(report.jurisdictionCode, MACRO_JURISDICTION_CODES, 'jurisdictionCode', code);
  assertEnum(report.currencyCode, MACRO_CURRENCY_CODES, 'currencyCode', code);
  for (const field of [
    'seriesCount', 'observationCount', 'resolvedObservationCount',
    'notAvailableObservationCount', 'withdrawnObservationCount',
    'futureVintageRejectedCount', 'revisionCountUsed', 'correctionCountUsed',
    'benchmarkRevisionCountUsed', 'releaseCalendarEventCount',
    'scheduledEventCount', 'rescheduledEventCount', 'releasedEventCount',
    'cancelledEventCount', 'delayedEventCount',
  ]) assertSafeInteger(report[field], field, { nonNegative: true });
  assertMacroMaterializationUtcInstant(report.earliestResolvedAvailableAt,
    'earliestResolvedAvailableAt', true);
  assertMacroMaterializationUtcInstant(report.latestResolvedAvailableAt,
    'latestResolvedAvailableAt', true);
  if ((report.earliestResolvedAvailableAt === null)
      !== (report.latestResolvedAvailableAt === null)
      || (report.resolvedObservationCount === 0) !== (report.earliestResolvedAvailableAt === null)
      || (report.earliestResolvedAvailableAt !== null
        && report.earliestResolvedAvailableAt > report.latestResolvedAvailableAt)) {
    throw new MarketDataL3Error(code, 'resolved availableAt bounds diverge from resolvedObservationCount');
  }
  const countsByResolutionStatus = normalizeCountMap(report.countsByResolutionStatus,
    COUNT_MAP_RESOLUTION_FIELDS, 'countsByResolutionStatus', code);
  const countsByCompletenessClass = normalizeDynamicCountMap(
    report.countsByCompletenessClass, 'countsByCompletenessClass', code);
  const countsByRevisionKind = normalizeDynamicCountMap(
    report.countsByRevisionKind, 'countsByRevisionKind', code);
  for (const field of [
    'orderedResolvedVintageIdentityDigest', 'orderedResolvedObservationDigest',
    'orderedCalendarStateDigest',
  ]) assertCasId(report[field], field);
  if (typeof report.emptyMaterialization !== 'boolean') {
    throw new MarketDataL3Error(code, 'emptyMaterialization must be a boolean');
  }
  const expectedEmpty = report.observationCount === 0 && report.releaseCalendarEventCount === 0;
  if (report.emptyMaterialization !== expectedEmpty) {
    throw new MarketDataL3Error(code, 'emptyMaterialization diverges from observation and calendar counts');
  }
  return {
    schemaVersion: MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    macroDatasetBindingId: report.macroDatasetBindingId,
    macroDatasetSnapshotManifestId: report.macroDatasetSnapshotManifestId,
    macroVintageSetManifestId: report.macroVintageSetManifestId,
    macroSeriesRegistryManifestId: report.macroSeriesRegistryManifestId,
    macroReleaseCalendarRegistryManifestId: report.macroReleaseCalendarRegistryManifestId,
    macroIngestionPolicyId: report.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: report.macroAsOfResolutionPolicyId,
    knowledgeCutoff: report.knowledgeCutoff,
    jurisdictionCode: report.jurisdictionCode,
    currencyCode: report.currencyCode,
    seriesCount: report.seriesCount,
    observationCount: report.observationCount,
    resolvedObservationCount: report.resolvedObservationCount,
    notAvailableObservationCount: report.notAvailableObservationCount,
    withdrawnObservationCount: report.withdrawnObservationCount,
    futureVintageRejectedCount: report.futureVintageRejectedCount,
    revisionCountUsed: report.revisionCountUsed,
    correctionCountUsed: report.correctionCountUsed,
    benchmarkRevisionCountUsed: report.benchmarkRevisionCountUsed,
    releaseCalendarEventCount: report.releaseCalendarEventCount,
    scheduledEventCount: report.scheduledEventCount,
    rescheduledEventCount: report.rescheduledEventCount,
    releasedEventCount: report.releasedEventCount,
    cancelledEventCount: report.cancelledEventCount,
    delayedEventCount: report.delayedEventCount,
    earliestResolvedAvailableAt: report.earliestResolvedAvailableAt,
    latestResolvedAvailableAt: report.latestResolvedAvailableAt,
    countsByResolutionStatus,
    countsByCompletenessClass,
    countsByRevisionKind,
    orderedResolvedVintageIdentityDigest: report.orderedResolvedVintageIdentityDigest,
    orderedResolvedObservationDigest: report.orderedResolvedObservationDigest,
    orderedCalendarStateDigest: report.orderedCalendarStateDigest,
    emptyMaterialization: report.emptyMaterialization,
  };
}

/** Total canonical order for resolved observation rows in digests. */
export function compareMacroResolvedObservationOrderKeys(left, right) {
  for (const field of [
    'macroSeriesIdentityId', 'observationPeriodStart', 'observationPeriodEnd',
    'observationIdentityId', 'selectedAvailableAt', 'selectedVintageSequence',
    'selectedMacroVintageIdentityId',
  ]) {
    const leftValue = left[field] ?? '';
    const rightValue = right[field] ?? '';
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

/** Total canonical order for calendar as-of states. */
export function compareMacroCalendarStateOrderKeys(left, right) {
  for (const field of [
    'macroSeriesIdentityId', 'referencePeriod', 'releaseKind',
    'releaseEventIdentityId', 'calendarKnowledgeAvailableAt',
    'releaseEventVersionId',
  ]) {
    const leftValue = left[field] ?? '';
    const rightValue = right[field] ?? '';
    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      continue;
    }
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}
