/**
 * MAINTENANCE PUBLICATION ADMISSION — the independent, causally prior Owner act
 * that decides whether ONE exact maintenance authority may publish at all.
 *
 * THE DEFECT THIS EXISTS FOR, STATED EXACTLY.
 *
 * A schemaVersion-2 maintenance authority proves a great deal about ITSELF: it
 * binds base HEAD, the ledger, the Gate pre-state, an exact manifest digest, a
 * literal path allowlist and maxUse = 1. What it cannot do is prove that anybody
 * other than its own author decided it should exist. Every fact the publisher
 * checks is a fact the authority declares, so the whole chain terminates in the
 * document being judged. Concretely, on this repository:
 *
 *   the GATE20 Repair-B manifest declares its authority, its manifest, the Owner
 *   reservation registry and the ratification it depends on as
 *
 *       prestate: { state: "ABSENT" }
 *
 *   which is a machine-readable claim that the program CREATES, in the same
 *   publication act, the documents that authorize the program. Publication would
 *   have been its own permission slip.
 *
 * WHAT AN ADMISSION IS INSTEAD.
 *
 * A SEPARATE pair of Owner documents, written before the publication and
 * external to the authority being admitted:
 *
 *   OWNER AUTHORIZATION REGISTRY  enumerates WHICH publications the Project Owner
 *                                 has admitted, by identity and by digest
 *   ADMISSION RECORD              pins the exact authority bytes, the exact
 *                                 manifest bytes, the exact pre-state, the Gate,
 *                                 the purpose and the operation classes
 *
 * They bind to each other MUTUALLY: the registry names the record's path and its
 * IDENTITY digest, and the record names the registry's path and its FILE digest.
 * The identity digest excludes the back-reference by construction, so the binding
 * is mutual without being recursive — the same idiom
 * `HISTORICAL_IDENTITY_RESERVATION_OWNER_AUTHORIZATION` already uses, reused here
 * rather than reinvented.
 *
 * WHY THE ADMITTED AUTHORITY CANNOT SELF-ADMIT.
 *
 * The admission names the authority's bytes. An authority that wrote its own
 * admission would have to know its own digest before it existed, and any edit to
 * the authority after admission breaks `admittedAuthority.sha256`. The admission
 * is not derivable from the thing it admits, which is the whole property: the
 * document that admits is not the document being admitted.
 *
 * WHAT AN ADMISSION IS NOT, ASSERTED AS EXPLICIT FALSE FIELDS.
 *
 * It grants no future-byte permission, no Gate authorization, no START, no status
 * transition, no generic V1 admission and no widening of any historical
 * admission. It is not derived from the Git delta and not derived from
 * FINAL_GATE_INTEGRITY findings — those remain independent comparators, never
 * trust roots. Each denial is a required field inside the sealed identity digest,
 * so a copy that quietly flips one fails its own recomputation rather than
 * becoming a broader authority.
 *
 * PATH AUTHORIZED IS STILL NOT CURRENT BYTES AUTHORIZED. An admission admits one
 * publication of one exact candidate lineage against one exact pre-state. A later
 * publication over changed bytes needs a new authority, a new pre-state and a new
 * admission; there is no standing permission anywhere in this document.
 *
 * NO PKI, NO SIGNATURES, NO CLOCK, NO NETWORK, NO GIT. LOCAL_EXPLICIT_AUTHORITY
 * with exhaustive digest binding, exactly as every other Owner document in this
 * project. Reads bytes; writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { sha256Canonical } from '../../tools/canonical-json.mjs';

export const MAINTENANCE_PUBLICATION_ADMISSION_DOCUMENT = 'MAINTENANCE_PUBLICATION_ADMISSION';
export const MAINTENANCE_PUBLICATION_ADMISSION_VERSION = 'R1';

/** The Owner registry that enumerates every admitted publication. */
export const ADMISSION_OWNER_AUTHORIZATION_DOCUMENT = 'MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION';
export const ADMISSION_OWNER_AUTHORIZATION_CLASS = 'PROJECT_OWNER_MAINTENANCE_PUBLICATION_ADMISSION_AUTHORITY';
// Legacy R1 fixture path only.  Resolution always uses the exact path carried
// by the selected admission; this value is never a fallback.
export const ADMISSION_REGISTRY_PATH = 'governance/sources/MAINTENANCE_PUBLICATION_ADMISSION_OWNER_AUTHORIZATION_R1.json';

/** Where per-Gate admission records live, mirroring the historical-bridge layout. */
export const ADMISSION_DIRECTORY = 'governance/authority/publication-admissions';

/** The one purpose an admission may declare. */
export const ADMISSION_PURPOSE = 'MAINTENANCE_PUBLICATION_ADMISSION';

/**
 * The one publisher class an admission may admit.
 *
 * Deliberately equal to `PUBLICATION_CLASS_PATH_PRESTATE_PROGRAM` in
 * maintenance-publication-admissibility.mjs, and deliberately NOT imported from
 * it: that module consumes this one, and a back-import would close a cycle. The
 * seam re-checks the equality against its own constant, so a divergence is a
 * refusal rather than a silent mismatch.
 */
export const ADMITTED_PUBLICATION_CLASS = 'PATH_PRESTATE_PROGRAM_PUBLISHER';

/** The only maintenance purpose the pre-state publisher governs. */
export const ADMITTED_AUTHORITY_PURPOSE = 'NORMAL_MAINTENANCE';

/** The manifest schema an admission may admit. A V1 manifest needs no admission — it needs a publisher. */
export const ADMITTED_MANIFEST_SCHEMA_VERSION = 2;
export const ADMITTED_AUTHORITY_SCHEMA_VERSION = 2;

