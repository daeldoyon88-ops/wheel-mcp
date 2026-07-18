/**
 * L2B core builders for authority, identity, descriptors, namespaces,
 * aliases, provider bindings and revocations. No re-exports (avoids cycles).
 */

import {
  INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION,
  INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION,
  INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
  INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION,
  InstrumentIdentityError,
  PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION,
  PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION,
  SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION,
  computeSymbolLookupKey,
  identitySeedProblems,
  isDateInHalfOpenInterval,
  namespacePolicyBindingProblems,
  normalizeInstrumentAliasBindingCoreV1,
  normalizeInstrumentAliasRevocationCoreV1,
  normalizeInstrumentDescriptorCoreV1,
  normalizeInstrumentIdentityAuthorityPolicyV1,
  normalizeInstrumentIdentityCoreV1,
  normalizeInstrumentIdentityRecordV1,
  normalizeProviderInstrumentBindingCoreV1,
  normalizeProviderInstrumentRevocationCoreV1,
  normalizeSymbolNamespacePolicyV1,
} from '../contracts/instrumentIdentityV1.mjs';
import {
  assertBuildInput,
  assertObjectId,
  assertStore,
  putCanonical,
  readSnapshotObject,
} from './instrumentIdentityStore.mjs';

// ─── Authority policy ───────────────────────────────────────────────────────

/**
 * @param {{
 *   store: any,
 *   authorityId: string,
 *   identitySeedFormat?: string,
 *   identitySeedLength?: number,
 * }} input
 */
export function buildInstrumentIdentityAuthorityPolicy(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  const policy = normalizeInstrumentIdentityAuthorityPolicyV1({
    schemaVersion: INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION,
    authorityId: input.authorityId,
    identitySeedFormat: input.identitySeedFormat ?? 'HEX_LOWERCASE',
    identitySeedLength: input.identitySeedLength ?? 64,
  });
  const stored = putCanonical(input.store, INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION, policy);
  return {
    authorityPolicyId: stored.objectId,
    authorityPolicy: stored.value,
    authorityPolicyObject: stored,
  };
}

/** @param {{store: any, authorityPolicyId: string}} input */
export function verifyInstrumentIdentityAuthorityPolicy(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.authorityPolicyId, 'authorityPolicyId');
  const authorityPolicy = readSnapshotObject(
    input.store, input.authorityPolicyId, INSTRUMENT_IDENTITY_AUTHORITY_POLICY_SCHEMA_VERSION, 'authority policy',
  );
  return { authorityPolicyId: input.authorityPolicyId, authorityPolicy };
}

// ─── Identity core / record ─────────────────────────────────────────────────

/**
 * @param {{
 *   store: any,
 *   authorityPolicyId: string,
 *   identitySeed: string,
 *   instrumentKind: string,
 * }} input
 */
export function buildInstrumentIdentity(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.authorityPolicyId, 'authorityPolicyId');
  const { authorityPolicy } = verifyInstrumentIdentityAuthorityPolicy({
    store: input.store, authorityPolicyId: input.authorityPolicyId,
  });
  const seedProblems = identitySeedProblems(authorityPolicy, input.identitySeed);
  if (seedProblems.length > 0) {
    throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_INVALID', seedProblems.join('; '), { problems: seedProblems });
  }
  const core = normalizeInstrumentIdentityCoreV1({
    schemaVersion: INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION,
    authorityPolicyId: input.authorityPolicyId,
    identitySeed: input.identitySeed,
    instrumentKind: input.instrumentKind,
  });
  const stored = putCanonical(input.store, INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION, core);
  return {
    instrumentIdentityId: stored.objectId,
    identityCore: stored.value,
    identityCoreObject: stored,
    authorityPolicy,
  };
}

/** @param {{store: any, instrumentIdentityId: string}} input */
export function verifyInstrumentIdentity(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  const identityCore = readSnapshotObject(
    input.store, input.instrumentIdentityId, INSTRUMENT_IDENTITY_CORE_SCHEMA_VERSION, 'instrument identity core',
  );
  const { authorityPolicy } = verifyInstrumentIdentityAuthorityPolicy({
    store: input.store, authorityPolicyId: identityCore.authorityPolicyId,
  });
  const seedProblems = identitySeedProblems(authorityPolicy, identityCore.identitySeed);
  if (seedProblems.length > 0) {
    throw new InstrumentIdentityError('INSTRUMENT_IDENTITY_INVALID', seedProblems.join('; '), { problems: seedProblems });
  }
  return { instrumentIdentityId: input.instrumentIdentityId, identityCore, authorityPolicy };
}

