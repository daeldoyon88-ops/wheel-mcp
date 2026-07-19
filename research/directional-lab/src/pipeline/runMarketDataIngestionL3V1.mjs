/**
 * L3-I3 official orchestration: parse → closed atoms normalize → I2 publisher →
 * ingestion manifest → append-only ingestion registry.
 *
 * Economic normalization uses ONLY the closed atoms-table vocabulary whose
 * column names are existing schema fields (replacementValues, CandidateSet pins,
 * knowledgeMode, sessionDate). No provider aliases, no hidden policy, no heuristics.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  canonicalValuesEqual,
  sha256Digest,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
  buildMarketDataParseResult,
  buildMarketDataSourceTemporalEvidence,
  verifyMarketDataAcquisitionRecord,
  verifyMarketDataIngestionLineage,
  verifyMarketDataIngestionPolicy,
  verifyMarketDataSourceArtifact,
  verifyMarketDataSourceAttestation,
} from '../contracts/marketDataSourceL3V1.mjs';
import {
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
  buildMarketDataBarIdentity,
} from '../contracts/marketDataBarIdentityL3V1.mjs';
import { verifyMarketCalendarRegistry } from '../contracts/marketCalendarL3V1.mjs';
import {
  MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
  MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
  buildMarketDataCandidateSet,
  buildMarketDataNormalizedCandidate,
  validateMarketDataCandidateSet,
} from '../contracts/marketDataCandidateL3V1.mjs';
import { publishValidatedMarketDataDelta } from '../contracts/marketDataDeltaL3V1.mjs';
import {
  verifyMarketDataAcceptedCandidatePublicationManifest,
} from '../contracts/marketDataBarRevisionL3V1.mjs';
import {
  verifyNormalizedMarketDataDeltaAssemblyManifest,
} from '../contracts/marketDataDeltaL3V1.mjs';
import {
  MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
  appendMarketDataIngestionRegistry,
  buildMarketDataIngestionManifest,
  deriveCorporateActionTreatment,
  derivePinnedIngestionBaseView,
  deriveTemporalCapabilityFromDeltaObjects,
  tipForLineage,
  verifyMarketDataIngestionManifest,
  verifyMarketDataIngestionRegistry,
} from '../contracts/marketDataIngestionRegistryL3V1.mjs';

/**
 * Closed V1 atoms-table header. Column names are existing contract fields only.
 * The three registry pin columns transport authority pins when no parent tip
 * exists yet (lineage core does not persist them).
 */
export const MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1 = Object.freeze([
  'sessionDate',
  'openAtoms',
  'highAtoms',
  'lowAtoms',
  'closeAtoms',
  'priceScale',
  'volumeAtoms',
  'volumeScale',
  'currency',
  'knowledgeMode',
  'identityRegistryManifestId',
  'calendarRegistryManifestId',
  'corporateActionRegistryManifestId',
]);

const RUN_INGESTION_FIELDS = Object.freeze([
  'baseIngestionRegistryManifestId',
  'expectedParentIngestionManifestId',
  'ingestionPolicyId',
  'ingestionLineageId',
  'sourceArtifactId',
  'sourceAttestationId',
  'acquisitionRecordId',
]);

/** @param {any} policy */
function expectedAtomsHeader(policy) {
  const header = [...MARKET_DATA_EOD_OHLCV_ATOMS_HEADER_V1];
  const needsPublication = policy.knowledgeModes.some((mode) => mode !== 'CAPTURE_TIME_ONLY');
  if (needsPublication) {
    if (typeof policy.providerPublicationTimeField !== 'string' || policy.providerPublicationTimeField.length === 0) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        'providerPublicationTimeField is required for attested knowledge modes',
      );
    }
    header.push(policy.providerPublicationTimeField);
  }
  if (policy.knowledgeModes.includes('PROVIDER_REVISION_HISTORY_ATTESTED')) {
    if (typeof policy.providerRevisionIdField !== 'string' || policy.providerRevisionIdField.length === 0) {
      throw new MarketDataL3Error(
        'MARKET_DATA_INPUT_INVALID',
        'providerRevisionIdField is required for revision-history knowledge mode',
      );
    }
    header.push(policy.providerRevisionIdField);
  }
  return header;
}

