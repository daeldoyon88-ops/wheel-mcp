/** L3-I2 bounded normalized delta chunks and exact delta-only assembly. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertCivilDate,
  assertExactFields,
  assertPlainObject,
  assertSafeInteger,
  assertSchemaVersion,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from './marketDataL3CommonV1.mjs';
import { addDays } from '../time/civilDate.mjs';
import {
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
} from './marketDataBarIdentityL3V1.mjs';
import {
  verifyMarketDataCandidateSet,
  verifyMarketDataValidationReport,
} from './marketDataCandidateL3V1.mjs';
import {
  MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
  MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION,
  buildMarketDataAcceptedCandidatePublicationManifest,
  materializeAcceptedMarketDataCandidate,
  verifyMarketDataAcceptedCandidatePublicationManifest,
} from './marketDataBarRevisionL3V1.mjs';

export const NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION = 'NormalizedMarketDataDeltaChunk/1';
export const NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION = 'NormalizedMarketDataDeltaAssemblyManifest/1';
export const MARKET_DATA_DELTA_L3_SCHEMA_VERSIONS = Object.freeze([
  NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION,
  NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION,
]);
export const MAX_NORMALIZED_MARKET_DATA_DELTA_CHUNK_SIZE_V1 = 100;

const CHUNK_FIELDS = Object.freeze([
  'schemaVersion', 'ingestionLineageId', 'chunkIndex', 'fromSessionDate',
  'toSessionDateExclusive', 'observationIds', 'correctionIds',
]);
const ASSEMBLY_FIELDS = Object.freeze([
  'schemaVersion', 'ingestionLineageId', 'candidateSetId', 'validationReportId',
  'publicationManifestId', 'chunkIds', 'acceptedObservationIds',
  'acceptedCorrectionIds', 'coverageFromDate', 'coverageToDateExclusive',
  'acceptedCandidateCount',
]);

function assertUniqueCasIds(value, label, nonEmpty = false) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', `${label} must be${nonEmpty ? ' a non-empty' : ' an'} array`);
  }
  const seen = new Set();
  value.forEach((id, index) => {
    assertCasId(id, `${label}[${index}]`);
    if (seen.has(id)) throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', `${label} contains a duplicate`);
    seen.add(id);
  });
  return [...value];
}

/** @param {unknown} value */
export function normalizeNormalizedMarketDataDeltaChunkV1(value) {
  const chunk = assertPlainObject(value, NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION);
  assertSchemaVersion(chunk, NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION);
  assertExactFields(chunk, CHUNK_FIELDS);
  assertCasId(chunk.ingestionLineageId, 'ingestionLineageId');
  assertSafeInteger(chunk.chunkIndex, 'chunkIndex', { nonNegative: true });
  assertCivilDate(chunk.fromSessionDate, 'fromSessionDate');
  assertCivilDate(chunk.toSessionDateExclusive, 'toSessionDateExclusive');
  if (chunk.fromSessionDate >= chunk.toSessionDateExclusive) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta chunk coverage must be non-empty');
  }
  const observationIds = assertUniqueCasIds(chunk.observationIds, 'observationIds');
  const correctionIds = assertUniqueCasIds(chunk.correctionIds, 'correctionIds');
  const size = observationIds.length + correctionIds.length;
  if (size === 0 || size > MAX_NORMALIZED_MARKET_DATA_DELTA_CHUNK_SIZE_V1) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', `delta chunk size must be 1..${MAX_NORMALIZED_MARKET_DATA_DELTA_CHUNK_SIZE_V1}`);
  }
  return { ...chunk, observationIds, correctionIds };
}

/** @param {unknown} value */
export function normalizeNormalizedMarketDataDeltaAssemblyManifestV1(value) {
  const assembly = assertPlainObject(value, NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION);
  assertSchemaVersion(assembly, NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION);
  assertExactFields(assembly, ASSEMBLY_FIELDS);
  for (const field of ['ingestionLineageId', 'candidateSetId', 'validationReportId', 'publicationManifestId']) {
    assertCasId(assembly[field], field);
  }
  const chunkIds = assertUniqueCasIds(assembly.chunkIds, 'chunkIds', true);
  const acceptedObservationIds = assertUniqueCasIds(assembly.acceptedObservationIds, 'acceptedObservationIds');
  const acceptedCorrectionIds = assertUniqueCasIds(assembly.acceptedCorrectionIds, 'acceptedCorrectionIds');
  assertCivilDate(assembly.coverageFromDate, 'coverageFromDate');
  assertCivilDate(assembly.coverageToDateExclusive, 'coverageToDateExclusive');
  if (assembly.coverageFromDate >= assembly.coverageToDateExclusive) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta assembly coverage must be non-empty');
  }
  assertSafeInteger(assembly.acceptedCandidateCount, 'acceptedCandidateCount', { positive: true });
  return { ...assembly, chunkIds, acceptedObservationIds, acceptedCorrectionIds };
}

