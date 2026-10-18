/**
 * L4C-I2 EarningsDatasetBinding/1: immutably pin everything an as-of
 * materialization is allowed to read.
 *
 * Follows the L4B-I2 precedent macroDatasetBindingL4BV1.mjs. Only five values
 * are accepted from the caller - the pinned snapshot, the two closed policies,
 * the I2 transform manifest and the cutoff. The remaining twelve fields are
 * derived from verified objects; a caller that supplies one of them is refused
 * rather than trusted, so a binding can never assert a jurisdiction, a currency,
 * a temporal capability or a set composition the snapshot does not prove.
 *
 * The I2 transform manifest is a caller argument on purpose: it pins the
 * L4C-I2 module bytes, which are a different set from the L4C-I1 extraction
 * manifest the snapshot pins.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertPlainObject,
  assertStore,
  assertUtcInstant,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import { EARNINGS_DATASET_SERIES_IDENTITY } from '../contracts/earningsContractsL4CIV1.mjs';
import {
  EARNINGS_DATASET_BINDING_POLICY_VERSION,
  EARNINGS_DATASET_BINDING_SCHEMA_VERSION,
  normalizeEarningsDatasetBindingV1,
} from '../contracts/earningsContractsL4CIIV1.mjs';
import { TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION } from '../data/transformImplementationManifestV2.mjs';
import {
  EARNINGS_STORE_METHODS,
  assertExplicitPinnedEarningsIdV1,
} from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsDatasetSnapshotManifest } from './earningsDatasetSnapshotL4CIV1.mjs';
import { verifyEarningsAsOfResolutionPolicy } from './earningsAsOfResolutionPolicyL4CIIV1.mjs';
import { verifyEarningsFiscalClassificationPolicy } from './earningsFiscalClassificationPolicyL4CIIV1.mjs';

/** The single temporal capability an L4C-I2 binding may ever carry. */
export const EARNINGS_BINDING_TEMPORAL_CAPABILITY_V1 = 'POINT_IN_TIME_PUBLIC_AVAILABLE_AT';

/**
 * The runtime contract an L4C-I2 transform manifest must declare. No new
 * manifest schema is introduced: the I2 profile is the runtime contract.
 */
export const EARNINGS_I2_RUNTIME_CONTRACT_VERSION = 'NODE_L4C_I2_V1';

const BINDING_CALLER_FIELDS = Object.freeze([
  'earningsDatasetSnapshotManifestId', 'earningsAsOfResolutionPolicyId',
  'earningsFiscalClassificationPolicyId', 'transformImplementationManifestId', 'knowledgeCutoff',
]);

/** Fields the builder derives; a caller value for any of them is refused. */
const BINDING_DERIVED_ONLY_FIELDS = Object.freeze([
  'earningsEventSetManifestId', 'earningsRevisionSetManifestId',
  'earningsExtractionSetManifestId', 'earningsIngestionPolicyId',
  'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
  'datasetSeriesIdentity', 'jurisdictionCode', 'currencyCode', 'temporalCapability',
  'bindingPolicyVersion', 'schemaVersion',
]);

function assertDerivedOnlyInput(input) {
  for (const field of BINDING_DERIVED_ONLY_FIELDS) {
    if (Object.hasOwn(input, field)) {
      throw new MarketDataL3Error('EARNINGS_BINDING_INVALID',
        `binding builder derives ${field}; a caller value is refused`);
    }
  }
}

/**
 * Recompute the canonical binding value from the pinned snapshot composition.
 * Every derived field has exactly one admissible source.
 */
