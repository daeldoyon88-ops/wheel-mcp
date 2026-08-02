import fs from 'node:fs';

const policyFile = 'governance/MODEL_ROUTING_POLICY.json';
const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
const findings = [];
if (!Array.isArray(policy.dimensions) || !Array.isArray(policy.profiles)) findings.push('SCHEMA_INVALID');
if (!policy.dimensions.some((item) => item.dimension === 'workClass')) findings.push('WORKCLASS_MISSING');
if (!policy.dimensions.some((item) => item.dimension === 'executionMode')) findings.push('EXECUTION_MODE_MISSING');
if (/"(model|modelId|provider|vendor)"\s*:/.test(JSON.stringify(policy))) findings.push('MODEL_BINDING_DETECTED');
const addSubagentsFinding = ({ detectorId, jsonPointer, actualValue, expectedValue = false, message }) => {
  findings.push({
    detectorId,
    severity: 'BLOCKING',
    file: policyFile,
    jsonPointer,
    actualValue,
    expectedValue,
    message,
    requirementId: 'AUD-I1-CT-07'
  });
};

const subagentsDimensions = Array.isArray(policy.dimensions)
  ? policy.dimensions
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.dimension === 'subagentsAllowed')
  : [];

let effectiveSubagentsDefault = false;
for (const { item, index } of subagentsDimensions) {
  if (!Object.prototype.hasOwnProperty.call(item, 'default')) continue;
  if (typeof item.default !== 'boolean') {
    addSubagentsFinding({
      detectorId: 'SUBAGENTS_DEFAULT_TYPE_INVALID',
      jsonPointer: `/dimensions/${index}/default`,
      actualValue: item.default,
      message: 'The effective subagents default must be the boolean false.'
    });
    continue;
  }
  effectiveSubagentsDefault ||= item.default;
  if (item.default === true) {
    addSubagentsFinding({
      detectorId: 'SUBAGENTS_DEFAULT_ALLOWED',
      jsonPointer: `/dimensions/${index}/default`,
      actualValue: true,
      message: 'Subagents are enabled by the canonical default.'
    });
  }
}

if (Array.isArray(policy.profiles)) {
  policy.profiles.forEach((profile, index) => {
    if (!profile || typeof profile !== 'object') return;
    const hasExplicitValue = Object.prototype.hasOwnProperty.call(profile, 'subagentsAllowed');
    const effectiveValue = hasExplicitValue ? profile.subagentsAllowed : effectiveSubagentsDefault;
    const pointer = `/profiles/${index}/subagentsAllowed`;

    if (hasExplicitValue && typeof effectiveValue !== 'boolean') {
      addSubagentsFinding({
        detectorId: 'SUBAGENTS_PROFILE_TYPE_INVALID',
        jsonPointer: pointer,
        actualValue: effectiveValue,
        message: 'A profile subagentsAllowed value must be the boolean false.'
      });
      return;
    }
    if (effectiveValue === true) {
      addSubagentsFinding({
        detectorId: hasExplicitValue ? 'SUBAGENTS_PROFILE_ALLOWED' : 'SUBAGENTS_INHERITED_DEFAULT_ALLOWED',
        jsonPointer: pointer,
        actualValue: true,
        message: hasExplicitValue
          ? 'A canonical profile explicitly enables subagents.'
          : 'A canonical profile inherits a subagents-enabled default.'
      });
    }
  });
}

const report = { document: 'I1_MODEL_ROUTING_VALIDATION', blockingFindings: findings, blockingTotal: findings.length, verdict: findings.length ? 'REPAIR_REQUIRED' : 'PASS' };
console.log(JSON.stringify(report, null, 2));
process.exitCode = findings.length ? 2 : 0;
