/**
 * STEP3-A historical reconciliation — hostile battery S3-H01..H09, H14..H17, H19.
 *
 * Isolated fixtures only. The live canonical registry is never mutated here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  computeEventPayloadSha256,
  parseRegistry,
  REGISTRY_PATH,
  VOCABULARY_PATH,
  validateDeferredCapabilityRegistry
} from '../tools/validate-deferred-capability-registry.mjs';
import { generateDeferredCapabilityIndex } from '../tools/generate-deferred-capability-index.mjs';
import { appendDeferredCapabilityRegistryEvents } from '../tools/append-deferred-capability-registry-events.mjs';
import {
  LIVE_FROZEN_CATALOG,
  RECEIPT_PATH,
  SKIP,
  reconcileHistoricalDeferredCapabilities
} from '../tools/reconcile-historical-deferred-capabilities.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const LIVE_LEDGER_SHA = '2d2707462ef4e518abb5153376c1145c39a97981486066eea62edae043f54a57';

function resolveCanonicalRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(dir, 'governance', 'PROJECT_CONSTITUTION.json'))
        && fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('CANONICAL_ROOT_UNRESOLVED');
    dir = parent;
  }
}

const REPO_ROOT = resolveCanonicalRoot();
const AUTHORITY_REL = 'governance/sources/TEST_STEP3_HISTORICAL_AUTHORITY.json';
const RECORDED_AT = '2026-08-26T15:00:00.000Z';

function writeJson(root, relative, value) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function makeScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3h-hist-'));
  for (const dir of ['master-matrix', 'sources', 'generated', 'historical-architecture', 'state']) {
    fs.mkdirSync(path.join(root, 'governance', dir), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO_ROOT, ...VOCABULARY_PATH.split('/')), path.join(root, ...VOCABULARY_PATH.split('/')));
  writeJson(root, AUTHORITY_REL, { document: 'TEST_STEP3_HISTORICAL_AUTHORITY' });
  fs.writeFileSync(path.join(root, ...REGISTRY_PATH.split('/')), Buffer.alloc(0));
  fs.copyFileSync(path.join(REPO_ROOT, ...LEDGER_PATH.split('/')), path.join(root, ...LEDGER_PATH.split('/')));
  return root;
}

function authorityPin(root) {
  const bytes = fs.readFileSync(path.join(root, ...AUTHORITY_REL.split('/')));
  return { authorityPath: AUTHORITY_REL, authoritySha256: sha256(bytes), recordedAt: RECORDED_AT };
}

function writeCatalogFile(root, relative, value) {
  const bytes = Buffer.isBuffer(value) || typeof value === 'string'
    ? Buffer.from(value)
    : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { path: relative, sha256: sha256(bytes), byteLength: bytes.length, bytes };
}

function registerableCatalog(root, { marker = 'DEFERRED', capabilityPlanned, extra = {} } = {}) {
  const relative = 'governance/sources/FIXTURE_HISTORICAL_MANDATE.json';
  const body = {
    sourceGate: 'GATE21',
    capabilityName: extra.capabilityName ?? 'fixture historical capability',
    status: marker,
    reasonDeferred: extra.reasonDeferred ?? ['TAXONOMY_INTENTIONALLY_DEFERRED'],
    capabilityPlanned,
    ...extra.fields
  };
  const written = writeCatalogFile(root, relative, body);
  return [{
    sourceClass: 'CLASS_4_CANONICAL_MANDATE',
    sourceClassRank: 4,
    path: relative,
    expectedSha256: written.sha256,
    expectedByteLength: written.byteLength,
    requiredPointer: '/',
    sourceGateHint: 'GATE21'
  }];
}

function dualClassSameCapability(root) {
  const class1Path = 'governance/GATE_REGISTRY_00_40.json';
  const class2Path = 'governance/master-matrix/GATE15_40_PREEXECUTION_CAPABILITY_MATRIX_V1.json';
  const capability = {
    gateId: 'GATE21',
    capabilityName: 'shared dual-class capability',
    status: 'DEFERRED',
    reasonDeferred: ['NOT_REQUIRED_BY_CORE_V1'],
    deferredLinks: {
      capabilityName: 'shared dual-class capability',
      status: 'DEFERRED',
      reasonDeferred: ['NOT_REQUIRED_BY_CORE_V1'],
      sourceGate: 'GATE21'
    },
    knownBlockingGap: 'CAPABILITY',
    foreseeableIssueClass: 'DEFERRED',
    gateLocalNormalMissing: []
  };
  const c1 = writeCatalogFile(root, class1Path, { gates: [capability] });
  const c2 = writeCatalogFile(root, class2Path, { gates: [capability] });
  return [
    {
      sourceClass: 'CLASS_1_GATE_REGISTRY', sourceClassRank: 1, path: class1Path,
      expectedSha256: c1.sha256, expectedByteLength: c1.byteLength, requiredPointer: '/gates'
    },
    {
      sourceClass: 'CLASS_2_PREEXECUTION_MATRIX', sourceClassRank: 2, path: class2Path,
      expectedSha256: c2.sha256, expectedByteLength: c2.byteLength, requiredPointer: '/gates'
    }
  ];
}

test('S3-H01 same reconciliation twice yields zero events on the second run', () => {
  const root = makeScratch();
  const catalog = registerableCatalog(root);
  const pin = authorityPin(root);
  const first = reconcileHistoricalDeferredCapabilities({ root, catalog, ...pin, enforceExpectedZero: false });
  assert.equal(first.historicalRegisterCount, 1);
  assert.equal(first.appendedCount, 1);
  const afterFirst = fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')));
  const second = reconcileHistoricalDeferredCapabilities({ root, catalog, ...pin, enforceExpectedZero: false });
  assert.equal(second.historicalRegisterCount, 0);
  assert.equal(second.appendedCount, 0);
  assert.equal(second.idempotent, true);
  assert.equal(sha256(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')))), sha256(afterFirst));
});

test('S3-H02 the same commitment through two allowed source classes receives one identity', () => {
  const root = makeScratch();
  const catalog = dualClassSameCapability(root);
  const pin = authorityPin(root);
  const result = reconcileHistoricalDeferredCapabilities({ root, catalog, ...pin, enforceExpectedZero: false });
  assert.equal(result.historicalRegisterCount, 1);
  assert.equal(result.registerIds[0], 'GATE21-DC-01');
  assert.equal(result.duplicateDiscoveries.length, 1);
  assert.equal(result.duplicateDiscoveries[0].skipCode, SKIP.DUPLICATE_SECONDARY_PROVENANCE);
  const events = parseRegistry(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8'));
  assert.equal(events.length, 1);
});

test('S3-H03 vague prose does not REGISTER', () => {
  const root = makeScratch();
  const relative = 'governance/sources/WHEEL_JARVISE_MASTER_ROADMAP_00_40.txt';
  const prose = 'SECTION G\nGATE21 - MARKET DATA CAUSAL FOUNDATION\nmaybe later we could add optional intelligence.\n';
  const written = writeCatalogFile(root, relative, prose);
  const catalog = [{
    sourceClass: 'CLASS_3_MASTER_ROADMAP', sourceClassRank: 3, path: relative,
    expectedSha256: written.sha256, expectedByteLength: written.byteLength,
    requiredPointer: 'HEADING_OR_EXPLICIT_DECISION', format: 'text'
  }];
  const result = reconcileHistoricalDeferredCapabilities({
    root, catalog, ...authorityPin(root), enforceExpectedZero: false
  });
  assert.equal(result.historicalRegisterCount, 0);
  assert.ok(result.skipped.some((row) => row.skipCode === SKIP.PROSE_NOT_STRUCTURED || row.skipCode === SKIP.MARKER_ABSENT));
});

test('S3-H04 structured DEFER with a valid V1 reason REGISTERs', () => {
  const root = makeScratch();
  const result = reconcileHistoricalDeferredCapabilities({
    root, catalog: registerableCatalog(root, { marker: 'DEFERRED' }), ...authorityPin(root), enforceExpectedZero: false
  });
  assert.equal(result.historicalRegisterCount, 1);
  assert.equal(result.registerIds[0], 'GATE21-DC-01');
  const events = parseRegistry(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8'));
  assert.equal(events[0].eventType, 'REGISTER');
  assert.deepEqual(events[0].payload.reasonDeferred, ['TAXONOMY_INTENTIONALLY_DEFERRED']);
});

test('S3-H05 structured FUTURE with a valid V1 reason REGISTERs', () => {
  const root = makeScratch();
  const result = reconcileHistoricalDeferredCapabilities({
    root, catalog: registerableCatalog(root, { marker: 'FUTURE' }), ...authorityPin(root), enforceExpectedZero: false
  });
  assert.equal(result.historicalRegisterCount, 1);
  const events = parseRegistry(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8'));
  assert.equal(events[0].payload.status, 'FUTURE');
});

test('S3-H06 OPTIONAL registers only when explicitly capability-planned', () => {
  const unplanned = makeScratch();
  const unplannedResult = reconcileHistoricalDeferredCapabilities({
    root: unplanned,
    catalog: registerableCatalog(unplanned, { marker: 'OPTIONAL' }),
    ...authorityPin(unplanned),
    enforceExpectedZero: false
  });
  assert.equal(unplannedResult.historicalRegisterCount, 0);
  assert.ok(unplannedResult.skipped.some((row) => row.skipCode === SKIP.OPTIONAL_NOT_CAPABILITY_PLANNED));

  const planned = makeScratch();
  const plannedResult = reconcileHistoricalDeferredCapabilities({
    root: planned,
    catalog: registerableCatalog(planned, { marker: 'OPTIONAL', capabilityPlanned: true }),
    ...authorityPin(planned),
    enforceExpectedZero: false
  });
  assert.equal(plannedResult.historicalRegisterCount, 1);
});

test('S3-H07 shuffled source traversal yields identical IDs and event order', () => {
  const rootA = makeScratch();
  const rootB = makeScratch();
  const ordered = dualClassSameCapability(rootA);
  const shuffled = dualClassSameCapability(rootB).slice().reverse();
  const a = reconcileHistoricalDeferredCapabilities({
    root: rootA, catalog: ordered, ...authorityPin(rootA), enforceExpectedZero: false
  });
  const b = reconcileHistoricalDeferredCapabilities({
    root: rootB, catalog: shuffled, ...authorityPin(rootB), enforceExpectedZero: false
  });
  assert.deepEqual(a.registerIds, b.registerIds);
  const eventsA = parseRegistry(fs.readFileSync(path.join(rootA, ...REGISTRY_PATH.split('/')), 'utf8'));
  const eventsB = parseRegistry(fs.readFileSync(path.join(rootB, ...REGISTRY_PATH.split('/')), 'utf8'));
  assert.deepEqual(eventsA.map((event) => event.deferredCapabilityId), eventsB.map((event) => event.deferredCapabilityId));
});

test('S3-H08 a source SHA mismatch is rejected', () => {
  const root = makeScratch();
  const catalog = registerableCatalog(root);
  catalog[0].expectedSha256 = '0'.repeat(64);
  assert.throws(
    () => reconcileHistoricalDeferredCapabilities({
      root, catalog, ...authorityPin(root), enforceExpectedZero: false
    }),
    (error) => error.code === 'SOURCE_SHA_MISMATCH'
  );
  assert.equal(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/'))).length, 0);
});

test('S3-H09 a required source pointer that is absent or malformed is rejected', () => {
  const root = makeScratch();
  const relative = 'governance/GATE_REGISTRY_00_40.json';
  const written = writeCatalogFile(root, relative, { notGates: [] });
  const catalog = [{
    sourceClass: 'CLASS_1_GATE_REGISTRY', sourceClassRank: 1, path: relative,
    expectedSha256: written.sha256, expectedByteLength: written.byteLength, requiredPointer: '/gates'
  }];
  assert.throws(
    () => reconcileHistoricalDeferredCapabilities({
      root, catalog, ...authorityPin(root), enforceExpectedZero: false
    }),
    (error) => error.code === 'SOURCE_POINTER_ABSENT'
  );
});

test('S3-H14 a duplicate registry identity is rejected', () => {
  const root = makeScratch();
  const pin = authorityPin(root);
  const draft = {
    eventId: 'STEP3_DUP_A',
    eventType: 'REGISTER',
    deferredCapabilityId: 'GATE21-DC-01',
    payload: {
      sourceGate: 'GATE21',
      capabilityName: 'dup',
      status: 'DEFERRED',
      disposition: 'OPEN',
      reasonDeferred: ['TAXONOMY_INTENTIONALLY_DEFERRED'],
      reasonVocabularyVersion: 'V1',
      promotionRequirements: [],
      consumerCandidates: [],
      ownerPromotionRequired: false,
      currentVersion: null,
      eventBasedRevisitTrigger: 'fixture'
    }
  };
  appendDeferredCapabilityRegistryEvents({ root, drafts: [draft], ...pin });
  assert.throws(
    () => appendDeferredCapabilityRegistryEvents({
      root,
      drafts: [{ ...draft, eventId: 'STEP3_DUP_B' }],
      ...pin
    }),
    (error) => error.code === 'REGISTRY_INVALID_AFTER_APPEND'
      && error.findings.some((finding) => finding.code === 'DUPLICATE_DEFERRED_CAPABILITY_IDENTITY')
  );
  const events = parseRegistry(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8'));
  assert.equal(events.length, 1);
});

test('S3-H15 a tampered registry chain is rejected', () => {
  const root = makeScratch();
  const pin = authorityPin(root);
  appendDeferredCapabilityRegistryEvents({
    root,
    drafts: [{
      eventId: 'STEP3_CHAIN_A',
      eventType: 'REGISTER',
      deferredCapabilityId: 'GATE21-DC-01',
      payload: {
        sourceGate: 'GATE21',
        capabilityName: 'chain',
        status: 'DEFERRED',
        disposition: 'OPEN',
        reasonDeferred: ['TAXONOMY_INTENTIONALLY_DEFERRED'],
        reasonVocabularyVersion: 'V1',
        promotionRequirements: [],
        consumerCandidates: [],
        ownerPromotionRequired: false,
        currentVersion: null,
        eventBasedRevisitTrigger: 'fixture'
      }
    }],
    ...pin
  });
  const file = path.join(root, ...REGISTRY_PATH.split('/'));
  const event = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  event.previousEventSha256 = 'a'.repeat(64);
  fs.writeFileSync(file, `${JSON.stringify(event)}\n`);
  const report = validateDeferredCapabilityRegistry({ root });
  assert.equal(report.verdict, 'BLOCKED');
  assert.ok(report.findings.some((finding) => finding.code === 'REGISTRY_CHAIN_BROKEN'));
});

test('S3-H16 a valid completion receipt prevents rediscovery', () => {
  const root = makeScratch();
  const catalog = registerableCatalog(root);
  const pin = authorityPin(root);
  const first = reconcileHistoricalDeferredCapabilities({ root, catalog, ...pin, enforceExpectedZero: false });
  assert.equal(first.receipt.completionState, 'COMPLETE');
  const receiptBefore = fs.readFileSync(path.join(root, ...RECEIPT_PATH.split('/')));
  const second = reconcileHistoricalDeferredCapabilities({ root, catalog, ...pin, enforceExpectedZero: false });
  assert.equal(second.idempotent, true);
  assert.equal(second.historicalRegisterCount, 0);
  assert.equal(sha256(fs.readFileSync(path.join(root, ...RECEIPT_PATH.split('/')))), sha256(receiptBefore));
});

test('S3-H17 generated index bytes are deterministic', () => {
  const root = makeScratch();
  reconcileHistoricalDeferredCapabilities({
    root, catalog: registerableCatalog(root), ...authorityPin(root), enforceExpectedZero: false
  });
  const first = generateDeferredCapabilityIndex({ root, now: new Date(RECORDED_AT) });
  const second = generateDeferredCapabilityIndex({ root, now: new Date(RECORDED_AT) });
  assert.equal(sha256(first.indexBytes), sha256(second.indexBytes));
  assert.equal(first.index.entryCount, 1);
});

test('S3-H19 the gate status ledger is unchanged by historical reconciliation', () => {
  const root = makeScratch();
  const before = fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')));
  reconcileHistoricalDeferredCapabilities({
    root, catalog: registerableCatalog(root), ...authorityPin(root), enforceExpectedZero: false
  });
  const after = fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')));
  assert.equal(sha256(after), sha256(before));
  const live = fs.readFileSync(path.join(REPO_ROOT, ...LEDGER_PATH.split('/')));
  assert.equal(sha256(live), LIVE_LEDGER_SHA);
  assert.equal(live.toString('utf8').split(/\r?\n/).filter((line) => line.trim()).length, 99);
});

test('live frozen catalog SHA pins remain the published CLASS 1-3 bytes', () => {
  for (const entry of LIVE_FROZEN_CATALOG.filter((item) => item.expectedSha256)) {
    const bytes = fs.readFileSync(path.join(REPO_ROOT, ...entry.path.split('/')));
    assert.equal(sha256(bytes), entry.expectedSha256, entry.path);
    assert.equal(bytes.length, entry.expectedByteLength, entry.path);
  }
});
