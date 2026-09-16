/**
 * Project-agnostic, owner-rooted successor authority for execution contracts.
 *
 * This primitive authorizes one exact CURRENT_CONTRACT switch. It never grants
 * START, execution, closure, ledger, GEE, or arbitrary governance authority.
 * The predecessor is content-addressed and immutable; the owner signs the
 * exact request/record bindings and the exact successor bytes by SHA-256.
 *
 * TWO MODES, ONE PRIMITIVE.
 *
 *   LEGACY_SIGNED_AUTHORITY  — the historical external request + owner-signed
 *                              authority pair. Byte-for-byte unchanged: an
 *                              existing document that names no `authorityMode`
 *                              resolves here and validates exactly as before,
 *                              signature verification included.
 *
 *   LOCAL_EXPLICIT_AUTHORITY — the project's standing policy for NEW authority
 *                              (see post-freeze-maintenance-authority.mjs): no
 *                              PKI, no private key, no signature. The mode
 *                              constants, the forbidden-signature-field rule and
 *                              the mode validator are all REUSED from that
 *                              module rather than reimplemented, so there is one
 *                              authority-mode vocabulary in the system.
 *
 * WHY THE LOCAL MODE EXISTS HERE. This project operates no PKI. The signed route
 * therefore made CURRENT_CONTRACT_SWITCH unreachable for every future Gate, while
 * the one succession that actually happened — GATE14 R0001 -> R0002 — was
 * authorized by a LOCAL_EXPLICIT_AUTHORITY document this primitive could not read
 * (governance/historical-architecture/CONTRACT_SUCCESSION_R0002_LOCAL_AUTHORITY.json,
 * pinned by historical-architecture-h7-contract-succession.test.mjs). The local
 * mode below is that established document family, bound to this primitive's exact
 * contract instead of being checked by hand.
 *
 * WHAT REPLACES THE SIGNATURE. Nothing is relaxed. Every binding this primitive
 * already enforced still runs in local mode — predecessor and successor path/SHA,
 * CURRENT_CONTRACT pointer bytes, revision lineage, the exact authorized delta and
 * its digest, the exact authorized-path set, the ledger head triple, the base
 * commit, maxUse = 1 and the replay blocker. A signature proves WHO wrote a
 * document; it proves nothing about WHICH repository state that document is valid
 * against, which is the property that matters for a single-use switch. What is
 * removed is the external key; what takes its place is a self-binding
 * `approvedRequestDigest` over the authority's own bindings, plus an exact-set
 * prohibition list.
 *
 * NO SIGNATURE FALLBACK. Signature material is not optional in local mode, it is
 * REJECTED (SIGNATURE_MATERIAL_NOT_PERMITTED, plus AUTHORITY_UNKNOWN_FIELD), so a
 * forged document cannot claim authority by carrying a key id and a signature the
 * local mode never checks. Local mode is reachable ONLY by naming `authorityMode`
 * explicitly; absence still resolves to the signed branch.
 *
 * NEITHER MODE GRANTS MORE. Both return startAuthorized / executionAuthorized /
 * closureAuthorized false, both refuse a candidate ledger whose bytes moved
 * (LEDGER_MUTATION_NOT_AUTHORIZED), and both confine writes to exactly
 * [successorContract, CURRENT_CONTRACT pointer, ...statePaths] — which is why no
 * ACTIVE_GATE or ledger path can ever enter the authorized set.
 */

import crypto from 'node:crypto';
import { canonicalize, sha256Bytes } from '../../tools/canonical-json.mjs';
import {
  LEGACY_SIGNED_AUTHORITY_MODE,
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  resolveAuthorityMode,
  validateAuthorityMode
} from './post-freeze-maintenance-authority.mjs';

export const SUCCESSION_SCHEMA_VERSION = 1;
export const SUCCESSION_REQUEST_KIND = 'GATE_CONTRACT_SUCCESSION_REQUEST';
export const SUCCESSION_RECORD_KIND = 'GATE_CONTRACT_SUCCESSION_RECORD';
export const SUCCESSION_AUTHORITY_KIND = 'PROJECT_OWNER_GATE_CONTRACT_SUCCESSION_AUTHORITY';
export const SUCCESSION_PURPOSE = 'OWNER_AUTHORIZED_CONTRACT_SUCCESSION';
export const SUCCESSION_OPERATION = 'CURRENT_CONTRACT_SWITCH';
export const SUCCESSION_MAX_USE = 1;
export const SUCCESSION_BINDING_ALGORITHM = 'SHA-256-CANONICAL-JSON-V1';
export const SUCCESSION_GATE_RE = /^GATE(1[4-9]|[23][0-9]|40)$/;

/** Reused, never redefined: one authority-mode vocabulary for the whole system. */
export const SUCCESSION_LOCAL_AUTHORITY_MODE = POST_FREEZE_MAINTENANCE_AUTHORITY_MODE;
export const SUCCESSION_LEGACY_AUTHORITY_MODE = LEGACY_SIGNED_AUTHORITY_MODE;
/** Reused from the succession local-authority family already on disk for GATE14. */
export const SUCCESSION_LOCAL_AUTHORITY_KIND = 'GATE_CONTRACT_SUCCESSION_LOCAL_AUTHORITY';
export const SUCCESSION_LOCAL_REQUEST_DIGEST_ALGORITHM = 'SHA256_CANONICAL_JSON_GATE_CONTRACT_SUCCESSION_LOCAL_REQUEST_V1';
/**
 * The exact prohibition set carried by the one succession local authority this
 * project has ever issued. Declared positively so that "grants no START", "may
 * not switch ACTIVE_GATE" and "may not rewrite the ledger" are checked claims
 * rather than the absence of a check.
 */
export const SUCCESSION_LOCAL_REQUIRED_PROHIBITIONS = Object.freeze([
  'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED', 'ACTIVE_GATE_SWITCH', 'GEE_R8', 'GIT_PUSH',
  'HISTORY_REWRITE', 'LEDGER_REWRITE'
]);
/**
 * Paths CURRENT_CONTRACT_SWITCH may never grant. The exact-set scope check
 * (`authorizedPaths` == successor + pointer + statePaths) cannot refuse these
 * on its own: listing a path in BOTH arrays keeps AUTHORIZED_PATH_SCOPE_MISMATCH
 * silent. Same loop and fail-closed finding shape as GEE_PATH_FORBIDDEN.
 */
export const SUCCESSION_LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
export const SUCCESSION_ACTIVE_GATE_PATH = 'governance/active/ACTIVE_GATE.json';
export const SUCCESSION_FORBIDDEN_GRANTED_PATHS = Object.freeze([
  SUCCESSION_LEDGER_PATH,
  SUCCESSION_ACTIVE_GATE_PATH
]);
/**
 * The governed finding each forbidden path raises. Keeping the mapping beside the
 * set is what lets ONE invariant serve both authority families without either of
 * them restating which code belongs to which path. A member of the set with no
 * mapped code still blocks: extending the set can never fail open.
 */
