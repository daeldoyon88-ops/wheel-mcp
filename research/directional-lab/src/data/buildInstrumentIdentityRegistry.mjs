/**
 * L2B global instrument identity registry — authoritative, append-only.
 */

import {
  INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
  InstrumentIdentityError,
  effectiveBindingInterval,
  halfOpenIntervalsOverlap,
  isSortedIdSubset,
  normalizeInstrumentIdentityRegistryManifestV1,
} from '../contracts/instrumentIdentityV1.mjs';
import { sortedUniqueStrings } from '../contracts/contractPrimitivesV1.mjs';
import {
  assertBuildInput,
  assertObjectId,
  assertStore,
  putCanonical,
  readSnapshotObject,
} from './instrumentIdentityStore.mjs';
import { verifyInstrumentIdentityAuthorityPolicy } from './instrumentIdentityBuildersCore.mjs';
import { verifyInstrumentIdentityManifest } from './buildInstrumentIdentityManifest.mjs';
import { verifyDatasetSnapshotInstrumentBinding } from './buildDatasetSnapshotInstrumentBinding.mjs';

/**
 * @param {any[]} identityBundles
 */
function assertGlobalAliasUniqueness(identityBundles) {
  /** @type {{identityId: string, bindingId: string, binding: any, revFrom: string|null}[]} */
  const entries = [];
  for (const bundle of identityBundles) {
    for (const entry of bundle.aliases) {
      entries.push({
        identityId: bundle.identityManifest.instrumentIdentityId,
        bindingId: entry.aliasBindingCoreId,
        binding: entry.aliasBindingCore,
        revFrom: bundle.aliasRevocationByBinding.get(entry.aliasBindingCoreId) ?? null,
      });
    }
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.identityId === b.identityId) continue;
      const ba = a.binding;
      const bb = b.binding;
      if (ba.namespacePolicyId !== bb.namespacePolicyId
        || ba.providerId !== bb.providerId
        || ba.symbolLookupKey !== bb.symbolLookupKey
        || ba.venueId !== bb.venueId
        || ba.currency !== bb.currency) {
        continue;
      }
      const effA = effectiveBindingInterval(ba.validFrom, ba.validToExclusive, a.revFrom);
      const effB = effectiveBindingInterval(bb.validFrom, bb.validToExclusive, b.revFrom);
      if (halfOpenIntervalsOverlap(effA.validFrom, effA.validToExclusive, effB.validFrom, effB.validToExclusive)) {
        throw new InstrumentIdentityError('INSTRUMENT_ALIAS_AMBIGUOUS',
          'active alias bindings overlap across identities in the registry', {
            instrumentIdentityIds: [a.identityId, b.identityId],
          });
      }
    }
  }
}

/**
 * @param {any[]} identityBundles
 */
function assertGlobalProviderUniqueness(identityBundles) {
  /** @type {{identityId: string, bindingId: string, binding: any, revFrom: string|null}[]} */
  const entries = [];
  for (const bundle of identityBundles) {
    for (const entry of bundle.providers) {
      entries.push({
        identityId: bundle.identityManifest.instrumentIdentityId,
        bindingId: entry.providerBindingCoreId,
        binding: entry.providerBindingCore,
        revFrom: bundle.providerRevocationByBinding.get(entry.providerBindingCoreId) ?? null,
      });
    }
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.identityId === b.identityId) continue;
      if (a.binding.providerId !== b.binding.providerId
        || a.binding.providerInstrumentId !== b.binding.providerInstrumentId) {
        continue;
      }
      const effA = effectiveBindingInterval(a.binding.validFrom, a.binding.validToExclusive, a.revFrom);
      const effB = effectiveBindingInterval(b.binding.validFrom, b.binding.validToExclusive, b.revFrom);
      if (halfOpenIntervalsOverlap(effA.validFrom, effA.validToExclusive, effB.validFrom, effB.validToExclusive)) {
        throw new InstrumentIdentityError('PROVIDER_INSTRUMENT_BINDING_AMBIGUOUS',
          'provider instrument IDs overlap across identities in the registry', {
            instrumentIdentityIds: [a.identityId, b.identityId],
          });
      }
    }
  }
}

