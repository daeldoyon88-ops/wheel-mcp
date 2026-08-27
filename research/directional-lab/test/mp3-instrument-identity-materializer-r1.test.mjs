import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  buildInstrumentAliasBinding,
  buildInstrumentIdentity,
  buildInstrumentIdentityAuthorityPolicy,
  buildInstrumentIdentityManifest,
  buildInstrumentIdentityRegistry,
  buildSymbolNamespacePolicy,
  resolveInstrumentIdentityAsOf,
} from '../src/data/buildInstrumentIdentity.mjs';
import {
  AUTHORITY_ID,
  CANONICAL_CONTRACT_SHA256,
  Mp3MaterializationError,
  assertCanonicalPin,
  assertExistingIdentityCompatible,
  assertProducerRandomnessBoundary,
  assertSeedCandidate,
  buildAuthorityPolicyInput,
  buildNamespacePolicyInput,
  derivePositiveKindEvidence,
  materializeMp3,
} from '../../../scripts/materializeJarviseMp3InstrumentIdentityR1.mjs';
import {
  validateInstrumentIdentityAuthorityPolicy,
  validateSymbolNamespacePolicy,
} from '../src/contracts/instrumentIdentityV1.mjs';

const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);

function code(expected) {
  return (error) => error?.code === expected;
}

