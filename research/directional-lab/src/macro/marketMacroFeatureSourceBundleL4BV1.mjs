/**
 * L4B-F1 MarketMacroFeatureSourceBundle/1: pin binding+report+calendar and a
 * civil session-date range. All authority refs are derived from verified
 * binding — free contradictory refs are refused.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertCivilDate,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_POLICY_VERSION,
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketMacroFeatureSourceBundleV1,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  assertMacroMaterializationUtcInstant,
  normalizeMacroMaterializationReportV1,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroDatasetBinding } from './macroDatasetBindingL4BV1.mjs';
import { verifyMarketCalendarRegistry } from '../contracts/marketCalendarL3V1.mjs';

function assertDerivedOnlyInput(api) {
  for (const field of [
    'macroDatasetSnapshotManifestId', 'macroVintageSetManifestId',
    'macroSeriesRegistryManifestId', 'macroReleaseCalendarRegistryManifestId',
    'macroIngestionPolicyId', 'macroAsOfResolutionPolicyId',
    'jurisdictionCode', 'currencyCode', 'temporalCapability',
    'sourceBundlePolicyVersion',
  ]) {
    if (Object.hasOwn(api, field)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_INVALID',
        `source bundle builder derives ${field}; free caller values are refused`);
    }
  }
}

function listOrderedSessions(calendarRegistryContext) {
  const sessions = [];
  for (const calendar of calendarRegistryContext.calendars) {
    for (const session of calendar.sessions) {
      sessions.push({
        sessionDate: session.sessionDate,
        sessionKind: session.sessionKind,
        openUtc: session.openUtc,
        closeUtc: session.closeUtc,
      });
    }
  }
  sessions.sort((left, right) => {
    if (left.sessionDate < right.sessionDate) return -1;
    if (left.sessionDate > right.sessionDate) return 1;
    if (left.openUtc < right.openUtc) return -1;
    if (left.openUtc > right.openUtc) return 1;
    if (left.closeUtc < right.closeUtc) return -1;
    if (left.closeUtc > right.closeUtc) return 1;
    return 0;
  });
  return sessions;
}

function expectedBundleValue(derived) {
  return normalizeMarketMacroFeatureSourceBundleV1({
    schemaVersion: MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
    sourceBundlePolicyVersion: MARKET_MACRO_FEATURE_SOURCE_BUNDLE_POLICY_VERSION,
    ...derived,
  });
}

function loadPinnedMaterializationReport(store, macroMaterializationReportId, expectedBindingId) {
  assertExplicitPinnedMacroId(macroMaterializationReportId, 'macroMaterializationReportId');
  assertCasId(macroMaterializationReportId, 'macroMaterializationReportId');
  const raw = readTypedReference(store, macroMaterializationReportId,
    MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, 'macro materialization report');
  const materializationReport = normalizeMacroMaterializationReportV1(raw);
  if (materializationReport.macroDatasetBindingId !== expectedBindingId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_MISMATCH',
      'materialization report is pinned to a different binding');
  }
  return materializationReport;
}

/**
 * Build a source bundle from pinned binding, materialization report, market
 * calendar registry and inclusive civil session dates.
 */
export function buildMarketMacroFeatureSourceBundle(input) {
  const api = assertApiInput(input, [
    'macroDatasetBindingId', 'macroMaterializationReportId',
    'marketCalendarRegistryManifestId',
    'featureComputationStartSessionDate', 'featureComputationEndSessionDateInclusive',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  for (const field of [
    'macroDatasetBindingId', 'macroMaterializationReportId', 'marketCalendarRegistryManifestId',
  ]) {
    assertExplicitPinnedMacroId(api[field], field);
    assertCasId(api[field], field);
  }
  assertCivilDate(api.featureComputationStartSessionDate, 'featureComputationStartSessionDate');
  assertCivilDate(api.featureComputationEndSessionDateInclusive,
    'featureComputationEndSessionDateInclusive');
  assertDerivedOnlyInput(api);

  const bindingContext = verifyMacroDatasetBinding({
    store: api.store, macroDatasetBindingId: api.macroDatasetBindingId,
  });
  loadPinnedMaterializationReport(
    api.store, api.macroMaterializationReportId, api.macroDatasetBindingId,
  );
  const calendarContext = verifyMarketCalendarRegistry({
    store: api.store, calendarRegistryManifestId: api.marketCalendarRegistryManifestId,
  });
  const sessions = listOrderedSessions(calendarContext);
  const start = api.featureComputationStartSessionDate;
  const end = api.featureComputationEndSessionDateInclusive;
  if (start > end) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_INVALID',
      'featureComputationStartSessionDate must be <= end inclusive');
  }
  const inRange = sessions.filter((session) => session.sessionDate >= start
    && session.sessionDate <= end);
  if (inRange.length > 0) {
    const endSession = inRange[inRange.length - 1];
    assertMacroMaterializationUtcInstant(endSession.closeUtc, 'endSession.closeUtc');
    if (bindingContext.binding.knowledgeCutoff < endSession.closeUtc) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SESSION_CUTOFF_INVALID',
        'binding knowledgeCutoff must be >= end session closeUtc');
    }
  }

  const binding = bindingContext.binding;
  const bundle = expectedBundleValue({
    macroDatasetBindingId: api.macroDatasetBindingId,
    macroMaterializationReportId: api.macroMaterializationReportId,
    macroDatasetSnapshotManifestId: binding.macroDatasetSnapshotManifestId,
    macroVintageSetManifestId: binding.macroVintageSetManifestId,
    macroSeriesRegistryManifestId: binding.macroSeriesRegistryManifestId,
    macroReleaseCalendarRegistryManifestId: binding.macroReleaseCalendarRegistryManifestId,
    macroIngestionPolicyId: binding.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: binding.macroAsOfResolutionPolicyId,
    marketCalendarRegistryManifestId: api.marketCalendarRegistryManifestId,
    featureComputationStartSessionDate: start,
    featureComputationEndSessionDateInclusive: end,
    jurisdictionCode: binding.jurisdictionCode,
    currencyCode: binding.currencyCode,
    temporalCapability: binding.temporalCapability,
  });

  const stored = putCanonicalL3(api.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, bundle);
  verifyMarketMacroFeatureSourceBundle({
    store: api.store, sourceBundleId: stored.objectId,
  });
  return { sourceBundleId: stored.objectId, sourceBundle: stored.value };
}

