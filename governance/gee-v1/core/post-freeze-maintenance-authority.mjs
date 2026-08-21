/**
 * GEE V1 core — post-freeze maintenance authority, schema V2.
 *
 * V2 exists because V1 authorizes a FILE LIST and nothing else: it cannot bind
 * the repository state a program was authorized against, cannot be single-use,
 * and cannot separate "which paths" from "which kind of operation". A multi-phase
 * governance implementation program needs all three.
 *
 * AUTHORITY MODE — LOCAL_EXPLICIT_AUTHORITY.
 *
 * V2 is deliberately NOT an owner-signed document. The Project Owner fixed the
 * policy for new maintenance/program authority: this project does not operate a
 * PKI, so requiring an Ed25519 signature bought no real protection while adding
 * a private key, an external signer, key rotation and a recovery root to the
 * governed surface. A signature proves WHO wrote a document; it proves nothing
 * about WHAT state that document is valid against, which is the property that
 * actually matters here.
 *
 * The protection V2 relies on instead is exhaustive pre-state binding, and every
 * one of these must match the live repository before anything is authorized:
 *
 *   exact Git base HEAD          — moves the moment a commit lands, so an
 *                                  authority cannot survive its own program
 *   exact ledger event count     — no appended event goes unnoticed
 *   exact ledger prefix digest   — no rewritten event goes unnoticed
 *   exact Gate/status/state/contract/ACTIVE_GATE pre-state
 *   exact R8 expectation
 *   exact authorized-path manifest digest
 *   literal finite path allowlist, no wildcards, no directory recursion
 *   literal operation-class allowlist
 *   maxUse = 1, pushAuthorized = false
 *
 * That is strictly MORE binding than a signature was: a signed V2 authority with
 * a stale HEAD was already BLOCKED, and an unsigned V2 authority with an exact
 * HEAD is authorized against exactly one repository state, once.
 *
 * NO SIGNATURE FALLBACK. There is no "signature missing → BLOCK" branch left for
 * schemaVersion 2. Signature material is not merely optional here, it is
 * REJECTED (SIGNATURE_MATERIAL_NOT_PERMITTED), so a forged document cannot claim
 * authority by carrying a key id and a signature this mode never checks.
 *
 * HISTORICAL SEMANTICS ARE UNCHANGED. V1 maintenance authorities keep their
 * original validation (see gee-mission-authority-source.mjs), and the separately
 * owner-signed historical artifacts — release authorizations, gate
 * authorizations — keep verifying against their retained public key material via
 * release-authority.mjs. Nothing historical is weakened, rewritten, or re-signed.
 *
 * Fail-closed everywhere: absence, malformation, unknown fields and drift all
 * produce BLOCKED. Nothing is ever upgraded by absence.
 */

import { sha256Hex } from './release-authority.mjs';
// The closed-status vocabulary, taken from the leaf module that now owns it. It
// used to be imported from sealed-state-evidence, and that edge is precisely what
// prevented sealed-state-evidence from consuming the canonical ledger validator
// (which imports THIS file) without an import cycle. Same three strings, one
// layer down — see closed-revision-status.mjs for the full argument.
import { CLOSED_REVISION_STATUSES } from './closed-revision-status.mjs';

export const POST_FREEZE_MAINTENANCE_V2_SCHEMA_VERSION = 2;
export const POST_FREEZE_MAINTENANCE_AUTHORITY_CLASS = 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY';
export const POST_FREEZE_MAINTENANCE_AUTHORITY_MODE = 'LOCAL_EXPLICIT_AUTHORITY';
export const POST_FREEZE_MAINTENANCE_WORK_UNIT_CLASS = 'MAINTENANCE';
export const LEGACY_SIGNED_AUTHORITY_MODE = 'LEGACY_SIGNED_AUTHORITY';
export const AUTHORITY_MODES = Object.freeze([
  LEGACY_SIGNED_AUTHORITY_MODE,
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE
]);
export const POST_FREEZE_MAINTENANCE_DOCUMENT = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY';
export const POST_FREEZE_MAINTENANCE_MANIFEST_KIND = 'POST_FREEZE_MAINTENANCE_AUTHORIZED_PATH_MANIFEST';
export const POST_FREEZE_MAINTENANCE_CONSUMPTION_KIND = 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION';
export const POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_NORMAL = 'NORMAL_MAINTENANCE';
export const POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_FINAL_CLOSURE = 'GATE_FINAL_CLOSURE';
export const POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION = 'GATE_EXTERNAL_CONFIRMATION';
export const FINAL_CLOSURE_OPERATION_CLASSES = Object.freeze(['AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION']);
export const EXTERNAL_CONFIRMATION_OPERATION_CLASSES = Object.freeze(['EXTERNAL_CONFIRMATION']);
export const PHASE_AUTHORIZE_PROGRAM_APPLY = 'AUTHORIZE_PROGRAM_APPLY';
export const PHASE_VERIFY_PROGRAM_CONSUMPTION = 'VERIFY_PROGRAM_CONSUMPTION';
export const SEALED_EVIDENCE_IMMUTABILITY_FINDING = 'POST_FREEZE_MAINTENANCE_SEALED_MEMBER_MUTATION';

export const REQUIRED_PROHIBITED_OPERATIONS = Object.freeze([
  'START', 'SECOND_START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION',
  'COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'ACTIVE_GATE_SWITCH', 'GEE_R8',
  'GIT_PUSH', 'HISTORY_REWRITE', 'THIRD_COMMIT', 'UNRELATED_WRITE'
]);

/**
 * Fields a LOCAL_EXPLICIT_AUTHORITY may never carry. Rejecting them — rather
 * than ignoring them — is what makes the absence of signature checking safe: a
 * document cannot present unverified cryptographic material as if it mattered.
 */
export const FORBIDDEN_SIGNATURE_FIELDS = Object.freeze([
  'ownerKeyId', 'signatureAlgorithm', 'signature', 'privateKeyPath',
  'externalSigner', 'ownerKeyHistory', 'recoveryRoot', 'keyRotation'
]);

/**
 * New authority documents must name one of the two mutually exclusive modes.
 * Historical signed documents predate this field and therefore resolve to the
 * legacy branch only when the caller allows the compatibility default.
 */
export function resolveAuthorityMode(value, { defaultLegacy = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.hasOwn(value, 'authorityMode')) return value.authorityMode;
  return defaultLegacy ? LEGACY_SIGNED_AUTHORITY_MODE : null;
}

export function validateAuthorityMode(value, {
  requireLegacySignature = false,
  defaultLegacy = true
} = {}) {
  const findings = [];
  const mode = resolveAuthorityMode(value, { defaultLegacy });
  if (!AUTHORITY_MODES.includes(mode)) {
    findings.push({ code: Object.hasOwn(value || {}, 'authorityMode') ? 'AUTHORITY_MODE_INVALID' : 'AUTHORITY_MODE_MISSING' });
    return { mode, valid: false, findings };
  }
  const signatureMaterial = FORBIDDEN_SIGNATURE_FIELDS.filter((field) => Object.hasOwn(value, field));
  if (mode === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE && signatureMaterial.length > 0) {
    findings.push({ code: 'SIGNATURE_MATERIAL_NOT_PERMITTED', detail: signatureMaterial });
  }
  if (mode === LEGACY_SIGNED_AUTHORITY_MODE && requireLegacySignature) {
    for (const field of ['ownerKeyId', 'signatureAlgorithm', 'signature']) {
      if (!Object.hasOwn(value, field) || typeof value[field] !== 'string' || !value[field]) {
        findings.push({ code: 'LEGACY_SIGNATURE_FIELD_MISSING', detail: field });
      }
    }
  }
  return { mode, valid: findings.length === 0, findings };
}

