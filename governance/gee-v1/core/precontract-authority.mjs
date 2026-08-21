/**
 * GEE V1 core — PRECONTRACT authority (bootstrap of a Gate's first contract).
 *
 * TWO MODES, ONE PRIMITIVE.
 *
 *   LEGACY_SIGNED_AUTHORITY  — the historical request + owner-signed authority
 *                              pair. Byte-for-byte unchanged semantics; an
 *                              existing document without `authorityMode`
 *                              resolves here and validates exactly as before.
 *
 *   LOCAL_EXPLICIT_AUTHORITY — the project's standing policy for NEW authority
 *                              (see post-freeze-maintenance-authority.mjs): no
 *                              PKI, no private key, no signature. The mode
 *                              constant, the forbidden-signature-field rule and
 *                              the mode validator are all REUSED from that
 *                              module rather than reimplemented, so there is one
 *                              authority-mode vocabulary in the system.
 *
 * WHY THE LOCAL MODE EXISTS HERE. Every other link of the bootstrap chain —
 * GATE_AUTHORIZATION and GATE_START — already accepts LOCAL_EXPLICIT_AUTHORITY.
 * PRECONTRACT did not, and PRECONTRACT is the first link: it is the only
 * authority that may create a Gate's EXECUTION_CONTRACT_R0001 and
 * CURRENT_CONTRACT while the Gate is still NOT_STARTED. With no signable key in
 * the project, a signature-only PRECONTRACT made the whole chain unreachable for
 * any future Gate — the blocker recorded as
 * STOP_EXISTING_BOOTSTRAP_PRIMITIVE_INSUFFICIENT.
 *
 * WHAT REPLACES THE SIGNATURE. A signature proves WHO wrote a document. It
 * proves nothing about WHICH repository state the document is valid against,
 * which is the property that matters for a single-use bootstrap. The local mode
 * binds, exhaustively and exactly:
 *
 *     projectId + gateId          the identity being bootstrapped
 *     baseCommit + baseTree       the exact Git HEAD and the exact tree it names
 *     ledgerSha256 + eventCount   the exact ledger pre-state, bytes and length
 *     currentStatus NOT_STARTED   the only status a bootstrap may act from
 *     currentContractPresent=false no contract may already exist
 *     dependencyProof             the exact predecessor disposition/terminal proof
 *     operation                   BOOTSTRAP_CONTRACT_CANONICALIZATION only
 *     authorizedPaths             a finite literal allowlist, no wildcards
 *     artifactBindings            the exact bytes the bootstrap may produce
 *     consumptionRecordPath       where the single use is receipted
 *     maxUse = 1                  plus the prohibition list below
 *
 * THE PRE-STATE IS PROVEN DIFFERENTLY IN EACH PHASE. Before the write it is
 * compared to the live head, which is the check that stands in for the
 * signature. After the write that comparison would demand that the bootstrap
 * never ran, so the pre-state is instead RECONSTRUCTED from the append-only
 * ledger and proven authentic in place (see verifyHistoricalPrestate). A
 * consumed authority therefore stays verifiable for as long as the ledger keeps
 * its history, however far the Gate later advances — while staying exactly as
 * impossible to replay, because the receipt and the contract it created are both
 * blockers for any further AUTHORIZE_WRITE.
 *
 * THE VALIDITY WINDOW SPLITS THE SAME WAY, for the same reason. Before the write
 * it gates PERMISSION and is measured against the clock: issuedAtUtc <= now <=
 * expiresAtUtc, and an expired authority may never bootstrap anything. After the
 * write the clock is irrelevant — what must be shown is that the authority was
 * used while it was valid, so the window is measured against the recorded moment
 * of consumption instead: issuedAtUtc <= recordedAt <= expiresAtUtc. The window
 * is not relaxed anywhere; it is asked about the correct instant.
 *
 * WHAT THIS AUTHORITY MAY NEVER DO. It authorizes the bootstrap write and
 * nothing else. START, AGENT_CLOSURE, EXTERNAL_CONFIRMATION, any other Gate and
 * any arbitrary ledger transition are refused twice over: the operation
 * allowlist admits one operation, and `prohibitedOperations` must enumerate the
 * refusals explicitly. Once CURRENT_CONTRACT exists — or the consumption receipt
 * exists — the authority is spent and re-presenting it is BLOCKED.
 *
 * Fail-closed throughout: absence, malformation, unknown fields, mode confusion
 * and drift all produce BLOCKED. Nothing is upgraded by absence.
 */

import { canonicalize, sha256Hex, verifyOwnerSignature } from './release-authority.mjs';
import { SUCCESSOR_CLOSURE_STATUSES } from './successor-closure.mjs';
import {
  LEGACY_SIGNED_AUTHORITY_MODE,
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  resolveAuthorityMode,
  validateAuthorityMode
} from './post-freeze-maintenance-authority.mjs';

export const PRECONTRACT_SCHEMA_VERSION = 1;
export const PRECONTRACT_REQUEST_KIND = 'PRECONTRACT_AUTHORITY_REQUEST';
export const PRECONTRACT_AUTHORITY_KIND = 'ACTIVE_PRECONTRACT_AUTHORITY';
export const PRECONTRACT_PURPOSE = 'BOOTSTRAP_CONTRACT_CANONICALIZATION';
export const PRECONTRACT_OPERATION = 'BOOTSTRAP_CONTRACT_CANONICALIZATION';
export const PRECONTRACT_STATUS = 'NOT_STARTED';
export const PRECONTRACT_MAX_USE = 1;
/** Re-exported, never restated: one sequencing rule for the whole engine. */
export const TERMINAL_DEPENDENCY_STATUSES = SUCCESSOR_CLOSURE_STATUSES;

/** Reused, not redefined: one authority-mode vocabulary for the whole system. */
export const PRECONTRACT_LOCAL_AUTHORITY_MODE = POST_FREEZE_MAINTENANCE_AUTHORITY_MODE;
export const PRECONTRACT_LEGACY_AUTHORITY_MODE = LEGACY_SIGNED_AUTHORITY_MODE;
export const PRECONTRACT_LOCAL_REQUEST_DIGEST_ALGORITHM = 'SHA256_CANONICAL_JSON_PRECONTRACT_LOCAL_REQUEST_V1';
export const PRECONTRACT_CONSUMPTION_KIND = 'PRECONTRACT_AUTHORITY_CONSUMPTION';
export const PRECONTRACT_CONSUMPTION_SCHEMA_VERSION = 1;
export const PRECONTRACT_HISTORICAL_PRESTATE_ALGORITHM = 'NDJSON_EVENT_PREFIX_RECONSTRUCTION_V1';
export const PRECONTRACT_CONSUMPTION_IDENTITY_ALGORITHM = 'SHA256_CANONICAL_JSON_PRECONTRACT_CONSUMPTION_IDENTITY_V1';
/** Reused from the ledger vocabulary, not redefined: one name for one concept. */
export const PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITION_TYPE = 'PRECONTRACT_CONSUMPTION_ANCHOR';
export const PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_KIND = 'GATE_PRECONTRACT_CONSUMPTION_ANCHOR_LOCAL_AUTHORITY';
export const PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_MODE = POST_FREEZE_MAINTENANCE_AUTHORITY_MODE;
export const PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_MAX_USE = 1;

export const PRECONTRACT_AUTHORITY_ROOT = 'governance/authority/precontract';

/**
 * The deterministic in-repo location of a Gate's local precontract authority.
 *
 * Its siblings — gateAuthorizationRecordPath, gateStartRecordPath and their owner
 * snapshot paths — already existed on their own primitives, so every consumer
 * located those through the primitive that owns them. This one was only ever
 * spelled as a literal at the call site, which is how a consumer came to disagree
 * with the primitive about where the document lives. It is exported here so the
 * path has exactly one definition, like the other three.
 */
