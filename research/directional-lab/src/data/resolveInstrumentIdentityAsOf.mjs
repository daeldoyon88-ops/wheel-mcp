/**
 * Official L2B as-of resolver — registryManifestId only (no free manifest lists).
 */

import {
  InstrumentIdentityError,
  computeSymbolLookupKey,
  effectiveBindingInterval,
  isDateInHalfOpenInterval,
  namespacePolicyBindingProblems,
} from '../contracts/instrumentIdentityV1.mjs';
import { isPlainObject } from '../contracts/contractPrimitivesV1.mjs';
import {
  assertBuildInput,
  assertObjectId,
  assertStore,
} from './instrumentIdentityStore.mjs';
import { verifySymbolNamespacePolicy } from './instrumentIdentityBuildersCore.mjs';
import { verifyInstrumentIdentityRegistry } from './buildInstrumentIdentityRegistry.mjs';

/**
 * Resolve exactly one active alias from the official global registry.
 *
 * @param {{
 *   store: any,
 *   registryManifestId: string,
 *   namespacePolicyId: string,
 *   providerId: string,
 *   venueId: string|null,
 *   symbol: string,
 *   currency: string|null,
 *   asOfDate: string,
 * }} input
 */
export function resolveInstrumentIdentityAsOf(input) {
  assertBuildInput(input);
  assertStore(input.store, ['readCanonicalObject', 'uriForObject']);

  if (!isPlainObject(input)) {
    throw new InstrumentIdentityError('INSTRUMENT_INPUT_INVALID', 'resolve input is required');
  }
  for (const forbidden of ['identityManifestId', 'identityManifestIds', 'manifests', 'aliases']) {
    if (Object.hasOwn(input, forbidden)) {
      throw new InstrumentIdentityError('INSTRUMENT_INPUT_INVALID',
        `official resolver refuses free collection field: ${forbidden}`);
    }
  }
  assertObjectId(input.registryManifestId, 'registryManifestId');
  assertObjectId(input.namespacePolicyId, 'namespacePolicyId');

  const registry = verifyInstrumentIdentityRegistry({
    store: input.store, registryManifestId: input.registryManifestId,
  });

  const { namespacePolicy } = verifySymbolNamespacePolicy({
    store: input.store, namespacePolicyId: input.namespacePolicyId,
  });
  if (namespacePolicy.providerId !== input.providerId) {
    throw new InstrumentIdentityError('SYMBOL_NAMESPACE_MISMATCH',
      'providerId does not match the namespace policy');
  }
  const policyProblems = namespacePolicyBindingProblems(namespacePolicy, {
    providerId: input.providerId,
    venueId: input.venueId,
    currency: input.currency,
  });
  if (policyProblems.length > 0) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INVALID', policyProblems.join('; '), { problems: policyProblems });
  }

  const normalizedLookupKey = computeSymbolLookupKey(namespacePolicy, input.symbol);

  /** @type {{instrumentIdentityId: string, aliasBindingCoreId: string}[]} */
  const matches = [];
  /** @type {{instrumentIdentityId: string, aliasBindingCoreId: string}[]} */
  const revokedMatches = [];

  for (const bundle of registry.identityBundles) {
    for (const entry of bundle.aliases) {
      const alias = entry.aliasBindingCore;
      if (alias.namespacePolicyId !== input.namespacePolicyId) continue;
      if (alias.providerId !== input.providerId) continue;
      if (alias.venueId !== input.venueId) continue;
      if (alias.currency !== input.currency) continue;
      if (alias.symbolLookupKey !== normalizedLookupKey) continue;

      const revFrom = bundle.aliasRevocationByBinding.get(entry.aliasBindingCoreId) ?? null;
      const effective = effectiveBindingInterval(alias.validFrom, alias.validToExclusive, revFrom);

      let inOriginalInterval;
      try {
        inOriginalInterval = isDateInHalfOpenInterval(input.asOfDate, alias.validFrom, alias.validToExclusive);
      } catch (error) {
        if (error instanceof InstrumentIdentityError) throw error;
        throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INTERVAL_INVALID', 'alias interval is invalid');
      }
      if (!inOriginalInterval) continue;

      if (revFrom !== null && input.asOfDate >= revFrom) {
        revokedMatches.push({
          instrumentIdentityId: alias.instrumentIdentityId,
          aliasBindingCoreId: entry.aliasBindingCoreId,
        });
        continue;
      }

      let inEffective;
      try {
        inEffective = isDateInHalfOpenInterval(input.asOfDate, effective.validFrom, effective.validToExclusive);
      } catch (error) {
        if (error instanceof InstrumentIdentityError) throw error;
        throw new InstrumentIdentityError('INSTRUMENT_ALIAS_INTERVAL_INVALID', 'effective alias interval is invalid');
      }
      if (!inEffective) continue;

      matches.push({
        instrumentIdentityId: alias.instrumentIdentityId,
        aliasBindingCoreId: entry.aliasBindingCoreId,
      });
    }
  }

  // A revocation always wins over an active match for the same binding.
  if (matches.length === 0 && revokedMatches.length > 0) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_REVOKED',
      'only revoked alias bindings match the as-of lookup', { revokedMatches });
  }
  if (matches.length === 0) {
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_NOT_FOUND',
      'no active alias binding matches the as-of lookup');
  }
  if (matches.length > 1) {
    const identities = new Set(matches.map((match) => match.instrumentIdentityId));
    if (identities.size > 1) {
      throw new InstrumentIdentityError('INSTRUMENT_ALIAS_AMBIGUOUS',
        'multiple active alias bindings match the as-of lookup', { matches });
    }
    throw new InstrumentIdentityError('INSTRUMENT_ALIAS_AMBIGUOUS',
      'multiple active alias bindings match the as-of lookup', { matches });
  }

  return {
    instrumentIdentityId: matches[0].instrumentIdentityId,
    aliasBindingCoreId: matches[0].aliasBindingCoreId,
    normalizedLookupKey,
    resolutionStatus: 'RESOLVED',
    registryManifestId: input.registryManifestId,
  };
}
