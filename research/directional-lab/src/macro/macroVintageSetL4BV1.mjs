/**
 * L4B-I1 pinned vintage set: total canonical ordering, single causal chain
 * per observation, deterministic conflict and cycle detection, policy scope
 * admission and append-only supersession. Every counter, bound and digest is
 * recomputed; the wire manifest is compared byte-for-byte.
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
  MACRO_UNIT_MAX_SCALE,
  MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
  compareMacroVintageOrderKeys,
  macroOrderedVintageIdentityDigestV1,
  macroVintageSetFlatEntriesV1,
  normalizeMacroVintageSetManifestV1,
} from '../contracts/macroIngestionContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
  verifyMacroIngestionPolicy,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroSeriesRegistryManifest } from './macroSeriesRegistryL4BV1.mjs';
import {
  assertMacroVintageReleaseResolutionV1,
  verifyMacroObservationVintageCore,
} from './macroObservationVintageL4BV1.mjs';

/**
 * Policy admission of one fully verified vintage against its series:
 * closed scope, completeness classes, revision-sensitivity and
 * series-specific release rules. Fail-closed on every divergence.
 */
export function assertMacroVintageAdmissibleV1(policy, series, observation, vintage) {
  if (series.jurisdictionCode !== policy.jurisdictionCode
      || series.currencyCode !== policy.currencyCode) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_NOT_IN_SCOPE',
      'series jurisdiction or currency is outside the closed policy scope');
  }
  if (!policy.allowedSourceAuthorities.includes(series.sourceAuthority)
      || !policy.allowedSeriesCodes.includes(series.canonicalSeriesCode)
      || !policy.allowedFrequencies.includes(series.frequency)
      || !policy.allowedUnits.includes(series.units)
      || !policy.allowedSeasonalAdjustments.includes(series.seasonalAdjustment)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_NOT_IN_SCOPE',
      'series is outside the closed policy scope');
  }
  if (!policy.allowedRevisionKinds.includes(vintage.revisionKind)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_INVALID',
      'revision kind is outside the closed policy scope');
  }
  if (!policy.allowedCompletenessClasses.includes(vintage.vintageCompletenessClass)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN',
      'vintage completeness class is forbidden by the closed policy');
  }
  if (vintage.vintageCompletenessClass === 'FINAL_ONLY'
      && policy.revisionSensitiveSeriesCodes.includes(series.canonicalSeriesCode)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN',
      'FINAL_ONLY data is forbidden for revision-sensitive series');
  }
  if (vintage.vintageCompletenessClass === 'PUBLICATION_ATTESTED'
      && !policy.publicationAttestedSeriesCodes.includes(series.canonicalSeriesCode)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN',
      'PUBLICATION_ATTESTED is only allowed for explicitly declared series');
  }
  if (vintage.value !== null) {
    const maxScale = MACRO_UNIT_MAX_SCALE[series.units];
    if (vintage.value.scale > maxScale) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_UNIT_MISMATCH',
        'fixed-point scale is incompatible with the series unit');
    }
  }
  assertMacroVintageReleaseResolutionV1(policy, series, vintage);
}

/**
 * Validate the vintage graph of one observation: exactly one INITIAL, a
 * single causal chain (no branch), strictly increasing sequences,
 * non-decreasing availableAt, parents inside the same observation and no
 * cycle. Insertion order never breaks ties: any ambiguity is a conflict.
 */
