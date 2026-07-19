import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalHash, canonicalJsonBytes, parseCanonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS, normalizeCanonicalValue } from '../canonical/canonicalSchemaRegistryV1.mjs';
import { CANONICAL_DAILY_BARS_SCHEMA_VERSION } from '../canonical/canonicalDailyBarsV1.mjs';
import { SHA256_OBJECT_ID_PATTERN } from '../contracts/datasetSnapshotV1.mjs';

/**
 * Closed set of schemas accepted in the L1 `normalized` namespace.
 * MarketDataEodOhlcvCanonicalRows/1 is the additive L3-I5 atom-preserving
 * content schema (literal kept here to avoid a storage↔contract cycle).
 */
const NORMALIZED_NAMESPACE_SCHEMA_VERSIONS = Object.freeze([
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  'MarketDataEodOhlcvCanonicalRows/1',
  'MarketTechnicalFeatureRows/1',
]);

export class ContentAddressedStoreError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'ContentAddressedStoreError';
    this.code = code;
    this.details = details;
  }
}

/** @param {Buffer} bytes */
function sha256ObjectId(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** @param {unknown} error @param {string} operation */
function mapFsError(error, operation) {
  const fsCode = /** @type {{code?: string}} */ (error)?.code;
  if (fsCode === 'EACCES' || fsCode === 'EPERM') {
    return new ContentAddressedStoreError('CAS_PERMISSION_DENIED', `${operation}: permission denied`, { fsCode, cause: error });
  }
  if (fsCode === 'ENOSPC') {
    return new ContentAddressedStoreError('CAS_NO_SPACE', `${operation}: filesystem has no free space`, { fsCode, cause: error });
  }
  return error;
}

/** @param {string} uri */
function validatePortableUri(uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', 'URI must be a non-empty relative string');
  }
  if (uri.includes('\0') || uri.includes('\\') || uri.includes(':') || uri.startsWith('/') || isAbsolute(uri)) {
    throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', `forbidden CAS URI: ${uri}`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) {
    throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', `URI schemes are forbidden: ${uri}`);
  }
  const segments = uri.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', `non-portable CAS URI: ${uri}`);
  }
  return segments;
}

/** @param {string} objectId */
function objectHex(objectId) {
  if (typeof objectId !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(objectId)) {
    throw new ContentAddressedStoreError('CAS_OBJECT_CORRUPT', `invalid expected object ID: ${String(objectId)}`);
  }
  return objectId.slice('sha256:'.length);
}

/** @param {'source'|'normalized'|'snapshots'} namespace @param {string} objectId */
function uriFor(namespace, objectId) {
  const hex = objectHex(objectId);
  if (namespace === 'source') return `objects/source/sha256/${hex.slice(0, 2)}/${hex}`;
  if (namespace === 'normalized') return `objects/normalized/sha256/${hex.slice(0, 2)}/${hex}`;
  if (namespace === 'snapshots') return `snapshots/sha256/${hex.slice(0, 2)}/${hex}.json`;
  throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', `unsupported namespace: ${String(namespace)}`);
}

/**
 * Local immutable CAS. All methods are synchronous so a completed call means
 * the final object has already been re-read and verified.
 * @param {{root: string, atomicPublishMode?: 'link'|'unsupported'}} options
 */