const AUTHORITY_FIELDS = Object.freeze([
  'document', 'schemaVersion', 'authorityId', 'authorityClass', 'authorityMode',
  'issuedBy', 'createdAt', 'expiresAt', 'targetSystem', 'programId', 'authorityPurpose',
  'resumePoint', 'maxUse', 'preState', 'authorizedPathManifestPath',
  'authorizedPathManifestSha256', 'authorizedOperationClasses', 'commitPolicy',
  'pushAuthorized', 'authorityPredecessor', 'authorityHeadBinding',
  'consumptionRecordPath', 'prohibitedOperations', 'externalReinspectionReportPath',
  'externalReinspectionReportSha256'
]);

const PRE_STATE_FIELDS = Object.freeze([
  'baseHead', 'ledgerEventCount', 'ledgerPrefixSha256', 'gateId', 'gateStatus',
  'stateRevision', 'contractRevision', 'activeGate', 'R8ExpectedAbsent'
]);

const COMMIT_POLICY_FIELDS = Object.freeze([
  'maxCommitCount', 'allowedGitOperations', 'commitMessage', 'thirdCommitAuthorized'
]);

const MANIFEST_FIELDS = Object.freeze(['documentKind', 'schemaVersion', 'manifestId', 'programId', 'paths']);
const MANIFEST_PATH_FIELDS = Object.freeze(['path', 'operation', 'phase', 'reason', 'artifactClass']);

/**
 * MANIFEST SCHEMA V2 — EXACT AUTHORIZED-PATH PRE-STATE BINDING.
 *
 * WHAT V1 COULD NOT SAY. A V1 authority binds the repository: base HEAD, ledger
 * count, ledger prefix digest, gate/state/contract/ACTIVE_GATE. It says nothing
 * about the bytes of the paths it authorizes. That gap is not cosmetic — it is
 * the difference between a governed replay and a ratification:
 *
 *   authority issued -> paths written        (a governed write)
 *   paths written    -> authority issued     (a ratification)
 *
 * Both produce byte-identical authority and consumption records under V1,
 * because nothing in V1 ever looked at what the paths held BEFORE the program
 * ran. An auditor could not tell the two apart, so "authorized" degraded to
 * "someone later wrote a document saying so".
 *
 * WHAT V2 ADDS. Exactly one field per manifest entry: `prestate`. It declares
 * the state each authorized path MUST be in before publication begins.
 *
 *   { "state": "ABSENT" }
 *   { "state": "PRESENT", "sha256": "<64 hex>", "byteLength": <int> }
 *
 * The evaluator refuses to authorize unless EVERY declared path matches its
 * declared pre-state on disk. One mismatch blocks the whole program; no path is
 * silently skipped, and an unobserved path is a blocking finding rather than a
 * pass.
 *
 * WHY A DECLARED HASH IS NOT ENOUGH BY ITSELF. If `prestate.sha256` could be any
 * value, a ratifier would simply declare the digest of the bytes already sitting
 * on disk and sail through. So a PRESENT pre-state must additionally be a
 * CANONICAL PREDECESSOR of that path: either the committed HEAD blob, or bytes
 * a prior valid consumption record already certified for it. Current working-tree
 * bytes that no canonical record ever certified are exactly what a ratification
 * would name, and they are refused.
 *
 * OPERATION COHERENCE. CREATE must declare ABSENT; MODIFY must declare PRESENT.
 * A CREATE whose path is already tracked in HEAD is refused as mislabelled.
 *
 * V1 IS UNTOUCHED. Manifests at schemaVersion 1 keep their exact original
 * validation, so every historical program stays valid and re-verifiable. V2 is
 * required only where a program elects to bind pre-state.
 */
export const MANIFEST_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const MANIFEST_FIELDS_V2 = Object.freeze([...MANIFEST_FIELDS, 'prestateSelfExclusion']);
export const MANIFEST_PATH_FIELDS_V2 = Object.freeze([...MANIFEST_PATH_FIELDS, 'prestate']);

/**
 * BOOTSTRAP SELF-EXCLUSION — the two documents that must already exist to be read.
 *
 * A program's authority document and its authorized-path manifest are themselves
 * governed artifacts, so they belong in the manifest — that is how the existing
 * primitive already works, and dropping them would leave two governed files
 * outside every cohort. But they are also the two files the evaluator must READ
 * in order to run at all, so at AUTHORIZE time they are unavoidably PRESENT
 * while their operation is CREATE. Under V1 that tension was invisible because
 * nothing checked pre-state; under V2 it would deadlock every program.
 *
 * The exception is therefore declared, never inferred, and it is deliberately
 * the narrowest one that unblocks the deadlock:
 *
 *   - only two roles exist, AUTHORITY_DOCUMENT and AUTHORIZED_PATH_MANIFEST
 *   - at most one entry per role
 *   - the manifest entry must BE `authority.authorizedPathManifestPath`
 *   - the authority entry must BE the authority document actually loaded
 *   - each excluded path must still appear in `paths`
 *   - each entry must carry a human reason
 *
 * What the exception does NOT do: it does not make authority files
 * self-authorizing. An excluded path skips the PRE-STATE gate only. It is still
 * bound by the manifest digest the authority pins, still inside the authorized
 * path set, and still verified byte-for-byte in the consumption cohort. The
 * consumption record itself needs no exemption — it genuinely does not exist at
 * authorize time, because an already-present one raises AUTHORITY_ALREADY_CONSUMED.
 *
 * Anything else named here is refused, so widening the hole requires editing this
 * table rather than writing a clever manifest.
 */
export const PRESTATE_SELF_EXCLUSION_ROLES = Object.freeze(['AUTHORITY_DOCUMENT', 'AUTHORIZED_PATH_MANIFEST']);
const PRESTATE_SELF_EXCLUSION_FIELDS = Object.freeze(['path', 'role', 'reason']);
export const PRESTATE_PRESENT = 'PRESENT';
export const PRESTATE_ABSENT = 'ABSENT';
export const PRESTATE_STATES = Object.freeze([PRESTATE_PRESENT, PRESTATE_ABSENT]);
const PRESTATE_PRESENT_FIELDS = Object.freeze(['state', 'sha256', 'byteLength']);
const PRESTATE_ABSENT_FIELDS = Object.freeze(['state']);

