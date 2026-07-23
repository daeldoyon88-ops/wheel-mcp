/**
 * L4B-F2 MarketMacroFullStateRows/1: enrich each pinned L4B-F1 session row with
 * CPI, UNRATE and claims causal state and a limited full macro regime, without
 * mutating the F1 row. The verifier reloads the F1 rows, recomputes F2 and
 * compares byte-for-byte.
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
  MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
  F2_CPI_SERIES_CODE,
  F2_UNRATE_SERIES_CODE,
  F2_CLAIMS_SERIES_CODE,
  normalizeMarketMacroFullStateRowsV1,
} from '../contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  normalizeMacroStateBySessionRowsV1,
  normalizeMarketMacroFeatureComputationReportV1,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMarketMacroFeatureSourceBundle } from './marketMacroFeatureSourceBundleL4BV1.mjs';
import { verifyMarketMacroFeatureComputationPolicy } from './marketMacroFeatureComputationPolicyL4BV1.mjs';
import { verifyMarketMacroFeatureComputationReport } from './marketMacroFeatureComputationReportL4BV1.mjs';
import { verifyMarketMacroInstrumentProjectionPolicy } from './marketMacroInstrumentProjectionPolicyL4BF2V1.mjs';
import { buildMonthlyWeeklySeriesIndex } from './macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';
import { computeInflationState } from './macroInflationFeaturesL4BF2V1.mjs';
import { computeUnemploymentState } from './macroLaborFeaturesL4BF2V1.mjs';
import { computeClaimsState } from './macroClaimsFeaturesL4BF2V1.mjs';
import { computeFullMacroState } from './macroFullMacroStateL4BF2V1.mjs';

const F2_INPUT_FIELDS = Object.freeze([
  'f1MacroStateBySessionRowsId', 'f1SourceBundleId', 'f1FeatureComputationPolicyId',
  'f1MacroFeatureComputationReportId', 'instrumentProjectionPolicyId',
]);

function provenanceDigest(context) {
  return canonicalDigest({
    sessionId: context.sessionId,
    sessionCloseUtc: context.sessionCloseUtc,
    f1SessionId: context.f1SessionId,
    f1MacroStateBySessionRowsId: context.f1MacroStateBySessionRowsId,
    cpi: {
      observationVintageId: context.inflation.cpiProvenance.observationVintageId,
      macroVintageIdentityId: context.inflation.cpiProvenance.macroVintageIdentityId,
      availableAt: context.inflation.cpiAvailableAt,
      status: context.inflation.cpiAvailabilityStatus,
    },
    unrate: {
      observationVintageId: context.labor.unemploymentProvenance.observationVintageId,
      macroVintageIdentityId: context.labor.unemploymentProvenance.macroVintageIdentityId,
      availableAt: context.labor.unemploymentAvailableAt,
      status: context.labor.unemploymentAvailabilityStatus,
    },
    claims: {
      observationVintageId: context.claims.claimsProvenance.observationVintageId,
      macroVintageIdentityId: context.claims.claimsProvenance.macroVintageIdentityId,
      availableAt: context.claims.claimsAvailableAt,
      status: context.claims.claimsAvailabilityStatus,
    },
  });
}

/**
 * Pure recomputation of the F2 full-state rows from verified F1 rows, the pinned
 * binding and the closed projection policy (thresholds).
 */
