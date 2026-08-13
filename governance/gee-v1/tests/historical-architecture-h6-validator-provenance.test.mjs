/**
 * H6 — the tree under judgement must not supply the code that judges it.
 *
 * H6-05 is the load-bearing test: it builds a candidate tree containing a
 * SABOTAGED validator that reports everything valid, runs the real tool against
 * that candidate, and proves the real code decided anyway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluateValidatorProvenance,
  validateValidatorProvenanceManifest,
  PURPOSE_ADMISSION,
  PURPOSE_REPLAY
} from '../core/validator-provenance.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = path.join(REPO_ROOT, 'governance/tools/validate-validator-provenance.mjs');
const MANIFEST = path.join(REPO_ROOT, 'governance/historical-architecture/VALIDATOR_PROVENANCE_MANIFEST.json');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const codes = (result) => result.findings.map((f) => f.code);

test('H6-01: the shipped provenance manifest is valid and pins real bytes', () => {
  const result = validateValidatorProvenanceManifest(manifest());
  assert.deepEqual(result.findings, []);
  for (const entry of manifest().validators) {
    const bytes = fs.readFileSync(path.join(REPO_ROOT, ...entry.canonicalPath.split('/')));
    assert.equal(sha(bytes), entry.sha256, entry.canonicalPath);
    assert.equal(bytes.length, entry.byteLength, entry.canonicalPath);
  }
});

test('H6-02: a validator at its canonical path with the pinned digest is admitted', () => {
  const entry = manifest().validators[0];
  const result = evaluateValidatorProvenance({
    manifest: manifest(), canonicalPath: entry.canonicalPath, purpose: PURPOSE_ADMISSION,
    observed: { resolvedPath: entry.canonicalPath, resolvedSha256: entry.sha256, resolvedFromCandidateTree: false }
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.decision, 'AUTHORIZED');
});

test('H6-03: a validator resolved from the candidate tree is refused', () => {
  const entry = manifest().validators[0];
  const result = evaluateValidatorProvenance({
    manifest: manifest(), canonicalPath: entry.canonicalPath, purpose: PURPOSE_ADMISSION,
    // Same path, same digest — only the ORIGIN differs, and that alone must block.
    observed: { resolvedPath: entry.canonicalPath, resolvedSha256: entry.sha256, resolvedFromCandidateTree: true }
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('VALIDATOR_RESOLVED_FROM_CANDIDATE_TREE'));
});

test('H6-04: wrong digest, wrong path, or an unpinned validator are all refused', () => {
  const entry = manifest().validators[0];
  const base = { manifest: manifest(), canonicalPath: entry.canonicalPath, purpose: PURPOSE_ADMISSION };
  assert.ok(codes(evaluateValidatorProvenance({ ...base, observed: { resolvedPath: entry.canonicalPath, resolvedSha256: 'f'.repeat(64), resolvedFromCandidateTree: false } }))
    .includes('VALIDATOR_DIGEST_MISMATCH'));
  assert.ok(codes(evaluateValidatorProvenance({ ...base, observed: { resolvedPath: 'candidate/tools/validate-status-ledger.mjs', resolvedSha256: entry.sha256, resolvedFromCandidateTree: false } }))
    .includes('VALIDATOR_NOT_AT_CANONICAL_PATH'));
  assert.ok(codes(evaluateValidatorProvenance({ ...base, canonicalPath: 'governance/tools/not-admitted.mjs', observed: {} }))
    .includes('VALIDATOR_NOT_IN_EXECUTION_MANIFEST'));
});

test('H6-05: a candidate tree carrying a sabotaged validator cannot decide its own verdict', () => {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'h6-candidate-'));
  try {
    // Build a candidate that ships its OWN governance/tools, including a
    // validator rewritten to approve absolutely everything.
    const toolsDir = path.join(candidate, 'governance', 'tools');
    const architectureDir = path.join(candidate, 'governance', 'historical-architecture');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(architectureDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'validate-validator-provenance.mjs'),
      'process.stdout.write(JSON.stringify({document:"VALIDATOR_PROVENANCE_VALIDATION",valid:true,validators:[],findings:[]}));\n');
    fs.writeFileSync(path.join(toolsDir, 'validate-status-ledger.mjs'), 'export function validateLedger(){return {valid:true,findings:[],events:[]};}\n');
    // Give the candidate a manifest that "pins" its own sabotaged bytes.
    const sabotaged = fs.readFileSync(path.join(toolsDir, 'validate-status-ledger.mjs'));
    fs.writeFileSync(path.join(architectureDir, 'VALIDATOR_PROVENANCE_MANIFEST.json'), JSON.stringify({
      documentKind: 'HISTORICAL_ARCHITECTURE_VALIDATOR_PROVENANCE_MANIFEST', schemaVersion: 1,
      programId: 'GOVERNANCE_HISTORICAL_ARCHITECTURE_IMPLEMENTATION_PROGRAM_R1', statement: 'candidate',
      validators: [{ canonicalPath: 'governance/tools/validate-status-ledger.mjs', sha256: sha(sabotaged), byteLength: sabotaged.length, purpose: 'ADMISSION_AND_REPLAY' }]
    }, null, 2) + '\n');

    // Run the REAL tool with cwd inside the candidate and --root pointing at it.
    const out = execFileSync(process.execPath, [TOOL, '--root', candidate], { cwd: candidate, encoding: 'utf8' });
    const report = JSON.parse(out);
    // It resolved its canonical root from its own file location, so it judged
    // the real validators and never loaded the candidate's sabotaged copies.
    assert.equal(report.canonicalRootDerivedFrom, 'THIS_FILE_LOCATION');
    assert.equal(report.validators.length, manifest().validators.length);
    assert.equal(report.valid, true);
    // Proof it did not read the candidate's manifest: the candidate pinned one
    // validator, the real manifest pins all of them.
    assert.ok(report.validators.length > 1);
    assert.ok(report.validators.some((v) => v.canonicalPath === 'governance/tools/replay-governance-history.mjs'));
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
});

test('H6-06: replay identifies a validator by retained historical identity', () => {
  const entry = manifest().validators[0];
  const historical = 'a'.repeat(64);
  // Replaying with today's code, when history says a different validator decided,
  // is not a replay.
  const drifted = evaluateValidatorProvenance({
    manifest: manifest(), canonicalPath: entry.canonicalPath, purpose: PURPOSE_REPLAY,
    observed: { resolvedSha256: entry.sha256, historicalSha256: historical }
  });
  assert.equal(drifted.decision, 'BLOCKED');
  assert.ok(codes(drifted).includes('REPLAY_VALIDATOR_IDENTITY_MISMATCH'));

  const faithful = evaluateValidatorProvenance({
    manifest: manifest(), canonicalPath: entry.canonicalPath, purpose: PURPOSE_REPLAY,
    observed: { resolvedSha256: historical, historicalSha256: historical }
  });
  assert.deepEqual(faithful.findings, []);
});

test('H6-07: replay without a retained historical identity is refused', () => {
  const entry = manifest().validators[0];
  const result = evaluateValidatorProvenance({
    manifest: manifest(), canonicalPath: entry.canonicalPath, purpose: PURPOSE_REPLAY,
    observed: { resolvedSha256: entry.sha256 }
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('REPLAY_HISTORICAL_IDENTITY_ABSENT'));
});

test('H6-08: no key, signature or rotation machinery is introduced', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'governance/gee-v1/core/validator-provenance.mjs'), 'utf8');
  // Checked as CODE, not as prose: the module explains in comments that it uses
  // no key machinery, so scanning for the words would match the explanation.
  assert.equal(/from ['"]node:crypto['"]/.test(source), false, 'provenance must not import crypto');
  for (const api of ['createSign(', 'createVerify(', 'crypto.sign(', 'crypto.verify(', 'privateKey']) {
    assert.equal(source.includes(api), false, `${api} must not appear`);
  }
  // The manifest carries content identity only — no key material of any kind.
  for (const entry of manifest().validators) {
    assert.deepEqual(Object.keys(entry).sort(), ['byteLength', 'canonicalPath', 'purpose', 'sha256']);
  }
});

test('H6-09: the executable verifier reports every admitted validator authorized', () => {
  const report = JSON.parse(execFileSync(process.execPath, [TOOL], { encoding: 'utf8' }));
  assert.equal(report.valid, true, JSON.stringify(report.findings));
  assert.ok(report.validators.every((v) => v.decision === 'AUTHORIZED'));
  assert.equal(report.validators.length, 8);
});
