/**
 * L4B-I2 append-only macro release calendar registry and as-of calendar
 * resolver. scheduledReleaseTimestamp is informative only; availability is
 * never inferred from the schedule. calendarKnowledgeAvailableAt governs
 * point-in-time visibility of calendar versions.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_RELEASE_CALENDAR_REGISTRY_POLICY_VERSION,
  assertMacroMaterializationUtcInstant,
  buildMacroReleaseEventVersionRecordV1,
  compareMacroReleaseEventVersions,
  macroOrderedReleaseEventVersionDigestV1,
  normalizeMacroReleaseCalendarRegistryManifestV1,
  verifyMacroReleaseCalendarRegistryChainV1,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroSeriesRegistryManifest } from './macroSeriesRegistryL4BV1.mjs';
import { verifyMacroSourceDocument } from './macroObservationVintageL4BV1.mjs';

function expectedRegistryValue(input) {
  const ordered = [...input.orderedReleaseEventVersions]
    .sort(compareMacroReleaseEventVersions);
  return normalizeMacroReleaseCalendarRegistryManifestV1({
    schemaVersion: MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registryPolicyVersion: MACRO_RELEASE_CALENDAR_REGISTRY_POLICY_VERSION,
    macroSeriesRegistryManifestId: input.macroSeriesRegistryManifestId,
    jurisdictionCode: input.jurisdictionCode,
    currencyCode: input.currencyCode,
    supersedesRegistryManifestId: input.supersedesRegistryManifestId,
    orderedReleaseEventVersions: ordered,
    eventVersionCount: ordered.length,
    orderedReleaseEventVersionDigest: macroOrderedReleaseEventVersionDigestV1(ordered),
  });
}

function assertSeriesMembership(seriesRegistry, version) {
  const entry = seriesRegistry.orderedSeriesEntries
    .find((item) => item.macroSeriesIdentityId === version.macroSeriesIdentityId);
  if (!entry) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_REFERENCE_MISMATCH',
      'calendar event series identity is absent from the pinned series registry');
  }
}

/**
 * Build a genesis or append calendar registry. Historical versions are never
 * mutated; appends must preserve every prior version byte-for-byte.
 */
export function buildMacroReleaseCalendarRegistryManifest(input) {
  const api = assertApiInput(input, [
    'macroSeriesRegistryManifestId', 'jurisdictionCode', 'currencyCode',
    'supersedesRegistryManifestId', 'orderedReleaseEventVersions',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroSeriesRegistryManifestId, 'macroSeriesRegistryManifestId');
  assertCasId(api.macroSeriesRegistryManifestId, 'macroSeriesRegistryManifestId');
  assertCasId(api.supersedesRegistryManifestId, 'supersedesRegistryManifestId', true);

  const { registry: seriesRegistry } = verifyMacroSeriesRegistryManifest({
    store: api.store, macroSeriesRegistryManifestId: api.macroSeriesRegistryManifestId,
  });
  for (const version of api.orderedReleaseEventVersions) {
    assertSeriesMembership(seriesRegistry, version);
    verifyMacroSourceDocument(api.store, version.sourceDocumentId);
  }

  const registry = expectedRegistryValue(api);
  if (api.supersedesRegistryManifestId !== null) {
    const parent = verifyMacroReleaseCalendarRegistryManifest({
      store: api.store,
      macroReleaseCalendarRegistryManifestId: api.supersedesRegistryManifestId,
    });
    verifyMacroReleaseCalendarRegistryChainV1([
      {
        registryManifestId: api.supersedesRegistryManifestId,
        registry: parent.registry,
      },
      {
        registryManifestId: 'pending',
        registry,
      },
    ]);
    if (parent.registry.macroSeriesRegistryManifestId !== api.macroSeriesRegistryManifestId
        || parent.registry.jurisdictionCode !== api.jurisdictionCode
        || parent.registry.currencyCode !== api.currencyCode) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_APPEND_ONLY_VIOLATION',
        'calendar append mutated pinned authority fields');
    }
  } else if (registry.orderedReleaseEventVersions.some(
    (version) => version.supersedesReleaseEventVersionId !== null,
  )) {
    // Allowed: genesis may already contain a small supersession chain of
    // event versions, as long as the registry itself is genesis.
  }

  const stored = putCanonicalL3(api.store,
    MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, registry);
  verifyMacroReleaseCalendarRegistryManifest({
    store: api.store,
    macroReleaseCalendarRegistryManifestId: stored.objectId,
  });
  return {
    macroReleaseCalendarRegistryManifestId: stored.objectId,
    registry: stored.value,
  };
}

