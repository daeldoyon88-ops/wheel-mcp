/**
 * GATE26 FULL real production producer V1.
 *
 * The expensive historical preparation is performed once.  Query execution uses
 * the published GATE25 index grouped by the exact eligibility keys, attaches P3H
 * outcomes only after the selection is frozen, and delegates the final record to
 * combineFrozenSelection.  This module has no network, Yahoo or broker adapter.
 * R0003 still forbids canonical FULL output; runRealBoundedPilot writes only to an
 * explicitly supplied off-repository evidence root.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { durableReplaceFileSync } from '../../../tools/durable-write.mjs';
import { simpleReturn } from '../../GATE23/implementation/feature-families-v1.mjs';
import { isClassifyingValue } from '../../GATE24/implementation/regime-taxonomy-v1.mjs';
import { SESSION_KINDS_V1 } from '../../GATE22/implementation/temporal-horizon-v1.mjs';
import {
  CORE_V1_DIMENSIONS_V1,
  ELIGIBILITY_EXCLUSION_REASONS_V1,
  coreV1Signature,
  historicallyCausal,
  readHistoricalCandidate,
} from '../../GATE25/implementation/analogue-eligibility-v1.mjs';
import {
  DISTANCE_FEATURE_IDS_V1,
  computeDistanceEvidence,
  computeNormalizationBounds,
} from '../../GATE25/implementation/analogue-distance-v1.mjs';
import {
  ANALOGUE_INDEX_SCHEMA_V1,
  INDEX_PAGE_SIZE_V1,
  compareCodeUnits,
  rankQueryResults,
} from '../../GATE25/implementation/analogue-index-v1.mjs';
import { identityMemberValue, verifyAnalogueIdentity } from '../../GATE25/implementation/analogue-identity-v1.mjs';
import { admissibleHorizonBindings, attachPostSelectionOutcomes, freezeSelection } from '../../GATE25/implementation/analogue-outcome-v1.mjs';
import { buildInputProof } from '../../GATE25/implementation/analogue-provenance-v1.mjs';
import { buildComparisonReport, buildSupportReport } from '../../GATE25/implementation/analogue-report-v1.mjs';
import {
  bindPublishedHistoricalRegimeFoundation,
  bindR0003SelectionPolicy,
  buildP3hQuery,
  createRegistryHistoricalIdentityResolver,
  iterateP3hCandidates,
  loadGate25BuildAuthority,
  loadHistoricalWindowCalendar,
  loadP3hDatasetBinding,
  prepareP3hHistoricalUniverse,
  runAnalogueSelection,
} from '../../GATE25/implementation/historical-analogue-engine-v1.mjs';
import { assertClosedKeys, failClosed } from './ensemble-identity-v1.mjs';
import { buildEnsembleIndexRecord, validateInputBinding } from './ensemble-provenance-v1.mjs';
import {
  combineFrozenSelection,
  ensembleCacheSize,
  loadGate26MiniBuildAuthority,
} from './predictive-ensemble-engine-v1.mjs';
import { streamVerifiedIndexRecords } from './full-query-cohort-v1.mjs';
// The published foundation projection primitives, imported from the same module the
// frozen GATE25 engine imports them from. GATE25 itself is untouched: this module
// calls the identical functions with identical arguments, and only changes WHEN a
// projection is computed and HOW LONG it is kept.
import {
  emitJarviseG25HistoricalRegimeRecordR1,
  projectGate25AnalogueInputsR1,
  readP3hAdmittedBarsR1,
} from '../../../../app/jarvise/jarviseG25HistoricalRegimeFoundationR1.mjs';

const REPOSITORY_ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export const REAL_PRODUCER_ID_V1 = 'GATE26_FULL_REAL_PRODUCTION_PRODUCER_V1';
export const REAL_PRODUCER_CLASS_V1 = 'REAL_PRODUCTION';
export const PRODUCER_BINDING_PATH_V1 = 'governance/gates/GATE26/contracts/GATE26_FULL_PRODUCTION_PRODUCER_V1.json';
export const RESOURCE_BUDGET_PATH_V1 = 'governance/gates/GATE26/contracts/GATE26_FULL_RESOURCE_BUDGET_V1.json';
export const CANONICAL_ANALOGUE_INDEX_PATH_V1 = 'data/jarvise/historical-analogue/GATE25/V1/ANALOGUE_INDEX.json';
export const MINI_PROVENANCE_PATH_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/MINI/PROVENANCE.json';
export const REAL_PILOT_SOURCE_LABEL_V1 = 'EXTERNAL:GATE26_PHASE_D_REAL_PRODUCER_PILOT_R1';
export const EXPECTED_SUPPORT_DISTRIBUTION_V1 = Object.freeze({
  queryCount: 68562,
  zero: 18988,
  one: 12131,
  belowTwo: 31119,
  median: 2,
  p95: 11,
  p99: 15,
  max: 27,
  worstPageNumber: 314,
  worstPageSupportSum: 531,
});

const PRODUCER_BINDING_FIELDS = Object.freeze([
  'document', 'schemaVersion', 'bindingId', 'gateId', 'producerId', 'productionClass', 'synthetic',
  'identityAlgorithm', 'dependencies', 'frozenInputs', 'bindings', 'producerIdentitySha256',
]);
const IDENTITY_ENTRY_FIELDS = Object.freeze(['path', 'sha256', 'byteLength', 'role']);
const RESOURCE_BINDING_FIELDS = Object.freeze([
  'document', 'schemaVersion', 'bindingId', 'gateId', 'status', 'source', 'limits', 'projection',
  'measurementPolicy', 'fullGenerationAuthorized',
]);
const RESOURCE_LIMIT_FIELDS = Object.freeze([
  'minimumRamFreeAtFullStartBytes', 'maximumRssBeforeNextPairBytes', 'maximumHeapUsedBytes',
  'maximumExternalBytes', 'maximumEngineCacheEntries', 'maximumSerializedPagePairBytes',
  'maximumProjectedTotalProductBytes', 'minimumDiskFreeAtFullStartBytes',
  'maximumProjectedRuntimeAfterPilotMs', 'absoluteMaximumRuntimeMs', 'maximumSinglePagePairMs',
  'maximumUniverseFullScanCount',
]);

function readJson(root, file, code) {
  try { return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8')); }
  catch (cause) { failClosed(code, { path: file, cause: cause.code ?? cause.message }); }
}

function observedIdentity(root, entry) {
  const file = path.isAbsolute(entry.path) ? entry.path : path.resolve(root, entry.path);
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (cause) { failClosed('REAL_PRODUCER_DEPENDENCY_ABSENT', { path: entry.path, cause: cause.code }); }
  return { path: entry.path, sha256: sha256Bytes(bytes), byteLength: bytes.length, role: entry.role };
}

function validateIdentityEntries(entries, code) {
  if (!Array.isArray(entries) || entries.length === 0) failClosed(code, { reason: 'EMPTY' });
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    assertClosedKeys(entry, IDENTITY_ENTRY_FIELDS, code, { index });
    if (typeof entry.path !== 'string' || entry.path.length === 0 || seen.has(entry.path)
      || !SHA256_HEX.test(entry.sha256 ?? '') || !Number.isInteger(entry.byteLength) || entry.byteLength < 1
      || typeof entry.role !== 'string' || entry.role.length === 0) {
      failClosed(code, { index, path: entry?.path ?? null });
    }
    seen.add(entry.path);
  }
}

export function loadResourceBudget({ root = REPOSITORY_ROOT } = {}) {
  const binding = readJson(root, RESOURCE_BUDGET_PATH_V1, 'RESOURCE_BUDGET_BINDING_ABSENT_OR_INVALID');
  assertClosedKeys(binding, RESOURCE_BINDING_FIELDS, 'RESOURCE_BUDGET_BINDING_NOT_CLOSED');
  if (binding.document !== 'GATE26_FULL_RESOURCE_BUDGET_BINDING' || binding.schemaVersion !== 1
    || binding.bindingId !== 'GATE26_FULL_RESOURCE_BUDGET_V1' || binding.gateId !== 'GATE26'
    || binding.source !== 'ACCEPTED_PHASE_D_PRELAUNCH_AUDIT' || binding.fullGenerationAuthorized !== false) {
    failClosed('RESOURCE_BUDGET_BINDING_INVALID');
  }
  assertClosedKeys(binding.limits, RESOURCE_LIMIT_FIELDS, 'RESOURCE_BUDGET_LIMITS_NOT_CLOSED');
  for (const field of RESOURCE_LIMIT_FIELDS) {
    if (!Number.isInteger(binding.limits[field]) || binding.limits[field] < 1) failClosed('RESOURCE_BUDGET_LIMIT_INVALID', { field });
  }
  if (binding.projection?.fullQueryCount !== 68562 || binding.projection?.fullPageCount !== 536
    || binding.projection?.pageSize !== 128
    || canonicalize(binding.projection?.horizonSessionCounts) !== canonicalize([30, 90, 180, 252])) {
    failClosed('RESOURCE_BUDGET_PROJECTION_INVALID');
  }
  if (binding.measurementPolicy?.hostObservationsAreAuthority !== false
    || binding.measurementPolicy?.stopBeforeNextPair !== true
    || binding.measurementPolicy?.thresholdLooseningInThisMission !== 'FORBIDDEN') {
    failClosed('RESOURCE_BUDGET_MEASUREMENT_POLICY_INVALID');
  }
  return Object.freeze(binding);
}

export function verifyProducerIdentity({ root = REPOSITORY_ROOT, binding = null } = {}) {
  const document = binding ?? readJson(root, PRODUCER_BINDING_PATH_V1, 'REAL_PRODUCER_BINDING_ABSENT_OR_INVALID');
  assertClosedKeys(document, PRODUCER_BINDING_FIELDS, 'REAL_PRODUCER_BINDING_NOT_CLOSED');
  if (document.document !== 'GATE26_FULL_PRODUCTION_PRODUCER_BINDING' || document.schemaVersion !== 1
    || document.bindingId !== 'GATE26_FULL_PRODUCTION_PRODUCER_V1' || document.gateId !== 'GATE26'
    || document.producerId !== REAL_PRODUCER_ID_V1 || document.productionClass !== REAL_PRODUCER_CLASS_V1
    || document.synthetic !== false || document.identityAlgorithm !== 'SHA256_CANONICAL_DEPENDENCY_SET_V1') {
    failClosed('REAL_PRODUCER_BINDING_INVALID');
  }
  validateIdentityEntries(document.dependencies, 'REAL_PRODUCER_DEPENDENCIES_INVALID');
  validateIdentityEntries(document.frozenInputs, 'REAL_PRODUCER_FROZEN_INPUTS_INVALID');
  const dependencies = document.dependencies.map((entry) => observedIdentity(root, entry));
  const frozenInputs = document.frozenInputs.map((entry) => observedIdentity(root, entry));
  for (const [declared, observed] of [...document.dependencies.map((entry, index) => [entry, dependencies[index]]),
    ...document.frozenInputs.map((entry, index) => [entry, frozenInputs[index]])]) {
    if (declared.sha256 !== observed.sha256 || declared.byteLength !== observed.byteLength) {
      failClosed('REAL_PRODUCER_DEPENDENCY_IDENTITY_MISMATCH', { path: declared.path, declared: declared.sha256, observed: observed.sha256 });
    }
  }
  const payload = {
    producerId: document.producerId,
    productionClass: document.productionClass,
    synthetic: document.synthetic,
    identityAlgorithm: document.identityAlgorithm,
    dependencies,
    frozenInputs,
    bindings: document.bindings,
  };
  const producerIdentitySha256 = sha256Canonical(payload);
  if (producerIdentitySha256 !== document.producerIdentitySha256) {
    failClosed('REAL_PRODUCER_IDENTITY_DIGEST_MISMATCH', { declared: document.producerIdentitySha256, observed: producerIdentitySha256 });
  }
  return Object.freeze({ verified: true, producerIdentitySha256, dependencies: Object.freeze(dependencies), frozenInputs: Object.freeze(frozenInputs), bindings: document.bindings });
}

/**
 * The directory whose volume will host the target, walking up to the nearest one that
 * exists. A guard is legitimately started for an output root the materializer has not
 * created yet, and statfs on a missing path throws ENOENT; the free space that matters
 * is the volume's, which every ancestor on that volume reports identically. This
 * resolves WHERE to measure, never WHETHER to measure: no reading is skipped, no
 * threshold moves, and a genuinely unreadable volume still fails closed below.
 */