const SUCCESSION_FORBIDDEN_GRANTED_PATH_CODES = Object.freeze({
  [SUCCESSION_LEDGER_PATH]: 'LEDGER_PATH_FORBIDDEN',
  [SUCCESSION_ACTIVE_GATE_PATH]: 'ACTIVE_GATE_PATH_FORBIDDEN'
});

/**
 * The forbidden-granted-path invariant, stated once.
 *
 * The legacy/local family applies it to `authorizedPaths` + `statePaths`, which is
 * where its grant is written down. The ledger-bound family carries NO authorizedPaths
 * array — its granted scope is DERIVED from the succession path fields themselves
 * (successor contract + CURRENT_CONTRACT pointer) — so the same invariant has to be
 * applied to those fields, or a ledger or ACTIVE_GATE path reaches the authorized set
 * through the successor or pointer slot with only isSafePath() in the way, and
 * isSafePath() is happy to accept both.
 */
function forbiddenGrantedPathCode(value) {
  if (typeof value !== 'string' || !SUCCESSION_FORBIDDEN_GRANTED_PATHS.includes(value)) return null;
  return SUCCESSION_FORBIDDEN_GRANTED_PATH_CODES[value] || 'FORBIDDEN_GRANTED_PATH';
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const REVISION_RE = /^R[0-9]{4}$/;
const STATUS_VALUES = new Set([
  'NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'IN_PROGRESS', 'REPAIR_REQUIRED',
  'BLOCKED_GOVERNANCE', 'INTERRUPTED_RESUMABLE', 'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED', 'SUPERSEDED', 'REOPENED_AUTHORIZED'
]);

const SHARED_FIELDS = Object.freeze([
  'projectId', 'gateId', 'purpose', 'reason',
  'predecessorContractPath', 'predecessorContractSha256',
  'predecessorCurrentContractPath', 'predecessorCurrentContractSha256',
  'successorContractPath', 'successorContractSha256',
  'successorCurrentContractPath', 'successorCurrentContractSha256',
  'previousContractPath', 'previousContractSha256', 'successorRevision',
  'authorizedDelta', 'authorizedDeltaDigest', 'currentGateStatus',
  'ledgerHeadEventId', 'ledgerHeadEventPayloadSha256', 'ledgerSha256',
  'baseCommit', 'ownerKeyId', 'expiresAtUtc', 'maxUse', 'successorAuthorized',
  'authorizedOperation', 'authorizedPaths', 'stateRevision', 'statePaths'
]);

export const SUCCESSION_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'requestId', ...SHARED_FIELDS, 'requestDigest'
]);
export const SUCCESSION_RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'document', 'recordId', ...SHARED_FIELDS, 'recordDigest'
]);
export const SUCCESSION_AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'authorityId', 'issuedBy', 'issuedAtUtc',
  ...SHARED_FIELDS, 'requestDigest', 'recordDigest', 'bindingDigest',
  'signatureAlgorithm', 'signature'
]);

/**
 * A signed document MAY name its mode, but is not required to: the historical
 * documents predate the field, so `authorityMode` is allowed and never required
 * on the legacy shapes. Naming a mode that is neither of the two is a blocking
 * finding rather than an ignored string.
 */
const SUCCESSION_RECORD_ALLOWED_FIELDS = Object.freeze([...SUCCESSION_RECORD_FIELDS, 'authorityMode']);
const SUCCESSION_AUTHORITY_ALLOWED_FIELDS = Object.freeze([...SUCCESSION_AUTHORITY_FIELDS, 'authorityMode']);

/**
 * The local mode carries no key, so `ownerKeyId` is not merely unused here: it is
 * forbidden signature material (FORBIDDEN_SIGNATURE_FIELDS) and is rejected.
 * Every other shared binding is retained exactly.
 */
export const SUCCESSION_LOCAL_SHARED_FIELDS = Object.freeze(SHARED_FIELDS.filter((field) => field !== 'ownerKeyId'));
export const SUCCESSION_LOCAL_RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'document', 'recordId', 'authorityMode',
  ...SUCCESSION_LOCAL_SHARED_FIELDS, 'recordDigest'
]);
/**
 * With no external request document, the local authority must carry every binding
 * the request used to supply, and must bind itself by digest.
 */
export const SUCCESSION_LOCAL_AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'authorityMode', 'authorityId', 'issuedBy', 'issuedAtUtc',
  'localRequestDigestAlgorithm', 'approvedRequestDigest',
  ...SUCCESSION_LOCAL_SHARED_FIELDS,
  'recordDigest', 'bindingDigest', 'pushAuthorized', 'prohibitedOperations'
]);

/**
 * Ledger-bound local succession authorities (GATE14 event 59, GATE21-GATE25
 * CONTRACT_SUCCESSION). Same documentKind as the GEE-local CURRENT_CONTRACT_SWITCH
 * family, but a different field set: pre-ledger prefix, contract revisions and a
 * CURRENT_CONTRACT pointer path, and no authorizedDelta/request digest. The
 * legacy signed validator used to canonicalize the missing authorizedDelta and
 * throw; this family is now accepted on its own closed shape.
 */
export const SUCCESSION_LEDGER_BOUND_REQUIRED_FIELDS = Object.freeze([
  'documentKind', 'schemaVersion', 'authorityId', 'authorityMode', 'issuedBy',
  'projectId', 'gateId', 'reason', 'baseHead', 'preLedgerEventCount',
  'preLedgerPrefixSha256', 'predecessorContractPath', 'predecessorContractSha256',
  'predecessorContractRevision', 'successorContractPath', 'successorContractSha256',
  'successorContractRevision', 'currentContractPointerPath',
  'successorCurrentContractSha256', 'previousStateSealSha256',
  'successorStateRevision', 'successorStateSealSha256', 'maxUse',
  'pushAuthorized', 'prohibitedOperations'
]);
export const SUCCESSION_LEDGER_BOUND_OPTIONAL_FIELDS = Object.freeze([
  'programId', 'programAuthorityId', 'candidate', 'published', 'ownerRatified',
  'predecessorCurrentContractSha256', 'successorStateSealBinding',
  'ledgerHeadEventId', 'ledgerHeadEventPayloadSha256', 'functionalBuildAuthorized'
]);
export const SUCCESSION_LEDGER_BOUND_ALLOWED_FIELDS = Object.freeze([
  ...SUCCESSION_LEDGER_BOUND_REQUIRED_FIELDS,
  ...SUCCESSION_LEDGER_BOUND_OPTIONAL_FIELDS
]);
export const SUCCESSION_LEDGER_BOUND_REQUIRED_PROHIBITIONS = Object.freeze([
  'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED', 'ACTIVE_GATE_SWITCH', 'GIT_PUSH', 'HISTORY_REWRITE',
  'LEDGER_REWRITE'
]);

function finding(findings, code, detail = undefined) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha(value) { return typeof value === 'string' && SHA256_RE.test(value); }
function isSafePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  return segments.length > 0 && !segments.some((segment) => !segment || segment === '.' || segment === '..');
}
function isDate(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function revisionNumber(value) { return REVISION_RE.test(String(value)) ? Number.parseInt(String(value).slice(1), 10) : null; }
function same(a, b) {
  try { return canonicalize(a) === canonicalize(b); } catch { return false; }
}

function checkShape(document, required, allowed, findings, label) {
  if (!isObject(document)) { finding(findings, `${label.toUpperCase()}_MALFORMED`); return false; }
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(document, field)) finding(findings, `${label.toUpperCase()}_MISSING_FIELD`, field);
  for (const field of Object.keys(document)) if (!allowed.includes(field)) finding(findings, `${label.toUpperCase()}_UNKNOWN_FIELD`, field);
  return true;
}