function expectedBindingValue(references, snapshot, policy) {
  return normalizeEarningsDatasetBindingV1({
    schemaVersion: EARNINGS_DATASET_BINDING_SCHEMA_VERSION,
    earningsDatasetSnapshotManifestId: references.earningsDatasetSnapshotManifestId,
    earningsEventSetManifestId: snapshot.earningsEventSetManifestId,
    earningsRevisionSetManifestId: snapshot.earningsRevisionSetManifestId,
    earningsExtractionSetManifestId: snapshot.earningsExtractionSetManifestId,
    earningsIngestionPolicyId: snapshot.earningsIngestionPolicyId,
    earningsMetricExtractionPolicyId: snapshot.earningsMetricExtractionPolicyId,
    earningsTaxonomyBundleManifestId: snapshot.earningsTaxonomyBundleManifestId,
    earningsAsOfResolutionPolicyId: references.earningsAsOfResolutionPolicyId,
    earningsFiscalClassificationPolicyId: references.earningsFiscalClassificationPolicyId,
    transformImplementationManifestId: references.transformImplementationManifestId,
    datasetSeriesIdentity: snapshot.datasetSeriesIdentity,
    jurisdictionCode: policy.jurisdictionCode,
    currencyCode: policy.currencyCode,
    knowledgeCutoff: references.knowledgeCutoff,
    temporalCapability: EARNINGS_BINDING_TEMPORAL_CAPABILITY_V1,
    bindingPolicyVersion: EARNINGS_DATASET_BINDING_POLICY_VERSION,
  });
}

/**
 * Verify the two closed policies and the I2 transform manifest, then return the
 * verified snapshot context every binding is derived from.
 */
function loadBindingContext(store, references) {
  const asOf = verifyEarningsAsOfResolutionPolicy({
    store, earningsAsOfResolutionPolicyId: references.earningsAsOfResolutionPolicyId,
  }).earningsAsOfResolutionPolicy;
  if (asOf.latestReferencePolicy !== 'FORBIDDEN'
    || asOf.snapshotSelectionPolicy !== 'EXPLICIT_PIN_ONLY') {
    throw new MarketDataL3Error('EARNINGS_AS_OF_POLICY_INVALID',
      'binding refuses a latest-capable as-of resolution policy');
  }
  const fiscal = verifyEarningsFiscalClassificationPolicy({
    store, earningsFiscalClassificationPolicyId: references.earningsFiscalClassificationPolicyId,
  }).earningsFiscalClassificationPolicy;
  let transformManifest;
  try {
    transformManifest = readTypedReference(store, references.transformImplementationManifestId,
      TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, 'transform implementation manifest');
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH',
      'binding transform implementation manifest is missing or invalid', { cause });
  }
  // The manifest is reused rather than re-versioned, so the I2 profile is
  // identified by its runtime contract: an L4C-I1 manifest cannot stand in for
  // the L4C-I2 module pins.
  if (transformManifest.runtimeContractVersion !== EARNINGS_I2_RUNTIME_CONTRACT_VERSION) {
    throw new MarketDataL3Error('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH',
      'binding transform manifest does not declare the L4C-I2 runtime contract',
      { expected: EARNINGS_I2_RUNTIME_CONTRACT_VERSION,
        actual: transformManifest.runtimeContractVersion });
  }

  let verifiedSnapshot;
  try {
    verifiedSnapshot = verifyEarningsDatasetSnapshotManifest({
      store,
      earningsDatasetSnapshotManifestId: references.earningsDatasetSnapshotManifestId,
    });
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_BINDING_MISMATCH',
      'binding snapshot is missing or diverges from its composition', { cause });
  }
  const snapshot = verifiedSnapshot.earningsDatasetSnapshotManifest;
  if (snapshot.datasetSeriesIdentity !== EARNINGS_DATASET_SERIES_IDENTITY) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_FOREIGN_DATASET',
      'binding snapshot carries a foreign datasetSeriesIdentity');
  }
  return {
    asOfPolicy: asOf,
    fiscalPolicy: fiscal,
    verifiedSnapshot,
    snapshot,
    ingestionPolicy: verifiedSnapshot.composition.policy,
  };
}

/**
 * Build a binding from five explicitly pinned caller values.
 * @param {{
 *   store: unknown,
 *   earningsDatasetSnapshotManifestId: string,
 *   earningsAsOfResolutionPolicyId: string,
 *   earningsFiscalClassificationPolicyId: string,
 *   transformImplementationManifestId: string,
 *   knowledgeCutoff: string
 * }} input
 */