function volumeMeasurementRoot(target) {
  let candidate = path.resolve(target);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function diskFreeBytes(target) {
  const stat = fs.statfsSync(volumeMeasurementRoot(target));
  const available = typeof stat.bavail === 'bigint' || typeof stat.bsize === 'bigint'
    ? BigInt(stat.bavail) * BigInt(stat.bsize)
    : stat.bavail * stat.bsize;
  const value = Number(available);
  if (!Number.isSafeInteger(value) || value < 0) failClosed('RESOURCE_DISK_FREE_UNAVAILABLE', { target });
  return value;
}

function defaultResourceSample(target) {
  const memory = process.memoryUsage();
  return {
    atMs: performance.now(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    cacheEntries: ensembleCacheSize(),
    ramFreeBytes: os.freemem(),
    diskFreeBytes: diskFreeBytes(target),
  };
}

/**
 * THE FULL-START RAM FLOOR IS A STARTUP PRECONDITION, NOT A RUNNING FLOOR.
 *
 * minimumRamFreeAtFullStartBytes answers one question: may this process begin a real
 * production run on this host at all. It is asked once, immediately before a fresh
 * process starts producer preparation, and the answer is a property of that startup
 * moment.
 *
 * Re-asking it later in the SAME live process measures something different and
 * misleading. After preparation the producer legitimately holds its own working set,
 * so host free RAM has fallen by roughly that amount; re-applying a startup floor to
 * that reading would make a run fail for having successfully allocated what it was
 * budgeted to allocate. The limits that DO bind a running process are the continuous
 * ones - RSS, heapUsed, external and the engine cache - and those are unchanged and
 * still enforced on every observation.
 *
 * A genuinely new process resets this naturally, because module state does not
 * survive process exit: a recovery worker, a restart after a kill, or a reboot each
 * re-ask the question before preparing. resetFullStartRamPrecondition exists so a
 * test can simulate that new process without spawning one; it is never called to
 * re-qualify a host mid-run.
 */
let fullStartRamPrecondition = null;

/** The startup evaluation this process made, or null before the first start. */
export function fullStartRamPreconditionState() {
  return fullStartRamPrecondition === null ? null : { ...fullStartRamPrecondition, laterHostContextBytes: [...fullStartRamPrecondition.laterHostContextBytes] };
}

/** Marks a new producer process for the startup precondition. Real new processes reset by existing. */
export function resetFullStartRamPrecondition() { fullStartRamPrecondition = null; }

function evaluateFullStartRamPrecondition(observedBytes, minimumBytes) {
  if (fullStartRamPrecondition === null) {
    if (observedBytes < minimumBytes) failClosed('RESOURCE_RAM_FREE_BELOW_MINIMUM', { observed: observedBytes, minimum: minimumBytes });
    fullStartRamPrecondition = { evaluated: true, observedBytes, minimumBytes, laterHostContextBytes: [] };
    return { appliedAsStartupPrecondition: true, observedBytes, minimumBytes };
  }
  // Same process, later guard: the reading is host context and decides nothing.
  fullStartRamPrecondition.laterHostContextBytes.push(observedBytes);
  return { appliedAsStartupPrecondition: false, hostContextBytes: observedBytes, startupObservedBytes: fullStartRamPrecondition.observedBytes, minimumBytes };
}

/** Fail-closed page-boundary resource guard. A custom sampler is accepted only for deterministic hostiles. */
export function createResourceBudgetGuard({
  root = REPOSITORY_ROOT,
  binding = loadResourceBudget({ root }),
  sample = defaultResourceSample,
  fullPageCount = binding.projection.fullPageCount,
} = {}) {
  const limits = binding.limits;
  const state = {
    started: false,
    startedAtMs: null,
    target: null,
    preparationMs: 0,
    pagePairs: 0,
    pairBytesTotal: 0,
    pairBytesMax: 0,
    pagePairMsMax: 0,
    checkpointMsMax: 0,
    restartRecoveryMsMax: 0,
    rssPeakBytes: 0,
    heapUsedPeakBytes: 0,
    externalPeakBytes: 0,
    cachePeakEntries: 0,
    ramFreeAtStartBytes: null,
    diskFreeAtStartBytes: null,
    fullStartRamPrecondition: null,
    projectedRuntimeMs: null,
    projectedTotalProductBytes: null,
    cumulativeRuntimeMs: 0,
    manifestByteLength: null,
    samples: 0,
  };

  const observe = (target = state.target) => {
    let measured;
    try { measured = sample(target); }
    catch (cause) { failClosed('RESOURCE_MEASUREMENT_UNAVAILABLE', { cause: cause.code ?? cause.message }); }
    for (const field of ['atMs', 'rssBytes', 'heapUsedBytes', 'externalBytes', 'cacheEntries', 'ramFreeBytes', 'diskFreeBytes']) {
      if (typeof measured?.[field] !== 'number' || !Number.isFinite(measured[field]) || measured[field] < 0) {
        failClosed('RESOURCE_MEASUREMENT_INVALID', { field });
      }
    }
    state.samples += 1;
    state.rssPeakBytes = Math.max(state.rssPeakBytes, measured.rssBytes);
    state.heapUsedPeakBytes = Math.max(state.heapUsedPeakBytes, measured.heapUsedBytes);
    state.externalPeakBytes = Math.max(state.externalPeakBytes, measured.externalBytes);
    state.cachePeakEntries = Math.max(state.cachePeakEntries, measured.cacheEntries);
    if (measured.rssBytes > limits.maximumRssBeforeNextPairBytes) failClosed('RESOURCE_RSS_LIMIT_BREACH', { observed: measured.rssBytes });
    if (measured.heapUsedBytes > limits.maximumHeapUsedBytes) failClosed('RESOURCE_HEAP_LIMIT_BREACH', { observed: measured.heapUsedBytes });
    if (measured.externalBytes > limits.maximumExternalBytes) failClosed('RESOURCE_EXTERNAL_LIMIT_BREACH', { observed: measured.externalBytes });
    if (measured.cacheEntries > limits.maximumEngineCacheEntries) failClosed('RESOURCE_ENGINE_CACHE_LIMIT_BREACH', { observed: measured.cacheEntries });
    return measured;
  };

  const refreshProjection = () => {
    if (state.pagePairs === 0) return;
    state.projectedRuntimeMs = Math.ceil(state.preparationMs + state.pagePairMsMax * fullPageCount);
    const scaledManifest = state.manifestByteLength === null ? 0 : Math.ceil((state.manifestByteLength / state.pagePairs) * fullPageCount);
    state.projectedTotalProductBytes = state.pairBytesMax * fullPageCount + scaledManifest;
    if (state.projectedRuntimeMs > limits.maximumProjectedRuntimeAfterPilotMs) {
      failClosed('RESOURCE_PROJECTED_RUNTIME_LIMIT_BREACH', { observed: state.projectedRuntimeMs });
    }
    if (state.projectedTotalProductBytes > limits.maximumProjectedTotalProductBytes) {
      failClosed('RESOURCE_PROJECTED_PRODUCT_BYTES_LIMIT_BREACH', { observed: state.projectedTotalProductBytes });
    }
  };

  return {
    bindingId: binding.bindingId,
    start({ outputRoot }) {
      if (state.started) return this.snapshot();
      state.target = outputRoot;
      const measured = observe(outputRoot);
      state.started = true;
      state.startedAtMs = measured.atMs;
      state.ramFreeAtStartBytes = measured.ramFreeBytes;
      state.diskFreeAtStartBytes = measured.diskFreeBytes;
      state.fullStartRamPrecondition = evaluateFullStartRamPrecondition(measured.ramFreeBytes, limits.minimumRamFreeAtFullStartBytes);
      if (measured.diskFreeBytes < limits.minimumDiskFreeAtFullStartBytes) failClosed('RESOURCE_DISK_FREE_BELOW_MINIMUM', { observed: measured.diskFreeBytes });
      return this.snapshot();
    },
    observePreparation({ elapsedMs }) {
      if (!state.started) failClosed('RESOURCE_GUARD_NOT_STARTED');
      if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) failClosed('RESOURCE_PREPARATION_TIME_INVALID');
      state.preparationMs = Math.max(state.preparationMs, elapsedMs);
      observe();
      return this.snapshot();
    },
    beforePair({ pageNumber, pairSerializedBytes, pageElapsedMs }) {
      if (!state.started) failClosed('RESOURCE_GUARD_NOT_STARTED');
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(pairSerializedBytes) || pairSerializedBytes < 1) {
        failClosed('RESOURCE_PAIR_MEASUREMENT_INVALID', { pageNumber, pairSerializedBytes });
      }
      if (pairSerializedBytes > limits.maximumSerializedPagePairBytes) failClosed('RESOURCE_PAIR_BYTES_LIMIT_BREACH', { pageNumber, observed: pairSerializedBytes });
      if (typeof pageElapsedMs !== 'number' || !Number.isFinite(pageElapsedMs) || pageElapsedMs < 0
        || pageElapsedMs > limits.maximumSinglePagePairMs) {
        failClosed('RESOURCE_PAGE_TIMEOUT', { pageNumber, observed: pageElapsedMs });
      }
      observe();
    },
    afterPair({ pairSerializedBytes, pagePairMs, checkpointMs = 0 }) {
      if (pagePairMs > limits.maximumSinglePagePairMs) failClosed('RESOURCE_PAGE_TIMEOUT', { observed: pagePairMs });
      state.pagePairs += 1;
      state.pairBytesTotal += pairSerializedBytes;
      state.pairBytesMax = Math.max(state.pairBytesMax, pairSerializedBytes);
      state.pagePairMsMax = Math.max(state.pagePairMsMax, pagePairMs);
      state.checkpointMsMax = Math.max(state.checkpointMsMax, checkpointMs);
      const measured = observe();
      state.cumulativeRuntimeMs = measured.atMs - state.startedAtMs;
      if (state.cumulativeRuntimeMs > limits.absoluteMaximumRuntimeMs) failClosed('RESOURCE_ABSOLUTE_RUNTIME_LIMIT_BREACH', { observed: state.cumulativeRuntimeMs });
      refreshProjection();
      return this.snapshot();
    },
    observeRecovery({ elapsedMs }) {
      if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) failClosed('RESOURCE_RECOVERY_TIME_INVALID');
      state.restartRecoveryMsMax = Math.max(state.restartRecoveryMsMax, elapsedMs);
      observe();
      return this.snapshot();
    },
    finalize({ manifestByteLength, totalElapsedMs }) {
      state.manifestByteLength = manifestByteLength;
      state.cumulativeRuntimeMs = Math.max(state.cumulativeRuntimeMs, totalElapsedMs);
      if (state.cumulativeRuntimeMs > limits.absoluteMaximumRuntimeMs) failClosed('RESOURCE_ABSOLUTE_RUNTIME_LIMIT_BREACH', { observed: state.cumulativeRuntimeMs });
      observe();
      refreshProjection();
      return this.snapshot();
    },
    snapshot() { return JSON.parse(JSON.stringify({ bindingId: binding.bindingId, limits, ...state })); },
  };
}