function sameStringSet(left, right) {
  if (!Array.isArray(left)) return false;
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validateShared(document, findings, { local = false } = {}) {
  if (document.schemaVersion !== SUCCESSION_SCHEMA_VERSION) finding(findings, 'SCHEMA_VERSION_UNSUPPORTED');
  if (typeof document.projectId !== 'string' || !document.projectId) finding(findings, 'PROJECT_ID_INVALID');
  if (!SUCCESSION_GATE_RE.test(String(document.gateId || ''))) finding(findings, 'GATE_ID_INVALID', document.gateId);
  if (document.purpose !== SUCCESSION_PURPOSE) finding(findings, 'PURPOSE_INVALID', document.purpose);
  if (typeof document.reason !== 'string' || !document.reason.trim()) finding(findings, 'REASON_INVALID');
  for (const field of [
    'predecessorContractSha256', 'predecessorCurrentContractSha256',
    'successorContractSha256', 'successorCurrentContractSha256',
    'previousContractSha256', 'ledgerHeadEventPayloadSha256', 'ledgerSha256',
    'authorizedDeltaDigest'
  ]) if (!isSha(document[field])) finding(findings, 'SHA256_INVALID', field);
  for (const field of ['predecessorContractPath', 'predecessorCurrentContractPath', 'successorContractPath', 'successorCurrentContractPath', 'previousContractPath']) {
    if (!isSafePath(document[field])) finding(findings, 'PATH_INVALID', `${field}:${document[field]}`);
  }
  if (!REVISION_RE.test(String(document.successorRevision || ''))) finding(findings, 'SUCCESSOR_REVISION_INVALID');
  if (document.previousContractPath !== document.predecessorContractPath) finding(findings, 'LINEAGE_PATH_DECLARATION_MISMATCH');
  if (document.previousContractSha256 !== document.predecessorContractSha256) finding(findings, 'LINEAGE_SHA_DECLARATION_MISMATCH');
  if (document.successorCurrentContractPath !== document.predecessorCurrentContractPath) finding(findings, 'CURRENT_POINTER_PATH_MISMATCH');
  if (typeof document.currentGateStatus !== 'string' || !STATUS_VALUES.has(document.currentGateStatus)) finding(findings, 'CURRENT_STATUS_INVALID');
  if (typeof document.ledgerHeadEventId !== 'string' || !document.ledgerHeadEventId) finding(findings, 'LEDGER_HEAD_EVENT_INVALID');
  if (typeof document.baseCommit !== 'string' || !COMMIT_RE.test(document.baseCommit)) finding(findings, 'BASE_COMMIT_INVALID');
  if (!isDate(document.expiresAtUtc)) finding(findings, 'EXPIRY_INVALID');
  // The local mode has no key to name, and naming one is rejected outright by
  // validateAuthorityMode; only the signed mode requires an owner key id.
  if (!local && (typeof document.ownerKeyId !== 'string' || !document.ownerKeyId)) finding(findings, 'OWNER_KEY_ID_INVALID');
  if (document.maxUse !== SUCCESSION_MAX_USE) finding(findings, 'MAX_USE_INVALID');
  if (document.successorAuthorized !== true) finding(findings, 'SUCCESSOR_NOT_AUTHORIZED');
  if (document.authorizedOperation !== SUCCESSION_OPERATION) finding(findings, 'AUTHORIZED_OPERATION_INVALID');
  if (!Array.isArray(document.authorizedPaths) || document.authorizedPaths.length === 0) finding(findings, 'AUTHORIZED_PATHS_INVALID');
  if (!Array.isArray(document.statePaths)) finding(findings, 'STATE_PATHS_INVALID');
  for (const p of [...(document.authorizedPaths || []), ...(document.statePaths || [])]) {
    if (!isSafePath(p)) finding(findings, 'AUTHORIZED_PATH_INVALID', p);
    if (String(p).startsWith('governance/gee-v1/')) finding(findings, 'GEE_PATH_FORBIDDEN', p);
    if (String(p).includes('*')) finding(findings, 'WILDCARD_PATH_FORBIDDEN', p);
    const forbidden = forbiddenGrantedPathCode(String(p));
    if (forbidden) finding(findings, forbidden, p);
  }
  if (!Array.isArray(document.authorizedDelta) || document.authorizedDelta.length === 0) finding(findings, 'AUTHORIZED_DELTA_INVALID');
  else {
    try {
      if (sha256Bytes(Buffer.from(canonicalize(document.authorizedDelta), 'utf8')) !== document.authorizedDeltaDigest) finding(findings, 'AUTHORIZED_DELTA_DIGEST_MISMATCH');
    } catch { finding(findings, 'AUTHORIZED_DELTA_DIGEST_MISMATCH'); }
  }
}

export function validateGateContractSuccessionRequestShape(request) {
  const findings = [];
  const valid = checkShape(request, SUCCESSION_REQUEST_FIELDS, SUCCESSION_REQUEST_FIELDS, findings, 'request');
  if (valid) {
    if (request.documentKind !== SUCCESSION_REQUEST_KIND) finding(findings, 'REQUEST_DOCUMENT_KIND_INVALID');
    validateShared(request, findings);
    if (typeof request.requestId !== 'string' || !request.requestId) finding(findings, 'REQUEST_ID_INVALID');
    if (request.requestDigest !== computeGateContractSuccessionRequestDigest(request)) finding(findings, 'REQUEST_DIGEST_MISMATCH');
  }
  return { valid: findings.length === 0, findings };
}

export function validateGateContractSuccessionRecordShape(record, { local = false } = {}) {
  const findings = [];
  const required = local ? SUCCESSION_LOCAL_RECORD_FIELDS : SUCCESSION_RECORD_FIELDS;
  const allowed = local ? SUCCESSION_LOCAL_RECORD_FIELDS : SUCCESSION_RECORD_ALLOWED_FIELDS;
  const valid = checkShape(record, required, allowed, findings, 'record');
  if (valid) {
    if (record.document !== SUCCESSION_RECORD_KIND) finding(findings, 'RECORD_DOCUMENT_KIND_INVALID');
    // A record must name the same mode as the authority that cites it, so a
    // legacy record can never be paired with a local authority or the reverse.
    if (local && record.authorityMode !== SUCCESSION_LOCAL_AUTHORITY_MODE) finding(findings, 'RECORD_AUTHORITY_MODE_INVALID', record.authorityMode);
    if (!local && Object.hasOwn(record, 'authorityMode') && record.authorityMode !== SUCCESSION_LEGACY_AUTHORITY_MODE) finding(findings, 'RECORD_AUTHORITY_MODE_INVALID', record.authorityMode);
    validateShared(record, findings, { local });
    if (typeof record.recordId !== 'string' || !record.recordId) finding(findings, 'RECORD_ID_INVALID');
    if (record.recordDigest !== computeGateContractSuccessionRecordDigest(record)) finding(findings, 'RECORD_DIGEST_MISMATCH');
  }
  return { valid: findings.length === 0, findings };
}

export function validateGateContractSuccessionAuthorityShape(authority) {
  try {
  if (isLedgerBoundGateContractSuccessionAuthority(authority)) {
    return validateGateContractSuccessionLedgerBoundAuthorityShape(authority);
  }
  const findings = [];
  const valid = checkShape(authority, SUCCESSION_AUTHORITY_FIELDS, SUCCESSION_AUTHORITY_ALLOWED_FIELDS, findings, 'authority');
  if (valid) {
    if (authority.documentKind !== SUCCESSION_AUTHORITY_KIND) finding(findings, 'AUTHORITY_DOCUMENT_KIND_INVALID');
    if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'AUTHORITY_NOT_OWNER_ISSUED');
    if (typeof authority.authorityId !== 'string' || !authority.authorityId) finding(findings, 'AUTHORITY_ID_INVALID');
    if (!isDate(authority.issuedAtUtc)) finding(findings, 'ISSUED_AT_INVALID');
    // Absence still resolves to the signed branch, so this adds a finding only for
    // a document that names a mode this branch does not implement.
    const modeResult = validateAuthorityMode(authority, { requireLegacySignature: true, defaultLegacy: true });
    findings.push(...modeResult.findings);
    if (modeResult.mode !== SUCCESSION_LEGACY_AUTHORITY_MODE) finding(findings, 'AUTHORITY_MODE_INVALID', authority.authorityMode);
    validateShared(authority, findings);
    if (!isSha(authority.requestDigest) || !isSha(authority.recordDigest) || !isSha(authority.bindingDigest)) finding(findings, 'AUTHORITY_DIGEST_INVALID');
    if (authority.signatureAlgorithm !== 'ed25519') finding(findings, 'SIGNATURE_ALGORITHM_INVALID');
    if (typeof authority.signature !== 'string' || !authority.signature) finding(findings, 'SIGNATURE_MISSING');
  }
  return { valid: findings.length === 0, findings };
  } catch (error) {
    return { valid: false, findings: [{ code: 'AUTHORITY_VALIDATION_EXCEPTION', detail: error?.name || 'Error' }] };
  }
}

