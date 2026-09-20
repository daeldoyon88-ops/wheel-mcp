/**
 * GATE26 FULL PAGED CONSUMER V1 — bounded-memory consumption of the paged FULL product.
 *
 * The FULL product (~1.1 GB projected) is never parsed as a whole. The consumer:
 *   1. verifies the manifest bytes against a DECLARED manifest SHA-256 and re-derives
 *      the whole page plan from it (contiguous numbering, ordinal ranges, strictly
 *      ascending analogueIdentityId bounds, LFS OID == content SHA-256);
 *   2. then holds at most ONE page pair at a time, and for that pair verifies
 *      materialized bytes (a Git LFS pointer is refused), SHA-256, byte length,
 *      product/engine/policy version, cohort identity, page range, provenance pairing
 *      and every record through the same V1 boundary the MINI consumer uses.
 * Missing, duplicate, corrupt, reordered, mixed-cohort or mixed-version pages fail
 * closed. A consumer/product version mismatch at the manifest is ABSTAIN. A single
 * query is served by binary search over the manifest and one page pair.
 *
 * The Wheel live scan never parses FULL: refuseWheelScanFullParse().
 */

import fs from 'node:fs';
import path from 'node:path';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { ENSEMBLE_ENGINE_VERSION_V1, assertClosedKeys, failClosed, horizonCoverageId } from './ensemble-identity-v1.mjs';
import { COMBINATION_POLICY_SCHEMA_V1 } from './combination-policy-v1.mjs';
import { ADMISSIBLE_SESSION_COUNTS_V1 } from './ensemble-record-v1.mjs';
import { validateInputBinding } from './ensemble-provenance-v1.mjs';
import { verifyPublishedEnsembleRecord, verifyPublishedRecordProvenance } from './consumption-boundary-v1.mjs';
import { pageFileName } from './full-query-cohort-v1.mjs';
import {
  FULL_ENSEMBLE_PAGE_FIELDS_V1, FULL_ENSEMBLE_PAGE_SCHEMA_V1, FULL_LFS_RULE_V1, FULL_MANIFEST_COHORT_FIELDS_V1, FULL_MANIFEST_FIELDS_V1,
  FULL_MANIFEST_FILE_V1, FULL_MANIFEST_PAGE_ENTRY_FIELDS_V1, FULL_MANIFEST_PAGE_FILE_FIELDS_V1, FULL_MANIFEST_PRODUCED_UNDER_FIELDS_V1,
  FULL_MANIFEST_SCHEMA_V1, FULL_MODEL_POLICY_FIELDS_V1, FULL_PAIRED_PAGE_FIELDS_V1, FULL_PRODUCT_VERSION_V1, FULL_PROVENANCE_PAGE_FIELDS_V1,
  FULL_PROVENANCE_PAGE_SCHEMA_V1, assertNoFutureInputProof,
} from './full-paged-materializer-v1.mjs';

export const FULL_CONSUMER_VERSION_V1 = 'GATE26_FullPagedConsumer/1';
export const LFS_POINTER_PREFIX_V1 = 'version https://git-lfs.github.com/spec/v1';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const isSha256Hex = (value) => typeof value === 'string' && SHA256_HEX.test(value);
const member = (record, memberId) => record.orderedMembers.find((entry) => entry.memberId === memberId)?.value;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function isLfsPointerBytes(bytes) {
  return bytes.length < 1024 && bytes.subarray(0, LFS_POINTER_PREFIX_V1.length).toString('utf8') === LFS_POINTER_PREFIX_V1;
}

function assertMaterialized(bytes, details) {
  if (!Buffer.isBuffer(bytes)) failClosed('PARTIAL_ARTIFACT_REFUSED', { ...details, reason: 'SERIALIZED_BYTES_REQUIRED' });
  if (isLfsPointerBytes(bytes)) failClosed('LFS_POINTER_NOT_MATERIALIZED', details);
}

