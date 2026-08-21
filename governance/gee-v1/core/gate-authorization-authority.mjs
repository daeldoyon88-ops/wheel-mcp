/**
 * GEE V1 core — GATE_AUTHORIZATION_AUTHORITY.
 *
 * Authorizes EXACTLY ONE normal Gate transition:
 *
 *     NOT_STARTED --(AUTHORIZATION)--> AUTHORIZED_NOT_STARTED
 *
 * plus the creation of that Gate's FIRST sealed canonical state revision (R0001).
 *
 * What this primitive deliberately does NOT do, at any schema version:
 *   - it does not authorize START (AUTHORIZED_NOT_STARTED -> IN_PROGRESS);
 *   - it does not authorize execution of the Gate's contract;
 *   - it does not authorize closure, external confirmation or COMPLETE_CONFIRMED;
 *   - it does not authorize a second ledger event, another Gate, or a GEE revision.
 *
 * Those privileges are not "checked and refused" — they are STRUCTURALLY
 * UNREPRESENTABLE. `purpose`, `transitionType`, `fromStatus` and `toStatus` are
 * hard constants; `maxUse` is 1; `executionAuthorized` is a literal `false` that
 * no document may set. A forged authority that names START is rejected by the
 * closed-world shape check before any decision is reached.
 *
 * Non-circularity, exactly as in core/release-authority.mjs: the agent may author
 * the GATE_AUTHORIZATION_RECORD and the GATE_AUTHORIZATION_AUTHORITY_REQUEST —
 * both are factual, non-authoritative descriptions. The agent may NOT author the
 * ACTIVE_GATE_AUTHORIZATION_AUTHORITY: it is signed with an owner key whose
 * private half never enters the governed set.
 *
 * Project-agnostic: this module knows `gateId` only as an opaque work-unit id.
 * It contains no specific Gate literal, no Wheel fact, and no filesystem access. Callers
 * supply observed facts; this module only applies the rules. Fail-closed
 * everywhere: absence, malformation, unknown fields and drift all produce BLOCKED.
 *
 * ACYCLIC CONSTRUCTION. The record is written BEFORE the ledger event, and the
 * owner authority is signed AFTER the derived artifacts are regenerated. Neither
 * document may therefore cite the other's bytes. They are joined by a third,
 * recomputable value — the binding digest — exactly as the historical
 * reconciliation primitive joins a record to an owner approval through a cohort
 * digest. The validator never reads a claimed relationship; it recomputes one.
 */

import { canonicalize, sha256Hex, verifyOwnerSignature, authorizationSigningPayload } from './release-authority.mjs';
import { IMMUTABLE_VERSIONED_ARTIFACT, MUTABLE_PROJECTION } from './artifact-classification.mjs';
import { SUCCESSOR_CLOSURE_STATUSES } from './successor-closure.mjs';
import {
  LEGACY_SIGNED_AUTHORITY_MODE,
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  resolveAuthorityMode,
  validateAuthorityMode
} from './post-freeze-maintenance-authority.mjs';

export { canonicalize, sha256Hex, verifyOwnerSignature, authorizationSigningPayload };

export const GATE_AUTHORIZATION_SCHEMA_VERSION = 1;

export const GATE_AUTHORIZATION_RECORD_KIND = 'GATE_AUTHORIZATION_RECORD';
export const GATE_AUTHORIZATION_REQUEST_KIND = 'GATE_AUTHORIZATION_AUTHORITY_REQUEST';
export const GATE_AUTHORIZATION_AUTHORITY_KIND = 'ACTIVE_GATE_AUTHORIZATION_AUTHORITY';

/** The one purpose this authority kind may ever carry. */
export const GATE_AUTHORIZATION_PURPOSE = 'GATE_NORMAL_AUTHORIZATION';

/** The one transition it may ever authorize. */
export const GATE_AUTHORIZATION_TRANSITION_TYPE = 'AUTHORIZATION';
export const GATE_AUTHORIZATION_FROM_STATUS = 'NOT_STARTED';
export const GATE_AUTHORIZATION_TO_STATUS = 'AUTHORIZED_NOT_STARTED';

export const GATE_AUTHORIZATION_MAX_USE = 1;
export const GATE_AUTHORIZATION_SIGNATURE_ALGORITHM = 'ed25519';
export const GATE_AUTHORIZATION_LOCAL_REQUEST_DIGEST_ALGORITHM = 'SHA256_CANONICAL_JSON_GATE_AUTHORIZATION_LOCAL_REQUEST_V1';

/** The Gate's FIRST sealed canonical revision. An authorization never creates R0002+. */
export const GATE_AUTHORIZATION_FIRST_REVISION = 'R0001';

/**
 * Privileges that must be explicitly disclaimed by every request and record.
 * Listing them is not what makes them impossible — the closed-world shape does —
 * but an authority document that cannot even NAME the boundary it respects is
 * not a document a reviewer can audit.
 */
export const GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS = Object.freeze([
  'START',
  'GATE_EXECUTION',
  'AGENT_CLOSURE',
  'EXTERNAL_CONFIRMATION',
  'COMPLETE_CONFIRMED',
  'ARBITRARY_LEDGER_TRANSITION',
  'LEDGER_REWRITE',
  'GIT_PUSH',
  'ARBITRARY_GOVERNANCE_WRITE',
  'OTHER_GATE',
  'GEE_REVISION_CREATION'
]);

/**
 * Terminal predecessor statuses that may satisfy an immediate dependency.
 *
 * RE-EXPORTED, never restated. This constant used to carry its own copy of the
 * list, and the copy included COMPLETE_AGENT. Existing importers keep the name
 * they already use; what they get is now the single canonical rule.
 */
export const GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES = SUCCESSOR_CLOSURE_STATUSES;

// --------------------------------------------------------------------------
// Canonical cohorts. Generic over gateId; no Gate literal anywhere.
// --------------------------------------------------------------------------

/**
 * The Gate's own first sealed state revision. Three of these four files are
 * IMMUTABLE once sealed, so their bytes are pinned permanently by the ledger.
 * CURRENT_STATE is not one of them — see the role classification below.
 */
