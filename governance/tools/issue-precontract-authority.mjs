#!/usr/bin/env node
/**
 * Binds an explicit Project Owner bootstrap decision to the exact live
 * repository pre-state, producing a LOCAL_EXPLICIT_AUTHORITY precontract
 * authority document.
 *
 * WHAT IS THE DECISION AND WHAT IS NOT. The decision is the input: which Gate,
 * which staged contract bytes, which expiry. Everything this file adds is
 * observation — HEAD, HEAD tree, ledger bytes and event count, live Gate status,
 * the predecessor's resolved dependency proof, the staged artifacts' hashes —
 * plus the digest that binds them together. It cannot invent an authorization:
 * the document it emits is re-verified against the live repository by the
 * PRECONTRACT primitive before a single byte is written, and refused if the
 * repository has moved since.
 *
 * Fail-closed: a Gate that is not NOT_STARTED, a Gate that already has a
 * contract, an unsatisfied dependency, or a staged path outside the finite
 * bootstrap cohort all produce no document at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  computePrecontractLocalRequestDigest,
  PRECONTRACT_AUTHORITY_KIND,
  PRECONTRACT_LOCAL_AUTHORITY_MODE,
  PRECONTRACT_LOCAL_REQUEST_DIGEST_ALGORITHM,
  PRECONTRACT_OPERATION,
  PRECONTRACT_PURPOSE,
  PRECONTRACT_STATUS
} from '../gee-v1/core/precontract-authority.mjs';
import {
  precontractBootstrapPaths, precontractConsumptionRecordPath
} from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';
import { resolveGateDependencyProof } from '../gee-v1/adapters/wheel/gate-dependency-resolution.mjs';

export const PRECONTRACT_ISSUE_DOCUMENT = 'PRECONTRACT_AUTHORITY_ISSUE';

/** The prohibitions a bootstrap authority must enumerate; see the core primitive. */
export const PRECONTRACT_ISSUED_PROHIBITIONS = Object.freeze([
  'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_CONFIRMED',
  'ARBITRARY_LEDGER_TRANSITION', 'GIT_PUSH', 'ARBITRARY_GOVERNANCE_WRITE',
  'OTHER_GATE', 'GEE_REVISION_CREATION', 'FUNCTIONAL_GATE_EXECUTION'
]);

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * @param {string[]} options.stagedPaths  Repository-relative paths, in the order
 *   they should appear in the authority. Each must exist under `stagedRoot`.
 */
