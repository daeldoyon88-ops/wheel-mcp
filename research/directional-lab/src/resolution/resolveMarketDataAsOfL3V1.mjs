/**
 * L3-I4 — point-in-time resolver over the authoritative L3-I3 ingestion
 * registry, and the closed MarketDataResolvedSeriesManifest/1 API pair.
 *
 * Authority is always relative to the explicitly pinned registry manifest and
 * the explicitly supplied UTC knowledgeCutoff. Object-by-object visibility uses
 * only knowledgeTimeUpperBound <= knowledgeCutoff. No latest-wins rule, no CAS
 * order, no insertion order, no wall clock, no implicit registry, no implicit
 * lineage, no implicit cutoff.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  assertUtcInstant,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  deriveCorporateActionTreatment,
  deriveTemporalCapabilityFromKnowledgeModes,
  tipForLineage,
  verifyMarketDataIngestionManifest,
  verifyMarketDataIngestionRegistry,
} from '../contracts/marketDataIngestionRegistryL3V1.mjs';
import {
  verifyMarketDataBarCorrection,
  verifyMarketDataBarObservation,
} from '../contracts/marketDataBarRevisionL3V1.mjs';
import {
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
} from '../contracts/marketDataBarIdentityL3V1.mjs';
import {
  MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  verifyMarketCalendarRegistry,
} from '../contracts/marketCalendarL3V1.mjs';
import {
  INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
} from '../contracts/instrumentIdentityV1.mjs';
import { CA } from '../contracts/corporateActionL2CV1.mjs';
import { verifyCorporateActionRegistry } from '../data/buildCorporateActionRegistry.mjs';
import {
  MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
  normalizeMarketDataResolvedSeriesManifestV1,
} from '../contracts/marketDataResolvedSeriesL3V1.mjs';

const STORE_METHODS = Object.freeze(['putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject']);

/** Strict UTC ISO instants share one fixed format, so string order is time order. */
function isVisibleAt(knowledgeTimeUpperBound, knowledgeCutoff) {
  return knowledgeTimeUpperBound <= knowledgeCutoff;
}

/** Registry chain from root to the explicitly pinned manifest (both inclusive). */
function orderedIngestionRegistryChain(store, ingestionRegistryManifestId) {
  const chain = [];
  const seen = new Set();
  let cursor = ingestionRegistryManifestId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_REGISTRY_CYCLE', 'ingestion registry supersedes chain contains a cycle');
    }
    seen.add(cursor);
    const registry = readTypedReference(
      store, cursor, MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION, 'ingestion registry',
    );
    chain.push({ ingestionRegistryManifestId: cursor, registry });
    cursor = registry.supersedesIngestionRegistryManifestId;
  }
  chain.reverse();
  return chain;
}

/** Ancestor IDs of one pinned manifest along a named supersedes field. */
function pinAncestors(store, pinId, schemaVersion, supersedesField, label) {
  const ancestors = new Set();
  const seen = new Set([pinId]);
  let cursor = readTypedReference(store, pinId, schemaVersion, label)[supersedesField];
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new MarketDataL3Error('MARKET_DATA_REFERENCE_CORRUPT', `${label} supersedes chain contains a cycle`);
    }
    seen.add(cursor);
    ancestors.add(cursor);
    cursor = readTypedReference(store, cursor, schemaVersion, label)[supersedesField];
  }
  return ancestors;
}

/**
 * All pins must live on one append-only supersedes chain; the most advanced
 * descendant is returned. Any pair on divergent branches fails closed.
 */
function mostAdvancedChainPin(store, pinIds, schemaVersion, supersedesField, label, code) {
  const ordered = [...new Set(pinIds)].sort();
  if (ordered.length === 1) return ordered[0];
  const ancestorsByPin = new Map(
    ordered.map((pinId) => [pinId, pinAncestors(store, pinId, schemaVersion, supersedesField, label)]),
  );
  for (const candidate of ordered) {
    const ancestors = ancestorsByPin.get(candidate);
    if (ordered.every((other) => other === candidate || ancestors.has(other))) {
      return candidate;
    }
  }
  throw new MarketDataL3Error(code, `${label} pins do not share one append-only chain`, { pins: ordered });
}

