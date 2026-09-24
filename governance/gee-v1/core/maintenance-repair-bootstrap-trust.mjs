/**
 * MAINTENANCE REPAIR BOOTSTRAP TRUST — the one-use trust boundary in front of a
 * V2 repair program while the ordinary Generic Fast Gate is blocked.
 *
 * THE SITUATION THIS EXISTS FOR, STATED EXACTLY.
 *
 * The Generic Fast Gate reads the ledger in FULL mode. When FULL reports a
 * BLOCKING present-state finding, the Wheel adapter sets LEDGER_NOT_VERIFIED and
 * context compilation refuses before any verdict. That is correct behaviour and
 * it stays byte-identical. But it also means the Fast Gate cannot be the thing
 * that admits the repair of the very defect that blocks it: the repair has to be
 * published BEFORE the gate can pass again.
 *
 * The V2 publisher does not consult the Fast Gate, so without this module a
 * repair of a trust defect is just another maintenance program — nothing says
 * the Owner decided it, nothing says the defect is the one the repair claims,
 * and nothing stops the same program from also touching the trust machinery.
 *
 * WHAT THIS MODULE IS.
 *
 * A pure, read-only evaluator. It answers one question for the publisher:
 *
 *   "Is this V2 repair program exactly the one Owner-authorized repair of exactly
 *    one reproduced present-state defect subject, on an intact ledger history?"
 *
 * It enforces E1–E9 of the accepted precontract:
 *
 *   E1  LEDGER_INTEGRITY is valid (never read as FULL validity)
 *   E2  the present residual, recomputed here, collapses to exactly one subject,
 *       and that subject and its residual identity equal the authority's
 *   E3  the Owner decision binds that subject, that identity and that manifest,
 *       exists before publication and is not written by the repair
 *   E4  the repair manifest is exact, closed, glob-free and disjoint from the
 *       protected trust-control surface
 *   E5  maxUse = 1
 *   E6  the bootstrap receipt is absent
 *   E7  push is not authorized
 *   E8  R8 is absent
 *   E9  no BLOCKING present finding exists outside the authorized subject
 *
 * WHAT THIS MODULE IS NOT.
 *
 * It is not the Fast Gate and never calls it for eligibility. It does not ignore
 * FULL findings, allowlist old findings, declare FULL valid, or manufacture a
 * PASS: the only closure obligation it knows is ORDINARY_FAST_GATE_PASS, and the
 * closure helper at the bottom of this file only ever reports what the unchanged
 * Fast Gate actually returned. It writes nothing. The publisher is the only
 * writer of the receipt this module composes.
 *
 * A PASTED FINDING LIST IS NOT PROOF. The residual is recomputed here, from the
 * repository, with the canonical ledger validator and the Wheel policy — the same
 * validator and policy canonical-ledger-authority.mjs and the Wheel adapter use.
 * No caller can hand this module a residual.
 *
 * NAMING (Owner amendment R2). For a V2 repair programId P, and only by literal
 * substitution — no directory scan, no inferred prefix, no abbreviation:
 *
 *   authority       governance/authority/maintenance-repair-bootstrap/P_AUTHORITY_R1.json
 *   Owner decision  governance/authority/maintenance-repair-bootstrap/P_OWNER_DECISION_R1.json
 *   receipt         governance/historical-architecture/P_BOOTSTRAP_CONSUMPTION_R1.json
 *   authorityId     P_BOOTSTRAP_AUTHORITY_R1
 *
 * The authority directory is deliberately not governance/sources/: the canonical
 * predecessor collector indexes every JSON there by authorityId.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../tools/canonical-json.mjs';
import { validatePresentConsistency } from '../../tools/validate-status-ledger.mjs';
import { observeCanonicalPreState } from '../../tools/post-freeze-maintenance-observation.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../adapters/wheel/external-authority-policy.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';
import {
  isExactMaintenancePath,
  POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_NORMAL,
  PRESTATE_ABSENT,
  PRESTATE_PRESENT,
  validateConsumptionRecordCoherence,
  validateMaintenanceAuthorizedPathManifest,
  validatePostFreezeMaintenanceAuthorityV2Shape
} from './post-freeze-maintenance-authority.mjs';

export const BOOTSTRAP_EVALUATOR_DOCUMENT = 'MAINTENANCE_REPAIR_BOOTSTRAP_TRUST_EVALUATION';
export const BOOTSTRAP_EVALUATOR_VERSION = 'R1';

export const BOOTSTRAP_AUTHORITY_DOCUMENT = 'MAINTENANCE_REPAIR_BOOTSTRAP_TRUST_AUTHORITY';
export const BOOTSTRAP_CONSUMPTION_DOCUMENT = 'MAINTENANCE_REPAIR_BOOTSTRAP_TRUST_CONSUMPTION';
export const BOOTSTRAP_OWNER_DECISION_DOCUMENT = 'MAINTENANCE_REPAIR_BOOTSTRAP_OWNER_DECISION';
export const BOOTSTRAP_RESIDUAL_IDENTITY_DOCUMENT = 'MAINTENANCE_REPAIR_BOOTSTRAP_RESIDUAL_IDENTITY';
export const BOOTSTRAP_AUTHORITY_CLASS = 'PROJECT_OWNER_MAINTENANCE_BOOTSTRAP_AUTHORITY';
export const BOOTSTRAP_AUTHORITY_MODE = 'LOCAL_EXPLICIT_AUTHORITY';
export const BOOTSTRAP_CLOSURE_OBLIGATION = 'ORDINARY_FAST_GATE_PASS';

export const BOOTSTRAP_AUTHORITY_DIRECTORY = 'governance/authority/maintenance-repair-bootstrap';
export const BOOTSTRAP_RECEIPT_DIRECTORY = 'governance/historical-architecture';

/** Applicability of the bootstrap boundary to one V2 publication. */
export const BOOTSTRAP_NOT_APPLICABLE = 'NOT_APPLICABLE';
export const BOOTSTRAP_NOT_REQUIRED = 'NOT_REQUIRED';
export const BOOTSTRAP_REQUIRED = 'REQUIRED';

/** The terminal a failed closure reaches. There is no successor, retry or rollback from it. */
export const STOP_BOOTSTRAP_REPAIR_FAILED_TO_RESTORE_TRUST = 'STOP_BOOTSTRAP_REPAIR_FAILED_TO_RESTORE_TRUST';

/**
 * The residual is produced by this validator, in these two modes. Both enter the
 * residual identity, so a change to either is a change of identity.
 */
export const RESIDUAL_VALIDATOR_PATH = 'governance/tools/validate-status-ledger.mjs';
export const RESIDUAL_VALIDATION_MODES = Object.freeze(['LEDGER_INTEGRITY', 'FULL']);

/**
 * Wrapper detectors whose `actualValue` carries the findings of another producer.
 * A wrapper is unwrapped and its inner BLOCKING findings become the manifestations;
 * the gate that carries the wrapper is a manifestation, never a subject by itself.
 */
export const STATE_LINEAGE_WRAPPER_DETECTOR = 'GATE_AUTHORIZATION_STATE_LINEAGE_INVALID';
export const WRAPPED_DETECTOR_PRODUCERS = Object.freeze({
  [STATE_LINEAGE_WRAPPER_DETECTOR]: 'governance/tools/validate-state-revision.mjs'
});

/**
 * THE CLOSED TRUST-CONTROL SURFACE. A bootstrap repair may not write any of these,
 * nor the resolved authority and Owner decision of its own program. The publisher
 * is here because the publisher is the only caller of this evaluator: a repair that
 * could rewrite it could delete the call.
 */
export const BOOTSTRAP_PROTECTED_CONTROL_SURFACE = Object.freeze([
  'governance/state/GATE_STATUS_LEDGER.ndjson',
  'governance/tools/gate-fast-path-control-plane.mjs',
  'governance/gee-v1/context/compile-context.mjs',
  'governance/gee-v1/adapters/wheel/wheel-project-adapter.mjs',
  'governance/gee-v1/adapters/wheel/context-wheel-adapter.mjs',
  'governance/gee-v1/core/maintenance-repair-bootstrap-trust.mjs',
  'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-authority.schema.json',
  'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-consumption.schema.json',
  'governance/tools/apply-path-prestate-program.mjs'
]);

/** The R8 contract whose presence ends eligibility (E8). Same path the V2 observation reads. */
export const R8_CONTRACT_PATH = 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0008.json';

