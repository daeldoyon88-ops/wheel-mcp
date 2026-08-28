import { randomBytes, createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContentAddressedStore } from '../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import {
  buildInstrumentAliasBinding,
  buildInstrumentIdentity,
  buildInstrumentIdentityAuthorityPolicy,
  buildInstrumentIdentityManifest,
  buildInstrumentIdentityRecord,
  buildInstrumentIdentityRegistry,
  buildSymbolNamespacePolicy,
  resolveInstrumentIdentityAsOf,
  verifyInstrumentIdentityRegistry,
} from '../research/directional-lab/src/data/buildInstrumentIdentity.mjs';
import {
  INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
  SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION,
  validateInstrumentIdentityAuthorityPolicy,
  validateSymbolNamespacePolicy,
} from '../research/directional-lab/src/contracts/instrumentIdentityV1.mjs';
import { sortedUniqueStrings } from '../research/directional-lab/src/contracts/contractPrimitivesV1.mjs';

export const MP3_MISSION_ID = 'WHEEL_JARVISE_MP3_INSTRUMENT_IDENTITY_PRIMITIVE_R1';
export const CANONICAL_CONTRACT_SHA256 = '9535f6a5d8347f99c7a0222479d27b5a9fd6c1d9f5bb4de7a699a80b23e8ee2e';
export const AUTHORITY_ID = 'wheel-jarvise-local/1';
export const NAMESPACE_ID = 'wheel-jarvise-yahoo-symbol';
export const NAMESPACE_VERSION = 1;
export const PROVIDER_ID = 'yahoo-finance2';
export const PRODUCTION_RELATIVE_ROOT = 'data/jarvise/instrument-identity';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const IDENTITY_STORE_SCHEMA = 'JarviseMp3IdentityStoreProjection/1';
const PROVENANCE_SCHEMA = 'JarviseMp3InstrumentIdentityProvenance/1';
const KIND_BY_QUOTE_TYPE = Object.freeze({
  EQUITY: 'EQUITY',
  ETF: 'ETF',
  ETN: 'ETN',
  INDEX: 'INDEX',
  MUTUALFUND: 'FUND',
  FUTURE: 'FUTURE',
});

export class Mp3MaterializationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'Mp3MaterializationError';
    this.code = code;
    this.details = details;
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertPathInside(root, candidate) {
  const rootAbs = resolve(root);
  const candidateAbs = resolve(candidate);
  const rel = relative(rootAbs, candidateAbs);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Mp3MaterializationError('MP3_OUTPUT_SCOPE_EXPANSION_REQUIRED', 'output path escapes MP-3 root', {
      root: rootAbs,
      candidate: candidateAbs,
    });
  }
  return candidateAbs;
}

function atomicWriteJson(root, path, value) {
  const safePath = assertPathInside(root, path);
  mkdirSync(dirname(safePath), { recursive: true });
  const temporary = `${safePath}.tmp-${process.pid}`;
  assertPathInside(root, temporary);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
  renameSync(temporary, safePath);
}

export function assertCanonicalPin({ repoRoot = DEFAULT_REPO_ROOT, expectedSha = CANONICAL_CONTRACT_SHA256 } = {}) {
  const contractPath = join(repoRoot, 'research', 'directional-lab', 'src', 'contracts', 'instrumentIdentityV1.mjs');
  const actualSha = sha256File(contractPath);
  if (actualSha !== expectedSha) {
    throw new Mp3MaterializationError('MP3_CANONICAL_PIN_DRIFT', 'canonical InstrumentIdentity contract SHA differs', {
      expectedSha,
      actualSha,
    });
  }
  return actualSha;
}

export function buildAuthorityPolicyInput() {
  return {
    schemaVersion: INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
    authorityId: AUTHORITY_ID,
    identitySeedFormat: 'HEX_LOWERCASE',
    identitySeedLength: 64,
  };
}

