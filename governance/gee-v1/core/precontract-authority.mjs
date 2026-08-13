import { canonicalize, sha256Hex, verifyOwnerSignature } from './release-authority.mjs';

export const PRECONTRACT_SCHEMA_VERSION = 1;
export const PRECONTRACT_REQUEST_KIND = 'PRECONTRACT_AUTHORITY_REQUEST';
export const PRECONTRACT_AUTHORITY_KIND = 'ACTIVE_PRECONTRACT_AUTHORITY';
export const PRECONTRACT_PURPOSE = 'BOOTSTRAP_CONTRACT_CANONICALIZATION';
export const PRECONTRACT_OPERATION = 'BOOTSTRAP_CONTRACT_CANONICALIZATION';
export const PRECONTRACT_STATUS = 'NOT_STARTED';
export const PRECONTRACT_MAX_USE = 1;
export const TERMINAL_DEPENDENCY_STATUSES = Object.freeze(['COMPLETE_AGENT', 'COMPLETE_CONFIRMED']);

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'requestId', 'projectId', 'gateId', 'purpose', 'operation',
  'baseCommit', 'ledgerSha256', 'currentStatus', 'dependencyProof', 'authorizedPaths',
  'artifactBindings', 'expiresAtUtc', 'maxUse', 'prohibitedOperations', 'requestDigest'
]);
const AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'authorityId', 'issuedBy', 'issuedAtUtc', 'approvedRequestDigest',
  'projectId', 'gateId', 'purpose', 'operation', 'authorizedPaths', 'artifactBindings', 'expiresAtUtc',
  'maxUse', 'ownerKeyId', 'signatureAlgorithm', 'signature'
]);
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

export function validatePrecontractAuthorityShape(authority) {
  const findings = [];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    finding(findings, 'AUTHORITY_ABSENT');
    return { valid: false, findings };
  }
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
  return { valid: findings.length === 0, findings };
}

function compareDependency(observed, expected, findings) {
  if (!observed || observed.gateId !== expected?.gateId || observed.status !== expected?.status
    || observed.authorityPath !== expected?.authorityPath || observed.authoritySha256 !== expected?.authoritySha256) finding(findings, 'DEPENDENCY_PROOF_MISMATCH');
  if (!TERMINAL_DEPENDENCY_STATUSES.includes(observed?.status)) finding(findings, 'DEPENDENCY_NOT_TERMINAL', observed?.status);
}

export function evaluatePrecontractAuthority({ request = null, authority = null, ownerKey = null, observed = {}, operation = PRECONTRACT_OPERATION, requestedPath = null, now = new Date(), phase = 'AUTHORIZE_WRITE' } = {}) {
  const findings = [];
  const requestResult = validatePrecontractRequest(request);
  const authorityResult = validatePrecontractAuthorityShape(authority);
  findings.push(...requestResult.findings, ...authorityResult.findings);
  if (authorityResult.valid) {
    const signature = verifyOwnerSignature(authority, ownerKey);
    if (!signature.verified) finding(findings, signature.reason);
    const expiry = Date.parse(authority.expiresAtUtc);
    if (now.getTime() > expiry) finding(findings, 'AUTHORITY_EXPIRED');
  }
  if (requestResult.valid && authorityResult.valid) {
    if (authority.approvedRequestDigest !== request.requestDigest || authority.approvedRequestDigest !== computePrecontractRequestDigest(request)) finding(findings, 'REQUEST_AUTHORITY_DIGEST_MISMATCH');
    for (const field of ['projectId', 'gateId', 'purpose', 'operation', 'expiresAtUtc', 'maxUse']) if (authority[field] !== request[field]) finding(findings, 'AUTHORITY_REQUEST_BINDING_MISMATCH', field);
    if (!sameStringArray(authority.authorizedPaths, request.authorizedPaths)) finding(findings, 'AUTHORITY_PATHS_MISMATCH');
    if (!sameBindings(authority.artifactBindings, request.artifactBindings)) finding(findings, 'AUTHORITY_ARTIFACT_BINDINGS_MISMATCH');
  }
  if (operation !== PRECONTRACT_OPERATION) finding(findings, 'OPERATION_NOT_AUTHORIZED', operation);
  if (requestedPath !== null && !isPrecontractPathAuthorized(request?.authorizedPaths, requestedPath)) finding(findings, 'PATH_NOT_AUTHORIZED', requestedPath);
  if (observed.projectId !== request?.projectId) finding(findings, 'PROJECT_ID_MISMATCH');
  if (observed.gateId !== request?.gateId) finding(findings, 'GATE_ID_MISMATCH');
  if (observed.headCommit !== request?.baseCommit) finding(findings, 'BASE_COMMIT_MISMATCH');
  if (observed.ledgerSha256 !== request?.ledgerSha256) finding(findings, 'LEDGER_SHA_MISMATCH');
  if (observed.currentStatus !== PRECONTRACT_STATUS) finding(findings, 'CURRENT_STATUS_NOT_NOT_STARTED', observed.currentStatus);
  compareDependency(observed.dependencyProof, request?.dependencyProof, findings);
  if (phase === 'AUTHORIZE_WRITE') {
    if (observed.currentContractPresent === true) finding(findings, 'CURRENT_CONTRACT_PRESENT');
    if (observed.consumed === true) finding(findings, 'AUTHORITY_ALREADY_CONSUMED');
  } else if (phase === 'VERIFY_CONSUMPTION') {
    if (observed.currentContractPresent !== true) finding(findings, 'CURRENT_CONTRACT_NOT_CREATED');
    for (const binding of request?.artifactBindings || []) if (observed.targetFileSha256?.[binding.path] !== binding.sha256) finding(findings, 'ARTIFACT_BYTES_MISMATCH', binding.path);
  } else finding(findings, 'PHASE_INVALID', phase);
  const decision = findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED';
  return { decision, bootstrapAuthorized: decision === 'AUTHORIZED' && phase === 'AUTHORIZE_WRITE', consumed: decision === 'AUTHORIZED' && phase === 'VERIFY_CONSUMPTION', findings, authorizedPaths: decision === 'AUTHORIZED' && phase === 'AUTHORIZE_WRITE' ? [...request.authorizedPaths] : [] };
}