/**
 * Walk the authoritative ingestion chain of one lineage under the pinned
 * registry, fully verifying every ingestion manifest closure (publication
 * manifest, delta assembly, temporal capability, price basis).
 */
function authoritativeIngestionChain(store, registry, ingestionLineageId) {
  const tipId = tipForLineage(registry, ingestionLineageId);
  if (tipId === null) {
    throw new MarketDataL3Error(
      'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION',
      'lineage has no authoritative ingestion under the pinned registry',
      { ingestionLineageId },
    );
  }
  const listed = new Set(registry.ingestionManifestIds);
  const chain = [];
  const seen = new Set();
  let cursor = tipId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_CHAIN_INVALID', 'ingestion supersedes chain contains a cycle');
    }
    if (!listed.has(cursor)) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_STALE_BASE', 'ingestion chain leaves the pinned registry closure');
    }
    seen.add(cursor);
    const { ingestionManifest } = verifyMarketDataIngestionManifest({ store, ingestionManifestId: cursor });
    if (ingestionManifest.ingestionLineageId !== ingestionLineageId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION',
        'ingestion chain crosses into another lineage',
        { ingestionManifestId: cursor },
      );
    }
    chain.push({ ingestionManifestId: cursor, ingestionManifest });
    cursor = ingestionManifest.expectedParentIngestionManifestId;
  }
  return chain;
}

/** Aggregate the authoritative objects of the chain; CAS presence alone never grants authority. */
function aggregateAuthoritativeObjects(store, chain, ingestionLineageId) {
  const observationById = new Map();
  const correctionById = new Map();
  const introducedBy = new Map();
  for (const { ingestionManifestId, ingestionManifest } of chain) {
    for (const observationId of ingestionManifest.newBarObservationIds) {
      const { observation } = verifyMarketDataBarObservation({ store, observationId });
      if (observation.ingestionLineageId !== ingestionLineageId) {
        throw new MarketDataL3Error(
          'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION',
          'authoritative observation belongs to another lineage',
          { observationId },
        );
      }
      observationById.set(observationId, observation);
      introducedBy.set(observationId, ingestionManifestId);
    }
    for (const correctionId of ingestionManifest.newBarCorrectionIds) {
      const { correction } = verifyMarketDataBarCorrection({ store, correctionId });
      if (correction.ingestionLineageId !== ingestionLineageId) {
        throw new MarketDataL3Error(
          'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION',
          'authoritative correction belongs to another lineage',
          { correctionId },
        );
      }
      correctionById.set(correctionId, correction);
      introducedBy.set(correctionId, ingestionManifestId);
    }
  }
  return { observationById, correctionById, introducedBy };
}

/**
 * Rebuild the visible correction chains per bar and select each derived
 * terminal tip. The caller never supplies a tip and corrections are never
 * ordered by CAS ID or insertion order.
 */
