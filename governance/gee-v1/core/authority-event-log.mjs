/**
 * GEE V1 core — authority event log projection.
 * RC-2 support: `value` for a work unit's AuthoritativeState comes from the
 * ledger (the primitive with the closed transition table and mandatory
 * external-reinspection rule for COMPLETE_CONFIRMED), never from a seal
 * payload or a generated snapshot. This module is a pure projection: it takes
 * an already-computed ledger validation report (see governance/tools/
 * validate-status-ledger.mjs) and a graded trust level (see head-witness.mjs)
 * and produces an AuthoritativeState for one work unit. It performs no I/O
 * and knows nothing about Wheel or any other project.
 */

import { createAuthoritativeState } from './authoritative-state.mjs';
import { assertIdentityBinding } from './identity-binding.mjs';

/**
 * @param {{
 *   ledgerReport: { valid: boolean, gates: Array<{gateId:string, currentStatus:string}>, ledgerSha256: string, events: Array<object> },
 *   ledgerPath: string,
 *   workUnitId: string,
 *   projectId?: string,
 *   trustLevel: string,
 *   subtreePrefix?: string
 * }} input
 */
export function deriveAuthoritativeStateFromLedger({ ledgerReport, ledgerPath, workUnitId, projectId, trustLevel, subtreePrefix }) {
  const events = Array.isArray(ledgerReport?.events) ? ledgerReport.events : [];
  const ownEvents = events.filter((event) => event.gateId === workUnitId);
  const claims = ownEvents.map((event, index) => ({ source: `ledger-event[${index}]`, workUnitId: event.gateId }));
  const binding = assertIdentityBinding({ projectId, workUnitId, subtreePrefix }, claims);

  const row = Array.isArray(ledgerReport?.gates) ? ledgerReport.gates.find((gate) => gate.gateId === workUnitId) : null;
  const verified = ledgerReport?.valid === true && row !== null && row !== undefined && binding.status === 'BOUND';

  return createAuthoritativeState({
    value: row ? row.currentStatus : 'UNKNOWN',
    verified,
    trustLevel,
    authority: { kind: 'GATE_STATUS_LEDGER', ref: ledgerPath, sha256: ledgerReport?.ledgerSha256 || null },
    evidenceRef: [ledgerPath],
    identityBinding: binding.status
  });
}

/**
 * A work unit has a real (non-genesis) transition recorded when at least one
 * of its ledger events has a transitionType other than GENESIS_IMPORT.
 */
export function hasNonGenesisTransition(ledgerReport, workUnitId) {
  const events = Array.isArray(ledgerReport?.events) ? ledgerReport.events : [];
  return events.some((event) => event.gateId === workUnitId && event.transitionType !== 'GENESIS_IMPORT');
}

const ACTIVATION_LEDGER_BINDING_STATES = Object.freeze(['PROVEN', 'FAILED', 'UNKNOWN']);

/**
 * R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: does a canonical ledger transition for THIS work unit
 * pin the EXACT activation-authority bytes a caller is about to trust?
 *
 * This closes the residual gap a coordinated LOCAL reseal exploited: authorityState.consistent
 * (see deriveAuthoritativeStateFromLedger above) only proves the ledger agrees with the work
 * unit's generic status STRING (e.g. "AUTHORIZED_NOT_STARTED") — it says nothing about WHICH
 * activation-authority record that status was granted for. A contract+seal+activation-authority
 * recomputed together, then locally resealed, reproduces the same status string and is therefore
 * "consistent" by that check alone, while pinning nothing to the ledger at all.
 *
 * Generic on purpose (RC-3/HF13-style de-Wheelification): callers pass workUnitId,
 * transitionType, authorityPath and authoritySha256 — no GATE-numbered or project literal here.
 * A project adapter (e.g. wheel-project-adapter.mjs) decides WHICH transitionType is its
 * canonical activation point and WHAT authorityPath/authoritySha256 the live activation-authority
 * bytes actually hash to; this function only asks the ledger "does exactly one of your events for
 * this work unit and this transition agree with that?".
 *
 * @param {{
 *   ledgerReport: { valid: boolean, events: Array<object> },
 *   workUnitId: string,
 *   transitionType: string,
 *   authorityPath: string,
 *   authoritySha256: string
 * }} input
 * @returns {{ state: 'PROVEN'|'FAILED'|'UNKNOWN', reason?: string, eventOrdinal?: number|null, eventId?: string|null }}
 */
export function deriveActivationLedgerBinding({ ledgerReport, workUnitId, transitionType, authorityPath, authoritySha256 }) {
  if (typeof workUnitId !== 'string' || !workUnitId || typeof transitionType !== 'string' || !transitionType) {
    return { state: 'FAILED', reason: 'ACTIVATION_LEDGER_BINDING_INPUT_INVALID', eventOrdinal: null, eventId: null };
  }
  if (typeof authorityPath !== 'string' || !authorityPath || typeof authoritySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(authoritySha256)) {
    return { state: 'FAILED', reason: 'ACTIVATION_AUTHORITY_REFERENCE_INVALID', eventOrdinal: null, eventId: null };
  }
  if (!ledgerReport || ledgerReport.valid !== true) {
    return { state: 'UNKNOWN', reason: 'LEDGER_NOT_VALID', eventOrdinal: null, eventId: null };
  }

  const events = Array.isArray(ledgerReport.events) ? ledgerReport.events : [];
  const ownEvents = events.filter((event) => event.gateId === workUnitId && event.transitionType === transitionType);

  if (ownEvents.length === 0) {
    const foreignMatch = events.some((event) =>
      event.transitionType === transitionType &&
      event.gateId !== workUnitId &&
      event.authorityPath === authorityPath &&
      event.authoritySha256 === authoritySha256
    );
    if (foreignMatch) {
      return { state: 'FAILED', reason: 'ACTIVATION_LEDGER_BINDING_FOREIGN_WORK_UNIT', eventOrdinal: null, eventId: null };
    }
    return { state: 'UNKNOWN', reason: 'NO_ACTIVATION_LEDGER_EVENT', eventOrdinal: null, eventId: null };
  }

  if (ownEvents.length > 1) {
    return {
      state: 'FAILED',
      reason: 'ACTIVATION_LEDGER_BINDING_AMBIGUOUS',
      eventOrdinal: null,
      eventId: null,
      candidateEventOrdinals: ownEvents.map((event) => event.ordinal)
    };
  }

  const [event] = ownEvents;
  if (event.authorityPath !== authorityPath) {
    return {
      state: 'FAILED',
      reason: 'ACTIVATION_LEDGER_BINDING_AUTHORITY_PATH_MISMATCH',
      eventOrdinal: event.ordinal,
      eventId: event.eventId,
      pinnedAuthorityPath: event.authorityPath,
      actualAuthorityPath: authorityPath
    };
  }
  if (event.authoritySha256 !== authoritySha256) {
    return {
      state: 'FAILED',
      reason: 'ACTIVATION_LEDGER_BINDING_AUTHORITY_SHA_MISMATCH',
      eventOrdinal: event.ordinal,
      eventId: event.eventId,
      pinnedAuthoritySha256: event.authoritySha256,
      actualAuthoritySha256: authoritySha256
    };
  }

  return {
    state: 'PROVEN',
    reason: null,
    eventOrdinal: event.ordinal,
    eventId: event.eventId,
    authorityPath: event.authorityPath,
    authoritySha256: event.authoritySha256
  };
}

export function isActivationLedgerBindingState(value) {
  return ACTIVATION_LEDGER_BINDING_STATES.includes(value);
}
