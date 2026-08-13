/**
 * Project-agnostic, owner-rooted successor authority for execution contracts.
 *
 * This primitive authorizes one exact CURRENT_CONTRACT switch. It never grants
 * START, execution, closure, ledger, GEE, or arbitrary governance authority.
 * The predecessor is content-addressed and immutable; the owner signs the
 * exact request/record bindings and the exact successor bytes by SHA-256.
 */

import crypto from 'node:crypto';
import { canonicalize, sha256Bytes } from '../../tools/canonical-json.mjs';

export const SUCCESSION_SCHEMA_VERSION = 1;
export const SUCCESSION_REQUEST_KIND = 'GATE_CONTRACT_SUCCESSION_REQUEST';
export const SUCCESSION_RECORD_KIND = 'GATE_CONTRACT_SUCCESSION_RECORD';
export const SUCCESSION_AUTHORITY_KIND = 'PROJECT_OWNER_GATE_CONTRACT_SUCCESSION_AUTHORITY';
export const SUCCESSION_PURPOSE = 'OWNER_AUTHORIZED_CONTRACT_SUCCESSION';
export const SUCCESSION_OPERATION = 'CURRENT_CONTRACT_SWITCH';
export const SUCCESSION_MAX_USE = 1;
export const SUCCESSION_BINDING_ALGORITHM = 'SHA-256-CANONICAL-JSON-V1';
export const SUCCESSION_GATE_RE = /^GATE(1[4-9]|[23][0-9]|40)$/;

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
function same(a, b) { return canonicalize(a) === canonicalize(b); }

function checkShape(document, required, allowed, findings, label) {
  if (!isObject(document)) { finding(findings, `${label.toUpperCase()}_MALFORMED`); return false; }
  for (const field of required) if (!Object.prototype.hasOwnProperty.call(document, field)) finding(findings, `${label.toUpperCase()}_MISSING_FIELD`, field);
  for (const field of Object.keys(document)) if (!allowed.includes(field)) finding(findings, `${label.toUpperCase()}_UNKNOWN_FIELD`, field);
  return true;
}

function validateShared(document, findings) {
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
  if (typeof document.ownerKeyId !== 'string' || !document.ownerKeyId) finding(findings, 'OWNER_KEY_ID_INVALID');
  if (document.maxUse !== SUCCESSION_MAX_USE) finding(findings, 'MAX_USE_INVALID');
  if (document.successorAuthorized !== true) finding(findings, 'SUCCESSOR_NOT_AUTHORIZED');
  if (document.authorizedOperation !== SUCCESSION_OPERATION) finding(findings, 'AUTHORIZED_OPERATION_INVALID');
  if (!Array.isArray(document.authorizedPaths) || document.authorizedPaths.length === 0) finding(findings, 'AUTHORIZED_PATHS_INVALID');
  if (!Array.isArray(document.statePaths)) finding(findings, 'STATE_PATHS_INVALID');
  for (const p of [...(document.authorizedPaths || []), ...(document.statePaths || [])]) {
    if (!isSafePath(p)) finding(findings, 'AUTHORIZED_PATH_INVALID', p);
    if (String(p).startsWith('governance/gee-v1/')) finding(findings, 'GEE_PATH_FORBIDDEN', p);
    if (String(p).includes('*')) finding(findings, 'WILDCARD_PATH_FORBIDDEN', p);
  }
  if (!Array.isArray(document.authorizedDelta) || document.authorizedDelta.length === 0) finding(findings, 'AUTHORIZED_DELTA_INVALID');
  if (sha256Bytes(Buffer.from(canonicalize(document.authorizedDelta), 'utf8')) !== document.authorizedDeltaDigest) finding(findings, 'AUTHORIZED_DELTA_DIGEST_MISMATCH');
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

export function validateGateContractSuccessionRecordShape(record) {
  const findings = [];
  const valid = checkShape(record, SUCCESSION_RECORD_FIELDS, SUCCESSION_RECORD_FIELDS, findings, 'record');
  if (valid) {
    if (record.document !== SUCCESSION_RECORD_KIND) finding(findings, 'RECORD_DOCUMENT_KIND_INVALID');
    validateShared(record, findings);
    if (typeof record.recordId !== 'string' || !record.recordId) finding(findings, 'RECORD_ID_INVALID');
    if (record.recordDigest !== computeGateContractSuccessionRecordDigest(record)) finding(findings, 'RECORD_DIGEST_MISMATCH');
  }
  return { valid: findings.length === 0, findings };
}

export function validateGateContractSuccessionAuthorityShape(authority) {
  const findings = [];
  const valid = checkShape(authority, SUCCESSION_AUTHORITY_FIELDS, SUCCESSION_AUTHORITY_FIELDS, findings, 'authority');
  if (valid) {
    if (authority.documentKind !== SUCCESSION_AUTHORITY_KIND) finding(findings, 'AUTHORITY_DOCUMENT_KIND_INVALID');
    if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'AUTHORITY_NOT_OWNER_ISSUED');
    if (typeof authority.authorityId !== 'string' || !authority.authorityId) finding(findings, 'AUTHORITY_ID_INVALID');
    if (!isDate(authority.issuedAtUtc)) finding(findings, 'ISSUED_AT_INVALID');
    validateShared(authority, findings);
    if (!isSha(authority.requestDigest) || !isSha(authority.recordDigest) || !isSha(authority.bindingDigest)) finding(findings, 'AUTHORITY_DIGEST_INVALID');
    if (authority.signatureAlgorithm !== 'ed25519') finding(findings, 'SIGNATURE_ALGORITHM_INVALID');
    if (typeof authority.signature !== 'string' || !authority.signature) finding(findings, 'SIGNATURE_MISSING');
  }
  return { valid: findings.length === 0, findings };
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

function exactPathSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && [...left].sort().every((v, i) => v === [...right].sort()[i]);
}