function parseCanonical(bytes, fields, code, details) {
  const text = bytes.toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { failClosed(code, { ...details, reason: 'NOT_JSON' }); }
  if (`${canonicalize(parsed)}\n` !== text) failClosed(code, { ...details, reason: 'NOT_CANONICAL' });
  assertClosedKeys(parsed, fields, code, details);
  return parsed;
}

/** Step 1: the manifest, verified against a declared identity, and the page plan it implies. */
export function openFullManifest({
  manifestBytes, expectedManifestSha256, expectedCombinationPolicyVersionId, expectedEngineVersion = ENSEMBLE_ENGINE_VERSION_V1,
  expectedProductVersion = FULL_PRODUCT_VERSION_V1, expectedPolicySchema = COMBINATION_POLICY_SCHEMA_V1, expectedCohortDigest = null,
  expectedQueryCount = null,
}) {
  for (const [field, value] of Object.entries({ expectedManifestSha256, expectedCombinationPolicyVersionId })) {
    if (!isSha256Hex(value)) failClosed('CONSUMER_DECLARED_IDENTITY_REQUIRED', { field });
  }
  assertMaterialized(manifestBytes, { artifact: 'MANIFEST' });
  const manifestSha256 = sha256Bytes(manifestBytes);
  if (manifestSha256 !== expectedManifestSha256) failClosed('MANIFEST_IDENTITY_MISMATCH', { observed: manifestSha256 });
  const manifest = parseCanonical(manifestBytes, FULL_MANIFEST_FIELDS_V1, 'MANIFEST_NOT_CLOSED', { artifact: 'MANIFEST' });
  if (manifest.schema !== FULL_MANIFEST_SCHEMA_V1 || manifest.gateId !== 'GATE26' || manifest.productClass !== 'OFF_SCAN') failClosed('MANIFEST_SCHEMA_INVALID');
  assertClosedKeys(manifest.modelPolicy, FULL_MODEL_POLICY_FIELDS_V1, 'MANIFEST_NOT_CLOSED', { field: 'modelPolicy' });
  if (manifest.productVersion !== expectedProductVersion || manifest.modelPolicy.engineVersion !== expectedEngineVersion
    || manifest.modelPolicy.combinationPolicyVersionId !== expectedCombinationPolicyVersionId
    || manifest.modelPolicy.combinationPolicySchema !== expectedPolicySchema) {
    return Object.freeze({ decision: 'ABSTAIN', abstainReason: 'CONSUMER_VERSION_MISMATCH', manifest: null, manifestSha256 });
  }
  if (manifest.modelPolicy.horizonCoverageId !== horizonCoverageId(ADMISSIBLE_SESSION_COUNTS_V1)
    || canonicalize(manifest.modelPolicy.sessionCounts) !== canonicalize([...ADMISSIBLE_SESSION_COUNTS_V1])) {
    failClosed('HORIZON_NOT_ADMISSIBLE', { reason: 'MANIFEST_HORIZON_COVERAGE' });
  }
  assertClosedKeys(manifest.producedUnder, FULL_MANIFEST_PRODUCED_UNDER_FIELDS_V1, 'MANIFEST_NOT_CLOSED', { field: 'producedUnder' });
  const inputBinding = validateInputBinding(manifest.inputBinding);
  if (manifest.inputBindingSha256 !== sha256Canonical(inputBinding)) failClosed('MANIFEST_INPUT_BINDING_MISMATCH');
  assertClosedKeys(manifest.cohort, FULL_MANIFEST_COHORT_FIELDS_V1, 'MANIFEST_NOT_CLOSED', { field: 'cohort' });
  const { cohort } = manifest;
  if (expectedCohortDigest !== null && cohort.cohortDigest !== expectedCohortDigest) failClosed('MIXED_COHORT_MANIFEST_REFUSED');
  if (expectedQueryCount !== null && cohort.queryCount !== expectedQueryCount) failClosed('QUERY_CARDINALITY_MISMATCH', { declared: cohort.queryCount });
  if (!Number.isInteger(manifest.pageSize) || manifest.pageSize < 1 || !Number.isInteger(cohort.queryCount) || cohort.queryCount < 1
    || manifest.pageCount !== Math.ceil(cohort.queryCount / manifest.pageSize) || !Array.isArray(manifest.pages)
    || manifest.pages.length !== manifest.pageCount) {
    failClosed('MANIFEST_PAGE_PLAN_INVALID');
  }
  assertClosedKeys(manifest.recordCounts, ['ensemble', 'provenance'], 'QUERY_CARDINALITY_MISMATCH', { field: 'recordCounts' });
  if (manifest.recordCounts.ensemble !== cohort.queryCount || manifest.recordCounts.provenance !== cohort.queryCount) {
    failClosed('QUERY_CARDINALITY_MISMATCH', { field: 'recordCounts' });
  }
  let previousLast = null;
  manifest.pages.forEach((entry, index) => {
    assertClosedKeys(entry, FULL_MANIFEST_PAGE_ENTRY_FIELDS_V1, 'MANIFEST_NOT_CLOSED', { pageIndex: index });
    if (entry.pageNumber !== index + 1) failClosed('MANIFEST_PAGE_ORDER_INVALID', { pageIndex: index, pageNumber: entry.pageNumber });
    const firstQueryOrdinal = index * manifest.pageSize + 1;
    const lastQueryOrdinal = Math.min(cohort.queryCount, firstQueryOrdinal + manifest.pageSize - 1);
    if (entry.firstQueryOrdinal !== firstQueryOrdinal || entry.lastQueryOrdinal !== lastQueryOrdinal || entry.recordCount !== lastQueryOrdinal - firstQueryOrdinal + 1) {
      failClosed('MANIFEST_PAGE_RANGE_INVALID', { pageNumber: entry.pageNumber });
    }
    const { firstAnalogueIdentityId: first, lastAnalogueIdentityId: last } = entry;
    if (!isSha256Hex(first) || !isSha256Hex(last) || (entry.recordCount === 1 ? first !== last : !(first < last))
      || (previousLast !== null && !(first > previousLast))) {
      failClosed('MANIFEST_PAGE_RANGE_INVALID', { pageNumber: entry.pageNumber, reason: 'IDENTITY_BOUNDS' });
    }
    for (const [kind, file] of [['ENSEMBLE', entry.ensemble], ['PROVENANCE', entry.provenance]]) {
      assertClosedKeys(file, FULL_MANIFEST_PAGE_FILE_FIELDS_V1, 'MANIFEST_NOT_CLOSED', { pageNumber: entry.pageNumber, kind });
      if (file.path !== pageFileName(kind, entry.pageNumber)) failClosed('MANIFEST_PAGE_PATH_INVALID', { pageNumber: entry.pageNumber, kind });
      if (!isSha256Hex(file.sha256) || !Number.isInteger(file.byteLength) || file.byteLength < 1) failClosed('MANIFEST_PAGE_IDENTITY_INVALID', { pageNumber: entry.pageNumber, kind });
      if (file.lfsOid !== file.sha256) failClosed('LFS_OID_MISMATCH', { pageNumber: entry.pageNumber, kind });
    }
    previousLast = last;
  });
  if (manifest.pages[0].firstAnalogueIdentityId !== cohort.firstAnalogueIdentityId || manifest.pages.at(-1).lastAnalogueIdentityId !== cohort.lastAnalogueIdentityId) {
    failClosed('MANIFEST_PAGE_RANGE_INVALID', { reason: 'COHORT_BOUNDS' });
  }
  assertClosedKeys(manifest.lfs, ['rule', 'oidAlgorithm', 'pointerConversion'], 'MANIFEST_NOT_CLOSED', { field: 'lfs' });
  if (manifest.lfs.rule !== FULL_LFS_RULE_V1 || manifest.lfs.oidAlgorithm !== 'sha256' || manifest.lfs.pointerConversion !== 'GIT_LFS_ONLY') {
    failClosed('LFS_RULE_MISMATCH');
  }
  return deepFreeze({ decision: 'OPEN', manifest, manifestSha256, manifestByteLength: manifestBytes.length, inputBinding });
}

