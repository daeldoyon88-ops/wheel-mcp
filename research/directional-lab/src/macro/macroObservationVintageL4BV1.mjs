/**
 * L4B-I1 logical observation identities, vintage temporal identities and
 * vintage contents. availableAt is always explicitly pinned: either the
 * normalized official timestamp or the deterministic series-specific policy
 * derivation. The wall clock is never consulted.
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
  MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
  MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
  MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION,
  assertMacroObservationPeriodShapeV1,
  deriveNewYorkUtcInstantV1,
  findMacroReleaseTimeRuleV1,
  macroVintageIdentityFor,
  normalizeMacroObservationIdentityCoreV1,
  normalizeMacroObservationVintageCoreV1,
  normalizeMacroVintageIdentityCoreV1,
} from '../contracts/macroIngestionContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroSeriesIdentityCore } from './macroSeriesRegistryL4BV1.mjs';
import { addDays } from '../time/civilDate.mjs';

/**
 * The pinned source document is raw evidence in the CAS source namespace.
 * The reference is loaded and hash-verified — a URL, a path, a timestamp or
 * an unregistered digest can never satisfy it.
 */
export function verifyMacroSourceDocument(store, sourceDocumentId) {
  assertStore(store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(sourceDocumentId, 'sourceDocumentId');
  try {
    assertCasId(sourceDocumentId, 'sourceDocumentId');
    const uri = store.uriForObject({ namespace: 'source', objectId: sourceDocumentId });
    const read = store.readObject({ uri, expectedObjectId: sourceDocumentId });
    return { sourceDocumentId, sizeBytes: read.sizeBytes };
  } catch (cause) {
    if (cause instanceof MarketDataL3Error
        && cause.code === 'MARKET_DATA_MACRO_SOURCE_DOCUMENT_INVALID') throw cause;
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SOURCE_DOCUMENT_INVALID',
      'sourceDocumentId is not a pinned, verifiable CAS source object', { cause });
  }
}

/** Match one observation identity against its pinned series identity. */
export function assertMacroObservationMatchesSeriesV1(observation, series) {
  if (observation.unit !== series.units) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_UNIT_MISMATCH',
      'observation unit diverges from the pinned series identity');
  }
  if (observation.seasonalAdjustment !== series.seasonalAdjustment) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH',
      'observation seasonal adjustment diverges from the pinned series identity');
  }
  assertMacroObservationPeriodShapeV1(series.frequency, observation.observationPeriodStart,
    observation.observationPeriodEnd, observation.referencePeriod);
}

export function buildMacroObservationIdentityCore(input) {
  const api = assertApiInput(input, ['identity']);
  assertStore(api.store, MACRO_STORE_METHODS);
  const identity = normalizeMacroObservationIdentityCoreV1(api.identity);
  const { macroSeriesIdentity } = verifyMacroSeriesIdentityCore({
    store: api.store, macroSeriesIdentityId: identity.macroSeriesIdentityId,
  });
  assertMacroObservationMatchesSeriesV1(identity, macroSeriesIdentity);
  const stored = putCanonicalL3(api.store,
    MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION, identity);
  return { observationIdentityId: stored.objectId, observationIdentity: stored.value };
}