/** True when the document names the local mode. Absence resolves to legacy. */
export function isLocalGateContractSuccessionAuthority(authority) {
  return resolveAuthorityMode(authority, { defaultLegacy: true }) === SUCCESSION_LOCAL_AUTHORITY_MODE;
}

/**
 * Discriminator for the ledger-bound family already cited by canonical
 * CONTRACT_SUCCESSION events. Requires the local documentKind plus the
 * pre-ledger / pointer fields that the GEE-local CURRENT_CONTRACT_SWITCH
 * documents never carry, so the two families cannot silently swap.
 */
export function isLedgerBoundGateContractSuccessionAuthority(authority) {
  return isObject(authority)
    && authority.documentKind === SUCCESSION_LOCAL_AUTHORITY_KIND
    && Object.hasOwn(authority, 'baseHead')
    && Object.hasOwn(authority, 'preLedgerEventCount')
    && Object.hasOwn(authority, 'preLedgerPrefixSha256')
    && Object.hasOwn(authority, 'currentContractPointerPath')
    && Object.hasOwn(authority, 'predecessorContractRevision');
}

export function validateGateContractSuccessionLedgerBoundAuthorityShape(authority) {
  const findings = [];
  try {
    const valid = checkShape(authority, SUCCESSION_LEDGER_BOUND_REQUIRED_FIELDS, SUCCESSION_LEDGER_BOUND_ALLOWED_FIELDS, findings, 'authority');
    if (!valid) return { valid: false, findings };
    if (authority.documentKind !== SUCCESSION_LOCAL_AUTHORITY_KIND) finding(findings, 'AUTHORITY_DOCUMENT_KIND_INVALID');
    if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'AUTHORITY_NOT_OWNER_ISSUED');
    if (typeof authority.authorityId !== 'string' || !authority.authorityId) finding(findings, 'AUTHORITY_ID_INVALID');
    const modeResult = validateAuthorityMode(authority, { requireLegacySignature: false, defaultLegacy: false });
    findings.push(...modeResult.findings);
    if (modeResult.mode !== SUCCESSION_LOCAL_AUTHORITY_MODE) finding(findings, 'AUTHORITY_MODE_INVALID', authority.authorityMode);
    if (authority.schemaVersion !== SUCCESSION_SCHEMA_VERSION) finding(findings, 'SCHEMA_VERSION_UNSUPPORTED');
    if (typeof authority.projectId !== 'string' || !authority.projectId) finding(findings, 'PROJECT_ID_INVALID');
    if (!SUCCESSION_GATE_RE.test(String(authority.gateId || ''))) finding(findings, 'GATE_ID_INVALID', authority.gateId);
    if (typeof authority.reason !== 'string' || !authority.reason.trim()) finding(findings, 'REASON_INVALID');
    if (!COMMIT_RE.test(String(authority.baseHead || ''))) finding(findings, 'BASE_COMMIT_INVALID');
    if (!Number.isInteger(authority.preLedgerEventCount) || authority.preLedgerEventCount < 1) finding(findings, 'LEDGER_HEAD_EVENT_INVALID');
    if (!isSha(authority.preLedgerPrefixSha256)) finding(findings, 'SHA256_INVALID', 'preLedgerPrefixSha256');
    for (const field of ['predecessorContractSha256', 'successorContractSha256', 'successorCurrentContractSha256', 'previousStateSealSha256']) {
      if (!isSha(authority[field])) finding(findings, 'SHA256_INVALID', field);
    }
    if (Object.hasOwn(authority, 'predecessorCurrentContractSha256') && !isSha(authority.predecessorCurrentContractSha256)) {
      finding(findings, 'SHA256_INVALID', 'predecessorCurrentContractSha256');
    }
    if (Object.hasOwn(authority, 'ledgerHeadEventPayloadSha256') && !isSha(authority.ledgerHeadEventPayloadSha256)) {
      finding(findings, 'SHA256_INVALID', 'ledgerHeadEventPayloadSha256');
    }
    // Every field here can reach the authorized scope, so each is held to BOTH the
    // shape rule and the forbidden-granted-path invariant. isSafePath() accepts the
    // ledger and ACTIVE_GATE paths perfectly happily; only this second check refuses
    // them, and refusing them here is what keeps them out of authorizedPaths below.
    for (const field of ['predecessorContractPath', 'successorContractPath', 'currentContractPointerPath']) {
      if (!isSafePath(authority[field])) finding(findings, 'PATH_INVALID', `${field}:${authority[field]}`);
      const forbidden = forbiddenGrantedPathCode(authority[field]);
      if (forbidden) finding(findings, forbidden, `${field}:${authority[field]}`);
    }
    if (!REVISION_RE.test(String(authority.predecessorContractRevision || ''))) finding(findings, 'SUCCESSOR_REVISION_INVALID');
    if (!REVISION_RE.test(String(authority.successorContractRevision || ''))) finding(findings, 'SUCCESSOR_REVISION_INVALID');
    if (!REVISION_RE.test(String(authority.successorStateRevision || ''))) finding(findings, 'SUCCESSOR_REVISION_INVALID');
    const predecessorRevision = revisionNumber(authority.predecessorContractRevision);
    const successorRevision = revisionNumber(authority.successorContractRevision);
    if (predecessorRevision === null || successorRevision === null || successorRevision !== predecessorRevision + 1) {
      finding(findings, 'SUCCESSOR_REVISION_LINEAGE_GAP');
    }
    if (authority.successorContractPath === authority.predecessorContractPath) finding(findings, 'PREDECESSOR_MUTATION_FORBIDDEN');
    if (authority.successorStateSealSha256 !== null && !isSha(authority.successorStateSealSha256)) {
      finding(findings, 'SHA256_INVALID', 'successorStateSealSha256');
    }
    if (typeof authority.ledgerHeadEventId === 'string' ? authority.ledgerHeadEventId.length === 0 : Object.hasOwn(authority, 'ledgerHeadEventId')) {
      finding(findings, 'LEDGER_HEAD_EVENT_INVALID');
    }
    if (authority.maxUse !== SUCCESSION_MAX_USE) finding(findings, 'MAX_USE_INVALID');
    if (authority.pushAuthorized !== false) finding(findings, 'PUSH_NOT_FORBIDDEN');
    if (!Array.isArray(authority.prohibitedOperations) || authority.prohibitedOperations.length === 0) {
      finding(findings, 'PROHIBITED_OPERATIONS_INVALID');
    } else {
      for (const required of SUCCESSION_LEDGER_BOUND_REQUIRED_PROHIBITIONS) {
        if (!authority.prohibitedOperations.includes(required)) finding(findings, 'PROHIBITED_OPERATIONS_INVALID', required);
      }
    }
    return { valid: findings.length === 0, findings };
  } catch (error) {
    finding(findings, 'AUTHORITY_VALIDATION_EXCEPTION', error?.name || 'Error');
    return { valid: false, findings };
  }
}