const lowerBound = (values, sought) => {
  let low = 0; let high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < sought) low = middle + 1; else high = middle; }
  return low;
};
const upperBound = (values, sought) => {
  let low = 0; let high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= sought) low = middle + 1; else high = middle; }
  return low;
};

function member(record, id) { return identityMemberValue(record.orderedMembers, id); }
function recordFactors(record) { return Object.fromEntries(record.coreV1RegimeFactors.map((entry) => [entry.dimensionId, entry.value])); }
function recordFeatureValues(record) { return Object.fromEntries(record.distanceFeatures.map((entry) => [entry.featureId, entry.rawValue])); }
function featuresComplete(record) {
  return record.distanceFeatures.every((entry) => entry.status === 'RESOLVED' && typeof entry.rawValue === 'number' && Number.isFinite(entry.rawValue));
}
function factorsClassifying(record) {
  return record.coreV1RegimeFactors.every((entry) => isClassifyingValue(entry.dimensionId, entry.value));
}
function recordCausalThreshold(record) {
  const cutoff = Date.parse(member(record, 'KnowledgeCutoff'));
  if (!Number.isFinite(cutoff)) return Infinity;
  let threshold = cutoff;
  for (const proof of record.inputProofs) {
    const available = Date.parse(proof.availableAt);
    if (!Number.isFinite(available) || available > cutoff) return Infinity;
    threshold = Math.max(threshold, available);
  }
  return threshold;
}
function groupKey(record) {
  return [member(record, 'InstrumentIdentityId'), member(record, 'RegimeHorizonSpecId'), coreV1Signature(recordFactors(record))].join('\u001e');
}