/**
 * @param {{
 *   store: any,
 *   instrumentIdentityId: string,
 *   registeredAt: string,
 *   registrationAuthority: string,
 *   executionIdentity: {runnerId: string, runId: string|null, environment: string},
 * }} input
 */
export function buildInstrumentIdentityRecord(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: input.instrumentIdentityId });
  const record = normalizeInstrumentIdentityRecordV1({
    schemaVersion: INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION,
    instrumentIdentityId: input.instrumentIdentityId,
    registeredAt: input.registeredAt,
    registrationAuthority: input.registrationAuthority,
    executionIdentity: input.executionIdentity,
  });
  const stored = putCanonical(input.store, INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION, record);
  return {
    identityRecordId: stored.objectId,
    identityRecord: stored.value,
    identityRecordObject: stored,
  };
}

/** @param {{store: any, identityRecordId: string}} input */
export function verifyInstrumentIdentityRecord(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.identityRecordId, 'identityRecordId');
  const identityRecord = readSnapshotObject(
    input.store, input.identityRecordId, INSTRUMENT_IDENTITY_RECORD_SCHEMA_VERSION, 'instrument identity record',
  );
  verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: identityRecord.instrumentIdentityId });
  return { identityRecordId: input.identityRecordId, identityRecord };
}

// ─── Descriptor ─────────────────────────────────────────────────────────────

/**
 * @param {{
 *   store: any,
 *   instrumentIdentityId: string,
 *   legalName: string,
 *   displayName: string,
 *   instrumentKind: string,
 *   domicileCountry: string,
 *   primaryCurrency: string,
 *   status: string,
 * }} input
 */
export function buildInstrumentDescriptor(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  const { identityCore } = verifyInstrumentIdentity({
    store: input.store, instrumentIdentityId: input.instrumentIdentityId,
  });
  if (input.instrumentKind !== identityCore.instrumentKind) {
    throw new InstrumentIdentityError('INSTRUMENT_DESCRIPTOR_KIND_MISMATCH',
      'descriptor instrumentKind does not match identity core');
  }
  const descriptor = normalizeInstrumentDescriptorCoreV1({
    schemaVersion: INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION,
    instrumentIdentityId: input.instrumentIdentityId,
    legalName: input.legalName,
    displayName: input.displayName,
    instrumentKind: input.instrumentKind,
    domicileCountry: input.domicileCountry,
    primaryCurrency: input.primaryCurrency,
    status: input.status,
  });
  const stored = putCanonical(input.store, INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION, descriptor);
  return {
    descriptorCoreId: stored.objectId,
    descriptorCore: stored.value,
    descriptorCoreObject: stored,
  };
}

/** @param {{store: any, descriptorCoreId: string}} input */
export function verifyInstrumentDescriptor(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.descriptorCoreId, 'descriptorCoreId');
  const descriptorCore = readSnapshotObject(
    input.store, input.descriptorCoreId, INSTRUMENT_DESCRIPTOR_CORE_SCHEMA_VERSION, 'instrument descriptor',
  );
  const { identityCore } = verifyInstrumentIdentity({
    store: input.store, instrumentIdentityId: descriptorCore.instrumentIdentityId,
  });
  if (descriptorCore.instrumentKind !== identityCore.instrumentKind) {
    throw new InstrumentIdentityError('INSTRUMENT_DESCRIPTOR_KIND_MISMATCH',
      'descriptor instrumentKind does not match identity core');
  }
  return { descriptorCoreId: input.descriptorCoreId, descriptorCore, identityCore };
}

// ─── Namespace policy ───────────────────────────────────────────────────────

/**
 * @param {{
 *   store: any,
 *   namespaceId: string,
 *   namespaceVersion: number,
 *   providerId: string,
 *   venuePolicy: string,
 *   casePolicy: string,
 *   allowedCharacterPolicy?: string,
 *   currencyPolicy: string,
 * }} input
 */