/**
 * Digest of the exact local authority projection. It replaces the absent external
 * request: the authority binds itself, and any edit to any bound field changes the
 * digest the document must already carry.
 */
export function computeGateContractSuccessionLocalRequestDigest(authority) {
  if (!isObject(authority)) return null;
  const projection = {
    algorithm: SUCCESSION_LOCAL_REQUEST_DIGEST_ALGORITHM,
    authorityMode: authority.authorityMode
  };
  for (const field of SUCCESSION_LOCAL_SHARED_FIELDS) projection[field] = authority[field];
  projection.pushAuthorized = authority.pushAuthorized;
  projection.prohibitedOperations = authority.prohibitedOperations;
  return sha256Bytes(Buffer.from(canonicalize(projection), 'utf8'));
}

export function validateGateContractSuccessionLocalAuthorityShape(authority) {
  try {
  if (isLedgerBoundGateContractSuccessionAuthority(authority)) {
    return validateGateContractSuccessionLedgerBoundAuthorityShape(authority);
  }
  const findings = [];
  const valid = checkShape(authority, SUCCESSION_LOCAL_AUTHORITY_FIELDS, SUCCESSION_LOCAL_AUTHORITY_FIELDS, findings, 'authority');
  if (valid) {
    if (authority.documentKind !== SUCCESSION_LOCAL_AUTHORITY_KIND) finding(findings, 'AUTHORITY_DOCUMENT_KIND_INVALID');
    if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'AUTHORITY_NOT_OWNER_ISSUED');
    if (typeof authority.authorityId !== 'string' || !authority.authorityId) finding(findings, 'AUTHORITY_ID_INVALID');
    if (!isDate(authority.issuedAtUtc)) finding(findings, 'ISSUED_AT_INVALID');
    // The mode must be named explicitly (defaultLegacy: false). Naming it is what
    // makes the absence of signature checking safe: any key or signature field
    // present is REJECTED rather than ignored.
    const modeResult = validateAuthorityMode(authority, { requireLegacySignature: false, defaultLegacy: false });
    findings.push(...modeResult.findings);
    if (modeResult.mode !== SUCCESSION_LOCAL_AUTHORITY_MODE) finding(findings, 'AUTHORITY_MODE_INVALID', authority.authorityMode);
    validateShared(authority, findings, { local: true });
    if (authority.localRequestDigestAlgorithm !== SUCCESSION_LOCAL_REQUEST_DIGEST_ALGORITHM) finding(findings, 'LOCAL_REQUEST_DIGEST_ALGORITHM_INVALID', authority.localRequestDigestAlgorithm);
    if (!isSha(authority.approvedRequestDigest) || !isSha(authority.recordDigest) || !isSha(authority.bindingDigest)) finding(findings, 'AUTHORITY_DIGEST_INVALID');
    else if (authority.approvedRequestDigest !== computeGateContractSuccessionLocalRequestDigest(authority)) finding(findings, 'LOCAL_REQUEST_DIGEST_SELF_INCONSISTENT');
    if (authority.pushAuthorized !== false) finding(findings, 'PUSH_NOT_FORBIDDEN');
    if (!sameStringSet(authority.prohibitedOperations, SUCCESSION_LOCAL_REQUIRED_PROHIBITIONS)) finding(findings, 'PROHIBITED_OPERATIONS_INVALID');
  }
  return { valid: findings.length === 0, findings };
  } catch (error) {
    return { valid: false, findings: [{ code: 'AUTHORITY_VALIDATION_EXCEPTION', detail: error?.name || 'Error' }] };
  }
}

export function canonicalSuccessionSigningPayload(authority) {
  const { signature, ...unsigned } = authority || {};
  return canonicalize(unsigned);
}

export function verifyGateContractSuccessionOwnerSignature(authority, ownerKey) {
  if (!ownerKey || ownerKey.keyId !== authority?.ownerKeyId || typeof ownerKey.publicKeyPem !== 'string') return { verified: false, reason: 'OWNER_KEY_MISMATCH' };
  try {
    const verified = crypto.verify(null, Buffer.from(canonicalSuccessionSigningPayload(authority), 'utf8'), crypto.createPublicKey(ownerKey.publicKeyPem), Buffer.from(authority.signature, 'base64'));
    return verified ? { verified: true, reason: 'OWNER_SIGNATURE_VERIFIED' } : { verified: false, reason: 'OWNER_SIGNATURE_INVALID' };
  } catch { return { verified: false, reason: 'OWNER_SIGNATURE_INVALID' }; }
}

export function computeGateContractSuccessionRequestDigest(request) {
  const { requestDigest, ...unsigned } = request || {};
  return sha256Bytes(Buffer.from(canonicalize(unsigned), 'utf8'));
}

export function computeGateContractSuccessionRecordDigest(record) {
  const { recordDigest, ...unsigned } = record || {};
  return sha256Bytes(Buffer.from(canonicalize(unsigned), 'utf8'));
}