function objectSessionDate(store, object, label) {
  const identity = readTypedReference(store, object.barIdentityId,
    MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION, `${label} bar identity`);
  return identity.sessionDate;
}

function economicObjects(store, ids, schemaVersion, label) {
  return ids.map((id) => {
    const value = readTypedReference(store, id, schemaVersion, label);
    return { id, value, sessionDate: objectSessionDate(store, value, label) };
  });
}

function assertEconomicOrder(items, label) {
  for (let i = 1; i < items.length; i += 1) {
    const previousKey = `${items[i - 1].sessionDate}\0${items[i - 1].id}`;
    const currentKey = `${items[i].sessionDate}\0${items[i].id}`;
    if (previousKey >= currentKey) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', `${label} is not in economic order`);
    }
  }
}

function verifyChunkReferences(store, chunk, publicationManifestId) {
  const publication = verifyMarketDataAcceptedCandidatePublicationManifest({ store, publicationManifestId }).publicationManifest;
  if (publication.ingestionLineageId !== chunk.ingestionLineageId) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta chunk belongs to another lineage');
  }
  const publishedObservationIds = publication.publications.map((entry) => entry.observationId).filter(Boolean);
  const publishedCorrectionIds = publication.publications.flatMap((entry) => entry.correctionIds);
  if (chunk.observationIds.some((id) => !publishedObservationIds.includes(id))
      || chunk.correctionIds.some((id) => !publishedCorrectionIds.includes(id))) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta chunk contains a foreign, historical or unpublished object');
  }
  const observations = economicObjects(store, chunk.observationIds,
    MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION, 'bar observation');
  const corrections = economicObjects(store, chunk.correctionIds,
    MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, 'bar correction');
  assertEconomicOrder(observations, 'observationIds');
  assertEconomicOrder(corrections, 'correctionIds');
  for (const item of [...observations, ...corrections]) {
    if (item.value.ingestionLineageId !== chunk.ingestionLineageId
        || item.sessionDate < chunk.fromSessionDate || item.sessionDate >= chunk.toSessionDateExclusive) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta object is foreign or outside chunk coverage');
    }
  }
  const dates = [...observations, ...corrections].map((item) => item.sessionDate).sort();
  if (dates[0] !== chunk.fromSessionDate || addDays(dates.at(-1), 1) !== chunk.toSessionDateExclusive) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta chunk range is not exact');
  }
  return { publicationManifest: publication, observations, corrections };
}

/** @param {unknown} input */
export function buildNormalizedMarketDataDeltaChunk(input) {
  const api = assertApiInput(input, ['chunk', 'publicationManifestId']);
  const chunk = normalizeNormalizedMarketDataDeltaChunkV1(api.chunk);
  const resolved = verifyChunkReferences(api.store, chunk, api.publicationManifestId);
  const stored = putCanonicalL3(api.store, NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION, chunk);
  return { deltaChunkId: stored.objectId, deltaChunk: stored.value, object: stored, ...resolved };
}

/** @param {unknown} input */
export function verifyNormalizedMarketDataDeltaChunk(input) {
  const api = assertApiInput(input, ['deltaChunkId', 'publicationManifestId']);
  const chunk = readTypedReference(api.store, api.deltaChunkId,
    NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION, 'normalized market-data delta chunk');
  const resolved = verifyChunkReferences(api.store, chunk, api.publicationManifestId);
  return { deltaChunkId: api.deltaChunkId, deltaChunk: chunk, ...resolved };
}