function deriveVisibleChains(visibleCorrections, correctionById, knowledgeCutoff) {
  const visibleChildrenByParent = new Map();
  for (const [correctionId, correction] of visibleCorrections) {
    const parentId = correction.parentCorrectionId;
    if (parentId === null) continue;
    if (!correctionById.has(parentId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CORRECTION_CHAIN_INVALID',
        'visible correction parent is outside the authoritative chain',
        { correctionId, parentCorrectionId: parentId },
      );
    }
    const parent = correctionById.get(parentId);
    if (parent.barIdentityId !== correction.barIdentityId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CORRECTION_CHAIN_INVALID',
        'visible correction parent belongs to another bar',
        { correctionId, parentCorrectionId: parentId },
      );
    }
    if (parent.ingestionLineageId !== correction.ingestionLineageId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_LINEAGE_MEMBERSHIP_VIOLATION',
        'visible correction parent belongs to another lineage',
        { correctionId, parentCorrectionId: parentId },
      );
    }
    if (!isVisibleAt(parent.knowledgeTimeUpperBound, knowledgeCutoff)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_PARENT_INVISIBLE',
        'visible correction has an invisible parent at the knowledge cutoff',
        { correctionId, parentCorrectionId: parentId },
      );
    }
    if (!visibleChildrenByParent.has(parentId)) visibleChildrenByParent.set(parentId, []);
    visibleChildrenByParent.get(parentId).push(correctionId);
  }
  for (const [parentId, childIds] of visibleChildrenByParent) {
    if (childIds.length > 1) {
      throw new MarketDataL3Error(
        'MARKET_DATA_BAR_REVISION_BRANCH',
        'one parent has multiple visible children',
        { parentCorrectionId: parentId, childCorrectionIds: [...childIds].sort() },
      );
    }
  }
  for (const correctionId of visibleCorrections.keys()) {
    const seen = new Set();
    let cursor = correctionId;
    while (cursor !== null && visibleCorrections.has(cursor)) {
      if (seen.has(cursor)) {
        throw new MarketDataL3Error('MARKET_DATA_CORRECTION_CHAIN_INVALID', 'visible correction chain contains a cycle');
      }
      seen.add(cursor);
      cursor = visibleCorrections.get(cursor).parentCorrectionId;
    }
  }

  const visibleByBar = new Map();
  for (const [correctionId, correction] of visibleCorrections) {
    if (!visibleByBar.has(correction.barIdentityId)) visibleByBar.set(correction.barIdentityId, []);
    visibleByBar.get(correction.barIdentityId).push(correctionId);
  }
  const tipByBar = new Map();
  for (const barIdentityId of [...visibleByBar.keys()].sort()) {
    const memberIds = visibleByBar.get(barIdentityId);
    const rootIds = memberIds
      .filter((correctionId) => visibleCorrections.get(correctionId).parentCorrectionId === null)
      .sort();
    if (rootIds.length !== 1) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
        'a bar has concurrent visible correction roots',
        { barIdentityId, rootCorrectionIds: rootIds },
      );
    }
    const tipIds = memberIds
      .filter((correctionId) => !visibleChildrenByParent.has(correctionId))
      .sort();
    if (tipIds.length !== 1) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
        'a bar has an ambiguous visible correction tip',
        { barIdentityId, tipCorrectionIds: tipIds },
      );
    }
    tipByBar.set(barIdentityId, tipIds[0]);
  }
  return { tipByBar, visibleByBar };
}

/** Find the visible SESSION_DATE_REPLACEMENT paired with one withdrawal, both directions checked. */
function findSessionDateReplacement(withdrawalId, withdrawal, visibleCorrections, visibleByBar) {
  const nextBarIdentityId = withdrawal.sessionDateLink.nextBarIdentityId;
  const candidateIds = (visibleByBar.get(nextBarIdentityId) ?? [])
    .filter((correctionId) => {
      const candidate = visibleCorrections.get(correctionId);
      return candidate.correctionKind === 'SESSION_DATE_REPLACEMENT'
        && candidate.sessionDateLink.withdrawalCorrectionId === withdrawalId
        && candidate.sessionDateLink.previousBarIdentityId === withdrawal.barIdentityId
        && candidate.barIdentityId === nextBarIdentityId;
    })
    .sort();
  if (candidateIds.length > 1) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'one session-date withdrawal has concurrent visible replacements',
      { withdrawalCorrectionId: withdrawalId, replacementCorrectionIds: candidateIds },
    );
  }
  return candidateIds.length === 1 ? candidateIds[0] : null;
}

/** Resolve one visible tip into { disposition, resolvedObservationId }. */
function resolveTipDisposition(tipId, tip, visibleCorrections, visibleByBar) {
  switch (tip.correctionKind) {
    case 'INITIAL_ROOT':
    case 'VALUE_REVISION':
    case 'SESSION_DATE_REPLACEMENT':
      return { disposition: 'PRESENT', resolvedObservationId: tip.observationId };
    case 'RESTORATION':
      return { disposition: 'PRESENT', resolvedObservationId: tip.restoredObservationId };
    case 'WITHDRAWAL':
      return { disposition: 'WITHDRAWN', resolvedObservationId: null };
    case 'SESSION_DATE_WITHDRAWAL': {
      const replacementId = findSessionDateReplacement(tipId, tip, visibleCorrections, visibleByBar);
      if (replacementId !== null) {
        return { disposition: 'MOVED_TO_OTHER_SESSION', resolvedObservationId: null };
      }
      return { disposition: 'WITHDRAWN', resolvedObservationId: null };
    }
    default:
      throw new MarketDataL3Error('MARKET_DATA_CORRECTION_CHAIN_INVALID', 'unknown visible tip correctionKind');
  }
}

