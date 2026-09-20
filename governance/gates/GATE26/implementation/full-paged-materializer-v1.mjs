/**
 * GATE26 FULL PAGED MATERIALIZER V1 — R0003 PREBUILD.
 *
 * Turns a derived query cohort into paired ensemble/provenance pages of 128 query
 * units plus one manifest, through the FULL checkpoint, so an interrupted run resumes
 * from its last committed pair and ends byte-identical to a continuous run.
 *
 * UNDER R0003 THIS MODULE CANNOT PRODUCE THE FULL PRODUCT. The authority is re-read
 * from the pinned contract on every run (a caller cannot hand in a permissive one):
 *   - any output root inside data/jarvise/predictive-ensemble/GATE26/V1/FULL, directly
 *     or through a link, fails closed with R0003_FULL_PRODUCT_WRITE_FORBIDDEN;
 *   - any other output root inside the repository fails closed;
 *   - the canonical GATE25 cohort (by bytes or by label) fails closed with
 *     R0003_FULL_PRODUCTION_FORBIDDEN wherever the output would go;
 *   - a rehearsal cohort must stay bounded (PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1).
 *
 * Work per run is O(Q) producer calls, O(Q) record serializations and O(P) page
 * hashes. Pages are filled into preallocated slots in cohort order; nothing is sorted
 * and nothing is re-copied per append. The P3H universe is never loaded here.
 *
 * The PREBUILD rehearsal (CLI --rehearse) runs on a BOUNDED SYNTHETIC cohort seeded
 * from existing MINI evidence, never on the published GATE25 index. Its producer is
 * the real V1 pipeline tail: GATE25 freezeSelection -> attachPostSelectionOutcomes ->
 * GATE26 combineFrozenSelection; only the outcome source is synthetic. The CLI writes
 * exactly one repository path: the PREBUILD rehearsal report.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { PUBLISH_TEMP_SUFFIX, durableReplaceFileSync, sweepPublicationResidue } from '../../../tools/durable-write.mjs';
import { createAnalogueIdentity, identityMemberValue, missingnessStateId } from '../../GATE25/implementation/analogue-identity-v1.mjs';
import { appendIndexRecords, buildIndexRecord, createAnalogueIndex, serializeAnalogueIndex } from '../../GATE25/implementation/analogue-index-v1.mjs';
import { CORE_V1_DIMENSIONS_V1 } from '../../GATE25/implementation/analogue-eligibility-v1.mjs';
import { admissibleHorizonBindings, attachPostSelectionOutcomes, freezeSelection } from '../../GATE25/implementation/analogue-outcome-v1.mjs';
import { buildInputProof } from '../../GATE25/implementation/analogue-provenance-v1.mjs';
import { SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1 } from '../../GATE25/implementation/analogue-report-v1.mjs';
import { ENSEMBLE_ENGINE_VERSION_V1, assertClosedKeys, failClosed, horizonCoverageId } from './ensemble-identity-v1.mjs';
import { COMBINATION_POLICY_SCHEMA_V1 } from './combination-policy-v1.mjs';
import { ADMISSIBLE_SESSION_COUNTS_V1 } from './ensemble-record-v1.mjs';
import {
  ENSEMBLE_INDEX_RECORD_FIELDS_V1, PROVENANCE_MANIFEST_FIELDS_V1, buildEnsembleIndexRecord, validateInputBinding,
} from './ensemble-provenance-v1.mjs';
import { combineFrozenSelection, loadGate26MiniBuildAuthority, readEnsembleCache } from './predictive-ensemble-engine-v1.mjs';
import { verifyPublishedEnsembleRecord, verifyPublishedRecordProvenance } from './consumption-boundary-v1.mjs';
import {
  FULL_QUERY_COHORT_SCHEMA_V1, QUERY_UNIT_FIELDS_V1, deriveQueryCohort, loadFullPrebuildAuthority, pageFileName, streamVerifiedIndexRecords,
} from './full-query-cohort-v1.mjs';
import {
  FINAL_REVISION_FILE_V1, FULL_CHECKPOINT_WORK_UNIT_V1, REVISION_FIELDS_V1, RUN_IDENTITY_FIELDS_V1, RUN_IDENTITY_FILE_V1,
  computeCodeIdentity, openFullCheckpoint, resolvesInside,
} from './full-checkpoint-v1.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const FULL_PRODUCT_VERSION_V1 = 'GATE26_FULL_PRODUCT_V1';
export const FULL_MANIFEST_SCHEMA_V1 = 'GATE26_FULL_MANIFEST_V1';
export const FULL_ENSEMBLE_PAGE_SCHEMA_V1 = 'GATE26_FULL_ENSEMBLE_PAGE_V1';
export const FULL_PROVENANCE_PAGE_SCHEMA_V1 = 'GATE26_FULL_PROVENANCE_PAGE_V1';
export const FULL_MANIFEST_FILE_V1 = 'MANIFEST.json';
export const FULL_LFS_RULE_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/FULL/** filter=lfs diff=lfs merge=lfs -text';
export const FULL_ENSEMBLE_PAGE_FIELDS_V1 = Object.freeze([
  'schema', 'productVersion', 'engineVersion', 'combinationPolicyVersionId', 'horizonCoverageId', 'cohortDigest', 'queryCount',
  'inputBindingSha256', 'pageNumber', 'pageCount', 'pageSize', 'firstQueryOrdinal', 'lastQueryOrdinal', 'firstAnalogueIdentityId',
  'lastAnalogueIdentityId', 'recordCount', 'records',
]);
export const FULL_PROVENANCE_PAGE_FIELDS_V1 = Object.freeze([
  'schema', 'productVersion', 'engineVersion', 'cohortDigest', 'queryCount', 'inputBindingSha256', 'pageNumber', 'pageCount', 'pageSize',
  'firstQueryOrdinal', 'lastQueryOrdinal', 'firstAnalogueIdentityId', 'lastAnalogueIdentityId', 'recordCount', 'pairedEnsemblePage', 'records',
]);
export const FULL_PAIRED_PAGE_FIELDS_V1 = Object.freeze(['sha256', 'byteLength']);
export const FULL_MANIFEST_FIELDS_V1 = Object.freeze([
  'schema', 'productVersion', 'gateId', 'productClass', 'producedUnder', 'modelPolicy', 'inputBinding', 'inputBindingSha256', 'cohort',
  'pageSize', 'pageCount', 'recordCounts', 'pages', 'lfs',
]);
export const FULL_MANIFEST_PRODUCED_UNDER_FIELDS_V1 = Object.freeze(['contractRevision', 'contractSha256', 'codeIdentitySha256', 'producerId']);
export const FULL_MANIFEST_COHORT_FIELDS_V1 = Object.freeze([
  'sourcePath', 'sourceSha256', 'queryCount', 'cohortDigest', 'canonicalOrder', 'firstAnalogueIdentityId', 'lastAnalogueIdentityId',
]);
export const FULL_MANIFEST_PAGE_ENTRY_FIELDS_V1 = Object.freeze([
  'pageNumber', 'firstQueryOrdinal', 'lastQueryOrdinal', 'firstAnalogueIdentityId', 'lastAnalogueIdentityId', 'recordCount', 'ensemble', 'provenance',
]);
export const FULL_MANIFEST_PAGE_FILE_FIELDS_V1 = Object.freeze(['path', 'sha256', 'byteLength', 'lfsOid']);
export const FULL_MODEL_POLICY_FIELDS_V1 = Object.freeze(['engineVersion', 'combinationPolicySchema', 'combinationPolicyVersionId', 'horizonCoverageId', 'sessionCounts']);
export const QUERY_OUTPUT_FIELDS_V1 = Object.freeze(['ensembleRecord', 'provenanceRecord']);
export const PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1 = 4096;
export const FAULT_POINTS_V1 = Object.freeze([
  'BEFORE_PAIR', 'AFTER_ENSEMBLE_PAGE', 'AFTER_PROVENANCE_PAGE', 'AFTER_PAIR_COMMIT', 'BEFORE_MANIFEST', 'AFTER_MANIFEST',
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const sameList = (left, right) => Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
const member = (record, memberId) => record.orderedMembers.find((entry) => entry.memberId === memberId)?.value;
const pageBytes = (body) => Buffer.from(`${canonicalize(body)}\n`, 'utf8');

/** The code constants must be exactly what the five R0003 binding artifacts declare. */
export function assertFullBindingsMatchCode(authority) {
  const { bindings } = authority;
  const ensemble = bindings.GATE26_FULL_ENSEMBLE_PAGE_V1;
  const provenance = bindings.GATE26_FULL_PROVENANCE_PAGE_V1;
  const manifest = bindings.GATE26_FULL_MANIFEST_V1;
  const checkpoint = bindings.GATE26_FULL_CHECKPOINT_V1;
  const checks = [
    ['ensembleFields', sameList(ensemble.fields, FULL_ENSEMBLE_PAGE_FIELDS_V1)],
    ['ensembleRecordFields', sameList(ensemble.recordFields, ENSEMBLE_INDEX_RECORD_FIELDS_V1)],
    ['provenanceFields', sameList(provenance.fields, FULL_PROVENANCE_PAGE_FIELDS_V1)],
    ['provenanceRecordFields', sameList(provenance.recordFields, PROVENANCE_MANIFEST_FIELDS_V1)],
    ['pairedEnsemblePageFields', sameList(provenance.pairedEnsemblePageFields, FULL_PAIRED_PAGE_FIELDS_V1)],
    ['manifestFields', sameList(manifest.fields, FULL_MANIFEST_FIELDS_V1)],
    ['producedUnderFields', sameList(manifest.producedUnderFields, FULL_MANIFEST_PRODUCED_UNDER_FIELDS_V1)],
    ['cohortFields', sameList(manifest.cohortFields, FULL_MANIFEST_COHORT_FIELDS_V1)],
    ['pageEntryFields', sameList(manifest.pageEntryFields, FULL_MANIFEST_PAGE_ENTRY_FIELDS_V1)],
    ['pageFileFields', sameList(manifest.pageFileFields, FULL_MANIFEST_PAGE_FILE_FIELDS_V1)],
    ['queryUnitFields', sameList(bindings.GATE26_FULL_QUERY_COHORT_V1.queryUnitFields, QUERY_UNIT_FIELDS_V1)],
    ['productVersion', manifest.productVersion === FULL_PRODUCT_VERSION_V1],
    ['manifestFileName', manifest.manifestFileName === FULL_MANIFEST_FILE_V1],
    ['lfsRule', manifest.lfs.rule === FULL_LFS_RULE_V1 && manifest.lfs.oidAlgorithm === 'sha256' && manifest.lfs.pointerConversion === 'GIT_LFS_ONLY'],
    ['ensembleSchema', ensemble.schema === FULL_ENSEMBLE_PAGE_SCHEMA_V1 && provenance.schema === FULL_PROVENANCE_PAGE_SCHEMA_V1],
    ['patterns', ensemble.pathPattern === 'ENSEMBLE_PAGE_NNNN.json' && provenance.pathPattern === 'PROVENANCE_PAGE_NNNN.json'],
    ['checkpointRevisionFields', sameList(checkpoint.revisionFields, REVISION_FIELDS_V1)],
    ['checkpointRunIdentity', sameList(checkpoint.runIdentityBinds, RUN_IDENTITY_FIELDS_V1)],
    ['checkpointFiles', checkpoint.workUnitDirectory === FULL_CHECKPOINT_WORK_UNIT_V1
      && checkpoint.runIdentityFile === RUN_IDENTITY_FILE_V1 && checkpoint.finalRevisionFile === FINAL_REVISION_FILE_V1],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([field]) => field);
  if (failed.length > 0) failClosed('FULL_BINDING_DIVERGES_FROM_CODE', { fields: failed });
  return true;
}