/** @param {string} cell @param {string} label */
function parseNullableAtoms(cell, label) {
  if (cell === '') return null;
  if (!/^(?:0|[1-9]\d*)$/.test(cell)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a non-negative atom string or empty`);
  }
  return cell;
}

/** @param {string} cell @param {string} label */
function parseScale(cell, label) {
  if (!/^(?:0|[1-9]\d*)$/.test(cell)) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be a non-negative integer string`);
  }
  const scale = Number(cell);
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 18) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', `${label} must be between 0 and 18`);
  }
  return scale;
}

/** @param {any} parseResult @param {any} policy */
function readAuthorityPinsFromAtomsTable(parseResult, policy) {
  const header = expectedAtomsHeader(policy);
  if (!canonicalValuesEqual(parseResult.headerFields, header)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'ParseResult header is not the closed EOD_OHLCV atoms-table V1 vocabulary',
      { expected: header, actual: parseResult.headerFields },
    );
  }
  if (parseResult.rows.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'atoms-table has no rows to carry authority pins');
  }
  const index = Object.fromEntries(header.map((field, i) => [field, i]));
  const first = parseResult.rows[0].cells;
  const pins = {
    identityRegistryManifestId: first[index.identityRegistryManifestId],
    calendarRegistryManifestId: first[index.calendarRegistryManifestId],
    corporateActionRegistryManifestId: first[index.corporateActionRegistryManifestId],
  };
  for (const row of parseResult.rows) {
    if (row.cells[index.identityRegistryManifestId] !== pins.identityRegistryManifestId
        || row.cells[index.calendarRegistryManifestId] !== pins.calendarRegistryManifestId
        || row.cells[index.corporateActionRegistryManifestId] !== pins.corporateActionRegistryManifestId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'authority pins are not identical across atoms-table rows');
    }
  }
  assertCasId(pins.identityRegistryManifestId, 'identityRegistryManifestId');
  assertCasId(pins.calendarRegistryManifestId, 'calendarRegistryManifestId');
  assertCasId(pins.corporateActionRegistryManifestId, 'corporateActionRegistryManifestId');
  return pins;
}

/**
 * Normalize one ParseResult into BAR_INITIAL_VALUE candidates using the closed
 * atoms-table contract. Refuses any other header.
 * @param {unknown} input
 */
