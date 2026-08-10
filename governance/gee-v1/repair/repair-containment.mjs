/**
 * GEE V1 R5 repair containment.
 *
 * The rule this file exists to enforce is narrow and easy to get wrong in both
 * directions: if the SAME root cause survives TWO TARGETED INCREMENTAL repair
 * attempts, a third incremental patch is no longer automatically authorized. It
 * is NOT "two bugs were found", it is NOT "anything that looks like the old
 * symptom", and it is NOT "two repairs of any kind". Containment therefore keys
 * on a declared, proven ROOT-CAUSE CLASS and counts only the repair class the
 * rule actually governs, so neither an independent defect nor a structural
 * correction can trip somebody else's threshold.
 *
 * Three deliberate non-goals:
 *
 * 1. NO NEW GOVERNANCE LEDGER DIRECTORY. This is a plain value: a frozen object
 *    with an ordered record list, serialisable to one JSON document that the
 *    caller stores wherever it already stores its own state. Nothing here
 *    writes a file, seals a release or mints a key.
 *
 * 2. NO ENFORCEMENT AT WRITE TIME. The ledger records what actually happened,
 *    including a patch that should not have been made; refusing to record
 *    history would only make history dishonest. Authorization is a separate
 *    question answered by evaluateContainment(), which the router enforces.
 *
 * 3. NO SECOND EVIDENCE SYSTEM. A resolution claim is proven by pointing at an
 *    R4 evidence node, and the CALLER supplies the predicate that checks it
 *    (the router builds one from its own verified R4 re-evaluation). This file
 *    never learns what an evidence graph is, and it never verifies anything
 *    twice.
 *
 * History is append-only in a way that survives a hostile edit: every record
 * carries the digest of the ledger as it stood immediately before the append,
 * so rewriting or deleting an earlier record breaks the chain of every later
 * one. verifyRepairLedger() replays that chain and recomputes every attempt
 * ordinal, so an ordinal cannot be back-dated either. Ordinals are lifetime
 * counts per (root cause, repair class) and never depend on resolution
 * verification, which keeps ledger identity independent of who is asking.
 */

import { sha256Canonical } from '../../tools/canonical-json.mjs';

export const REPAIR_CONTAINMENT_VERSION = 'GEE_V1_REPAIR_CONTAINMENT_R5';
export const REPAIR_LEDGER_KIND = 'GEE_REPAIR_LEDGER';

/** Two unresolved TARGETED INCREMENTAL attempts on one root cause is the threshold. */
export const CONTAINMENT_SURVIVAL_THRESHOLD = 2;

/* Lineage states. The progression is NORMAL -> TARGETED_REPAIR_1 ->
 * STOP_PATCH_CASCADE -> ROOT_CAUSE_REQUIRED as unresolved targeted attempts
 * accumulate, while TARGETED_REPAIR_2 is the state of the ATTEMPT that a
 * lineage at TARGETED_REPAIR_1 is still allowed to make. Lineage state
 * describes history; next-attempt state describes what may be authorized next. */
export const NORMAL = 'NORMAL';
export const TARGETED_REPAIR_1 = 'TARGETED_REPAIR_1';
export const TARGETED_REPAIR_2 = 'TARGETED_REPAIR_2';
export const STOP_PATCH_CASCADE = 'STOP_PATCH_CASCADE';
export const ROOT_CAUSE_REQUIRED = 'ROOT_CAUSE_REQUIRED';

export const REPAIR_ATTEMPT = 'REPAIR_ATTEMPT';
export const ROOT_CAUSE_ANALYSIS = 'ROOT_CAUSE_ANALYSIS';

/** A local patch against a known root cause. This is what containment counts. */
export const TARGETED_INCREMENTAL = 'TARGETED_INCREMENTAL';
/** A structural correction of the root cause itself. Never counted, never blocked. */
export const STRUCTURAL = 'STRUCTURAL';

/** SURVIVED: the same root cause is still present after the attempt. */
export const SURVIVED = 'SURVIVED';
/** RESOLVED: the attempt claims the root cause is gone. Only a VERIFIED claim counts. */
export const RESOLVED = 'RESOLVED';

/** A RESOLVED record nobody checked. Fail-closed: it changes nothing. */
export const RECORDED_RESOLUTION_CLAIM = 'RECORDED_RESOLUTION_CLAIM';
/** A RESOLVED record whose evidence a verifier confirmed. Only this closes a lineage. */
export const VERIFIED_RESOLUTION = 'VERIFIED_RESOLUTION';
/** A RESOLVED record a verifier actively refused. */
export const REJECTED_RESOLUTION_CLAIM = 'REJECTED_RESOLUTION_CLAIM';