/** Step 2: exactly one page pair, verified in isolation against the opened manifest. */
export function verifyPagePair({ opened, pageNumber, ensembleBytes, provenanceBytes }) {
  if (opened?.decision !== 'OPEN') failClosed('MANIFEST_NOT_OPEN');
  const { manifest } = opened;
  const entry = manifest.pages[pageNumber - 1];
  if (!entry || entry.pageNumber !== pageNumber) failClosed('PAGE_NOT_IN_MANIFEST', { pageNumber });
  for (const [kind, bytes, file] of [['ENSEMBLE', ensembleBytes, entry.ensemble], ['PROVENANCE', provenanceBytes, entry.provenance]]) {
    assertMaterialized(bytes, { kind, pageNumber });
    if (bytes.length !== file.byteLength || sha256Bytes(bytes) !== file.sha256) failClosed('PAGE_BYTES_IDENTITY_MISMATCH', { kind, pageNumber });
  }
  const ensemble = parseCanonical(ensembleBytes, FULL_ENSEMBLE_PAGE_FIELDS_V1, 'PAGE_NOT_CLOSED', { kind: 'ENSEMBLE', pageNumber });
  const provenance = parseCanonical(provenanceBytes, FULL_PROVENANCE_PAGE_FIELDS_V1, 'PAGE_NOT_CLOSED', { kind: 'PROVENANCE', pageNumber });
  if (ensemble.schema !== FULL_ENSEMBLE_PAGE_SCHEMA_V1 || provenance.schema !== FULL_PROVENANCE_PAGE_SCHEMA_V1) failClosed('PAGE_SCHEMA_INVALID', { pageNumber });
  for (const page of [ensemble, provenance]) {
    if (page.productVersion !== manifest.productVersion || page.engineVersion !== manifest.modelPolicy.engineVersion) {
      failClosed('MIXED_VERSION_PAGE_REFUSED', { pageNumber });
    }
    if (page.cohortDigest !== manifest.cohort.cohortDigest || page.queryCount !== manifest.cohort.queryCount
      || page.inputBindingSha256 !== manifest.inputBindingSha256 || page.pageCount !== manifest.pageCount || page.pageSize !== manifest.pageSize) {
      failClosed('MIXED_COHORT_PAGE_REFUSED', { pageNumber });
    }
    if (page.pageNumber !== entry.pageNumber) failClosed('PAGE_ORDER_INVALID', { pageNumber, declared: page.pageNumber });
    for (const field of ['firstQueryOrdinal', 'lastQueryOrdinal', 'firstAnalogueIdentityId', 'lastAnalogueIdentityId', 'recordCount']) {
      if (page[field] !== entry[field]) failClosed('PAGE_RANGE_MISMATCH', { pageNumber, field });
    }
    if (!Array.isArray(page.records) || page.records.length !== entry.recordCount) failClosed('PAGE_RECORD_COUNT_MISMATCH', { pageNumber });
  }
  if (ensemble.combinationPolicyVersionId !== manifest.modelPolicy.combinationPolicyVersionId || ensemble.horizonCoverageId !== manifest.modelPolicy.horizonCoverageId) {
    failClosed('MIXED_VERSION_PAGE_REFUSED', { pageNumber });
  }
  assertClosedKeys(provenance.pairedEnsemblePage, FULL_PAIRED_PAGE_FIELDS_V1, 'PROVENANCE_PAIRING_MISMATCH', { pageNumber });
  if (provenance.pairedEnsemblePage.sha256 !== entry.ensemble.sha256 || provenance.pairedEnsemblePage.byteLength !== entry.ensemble.byteLength) {
    failClosed('PROVENANCE_PAIRING_MISMATCH', { pageNumber, field: 'pairedEnsemblePage' });
  }
  const entries = new Array(entry.recordCount);
  let previous = null;
  for (let index = 0; index < entry.recordCount; index += 1) {
    const record = ensemble.records[index];
    verifyPublishedEnsembleRecord({ record, combinationPolicyVersionId: manifest.modelPolicy.combinationPolicyVersionId });
    const queryAnalogueIdentityId = member(record, 'QueryAnalogueIdentityId');
    if ((index === 0 && queryAnalogueIdentityId !== entry.firstAnalogueIdentityId)
      || (index === entry.recordCount - 1 && queryAnalogueIdentityId !== entry.lastAnalogueIdentityId)
      || (previous !== null && !(queryAnalogueIdentityId > previous))) {
      failClosed('RECORD_ORDER_INVALID', { pageNumber, index });
    }
    previous = queryAnalogueIdentityId;
    const manifestRecord = provenance.records[index];
    if (manifestRecord?.ensembleIdentityId !== record.ensembleIdentityId) failClosed('PROVENANCE_PAIRING_MISMATCH', { pageNumber, index });
    verifyPublishedRecordProvenance({ record, manifestRecord, productInputBinding: opened.inputBinding });
    assertNoFutureInputProof(manifestRecord);
    entries[index] = {
      queryAnalogueIdentityId,
      ensembleIdentityId: record.ensembleIdentityId,
      decision: record.decision === 'PROCEED' ? 'CONSUME' : 'ABSTAIN',
      abstainReason: record.abstention.reason,
      record,
      provenance: manifestRecord,
    };
  }
  return { pageNumber, entries };
}

