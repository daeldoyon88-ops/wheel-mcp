import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  normalizeCanonicalDailyBarsV1,
} from '../src/canonical/canonicalDailyBarsV1.mjs';

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), 'directional-lab-cas-'));
}

function withRoot(fn) {
  const root = temporaryRoot();
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function code(expected) {
  return (error) => error && error.code === expected;
}

function physical(root, uri) {
  return join(root, ...uri.split('/'));
}

function normalizedBars() {
  return normalizeCanonicalDailyBarsV1({
    schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION,
    bars: [{
      sessionDate: '2026-03-02', eventTime: '2026-03-02T21:00:00Z', availableAt: '2026-03-02T21:00:00Z',
      open: 20, high: 22, low: 19, close: 21, volume: 123,
      corporateActions: { splitFactor: null, cashDividend: 0.25 }, qualityFlags: ['SYNTHETIC'],
    }],
  });
}

test('CAS1 — root is mandatory', () => {
  assert.throws(() => createContentAddressedStore({}), code('CAS_ROOT_REQUIRED'));
});

test('CAS2 — root must be absolute and pre-existing', () => {
  assert.throws(() => createContentAddressedStore({ root: 'relative/cas' }), code('CAS_ROOT_NOT_ABSOLUTE'));
  const missing = join(tmpdir(), `missing-cas-${process.pid}-${Date.now()}`);
  assert.throws(() => createContentAddressedStore({ root: missing }), code('CAS_ROOT_MISSING'));
});

test('CAS3 — subdirectories are created only below the authorized root', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('synthetic'));
  assert.ok(readFileSync(physical(root, result.uri)).equals(Buffer.from('synthetic')));
  assert.ok(physical(root, result.uri).startsWith(root));
}));

test('CAS4 — traversal, absolute paths, backslashes, schemes and empty segments are refused', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const expectedObjectId = `sha256:${'0'.repeat(64)}`;
  for (const uri of ['../escape', '/absolute', 'C:/drive', 'file:object', 'objects\\source', 'objects//source', './object']) {
    assert.throws(() => store.readObject({ uri, expectedObjectId }), code('CAS_PATH_ESCAPE'));
  }
}));

test('CAS5 — a detectable symlink or junction below root is refused', () => withRoot((root) => {
  const outside = temporaryRoot();
  try {
    symlinkSync(outside, join(root, 'objects'), process.platform === 'win32' ? 'junction' : 'dir');
    const store = createContentAddressedStore({ root });
    const id = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => store.readObject({ uri: `objects/source/sha256/00/${'0'.repeat(64)}`, expectedObjectId: id }), code('CAS_REPARSE_POINT_FORBIDDEN'));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('CAS6 — source bytes are preserved bit for bit', () => withRoot((root) => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\n\u00e9\0', 'utf8')]);
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(bytes);
  assert.equal(result.objectId, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.deepEqual(store.readObject({ uri: result.uri, expectedObjectId: result.objectId }).bytes, bytes);
}));

test('CAS7 — canonical normalized objects are separate and verifiable', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putCanonicalObject({
    namespace: 'normalized', schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION, value: normalizedBars(),
  });
  assert.match(result.uri, /^objects\/normalized\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  const read = store.readCanonicalObject({ uri: result.uri, expectedObjectId: result.objectId, schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION });
  assert.deepEqual(read.value, normalizedBars());
}));

test('CAS8 — a repeated identical put is idempotent', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const first = store.putSourceBytes(Buffer.from('same'));
  const second = store.putSourceBytes(Buffer.from('same'));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual({ ...second, created: true }, first);
}));

test('CAS9 — two different byte strings produce two immutable objects', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const first = store.putSourceBytes(Buffer.from('one'));
  const second = store.putSourceBytes(Buffer.from('two'));
  assert.notEqual(first.objectId, second.objectId);
  assert.equal(readFileSync(physical(root, first.uri), 'utf8'), 'one');
  assert.equal(readFileSync(physical(root, second.uri), 'utf8'), 'two');
}));

test('CAS10 — an existing object with mismatched content is never overwritten', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const bytes = Buffer.from('original');
  const result = store.putSourceBytes(bytes);
  writeFileSync(physical(root, result.uri), Buffer.from('corrupt'));
  assert.throws(() => store.putSourceBytes(bytes), code('CAS_EXISTING_CONTENT_MISMATCH'));
  assert.equal(readFileSync(physical(root, result.uri), 'utf8'), 'corrupt');
}));

