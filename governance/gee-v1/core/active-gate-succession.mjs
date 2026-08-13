/**
 * H4 — the ACTIVE_GATE pointer, and a generic finite succession primitive.
 *
 * TWO SEPARATE FACTS, PREVIOUSLY CONFLATED.
 *
 * ACTIVE_GATE answers "which Gate owns the lifecycle right now". That is a
 * LIFECYCLE OWNERSHIP pointer. It is NOT the same as "which Gate is currently
 * executable" — GATE13 owns the pointer while GATE14 executes, and that is
 * correct, not a bug to be tidied away.
 *
 * THE DEFECT. The pointer also carried `currentStateSha256`, the byte digest of
 * governance/state/generated/GATE_STATUS_SNAPSHOT.json. That file is a
 * RECONSTRUCTABLE_PROJECTION: it is regenerated from scratch every single time
 * the ledger grows. So the pointer pinned bytes guaranteed to change on the next
 * append. Two consequences:
 *
 *   - every ledger append forced an ACTIVE_GATE rewrite, making a stable
 *     lifecycle pointer churn for reasons that have nothing to do with lifecycle;
 *   - any historical reference to ACTIVE_GATE became unverifiable the moment the
 *     snapshot moved, because the thing it pinned no longer existed.
 *
 * THE FIX. Bind only STABLE identity: the activation event's id, ordinal and
 * payload digest — all of which are immutable ledger facts. The derived snapshot
 * is still NAMED (it is useful to know which projection corresponds), but its
 * bytes are no longer pinned, so `currentStateSha256` is null.
 *
 * Legacy ACTIVE_GATE bytes stay replayable: nothing here rewrites history, and
 * the historical form is reconstructed from the ledger prefix plus the retained
 * generator identity exactly as before (see H1).
 *
 * SUCCESSION, WITHOUT A KEY SUBSYSTEM. A succession is valid through exact
 * pre-head, exact previous ACTIVE_GATE, exact ledger identity, exact next
 * ACTIVE_GATE and a single-use local authority — committed to Git. No signature,
 * no key rotation, no recovery root, and no standalone uncommitted hash chain
 * that could redefine canonical history by being added to or removed.
 *
 * Pure: no filesystem, no clock.
 */

export const ACTIVE_GATE_SUCCESSION_KIND = 'ACTIVE_GATE_SUCCESSION_RECORD';
export const ACTIVE_GATE_SUCCESSION_SCHEMA_VERSION = 1;

const GATE_RE = /^GATE[0-9]{2}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;

const RECORD_FIELDS = Object.freeze([
  'documentKind', 'schemaVersion', 'recordId', 'programId', 'preHead',
  'previousActiveGate', 'nextActiveGate', 'activationEventId',
  'activationEventOrdinal', 'activationEventSha256', 'ledgerEventCount',
  'ledgerPrefixSha256', 'authorityId', 'maxUse'
]);

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

/**
 * Validate an ACTIVE_GATE pointer document.
 *
 * The single rule that matters here: a pointer may name a derived projection but
 * may never pin its bytes.
 */
export function validateActiveGatePointer(pointer) {
  const findings = [];
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
    finding(findings, 'ACTIVE_GATE_ABSENT');
    return { valid: false, findings };
  }
  if (!GATE_RE.test(pointer.activeGate || '')) finding(findings, 'ACTIVE_GATE_ID_INVALID', pointer.activeGate);
  if (typeof pointer.activationEventId !== 'string' || !pointer.activationEventId) finding(findings, 'ACTIVATION_EVENT_ID_INVALID');
  if (!Number.isInteger(pointer.activationEventOrdinal) || pointer.activationEventOrdinal < 1) finding(findings, 'ACTIVATION_EVENT_ORDINAL_INVALID');
  if (!SHA256_RE.test(pointer.activationEventSha256 || '')) finding(findings, 'ACTIVATION_EVENT_DIGEST_INVALID');
  if (pointer.currentStateSha256 !== null && pointer.currentStateSha256 !== undefined && pointer.currentStateSha256 !== '') {
    finding(findings, 'ACTIVE_GATE_PINS_MUTABLE_PROJECTION', pointer.currentStatePath ?? null);
  }
  return { valid: findings.length === 0, findings };
}