/** Shape-only validation of one `prestate` declaration. */
export function validatePathPrestateDeclaration(prestate, operation, findings, pathName) {
  if (!prestate || typeof prestate !== 'object' || Array.isArray(prestate)) {
    finding(findings, 'MANIFEST_PATH_PRESTATE_MISSING', pathName);
    return null;
  }
  if (!PRESTATE_STATES.includes(prestate.state)) {
    finding(findings, 'MANIFEST_PATH_PRESTATE_STATE_INVALID', pathName);
    return null;
  }
  const allowed = prestate.state === PRESTATE_PRESENT ? PRESTATE_PRESENT_FIELDS : PRESTATE_ABSENT_FIELDS;
  for (const key of Object.keys(prestate)) {
    if (!allowed.includes(key)) finding(findings, 'MANIFEST_PATH_PRESTATE_UNKNOWN_FIELD', `${pathName}:${key}`);
  }
  if (prestate.state === PRESTATE_PRESENT) {
    if (!SHA256_RE.test(prestate.sha256 || '')) finding(findings, 'MANIFEST_PATH_PRESTATE_SHA_INVALID', pathName);
    if (!Number.isInteger(prestate.byteLength) || prestate.byteLength < 0) finding(findings, 'MANIFEST_PATH_PRESTATE_BYTE_LENGTH_INVALID', pathName);
  }
  // CREATE means the path is not there yet; MODIFY means it is. A manifest that
  // disagrees with itself is refused rather than resolved in either direction.
  if (operation === 'CREATE' && prestate.state !== PRESTATE_ABSENT) finding(findings, 'MANIFEST_PATH_PRESTATE_OPERATION_INCOHERENT', pathName);
  if (operation === 'MODIFY' && prestate.state !== PRESTATE_PRESENT) finding(findings, 'MANIFEST_PATH_PRESTATE_OPERATION_INCOHERENT', pathName);
  return prestate;
}
const CONSUMPTION_V1_FIELDS = Object.freeze([
  'documentKind', 'schemaVersion', 'authorityId', 'programId', 'manifestSha256',
  'baseHead', 'consumedUse', 'transactionId', 'recordedAt', 'commitMessage'
]);
const CONSUMPTION_V2_FIELDS = Object.freeze([
  ...CONSUMPTION_V1_FIELDS, 'cohortSelfExclusion', 'cohortPathCount', 'cohort', 'publicationAdmission'
]);

/**
 * THE ADMISSION CITATION A RECEIPT CARRIES.
 *
 * A consumption record already says which authority and which manifest a
 * publication ran under. It could not say who ADMITTED it, so a reader of the
 * receipt had no way to reach the independent Owner decision that made the
 * publication lawful — the citation had to be rediscovered by searching, which is
 * exactly the kind of gap an after-the-fact ratification lives in.
 *
 * The citation is three fields and no more: the admission's id, its path and its
 * file digest. It is OPTIONAL on the record, and that is deliberate rather than
 * lax — every consumption record already in this repository predates admissions,
 * and rewriting historical receipts to add a field would be the self-ratification
 * move this whole primitive exists to prevent. What is NOT optional: a citation
 * that is present must be exactly shaped, and when the caller supplies the
 * admission it was published under, it must match that admission exactly.
 */