/**
 * Every permission an admission MUST deny, explicitly and by name.
 *
 * An omitted field is a refusal, never a default. A record that simply forgot to
 * mention future bytes must not be read as granting them, and must not be read as
 * denying them either — it is malformed, and malformed admits nothing.
 */
export const ADMISSION_DENIED_PERMISSIONS = Object.freeze([
  'grantsFutureBytePermission',
  'grantsGateAuthorizationPermission',
  'grantsStartPermission',
  'grantsStatusTransitionPermission',
  'grantsHistoricalAdmissionWidening',
  'genericV1Admission',
  'derivedFromGitDelta',
  'derivedFromFinalGateIntegrityFindings'
]);

/** Operations an admission must name as prohibited, so a widened copy is self-invalidating. */
export const ADMISSION_REQUIRED_PROHIBITED_OPERATIONS = Object.freeze([
  'START', 'SECOND_START', 'GATE_AUTHORIZATION', 'STATUS_TRANSITION',
  'ACTIVE_GATE_SWITCH', 'GEE_R8', 'GIT_PUSH', 'HISTORY_REWRITE',
  'GENERIC_V1_ADMISSION', 'HISTORICAL_ADMISSION_WIDENING', 'SELF_ADMISSION'
]);

/** The exact pre-state facets an admission pins. Same shape the authority binds. */
export const ADMITTED_PRESTATE_FIELDS = Object.freeze([
  'baseHead', 'ledgerEventCount', 'ledgerPrefixSha256', 'gateId', 'gateStatus',
  'stateRevision', 'contractRevision', 'activeGate', 'R8ExpectedAbsent'
]);

/**
 * THE GOVERNING PATHS OF THIS ADMISSION CHAIN — Control 15's exact protected set.
 *
 * These four, and only these four, are the documents whose existence decides
 * whether the publication is authorized. They must be PRESENT, with exact digests,
 * BEFORE publication begins, and the program may not name any of them as a path it
 * creates. The rule is deliberately not generalized to every governance path:
 * widening it would be a new architecture decision, not this repair.
 */
export const GOVERNING_ROLE_ADMITTED_AUTHORITY = 'ADMITTED_AUTHORITY';
export const GOVERNING_ROLE_ADMITTED_MANIFEST = 'ADMITTED_MANIFEST';
export const GOVERNING_ROLE_ADMISSION_RECORD = 'PUBLICATION_ADMISSION_RECORD';
export const GOVERNING_ROLE_OWNER_AUTHORIZATION = 'OWNER_ADMISSION_AUTHORIZATION';
export const GOVERNING_PATH_ROLES = Object.freeze([
  GOVERNING_ROLE_ADMITTED_AUTHORITY,
  GOVERNING_ROLE_ADMITTED_MANIFEST,
  GOVERNING_ROLE_ADMISSION_RECORD,
  GOVERNING_ROLE_OWNER_AUTHORIZATION
]);

