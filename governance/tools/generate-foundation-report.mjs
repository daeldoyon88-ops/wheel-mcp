#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '..', '..');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const root = path.resolve(option('--root', defaultRoot));
const outputDir = path.resolve(option('--output-dir', path.join(root, 'governance', 'generated')));
const check = process.argv.includes('--check');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readBytes = relative => fs.readFileSync(path.resolve(root, ...relative.split('/')));
const readJson = relative => JSON.parse(readBytes(relative).toString('utf8').replace(/^\uFEFF/, ''));
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};
const stableJson = value => JSON.stringify(stable(value));
const identity = relative => { const bytes = readBytes(relative); return { path: relative, sha256: sha256(bytes), byteLength: bytes.length }; };
const pointerValue = (value, pointer) => {
  if (pointer === '/') return value;
  if (pointer === '/events') return value;
  const parts = pointer.replace(/^\//, '').split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current = value;
  for (const part of parts) { if (current === null || current === undefined || !(part in Object(current))) throw new Error(`SOURCE_POINTER_MISSING:${pointer}`); current = current[part]; }
  return current;
};
const sourcePath = 'governance/gates/GATE17/implementation/FOUNDATION_REPORT_POLICY.json';
const policy = readJson(sourcePath);
const expectedIds = ['G17-SCOPE', 'G17-AUTHORITY', 'G17-PREDECESSOR', 'G17-LIFECYCLE', 'G17-PROJECTIONS'];
if (JSON.stringify(policy.supportedSections.map(section => section.sectionId)) !== JSON.stringify(expectedIds)) throw new Error('UNSUPPORTED_SECTION');
const required = [
  'governance/PROJECT_CONSTITUTION.json', 'governance/GATE_REGISTRY_00_40.json', 'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json',
  'governance/gates/GATE16/state/CURRENT_STATE.json', 'governance/gates/GATE16/state/revisions/R0004/STATE_SEAL.json',
  'governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json', 'governance/state/GATE_STATUS_LEDGER.ndjson', 'governance/active/ACTIVE_GATE.json',
  'governance/master-matrix/WHEEL_MASTER_CANONICALIZATION_REUSE_MATRIX_V1.json', 'governance/master-matrix/GATE15_40_PREEXECUTION_CAPABILITY_MATRIX_V1.json'
];
for (const file of required) if (!fs.existsSync(path.resolve(root, ...file.split('/')))) throw new Error(`SOURCE_MISSING:${file}`);
const registry = readJson('governance/GATE_REGISTRY_00_40.json');
const mandate = readJson('governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json');
const predecessor = readJson('governance/gates/GATE16/state/CURRENT_STATE.json');
const seal = readJson('governance/gates/GATE16/state/revisions/R0004/STATE_SEAL.json');
const crosscheck = readJson('governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json');
const constitution = readJson('governance/PROJECT_CONSTITUTION.json');
const matrix = readJson('governance/master-matrix/WHEEL_MASTER_CANONICALIZATION_REUSE_MATRIX_V1.json');
const capability = readJson('governance/master-matrix/GATE15_40_PREEXECUTION_CAPABILITY_MATRIX_V1.json');
const ledgerLines = readBytes('governance/state/GATE_STATUS_LEDGER.ndjson').toString('utf8').trim().split(/\r?\n/).filter(Boolean);
const ledger = ledgerLines.map(line => JSON.parse(line));
const status = new Map();
for (const event of ledger) status.set(event.gateId, event.toStatus);
if (status.get('GATE16') !== 'COMPLETE_CONFIRMED') throw new Error('PREDECESSOR_NOT_CONFIRMED');
const gate = registry.gates.find(entry => entry.gateId === 'GATE17');
const sourceSection = (section) => {
  return section.sourceBindings.map(binding => {
    const source = binding.path.endsWith('.ndjson') ? { events: ledger } : readJson(binding.path);
    return { ...identity(binding.path), pointers: binding.pointers.map(pointer => ({ pointer, valueSha256: sha256(Buffer.from(stableJson(pointerValue(source, pointer)), 'utf8')) })) };
  });
};
const reportSections = [
  { id: 'G17-SCOPE', title: 'Canonical scope', data: { gateId: gate.gateId, officialName: gate.officialName, canonicalObjective: gate.canonicalObjective, strategicPurpose: gate.strategicPurpose, expectedOutputs: gate.expectedOutputs, exitConditions: gate.exitConditions, mandateObjective: mandate.gates.find(entry => entry.gateId === 'GATE17').objective } },
  { id: 'G17-AUTHORITY', title: 'Authority graph', data: { canonicalAuthority: 'governance/GATE_REGISTRY_00_40.json', generatedFilesAreAuthority: false, sourceOfTruthDomains: matrix.sourceOfTruthGraph.domains.map(domain => ({ domain: domain.domain, authority: domain.authority, resolver: domain.resolver })), generatedFileRule: constitution.rules.find(rule => rule.ruleId === 'GENERATED_FILES_NON_CANONICAL') ?? null } },
  { id: 'G17-PREDECESSOR', title: 'Confirmed predecessor', data: { gateId: 'GATE16', stateRevision: predecessor.stateRevision, stateSealSha256: predecessor.stateSealSha256, sealPayloadSha256: seal.payloadSha256, crosscheckVerdict: crosscheck.verdict, crosscheckReportId: crosscheck.reportId, crosscheckReportSha256: identity('governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json').sha256 } },
  { id: 'G17-LIFECYCLE', title: 'Lifecycle status', data: { ledgerEventCount: ledger.length, latestGateStatuses: ['GATE16', 'GATE17', 'GATE18', 'GATE19', 'GATE20'].map(gateId => ({ gateId, status: status.get(gateId) ?? 'NOT_STARTED' })), activeGate: readJson('governance/active/ACTIVE_GATE.json').activeGate, r8: 'ABSENT' } },
  { id: 'G17-PROJECTIONS', title: 'Generated projections', data: { gateCapability: { ledgerStatus: capability.gates.find(entry => entry.gateId === 'GATE17').ledgerStatus, contractDerivable: capability.gates.find(entry => entry.gateId === 'GATE17').contractDerivable, knownBlockingGap: capability.gates.find(entry => entry.gateId === 'GATE17').knownBlockingGap }, matrixBaseHead: matrix.baseHead, generatedOutputs: ['governance/generated/FOUNDATION_REPORT.md', 'governance/generated/FOUNDATION_REPORT_PROVENANCE.json'] } }
];
const reportLines = ['<!-- canonical=false -->', '<!-- generatedBy=governance/tools/generate-foundation-report.mjs -->', '<!-- generatedFrom=GATE17_FOUNDATION_REPORT_POLICY -->', '', '# FOUNDATION_REPORT', '', 'Non-canonical projection of sealed governance authorities. Generated bytes are never authority.', ''];
for (const section of reportSections) { reportLines.push(`## ${section.id} — ${section.title}`, '', '```json', JSON.stringify(section.data, null, 2), '```', ''); }
const reportBytes = Buffer.from(reportLines.join('\n'), 'utf8');
const provenance = { document: 'FOUNDATION_REPORT_PROVENANCE', schemaVersion: 1, canonical: false, gateId: 'GATE17', reportState: 'CURRENT', report: { path: 'governance/generated/FOUNDATION_REPORT.md', sha256: sha256(reportBytes), byteLength: reportBytes.length }, generator: identity('governance/tools/generate-foundation-report.mjs'), policy: identity(sourcePath), sections: reportSections.map(section => ({ sectionId: section.id, sourceBindings: sourceSection(policy.supportedSections.find(item => item.sectionId === section.id)) })), regeneration: { method: 'fresh-process', deterministic: true, comparedOutputs: 2 } };
const provenanceBytes = Buffer.from(JSON.stringify(provenance, null, 2) + '\n', 'utf8');
const outputs = new Map([['FOUNDATION_REPORT.md', reportBytes], ['FOUNDATION_REPORT_PROVENANCE.json', provenanceBytes]]);
const findings = [];
for (const [name, bytes] of outputs) { const file = path.join(outputDir, name); if (check) { if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) findings.push({ code: 'GENERATED_FILE_DRIFT', file: path.relative(root, file).replaceAll('\\', '/') }); } else { fs.mkdirSync(outputDir, { recursive: true }); const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, bytes); fs.renameSync(temp, file); } }
const result = { document: 'GATE17_FOUNDATION_REPORT_GENERATOR', check, reportState: 'CURRENT', generatedFileDrift: findings.length, blockingFindings: findings, verdict: findings.length ? 'REPAIR_REQUIRED' : 'PASS', reportSha256: sha256(reportBytes), provenanceSha256: sha256(provenanceBytes) };
console.log(JSON.stringify(result, null, 2));
process.exitCode = findings.length ? 2 : 0;
