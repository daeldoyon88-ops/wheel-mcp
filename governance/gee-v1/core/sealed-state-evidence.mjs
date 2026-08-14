/**
 * Generic inventory of evidence sealed by closed state revisions.
 *
 * The inventory is deliberately read-only. A maintenance authority may use it
 * to reject a path before apply, but it never rewrites a seal or its members.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const CLOSED_REVISION_STATUSES = Object.freeze([
  'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED',
  'CLOSED'
]);

const CLOSED_STATUS_SET = new Set(CLOSED_REVISION_STATUSES);
const SAFE_RELATIVE_RE = /^[^\\/][^\\]*$/;

export const EXACT_SEALED_BYTE_RESTORATION = 'EXACT_SEALED_BYTE_RESTORATION';

function hasClosedStatus(value) {
  if (typeof value === 'string') return CLOSED_STATUS_SET.has(value);
  if (Array.isArray(value)) return value.some(hasClosedStatus);
  if (value && typeof value === 'object') return Object.values(value).some(hasClosedStatus);
  return false;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (!SAFE_RELATIVE_RE.test(value) || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function finding(code, detail) {
  return { code, detail };
}

function sha256Buffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validByteLength(value) {
  return Number.isInteger(value) && value >= 0;
}

function readGitBlob(root, commit, repoRelativePath) {
  try {
    return execFileSync('git', ['show', `${commit}:${repoRelativePath}`], {
      cwd: root,
      encoding: null,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    return null;
  }
}

function directParent(root, commit) {
  try {
    const line = execFileSync('git', ['rev-list', '--parents', '-n', '1', commit], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    const parts = line.split(/\s+/);
    return parts[0] === commit && parts[1] ? parts[1] : null;
  } catch {
    return null;
  }
}

function sameSealedMember(left, right) {
  return left?.repoRelativePath === right?.repoRelativePath
    && left?.sha256 === right?.sha256
    && left?.byteLength === right?.byteLength
    && left?.gateId === right?.gateId
    && left?.stateRevision === right?.stateRevision
    && left?.sealPath === right?.sealPath;
}

function validateSealedMemberShape(member, findings) {
  const allowed = ['repoRelativePath', 'sha256', 'byteLength', 'gateId', 'stateRevision', 'sealPath'];
  if (!member || typeof member !== 'object' || Array.isArray(member)) {
    findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_MEMBER_MALFORMED'));
    return false;
  }
  for (const key of Object.keys(member)) {
    if (!allowed.includes(key)) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_MEMBER_UNKNOWN_FIELD', key));
  }
  const valid = safeRelativePath(member.repoRelativePath)
    && validSha256(member.sha256)
    && validByteLength(member.byteLength)
    && typeof member.gateId === 'string'
    && /^[A-Z][A-Z0-9_-]*$/.test(member.gateId)
    && typeof member.stateRevision === 'string'
    && /^R[0-9]{4}$/.test(member.stateRevision)
    && safeRelativePath(member.sealPath);
  if (!valid) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_MEMBER_MALFORMED'));
  return valid;
}

/**
 * Validate a retrospective exact-byte restoration against the live closed
 * STATE_SEAL inventory and the immutable Git parent/restoration identities.
 *
 * This is a read-only provenance primitive. It never writes evidence, changes
 * a seal, touches the ledger, or treats a later commit as permission to alter
 * the historical bytes. A successful repeat is explicitly idempotent.
 */
