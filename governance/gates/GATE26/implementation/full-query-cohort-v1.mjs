/**
 * GATE26 FULL QUERY COHORT V1 — R0003 PREBUILD.
 *
 * One FULL query unit is one canonical published GATE25 ANALOGUE_INDEX record,
 * consumed exactly once, in the storage order the index already guarantees
 * (analogueIdentityId ascending). That order is VERIFIED here and never produced
 * by a sort: a source that is not already in canonical order is a corrupt source.
 *
 * The published index is a single canonical JSON line (~191 MB). It is read as a
 * byte stream and split into records by a structural scanner, so memory stays
 * O(one record) whatever Q is, and there is no global JSON.parse of the index.
 * Every record is re-verified through the GATE25 verifier and must be exactly its
 * own canonical bytes. Nothing here loads the P3H universe U.
 *
 * This module is also the single loader of the R0003 FULL PREBUILD authority: the
 * pinned contract, its CURRENT_CONTRACT pointer and the five FULL binding artifacts,
 * each re-checked against the R0003 requirement bindings it cites.
 */

import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { identityMemberValue } from '../../GATE25/implementation/analogue-identity-v1.mjs';
import {
  ANALOGUE_INDEX_FIELDS_V1, ANALOGUE_INDEX_PRODUCT_PATH_V1, ANALOGUE_INDEX_SCHEMA_V1, INDEX_PAGE_SIZE_V1, verifyIndexRecord,
} from '../../GATE25/implementation/analogue-index-v1.mjs';
import { assertClosedKeys, failClosed } from './ensemble-identity-v1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const R0003_CONTRACT_PATH = 'governance/gates/GATE26/contracts/EXECUTION_CONTRACT_R0003.json';
export const R0003_CONTRACT_SHA256 = 'dddbc62956eb658b8207126a18edd9c7317e845f4c2b56374a6c05c28e90f381';
export const CURRENT_CONTRACT_POINTER_PATH = 'governance/gates/GATE26/contracts/CURRENT_CONTRACT.json';
export const FULL_BINDING_ARTIFACT_PATHS_V1 = Object.freeze({
  GATE26_FULL_QUERY_COHORT_V1: 'governance/gates/GATE26/contracts/GATE26_FULL_QUERY_COHORT_V1.json',
  GATE26_FULL_MANIFEST_V1: 'governance/gates/GATE26/contracts/GATE26_FULL_MANIFEST_V1.json',
  GATE26_FULL_ENSEMBLE_PAGE_V1: 'governance/gates/GATE26/contracts/GATE26_FULL_ENSEMBLE_PAGE_V1.json',
  GATE26_FULL_PROVENANCE_PAGE_V1: 'governance/gates/GATE26/contracts/GATE26_FULL_PROVENANCE_PAGE_V1.json',
  GATE26_FULL_CHECKPOINT_V1: 'governance/gates/GATE26/contracts/GATE26_FULL_CHECKPOINT_V1.json',
});
export const FULL_QUERY_COHORT_SCHEMA_V1 = 'GATE26_FULL_QUERY_COHORT_V1';
export const FULL_PRODUCT_ROOT_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/FULL';
export const PREBUILD_REHEARSAL_REPORT_PATH_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/PREBUILD/REHEARSAL_REPORT.json';
export const QUERY_UNIT_FIELDS_V1 = Object.freeze(['ordinal', 'analogueIdentityId', 'sessionDate', 'knowledgeCutoff', 'p3hKeyId']);
export const SOURCE_CHUNK_BYTES_V1 = 1 << 20;

const EXPECTED_AUTHORIZED_PATH_COUNT = 13;
const FULL_PRODUCTION_REPLAY = 'GATE26 FULL production generation';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function readRepositoryJson(root, path, code) {
  let bytes;
  try { bytes = readFileSync(resolve(root, path)); } catch (cause) { failClosed(`${code}_ABSENT`, { path, cause: cause.code }); }
  try { return { bytes, json: JSON.parse(bytes.toString('utf8')) }; } catch { failClosed(`${code}_MALFORMED`, { path }); }
}

const sameCanonical = (left, right) => canonicalize(left) === canonicalize(right);