export function computeGateContractSuccessionBindingDigest({ requestDigest, recordDigest, successorContractSha256, successorCurrentContractSha256 }) {
  return sha256Bytes(Buffer.from(canonicalize({ algorithm: SUCCESSION_BINDING_ALGORITHM, requestDigest, recordDigest, successorContractSha256, successorCurrentContractSha256 }), 'utf8'));
}

export function diffContractSemantics(predecessor, successor, pointer = '') {
  if (Object.is(predecessor, successor)) return [];
  if (Array.isArray(predecessor) && Array.isArray(successor)) {
    const length = Math.max(predecessor.length, successor.length);
    const result = [];
    for (let i = 0; i < length; i += 1) result.push(...diffContractSemantics(predecessor[i], successor[i], `${pointer}/${i}`));
    return result;
  }
  if (isObject(predecessor) && isObject(successor)) {
    const keys = new Set([...Object.keys(predecessor), ...Object.keys(successor)]);
    return [...keys].sort().flatMap((key) => diffContractSemantics(predecessor[key], successor[key], `${pointer}/${key}`));
  }
  return [{ op: predecessor === undefined ? 'add' : successor === undefined ? 'remove' : 'replace', path: pointer || '/', from: predecessor, to: successor }];
}

function compareShared(request, record, authority, findings) {
  for (const field of SHARED_FIELDS) {
    if (!same(request?.[field], record?.[field])) finding(findings, 'REQUEST_RECORD_BINDING_MISMATCH', field);
    if (!same(request?.[field], authority?.[field])) finding(findings, 'AUTHORITY_REQUEST_BINDING_MISMATCH', field);
  }
  if (authority?.requestDigest !== request?.requestDigest) finding(findings, 'AUTHORITY_REQUEST_DIGEST_MISMATCH');
  if (authority?.recordDigest !== record?.recordDigest) finding(findings, 'AUTHORITY_RECORD_DIGEST_MISMATCH');
  const expectedBinding = computeGateContractSuccessionBindingDigest({ requestDigest: request?.requestDigest, recordDigest: record?.recordDigest, successorContractSha256: request?.successorContractSha256, successorCurrentContractSha256: request?.successorCurrentContractSha256 });
  if (authority?.bindingDigest !== expectedBinding) finding(findings, 'AUTHORITY_BINDING_DIGEST_MISMATCH');
}

/**
 * Local mode has two documents, not three, so the record is compared against the
 * authority directly and the authority's self-binding digest takes the place the
 * external request digest held. The binding-digest primitive itself is REUSED
 * unchanged, so both modes commit to the same four values.
 */
function compareLocalShared(record, authority, findings) {
  for (const field of SUCCESSION_LOCAL_SHARED_FIELDS) {
    if (!same(record?.[field], authority?.[field])) finding(findings, 'AUTHORITY_RECORD_BINDING_MISMATCH', field);
  }
  if (record?.authorityMode !== authority?.authorityMode) finding(findings, 'AUTHORITY_RECORD_BINDING_MISMATCH', 'authorityMode');
  if (authority?.recordDigest !== record?.recordDigest) finding(findings, 'AUTHORITY_RECORD_DIGEST_MISMATCH');
  const expectedBinding = computeGateContractSuccessionBindingDigest({ requestDigest: authority?.approvedRequestDigest, recordDigest: record?.recordDigest, successorContractSha256: authority?.successorContractSha256, successorCurrentContractSha256: authority?.successorCurrentContractSha256 });
  if (authority?.bindingDigest !== expectedBinding) finding(findings, 'AUTHORITY_BINDING_DIGEST_MISMATCH');
}

function exactPathSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && [...left].sort().every((v, i) => v === [...right].sort()[i]);
}

function blockedEvaluation(findings, authorityMode) {
  return { decision: 'BLOCKED', successionAuthorized: false, authorityMode, findings, authorizedPaths: [], executionAuthorized: false, startAuthorized: false, closureAuthorized: false };
}

