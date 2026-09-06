import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canonicalHash, canonicalJsonBytes, parseCanonicalJsonBytes } from '../../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS, normalizeCanonicalValue } from '../../research/directional-lab/src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  COVERAGE_VERSION,
  DATASET_MANIFEST_SCHEMA_VERSION,
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  HISTORICAL_REPLAY_SUPPORT,
  JARVISE_SNAPSHOT_PERSISTENCE_VERSION,
  PERSISTENCE_CONTRACTS,
  PERSISTENCE_STAGES,
  RETROSPECTIVE_SEMANTICS,
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  createJarviseSnapshotDirectoryJournalR1,
  createJarviseSnapshotMemoryJournalR1,
  createJarviseSnapshotPersistenceR1,
  readJarviseSnapshotPersistenceProvenanceR1,
} from './jarviseSnapshotPersistenceR1.mjs';

const MODULE_URL = new URL('./jarviseSnapshotPersistenceR1.mjs', import.meta.url);
const ACQUISITION_AUTHORITY_URL = new URL('./jarviseAcquisitionAuthorityR1.json', import.meta.url);
const PROVENANCE_URL = new URL('../../data/jarvise/observation-snapshots/PROVENANCE.json', import.meta.url);

const ACQUISITION_KEY = 'YAHOO_CHART_EOD|AAPL|2026-05-04..2026-05-05';
const objectIdOf = (seed) => `sha256:${createHash('sha256').update(seed, 'utf8').digest('hex')}`;

/**
 * Local raw fixture. These bytes are authored by this test, never acquired:
 * nothing in this suite reaches a provider, a socket or the clock.
 */
const RAW_FIXTURE = Object.freeze({
  schemaVersion: 'JarviseLocalRawObservationFixture/1',
  rows: Object.freeze([
    Object.freeze({ sessionDate: '2026-05-04', open: 100, high: 102, low: 99, close: 101, volume: 1000 }),
    Object.freeze({ sessionDate: '2026-05-05', open: 101, high: 104, low: 100.5, close: 103, volume: 1200 }),
  ]),
});
const RAW_BYTES = Buffer.from(`${JSON.stringify(RAW_FIXTURE)}\n`, 'utf8');

/** Pure local normalizer: pinned bytes in, CanonicalDailyBars/1 out. */
function normalizeFixture(bytes) {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return {
    schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION,
    bars: parsed.rows.map((row) => ({
      sessionDate: row.sessionDate,
      eventTime: `${row.sessionDate}T20:00:00.000Z`,
      availableAt: `${row.sessionDate}T20:00:00.000Z`,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      corporateActions: { splitFactor: null, cashDividend: null },
      qualityFlags: [],
    })),
  };
}

const NO_ACQUISITION_AUTHORITY = Object.freeze({
  authorityId: 'P2_PRE_FETCH_PREPARATION_NO_ACQUISITION_R1',
  executionAuthorized: false,
  networkAuthorized: false,
});

/** A hypothetical future Owner authority, used only to exercise the gate. */
const NETWORK_AUTHORIZED_AUTHORITY = Object.freeze({
  authorityId: 'TEST_ONLY_FUTURE_FETCH_ONCE_AUTHORITY',
  executionAuthorized: true,
  networkAuthorized: true,
});

const ACQUISITION_PROVENANCE = Object.freeze({
  sourceAcquiredAt: null,
  ingestedIntoLabAt: '2026-09-05T00:00:00.000Z',
  acquisitionMethod: 'LOCAL_PINNED_BYTES_NO_ACQUISITION',
  acquisitionToolVersion: JARVISE_SNAPSHOT_PERSISTENCE_VERSION,
  acquisitionRequestIdentity: Object.freeze({
    authorityId: 'P2_PRE_FETCH_PREPARATION_NO_ACQUISITION_R1',
    networkAuthorized: false,
    providerCalls: 0,
  }),
  acquisitionEvidenceIds: Object.freeze([]),
});

