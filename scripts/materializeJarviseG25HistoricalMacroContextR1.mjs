/**
 * Materializes the GATE25 historical regime foundation R1 macro context from the
 * pinned source evidence already persisted under
 * data/jarvise/historical-macro-context/source-evidence. Network-free and
 * deterministic: identical evidence bytes reproduce identical CAS objects, ids
 * and projections. Every object is built by the unchanged L4B-I1/I2 builders,
 * which re-verify their inputs; nothing is accepted from a caller.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonBytes } from '../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import { createContentAddressedStore } from '../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { sha256Digest } from '../research/directional-lab/src/contracts/marketDataL3CommonV1.mjs';
import { MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION } from '../research/directional-lab/src/contracts/macroIngestionContractsL4BV1.mjs';
import { buildMacroIngestionPolicy } from '../research/directional-lab/src/macro/macroIngestionPolicyL4BV1.mjs';
import { buildMacroAsOfResolutionPolicy } from '../research/directional-lab/src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import { buildMacroSeriesIdentityCore, buildMacroSeriesRegistryGenesis } from '../research/directional-lab/src/macro/macroSeriesRegistryL4BV1.mjs';
import { buildMacroObservationIdentityCore, buildMacroObservationVintageCore } from '../research/directional-lab/src/macro/macroObservationVintageL4BV1.mjs';
import { buildMacroVintageSetManifest } from '../research/directional-lab/src/macro/macroVintageSetL4BV1.mjs';
import { buildMacroDatasetSnapshotManifest } from '../research/directional-lab/src/macro/macroDatasetSnapshotL4BV1.mjs';
import { buildMarketMacroFeatureComputationPolicy } from '../research/directional-lab/src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { buildMarketMacroInstrumentProjectionPolicy } from '../research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V1.mjs';
import { buildMarketMacroInstrumentProjectionPolicyV2 } from '../research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V2.mjs';
import {
  ALFRED_REAL_TIME_ENTRY_NAME_R1,
  CPI_SERIES_CODE_R1,
  HISTORICAL_MACRO_BINDING_PROJECTION_SCHEMA_R1,
  HISTORICAL_MACRO_CONTEXT_RELATIVE_ROOT_R1,
  HISTORICAL_MACRO_COVERAGE_R1,
  HISTORICAL_MACRO_PRODUCER_CLASSIFICATION_R1,
  TREASURY_COLUMN_SERIES_R1,
  TREASURY_SERIES_CODES_R1,
  cpiSuccessorPolicyRelativePathR1,
  parseAlfredRealTimePeriodCsvR1,
  parseTreasuryParYieldCsvR1,
  readZipEntriesR1,
} from '../app/jarvise/jarviseG25HistoricalMacroContextR1.mjs';

export const MISSION_ID = 'WHEEL_JARVISE_GATE25_HISTORICAL_REGIME_FOUNDATION_R1';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_OUTPUT_ROOT = resolve(REPOSITORY_ROOT, HISTORICAL_MACRO_CONTEXT_RELATIVE_ROOT_R1);

/** Pinned evidence: path relative to the macro root, sha256 and byte length as acquired. */
export const SOURCE_EVIDENCE_R1 = Object.freeze([
  Object.freeze({ path: 'source-evidence/US_TREASURY/daily-treasury-par-yield-curve-rates-2024.csv', sha256: '6775840b76cd7fd41121f61d6f6c60184eca6b2ba49954ec7372c463cbeef34d', byteLength: 19098, sourceAuthority: 'US_TREASURY', year: 2024 }),
  Object.freeze({ path: 'source-evidence/US_TREASURY/daily-treasury-par-yield-curve-rates-2025.csv', sha256: 'cf2fa3da7f160384b63d2ead698532b1d76cd9f789ce4911e2304db85b14e6d5', byteLength: 20155, sourceAuthority: 'US_TREASURY', year: 2025 }),
  Object.freeze({ path: 'source-evidence/US_TREASURY/daily-treasury-par-yield-curve-rates-2026.csv', sha256: '2b40d97e84a6a057eb62c540d9a201ebb85789fbec58d27a529cdae81c4371de', byteLength: 14366, sourceAuthority: 'US_TREASURY', year: 2026 }),
  Object.freeze({ path: 'source-evidence/FRED_ALFRED/CPIAUCSL-observations-by-real-time-period.zip', sha256: '3efff0e05d15f72b3623f5b4a695c1925a9e13ada20581261150b9fb875928c5', byteLength: 2680, sourceAuthority: 'FRED_ALFRED', year: null }),
]);

