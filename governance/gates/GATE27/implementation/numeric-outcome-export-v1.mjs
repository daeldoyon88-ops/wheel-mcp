/**
 * GATE27 numeric outcome export V1 (approved R2 contract).
 *
 * The builder is deliberately post-selection. It reads the analogue order and
 * selection digest already published in each GATE26 FULL provenance record,
 * independently rebuilds the expanded GATE25 outcome records from frozen P3H
 * bars, and refuses the build unless all 68,562 recomputed OutcomeSetIds equal
 * the published values. It never invokes selection or a GATE26 producer.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(MODULE_DIR, '../contracts/GATE27_NUMERIC_OUTCOME_EXPORT_V1.json');
const RESOURCE_PATH = path.resolve(MODULE_DIR, '../contracts/GATE27_NUMERIC_OUTCOME_EXPORT_RESOURCE_BUDGET_V1.json');
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_ID = /^sha256:[0-9a-f]{64}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const PRODUCT_VERSION = 'GATE27_NUMERIC_OUTCOME_EXPORT_V1';
export const MANIFEST_SCHEMA = 'GATE27_NUMERIC_OUTCOME_EXPORT_MANIFEST_V1';
export const PAGE_SCHEMA = 'GATE27_NUMERIC_OUTCOME_PAGE_V1';
export const PRODUCT_ROOT = 'data/jarvise/predictive-ensemble/GATE27/V1/NUMERIC_OUTCOME_EXPORT';
export const OUTCOME_SET_ARTIFACT_ID = 'GATE25_POST_SELECTION_OUTCOME_SET_V1';
export const RECORD_GRANULARITY = 'PER_ANALOGUE_PER_HORIZON';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fail(code, detail = null) {
  const error = new Error(detail === null ? code : `${code}: ${JSON.stringify(detail)}`);
  error.code = code;
  error.detail = detail;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sorted(values) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function assertExactKeys(value, expected, code = 'OBJECT_SCHEMA_NOT_CLOSED') {
  if (!isPlainObject(value)) fail(code, { expected, observedType: Array.isArray(value) ? 'array' : typeof value });
  const observed = sorted(Object.keys(value));
  const wanted = sorted(expected);
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) fail(code, { expected: wanted, observed });
  return value;
}

function canonicalInstant(value, code) {
  if (typeof value !== 'string' || !UTC_INSTANT.test(value) || new Date(Date.parse(value)).toISOString() !== value) fail(code, value);
  return value;
}

function exactId(value, code, prefixed = false) {
  if (typeof value !== 'string' || !(prefixed ? SHA256_ID : SHA256_HEX).test(value)) fail(code, value);
  return value;
}

function readContracts() {
  const contract = readJson(CONTRACT_PATH);
  const resource = readJson(RESOURCE_PATH);
  if (contract.contractId !== PRODUCT_VERSION || contract.contractRevision !== 'R2' || contract.product?.productVersion !== PRODUCT_VERSION) {
    fail('GATE27_CONTRACT_INVALID');
  }
  if (resource.bindingId !== 'GATE27_NUMERIC_OUTCOME_EXPORT_RESOURCE_BUDGET_V1' || resource.status !== 'BOUND') {
    fail('GATE27_RESOURCE_CONTRACT_INVALID');
  }
  return { contract, resource };
}

const LOCAL_CONTRACTS = readContracts();

function canonicalPageName(pageNumber) {
  return `OUTCOME_PAGE_${String(pageNumber).padStart(4, '0')}.json`;
}

function repositoryPath(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) fail('REPOSITORY_PATH_ESCAPE', relativePath);
  return resolved;
}

function productPath(candidateRoot, relativeName = '') {
  const root = path.resolve(candidateRoot, ...PRODUCT_ROOT.split('/'));
  return relativeName ? path.join(root, relativeName) : root;
}

function assertOutsideRepository(repositoryRoot, target, code) {
  const relative = path.relative(path.resolve(repositoryRoot), path.resolve(target));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) fail(code, { repositoryRoot, target });
}

function durableWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}

function jsonEvidenceBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function importFromRoot(root, relativePath) {
  return import(pathToFileURL(repositoryPath(root, relativePath)).href);
}

async function loadRuntime(root) {
  const canonical = await importFromRoot(root, 'governance/tools/canonical-json.mjs');
  const engine = await importFromRoot(root, 'governance/gates/GATE25/implementation/historical-analogue-engine-v1.mjs');
  const temporal = await importFromRoot(root, 'governance/gates/GATE22/implementation/temporal-horizon-v1.mjs');
  const queryCohort = await importFromRoot(root, 'governance/gates/GATE26/implementation/full-query-cohort-v1.mjs');
  const calendar = await importFromRoot(root, 'app/jarvise/jarviseHistoricalCalendarBindingR1.mjs');
  const network = await importFromRoot(root, 'governance/gates/GATE26/implementation/mini-fixture-v1.mjs');
  return { canonical, engine, temporal, queryCohort, calendar, network };
}

function readHead(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) fail('BUILD_HEAD_INVALID', head);
  return head;
}

function nearestExistingDirectory(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) fail('OUTPUT_VOLUME_UNRESOLVABLE', target);
    current = parent;
  }
  return fs.statSync(current).isDirectory() ? current : path.dirname(current);
}

function createResourceTelemetry({ resource, outputTarget }) {
  const limits = resource.limits;
  const startedAt = performance.now();
  const disk = fs.statfsSync(nearestExistingDirectory(outputTarget));
  const start = {
    freeRamBytes: os.freemem(),
    freeDiskBytes: Number(disk.bavail) * Number(disk.bsize),
  };
  if (start.freeRamBytes < limits.minimumFreeRamAtStartBytes) fail('RESOURCE_FREE_RAM_START_BREACH', { observed: start.freeRamBytes, limit: limits.minimumFreeRamAtStartBytes });
  if (start.freeDiskBytes < limits.minimumFreeDiskAtStartBytes) fail('RESOURCE_FREE_DISK_START_BREACH', { observed: start.freeDiskBytes, limit: limits.minimumFreeDiskAtStartBytes });
  const peak = { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0 };
  let maximumSinglePageMs = 0;
  const sample = (stage) => {
    const usage = process.memoryUsage();
    peak.rssBytes = Math.max(peak.rssBytes, usage.rss);
    peak.heapUsedBytes = Math.max(peak.heapUsedBytes, usage.heapUsed);
    peak.externalBytes = Math.max(peak.externalBytes, usage.external);
    if (usage.rss > limits.maximumRssBytes) fail('RESOURCE_RSS_BREACH', { stage, observed: usage.rss, limit: limits.maximumRssBytes });
    if (usage.heapUsed > limits.maximumHeapUsedBytes) fail('RESOURCE_HEAP_BREACH', { stage, observed: usage.heapUsed, limit: limits.maximumHeapUsedBytes });
    if (usage.external > limits.maximumExternalBytes) fail('RESOURCE_EXTERNAL_BREACH', { stage, observed: usage.external, limit: limits.maximumExternalBytes });
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs > limits.absoluteMaximumRuntimeMs) fail('RESOURCE_RUNTIME_BREACH', { stage, observed: elapsedMs, limit: limits.absoluteMaximumRuntimeMs });
    return usage;
  };
  const observePage = (pageNumber, elapsedMs) => {
    maximumSinglePageMs = Math.max(maximumSinglePageMs, elapsedMs);
    if (elapsedMs > limits.maximumSinglePageMs) fail('RESOURCE_PAGE_RUNTIME_BREACH', { pageNumber, observed: elapsedMs, limit: limits.maximumSinglePageMs });
    sample(`PAGE_${pageNumber}`);
  };
  const snapshot = () => ({
    start,
    peak,
    maximumSinglePageMs,
    runtimeMs: performance.now() - startedAt,
    universeFullScanCount: 0,
    limits,
  });
  sample('START');
  return { limits, sample, observePage, snapshot, startedAt };
}

function makeHorizonCounter(contract, initial = 0) {
  return Object.fromEntries(contract.horizons.map((entry) => [String(entry.sessionCount), initial]));
}

function addHorizonCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key];
}

function expectedProductNames(contract) {
  return ['MANIFEST.json', ...Array.from({ length: contract.product.pageCount }, (_unused, index) => canonicalPageName(index + 1))];
}

function assertExactProductPathset(root, contract) {
  const observed = sorted(fs.readdirSync(root));
  const expected = sorted(expectedProductNames(contract));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail('PRODUCT_PATHSET_MISMATCH', {
      observedCount: observed.length,
      expectedCount: expected.length,
      extra: observed.filter((name) => !expected.includes(name)).slice(0, 20),
      missing: expected.filter((name) => !observed.includes(name)).slice(0, 20),
    });
  }
}

function validateFullManifest(full, contract) {
  if (full.schema !== 'GATE26_FULL_MANIFEST_V1' || full.productClass !== 'OFF_SCAN' || full.productVersion !== 'GATE26_FULL_PRODUCT_V1'
    || full.pageCount !== contract.product.pageCount
    || full.pageSize !== contract.product.pageSize || full.cohort?.queryCount !== contract.product.queryCount
    || full.cohort?.cohortDigest !== contract.canonicalBindings.cohortDigest
    || full.cohort?.sourceSha256 !== contract.canonicalBindings.gate25AnalogueIndexSha256
    || full.inputBinding?.datasetId !== contract.canonicalBindings.datasetId
    || full.inputBinding?.calendarRegistryManifestId !== contract.canonicalBindings.calendarRegistryManifestId
    || !Array.isArray(full.pages) || full.pages.length !== contract.product.pageCount) {
    fail('GATE26_FULL_MANIFEST_BINDING_MISMATCH');
  }
  for (let index = 0; index < full.pages.length; index += 1) {
    const page = full.pages[index];
    if (page.pageNumber !== index + 1 || page.provenance?.path !== `PROVENANCE_PAGE_${String(index + 1).padStart(4, '0')}.json`
      || !SHA256_HEX.test(page.provenance?.sha256 ?? '') || page.provenance.sha256 !== page.provenance.lfsOid
      || !Number.isInteger(page.provenance?.byteLength) || page.provenance.byteLength <= 0) {
      fail('GATE26_FULL_PROVENANCE_DESCRIPTOR_INVALID', { pageNumber: index + 1 });
    }
  }
}

function validateFullProvenancePage(page, descriptor, full, previousId) {
  const fields = [
    'cohortDigest', 'engineVersion', 'firstAnalogueIdentityId', 'firstQueryOrdinal', 'inputBindingSha256',
    'lastAnalogueIdentityId', 'lastQueryOrdinal', 'pageCount', 'pageNumber', 'pageSize', 'pairedEnsemblePage',
    'productVersion', 'queryCount', 'recordCount', 'records', 'schema',
  ];
  assertExactKeys(page, fields, 'GATE26_PROVENANCE_PAGE_SCHEMA_NOT_CLOSED');
  if (page.schema !== 'GATE26_FULL_PROVENANCE_PAGE_V1' || page.pageNumber !== descriptor.pageNumber
    || page.pageCount !== full.pageCount || page.pageSize !== full.pageSize || page.queryCount !== full.cohort.queryCount
    || page.cohortDigest !== full.cohort.cohortDigest || page.recordCount !== descriptor.recordCount
    || page.records.length !== page.recordCount || page.firstQueryOrdinal !== descriptor.firstQueryOrdinal
    || page.lastQueryOrdinal !== descriptor.lastQueryOrdinal || page.firstAnalogueIdentityId !== descriptor.firstAnalogueIdentityId
    || page.lastAnalogueIdentityId !== descriptor.lastAnalogueIdentityId) {
    fail('GATE26_PROVENANCE_PAGE_BINDING_MISMATCH', { pageNumber: descriptor.pageNumber });
  }
  let prior = previousId;
  for (const record of page.records) {
    if (typeof record.queryIdentityId !== 'string' || !SHA256_HEX.test(record.queryIdentityId)
      || (prior !== null && !(record.queryIdentityId > prior))) {
      fail('GATE26_PROVENANCE_QUERY_ORDER_INVALID', { pageNumber: descriptor.pageNumber, prior, observed: record.queryIdentityId });
    }
    prior = record.queryIdentityId;
  }
  return prior;
}

function initializeCheckpoint({ contract, head, fullManifestSha256 }) {
  return {
    document: 'GATE27_NUMERIC_OUTCOME_EXPORT_BUILD_CHECKPOINT_V1',
    productVersion: PRODUCT_VERSION,
    baseHead: head,
    cohortDigest: contract.canonicalBindings.cohortDigest,
    fullManifestSha256,
    completedPageCount: 0,
    status: 'IN_PROGRESS',
  };
}

function validateCheckpoint(checkpoint, expected) {
  assertExactKeys(checkpoint, Object.keys(expected), 'RESUME_CHECKPOINT_SCHEMA_NOT_CLOSED');
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'completedPageCount' || key === 'status') continue;
    if (checkpoint[key] !== value) fail('RESUME_CHECKPOINT_BINDING_MISMATCH', { key, expected: value, observed: checkpoint[key] });
  }
  if (!Number.isInteger(checkpoint.completedPageCount) || checkpoint.completedPageCount < 0 || checkpoint.completedPageCount > LOCAL_CONTRACTS.contract.product.pageCount) {
    fail('RESUME_CHECKPOINT_PAGE_COUNT_INVALID', checkpoint.completedPageCount);
  }
  if (!['IN_PROGRESS', 'COMPLETE'].includes(checkpoint.status)) fail('RESUME_CHECKPOINT_STATUS_INVALID', checkpoint.status);
}

function outcomeSetIdDigestStart() {
  return crypto.createHash('sha256').update(`${PRODUCT_VERSION}\n`, 'utf8');
}

export function computeOutcomeSetIdDigest(outcomeSetIds) {
  const hash = outcomeSetIdDigestStart();
  for (const outcomeSetId of outcomeSetIds) hash.update(`${exactId(outcomeSetId, 'OUTCOME_SET_ID_INVALID')}\n`, 'utf8');
  return hash.digest('hex');
}

export function validateCompactQueryTuple(tuple, horizonCount = 4) {
  if (!Array.isArray(tuple) || tuple.length !== 5) fail('QUERY_TUPLE_INVALID');
  const [queryIdentityId, knowledgeCutoff, selectionDigest, outcomeSetId, analogues] = tuple;
  exactId(queryIdentityId, 'QUERY_ID_INVALID');
  canonicalInstant(knowledgeCutoff, 'QUERY_CUTOFF_INVALID');
  exactId(selectionDigest, 'SELECTION_DIGEST_INVALID');
  exactId(outcomeSetId, 'OUTCOME_SET_ID_INVALID');
  if (!Array.isArray(analogues)) fail('ANALOGUE_TUPLES_INVALID');
  for (const analogue of analogues) {
    if (!Array.isArray(analogue) || analogue.length !== 2) fail('ANALOGUE_TUPLE_INVALID');
    exactId(analogue[0], 'ANALOGUE_ID_INVALID');
    if (!Array.isArray(analogue[1]) || analogue[1].length !== horizonCount) fail('HORIZON_CELL_COUNT_INVALID');
    for (const cell of analogue[1]) {
      if (cell === null) continue;
      if (!Array.isArray(cell) || cell.length !== 2 || typeof cell[0] !== 'number' || !Number.isFinite(cell[0]) || Object.is(cell[0], -0)) {
        fail('AVAILABLE_CELL_INVALID', cell);
      }
      canonicalInstant(cell[1], 'OUTCOME_AVAILABLE_AT_INVALID');
      if (Date.parse(cell[1]) > Date.parse(knowledgeCutoff)) fail('OUTCOME_AVAILABLE_AFTER_KNOWLEDGE_CUTOFF', { queryIdentityId, outcomeAvailableAt: cell[1], knowledgeCutoff });
    }
  }
  return tuple;
}

export function expandCompactQueryTuple(tuple, { horizonIds, sourceBindingId }) {
  validateCompactQueryTuple(tuple, horizonIds.length);
  exactId(sourceBindingId, 'SOURCE_BINDING_ID_INVALID', true);
  const [queryIdentityId, knowledgeCutoff, selectionDigest, outcomeSetId, analogues] = tuple;
  const records = [];
  for (const [analogueIdentityId, cells] of analogues) {
    cells.forEach((cell, index) => records.push({
      analogueIdentityId,
      horizonId: horizonIds[index],
      selectionComplete: true,
      outcomeStatus: cell === null ? 'MISSING' : 'AVAILABLE',
      outcomeValue: cell === null ? null : cell[0],
      outcomeAvailableAt: cell === null ? null : cell[1],
      sourceBindingId,
    }));
  }
  return {
    queryIdentityId,
    knowledgeCutoff,
    outcomeSetId,
    outcomeSet: {
      artifactId: OUTCOME_SET_ARTIFACT_ID,
      recordGranularity: RECORD_GRANULARITY,
      selectionDigest,
      horizonIds: [...horizonIds],
      records,
    },
  };
}

export function validatePageShape(page, contract = LOCAL_CONTRACTS.contract) {
  assertExactKeys(page, contract.closedObjectFields.page, 'OUTPUT_PAGE_SCHEMA_NOT_CLOSED');
  assertExactKeys(page.pairedFullProvenancePage, contract.closedObjectFields.pairedFullProvenancePage, 'PROVENANCE_PAIR_SCHEMA_NOT_CLOSED');
  if (page.schema !== PAGE_SCHEMA || page.productVersion !== PRODUCT_VERSION || page.cohortDigest !== contract.canonicalBindings.cohortDigest
    || page.sourceBindingId !== contract.canonicalBindings.sourceBindingId || page.pageCount !== contract.product.pageCount
    || page.pageSize !== contract.product.pageSize || page.queryCount !== contract.product.queryCount
    || !Array.isArray(page.records) || page.records.length !== page.recordCount) fail('OUTPUT_PAGE_BINDING_INVALID', page.pageNumber);
  let cells = 0;
  for (const tuple of page.records) {
    validateCompactQueryTuple(tuple, contract.horizons.length);
    cells += tuple[4].length * contract.horizons.length;
  }
  if (cells !== page.cellCount) fail('OUTPUT_PAGE_CELL_COUNT_INVALID', { expected: cells, observed: page.cellCount });
  return page;
}

export function validateManifestShape(manifest, contract = LOCAL_CONTRACTS.contract) {
  assertExactKeys(manifest, contract.closedObjectFields.manifest, 'OUTPUT_MANIFEST_SCHEMA_NOT_CLOSED');
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.productVersion !== PRODUCT_VERSION || manifest.gateId !== 'GATE27'
    || manifest.contractRevision !== 'R2' || manifest.canonicalOrder !== contract.product.canonicalOrder
    || manifest.pageSize !== contract.product.pageSize || manifest.pageCount !== contract.product.pageCount
    || manifest.cohort?.queryCount !== contract.product.queryCount || manifest.cohort?.cohortDigest !== contract.canonicalBindings.cohortDigest
    || manifest.priceBasis !== 'SPLIT_ADJUSTED' || manifest.returnFormula !== 'Cfin / Cdebut - 1'
    || manifest.negativeZeroRule !== 'NORMALIZE_TO_POSITIVE_ZERO' || manifest.missingEncoding !== null
    || manifest.sourceBindingId !== contract.canonicalBindings.sourceBindingId
    || manifest.outcomeSetIdDigest !== contract.canonicalBindings.outcomeSetIdDigest
    || !Array.isArray(manifest.pages) || manifest.pages.length !== contract.product.pageCount) fail('OUTPUT_MANIFEST_BINDING_INVALID');
  return manifest;
}

function prepareRawInputs({ repositoryRoot, runtime, contract, telemetry }) {
  const { canonical, engine, temporal, queryCohort, calendar } = runtime;
  const fullManifestPath = repositoryPath(repositoryRoot, contract.canonicalBindings.gate26FullManifestPath);
  const fullManifestBytes = fs.readFileSync(fullManifestPath);
  const fullManifestSha256 = sha256Bytes(fullManifestBytes);
  if (fullManifestSha256 !== contract.canonicalBindings.gate26FullManifestSha256
    || fullManifestBytes.length !== contract.canonicalBindings.gate26FullManifestByteLength) {
    fail('GATE26_FULL_MANIFEST_IDENTITY_MISMATCH', { sha256: fullManifestSha256, byteLength: fullManifestBytes.length });
  }
  const fullManifest = JSON.parse(fullManifestBytes.toString('utf8'));
  validateFullManifest(fullManifest, contract);

  const authority = engine.loadGate25BuildAuthority({ root: repositoryRoot });
  const p3h = engine.loadP3hDatasetBinding({ authority, finalizationPath: authority.p3hFinalizationPath });
  if (p3h.datasetId !== contract.canonicalBindings.datasetId || p3h.datasetSha256 !== contract.canonicalBindings.datasetId.slice(7)) {
    fail('P3H_DATASET_BINDING_MISMATCH');
  }
  const historicalCalendar = engine.loadHistoricalWindowCalendar({ authority, root: repositoryRoot });
  const horizonCalendar = calendar.loadJarviseHistoricalCalendarR1({ root: repositoryRoot }).sessions
    .map((session) => ({ sessionDate: session.sessionDate, sessionKind: session.sessionKind }));
  if (historicalCalendar.calendarRegistryManifestId !== contract.canonicalBindings.calendarRegistryManifestId) fail('CALENDAR_REGISTRY_BINDING_MISMATCH');
  if (JSON.stringify(temporal.HORIZONS_V1) !== JSON.stringify(contract.horizons.map((entry) => entry.sessionCount))) fail('HORIZON_SESSION_COUNTS_MISMATCH');

  const barSessions = historicalCalendar.sessions;
  const barIndex = new Map(barSessions.map((session, index) => [session.sessionDate, index]));
  const pinnedCutoffMs = new Map(barSessions.map((session) => [session.sessionDate, session.knowledgeCutoffMs]));
  const horizonCalendarIndex = new Map(horizonCalendar.map((session, index) => [session.sessionDate, index]));
  const keys = new Map();
  const sourceBindingIds = new Set();
  for (const entry of p3h.admittedEntries) {
    const snapshot = engine.readP3hAdmittedSnapshot({ snapshotRoot: p3h.snapshotRoot, entry });
    const closes = new Float64Array(barSessions.length);
    const available = new Float64Array(barSessions.length);
    closes.fill(Number.NaN);
    available.fill(Number.NaN);
    for (const bar of snapshot.bars) {
      const index = barIndex.get(bar.sessionDate);
      if (index === undefined) fail('P3H_BAR_OUTSIDE_PINNED_WINDOW', { key: entry.acquisitionKey, sessionDate: bar.sessionDate });
      closes[index] = bar.close;
      available[index] = Date.parse(bar.availableAt);
    }
    keys.set(entry.acquisitionKey, { closes, available });
    sourceBindingIds.add(snapshot.sourceBindingId);
    telemetry.sample(`P3H_KEY_${keys.size}`);
  }
  if (sourceBindingIds.size !== 1 || [...sourceBindingIds][0] !== contract.canonicalBindings.sourceBindingId) {
    fail('SOURCE_BINDING_ID_MISMATCH', [...sourceBindingIds]);
  }

  const units = new Map();
  const analogueIndexPath = repositoryPath(repositoryRoot, contract.canonicalBindings.gate25AnalogueIndexPath);
  const indexStats = queryCohort.streamVerifiedIndexRecords({
    path: analogueIndexPath,
    onRecord: (unit) => {
      units.set(unit.analogueIdentityId, {
        sessionDate: unit.sessionDate,
        cutoffMs: Date.parse(unit.knowledgeCutoff),
        keyId: unit.p3hKeyId,
      });
    },
  });
  if (indexStats.sha256 !== contract.canonicalBindings.gate25AnalogueIndexSha256
    || indexStats.queryCount !== contract.product.queryCount || indexStats.cohortDigest !== contract.canonicalBindings.cohortDigest
    || units.size !== contract.product.queryCount) fail('ANALOGUE_INDEX_BINDING_MISMATCH', indexStats);
  telemetry.sample('ANALOGUE_INDEX_STREAMED');

  return {
    canonical,
    simpleReturn: null,
    fullManifest,
    fullManifestSha256,
    fullRoot: path.dirname(fullManifestPath),
    barSessions,
    barIndex,
    pinnedCutoffMs,
    horizonCalendar,
    horizonCalendarIndex,
    sessionKinds: temporal.SESSION_KINDS_V1,
    keys,
    units,
    sourceBindingId: [...sourceBindingIds][0],
    indexStats,
    p3hAdmittedKeyCount: p3h.admittedEntries.length,
  };
}

function rebuildOutcome({ analogueIdentityId, binding, queryCutoffMs, querySessionDate, inputs }) {
  const missing = { cell: null, kind: 'UNRESOLVABLE', expanded: null, predated: false };
  const unit = inputs.units.get(analogueIdentityId);
  if (!unit) return missing;
  const bars = inputs.keys.get(unit.keyId);
  const calendarStart = inputs.horizonCalendarIndex.get(unit.sessionDate);
  const historicalStart = inputs.barIndex.get(unit.sessionDate);
  if (!bars || calendarStart === undefined || historicalStart === undefined) return missing;
  const window = inputs.horizonCalendar.slice(calendarStart + 1, calendarStart + 1 + binding.sessionCount);
  if (window.length !== binding.sessionCount || window.some((session) => !inputs.sessionKinds.includes(session.sessionKind))) return missing;
  const indices = [historicalStart];
  for (const session of window) {
    const index = inputs.barIndex.get(session.sessionDate);
    if (index === undefined) return missing;
    indices.push(index);
  }
  let maximumAvailableAtMs = -Infinity;
  let predated = false;
  for (const index of indices) {
    const close = bars.closes[index];
    const availableAtMs = bars.available[index];
    if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(availableAtMs)) return missing;
    if (availableAtMs < inputs.barSessions[index].knowledgeCutoffMs) predated = true;
    maximumAvailableAtMs = Math.max(maximumAvailableAtMs, availableAtMs);
  }
  const endSessionDate = window.at(-1).sessionDate;
  const endPinnedCutoffMs = inputs.pinnedCutoffMs.get(endSessionDate);
  const mature = maximumAvailableAtMs <= queryCutoffMs
    && endPinnedCutoffMs <= queryCutoffMs
    && endSessionDate <= querySessionDate
    && !predated;
  if (!mature) return { cell: null, kind: 'IMMATURE', expanded: null, predated, endSessionDate, maximumAvailableAtMs, endPinnedCutoffMs };
  const rawValue = bars.closes[indices.at(-1)] / bars.closes[indices[0]] - 1;
  if (!Number.isFinite(rawValue)) fail('OUTCOME_VALUE_NOT_FINITE', { analogueIdentityId, horizonId: binding.horizonId });
  const outcomeValue = rawValue === 0 ? 0 : rawValue;
  const outcomeAvailableAt = new Date(maximumAvailableAtMs).toISOString();
  return {
    cell: [outcomeValue, outcomeAvailableAt],
    kind: 'AVAILABLE',
    predated,
    endSessionDate,
    maximumAvailableAtMs,
    endPinnedCutoffMs,
    slackMs: queryCutoffMs - maximumAvailableAtMs,
    calendarSlackMs: queryCutoffMs - endPinnedCutoffMs,
  };
}

function expandedRecord({ analogueIdentityId, binding, rebuilt, sourceBindingId }) {
  return {
    analogueIdentityId,
    horizonId: binding.horizonId,
    selectionComplete: true,
    outcomeStatus: rebuilt.cell === null ? 'MISSING' : 'AVAILABLE',
    outcomeValue: rebuilt.cell === null ? null : rebuilt.cell[0],
    outcomeAvailableAt: rebuilt.cell === null ? null : rebuilt.cell[1],
    sourceBindingId,
  };
}

function buildManifest({ contract, fullManifest, pageDescriptors, totals, outcomeSetIdDigest }) {
  return {
    schema: MANIFEST_SCHEMA,
    productVersion: PRODUCT_VERSION,
    gateId: 'GATE27',
    contractRevision: 'R2',
    canonicalOrder: contract.product.canonicalOrder,
    cohort: {
      queryCount: contract.product.queryCount,
      cohortDigest: contract.canonicalBindings.cohortDigest,
      firstQueryIdentityId: fullManifest.cohort.firstAnalogueIdentityId,
      lastQueryIdentityId: fullManifest.cohort.lastAnalogueIdentityId,
    },
    pageSize: contract.product.pageSize,
    pageCount: contract.product.pageCount,
    horizons: contract.horizons.map((entry) => ({ ...entry })),
    priceBasis: 'SPLIT_ADJUSTED',
    returnFormula: 'Cfin / Cdebut - 1',
    negativeZeroRule: 'NORMALIZE_TO_POSITIVE_ZERO',
    missingEncoding: null,
    sourceBindingId: contract.canonicalBindings.sourceBindingId,
    inputBinding: {
      baseHead: contract.canonicalBindings.baseHead,
      gate26FullManifestPath: contract.canonicalBindings.gate26FullManifestPath,
      gate26FullManifestSha256: contract.canonicalBindings.gate26FullManifestSha256,
      gate25AnalogueIndexPath: contract.canonicalBindings.gate25AnalogueIndexPath,
      gate25AnalogueIndexSha256: contract.canonicalBindings.gate25AnalogueIndexSha256,
      datasetId: contract.canonicalBindings.datasetId,
      calendarRegistryManifestId: contract.canonicalBindings.calendarRegistryManifestId,
      maturityProofScriptSha256: contract.canonicalBindings.maturityProof.scriptSha256,
      maturityProofReportSha256: contract.canonicalBindings.maturityProof.reportSha256,
    },
    recordCounts: {
      queries: totals.queries,
      analogues: totals.analogues,
      cells: totals.cells,
      available: totals.available,
      missing: totals.missing,
      availableByHorizon: totals.availableByHorizon,
      missingByHorizon: totals.missingByHorizon,
      outcomeSetIdMatched: totals.outcomeSetIdMatched,
      outcomeSetIdMismatched: totals.outcomeSetIdMismatched,
    },
    outcomeSetIdDigest,
    pages: pageDescriptors,
  };
}

function checkpointBytes(checkpoint) {
  return jsonEvidenceBytes(checkpoint);
}

async function executeNumericOutcomeExport({
  repositoryRoot,
  candidateRoot,
  checkpointRoot = null,
  evidenceRoot,
  mode,
  resume = false,
  faultAfterPage = null,
}) {
  const root = path.resolve(repositoryRoot);
  const candidate = path.resolve(candidateRoot);
  const evidence = path.resolve(evidenceRoot);
  const { contract, resource } = LOCAL_CONTRACTS;
  if (!['BUILD', 'VALIDATE'].includes(mode)) fail('EXECUTION_MODE_INVALID', mode);
  assertOutsideRepository(root, candidate, 'CANDIDATE_ROOT_INSIDE_REPOSITORY_FORBIDDEN');
  assertOutsideRepository(root, evidence, 'EVIDENCE_ROOT_INSIDE_REPOSITORY_FORBIDDEN');
  const outputRoot = productPath(candidate);
  const checkpointFile = checkpointRoot ? path.join(path.resolve(checkpointRoot), 'CHECKPOINT.json') : null;
  if (mode === 'BUILD' && !checkpointFile) fail('CHECKPOINT_ROOT_REQUIRED');
  if (checkpointRoot) assertOutsideRepository(root, checkpointRoot, 'CHECKPOINT_ROOT_INSIDE_REPOSITORY_FORBIDDEN');

  const head = readHead(root);
  if (head !== contract.canonicalBindings.baseHead) fail('BUILD_HEAD_MISMATCH', { expected: contract.canonicalBindings.baseHead, observed: head });
  const runtime = await loadRuntime(root);
  const networkCalls = runtime.network.installNetworkTrap();
  const telemetry = createResourceTelemetry({ resource, outputTarget: candidate });

  if (mode === 'BUILD') {
    if (!resume) {
      if (fs.existsSync(outputRoot)) fail('FRESH_BUILD_PRODUCT_ROOT_PRESENT', outputRoot);
      if (fs.existsSync(checkpointFile)) fail('FRESH_BUILD_CHECKPOINT_PRESENT', checkpointFile);
      fs.mkdirSync(outputRoot, { recursive: true });
      fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    } else if (!fs.existsSync(outputRoot) || !fs.existsSync(checkpointFile)) {
      fail('RESUME_STATE_ABSENT', { outputRootPresent: fs.existsSync(outputRoot), checkpointPresent: fs.existsSync(checkpointFile) });
    }
  } else if (!fs.existsSync(outputRoot)) fail('VALIDATION_PRODUCT_ROOT_ABSENT', outputRoot);
  fs.mkdirSync(evidence, { recursive: true });

  const inputs = prepareRawInputs({ repositoryRoot: root, runtime, contract, telemetry });
  const checkpointExpected = initializeCheckpoint({ contract, head, fullManifestSha256: inputs.fullManifestSha256 });
  let checkpoint;
  if (mode === 'BUILD') {
    checkpoint = resume ? readJson(checkpointFile) : checkpointExpected;
    validateCheckpoint(checkpoint, checkpointExpected);
    if (!resume) durableWrite(checkpointFile, checkpointBytes(checkpoint));
  }

  const totals = {
    queries: 0,
    analogues: 0,
    cells: 0,
    available: 0,
    missing: 0,
    availableByHorizon: makeHorizonCounter(contract),
    missingByHorizon: makeHorizonCounter(contract),
    outcomeSetIdMatched: 0,
    outcomeSetIdMismatched: 0,
    immatureResolvable: 0,
    unresolvable: 0,
    m5PredatedBars: 0,
    analogueBeforeQueryViolations: 0,
    minimumOutcomeSlackMs: Infinity,
    minimumCalendarSlackMs: Infinity,
  };
  const pageDescriptors = [];
  const outcomeDigest = outcomeSetIdDigestStart();
  let previousQueryIdentityId = null;
  let productPageBytes = 0;

  for (let pageNumber = 1; pageNumber <= contract.product.pageCount; pageNumber += 1) {
    const pageStartedAt = performance.now();
    const fullDescriptor = inputs.fullManifest.pages[pageNumber - 1];
    const provenancePath = path.join(inputs.fullRoot, fullDescriptor.provenance.path);
    const provenanceBytes = fs.readFileSync(provenancePath);
    if (provenanceBytes.length !== fullDescriptor.provenance.byteLength || sha256Bytes(provenanceBytes) !== fullDescriptor.provenance.sha256) {
      fail('FULL_PROVENANCE_PAGE_IDENTITY_MISMATCH', { pageNumber });
    }
    const provenance = JSON.parse(provenanceBytes.toString('utf8'));
    previousQueryIdentityId = validateFullProvenancePage(provenance, fullDescriptor, inputs.fullManifest, previousQueryIdentityId);
    const pageAvailable = makeHorizonCounter(contract);
    const pageMissing = makeHorizonCounter(contract);
    let pageCellCount = 0;
    const records = [];

    for (const published of provenance.records) {
      const query = inputs.units.get(published.queryIdentityId);
      if (!query) fail('QUERY_NOT_IN_CANONICAL_INDEX', published.queryIdentityId);
      const queryCutoffMs = Date.parse(published.knowledgeCutoff);
      if (!Number.isFinite(queryCutoffMs) || queryCutoffMs !== query.cutoffMs) fail('QUERY_CUTOFF_DIVERGES_FROM_INDEX', published.queryIdentityId);
      if (!Array.isArray(published.analogueIdentityIds)) fail('PUBLISHED_ANALOGUE_ORDER_ABSENT', published.queryIdentityId);
      const expanded = [];
      const compactAnalogues = [];
      for (const analogueIdentityId of published.analogueIdentityIds) {
        const analogue = inputs.units.get(analogueIdentityId);
        if (!analogue || !(analogue.sessionDate < query.sessionDate)) {
          totals.analogueBeforeQueryViolations += 1;
          fail('ANALOGUE_NOT_STRICTLY_BEFORE_QUERY', { queryIdentityId: published.queryIdentityId, analogueIdentityId });
        }
        const cells = [];
        for (const binding of contract.horizons) {
          const rebuilt = rebuildOutcome({ analogueIdentityId, binding, queryCutoffMs, querySessionDate: query.sessionDate, inputs });
          cells.push(rebuilt.cell);
          expanded.push(expandedRecord({ analogueIdentityId, binding, rebuilt, sourceBindingId: inputs.sourceBindingId }));
          const key = String(binding.sessionCount);
          pageCellCount += 1;
          totals.cells += 1;
          if (rebuilt.cell === null) {
            pageMissing[key] += 1;
            totals.missingByHorizon[key] += 1;
            totals.missing += 1;
            if (rebuilt.kind === 'IMMATURE') totals.immatureResolvable += 1;
            else totals.unresolvable += 1;
          } else {
            pageAvailable[key] += 1;
            totals.availableByHorizon[key] += 1;
            totals.available += 1;
            totals.minimumOutcomeSlackMs = Math.min(totals.minimumOutcomeSlackMs, rebuilt.slackMs);
            totals.minimumCalendarSlackMs = Math.min(totals.minimumCalendarSlackMs, rebuilt.calendarSlackMs);
          }
          if (rebuilt.predated) totals.m5PredatedBars += 1;
        }
        compactAnalogues.push([analogueIdentityId, cells]);
        totals.analogues += 1;
      }
      const outcomeSet = {
        artifactId: OUTCOME_SET_ARTIFACT_ID,
        recordGranularity: RECORD_GRANULARITY,
        selectionDigest: published.selectionDigest,
        horizonIds: contract.horizons.map((entry) => entry.horizonId),
        records: expanded,
      };
      const rebuiltOutcomeSetId = inputs.canonical.sha256Canonical(outcomeSet);
      if (rebuiltOutcomeSetId !== published.outcomeSetId) {
        totals.outcomeSetIdMismatched += 1;
        fail('OUTCOME_SET_ID_MISMATCH', { queryIdentityId: published.queryIdentityId, published: published.outcomeSetId, rebuilt: rebuiltOutcomeSetId });
      }
      totals.outcomeSetIdMatched += 1;
      totals.queries += 1;
      outcomeDigest.update(`${rebuiltOutcomeSetId}\n`, 'utf8');
      records.push([published.queryIdentityId, published.knowledgeCutoff, published.selectionDigest, rebuiltOutcomeSetId, compactAnalogues]);
    }

    const relativeProvenancePath = `${contract.canonicalBindings.gate26FullManifestPath.slice(0, -'MANIFEST.json'.length)}${fullDescriptor.provenance.path}`;
    const pairedFullProvenancePage = {
      path: relativeProvenancePath,
      sha256: fullDescriptor.provenance.sha256,
      byteLength: fullDescriptor.provenance.byteLength,
    };
    const page = {
      schema: PAGE_SCHEMA,
      productVersion: PRODUCT_VERSION,
      cohortDigest: contract.canonicalBindings.cohortDigest,
      sourceBindingId: inputs.sourceBindingId,
      pageNumber,
      pageCount: contract.product.pageCount,
      pageSize: contract.product.pageSize,
      queryCount: contract.product.queryCount,
      firstQueryOrdinal: fullDescriptor.firstQueryOrdinal,
      lastQueryOrdinal: fullDescriptor.lastQueryOrdinal,
      firstQueryIdentityId: fullDescriptor.firstAnalogueIdentityId,
      lastQueryIdentityId: fullDescriptor.lastAnalogueIdentityId,
      pairedFullProvenancePage,
      recordCount: records.length,
      cellCount: pageCellCount,
      availableByHorizon: pageAvailable,
      missingByHorizon: pageMissing,
      records,
    };
    validatePageShape(page, contract);
    const pageBytes = Buffer.from(`${inputs.canonical.canonicalize(page)}\n`, 'utf8');
    if (pageBytes.length > telemetry.limits.maximumPageBytes) fail('RESOURCE_PAGE_BYTES_BREACH', { pageNumber, observed: pageBytes.length, limit: telemetry.limits.maximumPageBytes });
    const pageName = canonicalPageName(pageNumber);
    const destination = path.join(outputRoot, pageName);
    const shouldCompare = mode === 'VALIDATE' || (resume && pageNumber <= checkpoint.completedPageCount);
    if (shouldCompare) {
      if (!fs.existsSync(destination)) fail('EXPECTED_OUTPUT_PAGE_ABSENT', pageName);
      const observed = fs.readFileSync(destination);
      if (!observed.equals(pageBytes)) fail('OUTPUT_PAGE_BYTE_MISMATCH', { pageNumber, expectedSha256: sha256Bytes(pageBytes), observedSha256: sha256Bytes(observed) });
    } else {
      if (fs.existsSync(destination)) fail('OUTPUT_PAGE_PREEXISTS_OUTSIDE_RESUME_PREFIX', pageName);
      durableWrite(destination, pageBytes);
      checkpoint.completedPageCount = pageNumber;
      checkpoint.status = 'IN_PROGRESS';
      durableWrite(checkpointFile, checkpointBytes(checkpoint));
    }
    productPageBytes += pageBytes.length;
    pageDescriptors.push({
      path: pageName,
      sha256: sha256Bytes(pageBytes),
      byteLength: pageBytes.length,
      pageNumber,
      recordCount: records.length,
      cellCount: pageCellCount,
      firstQueryOrdinal: fullDescriptor.firstQueryOrdinal,
      lastQueryOrdinal: fullDescriptor.lastQueryOrdinal,
      firstQueryIdentityId: fullDescriptor.firstAnalogueIdentityId,
      lastQueryIdentityId: fullDescriptor.lastAnalogueIdentityId,
      availableByHorizon: pageAvailable,
      missingByHorizon: pageMissing,
      pairedFullProvenancePage,
    });
    telemetry.observePage(pageNumber, performance.now() - pageStartedAt);
    if (mode === 'BUILD' && Number.isInteger(faultAfterPage) && pageNumber === faultAfterPage) {
      fail('SIMULATED_BUILD_INTERRUPT', { pageNumber });
    }
  }

  const outcomeSetIdDigest = outcomeDigest.digest('hex');
  if (outcomeSetIdDigest !== contract.canonicalBindings.outcomeSetIdDigest) {
    fail('OUTCOME_SET_ID_DIGEST_MISMATCH', { expected: contract.canonicalBindings.outcomeSetIdDigest, observed: outcomeSetIdDigest });
  }
  if (totals.queries !== contract.product.queryCount || totals.outcomeSetIdMatched !== contract.product.queryCount
    || totals.outcomeSetIdMismatched !== 0 || totals.m5PredatedBars !== 0 || totals.analogueBeforeQueryViolations !== 0
    || totals.cells !== contract.canonicalBindings.maturityProof.perAnalogueHorizonRecordCount
    || totals.available !== contract.canonicalBindings.maturityProof.availableOutcomeCount
    || totals.missing !== contract.canonicalBindings.maturityProof.missingOutcomeCount) {
    fail('CANONICAL_TOTALS_MISMATCH', totals);
  }
  if (networkCalls.length !== 0) fail('NETWORK_ATTEMPT_OBSERVED', networkCalls);
  const manifest = buildManifest({ contract, fullManifest: inputs.fullManifest, pageDescriptors, totals, outcomeSetIdDigest });
  validateManifestShape(manifest, contract);
  const manifestBytes = Buffer.from(`${inputs.canonical.canonicalize(manifest)}\n`, 'utf8');
  if (manifestBytes.length > telemetry.limits.maximumPageBytes) fail('RESOURCE_MANIFEST_BYTES_BREACH', { observed: manifestBytes.length, limit: telemetry.limits.maximumPageBytes });
  const manifestFile = path.join(outputRoot, 'MANIFEST.json');
  if (mode === 'VALIDATE') {
    const observed = fs.readFileSync(manifestFile);
    if (!observed.equals(manifestBytes)) fail('OUTPUT_MANIFEST_BYTE_MISMATCH', { expectedSha256: sha256Bytes(manifestBytes), observedSha256: sha256Bytes(observed) });
  } else {
    if (resume && checkpoint.status === 'COMPLETE') {
      const observed = fs.readFileSync(manifestFile);
      if (!observed.equals(manifestBytes)) fail('COMPLETED_RESUME_MANIFEST_MISMATCH');
    } else {
      if (fs.existsSync(manifestFile)) fail('OUTPUT_MANIFEST_PREEXISTS');
      durableWrite(manifestFile, manifestBytes);
      checkpoint.completedPageCount = contract.product.pageCount;
      checkpoint.status = 'COMPLETE';
      durableWrite(checkpointFile, checkpointBytes(checkpoint));
    }
  }
  const totalProductBytes = productPageBytes + manifestBytes.length;
  if (totalProductBytes > telemetry.limits.maximumTotalProductBytes) fail('RESOURCE_TOTAL_PRODUCT_BYTES_BREACH', { observed: totalProductBytes, limit: telemetry.limits.maximumTotalProductBytes });
  assertExactProductPathset(outputRoot, contract);
  telemetry.sample('COMPLETE');
  const resourceSnapshot = telemetry.snapshot();
  if (resourceSnapshot.runtimeMs > telemetry.limits.absoluteMaximumRuntimeMs) fail('RESOURCE_RUNTIME_BREACH', resourceSnapshot.runtimeMs);
  const report = {
    document: mode === 'BUILD' ? 'GATE27_NUMERIC_OUTCOME_EXPORT_BUILD_REPORT_R1' : 'GATE27_NUMERIC_OUTCOME_EXPORT_VALIDATION_REPORT_R1',
    verdict: mode === 'BUILD' ? 'BUILT' : 'VALID',
    mode,
    resumed: resume,
    baseHead: head,
    candidateRoot: candidate,
    productRoot: outputRoot,
    manifestSha256: sha256Bytes(manifestBytes),
    manifestBytes: manifestBytes.length,
    outputFileCount: contract.product.expectedDataPathCount,
    totalProductBytes,
    cohortDigest: contract.canonicalBindings.cohortDigest,
    outcomeSetIdDigest,
    sourceBindingId: inputs.sourceBindingId,
    counts: totals,
    pageCount: pageDescriptors.length,
    networkCalls,
    tooling: {
      yahoo: false,
      producerOutcomePathInvoked: false,
      gate26ProducerInvoked: false,
      selectionInvoked: false,
      p3hSnapshotReads: inputs.p3hAdmittedKeyCount,
      analogueIndexPassCount: 1,
      fullProvenancePageReads: contract.product.pageCount,
      universeFullScanCount: 0,
    },
    resources: resourceSnapshot,
  };
  const reportName = mode === 'BUILD' ? 'BUILD_REPORT.json' : 'VALIDATION_REPORT.json';
  durableWrite(path.join(evidence, reportName), jsonEvidenceBytes(report));
  return { report, manifest };
}

export async function buildNumericOutcomeExport(options) {
  return executeNumericOutcomeExport({ ...options, mode: 'BUILD' });
}

export async function validateNumericOutcomeExport(options) {
  return executeNumericOutcomeExport({ ...options, mode: 'VALIDATE', resume: false, checkpointRoot: null });
}

export function compareCandidateTrees(leftRoot, rightRoot) {
  const walk = (root, current = root) => {
    const result = [];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) result.push(...walk(root, absolute));
      else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join('/'));
      else fail('CANDIDATE_NON_FILE_ENTRY', absolute);
    }
    return result;
  };
  const leftNames = sorted(walk(path.resolve(leftRoot)));
  const rightNames = sorted(walk(path.resolve(rightRoot)));
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) {
    return { identical: false, reason: 'PATHSET', leftCount: leftNames.length, rightCount: rightNames.length };
  }
  for (const name of leftNames) {
    const leftBytes = fs.readFileSync(path.join(leftRoot, ...name.split('/')));
    const rightBytes = fs.readFileSync(path.join(rightRoot, ...name.split('/')));
    if (!leftBytes.equals(rightBytes)) return { identical: false, reason: 'BYTES', path: name, leftSha256: sha256Bytes(leftBytes), rightSha256: sha256Bytes(rightBytes) };
  }
  return { identical: true, pathCount: leftNames.length };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function cli() {
  const args = process.argv.slice(2);
  const repositoryRoot = option(args, '--repository-root');
  const candidateRoot = option(args, '--candidate-root');
  const checkpointRoot = option(args, '--checkpoint-root');
  const evidenceRoot = option(args, '--evidence-root');
  const validate = args.includes('--validate');
  const resume = args.includes('--resume');
  const faultRaw = option(args, '--fault-after-page');
  const faultAfterPage = faultRaw === null ? null : Number(faultRaw);
  if (!repositoryRoot || !candidateRoot || !evidenceRoot || (!validate && !checkpointRoot)) {
    process.stdout.write('usage: numeric-outcome-export-v1.mjs --repository-root <dir> --candidate-root <dir> --evidence-root <dir> [--checkpoint-root <dir>] [--resume] [--validate] [--fault-after-page N]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = validate
      ? await validateNumericOutcomeExport({ repositoryRoot, candidateRoot, evidenceRoot })
      : await buildNumericOutcomeExport({ repositoryRoot, candidateRoot, checkpointRoot, evidenceRoot, resume, faultAfterPage });
    process.stdout.write(`${JSON.stringify({ verdict: result.report.verdict, report: path.join(path.resolve(evidenceRoot), validate ? 'VALIDATION_REPORT.json' : 'BUILD_REPORT.json'), manifestSha256: result.report.manifestSha256, totalProductBytes: result.report.totalProductBytes })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ verdict: 'STOP', code: error?.code ?? 'UNEXPECTED_ERROR', detail: error?.detail ?? error?.message })}\n`);
    process.exitCode = error?.code === 'SIMULATED_BUILD_INTERRUPT' ? 86 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