/** A PRESENT entry must carry an authoritative, visible, same-bar observation. */
function assertResolvedObservation(observationId, barIdentityId, observationById, knowledgeCutoff) {
  if (observationId === null || !observationById.has(observationId)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE',
      'resolved tip requires an authoritative observation that is absent',
      { observationId, barIdentityId },
    );
  }
  const observation = observationById.get(observationId);
  if (observation.barIdentityId !== barIdentityId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'resolved observation belongs to another bar',
      { observationId, barIdentityId },
    );
  }
  if (!isVisibleAt(observation.knowledgeTimeUpperBound, knowledgeCutoff)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE',
      'resolved observation is not visible at the knowledge cutoff',
      { observationId, barIdentityId },
    );
  }
  return observation;
}

/** Contributing closure: visible tips, all their visible ancestors and every referenced observation. */
function deriveContributingClosure(tipByBar, visibleCorrections, observationById, knowledgeCutoff) {
  const contributingCorrectionIds = new Set();
  for (const tipId of tipByBar.values()) {
    let cursor = tipId;
    while (cursor !== null) {
      if (contributingCorrectionIds.has(cursor)) break;
      contributingCorrectionIds.add(cursor);
      cursor = visibleCorrections.get(cursor).parentCorrectionId;
    }
  }
  const contributingObservationIds = new Set();
  for (const correctionId of contributingCorrectionIds) {
    const correction = visibleCorrections.get(correctionId);
    for (const observationId of [correction.observationId, correction.restoredObservationId]) {
      if (observationId === null) continue;
      if (!observationById.has(observationId)) {
        throw new MarketDataL3Error(
          'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE',
          'contributing correction references a non-authoritative observation',
          { correctionId, observationId },
        );
      }
      if (!isVisibleAt(observationById.get(observationId).knowledgeTimeUpperBound, knowledgeCutoff)) {
        throw new MarketDataL3Error(
          'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE',
          'contributing observation is not visible at the knowledge cutoff',
          { correctionId, observationId },
        );
      }
      contributingObservationIds.add(observationId);
    }
  }
  return {
    contributingCorrectionIds: [...contributingCorrectionIds].sort(),
    contributingObservationIds: [...contributingObservationIds].sort(),
  };
}

/**
 * First registry of the pinned chain (root → call pin) whose closure lists
 * every contributing ingestion manifest. Appending a future non-contributing
 * ingestion never changes this prefix.
 */
function deriveContributingRegistryPrefixId(registryChain, contributingIngestionManifestIds) {
  for (const { ingestionRegistryManifestId, registry } of registryChain) {
    const listed = new Set(registry.ingestionManifestIds);
    if (contributingIngestionManifestIds.every((id) => listed.has(id))) {
      return ingestionRegistryManifestId;
    }
  }
  throw new MarketDataL3Error(
    'MARKET_DATA_INGESTION_STALE_BASE',
    'no pinned registry prefix lists every contributing ingestion manifest',
  );
}

/** Calendar pins: one authority policy, one chain, full coverage of every resolved session. */
function deriveCalendarPin(store, calendarPinIds, resolvedBarEntries) {
  const orderedPins = [...new Set(calendarPinIds)].sort();
  const registries = orderedPins.map((pinId) => readTypedReference(
    store, pinId, MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, 'calendar registry pin',
  ));
  const authorityPolicyId = registries[0].calendarAuthorityPolicyId;
  for (const registry of registries) {
    if (registry.calendarAuthorityPolicyId !== authorityPolicyId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CALENDAR_REGISTRY_MISMATCH',
        'contributing calendar pins use different authority policies',
      );
    }
  }
  const calendarRegistryManifestId = mostAdvancedChainPin(
    store, orderedPins, MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
    'supersedesCalendarRegistryManifestId', 'calendar registry pin', 'MARKET_DATA_CALENDAR_BRANCH',
  );
  const verified = verifyMarketCalendarRegistry({ store, calendarRegistryManifestId });
  const coveredDates = new Set(
    verified.calendars.flatMap((calendar) => calendar.sessions.map((session) => session.sessionDate)),
  );
  for (const entry of resolvedBarEntries) {
    if (!coveredDates.has(entry.sessionDate)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE',
        'a resolved session is not covered by the contributing calendar pin',
        { sessionDate: entry.sessionDate },
      );
    }
  }
  return calendarRegistryManifestId;
}

