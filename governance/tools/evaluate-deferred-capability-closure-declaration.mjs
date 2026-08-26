#!/usr/bin/env node
/**
 * EVALUATE_DEFERRED_CAPABILITY_CLOSURE_DECLARATION — read-only STEP2 rule owner.
 *
 * Reads a structured declaration at the current closure revision and the
 * canonical registry replay. Writes nothing. Never greps prose. Never trusts
 * the generated index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateDeferredCapabilityRegistry, IDENTITY_RE, TERMINAL_DISPOSITIONS
} from './validate-deferred-capability-registry.mjs';

export const EVALUATOR_DOCUMENT = 'DEFERRED_CAPABILITY_CLOSURE_EVALUATION';
export const EVALUATOR_VERSION = 'V1';
export const RULE_ID = 'DEFERRED_CAPABILITY_MUST_BE_DURABLY_REGISTERED';
export const DECLARATION_FILENAME = 'DEFERRED_CAPABILITY_DECLARATION.json';
export const FINDING_CODES = Object.freeze([
  'DEFERRED_CAPABILITY_DECLARATION_MISSING',
  'DEFERRED_CAPABILITY_DECLARATION_MALFORMED',
  'DEFERRED_CAPABILITY_REFERENCE_UNRESOLVED',
  'DEFERRED_CAPABILITY_NOT_DURABLY_REGISTERED',
  'DEFERRED_CAPABILITY_REGISTRY_INVALID'
]);

const GATE_RE = /^GATE[0-9]{2}$/;
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const CONSTITUTION_PATH = 'governance/PROJECT_CONSTITUTION.json';
const CLOSURE_RELEVANT_STATUSES = new Set([
  'COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'CLOSED', 'AGENT_CLOSURE'
]);

function repoFile(root, relativePath) {
  return path.resolve(root, ...relativePath.split('/'));
}

function readJsonOrNull(root, relativePath) {
  const file = repoFile(root, relativePath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return { __malformed: true }; }
}

function gateNumber(gateId) {
  if (!GATE_RE.test(gateId || '')) return null;
  return Number.parseInt(gateId.slice(4), 10);
}

export function declarationPathFor(gateId, stateRevision) {
  return `governance/gates/${gateId}/state/revisions/${stateRevision}/${DECLARATION_FILENAME}`;
}

export function deriveGateStatusFromLedger(root, gateId) {
  const file = repoFile(root, LEDGER_PATH);
  if (!fs.existsSync(file)) return null;
  let status = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.gateId === gateId) status = event.toStatus ?? status;
  }
  return status;
}

function finding(code, detail = {}) {
  return { code, path: detail.path ?? null, expected: detail.expected ?? null, actual: detail.actual ?? null, message: detail.message ?? null };
}

export function validateDeclarationDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.__malformed) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'deferredCapabilitiesIntroduced') return false;
  const listed = value.deferredCapabilitiesIntroduced;
  if (!Array.isArray(listed)) return false;
  const seen = new Set();
  for (const id of listed) {
    if (typeof id !== 'string' || !IDENTITY_RE.test(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

export function resolveApplicability({ constitution, gateId, derivedStatus }) {
  const rules = Array.isArray(constitution?.rules) ? constitution.rules : [];
  const rule = rules.find((entry) => entry?.ruleId === RULE_ID) ?? null;
  if (!rule) return { applicable: false, reason: 'RULE_ABSENT', rule: null, effectiveFromGate: null };
  const effectiveFromGate = GATE_RE.test(rule.effectiveFromGate || '') ? rule.effectiveFromGate : null;
  if (!effectiveFromGate) return { applicable: false, reason: 'EFFECTIVE_FROM_GATE_ABSENT', rule, effectiveFromGate: null };
  const subject = gateNumber(gateId);
  const floor = gateNumber(effectiveFromGate);
  if (subject === null || floor === null || subject < floor) {
    return { applicable: false, reason: 'BELOW_EFFECTIVE_FROM_GATE', rule, effectiveFromGate };
  }
  if (!CLOSURE_RELEVANT_STATUSES.has(derivedStatus)) {
    return { applicable: false, reason: 'NOT_CLOSURE_RELEVANT', rule, effectiveFromGate };
  }
  return { applicable: true, reason: 'APPLICABLE', rule, effectiveFromGate };
}

/**
 * @returns {{
 *   document: string, version: string, gateId: string, applicable: boolean,
 *   applicabilityReason: string, findings: object[], declarationPath: string|null
 * }}
 */
