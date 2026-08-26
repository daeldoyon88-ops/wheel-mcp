/**
 * STEP3-B GATE24 IMPORT_BINDING — hostile battery S3-H10..H13, H18, H20.
 *
 * Isolated fixtures only. The live canonical registry is never mutated here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseRegistry, REGISTRY_PATH, VOCABULARY_PATH } from '../tools/validate-deferred-capability-registry.mjs';
import { generateDeferredCapabilityIndex, INDEX_PATH } from '../tools/generate-deferred-capability-index.mjs';
import {
  GATE24_IMPORT_IDS,
  MANDATE_PATH,
  REQUIRED_MANDATE_BYTE_LENGTH,
  REQUIRED_MANDATE_SHA256,
  bindGate24DeferredCapabilities,
  proveGate24MandateHeadPersistence
} from '../tools/bind-gate24-deferred-capabilities.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const ACTIVE_GATE_PATH = 'governance/active/ACTIVE_GATE.json';
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
const AUTHORITY_REL = 'governance/sources/TEST_STEP3_GATE24_BIND_AUTHORITY.json';
const RECORDED_AT = '2026-08-26T15:00:00.000Z';

function writeJson(root, relative, value) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeGitWithMandate(mandateBytes) {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's3h-git-'));
  git(gitRoot, ['-c', 'init.defaultBranch=main', 'init']);
  git(gitRoot, ['config', 'user.email', 'step3@local']);
  git(gitRoot, ['config', 'user.name', 'STEP3']);
  git(gitRoot, ['config', 'core.autocrlf', 'false']);
  git(gitRoot, ['config', 'core.eol', 'lf']);
  const mandateFile = path.join(gitRoot, ...MANDATE_PATH.split('/'));
  fs.mkdirSync(path.dirname(mandateFile), { recursive: true });
  fs.writeFileSync(mandateFile, mandateBytes);
  git(gitRoot, ['add', '--', MANDATE_PATH]);
  git(gitRoot, ['-c', 'core.autocrlf=false', 'commit', '-m', 'mandate']);
  return gitRoot;
}

function makeScratch(gitRoot = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3h-bind-'));
  for (const dir of ['master-matrix', 'sources', 'generated', 'state', 'active', 'gates/GATE24/state']) {
    fs.mkdirSync(path.join(root, 'governance', dir), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO_ROOT, ...VOCABULARY_PATH.split('/')), path.join(root, ...VOCABULARY_PATH.split('/')));
  writeJson(root, AUTHORITY_REL, { document: 'TEST_STEP3_GATE24_BIND_AUTHORITY' });
  fs.writeFileSync(path.join(root, ...REGISTRY_PATH.split('/')), Buffer.alloc(0));
  fs.copyFileSync(path.join(REPO_ROOT, ...LEDGER_PATH.split('/')), path.join(root, ...LEDGER_PATH.split('/')));
  fs.copyFileSync(path.join(REPO_ROOT, ...ACTIVE_GATE_PATH.split('/')), path.join(root, ...ACTIVE_GATE_PATH.split('/')));
  if (gitRoot) {
    fs.copyFileSync(path.join(gitRoot, ...MANDATE_PATH.split('/')), path.join(root, ...MANDATE_PATH.split('/')));
  }
  return root;
}

function pin(root) {
  const bytes = fs.readFileSync(path.join(root, ...AUTHORITY_REL.split('/')));
  return { authorityPath: AUTHORITY_REL, authoritySha256: sha256(bytes), recordedAt: RECORDED_AT };
}

const liveMandate = execFileSync('git', ['cat-file', 'blob', `HEAD:${MANDATE_PATH}`], {
  cwd: REPO_ROOT, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
});

test('S3-H10 IMPORT_BINDING preserves GATE24-DC-01 through GATE24-DC-12 in mandate order', () => {
  const gitRoot = makeGitWithMandate(liveMandate);
  const root = makeScratch(gitRoot);
  const result = bindGate24DeferredCapabilities({ root, gitRoot, ...pin(root) });
  assert.equal(result.importBindingCount, 12);
  assert.deepEqual(result.deferredCapabilityIds, [...GATE24_IMPORT_IDS]);
  const events = parseRegistry(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8'));
  assert.equal(events.length, 12);
  events.forEach((event, index) => {
    assert.equal(event.ordinal, index + 1);
    assert.equal(event.eventType, 'IMPORT_BINDING');
    assert.equal(event.deferredCapabilityId, GATE24_IMPORT_IDS[index]);
    assert.equal(event.payload.bindingMode, 'REFERENCE_ONLY');
    assert.equal(event.payload.sourcePointer, `/gate24DeferredCapabilities/entries/${index}`);
  });
});

test('S3-H11 reason, status and OPEN disposition are preserved from the mandate', () => {
  const gitRoot = makeGitWithMandate(liveMandate);
  const root = makeScratch(gitRoot);
  bindGate24DeferredCapabilities({ root, gitRoot, ...pin(root) });
  const mandate = JSON.parse(liveMandate.toString('utf8'));
  const events = parseRegistry(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/')), 'utf8'));
  events.forEach((event, index) => {
    const entry = mandate.gate24DeferredCapabilities.entries[index];
    assert.equal(event.payload.sourceGate, entry.sourceGate);
    assert.equal(event.payload.capabilityName, entry.capabilityName);
    assert.equal(event.payload.capabilityClass, entry.class);
    assert.equal(event.payload.status, entry.status);
    assert.equal(event.payload.disposition, 'OPEN');
    assert.deepEqual(event.payload.reasonDeferred, entry.reasonDeferred);
    assert.equal(event.payload.ownerPromotionRequired, entry.ownerPromotionRequired);
    assert.equal(event.payload.currentVersion, entry.currentVersion);
    assert.equal(event.payload.sourceMandateSha256, REQUIRED_MANDATE_SHA256);
    assert.ok(!Object.hasOwn(event.payload, 'abandoned'));
  });
});

test('S3-H12 altered mandate bytes cause the binder to reject', () => {
  const altered = Buffer.from(liveMandate);
  altered[100] = altered[100] === 32 ? 33 : 32;
  const gitRoot = makeGitWithMandate(altered);
  const root = makeScratch(gitRoot);
  assert.notEqual(sha256(altered), REQUIRED_MANDATE_SHA256);
  assert.throws(
    () => bindGate24DeferredCapabilities({ root, gitRoot, ...pin(root) }),
    (error) => error.code === 'GATE24_MANDATE_HEAD_BYTES_MISMATCH'
  );
  assert.equal(fs.readFileSync(path.join(root, ...REGISTRY_PATH.split('/'))).length, 0);
});

test('S3-H13 a mandate not resolvable from HEAD is rejected', () => {
  const root = makeScratch();
  fs.mkdirSync(path.dirname(path.join(root, ...MANDATE_PATH.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...MANDATE_PATH.split('/')), liveMandate);
  assert.throws(
    () => bindGate24DeferredCapabilities({ root, gitRoot: root, ...pin(root) }),
    (error) => error.code === 'GATE24_MANDATE_NOT_RESOLVABLE_FROM_HEAD'
  );
  const proof = proveGate24MandateHeadPersistence({ gitRoot: REPO_ROOT });
  assert.equal(proof.headSha256, REQUIRED_MANDATE_SHA256);
  assert.equal(proof.headByteLength, REQUIRED_MANDATE_BYTE_LENGTH);
  assert.equal(proof.resolvableFromHead, true);
});

test('S3-H18 readiness surfaces imported GATE24 target commitments from the index', async () => {
  const gitRoot = makeGitWithMandate(liveMandate);
  const root = makeScratch(gitRoot);
  bindGate24DeferredCapabilities({ root, gitRoot, ...pin(root) });
  const { index, indexBytes } = generateDeferredCapabilityIndex({ root, now: new Date(RECORDED_AT) });
  fs.mkdirSync(path.dirname(path.join(root, ...INDEX_PATH.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(root, ...INDEX_PATH.split('/')), indexBytes);
  assert.equal(index.entryCount, 12);
  assert.equal(index.openCommitmentCount, 12);
  assert.deepEqual(index.bySourceGate.GATE24, [...GATE24_IMPORT_IDS]);
  assert.equal(index.byDisposition.OPEN.length, 12);
  assert.equal(index.trustRoot, REGISTRY_PATH);
  const surfaced = [...GATE24_IMPORT_IDS].map((id) => index.byId[id]);
  assert.ok(surfaced.every((entry) => entry.sourceGate === 'GATE24' && entry.disposition === 'OPEN' && entry.origin === 'IMPORT_BINDING'));
  assert.equal(surfaced.filter((entry) => (entry.dispositionDecisions ?? []).length === 0).length, 12);
});

test('S3-H20 GATE24 lifecycle and ACTIVE_GATE remain unchanged by binding', () => {
  const gitRoot = makeGitWithMandate(liveMandate);
  const root = makeScratch(gitRoot);
  const ledgerBefore = sha256(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/'))));
  const activeBefore = fs.readFileSync(path.join(root, ...ACTIVE_GATE_PATH.split('/')), 'utf8');
  bindGate24DeferredCapabilities({ root, gitRoot, ...pin(root) });
  assert.equal(sha256(fs.readFileSync(path.join(root, ...LEDGER_PATH.split('/')))), ledgerBefore);
  assert.equal(fs.readFileSync(path.join(root, ...ACTIVE_GATE_PATH.split('/')), 'utf8'), activeBefore);
  const liveActive = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ...ACTIVE_GATE_PATH.split('/')), 'utf8'));
  assert.equal(liveActive.activeGate, 'GATE13');
  const liveLedger = fs.readFileSync(path.join(REPO_ROOT, ...LEDGER_PATH.split('/')));
  assert.equal(sha256(liveLedger), LIVE_LEDGER_SHA);
  assert.equal(!fs.existsSync(path.join(REPO_ROOT, 'governance', 'gates', 'GATE24', 'state', 'CURRENT_STATE.json')), true);
});
