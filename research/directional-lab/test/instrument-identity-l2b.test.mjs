/**
 * L2B-R1 — permanent instrument identity registry (synthetic fixtures only).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
  computeSymbolLookupKey,
  halfOpenIntervalsOverlap,
  instrumentIdentityCoreId,
  normalizeInstrumentIdentityCoreV1,
  symbolNamespacePolicyId,
  validateInstrumentDescriptorCore,
  validateInstrumentIdentityCore,
  validateInstrumentIdentityManifest,
  validateSymbolNamespacePolicy,
} from '../src/contracts/instrumentIdentityV1.mjs';
import {
  buildDatasetSnapshotInstrumentBinding,
  buildInstrumentAliasBinding,
  buildInstrumentAliasRevocation,
  buildInstrumentDescriptor,
  buildInstrumentIdentity,
  buildInstrumentIdentityAuthorityPolicy,
  buildInstrumentIdentityManifest,
  buildInstrumentIdentityRecord,
  buildInstrumentIdentityRegistry,
  buildProviderInstrumentBinding,
  buildSymbolNamespacePolicy,
  recoverInstrumentIdentityRegistry,
  resolveInstrumentIdentityAsOf,
  verifyDatasetSnapshotInstrumentBinding,
  verifyInstrumentAliasBinding,
  verifyInstrumentDescriptor,
  verifyInstrumentIdentity,
  verifyInstrumentIdentityManifest,
  verifyInstrumentIdentityRegistry,
  verifyProviderInstrumentBinding,
  verifySymbolNamespacePolicy,
} from '../src/data/buildInstrumentIdentity.mjs';
import { buildSyntheticSnapshot, code, withStore } from './l2aSyntheticPipeline.mjs';
import { CanonicalizationError } from '../src/canonical/canonicalJsonV1.mjs';

const AUTHORITY = 'directional-lab-local/1';
const EXEC = Object.freeze({ runnerId: 'node:test', runId: null, environment: 'LOCAL_TEST' });
const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);
const SEED_C = 'c'.repeat(64);
const SEED_D = 'd'.repeat(64);
const SEED_E = 'e'.repeat(64);
const SEED_F = 'f'.repeat(64);
const SEED_1 = '1'.repeat(64);
const SEED_2 = '2'.repeat(64);
const SEED_3 = '3'.repeat(64);
const SEED_4 = '4'.repeat(64);
const SEED_5 = '5'.repeat(64);
const SEED_6 = '6'.repeat(64);
const SEED_7 = '7'.repeat(64);
const SEED_8 = '8'.repeat(64);
const SEED_9 = '9'.repeat(64);

/** @param {(store: any) => unknown} fn */
function withLabStore(fn) {
  return withStore((store) => fn(store));
}

function publishAuthority(store, authorityId = AUTHORITY) {
  return buildInstrumentIdentityAuthorityPolicy({
    store,
    authorityId,
    identitySeedFormat: 'HEX_LOWERCASE',
    identitySeedLength: 64,
  });
}

function publishNamespace(store, overrides = {}) {
  return buildSymbolNamespacePolicy({
    store,
    namespaceId: overrides.namespaceId ?? 'lab-synth-provider-a',
    namespaceVersion: overrides.namespaceVersion ?? 1,
    providerId: overrides.providerId ?? 'synth-provider-a',
    venuePolicy: overrides.venuePolicy ?? 'REQUIRED',
    casePolicy: overrides.casePolicy ?? 'ASCII_UPPERCASE',
    currencyPolicy: overrides.currencyPolicy ?? 'REQUIRED',
    allowedCharacterPolicy: 'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
  });
}

function publishIdentity(store, authorityPolicyId, seed, kind = 'EQUITY') {
  return buildInstrumentIdentity({
    store,
    authorityPolicyId,
    identitySeed: seed,
    instrumentKind: kind,
  });
}

function resolve(store, registryManifestId, ns, symbol, asOfDate, extras = {}) {
  return resolveInstrumentIdentityAsOf({
    store,
    registryManifestId,
    namespacePolicyId: ns.namespacePolicyId,
    providerId: extras.providerId ?? 'synth-provider-a',
    venueId: extras.venueId !== undefined ? extras.venueId : 'XNAS',
    symbol,
    currency: extras.currency !== undefined ? extras.currency : 'USD',
    asOfDate,
  });
}

// ─── Interval helper ────────────────────────────────────────────────────────

test('L2B-IV — half-open overlap boundaries and empty intervals', () => {
  assert.equal(halfOpenIntervalsOverlap('2020-01-01', '2023-01-01', '2023-01-01', null), false);
  assert.equal(halfOpenIntervalsOverlap('2020-01-01', '2023-01-01', '2022-12-31', null), true);
  assert.equal(halfOpenIntervalsOverlap('2020-01-01', null, '2025-01-01', null), true);
  assert.equal(halfOpenIntervalsOverlap('2020-01-01', '2020-01-01', '2020-01-01', null), false);
});

// ─── Authority + seed policy ────────────────────────────────────────────────

test('L2B-I1 — same policy + seed + kind → same instrumentIdentityId', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const a = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const b = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    assert.equal(a.instrumentIdentityId, b.instrumentIdentityId);
    assert.equal(a.identityCoreObject.created, true);
    assert.equal(b.identityCoreObject.created, false);
  });
});

