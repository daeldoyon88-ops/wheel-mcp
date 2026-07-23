/**
 * L4B-F2 MarketMacroFullComputationReport/1: fully recomputed counters and
 * digests over the full-state rows and instrument rows. No caller-supplied
 * derived field is trusted; the verifier recomputes every row and counter.
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
  MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
  MACRO_INFLATION_REGIMES,
  MACRO_LABOR_REGIMES,
  MACRO_CLAIMS_REGIMES,
  MACRO_COMPOSITE_STATES,
  MACRO_PROJECTION_STATUSES,
  F2_SERIES_CODES,
  normalizeMarketMacroFullComputationReportV1,
} from '../contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMarketMacroInstrumentRows } from './marketMacroInstrumentRowsL4BF2V1.mjs';

function emptyCountMap(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function bump(map, key) {
  map[key] += 1;
}

function f2SeriesIdentityIds(seriesRegistry) {
  const ids = new Set();
  for (const entry of seriesRegistry.orderedSeriesEntries) {
    if (F2_SERIES_CODES.includes(entry.canonicalSeriesCode) && entry.status === 'ACTIVE') {
      ids.add(entry.macroSeriesIdentityId);
    }
  }
  return ids;
}

export function computeMarketMacroFullComputationReportValueV1(context) {
  const {
    ids, fullRows, instrumentRows, bindingContext, sourceBundle, instrumentIdentityCount,
  } = context;

  const inflationRegimeCounts = emptyCountMap(MACRO_INFLATION_REGIMES);
  const laborRegimeCounts = emptyCountMap(MACRO_LABOR_REGIMES);
  const claimsRegimeCounts = emptyCountMap(MACRO_CLAIMS_REGIMES);
  const compositeStateCounts = emptyCountMap(MACRO_COMPOSITE_STATES);
  const projectionStatusCounts = emptyCountMap(MACRO_PROJECTION_STATUSES);

  let completeMacroSessionCount = 0;
  let partialMacroSessionCount = 0;
  let unavailableMacroSessionCount = 0;
  let cpiAvailableSessionCount = 0;
  let cpiStaleSessionCount = 0;
  let cpiWithdrawnSessionCount = 0;
  let cpiNotAvailableSessionCount = 0;
  let unrateAvailableSessionCount = 0;
  let unrateStaleSessionCount = 0;
  let unrateWithdrawnSessionCount = 0;
  let unrateNotAvailableSessionCount = 0;
  let claimsAvailableSessionCount = 0;
  let claimsStaleSessionCount = 0;
  let claimsWithdrawnSessionCount = 0;
  let claimsNotAvailableSessionCount = 0;

  for (const row of fullRows.rows) {
    bump(inflationRegimeCounts, row.fullMacroRegimeState.inflationRegime);
    bump(laborRegimeCounts, row.fullMacroRegimeState.laborRegime);
    bump(claimsRegimeCounts, row.fullMacroRegimeState.claimsRegime);
    bump(compositeStateCounts, row.fullMacroRegimeState.macroCompositeState);
    const completeness = row.fullAvailabilityState.fullMacroCompleteness;
    if (completeness === 'COMPLETE') completeMacroSessionCount += 1;
    else if (completeness === 'PARTIAL') partialMacroSessionCount += 1;
    else unavailableMacroSessionCount += 1;
    switch (row.inflationState.cpiAvailabilityStatus) {
      case 'AVAILABLE': cpiAvailableSessionCount += 1; break;
      case 'STALE': cpiStaleSessionCount += 1; break;
      case 'WITHDRAWN': cpiWithdrawnSessionCount += 1; break;
      default: cpiNotAvailableSessionCount += 1; break;
    }
    switch (row.unemploymentState.unemploymentAvailabilityStatus) {
      case 'AVAILABLE': unrateAvailableSessionCount += 1; break;
      case 'STALE': unrateStaleSessionCount += 1; break;
      case 'WITHDRAWN': unrateWithdrawnSessionCount += 1; break;
      default: unrateNotAvailableSessionCount += 1; break;
    }
    switch (row.claimsState.claimsAvailabilityStatus) {
      case 'AVAILABLE': claimsAvailableSessionCount += 1; break;
      case 'STALE': claimsStaleSessionCount += 1; break;
      case 'WITHDRAWN': claimsWithdrawnSessionCount += 1; break;
      default: claimsNotAvailableSessionCount += 1; break;
    }
  }

  for (const row of instrumentRows.rows) {
    bump(projectionStatusCounts, row.projectionStatus);
  }

  // Future data rejected relative to each session close, scoped to F2 series
  // (deterministic, pin-relative, never a CAS scan).
  const f2Ids = f2SeriesIdentityIds(bindingContext.seriesRegistry);
  let futureObservationRejectedCount = 0;
  let futureRevisionRejectedCount = 0;
  let futureCalendarUpdateRejectedCount = 0;
  for (const row of fullRows.rows) {
    for (const observation of bindingContext.vintageSet.orderedObservationEntries) {
      if (!f2Ids.has(observation.macroSeriesIdentityId)) continue;
      if (observation.observationPeriodStart > row.sessionDate) futureObservationRejectedCount += 1;
    }
    for (const observation of bindingContext.vintageSet.orderedObservationEntries) {
      if (!f2Ids.has(observation.macroSeriesIdentityId)) continue;
      for (const vintage of observation.orderedVintages) {
        if (vintage.availableAt > row.sessionCloseUtc) futureRevisionRejectedCount += 1;
      }
    }
    for (const version of bindingContext.calendarRegistry.orderedReleaseEventVersions) {
      if (!f2Ids.has(version.macroSeriesIdentityId)) continue;
      if (version.calendarKnowledgeAvailableAt > row.sessionCloseUtc) {
        futureCalendarUpdateRejectedCount += 1;
      }
    }
  }

  const sessionCount = fullRows.rows.length;
  const first = sessionCount === 0 ? null : fullRows.rows[0];
  const last = sessionCount === 0 ? null : fullRows.rows[sessionCount - 1];

  return normalizeMarketMacroFullComputationReportV1({
    schemaVersion: MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
    f1SourceBundleId: ids.f1SourceBundleId,
    f1FeatureComputationPolicyId: ids.f1FeatureComputationPolicyId,
    f1MacroStateBySessionRowsId: ids.f1MacroStateBySessionRowsId,
    f1MacroFeatureComputationReportId: ids.f1MacroFeatureComputationReportId,
    fullStateRowsId: ids.fullStateRowsId,
    instrumentProjectionPolicyId: ids.instrumentProjectionPolicyId,
    instrumentRowsId: ids.instrumentRowsId,
    macroDatasetBindingId: sourceBundle.macroDatasetBindingId,
    marketCalendarRegistryManifestId: sourceBundle.marketCalendarRegistryManifestId,
    instrumentIdentityRegistryManifestId: ids.instrumentIdentityRegistryManifestId,
    firstSessionId: first?.sessionId ?? null,
    lastSessionId: last?.sessionId ?? null,
    firstSessionDate: first?.sessionDate ?? null,
    lastSessionDate: last?.sessionDate ?? null,
    sessionCount,
    instrumentCount: instrumentIdentityCount,
    fullStateRowCount: fullRows.rows.length,
    instrumentRowCount: instrumentRows.rows.length,
    completeMacroSessionCount,
    partialMacroSessionCount,
    unavailableMacroSessionCount,
    cpiAvailableSessionCount,
    cpiStaleSessionCount,
    cpiWithdrawnSessionCount,
    cpiNotAvailableSessionCount,
    unrateAvailableSessionCount,
    unrateStaleSessionCount,
    unrateWithdrawnSessionCount,
    unrateNotAvailableSessionCount,
    claimsAvailableSessionCount,
    claimsStaleSessionCount,
    claimsWithdrawnSessionCount,
    claimsNotAvailableSessionCount,
    projectedInstrumentRowCount: projectionStatusCounts.PROJECTED,
    partialInstrumentRowCount: projectionStatusCounts.PARTIAL,
    notApplicableInstrumentRowCount: projectionStatusCounts.NOT_APPLICABLE,
    sessionMismatchInstrumentRowCount: projectionStatusCounts.SESSION_MISMATCH,
    futureObservationRejectedCount,
    futureRevisionRejectedCount,
    futureCalendarUpdateRejectedCount,
    inflationRegimeCounts,
    laborRegimeCounts,
    claimsRegimeCounts,
    compositeStateCounts,
    projectionStatusCounts,
    orderedFullStateRowDigest: canonicalDigest(fullRows.rows.map((row) => canonicalDigest(row))),
    orderedInstrumentRowDigest: canonicalDigest(instrumentRows.rows.map((row) => row.provenanceDigest)),
    orderedFullProvenanceDigest: canonicalDigest(
      fullRows.rows.map((row) => row.fullProvenanceState.orderedFullProvenanceDigest),
    ),
    emptyComputation: sessionCount === 0,
  });
}

const REPORT_INPUT_FIELDS = Object.freeze([
  'fullStateRowsId', 'instrumentRowsId', 'f1MacroStateBySessionRowsId', 'f1SourceBundleId',
  'f1FeatureComputationPolicyId', 'f1MacroFeatureComputationReportId',
  'instrumentProjectionPolicyId', 'instrumentIdentityRegistryManifestId',
]);

function computeReport(store, api) {
  const instrumentContext = verifyMarketMacroInstrumentRows({
    store,
    instrumentRowsId: api.instrumentRowsId,
    fullStateRowsId: api.fullStateRowsId,
    f1MacroStateBySessionRowsId: api.f1MacroStateBySessionRowsId,
    f1SourceBundleId: api.f1SourceBundleId,
    f1FeatureComputationPolicyId: api.f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: api.f1MacroFeatureComputationReportId,
    instrumentProjectionPolicyId: api.instrumentProjectionPolicyId,
    instrumentIdentityRegistryManifestId: api.instrumentIdentityRegistryManifestId,
  });
  const fullContext = instrumentContext.fullContext;
  const sourceBundle = fullContext.context.sourceContext.sourceBundle;
  const bindingContext = fullContext.context.sourceContext.bindingContext;
  const value = computeMarketMacroFullComputationReportValueV1({
    ids: {
      f1SourceBundleId: api.f1SourceBundleId,
      f1FeatureComputationPolicyId: api.f1FeatureComputationPolicyId,
      f1MacroStateBySessionRowsId: api.f1MacroStateBySessionRowsId,
      f1MacroFeatureComputationReportId: api.f1MacroFeatureComputationReportId,
      fullStateRowsId: api.fullStateRowsId,
      instrumentProjectionPolicyId: api.instrumentProjectionPolicyId,
      instrumentRowsId: api.instrumentRowsId,
      instrumentIdentityRegistryManifestId: api.instrumentIdentityRegistryManifestId,
    },
    fullRows: fullContext.marketMacroFullStateRows,
    instrumentRows: instrumentContext.marketMacroInstrumentRows,
    bindingContext,
    sourceBundle,
    instrumentIdentityCount: instrumentContext.instrumentRegistry.identityBundles.length,
  });
  return { value, instrumentContext };
}

export function computeMarketMacroFullComputationReport(input) {
  const api = assertApiInput(input, REPORT_INPUT_FIELDS);
  assertStore(api.store, MACRO_STORE_METHODS);
  for (const field of REPORT_INPUT_FIELDS) {
    assertExplicitPinnedMacroId(api[field], field);
    assertCasId(api[field], field);
  }
  const { value, instrumentContext } = computeReport(api.store, api);
  return { fullComputationReport: value, instrumentContext };
}

export function buildMarketMacroFullComputationReport(input) {
  const computed = computeMarketMacroFullComputationReport(input);
  const stored = putCanonicalL3(input.store, MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
    computed.fullComputationReport);
  return {
    fullComputationReportId: stored.objectId,
    fullComputationReport: stored.value,
  };
}

export function verifyMarketMacroFullComputationReport(input) {
  const api = assertApiInput(input, ['fullComputationReportId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.fullComputationReportId, 'fullComputationReportId');
  assertCasId(api.fullComputationReportId, 'fullComputationReportId');
  const raw = readTypedReference(api.store, api.fullComputationReportId,
    MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION, 'macro full computation report');
  const report = normalizeMarketMacroFullComputationReportV1(raw);
  const { value: expected } = computeReport(api.store, {
    fullStateRowsId: report.fullStateRowsId,
    instrumentRowsId: report.instrumentRowsId,
    f1MacroStateBySessionRowsId: report.f1MacroStateBySessionRowsId,
    f1SourceBundleId: report.f1SourceBundleId,
    f1FeatureComputationPolicyId: report.f1FeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: report.f1MacroFeatureComputationReportId,
    instrumentProjectionPolicyId: report.instrumentProjectionPolicyId,
    instrumentIdentityRegistryManifestId: report.instrumentIdentityRegistryManifestId,
  });
  if (!canonicalValuesEqual(report, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FULL_REPORT_MISMATCH',
      'stored MarketMacroFullComputationReport diverges from the recomputed report');
  }
  return {
    fullComputationReportId: api.fullComputationReportId,
    fullComputationReport: report,
  };
}