/**
 * GENESIS — the one program that installs this module. It is published by the
 * PREVIOUS publisher, which does not import this file, so the primitive is never
 * in the trust path of its own creation. The constants below describe its exact
 * cohort so the candidate can be checked; they grant nothing to anyone.
 */
export const BOOTSTRAP_GENESIS_PROGRAM_ID = 'GATE26_MAINTENANCE_BOOTSTRAP_TRUST_PRIMITIVE_GENESIS_R1';
export const BOOTSTRAP_GENESIS_AUTHORITY_PATH = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE26_MAINTENANCE_BOOTSTRAP_TRUST_PRIMITIVE_GENESIS_R1.json';
export const BOOTSTRAP_GENESIS_MANIFEST_PATH = 'governance/historical-architecture/GATE26_MAINTENANCE_BOOTSTRAP_TRUST_PRIMITIVE_GENESIS_AUTHORIZED_PATHS_R1.json';
export const BOOTSTRAP_GENESIS_CONSUMPTION_PATH = 'governance/historical-architecture/GATE26_MAINTENANCE_BOOTSTRAP_TRUST_PRIMITIVE_GENESIS_CONSUMPTION_R1.json';
export const BOOTSTRAP_GENESIS_PUBLISHER_PATH = 'governance/tools/apply-path-prestate-program.mjs';
export const BOOTSTRAP_GENESIS_CREATE_PATHS = Object.freeze([
  'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-authority.schema.json',
  'governance/gee-v1/schemas/maintenance-repair-bootstrap-trust-consumption.schema.json',
  'governance/gee-v1/core/maintenance-repair-bootstrap-trust.mjs',
  'governance/gee-v1/tests/maintenance-repair-bootstrap-trust.test.mjs',
  BOOTSTRAP_GENESIS_AUTHORITY_PATH,
  BOOTSTRAP_GENESIS_MANIFEST_PATH,
  BOOTSTRAP_GENESIS_CONSUMPTION_PATH
]);

