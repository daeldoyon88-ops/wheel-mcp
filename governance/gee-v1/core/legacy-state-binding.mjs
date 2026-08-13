/**
 * H5 — interpreting the two pre-native state-binding events.
 *
 * Events 57 and 58 were written before events pinned state natively. They bound
 * a state revision in substance but not in form, so something has to say which
 * revision each one bound. That "something" is a legacy binding record.
 *
 * THE DANGER, STATED PLAINLY. A record that declares what a historical event
 * meant is indistinguishable, structurally, from a record that INVENTS what a
 * historical event meant. If such a record were trusted on its own say-so, it
 * would be a way to rewrite history without touching the ledger.
 *
 * THE RULE THAT MAKES IT SAFE. A legacy binding record carries NO authority of
 * its own. It is valid only where it AGREES with evidence that was already
 * immutable before this program existed:
 *
 *   the event bytes and its payload digest   (append-only ledger)
 *   the original authority path and digest   (the event's own citation)
 *   the ledger prefix through that ordinal   (append-only ledger)
 *   the state revision and its seal bytes    (immutable revision members)
 *   the seal's own chain link and status     (immutable seal)
 *
 * Every one of those is checked against real bytes. The record adds
 * interpretation and NOTHING else: it grants no transition, no status change,
 * no contract change, no execution. Disagreement anywhere is BLOCK, never
 * "prefer the record".
 *
 * AND IT CANNOT REACH FORWARD. From ordinal 59 the ledger pins state natively,
 * so a legacy record claiming a native-era ordinal is refused outright. Without
 * that boundary the legacy path would be a permanent bypass around native
 * pinning — which is exactly the hole this phase exists to close.
 *
 * Pure: no filesystem. Callers supply bytes and parsed documents.
 */

export const LEGACY_STATE_BINDINGS_KIND = 'HISTORICAL_ARCHITECTURE_LEGACY_STATE_BINDINGS';
export const LEGACY_STATE_BINDINGS_SCHEMA_VERSION = 1;
export const DEFAULT_LEGACY_ERA_MAX_ORDINAL = 58;

/** Interpretation only. A binding record may never claim any of these. */
export const FORBIDDEN_BINDING_CLAIMS = Object.freeze([
  'toStatusOverride', 'statusMutation', 'contractRevision', 'contractMutation',
  'transitionAuthorized', 'executionAuthorized', 'startAuthorized',
  'closureAuthorized', 'r8Authorized', 'activeGateSwitch'
]);

const BINDING_FIELDS = Object.freeze([
  'eventOrdinal', 'eventId', 'gateId', 'transitionType', 'toStatus',
  'eventPayloadSha256', 'originalAuthorityPath', 'originalAuthoritySha256',
  'ledgerPrefixSha256', 'stateRevision', 'stateRevisionSealPath',
  'stateRevisionSealSha256', 'stateRevisionSealByteLength',
  'previousStateSealSha256', 'agreementRules', 'sealPayloadExecutionStatus',
  'derivedFrom'
]);

const REVISION_RE = /^R[0-9]{4}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

/**
 * Check one binding record against the immutable evidence it claims to describe.
 *
 * `evidence` supplies what was actually observed:
 *   { event, ledgerPrefixSha256, authoritySha256, seal: {sha256, byteLength, json},
 *     predecessorSealSha256 }
 */