/** Explicit L2C pin: valid registry, same authority chain as every contributing ingestion pin. */
function assertCorporateActionPin(store, corporateActionRegistryManifestId, contributorPinIds) {
  let pinned;
  try {
    pinned = verifyCorporateActionRegistry({
      store, registryManifestId: corporateActionRegistryManifestId,
    }).registryManifest;
  } catch (cause) {
    if (cause instanceof MarketDataL3Error) throw cause;
    throw new MarketDataL3Error(
      'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH',
      'corporate-action registry pin is missing, corrupt or foreign',
      { cause },
    );
  }
  const ancestors = pinAncestors(
    store, corporateActionRegistryManifestId, CA.REGISTRY,
    'supersedesRegistryManifestId', 'corporate-action registry pin',
  );
  for (const contributorPinId of [...new Set(contributorPinIds)].sort()) {
    if (contributorPinId !== corporateActionRegistryManifestId && !ancestors.has(contributorPinId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH',
        'contributing ingestion pin is not on the supplied corporate-action registry chain',
        { contributorPinId },
      );
    }
    const contributor = readTypedReference(
      store, contributorPinId, CA.REGISTRY, 'contributing corporate-action registry pin',
    );
    if (contributor.authorityPolicyId !== pinned.authorityPolicyId) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH',
        'contributing ingestion pin uses another corporate-action authority policy',
        { contributorPinId },
      );
    }
  }
}

/**
 * Resolve the provably knowable market-data series of one lineage under one
 * explicitly pinned ingestion registry at one explicit UTC knowledge cutoff.
 * @param {unknown} input
 */
