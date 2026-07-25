/** Immutable SEC document bytes and their pinned metadata core. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  putCanonicalL3,
  readTypedReference,
  sha256Digest,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION,
  normalizeSecDocumentBytesCoreV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';

export function putEarningsSecDocumentBytes(input) {
  const api = assertApiInput(input, ['bytes', 'mediaType', 'documentFormat', 'documentRole']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  if (!Buffer.isBuffer(api.bytes) && !(api.bytes instanceof Uint8Array)) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_INVALID', 'bytes must be supplied as bytes');
  }
  const bytes = Buffer.from(api.bytes);
  if (bytes.length === 0) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_INVALID', 'empty SEC documents are forbidden');
  }
  let raw;
  try { raw = api.store.putSourceBytes(bytes); } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_INVALID',
      'SEC document bytes could not be stored', { cause });
  }
  const core = normalizeSecDocumentBytesCoreV1({
    schemaVersion: SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION,
    documentObjectId: raw.objectId,
    sha256: sha256Digest(bytes),
    byteLength: bytes.length,
    mediaType: api.mediaType,
    documentFormat: api.documentFormat,
    documentRole: api.documentRole,
  });
  const stored = putCanonicalL3(api.store, SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION, core);
  return {
    secDocumentBytesId: stored.objectId,
    secDocumentBytesCore: stored.value,
    documentObjectId: raw.objectId,
  };
}

export const putSecDocumentBytesCore = putEarningsSecDocumentBytes;
export const buildSecDocumentBytesCore = putEarningsSecDocumentBytes;

export function verifyEarningsSecDocumentBytes(input) {
  const api = assertApiInput(input, ['secDocumentBytesId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let core;
  try {
    core = normalizeSecDocumentBytesCoreV1(readTypedReference(api.store, api.secDocumentBytesId,
      SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION, 'SEC document bytes core'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_MISSING',
      'SEC document bytes core is missing or corrupt', { cause });
  }
  let raw;
  try {
    raw = api.store.readObject({
      uri: api.store.uriForObject({ namespace: 'source', objectId: core.documentObjectId }),
      expectedObjectId: core.documentObjectId,
    });
  } catch (cause) {
    if (cause?.code === 'CAS_OBJECT_CORRUPT' || cause?.code === 'CAS_EXISTING_CONTENT_MISMATCH') {
      throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_MISMATCH',
        'raw SEC document bytes fail their content-addressed digest', { cause });
    }
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_MISSING',
      'raw SEC document bytes are missing', { cause });
  }
  if (raw.bytes.length !== core.byteLength || sha256Digest(raw.bytes) !== core.sha256
      || core.documentObjectId !== core.sha256) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_BYTES_MISMATCH',
      'raw SEC document bytes diverge from their immutable core');
  }
  return {
    secDocumentBytesId: api.secDocumentBytesId,
    secDocumentBytesCore: core,
    bytes: raw.bytes,
  };
}

export const verifySecDocumentBytesCore = verifyEarningsSecDocumentBytes;
