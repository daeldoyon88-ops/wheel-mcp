/**
 * GATE21 lab-import adapter.
 *
 * REUSE → WRAP → CONTRACTUALIZE → VERSION.
 * Imports directional-lab primitives. Does not fork or rewrite them.
 * Default: 0 directional-lab source bytes modified.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from '../../../tools/canonical-json.mjs';

import {
  DAILY_BAR_SCHEMA_VERSION,
  ADJUSTMENT_TYPES,
  isStrictUtcIsoInstant,
  dailyBarProblems,
  priceBlockProblems,
} from '../../../../research/directional-lab/src/contracts/dailyBarV1.mjs';
import {
  MISSING_REASON_SCHEMA_VERSION,
  MISSING_REASONS,
  MISSING_REASON_PRECEDENCE,
  isCanonicalMissingReason,
  pickMissingReason,
  reasonForTrailingWindow,
} from '../../../../research/directional-lab/src/contracts/missingReasonsV1.mjs';
import {
  CORPORATE_ACTION_SCHEMA_VERSION,
  CORPORATE_ACTION_TYPES,
  corporateActionProblems,
} from '../../../../research/directional-lab/src/contracts/corporateActionV1.mjs';
import {
  CORPORATE_ACTION_POLICY_VERSION,
  CORPORATE_ACTION_POLICY,
  ERROR_CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED,
  ERROR_CORPORATE_ACTION_ORDER_AMBIGUOUS,
  ERROR_FRACTIONAL_SPLIT_RESULT_UNSUPPORTED,
  corporateActionPolicyFor,
} from '../../../../research/directional-lab/src/data/corporateActionPolicy.mjs';
import {
  isValidCivilDate,
  assertCivilDate,
  compareCivilDate,
  addDays,
} from '../../../../research/directional-lab/src/time/civilDate.mjs';
import {
  isUsDst,
  sessionCloseUtc,
  sessionOpenUtc,
  isWeekday,
} from '../../../../research/directional-lab/src/time/marketSession.mjs';
import {
  MARKET_CALENDAR_L3_SCHEMA_VERSIONS,
  MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
  MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
} from '../../../../research/directional-lab/src/contracts/marketCalendarL3V1.mjs';
import {
  MARKET_DATA_SOURCE_L3_SCHEMA_VERSIONS,
  MARKET_DATA_PRICE_BASES,
  MARKET_DATA_KNOWLEDGE_MODES,
  MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
} from '../../../../research/directional-lab/src/contracts/marketDataSourceL3V1.mjs';
import {
  MARKET_DATA_INGESTION_REGISTRY_L3_SCHEMA_VERSIONS,
  MARKET_DATA_INGESTION_PRICE_BASES,
  MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
} from '../../../../research/directional-lab/src/contracts/marketDataIngestionRegistryL3V1.mjs';
import {
  MARKET_DATA_BAR_REVISION_L3_SCHEMA_VERSIONS,
  MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
} from '../../../../research/directional-lab/src/contracts/marketDataBarRevisionL3V1.mjs';
import {
  DATASET_MANIFEST_SCHEMA_VERSION,
  COVERAGE_VERSION,
  datasetManifestProblems,
} from '../../../../research/directional-lab/src/contracts/datasetManifestV1.mjs';
import {
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  snapshotDatasetManifestProblems,
  validateSnapshotDatasetManifest,
} from '../../../../research/directional-lab/src/contracts/snapshotDatasetManifestV1.mjs';
import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
} from '../../../../research/directional-lab/src/contracts/datasetSnapshotV1.mjs';
import { normalizeDailyBars, NORMALIZE_DAILY_BARS_VERSION } from '../../../../research/directional-lab/src/data/normalizeDailyBars.mjs';
import { validateDailyBars } from '../../../../research/directional-lab/src/data/validateDailyBars.mjs';
import { selectPriceBasis } from '../../../../research/directional-lab/src/data/selectPriceBasis.mjs';
import { validateDatasetManifest } from '../../../../research/directional-lab/src/data/validateDatasetManifest.mjs';
import { buildDatasetManifest } from '../../../../research/directional-lab/src/data/buildDatasetManifest.mjs';
import {
  SNAPSHOT_DATASET_MANIFEST_BUILDER_VERSION,
  buildSnapshotDatasetManifest,
} from '../../../../research/directional-lab/src/data/buildSnapshotDatasetManifest.mjs';
import { JSON_ADAPTER_VERSION } from '../../../../research/directional-lab/src/data/jsonDailyAdapter.mjs';
import { resolveMacroVintageAsOf } from '../../../../research/directional-lab/src/macro/resolveMacroVintageAsOfL4BV1.mjs';
import {
  MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
} from '../../../../research/directional-lab/src/contracts/macroIngestionContractsL4BV1.mjs';
import {
  MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
} from '../../../../research/directional-lab/src/contracts/macroIngestionContractsL4BV1.mjs';

export const LAB_IMPORT_ADAPTER_VERSION = 'GATE21_LabImportAdapter/1';

/** Exact mandate reuse set. Paths are repo-relative. Read/import only. */
export const DIRECTIONAL_LAB_ASSETS = Object.freeze([
  { path: 'research/directional-lab/DATA_CONTRACT.md', role: 'DATA_CONTRACT', behavior: 'DailyBarV1 raw/adjusted/missingness contract text' },
  { path: 'research/directional-lab/TEMPORAL_RULES.md', role: 'TEMPORAL_RULES', behavior: 'anti-lookahead and intra-session corporate-action order' },
  { path: 'research/directional-lab/src/contracts/dailyBarV1.mjs', role: 'DailyBarV1', behavior: 'eventTime/availableAt, raw vs adjusted blocks, availableAt>=eventTime' },
  { path: 'research/directional-lab/src/contracts/missingReasonsV1.mjs', role: 'missingReasonsV1', behavior: 'null stays null; VOLUME_MISSING; unknown reasons refused' },
  { path: 'research/directional-lab/src/contracts/corporateActionV1.mjs', role: 'corporateActionV1', behavior: 'SPLIT and CASH_DIVIDEND events separate from prices' },
  { path: 'research/directional-lab/src/data/corporateActionPolicy.mjs', role: 'corporateActionPolicy', behavior: 'per-basis split/dividend engine policy; RAW same-session fail-closed' },
  { path: 'research/directional-lab/src/time/civilDate.mjs', role: 'civilDate', behavior: 'UTC civil YYYY-MM-DD, no local Date conversion' },
  { path: 'research/directional-lab/src/time/marketSession.mjs', role: 'marketSession', behavior: 'America/New_York session open/close UTC without local TZ' },
  { path: 'research/directional-lab/src/contracts/marketCalendarL3V1.mjs', role: 'marketCalendarL3V1', behavior: 'venue/session calendar schema versions' },
  { path: 'research/directional-lab/src/contracts/marketDataSourceL3V1.mjs', role: 'marketDataSourceL3V1', behavior: 'provider-neutral source/ingestion identities' },
  { path: 'research/directional-lab/src/contracts/marketDataIngestionRegistryL3V1.mjs', role: 'marketDataIngestionRegistryL3V1', behavior: 'ingestion registry and fallback chain identities' },
  { path: 'research/directional-lab/src/contracts/marketDataBarRevisionL3V1.mjs', role: 'marketDataBarRevisionL3V1', behavior: 'bar observation/correction revision identities' },
  { path: 'research/directional-lab/src/contracts/datasetManifestV1.mjs', role: 'DatasetManifestV1', behavior: 'source hash, coverage, available vs complete' },
  { path: 'research/directional-lab/src/contracts/snapshotDatasetManifestV1.mjs', role: 'SnapshotDatasetManifestV1', behavior: 'immutable snapshot envelope' },
  { path: 'research/directional-lab/src/contracts/datasetSnapshotV1.mjs', role: 'DatasetSnapshotV1', behavior: 'snapshot core/record identity' },
  { path: 'research/directional-lab/src/data/buildDatasetManifest.mjs', role: 'buildDatasetManifest', behavior: 'read-only manifest from source bytes + bars' },
  { path: 'research/directional-lab/src/data/validateDatasetManifest.mjs', role: 'validateDatasetManifest', behavior: 'recompute source hash; mismatch is a problem' },
  { path: 'research/directional-lab/src/data/buildSnapshotDatasetManifest.mjs', role: 'buildSnapshotDatasetManifest', behavior: 'snapshot manifest builder' },
  { path: 'research/directional-lab/src/data/normalizeDailyBars.mjs', role: 'normalizeDailyBars', behavior: 'provider rows → DailyBarV1; missing volume is null not 0' },
  { path: 'research/directional-lab/src/data/validateDailyBars.mjs', role: 'validateDailyBars', behavior: 'series-level DailyBarV1 validation, never silent fix' },
  { path: 'research/directional-lab/src/data/selectPriceBasis.mjs', role: 'selectPriceBasis', behavior: 'RAW/SPLIT_ADJUSTED/TOTAL_RETURN/DERIVED; no implicit mix' },
  { path: 'research/directional-lab/src/data/jsonDailyAdapter.mjs', role: 'jsonDailyAdapter', behavior: 'FREE local JSON loader; does not fabricate raw' },
  { path: 'research/directional-lab/src/macro/macroVintageSetL4BV1.mjs', role: 'macroVintageSetL4BV1', behavior: 'pinned vintage set, no latest-wins' },
  { path: 'research/directional-lab/src/macro/resolveMacroVintageAsOfL4BV1.mjs', role: 'resolveMacroVintageAsOfL4BV1', behavior: 'availableAt <= knowledgeCutoff; later revision invisible' },
  { path: 'research/directional-lab/src/macro/macroObservationVintageL4BV1.mjs', role: 'macroObservationVintageL4BV1', behavior: 'observation vintage content with pinned availableAt' },
  { path: 'research/directional-lab/src/macro/macroDatasetSnapshotL4BV1.mjs', role: 'macroDatasetSnapshotL4BV1', behavior: 'pinned macro dataset snapshot identity' },
  { path: 'research/directional-lab/src/contracts/macroIngestionContractsL4BV1.mjs', role: 'macroIngestionContractsL4BV1', behavior: 'L4B schema versions; no wall clock' },
  { path: 'research/directional-lab/docs/L4B-I1-macro-ingestion-identities-vintages.md', role: 'L4B-I1-docs', behavior: 'macro identity/vintage documentation' },
]);