function prepareAccountingIndex({ policy, universe, counters, sampleMemory }) {
  const reasonIndex = new Map(ELIGIBILITY_EXCLUSION_REASONS_V1.map((reason, index) => [reason, index]));
  const fixed = new Array(ELIGIBILITY_EXCLUSION_REASONS_V1.length).fill(0);
  const withinWindowDates = [];
  const causalThresholds = [];
  const identityCounts = new Map();
  const horizonCounts = new Map();
  const coreCounts = new Map();
  let universeCount = 0;
  const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const candidate of iterateP3hCandidates(universe)) {
    const context = readHistoricalCandidate(candidate, policy);
    universeCount += 1;
    if (context.p3hReason !== null) fixed[reasonIndex.get(context.p3hReason)] += 1;
    const inWindow = context.sessionDate >= policy.historicalObservationWindow.startSessionInclusive
      && context.sessionDate <= policy.historicalObservationWindow.endSessionInclusive;
    if (inWindow) withinWindowDates.push(context.sessionDate);
    else fixed[reasonIndex.get('OUTSIDE_HISTORICAL_WINDOW')] += 1;
    if (historicallyCausal(context, Infinity)) {
      let threshold = Date.parse(context.knowledgeCutoff);
      for (const proof of context.inputProofs) threshold = Math.max(threshold, proof.availableAtMs);
      causalThresholds.push(threshold);
    }
    if (context.identity.matchable) increment(identityCounts, context.identity.instrumentIdentityId);
    if (context.regime !== null) {
      increment(horizonCounts, context.regime.regimeHorizonSpecId);
      if (context.regime.allCoreV1Classifying) increment(coreCounts, coreV1Signature(context.regime.coreV1));
    }
    if (context.regime === null || !context.regime.volatilityStateClassifying) fixed[reasonIndex.get('VOLATILITY_STATE_UNAVAILABLE')] += 1;
    const featureReasons = new Set(Object.values(context.features.classes).filter((value) => value !== null));
    for (const reason of featureReasons) fixed[reasonIndex.get(reason)] += 1;
    if (universeCount % 100000 === 0) sampleMemory();
  }
  counters.universeFullScanCount += 1;
  counters.eligibilityAccountingCandidates = universeCount;
  withinWindowDates.sort(compareCodeUnits);
  causalThresholds.sort((left, right) => left - right);
  return Object.freeze({ universeCount, fixed, withinWindowDates, causalThresholds, identityCounts, horizonCounts, coreCounts });
}

function exclusionCountsForQuery(accounting, record) {
  const counts = [...accounting.fixed];
  const index = new Map(ELIGIBILITY_EXCLUSION_REASONS_V1.map((reason, position) => [reason, position]));
  const sessionDate = member(record, 'SessionDate');
  const cutoffMs = Date.parse(member(record, 'KnowledgeCutoff'));
  counts[index.get('OUTSIDE_HISTORICAL_WINDOW')] += accounting.withinWindowDates.length - lowerBound(accounting.withinWindowDates, sessionDate);
  counts[index.get('AVAILABLE_AFTER_KNOWLEDGE_CUTOFF')] = accounting.universeCount - upperBound(accounting.causalThresholds, cutoffMs);
  counts[index.get('INSTRUMENT_IDENTITY_MISMATCH')] = accounting.universeCount - (accounting.identityCounts.get(member(record, 'InstrumentIdentityId')) ?? 0);
  counts[index.get('REGIME_HORIZON_SPEC_MISMATCH')] = accounting.universeCount - (accounting.horizonCounts.get(member(record, 'RegimeHorizonSpecId')) ?? 0);
  counts[index.get('CORE_V1_REGIME_MISMATCH')] = factorsClassifying(record)
    ? accounting.universeCount - (accounting.coreCounts.get(coreV1Signature(recordFactors(record))) ?? 0)
    : accounting.universeCount;
  return ELIGIBILITY_EXCLUSION_REASONS_V1.map((reasonId, position) => ({ reasonId, count: counts[position] }));
}

function buildOutcomeStore({ universe, calendarSessions }) {
  const sessionIndex = new Map(universe.sessions.map((session, index) => [session.sessionDate, index]));
  const calendar = calendarSessions.map((session) => ({ sessionDate: session.sessionDate, sessionKind: session.sessionKind }));
  const calendarIndex = new Map(calendar.map((session, index) => [session.sessionDate, index]));
  const keyById = new Map();
  let sourceBindingId = null;
  for (const key of universe.keys) {
    if (!Array.isArray(key.bars)) continue;
    const closes = new Float64Array(key.bars.length);
    const available = new Float64Array(key.bars.length);
    closes.fill(Number.NaN); available.fill(Number.NaN);
    key.bars.forEach((bar, index) => {
      if (bar === undefined) return;
      closes[index] = bar.close;
      available[index] = bar.availableAtMs;
    });
    keyById.set(key.acquisitionKey, { closes, available });
    sourceBindingId ??= key.sourceBindingId;
  }
  if (typeof sourceBindingId !== 'string' || sourceBindingId.length === 0) failClosed('OUTCOME_SOURCE_BINDING_REQUIRED');
  return Object.freeze({ sessionIndex, calendar, calendarIndex, keyById, sourceBindingId });
}

