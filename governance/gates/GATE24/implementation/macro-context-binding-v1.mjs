/**
 * GATE24 prepared macro context binding.
 *
 * GATE24 CONSUMES prepared, versioned macro context. It never fetches, ingests or
 * normalizes, and it creates no live macro fetcher. The inherited architecture is
 * FETCH_ONCE -> NORMALIZE -> VERSION_CACHE -> PRECOMPUTE -> REUSE, where PRECOMPUTE
 * names the historical, OFF_SCAN step GATE21 already declares.
 *
 * Budget, enforced by counters rather than asserted: network calls during
 * classification = 0, macro fetches per ticker = 0, one snapshot computed once and
 * reused across N tickers, Wheel live-scan latency delta = ZERO.
 *
 * MACRO_FEATURE_COMPLETENESS is a producer boundary field. It is one determinant of
 * macro-fed dimension resolution and is NEVER classificationQuality.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { admitMacroVintage, selectVintageAsOf } from './causal-admission-v1.mjs';
import { MACRO_FED_DIMENSION_NAMES_V1 } from './regime-taxonomy-v1.mjs';

export const MACRO_CONTEXT_BINDING_VERSION = 'GATE24_MacroContextBinding/1';
export const MACRO_CONTEXT_REGISTRY_VERSION_ID = 'MACRO_CONTEXT_REGISTRY_V1';

export const MACRO_TIERS_V1 = Object.freeze(['CORE_V1', 'OPTIONAL_V1', 'REGISTERED_DEFERRED', 'FUTURE_EXTENSION']);

/** CORE_V1 base sources: 5 Fed and monetary + 5 Treasury tenors + CPIAUCSL + UNRATE = 12. */
export const MACRO_CORE_V1_BASE_SERIES = Object.freeze([
  'US.FRB.DFEDTARU', 'US.FRB.DFEDTARL', 'US.NYFED.EFFR', 'US.NYFED.SOFR', 'US.FOMC.DECISION',
  'US.TREAS.DGS3MO', 'US.TREAS.DGS2', 'US.TREAS.DGS5', 'US.TREAS.DGS10', 'US.TREAS.DGS30',
  'US.BLS.CPIAUCSL', 'US.BLS.UNRATE',
]);
export const MACRO_CORE_V1_BASE_SERIES_COUNT = MACRO_CORE_V1_BASE_SERIES.length;

/** Derived features are computed from base sources and never counted as base sources. */
export const MACRO_CORE_V1_DERIVED_FEATURES = Object.freeze([
  'SPREAD_10Y_2Y', 'SPREAD_10Y_3M', 'SPREAD_5Y_2Y', 'cpiMoM', 'cpiYoY', 'inversionFlags',
]);

/**
 * The concrete producer feature codes realizing the declared "inversion flags"
 * derived feature: the MACRO_FEATURE_CURVE_SHAPES and MACRO_FEATURE_CURVE_DIRECTIONS
 * token carriers. They realize one declared derived feature, so the declared derived
 * feature count stays 6 and no macro member is promoted.
 */
export const MACRO_CORE_V1_CURVE_FEATURE_CODES = Object.freeze(['curveShape', 'curveDirection']);

/** OPTIONAL_V1 exists architecturally and is empty in V1; no silent promotion is admissible. */
export const MACRO_OPTIONAL_V1_MEMBERS = Object.freeze([]);

export const MACRO_FEATURE_COMPLETENESS_V1 = Object.freeze(['COMPLETE', 'PARTIAL', 'UNAVAILABLE']);

export const MACRO_ARCHITECTURE_CHAIN_V1 = Object.freeze([
  'FETCH_ONCE', 'NORMALIZE', 'VERSION_CACHE', 'PRECOMPUTE', 'REUSE',
]);

export const MACRO_REFUSAL_CODES_V1 = Object.freeze({
  network: 'MACRO_NETWORK_DURING_CLASSIFICATION_FORBIDDEN',
  liveFetcher: 'LIVE_MACRO_FETCHER_FORBIDDEN',
  perTicker: 'PER_TICKER_MACRO_FETCH_FORBIDDEN',
  ingestion: 'MACRO_INGESTION_NOT_IN_GATE24_SCOPE',
  silentPromotion: 'SILENT_TIER_PROMOTION_FORBIDDEN',
  completenessInconsistent: 'MACRO_COVERAGE_DECLARATION_INCONSISTENT',
});

/**
 * Instrumentation for the performance budget. The counters are real: every code
 * path that could reach a network or a per-ticker fetch increments them, so a
 * measured zero is evidence rather than a declaration.
 */
