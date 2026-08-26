#!/usr/bin/env node
/**
 * BIND_GATE24_DEFERRED_CAPABILITIES — REFERENCE_ONLY IMPORT_BINDING of DC-01..12.
 *
 * Mandate bytes are resolved from HEAD, never from working-tree-only provenance.
 * Binding copies ratified semantics. It does not REGISTER, PROMOTE, rename or
 * reinterpret abandoned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256Bytes } from './canonical-json.mjs';
import { appendDeferredCapabilityRegistryEvents } from './append-deferred-capability-registry-events.mjs';

export const BINDER_DOCUMENT = 'BIND_GATE24_DEFERRED_CAPABILITIES';
export const BINDER_VERSION = 'V1';
export const MANDATE_PATH = 'governance/sources/GATE24_CANONICAL_MANDATE_R0.json';
export const REQUIRED_MANDATE_SHA256 = '67bd631a77c87785d623ccbf1051c33b5b5bc9d57855167a8763d8586a55115f';
export const REQUIRED_MANDATE_BYTE_LENGTH = 164934;
export const GATE24_IMPORT_IDS = Object.freeze([
  'GATE24-DC-01', 'GATE24-DC-02', 'GATE24-DC-03', 'GATE24-DC-04',
  'GATE24-DC-05', 'GATE24-DC-06', 'GATE24-DC-07', 'GATE24-DC-08',
  'GATE24-DC-09', 'GATE24-DC-10', 'GATE24-DC-11', 'GATE24-DC-12'
]);

function fail(code, detail = null) {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  error.detail = detail;
  throw error;
}

export function resolveCanonicalHeadBlob({ gitRoot, repoRelativePath }) {
  try {
    const bytes = execFileSync('git', ['cat-file', 'blob', `HEAD:${repoRelativePath}`], {
      cwd: gitRoot,
      encoding: 'buffer',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { present: true, bytes, sha256: sha256Bytes(bytes), byteLength: bytes.length };
  } catch (error) {
    return { present: false, bytes: null, sha256: null, byteLength: null, reason: error?.message ?? 'HEAD_BLOB_UNRESOLVED' };
  }
}

export function proveGate24MandateHeadPersistence({
  gitRoot,
  workingTreeRoot = gitRoot,
  requiredSha256 = REQUIRED_MANDATE_SHA256,
  requiredByteLength = REQUIRED_MANDATE_BYTE_LENGTH
}) {
  const head = resolveCanonicalHeadBlob({ gitRoot, repoRelativePath: MANDATE_PATH });
  if (!head.present) fail('GATE24_MANDATE_NOT_RESOLVABLE_FROM_HEAD', head.reason);
  if (head.sha256 !== requiredSha256 || head.byteLength !== requiredByteLength) {
    fail('GATE24_MANDATE_HEAD_BYTES_MISMATCH', `sha256=${head.sha256}:byteLength=${head.byteLength}`);
  }
  const workingFile = path.resolve(workingTreeRoot, ...MANDATE_PATH.split('/'));
  if (fs.existsSync(workingFile)) {
    const working = fs.readFileSync(workingFile);
    if (sha256Bytes(working) !== requiredSha256 || working.length !== requiredByteLength) {
      fail('GATE24_MANDATE_WORKING_TREE_BYTES_MISMATCH', sha256Bytes(working));
    }
    if (Buffer.compare(working, head.bytes) !== 0) {
      fail('GATE24_MANDATE_HEAD_WORKING_TREE_DIVERGENCE');
    }
  }
  return {
    path: MANDATE_PATH,
    headSha256: head.sha256,
    headByteLength: head.byteLength,
    requiredSha256,
    requiredByteLength,
    resolvableFromHead: true,
    workingTreeMatches: true
  };
}

function pointerGet(value, pointer) {
  const parts = pointer.split('/').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return { __missing: true };
    current = Array.isArray(current) ? current[Number(part)] : current[part];
  }
  return current;
}

export function importBindingPayloadFromMandateEntry(entry, index, mandateSha256) {
  if (!entry || typeof entry !== 'object') fail('GATE24_MANDATE_ENTRY_ABSENT', String(index));
  const expectedId = GATE24_IMPORT_IDS[index];
  if (entry.deferredCapabilityId !== expectedId) {
    fail('GATE24_DEFERRED_CAPABILITY_ID_MISMATCH', `${entry.deferredCapabilityId}!==${expectedId}`);
  }
  const trigger = typeof entry.revisitTrigger === 'string' && entry.revisitTrigger.trim()
    ? entry.revisitTrigger.trim()
    : fail('GATE24_REVISIT_TRIGGER_ABSENT', expectedId);
  return {
    bindingMode: 'REFERENCE_ONLY',
    sourceGate: entry.sourceGate,
    capabilityName: entry.capabilityName,
    capabilityClass: entry.class,
    status: entry.status,
    disposition: 'OPEN',
    reasonDeferred: Array.isArray(entry.reasonDeferred) ? [...entry.reasonDeferred] : entry.reasonDeferred,
    promotionRequirements: Array.isArray(entry.promotionRequirements) ? [...entry.promotionRequirements] : [],
    consumerCandidates: Array.isArray(entry.consumerCandidates) ? [...entry.consumerCandidates] : [],
    ownerPromotionRequired: entry.ownerPromotionRequired === true,
    currentVersion: entry.currentVersion ?? null,
    reasonVocabularyVersion: 'V1',
    eventBasedRevisitTrigger: trigger,
    sourceMandatePath: MANDATE_PATH,
    sourceMandateSha256: mandateSha256,
    sourcePointer: `/gate24DeferredCapabilities/entries/${index}`
  };
}

export function buildGate24ImportDrafts(mandate, mandateSha256) {
  const entries = pointerGet(mandate, '/gate24DeferredCapabilities/entries');
  if (!Array.isArray(entries) || entries.length !== 12) {
    fail('GATE24_MANDATE_ENTRY_COUNT_INVALID', Array.isArray(entries) ? String(entries.length) : 'ABSENT');
  }
  return entries.map((entry, index) => ({
    eventId: `STEP3_IMPORT_BINDING_${GATE24_IMPORT_IDS[index].replace(/-/g, '_')}`,
    eventType: 'IMPORT_BINDING',
    deferredCapabilityId: GATE24_IMPORT_IDS[index],
    payload: importBindingPayloadFromMandateEntry(entry, index, mandateSha256)
  }));
}

export function bindGate24DeferredCapabilities({
  root,
  gitRoot = root,
  authorityPath,
  authoritySha256,
  recordedAt,
  requiredSha256 = REQUIRED_MANDATE_SHA256,
  requiredByteLength = REQUIRED_MANDATE_BYTE_LENGTH
}) {
  const proof = proveGate24MandateHeadPersistence({
    gitRoot, workingTreeRoot: gitRoot, requiredSha256, requiredByteLength
  });
  const head = resolveCanonicalHeadBlob({ gitRoot, repoRelativePath: MANDATE_PATH });
  if (!head.present) fail('GATE24_MANDATE_NOT_RESOLVABLE_FROM_HEAD', head.reason);
  const mandate = JSON.parse(head.bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const drafts = buildGate24ImportDrafts(mandate, proof.headSha256);
  if (drafts.length !== 12) fail('GATE24_IMPORT_COUNT_INVALID', String(drafts.length));
  const appended = appendDeferredCapabilityRegistryEvents({
    root, drafts, recordedAt, authorityPath, authoritySha256
  });
  if (appended.appendedCount !== 12) fail('GATE24_IMPORT_APPEND_COUNT_INVALID', String(appended.appendedCount));
  return {
    document: BINDER_DOCUMENT,
    version: BINDER_VERSION,
    mandateProof: proof,
    importBindingCount: 12,
    deferredCapabilityIds: GATE24_IMPORT_IDS.slice(),
    appended
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${JSON.stringify({ document: BINDER_DOCUMENT, version: BINDER_VERSION }, null, 2)}\n`);
}