const CORE_IDENTITY = Object.freeze({
  canonicalSymbol: 'AAPL',
  providerId: 'YAHOO',
  providerSymbol: 'AAPL',
  sourceFormat: 'JARVISE_LOCAL_RAW_OBSERVATION_FIXTURE_V1',
  adapterVersion: 'jarviseSnapshotPersistenceR1.test-adapter/1',
  adapterOptions: {},
  normalizerVersion: 'jarviseSnapshotPersistenceR1.test-normalizer/1',
  normalizationOptions: { priceBasis: 'SPLIT_ADJUSTED' },
  canonicalSerializationVersion: 'CanonicalJSON/1',
  priceBasis: 'SPLIT_ADJUSTED',
  corporateActionPolicyHash: objectIdOf('jarvise-corporate-action-policy'),
  calendarId: 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR',
  calendarVersion: '2',
  transformImplementationHash: objectIdOf('jarvise-transform-implementation'),
});

/** DatasetManifestV1 evidence, present only to bind coverage/1. */
const LEGACY_MANIFEST = Object.freeze({
  schemaVersion: DATASET_MANIFEST_SCHEMA_VERSION,
  symbol: 'AAPL',
  sourcePath: 'jarviseSnapshotPersistenceR1.test/local-raw-observation-fixture',
  sourceGitStatus: 'fixture',
  sourceFormat: 'JARVISE_LOCAL_RAW_OBSERVATION_FIXTURE_V1',
  contentHash: createHash('sha256').update(RAW_BYTES).digest('hex'),
  firstDate: '2026-05-04',
  lastDate: '2026-05-05',
  barCount: 2,
  coverageVersion: COVERAGE_VERSION,
  rawOhlcValidBars: 2,
  rawOhlcCoveragePct: 100,
  rawOhlcAvailable: true,
  rawOhlcComplete: true,
  adjustedOhlcValidBars: 2,
  adjustedOhlcCoveragePct: 100,
  adjustedOhlcAvailable: true,
  adjustedOhlcComplete: true,
  volumeValidBars: 2,
  volumeCoveragePct: 100,
  volumeAvailable: true,
  volumeComplete: true,
  adjustedCloseAvailable: true,
  nativeAdjustmentType: 'SPLIT_ADJUSTED',
  splitsDocumented: true,
  qualityFlags: [],
  warnings: [],
  gapStats: { missingSessions: 0 },
  lineage: { producedBy: 'jarviseSnapshotPersistenceR1.test/1' },
});

const INSTRUMENT_BINDING = Object.freeze({
  instrumentIdentityId: objectIdOf('jarvise-instrument-identity-AAPL'),
  aliasBindingCoreId: objectIdOf('jarvise-alias-binding-AAPL'),
  resolutionDate: '2026-05-04',
  canonicalSymbolObserved: 'AAPL',
  providerId: 'YAHOO',
  providerSymbolObserved: 'AAPL',
});

/**
 * In-memory CAS honouring the same URI scheme, immutability and re-verification
 * discipline as contentAddressedStoreV1, with no filesystem and no network.
 */
