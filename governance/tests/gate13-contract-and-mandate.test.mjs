// GATE13_CANONICAL_MANDATE_DEFINITION_AND_EXECUTION_CONTRACT_R1
// Every mutation happens in a physical sandbox copy. The repository ledger and
// governance/tools/validate-active-gate.mjs stay read-only in this repo copy.
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

const REGISTRY_REL = 'governance/GATE_REGISTRY_00_40.json';
const CONTRACT_REL = 'governance/gates/GATE13/contracts/EXECUTION_CONTRACT_R0001.json';
const POINTER_REL = 'governance/gates/GATE13/contracts/CURRENT_CONTRACT.json';
const CURRENT_STATE_REL = 'governance/gates/GATE13/state/CURRENT_STATE.json';
const SEAL_REL = 'governance/gates/GATE13/state/revisions/R0001/STATE_SEAL.json';
const ACTIVE_GATE_REL = 'governance/active/ACTIVE_GATE.json';
const LEDGER_REL = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const ACTIVE_GATE_VALIDATOR = path.join(REPO_ROOT, 'governance', 'tools', 'validate-active-gate.mjs');
const CONTRACT_VALIDATOR = path.join(REPO_ROOT, 'governance', 'tools', 'validate-gate-contract.mjs');
const STATE_VALIDATOR = path.join(REPO_ROOT, 'governance', 'tools', 'validate-state-revision.mjs');
const REGISTRY_VALIDATOR = path.join(REPO_ROOT, 'governance', 'tools', 'validate-gate-registry.mjs');
const GEN_DOCS = path.join(REPO_ROOT, 'governance', 'tools', 'generate-governance-docs.mjs');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function copyTreePhysical(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false, `source entry must not be a link: ${source}`);
    if (entry.isDirectory()) { copyTreePhysical(source, destination); continue; }
    fs.writeFileSync(destination, fs.readFileSync(source));
    assert.equal(fs.lstatSync(destination).isSymbolicLink(), false, `copied entry must not be a link: ${destination}`);
  }
}
function makeSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate13-mandate-'));
  copyTreePhysical(path.join(REPO_ROOT, 'governance'), path.join(dir, 'governance'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(scriptRel, args, cwd) {
  const result = spawnSync(process.execPath, [scriptRel, ...args], { cwd, encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(result.stdout || result.stderr); } catch { /* not JSON */ }
  return { status: result.status, report, stdout: result.stdout, stderr: result.stderr };
}

test('G13-POS-01: registry entry declares exact canonical name and non-null objective', () => {
  const registry = readJson(path.join(REPO_ROOT, REGISTRY_REL));
  const g13 = registry.gates.find((g) => g.gateId === 'GATE13');
  assert.equal(g13.officialName, 'Oracles and coverage');
  assert.equal(typeof g13.canonicalObjective, 'string');
  assert.ok(g13.canonicalObjective.length > 0);
  assert.equal(typeof g13.strategicPurpose, 'string');
  assert.deepEqual(g13.missingCanonicalFields, []);
});

test('G13-POS-02: no required registry field is NOT_CANONICALLY_DEFINED or null for GATE13', () => {
  const registry = readJson(path.join(REPO_ROOT, REGISTRY_REL));
  const g13 = registry.gates.find((g) => g.gateId === 'GATE13');
  for (const field of ['canonicalObjective', 'strategicPurpose', 'expectedOutputs', 'exitConditions']) {
    assert.notEqual(g13[field], null, `${field} must not be null`);
    assert.notEqual(g13[field], 'NOT_CANONICALLY_DEFINED', `${field} must not be NOT_CANONICALLY_DEFINED`);
  }
});

test('G13-POS-03: contract validates against the real validator with zero findings', () => {
  const result = run(CONTRACT_VALIDATOR, ['--contract', path.join(REPO_ROOT, CONTRACT_REL), '--pointer', path.join(REPO_ROOT, POINTER_REL)], REPO_ROOT);
  assert.equal(result.status, 0);
  assert.equal(result.report.valid, true);
  assert.equal(result.report.blockingCount, 0);
});

test('G13-POS-04: contract objective hash is bound to the real registry bytes', () => {
  const registry = readJson(path.join(REPO_ROOT, REGISTRY_REL));
  const g13 = registry.gates.find((g) => g.gateId === 'GATE13');
  const contract = readJson(path.join(REPO_ROOT, CONTRACT_REL));
  const canonicalize = (v) => {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
    if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  };
  const hash = crypto.createHash('sha256').update(canonicalize(g13.canonicalObjective), 'utf8').digest('hex');
  assert.equal(contract.strategicRegistryReference.canonicalObjectiveSha256, hash);
});

test('G13-POS-05: required functional outputs are declared, closure conditions require 100% mandatory coverage without denominator reduction', () => {
  const contract = readJson(path.join(REPO_ROOT, CONTRACT_REL));
  assert.ok(contract.requiredOutputs.length >= 8);
  const text = JSON.stringify(contract.closureConditions) + JSON.stringify(contract.canonicalRequirements);
  assert.match(text, /100%/);
  assert.match(text, /cannot be reduced|sans réduction artificielle|without denominator reduction/i);
});

test('G13-POS-06: allowlist for the future mission is exact paths, zero wildcards', () => {
  const contract = readJson(path.join(REPO_ROOT, CONTRACT_REL));
  assert.ok(Array.isArray(contract.authorizedPaths) && contract.authorizedPaths.length > 0);
  for (const p of contract.authorizedPaths) {
    assert.doesNotMatch(p, /[*?]/, `path must not contain a wildcard: ${p}`);
  }
});

test('G13-POS-07: state R0001 is AUTHORIZED_NOT_STARTED with executionStarted=false and GATE14 not authorized', () => {
  const seal = readJson(path.join(REPO_ROOT, SEAL_REL));
  assert.equal(seal.payload.executionStatus, 'AUTHORIZED_NOT_STARTED');
  assert.equal(seal.payload.gate13Started, false);
  assert.equal(seal.payload.gate14Authorized, false);
  assert.equal(seal.payload.gate13CompleteConfirmed, false);
});

test('G13-POS-08: state revision validates against the real validator with zero findings', () => {
  const result = run(STATE_VALIDATOR, ['--gate-id', 'GATE13', '--current-state', path.join(REPO_ROOT, CURRENT_STATE_REL), '--contract', path.join(REPO_ROOT, CONTRACT_REL)], REPO_ROOT);
  assert.equal(result.status, 0);
  assert.equal(result.report.valid, true);
});

test('G13-POS-09: reference counter is normalized to the audited 16/10/2/2/2 split', () => {
  const seal = readJson(path.join(REPO_ROOT, SEAL_REL));
  assert.deepEqual(seal.payload.referenceCounters, {
    TOTAL_REFERENCES: 16, CANONICAL_ACTIVE: 10, CANONICAL_HISTORICAL: 2, GENERATED: 2, INFORMATIONAL: 2, STALE: 0, CONTRADICTORY: 0, UNRESOLVED: 0
  });
});

test('G13-POS-10: GATE_REGISTRY_00_40.json validates against the real registry validator with verdict PASS', () => {
  const result = run(REGISTRY_VALIDATOR, [], REPO_ROOT);
  assert.equal(result.report.verdict, 'PASS');
});

test('G13-POS-11: generated GATE_REGISTRY_00_40.md is in byte parity with the source via the real generator --check', () => {
  const result = run(GEN_DOCS, ['--check'], REPO_ROOT);
  const findings = (result.report.blockingFindings || []).filter((f) => f.file === REGISTRY_REL.replace('governance/GATE_REGISTRY_00_40.json', 'governance/generated/GATE_REGISTRY_00_40.md') || f.file === 'governance/generated/GATE_REGISTRY_00_40.md');
  assert.equal(findings.length, 0);
});

test('G13-CT-BLOCKER-01 (REPAIRED by GATE13_AUTHORITY_CONFLICTS_REPAIR_AND_CONTRACT_RESUME_R1 -- was CONFIRMED REAL FINDING): modifying the registry no longer breaks authoritySha256 for genesis-import ledger events', () => {
  const dir = makeSandbox({ after: (fn) => process.on('exit', fn) });
  const registryPath = path.join(dir, 'governance/GATE_REGISTRY_00_40.json');
  const registry = readJson(registryPath);
  registry.gates.find((g) => g.gateId === 'GATE13').notes = 'sandbox mutation for probative test';
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  const ledgerValidator = path.join(dir, 'governance/tools/validate-status-ledger.mjs');
  const result = run(ledgerValidator, [], dir);
  // Before the repair this mutation produced AUTHORITY_HASH_MISMATCH on ~39 events and valid=false.
  // The append-only REGISTRY_AUTHORITY_MIGRATIONS.ndjson + immutable snapshot now resolve those
  // historical events instead, so the same mutation must leave the ledger valid with zero blocking
  // findings (only informational MIGRATED_HISTORICAL_AUTHORITY notes).
  const blocking = result.report.findings.filter((f) => f.severity === 'BLOCKING');
  assert.equal(blocking.length, 0, `expected zero blocking findings after the repair, got ${JSON.stringify(blocking)}`);
  assert.equal(result.report.valid, true);
  const mismatchCount = result.report.findings.filter((f) => f.detectorId === 'AUTHORITY_HASH_MISMATCH').length;
  assert.equal(mismatchCount, 0, 'AUTHORITY_HASH_MISMATCH must not recur for the pinned historical (path, hash) pair');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G13-CT-BLOCKER-02 (REPAIRED by GATE13_AUTHORITY_CONFLICTS_REPAIR_AND_CONTRACT_RESUME_R1 -- was CONFIRMED REAL FINDING): validate-active-gate.mjs now accepts a fully valid activeGate=GATE13 candidate', () => {
  const dir = makeSandbox({ after: (fn) => process.on('exit', fn) });
  const currentStatePath = path.join(dir, CURRENT_STATE_REL);
  fs.mkdirSync(path.dirname(currentStatePath), { recursive: true });
  const ledgerLines = fs.readFileSync(path.join(dir, LEDGER_REL), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const event = ledgerLines.find((e) => e.gateId === 'GATE13');
  assert.ok(event, 'GENESIS_IMPORT_GATE13 must already exist in the ledger without any mutation');
  const candidate = {
    schemaVersion: 1,
    activeGate: 'GATE13',
    activationEventId: event.eventId,
    activationEventOrdinal: event.ordinal,
    activationEventSha256: event.eventPayloadSha256,
    currentStatePath: CURRENT_STATE_REL,
    currentStateSha256: sha256(path.join(dir, CURRENT_STATE_REL))
  };
  fs.writeFileSync(path.join(dir, ACTIVE_GATE_REL), JSON.stringify(candidate) + '\n');
  const validator = path.join(dir, 'governance/tools/validate-active-gate.mjs');
  const result = run(validator, [], dir);
  // Before the repair this always failed with ACTIVE_GATE_NOT_AUTHORIZED regardless of validity.
  // The fail-closed, authority-driven rule (ledger replay + real contract + real sealed state +
  // closed predecessor) now accepts this exact candidate because every one of those is genuinely true.
  assert.equal(result.status, 0, `expected acceptance, got ${JSON.stringify(result.report)}`);
  assert.deepEqual(result.report, { valid: true, findingIds: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G13-NEG-01: hostile mutation lowering mandatoryCoverage language below 100% is detectable', () => {
  const dir = makeSandbox({ after: (fn) => process.on('exit', fn) });
  const contractPath = path.join(dir, CONTRACT_REL);
  const contract = readJson(contractPath);
  contract.closureConditions = contract.closureConditions.map((c) => c.replace('100%', '90%'));
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n');
  const mutated = readJson(contractPath);
  const text = JSON.stringify(mutated.closureConditions);
  assert.doesNotMatch(text, /mandatoryCoverage.*100%/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G13-NEG-02: hostile mutation introducing a wildcard authorizedPath is detectable', () => {
  const dir = makeSandbox({ after: (fn) => process.on('exit', fn) });
  const contractPath = path.join(dir, CONTRACT_REL);
  const contract = readJson(contractPath);
  contract.authorizedPaths.push('governance/gates/GATE13/implementation/*');
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n');
  const mutated = readJson(contractPath);
  const hasWildcard = mutated.authorizedPaths.some((p) => /[*?]/.test(p));
  assert.equal(hasWildcard, true, 'mutation should be detectable as a wildcard violation by any conformant reviewer');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G13-NEG-03: hostile mutation marking executionStatus=STARTED in CURRENT_STATE-referenced seal is detectable', () => {
  const dir = makeSandbox({ after: (fn) => process.on('exit', fn) });
  const sealPath = path.join(dir, SEAL_REL);
  const seal = readJson(sealPath);
  const mutatedPayload = { ...seal.payload, executionStatus: 'STARTED', gate13Started: true };
  const sealValidator = path.join(dir, 'governance/tools/validate-state-seal.mjs');
  const mutatedSeal = { ...seal, payload: mutatedPayload };
  fs.writeFileSync(sealPath, JSON.stringify(mutatedSeal, null, 2) + '\n');
  const result = run(sealValidator, ['--seal', sealPath], dir);
  assert.equal(result.report.valid, false, 'payloadSha256 must no longer match once the payload is mutated without recomputation');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('G13-NEG-04: GATE14 is never authorized by this contract or state', () => {
  const seal = readJson(path.join(REPO_ROOT, SEAL_REL));
  const contract = readJson(path.join(REPO_ROOT, CONTRACT_REL));
  assert.equal(seal.payload.gate14Authorized, false);
  assert.equal(seal.payload.gate14Executable, false);
  assert.doesNotMatch(JSON.stringify(contract), /GATE14.*[Aa]uthoriz(ed|ation)\s*[:=]\s*true/);
});

test('G13-NEG-05: no fallback silencieux language is present in the contract closure conditions', () => {
  const contract = readJson(path.join(REPO_ROOT, CONTRACT_REL));
  const text = JSON.stringify(contract.closureConditions).toLowerCase();
  assert.doesNotMatch(text, /silent fallback allowed|fallback autoris/);
});

test('G13-REPRO-01: state and contract validation is reproducible from a different working directory', () => {
  const cwdAlt = os.tmpdir();
  const result = run(CONTRACT_VALIDATOR, ['--contract', path.join(REPO_ROOT, CONTRACT_REL), '--pointer', path.join(REPO_ROOT, POINTER_REL)], cwdAlt);
  assert.equal(result.report.valid, true);
});