/**
 * The validated content an R4 evidence node must carry to prove a resolution.
 *
 * Identity alone is not relevance: a genuine, current, reusable evidence node
 * about something else proves nothing about THIS root cause, and letting one
 * close a lineage would make containment escapable with any honest artefact.
 * So the claim has to be written INSIDE the evidence content, which R4's
 * reuseIdentity already binds — change the assertion and the identity moves,
 * and the record no longer matches.
 *
 * This file owns the vocabulary only. Checking it against a verified R4
 * evaluation is the router's job, because only the router has the graph.
 */
export const ROOT_CAUSE_RESOLUTION_ASSERTION = 'GEE_R5_ROOT_CAUSE_RESOLUTION';

/** Canonical resolution-assertion body to store as an R4 evidence node's content. */
export function rootCauseResolutionAssertion({ rootCauseClass, defectId } = {}) {
  return {
    assertionKind: ROOT_CAUSE_RESOLUTION_ASSERTION,
    defectId: canonicalIdentifier(defectId, 'DEFECT_ID'),
    resolved: true,
    rootCauseClass: canonicalIdentifier(rootCauseClass, 'ROOT_CAUSE_CLASS')
  };
}

/**
 * Does this validated assertion actually speak about the record's root cause?
 * Pure and total: any malformed, negative or mismatched assertion is false.
 */
export function matchesResolutionAssertion(assertion, record) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) return false;
  if (assertion.assertionKind !== ROOT_CAUSE_RESOLUTION_ASSERTION) return false;
  if (assertion.resolved !== true) return false;
  if (typeof assertion.rootCauseClass !== 'string' || assertion.rootCauseClass.normalize('NFC') !== record?.rootCauseClass) return false;
  // The defect is bound too, so evidence about a different defect within the
  // same root-cause class cannot stand in for the one being closed.
  return typeof assertion.defectId === 'string' && assertion.defectId.normalize('NFC') === record?.defectId;
}

const RECORD_KINDS = Object.freeze([REPAIR_ATTEMPT, ROOT_CAUSE_ANALYSIS]);
const REPAIR_CLASSES = Object.freeze([TARGETED_INCREMENTAL, STRUCTURAL]);
const OUTCOMES = Object.freeze([SURVIVED, RESOLVED]);

function canonicalIdentifier(value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`REPAIR_${field}_REQUIRED`);
  const canonical = value.normalize('NFC');
  if (canonical !== value) throw new Error(`NON_CANONICAL_REPAIR_${field}:${value}`);
  return canonical;
}