function createIndexedOutcomeSource({ outcomeStore, recordById, horizonBindings, counters }) {
  const horizonById = new Map(horizonBindings.map((binding) => [binding.horizonId, binding]));
  return Object.freeze({
    sourceBindingId: outcomeStore.sourceBindingId,
    lookup({ analogueIdentityId, horizonId }) {
      counters.outcomeLookups += 1;
      const record = recordById.get(analogueIdentityId);
      const horizon = horizonById.get(horizonId);
      if (!record || !horizon) return null;
      const bars = outcomeStore.keyById.get(record.p3hKeyId);
      const sessionDate = member(record, 'SessionDate');
      const calendarStart = outcomeStore.calendarIndex.get(sessionDate);
      const historicalStart = outcomeStore.sessionIndex.get(sessionDate);
      if (!bars || calendarStart === undefined || historicalStart === undefined) return null;
      const sessions = outcomeStore.calendar.slice(calendarStart + 1, calendarStart + 1 + horizon.sessionCount);
      if (sessions.length !== horizon.sessionCount || sessions.some((session) => !SESSION_KINDS_V1.includes(session.sessionKind))) return null;
      const startClose = bars.closes[historicalStart];
      const startAvailable = bars.available[historicalStart];
      if (!Number.isFinite(startClose) || startClose <= 0 || !Number.isFinite(startAvailable)) return null;
      const closes = [startClose];
      let maxAvailableMs = startAvailable;
      for (const session of sessions) {
        const index = outcomeStore.sessionIndex.get(session.sessionDate);
        if (index === undefined) return null;
        const close = bars.closes[index];
        const availableAt = bars.available[index];
        if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(availableAt)) return null;
        closes.push(close);
        maxAvailableMs = Math.max(maxAvailableMs, availableAt);
      }
      const computed = simpleReturn(closes);
      if (computed.status !== 'RESOLVED') return null;
      return { outcomeValue: computed.value, outcomeAvailableAt: new Date(maxAvailableMs).toISOString() };
    },
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function summarizeSupport({ orderedRecords, supportCountById, pageSize }) {
  const support = orderedRecords.map((record) => supportCountById.get(record.analogueIdentityId));
  const sorted = [...support].sort((a, b) => a - b);
  const pages = [];
  for (let index = 0; index < orderedRecords.length; index += pageSize) {
    const values = support.slice(index, index + pageSize);
    pages.push({
      pageNumber: pages.length + 1,
      firstOrdinal: index + 1,
      lastOrdinal: index + values.length,
      recordCount: values.length,
      supportSum: values.reduce((sum, value) => sum + value, 0),
      supportMean: values.reduce((sum, value) => sum + value, 0) / values.length,
      supportMax: Math.max(...values),
      abstainBelowTwo: values.filter((value) => value < 2).length,
    });
  }
  return {
    queryCount: support.length,
    mean: support.reduce((sum, value) => sum + value, 0) / support.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
    zero: support.filter((value) => value === 0).length,
    one: support.filter((value) => value === 1).length,
    belowTwo: support.filter((value) => value < 2).length,
    pages,
  };
}

function assertMeasuredSupportDistribution(summary) {
  const expected = EXPECTED_SUPPORT_DISTRIBUTION_V1;
  const worst = summary.pages[expected.worstPageNumber - 1];
  for (const field of ['queryCount', 'zero', 'one', 'belowTwo', 'median', 'p95', 'p99', 'max']) {
    if (summary[field] !== expected[field]) failClosed('MEASURED_SUPPORT_DISTRIBUTION_DRIFT', { field, expected: expected[field], observed: summary[field] });
  }
  if (worst?.supportSum !== expected.worstPageSupportSum) {
    failClosed('MEASURED_SUPPORT_DISTRIBUTION_DRIFT', { field: 'worstPageSupportSum', observed: worst?.supportSum ?? null });
  }
}

function representativePilotPages(summary) {
  const closest = (target, field = 'supportMean') => summary.pages.reduce((best, page) => {
    const distance = Math.abs(page[field] - target);
    return best === null || distance < best.distance || (distance === best.distance && page.pageNumber < best.page.pageNumber)
      ? { page, distance } : best;
  }, null).page.pageNumber;
  const highAbstain = summary.pages.reduce((best, page) => page.abstainBelowTwo > best.abstainBelowTwo ? page : best, summary.pages[0]);
  return [...new Set([
    1,
    summary.pages.length,
    EXPECTED_SUPPORT_DISTRIBUTION_V1.worstPageNumber,
    closest(summary.median),
    closest(summary.p95, 'supportMax'),
    closest(summary.p99, 'supportMax'),
    highAbstain.pageNumber,
  ])].sort((a, b) => a - b);
}

function inputBindingFromMiniProvenance(root) {
  const provenance = readJson(root, MINI_PROVENANCE_PATH_V1, 'MINI_PROVENANCE_ABSENT_OR_INVALID');
  return validateInputBinding(provenance.inputBinding);
}

/**
 * BOUNDED FOUNDATION PROJECTION — the same projection, never materialized.
 *
 * WHAT THIS REPLACES AND WHY. attachPublishedFoundationProjections builds one
 * projected object for every admitted (acquisitionKey, sessionDate) pair and holds
 * the whole set in a Map for the lifetime of the universe. Measured on the real
 * 1,750,766-candidate universe that Map drove RSS from 483 MB to 1,866 MB and heap
 * from 221 MB to 1,568 MB, breaching two accepted limits, while the live working set
 * after release was only ~275 MB. The cost was never the data the producer needs; it
 * was keeping every projection alive at once so that a later lookup would be cheap.
 *
 * WHAT THE CONSUMER ACTUALLY REQUIRES. GATE25's realCandidate reads exactly one thing
 * from the attached universe: foundationProjections.get(candidateKey). It needs a
 * get method, not a Map. So this returns a universe whose foundationProjections computes
 * the projection on demand, from the same frozen primitives, with the same gating, in
 * the same order, and returns the same object realCandidate would have found. Nothing
 * is approximated, sampled, or dropped, and GATE25 is not modified.
 *
 * WHAT IS RETAINED. Only what is O(keys) or shared by reference with the base
 * universe: the admitted-entry index, a key index, a session-date index, and a
 * SINGLE-ENTRY bar cache. The bar cache is what keeps the cost identical rather than
 * merely bounded: iterateP3hCandidates walks key-major, so one cached key reproduces
 * exactly the keyBars reuse the original inner loop had. Each projected object lives
 * only until realCandidate has copied the fields it needs, so the peak holds one
 * projection, not 1.75 million. Boundedness here is structural — nothing is retained
 * to be collected later — so it does not depend on global.gc().
 */
export function createBoundedFoundationProjection({ universe, foundation, counters }) {
  const entryByKey = new Map(foundation.p3h.admittedEntries.map((entry) => [entry.acquisitionKey, entry]));
  const keyByAcquisition = new Map(universe.keys.map((key) => [key.acquisitionKey, key]));
  const sessionIndexByDate = new Map(universe.sessions.map((session, index) => [session.sessionDate, index]));

  // EAGERLY, exactly as the original did. The materializing version raised
  // FOUNDATION_ADMITTED_KEY_MISSING for an admitted key with no entry before it looked
  // at any session, so a key whose sessions are all unresolved still failed closed.
  // Checking here preserves that: a lazy check alone would silently skip such a key.
  for (const key of universe.keys) {
    if (key.exclusionClass !== null) continue;
    if (!entryByKey.has(key.acquisitionKey)) failClosed('FOUNDATION_ADMITTED_KEY_MISSING', { acquisitionKey: key.acquisitionKey });
  }

  let cachedAcquisitionKey = null;
  let cachedBars = null;

  const foundationProjections = {
    get(candidateKey) {
      // sessionDate is YYYY-MM-DD and contains no separator, so the last '|' splits
      // correctly even for an acquisition key that contains one.
      const separator = candidateKey.lastIndexOf('|');
      if (separator < 0) return undefined;
      const acquisitionKey = candidateKey.slice(0, separator);
      const sessionDate = candidateKey.slice(separator + 1);

      const key = keyByAcquisition.get(acquisitionKey);
      if (key === undefined || key.exclusionClass !== null) return undefined;
      const index = sessionIndexByDate.get(sessionDate);
      if (index === undefined) return undefined;
      if (universe.identityOutcomes[key.identityOutcome[index]].status !== 'RESOLVED') return undefined;

      const entry = entryByKey.get(acquisitionKey);
      if (cachedAcquisitionKey !== acquisitionKey) {
        cachedBars = readP3hAdmittedBarsR1({ p3h: foundation.p3h, entry });
        cachedAcquisitionKey = acquisitionKey;
        counters.foundationBarReads += 1;
      }
      const emitted = emitJarviseG25HistoricalRegimeRecordR1({ foundation, entry, keyBars: cachedBars, sessionDate });
      if (emitted.status !== 'EMITTED') { counters.foundationProjectionsRefused += 1; return undefined; }
      counters.foundationProjectionsComputed += 1;
      return projectGate25AnalogueInputsR1({ foundation, emitted });
    },
  };

  return Object.freeze({
    sessions: universe.sessions,
    calendarRegistryManifestId: universe.calendarRegistryManifestId,
    identityOutcomes: universe.identityOutcomes,
    keys: universe.keys,
    accounting: universe.accounting,
    foundationProjections,
    foundation,
    calendarSessions: foundation.calendarSessions,
    /** Releases the single-entry bar cache. The view retains nothing else per candidate. */
    releaseTransientCache() { cachedAcquisitionKey = null; cachedBars = null; },
  });
}

/** Prepare the real producer once. No query path calls an O(U) iterator. */
export function prepareRealProductionProducer({
  root = REPOSITORY_ROOT,
  retainOracleUniverse = false,
  maxOracleQueries = 24,
  resourceGuard = null,
} = {}) {
  const startedAt = performance.now();
  const identity = verifyProducerIdentity({ root });
  const resourceBudget = loadResourceBudget({ root });
  // THE STARTUP QUESTION IS ANCHORED HERE, immediately before preparation begins.
  //
  // Anchoring it to the first resource guard instead would make the answer depend on
  // when the caller happens to construct one. A caller that prepares first and guards
  // afterwards would be asked the startup question minutes late, against a host
  // reading already reduced by this process's own working set, and would fail for
  // having allocated what it was budgeted to allocate. Evaluating once here makes the
  // moment deterministic for every caller; a guard started earlier still asks first,
  // and a guard started later reads it as host context.
  evaluateFullStartRamPrecondition(os.freemem(), resourceBudget.limits.minimumRamFreeAtFullStartBytes);
  const inputBinding = inputBindingFromMiniProvenance(root);
  const counters = {
    p3hPreparationCount: 0,
    foundationProjectionPassCount: 0,
    foundationProjectionsComputed: 0,
    foundationProjectionsRefused: 0,
    foundationBarReads: 0,
    retainedFoundationProjectionEntries: 0,
    universeFullScanCount: 0,
    publishedIndexFullPassCount: 0,
    perQueryUniverseFullScanCount: 0,
    eligibilityAccountingCandidates: 0,
    indexedRecordsPrepared: 0,
    groupedCandidateCount: 0,
    groupCount: 0,
    groupedSortCount: 0,
    supportQueriesPrepared: 0,
    queryCalls: 0,
    indexedCandidateVisits: 0,
    outcomeLookups: 0,
    boundedOracleUniverseScans: 0,
    oracleQueries: 0,
    rssPeakBytes: 0,
    heapUsedPeakBytes: 0,
    externalPeakBytes: 0,
  };
  const sampleMemory = () => {
    const usage = process.memoryUsage();
    counters.rssPeakBytes = Math.max(counters.rssPeakBytes, usage.rss);
    counters.heapUsedPeakBytes = Math.max(counters.heapUsedPeakBytes, usage.heapUsed);
    counters.externalPeakBytes = Math.max(counters.externalPeakBytes, usage.external);
  };
  sampleMemory();

  const gate25Authority = loadGate25BuildAuthority({ root });
  const p3h = loadP3hDatasetBinding({ authority: gate25Authority });
  const calendar = loadHistoricalWindowCalendar({ authority: gate25Authority, root });
  const policy = bindR0003SelectionPolicy({ authority: gate25Authority, p3h, calendar });
  const identityResolver = createRegistryHistoricalIdentityResolver({ root });
  let baseUniverse = prepareP3hHistoricalUniverse({ p3h, calendar, identityResolver });
  counters.p3hPreparationCount += 1;
  counters.universeFullScanCount += 1;
  sampleMemory();
  const { foundation } = bindPublishedHistoricalRegimeFoundation({ authority: gate25Authority, root });
  // Constructing the bounded view is O(keys), not a universe pass: the projection work
  // is fused into the single accounting pass below, which already counts as one scan.
  // That is why universeFullScanCount falls from 3 to 2 rather than staying at 3.
  let oracleUniverse = createBoundedFoundationProjection({ universe: baseUniverse, foundation, counters });
  sampleMemory();
  const accounting = prepareAccountingIndex({ policy, universe: oracleUniverse, counters, sampleMemory });
  const outcomeStore = buildOutcomeStore({ universe: baseUniverse, calendarSessions: foundation.calendarSessions });

  const groups = new Map();
  const recordById = new Map();
  const orderedRecords = [];
  const sourceCounters = {};
  const sourcePath = path.resolve(root, CANONICAL_ANALOGUE_INDEX_PATH_V1);
  const stats = streamVerifiedIndexRecords({
    path: sourcePath,
    counters: sourceCounters,
    onRecord: (_unit, record) => {
      recordById.set(record.analogueIdentityId, record);
      orderedRecords.push(record);
      if (!factorsClassifying(record) || !featuresComplete(record) || !Number.isFinite(recordCausalThreshold(record))) return;
      const key = groupKey(record);
      const list = groups.get(key) ?? [];
      list.push({
        record,
        sessionDate: member(record, 'SessionDate'),
        knowledgeCutoffMs: Date.parse(member(record, 'KnowledgeCutoff')),
        causalThresholdMs: recordCausalThreshold(record),
        featureValues: recordFeatureValues(record),
      });
      groups.set(key, list);
      counters.groupedCandidateCount += 1;
    },
  });
  counters.publishedIndexFullPassCount += 1;
  counters.indexedRecordsPrepared = orderedRecords.length;
  if (stats.sha256 !== inputBinding.analogueIndexSha256 || stats.queryCount !== EXPECTED_SUPPORT_DISTRIBUTION_V1.queryCount
    || stats.datasetId !== inputBinding.datasetId || stats.selectionPolicyVersionId !== inputBinding.selectionPolicyVersionId) {
    failClosed('REAL_PRODUCER_INDEX_BINDING_MISMATCH', stats);
  }
  for (const list of groups.values()) {
    list.sort((left, right) => compareCodeUnits(left.sessionDate, right.sessionDate)
      || compareCodeUnits(left.record.analogueIdentityId, right.record.analogueIdentityId));
    counters.groupedSortCount += 1;
  }
  counters.groupCount = groups.size;
  sampleMemory();

  const selectedFor = (record, track = true) => {
    if (!factorsClassifying(record)) return [];
    const list = groups.get(groupKey(record)) ?? [];
    const queryDate = member(record, 'SessionDate');
    const queryCutoffMs = Date.parse(member(record, 'KnowledgeCutoff'));
    const stop = lowerBound(list.map((entry) => entry.sessionDate), queryDate);
    const selected = [];
    for (let index = 0; index < stop; index += 1) {
      const candidate = list[index];
      if (track) counters.indexedCandidateVisits += 1;
      if (candidate.causalThresholdMs <= queryCutoffMs) selected.push(candidate);
    }
    return selected;
  };
  const supportCountById = new Map();
  for (const record of orderedRecords) supportCountById.set(record.analogueIdentityId, selectedFor(record, false).length);
  counters.supportQueriesPrepared = orderedRecords.length;
  const supportDistribution = summarizeSupport({ orderedRecords, supportCountById, pageSize: 128 });
  assertMeasuredSupportDistribution(supportDistribution);
  const pilotPages = representativePilotPages(supportDistribution);

  if (!retainOracleUniverse) oracleUniverse = null;
  baseUniverse = null;
  if (global.gc) global.gc();
  sampleMemory();
  const horizonBindings = admissibleHorizonBindings({
    horizonContract: gate25Authority.horizonContract,
    calendarRegistryManifestId: inputBinding.calendarRegistryManifestId,
  });
  const outcomeSource = createIndexedOutcomeSource({ outcomeStore, recordById, horizonBindings, counters });
  const miniAuthority = loadGate26MiniBuildAuthority({ root });

  const detailed = (sourceRecord) => {
    counters.queryCalls += 1;
    const record = recordById.get(sourceRecord?.analogueIdentityId);
    if (!record || canonicalize(record) !== canonicalize(sourceRecord)) failClosed('REAL_PRODUCER_QUERY_SOURCE_MISMATCH');
    const selected = selectedFor(record, true);
    const structuralGatesPass = factorsClassifying(record) && featuresComplete(record);
    const exclusionCountsByReason = exclusionCountsForQuery(accounting, record);
    const support = buildSupportReport({
      universeCount: accounting.universeCount,
      eligibleCount: selected.length,
      excludedCount: accounting.universeCount - selected.length,
      exclusionCountsByReason,
      structuralGatesPass,
    });
    if (selected.length > 0 && !featuresComplete(record)) failClosed('QUERY_DISTANCE_FEATURE_INCOMPLETE');
    const bounds = selected.length === 0 ? [] : computeNormalizationBounds(selected.map((entry) => entry.featureValues));
    const queryFeatures = recordFeatureValues(record);
    const ranked = rankQueryResults(selected.map((entry) => ({
      analogueIdentityId: entry.record.analogueIdentityId,
      sessionDate: entry.sessionDate,
      ...computeDistanceEvidence({ queryFeatureValues: queryFeatures, candidateFeatureValues: entry.featureValues, bounds }),
      commonFactors: entry.record.coreV1RegimeFactors.map((factor) => ({ ...factor })),
    })));
    const queryIdentity = verifyAnalogueIdentity(record);
    const comparison = buildComparisonReport({
      queryIdentityId: queryIdentity.analogueIdentityId,
      datasetId: inputBinding.datasetId,
      selectionPolicyVersionId: inputBinding.selectionPolicyVersionId,
      knowledgeCutoff: member(record, 'KnowledgeCutoff'),
      supportReport: support.report,
      rankedAnalogues: ranked,
    });
    const frozenSelection = freezeSelection({ queryIdentityId: queryIdentity.analogueIdentityId, rankedAnalogues: ranked });
    const outcomeSet = attachPostSelectionOutcomes({
      frozenSelection,
      horizonBindings,
      outcomeSource,
      queryKnowledgeCutoff: member(record, 'KnowledgeCutoff'),
    });
    const inputProofs = [
      ...record.inputProofs.map((proof) => buildInputProof({
        inputId: `QUERY:${proof.inputId}`,
        sourceArtifactId: proof.sourceArtifactId,
        sourceArtifactSha256: proof.sourceArtifactSha256,
        availableAt: proof.availableAt,
        knowledgeCutoff: member(record, 'KnowledgeCutoff'),
      })),
      ...ranked.flatMap((entry) => {
        const analogue = recordById.get(entry.analogueIdentityId);
        return analogue.inputProofs.map((proof) => buildInputProof({
          inputId: `${entry.analogueIdentityId}:${proof.inputId}`,
          sourceArtifactId: proof.sourceArtifactId,
          sourceArtifactSha256: proof.sourceArtifactSha256,
          availableAt: proof.availableAt,
          knowledgeCutoff: member(analogue, 'KnowledgeCutoff'),
        }));
      }),
    ];
    const selection = {
      query: { knowledgeCutoff: member(record, 'KnowledgeCutoff') },
      queryIdentity,
      supportReport: support.report,
      supportReportId: support.supportReportId,
      comparisonReport: comparison.report,
      comparisonReportId: comparison.comparisonReportId,
      frozenSelection,
      normalizationBounds: bounds,
      horizonBindings,
      outcomeSet,
      inputProofs,
    };
    const combined = combineFrozenSelection({ authority: miniAuthority, selection, inputBinding });
    return {
      sourceRecord: record,
      selectedAnalogueIdentityIds: ranked.map((entry) => entry.analogueIdentityId),
      supportReport: support.report,
      comparisonReport: comparison.report,
      outcomeSet,
      combined,
      output: { ensembleRecord: buildEnsembleIndexRecord(combined), provenanceRecord: combined.provenance },
    };
  };

  const producer = {
    producerId: REAL_PRODUCER_ID_V1,
    producerCodeSha256: identity.producerIdentitySha256,
    productionClass: REAL_PRODUCER_CLASS_V1,
    synthetic: false,
    identity,
    inputBinding,
    resourceBudget,
    sourcePath,
    sourceIdentity: stats,
    supportDistribution,
    pilotPages,
    counters,
    orderedRecords,
    recordById,
    supportCountById,
    produce(_unit, sourceRecord) { return detailed(sourceRecord).output; },
    produceDetailed(sourceRecord) { return detailed(sourceRecord); },
    recordsForPages(pageNumbers = pilotPages) {
      const chosen = new Set(pageNumbers);
      return orderedRecords.filter((_record, index) => chosen.has(Math.floor(index / 128) + 1));
    },
    produceSlowOracle(sourceRecord) {
      if (!oracleUniverse) failClosed('BOUNDED_ORACLE_UNIVERSE_NOT_RETAINED');
      if (counters.oracleQueries >= maxOracleQueries) failClosed('BOUNDED_ORACLE_QUERY_LIMIT_EXCEEDED', { maxOracleQueries });
      const query = buildP3hQuery({ universe: oracleUniverse, acquisitionKey: sourceRecord.p3hKeyId, sessionDate: member(sourceRecord, 'SessionDate') });
      const selection = runAnalogueSelection({
        authority: gate25Authority,
        policy,
        query,
        candidates: iterateP3hCandidates(oracleUniverse),
        historicalOutcomeUniverse: oracleUniverse,
      });
      counters.oracleQueries += 1;
      counters.boundedOracleUniverseScans += 1;
      if (selection.queryIdentity.analogueIdentityId !== sourceRecord.analogueIdentityId) failClosed('BOUNDED_ORACLE_QUERY_IDENTITY_MISMATCH');
      const combined = combineFrozenSelection({ authority: miniAuthority, selection, inputBinding });
      return {
        selection,
        combined,
        output: { ensembleRecord: buildEnsembleIndexRecord(combined), provenanceRecord: combined.provenance },
      };
    },
  };
  counters.preparationMs = performance.now() - startedAt;
  if (counters.universeFullScanCount > resourceBudget.limits.maximumUniverseFullScanCount) {
    failClosed('REAL_PRODUCER_UNIVERSE_SCAN_LIMIT_BREACH', { observed: counters.universeFullScanCount });
  }
  resourceGuard?.observePreparation({ elapsedMs: counters.preparationMs });
  return Object.freeze(producer);
}

function pilotIndexBytes(records, inputBinding) {
  for (let index = 1; index < records.length; index += 1) {
    if (!(records[index].analogueIdentityId > records[index - 1].analogueIdentityId)) failClosed('PILOT_SOURCE_ORDER_INVALID');
  }
  return Buffer.from(canonicalize({
    schema: ANALOGUE_INDEX_SCHEMA_V1,
    datasetId: inputBinding.datasetId,
    selectionPolicyVersionId: inputBinding.selectionPolicyVersionId,
    pageSize: INDEX_PAGE_SIZE_V1,
    recordCount: records.length,
    records,
  }), 'utf8');
}

function compareProductDirectories(left, right) {
  const leftNames = fs.readdirSync(left).sort(compareCodeUnits);
  const rightNames = fs.readdirSync(right).sort(compareCodeUnits);
  return canonicalize(leftNames) === canonicalize(rightNames)
    && leftNames.every((name, index) => name === rightNames[index]
      && sha256Bytes(fs.readFileSync(path.join(left, name))) === sha256Bytes(fs.readFileSync(path.join(right, name))));
}

/** Bounded REAL pilot in durable external evidence. Never targets the canonical FULL root. */
export async function runRealBoundedPilot({ root = REPOSITORY_ROOT, evidenceRoot, pageNumbers = null } = {}) {
  if (typeof evidenceRoot !== 'string' || evidenceRoot.length === 0) failClosed('REAL_PILOT_EVIDENCE_ROOT_REQUIRED');
  const resolvedEvidence = path.resolve(evidenceRoot);
  const relative = path.relative(root, resolvedEvidence);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) failClosed('REAL_PILOT_EVIDENCE_INSIDE_REPOSITORY_FORBIDDEN');
  if (fs.existsSync(resolvedEvidence)) failClosed('REAL_PILOT_EVIDENCE_ROOT_ALREADY_EXISTS', { evidenceRoot: resolvedEvidence });
  fs.mkdirSync(resolvedEvidence, { recursive: true });
  const { installNetworkTrap } = await import('./mini-fixture-v1.mjs');
  const networkCalls = installNetworkTrap();
  const guard = createResourceBudgetGuard({ root });
  guard.start({ outputRoot: resolvedEvidence });
  const producer = prepareRealProductionProducer({ root, resourceGuard: guard });
  const selectedPages = pageNumbers ?? producer.pilotPages;
  const records = producer.recordsForPages(selectedPages);
  const sourceBytes = pilotIndexBytes(records, producer.inputBinding);
  const sourcePath = path.join(resolvedEvidence, 'source', 'PILOT_ANALOGUE_INDEX.json');
  durableReplaceFileSync(sourcePath, sourceBytes);
  const { deriveQueryCohort } = await import('./full-query-cohort-v1.mjs');
  const { loadFullPrebuildAuthority } = await import('./full-query-cohort-v1.mjs');
  const authority = loadFullPrebuildAuthority({ root });
  const cohort = deriveQueryCohort({
    path: sourcePath,
    sourceLabel: REAL_PILOT_SOURCE_LABEL_V1,
    expectedSha256: sha256Bytes(sourceBytes),
    expectedQueryCount: records.length,
    expectedDatasetId: producer.inputBinding.datasetId,
    pageSize: authority.pageSize,
    retainUnits: false,
  });
  const { runPagedMaterialization, simulatedCrashAt } = await import('./full-paged-materializer-v1.mjs');
  const run = (name, extra = {}) => runPagedMaterialization({
    root,
    sourcePath,
    cohort,
    producer,
    inputBinding: producer.inputBinding,
    outputRoot: path.join(resolvedEvidence, name, 'product'),
    checkpointRoot: path.join(resolvedEvidence, name, 'checkpoint'),
    executionIntent: 'REAL_PILOT',
    resourceGuard: extra.resourceGuard ?? createResourceBudgetGuard({ root }),
    ...extra,
  });
  const continuousGuard = createResourceBudgetGuard({ root });
  continuousGuard.start({ outputRoot: path.join(resolvedEvidence, 'continuous', 'product') });
  continuousGuard.observePreparation({ elapsedMs: producer.counters.preparationMs });
  const continuous = run('continuous', { resourceGuard: continuousGuard });
  const resumedGuard = createResourceBudgetGuard({ root });
  resumedGuard.start({ outputRoot: path.join(resolvedEvidence, 'resumed', 'product') });
  resumedGuard.observePreparation({ elapsedMs: producer.counters.preparationMs });
  let crash = null;
  try { run('resumed', { resourceGuard: resumedGuard, faultInjector: simulatedCrashAt('AFTER_PROVENANCE_PAGE', 2) }); }
  catch (error) { if (error.code !== 'SIMULATED_CRASH') throw error; crash = { code: error.code, point: error.point, pageNumber: error.pageNumber }; }
  if (!crash) failClosed('REAL_PILOT_CRASH_NOT_OBSERVED');
  const recoveryStarted = performance.now();
  const resumedAfterCrash = run('resumed', { resourceGuard: resumedGuard });
  resumedGuard.observeRecovery({ elapsedMs: performance.now() - recoveryStarted });
  const duplicate = run('continuous', { resourceGuard: continuousGuard });
  const byteIdenticalRecovery = compareProductDirectories(
    path.join(resolvedEvidence, 'continuous', 'product'),
    path.join(resolvedEvidence, 'resumed', 'product'),
  );
  if (!byteIdenticalRecovery || continuous.manifestSha256 !== resumedAfterCrash.manifestSha256) failClosed('REAL_PILOT_RECOVERY_NOT_BYTE_IDENTICAL');
  if (networkCalls.length > 0) failClosed('REAL_PILOT_NETWORK_ATTEMPT', { networkCalls });
  const abstain = { ABSTAIN_A_LT_2: 0, ABSTAIN_MISSING_OUTCOME: 0, ABSTAIN_OTHER_ALLOWED_REASON: 0 };
  for (const record of records) {
    const detailed = producer.produceDetailed(record);
    if (detailed.supportReport.eligibleCount < 2) abstain.ABSTAIN_A_LT_2 += 1;
    else if (detailed.combined.decision === 'ABSTAIN' && detailed.combined.abstention.reason === 'PREDICTIVE_FAMILY_MISSING') abstain.ABSTAIN_MISSING_OUTCOME += 1;
    else if (detailed.combined.decision === 'ABSTAIN') abstain.ABSTAIN_OTHER_ALLOWED_REASON += 1;
  }
  const report = {
    document: 'GATE26_PHASE_D_REAL_PRODUCER_BOUNDED_PILOT_R1',
    producerIdentitySha256: producer.identity.producerIdentitySha256,
    source: { path: sourcePath, sha256: sha256Bytes(sourceBytes), byteLength: sourceBytes.length },
    selectedCanonicalPageNumbers: selectedPages,
    pilotQueryCount: records.length,
    pilotPagePairCount: cohort.plan.pageCount,
    supportDistribution: producer.supportDistribution,
    abstain,
    complexity: producer.counters,
    continuous,
    crash,
    resumedAfterCrash,
    duplicate,
    byteIdenticalRecovery,
    resourceMeasurements: {
      preparation: {
        rssPeakBytes: producer.counters.rssPeakBytes,
        heapUsedPeakBytes: producer.counters.heapUsedPeakBytes,
        externalPeakBytes: producer.counters.externalPeakBytes,
        elapsedMs: producer.counters.preparationMs,
      },
      continuous: continuousGuard.snapshot(),
      resumed: resumedGuard.snapshot(),
    },
    networkCalls,
    yahoo: false,
    canonicalFullFilesCreated: fs.existsSync(path.resolve(root, 'data/jarvise/predictive-ensemble/GATE26/V1/FULL')) ? null : 0,
    phaseDReady: false,
    independentAuditAssigned: false,
  };
  const reportPath = path.join(resolvedEvidence, 'PILOT_REPORT.json');
  durableReplaceFileSync(reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
  return { reportPath, reportSha256: sha256Bytes(fs.readFileSync(reportPath)), report };
}
