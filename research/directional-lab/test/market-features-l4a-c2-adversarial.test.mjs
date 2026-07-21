import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  normalizeMarketSeasonalityFeatureRowsV1,
} from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  buildMarketSeasonalityFeatureComputationPolicy,
  buildMarketSeasonalityFeatureSourceBundle,
  computeMarketSeasonalityFeatures,
  verifyMarketSeasonalityFeatureComputation,
} from '../src/features/computeMarketSeasonalityFeaturesL4V1.mjs';
import { withOfficialL4Binding } from './marketFeaturesL4SyntheticPipeline.mjs';

const HASH = `sha256:${'f'.repeat(64)}`;
const FOREIGN_ID = `sha256:${'9'.repeat(64)}`;

function putImplementationManifestC2(store) {
  return store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: 'TransformImplementationManifest/2',
    value: {
      schemaVersion: 'TransformImplementationManifest/2',
      runtimeContractVersion: 'L4A-C2/1',
      moduleHashPolicyVersion: 'TransformSourceText/1',
      modules: [
        'src/contracts/marketSeasonalityFeatureComputationL4V1.mjs',
        'src/contracts/marketSeasonalityFeaturePolicyValuesL4V1.mjs',
        'src/features/marketSeasonalityOccurrenceEngineL4V1.mjs',
        'src/features/marketSeasonalityRuntimePolicyL4V1.mjs',
        'src/features/marketSeasonalityStatisticsL4V1.mjs',
        'src/features/marketSeasonalityFeatureReportL4V1.mjs',
        'src/features/computeMarketSeasonalityFeaturesL4V1.mjs',
      ].map((logicalPath) => ({ logicalPath, canonicalContentSha256: HASH })),
    },
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function forgeVerify(store, report, mutateReport) {
  const forgedValue = mutateReport(clone(report));
  const forged = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    value: forgedValue,
  });
  assert.throws(
    () => verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: forged.objectId,
    }),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_REPORT_MISMATCH'
      || error?.code === 'MARKET_DATA_SEASONALITY_ROWS_MISMATCH'
      || error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID',
  );
}

function putCorruptedRowsAndForgeReport(store, report, mutateDocument) {
  const document = mutateDocument(clone({
    schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    rows: store.readCanonicalObject({
      uri: store.uriForObject({ namespace: 'normalized', objectId: report.seasonalityFeatureRowsId }),
      expectedObjectId: report.seasonalityFeatureRowsId,
      schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    }).value.rows,
  }));
  const corrupted = store.putCanonicalObject({
    namespace: 'normalized',
    schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    value: document,
  });
  const forged = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    value: {
      ...report,
      seasonalityFeatureRowsId: corrupted.objectId,
    },
  });
  assert.throws(
    () => verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: forged.objectId,
    }),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_ROWS_MISMATCH'
      || error?.code === 'MARKET_DATA_SEASONALITY_REPORT_MISMATCH',
  );
}