/** Where pages may be written under the current authority. R0003: off-repository rehearsal roots only. */
export function assertOutputRootAuthorized({ root, outputRoot, authority }) {
  if (typeof outputRoot !== 'string' || outputRoot.length === 0) failClosed('OUTPUT_ROOT_REQUIRED');
  const fullRoot = path.resolve(root, authority.fullProductRoot);
  if (resolvesInside(fullRoot, outputRoot)) {
    if (!authority.fullProductionAuthorized) failClosed('R0003_FULL_PRODUCT_WRITE_FORBIDDEN', { contractRevision: authority.contract.revision });
    return 'FULL_PRODUCT_ROOT';
  }
  if (resolvesInside(root, outputRoot)) failClosed('PREBUILD_OUTPUT_INSIDE_REPOSITORY_FORBIDDEN');
  return 'OFF_REPOSITORY_REHEARSAL';
}

/** R0003 forbids FULL production: the canonical cohort never runs, and a rehearsal cohort stays bounded. */
export function assertCohortAdmissible({ cohort, authority }) {
  if (cohort?.schema !== FULL_QUERY_COHORT_SCHEMA_V1 || !cohort.plan || !SHA256_HEX.test(cohort.cohortDigest ?? '')) failClosed('COHORT_NOT_DERIVED');
  const canonical = cohort.sourceSha256 === authority.canonicalSource.sha256 || cohort.sourceLabel === authority.canonicalSource.path;
  if (canonical && !authority.fullProductionAuthorized) failClosed('R0003_FULL_PRODUCTION_FORBIDDEN', { contractRevision: authority.contract.revision });
  if (!canonical && cohort.queryCount > PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1) {
    failClosed('PREBUILD_REHEARSAL_COHORT_NOT_BOUNDED', { queryCount: cohort.queryCount, max: PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1 });
  }
  if (cohort.plan.pageSize !== authority.pageSize) failClosed('PAGE_PLAN_MISMATCH', { pageSize: cohort.plan.pageSize });
  return canonical ? 'CANONICAL_FULL' : 'PREBUILD_REHEARSAL';
}

/** No input proof may come from after the query's knowledge cutoff. */
export function assertNoFutureInputProof(manifest) {
  const cutoff = Date.parse(manifest.knowledgeCutoff);
  if (!Number.isFinite(cutoff)) failClosed('FUTURE_LEAKAGE_REFUSED', { reason: 'QUERY_CUTOFF_INVALID' });
  manifest.inputProofs.forEach((proof, index) => {
    if (!(Date.parse(proof.knowledgeCutoff) <= cutoff) || !(Date.parse(proof.availableAt) <= cutoff)) {
      failClosed('FUTURE_LEAKAGE_REFUSED', { index, inputId: proof.inputId });
    }
  });
  return true;
}

/**
 * Exactly one ensemble record and one provenance record per query unit, ABSTAIN
 * included. Both are re-verified through the same V1 boundary the consumer uses.
 */
export function validateQueryOutput({ unit, output, inputBinding, combinationPolicyVersionId }) {
  const at = { ordinal: unit.ordinal, analogueIdentityId: unit.analogueIdentityId };
  if (output === null || output === undefined) failClosed('QUERY_OUTPUT_MISSING', at);
  if (Array.isArray(output)) failClosed('QUERY_OUTPUT_NOT_EXACTLY_ONE', at);
  assertClosedKeys(output, QUERY_OUTPUT_FIELDS_V1, 'QUERY_OUTPUT_NOT_EXACTLY_ONE', at);
  if (output.ensembleRecord === null || output.provenanceRecord === null) failClosed('QUERY_OUTPUT_MISSING', at);
  const record = JSON.parse(canonicalize(output.ensembleRecord));
  verifyPublishedEnsembleRecord({ record, combinationPolicyVersionId });
  if (member(record, 'QueryAnalogueIdentityId') !== unit.analogueIdentityId || member(record, 'KnowledgeCutoff') !== unit.knowledgeCutoff) {
    failClosed('QUERY_RECORD_IDENTITY_MISMATCH', at);
  }
  const provenance = JSON.parse(canonicalize(output.provenanceRecord));
  if (provenance?.ensembleIdentityId !== record.ensembleIdentityId) failClosed('PROVENANCE_PAIRING_MISMATCH', at);
  verifyPublishedRecordProvenance({ record, manifestRecord: provenance, productInputBinding: inputBinding });
  assertNoFutureInputProof(provenance);
  return { record, provenance };
}

/* ---------------------------------------------------------------- envelopes */

function pageRange(page) {
  return {
    pageNumber: page.pageNumber,
    firstQueryOrdinal: page.firstQueryOrdinal,
    lastQueryOrdinal: page.lastQueryOrdinal,
    firstAnalogueIdentityId: page.firstAnalogueIdentityId,
    lastAnalogueIdentityId: page.lastAnalogueIdentityId,
    recordCount: page.recordCount,
  };
}

export function serializeEnsemblePage({ context, page, records }) {
  return pageBytes({
    schema: FULL_ENSEMBLE_PAGE_SCHEMA_V1,
    productVersion: FULL_PRODUCT_VERSION_V1,
    engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
    combinationPolicyVersionId: context.combinationPolicyVersionId,
    horizonCoverageId: context.horizonCoverageId,
    cohortDigest: context.cohortDigest,
    queryCount: context.queryCount,
    inputBindingSha256: context.inputBindingSha256,
    pageCount: context.pageCount,
    pageSize: context.pageSize,
    ...pageRange(page),
    records,
  });
}

