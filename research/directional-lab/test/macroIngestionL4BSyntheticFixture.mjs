/**
 * Synthetic L4B-I1 macro ingestion fixtures. Every value is fabricated test
 * data, clearly labelled SYNTHETIC_TEST_FIXTURE; nothing here is a real
 * published statistic. All fixtures are pinned, offline and deterministic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import { sha256Digest } from '../src/contracts/marketDataL3CommonV1.mjs';
import {
  MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
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
import { buildMacroDatasetSnapshotManifest } from '../src/macro/macroDatasetSnapshotL4BV1.mjs';

/** Assertion matcher for coded errors. @param {string} expected */
export function code(expected) {
  return (error) => error && error.code === expected;
}

/** @param {(store: any, root: string) => unknown} fn */
export function withMacroStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-l4b-i1-'));
  try {
    return fn(createContentAddressedStore({ root }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function methodologyId(canonicalSeriesCode) {
  return sha256Digest(`SYNTHETIC_TEST_FIXTURE macro methodology ${canonicalSeriesCode} v1`);
}

const SERIES_DEFINITIONS = Object.freeze({
  'US.NYFED.EFFR': {
    sourceAuthority: 'NY_FED', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_AVERAGE',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'NY_FED',
  },
  'US.TREAS.DGS10': {
    sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY',
  },
  'US.BLS.CPIAUCSL': {
    sourceAuthority: 'BLS', frequency: 'MONTHLY', units: 'INDEX',
    seasonalAdjustment: 'SEASONALLY_ADJUSTED', observationConvention: 'PERIOD_AVERAGE',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'BLS',
  },
  'US.BLS.ICSA': {
    sourceAuthority: 'BLS', frequency: 'WEEKLY', units: 'COUNT',
    seasonalAdjustment: 'SEASONALLY_ADJUSTED', observationConvention: 'PERIOD_TOTAL',
    revisionPolicy: 'VINTAGE_PARTIAL', releaseAuthority: 'BLS',
  },
  'US.FOMC.DECISION': {
    sourceAuthority: 'FRB', frequency: 'EVENT', units: 'RATE_RANGE_BOUND',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'POINT_IN_TIME_EVENT',
    revisionPolicy: 'PUBLICATION_ATTESTED', releaseAuthority: 'FRB',
  },
});

/** @param {string} canonicalSeriesCode @param {object} [overrides] */
export function syntheticMacroSeriesIdentity(canonicalSeriesCode, overrides = {}) {
  const definition = SERIES_DEFINITIONS[canonicalSeriesCode];
  if (!definition) throw new Error(`no synthetic definition for ${canonicalSeriesCode}`);
  return {
    schemaVersion: MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    canonicalSeriesCode,
    ...definition,
    methodologyVersionId: methodologyId(canonicalSeriesCode),
    validFrom: '2020-01-01',
    validThrough: null,
    ...overrides,
  };
}

/** Pin one synthetic source document and return its CAS source id. */
export function pinSyntheticSourceDocument(store, label) {
  const bytes = Buffer.from(JSON.stringify({
    kind: 'SYNTHETIC_TEST_FIXTURE',
    label,
    note: 'fabricated offline L4B-I1 test evidence, not real data',
  }), 'utf8');
  return store.putSourceBytes(bytes).objectId;
}

function observationFor(series, overrides) {
  return {
    schemaVersion: 'MacroObservationIdentityCore/1',
    macroSeriesIdentityId: series.macroSeriesIdentityId,
    unit: series.macroSeriesIdentity.units,
    seasonalAdjustment: series.macroSeriesIdentity.seasonalAdjustment,
    ...overrides,
  };
}

/**
 * Build the deterministic official L4B-I1 fixture: five synthetic series, an
 * observation with a single vintage, an initial+revision chain, a same-day
 * correction, a benchmark revision chain and one publication-attested event.
 * @param {(context: any) => unknown} callback
 */
export function withOfficialMacroL4BI1Fixture(callback) {
  return withMacroStore((store) => {
    const policyBuild = buildMacroIngestionPolicy({ store });
    const policy = policyBuild.macroIngestionPolicy;
    const macroIngestionPolicyId = policyBuild.macroIngestionPolicyId;

    const series = {};
    for (const codeName of Object.keys(SERIES_DEFINITIONS)) {
      series[codeName] = buildMacroSeriesIdentityCore({
        store, identity: syntheticMacroSeriesIdentity(codeName),
      });
    }
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

    const observations = {
      effr: buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series['US.NYFED.EFFR'], {
          observationPeriodStart: '2026-01-05', observationPeriodEnd: '2026-01-05',
          referencePeriod: '2026-01-05',
        }),
      }),
      dgs10: buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series['US.TREAS.DGS10'], {
          observationPeriodStart: '2026-01-05', observationPeriodEnd: '2026-01-05',
          referencePeriod: '2026-01-05',
        }),
      }),
      cpi: buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series['US.BLS.CPIAUCSL'], {
          observationPeriodStart: '2025-12-01', observationPeriodEnd: '2025-12-31',
          referencePeriod: '2025-12',
        }),
      }),
      icsa: buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series['US.BLS.ICSA'], {
          observationPeriodStart: '2026-01-04', observationPeriodEnd: '2026-01-10',
          referencePeriod: '2026-01-10',
        }),
      }),
      fomc: buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series['US.FOMC.DECISION'], {
          observationPeriodStart: '2026-01-28', observationPeriodEnd: '2026-01-28',
          referencePeriod: '2026-01-28',
        }),
      }),
    };

    const documents = {
      effr: pinSyntheticSourceDocument(store, 'effr-2026-01-05'),
      dgs10: pinSyntheticSourceDocument(store, 'dgs10-2026-01-05'),
      cpiInitial: pinSyntheticSourceDocument(store, 'cpi-2025-12-initial'),
      cpiRevision: pinSyntheticSourceDocument(store, 'cpi-2025-12-revision'),
      cpiCorrection: pinSyntheticSourceDocument(store, 'cpi-2025-12-correction'),
      icsaInitial: pinSyntheticSourceDocument(store, 'icsa-2026-01-10-initial'),
      icsaRevision: pinSyntheticSourceDocument(store, 'icsa-2026-01-10-revision'),
      icsaBenchmark: pinSyntheticSourceDocument(store, 'icsa-2026-01-10-benchmark'),
      fomc: pinSyntheticSourceDocument(store, 'fomc-2026-01-28'),
    };

    const vintage = (options) => buildMacroObservationVintageCore({ store, policy, ...options });

    const vintages = {
      // 1. Single-vintage daily observation resolved by the pinned NY Fed rule.
      effrInitial: vintage({
        series: series['US.NYFED.EFFR'].macroSeriesIdentity,
        observationIdentityId: observations.effr.observationIdentityId,
        releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
        releaseTimestamp: null, releaseCivilDate: '2026-01-06',
        vintageSequence: 0, value: { atoms: '433', scale: 2 },
        revisionKind: 'INITIAL', parentVintageId: null,
        vintageCompletenessClass: 'VINTAGE_COMPLETE',
        sourceDocumentId: documents.effr,
      }),
      // 2. Daily Treasury curve point resolved by the pinned Treasury rule.
      dgs10Initial: vintage({
        series: series['US.TREAS.DGS10'].macroSeriesIdentity,
        observationIdentityId: observations.dgs10.observationIdentityId,
        releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
        releaseTimestamp: null, releaseCivilDate: '2026-01-05',
        vintageSequence: 0, value: { atoms: '412', scale: 2 },
        revisionKind: 'INITIAL', parentVintageId: null,
        vintageCompletenessClass: 'VINTAGE_COMPLETE',
        sourceDocumentId: documents.dgs10,
      }),
    };

    // 3. Monthly revision-sensitive chain: initial, revision, same-day correction.
    vintages.cpiInitial = vintage({
      series: series['US.BLS.CPIAUCSL'].macroSeriesIdentity,
      observationIdentityId: observations.cpi.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-13T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 0, value: { atoms: '317102', scale: 3 },
      revisionKind: 'INITIAL', parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: documents.cpiInitial,
    });
    vintages.cpiRevision = vintage({
      series: series['US.BLS.CPIAUCSL'].macroSeriesIdentity,
      observationIdentityId: observations.cpi.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-02-11T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 1, value: { atoms: '317148', scale: 3 },
      revisionKind: 'REVISION', parentVintageId: vintages.cpiInitial.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: documents.cpiRevision,
    });
    vintages.cpiCorrection = vintage({
      series: series['US.BLS.CPIAUCSL'].macroSeriesIdentity,
      observationIdentityId: observations.cpi.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-02-11T18:00:00.000Z', releaseCivilDate: null,
      vintageSequence: 2, value: { atoms: '317151', scale: 3 },
      revisionKind: 'CORRECTION', parentVintageId: vintages.cpiRevision.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: documents.cpiCorrection,
    });

    // 4. Weekly claims benchmark-revision chain.
    vintages.icsaInitial = vintage({
      series: series['US.BLS.ICSA'].macroSeriesIdentity,
      observationIdentityId: observations.icsa.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-15T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 0, value: { atoms: '214000', scale: 0 },
      revisionKind: 'INITIAL', parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_PARTIAL',
      sourceDocumentId: documents.icsaInitial,
    });
    vintages.icsaRevision = vintage({
      series: series['US.BLS.ICSA'].macroSeriesIdentity,
      observationIdentityId: observations.icsa.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-22T13:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 1, value: { atoms: '216250', scale: 0 },
      revisionKind: 'REVISION', parentVintageId: vintages.icsaInitial.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_PARTIAL',
      sourceDocumentId: documents.icsaRevision,
    });
    vintages.icsaBenchmark = vintage({
      series: series['US.BLS.ICSA'].macroSeriesIdentity,
      observationIdentityId: observations.icsa.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-04-02T12:30:00.000Z', releaseCivilDate: null,
      vintageSequence: 2, value: { atoms: '215700', scale: 0 },
      revisionKind: 'BENCHMARK_REVISION',
      parentVintageId: vintages.icsaRevision.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_PARTIAL',
      sourceDocumentId: documents.icsaBenchmark,
    });

    // 5. Publication-attested FOMC decision event.
    vintages.fomcInitial = vintage({
      series: series['US.FOMC.DECISION'].macroSeriesIdentity,
      observationIdentityId: observations.fomc.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-01-28T19:00:00.000Z', releaseCivilDate: null,
      vintageSequence: 0, value: { atoms: '450', scale: 2 },
      revisionKind: 'INITIAL', parentVintageId: null,
      vintageCompletenessClass: 'PUBLICATION_ATTESTED',
      sourceDocumentId: documents.fomc,
    });

    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: Object.values(vintages)
        .map((built) => built.observationVintageId),
    });
    const snapshot = buildMacroDatasetSnapshotManifest({
      store,
      macroIngestionPolicyId,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    });

    return callback({
      store, policy, macroIngestionPolicyId, series, registry,
      observations, documents, vintages, vintageSet, snapshot,
    });
  });
}

/** Registry configured with series but zero observed vintages. */
export function withEmptyMacroL4BI1Fixture(callback) {
  return withMacroStore((store) => {
    const policyBuild = buildMacroIngestionPolicy({ store });
    const effr = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity('US.NYFED.EFFR'),
    });
    const registry = buildMacroSeriesRegistryGenesis({
      store,
      entries: [{
        macroSeriesIdentityId: effr.macroSeriesIdentityId,
        canonicalSeriesCode: 'US.NYFED.EFFR',
        status: 'ACTIVE',
        supersedesSeriesIdentityId: null,
        replacementReason: null,
      }],
    });
    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: [],
    });
    const snapshot = buildMacroDatasetSnapshotManifest({
      store,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    });
    return callback({
      store,
      policy: policyBuild.macroIngestionPolicy,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      effr, registry, vintageSet, snapshot,
    });
  });
}