export function normalizeParsedMarketDataAtomsTable(input) {
  const api = assertApiInput(input, [
    'parseResult', 'policy', 'lineage', 'ingestionLineageId', 'sourceArtifactId',
    'acquisitionRecordId', 'parseResultId', 'calendarRegistryManifestId',
    'acquisitionTimeUtc', 'identityRegistryManifestId', 'corporateActionRegistryManifestId',
  ]);
  const expectedHeader = expectedAtomsHeader(api.policy);
  if (!canonicalValuesEqual(api.parseResult.headerFields, expectedHeader)) {
    throw new MarketDataL3Error(
      'MARKET_DATA_INPUT_INVALID',
      'ParseResult header is not the closed EOD_OHLCV atoms-table V1 vocabulary',
      { expected: expectedHeader, actual: api.parseResult.headerFields },
    );
  }
  if (api.parseResult.syntaxErrors.length > 0) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'ParseResult contains syntax errors');
  }

  const calendar = verifyMarketCalendarRegistry({
    store: api.store, calendarRegistryManifestId: api.calendarRegistryManifestId,
  });
  const sessionsByDate = new Map();
  for (const core of calendar.calendars) {
    for (const session of core.sessions) {
      sessionsByDate.set(session.sessionDate, session);
    }
  }

  const index = Object.fromEntries(expectedHeader.map((field, i) => [field, i]));
  const candidates = [];
  for (const row of api.parseResult.rows) {
    if (row.cells.length !== expectedHeader.length) {
      throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'row cell count diverges from closed header');
    }
    if (row.cells[index.identityRegistryManifestId] !== api.identityRegistryManifestId
        || row.cells[index.calendarRegistryManifestId] !== api.calendarRegistryManifestId
        || row.cells[index.corporateActionRegistryManifestId] !== api.corporateActionRegistryManifestId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'row authority pins diverge from ingestion pins');
    }
    const sessionDate = row.cells[index.sessionDate];
    const session = sessionsByDate.get(sessionDate);
    if (!session) {
      throw new MarketDataL3Error('MARKET_DATA_CALENDAR_REGISTRY_MISMATCH', 'sessionDate is not in the pinned calendar');
    }
    const knowledgeMode = row.cells[index.knowledgeMode];
    if (!api.policy.knowledgeModes.includes(knowledgeMode)) {
      throw new MarketDataL3Error('MARKET_DATA_KNOWLEDGE_MODE_INVALID', 'row knowledgeMode is not authorized');
    }
    const volumeAtoms = parseNullableAtoms(row.cells[index.volumeAtoms], 'volumeAtoms');
    const volumeScaleCell = row.cells[index.volumeScale];
    let volumeScale = null;
    if (volumeAtoms === null) {
      if (volumeScaleCell !== '') {
        throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'volumeScale must be empty when volumeAtoms is empty');
      }
    } else {
      volumeScale = parseScale(volumeScaleCell, 'volumeScale');
    }

    const replacementValues = {
      openAtoms: row.cells[index.openAtoms],
      highAtoms: row.cells[index.highAtoms],
      lowAtoms: row.cells[index.lowAtoms],
      closeAtoms: row.cells[index.closeAtoms],
      priceScale: parseScale(row.cells[index.priceScale], 'priceScale'),
      volumeAtoms,
      volumeScale,
      currency: row.cells[index.currency],
      priceBasis: api.lineage.priceBasis,
    };

    let knowledgeTimeLowerBound = null;
    let knowledgeTimeUpperBound = api.acquisitionTimeUtc;
    let sourceTimestampEvidenceId = null;
    let providerRevisionId = null;

    if (knowledgeMode === 'PROVIDER_PUBLICATION_TIME_ATTESTED'
        || knowledgeMode === 'PROVIDER_REVISION_HISTORY_ATTESTED') {
      const publicationField = api.policy.providerPublicationTimeField;
      const rawTimestamp = row.cells[index[publicationField]];
      const evidenceKind = knowledgeMode === 'PROVIDER_REVISION_HISTORY_ATTESTED'
        ? 'PROVIDER_REVISION_TIMESTAMP' : 'PROVIDER_PUBLICATION_TIMESTAMP';
      if (knowledgeMode === 'PROVIDER_REVISION_HISTORY_ATTESTED') {
        providerRevisionId = row.cells[index[api.policy.providerRevisionIdField]];
      }
      const cellIndex = index[publicationField];
      const evidence = buildMarketDataSourceTemporalEvidence({
        store: api.store,
        evidence: {
          schemaVersion: MARKET_DATA_SOURCE_TEMPORAL_EVIDENCE_CORE_SCHEMA_VERSION,
          sourceArtifactId: api.sourceArtifactId,
          acquisitionRecordId: api.acquisitionRecordId,
          parseResultId: api.parseResultId,
          sourceRowIndex: row.rowIndex,
          sourceCellPath: `/cells/${cellIndex}`,
          sourceCellDigest: sha256Digest(rawTimestamp),
          rawTimestampValue: rawTimestamp,
          normalizedTimestampUtc: rawTimestamp,
          evidenceKind,
          providerRevisionId,
        },
      });
      sourceTimestampEvidenceId = evidence.sourceTemporalEvidenceId;
      knowledgeTimeLowerBound = rawTimestamp;
      knowledgeTimeUpperBound = rawTimestamp;
    }

    const bar = buildMarketDataBarIdentity({
      store: api.store,
      identity: {
        schemaVersion: MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
        instrumentIdentityId: api.lineage.instrumentIdentityId,
        frequency: api.lineage.frequency,
        venueId: api.lineage.venueId,
        sessionDate,
        sessionKind: 'DAILY_REGULAR_SESSION',
      },
    });

    candidates.push({
      schemaVersion: MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
      candidateKind: 'BAR_INITIAL_VALUE',
      ingestionLineageId: api.ingestionLineageId,
      sourceArtifactId: api.sourceArtifactId,
      acquisitionRecordId: api.acquisitionRecordId,
      parseResultId: api.parseResultId,
      sourceRowIndex: row.rowIndex,
      sourceRowDigest: row.rowDigest,
      knowledgeMode,
      knowledgeTimeLowerBound,
      knowledgeTimeUpperBound,
      sourceTimestampEvidenceId,
      providerRevisionId,
      calendarRegistryManifestId: api.calendarRegistryManifestId,
      marketValidTime: session.marketValidTime,
      barIdentityId: bar.barIdentityId,
      targetCorrectionId: null,
      replacementValues,
    });
  }
  if (candidates.length === 0) {
    throw new MarketDataL3Error('MARKET_DATA_INPUT_INVALID', 'atoms-table produced zero candidates');
  }
  return { candidates, expectedHeader };
}

