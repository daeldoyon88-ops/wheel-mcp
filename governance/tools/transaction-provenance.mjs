import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { collectPostFreezeMaintenanceObservation, observeCanonicalPreState, reconstructPathPrestates } from './post-freeze-maintenance-observation.mjs';
import { evaluatePostFreezeMaintenanceAuthorityV2, PHASE_AUTHORIZE_PROGRAM_APPLY } from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import {
  evaluatePrecontractConsumptionAnchorBinding,
  isLocalPrecontractAuthority,
  PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_KIND
} from '../gee-v1/core/precontract-authority.mjs';
import {
  gateAuthorizationAuthoritySnapshotPath,
  computeGateAuthorizationBindingDigest,
  computeGateAuthorizationLocalRequestDigest
} from '../gee-v1/core/gate-authorization-authority.mjs';
import {
  gateStartAuthorityPath,
  computeGateStartRecordDigest,
  computeGateStartLocalRequestDigest,
  computeGateStartBindingDigestFromDigests
} from '../gee-v1/core/gate-start-authority.mjs';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';

/**
 * WHICH CLASS OF AUTHORITY A PENDING TRANSACTION IS BOUND TO.
 *
 * One provenance FORMAT, one validator, two authority classes — because the
 * project has two, and a transaction that could not name the one governing it
 * had to record `provenance: null`. That was the whole R6 hard-crash defect: a
 * null provenance is a journal recovery must refuse, so an anchor publication
 * interrupted by a process death left a COMMITTING transaction nothing could
 * resolve.
 *
 * The alternative — inventing a maintenance program for every anchor purely so
 * the existing binding evaluator would apply — would have added a governance
 * ceremony to a transport tool and left the real authority (the single-use anchor
 * authority the ledger validator already enforces) unbound in the journal. The
 * binding class is therefore recorded, and each class is re-verified at recovery
 * time by the canonical evaluator that already owns its semantics.
 */
export const AUTHORITY_BINDING_POST_FREEZE_MAINTENANCE = 'POST_FREEZE_MAINTENANCE_AUTHORITY';
export const AUTHORITY_BINDING_PRECONTRACT_CONSUMPTION_ANCHOR = PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_KIND;

/**
 * TWO CLASSES WAS NEVER THE WHOLE PROJECT.
 *
 * The comment above says "two authority classes — because the project has two".
 * That was false, and the falseness is what left recoverable provenance opt-in.
 * The lifecycle has FOUR authority classes, and the two that were missing are the
 * two that open every Gate:
 *
 *   AUTHORIZATION / START   governed by the Gate's own owner-issued lifecycle
 *                           authority (GATE_AUTHORIZATION_RECORD + its owner
 *                           snapshot, GATE_START_RECORD + its owner authority)
 *   PRECONTRACT_BOOTSTRAP   governed by the single-use local precontract authority
 *
 * Because no binding class named them, `createLifecycleTransactionProvenance`
 * returned null for all three — it requires an evaluated maintenance authority,
 * and these transitions do not have one — and `requireRecoverableProvenance`
 * defaulted to false, so applyCandidate armed COMMITTING anyway. Every
 * AUTHORIZATION, every START and every bootstrap in this repository was published
 * through a journal that recovery is designed to REFUSE.
 *
 * The repair is to give those transitions their real authority rather than to
 * exempt them. Nothing is fabricated: the documents already exist, are already
 * owner-issued, and already have canonical validators that recompute their own
 * binding and request digests. Those validators are what re-prove the journal at
 * recovery time, exactly as the maintenance evaluator does for its class.
 */
export const AUTHORITY_BINDING_GATE_LIFECYCLE = 'GATE_LIFECYCLE_AUTHORITY';
export const AUTHORITY_BINDING_PRECONTRACT_LOCAL = 'PRECONTRACT_LOCAL_AUTHORITY';

export const AUTHORITY_BINDINGS = Object.freeze([
  AUTHORITY_BINDING_POST_FREEZE_MAINTENANCE,
  AUTHORITY_BINDING_PRECONTRACT_CONSUMPTION_ANCHOR,
  AUTHORITY_BINDING_GATE_LIFECYCLE,
  AUTHORITY_BINDING_PRECONTRACT_LOCAL
]);

/** Which lifecycle transitions are governed by the Gate's own lifecycle authority. */
export const GATE_LIFECYCLE_TRANSITIONS = Object.freeze(['AUTHORIZATION', 'START']);

/**
 * The journal caseType a post-freeze maintenance PROGRAM publishes under.
 *
 * Distinct from STATUS_TRANSITION because the two differ in a way recovery must
 * act on: a status transition appends a ledger event during roll-forward, and a
 * maintenance program must not. Naming the case is what lets one recovery path
 * serve both without guessing from the presence of a field.
 */
export const MAINTENANCE_PROGRAM_CASE_TYPE = 'MAINTENANCE_PROGRAM';

/** The journal caseType a precontract bootstrap publishes under. */
export const PRECONTRACT_BOOTSTRAP_CASE_TYPE = 'PRECONTRACT_BOOTSTRAP';

/**
 * The case types that publish a cohort and append NOTHING to the ledger.
 *
 * The distinction recovery acts on is not "which publisher wrote this" but "does
 * roll-forward have an event to append". A maintenance program and a precontract
 * bootstrap answer that identically, and the identity check below treats them
 * identically: same transaction/gate identity, and a ledger event that must be
 * ABSENT rather than merely unused. Requiring the absence is the point — a journal
 * that claimed one of these cases while carrying an event would otherwise append
 * to the ledger during roll-forward under an authority that never authorized a
 * transition.
 *
 * Enumerated rather than inferred from `ledgerEvent == null`, which is the same
 * mistake in a different place: a status-transition journal stripped of its event
 * would then be read as a no-event case and roll forward as one.
 */
export const LEDGER_SILENT_CASE_TYPES = [MAINTENANCE_PROGRAM_CASE_TYPE, PRECONTRACT_BOOTSTRAP_CASE_TYPE];