export const GATE_AUTHORIZATION_STATE_COHORT_ROLES = Object.freeze([
  'CURRENT_STATE', 'CHECKPOINT', 'OPEN_DEFECTS', 'STATE_SEAL'
]);

/**
 * WHAT EACH STATE-COHORT ROLE *IS*, in MODEL D terms. Not a new opinion: this
 * states, in one place, the classification the rest of the system already acts
 * on, so that consumers stop rediscovering it — inconsistently — one at a time.
 *
 * CHECKPOINT / OPEN_DEFECTS / STATE_SEAL are pinned at a REVISION-SCOPED path
 * (`state/revisions/R0001/...`). A revision never changes, so neither may they.
 * Their authorization-time digest is a permanent obligation, and the ledger
 * validator enforces exactly that.
 *
 * CURRENT_STATE is pinned at a REVISION-INDEPENDENT path (`state/CURRENT_STATE`).
 * It is the pointer that SAYS which revision is current, so advancing it is its
 * job, not its corruption. `validate-status-ledger` already encodes this
 * precisely: the exact-byte comparison against the authorization pin is skipped
 * for `cohortRole === 'CURRENT_STATE'`, and the pin is re-imposed only while the
 * pointer still names the authorization-time revision
 * (GATE_AUTHORIZATION_CURRENT_STATE_R0001_BYTES_CHANGED). Once it has advanced,
 * the pointer is proved through its TARGET'S LINEAGE instead — which is the only
 * ground MODEL D permits a MUTABLE_PROJECTION to terminate on.
 *
 * The consequence any consumer must respect: an authorization-time CURRENT_STATE
 * digest is an INITIAL-STATE binding, never a permanent terminal publication
 * root. Treating it as the latter is what MODEL D names
 * MUTABLE_PROJECTION_PERMANENTLY_BYTE_PINNED — it freezes something the
 * architecture defines as movable.
 */
export const GATE_AUTHORIZATION_STATE_COHORT_ROLE_CLASSES = Object.freeze({
  CURRENT_STATE: MUTABLE_PROJECTION,
  CHECKPOINT: IMMUTABLE_VERSIONED_ARTIFACT,
  OPEN_DEFECTS: IMMUTABLE_VERSIONED_ARTIFACT,
  STATE_SEAL: IMMUTABLE_VERSIONED_ARTIFACT
});

/**
 * The MODEL D class of one state-cohort role, or null for a role this module
 * does not classify.
 *
 * Null is deliberately NOT a synonym for "mutable". A caller relaxing an
 * obligation must do so only on a POSITIVE classification, so that an
 * unrecognised role keeps the strict treatment rather than inheriting the
 * loosest one by accident.
 */
export function gateAuthorizationStateCohortRoleClass(cohortRole) {
  return Object.hasOwn(GATE_AUTHORIZATION_STATE_COHORT_ROLE_CLASSES, cohortRole)
    ? GATE_AUTHORIZATION_STATE_COHORT_ROLE_CLASSES[cohortRole]
    : null;
}

/**
 * Ledger-derived generated views (OWNER DECISION A). The AUTHORIZATION ledger
 * append changes canonical ledger-derived state, so leaving these stale would
 * immediately create generated-state drift. They are authorized as an exact,
 * closed path cohort — never as a `governance/**` wildcard.
 */
export const GATE_AUTHORIZATION_DERIVED_COHORT_ROLES = Object.freeze([
  'GATE_STATUS_SNAPSHOT', 'ACTIVE_GATE', 'ACTIVE_GATE_CONTEXT_JSON', 'ACTIVE_GATE_CONTEXT_MD'
]);

/** The governance authority subtree under which authorization documents live. */
export const GATE_AUTHORIZATION_AUTHORITY_ROOT = 'governance/authority/authorizations';

export function gateAuthorizationStateCohortPaths(gateId) {
  const base = `governance/gates/${gateId}/state`;
  const revision = `${base}/revisions/${GATE_AUTHORIZATION_FIRST_REVISION}`;
  return Object.freeze({
    CURRENT_STATE: `${base}/CURRENT_STATE.json`,
    CHECKPOINT: `${revision}/CHECKPOINT.json`,
    OPEN_DEFECTS: `${revision}/OPEN_DEFECTS.json`,
    STATE_SEAL: `${revision}/STATE_SEAL.json`
  });
}

/** Gate-independent by construction: these are whole-project derived views. */
export function gateAuthorizationDerivedCohortPaths() {
  return Object.freeze({
    GATE_STATUS_SNAPSHOT: 'governance/state/generated/GATE_STATUS_SNAPSHOT.json',
    ACTIVE_GATE: 'governance/active/ACTIVE_GATE.json',
    ACTIVE_GATE_CONTEXT_JSON: 'governance/generated/ACTIVE_GATE_CONTEXT.json',
    ACTIVE_GATE_CONTEXT_MD: 'governance/generated/ACTIVE_GATE_CONTEXT.md'
  });
}

export function gateAuthorizationRecordPath(gateId) {
  return `${GATE_AUTHORIZATION_AUTHORITY_ROOT}/${gateId}/GATE_AUTHORIZATION_RECORD.json`;
}

export function gateAuthorizationAuthoritySnapshotPath(gateId) {
  return `${GATE_AUTHORIZATION_AUTHORITY_ROOT}/${gateId}/PROJECT_OWNER_GATE_AUTHORIZATION_AUTHORITY.json`;
}

// --------------------------------------------------------------------------
// Closed-world field sets.
// --------------------------------------------------------------------------

export const GATE_AUTHORIZATION_RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'authorityMode', 'document', 'authorizationId', 'projectId', 'gateId', 'purpose',
  'transitionType', 'fromStatus', 'toStatus', 'recordedAt', 'baseCommit',
  'preLedgerSha256', 'previousEventSha256', 'contractSha256', 'currentContractSha256',
  'dependencyProof', 'stateRevision', 'authorizedStateArtifacts', 'authorizedDerivedArtifacts',
  'prohibitedOperations', 'executionAuthorized', 'reason'
]);