export function createMacroBudgetMeter() {
  const counters = { networkCalls: 0, macroFetches: 0, snapshotComputes: 0, snapshotReuses: 0, ingestionCalls: 0 };
  return {
    counters,
    read: () => Object.freeze({ ...counters }),
    recordNetworkCall() { counters.networkCalls += 1; },
    recordMacroFetch() { counters.macroFetches += 1; },
    recordSnapshotCompute() { counters.snapshotComputes += 1; },
    recordSnapshotReuse() { counters.snapshotReuses += 1; },
    recordIngestionCall() { counters.ingestionCalls += 1; },
  };
}

/** Any attempt to fetch, ingest or normalize inside GATE24 is refused before it runs. */
export function refuseMacroFetch({ meter, reason = 'network' } = {}) {
  if (meter) meter.recordNetworkCall();
  return { status: 'BLOCKED', code: MACRO_REFUSAL_CODES_V1[reason] ?? MACRO_REFUSAL_CODES_V1.network };
}

export function refuseLiveMacroFetcher(meter) { return refuseMacroFetch({ meter, reason: 'liveFetcher' }); }
export function refusePerTickerMacroFetch(meter) { return refuseMacroFetch({ meter, reason: 'perTicker' }); }
export function refuseMacroIngestion(meter) { return refuseMacroFetch({ meter, reason: 'ingestion' }); }

/**
 * MacroContextBindingId identifies the prepared macro vintage that was consumed.
 * Identical market features with a different macro vintage are different inputs and
 * therefore a different RegimeRecordId.
 */
export function createMacroContextBinding({
  macroVintageSetManifestId,
  macroDatasetSnapshotManifestId,
  availableAtPolicyId,
  coreSeriesCodes = MACRO_CORE_V1_BASE_SERIES,
  derivedFeatureCodes = MACRO_CORE_V1_DERIVED_FEATURES,
  curveFeatureCodes = MACRO_CORE_V1_CURVE_FEATURE_CODES,
  optionalSeriesCodes = MACRO_OPTIONAL_V1_MEMBERS,
}) {
  const required = { macroVintageSetManifestId, macroDatasetSnapshotManifestId, availableAtPolicyId };
  if (Object.values(required).some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('MACRO_CONTEXT_BINDING_INVALID');
  }
  const promoted = optionalSeriesCodes.filter((code) => !MACRO_OPTIONAL_V1_MEMBERS.includes(code));
  if (promoted.length > 0) throw new Error(MACRO_REFUSAL_CODES_V1.silentPromotion);
  const payload = {
    schemaVersion: MACRO_CONTEXT_BINDING_VERSION,
    registryVersionId: MACRO_CONTEXT_REGISTRY_VERSION_ID,
    ...required,
    coreSeriesCodes: [...coreSeriesCodes].sort(),
    derivedFeatureCodes: [...derivedFeatureCodes].sort(),
    curveFeatureCodes: [...curveFeatureCodes].sort(),
    optionalSeriesCodes: [...optionalSeriesCodes].sort(),
  };
  return Object.freeze({
    ...payload,
    macroContextBindingId: sha256Canonical(payload),
  });
}

/**
 * Resolves the prepared macro snapshot at K(T) from an already-versioned vintage
 * store. Nothing is fetched: the store is an in-memory projection of the GATE21
 * versioned cache, and every observation is admitted at its own vintage.
 */
export function resolveMacroSnapshot({ macroContextBinding, vintageStore, knowledgeCutoff, meter }) {
  if (!macroContextBinding?.macroContextBindingId) throw new Error('MACRO_CONTEXT_BINDING_REQUIRED');
  if (typeof knowledgeCutoff !== 'string' || knowledgeCutoff.length === 0) {
    return { status: 'FAIL_CLOSED', code: 'KNOWLEDGE_CUTOFF_REQUIRED', snapshot: null };
  }
  if (meter) meter.recordSnapshotCompute();
  const store = vintageStore ?? {};
  const series = {};
  const absent = [];
  for (const code of macroContextBinding.coreSeriesCodes) {
    const observations = store[code];
    if (!Array.isArray(observations) || observations.length === 0) { absent.push(code); continue; }
    const selected = selectVintageAsOf({ observations, knowledgeCutoff });
    if (selected.status !== 'RESOLVED') { absent.push(code); continue; }
    series[code] = selected.observation;
  }
  const derived = {};
  for (const code of [...macroContextBinding.derivedFeatureCodes, ...macroContextBinding.curveFeatureCodes]) {
    const observations = store[code];
    if (!Array.isArray(observations) || observations.length === 0) continue;
    const selected = selectVintageAsOf({ observations, knowledgeCutoff });
    if (selected.status === 'RESOLVED') derived[code] = selected.observation;
  }
  const resolvedCount = Object.keys(series).length;
  const completeness = resolvedCount === 0
    ? 'UNAVAILABLE'
    : (absent.length === 0 ? 'COMPLETE' : 'PARTIAL');
  return Object.freeze({
    status: resolvedCount === 0 ? 'UNAVAILABLE' : 'RESOLVED',
    code: null,
    snapshot: Object.freeze({
      schemaVersion: MACRO_CONTEXT_BINDING_VERSION,
      macroContextBindingId: macroContextBinding.macroContextBindingId,
      knowledgeCutoff,
      series: Object.freeze(series),
      derived: Object.freeze(derived),
      absentSeriesCodes: Object.freeze([...absent].sort()),
      macroFeatureCompleteness: completeness,
      networkCalls: 0,
      fetches: 0,
    }),
  });
}