test('L2B-I2 — different seed → different ID; ticker seeds refused', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const a = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const b = publishIdentity(store, auth.authorityPolicyId, SEED_B);
    assert.notEqual(a.instrumentIdentityId, b.instrumentIdentityId);
    assert.throws(
      () => publishIdentity(store, auth.authorityPolicyId, 'APLD'),
      code('INSTRUMENT_IDENTITY_INVALID'),
    );
    assert.throws(
      () => publishIdentity(store, auth.authorityPolicyId, 'A'.repeat(64)),
      code('INSTRUMENT_IDENTITY_INVALID'),
    );
    assert.throws(
      () => publishIdentity(store, auth.authorityPolicyId, 'a'.repeat(63)),
      code('INSTRUMENT_IDENTITY_INVALID'),
    );
    assert.throws(
      () => publishIdentity(store, auth.authorityPolicyId, 'a'.repeat(65)),
      code('INSTRUMENT_IDENTITY_INVALID'),
    );
  });
});

test('L2B-I3 — ticker/symbol/authorityId forbidden on identity core', () => {
  const authId = `sha256:${'a'.repeat(64)}`;
  assert.throws(
    () => normalizeInstrumentIdentityCoreV1({
      schemaVersion: INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
      authorityPolicyId: authId,
      identitySeed: SEED_A,
      instrumentKind: 'EQUITY',
      ticker: 'ABC',
    }),
    (error) => error instanceof CanonicalizationError && error.code === 'CANONICAL_UNKNOWN_FIELD',
  );
  const valid = {
    schemaVersion: INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
    authorityPolicyId: authId,
    identitySeed: SEED_A,
    instrumentKind: 'EQUITY',
  };
  assert.equal(validateInstrumentIdentityCore(valid).valid, true);
});

test('L2B-I4 — missing policy refused; no random seed generation', () => {
  withLabStore((store) => {
    assert.throws(
      () => buildInstrumentIdentity({
        store,
        authorityPolicyId: `sha256:${'0'.repeat(64)}`,
        identitySeed: SEED_A,
        instrumentKind: 'EQUITY',
      }),
      code('INSTRUMENT_REFERENCE_MISSING'),
    );
    const src = readFileSync(new URL('../src/data/instrumentIdentityBuildersCore.mjs', import.meta.url), 'utf8');
    assert.equal(src.includes('randomBytes'), false);
    assert.equal(src.includes('Math.random'), false);
  });
});

test('L2B-I5 — identity record keeps registeredAt outside the core', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_1);
    const recordA = buildInstrumentIdentityRecord({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      registeredAt: '2026-01-01T12:00:00Z',
      registrationAuthority: AUTHORITY,
      executionIdentity: EXEC,
    });
    const recordB = buildInstrumentIdentityRecord({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      registeredAt: '2026-01-02T12:00:00Z',
      registrationAuthority: AUTHORITY,
      executionIdentity: EXEC,
    });
    assert.notEqual(recordA.identityRecordId, recordB.identityRecordId);
  });
});

// ─── Descriptor kind coherence ──────────────────────────────────────────────

test('L2B-D1 — coherent kind accepted; EQUITY vs ETF refused', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_2, 'EQUITY');
    const d1 = buildInstrumentDescriptor({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      legalName: 'Synthetic Alpha Corp',
      displayName: 'Alpha',
      instrumentKind: 'EQUITY',
      domicileCountry: 'US',
      primaryCurrency: 'USD',
      status: 'ACTIVE',
    });
    assert.equal(verifyInstrumentDescriptor({ store, descriptorCoreId: d1.descriptorCoreId }).descriptorCore.displayName, 'Alpha');
    assert.throws(
      () => buildInstrumentDescriptor({
        store,
        instrumentIdentityId: identity.instrumentIdentityId,
        legalName: 'X',
        displayName: 'X',
        instrumentKind: 'ETF',
        domicileCountry: 'US',
        primaryCurrency: 'USD',
        status: 'ACTIVE',
      }),
      code('INSTRUMENT_DESCRIPTOR_KIND_MISMATCH'),
    );
  });
});

test('L2B-D2 — currency/country/status validated; absent identity refused', () => {
  withLabStore((store) => {
    const missingId = `sha256:${'1'.repeat(64)}`;
    assert.throws(
      () => buildInstrumentDescriptor({
        store,
        instrumentIdentityId: missingId,
        legalName: 'X',
        displayName: 'X',
        instrumentKind: 'EQUITY',
        domicileCountry: 'US',
        primaryCurrency: 'USD',
        status: 'ACTIVE',
      }),
      code('INSTRUMENT_REFERENCE_MISSING'),
    );
    const bad = validateInstrumentDescriptorCore({
      schemaVersion: 'InstrumentDescriptorCore/1',
      instrumentIdentityId: missingId,
      legalName: 'X',
      displayName: 'X',
      instrumentKind: 'EQUITY',
      domicileCountry: 'USA',
      primaryCurrency: 'usd',
      status: 'LIVE',
    });
    assert.equal(bad.valid, false);
  });
});

// ─── Namespace version ──────────────────────────────────────────────────────

test('L2B-NS — namespaceVersion required; hash changes with version', () => {
  const base = {
    schemaVersion: 'SymbolNamespacePolicy/1',
    namespaceId: 'lab-synth-provider-a',
    namespaceVersion: 1,
    providerId: 'synth-provider-a',
    venuePolicy: 'REQUIRED',
    casePolicy: 'ASCII_UPPERCASE',
    allowedCharacterPolicy: 'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
    currencyPolicy: 'REQUIRED',
  };
  assert.equal(validateSymbolNamespacePolicy(base).valid, true);
  assert.equal(validateSymbolNamespacePolicy({ ...base, namespaceVersion: 0 }).valid, false);
  assert.equal(validateSymbolNamespacePolicy({ ...base, namespaceVersion: 1.5 }).valid, false);
  assert.equal(validateSymbolNamespacePolicy({ ...base, namespaceVersion: '1' }).valid, false);
  const { namespaceVersion: _drop, ...without } = base;
  assert.equal(validateSymbolNamespacePolicy(without).valid, false);
  const id1 = symbolNamespacePolicyId(base);
  const id2 = symbolNamespacePolicyId({ ...base, namespaceVersion: 2 });
  assert.notEqual(id1, id2);
});

