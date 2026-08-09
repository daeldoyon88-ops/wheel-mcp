/**
 * GEE V1 core — post-closure release authority.
 *
 * Answers a question the execution-contract layer deliberately does NOT answer:
 * "may the already-validated repository delta be persisted in ONE local Git commit?"
 *
 * Execution authority (work-unit-execution-contract) says what an agent may DO.
 * Release authority (this module) says whether a FINISHED, CLOSED result may be
 * PERSISTED. Keeping them separate is what makes it possible to release a work
 * unit that is COMPLETE_CONFIRMED without reopening it.
 *
 * Non-circularity is the whole point. The agent may author a RELEASE_REQUEST —
 * a factual, non-authoritative description of exactly what it wants to stage.
 * The agent may NOT author the PROJECT_OWNER_RELEASE_AUTHORIZATION. That
 * document is (a) loaded only from OUTSIDE the governed set and (b) signed with
 * an owner key whose private half never enters the governed set. This module is
 * the pure decision half: no filesystem access, no environment access, no
 * writes. Callers supply observed facts; this module only applies the rules.
 *
 * Project-agnostic: it knows `workUnits` as opaque {workUnitType, workUnitId,
 * closureVerdict} triples. It contains no gate identifiers, no Wheel facts, and
 * no knowledge of what a "GATE" is.
 *
 * Fail-closed everywhere: absence, malformation, unknown fields, drift, and
 * every unrecognised value produce BLOCKED. Nothing is ever upgraded by absence.
 *
 * Honest limit (published, not engineered around): this module raises forgery
 * from "write a JSON file" to "possess the owner's private key". If the owner
 * stores that private key on the same filesystem the agent can read, an agent
 * that deliberately reads it can still forge an authorization. The architecture
 * supports keeping the private half entirely off-machine; the mechanism cannot
 * force the owner to do so.
 */

import crypto from 'node:crypto';

export const RELEASE_SCHEMA_VERSION = 1;
export const REQUEST_DOCUMENT_KIND = 'RELEASE_REQUEST';
export const AUTHORIZATION_DOCUMENT_KIND = 'PROJECT_OWNER_RELEASE_AUTHORIZATION';
export const RELEASE_PURPOSE = 'POST_CLOSURE_LOCAL_RELEASE_COMMIT';

/** The complete set of Git operations this authority kind may ever grant. */
export const GRANTABLE_OPERATIONS = Object.freeze(['GIT_ADD_PATHSPEC', 'GIT_COMMIT']);

/**
 * Operations this authority kind may NEVER grant, at any schema version.
 * `git push` is a separate authority. The rest are covered by a constitutional
 * rule whose override authority is NONE, so no release authorization may claim
 * them even if a future owner document tried to.
 */
export const NEVER_GRANTABLE_OPERATIONS = Object.freeze([
  'GIT_PUSH', 'GIT_PUSH_FORCE', 'GIT_ADD_ALL', 'GIT_ADD_DOT', 'GIT_COMMIT_ALL',
  'GIT_RESET', 'GIT_CLEAN', 'GIT_RESTORE', 'GIT_CHECKOUT', 'GIT_STASH', 'GIT_RM', 'GIT_MV'
]);

export const PHASE_PRE_STAGE = 'PRE_STAGE';
export const PHASE_PRE_COMMIT = 'PRE_COMMIT';

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'requestId', 'projectId', 'repositoryOriginUrl',
  'branch', 'baseCommit', 'purpose', 'workUnits', 'governedStateBindings',
  'externalWitness', 'requestedOperations', 'pushRequested', 'maxCommitCount',
  'commitMessage', 'manifest', 'manifestDigest', 'requestDigest'
]);

const AUTHORIZATION_FIELDS = Object.freeze([
  'schemaVersion', 'documentKind', 'authorizationId', 'issuedBy', 'issuedAtUtc',
  'expiresAtUtc', 'projectId', 'branch', 'baseCommit', 'purpose',
  'approvedRequestDigest', 'authorizedOperations', 'pushAllowed', 'maxCommitCount',
  'ownerKeyId', 'signatureAlgorithm', 'signature'
]);