function createInMemoryCasR1() {
  /** @type {Map<string, Buffer>} */
  const objects = new Map();
  const sha256ObjectId = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const casError = (code, message, details = {}) => Object.assign(new Error(`${code}: ${message}`), { code, details });

  const uriFor = (namespace, objectId) => {
    const hex = objectId.slice('sha256:'.length);
    if (namespace === 'source') return `objects/source/sha256/${hex.slice(0, 2)}/${hex}`;
    if (namespace === 'normalized') return `objects/normalized/sha256/${hex.slice(0, 2)}/${hex}`;
    if (namespace === 'snapshots') return `snapshots/sha256/${hex.slice(0, 2)}/${hex}.json`;
    throw casError('CAS_PATH_ESCAPE', `unsupported namespace: ${String(namespace)}`);
  };

  const put = (bytes, objectId, uri) => {
    const existing = objects.get(uri);
    if (existing !== undefined) {
      if (!existing.equals(bytes)) throw casError('CAS_EXISTING_CONTENT_MISMATCH', `immutable object changed: ${uri}`);
    } else {
      objects.set(uri, Buffer.from(bytes));
    }
    return { objectId, uri, sizeBytes: bytes.length };
  };

  const store = {
    uriForObject({ namespace, objectId }) {
      return uriFor(namespace, objectId);
    },
    putSourceBytes(bytes) {
      const exact = Buffer.from(bytes);
      const objectId = sha256ObjectId(exact);
      return put(exact, objectId, uriFor('source', objectId));
    },
    putCanonicalObject({ namespace, schemaVersion, value }) {
      if (namespace === 'normalized' && !NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(schemaVersion)) {
        throw casError('CAS_PATH_ESCAPE', 'normalized namespace only accepts registered normalized content schemas');
      }
      if (namespace === 'snapshots' && !SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(schemaVersion)) {
        throw casError('CAS_PATH_ESCAPE', 'snapshots namespace only accepts registered snapshot metadata schemas');
      }
      const normalized = normalizeCanonicalValue(schemaVersion, value);
      const bytes = canonicalJsonBytes(normalized);
      const objectId = canonicalHash(schemaVersion, normalized);
      return { ...put(bytes, objectId, uriFor(namespace, objectId)), value: normalized };
    },
    readObject({ uri, expectedObjectId }) {
      const bytes = objects.get(uri);
      if (bytes === undefined) {
        throw casError('CAS_OBJECT_CORRUPT', `CAS object is missing: ${uri}`, { uri, expectedObjectId, fsCode: 'ENOENT' });
      }
      const objectId = sha256ObjectId(bytes);
      if (objectId !== expectedObjectId) {
        throw casError('CAS_EXISTING_CONTENT_MISMATCH', `content mismatch for immutable object ${uri}`, { uri, expectedObjectId, objectId });
      }
      return { objectId, uri, sizeBytes: bytes.length, bytes };
    },
    verifyObject(input) {
      const result = store.readObject(input);
      return { objectId: result.objectId, uri: result.uri, sizeBytes: result.sizeBytes, verified: true };
    },
    readCanonicalObject({ uri, expectedObjectId, schemaVersion }) {
      const result = store.readObject({ uri, expectedObjectId });
      const value = normalizeCanonicalValue(schemaVersion, parseCanonicalJsonBytes(result.bytes));
      const actualObjectId = canonicalHash(schemaVersion, value);
      if (actualObjectId !== expectedObjectId) {
        throw casError('CAS_OBJECT_CORRUPT', `canonical schema/hash mismatch for ${uri}`, { expectedObjectId, actualObjectId });
      }
      return { ...result, value };
    },
    contents() {
      return [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
  return store;
}

/** @param {ReturnType<typeof createInMemoryCasR1>} store */
function casFingerprint(store) {
  return store.contents().map(([uri, bytes]) => `${uri}=${createHash('sha256').update(bytes).digest('hex')}`);
}

function runPersistenceToVersionCache(store, journal, acquisitionAuthority = NO_ACQUISITION_AUTHORITY) {
  const persistence = createJarviseSnapshotPersistenceR1({ store, journal, acquisitionAuthority });
  persistence.pinRawOnce({ acquisitionKey: ACQUISITION_KEY, rawBytes: RAW_BYTES, acquisition: ACQUISITION_PROVENANCE });
  persistence.normalizePinnedRaw({ acquisitionKey: ACQUISITION_KEY, normalize: normalizeFixture });
  const cached = persistence.versionCache({
    acquisitionKey: ACQUISITION_KEY,
    core: CORE_IDENTITY,
    legacyManifest: LEGACY_MANIFEST,
    instrumentBinding: INSTRUMENT_BINDING,
  });
  return { persistence, cached };
}

test('T9 persistence round-trip pins, normalizes, version-caches and reuses', () => {
  const store = createInMemoryCasR1();
  const journal = createJarviseSnapshotMemoryJournalR1();
  const persistence = createJarviseSnapshotPersistenceR1({
    store, journal, acquisitionAuthority: NO_ACQUISITION_AUTHORITY,
  });

  assert.deepEqual([...PERSISTENCE_STAGES], ['EMPTY', 'RAW_PINNED', 'NORMALIZED', 'VERSION_CACHED']);
  assert.deepEqual([...PERSISTENCE_CONTRACTS], [
    DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
    SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
    DATASET_MANIFEST_SCHEMA_VERSION,
    COVERAGE_VERSION,
    DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  ]);
  assert.equal(persistence.stageOf(ACQUISITION_KEY), 'EMPTY');

  const pinned = persistence.pinRawOnce({
    acquisitionKey: ACQUISITION_KEY, rawBytes: RAW_BYTES, acquisition: ACQUISITION_PROVENANCE,
  });
  assert.equal(pinned.stage, 'RAW_PINNED');
  assert.equal(pinned.acquired, false);
  assert.equal(pinned.reused, false);
  assert.equal(pinned.sourceObjectId, `sha256:${createHash('sha256').update(RAW_BYTES).digest('hex')}`);
  assert.equal(pinned.sourceByteLength, RAW_BYTES.length);

  const normalized = persistence.normalizePinnedRaw({ acquisitionKey: ACQUISITION_KEY, normalize: normalizeFixture });
  assert.equal(normalized.stage, 'NORMALIZED');
  assert.equal(normalized.normalizedSchemaVersion, CANONICAL_DAILY_BARS_SCHEMA_VERSION);
  assert.equal(normalized.reused, false);

  const cached = persistence.versionCache({
    acquisitionKey: ACQUISITION_KEY,
    core: CORE_IDENTITY,
    legacyManifest: LEGACY_MANIFEST,
    instrumentBinding: INSTRUMENT_BINDING,
  });
  assert.equal(cached.stage, 'VERSION_CACHED');
  assert.match(cached.manifestId, /^sha256:[0-9a-f]{64}$/);
  assert.match(cached.instrumentBindingId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual([...cached.manifestVersions], [cached.manifestId]);

  const reused = persistence.reuse({ acquisitionKey: ACQUISITION_KEY });
  assert.equal(reused.refetched, false);
  assert.equal(reused.manifestId, cached.manifestId);
  assert.equal(reused.retrospectiveSemantics, RETROSPECTIVE_SEMANTICS);
  assert.equal(reused.historicalReplaySupport, HISTORICAL_REPLAY_SUPPORT);
  assert.equal(reused.manifest.snapshotCoreId, cached.snapshotCoreId);
  assert.equal(reused.manifest.snapshotRecordId, cached.snapshotRecordId);
  assert.ok(Buffer.from(reused.snapshot.sourceBytes).equals(RAW_BYTES));
  assert.deepEqual(reused.snapshot.normalizedDailyBars, normalizeCanonicalValue(
    CANONICAL_DAILY_BARS_SCHEMA_VERSION, normalizeFixture(RAW_BYTES),
  ));
  assert.deepEqual(reused.snapshot.core, {
    schemaVersion: DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
    sourceObjectId: pinned.sourceObjectId,
    normalizedObjectId: normalized.normalizedObjectId,
    ...CORE_IDENTITY,
  });

  // The acquisition instant binding survives the round-trip verbatim.
  assert.equal(reused.snapshot.record.sourceAcquiredAt, null);
  assert.equal(reused.snapshot.record.ingestedIntoLabAt, ACQUISITION_PROVENANCE.ingestedIntoLabAt);
  assert.equal(reused.snapshot.record.acquisitionMethod, ACQUISITION_PROVENANCE.acquisitionMethod);
  assert.equal(reused.snapshot.record.acquisitionToolVersion, JARVISE_SNAPSHOT_PERSISTENCE_VERSION);
  assert.deepEqual(reused.snapshot.record.acquisitionRequestIdentity, { ...ACQUISITION_PROVENANCE.acquisitionRequestIdentity });
  assert.deepEqual(reused.snapshot.record.acquisitionEvidenceIds, []);
  assert.equal(reused.snapshot.record.snapshotCoreId, cached.snapshotCoreId);

  // Re-running the identical version-cache is a content-addressed no-op.
  const before = casFingerprint(store);
  const again = persistence.versionCache({
    acquisitionKey: ACQUISITION_KEY,
    core: CORE_IDENTITY,
    legacyManifest: LEGACY_MANIFEST,
    instrumentBinding: INSTRUMENT_BINDING,
  });
  assert.equal(again.manifestId, cached.manifestId);
  assert.equal(again.reused, true);
  assert.deepEqual([...again.manifestVersions], [cached.manifestId]);
  assert.deepEqual(casFingerprint(store), before);

  // A new manifest version is additive: the previous one stays byte-identical.
  const successor = persistence.versionCache({
    acquisitionKey: ACQUISITION_KEY,
    core: CORE_IDENTITY,
    legacyManifest: LEGACY_MANIFEST,
    instrumentBinding: INSTRUMENT_BINDING,
    createdByVersion: 'jarviseSnapshotPersistenceR1.test-successor/1',
  });
  assert.notEqual(successor.manifestId, cached.manifestId);
  assert.deepEqual([...successor.manifestVersions], [cached.manifestId, successor.manifestId]);
  const priorManifest = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: cached.manifestId }),
    expectedObjectId: cached.manifestId,
    schemaVersion: SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  });
  assert.equal(priorManifest.value.createdByVersion, JARVISE_SNAPSHOT_PERSISTENCE_VERSION);
  const afterSuccessor = casFingerprint(store);
  for (const entry of before) {
    assert.ok(afterSuccessor.includes(entry), `immutable CAS entry changed or disappeared: ${entry}`);
  }
});

