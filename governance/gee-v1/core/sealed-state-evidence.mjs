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

import { validateStateSeal } from '../../tools/validate-state-seal.mjs';
import { authenticateCanonicalLedgerHistory } from '../../tools/canonical-ledger-authority.mjs';
import { verifyLedgerText } from './verified-ledger-evidence.mjs';
import {
  resolveStateRevisionLineage,
  ANCHOR_LEDGER,
  LEGACY_ERA_MAX_ORDINAL
} from './state-revision-resolver.mjs';
import { validateLegacyStateBindingsDocument } from './legacy-state-binding.mjs';
import {
  CLOSED_REVISION_STATUSES,
  CLOSED_REVISION_STATUS_SET
} from './closed-revision-status.mjs';

/**
 * The closed-status vocabulary now lives in its own leaf module, and is
 * re-exported here UNCHANGED.
 *
 * This module has always been the published home of `CLOSED_REVISION_STATUSES`
 * (see checkpoints/CP-GFG-A-BASELINE-PLAN-FROZEN.json, which records that exact
 * export), so the name stays on this module's public surface and every existing
 * importer keeps working. What moved is only WHERE the three strings are defined:
 * post-freeze-maintenance-authority imported them from here, and the canonical
 * ledger validator imports post-freeze-maintenance-authority — so that edge is
 * what made `validate-status-ledger` unreachable from this file without an import
 * cycle. Authenticating a seal lineage against canonically authorized ledger
 * history requires precisely that import. See closed-revision-status.mjs.
 */
export { CLOSED_REVISION_STATUSES };

const CLOSED_STATUS_SET = CLOSED_REVISION_STATUS_SET;
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