/**
 * The R0003 FULL PREBUILD authority, re-derived from repository bytes on every call.
 * A caller cannot hand in a more permissive authority: FULL production and FULL
 * product writes are read off the pinned contract itself, and R0003 grants neither.
 */
export function loadFullPrebuildAuthority({ root = REPOSITORY_ROOT } = {}) {
  const pointer = readRepositoryJson(root, CURRENT_CONTRACT_POINTER_PATH, 'CURRENT_CONTRACT').json;
  if (pointer.gateId !== 'GATE26' || pointer.contractRevision !== 'R0003' || pointer.contractPath !== R0003_CONTRACT_PATH
    || pointer.contractSha256 !== R0003_CONTRACT_SHA256) {
    failClosed('CURRENT_CONTRACT_NOT_R0003', { contractRevision: pointer.contractRevision ?? null });
  }
  const { bytes: contractBytes, json: contract } = readRepositoryJson(root, R0003_CONTRACT_PATH, 'EXECUTION_CONTRACT');
  if (sha256Bytes(contractBytes) !== R0003_CONTRACT_SHA256) failClosed('EXECUTION_CONTRACT_SHA256_MISMATCH', { observed: sha256Bytes(contractBytes) });
  if (contract.gateId !== 'GATE26' || contract.contractRevision !== 'R0003') failClosed('EXECUTION_CONTRACT_REVISION_INVALID');
  if (!Array.isArray(contract.authorizedPaths) || contract.authorizedPaths.length !== EXPECTED_AUTHORIZED_PATH_COUNT
    || new Set(contract.authorizedPaths).size !== EXPECTED_AUTHORIZED_PATH_COUNT
    || contract.authorizedPaths.some((path) => /[*?[\]]/.test(path) || path.startsWith(`${FULL_PRODUCT_ROOT_V1}/`))) {
    failClosed('AUTHORIZED_PATHS_NOT_EXACT');
  }
  const requirements = new Map(contract.canonicalRequirements.map((requirement) => [requirement.requirementId, requirement]));
  const requirementBinding = (id) => {
    const binding = requirements.get(id)?.binding;
    if (!binding) failClosed('CONTRACT_REQUIREMENT_BINDING_ABSENT', { requirementId: id });
    return binding;
  };
  const packaging = contract.packagingRequirements;

  const bindings = {};
  for (const [bindingId, path] of Object.entries(FULL_BINDING_ARTIFACT_PATHS_V1)) {
    const artifact = readRepositoryJson(root, path, 'FULL_BINDING_ARTIFACT').json;
    const authority = artifact.authority ?? {};
    if (artifact.document !== 'GATE26_BINDING_ARTIFACT' || artifact.gateId !== 'GATE26' || artifact.bindingId !== bindingId
      || authority.executionContractPath !== R0003_CONTRACT_PATH || authority.executionContractRevision !== 'R0003'
      || authority.executionContractSha256 !== R0003_CONTRACT_SHA256 || artifact.binding?.schema !== bindingId) {
      failClosed('FULL_BINDING_ARTIFACT_DIVERGES_FROM_R0003', { bindingId });
    }
    if (!Array.isArray(artifact.requirementIds) || artifact.requirementIds.some((id) => !requirements.has(id))) {
      failClosed('FULL_BINDING_ARTIFACT_DIVERGES_FROM_R0003', { bindingId, field: 'requirementIds' });
    }
    for (const [id, digest] of Object.entries(authority.requirementBindingSha256Canonical ?? {})) {
      if (sha256Canonical(requirementBinding(id)) !== digest) failClosed('FULL_BINDING_ARTIFACT_DIVERGES_FROM_R0003', { bindingId, requirementId: id });
    }
    if (authority.packagingRequirementsSha256Canonical !== undefined && authority.packagingRequirementsSha256Canonical !== sha256Canonical(packaging)) {
      failClosed('FULL_BINDING_ARTIFACT_DIVERGES_FROM_R0003', { bindingId, field: 'packagingRequirements' });
    }
    bindings[bindingId] = artifact.binding;
  }

  const cohort = bindings.GATE26_FULL_QUERY_COHORT_V1;
  const manifest = bindings.GATE26_FULL_MANIFEST_V1;
  const ensemblePage = bindings.GATE26_FULL_ENSEMBLE_PAGE_V1;
  const provenancePage = bindings.GATE26_FULL_PROVENANCE_PAGE_V1;
  const r02 = requirementBinding('G26-PREBUILD-02');
  const r03 = requirementBinding('G26-PREBUILD-03');
  const r04 = requirementBinding('G26-PREBUILD-04');
  const r06 = requirementBinding('G26-PREBUILD-06');
  const indexInput = contract.requiredInputs.find((input) => input.role === 'CANONICAL_G25_QUERY_COHORT_LFS_CONTENT');
  const crossChecks = [
    ['queryCount', [cohort.queryCount, r02.queryCount, r04.ensembleRecordCount, r04.provenanceRecordCount, r06.Q, cohort.complexity.Q]],
    ['queryUnit', [cohort.queryUnit, r02.queryUnit]],
    ['canonicalOrder', [cohort.canonicalOrder, r02.canonicalOrder]],
    ['skipPolicy', [cohort.skipPolicy, r02.skipPolicy]],
    ['invalidRecord', [cohort.invalidRecord, r02.invalidRecord]],
    ['insufficientEvidence', [cohort.insufficientEvidence, r02.insufficientEvidence]],
    ['sourcePath', [cohort.source.path, indexInput?.path, ANALOGUE_INDEX_PRODUCT_PATH_V1]],
    ['sourceSha256', [cohort.source.sha256, r03.analogueIndexSha256, indexInput?.sha256]],
    ['gate25ProvenanceSha256', [cohort.source.gate25ProvenanceSha256, r03.gate25ProvenanceSha256]],
    ['p3hDatasetId', [cohort.p3hDatasetId, r03.p3hDatasetId, cohort.source.datasetId]],
    ['horizons', [canonicalize(cohort.horizonSessionCounts), canonicalize(r03.horizonSessionCounts)]],
    ['pageSize', [cohort.pagePlan.pageSize, r04.pageSize, packaging.pageSize, ensemblePage.pageSize, provenancePage.pageSize]],
    ['pageCount', [cohort.pagePlan.pageCount, r04.ensemblePageCount, r04.provenancePageCount, r06.P, cohort.complexity.P]],
    ['universe', [cohort.complexity.U, r06.U]],
    ['horizonCount', [cohort.complexity.H, r06.H, r03.horizonSessionCounts.length]],
    ['noUniverseScan', [cohort.complexity.wholeUniverseScanPerQuery, r06.wholeUniverseScanPerQuery, false]],
    ['noAppendSort', [cohort.complexity.repeatedAppendSort, r06.repeatedAppendSort, false]],
    ['pageNumbering', [cohort.pagePlan.pageNumbering, ensemblePage.pageNumbering, provenancePage.pageNumbering, packaging.pageNumbering]],
    ['ensemblePageSchema', [ensemblePage.schema, packaging.ensemblePageSchema]],
    ['provenancePageSchema', [provenancePage.schema, packaging.provenancePageSchema]],
    ['ensemblePagePattern', [ensemblePage.pathPattern, packaging.ensemblePagePattern]],
    ['provenancePagePattern', [provenancePage.pathPattern, packaging.provenancePagePattern]],
    ['manifestSchema', [manifest.schema, packaging.manifestSchema]],
    ['fullProductRoot', [manifest.fullProductRoot, packaging.fullProductRoot, FULL_PRODUCT_ROOT_V1]],
    ['manifestPath', [`${manifest.fullProductRoot}/${manifest.manifestFileName}`, packaging.futureManifestPath]],
    ['lfsRule', [manifest.lfs.rule, packaging.lfsRule]],
    ['productFileCount', [manifest.futureFullProductFileCount, r04.futureFullProductFileCount, 1 + r04.ensemblePageCount + r04.provenancePageCount]],
    ['productFilesAuthorized', [manifest.productFilesAuthorizedUnderR0003, packaging.productFilesAuthorizedUnderThisRevision]],
    ['productVersion', [manifest.productVersion, ensemblePage.productVersion, provenancePage.productVersion]],
  ];
  for (const [field, values] of crossChecks) {
    if (values.some((value) => value === undefined || value !== values[0])) failClosed('FULL_BINDING_CROSS_CHECK_FAILED', { field });
  }
  const lastPageRecordCount = r02.queryCount - (r04.ensemblePageCount - 1) * r04.pageSize;
  if (cohort.pagePlan.lastPageRecordCount !== lastPageRecordCount || lastPageRecordCount < 1 || lastPageRecordCount > r04.pageSize) {
    failClosed('FULL_BINDING_CROSS_CHECK_FAILED', { field: 'lastPageRecordCount' });
  }

  const productFilesAuthorized = packaging.productFilesAuthorizedUnderThisRevision === true;
  const fullProductionAuthorized = productFilesAuthorized
    && r04.productionUnderR0003 !== 'FORBIDDEN'
    && !(contract.forbiddenReplays ?? []).includes(FULL_PRODUCTION_REPLAY);
  return deepFreeze({
    contract: { path: R0003_CONTRACT_PATH, revision: 'R0003', sha256: R0003_CONTRACT_SHA256 },
    authorizedPaths: [...contract.authorizedPaths],
    productFilesAuthorized,
    fullProductionAuthorized,
    fullProductRoot: FULL_PRODUCT_ROOT_V1,
    rehearsalReportPath: PREBUILD_REHEARSAL_REPORT_PATH_V1,
    canonicalSource: { path: cohort.source.path, sha256: cohort.source.sha256, datasetId: cohort.source.datasetId },
    queryCount: cohort.queryCount,
    pageSize: cohort.pagePlan.pageSize,
    pageCount: cohort.pagePlan.pageCount,
    lastPageRecordCount,
    bindings,
  });
}

