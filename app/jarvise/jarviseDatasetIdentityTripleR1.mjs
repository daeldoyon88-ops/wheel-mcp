import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256Canonical } from '../../governance/tools/canonical-json.mjs';
import { F1_DEFINITION, F1_FEATURE_DEFINITION_ID, F1_FORMULA_ID } from '../../governance/gates/GATE23/implementation/feature-families-v1.mjs';
import { createFeatureWindowSpec } from '../../governance/gates/GATE23/implementation/feature-window-v1.mjs';

export const SOURCE_BASIS_DECLARATION_PATH_R1 = 'app/jarvise/yahooSourceBasisDeclarationR1.json';
export const SOURCE_BASIS_DECLARATION_SHA256_R1 = 'fb9e5a17f4ef5503c58e2f2beac49fe3c3f035f3525b06fe282a13a60540364b';
export const JARVISE_SOURCE_BINDING_SCHEMA_R1 = 'R2SourceBinding/1';
export const JARVISE_OBSERVATION_DATASET_SCHEMA_R1 = 'R2ObservationDataset/1';
export const JARVISE_FEATURE_DATASET_SCHEMA_R1 = 'R2FeatureDataset/1';
export const G23_FEATURE_MATERIALIZER_VERSION_R1 = 'GATE23_FeatureMaterializer/1';
export const JARVISE_SOURCE_ID_R1 = 'YAHOO_CHART_EOD';
export const JARVISE_HISTORICAL_PLANE_R1 = 'HISTORICAL';
export const JARVISE_PRICE_BASIS_ID_R1 = 'SPLIT_ADJUSTED';

const BAR_FIELDS = Object.freeze(['sessionDate', 'eventTime', 'availableAt', 'open', 'high', 'low', 'close', 'volume']);
const FEATURE_SESSION_COUNTS = Object.freeze([5, 21]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const STRICT_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class JarviseDatasetIdentityError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'JarviseDatasetIdentityError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details = null) {
  throw new JarviseDatasetIdentityError(code, details);
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function isStrictUtcIso(value) {
  return typeof value === 'string' && STRICT_UTC_ISO.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function requiredString(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function requiredHash(value, code) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) fail(code);
  return value;
}

function readActualSourceBasisDeclarationBytes() {
  return readFileSync(new URL('./yahooSourceBasisDeclarationR1.json', import.meta.url));
}

function sourceBindingPreimage() {
  return {
    schemaVersion: JARVISE_SOURCE_BINDING_SCHEMA_R1,
    sourceId: JARVISE_SOURCE_ID_R1,
    plane: JARVISE_HISTORICAL_PLANE_R1,
    sourceBasisDeclarationPath: SOURCE_BASIS_DECLARATION_PATH_R1,
    sourceBasisDeclarationSha256: SOURCE_BASIS_DECLARATION_SHA256_R1,
  };
}

function assertSourceBindingId(value) {
  return requiredHash(value, 'SOURCE_BINDING_ID_INVALID');
}

function normalizeBar(bar, index) {
  if (!bar || typeof bar !== 'object' || Array.isArray(bar)) fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { index, reason: 'BAR_INVALID' });
  if (Object.keys(bar).some((key) => !BAR_FIELDS.includes(key)) || BAR_FIELDS.some((field) => !Object.hasOwn(bar, field))) {
    fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { index, reason: 'BAR_FIELDS_EXACT_ONLY' });
  }
  const normalized = {};
  for (const field of BAR_FIELDS) normalized[field] = bar[field];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.sessionDate)
    || !isStrictUtcIso(normalized.eventTime) || !isStrictUtcIso(normalized.availableAt)
    || Date.parse(normalized.eventTime) > Date.parse(normalized.availableAt)) {
    fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { index, reason: 'BAR_TIME_INVALID' });
  }
  for (const field of ['open', 'high', 'low', 'close']) {
    if (typeof normalized[field] !== 'number' || !Number.isFinite(normalized[field])) {
      fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { index, reason: `${field}_INVALID` });
    }
  }
  if (normalized.volume !== null && (typeof normalized.volume !== 'number' || !Number.isFinite(normalized.volume))) {
    fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { index, reason: 'volume_INVALID' });
  }
  return freeze(normalized);
}