test('CAS11 — corruption after publication is detected on read and verify', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('intact'));
  writeFileSync(physical(root, result.uri), Buffer.from('mutated'));
  assert.throws(() => store.readObject({ uri: result.uri, expectedObjectId: result.objectId }), code('CAS_OBJECT_CORRUPT'));
  assert.throws(() => store.verifyObject({ uri: result.uri, expectedObjectId: result.objectId }), code('CAS_OBJECT_CORRUPT'));
}));

test('CAS12 — a truncated permanent object is detected', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('long synthetic content'));
  writeFileSync(physical(root, result.uri), Buffer.from('long'));
  assert.throws(() => store.readObject({ uri: result.uri, expectedObjectId: result.objectId }), code('CAS_OBJECT_CORRUPT'));
}));

test('CAS13 — an unrelated abandoned temporary is not published or silently removed', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('stable'));
  const abandoned = `${physical(root, result.uri)}.tmp-abandoned`;
  writeFileSync(abandoned, 'partial');
  assert.equal(store.putSourceBytes(Buffer.from('stable')).created, false);
  assert.equal(readFileSync(abandoned, 'utf8'), 'partial');
}));

test('CAS14 — an abandoned lock fails closed and requires recovery', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('locked'));
  writeFileSync(`${physical(root, result.uri)}.lock`, JSON.stringify({ pid: 2147483647, createdAt: '2026-01-01T00:00:00.000Z' }));
  assert.throws(() => store.putSourceBytes(Buffer.from('locked')), code('CAS_LOCK_RECOVERY_REQUIRED'));
}));

test('CAS15 — a live lock reports CAS_LOCK_EXISTS', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('live-lock'));
  writeFileSync(`${physical(root, result.uri)}.lock`, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  assert.throws(() => store.putSourceBytes(Buffer.from('live-lock')), code('CAS_LOCK_EXISTS'));
}));

test('CAS16 — unavailable atomic no-replace publication fails closed', () => withRoot((root) => {
  const store = createContentAddressedStore({ root, atomicPublishMode: 'unsupported' });
  const bytes = Buffer.from('cannot-publish');
  const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const uri = store.uriForObject({ namespace: 'source', objectId: id });
  assert.throws(() => store.putSourceBytes(bytes), code('CAS_ATOMIC_PUBLISH_UNSUPPORTED'));
  assert.throws(() => store.readObject({ uri, expectedObjectId: id }), code('CAS_OBJECT_CORRUPT'));
}));

test('CAS17 — read and verify report the bound ID, URI and size', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('verify-me'));
  assert.deepEqual(store.verifyObject({ uri: result.uri, expectedObjectId: result.objectId }), {
    objectId: result.objectId, uri: result.uri, sizeBytes: result.sizeBytes, verified: true,
  });
}));

test('CAS18 — source remains retrievable after the original file disappears', () => withRoot((root) => {
  const sourcePath = join(root, 'original-source.bin');
  const bytes = Buffer.from('synthetic source only\r\n');
  writeFileSync(sourcePath, bytes);
  const casRoot = join(root, 'cas');
  mkdirSync(casRoot);
  const store = createContentAddressedStore({ root: casRoot });
  const result = store.putSourceBytes(readFileSync(sourcePath));
  unlinkSync(sourcePath);
  assert.deepEqual(store.readObject({ uri: result.uri, expectedObjectId: result.objectId }).bytes, bytes);
}));

test('CAS19 — caller cannot bind a correct hash to a different URI filename', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const result = store.putSourceBytes(Buffer.from('bound-name'));
  const wrong = result.uri.replace(/[0-9a-f]{64}$/, 'f'.repeat(64));
  assert.throws(() => store.readObject({ uri: wrong, expectedObjectId: result.objectId }), code('CAS_OBJECT_CORRUPT'));
}));

test('CAS20 — hash-valid but non-canonical JSON is still a corrupt canonical object', () => withRoot((root) => {
  const store = createContentAddressedStore({ root });
  const bytes = Buffer.from('{ "schemaVersion": "CanonicalDailyBars/1", "bars": [] }\n');
  const objectId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const uri = store.uriForObject({ namespace: 'normalized', objectId });
  const path = physical(root, uri);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  assert.throws(() => store.readCanonicalObject({ uri, expectedObjectId: objectId, schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION }), code('CAS_OBJECT_CORRUPT'));
}));