export function serializeProvenancePage({ context, page, records, pairedEnsemblePage }) {
  return pageBytes({
    schema: FULL_PROVENANCE_PAGE_SCHEMA_V1,
    productVersion: FULL_PRODUCT_VERSION_V1,
    engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
    cohortDigest: context.cohortDigest,
    queryCount: context.queryCount,
    inputBindingSha256: context.inputBindingSha256,
    pageCount: context.pageCount,
    pageSize: context.pageSize,
    ...pageRange(page),
    pairedEnsemblePage: { sha256: pairedEnsemblePage.sha256, byteLength: pairedEnsemblePage.byteLength },
    records,
  });
}

const pageFile = (kind, pageNumber, digest) => ({
  path: pageFileName(kind, pageNumber), sha256: digest.sha256, byteLength: digest.byteLength, lfsOid: digest.sha256,
});

export function serializeManifest({ context, cohort, plan, committed }) {
  return pageBytes({
    schema: FULL_MANIFEST_SCHEMA_V1,
    productVersion: FULL_PRODUCT_VERSION_V1,
    gateId: 'GATE26',
    productClass: 'OFF_SCAN',
    producedUnder: {
      contractRevision: context.contract.revision,
      contractSha256: context.contract.sha256,
      codeIdentitySha256: context.codeIdentitySha256,
      producerId: context.producerId,
    },
    modelPolicy: {
      engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
      combinationPolicySchema: COMBINATION_POLICY_SCHEMA_V1,
      combinationPolicyVersionId: context.combinationPolicyVersionId,
      horizonCoverageId: context.horizonCoverageId,
      sessionCounts: [...ADMISSIBLE_SESSION_COUNTS_V1],
    },
    inputBinding: context.inputBinding,
    inputBindingSha256: context.inputBindingSha256,
    cohort: {
      sourcePath: cohort.sourceLabel,
      sourceSha256: cohort.sourceSha256,
      queryCount: cohort.queryCount,
      cohortDigest: cohort.cohortDigest,
      canonicalOrder: cohort.canonicalOrder,
      firstAnalogueIdentityId: cohort.firstAnalogueIdentityId,
      lastAnalogueIdentityId: cohort.lastAnalogueIdentityId,
    },
    pageSize: plan.pageSize,
    pageCount: plan.pageCount,
    recordCounts: { ensemble: cohort.queryCount, provenance: cohort.queryCount },
    pages: plan.pages.map((page, index) => ({
      ...pageRange(page),
      ensemble: pageFile('ENSEMBLE', page.pageNumber, committed[index].pair.ensemble),
      provenance: pageFile('PROVENANCE', page.pageNumber, committed[index].pair.provenance),
    })),
    lfs: { rule: FULL_LFS_RULE_V1, oidAlgorithm: 'sha256', pointerConversion: 'GIT_LFS_ONLY' },
  });
}

/* ------------------------------------------------------------ materializer */

/**
 * WHAT A RUN IS FOR, DECLARED BEFORE IT RUNS.
 *
 * Until Phase D the only producer that reached this boundary was the synthetic
 * PREBUILD one, so "which producer is this" never had to be asked. A real
 * production producer makes the question load-bearing in both directions, and
 * the dangerous direction is the quiet one: a synthetic producer accepted under
 * a real label would manufacture evidence that the real pipeline had run. The
 * intent is therefore declared by the caller and checked against the producer's
 * own self-description, and a mismatch either way fails closed.
 */
export const PREBUILD_REHEARSAL_INTENT_V1 = 'PREBUILD_REHEARSAL';
export const REAL_PILOT_INTENT_V1 = 'REAL_PILOT';
export const EXECUTION_INTENTS_V1 = Object.freeze([PREBUILD_REHEARSAL_INTENT_V1, REAL_PILOT_INTENT_V1]);

function assertProducer(producer, executionIntent) {
  if (!producer || typeof producer.produce !== 'function' || typeof producer.producerId !== 'string' || producer.producerId.length === 0
    || !SHA256_HEX.test(producer.producerCodeSha256 ?? '')) {
    failClosed('PRODUCER_INVALID');
  }
  if (!EXECUTION_INTENTS_V1.includes(executionIntent)) failClosed('EXECUTION_INTENT_INVALID', { executionIntent: executionIntent ?? null });
  const declaredReal = producer.synthetic === false && producer.productionClass === 'REAL_PRODUCTION';
  if (executionIntent === REAL_PILOT_INTENT_V1 && !declaredReal) {
    failClosed('REAL_EXECUTION_REQUIRES_REAL_PRODUCER', {
      producerId: producer.producerId,
      synthetic: producer.synthetic ?? null,
      productionClass: producer.productionClass ?? null,
    });
  }
  if (executionIntent === PREBUILD_REHEARSAL_INTENT_V1 && declaredReal) {
    failClosed('REAL_PRODUCER_REQUIRES_REAL_EXECUTION_INTENT', { producerId: producer.producerId });
  }
  return executionIntent;
}

/** The page-boundary guard surface this module drives. A partial guard is refused. */
function assertResourceGuard(resourceGuard, executionIntent) {
  if (resourceGuard === null || resourceGuard === undefined) {
    // A real pilot exists to measure; running one unmeasured would produce exactly
    // the unprovable budget Phase D is blocked on.
    if (executionIntent === REAL_PILOT_INTENT_V1) failClosed('REAL_EXECUTION_REQUIRES_RESOURCE_GUARD');
    return null;
  }
  for (const method of ['start', 'beforePair', 'afterPair', 'finalize', 'snapshot']) {
    if (typeof resourceGuard[method] !== 'function') failClosed('RESOURCE_GUARD_INCOMPLETE', { method });
  }
  return resourceGuard;
}

const OUTPUT_FILE = /^(ENSEMBLE|PROVENANCE)_PAGE_(\d{4})\.json$/;

/**
 * Runs (or resumes) one paged materialization. Every committed pair is re-verified on
 * disk before anything new is produced; an uncommitted frontier page is recomputed and
 * accepted only if byte-identical; nothing is ever silently overwritten.
 */