export const LAB_SCHEMA_PINS = Object.freeze({
  DailyBarV1: DAILY_BAR_SCHEMA_VERSION,
  MissingReasonsV1: MISSING_REASON_SCHEMA_VERSION,
  CorporateActionV1: CORPORATE_ACTION_SCHEMA_VERSION,
  corporateActionPolicy: CORPORATE_ACTION_POLICY_VERSION,
  DatasetManifestV1: DATASET_MANIFEST_SCHEMA_VERSION,
  coverage: COVERAGE_VERSION,
  SnapshotDatasetManifestV1: SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  DatasetSnapshotCore: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DatasetSnapshotRecord: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  normalizeDailyBars: NORMALIZE_DAILY_BARS_VERSION,
  jsonDailyAdapter: JSON_ADAPTER_VERSION,
  marketCalendarL3: MARKET_CALENDAR_L3_SCHEMA_VERSIONS,
  marketDataSourceL3: MARKET_DATA_SOURCE_L3_SCHEMA_VERSIONS,
  marketDataIngestionRegistryL3: MARKET_DATA_INGESTION_REGISTRY_L3_SCHEMA_VERSIONS,
  marketDataBarRevisionL3: MARKET_DATA_BAR_REVISION_L3_SCHEMA_VERSIONS,
  MacroVintageSetManifest: MACRO_VINTAGE_SET_MANIFEST_SCHEMA_VERSION,
  MacroDatasetSnapshotManifest: MACRO_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  adjustmentTypes: ADJUSTMENT_TYPES,
  marketDataPriceBases: MARKET_DATA_PRICE_BASES,
  knowledgeModes: MARKET_DATA_KNOWLEDGE_MODES,
  ingestionPolicy: MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
  marketCalendarAuthority: MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
  marketSessionCalendar: MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
  marketCalendarRegistry: MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  barObservation: MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
  ingestionPriceBases: MARKET_DATA_INGESTION_PRICE_BASES,
  corporateActionTreatments: MARKET_DATA_CORPORATE_ACTION_TREATMENTS,
});

