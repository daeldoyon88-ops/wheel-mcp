import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../../..');
const validator = path.join(repoRoot, 'governance/gates/GATE13/implementation/oracle-coverage-validator.mjs');
const fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), 'gate13-oracle-coverage-'));
const fixtures = [];

function fixture(name) {
  const dir = path.join(fixtureBase, name);
  fs.cpSync(path.join(repoRoot, 'governance'), path.join(dir, 'governance'), { recursive: true, dereference: true });
  fixtures.push(dir);
  return dir;
}

function json(dir, relative) {
  return JSON.parse(fs.readFileSync(path.join(dir, relative), 'utf8'));
}

function writeJson(dir, relative, value) {
  fs.writeFileSync(path.join(dir, relative), `${JSON.stringify(value, null, 2)}\n`);
}

function run(dir, args = [], cwd = dir) {
  try {
    const out = execFileSync(process.execPath, [validator, '--root', dir, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, report: JSON.parse(out) };
  } catch (error) {
    return { code: error.status ?? 1, report: JSON.parse(error.stdout || '{}') };
  }
}

after(() => fs.rmSync(fixtureBase, { recursive: true, force: true }));

test('G13-POS-01: real canonical inputs produce a passing fail-closed calculation', () => {
  const dir = fixture('pos-real');
  const result = run(dir, ['--write']);
  assert.equal(result.code, 0);
  assert.equal(result.report.valid, true);
  assert.equal(result.report.verdict, 'GATE13_ORACLE_COVERAGE_PASS');
  assert.equal(result.report.mandatoryCoverage, 100);
});

test('G13-POS-02: all mandatory coverage items and oracle statuses are explicitly satisfied', () => {
  const dir = fixture('pos-counts');
  const result = run(dir, ['--write']);
  assert.deepEqual(result.report.counts, { totalApplicable: 12, totalMandatory: 12, satisfied: 12, missingMandatory: 0, invalidMandatory: 0, staleMandatory: 0, contradictoryMandatory: 0, unresolvedMandatory: 0 });
});

test('G13-POS-03: execution is reproducible from an unrelated working directory', () => {
  const dir = fixture('pos-cwd');
  const result = run(dir, ['--write'], os.tmpdir());
  assert.equal(result.code, 0);
  assert.equal(result.report.valid, true);
});

test('G13-POS-04: matrix, report and replay evidence are emitted from the same calculation', () => {
  const dir = fixture('pos-evidence');
  const result = run(dir, ['--write']);
  assert.equal(result.code, 0);
  const matrix = json(dir, 'governance/gates/GATE13/implementation/ORACLE_COVERAGE_MATRIX.json');
  const report = json(dir, 'governance/gates/GATE13/implementation/COVERAGE_REPORT.json');
  const evidence = json(dir, 'governance/gates/GATE13/implementation/REPLAY_AND_PROVENANCE_EVIDENCE.json');
  assert.equal(matrix.verdict, result.report.verdict);
  assert.equal(report.verdict, result.report.verdict);
  assert.equal(evidence.mandatoryCoverage, 100);
  assert.equal(evidence.counts.satisfied, 12);
});

test('G13-POS-05: generated context is visible but cannot satisfy a mandatory item', () => {
  const dir = fixture('pos-generated');
  const matrix = path.join(dir, 'governance/gates/GATE13/implementation/ORACLE_COVERAGE_MATRIX.json');
  const result = run(dir, ['--write']);
  assert.equal(result.code, 0);
  const generated = json(dir, 'governance/gates/GATE13/implementation/ORACLE_COVERAGE_MATRIX.json').oracleStatuses.find((item) => item.oracleId === 'G13-O-013');
  assert.equal(generated.authorityClass, 'GENERATED_NON_CANONICAL');
  assert.ok(fs.existsSync(matrix));
  assert.equal(result.report.counts.satisfied, result.report.counts.totalMandatory);
});

test('G13-POS-06: a second replay is byte-stable', () => {
  const dir = fixture('pos-deterministic');
  run(dir, ['--write']);
  const first = fs.readFileSync(path.join(dir, 'governance/gates/GATE13/implementation/ORACLE_COVERAGE_MATRIX.json'));
  run(dir, ['--write']);
  const second = fs.readFileSync(path.join(dir, 'governance/gates/GATE13/implementation/ORACLE_COVERAGE_MATRIX.json'));
  assert.deepEqual(second, first);
});

test('G13-NEG-01: missing mandatory source blocks coverage', () => {
  const dir = fixture('neg-missing');
  fs.rmSync(path.join(dir, 'governance/PROJECT_CONSTITUTION.json'));
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.equal(result.report.valid, false);
  assert.ok(result.report.counts.missingMandatory > 0);
});

test('G13-NEG-02: stale source hash blocks coverage', () => {
  const dir = fixture('neg-stale');
  const registry = json(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json');
  registry.oracles.find((item) => item.oracleId === 'G13-O-002').expectedSha256 = '0'.repeat(64);
  writeJson(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json', registry);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.counts.staleMandatory > 0);
});

test('G13-NEG-03: duplicate oracle ID is detected', () => {
  const dir = fixture('neg-duplicate-oracle');
  const registry = json(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json');
  registry.oracles[1].oracleId = registry.oracles[0].oracleId;
  writeJson(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json', registry);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-04: orphan oracle reference is detected', () => {
  const dir = fixture('neg-orphan');
  const coverage = json(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json');
  coverage.coverageItems[0].requiredOracleIds.push('G13-O-999');
  writeJson(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json', coverage);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.counts.unresolvedMandatory > 0);
});

test('G13-NEG-05: cyclic coverage dependency is detected', () => {
  const dir = fixture('neg-cycle');
  const coverage = json(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json');
  coverage.coverageItems[0].dependsOnCoverageItemIds = ['G13-C-012'];
  coverage.coverageItems[11].dependsOnCoverageItemIds = ['G13-C-001'];
  writeJson(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json', coverage);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-06: silent fallback on a mandatory oracle is detected', () => {
  const dir = fixture('neg-fallback');
  const registry = json(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json');
  registry.oracles[0].fallbackPolicy = 'SILENT_SYNTHETIC_FALLBACK';
  writeJson(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json', registry);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-07: generated oracle marked mandatory is rejected', () => {
  const dir = fixture('neg-generated-mandatory');
  const registry = json(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json');
  registry.oracles.find((item) => item.oracleId === 'G13-O-013').required = true;
  writeJson(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json', registry);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-08: unsafe traversal path is rejected', () => {
  const dir = fixture('neg-path');
  const registry = json(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json');
  registry.oracles[0].path = '../PROJECT_CONSTITUTION.json';
  writeJson(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json', registry);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-09: contradictory pins for one source path are rejected', () => {
  const dir = fixture('neg-contradiction');
  const registry = json(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json');
  registry.oracles.push({ ...registry.oracles[1], oracleId: 'G13-O-099', expectedSha256: 'f'.repeat(64) });
  writeJson(dir, 'governance/gates/GATE13/implementation/ORACLE_REGISTRY.json', registry);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-10: a preproduced PASS report cannot mask a stale source', () => {
  const dir = fixture('neg-summary-only');
  run(dir, ['--write']);
  const reportPath = path.join(dir, 'governance/gates/GATE13/implementation/COVERAGE_REPORT.json');
  const report = json(dir, 'governance/gates/GATE13/implementation/COVERAGE_REPORT.json');
  fs.rmSync(path.join(dir, 'governance/PROJECT_CONSTITUTION.json'));
  report.verdict = 'GATE13_ORACLE_COVERAGE_PASS';
  writeJson(dir, 'governance/gates/GATE13/implementation/COVERAGE_REPORT.json', report);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.equal(result.report.valid, false);
  assert.ok(fs.existsSync(reportPath));
});

test('G13-NEG-11: GATE14 active pointer mutation is not accepted', () => {
  const dir = fixture('neg-gate14');
  const active = json(dir, 'governance/active/ACTIVE_GATE.json');
  active.activeGate = 'GATE14';
  writeJson(dir, 'governance/active/ACTIVE_GATE.json', active);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.counts.staleMandatory > 0);
});

test('G13-NEG-12: malformed canonical source is detected as stale or invalid', () => {
  const dir = fixture('neg-invalid');
  fs.writeFileSync(path.join(dir, 'governance/GATE_REGISTRY_00_40.json'), '{not-json}\n');
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.counts.staleMandatory + result.report.counts.invalidMandatory > 0);
});

test('G13-NEG-13: mandatory coverage cannot be removed by changing applicability to OPTIONAL', () => {
  const dir = fixture('neg-denominator');
  const coverage = json(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json');
  coverage.coverageItems[0].applicability = 'OPTIONAL';
  writeJson(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json', coverage);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.equal(result.report.valid, false);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-14: invalid mandatory fail-closed declaration is rejected', () => {
  const dir = fixture('neg-not-fail-closed');
  const coverage = json(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json');
  coverage.coverageItems[0].failClosed = false;
  writeJson(dir, 'governance/gates/GATE13/implementation/COVERAGE_REQUIREMENTS_REGISTRY.json', coverage);
  const result = run(dir);
  assert.equal(result.code, 2);
  assert.ok(result.report.findingCount > 0);
});

test('G13-NEG-15: future gate authorization is not inferred from coverage PASS', () => {
  const dir = fixture('neg-gate14-implicit');
  const result = run(dir, ['--write']);
  assert.equal(result.code, 0);
  const mandate = json(dir, 'governance/sources/GATE13_CANONICAL_MANDATE_AND_EXECUTION_AUTHORITY_R1.json');
  assert.equal(mandate.gate14Authorized, false);
  assert.equal(mandate.gate14Executable, false);
});
