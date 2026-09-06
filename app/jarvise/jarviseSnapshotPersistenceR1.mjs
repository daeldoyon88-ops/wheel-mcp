/**
 * Jarvise R2 historical observation persistence surface.
 *
 * FETCH_ONCE -> NORMALIZE -> VERSION_CACHE -> REUSE over the already-published
 * L1/L2 contracts. This module is an orchestrator only: it constructs no HTTP
 * client, imports no provider adapter, reads no clock and acquires nothing on
 * its own. Raw bytes enter either as bytes the caller already holds locally or
 * through an injected acquirer, and the acquirer is refused unless the caller
 * supplies an acquisition authority that explicitly authorizes network. Under
 * P2_PRE_FETCH_PREPARATION_NO_ACQUISITION_R1 that authority denies network, so
 * locally supplied bytes are the only admissible entry point today.
 *
 * Once a key reaches RAW_PINNED the raw object is immutable and no further
 * acquisition is ever attempted for it: every later stage re-reads the pinned
 * bytes out of the CAS. That is what makes replay RETROSPECTIVE_RECONSTRUCTION
 * from a pinned snapshot rather than a point-in-time vintage.
 */

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANONICAL_DAILY_BARS_SCHEMA_VERSION } from '../../research/directional-lab/src/canonical/canonicalDailyBarsV1.mjs';
import { COVERAGE_VERSION, DATASET_MANIFEST_SCHEMA_VERSION } from '../../research/directional-lab/src/contracts/datasetManifestV1.mjs';
import {
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  SHA256_OBJECT_ID_PATTERN,
  normalizeDatasetSnapshotRecordV1,
} from '../../research/directional-lab/src/contracts/datasetSnapshotV1.mjs';
import { SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION } from '../../research/directional-lab/src/contracts/snapshotDatasetManifestV1.mjs';
import {
  DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  normalizeDatasetSnapshotInstrumentBindingV1,
} from '../../research/directional-lab/src/contracts/instrumentIdentityV1.mjs';
import { buildDatasetSnapshot, verifyDatasetSnapshot } from '../../research/directional-lab/src/data/buildDatasetSnapshot.mjs';
import {
  buildSnapshotDatasetManifest,
  verifySnapshotDatasetManifest,
} from '../../research/directional-lab/src/data/buildSnapshotDatasetManifest.mjs';

export const JARVISE_SNAPSHOT_PERSISTENCE_VERSION = 'jarviseSnapshotPersistenceR1/1';
export const JARVISE_SNAPSHOT_JOURNAL_SCHEMA_VERSION = 'JarviseSnapshotPersistenceJournalEntry/1';
export const PERSISTENCE_ROOT_RELATIVE_PATH = 'data/jarvise/observation-snapshots';

export const RETROSPECTIVE_SEMANTICS = 'RETROSPECTIVE_RECONSTRUCTION';
export const FORBIDDEN_RETROSPECTIVE_SEMANTICS = 'POINT_IN_TIME_VINTAGE';
export const HISTORICAL_REPLAY_SUPPORT = 'RETROSPECTIVE_RECONSTRUCTION_FROM_PINNED_SNAPSHOT';

/** Ordered lifecycle. RAW_PINNED is the point of no return for acquisition. */
export const PERSISTENCE_STAGES = Object.freeze(['EMPTY', 'RAW_PINNED', 'NORMALIZED', 'VERSION_CACHED']);

/** Every contract this surface reuses; nothing new is defined here. */
export const PERSISTENCE_CONTRACTS = Object.freeze([
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
  DATASET_MANIFEST_SCHEMA_VERSION,
  COVERAGE_VERSION,
  DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
]);

const STORE_METHODS = Object.freeze(['putSourceBytes', 'putCanonicalObject', 'readObject', 'readCanonicalObject', 'uriForObject']);
const JOURNAL_METHODS = Object.freeze(['readEntry', 'writeEntry']);

export class JarviseSnapshotPersistenceError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseSnapshotPersistenceError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {object} [details] */
function fail(code, message, details = {}) {
  throw new JarviseSnapshotPersistenceError(code, message, details);
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value @param {string} label */
function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail('PERSISTENCE_INPUT_INVALID', `${label} must be a non-empty trimmed string`);
  }
  return /** @type {string} */ (value);
}

