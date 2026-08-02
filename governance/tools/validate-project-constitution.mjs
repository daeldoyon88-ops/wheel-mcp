import fs from 'node:fs';

const constitution = JSON.parse(fs.readFileSync('governance/PROJECT_CONSTITUTION.json', 'utf8'));
const findings = [];
const ids = (constitution.rules || []).map((rule) => rule.ruleId);
if (ids.length !== 17) findings.push('RULE_COUNT_MISMATCH');
if (new Set(ids).size !== ids.length) findings.push('DUPLICATE_RULE_ID');
if (!constitution.governedRepository || constitution.governedRepository.headIsIdentity !== false) findings.push('REPOSITORY_IDENTITY_INVALID');
if (!Array.isArray(constitution.adapterRegistry) || !constitution.adapterRegistry.length) findings.push('ADAPTER_REGISTRY_MISSING');
const report = { document: 'I1_PROJECT_CONSTITUTION_VALIDATION', blockingFindings: findings, blockingTotal: findings.length, verdict: findings.length ? 'REPAIR_REQUIRED' : 'PASS' };
console.log(JSON.stringify(report, null, 2));
process.exitCode = findings.length ? 2 : 0;