export function resolveMarketDataAsOf(input) {
  const api = assertApiInput(input, ['ingestionRegistryManifestId', 'ingestionLineageId', 'knowledgeCutoff']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.ingestionRegistryManifestId, 'ingestionRegistryManifestId');
  assertCasId(api.ingestionLineageId, 'ingestionLineageId');
  assertUtcInstant(api.knowledgeCutoff, 'knowledgeCutoff');
  const store = api.store;
  const knowledgeCutoff = api.knowledgeCutoff;

  const { ingestionRegistryManifest: registry } = verifyMarketDataIngestionRegistry({
    store, ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });
  const chain = authoritativeIngestionChain(store, registry, api.ingestionLineageId);
  const { observationById, correctionById, introducedBy } = aggregateAuthoritativeObjects(
    store, chain, api.ingestionLineageId,
  );

  const visibleCorrections = new Map(
    [...correctionById].filter(([, correction]) => isVisibleAt(correction.knowledgeTimeUpperBound, knowledgeCutoff)),
  );
  if (visibleCorrections.size === 0) {
    throw new MarketDataL3Error(
      'MARKET_DATA_HISTORICAL_KNOWLEDGE_NOT_PROVABLE',
      'the lineage has authoritative objects but none is provably knowable at the cutoff',
      { knowledgeCutoff },
    );
  }

  const { tipByBar, visibleByBar } = deriveVisibleChains(visibleCorrections, correctionById, knowledgeCutoff);

  const resolvedBarEntries = [];
  for (const barIdentityId of [...tipByBar.keys()].sort()) {
    const tipId = tipByBar.get(barIdentityId);
    const tip = visibleCorrections.get(tipId);
    const { disposition, resolvedObservationId } = resolveTipDisposition(
      tipId, tip, visibleCorrections, visibleByBar,
    );
    if (disposition === 'PRESENT') {
      assertResolvedObservation(resolvedObservationId, barIdentityId, observationById, knowledgeCutoff);
    }
    const barIdentity = readTypedReference(
      store, barIdentityId, MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION, 'resolved bar identity',
    );
    resolvedBarEntries.push({
      barIdentityId,
      resolvedObservationId,
      resolvedCorrectionTipId: tipId,
      sessionDate: barIdentity.sessionDate,
      disposition,
    });
  }
  resolvedBarEntries.sort((left, right) => (
    left.sessionDate < right.sessionDate ? -1
      : left.sessionDate > right.sessionDate ? 1
        : left.barIdentityId < right.barIdentityId ? -1 : 1
  ));

  const closure = deriveContributingClosure(tipByBar, visibleCorrections, observationById, knowledgeCutoff);
  const contributingManifestIdSet = new Set();
  for (const objectId of [...closure.contributingCorrectionIds, ...closure.contributingObservationIds]) {
    contributingManifestIdSet.add(introducedBy.get(objectId));
  }
  const contributingIngestionManifestIds = [...contributingManifestIdSet].sort();
  const contributingManifests = chain
    .filter(({ ingestionManifestId }) => contributingManifestIdSet.has(ingestionManifestId))
    .map(({ ingestionManifest }) => ingestionManifest);

  const contributingAcquisitionRecordIds = [...new Set(
    contributingManifests.map((manifest) => manifest.acquisitionRecordId),
  )].sort();
  const contributingSourceArtifactIds = [...new Set(
    contributingManifests.map((manifest) => manifest.sourceArtifactId).filter((id) => id !== null),
  )].sort();

  const registryChain = orderedIngestionRegistryChain(store, api.ingestionRegistryManifestId);
  const contributingRegistryPrefixId = deriveContributingRegistryPrefixId(
    registryChain, contributingIngestionManifestIds,
  );

  const contributingKnowledgeModes = [
    ...closure.contributingCorrectionIds.map((id) => visibleCorrections.get(id).knowledgeMode),
    ...closure.contributingObservationIds.map((id) => observationById.get(id).knowledgeMode),
  ];
  const temporalCapability = deriveTemporalCapabilityFromKnowledgeModes(contributingKnowledgeModes);

  const identityRegistryManifestId = mostAdvancedChainPin(
    store,
    contributingManifests.map((manifest) => manifest.identityRegistryManifestId),
    INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
    'supersedesRegistryManifestId', 'instrument identity registry pin',
    'MARKET_DATA_IDENTITY_REGISTRY_MISMATCH',
  );
  const calendarRegistryManifestId = deriveCalendarPin(
    store,
    [
      ...contributingManifests.map((manifest) => manifest.calendarRegistryManifestId),
      ...closure.contributingObservationIds.map((id) => observationById.get(id).calendarRegistryManifestId),
    ],
    resolvedBarEntries,
  );

  const priceBasis = contributingManifests[0].priceBasis;
  const corporateActionTreatment = contributingManifests[0].corporateActionTreatment;
  for (const manifest of contributingManifests) {
    if (manifest.priceBasis !== priceBasis || manifest.corporateActionTreatment !== corporateActionTreatment) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH',
        'contributing ingestions mix price bases or corporate-action treatments',
      );
    }
  }

  return {
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
    ingestionLineageId: api.ingestionLineageId,
    knowledgeCutoff,
    resolvedBarEntries,
    contributingRegistryPrefixId,
    contributingIngestionManifestIds,
    contributingObservationIds: closure.contributingObservationIds,
    contributingCorrectionIds: closure.contributingCorrectionIds,
    contributingAcquisitionRecordIds,
    contributingSourceArtifactIds,
    temporalCapability,
    identityRegistryManifestId,
    calendarRegistryManifestId,
    contributingCorporateActionPinIds: [...new Set(
      contributingManifests.map((manifest) => manifest.corporateActionRegistryManifestId),
    )].sort(),
    priceBasis,
    corporateActionTreatment,
  };
}

/** Derive the exact canonical manifest value for one pin, lineage, cutoff and L2C pin. */
function deriveResolvedSeriesManifestValue(store, {
  ingestionRegistryManifestId, ingestionLineageId, knowledgeCutoff, corporateActionRegistryManifestId,
}) {
  const readModel = resolveMarketDataAsOf({
    store, ingestionRegistryManifestId, ingestionLineageId, knowledgeCutoff,
  });
  assertCorporateActionPin(store, corporateActionRegistryManifestId, readModel.contributingCorporateActionPinIds);
  return normalizeMarketDataResolvedSeriesManifestV1({
    schemaVersion: MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION,
    contributingRegistryPrefixId: readModel.contributingRegistryPrefixId,
    ingestionLineageId: readModel.ingestionLineageId,
    knowledgeCutoff: readModel.knowledgeCutoff,
    temporalCapability: readModel.temporalCapability,
    resolvedBarEntries: readModel.resolvedBarEntries,
    contributingIngestionManifestIds: readModel.contributingIngestionManifestIds,
    contributingObservationIds: readModel.contributingObservationIds,
    contributingCorrectionIds: readModel.contributingCorrectionIds,
    contributingAcquisitionRecordIds: readModel.contributingAcquisitionRecordIds,
    contributingSourceArtifactIds: readModel.contributingSourceArtifactIds,
    identityRegistryManifestId: readModel.identityRegistryManifestId,
    calendarRegistryManifestId: readModel.calendarRegistryManifestId,
    corporateActionRegistryManifestId,
    priceBasis: readModel.priceBasis,
    corporateActionTreatment: readModel.corporateActionTreatment,
  });
}