/**
 * Official L3-I3 ingestion orchestration.
 * @param {unknown} input
 */
export function runIngestion(input) {
  const api = assertApiInput(input, RUN_INGESTION_FIELDS);
  assertStore(api.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes']);
  assertCasId(api.baseIngestionRegistryManifestId, 'baseIngestionRegistryManifestId');
  assertCasId(api.expectedParentIngestionManifestId, 'expectedParentIngestionManifestId', true);
  assertCasId(api.ingestionPolicyId, 'ingestionPolicyId');
  assertCasId(api.ingestionLineageId, 'ingestionLineageId');
  assertCasId(api.sourceArtifactId, 'sourceArtifactId', true);
  assertCasId(api.sourceAttestationId, 'sourceAttestationId');
  assertCasId(api.acquisitionRecordId, 'acquisitionRecordId');

  // 1. Verify pinned base registry
  const { ingestionRegistryManifest: baseRegistry } = verifyMarketDataIngestionRegistry({
    store: api.store, ingestionRegistryManifestId: api.baseIngestionRegistryManifestId,
  });

  const policy = verifyMarketDataIngestionPolicy({
    store: api.store, ingestionPolicyId: api.ingestionPolicyId,
  }).ingestionPolicy;

  // 2. Verify lineage tip / expected parent under the pin
  const tipId = tipForLineage(baseRegistry, api.ingestionLineageId);
  if (tipId !== api.expectedParentIngestionManifestId) {
    if (api.expectedParentIngestionManifestId === null && tipId !== null) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_REQUIRED', 'lineage tip exists; expected parent is required');
    }
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_PARENT_MISMATCH', 'expected parent is not the tip under the pinned registry');
  }

  // 3. Verify attestation / artifact / acquisition
  const attestation = verifyMarketDataSourceAttestation({
    store: api.store, sourceAttestationId: api.sourceAttestationId,
  }).sourceAttestation;
  if (attestation.ingestionLineageId !== api.ingestionLineageId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'attestation belongs to another lineage');
  }
  if (api.sourceArtifactId === null) {
    if (attestation.attestationMode !== 'DIGEST_ONLY') {
      throw new MarketDataL3Error('MARKET_DATA_SOURCE_EMBEDDED_REQUIRED', 'null sourceArtifactId requires DIGEST_ONLY');
    }
    throw new MarketDataL3Error(
      'MARKET_DATA_SOURCE_EMBEDDED_REQUIRED',
      'DIGEST_ONLY diagnostic ingestion cannot produce authoritative economic candidates in L3 V1',
    );
  }
  const artifact = verifyMarketDataSourceArtifact({
    store: api.store,
    sourceArtifactId: api.sourceArtifactId,
    ingestionPolicyId: api.ingestionPolicyId,
  }).sourceArtifact;
  if (artifact.ingestionLineageId !== api.ingestionLineageId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'artifact belongs to another lineage');
  }
  if (attestation.attestationMode === 'EMBEDDED_ARTIFACT'
      && attestation.embeddedArtifactId !== api.sourceArtifactId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'artifact does not match attestation');
  }
  const acquisition = verifyMarketDataAcquisitionRecord({
    store: api.store, acquisitionRecordId: api.acquisitionRecordId,
  }).acquisitionRecord;
  if (acquisition.ingestionLineageId !== api.ingestionLineageId
      || acquisition.sourceAttestationId !== api.sourceAttestationId) {
    throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'acquisition is foreign');
  }

  // 4. Parse
  const parseBuilt = buildMarketDataParseResult({
    store: api.store,
    sourceArtifactId: api.sourceArtifactId,
    acquisitionRecordId: api.acquisitionRecordId,
    ingestionPolicyId: api.ingestionPolicyId,
  });

  // Authority pins: parent tip (durable) or closed atoms-table pin columns (first tip).
  let pins;
  if (tipId !== null) {
    const parent = verifyMarketDataIngestionManifest({
      store: api.store, ingestionManifestId: tipId,
    }).ingestionManifest;
    if (parent.ingestionPolicyId !== api.ingestionPolicyId) {
      throw new MarketDataL3Error('MARKET_DATA_INGESTION_KEY_MISMATCH', 'parent uses another ingestion policy');
    }
    pins = {
      identityRegistryManifestId: parent.identityRegistryManifestId,
      calendarRegistryManifestId: parent.calendarRegistryManifestId,
      corporateActionRegistryManifestId: parent.corporateActionRegistryManifestId,
    };
  } else {
    pins = readAuthorityPinsFromAtomsTable(parseBuilt.parseResult, policy);
  }

  const lineage = verifyMarketDataIngestionLineage({
    store: api.store,
    ingestionLineageId: api.ingestionLineageId,
    ingestionPolicyId: api.ingestionPolicyId,
    instrumentIdentityRegistryManifestId: pins.identityRegistryManifestId,
    calendarRegistryManifestId: pins.calendarRegistryManifestId,
    corporateActionRegistryManifestId: pins.corporateActionRegistryManifestId,
  }).ingestionLineage;

  const baseViewFull = derivePinnedIngestionBaseView(
    api.store,
    api.baseIngestionRegistryManifestId,
    api.ingestionLineageId,
    api.expectedParentIngestionManifestId,
  );
  const baseView = {
    baseIngestionRegistryManifestId: baseViewFull.baseIngestionRegistryManifestId,
    expectedParentIngestionManifestId: baseViewFull.expectedParentIngestionManifestId,
    terminalCorrectionIds: baseViewFull.terminalCorrectionIds,
    visibleCorrectionIds: baseViewFull.visibleCorrectionIds,
    occupiedBarIdentityIds: baseViewFull.occupiedBarIdentityIds,
    publishedBarIdentityIds: baseViewFull.publishedBarIdentityIds,
    duplicateCandidateIds: [],
  };

  // 5-6. Normalize + publish bar identities
  const { candidates: candidateValues } = normalizeParsedMarketDataAtomsTable({
    store: api.store,
    parseResult: parseBuilt.parseResult,
    policy,
    lineage,
    ingestionLineageId: api.ingestionLineageId,
    sourceArtifactId: api.sourceArtifactId,
    acquisitionRecordId: api.acquisitionRecordId,
    parseResultId: parseBuilt.parseResultId,
    calendarRegistryManifestId: pins.calendarRegistryManifestId,
    identityRegistryManifestId: pins.identityRegistryManifestId,
    corporateActionRegistryManifestId: pins.corporateActionRegistryManifestId,
    acquisitionTimeUtc: acquisition.acquisitionTimeUtc,
  });

  // 7. Publish candidates + CandidateSet
  const builtCandidates = candidateValues.map((candidate) => buildMarketDataNormalizedCandidate({
    store: api.store, candidate,
  }));
  const candidateIds = builtCandidates.map((item) => item.candidateId).sort();

  const duplicateCandidateIds = [];
  for (const item of builtCandidates) {
    const candidate = item.candidate;
    if (candidate.candidateKind !== 'BAR_INITIAL_VALUE') continue;
    if (!baseView.occupiedBarIdentityIds.includes(candidate.barIdentityId)) continue;
    const terminalId = baseViewFull.terminalCorrectionIds.find((correctionId) => {
      const correction = baseViewFull.correctionById.get(correctionId);
      return correction && correction.barIdentityId === candidate.barIdentityId;
    });
    if (!terminalId) continue;
    const terminal = baseViewFull.correctionById.get(terminalId);
    if (!terminal?.observationId) {
      duplicateCandidateIds.push(item.candidateId);
      continue;
    }
    const observation = baseViewFull.observationById.get(terminal.observationId);
    if (observation
        && canonicalValuesEqual(observation.values, candidate.replacementValues)
        && observation.sourceRowDigest === candidate.sourceRowDigest) {
      duplicateCandidateIds.push(item.candidateId);
    }
  }
  baseView.duplicateCandidateIds = [...new Set(duplicateCandidateIds)].sort();
  baseView.publishedBarIdentityIds = [...new Set([
    ...baseView.publishedBarIdentityIds,
    ...builtCandidates.map((item) => item.candidate.barIdentityId),
  ])].sort();

  const candidateSet = buildMarketDataCandidateSet({
    store: api.store,
    candidateSet: {
      schemaVersion: MARKET_DATA_CANDIDATE_SET_CORE_SCHEMA_VERSION,
      ingestionLineageId: api.ingestionLineageId,
      sourceArtifactId: api.sourceArtifactId,
      acquisitionRecordId: api.acquisitionRecordId,
      parseResultId: parseBuilt.parseResultId,
      ingestionPolicyId: api.ingestionPolicyId,
      identityRegistryManifestId: pins.identityRegistryManifestId,
      calendarRegistryManifestId: pins.calendarRegistryManifestId,
      corporateActionRegistryManifestId: pins.corporateActionRegistryManifestId,
      candidateIds,
    },
  });

  // 8. ValidationReport
  const report = validateMarketDataCandidateSet({
    store: api.store,
    candidateSetId: candidateSet.candidateSetId,
    baseView,
  });

  // 9-10. Hardened I2 publisher only (never trust a stored report alone)
  const delta = publishValidatedMarketDataDelta({
    store: api.store,
    candidateSetId: candidateSet.candidateSetId,
    validationReportId: report.validationReportId,
    baseView,
  });

  if (delta.status === 'NO_AUTHORITATIVE_DELTA') {
    return {
      status: 'NO_AUTHORITATIVE_DELTA',
      ingestionManifestId: null,
      ingestionRegistryManifestId: api.baseIngestionRegistryManifestId,
      candidateSetId: candidateSet.candidateSetId,
      validationReportId: report.validationReportId,
      publicationManifestId: null,
      deltaAssemblyManifestId: null,
    };
  }

  const assembly = verifyNormalizedMarketDataDeltaAssemblyManifest({
    store: api.store, deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
  }).deltaAssemblyManifest;
  verifyMarketDataAcceptedCandidatePublicationManifest({
    store: api.store, publicationManifestId: delta.publicationManifestId,
  });

  const newBarObservationIds = [...assembly.acceptedObservationIds].sort();
  const newBarCorrectionIds = [...assembly.acceptedCorrectionIds].sort();
  const temporalCapability = deriveTemporalCapabilityFromDeltaObjects(
    api.store, newBarObservationIds, newBarCorrectionIds,
  );
  const priceBasis = lineage.priceBasis;
  const corporateActionTreatment = deriveCorporateActionTreatment(priceBasis);

  // 11. Publish ingestion manifest
  const ingestion = buildMarketDataIngestionManifest({
    store: api.store,
    manifest: {
      schemaVersion: MARKET_DATA_INGESTION_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: api.ingestionLineageId,
      ingestionPolicyId: api.ingestionPolicyId,
      baseIngestionRegistryManifestId: api.baseIngestionRegistryManifestId,
      expectedParentIngestionManifestId: api.expectedParentIngestionManifestId,
      supersedesIngestionManifestId: api.expectedParentIngestionManifestId,
      identityRegistryManifestId: pins.identityRegistryManifestId,
      calendarRegistryManifestId: pins.calendarRegistryManifestId,
      corporateActionRegistryManifestId: pins.corporateActionRegistryManifestId,
      sourceArtifactId: api.sourceArtifactId,
      sourceAttestationId: api.sourceAttestationId,
      acquisitionRecordId: api.acquisitionRecordId,
      parseResultId: parseBuilt.parseResultId,
      candidateSetId: candidateSet.candidateSetId,
      validationReportId: report.validationReportId,
      acceptedCandidatePublicationManifestId: delta.publicationManifestId,
      deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
      newBarObservationIds,
      newBarCorrectionIds,
      temporalCapability,
      priceBasis,
      corporateActionTreatment,
    },
  });

  // 12. Append registry
  const registry = appendMarketDataIngestionRegistry({
    store: api.store,
    baseIngestionRegistryManifestId: api.baseIngestionRegistryManifestId,
    expectedParentIngestionManifestId: api.expectedParentIngestionManifestId,
    ingestionManifestId: ingestion.ingestionManifestId,
  });

  return {
    status: 'PUBLISHED',
    ingestionManifestId: ingestion.ingestionManifestId,
    ingestionRegistryManifestId: registry.ingestionRegistryManifestId,
    candidateSetId: candidateSet.candidateSetId,
    validationReportId: report.validationReportId,
    publicationManifestId: delta.publicationManifestId,
    deltaAssemblyManifestId: delta.deltaAssemblyManifestId,
  };
}
