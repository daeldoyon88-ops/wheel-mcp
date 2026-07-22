/**
 * L4B-F1 MarketMacroFeatureComputationReport/1: fully recomputed counters and
 * digests over MacroStateBySessionRows. No caller-supplied derived fields.
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
  MACRO_FEATURE_COMPLETENESS,
  MACRO_FEATURE_CURVE_SHAPES,
  MACRO_FEATURE_POLICY_DIRECTIONS,
  MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  normalizeMarketMacroFeatureComputationReportV1,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMarketMacroFeatureSourceBundle } from './marketMacroFeatureSourceBundleL4BV1.mjs';
import { verifyMarketMacroFeatureComputationPolicy } from './marketMacroFeatureComputationPolicyL4BV1.mjs';
import {
  computeMacroStateBySessionRows,
  verifyMacroStateBySessionRows,
} from './macroStateBySessionRowsL4BV1.mjs';

function emptyCountMap(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function bump(map, key) {
  if (!Object.hasOwn(map, key)) map[key] = 0;
  map[key] += 1;
}

/**
 * Recompute the full report value from verified source bundle, policy and rows.
 */
export function computeMarketMacroFeatureComputationReportValueV1(context) {
  const {
    sourceBundleId, featureComputationPolicyId, macroStateBySessionRowsId,
    sourceBundle, rows,
    bindingContext, orderedSessionsAll,
  } = context;
  const binding = bindingContext.binding;
  const countsByPolicyDirection = emptyCountMap(MACRO_FEATURE_POLICY_DIRECTIONS);
  const countsByCurveShape = emptyCountMap(MACRO_FEATURE_CURVE_SHAPES);
  const countsByCompleteness = emptyCountMap(MACRO_FEATURE_COMPLETENESS);

  let completeSessionCount = 0;
  let partialSessionCount = 0;
  let unavailableSessionCount = 0;
  let sessionWithFomcDecisionCount = 0;
  let easingSessionCount = 0;
  let tighteningSessionCount = 0;
  let holdSessionCount = 0;
  let normalCurveSessionCount = 0;
  let flatCurveSessionCount = 0;
  let partiallyInvertedCurveSessionCount = 0;
  let invertedCurveSessionCount = 0;
  let mixedCurveSessionCount = 0;
  let missingSeriesResolutionCount = 0;
  let staleSeriesResolutionCount = 0;
  let withdrawnSeriesResolutionCount = 0;
  let futureObservationRejectedCount = 0;
  let futureVintageRejectedCount = 0;
  let futureCalendarUpdateRejectedCount = 0;

  for (const row of rows.rows) {
    bump(countsByPolicyDirection, row.rateState.policyDirection);
    bump(countsByCurveShape, row.curveState.curveShape);
    bump(countsByCompleteness, row.availabilityState.overallF1Completeness);

    if (row.availabilityState.overallF1Completeness === 'COMPLETE') completeSessionCount += 1;
    else if (row.availabilityState.overallF1Completeness === 'PARTIAL') partialSessionCount += 1;
    else unavailableSessionCount += 1;

    if (row.fomcState.fomcDecisionDuringSession) sessionWithFomcDecisionCount += 1;
    if (row.rateState.policyDirection === 'EASING') easingSessionCount += 1;
    if (row.rateState.policyDirection === 'TIGHTENING') tighteningSessionCount += 1;
    if (row.rateState.policyDirection === 'UNCHANGED') holdSessionCount += 1;

    if (row.curveState.curveShape === 'NORMAL') normalCurveSessionCount += 1;
    if (row.curveState.curveShape === 'FLAT') flatCurveSessionCount += 1;
    if (row.curveState.curveShape === 'PARTIALLY_INVERTED') partiallyInvertedCurveSessionCount += 1;
    if (row.curveState.curveShape === 'INVERTED') invertedCurveSessionCount += 1;
    if (row.curveState.curveShape === 'MIXED') mixedCurveSessionCount += 1;

    for (const resolution of row.provenanceState.orderedSeriesResolutions) {
      if (resolution.availabilityStatus === 'NOT_AVAILABLE'
          || resolution.availabilityStatus === 'SERIES_NOT_IN_BINDING') {
        missingSeriesResolutionCount += 1;
      }
      if (resolution.availabilityStatus === 'STALE') staleSeriesResolutionCount += 1;
      if (resolution.availabilityStatus === 'WITHDRAWN') withdrawnSeriesResolutionCount += 1;
    }
  }

  // Future vintage / calendar knowledge relative to each session close, counted
  // once over the pinned authorities (deterministic, no CAS scan).
  for (const row of rows.rows) {
    for (const observation of bindingContext.vintageSet.orderedObservationEntries) {
      for (const vintageEntry of observation.orderedVintages) {
        if (vintageEntry.availableAt > row.sessionCloseUtc) futureVintageRejectedCount += 1;
      }
    }
    for (const version of bindingContext.calendarRegistry.orderedReleaseEventVersions) {
      if (version.calendarKnowledgeAvailableAt > row.sessionCloseUtc) {
        futureCalendarUpdateRejectedCount += 1;
      }
    }
  }

  // Observations whose period start is after session close never resolve; count
  // distinct observation identities with periodStart > last session close when
  // sessions exist, else zero. Keep deterministic and pin-relative.
  if (rows.rows.length > 0) {
    const lastClose = rows.rows[rows.rows.length - 1].sessionCloseUtc;
    for (const observation of bindingContext.vintageSet.orderedObservationEntries) {
      if (observation.observationPeriodStart > lastClose.slice(0, 10)) {
        futureObservationRejectedCount += 1;
      }
    }
  }

  const sessionCount = rows.rows.length;
  const first = sessionCount === 0 ? null : rows.rows[0];
  const last = sessionCount === 0 ? null : rows.rows[sessionCount - 1];

  return normalizeMarketMacroFeatureComputationReportV1({
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    sourceBundleId,
    featureComputationPolicyId,
    macroStateBySessionRowsId,
    macroDatasetBindingId: sourceBundle.macroDatasetBindingId,
    macroMaterializationReportId: sourceBundle.macroMaterializationReportId,
    marketCalendarRegistryManifestId: sourceBundle.marketCalendarRegistryManifestId,
    firstSessionId: first?.sessionId ?? null,
    lastSessionId: last?.sessionId ?? null,
    firstSessionDate: first?.sessionDate ?? null,
    lastSessionDate: last?.sessionDate ?? null,
    sessionCount,
    completeSessionCount,
    partialSessionCount,
    unavailableSessionCount,
    sessionWithFomcDecisionCount,
    easingSessionCount,
    tighteningSessionCount,
    holdSessionCount,
    normalCurveSessionCount,
    flatCurveSessionCount,
    partiallyInvertedCurveSessionCount,
    invertedCurveSessionCount,
    mixedCurveSessionCount,
    missingSeriesResolutionCount,
    staleSeriesResolutionCount,
    withdrawnSeriesResolutionCount,
    futureObservationRejectedCount,
    futureVintageRejectedCount,
    futureCalendarUpdateRejectedCount,
    orderedSessionIdentityDigest: canonicalDigest(rows.rows.map((row) => row.sessionId)),
    orderedRowIdentityDigest: canonicalDigest(rows.rows.map((row) => ({
      sessionId: row.sessionId,
      sourceBundleId: row.sourceBundleId,
      featureComputationPolicyId: row.featureComputationPolicyId,
    }))),
    orderedFeatureProvenanceDigest: canonicalDigest(
      rows.rows.map((row) => row.provenanceState.orderedFeatureProvenanceDigest),
    ),
    countsByPolicyDirection,
    countsByCurveShape,
    countsByCompleteness,
    emptyComputation: sessionCount === 0,
  });
}

