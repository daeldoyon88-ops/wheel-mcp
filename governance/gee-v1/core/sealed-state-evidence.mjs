/**
 * Generic inventory of evidence sealed by closed state revisions.
 *
 * The inventory is deliberately read-only. A maintenance authority may use it
 * to reject a path before apply, but it never rewrites a seal or its members.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CLOSED_REVISION_STATUSES = Object.freeze([
  'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED',
  'CLOSED'
]);

const CLOSED_STATUS_SET = new Set(CLOSED_REVISION_STATUSES);
const SAFE_RELATIVE_RE = /^[^\\/][^\\]*$/;

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

/**
 * Enumerate the exact member paths named by every closed revision seal.
 * Invalid closed seal member data is returned as a blocking finding so an
 * authority cannot proceed while the immutability boundary is unknowable.
 */
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
      const sealId = `${gate.name}/${revision.name}`;
      if (!Array.isArray(seal.sealedMembers)) {
        findings.push(finding('CLOSED_STATE_SEAL_MEMBERS_INVALID', sealId));
        continue;
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
          gateId: seal.gateId,
          stateRevision: seal.stateRevision,
          sealPath: path.relative(root, sealPath).replaceAll('\\', '/')
        });
      }
    }
  }

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

export function findClosedStateSealMember(root, repoRelativePath) {
  const inventory = collectClosedStateSealMembers(root);
  return {
    ...inventory,
    matches: inventory.members.filter((member) => member.repoRelativePath === repoRelativePath)
  };
}