export const GATE_AUTHORIZATION_REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'authorityMode', 'documentKind', 'requestId', 'projectId', 'gateId', 'purpose',
  'transitionType', 'fromStatus', 'toStatus', 'baseCommit', 'preLedgerSha256',
  'previousEventSha256', 'contractSha256', 'currentContractSha256', 'dependencyProof',
  'stateRevision', 'authorizedStateArtifacts', 'authorizedDerivedArtifacts',
  'bindingDigestAlgorithm', 'bindingDigest', 'prohibitedOperations', 'executionAuthorized',
  'expiresAtUtc', 'maxUse', 'requestDigest'
]);

export const GATE_AUTHORIZATION_AUTHORITY_FIELDS = Object.freeze([
  'schemaVersion', 'authorityMode', 'documentKind', 'authorityId', 'issuedBy', 'issuedAtUtc', 'expiresAtUtc',
  'projectId', 'gateId', 'purpose', 'transitionType', 'fromStatus', 'toStatus',
  'baseCommit', 'preLedgerSha256', 'previousEventSha256', 'contractSha256',
  'currentContractSha256', 'dependencyProof', 'stateRevision',
  'authorizedStateArtifacts', 'authorizedDerivedArtifacts',
  'bindingDigestAlgorithm', 'approvedBindingDigest', 'approvedRequestDigest',
  'executionAuthorized', 'maxUse', 'ownerKeyId', 'signatureAlgorithm', 'signature'
]);

const ARTIFACT_FIELDS = Object.freeze(['cohortRole', 'repoRelativePath', 'sha256', 'byteLength']);

/**
 * The RECORD declares derived artifacts by PATH ONLY, and this is forced by the
 * acyclic construction order rather than chosen for convenience.
 *
 * The record is written and then pinned by the AUTHORIZATION ledger event. The
 * four derived views are regenerated AFTER that event, because regenerating them
 * is precisely what consumes the new ledger state. At the moment the record's
 * bytes are frozen, the post-authorization derived bytes do not exist yet, so a
 * record that claimed to know their hashes would be claiming to know the future.
 *
 * The owner authority is signed last, so it CAN and does carry the full
 * post-authorization derived hashes. Result: the ledger permanently pins which
 * derived paths were authorized, and the owner authority permanently records
 * what those paths contained at authorization time.
 */
const RECORD_DERIVED_ARTIFACT_FIELDS = Object.freeze(['cohortRole', 'repoRelativePath']);

const DEPENDENCY_PROOF_FIELDS = Object.freeze(['gateId', 'status', 'authorityPath', 'authoritySha256']);

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

// --------------------------------------------------------------------------
// SHA256_CANONICAL_JSON_GATE_AUTHORIZATION_BINDING_V1
// --------------------------------------------------------------------------

export const GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM = 'SHA256_CANONICAL_JSON_GATE_AUTHORIZATION_BINDING_V1';

/** Transition-identity fields that take part in the binding, in fixed order. */
export const GATE_AUTHORIZATION_BINDING_IDENTITY_FIELDS = Object.freeze([
  'projectId', 'gateId', 'purpose', 'transitionType', 'fromStatus', 'toStatus',
  'recordedAt', 'baseCommit', 'preLedgerSha256', 'previousEventSha256', 'contractSha256',
  'currentContractSha256', 'stateRevision'
]);

/** Per-artifact projection used by the binding digest, for both cohorts. */
export const GATE_AUTHORIZATION_BINDING_DIGEST_FIELDS = ARTIFACT_FIELDS;

/** Per-artifact projection of the RECORD's derived cohort (path-only; see above). */
export const GATE_AUTHORIZATION_RECORD_DERIVED_FIELDS = RECORD_DERIVED_ARTIFACT_FIELDS;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Exact, portable, normalization-safe repository-relative path. No wildcards. */
export function isExactGovernedRelativePath(value) {
  if (!isNonEmptyString(value) || value.normalize('NFC') !== value) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes('*') || value.includes('?')) return false;
  return !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function projectArtifact(item, fields = ARTIFACT_FIELDS) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  // Closed-world at the item level too: a path-only derived entry that smuggles in
  // extra fields is malformed, not "path-only plus harmless extras".
  for (const key of Object.keys(item)) if (!fields.includes(key)) return null;
  const projection = {};
  for (const field of fields) {
    const value = item[field];
    if (field === 'byteLength') {
      if (!Number.isInteger(value) || value < 0) return null;
    } else if (field === 'repoRelativePath') {
      if (!isExactGovernedRelativePath(value)) return null;
    } else if (field === 'sha256') {
      if (!isNonEmptyString(value) || !SHA256_RE.test(value)) return null;
    } else if (!isNonEmptyString(value)) {
      return null;
    }
    projection[field] = value;
  }
  return projection;
}

/**
 * Deterministic cohort projection: project, canonicalize, sort by UTF-16 code
 * unit (locale-independent — never localeCompare), reject duplicates.
 */
function projectCohort(cohort, fields = ARTIFACT_FIELDS) {
  if (!Array.isArray(cohort) || cohort.length === 0) return { entries: null, reason: 'EMPTY_OR_NOT_AN_ARRAY' };
  const rows = [];
  for (const item of cohort) {
    const projection = projectArtifact(item, fields);
    if (projection === null) return { entries: null, reason: 'MALFORMED_COHORT_ITEM' };
    rows.push({ projection, serialized: canonicalize(projection) });
  }
  rows.sort((a, b) => (a.serialized < b.serialized ? -1 : a.serialized > b.serialized ? 1 : 0));
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].serialized === rows[i - 1].serialized) return { entries: null, reason: 'DUPLICATE_COHORT_ENTRY' };
  }
  return { entries: rows.map((row) => row.projection), reason: null };
}

