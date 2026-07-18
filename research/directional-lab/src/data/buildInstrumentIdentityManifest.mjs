/**
 * L2B identity manifest builder/verifier with recursive append-only supersedes.
 */

import {
  INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION,
  InstrumentIdentityError,
  effectiveBindingInterval,
  halfOpenIntervalsOverlap,
  isSortedIdSubset,
  normalizeInstrumentIdentityManifestV1,
} from '../contracts/instrumentIdentityV1.mjs';
import { sortedUniqueStrings } from '../contracts/contractPrimitivesV1.mjs';
import {
  assertBuildInput,
  assertObjectId,
  assertStore,
  putCanonical,
  readSnapshotObject,
} from './instrumentIdentityStore.mjs';
import {
  verifyInstrumentAliasBinding,
  verifyInstrumentAliasRevocation,
  verifyInstrumentDescriptor,
  verifyInstrumentIdentity,
  verifyInstrumentIdentityRecord,
  verifyProviderInstrumentBinding,
  verifyProviderInstrumentRevocation,
} from './instrumentIdentityBuildersCore.mjs';

/**
 * @param {Map<string, string>} revocationByBinding
 * @param {string} bindingId
 * @param {string} effectiveFrom
 */
function registerEarliestRevocation(revocationByBinding, bindingId, effectiveFrom) {
  const existing = revocationByBinding.get(bindingId);
  if (existing === undefined) {
    revocationByBinding.set(bindingId, effectiveFrom);
    return;
  }
  if (existing !== effectiveFrom) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_REVOCATION_INVALID',
      'contradictory revocations for the same binding', { bindingId, existing, effectiveFrom });
  }
}

/**
 * @param {{id: string, binding: any}[]} entries
 * @param {Map<string, string>} revocationByBinding
 */
function findInternalAliasOverlaps(entries, revocationByBinding) {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].binding;
      const b = entries[j].binding;
      if (a.namespacePolicyId !== b.namespacePolicyId
        || a.providerId !== b.providerId
        || a.symbolLookupKey !== b.symbolLookupKey
        || a.venueId !== b.venueId
        || a.currency !== b.currency) {
        continue;
      }
      const effA = effectiveBindingInterval(
        a.validFrom, a.validToExclusive, revocationByBinding.get(entries[i].id) ?? null,
      );
      const effB = effectiveBindingInterval(
        b.validFrom, b.validToExclusive, revocationByBinding.get(entries[j].id) ?? null,
      );
      if (halfOpenIntervalsOverlap(effA.validFrom, effA.validToExclusive, effB.validFrom, effB.validToExclusive)) {
        return { a, b };
      }
    }
  }
  return null;
}

/**
 * @param {{id: string, binding: any}[]} entries
 * @param {Map<string, string>} revocationByBinding
 */
function findInternalProviderOverlaps(entries, revocationByBinding) {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].binding;
      const b = entries[j].binding;
      if (a.providerId !== b.providerId || a.providerInstrumentId !== b.providerInstrumentId) continue;
      const effA = effectiveBindingInterval(
        a.validFrom, a.validToExclusive, revocationByBinding.get(entries[i].id) ?? null,
      );
      const effB = effectiveBindingInterval(
        b.validFrom, b.validToExclusive, revocationByBinding.get(entries[j].id) ?? null,
      );
      if (halfOpenIntervalsOverlap(effA.validFrom, effA.validToExclusive, effB.validFrom, effB.validToExclusive)) {
        return { a, b };
      }
    }
  }
  return null;
}

/**
 * Walk supersedes chain and enforce append-only set inclusion.
 * @param {any} store
 * @param {ReturnType<typeof normalizeInstrumentIdentityManifestV1>} manifest
 * @param {string|null} currentManifestId
 * @param {Set<string>} visited
 */