const TOKEN_RE = /^[A-Z][A-Z0-9_-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;
const PRE_STATE_FIELDS = Object.freeze([
  'baseHead', 'ledgerEventCount', 'ledgerPrefixSha256', 'gateId', 'gateStatus',
  'stateRevision', 'contractRevision', 'activeGate', 'R8ExpectedAbsent'
]);
const LIVE_PRE_STATE_FIELDS = Object.freeze(PRE_STATE_FIELDS.filter((field) => field !== 'R8ExpectedAbsent'));
const DEFECT_SUBJECT_FIELDS = Object.freeze(['detectorId', 'protectedPath', 'producerPath', 'producerBlobSha256']);

/**
 * The denials an authority must state as literal `false`. An omitted denial is a
 * refusal, not a default: a document that forgot to deny present-state trust must
 * not be read as denying it.
 */
export const BOOTSTRAP_AUTHORITY_DENIALS = Object.freeze([
  'pushAuthorized', 'genesisAuthorized', 'grantsPresentStateTrust', 'grantsFastGateExemption',
  'recursiveBootstrapAuthorized', 'derivedFromFinalGateIntegrityFindings'
]);

export const BOOTSTRAP_OWNER_DECISION_FIELDS = Object.freeze([
  'document', 'schemaVersion', 'decisionId', 'issuedBy', 'authorityMode', 'decidedAt', 'programId',
  'bootstrapAuthorityId', 'defectSubject', 'residualIdentitySha256', 'repairManifestPath',
  'repairManifestSha256', 'decisionStatement'
]);

/*
 * The schemas are resolved next to this module, never below the root being judged:
 * a candidate tree may not supply the rules it is judged by. Same idiom as the
 * historical-reconciliation schema in validate-status-ledger.mjs.
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXECUTING_REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');
export const BOOTSTRAP_AUTHORITY_SCHEMA_PATH = path.resolve(MODULE_DIR, '..', 'schemas', 'maintenance-repair-bootstrap-trust-authority.schema.json');
export const BOOTSTRAP_CONSUMPTION_SCHEMA_PATH = path.resolve(MODULE_DIR, '..', 'schemas', 'maintenance-repair-bootstrap-trust-consumption.schema.json');
let schemaCache = null;
function loadSchemas() {
  schemaCache ??= {
    authority: JSON.parse(fs.readFileSync(BOOTSTRAP_AUTHORITY_SCHEMA_PATH, 'utf8')),
    consumption: JSON.parse(fs.readFileSync(BOOTSTRAP_CONSUMPTION_SCHEMA_PATH, 'utf8'))
  };
  return schemaCache;
}

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function resolveRepoPath(root, relativePath) {
  if (!isExactMaintenancePath(relativePath)) return null;
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null;
}

/** Exact bytes of a repo-relative file, or null when it is not a readable file. */
function readRepoFile(root, relativePath) {
  const file = resolveRepoPath(root, relativePath);
  try {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}

function parseJsonBytes(bytes) {
  try { return JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return null; }
}

/* ------------------------------------------------------------------------ */
/* NAMING                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The literal PROGRAM_ID substitution of Owner amendment R2. Returns null for a
 * programId that is not a plain token, so no path can be steered by the id.
 */
export function deriveMaintenanceRepairBootstrapPaths(programId) {
  if (typeof programId !== 'string' || !TOKEN_RE.test(programId)) return null;
  return {
    programId,
    authorityPath: `${BOOTSTRAP_AUTHORITY_DIRECTORY}/${programId}_AUTHORITY_R1.json`,
    ownerDecisionPath: `${BOOTSTRAP_AUTHORITY_DIRECTORY}/${programId}_OWNER_DECISION_R1.json`,
    receiptPath: `${BOOTSTRAP_RECEIPT_DIRECTORY}/${programId}_BOOTSTRAP_CONSUMPTION_R1.json`,
    authorityId: `${programId}_BOOTSTRAP_AUTHORITY_R1`
  };
}

/** The static surface plus the resolved authority and Owner decision of this program. */
export function resolveBootstrapProtectedControlSurface(programId) {
  const paths = deriveMaintenanceRepairBootstrapPaths(programId);
  return paths
    ? [...BOOTSTRAP_PROTECTED_CONTROL_SURFACE, paths.authorityPath, paths.ownerDecisionPath]
    : [...BOOTSTRAP_PROTECTED_CONTROL_SURFACE];
}

/**
 * Which manifest paths touch the trust machinery. Pure.
 *
 *   controlSurfaceHits  the closed surface, including this program's own authority
 *                       and Owner decision
 *   recursiveHits       any other bootstrap authority/decision, or any bootstrap
 *                       receipt other than this program's own: a repair that mints
 *                       or forges another bootstrap is a recursive bootstrap
 */
export function classifyBootstrapManifestPaths({ programId, manifestPaths }) {
  const paths = deriveMaintenanceRepairBootstrapPaths(programId);
  const surface = new Set(resolveBootstrapProtectedControlSurface(programId));
  const controlSurfaceHits = [];
  const recursiveHits = [];
  for (const candidate of Array.isArray(manifestPaths) ? manifestPaths : []) {
    if (surface.has(candidate)) { controlSurfaceHits.push(candidate); continue; }
    if (typeof candidate !== 'string') continue;
    if (candidate.startsWith(`${BOOTSTRAP_AUTHORITY_DIRECTORY}/`)) { recursiveHits.push(candidate); continue; }
    if (candidate.startsWith(`${BOOTSTRAP_RECEIPT_DIRECTORY}/`) && candidate.endsWith('_BOOTSTRAP_CONSUMPTION_R1.json')
        && candidate !== paths?.receiptPath) recursiveHits.push(candidate);
  }
  return { controlSurfaceHits: controlSurfaceHits.sort(), recursiveHits: recursiveHits.sort() };
}

/* ------------------------------------------------------------------------ */
/* RESIDUAL                                                                   */
/* ------------------------------------------------------------------------ */

function protectedPathOf(item) {
  if (typeof item?.protectedHashCheck?.path === 'string') return item.protectedHashCheck.path;
  const actual = item?.actualValue;
  if (actual && typeof actual === 'object' && !Array.isArray(actual) && typeof actual.path === 'string') return actual.path;
  return null;
}

function historicalHashOf(item) {
  if (typeof item?.protectedHashCheck?.expectedSha256 === 'string') return item.protectedHashCheck.expectedSha256;
  const actual = item?.actualValue;
  if (actual && typeof actual === 'object' && !Array.isArray(actual) && typeof actual.sha256 === 'string') return actual.sha256;
  return null;
}

function liveHashOf(item) {
  return typeof item?.protectedHashCheck?.actualSha256 === 'string' ? item.protectedHashCheck.actualSha256 : null;
}

/** The normalized subject key. Order and separator are fixed; nothing else enters it. */
export function defectSubjectKey(subject) {
  return canonicalize({
    detectorId: subject?.detectorId ?? null,
    protectedPath: subject?.protectedPath ?? null,
    producerPath: subject?.producerPath ?? null
  });
}

/**
 * Collapse BLOCKING present-state findings into defect subjects. Pure.
 *
 * A subject is (detectorId, protectedPath, producerPath) after unwrapping the
 * state-lineage wrapper. Manifestations carry the gate, the pointer and the two
 * hashes, never the human message. INFO findings are not subjects.
 */
export function normalizeResidualFindings(presentFindings) {
  const bySubject = new Map();
  let blockingCount = 0;
  const add = (subject, manifestation) => {
    const key = defectSubjectKey(subject);
    if (!bySubject.has(key)) bySubject.set(key, { key, subject, manifestations: [] });
    bySubject.get(key).manifestations.push(manifestation);
  };
  for (const item of Array.isArray(presentFindings) ? presentFindings : []) {
    if (item?.severity !== 'BLOCKING') continue;
    blockingCount += 1;
    const producerPath = WRAPPED_DETECTOR_PRODUCERS[item.detectorId] ?? null;
    const inner = producerPath && Array.isArray(item.actualValue)
      ? item.actualValue.filter((entry) => entry?.severity === 'BLOCKING')
      : [];
    if (producerPath && inner.length > 0) {
      for (const entry of inner) {
        add(
          { detectorId: entry.detectorId ?? null, protectedPath: protectedPathOf(entry), producerPath },
          {
            gateId: item.gateId ?? null, eventId: item.eventId ?? null,
            wrapperDetectorId: item.detectorId, wrapperPointer: item.jsonPointer ?? null,
            pointer: entry.jsonPointer ?? null, historicalSha256: historicalHashOf(entry), liveSha256: liveHashOf(entry)
          }
        );
      }
      continue;
    }
    add(
      { detectorId: item.detectorId ?? null, protectedPath: protectedPathOf(item), producerPath: RESIDUAL_VALIDATOR_PATH },
      {
        gateId: item.gateId ?? null, eventId: item.eventId ?? null, wrapperDetectorId: null, wrapperPointer: null,
        pointer: item.jsonPointer ?? null, historicalSha256: historicalHashOf(item), liveSha256: liveHashOf(item)
      }
    );
  }
  const subjects = [...bySubject.values()]
    .map((entry) => ({ ...entry, manifestations: sortManifestations(entry.manifestations) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return { subjects, blockingCount };
}

function sortManifestations(manifestations) {
  return manifestations
    .map((entry) => ({
      gateId: entry.gateId ?? null, eventId: entry.eventId ?? null,
      wrapperDetectorId: entry.wrapperDetectorId ?? null, wrapperPointer: entry.wrapperPointer ?? null,
      pointer: entry.pointer ?? null, historicalSha256: entry.historicalSha256 ?? null, liveSha256: entry.liveSha256 ?? null
    }))
    .map((entry) => [canonicalize(entry), entry])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([, entry]) => entry);
}

/**
 * The residual identity digest. Deterministic, message-free, computed with the
 * repository's canonical JSON hash. The authority carries it; this module
 * recomputes it and never trusts a supplied value.
 */
export function computeResidualIdentity({ validator, baseHead, ledgerEventCount, ledgerPrefixSha256, producer, subject, manifestations }) {
  return sha256Canonical({
    document: BOOTSTRAP_RESIDUAL_IDENTITY_DOCUMENT,
    schemaVersion: 1,
    validator: { path: validator?.path ?? null, sha256: validator?.sha256 ?? null },
    validationModes: [...RESIDUAL_VALIDATION_MODES],
    baseHead: baseHead ?? null,
    ledger: { eventCount: ledgerEventCount ?? null, prefixSha256: ledgerPrefixSha256 ?? null },
    producer: { path: producer?.path ?? null, sha256: producer?.sha256 ?? null },
    defectSubject: {
      detectorId: subject?.detectorId ?? null,
      protectedPath: subject?.protectedPath ?? null,
      producerPath: subject?.producerPath ?? null
    },
    manifestations: sortManifestations(Array.isArray(manifestations) ? manifestations : [])
  });
}

/**
 * Recompute the residual from the repository below `root`. Read-only.
 *
 * `validatePresentConsistency` runs the canonical validator twice — LEDGER_INTEGRITY
 * and FULL — with the Wheel policy, and returns exactly the FULL findings that
 * INTEGRITY does not report. That difference is the present-state residual; it is
 * not re-derived here. A validator that throws has not said "valid": the residual
 * is then unevaluable, and unevaluable is never eligible.
 */
export function deriveMaintenanceRepairResidual({ root }) {
  const ledgerPath = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
  const executedValidator = readRepoFile(EXECUTING_REPO_ROOT, RESIDUAL_VALIDATOR_PATH);
  const rootValidator = readRepoFile(root, RESIDUAL_VALIDATOR_PATH);
  const validator = {
    path: RESIDUAL_VALIDATOR_PATH,
    sha256: executedValidator ? sha256Bytes(executedValidator) : null,
    rootSha256: rootValidator ? sha256Bytes(rootValidator) : null
  };
  if (!fs.existsSync(ledgerPath) || !fs.statSync(ledgerPath).isFile()) {
    return { evaluable: false, reason: 'CANONICAL_LEDGER_ABSENT', validator, subjects: [], blockingCount: 0 };
  }
  let report;
  try {
    report = validatePresentConsistency({ root, ledgerPath, policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  } catch (error) {
    return { evaluable: false, reason: 'RESIDUAL_UNEVALUABLE', detail: error?.message || String(error), validator, subjects: [], blockingCount: 0 };
  }
  const integrityBlocking = (report.integrityFindings ?? []).filter((entry) => entry?.severity === 'BLOCKING');
  const normalized = normalizeResidualFindings(report.presentFindings);
  return {
    evaluable: true,
    reason: null,
    ledgerIntegrityValid: report.ledgerIntegrityValid === true && integrityBlocking.length === 0,
    integrityBlockingDetectors: [...new Set(integrityBlocking.map((entry) => entry.detectorId))].sort(),
    eventCount: report.eventCount,
    ledgerSha256: report.ledgerSha256,
    validator,
    subjects: normalized.subjects,
    blockingCount: normalized.blockingCount
  };
}

/**
 * Exact paths and gate roots a repair of the residual would have to touch: each
 * subject's protected path and producer, the validator whose output defines the
 * residual, and the governance root of every manifesting gate.
 */
function residualClosureSurface(residual) {
  const exact = new Set([RESIDUAL_VALIDATOR_PATH]);
  const prefixes = new Set();
  for (const entry of residual.subjects ?? []) {
    if (entry.subject.protectedPath) exact.add(entry.subject.protectedPath);
    if (entry.subject.producerPath) exact.add(entry.subject.producerPath);
    for (const manifestation of entry.manifestations) {
      if (typeof manifestation.gateId === 'string' && /^GATE[0-9]{2}$/.test(manifestation.gateId)) prefixes.add(`governance/gates/${manifestation.gateId}/`);
    }
  }
  return { exact, prefixes };
}

/* ------------------------------------------------------------------------ */
/* DOCUMENT SHAPES                                                            */
/* ------------------------------------------------------------------------ */

function schemaFindings(findings, code, instance, schema) {
  const result = validateAgainstJsonSchema(instance, schema);
  for (const error of result.errors) finding(findings, code, `${error.jsonPointer}:${error.reason}`);
  return result.valid;
}

/**
 * Authority shape: the closed schema, plus named findings for the E5/E7 denials
 * and the recursion/genesis denials so a refusal says which permission was claimed.
 */
export function validateMaintenanceRepairBootstrapAuthorityShape(authority) {
  const findings = [];
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    finding(findings, 'BOOTSTRAP_AUTHORITY_UNREADABLE');
    return { valid: false, findings };
  }
  if (authority.maxUse !== 1) finding(findings, 'BOOTSTRAP_E5_MAX_USE_INVALID', authority.maxUse ?? null);
  if (authority.pushAuthorized !== false) finding(findings, 'BOOTSTRAP_E7_PUSH_AUTHORIZED');
  if (authority.genesisAuthorized !== false) finding(findings, 'BOOTSTRAP_GENESIS_NOT_PERMITTED');
  if (authority.recursiveBootstrapAuthorized !== false) finding(findings, 'BOOTSTRAP_RECURSION_NOT_PERMITTED');
  for (const field of ['grantsPresentStateTrust', 'grantsFastGateExemption', 'derivedFromFinalGateIntegrityFindings']) {
    if (authority[field] !== false) finding(findings, 'BOOTSTRAP_AUTHORITY_DENIAL_MISSING', field);
  }
  if (authority.closureObligation !== BOOTSTRAP_CLOSURE_OBLIGATION) finding(findings, 'BOOTSTRAP_CLOSURE_OBLIGATION_INVALID', authority.closureObligation ?? null);
  schemaFindings(findings, 'BOOTSTRAP_AUTHORITY_SCHEMA_INVALID', authority, loadSchemas().authority);
  return { valid: findings.length === 0, findings };
}

/** Owner decision shape. Closed field set, enforced here; the decision grants nothing by itself. */
export function validateMaintenanceRepairBootstrapOwnerDecisionShape(decision) {
  const findings = [];
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_UNREADABLE');
    return { valid: false, findings };
  }
  for (const key of Object.keys(decision)) {
    if (!BOOTSTRAP_OWNER_DECISION_FIELDS.includes(key)) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_UNKNOWN_FIELD', key);
  }
  for (const key of BOOTSTRAP_OWNER_DECISION_FIELDS) {
    if (!Object.hasOwn(decision, key)) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_FIELD_MISSING', key);
  }
  if (decision.document !== BOOTSTRAP_OWNER_DECISION_DOCUMENT) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_DOCUMENT_INVALID');
  if (decision.schemaVersion !== 1) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_SCHEMA_VERSION_INVALID');
  if (!TOKEN_RE.test(decision.decisionId ?? '')) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_ID_INVALID');
  if (decision.issuedBy !== 'PROJECT_OWNER') finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_ISSUER_INVALID');
  if (decision.authorityMode !== BOOTSTRAP_AUTHORITY_MODE) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_MODE_INVALID');
  if (!ISO_UTC_RE.test(decision.decidedAt ?? '')) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_TIME_INVALID');
  if (!TOKEN_RE.test(decision.programId ?? '')) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_PROGRAM_INVALID');
  if (!TOKEN_RE.test(decision.bootstrapAuthorityId ?? '')) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_AUTHORITY_ID_INVALID');
  const subject = decision.defectSubject;
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)
      || Object.keys(subject).some((key) => !DEFECT_SUBJECT_FIELDS.includes(key))
      || DEFECT_SUBJECT_FIELDS.some((key) => typeof subject[key] !== 'string' || !subject[key])) {
    finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_SUBJECT_INVALID');
  }
  if (!SHA256_RE.test(decision.residualIdentitySha256 ?? '')) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_RESIDUAL_INVALID');
  if (!isExactMaintenancePath(decision.repairManifestPath)) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_MANIFEST_PATH_INVALID');
  if (!SHA256_RE.test(decision.repairManifestSha256 ?? '')) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_MANIFEST_SHA_INVALID');
  if (typeof decision.decisionStatement !== 'string' || !decision.decisionStatement) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_STATEMENT_INVALID');
  return { valid: findings.length === 0, findings };
}

/** Receipt shape: the closed consumption schema. */
export function validateMaintenanceRepairBootstrapConsumptionShape(record) {
  const findings = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    finding(findings, 'BOOTSTRAP_RECEIPT_UNREADABLE');
    return { valid: false, findings };
  }
  schemaFindings(findings, 'BOOTSTRAP_RECEIPT_SCHEMA_INVALID', record, loadSchemas().consumption);
  return { valid: findings.length === 0, findings };
}

/* ------------------------------------------------------------------------ */
/* ELIGIBILITY                                                                */
/* ------------------------------------------------------------------------ */

function notRequired(applicability, extra = {}) {
  return {
    document: BOOTSTRAP_EVALUATOR_DOCUMENT, version: BOOTSTRAP_EVALUATOR_VERSION,
    applicability, eligible: null, findings: [], ...extra
  };
}

/**
 * THE ELIGIBILITY DECISION.
 *
 * APPLICABILITY first, because the boundary must not change the law for
 * publications it does not concern:
 *
 *   NOT_APPLICABLE  the ledger below `root` is not an intact canonical history
 *                   (unit fixtures, candidate trees) and the program shows no
 *                   bootstrap signal — the existing V2 law applies unchanged
 *   NOT_REQUIRED    the ledger is intact, the program shows no bootstrap signal,
 *                   and it does not touch the closure surface of a non-empty
 *                   residual. An empty residual never makes a signal NOT_REQUIRED.
 *   REQUIRED        anything else — and then every clause below must hold
 *
 * A bootstrap signal is: a manifest path on the protected control surface, a
 * recursive bootstrap path, this program's own receipt path, or a present
 * authority, Owner decision or receipt at the derived paths. A signal on a ledger
 * that is not intact is REQUIRED (and therefore refused at E1): trust machinery is
 * never touched on a history nobody could validate.
 *
 * Reads the repository below `root`; writes nothing.
 */
export function evaluateMaintenanceRepairBootstrapEligibility({
  root, v2Authority, v2AuthorityPath = null, manifest, manifestSha256, now = new Date()
}) {
  const programId = v2Authority?.programId ?? null;
  const paths = deriveMaintenanceRepairBootstrapPaths(programId);
  if (!paths) {
    return { ...notRequired(BOOTSTRAP_REQUIRED), eligible: false, findings: [{ code: 'BOOTSTRAP_PROGRAM_ID_INVALID', detail: programId }] };
  }
  const manifestEntries = Array.isArray(manifest?.paths) ? manifest.paths : [];
  const manifestPaths = manifestEntries.map((entry) => entry?.path);
  const { controlSurfaceHits, recursiveHits } = classifyBootstrapManifestPaths({ programId, manifestPaths });
  const receiptEntry = manifestEntries.find((entry) => entry?.path === paths.receiptPath) ?? null;

  const authorityBytes = readRepoFile(root, paths.authorityPath);
  const decisionBytes = readRepoFile(root, paths.ownerDecisionPath);
  const receiptBytes = readRepoFile(root, paths.receiptPath);
  const documentSignal = authorityBytes !== null || decisionBytes !== null || receiptBytes !== null || receiptEntry !== null;
  const signal = documentSignal || controlSurfaceHits.length > 0 || recursiveHits.length > 0;

  const residual = deriveMaintenanceRepairResidual({ root });
  const residualSummary = {
    evaluable: residual.evaluable, ledgerIntegrityValid: residual.ledgerIntegrityValid ?? false,
    subjectCount: residual.subjects.length, blockingCount: residual.blockingCount
  };
  const base = { paths, residualSummary, controlSurfaceHits, recursiveHits };

  let applicability;
  if (!residual.evaluable || !residual.ledgerIntegrityValid) {
    applicability = signal ? BOOTSTRAP_REQUIRED : BOOTSTRAP_NOT_APPLICABLE;
  } else if (residual.blockingCount === 0) {
    // An empty residual is not a licence to touch the trust machinery. A program
    // on the protected control surface is REQUIRED here exactly as it is on a
    // non-empty residual, and E4 then refuses it: after Genesis the surface is never
    // ordinary maintenance. There is no Genesis exception in this evaluator; Genesis
    // is published by the previous publisher, which does not call it.
    applicability = signal ? BOOTSTRAP_REQUIRED : BOOTSTRAP_NOT_REQUIRED;
  } else {
    const closure = residualClosureSurface(residual);
    const touchesClosure = manifestPaths.some((candidate) => typeof candidate === 'string'
      && (closure.exact.has(candidate) || [...closure.prefixes].some((prefix) => candidate.startsWith(prefix))));
    applicability = signal || touchesClosure ? BOOTSTRAP_REQUIRED : BOOTSTRAP_NOT_REQUIRED;
  }
  if (applicability !== BOOTSTRAP_REQUIRED) return notRequired(applicability, base);

  const findings = [];

  // ---- E1 -----------------------------------------------------------------
  if (!residual.evaluable) finding(findings, 'BOOTSTRAP_E1_LEDGER_INTEGRITY_UNEVALUABLE', residual.reason);
  else if (!residual.ledgerIntegrityValid) finding(findings, 'BOOTSTRAP_E1_LEDGER_INTEGRITY_INVALID', residual.integrityBlockingDetectors.join(',') || null);

  // ---- AUTHORITY: presence, shape, identity --------------------------------
  let authority = null;
  if (authorityBytes === null) finding(findings, 'BOOTSTRAP_AUTHORITY_ABSENT', paths.authorityPath);
  else {
    authority = parseJsonBytes(authorityBytes);
    const shape = validateMaintenanceRepairBootstrapAuthorityShape(authority);
    findings.push(...shape.findings);
    if (authority && typeof authority === 'object') {
      // A document at the derived path that names another identity is a
      // conflicting candidate, not a second chance: it is refused, never re-resolved.
      if (authority.authorityId !== paths.authorityId) finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'authorityId');
      if (authority.programId !== programId) finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'programId');
      if (authority.ownerDecisionPath !== paths.ownerDecisionPath) finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'ownerDecisionPath');
      if (authority.receiptPath !== paths.receiptPath) finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'receiptPath');
    }
  }
  const authorityValid = authority && typeof authority === 'object' && !Array.isArray(authority);

  // ---- PRE-STATE: equal to the V2 authority AND to the live repository -----
  const gateId = v2Authority?.preState?.gateId ?? null;
  let live = null;
  try { live = observeCanonicalPreState(root, gateId); } catch { live = null; }
  if (authorityValid) {
    for (const field of PRE_STATE_FIELDS) {
      if (authority.preState?.[field] !== v2Authority?.preState?.[field]) finding(findings, 'BOOTSTRAP_PRESTATE_V2_MISMATCH', field);
    }
    for (const field of LIVE_PRE_STATE_FIELDS) {
      if (live?.[field] !== authority.preState?.[field]) finding(findings, 'BOOTSTRAP_PRESTATE_LIVE_MISMATCH', field);
    }
  }

  // ---- E8 -----------------------------------------------------------------
  if (readRepoFile(root, R8_CONTRACT_PATH) !== null) finding(findings, 'BOOTSTRAP_E8_R8_PRESENT');

  // ---- E2 / E9 --------------------------------------------------------------
  let recomputedResidualIdentity = null;
  let matched = null;
  if (residual.evaluable) {
    if (residual.subjects.length === 0) finding(findings, 'BOOTSTRAP_E2_RESIDUAL_ABSENT');
    if (residual.subjects.length > 1) finding(findings, 'BOOTSTRAP_E2_MULTIPLE_DEFECT_SUBJECTS', residual.subjects.length);
    if (authorityValid && authority.defectSubject && typeof authority.defectSubject === 'object') {
      const authorizedKey = defectSubjectKey(authority.defectSubject);
      matched = residual.subjects.find((entry) => entry.key === authorizedKey) ?? null;
      if (!matched && residual.subjects.length > 0) finding(findings, 'BOOTSTRAP_E2_SUBJECT_MISMATCH', authorizedKey);
      for (const entry of residual.subjects) {
        if (entry.key !== authorizedKey) finding(findings, 'BOOTSTRAP_E9_BLOCKING_FINDING_OUTSIDE_SUBJECT', entry.key);
      }
    }
    // The executed validator must be the one the repository carries.
    if (residual.validator.sha256 === null || residual.validator.rootSha256 !== residual.validator.sha256) {
      finding(findings, 'BOOTSTRAP_E2_VALIDATOR_NOT_EXECUTED_BYTES', RESIDUAL_VALIDATOR_PATH);
    }
    if (matched) {
      const producerPath = matched.subject.producerPath;
      const executedProducer = readRepoFile(EXECUTING_REPO_ROOT, producerPath);
      const rootProducer = readRepoFile(root, producerPath);
      const producerSha256 = executedProducer ? sha256Bytes(executedProducer) : null;
      if (producerSha256 === null || !rootProducer || sha256Bytes(rootProducer) !== producerSha256) {
        finding(findings, 'BOOTSTRAP_E2_PRODUCER_NOT_EXECUTED_BYTES', producerPath);
      }
      if (authority.defectSubject.producerBlobSha256 !== producerSha256) finding(findings, 'BOOTSTRAP_E2_PRODUCER_BLOB_MISMATCH', producerPath);
      recomputedResidualIdentity = computeResidualIdentity({
        validator: residual.validator,
        baseHead: live?.baseHead ?? null,
        ledgerEventCount: residual.eventCount,
        ledgerPrefixSha256: residual.ledgerSha256,
        producer: { path: producerPath, sha256: producerSha256 },
        subject: matched.subject,
        manifestations: matched.manifestations
      });
      if (authority.residualIdentitySha256 !== recomputedResidualIdentity) finding(findings, 'BOOTSTRAP_E2_RESIDUAL_IDENTITY_MISMATCH');
    }
  }

  // ---- E3 -------------------------------------------------------------------
  if (decisionBytes === null) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_ABSENT', paths.ownerDecisionPath);
  else {
    const decision = parseJsonBytes(decisionBytes);
    const shape = validateMaintenanceRepairBootstrapOwnerDecisionShape(decision);
    findings.push(...shape.findings);
    if (authorityValid && authority.ownerDecisionSha256 !== sha256Bytes(decisionBytes)) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_DIGEST_MISMATCH');
    if (decision && typeof decision === 'object' && authorityValid) {
      const bindings = [
        ['programId', decision.programId, programId],
        ['bootstrapAuthorityId', decision.bootstrapAuthorityId, paths.authorityId],
        ['residualIdentitySha256', decision.residualIdentitySha256, authority.residualIdentitySha256],
        ['repairManifestPath', decision.repairManifestPath, authority.repairManifestPath],
        ['repairManifestSha256', decision.repairManifestSha256, authority.repairManifestSha256]
      ];
      for (const field of DEFECT_SUBJECT_FIELDS) bindings.push([`defectSubject.${field}`, decision.defectSubject?.[field], authority.defectSubject?.[field]]);
      for (const [field, actual, expected] of bindings) {
        if (actual !== expected) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_BINDING_MISMATCH', field);
      }
      if (recomputedResidualIdentity !== null && decision.residualIdentitySha256 !== recomputedResidualIdentity) {
        finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_BINDING_MISMATCH', 'residualIdentitySha256:recomputed');
      }
      // CAUSAL ORDER. The decision precedes the repair authority, and both precede
      // publication. A decision dated after either describes a mutation already made.
      const decidedAt = Date.parse(decision.decidedAt ?? '');
      const authorizedAt = Date.parse(v2Authority?.createdAt ?? '');
      if (Number.isNaN(decidedAt) || Number.isNaN(authorizedAt) || decidedAt > authorizedAt) {
        finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_NOT_CAUSALLY_PRIOR', 'V2_AUTHORITY_CREATED_AT');
      }
      if (!Number.isNaN(decidedAt) && decidedAt > now.getTime()) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_NOT_CAUSALLY_PRIOR', 'NOW');
    }
  }
  if (manifestPaths.includes(paths.ownerDecisionPath)) finding(findings, 'BOOTSTRAP_E3_OWNER_DECISION_WRITTEN_BY_REPAIR', paths.ownerDecisionPath);

  // ---- E4 -------------------------------------------------------------------
  if (authorityValid) {
    if (authority.repairManifestPath !== v2Authority?.authorizedPathManifestPath) finding(findings, 'BOOTSTRAP_E4_MANIFEST_PATH_MISMATCH');
    if (authority.repairManifestSha256 !== manifestSha256 || authority.repairManifestSha256 !== v2Authority?.authorizedPathManifestSha256) {
      finding(findings, 'BOOTSTRAP_E4_MANIFEST_DIGEST_MISMATCH');
    }
  }
  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, programId, v2Authority?.authorityPurpose);
  if (!manifestResult.valid || !manifestResult.bindsPrestate) finding(findings, 'BOOTSTRAP_E4_MANIFEST_NOT_CLOSED', manifestResult.findings?.[0]?.code ?? 'SCHEMA_VERSION');
  for (const candidate of manifestPaths) if (!isExactMaintenancePath(candidate)) finding(findings, 'BOOTSTRAP_E4_MANIFEST_PATH_NOT_EXACT', candidate ?? null);
  for (const hit of controlSurfaceHits) finding(findings, 'BOOTSTRAP_E4_PROTECTED_CONTROL_SURFACE', hit);
  for (const hit of recursiveHits) finding(findings, 'BOOTSTRAP_RECURSIVE_BOOTSTRAP_PATH', hit);
  if (!receiptEntry || receiptEntry.operation !== 'CREATE' || receiptEntry.prestate?.state !== PRESTATE_ABSENT) {
    finding(findings, 'BOOTSTRAP_E4_RECEIPT_NOT_RESERVED', paths.receiptPath);
  }
  if (paths.receiptPath === v2Authority?.consumptionRecordPath) finding(findings, 'BOOTSTRAP_E4_RECEIPT_COLLIDES_WITH_V2_RECEIPT');
  if (v2AuthorityPath && (v2AuthorityPath === paths.authorityPath || v2AuthorityPath === paths.ownerDecisionPath)) {
    finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'v2AuthorityPath');
  }

  // ---- E6 / E7 ----------------------------------------------------------------
  if (receiptBytes !== null) finding(findings, 'BOOTSTRAP_E6_RECEIPT_ALREADY_PRESENT', paths.receiptPath);
  if (v2Authority?.pushAuthorized !== false) finding(findings, 'BOOTSTRAP_E7_PUSH_AUTHORIZED', 'V2_AUTHORITY');

  const eligible = findings.length === 0;
  return {
    document: BOOTSTRAP_EVALUATOR_DOCUMENT, version: BOOTSTRAP_EVALUATOR_VERSION,
    applicability, eligible, findings, ...base,
    subject: matched?.subject ?? null,
    residualIdentitySha256: recomputedResidualIdentity,
    bootstrapAuthority: eligible
      ? { path: paths.authorityPath, sha256: sha256Bytes(authorityBytes), authorityId: authority.authorityId, document: authority }
      : null
  };
}