export function runPagedMaterialization({
  root = REPOSITORY_ROOT, sourcePath, cohort, producer, inputBinding, outputRoot, checkpointRoot,
  faultInjector = null, isProcessAlive = undefined, onPage = null,
  executionIntent = PREBUILD_REHEARSAL_INTENT_V1, resourceGuard = null,
}) {
  const authority = loadFullPrebuildAuthority({ root });
  assertFullBindingsMatchCode(authority);
  const target = assertOutputRootAuthorized({ root, outputRoot, authority });
  const cohortKind = assertCohortAdmissible({ cohort, authority });
  const intent = assertProducer(producer, executionIntent);
  const guard = assertResourceGuard(resourceGuard, intent);
  const binding = validateInputBinding(inputBinding);
  if (binding.datasetId !== cohort.datasetId || binding.selectionPolicyVersionId !== cohort.selectionPolicyVersionId) {
    failClosed('INPUT_BINDING_COHORT_MISMATCH');
  }
  const { plan } = cohort;
  const code = computeCodeIdentity({ root });
  const context = {
    contract: authority.contract,
    codeIdentitySha256: code.sha256,
    producerId: producer.producerId,
    combinationPolicyVersionId: loadGate26MiniBuildAuthority({ root }).policy.combinationPolicyVersionId,
    horizonCoverageId: horizonCoverageId(ADMISSIBLE_SESSION_COUNTS_V1),
    cohortDigest: cohort.cohortDigest,
    queryCount: cohort.queryCount,
    inputBinding: binding,
    inputBindingSha256: sha256Canonical(binding),
    pageCount: plan.pageCount,
    pageSize: plan.pageSize,
  };
  const runIdentity = {
    inputIdentity: { sourceSha256: cohort.sourceSha256, queryCount: cohort.queryCount, cohortDigest: cohort.cohortDigest, inputBindingSha256: context.inputBindingSha256 },
    codeIdentity: { sha256: code.sha256 },
    contractIdentity: { ...authority.contract },
    planIdentity: { productVersion: FULL_PRODUCT_VERSION_V1, pageSize: plan.pageSize, pageCount: plan.pageCount, lastPageRecordCount: plan.lastPageRecordCount },
    producerIdentity: { producerId: producer.producerId, producerCodeSha256: producer.producerCodeSha256 },
  };
  const counters = {
    producerCalls: 0, queriesSkippedAsCommitted: 0, recordValidations: 0, pageSerializations: 0, manifestSerializations: 0,
    sha256Computations: 0, fileWrites: 0, existingVerified: 0, committedPagesReverified: 0, bytesWritten: 0, scan: {},
  };
  const pageTimingsMs = [];
  const producerTimeMs = [];
  const fault = (point, pageNumber) => { if (faultInjector) faultInjector(point, pageNumber); };

  const checkpoint = openFullCheckpoint({ checkpointRoot, repositoryRoot: root, runIdentity, ...(isProcessAlive ? { isProcessAlive } : {}) });
  try {
    const frontier = checkpoint.committed.length;
    if (frontier > plan.pageCount) failClosed('CHECKPOINT_BEYOND_PLAN', { frontier });
    fs.mkdirSync(outputRoot, { recursive: true });
    // Started only once the directory exists, because the opening sample reads free
    // disk at the actual output target rather than at a parent that may sit on
    // another volume. start() is idempotent, so a caller that already started its
    // own guard across several runs keeps one continuous measurement.
    const runStartedAt = performance.now();
    guard?.start({ outputRoot });
    const outputResidue = [];
    for (const entry of fs.readdirSync(outputRoot)) {
      if (!entry.endsWith(PUBLISH_TEMP_SUFFIX)) continue;
      fs.rmSync(path.join(outputRoot, entry), { force: true });
      outputResidue.push(entry);
    }
    for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
      if (!entry.isFile()) failClosed('UNEXPECTED_OUTPUT_FILE', { entry: entry.name });
      if (entry.name === FULL_MANIFEST_FILE_V1) {
        if (frontier !== plan.pageCount) failClosed('UNEXPECTED_OUTPUT_FILE', { entry: entry.name, reason: 'MANIFEST_BEFORE_ALL_PAIRS' });
        continue;
      }
      const match = OUTPUT_FILE.exec(entry.name);
      if (!match) failClosed('UNEXPECTED_OUTPUT_FILE', { entry: entry.name });
      if (Number(match[2]) > frontier + 1 || Number(match[2]) > plan.pageCount) failClosed('UNCOMMITTED_PAGE_BEYOND_FRONTIER', { entry: entry.name, frontier });
    }
    const verifyOnDisk = (file, digest) => {
      let bytes;
      try { bytes = fs.readFileSync(path.join(outputRoot, file)); } catch { failClosed('COMMITTED_PAGE_MISSING', { file }); }
      counters.sha256Computations += 1;
      if (bytes.length !== digest.byteLength || sha256Bytes(bytes) !== digest.sha256) failClosed('COMMITTED_PAGE_BYTES_DIVERGE', { file });
    };
    for (const revision of checkpoint.committed) {
      verifyOnDisk(pageFileName('ENSEMBLE', revision.pair.pageNumber), revision.pair.ensemble);
      verifyOnDisk(pageFileName('PROVENANCE', revision.pair.pageNumber), revision.pair.provenance);
      counters.committedPagesReverified += 1;
    }
    const result = (extra) => ({
      target, cohortKind, runId: checkpoint.runId, pageCount: plan.pageCount, queryCount: cohort.queryCount, committedAtStart: frontier,
      codeIdentitySha256: code.sha256, counters, pageTimingsMs, producerTimeMs,
      residueRemoved: [...checkpoint.residueRemoved, ...outputResidue], staleLockRecovered: checkpoint.staleLockRecovered,
      checkpointRevisionWrites: checkpoint.revisionWrites,
      executionIntent: intent, resourceSnapshot: guard ? guard.snapshot() : null, ...extra,
    });
    if (checkpoint.final !== null) {
      verifyOnDisk(FULL_MANIFEST_FILE_V1, checkpoint.final.manifest);
      // A duplicate resume produces no pair, but it still costs a full re-verification
      // of every committed page, and that cost is part of the restart budget.
      guard?.finalize({ manifestByteLength: checkpoint.final.manifest.byteLength, totalElapsedMs: performance.now() - runStartedAt });
      return result({ alreadyFinal: true, pagesProduced: 0, manifestSha256: checkpoint.final.manifest.sha256, manifestByteLength: checkpoint.final.manifest.byteLength });
    }

    const writeOrVerify = (file, bytes, digest) => {
      const destination = path.join(outputRoot, file);
      if (fs.existsSync(destination)) {
        const existing = fs.readFileSync(destination);
        counters.sha256Computations += 1;
        if (existing.length !== digest.byteLength || sha256Bytes(existing) !== digest.sha256) failClosed('DIVERGENT_PAGE_BYTES_REFUSED', { file });
        counters.existingVerified += 1;
        return;
      }
      durableReplaceFileSync(destination, bytes);
      counters.fileWrites += 1;
      counters.bytesWritten += bytes.length;
    };
    const digestOf = (bytes) => { counters.sha256Computations += 1; return { sha256: sha256Bytes(bytes), byteLength: bytes.length }; };

    let current = null;
    let pagesProduced = 0;
    const finishPage = () => {
      const { page, records, provenance, startedAt } = current;
      const ensembleBytes = serializeEnsemblePage({ context, page, records });
      counters.pageSerializations += 1;
      const ensemble = digestOf(ensembleBytes);
      writeOrVerify(pageFileName('ENSEMBLE', page.pageNumber), ensembleBytes, ensemble);
      fault('AFTER_ENSEMBLE_PAGE', page.pageNumber);
      const provenanceBytes = serializeProvenancePage({ context, page, records: provenance, pairedEnsemblePage: ensemble });
      counters.pageSerializations += 1;
      const provenanceDigest = digestOf(provenanceBytes);
      writeOrVerify(pageFileName('PROVENANCE', page.pageNumber), provenanceBytes, provenanceDigest);
      fault('AFTER_PROVENANCE_PAGE', page.pageNumber);
      // THE BUDGET IS TESTED BEFORE THE PAIR IS COMMITTED, NOT AFTER. A breach noticed
      // after the commit has already spent what the limit existed to bound, and the
      // next resume would walk straight back into it from a committed frontier.
      const pairSerializedBytes = ensemble.byteLength + provenanceDigest.byteLength;
      const pageElapsedMs = performance.now() - startedAt;
      guard?.beforePair({ pageNumber: page.pageNumber, pairSerializedBytes, pageElapsedMs });
      const committedAt = performance.now();
      checkpoint.commitPair({ pageNumber: page.pageNumber, ensemble, provenance: provenanceDigest });
      const checkpointMs = performance.now() - committedAt;
      fault('AFTER_PAIR_COMMIT', page.pageNumber);
      guard?.afterPair({ pairSerializedBytes, pagePairMs: pageElapsedMs, checkpointMs });
      pagesProduced += 1;
      pageTimingsMs.push(performance.now() - startedAt);
      producerTimeMs.push(current.producerMs);
      if (onPage) onPage({ pageNumber: page.pageNumber, ensembleByteLength: ensemble.byteLength, provenanceByteLength: provenanceDigest.byteLength, records, provenance });
      current = null;
    };

    const stats = streamVerifiedIndexRecords({
      path: sourcePath,
      counters: counters.scan,
      onRecord: (unit, sourceRecord) => {
        const page = plan.pages[Math.floor((unit.ordinal - 1) / plan.pageSize)];
        if (!page) failClosed('QUERY_CARDINALITY_MISMATCH', { ordinal: unit.ordinal });
        if ((unit.ordinal === page.firstQueryOrdinal && unit.analogueIdentityId !== page.firstAnalogueIdentityId)
          || (unit.ordinal === page.lastQueryOrdinal && unit.analogueIdentityId !== page.lastAnalogueIdentityId)) {
          failClosed('SOURCE_DRIFT_DURING_MATERIALIZATION', { ordinal: unit.ordinal });
        }
        if (page.pageNumber <= frontier) { counters.queriesSkippedAsCommitted += 1; return; }
        if (unit.ordinal === page.firstQueryOrdinal) {
          fault('BEFORE_PAIR', page.pageNumber);
          current = { page, records: new Array(page.recordCount), provenance: new Array(page.recordCount), startedAt: performance.now(), producerMs: 0 };
        }
        const slot = unit.ordinal - page.firstQueryOrdinal;
        counters.producerCalls += 1;
        const producedAt = performance.now();
        const output = producer.produce(unit, sourceRecord);
        current.producerMs += performance.now() - producedAt;
        const validated = validateQueryOutput({ unit, output, inputBinding: binding, combinationPolicyVersionId: context.combinationPolicyVersionId });
        counters.recordValidations += 1;
        current.records[slot] = validated.record;
        current.provenance[slot] = validated.provenance;
        if (unit.ordinal === page.lastQueryOrdinal) finishPage();
      },
    });
    if (stats.sha256 !== cohort.sourceSha256 || stats.queryCount !== cohort.queryCount || stats.cohortDigest !== cohort.cohortDigest) {
      failClosed('SOURCE_DRIFT_DURING_MATERIALIZATION', { reason: 'SOURCE_IDENTITY' });
    }
    if (checkpoint.committed.length !== plan.pageCount) failClosed('PAGE_PAIRS_INCOMPLETE', { committed: checkpoint.committed.length });

    const manifestBytes = serializeManifest({
      context, cohort, plan, committed: checkpoint.committed,
    });
    counters.manifestSerializations += 1;
    const manifest = digestOf(manifestBytes);
    fault('BEFORE_MANIFEST', plan.pageCount);
    writeOrVerify(FULL_MANIFEST_FILE_V1, manifestBytes, manifest);
    fault('AFTER_MANIFEST', plan.pageCount);
    checkpoint.finalize({ manifest, pageCount: plan.pageCount });
    guard?.finalize({ manifestByteLength: manifest.byteLength, totalElapsedMs: performance.now() - runStartedAt });
    return result({ alreadyFinal: false, pagesProduced, manifestSha256: manifest.sha256, manifestByteLength: manifest.byteLength });
  } finally {
    checkpoint.release();
  }
}