export function buildNamespacePolicyInput() {
  return {
    schemaVersion: SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION,
    namespaceId: NAMESPACE_ID,
    namespaceVersion: NAMESPACE_VERSION,
    providerId: PROVIDER_ID,
    venuePolicy: 'NOT_APPLICABLE',
    casePolicy: 'ASCII_UPPERCASE',
    allowedCharacterPolicy: 'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
    currencyPolicy: 'REQUIRED',
  };
}

export function derivePositiveKindEvidence(symbol, fundamentalsItem) {
  const quoteType = typeof fundamentalsItem?.quoteType === 'string'
    ? fundamentalsItem.quoteType.trim().toUpperCase()
    : null;
  const instrumentKind = quoteType === null ? null : (KIND_BY_QUOTE_TYPE[quoteType] ?? null);
  const currency = typeof fundamentalsItem?.currency === 'string'
    ? fundamentalsItem.currency.trim().toUpperCase()
    : null;
  const evidenceAsOf = typeof fundamentalsItem?.asOf === 'string' ? fundamentalsItem.asOf : null;
  if (instrumentKind === null || !/^[A-Z]{3}$/.test(currency ?? '') || !Number.isFinite(Date.parse(evidenceAsOf ?? ''))) {
    return {
      symbol,
      resolved: false,
      exclusionReason: 'INSTRUMENT_KIND_UNRESOLVED',
      quoteType,
      currency,
      evidenceAsOf,
    };
  }
  return {
    symbol,
    resolved: true,
    quoteType,
    instrumentKind,
    currency,
    evidenceAsOf,
    validFrom: new Date(evidenceAsOf).toISOString().slice(0, 10),
  };
}

function symbolDerivedCandidates(symbol, instrumentKind) {
  const values = [
    symbol,
    symbol.toLowerCase(),
    symbol.toUpperCase(),
    `${symbol}${instrumentKind}`,
    `${symbol}:${instrumentKind}`,
    `${symbol}|${instrumentKind}`,
    `${symbol.toLowerCase()}:${instrumentKind.toLowerCase()}`,
  ];
  return new Set(values.map((value) => sha256Bytes(value)));
}

export function assertSeedCandidate(seed, symbol, instrumentKind) {
  if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/.test(seed)) {
    throw new Mp3MaterializationError('MP3_SEED_FORMAT_INVALID', 'identitySeed must be 64 lowercase hex characters');
  }
  if (symbolDerivedCandidates(symbol, instrumentKind).has(seed)) {
    throw new Mp3MaterializationError(
      'MP3_SYMBOL_DERIVED_SEED_DETECTED',
      'identitySeed matches a forbidden symbol-derived digest',
      { symbol, instrumentKind },
    );
  }
  return seed;
}

export function mintSeedOnce(symbol, instrumentKind) {
  return assertSeedCandidate(randomBytes(32).toString('hex'), symbol, instrumentKind);
}

export function assertExistingIdentityCompatible(existing, evidence, proposedSeed = existing?.identitySeed) {
  if (!existing || existing.symbol !== evidence.symbol
      || existing.instrumentKind !== evidence.instrumentKind
      || existing.quoteType !== evidence.quoteType
      || existing.currency !== evidence.currency
      || proposedSeed !== existing.identitySeed) {
    throw new Mp3MaterializationError(
      'MP3_EXISTING_IDENTITY_CONFLICT',
      'persisted identity conflicts with current kind/source evidence or a seed replacement was attempted',
      { symbol: evidence.symbol },
    );
  }
  assertSeedCandidate(existing.identitySeed, existing.symbol, existing.instrumentKind);
  return existing;
}

export function assertProducerRandomnessBoundary(sourceText = readFileSync(SCRIPT_PATH, 'utf8')) {
  const forbiddenToken = ['Math', 'random'].join('.');
  if (sourceText.includes(forbiddenToken) || !sourceText.includes('randomBytes(32)')) {
    throw new Mp3MaterializationError('MP3_SEED_FORMAT_INVALID', 'producer randomness boundary is invalid');
  }
  return { primitive: 'node:crypto.randomBytes(32)', forbiddenUsageCount: 0 };
}