function withTempDirectory(fn) {
  const root = mkdtempSync(join(tmpdir(), 'jarvise-mp3-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixtureFundamentals() {
  return {
    asOf: '2026-05-03T08:56:22.567Z',
    source: 'yahoo-finance2',
    items: {
      ABC: { symbol: 'ABC', quoteType: 'EQUITY', currency: 'USD', asOf: '2026-05-03T08:56:23.000Z' },
      'BF.B': { symbol: 'BF.B', quoteType: 'EQUITY', currency: 'USD', asOf: '2026-05-03T08:56:24.000Z' },
      UNKNOWN: { symbol: 'UNKNOWN', currency: 'USD', asOf: '2026-05-03T08:56:25.000Z' },
    },
  };
}

function buildTestAuthorityAndNamespace(store) {
  const authority = buildInstrumentIdentityAuthorityPolicy({
    store,
    authorityId: AUTHORITY_ID,
    identitySeedFormat: 'HEX_LOWERCASE',
    identitySeedLength: 64,
  });
  const namespace = buildSymbolNamespacePolicy({
    store,
    namespaceId: 'wheel-jarvise-mp3-test',
    namespaceVersion: 1,
    providerId: 'yahoo-finance2',
    venuePolicy: 'NOT_APPLICABLE',
    casePolicy: 'ASCII_UPPERCASE',
    allowedCharacterPolicy: 'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
    currencyPolicy: 'REQUIRED',
  });
  return { authority, namespace };
}

test('MP3 P1/P2/P3/P4/P6-P11 - production adapter materializes and reruns without reseeding', () => {
  withTempDirectory((outputRoot) => {
    const options = {
      outputRoot,
      testOnlyAllowOutputRoot: true,
      targetPoolOverride: ['ABC', 'BF.B', 'UNKNOWN'],
      fundamentalsOverride: fixtureFundamentals(),
      sourceHashesOverride: {
        'data/universe/fundamentals.cache.json': '1'.repeat(64),
        'data/universe/universe.master.json': '2'.repeat(64),
        'app/watchlist/researchExpandedPool.js': '3'.repeat(64),
      },
      now: () => '2026-08-27T12:00:00.000Z',
    };
    const first = materializeMp3(options);
    const projectionFirst = JSON.parse(readFileSync(join(outputRoot, 'identity-store.json'), 'utf8'));
    const second = materializeMp3({ ...options, now: () => { throw new Error('must not mint on rerun'); } });
    const projectionSecond = JSON.parse(readFileSync(join(outputRoot, 'identity-store.json'), 'utf8'));

    assert.equal(validateInstrumentIdentityAuthorityPolicy(buildAuthorityPolicyInput()).valid, true);
    assert.equal(validateSymbolNamespacePolicy(buildNamespacePolicyInput()).valid, true);
    assert.equal(first.mintedIdentityCount, 2);
    assert.equal(first.excludedUnresolvedKindCount, 1);
    assert.equal(first.venuePolicy, 'NOT_APPLICABLE');
    assert.equal(first.currencyPolicy, 'REQUIRED');
    assert.equal(first.registryVerification, 'PASS');
    assert.equal(first.asOfResolutionSuccesses, 2);
    assert.equal(first.asOfResolutionFailures, 0);
    assert.equal(first.aliasBindingCount, 2);
    assert.equal(first.symbolDerivedSeeds, 0);
    assert.equal(first.forbiddenRandomUsage, 0);
    assert.match(projectionFirst.identities.find((row) => row.symbol === 'ABC').identitySeed, /^[0-9a-f]{64}$/);
    assert.ok(projectionFirst.identities.some((row) => row.symbol === 'BF.B'));
    assert.equal(second.newSeeds, 0);
    assert.equal(second.replacedSeeds, 0);
    assert.equal(second.changedIdentityIds, 0);
    assert.equal(second.reusedExistingIdentityCount, 2);
    assert.equal(second.registryManifestId, first.registryManifestId);
    assert.deepEqual(projectionSecond, projectionFirst);
  });
});

test('MP3 P5 - symbol is absent from identity core and cannot affect its ID', () => {
  withTempDirectory((root) => {
    const store = createContentAddressedStore({ root });
    const { authority } = buildTestAuthorityAndNamespace(store);
    const first = buildInstrumentIdentity({
      store,
      authorityPolicyId: authority.authorityPolicyId,
      identitySeed: SEED_A,
      instrumentKind: 'EQUITY',
    });
    const second = buildInstrumentIdentity({
      store,
      authorityPolicyId: authority.authorityPolicyId,
      identitySeed: SEED_A,
      instrumentKind: 'EQUITY',
    });
    assert.equal(Object.hasOwn(first.identityCore, 'symbol'), false);
    assert.equal(first.instrumentIdentityId, second.instrumentIdentityId);
  });
});

test('MP3 P12 - permanent seed survives an effective-dated alias rename', () => {
  withTempDirectory((root) => {
    const store = createContentAddressedStore({ root });
    const { authority, namespace } = buildTestAuthorityAndNamespace(store);
    const identity = buildInstrumentIdentity({
      store,
      authorityPolicyId: authority.authorityPolicyId,
      identitySeed: SEED_A,
      instrumentKind: 'EQUITY',
    });
    const oldAlias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: namespace.namespacePolicyId,
      venueId: null,
      symbol: 'BF.B',
      currency: 'USD',
      validFrom: '2026-01-01',
      validToExclusive: '2026-06-01',
    });
    const newAlias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: namespace.namespacePolicyId,
      venueId: null,
      symbol: 'BF-B',
      currency: 'USD',
      validFrom: '2026-06-01',
      validToExclusive: null,
    });
    const manifest = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      aliasBindingCoreIds: [oldAlias.aliasBindingCoreId, newAlias.aliasBindingCoreId],
    });
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: authority.authorityPolicyId,
      identityManifestIds: [manifest.identityManifestId],
    });
    for (const [symbol, asOfDate] of [['bf.b', '2026-05-31'], ['bf-b', '2026-06-01']]) {
      const resolved = resolveInstrumentIdentityAsOf({
        store,
        registryManifestId: registry.registryManifestId,
        namespacePolicyId: namespace.namespacePolicyId,
        providerId: 'yahoo-finance2',
        venueId: null,
        symbol,
        currency: 'USD',
        asOfDate,
      });
      assert.equal(resolved.instrumentIdentityId, identity.instrumentIdentityId);
    }
  });
});

test('MP3 N1/N8/N9/N10 - derived and malformed seeds are refused', () => {
  const tickerDigest = createHash('sha256').update('ABC').digest('hex');
  assert.throws(() => assertSeedCandidate(tickerDigest, 'ABC', 'EQUITY'), code('MP3_SYMBOL_DERIVED_SEED_DETECTED'));
  assert.throws(() => assertSeedCandidate('not-hex', 'ABC', 'EQUITY'), code('MP3_SEED_FORMAT_INVALID'));
  assert.throws(() => assertSeedCandidate('a'.repeat(63), 'ABC', 'EQUITY'), code('MP3_SEED_FORMAT_INVALID'));
  assert.throws(() => assertSeedCandidate('a'.repeat(65), 'ABC', 'EQUITY'), code('MP3_SEED_FORMAT_INVALID'));
  assert.throws(() => assertSeedCandidate('A'.repeat(64), 'ABC', 'EQUITY'), code('MP3_SEED_FORMAT_INVALID'));
});