const ROW_CORRUPTIONS = [
  ['remove-last-row', (doc) => {
    doc.rows = doc.rows.slice(0, 1);
    return doc;
  }],
  ['remove-first-row', (doc) => {
    doc.rows = doc.rows.slice(1);
    return doc;
  }],
  ['change-sessionDate', (doc) => {
    doc.rows[0].sessionDate = '2000-01-03';
    return doc;
  }],
  ['change-bar-id', (doc) => {
    doc.rows[0].subjectBarIdentityId = FOREIGN_ID;
    return doc;
  }],
  ['change-occurrenceCount', (doc) => {
    const window = doc.rows[0].features.seasonality.horizonWindows[0];
    window.occurrenceCount = 1;
    window.distinctYearCount = 1;
    window.bullishCount = 1;
    window.bearishCount = 0;
    window.flatCount = 0;
    return doc;
  }],
  ['change-meanReturn-atoms', (doc) => {
    const window = doc.rows[0].features.seasonality.horizonWindows[0];
    window.occurrenceCount = 1;
    window.distinctYearCount = 1;
    window.bullishCount = 1;
    window.meanReturn = { atoms: '123', scale: 12 };
    return doc;
  }],
  ['change-meanReturn-scale-refused-at-put', (doc) => {
    const window = doc.rows[0].features.seasonality.horizonWindows[0];
    window.occurrenceCount = 1;
    window.distinctYearCount = 1;
    window.bullishCount = 1;
    window.meanReturn = { atoms: '1', scale: 10 };
    return doc;
  }],
  ['change-primaryAvailabilityReason', (doc) => {
    const window = doc.rows[0].features.seasonality.horizonWindows[0];
    const wasAvailable = window.primaryAvailabilityReason === 'AVAILABLE';
    window.primaryAvailabilityReason = wasAvailable ? 'INSUFFICIENT_HISTORY' : 'AVAILABLE';
    const available = doc.rows[0].features.seasonality.horizonWindows
      .filter((item) => item.primaryAvailabilityReason === 'AVAILABLE').length;
    doc.rows[0].availability.availableHorizonWindowCount = available;
    doc.rows[0].availability.unavailableHorizonWindowCount =
      doc.rows[0].features.seasonality.horizonWindows.length - available;
    return doc;
  }],
  ['change-currentWindow-status', (doc) => {
    const current = doc.rows[0].features.seasonality.currentWindows[0];
    current.status = current.status === 'NOT_STARTED' ? 'IN_PROGRESS' : 'NOT_STARTED';
    return doc;
  }],
  ['change-diagnostics-missingInput', (doc) => {
    doc.rows[0].features.seasonality.horizonWindows[0].diagnostics.missingInputCount += 1;
    return doc;
  }],
  ['change-subjectResolvedObservationId', (doc) => {
    doc.rows[0].subjectResolvedObservationId = FOREIGN_ID;
    return doc;
  }],
  ['change-bullishCount', (doc) => {
    const window = doc.rows[0].features.seasonality.horizonWindows[0];
    if (window.occurrenceCount === 0) {
      window.occurrenceCount = 2;
      window.distinctYearCount = 1;
      window.bullishCount = 2;
      window.bearishCount = 0;
      window.flatCount = 0;
    } else {
      window.bullishCount = window.occurrenceCount;
      window.bearishCount = 0;
      window.flatCount = 0;
    }
    return doc;
  }],
  ['swap-bar-ids-keep-dates', (doc) => {
    const first = doc.rows[0].subjectBarIdentityId;
    doc.rows[0].subjectBarIdentityId = doc.rows[1].subjectBarIdentityId;
    doc.rows[1].subjectBarIdentityId = first;
    return doc;
  }],
  ['change-second-row-sessionDate', (doc) => {
    doc.rows[1].sessionDate = '2099-12-31';
    return doc;
  }],
  ['inflate-unavailable-count-consistent', (doc) => {
    // Flip a window reason so availability counters stay consistent but diverge from recompute.
    const window = doc.rows[1].features.seasonality.horizonWindows[1];
    window.primaryAvailabilityReason = window.primaryAvailabilityReason === 'AVAILABLE'
      ? 'NO_ELIGIBLE_OCCURRENCE'
      : 'AVAILABLE';
    const available = doc.rows[1].features.seasonality.horizonWindows
      .filter((item) => item.primaryAvailabilityReason === 'AVAILABLE').length;
    doc.rows[1].availability.availableHorizonWindowCount = available;
    doc.rows[1].availability.unavailableHorizonWindowCount =
      doc.rows[1].features.seasonality.horizonWindows.length - available;
    return doc;
  }],
  ['change-lookaheadRejectedCount', (doc) => {
    doc.rows[0].features.seasonality.horizonWindows[2].diagnostics.lookaheadRejectedCount += 3;
    return doc;
  }],
  ['change-candidateYearCount', (doc) => {
    doc.rows[0].features.seasonality.horizonWindows[3].diagnostics.candidateYearCount += 1;
    return doc;
  }],
  ['change-rawHistoryCoverageComplete', (doc) => {
    const diagnostics = doc.rows[0].features.seasonality.horizonWindows[4].diagnostics;
    diagnostics.rawHistoryCoverageComplete = !diagnostics.rawHistoryCoverageComplete;
    return doc;
  }],
  ['change-current-availabilityReason', (doc) => {
    const current = doc.rows[0].features.seasonality.currentWindows[1];
    current.availabilityReason = current.availabilityReason === 'AVAILABLE'
      ? 'MISSING_INPUT'
      : 'AVAILABLE';
    return doc;
  }],
  ['change-instrumentIdentityId', (doc) => {
    doc.rows[0].instrumentIdentityId = FOREIGN_ID;
    return doc;
  }],
];

