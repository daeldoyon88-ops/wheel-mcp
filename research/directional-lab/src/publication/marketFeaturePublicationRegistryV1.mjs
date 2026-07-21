/** L4A-C3 append-only registry, tip verification and explicit as-of resolver. */

import {
  MarketDataL3Error, assertApiInput, assertCasId, assertStore,
  assertUtcInstant, canonicalValuesEqual, putCanonicalL3, readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  compareMarketFeaturePublicationRegistryEntries,
  marketFeaturePublicationLogicalKeysEqual,
  normalizeMarketFeaturePublicationLogicalKeyV1,
  normalizeMarketFeaturePublicationManifestV1,
  normalizeMarketFeaturePublicationRegistryManifestV1,
} from '../contracts/marketFeaturePublicationContractsV1.mjs';
import {
  marketFeaturePublicationLogicalKeyFor,
  verifyMarketFeaturePublicationAuthorityPolicy,
  verifyMarketFeaturePublicationManifest,
} from './marketFeaturePublicationV1.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

function sameEntry(left, right) {
  return canonicalValuesEqual(left, right);
}

function verifyEntryReferences(store, registry, entries) {
  const manifestsById = new Map();
  for (const entry of entries) {
    const { publicationManifest: manifest } = verifyMarketFeaturePublicationManifest({
      store, publicationManifestId: entry.publicationManifestId,
    });
    manifestsById.set(entry.publicationManifestId, manifest);
  }
  verifyMarketFeaturePublicationRegistryReferenceValuesV1(registry, entries, manifestsById);
  const graph = verifyMarketFeaturePublicationRegistryGraphV1(entries);
  return { byId: graph.byId, tips: graph.tips };
}

/** Compare registry entries with already fully verified publication manifests. */
export function verifyMarketFeaturePublicationRegistryReferenceValuesV1(
  registry, entries, manifestsById,
) {
  for (const entry of entries) {
    const candidate = manifestsById.get(entry.publicationManifestId);
    if (!candidate) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
        'registry publication manifest is absent');
    }
    let manifest;
    try { manifest = normalizeMarketFeaturePublicationManifestV1(candidate); } catch (cause) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
        'registry publication manifest has the wrong contract', { cause });
    }
    if (manifest.publicationAuthorityPolicyId !== registry.publicationAuthorityPolicyId
        || !marketFeaturePublicationLogicalKeysEqual(
          entry.logicalKey, marketFeaturePublicationLogicalKeyFor(manifest))
        || entry.knowledgeCutoff !== manifest.knowledgeCutoff
        || !canonicalValuesEqual(entry.sessionCoverage, manifest.sessionCoverage)) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
        'registry entry diverges from its verified publication manifest');
    }
  }
  return true;
}

/** Validate the normalized publication supersession graph independently of storage traversal. */
export function verifyMarketFeaturePublicationRegistryGraphV1(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (byId.has(entry.publicationManifestId)) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CONFLICT',
        'publication manifest appears more than once');
    }
    byId.set(entry.publicationManifestId, entry);
  }
  const childByParent = new Map();
  for (const entry of entries) {
    const parentId = entry.supersedesPublicationManifestId;
    if (parentId === null) continue;
    if (parentId === entry.publicationManifestId) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CYCLE',
        'publication cannot supersede itself');
    }
    const parent = byId.get(parentId);
    if (!parent) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
        'superseded publication is absent from the pinned registry');
    }
    if (!marketFeaturePublicationLogicalKeysEqual(entry.logicalKey, parent.logicalKey)) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
        'publication supersession crosses logical keys');
    }
    if (entry.knowledgeCutoff < parent.knowledgeCutoff) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
        'publication supersession moves knowledgeCutoff backwards');
    }
    if (childByParent.has(parentId)) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CONFLICT',
        'two publications branch from the same parent');
    }
    childByParent.set(parentId, entry.publicationManifestId);
  }

  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CYCLE',
        'publication supersession graph contains a cycle');
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    const parentId = byId.get(id).supersedesPublicationManifestId;
    if (parentId !== null) visit(parentId);
    state.set(id, 2);
  };
  for (const id of [...byId.keys()].sort()) visit(id);

  const keys = [];
  for (const entry of entries) {
    let group = keys.find((candidate) =>
      marketFeaturePublicationLogicalKeysEqual(candidate.logicalKey, entry.logicalKey));
    if (!group) {
      group = { logicalKey: entry.logicalKey, entries: [] };
      keys.push(group);
    }
    group.entries.push(entry);
  }
  const tips = [];
  for (const group of keys) {
    const parentIds = new Set(group.entries.map((entry) => entry.supersedesPublicationManifestId)
      .filter((id) => id !== null));
    const groupTips = group.entries.filter((entry) => !parentIds.has(entry.publicationManifestId));
    if (groupTips.length !== 1) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CONFLICT',
        'logical key must have exactly one publication tip');
    }
    tips.push({ logicalKey: group.logicalKey,
      publicationManifestId: groupTips[0].publicationManifestId });
  }
  return { byId, tips };
}

