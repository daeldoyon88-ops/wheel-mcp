import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import { CANONICAL_DAILY_BARS_SCHEMA_VERSION } from '../src/canonical/canonicalDailyBarsV1.mjs';
import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  datasetSnapshotCoreProblems,
  datasetSnapshotRecordProblems,
  normalizeDatasetSnapshotCoreV1,
  normalizeDatasetSnapshotRecordV1,
  validateDatasetSnapshotCore,
  validateDatasetSnapshotRecord,
} from '../src/contracts/datasetSnapshotV1.mjs';
import {
  buildDatasetSnapshot,
  datasetSnapshotCoreId,
  datasetSnapshotRecordId,
  verifyDatasetSnapshot,
} from '../src/data/buildDatasetSnapshot.mjs';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function code(expected) {
  return (error) => error && error.code === expected;
}

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-snapshot-'));
  try { return fn(createContentAddressedStore({ root }), root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function normalizedBars(close = 31) {
  return {
    schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION,
    bars: [{
      sessionDate: '2026-04-01', eventTime: '2026-04-01T20:00:00Z', availableAt: '2026-04-01T20:00:00Z',
      open: 30, high: 32, low: 29, close, volume: null,
      corporateActions: { splitFactor: null, cashDividend: null }, qualityFlags: ['SYNTHETIC', 'VOLUME_MISSING'],
    }],
  };
}

function coreFields(overrides = {}) {
  return {
    canonicalSymbol: 'SYNTH', providerId: 'fixture-provider', providerSymbol: 'SYNTH', sourceFormat: 'SYNTHETIC_JSON_V1',
    adapterVersion: 'syntheticAdapter/1', adapterOptions: { orderedColumns: ['date', 'close'], delimiter: ',' },
    normalizerVersion: 'canonicalDailyBars/1', normalizationOptions: { timezone: 'UTC' },
    canonicalSerializationVersion: 'CanonicalJSON/1', priceBasis: 'RAW', corporateActionPolicyHash: HASH_A,
    calendarId: 'SYNTHETIC_WEEKDAY', calendarVersion: 'calendar/1', transformImplementationHash: HASH_B,
    ...overrides,
  };
}

function recordFields(overrides = {}) {
  return {
    sourceAcquiredAt: null,
    ingestedIntoLabAt: '2026-07-18T14:00:00Z',
    acquisitionMethod: 'synthetic-fixture',
    acquisitionToolVersion: 'fixture-tool/1',
    acquisitionRequestIdentity: { orderedSteps: ['create', 'ingest'], request: 'fixture-only' },
    acquisitionEvidenceIds: [HASH_B, HASH_A, HASH_B],
    ...overrides,
  };
}

function build(store, overrides = {}) {
  return buildDatasetSnapshot({
    store,
    sourceBytes: overrides.sourceBytes ?? Buffer.from('{"synthetic":true}\r\n', 'utf8'),
    normalizedDailyBars: overrides.normalizedDailyBars ?? normalizedBars(),
    core: coreFields(overrides.core),
    record: recordFields(overrides.record),
    humanNotes: overrides.humanNotes,
  });
}

test('SN1 — core and record contracts validate strict objects', () => withStore((store) => {
  const result = build(store);
  assert.deepEqual(validateDatasetSnapshotCore(result.core), { valid: true, problems: [] });
  assert.deepEqual(validateDatasetSnapshotRecord(result.record), { valid: true, problems: [] });
  assert.deepEqual(datasetSnapshotCoreProblems(result.core), []);
  assert.deepEqual(datasetSnapshotRecordProblems(result.record), []);
}));

test('SN2 — sourceAcquiredAt null is valid and never invented', () => withStore((store) => {
  const result = build(store);
  assert.equal(result.record.sourceAcquiredAt, null);
  assert.equal(result.record.ingestedIntoLabAt, '2026-07-18T14:00:00.000Z');
}));

test('SN3 — acquired and ingested timestamps remain distinct', () => withStore((store) => {
  const result = build(store, { record: { sourceAcquiredAt: '2026-07-01T12:00:00Z', ingestedIntoLabAt: '2026-07-18T14:00:00Z' } });
  assert.equal(result.record.sourceAcquiredAt, '2026-07-01T12:00:00.000Z');
  assert.equal(result.record.ingestedIntoLabAt, '2026-07-18T14:00:00.000Z');
  assert.notEqual(result.record.sourceAcquiredAt, result.record.ingestedIntoLabAt);
}));

test('SN4 — unknown fields are refused', () => {
  assert.throws(() => normalizeDatasetSnapshotCoreV1({
    schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    sourceObjectId: HASH_A, normalizedObjectId: HASH_B, ...coreFields(), admissibleFor: ['DEV'],
  }), code('CANONICAL_UNKNOWN_FIELD'));
  assert.throws(() => normalizeDatasetSnapshotRecordV1({
    schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION, snapshotCoreId: HASH_A, ...recordFields(), notes: 'outside contract',
  }), code('CANONICAL_UNKNOWN_FIELD'));
});

test('SN5 — malformed IDs are refused', () => {
  const problems = datasetSnapshotCoreProblems({
    schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    sourceObjectId: 'bad', normalizedObjectId: HASH_B, ...coreFields(),
  });
  assert.ok(problems.some((problem) => problem.includes('sourceObjectId')));
  assert.throws(() => datasetSnapshotRecordId({
    schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION, snapshotCoreId: 'sha256:ABC', ...recordFields(),
  }), code('SNAPSHOT_CONTRACT_INVALID'));
});

test('SN6 — evidence IDs are a sorted set while ordered request lists are preserved', () => withStore((store) => {
  const result = build(store);
  assert.deepEqual(result.record.acquisitionEvidenceIds, [HASH_A, HASH_B]);
  assert.deepEqual(result.record.acquisitionRequestIdentity.orderedSteps, ['create', 'ingest']);
}));

test('SN7 — same source bytes produce the same sourceObjectId; one byte changes it', () => withStore((store) => {
  const first = build(store);
  const same = build(store);
  const changed = build(store, { sourceBytes: Buffer.from('{"synthetic":false}\r\n') });
  assert.equal(first.sourceObject.objectId, same.sourceObject.objectId);
  assert.notEqual(first.sourceObject.objectId, changed.sourceObject.objectId);
}));

test('SN8 — same normalized bars produce the same normalizedObjectId', () => withStore((store) => {
  const first = build(store, { core: { adapterVersion: 'syntheticAdapter/1' } });
  const second = build(store, { core: { adapterVersion: 'syntheticAdapter/2' } });
  assert.equal(first.normalizedObject.objectId, second.normalizedObject.objectId);
  assert.notEqual(first.snapshotCore.objectId, second.snapshotCore.objectId);
}));

test('SN9 — process/options/version changes alter core ID', () => withStore((store) => {
  const base = build(store);
  const option = build(store, { core: { normalizationOptions: { timezone: 'UTC', strict: true } } });
  const version = build(store, { core: { normalizerVersion: 'canonicalDailyBars/2' } });
  const transform = build(store, { core: { transformImplementationHash: HASH_A } });
  assert.notEqual(base.snapshotCore.objectId, option.snapshotCore.objectId);
  assert.notEqual(base.snapshotCore.objectId, version.snapshotCore.objectId);
  assert.notEqual(base.snapshotCore.objectId, transform.snapshotCore.objectId);
}));

test('SN10 — two acquisitions of the same core have distinct record IDs', () => withStore((store) => {
  const first = build(store, { record: { ingestedIntoLabAt: '2026-07-18T14:00:00Z' } });
  const second = build(store, { record: { ingestedIntoLabAt: '2026-07-18T14:00:01Z' } });
  assert.equal(first.snapshotCore.objectId, second.snapshotCore.objectId);
  assert.notEqual(first.snapshotRecord.objectId, second.snapshotRecord.objectId);
}));

test('SN11 — human notes and Windows/POSIX physical-path text alter no deterministic ID', () => withStore((store) => {
  const windows = build(store, { humanNotes: { note: 'C:\\cache\\fixture.json' } });
  const posix = build(store, { humanNotes: { note: '/cache/fixture.json' } });
  assert.equal(windows.sourceObject.objectId, posix.sourceObject.objectId);
  assert.equal(windows.normalizedObject.objectId, posix.normalizedObject.objectId);
  assert.equal(windows.snapshotCore.objectId, posix.snapshotCore.objectId);
  assert.equal(windows.snapshotRecord.objectId, posix.snapshotRecord.objectId);
}));

test('SN12 — complete snapshot round-trips from record ID alone', () => withStore((store) => {
  const built = build(store);
  const recovered = verifyDatasetSnapshot({ store, snapshotRecordId: built.snapshotRecord.objectId });
  assert.deepEqual(recovered.sourceBytes, Buffer.from('{"synthetic":true}\r\n'));
  assert.deepEqual(recovered.normalizedDailyBars, built.normalizedObject.value);
  assert.deepEqual(recovered.core, built.core);
  assert.deepEqual(recovered.record, built.record);
}));

test('SN13 — missing snapshot record and missing referenced object are explicit', () => withStore((store) => {
  assert.throws(() => verifyDatasetSnapshot({ store, snapshotRecordId: HASH_A }), code('SNAPSHOT_REFERENCE_MISSING'));
  const built = build(store);
  const sourcePath = join(store.root, ...built.sourceObject.uri.split('/'));
  rmSync(sourcePath);
  assert.throws(() => verifyDatasetSnapshot({ store, snapshotRecordId: built.snapshotRecord.objectId }), code('SNAPSHOT_REFERENCE_MISSING'));
}));

test('SN14 — corrupted referenced bytes are reported as hash mismatch', () => withStore((store) => {
  const built = build(store);
  const normalizedPath = join(store.root, ...built.normalizedObject.uri.split('/'));
  writeFileSync(normalizedPath, '{"corrupt":true}\n');
  assert.throws(() => verifyDatasetSnapshot({ store, snapshotRecordId: built.snapshotRecord.objectId }), code('SNAPSHOT_REFERENCE_HASH_MISMATCH'));
}));

test('SN15 — source and normalized references cannot be inverted', () => withStore((store) => {
  const built = build(store);
  const invertedCore = normalizeDatasetSnapshotCoreV1({
    ...built.core,
    sourceObjectId: built.normalizedObject.objectId,
    normalizedObjectId: built.sourceObject.objectId,
  });
  const corePut = store.putCanonicalObject({ namespace: 'snapshots', schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION, value: invertedCore });
  const record = normalizeDatasetSnapshotRecordV1({ ...built.record, snapshotCoreId: corePut.objectId });
  const recordPut = store.putCanonicalObject({ namespace: 'snapshots', schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION, value: record });
  assert.throws(() => verifyDatasetSnapshot({ store, snapshotRecordId: recordPut.objectId }), code('SNAPSHOT_REFERENCE_MISSING'));
}));

test('SN16 — core/record helper IDs equal stored IDs', () => withStore((store) => {
  const built = build(store);
  assert.equal(datasetSnapshotCoreId(built.core), built.snapshotCore.objectId);
  assert.equal(datasetSnapshotRecordId(built.record), built.snapshotRecord.objectId);
}));

test('SN17 — derived IDs cannot be injected into builder input', () => withStore((store) => {
  assert.throws(() => buildDatasetSnapshot({
    store, sourceBytes: Buffer.from('x'), normalizedDailyBars: normalizedBars(),
    core: { ...coreFields(), sourceObjectId: HASH_A }, record: recordFields(),
  }), code('SNAPSHOT_CONTRACT_INVALID'));
}));
