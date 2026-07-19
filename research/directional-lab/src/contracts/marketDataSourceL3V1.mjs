/**
 * L3-I1 ingestion, source provenance, deterministic parsing and temporal
 * evidence. Only captured CAS bytes are parsed; no adapter performs I/O.
 */

import { TextDecoder } from 'node:util';
import { parseCanonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import { verifyInstrumentIdentityRegistry } from '../data/buildInstrumentIdentityRegistry.mjs';
import { verifyCorporateActionRegistry } from '../data/buildCorporateActionRegistry.mjs';
import { verifyMarketCalendarRegistry } from './marketCalendarL3V1.mjs';
import {
  MarketDataL3Error,
  asMarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertEnum,
  assertExactFields,
  assertNoStructuredSecret,
  assertNonEmptyString,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  assertStore,
  assertUtcInstant,
  canonicalDigest,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
  sha256Digest,
} from './marketDataL3CommonV1.mjs';

export const MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION = 'MarketDataIngestionPolicy/1';
export const MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION = 'MarketDataIngestionLineageCore/1';
export const MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION = 'MarketDataIngestionRegistryAuthorityPolicy/1';
export const MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION = 'MarketDataSourceArtifactCore/1';
export const MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION = 'MarketDataSourceAttestationCore/1';
export const MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION = 'MarketDataAcquisitionRecordCore/1';
export const MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION = 'MarketDataParseResultCore/1';
export const MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION = 'MarketDataSourceTemporalEvidenceCore/1';

export const MARKET_DATA_SOURCE_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION,
  MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION,
  MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION,
  MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION,
  MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
]);

export const MARKET_DATA_INSTRUMENT_KINDS = Object.freeze(['EQUITY', 'ETF', 'ETN']);
export const MARKET_DATA_FREQUENCIES = Object.freeze(['DAILY_REGULAR_SESSION']);
export const MARKET_DATA_PRICE_BASES = Object.freeze(['RAW', 'SPLIT_ADJUSTED']);
export const MARKET_DATA_SOURCE_DATASET_KINDS = Object.freeze(['EOD_OHLCV']);
export const MARKET_DATA_PAYLOAD_FORMATS = Object.freeze(['CANONICAL_JSON', 'CSV_UTF8']);
export const MARKET_DATA_KNOWLEDGE_MODES = Object.freeze([
  'CAPTURE_TIME_ONLY',
  'PROVIDER_PUBLICATION_TIME_ATTESTED',
  'PROVIDER_REVISION_HISTORY_ATTESTED',
]);
export const MARKET_DATA_ATTESTATION_MODES = Object.freeze(['DIGEST_ONLY', 'EMBEDDED_ARTIFACT']);
export const MARKET_DATA_TEMPORAL_EVIDENCE_KINDS = Object.freeze([
  'PROVIDER_PUBLICATION_TIMESTAMP', 'PROVIDER_REVISION_TIMESTAMP',
]);
export const MARKET_DATA_LOGICAL_ENDPOINT_KINDS = Object.freeze(['EOD_OHLCV_DATASET']);

export const MARKET_DATA_MEDIA_TYPE_BY_FORMAT = Object.freeze({
  CSV_UTF8: 'text/csv; charset=utf-8',
  CANONICAL_JSON: 'application/json',
});

const POLICY_FIELDS = Object.freeze([
  'schemaVersion', 'allowedInstrumentKinds', 'allowedFrequencies', 'allowedPriceBases',
  'allowedSourceDatasetKinds', 'allowedPayloadFormats', 'maxArtifactBytes', 'knowledgeModes',
  'providerPublicationTimeField', 'providerRevisionIdField', 'unknownFieldPolicy',
  'duplicateIdenticalRowPolicy', 'volumePolicy',
]);
const LINEAGE_FIELDS = Object.freeze([
  'schemaVersion', 'providerId', 'instrumentIdentityId', 'frequency', 'venueId',
  'priceBasis', 'sourceDatasetKind',
]);
const INGESTION_AUTHORITY_FIELDS = Object.freeze(['schemaVersion', 'registryNamespaceVersion', 'authorityScope']);
const ARTIFACT_FIELDS = Object.freeze([
  'schemaVersion', 'ingestionLineageId', 'payloadFormat', 'mediaType',
  'embeddedBytesObjectId', 'payloadDigest', 'payloadByteLength',
]);
const ATTESTATION_FIELDS = Object.freeze([
  'schemaVersion', 'ingestionLineageId', 'attestationMode', 'embeddedArtifactId',
  'payloadDigest', 'payloadByteLength', 'payloadFormat', 'providerId',
]);
const ACQUISITION_FIELDS = Object.freeze([
  'schemaVersion', 'ingestionLineageId', 'acquisitionTimeUtc', 'providerId',
  'logicalEndpointKind', 'requestDatasetKind', 'executionIdentity', 'sourceAttestationId',
]);
const EXECUTION_IDENTITY_FIELDS = Object.freeze(['runnerId', 'runId', 'environment']);
const PARSE_FIELDS = Object.freeze([
  'schemaVersion', 'sourceArtifactId', 'acquisitionRecordId', 'ingestionPolicyId',
  'headerFields', 'rowCount', 'rows', 'syntaxErrors',
]);
const PARSE_ROW_FIELDS = Object.freeze(['rowIndex', 'rowDigest', 'cells']);
const SYNTAX_ERROR_FIELDS = Object.freeze(['rowIndex', 'code', 'message']);
const TEMPORAL_FIELDS = Object.freeze([
  'schemaVersion', 'sourceArtifactId', 'acquisitionRecordId', 'parseResultId',
  'sourceRowIndex', 'sourceCellPath', 'sourceCellDigest', 'rawTimestampValue',
  'normalizedTimestampUtc', 'evidenceKind', 'providerRevisionId',
]);

