/**
 * L4B-F2 MarketMacroInstrumentRows/1: an additive projection of the global macro
 * state onto instruments pinned in an existing L2B instrument identity registry.
 * No free ticker mapping, no per-ticker inference, no score, no ranking, no
 * recommendation. Jurisdiction and currency are read from the authoritative
 * descriptor; leverage is not authoritative anywhere and is recorded as such.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  canonicalDigest,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
  compareMacroInstrumentRowOrderKeys,
  normalizeMarketMacroInstrumentRowsV1,
} from '../contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import {
  effectiveBindingInterval,
  isDateInHalfOpenInterval,
} from '../contracts/instrumentIdentityV1.mjs';
import { verifyInstrumentIdentityRegistry } from '../data/buildInstrumentIdentityRegistry.mjs';
import { verifyMarketMacroFullStateRows } from './marketMacroFullStateRowsL4BF2V1.mjs';

const LEVERAGE_CLASS = 'NOT_AUTHORITATIVE';

/** Resolve the closed authoritative facts one instrument bundle contributes. */
function instrumentFactsFromBundle(bundle) {
  const instrumentIdentityId = bundle.identityManifest.instrumentIdentityId;
  const assetClass = bundle.identityCore.instrumentKind;
  if (bundle.descriptors.length > 1) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_INSTRUMENT_REGISTRY_MISMATCH',
      'projection requires at most one authoritative descriptor per instrument');
  }
  const descriptor = bundle.descriptors.length === 1 ? bundle.descriptors[0].descriptorCore : null;
  const domicileCountry = descriptor === null ? 'UNKNOWN' : descriptor.domicileCountry;
  const primaryCurrency = descriptor === null ? 'UNKNOWN' : descriptor.primaryCurrency;
  const listingIntervals = [];
  for (const entry of bundle.aliases) {
    const alias = entry.aliasBindingCore;
    const revFrom = bundle.aliasRevocationByBinding.get(entry.aliasBindingCoreId) ?? null;
    const effective = effectiveBindingInterval(alias.validFrom, alias.validToExclusive, revFrom);
    listingIntervals.push(effective);
  }
  return { instrumentIdentityId, assetClass, domicileCountry, primaryCurrency, listingIntervals };
}

function listedOnSession(listingIntervals, sessionDate) {
  for (const interval of listingIntervals) {
    if (isDateInHalfOpenInterval(sessionDate, interval.validFrom, interval.validToExclusive)) {
      return true;
    }
  }
  return false;
}

function provenanceDigestFor(fields) {
  return canonicalDigest(fields);
}

/**
 * Project the full macro state onto one instrument. NOT_APPLICABLE yields one
 * instrument-level row; a supported instrument yields one row per session
 * (SESSION_MISMATCH when not listed, PARTIAL when macro data is incomplete,
 * PROJECTED otherwise).
 */