export function precontractLocalAuthorityPath(gateId) {
  return `${PRECONTRACT_AUTHORITY_ROOT}/${gateId}/PROJECT_OWNER_LOCAL_PRECONTRACT_AUTHORITY.json`;
}

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'requestId', 'projectId', 'gateId', 'purpose', 'operation',
  'baseCommit', 'ledgerSha256', 'currentStatus', 'dependencyProof', 'authorizedPaths',
  'artifactBindings', 'expiresAtUtc', 'maxUse', 'prohibitedOperations', 'requestDigest'
]);
const AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'authorityMode', 'authorityId', 'issuedBy', 'issuedAtUtc',
  'approvedRequestDigest', 'projectId', 'gateId', 'purpose', 'operation', 'authorizedPaths',
  'artifactBindings', 'expiresAtUtc', 'maxUse', 'ownerKeyId', 'signatureAlgorithm', 'signature'
]);

/**
 * The local authority is self-contained: with no external request document, the
 * authority itself must carry every binding the request used to supply.
 */
const LOCAL_AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'authorityMode', 'authorityId', 'issuedBy', 'issuedAtUtc',
  'localRequestDigestAlgorithm', 'approvedRequestDigest', 'projectId', 'gateId', 'purpose',
  'operation', 'preState', 'dependencyProof', 'authorizedPaths', 'artifactBindings',
  'consumptionRecordPath', 'prohibitedOperations', 'expiresAtUtc', 'maxUse'
]);
const LOCAL_PRE_STATE_FIELDS = Object.freeze([
  'baseCommit', 'baseTree', 'ledgerSha256', 'ledgerEventCount', 'currentStatus', 'currentContractPresent'
]);
const LOCAL_CONSUMPTION_FIELDS = Object.freeze([
  'documentKind', 'schemaVersion', 'authorityId', 'authorityMode', 'projectId', 'gateId',
  'approvedRequestDigest', 'baseCommit', 'baseTree', 'consumedUse', 'recordedAt', 'cohort',
  'consumptionIdentityAlgorithm', 'consumptionIdentityDigest'
]);
const LOCAL_CONSUMPTION_COHORT_FIELDS = Object.freeze(['path', 'sha256']);

const REQUIRED_PROHIBITIONS = Object.freeze([
  'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_CONFIRMED', 'ARBITRARY_LEDGER_TRANSITION',
  'GIT_PUSH', 'ARBITRARY_GOVERNANCE_WRITE', 'OTHER_GATE', 'GEE_REVISION_CREATION', 'FUNCTIONAL_GATE_EXECUTION'
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const GATE_RE = /^GATE(0[0-9]|[1-3][0-9]|40)$/;

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function unknownFields(value, allowed, findings, code) {
  for (const key of Object.keys(value || {})) if (!allowed.includes(key)) finding(findings, code, key);
}

function isExactRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes('*') || value.includes('?')) return false;
  return !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

export function isPrecontractPathAuthorized(authorizedPaths, candidate) {
  return isExactRelativePath(candidate) && Array.isArray(authorizedPaths)
    && authorizedPaths.some((scope) => isExactRelativePath(scope) && scope === candidate);
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameBindings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const normalize = (items) => items.map((item) => `${item?.path}\u0000${item?.sha256}`).sort();
  const a = normalize(left); const b = normalize(right);
  return a.every((value, index) => value === b[index]);
}

export function computePrecontractRequestDigest(request) {
  const { requestDigest, ...unsigned } = request || {};
  return sha256Hex(canonicalize(unsigned));
}

/**
 * Digest of the exact local authority projection. It replaces the absent
 * external request: the authority binds itself, and any edit to any bound field
 * changes the digest the document must already carry.
 */
export function computePrecontractLocalRequestDigest(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
  const fields = [
    'projectId', 'gateId', 'purpose', 'operation', 'preState', 'dependencyProof',
    'authorizedPaths', 'artifactBindings', 'consumptionRecordPath', 'prohibitedOperations',
    'expiresAtUtc', 'maxUse'
  ];
  const projection = {
    algorithm: PRECONTRACT_LOCAL_REQUEST_DIGEST_ALGORITHM,
    authorityMode: authority.authorityMode
  };
  for (const field of fields) projection[field] = authority[field];
  return sha256Hex(canonicalize(projection));
}

/** True when the document names the local mode. Absence resolves to legacy. */
export function isLocalPrecontractAuthority(authority) {
  return resolveAuthorityMode(authority, { defaultLegacy: true }) === PRECONTRACT_LOCAL_AUTHORITY_MODE;
}

function validateDependencyProof(proof, findings) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    finding(findings, 'DEPENDENCY_PROOF_MISSING');
    return;
  }
  if (!GATE_RE.test(proof.gateId || '')) finding(findings, 'DEPENDENCY_GATE_INVALID', proof.gateId);
  if (!TERMINAL_DEPENDENCY_STATUSES.includes(proof.status)) finding(findings, 'DEPENDENCY_NOT_TERMINAL', proof.status);
  if (!isExactRelativePath(proof.authorityPath)) finding(findings, 'DEPENDENCY_AUTHORITY_PATH_INVALID', proof.authorityPath);
  if (!SHA256_RE.test(proof.authoritySha256 || '')) finding(findings, 'DEPENDENCY_AUTHORITY_SHA_INVALID');
}

function validateBindings(paths, bindings, findings) {
  if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) finding(findings, 'AUTHORIZED_PATHS_INVALID');
  else for (const value of paths) if (!isExactRelativePath(value)) finding(findings, 'UNSAFE_AUTHORIZED_PATH', value);
  if (!Array.isArray(bindings) || bindings.length === 0 || new Set(bindings.map((item) => item?.path)).size !== bindings.length) {
    finding(findings, 'ARTIFACT_BINDINGS_INVALID');
    return;
  }
  for (const binding of bindings) {
    if (!isExactRelativePath(binding?.path)) finding(findings, 'UNSAFE_ARTIFACT_PATH', binding?.path);
    if (!SHA256_RE.test(binding?.sha256 || '')) finding(findings, 'ARTIFACT_SHA_INVALID', binding?.path);
  }
  if (!sameStringArray(bindings.map((item) => item.path).sort(), [...paths].sort())) finding(findings, 'PATH_BINDING_MISMATCH');
}

/**
 * Local-mode path/binding rule. It differs from the legacy rule in exactly one
 * way, and for the same reason the maintenance authority excludes its own
 * receipt: the consumption record is written BY the bootstrap, so it is an
 * authorized path but cannot bind its own future bytes. Every other authorized
 * path must carry an exact byte binding.
 */
function validateLocalBindings(paths, bindings, consumptionRecordPath, findings) {
  if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) finding(findings, 'AUTHORIZED_PATHS_INVALID');
  else for (const value of paths) if (!isExactRelativePath(value)) finding(findings, 'UNSAFE_AUTHORIZED_PATH', value);
  if (!isExactRelativePath(consumptionRecordPath)) finding(findings, 'CONSUMPTION_RECORD_PATH_INVALID', consumptionRecordPath);
  else if (Array.isArray(paths) && !paths.includes(consumptionRecordPath)) finding(findings, 'CONSUMPTION_RECORD_PATH_NOT_AUTHORIZED', consumptionRecordPath);
  if (!Array.isArray(bindings) || bindings.length === 0 || new Set(bindings.map((item) => item?.path)).size !== bindings.length) {
    finding(findings, 'ARTIFACT_BINDINGS_INVALID');
    return;
  }
  for (const binding of bindings) {
    if (!isExactRelativePath(binding?.path)) finding(findings, 'UNSAFE_ARTIFACT_PATH', binding?.path);
    if (!SHA256_RE.test(binding?.sha256 || '')) finding(findings, 'ARTIFACT_SHA_INVALID', binding?.path);
    if (binding?.path === consumptionRecordPath) finding(findings, 'CONSUMPTION_RECORD_SELF_BINDING_NOT_PERMITTED', binding.path);
  }
  const expected = (Array.isArray(paths) ? paths : []).filter((value) => value !== consumptionRecordPath).sort();
  if (!sameStringArray(bindings.map((item) => item.path).sort(), expected)) finding(findings, 'PATH_BINDING_MISMATCH');
}