export function buildMacroReleaseCalendarRegistryGenesis(input) {
  return buildMacroReleaseCalendarRegistryManifest({
    ...input,
    supersedesRegistryManifestId: null,
  });
}

/** Convenience: synthesize a version record then include it in a build. */
export function makeMacroReleaseEventVersion(components) {
  return buildMacroReleaseEventVersionRecordV1(components);
}

export function verifyMacroReleaseCalendarRegistryManifest(input) {
  const api = assertApiInput(input, ['macroReleaseCalendarRegistryManifestId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroReleaseCalendarRegistryManifestId,
    'macroReleaseCalendarRegistryManifestId');
  assertCasId(api.macroReleaseCalendarRegistryManifestId,
    'macroReleaseCalendarRegistryManifestId');
  const raw = readTypedReference(api.store, api.macroReleaseCalendarRegistryManifestId,
    MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, 'macro release calendar registry');
  const registry = normalizeMacroReleaseCalendarRegistryManifestV1(raw);
  const { registry: seriesRegistry } = verifyMacroSeriesRegistryManifest({
    store: api.store, macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
  });
  for (const version of registry.orderedReleaseEventVersions) {
    assertSeriesMembership(seriesRegistry, version);
    verifyMacroSourceDocument(api.store, version.sourceDocumentId);
  }
  const expected = expectedRegistryValue(registry);
  if (!canonicalValuesEqual(registry, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_INVALID',
      'calendar registry diverges from its recomputed canonical value');
  }
  if (registry.supersedesRegistryManifestId !== null) {
    const parent = verifyMacroReleaseCalendarRegistryManifest({
      store: api.store,
      macroReleaseCalendarRegistryManifestId: registry.supersedesRegistryManifestId,
    });
    verifyMacroReleaseCalendarRegistryChainV1([
      {
        registryManifestId: registry.supersedesRegistryManifestId,
        registry: parent.registry,
      },
      {
        registryManifestId: api.macroReleaseCalendarRegistryManifestId,
        registry,
      },
    ]);
  }
  return {
    macroReleaseCalendarRegistryManifestId: api.macroReleaseCalendarRegistryManifestId,
    registry,
    seriesRegistry,
  };
}

/**
 * Resolve the calendar state known for one logical release event at an
 * explicit knowledge cutoff on a pinned calendar registry. Runtime only.
 */
export function resolveMacroReleaseCalendarAsOf(input) {
  const api = assertApiInput(input, [
    'releaseEventIdentityId', 'knowledgeCutoff',
    'macroReleaseCalendarRegistryManifestId',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.releaseEventIdentityId, 'releaseEventIdentityId');
  assertExplicitPinnedMacroId(api.macroReleaseCalendarRegistryManifestId,
    'macroReleaseCalendarRegistryManifestId');
  assertCasId(api.releaseEventIdentityId, 'releaseEventIdentityId');
  assertCasId(api.macroReleaseCalendarRegistryManifestId,
    'macroReleaseCalendarRegistryManifestId');
  assertMacroMaterializationUtcInstant(api.knowledgeCutoff, 'knowledgeCutoff');

  const verified = verifyMacroReleaseCalendarRegistryManifest({
    store: api.store,
    macroReleaseCalendarRegistryManifestId: api.macroReleaseCalendarRegistryManifestId,
  });
  const versions = verified.registry.orderedReleaseEventVersions
    .filter((version) => version.releaseEventIdentityId === api.releaseEventIdentityId);
  if (versions.length === 0) {
    return {
      releaseEventIdentityId: api.releaseEventIdentityId,
      knowledgeCutoff: api.knowledgeCutoff,
      macroReleaseCalendarRegistryManifestId: api.macroReleaseCalendarRegistryManifestId,
      resolutionStatus: 'NOT_AVAILABLE',
      selectedReleaseEventVersionId: null,
      eventStatus: null,
      scheduledReleaseTimestamp: null,
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: null,
    };
  }

  const admissible = versions
    .filter((version) => version.calendarKnowledgeAvailableAt <= api.knowledgeCutoff)
    .sort((left, right) => {
      if (left.calendarKnowledgeAvailableAt < right.calendarKnowledgeAvailableAt) return -1;
      if (left.calendarKnowledgeAvailableAt > right.calendarKnowledgeAvailableAt) return 1;
      return left.releaseEventVersionId < right.releaseEventVersionId ? -1
        : left.releaseEventVersionId > right.releaseEventVersionId ? 1 : 0;
    });
  if (admissible.length === 0) {
    return {
      releaseEventIdentityId: api.releaseEventIdentityId,
      knowledgeCutoff: api.knowledgeCutoff,
      macroReleaseCalendarRegistryManifestId: api.macroReleaseCalendarRegistryManifestId,
      resolutionStatus: 'NOT_AVAILABLE',
      selectedReleaseEventVersionId: null,
      eventStatus: null,
      scheduledReleaseTimestamp: null,
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: null,
    };
  }

  const byId = new Map(admissible.map((version) => [version.releaseEventVersionId, version]));
  const childByParent = new Map();
  for (const version of admissible) {
    const parentId = version.supersedesReleaseEventVersionId;
    if (parentId === null) continue;
    if (!byId.has(parentId) && versions.some((item) => item.releaseEventVersionId === parentId
        && item.calendarKnowledgeAvailableAt > api.knowledgeCutoff)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_INVALID',
        'visible calendar version has an invisible parent at the knowledge cutoff');
    }
    if (!byId.has(parentId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_INVALID',
        'calendar parent is absent from the admissible as-of chain');
    }
    if (childByParent.has(parentId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_CONFLICT',
        'concurrent calendar branches refuse as-of resolution');
    }
    childByParent.set(parentId, version.releaseEventVersionId);
  }

  const roots = admissible.filter((version) => version.supersedesReleaseEventVersionId === null
    || !byId.has(version.supersedesReleaseEventVersionId));
  if (roots.length !== 1) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_CALENDAR_CONFLICT',
      'admissible calendar versions do not form a single tip');
  }
  let tip = roots[0];
  while (childByParent.has(tip.releaseEventVersionId)) {
    tip = byId.get(childByParent.get(tip.releaseEventVersionId));
  }

  return {
    releaseEventIdentityId: api.releaseEventIdentityId,
    knowledgeCutoff: api.knowledgeCutoff,
    macroReleaseCalendarRegistryManifestId: api.macroReleaseCalendarRegistryManifestId,
    resolutionStatus: 'RESOLVED',
    selectedReleaseEventVersionId: tip.releaseEventVersionId,
    eventStatus: tip.eventStatus,
    scheduledReleaseTimestamp: tip.scheduledReleaseTimestamp,
    actualReleaseTimestamp: tip.actualReleaseTimestamp,
    availableAt: tip.availableAt,
    calendarKnowledgeAvailableAt: tip.calendarKnowledgeAvailableAt,
    macroSeriesIdentityId: tip.macroSeriesIdentityId,
    referencePeriod: tip.referencePeriod,
    releaseKind: tip.releaseKind,
    releaseOrdinal: tip.releaseOrdinal,
    releaseAuthority: tip.releaseAuthority,
  };
}