/* ========================================================================== *
 * AUTHENTICATED closed-state seal inventory.
 *
 * WHY A SECOND INVENTORY EXISTS, AND WHY IT MUST.
 *
 * `collectClosedStateSealMembers` above answers a REFUSAL question: "might this
 * path be sealed?" Its only consumer duty is to stop a publisher from mutating a
 * sealed member, so its correct failure direction is INCLUSIVE — a seal-shaped
 * document that names a path is reason enough to refuse, and narrowing it would
 * weaken the SEALED_MEMBER_MUTATION guard. It is deliberately left unchanged.
 *
 * This function answers the OPPOSITE question: "may this seal PROVE the bytes a
 * path holds right now?" That is an authorization question, and its correct
 * failure direction is EXCLUSIVE. Feeding the refusal inventory to an authorizer
 * inverted the trust direction of every check in it, and produced exactly one
 * defect class:
 *
 *     a path reported BLOCKED / NO_APPLICABLE_AUTHORITY became
 *     AUTHORIZED_CURRENT_BYTES as soon as ANY file appeared at
 *     governance/gates/<G>/state/revisions/<Rxxxx>/STATE_SEAL.json whose payload
 *     contained a closed-looking string anywhere and whose sealedMembers named
 *     the path at its CURRENT digest.
 *
 * Nothing in that document had to be true. It needed no payloadSha256, no
 * sealedMembersDigest, no seal chain, no ledger, no gate that exists. Writing the
 * file was the whole proof. A "seal" that certifies whatever it is handed is not
 * evidence about bytes; it is a restatement of them.
 *
 * WHAT AUTHENTICATION MEANS HERE. Four independent canonical primitives, each
 * already the repository's single definition of its own question, and none of
 * them re-implemented:
 *
 *   verifyLedgerText              are the ledger bytes an intact canonical chain?
 *   validateLegacyStateBindingsDocument   is the legacy interpretation record sound?
 *   resolveStateRevisionLineage   which revisions does that ledger actually bind,
 *                                 and is this gate ledger-anchored at all?
 *   validateStateSeal             is this exact seal canonically valid — schema,
 *                                 payloadSha256, sealedMembersDigest, canonical
 *                                 location, revision-directory identity, member
 *                                 bytes, and previous-seal chain?
 *
 * A seal contributes members only where ALL of them agree. There is no local
 * notion of "valid state seal" in this module and none may be added: every
 * verdict below is a verdict one of those four returned.
 *
 * THE LEDGER ANCHOR IS THE LOAD-BEARING PART. Canonical seal validity alone is
 * NOT sufficient and must not be mistaken for sufficiency. `validateStateSeal`
 * verifies a seal against the bytes on disk, so anyone able to write files can
 * manufacture a seal that passes it: create R000N+1 with its own CHECKPOINT and
 * OPEN_DEFECTS, link previousStateSealSha256 to the real predecessor, recompute
 * both digests, and name any path at its current digest. Self-consistency is
 * cheap. What cannot be manufactured is the append-only ledger's pin of the seal
 * bytes. So eligibility is restricted to revisions on the lineage that
 * `resolveStateRevisionLineage` resolves from the LEDGER (ANCHOR_LEDGER): the
 * head seal's digest is pinned by an event, and every predecessor is pinned
 * cryptographically by the successor's previousStateSealSha256. A planted
 * revision is not on that chain — it is reported as an orphan — and therefore
 * proves nothing.
 *
 * A gate in the PRE-BINDING era (its events never bound a revision and no legacy
 * record claims one) resolves its head from the seal chain alone. That chain is
 * self-certifying and a planted successor can extend it, so such a gate is
 * refused as a source of current-byte authorization rather than admitted on a
 * weaker claim it cannot carry. Its seals keep every other role they have.
 *
 * CLOSED STATE IS READ FROM THE SEAL'S OWN STATUS FIELD, not by scanning the
 * payload for a closed-looking string. The recursive scan used by the refusal
 * inventory is right for refusal — err toward "this might be sealed" — and wrong
 * here: it classified GATE12's R0001/R0002 as CLOSED because an unrelated payload
 * field happened to hold the text 'COMPLETE_CONFIRMED', when neither seal
 * declares a closed execution status at all. Under authorization that is a
 * fabricated closed status, so `payload.executionStatus` is required to BE one of
 * CLOSED_REVISION_STATUSES.
 *
 * HISTORICAL MUTABLE PROJECTIONS ARE NOT PROMOTED. `validateStateSeal` verifies a
 * superseded revision's CURRENT_STATE / CURRENT_CONTRACT members for SHAPE only —
 * correctly, since a pointer's sealed digest is a historical fact and its current
 * bytes are supposed to have moved on. Those digests are therefore not something
 * the validator proved about the bytes there now, and MODEL D forbids pinning a
 * MUTABLE_PROJECTION permanently in any case. They are contributed only by the
 * seal of the revision the ledger resolves as CURRENT, where the validator does
 * compare real bytes.
 *
 * CONFLICTS DROP THE PATH. Two authenticated seals naming one path at different
 * digests is a contradiction between two governed records. The path contributes
 * NOTHING — never the first one found.
 * ========================================================================== */

export const AUTHENTICATED_CLOSED_STATE_SEAL_INVENTORY = 'AUTHENTICATED_CLOSED_STATE_SEAL_INVENTORY';

const LEDGER_RELATIVE_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const LEGACY_BINDINGS_RELATIVE_PATH = 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json';

/**
 * The two gate-local pointer paths a state seal may name. Same paths
 * `validate-state-seal.mjs` treats as mutable projections, expressed the way the
 * rest of core already expresses them (see canonical-authorized-cohort.mjs). This
 * is a path template, not a second opinion about seal validity.
 */
function gateLocalProjectionPaths(gateId) {
  return new Set([
    `governance/gates/${gateId}/state/CURRENT_STATE.json`,
    `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`
  ]);
}

function readFileTextOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function sealIdentityMap(revisionsRoot) {
  const seals = new Map();
  const presentRevisions = [];
  let entries;
  try {
    entries = fs.readdirSync(revisionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^R[0-9]{4}$/.test(entry.name));
  } catch { return { seals, presentRevisions }; }
  for (const entry of entries) {
    presentRevisions.push(entry.name);
    const file = path.join(revisionsRoot, entry.name, 'STATE_SEAL.json');
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { continue; }
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { continue; }
    seals.set(entry.name, {
      sha256: sha256Buffer(bytes),
      gateId: parsed.gateId,
      stateRevision: parsed.stateRevision,
      previousStateSealSha256: parsed.previousStateSealSha256
    });
  }
  return { seals, presentRevisions };
}