export {
  DAILY_BAR_SCHEMA_VERSION,
  ADJUSTMENT_TYPES,
  isStrictUtcIsoInstant,
  dailyBarProblems,
  priceBlockProblems,
  MISSING_REASON_SCHEMA_VERSION,
  MISSING_REASONS,
  MISSING_REASON_PRECEDENCE,
  isCanonicalMissingReason,
  pickMissingReason,
  reasonForTrailingWindow,
  CORPORATE_ACTION_SCHEMA_VERSION,
  CORPORATE_ACTION_TYPES,
  corporateActionProblems,
  CORPORATE_ACTION_POLICY_VERSION,
  CORPORATE_ACTION_POLICY,
  ERROR_CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED,
  ERROR_CORPORATE_ACTION_ORDER_AMBIGUOUS,
  ERROR_FRACTIONAL_SPLIT_RESULT_UNSUPPORTED,
  corporateActionPolicyFor,
  isValidCivilDate,
  assertCivilDate,
  compareCivilDate,
  addDays,
  isUsDst,
  sessionCloseUtc,
  sessionOpenUtc,
  isWeekday,
  normalizeDailyBars,
  validateDailyBars,
  selectPriceBasis,
  validateDatasetManifest,
  buildDatasetManifest,
  datasetManifestProblems,
  snapshotDatasetManifestProblems,
  validateSnapshotDatasetManifest,
  buildSnapshotDatasetManifest,
  SNAPSHOT_DATASET_MANIFEST_BUILDER_VERSION,
  resolveMacroVintageAsOf,
};

export function pinLabAsset(repoRoot, relativePath) {
  const abs = path.resolve(repoRoot, relativePath);
  const bytes = fs.readFileSync(abs);
  return {
    path: relativePath.replaceAll('\\', '/'),
    sha256: sha256Bytes(bytes),
    byteLength: bytes.length,
    mutated: false,
  };
}

export function pinAllLabAssets(repoRoot) {
  return DIRECTIONAL_LAB_ASSETS.map((asset) => ({
    ...asset,
    ...pinLabAsset(repoRoot, asset.path),
  }));
}

export function refuseDirectionalLabMutation(requestedPath) {
  const normalized = String(requestedPath ?? '').replaceAll('\\', '/');
  if (normalized.startsWith('research/directional-lab/') || normalized.includes('/research/directional-lab/')) {
    return {
      status: 'BLOCKED',
      code: 'DIRECTIONAL_LAB_MUTATION_FORBIDDEN',
      path: normalized,
    };
  }
  return { status: 'ALLOWED', code: null, path: normalized };
}