export const PUBLICATION_ADMISSION_CITATION_FIELDS = Object.freeze(['admissionId', 'admissionPath', 'admissionSha256']);
const CONSUMPTION_SELF_EXCLUSION_FIELDS = Object.freeze(['path', 'reason']);
const CONSUMPTION_COHORT_FIELDS = Object.freeze([
  'path', 'sha256', 'byteLength', 'operation', 'reason', 'artifactClass'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const TOKEN_RE = /^[A-Z][A-Z0-9_-]*$/;
const ISO_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function unknownFields(findings, value, allowed, code) {
  for (const key of Object.keys(value || {})) if (!allowed.includes(key)) finding(findings, code, key);
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return left.length === right.length
    && new Set(left).size === left.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function isExactMaintenancePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes(':')) return false;
  if (value.includes('*') || value.includes('?') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function validatePostFreezeMaintenanceAuthorityV2Shape(authority) {
  const findings = [];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    finding(findings, 'AUTHORITY_ABSENT');
    return { valid: false, findings };
  }
  unknownFields(findings, authority, AUTHORITY_FIELDS, 'AUTHORITY_UNKNOWN_FIELD');
  for (const field of FORBIDDEN_SIGNATURE_FIELDS) {
    if (Object.hasOwn(authority, field)) finding(findings, 'SIGNATURE_MATERIAL_NOT_PERMITTED', field);
  }
  if (authority.document !== POST_FREEZE_MAINTENANCE_DOCUMENT) finding(findings, 'DOCUMENT_INVALID');
  if (authority.schemaVersion !== POST_FREEZE_MAINTENANCE_V2_SCHEMA_VERSION) finding(findings, 'SCHEMA_VERSION_UNSUPPORTED');
  if (authority.authorityClass !== POST_FREEZE_MAINTENANCE_AUTHORITY_CLASS) finding(findings, 'AUTHORITY_CLASS_INVALID');
  if (authority.authorityMode !== POST_FREEZE_MAINTENANCE_AUTHORITY_MODE) finding(findings, 'AUTHORITY_MODE_INVALID', authority.authorityMode);
  if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'ISSUER_INVALID');
  if (!TOKEN_RE.test(authority.authorityId || '')) finding(findings, 'AUTHORITY_ID_INVALID');
  if (!TOKEN_RE.test(authority.programId || '')) finding(findings, 'PROGRAM_ID_INVALID');
  if (typeof authority.resumePoint !== 'string' || !authority.resumePoint) finding(findings, 'RESUME_POINT_INVALID');
  for (const field of ['createdAt', 'expiresAt']) if (!ISO_UTC_RE.test(authority[field] || '')) finding(findings, 'TIMESTAMP_INVALID', field);
  if (authority.targetSystem !== 'PROJECT_GOVERNANCE') finding(findings, 'TARGET_SYSTEM_INVALID');
  const authorityPurpose = authority.authorityPurpose ?? POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_NORMAL;
  if (![POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_NORMAL, POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_FINAL_CLOSURE, POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION].includes(authorityPurpose)) {
    finding(findings, 'AUTHORITY_PURPOSE_INVALID', authorityPurpose);
  }
  if (authority.maxUse !== 1) finding(findings, 'MAX_USE_INVALID');
  if (!authority.preState || typeof authority.preState !== 'object' || Array.isArray(authority.preState)) {
    finding(findings, 'PRE_STATE_INVALID');
  } else {
    unknownFields(findings, authority.preState, PRE_STATE_FIELDS, 'PRE_STATE_UNKNOWN_FIELD');
    for (const field of PRE_STATE_FIELDS) if (!Object.hasOwn(authority.preState, field)) finding(findings, 'PRE_STATE_FIELD_MISSING', field);
    if (!COMMIT_RE.test(authority.preState.baseHead || '')) finding(findings, 'BASE_HEAD_INVALID');
    if (!Number.isInteger(authority.preState.ledgerEventCount) || authority.preState.ledgerEventCount < 0) finding(findings, 'LEDGER_EVENT_COUNT_INVALID');
    if (!SHA256_RE.test(authority.preState.ledgerPrefixSha256 || '')) finding(findings, 'LEDGER_PREFIX_INVALID');
    for (const field of ['gateId', 'gateStatus', 'stateRevision', 'contractRevision', 'activeGate']) {
      if (authority.preState[field] !== null && (typeof authority.preState[field] !== 'string' || !authority.preState[field])) finding(findings, 'PRE_STATE_FIELD_INVALID', field);
    }
    if (typeof authority.preState.R8ExpectedAbsent !== 'boolean') finding(findings, 'R8_EXPECTATION_INVALID');
  }
  if (!isExactMaintenancePath(authority.authorizedPathManifestPath)) finding(findings, 'AUTHORIZED_MANIFEST_PATH_INVALID');
  if (!SHA256_RE.test(authority.authorizedPathManifestSha256 || '')) finding(findings, 'AUTHORIZED_MANIFEST_SHA_INVALID');
  if (authorityPurpose === POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION) {
    if (!isExactMaintenancePath(authority.externalReinspectionReportPath)) finding(findings, 'EXTERNAL_REINSPECTION_REPORT_PATH_REQUIRED');
    if (!SHA256_RE.test(authority.externalReinspectionReportSha256 || '')) finding(findings, 'EXTERNAL_REINSPECTION_REPORT_SHA_REQUIRED');
  } else if (Object.hasOwn(authority, 'externalReinspectionReportPath') || Object.hasOwn(authority, 'externalReinspectionReportSha256')) {
    finding(findings, 'EXTERNAL_REINSPECTION_REPORT_BINDING_NOT_PERMITTED');
  }
  if (!Array.isArray(authority.authorizedOperationClasses) || authority.authorizedOperationClasses.length === 0
      || new Set(authority.authorizedOperationClasses).size !== authority.authorizedOperationClasses.length
      || authority.authorizedOperationClasses.some((value) => !TOKEN_RE.test(value))) finding(findings, 'AUTHORIZED_OPERATION_CLASSES_INVALID');
  for (const operationClass of Array.isArray(authority.authorizedOperationClasses) ? authority.authorizedOperationClasses : []) {
    const closureException = authorityPurpose === POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_FINAL_CLOSURE
      ? FINAL_CLOSURE_OPERATION_CLASSES.includes(operationClass)
      : authorityPurpose === POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION
        && EXTERNAL_CONFIRMATION_OPERATION_CLASSES.includes(operationClass);
    if (REQUIRED_PROHIBITED_OPERATIONS.includes(operationClass) && !closureException) finding(findings, 'PROHIBITED_OPERATION_CLASS_CLAIMED', operationClass);
  }
  if (authorityPurpose === POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_FINAL_CLOSURE
      && !authority.authorizedOperationClasses?.includes('AGENT_CLOSURE')) finding(findings, 'FINAL_CLOSURE_AGENT_OPERATION_REQUIRED');
  if (authorityPurpose === POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION
      && (authority.authorizedOperationClasses?.length !== 1 || authority.authorizedOperationClasses[0] !== 'EXTERNAL_CONFIRMATION')) {
    finding(findings, 'EXTERNAL_CONFIRMATION_OPERATION_REQUIRED');
  }
  if (!authority.commitPolicy || typeof authority.commitPolicy !== 'object' || Array.isArray(authority.commitPolicy)) {
    finding(findings, 'COMMIT_POLICY_INVALID');
  } else {
    unknownFields(findings, authority.commitPolicy, COMMIT_POLICY_FIELDS, 'COMMIT_POLICY_UNKNOWN_FIELD');
    if (authority.commitPolicy.maxCommitCount !== 1) finding(findings, 'COMMIT_COUNT_INVALID');
    if (!sameStringSet(authority.commitPolicy.allowedGitOperations, ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'])) finding(findings, 'COMMIT_OPERATIONS_INVALID');
    if (typeof authority.commitPolicy.commitMessage !== 'string' || !authority.commitPolicy.commitMessage) finding(findings, 'COMMIT_MESSAGE_INVALID');
    if (authority.commitPolicy.thirdCommitAuthorized !== false) finding(findings, 'THIRD_COMMIT_NOT_FORBIDDEN');
  }
  if (authority.pushAuthorized !== false) finding(findings, 'PUSH_NOT_FORBIDDEN');
  if (authority.authorityPredecessor !== null) {
    if (!authority.authorityPredecessor || typeof authority.authorityPredecessor !== 'object' || Array.isArray(authority.authorityPredecessor)
        || !TOKEN_RE.test(authority.authorityPredecessor.authorityId || '')
        || !SHA256_RE.test(authority.authorityPredecessor.sha256 || '')
        || Object.keys(authority.authorityPredecessor).some((key) => !['authorityId', 'sha256'].includes(key))) finding(findings, 'AUTHORITY_PREDECESSOR_INVALID');
  }
  if (!authority.authorityHeadBinding || authority.authorityHeadBinding.mode !== 'BASE_HEAD'
      || authority.authorityHeadBinding.baseHead !== authority.preState?.baseHead
      || Object.keys(authority.authorityHeadBinding || {}).some((key) => !['mode', 'baseHead'].includes(key))) finding(findings, 'AUTHORITY_HEAD_BINDING_INVALID');
  if (!isExactMaintenancePath(authority.consumptionRecordPath)) finding(findings, 'CONSUMPTION_RECORD_PATH_INVALID');
  if (!sameStringSet(authority.prohibitedOperations, REQUIRED_PROHIBITED_OPERATIONS)) finding(findings, 'PROHIBITED_OPERATIONS_INVALID');
  return { valid: findings.length === 0, findings };
}

export function validateMaintenanceAuthorizedPathManifest(manifest, programId, authorityPurpose = POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_NORMAL) {
  const findings = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    finding(findings, 'MANIFEST_ABSENT');
    return { valid: false, findings, authorizedPaths: [], operationClasses: [] };
  }
  const bindsPrestate = manifest.schemaVersion === 2;
  unknownFields(findings, manifest, bindsPrestate ? MANIFEST_FIELDS_V2 : MANIFEST_FIELDS, 'MANIFEST_UNKNOWN_FIELD');
  if (manifest.documentKind !== POST_FREEZE_MAINTENANCE_MANIFEST_KIND) finding(findings, 'MANIFEST_KIND_INVALID');
  if (!MANIFEST_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) finding(findings, 'MANIFEST_SCHEMA_VERSION_INVALID');
  if (!TOKEN_RE.test(manifest.manifestId || '')) finding(findings, 'MANIFEST_ID_INVALID');
  if (manifest.programId !== programId) finding(findings, 'MANIFEST_PROGRAM_MISMATCH');
  if (!Array.isArray(manifest.paths) || manifest.paths.length === 0) finding(findings, 'MANIFEST_PATHS_INVALID');
  const paths = [];
  const operationClasses = [];
  const prestateByPath = new Map();
  for (const entry of Array.isArray(manifest.paths) ? manifest.paths : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { finding(findings, 'MANIFEST_ENTRY_INVALID'); continue; }
    unknownFields(findings, entry, bindsPrestate ? MANIFEST_PATH_FIELDS_V2 : MANIFEST_PATH_FIELDS, 'MANIFEST_ENTRY_UNKNOWN_FIELD');
    if (bindsPrestate) {
      const declared = validatePathPrestateDeclaration(entry.prestate, entry.operation, findings, entry.path);
      if (declared && isExactMaintenancePath(entry.path)) prestateByPath.set(entry.path, declared);
    }
    if (!isExactMaintenancePath(entry.path)) finding(findings, 'MANIFEST_PATH_INVALID', entry.path);
    else if (paths.includes(entry.path)) finding(findings, 'MANIFEST_PATH_DUPLICATE', entry.path);
    else paths.push(entry.path);
    if (!['CREATE', 'MODIFY'].includes(entry.operation)) finding(findings, 'MANIFEST_OPERATION_INVALID', entry.path);
    if (!TOKEN_RE.test(entry.phase || '')) finding(findings, 'MANIFEST_PHASE_INVALID', entry.path);
    if (typeof entry.reason !== 'string' || !entry.reason) finding(findings, 'MANIFEST_REASON_INVALID', entry.path);
    if (!TOKEN_RE.test(entry.artifactClass || '')) finding(findings, 'MANIFEST_ARTIFACT_CLASS_INVALID', entry.path);
    else operationClasses.push(entry.artifactClass);
    if ([POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_FINAL_CLOSURE, POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION].includes(authorityPurpose)) {
      if (!FINAL_CLOSURE_OPERATION_CLASSES.includes(entry.phase)) finding(findings, 'FINAL_CLOSURE_PHASE_INVALID', entry.path);
      if (entry.phase !== entry.artifactClass) finding(findings, 'FINAL_CLOSURE_PHASE_CLASS_MISMATCH', entry.path);
      if (authorityPurpose === POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION
          && (entry.phase !== 'EXTERNAL_CONFIRMATION' || entry.artifactClass !== 'EXTERNAL_CONFIRMATION')) {
        finding(findings, 'EXTERNAL_CONFIRMATION_PHASE_CLASS_REQUIRED', entry.path);
      }
    } else if (FINAL_CLOSURE_OPERATION_CLASSES.includes(entry.phase) || FINAL_CLOSURE_OPERATION_CLASSES.includes(entry.artifactClass)) {
      finding(findings, 'FINAL_CLOSURE_OPERATION_OUTSIDE_PURPOSE', entry.path);
    }
  }
  // Bootstrap self-exclusion: shape and bounds. Membership in `paths` and the
  // identity of each excluded document are settled here; agreement with the
  // authority actually loaded is settled in the evaluator, which is the only
  // place that knows it.
  const prestateSelfExcluded = new Map();
  if (bindsPrestate && Object.hasOwn(manifest, 'prestateSelfExclusion')) {
    if (!Array.isArray(manifest.prestateSelfExclusion)) {
      finding(findings, 'MANIFEST_PRESTATE_SELF_EXCLUSION_INVALID');
    } else {
      for (const entry of manifest.prestateSelfExclusion) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { finding(findings, 'MANIFEST_PRESTATE_SELF_EXCLUSION_ENTRY_INVALID'); continue; }
        unknownFields(findings, entry, PRESTATE_SELF_EXCLUSION_FIELDS, 'MANIFEST_PRESTATE_SELF_EXCLUSION_UNKNOWN_FIELD');
        if (!PRESTATE_SELF_EXCLUSION_ROLES.includes(entry.role)) { finding(findings, 'MANIFEST_PRESTATE_SELF_EXCLUSION_ROLE_INVALID', entry.path); continue; }
        if (!isExactMaintenancePath(entry.path)) { finding(findings, 'MANIFEST_PRESTATE_SELF_EXCLUSION_PATH_INVALID', entry.path); continue; }
        if (typeof entry.reason !== 'string' || !entry.reason) finding(findings, 'MANIFEST_PRESTATE_SELF_EXCLUSION_REASON_INVALID', entry.path);
        if (!paths.includes(entry.path)) finding(findings, 'MANIFEST_PRESTATE_SELF_EXCLUSION_PATH_NOT_AUTHORIZED', entry.path);
        if ([...prestateSelfExcluded.values()].some((existing) => existing.role === entry.role)) {
          finding(findings, 'MANIFEST_PRESTATE_SELF_EXCLUSION_ROLE_DUPLICATE', entry.role);
          continue;
        }
        prestateSelfExcluded.set(entry.path, entry);
      }
    }
  }
  return {
    valid: findings.length === 0,
    findings,
    authorizedPaths: paths,
    operationClasses: [...new Set(operationClasses)],
    bindsPrestate,
    prestateByPath,
    prestateSelfExcluded
  };
}

/**
 * The pre-state gate. Runs only at AUTHORIZE time and only for a V2 manifest,
 * and is deliberately exhaustive: every declared path must be observed, every
 * observation must match, and any observed path nobody declared is a finding.
 *
 * `observed.pathPrestates` is a path-keyed map of what the repository actually
 * holds right now:
 *
 *   { state, sha256, byteLength, canonicalPredecessors: [ ...sha256 ] }
 *
 * `canonicalPredecessors` is what makes this more than a self-consistent claim.
 * It is assembled by the observer from sources a program cannot author: the
 * committed HEAD blob for the path, plus every digest a prior VALID consumption
 * record already certified for it. A PRESENT pre-state must name one of those.
 * Declaring the digest of bytes that are merely sitting in the working tree —
 * which is exactly what an after-the-fact ratification would declare — matches
 * no canonical predecessor and is refused.
 */
export function evaluatePathPrestateBinding({ manifestResult, authority, observed, findings }) {
  if (!manifestResult.bindsPrestate) return;
  const observedPrestates = observed?.pathPrestates;
  if (!observedPrestates || typeof observedPrestates !== 'object' || Array.isArray(observedPrestates)) {
    finding(findings, 'PATH_PRESTATE_OBSERVATION_MISSING');
    return;
  }
  // Each self-exclusion must name the document it claims to be. The manifest
  // role is checked against the digest-pinned manifest path; the authority role
  // against the document the caller actually loaded. An exclusion that names
  // some other file is refused rather than honoured.
  const excluded = new Set();
  for (const [pathName, entry] of manifestResult.prestateSelfExcluded ?? new Map()) {
    if (entry.role === 'AUTHORIZED_PATH_MANIFEST') {
      if (pathName !== authority?.authorizedPathManifestPath) { finding(findings, 'PRESTATE_SELF_EXCLUSION_MANIFEST_PATH_MISMATCH', pathName); continue; }
    } else if (entry.role === 'AUTHORITY_DOCUMENT') {
      if (typeof observed.authorityDocumentPath !== 'string' || !observed.authorityDocumentPath) { finding(findings, 'PRESTATE_SELF_EXCLUSION_AUTHORITY_PATH_UNOBSERVED', pathName); continue; }
      if (pathName !== observed.authorityDocumentPath) { finding(findings, 'PRESTATE_SELF_EXCLUSION_AUTHORITY_PATH_MISMATCH', pathName); continue; }
    }
    excluded.add(pathName);
  }
  const declaredPaths = new Set(manifestResult.prestateByPath.keys());
  for (const [pathName, declared] of manifestResult.prestateByPath) {
    if (excluded.has(pathName)) continue;
    const actual = observedPrestates[pathName];
    if (!actual || typeof actual !== 'object') {
      finding(findings, 'PATH_PRESTATE_ENTRY_NOT_OBSERVED', pathName);
      continue;
    }
    if (actual.state !== declared.state) {
      finding(findings, 'PATH_PRESTATE_STATE_MISMATCH', `${pathName}:expected=${declared.state}:actual=${actual.state}`);
      continue;
    }
    if (declared.state !== PRESTATE_PRESENT) continue;
    if (actual.sha256 !== declared.sha256) {
      finding(findings, 'PATH_PRESTATE_SHA_MISMATCH', pathName);
      continue;
    }
    if (actual.byteLength !== declared.byteLength) {
      finding(findings, 'PATH_PRESTATE_BYTE_LENGTH_MISMATCH', pathName);
      continue;
    }
    const predecessors = Array.isArray(actual.canonicalPredecessors) ? actual.canonicalPredecessors : null;
    if (!predecessors) {
      finding(findings, 'PATH_PRESTATE_CANONICAL_PREDECESSORS_UNOBSERVED', pathName);
      continue;
    }
    if (!predecessors.includes(declared.sha256)) {
      finding(findings, 'PATH_PRESTATE_NOT_A_CANONICAL_PREDECESSOR', pathName);
    }
  }
  for (const pathName of Object.keys(observedPrestates)) {
    if (!declaredPaths.has(pathName)) finding(findings, 'PATH_PRESTATE_OBSERVED_UNDECLARED_PATH', pathName);
  }
}

/**
 * CONTROL 15 — A PROGRAM MAY NOT CREATE THE DOCUMENTS THAT AUTHORIZE IT.
 *
 * THE DEMONSTRATED DEFECT, EXACTLY. The GATE20 Repair-B manifest declares the
 * Owner documents its own admission chain depends on as
 *
 *     prestate: { state: "ABSENT" }
 *
 * An ABSENT declaration paired with operation CREATE is a machine-readable claim
 * that the path does not exist yet and that this publication brings it into being.
 * Applied to a governing document that is exactly a bootstrap: the publication
 * writes its own permission slip, and every downstream check then verifies the
 * program against paperwork the program itself produced.
 *
 * THE RULE, AND WHY IT IS DELIBERATELY NARROW. For the exact governing paths of
 * THIS admission chain — the admitted authority, the admitted manifest, the
 * publication admission record and the Owner authorization registry — a manifest
 * may not declare ABSENT, and where it declares PRESENT the digest and length must
 * be the ones the admission pins. Anything else in the cohort is untouched.
 *
 * Generalizing the ABSENT prohibition across all governance paths would be a new
 * architecture decision, not this repair: CREATE-from-ABSENT is the normal, lawful
 * shape for every ordinary artifact a maintenance program publishes.
 *
 * THE ONE EXEMPTION, AND WHY IT IS NOT A HOLE. The admitted authority and the
 * admitted manifest may be covered by the existing BOOTSTRAP SELF-EXCLUSION, which
 * already proves exactly what this rule wants: `evaluatePathPrestateBinding`
 * requires the excluded AUTHORITY_DOCUMENT entry to BE the document the evaluator
 * actually loaded from disk, and the AUTHORIZED_PATH_MANIFEST entry to BE the path
 * whose digest the authority pins and the evaluator re-checks. Both are therefore
 * demonstrably PRESENT with exact digests before publication, by a canonical
 * mechanism that predates this rule. The manifest additionally cannot state its own
 * final digest — a self-referential seal is not computable — so requiring it to do
 * so would deadlock rather than protect. The exemption is limited to those two
 * roles, each of which may appear at most once; the admission record and the Owner
 * registry have no such mechanism and get no such exemption.
 *
 * Pure and shape-only: this decides what the MANIFEST may claim. Whether the
 * governing files are genuinely present with the pinned bytes is decided by the
 * resolver, against the repository.
 */
export function validateGoverningPathPrestateBinding({ manifestResult, governingPaths, findings }) {
  if (!Array.isArray(governingPaths) || governingPaths.length === 0) {
    finding(findings, 'GOVERNING_PATH_SET_MISSING');
    return;
  }
  const declared = manifestResult?.prestateByPath instanceof Map ? manifestResult.prestateByPath : new Map();
  const excluded = manifestResult?.prestateSelfExcluded instanceof Map ? manifestResult.prestateSelfExcluded : new Map();
  const bootstrapExemptRoles = new Map([
    ['AUTHORITY_DOCUMENT', 'ADMITTED_AUTHORITY'],
    ['AUTHORIZED_PATH_MANIFEST', 'ADMITTED_MANIFEST']
  ]);
  for (const governing of governingPaths) {
    if (!governing || typeof governing !== 'object') { finding(findings, 'GOVERNING_PATH_ENTRY_INVALID'); continue; }
    const entry = declared.get(governing.path);
    if (!entry) continue; // Not a path this program writes at all: the safest shape.

    const exclusion = excluded.get(governing.path) ?? null;
    const exemptRole = exclusion ? bootstrapExemptRoles.get(exclusion.role) ?? null : null;
    if (exemptRole !== null && exemptRole === governing.role) continue;

    if (entry.state !== PRESTATE_PRESENT) {
      finding(findings, 'GOVERNING_PATH_PRESTATE_ABSENT_NOT_PERMITTED', `${governing.role}:${governing.path}`);
      continue;
    }
    if (typeof governing.sha256 === 'string' && entry.sha256 !== governing.sha256) {
      finding(findings, 'GOVERNING_PATH_PRESTATE_DIGEST_MISMATCH', `${governing.role}:${governing.path}`);
      continue;
    }
    if (Number.isInteger(governing.byteLength) && entry.byteLength !== governing.byteLength) {
      finding(findings, 'GOVERNING_PATH_PRESTATE_BYTE_LENGTH_MISMATCH', `${governing.role}:${governing.path}`);
    }
  }
}

/**
 * The admission citation on a consumption record.
 *
 * Absent is permitted, because every historical receipt in this repository predates
 * admissions and rewriting them would be self-ratification. Present is validated
 * strictly, and when the caller knows which admission the publication ran under,
 * the citation must be that admission exactly — a receipt may not cite a decision
 * other than the one it was published under.
 */
export function validatePublicationAdmissionCitation(record, publicationAdmission, findings) {
  const citation = record?.publicationAdmission ?? null;
  if (citation === null || citation === undefined) {
    if (publicationAdmission) finding(findings, 'CONSUMPTION_ADMISSION_CITATION_ABSENT', publicationAdmission.admissionId ?? null);
    return;
  }
  if (typeof citation !== 'object' || Array.isArray(citation)) { finding(findings, 'CONSUMPTION_ADMISSION_CITATION_INVALID'); return; }
  unknownFields(findings, citation, PUBLICATION_ADMISSION_CITATION_FIELDS, 'CONSUMPTION_ADMISSION_CITATION_UNKNOWN_FIELD');
  if (!TOKEN_RE.test(citation.admissionId || '')) finding(findings, 'CONSUMPTION_ADMISSION_CITATION_ID_INVALID');
  if (!isExactMaintenancePath(citation.admissionPath)) finding(findings, 'CONSUMPTION_ADMISSION_CITATION_PATH_INVALID');
  if (!SHA256_RE.test(citation.admissionSha256 || '')) finding(findings, 'CONSUMPTION_ADMISSION_CITATION_SHA_INVALID');
  if (!publicationAdmission) return;
  if (citation.admissionId !== publicationAdmission.admissionId) finding(findings, 'CONSUMPTION_ADMISSION_CITATION_ID_MISMATCH', citation.admissionId ?? null);
  if (citation.admissionPath !== publicationAdmission.admissionPath) finding(findings, 'CONSUMPTION_ADMISSION_CITATION_PATH_MISMATCH', citation.admissionPath ?? null);
  if (citation.admissionSha256 !== publicationAdmission.admissionSha256) finding(findings, 'CONSUMPTION_ADMISSION_CITATION_SHA_MISMATCH', citation.admissionPath ?? null);
}

/**
 * CONSUMPTION COHERENCE — the half of consumption validation that can never
 * legitimately drift.
 *
 * A consumption record is checked against two different things, and only one of
 * them is stable over time:
 *
 *   COHERENCE  the record against the AUTHORITY and the MANIFEST it cites. Both
 *              are digest-pinned for the life of the program, so this comparison
 *              has exactly one correct answer forever. A mismatch here is not
 *              staleness, it is a record that never described its own program.
 *
 *   OCCUPANCY  the record against the bytes currently on disk. This one is
 *              EXPECTED to drift: a later authorized program may lawfully rewrite
 *              a path an earlier program certified, which is why completed
 *              historical programs legitimately report SHA_MISMATCH.
 *
 * They are separated because callers need different halves. The full evaluator
 * wants both. The canonical cohort derivation wants COHERENCE ONLY — it must
 * refuse a program whose record contradicts its own manifest, while still
 * admitting completed programs whose outputs were later superseded. Before this
 * split the cohort re-checked five header fields by hand and so admitted a
 * program the canonical consumption validator rejected, which is precisely how
 * FINAL_GATE_INTEGRITY came to PASS over a BLOCKED consumption.
 *
 * Exported so there is ONE implementation of "does this record match its
 * manifest". A second one is what would let the two verdicts diverge again.
 */
export function validateConsumptionRecordCoherence(record, authority, manifest, findings, { publicationAdmission = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) { finding(findings, 'CONSUMPTION_RECORD_MISSING'); return; }
  validatePublicationAdmissionCitation(record, publicationAdmission, findings);
  const consumptionFields = record.schemaVersion === 2 ? CONSUMPTION_V2_FIELDS : CONSUMPTION_V1_FIELDS;
  unknownFields(findings, record, consumptionFields, 'CONSUMPTION_UNKNOWN_FIELD');
  if (record.documentKind !== POST_FREEZE_MAINTENANCE_CONSUMPTION_KIND || ![1, 2].includes(record.schemaVersion)) finding(findings, 'CONSUMPTION_RECORD_INVALID');
  if (record.authorityId !== authority.authorityId || record.programId !== authority.programId) finding(findings, 'CONSUMPTION_AUTHORITY_MISMATCH');
  if (record.manifestSha256 !== authority.authorizedPathManifestSha256) finding(findings, 'CONSUMPTION_MANIFEST_MISMATCH');
  if (record.baseHead !== authority.preState.baseHead) finding(findings, 'CONSUMPTION_BASE_HEAD_MISMATCH');
  if (record.consumedUse !== 1) finding(findings, 'CONSUMPTION_USE_INVALID');
  if (typeof record.transactionId !== 'string' || !record.transactionId) finding(findings, 'CONSUMPTION_TRANSACTION_INVALID');
  if (!ISO_UTC_RE.test(record.recordedAt || '')) finding(findings, 'CONSUMPTION_RECORDED_AT_INVALID');
  if (record.commitMessage !== authority.commitPolicy.commitMessage) finding(findings, 'CONSUMPTION_COMMIT_MESSAGE_MISMATCH');
  if (record.schemaVersion !== 2) return;

  const manifestEntries = Array.isArray(manifest?.paths) ? manifest.paths : [];
  const manifestByPath = new Map(manifestEntries.map((entry) => [entry.path, entry]));
  const selfPath = authority.consumptionRecordPath;
  if (!record.cohortSelfExclusion || typeof record.cohortSelfExclusion !== 'object' || Array.isArray(record.cohortSelfExclusion)) {
    finding(findings, 'CONSUMPTION_SELF_EXCLUSION_INVALID');
  } else {
    unknownFields(findings, record.cohortSelfExclusion, CONSUMPTION_SELF_EXCLUSION_FIELDS, 'CONSUMPTION_SELF_EXCLUSION_UNKNOWN_FIELD');
    if (record.cohortSelfExclusion.path !== selfPath || typeof record.cohortSelfExclusion.reason !== 'string' || !record.cohortSelfExclusion.reason) {
      finding(findings, 'CONSUMPTION_SELF_EXCLUSION_INVALID');
    }
  }
  if (!manifestByPath.has(selfPath)) finding(findings, 'CONSUMPTION_SELF_PATH_NOT_AUTHORIZED', selfPath);
  if (record.cohortPathCount !== manifestEntries.length) finding(findings, 'CONSUMPTION_COHORT_COUNT_MISMATCH');
  if (!Array.isArray(record.cohort)) {
    finding(findings, 'CONSUMPTION_COHORT_INVALID');
    return;
  }

  const expectedPaths = manifestEntries.map((entry) => entry.path).filter((entryPath) => entryPath !== selfPath);
  const receiptPaths = [];
  for (const entry of record.cohort) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { finding(findings, 'CONSUMPTION_COHORT_ENTRY_INVALID'); continue; }
    unknownFields(findings, entry, CONSUMPTION_COHORT_FIELDS, 'CONSUMPTION_COHORT_ENTRY_UNKNOWN_FIELD');
    if (!isExactMaintenancePath(entry.path)) finding(findings, 'CONSUMPTION_COHORT_PATH_INVALID', entry.path);
    else if (receiptPaths.includes(entry.path)) finding(findings, 'CONSUMPTION_COHORT_PATH_DUPLICATE', entry.path);
    else receiptPaths.push(entry.path);
    const authorized = manifestByPath.get(entry.path);
    if (!authorized || entry.path === selfPath) {
      finding(findings, 'CONSUMPTION_COHORT_UNEXPECTED_PATH', entry.path);
      continue;
    }
    if (!SHA256_RE.test(entry.sha256 || '')) finding(findings, 'CONSUMPTION_COHORT_SHA_INVALID', entry.path);
    if (!Number.isInteger(entry.byteLength) || entry.byteLength < 0) finding(findings, 'CONSUMPTION_COHORT_BYTE_LENGTH_INVALID', entry.path);
    for (const field of ['operation', 'reason', 'artifactClass']) {
      if (entry[field] !== authorized[field]) finding(findings, 'CONSUMPTION_COHORT_METADATA_MISMATCH', `${entry.path}:${field}`);
    }
  }
  for (const expectedPath of expectedPaths) {
    if (!receiptPaths.includes(expectedPath)) finding(findings, 'CONSUMPTION_COHORT_PATH_MISSING', expectedPath);
  }
  if (record.cohort.length !== expectedPaths.length) finding(findings, 'CONSUMPTION_COHORT_ENTRY_COUNT_MISMATCH');
}