/**
 * Validate one ACTIVE_GATE succession against observed facts.
 *
 * Every binding is exact and finite; nothing is inferred, and a succession is
 * never authorized by resemblance.
 */
export function evaluateActiveGateSuccession({ record = null, observed = {}, authorityAuthorized = false } = {}) {
  const findings = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    finding(findings, 'SUCCESSION_RECORD_ABSENT');
    return { decision: 'BLOCKED', findings };
  }
  for (const key of Object.keys(record)) if (!RECORD_FIELDS.includes(key)) finding(findings, 'SUCCESSION_UNKNOWN_FIELD', key);
  if (record.documentKind !== ACTIVE_GATE_SUCCESSION_KIND) finding(findings, 'SUCCESSION_KIND_INVALID');
  if (record.schemaVersion !== ACTIVE_GATE_SUCCESSION_SCHEMA_VERSION) finding(findings, 'SUCCESSION_SCHEMA_VERSION_INVALID');
  if (!COMMIT_RE.test(record.preHead || '')) finding(findings, 'SUCCESSION_PRE_HEAD_INVALID');
  if (!GATE_RE.test(record.previousActiveGate || '')) finding(findings, 'SUCCESSION_PREVIOUS_GATE_INVALID');
  if (!GATE_RE.test(record.nextActiveGate || '')) finding(findings, 'SUCCESSION_NEXT_GATE_INVALID');
  if (record.previousActiveGate === record.nextActiveGate) finding(findings, 'SUCCESSION_IS_NOT_A_TRANSITION');
  if (!SHA256_RE.test(record.activationEventSha256 || '')) finding(findings, 'SUCCESSION_ACTIVATION_DIGEST_INVALID');
  if (!Number.isInteger(record.activationEventOrdinal) || record.activationEventOrdinal < 1) finding(findings, 'SUCCESSION_ACTIVATION_ORDINAL_INVALID');
  if (!Number.isInteger(record.ledgerEventCount) || record.ledgerEventCount < 1) finding(findings, 'SUCCESSION_LEDGER_COUNT_INVALID');
  if (!SHA256_RE.test(record.ledgerPrefixSha256 || '')) finding(findings, 'SUCCESSION_LEDGER_PREFIX_INVALID');
  if (record.maxUse !== 1) finding(findings, 'SUCCESSION_MAX_USE_INVALID');

  if (observed.head !== record.preHead) finding(findings, 'SUCCESSION_HEAD_MISMATCH', observed.head ?? 'ABSENT');
  if (observed.activeGate !== record.previousActiveGate) finding(findings, 'SUCCESSION_PREVIOUS_GATE_MISMATCH', observed.activeGate ?? 'ABSENT');
  if (observed.ledgerEventCount !== record.ledgerEventCount) finding(findings, 'SUCCESSION_LEDGER_COUNT_MISMATCH');
  if (observed.ledgerPrefixSha256 !== record.ledgerPrefixSha256) finding(findings, 'SUCCESSION_LEDGER_PREFIX_MISMATCH');
  if (observed.activationEventSha256 !== record.activationEventSha256) finding(findings, 'SUCCESSION_ACTIVATION_EVENT_MISMATCH');
  if (observed.alreadyConsumed === true) finding(findings, 'SUCCESSION_ALREADY_CONSUMED');
  // Authority comes from the single-use local program authority, never from a
  // signature and never from the record asserting its own legitimacy.
  if (authorityAuthorized !== true) finding(findings, 'SUCCESSION_NOT_AUTHORIZED_BY_PROGRAM_AUTHORITY');

  return { decision: findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED', findings };
}
