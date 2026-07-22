/**
 * L4B-I1 series registry tests: genesis, append-only history, explicit
 * deprecation/replacement, conflicts, cycles, replay and multi-store.
 * All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_POLICY_VERSION,
  macroSeriesIdentityIdFor,
  normalizeMacroSeriesRegistryManifestV1,
  verifyMacroSeriesRegistryChainV1,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import {
  appendMacroSeriesRegistryManifest,
  buildMacroSeriesIdentityCore,
  buildMacroSeriesRegistryGenesis,
  verifyMacroSeriesIdentityCore,
  verifyMacroSeriesRegistryManifest,
} from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import {
  code,
  pinSyntheticSourceDocument,
  syntheticMacroSeriesIdentity,
  withMacroStore,
} from './macroIngestionL4BSyntheticFixture.mjs';

function entryFor(built, overrides = {}) {
  return {
    macroSeriesIdentityId: built.macroSeriesIdentityId,
    canonicalSeriesCode: built.macroSeriesIdentity.canonicalSeriesCode,
    status: 'ACTIVE',
    supersedesSeriesIdentityId: null,
    replacementReason: null,
    ...overrides,
  };
}

function wireRegistry(overrides = {}) {
  return {
    schemaVersion: MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
    registryPolicyVersion: MACRO_SERIES_REGISTRY_POLICY_VERSION,
    supersedesRegistryManifestId: null,
    orderedSeriesEntries: [],
    ...overrides,
  };
}

test('series identity build/verify round-trips through the store', () => {
  withMacroStore((store) => {
    const built = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const verified = verifyMacroSeriesIdentityCore({
      store, macroSeriesIdentityId: built.macroSeriesIdentityId,
    });
    assert.deepEqual(verified.macroSeriesIdentity, built.macroSeriesIdentity);
    assert.equal(built.macroSeriesIdentityId,
      macroSeriesIdentityIdFor(syntheticMacroSeriesIdentity('US.NYFED.EFFR')));
  });
});

test('two identical series identities produce the same pinned ID', () => {
  withMacroStore((store) => {
    const first = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.TREAS.DGS10'),
    });
    const second = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.TREAS.DGS10'),
    });
    assert.equal(first.macroSeriesIdentityId, second.macroSeriesIdentityId);
  });
});

test('a unit / seasonal-adjustment / frequency / methodology / convention / authority change produces a new series identity', () => {
  const base = macroSeriesIdentityIdFor(syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL'));
  const variants = [
    { units: 'PERCENT' },
    { seasonalAdjustment: 'NOT_SEASONALLY_ADJUSTED' },
    { frequency: 'WEEKLY' },
    { methodologyVersionId: `sha256:${'e'.repeat(64)}` },
    { observationConvention: 'PERIOD_END' },
    { sourceAuthority: 'FRED_ALFRED' },
  ];
  for (const overrides of variants) {
    const changed = macroSeriesIdentityIdFor(
      syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL', overrides));
    assert.notEqual(changed, base, JSON.stringify(overrides));
  }
});

test('empty genesis registry is valid, deterministic and verifiable', () => {
  withMacroStore((store) => {
    const genesis = buildMacroSeriesRegistryGenesis({ store, entries: [] });
    const verified = verifyMacroSeriesRegistryManifest({
      store, macroSeriesRegistryManifestId: genesis.macroSeriesRegistryManifestId,
    });
    assert.equal(verified.registry.orderedSeriesEntries.length, 0);
    assert.equal(verified.registry.supersedesRegistryManifestId, null);
  });
});

test('genesis with two authorities orders entries canonically regardless of insertion order', () => {
  const buildWith = (order) => withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const dgs10 = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.TREAS.DGS10'),
    });
    const entries = order === 'forward'
      ? [entryFor(effr), entryFor(dgs10)] : [entryFor(dgs10), entryFor(effr)];
    return buildMacroSeriesRegistryGenesis({ store, entries }).macroSeriesRegistryManifestId;
  });
  assert.equal(buildWith('forward'), buildWith('reverse'));
});

test('append preserves history, adds a series and re-verifies from genesis', () => {
  withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const genesis = buildMacroSeriesRegistryGenesis({ store, entries: [entryFor(effr)] });
    const cpi = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL'),
    });
    const appended = appendMacroSeriesRegistryManifest({
      store,
      baseRegistryManifestId: genesis.macroSeriesRegistryManifestId,
      newEntries: [entryFor(cpi)],
      statusTransitions: [],
    });
    const verified = verifyMacroSeriesRegistryManifest({
      store, macroSeriesRegistryManifestId: appended.macroSeriesRegistryManifestId,
    });
    assert.equal(verified.registry.orderedSeriesEntries.length, 2);
    assert.equal(verified.registryChain.length, 2);
    assert.equal(verified.registry.supersedesRegistryManifestId,
      genesis.macroSeriesRegistryManifestId);
  });
});

test('explicit deprecation is the only permitted historical status change', () => {
  withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const genesis = buildMacroSeriesRegistryGenesis({ store, entries: [entryFor(effr)] });
    const deprecated = appendMacroSeriesRegistryManifest({
      store,
      baseRegistryManifestId: genesis.macroSeriesRegistryManifestId,
      newEntries: [],
      statusTransitions: [{
        macroSeriesIdentityId: effr.macroSeriesIdentityId, status: 'DEPRECATED',
      }],
    });
    const verified = verifyMacroSeriesRegistryManifest({
      store, macroSeriesRegistryManifestId: deprecated.macroSeriesRegistryManifestId,
    });
    assert.equal(verified.registry.orderedSeriesEntries[0].status, 'DEPRECATED');
  });
});

test('explicit replacement (methodology change) links old and new identities', () => {
  withMacroStore((store) => {
    const cpiV1 = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL'),
    });
    const genesis = buildMacroSeriesRegistryGenesis({ store, entries: [entryFor(cpiV1)] });
    const cpiV2 = buildMacroSeriesIdentityCore({
      store,
      identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL', {
        methodologyVersionId: `sha256:${'f'.repeat(64)}`,
      }),
    });
    const replaced = appendMacroSeriesRegistryManifest({
      store,
      baseRegistryManifestId: genesis.macroSeriesRegistryManifestId,
      newEntries: [entryFor(cpiV2, {
        supersedesSeriesIdentityId: cpiV1.macroSeriesIdentityId,
        replacementReason: 'METHODOLOGY_CHANGE',
      })],
      statusTransitions: [{
        macroSeriesIdentityId: cpiV1.macroSeriesIdentityId, status: 'REPLACED',
      }],
    });
    const verified = verifyMacroSeriesRegistryManifest({
      store, macroSeriesRegistryManifestId: replaced.macroSeriesRegistryManifestId,
    });
    const active = verified.registry.orderedSeriesEntries
      .filter((entry) => entry.status === 'ACTIVE');
    assert.equal(active.length, 1);
    assert.equal(active[0].macroSeriesIdentityId, cpiV2.macroSeriesIdentityId);
  });
});

test('two ACTIVE tips for one canonical code are refused', () => {
  withMacroStore((store) => {
    const cpiV1 = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL'),
    });
    const cpiV2 = buildMacroSeriesIdentityCore({
      store,
      identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL', {
        methodologyVersionId: `sha256:${'f'.repeat(64)}`,
      }),
    });
    assert.throws(() => buildMacroSeriesRegistryGenesis({
      store, entries: [entryFor(cpiV1), entryFor(cpiV2)],
    }), code('MARKET_DATA_MACRO_SERIES_DUPLICATE_ACTIVE_CODE'));
  });
});

test('duplicate series identity in one registry is refused', () => {
  withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    assert.throws(() => buildMacroSeriesRegistryGenesis({
      store, entries: [entryFor(effr), entryFor(effr)],
    }), code('MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID'));
  });
});

test('entry code diverging from the pinned identity is refused', () => {
  withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    assert.throws(() => buildMacroSeriesRegistryGenesis({
      store, entries: [entryFor(effr, { canonicalSeriesCode: 'US.NYFED.SOFR' })],
    }), code('MARKET_DATA_MACRO_SERIES_REFERENCE_MISMATCH'));
  });
});

test('self-replacement is refused as a registry cycle', () => {
  const id = macroSeriesIdentityIdFor(syntheticMacroSeriesIdentity('US.NYFED.EFFR'));
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: [{
      macroSeriesIdentityId: id,
      canonicalSeriesCode: 'US.NYFED.EFFR',
      status: 'REPLACED',
      supersedesSeriesIdentityId: id,
      replacementReason: 'METHODOLOGY_CHANGE',
    }],
  })), code('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE'));
});

function replacementRing(ids, codes) {
  return ids.map((id, index) => ({
    macroSeriesIdentityId: id,
    canonicalSeriesCode: codes[index],
    status: 'REPLACED',
    supersedesSeriesIdentityId: ids[(index + 1) % ids.length],
    replacementReason: 'METHODOLOGY_CHANGE',
  })).sort((a, b) => (a.canonicalSeriesCode < b.canonicalSeriesCode ? -1 : 1));
}

test('replacement cycles of length 2 and 3 are refused deterministically', () => {
  const ids = ['a', 'b', 'c'].map((c) => `sha256:${c.repeat(64)}`);
  const codes = ['US.NYFED.EFFR', 'US.NYFED.SOFR', 'US.TREAS.DGS10'];
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: replacementRing(ids.slice(0, 2), codes.slice(0, 2)),
  })), code('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE'));
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: replacementRing(ids, codes),
  })), code('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE'));
});

test('cycle detection is insertion-order independent', () => {
  const ids = ['a', 'b'].map((c) => `sha256:${c.repeat(64)}`);
  const codes = ['US.NYFED.EFFR', 'US.NYFED.SOFR'];
  const forward = replacementRing(ids, codes);
  const reversed = replacementRing([ids[1], ids[0]], [codes[1], codes[0]]);
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: forward,
  })), code('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE'));
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: reversed,
  })), code('MARKET_DATA_MACRO_SERIES_REGISTRY_CYCLE'));
});

test('replacement referencing an absent identity is refused', () => {
  const id = `sha256:${'a'.repeat(64)}`;
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: [{
      macroSeriesIdentityId: id,
      canonicalSeriesCode: 'US.NYFED.EFFR',
      status: 'ACTIVE',
      supersedesSeriesIdentityId: `sha256:${'b'.repeat(64)}`,
      replacementReason: 'METHODOLOGY_CHANGE',
    }],
  })), code('MARKET_DATA_MACRO_SERIES_REFERENCE_MISMATCH'));
});

test('two series replacing the same identity (concurrent branch) are refused', () => {
  const target = `sha256:${'a'.repeat(64)}`;
  const entries = [
    {
      macroSeriesIdentityId: target,
      canonicalSeriesCode: 'US.NYFED.EFFR',
      status: 'REPLACED',
      supersedesSeriesIdentityId: null,
      replacementReason: null,
    },
    {
      macroSeriesIdentityId: `sha256:${'b'.repeat(64)}`,
      canonicalSeriesCode: 'US.NYFED.SOFR',
      status: 'ACTIVE',
      supersedesSeriesIdentityId: target,
      replacementReason: 'METHODOLOGY_CHANGE',
    },
    {
      macroSeriesIdentityId: `sha256:${'c'.repeat(64)}`,
      canonicalSeriesCode: 'US.TREAS.DGS10',
      status: 'ACTIVE',
      supersedesSeriesIdentityId: target,
      replacementReason: 'METHODOLOGY_CHANGE',
    },
  ];
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: entries,
  })), code('MARKET_DATA_MACRO_SERIES_REGISTRY_CONFLICT'));
});

test('mis-ordered wire entries are refused (order is part of the contract)', () => {
  const entries = [
    {
      macroSeriesIdentityId: `sha256:${'b'.repeat(64)}`,
      canonicalSeriesCode: 'US.NYFED.SOFR',
      status: 'ACTIVE',
      supersedesSeriesIdentityId: null,
      replacementReason: null,
    },
    {
      macroSeriesIdentityId: `sha256:${'a'.repeat(64)}`,
      canonicalSeriesCode: 'US.NYFED.EFFR',
      status: 'ACTIVE',
      supersedesSeriesIdentityId: null,
      replacementReason: null,
    },
  ];
  assert.throws(() => normalizeMacroSeriesRegistryManifestV1(wireRegistry({
    orderedSeriesEntries: entries,
  })), code('MARKET_DATA_MACRO_SERIES_REGISTRY_INVALID'));
});

function chainStub(registries) {
  return registries.map((registry, index) => ({
    registryManifestId: `sha256:${String(index).repeat(64).slice(0, 64)}`,
    registry,
  }));
}

function stubEntry(letter, codeName, overrides = {}) {
  return {
    macroSeriesIdentityId: `sha256:${letter.repeat(64)}`,
    canonicalSeriesCode: codeName,
    status: 'ACTIVE',
    supersedesSeriesIdentityId: null,
    replacementReason: null,
    ...overrides,
  };
}

test('append-only chain: removing a historical entry is refused', () => {
  const parent = wireRegistry({
    orderedSeriesEntries: [stubEntry('a', 'US.NYFED.EFFR'), stubEntry('b', 'US.NYFED.SOFR')],
  });
  const child = wireRegistry({
    supersedesRegistryManifestId: `sha256:${'0'.repeat(64)}`,
    orderedSeriesEntries: [stubEntry('a', 'US.NYFED.EFFR')],
  });
  assert.throws(() => verifyMacroSeriesRegistryChainV1(chainStub([parent, child])),
    code('MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION'));
});

test('append-only chain: mutating a historical entry is refused', () => {
  const parent = wireRegistry({ orderedSeriesEntries: [stubEntry('a', 'US.NYFED.EFFR')] });
  const child = wireRegistry({
    supersedesRegistryManifestId: `sha256:${'0'.repeat(64)}`,
    orderedSeriesEntries: [stubEntry('a', 'US.NYFED.SOFR')],
  });
  assert.throws(() => verifyMacroSeriesRegistryChainV1(chainStub([parent, child])),
    code('MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION'));
});

test('append-only chain: resurrecting a DEPRECATED or REPLACED series is refused', () => {
  for (const status of ['DEPRECATED']) {
    const parent = wireRegistry({
      orderedSeriesEntries: [stubEntry('a', 'US.NYFED.EFFR', { status })],
    });
    const child = wireRegistry({
      supersedesRegistryManifestId: `sha256:${'0'.repeat(64)}`,
      orderedSeriesEntries: [stubEntry('a', 'US.NYFED.EFFR', { status: 'ACTIVE' })],
    });
    assert.throws(() => verifyMacroSeriesRegistryChainV1(chainStub([parent, child])),
      code('MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION'));
  }
});

test('append-only chain: child must reference its immediate parent', () => {
  const parent = wireRegistry({ orderedSeriesEntries: [stubEntry('a', 'US.NYFED.EFFR')] });
  const child = wireRegistry({
    supersedesRegistryManifestId: `sha256:${'9'.repeat(64)}`,
    orderedSeriesEntries: [stubEntry('a', 'US.NYFED.EFFR')],
  });
  assert.throws(() => verifyMacroSeriesRegistryChainV1(chainStub([parent, child])),
    code('MARKET_DATA_MACRO_SERIES_REGISTRY_APPEND_ONLY_VIOLATION'));
});

test('registry supersession pointing to a missing parent is refused at verification', () => {
  withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    assert.throws(() => appendMacroSeriesRegistryManifest({
      store,
      baseRegistryManifestId: `sha256:${'d'.repeat(64)}`,
      newEntries: [entryFor(effr)],
      statusTransitions: [],
    }), code('MARKET_DATA_REFERENCE_MISSING'));
  });
});

test('registry replay: same inputs produce identical bytes and IDs in two stores', () => {
  const build = () => withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const cpi = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL'),
    });
    const genesis = buildMacroSeriesRegistryGenesis({
      store, entries: [entryFor(cpi), entryFor(effr)],
    });
    return {
      id: genesis.macroSeriesRegistryManifestId,
      bytes: canonicalJsonBytes(genesis.registry).toString('hex'),
    };
  });
  const first = build();
  const second = build();
  assert.equal(first.id, second.id);
  assert.equal(first.bytes, second.bytes);
});

test('registry verification ignores unrelated CAS noise', () => {
  withMacroStore((store) => {
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const genesis = buildMacroSeriesRegistryGenesis({ store, entries: [entryFor(effr)] });
    pinSyntheticSourceDocument(store, 'noise-1');
    pinSyntheticSourceDocument(store, 'noise-2');
    buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.TREAS.DGS10'),
    });
    const verified = verifyMacroSeriesRegistryManifest({
      store, macroSeriesRegistryManifestId: genesis.macroSeriesRegistryManifestId,
    });
    assert.deepEqual(verified.registry, genesis.registry);
  });
});