function admittedBarsFromG21Bridge(g21BridgeOutput, effectiveKnowledgeCutoff) {
  if (!g21BridgeOutput || typeof g21BridgeOutput !== 'object'
    || g21BridgeOutput.status !== 'AVAILABLE'
    || g21BridgeOutput.sourceId !== JARVISE_SOURCE_ID_R1
    || g21BridgeOutput.historicalPlaneStatus !== JARVISE_HISTORICAL_PLANE_R1
    || g21BridgeOutput.priceBasis !== JARVISE_PRICE_BASIS_ID_R1
    || g21BridgeOutput.effectiveKnowledgeCutoff !== effectiveKnowledgeCutoff
    || !Array.isArray(g21BridgeOutput.records)) {
    fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { reason: 'G21_BRIDGE_NOT_ADMITTED' });
  }
  return g21BridgeOutput.records.map((record, index) => normalizeBar({
    sessionDate: record?.sessionDate,
    eventTime: record?.eventTime,
    availableAt: record?.availableAt,
    open: record?.adjusted?.open,
    high: record?.adjusted?.high,
    low: record?.adjusted?.low,
    close: record?.adjusted?.close,
    volume: record?.adjusted?.volume,
  }, index));
}

function normalizeAdmittedBars(bars, effectiveKnowledgeCutoff) {
  if (!Array.isArray(bars) || bars.length === 0) fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { reason: 'ADMITTED_BARS_REQUIRED' });
  const normalized = bars.map(normalizeBar).sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
  const dates = normalized.map((bar) => bar.sessionDate);
  if (new Set(dates).size !== dates.length) fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { reason: 'SESSION_DATE_DUPLICATE' });
  const cutoffMs = Date.parse(effectiveKnowledgeCutoff);
  if (normalized.some((bar) => Date.parse(bar.eventTime) > cutoffMs || Date.parse(bar.availableAt) > cutoffMs)) {
    fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { reason: 'POST_K_OR_UNAVAILABLE_BAR' });
  }
  return freeze(normalized);
}

function featureDefinitionSet(calendarWindowBinding) {
  if (!calendarWindowBinding || typeof calendarWindowBinding !== 'object') fail('FEATURE_DEFINITION_SET_AUTHORITY_GAP');
  const entries = FEATURE_SESSION_COUNTS.map((sessionCount) => {
    const window = createFeatureWindowSpec({ sessionCount, calendarWindowBinding });
    return {
      featureDefinitionId: F1_DEFINITION.featureDefinitionId,
      formulaId: F1_DEFINITION.formulaId,
      featureWindowSpecId: window.featureWindowSpecId,
    };
  }).sort((left, right) => left.featureDefinitionId.localeCompare(right.featureDefinitionId)
    || left.featureWindowSpecId.localeCompare(right.featureWindowSpecId));
  if (F1_DEFINITION.featureDefinitionId !== F1_FEATURE_DEFINITION_ID || F1_DEFINITION.formulaId !== F1_FORMULA_ID || entries.length !== 2) {
    fail('FEATURE_DEFINITION_SET_AUTHORITY_GAP');
  }
  return freeze(entries);
}

function featureDatasetPreimage(datasetIdObservation, featureDefinitionSetValue, materializerModuleVersion) {
  return {
    schemaVersion: JARVISE_FEATURE_DATASET_SCHEMA_R1,
    datasetIdObservation,
    featureDefinitionSet: featureDefinitionSetValue,
    materializerModuleVersion,
  };
}

function featureRecordIdentity(record) {
  const identity = record?.identity;
  if (!identity || typeof identity !== 'object') fail('FEATURE_DATASET_PREIMAGE_CONTRADICTION', { reason: 'FEATURE_RECORD_IDENTITY_REQUIRED' });
  return identity;
}