export function issuePrecontractAuthority({
  root, gateId, authorityId, stagedRoot, stagedPaths, issuedAtUtc, expiresAtUtc
}) {
  const findings = [];
  const absoluteRoot = path.resolve(root);
  const registry = JSON.parse(fs.readFileSync(path.join(absoluteRoot, 'governance/GATE_REGISTRY_00_40.json'), 'utf8'));
  const entry = (registry.gates || []).find((gate) => gate.gateId === gateId);
  if (!entry) findings.push({ code: 'GATE_NOT_REGISTERED', detail: gateId });

  const ledgerBytes = fs.readFileSync(path.join(absoluteRoot, 'governance/state/GATE_STATUS_LEDGER.ndjson'));
  const events = ledgerBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const status = events.filter((event) => event.gateId === gateId).at(-1)?.toStatus ?? null;
  if (status !== PRECONTRACT_STATUS) findings.push({ code: 'GATE_NOT_NOT_STARTED', detail: status });

  const contractDirectory = path.join(absoluteRoot, 'governance', 'gates', gateId, 'contracts');
  if (fs.existsSync(path.join(contractDirectory, 'CURRENT_CONTRACT.json'))) findings.push({ code: 'CURRENT_CONTRACT_PRESENT' });

  const dependencyGate = (Array.isArray(entry?.dependencies) ? entry.dependencies : []).at(-1) ?? null;
  const dependency = dependencyGate ? resolveGateDependencyProof({ root: absoluteRoot, gateId: dependencyGate }) : null;
  if (!dependency?.satisfied) findings.push({ code: 'DEPENDENCY_NOT_SATISFIED', detail: dependency?.reason ?? dependencyGate });

  const cohort = new Set(precontractBootstrapPaths(gateId));
  const consumptionRecordPath = precontractConsumptionRecordPath(gateId);
  const artifactBindings = [];
  for (const relativePath of stagedPaths) {
    if (!cohort.has(relativePath)) { findings.push({ code: 'PATH_OUTSIDE_BOOTSTRAP_SCOPE', detail: relativePath }); continue; }
    if (relativePath === consumptionRecordPath) { findings.push({ code: 'CONSUMPTION_RECORD_CANNOT_BE_STAGED', detail: relativePath }); continue; }
    const staged = path.join(path.resolve(stagedRoot), ...relativePath.split('/'));
    if (!fs.existsSync(staged)) { findings.push({ code: 'STAGED_ARTIFACT_ABSENT', detail: relativePath }); continue; }
    artifactBindings.push({ path: relativePath, sha256: sha256(fs.readFileSync(staged)) });
  }
  if (artifactBindings.length === 0) findings.push({ code: 'NO_STAGED_ARTIFACT' });

  const baseCommit = git(absoluteRoot, ['rev-parse', 'HEAD']);
  const baseTree = git(absoluteRoot, ['rev-parse', 'HEAD^{tree}']);
  if (!baseCommit || !baseTree) findings.push({ code: 'HEAD_UNRESOLVABLE' });
  if (findings.length) return { document: PRECONTRACT_ISSUE_DOCUMENT, verdict: 'BLOCKED', findings, authority: null };

  const authority = {
    schemaVersion: 1,
    documentKind: PRECONTRACT_AUTHORITY_KIND,
    authorityMode: PRECONTRACT_LOCAL_AUTHORITY_MODE,
    authorityId,
    issuedBy: 'PROJECT_OWNER',
    issuedAtUtc,
    localRequestDigestAlgorithm: PRECONTRACT_LOCAL_REQUEST_DIGEST_ALGORITHM,
    approvedRequestDigest: null,
    projectId: 'WHEEL',
    gateId,
    purpose: PRECONTRACT_PURPOSE,
    operation: PRECONTRACT_OPERATION,
    preState: {
      baseCommit, baseTree,
      ledgerSha256: sha256(ledgerBytes),
      ledgerEventCount: events.length,
      currentStatus: PRECONTRACT_STATUS,
      currentContractPresent: false
    },
    dependencyProof: dependency.proof,
    authorizedPaths: [...artifactBindings.map((binding) => binding.path), consumptionRecordPath],
    artifactBindings,
    consumptionRecordPath,
    prohibitedOperations: [...PRECONTRACT_ISSUED_PROHIBITIONS],
    expiresAtUtc,
    maxUse: 1
  };
  authority.approvedRequestDigest = computePrecontractLocalRequestDigest(authority);
  return { document: PRECONTRACT_ISSUE_DOCUMENT, verdict: 'ISSUED', findings: [], authority };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const gateId = option('--gate');
  const stagedRoot = option('--staged');
  const declared = option('--paths');
  const stagedPaths = declared
    ? declared.split(',').map((value) => value.trim()).filter(Boolean)
    : [
        `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`,
        `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`
      ];
  const result = issuePrecontractAuthority({
    root, gateId, stagedRoot, stagedPaths,
    authorityId: option('--authority-id', `PRECONTRACT_BOOTSTRAP_${gateId}_LOCAL_R1`),
    issuedAtUtc: option('--issued-at', new Date().toISOString()),
    expiresAtUtc: option('--expires', '2026-12-31T23:59:59.000Z')
  });
  const out = option('--out');
  if (result.verdict === 'ISSUED' && out) {
    const target = path.resolve(root, out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result.authority, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ...result, out }, null, 2)}\n`);
  process.exitCode = result.verdict === 'ISSUED' ? 0 : 2;
}