/** @param {unknown} value @param {string} label */
function assertObjectId(value, label) {
  if (typeof value !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(value)) {
    fail('PERSISTENCE_INPUT_INVALID', `${label} must use sha256:<64 lowercase hex>`);
  }
  return /** @type {string} */ (value);
}

/** @param {string} stage */
function stageIndex(stage) {
  const index = PERSISTENCE_STAGES.indexOf(stage);
  if (index < 0) fail('PERSISTENCE_STAGE_UNKNOWN', `unknown persistence stage: ${String(stage)}`);
  return index;
}

/**
 * Refuse anything that claims point-in-time vintage semantics. The historical
 * plane only ever replays a pinned snapshot retrospectively.
 * @param {unknown} provenance
 */
export function assertRetrospectiveReconstructionOnly(provenance) {
  if (!isPlainObject(provenance)) fail('PERSISTENCE_PROVENANCE_INVALID', 'provenance must be a plain object');
  const document = /** @type {Record<string, unknown>} */ (provenance);
  if (JSON.stringify(document).includes(FORBIDDEN_RETROSPECTIVE_SEMANTICS)) {
    fail('PERSISTENCE_POINT_IN_TIME_VINTAGE_FORBIDDEN', `provenance declares ${FORBIDDEN_RETROSPECTIVE_SEMANTICS}`);
  }
  if (document.retrospectiveSemantics !== RETROSPECTIVE_SEMANTICS) {
    fail('PERSISTENCE_PROVENANCE_INVALID', `retrospectiveSemantics must be ${RETROSPECTIVE_SEMANTICS}`);
  }
  if (document.historicalReplaySupport !== HISTORICAL_REPLAY_SUPPORT) {
    fail('PERSISTENCE_PROVENANCE_INVALID', `historicalReplaySupport must be ${HISTORICAL_REPLAY_SUPPORT}`);
  }
  return document;
}

/**
 * Read the persistence-root provenance declaration and assert its semantics.
 * @param {{root?: string}} [options]
 */