function evaluateLedgerBoundGateContractSuccessionAuthority({ authority, request, predecessorContract, successorContract, predecessorCurrentContract, successorCurrentContract, observed }) {
  const findings = [];
  const authorityResult = validateGateContractSuccessionLedgerBoundAuthorityShape(authority);
  findings.push(...authorityResult.findings);
  if (request !== null) finding(findings, 'LOCAL_AUTHORITY_REQUEST_NOT_PERMITTED');
  if (!authorityResult.valid) return blockedEvaluation(findings, SUCCESSION_LOCAL_AUTHORITY_MODE);
  /**
   * MISSING OBSERVATION IS NOT AGREEMENT.
   *
   * A conditional of the form `if (observed.X && observed.X !== authority.Y)` reads
   * an ABSENT observation as a match, so a caller that simply omits a field is
   * authorized on evidence nobody ever produced — the strongest possible fail-open.
   * Presence is therefore proven BEFORE any comparison, and absence raises the SAME
   * governed finding a divergent value raises: absence is a mismatch, never a default.
   *
   * The shape validator above has already proven every authority binding is a
   * well-formed non-empty string / SHA-256 / safe path. That is what lets a single
   * STRICT equality against the authority do both jobs at once: `undefined` can never
   * equal a validated binding, so `observed.X !== authority.Y` rejects absent,
   * malformed and divergent observations alike, with no truthiness shortcut and no
   * permissive default anywhere. Only the two values the authority does NOT bind —
   * the live and candidate ledger digests — need an explicit well-formedness test.
   */
  const seen = isObject(observed) ? observed : {};
  const pointerPath = authority.currentContractPointerPath;

  // Exactly one authority may be in play: absent, non-integer and >1 all block.
  if (seen.competingAuthorityCount !== 1) finding(findings, 'COMPETING_SUCCESSION_AUTHORITIES');
  // Single-use. Only an explicit, observed `false` clears the replay blocker; absent
  // or malformed consumption evidence is treated exactly as a replay.
  if (seen.authorityConsumed !== false) finding(findings, 'AUTHORITY_REPLAY');
  if (seen.projectId !== authority.projectId || seen.gateId !== authority.gateId) finding(findings, 'CROSS_GATE_OR_PROJECT_BINDING');
  if (seen.baseCommit !== authority.baseHead) finding(findings, 'BASE_COMMIT_MISMATCH');

  if (seen.predecessorContractPath !== authority.predecessorContractPath) finding(findings, 'PREDECESSOR_PATH_MISMATCH');
  if (seen.predecessorContractSha256 !== authority.predecessorContractSha256) finding(findings, 'PREDECESSOR_SHA_MISMATCH');
  if (seen.successorContractPath !== authority.successorContractPath) finding(findings, 'SUCCESSOR_PATH_MISMATCH');
  if (seen.successorContractSha256 !== authority.successorContractSha256) finding(findings, 'SUCCESSOR_SHA_MISMATCH');
  if (seen.predecessorCurrentContractPath !== pointerPath) finding(findings, 'PREDECESSOR_CURRENT_POINTER_PATH_MISMATCH');
  if (seen.successorCurrentContractPath !== pointerPath) finding(findings, 'SUCCESSOR_CURRENT_POINTER_PATH_MISMATCH');
  if (seen.successorCurrentContractSha256 !== authority.successorCurrentContractSha256) {
    finding(findings, 'SUCCESSOR_CURRENT_POINTER_SHA_MISMATCH');
  }
  // Optional bindings: required as evidence exactly when the authority declares them,
  // and then compared as strictly as every mandatory one.
  if (Object.hasOwn(authority, 'predecessorCurrentContractSha256')
    && seen.predecessorCurrentContractSha256 !== authority.predecessorCurrentContractSha256) {
    finding(findings, 'PREDECESSOR_CURRENT_POINTER_SHA_MISMATCH');
  }
  if (Object.hasOwn(authority, 'ledgerHeadEventId')
    && (seen.ledgerHeadEventId !== authority.ledgerHeadEventId
      || seen.ledgerHeadEventPayloadSha256 !== authority.ledgerHeadEventPayloadSha256)) {
    finding(findings, 'LEDGER_HEAD_BINDING_MISMATCH');
  }

  if (authority.successorContractPath === authority.predecessorContractPath) finding(findings, 'PREDECESSOR_MUTATION_FORBIDDEN');
  if (authority.successorContractPath === pointerPath) finding(findings, 'CURRENT_POINTER_REPLACEMENT_PATH_INVALID');
  // Neither digest is bound by the authority, so here presence is proven explicitly:
  // an unobservable ledger cannot witness that the ledger did not move.
  if (!isSha(seen.ledgerSha256) || seen.candidateLedgerSha256 !== seen.ledgerSha256) {
    finding(findings, 'LEDGER_MUTATION_NOT_AUTHORIZED');
  }

  /**
   * The contract and pointer documents are required evidence, not a nicety: the
   * lineage checks below are the only thing proving the successor actually succeeds
   * THIS predecessor and that the pointer really moves between them. Authorizing
   * while they are unreadable would be authorizing on nothing at all.
   */
  if (!isObject(predecessorContract)) finding(findings, 'CONTRACT_BYTES_UNAVAILABLE', 'predecessorContract');
  else if (predecessorContract.gateId !== authority.gateId) finding(findings, 'SUCCESSOR_GATE_MISMATCH');
  if (!isObject(successorContract)) finding(findings, 'CONTRACT_BYTES_UNAVAILABLE', 'successorContract');
  else {
    if (successorContract.gateId !== authority.gateId) finding(findings, 'SUCCESSOR_GATE_MISMATCH');
    if (successorContract.previousContractPath !== authority.predecessorContractPath
      || successorContract.previousContractSha256 !== authority.predecessorContractSha256) {
      finding(findings, 'SUCCESSOR_PREDECESSOR_LINEAGE_MISMATCH');
    }
    if (successorContract.contractRevision !== authority.successorContractRevision) {
      finding(findings, 'SUCCESSOR_REVISION_LINEAGE_GAP');
    }
  }
  /**
   * `contractPath`/`contractSha256` INSIDE a CURRENT_CONTRACT pointer name the
   * execution contract it points at — never the pointer's own path, which is
   * `currentContractPointerPath`, and never the pointer's own bytes, which are
   * `{predecessor,successor}CurrentContractSha256`. The legacy family already binds
   * the pointed-at contract; the ledger-bound family binds it the same way here.
   */
  if (!isObject(predecessorCurrentContract)) finding(findings, 'CONTRACT_BYTES_UNAVAILABLE', 'predecessorCurrentContract');
  else if (predecessorCurrentContract.gateId !== authority.gateId
    || predecessorCurrentContract.contractRevision !== authority.predecessorContractRevision
    || predecessorCurrentContract.contractPath !== authority.predecessorContractPath
    || predecessorCurrentContract.contractSha256 !== authority.predecessorContractSha256) {
    finding(findings, 'PREDECESSOR_POINTER_BINDING_MISMATCH');
  }
  if (!isObject(successorCurrentContract)) finding(findings, 'CONTRACT_BYTES_UNAVAILABLE', 'successorCurrentContract');
  else if (successorCurrentContract.gateId !== authority.gateId
    || successorCurrentContract.contractRevision !== authority.successorContractRevision
    || successorCurrentContract.contractPath !== authority.successorContractPath
    || successorCurrentContract.contractSha256 !== authority.successorContractSha256) {
    finding(findings, 'SUCCESSOR_POINTER_BINDING_MISMATCH');
  }

  const grantedPaths = [authority.successorContractPath, pointerPath];
  // Belt and braces at the actual grant point: the shape validator already refused
  // a forbidden successor or pointer path, so this can only fire if that check is
  // ever weakened. No forbidden path may leave this function inside authorizedPaths.
  for (const granted of grantedPaths) {
    const forbidden = forbiddenGrantedPathCode(granted);
    if (forbidden) finding(findings, forbidden, granted);
  }
  const authorized = findings.length === 0;
  return {
    decision: authorized ? 'AUTHORIZED' : 'BLOCKED',
    successionAuthorized: authorized,
    authorityMode: SUCCESSION_LOCAL_AUTHORITY_MODE,
    executionAuthorized: false,
    startAuthorized: false,
    closureAuthorized: false,
    authorizedPaths: authorized ? grantedPaths : [],
    findings
  };
}