// ─── Alias + rename via registry ────────────────────────────────────────────

test('L2B-A1 — open/closed intervals; lookup key recomputed; no evidence IDs', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_3);
    const ns = publishNamespace(store);
    const open = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'Old',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    assert.equal(open.aliasBindingCore.symbolLookupKey, 'OLD');
    assert.equal(Object.hasOwn(open.aliasBindingCore, 'evidenceObjectIds'), false);
    assert.throws(
      () => buildInstrumentAliasBinding({
        store,
        instrumentIdentityId: identity.instrumentIdentityId,
        namespacePolicyId: ns.namespacePolicyId,
        venueId: 'XNAS',
        symbol: 'BAD',
        currency: 'USD',
        validFrom: '2024-05-01',
        validToExclusive: '2024-05-01',
      }),
      code('INSTRUMENT_ALIAS_INVALID'),
    );
  });
});

test('L2B-T1 — OLD then NEW; registry resolve before/after', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_4);
    const ns = publishNamespace(store);
    const oldAlias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'OLD',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: '2024-05-01',
    });
    const newAlias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'NEW',
      currency: 'USD',
      validFrom: '2024-05-01',
      validToExclusive: null,
    });
    const manifest = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      aliasBindingCoreIds: [oldAlias.aliasBindingCoreId, newAlias.aliasBindingCoreId],
    });
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifest.identityManifestId],
    });

    const before = resolve(store, registry.registryManifestId, ns, 'OLD', '2024-04-30');
    assert.equal(before.instrumentIdentityId, identity.instrumentIdentityId);
    assert.equal(before.aliasBindingCoreId, oldAlias.aliasBindingCoreId);

    const after = resolve(store, registry.registryManifestId, ns, 'NEW', '2024-05-01');
    assert.equal(after.aliasBindingCoreId, newAlias.aliasBindingCoreId);

    assert.throws(
      () => resolve(store, registry.registryManifestId, ns, 'OLD', '2024-05-01'),
      code('INSTRUMENT_ALIAS_NOT_FOUND'),
    );
  });
});

// ─── Global registry / reuse / ambiguity ────────────────────────────────────

test('L2B-R1 — ticker reuse via registry; gap NOT_FOUND', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identityA = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const identityB = publishIdentity(store, auth.authorityPolicyId, SEED_B);
    const ns = publishNamespace(store);
    const aliasA = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'ABC',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: '2023-01-01',
    });
    const aliasB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'ABC',
      currency: 'USD',
      validFrom: '2025-01-01',
      validToExclusive: null,
    });
    const manifestA = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      aliasBindingCoreIds: [aliasA.aliasBindingCoreId],
    });
    const manifestB = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasB.aliasBindingCoreId],
    });
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifestA.identityManifestId, manifestB.identityManifestId],
    });

    assert.equal(resolve(store, registry.registryManifestId, ns, 'ABC', '2021-06-15').instrumentIdentityId,
      identityA.instrumentIdentityId);
    assert.throws(
      () => resolve(store, registry.registryManifestId, ns, 'ABC', '2024-06-15'),
      code('INSTRUMENT_ALIAS_NOT_FOUND'),
    );
    assert.equal(resolve(store, registry.registryManifestId, ns, 'ABC', '2026-06-15').instrumentIdentityId,
      identityB.instrumentIdentityId);
  });
});

test('L2B-M1 — overlapping aliases across identities refuse registry', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identityA = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const identityB = publishIdentity(store, auth.authorityPolicyId, SEED_B);
    const ns = publishNamespace(store);
    const aliasA = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'ABC',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const aliasB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'abc',
      currency: 'USD',
      validFrom: '2025-01-01',
      validToExclusive: null,
    });
    const manifestA = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      aliasBindingCoreIds: [aliasA.aliasBindingCoreId],
    });
    const manifestB = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasB.aliasBindingCoreId],
    });
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [manifestA.identityManifestId, manifestB.identityManifestId],
      }),
      code('INSTRUMENT_ALIAS_AMBIGUOUS'),
    );
  });
});

test('L2B-RG1 — explicit empty registry is valid; free IDs and omission are refused', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const emptyRegistry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [],
    });
    assert.deepEqual(emptyRegistry.registryManifest.identityManifestIds, []);
    assert.deepEqual(
      verifyInstrumentIdentityRegistry({
        store,
        registryManifestId: emptyRegistry.registryManifestId,
      }).identityBundles,
      [],
    );
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
      }),
      code('INSTRUMENT_IDENTITY_REGISTRY_INVALID'),
    );
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_5);
    const ns = publishNamespace(store);
    const alias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'AAA',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const manifest = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
    });
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifest.identityManifestId],
    });
    assert.throws(
      () => resolveInstrumentIdentityAsOf({
        store,
        registryManifestId: registry.registryManifestId,
        identityManifestIds: [manifest.identityManifestId],
        namespacePolicyId: ns.namespacePolicyId,
        providerId: 'synth-provider-a',
        venueId: 'XNAS',
        symbol: 'AAA',
        currency: 'USD',
        asOfDate: '2021-01-01',
      }),
      code('INSTRUMENT_INPUT_INVALID'),
    );
    assert.throws(
      () => resolveInstrumentIdentityAsOf({
        store,
        identityManifestId: manifest.identityManifestId,
        namespacePolicyId: ns.namespacePolicyId,
        providerId: 'synth-provider-a',
        venueId: 'XNAS',
        symbol: 'AAA',
        currency: 'USD',
        asOfDate: '2021-01-01',
      }),
      code('INSTRUMENT_INPUT_INVALID'),
    );
    assert.throws(
      () => verifyInstrumentIdentityRegistry({
        store, registryManifestId: `sha256:${'9'.repeat(64)}`,
      }),
      code('INSTRUMENT_REFERENCE_MISSING'),
    );
  });
});