export function verifyMarketMacroFeatureSourceBundle(input) {
  const api = assertApiInput(input, ['sourceBundleId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.sourceBundleId, 'sourceBundleId');
  assertCasId(api.sourceBundleId, 'sourceBundleId');
  const raw = readTypedReference(api.store, api.sourceBundleId,
    MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, 'macro feature source bundle');
  const bundle = normalizeMarketMacroFeatureSourceBundleV1(raw);

  if (bundle.sourceBundlePolicyVersion !== MARKET_MACRO_FEATURE_SOURCE_BUNDLE_POLICY_VERSION) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_MISMATCH',
      'sourceBundlePolicyVersion diverges from closed V1');
  }

  const bindingContext = verifyMacroDatasetBinding({
    store: api.store, macroDatasetBindingId: bundle.macroDatasetBindingId,
  });
  const materializationReport = loadPinnedMaterializationReport(
    api.store, bundle.macroMaterializationReportId, bundle.macroDatasetBindingId,
  );
  const calendarContext = verifyMarketCalendarRegistry({
    store: api.store, calendarRegistryManifestId: bundle.marketCalendarRegistryManifestId,
  });

  const binding = bindingContext.binding;
  for (const [field, expected] of [
    ['macroDatasetSnapshotManifestId', binding.macroDatasetSnapshotManifestId],
    ['macroVintageSetManifestId', binding.macroVintageSetManifestId],
    ['macroSeriesRegistryManifestId', binding.macroSeriesRegistryManifestId],
    ['macroReleaseCalendarRegistryManifestId', binding.macroReleaseCalendarRegistryManifestId],
    ['macroIngestionPolicyId', binding.macroIngestionPolicyId],
    ['macroAsOfResolutionPolicyId', binding.macroAsOfResolutionPolicyId],
    ['jurisdictionCode', binding.jurisdictionCode],
    ['currencyCode', binding.currencyCode],
    ['temporalCapability', binding.temporalCapability],
  ]) {
    if (bundle[field] !== expected) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_MISMATCH',
        `source bundle ${field} diverges from verified binding`);
    }
  }

  const sessions = listOrderedSessions(calendarContext);
  const inRange = sessions.filter((session) => (
    session.sessionDate >= bundle.featureComputationStartSessionDate
    && session.sessionDate <= bundle.featureComputationEndSessionDateInclusive
  ));
  if (inRange.length > 0) {
    const endSession = inRange[inRange.length - 1];
    if (binding.knowledgeCutoff < endSession.closeUtc) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SESSION_CUTOFF_INVALID',
        'binding knowledgeCutoff must be >= end session closeUtc');
    }
  }

  const expected = expectedBundleValue({
    macroDatasetBindingId: bundle.macroDatasetBindingId,
    macroMaterializationReportId: bundle.macroMaterializationReportId,
    macroDatasetSnapshotManifestId: binding.macroDatasetSnapshotManifestId,
    macroVintageSetManifestId: binding.macroVintageSetManifestId,
    macroSeriesRegistryManifestId: binding.macroSeriesRegistryManifestId,
    macroReleaseCalendarRegistryManifestId: binding.macroReleaseCalendarRegistryManifestId,
    macroIngestionPolicyId: binding.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: binding.macroAsOfResolutionPolicyId,
    marketCalendarRegistryManifestId: bundle.marketCalendarRegistryManifestId,
    featureComputationStartSessionDate: bundle.featureComputationStartSessionDate,
    featureComputationEndSessionDateInclusive: bundle.featureComputationEndSessionDateInclusive,
    jurisdictionCode: binding.jurisdictionCode,
    currencyCode: binding.currencyCode,
    temporalCapability: binding.temporalCapability,
  });
  if (!canonicalValuesEqual(bundle, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_CANONICAL_MISMATCH',
      'source bundle diverges from its recomputed canonical value');
  }

  return {
    sourceBundleId: api.sourceBundleId,
    sourceBundle: bundle,
    bindingContext,
    reportContext: {
      macroMaterializationReportId: bundle.macroMaterializationReportId,
      materializationReport,
    },
    calendarContext,
    orderedSessionsInRange: inRange,
    orderedSessionsAll: sessions,
  };
}

export { listOrderedSessions };