/** Serves one query: binary search over manifest bounds, then exactly one page pair. */
export function lookupFullQuery({ opened, analogueIdentityId, readPagePair }) {
  if (opened?.decision !== 'OPEN') failClosed('MANIFEST_NOT_OPEN');
  if (!isSha256Hex(analogueIdentityId)) failClosed('CONSUMER_DECLARED_IDENTITY_REQUIRED', { field: 'analogueIdentityId' });
  const { pages } = opened.manifest;
  let low = 0;
  let high = pages.length - 1;
  let found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (analogueIdentityId < pages[middle].firstAnalogueIdentityId) high = middle - 1;
    else if (analogueIdentityId > pages[middle].lastAnalogueIdentityId) low = middle + 1;
    else { found = pages[middle]; break; }
  }
  if (found === null) failClosed('QUERY_NOT_IN_COHORT', { analogueIdentityId });
  const { ensembleBytes, provenanceBytes } = readPagePair(found.pageNumber);
  const verified = verifyPagePair({ opened, pageNumber: found.pageNumber, ensembleBytes, provenanceBytes });
  const hit = verified.entries.find((item) => item.queryAnalogueIdentityId === analogueIdentityId);
  if (!hit) failClosed('QUERY_NOT_IN_COHORT', { analogueIdentityId, pageNumber: found.pageNumber });
  return Object.freeze({ ...hit, pageNumber: found.pageNumber, consumerVersion: FULL_CONSUMER_VERSION_V1, manifestSha256: opened.manifestSha256 });
}