/**
 * SHA256_CANONICAL_JSON_GATE_AUTHORIZATION_BINDING_V1 — the deterministic
 * identity of one Gate authorization.
 *
 * Canonicalization, exactly:
 *   1. project the transition identity onto GATE_AUTHORIZATION_BINDING_IDENTITY_FIELDS;
 *   2. project the dependency proof onto {gateId, status, authorityPath, authoritySha256};
 *   3. project every state-cohort and derived-cohort artifact onto
 *      {cohortRole, repoRelativePath, sha256, byteLength};
 *   4. canonicalize each artifact projection, sort those serializations by UTF-16
 *      code unit, and reject any two identical serializations;
 *   5. digest = SHA-256 over the UTF-8 bytes of the canonical JSON of
 *      { algorithm, ...identity, dependencyProof, stateArtifacts, derivedArtifacts }.
 *
 * Consequences, all intended: cohort iteration order does not change identity,
 * while any change of gate, base commit, pre-ledger SHA, chain head, contract
 * hash, dependency, governed path, byte length or content hash does.
 *
 * @returns {{ digest: string|null, reason: string|null }}
 */
export function computeGateAuthorizationBindingDigest(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    return { digest: null, reason: 'MALFORMED_BINDING' };
  }
  const identity = {};
  for (const field of GATE_AUTHORIZATION_BINDING_IDENTITY_FIELDS) {
    const value = binding[field];
    if (!isNonEmptyString(value)) return { digest: null, reason: `MALFORMED_IDENTITY_FIELD:${field}` };
    identity[field] = value;
  }
  if (Object.hasOwn(binding, 'authorityMode')) {
    if (![LEGACY_SIGNED_AUTHORITY_MODE, POST_FREEZE_MAINTENANCE_AUTHORITY_MODE].includes(binding.authorityMode)) {
      return { digest: null, reason: 'MALFORMED_AUTHORITY_MODE' };
    }
    identity.authorityMode = binding.authorityMode;
  }
  const proof = binding.dependencyProof;
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) {
    return { digest: null, reason: 'MALFORMED_DEPENDENCY_PROOF' };
  }
  const dependencyProof = {};
  for (const field of DEPENDENCY_PROOF_FIELDS) {
    if (!isNonEmptyString(proof[field])) return { digest: null, reason: `MALFORMED_DEPENDENCY_PROOF:${field}` };
    dependencyProof[field] = proof[field];
  }
  const state = projectCohort(binding.stateArtifacts);
  if (state.entries === null) return { digest: null, reason: `STATE_COHORT_${state.reason}` };
  const derived = projectCohort(binding.derivedArtifacts);
  if (derived.entries === null) return { digest: null, reason: `DERIVED_COHORT_${derived.reason}` };

  return {
    digest: sha256Hex(canonicalize({
      algorithm: GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
      ...identity,
      dependencyProof,
      stateArtifacts: state.entries,
      derivedArtifacts: derived.entries
    })),
    reason: null
  };
}

/** Digest of the whole request EXCEPT its own `requestDigest` field. */
export function computeGateAuthorizationRequestDigest(request) {
  const { requestDigest, ...unsigned } = request || {};
  return sha256Hex(canonicalize(unsigned));
}

// --------------------------------------------------------------------------
// Shape validation (closed-world).
// --------------------------------------------------------------------------

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function unknownFields(value, allowed, findings, code) {
  for (const key of Object.keys(value || {})) if (!allowed.includes(key)) finding(findings, code, key);
}

function validateDependencyProofShape(proof, findings, code) {
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) {
    finding(findings, 'DEPENDENCY_PROOF_MISSING');
    return;
  }
  unknownFields(proof, DEPENDENCY_PROOF_FIELDS, findings, code);
  if (!isNonEmptyString(proof.gateId)) finding(findings, 'DEPENDENCY_GATE_INVALID', proof.gateId);
  if (!GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES.includes(proof.status)) finding(findings, 'DEPENDENCY_NOT_TERMINAL', proof.status);
  if (!isNonEmptyString(proof.authorityPath)) finding(findings, 'DEPENDENCY_AUTHORITY_PATH_INVALID', proof.authorityPath);
  if (!isNonEmptyString(proof.authoritySha256) || !SHA256_RE.test(proof.authoritySha256)) finding(findings, 'DEPENDENCY_AUTHORITY_SHA_INVALID');
}

/**
 * Cohort shape + EXACT path template enforcement. This is where "extra state
 * path", "cross-Gate path", "GEE R8 path" and "governance/** wildcard" all die:
 * the cohort must be exactly the expected roles, each at exactly the expected
 * path for THIS gate. Nothing is matched by prefix or glob.
 */
function validateCohortShape(cohort, expectedRoles, expectedPaths, findings, kind, fields = ARTIFACT_FIELDS) {
  if (!Array.isArray(cohort) || cohort.length !== expectedRoles.length) {
    finding(findings, `${kind}_COHORT_INVALID`, Array.isArray(cohort) ? cohort.length : typeof cohort);
    return;
  }
  const seenRoles = new Set();
  const seenPaths = new Set();
  for (const item of cohort) {
    if (projectArtifact(item, fields) === null) {
      finding(findings, `${kind}_ARTIFACT_MALFORMED`, item?.repoRelativePath ?? item?.cohortRole);
      continue;
    }
    if (!expectedRoles.includes(item.cohortRole)) {
      finding(findings, `${kind}_COHORT_ROLE_UNKNOWN`, item.cohortRole);
      continue;
    }
    if (seenRoles.has(item.cohortRole)) finding(findings, `${kind}_COHORT_ROLE_DUPLICATE`, item.cohortRole);
    seenRoles.add(item.cohortRole);
    if (seenPaths.has(item.repoRelativePath)) finding(findings, `${kind}_COHORT_PATH_DUPLICATE`, item.repoRelativePath);
    seenPaths.add(item.repoRelativePath);
    const expected = expectedPaths[item.cohortRole];
    if (item.repoRelativePath !== expected) {
      finding(findings, `${kind}_COHORT_PATH_NOT_AUTHORIZED`, `${item.cohortRole}:${item.repoRelativePath}`);
    }
  }
  for (const role of expectedRoles) if (!seenRoles.has(role)) finding(findings, `${kind}_COHORT_ROLE_MISSING`, role);
}

/**
 * Fields shared by the record, the request and the owner authority. Enforcing
 * them once, identically, is what makes "authority used for START" and
 * "transition borrowed" impossible in all three documents at the same time.
 */
