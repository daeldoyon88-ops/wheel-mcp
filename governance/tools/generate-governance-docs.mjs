import fs from 'node:fs';
import { sha256Canonical } from './canonical-json.mjs';

const generatedAt = '2026-08-01T16:00:00.000Z';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const registry = read('governance/GATE_REGISTRY_00_40.json');
const constitution = read('governance/PROJECT_CONSTITUTION.json');
const routing = read('governance/MODEL_ROUTING_POLICY.json');
const header = (source, object) => '<!-- canonical=false -->\n<!-- generatedBy=governance/tools/generate-governance-docs.mjs -->\n<!-- generatedFrom=' + source + ' -->\n<!-- generatedAt=' + generatedAt + ' -->\n<!-- sourceDigest=' + sha256Canonical(object) + ' -->\n\n';
const docs = {
  'governance/generated/GATE_REGISTRY_00_40.md': header('governance/GATE_REGISTRY_00_40.json', registry) + '# GATE_REGISTRY_00_40\n\nNon-canonique : vue générée depuis GATE_REGISTRY_00_40.json.\n\n| Gate | Nom officiel | Complétude |\n| --- | --- | --- |\n' + registry.gates.map((gate) => '| ' + gate.gateId + ' | ' + gate.officialName + ' | ' + gate.definitionCompleteness + ' |').join('\n') + '\n',
  'governance/generated/PROJECT_CONSTITUTION.md': header('governance/PROJECT_CONSTITUTION.json', constitution) + '# PROJECT_CONSTITUTION\n\nNon-canonique : vue générée depuis PROJECT_CONSTITUTION.json.\n\n' + constitution.rules.map((rule) => '- ' + rule.ruleId + ' — ' + rule.severity + ' — ' + rule.name).join('\n') + '\n',
  'governance/generated/MODEL_ROUTING_POLICY.md': header('governance/MODEL_ROUTING_POLICY.json', routing) + '# MODEL_ROUTING_POLICY\n\nNon-canonique : vue générée depuis MODEL_ROUTING_POLICY.json.\n\n| Profil | workClass | executionMode | reasoning |\n| --- | --- | --- | --- |\n' + routing.profiles.map((profile) => '| ' + profile.profileId + ' | ' + profile.workClass + ' | ' + profile.executionMode + ' | ' + profile.recommendedReasoningDepth + ' |').join('\n') + '\n'
};
const check = process.argv.includes('--check');
const findings = [];
for (const [file, content] of Object.entries(docs)) {
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) findings.push({ code: 'GENERATED_FILE_DRIFT', file });
  } else {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, content, 'utf8');
    fs.renameSync(temp, file);
  }
}
const report = { document: 'I1_GENERATED_DOCUMENT_VALIDATION', check, blockingFindings: findings, blockingTotal: findings.length, verdict: findings.length ? 'REPAIR_REQUIRED' : 'PASS' };
console.log(JSON.stringify(report, null, 2));
process.exitCode = findings.length ? 2 : 0;
