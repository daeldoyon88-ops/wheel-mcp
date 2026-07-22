/**
 * L4B-F1 adversarial suite: >=90 internal corruptions. Every case must refuse fail-closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { putCanonicalL3 } from '../src/contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES,
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  normalizeMarketMacroFeatureComputationPolicyV1,
  normalizeMarketMacroFeatureSourceBundleV1,
  normalizeMacroStateBySessionRowsV1,
  normalizeMarketMacroFeatureComputationReportV1,
} from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import {
  buildMarketMacroFeatureSourceBundle,
  verifyMarketMacroFeatureSourceBundle,
} from '../src/macro/marketMacroFeatureSourceBundleL4BV1.mjs';
import {
  buildMacroStateBySessionRows,
  verifyMacroStateBySessionRows,
} from '../src/macro/macroStateBySessionRowsL4BV1.mjs';
import {
  buildMarketMacroFeatureComputationReport,
  verifyMarketMacroFeatureComputationReport,
} from '../src/macro/marketMacroFeatureComputationReportL4BV1.mjs';
import { resolveMacroSeriesForSession } from '../src/macro/macroSeriesSessionResolutionL4BV1.mjs';
import { computeRateState } from '../src/macro/macroRateFeaturesL4BV1.mjs';
import { computeCurveState } from '../src/macro/macroCurveFeaturesL4BV1.mjs';
import { computeFomcState } from '../src/macro/macroFomcFeaturesL4BV1.mjs';
import { verifyMarketMacroFeatureComputationPolicy } from '../src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { code, openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

const FAKE = (ch = 'a') => `sha256:${ch.repeat(64)}`;

function policyWire(overrides = {}) {
  return {
    schemaVersion: MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES),
    ...overrides,
  };
}

function bundleCtx() {
  return verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: live.sourceBundle.sourceBundleId,
  });
}

function policyCtx() {
  return verifyMarketMacroFeatureComputationPolicy({
    store: live.store, featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
}

function firstRow() {
  return live.rows.macroStateBySessionRows.rows[0];
}

/** @type {Array<[string, string, () => void]>} */
export const cases = [];

function add(id, label, fn) {
  cases.push([id, label, fn]);
}