/** @param {unknown} value @param {readonly string[]} allowed @param {string} label @param {string} [code] */
function canonicalEnumSet(value, allowed, label, code = 'MARKET_DATA_INPUT_INVALID') {
  if (!Array.isArray(value) || value.length === 0) throw new MarketDataL3Error(code, `${label} must be a non-empty array`);
  for (const item of value) assertEnum(item, allowed, label, code);
  if (new Set(value).size !== value.length) throw new MarketDataL3Error(code, `${label} must be unique`);
  return [...value].sort();
}

/** @param {unknown} value @param {string} label @param {boolean} [nullable] */
function nullableString(value, label, nullable = true) {
  if (nullable && value === null) return;
  assertNonEmptyString(value, label);
}

export function normalizeMarketDataIngestionPolicyV1(value) {
  const policy = assertPlainObject(value, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION);
  assertExactFields(policy, POLICY_FIELDS);
  const allowedInstrumentKinds = canonicalEnumSet(policy.allowedInstrumentKinds, MARKET_DATA_INSTRUMENT_KINDS, 'allowedInstrumentKinds');
  const allowedFrequencies = canonicalEnumSet(policy.allowedFrequencies, MARKET_DATA_FREQUENCIES, 'allowedFrequencies');
  const allowedPriceBases = canonicalEnumSet(policy.allowedPriceBases, MARKET_DATA_PRICE_BASES, 'allowedPriceBases');
  const allowedSourceDatasetKinds = canonicalEnumSet(policy.allowedSourceDatasetKinds, MARKET_DATA_SOURCE_DATASET_KINDS, 'allowedSourceDatasetKinds');
  const allowedPayloadFormats = canonicalEnumSet(policy.allowedPayloadFormats, MARKET_DATA_PAYLOAD_FORMATS, 'allowedPayloadFormats');
  assertSafeInteger(policy.maxArtifactBytes, 'maxArtifactBytes', { positive: true });
  const knowledgeModes = canonicalEnumSet(
    policy.knowledgeModes, MARKET_DATA_KNOWLEDGE_MODES, 'knowledgeModes',
    !Array.isArray(policy.knowledgeModes) || policy.knowledgeModes.length === 0
      ? 'MARKET_DATA_KNOWLEDGE_BOUNDS_REQUIRED' : 'MARKET_DATA_KNOWLEDGE_MODE_INVALID',
  );
  if (Array.isArray(policy.knowledgeModes)
      && (new Set(policy.knowledgeModes).size !== policy.knowledgeModes.length
        || [...policy.knowledgeModes].sort().some((item, index) => item !== policy.knowledgeModes[index]))) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'knowledgeModes must be sorted and unique');
  }
  const publicationAttested = knowledgeModes.includes('PROVIDER_PUBLICATION_TIME_ATTESTED')
    || knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED');
  const revisionAttested = knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED');
  if (publicationAttested) nullableString(policy.providerPublicationTimeField, 'providerPublicationTimeField', false);
  else if (policy.providerPublicationTimeField !== null) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'capture-only policy requires providerPublicationTimeField = null');
  }
  if (revisionAttested) nullableString(policy.providerRevisionIdField, 'providerRevisionIdField', false);
  else if (policy.providerRevisionIdField !== null) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID', 'providerRevisionIdField is only valid for revision-history knowledge');
  }
  assertEnum(policy.unknownFieldPolicy, ['REJECT'], 'unknownFieldPolicy');
  assertEnum(policy.duplicateIdenticalRowPolicy, ['ACCEPT_IDENTICAL', 'REJECT'], 'duplicateIdenticalRowPolicy');
  assertEnum(policy.volumePolicy, ['NULLABLE_NON_NEGATIVE_DECIMAL_STRING'], 'volumePolicy');
  return {
    schemaVersion: MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION,
    allowedInstrumentKinds,
    allowedFrequencies,
    allowedPriceBases,
    allowedSourceDatasetKinds,
    allowedPayloadFormats,
    maxArtifactBytes: policy.maxArtifactBytes,
    knowledgeModes,
    providerPublicationTimeField: policy.providerPublicationTimeField,
    providerRevisionIdField: policy.providerRevisionIdField,
    unknownFieldPolicy: policy.unknownFieldPolicy,
    duplicateIdenticalRowPolicy: policy.duplicateIdenticalRowPolicy,
    volumePolicy: policy.volumePolicy,
  };
}

export function normalizeMarketDataIngestionLineageCoreV1(value) {
  const lineage = assertPlainObject(value, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION);
  assertSchemaVersion(lineage, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION);
  assertExactFields(lineage, LINEAGE_FIELDS);
  assertNonEmptyString(lineage.providerId, 'providerId');
  assertCasId(lineage.instrumentIdentityId, 'instrumentIdentityId');
  assertEnum(lineage.frequency, MARKET_DATA_FREQUENCIES, 'frequency');
  assertNonEmptyString(lineage.venueId, 'venueId');
  assertEnum(lineage.priceBasis, MARKET_DATA_PRICE_BASES, 'priceBasis');
  assertEnum(lineage.sourceDatasetKind, MARKET_DATA_SOURCE_DATASET_KINDS, 'sourceDatasetKind');
  return { ...lineage };
}