export function projectMacroStateToInstrument(context) {
  const {
    instrument, fullRows, fullRowIdentityBySessionId, policy,
    projectionPolicyId, instrumentRegistryManifestId,
  } = context;
  const base = {
    instrumentIdentityId: instrument.instrumentIdentityId,
    projectionPolicyId,
    instrumentRegistryManifestId,
    instrumentJurisdictionCode: instrument.domicileCountry,
    instrumentCurrencyCode: instrument.primaryCurrency,
    assetClass: instrument.assetClass,
    leverageClass: LEVERAGE_CLASS,
  };

  if (fullRows.rows.length === 0) return [];

  const applicable = instrument.domicileCountry === policy.supportedDomicileCountry
    && instrument.primaryCurrency === policy.supportedPrimaryCurrency;

  if (!applicable) {
    return [{
      ...base,
      sessionId: null,
      sessionDate: null,
      macroFullStateRowIdentity: null,
      projectionStatus: 'NOT_APPLICABLE',
      macroStateCompleteness: null,
      macroRegimeAxes: null,
      provenanceDigest: provenanceDigestFor({
        instrumentIdentityId: instrument.instrumentIdentityId,
        projectionStatus: 'NOT_APPLICABLE',
        instrumentJurisdictionCode: instrument.domicileCountry,
        instrumentCurrencyCode: instrument.primaryCurrency,
        assetClass: instrument.assetClass,
      }),
    }];
  }

  const rows = [];
  for (const fullRow of fullRows.rows) {
    if (!listedOnSession(instrument.listingIntervals, fullRow.sessionDate)) {
      rows.push({
        ...base,
        sessionId: fullRow.sessionId,
        sessionDate: fullRow.sessionDate,
        macroFullStateRowIdentity: null,
        projectionStatus: 'SESSION_MISMATCH',
        macroStateCompleteness: null,
        macroRegimeAxes: null,
        provenanceDigest: provenanceDigestFor({
          instrumentIdentityId: instrument.instrumentIdentityId,
          sessionId: fullRow.sessionId,
          projectionStatus: 'SESSION_MISMATCH',
          instrumentJurisdictionCode: instrument.domicileCountry,
          instrumentCurrencyCode: instrument.primaryCurrency,
          assetClass: instrument.assetClass,
        }),
      });
      continue;
    }
    const completeness = fullRow.fullMacroRegimeState.macroDataCompleteness;
    const projectionStatus = completeness === 'COMPLETE' ? 'PROJECTED' : 'PARTIAL';
    const macroFullStateRowIdentity = fullRowIdentityBySessionId.get(fullRow.sessionId);
    if (macroFullStateRowIdentity === undefined) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_INSTRUMENT_ROWS_INVALID',
        `no full state row identity for session ${fullRow.sessionId}`);
    }
    const axes = { ...fullRow.fullMacroRegimeState };
    rows.push({
      ...base,
      sessionId: fullRow.sessionId,
      sessionDate: fullRow.sessionDate,
      macroFullStateRowIdentity,
      projectionStatus,
      macroStateCompleteness: completeness,
      macroRegimeAxes: axes,
      provenanceDigest: provenanceDigestFor({
        instrumentIdentityId: instrument.instrumentIdentityId,
        sessionId: fullRow.sessionId,
        projectionStatus,
        macroFullStateRowIdentity,
        instrumentJurisdictionCode: instrument.domicileCountry,
        instrumentCurrencyCode: instrument.primaryCurrency,
        assetClass: instrument.assetClass,
      }),
    });
  }
  return rows;
}

