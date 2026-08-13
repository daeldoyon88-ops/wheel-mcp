/**
 * GEE V1 core - GATE_START_AUTHORITY.
 *
 * This module is deliberately pure.  It validates the closed document model,
 * computes the two deterministic bindings and verifies the owner signature.
 * Repository I/O belongs to the adapter and the permanent ledger validator.
 */

import { canonicalize, sha256Hex, verifyOwnerSignature, authorizationSigningPayload } from './release-authority.mjs';

export const GATE_START_SCHEMA_VERSION = 1;
export const GATE_START_PURPOSE = 'START_PLUS_EXECUTION_AUTHORITY';
export const GATE_START_TRANSITION_TYPE = 'START';
export const GATE_START_FROM_STATUS = 'AUTHORIZED_NOT_STARTED';
export const GATE_START_TO_STATUS = 'IN_PROGRESS';
export const GATE_START_MAX_USE = 1;
export const GATE_START_SIGNATURE_ALGORITHM = 'ed25519';
export const GATE_START_BINDING_DIGEST_ALGORITHM = 'SHA256_CANONICAL_JSON_GATE_START_BINDING_V1';
export const GATE_START_READINESS_DIGEST_ALGORITHM = 'SHA256_CANONICAL_JSON_GATE_START_READINESS_V1';
export const GATE_START_RECORD_KIND = 'GATE_START_RECORD';
export const GATE_START_REQUEST_KIND = 'GATE_START_AUTHORITY_REQUEST';
export const GATE_START_AUTHORITY_KIND = 'PROJECT_OWNER_GATE_START_AUTHORITY';

export const GATE_START_PROHIBITED_OPERATIONS = Object.freeze([
  'AUTHORIZATION', 'SECOND_START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION',
  'COMPLETE_CONFIRMED', 'OTHER_GATE', 'GEE_REVISION_CREATION',
  'ARBITRARY_LEDGER_TRANSITION', 'LEDGER_REWRITE', 'ARBITRARY_GOVERNANCE_WRITE', 'GIT_PUSH'
]);

export const GATE_START_SHARED_FIELDS = Object.freeze([
  'schemaVersion', 'projectId', 'gateId', 'purpose', 'eventId', 'transitionType',
  'fromStatus', 'toStatus', 'recordedAt', 'baseCommit', 'preStartLedgerSha256',
  'previousEventSha256', 'contractSha256', 'currentContractSha256', 'preStateRevision',
  'preCurrentStateSha256', 'preStateSealSha256', 'readinessDigest', 'dependencyProof',
  'activeGatePreState', 'authorizedStartWritePaths', 'functionalExecutionScope',
  'ownerKeyId', 'expiresAtUtc', 'maxUse', 'prohibitedOperations', 'startAuthorized',
  'executionAuthorized'
]);

export const GATE_START_REQUEST_FIELDS = Object.freeze([
  'documentKind', 'requestId', ...GATE_START_SHARED_FIELDS,
  'bindingDigestAlgorithm', 'bindingDigest', 'requestDigest'
]);
export const GATE_START_RECORD_FIELDS = Object.freeze([
  'document', 'recordId', ...GATE_START_SHARED_FIELDS, 'recordDigest'
]);
export const GATE_START_AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'authorityId', 'issuedBy', 'issuedAtUtc',
  'requestDigest', 'recordDigest', 'bindingDigest', ...GATE_START_SHARED_FIELDS,
  'signatureAlgorithm', 'signature'
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const GATE_RE = /^GATE(?:1[4-9]|[23][0-9]|40)$/;

export function isModernGateStartId(gateId) {
  return typeof gateId === 'string' && GATE_RE.test(gateId);
}

export function gateStartRecordPath(gateId) {
  return `governance/authority/authorizations/${gateId}/GATE_START_RECORD.json`;
}

export function gateStartAuthorityPath(gateId) {
  return `governance/authority/authorizations/${gateId}/PROJECT_OWNER_GATE_START_AUTHORITY.json`;
}

