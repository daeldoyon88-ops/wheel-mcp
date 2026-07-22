/**
 * L4B-I1 permanent macro series identities and the append-only series
 * registry: genesis, appends with explicit deprecation/replacement, full
 * chain verification, reference verification and deterministic conflicts.
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
  MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_POLICY_VERSION,
  compareMacroSeriesRegistryEntries,
  normalizeMacroSeriesIdentityCoreV1,
  normalizeMacroSeriesRegistryManifestV1,
  verifyMacroSeriesRegistryChainV1,
} from '../contracts/macroIngestionContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';

export function buildMacroSeriesIdentityCore(input) {
  const api = assertApiInput(input, ['identity']);
  assertStore(api.store, MACRO_STORE_METHODS);
  const identity = normalizeMacroSeriesIdentityCoreV1(api.identity);
  const stored = putCanonicalL3(api.store, MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION, identity);
  return { macroSeriesIdentityId: stored.objectId, macroSeriesIdentity: stored.value };
}

export function verifyMacroSeriesIdentityCore(input) {
  const api = assertApiInput(input, ['macroSeriesIdentityId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroSeriesIdentityId, 'macroSeriesIdentityId');
  assertCasId(api.macroSeriesIdentityId, 'macroSeriesIdentityId');
  const raw = readTypedReference(api.store, api.macroSeriesIdentityId,
    MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION, 'macro series identity');
  const identity = normalizeMacroSeriesIdentityCoreV1(raw);
  if (!canonicalValuesEqual(identity, raw)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_IDENTITY_INVALID',
      'stored macro series identity is not canonical');
  }
  return { macroSeriesIdentityId: api.macroSeriesIdentityId, macroSeriesIdentity: identity };
}

function verifyEntryReferences(store, registry) {
  const identitiesById = new Map();
  for (const entry of registry.orderedSeriesEntries) {
    const { macroSeriesIdentity } = verifyMacroSeriesIdentityCore({
      store, macroSeriesIdentityId: entry.macroSeriesIdentityId,
    });
    if (macroSeriesIdentity.canonicalSeriesCode !== entry.canonicalSeriesCode) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REFERENCE_MISMATCH',
        'registry entry canonicalSeriesCode diverges from the pinned identity');
    }
    identitiesById.set(entry.macroSeriesIdentityId, macroSeriesIdentity);
  }
  return identitiesById;
}

function readAndVerifyRegistryChain(store, registryManifestId) {
  const seen = new Set();
  const descending = [];
  let cursorId = registryManifestId;
  while (cursorId !== null) {
    if (seen.has(cursorId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE',
        'registry supersession chain contains a cycle');
    }
    seen.add(cursorId);
    const registry = normalizeMacroSeriesRegistryManifestV1(readTypedReference(
      store, cursorId, MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION, 'macro series registry'));
    if (registry.supersedesRegistryManifestId === cursorId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE',
        'registry cannot supersede itself');
    }
    descending.push({ registryManifestId: cursorId, registry });
    cursorId = registry.supersedesRegistryManifestId;
  }
  return verifyMacroSeriesRegistryChainV1(descending.reverse());
}

/**
 * Authoritative registry verifier: re-reads and re-normalizes the whole
 * supersession chain, replays the append-only rules, and re-verifies every
 * referenced series identity object against its pinned bytes.
 */
export function verifyMacroSeriesRegistryManifest(input) {
  const api = assertApiInput(input, ['macroSeriesRegistryManifestId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroSeriesRegistryManifestId, 'macroSeriesRegistryManifestId');
  assertCasId(api.macroSeriesRegistryManifestId, 'macroSeriesRegistryManifestId');
  const chain = readAndVerifyRegistryChain(api.store, api.macroSeriesRegistryManifestId);
  const current = chain.at(-1);
  const identitiesById = verifyEntryReferences(api.store, current.registry);
  return {
    macroSeriesRegistryManifestId: current.registryManifestId,
    registry: current.registry,
    registryChain: chain,
    seriesIdentitiesById: identitiesById,
  };
}

/** @param {{store: any, entries?: unknown[]}} input */
export function buildMacroSeriesRegistryGenesis(input) {
  const api = assertApiInput(input, ['entries']);
  assertStore(api.store, MACRO_STORE_METHODS);
  if (!Array.isArray(api.entries)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID',
      'entries must be an array');
  }
  const registry = normalizeMacroSeriesRegistryManifestV1({
    schemaVersion: MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registryPolicyVersion: MACRO_SERIES_REGISTRY_POLICY_VERSION,
    supersedesRegistryManifestId: null,
    orderedSeriesEntries: [...api.entries].sort(compareMacroSeriesRegistryEntries),
  });
  const stored = putCanonicalL3(api.store, MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION, registry);
  verifyMacroSeriesRegistryManifest({
    store: api.store, macroSeriesRegistryManifestId: stored.objectId,
  });
  return { macroSeriesRegistryManifestId: stored.objectId, registry: stored.value };
}

/**
 * Append-only registry step: preserve every historical entry (allowing only
 * the closed monotone status transitions supplied through statusTransitions)
 * and add the newEntries. The result is re-verified from genesis.
 * @param {{store: any, baseRegistryManifestId: string, newEntries?: unknown[],
 *   statusTransitions?: Array<{macroSeriesIdentityId: string, status: string}>}} input
 */
export function appendMacroSeriesRegistryManifest(input) {
  const api = assertApiInput(input, ['baseRegistryManifestId', 'newEntries', 'statusTransitions']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertCasId(api.baseRegistryManifestId, 'baseRegistryManifestId');
  if (!Array.isArray(api.newEntries) || !Array.isArray(api.statusTransitions)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID',
      'newEntries and statusTransitions must be arrays');
  }
  const base = verifyMacroSeriesRegistryManifest({
    store: api.store, macroSeriesRegistryManifestId: api.baseRegistryManifestId,
  });
  const transitionsById = new Map();
  for (const transition of api.statusTransitions) {
    if (transition === null || typeof transition !== 'object'
        || typeof transition.macroSeriesIdentityId !== 'string'
        || transitionsById.has(transition.macroSeriesIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID',
        'statusTransitions must target unique series identities');
    }
    transitionsById.set(transition.macroSeriesIdentityId, transition.status);
  }
  const preserved = base.registry.orderedSeriesEntries.map((entry) => (
    transitionsById.has(entry.macroSeriesIdentityId)
      ? { ...entry, status: transitionsById.get(entry.macroSeriesIdentityId) }
      : entry));
  for (const identityId of transitionsById.keys()) {
    if (!base.registry.orderedSeriesEntries
      .some((entry) => entry.macroSeriesIdentityId === identityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_REFERENCE_MISMATCH',
        'status transition targets a series absent from the base registry');
    }
  }
  const registry = normalizeMacroSeriesRegistryManifestV1({
    schemaVersion: MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registryPolicyVersion: MACRO_SERIES_REGISTRY_POLICY_VERSION,
    supersedesRegistryManifestId: api.baseRegistryManifestId,
    orderedSeriesEntries: [...preserved, ...api.newEntries]
      .sort(compareMacroSeriesRegistryEntries),
  });
  const stored = putCanonicalL3(api.store, MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION, registry);
  verifyMacroSeriesRegistryManifest({
    store: api.store, macroSeriesRegistryManifestId: stored.objectId,
  });
  return { macroSeriesRegistryManifestId: stored.objectId, registry: stored.value };
}
