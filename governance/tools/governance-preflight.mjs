#!/usr/bin/env node
/**
 * Governance preflight.
 *
 * Answers two separate questions and never conflates them:
 *
 *   1. Is the governance CONFIGURATION of this repository valid right now?
 *      (structure, active pointer integrity, adapter parity, authority refs)
 *   2. Does the REQUESTED WORK UNIT authorize execution?
 *
 * Question 2 used to have only one possible subject. Authority was read
 * straight out of governance/active/ACTIVE_GATE.json, so the active gate was
 * the universal execution authority: any work unit that was not that gate had
 * no route to authorization at all, and a closed gate froze every kind of
 * work, not just its own. Question 2 is now resolved by
 * gee-v1/core/work-unit-core.mjs, which routes an EXPLICIT (workUnitType,
 * workUnitId) request to exactly one authority source.
 *
 * Usage:
 *   governance-preflight.mjs
 *   governance-preflight.mjs --work-unit-type <TYPE> --work-unit-id <ID>
 *
 * With no arguments the request defaults to the active gate, so every existing
 * caller keeps its exact previous behaviour. The default is the documented
 * legacy interface for ONE work-unit type; an unrecognised type is blocked and
 * never silently redirected to the active pointer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createExecutionAuthorityRegistry, resolveExecutionAuthority } from '../gee-v1/core/work-unit-core.mjs';
import { createWheelGateAuthoritySource, readActiveGateId } from '../gee-v1/adapters/wheel/gate-authority-source.mjs';
import { createWheelGateStartAuthoritySource } from '../gee-v1/adapters/wheel/gate-start-authority-source.mjs';
import { createGeeMissionAuthoritySource } from '../gee-v1/adapters/gee-mission-authority-source.mjs';
import { createWheelProjectAdapter } from '../gee-v1/adapters/wheel/wheel-project-adapter.mjs';
import { createWheelPrecontractAuthoritySource, PRECONTRACT_WORK_UNIT_TYPE } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ID = 'WHEEL';
const DEFAULT_WORK_UNIT_TYPE = 'GATE';

const CONFIGURATION_VALIDATORS = [
  ['governance/tools/validate-adapter-parity.mjs', []],
  ['governance/tools/validate-active-gate.mjs', []],
  ['governance/tools/validate-active-authority-references.mjs', []],
  ['governance/tools/generate-active-gate-context.mjs', ['--check']]
];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function runConfigurationValidators() {
  const findings = [];
  for (const [tool, args] of CONFIGURATION_VALIDATORS) {
    const result = spawnSync(process.execPath, [tool, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status === 0) continue;
    try {
      findings.push(...(JSON.parse(result.stderr || result.stdout).findingIds || []));
    } catch {
      findings.push('TOOL_EXECUTION_FAILURE');
    }
  }
  return findings;
}

/**
 * The Git policy an agent must obey, read from the constitution rather than
 * restated here — a copy in this file would be a second authority that could
 * drift from the real one. Absence is disclosed, never defaulted to something
 * permissive.
 */
function readGitPolicy() {
  try {
    const constitution = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/PROJECT_CONSTITUTION.json'), 'utf8'));
    const rule = (constitution.rules || []).find((entry) => entry.ruleId === 'GIT_WRITES_FORBIDDEN_BY_DEFAULT');
    if (!rule?.gitOperationPolicy) return { declared: false, authority: 'governance/PROJECT_CONSTITUTION.json' };
    return { declared: true, authority: 'governance/PROJECT_CONSTITUTION.json#GIT_WRITES_FORBIDDEN_BY_DEFAULT', ...rule.gitOperationPolicy };
  } catch (error) {
    return { declared: false, error: error?.message || String(error) };
  }
}

function buildRegistry() {
  const wheelAdapter = createWheelProjectAdapter(REPO_ROOT);
  const sources = [
    createWheelGateAuthoritySource(REPO_ROOT, { projectId: PROJECT_ID }),
    createGeeMissionAuthoritySource(REPO_ROOT, {
      projectId: PROJECT_ID,
      prerequisiteResolvers: {
        // A GEE mission may depend on a host-project work unit. The mission
        // source does not know what a gate is; the host project's own adapter
        // resolves it, exactly as it already does for readiness.
        'wheel-adapter-status': (prerequisite) => wheelAdapter.resolvePrerequisite(prerequisite.id, prerequisite)
      }
    })
  ];
  if (workUnitType === 'GATE_START') {
    sources.push(createWheelGateStartAuthoritySource(REPO_ROOT, { projectId: PROJECT_ID }));
  }
  if (workUnitType === PRECONTRACT_WORK_UNIT_TYPE) {
    sources.push(createWheelPrecontractAuthoritySource(REPO_ROOT, {
      requestPath: option('--request'),
      authorityPath: option('--authority')
    }));
  }
  return createExecutionAuthorityRegistry(sources);
}

