import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  EXACT_SEALED_BYTE_RESTORATION,
  evaluateExactSealedByteRestoration
} from '../core/sealed-state-evidence.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESTORATION_COMMIT = '55dcf426b99d7d6afe5cb993ec0891fc5e15e123';
const PARENT_COMMIT = '8d7653a8d7143faec9f40ae39d978421157c2b1e';
const REPORT_PATH = 'governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json';
const BEFORE_SHA256 = '69ffb7591be6e0cbb5caada0c96414852aaaac76cbd4a4f128aa08d5d5234890';
const RESTORED_SHA256 = 'd5e4c719d7ed3979a33805349c809dd873220ed2fcea845441ad6b10511562d8';
const REPORT_BYTE_LENGTH = 64884;
const SEALED_MEMBER = {
  repoRelativePath: REPORT_PATH,
  sha256: RESTORED_SHA256,
  byteLength: REPORT_BYTE_LENGTH,
  gateId: 'GATE16',
  stateRevision: 'R0004',
  sealPath: 'governance/gates/GATE16/state/revisions/R0004/STATE_SEAL.json'
};
const PRIOR_RESTORATION_COHORT = Object.freeze([
  REPORT_PATH,
  'governance/gates/GATE16/implementation/crosscheck-validator.mjs',
  'governance/gates/GATE16/tests/gate16-independent-crosscheck.test.mjs',
  'governance/gee-v1/adapters/gee-mission-authority-source.mjs',
  'governance/gee-v1/core/post-freeze-maintenance-authority.mjs',
  'governance/gee-v1/core/sealed-state-evidence.mjs',
  'governance/gee-v1/tests/gee-post-freeze-maintenance-authority.test.mjs',
  'governance/historical-architecture/WHEEL_POST_CLOSURE_SEALED_EVIDENCE_IMMUTABILITY_REPAIR_R1_AUTHORIZED_PATHS.json',
  'governance/historical-architecture/WHEEL_POST_CLOSURE_SEALED_EVIDENCE_IMMUTABILITY_REPAIR_R1_CONSUMPTION_R1.json',
  'governance/historical-architecture/WHEEL_POST_CLOSURE_SEALED_EVIDENCE_IMMUTABILITY_REPAIR_R1_EVIDENCE.json',
  'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_WHEEL_POST_CLOSURE_SEALED_EVIDENCE_IMMUTABILITY_REPAIR_R1.json',
  'governance/tools/validate-post-freeze-maintenance-authority.mjs'
]);

function baseRequest() {
  return {
    root: REPO_ROOT,
    authorizedPaths: PRIOR_RESTORATION_COHORT,
    path: REPORT_PATH,
    beforeSha256: BEFORE_SHA256,
    beforeByteLength: REPORT_BYTE_LENGTH,
    restoredSha256: RESTORED_SHA256,
    restoredByteLength: REPORT_BYTE_LENGTH,
    restorationCommit: RESTORATION_COMMIT,
    parentCommit: PARENT_COMMIT,
    sealedMember: SEALED_MEMBER,
    ownerApproved: true,
    semanticBytesIntroduced: false,
    resealAttempt: false,
    ledgerRewriteAttempt: false,
    historyRewriteAttempt: false,
    operation: EXACT_SEALED_BYTE_RESTORATION
  };
}

function evaluate(overrides = {}) {
  return evaluateExactSealedByteRestoration({ ...baseRequest(), ...overrides });
}

function assertBlocked(result) {
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.idempotent, false);
  assert.ok(result.findings.length > 0);
}

test('exact historical restoration is authorized from the sealed R0004 member', () => {
  const result = evaluate();
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.idempotent, true);
  assert.equal(result.operation, EXACT_SEALED_BYTE_RESTORATION);
  assert.equal(result.sealedMemberMatches.length, 1);
});

test('arbitrary mutated bytes are blocked', () => {
  assertBlocked(evaluate({ restoredSha256: '0'.repeat(64) }));
});

test('correct hash with the wrong restored length is blocked', () => {
  assertBlocked(evaluate({ restoredByteLength: REPORT_BYTE_LENGTH + 1 }));
});

test('a restoration naming a different sealed path is blocked', () => {
  assertBlocked(evaluate({
    sealedMember: { ...SEALED_MEMBER, repoRelativePath: 'governance/gates/GATE16/evidence/OTHER.json' }
  }));
});

test('a path absent from every closed STATE_SEAL is blocked', () => {
  const unsealedPath = 'governance/gee-v1/core/sealed-state-evidence.mjs';
  const bytes = fs.readFileSync(path.join(REPO_ROOT, unsealedPath));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assertBlocked(evaluate({
    authorizedPaths: [...PRIOR_RESTORATION_COHORT, unsealedPath],
    path: unsealedPath,
    restoredSha256: sha256,
    restoredByteLength: bytes.length,
    sealedMember: { ...SEALED_MEMBER, repoRelativePath: unsealedPath, sha256, byteLength: bytes.length }
  }));
});

test('a reseal attempt is blocked', () => {
  assertBlocked(evaluate({ resealAttempt: true }));
});

test('a ledger rewrite attempt is blocked', () => {
  assertBlocked(evaluate({ ledgerRewriteAttempt: true }));
});

test('a history rewrite attempt is blocked', () => {
  assertBlocked(evaluate({ historyRewriteAttempt: true }));
});

test('repeated verification is authorized and idempotent', () => {
  const first = evaluate();
  const second = evaluate();
  assert.deepEqual(second, first);
  assert.equal(second.decision, 'AUTHORIZED');
  assert.equal(second.idempotent, true);
});
