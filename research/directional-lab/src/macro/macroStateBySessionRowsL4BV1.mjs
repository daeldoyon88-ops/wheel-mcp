/**
 * L4B-F1 MacroStateBySessionRows/1: compute, build and verify causal macro
 * feature rows for each official market session in the pinned source bundle.
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
  F1_SERIES_CODES,
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  compareMacroSessionOrderKeys,
  macroMarketSessionIdFor,
  normalizeMacroStateBySessionRowsV1,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMarketMacroFeatureSourceBundle } from './marketMacroFeatureSourceBundleL4BV1.mjs';
import { verifyMarketMacroFeatureComputationPolicy } from './marketMacroFeatureComputationPolicyL4BV1.mjs';
import { resolveMacroSeriesForSession } from './macroSeriesSessionResolutionL4BV1.mjs';
import { computeRateState } from './macroRateFeaturesL4BV1.mjs';
import { computeFomcState } from './macroFomcFeaturesL4BV1.mjs';
import { computeCurveState } from './macroCurveFeaturesL4BV1.mjs';

function completenessFromCounts(available, required) {
  if (required === 0) return 'UNAVAILABLE';
  if (available === required) return 'COMPLETE';
  if (available === 0) return 'UNAVAILABLE';
  return 'PARTIAL';
}

function buildAvailabilityState(orderedResolutions, curveState, rateState, fomcState, policy) {
  let availableSeriesCount = 0;
  let missingSeriesCount = 0;
  let staleSeriesCount = 0;
  let withdrawnSeriesCount = 0;
  for (const resolution of orderedResolutions) {
    if (resolution.availabilityStatus === 'AVAILABLE') availableSeriesCount += 1;
    else if (resolution.availabilityStatus === 'STALE') staleSeriesCount += 1;
    else if (resolution.availabilityStatus === 'WITHDRAWN') withdrawnSeriesCount += 1;
    else missingSeriesCount += 1;
  }
  const availableCurveSpreadCount = curveState.orderedSpreads
    .filter((spread) => spread.availabilityStatus === 'AVAILABLE').length;
  const requiredCurveSpreadCount = policy.curveShapePolicy.requiredSpreadCodes.length;
  const requiredAvailable = policy.curveShapePolicy.requiredSpreadCodes
    .filter((code) => curveState.orderedSpreads
      .some((spread) => spread.spreadCode === code && spread.availabilityStatus === 'AVAILABLE'))
    .length;

  const rateStateCompleteness = rateState.policyStateAvailability;
  const curveStateCompleteness = completenessFromCounts(requiredAvailable, requiredCurveSpreadCount);
  const fomcStateCompleteness = fomcState.fomcStateAvailability;

  let overallF1Completeness = 'COMPLETE';
  for (const part of [rateStateCompleteness, curveStateCompleteness, fomcStateCompleteness]) {
    if (part === 'UNAVAILABLE') {
      overallF1Completeness = overallF1Completeness === 'COMPLETE' ? 'UNAVAILABLE' : 'PARTIAL';
    } else if (part === 'PARTIAL') {
      overallF1Completeness = overallF1Completeness === 'UNAVAILABLE' ? 'PARTIAL' : 'PARTIAL';
    }
  }
  if ([rateStateCompleteness, curveStateCompleteness, fomcStateCompleteness]
    .every((part) => part === 'UNAVAILABLE')) {
    overallF1Completeness = 'UNAVAILABLE';
  } else if ([rateStateCompleteness, curveStateCompleteness, fomcStateCompleteness]
    .every((part) => part === 'COMPLETE')) {
    overallF1Completeness = 'COMPLETE';
  } else {
    overallF1Completeness = 'PARTIAL';
  }

  return {
    availableSeriesCount,
    missingSeriesCount,
    staleSeriesCount,
    withdrawnSeriesCount,
    availableCurveSpreadCount,
    requiredCurveSpreadCount,
    rateStateCompleteness,
    curveStateCompleteness,
    fomcStateCompleteness,
    overallF1Completeness,
  };
}

function rowProvenanceDigest(row) {
  return canonicalDigest({
    sessionId: row.sessionId,
    sessionCloseUtc: row.sessionCloseUtc,
    orderedSeriesResolutions: row.provenanceState.orderedSeriesResolutions.map((item) => ({
      canonicalSeriesCode: item.canonicalSeriesCode,
      observationIdentityId: item.observationIdentityId,
      macroVintageIdentityId: item.macroVintageIdentityId,
      availableAt: item.availableAt,
      availabilityStatus: item.availabilityStatus,
      carryForwardAgeSessions: item.carryForwardAgeSessions,
    })),
    orderedSpreads: row.curveState.orderedSpreads.map((spread) => ({
      spreadCode: spread.spreadCode,
      availabilityStatus: spread.availabilityStatus,
      leftVintageIdentityId: spread.leftVintageIdentityId,
      rightVintageIdentityId: spread.rightVintageIdentityId,
      effectiveAvailableAt: spread.effectiveAvailableAt,
    })),
    lastFomcReleaseEventVersionId: row.provenanceState.lastFomcReleaseEventVersionId,
    nextFomcReleaseEventVersionId: row.provenanceState.nextFomcReleaseEventVersionId,
  });
}

/**
 * Pure recomputation of MacroStateBySessionRows value from verified pins.
 */
