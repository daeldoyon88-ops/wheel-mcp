/**
 * L4B-I1 replay, prefix invariance and medium-scale performance tests.
 * The full pipeline is replayed in fresh temporary stores; adding future
 * objects to a store never changes previously pinned bytes or IDs.
 * All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { addDays } from '../src/time/civilDate.mjs';
import {
  MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import { buildMacroIngestionPolicy } from '../src/macro/macroIngestionPolicyL4BV1.mjs';
import {
  buildMacroSeriesIdentityCore,
  buildMacroSeriesRegistryGenesis,
} from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import {
  buildMacroObservationIdentityCore,
  buildMacroObservationVintageCore,
} from '../src/macro/macroObservationVintageL4BV1.mjs';
import { buildMacroVintageSetManifest } from '../src/macro/macroVintageSetL4BV1.mjs';
import {
  buildMacroDatasetSnapshotManifest,
  verifyMacroDatasetSnapshotManifest,
} from '../src/macro/macroDatasetSnapshotL4BV1.mjs';
import {
  pinSyntheticSourceDocument,
  syntheticMacroSeriesIdentity,
  withMacroStore,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';

function fixtureFingerprint(ctx) {
  return {
    policyId: ctx.macroIngestionPolicyId,
    registryId: ctx.registry.macroSeriesRegistryManifestId,
    vintageSetId: ctx.vintageSet.macroVintageSetManifestId,
    snapshotId: ctx.snapshot.macroDatasetSnapshotManifestId,
    snapshotBytes: canonicalJsonBytes(ctx.snapshot.datasetSnapshot).toString('hex'),
    vintageSetBytes: canonicalJsonBytes(ctx.vintageSet.vintageSet).toString('hex'),
    registryBytes: canonicalJsonBytes(ctx.registry.registry).toString('hex'),
    counts: [
      ctx.snapshot.datasetSnapshot.seriesCount,
      ctx.snapshot.datasetSnapshot.observationCount,
      ctx.snapshot.datasetSnapshot.vintageCount,
    ],
    digests: [
      ctx.snapshot.datasetSnapshot.orderedSeriesIdentityDigest,
      ctx.snapshot.datasetSnapshot.orderedObservationIdentityDigest,
      ctx.snapshot.datasetSnapshot.orderedVintageIdentityDigest,
    ],
  };
}

test('the whole official fixture replays identically in two fresh stores', () => {
  const first = withOfficialMacroL4BI1Fixture(fixtureFingerprint);
  const second = withOfficialMacroL4BI1Fixture(fixtureFingerprint);
  assert.deepEqual(first, second);
});

test('replay is identical after CAS noise and future objects are added', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const before = fixtureFingerprint(ctx);
    pinSyntheticSourceDocument(ctx.store, 'replay-noise-1');
    pinSyntheticSourceDocument(ctx.store, 'replay-noise-2');
    buildMacroSeriesIdentityCore({
      store: ctx.store,
      identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR', {
        methodologyVersionId: `sha256:${'9'.repeat(64)}`,
      }),
    });
    const rebuiltSnapshot = buildMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    });
    assert.equal(rebuiltSnapshot.macroDatasetSnapshotManifestId, before.snapshotId);
    assert.equal(canonicalJsonBytes(rebuiltSnapshot.datasetSnapshot).toString('hex'),
      before.snapshotBytes);
  });
});

test('prefix invariance: pinning a longer future chain leaves the old snapshot intact', () => {
  withOfficialMacroL4BI1Fixture((ctx) => {
    const pinnedId = ctx.snapshot.macroDatasetSnapshotManifestId;
    const pinnedBytes = canonicalJsonBytes(ctx.snapshot.datasetSnapshot).toString('hex');

    // A future correction vintage lands in the store and a future vintage set
    // supersedes the pinned one.
    const futureVintage = buildMacroObservationVintageCore({
      store: ctx.store,
      policy: ctx.policy,
      series: ctx.series['US.BLS.CPIAUCSL'].macroSeriesIdentity,
      observationIdentityId: ctx.observations.cpi.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-03-11T13:30:00.000Z',
      releaseCivilDate: null,
      vintageSequence: 3,
      value: { atoms: '317160', scale: 3 },
      revisionKind: 'REVISION',
      parentVintageId: ctx.vintages.cpiCorrection.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: pinSyntheticSourceDocument(ctx.store, 'cpi-future-doc'),
    });
    const futureSet = buildMacroVintageSetManifest({
      store: ctx.store,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      supersedesVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
      observationVintageIds: [
        ...Object.values(ctx.vintages).map((v) => v.observationVintageId),
        futureVintage.observationVintageId,
      ],
    });
    const futureSnapshot = buildMacroDatasetSnapshotManifest({
      store: ctx.store,
      macroIngestionPolicyId: ctx.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: futureSet.macroVintageSetManifestId,
    });

    // The old pinned snapshot still verifies byte-for-byte; the future data
    // only exists inside the new, distinct snapshot.
    const verified = verifyMacroDatasetSnapshotManifest({
      store: ctx.store, macroDatasetSnapshotManifestId: pinnedId,
    });
    assert.equal(canonicalJsonBytes(verified.datasetSnapshot).toString('hex'), pinnedBytes);
    assert.equal(verified.datasetSnapshot.vintageCount, 9);
    assert.notEqual(futureSnapshot.macroDatasetSnapshotManifestId, pinnedId);
    assert.equal(futureSnapshot.datasetSnapshot.vintageCount, 10);
  });
});

test('medium fixture: a 20-revision chain and 500+ vintages stay correct and linear-ish', () => {
  withMacroStore((store) => {
    const policyBuild = buildMacroIngestionPolicy({ store });
    const policy = policyBuild.macroIngestionPolicy;
    const series = {
      effr: buildMacroSeriesIdentityCore({
        store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
      }),
      dgs10: buildMacroSeriesIdentityCore({
        store, identity: syntheticMacroSeriesIdentity('US.TREAS.DGS10'),
      }),
      cpi: buildMacroSeriesIdentityCore({
        store, identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL'),
      }),
    };
    const registry = buildMacroSeriesRegistryGenesis({
      store,
      entries: Object.values(series).map((built) => ({
        macroSeriesIdentityId: built.macroSeriesIdentityId,
        canonicalSeriesCode: built.macroSeriesIdentity.canonicalSeriesCode,
        status: 'ACTIVE',
        supersedesSeriesIdentityId: null,
        replacementReason: null,
      })),
    });
    const sharedDocument = pinSyntheticSourceDocument(store, 'medium-shared-doc');
    const vintageIds = [];

    // 250 EFFR + 250 DGS10 daily observations, one vintage each. Weekdays of
    // 2025 starting Jan 6 (a Monday), skipping weekends deterministically.
    const civilDates = [];
    for (let offset = 0; civilDates.length < 250; offset += 1) {
      const week = Math.floor(offset / 5);
      const dayInWeek = offset % 5;
      civilDates.push(addDays('2025-01-06', week * 7 + dayInWeek));
    }
    for (const [key, hour] of [['effr', '14:00'], ['dgs10', '21:00']]) {
      for (const [index, civilDate] of civilDates.entries()) {
        const observation = buildMacroObservationIdentityCore({
          store,
          identity: {
            schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
            macroSeriesIdentityId: series[key].macroSeriesIdentityId,
            observationPeriodStart: civilDate,
            observationPeriodEnd: civilDate,
            referencePeriod: civilDate,
            unit: 'PERCENT',
            seasonalAdjustment: 'NOT_APPLICABLE',
          },
        });
        vintageIds.push(buildMacroObservationVintageCore({
          store,
          policy,
          series: series[key].macroSeriesIdentity,
          observationIdentityId: observation.observationIdentityId,
          releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
          releaseTimestamp: `${civilDate}T${hour}:00.000Z`,
          releaseCivilDate: null,
          vintageSequence: 0,
          value: { atoms: String(400 + (index % 50)), scale: 2 },
          revisionKind: 'INITIAL',
          parentVintageId: null,
          vintageCompletenessClass: 'VINTAGE_COMPLETE',
          sourceDocumentId: sharedDocument,
        }).observationVintageId);
      }
    }

    // One CPI observation carrying a 21-vintage chain (initial + 20 revisions).
    const cpiObservation = buildMacroObservationIdentityCore({
      store,
      identity: {
        schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
        macroSeriesIdentityId: series.cpi.macroSeriesIdentityId,
        observationPeriodStart: '2025-01-01',
        observationPeriodEnd: '2025-01-31',
        referencePeriod: '2025-01',
        unit: 'INDEX',
        seasonalAdjustment: 'SEASONALLY_ADJUSTED',
      },
    });
    let parentIdentityId = null;
    for (let sequence = 0; sequence <= 20; sequence += 1) {
      const month = String(2 + Math.floor(sequence / 2)).padStart(2, '0');
      const day = String(10 + (sequence % 2)).padStart(2, '0');
      const built = buildMacroObservationVintageCore({
        store,
        policy,
        series: series.cpi.macroSeriesIdentity,
        observationIdentityId: cpiObservation.observationIdentityId,
        releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
        releaseTimestamp: `2025-${month}-${day}T13:30:00.000Z`,
        releaseCivilDate: null,
        vintageSequence: sequence,
        value: { atoms: String(310000 + sequence), scale: 3 },
        revisionKind: sequence === 0 ? 'INITIAL' : 'REVISION',
        parentVintageId: parentIdentityId,
        vintageCompletenessClass: 'VINTAGE_COMPLETE',
        sourceDocumentId: sharedDocument,
      });
      parentIdentityId = built.macroVintageIdentityId;
      vintageIds.push(built.observationVintageId);
    }

    assert.equal(vintageIds.length, 521);
    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: vintageIds,
    });
    assert.equal(vintageSet.vintageSet.vintageCount, 521);
    assert.equal(vintageSet.vintageSet.observationCount, 501);
    const snapshot = buildMacroDatasetSnapshotManifest({
      store,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    });
    assert.equal(snapshot.datasetSnapshot.vintageCount, 521);
    assert.equal(snapshot.datasetSnapshot.seriesCount, 3);
  });
});