export function verifyMacroObservationIdentityCore(input) {
  const api = assertApiInput(input, ['observationIdentityId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.observationIdentityId, 'observationIdentityId');
  assertCasId(api.observationIdentityId, 'observationIdentityId');
  const raw = readTypedReference(api.store, api.observationIdentityId,
    MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION, 'macro observation identity');
  const identity = normalizeMacroObservationIdentityCoreV1(raw);
  const { macroSeriesIdentity } = verifyMacroSeriesIdentityCore({
    store: api.store, macroSeriesIdentityId: identity.macroSeriesIdentityId,
  });
  assertMacroObservationMatchesSeriesV1(identity, macroSeriesIdentity);
  return {
    observationIdentityId: api.observationIdentityId,
    observationIdentity: identity,
    macroSeriesIdentity,
  };
}

export function buildMacroVintageIdentityCore(input) {
  const api = assertApiInput(input, ['identity']);
  assertStore(api.store, MACRO_STORE_METHODS);
  const identity = normalizeMacroVintageIdentityCoreV1(api.identity);
  verifyMacroObservationIdentityCore({
    store: api.store, observationIdentityId: identity.observationIdentityId,
  });
  verifyMacroSourceDocument(api.store, identity.sourceDocumentId);
  const stored = putCanonicalL3(api.store, MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION, identity);
  return { macroVintageIdentityId: stored.objectId, macroVintageIdentity: stored.value };
}

export function verifyMacroVintageIdentityCore(input) {
  const api = assertApiInput(input, ['macroVintageIdentityId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroVintageIdentityId, 'macroVintageIdentityId');
  assertCasId(api.macroVintageIdentityId, 'macroVintageIdentityId');
  const raw = readTypedReference(api.store, api.macroVintageIdentityId,
    MACRO_VINTAGE_IDENTITY_CORE_SCHEMA_VERSION, 'macro vintage identity');
  const identity = normalizeMacroVintageIdentityCoreV1(raw);
  const observation = verifyMacroObservationIdentityCore({
    store: api.store, observationIdentityId: identity.observationIdentityId,
  });
  verifyMacroSourceDocument(api.store, identity.sourceDocumentId);
  return {
    macroVintageIdentityId: api.macroVintageIdentityId,
    macroVintageIdentity: identity,
    observationIdentity: observation.observationIdentity,
    macroSeriesIdentity: observation.macroSeriesIdentity,
  };
}

/**
 * Deterministic policy admission of one vintage's availableAt.
 *
 * OFFICIAL_TIMESTAMP — the contract already pinned availableAt to the
 * official timestamp; nothing policy-specific remains.
 *
 * SERIES_AUTHORITY_POLICY — a pinned series-specific rule must exist and the
 * availableAt must equal the deterministic New-York derivation of the rule's
 * civil time on the release civil date. No generic hour, no machine timezone.
 */
export function assertMacroVintageReleaseResolutionV1(policy, series, vintage) {
  if (vintage.releaseTimeResolutionMode === 'OFFICIAL_TIMESTAMP') return;
  const utcDate = vintage.availableAt.slice(0, 10);
  for (const civilDate of [utcDate, addDays(utcDate, -1)]) {
    const rule = findMacroReleaseTimeRuleV1(policy, series.sourceAuthority,
      series.canonicalSeriesCode, civilDate);
    if (rule !== null
        && deriveNewYorkUtcInstantV1(civilDate, rule.localTime) === vintage.availableAt) {
      return;
    }
  }
  throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
    'availableAt does not match any pinned series-specific release rule');
}

/**
 * Build one vintage content. availableAt is never guessed: OFFICIAL mode
 * copies the official timestamp; policy mode derives from the pinned rule for
 * the explicit releaseCivilDate; anything else is rejected.
 * @param {{store: any, policy: any, series: any, observationIdentityId: string,
 *   releaseTimeResolutionMode: string, releaseTimestamp?: string|null,
 *   releaseCivilDate?: string|null, vintageSequence: number, value: unknown,
 *   revisionKind: string, parentVintageId: string|null,
 *   vintageCompletenessClass: string, sourceDocumentId: string}} input
 */
export function buildMacroObservationVintageCore(input) {
  const api = assertApiInput(input, ['policy', 'series', 'observationIdentityId',
    'releaseTimeResolutionMode', 'releaseTimestamp', 'releaseCivilDate', 'vintageSequence',
    'value', 'revisionKind', 'parentVintageId', 'vintageCompletenessClass', 'sourceDocumentId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  // Authority is the observation pinned in the store — never a caller-forged
  // series object alone. The provided series must match that observation.
  const observationBundle = verifyMacroObservationIdentityCore({
    store: api.store, observationIdentityId: api.observationIdentityId,
  });
  const series = observationBundle.macroSeriesIdentity;
  if (api.series.sourceAuthority !== series.sourceAuthority
      || api.series.canonicalSeriesCode !== series.canonicalSeriesCode
      || api.series.units !== series.units
      || api.series.seasonalAdjustment !== series.seasonalAdjustment
      || api.series.frequency !== series.frequency
      || api.series.methodologyVersionId !== series.methodologyVersionId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH',
      'caller series diverges from the series pinned by the observation identity');
  }
  let availableAt;
  if (api.releaseTimeResolutionMode === 'OFFICIAL_TIMESTAMP') {
    availableAt = api.releaseTimestamp;
  } else if (api.releaseTimeResolutionMode === 'SERIES_AUTHORITY_POLICY') {
    if (typeof api.releaseCivilDate !== 'string') {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AVAILABLE_AT_INVALID',
        'SERIES_AUTHORITY_POLICY requires an explicit release civil date');
    }
    const rule = findMacroReleaseTimeRuleV1(api.policy, series.sourceAuthority,
      series.canonicalSeriesCode, api.releaseCivilDate);
    if (rule === null) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_TIMESTAMP_UNKNOWN',
        'no pinned series-specific release rule covers this series and date');
    }
    availableAt = deriveNewYorkUtcInstantV1(api.releaseCivilDate, rule.localTime);
  } else {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_RELEASE_TIMESTAMP_UNKNOWN',
      'an unknown release time cannot produce a computable vintage');
  }
  const identity = macroVintageIdentityFor({
    observationIdentityId: api.observationIdentityId,
    availableAt,
    vintageSequence: api.vintageSequence,
    sourceDocumentId: api.sourceDocumentId,
  });
  const identityStored = buildMacroVintageIdentityCore({ store: api.store, identity });
  const vintage = normalizeMacroObservationVintageCoreV1({
    schemaVersion: MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION,
    macroVintageIdentityId: identityStored.macroVintageIdentityId,
    observationIdentityId: api.observationIdentityId,
    releaseTimestamp: api.releaseTimestamp,
    availableAt,
    vintageSequence: api.vintageSequence,
    value: api.value,
    revisionKind: api.revisionKind,
    parentVintageId: api.parentVintageId,
    vintageCompletenessClass: api.vintageCompletenessClass,
    releaseTimeResolutionMode: api.releaseTimeResolutionMode,
    sourceDocumentId: api.sourceDocumentId,
  });
  assertMacroVintageReleaseResolutionV1(api.policy, series, vintage);
  const stored = putCanonicalL3(api.store, MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION, vintage);
  return {
    observationVintageId: stored.objectId,
    macroVintageIdentityId: identityStored.macroVintageIdentityId,
    observationVintage: stored.value,
  };
}