test('T10 crash-safe resume performs zero refetch once RAW_PINNED', () => {
  const store = createInMemoryCasR1();
  const journal = createJarviseSnapshotMemoryJournalR1();
  let providerInvocations = 0;
  const acquireRawBytes = () => {
    providerInvocations += 1;
    return RAW_BYTES;
  };

  // A future Owner authority that does allow acquisition: the FETCH_ONCE arm.
  const first = createJarviseSnapshotPersistenceR1({
    store, journal, acquisitionAuthority: NETWORK_AUTHORIZED_AUTHORITY,
  });
  const pinned = first.pinRawOnce({ acquisitionKey: ACQUISITION_KEY, acquireRawBytes, acquisition: ACQUISITION_PROVENANCE });
  assert.equal(pinned.acquired, true);
  assert.equal(pinned.stage, 'RAW_PINNED');
  assert.equal(providerInvocations, 1);
  assert.equal(first.acquisitionInvocations(), 1);

  // Crash: the runtime is discarded, only the CAS and the journal survive.
  const resumed = createJarviseSnapshotPersistenceR1({
    store, journal, acquisitionAuthority: NETWORK_AUTHORIZED_AUTHORITY,
  });
  const resumeState = resumed.resume({ acquisitionKey: ACQUISITION_KEY });
  assert.equal(resumeState.stage, 'RAW_PINNED');
  assert.equal(resumeState.nextStep, 'normalizePinnedRaw');
  assert.equal(resumeState.refetchRequired, false);
  assert.equal(resumeState.rawPinned, true);

  const rePin = resumed.pinRawOnce({ acquisitionKey: ACQUISITION_KEY, acquireRawBytes, acquisition: ACQUISITION_PROVENANCE });
  assert.equal(rePin.reused, true);
  assert.equal(rePin.acquired, false);
  assert.equal(rePin.sourceObjectId, pinned.sourceObjectId);
  assert.equal(providerInvocations, 1);
  assert.equal(resumed.acquisitionInvocations(), 0);

  resumed.normalizePinnedRaw({ acquisitionKey: ACQUISITION_KEY, normalize: normalizeFixture });
  const cached = resumed.versionCache({
    acquisitionKey: ACQUISITION_KEY,
    core: CORE_IDENTITY,
    legacyManifest: LEGACY_MANIFEST,
    instrumentBinding: INSTRUMENT_BINDING,
  });

  // Crash again after VERSION_CACHE: reuse recovers from the journal head.
  const afterCrash = createJarviseSnapshotPersistenceR1({
    store, journal, acquisitionAuthority: NETWORK_AUTHORIZED_AUTHORITY,
  });
  const finalState = afterCrash.resume({ acquisitionKey: ACQUISITION_KEY });
  assert.equal(finalState.stage, 'VERSION_CACHED');
  assert.equal(finalState.nextStep, 'reuse');
  assert.equal(finalState.refetchRequired, false);
  const recovered = afterCrash.reuse({ acquisitionKey: ACQUISITION_KEY });
  assert.equal(recovered.manifestId, cached.manifestId);
  assert.equal(recovered.refetched, false);
  assert.equal(providerInvocations, 1);
  assert.equal(afterCrash.acquisitionInvocations(), 0);

  // Crash between the durable CAS write and the journal commit: the raw bytes
  // are already pinned, so replay re-pins the same object and never refetches.
  const orphanJournal = createJarviseSnapshotMemoryJournalR1();
  const replay = createJarviseSnapshotPersistenceR1({
    store, journal: orphanJournal, acquisitionAuthority: NETWORK_AUTHORIZED_AUTHORITY,
  });
  assert.equal(replay.stageOf(ACQUISITION_KEY), 'EMPTY');
  const objectsBefore = store.contents().length;
  const rePinned = replay.pinRawOnce({
    acquisitionKey: ACQUISITION_KEY, rawBytes: RAW_BYTES, acquisition: ACQUISITION_PROVENANCE,
  });
  assert.equal(rePinned.sourceObjectId, pinned.sourceObjectId);
  assert.equal(store.contents().length, objectsBefore);
  assert.equal(providerInvocations, 1);
  assert.equal(replay.acquisitionInvocations(), 0);

  // The durable journal refuses a non-absolute root before touching any disk.
  assert.throws(
    () => createJarviseSnapshotDirectoryJournalR1({ root: 'observation-snapshots' }),
    (error) => error.code === 'PERSISTENCE_INPUT_INVALID',
  );
});