export function buildSymbolNamespacePolicy(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  const policy = normalizeSymbolNamespacePolicyV1({
    schemaVersion: SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION,
    namespaceId: input.namespaceId,
    namespaceVersion: input.namespaceVersion,
    providerId: input.providerId,
    venuePolicy: input.venuePolicy,
    casePolicy: input.casePolicy,
    allowedCharacterPolicy: input.allowedCharacterPolicy ?? 'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
    currencyPolicy: input.currencyPolicy,
  });
  const stored = putCanonical(input.store, SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION, policy);
  return {
    namespacePolicyId: stored.objectId,
    namespacePolicy: stored.value,
    namespacePolicyObject: stored,
  };
}

/** @param {{store: any, namespacePolicyId: string}} input */
export function verifySymbolNamespacePolicy(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.namespacePolicyId, 'namespacePolicyId');
  const namespacePolicy = readSnapshotObject(
    input.store, input.namespacePolicyId, SYMBOL_NAMESPACE_POLICY_SCHEMA_VERSION, 'symbol namespace policy',
  );
  return { namespacePolicyId: input.namespacePolicyId, namespacePolicy };
}

// ─── Alias binding ──────────────────────────────────────────────────────────

/**
 * @param {{
 *   store: any,
 *   instrumentIdentityId: string,
 *   namespacePolicyId: string,
 *   venueId: string|null,
 *   symbol: string,
 *   currency: string|null,
 *   validFrom: string,
 *   validToExclusive: string|null,
 *   bindingStatus?: string,
 *   symbolLookupKey?: string,
 * }} input
 */
export function buildInstrumentAliasBinding(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  assertObjectId(input.namespacePolicyId, 'namespacePolicyId');
  verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: input.instrumentIdentityId });
  const { namespacePolicy } = verifySymbolNamespacePolicy({
    store: input.store, namespacePolicyId: input.namespacePolicyId,
  });

  const policyProblems = namespacePolicyBindingProblems(namespacePolicy, {
    providerId: namespacePolicy.providerId,
    venueId: input.venueId,
    currency: input.currency,
  });
  if (policyProblems.length > 0) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID', policyProblems.join('; '), { problems: policyProblems });
  }

  const computedLookupKey = computeSymbolLookupKey(namespacePolicy, input.symbol);
  if (input.symbolLookupKey !== undefined && input.symbolLookupKey !== computedLookupKey) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID',
      'symbolLookupKey does not match namespace policy derivation', {
        provided: input.symbolLookupKey,
        expected: computedLookupKey,
      });
  }

  const binding = normalizeInstrumentAliasBindingCoreV1({
    schemaVersion: INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION,
    instrumentIdentityId: input.instrumentIdentityId,
    namespacePolicyId: input.namespacePolicyId,
    providerId: namespacePolicy.providerId,
    venueId: input.venueId,
    symbol: input.symbol,
    symbolLookupKey: computedLookupKey,
    currency: input.currency,
    validFrom: input.validFrom,
    validToExclusive: input.validToExclusive,
    bindingStatus: input.bindingStatus ?? 'CONFIRMED',
  });
  const stored = putCanonical(input.store, INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION, binding);
  return {
    aliasBindingCoreId: stored.objectId,
    aliasBindingCore: stored.value,
    aliasBindingCoreObject: stored,
    namespacePolicy,
  };
}

