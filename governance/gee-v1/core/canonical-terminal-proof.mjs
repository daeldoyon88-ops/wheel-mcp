/**
 * CANONICAL TERMINAL PROOF — what it takes for a Gate's terminal status to be
 * EVIDENCE that the successor may spend, rather than a string someone wrote.
 *
 * THE DEFECT THIS EXISTS FOR, AND WHY THE FIRST REPAIR WAS NOT ENOUGH.
 *
 * Round one of this repair established that a terminal scalar must come from a
 * chain-intact ledger: canonical bytes, continuous ordinals, a `previousEventSha256`
 * that pins the line before, and an `eventPayloadSha256` that recomputes. That
 * closed the naive forgery — edit `toStatus`, leave the digests stale.
 *
 * It did not close the competent one. An independent hostile edited GATE20's
 * terminal event to COMPLETE_CONFIRMED and then RECOMPUTED `eventPayloadSha256`
 * correctly. The chain stayed perfectly self-consistent, `verifyLedgerText`
 * returned verified, and the dependency resolver returned
 * satisfied/COMPLETE_CONFIRMED/LEDGER_TERMINAL_STATUS — while the canonical ledger
 * validator still said FAIL, because the event was not a lawful transition and its
 * authority did not bind.
 *
 * The lesson is exact and worth stating plainly:
 *
 *     HASH-CHAIN SELF-CONSISTENCY IS NOT TERMINAL STATUS AUTHORITY.
 *
 * A chain proves that a history has not been RETROACTIVELY altered relative to
 * its own digests. It says nothing about whether any given line was ever ALLOWED.
 * A forger who controls the file controls the digests too, so digests alone can
 * only ever prove internal consistency — including the internal consistency of a
 * fabrication.
 *
 * WHAT ACTUALLY MAKES A TERMINAL STATUS CANONICAL. Three things, none optional:
 *
 *   1. CHAIN INTEGRITY — the file is an intact canonical chain
 *      (verified-ledger-evidence.mjs; still necessary, just not sufficient).
 *
 *   2. TRANSITION LEGALITY — the terminal event is a transition the canonical
 *      tables permit, FROM the status the Gate's own replayed history actually
 *      had. COMPLETE_CONFIRMED is reachable only by EXTERNAL_CONFIRMATION from
 *      COMPLETE_AGENT (or by GENESIS_IMPORT). The hostile above fails here: it
 *      relabels an AGENT_CLOSURE/anchor event's status without being the
 *      transition that produces it.
 *
 *   3. AUTHORITY BINDING — the terminal event names an authority, and that
 *      authority's live bytes hash to the digest the event pinned. A confirmation
 *      whose independent reinspection report cannot be resolved, or has been
 *      swapped, is not a confirmation.
 *
 * WHY THIS MODULE EXISTS RATHER THAN A CALL INTO THE VALIDATOR. The canonical
 * ledger validator already imports the dependency resolver, so the resolver
 * cannot import it back without a cycle. The semantics are therefore extracted
 * DOWNWARD to where both can depend on them:
 *
 *                canonical-terminal-proof.mjs
 *                  ^                      ^
 *                  |                      |
 *        gate-dependency-resolution   validate-status-ledger
 *
 * The transition tables below are the ONE normative copy; validate-status-ledger
 * imports and re-exports them, so the two sides cannot drift — drifting would
 * require editing the table they share.
 *
 * WHAT IS DELIBERATELY NOT HERE. Schema shape, state seals, precontract anchor
 * clauses, authorization/start record replay, evidence cohorts. Those belong to
 * the full validator and duplicating them here would rebuild the parallel-
 * validation problem this module exists to remove. This answers one question —
 * "is this terminal status canonically produced?" — which is the question a
 * successor's dependency has to survive.
 */
import fs from 'node:fs';
import path from 'node:path';

import { sha256Bytes } from '../../tools/canonical-json.mjs';

export const CANONICAL_TERMINAL_PROOF_DOCUMENT = 'CANONICAL_TERMINAL_PROOF';

export const STATUSES = Object.freeze([
  'NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'IN_PROGRESS', 'REPAIR_REQUIRED',
  'BLOCKED_GOVERNANCE', 'INTERRUPTED_RESUMABLE', 'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED', 'SUPERSEDED', 'REOPENED_AUTHORIZED'
]);

