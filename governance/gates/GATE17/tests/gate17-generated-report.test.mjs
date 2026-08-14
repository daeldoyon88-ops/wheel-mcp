import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GENERATOR = path.join(ROOT, 'governance', 'tools', 'generate-foundation-report.mjs');
const INPUTS = ['governance/PROJECT_CONSTITUTION.json', 'governance/GATE_REGISTRY_00_40.json', 'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json', 'governance/gates/GATE16/state/CURRENT_STATE.json', 'governance/gates/GATE16/state/revisions/R0004/STATE_SEAL.json', 'governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json', 'governance/state/GATE_STATUS_LEDGER.ndjson', 'governance/active/ACTIVE_GATE.json', 'governance/master-matrix/WHEEL_MASTER_CANONICALIZATION_REUSE_MATRIX_V1.json', 'governance/master-matrix/GATE15_40_PREEXECUTION_CAPABILITY_MATRIX_V1.json', 'governance/gates/GATE17/implementation/FOUNDATION_REPORT_POLICY.json', 'governance/tools/generate-foundation-report.mjs'];
const copyFixture = () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate17-report-'));
  for (const relative of INPUTS) { const destination = path.join(temp, ...relative.split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(ROOT, ...relative.split('/')), destination); }
  return temp;
};
const run = (root, outputDir, ...args) => spawnSync(process.execPath, [path.join(root, 'governance', 'tools', 'generate-foundation-report.mjs'), '--root', root, '--output-dir', outputDir, ...args], { encoding: 'utf8' });
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const outputs = dir => [path.join(dir, 'FOUNDATION_REPORT.md'), path.join(dir, 'FOUNDATION_REPORT_PROVENANCE.json')];

test('G17-POS-01: generator emits the declared non-canonical report and provenance', () => {
  const root = copyFixture(); const out = path.join(root, 'out'); const result = run(root, out); assert.equal(result.status, 0, result.stderr); const [report, provenance] = outputs(out); assert.match(fs.readFileSync(report, 'utf8'), /canonical=false/); const p = JSON.parse(fs.readFileSync(provenance, 'utf8')); assert.equal(p.reportState, 'CURRENT'); assert.equal(p.sections.length, 5); assert.equal(p.report.sha256, digest(report));
});

test('G17-POS-02: every supported section has source identities and pointer bindings', () => {
  const root = copyFixture(); const out = path.join(root, 'out'); assert.equal(run(root, out).status, 0); const p = JSON.parse(fs.readFileSync(path.join(out, 'FOUNDATION_REPORT_PROVENANCE.json'), 'utf8')); assert.deepEqual(p.sections.map(s => s.sectionId), ['G17-SCOPE', 'G17-AUTHORITY', 'G17-PREDECESSOR', 'G17-LIFECYCLE', 'G17-PROJECTIONS']); for (const section of p.sections) for (const source of section.sourceBindings) { assert.match(source.sha256, /^[0-9a-f]{64}$/); assert.ok(source.byteLength > 0); assert.ok(source.pointers.length > 0); }
});

test('G17-POS-03: two independent fresh-process regenerations are byte-identical', () => {
  const root = copyFixture(); const a = path.join(root, 'out-a'); const b = path.join(root, 'out-b'); assert.equal(run(root, a).status, 0); assert.equal(run(root, b).status, 0); for (const name of ['FOUNDATION_REPORT.md', 'FOUNDATION_REPORT_PROVENANCE.json']) assert.deepEqual(fs.readFileSync(path.join(a, name)), fs.readFileSync(path.join(b, name)));
});

test('G17-POS-04: canonical outputs pass the generator drift check', () => { const result = run(ROOT, path.join(ROOT, 'governance', 'generated'), '--check'); assert.equal(result.status, 0, result.stdout + result.stderr); });