// ─── Multi-provider ─────────────────────────────────────────────────────────

test('L2B-P1 — distinct namespaces; no cross-provider implicit resolution', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_6);
    const nsA = publishNamespace(store, { namespaceId: 'lab-synth-provider-a', providerId: 'synth-provider-a' });
    const nsB = publishNamespace(store, {
      namespaceId: 'lab-synth-provider-b',
      providerId: 'synth-provider-b',
      venuePolicy: 'OPTIONAL',
    });
    const aliasA = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: nsA.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'ABC',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const aliasB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: nsB.namespacePolicyId,
      venueId: null,
      symbol: 'ABC.US',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const manifest = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      aliasBindingCoreIds: [aliasA.aliasBindingCoreId, aliasB.aliasBindingCoreId],
    });
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifest.identityManifestId],
    });
    assert.equal(resolve(store, registry.registryManifestId, nsA, 'ABC', '2021-01-01').instrumentIdentityId,
      identity.instrumentIdentityId);
    assert.throws(
      () => resolve(store, registry.registryManifestId, nsA, 'ABC.US', '2021-01-01'),
      code('INSTRUMENT_ALIAS_NOT_FOUND'),
    );
    assert.throws(
      () => resolve(store, registry.registryManifestId, nsB, 'ABC.US', '2021-01-01', {
        providerId: 'synth-provider-a', venueId: null,
      }),
      code('SYMBOL_NAMESPACE_MISMATCH'),
    );
  });
});

// ─── Provider ID global uniqueness ──────────────────────────────────────────

test('L2B-PB1 — global provider ID overlap refused; gaps allowed', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identityA = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const identityB = publishIdentity(store, auth.authorityPolicyId, SEED_B);
    const first = buildProviderInstrumentBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      providerId: 'synth-provider-c',
      providerInstrumentId: '123456',
      validFrom: '2020-01-01',
      validToExclusive: '2023-01-01',
    });
    const second = buildProviderInstrumentBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      providerId: 'synth-provider-c',
      providerInstrumentId: '123456',
      validFrom: '2023-01-01',
      validToExclusive: null,
    });
    const overlap = buildProviderInstrumentBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      providerId: 'synth-provider-c',
      providerInstrumentId: '123456',
      validFrom: '2022-01-01',
      validToExclusive: '2024-01-01',
    });
    const manifestA = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      providerBindingCoreIds: [first.providerBindingCoreId],
    });
    const manifestGap = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      providerBindingCoreIds: [second.providerBindingCoreId],
    });
    buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifestA.identityManifestId, manifestGap.identityManifestId],
    });
    const manifestOverlap = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      providerBindingCoreIds: [overlap.providerBindingCoreId],
    });
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [manifestA.identityManifestId, manifestOverlap.identityManifestId],
      }),
      code('PROVIDER_INSTRUMENT_BINDING_AMBIGUOUS'),
    );
  });
});

// ─── Append-only identity manifest ──────────────────────────────────────────

test('L2B-MF1 — append-only supersedes; drop refused; chain walks history', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identityA = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const identityB = publishIdentity(store, auth.authorityPolicyId, SEED_B);
    const ns = publishNamespace(store);
    const record = buildInstrumentIdentityRecord({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      registeredAt: '2026-01-01T00:00:00Z',
      registrationAuthority: AUTHORITY,
      executionIdentity: EXEC,
    });
    const descriptor = buildInstrumentDescriptor({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      legalName: 'A',
      displayName: 'A',
      instrumentKind: 'EQUITY',
      domicileCountry: 'US',
      primaryCurrency: 'USD',
      status: 'ACTIVE',
    });
    const alias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'AAA',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const m1 = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      identityRecordIds: [record.identityRecordId],
      descriptorCoreIds: [descriptor.descriptorCoreId],
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
    });
    assert.throws(
      () => buildInstrumentIdentityManifest({
        store,
        instrumentIdentityId: identityA.instrumentIdentityId,
        identityRecordIds: [record.identityRecordId],
        descriptorCoreIds: [descriptor.descriptorCoreId],
        supersedesManifestId: m1.identityManifestId,
      }),
      code('INSTRUMENT_IDENTITY_MANIFEST_INVALID'),
    );
    assert.throws(
      () => buildInstrumentIdentityManifest({
        store,
        instrumentIdentityId: identityA.instrumentIdentityId,
        descriptorCoreIds: [descriptor.descriptorCoreId],
        aliasBindingCoreIds: [alias.aliasBindingCoreId],
        supersedesManifestId: m1.identityManifestId,
      }),
      code('INSTRUMENT_IDENTITY_MANIFEST_INVALID'),
    );
    const m2 = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      identityRecordIds: [record.identityRecordId],
      descriptorCoreIds: [descriptor.descriptorCoreId],
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
      supersedesManifestId: m1.identityManifestId,
    });
    const m3 = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      identityRecordIds: [record.identityRecordId],
      descriptorCoreIds: [descriptor.descriptorCoreId],
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
      supersedesManifestId: m2.identityManifestId,
    });
    const uri = store.uriForObject({ namespace: 'snapshots', objectId: alias.aliasBindingCoreId });
    const physical = join(store.root, ...uri.split('/'));
    const original = readFileSync(physical);
    unlinkSync(physical);
    assert.throws(
      () => verifyInstrumentIdentityManifest({ store, identityManifestId: m3.identityManifestId }),
      code('INSTRUMENT_REFERENCE_MISSING'),
    );
    writeFileSync(physical, original);

    const aliasB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'BBB',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const foreign = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasB.aliasBindingCoreId],
    });
    assert.throws(
      () => buildInstrumentIdentityManifest({
        store,
        instrumentIdentityId: identityA.instrumentIdentityId,
        identityRecordIds: [record.identityRecordId],
        descriptorCoreIds: [descriptor.descriptorCoreId],
        aliasBindingCoreIds: [alias.aliasBindingCoreId],
        supersedesManifestId: foreign.identityManifestId,
      }),
      code('INSTRUMENT_IDENTITY_MANIFEST_INVALID'),
    );
  });
});