export function evaluateDeferredCapabilityClosureDeclaration({
  root, gateId, derivedStatus = null, stateRevision = null
} = {}) {
  const constitution = readJsonOrNull(root, CONSTITUTION_PATH);
  const status = derivedStatus ?? deriveGateStatusFromLedger(root, gateId);
  const applicability = resolveApplicability({ constitution, gateId, derivedStatus: status });
  const base = {
    document: EVALUATOR_DOCUMENT,
    version: EVALUATOR_VERSION,
    gateId,
    derivedStatus: status,
    applicable: applicability.applicable,
    applicabilityReason: applicability.reason,
    effectiveFromGate: applicability.effectiveFromGate,
    declarationPath: null,
    findings: []
  };
  if (!applicability.applicable) return base;

  const currentState = readJsonOrNull(root, `governance/gates/${gateId}/state/CURRENT_STATE.json`);
  const revision = stateRevision
    ?? (currentState && !currentState.__malformed ? currentState.stateRevision ?? null : null);
  if (typeof revision !== 'string' || !revision) {
    base.findings.push(finding('DEFERRED_CAPABILITY_DECLARATION_MISSING', {
      path: `governance/gates/${gateId}/state/CURRENT_STATE.json`,
      expected: 'current stateRevision locating DEFERRED_CAPABILITY_DECLARATION.json',
      actual: 'ABSENT'
    }));
    return base;
  }
  const declarationPath = declarationPathFor(gateId, revision);
  base.declarationPath = declarationPath;
  const file = repoFile(root, declarationPath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    base.findings.push(finding('DEFERRED_CAPABILITY_DECLARATION_MISSING', {
      path: declarationPath, expected: 'existing structured declaration', actual: 'ABSENT'
    }));
    return base;
  }

  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { parsed = { __malformed: true }; }
  if (!validateDeclarationDocument(parsed)) {
    base.findings.push(finding('DEFERRED_CAPABILITY_DECLARATION_MALFORMED', {
      path: declarationPath, expected: 'schema-valid deferredCapabilitiesIntroduced array', actual: 'MALFORMED'
    }));
    return base;
  }

  const report = validateDeferredCapabilityRegistry({ root });
  if (report.verdict !== 'VALID') {
    base.findings.push(finding('DEFERRED_CAPABILITY_REGISTRY_INVALID', {
      path: 'governance/master-matrix/DEFERRED_CAPABILITY_REGISTRY.ndjson',
      expected: 'VALID', actual: report.verdict ?? 'BLOCKED'
    }));
    return base;
  }

  const byId = new Map((report.entries ?? []).map((entry) => [entry.deferredCapabilityId, entry]));
  for (const id of parsed.deferredCapabilitiesIntroduced) {
    const entry = byId.get(id);
    if (!entry) {
      base.findings.push(finding('DEFERRED_CAPABILITY_REFERENCE_UNRESOLVED', {
        path: declarationPath, expected: `canonical registry entry ${id}`, actual: 'ABSENT'
      }));
      continue;
    }
    const terminal = TERMINAL_DISPOSITIONS.includes(entry.disposition);
    if (entry.sourceGate !== gateId || entry.disposition !== 'OPEN' || terminal) {
      base.findings.push(finding('DEFERRED_CAPABILITY_NOT_DURABLY_REGISTERED', {
        path: declarationPath,
        expected: `OPEN deferral owned by ${gateId}`,
        actual: `${entry.sourceGate}:${entry.disposition}`
      }));
    }
  }
  return base;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const report = evaluateDeferredCapabilityClosureDeclaration({ root, gateId: option('--gate') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.findings.length ? 2 : 0;
}