/* ------------------------------------------------------- PREBUILD rehearsal */

export const REHEARSAL_SOURCE_LABEL_V1 = 'SYNTHETIC:GATE26_PREBUILD_REHEARSAL_SOURCE_V1';
export const REHEARSAL_PRODUCER_ID_V1 = 'GATE26_PREBUILD_SYNTHETIC_SELECTION_PRODUCER_V1';
export const REHEARSAL_OUTCOME_SOURCE_ID_V1 = 'GATE26_PREBUILD_SYNTHETIC_OUTCOME_SOURCE_V1';
export const REHEARSAL_DEFAULT_QUERY_COUNT_V1 = 2002;
export const REHEARSAL_MAX_PREFIX_GROUP_SIZE_V1 = 128;
export const REHEARSAL_GROUP_SIZE_CYCLE_V1 = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
export const REHEARSAL_MINI_EVIDENCE_V1 = Object.freeze([
  Object.freeze({ path: 'data/jarvise/predictive-ensemble/GATE26/V1/MINI/PROVENANCE.json', sha256: 'f01508f16f438fd59cd6e7d5aee758cfac32320d688adcf5829f7738c4053782' }),
  Object.freeze({ path: 'data/jarvise/predictive-ensemble/GATE26/V1/MINI/SIZE_MEASUREMENT.json', sha256: '5f38c56cf9a334b4521aa07da5bdabf068d3806c9e38cad462d3335a03d0ad5d' }),
]);
const HORIZON_CONTRACT_V1 = Object.freeze({
  path: 'governance/gates/GATE22/contracts/GATE22_TEMPORAL_HORIZON_V1.json', sha256: 'c53ec179919f90593efdaad625187bc56218a4615bd7d0cecb415a27d4b55783',
});

function readPinnedBytes(root, { path: file, sha256 }) {
  const bytes = fs.readFileSync(path.resolve(root, file));
  if (sha256Bytes(bytes) !== sha256) failClosed('REHEARSAL_SEED_SHA256_MISMATCH', { path: file });
  return bytes;
}

/** Real, pinned seed material only: the MINI input binding and regime vocabulary, and the GATE22 horizons. */
export function loadRehearsalSeed({ root = REPOSITORY_ROOT } = {}) {
  const miniProvenance = JSON.parse(readPinnedBytes(root, REHEARSAL_MINI_EVIDENCE_V1[0]).toString('utf8'));
  const miniSize = JSON.parse(readPinnedBytes(root, REHEARSAL_MINI_EVIDENCE_V1[1]).toString('utf8'));
  const horizonContract = JSON.parse(readPinnedBytes(root, HORIZON_CONTRACT_V1).toString('utf8'));
  const seedFactors = miniProvenance.records.find((record) => record.regimeBinding.factors.length > 0)?.regimeBinding.factors[0].commonFactors;
  if (!seedFactors || !sameList(seedFactors.map((factor) => factor.dimensionId), CORE_V1_DIMENSIONS_V1)) failClosed('REHEARSAL_SEED_INVALID');
  return Object.freeze({
    inputBinding: validateInputBinding(miniProvenance.inputBinding),
    seedFactors: seedFactors.map((factor) => ({ dimensionId: factor.dimensionId, value: factor.value })),
    horizonContract,
    miniSizeMeasurement: miniSize,
    evidence: REHEARSAL_MINI_EVIDENCE_V1.map((entry) => ({ ...entry })),
  });
}

const DAY_MS = 86400000;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const syntheticId = (...parts) => sha256Canonical({ rehearsal: 'GATE26_PREBUILD_REHEARSAL_V1', parts });

/**
 * A bounded synthetic cohort in the exact published GATE25 ANALOGUE_INDEX byte format.
 * Groups are fixture-declared analogue prefix cohorts: member j of a group has the j
 * earlier members as its selected analogues. One group is the max-prefix group.
 */
export function buildSyntheticRehearsalSource({
  seed, queryCount = REHEARSAL_DEFAULT_QUERY_COUNT_V1, maxPrefixGroupSize = REHEARSAL_MAX_PREFIX_GROUP_SIZE_V1,
  groupSizeCycle = REHEARSAL_GROUP_SIZE_CYCLE_V1,
}) {
  if (!Number.isInteger(queryCount) || queryCount < 1 || queryCount > PREBUILD_REHEARSAL_MAX_QUERY_COUNT_V1) {
    failClosed('PREBUILD_REHEARSAL_COHORT_NOT_BOUNDED', { queryCount });
  }
  const { inputBinding, seedFactors } = seed;
  const sizes = [];
  let remaining = queryCount;
  for (let cycle = -1; remaining > 0; cycle += 1) {
    const size = Math.min(cycle < 0 ? maxPrefixGroupSize : groupSizeCycle[cycle % groupSizeCycle.length], remaining);
    sizes.push(size);
    remaining -= size;
  }
  const regimeValues = [['BULL', 'BEAR', 'TRANSITION'], ['NORMAL', 'VOLATILE', 'EXTREME']];
  const records = [];
  const cohorts = new Map();
  const byId = new Map();
  let maxAnalogueCount = 0;
  sizes.forEach((size, group) => {
    const factors = seedFactors.map((factor, index) => ({
      dimensionId: factor.dimensionId,
      value: index < 2 ? regimeValues[index][(index === 0 ? group : Math.floor(group / 3)) % 3] : factor.value,
    }));
    const coreV1 = Object.fromEntries(factors.map((factor) => [factor.dimensionId, factor.value]));
    const members = new Array(size);
    for (let position = 0; position < size; position += 1) {
      const sessionDate = addDays('2015-01-05', group * 3 + position * 7);
      const knowledgeCutoff = `${sessionDate}T20:00:00.000Z`;
      const regimeRecordId = syntheticId('regime-record', group, position);
      const featureSource = syntheticId('feature-source', group, position);
      const identity = createAnalogueIdentity({
        InstrumentIdentityId: `sha256:${syntheticId('instrument', group)}`,
        SessionDate: sessionDate,
        KnowledgeCutoff: knowledgeCutoff,
        FeatureVectorBindingId: syntheticId('feature-vector', group, position),
        RegimeRecordId: regimeRecordId,
        RegimeHorizonSpecId: syntheticId('regime-horizon-spec'),
        MacroContextBindingId: syntheticId('macro-context'),
        SelectionPolicyVersionId: inputBinding.selectionPolicyVersionId,
        EligibleHistoryPinSetId: inputBinding.datasetId,
        PriceBasisId: 'SPLIT_ADJUSTED',
        MissingnessStateId: missingnessStateId('COMPLETE'),
      });
      const rawValue = (window) => ((group * 37 + position * 11 + window) % 200 - 100) / 1000;
      const record = buildIndexRecord({
        identity,
        p3hKeyId: `SYNTHETIC_EOD/G${group}/${syntheticId('key', group)}`,
        regime: { coreV1 },
        features: {
          records: {
            'F1_SIMPLE_RETURN@W5': { featureRecordId: syntheticId('feature', group, position, 5), status: 'RESOLVED', code: null, rawValue: rawValue(5) },
            'F1_SIMPLE_RETURN@W21': { featureRecordId: syntheticId('feature', group, position, 21), status: 'RESOLVED', code: null, rawValue: rawValue(21) },
          },
        },
        inputProofs: [
          { inputId: 'F1_SIMPLE_RETURN@W5', sourceArtifactId: `sha256:${featureSource}`, sourceArtifactSha256: featureSource, availableAt: knowledgeCutoff },
          { inputId: 'F1_SIMPLE_RETURN@W21', sourceArtifactId: `sha256:${featureSource}`, sourceArtifactSha256: featureSource, availableAt: knowledgeCutoff },
          { inputId: 'GATE24_REGIME_RECORD', sourceArtifactId: `GATE24_RegimeRecord/1:${regimeRecordId}`, sourceArtifactSha256: syntheticId('regime-bytes', group, position), availableAt: knowledgeCutoff },
        ],
      });
      const entry = { analogueIdentityId: identity.analogueIdentityId, knowledgeCutoff, inputProofs: record.inputProofs, group, position };
      members[position] = entry;
      byId.set(entry.analogueIdentityId, entry);
      records.push(record);
    }
    for (let position = 0; position < size; position += 1) {
      const analogues = new Array(position);
      for (let rank = 0; rank < position; rank += 1) analogues[rank] = members[position - 1 - rank];
      cohorts.set(members[position].analogueIdentityId, { group, position, analogues, commonFactors: factors });
      if (position > maxAnalogueCount) maxAnalogueCount = position;
    }
  });
  const index = appendIndexRecords(createAnalogueIndex({ datasetId: inputBinding.datasetId, selectionPolicyVersionId: inputBinding.selectionPolicyVersionId }), records);
  const sourceBytes = Buffer.from(serializeAnalogueIndex(index), 'utf8');
  return {
    sourceBytes,
    sourceSha256: sha256Bytes(sourceBytes),
    queryCount,
    cohorts,
    byId,
    groups: { count: sizes.length, maxPrefixGroupSize: sizes[0], sizeCycle: [...groupSizeCycle] },
    maxAnalogueCount,
    totalAnalogueCount: [...cohorts.values()].reduce((sum, entry) => sum + entry.analogues.length, 0),
  };
}