// ─── Append-only registry ───────────────────────────────────────────────────

test('L2B-RG2 — registry append-only; drop identity refused; chain walks history', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identityA = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const identityB = publishIdentity(store, auth.authorityPolicyId, SEED_B);
    const ns = publishNamespace(store);
    const aliasA = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'AAA',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const aliasB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'BBB',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const mA = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      aliasBindingCoreIds: [aliasA.aliasBindingCoreId],
    });
    const mB = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasB.aliasBindingCoreId],
    });
    const r1 = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [mA.identityManifestId],
    });
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [mB.identityManifestId],
        supersedesRegistryManifestId: r1.registryManifestId,
      }),
      code('INSTRUMENT_IDENTITY_REGISTRY_INVALID'),
    );
    const r2 = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [mA.identityManifestId, mB.identityManifestId],
      supersedesRegistryManifestId: r1.registryManifestId,
    });
    const r3 = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [mA.identityManifestId, mB.identityManifestId],
      supersedesRegistryManifestId: r2.registryManifestId,
    });
    const uri = store.uriForObject({ namespace: 'snapshots', objectId: mA.identityManifestId });
    const physical = join(store.root, ...uri.split('/'));
    const original = readFileSync(physical);
    unlinkSync(physical);
    assert.throws(
      () => verifyInstrumentIdentityRegistry({ store, registryManifestId: r3.registryManifestId }),
      code('INSTRUMENT_REFERENCE_MISSING'),
    );
    writeFileSync(physical, original);
  });
});

// ─── Snapshot uniqueness ────────────────────────────────────────────────────

test('L2B-S1 — snapshot linked; conflicting A/B on same snapshot refused by registry', () => {
  withLabStore((store) => {
    const { built } = buildSyntheticSnapshot(store, {
      coreOverrides: {
        canonicalSymbol: 'SYNTH',
        providerId: 'synth-provider-a',
        providerSymbol: 'SYNTH',
      },
    });
    const auth = publishAuthority(store);
    const identityA = publishIdentity(store, auth.authorityPolicyId, SEED_A);
    const identityB = publishIdentity(store, auth.authorityPolicyId, SEED_B);
    const ns = publishNamespace(store, {
      venuePolicy: 'NOT_APPLICABLE',
      currencyPolicy: 'OPTIONAL',
    });
    const aliasA = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: null,
      symbol: 'SYNTH',
      currency: null,
      validFrom: '2020-01-01',
      validToExclusive: '2026-01-01',
    });
    const aliasB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: null,
      symbol: 'SYNTH',
      currency: null,
      validFrom: '2026-01-01',
      validToExclusive: null,
    });
    const snapA = buildDatasetSnapshotInstrumentBinding({
      store,
      snapshotCoreId: built.snapshotCore.objectId,
      instrumentIdentityId: identityA.instrumentIdentityId,
      aliasBindingCoreId: aliasA.aliasBindingCoreId,
      resolutionDate: '2025-06-01',
    });
    // Binding object for B uses same snapshot but different identity — create via put of a
    // second binding only if symbols/dates allow. Use a different resolution path:
    // publish a second synthetic binding by temporarily using aliasA's window for A only,
    // and craft B binding with a later alias that still matches SYNTH after 2026 — but
    // snapshot resolutionDate must be in alias interval. For conflict test we need two
    // bindings to same snapshotCoreId with different identities.
    // Build B binding at 2026-06-01 with aliasB.
    const snapB = buildDatasetSnapshotInstrumentBinding({
      store,
      snapshotCoreId: built.snapshotCore.objectId,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreId: aliasB.aliasBindingCoreId,
      resolutionDate: '2026-06-01',
    });
    assert.notEqual(snapA.snapshotInstrumentBindingId, snapB.snapshotInstrumentBindingId);
    const mA = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      aliasBindingCoreIds: [aliasA.aliasBindingCoreId],
    });
    const mB = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasB.aliasBindingCoreId],
    });
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [mA.identityManifestId, mB.identityManifestId],
        snapshotInstrumentBindingIds: [
          snapA.snapshotInstrumentBindingId, snapB.snapshotInstrumentBindingId,
        ],
      }),
      code('SNAPSHOT_INSTRUMENT_BINDING_CONFLICT'),
    );
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [mA.identityManifestId, mB.identityManifestId],
      snapshotInstrumentBindingIds: [snapA.snapshotInstrumentBindingId],
    });
    assert.equal(
      verifyDatasetSnapshotInstrumentBinding({
        store, snapshotInstrumentBindingId: snapA.snapshotInstrumentBindingId,
      }).snapshotInstrumentBinding.instrumentIdentityId,
      identityA.instrumentIdentityId,
    );
    assert.ok(registry.registryManifestId);
  });
});