function createEmptyProjection() {
  return {
    schemaVersion: IDENTITY_STORE_SCHEMA,
    authoritative: false,
    authoritativeSource: 'canonical CAS objects and registryManifestId',
    missionId: MP3_MISSION_ID,
    authorityPolicyId: null,
    namespacePolicyId: null,
    identities: [],
  };
}

function loadProjection(path) {
  if (!existsSync(path)) return createEmptyProjection();
  const projection = readJson(path);
  if (projection?.schemaVersion !== IDENTITY_STORE_SCHEMA
      || projection.authoritative !== false
      || !Array.isArray(projection.identities)) {
    throw new Mp3MaterializationError('MP3_EXISTING_IDENTITY_CONFLICT', 'existing identity-store projection is invalid');
  }
  return projection;
}

function assertProductionOutputRoot(repoRoot, outputRoot, testOnlyAllowOutputRoot) {
  const expected = resolve(repoRoot, ...PRODUCTION_RELATIVE_ROOT.split('/'));
  const actual = resolve(outputRoot);
  if (!testOnlyAllowOutputRoot && actual !== expected) {
    throw new Mp3MaterializationError('MP3_OUTPUT_SCOPE_EXPANSION_REQUIRED', 'production output root differs from MP-3 root', {
      expected,
      actual,
    });
  }
  return actual;
}