/** Validate a fully read registry chain: genesis plus exact one-entry append steps. */
export function verifyMarketFeaturePublicationRegistryChainV1(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_APPEND_ONLY_VIOLATION',
      'registry chain must contain a genesis');
  }
  if (chain[0].registry.entries.length !== 0) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_APPEND_ONLY_VIOLATION',
      'genesis registry must be empty');
  }
  for (let index = 1; index < chain.length; index += 1) {
    const parent = chain[index - 1];
    const current = chain[index];
    const child = current.registry;
    if (child.supersedesRegistryManifestId !== parent.registryManifestId) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_APPEND_ONLY_VIOLATION',
        'registry child does not reference its immediate parent');
    }
    if (child.publicationAuthorityPolicyId !== parent.registry.publicationAuthorityPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
        'registry authority policy changes across append-only history');
    }
    if (child.entries.length !== parent.registry.entries.length + 1) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_APPEND_ONLY_VIOLATION',
        'registry child must append exactly one publication');
    }
    const childById = new Map(child.entries.map((entry) => [entry.publicationManifestId, entry]));
    for (const parentEntry of parent.registry.entries) {
      const preserved = childById.get(parentEntry.publicationManifestId);
      if (!preserved || !sameEntry(preserved, parentEntry)) {
        throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_APPEND_ONLY_VIOLATION',
          'registry child removed or modified historical publication evidence');
      }
    }
  }
  return chain;
}

function readAndVerifyRegistryChain(store, registryManifestId) {
  const seen = new Set();
  const descending = [];
  let cursorId = registryManifestId;
  while (cursorId !== null) {
    if (seen.has(cursorId)) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CYCLE',
        'registry supersession chain contains a cycle');
    }
    seen.add(cursorId);
    const registry = normalizeMarketFeaturePublicationRegistryManifestV1(readTypedReference(
      store, cursorId, MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
      'market feature publication registry'));
    verifyMarketFeaturePublicationAuthorityPolicy({
      store, publicationAuthorityPolicyId: registry.publicationAuthorityPolicyId,
    });
    if (registry.supersedesRegistryManifestId === cursorId) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CYCLE',
        'registry cannot supersede itself');
    }
    descending.push({ registryManifestId: cursorId, registry });
    cursorId = registry.supersedesRegistryManifestId;
  }
  const chain = descending.reverse();
  return verifyMarketFeaturePublicationRegistryChainV1(chain);
}

