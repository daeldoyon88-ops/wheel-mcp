#!/usr/bin/env node
/**
 * RECONCILE_HISTORICAL_DEFERRED_CAPABILITIES — one-time structured pass.
 *
 * Consumes ONLY the frozen closed catalog. No directory walk. No prose mining.
 * Live frozen bytes are expected to yield zero REGISTER events; any live
 * REGISTER is UNEXPECTED_HISTORICAL_RECONCILIATION_DELTA and is not appended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './canonical-json.mjs';
import { durableReplaceFileSync } from './durable-write.mjs';
import {
  REGISTRY_PATH,
  parseRegistry,
  readVocabulary,
  validateDeferredCapabilityRegistry
} from './validate-deferred-capability-registry.mjs';
import { appendDeferredCapabilityRegistryEvents } from './append-deferred-capability-registry-events.mjs';

export const RECONCILER_DOCUMENT = 'DEFERRED_CAPABILITY_HISTORICAL_RECONCILIATION';
export const RECONCILER_VERSION = 'V1';
export const EXTRACTOR_VERSION = 'DEFERRED_CAPABILITY_HISTORICAL_EXTRACTOR_V1';
export const RECONCILIATION_ID = 'DEFERRED_CAPABILITY_HISTORICAL_RECONCILIATION_R1';
export const RECEIPT_PATH = 'governance/historical-architecture/DEFERRED_CAPABILITY_HISTORICAL_RECONCILIATION_RECEIPT_R1.json';

export const SKIP = Object.freeze({
  NULL_OR_EMPTY_STRUCTURE: 'NULL_OR_EMPTY_STRUCTURE',
  GOLDEN_VECTOR_LINK_NOT_CAPABILITY: 'GOLDEN_VECTOR_LINK_NOT_CAPABILITY',
  CAPABILITY_COMMITMENT_ABSENT: 'CAPABILITY_COMMITMENT_ABSENT',
  INFRASTRUCTURE_ABSENCE_NOT_CAPABILITY: 'INFRASTRUCTURE_ABSENCE_NOT_CAPABILITY',
  MARKER_ABSENT: 'MARKER_ABSENT',
  IDENTITY_ABSENT: 'IDENTITY_ABSENT',
  REASON_DEFERRED_ABSENT: 'REASON_DEFERRED_ABSENT',
  REASON_NOT_IN_VOCABULARY_V1: 'REASON_NOT_IN_VOCABULARY_V1',
  OPTIONAL_NOT_CAPABILITY_PLANNED: 'OPTIONAL_NOT_CAPABILITY_PLANNED',
  GATE24_RESERVED_FOR_IMPORT_BINDING: 'GATE24_RESERVED_FOR_IMPORT_BINDING',
  PROSE_NOT_STRUCTURED: 'PROSE_NOT_STRUCTURED',
  DUPLICATE_SECONDARY_PROVENANCE: 'DUPLICATE_SECONDARY_PROVENANCE'
});

const MARKER_TOKENS = Object.freeze([
  'DEFERRED', 'FUTURE', 'NOT_ACTIVE', 'OPTIONAL', 'OUT_OF_SCOPE_BUT_PLANNED', 'DEFER'
]);
const MARKER_EQUIVALENT = Object.freeze({
  DEFER: 'DEFERRED',
  FUTURE_ADDITIVE_OPTION: 'FUTURE'
});

export const LIVE_FROZEN_CATALOG = Object.freeze([
  {
    sourceClass: 'CLASS_1_GATE_REGISTRY',
    sourceClassRank: 1,
    path: 'governance/GATE_REGISTRY_00_40.json',
    expectedSha256: '76d5f9ff0a21f8c1eadaf9ccd9e48c9087d12655fac6a5c9215584053652a56b',
    expectedByteLength: 114592,
    requiredPointer: '/gates',
    structuredFieldFamily: 'deferredLinks'
  },
  {
    sourceClass: 'CLASS_2_PREEXECUTION_MATRIX',
    sourceClassRank: 2,
    path: 'governance/master-matrix/GATE15_40_PREEXECUTION_CAPABILITY_MATRIX_V1.json',
    expectedSha256: 'b11d5a74c5f70a7bf255dfae956ccb97ced1c28639a36f6cca6a56a49bde01ab',
    expectedByteLength: 58602,
    requiredPointer: '/gates',
    structuredFieldFamily: 'knownBlockingGap,foreseeableIssueClass,gateLocalNormalMissing'
  },
  {
    sourceClass: 'CLASS_3_MASTER_ROADMAP',
    sourceClassRank: 3,
    path: 'governance/sources/WHEEL_JARVISE_MASTER_ROADMAP_00_40.txt',
    expectedSha256: 'c59c9f243581104e0486f075311da4163b27f778ea5ba176c8f86f3b74d6647d',
    expectedByteLength: 13982,
    requiredPointer: 'HEADING_OR_EXPLICIT_DECISION',
    structuredFieldFamily: 'structuredHeading/explicitDecision',
    format: 'text'
  },
  {
    sourceClass: 'CLASS_4_CANONICAL_MANDATE',
    sourceClassRank: 4,
    path: 'governance/sources/GATE13_CANONICAL_MANDATE_AND_EXECUTION_AUTHORITY_R1.json',
    expectedSha256: 'f67aed86fcea61dc7c49b56ec36b461b335e55973e4be1aaffaf7e3db766442e',
    expectedByteLength: 5874,
    requiredPointer: '/',
    sourceGateHint: 'GATE13'
  },
  {
    sourceClass: 'CLASS_4_CANONICAL_MANDATE',
    sourceClassRank: 4,
    path: 'governance/sources/GATE15_CANONICAL_MANDATE_R0.json',
    expectedSha256: '40d513c872348c051b888cf7e0a35a9afd22d10f487438c5bef082dfbd372f6b',
    expectedByteLength: 25844,
    requiredPointer: '/',
    sourceGateHint: 'GATE15'
  },
  {
    sourceClass: 'CLASS_4_CANONICAL_MANDATE',
    sourceClassRank: 4,
    path: 'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json',
    expectedSha256: 'bf7859ef8d0992c2ea0169af48d7762c11ee5f5a8490922588026150a92031cc',
    expectedByteLength: 67534,
    requiredPointer: '/',
    sourceGateHint: 'GATE16'
  },
  {
    sourceClass: 'CLASS_4_CANONICAL_MANDATE',
    sourceClassRank: 4,
    path: 'governance/sources/GATE21_CANONICAL_MANDATE_R0.json',
    expectedSha256: '8e261f88982a1b0892dd2cf25a765773ece72d6f47c6f35261b7e36a72c58474',
    expectedByteLength: 19268,
    requiredPointer: '/',
    sourceGateHint: 'GATE21'
  },
  {
    sourceClass: 'CLASS_4_CANONICAL_MANDATE',
    sourceClassRank: 4,
    path: 'governance/sources/GATE22_CANONICAL_MANDATE_R0.json',
    expectedSha256: '1d101e0da4a21f2561055993d17779ade6f9c5bc339fe91abaee390e10eb95bb',
    expectedByteLength: 41184,
    requiredPointer: '/',
    sourceGateHint: 'GATE22'
  },
  {
    sourceClass: 'CLASS_4_CANONICAL_MANDATE',
    sourceClassRank: 4,
    path: 'governance/sources/GATE23_CANONICAL_MANDATE_R0.json',
    expectedSha256: 'b8230ac3e76145cd68a3e9499dd227642283236cab3755d0029856dc28b0dfc9',
    expectedByteLength: 17467,
    requiredPointer: '/',
    sourceGateHint: 'GATE23'
  },
  {
    sourceClass: 'CLASS_5_CONSUMPTION_BOUNDARY',
    sourceClassRank: 5,
    path: 'governance/gates/GATE22/contracts/GATE22_CONSUMPTION_BOUNDARY_V1.json',
    expectedSha256: '3e33b498ee24139e04b654c269c3a9fb2ba9b08421b641876d69fce56e05cd60',
    expectedByteLength: 3131,
    requiredPointer: '/',
    sourceGateHint: 'GATE22'
  },
  {
    sourceClass: 'CLASS_5_CONSUMPTION_BOUNDARY',
    sourceClassRank: 5,
    path: 'governance/gates/GATE23/contracts/GATE23_CONSUMPTION_BOUNDARY_V1.json',
    expectedSha256: '1ba791f09541d50793b757d10f923730cf20a7f4e72569fc986e7a6364ba9ab2',
    expectedByteLength: 3137,
    requiredPointer: '/',
    sourceGateHint: 'GATE23'
  }
]);

function fail(code, detail = null, extra = {}) {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  error.detail = detail;
  Object.assign(error, extra);
  throw error;
}

function compareDeterministic(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareDiscoveryOrder(left, right) {
  return compareDeterministic(String(left.sourceClassRank), String(right.sourceClassRank))
    || compareDeterministic(left.sourcePath, right.sourcePath)
    || compareDeterministic(left.sourcePointer, right.sourcePointer)
    || compareDeterministic(left.capabilityName ?? '', right.capabilityName ?? '');
}

function pointerGet(value, pointer) {
  if (pointer === '/' || pointer === '') return value;
  const parts = pointer.split('/').filter(Boolean).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = value;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return { __missing: true };
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { __missing: true };
      current = current[index];
    } else {
      if (!Object.hasOwn(current, part)) return { __missing: true };
      current = current[part];
    }
  }
  return current;
}

function markerToken(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (MARKER_TOKENS.includes(trimmed)) return trimmed === 'DEFER' ? 'DEFERRED' : trimmed;
  if (MARKER_EQUIVALENT[trimmed]) return MARKER_EQUIVALENT[trimmed];
  return null;
}

function structuredMarker(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  for (const field of ['status', 'disposition', 'class', 'deferredDisposition', 'optionBDisposition', 'marker']) {
    const token = markerToken(object[field]);
    if (token) return { field, token, raw: object[field] };
  }
  if (typeof object.decision === 'string') {
    const exact = markerToken(object.decision);
    if (exact) return { field: 'decision', token: exact, raw: object.decision };
    const match = object.decision.match(/\b(DEFER|DEFERRED|FUTURE|NOT_ACTIVE|OPTIONAL|OUT_OF_SCOPE_BUT_PLANNED)\b/);
    if (match) return { field: 'decision', token: match[1] === 'DEFER' ? 'DEFERRED' : match[1], raw: object.decision };
  }
  if (Array.isArray(object.deferred) && object.deferred.length) {
    return { field: 'deferred', token: 'DEFERRED', raw: object.deferred };
  }
  return null;
}

function capabilityNameOf(object, fallback = null) {
  if (!object || typeof object !== 'object') return fallback;
  for (const field of ['capabilityName', 'canonicalName', 'registryConcept', 'subject', 'officialName', 'name', 'id']) {
    if (typeof object[field] === 'string' && object[field].trim()) return object[field].trim();
  }
  if (typeof object.decision === 'string') {
    const named = object.decision.match(/^([A-Z][A-Z0-9_]+)\s+is\s+DEFER\b/);
    if (named) return named[1];
  }
  return fallback;
}

function reasonsOf(object, vocabularyTokens) {
  const raw = object?.reasonDeferred ?? object?.reasons ?? object?.reason ?? null;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw.trim()] : [];
  return {
    present: list.length > 0,
    tokens: list,
    allInVocabulary: list.length > 0 && list.every((token) => vocabularyTokens.includes(token))
  };
}

function skipRow({
  sourceClassRank, sourceClass, sourcePath, sourcePointer, sourceGate, capabilityName, skipCode, note = null, marker = null
}) {
  return {
    sourceClassRank,
    sourceClass,
    sourcePath,
    sourcePointer,
    sourceGate: sourceGate ?? null,
    capabilityName: capabilityName ?? null,
    skipCode,
    marker,
    note
  };
}

function readCatalogEntry(root, entry) {
  const file = path.resolve(root, ...entry.path.split('/'));
  if (!fs.existsSync(file)) fail('SOURCE_POINTER_ABSENT', entry.path);
  const bytes = fs.readFileSync(file);
  const sha256 = sha256Bytes(bytes);
  if (entry.expectedSha256 && sha256 !== entry.expectedSha256) {
    fail('SOURCE_SHA_MISMATCH', `${entry.path}:actual=${sha256}:expected=${entry.expectedSha256}`);
  }
  if (Number.isInteger(entry.expectedByteLength) && bytes.length !== entry.expectedByteLength) {
    fail('SOURCE_BYTE_LENGTH_MISMATCH', `${entry.path}:actual=${bytes.length}`);
  }
  return { bytes, sha256, byteLength: bytes.length, text: bytes.toString('utf8') };
}

function extractClass1(entry, parsed, vocabularyTokens) {
  const gates = parsed?.gates;
  if (!Array.isArray(gates)) fail('SOURCE_POINTER_ABSENT', `${entry.path}#/gates`);
  const rows = [];
  gates.forEach((gate, index) => {
    const pointer = `/gates/${index}/deferredLinks`;
    const sourceGate = gate?.gateId ?? null;
    if (!Object.hasOwn(gate ?? {}, 'deferredLinks')) {
      fail('SOURCE_POINTER_ABSENT', `${entry.path}#${pointer}`);
    }
    const links = gate.deferredLinks;
    if (links == null || links === '' || (Array.isArray(links) && links.length === 0)) {
      rows.push(skipRow({
        sourceClassRank: 1, sourceClass: entry.sourceClass, sourcePath: entry.path,
        sourcePointer: pointer, sourceGate, skipCode: SKIP.NULL_OR_EMPTY_STRUCTURE
      }));
      return;
    }
    const evidence = typeof links === 'object' ? JSON.stringify(links) : String(links);
    if (/golden-vector|golden vector|testId|mutationId/i.test(evidence)) {
      rows.push(skipRow({
        sourceClassRank: 1, sourceClass: entry.sourceClass, sourcePath: entry.path,
        sourcePointer: pointer, sourceGate, skipCode: SKIP.GOLDEN_VECTOR_LINK_NOT_CAPABILITY,
        note: 'GATE04 golden-vector links are not deferred capabilities'
      }));
      return;
    }
    const marker = structuredMarker(links);
    const name = capabilityNameOf(links);
    if (!marker) {
      rows.push(skipRow({
        sourceClassRank: 1, sourceClass: entry.sourceClass, sourcePath: entry.path,
        sourcePointer: pointer, sourceGate, capabilityName: name,
        skipCode: SKIP.CAPABILITY_COMMITMENT_ABSENT
      }));
      return;
    }
    rows.push(evaluateCandidate({
      sourceClassRank: 1, sourceClass: entry.sourceClass, sourcePath: entry.path,
      sourcePointer: pointer, sourceGate, object: links, marker, vocabularyTokens
    }));
  });
  return rows;
}

function extractClass2(entry, parsed, vocabularyTokens) {
  const gates = parsed?.gates;
  if (!Array.isArray(gates)) fail('SOURCE_POINTER_ABSENT', `${entry.path}#/gates`);
  return gates.map((gate, index) => {
    const pointer = `/gates/${index}`;
    const sourceGate = gate?.gateId ?? null;
    for (const field of ['knownBlockingGap', 'foreseeableIssueClass', 'gateLocalNormalMissing']) {
      if (!Object.hasOwn(gate ?? {}, field)) fail('SOURCE_POINTER_ABSENT', `${entry.path}#${pointer}/${field}`);
    }
    const marker = structuredMarker(gate);
    const infrastructure = Array.isArray(gate.gateLocalNormalMissing)
      && gate.gateLocalNormalMissing.every((item) => typeof item === 'string');
    if ((gate.knownBlockingGap === 'NONE' || gate.foreseeableIssueClass === 'GATE_LOCAL_EXPECTED' || infrastructure)
        && !marker) {
      return skipRow({
        sourceClassRank: 2, sourceClass: entry.sourceClass, sourcePath: entry.path,
        sourcePointer: pointer, sourceGate, skipCode: SKIP.INFRASTRUCTURE_ABSENCE_NOT_CAPABILITY,
        note: `knownBlockingGap=${gate.knownBlockingGap}; foreseeableIssueClass=${gate.foreseeableIssueClass}`
      });
    }
    if (!marker) {
      return skipRow({
        sourceClassRank: 2, sourceClass: entry.sourceClass, sourcePath: entry.path,
        sourcePointer: pointer, sourceGate, skipCode: SKIP.MARKER_ABSENT
      });
    }
    return evaluateCandidate({
      sourceClassRank: 2, sourceClass: entry.sourceClass, sourcePath: entry.path,
      sourcePointer: pointer, sourceGate, object: gate, marker, vocabularyTokens
    });
  });
}

function extractClass3(entry, text, vocabularyTokens) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const headingRe = /^(=+|-+)$/;
  const namedHeadingRe = /^(SECTION\s+[A-Z]\b|GATE[0-9]{2}\b|DECISION\b|EXPLICIT\b)/;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const isHeading = headingRe.test(trimmed) || namedHeadingRe.test(trimmed)
      || (index > 0 && headingRe.test((lines[index + 1] ?? '').trim()) && trimmed === trimmed.toUpperCase());
    const isDecision = /^(DECISION|EXPLICIT[_\s-]?DECISION)\b/i.test(trimmed);
    if (!isHeading && !isDecision) return;
    const pointer = `/line/${index + 1}`;
    const gateMatch = trimmed.match(/^(GATE[0-9]{2})\b/);
    const object = { decision: trimmed, capabilityName: gateMatch ? `${gateMatch[1]} roadmap heading` : trimmed };
    const marker = structuredMarker(object);
    if (!marker) {
      rows.push(skipRow({
        sourceClassRank: 3, sourceClass: entry.sourceClass, sourcePath: entry.path,
        sourcePointer: pointer, sourceGate: gateMatch ? gateMatch[1] : null,
        capabilityName: object.capabilityName,
        skipCode: isDecision ? SKIP.MARKER_ABSENT : SKIP.PROSE_NOT_STRUCTURED
      }));
      return;
    }
    rows.push(evaluateCandidate({
      sourceClassRank: 3, sourceClass: entry.sourceClass, sourcePath: entry.path,
      sourcePointer: pointer, sourceGate: gateMatch ? gateMatch[1] : null,
      object, marker, vocabularyTokens
    }));
  });
  return rows;
}

function walkStructured(value, pointer, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStructured(item, `${pointer}/${index}`, visit));
    return;
  }
  if (value && typeof value === 'object') {
    visit(value, pointer === '' ? '/' : pointer);
    for (const [key, child] of Object.entries(value)) {
      walkStructured(child, `${pointer}/${key}`, visit);
    }
  }
}

function extractStructuredJson(entry, parsed, vocabularyTokens) {
  const rows = [];
  const required = pointerGet(parsed, entry.requiredPointer ?? '/');
  if (required && required.__missing) fail('SOURCE_POINTER_ABSENT', `${entry.path}#${entry.requiredPointer}`);
  walkStructured(parsed, '', (object, pointer) => {
    const marker = structuredMarker(object);
    if (!marker) return;
    rows.push(evaluateCandidate({
      sourceClassRank: entry.sourceClassRank,
      sourceClass: entry.sourceClass,
      sourcePath: entry.path,
      sourcePointer: pointer,
      sourceGate: object.sourceGate ?? entry.sourceGateHint ?? null,
      object,
      marker,
      vocabularyTokens
    }));
  });
  if (rows.length === 0) {
    rows.push(skipRow({
      sourceClassRank: entry.sourceClassRank, sourceClass: entry.sourceClass, sourcePath: entry.path,
      sourcePointer: entry.requiredPointer ?? '/', sourceGate: entry.sourceGateHint ?? null,
      skipCode: SKIP.MARKER_ABSENT
    }));
  }
  return rows;
}

function evaluateCandidate({
  sourceClassRank, sourceClass, sourcePath, sourcePointer, sourceGate, object, marker, vocabularyTokens
}) {
  const base = {
    sourceClassRank, sourceClass, sourcePath, sourcePointer, sourceGate, marker: marker.token
  };
  const capabilityName = capabilityNameOf(object);
  if (marker.token === 'OPTIONAL' && object.capabilityPlanned !== true) {
    return skipRow({ ...base, capabilityName, skipCode: SKIP.OPTIONAL_NOT_CAPABILITY_PLANNED });
  }
  if (!capabilityName) {
    return skipRow({ ...base, skipCode: SKIP.IDENTITY_ABSENT });
  }
  const gate = sourceGate ?? object.sourceGate ?? null;
  if (typeof gate !== 'string' || !/^GATE[0-9]{2}$/.test(gate)) {
    return skipRow({ ...base, capabilityName, skipCode: SKIP.IDENTITY_ABSENT, note: 'sourceGate missing' });
  }
  if (gate === 'GATE24') {
    return skipRow({ ...base, sourceGate: gate, capabilityName, skipCode: SKIP.GATE24_RESERVED_FOR_IMPORT_BINDING });
  }
  const reasons = reasonsOf(object, vocabularyTokens);
  if (!reasons.present) {
    return skipRow({ ...base, sourceGate: gate, capabilityName, skipCode: SKIP.REASON_DEFERRED_ABSENT });
  }
  if (!reasons.allInVocabulary) {
    return skipRow({ ...base, sourceGate: gate, capabilityName, skipCode: SKIP.REASON_NOT_IN_VOCABULARY_V1, note: reasons.tokens.join(',') });
  }
  return {
    registerable: true,
    sourceClassRank,
    sourceClass,
    sourcePath,
    sourcePointer,
    sourceGate: gate,
    capabilityName,
    marker: marker.token,
    reasonDeferred: [...reasons.tokens],
    payload: {
      sourceGate: gate,
      capabilityName,
      capabilityClass: object.capabilityClass ?? object.class ?? marker.token,
      status: object.status && ['REGISTERED', 'READY', 'ACTIVE', 'DEFERRED', 'FUTURE'].includes(object.status)
        ? object.status
        : (marker.token === 'FUTURE' ? 'FUTURE' : 'DEFERRED'),
      disposition: 'OPEN',
      reasonDeferred: [...reasons.tokens],
      reasonVocabularyVersion: 'V1',
      promotionRequirements: Array.isArray(object.promotionRequirements) ? [...object.promotionRequirements] : [],
      consumerCandidates: Array.isArray(object.consumerCandidates) ? [...object.consumerCandidates] : [],
      ownerPromotionRequired: object.ownerPromotionRequired === true,
      currentVersion: object.currentVersion ?? null,
      eventBasedRevisitTrigger: object.eventBasedRevisitTrigger
        ?? object.revisitTrigger
        ?? `historical reconciliation of ${capabilityName}`,
      sourcePath,
      sourcePointer
    }
  };
}

export function extractHistoricalDiscoveries({ root, catalog = LIVE_FROZEN_CATALOG, vocabularyTokens }) {
  const frozenCatalog = [];
  const discoveries = [];
  for (const entry of catalog) {
    const read = readCatalogEntry(root, entry);
    frozenCatalog.push({
      sourceClass: entry.sourceClass,
      sourceClassRank: entry.sourceClassRank,
      path: entry.path,
      sha256: read.sha256,
      byteLength: read.byteLength,
      expectedSha256: entry.expectedSha256 ?? read.sha256,
      expectedByteLength: entry.expectedByteLength ?? read.byteLength
    });
    if (entry.format === 'text') {
      discoveries.push(...extractClass3(entry, read.text, vocabularyTokens));
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(read.text.replace(/^\uFEFF/, ''));
    } catch {
      fail('SOURCE_POINTER_ABSENT', `${entry.path}:UNPARSABLE`);
    }
    if (entry.sourceClassRank === 1) discoveries.push(...extractClass1(entry, parsed, vocabularyTokens));
    else if (entry.sourceClassRank === 2) discoveries.push(...extractClass2(entry, parsed, vocabularyTokens));
    else discoveries.push(...extractStructuredJson(entry, parsed, vocabularyTokens));
  }
  return { frozenCatalog, discoveries };
}

export function assignHistoricalIdentities(discoveries) {
  const skipped = [];
  const registerable = [];
  for (const row of discoveries) {
    if (row.registerable === true) registerable.push(row);
    else skipped.push(row);
  }
  registerable.sort(compareDiscoveryOrder);
  const unique = [];
  const duplicateDiscoveries = [];
  const seen = new Map();
  for (const row of registerable) {
    const key = `${row.sourceGate}::${row.capabilityName}`;
    if (seen.has(key)) {
      duplicateDiscoveries.push({
        ...row,
        primarySourceClassRank: seen.get(key).sourceClassRank,
        skipCode: SKIP.DUPLICATE_SECONDARY_PROVENANCE
      });
      continue;
    }
    seen.set(key, row);
    unique.push(row);
  }
  unique.sort(compareDiscoveryOrder);
  const counters = new Map();
  for (const row of unique) {
    const next = (counters.get(row.sourceGate) ?? 0) + 1;
    counters.set(row.sourceGate, next);
    row.deferredCapabilityId = `${row.sourceGate}-DC-${String(next).padStart(2, '0')}`;
    if (row.deferredCapabilityId.startsWith('GATE24-DC-')) {
      fail('GATE24_RESERVED_FOR_IMPORT_BINDING', row.deferredCapabilityId);
    }
  }
  return { unique, skipped, duplicateDiscoveries };
}

function readReceipt(root, receiptPath) {
  const file = path.resolve(root, ...receiptPath.split('/'));
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function catalogFingerprint(frozenCatalog) {
  return frozenCatalog.map((entry) => `${entry.path}:${entry.sha256}:${entry.byteLength}`).join('|');
}

export function reconcileHistoricalDeferredCapabilities({
  root,
  catalog = LIVE_FROZEN_CATALOG,
  authorityPath,
  authoritySha256,
  recordedAt,
  receiptPath = RECEIPT_PATH,
  enforceExpectedZero = catalog === LIVE_FROZEN_CATALOG,
  writeReceipt = true
}) {
  const vocabulary = readVocabulary(root);
  const before = validateDeferredCapabilityRegistry({ root });
  if (before.verdict !== 'VALID') fail('REGISTRY_INVALID_BEFORE_RECONCILIATION', null, { findings: before.findings });

  const { frozenCatalog, discoveries } = extractHistoricalDiscoveries({
    root, catalog, vocabularyTokens: vocabulary.tokens
  });
  const existingReceipt = readReceipt(root, receiptPath);
  if (existingReceipt?.completionState === 'COMPLETE'
      && existingReceipt.catalogFingerprint === catalogFingerprint(frozenCatalog)) {
    const registryBytes = fs.readFileSync(path.resolve(root, ...REGISTRY_PATH.split('/')));
    return {
      document: RECONCILER_DOCUMENT,
      version: RECONCILER_VERSION,
      reconciliationId: RECONCILIATION_ID,
      idempotent: true,
      historicalRegisterCount: 0,
      appendedCount: 0,
      discoveredCount: existingReceipt.discoveredCount,
      skipped: existingReceipt.discoveredNotRegisterable,
      duplicateDiscoveries: existingReceipt.duplicateDiscoveries,
      registerIds: existingReceipt.registerIds,
      receipt: existingReceipt,
      registrySha256: sha256Bytes(registryBytes),
      byteLength: registryBytes.length
    };
  }
  if (existingReceipt?.completionState === 'COMPLETE'
      && existingReceipt.catalogFingerprint
      && existingReceipt.catalogFingerprint !== catalogFingerprint(frozenCatalog)) {
    fail('CATALOG_BYTES_CHANGED_NEW_OWNER_AUTHORITY_REQUIRED', receiptPath);
  }

  const { unique, skipped, duplicateDiscoveries } = assignHistoricalIdentities(discoveries);
  if (enforceExpectedZero && unique.length > 0) {
    const first = unique[0];
    fail('UNEXPECTED_HISTORICAL_RECONCILIATION_DELTA', null, {
      sourceGate: first.sourceGate,
      sourcePath: first.sourcePath,
      sourcePointer: first.sourcePointer,
      capabilityName: first.capabilityName,
      reasonDeferred: first.reasonDeferred,
      delta: unique.map((row) => ({
        sourceGate: row.sourceGate,
        sourcePath: row.sourcePath,
        sourcePointer: row.sourcePointer,
        capabilityName: row.capabilityName,
        reasonDeferred: row.reasonDeferred
      }))
    });
  }

  const drafts = unique.map((row) => ({
    eventId: `STEP3_HISTORICAL_REGISTER_${row.deferredCapabilityId.replace(/-/g, '_')}`,
    eventType: 'REGISTER',
    deferredCapabilityId: row.deferredCapabilityId,
    payload: row.payload
  }));

  const appended = appendDeferredCapabilityRegistryEvents({
    root,
    drafts,
    recordedAt,
    authorityPath,
    authoritySha256
  });

  const registryBytes = fs.readFileSync(path.resolve(root, ...REGISTRY_PATH.split('/')));
  const receipt = {
    document: RECONCILER_DOCUMENT,
    schemaVersion: 1,
    reconciliationId: RECONCILIATION_ID,
    reconciliationVersion: RECONCILER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    frozenCatalog,
    catalogFingerprint: catalogFingerprint(frozenCatalog),
    registerIds: unique.map((row) => row.deferredCapabilityId),
    historicalRegisterCount: unique.length,
    discoveredCount: discoveries.length,
    discoveredNotRegisterable: skipped.sort(compareDiscoveryOrder),
    duplicateDiscoveries,
    skipCodes: [...new Set(skipped.map((row) => row.skipCode))].sort(),
    resultingRegistrySha256: sha256Bytes(registryBytes),
    resultingRegistryByteLength: registryBytes.length,
    resultingEventCount: parseRegistry(registryBytes.toString('utf8')).length,
    completionState: 'COMPLETE',
    idempotentReplay: {
      identicalCatalogBytes: 'ZERO_NEW_EVENTS',
      catalogByteChange: 'NEW_OWNER_AUTHORITY_REQUIRED'
    }
  };
  if (writeReceipt) {
    durableReplaceFileSync(
      path.resolve(root, ...receiptPath.split('/')),
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    );
  }
  return {
    document: RECONCILER_DOCUMENT,
    version: RECONCILER_VERSION,
    reconciliationId: RECONCILIATION_ID,
    idempotent: false,
    historicalRegisterCount: unique.length,
    appendedCount: appended.appendedCount,
    discoveredCount: discoveries.length,
    skipped,
    duplicateDiscoveries,
    registerIds: unique.map((row) => row.deferredCapabilityId),
    receipt,
    registrySha256: appended.registrySha256,
    byteLength: appended.byteLength
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
  };
  const root = path.resolve(option('--root') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  try {
    const report = reconcileHistoricalDeferredCapabilities({
      root,
      authorityPath: option('--authority-path'),
      authoritySha256: option('--authority-sha256'),
      recordedAt: option('--recorded-at')
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      document: RECONCILER_DOCUMENT,
      verdict: error.code ?? 'FAILED',
      detail: error.detail ?? error.message,
      sourceGate: error.sourceGate ?? null,
      sourcePath: error.sourcePath ?? null,
      sourcePointer: error.sourcePointer ?? null,
      capabilityName: error.capabilityName ?? null,
      reasonDeferred: error.reasonDeferred ?? null
    }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