export function normalizeMarketDataIngestionRegistryAuthorityPolicyV1(value) {
  const policy = assertPlainObject(value, MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION);
  assertSchemaVersion(policy, MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION);
  assertExactFields(policy, INGESTION_AUTHORITY_FIELDS);
  assertNonEmptyString(policy.registryNamespaceVersion, 'registryNamespaceVersion');
  if (policy.authorityScope !== 'MARKET_DATA_INGESTION') {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'authorityScope must be MARKET_DATA_INGESTION');
  }
  return { ...policy };
}

export function normalizeMarketDataSourceArtifactCoreV1(value) {
  const artifact = assertPlainObject(value, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION);
  assertSchemaVersion(artifact, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION);
  assertExactFields(artifact, ARTIFACT_FIELDS);
  assertCasId(artifact.ingestionLineageId, 'ingestionLineageId');
  assertEnum(artifact.payloadFormat, MARKET_DATA_PAYLOAD_FORMATS, 'payloadFormat');
  assertEnum(artifact.mediaType, Object.values(MARKET_DATA_MEDIA_TYPE_BY_FORMAT), 'mediaType');
  if (artifact.mediaType !== MARKET_DATA_MEDIA_TYPE_BY_FORMAT[artifact.payloadFormat]) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_ARTIFACT_INVALID', 'mediaType does not match payloadFormat');
  }
  assertCasId(artifact.embeddedBytesObjectId, 'embeddedBytesObjectId');
  assertCasId(artifact.payloadDigest, 'payloadDigest');
  assertSafeInteger(artifact.payloadByteLength, 'payloadByteLength', { nonNegative: true });
  return { ...artifact };
}

export function normalizeMarketDataSourceAttestationCoreV1(value) {
  const attestation = assertPlainObject(value, MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION);
  assertSchemaVersion(attestation, MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION);
  assertExactFields(attestation, ATTESTATION_FIELDS);
  assertCasId(attestation.ingestionLineageId, 'ingestionLineageId');
  assertEnum(attestation.attestationMode, MARKET_DATA_ATTESTATION_MODES, 'attestationMode', 'MARKET_DATA_SOURCE_ATTESTATION_MODE_INVALID');
  if (attestation.attestationMode === 'EMBEDDED_ARTIFACT') {
    if (attestation.embeddedArtifactId === null) {
      throw new MarketDataL3Error('MARKET_DATA_SOURCE_EMBEDDED_REQUIRED', 'embeddedArtifactId is required in embedded mode');
    }
    assertCasId(attestation.embeddedArtifactId, 'embeddedArtifactId');
    for (const field of ['payloadDigest', 'payloadByteLength', 'payloadFormat', 'providerId']) {
      if (attestation[field] !== null) {
        throw new MarketDataL3Error('MARKET_DATA_SOURCE_ATTESTATION_MODE_INVALID', `${field} must be null in embedded mode`);
      }
    }
  } else {
    if (attestation.embeddedArtifactId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_SOURCE_ATTESTATION_MODE_INVALID', 'embeddedArtifactId must be null in digest-only mode');
    }
    assertCasId(attestation.payloadDigest, 'payloadDigest');
    assertSafeInteger(attestation.payloadByteLength, 'payloadByteLength', { nonNegative: true });
    assertEnum(attestation.payloadFormat, MARKET_DATA_PAYLOAD_FORMATS, 'payloadFormat');
    assertNonEmptyString(attestation.providerId, 'providerId');
  }
  return { ...attestation };
}

function normalizeExecutionIdentity(value) {
  const execution = assertPlainObject(value, 'executionIdentity');
  assertExactFields(execution, EXECUTION_IDENTITY_FIELDS);
  for (const field of EXECUTION_IDENTITY_FIELDS) assertNonEmptyString(execution[field], `executionIdentity.${field}`);
  assertNoStructuredSecret(execution, 'executionIdentity', 'MARKET_DATA_INPUT_INVALID');
  return { runnerId: execution.runnerId, runId: execution.runId, environment: execution.environment };
}

export function normalizeMarketDataAcquisitionRecordCoreV1(value) {
  const record = assertPlainObject(value, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION);
  assertSchemaVersion(record, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION);
  assertExactFields(record, ACQUISITION_FIELDS);
  assertCasId(record.ingestionLineageId, 'ingestionLineageId');
  assertUtcInstant(record.acquisitionTimeUtc, 'acquisitionTimeUtc');
  assertNonEmptyString(record.providerId, 'providerId');
  assertEnum(record.logicalEndpointKind, MARKET_DATA_LOGICAL_ENDPOINT_KINDS, 'logicalEndpointKind');
  if (record.requestDatasetKind !== 'EOD_OHLCV') throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'requestDatasetKind must be EOD_OHLCV');
  const executionIdentity = normalizeExecutionIdentity(record.executionIdentity);
  assertCasId(record.sourceAttestationId, 'sourceAttestationId');
  return { ...record, executionIdentity };
}

function normalizeParseRow(value, index) {
  const row = assertPlainObject(value, `rows[${index}]`);
  assertExactFields(row, PARSE_ROW_FIELDS);
  assertSafeInteger(row.rowIndex, `rows[${index}].rowIndex`, { nonNegative: true });
  if (row.rowIndex !== index) throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'rowIndex must preserve source row order');
  assertCasId(row.rowDigest, `rows[${index}].rowDigest`);
  if (!Array.isArray(row.cells)) throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `rows[${index}].cells must be an array`);
  const cells = row.cells.map((cell, cellIndex) => {
    if (typeof cell !== 'string') throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `rows[${index}].cells[${cellIndex}] must be text`);
    return cell;
  });
  if (row.rowDigest !== canonicalDigest({ rowIndex: row.rowIndex, cells })) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_DIGEST_MISMATCH', `rows[${index}].rowDigest is incorrect`);
  }
  return { rowIndex: row.rowIndex, rowDigest: row.rowDigest, cells };
}