export function validatePrecontractRequest(request) {
  const findings = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    finding(findings, 'REQUEST_ABSENT');
    return { valid: false, findings };
  }
  unknownFields(request, REQUEST_FIELDS, findings, 'REQUEST_UNKNOWN_FIELD');
  if (request.schemaVersion !== PRECONTRACT_SCHEMA_VERSION) finding(findings, 'REQUEST_SCHEMA_VERSION_INVALID');
  if (request.documentKind !== PRECONTRACT_REQUEST_KIND) finding(findings, 'REQUEST_KIND_INVALID');
  if (typeof request.requestId !== 'string' || !request.requestId) finding(findings, 'REQUEST_ID_INVALID');
  if (typeof request.projectId !== 'string' || !request.projectId) finding(findings, 'PROJECT_ID_INVALID');
  if (!GATE_RE.test(request.gateId || '')) finding(findings, 'GATE_ID_INVALID', request.gateId);
  if (request.purpose !== PRECONTRACT_PURPOSE || request.operation !== PRECONTRACT_OPERATION) finding(findings, 'PURPOSE_OR_OPERATION_INVALID');
  if (!COMMIT_RE.test(request.baseCommit || '')) finding(findings, 'BASE_COMMIT_INVALID');
  if (!SHA256_RE.test(request.ledgerSha256 || '')) finding(findings, 'LEDGER_SHA_INVALID');
  if (request.currentStatus !== PRECONTRACT_STATUS) finding(findings, 'CURRENT_STATUS_INVALID', request.currentStatus);
  validateDependencyProof(request.dependencyProof, findings);
  validateBindings(request.authorizedPaths, request.artifactBindings, findings);
  if (typeof request.expiresAtUtc !== 'string' || Number.isNaN(Date.parse(request.expiresAtUtc))) finding(findings, 'EXPIRY_INVALID');
  if (request.maxUse !== PRECONTRACT_MAX_USE) finding(findings, 'MAX_USE_INVALID');
  if (!Array.isArray(request.prohibitedOperations) || REQUIRED_PROHIBITIONS.some((item) => !request.prohibitedOperations.includes(item))) finding(findings, 'PROHIBITED_SCOPE_INCOMPLETE');
  if (!SHA256_RE.test(request.requestDigest || '')) finding(findings, 'REQUEST_DIGEST_INVALID');
  else if (computePrecontractRequestDigest(request) !== request.requestDigest) finding(findings, 'REQUEST_DIGEST_MISMATCH');
  return { valid: findings.length === 0, findings };
}

/** Historical, owner-signed shape. Unchanged apart from the explicit mode name. */
function validateLegacyPrecontractAuthorityShape(authority, findings) {
  unknownFields(authority, AUTHORITY_FIELDS, findings, 'AUTHORITY_UNKNOWN_FIELD');
  if (authority.schemaVersion !== PRECONTRACT_SCHEMA_VERSION) finding(findings, 'AUTHORITY_SCHEMA_VERSION_INVALID');
  if (authority.documentKind !== PRECONTRACT_AUTHORITY_KIND) finding(findings, 'AUTHORITY_KIND_INVALID');
  if (typeof authority.authorityId !== 'string' || !authority.authorityId) finding(findings, 'AUTHORITY_ID_INVALID');
  if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'AUTHORITY_ISSUER_INVALID');
  if (typeof authority.issuedAtUtc !== 'string' || Number.isNaN(Date.parse(authority.issuedAtUtc))) finding(findings, 'ISSUED_AT_INVALID');
  if (!SHA256_RE.test(authority.approvedRequestDigest || '')) finding(findings, 'APPROVED_REQUEST_DIGEST_INVALID');
  if (typeof authority.projectId !== 'string' || !authority.projectId) finding(findings, 'PROJECT_ID_INVALID');
  if (!GATE_RE.test(authority.gateId || '')) finding(findings, 'GATE_ID_INVALID', authority.gateId);
  if (authority.purpose !== PRECONTRACT_PURPOSE || authority.operation !== PRECONTRACT_OPERATION) finding(findings, 'PURPOSE_OR_OPERATION_INVALID');
  validateBindings(authority.authorizedPaths, authority.artifactBindings, findings);
  if (typeof authority.expiresAtUtc !== 'string' || Number.isNaN(Date.parse(authority.expiresAtUtc))) finding(findings, 'EXPIRY_INVALID');
  if (authority.maxUse !== PRECONTRACT_MAX_USE) finding(findings, 'MAX_USE_INVALID');
  if (typeof authority.ownerKeyId !== 'string' || !authority.ownerKeyId) finding(findings, 'OWNER_KEY_ID_INVALID');
  if (authority.signatureAlgorithm !== 'ed25519' || typeof authority.signature !== 'string' || !authority.signature) finding(findings, 'OWNER_SIGNATURE_INVALID');
}

/** Local, unsigned, exhaustively pre-state-bound shape. */
function validateLocalPrecontractAuthorityShape(authority, findings) {
  unknownFields(authority, LOCAL_AUTHORITY_FIELDS, findings, 'AUTHORITY_UNKNOWN_FIELD');
  for (const field of LOCAL_AUTHORITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(authority, field)) finding(findings, 'AUTHORITY_FIELD_MISSING', field);
  }
  if (authority.schemaVersion !== PRECONTRACT_SCHEMA_VERSION) finding(findings, 'AUTHORITY_SCHEMA_VERSION_INVALID');
  if (authority.documentKind !== PRECONTRACT_AUTHORITY_KIND) finding(findings, 'AUTHORITY_KIND_INVALID');
  if (typeof authority.authorityId !== 'string' || !authority.authorityId) finding(findings, 'AUTHORITY_ID_INVALID');
  if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'AUTHORITY_ISSUER_INVALID');
  if (typeof authority.issuedAtUtc !== 'string' || Number.isNaN(Date.parse(authority.issuedAtUtc))) finding(findings, 'ISSUED_AT_INVALID');
  if (typeof authority.projectId !== 'string' || !authority.projectId) finding(findings, 'PROJECT_ID_INVALID');
  if (!GATE_RE.test(authority.gateId || '')) finding(findings, 'GATE_ID_INVALID', authority.gateId);
  if (authority.purpose !== PRECONTRACT_PURPOSE || authority.operation !== PRECONTRACT_OPERATION) finding(findings, 'PURPOSE_OR_OPERATION_INVALID');
  if (authority.localRequestDigestAlgorithm !== PRECONTRACT_LOCAL_REQUEST_DIGEST_ALGORITHM) finding(findings, 'LOCAL_REQUEST_DIGEST_ALGORITHM_INVALID', authority.localRequestDigestAlgorithm);

  const preState = authority.preState;
  if (!preState || typeof preState !== 'object' || Array.isArray(preState)) finding(findings, 'PRE_STATE_INVALID');
  else {
    unknownFields(preState, LOCAL_PRE_STATE_FIELDS, findings, 'PRE_STATE_UNKNOWN_FIELD');
    for (const field of LOCAL_PRE_STATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(preState, field)) finding(findings, 'PRE_STATE_FIELD_MISSING', field);
    }
    if (!COMMIT_RE.test(preState.baseCommit || '')) finding(findings, 'BASE_COMMIT_INVALID');
    if (!COMMIT_RE.test(preState.baseTree || '')) finding(findings, 'BASE_TREE_INVALID');
    if (!SHA256_RE.test(preState.ledgerSha256 || '')) finding(findings, 'LEDGER_SHA_INVALID');
    if (!Number.isInteger(preState.ledgerEventCount) || preState.ledgerEventCount < 0) finding(findings, 'LEDGER_EVENT_COUNT_INVALID');
    if (preState.currentStatus !== PRECONTRACT_STATUS) finding(findings, 'CURRENT_STATUS_INVALID', preState.currentStatus);
    if (preState.currentContractPresent !== false) finding(findings, 'PRE_STATE_CONTRACT_EXPECTATION_INVALID', preState.currentContractPresent);
  }

  validateDependencyProof(authority.dependencyProof, findings);
  validateLocalBindings(authority.authorizedPaths, authority.artifactBindings, authority.consumptionRecordPath, findings);
  if (typeof authority.expiresAtUtc !== 'string' || Number.isNaN(Date.parse(authority.expiresAtUtc))) finding(findings, 'EXPIRY_INVALID');
  if (authority.maxUse !== PRECONTRACT_MAX_USE) finding(findings, 'MAX_USE_INVALID');
  if (!Array.isArray(authority.prohibitedOperations) || REQUIRED_PROHIBITIONS.some((item) => !authority.prohibitedOperations.includes(item))) finding(findings, 'PROHIBITED_SCOPE_INCOMPLETE');
  if (!SHA256_RE.test(authority.approvedRequestDigest || '')) finding(findings, 'APPROVED_REQUEST_DIGEST_INVALID');
  else if (authority.approvedRequestDigest !== computePrecontractLocalRequestDigest(authority)) finding(findings, 'LOCAL_REQUEST_DIGEST_SELF_INCONSISTENT');
}