/* ------------------------------------------------------------------------ */
/* RECEIPT                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Compose the bootstrap receipt. Pure. Composed BEFORE the V2 receipt and without
 * any reference to the V2 receipt's bytes, so the V2 receipt can certify this
 * receipt's digest in its cohort with no cycle.
 */
export function composeMaintenanceRepairBootstrapConsumption({
  eligibility, v2Authority, manifestSha256, transactionId, recordedAt, publicationAdmission
}) {
  const authority = eligibility?.bootstrapAuthority?.document;
  if (eligibility?.eligible !== true || !authority) throw new Error('BOOTSTRAP_RECEIPT_REQUIRES_ELIGIBILITY');
  if (!publicationAdmission) throw new Error('BOOTSTRAP_RECEIPT_REQUIRES_PUBLICATION_ADMISSION');
  return {
    document: BOOTSTRAP_CONSUMPTION_DOCUMENT,
    schemaVersion: 1,
    bootstrapAuthorityId: authority.authorityId,
    bootstrapAuthorityPath: eligibility.bootstrapAuthority.path,
    bootstrapAuthoritySha256: eligibility.bootstrapAuthority.sha256,
    programId: v2Authority.programId,
    repairManifestPath: v2Authority.authorizedPathManifestPath,
    repairManifestSha256: manifestSha256,
    baseHead: v2Authority.preState.baseHead,
    residualIdentitySha256: eligibility.residualIdentitySha256,
    v2ConsumptionRecordPath: v2Authority.consumptionRecordPath,
    v2AuthorityId: v2Authority.authorityId,
    transactionId,
    publicationAdmission: {
      admissionId: publicationAdmission.admissionId,
      admissionPath: publicationAdmission.admissionPath,
      admissionSha256: publicationAdmission.admissionSha256
    },
    recordedAt,
    consumedUse: 1,
    closureObligation: BOOTSTRAP_CLOSURE_OBLIGATION
  };
}