/* ------------------------------------------------------------------ page plan */

/** Contiguous ordinal ranges covering 1..queryCount exactly once. O(P), no sort, no append-copy. */
export function planQueryPages({ queryCount, pageSize }) {
  if (!Number.isInteger(queryCount) || queryCount < 1) failClosed('QUERY_CARDINALITY_MISMATCH', { queryCount });
  if (!Number.isInteger(pageSize) || pageSize < 1) failClosed('PAGE_SIZE_INVALID', { pageSize });
  const pageCount = Math.ceil(queryCount / pageSize);
  if (pageCount > 9999) failClosed('PAGE_NUMBERING_EXHAUSTED', { pageCount });
  const pages = new Array(pageCount);
  for (let index = 0; index < pageCount; index += 1) {
    const firstQueryOrdinal = index * pageSize + 1;
    const lastQueryOrdinal = Math.min(queryCount, firstQueryOrdinal + pageSize - 1);
    pages[index] = { pageNumber: index + 1, firstQueryOrdinal, lastQueryOrdinal, recordCount: lastQueryOrdinal - firstQueryOrdinal + 1 };
  }
  return { queryCount, pageSize, pageCount, lastPageRecordCount: pages[pageCount - 1].recordCount, pages };
}

export function pageFileName(kind, pageNumber) {
  if (!['ENSEMBLE', 'PROVENANCE'].includes(kind)) failClosed('PAGE_KIND_INVALID', { kind });
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 9999) failClosed('PAGE_NUMBER_INVALID', { pageNumber });
  return `${kind}_PAGE_${String(pageNumber).padStart(4, '0')}.json`;
}