export function evaluateGateContractSuccessionAuthority({ request = null, record = null, authority = null, ownerKey = null, predecessorContract = null, successorContract = null, predecessorCurrentContract = null, successorCurrentContract = null, observed = {}, now = new Date() } = {}) {
  try {
  const findings = [];
  /**
   * The mode is read from the authority alone, and absence resolves to legacy, so
   * no existing document changes branch. A local authority is self-contained: an
   * external request is not merely unnecessary but REFUSED, so a caller cannot
   * smuggle a second, differently-bound document past an authority that never
   * binds it.
   */
  if (isLedgerBoundGateContractSuccessionAuthority(authority)) {
    return evaluateLedgerBoundGateContractSuccessionAuthority({
      authority, request, predecessorContract, successorContract, predecessorCurrentContract, successorCurrentContract, observed
    });
  }
  const local = isLocalGateContractSuccessionAuthority(authority);
  const requestResult = local ? { valid: true, findings: [] } : validateGateContractSuccessionRequestShape(request);
  const recordResult = validateGateContractSuccessionRecordShape(record, { local });
  const authorityResult = local
    ? validateGateContractSuccessionLocalAuthorityShape(authority)
    : validateGateContractSuccessionAuthorityShape(authority);
  findings.push(...requestResult.findings, ...recordResult.findings, ...authorityResult.findings);
  if (local && request !== null) finding(findings, 'LOCAL_AUTHORITY_REQUEST_NOT_PERMITTED');
  const authorityMode = local ? SUCCESSION_LOCAL_AUTHORITY_MODE : SUCCESSION_LEGACY_AUTHORITY_MODE;
  if (!requestResult.valid || !recordResult.valid || !authorityResult.valid) return blockedEvaluation(findings, authorityMode);

  /**
   * The document the live repository is compared against: the external request in
   * legacy mode, the self-contained authority in local mode. Every binding below
   * is therefore identical in both modes — only where the values come from moves.
   */
  const binding = local ? authority : request;

  if (local) compareLocalShared(record, authority, findings);
  else compareShared(request, record, authority, findings);
  if (authority.expiresAtUtc && now.getTime() > Date.parse(authority.expiresAtUtc)) finding(findings, 'AUTHORITY_EXPIRED');
  if (!local) {
    const signature = verifyGateContractSuccessionOwnerSignature(authority, ownerKey);
    if (!signature.verified) finding(findings, signature.reason);
  }
  if (observed.competingAuthorityCount > 1) finding(findings, 'COMPETING_SUCCESSION_AUTHORITIES');
  if (observed.authorityConsumed === true) finding(findings, 'AUTHORITY_REPLAY');
  if (observed.projectId !== binding.projectId || observed.gateId !== binding.gateId) finding(findings, 'CROSS_GATE_OR_PROJECT_BINDING');
  if (observed.currentStatus !== binding.currentGateStatus) finding(findings, 'CURRENT_STATUS_MISMATCH');
  if (observed.ledgerHeadEventId !== binding.ledgerHeadEventId || observed.ledgerHeadEventPayloadSha256 !== binding.ledgerHeadEventPayloadSha256 || observed.ledgerSha256 !== binding.ledgerSha256) finding(findings, 'LEDGER_HEAD_BINDING_MISMATCH');
  if (observed.baseCommit !== binding.baseCommit) finding(findings, 'BASE_COMMIT_MISMATCH');

  if (observed.predecessorContractPath !== binding.predecessorContractPath) finding(findings, 'PREDECESSOR_PATH_MISMATCH');
  if (observed.predecessorContractSha256 !== binding.predecessorContractSha256) finding(findings, 'PREDECESSOR_SHA_MISMATCH');
  if (observed.predecessorCurrentContractPath !== binding.predecessorCurrentContractPath) finding(findings, 'PREDECESSOR_CURRENT_POINTER_PATH_MISMATCH');
  if (observed.predecessorCurrentContractSha256 !== binding.predecessorCurrentContractSha256) finding(findings, 'PREDECESSOR_CURRENT_POINTER_SHA_MISMATCH');
  if (binding.successorContractPath === binding.predecessorContractPath) finding(findings, 'PREDECESSOR_MUTATION_FORBIDDEN');
  if (binding.successorContractPath === binding.predecessorCurrentContractPath) finding(findings, 'CURRENT_POINTER_REPLACEMENT_PATH_INVALID');
  if (observed.successorContractPath !== binding.successorContractPath) finding(findings, 'SUCCESSOR_PATH_MISMATCH');
  if (observed.successorContractSha256 !== binding.successorContractSha256) finding(findings, 'SUCCESSOR_SHA_MISMATCH');
  if (observed.successorCurrentContractPath !== binding.successorCurrentContractPath) finding(findings, 'SUCCESSOR_CURRENT_POINTER_PATH_MISMATCH');
  if (observed.successorCurrentContractSha256 !== binding.successorCurrentContractSha256) finding(findings, 'SUCCESSOR_CURRENT_POINTER_SHA_MISMATCH');
  if (observed.candidateLedgerSha256 && observed.candidateLedgerSha256 !== binding.ledgerSha256) finding(findings, 'LEDGER_MUTATION_NOT_AUTHORIZED');
  const statePaths = Array.isArray(binding.statePaths) ? binding.statePaths : [];
  if (!exactPathSet(binding.authorizedPaths, [binding.successorContractPath, binding.successorCurrentContractPath, ...statePaths])) finding(findings, 'AUTHORIZED_PATH_SCOPE_MISMATCH');

  const predecessorRevision = revisionNumber(predecessorContract?.contractRevision);
  const successorRevision = revisionNumber(successorContract?.contractRevision);
  if (predecessorContract?.gateId !== binding.gateId || successorContract?.gateId !== binding.gateId) finding(findings, 'SUCCESSOR_GATE_MISMATCH');
  if (predecessorRevision === null || successorRevision === null || successorRevision !== predecessorRevision + 1 || binding.successorRevision !== successorContract?.contractRevision) finding(findings, 'SUCCESSOR_REVISION_LINEAGE_GAP');
  if (successorContract?.previousContractPath !== binding.predecessorContractPath || successorContract?.previousContractSha256 !== binding.predecessorContractSha256) finding(findings, 'SUCCESSOR_PREDECESSOR_LINEAGE_MISMATCH');
  if (predecessorContract && successorContract) {
    const actualDelta = diffContractSemantics(predecessorContract, successorContract);
    if (!same(actualDelta, binding.authorizedDelta)) finding(findings, 'SUCCESSOR_DELTA_OUTSIDE_AUTHORIZATION', actualDelta);
    try {
      if (sha256Bytes(Buffer.from(canonicalize(actualDelta), 'utf8')) !== binding.authorizedDeltaDigest) finding(findings, 'SUCCESSOR_DELTA_DIGEST_MISMATCH');
    } catch { finding(findings, 'SUCCESSOR_DELTA_DIGEST_MISMATCH'); }
  } else finding(findings, 'CONTRACT_BYTES_UNAVAILABLE');
  if (successorCurrentContract && (successorCurrentContract.gateId !== binding.gateId || successorCurrentContract.contractRevision !== binding.successorRevision || successorCurrentContract.contractPath !== binding.successorContractPath || successorCurrentContract.contractSha256 !== binding.successorContractSha256)) finding(findings, 'SUCCESSOR_POINTER_BINDING_MISMATCH');
  if (predecessorCurrentContract && (predecessorCurrentContract.gateId !== binding.gateId || predecessorCurrentContract.contractPath !== binding.predecessorContractPath || predecessorCurrentContract.contractSha256 !== binding.predecessorContractSha256)) finding(findings, 'PREDECESSOR_POINTER_BINDING_MISMATCH');

  const authorized = findings.length === 0;
  return { decision: authorized ? 'AUTHORIZED' : 'BLOCKED', successionAuthorized: authorized, authorityMode, executionAuthorized: false, startAuthorized: false, closureAuthorized: false, authorizedPaths: authorized ? binding.authorizedPaths : [], findings };
  } catch (error) {
    return blockedEvaluation([{ code: 'AUTHORITY_VALIDATION_EXCEPTION', detail: error?.name || 'Error' }], null);
  }
}

export function gateContractSuccessionRecordPath(gateId) {
  return `governance/authority/authorizations/${gateId}/GATE_CONTRACT_SUCCESSION_RECORD.json`;
}

export function gateContractSuccessionAuthorityPath(gateId) {
  return `governance/authority/authorizations/${gateId}/PROJECT_OWNER_GATE_CONTRACT_SUCCESSION_AUTHORITY.json`;
}

/**
 * The deterministic in-repo location of a Gate's LOCAL succession authority. The
 * signed authority is required to be EXTERNAL to the repository, because a
 * document the repository can rewrite cannot also be the key that guards it. The
 * local authority is the opposite by construction: it holds no secret, and its
 * whole defence is the exact repository pre-state it names, so it belongs beside
 * the record it authorizes and is content-addressed like every other governed
 * artifact.
 */
export function gateContractSuccessionLocalAuthorityPath(gateId) {
  return `governance/authority/authorizations/${gateId}/${SUCCESSION_LOCAL_AUTHORITY_KIND}.json`;
}
