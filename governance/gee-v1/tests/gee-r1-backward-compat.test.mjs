import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const PINNED = {
  'governance/gates/GATE13/state/revisions/R0002/STATE_SEAL.json':
    '4e62299926bfe611bc39cbe911bae772e70d09726420fe0976cb618133c9ac0f',
  'governance/gates/GATE13/contracts/EXECUTION_CONTRACT_R0001.json':
    'eb2aa7db21fb5a250fe32dad30d7717c1dd49d5e14bff9ede619dfbe65a79c5c',
  'governance/gates/GATE13/contracts/CURRENT_CONTRACT.json':
    'e687284f3e0e9e92cc466b34c89a35bc6365730492ed9bbf23feb05f346778a0',
  'governance/gates/GATE13/state/CURRENT_STATE.json':
    'd9cd2f88cda87f684401ab987a519efda47e4fe0fdd61ea593a27ceff994edc4'
};

test('GATE13 historical seals and contracts remain byte-identical to independent-audit pins', () => {
  for (const [rel, expected] of Object.entries(PINNED)) {
    const actual = sha256(path.join(REPO_ROOT, rel));
    assert.equal(actual, expected, rel);
  }
  const seal = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gates/GATE13/state/revisions/R0002/STATE_SEAL.json'), 'utf8'));
  assert.equal(seal.payload.executionStatus, 'COMPLETE_CONFIRMED');
});

test('validate-state-seal and validate-state-revision still PASS for GATE13', () => {
  const seal = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'governance/tools/validate-state-seal.mjs'),
    '--seal', 'governance/gates/GATE13/state/revisions/R0002/STATE_SEAL.json'
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(seal.status, 0, seal.stdout + seal.stderr);
  const report = JSON.parse(seal.stdout);
  assert.equal(report.valid, true);

  const rev = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'governance/tools/validate-state-revision.mjs'),
    '--gate', 'GATE13'
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(rev.status, 0, rev.stdout + rev.stderr);
  assert.equal(JSON.parse(rev.stdout).valid, true);
});

test('active pointer file still present and parseable (not rewritten by R1)', () => {
  const active = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/active/ACTIVE_GATE.json'), 'utf8'));
  assert.equal(typeof active.activeGate, 'string');
  assert.ok(active.activeGate.length > 0);
});

test('no R1 mutation of historical gate-contract schema', () => {
  const schemaPath = path.join(REPO_ROOT, 'governance/schemas/gate-contract.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.$id, 'gate-contract.schema.json');
  assert.ok(schema.properties.gateId);
});