/**
 * Coherence, then occupancy. The evaluator needs both halves; splitting them
 * changes who can ask for which, not what either one decides.
 */
function validateConsumptionRecord(record, authority, manifest, observed, findings) {
  validateConsumptionRecordCoherence(record, authority, manifest, findings);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  if (record.schemaVersion !== 2 || !Array.isArray(record.cohort)) return;

  const manifestEntries = Array.isArray(manifest?.paths) ? manifest.paths : [];
  const selfPath = authority.consumptionRecordPath;
  const expectedPaths = manifestEntries.map((entry) => entry.path).filter((entryPath) => entryPath !== selfPath);

  const observedCohort = Array.isArray(observed.consumptionCohort) ? observed.consumptionCohort : [];
  const observedByPath = new Map();
  for (const entry of observedCohort) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') { finding(findings, 'CONSUMPTION_OBSERVED_COHORT_INVALID'); continue; }
    if (observedByPath.has(entry.path)) finding(findings, 'CONSUMPTION_OBSERVED_COHORT_DUPLICATE', entry.path);
    observedByPath.set(entry.path, entry);
  }
  for (const expectedPath of expectedPaths) {
    const receiptEntry = record.cohort.find((entry) => entry?.path === expectedPath);
    const observedEntry = observedByPath.get(expectedPath);
    if (!observedEntry) {
      finding(findings, 'CONSUMPTION_OBSERVED_PATH_MISSING', expectedPath);
      continue;
    }
    if (receiptEntry?.sha256 !== observedEntry.sha256) finding(findings, 'CONSUMPTION_COHORT_SHA_MISMATCH', expectedPath);
    if (receiptEntry?.byteLength !== observedEntry.byteLength) finding(findings, 'CONSUMPTION_COHORT_BYTE_LENGTH_MISMATCH', expectedPath);
  }
  for (const observedPath of observedByPath.keys()) {
    if (!expectedPaths.includes(observedPath)) finding(findings, 'CONSUMPTION_OBSERVED_UNEXPECTED_PATH', observedPath);
  }
}