const FIELD_MISMATCH_CODES = Object.freeze({
  temporalCapability: 'MARKET_DATA_TEMPORAL_CAPABILITY_DERIVATION_MISMATCH',
  priceBasis: 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH',
  corporateActionTreatment: 'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH',
  identityRegistryManifestId: 'MARKET_DATA_IDENTITY_REGISTRY_MISMATCH',
  calendarRegistryManifestId: 'MARKET_DATA_CALENDAR_REGISTRY_MISMATCH',
});

const CONTRIBUTOR_FIELDS = Object.freeze([
  'contributingIngestionManifestIds',
  'contributingObservationIds',
  'contributingCorrectionIds',
  'contributingAcquisitionRecordIds',
  'contributingSourceArtifactIds',
]);

/** Compare one stored manifest against its exact recomputation, fail-closed with targeted codes. */
function assertManifestMatchesRecomputation(stored, expected) {
  for (const field of CONTRIBUTOR_FIELDS) {
    const storedSet = new Set(stored[field]);
    const expectedSet = new Set(expected[field]);
    const omitted = expected[field].filter((id) => !storedSet.has(id));
    if (omitted.length > 0) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_INCOMPLETE',
        `stored manifest omits contributing IDs in ${field}`,
        { field, omitted },
      );
    }
    const extra = stored[field].filter((id) => !expectedSet.has(id));
    if (extra.length > 0) {
      throw new MarketDataL3Error(
        'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
        `stored manifest lists non-contributing IDs in ${field}`,
        { field, extra },
      );
    }
  }
  for (const [field, code] of Object.entries(FIELD_MISMATCH_CODES)) {
    if (!canonicalValuesEqual(stored[field], expected[field])) {
      throw new MarketDataL3Error(code, `stored manifest ${field} diverges from recomputation`, {
        field, stored: stored[field], expected: expected[field],
      });
    }
  }
  if (!canonicalValuesEqual(stored, expected)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_RESOLVED_SERIES_CONFLICT',
      'stored resolved-series manifest diverges from its recomputed read model',
    );
  }
}

/**
 * Build, store, re-read and verify one MarketDataResolvedSeriesManifest/1.
 * The caller never supplies a read model or free contributor arrays.
 * @param {unknown} input
 */
export function buildMarketDataResolvedSeriesManifest(input) {
  const api = assertApiInput(input, [
    'ingestionRegistryManifestId', 'ingestionLineageId', 'knowledgeCutoff', 'corporateActionRegistryManifestId',
  ]);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.ingestionRegistryManifestId, 'ingestionRegistryManifestId');
  assertCasId(api.ingestionLineageId, 'ingestionLineageId');
  assertUtcInstant(api.knowledgeCutoff, 'knowledgeCutoff');
  assertCasId(api.corporateActionRegistryManifestId, 'corporateActionRegistryManifestId');

  const manifest = deriveResolvedSeriesManifestValue(api.store, {
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
    ingestionLineageId: api.ingestionLineageId,
    knowledgeCutoff: api.knowledgeCutoff,
    corporateActionRegistryManifestId: api.corporateActionRegistryManifestId,
  });
  const stored = putCanonicalL3(api.store, MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION, manifest);
  verifyMarketDataResolvedSeriesManifest({ store: api.store, resolvedSeriesManifestId: stored.objectId });
  return { resolvedSeriesManifestId: stored.objectId };
}