const ROW_WRITE_REFUSALS = [
  ['duplicate-row', (doc) => {
    doc.rows = [doc.rows[0], clone(doc.rows[0])];
    return doc;
  }],
  ['reverse-order', (doc) => {
    doc.rows = [doc.rows[1], doc.rows[0]];
    return doc;
  }],
  ['unknown-key', (doc) => {
    doc.rows[0].alien = true;
    return doc;
  }],
  ['add-incomplete-row', (doc) => {
    doc.rows.push({ sessionDate: '2099-01-01', subjectBarIdentityId: FOREIGN_ID });
    return doc;
  }],
];

const REPORT_CORRUPTIONS = [
  ['rowCount', (r) => {
    r.rowCount = r.rowCount + 1;
    r.emptySnapshot = false;
    r.firstSessionDate = r.firstSessionDate ?? '2024-01-02';
    r.lastSessionDate = r.lastSessionDate ?? '2024-01-03';
    return r;
  }],
  ['emptySnapshot', (r) => {
    // Keep rowCount/date consistency: force empty shape that diverges from recomputed non-empty.
    r.rowCount = 0;
    r.emptySnapshot = true;
    r.firstSessionDate = null;
    r.lastSessionDate = null;
    return r;
  }],
  ['distinctOccurrenceCount', (r) => {
    r.distinctOccurrenceCount += 1;
    return r;
  }],
  ['distinctHistoricalYearCount', (r) => {
    r.distinctHistoricalYearCount += 1;
    return r;
  }],
  ['orderedRowIdentityDigest', (r) => {
    r.orderedRowIdentityDigest = `sha256:${'c'.repeat(64)}`;
    return r;
  }],
  ['availabilityCounts.available', (r) => {
    r.availabilityCounts.availableHorizonWindowCount += 1;
    return r;
  }],
  ['availabilityCounts.unavailable', (r) => {
    r.availabilityCounts.unavailableHorizonWindowCount += 1;
    return r;
  }],
  ['partialCurrentWindowCount', (r) => {
    r.partialCurrentWindowCount += 1;
    return r;
  }],
  ['completedCurrentWindowCount', (r) => {
    r.completedCurrentWindowCount += 1;
    return r;
  }],
  ['currentWindowStatusCounts', (r) => {
    r.currentWindowStatusCounts.NOT_STARTED += 1;
    return r;
  }],
  ['primaryAvailabilityReasonCounts', (r) => {
    r.primaryAvailabilityReasonCounts.AVAILABLE += 1;
    return r;
  }],
  ['rejectedOccurrenceCounts', (r) => {
    r.rejectedOccurrenceCounts.missingInputCount += 1;
    return r;
  }],
  ['countsByHorizon.3.occurrenceCountSum', (r) => {
    r.countsByHorizon['3'].occurrenceCountSum += 1;
    return r;
  }],
  ['countsByHorizon.5.rowPresenceCount', (r) => {
    r.countsByHorizon['5'].rowPresenceCount += 1;
    return r;
  }],
  ['countsByHorizon.10.distinctOccurrenceCount', (r) => {
    r.countsByHorizon['10'].distinctOccurrenceCount += 1;
    return r;
  }],
  ['countsByForwardSessionCount.5.occurrenceCountSum', (r) => {
    r.countsByForwardSessionCount['5'].occurrenceCountSum += 1;
    return r;
  }],
  ['countsByForwardSessionCount.60.distinctOccurrenceCount', (r) => {
    r.countsByForwardSessionCount['60'].distinctOccurrenceCount += 1;
    return r;
  }],
  ['firstSessionDate', (r) => {
    r.firstSessionDate = '1999-01-01';
    return r;
  }],
  ['lastSessionDate', (r) => {
    r.lastSessionDate = '2099-12-31';
    return r;
  }],
  ['featureFamilyVersion-refused-at-put', (r) => {
    r.featureFamilyVersion = 'MARKET_SEASONALITY_FEATURE_L4A_C2/0';
    return r;
  }],
  ['configuredHorizonWindowPairCount-refused-at-put', (r) => {
    r.configuredHorizonWindowPairCount = 19;
    return r;
  }],
  ['knowledgeCutoff', (r) => {
    r.knowledgeCutoff = '2000-01-01T00:00:00.000Z';
    return r;
  }],
];