export function createContentAddressedStore(options) {
  if (!options || typeof options.root !== 'string' || options.root.length === 0) {
    throw new ContentAddressedStoreError('CAS_ROOT_REQUIRED', 'an explicit CAS root is required');
  }
  if (!isAbsolute(options.root)) {
    throw new ContentAddressedStoreError('CAS_ROOT_NOT_ABSOLUTE', `CAS root must be absolute: ${options.root}`);
  }
  if (!existsSync(options.root)) {
    throw new ContentAddressedStoreError('CAS_ROOT_MISSING', `CAS root does not exist: ${options.root}`);
  }
  let rootStat;
  try { rootStat = lstatSync(options.root); } catch (error) { throw mapFsError(error, 'inspect root'); }
  if (!rootStat.isDirectory()) throw new ContentAddressedStoreError('CAS_ROOT_MISSING', 'CAS root is not a directory');
  if (rootStat.isSymbolicLink()) {
    throw new ContentAddressedStoreError('CAS_REPARSE_POINT_FORBIDDEN', 'CAS root cannot be a symlink or junction');
  }
  const root = resolve(options.root);
  const atomicPublishMode = options.atomicPublishMode ?? 'link';
  if (!['link', 'unsupported'].includes(atomicPublishMode)) {
    throw new ContentAddressedStoreError('CAS_ATOMIC_PUBLISH_UNSUPPORTED', `unsupported publish mode: ${String(atomicPublishMode)}`);
  }

  /** @param {string} uri */
  function physicalPath(uri) {
    const segments = validatePortableUri(uri);
    const candidate = resolve(root, ...segments);
    const rel = relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', `URI escapes CAS root: ${uri}`);
    }
    return { candidate, segments };
  }

  /** @param {string} path @param {string} label */
  function assertNotReparse(path, label) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new ContentAddressedStoreError('CAS_REPARSE_POINT_FORBIDDEN', `${label} is a symlink or junction`, { path });
    }
    return stat;
  }

  /** @param {string[]} directorySegments */
  function ensureSafeDirectories(directorySegments) {
    let current = root;
    for (const segment of directorySegments) {
      current = resolve(current, segment);
      if (!existsSync(current)) {
        try { mkdirSync(current); } catch (error) {
          if (/** @type {{code?: string}} */ (error).code !== 'EEXIST') throw mapFsError(error, `create directory ${segment}`);
        }
      }
      let stat;
      try { stat = assertNotReparse(current, `CAS path segment ${segment}`); } catch (error) { throw mapFsError(error, `inspect directory ${segment}`); }
      if (!stat.isDirectory()) throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', `CAS path segment is not a directory: ${segment}`);
    }
  }

  /** @param {string} uri */
  function assertSafeExistingPath(uri) {
    const { candidate, segments } = physicalPath(uri);
    let current = root;
    for (const segment of segments) {
      current = resolve(current, segment);
      if (!existsSync(current)) break;
      try { assertNotReparse(current, `CAS path segment ${segment}`); } catch (error) { throw mapFsError(error, `inspect ${uri}`); }
    }
    return candidate;
  }

  /** @param {string} targetPath @param {string} uri @param {string} expectedObjectId @param {Buffer|undefined} expectedBytes @param {string} mismatchCode */
  function verifyPath(targetPath, uri, expectedObjectId, expectedBytes, mismatchCode) {
    let stat;
    let bytes;
    try {
      stat = assertNotReparse(targetPath, `CAS object ${uri}`);
      if (!stat.isFile()) throw new ContentAddressedStoreError(mismatchCode, `CAS object is not a regular file: ${uri}`);
      bytes = readFileSync(targetPath);
    } catch (error) {
      if (error instanceof ContentAddressedStoreError) throw error;
      const fsCode = /** @type {{code?: string}} */ (error).code;
      if (fsCode === 'ENOENT') {
        throw new ContentAddressedStoreError('CAS_OBJECT_CORRUPT', `CAS object is missing: ${uri}`, { uri, expectedObjectId, fsCode });
      }
      throw mapFsError(error, `read ${uri}`);
    }
    const actualObjectId = sha256ObjectId(bytes);
    if (actualObjectId !== expectedObjectId || stat.size !== bytes.length || (expectedBytes && !bytes.equals(expectedBytes))) {
      throw new ContentAddressedStoreError(mismatchCode, `content mismatch for immutable object ${uri}`, {
        uri, expectedObjectId, actualObjectId, expectedSizeBytes: expectedBytes?.length, actualSizeBytes: bytes.length,
      });
    }
    return { objectId: actualObjectId, uri, sizeBytes: bytes.length, bytes };
  }

  /** @param {string} lockPath @param {string} uri */
  function classifyExistingLock(lockPath, uri) {
    let lock;
    try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch {
      throw new ContentAddressedStoreError('CAS_LOCK_RECOVERY_REQUIRED', `lock metadata is unreadable for ${uri}`, { lockPath });
    }
    if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0 || typeof lock?.createdAt !== 'string') {
      throw new ContentAddressedStoreError('CAS_LOCK_RECOVERY_REQUIRED', `lock metadata is invalid for ${uri}`, { lockPath });
    }
    try {
      process.kill(lock.pid, 0);
      throw new ContentAddressedStoreError('CAS_LOCK_EXISTS', `another writer holds the lock for ${uri}`, { lockPath, pid: lock.pid });
    } catch (error) {
      if (error instanceof ContentAddressedStoreError) throw error;
      if (/** @type {{code?: string}} */ (error).code === 'ESRCH') {
        throw new ContentAddressedStoreError('CAS_LOCK_RECOVERY_REQUIRED', `abandoned lock requires administrative recovery for ${uri}`, { lockPath, pid: lock.pid });
      }
      throw new ContentAddressedStoreError('CAS_LOCK_EXISTS', `writer liveness cannot be disproved for ${uri}`, { lockPath, pid: lock.pid });
    }
  }

  /** @param {string} targetPath @param {string} uri */
  function acquireLock(targetPath, uri) {
    const lockPath = `${targetPath}.lock`;
    let fd;
    try { fd = openSync(lockPath, 'wx', 0o600); } catch (error) {
      if (/** @type {{code?: string}} */ (error).code === 'EEXIST') classifyExistingLock(lockPath, uri);
      throw mapFsError(error, `acquire lock for ${uri}`);
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch {}
      throw mapFsError(error, `write lock for ${uri}`);
    }
    return { fd, lockPath };
  }

  /** @param {{fd: number, lockPath: string}} lock */
  function releaseLock(lock) {
    try { closeSync(lock.fd); } finally {
      try { unlinkSync(lock.lockPath); } catch (error) {
        if (/** @type {{code?: string}} */ (error).code !== 'ENOENT') throw mapFsError(error, 'release lock');
      }
    }
  }

  /** @param {string} directoryPath */
  function fsyncDirectoryWhenSupported(directoryPath) {
    let fd;
    try {
      fd = openSync(directoryPath, 'r');
      fsyncSync(fd);
    } catch (error) {
      const code = /** @type {{code?: string}} */ (error).code;
      if (!['EINVAL', 'EPERM', 'EACCES', 'EISDIR'].includes(code ?? '')) throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** @param {{bytes: Buffer, objectId: string, uri: string}} input */
  function putBytes(input) {
    const { candidate: targetPath, segments } = physicalPath(input.uri);
    ensureSafeDirectories(segments.slice(0, -1));
    assertSafeExistingPath(input.uri);
    const expectedName = input.objectId.slice('sha256:'.length) + (input.uri.endsWith('.json') ? '.json' : '');
    if (basename(targetPath) !== expectedName) throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', 'object ID does not match target URI');
    const lock = acquireLock(targetPath, input.uri);
    let temporaryPath;
    try {
      if (existsSync(targetPath)) {
        const verified = verifyPath(targetPath, input.uri, input.objectId, input.bytes, 'CAS_EXISTING_CONTENT_MISMATCH');
        return { objectId: verified.objectId, uri: input.uri, sizeBytes: verified.sizeBytes, created: false };
      }
      temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
      let temporaryFd;
      try {
        temporaryFd = openSync(temporaryPath, 'wx', 0o600);
        writeFileSync(temporaryFd, input.bytes);
        fsyncSync(temporaryFd);
      } catch (error) {
        throw mapFsError(error, `write temporary object ${input.uri}`);
      } finally {
        if (temporaryFd !== undefined) closeSync(temporaryFd);
      }
      verifyPath(temporaryPath, input.uri, input.objectId, input.bytes, 'CAS_OBJECT_CORRUPT');
      if (atomicPublishMode === 'unsupported') {
        throw new ContentAddressedStoreError('CAS_ATOMIC_PUBLISH_UNSUPPORTED', `atomic no-replace publication disabled for ${input.uri}`);
      }
      try {
        linkSync(temporaryPath, targetPath);
      } catch (error) {
        const code = /** @type {{code?: string}} */ (error).code;
        if (code === 'EEXIST') {
          const verified = verifyPath(targetPath, input.uri, input.objectId, input.bytes, 'CAS_EXISTING_CONTENT_MISMATCH');
          return { objectId: verified.objectId, uri: input.uri, sizeBytes: verified.sizeBytes, created: false };
        }
        if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code ?? '')) {
          throw new ContentAddressedStoreError('CAS_ATOMIC_PUBLISH_UNSUPPORTED', `hard-link no-replace publication unavailable for ${input.uri}`, { fsCode: code });
        }
        throw mapFsError(error, `publish ${input.uri}`);
      }
      unlinkSync(temporaryPath);
      temporaryPath = undefined;
      fsyncDirectoryWhenSupported(dirname(targetPath));
      const verified = verifyPath(targetPath, input.uri, input.objectId, input.bytes, 'CAS_OBJECT_CORRUPT');
      return { objectId: verified.objectId, uri: input.uri, sizeBytes: verified.sizeBytes, created: true };
    } finally {
      if (temporaryPath && existsSync(temporaryPath)) {
        try { unlinkSync(temporaryPath); } catch {}
      }
      releaseLock(lock);
    }
  }

  return Object.freeze({
    root,

    /** @param {{namespace: 'source'|'normalized'|'snapshots', objectId: string}} input */
    uriForObject(input) {
      return uriFor(input.namespace, input.objectId);
    },

    /** @param {Buffer|Uint8Array} bytes */
    putSourceBytes(bytes) {
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
        throw new ContentAddressedStoreError('CAS_OBJECT_CORRUPT', 'source object must be supplied as bytes');
      }
      const exactBytes = Buffer.from(bytes);
      const objectId = sha256ObjectId(exactBytes);
      return putBytes({ bytes: exactBytes, objectId, uri: uriFor('source', objectId) });
    },

    /** @param {{namespace: 'normalized'|'snapshots', schemaVersion: string, value: unknown}} input */
    putCanonicalObject(input) {
      if (!input || !['normalized', 'snapshots'].includes(input.namespace)) {
        throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', 'canonical namespace must be normalized or snapshots');
      }
      if (input.namespace === 'normalized'
          && !NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(input.schemaVersion)) {
        throw new ContentAddressedStoreError(
          'CAS_PATH_ESCAPE',
          'normalized namespace only accepts registered closed normalized content schemas',
        );
      }
      if (input.namespace === 'snapshots' && !SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(input.schemaVersion)) {
        throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', 'snapshots namespace only accepts registered snapshot metadata schemas');
      }
      const normalized = normalizeCanonicalValue(input.schemaVersion, input.value);
      const bytes = canonicalJsonBytes(normalized);
      const objectId = canonicalHash(input.schemaVersion, normalized);
      return { ...putBytes({ bytes, objectId, uri: uriFor(input.namespace, objectId) }), value: normalized };
    },

    /** @param {{uri: string, expectedObjectId: string}} input */
    readObject(input) {
      if (!input || typeof input !== 'object') throw new ContentAddressedStoreError('CAS_PATH_ESCAPE', 'read input is required');
      const hex = objectHex(input.expectedObjectId);
      const path = assertSafeExistingPath(input.uri);
      const expectedName = hex + (input.uri.endsWith('.json') ? '.json' : '');
      if (basename(path) !== expectedName) {
        throw new ContentAddressedStoreError('CAS_OBJECT_CORRUPT', 'URI filename does not match expected object ID', { uri: input.uri });
      }
      return verifyPath(path, input.uri, input.expectedObjectId, undefined, 'CAS_OBJECT_CORRUPT');
    },

    /** @param {{uri: string, expectedObjectId: string}} input */
    verifyObject(input) {
      const result = this.readObject(input);
      return { objectId: result.objectId, uri: result.uri, sizeBytes: result.sizeBytes, verified: true };
    },

    /** @param {{uri: string, expectedObjectId: string, schemaVersion: string}} input */
    readCanonicalObject(input) {
      const result = this.readObject(input);
      try {
        const parsed = parseCanonicalJsonBytes(result.bytes);
        const value = normalizeCanonicalValue(input.schemaVersion, parsed);
        const actualObjectId = canonicalHash(input.schemaVersion, value);
        if (actualObjectId !== input.expectedObjectId) {
          throw new ContentAddressedStoreError('CAS_OBJECT_CORRUPT', `canonical schema/hash mismatch for ${input.uri}`, {
            expectedObjectId: input.expectedObjectId, actualObjectId,
          });
        }
        return { ...result, value };
      } catch (error) {
        if (error instanceof ContentAddressedStoreError) throw error;
        throw new ContentAddressedStoreError('CAS_OBJECT_CORRUPT', `canonical object is structurally invalid: ${input.uri}`, {
          expectedObjectId: input.expectedObjectId,
          canonicalErrorCode: error?.code,
          cause: error,
        });
      }
    },
  });
}