export function gateStartWriteCohortPaths(gateId, revision = 'R0002') {
  return Object.freeze([
    gateStartRecordPath(gateId),
    gateStartAuthorityPath(gateId),
    'governance/state/GATE_STATUS_LEDGER.ndjson',
    `governance/gates/${gateId}/state/revisions/${revision}/CHECKPOINT.json`,
    `governance/gates/${gateId}/state/revisions/${revision}/OPEN_DEFECTS.json`,
    `governance/gates/${gateId}/state/revisions/${revision}/STATE_SEAL.json`,
    `governance/gates/${gateId}/state/CURRENT_STATE.json`,
    'governance/state/generated/GATE_STATUS_SNAPSHOT.json',
    'governance/generated/ACTIVE_GATE_CONTEXT.json',
    'governance/generated/ACTIVE_GATE_CONTEXT.md'
  ]);
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isString(value) { return typeof value === 'string' && value.length > 0; }
function isSha(value) { return typeof value === 'string' && SHA256_RE.test(value); }
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function unknownFields(value, fields, findings, code) {
  for (const key of Object.keys(value || {})) if (!fields.includes(key)) findings.push({ code, detail: key });
}
function missingFields(value, fields, findings, code) {
  for (const key of fields) if (!hasOwn(value, key)) findings.push({ code, detail: key });
}
function exactPath(value) {
  return isString(value) && value.normalize('NFC') === value && !value.includes('\\')
    && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('*')
    && !value.includes('?') && !value.split('/').some((part) => !part || part === '.' || part === '..');
}
function exactPathList(value, { nonEmpty = true } = {}) {
  return Array.isArray(value) && (!nonEmpty || value.length > 0)
    && value.every(exactPath) && new Set(value).size === value.length;
}
function sortedPaths(value) { return [...value].sort((a, b) => a < b ? -1 : a > b ? 1 : 0); }

function validateDependencyProof(value, findings) {
  if (!isObject(value)) { findings.push({ code: 'DEPENDENCY_PROOF_INVALID' }); return; }
  const fields = ['gateId', 'status', 'authorityPath', 'authoritySha256'];
  unknownFields(value, fields, findings, 'DEPENDENCY_PROOF_UNKNOWN_FIELD');
  missingFields(value, fields, findings, 'DEPENDENCY_PROOF_FIELD_MISSING');
  if (!isString(value.gateId)) findings.push({ code: 'DEPENDENCY_GATE_INVALID' });
  if (!['COMPLETE_AGENT', 'COMPLETE_CONFIRMED'].includes(value.status)) findings.push({ code: 'DEPENDENCY_STATUS_NON_TERMINAL' });
  if (!exactPath(value.authorityPath) && !isString(value.authorityPath)) findings.push({ code: 'DEPENDENCY_AUTHORITY_INVALID' });
  if (!isSha(value.authoritySha256)) findings.push({ code: 'DEPENDENCY_AUTHORITY_SHA_INVALID' });
}

function validateCommon(document, findings) {
  if (document.schemaVersion !== GATE_START_SCHEMA_VERSION) findings.push({ code: 'SCHEMA_VERSION_INVALID' });
  if (!isString(document.projectId)) findings.push({ code: 'PROJECT_ID_INVALID' });
  if (!isModernGateStartId(document.gateId)) findings.push({ code: 'GATE_ID_OUT_OF_SCOPE' });
  if (document.purpose !== GATE_START_PURPOSE) findings.push({ code: 'PURPOSE_INVALID' });
  if (!isString(document.eventId)) findings.push({ code: 'EVENT_ID_INVALID' });
  if (document.transitionType !== GATE_START_TRANSITION_TYPE) findings.push({ code: 'TRANSITION_TYPE_INVALID' });
  if (document.fromStatus !== GATE_START_FROM_STATUS) findings.push({ code: 'FROM_STATUS_INVALID' });
  if (document.toStatus !== GATE_START_TO_STATUS) findings.push({ code: 'TO_STATUS_INVALID' });
  if (!isString(document.recordedAt) || Number.isNaN(Date.parse(document.recordedAt))) findings.push({ code: 'RECORDED_AT_INVALID' });
  if (!isString(document.baseCommit) || !COMMIT_RE.test(document.baseCommit)) findings.push({ code: 'BASE_COMMIT_INVALID' });
  for (const field of ['preStartLedgerSha256', 'previousEventSha256', 'contractSha256', 'currentContractSha256', 'preCurrentStateSha256', 'preStateSealSha256', 'readinessDigest']) {
    if (!isSha(document[field])) findings.push({ code: `${field.toUpperCase()}_INVALID` });
  }
  if (document.preStateRevision !== 'R0001') findings.push({ code: 'PRE_STATE_REVISION_INVALID' });
  validateDependencyProof(document.dependencyProof, findings);
  if (!isObject(document.activeGatePreState)) findings.push({ code: 'ACTIVE_GATE_PRE_STATE_INVALID' });
  else {
    unknownFields(document.activeGatePreState, ['activeGate', 'sha256', 'byteLength'], findings, 'ACTIVE_GATE_PRE_STATE_UNKNOWN_FIELD');
    if (!isString(document.activeGatePreState.activeGate)) findings.push({ code: 'ACTIVE_GATE_PRE_STATE_GATE_INVALID' });
    if (!isSha(document.activeGatePreState.sha256)) findings.push({ code: 'ACTIVE_GATE_PRE_STATE_SHA_INVALID' });
    if (!Number.isInteger(document.activeGatePreState.byteLength) || document.activeGatePreState.byteLength < 0) findings.push({ code: 'ACTIVE_GATE_PRE_STATE_LENGTH_INVALID' });
  }
  if (!exactPathList(document.authorizedStartWritePaths) || JSON.stringify(sortedPaths(document.authorizedStartWritePaths)) !== JSON.stringify(sortedPaths(gateStartWriteCohortPaths(document.gateId)))) {
    findings.push({ code: 'START_WRITE_COHORT_NOT_EXACT' });
  }
  if (!exactPathList(document.functionalExecutionScope)) findings.push({ code: 'FUNCTIONAL_SCOPE_INVALID' });
  if (document.functionalExecutionScope.some((p) => p.includes('/GEE') || p.includes('/R8') || p.includes('/../'))) findings.push({ code: 'FUNCTIONAL_SCOPE_FORBIDDEN_PATH' });
  if (!isString(document.ownerKeyId)) findings.push({ code: 'OWNER_KEY_ID_INVALID' });
  if (!isString(document.expiresAtUtc) || Number.isNaN(Date.parse(document.expiresAtUtc))) findings.push({ code: 'EXPIRY_INVALID' });
  if (document.maxUse !== GATE_START_MAX_USE) findings.push({ code: 'MAX_USE_INVALID' });
  if (!Array.isArray(document.prohibitedOperations) || document.prohibitedOperations.length !== GATE_START_PROHIBITED_OPERATIONS.length
    || document.prohibitedOperations.some((item) => !GATE_START_PROHIBITED_OPERATIONS.includes(item))
    || new Set(document.prohibitedOperations).size !== document.prohibitedOperations.length) findings.push({ code: 'PROHIBITED_OPERATIONS_INVALID' });
  if (document.startAuthorized !== true) findings.push({ code: 'START_PRIVILEGE_NOT_GRANTED' });
  if (document.executionAuthorized !== true) findings.push({ code: 'EXECUTION_PRIVILEGE_NOT_GRANTED' });
}

export function validateGateStartRequestShape(request) {
  const findings = [];
  if (!isObject(request)) return { valid: false, findings: [{ code: 'REQUEST_ABSENT' }] };
  unknownFields(request, ['schemaVersion', ...GATE_START_REQUEST_FIELDS], findings, 'REQUEST_UNKNOWN_FIELD');
  missingFields(request, ['schemaVersion', ...GATE_START_REQUEST_FIELDS], findings, 'REQUEST_FIELD_MISSING');
  if (request.documentKind !== GATE_START_REQUEST_KIND) findings.push({ code: 'REQUEST_KIND_INVALID' });
  if (!isString(request.requestId)) findings.push({ code: 'REQUEST_ID_INVALID' });
  if (request.bindingDigestAlgorithm !== GATE_START_BINDING_DIGEST_ALGORITHM) findings.push({ code: 'BINDING_ALGORITHM_INVALID' });
  validateCommon(request, findings);
  const recomputed = computeGateStartRequestDigest(request);
  if (request.requestDigest !== recomputed) findings.push({ code: 'REQUEST_DIGEST_MISMATCH', detail: recomputed });
  // The request is intentionally not self-authorizing: bindingDigest joins this
  // request to the separately authored START record.  The pair is checked by
  // evaluateGateStartAuthority (and by the owner tool), never by this document
  // alone.
  return { valid: findings.length === 0, findings };
}

export function validateGateStartRecordShape(record) {
  const findings = [];
  if (!isObject(record)) return { valid: false, findings: [{ code: 'RECORD_ABSENT' }] };
  unknownFields(record, ['schemaVersion', ...GATE_START_RECORD_FIELDS], findings, 'RECORD_UNKNOWN_FIELD');
  missingFields(record, ['schemaVersion', ...GATE_START_RECORD_FIELDS], findings, 'RECORD_FIELD_MISSING');
  if (record.document !== GATE_START_RECORD_KIND) findings.push({ code: 'RECORD_KIND_INVALID' });
  if (!isString(record.recordId)) findings.push({ code: 'RECORD_ID_INVALID' });
  validateCommon(record, findings);
  const digest = computeGateStartRecordDigest(record);
  if (record.recordDigest !== digest) findings.push({ code: 'RECORD_DIGEST_MISMATCH', detail: digest });
  return { valid: findings.length === 0, findings };
}

export function validateGateStartAuthorityShape(authority) {
  const findings = [];
  if (!isObject(authority)) return { valid: false, findings: [{ code: 'AUTHORITY_ABSENT' }] };
  unknownFields(authority, GATE_START_AUTHORITY_FIELDS, findings, 'AUTHORITY_UNKNOWN_FIELD');
  missingFields(authority, GATE_START_AUTHORITY_FIELDS, findings, 'AUTHORITY_FIELD_MISSING');
  if (authority.schemaVersion !== GATE_START_SCHEMA_VERSION) findings.push({ code: 'SCHEMA_VERSION_INVALID' });
  if (authority.documentKind !== GATE_START_AUTHORITY_KIND) findings.push({ code: 'AUTHORITY_KIND_INVALID' });
  if (!isString(authority.authorityId)) findings.push({ code: 'AUTHORITY_ID_INVALID' });
  if (authority.issuedBy !== 'PROJECT_OWNER') findings.push({ code: 'ISSUER_INVALID' });
  if (!isString(authority.issuedAtUtc) || Number.isNaN(Date.parse(authority.issuedAtUtc))) findings.push({ code: 'ISSUED_AT_INVALID' });
  if (authority.signatureAlgorithm !== GATE_START_SIGNATURE_ALGORITHM || !isString(authority.signature)) findings.push({ code: 'SIGNATURE_INVALID' });
  if (!isSha(authority.requestDigest) || !isSha(authority.recordDigest) || !isSha(authority.bindingDigest)) findings.push({ code: 'APPROVED_DIGEST_INVALID' });
  validateCommon(authority, findings);
  return { valid: findings.length === 0, findings };
}

export function computeGateStartRequestDigest(request) {
  const { requestDigest, bindingDigest, ...unsigned } = request || {};
  return sha256Hex(canonicalize(unsigned));
}
export function computeGateStartRecordDigest(record) {
  const { recordDigest, ...unsigned } = record || {};
  return sha256Hex(canonicalize(unsigned));
}
export function computeGateStartBindingDigest({ request, record } = {}) {
  return computeGateStartBindingDigestFromDigests({
    requestDigest: computeGateStartRequestDigest(request),
    recordDigest: computeGateStartRecordDigest(record)
  });
}
export function computeGateStartBindingDigestFromDigests({ requestDigest, recordDigest } = {}) {
  return sha256Hex(canonicalize({
    algorithm: GATE_START_BINDING_DIGEST_ALGORITHM,
    requestDigest,
    recordDigest
  }));
}

export function computeGateStartReadinessDigest(input) {
  const required = ['projectId', 'gateId', 'status', 'preStartLedgerSha256', 'previousEventSha256', 'preStateRevision', 'preCurrentStateSha256', 'preStateSealSha256', 'openDefectsKnowledge', 'contractSha256', 'currentContractSha256', 'dependencyProof', 'readinessVerdict'];
  if (!isObject(input) || required.some((key) => input[key] === undefined)) return null;
  return sha256Hex(canonicalize({
    algorithm: GATE_START_READINESS_DIGEST_ALGORITHM,
    projectId: input.projectId, gateId: input.gateId, status: input.status,
    preStartLedgerSha256: input.preStartLedgerSha256, previousEventSha256: input.previousEventSha256,
    preStateRevision: input.preStateRevision, preCurrentStateSha256: input.preCurrentStateSha256,
    preStateSealSha256: input.preStateSealSha256, openDefectsKnowledge: input.openDefectsKnowledge,
    contractSha256: input.contractSha256, currentContractSha256: input.currentContractSha256,
    dependencyProof: input.dependencyProof, readinessVerdict: input.readinessVerdict
  }));
}

export function evaluateGateStartAuthority({ request, record, authority, ownerKey, now = new Date(), expectedEvent = null } = {}) {
  const findings = [];
  const requestShape = validateGateStartRequestShape(request);
  const recordShape = validateGateStartRecordShape(record);
  const authorityShape = validateGateStartAuthorityShape(authority);
  findings.push(...requestShape.findings, ...recordShape.findings, ...authorityShape.findings);
  if (requestShape.valid && recordShape.valid && authorityShape.valid) {
    const requestDigest = computeGateStartRequestDigest(request);
    const recordDigest = computeGateStartRecordDigest(record);
    const bindingDigest = computeGateStartBindingDigest({ request, record });
    if (authority.requestDigest !== requestDigest) findings.push({ code: 'REQUEST_DIGEST_MISMATCH' });
    if (authority.recordDigest !== recordDigest) findings.push({ code: 'RECORD_DIGEST_MISMATCH' });
    if (authority.bindingDigest !== bindingDigest) findings.push({ code: 'BINDING_DIGEST_MISMATCH' });
    for (const field of GATE_START_SHARED_FIELDS) if (request[field] !== record[field] || record[field] !== authority[field]) findings.push({ code: 'AUTHORITY_BINDING_MISMATCH', detail: field });
    const signature = verifyOwnerSignature(authority, ownerKey);
    if (!signature.verified) findings.push({ code: 'OWNER_SIGNATURE_INVALID', detail: signature.reason });
    const expiry = Date.parse(authority.expiresAtUtc);
    if (Number.isNaN(expiry) || now.getTime() > expiry) findings.push({ code: 'AUTHORITY_EXPIRED' });
    if (expectedEvent) {
      for (const field of ['eventId', 'gateId', 'transitionType', 'fromStatus', 'toStatus', 'recordedAt']) {
        if (expectedEvent[field] !== record[field]) findings.push({ code: `EVENT_${field.toUpperCase()}_MISMATCH` });
      }
    }
  }
  return { decision: findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED', startAuthorized: findings.length === 0, executionAuthorized: findings.length === 0, findings };
}

export { authorizationSigningPayload, canonicalize, sha256Hex, verifyOwnerSignature };