function normalizeSyntaxError(value, index) {
  const error = assertPlainObject(value, `syntaxErrors[${index}]`);
  assertExactFields(error, SYNTAX_ERROR_FIELDS);
  if (error.rowIndex !== null) assertSafeInteger(error.rowIndex, `syntaxErrors[${index}].rowIndex`, { nonNegative: true });
  assertNonEmptyString(error.code, `syntaxErrors[${index}].code`);
  assertNonEmptyString(error.message, `syntaxErrors[${index}].message`, { physicalLocationForbidden: false });
  return { rowIndex: error.rowIndex, code: error.code, message: error.message };
}

export function normalizeMarketDataParseResultCoreV1(value) {
  const result = assertPlainObject(value, MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION);
  assertSchemaVersion(result, MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION);
  assertExactFields(result, PARSE_FIELDS);
  assertCasId(result.sourceArtifactId, 'sourceArtifactId');
  assertCasId(result.acquisitionRecordId, 'acquisitionRecordId');
  assertCasId(result.ingestionPolicyId, 'ingestionPolicyId');
  if (!Array.isArray(result.headerFields)) throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'headerFields must be an array');
  const headerFields = result.headerFields.map((field, index) => {
    if (typeof field !== 'string') throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `headerFields[${index}] must be text`);
    return field;
  });
  assertSafeInteger(result.rowCount, 'rowCount', { nonNegative: true });
  if (!Array.isArray(result.rows)) throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'rows must be an array');
  const rows = result.rows.map(normalizeParseRow);
  if (result.rowCount !== rows.length) throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'rowCount must equal rows.length');
  if (!Array.isArray(result.syntaxErrors)) throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'syntaxErrors must be an array');
  const syntaxErrors = result.syntaxErrors.map(normalizeSyntaxError);
  return { ...result, headerFields, rows, syntaxErrors };
}

export function normalizeMarketDataSourceTemporalEvidenceCoreV1(value) {
  const evidence = assertPlainObject(value, MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION);
  assertSchemaVersion(evidence, MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION);
  assertExactFields(evidence, TEMPORAL_FIELDS);
  assertCasId(evidence.sourceArtifactId, 'sourceArtifactId');
  assertCasId(evidence.acquisitionRecordId, 'acquisitionRecordId');
  assertCasId(evidence.parseResultId, 'parseResultId');
  assertSafeInteger(evidence.sourceRowIndex, 'sourceRowIndex', { nonNegative: true });
  if (typeof evidence.sourceCellPath !== 'string' || !/^\/cells\/(?:0|[1-9]\d*)$/.test(evidence.sourceCellPath)) {
    throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID', 'sourceCellPath must be /cells/<index>');
  }
  assertCasId(evidence.sourceCellDigest, 'sourceCellDigest');
  assertNonEmptyString(evidence.rawTimestampValue, 'rawTimestampValue', { physicalLocationForbidden: false });
  assertUtcInstant(evidence.normalizedTimestampUtc, 'normalizedTimestampUtc');
  assertEnum(evidence.evidenceKind, MARKET_DATA_TEMPORAL_EVIDENCE_KINDS, 'evidenceKind', 'MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID');
  if (evidence.evidenceKind === 'PROVIDER_REVISION_TIMESTAMP') {
    if (evidence.providerRevisionId === null) {
      throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_REQUIRED', 'providerRevisionId is required for revision evidence');
    }
    assertNonEmptyString(evidence.providerRevisionId, 'providerRevisionId');
  } else if (evidence.providerRevisionId !== null) {
    throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID', 'publication evidence requires providerRevisionId = null');
  }
  return { ...evidence };
}