/* ------------------------------------------------------------ streaming scan */

const BYTE = Object.freeze({ QUOTE: 0x22, BACKSLASH: 0x5c, LBRACE: 0x7b, RBRACE: 0x7d, LBRACKET: 0x5b, RBRACKET: 0x5d, COMMA: 0x2c });
const corrupt = (reason, details = {}) => failClosed('SOURCE_PRODUCT_CORRUPTION', { reason, ...details });

/**
 * Streams a canonical GATE25 ANALOGUE_INDEX file and calls onRecord(unit, record) once per
 * record, in file order, after that record passed every structural check. Returns the
 * whole-file identity, the verified envelope and the recomputed cohort digest.
 */
export function streamVerifiedIndexRecords({ path, onRecord = () => {}, counters = {}, chunkBytes = SOURCE_CHUNK_BYTES_V1 }) {
  const fileHash = createHash('sha256');
  const cohortHash = createHash('sha256').update(`${FULL_QUERY_COHORT_SCHEMA_V1}\n`, 'utf8');
  const headerParts = [];
  const trailerParts = [];
  let recordParts = null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let section = 'HEADER';
  let expectComma = false;
  let byteLength = 0;
  let ordinal = 0;
  let previousId = null;
  let firstId = null;
  let datasetId = null;
  let selectionPolicyVersionId = null;
  let topLevelClosed = false;
  counters.bytesRead ??= 0; counters.chunks ??= 0; counters.recordsScanned ??= 0; counters.idComparisons ??= 0;
  counters.recordVerifications ??= 0; counters.digestUpdates ??= 0;

  const finishRecord = () => {
    const text = Buffer.concat(recordParts).toString('utf8');
    recordParts = null;
    ordinal += 1;
    let record;
    try { record = JSON.parse(text); } catch { corrupt('RECORD_NOT_JSON', { ordinal }); }
    if (canonicalize(record) !== text) corrupt('RECORD_NOT_CANONICAL', { ordinal });
    try { verifyIndexRecord(record); } catch (error) { corrupt('RECORD_STRUCTURALLY_INVALID', { ordinal, cause: error?.code ?? String(error) }); }
    counters.recordVerifications += 1;
    const id = record.analogueIdentityId;
    const recordDataset = identityMemberValue(record.orderedMembers, 'EligibleHistoryPinSetId');
    const recordPolicy = identityMemberValue(record.orderedMembers, 'SelectionPolicyVersionId');
    if (recordDataset !== datasetId) corrupt('RECORD_DATASET_MISMATCH', { ordinal });
    if (selectionPolicyVersionId === null) selectionPolicyVersionId = recordPolicy;
    if (recordPolicy !== selectionPolicyVersionId) corrupt('RECORD_SELECTION_POLICY_MISMATCH', { ordinal });
    if (previousId !== null) {
      counters.idComparisons += 1;
      if (id === previousId) corrupt('DUPLICATE_QUERY_IDENTITY', { ordinal, analogueIdentityId: id });
      if (!(id > previousId)) corrupt('CANONICAL_ORDER_VIOLATED', { ordinal, analogueIdentityId: id });
    }
    previousId = id;
    if (firstId === null) firstId = id;
    cohortHash.update(`${id}\n`, 'utf8');
    counters.digestUpdates += 1;
    counters.recordsScanned += 1;
    const unit = Object.freeze({
      ordinal,
      analogueIdentityId: id,
      sessionDate: identityMemberValue(record.orderedMembers, 'SessionDate'),
      knowledgeCutoff: identityMemberValue(record.orderedMembers, 'KnowledgeCutoff'),
      p3hKeyId: record.p3hKeyId,
    });
    onRecord(unit, record);
  };

  const readHeaderDataset = () => {
    const header = Buffer.concat(headerParts).toString('utf8');
    const match = /^\{"datasetId":("(?:[^"\\]|\\.)*"),"pageSize":\d+,"recordCount":\d+,"records":\[$/.exec(header);
    if (!match) corrupt('ENVELOPE_HEADER_NOT_CANONICAL');
    datasetId = JSON.parse(match[1]);
  };

  let fd;
  try { fd = openSync(path, 'r'); } catch (cause) { failClosed('SOURCE_PRODUCT_ABSENT', { cause: cause.code }); }
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const read = readSync(fd, buffer, 0, chunkBytes, null);
      if (read === 0) break;
      const chunk = buffer.subarray(0, read);
      fileHash.update(chunk);
      byteLength += read;
      counters.bytesRead += read;
      counters.chunks += 1;
      let segmentStart = 0;
      let nextBackslash = -2;
      for (let at = 0; at < read; at += 1) {
        if (topLevelClosed) corrupt('TRAILING_BYTES_AFTER_ENVELOPE');
        if (inString) {
          if (escape) { escape = false; continue; }
          /* Jump to the next quote or backslash; the backslash position is cached, so a chunk is still scanned once. */
          if (nextBackslash !== -1 && nextBackslash < at) nextBackslash = chunk.indexOf(BYTE.BACKSLASH, at);
          const quote = chunk.indexOf(BYTE.QUOTE, at);
          const next = quote === -1 ? nextBackslash : nextBackslash === -1 ? quote : Math.min(quote, nextBackslash);
          if (next === -1) { at = read; continue; }
          at = next;
          if (chunk[at] === BYTE.BACKSLASH) escape = true;
          else inString = false;
          continue;
        }
        const byte = chunk[at];
        if (byte === BYTE.QUOTE) {
          if (section === 'RECORDS' && depth === 2) corrupt('RECORDS_ARRAY_MEMBER_NOT_OBJECT');
          inString = true;
          continue;
        }
        if (section === 'RECORDS' && depth === 2) {
          if (byte === BYTE.LBRACE) {
            if (expectComma) corrupt('RECORD_SEPARATOR_INVALID', { ordinal });
            recordParts = [];
            segmentStart = at;
            depth = 3;
            continue;
          }
          if (byte === BYTE.COMMA && expectComma) { expectComma = false; continue; }
          if (byte === BYTE.RBRACKET && (expectComma || ordinal === 0)) {
            section = 'TRAILER';
            depth = 1;
            segmentStart = at;
            continue;
          }
          corrupt('RECORD_SEPARATOR_INVALID', { ordinal });
        }
        if (byte === BYTE.LBRACE || byte === BYTE.LBRACKET) {
          if (section === 'HEADER' && depth === 1) {
            if (byte !== BYTE.LBRACKET) corrupt('ENVELOPE_HEADER_NOT_CANONICAL');
            headerParts.push(Buffer.from(chunk.subarray(segmentStart, at + 1)));
            readHeaderDataset();
            section = 'RECORDS';
            depth = 2;
            continue;
          }
          depth += 1;
          continue;
        }
        if (byte === BYTE.RBRACE || byte === BYTE.RBRACKET) {
          depth -= 1;
          if (section === 'RECORDS' && depth === 2) {
            recordParts.push(Buffer.from(chunk.subarray(segmentStart, at + 1)));
            finishRecord();
            expectComma = true;
            continue;
          }
          if (depth === 0) {
            if (section !== 'TRAILER') corrupt('ENVELOPE_RECORDS_ARRAY_ABSENT');
            trailerParts.push(Buffer.from(chunk.subarray(segmentStart, at + 1)));
            segmentStart = at + 1;
            topLevelClosed = true;
          }
          if (depth < 0) corrupt('ENVELOPE_UNBALANCED');
        }
      }
      if (topLevelClosed) {
        if (segmentStart < read) corrupt('TRAILING_BYTES_AFTER_ENVELOPE');
      } else if (section === 'HEADER') headerParts.push(Buffer.from(chunk.subarray(segmentStart, read)));
      else if (section === 'RECORDS' && recordParts !== null) recordParts.push(Buffer.from(chunk.subarray(segmentStart, read)));
      else if (section === 'TRAILER') trailerParts.push(Buffer.from(chunk.subarray(segmentStart, read)));
    }
  } finally {
    closeSync(fd);
  }
  if (!topLevelClosed || inString || depth !== 0) corrupt('SOURCE_TRUNCATED');

  const envelopeText = `${Buffer.concat(headerParts).toString('utf8')}${Buffer.concat(trailerParts).toString('utf8')}`;
  let envelope;
  try { envelope = JSON.parse(envelopeText); } catch { corrupt('ENVELOPE_NOT_JSON'); }
  assertClosedKeys(envelope, ANALOGUE_INDEX_FIELDS_V1, 'SOURCE_PRODUCT_CORRUPTION', { reason: 'ENVELOPE_NOT_CLOSED' });
  if (canonicalize(envelope) !== envelopeText) corrupt('ENVELOPE_NOT_CANONICAL');
  if (envelope.schema !== ANALOGUE_INDEX_SCHEMA_V1 || envelope.pageSize !== INDEX_PAGE_SIZE_V1) corrupt('ENVELOPE_HEADER_INVALID');
  if (envelope.recordCount !== ordinal) corrupt('ENVELOPE_RECORD_COUNT_MISMATCH', { declared: envelope.recordCount, scanned: ordinal });
  if (ordinal > 0 && envelope.selectionPolicyVersionId !== selectionPolicyVersionId) corrupt('ENVELOPE_SELECTION_POLICY_MISMATCH');
  return {
    sha256: fileHash.digest('hex'),
    byteLength,
    queryCount: ordinal,
    cohortDigest: cohortHash.digest('hex'),
    datasetId: envelope.datasetId,
    selectionPolicyVersionId: envelope.selectionPolicyVersionId,
    firstAnalogueIdentityId: firstId,
    lastAnalogueIdentityId: previousId,
  };
}

