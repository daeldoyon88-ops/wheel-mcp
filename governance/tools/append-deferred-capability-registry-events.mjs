#!/usr/bin/env node
/**
 * APPEND_DEFERRED_CAPABILITY_REGISTRY_EVENTS — the only sanctioned writer.
 *
 * Whole-file replacement of (old valid bytes + deterministic appended lines).
 * Never truncate-write. Never hand-edit NDJSON. recordedAt is supplied by the
 * caller (the STEP3 authority createdAt); this module never reads the clock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './canonical-json.mjs';
import { durableReplaceFileSync } from './durable-write.mjs';
import {
  REGISTRY_PATH,
  computeEventPayloadSha256,
  parseRegistry,
  readVocabulary,
  replayRegistry,
  validateDeferredCapabilityRegistry
} from './validate-deferred-capability-registry.mjs';

export const APPENDER_DOCUMENT = 'APPEND_DEFERRED_CAPABILITY_REGISTRY_EVENTS';
export const APPENDER_VERSION = 'V1';

function fail(code, detail = null, extra = {}) {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  error.detail = detail;
  error.findings = extra.findings ?? [{ code, detail }];
  throw error;
}

export function serializeRegistryEvents(events) {
  if (!events.length) return Buffer.alloc(0);
  return Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

export function combineRegistryBytes(oldBytes, appendedEvents) {
  const suffix = serializeRegistryEvents(appendedEvents);
  if (!appendedEvents.length) return Buffer.from(oldBytes);
  if (!oldBytes.length) return suffix;
  if (oldBytes[oldBytes.length - 1] === 0x0a) return Buffer.concat([oldBytes, suffix]);
  return Buffer.concat([oldBytes, Buffer.from('\n'), suffix]);
}

/**
 * Fill chain, ordinal, recordedAt, authority and payload digest.
 * Drafts supply eventId, eventType, deferredCapabilityId and payload.
 */
export function materializeRegistryEvents({
  drafts,
  previousEventSha256 = null,
  startingOrdinal = 1,
  recordedAt,
  authorityPath,
  authoritySha256
}) {
  const events = [];
  let previous = previousEventSha256 ?? null;
  drafts.forEach((draft, index) => {
    const ordinal = startingOrdinal + index;
    const base = {
      schemaVersion: 1,
      eventId: draft.eventId,
      ordinal,
      recordedAt,
      eventType: draft.eventType,
      deferredCapabilityId: draft.deferredCapabilityId,
      authorityPath,
      authoritySha256,
      payload: draft.payload
    };
    const event = {
      ...base,
      previousEventSha256: previous,
      eventPayloadSha256: computeEventPayloadSha256(base)
    };
    previous = event.eventPayloadSha256;
    events.push(event);
  });
  return events;
}

export function appendDeferredCapabilityRegistryEvents({
  root,
  drafts,
  recordedAt,
  authorityPath,
  authoritySha256,
  registryRelativePath = REGISTRY_PATH
}) {
  if (!Array.isArray(drafts)) fail('APPEND_DRAFTS_INVALID');
  if (typeof recordedAt !== 'string' || !recordedAt) fail('APPEND_RECORDED_AT_REQUIRED');
  if (typeof authorityPath !== 'string' || !authorityPath) fail('APPEND_AUTHORITY_PATH_REQUIRED');
  if (typeof authoritySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(authoritySha256)) {
    fail('APPEND_AUTHORITY_SHA_INVALID');
  }

  const registryFile = path.resolve(root, ...registryRelativePath.split('/'));
  if (!fs.existsSync(registryFile)) fail('REGISTRY_ABSENT', registryRelativePath);

  const before = validateDeferredCapabilityRegistry({ root });
  if (before.verdict !== 'VALID') fail('REGISTRY_INVALID_BEFORE_APPEND', null, { findings: before.findings });

  const oldBytes = fs.readFileSync(registryFile);
  const existing = parseRegistry(oldBytes.toString('utf8'));
  const previousEventSha256 = existing.length === 0
    ? null
    : existing[existing.length - 1].eventPayloadSha256 ?? null;

  const appended = materializeRegistryEvents({
    drafts,
    previousEventSha256,
    startingOrdinal: existing.length + 1,
    recordedAt,
    authorityPath,
    authoritySha256
  });

  if (appended.length === 0) {
    return {
      document: APPENDER_DOCUMENT,
      version: APPENDER_VERSION,
      appendedCount: 0,
      eventCount: existing.length,
      registrySha256: sha256Bytes(oldBytes),
      byteLength: oldBytes.length,
      events: []
    };
  }

  const candidateBytes = combineRegistryBytes(oldBytes, appended);
  durableReplaceFileSync(registryFile, candidateBytes);

  const after = validateDeferredCapabilityRegistry({ root });
  if (after.verdict !== 'VALID') {
    durableReplaceFileSync(registryFile, oldBytes);
    fail('REGISTRY_INVALID_AFTER_APPEND', null, { findings: after.findings });
  }

  const vocabulary = readVocabulary(root);
  const replay = replayRegistry({
    events: parseRegistry(candidateBytes.toString('utf8')),
    vocabulary,
    root
  });
  if (!replay.valid) {
    durableReplaceFileSync(registryFile, oldBytes);
    fail('REGISTRY_REPLAY_INVALID_AFTER_APPEND', null, { findings: replay.findings });
  }

  return {
    document: APPENDER_DOCUMENT,
    version: APPENDER_VERSION,
    appendedCount: appended.length,
    eventCount: after.eventCount,
    registrySha256: sha256Bytes(candidateBytes),
    byteLength: candidateBytes.length,
    events: appended
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.stdout.write(`${JSON.stringify({ document: APPENDER_DOCUMENT, version: APPENDER_VERSION, note: 'library — invoke appendDeferredCapabilityRegistryEvents' }, null, 2)}\n`);
}
