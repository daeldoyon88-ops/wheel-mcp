// I4_ADAPTER_DEFAULT_SOURCE_MAP_ACTIVATION_AND_GOVERNANCE_CLOSURE_R1
// Every mutation happens in a physical sandbox copy. The repository ledger, the
// canonical source map, and every adopted authority stay read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const VALIDATOR = path.join(REPO_ROOT, 'governance', 'tools', 'validate-status-ledger.mjs');

const SOURCE_MAP_REL = 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json';
const LEDGER_REL = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const EXTERNAL_REPORT_REL = 'governance/sources/GATE12_L3_RECLOSURE_R1_EXTERNAL_REINSPECTION_REPORT.json';
const CONTRACT_REL = 'governance/gates/GATE12/contracts/EXECUTION_CONTRACT_R0001.json';
const BOOTSTRAP_AUTHORITY_REL = 'governance/sources/I4_BOOTSTRAP_EXECUTION_AUTHORITY.json';

const REPO_SOURCE_MAP_SHA_AT_START = sha256(path.join(REPO_ROOT, SOURCE_MAP_REL));
const REPO_EXTERNAL_REPORT_SHA_AT_START = sha256(path.join(REPO_ROOT, EXTERNAL_REPORT_REL));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Physical byte copies only: no hard link, no symlink, no junction.
function copyTreePhysical(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false, `source entry must not be a link: ${source}`);
    if (entry.isDirectory()) {
      copyTreePhysical(source, destination);
      continue;
    }
    fs.writeFileSync(destination, fs.readFileSync(source));
    const copied = fs.lstatSync(destination);
    assert.equal(copied.isSymbolicLink(), false, `copied entry must not be a link: ${destination}`);
    assert.equal(copied.nlink === undefined || copied.nlink <= 1, true, `copied entry must not be a hard link: ${destination}`);
  }
}

function makeSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-default-source-map-'));
  copyTreePhysical(path.join(REPO_ROOT, 'governance'), path.join(dir, 'governance'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, cwd = os.tmpdir()) {
  const result = spawnSync(process.execPath, [VALIDATOR, ...args], { cwd, encoding: 'utf8' });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, report };
}

function detectors(report) {
  return (report?.findings ?? []).map((f) => f.detectorId);
}

test('1. normal entry without --source-map activates the canonical default and passes', () => {
  const outcome = run(['--root', REPO_ROOT]);
  assert.equal(outcome.exitCode, 0, outcome.stdout + outcome.stderr);
  assert.equal(outcome.report.valid, true);
  assert.equal(outcome.report.findings.length, 0);
  assert.equal(outcome.report.eventCount, 41);
  assert.equal(outcome.report.sourceMap.origin, 'CANONICAL_DEFAULT');
  assert.equal(outcome.report.sourceMap.declaredPath, SOURCE_MAP_REL);
  assert.equal(outcome.report.sourceMap.resolvedPath, SOURCE_MAP_REL);
  assert.equal(outcome.report.sourceMap.loaded, true);
});

test('2. explicit valid override is preserved, relative and absolute', () => {
  const relative = run(['--root', REPO_ROOT, '--source-map', SOURCE_MAP_REL]);
  assert.equal(relative.exitCode, 0, relative.stdout + relative.stderr);
  assert.equal(relative.report.valid, true);
  assert.equal(relative.report.findings.length, 0);
  assert.equal(relative.report.eventCount, 41);
  assert.equal(relative.report.sourceMap.origin, 'EXPLICIT_OVERRIDE');
  assert.equal(relative.report.sourceMap.loaded, true);

  const absolute = run(['--root', REPO_ROOT, '--source-map', path.join(REPO_ROOT, SOURCE_MAP_REL)]);
  assert.equal(absolute.exitCode, 0, absolute.stdout + absolute.stderr);
  assert.equal(absolute.report.valid, true);
  assert.equal(absolute.report.findings.length, 0);
  assert.equal(absolute.report.sourceMap.origin, 'EXPLICIT_OVERRIDE');
  assert.equal(absolute.report.sourceMap.loaded, true);
});