/**
 * THE REPLAY LAW's coherence test. The bootstrap receipt and the V2 receipt are one
 * publication's two halves; they are coherent only when every shared fact agrees and
 * the V2 cohort certifies the exact bytes of the bootstrap receipt on disk.
 *
 * Reads the two receipts and the bootstrap authority below `root`. Writes nothing
 * and repairs nothing: an incoherent pair is reported, never reconciled.
 */
export function validateMaintenanceRepairBootstrapReceiptPair({ root, v2Authority, v2ConsumptionRecord }) {
  const findings = [];
  const paths = deriveMaintenanceRepairBootstrapPaths(v2Authority?.programId);
  if (!paths) return { coherent: false, findings: [{ code: 'BOOTSTRAP_PROGRAM_ID_INVALID' }] };
  const receiptBytes = readRepoFile(root, paths.receiptPath);
  if (receiptBytes === null) {
    finding(findings, 'BOOTSTRAP_RECEIPT_ABSENT', paths.receiptPath);
    return { coherent: false, findings };
  }
  const receipt = parseJsonBytes(receiptBytes);
  findings.push(...validateMaintenanceRepairBootstrapConsumptionShape(receipt).findings);
  const authorityBytes = readRepoFile(root, paths.authorityPath);
  const authority = authorityBytes ? parseJsonBytes(authorityBytes) : null;
  if (!authority) finding(findings, 'BOOTSTRAP_RECEIPT_AUTHORITY_ABSENT', paths.authorityPath);
  const v2 = v2ConsumptionRecord;
  if (!v2 || typeof v2 !== 'object') finding(findings, 'BOOTSTRAP_RECEIPT_V2_RECEIPT_ABSENT', v2Authority?.consumptionRecordPath ?? null);
  if (receipt && typeof receipt === 'object') {
    const expect = [
      ['bootstrapAuthorityId', receipt.bootstrapAuthorityId, paths.authorityId],
      ['bootstrapAuthorityPath', receipt.bootstrapAuthorityPath, paths.authorityPath],
      ['bootstrapAuthoritySha256', receipt.bootstrapAuthoritySha256, authorityBytes ? sha256Bytes(authorityBytes) : null],
      ['programId', receipt.programId, v2Authority.programId],
      ['repairManifestPath', receipt.repairManifestPath, v2Authority.authorizedPathManifestPath],
      ['repairManifestSha256', receipt.repairManifestSha256, v2Authority.authorizedPathManifestSha256],
      ['baseHead', receipt.baseHead, v2Authority.preState?.baseHead],
      ['v2ConsumptionRecordPath', receipt.v2ConsumptionRecordPath, v2Authority.consumptionRecordPath],
      ['v2AuthorityId', receipt.v2AuthorityId, v2Authority.authorityId]
    ];
    if (authority) {
      expect.push(['residualIdentitySha256', receipt.residualIdentitySha256, authority.residualIdentitySha256]);
      expect.push(['authority.receiptPath', authority.receiptPath, paths.receiptPath]);
    }
    if (v2 && typeof v2 === 'object') {
      expect.push(['transactionId', receipt.transactionId, v2.transactionId]);
      expect.push(['recordedAt', receipt.recordedAt, v2.recordedAt]);
      expect.push(['v2.authorityId', v2.authorityId, v2Authority.authorityId]);
      expect.push(['v2.programId', v2.programId, v2Authority.programId]);
      expect.push(['v2.manifestSha256', v2.manifestSha256, receipt.repairManifestSha256]);
      expect.push(['publicationAdmission', canonicalize(receipt.publicationAdmission ?? null), canonicalize(v2.publicationAdmission ?? null)]);
      const certified = (Array.isArray(v2.cohort) ? v2.cohort : []).find((entry) => entry?.path === paths.receiptPath) ?? null;
      if (!certified) finding(findings, 'BOOTSTRAP_RECEIPT_NOT_CERTIFIED_BY_V2_COHORT', paths.receiptPath);
      else {
        if (certified.sha256 !== sha256Bytes(receiptBytes)) finding(findings, 'BOOTSTRAP_RECEIPT_V2_COHORT_DIGEST_MISMATCH', paths.receiptPath);
        if (certified.byteLength !== receiptBytes.length) finding(findings, 'BOOTSTRAP_RECEIPT_V2_COHORT_LENGTH_MISMATCH', paths.receiptPath);
      }
    }
    for (const [field, actual, expected] of expect) {
      if (actual !== expected) finding(findings, 'BOOTSTRAP_RECEIPT_MISMATCH', field);
    }
  }
  return { coherent: findings.length === 0, findings, receiptPath: paths.receiptPath };
}

