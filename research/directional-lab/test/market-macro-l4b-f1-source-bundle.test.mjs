import test from 'node:test';
import assert from 'node:assert/strict';
import { putCanonicalL3 } from '../src/contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
  normalizeMarketMacroFeatureSourceBundleV1,
} from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import {
  buildMarketMacroFeatureSourceBundle,
  verifyMarketMacroFeatureSourceBundle,
} from '../src/macro/marketMacroFeatureSourceBundleL4BV1.mjs';
import { code, openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

const FAKE = (ch = 'a') => `sha256:${ch.repeat(64)}`;

test('official source bundle verifies', () => {
  const verified = verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: live.sourceBundle.sourceBundleId,
  });
  assert.equal(verified.orderedSessionsInRange.length, 6);
  assert.equal(verified.sourceBundle.featureComputationStartSessionDate, '2026-03-02');
  assert.equal(verified.sourceBundle.featureComputationEndSessionDateInclusive, '2026-03-09');
});

test('source bundle derives binding refs and refuses free caller fields', () => {
  assert.throws(() => buildMarketMacroFeatureSourceBundle({
    store: live.store,
    macroDatasetBindingId: live.binding.macroDatasetBindingId,
    macroMaterializationReportId: live.materialization.macroMaterializationReportId,
    marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
    featureComputationStartSessionDate: '2026-03-02',
    featureComputationEndSessionDateInclusive: '2026-03-09',
    jurisdictionCode: 'UNITED_STATES',
  }), code('MARKET_DATA_UNKNOWN_FIELD'));
});

test('source bundle refuses latest marker on binding id', () => {
  assert.throws(() => buildMarketMacroFeatureSourceBundle({
    store: live.store,
    macroDatasetBindingId: 'latest',
    macroMaterializationReportId: live.materialization.macroMaterializationReportId,
    marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
    featureComputationStartSessionDate: '2026-03-02',
    featureComputationEndSessionDateInclusive: '2026-03-09',
  }));
});

test('source bundle refuses inverted session date range', () => {
  assert.throws(() => buildMarketMacroFeatureSourceBundle({
    store: live.store,
    macroDatasetBindingId: live.binding.macroDatasetBindingId,
    macroMaterializationReportId: live.materialization.macroMaterializationReportId,
    marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
    featureComputationStartSessionDate: '2026-03-09',
    featureComputationEndSessionDateInclusive: '2026-03-02',
  }), code('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_INVALID'));
});

test('source bundle replay is stable', () => {
  const built = buildMarketMacroFeatureSourceBundle({
    store: live.store,
    macroDatasetBindingId: live.binding.macroDatasetBindingId,
    macroMaterializationReportId: live.materialization.macroMaterializationReportId,
    marketCalendarRegistryManifestId: live.calendarRegistry.calendarRegistryManifestId,
    featureComputationStartSessionDate: '2026-03-02',
    featureComputationEndSessionDateInclusive: '2026-03-09',
  });
  assert.equal(built.sourceBundleId, live.sourceBundle.sourceBundleId);
});

test('source bundle mismatch on forged binding ref in stored object refuses', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroDatasetBindingId = FAKE('b');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: stored.objectId,
  }), code('MARKET_DATA_REFERENCE_MISSING'));
});

test('source bundle mismatch on forged snapshot manifest refuses', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroDatasetSnapshotManifestId = FAKE('c');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: stored.objectId,
  }), code('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_MISMATCH'));
});

test('source bundle mismatch on forged calendar registry refuses', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.marketCalendarRegistryManifestId = FAKE('d');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: stored.objectId,
  }), code('MARKET_DATA_REFERENCE_MISSING'));
});

test('source bundle mismatch on forged policy id refuses', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroAsOfResolutionPolicyId = FAKE('e');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: stored.objectId,
  }), code('MARKET_DATA_MACRO_FEATURE_SOURCE_BUNDLE_MISMATCH'));
});

test('source bundle normalize rejects bad jurisdiction enum', () => {
  const bad = structuredClone(live.sourceBundle.sourceBundle);
  bad.jurisdictionCode = 'CANADA';
  assert.throws(() => normalizeMarketMacroFeatureSourceBundleV1(bad));
});

test('source bundle normalize rejects bad currency enum', () => {
  const bad = structuredClone(live.sourceBundle.sourceBundle);
  bad.currencyCode = 'CAD';
  assert.throws(() => normalizeMarketMacroFeatureSourceBundleV1(bad));
});

test('source bundle normalize rejects bad temporal capability', () => {
  const bad = structuredClone(live.sourceBundle.sourceBundle);
  bad.temporalCapability = 'LATEST';
  assert.throws(() => normalizeMarketMacroFeatureSourceBundleV1(bad));
});

test('source bundle normalize rejects missing CAS id', () => {
  const bad = structuredClone(live.sourceBundle.sourceBundle);
  bad.macroMaterializationReportId = 'not-a-cas-id';
  assert.throws(() => normalizeMarketMacroFeatureSourceBundleV1(bad));
});

test('source bundle ordered sessions in range skip weekend gap', () => {
  const verified = verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: live.sourceBundle.sourceBundleId,
  });
  const dates = verified.orderedSessionsInRange.map((s) => s.sessionDate);
  assert.deepEqual(dates, ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09']);
});

test('source bundle materialization report must match binding', () => {
  const forged = structuredClone(live.sourceBundle.sourceBundle);
  forged.macroMaterializationReportId = FAKE('f');
  const stored = putCanonicalL3(live.store, MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, forged);
  assert.throws(() => verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: stored.objectId,
  }));
});

test('source bundle half-day session is included in range', () => {
  const verified = verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: live.sourceBundle.sourceBundleId,
  });
  const halfDay = verified.orderedSessionsInRange.find((s) => s.sessionDate === '2026-03-06');
  assert.equal(halfDay.sessionKind, 'HALF_DAY_SESSION');
});

test('source bundle knowledge cutoff covers last session close', () => {
  const verified = verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: live.sourceBundle.sourceBundleId,
  });
  const last = verified.orderedSessionsInRange.at(-1);
  assert.ok(live.binding.binding.knowledgeCutoff >= last.closeUtc);
});