export function verifyMacroObservationVintageGraphV1(observationIdentityId, vintages) {
  const byIdentityId = new Map();
  for (const vintage of vintages) {
    if (vintage.observationIdentityId !== observationIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH',
        'vintage is grouped under the wrong observation');
    }
    const existing = byIdentityId.get(vintage.macroVintageIdentityId);
    if (existing) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CONFLICT',
        'two vintage contents claim the same temporal identity');
    }
    byIdentityId.set(vintage.macroVintageIdentityId, vintage);
  }
  const initials = vintages.filter((vintage) => vintage.revisionKind === 'INITIAL');
  if (initials.length !== 1) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CONFLICT',
      'an observation requires exactly one INITIAL vintage');
  }
  const sequences = new Set();
  for (const vintage of vintages) {
    if (sequences.has(vintage.vintageSequence)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID',
        'two vintages claim the same sequence for one observation');
    }
    sequences.add(vintage.vintageSequence);
  }
  // Topology first: missing parent, self-parent, concurrent branches, then DFS
  // cycles. Sequence / availableAt monotonicity is checked only after the
  // parent graph is proven acyclic so multi-node cycles surface as CYCLE.
  const childByParent = new Map();
  for (const vintage of vintages) {
    const parentId = vintage.parentVintageId;
    if (parentId === null) continue;
    if (parentId === vintage.macroVintageIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CYCLE',
        'a vintage cannot be its own parent');
    }
    const parent = byIdentityId.get(parentId);
    if (!parent) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH',
        'parent vintage is absent from the observation chain');
    }
    if (childByParent.has(parentId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CONFLICT',
        'two vintages branch from the same parent');
    }
    childByParent.set(parentId, vintage.macroVintageIdentityId);
  }
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CYCLE',
        'vintage parent graph contains a cycle');
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    const parentId = byIdentityId.get(id).parentVintageId;
    if (parentId !== null && byIdentityId.has(parentId)) visit(parentId);
    state.set(id, 2);
  };
  for (const id of [...byIdentityId.keys()].sort()) visit(id);
  for (const vintage of vintages) {
    const parentId = vintage.parentVintageId;
    if (parentId === null) continue;
    const parent = byIdentityId.get(parentId);
    if (vintage.vintageSequence <= parent.vintageSequence) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_SEQUENCE_INVALID',
        'child sequence must be strictly greater than its parent');
    }
    if (vintage.availableAt < parent.availableAt) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
        'child availableAt cannot precede its parent');
    }
  }
}

function expectedManifestValue(input) {
  const flat = macroVintageSetFlatEntriesV1(input.orderedObservationEntries);
  const availableAts = flat.map((entry) => entry.availableAt).sort();
  return normalizeMacroVintageSetManifestV1({
    schemaVersion: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
    macroSeriesRegistryManifestId: input.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: input.macroIngestionPolicyId,
    supersedesVintageSetManifestId: input.supersedesVintageSetManifestId,
    orderedObservationEntries: input.orderedObservationEntries,
    orderedVintageIds: flat.map((entry) => entry.observationVintageId),
    observationCount: input.orderedObservationEntries.length,
    vintageCount: flat.length,
    firstAvailableAt: availableAts.length === 0 ? null : availableAts[0],
    lastAvailableAt: availableAts.length === 0 ? null : availableAts[availableAts.length - 1],
    orderedVintageIdentityDigest: macroOrderedVintageIdentityDigestV1(flat),
  });
}

function loadAndVerifyEntries(store, policy, manifest) {
  const verifiedByVintageId = new Map();
  const identityOwners = new Map();
  for (const observationEntry of manifest.orderedObservationEntries) {
    const chainVintages = [];
    for (const vintageEntry of observationEntry.orderedVintages) {
      const verified = verifyMacroObservationVintageCore({
        store, observationVintageId: vintageEntry.observationVintageId,
      });
      const vintage = verified.observationVintage;
      if (vintage.macroVintageIdentityId !== vintageEntry.macroVintageIdentityId
          || vintage.availableAt !== vintageEntry.availableAt
          || vintage.vintageSequence !== vintageEntry.vintageSequence
          || vintage.observationIdentityId !== observationEntry.observationIdentityId) {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_REFERENCE_MISMATCH',
          'vintage set entry diverges from its verified vintage content');
      }
      if (verified.observationIdentity.macroSeriesIdentityId
          !== observationEntry.macroSeriesIdentityId
          || verified.observationIdentity.observationPeriodStart
          !== observationEntry.observationPeriodStart
          || verified.observationIdentity.observationPeriodEnd
          !== observationEntry.observationPeriodEnd) {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_REFERENCE_MISMATCH',
          'observation entry diverges from its verified observation identity');
      }
      const previousOwner = identityOwners.get(vintage.macroVintageIdentityId);
      if (previousOwner !== undefined && previousOwner !== vintageEntry.observationVintageId) {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CONFLICT',
          'two different contents are pinned under one vintage identity');
      }
      identityOwners.set(vintage.macroVintageIdentityId, vintageEntry.observationVintageId);
      assertMacroVintageAdmissibleV1(policy, verified.macroSeriesIdentity,
        verified.observationIdentity, vintage);
      chainVintages.push(vintage);
      verifiedByVintageId.set(vintageEntry.observationVintageId, verified);
    }
    verifyMacroObservationVintageGraphV1(observationEntry.observationIdentityId, chainVintages);
  }
  return verifiedByVintageId;
}

