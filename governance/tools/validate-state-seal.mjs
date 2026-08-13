import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical, canonicalize } from './canonical-json.mjs';
import { resolveStateRevisionLineage } from '../gee-v1/core/state-revision-resolver.mjs';

const LEDGER_RELATIVE = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const LEGACY_BINDINGS_RELATIVE = 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json';

/**
 * H3 — the sealed member list gets its own digest, so a member cannot be added,
 * dropped or reordered while every surviving member still hashes correctly.
 * Placed inside `payload` (which is itself hashed by payloadSha256) because the
 * seal document is additionalProperties=false and legacy seals must stay
 * byte-identical.
 */
export function computeSealedMembersDigest(sealedMembers) {
  const rows = (Array.isArray(sealedMembers) ? sealedMembers : [])
    .map((member) => ({ repoRelativePath: member?.repoRelativePath, sha256: member?.sha256, byteLength: member?.byteLength }))
    .sort((a, b) => String(a.repoRelativePath).localeCompare(String(b.repoRelativePath), 'en'));
  return sha256Bytes(Buffer.from(canonicalize(rows), 'utf8'));
}

/**
 * Case-exact resolution. On Windows and macOS the filesystem happily opens
 * `governance/Gates/GATE14/...` for a path that is really `gates`. A seal that
 * binds a path must bind THAT path, not a case-variant of it, or two different
 * declared paths silently verify against one file.
 */
function isCaseExact(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split('/')) {
    let entries;
    try { entries = fs.readdirSync(current); } catch { return false; }
    if (!entries.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return true;
}

/**
 * Reject symlinks, junctions and any other reparse point on the member path,
 * and require the fully resolved real path to stay inside the repository. A
 * sealed member that is a link is not evidence about the bytes it appears to
 * name — it is evidence about wherever the link currently points.
 */
function reparseFinding(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return null; }
    if (stat.isSymbolicLink()) return 'SEALED_MEMBER_REPARSE_POINT';
  }
  try {
    const real = fs.realpathSync(current);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return 'SEALED_MEMBER_ESCAPES_ROOT';
  } catch { return null; }
  return null;
}