/** Reader over a product directory; the directory must contain exactly the manifest-declared files. */
export function openFullProductDirectory({ productRoot, ...expected }) {
  const read = (file) => {
    try { return fs.readFileSync(path.join(productRoot, file)); } catch (cause) {
      failClosed(cause.code === 'ENOENT' ? 'PAGE_MISSING' : 'PARTIAL_ARTIFACT_REFUSED', { file });
    }
  };
  const opened = openFullManifest({ ...expected, manifestBytes: read(FULL_MANIFEST_FILE_V1) });
  if (opened.decision !== 'OPEN') return { opened, readPagePair: null };
  const declared = new Set([FULL_MANIFEST_FILE_V1]);
  for (const entry of opened.manifest.pages) { declared.add(entry.ensemble.path); declared.add(entry.provenance.path); }
  const present = fs.readdirSync(productRoot);
  for (const name of present) if (!declared.has(name)) failClosed('UNEXPECTED_PRODUCT_FILE', { file: name });
  if (present.length !== declared.size) {
    const missing = [...declared].find((name) => !present.includes(name));
    failClosed('PAGE_MISSING', { file: missing });
  }
  const readPagePair = (pageNumber) => {
    const entry = opened.manifest.pages[pageNumber - 1];
    if (!entry) failClosed('PAGE_NOT_IN_MANIFEST', { pageNumber });
    return { ensembleBytes: read(entry.ensemble.path), provenanceBytes: read(entry.provenance.path) };
  };
  return { opened, readPagePair };
}

