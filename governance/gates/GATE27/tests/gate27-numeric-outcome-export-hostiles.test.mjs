import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeOutcomeSetIdDigest,
  expandCompactQueryTuple,
  validateCompactQueryTuple,
  validateManifestShape,
  validatePageShape,
} from '../implementation/numeric-outcome-export-v1.mjs';
import { readNumericOutcomeForDecision } from '../implementation/numeric-outcome-consumer-v1.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const SOURCE = 'sha256:04d3e217eb0303a506a112c40e00732ffb0586d6aa37b717464c49ea0b05282b';
const CUTOFF = '2025-01-02T21:00:00.000Z';
const HORIZONS = [30, 90, 180, 252].map((count) => `${count}:sha256:3df426b405f9ae43cb996b14f310d8efed55ce9f6377ed68dea4cd6ef939883f`);

const tuple = () => [ID_A, CUTOFF, ID_B, ID_A, [[ID_B, [null, null, null, null]]]];
const page = () => ({
  schema: 'GATE27_NUMERIC_OUTCOME_PAGE_V1',
  productVersion: 'GATE27_NUMERIC_OUTCOME_EXPORT_V1',
  cohortDigest: '7ca9a18c4608c07be752cfdce8e3cbbc01ec343da85da7c710d0143705e336fb',
  sourceBindingId: SOURCE,
  pageNumber: 1,
  pageCount: 536,
  pageSize: 128,
  queryCount: 68562,
  firstQueryOrdinal: 1,
  lastQueryOrdinal: 1,
  firstQueryIdentityId: ID_A,
  lastQueryIdentityId: ID_A,
  pairedFullProvenancePage: { path: 'data/jarvise/predictive-ensemble/GATE26/V1/FULL/PROVENANCE_PAGE_0001.json', sha256: ID_A, byteLength: 1 },
  recordCount: 1,
  cellCount: 4,
  availableByHorizon: { 30: 0, 90: 0, 180: 0, 252: 0 },
  missingByHorizon: { 30: 1, 90: 1, 180: 1, 252: 1 },
  records: [tuple()],
});

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, code);
}

test('G27-H01 closed page schema rejects probability additions', () => {
  const hostile = page();
  hostile.probability = 0.9;
  throwsCode(() => validatePageShape(hostile), 'OUTPUT_PAGE_SCHEMA_NOT_CLOSED');
});

test('G27-H02 closed manifest schema rejects confidence additions before acceptance', () => {
  const hostile = {
    schema: 'GATE27_NUMERIC_OUTCOME_EXPORT_MANIFEST_V1', productVersion: 'GATE27_NUMERIC_OUTCOME_EXPORT_V1', gateId: 'GATE27', contractRevision: 'R2',
    canonicalOrder: 'queryIdentityId_ASCII_ASCENDING', cohort: {}, pageSize: 128, pageCount: 536, horizons: [], priceBasis: 'SPLIT_ADJUSTED',
    returnFormula: 'Cfin / Cdebut - 1', negativeZeroRule: 'NORMALIZE_TO_POSITIVE_ZERO', missingEncoding: null, sourceBindingId: SOURCE,
    inputBinding: {}, recordCounts: {}, outcomeSetIdDigest: ID_A, pages: [], confidence: 1,
  };
  throwsCode(() => validateManifestShape(hostile), 'OUTPUT_MANIFEST_SCHEMA_NOT_CLOSED');
});

test('G27-H03 query and analogue tuple arity is closed', () => {
  const hostile = tuple();
  hostile.push('extra');
  throwsCode(() => validateCompactQueryTuple(hostile), 'QUERY_TUPLE_INVALID');
  const second = tuple();
  second[4][0].push('extra');
  throwsCode(() => validateCompactQueryTuple(second), 'ANALOGUE_TUPLE_INVALID');
});

test('G27-H04 MISSING is null only; a pseudo-cell with null members is rejected', () => {
  const hostile = tuple();
  hostile[4][0][1][0] = [null, null];
  throwsCode(() => validateCompactQueryTuple(hostile), 'AVAILABLE_CELL_INVALID');
});