export function verifyMacroObservationVintageCore(input) {
  const api = assertApiInput(input, ['observationVintageId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.observationVintageId, 'observationVintageId');
  assertCasId(api.observationVintageId, 'observationVintageId');
  const raw = readTypedReference(api.store, api.observationVintageId,
    MACRO_OBSERVATION_VINTAGE_CORE_SCHEMA_VERSION, 'macro observation vintage');
  const vintage = normalizeMacroObservationVintageCoreV1(raw);
  const identity = verifyMacroVintageIdentityCore({
    store: api.store, macroVintageIdentityId: vintage.macroVintageIdentityId,
  });
  const pinned = identity.macroVintageIdentity;
  if (pinned.observationIdentityId !== vintage.observationIdentityId
      || pinned.availableAt !== vintage.availableAt
      || pinned.vintageSequence !== vintage.vintageSequence
      || pinned.sourceDocumentId !== vintage.sourceDocumentId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_REFERENCE_MISMATCH',
      'vintage content diverges from its pinned temporal identity');
  }
  if (!canonicalValuesEqual(vintage, raw)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_INVALID',
      'stored vintage content is not canonical');
  }
  return {
    observationVintageId: api.observationVintageId,
    observationVintage: vintage,
    macroVintageIdentity: pinned,
    observationIdentity: identity.observationIdentity,
    macroSeriesIdentity: identity.macroSeriesIdentity,
  };
}