// --- requested work unit ----------------------------------------------------
const workUnitType = option('--work-unit-type', DEFAULT_WORK_UNIT_TYPE);
const activeGate = readActiveGateId(REPO_ROOT);
const explicitWorkUnitId = option('--work-unit-id', null);
// The legacy pointer supplies a default id for the legacy type ONLY.
const workUnitId = explicitWorkUnitId || (workUnitType === DEFAULT_WORK_UNIT_TYPE ? activeGate : null);

const configurationFindings = runConfigurationValidators();
const configurationValid = configurationFindings.length === 0;

const registry = buildRegistry();
const authority = workUnitType === PRECONTRACT_WORK_UNIT_TYPE
  ? registry.match(PROJECT_ID, PRECONTRACT_WORK_UNIT_TYPE)[0]?.resolvePrecontractAuthority(workUnitId)
    || { authoritySource: null, decision: 'BLOCKED', executionAuthorized: false, bootstrapAuthorized: false, authorizedPaths: [], proofs: {}, findings: [{ code: 'PRECONTRACT_AUTHORITY_SOURCE_MISSING' }] }
  : resolveExecutionAuthority({ projectId: PROJECT_ID, workUnitType, workUnitId, registry });

// Execution needs BOTH a valid configuration and an authorizing work unit.
const executionAuthorized = configurationValid && workUnitType !== PRECONTRACT_WORK_UNIT_TYPE && authority.executionAuthorized;

// Preserved verbatim from the pre-repair report so existing consumers keep
// reading the same fields with the same meaning: these describe the ACTIVE
// GATE, whatever work unit was requested.
const activeGateStatus = activeGate
  ? (fs.readFileSync(path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line))
      .filter((event) => event.gateId === activeGate).at(-1)?.toStatus || 'UNKNOWN')
  : 'UNKNOWN';
const activeContractPresent = Boolean(activeGate)
  && fs.existsSync(path.join(REPO_ROOT, 'governance', 'gates', activeGate, 'contracts', 'CURRENT_CONTRACT.json'));
const activeGateExecutable = activeContractPresent && ['AUTHORIZED_NOT_STARTED', 'IN_PROGRESS'].includes(activeGateStatus);

const gitPolicy = readGitPolicy();
const advisoryFindings = gitPolicy.declared ? [] : ['GIT_OPERATION_POLICY_UNDECLARED'];

const workUnitReport = {
  requested: { projectId: PROJECT_ID, workUnitType, workUnitId: workUnitId ?? null },
  resolvedBy: authority.authoritySource,
  decision: authority.decision,
  executionAuthorized: authority.executionAuthorized,
  authorizedPaths: authority.authorizedPaths,
  proofs: authority.proofs,
  findings: authority.findings
};
if (workUnitType === PRECONTRACT_WORK_UNIT_TYPE) workUnitReport.bootstrapAuthorized = authority.bootstrapAuthorized === true;

const report = {
  GOVERNANCE_VERDICT: configurationValid ? 'PASS' : 'BLOCKED_GOVERNANCE',
  configurationValid,
  governanceStructureValid: configurationValid,
  executionAuthorized,
  workUnit: workUnitReport,
  gitPolicy,
  activeGateExecutable,
  activeContractPresent,
  activeGateStatus,
  blockingFindings: [...new Set(configurationFindings)],
  advisoryFindings,
  blockingFindingCount: configurationFindings.length,
  findingIds: [...new Set(configurationFindings)],
  processExitCode: configurationFindings.length ? 2 : 0,
  generatedAt: '2026-08-01T16:00:00.000Z'
};
if (workUnitType === PRECONTRACT_WORK_UNIT_TYPE) report.bootstrapAuthorized = configurationValid && authority.bootstrapAuthorized === true;

console.log(JSON.stringify(report, null, 2));
if (configurationFindings.length) process.exitCode = 2;
