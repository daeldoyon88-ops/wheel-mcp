import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from './canonical-json.mjs';

const root = process.cwd();
const report = { document: 'I1_GATE_REGISTRY_VALIDATION', blockingFindings: [], counters: {} };
const fail = (code, pointer, detail) => report.blockingFindings.push({ code, pointer, detail });
let registry;
try { registry = JSON.parse(fs.readFileSync(path.join(root, 'governance/GATE_REGISTRY_00_40.json'), 'utf8')); }
catch (error) { fail('JSON_INVALID', '/', error.message); }
if (registry) {
  const gates = Array.isArray(registry.gates) ? registry.gates : [];
  const ids = gates.map((gate) => gate.gateId);
  report.counters.registryEntryCount = gates.length;
  report.counters.duplicateGateIdCount = ids.length - new Set(ids).size;
  report.counters.missingGateCount = 41 - new Set(ids).size;
  report.counters.outOfRangeGateCount = gates.filter((gate) => !/^GATE[0-4][0-9]$/.test(gate.gateId)).length;
  report.counters.operationalFieldCount = gates.reduce((n, gate) => n + ['currentStatus', 'status', 'stateRevision', 'contractRevision', 'openDefects', 'resumePoint', 'activeGate'].filter((key) => Object.hasOwn(gate, key)).length, 0);
  const shapes = gates.map((gate) => Object.keys(gate).sort().join('|'));
  report.counters.nonUniformGateEntryCount = new Set(shapes).size === 1 ? 0 : 1;
  report.counters.unknownReferenceCount = gates.reduce((n, gate) => n + [...(gate.dependencies || []), ...(gate.nextGate ? [gate.nextGate] : [])].filter((ref) => !ids.includes(ref)).length, 0);
  report.counters.dependencyCycleCount = 0;
  const visiting = new Set(), visited = new Set(), byId = new Map(gates.map((gate) => [gate.gateId, gate]));
  const visit = (id) => {
    if (visiting.has(id)) { report.counters.dependencyCycleCount += 1; return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies || []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  const source = path.join(root, 'governance/sources/WHEEL_JARVISE_MASTER_ROADMAP_00_40.txt');
  const sourceSha = sha256Bytes(fs.readFileSync(source));
  if (registry.registryEntryCount !== 41 || gates.length !== 41) fail('RANGE_GAP', '/gates', 'exactly 41 gates required');
  if (registry.declaredGateRange?.sourceSha256 !== sourceSha) fail('SOURCE_HASH_MISMATCH', '/declaredGateRange/sourceSha256', 'roadmap hash mismatch');
  if (report.counters.duplicateGateIdCount) fail('DUPLICATE_GATE_ID', '/gates', 'gateId must be unique');
  if (report.counters.outOfRangeGateCount) fail('OUT_OF_RANGE_GATE', '/gates', 'gateId must be GATE00..GATE40');
  if (report.counters.operationalFieldCount) fail('OPERATIONAL_FIELD_IN_REGISTRY', '/gates', 'strategic registry cannot contain operational status');
  if (report.counters.nonUniformGateEntryCount) fail('NON_UNIFORM_GATE_ENTRY', '/gates', 'all gate entries must use the same 18 keys');
  if (report.counters.unknownReferenceCount) fail('UNKNOWN_GATE_REFERENCE', '/gates', 'dependencies and nextGate must resolve');
  if (report.counters.dependencyCycleCount) fail('DEPENDENCY_CYCLE', '/gates', 'dependency graph must be acyclic');
  for (const [index, gate] of gates.entries()) {
    if (gate.gateId !== 'GATE' + String(index).padStart(2, '0')) fail('RANGE_GAP', '/gates/' + index + '/gateId', 'ordered coverage required');
    if (gate.definitionCompleteness !== 'EXPLICIT_COMPLETE' && (!Array.isArray(gate.missingCanonicalFields) || !gate.missingCanonicalFields.length)) fail('MISSING_CANONICAL_FIELD_DISCLOSURE', '/gates/' + index, 'incomplete gate must disclose missing fields');
    if (gate.definitionCompleteness === 'EXPLICIT_COMPLETE' && (gate.missingCanonicalFields || []).length) fail('GATE_DEFINITION_COMPLETENESS_MISREPRESENTED', '/gates/' + index + '/definitionCompleteness', 'complete gate cannot disclose missing canonical fields');
    for (const key of gate.missingCanonicalFields || []) if (gate[key] !== null) fail('MISSING_FIELD_NOT_NULL', '/gates/' + index + '/' + key, 'missing field must be null');
  }
}
report.blockingTotal = report.blockingFindings.length;
report.verdict = report.blockingTotal === 0 ? 'PASS' : 'REPAIR_REQUIRED';
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.blockingTotal ? 2 : 0;