/* ------------------------------------------------------------------------ */
/* GENESIS CANDIDATE CHECK                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Is `manifest` exactly the Owner-authorized Genesis cohort? Pure and descriptive:
 * it is used to check the candidate and to prove a second Genesis cannot reuse the
 * shape. It authorizes nothing, and no publisher consults it to grant anything.
 *
 * The publisher succession is required, as MODIFY with a PRESENT pre-state equal to
 * `publisherPrestate` (the committed blob at Genesis baseHead). A Genesis without
 * it would install an evaluator that no publisher ever calls.
 */
export function validateMaintenanceBootstrapGenesisCohort({ manifest, publisherPrestate, genesisConsumptionPresent = false }) {
  const findings = [];
  if (genesisConsumptionPresent) finding(findings, 'BOOTSTRAP_GENESIS_ALREADY_CONSUMED', BOOTSTRAP_GENESIS_CONSUMPTION_PATH);
  if (manifest?.programId !== BOOTSTRAP_GENESIS_PROGRAM_ID) finding(findings, 'BOOTSTRAP_GENESIS_PROGRAM_MISMATCH', manifest?.programId ?? null);
  const entries = Array.isArray(manifest?.paths) ? manifest.paths : [];
  const byPath = new Map(entries.map((entry) => [entry?.path, entry]));
  const expected = [...BOOTSTRAP_GENESIS_CREATE_PATHS, BOOTSTRAP_GENESIS_PUBLISHER_PATH];
  for (const candidate of entries.map((entry) => entry?.path)) {
    if (!expected.includes(candidate)) finding(findings, 'BOOTSTRAP_GENESIS_UNEXPECTED_PATH', candidate ?? null);
  }
  for (const createPath of BOOTSTRAP_GENESIS_CREATE_PATHS) {
    const entry = byPath.get(createPath);
    if (!entry) finding(findings, 'BOOTSTRAP_GENESIS_PATH_MISSING', createPath);
    else if (entry.operation !== 'CREATE' || entry.prestate?.state !== PRESTATE_ABSENT) finding(findings, 'BOOTSTRAP_GENESIS_CREATE_PRESTATE_INVALID', createPath);
  }
  const publisher = byPath.get(BOOTSTRAP_GENESIS_PUBLISHER_PATH);
  if (!publisher) finding(findings, 'BOOTSTRAP_GENESIS_PUBLISHER_SUCCESSION_MISSING', BOOTSTRAP_GENESIS_PUBLISHER_PATH);
  else if (publisher.operation !== 'MODIFY' || publisher.prestate?.state !== PRESTATE_PRESENT
      || publisher.prestate?.sha256 !== publisherPrestate?.sha256 || publisher.prestate?.byteLength !== publisherPrestate?.byteLength) {
    finding(findings, 'BOOTSTRAP_GENESIS_PUBLISHER_SUCCESSION_INVALID', BOOTSTRAP_GENESIS_PUBLISHER_PATH);
  }
  const exclusions = new Map((Array.isArray(manifest?.prestateSelfExclusion) ? manifest.prestateSelfExclusion : []).map((entry) => [entry?.role, entry?.path]));
  if (exclusions.get('AUTHORITY_DOCUMENT') !== BOOTSTRAP_GENESIS_AUTHORITY_PATH) finding(findings, 'BOOTSTRAP_GENESIS_SELF_EXCLUSION_INVALID', 'AUTHORITY_DOCUMENT');
  if (exclusions.get('AUTHORIZED_PATH_MANIFEST') !== BOOTSTRAP_GENESIS_MANIFEST_PATH) finding(findings, 'BOOTSTRAP_GENESIS_SELF_EXCLUSION_INVALID', 'AUTHORIZED_PATH_MANIFEST');
  return { valid: findings.length === 0, findings };
}