/** The single canonical path an anchor transaction is structurally allowed to move. */
export const ANCHOR_LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value) && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function rootPath(root, relative) {
  if (!safeRelative(relative)) return null;
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}

function cohortFor(writes, before) {
  return writes.map((write) => {
    const prior = before.find((entry) => entry.write.path === write.path);
    return {
      path: write.path, sha256: write.sha256, byteLength: write.byteLength,
      expectedBeforePresent: prior?.existed ?? false,
      expectedBeforeSha256: prior?.bytes ? sha256Bytes(prior.bytes) : null,
      expectedBeforeByteLength: prior?.bytes?.length ?? null
    };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function createLifecycleTransactionProvenance({ root, candidate, before, authorityDocumentPath, authority }) {
  if (!authorityDocumentPath || authority?.decision !== 'AUTHORIZED' || !authority.observed) return null;
  const authorityFile = rootPath(root, authorityDocumentPath);
  if (!authorityFile || !fs.existsSync(authorityFile)) return null;
  const authorityBytes = fs.readFileSync(authorityFile);
  const authorityDocument = JSON.parse(authorityBytes.toString('utf8'));
  const cohort = cohortFor(candidate.writes, before);
  const candidateManifest = { gateId: candidate.gateId, transitionType: candidate.transitionType, cohort };
  return {
    schemaVersion: 1,
    mechanism: 'LOCAL_EXPLICIT_AUTHORITY',
    authorityBinding: AUTHORITY_BINDING_POST_FREEZE_MAINTENANCE,
    transactionId: `${candidate.eventId}_TRANSACTION`,
    gateId: candidate.gateId,
    transitionType: candidate.transitionType,
    candidateManifestSha256: sha256Canonical(candidateManifest),
    candidateCohort: cohort,
    requestedOperationClasses: [candidate.transitionType],
    preState: {
      baseHead: authority.observed.baseHead,
      ledgerEventCount: authority.observed.ledgerEventCount,
      ledgerPrefixSha256: authority.observed.ledgerPrefixSha256,
      gateStatus: authority.observed.gateStatus,
      stateRevision: authority.observed.stateRevision,
      contractRevision: authority.observed.contractRevision,
      activeGate: authority.observed.activeGate
    },
    authority: {
      documentPath: authorityDocumentPath,
      documentSha256: sha256Bytes(authorityBytes),
      authorityId: authorityDocument.authorityId,
      authorizedPathManifestPath: authorityDocument.authorizedPathManifestPath,
      authorizedPathManifestSha256: authorityDocument.authorizedPathManifestSha256,
      authorityPredecessor: authorityDocument.authorityPredecessor,
      observed: authority.observed
    },
    external: authorityDocument.authorityPurpose === 'GATE_EXTERNAL_CONFIRMATION' ? {
      logicalAuthorityId: candidate.event.authorityPath,
      reportPath: authorityDocument.externalReinspectionReportPath,
      reportSha256: authorityDocument.externalReinspectionReportSha256,
      authorityPredecessor: authorityDocument.authorityPredecessor
    } : null
  };
}

/**
 * Provenance for a PRECONTRACT_CONSUMPTION_ANCHOR publication.
 *
 * Same record, same fields, same validator. What differs is only WHICH document
 * is named as the authority and therefore which canonical evaluator re-proves it
 * during recovery: the single-use anchor authority, whose binding clauses
 * `evaluatePrecontractConsumptionAnchorBinding` already owns and which
 * `validate-status-ledger` already enforces on the published event.
 *
 * The manifest fields stay null on purpose. An anchor authority does not carry an
 * authorized-path manifest, and fabricating one here would be a claim no document
 * makes. The cohort it may move is not left open in consequence: an anchor
 * transaction is structurally confined to the ledger, and the validator refuses
 * any other path outright.
 */
export function createAnchorTransactionProvenance({ root, candidate, before, authorityDocumentPath }) {
  if (!authorityDocumentPath) return null;
  const authorityFile = rootPath(root, authorityDocumentPath);
  if (!authorityFile || !fs.existsSync(authorityFile)) return null;
  const authorityBytes = fs.readFileSync(authorityFile);
  let authorityDocument = null;
  try { authorityDocument = JSON.parse(authorityBytes.toString('utf8')); } catch { return null; }
  if (authorityDocument?.documentKind !== PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_KIND) return null;
  let observed = null;
  try { observed = observeCanonicalPreState(root, candidate.gateId); } catch { return null; }
  const cohort = cohortFor(candidate.writes, before);
  const candidateManifest = { gateId: candidate.gateId, transitionType: candidate.transitionType, cohort };
  return {
    schemaVersion: 1,
    mechanism: 'LOCAL_EXPLICIT_AUTHORITY',
    authorityBinding: AUTHORITY_BINDING_PRECONTRACT_CONSUMPTION_ANCHOR,
    transactionId: `${candidate.eventId}_TRANSACTION`,
    gateId: candidate.gateId,
    transitionType: candidate.transitionType,
    candidateManifestSha256: sha256Canonical(candidateManifest),
    candidateCohort: cohort,
    requestedOperationClasses: [candidate.transitionType],
    preState: {
      baseHead: observed.baseHead,
      ledgerEventCount: observed.ledgerEventCount,
      ledgerPrefixSha256: observed.ledgerPrefixSha256,
      gateStatus: observed.gateStatus,
      stateRevision: observed.stateRevision,
      contractRevision: observed.contractRevision,
      activeGate: observed.activeGate
    },
    authority: {
      documentPath: authorityDocumentPath,
      documentSha256: sha256Bytes(authorityBytes),
      authorityId: authorityDocument.authorityId,
      authorizedPathManifestPath: null,
      authorizedPathManifestSha256: null,
      authorityPredecessor: null,
      observed
    },
    external: null
  };
}

/**
 * The fields every provenance record shares, built once so a new binding class
 * cannot accidentally omit one and be validated more weakly than its siblings.
 */
function baseProvenance({ authorityBinding, candidate, before, observed, authorityDocumentPath, authorityBytes, authorityId }) {
  const cohort = cohortFor(candidate.writes, before);
  return {
    schemaVersion: 1,
    mechanism: 'LOCAL_EXPLICIT_AUTHORITY',
    authorityBinding,
    transactionId: `${candidate.eventId}_TRANSACTION`,
    gateId: candidate.gateId,
    transitionType: candidate.transitionType,
    candidateManifestSha256: sha256Canonical({ gateId: candidate.gateId, transitionType: candidate.transitionType, cohort }),
    candidateCohort: cohort,
    requestedOperationClasses: [candidate.transitionType],
    preState: {
      baseHead: observed.baseHead,
      ledgerEventCount: observed.ledgerEventCount,
      ledgerPrefixSha256: observed.ledgerPrefixSha256,
      gateStatus: observed.gateStatus,
      stateRevision: observed.stateRevision,
      contractRevision: observed.contractRevision,
      activeGate: observed.activeGate
    },
    authority: {
      documentPath: authorityDocumentPath,
      documentSha256: sha256Bytes(authorityBytes),
      authorityId,
      authorizedPathManifestPath: null,
      authorizedPathManifestSha256: null,
      authorityPredecessor: null,
      observed
    },
    external: null
  };
}

/**
 * Provenance for an AUTHORIZATION or START publication.
 *
 * The named document is the Gate's lifecycle RECORD — the same path the ledger
 * event itself cites as its authority — and the companion owner document is
 * carried alongside it, because the record alone is not the authority: the owner
 * snapshot is what approved it, and the pair is only meaningful together. Both
 * digests are pinned here and both are re-validated at recovery by the canonical
 * shape validators, which recompute the record digest and the owner's approved
 * binding digest from the documents' own remaining fields.
 *
 * Returns null when the pair is not resolvable. A null here is not a licence to
 * proceed without provenance — applyCandidate now refuses the publication — it is
 * a refusal to invent a binding for a transition whose authority is not on disk.
 */
export function createGateLifecycleTransactionProvenance({ root, candidate, before }) {
  if (!GATE_LIFECYCLE_TRANSITIONS.includes(candidate?.transitionType)) return null;

  // THE RECORD PATH COMES FROM THE CANDIDATE, NOT FROM THE MAINTENANCE CHANNEL.
  //
  // The first wiring of this builder read `authorityDocumentPath`, which is the
  // POST-FREEZE MAINTENANCE authority argument. A normal AUTHORIZATION or START
  // does not travel that channel — it names its lifecycle record through the
  // request's own `authorityPath`, which the orchestrator has already placed on
  // the candidate event. So `authorityDocumentPath` was null for exactly the two
  // transitions this builder exists to serve, provenance came back null, and the
  // (correct) strict default refused every production-like AUTHORIZATION/START.
  //
  // Reading the candidate event is not a workaround for that: it is the right
  // source. It is the same path the ledger event itself will cite as its
  // authority, so the journal and the published event name one document rather
  // than two that happen to agree. Overloading the maintenance argument to carry
  // a lifecycle record would have made one parameter mean two different kinds of
  // authority, which is how the ambiguity would come back.
  const authorityDocumentPath = candidate?.event?.authorityPath ?? null;
  if (typeof authorityDocumentPath !== 'string' || !authorityDocumentPath) return null;
  const authorityFile = rootPath(root, authorityDocumentPath);
  if (!authorityFile || !fs.existsSync(authorityFile)) return null;
  const authorityBytes = fs.readFileSync(authorityFile);
  let record = null;
  try { record = JSON.parse(authorityBytes.toString('utf8')); } catch { return null; }
  if (record?.gateId !== candidate.gateId) return null;

  const isAuthorization = candidate.transitionType === 'AUTHORIZATION';
  const ownerPath = isAuthorization
    ? gateAuthorizationAuthoritySnapshotPath(candidate.gateId)
    : gateStartAuthorityPath(candidate.gateId);
  const ownerFile = rootPath(root, ownerPath);
  if (!ownerFile || !fs.existsSync(ownerFile)) return null;
  const ownerBytes = fs.readFileSync(ownerFile);
  let owner = null;
  try { owner = JSON.parse(ownerBytes.toString('utf8')); } catch { return null; }
  if (owner?.gateId !== candidate.gateId) return null;

  let observed = null;
  try { observed = observeCanonicalPreState(root, candidate.gateId); } catch { return null; }

  const provenance = baseProvenance({
    authorityBinding: AUTHORITY_BINDING_GATE_LIFECYCLE,
    candidate, before, observed, authorityDocumentPath, authorityBytes,
    authorityId: record.authorizationId ?? record.recordId ?? null
  });
  provenance.lifecycle = {
    recordPath: authorityDocumentPath,
    recordSha256: sha256Bytes(authorityBytes),
    ownerAuthorityPath: ownerPath,
    ownerAuthoritySha256: sha256Bytes(ownerBytes),
    ownerAuthorityId: owner.authorityId ?? null,
    recordedAt: record.recordedAt ?? null
  };
  return provenance;
}

/**
 * Provenance for a PRECONTRACT_BOOTSTRAP publication.
 *
 * WHAT THE OLD CODE GOT WRONG HERE IS SUBTLE AND WORTH NAMING. The bootstrap
 * applier called `applyCandidate({ authority, ... })` passing the parsed
 * precontract authority DOCUMENT. `createLifecycleTransactionProvenance` tests
 * `authority?.decision !== 'AUTHORIZED'` — a field only an EVALUATION result
 * carries — so the raw document silently failed the test and provenance came back
 * null. The publication then proceeded, because the requirement was opt-in.
 *
 * The lesson is not "pass the right object". It is that a raw document and an
 * evaluated authorization are different kinds, and code that accepts either will
 * eventually be handed the weaker one. This builder therefore takes the
 * EVALUATION — the same `resolvePrecontractAuthority` result the applier already
 * computed to decide it was allowed to write at all — and refuses anything else.
 */
export function createPrecontractBootstrapTransactionProvenance({ root, candidate, before, authorityDocumentPath, authorization }) {
  if (!authorityDocumentPath) return null;
  // The evaluated decision, never the document. A document has no `decision`.
  if (authorization?.decision !== 'AUTHORIZED' || !Array.isArray(authorization.authorizedPaths)) return null;
  const authorityFile = rootPath(root, authorityDocumentPath);
  if (!authorityFile || !fs.existsSync(authorityFile)) return null;
  const authorityBytes = fs.readFileSync(authorityFile);
  let authorityDocument = null;
  try { authorityDocument = JSON.parse(authorityBytes.toString('utf8')); } catch { return null; }
  if (authorityDocument?.gateId !== candidate.gateId) return null;

  let observed = null;
  try { observed = observeCanonicalPreState(root, candidate.gateId); } catch { return null; }

  const provenance = baseProvenance({
    authorityBinding: AUTHORITY_BINDING_PRECONTRACT_LOCAL,
    candidate, before, observed, authorityDocumentPath, authorityBytes,
    authorityId: authorityDocument.authorityId ?? null
  });
  provenance.precontract = {
    authorityPath: authorityDocumentPath,
    authoritySha256: sha256Bytes(authorityBytes),
    consumptionRecordPath: authorityDocument.consumptionRecordPath ?? null,
    authorizedPaths: [...authorization.authorizedPaths].sort((left, right) => left.localeCompare(right, 'en'))
  };
  return provenance;
}

function finding(findings, code, detail = null) { findings.push({ code, detail }); }

function readStagedBytes(root, artifact, findings) {
  const source = rootPath(root, artifact?.sourcePath);
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    finding(findings, 'PENDING_TRANSACTION_STAGED_ARTIFACT_MISSING', artifact?.sourcePath ?? null);
    return null;
  }
  const bytes = fs.readFileSync(source);
  if (sha256Bytes(bytes) !== artifact.sha256 || bytes.length !== artifact.byteLength) {
    finding(findings, 'PENDING_TRANSACTION_STAGED_ARTIFACT_ALTERED', artifact.targetPath);
    return null;
  }
  return bytes;
}

/**
 * WHICH CANONICAL FILE BACKS EACH SCALAR PRE-STATE FIELD.
 *
 * Recovery may rewind a scalar observation to the receipt ONLY when this
 * transaction's own cohort contains the file that observation is read from.
 * Rewinding unconditionally would hide a change nobody in this transaction made —
 * a ledger appended by another actor between the crash and the recovery would be
 * papered over by the receipt's older count, which is precisely the "future ledger
 * append" a hostile is entitled to expect a BLOCK for.
 *
 * `baseHead` is deliberately absent: it is read from Git, never from a governed
 * path, so no cohort can justify rewinding it.
 */
const LEDGER_BACKED_PRESTATE_FIELDS = Object.freeze(['ledgerEventCount', 'ledgerPrefixSha256', 'gateStatus']);
function prestateFieldSourcePath(field, gateId) {
  if (LEDGER_BACKED_PRESTATE_FIELDS.includes(field)) return ANCHOR_LEDGER_PATH;
  if (field === 'stateRevision') return `governance/gates/${gateId}/state/CURRENT_STATE.json`;
  if (field === 'contractRevision') return `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  if (field === 'activeGate') return 'governance/active/ACTIVE_GATE.json';
  return null;
}

function isPermittedProgress(root, provenance, candidateByPath, findings) {
  let progressed = false;
  let seenUnchangedAfterProgress = false;
  for (const entry of provenance.candidateCohort) {
    const target = rootPath(root, entry.path);
    const present = Boolean(target && fs.existsSync(target));
    const bytes = present ? fs.readFileSync(target) : null;
    const atCandidate = present && sha256Bytes(bytes) === entry.sha256 && bytes.length === entry.byteLength;
    const atBefore = present === entry.expectedBeforePresent
      && (!present || (sha256Bytes(bytes) === entry.expectedBeforeSha256 && bytes.length === entry.expectedBeforeByteLength));
    if (!atCandidate && !atBefore) finding(findings, 'PENDING_TRANSACTION_CANONICAL_BYTES_UNEXPECTED', entry.path);
    // A path whose candidate bytes EQUAL its pre-state bytes is `atCandidate` and
    // `atBefore` at the same time, and it is IMPOSSIBLE to tell from the bytes
    // whether it has been written yet. Counting it as progress is therefore a
    // guess, and it was a wrong one: a no-op member sorting early in the cohort
    // made every genuinely unwritten member after it look like a gap, and the
    // publication was refused as PROGRESS_NON_PREFIX before a single byte moved.
    //
    // Status transitions never hit this because every member of a transition
    // cohort changes. A maintenance program republishing a file to the bytes it
    // already holds is ordinary. Ambiguous members are therefore neutral: they
    // neither start progress nor break a prefix, which is the only reading that
    // does not depend on information the filesystem cannot supply.
    const ambiguous = atCandidate && atBefore;
    if (atCandidate && !ambiguous) {
      if (seenUnchangedAfterProgress) finding(findings, 'PENDING_TRANSACTION_PROGRESS_NON_PREFIX', entry.path);
      progressed = true;
    } else if (progressed && !ambiguous) seenUnchangedAfterProgress = true;
    if (!candidateByPath.has(entry.path)) finding(findings, 'PENDING_TRANSACTION_COHORT_ARTIFACT_MISSING', entry.path);
  }
}

/**
 * Re-proves an anchor transaction's authority from bytes, at recovery time.
 *
 * ONE SEMANTICS, THREE CONSUMERS. The clause set is not restated here: it is
 * `evaluatePrecontractConsumptionAnchorBinding`, the same primitive
 * `validate-status-ledger` uses to judge the published event and
 * VERIFY_CONSUMPTION uses to judge the receipt. A clause added there is a clause
 * recovery gains, which is the property that keeps a recovered anchor and a
 * validated anchor from ever meaning different things.
 *
 * The receipt's OWN bytes are checked on top of that, because the shared clause
 * set compares two claims — what the event states and what the authority permits
 * — and a receipt rewritten between prepare and crash would satisfy both while no
 * longer being the document that was anchored.
 */
function validateAnchorAuthorityBinding({ root, transaction, authority, authorityBytes, findings }) {
  const event = transaction.ledgerEvent;
  let precontractAuthority = null;
  const precontractFile = rootPath(root, authority.precontractAuthorityPath);
  if (precontractFile && fs.existsSync(precontractFile)) {
    try { precontractAuthority = JSON.parse(fs.readFileSync(precontractFile, 'utf8')); } catch { precontractAuthority = null; }
  }
  if (!precontractAuthority) {
    finding(findings, 'PENDING_TRANSACTION_ANCHOR_PRECONTRACT_AUTHORITY_UNRESOLVED', authority.precontractAuthorityPath ?? null);
  }
  const binding = evaluatePrecontractConsumptionAnchorBinding({
    event,
    anchorAuthority: { present: true, sha256: sha256Bytes(authorityBytes), record: authority },
    precontractAuthority
  });
  if (!binding.bound) {
    for (const clause of [...binding.authority, ...binding.source]) {
      finding(findings, 'PENDING_TRANSACTION_ANCHOR_BINDING_INVALID', clause.clause);
    }
    if (binding.terminal && binding.authority.length === 0 && binding.source.length === 0) {
      finding(findings, 'PENDING_TRANSACTION_ANCHOR_BINDING_INVALID', 'TERMINAL');
    }
  }
  const receiptFile = rootPath(root, authority.consumptionRecordPath);
  if (!receiptFile || !fs.existsSync(receiptFile)) {
    finding(findings, 'PENDING_TRANSACTION_ANCHOR_RECEIPT_ABSENT', authority.consumptionRecordPath ?? null);
  } else if (sha256Bytes(fs.readFileSync(receiptFile)) !== authority.consumptionRecordSha256) {
    finding(findings, 'PENDING_TRANSACTION_ANCHOR_RECEIPT_BYTES_MISMATCH', authority.consumptionRecordPath);
  }
}

/**
 * Re-proves an AUTHORIZATION/START transaction's authority from bytes.
 *
 * The record and its owner document are BOTH re-validated, by the canonical shape
 * validators rather than by a local restatement of their rules. Those validators
 * recompute the record digest and the owner's approved binding digest from the
 * documents' remaining fields, so a record edited after the transaction was
 * prepared fails here even though its path and its digest pin would still line up
 * with each other.
 *
 * `recordedAt` is threaded into the owner validation deliberately: without it the
 * owner document would validate against ANY authorization of the same Gate, and
 * an approval issued for a previous authorization would be accepted as approval
 * for this one.
 */
function validateGateLifecycleAuthorityBinding({ root, provenance, authority, authorityBytes, findings }) {
  const lifecycle = provenance.lifecycle;
  if (!lifecycle || typeof lifecycle !== 'object') {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_BINDING_ABSENT');
    return;
  }
  if (lifecycle.recordPath !== provenance.authority.documentPath || lifecycle.recordSha256 !== sha256Bytes(authorityBytes)) {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_RECORD_MISMATCH', lifecycle.recordPath ?? null);
  }
  const isAuthorization = provenance.transitionType === 'AUTHORIZATION';
  const expectedOwnerPath = isAuthorization
    ? gateAuthorizationAuthoritySnapshotPath(provenance.gateId)
    : gateStartAuthorityPath(provenance.gateId);
  if (lifecycle.ownerAuthorityPath !== expectedOwnerPath) {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_OWNER_PATH_INVALID', lifecycle.ownerAuthorityPath ?? null);
    return;
  }
  const ownerFile = rootPath(root, expectedOwnerPath);
  if (!ownerFile || !fs.existsSync(ownerFile)) {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_OWNER_ABSENT', expectedOwnerPath);
    return;
  }
  const ownerBytes = fs.readFileSync(ownerFile);
  if (sha256Bytes(ownerBytes) !== lifecycle.ownerAuthoritySha256) {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_OWNER_BYTES_MISMATCH', expectedOwnerPath);
    return;
  }
  let owner = null;
  try { owner = JSON.parse(ownerBytes.toString('utf8')); } catch { owner = null; }
  if (!owner) { finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_OWNER_MALFORMED', expectedOwnerPath); return; }

  // CROSS-DOCUMENT PAIR BINDING, NOT TWO SEPARATE SHAPE CHECKS.
  //
  // Validating the record and the owner document independently proves only that
  // each is well-formed. Two individually valid documents that were never issued
  // for one another would both pass, and recovery would roll forward a
  // publication whose "authority" approved a DIFFERENT authorization of the same
  // Gate. What ties them together is the owner document's binding digest, which is
  // computed OVER THE RECORD — so recomputing it here from the record on disk is
  // what proves the pair is the pair.
  //
  // The full live evaluators (evaluateGateAuthorizationAuthority /
  // evaluateGateStartAuthority) are deliberately NOT used for this. They also
  // assert the repository's CURRENT observation — that the Gate is still
  // NOT_STARTED, that every authorized artifact still holds its approved bytes,
  // that the authority is not yet consumed. Those are apply-time questions. A
  // journal is re-proved at recovery time, when the Gate has by definition
  // already moved, so asking them would make every recovered transaction
  // unrecoverable for reasons that have nothing to do with its authority. The
  // clauses reused here are exactly the drift-independent ones: the canonical
  // digest computations, taken from the canonical modules rather than restated.
  const bindingFindings = [];
  if (isAuthorization) {
    const expectedRequestDigest = computeGateAuthorizationLocalRequestDigest(owner);
    if (!expectedRequestDigest || owner.approvedRequestDigest !== expectedRequestDigest) {
      bindingFindings.push('APPROVED_REQUEST_DIGEST_MISMATCH');
    }
    const expectedBinding = computeGateAuthorizationBindingDigest({
      ...owner,
      recordedAt: authority?.recordedAt,
      stateArtifacts: authority?.authorizedStateArtifacts,
      derivedArtifacts: owner?.authorizedDerivedArtifacts
    });
    if (!expectedBinding?.digest || owner.approvedBindingDigest !== expectedBinding.digest) {
      bindingFindings.push('APPROVED_BINDING_DIGEST_MISMATCH');
    }
  } else {
    const expectedRecordDigest = computeGateStartRecordDigest(authority);
    if (owner.recordDigest !== expectedRecordDigest) bindingFindings.push('START_RECORD_DIGEST_MISMATCH');
    if (authority.recordDigest !== expectedRecordDigest) bindingFindings.push('START_RECORD_SELF_DIGEST_MISMATCH');
    const expectedRequestDigest = computeGateStartLocalRequestDigest(owner);
    if (!expectedRequestDigest || owner.requestDigest !== expectedRequestDigest) bindingFindings.push('START_REQUEST_DIGEST_MISMATCH');
    const expectedBinding = computeGateStartBindingDigestFromDigests({
      requestDigest: owner.requestDigest, recordDigest: owner.recordDigest
    });
    if (owner.bindingDigest !== expectedBinding) bindingFindings.push('START_BINDING_DIGEST_MISMATCH');
  }
  if (bindingFindings.length > 0) {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_PAIR_NOT_AUTHORIZED', bindingFindings[0]);
  }

  if (authority?.gateId !== provenance.gateId || owner?.gateId !== provenance.gateId) {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_GATE_MISMATCH');
  }
}

/**
 * Re-proves a PRECONTRACT_BOOTSTRAP transaction's authority from bytes.
 *
 * The authorization is RE-EVALUATED, not re-read: `resolvePrecontractAuthority`
 * is the same pure evaluation the applier had to pass before it was allowed to
 * stage anything, and running it again here is what makes the journal's claim
 * checkable rather than merely self-consistent. The cohort is then held to the
 * authorized path set, so a journal widened after preparation cannot roll forward
 * a path the authority never named.
 */
function validatePrecontractBootstrapBinding({ root, provenance, authority, authorityBytes, findings }) {
  const precontract = provenance.precontract;
  if (!precontract || typeof precontract !== 'object') {
    finding(findings, 'PENDING_TRANSACTION_PRECONTRACT_BINDING_ABSENT');
    return;
  }
  if (precontract.authorityPath !== provenance.authority.documentPath || precontract.authoritySha256 !== sha256Bytes(authorityBytes)) {
    finding(findings, 'PENDING_TRANSACTION_PRECONTRACT_AUTHORITY_MISMATCH', precontract.authorityPath ?? null);
  }
  if (!isLocalPrecontractAuthority(authority)) {
    finding(findings, 'PENDING_TRANSACTION_PRECONTRACT_AUTHORITY_NOT_LOCAL');
    return;
  }
  // The journal names the authority relative to the governed root; the source
  // resolves whatever string it is handed against the PROCESS working directory.
  // Passing the journal's path through unresolved therefore did not fail loudly —
  // it silently pointed the re-evaluation at a same-named document under the
  // caller's cwd, which for any recovery run from inside another repository is a
  // different file that is (correctly) refused as ungoverned. Resolving against
  // `root` is what makes this a check on the tree being recovered.
  const authorityFile = rootPath(root, precontract.authorityPath);
  if (!authorityFile) {
    finding(findings, 'PENDING_TRANSACTION_PRECONTRACT_AUTHORITY_PATH_INVALID', precontract.authorityPath ?? null);
    return;
  }
  let evaluation = null;
  try {
    evaluation = createWheelPrecontractAuthoritySource(root, { authorityPath: authorityFile })
      .resolvePrecontractAuthority(provenance.gateId);
  } catch { evaluation = null; }
  if (evaluation?.decision !== 'AUTHORIZED') {
    finding(findings, 'PENDING_TRANSACTION_PRECONTRACT_NOT_AUTHORIZED', evaluation?.findings?.[0]?.code ?? evaluation?.decision ?? null);
    return;
  }
  const authorized = new Set(evaluation.authorizedPaths ?? []);
  for (const entry of provenance.candidateCohort ?? []) {
    if (!authorized.has(entry?.path)) finding(findings, 'PENDING_TRANSACTION_PRECONTRACT_COHORT_NOT_AUTHORIZED', entry?.path ?? null);
  }
}

/** Recomputes authority, cohort and byte bindings before a pending transaction can publish. */
export function validateLifecycleTransactionProvenance({ root, transaction }) {
  const findings = [];
  const provenance = transaction?.provenance;
  if (!provenance || provenance.schemaVersion !== 1) return { valid: false, findings: [{ code: 'PENDING_TRANSACTION_PROVENANCE_INVALID', detail: 'PROVENANCE_ABSENT_OR_INVALID' }] };
  // An unnamed binding class is refused rather than defaulted. Defaulting would
  // let a forged record pick the cheaper evaluator by simply omitting the field.
  if (!AUTHORITY_BINDINGS.includes(provenance.authorityBinding)) {
    return { valid: false, findings: [{ code: 'PENDING_TRANSACTION_PROVENANCE_INVALID', detail: 'AUTHORITY_BINDING_UNKNOWN' }] };
  }
  for (const field of ['baseHead', 'ledgerEventCount', 'ledgerPrefixSha256', 'gateStatus', 'stateRevision', 'contractRevision', 'activeGate']) {
    if (provenance.preState?.[field] !== provenance.authority?.observed?.[field]) finding(findings, 'PENDING_TRANSACTION_PRESTATE_RECEIPT_MISMATCH', field);
  }
  // A MAINTENANCE PROGRAM MOVES BYTES WITHOUT MOVING THE LEDGER.
  //
  // The identity check below was written for status transitions, where the journal
  // always carries the event it is about to append. A post-freeze maintenance
  // program appends nothing — it publishes a cohort and a consumption receipt —
  // so demanding a ledger event of it would make every maintenance transaction
  // unrecoverable, which is the opposite of the repair. The two shapes are
  // therefore distinguished explicitly, and the maintenance shape is required to
  // carry NO ledger event rather than merely being excused from carrying one: a
  // journal that both claims maintenance and smuggles an event would otherwise
  // append to the ledger during roll-forward under an authority that never
  // authorized a transition.
  const isMaintenanceCase = LEDGER_SILENT_CASE_TYPES.includes(transaction.caseType);
  if (isMaintenanceCase) {
    if (transaction.transactionId !== provenance.transactionId
        || transaction.gateId !== provenance.gateId
        || transaction.ledgerEvent !== null && transaction.ledgerEvent !== undefined) {
      finding(findings, 'PENDING_TRANSACTION_IDENTITY_MISMATCH');
    }
  } else if (transaction.caseType !== 'STATUS_TRANSITION' || transaction.transactionId !== provenance.transactionId
      || transaction.gateId !== provenance.gateId || transaction.ledgerEvent?.gateId !== provenance.gateId
      || transaction.ledgerEvent?.transitionType !== provenance.transitionType) finding(findings, 'PENDING_TRANSACTION_IDENTITY_MISMATCH');
  if (provenance.mechanism !== 'LOCAL_EXPLICIT_AUTHORITY') finding(findings, 'PENDING_TRANSACTION_AUTHORITY_MECHANISM_INVALID');
  const candidateByPath = new Map();
  for (const artifact of transaction.stagedArtifacts ?? []) {
    const bytes = readStagedBytes(root, artifact, findings);
    if (bytes) candidateByPath.set(artifact.targetPath, bytes);
  }
  const expected = new Map((transaction.expectedHashes ?? []).map((item) => [item.targetPath, item]));
  const observedCohort = [...candidateByPath.entries()].map(([path, bytes]) => ({ path, sha256: sha256Bytes(bytes), byteLength: bytes.length }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const claimedCohort = Array.isArray(provenance.candidateCohort) ? provenance.candidateCohort : [];
  if (canonicalize(observedCohort) !== canonicalize(claimedCohort.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })))) finding(findings, 'PENDING_TRANSACTION_COHORT_MISMATCH');
  const manifest = { gateId: provenance.gateId, transitionType: provenance.transitionType, cohort: claimedCohort };
  if (sha256Canonical(manifest) !== provenance.candidateManifestSha256) finding(findings, 'PENDING_TRANSACTION_CANDIDATE_MANIFEST_MISMATCH');
  if (canonicalize([...expected.values()].map(({ targetPath, sha256, byteLength }) => ({ path: targetPath, sha256, byteLength })).sort((a, b) => a.path.localeCompare(b.path, 'en'))) !== canonicalize(observedCohort)) finding(findings, 'PENDING_TRANSACTION_EXPECTED_HASHES_MISMATCH');
  if (canonicalize(transaction.commitOrder) !== canonicalize(claimedCohort.map((entry) => entry.path))) finding(findings, 'PENDING_TRANSACTION_COMMIT_ORDER_MISMATCH');
  isPermittedProgress(root, provenance, candidateByPath, findings);

  const isAnchorBinding = provenance.authorityBinding === AUTHORITY_BINDING_PRECONTRACT_CONSUMPTION_ANCHOR;
  const isLifecycleBinding = provenance.authorityBinding === AUTHORITY_BINDING_GATE_LIFECYCLE;
  const isPrecontractBinding = provenance.authorityBinding === AUTHORITY_BINDING_PRECONTRACT_LOCAL;
  // A binding class may only be claimed by the transitions it actually governs.
  // Without this, a maintenance transition could name the lifecycle class and be
  // judged by the cheaper of two evaluators purely by asserting so.
  if (isLifecycleBinding && !GATE_LIFECYCLE_TRANSITIONS.includes(provenance.transitionType)) {
    finding(findings, 'PENDING_TRANSACTION_LIFECYCLE_TRANSITION_INVALID', provenance.transitionType ?? null);
  }
  if (isPrecontractBinding && provenance.transitionType !== 'PRECONTRACT_BOOTSTRAP') {
    finding(findings, 'PENDING_TRANSACTION_PRECONTRACT_TRANSITION_INVALID', provenance.transitionType ?? null);
  }
  // An anchor moves the ledger and nothing else. Its authority carries no path
  // manifest, so the cohort bound is structural rather than declared — and it is
  // enforced here, not assumed, because a journal is exactly what a forger would
  // widen if widening were possible.
  if (isAnchorBinding) {
    for (const entry of claimedCohort) {
      if (entry?.path !== ANCHOR_LEDGER_PATH) finding(findings, 'PENDING_TRANSACTION_ANCHOR_COHORT_NOT_PERMITTED', entry?.path ?? null);
    }
    if (provenance.transitionType !== 'PRECONTRACT_CONSUMPTION_ANCHOR') finding(findings, 'PENDING_TRANSACTION_ANCHOR_TRANSITION_INVALID', provenance.transitionType ?? null);
  }

  const authorityPath = rootPath(root, provenance.authority?.documentPath);
  if (!authorityPath || !fs.existsSync(authorityPath)) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_ABSENT');
  else {
    const authorityBytes = fs.readFileSync(authorityPath);
    let authority = null;
    try { authority = JSON.parse(authorityBytes.toString('utf8')); } catch { authority = null; }
    if (sha256Bytes(authorityBytes) !== provenance.authority.documentSha256) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_SHA_MISMATCH');
    else if (!authority) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_MALFORMED', provenance.authority.documentPath);
    else if (isAnchorBinding) {
      if (authority.authorityId !== provenance.authority.authorityId) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_BINDING_MISMATCH');
      validateAnchorAuthorityBinding({ root, transaction, authority, authorityBytes, findings });
    } else if (isLifecycleBinding) {
      validateGateLifecycleAuthorityBinding({ root, provenance, authority, authorityBytes, findings });
    } else if (isPrecontractBinding) {
      validatePrecontractBootstrapBinding({ root, provenance, authority, authorityBytes, findings });
    } else {
      if (authority.authorityId !== provenance.authority.authorityId || authority.authorizedPathManifestSha256 !== provenance.authority.authorizedPathManifestSha256) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_BINDING_MISMATCH');
      const candidateWrites = observedCohort.map((entry) => ({ ...entry, bytes: candidateByPath.get(entry.path) }));
      // `authorityDocumentPath` is passed for the same reason the publisher passes
      // it: a V2 manifest's `prestateSelfExclusion` names the authority document
      // and the manifest, and the observation can only account for them when it
      // knows where the authority lives. Omitting it made the re-evaluation report
      // PRESTATE_SELF_EXCLUSION_AUTHORITY_PATH_UNOBSERVED against a program the
      // publisher had just evaluated as AUTHORIZED over the same bytes — two
      // observations of one thing, which is the defect class this whole repair is
      // about, reappearing inside the recovery validator itself.
      const observation = collectPostFreezeMaintenanceObservation({ root, authority, authorityDocumentPath: provenance.authority?.documentPath ?? null, requestedPaths: observedCohort.map((entry) => entry.path), requestedOperationClasses: provenance.requestedOperationClasses, candidateWrites });
      if (!observation.valid) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_OBSERVATION_INVALID');
      else {
        // RECOVERY EVALUATES THE PRE-PUBLICATION STATE, NOT THE POST-CRASH ONE.
        //
        // THE DEFECT THIS REPLACES. The old code evaluated the authority against
        // the LIVE observation and only fell back to the receipt when the seven
        // scalar pre-state fields disagreed. Those fields are read from the ledger,
        // CURRENT_STATE, CURRENT_CONTRACT and ACTIVE_GATE — none of which a
        // maintenance program writes — so for the entire maintenance class they
        // agreed, the fallback never ran, and the live evaluation was used. The
        // live evaluation compares the manifest's declared pre-state against
        // `pathPrestates`, which IS read from the cohort the publication had just
        // overwritten. So the two crash boundaries where bytes had already moved —
        // a partial cohort, and a full candidate that never reached COMMITTED —
        // failed with PATH_PRESTATE_SHA_MISMATCH for precisely the members that had
        // been published successfully. Publication was destroying the evidence
        // recovery was then asked to produce.
        //
        // The model is now the one the design always assumed: reconstruct the state
        // the authority was evaluated against BEFORE any byte moved, and judge the
        // authority against that. Nothing is weakened to get there:
        //
        //   - the cohort's before-state is taken from the receipt, and the live
        //     dichotomy check above has already proved every member holds either
        //     those exact bytes or its exact candidate bytes;
        //   - `canonicalPredecessors` is still recomputed LIVE inside
        //     `reconstructPathPrestates`, so a declared pre-state digest must still
        //     name a committed blob or a previously certified digest;
        //   - the authority and manifest are still the digest-pinned documents on
        //     disk, and the manifest still supplies every declared expectation.
        //
        // A scalar field is rewound only when this transaction's cohort actually
        // contains the file that field is read from, so a ledger appended by
        // somebody else after the crash still fails rather than being excused.
        const recordedBefore = new Map(claimedCohort.map((entry) => [entry.path, {
          present: entry.expectedBeforePresent, sha256: entry.expectedBeforeSha256, byteLength: entry.expectedBeforeByteLength
        }]));
        const cohortPaths = new Set(claimedCohort.map((entry) => entry.path));
        const rewound = { ...observation.observed };
        for (const field of Object.keys(provenance.preState ?? {})) {
          const source = prestateFieldSourcePath(field, provenance.gateId);
          if (source && cohortPaths.has(source)) { rewound[field] = provenance.preState[field]; continue; }
          // THE OTHER HALF OF THE REWIND RULE, AND IT IS NOT OPTIONAL.
          //
          // A field this transaction could not have changed must still read today
          // exactly as the receipt recorded it. Without this, a receipt value that
          // is merely IGNORED becomes a value nobody checks: tampering with a
          // pre-state field whose file is outside the cohort had no effect on the
          // evaluation and no detector either, so the journal could disagree with
          // the repository about the state it was published against and still
          // recover. Rewindable fields are re-proved by the authority evaluation
          // below; non-rewindable ones are re-proved here, so every recorded field
          // is accounted for by exactly one of the two.
          if (provenance.preState[field] !== observation.observed[field]) {
            finding(findings, 'PENDING_TRANSACTION_PRESTATE_RECEIPT_DIVERGED', field);
          }
        }
        if (observation.manifest?.schemaVersion === 2) {
          rewound.pathPrestates = reconstructPathPrestates(
            root, (observation.manifest.paths ?? []).map((entry) => entry.path), recordedBefore
          );
        }
        const evaluation = evaluatePostFreezeMaintenanceAuthorityV2({ authority, manifest: observation.manifest, observed: rewound, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
        if (evaluation.decision !== 'AUTHORIZED') finding(findings, 'PENDING_TRANSACTION_AUTHORITY_NOT_AUTHORIZED', evaluation.findings?.map((item) => item.code).join(',') ?? null);
      }
    }
  }
  if (provenance.external) {
    const external = provenance.external;
    if (external.logicalAuthorityId !== transaction.ledgerEvent?.authorityPath) finding(findings, 'PENDING_TRANSACTION_EXTERNAL_LOGICAL_ID_MISMATCH');
    const report = rootPath(root, external.reportPath);
    if (!report || !fs.existsSync(report) || sha256Bytes(fs.readFileSync(report)) !== external.reportSha256) finding(findings, 'PENDING_TRANSACTION_EXTERNAL_REPORT_MISMATCH');
  }
  return { valid: findings.length === 0, findings };
}