const MANIFEST_FIELDS = Object.freeze(['path', 'status', 'workingTreeSha256', 'stageAction']);
const MANIFEST_STATUSES = Object.freeze(['ADDED', 'MODIFIED', 'DELETED']);
const MANIFEST_ACTIONS = Object.freeze(['STAGE_CONTENT', 'STAGE_DELETION']);

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

/** Deterministic canonical JSON: object keys sorted, no insignificant whitespace. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).digest('hex');
}

/** Digest of the approved delta alone — every path, byte hash and stage action. */
export function computeManifestDigest(manifest) {
  const rows = (Array.isArray(manifest) ? manifest : [])
    .map((e) => ({ path: e?.path, status: e?.status, workingTreeSha256: e?.workingTreeSha256, stageAction: e?.stageAction }))
    .sort((a, b) => String(a.path).localeCompare(String(b.path), 'en'));
  return sha256Hex(canonicalize(rows));
}

/**
 * Digest of the whole request EXCEPT its own `requestDigest` field. This is the
 * single value the owner signs: binding it transitively binds base HEAD, branch,
 * project, work units, ledger/witness state, the exact manifest, the commit
 * message and the requested operations. Changing ANY of them changes the digest,
 * so a previously approved authorization stops matching.
 */
export function computeRequestDigest(request) {
  const { requestDigest, ...rest } = request || {};
  return sha256Hex(canonicalize(rest));
}

