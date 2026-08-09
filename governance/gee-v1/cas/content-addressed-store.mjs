import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, sha256Bytes } from '../../tools/canonical-json.mjs';

export const CAS_VERSION = 'GEE_V1_CONTENT_ADDRESSED_STORE_R4';

function asBytes(content) {
  if (Buffer.isBuffer(content)) return Buffer.from(content);
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content && typeof content === 'object') return Buffer.from(canonicalize(content), 'utf8');
  throw new Error('CAS_CONTENT_BYTES_REQUIRED');
}

function hashId(hash) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_CAS_ID');
  return `sha256:${hash}`;
}

function hashFromId(id) {
  if (typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('INVALID_CAS_ID');
  return id.slice('sha256:'.length);
}

export function createContentAddressedStore(root) {
  if (typeof root !== 'string' || !root) throw new Error('CAS_ROOT_REQUIRED');
  const casRoot = path.resolve(root);

  function fileFor(hash) {
    return path.join(casRoot, hash.slice(0, 2), hash.slice(2));
  }

  return {
    version: CAS_VERSION,
    root: casRoot,
    identity(content) {
      const bytes = asBytes(content);
      const hash = sha256Bytes(bytes);
      return { id: hashId(hash), sha256: hash, bytes: bytes.length };
    },
    put(content) {
      const bytes = asBytes(content);
      const hash = sha256Bytes(bytes);
      const file = fileFor(hash);
      let created = false;
      if (fs.existsSync(file)) {
        const stored = fs.readFileSync(file);
        if (sha256Bytes(stored) !== hash) throw new Error(`CAS_TAMPER_DETECTED:${hashId(hash)}`);
        if (!stored.equals(bytes)) throw new Error(`CAS_TAMPER_DETECTED:${hashId(hash)}`);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { flag: 'wx' });
        created = true;
      }
      return { id: hashId(hash), sha256: hash, bytes: bytes.length, created, path: file };
    },
    get(id) {
      const hash = hashFromId(id);
      const file = fileFor(hash);
      if (!fs.existsSync(file)) throw new Error(`CAS_CONTENT_MISSING:${id}`);
      const bytes = fs.readFileSync(file);
      if (sha256Bytes(bytes) !== hash) throw new Error(`CAS_TAMPER_DETECTED:${id}`);
      return Buffer.from(bytes);
    },
    has(id) {
      try {
        this.get(id);
        return true;
      } catch (error) {
        if (/^CAS_CONTENT_MISSING:/.test(error.message)) return false;
        throw error;
      }
    }
  };
}

export { asBytes };