export function computeMacroStateBySessionRowsValueV1(context) {
  const {
    store, sourceBundle, sourceBundleId, policy, featureComputationPolicyId,
    bindingContext, calendarSessionsAll, calendarSessionsInRange,
  } = context;
  const binding = bindingContext.binding;
  const vintageSet = bindingContext.vintageSet;
  const seriesRegistry = bindingContext.seriesRegistry;
  const calendarRegistry = bindingContext.calendarRegistry;

  const orderedSessionsAll = calendarSessionsAll.map((session) => {
    const sessionId = macroMarketSessionIdFor({
      marketCalendarRegistryManifestId: sourceBundle.marketCalendarRegistryManifestId,
      sessionDate: session.sessionDate,
      openUtc: session.openUtc,
      closeUtc: session.closeUtc,
    });
    return { ...session, sessionId };
  });
  const orderedSessionsInRange = calendarSessionsInRange.map((session) => {
    const sessionId = macroMarketSessionIdFor({
      marketCalendarRegistryManifestId: sourceBundle.marketCalendarRegistryManifestId,
      sessionDate: session.sessionDate,
      openUtc: session.openUtc,
      closeUtc: session.closeUtc,
    });
    return { ...session, sessionId };
  });
  orderedSessionsInRange.sort(compareMacroSessionOrderKeys);

  const rows = [];
  let previousRateState = null;
  let previousCurveState = null;
  let previousFomcState = null;
  let previousFomcMeta = {
    lastFomcReleaseEventVersionId: null,
  };

  for (const session of orderedSessionsInRange) {
    const orderedResolutions = [];
    for (const canonicalSeriesCode of F1_SERIES_CODES) {
      orderedResolutions.push(resolveMacroSeriesForSession({
        store,
        binding,
        policy,
        canonicalSeriesCode,
        session,
        orderedSessions: orderedSessionsAll,
        vintageSet,
        seriesRegistry,
      }));
    }

    const rateState = computeRateState({
      orderedResolutions, policy, previousRateState,
    });
    const fomcComputed = computeFomcState({
      store,
      binding,
      calendarRegistry,
      orderedResolutions,
      rateState,
      previousFomcState: previousFomcState === null ? null : {
        ...previousFomcState,
        lastFomcReleaseEventVersionId: previousFomcMeta.lastFomcReleaseEventVersionId,
      },
      session,
      orderedSessionsWithIds: orderedSessionsAll,
      seriesRegistry,
    });
    const curveState = computeCurveState({
      orderedResolutions, policy, previousCurveState, scale: policy.rateFeatureScale,
    });
    const availabilityState = buildAvailabilityState(
      orderedResolutions, curveState, rateState, fomcComputed.state, policy,
    );

    const draftRow = {
      sessionId: session.sessionId,
      sessionDate: session.sessionDate,
      sessionOpenUtc: session.openUtc,
      sessionCloseUtc: session.closeUtc,
      sessionKind: session.sessionKind,
      jurisdictionCode: sourceBundle.jurisdictionCode,
      currencyCode: sourceBundle.currencyCode,
      marketCalendarRegistryManifestId: sourceBundle.marketCalendarRegistryManifestId,
      macroDatasetBindingId: sourceBundle.macroDatasetBindingId,
      featureComputationPolicyId,
      sourceBundleId,
      rateState,
      fomcState: fomcComputed.state,
      curveState,
      availabilityState,
      provenanceState: {
        macroMaterializationReportId: sourceBundle.macroMaterializationReportId,
        sessionCloseUtc: session.closeUtc,
        orderedSeriesResolutions: orderedResolutions,
        lastFomcReleaseEventVersionId: fomcComputed.lastFomcReleaseEventVersionId,
        nextFomcReleaseEventVersionId: fomcComputed.nextFomcReleaseEventVersionId,
        orderedFeatureProvenanceDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
    };
    draftRow.provenanceState.orderedFeatureProvenanceDigest = rowProvenanceDigest(draftRow);
    rows.push(draftRow);

    previousRateState = rateState;
    previousCurveState = curveState;
    previousFomcState = fomcComputed.state;
    previousFomcMeta = {
      lastFomcReleaseEventVersionId: fomcComputed.lastFomcReleaseEventVersionId,
    };
  }

  return normalizeMacroStateBySessionRowsV1({
    schemaVersion: MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
    rows,
  });
}

export function computeMacroStateBySessionRows(input) {
  const api = assertApiInput(input, ['sourceBundleId', 'featureComputationPolicyId']);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.sourceBundleId, 'sourceBundleId');
  assertExplicitPinnedMacroId(api.featureComputationPolicyId, 'featureComputationPolicyId');
  assertCasId(api.sourceBundleId, 'sourceBundleId');
  assertCasId(api.featureComputationPolicyId, 'featureComputationPolicyId');

  const sourceContext = verifyMarketMacroFeatureSourceBundle({
    store: api.store, sourceBundleId: api.sourceBundleId,
  });
  const policyContext = verifyMarketMacroFeatureComputationPolicy({
    store: api.store, featureComputationPolicyId: api.featureComputationPolicyId,
  });
  if (policyContext.featureComputationPolicy.latestPolicy !== 'FORBIDDEN') {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_LATEST_FORBIDDEN',
      'computation refuses a latest-capable feature policy');
  }

  const value = computeMacroStateBySessionRowsValueV1({
    store: api.store,
    sourceBundle: sourceContext.sourceBundle,
    sourceBundleId: api.sourceBundleId,
    policy: policyContext.featureComputationPolicy,
    featureComputationPolicyId: api.featureComputationPolicyId,
    bindingContext: sourceContext.bindingContext,
    calendarSessionsAll: sourceContext.orderedSessionsAll,
    calendarSessionsInRange: sourceContext.orderedSessionsInRange,
  });
  return {
    macroStateBySessionRows: value,
    sourceContext,
    policyContext,
  };
}