function push(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function checkUnknownFields(findings, object, allowed, code) {
  for (const key of Object.keys(object || {})) {
    if (!allowed.includes(key)) push(findings, code, key);
  }
}

function validateRequestShape(request, findings) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    push(findings, 'REQUEST_ABSENT');
    return false;
  }
  checkUnknownFields(findings, request, REQUEST_FIELDS, 'REQUEST_UNKNOWN_FIELD');
  if (request.schemaVersion !== RELEASE_SCHEMA_VERSION) push(findings, 'REQUEST_SCHEMA_VERSION_UNSUPPORTED', request.schemaVersion);
  if (request.documentKind !== REQUEST_DOCUMENT_KIND) push(findings, 'REQUEST_WRONG_DOCUMENT_KIND', request.documentKind);
  if (request.purpose !== RELEASE_PURPOSE) push(findings, 'REQUEST_WRONG_PURPOSE', request.purpose);
  if (typeof request.projectId !== 'string' || !request.projectId) push(findings, 'REQUEST_MALFORMED', 'projectId');
  if (typeof request.branch !== 'string' || !request.branch) push(findings, 'REQUEST_MALFORMED', 'branch');
  if (typeof request.baseCommit !== 'string' || !COMMIT_RE.test(request.baseCommit)) push(findings, 'REQUEST_MALFORMED', 'baseCommit');
  if (typeof request.commitMessage !== 'string' || !request.commitMessage) push(findings, 'REQUEST_MALFORMED', 'commitMessage');
  if (request.pushRequested !== false) push(findings, 'PUSH_NOT_AUTHORIZED', 'request.pushRequested');
  if (request.maxCommitCount !== 1) push(findings, 'COMMIT_BUDGET_INVALID', request.maxCommitCount);
  if (!Array.isArray(request.workUnits) || request.workUnits.length === 0) push(findings, 'REQUEST_MALFORMED', 'workUnits');
  if (!Array.isArray(request.manifest) || request.manifest.length === 0) push(findings, 'REQUEST_MALFORMED', 'manifest');
  if (!Array.isArray(request.governedStateBindings)) push(findings, 'REQUEST_MALFORMED', 'governedStateBindings');

  for (const operation of Array.isArray(request.requestedOperations) ? request.requestedOperations : [null]) {
    if (NEVER_GRANTABLE_OPERATIONS.includes(operation)) push(findings, 'FORBIDDEN_OPERATION_REQUESTED', operation);
    else if (!GRANTABLE_OPERATIONS.includes(operation)) push(findings, 'REQUEST_MALFORMED', `requestedOperations:${operation}`);
  }

  const seenPaths = new Set();
  for (const entry of Array.isArray(request.manifest) ? request.manifest : []) {
    if (!entry || typeof entry !== 'object') { push(findings, 'REQUEST_MALFORMED', 'manifest entry'); continue; }
    checkUnknownFields(findings, entry, MANIFEST_FIELDS, 'REQUEST_UNKNOWN_FIELD');
    if (typeof entry.path !== 'string' || !entry.path) push(findings, 'REQUEST_MALFORMED', 'manifest.path');
    else if (entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').includes('..')) push(findings, 'MANIFEST_PATH_NOT_REPO_RELATIVE', entry.path);
    else if (seenPaths.has(entry.path)) push(findings, 'MANIFEST_DUPLICATE_PATH', entry.path);
    else seenPaths.add(entry.path);
    if (!MANIFEST_STATUSES.includes(entry.status)) push(findings, 'REQUEST_MALFORMED', 'manifest.status');
    if (!MANIFEST_ACTIONS.includes(entry.stageAction)) push(findings, 'REQUEST_MALFORMED', 'manifest.stageAction');
    if (entry.status === 'DELETED') {
      if (entry.workingTreeSha256 !== null) push(findings, 'REQUEST_MALFORMED', 'manifest.workingTreeSha256 must be null for DELETED');
      if (entry.stageAction !== 'STAGE_DELETION') push(findings, 'REQUEST_MALFORMED', 'manifest.stageAction for DELETED');
    } else if (typeof entry.workingTreeSha256 !== 'string' || !SHA256_RE.test(entry.workingTreeSha256)) {
      push(findings, 'REQUEST_MALFORMED', 'manifest.workingTreeSha256');
    }
  }

  const recomputedManifestDigest = computeManifestDigest(request.manifest);
  if (request.manifestDigest !== recomputedManifestDigest) push(findings, 'MANIFEST_DIGEST_MISMATCH', recomputedManifestDigest);
  const recomputedRequestDigest = computeRequestDigest(request);
  if (request.requestDigest !== recomputedRequestDigest) push(findings, 'REQUEST_DIGEST_SELF_INCONSISTENT', recomputedRequestDigest);
  return true;
}