/* ------------------------------------------------------------------------ */
/* CLOSURE OBLIGATION                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The canonical invoker: the UNCHANGED Generic Fast Gate, loaded only when a
 * closure is actually attempted (never at import time, never for eligibility).
 */
export async function invokeCanonicalFastGate({ root, gateId, phase = 'READINESS', ...options }) {
  const { runFastPathControlPlane } = await import('../../tools/gate-fast-path-control-plane.mjs');
  return runFastPathControlPlane({ ...options, root, gateId, phase });
}

/**
 * THE CONSUMPTION PROOF a closure requires before it may invoke anything. A
 * bootstrap receipt alone proves nothing: it is one half of a publication, and a
 * lone or forged half must not reach the Fast Gate. Consumption is proven only by
 * the whole chain, each link resolved by literal path, never by a directory scan:
 *
 *   bootstrap receipt   present, closed-schema valid, for this programId
 *   bootstrap authority present at the derived path, shape-valid, naming this
 *                       authorityId, programId and receipt path
 *   repair manifest     present at the authority's repairManifestPath, with the
 *                       digest the authority binds, for this programId
 *   V2 authority        the manifest's single AUTHORITY_DOCUMENT self-exclusion —
 *                       the V2 law requires it to be the document it evaluated —
 *                       for this programId and bound to this manifest; valid under
 *                       the canonical V2 authority shape, with the manifest valid
 *                       under the canonical manifest law for this programId and the
 *                       authority's purpose
 *   V2 receipt          present at the V2 authority's consumptionRecordPath,
 *                       coherent under the canonical validateConsumptionRecordCoherence,
 *                       and certifying the exact bytes of the V2 authority and manifest
 *   the pair            validateMaintenanceRepairBootstrapReceiptPair: coherent
 *
 * The V2 documents are judged by the CANONICAL V2 validators, never by a restated
 * subset of them: a second implementation of "is this a valid V2 consumption" is
 * how a closure could accept a receipt the V2 law rejects. The drift-independent
 * half only, as the admissibility cohort asks it: occupancy and the AUTHORIZE-time
 * pre-state describe the repository at other moments, and a consumed program must
 * not be re-judged against a state its own publication moved past.
 *
 * Read-only. Stops at the first missing link: a later link is not resolved from an
 * earlier one that failed. Repairs nothing and infers nothing.
 */