test('T11 the persistence surface is network-free end to end', () => {
  const moduleSource = readFileSync(MODULE_URL, 'utf8');
  for (const forbidden of [
    'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:dgram',
    'undici', 'axios', 'node-fetch', 'XMLHttpRequest', 'WebSocket', 'yahoo', 'ibkr', 'macro',
  ]) {
    assert.ok(
      !moduleSource.toLowerCase().includes(forbidden.toLowerCase()),
      `persistence module must not reference ${forbidden}`,
    );
  }
  assert.ok(!/\bfetch\s*\(/.test(moduleSource), 'persistence module must not call fetch');

  // A full round-trip while every global network entry point throws on touch.
  const globals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
  const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globals) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: () => assert.fail(`persistence touched ${name}`),
    });
  }
  try {
    const store = createInMemoryCasR1();
    const journal = createJarviseSnapshotMemoryJournalR1();
    const { persistence, cached } = runPersistenceToVersionCache(store, journal);
    assert.equal(persistence.reuse({ acquisitionKey: ACQUISITION_KEY }).manifestId, cached.manifestId);
    assert.equal(persistence.acquisitionInvocations(), 0);
    assert.equal(persistence.describe().networkAuthorized, false);
  } finally {
    for (const name of globals) {
      const descriptor = saved.get(name);
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }

  // Under the P2 authority an acquirer is refused and never invoked.
  let acquirerCalls = 0;
  const guarded = createJarviseSnapshotPersistenceR1({
    store: createInMemoryCasR1(),
    journal: createJarviseSnapshotMemoryJournalR1(),
    acquisitionAuthority: NO_ACQUISITION_AUTHORITY,
  });
  assert.throws(
    () => guarded.pinRawOnce({
      acquisitionKey: ACQUISITION_KEY,
      acquisition: ACQUISITION_PROVENANCE,
      acquireRawBytes: () => {
        acquirerCalls += 1;
        return RAW_BYTES;
      },
    }),
    (error) => error.code === 'PERSISTENCE_ACQUISITION_FORBIDDEN',
  );
  assert.equal(acquirerCalls, 0);
  assert.equal(guarded.acquisitionInvocations(), 0);

  // The staged acquisition authority grants nothing.
  const authority = JSON.parse(readFileSync(ACQUISITION_AUTHORITY_URL, 'utf8'));
  assert.equal(authority.executionAuthorized, false);
  assert.equal(authority.networkAuthorized, false);
  assert.equal(authority.providerCallsAuthorized, 0);
  assert.equal(authority.yahooFetchAuthorized, false);
  assert.equal(authority.macroIngestionAuthorized, false);

  // The persistence-root provenance is retrospective reconstruction only.
  const provenanceText = readFileSync(PROVENANCE_URL, 'utf8');
  assert.ok(provenanceText.length > 0, 'PROVENANCE.json must not be empty');
  assert.ok(!provenanceText.includes('POINT_IN_TIME'), 'PROVENANCE.json must not claim point-in-time vintage semantics');
  const provenance = readJarviseSnapshotPersistenceProvenanceR1({ root: fileURLToPath(new URL('../../', import.meta.url)) });
  assert.deepEqual(provenance, JSON.parse(provenanceText));
  assert.equal(provenance.retrospectiveSemantics, RETROSPECTIVE_SEMANTICS);
  assert.equal(provenance.historicalReplaySupport, HISTORICAL_REPLAY_SUPPORT);
  assert.equal(provenance.acquiredBytesPresent, false);
  assert.equal(provenance.acquisitionState, 'NO_ACQUISITION_PERFORMED');
  assert.deepEqual(provenance.acquiredSourceObjectIds, []);
  assert.equal(provenance.persistenceModuleVersion, JARVISE_SNAPSHOT_PERSISTENCE_VERSION);
  assert.equal(provenance.acquisitionProvenanceBinding.boundThrough, DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(provenance.acquisitionProvenanceBinding.fields).sort(), [
    'acquisitionEvidenceIds',
    'acquisitionMethod',
    'acquisitionRequestIdentity',
    'acquisitionToolVersion',
    'sourceAcquiredAt',
  ]);
  assert.deepEqual([...provenance.reusedContracts].sort(), [...PERSISTENCE_CONTRACTS].sort());
});