// ─── Revocations ────────────────────────────────────────────────────────────

test('L2B-REV — explicit revocation before/at/after; foreign/early/contradictory refused', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_7);
    const other = publishIdentity(store, auth.authorityPolicyId, SEED_8);
    const ns = publishNamespace(store);
    const alias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'NEW',
      currency: 'USD',
      validFrom: '2024-05-01',
      validToExclusive: null,
    });
    assert.throws(
      () => buildInstrumentAliasRevocation({
        store,
        revokedAliasBindingCoreId: alias.aliasBindingCoreId,
        instrumentIdentityId: other.instrumentIdentityId,
        effectiveFrom: '2025-01-01',
        reasonCode: 'AUTHORITY_WITHDRAWAL',
      }),
      code('INSTRUMENT_ALIAS_REVOCATION_INVALID'),
    );
    assert.throws(
      () => buildInstrumentAliasRevocation({
        store,
        revokedAliasBindingCoreId: alias.aliasBindingCoreId,
        instrumentIdentityId: identity.instrumentIdentityId,
        effectiveFrom: '2024-04-01',
        reasonCode: 'AUTHORITY_WITHDRAWAL',
      }),
      code('INSTRUMENT_ALIAS_REVOCATION_INVALID'),
    );
    const rev = buildInstrumentAliasRevocation({
      store,
      revokedAliasBindingCoreId: alias.aliasBindingCoreId,
      instrumentIdentityId: identity.instrumentIdentityId,
      effectiveFrom: '2025-06-01',
      reasonCode: 'AUTHORITY_WITHDRAWAL',
    });
    const rev2 = buildInstrumentAliasRevocation({
      store,
      revokedAliasBindingCoreId: alias.aliasBindingCoreId,
      instrumentIdentityId: identity.instrumentIdentityId,
      effectiveFrom: '2025-07-01',
      reasonCode: 'DATA_CORRECTION',
    });
    assert.throws(
      () => buildInstrumentIdentityManifest({
        store,
        instrumentIdentityId: identity.instrumentIdentityId,
        aliasBindingCoreIds: [alias.aliasBindingCoreId],
        aliasRevocationCoreIds: [rev.aliasRevocationCoreId, rev2.aliasRevocationCoreId],
      }),
      code('INSTRUMENT_ALIAS_REVOCATION_INVALID'),
    );
    const manifest = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
      aliasRevocationCoreIds: [rev.aliasRevocationCoreId],
    });
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifest.identityManifestId],
    });
    assert.equal(resolve(store, registry.registryManifestId, ns, 'NEW', '2025-05-31').resolutionStatus, 'RESOLVED');
    assert.throws(
      () => resolve(store, registry.registryManifestId, ns, 'NEW', '2025-06-01'),
      code('INSTRUMENT_ALIAS_REVOKED'),
    );
    assert.throws(
      () => resolve(store, registry.registryManifestId, ns, 'NEW', '2025-12-01'),
      code('INSTRUMENT_ALIAS_REVOKED'),
    );
    assert.equal(
      verifyInstrumentAliasBinding({ store, aliasBindingCoreId: alias.aliasBindingCoreId }).aliasBindingCore.bindingStatus,
      'CONFIRMED',
    );
  });
});

// ─── CAS ────────────────────────────────────────────────────────────────────

test('L2B-C1 — corruption/deletion/wrong object/non-canonical/no overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-l2b-cas-'));
  try {
    const store = createContentAddressedStore({ root });
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_9);
    const uri = store.uriForObject({ namespace: 'snapshots', objectId: identity.instrumentIdentityId });
    const physical = join(root, ...uri.split('/'));
    const original = readFileSync(physical);

    writeFileSync(physical, Buffer.from(`${original.toString('utf8').slice(0, -2)}x\n`, 'utf8'));
    assert.throws(
      () => verifyInstrumentIdentity({ store, instrumentIdentityId: identity.instrumentIdentityId }),
      code('INSTRUMENT_REFERENCE_MISMATCH'),
    );
    writeFileSync(physical, original);

    unlinkSync(physical);
    assert.throws(
      () => verifyInstrumentIdentity({ store, instrumentIdentityId: identity.instrumentIdentityId }),
      code('INSTRUMENT_REFERENCE_MISSING'),
    );

    const restored = publishIdentity(store, auth.authorityPolicyId, SEED_9);
    assert.equal(restored.instrumentIdentityId, identity.instrumentIdentityId);

    assert.throws(
      () => store.putCanonicalObject({
        namespace: 'snapshots',
        schemaVersion: INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
        value: {
          schemaVersion: INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
          authorityPolicyId: auth.authorityPolicyId,
          identitySeed: SEED_9,
          instrumentKind: 'EQUITY',
          extra: true,
        },
      }),
      (error) => error instanceof CanonicalizationError && error.code === 'CANONICAL_UNKNOWN_FIELD',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L2B-C2 — namespace mismatch; lookup helpers; invalid inputs no TypeError', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const ns = publishNamespace(store);
    assert.equal(computeSymbolLookupKey(ns.namespacePolicy, 'abc'), 'ABC');
    assert.equal(verifySymbolNamespacePolicy({ store, namespacePolicyId: ns.namespacePolicyId }).namespacePolicy.providerId,
      'synth-provider-a');

    for (const api of [
      () => buildInstrumentIdentity(undefined),
      () => buildInstrumentIdentity(null),
      () => buildInstrumentIdentity({}),
      () => resolveInstrumentIdentityAsOf(undefined),
      () => resolveInstrumentIdentityAsOf(null),
      () => resolveInstrumentIdentityAsOf({}),
      () => buildInstrumentIdentityRegistry({ identityManifestIds: [] }),
      () => verifyInstrumentIdentityManifest({ store }),
    ]) {
      assert.throws(api, (error) => error && typeof error.code === 'string' && !(error instanceof TypeError));
    }
    void auth;
  });
});