export function verifyMarketFeaturePublicationRegistryManifest(input) {
  const api = assertApiInput(input, ['registryManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.registryManifestId, 'registryManifestId');
  const chain = readAndVerifyRegistryChain(api.store, api.registryManifestId);
  const current = chain.at(-1);
  const graph = verifyEntryReferences(api.store, current.registry, current.registry.entries);
  return { registryManifestId: current.registryManifestId, registry: current.registry,
    tips: graph.tips, entriesById: graph.byId, registryChain: chain };
}

export function buildMarketFeaturePublicationRegistryGenesis(input) {
  const api = assertApiInput(input, ['publicationAuthorityPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.publicationAuthorityPolicyId, 'publicationAuthorityPolicyId');
  verifyMarketFeaturePublicationAuthorityPolicy({
    store: api.store, publicationAuthorityPolicyId: api.publicationAuthorityPolicyId,
  });
  const registry = normalizeMarketFeaturePublicationRegistryManifestV1({
    schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: api.publicationAuthorityPolicyId,
    supersedesRegistryManifestId: null,
    entries: [],
  });
  const stored = putCanonicalL3(api.store,
    MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION, registry);
  verifyMarketFeaturePublicationRegistryManifest({ store: api.store, registryManifestId: stored.objectId });
  return { registryManifestId: stored.objectId, registryManifest: registry };
}

export function publishMarketFeaturePublicationRegistryManifest(input) {
  const api = assertApiInput(input, [
    'baseRegistryManifestId', 'publicationManifestId', 'expectedParentPublicationManifestId',
  ]);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.baseRegistryManifestId, 'baseRegistryManifestId');
  assertCasId(api.publicationManifestId, 'publicationManifestId');
  assertCasId(api.expectedParentPublicationManifestId,
    'expectedParentPublicationManifestId', true);
  const base = verifyMarketFeaturePublicationRegistryManifest({
    store: api.store, registryManifestId: api.baseRegistryManifestId,
  });
  const { publicationManifest: manifest } = verifyMarketFeaturePublicationManifest({
    store: api.store, publicationManifestId: api.publicationManifestId,
  });
  if (manifest.publicationAuthorityPolicyId !== base.registry.publicationAuthorityPolicyId) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_REFERENCE_MISMATCH',
      'publication and registry authority policies differ');
  }
  const logicalKey = marketFeaturePublicationLogicalKeyFor(manifest);
  const existing = base.registry.entries.find((entry) =>
    entry.publicationManifestId === api.publicationManifestId);
  if (existing) {
    if (existing.supersedesPublicationManifestId !== api.expectedParentPublicationManifestId) {
      throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CONFLICT',
        'idempotent publication replay supplied another parent');
    }
    return { registryManifestId: api.baseRegistryManifestId,
      registryManifest: base.registry, noop: true };
  }
  const matchingTip = base.tips.find((tip) =>
    marketFeaturePublicationLogicalKeysEqual(tip.logicalKey, logicalKey));
  const tipId = matchingTip?.publicationManifestId ?? null;
  if (tipId !== api.expectedParentPublicationManifestId) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_REGISTRY_CONFLICT',
      'expected parent is not the unique tip under the pinned registry');
  }
  const entry = {
    publicationManifestId: api.publicationManifestId,
    logicalKey,
    knowledgeCutoff: manifest.knowledgeCutoff,
    sessionCoverage: manifest.sessionCoverage,
    supersedesPublicationManifestId: api.expectedParentPublicationManifestId,
  };
  const registry = normalizeMarketFeaturePublicationRegistryManifestV1({
    schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: base.registry.publicationAuthorityPolicyId,
    supersedesRegistryManifestId: api.baseRegistryManifestId,
    entries: [...base.registry.entries, entry].sort(compareMarketFeaturePublicationRegistryEntries),
  });
  const stored = putCanonicalL3(api.store,
    MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION, registry);
  verifyMarketFeaturePublicationRegistryManifest({ store: api.store, registryManifestId: stored.objectId });
  return { registryManifestId: stored.objectId, registryManifest: registry, noop: false };
}

/** Resolve only against the explicitly pinned registry and explicit knowledge cutoff. */
export function resolveMarketFeaturePublicationAsOf(input) {
  const api = assertApiInput(input, ['registryManifestId', 'logicalKey', 'asOfKnowledgeCutoff']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.registryManifestId, 'registryManifestId');
  assertUtcInstant(api.asOfKnowledgeCutoff, 'asOfKnowledgeCutoff');
  const logicalKey = normalizeMarketFeaturePublicationLogicalKeyV1(api.logicalKey);
  const verified = verifyMarketFeaturePublicationRegistryManifest({
    store: api.store, registryManifestId: api.registryManifestId,
  });
  const tip = resolveMarketFeaturePublicationEntryAsOfV1(
    verified.registry.entries, logicalKey, api.asOfKnowledgeCutoff);
  return { registryManifestId: api.registryManifestId,
    asOfKnowledgeCutoff: api.asOfKnowledgeCutoff,
    logicalKey,
    publicationManifestId: tip.publicationManifestId,
    publicationManifest: verifyMarketFeaturePublicationManifest({
      store: api.store, publicationManifestId: tip.publicationManifestId,
    }).publicationManifest };
}

/** Resolve the unique causal tip from an already verified, explicitly pinned registry. */
export function resolveMarketFeaturePublicationEntryAsOfV1(entries, logicalKey, asOfKnowledgeCutoff) {
  assertUtcInstant(asOfKnowledgeCutoff, 'asOfKnowledgeCutoff');
  const normalizedLogicalKey = normalizeMarketFeaturePublicationLogicalKeyV1(logicalKey);
  const eligible = entries.filter((entry) =>
    marketFeaturePublicationLogicalKeysEqual(entry.logicalKey, normalizedLogicalKey)
    && entry.knowledgeCutoff <= asOfKnowledgeCutoff);
  if (eligible.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_AS_OF_NOT_FOUND',
      'no publication is visible under the pinned registry at the explicit cutoff');
  }
  const eligibleIds = new Set(eligible.map((entry) => entry.publicationManifestId));
  const parentIds = new Set(eligible.map((entry) => entry.supersedesPublicationManifestId)
    .filter((id) => id !== null && eligibleIds.has(id)));
  const tips = eligible.filter((entry) => !parentIds.has(entry.publicationManifestId));
  if (tips.length !== 1) {
    throw new MarketDataL3Error('MARKET_DATA_FEATURE_PUBLICATION_AS_OF_AMBIGUOUS',
      'eligible publication history has no unique causal tip');
  }
  return tips[0];
}