/**
 * @param {any[]} snapshotBindings
 */
function assertGlobalSnapshotUniqueness(snapshotBindings) {
  /** @type {Map<string, any>} */
  const bySnapshot = new Map();
  for (const entry of snapshotBindings) {
    const binding = entry.snapshotInstrumentBinding;
    const previous = bySnapshot.get(binding.snapshotCoreId);
    if (!previous) {
      bySnapshot.set(binding.snapshotCoreId, binding);
      continue;
    }
    const identical = previous.instrumentIdentityId === binding.instrumentIdentityId
      && previous.aliasBindingCoreId === binding.aliasBindingCoreId
      && previous.resolutionDate === binding.resolutionDate
      && previous.canonicalSymbolObserved === binding.canonicalSymbolObserved
      && previous.providerSymbolObserved === binding.providerSymbolObserved
      && previous.providerId === binding.providerId;
    if (!identical) {
      throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_CONFLICT',
        'snapshot is bound to conflicting instrument identities', {
          snapshotCoreId: binding.snapshotCoreId,
        });
    }
  }
}

/**
 * @param {any} store
 * @param {ReturnType<typeof normalizeInstrumentIdentityRegistryManifestV1>} registry
 * @param {string|null} registryId
 * @param {Set<string>} visited
 */
function verifyRegistrySupersedesChain(store, registry, registryId, visited) {
  if (registry.supersedesRegistryManifestId === null) return;
  if (registryId !== null && registry.supersedesRegistryManifestId === registryId) {
    throw new InstrumentIdentityError('INSTRUMENT_REGISTRY_CYCLE', 'registry cannot supersede itself');
  }
  if (visited.has(registry.supersedesRegistryManifestId)) {
    throw new InstrumentIdentityError('INSTRUMENT_REGISTRY_CYCLE', 'registry supersedes chain has a cycle');
  }
  visited.add(registry.supersedesRegistryManifestId);
  const previous = readSnapshotObject(
    store,
    registry.supersedesRegistryManifestId,
    INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
    'superseded registry',
  );
  if (previous.authorityPolicyId !== registry.authorityPolicyId) {
    throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_REGISTRY_INVALID',
      'superseded registry uses a different authority policy');
  }
  if (!isSortedIdSubset(previous.identityManifestIds, registry.identityManifestIds)) {
    throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_REGISTRY_INVALID',
      'append-only violation: identityManifestIds from superseded registry not preserved');
  }
  if (!isSortedIdSubset(previous.snapshotInstrumentBindingIds, registry.snapshotInstrumentBindingIds)) {
    throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_REGISTRY_INVALID',
      'append-only violation: snapshotInstrumentBindingIds from superseded registry not preserved');
  }
  resolveRegistryReferences(store, previous, registry.supersedesRegistryManifestId, visited);
}

/**
 * @param {any} store
 * @param {ReturnType<typeof normalizeInstrumentIdentityRegistryManifestV1>} registry
 * @param {string|null} [registryId]
 * @param {Set<string>} [visited]
 */