// ─── End-to-end global (mission §20) ─────────────────────────────────────────

test('L2B-E2E — global registry rename, reuse, revocation, recovery and counter-tests', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identityA = publishIdentity(store, auth.authorityPolicyId, SEED_A, 'ETF');
    const recordA = buildInstrumentIdentityRecord({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      registeredAt: '2026-07-18T10:00:00Z',
      registrationAuthority: AUTHORITY,
      executionIdentity: EXEC,
    });
    const descriptorA = buildInstrumentDescriptor({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      legalName: 'E2E Instrument A',
      displayName: 'Instrument A',
      instrumentKind: 'ETF',
      domicileCountry: 'US',
      primaryCurrency: 'USD',
      status: 'ACTIVE',
    });
    const ns = publishNamespace(store);
    const aliasOld = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'OLD',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: '2024-05-01',
    });
    const aliasNew = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'NEW',
      currency: 'USD',
      validFrom: '2024-05-01',
      validToExclusive: null,
    });
    const providerA = buildProviderInstrumentBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      providerId: 'synth-provider-c',
      providerInstrumentId: 'prov-A-42',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const manifestA1 = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      identityRecordIds: [recordA.identityRecordId],
      descriptorCoreIds: [descriptorA.descriptorCoreId],
      aliasBindingCoreIds: [aliasOld.aliasBindingCoreId, aliasNew.aliasBindingCoreId],
      providerBindingCoreIds: [providerA.providerBindingCoreId],
    });
    const aliasSynth = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'SYNTH',
      currency: 'USD',
      validFrom: '2024-05-01',
      validToExclusive: '2026-01-01',
    });
    const manifestA2 = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      identityRecordIds: [recordA.identityRecordId],
      descriptorCoreIds: [descriptorA.descriptorCoreId],
      aliasBindingCoreIds: [
        aliasOld.aliasBindingCoreId, aliasNew.aliasBindingCoreId, aliasSynth.aliasBindingCoreId,
      ],
      providerBindingCoreIds: [providerA.providerBindingCoreId],
      supersedesManifestId: manifestA1.identityManifestId,
    });

    const identityB = publishIdentity(store, auth.authorityPolicyId, SEED_B, 'ETF');
    const aliasOldB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'OLD',
      currency: 'USD',
      validFrom: '2025-01-01',
      validToExclusive: null,
    });
    const manifestB = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasOldB.aliasBindingCoreId],
    });

    const { built } = buildSyntheticSnapshot(store, {
      coreOverrides: {
        canonicalSymbol: 'SYNTH',
        providerId: 'synth-provider-a',
        providerSymbol: 'SYNTH',
      },
    });
    const snapBind = buildDatasetSnapshotInstrumentBinding({
      store,
      snapshotCoreId: built.snapshotCore.objectId,
      instrumentIdentityId: identityA.instrumentIdentityId,
      aliasBindingCoreId: aliasSynth.aliasBindingCoreId,
      resolutionDate: '2025-01-15',
    });

    const r1 = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifestA2.identityManifestId, manifestB.identityManifestId],
      snapshotInstrumentBindingIds: [snapBind.snapshotInstrumentBindingId],
    });

    assert.equal(resolve(store, r1.registryManifestId, ns, 'OLD', '2023-12-31').instrumentIdentityId,
      identityA.instrumentIdentityId);
    assert.equal(resolve(store, r1.registryManifestId, ns, 'NEW', '2024-05-01').instrumentIdentityId,
      identityA.instrumentIdentityId);
    assert.equal(resolve(store, r1.registryManifestId, ns, 'OLD', '2025-06-01').instrumentIdentityId,
      identityB.instrumentIdentityId);

    const revNew = buildInstrumentAliasRevocation({
      store,
      revokedAliasBindingCoreId: aliasNew.aliasBindingCoreId,
      instrumentIdentityId: identityA.instrumentIdentityId,
      effectiveFrom: '2025-08-01',
      reasonCode: 'AUTHORITY_WITHDRAWAL',
    });
    const manifestA3 = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityA.instrumentIdentityId,
      identityRecordIds: [recordA.identityRecordId],
      descriptorCoreIds: [descriptorA.descriptorCoreId],
      aliasBindingCoreIds: [
        aliasOld.aliasBindingCoreId, aliasNew.aliasBindingCoreId, aliasSynth.aliasBindingCoreId,
      ],
      providerBindingCoreIds: [providerA.providerBindingCoreId],
      aliasRevocationCoreIds: [revNew.aliasRevocationCoreId],
      supersedesManifestId: manifestA2.identityManifestId,
    });
    const r2 = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [
        manifestA2.identityManifestId, manifestA3.identityManifestId, manifestB.identityManifestId,
      ],
      snapshotInstrumentBindingIds: [snapBind.snapshotInstrumentBindingId],
      supersedesRegistryManifestId: r1.registryManifestId,
    });

    assert.equal(resolve(store, r2.registryManifestId, ns, 'NEW', '2025-07-31').resolutionStatus, 'RESOLVED');
    assert.throws(
      () => resolve(store, r2.registryManifestId, ns, 'NEW', '2025-08-01'),
      code('INSTRUMENT_ALIAS_REVOKED'),
    );

    const recovered = recoverInstrumentIdentityRegistry({ store, registryManifestId: r2.registryManifestId });
    assert.equal(recovered.identityBundles.length, 2);
    assert.equal(recovered.snapshotBindings.length, 1);
    assert.equal(recovered.identityBundles[0].identityCore.identitySeed === SEED_A
      || recovered.identityBundles[1].identityCore.identitySeed === SEED_A, true);

    // Counter-tests
    const aliasConflict = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'NEW',
      currency: 'USD',
      validFrom: '2024-06-01',
      validToExclusive: '2025-08-01',
    });
    const manifestBConflict = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasOldB.aliasBindingCoreId, aliasConflict.aliasBindingCoreId],
      supersedesManifestId: manifestB.identityManifestId,
    });
    const r2Ids = [
      manifestA2.identityManifestId, manifestA3.identityManifestId, manifestB.identityManifestId,
    ];
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [...r2Ids, manifestBConflict.identityManifestId],
        snapshotInstrumentBindingIds: [snapBind.snapshotInstrumentBindingId],
        supersedesRegistryManifestId: r2.registryManifestId,
      }),
      code('INSTRUMENT_ALIAS_AMBIGUOUS'),
    );

    const providerB = buildProviderInstrumentBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      providerId: 'synth-provider-c',
      providerInstrumentId: 'prov-A-42',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const manifestBProv = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasOldB.aliasBindingCoreId],
      providerBindingCoreIds: [providerB.providerBindingCoreId],
      supersedesManifestId: manifestB.identityManifestId,
    });
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [...r2Ids, manifestBProv.identityManifestId],
        snapshotInstrumentBindingIds: [snapBind.snapshotInstrumentBindingId],
        supersedesRegistryManifestId: r2.registryManifestId,
      }),
      code('PROVIDER_INSTRUMENT_BINDING_AMBIGUOUS'),
    );

    const aliasSynthB = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'SYNTH',
      currency: 'USD',
      validFrom: '2026-01-01',
      validToExclusive: null,
    });
    const manifestBSynth = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreIds: [aliasOldB.aliasBindingCoreId, aliasSynthB.aliasBindingCoreId],
      supersedesManifestId: manifestB.identityManifestId,
    });
    const snapB = buildDatasetSnapshotInstrumentBinding({
      store,
      snapshotCoreId: built.snapshotCore.objectId,
      instrumentIdentityId: identityB.instrumentIdentityId,
      aliasBindingCoreId: aliasSynthB.aliasBindingCoreId,
      resolutionDate: '2026-06-01',
    });
    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [...r2Ids, manifestBSynth.identityManifestId],
        snapshotInstrumentBindingIds: [snapBind.snapshotInstrumentBindingId, snapB.snapshotInstrumentBindingId],
        supersedesRegistryManifestId: r2.registryManifestId,
      }),
      code('SNAPSHOT_INSTRUMENT_BINDING_CONFLICT'),
    );

    assert.throws(
      () => buildInstrumentIdentityManifest({
        store,
        instrumentIdentityId: identityA.instrumentIdentityId,
        identityRecordIds: [recordA.identityRecordId],
        descriptorCoreIds: [descriptorA.descriptorCoreId],
        aliasBindingCoreIds: [aliasOld.aliasBindingCoreId, aliasNew.aliasBindingCoreId],
        providerBindingCoreIds: [providerA.providerBindingCoreId],
        aliasRevocationCoreIds: [revNew.aliasRevocationCoreId],
        supersedesManifestId: manifestA3.identityManifestId,
      }),
      code('INSTRUMENT_IDENTITY_MANIFEST_INVALID'),
    );

    assert.throws(
      () => buildInstrumentIdentityRegistry({
        store,
        authorityPolicyId: auth.authorityPolicyId,
        identityManifestIds: [manifestA2.identityManifestId, manifestA3.identityManifestId],
        snapshotInstrumentBindingIds: [snapBind.snapshotInstrumentBindingId],
        supersedesRegistryManifestId: r2.registryManifestId,
      }),
      code('INSTRUMENT_IDENTITY_REGISTRY_INVALID'),
    );
  });
});