/** The stored pins and enums must be internally coherent before any replay. */
function assertStoredManifestCoherence(store, manifest) {
  if (deriveCorporateActionTreatment(manifest.priceBasis) !== manifest.corporateActionTreatment) {
    throw new MarketDataL3Error(
      'MARKET_DATA_CORPORATE_ACTION_TREATMENT_MISMATCH',
      'stored corporateActionTreatment is inconsistent with the stored priceBasis',
    );
  }
  const calendar = verifyMarketCalendarRegistry({
    store, calendarRegistryManifestId: manifest.calendarRegistryManifestId,
  });
  const coveredDates = new Set(
    calendar.calendars.flatMap((core) => core.sessions.map((session) => session.sessionDate)),
  );
  for (const entry of manifest.resolvedBarEntries) {
    if (!coveredDates.has(entry.sessionDate)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_CALENDAR_COVERAGE_INCOMPLETE',
        'stored calendar pin does not cover every resolved session',
        { sessionDate: entry.sessionDate },
      );
    }
  }
}

/**
 * Verify one stored manifest beyond its shape: replay the resolver under the
 * stored contributing registry prefix and compare the full content.
 * @param {unknown} input
 */
export function verifyMarketDataResolvedSeriesManifest(input) {
  const api = assertApiInput(input, ['resolvedSeriesManifestId']);
  const raw = readTypedReference(
    api.store, api.resolvedSeriesManifestId,
    MARKET_DATA_RESOLVED_SERIES_MANIFEST_SCHEMA_VERSION, 'resolved-series manifest',
  );
  const manifest = normalizeMarketDataResolvedSeriesManifestV1(raw);
  assertStoredManifestCoherence(api.store, manifest);
  const expected = deriveResolvedSeriesManifestValue(api.store, {
    ingestionRegistryManifestId: manifest.contributingRegistryPrefixId,
    ingestionLineageId: manifest.ingestionLineageId,
    knowledgeCutoff: manifest.knowledgeCutoff,
    corporateActionRegistryManifestId: manifest.corporateActionRegistryManifestId,
  });
  assertManifestMatchesRecomputation(manifest, expected);
  return { resolvedSeriesManifestId: api.resolvedSeriesManifestId, resolvedSeriesManifest: manifest };
}

/**
 * Verify one stored manifest under an explicitly supplied calling registry pin:
 * the pin must descend from the stored prefix, authorize every contributor and
 * replay to the exact same manifest content.
 * @param {unknown} input
 */
export function verifyMarketDataResolvedSeries(input) {
  const api = assertApiInput(input, ['resolvedSeriesManifestId', 'ingestionRegistryManifestId']);
  assertCasId(api.resolvedSeriesManifestId, 'resolvedSeriesManifestId');
  assertCasId(api.ingestionRegistryManifestId, 'ingestionRegistryManifestId');

  const { resolvedSeriesManifest: manifest } = verifyMarketDataResolvedSeriesManifest({
    store: api.store, resolvedSeriesManifestId: api.resolvedSeriesManifestId,
  });

  const { ingestionRegistryManifest: callRegistry } = verifyMarketDataIngestionRegistry({
    store: api.store, ingestionRegistryManifestId: api.ingestionRegistryManifestId,
  });
  if (api.ingestionRegistryManifestId !== manifest.contributingRegistryPrefixId) {
    const ancestors = pinAncestors(
      api.store, api.ingestionRegistryManifestId,
      MARKET_DATA_INGESTION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      'supersedesIngestionRegistryManifestId', 'calling ingestion registry',
    );
    if (!ancestors.has(manifest.contributingRegistryPrefixId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INGESTION_STALE_BASE',
        'calling registry does not descend from the contributing registry prefix',
      );
    }
  }
  const listed = new Set(callRegistry.ingestionManifestIds);
  for (const ingestionManifestId of manifest.contributingIngestionManifestIds) {
    if (!listed.has(ingestionManifestId)) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INGESTION_STALE_BASE',
        'a contributing ingestion manifest is not authorized under the calling registry',
        { ingestionManifestId },
      );
    }
  }

  const expected = deriveResolvedSeriesManifestValue(api.store, {
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
    ingestionLineageId: manifest.ingestionLineageId,
    knowledgeCutoff: manifest.knowledgeCutoff,
    corporateActionRegistryManifestId: manifest.corporateActionRegistryManifestId,
  });
  assertManifestMatchesRecomputation(manifest, expected);
  return {
    resolvedSeriesManifestId: api.resolvedSeriesManifestId,
    ingestionRegistryManifestId: api.ingestionRegistryManifestId,
    resolvedSeriesManifest: manifest,
  };
}