function validateSharedBinding(document, findings, { requireGateId = true, derivedFields = ARTIFACT_FIELDS } = {}) {
  if (document.schemaVersion !== GATE_AUTHORIZATION_SCHEMA_VERSION) finding(findings, 'SCHEMA_VERSION_INVALID', document.schemaVersion);
  if (!isNonEmptyString(document.projectId)) finding(findings, 'PROJECT_ID_INVALID', document.projectId);
  if (requireGateId && !isNonEmptyString(document.gateId)) finding(findings, 'GATE_ID_INVALID', document.gateId);
  if (document.purpose !== GATE_AUTHORIZATION_PURPOSE) finding(findings, 'PURPOSE_INVALID', document.purpose);
  // The three constants that make START and execution unrepresentable.
  if (document.transitionType !== GATE_AUTHORIZATION_TRANSITION_TYPE) finding(findings, 'TRANSITION_TYPE_INVALID', document.transitionType);
  if (document.fromStatus !== GATE_AUTHORIZATION_FROM_STATUS) finding(findings, 'FROM_STATUS_INVALID', document.fromStatus);
  if (document.toStatus !== GATE_AUTHORIZATION_TO_STATUS) finding(findings, 'TO_STATUS_INVALID', document.toStatus);
  if (document.executionAuthorized !== false) finding(findings, 'EXECUTION_PRIVILEGE_CLAIMED', document.executionAuthorized);
  if (Object.hasOwn(document, 'authorityMode') && ![LEGACY_SIGNED_AUTHORITY_MODE, POST_FREEZE_MAINTENANCE_AUTHORITY_MODE].includes(document.authorityMode)) {
    finding(findings, 'AUTHORITY_MODE_INVALID', document.authorityMode);
  }
  if (document.stateRevision !== GATE_AUTHORIZATION_FIRST_REVISION) finding(findings, 'STATE_REVISION_INVALID', document.stateRevision);
  if (!isNonEmptyString(document.baseCommit) || !COMMIT_RE.test(document.baseCommit)) finding(findings, 'BASE_COMMIT_INVALID', document.baseCommit);
  if (!isNonEmptyString(document.preLedgerSha256) || !SHA256_RE.test(document.preLedgerSha256)) finding(findings, 'PRE_LEDGER_SHA_INVALID');
  if (!isNonEmptyString(document.previousEventSha256) || !SHA256_RE.test(document.previousEventSha256)) finding(findings, 'PREVIOUS_EVENT_SHA_INVALID');
  if (!isNonEmptyString(document.contractSha256) || !SHA256_RE.test(document.contractSha256)) finding(findings, 'CONTRACT_SHA_INVALID');
  if (!isNonEmptyString(document.currentContractSha256) || !SHA256_RE.test(document.currentContractSha256)) finding(findings, 'CURRENT_CONTRACT_SHA_INVALID');
  validateDependencyProofShape(document.dependencyProof, findings, 'DEPENDENCY_PROOF_UNKNOWN_FIELD');
  if (isNonEmptyString(document.gateId)) {
    validateCohortShape(document.authorizedStateArtifacts, GATE_AUTHORIZATION_STATE_COHORT_ROLES, gateAuthorizationStateCohortPaths(document.gateId), findings, 'STATE');
    validateCohortShape(document.authorizedDerivedArtifacts, GATE_AUTHORIZATION_DERIVED_COHORT_ROLES, gateAuthorizationDerivedCohortPaths(), findings, 'DERIVED', derivedFields);
  }
}

export function validateGateAuthorizationRecordShape(record) {
  const findings = [];
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    finding(findings, 'RECORD_ABSENT');
    return { valid: false, findings };
  }
  unknownFields(record, GATE_AUTHORIZATION_RECORD_FIELDS, findings, 'RECORD_UNKNOWN_FIELD');
  for (const field of GATE_AUTHORIZATION_RECORD_FIELDS) {
    if (field !== 'authorityMode' && !Object.prototype.hasOwnProperty.call(record, field)) finding(findings, 'RECORD_FIELD_MISSING', field);
  }
  if (record.document !== GATE_AUTHORIZATION_RECORD_KIND) finding(findings, 'RECORD_KIND_INVALID', record.document);
  const modeResult = validateAuthorityMode(record);
  findings.push(...modeResult.findings);
  if (!isNonEmptyString(record.authorizationId) || !/^GATE_AUTHORIZATION_[A-Z0-9_]{3,64}$/.test(record.authorizationId)) finding(findings, 'AUTHORIZATION_ID_INVALID', record.authorizationId);
  if (!isNonEmptyString(record.recordedAt) || Number.isNaN(Date.parse(record.recordedAt))) finding(findings, 'RECORDED_AT_INVALID', record.recordedAt);
  if (!isNonEmptyString(record.reason) || !record.reason.trim()) finding(findings, 'REASON_INVALID');
  if (!Array.isArray(record.prohibitedOperations) || GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS.some((op) => !record.prohibitedOperations.includes(op))) {
    finding(findings, 'PROHIBITED_SCOPE_INCOMPLETE');
  }
  validateSharedBinding(record, findings, { derivedFields: RECORD_DERIVED_ARTIFACT_FIELDS });
  return { valid: findings.length === 0, findings };
}