test('MP3 N2 - producer refuses a forbidden non-CSPRNG source boundary', () => {
  assert.throws(
    () => assertProducerRandomnessBoundary(`const seed = ${['Math', 'random'].join('.')}();`),
    code('MP3_SEED_FORMAT_INVALID'),
  );
  assert.equal(assertProducerRandomnessBoundary('randomBytes(32)').forbiddenUsageCount, 0);
});

test('MP3 N3/N4 - seed replacement and kind evidence conflict are refused', () => {
  const existing = {
    symbol: 'ABC',
    quoteType: 'EQUITY',
    instrumentKind: 'EQUITY',
    currency: 'USD',
    identitySeed: SEED_A,
  };
  const evidence = derivePositiveKindEvidence('ABC', fixtureFundamentals().items.ABC);
  assert.throws(() => assertExistingIdentityCompatible(existing, evidence, SEED_B), code('MP3_EXISTING_IDENTITY_CONFLICT'));
  assert.throws(
    () => assertExistingIdentityCompatible(existing, { ...evidence, quoteType: 'ETF', instrumentKind: 'ETF' }),
    code('MP3_EXISTING_IDENTITY_CONFLICT'),
  );
});

test('MP3 N5 - unresolved kind is excluded rather than guessed', () => {
  const unresolved = derivePositiveKindEvidence('UNKNOWN', fixtureFundamentals().items.UNKNOWN);
  assert.equal(unresolved.resolved, false);
  assert.equal(unresolved.exclusionReason, 'INSTRUMENT_KIND_UNRESOLVED');
});

test('MP3 N6 - ambiguous alias is refused by the actual registry builder', () => {
  withTempDirectory((root) => {
    const store = createContentAddressedStore({ root });
    const { authority, namespace } = buildTestAuthorityAndNamespace(store);
    const manifests = [SEED_A, SEED_B].map((seed) => {
      const identity = buildInstrumentIdentity({
        store,
        authorityPolicyId: authority.authorityPolicyId,
        identitySeed: seed,
        instrumentKind: 'EQUITY',
      });
      const alias = buildInstrumentAliasBinding({
        store,
        instrumentIdentityId: identity.instrumentIdentityId,
        namespacePolicyId: namespace.namespacePolicyId,
        venueId: null,
        symbol: 'ABC',
        currency: 'USD',
        validFrom: '2026-01-01',
        validToExclusive: null,
      });
      return buildInstrumentIdentityManifest({
        store,
        instrumentIdentityId: identity.instrumentIdentityId,
        aliasBindingCoreIds: [alias.aliasBindingCoreId],
      }).identityManifestId;
    });
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: authority.authorityPolicyId,
        identityManifestIds: manifests,
      }),
      code('INSTRUMENT_ALIAS_AMBIGUOUS'),
    );
  });
});

test('MP3 N7 - venue is refused under NOT_APPLICABLE', () => {
  withTempDirectory((root) => {
    const store = createContentAddressedStore({ root });
    const { authority, namespace } = buildTestAuthorityAndNamespace(store);
    const identity = buildInstrumentIdentity({
      store,
      authorityPolicyId: authority.authorityPolicyId,
      identitySeed: SEED_A,
      instrumentKind: 'EQUITY',
    });
    assert.throws(
      () => buildInstrumentAliasBinding({
        store,
        instrumentIdentityId: identity.instrumentIdentityId,
        namespacePolicyId: namespace.namespacePolicyId,
        venueId: 'XNYS',
        symbol: 'ABC',
        currency: 'USD',
        validFrom: '2026-01-01',
        validToExclusive: null,
      }),
      code('INSTRUMENT_ALIAS_INVALID'),
    );
  });
});

test('MP3 N11 - canonical contract SHA drift blocks before emission', () => {
  assert.equal(assertCanonicalPin(), CANONICAL_CONTRACT_SHA256);
  assert.throws(() => assertCanonicalPin({ expectedSha: '0'.repeat(64) }), code('MP3_CANONICAL_PIN_DRIFT'));
});

test('MP3 N12 - production materializer refuses an output root outside MP-3', () => {
  withTempDirectory((outputRoot) => {
    assert.throws(() => materializeMp3({ outputRoot }), (error) => (
      error instanceof Mp3MaterializationError && error.code === 'MP3_OUTPUT_SCOPE_EXPANSION_REQUIRED'
    ));
  });
});