export function buildMacroStateBySessionRows(input) {
  const computed = computeMacroStateBySessionRows(input);
  const stored = putCanonicalL3(input.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
    computed.macroStateBySessionRows);
  // Full recompute verification is available via verifyMacroStateBySessionRows;
  // builders pin by content-address and avoid a second O(sessions×vintages) pass.
  return {
    macroStateBySessionRowsId: stored.objectId,
    macroStateBySessionRows: stored.value,
  };
}

export function verifyMacroStateBySessionRows(input) {
  const api = assertApiInput(input, [
    'macroStateBySessionRowsId', 'sourceBundleId', 'featureComputationPolicyId',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.macroStateBySessionRowsId, 'macroStateBySessionRowsId');
  assertCasId(api.macroStateBySessionRowsId, 'macroStateBySessionRowsId');
  const raw = readTypedReference(api.store, api.macroStateBySessionRowsId,
    MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, 'macro state by session rows');
  const rows = normalizeMacroStateBySessionRowsV1(raw);
  const recomputed = computeMacroStateBySessionRows({
    store: api.store,
    sourceBundleId: api.sourceBundleId,
    featureComputationPolicyId: api.featureComputationPolicyId,
  });
  if (!canonicalValuesEqual(rows, recomputed.macroStateBySessionRows)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_STATE_ROWS_MISMATCH',
      'stored MacroStateBySessionRows diverge from recomputed rows');
  }
  for (const row of rows.rows) {
    if (row.sourceBundleId !== api.sourceBundleId
        || row.featureComputationPolicyId !== api.featureComputationPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_REFERENCE_MISMATCH',
        'row pins diverge from verification pins');
    }
  }
  return {
    macroStateBySessionRowsId: api.macroStateBySessionRowsId,
    macroStateBySessionRows: rows,
  };
}