test('3. invalid explicit override fails closed and never falls back to the default', (t) => {
  const sandbox = makeSandbox(t);

  const missing = run(['--root', sandbox, '--source-map', 'governance/authority/NO_SUCH_SOURCE_MAP.json']);
  assert.equal(missing.exitCode, 2);
  assert.equal(missing.report.valid, false);
  assert.ok(detectors(missing.report).includes('MISSING_GENESIS_IMPORT_SOURCE_MAP'));
  assert.equal(missing.report.sourceMap.origin, 'EXPLICIT_OVERRIDE');
  assert.equal(missing.report.sourceMap.loaded, false);
  assert.notEqual(missing.report.sourceMap.resolvedPath, SOURCE_MAP_REL);
  // Proof of no silent fallback: the map-dependent external authority stays unresolved.
  assert.ok(detectors(missing.report).includes('MISSING_TRANSITION_AUTHORITY'));

  const corruptOverride = path.join(sandbox, 'governance', 'authority', 'CORRUPT_OVERRIDE.json');
  fs.writeFileSync(corruptOverride, '{ "gates": [ this is not json', 'utf8');
  const corrupt = run(['--root', sandbox, '--source-map', 'governance/authority/CORRUPT_OVERRIDE.json']);
  assert.equal(corrupt.exitCode, 2);
  assert.equal(corrupt.report.valid, false);
  assert.ok(detectors(corrupt.report).includes('INVALID_GENESIS_IMPORT_SOURCE_MAP'));
  assert.equal(corrupt.report.sourceMap.origin, 'EXPLICIT_OVERRIDE');
  assert.equal(corrupt.report.sourceMap.loaded, false);
  assert.ok(detectors(corrupt.report).includes('MISSING_TRANSITION_AUTHORITY'));

  // A declared --source-map flag with no value is an override, not an absent override.
  const empty = run(['--root', sandbox, '--source-map']);
  assert.equal(empty.exitCode, 2);
  assert.equal(empty.report.valid, false);
  assert.equal(empty.report.sourceMap.origin, 'EXPLICIT_OVERRIDE');
  assert.equal(empty.report.sourceMap.loaded, false);
  assert.ok(detectors(empty.report).includes('MISSING_GENESIS_IMPORT_SOURCE_MAP'));

  // The sandbox default map is intact, so the failures above are override failures.
  const control = run(['--root', sandbox]);
  assert.equal(control.exitCode, 0, control.stdout + control.stderr);
  assert.equal(control.report.valid, true);
  assert.equal(control.report.findings.length, 0);
});

test('4. absent canonical default map fails closed with a structured finding', (t) => {
  const sandbox = makeSandbox(t);
  fs.rmSync(path.join(sandbox, SOURCE_MAP_REL));

  const outcome = run(['--root', sandbox]);
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.report.valid, false);
  assert.equal(outcome.report.sourceMap.origin, 'CANONICAL_DEFAULT');
  assert.equal(outcome.report.sourceMap.loaded, false);
  const structured = outcome.report.findings.find((f) => f.detectorId === 'MISSING_GENESIS_IMPORT_SOURCE_MAP');
  assert.ok(structured);
  assert.equal(structured.severity, 'BLOCKING');
  assert.equal(structured.jsonPointer, '/sourceMap');
  assert.equal(structured.requirementId, 'REQ-BST-01');
  assert.equal(structured.actualValue, SOURCE_MAP_REL);
});

test('5. unparsable canonical default map fails closed with a structured finding', (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(path.join(sandbox, SOURCE_MAP_REL), '{ "gates": [ broken', 'utf8');

  const outcome = run(['--root', sandbox]);
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.report.valid, false);
  assert.equal(outcome.report.sourceMap.origin, 'CANONICAL_DEFAULT');
  assert.equal(outcome.report.sourceMap.loaded, false);
  const structured = outcome.report.findings.find((f) => f.detectorId === 'INVALID_GENESIS_IMPORT_SOURCE_MAP');
  assert.ok(structured);
  assert.equal(structured.severity, 'BLOCKING');
  assert.equal(structured.jsonPointer, '/sourceMap');
  assert.equal(structured.requirementId, 'REQ-BST-01');

  // A JSON array is a parsable document but not a source map object.
  fs.writeFileSync(path.join(sandbox, SOURCE_MAP_REL), '[]', 'utf8');
  const arrayOutcome = run(['--root', sandbox]);
  assert.equal(arrayOutcome.exitCode, 2);
  assert.equal(arrayOutcome.report.valid, false);
  assert.ok(detectors(arrayOutcome.report).includes('INVALID_GENESIS_IMPORT_SOURCE_MAP'));
});

test('6. absent external authority fails even with the default map active', (t) => {
  const sandbox = makeSandbox(t);
  fs.rmSync(path.join(sandbox, EXTERNAL_REPORT_REL));

  const outcome = run(['--root', sandbox]);
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.report.valid, false);
  assert.equal(outcome.report.sourceMap.loaded, true);
  assert.ok(detectors(outcome.report).includes('MISSING_TRANSITION_AUTHORITY'));
  assert.ok(detectors(outcome.report).includes('COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION'));
});

test('7. external authority hash mismatch fails even with the default map active', (t) => {
  const sandbox = makeSandbox(t);
  const reportPath = path.join(sandbox, EXTERNAL_REPORT_REL);
  const mutated = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  mutated.I4_HOSTILE_MUTATION = 'byte-level tamper';
  fs.writeFileSync(reportPath, JSON.stringify(mutated, null, 2), 'utf8');
  assert.notEqual(sha256(reportPath), REPO_EXTERNAL_REPORT_SHA_AT_START);

  const outcome = run(['--root', sandbox]);
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.report.valid, false);
  assert.equal(outcome.report.sourceMap.loaded, true);
  assert.ok(detectors(outcome.report).includes('AUTHORITY_HASH_MISMATCH'));
  assert.ok(detectors(outcome.report).includes('AUTHORITY_MANIFEST_HASH_MISMATCH'));
});