function verifySupersedesChain(store, manifest, currentManifestId, visited) {
  if (manifest.supersedesManifestId === null) return;
  if (currentManifestId !== null && manifest.supersedesManifestId === currentManifestId) {
    throw new InstrumentIdentityError('INSTRUMENT_MANIFEST_CYCLE', 'manifest cannot supersede itself');
  }
  if (visited.has(manifest.supersedesManifestId)) {
    throw new InstrumentIdentityError('INSTRUMENT_MANIFEST_CYCLE', 'identity manifest supersedes chain has a cycle');
  }
  visited.add(manifest.supersedesManifestId);
  const previous = readSnapshotObject(
    store, manifest.supersedesManifestId, INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION, 'superseded manifest',
  );
  if (previous.instrumentIdentityId !== manifest.instrumentIdentityId) {
    throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
      'supersedesManifestId targets a different instrument identity');
  }
  for (const field of [
    'identityRecordIds', 'descriptorCoreIds', 'aliasBindingCoreIds', 'providerBindingCoreIds',
    'aliasRevocationCoreIds', 'providerRevocationCoreIds',
  ]) {
    if (!isSortedIdSubset(previous[field], manifest[field])) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        `append-only violation: ${field} from superseded manifest is not preserved`);
    }
  }
  resolveIdentityManifestReferences(store, previous, manifest.supersedesManifestId, visited);
}

/**
 * @param {any} store
 * @param {ReturnType<typeof normalizeInstrumentIdentityManifestV1>} manifest
 * @param {string|null} [manifestId]
 * @param {Set<string>} [visited]
 */
export function resolveIdentityManifestReferences(store, manifest, manifestId = null, visited = new Set()) {
  if (manifestId !== null) visited.add(manifestId);
  const { identityCore } = verifyInstrumentIdentity({
    store, instrumentIdentityId: manifest.instrumentIdentityId,
  });

  verifySupersedesChain(store, manifest, manifestId, visited);

  const identityRecords = manifest.identityRecordIds.map((id) => {
    const recovered = verifyInstrumentIdentityRecord({ store, identityRecordId: id });
    if (recovered.identityRecord.instrumentIdentityId !== manifest.instrumentIdentityId) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'identity record belongs to another instrument', { identityRecordId: id });
    }
    return recovered;
  });

  const descriptors = manifest.descriptorCoreIds.map((id) => {
    const recovered = verifyInstrumentDescriptor({ store, descriptorCoreId: id });
    if (recovered.descriptorCore.instrumentIdentityId !== manifest.instrumentIdentityId) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'descriptor belongs to another instrument', { descriptorCoreId: id });
    }
    return recovered;
  });

  const aliases = manifest.aliasBindingCoreIds.map((id) => {
    const recovered = verifyInstrumentAliasBinding({ store, aliasBindingCoreId: id });
    if (recovered.aliasBindingCore.instrumentIdentityId !== manifest.instrumentIdentityId) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'alias binding belongs to another instrument', { aliasBindingCoreId: id });
    }
    return recovered;
  });

  const providers = manifest.providerBindingCoreIds.map((id) => {
    const recovered = verifyProviderInstrumentBinding({ store, providerBindingCoreId: id });
    if (recovered.providerBindingCore.instrumentIdentityId !== manifest.instrumentIdentityId) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'provider binding belongs to another instrument', { providerBindingCoreId: id });
    }
    return recovered;
  });

  /** @type {Map<string, string>} */
  const aliasRevocationByBinding = new Map();
  const aliasRevocations = manifest.aliasRevocationCoreIds.map((id) => {
    const recovered = verifyInstrumentAliasRevocation({ store, aliasRevocationCoreId: id });
    if (recovered.aliasRevocationCore.instrumentIdentityId !== manifest.instrumentIdentityId) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'alias revocation belongs to another instrument', { aliasRevocationCoreId: id });
    }
    if (!manifest.aliasBindingCoreIds.includes(recovered.aliasRevocationCore.revokedAliasBindingCoreId)) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'alias revocation references a binding not listed in the manifest');
    }
    registerEarliestRevocation(
      aliasRevocationByBinding,
      recovered.aliasRevocationCore.revokedAliasBindingCoreId,
      recovered.aliasRevocationCore.effectiveFrom,
    );
    return recovered;
  });

  /** @type {Map<string, string>} */
  const providerRevocationByBinding = new Map();
  const providerRevocations = manifest.providerRevocationCoreIds.map((id) => {
    const recovered = verifyProviderInstrumentRevocation({ store, providerRevocationCoreId: id });
    if (recovered.providerRevocationCore.instrumentIdentityId !== manifest.instrumentIdentityId) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'provider revocation belongs to another instrument', { providerRevocationCoreId: id });
    }
    if (!manifest.providerBindingCoreIds.includes(recovered.providerRevocationCore.revokedProviderBindingCoreId)) {
      throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_MANIFEST_INVALID',
        'provider revocation references a binding not listed in the manifest');
    }
    registerEarliestRevocation(
      providerRevocationByBinding,
      recovered.providerRevocationCore.revokedProviderBindingCoreId,
      recovered.providerRevocationCore.effectiveFrom,
    );
    return recovered;
  });

  const aliasOverlap = findInternalAliasOverlaps(
    aliases.map((entry) => ({ id: entry.aliasBindingCoreId, binding: entry.aliasBindingCore })),
    aliasRevocationByBinding,
  );
  if (aliasOverlap) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_AMBIGUOUS',
      'active alias bindings overlap for the same lookup key within one identity');
  }
  const providerOverlap = findInternalProviderOverlaps(
    providers.map((entry) => ({ id: entry.providerBindingCoreId, binding: entry.providerBindingCore })),
    providerRevocationByBinding,
  );
  if (providerOverlap) {
    throw new InstrumentIdentityError('PROVIDER_INSTRUMENT_BINDING_AMBIGUOUS',
      'active provider instrument IDs overlap within one identity');
  }

  return {
    identityCore,
    identityRecords,
    descriptors,
    aliases,
    providers,
    aliasRevocations,
    providerRevocations,
    aliasRevocationByBinding,
    providerRevocationByBinding,
  };
}