export function computeMarketMacroFullStateRowsValueV1(context) {
  const {
    f1MacroStateBySessionRowsId, f1SourceBundleId, f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId, projectionPolicyId, projectionPolicy,
    f1Rows, bindingContext,
  } = context;
  const vintageSet = bindingContext.vintageSet;
  const seriesRegistry = bindingContext.seriesRegistry;
  const store = context.store;

  const cpiIndex = buildMonthlyWeeklySeriesIndex({
    store, vintageSet, seriesRegistry, canonicalSeriesCode: F2_CPI_SERIES_CODE,
  });
  const unrateIndex = buildMonthlyWeeklySeriesIndex({
    store, vintageSet, seriesRegistry, canonicalSeriesCode: F2_UNRATE_SERIES_CODE,
  });
  const claimsIndex = buildMonthlyWeeklySeriesIndex({
    store, vintageSet, seriesRegistry, canonicalSeriesCode: F2_CLAIMS_SERIES_CODE,
  });

  const rows = [];
  for (const f1Row of f1Rows.rows) {
    const knowledgeCutoff = f1Row.sessionCloseUtc;
    const sessionMonthKey = f1Row.sessionDate.slice(0, 7);
    const inflation = computeInflationState({
      cpiIndex, knowledgeCutoff, sessionMonthKey, policy: projectionPolicy,
    });
    const labor = computeUnemploymentState({
      unrateIndex, knowledgeCutoff, sessionMonthKey, policy: projectionPolicy,
    });
    const claims = computeClaimsState({
      claimsIndex, knowledgeCutoff, sessionDate: f1Row.sessionDate, policy: projectionPolicy,
    });
    const full = computeFullMacroState({
      f1Row, inflation, labor, claims, policy: projectionPolicy,
    });

    const digest = provenanceDigest({
      sessionId: f1Row.sessionId,
      sessionCloseUtc: f1Row.sessionCloseUtc,
      f1SessionId: f1Row.sessionId,
      f1MacroStateBySessionRowsId,
      inflation: inflation.inflationState,
      labor: labor.unemploymentState,
      claims: claims.claimsState,
    });

    rows.push({
      sessionId: f1Row.sessionId,
      sessionDate: f1Row.sessionDate,
      sessionOpenUtc: f1Row.sessionOpenUtc,
      sessionCloseUtc: f1Row.sessionCloseUtc,
      f1StateReference: {
        f1MacroStateBySessionRowsId,
        f1SourceBundleId,
        f1FeatureComputationPolicyId,
        f1MacroFeatureComputationReportId,
        f1SessionId: f1Row.sessionId,
        f1SessionCloseUtc: f1Row.sessionCloseUtc,
        f1OverallCompleteness: f1Row.availabilityState.overallF1Completeness,
        nominalRateRegime: full.f1StateReferenceRegime.nominalRateRegime,
        curveRegime: full.f1StateReferenceRegime.curveRegime,
        policyDirection: full.f1StateReferenceRegime.policyDirection,
      },
      inflationState: inflation.inflationState,
      unemploymentState: labor.unemploymentState,
      claimsState: claims.claimsState,
      fullMacroRegimeState: full.fullMacroRegimeState,
      fullAvailabilityState: full.fullAvailabilityState,
      fullProvenanceState: {
        f1MacroStateBySessionRowsId,
        f1SessionId: f1Row.sessionId,
        sessionCloseUtc: f1Row.sessionCloseUtc,
        cpiObservationVintageId: inflation.inflationState.cpiProvenance.observationVintageId,
        unrateObservationVintageId: labor.unemploymentState.unemploymentProvenance.observationVintageId,
        claimsObservationVintageId: claims.claimsState.claimsProvenance.observationVintageId,
        orderedFullProvenanceDigest: digest,
      },
    });
  }

  return normalizeMarketMacroFullStateRowsV1({
    schemaVersion: MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
    f1MacroStateBySessionRowsId,
    f1SourceBundleId,
    f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId,
    projectionPolicyId,
    rows,
  });
}

/**
 * Load the pinned F1 quartet plus the projection policy. F1 is consumed by
 * content address: the source bundle (and its binding graph), policy and full
 * F1 computation report are verified. The F1 report verifier recomputes its
 * pinned rows, so no freely supplied F1 row or schema-only report can enter F2.
 */
export function loadFullStateContext(store, api) {
  const sourceContext = verifyMarketMacroFeatureSourceBundle({
    store, sourceBundleId: api.f1SourceBundleId,
  });
  verifyMarketMacroFeatureComputationPolicy({
    store, featureComputationPolicyId: api.f1FeatureComputationPolicyId,
  });
  const f1RowsRaw = readTypedReference(store, api.f1MacroStateBySessionRowsId,
    MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, 'F1 macro state by session rows');
  const f1Rows = normalizeMacroStateBySessionRowsV1(f1RowsRaw);
  for (const row of f1Rows.rows) {
    if (row.sourceBundleId !== api.f1SourceBundleId
        || row.featureComputationPolicyId !== api.f1FeatureComputationPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_F2_SOURCE_MISMATCH',
        'F1 rows do not pin the F1 source bundle and policy supplied to F2');
    }
  }
  const f1ReportContext = verifyMarketMacroFeatureComputationReport({
    store, macroFeatureComputationReportId: api.f1MacroFeatureComputationReportId,
  });
  const f1Report = normalizeMarketMacroFeatureComputationReportV1(
    f1ReportContext.featureComputationReport,
  );
  if (f1Report.sourceBundleId !== api.f1SourceBundleId
      || f1Report.featureComputationPolicyId !== api.f1FeatureComputationPolicyId
      || f1Report.macroStateBySessionRowsId !== api.f1MacroStateBySessionRowsId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_F2_SOURCE_MISMATCH',
      'F1 report does not pin the F1 source bundle, policy and rows supplied to F2');
  }
  const projectionPolicyContext = verifyMarketMacroInstrumentProjectionPolicy({
    store, instrumentProjectionPolicyId: api.instrumentProjectionPolicyId,
  });
  return { sourceContext, f1Rows, f1Report, projectionPolicyContext };
}