/** Full sequential verification, one page pair in memory at a time. */
export function consumeFullProductDirectory({ productRoot, collectQueryIds = false, onPage = null, ...expected }) {
  const { opened, readPagePair } = openFullProductDirectory({ productRoot, ...expected });
  if (opened.decision !== 'OPEN') return { decision: 'ABSTAIN', abstainReason: opened.abstainReason, pagesVerified: 0, recordsVerified: 0 };
  const { manifest } = opened;
  const decisions = {};
  const queryIds = collectQueryIds ? [] : null;
  const ensembleIdentityIds = collectQueryIds ? [] : null;
  let recordsVerified = 0;
  let largestPagePairBytes = 0;
  for (let pageNumber = 1; pageNumber <= manifest.pageCount; pageNumber += 1) {
    const { ensembleBytes, provenanceBytes } = readPagePair(pageNumber);
    largestPagePairBytes = Math.max(largestPagePairBytes, ensembleBytes.length + provenanceBytes.length);
    const verified = verifyPagePair({ opened, pageNumber, ensembleBytes, provenanceBytes });
    for (const entry of verified.entries) {
      const key = `${entry.decision}:${entry.abstainReason ?? 'NONE'}`;
      decisions[key] = (decisions[key] ?? 0) + 1;
      if (queryIds) { queryIds.push(entry.queryAnalogueIdentityId); ensembleIdentityIds.push(entry.ensembleIdentityId); }
    }
    recordsVerified += verified.entries.length;
    if (onPage) onPage(pageNumber);
  }
  if (recordsVerified !== manifest.cohort.queryCount) failClosed('QUERY_CARDINALITY_MISMATCH', { recordsVerified });
  return {
    decision: 'CONSUMED',
    consumerVersion: FULL_CONSUMER_VERSION_V1,
    manifestSha256: opened.manifestSha256,
    pagesVerified: manifest.pageCount,
    recordsVerified,
    decisions,
    queryIds,
    ensembleIdentityIds,
    largestPagePairBytes,
    maxBytesHeldAtOnce: largestPagePairBytes + opened.manifestByteLength,
    firstEnsemblePageSha256: manifest.pages[0].ensemble.sha256,
  };
}

export function refuseWheelScanFullParse() {
  failClosed('WHEEL_SCAN_FULL_PARSE_FORBIDDEN');
}

export function describeFullConsumer() {
  return Object.freeze({
    consumerVersion: FULL_CONSUMER_VERSION_V1,
    input: 'MANIFEST_THEN_ONE_PAGE_PAIR_AT_A_TIME',
    declaredManifestSha256Required: true,
    wholeProductParse: 'FORBIDDEN',
    wheelScanHotPathParse: 'FORBIDDEN',
    lfsPointer: 'REFUSED_NOT_MATERIALIZED',
    fallback: 'ABSTAIN_ON_VERSION_MISMATCH_ONLY',
    permissiveFallback: 'FORBIDDEN',
  });
}