export function validateGateAuthorizationRequestShape(request, { recordedAt = null } = {}) {
  const findings = [];
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    finding(findings, 'REQUEST_ABSENT');
    return { valid: false, findings };
  }
  unknownFields(request, GATE_AUTHORIZATION_REQUEST_FIELDS, findings, 'REQUEST_UNKNOWN_FIELD');
  for (const field of GATE_AUTHORIZATION_REQUEST_FIELDS) {
    if (field !== 'authorityMode' && !Object.prototype.hasOwnProperty.call(request, field)) finding(findings, 'REQUEST_FIELD_MISSING', field);
  }
  if (request.documentKind !== GATE_AUTHORIZATION_REQUEST_KIND) finding(findings, 'REQUEST_KIND_INVALID', request.documentKind);
  const modeResult = validateAuthorityMode(request);
  findings.push(...modeResult.findings);
  if (!isNonEmptyString(request.requestId)) finding(findings, 'REQUEST_ID_INVALID', request.requestId);
  if (request.bindingDigestAlgorithm !== GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM) finding(findings, 'BINDING_DIGEST_ALGORITHM_INVALID', request.bindingDigestAlgorithm);
  if (!isNonEmptyString(request.expiresAtUtc) || Number.isNaN(Date.parse(request.expiresAtUtc))) finding(findings, 'EXPIRY_INVALID', request.expiresAtUtc);
  if (request.maxUse !== GATE_AUTHORIZATION_MAX_USE) finding(findings, 'MAX_USE_INVALID', request.maxUse);
  if (!Array.isArray(request.prohibitedOperations) || GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS.some((op) => !request.prohibitedOperations.includes(op))) {
    finding(findings, 'PROHIBITED_SCOPE_INCOMPLETE');
  }
  validateSharedBinding(request, findings);

  // The request never gets to ASSERT its own binding digest: it is recomputed.
  const recomputed = computeGateAuthorizationBindingDigest({
    ...request,
    recordedAt,
    stateArtifacts: request.authorizedStateArtifacts,
    derivedArtifacts: request.authorizedDerivedArtifacts
  });
  if (recomputed.digest === null) finding(findings, 'BINDING_DIGEST_NOT_COMPUTABLE', recomputed.reason);
  else if (request.bindingDigest !== recomputed.digest) finding(findings, 'BINDING_DIGEST_SELF_INCONSISTENT', recomputed.digest);

  if (!isNonEmptyString(request.requestDigest) || !SHA256_RE.test(request.requestDigest)) finding(findings, 'REQUEST_DIGEST_INVALID');
  else if (computeGateAuthorizationRequestDigest(request) !== request.requestDigest) finding(findings, 'REQUEST_DIGEST_SELF_INCONSISTENT');
  return { valid: findings.length === 0, findings };
}

export function validateGateAuthorizationAuthorityShape(authority, { recordedAt = null } = {}) {
  const findings = [];
  if (authority === null || typeof authority !== 'object' || Array.isArray(authority)) {
    finding(findings, 'AUTHORITY_ABSENT');
    return { valid: false, findings };
  }
  unknownFields(authority, GATE_AUTHORIZATION_AUTHORITY_FIELDS, findings, 'AUTHORITY_UNKNOWN_FIELD');
  for (const field of GATE_AUTHORIZATION_AUTHORITY_FIELDS) {
    if (!['authorityMode', 'ownerKeyId', 'signatureAlgorithm', 'signature'].includes(field)
        && !Object.prototype.hasOwnProperty.call(authority, field)) finding(findings, 'AUTHORITY_FIELD_MISSING', field);
  }
  if (authority.documentKind !== GATE_AUTHORIZATION_AUTHORITY_KIND) finding(findings, 'AUTHORITY_KIND_INVALID', authority.documentKind);
  const modeResult = validateAuthorityMode(authority, {
    requireLegacySignature: true,
    defaultLegacy: true
  });
  findings.push(...modeResult.findings);
  if (!isNonEmptyString(authority.authorityId)) finding(findings, 'AUTHORITY_ID_INVALID', authority.authorityId);
  if (authority.issuedBy !== 'PROJECT_OWNER') finding(findings, 'AUTHORITY_ISSUER_INVALID', authority.issuedBy);
  if (!isNonEmptyString(authority.issuedAtUtc) || Number.isNaN(Date.parse(authority.issuedAtUtc))) finding(findings, 'ISSUED_AT_INVALID', authority.issuedAtUtc);
  if (!isNonEmptyString(authority.expiresAtUtc) || Number.isNaN(Date.parse(authority.expiresAtUtc))) finding(findings, 'EXPIRY_INVALID', authority.expiresAtUtc);
  if (authority.bindingDigestAlgorithm !== GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM) finding(findings, 'BINDING_DIGEST_ALGORITHM_INVALID', authority.bindingDigestAlgorithm);
  if (!isNonEmptyString(authority.approvedBindingDigest) || !SHA256_RE.test(authority.approvedBindingDigest)) finding(findings, 'APPROVED_BINDING_DIGEST_INVALID');
  if (!isNonEmptyString(authority.approvedRequestDigest) || !SHA256_RE.test(authority.approvedRequestDigest)) finding(findings, 'APPROVED_REQUEST_DIGEST_INVALID');
  if (authority.maxUse !== GATE_AUTHORIZATION_MAX_USE) finding(findings, 'MAX_USE_INVALID', authority.maxUse);
  if (modeResult.mode === LEGACY_SIGNED_AUTHORITY_MODE) {
    if (!isNonEmptyString(authority.ownerKeyId)) finding(findings, 'OWNER_KEY_ID_INVALID', authority.ownerKeyId);
    if (authority.signatureAlgorithm !== GATE_AUTHORIZATION_SIGNATURE_ALGORITHM) finding(findings, 'SIGNATURE_ALGORITHM_UNSUPPORTED', authority.signatureAlgorithm);
    if (!isNonEmptyString(authority.signature)) finding(findings, 'OWNER_SIGNATURE_MISSING');
  }
  validateSharedBinding(authority, findings);

  // The owner signed a digest, not a description: it must reproduce the cohort
  // the authority itself carries, or the two halves disagree about what was approved.
  const recomputed = computeGateAuthorizationBindingDigest({
    ...authority,
    recordedAt,
    stateArtifacts: authority.authorizedStateArtifacts,
    derivedArtifacts: authority.authorizedDerivedArtifacts
  });
  if (recomputed.digest === null) finding(findings, 'BINDING_DIGEST_NOT_COMPUTABLE', recomputed.reason);
  else if (authority.approvedBindingDigest !== recomputed.digest) finding(findings, 'APPROVED_BINDING_DIGEST_SELF_INCONSISTENT', recomputed.digest);
  if (modeResult.mode === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE
      && authority.approvedRequestDigest !== computeGateAuthorizationLocalRequestDigest(authority)) {
    finding(findings, 'LOCAL_REQUEST_DIGEST_SELF_INCONSISTENT');
  }
  return { valid: findings.length === 0, findings };
}