test('8. the result is identical from any terminal working directory', (t) => {
  const sandbox = makeSandbox(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-cwd-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));

  const cwds = [REPO_ROOT, os.tmpdir(), elsewhere, sandbox, path.join(REPO_ROOT, 'governance', 'tools')];
  const observed = cwds.map((cwd) => {
    const outcome = run(['--root', REPO_ROOT], cwd);
    return JSON.stringify({
      exitCode: outcome.exitCode,
      valid: outcome.report.valid,
      eventCount: outcome.report.eventCount,
      findings: outcome.report.findings.length,
      sourceMap: outcome.report.sourceMap
    });
  });
  for (const value of observed) assert.equal(value, observed[0]);
  const first = JSON.parse(observed[0]);
  assert.equal(first.exitCode, 0);
  assert.equal(first.valid, true);
  assert.equal(first.findings, 0);
  assert.equal(first.sourceMap.resolvedPath, SOURCE_MAP_REL);

  // A decoy map beside the terminal working directory must never be selected.
  fs.mkdirSync(path.join(elsewhere, 'governance', 'authority'), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, SOURCE_MAP_REL), '{ "gates": [] }', 'utf8');
  const decoy = run(['--root', REPO_ROOT], elsewhere);
  assert.equal(decoy.exitCode, 0, decoy.stdout + decoy.stderr);
  assert.equal(decoy.report.valid, true);
  assert.equal(decoy.report.findings.length, 0);
});

test('9. the I4 contract authorizes no GATE13 path', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONTRACT_REL), 'utf8'));
  assert.equal(contract.gateId, 'GATE12');
  assert.equal(contract.contractRevision, 'R0001');
  assert.equal(contract.authorizedPaths.length, 8);
  for (const authorized of contract.authorizedPaths) {
    assert.equal(authorized.includes('GATE13'), false, `authorizedPaths must not reach GATE13: ${authorized}`);
  }
  assert.equal(JSON.stringify(contract).includes('"governance/gates/GATE13'), false);
});

test('10. GATE13 is neither executable nor authorized by this mission', () => {
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance', 'gates', 'GATE13')), false);

  const authority = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BOOTSTRAP_AUTHORITY_REL), 'utf8'));
  assert.equal(authority.constraints.gate13Authorized, false);
  assert.equal(authority.constraints.gate13ExecutableAllowed, false);
  assert.equal(authority.constraints.gate14Authorized, false);
  for (const authorized of authority.authorizedPaths) {
    assert.equal(authorized.includes('GATE13'), false);
  }

  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONTRACT_REL), 'utf8'));
  assert.equal(contract.nextGateAuthorizationConditions.some((c) => /GATE13/.test(c) && /not authorized|non autoris/i.test(c)), true);
});

// Replacement for the ledger portion of test 11 — GEE_V1_R1_ARCHITECTURE_REPAIR_IMPLEMENTATION_R1
// (RC-1/RC-2): OLD_TEST_ASSUMPTION: the WHOLE ledger file's bytes never change.
// WHY_INVALID: same root cause as G13-REPAIR-06 in gate13-authority-conflicts-repair.test.mjs — the
// ledger is now the real authority spine and records real appended transitions (GATE13 reaching
// COMPLETE_CONFIRMED via real independent-reinspection evidence), not a frozen genesis snapshot.
// NEW_ARCHITECTURE_RULE / NEW_TEST: the first 41 historical lines stay byte-identical; only appended
// lines beyond them may exist. The canonical map and external report remain fully untouched, as before.
test('11. the canonical map and the external authority stay read-only; the ledger stays append-only', () => {
  assert.equal(sha256(path.join(REPO_ROOT, SOURCE_MAP_REL)), REPO_SOURCE_MAP_SHA_AT_START);
  assert.equal(sha256(path.join(REPO_ROOT, EXTERNAL_REPORT_REL)), REPO_EXTERNAL_REPORT_SHA_AT_START);
  assert.equal(REPO_SOURCE_MAP_SHA_AT_START, 'a41bf05fcc4186c83f4e7928562250a260311cc92ccbbe31c37843af6dbeb92b');
  assert.equal(REPO_EXTERNAL_REPORT_SHA_AT_START, '8d524eb4969d669ddb01d443d787c1e9f13e6e634e2f8eef0f2c4fbc1e08bd08');

  const lines = fs.readFileSync(path.join(REPO_ROOT, LEDGER_REL), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 41);
  const first41 = lines.slice(0, 41).join('\n') + '\n';
  assert.equal(sha256Bytes(Buffer.from(first41, 'utf8')), 'a39591873658989062cedfc96f2acd9415311950b94ee98ffb0d65575e3ecec5');
});

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