export function evaluateLegacyStateBinding({ binding = null, evidence = {}, legacyEraMaxOrdinal = DEFAULT_LEGACY_ERA_MAX_ORDINAL } = {}) {
  const findings = [];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    finding(findings, 'LEGACY_BINDING_ABSENT');
    return { decision: 'BLOCKED', findings };
  }
  for (const key of Object.keys(binding)) if (!BINDING_FIELDS.includes(key)) finding(findings, 'LEGACY_BINDING_UNKNOWN_FIELD', key);
  // A record that tries to grant anything is refused on sight, before any
  // agreement check, because agreement would otherwise legitimise the grant.
  for (const claim of FORBIDDEN_BINDING_CLAIMS) {
    if (Object.hasOwn(binding, claim)) finding(findings, 'LEGACY_BINDING_CLAIMS_PERMISSION', claim);
  }

  if (!Number.isInteger(binding.eventOrdinal) || binding.eventOrdinal < 1) finding(findings, 'LEGACY_BINDING_ORDINAL_INVALID');
  else if (binding.eventOrdinal > legacyEraMaxOrdinal) finding(findings, 'NATIVE_ERA_MIGRATION_FORBIDDEN', binding.eventOrdinal);
  if (!REVISION_RE.test(binding.stateRevision || '')) finding(findings, 'LEGACY_BINDING_REVISION_INVALID');
  if (!SHA256_RE.test(binding.stateRevisionSealSha256 || '')) finding(findings, 'LEGACY_BINDING_SEAL_DIGEST_INVALID');

  const event = evidence.event;
  if (!event) {
    finding(findings, 'LEGACY_BINDING_EVENT_NOT_FOUND', binding.eventOrdinal);
    return { decision: 'BLOCKED', findings };
  }
  // --- agreement with the append-only ledger -------------------------------
  if (event.ordinal !== binding.eventOrdinal) finding(findings, 'LEGACY_BINDING_EVENT_MISMATCH', 'ordinal');
  if (event.eventId !== binding.eventId) finding(findings, 'LEGACY_BINDING_EVENT_MISMATCH', 'eventId');
  if (event.gateId !== binding.gateId) finding(findings, 'LEGACY_BINDING_GATE_MISMATCH', event.gateId);
  if (event.transitionType !== binding.transitionType) finding(findings, 'LEGACY_BINDING_TRANSITION_MISMATCH', event.transitionType);
  if (event.toStatus !== binding.toStatus) finding(findings, 'LEGACY_BINDING_STATUS_MISMATCH', event.toStatus);
  if (event.eventPayloadSha256 !== binding.eventPayloadSha256) finding(findings, 'LEGACY_BINDING_PAYLOAD_MISMATCH');
  if (evidence.ledgerPrefixSha256 !== binding.ledgerPrefixSha256) finding(findings, 'LEGACY_BINDING_LEDGER_PREFIX_MISMATCH');

  // --- agreement with the event's own cited authority ----------------------
  if (event.authorityPath !== binding.originalAuthorityPath) finding(findings, 'LEGACY_BINDING_AUTHORITY_PATH_MISMATCH', event.authorityPath);
  if (event.authoritySha256 !== binding.originalAuthoritySha256) finding(findings, 'LEGACY_BINDING_AUTHORITY_DIGEST_MISMATCH');
  if (evidence.authoritySha256 !== binding.originalAuthoritySha256) finding(findings, 'LEGACY_BINDING_AUTHORITY_BYTES_MISMATCH');

  // --- agreement with the immutable seal -----------------------------------
  const seal = evidence.seal;
  if (!seal) {
    finding(findings, 'LEGACY_BINDING_SEAL_NOT_FOUND', binding.stateRevision);
    return { decision: 'BLOCKED', findings };
  }
  if (seal.sha256 !== binding.stateRevisionSealSha256) finding(findings, 'LEGACY_BINDING_SEAL_BYTES_MISMATCH');
  if (Number.isInteger(binding.stateRevisionSealByteLength) && seal.byteLength !== binding.stateRevisionSealByteLength) finding(findings, 'LEGACY_BINDING_SEAL_LENGTH_MISMATCH');
  if (seal.json?.gateId !== binding.gateId) finding(findings, 'LEGACY_BINDING_SEAL_GATE_MISMATCH', seal.json?.gateId);
  if (seal.json?.stateRevision !== binding.stateRevision) finding(findings, 'LEGACY_BINDING_SEAL_REVISION_MISMATCH', seal.json?.stateRevision);
  // The seal's own recorded execution status must be the status this event
  // produced. This is what stops a record binding an event to a seal from a
  // different moment in the gate's life.
  if (seal.json?.payload?.executionStatus !== binding.toStatus) finding(findings, 'LEGACY_BINDING_SEAL_STATUS_DISAGREEMENT', seal.json?.payload?.executionStatus);
  if (seal.json?.previousStateSealSha256 !== binding.previousStateSealSha256) finding(findings, 'LEGACY_BINDING_SEAL_CHAIN_MISMATCH');
  // A non-root binding must chain to the seal the PREVIOUS binding bound.
  if (evidence.predecessorSealSha256 !== undefined && binding.previousStateSealSha256 !== evidence.predecessorSealSha256) {
    finding(findings, 'LEGACY_BINDING_PREDECESSOR_DISAGREEMENT');
  }

  return { decision: findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED', findings, grantsPermission: false };
}

/** Validate the whole document: shape, uniqueness, and no conflicting claims. */
export function validateLegacyStateBindingsDocument(document) {
  const findings = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    finding(findings, 'LEGACY_BINDINGS_DOCUMENT_ABSENT');
    return { valid: false, findings };
  }
  if (document.documentKind !== LEGACY_STATE_BINDINGS_KIND) finding(findings, 'LEGACY_BINDINGS_KIND_INVALID');
  if (document.schemaVersion !== LEGACY_STATE_BINDINGS_SCHEMA_VERSION) finding(findings, 'LEGACY_BINDINGS_SCHEMA_VERSION_INVALID');
  if (!Number.isInteger(document.legacyEraMaxOrdinal) || document.legacyEraMaxOrdinal < 1) finding(findings, 'LEGACY_ERA_BOUNDARY_INVALID');
  if (!Array.isArray(document.bindings) || document.bindings.length === 0) {
    finding(findings, 'LEGACY_BINDINGS_EMPTY');
    return { valid: false, findings };
  }
  const byOrdinal = new Map();
  const byRevision = new Map();
  for (const binding of document.bindings) {
    if (byOrdinal.has(binding?.eventOrdinal)) finding(findings, 'LEGACY_BINDING_DUPLICATE', binding.eventOrdinal);
    byOrdinal.set(binding?.eventOrdinal, binding);
    const key = `${binding?.gateId}/${binding?.stateRevision}`;
    // Two ordinals binding the same revision is a CONFLICT, not a duplicate:
    // one revision cannot have been established twice.
    if (byRevision.has(key)) finding(findings, 'LEGACY_BINDING_CONFLICT', key);
    byRevision.set(key, binding);
  }
  return { valid: findings.length === 0, findings };
}