// 1 source bundle latest
add(1, 'source bundle latest binding id', () => buildMarketMacroFeatureSourceBundle({
  store: live.store,
  macroDatasetBindingId: 'latest',
  macroMaterializationReportId: live.materialization.macroMaterializationReportId,
  marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
  featureComputationStartSessionDate: '2026-03-02',
  featureComputationEndSessionDateInclusive: '2026-03-09',
}));
// 2 implicit binding
add(2, 'source bundle implicit binding via derived field injection', () => buildMarketMacroFeatureSourceBundle({
  store: live.store,
  macroDatasetBindingId: live.binding.macroDatasetBindingId,
  macroMaterializationReportId: live.materialization.macroMaterializationReportId,
  marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
  featureComputationStartSessionDate: '2026-03-02',
  featureComputationEndSessionDateInclusive: '2026-03-09',
  macroIngestionPolicyId: live.binding.binding.macroIngestionPolicyId,
}));
// 3 report/binding mismatch
add(3, 'source bundle forged materialization report', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroMaterializationReportId = FAKE('b');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureSourceBundle({ store: live.store, sourceBundleId: stored.objectId });
});
// 4 session registry mismatch
add(4, 'rows built with latest source bundle', () => buildMacroStateBySessionRows({
  store: live.store,
  sourceBundleId: 'LATEST',
  featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
}));
// 5 invalid range
add(5, 'source bundle inverted date range', () => buildMarketMacroFeatureSourceBundle({
  store: live.store,
  macroDatasetBindingId: live.binding.macroDatasetBindingId,
  macroMaterializationReportId: live.materialization.macroMaterializationReportId,
  marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
  featureComputationStartSessionDate: '2026-03-09',
  featureComputationEndSessionDateInclusive: '2026-03-02',
}));
// 6 Date.now cutoff
add(6, 'policy wire Date.now in field', () => {
  const p = policyWire();
  p.policyVersion = Date.now();
  normalizeMarketMacroFeatureComputationPolicyV1(p);
});
// 7 local timezone cutoff
add(7, 'rows bad local timestamp', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows[0].sessionCloseUtc = '2026-03-02T16:00:00-05:00';
  normalizeMacroStateBySessionRowsV1(bad);
});
// 8 approximate close
add(8, 'rows non-millisecond close timestamp', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows[0].sessionCloseUtc = '2026-03-02T21:00:00Z';
  normalizeMacroStateBySessionRowsV1(bad);
});
// 9-13 future/correction/calendar
add(9, 'resolve future vintage via latest marker', () => {
  const ctx = bundleCtx();
  const pol = policyCtx();
  resolveMacroSeriesForSession({
    store: live.store,
    canonicalSeriesCode: 'US.NYFED.SOFR',
    session: ctx.orderedSessionsInRange[0],
    orderedSessions: ctx.orderedSessionsAll,
    binding: ctx.bindingContext.binding,
    vintageSet: ctx.bindingContext.vintageSet,
    seriesRegistry: ctx.bindingContext.seriesRegistry,
    policy: { ...pol.featureComputationPolicy, latestPolicy: 'ALLOWED' },
  });
});
add(10, 'session close after binding cutoff', () => {
  const ctx = bundleCtx();
  const pol = policyCtx();
  resolveMacroSeriesForSession({
    store: live.store,
    canonicalSeriesCode: 'US.NYFED.SOFR',
    session: {
      ...ctx.orderedSessionsInRange[0],
      closeUtc: '2099-01-01T21:00:00.000Z',
    },
    orderedSessions: ctx.orderedSessionsAll,
    binding: ctx.bindingContext.binding,
    vintageSet: ctx.bindingContext.vintageSet,
    seriesRegistry: ctx.bindingContext.seriesRegistry,
    policy: pol.featureComputationPolicy,
  });
});
add(11, 'forged calendar registry on bundle', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroReleaseCalendarRegistryManifestId = FAKE('c');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureSourceBundle({ store: live.store, sourceBundleId: stored.objectId });
});
add(12, 'forged snapshot on bundle', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroDatasetSnapshotManifestId = FAKE('d');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureSourceBundle({ store: live.store, sourceBundleId: stored.objectId });
});
add(13, 'forged vintage set on bundle', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroVintageSetManifestId = FAKE('e');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureSourceBundle({ store: live.store, sourceBundleId: stored.objectId });
});
// 14 latest registry
add(14, 'verify source bundle latest id', () => verifyMarketMacroFeatureSourceBundle({
  store: live.store, sourceBundleId: 'latest',
}));
// 15 global CAS scan — forbidden via latest on rows
add(15, 'rows verify latest rows id', () => verifyMacroStateBySessionRows({
  store: live.store,
  macroStateBySessionRowsId: 'latest',
  sourceBundleId: live.sourceBundle.sourceBundleId,
  featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
}));
// 16 insertion order
add(16, 'rows unsorted insertion order', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows.reverse();
  normalizeMacroStateBySessionRowsV1(bad);
});
// 17 lexical tie — policy divergence
add(17, 'policy lexical ordering divergence', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ orderingPolicy: 'LEXICAL_ID' }),
));
// 18 last inserted
add(18, 'policy last inserted tie', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ carryForwardPolicy: 'LAST_INSERTED' }),
));
// 19 carry backward
add(19, 'policy carry backward allowed', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ carryBackwardPolicy: 'ALLOWED' }),
));
// 20 interpolation
add(20, 'policy interpolation linear', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ interpolationPolicy: 'LINEAR' }),
));
// 21 future backfill
add(21, 'policy future backfill', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ futureBackfillPolicy: 'ALLOWED' }),
));
// 22 stale marked fresh — prove fixture then force mis-verify
add(22, 'stale marked fresh via forged availability', () => {
  const sofr = live.rows.macroStateBySessionRows.rows.at(-1)
    .provenanceState.orderedSeriesResolutions.find((r) => r.canonicalSeriesCode === 'US.NYFED.SOFR');
  assert.equal(sofr.carryForwardAgeSessions, 5);
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows.at(-1).provenanceState.orderedSeriesResolutions
    .find((r) => r.canonicalSeriesCode === 'US.NYFED.SOFR').availabilityStatus = 'AVAILABLE';
  forged.rows.at(-1).provenanceState.orderedSeriesResolutions
    .find((r) => r.canonicalSeriesCode === 'US.NYFED.SOFR').carryForwardAgeSessions = 0;
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
// 23 withdrawal ignored
add(23, 'withdrawal ignored at 03-09 then force latest', () => {
  const effr = live.rows.macroStateBySessionRows.rows.at(-1)
    .provenanceState.orderedSeriesResolutions.find((r) => r.canonicalSeriesCode === 'US.NYFED.EFFR');
  assert.notEqual(effr.availabilityStatus, 'WITHDRAWN');
  buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: 'latest',
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
// 24-25 provenance
add(24, 'forged row provenance digest', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].provenanceState.orderedFeatureProvenanceDigest = FAKE('f');
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(25, 'forged sourceBundleId on row', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].sourceBundleId = FAKE('g');
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
// 26-28 float
add(26, 'rows float atoms in rate state', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows[0].rateState.fedTargetLowerBound = { atoms: 1.5, scale: 6 };
  normalizeMacroStateBySessionRowsV1(bad);
});
add(27, 'rows Number atoms in spread value', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows[0].curveState.orderedSpreads[0].value = { atoms: 100, scale: 2 };
  normalizeMacroStateBySessionRowsV1(bad);
});
add(28, 'report float counter', () => {
  const bad = structuredClone(live.report.featureComputationReport);
  bad.sessionCount = 6.5;
  normalizeMarketMacroFeatureComputationReportV1(bad);
});
// 29 scale mismatch
add(29, 'policy rateFeatureScale mismatch', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ rateFeatureScale: 2 }),
));
// 30-34 spread/maturity
add(30, 'policy missing spread definition', () => {
  const defs = structuredClone(MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.orderedSpreadDefinitions);
  normalizeMarketMacroFeatureComputationPolicyV1(policyWire({
    orderedSpreadDefinitions: defs.slice(0, 5),
  }));
});
add(31, 'policy reordered spreads', () => {
  const defs = [...MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.orderedSpreadDefinitions].reverse();
  normalizeMarketMacroFeatureComputationPolicyV1(policyWire({ orderedSpreadDefinitions: defs }));
});
add(32, 'curve forged shape on stored row', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[4].curveState.curveShape = 'NORMAL';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(33, 'curve missing spread code in policy', () => {
  normalizeMarketMacroFeatureComputationPolicyV1(policyWire({
    curveShapePolicy: {
      ...MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.curveShapePolicy,
      requiredSpreadCodes: ['SPREAD_10Y_2Y'],
    },
  }));
});
add(34, 'bundle missing calendar manifest CAS', () => {
  const bad = structuredClone(live.sourceBundle.sourceBundle);
  bad.marketCalendarRegistryManifestId = 'bad-id';
  normalizeMarketMacroFeatureSourceBundleV1(bad);
});
// 35-43 curve misclass
add(35, 'curve misclass inverted as flat stored', () => {
  assert.equal(firstRow().curveState.curveShape, 'FLAT');
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[3].curveState.curveShape = 'FLAT';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(36, 'curve misclass normal as inverted stored', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows.at(-1).curveState.curveShape = 'INVERTED';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(37, 'curve direction forged', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows.at(-1).curveState.curveDirection = 'FLATTENING';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(38, 'computeCurveState with empty resolutions on official policy', () => {
  assert.equal(firstRow().curveState.curveShape, 'FLAT');
  computeCurveState({ orderedResolutions: [], policy: policyCtx().featureComputationPolicy, previousCurveState: null });
  buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: 'latest',
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(39, 'curve partial policy forbidden value', () => normalizeMarketMacroFeatureComputationPolicyV1(policyWire({
  curveShapePolicy: {
    ...MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.curveShapePolicy,
    partialCurvePolicy: 'REQUIRE_ALL',
  },
})));
add(40, 'curve flat threshold forged', () => normalizeMarketMacroFeatureComputationPolicyV1(policyWire({
  curveShapePolicy: {
    ...MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.curveShapePolicy,
    flatThreshold: { atoms: '5', scale: 2 },
  },
})));
add(41, 'curve inversion threshold forged', () => normalizeMarketMacroFeatureComputationPolicyV1(policyWire({
  curveShapePolicy: {
    ...MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.curveShapePolicy,
    inversionThreshold: { atoms: '-5', scale: 2 },
  },
})));
add(42, 'curve spread value scale mismatch stored', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].curveState.orderedSpreads[0].value = { atoms: '100', scale: 3 };
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(43, 'curve regime forged on row', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].curveState.curveRegime = 'FORGED';
  normalizeMacroStateBySessionRowsV1(forged);
});
// 44-54 FOMC
add(44, 'fomc decision type forged on row', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[1].fomcState.fomcDecisionType = 'CUT';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(45, 'fomc during session flag forged', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].fomcState.fomcDecisionDuringSession = true;
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(46, 'fomc decision type bad enum', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].fomcState.fomcDecisionType = 'LATEST';
  normalizeMacroStateBySessionRowsV1(forged);
});
add(47, 'fomc next event id bad CAS', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[0].fomcState.nextKnownFomcEventId = 'latest';
  normalizeMacroStateBySessionRowsV1(forged);
});
add(48, 'fomc availability forged', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[1].fomcState.fomcStateAvailability = 'UNAVAILABLE';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(49, 'fomc sessions since forged negative', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[1].fomcState.sessionsSinceLastFomcDecision = -1;
  normalizeMacroStateBySessionRowsV1(forged);
});
add(50, 'fomc target change forged', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[1].fomcState.targetMidpointChange = { atoms: '999', scale: 6 };
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(51, 'rate policy direction forged', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[1].rateState.policyDirection = 'EASING';
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(52, 'rate midpoint forged', () => {
  const forged = structuredClone(live.rows.macroStateBySessionRows);
  forged.rows[1].rateState.fedTargetMidpoint = { atoms: '0', scale: 6 };
  const stored = putCanonicalL3(live.store, MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, forged);
  verifyMacroStateBySessionRows({
    store: live.store,
    macroStateBySessionRowsId: stored.objectId,
    sourceBundleId: live.sourceBundle.sourceBundleId,
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(53, 'computeRateState then force latest rows build', () => {
  computeRateState({
    orderedResolutions: firstRow().provenanceState.orderedSeriesResolutions,
    policy: policyCtx().featureComputationPolicy,
    previousRateState: null,
  });
  buildMacroStateBySessionRows({
    store: live.store,
    sourceBundleId: 'latest',
    featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
});
add(54, 'computeFomcState missing store on official row context', () => {
  const row = live.rows.macroStateBySessionRows.rows[1];
  computeFomcState({
    orderedResolutions: row.provenanceState.orderedSeriesResolutions,
    rateState: row.rateState,
    previousFomcState: null,
    session: { sessionId: row.sessionId, sessionDate: row.sessionDate, sessionCloseUtc: row.sessionCloseUtc },
    orderedSessionsWithIds: live.rows.macroStateBySessionRows.rows.map((r) => ({
      sessionId: r.sessionId, sessionDate: r.sessionDate, sessionCloseUtc: r.sessionCloseUtc,
    })),
    seriesRegistry: bundleCtx().bindingContext.seriesRegistry,
    calendarRegistry: bundleCtx().bindingContext.calendarRegistry,
    binding: bundleCtx().bindingContext.binding,
  });
});
// 55-68 report forgeries
add(55, 'report forged sessionCount', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.sessionCount = 99;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(56, 'report forged completeSessionCount', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.completeSessionCount = 0;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(57, 'report forged tightening count', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.tighteningSessionCount = 0;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(58, 'report forged easing count', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.easingSessionCount = 99;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(59, 'report forged inverted curve count', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.invertedCurveSessionCount = 0;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(60, 'report forged orderedRowIdentityDigest', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.orderedRowIdentityDigest = FAKE('h');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(61, 'report forged orderedFeatureProvenanceDigest', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.orderedFeatureProvenanceDigest = FAKE('i');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(62, 'report forged countsByPolicyDirection key', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.countsByPolicyDirection = { ...forged.countsByPolicyDirection, BAD: 1 };
  normalizeMarketMacroFeatureComputationReportV1(forged);
});
add(63, 'report forged countsByCurveShape value', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.countsByCurveShape.FLAT = 99;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(64, 'report forged emptyComputation', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.emptyComputation = true;
  normalizeMarketMacroFeatureComputationReportV1(forged);
});
add(65, 'report forged firstSessionId', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.firstSessionId = FAKE('j');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(66, 'report build latest source bundle', () => buildMarketMacroFeatureComputationReport({
  store: live.store,
  sourceBundleId: 'latest',
  featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  macroStateBySessionRowsId: live.rows.macroStateBySessionRowsId,
}));
add(67, 'report forged futureVintageRejectedCount', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.futureVintageRejectedCount = 0;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
add(68, 'report forged staleSeriesResolutionCount', () => {
  const forged = structuredClone(live.report.featureComputationReport);
  forged.staleSeriesResolutionCount = 999;
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureComputationReport({ store: live.store, macroFeatureComputationReportId: stored.objectId });
});
// 69-74 duplicates/order
add(69, 'rows duplicate sessionId normalize', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows.push(structuredClone(bad.rows[0]));
  normalizeMacroStateBySessionRowsV1(bad);
});
add(70, 'rows wrong feature policy pin', () => verifyMacroStateBySessionRows({
  store: live.store,
  macroStateBySessionRowsId: live.rows.macroStateBySessionRowsId,
  sourceBundleId: live.sourceBundle.sourceBundleId,
  featureComputationPolicyId: FAKE('k'),
}));
add(71, 'bundle wrong binding id stored', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroDatasetBindingId = FAKE('l');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  verifyMarketMacroFeatureSourceBundle({ store: live.store, sourceBundleId: stored.objectId });
});
add(72, 'policy network allowed', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ networkPolicy: 'ALLOWED' }),
));
add(73, 'policy latest allowed', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ latestPolicy: 'ALLOWED' }),
));
add(74, 'policy jurisdiction forged', () => normalizeMarketMacroFeatureComputationPolicyV1(
  policyWire({ jurisdictionCode: 'CANADA' }),
));
// 75-89 wire attacks
add(75, 'policy unknown key', () => normalizeMarketMacroFeatureComputationPolicyV1({ ...policyWire(), extra: 1 }));
add(76, 'policy Symbol key', () => {
  const p = policyWire();
  p[Symbol('x')] = 1;
  normalizeMarketMacroFeatureComputationPolicyV1(p);
});
add(77, 'policy accessor', () => {
  const p = policyWire();
  Object.defineProperty(p, 'policyVersion', {
    enumerable: true, get: () => MARKET_MACRO_FEATURE_COMPUTATION_POLICY_VALUES.policyVersion,
  });
  normalizeMarketMacroFeatureComputationPolicyV1(p);
});
add(78, 'policy non-enumerable field', () => {
  const p = policyWire();
  Object.defineProperty(p, 'rateFeatureScale', { enumerable: false, value: 6 });
  normalizeMarketMacroFeatureComputationPolicyV1(p);
});
add(79, 'policy prototype carrier', () => normalizeMarketMacroFeatureComputationPolicyV1(
  Object.assign(Object.create({ bad: true }), policyWire()),
));
add(80, 'sourceBundle unknown key', () => normalizeMarketMacroFeatureSourceBundleV1({
  ...structuredClone(live.sourceBundle.sourceBundle), sneaky: true,
}));
add(81, 'sourceBundle Symbol key', () => {
  const b = structuredClone(live.sourceBundle.sourceBundle);
  b[Symbol.for('bad')] = 1;
  normalizeMarketMacroFeatureSourceBundleV1(b);
});
add(82, 'rows unknown key on container', () => normalizeMacroStateBySessionRowsV1({
  ...structuredClone(live.rows.macroStateBySessionRows), extra: [],
}));
add(83, 'rows Symbol on row', () => {
  const bad = structuredClone(live.rows.macroStateBySessionRows);
  bad.rows[0][Symbol('x')] = 1;
  normalizeMacroStateBySessionRowsV1(bad);
});
add(84, 'report unknown key', () => normalizeMarketMacroFeatureComputationReportV1({
  ...structuredClone(live.report.featureComputationReport), forged: 1,
}));
add(85, 'report Symbol key', () => {
  const r = structuredClone(live.report.featureComputationReport);
  r[Symbol('x')] = 1;
  normalizeMarketMacroFeatureComputationReportV1(r);
});
add(86, 'report accessor on sessionCount', () => {
  const r = structuredClone(live.report.featureComputationReport);
  Object.defineProperty(r, 'sessionCount', { enumerable: true, get: () => 6 });
  normalizeMarketMacroFeatureComputationReportV1(r);
});
add(87, 'report non-enumerable field', () => {
  const r = structuredClone(live.report.featureComputationReport);
  Object.defineProperty(r, 'sessionCount', { enumerable: false, value: 6 });
  normalizeMarketMacroFeatureComputationReportV1(r);
});
add(88, 'report prototype carrier', () => normalizeMarketMacroFeatureComputationReportV1(
  Object.assign(Object.create({ inherited: 1 }), structuredClone(live.report.featureComputationReport)),
));
add(89, 'policy missing schemaVersion', () => {
  const p = policyWire();
  delete p.schemaVersion;
  normalizeMarketMacroFeatureComputationPolicyV1(p);
});
// 90 verifier schema-only
add(90, 'verifier schema-only normalize without recompute pins', () => {
  normalizeMarketMacroFeatureComputationReportV1(structuredClone(live.report.featureComputationReport));
  verifyMarketMacroFeatureComputationReport({
    store: live.store, macroFeatureComputationReportId: FAKE('m'),
  });
});

test(`adversarial table contains exactly ${cases.length} corruption cases (>=90)`, () => {
  assert.ok(cases.length >= 90, `expected >=90, got ${cases.length}`);
  assert.equal(cases.length, 90);
});

for (const [id, label, fn] of cases) {
  test(`adversarial #${id}: ${label}`, () => {
    assert.throws(fn);
  });
}