/**
 * Computed once, reused across N tickers. A second resolution for the same binding
 * and cutoff is a cache hit, never a recompute and never a fetch.
 */
export function createMacroSnapshotCache() {
  const entries = new Map();
  return {
    size: () => entries.size,
    resolve({ macroContextBinding, vintageStore, knowledgeCutoff, meter, instrumentIdentityId }) {
      const key = `${macroContextBinding.macroContextBindingId}|${knowledgeCutoff}`;
      if (entries.has(key)) {
        if (meter) meter.recordSnapshotReuse();
        return entries.get(key);
      }
      const resolved = resolveMacroSnapshot({ macroContextBinding, vintageStore, knowledgeCutoff, meter });
      entries.set(key, resolved);
      return resolved;
      /* instrumentIdentityId is deliberately not part of the key: a per-ticker
         snapshot would be a per-ticker macro computation, which is forbidden. */
    },
  };
}

/**
 * G24-BUILD-12: the producer-declared completeness must agree with what the
 * snapshot actually resolved. A disagreement is a BUILD defect that fails closed;
 * it is never recorded as a classificationQuality value.
 */
export function assertMacroCoverageConsistent({ declaredCompleteness, snapshot }) {
  if (declaredCompleteness === undefined || declaredCompleteness === null) return { status: 'ALLOWED', code: null };
  if (!MACRO_FEATURE_COMPLETENESS_V1.includes(declaredCompleteness)) {
    return { status: 'FAIL_CLOSED', code: MACRO_REFUSAL_CODES_V1.completenessInconsistent };
  }
  return declaredCompleteness === snapshot?.macroFeatureCompleteness
    ? { status: 'ALLOWED', code: null }
    : { status: 'FAIL_CLOSED', code: MACRO_REFUSAL_CODES_V1.completenessInconsistent };
}

/** V-19 perimeter integrity: only CORE_V1 and populated OPTIONAL_V1 members may appear. */
export function assertMacroPerimeter({ macroContextBinding, snapshot }) {
  const admitted = new Set([
    ...macroContextBinding.coreSeriesCodes,
    ...macroContextBinding.derivedFeatureCodes,
    ...macroContextBinding.curveFeatureCodes,
    ...macroContextBinding.optionalSeriesCodes,
  ]);
  const intruder = [...Object.keys(snapshot.series), ...Object.keys(snapshot.derived)].find((code) => !admitted.has(code));
  return intruder === undefined
    ? { status: 'ALLOWED', code: null }
    : { status: 'BLOCKED', code: MACRO_REFUSAL_CODES_V1.silentPromotion, member: intruder };
}

export function describeMacroContextBoundary() {
  return Object.freeze({
    schemaVersion: MACRO_CONTEXT_BINDING_VERSION,
    boundaryName: 'GATE24_MACRO_CONTEXT_BOUNDARY',
    direction: 'GATE24 consumes prepared, versioned macro context; it never fetches, ingests or normalizes.',
    registryVersionId: MACRO_CONTEXT_REGISTRY_VERSION_ID,
    tiers: MACRO_TIERS_V1,
    architectureChain: MACRO_ARCHITECTURE_CHAIN_V1,
    coreBaseSeriesCount: MACRO_CORE_V1_BASE_SERIES_COUNT,
    derivedFeatureCount: MACRO_CORE_V1_DERIVED_FEATURES.length,
    curveFeatureCodes: MACRO_CORE_V1_CURVE_FEATURE_CODES,
    curveFeatureCodesRealizeDeclaredDerivedFeature: 'inversionFlags',
    optionalMemberCount: MACRO_OPTIONAL_V1_MEMBERS.length,
    macroFedDimensions: MACRO_FED_DIMENSION_NAMES_V1,
    completenessVocabulary: MACRO_FEATURE_COMPLETENESS_V1,
    completenessIsClassificationQuality: false,
    networkDuringClassification: 'FORBIDDEN',
    perTickerMacroFetch: 'FORBIDDEN',
    liveMacroFetcher: 'FORBIDDEN',
    historicalMacroPrecompute: 'ALLOWED_OFF_SCAN',
    liveScanCriticalPath: 'MUST_NOT_LENGTHEN',
    latencyTargetDelta: 'ZERO',
    refusalCodes: MACRO_REFUSAL_CODES_V1,
    vintageAdmission: 'governance/gates/GATE24/implementation/causal-admission-v1.mjs::admitMacroVintage',
  });
}

export { admitMacroVintage };