/** @param {any} store @param {any} lineage @param {any} context */
function verifyLineageAuthorities(store, lineage, context) {
  let policy;
  try { policy = readTypedReference(store, context.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy'); }
  catch (cause) { throw asMarketDataL3Error(cause); }
  let identityRegistry;
  try { identityRegistry = verifyInstrumentIdentityRegistry({ store, registryManifestId: context.instrumentIdentityRegistryManifestId }); }
  catch (cause) { throw new MarketDataL3Error('MARKET_DATA_IDENTITY_REGISTRY_MISMATCH', 'instrument identity registry is missing, corrupt or foreign', { cause }); }
  const identityBundle = identityRegistry.identityBundles.find(
    (bundle) => bundle.identityManifest.instrumentIdentityId === lineage.instrumentIdentityId,
  );
  if (!identityBundle) throw new MarketDataL3Error('MARKET_DATA_INSTRUMENT_NOT_AUTHORIZED', 'instrument identity is not authorized by the pinned L2B registry');
  const instrumentKind = identityBundle.identityCore.instrumentKind;
  if (!MARKET_DATA_INSTRUMENT_KINDS.includes(instrumentKind)) {
    throw new MarketDataL3Error('MARKET_DATA_INSTRUMENT_KIND_UNSUPPORTED', 'instrument kind is not supported by L3-I1', { instrumentKind });
  }
  if (!policy.allowedInstrumentKinds.includes(instrumentKind)) {
    throw new MarketDataL3Error('MARKET_DATA_INSTRUMENT_NOT_AUTHORIZED', 'instrument kind is not authorized by the ingestion policy', { instrumentKind });
  }
  if (!policy.allowedFrequencies.includes(lineage.frequency)
      || !policy.allowedPriceBases.includes(lineage.priceBasis)
      || !policy.allowedSourceDatasetKinds.includes(lineage.sourceDatasetKind)) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_LINEAGE_INVALID', 'lineage parameters are not authorized by the ingestion policy');
  }
  let calendarRegistry;
  try { calendarRegistry = verifyMarketCalendarRegistry({ store, calendarRegistryManifestId: context.calendarRegistryManifestId }); }
  catch (cause) { throw new MarketDataL3Error('MARKET_DATA_CALENDAR_REGISTRY_MISMATCH', 'calendar registry is missing, corrupt or foreign', { cause }); }
  if (calendarRegistry.policy.venueId !== lineage.venueId) {
    throw new MarketDataL3Error('MARKET_DATA_CALENDAR_REGISTRY_MISMATCH', 'calendar registry venue does not match lineage');
  }
  let corporateRegistry;
  try { corporateRegistry = verifyCorporateActionRegistry({ store, registryManifestId: context.corporateActionRegistryManifestId }); }
  catch (cause) { throw new MarketDataL3Error('MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH', 'corporate-action registry is missing, corrupt or foreign', { cause }); }
  const corporateAuthorized = corporateRegistry.instrumentRegistry.identityBundles.some(
    (bundle) => bundle.identityManifest.instrumentIdentityId === lineage.instrumentIdentityId,
  );
  if (!corporateAuthorized) {
    throw new MarketDataL3Error('MARKET_DATA_CORPORATE_ACTION_REGISTRY_MISMATCH', 'corporate-action registry does not authorize the lineage instrument');
  }
  return { policy, identityRegistry, identityBundle, calendarRegistry, corporateRegistry };
}

/** @param {any} store @param {any} artifact @param {any|null} policy */
function verifyArtifactReferences(store, artifact, policy = null) {
  const lineage = readTypedReference(store, artifact.ingestionLineageId, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, 'ingestion lineage');
  if (policy && !policy.allowedPayloadFormats.includes(artifact.payloadFormat)) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_ARTIFACT_INVALID', 'payload format is not authorized by the ingestion policy');
  }
  let source;
  try {
    const uri = store.uriForObject({ namespace: 'source', objectId: artifact.embeddedBytesObjectId });
    source = store.readObject({ uri, expectedObjectId: artifact.embeddedBytesObjectId });
  } catch (cause) {
    if (cause?.details?.fsCode === 'ENOENT') throw new MarketDataL3Error('MARKET_DATA_REFERENCE_MISSING', 'embedded source bytes are missing', { cause });
    throw new MarketDataL3Error('MARKET_DATA_REFERENCE_CORRUPT', 'embedded source bytes are corrupt', { cause });
  }
  if (artifact.payloadDigest !== source.objectId || artifact.payloadDigest !== sha256Digest(source.bytes)) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_DIGEST_MISMATCH', 'artifact payload digest does not match captured bytes');
  }
  if (artifact.payloadByteLength !== source.sizeBytes) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_ARTIFACT_INVALID', 'artifact payload byte length does not match captured bytes');
  }
  if (policy && source.sizeBytes > policy.maxArtifactBytes) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_ARTIFACT_INVALID', 'artifact exceeds maxArtifactBytes');
  }
  assertNoStructuredSecret(source.bytes, 'embedded source bytes');
  return { lineage, source };
}

/** @param {any} store @param {any} attestation */
function verifyAttestationReferences(store, attestation) {
  const lineage = readTypedReference(store, attestation.ingestionLineageId, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, 'ingestion lineage');
  if (attestation.attestationMode === 'EMBEDDED_ARTIFACT') {
    const artifact = readTypedReference(store, attestation.embeddedArtifactId, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, 'embedded source artifact');
    if (artifact.ingestionLineageId !== attestation.ingestionLineageId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_LINEAGE_INVALID', 'embedded artifact belongs to another lineage');
    }
    const resolved = verifyArtifactReferences(store, artifact);
    return { lineage, artifact, effectiveProviderId: lineage.providerId, payloadDigest: artifact.payloadDigest,
      payloadByteLength: artifact.payloadByteLength, payloadFormat: artifact.payloadFormat, source: resolved.source };
  }
  if (attestation.providerId !== lineage.providerId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_LINEAGE_INVALID', 'digest-only provider does not match lineage');
  }
  return { lineage, artifact: null, effectiveProviderId: attestation.providerId,
    payloadDigest: attestation.payloadDigest, payloadByteLength: attestation.payloadByteLength,
    payloadFormat: attestation.payloadFormat, source: null };
}

/** @param {any} store @param {any} record */
function verifyAcquisitionReferences(store, record) {
  const lineage = readTypedReference(store, record.ingestionLineageId, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, 'ingestion lineage');
  const attestation = readTypedReference(store, record.sourceAttestationId, MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, 'source attestation');
  const resolved = verifyAttestationReferences(store, attestation);
  if (attestation.ingestionLineageId !== record.ingestionLineageId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_LINEAGE_INVALID', 'acquisition and attestation use different lineages');
  }
  if (record.providerId !== lineage.providerId || record.providerId !== resolved.effectiveProviderId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_LINEAGE_INVALID', 'acquisition provider does not match attestation and lineage');
  }
  if (record.requestDatasetKind !== lineage.sourceDatasetKind) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_LINEAGE_INVALID', 'acquisition dataset kind does not match lineage');
  }
  return { lineage, attestation, resolvedAttestation: resolved };
}

/** @param {string[]} cells @param {number} rowIndex */
function makeParseRow(cells, rowIndex) {
  return { rowIndex, rowDigest: canonicalDigest({ rowIndex, cells }), cells };
}