function compareIdentifiers(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function ledgerBody(records) {
  return { schemaVersion: 1, ledgerKind: REPAIR_LEDGER_KIND, engine: REPAIR_CONTAINMENT_VERSION, records };
}

function sealLedger(records) {
  const body = ledgerBody(records);
  return Object.freeze({ ...body, records: Object.freeze(records.map((record) => Object.freeze({ ...record }))), ledgerSha256: sha256Canonical(body) });
}

export function createRepairLedger() { return sealLedger([]); }

function lineageRecords(records, rootCauseClass) {
  return records.filter((record) => record.rootCauseClass === rootCauseClass);
}

/**
 * Lifetime ordinal of the next attempt of one repair class on one root cause.
 * Deliberately NOT window-scoped: a record's ordinal is part of its identity
 * and must be recomputable by verifyRepairLedger() without knowing whether any
 * resolution was ever verified.
 */
function nextOrdinal(records, rootCauseClass, repairClass) {
  return lineageRecords(records, rootCauseClass)
    .filter((record) => record.recordKind === REPAIR_ATTEMPT && record.repairClass === repairClass).length + 1;
}

/**
 * A resolution claim is only worth something if somebody checked it. Without a
 * verifier every claim stays RECORDED_RESOLUTION_CLAIM, which changes nothing —
 * so an arbitrary evidence string can never lift STOP_PATCH_CASCADE.
 */
function resolutionStateOf(record, verifyResolution) {
  if (record.outcome !== RESOLVED) return null;
  if (typeof verifyResolution !== 'function') return RECORDED_RESOLUTION_CLAIM;
  let verified = false;
  try {
    verified = verifyResolution(record.resolutionEvidence, record) === true;
  } catch {
    verified = false;
  }
  return verified ? VERIFIED_RESOLUTION : REJECTED_RESOLUTION_CLAIM;
}

/**
 * Records of one lineage that are still in force. Only a VERIFIED resolution
 * proves the root cause is gone, so only a verified one restarts the window: a
 * later recurrence is then a fresh lineage window rather than an eternal debt.
 */
function activeWindow(records, rootCauseClass, verifyResolution) {
  const lineage = lineageRecords(records, rootCauseClass);
  let start = 0;
  for (let index = 0; index < lineage.length; index += 1) {
    const record = lineage[index];
    if (record.recordKind === REPAIR_ATTEMPT && resolutionStateOf(record, verifyResolution) === VERIFIED_RESOLUTION) start = index + 1;
  }
  return lineage.slice(start);
}

function normalizeResolutionEvidence(input, outcome) {
  if (outcome !== RESOLVED) {
    if (input !== undefined && input !== null) throw new Error('RESOLUTION_EVIDENCE_ONLY_FOR_RESOLVED');
    return null;
  }
  // A RESOLVED record asserts that a root cause is gone. Pointing at an R4
  // evidence identity is the smallest claim a verifier can actually check;
  // a free-text reference is not, which is exactly the gap this closes.
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('RESOLUTION_EVIDENCE_REQUIRED');
  const evidenceId = canonicalIdentifier(input.evidenceId, 'RESOLUTION_EVIDENCE_ID');
  if (typeof input.reuseIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(input.reuseIdentity)) throw new Error('RESOLUTION_EVIDENCE_IDENTITY_REQUIRED');
  return { evidenceId, reuseIdentity: input.reuseIdentity };
}

function normalizeRecord(records, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('REPAIR_RECORD_REQUIRED');
  const recordKind = input.recordKind === undefined ? REPAIR_ATTEMPT : input.recordKind;
  if (!RECORD_KINDS.includes(recordKind)) throw new Error(`INVALID_REPAIR_RECORD_KIND:${String(recordKind)}`);
  const defectId = canonicalIdentifier(input.defectId, 'DEFECT_ID');
  const rootCauseClass = canonicalIdentifier(input.rootCauseClass, 'ROOT_CAUSE_CLASS');
  if (!OUTCOMES.includes(input.outcome)) throw new Error(`INVALID_REPAIR_OUTCOME:${String(input.outcome)}`);
  // Every outcome is an assertion about reality, so it has to point at the
  // thing that established it. RESOLVED needs more than this; see above.
  if (typeof input.evidenceRef !== 'string' || !input.evidenceRef) throw new Error('REPAIR_OUTCOME_EVIDENCE_REQUIRED');
  if (input.scope !== undefined && !Array.isArray(input.scope)) throw new Error('REPAIR_SCOPE_MUST_BE_ARRAY');
  const scope = [...new Set((input.scope || []).map((entry) => canonicalIdentifier(entry, 'SCOPE')))].sort(compareIdentifiers);

  // ROOT_CAUSE_ANALYSIS is not a patch, so it has no repair class and never
  // consumes an attempt. An unlabelled patch defaults to TARGETED_INCREMENTAL:
  // the class that counts against containment is the fail-closed default, so
  // forgetting the label can never launder a patch into a structural fix.
  let repairClass = null;
  if (recordKind === REPAIR_ATTEMPT) {
    repairClass = input.repairClass === undefined ? TARGETED_INCREMENTAL : input.repairClass;
    if (!REPAIR_CLASSES.includes(repairClass)) throw new Error(`INVALID_REPAIR_CLASS:${String(input.repairClass)}`);
  } else if (input.repairClass !== undefined && input.repairClass !== null) {
    throw new Error('REPAIR_CLASS_ONLY_FOR_REPAIR_ATTEMPT');
  }

  const attemptOrdinal = recordKind === REPAIR_ATTEMPT ? nextOrdinal(records, rootCauseClass, repairClass) : null;
  if (input.attemptOrdinal !== undefined && input.attemptOrdinal !== attemptOrdinal) {
    throw new Error(`REPAIR_ATTEMPT_ORDINAL_MISMATCH:${rootCauseClass}:${attemptOrdinal}`);
  }
  return {
    recordKind,
    repairClass,
    defectId,
    rootCauseClass,
    symptom: typeof input.symptom === 'string' && input.symptom ? input.symptom.normalize('NFC') : null,
    scope,
    attemptOrdinal,
    outcome: input.outcome,
    evidenceRef: input.evidenceRef.normalize('NFC'),
    resolutionEvidence: normalizeResolutionEvidence(input.resolutionEvidence, input.outcome)
  };
}

/**
 * Appends one record and returns a NEW ledger. The supplied ledger is never
 * mutated, and it is verified first so a tampered history cannot be extended
 * into a clean-looking one.
 */
export function appendRepairRecord(ledger, input) {
  verifyRepairLedger(ledger);
  const records = ledger.records.map((record) => ({ ...record }));
  const record = { ...normalizeRecord(records, input), previousLedgerSha256: ledger.ledgerSha256 };
  return sealLedger([...records, record]);
}

/**
 * Replays the ledger from empty. Structure, chain and every attempt ordinal are
 * recomputed, so an edited, reordered, deleted or back-dated record fails here
 * rather than quietly changing a containment verdict.
 */
export function verifyRepairLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new Error('REPAIR_LEDGER_REQUIRED');
  if (ledger.schemaVersion !== 1 || ledger.ledgerKind !== REPAIR_LEDGER_KIND || ledger.engine !== REPAIR_CONTAINMENT_VERSION) throw new Error('INVALID_REPAIR_LEDGER_IDENTITY');
  if (!Array.isArray(ledger.records)) throw new Error('INVALID_REPAIR_LEDGER_STRUCTURE');
  const replay = [];
  for (const record of ledger.records) {
    const expectedPrevious = sealLedger(replay.map((item) => ({ ...item }))).ledgerSha256;
    if (record?.previousLedgerSha256 !== expectedPrevious) throw new Error(`REPAIR_LEDGER_CHAIN_BROKEN:${record?.defectId ?? 'UNKNOWN'}`);
    const { previousLedgerSha256, ...body } = record;
    const normalized = normalizeRecord(replay, body);
    if (sha256Canonical(normalized) !== sha256Canonical(body)) throw new Error(`REPAIR_RECORD_MUTATED:${body.defectId}`);
    replay.push({ ...normalized, previousLedgerSha256 });
  }
  if (ledger.ledgerSha256 !== sealLedger(replay).ledgerSha256) throw new Error('INVALID_REPAIR_LEDGER_DIGEST');
  return true;
}