function ensureWritableRoot(outputRoot) {
  let ancestor = outputRoot;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  accessSync(ancestor, constants.W_OK);
  mkdirSync(outputRoot, { recursive: true });
  accessSync(outputRoot, constants.W_OK);
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function materializeMp3(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const outputRoot = assertProductionOutputRoot(
    repoRoot,
    options.outputRoot ?? join(repoRoot, ...PRODUCTION_RELATIVE_ROOT.split('/')),
    options.testOnlyAllowOutputRoot === true,
  );
  const canonicalPinSha256 = assertCanonicalPin({
    repoRoot,
    expectedSha: options.expectedCanonicalSha ?? CANONICAL_CONTRACT_SHA256,
  });
  const randomness = assertProducerRandomnessBoundary();

  const authorityInput = buildAuthorityPolicyInput();
  const namespaceInput = buildNamespacePolicyInput();
  if (!validateInstrumentIdentityAuthorityPolicy(authorityInput).valid) {
    throw new Mp3MaterializationError('MP3_AUTHORITY_POLICY_INVALID', 'authority policy input is invalid');
  }
  if (!validateSymbolNamespacePolicy(namespaceInput).valid) {
    throw new Mp3MaterializationError('MP3_NAMESPACE_POLICY_INVALID', 'namespace policy input is invalid');
  }

  const fundamentalsPath = join(repoRoot, 'data', 'universe', 'fundamentals.cache.json');
  const universePath = join(repoRoot, 'data', 'universe', 'universe.master.json');
  const fundamentals = options.fundamentalsOverride ?? readJson(fundamentalsPath);
  const universe = readJson(universePath);
  const targetPool = options.targetPoolOverride ?? universe
    .filter((entry) => entry.enabled === true && entry.excluded === false)
    .map((entry) => entry.symbol);
  if (!Array.isArray(targetPool) || targetPool.length === 0) {
    throw new Mp3MaterializationError('MP3_NO_EVIDENCED_INSTRUMENTS', 'target pool is empty');
  }
  const evidenceRows = targetPool.map((symbol) => derivePositiveKindEvidence(symbol, fundamentals.items?.[symbol]));
  const evidenced = evidenceRows.filter((row) => row.resolved);
  const unresolved = evidenceRows.filter((row) => !row.resolved);
  if (evidenced.length === 0) {
    throw new Mp3MaterializationError('MP3_NO_EVIDENCED_INSTRUMENTS', 'no target symbol has positive kind evidence');
  }

  ensureWritableRoot(outputRoot);
  const casRoot = assertPathInside(outputRoot, join(outputRoot, 'cas'));
  mkdirSync(casRoot, { recursive: true });
  const store = createContentAddressedStore({ root: casRoot });
  const authority = buildInstrumentIdentityAuthorityPolicy({
    store,
    authorityId: AUTHORITY_ID,
    identitySeedFormat: 'HEX_LOWERCASE',
    identitySeedLength: 64,
  });
  const namespace = buildSymbolNamespacePolicy({
    store,
    namespaceId: NAMESPACE_ID,
    namespaceVersion: NAMESPACE_VERSION,
    providerId: PROVIDER_ID,
    venuePolicy: 'NOT_APPLICABLE',
    casePolicy: 'ASCII_UPPERCASE',
    allowedCharacterPolicy: 'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
    currencyPolicy: 'REQUIRED',
  });

  const projectionPath = assertPathInside(outputRoot, join(outputRoot, 'identity-store.json'));
  const projection = loadProjection(projectionPath);
  if ((projection.authorityPolicyId !== null && projection.authorityPolicyId !== authority.authorityPolicyId)
      || (projection.namespacePolicyId !== null && projection.namespacePolicyId !== namespace.namespacePolicyId)) {
    throw new Mp3MaterializationError('MP3_EXISTING_IDENTITY_CONFLICT', 'persisted policy IDs conflict with current policies');
  }
  const previousRegistryManifestId = projection.registryManifestId ?? null;
  projection.authorityPolicyId = authority.authorityPolicyId;
  projection.namespacePolicyId = namespace.namespacePolicyId;

  const bySymbol = new Map();
  for (const entry of projection.identities) {
    if (bySymbol.has(entry.symbol)) {
      throw new Mp3MaterializationError('MP3_EXISTING_IDENTITY_CONFLICT', 'duplicate persisted symbol identity');
    }
    bySymbol.set(entry.symbol, entry);
  }

  let mintedIdentityCount = 0;
  let reusedExistingIdentityCount = 0;
  for (const row of evidenced) {
    const existing = bySymbol.get(row.symbol);
    if (existing) {
      assertExistingIdentityCompatible(existing, row);
      reusedExistingIdentityCount += 1;
      continue;
    }
    const registeredAt = options.now?.() ?? new Date().toISOString();
    const entry = {
      symbol: row.symbol,
      quoteType: row.quoteType,
      instrumentKind: row.instrumentKind,
      currency: row.currency,
      evidenceAsOf: row.evidenceAsOf,
      validFrom: row.validFrom,
      identitySeed: mintSeedOnce(row.symbol, row.instrumentKind),
      registeredAt,
      instrumentIdentityId: null,
      identityRecordId: null,
      aliasBindingCoreId: null,
      identityManifestId: null,
    };
    projection.identities.push(entry);
    projection.identities.sort((a, b) => a.symbol.localeCompare(b.symbol));
    bySymbol.set(row.symbol, entry);
    atomicWriteJson(outputRoot, projectionPath, projection);
    mintedIdentityCount += 1;
  }

  const identityManifestIds = [];
  let identitiesChanged = 0;
  for (const row of evidenced) {
    const entry = bySymbol.get(row.symbol);
    const identity = buildInstrumentIdentity({
      store,
      authorityPolicyId: authority.authorityPolicyId,
      identitySeed: entry.identitySeed,
      instrumentKind: entry.instrumentKind,
    });
    const identityRecord = buildInstrumentIdentityRecord({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      registeredAt: entry.registeredAt,
      registrationAuthority: AUTHORITY_ID,
      executionIdentity: {
        runnerId: 'wheel-jarvise-mp3-materializer-r1',
        runId: MP3_MISSION_ID,
        environment: 'LOCAL_MANUAL',
      },
    });
    const alias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: namespace.namespacePolicyId,
      venueId: null,
      symbol: entry.symbol,
      currency: entry.currency,
      validFrom: entry.validFrom,
      validToExclusive: null,
      bindingStatus: 'CONFIRMED',
    });
    const manifest = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      identityRecordIds: [identityRecord.identityRecordId],
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
    });
    const nextIds = {
      instrumentIdentityId: identity.instrumentIdentityId,
      identityRecordId: identityRecord.identityRecordId,
      aliasBindingCoreId: alias.aliasBindingCoreId,
      identityManifestId: manifest.identityManifestId,
    };
    for (const [field, value] of Object.entries(nextIds)) {
      if (entry[field] !== null && entry[field] !== value) {
        throw new Mp3MaterializationError('MP3_EXISTING_IDENTITY_CONFLICT', `${field} changed for persisted identity`, {
          symbol: entry.symbol,
          previous: entry[field],
          next: value,
        });
      }
      if (entry[field] !== null && entry[field] === value) continue;
      entry[field] = value;
    }
    if (nextIds.instrumentIdentityId !== identity.instrumentIdentityId) identitiesChanged += 1;
    identityManifestIds.push(manifest.identityManifestId);
    atomicWriteJson(outputRoot, projectionPath, projection);
  }

  const intendedIdentityManifestIds = sortedUniqueStrings(identityManifestIds);
  const intendedSnapshotInstrumentBindingIds = [];
  const sameStringArrays = (actual, intended) => actual.length === intended.length
    && actual.every((value, index) => value === intended[index]);
  let registry;
  let verified;
  if (previousRegistryManifestId !== null) {
    const current = verifyInstrumentIdentityRegistry({
      store,
      registryManifestId: previousRegistryManifestId,
    });
    const sameSemanticRegistry = current.registryManifest.authorityPolicyId === authority.authorityPolicyId
      && sameStringArrays(current.registryManifest.identityManifestIds, intendedIdentityManifestIds)
      && sameStringArrays(current.registryManifest.snapshotInstrumentBindingIds, intendedSnapshotInstrumentBindingIds);
    if (sameSemanticRegistry) {
      registry = {
        registryManifestId: previousRegistryManifestId,
        registryManifest: current.registryManifest,
      };
      verified = current;
    }
  }
  if (!registry) {
    registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: authority.authorityPolicyId,
      identityManifestIds: intendedIdentityManifestIds,
      snapshotInstrumentBindingIds: intendedSnapshotInstrumentBindingIds,
      supersedesRegistryManifestId: previousRegistryManifestId,
    });
    verified = verifyInstrumentIdentityRegistry({
      store,
      registryManifestId: registry.registryManifestId,
    });
  }
  if (verified.identityBundles.length !== evidenced.length) {
    throw new Mp3MaterializationError('MP3_REGISTRY_VERIFICATION_FAILED', 'verified registry perimeter count differs');
  }

  const resolutions = [];
  for (const row of evidenced) {
    const entry = bySymbol.get(row.symbol);
    let resolvedIdentity;
    try {
      resolvedIdentity = resolveInstrumentIdentityAsOf({
        store,
        registryManifestId: registry.registryManifestId,
        namespacePolicyId: namespace.namespacePolicyId,
        providerId: PROVIDER_ID,
        venueId: null,
        symbol: row.symbol.toLowerCase(),
        currency: row.currency,
        asOfDate: entry.validFrom,
      });
    } catch (error) {
      const code = error?.code === 'INSTRUMENT_ALIAS_AMBIGUOUS'
        ? 'MP3_ALIAS_RESOLUTION_AMBIGUOUS'
        : 'MP3_REGISTRY_VERIFICATION_FAILED';
      throw new Mp3MaterializationError(code, 'as-of resolution failed', { symbol: row.symbol, cause: error?.code });
    }
    if (resolvedIdentity.instrumentIdentityId !== entry.instrumentIdentityId) {
      throw new Mp3MaterializationError('MP3_REGISTRY_VERIFICATION_FAILED', 'resolved identity differs from emitted identity', {
        symbol: row.symbol,
      });
    }
    resolutions.push(resolvedIdentity);
  }

  projection.registryManifestId = registry.registryManifestId;
  atomicWriteJson(outputRoot, projectionPath, projection);
  atomicWriteJson(outputRoot, join(outputRoot, 'authority-policy.json'), authority.authorityPolicy);
  atomicWriteJson(outputRoot, join(outputRoot, 'symbol-namespace-policy.json'), namespace.namespacePolicy);
  atomicWriteJson(outputRoot, join(outputRoot, 'registry-manifest.json'), registry.registryManifest);

  const sourceHashes = options.sourceHashesOverride ?? {
    'data/universe/fundamentals.cache.json': sha256File(fundamentalsPath),
    'data/universe/universe.master.json': sha256File(universePath),
  };
  const materializerSha256 = sha256File(SCRIPT_PATH);
  const provenance = {
    schemaVersion: PROVENANCE_SCHEMA,
    authoritative: false,
    missionId: MP3_MISSION_ID,
    authorityId: AUTHORITY_ID,
    authorityPolicyId: authority.authorityPolicyId,
    namespaceId: NAMESPACE_ID,
    namespacePolicyId: namespace.namespacePolicyId,
    registryManifestId: registry.registryManifestId,
    sourcePerimeter: 'universe.master enabled && !excluded; positive structured quoteType evidence determines evidenced vs unresolved',
    sourcePaths: Object.keys(sourceHashes),
    sourceSha256s: sourceHashes,
    sourceEvidenceAsOf: fundamentals.asOf ?? null,
    effectiveDateDecision: 'alias validFrom is the civil date of the local fundamentals evidence observation; no earlier listing history is claimed',
    targetPoolCount: targetPool.length,
    positiveKindEvidencedCount: evidenced.length,
    excludedUnresolvedKindCount: unresolved.length,
    unresolvedSymbols: unresolved.map((row) => ({ symbol: row.symbol, reason: row.exclusionReason })),
    instrumentCount: evidenced.length,
    instrumentKindDistribution: countBy(evidenced, 'instrumentKind'),
    identities: evidenced.map((row) => {
      const entry = bySymbol.get(row.symbol);
      return {
        symbol: entry.symbol,
        instrumentKind: entry.instrumentKind,
        identitySeed: entry.identitySeed,
        instrumentIdentityId: entry.instrumentIdentityId,
        aliasBindingCoreId: entry.aliasBindingCoreId,
      };
    }),
    materializerPath: 'scripts/materializeJarviseMp3InstrumentIdentityR1.mjs',
    materializerSha256,
    seedPersistence: 'identity-store.json is atomically updated immediately after each first mint; existing seeds are reused',
  };
  atomicWriteJson(outputRoot, join(outputRoot, 'PROVENANCE.json'), provenance);

  return {
    verdict: 'WHEEL_JARVISE_MP3_INSTRUMENT_IDENTITY_PRIMITIVE_PASS',
    canonicalPinSha256,
    authorityId: AUTHORITY_ID,
    authorityPolicyId: authority.authorityPolicyId,
    namespaceId: NAMESPACE_ID,
    namespacePolicyId: namespace.namespacePolicyId,
    venuePolicy: namespace.namespacePolicy.venuePolicy,
    currencyPolicy: namespace.namespacePolicy.currencyPolicy,
    targetPoolCount: targetPool.length,
    positiveKindEvidencedCount: evidenced.length,
    excludedUnresolvedKindCount: unresolved.length,
    unresolvedSymbols: unresolved.map((row) => row.symbol),
    mintedIdentityCount,
    reusedExistingIdentityCount,
    seedGenerationPrimitive: randomness.primitive,
    symbolDerivedSeeds: 0,
    forbiddenRandomUsage: randomness.forbiddenUsageCount,
    identitySeedFormat: '64 lowercase hex',
    instrumentKindDistribution: countBy(evidenced, 'instrumentKind'),
    registryManifestId: registry.registryManifestId,
    aliasBindingCount: evidenced.length,
    asOfResolutionSuccesses: resolutions.length,
    asOfResolutionFailures: 0,
    registryVerification: 'PASS',
    newSeeds: mintedIdentityCount,
    replacedSeeds: 0,
    changedIdentityIds: identitiesChanged,
    outputRoot,
  };
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    process.stdout.write(`${JSON.stringify(materializeMp3(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      verdict: error?.code ?? 'REPAIR_REQUIRED',
      message: error?.message ?? String(error),
      details: error?.details ?? {},
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