export function readJarviseSnapshotPersistenceProvenanceR1(options = {}) {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (!isAbsolute(root)) fail('PERSISTENCE_INPUT_INVALID', 'root must be an absolute path');
  const path = resolve(root, PERSISTENCE_ROOT_RELATIVE_PATH, 'PROVENANCE.json');
  return assertRetrospectiveReconstructionOnly(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Acquisition authority gate. This module never grants itself network: the
 * caller must present an authority whose networkAuthorized is explicitly true
 * before any acquirer callback becomes reachable.
 * @param {unknown} value
 */
function normalizeAcquisitionAuthority(value) {
  if (!isPlainObject(value)) fail('PERSISTENCE_AUTHORITY_REQUIRED', 'an acquisition authority document is required');
  const authority = /** @type {Record<string, unknown>} */ (value);
  assertNonEmptyString(authority.authorityId, 'acquisitionAuthority.authorityId');
  for (const field of ['executionAuthorized', 'networkAuthorized']) {
    if (typeof authority[field] !== 'boolean') {
      fail('PERSISTENCE_AUTHORITY_INVALID', `acquisitionAuthority.${field} must be a boolean`);
    }
  }
  return Object.freeze({
    authorityId: /** @type {string} */ (authority.authorityId),
    executionAuthorized: authority.executionAuthorized === true,
    networkAuthorized: authority.networkAuthorized === true,
  });
}

/**
 * Validate the DatasetSnapshotRecord/1 acquisition provenance up front, using
 * the contract's own normalizer so this module invents no second definition.
 * @param {unknown} value @param {string} probeCoreId
 */
function normalizeAcquisitionProvenance(value, probeCoreId) {
  if (!isPlainObject(value)) fail('PERSISTENCE_ACQUISITION_PROVENANCE_INVALID', 'acquisition provenance must be a plain object');
  let record;
  try {
    record = normalizeDatasetSnapshotRecordV1({
      schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
      snapshotCoreId: probeCoreId,
      .../** @type {Record<string, unknown>} */ (value),
    });
  } catch (cause) {
    fail('PERSISTENCE_ACQUISITION_PROVENANCE_INVALID', `acquisition provenance is not a valid ${DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION} body`, {
      causeCode: /** @type {{code?: string}} */ (cause)?.code ?? null,
      causeMessage: /** @type {Error} */ (cause)?.message ?? null,
    });
  }
  const { schemaVersion, snapshotCoreId, ...provenance } = /** @type {Record<string, unknown>} */ (record);
  return provenance;
}

/** @param {string} acquisitionKey @param {object} fields */
function journalEntry(acquisitionKey, fields) {
  return {
    schemaVersion: JARVISE_SNAPSHOT_JOURNAL_SCHEMA_VERSION,
    acquisitionKey,
    retrospectiveSemantics: RETROSPECTIVE_SEMANTICS,
    historicalReplaySupport: HISTORICAL_REPLAY_SUPPORT,
    stage: 'RAW_PINNED',
    sourceObjectId: null,
    sourceByteLength: 0,
    normalizedObjectId: null,
    normalizedSchemaVersion: null,
    snapshotCoreId: null,
    snapshotRecordId: null,
    instrumentBindingId: null,
    manifestVersions: [],
    manifestHeadId: null,
    acquisition: null,
    ...fields,
  };
}

/**
 * Deterministic, non-durable journal. Suitable for tests and for callers that
 * own their own durability.
 * @param {Record<string, object>} [seed]
 */
export function createJarviseSnapshotMemoryJournalR1(seed = {}) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  for (const [key, value] of Object.entries(seed)) entries.set(key, JSON.stringify(value));
  return Object.freeze({
    kind: 'MEMORY',
    /** @param {string} acquisitionKey */
    readEntry(acquisitionKey) {
      const raw = entries.get(acquisitionKey);
      return raw === undefined ? null : JSON.parse(raw);
    },
    /** @param {string} acquisitionKey @param {object} entry */
    writeEntry(acquisitionKey, entry) {
      entries.set(acquisitionKey, JSON.stringify(entry));
    },
    keys() {
      return [...entries.keys()].sort();
    },
  });
}

/**
 * Durable journal under a persistence root. Each entry is written to a
 * content-named temporary file, fsynced, then renamed over its final path, so
 * a crash either leaves the previous entry or the complete new one and never a
 * half-written stage.
 * @param {{root: string}} options
 */
export function createJarviseSnapshotDirectoryJournalR1(options) {
  const root = assertNonEmptyString(options?.root, 'journal root');
  if (!isAbsolute(root)) fail('PERSISTENCE_INPUT_INVALID', 'journal root must be an absolute path');
  const journalRoot = resolve(root, 'journal');
  mkdirSync(journalRoot, { recursive: true });
  if (lstatSync(journalRoot).isSymbolicLink()) {
    fail('PERSISTENCE_REPARSE_POINT_FORBIDDEN', 'journal root cannot be a symlink or junction');
  }

  /** @param {string} acquisitionKey */
  const entryPath = (acquisitionKey) => resolve(
    journalRoot,
    `${createHash('sha256').update(assertNonEmptyString(acquisitionKey, 'acquisitionKey'), 'utf8').digest('hex')}.json`,
  );

  return Object.freeze({
    kind: 'DIRECTORY',
    root: journalRoot,
    /** @param {string} acquisitionKey */
    readEntry(acquisitionKey) {
      const path = entryPath(acquisitionKey);
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (cause) {
        if (/** @type {{code?: string}} */ (cause)?.code === 'ENOENT') return null;
        throw cause;
      }
      const entry = JSON.parse(text);
      if (entry?.acquisitionKey !== acquisitionKey) {
        fail('PERSISTENCE_JOURNAL_CORRUPT', 'journal entry does not match its acquisition key', { path });
      }
      return entry;
    },
    /** @param {string} acquisitionKey @param {object} entry */
    writeEntry(acquisitionKey, entry) {
      const path = entryPath(acquisitionKey);
      const bytes = Buffer.from(`${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      const temporaryPath = `${path}.${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.tmp`;
      const handle = openSync(temporaryPath, 'w');
      try {
        writeFileSync(handle, bytes);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporaryPath, path);
    },
  });
}

/**
 * @param {{
 *   store: any,
 *   journal: {readEntry: Function, writeEntry: Function},
 *   acquisitionAuthority: unknown,
 *   toolVersion?: string,
 * }} options
 */
export function createJarviseSnapshotPersistenceR1(options) {
  if (!isPlainObject(options)) fail('PERSISTENCE_INPUT_INVALID', 'persistence options are required');
  const store = options.store;
  for (const method of STORE_METHODS) {
    if (!store || typeof store[method] !== 'function') fail('PERSISTENCE_STORE_INVALID', `store.${method} is required`);
  }
  const journal = options.journal;
  for (const method of JOURNAL_METHODS) {
    if (!journal || typeof (/** @type {any} */ (journal))[method] !== 'function') {
      fail('PERSISTENCE_JOURNAL_INVALID', `journal.${method} is required`);
    }
  }
  const authority = normalizeAcquisitionAuthority(options.acquisitionAuthority);
  const toolVersion = options.toolVersion === undefined
    ? JARVISE_SNAPSHOT_PERSISTENCE_VERSION
    : assertNonEmptyString(options.toolVersion, 'toolVersion');

  let acquisitionInvocations = 0;

  /** @param {string} acquisitionKey */
  function loadEntry(acquisitionKey) {
    const entry = journal.readEntry(acquisitionKey);
    if (entry === null || entry === undefined) return null;
    if (!isPlainObject(entry) || entry.schemaVersion !== JARVISE_SNAPSHOT_JOURNAL_SCHEMA_VERSION) {
      fail('PERSISTENCE_JOURNAL_CORRUPT', 'journal entry is not a recognised persistence journal entry', { acquisitionKey });
    }
    stageIndex(/** @type {string} */ (entry.stage));
    return /** @type {Record<string, any>} */ (entry);
  }

  /** @param {string} acquisitionKey @param {string} minimumStage */
  function requireEntry(acquisitionKey, minimumStage) {
    const entry = loadEntry(acquisitionKey);
    if (entry === null) {
      fail('PERSISTENCE_STAGE_NOT_REACHED', `no pinned snapshot for ${acquisitionKey}`, { required: minimumStage, stage: 'EMPTY' });
    }
    if (stageIndex(entry.stage) < stageIndex(minimumStage)) {
      fail('PERSISTENCE_STAGE_NOT_REACHED', `stage ${entry.stage} precedes ${minimumStage}`, {
        acquisitionKey, stage: entry.stage, required: minimumStage,
      });
    }
    return entry;
  }

  /** @param {Record<string, any>} entry */
  function readPinnedSourceBytes(entry) {
    const uri = store.uriForObject({ namespace: 'source', objectId: entry.sourceObjectId });
    const object = store.readObject({ uri, expectedObjectId: entry.sourceObjectId });
    if (object.sizeBytes !== entry.sourceByteLength) {
      fail('PERSISTENCE_RAW_PIN_DIVERGENCE', 'pinned raw byte length diverged from the journal', {
        acquisitionKey: entry.acquisitionKey, expected: entry.sourceByteLength, actual: object.sizeBytes,
      });
    }
    return object.bytes;
  }

  /** @param {Record<string, any>} entry */
  function readNormalizedValue(entry) {
    const uri = store.uriForObject({ namespace: 'normalized', objectId: entry.normalizedObjectId });
    return store.readCanonicalObject({
      uri, expectedObjectId: entry.normalizedObjectId, schemaVersion: entry.normalizedSchemaVersion,
    }).value;
  }

  return Object.freeze({
    version: JARVISE_SNAPSHOT_PERSISTENCE_VERSION,
    contracts: PERSISTENCE_CONTRACTS,
    stages: PERSISTENCE_STAGES,
    authority,

    /** Total number of times an injected acquirer was actually invoked. */
    acquisitionInvocations() {
      return acquisitionInvocations;
    },

    describe() {
      return Object.freeze({
        version: JARVISE_SNAPSHOT_PERSISTENCE_VERSION,
        contracts: PERSISTENCE_CONTRACTS,
        stages: PERSISTENCE_STAGES,
        retrospectiveSemantics: RETROSPECTIVE_SEMANTICS,
        historicalReplaySupport: HISTORICAL_REPLAY_SUPPORT,
        networkAuthorized: authority.networkAuthorized,
        acquisitionInvocations,
      });
    },

    /** @param {string} acquisitionKey */
    stageOf(acquisitionKey) {
      const entry = loadEntry(assertNonEmptyString(acquisitionKey, 'acquisitionKey'));
      return entry === null ? 'EMPTY' : entry.stage;
    },

    /**
     * Crash-safe resume. Recovers the durable stage from the journal, re-reads
     * every already-pinned object out of the CAS and names the next step. Once
     * RAW_PINNED is reached refetchRequired stays false forever.
     * @param {{acquisitionKey: string}} input
     */
    resume(input) {
      const acquisitionKey = assertNonEmptyString(input?.acquisitionKey, 'acquisitionKey');
      const entry = loadEntry(acquisitionKey);
      const stage = entry === null ? 'EMPTY' : entry.stage;
      const nextStep = {
        EMPTY: 'pinRawOnce',
        RAW_PINNED: 'normalizePinnedRaw',
        NORMALIZED: 'versionCache',
        VERSION_CACHED: 'reuse',
      }[stage];
      if (entry !== null) readPinnedSourceBytes(entry);
      if (entry !== null && entry.normalizedObjectId !== null) readNormalizedValue(entry);
      return Object.freeze({
        acquisitionKey,
        stage,
        nextStep,
        refetchRequired: stage === 'EMPTY',
        rawPinned: entry !== null,
        entry,
      });
    },

    /**
     * FETCH_ONCE. Pins raw bytes exactly once per acquisition key. When the key
     * is already RAW_PINNED the pinned object is re-verified and reused and no
     * acquirer is consulted, so zero refetch is structural rather than advisory.
     * @param {{
     *   acquisitionKey: string,
     *   acquisition: Record<string, unknown>,
     *   rawBytes?: Buffer|Uint8Array,
     *   acquireRawBytes?: () => Buffer|Uint8Array,
     * }} input
     */
    pinRawOnce(input) {
      if (!isPlainObject(input)) fail('PERSISTENCE_INPUT_INVALID', 'pinRawOnce input is required');
      const acquisitionKey = assertNonEmptyString(input.acquisitionKey, 'acquisitionKey');
      const existing = loadEntry(acquisitionKey);
      if (existing !== null) {
        const bytes = readPinnedSourceBytes(existing);
        return Object.freeze({
          acquisitionKey,
          stage: existing.stage,
          sourceObjectId: existing.sourceObjectId,
          sourceByteLength: bytes.length,
          acquired: false,
          reused: true,
        });
      }

      let rawBytes;
      if (input.acquireRawBytes !== undefined) {
        if (typeof input.acquireRawBytes !== 'function') fail('PERSISTENCE_INPUT_INVALID', 'acquireRawBytes must be a function');
        if (!authority.networkAuthorized) {
          fail('PERSISTENCE_ACQUISITION_FORBIDDEN', `acquisition authority ${authority.authorityId} does not authorize network acquisition`, {
            authorityId: authority.authorityId,
          });
        }
        acquisitionInvocations += 1;
        rawBytes = input.acquireRawBytes();
      } else {
        rawBytes = input.rawBytes;
      }
      if (!Buffer.isBuffer(rawBytes) && !(rawBytes instanceof Uint8Array)) {
        fail('PERSISTENCE_INPUT_INVALID', 'raw bytes must be supplied as a Buffer or Uint8Array');
      }
      if (rawBytes.length === 0) fail('PERSISTENCE_INPUT_INVALID', 'raw bytes must not be empty');

      const sourceObject = store.putSourceBytes(rawBytes);
      const acquisition = normalizeAcquisitionProvenance(input.acquisition, sourceObject.objectId);
      const entry = journalEntry(acquisitionKey, {
        stage: 'RAW_PINNED',
        sourceObjectId: sourceObject.objectId,
        sourceByteLength: sourceObject.sizeBytes,
        acquisition,
      });
      // The CAS object is durable and re-verified before the journal advances,
      // so a crash between the two loses the journal entry, never the bytes.
      store.readObject({
        uri: store.uriForObject({ namespace: 'source', objectId: sourceObject.objectId }),
        expectedObjectId: sourceObject.objectId,
      });
      journal.writeEntry(acquisitionKey, entry);
      return Object.freeze({
        acquisitionKey,
        stage: 'RAW_PINNED',
        sourceObjectId: sourceObject.objectId,
        sourceByteLength: sourceObject.sizeBytes,
        acquired: input.acquireRawBytes !== undefined,
        reused: false,
      });
    },

    /**
     * NORMALIZE. Runs a caller-supplied pure normalizer over the pinned raw
     * bytes and pins the canonical result. Already-normalized keys are reused
     * and the normalizer is not called again.
     * @param {{acquisitionKey: string, normalize: (bytes: Buffer) => unknown}} input
     */
    normalizePinnedRaw(input) {
      if (!isPlainObject(input)) fail('PERSISTENCE_INPUT_INVALID', 'normalizePinnedRaw input is required');
      const acquisitionKey = assertNonEmptyString(input.acquisitionKey, 'acquisitionKey');
      const entry = requireEntry(acquisitionKey, 'RAW_PINNED');
      if (entry.normalizedObjectId !== null) {
        return Object.freeze({
          acquisitionKey,
          stage: entry.stage,
          normalizedObjectId: entry.normalizedObjectId,
          normalizedSchemaVersion: entry.normalizedSchemaVersion,
          reused: true,
        });
      }
      if (typeof input.normalize !== 'function') fail('PERSISTENCE_INPUT_INVALID', 'normalize must be a function');

      const normalizedValue = input.normalize(readPinnedSourceBytes(entry));
      if (!isPlainObject(normalizedValue)) fail('PERSISTENCE_NORMALIZATION_INVALID', 'normalize must return a plain object');
      const normalizedSchemaVersion = /** @type {Record<string, unknown>} */ (normalizedValue).schemaVersion;
      if (typeof normalizedSchemaVersion !== 'string' || normalizedSchemaVersion.length === 0) {
        fail('PERSISTENCE_NORMALIZATION_INVALID', 'normalized content must carry a schemaVersion');
      }
      const normalizedObject = store.putCanonicalObject({
        namespace: 'normalized', schemaVersion: normalizedSchemaVersion, value: normalizedValue,
      });
      store.readObject({
        uri: store.uriForObject({ namespace: 'normalized', objectId: normalizedObject.objectId }),
        expectedObjectId: normalizedObject.objectId,
      });
      journal.writeEntry(acquisitionKey, {
        ...entry, stage: 'NORMALIZED', normalizedObjectId: normalizedObject.objectId, normalizedSchemaVersion,
      });
      return Object.freeze({
        acquisitionKey,
        stage: 'NORMALIZED',
        normalizedObjectId: normalizedObject.objectId,
        normalizedSchemaVersion,
        reused: false,
      });
    },

    /**
     * VERSION_CACHE. Publishes the immutable content-addressed snapshot core,
     * acquisition record and SnapshotDatasetManifestV1 over the already-pinned
     * bytes. Manifests are append-only: a new manifest gets a new object ID and
     * every previously published manifest stays byte-identical in the CAS.
     * @param {{
     *   acquisitionKey: string,
     *   core: Record<string, unknown>,
     *   legacyManifest?: unknown,
     *   instrumentBinding?: Record<string, unknown>,
     *   createdByVersion?: string,
     * }} input
     */
    versionCache(input) {
      if (!isPlainObject(input)) fail('PERSISTENCE_INPUT_INVALID', 'versionCache input is required');
      const acquisitionKey = assertNonEmptyString(input.acquisitionKey, 'acquisitionKey');
      const entry = requireEntry(acquisitionKey, 'NORMALIZED');
      if (!isPlainObject(input.core)) fail('PERSISTENCE_INPUT_INVALID', 'core identity fields must be a plain object');
      if (input.legacyManifest !== undefined && input.legacyManifest !== null) {
        if (!isPlainObject(input.legacyManifest)) fail('PERSISTENCE_INPUT_INVALID', 'legacyManifest must be a plain object');
        const coverageVersion = /** @type {Record<string, unknown>} */ (input.legacyManifest).coverageVersion;
        if (coverageVersion !== COVERAGE_VERSION) {
          fail('PERSISTENCE_COVERAGE_VERSION_INVALID', `legacyManifest.coverageVersion must be ${COVERAGE_VERSION}`, { coverageVersion });
        }
      }

      const snapshot = buildDatasetSnapshot({
        store,
        sourceBytes: readPinnedSourceBytes(entry),
        normalizedDailyBars: readNormalizedValue(entry),
        core: input.core,
        record: entry.acquisition,
      });
      if (snapshot.sourceObject.objectId !== entry.sourceObjectId) {
        fail('PERSISTENCE_RAW_PIN_DIVERGENCE', 'rebuilt snapshot does not reference the pinned raw object', {
          acquisitionKey, expected: entry.sourceObjectId, actual: snapshot.sourceObject.objectId,
        });
      }
      if (snapshot.normalizedObject.objectId !== entry.normalizedObjectId) {
        fail('PERSISTENCE_NORMALIZED_PIN_DIVERGENCE', 'rebuilt snapshot does not reference the pinned normalized object', {
          acquisitionKey, expected: entry.normalizedObjectId, actual: snapshot.normalizedObject.objectId,
        });
      }

      const manifest = buildSnapshotDatasetManifest({
        store,
        snapshotCoreId: snapshot.snapshotCore.objectId,
        snapshotRecordId: snapshot.snapshotRecord.objectId,
        legacyManifest: input.legacyManifest ?? undefined,
        createdByVersion: input.createdByVersion ?? toolVersion,
      });

      let instrumentBindingId = entry.instrumentBindingId;
      if (input.instrumentBinding !== undefined) {
        if (!isPlainObject(input.instrumentBinding)) fail('PERSISTENCE_INPUT_INVALID', 'instrumentBinding must be a plain object');
        const binding = normalizeDatasetSnapshotInstrumentBindingV1({
          schemaVersion: DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
          snapshotCoreId: snapshot.snapshotCore.objectId,
          ...input.instrumentBinding,
        });
        instrumentBindingId = store.putCanonicalObject({
          namespace: 'snapshots', schemaVersion: DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION, value: binding,
        }).objectId;
      }

      const alreadyPublished = entry.manifestVersions.includes(manifest.manifestId);
      const manifestVersions = alreadyPublished ? entry.manifestVersions : [...entry.manifestVersions, manifest.manifestId];
      journal.writeEntry(acquisitionKey, {
        ...entry,
        stage: 'VERSION_CACHED',
        snapshotCoreId: snapshot.snapshotCore.objectId,
        snapshotRecordId: snapshot.snapshotRecord.objectId,
        instrumentBindingId,
        manifestVersions,
        manifestHeadId: manifest.manifestId,
      });
      return Object.freeze({
        acquisitionKey,
        stage: 'VERSION_CACHED',
        snapshotCoreId: snapshot.snapshotCore.objectId,
        snapshotRecordId: snapshot.snapshotRecord.objectId,
        manifestId: manifest.manifestId,
        manifestVersions: Object.freeze([...manifestVersions]),
        instrumentBindingId,
        reused: alreadyPublished,
      });
    },

    /**
     * REUSE. Recovers the cached version from the journal head alone and
     * re-verifies the complete evidence chain out of the CAS. No acquirer is
     * reachable from this path at all.
     * @param {{acquisitionKey: string}} input
     */
    reuse(input) {
      const acquisitionKey = assertNonEmptyString(input?.acquisitionKey, 'acquisitionKey');
      const entry = requireEntry(acquisitionKey, 'VERSION_CACHED');
      const manifestId = assertObjectId(entry.manifestHeadId, 'manifestHeadId');
      const recovered = verifySnapshotDatasetManifest({ store, snapshotDatasetManifestId: manifestId });
      const snapshot = verifyDatasetSnapshot({ store, snapshotRecordId: entry.snapshotRecordId });
      if (snapshot.core.sourceObjectId !== entry.sourceObjectId
        || snapshot.core.normalizedObjectId !== entry.normalizedObjectId) {
        fail('PERSISTENCE_RAW_PIN_DIVERGENCE', 'recovered snapshot does not reference the pinned objects', { acquisitionKey });
      }
      return Object.freeze({
        acquisitionKey,
        manifestId,
        manifestVersions: Object.freeze([...entry.manifestVersions]),
        manifest: recovered.manifest,
        snapshot,
        acquisition: entry.acquisition,
        historicalReplaySupport: HISTORICAL_REPLAY_SUPPORT,
        retrospectiveSemantics: RETROSPECTIVE_SEMANTICS,
        refetched: false,
      });
    },
  });
}

export {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  COVERAGE_VERSION,
  DATASET_MANIFEST_SCHEMA_VERSION,
  DATASET_SNAPSHOT_CORE_SCHEMA_VERSION,
  DATASET_SNAPSHOT_INSTRUMENT_BINDING_SCHEMA_VERSION,
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  SNAPSHOT_DATASET_MANIFEST_SCHEMA_VERSION,
};