/**
 * The containment verdict for one root-cause class.
 *
 * The number the threshold reads is `containmentCount`: TARGETED INCREMENTAL
 * attempts in the active window that have NOT been shown to resolve the root
 * cause. That deliberately includes a RESOLVED record whose evidence nobody
 * verified — otherwise relabelling a failed patch as "resolved" with an
 * arbitrary reference would reset the counter, which is precisely the evasion
 * this must not permit.
 *
 * Structural corrections and root-cause analyses are counted and reported but
 * never gate anything: they are the way OUT of a cascade, not part of it.
 *
 * @param {object} [options]
 * @param {(resolutionEvidence: object, record: object) => boolean} [options.verifyResolution]
 *   Caller-supplied predicate proving a resolution claim. The router builds one
 *   from its own verified R4 evaluation. Absent: every claim stays unverified.
 */
export function evaluateContainment(ledger, rootCauseClass, { verifyResolution = null } = {}) {
  verifyRepairLedger(ledger);
  const lineageKey = canonicalIdentifier(rootCauseClass, 'ROOT_CAUSE_CLASS');
  const lineage = lineageRecords(ledger.records, lineageKey);
  const window = activeWindow(ledger.records, lineageKey, verifyResolution);
  const attemptsOfClass = (records, repairClass) => records.filter((record) => record.recordKind === REPAIR_ATTEMPT && record.repairClass === repairClass);
  const targeted = attemptsOfClass(window, TARGETED_INCREMENTAL);
  const structural = attemptsOfClass(window, STRUCTURAL);
  const stateOf = (record) => resolutionStateOf(record, verifyResolution);

  const containmentCount = targeted.filter((record) => stateOf(record) !== VERIFIED_RESOLUTION).length;
  const contained = containmentCount >= CONTAINMENT_SURVIVAL_THRESHOLD;
  const lineageState = containmentCount === 0 ? NORMAL
    : containmentCount === 1 ? TARGETED_REPAIR_1
      : containmentCount === CONTAINMENT_SURVIVAL_THRESHOLD ? STOP_PATCH_CASCADE
        : ROOT_CAUSE_REQUIRED;

  // Analyses are counted in the ACTIVE window only. An analysis performed
  // before a verified resolution belongs to the lineage that closed, so it
  // cannot pre-authorize the structural repair of a later recurrence.
  const rootCauseAnalyses = window.filter((record) => record.recordKind === ROOT_CAUSE_ANALYSIS).length;

  // Where in the window the cascade actually stopped: the targeted attempt that
  // brought the unresolved count up to the threshold. Position comes from the
  // append-only ordering that is already there; no timestamps are involved.
  let unresolvedSoFar = 0;
  let containmentIndex = -1;
  window.forEach((record, index) => {
    if (containmentIndex !== -1) return;
    if (record.recordKind !== REPAIR_ATTEMPT || record.repairClass !== TARGETED_INCREMENTAL) return;
    if (stateOf(record) === VERIFIED_RESOLUTION) return;
    unresolvedSoFar += 1;
    if (unresolvedSoFar >= CONTAINMENT_SURVIVAL_THRESHOLD) containmentIndex = index;
  });
  // Only an analysis that came AFTER the stop can satisfy the stop. One
  // performed earlier was reasoning about a lineage that had not yet failed
  // twice, so treating it as the prerequisite would let a cascade be escaped by
  // work that predates the thing it is supposed to explain.
  const postContainmentRootCauseAnalyses = containmentIndex === -1 ? 0
    : window.slice(containmentIndex + 1).filter((record) => record.recordKind === ROOT_CAUSE_ANALYSIS).length;

  // A stopped cascade is stopped for incremental patching AND for relabelling
  // the same patch as structural. What lifts it is the analysis the stop asked
  // for — a prerequisite, not an approval, and one the lineage can satisfy
  // itself, so structural work is never permanently blocked.
  const structuralRepairAuthorized = !contained || postContainmentRootCauseAnalyses > 0;

  return {
    rootCauseClass: lineageKey,
    targetedAttempts: targeted.length,
    structuralAttempts: structural.length,
    rootCauseAnalyses,
    postContainmentRootCauseAnalyses,
    survivedTargetedAttempts: targeted.filter((record) => record.outcome === SURVIVED).length,
    unprovenResolutionClaims: window.filter((record) => stateOf(record) === RECORDED_RESOLUTION_CLAIM || stateOf(record) === REJECTED_RESOLUTION_CLAIM).length,
    verifiedResolutions: lineage.filter((record) => stateOf(record) === VERIFIED_RESOLUTION).length,
    containmentCount,
    lineageState,
    nextTargetedAttemptOrdinal: nextOrdinal(ledger.records, lineageKey, TARGETED_INCREMENTAL),
    nextAttemptState: contained ? STOP_PATCH_CASCADE : containmentCount === 1 ? TARGETED_REPAIR_2 : TARGETED_REPAIR_1,
    incrementalPatchAuthorized: !contained,
    structuralRepairAuthorized,
    structuralRepairObstacle: structuralRepairAuthorized ? null : 'ROOT_CAUSE_ANALYSIS_REQUIRED_BEFORE_STRUCTURAL_REPAIR',
    requiredNextAction: contained ? ROOT_CAUSE_ANALYSIS : REPAIR_ATTEMPT,
    reasonCode: contained
      ? `SAME_ROOT_CAUSE_UNRESOLVED_AFTER_${containmentCount}_TARGETED_REPAIRS`
      : containmentCount === 1 ? 'ONE_TARGETED_REPAIR_UNRESOLVED_SECOND_ATTEMPT_AUTHORIZED' : 'NO_UNRESOLVED_TARGETED_REPAIR_ATTEMPT'
  };
}

/** Deterministic identity of the containment input a route digest binds. */
export function repairLedgerSha256(ledger) {
  verifyRepairLedger(ledger);
  return ledger.ledgerSha256;
}

export function serializeRepairLedger(ledger) {
  verifyRepairLedger(ledger);
  return `${JSON.stringify(ledgerBody(ledger.records.map((record) => ({ ...record }))), null, 2)}\n`;
}

export function parseRepairLedger(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('INVALID_REPAIR_LEDGER_JSON');
  }
  if (!parsed || !Array.isArray(parsed.records)) throw new Error('INVALID_REPAIR_LEDGER_STRUCTURE');
  const ledger = sealLedger(parsed.records.map((record) => ({ ...record })));
  if (ledger.schemaVersion !== parsed.schemaVersion || ledger.ledgerKind !== parsed.ledgerKind || ledger.engine !== parsed.engine) throw new Error('INVALID_REPAIR_LEDGER_IDENTITY');
  verifyRepairLedger(ledger);
  return ledger;
}