function validateAuthorizationShape(authorization, findings) {
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    push(findings, 'AUTHORIZATION_ABSENT');
    return false;
  }
  checkUnknownFields(findings, authorization, AUTHORIZATION_FIELDS, 'AUTHORIZATION_UNKNOWN_FIELD');
  if (authorization.schemaVersion !== RELEASE_SCHEMA_VERSION) push(findings, 'AUTHORIZATION_SCHEMA_VERSION_UNSUPPORTED', authorization.schemaVersion);
  if (authorization.documentKind !== AUTHORIZATION_DOCUMENT_KIND) push(findings, 'AUTHORIZATION_WRONG_DOCUMENT_KIND', authorization.documentKind);
  if (authorization.purpose !== RELEASE_PURPOSE) push(findings, 'AUTHORIZATION_WRONG_PURPOSE', authorization.purpose);
  if (authorization.issuedBy !== 'PROJECT_OWNER') push(findings, 'AUTHORIZATION_NOT_ISSUED_BY_PROJECT_OWNER', authorization.issuedBy);
  if (typeof authorization.authorizationId !== 'string' || !authorization.authorizationId) push(findings, 'AUTHORIZATION_MALFORMED', 'authorizationId');
  if (typeof authorization.projectId !== 'string' || !authorization.projectId) push(findings, 'AUTHORIZATION_MALFORMED', 'projectId');
  if (typeof authorization.branch !== 'string' || !authorization.branch) push(findings, 'AUTHORIZATION_MALFORMED', 'branch');
  if (typeof authorization.baseCommit !== 'string' || !COMMIT_RE.test(authorization.baseCommit)) push(findings, 'AUTHORIZATION_MALFORMED', 'baseCommit');
  if (typeof authorization.approvedRequestDigest !== 'string' || !SHA256_RE.test(authorization.approvedRequestDigest)) push(findings, 'AUTHORIZATION_MALFORMED', 'approvedRequestDigest');
  if (typeof authorization.issuedAtUtc !== 'string' || Number.isNaN(Date.parse(authorization.issuedAtUtc))) push(findings, 'AUTHORIZATION_MALFORMED', 'issuedAtUtc');
  // pushAllowed is a hard constant for this authority kind, never a decision.
  if (authorization.pushAllowed !== false) push(findings, 'PUSH_NOT_AUTHORIZED', 'authorization.pushAllowed');
  if (authorization.maxCommitCount !== 1) push(findings, 'COMMIT_BUDGET_INVALID', authorization.maxCommitCount);
  if (!Array.isArray(authorization.authorizedOperations) || authorization.authorizedOperations.length === 0) {
    push(findings, 'AUTHORIZATION_MALFORMED', 'authorizedOperations');
  } else {
    for (const operation of authorization.authorizedOperations) {
      if (NEVER_GRANTABLE_OPERATIONS.includes(operation)) push(findings, 'FORBIDDEN_OPERATION_GRANTED', operation);
      else if (!GRANTABLE_OPERATIONS.includes(operation)) push(findings, 'AUTHORIZATION_MALFORMED', `authorizedOperations:${operation}`);
    }
  }
  if (typeof authorization.ownerKeyId !== 'string' || !authorization.ownerKeyId) push(findings, 'AUTHORIZATION_MALFORMED', 'ownerKeyId');
  if (authorization.signatureAlgorithm !== 'ed25519') push(findings, 'AUTHORIZATION_SIGNATURE_ALGORITHM_UNSUPPORTED', authorization.signatureAlgorithm);
  if (typeof authorization.signature !== 'string' || !authorization.signature) push(findings, 'AUTHORIZATION_SIGNATURE_MISSING');
  return true;
}

/** The exact bytes the owner key signs: the authorization minus its signature. */
export function authorizationSigningPayload(authorization) {
  const { signature, ...rest } = authorization || {};
  return canonicalize(rest);
}

/**
 * Verifies the owner signature. `ownerKey` is the PUBLIC half only — pinning a
 * public key inside the governed set grants nothing, so an agent that can
 * rewrite it can only invalidate authorizations, never forge one.
 */
export function verifyOwnerSignature(authorization, ownerKey) {
  if (!ownerKey || typeof ownerKey.publicKeyPem !== 'string' || !ownerKey.publicKeyPem) {
    return { verified: false, reason: 'OWNER_PUBLIC_KEY_UNAVAILABLE' };
  }
  if (ownerKey.keyId !== authorization?.ownerKeyId) {
    return { verified: false, reason: 'OWNER_KEY_ID_MISMATCH' };
  }
  try {
    const ok = crypto.verify(
      null,
      Buffer.from(authorizationSigningPayload(authorization), 'utf8'),
      crypto.createPublicKey(ownerKey.publicKeyPem),
      Buffer.from(authorization.signature, 'base64')
    );
    return ok ? { verified: true, reason: 'OWNER_SIGNATURE_VERIFIED' } : { verified: false, reason: 'AUTHORIZATION_SIGNATURE_INVALID' };
  } catch {
    return { verified: false, reason: 'AUTHORIZATION_SIGNATURE_INVALID' };
  }
}