/** Recomputes the source binding from actual declaration bytes; no caller-supplied ID is accepted. */
export function deriveJarviseSourceBindingIdR1({ sourceBasisDeclarationBytes = readActualSourceBasisDeclarationBytes() } = {}) {
  const bytes = Buffer.isBuffer(sourceBasisDeclarationBytes) || sourceBasisDeclarationBytes instanceof Uint8Array
    ? sourceBasisDeclarationBytes : fail('SOURCE_BINDING_DECLARATION_DRIFT');
  const actualDeclarationSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualDeclarationSha256 !== SOURCE_BASIS_DECLARATION_SHA256_R1) fail('SOURCE_BINDING_DECLARATION_DRIFT', { actualDeclarationSha256 });
  return freeze({
    sourceBindingId: sha256Canonical(sourceBindingPreimage()),
    sourceBindingPreimage: freeze(sourceBindingPreimage()),
    sourceBasisDeclarationPath: SOURCE_BASIS_DECLARATION_PATH_R1,
    sourceBasisDeclarationSha256: actualDeclarationSha256,
  });
}

/** Derives the observation identity only from a successful G21 bridge cohort. */
export function deriveJarviseObservationDatasetIdR1({ g21BridgeOutput, instrumentIdentityId, priceBasisId = JARVISE_PRICE_BASIS_ID_R1 } = {}) {
  requiredString(instrumentIdentityId, 'INSTRUMENT_IDENTITY_REQUIRED');
  if (priceBasisId !== JARVISE_PRICE_BASIS_ID_R1) fail('PRICE_BASIS_ID_PRODUCTION_GAP');
  const effectiveKnowledgeCutoff = g21BridgeOutput?.effectiveKnowledgeCutoff;
  if (!isStrictUtcIso(effectiveKnowledgeCutoff)) fail('DATASET_OBSERVATION_PREIMAGE_CONTRADICTION', { reason: 'EFFECTIVE_K_INVALID' });
  const admittedBars = normalizeAdmittedBars(admittedBarsFromG21Bridge(g21BridgeOutput, effectiveKnowledgeCutoff), effectiveKnowledgeCutoff);
  const source = deriveJarviseSourceBindingIdR1();
  const preimage = {
    schemaVersion: JARVISE_OBSERVATION_DATASET_SCHEMA_R1,
    sourceBindingId: source.sourceBindingId,
    instrumentIdentityId,
    effectiveKnowledgeCutoff,
    plane: JARVISE_HISTORICAL_PLANE_R1,
    priceBasisId,
    admittedBars,
  };
  return freeze({ datasetIdObservation: sha256Canonical(preimage), observationDatasetPreimage: freeze(preimage), admittedBars });
}

/** Derives the exact F1/W5 plus F1/W21 feature cohort from G23 primitives. */
export function deriveJarviseFeatureDatasetIdR1({ datasetIdObservation, calendarWindowBinding, materializerModuleVersion = G23_FEATURE_MATERIALIZER_VERSION_R1 } = {}) {
  requiredHash(datasetIdObservation, 'DATASET_OBSERVATION_ID_INVALID');
  if (materializerModuleVersion !== G23_FEATURE_MATERIALIZER_VERSION_R1) fail('FEATURE_DATASET_PREIMAGE_CONTRADICTION', { reason: 'MATERIALIZER_VERSION_UNRATIFIED' });
  const entries = featureDefinitionSet(calendarWindowBinding);
  const preimage = featureDatasetPreimage(datasetIdObservation, entries, materializerModuleVersion);
  return freeze({ datasetIdFeature: sha256Canonical(preimage), featureDatasetPreimage: freeze(preimage), featureDefinitionSet: entries });
}

/** Composes the three runtime derivations without accepting caller-supplied identities. */
export function deriveJarviseDatasetIdentityTripleR1({ g21BridgeOutput, instrumentIdentityId, priceBasisId, calendarWindowBinding } = {}) {
  const source = deriveJarviseSourceBindingIdR1();
  const observation = deriveJarviseObservationDatasetIdR1({ g21BridgeOutput, instrumentIdentityId, priceBasisId });
  const feature = deriveJarviseFeatureDatasetIdR1({
    datasetIdObservation: observation.datasetIdObservation,
    calendarWindowBinding,
  });
  return freeze({ ...source, ...observation, ...feature });
}

