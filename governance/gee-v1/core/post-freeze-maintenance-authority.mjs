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

export const POST_FREEZE_MAINTENANCE_V2_SCHEMA_VERSION = 2;
export const POST_FREEZE_MAINTENANCE_AUTHORITY_CLASS = 'PROJECT_OWNER_POST_FREEZE_MAINTENANCE_AUTHORITY';
export const POST_FREEZE_MAINTENANCE_AUTHORITY_MODE = 'LOCAL_EXPLICIT_AUTHORITY';
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
const CONSUMPTION_V1_FIELDS = Object.freeze([
  'documentKind', 'schemaVersion', 'authorityId', 'programId', 'manifestSha256',
  'baseHead', 'consumedUse', 'transactionId', 'recordedAt', 'commitMessage'
]);
const CONSUMPTION_V2_FIELDS = Object.freeze([
  ...CONSUMPTION_V1_FIELDS, 'cohortSelfExclusion', 'cohortPathCount', 'cohort'
]);
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
  unknownFields(findings, manifest, MANIFEST_FIELDS, 'MANIFEST_UNKNOWN_FIELD');
  if (manifest.documentKind !== POST_FREEZE_MAINTENANCE_MANIFEST_KIND) finding(findings, 'MANIFEST_KIND_INVALID');
  if (manifest.schemaVersion !== 1) finding(findings, 'MANIFEST_SCHEMA_VERSION_INVALID');
  if (!TOKEN_RE.test(manifest.manifestId || '')) finding(findings, 'MANIFEST_ID_INVALID');
  if (manifest.programId !== programId) finding(findings, 'MANIFEST_PROGRAM_MISMATCH');
  if (!Array.isArray(manifest.paths) || manifest.paths.length === 0) finding(findings, 'MANIFEST_PATHS_INVALID');
  const paths = [];
  const operationClasses = [];
  for (const entry of Array.isArray(manifest.paths) ? manifest.paths : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { finding(findings, 'MANIFEST_ENTRY_INVALID'); continue; }
    unknownFields(findings, entry, MANIFEST_PATH_FIELDS, 'MANIFEST_ENTRY_UNKNOWN_FIELD');
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
  return { valid: findings.length === 0, findings, authorizedPaths: paths, operationClasses: [...new Set(operationClasses)] };
}

function validateConsumptionRecord(record, authority, manifest, observed, findings) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) { finding(findings, 'CONSUMPTION_RECORD_MISSING'); return; }
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