export function validatePrecontractAuthorityShape(authority) {
  const findings = [];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    finding(findings, 'AUTHORITY_ABSENT');
    return { valid: false, findings };
  }
  // requireLegacySignature stays FALSE here: the legacy branch below reports the
  // missing signature under its own historical finding code, and duplicating it
  // would change the finding set that existing consumers already assert on.
  const modeResult = validateAuthorityMode(authority, { defaultLegacy: true });
  findings.push(...modeResult.findings);
  if (!modeResult.valid && modeResult.mode !== PRECONTRACT_LOCAL_AUTHORITY_MODE && modeResult.mode !== LEGACY_SIGNED_AUTHORITY_MODE) {
    return { valid: false, findings };
  }
  if (modeResult.mode === PRECONTRACT_LOCAL_AUTHORITY_MODE) validateLocalPrecontractAuthorityShape(authority, findings);
  else validateLegacyPrecontractAuthorityShape(authority, findings);
  return { valid: findings.length === 0, findings };
}

/**
 * The single-use receipt. It is validated only in VERIFY_CONSUMPTION, where the
 * authority has already been spent: re-asserting the pre-state there would
 * demand that the bootstrap had never run.
 */
export function validatePrecontractConsumptionRecord(record, authority, findings) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    finding(findings, 'CONSUMPTION_RECORD_MISSING');
    return;
  }
  unknownFields(record, LOCAL_CONSUMPTION_FIELDS, findings, 'CONSUMPTION_UNKNOWN_FIELD');
  if (record.documentKind !== PRECONTRACT_CONSUMPTION_KIND || record.schemaVersion !== PRECONTRACT_CONSUMPTION_SCHEMA_VERSION) finding(findings, 'CONSUMPTION_RECORD_INVALID');
  if (record.authorityMode !== PRECONTRACT_LOCAL_AUTHORITY_MODE) finding(findings, 'CONSUMPTION_AUTHORITY_MODE_INVALID', record.authorityMode);
  if (record.authorityId !== authority?.authorityId) finding(findings, 'CONSUMPTION_AUTHORITY_MISMATCH', 'authorityId');
  if (record.projectId !== authority?.projectId) finding(findings, 'CONSUMPTION_AUTHORITY_MISMATCH', 'projectId');
  if (record.gateId !== authority?.gateId) finding(findings, 'CONSUMPTION_AUTHORITY_MISMATCH', 'gateId');
  if (record.approvedRequestDigest !== authority?.approvedRequestDigest) finding(findings, 'CONSUMPTION_AUTHORITY_MISMATCH', 'approvedRequestDigest');
  if (record.baseCommit !== authority?.preState?.baseCommit) finding(findings, 'CONSUMPTION_BASE_COMMIT_MISMATCH');
  if (record.baseTree !== authority?.preState?.baseTree) finding(findings, 'CONSUMPTION_BASE_TREE_MISMATCH');
  if (record.consumedUse !== PRECONTRACT_MAX_USE) finding(findings, 'CONSUMPTION_USE_INVALID', record.consumedUse);
  if (typeof record.recordedAt !== 'string' || Number.isNaN(Date.parse(record.recordedAt))) finding(findings, 'CONSUMPTION_RECORDED_AT_INVALID');

  const expected = Array.isArray(authority?.artifactBindings) ? authority.artifactBindings : [];
  if (!Array.isArray(record.cohort)) {
    finding(findings, 'CONSUMPTION_COHORT_INVALID');
    return;
  }
  for (const entry of record.cohort) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { finding(findings, 'CONSUMPTION_COHORT_ENTRY_INVALID'); continue; }
    unknownFields(entry, LOCAL_CONSUMPTION_COHORT_FIELDS, findings, 'CONSUMPTION_COHORT_ENTRY_UNKNOWN_FIELD');
  }
  if (!sameBindings(record.cohort, expected)) finding(findings, 'CONSUMPTION_COHORT_MISMATCH');
}

/**
 * Rebuild the exact byte prefix of the append-only ledger that held the first
 * `eventCount` events.
 *
 * The ledger is NDJSON, so the prefix is a literal byte prefix of the file and
 * reconstruction is exact rather than approximate: segments are re-emitted with
 * the terminator they were read with, including any interior blank line, so the
 * recomputed digest equals the digest the authority recorded IF AND ONLY IF no
 * historical byte has moved. That is the whole proof — an altered or reordered
 * historical event changes the digest, and a truncated ledger cannot reach the
 * recorded count at all.
 *
 * Fail-closed: every abnormal input returns `valid: false` with its own code.
 */
export function reconstructLedgerPrefix(ledgerText, eventCount) {
  if (typeof ledgerText !== 'string' || ledgerText.length === 0) return { valid: false, code: 'HISTORICAL_LEDGER_UNREADABLE' };
  if (!Number.isInteger(eventCount) || eventCount <= 0) return { valid: false, code: 'HISTORICAL_EVENT_COUNT_INVALID', detail: eventCount };
  const segments = ledgerText.split('\n');
  const events = [];
  let prefix = '';
  for (let index = 0; index < segments.length && events.length < eventCount; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (last && segment === '') break;
    prefix += last ? segment : `${segment}\n`;
    if (segment.trim() === '') continue;
    let parsed;
    try { parsed = JSON.parse(segment); } catch { return { valid: false, code: 'HISTORICAL_LEDGER_MALFORMED', detail: index + 1 }; }
    events.push(parsed);
  }
  if (events.length !== eventCount) return { valid: false, code: 'HISTORICAL_LEDGER_TOO_SHORT', detail: `${events.length}/${eventCount}` };
  return { valid: true, sha256: sha256Hex(prefix), events, eventCount: events.length };
}

/**
 * THE HISTORICAL PRE-STATE PROOF — why VERIFY_CONSUMPTION cannot reuse the
 * AUTHORIZE_WRITE comparison.
 *
 * Before the write, "is the repository in the state this authority was issued
 * against?" is answered by comparing the recorded pre-state to the LIVE head.
 * That is the check that replaces the signature, and it stays exactly as it was.
 *
 * After the write, the same comparison asks the repository to still be in the
 * pre-bootstrap state — that is, it demands that the bootstrap never ran and
 * that the Gate never advanced. A consumed authority would then be refutable by
 * nothing worse than the Gate lawfully reaching COMPLETE_AGENT. A single-use
 * receipt whose validity decays as history moves forward is not a receipt.
 *
 * So the pre-state is not compared to the present here; it is RECONSTRUCTED from
 * the append-only ledger and proven authentic in place. The proof is strictly
 * stronger than the live comparison it replaces, because it also establishes
 * that the historical bytes have not been rewritten since.
 *
 * Nothing here trusts a caller-supplied verdict: the digest, the derived status
 * and the genesis-only proof are all recomputed from the raw ledger text.
 */