function verifyAssemblyReferences(store, assembly) {
  const publication = verifyMarketDataAcceptedCandidatePublicationManifest({
    store, publicationManifestId: assembly.publicationManifestId,
  }).publicationManifest;
  const candidateSet = verifyMarketDataCandidateSet({ store, candidateSetId: assembly.candidateSetId }).candidateSet;
  const report = verifyMarketDataValidationReport({ store, validationReportId: assembly.validationReportId }).validationReport;
  if (publication.candidateSetId !== assembly.candidateSetId
      || publication.validationReportId !== assembly.validationReportId
      || publication.ingestionLineageId !== assembly.ingestionLineageId
      || candidateSet.ingestionLineageId !== assembly.ingestionLineageId
      || report.candidateSetId !== assembly.candidateSetId || report.fatalErrors.length > 0) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta assembly closure is incoherent');
  }
  const chunks = assembly.chunkIds.map((deltaChunkId) => verifyNormalizedMarketDataDeltaChunk({
    store, deltaChunkId, publicationManifestId: assembly.publicationManifestId,
  }).deltaChunk);
  chunks.forEach((chunk, index) => {
    if (chunk.chunkIndex !== index) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'chunkIds must follow contiguous chunkIndex order');
    }
    if (index > 0 && chunks[index - 1].toSessionDateExclusive > chunk.fromSessionDate) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta chunk ranges overlap or regress');
    }
  });
  const observationUnion = chunks.flatMap((chunk) => chunk.observationIds);
  const correctionUnion = chunks.flatMap((chunk) => chunk.correctionIds);
  const publishedObservationIds = publication.publications.map((entry) => entry.observationId).filter(Boolean);
  const publishedCorrectionIds = publication.publications.flatMap((entry) => entry.correctionIds);
  const sameSet = (left, right) => left.length === right.length
    && [...left].sort().every((id, index) => id === [...right].sort()[index]);
  if (!canonicalValuesEqual(observationUnion, assembly.acceptedObservationIds)
      || !canonicalValuesEqual(correctionUnion, assembly.acceptedCorrectionIds)
      || !sameSet(observationUnion, publishedObservationIds)
      || !sameSet(correctionUnion, publishedCorrectionIds)) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'chunk union, assembly lists and publication manifest differ');
  }
  if (assembly.coverageFromDate !== chunks[0].fromSessionDate
      || assembly.coverageToDateExclusive !== chunks.at(-1).toSessionDateExclusive
      || assembly.acceptedCandidateCount !== publication.publications.length) {
    throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'delta assembly coverage or accepted count is not exact');
  }
  return { publicationManifest: publication, candidateSet, validationReport: report, chunks };
}

/** @param {unknown} input */
export function buildNormalizedMarketDataDeltaAssemblyManifest(input) {
  const api = assertApiInput(input, ['assembly']);
  const assembly = normalizeNormalizedMarketDataDeltaAssemblyManifestV1(api.assembly);
  const resolved = verifyAssemblyReferences(api.store, assembly);
  const stored = putCanonicalL3(api.store, NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION, assembly);
  return { deltaAssemblyManifestId: stored.objectId, deltaAssemblyManifest: stored.value, object: stored, ...resolved };
}

/** ID-only assembly recovery follows all chunks and their publication closure. @param {unknown} input */
export function verifyNormalizedMarketDataDeltaAssemblyManifest(input) {
  const api = assertApiInput(input, ['deltaAssemblyManifestId']);
  const assembly = readTypedReference(api.store, api.deltaAssemblyManifestId,
    NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION, 'normalized market-data delta assembly');
  const resolved = verifyAssemblyReferences(api.store, assembly);
  return { deltaAssemblyManifestId: api.deltaAssemblyManifestId, deltaAssemblyManifest: assembly, ...resolved };
}

function sortEconomic(items) {
  return [...items].sort((left, right) => left.sessionDate.localeCompare(right.sessionDate)
    || left.id.localeCompare(right.id));
}