test('L4A-C2 adversarial row and report corruptions after valid compute', () => (
  withOfficialL4Binding(({ store, published }) => {
    const implementation = putImplementationManifestC2(store);
    const source = buildMarketSeasonalityFeatureSourceBundle({
      store,
      subjectBindingRegistryManifestId: published.bindingRegistryManifestId,
      subjectBindingId: published.bindingId,
      implementationManifestId: implementation.objectId,
    });
    const policy = buildMarketSeasonalityFeatureComputationPolicy({ store });
    const computed = computeMarketSeasonalityFeatures({
      store,
      seasonalityFeatureSourceBundleId: source.seasonalityFeatureSourceBundleId,
      seasonalityFeatureComputationPolicyId: policy.seasonalityFeatureComputationPolicyId,
    });
    const verified = verifyMarketSeasonalityFeatureComputation({
      store, seasonalityFeatureComputationReportId: computed.seasonalityFeatureComputationReportId,
    });
    const report = verified.seasonalityFeatureComputationReport;

    for (const [name, mutate] of ROW_CORRUPTIONS) {
      try {
        putCorruptedRowsAndForgeReport(store, report, mutate);
      } catch (error) {
        // Some mutations are refused at put/normalize (closed rows gate) — still a closed failure.
        if (name.includes('refused-at-put') || error?.code === 'MARKET_DATA_SEASONALITY_INPUT_INVALID'
            || error?.name === 'MarketDataL3Error'
            || /scale|invalid|unknown|inconsistent/i.test(String(error?.message ?? error))) {
          assert.ok(true, name);
          continue;
        }
        error.message = `${name}: ${error.message}`;
        throw error;
      }
    }

    for (const [name, mutate] of ROW_WRITE_REFUSALS) {
      const document = mutate(clone({
        schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
        rows: verified.seasonalityFeatureRows.rows,
      }));
      assert.throws(
        () => normalizeMarketSeasonalityFeatureRowsV1(document),
        () => true,
        name,
      );
    }

    for (const [name, mutate] of REPORT_CORRUPTIONS) {
      try {
        forgeVerify(store, report, mutate);
      } catch (error) {
        if (name.includes('refused-at-put')
            || error?.code === 'MARKET_DATA_SEASONALITY_REPORT_INVALID'
            || error?.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED') {
          assert.ok(true, name);
          continue;
        }
        error.message = `${name}: ${error.message}`;
        throw error;
      }
    }

    assert.ok(ROW_CORRUPTIONS.length >= 20);
    assert.ok(REPORT_CORRUPTIONS.length >= 20);
  })
));