/** The two roles the existing bootstrap self-exclusion already proves PRESENT by construction. */
export const BOOTSTRAP_EXCLUDABLE_GOVERNING_ROLES = Object.freeze([
  GOVERNING_ROLE_ADMITTED_AUTHORITY,
  GOVERNING_ROLE_ADMITTED_MANIFEST
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const GATE_RE = /^GATE[0-9]{2}$/;
const TOKEN_RE = /^[A-Z][A-Z0-9_-]*$/;
const ISO_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;

/** The bound-object roles an admission pins, in a fixed order. */
export const ADMITTED_OBJECT_ROLES = Object.freeze(['admittedAuthority', 'admittedManifest']);

/**
 * The complete field set of each document, enforced at runtime AND in the JSON
 * schema. Kept identical on purpose: if runtime validation accepted a field the
 * schema rejected, or the reverse, then "schema-valid" and "trusted" would be two
 * different properties and an unknown field could carry a claim nobody checks.
 */
export const ADMISSION_FIELDS = Object.freeze([
  'documentKind', 'schemaVersion', 'authorityMode', 'issuedBy', 'admissionId', 'decisionId',
  'issuedAtUtc', 'expiresAtUtc', 'projectId', 'repositoryId', 'gateId', 'programId',
  'purpose', 'publicationClass', 'authorityPurpose', 'maxUse', 'admissionStatement',
  'admittedAuthority', 'admittedManifest', 'admittedPrestate', 'admittedOperationClasses',
  ...ADMISSION_DENIED_PERMISSIONS, 'prohibitedOperations', 'successorRequirement',
  'admissionDigest', 'ownerAuthorizationPath', 'ownerAuthorizationSha256'
]);

export const ADMISSION_BOUND_OBJECT_FIELDS = Object.freeze(['path', 'sha256', 'byteLength', 'schemaVersion', 'documentId']);

export const ADMISSION_REGISTRY_FIELDS = Object.freeze([
  'document', 'schemaVersion', 'authorityId', 'authorityClass', 'authorityMode', 'issuedBy',
  'issuedAtUtc', 'decisionId', 'purpose', 'reexecutionAuthorized', 'grantsFutureBytePermission',
  'genericV1Admission', 'admittedPublications', 'registryDigest'
]);

export const ADMISSION_REGISTRY_ENTRY_FIELDS = Object.freeze([
  'admissionId', 'projectId', 'gateId', 'programId', 'admissionPath', 'admissionDigest'
]);

function firstUnknownField(value, allowed) {
  return Object.keys(value ?? {}).find((key) => !allowed.includes(key)) ?? null;
}

function refusal(reason, detail = null, extra = {}) {
  return { document: MAINTENANCE_PUBLICATION_ADMISSION_DOCUMENT, admitted: false, reason, detail, governingPaths: [], ...extra };
}

function shapeFinding(code, detail = null) { return { valid: false, findings: [{ code, detail }] }; }

function isExactGovernancePath(value) {
  return typeof value === 'string'
    && value.startsWith('governance/')
    && !value.includes('..')
    && !value.includes('\\')
    && !value.includes('*')
    && !value.includes('?')
    && !value.includes(':')
    && !value.split('/').some((segment) => segment === '' || segment === '.');
}

function isExactOwnerAuthorizationPath(value) {
  return isExactGovernancePath(value) && value.startsWith('governance/sources/');
}

/**
 * The digest an admission record commits to.
 *
 * Over the ADMITTED IDENTITY, the bound objects, the exact pre-state, the exact
 * operation classes and every denied permission — never over prose, issuance
 * metadata or the registry back-reference. So the fields that decide WHAT is
 * admitted cannot be edited without the record failing its own recomputation, and
 * the back-reference stays outside the seal so the mutual binding is not
 * recursive.
 */
export function computeMaintenancePublicationAdmissionDigest(admission) {
  const bound = {};
  for (const role of ADMITTED_OBJECT_ROLES) {
    bound[role] = {
      path: admission?.[role]?.path ?? null,
      sha256: admission?.[role]?.sha256 ?? null,
      byteLength: admission?.[role]?.byteLength ?? null,
      schemaVersion: admission?.[role]?.schemaVersion ?? null,
      documentId: admission?.[role]?.documentId ?? null
    };
  }
  const prestate = {};
  for (const field of ADMITTED_PRESTATE_FIELDS) prestate[field] = admission?.admittedPrestate?.[field] ?? null;
  const denied = {};
  for (const field of ADMISSION_DENIED_PERMISSIONS) denied[field] = admission?.[field] ?? null;
  return sha256Canonical({
    documentKind: MAINTENANCE_PUBLICATION_ADMISSION_DOCUMENT,
    admissionId: admission?.admissionId ?? null,
    decisionId: admission?.decisionId ?? null,
    projectId: admission?.projectId ?? null,
    repositoryId: admission?.repositoryId ?? null,
    gateId: admission?.gateId ?? null,
    programId: admission?.programId ?? null,
    purpose: admission?.purpose ?? null,
    publicationClass: admission?.publicationClass ?? null,
    authorityPurpose: admission?.authorityPurpose ?? null,
    maxUse: admission?.maxUse ?? null,
    admittedOperationClasses: Array.isArray(admission?.admittedOperationClasses) ? [...admission.admittedOperationClasses] : null,
    admittedPrestate: prestate,
    ...denied,
    ...bound
  });
}

/**
 * Shape, permission and self-binding validation of one admission record.
 *
 * Reads nothing and compares against nothing external. A record that fails here
 * admits nothing at all — there is no partially valid admission.
 */
export function validateMaintenancePublicationAdmissionShape(admission) {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) return shapeFinding('ADMISSION_ABSENT_OR_UNREADABLE');
  if (admission.documentKind !== MAINTENANCE_PUBLICATION_ADMISSION_DOCUMENT) return shapeFinding('ADMISSION_DOCUMENT_KIND_INVALID', admission.documentKind ?? null);
  const unknownAdmissionField = firstUnknownField(admission, ADMISSION_FIELDS);
  if (unknownAdmissionField !== null) return shapeFinding('ADMISSION_UNKNOWN_FIELD', unknownAdmissionField);
  if (admission.schemaVersion !== 1) return shapeFinding('ADMISSION_SCHEMA_VERSION_UNSUPPORTED', admission.schemaVersion ?? null);
  if (admission.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY') return shapeFinding('ADMISSION_AUTHORITY_MODE_INVALID', admission.authorityMode ?? null);
  if (admission.issuedBy !== 'PROJECT_OWNER') return shapeFinding('ADMISSION_ISSUER_INVALID', admission.issuedBy ?? null);
  if (!TOKEN_RE.test(admission.admissionId ?? '')) return shapeFinding('ADMISSION_ID_INVALID', admission.admissionId ?? null);
  if (!TOKEN_RE.test(admission.decisionId ?? '')) return shapeFinding('ADMISSION_DECISION_ID_INVALID', admission.decisionId ?? null);
  if (!ISO_UTC_RE.test(admission.issuedAtUtc ?? '')) return shapeFinding('ADMISSION_ISSUED_AT_INVALID', admission.issuedAtUtc ?? null);
  if (typeof admission.projectId !== 'string' || !admission.projectId) return shapeFinding('ADMISSION_PROJECT_ID_INVALID');
  if (typeof admission.repositoryId !== 'string' || !admission.repositoryId) return shapeFinding('ADMISSION_REPOSITORY_ID_INVALID');
  if (!GATE_RE.test(admission.gateId ?? '')) return shapeFinding('ADMISSION_GATE_ID_INVALID', admission.gateId ?? null);
  if (!TOKEN_RE.test(admission.programId ?? '')) return shapeFinding('ADMISSION_PROGRAM_ID_INVALID', admission.programId ?? null);
  if (admission.purpose !== ADMISSION_PURPOSE) return shapeFinding('ADMISSION_PURPOSE_INVALID', admission.purpose ?? null);
  if (admission.publicationClass !== ADMITTED_PUBLICATION_CLASS) return shapeFinding('ADMISSION_PUBLICATION_CLASS_UNSUPPORTED', admission.publicationClass ?? null);
  if (admission.authorityPurpose !== ADMITTED_AUTHORITY_PURPOSE) return shapeFinding('ADMISSION_AUTHORITY_PURPOSE_UNSUPPORTED', admission.authorityPurpose ?? null);

  // ONE USE, ONE PUBLICATION. An open-ended admission would be a standing licence,
  // which is the thing this primitive exists to make impossible.
  if (admission.maxUse !== 1) return shapeFinding('ADMISSION_MAX_USE_INVALID', admission.maxUse ?? null);

  for (const field of ADMISSION_DENIED_PERMISSIONS) {
    if (admission[field] !== false) return shapeFinding('ADMISSION_PERMISSION_NOT_DENIED', field);
  }
  if (!Array.isArray(admission.prohibitedOperations)
      || new Set(admission.prohibitedOperations).size !== admission.prohibitedOperations.length
      || ADMISSION_REQUIRED_PROHIBITED_OPERATIONS.some((operation) => !admission.prohibitedOperations.includes(operation))
      || admission.prohibitedOperations.length !== ADMISSION_REQUIRED_PROHIBITED_OPERATIONS.length) {
    return shapeFinding('ADMISSION_PROHIBITED_OPERATIONS_INVALID');
  }

  for (const role of ADMITTED_OBJECT_ROLES) {
    const entry = admission[role];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return shapeFinding('ADMISSION_BOUND_OBJECT_MISSING', role);
    const unknownBoundField = firstUnknownField(entry, ADMISSION_BOUND_OBJECT_FIELDS);
    if (unknownBoundField !== null) return shapeFinding('ADMISSION_BOUND_UNKNOWN_FIELD', role + ':' + unknownBoundField);
    if (!isExactGovernancePath(entry.path)) return shapeFinding('ADMISSION_BOUND_PATH_INVALID', role);
    if (!SHA256_RE.test(entry.sha256 ?? '')) return shapeFinding('ADMISSION_BOUND_SHA_INVALID', role);
    if (!Number.isInteger(entry.byteLength) || entry.byteLength < 0) return shapeFinding('ADMISSION_BOUND_BYTE_LENGTH_INVALID', role);
    if (!Number.isInteger(entry.schemaVersion)) return shapeFinding('ADMISSION_BOUND_SCHEMA_VERSION_INVALID', role);
    if (!TOKEN_RE.test(entry.documentId ?? '')) return shapeFinding('ADMISSION_BOUND_DOCUMENT_ID_INVALID', role);
  }
  if (admission.admittedAuthority.schemaVersion !== ADMITTED_AUTHORITY_SCHEMA_VERSION) {
    return shapeFinding('ADMISSION_AUTHORITY_SCHEMA_UNSUPPORTED', admission.admittedAuthority.schemaVersion);
  }
  // A V1 manifest is not admissible by any admission. Admitting one would be a
  // generic legacy escape hatch wearing an Owner document as a disguise.
  if (admission.admittedManifest.schemaVersion !== ADMITTED_MANIFEST_SCHEMA_VERSION) {
    return shapeFinding('ADMISSION_MANIFEST_SCHEMA_UNSUPPORTED', admission.admittedManifest.schemaVersion);
  }
  if (admission.admittedAuthority.path === admission.admittedManifest.path) {
    return shapeFinding('ADMISSION_BOUND_PATHS_NOT_DISTINCT', admission.admittedAuthority.path);
  }

  const prestate = admission.admittedPrestate;
  if (!prestate || typeof prestate !== 'object' || Array.isArray(prestate)) return shapeFinding('ADMISSION_PRESTATE_MISSING');
  for (const key of Object.keys(prestate)) {
    if (!ADMITTED_PRESTATE_FIELDS.includes(key)) return shapeFinding('ADMISSION_PRESTATE_UNKNOWN_FIELD', key);
  }
  for (const field of ADMITTED_PRESTATE_FIELDS) {
    if (!Object.hasOwn(prestate, field)) return shapeFinding('ADMISSION_PRESTATE_FIELD_MISSING', field);
  }
  if (!COMMIT_RE.test(prestate.baseHead ?? '')) return shapeFinding('ADMISSION_PRESTATE_BASE_HEAD_INVALID');
  if (!Number.isInteger(prestate.ledgerEventCount) || prestate.ledgerEventCount < 0) return shapeFinding('ADMISSION_PRESTATE_LEDGER_COUNT_INVALID');
  if (!SHA256_RE.test(prestate.ledgerPrefixSha256 ?? '')) return shapeFinding('ADMISSION_PRESTATE_LEDGER_PREFIX_INVALID');
  if (prestate.gateId !== admission.gateId) return shapeFinding('ADMISSION_PRESTATE_GATE_MISMATCH', prestate.gateId ?? null);
  for (const field of ['gateStatus', 'stateRevision', 'contractRevision', 'activeGate']) {
    if (prestate[field] !== null && (typeof prestate[field] !== 'string' || !prestate[field])) return shapeFinding('ADMISSION_PRESTATE_FIELD_INVALID', field);
  }
  if (typeof prestate.R8ExpectedAbsent !== 'boolean') return shapeFinding('ADMISSION_PRESTATE_R8_INVALID');

  if (!Array.isArray(admission.admittedOperationClasses) || admission.admittedOperationClasses.length === 0
      || new Set(admission.admittedOperationClasses).size !== admission.admittedOperationClasses.length
      || admission.admittedOperationClasses.some((value) => !TOKEN_RE.test(value))) {
    return shapeFinding('ADMISSION_OPERATION_CLASSES_INVALID');
  }
  // An admission may never hand out an operation it declares prohibited.
  for (const operationClass of admission.admittedOperationClasses) {
    if (ADMISSION_REQUIRED_PROHIBITED_OPERATIONS.includes(operationClass)) {
      return shapeFinding('ADMISSION_PROHIBITED_OPERATION_CLASS_ADMITTED', operationClass);
    }
  }

  // THE BACK-REFERENCE. Outside the identity digest by construction, so the two
  // documents can bind each other without either depending on the other's file
  // hash to seal itself.
  if (!isExactOwnerAuthorizationPath(admission.ownerAuthorizationPath)) return shapeFinding('ADMISSION_OWNER_AUTHORIZATION_PATH_INVALID', admission.ownerAuthorizationPath ?? null);
  if (!SHA256_RE.test(admission.ownerAuthorizationSha256 ?? '')) return shapeFinding('ADMISSION_OWNER_AUTHORIZATION_SHA_INVALID');

  const expected = computeMaintenancePublicationAdmissionDigest(admission);
  if (admission.admissionDigest !== expected) return shapeFinding('ADMISSION_DIGEST_MISMATCH', expected);
  return { valid: true, findings: [] };
}

/**
 * The digest the Owner authorization registry commits to.
 *
 * Over the admitted publications only, so the list of WHAT is admitted cannot be
 * lengthened, shortened or repointed without the registry failing its own
 * recomputation. Each entry carries the record's IDENTITY digest, never its file
 * hash, for the same non-recursion reason the reservation registry does.
 */
export function computeAdmissionRegistryDigest(registry) {
  return sha256Canonical({
    document: ADMISSION_OWNER_AUTHORIZATION_DOCUMENT,
    authorityId: registry?.authorityId ?? null,
    admittedPublications: (registry?.admittedPublications ?? []).map((entry) => ({
      admissionId: entry?.admissionId ?? null,
      projectId: entry?.projectId ?? null,
      gateId: entry?.gateId ?? null,
      programId: entry?.programId ?? null,
      admissionPath: entry?.admissionPath ?? null,
      admissionDigest: entry?.admissionDigest ?? null
    }))
  });
}

export function validateAdmissionRegistryShape(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return shapeFinding('ADMISSION_REGISTRY_ABSENT_OR_UNREADABLE');
  if (registry.document !== ADMISSION_OWNER_AUTHORIZATION_DOCUMENT) return shapeFinding('ADMISSION_REGISTRY_DOCUMENT_KIND_INVALID', registry.document ?? null);
  const unknownRegistryField = firstUnknownField(registry, ADMISSION_REGISTRY_FIELDS);
  if (unknownRegistryField !== null) return shapeFinding('ADMISSION_REGISTRY_UNKNOWN_FIELD', unknownRegistryField);
  if (registry.schemaVersion !== 1) return shapeFinding('ADMISSION_REGISTRY_SCHEMA_VERSION_UNSUPPORTED', registry.schemaVersion ?? null);
  if (registry.authorityClass !== ADMISSION_OWNER_AUTHORIZATION_CLASS) return shapeFinding('ADMISSION_REGISTRY_AUTHORITY_CLASS_INVALID', registry.authorityClass ?? null);
  if (registry.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY') return shapeFinding('ADMISSION_REGISTRY_AUTHORITY_MODE_INVALID', registry.authorityMode ?? null);
  if (registry.issuedBy !== 'PROJECT_OWNER') return shapeFinding('ADMISSION_REGISTRY_ISSUER_INVALID', registry.issuedBy ?? null);
  if (!TOKEN_RE.test(registry.authorityId ?? '')) return shapeFinding('ADMISSION_REGISTRY_AUTHORITY_ID_INVALID');
  if (!ISO_UTC_RE.test(registry.issuedAtUtc ?? '')) return shapeFinding('ADMISSION_REGISTRY_ISSUED_AT_INVALID', registry.issuedAtUtc ?? null);
  // The registry itself is an index, never a grant. It admits by NAMING records.
  if (registry.reexecutionAuthorized !== false) return shapeFinding('ADMISSION_REGISTRY_REEXECUTION_NOT_DENIED');
  if (registry.grantsFutureBytePermission !== false) return shapeFinding('ADMISSION_REGISTRY_FUTURE_BYTES_NOT_DENIED');
  if (registry.genericV1Admission !== false) return shapeFinding('ADMISSION_REGISTRY_GENERIC_V1_NOT_DENIED');
  if (!Array.isArray(registry.admittedPublications)) return shapeFinding('ADMISSION_REGISTRY_ENTRIES_INVALID');

  const seenAdmissionIds = new Set();
  const seenIdentities = new Set();
  for (const entry of registry.admittedPublications) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return shapeFinding('ADMISSION_REGISTRY_ENTRY_MALFORMED');
    const unknownEntryField = firstUnknownField(entry, ADMISSION_REGISTRY_ENTRY_FIELDS);
    if (unknownEntryField !== null) return shapeFinding('ADMISSION_REGISTRY_ENTRY_UNKNOWN_FIELD', unknownEntryField);
    if (!TOKEN_RE.test(entry.admissionId ?? '')) return shapeFinding('ADMISSION_REGISTRY_ENTRY_ID_INVALID');
    if (typeof entry.projectId !== 'string' || !entry.projectId) return shapeFinding('ADMISSION_REGISTRY_ENTRY_PROJECT_INVALID', entry.admissionId);
    if (!GATE_RE.test(entry.gateId ?? '')) return shapeFinding('ADMISSION_REGISTRY_ENTRY_GATE_INVALID', entry.gateId ?? null);
    if (!TOKEN_RE.test(entry.programId ?? '')) return shapeFinding('ADMISSION_REGISTRY_ENTRY_PROGRAM_INVALID', entry.admissionId);
    if (!isExactGovernancePath(entry.admissionPath)) return shapeFinding('ADMISSION_REGISTRY_ENTRY_PATH_INVALID', entry.admissionId);
    if (!SHA256_RE.test(entry.admissionDigest ?? '')) return shapeFinding('ADMISSION_REGISTRY_ENTRY_DIGEST_INVALID', entry.admissionId);
    // Two registry rows for one identity is a governance defect, not a choice to
    // resolve by order. It invalidates the registry outright.
    if (seenAdmissionIds.has(entry.admissionId)) return shapeFinding('ADMISSION_REGISTRY_DUPLICATE_ADMISSION_ID', entry.admissionId);
    const identity = admittedIdentityKey(entry);
    if (seenIdentities.has(identity)) return shapeFinding('ADMISSION_REGISTRY_DUPLICATE_IDENTITY', identity);
    seenAdmissionIds.add(entry.admissionId);
    seenIdentities.add(identity);
  }
  const expected = computeAdmissionRegistryDigest(registry);
  if (registry.registryDigest !== expected) return shapeFinding('ADMISSION_REGISTRY_DIGEST_MISMATCH', expected);
  return { valid: true, findings: [] };
}

/** The identity an admission admits, as a single comparable key. */
export function admittedIdentityKey({ projectId, gateId, programId }) {
  return `${projectId ?? ''}::${gateId ?? ''}::${programId ?? ''}`;
}

/**
 * Does `admission` admit THIS exact publication?
 *
 * Pure: every input is bytes the caller already read. Each clause is checked
 * separately so a refusal names the precise thing that did not match, which is
 * what makes a negative control meaningful rather than merely red.
 */
export function evaluateMaintenancePublicationAdmission({
  admission, gateId, authority, authorityPath, authoritySha256, authorityByteLength,
  manifest, manifestSha256, manifestByteLength
}) {
  const shape = validateMaintenancePublicationAdmissionShape(admission);
  if (!shape.valid) return refusal(shape.findings[0].code, shape.findings[0].detail ?? null);

  // ---- GATE, PROGRAM, PURPOSE ------------------------------------------
  //
  // The Gate is compared against the Gate the AUTHORITY binds, never against a
  // Gate the caller supplies alone. An admission for GATE20 therefore cannot
  // authorize a GATE21 program: the identity is exact in both directions, and a
  // GATE21 publication needs its own Owner admission.
  if (admission.gateId !== gateId) return refusal('ADMISSION_GATE_MISMATCH', admission.gateId);
  if (authority?.preState?.gateId !== admission.gateId) return refusal('ADMISSION_AUTHORITY_GATE_MISMATCH', authority?.preState?.gateId ?? null);
  if (admission.programId !== authority?.programId) return refusal('ADMISSION_PROGRAM_MISMATCH', authority?.programId ?? null);
  if ((authority?.authorityPurpose ?? ADMITTED_AUTHORITY_PURPOSE) !== admission.authorityPurpose) {
    return refusal('ADMISSION_PURPOSE_MISMATCH', authority?.authorityPurpose ?? null);
  }

  // ---- EXACT AUTHORITY BYTES -------------------------------------------
  if (admission.admittedAuthority.path !== authorityPath) return refusal('ADMISSION_AUTHORITY_PATH_MISMATCH', authorityPath ?? null);
  if (admission.admittedAuthority.sha256 !== authoritySha256) return refusal('ADMISSION_AUTHORITY_SHA_MISMATCH', authorityPath ?? null);
  if (authorityByteLength !== null && authorityByteLength !== undefined && admission.admittedAuthority.byteLength !== authorityByteLength) {
    return refusal('ADMISSION_AUTHORITY_BYTE_LENGTH_MISMATCH', authorityPath ?? null);
  }
  if (admission.admittedAuthority.documentId !== authority?.authorityId) return refusal('ADMISSION_AUTHORITY_ID_MISMATCH', authority?.authorityId ?? null);
  if (admission.admittedAuthority.schemaVersion !== authority?.schemaVersion) return refusal('ADMISSION_AUTHORITY_SCHEMA_MISMATCH', String(authority?.schemaVersion ?? null));

  // ---- EXACT MANIFEST BYTES --------------------------------------------
  //
  // Both directions: the admission's manifest path must be the path the AUTHORITY
  // pins, and its digest must be the bytes actually loaded. Checking only one
  // would let a substituted manifest at the admitted path pass.
  if (admission.admittedManifest.path !== authority?.authorizedPathManifestPath) return refusal('ADMISSION_MANIFEST_PATH_MISMATCH', authority?.authorizedPathManifestPath ?? null);
  if (admission.admittedManifest.sha256 !== manifestSha256) return refusal('ADMISSION_MANIFEST_SHA_MISMATCH', admission.admittedManifest.path);
  if (admission.admittedManifest.sha256 !== authority?.authorizedPathManifestSha256) return refusal('ADMISSION_MANIFEST_AUTHORITY_PIN_MISMATCH', admission.admittedManifest.path);
  if (manifestByteLength !== null && manifestByteLength !== undefined && admission.admittedManifest.byteLength !== manifestByteLength) {
    return refusal('ADMISSION_MANIFEST_BYTE_LENGTH_MISMATCH', admission.admittedManifest.path);
  }
  if (admission.admittedManifest.documentId !== manifest?.manifestId) return refusal('ADMISSION_MANIFEST_ID_MISMATCH', manifest?.manifestId ?? null);
  if (admission.admittedManifest.schemaVersion !== manifest?.schemaVersion) return refusal('ADMISSION_MANIFEST_SCHEMA_MISMATCH', String(manifest?.schemaVersion ?? null));

  // ---- EXACT PRE-STATE --------------------------------------------------
  //
  // Every facet, not a subset. The admission admits a publication against ONE
  // repository state; a stale admission replayed against a moved repository fails
  // here, on the exact facet that moved.
  for (const field of ADMITTED_PRESTATE_FIELDS) {
    if (admission.admittedPrestate[field] !== authority?.preState?.[field]) {
      return refusal('ADMISSION_PRESTATE_MISMATCH', field);
    }
  }

  // ---- EXACT OPERATION CLASSES -----------------------------------------
  //
  // Set equality in both directions. An authority may not exercise a class the
  // Owner did not admit, and an admission that names a class the authority does
  // not claim describes some other program.
  const admitted = new Set(admission.admittedOperationClasses);
  const claimed = Array.isArray(authority?.authorizedOperationClasses) ? authority.authorizedOperationClasses : [];
  for (const operationClass of claimed) {
    if (!admitted.has(operationClass)) return refusal('ADMISSION_OPERATION_CLASS_NOT_ADMITTED', operationClass);
  }
  for (const operationClass of admitted) {
    if (!claimed.includes(operationClass)) return refusal('ADMISSION_OPERATION_CLASS_NOT_CLAIMED', operationClass);
  }

  return {
    document: MAINTENANCE_PUBLICATION_ADMISSION_DOCUMENT,
    admitted: true, reason: null, detail: null,
    admissionId: admission.admissionId,
    decisionId: admission.decisionId,
    programId: admission.programId,
    gateId: admission.gateId,
    publicationClass: admission.publicationClass,
    maxUse: admission.maxUse,
    grantsFutureBytePermission: false,
    governingPaths: []
  };
}

function readJsonOrNull(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

/** SHA-256 and byte length of a repo-relative file, or nulls when it is not a readable file. */
export function observeGoverningFile(root, relativePath) {
  try {
    if (!isExactGovernancePath(relativePath)) return { present: false, sha256: null, byteLength: null };
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { present: false, sha256: null, byteLength: null };
    const bytes = fs.readFileSync(file);
    return { present: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  } catch { return { present: false, sha256: null, byteLength: null }; }
}

/**
 * Every admission record issued for `gateId`, keyed by the identity it admits.
 *
 * A duplicate identity refuses BOTH, never first-wins: two Owner documents
 * claiming the same publication is a governance defect, and picking one would make
 * the outcome depend on directory order.
 */
export function collectMaintenancePublicationAdmissions({ root, gateId }) {
  const byIdentity = new Map();
  const findings = [];
  const directory = path.resolve(root, ...ADMISSION_DIRECTORY.split('/'), gateId);
  if (!fs.existsSync(directory)) return { byIdentity, findings };
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
    const relativePath = `${ADMISSION_DIRECTORY}/${gateId}/${name}`;
    const admission = readJsonOrNull(path.join(directory, name));
    if (admission === null) { findings.push({ code: 'ADMISSION_UNREADABLE', detail: relativePath }); continue; }
    if (admission.documentKind !== MAINTENANCE_PUBLICATION_ADMISSION_DOCUMENT) continue;
    const observed = observeGoverningFile(root, relativePath);
    const key = admittedIdentityKey(admission);
    if (byIdentity.has(key)) {
      findings.push({ code: 'ADMISSION_DUPLICATE_IDENTITY', detail: key });
      byIdentity.set(key, { valid: false, reason: 'ADMISSION_DUPLICATE_IDENTITY', path: relativePath, admission: null, sha256: null, byteLength: null });
      continue;
    }
    const shape = validateMaintenancePublicationAdmissionShape(admission);
    if (!shape.valid) {
      findings.push({ code: 'ADMISSION_INVALID', detail: `${relativePath}:${shape.findings[0].code}` });
      byIdentity.set(key, { valid: false, reason: shape.findings[0].code, path: relativePath, admission: null, sha256: observed.sha256, byteLength: observed.byteLength });
      continue;
    }
    if (admission.gateId !== gateId) { findings.push({ code: 'ADMISSION_GATE_MISMATCH', detail: relativePath }); continue; }
    byIdentity.set(key, { valid: true, reason: null, path: relativePath, admission, sha256: observed.sha256, byteLength: observed.byteLength });
  }
  return { byIdentity, findings };
}

/**
 * THE ONE PUBLICATION-ADMISSION DECISION, consumed by the canonical publisher.
 *
 * Resolves, for the source described by `authority`, whether an independent Owner
 * admission exists that admits exactly this publication — and returns the exact
 * governing paths the publication must treat as causally prior PRESENT inputs.
 *
 * FAIL-CLOSED IN EVERY DIRECTION. Absent registry, absent record, invalid either,
 * mismatched mutual binding, a reserved historical identity, or a governing file
 * that is missing or has drifted a single byte — all refuse, each with its own
 * reason. There is no branch that returns `admitted: true` on incomplete evidence,
 * and no branch that falls back to publishing without an admission.
 *
 * Reads bytes. Never writes, never shells out to Git, never consults a clock,
 * never looks at FINAL_GATE_INTEGRITY output.
 */
export function resolveMaintenancePublicationAdmission({
  root, gateId, authority, authorityPath, authoritySha256, authorityByteLength,
  manifest, manifestSha256, manifestByteLength,
  historicalIdentity = null, admissions = null
}) {
  // A RESERVED HISTORICAL IDENTITY IS NEVER ADMISSIBLE FOR PUBLICATION, and the
  // check is repeated here rather than left to the caller. The seam already refuses
  // reserved identities earlier, so this is defence in depth against a future
  // caller that resolves admission first — an admission must never become the
  // second route around the reservation the bridge exists to enforce.
  if (historicalIdentity?.reserved === true) {
    return refusal('ADMISSION_REFUSES_RESERVED_HISTORICAL_IDENTITY', authority?.programId ?? null);
  }

  const resolved = admissions ?? collectMaintenancePublicationAdmissions({ root, gateId });
  const programId = authority?.programId ?? null;

  // Matched on Gate + program, never on a field the judged source supplies alone:
  // a maintenance authority carries no projectId, so letting it name one would let
  // a program pick which admission judges it.
  let entry = null;
  for (const [candidateKey, candidate] of resolved.byIdentity) {
    const [, candidateGate, candidateProgram] = candidateKey.split('::');
    if (candidateGate === gateId && candidateProgram === programId) { entry = candidate; break; }
  }
  if (!entry) return refusal('PUBLICATION_ADMISSION_ABSENT', programId);
  if (!entry.valid) return refusal('PUBLICATION_ADMISSION_INVALID', entry.reason, { admissionPath: entry.path });
  const admission = entry.admission;
  const ownerAuthorizationPath = admission.ownerAuthorizationPath;
  if (!isExactOwnerAuthorizationPath(ownerAuthorizationPath)) {
    return refusal('ADMISSION_OWNER_AUTHORIZATION_PATH_INVALID', ownerAuthorizationPath, { admissionPath: entry.path });
  }
  const registryObserved = observeGoverningFile(root, ownerAuthorizationPath);
  const registry = readJsonOrNull(path.resolve(root, ...ownerAuthorizationPath.split('/')));
  if (registry === null) return refusal('ADMISSION_OWNER_AUTHORIZATION_ABSENT', ownerAuthorizationPath, { admissionPath: entry.path });
  const registryShape = validateAdmissionRegistryShape(registry);
  if (!registryShape.valid) return refusal('ADMISSION_OWNER_AUTHORIZATION_INVALID', registryShape.findings[0].code, { admissionPath: entry.path });

  // ---- MUTUAL BINDING, BOTH DIRECTIONS ---------------------------------
  //
  // A one-way reference is half a binding. The registry must name this exact record
  // by path and identity digest, and the record must name the registry by path and
  // FILE digest. Substituting a valid-looking record for the registered one, or
  // repointing a record at a different registry, fails here.
  const registryEntry = registry.admittedPublications.find(
    (candidate) => candidate.gateId === gateId && candidate.programId === programId
  ) ?? null;
  if (!registryEntry) return refusal('ADMISSION_NOT_IN_OWNER_AUTHORIZATION', programId, { admissionPath: entry.path });
  if (registry.decisionId !== admission.decisionId) return refusal('ADMISSION_REGISTRY_DECISION_MISMATCH', registry.decisionId, { admissionPath: entry.path });
  if (registryEntry.admissionId !== admission.admissionId) return refusal('ADMISSION_REGISTRY_ID_MISMATCH', registryEntry.admissionId, { admissionPath: entry.path });
  if (registryEntry.projectId !== admission.projectId) return refusal('ADMISSION_REGISTRY_PROJECT_MISMATCH', registryEntry.projectId, { admissionPath: entry.path });
  if (registryEntry.admissionPath !== entry.path) return refusal('ADMISSION_REGISTRY_PATH_MISMATCH', registryEntry.admissionPath, { admissionPath: entry.path });
  if (registryEntry.admissionDigest !== admission.admissionDigest) return refusal('ADMISSION_REGISTRY_DIGEST_BINDING_INVALID', registryEntry.admissionPath, { admissionPath: entry.path });
  if (admission.ownerAuthorizationSha256 !== registryObserved.sha256) {
    return refusal('ADMISSION_OWNER_AUTHORIZATION_BACKREFERENCE_INVALID', ownerAuthorizationPath, { admissionPath: entry.path });
  }

  // ---- THE EXACT PUBLICATION ------------------------------------------
  const evaluation = evaluateMaintenancePublicationAdmission({
    admission, gateId, authority, authorityPath, authoritySha256, authorityByteLength,
    manifest, manifestSha256, manifestByteLength
  });
  if (!evaluation.admitted) return { ...evaluation, admissionPath: entry.path };

  // ---- CONTROL 15: GOVERNING PATHS ARE CAUSALLY PRIOR PRESENT INPUTS ----
  //
  // The four documents that decide whether this publication is authorized must
  // already exist, with exactly the bytes the admission pins, BEFORE the
  // publication begins. This is the half of Control 15 that is checked against the
  // repository rather than against the manifest: a manifest can only claim, whereas
  // this reads. Together with the manifest-shape rule that refuses an ABSENT
  // declaration for any of these paths, a program cannot create the documents that
  // authorize it in the act they authorize.
  const governingPaths = [
    { role: GOVERNING_ROLE_ADMITTED_AUTHORITY, path: admission.admittedAuthority.path, sha256: admission.admittedAuthority.sha256, byteLength: admission.admittedAuthority.byteLength },
    { role: GOVERNING_ROLE_ADMITTED_MANIFEST, path: admission.admittedManifest.path, sha256: admission.admittedManifest.sha256, byteLength: admission.admittedManifest.byteLength },
    { role: GOVERNING_ROLE_ADMISSION_RECORD, path: entry.path, sha256: admission.admissionDigest === null ? null : entry.sha256, byteLength: entry.byteLength },
    { role: GOVERNING_ROLE_OWNER_AUTHORIZATION, path: ownerAuthorizationPath, sha256: registryObserved.sha256, byteLength: registryObserved.byteLength }
  ];
  for (const governing of governingPaths) {
    const observed = observeGoverningFile(root, governing.path);
    if (!observed.present) return refusal('GOVERNING_PATH_ABSENT_BEFORE_PUBLICATION', `${governing.role}:${governing.path}`, { admissionPath: entry.path });
    if (governing.sha256 === null || observed.sha256 !== governing.sha256) {
      return refusal('GOVERNING_PATH_DIGEST_MISMATCH', `${governing.role}:${governing.path}`, { admissionPath: entry.path });
    }
    if (governing.byteLength !== null && observed.byteLength !== governing.byteLength) {
      return refusal('GOVERNING_PATH_BYTE_LENGTH_MISMATCH', `${governing.role}:${governing.path}`, { admissionPath: entry.path });
    }
  }

  return {
    ...evaluation,
    admissionPath: entry.path,
    admissionSha256: entry.sha256,
    ownerAuthorizationPath,
    ownerAuthorizationSha256: registryObserved.sha256,
    governingPaths
  };
}

/**
 * The consumption-record citation this admission requires, so a receipt names the
 * decision it was published under. Composed here rather than in the publisher so
 * there is one definition of what a citation is.
 */
export function admissionCitation(resolution) {
  if (!resolution || resolution.admitted !== true) return null;
  return {
    admissionId: resolution.admissionId,
    admissionPath: resolution.admissionPath,
    admissionSha256: resolution.admissionSha256
  };
}