function makeChunkGroups(items) {
  const byDate = new Map();
  for (const item of items) {
    if (!byDate.has(item.sessionDate)) byDate.set(item.sessionDate, []);
    byDate.get(item.sessionDate).push(item);
  }
  const groups = [];
  let current = [];
  for (const sessionDate of [...byDate.keys()].sort()) {
    const dateItems = byDate.get(sessionDate);
    if (dateItems.length > MAX_NORMALIZED_MARKET_DATA_DELTA_CHUNK_SIZE_V1) {
      throw new MarketDataL3Error('MARKET_DATA_PUBLICATION_MANIFEST_MISMATCH', 'one session exceeds the V1 chunk-size bound');
    }
    if (current.length > 0 && current.length + dateItems.length > MAX_NORMALIZED_MARKET_DATA_DELTA_CHUNK_SIZE_V1) {
      groups.push(current);
      current = [];
    }
    current.push(...dateItems);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Publishes only the authoritative delta for one already validated CandidateSet. @param {unknown} input */
export function publishValidatedMarketDataDelta(input) {
  const api = assertApiInput(input, ['candidateSetId', 'validationReportId']);
  const candidateSet = verifyMarketDataCandidateSet({ store: api.store, candidateSetId: api.candidateSetId }).candidateSet;
  const report = verifyMarketDataValidationReport({ store: api.store, validationReportId: api.validationReportId }).validationReport;
  if (report.candidateSetId !== api.candidateSetId) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_PUBLICATION_ORDER_VIOLATION', 'validation report belongs to another CandidateSet');
  }
  if (report.fatalErrors.length > 0) {
    throw new MarketDataL3Error('MARKET_DATA_VALIDATION_FAILED', 'fatal validation diagnostics prohibit publication');
  }
  const accepted = report.decisions.filter((decision) => decision.disposition === 'ACCEPTED');
  if (accepted.length === 0) {
    return {
      status: 'NO_AUTHORITATIVE_DELTA',
      publicationManifestId: null,
      deltaAssemblyManifestId: null,
    };
  }
  const publications = accepted.map((decision) => materializeAcceptedMarketDataCandidate({
    store: api.store, candidateId: decision.candidateId, candidateSetId: api.candidateSetId,
    validationReportId: api.validationReportId,
  })).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const publication = buildMarketDataAcceptedCandidatePublicationManifest({
    store: api.store,
    manifest: {
      schemaVersion: MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
      candidateSetId: api.candidateSetId,
      validationReportId: api.validationReportId,
      baseIngestionRegistryManifestId: report.baseIngestionRegistryManifestId,
      expectedParentIngestionManifestId: report.expectedParentIngestionManifestId,
      ingestionLineageId: candidateSet.ingestionLineageId,
      publications,
    },
  });
  const items = [];
  for (const entry of publications) {
    if (entry.observationId !== null) {
      const observation = readTypedReference(api.store, entry.observationId,
        MARKET_DATA_BAR_OBSERVATION_CORE_SCHEMA_VERSION, 'bar observation');
      items.push({ type: 'observation', id: entry.observationId,
        sessionDate: objectSessionDate(api.store, observation, 'bar observation') });
    }
    for (const correctionId of entry.correctionIds) {
      const correction = readTypedReference(api.store, correctionId,
        MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION, 'bar correction');
      items.push({ type: 'correction', id: correctionId,
        sessionDate: objectSessionDate(api.store, correction, 'bar correction') });
    }
  }
  const chunkIds = [];
  const chunks = [];
  for (const [chunkIndex, group] of makeChunkGroups(sortEconomic(items)).entries()) {
    const ordered = sortEconomic(group);
    const fromSessionDate = ordered[0].sessionDate;
    const toSessionDateExclusive = addDays(ordered.at(-1).sessionDate, 1);
    const built = buildNormalizedMarketDataDeltaChunk({
      store: api.store,
      publicationManifestId: publication.publicationManifestId,
      chunk: {
        schemaVersion: NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION,
        ingestionLineageId: candidateSet.ingestionLineageId,
        chunkIndex,
        fromSessionDate,
        toSessionDateExclusive,
        observationIds: sortEconomic(ordered.filter((item) => item.type === 'observation')).map((item) => item.id),
        correctionIds: sortEconomic(ordered.filter((item) => item.type === 'correction')).map((item) => item.id),
      },
    });
    chunkIds.push(built.deltaChunkId);
    chunks.push(built.deltaChunk);
  }
  const assembly = buildNormalizedMarketDataDeltaAssemblyManifest({
    store: api.store,
    assembly: {
      schemaVersion: NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION,
      ingestionLineageId: candidateSet.ingestionLineageId,
      candidateSetId: api.candidateSetId,
      validationReportId: api.validationReportId,
      publicationManifestId: publication.publicationManifestId,
      chunkIds,
      acceptedObservationIds: chunks.flatMap((chunk) => chunk.observationIds),
      acceptedCorrectionIds: chunks.flatMap((chunk) => chunk.correctionIds),
      coverageFromDate: chunks[0].fromSessionDate,
      coverageToDateExclusive: chunks.at(-1).toSessionDateExclusive,
      acceptedCandidateCount: accepted.length,
    },
  });
  return {
    status: 'AUTHORITATIVE_DELTA_READY',
    publicationManifestId: publication.publicationManifestId,
    deltaAssemblyManifestId: assembly.deltaAssemblyManifestId,
  };
}

export const recoverNormalizedMarketDataDeltaAssemblyManifest = verifyNormalizedMarketDataDeltaAssemblyManifest;