/** @param {{store: any, aliasBindingCoreId: string}} input */
export function verifyInstrumentAliasBinding(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.aliasBindingCoreId, 'aliasBindingCoreId');
  const aliasBindingCore = readSnapshotObject(
    input.store, input.aliasBindingCoreId, INSTRUMENT_ALIAS_BINDING_CORE_SCHEMA_VERSION, 'alias binding',
  );
  verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: aliasBindingCore.instrumentIdentityId });
  const { namespacePolicy } = verifySymbolNamespacePolicy({
    store: input.store, namespacePolicyId: aliasBindingCore.namespacePolicyId,
  });
  if (aliasBindingCore.providerId !== namespacePolicy.providerId) {
    throw new InstrumentIdentityError('SYMBOL_NAMESPACE_MISMATCH',
      'alias binding providerId does not match namespace policy');
  }
  const policyProblems = namespacePolicyBindingProblems(namespacePolicy, aliasBindingCore);
  if (policyProblems.length > 0) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID', policyProblems.join('; '), { problems: policyProblems });
  }
  const expectedKey = computeSymbolLookupKey(namespacePolicy, aliasBindingCore.symbol);
  if (aliasBindingCore.symbolLookupKey !== expectedKey) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID',
      'stored symbolLookupKey does not match namespace policy derivation');
  }
  try {
    isDateInHalfOpenInterval(aliasBindingCore.validFrom, aliasBindingCore.validFrom, aliasBindingCore.validToExclusive);
  } catch (error) {
    if (error instanceof InstrumentIdentityError) throw error;
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INTERVAL_INVALID', 'alias interval is invalid');
  }
  return { aliasBindingCoreId: input.aliasBindingCoreId, aliasBindingCore, namespacePolicy };
}

// ─── Provider binding ───────────────────────────────────────────────────────

/**
 * @param {{
 *   store: any,
 *   instrumentIdentityId: string,
 *   providerId: string,
 *   providerInstrumentId: string,
 *   validFrom: string,
 *   validToExclusive: string|null,
 *   status?: string,
 * }} input
 */
export function buildProviderInstrumentBinding(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: input.instrumentIdentityId });
  const binding = normalizeProviderInstrumentBindingCoreV1({
    schemaVersion: PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION,
    instrumentIdentityId: input.instrumentIdentityId,
    providerId: input.providerId,
    providerInstrumentId: input.providerInstrumentId,
    validFrom: input.validFrom,
    validToExclusive: input.validToExclusive,
    status: input.status ?? 'ACTIVE',
  });
  const stored = putCanonical(input.store, PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION, binding);
  return {
    providerBindingCoreId: stored.objectId,
    providerBindingCore: stored.value,
    providerBindingCoreObject: stored,
  };
}

/** @param {{store: any, providerBindingCoreId: string}} input */
export function verifyProviderInstrumentBinding(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.providerBindingCoreId, 'providerBindingCoreId');
  const providerBindingCore = readSnapshotObject(
    input.store, input.providerBindingCoreId, PROVIDER_INSTRUMENT_BINDING_CORE_SCHEMA_VERSION, 'provider binding',
  );
  verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: providerBindingCore.instrumentIdentityId });
  try {
    isDateInHalfOpenInterval(
      providerBindingCore.validFrom, providerBindingCore.validFrom, providerBindingCore.validToExclusive,
    );
  } catch (error) {
    if (error instanceof InstrumentIdentityError) throw error;
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INTERVAL_INVALID', 'provider binding interval is invalid');
  }
  return { providerBindingCoreId: input.providerBindingCoreId, providerBindingCore };
}

// ─── Explicit revocations ───────────────────────────────────────────────────

/**
 * @param {{
 *   store: any,
 *   revokedAliasBindingCoreId: string,
 *   instrumentIdentityId: string,
 *   effectiveFrom: string,
 *   reasonCode: string,
 * }} input
 */
export function buildInstrumentAliasRevocation(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.revokedAliasBindingCoreId, 'revokedAliasBindingCoreId');
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  const { aliasBindingCore } = verifyInstrumentAliasBinding({
    store: input.store, aliasBindingCoreId: input.revokedAliasBindingCoreId,
  });
  if (aliasBindingCore.instrumentIdentityId !== input.instrumentIdentityId) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_REVOCATION_INVALID',
      'revocation targets a binding of another instrument identity');
  }
  if (typeof input.effectiveFrom !== 'string' || input.effectiveFrom < aliasBindingCore.validFrom) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_REVOCATION_INVALID',
      'effectiveFrom cannot precede binding validFrom');
  }
  const revocation = normalizeInstrumentAliasRevocationCoreV1({
    schemaVersion: INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION,
    revokedAliasBindingCoreId: input.revokedAliasBindingCoreId,
    instrumentIdentityId: input.instrumentIdentityId,
    effectiveFrom: input.effectiveFrom,
    reasonCode: input.reasonCode,
  });
  const stored = putCanonical(input.store, INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION, revocation);
  return {
    aliasRevocationCoreId: stored.objectId,
    aliasRevocationCore: stored.value,
    aliasRevocationCoreObject: stored,
  };
}