export function resolveRegistryReferences(store, registry, registryId = null, visited = new Set()) {
  if (registryId !== null) visited.add(registryId);
  const { authorityPolicy } = verifyInstrumentIdentityAuthorityPolicy({
    store, authorityPolicyId: registry.authorityPolicyId,
  });

  verifyRegistrySupersedesChain(store, registry, registryId, visited);

  const allIdentityBundles = registry.identityManifestIds.map((id) => (
    verifyInstrumentIdentityManifest({ store, identityManifestId: id })
  ));

  for (const bundle of allIdentityBundles) {
    if (bundle.identityCore.authorityPolicyId !== registry.authorityPolicyId) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_REGISTRY_INVALID',
        'identity manifest authority policy does not match registry', {
          identityManifestId: bundle.identityManifestId,
        });
    }
  }

  // Append-only registries retain historical manifests. Uniqueness and resolution
  // use only tip manifests (not superseded by another listed manifest).
  const listed = new Set(registry.identityManifestIds);
  const supersededIds = new Set(
    allIdentityBundles
      .filter((bundle) => listed.has(bundle.identityManifest.supersedesManifestId))
      .map((bundle) => bundle.identityManifest.supersedesManifestId),
  );
  const identityBundles = allIdentityBundles.filter(
    (bundle) => !supersededIds.has(bundle.identityManifestId),
  );

  /** @type {Map<string, string>} */
  const tipByIdentity = new Map();
  for (const bundle of identityBundles) {
    const identityId = bundle.identityManifest.instrumentIdentityId;
    if (tipByIdentity.has(identityId)) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_REGISTRY_INVALID',
        'multiple tip manifests for the same instrument identity', { instrumentIdentityId: identityId });
    }
    tipByIdentity.set(identityId, bundle.identityManifestId);
  }

  const snapshotBindings = registry.snapshotInstrumentBindingIds.map((id) => (
    verifyDatasetSnapshotInstrumentBinding({ store, snapshotInstrumentBindingId: id })
  ));

  for (const entry of snapshotBindings) {
    if (!tipByIdentity.has(entry.snapshotInstrumentBinding.instrumentIdentityId)) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_REGISTRY_INVALID',
        'snapshot binding identity is not covered by registry manifests');
    }
  }

  assertGlobalAliasUniqueness(identityBundles);
  assertGlobalProviderUniqueness(identityBundles);
  assertGlobalSnapshotUniqueness(snapshotBindings);

  return {
    authorityPolicy,
    identityBundles,
    allIdentityBundles,
    snapshotBindings,
  };
}

/**
 * @param {{
 *   store: any,
 *   authorityPolicyId: string,
 *   identityManifestIds: string[],
 *   snapshotInstrumentBindingIds?: string[],
 *   supersedesRegistryManifestId?: string|null,
 * }} input
 */
export function buildInstrumentIdentityRegistry(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.authorityPolicyId, 'authorityPolicyId');
  if (!Array.isArray(input.identityManifestIds)) {
    throw new InstrumentIdentityError(
      'INSTRUMENT_IDENTITY_REGISTRY_INVALID',
      'identityManifestIds must be an explicitly supplied array',
    );
  }
  const candidate = normalizeInstrumentIdentityRegistryManifestV1({
    schemaVersion: INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId: input.authorityPolicyId,
    identityManifestIds: sortedUniqueStrings(input.identityManifestIds),
    snapshotInstrumentBindingIds: sortedUniqueStrings(input.snapshotInstrumentBindingIds ?? []),
    supersedesRegistryManifestId: input.supersedesRegistryManifestId ?? null,
  });
  const resolved = resolveRegistryReferences(input.store, candidate, null, new Set());
  const stored = putCanonical(input.store, INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION, candidate);
  return {
    registryManifestId: stored.objectId,
    registryManifest: stored.value,
    registryManifestObject: stored,
    ...resolved,
  };
}

/** @param {{store: any, registryManifestId: string}} input */
export function verifyInstrumentIdentityRegistry(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.registryManifestId, 'registryManifestId');
  const registryManifest = readSnapshotObject(
    input.store,
    input.registryManifestId,
    INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
    'registry manifest',
  );
  const resolved = resolveRegistryReferences(
    input.store, registryManifest, input.registryManifestId, new Set(),
  );
  return {
    registryManifestId: input.registryManifestId,
    registryManifest,
    ...resolved,
  };
}

/**
 * ID-only recovery of the full registry dependency graph.
 * @param {{store: any, registryManifestId: string}} input
 */
export function recoverInstrumentIdentityRegistry(input) {
  return verifyInstrumentIdentityRegistry(input);
}
