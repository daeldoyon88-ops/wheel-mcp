/**
 * L2B additive snapshot ↔ instrument binding (L1/L2A cores untouched).
 */

import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
} from '../contracts/datasetSnapshotV1.mjs';
import {
  DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  InstrumentIdentityError,
  computeSymbolLookupKey,
  isDateInHalfOpenInterval,
  normalizeDatasetSnapshotInstrumentBindingV1,
} from '../contracts/instrumentIdentityV1.mjs';
import {
  assertBuildInput,
  assertObjectId,
  assertStore,
  putCanonical,
  readSnapshotObject,
} from './instrumentIdentityStore.mjs';
import {
  verifyInstrumentAliasBinding,
} from './instrumentIdentityBuildersCore.mjs';

/**
 * @param {{
 *   store: any,
 *   snapshotCoreId: string,
 *   instrumentIdentityId: string,
 *   aliasBindingCoreId: string,
 *   resolutionDate: string,
 * }} input
 */
export function buildDatasetSnapshotInstrumentBinding(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.snapshotCoreId, 'snapshotCoreId');
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  assertObjectId(input.aliasBindingCoreId, 'aliasBindingCoreId');

  const snapshotCore = readSnapshotObject(
    input.store, input.snapshotCoreId, DATASET_SNAPSHOT_CORE_SCHEMA_VERSION, 'snapshot core',
  );
  const { aliasBindingCore, namespacePolicy } = verifyInstrumentAliasBinding({
    store: input.store, aliasBindingCoreId: input.aliasBindingCoreId,
  });
  if (aliasBindingCore.instrumentIdentityId !== input.instrumentIdentityId) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'alias binding belongs to another instrument identity');
  }
  if (!isDateInHalfOpenInterval(input.resolutionDate, aliasBindingCore.validFrom, aliasBindingCore.validToExclusive)) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'resolutionDate is outside the alias binding interval');
  }
  if (snapshotCore.providerId !== aliasBindingCore.providerId
    || snapshotCore.providerId !== namespacePolicy.providerId) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'snapshot providerId does not match the alias binding');
  }
  const aliasLookup = computeSymbolLookupKey(namespacePolicy, aliasBindingCore.symbol);
  const snapshotCanonicalLookup = computeSymbolLookupKey(namespacePolicy, snapshotCore.canonicalSymbol);
  const snapshotProviderLookup = computeSymbolLookupKey(namespacePolicy, snapshotCore.providerSymbol);
  if (aliasLookup !== snapshotCanonicalLookup && aliasLookup !== snapshotProviderLookup) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'snapshot symbols do not match the alias binding under the namespace policy');
  }
  if (snapshotCore.providerSymbol !== aliasBindingCore.symbol
    && snapshotCore.canonicalSymbol !== aliasBindingCore.symbol) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'alias symbol must equal snapshot canonicalSymbol or providerSymbol');
  }

  const binding = normalizeDatasetSnapshotInstrumentBindingV1({
    schemaVersion: DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
    snapshotCoreId: input.snapshotCoreId,
    instrumentIdentityId: input.instrumentIdentityId,
    aliasBindingCoreId: input.aliasBindingCoreId,
    resolutionDate: input.resolutionDate,
    canonicalSymbolObserved: snapshotCore.canonicalSymbol,
    providerId: snapshotCore.providerId,
    providerSymbolObserved: snapshotCore.providerSymbol,
  });
  const stored = putCanonical(input.store, DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION, binding);
  return {
    snapshotInstrumentBindingId: stored.objectId,
    snapshotInstrumentBinding: stored.value,
    snapshotInstrumentBindingObject: stored,
    snapshotCore,
    aliasBindingCore,
  };
}

/** @param {{store: any, snapshotInstrumentBindingId: string}} input */
export function verifyDatasetSnapshotInstrumentBinding(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.snapshotInstrumentBindingId, 'snapshotInstrumentBindingId');
  const snapshotInstrumentBinding = readSnapshotObject(
    input.store,
    input.snapshotInstrumentBindingId,
    DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
    'snapshot instrument binding',
  );

  const snapshotCore = readSnapshotObject(
    input.store, snapshotInstrumentBinding.snapshotCoreId, DATASET_SNAPSHOT_CORE_SCHEMA_VERSION, 'snapshot core',
  );
  const { aliasBindingCore, namespacePolicy } = verifyInstrumentAliasBinding({
    store: input.store, aliasBindingCoreId: snapshotInstrumentBinding.aliasBindingCoreId,
  });
  if (aliasBindingCore.instrumentIdentityId !== snapshotInstrumentBinding.instrumentIdentityId) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'alias binding belongs to another instrument identity');
  }
  if (!isDateInHalfOpenInterval(
    snapshotInstrumentBinding.resolutionDate, aliasBindingCore.validFrom, aliasBindingCore.validToExclusive,
  )) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'resolutionDate is outside the alias binding interval');
  }
  if (snapshotCore.providerId !== aliasBindingCore.providerId
    || snapshotCore.providerId !== snapshotInstrumentBinding.providerId) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'snapshot providerId does not match the binding');
  }
  if (snapshotInstrumentBinding.canonicalSymbolObserved !== snapshotCore.canonicalSymbol
    || snapshotInstrumentBinding.providerSymbolObserved !== snapshotCore.providerSymbol) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'observed symbols diverge from the snapshot core');
  }
  const aliasLookup = computeSymbolLookupKey(namespacePolicy, aliasBindingCore.symbol);
  const snapshotCanonicalLookup = computeSymbolLookupKey(namespacePolicy, snapshotCore.canonicalSymbol);
  const snapshotProviderLookup = computeSymbolLookupKey(namespacePolicy, snapshotCore.providerSymbol);
  if (aliasLookup !== snapshotCanonicalLookup && aliasLookup !== snapshotProviderLookup) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'snapshot symbols do not match the alias binding under the namespace policy');
  }
  if (snapshotCore.providerSymbol !== aliasBindingCore.symbol
    && snapshotCore.canonicalSymbol !== aliasBindingCore.symbol) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'alias symbol must equal snapshot canonicalSymbol or providerSymbol');
  }

  const recomputed = normalizeDatasetSnapshotInstrumentBindingV1({
    schemaVersion: DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
    snapshotCoreId: snapshotInstrumentBinding.snapshotCoreId,
    instrumentIdentityId: snapshotInstrumentBinding.instrumentIdentityId,
    aliasBindingCoreId: snapshotInstrumentBinding.aliasBindingCoreId,
    resolutionDate: snapshotInstrumentBinding.resolutionDate,
    canonicalSymbolObserved: snapshotCore.canonicalSymbol,
    providerId: snapshotCore.providerId,
    providerSymbolObserved: snapshotCore.providerSymbol,
  });
  const uri = input.store.uriForObject({
    namespace: 'snapshots', objectId: input.snapshotInstrumentBindingId,
  });
  const reread = input.store.readCanonicalObject({
    uri,
    expectedObjectId: input.snapshotInstrumentBindingId,
    schemaVersion: DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  });
  if (JSON.stringify(reread.value) !== JSON.stringify(recomputed)) {
    throw new InstrumentIdentityError('SNAPSHOT_INSTRUMENT_BINDING_INVALID',
      'snapshot instrument binding failed deterministic recomputation');
  }

  return {
    snapshotInstrumentBindingId: input.snapshotInstrumentBindingId,
    snapshotInstrumentBinding,
    snapshotCore,
    aliasBindingCore,
  };
}