/** @param {{store: any, aliasRevocationCoreId: string}} input */
export function verifyInstrumentAliasRevocation(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.aliasRevocationCoreId, 'aliasRevocationCoreId');
  const aliasRevocationCore = readSnapshotObject(
    input.store, input.aliasRevocationCoreId, INSTRUMENT_ALIAS_REVOCATION_CORE_SCHEMA_VERSION, 'alias revocation',
  );
  const { aliasBindingCore } = verifyInstrumentAliasBinding({
    store: input.store, aliasBindingCoreId: aliasRevocationCore.revokedAliasBindingCoreId,
  });
  if (aliasBindingCore.instrumentIdentityId !== aliasRevocationCore.instrumentIdentityId) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_REVOCATION_INVALID',
      'revocation identity does not match revoked binding');
  }
  if (aliasRevocationCore.effectiveFrom < aliasBindingCore.validFrom) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_REVOCATION_INVALID',
      'effectiveFrom cannot precede binding validFrom');
  }
  return { aliasRevocationCoreId: input.aliasRevocationCoreId, aliasRevocationCore, aliasBindingCore };
}

/**
 * @param {{
 *   store: any,
 *   revokedProviderBindingCoreId: string,
 *   instrumentIdentityId: string,
 *   effectiveFrom: string,
 *   reasonCode: string,
 * }} input
 */
export function buildProviderInstrumentRevocation(input) {
  assertBuildInput(input);
  assertStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  assertObjectId(input.revokedProviderBindingCoreId, 'revokedProviderBindingCoreId');
  assertObjectId(input.instrumentIdentityId, 'instrumentIdentityId');
  const { providerBindingCore } = verifyProviderInstrumentBinding({
    store: input.store, providerBindingCoreId: input.revokedProviderBindingCoreId,
  });
  if (providerBindingCore.instrumentIdentityId !== input.instrumentIdentityId) {
    throw new InstrumentIdentityError('PROVIDER_INSTRUMENT_REVOCATION_INVALID',
      'revocation targets a binding of another instrument identity');
  }
  if (typeof input.effectiveFrom !== 'string' || input.effectiveFrom < providerBindingCore.validFrom) {
    throw new InstrumentIdentityError('PROVIDER_INSTRUMENT_REVOCATION_INVALID',
      'effectiveFrom cannot precede binding validFrom');
  }
  const revocation = normalizeProviderInstrumentRevocationCoreV1({
    schemaVersion: PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION,
    revokedProviderBindingCoreId: input.revokedProviderBindingCoreId,
    instrumentIdentityId: input.instrumentIdentityId,
    effectiveFrom: input.effectiveFrom,
    reasonCode: input.reasonCode,
  });
  const stored = putCanonical(input.store, PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION, revocation);
  return {
    providerRevocationCoreId: stored.objectId,
    providerRevocationCore: stored.value,
    providerRevocationCoreObject: stored,
  };
}

/** @param {{store: any, providerRevocationCoreId: string}} input */
export function verifyProviderInstrumentRevocation(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);
  assertObjectId(input.providerRevocationCoreId, 'providerRevocationCoreId');
  const providerRevocationCore = readSnapshotObject(
    input.store, input.providerRevocationCoreId,
    PROVIDER_INSTRUMENT_REVOCATION_CORE_SCHEMA_VERSION, 'provider revocation',
  );
  const { providerBindingCore } = verifyProviderInstrumentBinding({
    store: input.store, providerBindingCoreId: providerRevocationCore.revokedProviderBindingCoreId,
  });
  if (providerBindingCore.instrumentIdentityId !== providerRevocationCore.instrumentIdentityId) {
    throw new InstrumentIdentityError('PROVIDER_INSTRUMENT_REVOCATION_INVALID',
      'revocation identity does not match revoked binding');
  }
  if (providerRevocationCore.effectiveFrom < providerBindingCore.validFrom) {
    throw new InstrumentIdentityError('PROVIDER_INSTRUMENT_REVOCATION_INVALID',
      'effectiveFrom cannot precede binding validFrom');
  }
  return { providerRevocationCoreId: input.providerRevocationCoreId, providerRevocationCore, providerBindingCore };
}