function verifyHistoricalPrestate(authority, observed, findings) {
  const preState = authority?.preState || {};
  const prefix = reconstructLedgerPrefix(observed.ledgerText, preState.ledgerEventCount);
  if (!prefix.valid) finding(findings, prefix.code, prefix.detail);
  else if (prefix.sha256 !== preState.ledgerSha256) finding(findings, 'HISTORICAL_LEDGER_SHA_MISMATCH', prefix.sha256);
  else {
    const own = prefix.events.filter((event) => event?.gateId === authority?.gateId);
    const latest = own.at(-1) || null;
    if (!latest) finding(findings, 'HISTORICAL_GATE_ABSENT_FROM_PREFIX', authority?.gateId);
    else if (latest.toStatus !== PRECONTRACT_STATUS) finding(findings, 'HISTORICAL_STATUS_NOT_NOT_STARTED', latest.toStatus);
    // A Gate that has only ever been imported has no contract: the contract is
    // created BY this bootstrap. Genesis-only in the reconstructed prefix is the
    // ledger-derived form of the recorded `currentContractPresent: false`, which
    // cannot be observed directly once the contract exists.
    if (latest && !own.every((event) => event.transitionType === 'GENESIS_IMPORT')) finding(findings, 'HISTORICAL_LIFECYCLE_PRECEDED_BOOTSTRAP', own.length);
  }

  // The recorded commit is not required to still be HEAD — later commits are
  // lawful — but it must be a real commit of THIS repository, naming the tree the
  // authority recorded, and still reachable from HEAD so that a bootstrap cannot
  // cite an abandoned or foreign history.
  const commit = observed.historicalCommit;
  if (!commit || typeof commit !== 'object' || commit.present !== true) finding(findings, 'HISTORICAL_BASE_COMMIT_UNKNOWN', preState.baseCommit);
  else {
    if (commit.tree !== preState.baseTree) finding(findings, 'HISTORICAL_BASE_TREE_MISMATCH', commit.tree);
    if (commit.reachableFromHead !== true) finding(findings, 'HISTORICAL_BASE_COMMIT_NOT_REACHABLE', preState.baseCommit);
  }
  // Returned so the consumption proofs reuse the SAME reconstruction rather than
  // rebuilding one that might differ.
  return prefix;
}

/**
 * CURRENT_CONTRACT must still resolve to the execution contract this bootstrap
 * minted. Byte equality alone would not say it: a CURRENT_CONTRACT redirected to
 * another Gate's contract and then re-pinned would satisfy a hash check on its
 * own bytes, so the link itself is verified — bound path, exact revision digest,
 * own Gate, and never a self-reference.
 */
function verifyCurrentContractLink(authority, observed, findings) {
  const link = observed.currentContractLink;
  if (!link || typeof link !== 'object' || Array.isArray(link)) { finding(findings, 'CURRENT_CONTRACT_LINK_UNREADABLE'); return; }
  if (link.gateId !== authority?.gateId) finding(findings, 'CURRENT_CONTRACT_LINK_GATE_MISMATCH', link.gateId);
  if (link.contractPath === observed.currentContractRelativePath) { finding(findings, 'CURRENT_CONTRACT_LINK_SELF_REFERENCE', link.contractPath); return; }
  const bound = (Array.isArray(authority?.artifactBindings) ? authority.artifactBindings : []).find((item) => item?.path === link.contractPath) || null;
  if (!bound) { finding(findings, 'CURRENT_CONTRACT_LINK_NOT_AUTHORIZED', link.contractPath); return; }
  if (link.contractSha256 !== bound.sha256) finding(findings, 'CURRENT_CONTRACT_LINK_SHA_MISMATCH', link.contractPath);
}

/**
 * THE CONSUMPTION IDENTITY — what makes `recordedAt` more than a claim.
 *
 * A timestamp that merely sits inside the validity window proves nothing: any
 * other in-window value would have passed just as well, so the recorded instant
 * was decoration rather than evidence. What is needed is that the instant be
 * INSIDE the identity of the consumption, so that moving it alone stops the
 * receipt from reproducing.
 *
 * The digest is therefore computed over the whole consumption identity, and
 * every input except `recordedAt` and `consumedUse` is recoverable from
 * somewhere other than the receipt: the authority document supplies its own id,
 * self-digest and pre-state; the ledger prefix digest is recomputed from the
 * append-only ledger; the cohort hashes are re-read from the artifacts on disk.
 * A validator can therefore rebuild the expected digest without trusting the
 * receipt for anything but the instant it is attesting to.
 *
 * WHAT THIS DOES AND DOES NOT ACHIEVE. It makes a lone edit of `recordedAt` fail
 * closed, which is the reported defect. It cannot make the receipt unforgeable
 * against an adversary who rewrites every governed artifact consistently — no
 * purely local scheme can, without a secret or an external time authority, and
 * both are out of scope by mandate. The ledger bracket below is what narrows
 * that residue: the two endpoints come from the hash-chained ledger, so the
 * instant cannot be moved outside them at all.
 */