/**
 * The single V2 decision function. No key material is accepted and none is
 * consulted: authority is the exact agreement between this document and the
 * live repository, nothing else.
 */
export function evaluatePostFreezeMaintenanceAuthorityV2({
  authority = null,
  manifest = null,
  observed = {},
  phase = PHASE_AUTHORIZE_PROGRAM_APPLY,
  now = new Date(),
  consumptionRecord = null
} = {}) {
  const shape = validatePostFreezeMaintenanceAuthorityV2Shape(authority);
  const manifestResult = validateMaintenanceAuthorizedPathManifest(
    manifest,
    authority?.programId,
    authority?.authorityPurpose ?? POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_NORMAL
  );
  const findings = [...shape.findings, ...manifestResult.findings];
  if (phase !== PHASE_AUTHORIZE_PROGRAM_APPLY && phase !== PHASE_VERIFY_PROGRAM_CONSUMPTION) finding(findings, 'PHASE_INVALID', phase);
  if (shape.valid) {
    const created = Date.parse(authority.createdAt), expires = Date.parse(authority.expiresAt);
    if (Number.isNaN(created) || Number.isNaN(expires) || created > expires) finding(findings, 'AUTHORITY_TIME_ORDER_INVALID');
    else if (now.getTime() > expires) finding(findings, 'AUTHORITY_EXPIRED');
  }
  if (observed.manifestSha256 !== authority?.authorizedPathManifestSha256) finding(findings, 'AUTHORIZED_MANIFEST_SHA_MISMATCH', observed.manifestSha256 ?? 'ABSENT');
  if (authority?.authorityPurpose === POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_EXTERNAL_CONFIRMATION) {
    if (!manifestResult.authorizedPaths.includes(authority.externalReinspectionReportPath)) finding(findings, 'EXTERNAL_REINSPECTION_REPORT_NOT_IN_MANIFEST');
    if (observed.externalReinspectionReportPath !== authority.externalReinspectionReportPath) finding(findings, 'EXTERNAL_REINSPECTION_REPORT_PATH_MISMATCH', observed.externalReinspectionReportPath ?? 'ABSENT');
    if (observed.externalReinspectionReportSha256 !== authority.externalReinspectionReportSha256) finding(findings, 'EXTERNAL_REINSPECTION_REPORT_SHA_MISMATCH', observed.externalReinspectionReportSha256 ?? 'ABSENT');
  }
  // PRE-STATE DRIFT IS ONLY A QUESTION AT AUTHORIZE TIME.
  //
  // The pre-state binding is what makes this authority single-use: it names the
  // exact repository state it may act on, so once the program has applied, HEAD
  // has moved, the ledger has grown and the bound state no longer exists. That
  // is the authority being SPENT, not the authority being invalid.
  //
  // Re-asserting the pre-state during consumption verification would therefore
  // be incoherent — it would demand the program had never run. Consumption is
  // verified against the consumption record instead, which binds the authority,
  // the program, the manifest digest and the baseHead it was consumed at.
  if (phase === PHASE_AUTHORIZE_PROGRAM_APPLY) {
    // The authorized-path pre-state gate. Placed with the other AUTHORIZE-time
    // bindings for the same reason they are: it describes the state the program
    // may act ON, so re-asserting it after publication would demand the program
    // had never run.
    evaluatePathPrestateBinding({ manifestResult, authority, observed, findings });
    if (observed.baseHead !== authority?.preState?.baseHead) finding(findings, 'BASE_HEAD_MISMATCH', observed.baseHead ?? 'ABSENT');
    if (observed.ledgerEventCount !== authority?.preState?.ledgerEventCount) finding(findings, 'LEDGER_EVENT_COUNT_MISMATCH');
    if (observed.ledgerPrefixSha256 !== authority?.preState?.ledgerPrefixSha256) finding(findings, 'LEDGER_PREFIX_MISMATCH');
    for (const field of ['gateId', 'gateStatus', 'stateRevision', 'contractRevision', 'activeGate']) {
      if (authority?.preState?.[field] !== null && observed[field] !== authority?.preState?.[field]) finding(findings, 'PRE_STATE_MISMATCH', field);
    }
  }
  // R8 must be absent in BOTH phases: it is a prohibition, not a pre-state.
  if (authority?.preState?.R8ExpectedAbsent === true && observed.R8Absent !== true) finding(findings, 'R8_PRESENT_OR_UNKNOWN');
  if (authority?.authorityPredecessor !== null && observed.authorityPredecessorSha256 !== authority?.authorityPredecessor?.sha256) finding(findings, 'AUTHORITY_PREDECESSOR_MISMATCH');
  const requestedPaths = Array.isArray(observed.requestedPaths) ? observed.requestedPaths : manifestResult.authorizedPaths;
  for (const path of requestedPaths) if (!manifestResult.authorizedPaths.includes(path)) finding(findings, 'PATH_NOT_AUTHORIZED', path);
  const requestedClasses = Array.isArray(observed.requestedOperationClasses) ? observed.requestedOperationClasses : manifestResult.operationClasses;
  for (const operationClass of requestedClasses) if (!authority?.authorizedOperationClasses?.includes(operationClass)) finding(findings, 'OPERATION_CLASS_NOT_AUTHORIZED', operationClass);
  for (const operationClass of manifestResult.operationClasses) if (!authority?.authorizedOperationClasses?.includes(operationClass)) finding(findings, 'MANIFEST_OPERATION_CLASS_NOT_AUTHORIZED', operationClass);
  const currentSealedMembers = observed.closedStateSealMembers;
  const currentSealFindings = observed.closedStateSealFindings;
  const preStateSealedMembers = observed.preStateClosedStateSealMembers;
  const preStateSealFindings = observed.preStateClosedStateSealFindings;
  if (!Array.isArray(currentSealedMembers) || !Array.isArray(currentSealFindings)) {
    finding(findings, 'SEALED_EVIDENCE_IMMUTABILITY_OBSERVATION_MISSING', CLOSED_REVISION_STATUSES.join('|'));
  } else {
    for (const inventoryFinding of currentSealFindings) finding(findings, 'SEALED_EVIDENCE_IMMUTABILITY_INVENTORY_INVALID', inventoryFinding);
    if (!Array.isArray(preStateSealedMembers) || !Array.isArray(preStateSealFindings)) {
      finding(findings, 'PRESTATE_SEALED_EVIDENCE_OBSERVATION_MISSING', CLOSED_REVISION_STATUSES.join('|'));
    } else {
      for (const inventoryFinding of preStateSealFindings) finding(findings, 'PRESTATE_SEALED_EVIDENCE_INVENTORY_INVALID', inventoryFinding);
      // Only members present in the authority's immutable pre-state are
      // protected from mutation here. A member that appears solely in the
      // successor inventory is a transaction product and is verified by the
      // exact consumption cohort instead of being misclassified as pre-state.
      const preStateSealedPaths = new Set(preStateSealedMembers
        .map((member) => member?.repoRelativePath)
        .filter((value) => typeof value === 'string'));
      for (const requestedPath of new Set([...manifestResult.authorizedPaths, ...requestedPaths])) {
        if (preStateSealedPaths.has(requestedPath)) finding(findings, SEALED_EVIDENCE_IMMUTABILITY_FINDING, requestedPath);
      }
    }
  }
  if (phase === PHASE_AUTHORIZE_PROGRAM_APPLY && consumptionRecord) finding(findings, 'AUTHORITY_ALREADY_CONSUMED');
  if (phase === PHASE_VERIFY_PROGRAM_CONSUMPTION) validateConsumptionRecord(consumptionRecord, authority, manifest, observed, findings);
  const decision = findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED';
  return {
    decision,
    authorityMode: POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
    programAuthorized: decision === 'AUTHORIZED' && phase === PHASE_AUTHORIZE_PROGRAM_APPLY,
    consumed: decision === 'AUTHORIZED' && phase === PHASE_VERIFY_PROGRAM_CONSUMPTION,
    authorizedPaths: decision === 'AUTHORIZED' ? [...manifestResult.authorizedPaths] : [],
    authorizedOperationClasses: decision === 'AUTHORIZED' ? [...authority.authorizedOperationClasses] : [],
    findings
  };
}

export { sha256Hex };