/** Digest of the exact local authority projection; no external request or key is needed. */
export function computeGateAuthorizationLocalRequestDigest(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
  const fields = [
    'projectId', 'gateId', 'purpose', 'transitionType', 'fromStatus', 'toStatus',
    'baseCommit', 'preLedgerSha256', 'previousEventSha256', 'contractSha256',
    'currentContractSha256', 'dependencyProof', 'stateRevision',
    'authorizedStateArtifacts', 'authorizedDerivedArtifacts', 'executionAuthorized', 'maxUse'
  ];
  const projection = { algorithm: GATE_AUTHORIZATION_LOCAL_REQUEST_DIGEST_ALGORITHM, authorityMode: authority.authorityMode };
  for (const field of fields) projection[field] = authority[field];
  return sha256Hex(canonicalize(projection));
}

// --------------------------------------------------------------------------
// Cross-document agreement.
// --------------------------------------------------------------------------

/**
 * Identity fields carried directly by record, request and authority.
 * `recordedAt` is deliberately contextual: request and authority approve it
 * through their signed binding digest, while the record carries the one
 * canonical value that permanent ledger validation compares to the event.
 */
const CROSS_DOCUMENT_FIELDS = Object.freeze([
  ...GATE_AUTHORIZATION_BINDING_IDENTITY_FIELDS.filter((field) => field !== 'recordedAt'),
  'executionAuthorized'
]);

/**
 * Comparison projection, deliberately distinct from the closed-world VALIDATION
 * projection above. Validation rejects unknown fields; comparison must instead
 * extract the shared subset from documents that legitimately carry different
 * field sets — the record's derived entries are path-only while the authority's
 * carry hashes, so comparing them under one closed field set would report a
 * mismatch between two documents that agree perfectly.
 */
function cohortComparisonKey(cohort, fields) {
  if (!Array.isArray(cohort)) return null;
  const rows = cohort.map((item) => {
    const row = {};
    for (const field of fields) row[field] = item?.[field];
    return canonicalize(row);
  });
  rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return canonicalize(rows);
}

function sameCohort(left, right, fields = ARTIFACT_FIELDS) {
  const a = cohortComparisonKey(left, fields);
  const b = cohortComparisonKey(right, fields);
  return a !== null && b !== null && a === b;
}

/**
 * @param {object} options.derivedFields  Projection used to compare the derived
 *   cohort. When either side is a RECORD, only paths are comparable — the record
 *   cannot carry post-authorization derived hashes (see RECORD_DERIVED_ARTIFACT_FIELDS).
 */
function compareDocuments(left, right, findings, code, { derivedFields = ARTIFACT_FIELDS } = {}) {
  if (resolveAuthorityMode(left) !== resolveAuthorityMode(right)) finding(findings, code, 'authorityMode');
  for (const field of CROSS_DOCUMENT_FIELDS) {
    if (left[field] !== right[field]) finding(findings, code, field);
  }
  for (const field of DEPENDENCY_PROOF_FIELDS) {
    if (left.dependencyProof?.[field] !== right.dependencyProof?.[field]) finding(findings, code, `dependencyProof.${field}`);
  }
  if (!sameCohort(left.authorizedStateArtifacts, right.authorizedStateArtifacts)) finding(findings, code, 'authorizedStateArtifacts');
  if (!sameCohort(left.authorizedDerivedArtifacts, right.authorizedDerivedArtifacts, derivedFields)) finding(findings, code, 'authorizedDerivedArtifacts');
}

// --------------------------------------------------------------------------
// The single decision function.
// --------------------------------------------------------------------------

export const PHASE_AUTHORIZE_APPLY = 'AUTHORIZE_APPLY';
export const PHASE_VERIFY_CONSUMPTION = 'VERIFY_CONSUMPTION';

/**
 * @param {object} input
 * @param {object|null} input.record        GATE_AUTHORIZATION_RECORD (agent-authored, non-authoritative)
 * @param {object|null} input.request       GATE_AUTHORIZATION_AUTHORITY_REQUEST (agent-authored)
 * @param {object|null} input.authority     ACTIVE_GATE_AUTHORIZATION_AUTHORITY (owner-signed, external)
 * @param {string|null} input.loadFinding   loader-reported reason a document is unusable
 * @param {object|null} input.ownerKey      { keyId, publicKeyPem }
 * @param {object} input.observed           live facts read by the caller
 * @param {string} input.phase
 * @param {Date}   [input.now]
 * @returns {{ decision, authorizationAuthorized, executionAuthorized, startAuthorized, findings, authorizedPaths }}
 */