test('L2B-ID — ID-only recovery blocks on missing dependency', () => {
  withLabStore((store) => {
    const auth = publishAuthority(store);
    const identity = publishIdentity(store, auth.authorityPolicyId, SEED_C);
    const ns = publishNamespace(store);
    const alias = buildInstrumentAliasBinding({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: ns.namespacePolicyId,
      venueId: 'XNAS',
      symbol: 'ZZZ',
      currency: 'USD',
      validFrom: '2020-01-01',
      validToExclusive: null,
    });
    const manifest = buildInstrumentIdentityManifest({
      store,
      instrumentIdentityId: identity.instrumentIdentityId,
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
    });
    const registry = buildInstrumentIdentityRegistry({
      store,
      authorityPolicyId: auth.authorityPolicyId,
      identityManifestIds: [manifest.identityManifestId],
    });
    const recovered = recoverInstrumentIdentityRegistry({
      store, registryManifestId: registry.registryManifestId,
    });
    assert.equal(recovered.registryManifestId, registry.registryManifestId);
    assert.equal(recovered.identityBundles[0].aliases.length, 1);

    const uri = store.uriForObject({ namespace: 'snapshots', objectId: identity.instrumentIdentityId });
    const physical = join(store.root, ...uri.split('/'));
    unlinkSync(physical);
    assert.throws(
      () => recoverInstrumentIdentityRegistry({ store, registryManifestId: registry.registryManifestId }),
      code('INSTRUMENT_REFERENCE_MISSING'),
    );
  });
});