/**
 * The rehearsal producer: GATE25 freezeSelection -> attachPostSelectionOutcomes (real
 * causal outcome cutoff) -> GATE26 combineFrozenSelection (real V1 engine). The only
 * synthetic part is the outcome source; its values never reach an identity.
 */
export function createSyntheticSelectionProducer({ root = REPOSITORY_ROOT, fixture, seed }) {
  const miniAuthority = loadGate26MiniBuildAuthority({ root });
  const horizonBindings = admissibleHorizonBindings({ horizonContract: seed.horizonContract, calendarRegistryManifestId: seed.inputBinding.calendarRegistryManifestId });
  const outcomeSource = {
    sourceBindingId: REHEARSAL_OUTCOME_SOURCE_ID_V1,
    lookup({ analogueIdentityId, horizonId }) {
      const analogue = fixture.byId.get(analogueIdentityId);
      if (!analogue) failClosed('REHEARSAL_OUTCOME_ANALOGUE_UNKNOWN');
      const draw = parseInt(syntheticId('outcome', analogueIdentityId, horizonId).slice(0, 8), 16);
      if (draw % 5 === 0) return null;
      const sessionCount = Number(horizonId.split(':')[0]);
      return {
        outcomeValue: ((draw % 2001) - 1000) / 10000,
        outcomeAvailableAt: new Date(Date.parse(analogue.knowledgeCutoff) + Math.ceil((sessionCount * 7) / 5) * DAY_MS).toISOString(),
      };
    },
  };
  const proof = (inputId, source, knowledgeCutoff) => buildInputProof({
    inputId, sourceArtifactId: source.sourceArtifactId, sourceArtifactSha256: source.sourceArtifactSha256, availableAt: source.availableAt, knowledgeCutoff,
  });
  return {
    producerId: REHEARSAL_PRODUCER_ID_V1,
    producerCodeSha256: sha256Canonical({ producerId: REHEARSAL_PRODUCER_ID_V1, sourceSha256: fixture.sourceSha256, outcomeSource: REHEARSAL_OUTCOME_SOURCE_ID_V1 }),
    // Declared, not inferred. This producer's outcome source is synthetic, and saying
    // so here is what lets the boundary refuse it under a real execution intent
    // instead of relying on the absence of a field.
    synthetic: true,
    productionClass: 'PREBUILD_SYNTHETIC',
    produce(unit, sourceRecord) {
      const entry = fixture.cohorts.get(unit.analogueIdentityId);
      if (!entry) failClosed('REHEARSAL_COHORT_ENTRY_ABSENT', { ordinal: unit.ordinal });
      const rankedAnalogues = entry.analogues.map((analogue, index) => ({ rank: index + 1, analogueIdentityId: analogue.analogueIdentityId, finalDistance: (index + 1) / 64 }));
      const frozenSelection = freezeSelection({ queryIdentityId: unit.analogueIdentityId, rankedAnalogues });
      const outcomeSet = attachPostSelectionOutcomes({ frozenSelection, horizonBindings, outcomeSource, queryKnowledgeCutoff: unit.knowledgeCutoff });
      const eligibleCount = rankedAnalogues.length;
      const supportStatus = eligibleCount >= SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1 ? 'SUFFICIENT_SUPPORT' : 'INSUFFICIENT_SUPPORT';
      const supportReport = {
        decision: supportStatus === 'SUFFICIENT_SUPPORT' ? 'PROCEED' : 'ABSTAIN', supportStatus, eligibleCount, excludedCount: fixture.queryCount - 1 - eligibleCount,
      };
      const selection = {
        query: { knowledgeCutoff: unit.knowledgeCutoff },
        queryIdentity: { analogueIdentityId: sourceRecord.analogueIdentityId, orderedMembers: sourceRecord.orderedMembers },
        comparisonReport: {
          queryIdentityId: unit.analogueIdentityId,
          datasetId: identityMemberValue(sourceRecord.orderedMembers, 'EligibleHistoryPinSetId'),
          selectionPolicyVersionId: identityMemberValue(sourceRecord.orderedMembers, 'SelectionPolicyVersionId'),
          analogues: entry.analogues.map((analogue) => ({ analogueIdentityId: analogue.analogueIdentityId, commonFactors: entry.commonFactors })),
        },
        frozenSelection,
        outcomeSet,
        supportReport,
        supportReportId: sha256Canonical({ report: 'SYNTHETIC_SUPPORT_REPORT', queryIdentityId: unit.analogueIdentityId, supportReport }),
        horizonBindings,
        inputProofs: [
          ...sourceRecord.inputProofs.map((source) => proof(`QUERY:${source.inputId}`, source, unit.knowledgeCutoff)),
          ...entry.analogues.flatMap((analogue) => analogue.inputProofs.map((source) => proof(`${analogue.analogueIdentityId}:${source.inputId}`, source, analogue.knowledgeCutoff))),
        ],
      };
      const combined = combineFrozenSelection({ authority: miniAuthority, selection, inputBinding: seed.inputBinding });
      return { ensembleRecord: buildEnsembleIndexRecord(combined), provenanceRecord: combined.provenance };
    },
  };
}

class SimulatedCrash extends Error {
  constructor(point, pageNumber) { super(`SIMULATED_CRASH:${point}:${pageNumber}`); this.code = 'SIMULATED_CRASH'; this.point = point; this.pageNumber = pageNumber; }
}
export const simulatedCrashAt = (point, pageNumber) => (at, page) => { if (at === point && page === pageNumber) throw new SimulatedCrash(at, page); };

/** Builds the synthetic source on disk (off-repository) and derives its cohort exactly like the canonical one. */
export function prepareRehearsalCohort({
  root = REPOSITORY_ROOT, workRoot, queryCount = REHEARSAL_DEFAULT_QUERY_COUNT_V1, maxPrefixGroupSize = REHEARSAL_MAX_PREFIX_GROUP_SIZE_V1,
  seed = loadRehearsalSeed({ root }), retainUnits = false,
}) {
  const authority = loadFullPrebuildAuthority({ root });
  if (resolvesInside(root, workRoot)) failClosed('PREBUILD_OUTPUT_INSIDE_REPOSITORY_FORBIDDEN');
  const fixture = buildSyntheticRehearsalSource({ seed, queryCount, maxPrefixGroupSize });
  const sourcePath = path.join(workRoot, 'source', 'SYNTHETIC_ANALOGUE_INDEX.json');
  durableReplaceFileSync(sourcePath, fixture.sourceBytes);
  const cohort = deriveQueryCohort({
    path: sourcePath, sourceLabel: REHEARSAL_SOURCE_LABEL_V1, expectedSha256: fixture.sourceSha256, expectedQueryCount: queryCount,
    expectedDatasetId: seed.inputBinding.datasetId, pageSize: authority.pageSize, retainUnits,
  });
  return { authority, seed, fixture, sourcePath, cohort, producer: createSyntheticSelectionProducer({ root, fixture, seed }) };
}

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.ceil(fraction * sortedAscending.length) - 1)];
}