function readLedgerEvents(ledgerPath) {
  try {
    return fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch { return null; }
}

function readLegacyBindings(bindingsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(bindingsPath, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(parsed.bindings) ? parsed : null;
  } catch { return null; }
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveOptionPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function finding(findings, detectorId, jsonPointer, actualValue, expectedRule, message, requirementId) {
  findings.push({ detectorId, severity: 'BLOCKING', jsonPointer, actualValue, expectedRule, message, requirementId });
}

function readJson(file, findings, requirementId) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    finding(findings, 'MISSING_SEAL_INPUT', '/', file, 'existing JSON file', 'Required seal input is missing.', requirementId);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    finding(findings, 'INVALID_JSON', '/', file, 'valid JSON', error.message, requirementId);
    return null;
  }
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveMember(root, value, findings, pointer) {
  if (!safeRelative(value)) {
    finding(findings, 'INVALID_NORMALIZED_PATH', pointer, value, 'relative slash-separated path without traversal', 'Sealed member path is unsafe.', 'REQ-SEA-01');
    return null;
  }
  const resolved = path.resolve(root, value);
  const prefix = path.resolve(root) + path.sep;
  if (!resolved.startsWith(prefix)) {
    finding(findings, 'PATH_OUTSIDE_ROOT', pointer, value, 'member below repository root', 'Sealed member escapes the repository root.', 'REQ-SEA-01');
    return null;
  }
  return resolved;
}

function mutableProjectionKind(gateId, memberPath) {
  if (typeof memberPath !== 'string') return null;
  const expectedContract = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  const expectedState = `governance/gates/${gateId}/state/CURRENT_STATE.json`;
  if (memberPath === expectedContract || memberPath.endsWith('/CURRENT_CONTRACT.json')) return { kind: 'CURRENT_CONTRACT', expectedPath: expectedContract };
  if (memberPath === expectedState || memberPath.endsWith('/CURRENT_STATE.json')) return { kind: 'CURRENT_STATE', expectedPath: expectedState };
  return null;
}

function revisionNumber(value) {
  return /^R[0-9]{4}$/.test(String(value || '')) ? Number.parseInt(String(value).slice(1), 10) : null;
}

/**
 * Which revision is CURRENT — asked of the ledger, never of the directory.
 *
 * This replaces the previous maximumRevision() readdir scan. That scan made a
 * directory name an authority: creating `revisions/R9999/` changed whether an
 * older seal was treated as a historical projection, and therefore changed how
 * it was verified. Nothing about verification may depend on what someone
 * managed to mkdir.
 */
function resolveCurrentRevision(root, gateId, revisionRoot) {
  const events = readLedgerEvents(path.join(root, ...LEDGER_RELATIVE.split('/')));
  if (!events) return null;
  const legacy = readLegacyBindings(path.join(root, ...LEGACY_BINDINGS_RELATIVE.split('/')));
  const seals = new Map();
  const presentRevisions = [];
  if (fs.existsSync(revisionRoot)) {
    for (const entry of fs.readdirSync(revisionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^R[0-9]{4}$/.test(entry.name)) continue;
      presentRevisions.push(entry.name);
      const file = path.join(revisionRoot, entry.name, 'STATE_SEAL.json');
      if (!fs.existsSync(file)) continue;
      try {
        const bytes = fs.readFileSync(file);
        const json = JSON.parse(bytes.toString('utf8'));
        seals.set(entry.name, {
          sha256: sha256Bytes(bytes), gateId: json.gateId,
          stateRevision: json.stateRevision, previousStateSealSha256: json.previousStateSealSha256
        });
      } catch { /* unreadable seals are reported by the seal validation itself */ }
    }
  }
  const lineage = resolveStateRevisionLineage({
    gateId, events, legacyBindings: legacy?.bindings ?? [],
    legacyEraMaxOrdinal: legacy?.legacyEraMaxOrdinal ?? undefined,
    seals, presentRevisions
  });
  return lineage.resolved;
}

/**
 * Is this seal superseded? Answered from the SEAL CHAIN: some other seal of the
 * same Gate names this seal's bytes as its predecessor.
 *
 * This is the fallback for trees that have no ledger at all (isolated fixtures,
 * standalone seal checks). It deliberately does NOT reintroduce directory
 * authority: readdir is used only to ENUMERATE candidate seals, and the
 * decision comes from a cryptographic predecessor link, never from name order
 * or from which name sorts highest. Planting `R9999/` with no valid seal
 * changes nothing; planting one that links to this seal is a fork, which the
 * revision layer blocks.
 */
function isSupersededByChain(revisionRoot, sealSha256, gateId) {
  if (!sealSha256 || !fs.existsSync(revisionRoot)) return false;
  for (const entry of fs.readdirSync(revisionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^R[0-9]{4}$/.test(entry.name)) continue;
    const candidate = path.join(revisionRoot, entry.name, 'STATE_SEAL.json');
    if (!fs.existsSync(candidate)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (json.gateId === gateId && json.previousStateSealSha256 === sealSha256) return true;
    } catch { /* unreadable candidates cannot supersede anything */ }
  }
  return false;
}

function validateStateSeal({ root, sealPath, currentRevision = undefined }) {
  const findings = [];
  const seal = readJson(sealPath, findings, 'REQ-SEA-01');
  if (!seal) return { valid: false, blockingCount: findings.length, findings, sealPath };
  const required = ['schemaVersion', 'gateId', 'stateRevision', 'sealedMembers', 'previousStateSealSha256', 'sealedAt', 'payload', 'payloadSha256'];
  const allowed = new Set(required);
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(seal, field)) finding(findings, 'SCHEMA_VIOLATION', '/', field, 'required property', `STATE_SEAL is missing ${field}.`, 'REQ-SEA-01');
  for (const field of Object.keys(seal)) if (!allowed.has(field)) finding(findings, 'SCHEMA_VIOLATION', `/${field}`, seal[field], 'additionalProperties=false', `STATE_SEAL contains unknown field ${field}.`, 'REQ-SEA-01');
  if (typeof seal.stateRevision !== 'string' || !/^R[0-9]{4}$/.test(seal.stateRevision)) finding(findings, 'INVALID_REVISION_ID', '/stateRevision', seal.stateRevision, 'Rxxxx', 'Seal revision is not versioned.', 'REQ-SEA-01');
  if (!Array.isArray(seal.sealedMembers)) finding(findings, 'SCHEMA_VIOLATION', '/sealedMembers', seal.sealedMembers, 'array', 'sealedMembers must be an array.', 'REQ-SEA-01');
  if (seal.payload === null || typeof seal.payload !== 'object' || Array.isArray(seal.payload)) finding(findings, 'SCHEMA_VIOLATION', '/payload', seal.payload, 'object', 'Seal payload must be an object.', 'REQ-CJS-03');
  else if (sha256Canonical(seal.payload) !== seal.payloadSha256) finding(findings, 'PAYLOAD_HASH_MISMATCH', '/payloadSha256', seal.payloadSha256, sha256Canonical(seal.payload), 'payloadSha256 is not recalculated from the real payload.', 'REQ-CJS-03');

  const rootResolved = path.resolve(root);
  const sealRelative = path.relative(rootResolved, sealPath).replaceAll('\\', '/');
  const revisionDir = path.dirname(sealPath);
  const expectedRevisionDir = path.basename(revisionDir);

  // The seal must live at its canonical location: <gate>/state/revisions/<Rxxxx>/STATE_SEAL.json,
  // with the directory naming the very revision the seal declares. A seal that
  // has been relocated — including into another Gate — is not evidence about
  // the revision it claims.
  const expectedSealRelative = `governance/gates/${seal.gateId}/state/revisions/${seal.stateRevision}/STATE_SEAL.json`;
  if (sealRelative !== expectedSealRelative) {
    finding(findings, 'SEAL_NOT_AT_CANONICAL_LOCATION', '/', sealRelative, expectedSealRelative, 'STATE_SEAL must live at its canonical gate-local revision path.', 'REQ-SEA-03');
  }
  if (expectedRevisionDir !== seal.stateRevision) {
    finding(findings, 'SEAL_REVISION_DIRECTORY_MISMATCH', '/stateRevision', seal.stateRevision, expectedRevisionDir, 'Seal revision must equal its own directory name.', 'REQ-SEA-01');
  }

  const resolvedCurrent = currentRevision === undefined
    ? resolveCurrentRevision(rootResolved, seal.gateId, path.dirname(revisionDir))
    : currentRevision;
  // A superseded revision's MUTABLE PROJECTION members legitimately no longer
  // hold the sealed bytes; its IMMUTABLE members always must.
  //
  // The ledger is the preferred authority. Where there is no ledger to ask, the
  // seal chain answers instead — never the directory listing.
  const ownSealSha256 = sha256Bytes(fs.readFileSync(sealPath));
  const historicalProjection = resolvedCurrent
    ? seal.stateRevision !== resolvedCurrent
    : isSupersededByChain(path.dirname(revisionDir), ownSealSha256, seal.gateId);

  // H3 — sealed member set integrity. Verified whenever declared; not required
  // of legacy seals, which must stay byte-identical forever.
  if (seal.payload && Object.hasOwn(seal.payload, 'sealedMembersDigest')) {
    const expected = computeSealedMembersDigest(seal.sealedMembers);
    if (seal.payload.sealedMembersDigest !== expected) {
      finding(findings, 'SEALED_MEMBERS_DIGEST_MISMATCH', '/payload/sealedMembersDigest', seal.payload.sealedMembersDigest, expected, 'sealedMembersDigest must be recomputed from the real sealed member set.', 'REQ-SEA-01');
    }
  }
  const members = new Set();
  let hasCheckpoint = false;
  let hasDefects = false;
  let hasContract = false;
  for (const [index, member] of (seal.sealedMembers || []).entries()) {
    const pointer = `/sealedMembers/${index}`;
    if (!member || typeof member !== 'object') {
      finding(findings, 'SCHEMA_VIOLATION', pointer, member, 'object', 'Sealed member must be an object.', 'REQ-SEA-01');
      continue;
    }
    const memberPath = member.repoRelativePath;
    const projection = mutableProjectionKind(seal.gateId, memberPath);
    if (projection && memberPath !== projection.expectedPath) finding(findings, 'HISTORICAL_TARGET_PATH_MISMATCH', `${pointer}/repoRelativePath`, memberPath, projection.expectedPath, 'Mutable projection path is gate-local and exact.', 'REQ-SEA-03');
    if (typeof memberPath === 'string' && memberPath.includes(`/contracts/`) && memberPath !== `governance/gates/${seal.gateId}/contracts/CURRENT_CONTRACT.json`) finding(findings, 'HISTORICAL_TARGET_PATH_MISMATCH', `${pointer}/repoRelativePath`, memberPath, `governance/gates/${seal.gateId}/contracts/CURRENT_CONTRACT.json`, 'State seals must bind the gate-local current contract projection, not an unrelated contract artifact.', 'REQ-SEA-03');
    if (typeof memberPath === 'string' && memberPath.startsWith('governance/gee-v1/')) finding(findings, 'GEE_R8_PATH_FORBIDDEN', `${pointer}/repoRelativePath`, memberPath, 'no GEE path in state seal', 'State seals cannot depend on GEE infrastructure.', 'REQ-SEA-03');
    if (memberPath?.endsWith('/STATE_SEAL.json') || memberPath === 'STATE_SEAL.json') finding(findings, 'SELF_HASH_RECURSION', `${pointer}/repoRelativePath`, memberPath, 'STATE_SEAL.json excluded from sealedMembers', 'STATE_SEAL cannot seal itself.', 'REQ-CJS-03');
    if (members.has(memberPath)) finding(findings, 'DUPLICATE_SEALED_MEMBER', `${pointer}/repoRelativePath`, memberPath, 'unique sealed member path', 'A sealed member is listed twice.', 'REQ-SEA-01');
    members.add(memberPath);
    if (typeof memberPath === 'string' && memberPath.endsWith('/CHECKPOINT.json')) hasCheckpoint = true;
    if (typeof memberPath === 'string' && memberPath.endsWith('/OPEN_DEFECTS.json')) hasDefects = true;
    if (typeof memberPath === 'string' && memberPath.includes('/contracts/')) hasContract = true;
    const target = resolveMember(rootResolved, memberPath, findings, `${pointer}/repoRelativePath`);
    if (!target) continue;
    // Case-exactness and reparse rejection are checked BEFORE any byte is read,
    // so a link or a case-variant can never supply the bytes that get hashed.
    if (fs.existsSync(target) && !isCaseExact(rootResolved, memberPath)) {
      finding(findings, 'SEALED_MEMBER_PATH_CASE_MISMATCH', `${pointer}/repoRelativePath`, memberPath, 'case-exact repository path', 'Sealed member path differs from the real on-disk name by case.', 'REQ-SEA-01');
      continue;
    }
    const reparse = reparseFinding(rootResolved, memberPath);
    if (reparse) {
      finding(findings, reparse, `${pointer}/repoRelativePath`, memberPath, 'regular file inside the repository, no reparse point', 'Sealed member resolves through a link or outside the repository.', 'REQ-SEA-01');
      continue;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      finding(findings, historicalProjection && projection ? 'HISTORICAL_PROJECTION_BYTES_UNAVAILABLE' : 'STATE_SEAL_MEMBER_MISMATCH', `${pointer}/repoRelativePath`, memberPath, 'existing regular file', 'Sealed member is absent.', historicalProjection && projection ? 'REQ-SEA-03' : 'REQ-SEA-01');
      continue;
    }
    const bytes = fs.readFileSync(target);
    const actualSha = sha256Bytes(bytes);
    if (historicalProjection && projection) {
      if (!/^[a-f0-9]{64}$/.test(String(member.sha256 || '')) || !Number.isInteger(member.byteLength) || member.byteLength < 0) finding(findings, 'HISTORICAL_PROJECTION_BINDING_INVALID', pointer, member, 'historical SHA-256 and byteLength', 'Historical mutable projection identity is malformed.', 'REQ-SEA-03');
    } else if (actualSha !== member.sha256 || bytes.length !== member.byteLength) finding(findings, 'STATE_SEAL_MEMBER_MISMATCH', pointer, { sha256: member.sha256, byteLength: member.byteLength }, { sha256: actualSha, byteLength: bytes.length }, 'Sealed member hash and length match real bytes.', 'REQ-SEA-01');
    const currentRevision = path.basename(path.dirname(target));
    if (memberPath?.includes('/state/revisions/') && currentRevision !== expectedRevisionDir) finding(findings, 'CROSS_REVISION_MEMBER', pointer, memberPath, `member belongs to ${expectedRevisionDir}`, 'Seal references a mutable or different revision.', 'REQ-SEA-01');
  }
  if (!hasCheckpoint) finding(findings, 'STATE_SEAL_MEMBER_MISSING', '/sealedMembers', seal.sealedMembers, 'same revision CHECKPOINT.json', 'Seal does not include CHECKPOINT.json.', 'REQ-SEA-01');
  if (!hasDefects) finding(findings, 'STATE_SEAL_MEMBER_MISSING', '/sealedMembers', seal.sealedMembers, 'same revision OPEN_DEFECTS.json', 'Seal does not include OPEN_DEFECTS.json.', 'REQ-SEA-01');
  if (!hasContract) finding(findings, 'STATE_SEAL_MEMBER_MISSING', '/sealedMembers', seal.sealedMembers, 'current contract reference', 'Seal does not include the current contract reference.', 'REQ-SEA-01');
  const sealRevisionNumber = Number.parseInt(seal.stateRevision?.slice(1), 10);
  const previous = seal.previousStateSealSha256;
  if (sealRevisionNumber === 1 && previous !== null) finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, null, 'R0001 must have no previous seal.', 'REQ-SEA-02');
  if (sealRevisionNumber > 1) {
    if (typeof previous !== 'string') finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, 'SHA-256 of previous STATE_SEAL.json', 'A non-bootstrap revision must link a previous seal.', 'REQ-SEA-02');
    else {
      const previousPath = path.join(revisionDir, '..', `R${String(sealRevisionNumber - 1).padStart(4, '0')}`, 'STATE_SEAL.json');
      if (!fs.existsSync(previousPath)) finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, 'existing previous revision seal', 'Previous revision seal is absent.', 'REQ-SEA-02');
      else {
        const actualPrevious = sha256Bytes(fs.readFileSync(previousPath));
        if (actualPrevious !== previous) finding(findings, 'STATE_SEAL_CHAIN_ERROR', '/previousStateSealSha256', previous, actualPrevious, 'previousStateSealSha256 links the previous seal bytes.', 'REQ-SEA-02');
      }
    }
  }
  return { valid: findings.length === 0, blockingCount: findings.length, findings, sealPath: sealRelative, stateRevision: seal.stateRevision };
}

export { validateStateSeal };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const sealPath = resolveOptionPath(root, option('--seal', path.join(root, 'governance/gates/GATE13/state/revisions/R0001/STATE_SEAL.json')));
  const report = validateStateSeal({ root, sealPath });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