test('G27-H05 negative zero is rejected instead of silently stored', () => {
  const hostile = tuple();
  hostile[4][0][1][0] = [-0, '2025-01-02T20:00:00.000Z'];
  throwsCode(() => validateCompactQueryTuple(hostile), 'AVAILABLE_CELL_INVALID');
});

test('G27-H06 future leakage is rejected when outcomeAvailableAt exceeds KnowledgeCutoff', () => {
  const hostile = tuple();
  hostile[4][0][1][0] = [0.1, '2025-01-03T21:00:00.000Z'];
  throwsCode(() => validateCompactQueryTuple(hostile), 'OUTCOME_AVAILABLE_AFTER_KNOWLEDGE_CUTOFF');
});

test('G27-H07 non-canonical timestamp and non-finite value are rejected', () => {
  const timestamp = tuple();
  timestamp[4][0][1][0] = [0.1, '2025-01-02T21:00:00Z'];
  throwsCode(() => validateCompactQueryTuple(timestamp), 'OUTCOME_AVAILABLE_AT_INVALID');
  const numeric = tuple();
  numeric[4][0][1][0] = [Number.NaN, '2025-01-02T20:00:00.000Z'];
  throwsCode(() => validateCompactQueryTuple(numeric), 'AVAILABLE_CELL_INVALID');
});

test('G27-H08 expanded MISSING records carry null value and null availability', () => {
  const expanded = expandCompactQueryTuple(tuple(), { horizonIds: HORIZONS, sourceBindingId: SOURCE });
  assert.equal(expanded.outcomeSet.records.length, 4);
  for (const record of expanded.outcomeSet.records) {
    assert.equal(record.outcomeStatus, 'MISSING');
    assert.equal(record.outcomeValue, null);
    assert.equal(record.outcomeAvailableAt, null);
  }
});

test('G27-H09 OutcomeSetId digest uses the domain-separated canonical order', () => {
  const expected = crypto.createHash('sha256').update(`GATE27_NUMERIC_OUTCOME_EXPORT_V1\n${ID_A}\n${ID_B}\n`, 'utf8').digest('hex');
  assert.equal(computeOutcomeSetIdDigest([ID_A, ID_B]), expected);
  assert.notEqual(computeOutcomeSetIdDigest([ID_B, ID_A]), expected);
});

test('G27-H10 page cell count tampering is rejected', () => {
  const hostile = page();
  hostile.cellCount = 3;
  throwsCode(() => validatePageShape(hostile), 'OUTPUT_PAGE_CELL_COUNT_INVALID');
});

test('G27-H11 Wheel scan parsing is forbidden before any filesystem read', () => {
  let reads = 0;
  throwsCode(() => readNumericOutcomeForDecision({
    candidateRoot: 'unused',
    request: { requestKind: 'WHEEL_SCAN', queryIdentityId: ID_A, decisionCutoff: CUTOFF },
    readFile: () => { reads += 1; throw new Error('should not read'); },
  }), 'WHEEL_SCAN_PARSE_FORBIDDEN');
  assert.equal(reads, 0);
});

test('G27-H12 resource limits are exact and not loosened', () => {
  const resource = JSON.parse(fs.readFileSync(path.resolve(HERE, '../contracts/GATE27_NUMERIC_OUTCOME_EXPORT_RESOURCE_BUDGET_V1.json'), 'utf8'));
  assert.deepEqual(resource.limits, {
    maximumRssBytes: 1610612736,
    maximumHeapUsedBytes: 1073741824,
    maximumExternalBytes: 268435456,
    maximumUniverseFullScanCount: 0,
    maximumSinglePageMs: 60000,
    absoluteMaximumRuntimeMs: 600000,
    maximumPageBytes: 3145728,
    maximumTotalProductBytes: 52428800,
    minimumFreeRamAtStartBytes: 1073741824,
    minimumFreeDiskAtStartBytes: 536870912,
  });
});