export function computePrecontractConsumptionIdentityDigest({
  authority, ledgerPrefixSha256, ledgerEventCount, cohort, recordedAt, consumedUse
} = {}) {
  const normalizedCohort = (Array.isArray(cohort) ? cohort : [])
    .map((entry) => ({ path: entry?.path, sha256: entry?.sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return sha256Hex(canonicalize({
    algorithm: PRECONTRACT_CONSUMPTION_IDENTITY_ALGORITHM,
    authorityId: authority?.authorityId,
    authorityMode: PRECONTRACT_LOCAL_AUTHORITY_MODE,
    projectId: authority?.projectId,
    gateId: authority?.gateId,
    approvedRequestDigest: authority?.approvedRequestDigest,
    baseCommit: authority?.preState?.baseCommit,
    baseTree: authority?.preState?.baseTree,
    consumptionRecordPath: authority?.consumptionRecordPath,
    ledgerPrefixSha256,
    ledgerEventCount,
    consumedUse,
    recordedAt,
    cohort: normalizedCohort
  }));
}

/**
 * The canonical shape of the receipt, in one place.
 *
 * The applier writes it and the repair path re-derives it through this same
 * function, so a receipt can never be assembled two subtly different ways.
 */
export function buildPrecontractConsumptionRecord({
  authority, ledgerPrefixSha256, ledgerEventCount, recordedAt, consumedUse = PRECONTRACT_MAX_USE
} = {}) {
  const cohort = (Array.isArray(authority?.artifactBindings) ? authority.artifactBindings : [])
    .map((binding) => ({ path: binding.path, sha256: binding.sha256 }));
  return {
    documentKind: PRECONTRACT_CONSUMPTION_KIND,
    schemaVersion: PRECONTRACT_CONSUMPTION_SCHEMA_VERSION,
    authorityId: authority?.authorityId,
    authorityMode: PRECONTRACT_LOCAL_AUTHORITY_MODE,
    projectId: authority?.projectId,
    gateId: authority?.gateId,
    approvedRequestDigest: authority?.approvedRequestDigest,
    baseCommit: authority?.preState?.baseCommit,
    baseTree: authority?.preState?.baseTree,
    consumedUse,
    recordedAt,
    cohort,
    consumptionIdentityAlgorithm: PRECONTRACT_CONSUMPTION_IDENTITY_ALGORITHM,
    consumptionIdentityDigest: computePrecontractConsumptionIdentityDigest({
      authority, ledgerPrefixSha256, ledgerEventCount, cohort, recordedAt, consumedUse
    })
  };
}

/**
 * The instant of consumption, checked against the ledger's own hash chain.
 *
 * The bootstrap happens between two ledger facts: the pre-state the authority
 * was bound to, and whatever was appended next. Both endpoints live inside the
 * append-only chain whose prefix digest the historical proof has already
 * verified, so neither can be moved without breaking that digest. The instant is
 * therefore not merely "somewhere in the authority's window" but pinned to a
 * position in a chain of events nobody can rewrite in place.
 *
 * The upper bound is absent immediately after a bootstrap, before anything else
 * has been appended. That is a legitimate state, not a gap: the lower bound and
 * the authority window still apply, and the bound appears as soon as the ledger
 * moves on.
 */
function validateConsumptionLedgerBracket(record, prefixEvents, allEvents, findings) {
  const consumedAt = Date.parse(record?.recordedAt);
  if (!Number.isFinite(consumedAt)) return;
  const lower = (Array.isArray(prefixEvents) ? prefixEvents : [])
    .map((event) => Date.parse(event?.recordedAt)).filter(Number.isFinite).sort((a, b) => a - b).at(-1);
  if (Number.isFinite(lower) && consumedAt < lower) {
    finding(findings, 'CONSUMPTION_BEFORE_BOUND_LEDGER_PRESTATE', record.recordedAt);
  }
  const beyond = (Array.isArray(allEvents) ? allEvents : []).slice(prefixEvents?.length ?? 0);
  const upper = beyond.map((event) => Date.parse(event?.recordedAt)).filter(Number.isFinite).at(0);
  if (Number.isFinite(upper) && consumedAt > upper) {
    finding(findings, 'CONSUMPTION_AFTER_NEXT_LEDGER_EVENT', record.recordedAt);
  }
}

/**
 * THE ANCHOR AUTHORITY BINDING — one primitive, two consumers.
 *
 * WHY THIS EXISTS AS A SHARED FUNCTION. The anchor event states a receipt digest,
 * but an event does not get to PERMIT itself: like every other transition class in
 * this project, it cites a single-use authority by path AND by hash, and that
 * authority names `consumptionRecordSha256` independently. `validate-status-ledger`
 * has always proven that leg (PRECONTRACT_ANCHOR_DIGEST_MISMATCH and its
 * neighbours); VERIFY_CONSUMPTION did not, and stopped at the event.
 *
 * That gap was the whole defect. A forger able to edit both the receipt and the
 * ledger could move `recordedAt`, recompute the in-file identity digest with the
 * official helper, recompute the receipt's byte digest, restate that digest in the
 * anchor event and re-derive `eventPayloadSha256` — internally perfect at every
 * link the consumer inspected, while the anchor authority still named the ORIGINAL
 * digest. Two validators over one repository returned opposite verdicts.
 *
 * The fix is not a second model of the same property. The clause set below IS the
 * ledger validator's clause set, lifted here so both consumers evaluate one
 * semantics: the ledger validator maps these clauses onto its existing detector
 * ids, and VERIFY_CONSUMPTION reports them under the CONSUMPTION_ANCHOR_
 * vocabulary. A clause added here is a clause both validators gain.
 *
 * PURE BY CONSTRUCTION. No I/O, no crypto, no clock. The caller resolves the cited
 * bytes — that is the part that differs between a ledger walk and a consumption
 * check — and passes the result as observation. Everything judged here is judged
 * from data the caller could not have shortcut: `anchorAuthority.sha256` is the
 * digest of the bytes actually read, never a digest anyone recorded.
 *
 * FAIL CLOSED. Absence, malformation and an unresolvable citation are refusals,
 * never skips. `terminal` marks the states where nothing further can be judged, so
 * a caller stops rather than continuing against a document it does not have.
 *
 * @param {object|null} options.event      the PRECONTRACT_CONSUMPTION_ANCHOR event.
 * @param {object|null} options.anchorAuthority  `{ present, sha256, record }` for the
 *   bytes at the event's OWN cited path. Absent or unreadable ⇒ `{ present: false }`.
 * @param {object|null} options.precontractAuthority  the underlying precontract
 *   authority, when the caller holds it. Omitted ⇒ the `source` clauses are not
 *   evaluated and the caller reports its own unresolved code, exactly as before.
 * @returns {{authority: object[], source: object[], terminal: boolean, bound: boolean}}
 */
export function evaluatePrecontractConsumptionAnchorBinding({
  event = null, anchorAuthority = null, precontractAuthority = null
} = {}) {
  const authority = [];
  const source = [];
  const clause = (list, name, actual, expected) => {
    list.push({ clause: name, actual: actual ?? null, expected: expected ?? null });
  };
  const done = (terminal) => ({ authority, source, terminal, bound: !terminal && authority.length === 0 && source.length === 0 });

  // The event must name its authority by path AND by digest; one without the
  // other pins nothing.
  const citedPath = typeof event?.authorityPath === 'string' && event.authorityPath ? event.authorityPath : null;
  const citedSha = SHA256_RE.test(event?.authoritySha256 || '') ? event.authoritySha256 : null;
  if (!citedPath || !citedSha || !anchorAuthority?.present) {
    clause(authority, 'AUTHORITY_UNRESOLVED', event?.authoritySha256 ?? null, 'resolvable cited authority');
    return done(true);
  }
  // The bytes actually read must be the bytes the event pinned. Without this the
  // authority is merely a file at a path, and any file could be swapped in.
  if (anchorAuthority.sha256 !== citedSha) {
    clause(authority, 'AUTHORITY_BYTES_MISMATCH', anchorAuthority.sha256 ?? null, citedSha);
  }
  const record = anchorAuthority.record;
  if (!record || typeof record !== 'object') {
    clause(authority, 'AUTHORITY_MALFORMED', citedPath, 'JSON object');
    return done(true);
  }

  // It must BE an anchor authority, for THIS Gate, single use.
  if (record.documentKind !== PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_KIND) clause(authority, 'AUTHORITY_KIND_INVALID', record.documentKind, PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_KIND);
  if (record.gateId !== event.gateId) clause(authority, 'AUTHORITY_GATE_MISMATCH', record.gateId, event.gateId);
  if (record.authorityMode !== PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_MODE) clause(authority, 'AUTHORITY_MODE_INVALID', record.authorityMode, PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_MODE);
  if (record.maxUse !== PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_MAX_USE) clause(authority, 'AUTHORITY_MAX_USE_INVALID', record.maxUse, PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_MAX_USE);

  // The decisive pair: the receipt identity the event states must be the identity
  // its authority permitted — path and digest both.
  const anchored = event.precontractConsumption;
  if (!anchored || typeof anchored !== 'object') {
    clause(authority, 'BINDING_ABSENT', anchored ?? null, '{ path, sha256 }');
    return done(true);
  }
  if (anchored.path !== record.consumptionRecordPath) clause(authority, 'RECORD_PATH_MISMATCH', anchored.path, record.consumptionRecordPath);
  if (anchored.sha256 !== record.consumptionRecordSha256) clause(authority, 'RECORD_DIGEST_MISMATCH', anchored.sha256, record.consumptionRecordSha256);

  // And the anchor must sit above the precontract authority it claims to serve,
  // so an anchor cannot legitimise a receipt belonging to some other bootstrap.
  if (precontractAuthority) {
    if (precontractAuthority.gateId !== event.gateId) clause(source, 'SOURCE_GATE_MISMATCH', precontractAuthority.gateId, event.gateId);
    if (precontractAuthority.consumptionRecordPath !== anchored.path) clause(source, 'SOURCE_PATH_MISMATCH', precontractAuthority.consumptionRecordPath, anchored.path);
    if (record.precontractAuthorityId && precontractAuthority.authorityId !== record.precontractAuthorityId) clause(source, 'SOURCE_AUTHORITY_MISMATCH', precontractAuthority.authorityId, record.precontractAuthorityId);
  }
  return done(false);
}

/**
 * THE EXTERNAL ANCHOR — why the identity digest alone was never enough.
 *
 * `consumptionIdentityDigest` lives in the same file whose `recordedAt` it
 * protects. Anyone who can edit the receipt can recompute the digest with the
 * official implementation and produce a receipt that verifies. It is a checksum
 * against accident, not an anchor against rewriting, and treating it as the
 * latter was the defect.
 *
 * An anchor has to live somewhere the receipt's author cannot quietly revise.
 * This project has exactly one such structure: the append-only, hash-chained
 * status ledger. So the receipt's exact digest is stated there, by a
 * PRECONTRACT_CONSUMPTION_ANCHOR event, and verification asks the ledger what
 * the receipt was supposed to say rather than asking the receipt.
 *
 * The anchor is found by SCANNING the ledger, never by following a pointer the
 * receipt supplies — a receipt that chose its own anchor would be back to
 * vouching for itself. Exactly one anchor may exist for a Gate: several would
 * let a convenient one be selected after the fact.
 *
 * `observed.ledgerEvents` is the live ledger rather than the historical prefix,
 * and deliberately: the anchor is appended AFTER the bootstrap, so it is not in
 * the pre-state the authority was bound to. That does not weaken the historical
 * proof, which continues to be judged on the prefix alone.
 */
function validateReceiptAnchor(authority, record, observed, findings) {
  const events = Array.isArray(observed.ledgerEvents) ? observed.ledgerEvents : [];
  const anchors = events.filter((event) => event?.gateId === authority?.gateId
    && event?.transitionType === PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITION_TYPE);
  if (anchors.length === 0) {
    /**
     * ORDERING, NOT AN EXEMPTION. An anchor states the digest of a receipt, so it
     * cannot precede the receipt it describes: at the instant a bootstrap
     * publishes, the ledger has not moved and no anchor can exist yet.
     *
     * The obligation therefore attaches to the FIRST ledger append after the
     * bootstrap, which is exactly the architectural rule: the first canonical
     * lifecycle event after a successful consumption binds the receipt. As soon
     * as the ledger has advanced past the pre-state the authority was bound to,
     * an unanchored receipt is refused — so the window closes by itself and
     * cannot be held open.
     */
    if (events.length > (authority?.preState?.ledgerEventCount ?? 0)) {
      finding(findings, 'CONSUMPTION_RECEIPT_NOT_ANCHORED', authority?.consumptionRecordPath);
    }
    return;
  }
  if (anchors.length > 1) { finding(findings, 'CONSUMPTION_RECEIPT_ANCHOR_AMBIGUOUS', anchors.length); return; }
  const anchored = anchors[0].precontractConsumption;
  if (!anchored || typeof anchored !== 'object') { finding(findings, 'CONSUMPTION_ANCHOR_BINDING_ABSENT'); return; }
  if (anchored.path !== authority?.consumptionRecordPath) {
    finding(findings, 'CONSUMPTION_ANCHOR_PATH_MISMATCH', anchored.path);
    return;
  }
  if (!SHA256_RE.test(anchored.sha256 || '')) { finding(findings, 'CONSUMPTION_ANCHOR_DIGEST_INVALID', anchored.sha256); return; }

  /**
   * AND THE EVENT MUST ITSELF BE AUTHORIZED.
   *
   * Everything above compares the receipt to the EVENT. That is necessary and was
   * not sufficient: an attacker who can append to the receipt can also restate the
   * event, and a restated event re-digests cleanly. The event is therefore held to
   * the same standard as every other transition — it must be permitted by the
   * single-use authority it cites, whose `consumptionRecordSha256` no rewrite of
   * the receipt or of the event can reach.
   *
   * The authority is resolved by the EVENT'S OWN citation, supplied as observation
   * because the core does no I/O. An absent observation is a refusal, not a skip:
   * a consumer that cannot see the authority has not proven the binding.
   */
  const anchorAuthority = observed.anchorAuthorities && typeof observed.anchorAuthorities === 'object'
    ? observed.anchorAuthorities[anchors[0].authorityPath] ?? null
    : null;
  const binding = evaluatePrecontractConsumptionAnchorBinding({
    event: anchors[0], anchorAuthority, precontractAuthority: authority
  });
  for (const item of [...binding.authority, ...binding.source]) {
    finding(findings, `CONSUMPTION_ANCHOR_${item.clause}`, item.actual);
  }

  // The decisive comparison: the receipt's own bytes against what the ledger
  // recorded them to be. Editing recordedAt changes the bytes, so it changes
  // this digest, and repairing the in-file identity digest does not help.
  if (observed.consumptionRecordSha256 !== anchored.sha256) {
    finding(findings, 'CONSUMPTION_RECEIPT_ANCHOR_MISMATCH', observed.consumptionRecordSha256 ?? null);
  }
}

/**
 * Recompute the consumption identity from sources other than the receipt, and
 * require the receipt to already carry the result.
 *
 * The cohort used here is the AUTHORITY's binding list, not the receipt's copy
 * of it, and the ledger digest is the one this validator reconstructed rather
 * than the one anybody recorded. So the expected digest is derived from evidence
 * the receipt does not own, and a receipt that disagrees with it is refused.
 */
function validateConsumptionAuthenticity(authority, record, prefix, findings) {
  if (record?.consumptionIdentityAlgorithm !== PRECONTRACT_CONSUMPTION_IDENTITY_ALGORITHM) {
    finding(findings, 'CONSUMPTION_IDENTITY_ALGORITHM_INVALID', record?.consumptionIdentityAlgorithm);
    return;
  }
  if (!SHA256_RE.test(record?.consumptionIdentityDigest || '')) {
    finding(findings, 'CONSUMPTION_IDENTITY_DIGEST_INVALID', record?.consumptionIdentityDigest);
    return;
  }
  if (!prefix?.valid) { finding(findings, 'CONSUMPTION_IDENTITY_UNVERIFIABLE', 'historical ledger prefix unavailable'); return; }
  const expected = computePrecontractConsumptionIdentityDigest({
    authority,
    ledgerPrefixSha256: prefix.sha256,
    ledgerEventCount: prefix.eventCount,
    cohort: authority?.artifactBindings,
    recordedAt: record.recordedAt,
    consumedUse: record.consumedUse
  });
  if (expected !== record.consumptionIdentityDigest) finding(findings, 'CONSUMPTION_IDENTITY_DIGEST_MISMATCH', expected);
}

/**
 * The temporal half of the historical proof.
 *
 * The question a spent authority must answer is not "is the window still open?"
 * but "was the window open at the moment this authority was actually used?".
 * That instant is the consumption receipt's own `recordedAt`, and it is bound to
 * the authority by everything validatePrecontractConsumptionRecord already
 * checks, so it cannot be moved without breaking the rest of the receipt.
 *
 * Both bounds are inclusive, matching the pre-write rule exactly: an authority
 * used at the very second of its expiry was used lawfully, and the same is true
 * of one used at the instant it was issued. Fail-closed: an unparsable or absent
 * `recordedAt` proves nothing and is refused rather than skipped.
 */
function validateConsumptionWindow(authority, consumptionRecord, findings) {
  const issued = Date.parse(authority?.issuedAtUtc);
  const expiry = Date.parse(authority?.expiresAtUtc);
  const consumedAt = Date.parse(consumptionRecord?.recordedAt);
  // A distinct code, not a second CONSUMPTION_RECORDED_AT_INVALID: the record
  // validator owns that finding, and this check must be seen to refuse rather
  // than be silently skipped should the two ever drift apart.
  if (!Number.isFinite(consumedAt)) { finding(findings, 'CONSUMPTION_WINDOW_UNVERIFIABLE', consumptionRecord?.recordedAt); return; }
  if (!Number.isFinite(issued) || !Number.isFinite(expiry)) { finding(findings, 'AUTHORITY_WINDOW_UNRESOLVABLE'); return; }
  if (consumedAt < issued) finding(findings, 'CONSUMPTION_BEFORE_AUTHORITY_ISSUED', consumptionRecord.recordedAt);
  if (consumedAt > expiry) finding(findings, 'CONSUMPTION_AFTER_AUTHORITY_EXPIRED', consumptionRecord.recordedAt);
}

function compareDependency(observed, expected, findings) {
  if (!observed || observed.gateId !== expected?.gateId || observed.status !== expected?.status
    || observed.authorityPath !== expected?.authorityPath || observed.authoritySha256 !== expected?.authoritySha256) finding(findings, 'DEPENDENCY_PROOF_MISMATCH');
  if (!TERMINAL_DEPENDENCY_STATUSES.includes(observed?.status)) finding(findings, 'DEPENDENCY_NOT_TERMINAL', observed?.status);
}

/**
 * The one decision function, for both modes.
 *
 * @param {object|null} options.request  Legacy mode only. In local mode a
 *   request is not merely optional but REFUSED, so a caller cannot smuggle a
 *   second, differently-bound document past an authority that never binds it.
 */
export function evaluatePrecontractAuthority({
  request = null, authority = null, ownerKey = null, observed = {},
  operation = PRECONTRACT_OPERATION, requestedPath = null, now = new Date(),
  phase = 'AUTHORIZE_WRITE', consumptionRecord = null
} = {}) {
  const findings = [];
  const local = isLocalPrecontractAuthority(authority);
  /**
   * The historical phase: a local authority that has already been spent. Both
   * the pre-state proof and the temporal proof below branch on it, because both
   * answer "was this lawful THEN?" rather than "is this permitted NOW?".
   */
  const historicalPhase = local && phase === 'VERIFY_CONSUMPTION';
  const authorityResult = validatePrecontractAuthorityShape(authority);
  const requestResult = local ? { valid: true, findings: [] } : validatePrecontractRequest(request);
  findings.push(...requestResult.findings, ...authorityResult.findings);

  if (local && request !== null) finding(findings, 'LOCAL_AUTHORITY_REQUEST_NOT_PERMITTED');

  if (authorityResult.valid) {
    if (!local) {
      const signature = verifyOwnerSignature(authority, ownerKey);
      if (!signature.verified) finding(findings, signature.reason);
    }
    /**
     * THE VALIDITY WINDOW IS A PERMISSION, NOT A PROOF OF HISTORY.
     *
     * `issuedAtUtc..expiresAtUtc` answers "may this authority be USED now?", and
     * for a pre-write decision that is exactly the right question: an expired
     * authority must never bootstrap anything, then or later.
     *
     * Applying the same test to a spent authority asks something else entirely —
     * whether a thing that already happened is still allowed to have happened.
     * Under that reading a lawfully consumed bootstrap became unverifiable the
     * day the clock passed the expiry, with no mutation of the repository at all,
     * and every historical proof was lost to nothing but the passage of time.
     *
     * So the window is not removed, it is asked about the right instant: the
     * recorded moment of consumption (see validateConsumptionWindow).
     */
    if (!historicalPhase) {
      const issued = Date.parse(authority.issuedAtUtc);
      const expiry = Date.parse(authority.expiresAtUtc);
      if (now.getTime() > expiry) finding(findings, 'AUTHORITY_EXPIRED');
      if (Number.isFinite(issued) && now.getTime() < issued) finding(findings, 'AUTHORITY_NOT_YET_VALID');
    }
  }
  if (!local && requestResult.valid && authorityResult.valid) {
    if (authority.approvedRequestDigest !== request.requestDigest || authority.approvedRequestDigest !== computePrecontractRequestDigest(request)) finding(findings, 'REQUEST_AUTHORITY_DIGEST_MISMATCH');
    for (const field of ['projectId', 'gateId', 'purpose', 'operation', 'expiresAtUtc', 'maxUse']) if (authority[field] !== request[field]) finding(findings, 'AUTHORITY_REQUEST_BINDING_MISMATCH', field);
    if (!sameStringArray(authority.authorizedPaths, request.authorizedPaths)) finding(findings, 'AUTHORITY_PATHS_MISMATCH');
    if (!sameBindings(authority.artifactBindings, request.artifactBindings)) finding(findings, 'AUTHORITY_ARTIFACT_BINDINGS_MISMATCH');
  }

  // The binding the live repository is compared against: the request in legacy
  // mode, the self-contained authority in local mode.
  const binding = local
    ? {
        projectId: authority?.projectId, gateId: authority?.gateId,
        baseCommit: authority?.preState?.baseCommit, baseTree: authority?.preState?.baseTree,
        ledgerSha256: authority?.preState?.ledgerSha256, ledgerEventCount: authority?.preState?.ledgerEventCount,
        dependencyProof: authority?.dependencyProof, authorizedPaths: authority?.authorizedPaths,
        artifactBindings: authority?.artifactBindings
      }
    : {
        projectId: request?.projectId, gateId: request?.gateId,
        baseCommit: request?.baseCommit, baseTree: undefined,
        ledgerSha256: request?.ledgerSha256, ledgerEventCount: undefined,
        dependencyProof: request?.dependencyProof, authorizedPaths: request?.authorizedPaths,
        artifactBindings: request?.artifactBindings
      };

  if (operation !== PRECONTRACT_OPERATION) finding(findings, 'OPERATION_NOT_AUTHORIZED', operation);
  if (requestedPath !== null && !isPrecontractPathAuthorized(binding.authorizedPaths, requestedPath)) finding(findings, 'PATH_NOT_AUTHORIZED', requestedPath);
  if (observed.projectId !== binding.projectId) finding(findings, 'PROJECT_ID_MISMATCH');
  if (observed.gateId !== binding.gateId) finding(findings, 'GATE_ID_MISMATCH');
  /**
   * The pre-state is proven LIVE before the write and HISTORICALLY after it.
   *
   * The historical branch is local-mode only, and deliberately so: a
   * LEGACY_SIGNED_AUTHORITY records neither a base tree nor an event count, so
   * there is nothing to reconstruct a prefix from, and its real defence is the
   * owner's key rather than a pre-state binding. Routing it through a proof it
   * cannot satisfy would change historical validation outcomes, so the legacy
   * path keeps the live comparison byte-for-byte.
   */
  let historicalPrefix = null;
  if (historicalPhase) historicalPrefix = verifyHistoricalPrestate(authority, observed, findings);
  else {
    if (observed.headCommit !== binding.baseCommit) finding(findings, 'BASE_COMMIT_MISMATCH');
    if (observed.ledgerSha256 !== binding.ledgerSha256) finding(findings, 'LEDGER_SHA_MISMATCH');
    if (local) {
      if (observed.headTree !== binding.baseTree) finding(findings, 'BASE_TREE_MISMATCH');
      if (observed.ledgerEventCount !== binding.ledgerEventCount) finding(findings, 'LEDGER_EVENT_COUNT_MISMATCH');
    }
    if (observed.currentStatus !== PRECONTRACT_STATUS) finding(findings, 'CURRENT_STATUS_NOT_NOT_STARTED', observed.currentStatus);
  }
  // Replay-scoped in the historical phase: the adapter resolves the predecessor
  // against the reconstructed prefix, so a later event on the dependency Gate
  // cannot retroactively invalidate a lawful bootstrap.
  compareDependency(observed.dependencyProof, binding.dependencyProof, findings);

  if (phase === 'AUTHORIZE_WRITE') {
    if (observed.currentContractPresent === true) finding(findings, 'CURRENT_CONTRACT_PRESENT');
    if (observed.consumed === true) finding(findings, 'AUTHORITY_ALREADY_CONSUMED');
    if (local && observed.consumptionRecordPresent === true) finding(findings, 'AUTHORITY_ALREADY_CONSUMED', 'consumptionRecord');
  } else if (phase === 'VERIFY_CONSUMPTION') {
    if (observed.currentContractPresent !== true) finding(findings, 'CURRENT_CONTRACT_NOT_CREATED');
    for (const item of binding.artifactBindings || []) if (observed.targetFileSha256?.[item.path] !== item.sha256) finding(findings, 'ARTIFACT_BYTES_MISMATCH', item.path);
    if (local) {
      verifyCurrentContractLink(authority, observed, findings);
      // Asserting both marks positively is also the proof that no second use is
      // reachable: each of them is an AUTHORIZE_WRITE blocker, so an authority
      // that verifies as consumed can no longer authorize a write.
      if (observed.consumptionRecordPresent !== true) finding(findings, 'AUTHORITY_NOT_MARKED_CONSUMED');
      validatePrecontractConsumptionRecord(consumptionRecord, authority, findings);
      // Three independent questions about the same instant: was it inside the
      // authority's window, is it part of the receipt's identity, and does it sit
      // where the hash-chained ledger says the bootstrap must have happened?
      validateConsumptionWindow(authority, consumptionRecord, findings);
      validateConsumptionAuthenticity(authority, consumptionRecord, historicalPrefix, findings);
      validateConsumptionLedgerBracket(consumptionRecord, historicalPrefix?.events, observed.ledgerEvents, findings);
      // The only one of the four that a receipt cannot satisfy by rewriting itself.
      validateReceiptAnchor(authority, consumptionRecord, observed, findings);
    }
  } else finding(findings, 'PHASE_INVALID', phase);

  const decision = findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED';
  return {
    decision,
    authorityMode: local ? PRECONTRACT_LOCAL_AUTHORITY_MODE : LEGACY_SIGNED_AUTHORITY_MODE,
    bootstrapAuthorized: decision === 'AUTHORIZED' && phase === 'AUTHORIZE_WRITE',
    consumed: decision === 'AUTHORIZED' && phase === 'VERIFY_CONSUMPTION',
    findings,
    authorizedPaths: decision === 'AUTHORIZED' && phase === 'AUTHORIZE_WRITE' ? [...binding.authorizedPaths] : []
  };
}