export function buildEarningsDatasetBinding(input) {
  // Derived fields are screened before the generic unknown-field guard, so a
  // caller that supplies one is told which authority derives it rather than
  // being told the field is merely unknown.
  assertDerivedOnlyInput(assertPlainObject(input));
  const api = assertApiInput(input, BINDING_CALLER_FIELDS);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  for (const field of BINDING_CALLER_FIELDS) {
    if (field === 'knowledgeCutoff') continue;
    assertExplicitPinnedEarningsIdV1(api[field], field);
    assertCasId(api[field], field);
  }
  try {
    assertUtcInstant(api.knowledgeCutoff, 'knowledgeCutoff');
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_KNOWLEDGE_CUTOFF_INVALID',
      'knowledgeCutoff must be a strict UTC instant', { cause });
  }

  const context = loadBindingContext(api.store, api);
  const binding = expectedBindingValue(api, context.snapshot, context.ingestionPolicy);
  const stored = putCanonicalL3(api.store, EARNINGS_DATASET_BINDING_SCHEMA_VERSION, binding);
  verifyEarningsDatasetBinding({ store: api.store, earningsDatasetBindingId: stored.objectId });
  return { earningsDatasetBindingId: stored.objectId, earningsDatasetBinding: stored.value };
}

/**
 * Verify a stored binding by recomputing it. Nothing written into the binding
 * is trusted: every derived field is compared against the snapshot it claims.
 * @param {{store: unknown, earningsDatasetBindingId: string}} input
 */
export function verifyEarningsDatasetBinding(input) {
  const api = assertApiInput(input, ['earningsDatasetBindingId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsDatasetBindingId, 'earningsDatasetBindingId');
  assertCasId(api.earningsDatasetBindingId, 'earningsDatasetBindingId');

  let binding;
  try {
    binding = normalizeEarningsDatasetBindingV1(readTypedReference(api.store,
      api.earningsDatasetBindingId, EARNINGS_DATASET_BINDING_SCHEMA_VERSION,
      'earnings dataset binding'));
  } catch (cause) {
    if (cause instanceof MarketDataL3Error
      && (cause.code === 'EARNINGS_BINDING_INVALID'
        || cause.code === 'EARNINGS_KNOWLEDGE_CUTOFF_INVALID'
        || cause.code === 'EARNINGS_MATERIALIZATION_SUPERSESSION_FORBIDDEN')) {
      throw cause;
    }
    throw new MarketDataL3Error('EARNINGS_BINDING_MISSING',
      'earnings dataset binding is missing or corrupt', { cause });
  }

  const context = loadBindingContext(api.store, binding);
  const snapshot = context.snapshot;
  for (const field of ['earningsEventSetManifestId', 'earningsRevisionSetManifestId',
    'earningsExtractionSetManifestId', 'earningsIngestionPolicyId',
    'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId']) {
    if (binding[field] !== snapshot[field]) {
      throw new MarketDataL3Error('EARNINGS_BINDING_MISMATCH',
        `binding ${field} diverges from the pinned snapshot composition`);
    }
  }
  if (binding.temporalCapability !== EARNINGS_BINDING_TEMPORAL_CAPABILITY_V1) {
    throw new MarketDataL3Error('EARNINGS_BINDING_MISMATCH',
      'binding temporalCapability diverges from the derived capability');
  }
  const expected = expectedBindingValue(binding, snapshot, context.ingestionPolicy);
  if (!canonicalValuesEqual(binding, expected)) {
    throw new MarketDataL3Error('EARNINGS_BINDING_INVALID',
      'binding diverges from its recomputed canonical value');
  }
  return {
    earningsDatasetBindingId: api.earningsDatasetBindingId,
    earningsDatasetBinding: binding,
    earningsDatasetSnapshotManifest: snapshot,
    composition: context.verifiedSnapshot.composition,
    earningsAsOfResolutionPolicy: context.asOfPolicy,
    earningsFiscalClassificationPolicy: context.fiscalPolicy,
  };
}