/** @param {Buffer} bytes */
function parseCsvUtf8(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { headerFields: [], rows: [], syntaxErrors: [{ rowIndex: null, code: 'INVALID_UTF8', message: 'payload is not valid UTF-8' }] }; }
  const syntaxErrors = [];
  if (text.charCodeAt(0) === 0xfeff) syntaxErrors.push({ rowIndex: null, code: 'UTF8_BOM_FORBIDDEN', message: 'UTF-8 BOM is not canonical CSV_UTF8' });
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return { headerFields: [], rows: [], syntaxErrors: [{ rowIndex: null, code: 'HEADER_MISSING', message: 'CSV header is missing' }] };
  const headerFields = lines[0].split(',');
  if (lines[0].includes('"')) syntaxErrors.push({ rowIndex: null, code: 'QUOTED_FIELD_UNSUPPORTED', message: 'quoted CSV fields are unsupported in V1' });
  const rows = lines.slice(1).map((line, rowIndex) => {
    const cells = line.split(',');
    if (line.length === 0) syntaxErrors.push({ rowIndex, code: 'EMPTY_ROW', message: 'empty source row retained' });
    if (line.includes('"')) syntaxErrors.push({ rowIndex, code: 'QUOTED_FIELD_UNSUPPORTED', message: 'quoted CSV fields are unsupported in V1' });
    if (cells.length !== headerFields.length) syntaxErrors.push({ rowIndex, code: 'CELL_COUNT_MISMATCH', message: 'row cell count differs from header count' });
    return makeParseRow(cells, rowIndex);
  });
  return { headerFields, rows, syntaxErrors };
}

/** @param {Buffer} bytes */
function parseCanonicalJsonTable(bytes) {
  let payload;
  try { payload = parseCanonicalJsonBytes(bytes); }
  catch { return { headerFields: [], rows: [], syntaxErrors: [{ rowIndex: null, code: 'CANONICAL_JSON_INVALID', message: 'payload is not canonical JSON' }] }; }
  const syntaxErrors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).sort().join(',') !== 'headerFields,rows') {
    return { headerFields: [], rows: [], syntaxErrors: [{ rowIndex: null, code: 'JSON_TABLE_SHAPE_INVALID', message: 'JSON table must contain only headerFields and rows' }] };
  }
  const headerFields = Array.isArray(payload.headerFields)
    ? payload.headerFields.map((field) => typeof field === 'string' ? field : JSON.stringify(field)) : [];
  if (!Array.isArray(payload.headerFields) || payload.headerFields.some((field) => typeof field !== 'string')) {
    syntaxErrors.push({ rowIndex: null, code: 'HEADER_INVALID', message: 'header fields must be text' });
  }
  const sourceRows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!Array.isArray(payload.rows)) syntaxErrors.push({ rowIndex: null, code: 'ROWS_INVALID', message: 'rows must be an array' });
  const rows = sourceRows.map((raw, rowIndex) => {
    const values = Array.isArray(raw) ? raw : [raw];
    const cells = values.map((cell) => typeof cell === 'string' ? cell : JSON.stringify(cell));
    if (!Array.isArray(raw) || values.some((cell) => typeof cell !== 'string')) {
      syntaxErrors.push({ rowIndex, code: 'ROW_CELL_INVALID', message: 'row retained but every cell must be text' });
    }
    if (cells.length !== headerFields.length) syntaxErrors.push({ rowIndex, code: 'CELL_COUNT_MISMATCH', message: 'row cell count differs from header count' });
    return makeParseRow(cells, rowIndex);
  });
  return { headerFields, rows, syntaxErrors };
}

/** @param {any} store @param {any} artifact @param {any} acquisition @param {any} policy */
function computeParseResult(store, artifact, acquisition, policy) {
  const artifactResolved = verifyArtifactReferences(store, artifact, policy);
  const acquisitionResolved = verifyAcquisitionReferences(store, acquisition);
  if (acquisition.ingestionLineageId !== artifact.ingestionLineageId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_LINEAGE_INVALID', 'artifact and acquisition belong to different lineages');
  }
  const parsed = artifact.payloadFormat === 'CSV_UTF8'
    ? parseCsvUtf8(artifactResolved.source.bytes)
    : parseCanonicalJsonTable(artifactResolved.source.bytes);
  return { parsed, artifactResolved, acquisitionResolved };
}

/** @param {unknown} input */
export function buildMarketDataIngestionPolicy(input) {
  const api = assertApiInput(input, ['policy']);
  const policy = normalizeMarketDataIngestionPolicyV1(api.policy);
  const stored = putCanonicalL3(api.store, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, policy);
  return { ingestionPolicyId: stored.objectId, ingestionPolicy: stored.value, object: stored };
}