function assertSeriesPinnedInRegistry(registry, manifest) {
  const registryIds = new Set(registry.orderedSeriesEntries
    .map((entry) => entry.macroSeriesIdentityId));
  for (const observationEntry of manifest.orderedObservationEntries) {
    if (!registryIds.has(observationEntry.macroSeriesIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_NOT_IN_SCOPE',
        'observation series is absent from the pinned series registry');
    }
  }
}

function verifyAppendOnlyChain(store, tipManifestId) {
  const seen = new Set();
  const descending = [];
  let cursorId = tipManifestId;
  while (cursorId !== null) {
    if (seen.has(cursorId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CYCLE',
        'vintage set supersession chain contains a cycle');
    }
    seen.add(cursorId);
    const manifest = normalizeMacroVintageSetManifestV1(readTypedReference(
      store, cursorId, MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION, 'macro vintage set'));
    if (manifest.supersedesVintageSetManifestId === cursorId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CYCLE',
        'vintage set cannot supersede itself');
    }
    descending.push({ vintageSetManifestId: cursorId, manifest });
    cursorId = manifest.supersedesVintageSetManifestId;
  }
  const chain = descending.reverse();
  for (let index = 1; index < chain.length; index += 1) {
    const parent = chain[index - 1].manifest;
    const child = chain[index].manifest;
    if (child.macroSeriesRegistryManifestId !== parent.macroSeriesRegistryManifestId
        || child.macroIngestionPolicyId !== parent.macroIngestionPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_REFERENCE_MISMATCH',
        'vintage set chain changes its pinned policy or registry');
    }
    const childFlat = macroVintageSetFlatEntriesV1(child.orderedObservationEntries);
    const childByVintageId = new Map(childFlat.map((entry) => [entry.observationVintageId, entry]));
    const parentFlat = macroVintageSetFlatEntriesV1(parent.orderedObservationEntries);
    if (childFlat.length < parentFlat.length) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_APPEND_ONLY_VIOLATION',
        'vintage set child removed historical vintages');
    }
    for (const parentEntry of parentFlat) {
      const preserved = childByVintageId.get(parentEntry.observationVintageId);
      if (!preserved || !canonicalValuesEqual(preserved, parentEntry)) {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_APPEND_ONLY_VIOLATION',
          'vintage set child removed or mutated a historical vintage');
      }
    }
  }
  return chain;
}

/**
 * Authoritative vintage set verifier: policy, registry, every observation,
 * every vintage identity and content, source documents, graphs, conflicts,
 * cycles, scope, append-only history — then the full expected manifest is
 * rebuilt and compared in CanonicalJSON byte-for-byte.
 */