export function computeMarketMacroInstrumentRowsValueV1(context) {
  const {
    fullStateRowsId, fullRows, projectionPolicyId, projectionPolicy,
    instrumentRegistryManifestId, registryBundles,
  } = context;

  const fullRowIdentityBySessionId = new Map();
  for (const fullRow of fullRows.rows) {
    fullRowIdentityBySessionId.set(fullRow.sessionId, canonicalDigest(fullRow));
  }

  const bundles = [...registryBundles].sort((left, right) => {
    const a = left.identityManifest.instrumentIdentityId;
    const b = right.identityManifest.instrumentIdentityId;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const rows = [];
  for (const bundle of bundles) {
    const instrument = instrumentFactsFromBundle(bundle);
    for (const row of projectMacroStateToInstrument({
      instrument, fullRows, fullRowIdentityBySessionId, policy: projectionPolicy,
      projectionPolicyId, instrumentRegistryManifestId,
    })) {
      rows.push(row);
    }
  }
  rows.sort(compareMacroInstrumentRowOrderKeys);

  return normalizeMarketMacroInstrumentRowsV1({
    schemaVersion: MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
    fullStateRowsId,
    projectionPolicyId,
    instrumentRegistryManifestId,
    rows,
  });
}

const INSTRUMENT_INPUT_FIELDS = Object.freeze([
  'fullStateRowsId', 'f1MacroStateBySessionRowsId', 'f1SourceBundleId',
  'f1FeatureComputationPolicyId', 'f1MacroFeatureComputationReportId',
  'instrumentProjectionPolicyId', 'instrumentIdentityRegistryManifestId',
]);

export function computeMarketMacroInstrumentRows(input) {
  const api = assertApiInput(input, INSTRUMENT_INPUT_FIELDS);
  assertStore(api.store, MACRO_STORE_METHODS);
  for (const field of INSTRUMENT_INPUT_FIELDS) {
    assertExplicitPinnedMacroId(api[field], field);
    assertCasId(api[field], field);
  }
  const fullContext = verifyMarketMacroFullStateRows({
    store: api.store,
    fullStateRowsId: api.fullStateRowsId,
    f1MacroStateBySessionRowsId: api.f1MacroStateBySessionRowsId,
    f1SourceBundleId: api.f1SourceBundleId,
    f1FeatureComputationPolicyId: api.f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: api.f1MacroFeatureComputationReportId,
    instrumentProjectionPolicyId: api.instrumentProjectionPolicyId,
  });
  const projectionPolicy = fullContext.context.projectionPolicyContext.instrumentProjectionPolicy;
  if (projectionPolicy.instrumentSelectionPolicy !== 'EXPLICIT_REGISTRY_ONLY'
      || projectionPolicy.latestPolicy !== 'FORBIDDEN') {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_INSTRUMENT_POLICY_INVALID',
      'projection refuses a latest or non-registry instrument selection policy');
  }
  const registry = verifyInstrumentIdentityRegistry({
    store: api.store, registryManifestId: api.instrumentIdentityRegistryManifestId,
  });
  const value = computeMarketMacroInstrumentRowsValueV1({
    fullStateRowsId: api.fullStateRowsId,
    fullRows: fullContext.marketMacroFullStateRows,
    projectionPolicyId: api.instrumentProjectionPolicyId,
    projectionPolicy,
    instrumentRegistryManifestId: api.instrumentIdentityRegistryManifestId,
    registryBundles: registry.identityBundles,
  });
  return { marketMacroInstrumentRows: value, fullContext, instrumentRegistry: registry };
}

export function buildMarketMacroInstrumentRows(input) {
  const computed = computeMarketMacroInstrumentRows(input);
  const stored = putCanonicalL3(input.store, MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
    computed.marketMacroInstrumentRows);
  return {
    instrumentRowsId: stored.objectId,
    marketMacroInstrumentRows: stored.value,
    fullContext: computed.fullContext,
  };
}

export function verifyMarketMacroInstrumentRows(input) {
  const api = assertApiInput(input, ['instrumentRowsId', ...INSTRUMENT_INPUT_FIELDS]);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.instrumentRowsId, 'instrumentRowsId');
  assertCasId(api.instrumentRowsId, 'instrumentRowsId');
  const raw = readTypedReference(api.store, api.instrumentRowsId,
    MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION, 'macro instrument rows');
  const rows = normalizeMarketMacroInstrumentRowsV1(raw);
  for (const [field, expected] of [
    ['fullStateRowsId', api.fullStateRowsId],
    ['projectionPolicyId', api.instrumentProjectionPolicyId],
    ['instrumentRegistryManifestId', api.instrumentIdentityRegistryManifestId],
  ]) {
    if (rows[field] !== expected) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_INSTRUMENT_ROWS_MISMATCH',
        `stored instrument rows ${field} diverges from the verification pins`);
    }
  }
  const recomputed = computeMarketMacroInstrumentRows({
    store: api.store,
    fullStateRowsId: api.fullStateRowsId,
    f1MacroStateBySessionRowsId: api.f1MacroStateBySessionRowsId,
    f1SourceBundleId: api.f1SourceBundleId,
    f1FeatureComputationPolicyId: api.f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: api.f1MacroFeatureComputationReportId,
    instrumentProjectionPolicyId: api.instrumentProjectionPolicyId,
    instrumentIdentityRegistryManifestId: api.instrumentIdentityRegistryManifestId,
  });
  if (!canonicalValuesEqual(rows, recomputed.marketMacroInstrumentRows)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_INSTRUMENT_ROWS_MISMATCH',
      'stored MarketMacroInstrumentRows diverge from recomputed rows');
  }
  return {
    instrumentRowsId: api.instrumentRowsId,
    marketMacroInstrumentRows: rows,
    fullContext: recomputed.fullContext,
    instrumentRegistry: recomputed.instrumentRegistry,
  };
}
