/**
 * VERIFIED LEDGER EVIDENCE — the one place that decides whether ledger bytes are
 * evidence at all, as opposed to text that merely parses.
 *
 * THE DEFECT THIS EXISTS FOR. Successor closure was tightened so that only
 * COMPLETE_CONFIRMED and SUPERSEDED admit a successor (see successor-closure.mjs).
 * That fixed WHICH status counts. It did not fix WHERE the status came from.
 *
 * `resolveGateDependencyProofFromEvents` read the last event for a Gate and
 * tested `satisfiesSuccessorClosure(latest.toStatus)` — a string comparison
 * against a scalar lifted straight out of a file. Nothing had checked that the
 * file was the canonical ledger. So editing exactly one byte-range in one line:
 *
 *     "toStatus":"COMPLETE_AGENT"  ->  "toStatus":"COMPLETE_CONFIRMED"
 *
 * without touching eventPayloadSha256, without re-chaining previousEventSha256
 * and without any authority — produced a dependency proof of
 *
 *     satisfied = true, status = COMPLETE_CONFIRMED, reason = LEDGER_TERMINAL_STATUS
 *
 * while the canonical ledger validator correctly reported the ledger as INVALID.
 * The repository held two answers over the same bytes, and the one that gated
 * successor admission was the one that had verified nothing.
 *
 * A SCALAR IS NOT A PROOF. The ledger's integrity is not a property of any single
 * event; it is a property of the CHAIN. Each event pins the payload digest of the
 * event before it, and each event's own payload digest is recomputable from its
 * remaining fields. Those two facts together are what make a terminal status
 * evidence: they say the status was written as part of this history and has not
 * been altered since. Reading `toStatus` without them reads a claim.
 *
 * WHY THIS MODULE, AND NOT A CALL INTO validate-status-ledger. The canonical
 * validator already imports the dependency resolver (it replays authorization
 * events and asks whether each dependency was lawfully disposed at that point).
 * Having the resolver import the validator back would be a cycle, and the mission
 * that required this repair forbids one. The algorithm is therefore extracted
 * DOWNWARD into core, where both sides can depend on it:
 *
 *     verified-ledger-evidence.mjs      (canonical-json only)
 *         ^                       ^
 *         |                       |
 *   gate-dependency-resolution   validate-status-ledger
 *
 * There is exactly one implementation of the chain algorithm, and the validator
 * and the resolver cannot drift apart, because drift would require editing the
 * function they both call.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not check authority binding,
 * transition legality, schema shape, state seals or precontract anchors. Those
 * are the canonical validator's, and duplicating them here would recreate exactly
 * the parallel-validation problem this module exists to remove. This answers one
 * question — "are these bytes an intact canonical chain?" — which is the question
 * a terminal scalar has to survive before anyone may spend it.
 *
 * Pure: no filesystem, no clock, no process state.
 */
import { canonicalize, sha256Canonical } from '../../tools/canonical-json.mjs';

export const VERIFIED_LEDGER_EVIDENCE_DOCUMENT = 'VERIFIED_LEDGER_EVIDENCE';

/**
 * Chain integrity over an ARRAY of already-parsed events.
 *
 * This is the form historical replay needs. A lawfully-recorded historical proof
 * is re-validated against the events that PRECEDED it, not against the live
 * ledger, so the verification has to work on an arbitrary prefix. A genuine
 * prefix of a valid chain is itself a valid chain — that is what makes the
 * append-only structure replayable — so no special case is required for it.
 *
 * `previousEventSha256` of the first event is checked against `null`, which is
 * correct for a true prefix beginning at ordinal 1. A caller replaying a WINDOW
 * that does not start at the beginning must pass `expectedFirstPrevious`.
 */