/**
 * First pass: derives and pins the query cohort before any production. The page plan
 * carries each page's first and last analogueIdentityId so a later pass can prove it
 * is reading the same cohort page by page.
 */
export function deriveQueryCohort({
  path, sourceLabel, expectedSha256, expectedQueryCount, expectedDatasetId = null, pageSize, retainUnits = false, counters = {},
}) {
  if (typeof sourceLabel !== 'string' || sourceLabel.length === 0) failClosed('COHORT_SOURCE_LABEL_REQUIRED');
  if (!Number.isInteger(expectedQueryCount) || expectedQueryCount < 1) failClosed('QUERY_CARDINALITY_MISMATCH', { expectedQueryCount });
  const plan = planQueryPages({ queryCount: expectedQueryCount, pageSize });
  const units = retainUnits ? new Array(expectedQueryCount) : null;
  const stats = streamVerifiedIndexRecords({
    path,
    counters,
    onRecord: (unit) => {
      if (unit.ordinal > expectedQueryCount) failClosed('QUERY_CARDINALITY_MISMATCH', { expected: expectedQueryCount, observedAtLeast: unit.ordinal });
      const page = plan.pages[Math.floor((unit.ordinal - 1) / pageSize)];
      if (unit.ordinal === page.firstQueryOrdinal) page.firstAnalogueIdentityId = unit.analogueIdentityId;
      if (unit.ordinal === page.lastQueryOrdinal) page.lastAnalogueIdentityId = unit.analogueIdentityId;
      if (units) units[unit.ordinal - 1] = unit;
    },
  });
  if (stats.sha256 !== expectedSha256) failClosed('SOURCE_SHA256_MISMATCH', { observed: stats.sha256, expected: expectedSha256 });
  if (stats.queryCount !== expectedQueryCount) failClosed('QUERY_CARDINALITY_MISMATCH', { expected: expectedQueryCount, observed: stats.queryCount });
  if (expectedDatasetId !== null && stats.datasetId !== expectedDatasetId) failClosed('SOURCE_DATASET_MISMATCH', { observed: stats.datasetId });
  return deepFreeze({
    schema: FULL_QUERY_COHORT_SCHEMA_V1,
    sourceLabel,
    sourceSha256: stats.sha256,
    sourceByteLength: stats.byteLength,
    datasetId: stats.datasetId,
    selectionPolicyVersionId: stats.selectionPolicyVersionId,
    queryCount: stats.queryCount,
    cohortDigest: stats.cohortDigest,
    canonicalOrder: 'analogueIdentityId_ASCII_ASCENDING',
    firstAnalogueIdentityId: stats.firstAnalogueIdentityId,
    lastAnalogueIdentityId: stats.lastAnalogueIdentityId,
    plan,
    units,
  });
}

/** The canonical FULL cohort: the pinned published GATE25 index, exactly as R0003 binds it. Read-only. */
export function deriveCanonicalFullQueryCohort({ root = REPOSITORY_ROOT, authority = loadFullPrebuildAuthority({ root }), retainUnits = false, counters = {} } = {}) {
  const cohort = deriveQueryCohort({
    path: resolve(root, authority.canonicalSource.path),
    sourceLabel: authority.canonicalSource.path,
    expectedSha256: authority.canonicalSource.sha256,
    expectedQueryCount: authority.queryCount,
    expectedDatasetId: authority.canonicalSource.datasetId,
    pageSize: authority.pageSize,
    retainUnits,
    counters,
  });
  if (cohort.plan.pageCount !== authority.pageCount || cohort.plan.lastPageRecordCount !== authority.lastPageRecordCount) {
    failClosed('PAGE_PLAN_MISMATCH', { pageCount: cohort.plan.pageCount });
  }
  return cohort;
}