function untrustedInventory(findings, refusals = []) {
  return {
    document: AUTHENTICATED_CLOSED_STATE_SEAL_INVENTORY,
    authenticated: false,
    members: [],
    findings,
    refusals
  };
}

/**
 * Every closed-state seal member whose seal is provably part of the governed,
 * ledger-anchored history AND canonically valid, and whose bytes that validation
 * actually compared.
 *
 * @returns {{ document: string, authenticated: boolean,
 *   members: Array<{repoRelativePath: string, sha256: string, byteLength: number,
 *                   gateId: string, stateRevision: string, sealPath: string}>,
 *   findings: Array<{code: string, detail?: unknown}>,
 *   refusals: Array<{code: string, detail?: unknown}> }}
 *
 * `authenticated === false` means the trust source itself could not be
 * established. Members are empty in that case and a consumer must not fall back
 * to the refusal inventory to fill the gap.
 */
export function collectAuthenticatedClosedStateSealMembers(root) {
  const findings = [];
  const refusals = [];

  /* ---- 1. The ledger must be an intact canonical chain ------------------ */
  const ledgerText = readFileTextOrNull(path.join(root, ...LEDGER_RELATIVE_PATH.split('/')));
  if (ledgerText === null) {
    return untrustedInventory([finding('AUTHENTICATED_CLOSED_STATE_SEAL_LEDGER_UNAVAILABLE', LEDGER_RELATIVE_PATH)]);
  }
  const ledger = verifyLedgerText(ledgerText);
  if (!ledger.verified) {
    return untrustedInventory([finding(
      'AUTHENTICATED_CLOSED_STATE_SEAL_LEDGER_EVIDENCE_INVALID',
      [...new Set(ledger.findings.map((entry) => entry.code))].sort().join(',')
    )]);
  }

  /* ---- 1b. ...AND that chain must be a CANONICALLY AUTHORIZED history ---- */
  //
  // THE DEFECT THIS CLAUSE CLOSES, STATED AS THE REPRODUCED ATTACK.
  //
  // Step 1 above proves CHAIN INTEGRITY and nothing else. Every digest it checks
  // is computed by whoever writes the file, so an author who controls the ledger
  // controls them too:
  //
  //     SELF-HASH IS NOT AUTHENTICITY.
  //     A COHERENT HASH CHAIN IS NOT A CANONICALLY AUTHORIZED HISTORY.
  //
  // Reproduced from live bytes in a disposable clone: take a path reported
  // BLOCKED / NO_APPLICABLE_AUTHORITY, mint a state-binding event pinning a new
  // revision, RECHAIN the whole ledger so every ordinal and digest is correct,
  // and plant a STATE_SEAL for that revision naming the path at its CURRENT
  // digest. `verifyLedgerText` returned verified, `validateStateSeal` returned
  // valid, `resolveStateRevisionLineage` reported the planted revision as
  // LEDGER-ANCHORED — because the ledger really did pin it — and the path became
  // AUTHORIZED_CURRENT_BYTES. Meanwhile the canonical ledger validator reported
  // the transition as unauthorized. The repository held two answers over one set
  // of bytes, and the one gating byte authorization had checked no authority.
  //
  // The comment block above still says the ledger's pin "cannot be manufactured".
  // That was the load-bearing assumption and it was false: it is true only of a
  // ledger somebody has actually validated. So the pin is now required to come
  // from a history the CANONICAL VALIDATOR accepts.
  //
  // NO SECOND VALIDATOR. `authenticateCanonicalLedgerHistory` calls the very
  // `validateLedger` the validate-status-ledger CLI calls, with the same project
  // policy, in LEDGER_INTEGRITY mode ("was this history validly written?" — not
  // "do today's mutable projections agree?", which is a different question and
  // whose fusion with this one is itself a recorded defect). Transition legality,
  // authority binding, anchor clauses, authorization/start replay and successor
  // rules are consulted in their single normative implementation; none of them is
  // restated here.
  //
  // NO FALLBACK. If canonical authority cannot be established there is no such
  // thing as a proven seal member below this root, so the inventory is refused
  // whole. Reading the chain-only result "anyway" is precisely the defect.
  const ledgerAuthority = authenticateCanonicalLedgerHistory({ root });
  if (!ledgerAuthority.authorized) {
    return untrustedInventory([finding(
      'AUTHENTICATED_CLOSED_STATE_SEAL_LEDGER_AUTHORITY_INVALID',
      `${ledgerAuthority.reason}:${ledgerAuthority.detail ?? ''}`
    )]);
  }
  // Both layers must be describing the SAME artifact. They read the file
  // independently, so a disagreement about how many events it holds means one of
  // them is reasoning about bytes the other never saw; that is never resolved by
  // preferring either answer.
  if (ledgerAuthority.eventCount !== ledger.eventCount) {
    return untrustedInventory([finding(
      'AUTHENTICATED_CLOSED_STATE_SEAL_LEDGER_AUTHORITY_DISAGREEMENT',
      `${ledger.eventCount}!=${ledgerAuthority.eventCount}`
    )]);
  }

  /* ---- 2. Legacy interpretation records, if any ------------------------- */
  //
  // Absent is fine — most gates never needed one. PRESENT BUT INVALID is not:
  // the era boundary would then rest on a record nothing had checked, so the
  // whole inventory is refused rather than resolved without it.
  let legacyBindings = [];
  let legacyEraMaxOrdinal = LEGACY_ERA_MAX_ORDINAL;
  const legacyFile = path.join(root, ...LEGACY_BINDINGS_RELATIVE_PATH.split('/'));
  if (fs.existsSync(legacyFile)) {
    const legacyDocument = readJson(legacyFile);
    const legacyReport = validateLegacyStateBindingsDocument(legacyDocument);
    if (!legacyReport.valid) {
      return untrustedInventory([finding(
        'AUTHENTICATED_CLOSED_STATE_SEAL_LEGACY_BINDINGS_INVALID',
        [...new Set(legacyReport.findings.map((entry) => entry.code))].sort().join(',')
      )]);
    }
    legacyBindings = legacyDocument.bindings;
    legacyEraMaxOrdinal = legacyDocument.legacyEraMaxOrdinal;
  }

  /* ---- 3. Per gate: ledger-anchored lineage, then canonical seal validity */
  const members = [];
  const gatesRoot = path.join(root, 'governance', 'gates');
  let gates;
  try {
    gates = fs.readdirSync(gatesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    return untrustedInventory([finding('AUTHENTICATED_CLOSED_STATE_SEAL_INVENTORY_UNAVAILABLE', error?.message || String(error))]);
  }

  for (const gate of gates.sort((a, b) => a.name.localeCompare(b.name))) {
    const gateId = gate.name;
    const revisionsRoot = path.join(gatesRoot, gateId, 'state', 'revisions');
    const { seals, presentRevisions } = sealIdentityMap(revisionsRoot);
    if (seals.size === 0) continue;

    // The events come from the CANONICALLY AUTHORIZED report, not from the
    // chain-only verification. Both parsed the same file, but only one of them
    // established that these events were lawfully written, and the positive trust
    // chain must descend from that one.
    const lineage = resolveStateRevisionLineage({
      gateId, events: ledgerAuthority.events, legacyBindings, legacyEraMaxOrdinal, seals, presentRevisions
    });

    // A gate whose revisions the ledger never bound cannot lend authorization
    // weight to anything. Reported, never silently skipped.
    if (lineage.anchorState !== ANCHOR_LEDGER) {
      refusals.push(finding('AUTHENTICATED_CLOSED_STATE_SEAL_LINEAGE_NOT_LEDGER_ANCHORED', gateId));
      continue;
    }
    // Orphan revisions, forks, rollbacks, broken or cross-gate chains: any one of
    // them means "which seals belong to this gate's history" is not knowable, and
    // a planted revision is exactly what an orphan finding reports.
    if (lineage.findings.length > 0) {
      findings.push(finding(
        'AUTHENTICATED_CLOSED_STATE_SEAL_LINEAGE_INVALID',
        `${gateId}:${[...new Set(lineage.findings.map((entry) => entry.code))].sort().join(',')}`
      ));
      continue;
    }

    const projections = gateLocalProjectionPaths(gateId);
    for (const stateRevision of lineage.sealChain) {
      const sealFile = path.join(revisionsRoot, stateRevision, 'STATE_SEAL.json');
      const sealPath = path.relative(root, sealFile).replaceAll('\\', '/');
      const sealId = `${gateId}/${stateRevision}`;

      // THE canonical seal validator. `currentRevision` is supplied from the
      // ledger-anchored lineage resolved above so the two layers cannot form two
      // opinions about which revision is current.
      const report = validateStateSeal({ root, sealPath: sealFile, currentRevision: lineage.resolved });
      if (!report.valid) {
        findings.push(finding(
          'AUTHENTICATED_CLOSED_STATE_SEAL_NOT_CANONICALLY_VALID',
          `${sealPath}:${[...new Set(report.findings.map((entry) => entry.detectorId))].sort().join(',')}`
        ));
        continue;
      }

      const seal = readJson(sealFile);
      if (!seal) {
        findings.push(finding('AUTHENTICATED_CLOSED_STATE_SEAL_UNREADABLE', sealPath));
        continue;
      }
      // Identity is taken from the LOCATION and required to equal the claim.
      // validateStateSeal already blocks a relocated or misdeclared seal; this
      // states the same invariant at the point the member record is built, so a
      // member can never carry an identity the location does not support.
      if (seal.gateId !== gateId || seal.stateRevision !== stateRevision) {
        findings.push(finding('AUTHENTICATED_CLOSED_STATE_SEAL_IDENTITY_MISMATCH', sealPath));
        continue;
      }
      // Closed state, from the seal's own execution status. Not closed is an
      // ordinary fact about most revisions, so it is a refusal, not a finding.
      if (!CLOSED_STATUS_SET.has(seal.payload?.executionStatus)) {
        refusals.push(finding('AUTHENTICATED_CLOSED_STATE_SEAL_NOT_CLOSED', sealId));
        continue;
      }

      const contributed = [];
      let sealUsable = true;
      for (const [index, member] of (seal.sealedMembers ?? []).entries()) {
        const memberPath = member?.repoRelativePath;
        if (!safeRelativePath(memberPath) || !validSha256(member?.sha256) || !validByteLength(member?.byteLength)) {
          // Unreachable while the seal is canonically valid; if it ever is
          // reached the two layers disagree, and the seal is dropped whole.
          findings.push(finding('AUTHENTICATED_CLOSED_STATE_SEAL_MEMBER_INVALID', `${sealId}/sealedMembers/${index}`));
          sealUsable = false;
          break;
        }
        if (projections.has(memberPath) && stateRevision !== lineage.resolved) {
          refusals.push(finding('AUTHENTICATED_CLOSED_STATE_SEAL_HISTORICAL_PROJECTION_NOT_PROMOTED', `${sealId}:${memberPath}`));
          continue;
        }
        contributed.push({
          repoRelativePath: memberPath,
          sha256: member.sha256,
          byteLength: member.byteLength,
          gateId,
          stateRevision,
          sealPath
        });
      }
      if (sealUsable) members.push(...contributed);
    }
  }

  /* ---- 4. Contradiction between two governed records drops the path ----- */
  const byPath = new Map();
  const conflicted = new Set();
  for (const member of members) {
    const prior = byPath.get(member.repoRelativePath);
    if (prior && (prior.sha256 !== member.sha256 || prior.byteLength !== member.byteLength)) {
      findings.push(finding('AUTHENTICATED_CLOSED_STATE_SEAL_MEMBER_CONFLICT', member.repoRelativePath));
      conflicted.add(member.repoRelativePath);
    }
    if (!prior) byPath.set(member.repoRelativePath, member);
  }

  return {
    document: AUTHENTICATED_CLOSED_STATE_SEAL_INVENTORY,
    authenticated: true,
    members: members.filter((member) => !conflicted.has(member.repoRelativePath)),
    findings,
    refusals
  };
}