export function verifyLedgerEventChain(events, { expectedFirstPrevious = null, firstOrdinal = 1 } = {}) {
  const findings = [];
  if (!Array.isArray(events)) {
    return { document: VERIFIED_LEDGER_EVIDENCE_DOCUMENT, verified: false, eventCount: 0, findings: [{ code: 'LEDGER_EVENTS_NOT_AN_ARRAY' }] };
  }
  let expectedPrevious = expectedFirstPrevious;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const ordinal = firstOrdinal + index;
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      findings.push({ code: 'LEDGER_EVENT_NOT_AN_OBJECT', detail: { ordinal } });
      // The chain cannot continue through a non-event: every later link would be
      // reported against a pin this module never established.
      return { document: VERIFIED_LEDGER_EVIDENCE_DOCUMENT, verified: false, eventCount: events.length, findings };
    }
    if (event.ordinal !== ordinal) {
      findings.push({ code: 'LEDGER_ORDINAL_INVALID', detail: { expected: ordinal, actual: event.ordinal ?? null } });
    }
    if (event.previousEventSha256 !== expectedPrevious) {
      findings.push({ code: 'LEDGER_CHAIN_BREAK', detail: { ordinal, field: 'previousEventSha256', expected: expectedPrevious, actual: event.previousEventSha256 ?? null } });
    }
    const declared = event.eventPayloadSha256;
    if (typeof declared !== 'string' || !/^[a-f0-9]{64}$/.test(declared)) {
      findings.push({ code: 'LEDGER_EVENT_PAYLOAD_DIGEST_INVALID', detail: { ordinal, actual: declared ?? null } });
      return { document: VERIFIED_LEDGER_EVIDENCE_DOCUMENT, verified: false, eventCount: events.length, findings };
    }
    const payload = { ...event };
    delete payload.eventPayloadSha256;
    const recomputed = sha256Canonical(payload);
    if (declared !== recomputed) {
      findings.push({ code: 'LEDGER_CHAIN_BREAK', detail: { ordinal, field: 'eventPayloadSha256', expected: recomputed, actual: declared } });
    }
    expectedPrevious = declared;
  }
  return {
    document: VERIFIED_LEDGER_EVIDENCE_DOCUMENT,
    verified: findings.length === 0,
    eventCount: events.length,
    headPayloadSha256: expectedPrevious,
    findings
  };
}

/**
 * Chain integrity over canonical ledger TEXT.
 *
 * The text form catches a class the array form structurally cannot: bytes that
 * are not the canonical serialization of the object they parse to. A ledger whose
 * final line was truncated by a crashed writer, or whose whitespace was reflowed
 * by an editor, parses into objects that chain perfectly — the digests were never
 * touched — while the FILE is no longer the artifact those digests were computed
 * over. `canonicalize(event) === line` is the check that keeps the digest bound
 * to the bytes on disk rather than to an in-memory reconstruction of them.
 *
 * Every line is examined. A parse failure on line 40 does not stop line 41 from
 * being reported, because "how badly is this file damaged" is information an
 * operator needs; but ANY finding at all makes the whole result unverified, so no
 * consumer can read a surviving terminal-looking prefix out of a broken file.
 */
export function verifyLedgerText(text) {
  const findings = [];
  if (typeof text !== 'string') {
    return { document: VERIFIED_LEDGER_EVIDENCE_DOCUMENT, verified: false, eventCount: 0, events: [], findings: [{ code: 'LEDGER_TEXT_UNREADABLE' }] };
  }
  const rawLines = text.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  else if (rawLines.length > 0) findings.push({ code: 'LEDGER_FINAL_NEWLINE_MISSING', detail: { ordinal: rawLines.length } });

  const events = [];
  const seenEventIds = new Set();
  const seenOrdinals = new Set();
  let structurallyIntact = true;
  for (let index = 0; index < rawLines.length; index += 1) {
    const ordinal = index + 1;
    const raw = rawLines[index];
    if (raw.endsWith('\r')) findings.push({ code: 'LEDGER_LINE_ENDING_NON_CANONICAL', detail: { ordinal } });
    const line = raw.replace(/\r$/, '');
    let event;
    try { event = JSON.parse(line); } catch {
      findings.push({ code: 'LEDGER_LINE_UNPARSEABLE', detail: { ordinal } });
      structurallyIntact = false;
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      findings.push({ code: 'LEDGER_EVENT_NOT_AN_OBJECT', detail: { ordinal } });
      structurallyIntact = false;
      continue;
    }
    if (canonicalize(event) !== line) findings.push({ code: 'LEDGER_EVENT_BYTES_NON_CANONICAL', detail: { ordinal } });
    if (seenEventIds.has(event.eventId)) findings.push({ code: 'LEDGER_DUPLICATE_EVENT_ID', detail: { ordinal, eventId: event.eventId ?? null } });
    if (seenOrdinals.has(event.ordinal)) findings.push({ code: 'LEDGER_DUPLICATE_ORDINAL', detail: { ordinal, declared: event.ordinal ?? null } });
    seenEventIds.add(event.eventId);
    seenOrdinals.add(event.ordinal);
    events.push(event);
  }

  // The chain is only meaningful over a complete line set. If a line failed to
  // parse, the events array has a HOLE, and chaining across that hole would
  // report a break that describes the hole rather than the tampering.
  const chain = structurallyIntact
    ? verifyLedgerEventChain(events)
    : { verified: false, findings: [], headPayloadSha256: null };
  findings.push(...chain.findings);

  return {
    document: VERIFIED_LEDGER_EVIDENCE_DOCUMENT,
    verified: structurallyIntact && findings.length === 0,
    eventCount: events.length,
    events,
    headPayloadSha256: chain.headPayloadSha256 ?? null,
    findings
  };
}