export class JarviseG25HistoricalMacroMaterializationError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'JarviseG25HistoricalMacroMaterializationError'; this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new JarviseG25HistoricalMacroMaterializationError(code, details); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function lastDayOfMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function methodologyDescriptor(canonicalSeriesCode) {
  if (canonicalSeriesCode === CPI_SERIES_CODE_R1) {
    return {
      schemaVersion: 'WHEEL_JARVISE_G25_HISTORICAL_MACRO_METHODOLOGY_DESCRIPTOR/1',
      canonicalSeriesCode,
      sourceAuthority: 'BLS',
      concept: 'Consumer Price Index for All Urban Consumers: All Items in U.S. City Average, Index 1982-1984=100, Seasonally Adjusted, Monthly',
      pointInTimeCarrier: 'FRED_ALFRED CPIAUCSL Observations by Real-Time Period',
      vintageRule: 'each ALFRED real-time period start is one BLS publication; value changes form one INITIAL-then-REVISION chain per reference month',
      nonPublicationRule: 'an explicitly empty ALFRED value is a published non-observation and is never stored as a vintage',
    };
  }
  const column = Object.entries(TREASURY_COLUMN_SERIES_R1).find(([, code]) => code === canonicalSeriesCode)[0];
  return {
    schemaVersion: 'WHEEL_JARVISE_G25_HISTORICAL_MACRO_METHODOLOGY_DESCRIPTOR/1',
    canonicalSeriesCode,
    sourceAuthority: 'US_TREASURY',
    concept: `U.S. Treasury Daily Par Yield Curve Rate, ${column} constant maturity, percent`,
    sourceColumn: column,
    vintageRule: 'FINAL_ONLY: one INITIAL vintage per business date as published',
  };
}