function directoryBytes(directory) {
  let total = 0;
  let files = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { total += fs.statSync(full).size; files += 1; }
    }
  }
  return { bytes: total, files };
}

function freeBytes(directory) {
  try { const stats = fs.statfsSync(directory); return stats.bavail * stats.bsize; } catch { return null; }
}

function gitReadOnly(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (error) { return `UNAVAILABLE:${error.code ?? error.status}`; }
}

/** Least squares bytes = intercept + slope * analogueCount. */
function linearFit(points) {
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  const sxx = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const sxy = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residualMax = points.reduce((max, point) => Math.max(max, Math.abs(point.y - (intercept + slope * point.x))), 0);
  return { intercept: Math.round(intercept), bytesPerAnalogue: Math.round(slope * 100) / 100, maxAbsResidualBytes: Math.round(residualMax) };
}

/**
 * The bounded PREBUILD rehearsal: continuous run, crash + resume run, byte comparison,
 * duplicate resume, bounded consumption and measurements. Everything is written under
 * `workRoot` (off-repository) and removed at the end; the report is returned.
 */
export async function runPrebuildRehearsal({
  root = REPOSITORY_ROOT, workRoot, queryCount = REHEARSAL_DEFAULT_QUERY_COUNT_V1, crash = { point: 'AFTER_ENSEMBLE_PAGE', pageNumber: 7 },
  networkCalls = null,
}) {
  const { consumeFullProductDirectory } = await import('./full-consumer-v1.mjs');
  const startedAt = performance.now();
  const freeBefore = { temp: freeBytes(os.tmpdir()), repository: freeBytes(root) };
  const memory = { heapUsedPeak: 0, externalPeak: 0, arrayBuffersPeak: 0, rssPeakSampled: 0 };
  const sample = () => {
    const usage = process.memoryUsage();
    memory.heapUsedPeak = Math.max(memory.heapUsedPeak, usage.heapUsed);
    memory.externalPeak = Math.max(memory.externalPeak, usage.external);
    memory.arrayBuffersPeak = Math.max(memory.arrayBuffersPeak, usage.arrayBuffers);
    memory.rssPeakSampled = Math.max(memory.rssPeakSampled, usage.rss);
  };
  sample();
  const prepared = prepareRehearsalCohort({ root, workRoot, queryCount, retainUnits: true });
  const { authority, seed, fixture, sourcePath, cohort, producer } = prepared;
  const run = (name, extra = {}) => runPagedMaterialization({
    root, sourcePath, cohort, producer, inputBinding: seed.inputBinding,
    outputRoot: path.join(workRoot, name, 'product'), checkpointRoot: path.join(workRoot, name, 'checkpoint'), onPage: sample, ...extra,
  });

  const recordSizes = [];
  const continuous = run('continuous', {
    onPage: (page) => {
      sample();
      page.records.forEach((record, index) => recordSizes.push({
        decision: record.decision,
        reason: record.abstention.reason,
        analogueCount: page.provenance[index].analogueIdentityIds.length,
        ensembleBytes: Buffer.byteLength(canonicalize(record), 'utf8'),
        provenanceBytes: Buffer.byteLength(canonicalize(page.provenance[index]), 'utf8'),
      }));
    },
  });
  sample();

  let crashObserved = null;
  try { run('resumed', { faultInjector: simulatedCrashAt(crash.point, crash.pageNumber) }); } catch (error) {
    if (error.code !== 'SIMULATED_CRASH') throw error;
    crashObserved = { point: error.point, pageNumber: error.pageNumber };
  }
  if (crashObserved === null) failClosed('REHEARSAL_CRASH_NOT_OBSERVED');
  const resumed = run('resumed');
  const duplicate = run('continuous');
  sample();

  const continuousFiles = fs.readdirSync(path.join(workRoot, 'continuous', 'product'));
  const resumedFiles = fs.readdirSync(path.join(workRoot, 'resumed', 'product'));
  const byteIdentical = continuousFiles.length === resumedFiles.length && continuousFiles.every((file) => resumedFiles.includes(file)
    && sha256Bytes(fs.readFileSync(path.join(workRoot, 'continuous', 'product', file))) === sha256Bytes(fs.readFileSync(path.join(workRoot, 'resumed', 'product', file))));
  if (!byteIdentical || continuous.manifestSha256 !== resumed.manifestSha256) failClosed('REHEARSAL_RESUME_NOT_BYTE_IDENTICAL');

  const consumeStarted = performance.now();
  const consumption = consumeFullProductDirectory({
    productRoot: path.join(workRoot, 'continuous', 'product'),
    expectedManifestSha256: continuous.manifestSha256,
    expectedCombinationPolicyVersionId: loadGate26MiniBuildAuthority({ root }).policy.combinationPolicyVersionId,
    expectedCohortDigest: cohort.cohortDigest,
    expectedQueryCount: cohort.queryCount,
    collectQueryIds: true,
    onPage: sample,
  });
  const consumeMs = performance.now() - consumeStarted;
  const consumedInCohortOrder = consumption.queryIds.length === cohort.units.length
    && consumption.queryIds.every((id, index) => id === cohort.units[index].analogueIdentityId);
  if (!consumedInCohortOrder) failClosed('REHEARSAL_CONSUMPTION_COHORT_MISMATCH');

  const retainedInEngineCache = consumption.ensembleIdentityIds.filter((id) => readEnsembleCache(id) !== null).length;
  const pageOne = path.join(workRoot, 'continuous', 'product', pageFileName('ENSEMBLE', 1));
  const lfsPointer = gitReadOnly(root, ['lfs', 'pointer', `--file=${pageOne}`]);
  const pointerOid = /oid sha256:([0-9a-f]{64})/.exec(lfsPointer)?.[1] ?? null;
  const checkAttr = gitReadOnly(root, ['check-attr', 'filter', 'diff', 'merge', 'text', '--', `${authority.fullProductRoot}/${FULL_MANIFEST_FILE_V1}`, `${authority.fullProductRoot}/${pageFileName('ENSEMBLE', 1)}`]);
  const temporary = directoryBytes(workRoot);
  const products = directoryBytes(path.join(workRoot, 'continuous', 'product'));
  sample();

  const timings = [...continuous.pageTimingsMs];
  const ascending = timings.slice(0).sort((left, right) => left - right);
  const producerAscending = continuous.producerTimeMs.slice(0).sort((left, right) => left - right);
  const overheadMs = timings.map((value, index) => value - continuous.producerTimeMs[index]).sort((left, right) => left - right);
  const ensembleMean = recordSizes.reduce((sum, row) => sum + row.ensembleBytes, 0) / recordSizes.length;
  const ensembleMax = recordSizes.reduce((max, row) => Math.max(max, row.ensembleBytes), 0);
  const provenanceFit = linearFit(recordSizes.map((row) => ({ x: row.analogueCount, y: row.provenanceBytes })));
  const ensembleFit = linearFit(recordSizes.map((row) => ({ x: row.analogueCount, y: row.ensembleBytes })));
  const recordBytesTotal = recordSizes.reduce((sum, row) => sum + row.ensembleBytes + row.provenanceBytes, 0);
  const envelopeBytesPerPagePair = Math.ceil((products.bytes - recordBytesTotal - continuous.manifestByteLength) / continuous.pageCount);
  const manifestBytesPerPage = Math.ceil(continuous.manifestByteLength / continuous.pageCount);
  const Q = authority.queryCount;
  const P = authority.pageCount;
  const projection = (meanAnalogueCount) => {
    const ensembleBytes = Math.round(Q * (ensembleFit.intercept + ensembleFit.bytesPerAnalogue * meanAnalogueCount) + P * Math.ceil(envelopeBytesPerPagePair / 2));
    const provenanceBytes = Math.round(Q * (provenanceFit.intercept + provenanceFit.bytesPerAnalogue * meanAnalogueCount) + P * Math.ceil(envelopeBytesPerPagePair / 2));
    const manifestBytes = P * manifestBytesPerPage;
    return { meanAnalogueCount, ensembleBytes, provenanceBytes, manifestBytes, totalBytes: ensembleBytes + provenanceBytes + manifestBytes };
  };
  const existing = seed.miniSizeMeasurement.fullBuildProjection;
  const decisions = {};
  for (const row of recordSizes) decisions[`${row.decision}:${row.reason ?? 'NONE'}`] = (decisions[`${row.decision}:${row.reason ?? 'NONE'}`] ?? 0) + 1;
  const usage = process.resourceUsage();
  const materializationOverheadP50 = percentile(overheadMs, 0.5);

  fs.rmSync(workRoot, { recursive: true, force: true });
  const freeAfter = { temp: freeBytes(os.tmpdir()), repository: freeBytes(root) };
  return {
    schema: 'GATE26_FULL_PREBUILD_REHEARSAL_REPORT_V1',
    authority: {
      contractRevision: authority.contract.revision,
      contractSha256: authority.contract.sha256,
      productFilesAuthorized: authority.productFilesAuthorized,
      fullProductionAuthorized: authority.fullProductionAuthorized,
      fullProductRoot: authority.fullProductRoot,
      fullProductBytesCreated: fs.existsSync(path.resolve(root, authority.fullProductRoot)),
    },
    rehearsalInput: {
      kind: 'BOUNDED_SYNTHETIC_SEEDED_BY_EXISTING_MINI_EVIDENCE',
      miniEvidence: seed.evidence,
      horizonContract: { ...HORIZON_CONTRACT_V1 },
      publishedGate25AnalogueIndexRead: false,
      yahoo: false,
      network: { trapInstalled: networkCalls !== null, attemptedCalls: networkCalls ? [...networkCalls] : null },
      producer: {
        producerId: producer.producerId,
        pipeline: ['GATE25.freezeSelection', 'GATE25.attachPostSelectionOutcomes', 'GATE26.combineFrozenSelection', 'GATE26.buildEnsembleIndexRecord'],
        syntheticParts: ['ANALOGUE_INDEX_RECORDS', 'PREFIX_ANALOGUE_COHORTS', 'OUTCOME_SOURCE'],
      },
    },
    syntheticCohort: {
      sourceLabel: cohort.sourceLabel,
      sourceSha256: cohort.sourceSha256,
      sourceByteLength: cohort.sourceByteLength,
      queryCount: cohort.queryCount,
      cohortDigest: cohort.cohortDigest,
      pageSize: cohort.plan.pageSize,
      pageCount: cohort.plan.pageCount,
      lastPageRecordCount: cohort.plan.lastPageRecordCount,
      groups: fixture.groups,
      maxAnalogueCount: fixture.maxAnalogueCount,
      meanAnalogueCount: Math.round((fixture.totalAnalogueCount / fixture.queryCount) * 1000) / 1000,
      decisions,
    },
    determinism: {
      manifestSha256: continuous.manifestSha256,
      manifestByteLength: continuous.manifestByteLength,
      productFileCount: continuousFiles.length,
      crashInjected: crashObserved,
      resumedFromCommittedPairs: resumed.committedAtStart,
      resumedFrontierPageReusedIdentical: resumed.counters.existingVerified,
      continuousVsResumedByteIdentical: byteIdentical,
      duplicateResume: { alreadyFinal: duplicate.alreadyFinal, fileWrites: duplicate.counters.fileWrites, producerCalls: duplicate.counters.producerCalls, checkpointRevisionWrites: duplicate.checkpointRevisionWrites },
      codeIdentitySha256: continuous.codeIdentitySha256,
    },
    consumption: {
      pagesVerified: consumption.pagesVerified,
      recordsVerified: consumption.recordsVerified,
      everyQueryExactlyOnceInCohortOrder: consumedInCohortOrder,
      decisions: consumption.decisions,
      maxBytesHeldAtOnce: consumption.maxBytesHeldAtOnce,
      largestPagePairBytes: consumption.largestPagePairBytes,
      wallMs: Math.round(consumeMs),
    },
    performance: {
      peakRssBytes: usage.maxRSS * 1024,
      rssPeakSampledBytes: memory.rssPeakSampled,
      heapUsedPeakBytes: memory.heapUsedPeak,
      externalPeakBytes: memory.externalPeak,
      arrayBuffersPeakBytes: memory.arrayBuffersPeak,
      pagePairTimeMs: { p50: percentile(ascending, 0.5), p95: percentile(ascending, 0.95), max: ascending.at(-1) },
      producerTimePerPageMs: { p50: percentile(producerAscending, 0.5), p95: percentile(producerAscending, 0.95), max: producerAscending.at(-1) },
      materializationOverheadPerPageMs: { p50: materializationOverheadP50, p95: percentile(overheadMs, 0.95), max: overheadMs.at(-1) },
      operationCounts: {
        continuous: continuous.counters,
        resumed: resumed.counters,
        duplicateResume: duplicate.counters,
      },
      temporaryDisk: temporary,
      productBytesForSyntheticCohort: products,
      freeDiskBefore: freeBefore,
      freeDiskAfter: freeAfter,
      rehearsalWallMs: Math.round(performance.now() - startedAt),
      engineCacheRetainedPayloads: retainedInEngineCache,
    },
    sizeModel: {
      method: 'CanonicalJSON/1 UTF-8 bytes of every record in the rehearsal pages; least squares on analogue count',
      ensembleRecordBytes: { mean: Math.round(ensembleMean), max: ensembleMax, fit: ensembleFit },
      provenanceRecordBytes: provenanceFit,
      envelopeBytesPerPagePair,
      manifestBytesPerPage,
    },
    fullProjection: {
      Q,
      P,
      basis: 'record bytes are linear in the per-query analogue count A; the FULL A distribution is not observable in PREBUILD without the published index',
      scenarios: [0, 1.5, 3, 10, 32].map(projection),
      existingProjection: {
        source: REHEARSAL_MINI_EVIDENCE_V1[1].path,
        ensembleIndexBytes: existing.projectedEnsembleIndexBytes,
        provenanceBytesAtMiniMaxAnalogueCount: existing.projectedProvenanceBytesAtMiniMaxAnalogueCount,
        totalBytes: existing.projectedEnsembleIndexBytes + existing.projectedProvenanceBytesAtMiniMaxAnalogueCount,
      },
    },
    lfs: {
      gitLfsVersion: gitReadOnly(root, ['lfs', 'version']),
      checkAttr: checkAttr.split(/\r?\n/),
      pointerOidOfRehearsalPage: pointerOid,
      rehearsalPageSha256: consumption.firstEnsemblePageSha256,
      pointerOidEqualsContentSha256: pointerOid !== null && pointerOid === consumption.firstEnsemblePageSha256,
      pointerWrittenAnywhere: false,
    },
    runtimeEstimate: {
      materializationOverheadMsForFullPlan: materializationOverheadP50 === null ? null : Math.round(materializationOverheadP50 * P),
      rehearsalProducerMsPerQuery: Math.round((continuous.producerTimeMs.reduce((sum, value) => sum + value, 0) / cohort.queryCount) * 1000) / 1000,
      realProducerComputeMeasured: false,
      note: 'Page, hash, write and checkpoint overhead are measured. The Phase D producer (P3H outcome attachment, O(A x H) per query) is not executed under R0003.',
    },
    residue: {
      workRootRemoved: !fs.existsSync(workRoot),
      checkpointResidueRemovedDuringResume: resumed.residueRemoved,
    },
    closure: { agentClosureExecuted: false, externalConfirmationExecuted: false, independentAuditPassAssigned: false, phaseDAuthorized: false },
  };
}

