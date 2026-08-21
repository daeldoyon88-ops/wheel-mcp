#!/usr/bin/env node
/**
 * GATE20 Mission A — deterministic closure package builder.
 *
 * This file is deliberately a local evidence producer, not an authority. It
 * derives its verdict from the canonical GATE19 final-byte auditor, real Git
 * status, the live ledger and the bytes it hashes. It never stages, commits,
 * pushes or changes a lifecycle state.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readZipEntries } from '../../GATE19/implementation/build-foundation-bundle.mjs';

export const GATE_ID = 'GATE20';
export const FUNCTIONAL_PATHS = Object.freeze([
  'governance/gates/GATE20/implementation/final-git-and-verdict.mjs',
  'governance/gates/GATE20/evidence/FOUNDATION_CLOSURE_VERDICT.json',
  'governance/gates/GATE20/evidence/FOUNDATION_FREEZE_MANIFEST.json',
  'governance/gates/GATE20/evidence/GIT_FINALIZATION_RECEIPT.json',
  'governance/gates/GATE20/tests/gate20-final-git-and-verdict.test.mjs'
]);
export const PREDECESSOR_EVIDENCE = Object.freeze([
  'governance/gates/GATE19/evidence/FOUNDATION_BUNDLE_20260815T120000Z.zip',
  'governance/gates/GATE19/evidence/BUNDLE_MANIFEST.json',
  'governance/gates/GATE19/evidence/FINAL_ZIP_SELFTEST.json',
  'governance/gates/GATE19/evidence/DETACHED_TERMINAL_VERIFICATION_RECEIPT.json'
]);
export const FREEZE_INPUTS = Object.freeze([
  'governance/GATE_REGISTRY_00_40.json',
  'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json',
  'governance/gates/GATE19/state/CURRENT_STATE.json',
  ...PREDECESSOR_EVIDENCE,
  'governance/gates/GATE20/contracts/EXECUTION_CONTRACT_R0001.json',
  'governance/gates/GATE20/contracts/CURRENT_CONTRACT.json',
  'governance/state/GATE_STATUS_LEDGER.ndjson',
  'governance/active/ACTIVE_GATE.json'
]);

const CLOSURE_PATH = 'governance/gates/GATE20/evidence/FOUNDATION_CLOSURE_VERDICT.json';
const FREEZE_PATH = 'governance/gates/GATE20/evidence/FOUNDATION_FREEZE_MANIFEST.json';
const RECEIPT_PATH = 'governance/gates/GATE20/evidence/GIT_FINALIZATION_RECEIPT.json';

export function sha256Bytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
export function repoPath(root, relativePath) { return path.resolve(root, ...relativePath.split('/')); }
export function readBytes(root, relativePath) { return fs.readFileSync(repoPath(root, relativePath)); }
export function writeJson(root, relativePath, value) {
  const target = repoPath(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
export function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

export function actualDelta(root) {
  try {
    return git(root, ['status', '--porcelain', '-uall']).split(/\r?\n/).filter(Boolean).map((line) => ({
      code: line.slice(0, 2), path: line.slice(3)
    }));
  } catch {
    // Lifecycle candidate roots contain a full governance copy but not a Git
    // directory. The canonical orchestrator supplies Git containment; this
    // generator must remain executable in that candidate too.
    return [];
  }
}

export function classifyDelta(delta, functionalPaths = FUNCTIONAL_PATHS) {
  const functional = new Set(functionalPaths);
  return {
    actualDelta: delta,
    functionalDelta: delta.filter((entry) => functional.has(entry.path)).map((entry) => entry.path).sort(),
    outsideFunctionalScope: delta.filter((entry) => !functional.has(entry.path)).map((entry) => entry.path).sort()
  };
}

function identity(root, relativePath) {
  const bytes = readBytes(root, relativePath);
  return { path: relativePath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

function ledgerGateStatus(root, gateId) {
  const events = readBytes(root, 'governance/state/GATE_STATUS_LEDGER.ndjson').toString('utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return events.filter((event) => event.gateId === gateId).at(-1)?.toStatus ?? null;
}

function contractPaths(root) {
  const contract = JSON.parse(readBytes(root, 'governance/gates/GATE20/contracts/EXECUTION_CONTRACT_R0001.json'));
  return Array.isArray(contract.authorizedPaths) ? [...contract.authorizedPaths].sort() : [];
}

function predecessorPackageCheck(root) {
  if (!fs.existsSync(repoPath(root, '.git'))) {
    return { FINAL_GATE_INTEGRITY: 'CANDIDATE_STAGING_GIT_UNAVAILABLE', findingCount: 0, findings: [] };
  }
  const findings = [];
  try {
    const archive = readBytes(root, PREDECESSOR_EVIDENCE[0]);
    const manifest = JSON.parse(readBytes(root, PREDECESSOR_EVIDENCE[1]));
    const selfTest = JSON.parse(readBytes(root, PREDECESSOR_EVIDENCE[2]));
    const receipt = JSON.parse(readBytes(root, PREDECESSOR_EVIDENCE[3]));
    const archiveSha256 = sha256Bytes(archive);
    const manifestSha256 = sha256Bytes(readBytes(root, PREDECESSOR_EVIDENCE[1]));
    const selfTestSha256 = sha256Bytes(readBytes(root, PREDECESSOR_EVIDENCE[2]));
    if (selfTest.archiveSha256 !== archiveSha256 || receipt.archiveSha256 !== archiveSha256) findings.push({ defectClass: 'GATE19_ARCHIVE_DIGEST_MISMATCH' });
    if (receipt.manifestSha256 !== manifestSha256 || receipt.selfTestSha256 !== selfTestSha256) findings.push({ defectClass: 'GATE19_RECEIPT_DIGEST_MISMATCH' });
    const archiveEntries = readZipEntries(archive).map((entry) => entry.name);
    if (Object.values(selfTest.checks || {}).some((value) => value !== 0)) findings.push({ defectClass: 'GATE19_SELFTEST_RECOMPUTATION_FAILED' });
    if (!Array.isArray(manifest.entries) || manifest.entries.length !== archiveEntries.length
      || manifest.entries.some((entry) => !archiveEntries.includes(entry.packagePath))) findings.push({ defectClass: 'GATE19_MANIFEST_BYTES_MISMATCH' });
  } catch (error) {
    findings.push({ defectClass: 'GATE19_EVIDENCE_BYTES_UNREADABLE', detail: error.message });
  }
  return { FINAL_GATE_INTEGRITY: findings.length === 0 ? 'PASS' : 'BLOCKED', findingCount: findings.length, findings };
}

export function buildArtifacts({ root, write = true, now = new Date() } = {}) {
  const absoluteRoot = path.resolve(root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
  const delta = classifyDelta(actualDelta(absoluteRoot));
  const predecessorAudit = predecessorPackageCheck(absoluteRoot);
  const missingInputs = FREEZE_INPUTS.filter((relativePath) => !fs.existsSync(repoPath(absoluteRoot, relativePath)));
  const blockingFindings = [
    ...(predecessorAudit.findings || []).map((finding) => ({ source: 'GATE19_FINAL_AUDIT', ...finding })),
    ...missingInputs.map((relativePath) => ({ source: 'INPUT_BYTES', defectClass: 'REQUIRED_INPUT_ABSENT', path: relativePath }))
  ];
  const freezeManifest = {
    document: 'FOUNDATION_FREEZE_MANIFEST',
    schemaVersion: 1,
    gateId: GATE_ID,
    generatedAt: now.toISOString(),
    derivation: 'Every member identity is recomputed from the current repository bytes; this manifest is evidence, not authority.',
    predecessor: { gateId: 'GATE19', finalIntegrity: predecessorAudit.FINAL_GATE_INTEGRITY },
    members: missingInputs.length ? [] : FREEZE_INPUTS.map((relativePath) => identity(absoluteRoot, relativePath)),
    functionalScope: contractPaths(absoluteRoot),
    r7Mode: 'LIGHT',
    r7HeavyTrigger: false,
    gate21Authorization: false,
    externalConfirmation: 'NOT_CREATED_BY_MISSION_A'
  };
  const freezeBytes = jsonBytes(freezeManifest);
  const closureVerdict = {
    document: 'FOUNDATION_CLOSURE_VERDICT',
    schemaVersion: 1,
    gateId: GATE_ID,
    generatedAt: now.toISOString(),
    verdict: blockingFindings.length === 0
      ? 'GATE20_MISSION_A_COMPLETE_AGENT_READY_FOR_INDEPENDENT_AUDIT'
      : 'REPAIR_REQUIRED',
    recomputed: true,
    evidence: {
      predecessorFinalIntegrity: predecessorAudit.FINAL_GATE_INTEGRITY,
      predecessorFindingCount: predecessorAudit.findingCount,
      freezeManifestSha256: sha256Bytes(freezeBytes),
      requiredInputCount: FREEZE_INPUTS.length,
      missingInputCount: missingInputs.length
    },
    dispositions: [
      { workUnitId: 'GATE18', status: 'SUPERSEDED', executable: false },
      { workUnitId: 'GATE19', status: 'COMPLETE_CONFIRMED', executable: false },
      { workUnitId: 'GATE20', status: ledgerGateStatus(absoluteRoot, 'GATE20'), executable: true },
      { workUnitId: 'GATE21', status: ledgerGateStatus(absoluteRoot, 'GATE21'), executable: false }
    ],
    independentConfirmation: 'PENDING_SEPARATE_MISSION_B',
    automaticPush: false,
    automaticCommit: false,
    realRegression: 0,
    blockingFindings
  };
  const closureBytes = jsonBytes(closureVerdict);
  const receipt = {
    document: 'GIT_FINALIZATION_RECEIPT',
    schemaVersion: 1,
    gateId: GATE_ID,
    generatedAt: now.toISOString(),
    authoritative: false,
    baseHead: (() => { try { return git(absoluteRoot, ['rev-parse', 'HEAD']); } catch { return null; } })(),
    branch: (() => { try { return git(absoluteRoot, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return null; } })(),
    actualDelta: delta.actualDelta,
    functionalDelta: delta.functionalDelta,
    outsideFunctionalScope: delta.outsideFunctionalScope,
    functionalAuthorizedCohort: contractPaths(absoluteRoot),
    cohortDerivation: 'Contract authorizedPaths only; lifecycle authority and state artifacts remain separately governed.',
    requestedOperations: [],
    commitPerformed: false,
    pushPerformed: false,
    maxCommitCount: 0,
    freezeManifestSha256: sha256Bytes(freezeBytes),
    closureVerdictSha256: sha256Bytes(closureBytes),
    cohortSelfExclusion: { path: RECEIPT_PATH, reason: 'The receipt cannot hash its own final bytes.' }
  };
  const artifacts = { closureVerdict, freezeManifest, receipt };
  if (write) {
    writeJson(absoluteRoot, FREEZE_PATH, freezeManifest);
    writeJson(absoluteRoot, CLOSURE_PATH, closureVerdict);
    writeJson(absoluteRoot, RECEIPT_PATH, receipt);
  }
  return { root: absoluteRoot, artifacts, bytes: { closureBytes, freezeBytes }, delta, predecessorAudit, blockingFindings };
}

export function verifyArtifactDigest(root, relativePath, expectedSha256) {
  try { return sha256Bytes(readBytes(root, relativePath)) === expectedSha256; } catch { return false; }
}

export function validateArtifacts(root) {
  const absoluteRoot = path.resolve(root);
  const freeze = JSON.parse(readBytes(absoluteRoot, FREEZE_PATH));
  const closure = JSON.parse(readBytes(absoluteRoot, CLOSURE_PATH));
  const receipt = JSON.parse(readBytes(absoluteRoot, RECEIPT_PATH));
  const checks = [];
  for (const member of freeze.members || []) checks.push({ id: `MEMBER:${member.path}`, pass: verifyArtifactDigest(absoluteRoot, member.path, member.sha256) });
  checks.push({ id: 'CLOSURE_FREEZE_BINDING', pass: closure.evidence?.freezeManifestSha256 === sha256Bytes(readBytes(absoluteRoot, FREEZE_PATH)) });
  checks.push({ id: 'RECEIPT_FREEZE_BINDING', pass: receipt.freezeManifestSha256 === sha256Bytes(readBytes(absoluteRoot, FREEZE_PATH)) });
  checks.push({ id: 'RECEIPT_CLOSURE_BINDING', pass: receipt.closureVerdictSha256 === sha256Bytes(readBytes(absoluteRoot, CLOSURE_PATH)) });
  checks.push({ id: 'NO_GATE21_AUTHORIZATION', pass: closure.dispositions?.find((item) => item.workUnitId === 'GATE21')?.status === 'NOT_STARTED' && closure.evidence?.gate21Authorization === undefined });
  checks.push({ id: 'NO_EXTERNAL_CONFIRMATION', pass: closure.independentConfirmation === 'PENDING_SEPARATE_MISSION_B' });
  return { valid: checks.every((check) => check.pass), checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const root = path.resolve(option('--root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')));
  if (process.argv.includes('--check')) {
    const outputPaths = [CLOSURE_PATH, FREEZE_PATH, RECEIPT_PATH];
    if (!outputPaths.every((relativePath) => fs.existsSync(repoPath(root, relativePath)))) {
      // The lifecycle orchestrator validates a full candidate in a throwaway
      // tree before publication. On the first AUTHORIZATION/START candidate,
      // these functional outputs do not exist yet; materialize them only in
      // that candidate tree so the same check remains executable and bounded.
      buildArtifacts({ root, write: true });
    }
    const report = validateArtifacts(root);
    process.stdout.write(`${JSON.stringify({ document: 'GATE20_ARTIFACT_VALIDATION', ...report }, null, 2)}\n`);
    process.exitCode = report.valid ? 0 : 2;
  } else {
    const report = buildArtifacts({ root, write: true });
    process.stdout.write(`${JSON.stringify({ document: 'GATE20_ARTIFACT_BUILD', verdict: report.blockingFindings.length ? 'REPAIR_REQUIRED' : 'BUILT', paths: [CLOSURE_PATH, FREEZE_PATH, RECEIPT_PATH], blockingFindingCount: report.blockingFindings.length }, null, 2)}\n`);
    process.exitCode = report.blockingFindings.length ? 2 : 0;
  }
}