export function evaluateGateContractSuccessionAuthority({ request = null, record = null, authority = null, ownerKey = null, predecessorContract = null, successorContract = null, predecessorCurrentContract = null, successorCurrentContract = null, observed = {}, now = new Date() } = {}) {
  const findings = [];
  const requestResult = validateGateContractSuccessionRequestShape(request);
  const recordResult = validateGateContractSuccessionRecordShape(record);
  const authorityResult = validateGateContractSuccessionAuthorityShape(authority);
  findings.push(...requestResult.findings, ...recordResult.findings, ...authorityResult.findings);
  if (!requestResult.valid || !recordResult.valid || !authorityResult.valid) return { decision: 'BLOCKED', successionAuthorized: false, findings, authorizedPaths: [] };

  compareShared(request, record, authority, findings);
  if (authority.expiresAtUtc && now.getTime() > Date.parse(authority.expiresAtUtc)) finding(findings, 'AUTHORITY_EXPIRED');
  const signature = verifyGateContractSuccessionOwnerSignature(authority, ownerKey);
  if (!signature.verified) finding(findings, signature.reason);
  if (observed.competingAuthorityCount > 1) finding(findings, 'COMPETING_SUCCESSION_AUTHORITIES');
  if (observed.authorityConsumed === true) finding(findings, 'AUTHORITY_REPLAY');
  if (observed.projectId !== request.projectId || observed.gateId !== request.gateId) finding(findings, 'CROSS_GATE_OR_PROJECT_BINDING');
  if (observed.currentStatus !== request.currentGateStatus) finding(findings, 'CURRENT_STATUS_MISMATCH');
  if (observed.ledgerHeadEventId !== request.ledgerHeadEventId || observed.ledgerHeadEventPayloadSha256 !== request.ledgerHeadEventPayloadSha256 || observed.ledgerSha256 !== request.ledgerSha256) finding(findings, 'LEDGER_HEAD_BINDING_MISMATCH');
  if (observed.baseCommit !== request.baseCommit) finding(findings, 'BASE_COMMIT_MISMATCH');

  if (observed.predecessorContractPath !== request.predecessorContractPath) finding(findings, 'PREDECESSOR_PATH_MISMATCH');
  if (observed.predecessorContractSha256 !== request.predecessorContractSha256) finding(findings, 'PREDECESSOR_SHA_MISMATCH');
  if (observed.predecessorCurrentContractPath !== request.predecessorCurrentContractPath) finding(findings, 'PREDECESSOR_CURRENT_POINTER_PATH_MISMATCH');
  if (observed.predecessorCurrentContractSha256 !== request.predecessorCurrentContractSha256) finding(findings, 'PREDECESSOR_CURRENT_POINTER_SHA_MISMATCH');
  if (request.successorContractPath === request.predecessorContractPath) finding(findings, 'PREDECESSOR_MUTATION_FORBIDDEN');
  if (request.successorContractPath === request.predecessorCurrentContractPath) finding(findings, 'CURRENT_POINTER_REPLACEMENT_PATH_INVALID');
  if (observed.successorContractPath !== request.successorContractPath) finding(findings, 'SUCCESSOR_PATH_MISMATCH');
  if (observed.successorContractSha256 !== request.successorContractSha256) finding(findings, 'SUCCESSOR_SHA_MISMATCH');
  if (observed.successorCurrentContractPath !== request.successorCurrentContractPath) finding(findings, 'SUCCESSOR_CURRENT_POINTER_PATH_MISMATCH');
  if (observed.successorCurrentContractSha256 !== request.successorCurrentContractSha256) finding(findings, 'SUCCESSOR_CURRENT_POINTER_SHA_MISMATCH');
  if (observed.candidateLedgerSha256 && observed.candidateLedgerSha256 !== request.ledgerSha256) finding(findings, 'LEDGER_MUTATION_NOT_AUTHORIZED');
  if (!exactPathSet(request.authorizedPaths, [request.successorContractPath, request.successorCurrentContractPath, ...request.statePaths])) finding(findings, 'AUTHORIZED_PATH_SCOPE_MISMATCH');

  const predecessorRevision = revisionNumber(predecessorContract?.contractRevision);
  const successorRevision = revisionNumber(successorContract?.contractRevision);
  if (predecessorContract?.gateId !== request.gateId || successorContract?.gateId !== request.gateId) finding(findings, 'SUCCESSOR_GATE_MISMATCH');
  if (predecessorRevision === null || successorRevision === null || successorRevision !== predecessorRevision + 1 || request.successorRevision !== successorContract?.contractRevision) finding(findings, 'SUCCESSOR_REVISION_LINEAGE_GAP');
  if (successorContract?.previousContractPath !== request.predecessorContractPath || successorContract?.previousContractSha256 !== request.predecessorContractSha256) finding(findings, 'SUCCESSOR_PREDECESSOR_LINEAGE_MISMATCH');
  if (predecessorContract && successorContract) {
    const actualDelta = diffContractSemantics(predecessorContract, successorContract);
    if (!same(actualDelta, request.authorizedDelta)) finding(findings, 'SUCCESSOR_DELTA_OUTSIDE_AUTHORIZATION', actualDelta);
    if (sha256Bytes(Buffer.from(canonicalize(actualDelta), 'utf8')) !== request.authorizedDeltaDigest) finding(findings, 'SUCCESSOR_DELTA_DIGEST_MISMATCH');
  } else finding(findings, 'CONTRACT_BYTES_UNAVAILABLE');
  if (successorCurrentContract && (successorCurrentContract.gateId !== request.gateId || successorCurrentContract.contractRevision !== request.successorRevision || successorCurrentContract.contractPath !== request.successorContractPath || successorCurrentContract.contractSha256 !== request.successorContractSha256)) finding(findings, 'SUCCESSOR_POINTER_BINDING_MISMATCH');
  if (predecessorCurrentContract && (predecessorCurrentContract.gateId !== request.gateId || predecessorCurrentContract.contractPath !== request.predecessorContractPath || predecessorCurrentContract.contractSha256 !== request.predecessorContractSha256)) finding(findings, 'PREDECESSOR_POINTER_BINDING_MISMATCH');

  const authorized = findings.length === 0;
  return { decision: authorized ? 'AUTHORIZED' : 'BLOCKED', successionAuthorized: authorized, executionAuthorized: false, startAuthorized: false, closureAuthorized: false, authorizedPaths: authorized ? request.authorizedPaths : [], findings };
}

export function gateContractSuccessionRecordPath(gateId) {
  return `governance/authority/authorizations/${gateId}/GATE_CONTRACT_SUCCESSION_RECORD.json`;
}

export function gateContractSuccessionAuthorityPath(gateId) {
  return `governance/authority/authorizations/${gateId}/PROJECT_OWNER_GATE_CONTRACT_SUCCESSION_AUTHORITY.json`;
}