export function computeMarketMacroFullStateRows(input) {
  const api = assertApiInput(input, F2_INPUT_FIELDS);
  assertStore(api.store, MACRO_STORE_METHODS);
  for (const field of F2_INPUT_FIELDS) {
    assertExplicitPinnedMacroId(api[field], field);
    assertCasId(api[field], field);
  }
  const ctx = loadFullStateContext(api.store, api);
  const projectionPolicy = ctx.projectionPolicyContext.instrumentProjectionPolicy;
  if (projectionPolicy.latestPolicy !== 'FORBIDDEN' || projectionPolicy.networkPolicy !== 'FORBIDDEN') {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_F2_LATEST_FORBIDDEN',
      'F2 computation refuses a latest or network capable projection policy');
  }
  const value = computeMarketMacroFullStateRowsValueV1({
    store: api.store,
    f1MacroStateBySessionRowsId: api.f1MacroStateBySessionRowsId,
    f1SourceBundleId: api.f1SourceBundleId,
    f1FeatureComputationPolicyId: api.f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: api.f1MacroFeatureComputationReportId,
    projectionPolicyId: api.instrumentProjectionPolicyId,
    projectionPolicy,
    f1Rows: ctx.f1Rows,
    bindingContext: ctx.sourceContext.bindingContext,
  });
  return { marketMacroFullStateRows: value, context: ctx };
}

export function buildMarketMacroFullStateRows(input) {
  const computed = computeMarketMacroFullStateRows(input);
  const stored = putCanonicalL3(input.store, MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
    computed.marketMacroFullStateRows);
  return {
    fullStateRowsId: stored.objectId,
    marketMacroFullStateRows: stored.value,
    context: computed.context,
  };
}

export function verifyMarketMacroFullStateRows(input) {
  const api = assertApiInput(input, ['fullStateRowsId', ...F2_INPUT_FIELDS]);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.fullStateRowsId, 'fullStateRowsId');
  assertCasId(api.fullStateRowsId, 'fullStateRowsId');
  const raw = readTypedReference(api.store, api.fullStateRowsId,
    MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION, 'macro full state rows');
  const rows = normalizeMarketMacroFullStateRowsV1(raw);
  for (const [field, expected] of [
    ['f1MacroStateBySessionRowsId', api.f1MacroStateBySessionRowsId],
    ['f1SourceBundleId', api.f1SourceBundleId],
    ['f1FeatureComputationPolicyId', api.f1FeatureComputationPolicyId],
    ['f1MacroFeatureComputationReportId', api.f1MacroFeatureComputationReportId],
    ['projectionPolicyId', api.instrumentProjectionPolicyId],
  ]) {
    if (rows[field] !== expected) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_F2_REFERENCE_MISMATCH',
        `stored full state rows ${field} diverges from the verification pins`);
    }
  }
  const recomputed = computeMarketMacroFullStateRows({
    store: api.store,
    f1MacroStateBySessionRowsId: api.f1MacroStateBySessionRowsId,
    f1SourceBundleId: api.f1SourceBundleId,
    f1FeatureComputationPolicyId: api.f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: api.f1MacroFeatureComputationReportId,
    instrumentProjectionPolicyId: api.instrumentProjectionPolicyId,
  });
  if (!canonicalValuesEqual(rows, recomputed.marketMacroFullStateRows)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FULL_ROWS_MISMATCH',
      'stored MarketMacroFullStateRows diverge from recomputed rows');
  }
  return {
    fullStateRowsId: api.fullStateRowsId,
    marketMacroFullStateRows: rows,
    context: recomputed.context,
  };
}