export function buildMarketMacroFeatureComputationReport(input) {
  const api = assertApiInput(input, [
    'sourceBundleId', 'featureComputationPolicyId', 'macroStateBySessionRowsId',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  for (const field of [
    'sourceBundleId', 'featureComputationPolicyId', 'macroStateBySessionRowsId',
  ]) {
    assertExplicitPinnedMacroId(api[field], field);
    assertCasId(api[field], field);
  }

  const sourceContext = verifyMarketMacroFeatureSourceBundle({
    store: api.store, sourceBundleId: api.sourceBundleId,
  });
  verifyMarketMacroFeatureComputationPolicy({
    store: api.store, featureComputationPolicyId: api.featureComputationPolicyId,
  });
  const rowsContext = verifyMacroStateBySessionRows({
    store: api.store,
    macroStateBySessionRowsId: api.macroStateBySessionRowsId,
    sourceBundleId: api.sourceBundleId,
    featureComputationPolicyId: api.featureComputationPolicyId,
  });

  const report = computeMarketMacroFeatureComputationReportValueV1({
    sourceBundleId: api.sourceBundleId,
    featureComputationPolicyId: api.featureComputationPolicyId,
    macroStateBySessionRowsId: api.macroStateBySessionRowsId,
    sourceBundle: sourceContext.sourceBundle,
    rows: rowsContext.macroStateBySessionRows,
    bindingContext: sourceContext.bindingContext,
    orderedSessionsAll: sourceContext.orderedSessionsAll,
  });
  const stored = putCanonicalL3(api.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    report);
  return {
    macroFeatureComputationReportId: stored.objectId,
    featureComputationReport: stored.value,
  };
}

export function verifyMarketMacroFeatureComputationReport(input) {
  const api = assertApiInput(input, ['macroFeatureComputationReportId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroFeatureComputationReportId,
    'macroFeatureComputationReportId');
  assertCasId(api.macroFeatureComputationReportId, 'macroFeatureComputationReportId');
  const raw = readTypedReference(api.store, api.macroFeatureComputationReportId,
    MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, 'macro feature computation report');
  const report = normalizeMarketMacroFeatureComputationReportV1(raw);

  const sourceContext = verifyMarketMacroFeatureSourceBundle({
    store: api.store, sourceBundleId: report.sourceBundleId,
  });
  verifyMarketMacroFeatureComputationPolicy({
    store: api.store, featureComputationPolicyId: report.featureComputationPolicyId,
  });
  const rowsContext = verifyMacroStateBySessionRows({
    store: api.store,
    macroStateBySessionRowsId: report.macroStateBySessionRowsId,
    sourceBundleId: report.sourceBundleId,
    featureComputationPolicyId: report.featureComputationPolicyId,
  });

  // Full recompute of rows then report (byte-for-byte).
  const recomputedRows = computeMacroStateBySessionRows({
    store: api.store,
    sourceBundleId: report.sourceBundleId,
    featureComputationPolicyId: report.featureComputationPolicyId,
  });
  if (!canonicalValuesEqual(rowsContext.macroStateBySessionRows,
    recomputedRows.macroStateBySessionRows)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_STATE_ROWS_MISMATCH',
      'report rows pin diverges from recomputed rows');
  }

  const expected = computeMarketMacroFeatureComputationReportValueV1({
    sourceBundleId: report.sourceBundleId,
    featureComputationPolicyId: report.featureComputationPolicyId,
    macroStateBySessionRowsId: report.macroStateBySessionRowsId,
    sourceBundle: sourceContext.sourceBundle,
    rows: recomputedRows.macroStateBySessionRows,
    bindingContext: sourceContext.bindingContext,
    orderedSessionsAll: sourceContext.orderedSessionsAll,
  });
  if (!canonicalValuesEqual(report, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_REPORT_MISMATCH',
      'stored macro feature report diverges from recomputed report');
  }
  return {
    macroFeatureComputationReportId: api.macroFeatureComputationReportId,
    featureComputationReport: report,
  };
}
