import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  FUNCTIONAL_PATHS, FREEZE_INPUTS, buildArtifacts, classifyDelta, sha256Bytes,
  validateArtifacts, verifyArtifactDigest
} from '../implementation/final-git-and-verdict.mjs';

const ROOT = new URL('../../../..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, '$1:').replaceAll('/', '\\');
const CLOSURE = 'governance/gates/GATE20/evidence/FOUNDATION_CLOSURE_VERDICT.json';

test('G20-POS-01: recomputes the predecessor audit and required byte frontier', () => {
  const result = buildArtifacts({ root: ROOT, write: false });
  assert.equal(result.predecessorAudit.FINAL_GATE_INTEGRITY, 'PASS');
  assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.artifacts.freezeManifest.members.length, FREEZE_INPUTS.length);
  assert.equal(result.artifacts.closureVerdict.recomputed, true);
});

test('G20-POS-02: generated outputs bind to actual bytes and stop before Mission B', () => {
  const report = validateArtifacts(ROOT);
  assert.equal(report.valid, true, JSON.stringify(report));
  assert.equal(FUNCTIONAL_PATHS.length, 5);
  const closure = JSON.parse(fs.readFileSync(`${ROOT}\\${CLOSURE}`, 'utf8'));
  assert.equal(closure.independentConfirmation, 'PENDING_SEPARATE_MISSION_B');
  assert.equal(closure.automaticPush, false);
});

test('G20-POS-03: identical input objects serialize byte-identically', () => {
  const left = buildArtifacts({ root: ROOT, write: false, now: new Date('2026-08-16T15:35:00.000Z') });
  const right = buildArtifacts({ root: ROOT, write: false, now: new Date('2026-08-16T15:35:00.000Z') });
  assert.equal(sha256Bytes(Buffer.from(JSON.stringify(left.artifacts.freezeManifest))), sha256Bytes(Buffer.from(JSON.stringify(right.artifacts.freezeManifest))));
});

test('G20-NEG-01: an unexpected Git path is never absorbed into the functional cohort', () => {
  const result = classifyDelta([{ code: '??', path: 'outside/foreign.txt' }]);
  assert.deepEqual(result.functionalDelta, []);
  assert.deepEqual(result.outsideFunctionalScope, ['outside/foreign.txt']);
});

test('G20-NEG-02: a future authorization claim is rejected by the independent field check', () => {
  const result = validateArtifacts(ROOT);
  assert.equal(result.checks.find((check) => check.id === 'NO_GATE21_AUTHORIZATION')?.pass, true);
});

test('G20-NEG-03: a mutated digest cannot validate', () => {
  const file = 'governance/GATE_REGISTRY_00_40.json';
  assert.equal(verifyArtifactDigest(ROOT, file, '0'.repeat(64)), false);
});

test('G20-CTR-01: an asserted PASS is not used as the detector', () => {
  const result = buildArtifacts({ root: ROOT, write: false });
  result.artifacts.closureVerdict.verdict = 'PASS';
  assert.equal(result.predecessorAudit.FINAL_GATE_INTEGRITY, 'PASS');
  assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.artifacts.closureVerdict.recomputed, true);
});

test('G20-CTR-02: no Git mutation is requested by the receipt producer', () => {
  const result = buildArtifacts({ root: ROOT, write: false });
  assert.deepEqual(result.artifacts.receipt.requestedOperations, []);
  assert.equal(result.artifacts.receipt.commitPerformed, false);
  assert.equal(result.artifacts.receipt.pushPerformed, false);
});