/**
 * The 21 NORMAL_EXECUTION transitions extracted from I2. Not widened, not
 * relaxed. Moved here from validate-status-ledger so the resolver judges
 * legality by the same table the validator does; that file now imports it.
 */
export const TRANSITIONS = Object.freeze([
  [null, 'NOT_STARTED', 'GENESIS_IMPORT'],
  [null, 'AUTHORIZED_NOT_STARTED', 'GENESIS_IMPORT'],
  [null, 'COMPLETE_CONFIRMED', 'GENESIS_IMPORT'],
  [null, 'IN_PROGRESS', 'GENESIS_IMPORT'],
  [null, 'BLOCKED_GOVERNANCE', 'GENESIS_IMPORT'],
  ['NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'AUTHORIZATION'],
  ['AUTHORIZED_NOT_STARTED', 'IN_PROGRESS', 'START'],
  ['IN_PROGRESS', 'INTERRUPTED_RESUMABLE', 'INTERRUPTION'],
  ['INTERRUPTED_RESUMABLE', 'IN_PROGRESS', 'RESUME'],
  ['IN_PROGRESS', 'REPAIR_REQUIRED', 'DEFECT_OPENED'],
  ['REPAIR_REQUIRED', 'IN_PROGRESS', 'REPAIR_ACCEPTED'],
  ['IN_PROGRESS', 'BLOCKED_GOVERNANCE', 'GOVERNANCE_BLOCK'],
  ['REPAIR_REQUIRED', 'BLOCKED_GOVERNANCE', 'GOVERNANCE_BLOCK'],
  ['BLOCKED_GOVERNANCE', 'IN_PROGRESS', 'GOVERNANCE_UNBLOCK'],
  ['IN_PROGRESS', 'COMPLETE_AGENT', 'AGENT_CLOSURE'],
  ['COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'EXTERNAL_CONFIRMATION'],
  ['COMPLETE_AGENT', 'REPAIR_REQUIRED', 'EXTERNAL_REJECTION'],
  ['COMPLETE_CONFIRMED', 'REOPENED_AUTHORIZED', 'AUTHORIZED_REOPEN'],
  ['REOPENED_AUTHORIZED', 'IN_PROGRESS', 'RESUME_AFTER_REOPEN'],
  ['COMPLETE_CONFIRMED', 'SUPERSEDED', 'SUPERSESSION'],
  ['COMPLETE_AGENT', 'SUPERSEDED', 'SUPERSESSION']
]);

export const NORMAL_EXECUTION_TRANSITION_TYPES = Object.freeze([
  'GENESIS_IMPORT', 'AUTHORIZATION', 'START', 'INTERRUPTION', 'RESUME', 'DEFECT_OPENED',
  'REPAIR_ACCEPTED', 'GOVERNANCE_BLOCK', 'GOVERNANCE_UNBLOCK', 'AGENT_CLOSURE',
  'EXTERNAL_CONFIRMATION', 'EXTERNAL_REJECTION', 'AUTHORIZED_REOPEN', 'RESUME_AFTER_REOPEN',
  'SUPERSESSION'
]);

export const HISTORICAL_RECONCILIATION_TRANSITION_TYPE = 'HISTORICAL_RECONCILIATION';
export const HISTORICAL_RECONCILIATION_TRANSITIONS = Object.freeze([
  ['NOT_STARTED', 'COMPLETE_AGENT', 'HISTORICAL_RECONCILIATION'],
  ['NOT_STARTED', 'INTERRUPTED_RESUMABLE', 'HISTORICAL_RECONCILIATION']
]);

export const CONTRACT_SUCCESSION_TRANSITION_TYPE = 'CONTRACT_SUCCESSION';
export const CONTRACT_SUCCESSION_TRANSITIONS = Object.freeze([
  ['IN_PROGRESS', 'IN_PROGRESS', 'CONTRACT_SUCCESSION']
]);

export const PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITION_TYPE = 'PRECONTRACT_CONSUMPTION_ANCHOR';
export const PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITIONS = Object.freeze([
  ['NOT_STARTED', 'NOT_STARTED', 'PRECONTRACT_CONSUMPTION_ANCHOR'],
  ['COMPLETE_AGENT', 'COMPLETE_AGENT', 'PRECONTRACT_CONSUMPTION_ANCHOR']
]);

/**
 * The four classes, kept apart on purpose.
 *
 * They are never consulted interchangeably: a reconciliation cannot impersonate
 * an execution transition, and an anchor cannot borrow a confirmation's
 * permissions. Legality is membership in the table that owns the event's own
 * declared transitionType — not membership in the union.
 */
const TRANSITION_TABLES = Object.freeze({
  NORMAL_EXECUTION: TRANSITIONS,
  HISTORICAL_RECONCILIATION: HISTORICAL_RECONCILIATION_TRANSITIONS,
  CONTRACT_SUCCESSION: CONTRACT_SUCCESSION_TRANSITIONS,
  PRECONTRACT_CONSUMPTION_ANCHOR: PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITIONS
});

function tableFor(transitionType) {
  if (transitionType === HISTORICAL_RECONCILIATION_TRANSITION_TYPE) return TRANSITION_TABLES.HISTORICAL_RECONCILIATION;
  if (transitionType === CONTRACT_SUCCESSION_TRANSITION_TYPE) return TRANSITION_TABLES.CONTRACT_SUCCESSION;
  if (transitionType === PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITION_TYPE) return TRANSITION_TABLES.PRECONTRACT_CONSUMPTION_ANCHOR;
  if (NORMAL_EXECUTION_TRANSITION_TYPES.includes(transitionType)) return TRANSITION_TABLES.NORMAL_EXECUTION;
  return null;
}

/** Whether (from, to, type) is a transition the class that owns `type` permits. */
export function isPermittedTransition(fromStatus, toStatus, transitionType) {
  const table = tableFor(transitionType);
  if (!table) return false;
  return table.some(([from, to, type]) => from === fromStatus && to === toStatus && type === transitionType);
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

/**
 * Resolve the authority an event cites, and prove its live bytes are the bytes
 * the event pinned.
 *
 * An authority is named EITHER by repository-relative path OR by a declared
 * external authority id — the second is how an independent reinspection report
 * that lives outside the normal governed tree is cited. Both are resolved the
 * same way and neither is trusted more: the declaration only names a candidate
 * file, and the digest still has to match.
 *
 * `migrations` optionally maps `path::pinnedSha` to an immutable snapshot, for
 * historical authorities whose live file has legitimately moved on. The caller
 * supplies it already chain-verified; this function re-derives the snapshot
 * digest rather than trusting the record's own claim.
 */
export function resolveTransitionAuthorityBinding({ root, event, externalAuthorities = [], migrations = null }) {
  const authorityPath = event?.authorityPath;
  if (typeof authorityPath !== 'string' || !authorityPath) {
    return { bound: false, reason: 'MISSING_TRANSITION_AUTHORITY', detail: null };
  }
  const declared = externalAuthorities.find((entry) => entry?.authorityId === authorityPath) || null;
  let filePath;
  if (declared) {
    filePath = path.isAbsolute(declared.path) ? declared.path : path.resolve(root, declared.path);
  } else {
    if (!safeRelativePath(authorityPath)) return { bound: false, reason: 'INVALID_AUTHORITY_PATH', detail: authorityPath };
    filePath = path.resolve(root, authorityPath);
    if (!filePath.startsWith(path.resolve(root) + path.sep)) return { bound: false, reason: 'INVALID_AUTHORITY_PATH', detail: authorityPath };
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { bound: false, reason: 'MISSING_TRANSITION_AUTHORITY', detail: authorityPath };
  }
  const actualSha = sha256Bytes(fs.readFileSync(filePath));
  if (actualSha !== event.authoritySha256) {
    const migration = migrations?.get?.(`${authorityPath}::${event.authoritySha256}`) ?? null;
    if (migration) {
      const snapshotAbsolute = path.resolve(root, migration.snapshotPath);
      const snapshotSha = fs.existsSync(snapshotAbsolute) ? sha256Bytes(fs.readFileSync(snapshotAbsolute)) : null;
      if (snapshotSha === event.authoritySha256 && migration.snapshotSha256 === event.authoritySha256) {
        return { bound: true, reason: 'MIGRATED_HISTORICAL_AUTHORITY', authorityPath, resolvedSha256: snapshotSha };
      }
    }
    return { bound: false, reason: 'AUTHORITY_HASH_MISMATCH', detail: authorityPath, resolvedSha256: actualSha };
  }
  if (declared && declared.sha256 !== actualSha) {
    return { bound: false, reason: 'AUTHORITY_MANIFEST_HASH_MISMATCH', detail: authorityPath, resolvedSha256: actualSha };
  }
  return { bound: true, reason: 'AUTHORITY_BOUND', authorityPath, resolvedSha256: actualSha };
}

/**
 * Replay one Gate's own events and prove the status it ends on.
 *
 * The replay is what makes `fromStatus` meaningful. An event states the status it
 * came from, but a forged event states whatever its author typed; the only
 * trustworthy value is the one the PRECEDING events actually produced. So the
 * replay carries its own running status and checks each event against it, rather
 * than against the event's own claim about the past.
 *
 * Fail-closed at the first illegality: once a Gate's history contains an event
 * that was not permitted, every status after it is downstream of a fabrication,
 * and reporting the end state as if it were reached lawfully is exactly the error
 * this module exists to prevent.
 */
export function proveCanonicalTerminalStatus({ root, gateId, events, externalAuthorities = [], migrations = null }) {
  const findings = [];
  if (!Array.isArray(events)) {
    return { document: CANONICAL_TERMINAL_PROOF_DOCUMENT, proven: false, status: null, findings: [{ code: 'LEDGER_EVENTS_NOT_AN_ARRAY' }] };
  }
  const own = events.filter((event) => event?.gateId === gateId);
  if (own.length === 0) {
    return { document: CANONICAL_TERMINAL_PROOF_DOCUMENT, proven: false, status: 'ABSENT', findings: [{ code: 'GATE_ABSENT_FROM_LEDGER', detail: gateId }] };
  }

  let running = null;
  for (const event of own) {
    const declaredFrom = Object.hasOwn(event, 'fromStatus') ? event.fromStatus : null;
    // The event's own claim about where it came from must agree with what the
    // replay says. Disagreement is not reconciled in either direction.
    if (declaredFrom !== running) {
      findings.push({ code: 'TRANSITION_FROM_STATUS_DISAGREES_WITH_REPLAY', detail: { ordinal: event.ordinal ?? null, declared: declaredFrom, replayed: running } });
      return { document: CANONICAL_TERMINAL_PROOF_DOCUMENT, proven: false, status: null, findings };
    }
    if (!isPermittedTransition(running, event.toStatus, event.transitionType)) {
      findings.push({ code: 'TRANSITION_NOT_PERMITTED', detail: { ordinal: event.ordinal ?? null, from: running, to: event.toStatus ?? null, transitionType: event.transitionType ?? null } });
      return { document: CANONICAL_TERMINAL_PROOF_DOCUMENT, proven: false, status: null, findings };
    }
    running = event.toStatus;
  }

  // The authority of the event that PRODUCED the terminal status. Every event in
  // the replay was legal; this is the one whose authority the successor is about
  // to spend, so it is the one whose bytes must still bind.
  const terminal = own.at(-1);
  const binding = resolveTransitionAuthorityBinding({ root, event: terminal, externalAuthorities, migrations });
  if (!binding.bound) {
    findings.push({ code: 'TERMINAL_AUTHORITY_UNBOUND', detail: { ordinal: terminal.ordinal ?? null, reason: binding.reason, path: binding.detail ?? null } });
    return { document: CANONICAL_TERMINAL_PROOF_DOCUMENT, proven: false, status: null, findings };
  }

  return {
    document: CANONICAL_TERMINAL_PROOF_DOCUMENT,
    proven: true,
    status: running,
    terminalOrdinal: terminal.ordinal ?? null,
    terminalTransitionType: terminal.transitionType ?? null,
    terminalAuthorityPath: terminal.authorityPath ?? null,
    terminalAuthoritySha256: binding.resolvedSha256 ?? null,
    findings: []
  };
}