/**
 * @param {{
 *   store: any,
 *   instrumentIdentityId: string,
 *   identityRecordIds?: string[],
 *   descriptorCoreIds?: string[],
 *   aliasBindingCoreIds?: string[],
 *   providerBindingCoreIds?: string[],
 *   aliasRevocationCoreIds?: string[],
 *   providerRevocationCoreIds?: string[],
 *   supersedesManifestId?: string|null,
 * }} input
 */
export function buildInstrumentIdentityManifest(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  const candidate = normalizeInstrumentIdentityManifestV1({
    schemaVersion: INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION,
    instrumentIdentityId: input.instrumentIdentityId,
    identityRecordIds: sortedUniqueStrings(input.identityRecordIds ?? []),
    descriptorCoreIds: sortedUniqueStrings(input.descriptorCoreIds ?? []),
    aliasBindingCoreIds: sortedUniqueStrings(input.aliasBindingCoreIds ?? []),
    providerBindingCoreIds: sortedUniqueStrings(input.providerBindingCoreIds ?? []),
    aliasRevocationCoreIds: sortedUniqueStrings(input.aliasRevocationCoreIds ?? []),
    providerRevocationCoreIds: sortedUniqueStrings(input.providerRevocationCoreIds ?? []),
    supersedesManifestId: input.supersedesManifestId ?? null,
  });
  const resolved = resolveIdentityManifestReferences(input.store, candidate, null, new Set());
  const stored = putCanonical(input.store, INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION, candidate);
  return {
    identityManifestId: stored.objectId,
    identityManifest: stored.value,
    identityManifestObject: stored,
    ...resolved,
  };
}

/** @param {{store: any, identityManifestId: string}} input */
export function verifyInstrumentIdentityManifest(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.identityManifestId, 'identityManifestId');
  const identityManifest = readSnapshotObject(
    input.store, input.identityManifestId, INSTRUMENT_IDENTITY_MANIFEST_SCHEMA_VERSION, 'identity manifest',
  );
  const resolved = resolveIdentityManifestReferences(
    input.store, identityManifest, input.identityManifestId, new Set(),
  );
  return {
    identityManifestId: input.identityManifestId,
    identityManifest,
    ...resolved,
  };
}