export function evaluateExactSealedByteRestoration({
  root,
  authorizedPaths,
  path: repoRelativePath,
  beforeSha256,
  beforeByteLength,
  restoredSha256,
  restoredByteLength,
  restorationCommit,
  parentCommit,
  sealedMember,
  ownerApproved,
  semanticBytesIntroduced,
  resealAttempt,
  ledgerRewriteAttempt,
  historyRewriteAttempt,
  operation
} = {}) {
  const findings = [];
  const requiredFields = [
    ['root', typeof root === 'string' && root.length > 0],
    ['authorizedPaths', Array.isArray(authorizedPaths)],
    ['path', safeRelativePath(repoRelativePath)],
    ['beforeSha256', validSha256(beforeSha256)],
    ['beforeByteLength', validByteLength(beforeByteLength)],
    ['restoredSha256', validSha256(restoredSha256)],
    ['restoredByteLength', validByteLength(restoredByteLength)],
    ['restorationCommit', typeof restorationCommit === 'string' && /^[a-f0-9]{40}$/.test(restorationCommit)],
    ['parentCommit', typeof parentCommit === 'string' && /^[a-f0-9]{40}$/.test(parentCommit)],
    ['ownerApproved', ownerApproved === true],
    ['semanticBytesIntroduced', semanticBytesIntroduced === false],
    ['resealAttempt', typeof resealAttempt === 'boolean'],
    ['ledgerRewriteAttempt', typeof ledgerRewriteAttempt === 'boolean'],
    ['historyRewriteAttempt', typeof historyRewriteAttempt === 'boolean'],
    ['operation', operation === EXACT_SEALED_BYTE_RESTORATION]
  ];
  for (const [field, valid] of requiredFields) {
    if (!valid) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_CONTRACT_MALFORMED', field));
  }
  const sealedMemberValid = validateSealedMemberShape(sealedMember, findings);
  const authorizedValues = Array.isArray(authorizedPaths)
    ? authorizedPaths.map((entry) => typeof entry === 'string' ? entry : entry?.path)
    : [];
  if (!authorizedValues.every((value) => safeRelativePath(value))) {
    findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_AUTHORIZED_PATHS_MALFORMED'));
  }
  if (!authorizedValues.includes(repoRelativePath)) {
    findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_PATH_NOT_AUTHORIZED', repoRelativePath));
  }
  if (resealAttempt === true) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_RESEAL_FORBIDDEN'));
  if (ledgerRewriteAttempt === true) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_LEDGER_REWRITE_FORBIDDEN'));
  if (historyRewriteAttempt === true) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_HISTORY_REWRITE_FORBIDDEN'));

  if (sealedMemberValid) {
    if (sealedMember.repoRelativePath !== repoRelativePath) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_PATH_MISMATCH'));
    if (sealedMember.sha256 !== restoredSha256) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_SHA_MISMATCH'));
    if (sealedMember.byteLength !== restoredByteLength) findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_LENGTH_MISMATCH'));
  }

  let inventory = { members: [], findings: [], matches: [] };
  if (typeof root === 'string' && root.length > 0 && safeRelativePath(repoRelativePath)) {
    inventory = findClosedStateSealMember(root, repoRelativePath);
    for (const inventoryFinding of inventory.findings) {
      findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEAL_INVENTORY_INVALID', inventoryFinding));
    }
    if (!inventory.matches.some((member) => sealedMemberValid && sameSealedMember(member, sealedMember))) {
      findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_MEMBER_NOT_FOUND', repoRelativePath));
    }
    if (inventory.matches.length > 1) {
      findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_SEALED_MEMBER_AMBIGUOUS', repoRelativePath));
    }
  }

  if (typeof root === 'string' && root.length > 0 && safeRelativePath(repoRelativePath) && validSha256(restoredSha256) && validByteLength(restoredByteLength)) {
    try {
      const currentBytes = fs.readFileSync(path.join(root, repoRelativePath));
      if (currentBytes.length !== restoredByteLength || sha256Buffer(currentBytes) !== restoredSha256) {
        findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_CURRENT_BYTES_MISMATCH', repoRelativePath));
      }
    } catch {
      findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_CURRENT_BYTES_UNAVAILABLE', repoRelativePath));
    }
  }

  if (typeof restorationCommit === 'string' && /^[a-f0-9]{40}$/.test(restorationCommit)
      && typeof parentCommit === 'string' && /^[a-f0-9]{40}$/.test(parentCommit)
      && safeRelativePath(repoRelativePath)) {
    if (restorationCommit === parentCommit || directParent(root, restorationCommit) !== parentCommit) {
      findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_PARENT_IDENTITY_MISMATCH'));
    }
    const beforeBytes = readGitBlob(root, parentCommit, repoRelativePath);
    if (!beforeBytes || beforeBytes.length !== beforeByteLength || sha256Buffer(beforeBytes) !== beforeSha256) {
      findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_BEFORE_IDENTITY_MISMATCH'));
    }
    const restoredBytes = readGitBlob(root, restorationCommit, repoRelativePath);
    if (!restoredBytes || restoredBytes.length !== restoredByteLength || sha256Buffer(restoredBytes) !== restoredSha256) {
      findings.push(finding('EXACT_SEALED_BYTE_RESTORATION_RESTORED_IDENTITY_MISMATCH'));
    }
  }

  const decision = findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED';
  return {
    decision,
    operation: EXACT_SEALED_BYTE_RESTORATION,
    idempotent: decision === 'AUTHORIZED',
    findings,
    sealedMemberMatches: inventory.matches
  };
}

/**
 * Enumerate the exact member paths named by every closed revision seal.
 * Invalid closed seal member data is returned as a blocking finding so an
 * authority cannot proceed while the immutability boundary is unknowable.
 */