export function verifyMacroVintageSetManifest(input) {
  const api = assertApiInput(input, ['macroVintageSetManifestId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroVintageSetManifestId, 'macroVintageSetManifestId');
  assertCasId(api.macroVintageSetManifestId, 'macroVintageSetManifestId');
  const chain = verifyAppendOnlyChain(api.store, api.macroVintageSetManifestId);
  const current = chain.at(-1);
  const manifest = current.manifest;
  const { macroIngestionPolicy: policy } = verifyMacroIngestionPolicy({
    store: api.store, macroIngestionPolicyId: manifest.macroIngestionPolicyId,
  });
  const registry = verifyMacroSeriesRegistryManifest({
    store: api.store, macroSeriesRegistryManifestId: manifest.macroSeriesRegistryManifestId,
  });
  assertSeriesPinnedInRegistry(registry.registry, manifest);
  loadAndVerifyEntries(api.store, policy, manifest);
  const expected = expectedManifestValue(manifest);
  if (!canonicalValuesEqual(manifest, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_CANONICAL_MISMATCH',
      'vintage set manifest diverges from its recomputed canonical value');
  }
  return {
    macroVintageSetManifestId: current.vintageSetManifestId,
    vintageSet: manifest,
    vintageSetChain: chain,
    macroIngestionPolicy: policy,
    seriesRegistry: registry.registry,
  };
}

function groupVintages(store, observationVintageIds) {
  const observations = new Map();
  for (const observationVintageId of observationVintageIds) {
    const verified = verifyMacroObservationVintageCore({ store, observationVintageId });
    const key = verified.observationVintage.observationIdentityId;
    if (!observations.has(key)) {
      observations.set(key, {
        observationIdentityId: key,
        macroSeriesIdentityId: verified.observationIdentity.macroSeriesIdentityId,
        observationPeriodStart: verified.observationIdentity.observationPeriodStart,
        observationPeriodEnd: verified.observationIdentity.observationPeriodEnd,
        vintages: [],
      });
    }
    observations.get(key).vintages.push(verified);
  }
  const entries = [...observations.values()].map((observation) => ({
    observationIdentityId: observation.observationIdentityId,
    macroSeriesIdentityId: observation.macroSeriesIdentityId,
    observationPeriodStart: observation.observationPeriodStart,
    observationPeriodEnd: observation.observationPeriodEnd,
    orderedVintages: observation.vintages
      .map((verified) => ({
        observationVintageId: verified.observationVintageId,
        macroVintageIdentityId: verified.observationVintage.macroVintageIdentityId,
        availableAt: verified.observationVintage.availableAt,
        vintageSequence: verified.observationVintage.vintageSequence,
      }))
      .sort((left, right) => compareMacroVintageOrderKeys(
        { macroSeriesIdentityId: observation.macroSeriesIdentityId,
          observationPeriodStart: observation.observationPeriodStart,
          observationPeriodEnd: observation.observationPeriodEnd,
          observationIdentityId: observation.observationIdentityId, ...left },
        { macroSeriesIdentityId: observation.macroSeriesIdentityId,
          observationPeriodStart: observation.observationPeriodStart,
          observationPeriodEnd: observation.observationPeriodEnd,
          observationIdentityId: observation.observationIdentityId, ...right })),
  }));
  entries.sort((left, right) => compareMacroVintageOrderKeys(
    { ...left, ...left.orderedVintages[0] }, { ...right, ...right.orderedVintages[0] }));
  return entries;
}

/**
 * Deterministic builder: groups explicit pinned vintage contents into the
 * canonical order (insertion order is irrelevant), derives every counter,
 * bound and digest, then re-verifies the stored manifest from scratch.
 * @param {{store: any, macroSeriesRegistryManifestId: string,
 *   macroIngestionPolicyId: string, supersedesVintageSetManifestId: string|null,
 *   observationVintageIds: string[]}} input
 */
export function buildMacroVintageSetManifest(input) {
  const api = assertApiInput(input, ['macroSeriesRegistryManifestId', 'macroIngestionPolicyId',
    'supersedesVintageSetManifestId', 'observationVintageIds']);
  assertStore(api.store, MACRO_STORE_METHODS);
  if (!Array.isArray(api.observationVintageIds)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_INVALID',
      'observationVintageIds must be an array');
  }
  if (new Set(api.observationVintageIds).size !== api.observationVintageIds.length) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CONFLICT',
      'duplicate vintage references in one vintage set');
  }
  const orderedObservationEntries = groupVintages(api.store, api.observationVintageIds);
  const flat = macroVintageSetFlatEntriesV1(orderedObservationEntries);
  const availableAts = flat.map((entry) => entry.availableAt).sort();
  const manifest = normalizeMacroVintageSetManifestV1({
    schemaVersion: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
    macroSeriesRegistryManifestId: api.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: api.macroIngestionPolicyId,
    supersedesVintageSetManifestId: api.supersedesVintageSetManifestId,
    orderedObservationEntries,
    orderedVintageIds: flat.map((entry) => entry.observationVintageId),
    observationCount: orderedObservationEntries.length,
    vintageCount: flat.length,
    firstAvailableAt: availableAts.length === 0 ? null : availableAts[0],
    lastAvailableAt: availableAts.length === 0 ? null : availableAts[availableAts.length - 1],
    orderedVintageIdentityDigest: macroOrderedVintageIdentityDigestV1(flat),
  });
  const stored = putCanonicalL3(api.store, MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION, manifest);
  verifyMacroVintageSetManifest({
    store: api.store, macroVintageSetManifestId: stored.objectId,
  });
  return { macroVintageSetManifestId: stored.objectId, vintageSet: stored.value };
}