function proveMaintenanceRepairBootstrapConsumption({ root, programId }) {
  const findings = [];
  const refused = () => ({ proven: false, findings });
  const paths = deriveMaintenanceRepairBootstrapPaths(programId);
  if (!paths) { finding(findings, 'BOOTSTRAP_PROGRAM_ID_INVALID', programId ?? null); return refused(); }

  const receiptBytes = readRepoFile(root, paths.receiptPath);
  if (receiptBytes === null) { finding(findings, 'BOOTSTRAP_RECEIPT_ABSENT', paths.receiptPath); return refused(); }
  const receipt = parseJsonBytes(receiptBytes);
  findings.push(...validateMaintenanceRepairBootstrapConsumptionShape(receipt).findings);
  if (receipt?.programId !== programId) finding(findings, 'BOOTSTRAP_CLOSURE_RECEIPT_PROGRAM_MISMATCH', paths.receiptPath);
  if (findings.length > 0) return refused();

  const authorityBytes = readRepoFile(root, paths.authorityPath);
  if (authorityBytes === null) { finding(findings, 'BOOTSTRAP_AUTHORITY_ABSENT', paths.authorityPath); return refused(); }
  const authority = parseJsonBytes(authorityBytes);
  findings.push(...validateMaintenanceRepairBootstrapAuthorityShape(authority).findings);
  if (authority && typeof authority === 'object' && !Array.isArray(authority)) {
    if (authority.authorityId !== paths.authorityId) finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'authorityId');
    if (authority.programId !== programId) finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'programId');
    if (authority.receiptPath !== paths.receiptPath) finding(findings, 'BOOTSTRAP_AUTHORITY_IDENTITY_CONFLICT', 'receiptPath');
  }
  if (findings.length > 0) return refused();

  const manifestBytes = readRepoFile(root, authority.repairManifestPath);
  if (manifestBytes === null) { finding(findings, 'BOOTSTRAP_CLOSURE_MANIFEST_ABSENT', authority.repairManifestPath); return refused(); }
  const manifestSha256 = sha256Bytes(manifestBytes);
  const manifest = parseJsonBytes(manifestBytes);
  if (manifestSha256 !== authority.repairManifestSha256) finding(findings, 'BOOTSTRAP_CLOSURE_MANIFEST_DIGEST_MISMATCH', authority.repairManifestPath);
  if (manifest?.programId !== programId) finding(findings, 'BOOTSTRAP_CLOSURE_MANIFEST_PROGRAM_MISMATCH', authority.repairManifestPath);
  const declared = (Array.isArray(manifest?.prestateSelfExclusion) ? manifest.prestateSelfExclusion : [])
    .filter((entry) => entry?.role === 'AUTHORITY_DOCUMENT');
  const v2AuthorityPath = declared.length === 1 ? declared[0].path : null;
  if (!isExactMaintenancePath(v2AuthorityPath)
      || !(Array.isArray(manifest?.paths) ? manifest.paths : []).some((entry) => entry?.path === v2AuthorityPath)
      || v2AuthorityPath === paths.authorityPath || v2AuthorityPath === paths.ownerDecisionPath) {
    finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_UNRESOLVED', authority.repairManifestPath);
  }
  if (findings.length > 0) return refused();

  const v2AuthorityBytes = readRepoFile(root, v2AuthorityPath);
  if (v2AuthorityBytes === null) { finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_ABSENT', v2AuthorityPath); return refused(); }
  const v2Authority = parseJsonBytes(v2AuthorityBytes);
  if (!v2Authority || typeof v2Authority !== 'object' || Array.isArray(v2Authority)) {
    finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_UNREADABLE', v2AuthorityPath);
    return refused();
  }
  if (v2Authority.programId !== programId) finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_MISMATCH', 'programId');
  if (v2Authority.authorizedPathManifestPath !== authority.repairManifestPath) finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_MISMATCH', 'authorizedPathManifestPath');
  if (v2Authority.authorizedPathManifestSha256 !== manifestSha256) finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_MISMATCH', 'authorizedPathManifestSha256');
  if (!isExactMaintenancePath(v2Authority.consumptionRecordPath)) finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_MISMATCH', 'consumptionRecordPath');
  // Both before the receipt is read: canonical coherence dereferences the
  // authority's pre-state and commit policy and every manifest entry.
  const v2Shape = validatePostFreezeMaintenanceAuthorityV2Shape(v2Authority);
  findings.push(...v2Shape.findings);
  if (!v2Shape.valid) finding(findings, 'BOOTSTRAP_CLOSURE_V2_AUTHORITY_INVALID', v2AuthorityPath);
  const manifestResult = validateMaintenanceAuthorizedPathManifest(
    manifest, programId, v2Authority.authorityPurpose ?? POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_NORMAL
  );
  findings.push(...manifestResult.findings);
  if (!manifestResult.valid || !manifestResult.bindsPrestate) finding(findings, 'BOOTSTRAP_CLOSURE_V2_MANIFEST_INVALID', authority.repairManifestPath);
  if (findings.length > 0) return refused();

  const v2ReceiptBytes = readRepoFile(root, v2Authority.consumptionRecordPath);
  if (v2ReceiptBytes === null) { finding(findings, 'BOOTSTRAP_CLOSURE_V2_RECEIPT_ABSENT', v2Authority.consumptionRecordPath); return refused(); }
  const v2Receipt = parseJsonBytes(v2ReceiptBytes);
  if (!v2Receipt || typeof v2Receipt !== 'object' || Array.isArray(v2Receipt)) {
    finding(findings, 'BOOTSTRAP_CLOSURE_V2_RECEIPT_UNREADABLE', v2Authority.consumptionRecordPath);
    return refused();
  }
  // No admission is supplied: the closure did not publish and knows none of its own.
  // The citation's shape is still canonical law here; its agreement with the
  // bootstrap receipt's citation is the pair's.
  const coherence = [];
  validateConsumptionRecordCoherence(v2Receipt, v2Authority, manifest, coherence);
  findings.push(...coherence);
  if (coherence.length > 0) finding(findings, 'BOOTSTRAP_CLOSURE_V2_RECEIPT_INCOHERENT', v2Authority.consumptionRecordPath);
  const cohort = Array.isArray(v2Receipt.cohort) ? v2Receipt.cohort : [];
  for (const [certifiedPath, bytes] of [[v2AuthorityPath, v2AuthorityBytes], [authority.repairManifestPath, manifestBytes]]) {
    const certified = cohort.find((entry) => entry?.path === certifiedPath) ?? null;
    if (!certified || certified.sha256 !== sha256Bytes(bytes) || certified.byteLength !== bytes.length) {
      finding(findings, 'BOOTSTRAP_CLOSURE_V2_COHORT_NOT_CERTIFIED', certifiedPath);
    }
  }

  const pair = validateMaintenanceRepairBootstrapReceiptPair({ root, v2Authority, v2ConsumptionRecord: v2Receipt });
  findings.push(...pair.findings);
  if (pair.coherent !== true) finding(findings, 'BOOTSTRAP_CLOSURE_RECEIPT_PAIR_INCOHERENT', paths.receiptPath);
  return findings.length === 0 ? { proven: true, findings } : refused();
}

/**
 * THE CLOSURE OBLIGATION. After a bootstrap repair is published and consumed, the
 * only thing that closes it is an ORDINARY Fast Gate PASS (`FAST_PATH_READY`),
 * obtained by invoking the unchanged Fast Gate once, now.
 *
 *   - a supplied verdict is refused: a closure must invoke, not quote
 *   - consumption is proven first, by the whole receipt chain above; an unproven
 *     consumption is refused with zero Fast Gate invocations
 *   - a verdict from any invoker other than the canonical one can demonstrate a
 *     failure but can never close
 *   - failure (a throw, or any verdict other than FAST_PATH_READY) is terminal:
 *     STOP_BOOTSTRAP_REPAIR_FAILED_TO_RESTORE_TRUST, with no retry, no successor,
 *     no rollback and no second bootstrap. The authority stays consumed.
 *
 * Writes nothing itself; whatever the Fast Gate writes is the Fast Gate's own law.
 */
export async function evaluateMaintenanceRepairBootstrapClosure({
  root, programId, gateId, phase = 'READINESS', invokeFastGate = invokeCanonicalFastGate, fastGateOptions = {}, ...unexpected
}) {
  const refusal = (code, extra = {}) => ({
    document: 'MAINTENANCE_REPAIR_BOOTSTRAP_CLOSURE', closureObligationSatisfied: false, decision: code,
    fastGateInvocations: 0, ...extra
  });
  if (Object.hasOwn(unexpected, 'fastGateResult') || Object.hasOwn(unexpected, 'fastGateVerdict') || Object.hasOwn(unexpected, 'verdict')) {
    return refusal('CLOSURE_REQUIRES_REAL_FAST_GATE_INVOCATION');
  }
  const consumption = proveMaintenanceRepairBootstrapConsumption({ root, programId });
  if (!consumption.proven) return refusal('CLOSURE_WITHOUT_CONSUMED_BOOTSTRAP', { findings: consumption.findings });
  let outcome;
  let error = null;
  try {
    outcome = await invokeFastGate({ ...fastGateOptions, root, gateId, phase });
  } catch (cause) {
    error = cause?.message || String(cause);
  }
  const verdict = error === null ? outcome?.verdict ?? null : null;
  if (verdict !== 'FAST_PATH_READY') {
    return {
      document: 'MAINTENANCE_REPAIR_BOOTSTRAP_CLOSURE', closureObligationSatisfied: false,
      decision: STOP_BOOTSTRAP_REPAIR_FAILED_TO_RESTORE_TRUST, terminal: true,
      fastGateInvocations: 1, fastGateVerdict: verdict, fastGateError: error,
      retryAuthorized: false, successorAuthorized: false, rollbackAuthorized: false, secondBootstrapAuthorized: false,
      authorityConsumed: true
    };
  }
  if (invokeFastGate !== invokeCanonicalFastGate) {
    return refusal('CLOSURE_REQUIRES_REAL_FAST_GATE_INVOCATION', { fastGateInvocations: 1, fastGateVerdict: verdict });
  }
  return {
    document: 'MAINTENANCE_REPAIR_BOOTSTRAP_CLOSURE', closureObligationSatisfied: true,
    decision: 'ORDINARY_FAST_GATE_PASS_OBSERVED', fastGateInvocations: 1, fastGateVerdict: verdict
  };
}
