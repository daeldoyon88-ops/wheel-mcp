/**
 * L4B-P official market-macro reference publication.
 *
 * This module never enumerates the CAS and never performs network or wall-clock
 * reads. Every authority is supplied as an explicit immutable content address.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  assertUtcInstant,
  canonicalDigest,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_AUTHORITY_PIN_FIELDS,
  MARKET_MACRO_AUTHORITY_POLICY_VALUES,
  MARKET_MACRO_FAMILY_CODES,
  MARKET_MACRO_FEATURE_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_MACRO_IMPLEMENTATION_PHASES,
  MARKET_MACRO_PUBLICATION_VERSION,
  MARKET_MACRO_REGISTRY_NAMESPACE_VERSION,
  normalizeMarketMacroFeatureAuthorityPolicyV1,
  normalizeMarketMacroFeatureCoverageReportV1,
  normalizeMarketMacroFeaturePublicationManifestV1,
  normalizeMarketMacroFeatureRegistryManifestV1,
} from '../contracts/marketMacroFeaturePublicationContractsL4BPV1.mjs';
import {
  MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  MACRO_INGESTION_POLICY_SCHEMA_VERSION,
  MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
} from '../contracts/macroIngestionContractsL4BV1.mjs';
import {
  MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  MACRO_DATASET_BINDING_SCHEMA_VERSION,
  MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION,
} from '../contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  verifyMarketCalendarRegistry,
} from '../contracts/marketCalendarL3V1.mjs';
import {
  INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION,
} from '../contracts/instrumentIdentityV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  buildTransformImplementationManifestV2,
} from '../data/transformImplementationManifestV2.mjs';
import { verifyInstrumentIdentityRegistry } from '../data/buildInstrumentIdentityRegistry.mjs';
import { verifyMacroIngestionPolicy } from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroSeriesRegistryManifest } from './macroSeriesRegistryL4BV1.mjs';
import { verifyMacroVintageSetManifest } from './macroVintageSetL4BV1.mjs';
import { verifyMacroDatasetSnapshotManifest } from './macroDatasetSnapshotL4BV1.mjs';
import { verifyMacroAsOfResolutionPolicy } from './macroAsOfResolutionPolicyL4BV1.mjs';
import { verifyMacroReleaseCalendarRegistryManifest } from './macroReleaseCalendarRegistryL4BV1.mjs';
import { verifyMacroDatasetBinding } from './macroDatasetBindingL4BV1.mjs';
import { verifyMacroMaterializationReport } from './macroMaterializationReportL4BV1.mjs';
import { verifyMarketMacroFeatureComputationPolicy } from './marketMacroFeatureComputationPolicyL4BV1.mjs';
import { verifyMarketMacroFeatureSourceBundle } from './marketMacroFeatureSourceBundleL4BV1.mjs';
import { verifyMacroStateBySessionRows } from './macroStateBySessionRowsL4BV1.mjs';
import { verifyMarketMacroFeatureComputationReport } from './marketMacroFeatureComputationReportL4BV1.mjs';
import { verifyMarketMacroInstrumentProjectionPolicy } from './marketMacroInstrumentProjectionPolicyL4BF2V1.mjs';
import { verifyMarketMacroFullStateRows } from './marketMacroFullStateRowsL4BF2V1.mjs';
import { verifyMarketMacroInstrumentRows } from './marketMacroInstrumentRowsL4BF2V1.mjs';
import { verifyMarketMacroFullComputationReport } from './marketMacroFullComputationReportL4BF2V1.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject',
  'readCanonicalObject',
  'uriForObject',
  'readObject',
  'putSourceBytes',
]);
const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const IMPLEMENTATION_PROFILES = Object.freeze({
  I1: Object.freeze({
    runtimeContractVersion: 'MARKET_MACRO_INGESTION_L4B_I1/1',
    logicalPaths: Object.freeze([
      'src/contracts/macroIngestionContractsL4BV1.mjs',
      'src/macro/macroIngestionPolicyL4BV1.mjs',
      'src/macro/macroSeriesRegistryL4BV1.mjs',
      'src/macro/macroObservationVintageL4BV1.mjs',
      'src/macro/macroVintageSetL4BV1.mjs',
      'src/macro/macroDatasetSnapshotL4BV1.mjs',
    ]),
  }),
  I2: Object.freeze({
    runtimeContractVersion: 'MARKET_MACRO_MATERIALIZATION_L4B_I2/1',
    logicalPaths: Object.freeze([
      'src/contracts/macroMaterializationContractsL4BV1.mjs',
      'src/macro/macroAsOfResolutionPolicyL4BV1.mjs',
      'src/macro/macroReleaseCalendarRegistryL4BV1.mjs',
      'src/macro/macroDatasetBindingL4BV1.mjs',
      'src/macro/resolveMacroVintageAsOfL4BV1.mjs',
      'src/macro/macroMaterializationReportL4BV1.mjs',
    ]),
  }),
  F1: Object.freeze({
    runtimeContractVersion: 'MARKET_MACRO_FEATURE_L4B_F1/1',
    logicalPaths: Object.freeze([
      'src/contracts/macroFeatureContractsL4BV1.mjs',
      'src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs',
      'src/macro/marketMacroFeatureSourceBundleL4BV1.mjs',
      'src/macro/macroSeriesSessionResolutionL4BV1.mjs',
      'src/macro/macroRateFeaturesL4BV1.mjs',
      'src/macro/macroFomcFeaturesL4BV1.mjs',
      'src/macro/macroCurveFeaturesL4BV1.mjs',
      'src/macro/macroStateBySessionRowsL4BV1.mjs',
      'src/macro/marketMacroFeatureComputationReportL4BV1.mjs',
    ]),
  }),
  F2: Object.freeze({
    runtimeContractVersion: 'MARKET_MACRO_FEATURE_L4B_F2/1',
    logicalPaths: Object.freeze([
      'src/contracts/macroFullFeatureContractsL4BF2V1.mjs',
      'src/macro/marketMacroInstrumentProjectionPolicyL4BF2V1.mjs',
      'src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs',
      'src/macro/macroFixedPointRatioL4BF2V1.mjs',
      'src/macro/macroInflationFeaturesL4BF2V1.mjs',
      'src/macro/macroLaborFeaturesL4BF2V1.mjs',
      'src/macro/macroClaimsFeaturesL4BF2V1.mjs',
      'src/macro/macroFullMacroStateL4BF2V1.mjs',
      'src/macro/marketMacroFullStateRowsL4BF2V1.mjs',
      'src/macro/marketMacroInstrumentRowsL4BF2V1.mjs',
      'src/macro/marketMacroFullComputationReportL4BF2V1.mjs',
    ]),
  }),
});

const FAMILY_PHASE = Object.freeze({
  RATES: 'F1',
  FOMC: 'F1',
  TREASURY_CURVE: 'F1',
  INFLATION: 'F2',
  UNEMPLOYMENT: 'F2',
  CLAIMS: 'F2',
  FULL_MACRO_STATE: 'F2',
  INSTRUMENT_PROJECTION: 'F2',
});

function fail(code, message) {
  throw new MarketDataL3Error(code, message);
}

function assertPins(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_PIN_MISMATCH', 'authorityPins must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== MARKET_MACRO_AUTHORITY_PIN_FIELDS.length
      || MARKET_MACRO_AUTHORITY_PIN_FIELDS.some((field) => !Object.hasOwn(value, field))) {
    fail('MARKET_DATA_MACRO_PUBLICATION_PIN_MISMATCH',
      'authorityPins must contain the closed 18-reference inventory');
  }
  for (const field of MARKET_MACRO_AUTHORITY_PIN_FIELDS) assertCasId(value[field], field);
  return Object.fromEntries(MARKET_MACRO_AUTHORITY_PIN_FIELDS.map((field) => [field, value[field]]));
}

function read(store, id, schemaVersion, label) {
  return readTypedReference(store, id, schemaVersion, label);
}

function same(left, right, code, message) {
  if (left !== right) fail(code, message);
}

function expectedImplementationManifest(phaseCode) {
  const profile = IMPLEMENTATION_PROFILES[phaseCode];
  if (!profile) {
    fail('MARKET_DATA_MACRO_PUBLICATION_IMPLEMENTATION_MISMATCH',
      'unknown market-macro implementation phase');
  }
  return buildTransformImplementationManifestV2({
    labRoot: LAB_ROOT,
    runtimeContractVersion: profile.runtimeContractVersion,
    logicalPaths: [...profile.logicalPaths],
  });
}

export function computeMarketMacroPublicationImplementationIdentity(input) {
  const api = assertApiInput(input, ['phaseCode']);
  assertStore(api.store, STORE_METHODS);
  if (!MARKET_MACRO_IMPLEMENTATION_PHASES.includes(api.phaseCode)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_IMPLEMENTATION_MISMATCH',
      'phaseCode must be one of I1/I2/F1/F2');
  }
  const value = expectedImplementationManifest(api.phaseCode);
  const stored = putCanonicalL3(api.store,
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, value);
  return {
    phaseCode: api.phaseCode,
    implementationManifestId: stored.objectId,
    implementationManifest: value,
  };
}

export const buildMarketMacroPublicationImplementationIdentity =
  computeMarketMacroPublicationImplementationIdentity;

export function verifyMarketMacroPublicationImplementationIdentity(input) {
  const api = assertApiInput(input, ['phaseCode', 'implementationManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.implementationManifestId, 'implementationManifestId');
  const observed = read(api.store, api.implementationManifestId,
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, 'implementation manifest');
  const expected = expectedImplementationManifest(api.phaseCode);
  if (!canonicalValuesEqual(observed, expected)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_IMPLEMENTATION_MISMATCH',
      `${api.phaseCode} implementation manifest diverges from closed runtime identity`);
  }
  return {
    phaseCode: api.phaseCode,
    implementationManifestId: api.implementationManifestId,
    implementationManifest: observed,
  };
}

function verifyImplementationIdentities(store, identities) {
  if (!Array.isArray(identities) || identities.length !== MARKET_MACRO_IMPLEMENTATION_PHASES.length) {
    fail('MARKET_DATA_MACRO_PUBLICATION_IMPLEMENTATION_MISMATCH',
      'exactly four implementation identities are required');
  }
  return MARKET_MACRO_IMPLEMENTATION_PHASES.map((phaseCode, index) => {
    const identity = identities[index];
    if (identity?.phaseCode !== phaseCode) {
      fail('MARKET_DATA_MACRO_PUBLICATION_IMPLEMENTATION_MISMATCH',
        'implementation identities must follow I1/I2/F1/F2 order');
    }
    verifyMarketMacroPublicationImplementationIdentity({
      store,
      phaseCode,
      implementationManifestId: identity.implementationManifestId,
    });
    return {
      phaseCode,
      implementationManifestId: identity.implementationManifestId,
    };
  });
}

export function buildMarketMacroFeatureAuthorityPolicy(input) {
  const api = assertApiInput(input, []);
  assertStore(api.store, STORE_METHODS);
  const value = normalizeMarketMacroFeatureAuthorityPolicyV1(
    MARKET_MACRO_AUTHORITY_POLICY_VALUES);
  const stored = putCanonicalL3(api.store,
    MARKET_MACRO_FEATURE_AUTHORITY_POLICY_SCHEMA_VERSION, value);
  return { authorityPolicyId: stored.objectId, authorityPolicy: value };
}

export function verifyMarketMacroFeatureAuthorityPolicy(input) {
  const api = assertApiInput(input, ['authorityPolicyId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.authorityPolicyId, 'authorityPolicyId');
  const value = read(api.store, api.authorityPolicyId,
    MARKET_MACRO_FEATURE_AUTHORITY_POLICY_SCHEMA_VERSION, 'authority policy');
  const normalized = normalizeMarketMacroFeatureAuthorityPolicyV1(value);
  return { authorityPolicyId: api.authorityPolicyId, authorityPolicy: normalized };
}

function verifyPinClosure(store, rawPins) {
  const pins = assertPins(rawPins);

  verifyMacroIngestionPolicy({ store, macroIngestionPolicyId: pins.macroIngestionPolicyId });
  verifyMacroSeriesRegistryManifest({
    store,
    macroSeriesRegistryManifestId: pins.macroSeriesRegistryManifestId,
  });
  verifyMacroVintageSetManifest({
    store,
    macroVintageSetManifestId: pins.macroVintageSetManifestId,
  });
  verifyMacroDatasetSnapshotManifest({
    store,
    macroDatasetSnapshotManifestId: pins.macroDatasetSnapshotManifestId,
  });
  verifyMacroAsOfResolutionPolicy({
    store,
    macroAsOfResolutionPolicyId: pins.macroAsOfResolutionPolicyId,
  });
  verifyMacroReleaseCalendarRegistryManifest({
    store,
    macroReleaseCalendarRegistryManifestId: pins.macroReleaseCalendarRegistryManifestId,
  });
  verifyMacroDatasetBinding({ store, macroDatasetBindingId: pins.macroDatasetBindingId });
  verifyMacroMaterializationReport({
    store,
    macroMaterializationReportId: pins.macroMaterializationReportId,
  });
  verifyMarketMacroFeatureComputationPolicy({
    store,
    featureComputationPolicyId: pins.marketMacroFeatureComputationPolicyId,
  });
  verifyMarketMacroFeatureSourceBundle({
    store,
    sourceBundleId: pins.marketMacroFeatureSourceBundleId,
  });
  verifyMacroStateBySessionRows({
    store,
    macroStateBySessionRowsId: pins.macroStateBySessionRowsId,
    sourceBundleId: pins.marketMacroFeatureSourceBundleId,
    featureComputationPolicyId: pins.marketMacroFeatureComputationPolicyId,
  });
  verifyMarketMacroFeatureComputationReport({
    store,
    macroFeatureComputationReportId: pins.marketMacroFeatureComputationReportId,
  });
  verifyMarketMacroInstrumentProjectionPolicy({
    store,
    instrumentProjectionPolicyId: pins.marketMacroInstrumentProjectionPolicyId,
  });
  verifyMarketMacroFullStateRows({
    store,
    fullStateRowsId: pins.marketMacroFullStateRowsId,
    f1MacroStateBySessionRowsId: pins.macroStateBySessionRowsId,
    f1SourceBundleId: pins.marketMacroFeatureSourceBundleId,
    f1FeatureComputationPolicyId: pins.marketMacroFeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: pins.marketMacroFeatureComputationReportId,
    instrumentProjectionPolicyId: pins.marketMacroInstrumentProjectionPolicyId,
  });
  verifyMarketMacroInstrumentRows({
    store,
    instrumentRowsId: pins.marketMacroInstrumentRowsId,
    fullStateRowsId: pins.marketMacroFullStateRowsId,
    f1MacroStateBySessionRowsId: pins.macroStateBySessionRowsId,
    f1SourceBundleId: pins.marketMacroFeatureSourceBundleId,
    f1FeatureComputationPolicyId: pins.marketMacroFeatureComputationPolicyId,
    f1MacroFeatureComputationReportId: pins.marketMacroFeatureComputationReportId,
    instrumentProjectionPolicyId: pins.marketMacroInstrumentProjectionPolicyId,
    instrumentIdentityRegistryManifestId: pins.instrumentIdentityRegistryManifestId,
  });
  verifyMarketMacroFullComputationReport({
    store,
    fullComputationReportId: pins.marketMacroFullComputationReportId,
  });
  verifyMarketCalendarRegistry({
    store,
    calendarRegistryManifestId: pins.marketSessionRegistryManifestId,
  });
  verifyInstrumentIdentityRegistry({
    store,
    registryManifestId: pins.instrumentIdentityRegistryManifestId,
  });

  const ingestionPolicy = read(store, pins.macroIngestionPolicyId,
    MACRO_INGESTION_POLICY_SCHEMA_VERSION, 'macro ingestion policy');
  const seriesRegistry = read(store, pins.macroSeriesRegistryManifestId,
    MACRO_SERIES_REGISTRY_MANIFEST_SCHEMA_VERSION, 'macro series registry');
  const vintageSet = read(store, pins.macroVintageSetManifestId,
    MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION, 'macro vintage set');
  const snapshot = read(store, pins.macroDatasetSnapshotManifestId,
    MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION, 'macro dataset snapshot');
  const asOfPolicy = read(store, pins.macroAsOfResolutionPolicyId,
    MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION, 'macro as-of policy');
  const releaseCalendar = read(store, pins.macroReleaseCalendarRegistryManifestId,
    MACRO_RELEASE_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, 'release calendar');
  const binding = read(store, pins.macroDatasetBindingId,
    MACRO_DATASET_BINDING_SCHEMA_VERSION, 'macro dataset binding');
  const materialization = read(store, pins.macroMaterializationReportId,
    MACRO_MATERIALIZATION_REPORT_SCHEMA_VERSION, 'macro materialization report');
  const f1Policy = read(store, pins.marketMacroFeatureComputationPolicyId,
    MARKET_MACRO_FEATURE_COMPUTATION_POLICY_SCHEMA_VERSION, 'F1 policy');
  const sourceBundle = read(store, pins.marketMacroFeatureSourceBundleId,
    MARKET_MACRO_FEATURE_SOURCE_BUNDLE_SCHEMA_VERSION, 'F1 source bundle');
  const f1Rows = read(store, pins.macroStateBySessionRowsId,
    MACRO_STATE_BY_SESSION_ROWS_SCHEMA_VERSION, 'F1 rows');
  const f1Report = read(store, pins.marketMacroFeatureComputationReportId,
    MARKET_MACRO_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION, 'F1 report');
  const f2Policy = read(store, pins.marketMacroInstrumentProjectionPolicyId,
    MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION, 'F2 policy');
  const fullRows = read(store, pins.marketMacroFullStateRowsId,
    MARKET_MACRO_FULL_STATE_ROWS_SCHEMA_VERSION, 'F2 full rows');
  const instrumentRows = read(store, pins.marketMacroInstrumentRowsId,
    MARKET_MACRO_INSTRUMENT_ROWS_SCHEMA_VERSION, 'F2 instrument rows');
  const fullReport = read(store, pins.marketMacroFullComputationReportId,
    MARKET_MACRO_FULL_COMPUTATION_REPORT_SCHEMA_VERSION, 'F2 report');
  const sessionRegistry = read(store, pins.marketSessionRegistryManifestId,
    MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION, 'market session registry');
  const instrumentRegistry = read(store, pins.instrumentIdentityRegistryManifestId,
    INSTRUMENT_IDENTITY_REGISTRY_MANIFEST_SCHEMA_VERSION, 'instrument registry');

  const code = 'MARKET_DATA_MACRO_PUBLICATION_PIN_MISMATCH';
  same(snapshot.macroIngestionPolicyId, pins.macroIngestionPolicyId, code,
    'snapshot ingestion policy pin mismatch');
  same(snapshot.macroSeriesRegistryManifestId, pins.macroSeriesRegistryManifestId, code,
    'snapshot series registry pin mismatch');
  same(snapshot.macroVintageSetManifestId, pins.macroVintageSetManifestId, code,
    'snapshot vintage set pin mismatch');
  same(vintageSet.macroSeriesRegistryManifestId, pins.macroSeriesRegistryManifestId, code,
    'vintage set series registry pin mismatch');
  same(vintageSet.macroIngestionPolicyId, pins.macroIngestionPolicyId, code,
    'vintage set ingestion policy pin mismatch');
  same(binding.macroDatasetSnapshotManifestId, pins.macroDatasetSnapshotManifestId, code,
    'binding snapshot pin mismatch');
  same(binding.macroVintageSetManifestId, pins.macroVintageSetManifestId, code,
    'binding vintage set pin mismatch');
  same(binding.macroSeriesRegistryManifestId, pins.macroSeriesRegistryManifestId, code,
    'binding series registry pin mismatch');
  same(binding.macroIngestionPolicyId, pins.macroIngestionPolicyId, code,
    'binding ingestion policy pin mismatch');
  same(binding.macroAsOfResolutionPolicyId, pins.macroAsOfResolutionPolicyId, code,
    'binding as-of policy pin mismatch');
  same(binding.macroReleaseCalendarRegistryManifestId,
    pins.macroReleaseCalendarRegistryManifestId, code, 'binding release calendar pin mismatch');
  same(materialization.macroDatasetBindingId, pins.macroDatasetBindingId, code,
    'materialization binding pin mismatch');
  same(sourceBundle.macroDatasetBindingId, pins.macroDatasetBindingId, code,
    'F1 source bundle binding pin mismatch');
  same(sourceBundle.macroMaterializationReportId, pins.macroMaterializationReportId, code,
    'F1 source bundle materialization pin mismatch');
  same(sourceBundle.marketCalendarRegistryManifestId,
    pins.marketSessionRegistryManifestId, code, 'F1 session registry pin mismatch');
  same(f1Rows.rows[0]?.featureComputationPolicyId ?? pins.marketMacroFeatureComputationPolicyId,
    pins.marketMacroFeatureComputationPolicyId, code, 'F1 rows policy pin mismatch');
  same(f1Rows.rows[0]?.sourceBundleId ?? pins.marketMacroFeatureSourceBundleId,
    pins.marketMacroFeatureSourceBundleId, code, 'F1 rows source pin mismatch');
  same(f1Report.sourceBundleId, pins.marketMacroFeatureSourceBundleId, code,
    'F1 report source pin mismatch');
  same(f1Report.featureComputationPolicyId, pins.marketMacroFeatureComputationPolicyId, code,
    'F1 report policy pin mismatch');
  same(f1Report.macroStateBySessionRowsId, pins.macroStateBySessionRowsId, code,
    'F1 report rows pin mismatch');
  same(fullRows.f1MacroStateBySessionRowsId, pins.macroStateBySessionRowsId, code,
    'F2 full rows F1 rows pin mismatch');
  same(fullRows.f1SourceBundleId, pins.marketMacroFeatureSourceBundleId, code,
    'F2 full rows F1 source pin mismatch');
  same(fullRows.f1FeatureComputationPolicyId, pins.marketMacroFeatureComputationPolicyId, code,
    'F2 full rows F1 policy pin mismatch');
  same(fullRows.f1MacroFeatureComputationReportId,
    pins.marketMacroFeatureComputationReportId, code, 'F2 full rows F1 report pin mismatch');
  same(fullRows.projectionPolicyId,
    pins.marketMacroInstrumentProjectionPolicyId, code, 'F2 full rows policy pin mismatch');
  same(instrumentRows.fullStateRowsId, pins.marketMacroFullStateRowsId, code,
    'instrument rows full-state pin mismatch');
  same(instrumentRows.instrumentRegistryManifestId,
    pins.instrumentIdentityRegistryManifestId, code, 'instrument rows registry pin mismatch');
  same(instrumentRows.projectionPolicyId,
    pins.marketMacroInstrumentProjectionPolicyId, code, 'instrument rows policy pin mismatch');
  same(fullReport.fullStateRowsId, pins.marketMacroFullStateRowsId, code,
    'F2 report full rows pin mismatch');
  same(fullReport.instrumentRowsId, pins.marketMacroInstrumentRowsId, code,
    'F2 report instrument rows pin mismatch');
  same(fullReport.instrumentIdentityRegistryManifestId,
    pins.instrumentIdentityRegistryManifestId, code, 'F2 report registry pin mismatch');
  same(ingestionPolicy.jurisdictionCode, 'UNITED_STATES', code,
    'ingestion jurisdiction must be UNITED_STATES');
  same(ingestionPolicy.currencyCode, 'USD', code, 'ingestion currency must be USD');
  same(binding.jurisdictionCode, 'UNITED_STATES', code,
    'binding jurisdiction must be UNITED_STATES');
  same(binding.currencyCode, 'USD', code, 'binding currency must be USD');
  same(asOfPolicy.latestReferencePolicy, 'FORBIDDEN', code,
    'as-of policy must forbid latest');
  same(f1Policy.latestPolicy, 'FORBIDDEN', code, 'F1 policy must forbid latest');
  same(f2Policy.latestPolicy, 'FORBIDDEN', code, 'F2 policy must forbid latest');
  same(releaseCalendar.macroSeriesRegistryManifestId,
    pins.macroSeriesRegistryManifestId, code, 'release calendar series registry pin mismatch');

  return {
    pins,
    ingestionPolicy,
    seriesRegistry,
    vintageSet,
    snapshot,
    asOfPolicy,
    releaseCalendar,
    binding,
    materialization,
    f1Policy,
    sourceBundle,
    f1Rows,
    f1Report,
    f2Policy,
    fullRows,
    instrumentRows,
    fullReport,
    sessionRegistry,
    instrumentRegistry,
  };
}

function implementationIdByPhase(identities) {
  return new Map(identities.map((item) => [item.phaseCode, item.implementationManifestId]));
}

function familyReference(familyCode, closure, identities) {
  const phaseCode = FAMILY_PHASE[familyCode];
  const implementationManifestId = implementationIdByPhase(identities).get(phaseCode);
  if (phaseCode === 'F1') {
    return {
      phaseCode,
      featureVersion: 'MARKET_MACRO_FEATURE_L4B_F1/1',
      policyId: closure.pins.marketMacroFeatureComputationPolicyId,
      sourceBundleId: closure.pins.marketMacroFeatureSourceBundleId,
      rowsId: closure.pins.macroStateBySessionRowsId,
      reportId: closure.pins.marketMacroFeatureComputationReportId,
      implementationManifestId,
    };
  }
  return {
    phaseCode,
    featureVersion: 'MARKET_MACRO_FEATURE_L4B_F2/1',
    policyId: closure.pins.marketMacroInstrumentProjectionPolicyId,
    sourceBundleId: closure.pins.marketMacroFeatureSourceBundleId,
    rowsId: familyCode === 'INSTRUMENT_PROJECTION'
      ? closure.pins.marketMacroInstrumentRowsId
      : closure.pins.marketMacroFullStateRowsId,
    reportId: closure.pins.marketMacroFullComputationReportId,
    implementationManifestId,
  };
}

function deriveTemporalCapability(closure) {
  if (closure.fullRows.rows.length === 0) return 'EMPTY';
  if (closure.binding.temporalCapability === 'POINT_IN_TIME_VINTAGE_COMPLETE'
      && closure.fullReport.partialMacroSessionCount === 0
      && closure.fullReport.unavailableMacroSessionCount === 0) {
    return 'COMPLETE_POINT_IN_TIME';
  }
  return 'PARTIAL_POINT_IN_TIME';
}

function entryIdentity(entryWithoutIdentity) {
  return canonicalDigest(entryWithoutIdentity);
}

function deriveRegistryValue(input) {
  const {
    authorityPolicyId,
    closure,
    implementationIdentities,
    availableAt,
    publicationStatus,
    withdrawalReason,
    parent,
    parentId,
  } = input;
  const temporalCapability = deriveTemporalCapability(closure);
  const entries = MARKET_MACRO_FAMILY_CODES.map((familyCode, index) => {
    const parentEntry = parent?.entries[index] ?? null;
    const base = {
      familyCode,
      ...familyReference(familyCode, closure, implementationIdentities),
      availableAt,
      publicationStatus,
      temporalCapability,
      supersedesEntryIdentityDigest: parentEntry?.entryIdentityDigest ?? null,
      withdrawalReason,
    };
    return { ...base, entryIdentityDigest: entryIdentity(base) };
  });
  return normalizeMarketMacroFeatureRegistryManifestV1({
    schemaVersion: MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId,
    registryNamespaceVersion: MARKET_MACRO_REGISTRY_NAMESPACE_VERSION,
    publicationVersion: MARKET_MACRO_PUBLICATION_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    availableAt,
    temporalCapability,
    supersedesRegistryManifestId: parentId,
    entries,
    orderedEntryDigest: canonicalDigest(entries.map((entry) => ({
      familyCode: entry.familyCode,
      entryIdentityDigest: entry.entryIdentityDigest,
    }))),
  });
}

export function buildMarketMacroFeatureRegistryManifest(input) {
  const api = assertApiInput(input, [
    'authorityPolicyId',
    'authorityPins',
    'implementationIdentities',
    'availableAt',
    'publicationStatus',
    'withdrawalReason',
    'baseRegistryManifestId',
  ]);
  assertStore(api.store, STORE_METHODS);
  verifyMarketMacroFeatureAuthorityPolicy({
    store: api.store,
    authorityPolicyId: api.authorityPolicyId,
  });
  assertUtcInstant(api.availableAt, 'availableAt');
  const closure = verifyPinClosure(api.store, api.authorityPins);
  const identities = verifyImplementationIdentities(api.store, api.implementationIdentities);
  let parent = null;
  if (api.baseRegistryManifestId !== null) {
    parent = verifyMarketMacroFeatureRegistryManifest({
      store: api.store,
      registryManifestId: api.baseRegistryManifestId,
    }).registryManifest;
    if (parent.authorityPolicyId !== api.authorityPolicyId) {
      fail('MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
        'registry parent authority policy mismatch');
    }
    if (api.availableAt < parent.availableAt) {
      fail('MARKET_DATA_MACRO_PUBLICATION_CAUSALITY_VIOLATION',
        'registry child availableAt precedes parent');
    }
  }
  const value = deriveRegistryValue({
    authorityPolicyId: api.authorityPolicyId,
    closure,
    implementationIdentities: identities,
    availableAt: api.availableAt,
    publicationStatus: api.publicationStatus,
    withdrawalReason: api.withdrawalReason,
    parent,
    parentId: api.baseRegistryManifestId,
  });
  const stored = putCanonicalL3(api.store,
    MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION, value);
  return { registryManifestId: stored.objectId, registryManifest: value };
}

function verifyRegistryRecursive(store, registryManifestId, seen = new Set()) {
  if (seen.has(registryManifestId)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CYCLE',
      'registry supersession chain contains a cycle');
  }
  seen.add(registryManifestId);
  const observed = normalizeMarketMacroFeatureRegistryManifestV1(read(store,
    registryManifestId, MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION,
    'market macro registry'));
  verifyMarketMacroFeatureAuthorityPolicy({
    store,
    authorityPolicyId: observed.authorityPolicyId,
  });
  let parent = null;
  if (observed.supersedesRegistryManifestId !== null) {
    parent = verifyRegistryRecursive(store, observed.supersedesRegistryManifestId, seen);
    if (observed.availableAt < parent.availableAt) {
      fail('MARKET_DATA_MACRO_PUBLICATION_CAUSALITY_VIOLATION',
        'registry child availableAt precedes parent');
    }
    for (let index = 0; index < observed.entries.length; index += 1) {
      if (observed.entries[index].supersedesEntryIdentityDigest
          !== parent.entries[index].entryIdentityDigest) {
        fail('MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
          'registry entry does not supersede its immediate family parent');
      }
    }
  } else if (observed.entries.some((entry) => entry.supersedesEntryIdentityDigest !== null)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
      'genesis registry entry cannot supersede an absent parent');
  }
  for (const entry of observed.entries) {
    const { entryIdentityDigest, ...base } = entry;
    if (entryIdentity(base) !== entryIdentityDigest) {
      fail('MARKET_DATA_MACRO_PUBLICATION_DIGEST_MISMATCH',
        'registry entry identity digest mismatch');
    }
  }
  const ordered = canonicalDigest(observed.entries.map((entry) => ({
    familyCode: entry.familyCode,
    entryIdentityDigest: entry.entryIdentityDigest,
  })));
  if (ordered !== observed.orderedEntryDigest) {
    fail('MARKET_DATA_MACRO_PUBLICATION_DIGEST_MISMATCH',
      'registry ordered entry digest mismatch');
  }
  return observed;
}

export function verifyMarketMacroFeatureRegistryManifest(input) {
  const api = assertApiInput(input, ['registryManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.registryManifestId, 'registryManifestId');
  const registryManifest = verifyRegistryRecursive(api.store, api.registryManifestId);
  return { registryManifestId: api.registryManifestId, registryManifest };
}

function coverageStatus(available, unavailable, sessionCount) {
  if (sessionCount === 0 || available === 0) return 'UNAVAILABLE';
  if (available === sessionCount && unavailable === 0) return 'COMPLETE';
  return 'PARTIAL';
}

function f1FamilyCoverage(closure, familyCode) {
  const field = familyCode === 'RATES'
    ? 'rateStateCompleteness'
    : familyCode === 'FOMC'
      ? 'fomcStateCompleteness'
      : 'curveStateCompleteness';
  const rows = closure.f1Rows.rows;
  const available = rows.filter((row) => row.availabilityState[field] === 'COMPLETE').length;
  const unavailable = rows.filter((row) => row.availabilityState[field] === 'UNAVAILABLE').length;
  const stale = rows.reduce((total, row) =>
    total + row.provenanceState.orderedSeriesResolutions
      .filter((resolution) => resolution.availabilityStatus === 'STALE').length, 0);
  const withdrawn = rows.reduce((total, row) =>
    total + row.provenanceState.orderedSeriesResolutions
      .filter((resolution) => resolution.availabilityStatus === 'WITHDRAWN').length, 0);
  return {
    familyCode,
    availableSessionCount: available,
    staleSessionCount: stale,
    withdrawnSessionCount: withdrawn,
    unavailableSessionCount: unavailable,
    coverageStatus: coverageStatus(available, unavailable, rows.length),
  };
}

function f2FamilyCoverage(closure, familyCode) {
  const rows = closure.fullRows.rows;
  if (familyCode === 'FULL_MACRO_STATE') {
    const available = rows.filter((row) =>
      row.fullAvailabilityState.fullMacroCompleteness === 'COMPLETE').length;
    const unavailable = rows.filter((row) =>
      row.fullAvailabilityState.fullMacroCompleteness === 'UNAVAILABLE').length;
    return {
      familyCode,
      availableSessionCount: available,
      staleSessionCount: closure.fullReport.cpiStaleSessionCount
        + closure.fullReport.unrateStaleSessionCount
        + closure.fullReport.claimsStaleSessionCount,
      withdrawnSessionCount: closure.fullReport.cpiWithdrawnSessionCount
        + closure.fullReport.unrateWithdrawnSessionCount
        + closure.fullReport.claimsWithdrawnSessionCount,
      unavailableSessionCount: unavailable,
      coverageStatus: coverageStatus(available, unavailable, rows.length),
    };
  }
  if (familyCode === 'INSTRUMENT_PROJECTION') {
    const statuses = closure.fullReport.projectionStatusCounts;
    const available = statuses.PROJECTED + statuses.PARTIAL > 0 ? rows.length : 0;
    const unavailable = rows.length - available;
    return {
      familyCode,
      availableSessionCount: available,
      staleSessionCount: 0,
      withdrawnSessionCount: 0,
      unavailableSessionCount: unavailable,
      coverageStatus: coverageStatus(available, unavailable, rows.length),
    };
  }
  const mapping = {
    INFLATION: ['inflationState', 'cpiAvailabilityStatus'],
    UNEMPLOYMENT: ['unemploymentState', 'unemploymentAvailabilityStatus'],
    CLAIMS: ['claimsState', 'claimsAvailabilityStatus'],
  };
  const [stateField, statusField] = mapping[familyCode];
  const statuses = rows.map((row) => row[stateField][statusField]);
  const available = statuses.filter((status) => status === 'AVAILABLE').length;
  const stale = statuses.filter((status) => status === 'STALE').length;
  const withdrawn = statuses.filter((status) => status === 'WITHDRAWN').length;
  const unavailable = statuses.length - available - stale - withdrawn;
  return {
    familyCode,
    availableSessionCount: available,
    staleSessionCount: stale,
    withdrawnSessionCount: withdrawn,
    unavailableSessionCount: unavailable,
    coverageStatus: coverageStatus(available, unavailable + stale + withdrawn, rows.length),
  };
}

function deriveCoverageValue(registryManifestId, registry, closure) {
  const fullRows = closure.fullRows.rows;
  const first = fullRows[0] ?? null;
  const last = fullRows[fullRows.length - 1] ?? null;
  const f1 = closure.f1Report;
  const f2 = closure.fullReport;
  const familyCoverage = MARKET_MACRO_FAMILY_CODES.map((familyCode) =>
    FAMILY_PHASE[familyCode] === 'F1'
      ? f1FamilyCoverage(closure, familyCode)
      : f2FamilyCoverage(closure, familyCode));
  return normalizeMarketMacroFeatureCoverageReportV1({
    schemaVersion: MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION,
    registryManifestId,
    authorityPins: closure.pins,
    firstSessionId: first?.sessionId ?? null,
    lastSessionId: last?.sessionId ?? null,
    firstSessionDate: first?.sessionDate ?? null,
    lastSessionDate: last?.sessionDate ?? null,
    temporalCapability: deriveTemporalCapability(closure),
    sessionCount: fullRows.length,
    f1RowCount: closure.f1Rows.rows.length,
    f2FullRowCount: fullRows.length,
    instrumentRowCount: closure.instrumentRows.rows.length,
    instrumentCount: f2.instrumentCount,
    completeSessionCount: f2.completeMacroSessionCount,
    partialSessionCount: f2.partialMacroSessionCount,
    unavailableSessionCount: f2.unavailableMacroSessionCount,
    staleResolutionCount: f1.staleSeriesResolutionCount
      + f2.cpiStaleSessionCount + f2.unrateStaleSessionCount + f2.claimsStaleSessionCount,
    withdrawnResolutionCount: f1.withdrawnSeriesResolutionCount
      + f2.cpiWithdrawnSessionCount + f2.unrateWithdrawnSessionCount
      + f2.claimsWithdrawnSessionCount,
    futureRejectedCount: f1.futureObservationRejectedCount
      + f1.futureVintageRejectedCount + f1.futureCalendarUpdateRejectedCount
      + f2.futureObservationRejectedCount + f2.futureRevisionRejectedCount
      + f2.futureCalendarUpdateRejectedCount,
    familyCoverage,
    projectionStatusCounts: { ...f2.projectionStatusCounts },
    emptyPublication: fullRows.length === 0,
    orderedSessionDigest: canonicalDigest(fullRows.map((row) => row.sessionId)),
    orderedRowDigest: canonicalDigest([
      f1.orderedRowIdentityDigest,
      f2.orderedFullStateRowDigest,
    ]),
    orderedInstrumentRowDigest: f2.orderedInstrumentRowDigest,
    orderedProvenanceDigest: canonicalDigest([
      f1.orderedFeatureProvenanceDigest,
      f2.orderedFullProvenanceDigest,
    ]),
    orderedPublicationEntryDigest: registry.orderedEntryDigest,
  });
}

export function buildMarketMacroFeatureCoverageReport(input) {
  const api = assertApiInput(input, ['registryManifestId', 'authorityPins']);
  assertStore(api.store, STORE_METHODS);
  const registry = verifyMarketMacroFeatureRegistryManifest({
    store: api.store,
    registryManifestId: api.registryManifestId,
  }).registryManifest;
  const closure = verifyPinClosure(api.store, api.authorityPins);
  const expectedEntries = MARKET_MACRO_FAMILY_CODES.map((familyCode) =>
    familyReference(familyCode, closure,
      registry.entries.map((entry) => ({
        phaseCode: entry.phaseCode,
        implementationManifestId: entry.implementationManifestId,
      })).filter((value, index, array) =>
        array.findIndex((other) => other.phaseCode === value.phaseCode) === index)));
  for (let index = 0; index < registry.entries.length; index += 1) {
    const observed = registry.entries[index];
    const expected = expectedEntries[index];
    for (const field of ['phaseCode', 'featureVersion', 'policyId', 'sourceBundleId',
      'rowsId', 'reportId', 'implementationManifestId']) {
      same(observed[field], expected[field],
        'MARKET_DATA_MACRO_PUBLICATION_PIN_MISMATCH',
        `registry ${observed.familyCode} ${field} mismatch`);
    }
  }
  const value = deriveCoverageValue(api.registryManifestId, registry, closure);
  const stored = putCanonicalL3(api.store,
    MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION, value);
  return { coverageReportId: stored.objectId, coverageReport: value };
}

export function verifyMarketMacroFeatureCoverageReport(input) {
  const api = assertApiInput(input, ['coverageReportId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.coverageReportId, 'coverageReportId');
  const observed = normalizeMarketMacroFeatureCoverageReportV1(read(api.store,
    api.coverageReportId, MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION,
    'market macro coverage report'));
  const registry = verifyMarketMacroFeatureRegistryManifest({
    store: api.store,
    registryManifestId: observed.registryManifestId,
  }).registryManifest;
  const closure = verifyPinClosure(api.store, observed.authorityPins);
  const expected = deriveCoverageValue(observed.registryManifestId, registry, closure);
  if (!canonicalValuesEqual(observed, expected)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_COVERAGE_MISMATCH',
      'coverage report diverges from recomputed I1/I2/F1/F2 closure');
  }
  return {
    coverageReportId: api.coverageReportId,
    coverageReport: observed,
    closure,
  };
}

function derivedPublicationStatus(coverage) {
  if (coverage.emptyPublication) return 'EMPTY';
  if (coverage.partialSessionCount > 0 || coverage.unavailableSessionCount > 0
      || coverage.familyCoverage.some((item) => item.coverageStatus !== 'COMPLETE')) {
    return 'PARTIAL';
  }
  return 'PUBLISHED';
}

function derivePublicationValue(input) {
  const {
    authorityPolicyId,
    registryManifestId,
    coverageReportId,
    registry,
    coverage,
    implementationIdentities,
    availableAt,
    publicationStatus,
    supersedesPublicationManifestId,
    withdrawalReason,
  } = input;
  return normalizeMarketMacroFeaturePublicationManifestV1({
    schemaVersion: MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    authorityPolicyId,
    registryManifestId,
    coverageReportId,
    authorityPins: coverage.authorityPins,
    implementationIdentities,
    publicationVersion: MARKET_MACRO_PUBLICATION_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    availableAt,
    firstSessionId: coverage.firstSessionId,
    lastSessionId: coverage.lastSessionId,
    firstSessionDate: coverage.firstSessionDate,
    lastSessionDate: coverage.lastSessionDate,
    temporalCapability: coverage.temporalCapability,
    publicationStatus,
    supersedesPublicationManifestId,
    withdrawalReason,
    publishedEntries: registry.entries.map((entry) => ({
      familyCode: entry.familyCode,
      entryIdentityDigest: entry.entryIdentityDigest,
    })),
    orderedPublicationEntryDigest: registry.orderedEntryDigest,
  });
}

export function buildMarketMacroFeaturePublicationManifest(input) {
  const api = assertApiInput(input, [
    'authorityPolicyId',
    'registryManifestId',
    'coverageReportId',
    'implementationIdentities',
    'availableAt',
    'publicationStatus',
    'supersedesPublicationManifestId',
    'withdrawalReason',
  ]);
  assertStore(api.store, STORE_METHODS);
  verifyMarketMacroFeatureAuthorityPolicy({
    store: api.store,
    authorityPolicyId: api.authorityPolicyId,
  });
  assertUtcInstant(api.availableAt, 'availableAt');
  const identities = verifyImplementationIdentities(api.store, api.implementationIdentities);
  const registry = verifyMarketMacroFeatureRegistryManifest({
    store: api.store,
    registryManifestId: api.registryManifestId,
  }).registryManifest;
  const coverage = verifyMarketMacroFeatureCoverageReport({
    store: api.store,
    coverageReportId: api.coverageReportId,
  }).coverageReport;
  same(registry.authorityPolicyId, api.authorityPolicyId,
    'MARKET_DATA_MACRO_PUBLICATION_PIN_MISMATCH',
    'registry authority policy mismatch');
  same(coverage.registryManifestId, api.registryManifestId,
    'MARKET_DATA_MACRO_PUBLICATION_PIN_MISMATCH',
    'coverage registry mismatch');
  same(registry.availableAt, api.availableAt,
    'MARKET_DATA_MACRO_PUBLICATION_CAUSALITY_VIOLATION',
    'publication availableAt must equal registry availableAt');
  const historyStatus = api.publicationStatus === 'WITHDRAWN'
    || api.publicationStatus === 'DEPRECATED';
  if (!historyStatus && api.publicationStatus !== derivedPublicationStatus(coverage)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_STATUS_MISMATCH',
      'publication status diverges from recomputed coverage');
  }
  if (historyStatus && api.supersedesPublicationManifestId === null) {
    fail('MARKET_DATA_MACRO_PUBLICATION_STATUS_MISMATCH',
      'withdrawal/deprecation requires an explicit parent publication');
  }
  if (api.supersedesPublicationManifestId !== null) {
    const parent = verifyMarketMacroFeaturePublicationManifest({
      store: api.store,
      publicationManifestId: api.supersedesPublicationManifestId,
    }).publicationManifest;
    if (api.availableAt < parent.availableAt) {
      fail('MARKET_DATA_MACRO_PUBLICATION_CAUSALITY_VIOLATION',
        'publication child availableAt precedes parent');
    }
    same(registry.supersedesRegistryManifestId, parent.registryManifestId,
      'MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
      'publication child registry must supersede parent registry');
  } else if (registry.supersedesRegistryManifestId !== null) {
    fail('MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
      'genesis publication cannot reference a child registry');
  }
  const value = derivePublicationValue({
    authorityPolicyId: api.authorityPolicyId,
    registryManifestId: api.registryManifestId,
    coverageReportId: api.coverageReportId,
    registry,
    coverage,
    implementationIdentities: identities,
    availableAt: api.availableAt,
    publicationStatus: api.publicationStatus,
    supersedesPublicationManifestId: api.supersedesPublicationManifestId,
    withdrawalReason: api.withdrawalReason,
  });
  const stored = putCanonicalL3(api.store,
    MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION, value);
  return { publicationManifestId: stored.objectId, publicationManifest: value };
}

function verifyPublicationRecursive(store, publicationManifestId, seen = new Set()) {
  if (seen.has(publicationManifestId)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_CYCLE',
      'publication supersession chain contains a cycle');
  }
  seen.add(publicationManifestId);
  const observed = normalizeMarketMacroFeaturePublicationManifestV1(read(store,
    publicationManifestId, MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    'market macro publication manifest'));
  verifyMarketMacroFeatureAuthorityPolicy({
    store,
    authorityPolicyId: observed.authorityPolicyId,
  });
  const identities = verifyImplementationIdentities(store, observed.implementationIdentities);
  const registry = verifyMarketMacroFeatureRegistryManifest({
    store,
    registryManifestId: observed.registryManifestId,
  }).registryManifest;
  const coverage = verifyMarketMacroFeatureCoverageReport({
    store,
    coverageReportId: observed.coverageReportId,
  }).coverageReport;
  let parent = null;
  if (observed.supersedesPublicationManifestId !== null) {
    parent = verifyPublicationRecursive(store, observed.supersedesPublicationManifestId, seen);
    if (observed.availableAt < parent.availableAt) {
      fail('MARKET_DATA_MACRO_PUBLICATION_CAUSALITY_VIOLATION',
        'publication child availableAt precedes parent');
    }
    same(registry.supersedesRegistryManifestId, parent.registryManifestId,
      'MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
      'publication child registry does not supersede parent registry');
  }
  const historyStatus = observed.publicationStatus === 'WITHDRAWN'
    || observed.publicationStatus === 'DEPRECATED';
  if (!historyStatus && observed.publicationStatus !== derivedPublicationStatus(coverage)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_STATUS_MISMATCH',
      'stored publication status diverges from recomputed coverage');
  }
  if (historyStatus && parent === null) {
    fail('MARKET_DATA_MACRO_PUBLICATION_STATUS_MISMATCH',
      'history status requires a parent publication');
  }
  const expected = derivePublicationValue({
    authorityPolicyId: observed.authorityPolicyId,
    registryManifestId: observed.registryManifestId,
    coverageReportId: observed.coverageReportId,
    registry,
    coverage,
    implementationIdentities: identities,
    availableAt: observed.availableAt,
    publicationStatus: observed.publicationStatus,
    supersedesPublicationManifestId: observed.supersedesPublicationManifestId,
    withdrawalReason: observed.withdrawalReason,
  });
  if (!canonicalValuesEqual(observed, expected)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_MANIFEST_MISMATCH',
      'publication manifest diverges from recomputed registry/coverage closure');
  }
  return observed;
}

export function verifyMarketMacroFeaturePublicationManifest(input) {
  const api = assertApiInput(input, ['publicationManifestId']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.publicationManifestId, 'publicationManifestId');
  const publicationManifest = verifyPublicationRecursive(
    api.store, api.publicationManifestId);
  return { publicationManifestId: api.publicationManifestId, publicationManifest };
}

export function resolveMarketMacroFeaturePublicationAsOf(input) {
  const api = assertApiInput(input, ['publicationManifestId', 'asOfKnowledgeCutoff']);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.publicationManifestId, 'publicationManifestId');
  assertUtcInstant(api.asOfKnowledgeCutoff, 'asOfKnowledgeCutoff');
  const visited = new Set();
  let currentId = api.publicationManifestId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      fail('MARKET_DATA_MACRO_PUBLICATION_CYCLE',
        'resolver encountered a publication cycle');
    }
    visited.add(currentId);
    const current = normalizeMarketMacroFeaturePublicationManifestV1(read(api.store,
      currentId, MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
      'market macro publication manifest'));
    if (current.availableAt <= api.asOfKnowledgeCutoff) {
      const verified = verifyMarketMacroFeaturePublicationManifest({
        store: api.store,
        publicationManifestId: currentId,
      }).publicationManifest;
      const resolutionStatus = current.publicationStatus === 'WITHDRAWN'
        ? 'WITHDRAWN'
        : current.publicationStatus === 'DEPRECATED'
          ? 'DEPRECATED'
          : 'RESOLVED';
      return {
        resolutionStatus,
        asOfKnowledgeCutoff: api.asOfKnowledgeCutoff,
        publicationManifestId: currentId,
        publicationManifest: verified,
      };
    }
    currentId = current.supersedesPublicationManifestId;
  }
  return {
    resolutionStatus: 'NOT_AVAILABLE',
    asOfKnowledgeCutoff: api.asOfKnowledgeCutoff,
    publicationManifestId: null,
    publicationManifest: null,
  };
}

export function publishOfficialMarketMacroFeaturesL4BPV1(input) {
  const api = assertApiInput(input, [
    'authorityPins',
    'availableAt',
    'publicationStatus',
    'withdrawalReason',
    'baseRegistryManifestId',
    'supersedesPublicationManifestId',
  ]);
  assertStore(api.store, STORE_METHODS);
  const authority = buildMarketMacroFeatureAuthorityPolicy({ store: api.store });
  const implementationIdentities = MARKET_MACRO_IMPLEMENTATION_PHASES.map((phaseCode) => {
    const built = computeMarketMacroPublicationImplementationIdentity({
      store: api.store,
      phaseCode,
    });
    return {
      phaseCode,
      implementationManifestId: built.implementationManifestId,
    };
  });
  assertUtcInstant(api.availableAt, 'availableAt');
  const closure = verifyPinClosure(api.store, api.authorityPins);
  let parentRegistry = null;
  if (api.baseRegistryManifestId !== null) {
    parentRegistry = verifyMarketMacroFeatureRegistryManifest({
      store: api.store,
      registryManifestId: api.baseRegistryManifestId,
    }).registryManifest;
  }
  const registryValue = deriveRegistryValue({
    authorityPolicyId: authority.authorityPolicyId,
    closure,
    implementationIdentities,
    availableAt: api.availableAt,
    publicationStatus: api.publicationStatus,
    withdrawalReason: api.withdrawalReason,
    parent: parentRegistry,
    parentId: api.baseRegistryManifestId,
  });
  const registryStored = putCanonicalL3(api.store,
    MARKET_MACRO_FEATURE_REGISTRY_MANIFEST_SCHEMA_VERSION, registryValue);
  const registry = {
    registryManifestId: registryStored.objectId,
    registryManifest: registryValue,
  };
  const coverageValue = deriveCoverageValue(
    registry.registryManifestId, registryValue, closure);
  const coverageStored = putCanonicalL3(api.store,
    MARKET_MACRO_FEATURE_COVERAGE_REPORT_SCHEMA_VERSION, coverageValue);
  const coverage = {
    coverageReportId: coverageStored.objectId,
    coverageReport: coverageValue,
  };
  const historyStatus = api.publicationStatus === 'WITHDRAWN'
    || api.publicationStatus === 'DEPRECATED';
  if (!historyStatus && api.publicationStatus !== derivedPublicationStatus(coverageValue)) {
    fail('MARKET_DATA_MACRO_PUBLICATION_STATUS_MISMATCH',
      'publication status diverges from recomputed coverage');
  }
  let parentPublication = null;
  if (api.supersedesPublicationManifestId !== null) {
    parentPublication = verifyMarketMacroFeaturePublicationManifest({
      store: api.store,
      publicationManifestId: api.supersedesPublicationManifestId,
    }).publicationManifest;
    same(api.baseRegistryManifestId, parentPublication.registryManifestId,
      'MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
      'publication child must supersede the registry of its parent publication');
  } else if (api.baseRegistryManifestId !== null) {
    fail('MARKET_DATA_MACRO_PUBLICATION_REGISTRY_CONFLICT',
      'registry supersession requires publication supersession');
  }
  if (historyStatus && parentPublication === null) {
    fail('MARKET_DATA_MACRO_PUBLICATION_STATUS_MISMATCH',
      'withdrawal/deprecation requires a parent publication');
  }
  const publicationValue = derivePublicationValue({
    authorityPolicyId: authority.authorityPolicyId,
    registryManifestId: registry.registryManifestId,
    coverageReportId: coverage.coverageReportId,
    registry: registryValue,
    coverage: coverageValue,
    implementationIdentities,
    availableAt: api.availableAt,
    publicationStatus: api.publicationStatus,
    supersedesPublicationManifestId: api.supersedesPublicationManifestId,
    withdrawalReason: api.withdrawalReason,
  });
  const publicationStored = putCanonicalL3(api.store,
    MARKET_MACRO_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION, publicationValue);
  const publication = {
    publicationManifestId: publicationStored.objectId,
    publicationManifest: publicationValue,
  };
  return {
    ...authority,
    ...registry,
    ...coverage,
    ...publication,
    implementationIdentities,
  };
}