const SERIES_DEFINITIONS = Object.freeze({
  treasury: Object.freeze({ sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END', revisionPolicy: 'FINAL_ONLY', releaseAuthority: 'US_TREASURY' }),
  cpi: Object.freeze({ sourceAuthority: 'BLS', frequency: 'MONTHLY', units: 'INDEX', seasonalAdjustment: 'SEASONALLY_ADJUSTED', observationConvention: 'PERIOD_AVERAGE', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'BLS' }),
});

function writeStableCanonical(path, value) {
  const bytes = canonicalJsonBytes(value);
  if (existsSync(path)) {
    const present = readFileSync(path);
    if (!present.equals(bytes)) fail('HISTORICAL_MACRO_PROJECTION_IDEMPOTENCE_FAILURE', { path });
    return { created: false, byteLength: present.length, sha256: sha256(present) };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' });
  return { created: true, byteLength: bytes.length, sha256: sha256(bytes) };
}

export function materializeJarviseG25HistoricalMacroContextR1(options = {}) {
  const outputRoot = resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  if (outputRoot !== DEFAULT_OUTPUT_ROOT && options.testOnlyAllowOutputRoot !== true) fail('HISTORICAL_MACRO_OUTPUT_ROOT_NOT_AUTHORIZED');
  const evidenceRoot = resolve(options.evidenceRoot ?? DEFAULT_OUTPUT_ROOT);
  const coverage = HISTORICAL_MACRO_COVERAGE_R1;
  mkdirSync(join(outputRoot, 'cas'), { recursive: true });
  const store = createContentAddressedStore({ root: join(outputRoot, 'cas') });

  const evidence = SOURCE_EVIDENCE_R1.map((item) => {
    const bytes = readFileSync(join(evidenceRoot, item.path));
    if (bytes.length !== item.byteLength || sha256(bytes) !== item.sha256) fail('SOURCE_EVIDENCE_DIGEST_MISMATCH', { path: item.path });
    return { ...item, bytes, sourceObjectId: store.putSourceBytes(bytes).objectId };
  });

  const ingestion = buildMacroIngestionPolicy({ store });
  const asOf = buildMacroAsOfResolutionPolicy({ store });
  const featurePolicy = buildMarketMacroFeatureComputationPolicy({ store });
  const projectionPolicy = buildMarketMacroInstrumentProjectionPolicy({ store });
  const cpiSuccessorPolicy = buildMarketMacroInstrumentProjectionPolicyV2();
  const cpiSuccessorPolicyWrite = writeStableCanonical(
    join(outputRoot, cpiSuccessorPolicyRelativePathR1(cpiSuccessorPolicy.instrumentProjectionPolicyId)),
    cpiSuccessorPolicy.instrumentProjectionPolicy,
  );
  if (`sha256:${cpiSuccessorPolicyWrite.sha256}` !== cpiSuccessorPolicy.instrumentProjectionPolicyId) fail('CPI_SUCCESSOR_POLICY_BYTES_NOT_CONTENT_ADDRESSED');
  const policy = ingestion.macroIngestionPolicy;

  const series = {};
  for (const code of [...TREASURY_SERIES_CODES_R1, CPI_SERIES_CODE_R1]) {
    const methodologyBytes = canonicalJsonBytes(methodologyDescriptor(code));
    const methodologyObjectId = store.putSourceBytes(methodologyBytes).objectId;
    if (methodologyObjectId !== sha256Digest(methodologyBytes)) fail('METHODOLOGY_OBJECT_ID_MISMATCH');
    series[code] = buildMacroSeriesIdentityCore({
      store,
      identity: {
        schemaVersion: MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
        jurisdictionCode: 'UNITED_STATES',
        currencyCode: 'USD',
        canonicalSeriesCode: code,
        ...(code === CPI_SERIES_CODE_R1 ? SERIES_DEFINITIONS.cpi : SERIES_DEFINITIONS.treasury),
        methodologyVersionId: methodologyObjectId,
        validFrom: '2007-01-01',
        validThrough: null,
      },
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

  const vintageIds = [];
  const counts = { treasuryObservations: {}, treasuryBlankCells: {}, cpiObservations: 0, cpiVintages: 0, cpiRevisions: 0, cpiNonPublications: [] };

  /* Treasury: FINAL_ONLY, one INITIAL vintage per business date, 16:00 America/New_York. */
  const treasuryDates = new Set();
  for (const item of evidence.filter((entry) => entry.sourceAuthority === 'US_TREASURY')) {
    for (const row of parseTreasuryParYieldCsvR1(item.bytes)) {
      if (row.date < coverage.treasuryObservationFromInclusive || row.date > coverage.treasuryObservationToInclusive) continue;
      if (treasuryDates.has(row.date)) fail('TREASURY_DATE_IN_TWO_DOCUMENTS', { date: row.date });
      treasuryDates.add(row.date);
      for (const code of TREASURY_SERIES_CODES_R1) {
        const value = row.values[code];
        if (value === null) { counts.treasuryBlankCells[code] = (counts.treasuryBlankCells[code] ?? 0) + 1; continue; }
        const observation = buildMacroObservationIdentityCore({
          store,
          identity: {
            schemaVersion: 'MacroObservationIdentityCore/1',
            macroSeriesIdentityId: series[code].macroSeriesIdentityId,
            observationPeriodStart: row.date,
            observationPeriodEnd: row.date,
            referencePeriod: row.date,
            unit: 'PERCENT',
            seasonalAdjustment: 'NOT_APPLICABLE',
          },
        });
        const vintage = buildMacroObservationVintageCore({
          store,
          policy,
          series: series[code].macroSeriesIdentity,
          observationIdentityId: observation.observationIdentityId,
          releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
          releaseTimestamp: null,
          releaseCivilDate: row.date,
          vintageSequence: 0,
          value,
          revisionKind: 'INITIAL',
          parentVintageId: null,
          vintageCompletenessClass: 'FINAL_ONLY',
          sourceDocumentId: item.sourceObjectId,
        });
        vintageIds.push(vintage.observationVintageId);
        counts.treasuryObservations[code] = (counts.treasuryObservations[code] ?? 0) + 1;
      }
    }
  }

  /* CPI: BLS point-in-time vintages carried by ALFRED, 08:30 America/New_York on each release date. */
  const alfred = evidence.find((entry) => entry.sourceAuthority === 'FRED_ALFRED');
  const csvBytes = readZipEntriesR1(alfred.bytes).get(ALFRED_REAL_TIME_ENTRY_NAME_R1);
  if (!csvBytes) fail('ALFRED_REAL_TIME_ENTRY_ABSENT');
  const cpiDocumentId = store.putSourceBytes(csvBytes).objectId;
  const parsed = parseAlfredRealTimePeriodCsvR1(csvBytes);
  counts.cpiNonPublications = parsed.nonPublications;
  for (const chain of parsed.chains) {
    if (chain.referencePeriod < coverage.cpiReferencePeriodFromInclusive || chain.referencePeriod > coverage.cpiReferencePeriodToInclusive) continue;
    const vintages = chain.vintages.filter((item) => item.realtimeStart <= coverage.vintageReleaseCivilDateToInclusive);
    if (vintages.length === 0) continue;
    const observation = buildMacroObservationIdentityCore({
      store,
      identity: {
        schemaVersion: 'MacroObservationIdentityCore/1',
        macroSeriesIdentityId: series[CPI_SERIES_CODE_R1].macroSeriesIdentityId,
        observationPeriodStart: `${chain.referencePeriod}-01`,
        observationPeriodEnd: lastDayOfMonth(chain.referencePeriod),
        referencePeriod: chain.referencePeriod,
        unit: 'INDEX',
        seasonalAdjustment: 'SEASONALLY_ADJUSTED',
      },
    });
    counts.cpiObservations += 1;
    let parent = null;
    vintages.forEach((item, sequence) => {
      if (parent !== null && parent.value.atoms === item.value.atoms && parent.value.scale === item.value.scale) {
        fail('ALFRED_REAL_TIME_PERIOD_WITHOUT_VALUE_CHANGE', { referencePeriod: chain.referencePeriod, realtimeStart: item.realtimeStart });
      }
      const built = buildMacroObservationVintageCore({
        store,
        policy,
        series: series[CPI_SERIES_CODE_R1].macroSeriesIdentity,
        observationIdentityId: observation.observationIdentityId,
        releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
        releaseTimestamp: null,
        releaseCivilDate: item.realtimeStart,
        vintageSequence: sequence,
        value: item.value,
        revisionKind: sequence === 0 ? 'INITIAL' : 'REVISION',
        parentVintageId: parent === null ? null : parent.macroVintageIdentityId,
        vintageCompletenessClass: 'VINTAGE_COMPLETE',
        sourceDocumentId: cpiDocumentId,
      });
      vintageIds.push(built.observationVintageId);
      counts.cpiVintages += 1;
      if (sequence > 0) counts.cpiRevisions += 1;
      parent = { macroVintageIdentityId: built.macroVintageIdentityId, value: item.value };
    });
  }

  const vintageSet = buildMacroVintageSetManifest({
    store,
    macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: ingestion.macroIngestionPolicyId,
    supersedesVintageSetManifestId: null,
    observationVintageIds: vintageIds,
  });
  const snapshot = buildMacroDatasetSnapshotManifest({
    store,
    macroIngestionPolicyId: ingestion.macroIngestionPolicyId,
    macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
  });

  const ids = {
    macroIngestionPolicyId: ingestion.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
    macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: snapshot.macroDatasetSnapshotManifestId,
    featureComputationPolicyId: featurePolicy.featureComputationPolicyId,
    instrumentProjectionPolicyId: projectionPolicy.instrumentProjectionPolicyId,
    cpiSuccessorInstrumentProjectionPolicyId: cpiSuccessorPolicy.instrumentProjectionPolicyId,
  };
  const projection = {
    schemaVersion: HISTORICAL_MACRO_BINDING_PROJECTION_SCHEMA_R1,
    authoritative: false,
    producerClassification: HISTORICAL_MACRO_PRODUCER_CLASSIFICATION_R1,
    coverage,
    ...ids,
  };
  const provenance = {
    schemaVersion: 'JarviseG25HistoricalMacroContextProvenance/2',
    authoritative: false,
    mission: MISSION_ID,
    producerClassification: HISTORICAL_MACRO_PRODUCER_CLASSIFICATION_R1,
    artifactIds: ids,
    coverage,
    sourceEvidence: evidence.map(({ path, sha256: digest, byteLength, sourceAuthority, sourceObjectId }) => ({ path, sha256: digest, byteLength, sourceAuthority, sourceObjectId })),
    cpiSourceDocument: { entryName: ALFRED_REAL_TIME_ENTRY_NAME_R1, sourceObjectId: cpiDocumentId },
    seriesIdentityIds: Object.fromEntries(Object.entries(series).map(([code, built]) => [code, built.macroSeriesIdentityId])),
    counts: {
      ...counts,
      vintageCount: vintageSet.vintageSet.vintageCount,
      observationCount: vintageSet.vintageSet.observationCount,
      firstAvailableAt: vintageSet.vintageSet.firstAvailableAt,
      lastAvailableAt: vintageSet.vintageSet.lastAvailableAt,
    },
    truthStatement: 'Real FREE/public macro evidence acquired once OFF_SCAN and normalized by the unchanged L4B builders. October 2025 CPI-U was not published by BLS; it is carried as an explicit non-publication and never imputed. cpiYoY is derived under the additive CPI successor policy MarketMacroInstrumentProjectionPolicy/2 (ENDPOINTS_M_AND_M_MINUS_12_REQUIRED, OWNER_DECIDE_GATE25_CPI_SUCCESSOR_POLICY_R1 OPTION A); the V1 policy object is materialized unchanged.',
    ownerDecision: 'OWNER_DECIDE_GATE25_CPI_SUCCESSOR_POLICY_R1:OPTION_A',
    runtimeModule: 'app/jarvise/jarviseG25HistoricalMacroContextR1.mjs',
    materializer: 'scripts/materializeJarviseG25HistoricalMacroContextR1.mjs',
    bindingContract: 'governance/gates/GATE24/implementation/macro-context-binding-v1.mjs::GATE24_MacroContextBinding/1',
    networkDuringMaterialization: 'NONE',
  };
  const projectionWrite = writeStableCanonical(join(outputRoot, 'binding-projection.json'), projection);
  const provenanceWrite = writeStableCanonical(join(outputRoot, 'PROVENANCE.json'), provenance);
  return Object.freeze({ status: 'MATERIALIZED_AND_VERIFIED', outputRoot, ids, counts: provenance.counts, projectionWrite, provenanceWrite, cpiSuccessorPolicyWrite });
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    process.stdout.write(`${JSON.stringify(materializeJarviseG25HistoricalMacroContextR1(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ verdict: error?.code ?? 'MATERIALIZATION_FAILED', message: error?.message, details: error?.details ?? {} }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