test('G17-NEG-01: absent canonical source blocks generation', () => { const root = copyFixture(); fs.rmSync(path.join(root, 'governance', 'gates', 'GATE16', 'evidence', 'CROSSCHECK_REPORT.json')); const result = run(root, path.join(root, 'out')); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /SOURCE_MISSING/); });

test('G17-NEG-02: manual report edit is detected as generated-file drift', () => { const root = copyFixture(); const out = path.join(root, 'out'); assert.equal(run(root, out).status, 0); fs.appendFileSync(path.join(out, 'FOUNDATION_REPORT.md'), '\nmanual injection\n'); const result = run(root, out, '--check'); assert.equal(result.status, 2); assert.match(result.stdout, /GENERATED_FILE_DRIFT/); });

test('G17-NEG-03: provenance edit is detected as generated-file drift', () => { const root = copyFixture(); const out = path.join(root, 'out'); assert.equal(run(root, out).status, 0); const file = path.join(out, 'FOUNDATION_REPORT_PROVENANCE.json'); fs.appendFileSync(file, 'manual injection\n'); const result = run(root, out, '--check'); assert.equal(result.status, 2); assert.match(result.stdout, /GENERATED_FILE_DRIFT/); });

test('G17-NEG-04: unsupported policy section is rejected', () => { const root = copyFixture(); const policy = path.join(root, 'governance', 'gates', 'GATE17', 'implementation', 'FOUNDATION_REPORT_POLICY.json'); const value = JSON.parse(fs.readFileSync(policy, 'utf8')); value.supportedSections.push({ sectionId: 'UNSUPPORTED', title: 'unsupported', sourceBindings: [] }); fs.writeFileSync(policy, JSON.stringify(value, null, 2)); const result = run(root, path.join(root, 'out')); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /UNSUPPORTED_SECTION/); });

test('G17-NEG-05: stale predecessor status is rejected', () => { const root = copyFixture(); const ledger = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'); const lines = fs.readFileSync(ledger, 'utf8').trim().split(/\r?\n/).map(JSON.parse); lines.push({ gateId: 'GATE16', toStatus: 'IN_PROGRESS' }); fs.writeFileSync(ledger, lines.map(JSON.stringify).join('\n') + '\n'); const result = run(root, path.join(root, 'out')); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /PREDECESSOR_NOT_CONFIRMED/); });

test('G17-CT-01: source mutation changes both report and provenance identities', () => { const root = copyFixture(); const a = path.join(root, 'a'); assert.equal(run(root, a).status, 0); const registry = path.join(root, 'governance', 'GATE_REGISTRY_00_40.json'); const value = JSON.parse(fs.readFileSync(registry, 'utf8')); value.gates.find(g => g.gateId === 'GATE17').strategicPurpose += ' mutated'; fs.writeFileSync(registry, JSON.stringify(value, null, 2)); const b = path.join(root, 'b'); assert.equal(run(root, b).status, 0); assert.notDeepEqual(fs.readFileSync(path.join(a, 'FOUNDATION_REPORT.md')), fs.readFileSync(path.join(b, 'FOUNDATION_REPORT.md'))); assert.notEqual(JSON.parse(fs.readFileSync(path.join(a, 'FOUNDATION_REPORT_PROVENANCE.json'))).sections[0].sourceBindings[0].sha256, JSON.parse(fs.readFileSync(path.join(b, 'FOUNDATION_REPORT_PROVENANCE.json'))).sections[0].sourceBindings[0].sha256); });

test('G17-CT-02: report has exactly the five policy-supported headings', () => { const root = copyFixture(); const out = path.join(root, 'out'); assert.equal(run(root, out).status, 0); const report = fs.readFileSync(path.join(out, 'FOUNDATION_REPORT.md'), 'utf8'); assert.deepEqual([...report.matchAll(/^## (G17-[A-Z-]+)/gm)].map(match => match[1]), ['G17-SCOPE', 'G17-AUTHORITY', 'G17-PREDECESSOR', 'G17-LIFECYCLE', 'G17-PROJECTIONS']); });