/**
 * The single decision function.
 *
 * @param {object} input
 * @param {object|null} input.request           RELEASE_REQUEST document (agent-authored, non-authoritative)
 * @param {object|null} input.authorization     PROJECT_OWNER_RELEASE_AUTHORIZATION (owner-authored, external)
 * @param {string|null} input.authorizationLoadFinding  loader-reported reason the authorization is unusable
 * @param {object|null} input.ownerKey          { keyId, publicKeyPem }
 * @param {object} input.observed               live facts read by the caller:
 *   { projectId, branch, headCommit, governedStateSha256: {bindingId: sha}, externalWitnessSha256,
 *     externalWitnessIsExternal, manifestPathSha256: {path: sha|null}, stagedPaths?: [], workUnitClosures: {id: verdict} }
 * @param {string} input.phase                  PHASE_PRE_STAGE | PHASE_PRE_COMMIT
 * @param {Date}   [input.now]
 * @param {object|null} [input.consumptionRecord]
 * @returns {{ decision: 'AUTHORIZED'|'BLOCKED', phase: string, findings: Array<object>, permittedOperations: Array<string>, commitPlan: object|null }}
 */
export function evaluateReleaseAuthorization({
  request = null,
  authorization = null,
  authorizationLoadFinding = null,
  ownerKey = null,
  observed = {},
  phase = PHASE_PRE_STAGE,
  now = new Date(),
  consumptionRecord = null
} = {}) {
  const findings = [];

  if (phase !== PHASE_PRE_STAGE && phase !== PHASE_PRE_COMMIT) push(findings, 'UNKNOWN_PHASE', phase);
  if (authorizationLoadFinding) push(findings, authorizationLoadFinding);

  const haveRequest = validateRequestShape(request, findings);
  const haveAuthorization = validateAuthorizationShape(authorization, findings);

  if (haveAuthorization) {
    const signature = verifyOwnerSignature(authorization, ownerKey);
    if (!signature.verified) push(findings, signature.reason);
    if (typeof authorization.expiresAtUtc === 'string') {
      const expiry = Date.parse(authorization.expiresAtUtc);
      if (Number.isNaN(expiry)) push(findings, 'AUTHORIZATION_MALFORMED', 'expiresAtUtc');
      else if (now.getTime() > expiry) push(findings, 'AUTHORIZATION_EXPIRED', authorization.expiresAtUtc);
    }
  }

  if (haveRequest && haveAuthorization) {
    // The owner approved a digest, not a description. Recompute, never read.
    const actualDigest = computeRequestDigest(request);
    if (authorization.approvedRequestDigest !== actualDigest) push(findings, 'REQUEST_DIGEST_MISMATCH', actualDigest);
    if (authorization.projectId !== request.projectId) push(findings, 'AUTHORIZATION_REQUEST_PROJECT_MISMATCH');
    if (authorization.branch !== request.branch) push(findings, 'AUTHORIZATION_REQUEST_BRANCH_MISMATCH');
    if (authorization.baseCommit !== request.baseCommit) push(findings, 'AUTHORIZATION_REQUEST_BASE_COMMIT_MISMATCH');
    for (const operation of Array.isArray(request.requestedOperations) ? request.requestedOperations : []) {
      if (!authorization.authorizedOperations?.includes(operation)) push(findings, 'OPERATION_NOT_AUTHORIZED', operation);
    }
  }

  // --- live repository / governed-state re-verification -------------------
  if (haveAuthorization) {
    if (observed.projectId !== authorization.projectId) push(findings, 'PROJECT_ID_MISMATCH', observed.projectId);
    if (observed.branch !== authorization.branch) push(findings, 'BRANCH_MISMATCH', observed.branch);
    // Base-HEAD binding is the primary consumption mechanism: once the commit
    // lands, HEAD moves and this check can never pass again.
    if (observed.headCommit !== authorization.baseCommit) push(findings, 'BASE_HEAD_MISMATCH', observed.headCommit);
  }

  if (haveRequest) {
    for (const binding of Array.isArray(request.governedStateBindings) ? request.governedStateBindings : []) {
      const actual = observed.governedStateSha256?.[binding?.bindingId];
      if (actual !== binding?.sha256) push(findings, 'GOVERNED_STATE_BINDING_MISMATCH', `${binding?.bindingId}:${actual ?? 'ABSENT'}`);
    }
    if (request.externalWitness) {
      if (observed.externalWitnessIsExternal !== true) push(findings, 'EXTERNAL_WITNESS_INSIDE_GOVERNED_SET');
      if (observed.externalWitnessSha256 !== request.externalWitness.sha256) push(findings, 'EXTERNAL_WITNESS_BINDING_MISMATCH', observed.externalWitnessSha256 ?? 'ABSENT');
    }
    for (const unit of Array.isArray(request.workUnits) ? request.workUnits : []) {
      const actual = observed.workUnitClosures?.[unit?.workUnitId];
      if (actual === undefined) push(findings, 'WORK_UNIT_CLOSURE_UNKNOWN', unit?.workUnitId);
      else if (actual !== unit?.closureVerdict) push(findings, 'CLOSURE_VERDICT_MISMATCH', `${unit?.workUnitId}:${actual}`);
    }
    // Bytes the owner approved must still be the bytes on disk.
    for (const entry of Array.isArray(request.manifest) ? request.manifest : []) {
      if (!entry || typeof entry.path !== 'string') continue;
      const actual = observed.manifestPathSha256?.[entry.path];
      if (entry.status === 'DELETED') {
        if (actual !== null && actual !== undefined) push(findings, 'MANIFEST_ENTRY_STILL_PRESENT', entry.path);
      } else if (actual === undefined || actual === null) {
        push(findings, 'MANIFEST_ENTRY_MISSING', entry.path);
      } else if (actual !== entry.workingTreeSha256) {
        push(findings, 'MANIFEST_ENTRY_BYTES_CHANGED', entry.path);
      }
    }
  }

  if (consumptionRecord) push(findings, 'AUTHORIZATION_ALREADY_CONSUMED', consumptionRecord.commit ?? 'UNKNOWN');

  // At PRE_COMMIT the staged set must equal the approved manifest exactly —
  // this is what makes `git add .` / `git add -A` detectable rather than merely
  // forbidden by convention.
  if (phase === PHASE_PRE_COMMIT && haveRequest) {
    const approved = new Set((request.manifest || []).map((e) => e?.path));
    const staged = new Set(Array.isArray(observed.stagedPaths) ? observed.stagedPaths : []);
    for (const path of staged) if (!approved.has(path)) push(findings, 'STAGED_PATH_NOT_APPROVED', path);
    for (const path of approved) if (!staged.has(path)) push(findings, 'APPROVED_PATH_NOT_STAGED', path);
  }

  const decision = findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED';
  return {
    decision,
    phase,
    findings,
    permittedOperations: decision === 'AUTHORIZED' ? [...authorization.authorizedOperations] : [],
    commitPlan: decision === 'AUTHORIZED' ? buildCommitPlan(request) : null
  };
}

/**
 * The only Git command lines a release mission may run. Pathspecs are explicit
 * and enumerated; there is no `.`, no `-A`, no `-a`, and no push. A mission that
 * runs anything else is not executing this plan.
 */
export function buildCommitPlan(request) {
  const content = (request.manifest || []).filter((e) => e.stageAction === 'STAGE_CONTENT').map((e) => e.path).sort();
  const deletions = (request.manifest || []).filter((e) => e.stageAction === 'STAGE_DELETION').map((e) => e.path).sort();
  const commands = [];
  if (content.length) commands.push(['git', 'add', '--', ...content]);
  if (deletions.length) commands.push(['git', 'add', '--', ...deletions]);
  commands.push(['git', 'commit', '-m', request.commitMessage]);
  return {
    baseCommit: request.baseCommit,
    branch: request.branch,
    stagePathCount: content.length + deletions.length,
    commands,
    pushCommand: null,
    pushAllowed: false
  };
}