/** @param {unknown} input */
export function verifyMarketDataIngestionPolicy(input) {
  const api = assertApiInput(input, ['ingestionPolicyId']);
  const policy = readTypedReference(api.store, api.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy');
  return { ingestionPolicyId: api.ingestionPolicyId, ingestionPolicy: policy };
}

/** @param {unknown} input */
export function buildMarketDataIngestionLineage(input) {
  const api = assertApiInput(input, ['lineage', 'ingestionPolicyId', 'instrumentIdentityRegistryManifestId', 'calendarRegistryManifestId', 'corporateActionRegistryManifestId']);
  const lineage = normalizeMarketDataIngestionLineageCoreV1(api.lineage);
  const authorities = verifyLineageAuthorities(api.store, lineage, api);
  const stored = putCanonicalL3(api.store, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, lineage);
  return { ingestionLineageId: stored.objectId, ingestionLineage: stored.value, object: stored, ...authorities };
}

/** @param {unknown} input */
export function verifyMarketDataIngestionLineage(input) {
  const api = assertApiInput(input, ['ingestionLineageId', 'ingestionPolicyId', 'instrumentIdentityRegistryManifestId', 'calendarRegistryManifestId', 'corporateActionRegistryManifestId']);
  const lineage = readTypedReference(api.store, api.ingestionLineageId, MARKET_DATA_INGESTION_LINEAGE_CORE_SCHEMA_VERSION, 'ingestion lineage');
  const authorities = verifyLineageAuthorities(api.store, lineage, api);
  return { ingestionLineageId: api.ingestionLineageId, ingestionLineage: lineage, ...authorities };
}

/** @param {unknown} input */
export function buildMarketDataIngestionRegistryAuthorityPolicy(input) {
  const api = assertApiInput(input, ['policy']);
  const policy = normalizeMarketDataIngestionRegistryAuthorityPolicyV1(api.policy);
  const stored = putCanonicalL3(api.store, MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION, policy);
  return { ingestionRegistryAuthorityPolicyId: stored.objectId, ingestionRegistryAuthorityPolicy: stored.value, object: stored };
}

/** @param {unknown} input */
export function verifyMarketDataIngestionRegistryAuthorityPolicy(input) {
  const api = assertApiInput(input, ['ingestionRegistryAuthorityPolicyId']);
  const policy = readTypedReference(api.store, api.ingestionRegistryAuthorityPolicyId, MARKET_DATA_INGESTION_REGISTRY_AUTHORITY_POLICY_SCHEMA_VERSION, 'ingestion registry authority policy');
  return { ingestionRegistryAuthorityPolicyId: api.ingestionRegistryAuthorityPolicyId, ingestionRegistryAuthorityPolicy: policy };
}

/** @param {unknown} input */
export function buildMarketDataSourceArtifact(input) {
  const api = assertApiInput(input, ['artifact', 'ingestionPolicyId']);
  const artifact = normalizeMarketDataSourceArtifactCoreV1(api.artifact);
  const policy = readTypedReference(api.store, api.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy');
  const resolved = verifyArtifactReferences(api.store, artifact, policy);
  const stored = putCanonicalL3(api.store, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, artifact);
  return { sourceArtifactId: stored.objectId, sourceArtifact: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyMarketDataSourceArtifact(input) {
  const api = assertApiInput(input, ['sourceArtifactId', 'ingestionPolicyId']);
  const artifact = readTypedReference(api.store, api.sourceArtifactId, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, 'source artifact');
  const policy = readTypedReference(api.store, api.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy');
  const resolved = verifyArtifactReferences(api.store, artifact, policy);
  return { sourceArtifactId: api.sourceArtifactId, sourceArtifact: artifact, ingestionPolicy: policy, ...resolved };
}

/** @param {unknown} input */
export function buildMarketDataSourceAttestation(input) {
  const api = assertApiInput(input, ['attestation']);
  const attestation = normalizeMarketDataSourceAttestationCoreV1(api.attestation);
  const resolved = verifyAttestationReferences(api.store, attestation);
  const stored = putCanonicalL3(api.store, MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, attestation);
  return { sourceAttestationId: stored.objectId, sourceAttestation: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyMarketDataSourceAttestation(input) {
  const api = assertApiInput(input, ['sourceAttestationId']);
  const attestation = readTypedReference(api.store, api.sourceAttestationId, MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, 'source attestation');
  const resolved = verifyAttestationReferences(api.store, attestation);
  return { sourceAttestationId: api.sourceAttestationId, sourceAttestation: attestation, ...resolved };
}

/** @param {unknown} input */
export function buildMarketDataAcquisitionRecord(input) {
  const api = assertApiInput(input, ['record']);
  const record = normalizeMarketDataAcquisitionRecordCoreV1(api.record);
  const resolved = verifyAcquisitionReferences(api.store, record);
  const stored = putCanonicalL3(api.store, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, record);
  return { acquisitionRecordId: stored.objectId, acquisitionRecord: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyMarketDataAcquisitionRecord(input) {
  const api = assertApiInput(input, ['acquisitionRecordId']);
  const record = readTypedReference(api.store, api.acquisitionRecordId, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, 'acquisition record');
  const resolved = verifyAcquisitionReferences(api.store, record);
  return { acquisitionRecordId: api.acquisitionRecordId, acquisitionRecord: record, ...resolved };
}

/** @param {unknown} input */
export function buildMarketDataParseResult(input) {
  const api = assertApiInput(input, ['sourceArtifactId', 'acquisitionRecordId', 'ingestionPolicyId']);
  const artifact = readTypedReference(api.store, api.sourceArtifactId, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, 'source artifact');
  const acquisition = readTypedReference(api.store, api.acquisitionRecordId, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, 'acquisition record');
  const policy = readTypedReference(api.store, api.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy');
  const attestation = readTypedReference(api.store, acquisition.sourceAttestationId, MARKET_DATA_SOURCE_ATTESTATION_CORE_SCHEMA_VERSION, 'source attestation');
  if (attestation.attestationMode !== 'EMBEDDED_ARTIFACT' || attestation.embeddedArtifactId !== api.sourceArtifactId) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_EMBEDDED_REQUIRED', 'parsing requires the acquisition embedded artifact');
  }
  const computed = computeParseResult(api.store, artifact, acquisition, policy);
  const candidate = normalizeMarketDataParseResultCoreV1({
    schemaVersion: MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION,
    sourceArtifactId: api.sourceArtifactId,
    acquisitionRecordId: api.acquisitionRecordId,
    ingestionPolicyId: api.ingestionPolicyId,
    headerFields: computed.parsed.headerFields,
    rowCount: computed.parsed.rows.length,
    rows: computed.parsed.rows,
    syntaxErrors: computed.parsed.syntaxErrors,
  });
  const stored = putCanonicalL3(api.store, MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION, candidate);
  return { parseResultId: stored.objectId, parseResult: stored.value, object: stored };
}

/** @param {unknown} input */
export function verifyMarketDataParseResult(input) {
  const api = assertApiInput(input, ['parseResultId']);
  const result = readTypedReference(api.store, api.parseResultId, MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION, 'parse result');
  const artifact = readTypedReference(api.store, result.sourceArtifactId, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, 'source artifact');
  const acquisition = readTypedReference(api.store, result.acquisitionRecordId, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, 'acquisition record');
  const policy = readTypedReference(api.store, result.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy');
  const computed = computeParseResult(api.store, artifact, acquisition, policy);
  const expected = normalizeMarketDataParseResultCoreV1({ ...result,
    headerFields: computed.parsed.headerFields, rowCount: computed.parsed.rows.length,
    rows: computed.parsed.rows, syntaxErrors: computed.parsed.syntaxErrors });
  if (!canonicalValuesEqual(result, expected)) {
    throw new MarketDataL3Error('MARKET_DATA_SOURCE_DIGEST_MISMATCH', 'parse result does not match captured source bytes');
  }
  return { parseResultId: api.parseResultId, parseResult: result, sourceArtifact: artifact, acquisitionRecord: acquisition, ingestionPolicy: policy };
}

/** @param {unknown} input */
export function buildMarketDataSourceTemporalEvidence(input) {
  const api = assertApiInput(input, ['evidence']);
  const evidence = normalizeMarketDataSourceTemporalEvidenceCoreV1(api.evidence);
  verifyTemporalEvidenceReferences(api.store, evidence);
  const stored = putCanonicalL3(api.store, MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION, evidence);
  return { sourceTemporalEvidenceId: stored.objectId, sourceTemporalEvidence: stored.value, object: stored };
}

/** @param {unknown} input */
export function verifyMarketDataSourceTemporalEvidence(input) {
  const api = assertApiInput(input, ['sourceTemporalEvidenceId']);
  const evidence = readTypedReference(api.store, api.sourceTemporalEvidenceId, MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION, 'source temporal evidence');
  const resolved = verifyTemporalEvidenceReferences(api.store, evidence);
  return { sourceTemporalEvidenceId: api.sourceTemporalEvidenceId, sourceTemporalEvidence: evidence, ...resolved };
}

/** @param {any} store @param {any} evidence */
function verifyTemporalEvidenceReferences(store, evidence) {
  const parseResult = readTypedReference(store, evidence.parseResultId, MARKET_DATA_PARSE_RESULT_CORE_SCHEMA_VERSION, 'parse result');
  const artifact = readTypedReference(store, evidence.sourceArtifactId, MARKET_DATA_SOURCE_ARTIFACT_CORE_SCHEMA_VERSION, 'source artifact');
  const acquisition = readTypedReference(store, evidence.acquisitionRecordId, MARKET_DATA_ACQUISITION_RECORD_CORE_SCHEMA_VERSION, 'acquisition record');
  if (parseResult.sourceArtifactId !== evidence.sourceArtifactId || parseResult.acquisitionRecordId !== evidence.acquisitionRecordId) {
    throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID', 'temporal evidence references a different artifact or acquisition');
  }
  const row = parseResult.rows[evidence.sourceRowIndex];
  if (!row) throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_REQUIRED', 'source row is absent from parse result');
  const cellIndex = Number(evidence.sourceCellPath.slice('/cells/'.length));
  const cell = row.cells[cellIndex];
  if (cell === undefined) throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_REQUIRED', 'source cell is absent from parse result');
  if (cell !== evidence.rawTimestampValue || sha256Digest(cell) !== evidence.sourceCellDigest) {
    throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID', 'source cell value or digest does not match parse result');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cell)
      || cell !== evidence.normalizedTimestampUtc) {
    throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID', 'provider timestamp cannot be normalized deterministically to the asserted UTC instant');
  }
  const policy = readTypedReference(store, parseResult.ingestionPolicyId, MARKET_DATA_INGESTION_POLICY_SCHEMA_VERSION, 'ingestion policy');
  const neededMode = evidence.evidenceKind === 'PROVIDER_REVISION_TIMESTAMP'
    ? 'PROVIDER_REVISION_HISTORY_ATTESTED' : 'PROVIDER_PUBLICATION_TIME_ATTESTED';
  if (!policy.knowledgeModes.includes(neededMode)
      && !(neededMode === 'PROVIDER_PUBLICATION_TIME_ATTESTED'
        && policy.knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED'))) {
    throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_MODE_INVALID', 'ingestion policy does not authorize this temporal evidence kind');
  }
  if (parseResult.headerFields[cellIndex] !== policy.providerPublicationTimeField) {
    throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID', 'source cell is not the provider field pinned by the ingestion policy');
  }
  if (evidence.evidenceKind === 'PROVIDER_REVISION_TIMESTAMP') {
    const revisionCellIndex = parseResult.headerFields.indexOf(policy.providerRevisionIdField);
    if (revisionCellIndex < 0 || row.cells[revisionCellIndex] !== evidence.providerRevisionId) {
      throw new MarketDataL3Error('MARKET_DATA_PROVIDER_TIMESTAMP_EVIDENCE_INVALID', 'providerRevisionId is not founded on the pinned ParseResult field');
    }
  }
  return { parseResult, sourceArtifact: artifact, acquisitionRecord: acquisition, ingestionPolicy: policy };
}