/** Verifies a later G23 materialized cohort against independently recomputed R2 identities. */
export function verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation, datasetIdFeature, featureRecords, calendarWindowBinding } = {}) {
  requiredHash(datasetIdObservation, 'DATASET_OBSERVATION_ID_INVALID');
  requiredHash(datasetIdFeature, 'DATASET_FEATURE_ID_INVALID');
  if (datasetIdFeature === datasetIdObservation) fail('FEATURE_DATASET_FIXTURE_ALIAS_FORBIDDEN');
  if (!Array.isArray(featureRecords) || featureRecords.length === 0) fail('FEATURE_DATASET_PREIMAGE_CONTRADICTION', { reason: 'FEATURE_RECORDS_REQUIRED' });
  const expected = deriveJarviseFeatureDatasetIdR1({ datasetIdObservation, calendarWindowBinding });
  if (datasetIdFeature !== expected.datasetIdFeature) fail('FEATURE_DATASET_ID_MISMATCH');
  const source = deriveJarviseSourceBindingIdR1();
  const ids = new Set();
  const semanticMembers = new Set();
  const instruments = new Set();
  const cutoffs = new Set();
  const members = new Set();
  const allowed = new Set(expected.featureDefinitionSet.map((entry) => `${entry.featureDefinitionId}|${entry.formulaId}|${entry.featureWindowSpecId}`));
  for (const record of featureRecords) {
    const identity = featureRecordIdentity(record);
    requiredHash(record?.featureRecordId, 'FEATURE_DATASET_PREIMAGE_CONTRADICTION');
    if (ids.has(record.featureRecordId)) fail('FEATURE_DATASET_DUPLICATE_RECORD');
    ids.add(record.featureRecordId);
    if (identity.DatasetId_observation !== datasetIdObservation) fail('FEATURE_DATASET_OBSERVATION_LINEAGE_MISMATCH');
    if (identity.SourceBindingId !== source.sourceBindingId) fail('FEATURE_DATASET_SOURCE_BINDING_MISMATCH');
    requiredString(identity.InstrumentIdentityId, 'FEATURE_DATASET_PREIMAGE_CONTRADICTION');
    if (!isStrictUtcIso(identity.KnowledgeCutoff)) fail('FEATURE_DATASET_PREIMAGE_CONTRADICTION', { reason: 'FEATURE_K_INVALID' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(identity.SessionDate) || identity.SessionDate > identity.KnowledgeCutoff.slice(0, 10)) {
      fail('FEATURE_DATASET_FUTURE_FEATURE_FORBIDDEN');
    }
    if (Object.keys(identity).some((key) => /outcome|prediction/i.test(key)) || Object.keys(record ?? {}).some((key) => /outcome|prediction/i.test(key))) {
      fail('FEATURE_DATASET_OUTCOME_FORBIDDEN');
    }
    const member = `${identity.FeatureDefinitionId}|${identity.FormulaId}|${identity.FeatureWindowSpecId}`;
    if (!allowed.has(member)) fail('FEATURE_DATASET_FEATURE_COHORT_MISMATCH');
    const semantic = `${identity.InstrumentIdentityId}|${identity.SessionDate}|${identity.KnowledgeCutoff}|${member}|${identity.DatasetId_observation}`;
    if (semanticMembers.has(semantic)) fail('FEATURE_DATASET_DUPLICATE_RECORD');
    semanticMembers.add(semantic);
    instruments.add(identity.InstrumentIdentityId);
    cutoffs.add(identity.KnowledgeCutoff);
    members.add(member);
  }
  if (instruments.size !== 1) fail('FEATURE_DATASET_INSTRUMENT_MIXED');
  if (cutoffs.size !== 1) fail('FEATURE_DATASET_KNOWLEDGE_CUTOFF_MIXED');
  if (members.size !== expected.featureDefinitionSet.length || [...allowed].some((member) => !members.has(member))) {
    fail('FEATURE_DATASET_FEATURE_COHORT_MISMATCH');
  }
  return freeze({
    status: 'VERIFIED',
    datasetIdObservation,
    datasetIdFeature,
    featureDefinitionSet: expected.featureDefinitionSet,
    featureRecordCount: featureRecords.length,
    instrumentIdentityId: [...instruments][0],
    knowledgeCutoff: [...cutoffs][0],
  });
}