function addClosedSealMembers(members, findings, seal, gateId, stateRevision, sealPath) {
  const sealId = `${gateId}/${stateRevision}`;
  if (!Array.isArray(seal?.sealedMembers)) {
    findings.push(finding('CLOSED_STATE_SEAL_MEMBERS_INVALID', sealId));
    return;
  }
  for (const [index, member] of seal.sealedMembers.entries()) {
    const memberPath = member?.repoRelativePath;
    if (!safeRelativePath(memberPath) || !/^[a-f0-9]{64}$/.test(String(member?.sha256 || '')) || !Number.isInteger(member?.byteLength) || member.byteLength < 0) {
      findings.push(finding('CLOSED_STATE_SEAL_MEMBER_INVALID', `${sealId}/sealedMembers/${index}`));
      continue;
    }
    members.push({
      repoRelativePath: memberPath,
      sha256: member.sha256,
      byteLength: member.byteLength,
      gateId,
      stateRevision,
      sealPath
    });
  }
}

function finalizeClosedSealInventory(members, findings) {
  const byPath = new Map();
  for (const member of members) {
    const prior = byPath.get(member.repoRelativePath);
    if (prior && (prior.sha256 !== member.sha256 || prior.byteLength !== member.byteLength)) {
      findings.push(finding('CLOSED_STATE_SEAL_MEMBER_CONFLICT', member.repoRelativePath));
    }
    if (!prior) byPath.set(member.repoRelativePath, member);
  }
  return { members, findings };
}

export function collectClosedStateSealMembers(root) {
  const members = [];
  const findings = [];
  const gatesRoot = path.join(root, 'governance', 'gates');
  let gates;
  try {
    gates = fs.readdirSync(gatesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    return { members, findings: [finding('CLOSED_STATE_SEAL_INVENTORY_UNAVAILABLE', error?.message || String(error))] };
  }

  for (const gate of gates.sort((a, b) => a.name.localeCompare(b.name))) {
    const revisionsRoot = path.join(gatesRoot, gate.name, 'state', 'revisions');
    let revisions;
    try {
      revisions = fs.readdirSync(revisionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^R[0-9]{4}$/.test(entry.name));
    } catch {
      continue;
    }
    for (const revision of revisions.sort((a, b) => a.name.localeCompare(b.name))) {
      const sealPath = path.join(revisionsRoot, revision.name, 'STATE_SEAL.json');
      if (!fs.existsSync(sealPath)) continue;
      const seal = readJson(sealPath);
      if (!seal || !hasClosedStatus(seal.payload)) continue;
      if (!Array.isArray(seal.sealedMembers)) {
        findings.push(finding('CLOSED_STATE_SEAL_MEMBERS_INVALID', `${gate.name}/${revision.name}`));
        continue;
      }
      addClosedSealMembers(
        members,
        findings,
        seal,
        seal.gateId,
        seal.stateRevision,
        path.relative(root, sealPath).replaceAll('\\', '/')
      );
    }
  }
  return finalizeClosedSealInventory(members, findings);
}

/**
 * Enumerate the closed seal inventory at an immutable Git pre-state. This is
 * intentionally separate from the live-tree inventory: a successor revision
 * may seal artifacts produced by the authorized transaction, and those bytes
 * must not be mistaken for pre-existing sealed members during consumption.
 */
export function collectClosedStateSealMembersAtCommit(root, commit) {
  const members = [];
  const findings = [];
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    return { members, findings: [finding('CLOSED_STATE_PRESTATE_COMMIT_INVALID', commit)] };
  }
  let sealPaths;
  try {
    sealPaths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'governance/gates'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).split(/\r?\n/).filter((entry) => /^governance\/gates\/[^/]+\/state\/revisions\/R[0-9]{4}\/STATE_SEAL\.json$/.test(entry));
  } catch (error) {
    return { members, findings: [finding('CLOSED_STATE_PRESTATE_INVENTORY_UNAVAILABLE', error?.message || String(error))] };
  }
  for (const sealPath of sealPaths) {
    const match = sealPath.match(/^governance\/gates\/([^/]+)\/state\/revisions\/(R[0-9]{4})\/STATE_SEAL\.json$/);
    if (!match) continue;
    let seal;
    try {
      seal = JSON.parse(execFileSync('git', ['show', `${commit}:${sealPath}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).replace(/^\uFEFF/, ''));
    } catch (error) {
      findings.push(finding('CLOSED_STATE_PRESTATE_SEAL_UNREADABLE', `${sealPath}:${error?.message || String(error)}`));
      continue;
    }
    if (!hasClosedStatus(seal.payload)) continue;
    addClosedSealMembers(members, findings, seal, match[1], match[2], sealPath);
  }
  return finalizeClosedSealInventory(members, findings);
}

export function findClosedStateSealMember(root, repoRelativePath) {
  const inventory = collectClosedStateSealMembers(root);
  return {
    ...inventory,
    matches: inventory.members.filter((member) => member.repoRelativePath === repoRelativePath)
  };
}