/** CLI body. Runs after this module finished evaluating, so the consumer's static import of it resolves. */
async function rehearseFromCli() {
  const { installNetworkTrap } = await import('./mini-fixture-v1.mjs');
  const networkCalls = installNetworkTrap();
  const workRoot = path.join(os.tmpdir(), 'wheel-gee', `gate26-prebuild-rehearsal-${process.pid}`);
  const authority = loadFullPrebuildAuthority({ root: REPOSITORY_ROOT });
  const report = await runPrebuildRehearsal({ root: REPOSITORY_ROOT, workRoot, networkCalls });
  const reportPath = path.resolve(REPOSITORY_ROOT, authority.rehearsalReportPath);
  durableReplaceFileSync(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
  const residue = sweepPublicationResidue([reportPath]);
  process.stdout.write(`${JSON.stringify({ written: authority.rehearsalReportPath, sha256: sha256Bytes(fs.readFileSync(reportPath)), residue, networkCalls, determinism: report.determinism, performance: { peakRssBytes: report.performance.peakRssBytes, pagePairTimeMs: report.performance.pagePairTimeMs } }, null, 2)}\n`);
  if (networkCalls.length > 0 || report.authority.fullProductBytesCreated) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv.includes('--rehearse')) {
    process.stdout.write('usage: full-paged-materializer-v1.mjs --rehearse   (bounded synthetic PREBUILD rehearsal; writes only the PREBUILD rehearsal report)\n');
    process.exitCode = 2;
  } else {
    rehearseFromCli().catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n${JSON.stringify(error?.details ?? null)}\n`);
      process.exitCode = 1;
    });
  }
}