export function evaluateGateAuthorizationAuthority({
  record = null,
  request = null,
  authority = null,
  loadFinding = null,
  ownerKey = null,
  observed = {},
  phase = PHASE_AUTHORIZE_APPLY,
  now = new Date()
} = {}) {
  const findings = [];
  if (loadFinding) finding(findings, loadFinding);
  if (phase !== PHASE_AUTHORIZE_APPLY && phase !== PHASE_VERIFY_CONSUMPTION) finding(findings, 'PHASE_INVALID', phase);

  const recordResult = validateGateAuthorizationRecordShape(record);
  const bindingContext = { recordedAt: record?.recordedAt ?? null };
  const authorityMode = resolveAuthorityMode(authority, { defaultLegacy: false });
  const requestResult = authorityMode === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE && request === null
    ? { valid: true, findings: [] }
    : validateGateAuthorizationRequestShape(request, bindingContext);
  const authorityResult = validateGateAuthorizationAuthorityShape(authority, bindingContext);
  findings.push(...recordResult.findings, ...requestResult.findings, ...authorityResult.findings);

  if (authorityResult.valid) {
    if (authorityMode === POST_FREEZE_MAINTENANCE_AUTHORITY_MODE && request !== null) {
      finding(findings, 'LOCAL_AUTHORITY_REQUEST_NOT_PERMITTED');
    } else if (authorityMode !== POST_FREEZE_MAINTENANCE_AUTHORITY_MODE) {
      const signature = verifyOwnerSignature(authority, ownerKey);
      if (!signature.verified) finding(findings, signature.reason);
    }
    // Wall-clock expiry applies to the pre-write decision only. Permanent ledger
    // re-verification compares expiry against the event's recordedAt instead, so
    // a correctly-issued historical authorization does not rot.
    if (now.getTime() > Date.parse(authority.expiresAtUtc)) finding(findings, 'AUTHORITY_EXPIRED', authority.expiresAtUtc);
  }

  if (requestResult.valid && authorityResult.valid && authorityMode !== POST_FREEZE_MAINTENANCE_AUTHORITY_MODE) {
    if (authority.approvedRequestDigest !== computeGateAuthorizationRequestDigest(request)) finding(findings, 'REQUEST_DIGEST_MISMATCH');
    if (authority.approvedBindingDigest !== request.bindingDigest) finding(findings, 'BINDING_DIGEST_MISMATCH');
    if (authority.expiresAtUtc !== request.expiresAtUtc) finding(findings, 'AUTHORITY_REQUEST_BINDING_MISMATCH', 'expiresAtUtc');
    if (authority.maxUse !== request.maxUse) finding(findings, 'AUTHORITY_REQUEST_BINDING_MISMATCH', 'maxUse');
    compareDocuments(authority, request, findings, 'AUTHORITY_REQUEST_BINDING_MISMATCH');
  }
  if (recordResult.valid && authorityResult.valid) {
    compareDocuments(authority, record, findings, 'AUTHORITY_RECORD_BINDING_MISMATCH', { derivedFields: RECORD_DERIVED_ARTIFACT_FIELDS });
  }

  // --- live re-verification ------------------------------------------------
  if (recordResult.valid) {
    if (observed.projectId !== record.projectId) finding(findings, 'PROJECT_ID_MISMATCH', observed.projectId);
    if (observed.gateId !== record.gateId) finding(findings, 'GATE_ID_MISMATCH', observed.gateId);
    if (observed.headCommit !== record.baseCommit) finding(findings, 'BASE_COMMIT_MISMATCH', observed.headCommit);
    if (observed.preLedgerSha256 !== record.preLedgerSha256) finding(findings, 'PRE_LEDGER_SHA_MISMATCH', observed.preLedgerSha256);
    if (observed.previousEventSha256 !== record.previousEventSha256) finding(findings, 'PREVIOUS_EVENT_SHA_MISMATCH', observed.previousEventSha256);
    if (observed.contractSha256 !== record.contractSha256) finding(findings, 'CONTRACT_SHA_MISMATCH', observed.contractSha256);
    if (observed.currentContractSha256 !== record.currentContractSha256) finding(findings, 'CURRENT_CONTRACT_SHA_MISMATCH', observed.currentContractSha256);
    if (observed.currentContractPresent !== true) finding(findings, 'CURRENT_CONTRACT_ABSENT');
    if (observed.currentStatus !== GATE_AUTHORIZATION_FROM_STATUS) finding(findings, 'CURRENT_STATUS_NOT_NOT_STARTED', observed.currentStatus);

    const proof = observed.dependencyProof;
    if (!proof || DEPENDENCY_PROOF_FIELDS.some((field) => proof[field] !== record.dependencyProof?.[field])) {
      finding(findings, 'DEPENDENCY_PROOF_MISMATCH');
    } else if (!GATE_AUTHORIZATION_TERMINAL_DEPENDENCY_STATUSES.includes(proof.status)) {
      finding(findings, 'DEPENDENCY_NOT_TERMINAL', proof.status);
    }

    // Every approved byte must still be the byte on disk, in BOTH cohorts. State
    // hashes come from the record (pinned by the ledger); derived hashes come from
    // the owner authority, which is the only document written late enough to know
    // the post-authorization derived bytes.
    const byteBoundArtifacts = [
      ...record.authorizedStateArtifacts,
      ...(authorityResult.valid ? authority.authorizedDerivedArtifacts : [])
    ];
    for (const artifact of byteBoundArtifacts) {
      const actual = observed.artifactSha256?.[artifact.repoRelativePath];
      if (actual === undefined || actual === null) finding(findings, 'AUTHORIZED_ARTIFACT_MISSING', artifact.repoRelativePath);
      else if (actual !== artifact.sha256) finding(findings, 'AUTHORIZED_ARTIFACT_BYTES_CHANGED', artifact.repoRelativePath);
      const length = observed.artifactByteLength?.[artifact.repoRelativePath];
      if (length !== undefined && length !== null && length !== artifact.byteLength) {
        finding(findings, 'AUTHORIZED_ARTIFACT_BYTE_LENGTH_CHANGED', artifact.repoRelativePath);
      }
    }
  }

  if (observed.competingAuthorityCount > 1) finding(findings, 'COMPETING_GATE_AUTHORIZATION_AUTHORITIES', observed.competingAuthorityCount);
  if (observed.existingAuthorizationEventCount > 0) finding(findings, 'GATE_ALREADY_AUTHORIZED', observed.existingAuthorizationEventCount);

  if (phase === PHASE_AUTHORIZE_APPLY) {
    if (observed.consumed === true) finding(findings, 'AUTHORITY_ALREADY_CONSUMED');
  } else if (phase === PHASE_VERIFY_CONSUMPTION) {
    if (observed.consumed !== true) finding(findings, 'AUTHORITY_NOT_CONSUMED');
  }

  const decision = findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED';
  return {
    decision,
    authorizationAuthorized: decision === 'AUTHORIZED' && phase === PHASE_AUTHORIZE_APPLY,
    // Structural, not decided: this primitive has no execution or START privilege
    // to grant, so these are literals rather than outcomes.
    executionAuthorized: false,
    startAuthorized: false,
    findings,
    authorizedPaths: decision === 'AUTHORIZED'
      ? [...record.authorizedStateArtifacts, ...record.authorizedDerivedArtifacts]
        .map((a) => a.repoRelativePath)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : []
  };
}
