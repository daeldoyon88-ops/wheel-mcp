/**
 * CANONICAL LEDGER AUTHORITY — one question, answered by THE canonical validator.
 *
 *     "Is this repository's ledger history CANONICALLY AUTHORIZED?"
 *
 * THE DEFECT THIS EXISTS FOR, STATED EXACTLY.
 *
 * The authenticated closed-state-seal inventory built its positive trust chain as
 *
 *     verifyLedgerText -> resolveStateRevisionLineage -> validateStateSeal
 *                      -> CLOSED_STATE_SEAL_MEMBER -> AUTHORIZED_CURRENT_BYTES
 *
 * and treated the first link as proof that the ledger's state-binding events were
 * lawful. It is not. `verifyLedgerText` proves CHAIN INTEGRITY: canonical bytes,
 * continuous ordinals, `previousEventSha256` pinning the line before, and an
 * `eventPayloadSha256` that recomputes. Every one of those digests is computed by
 * whoever writes the file, so an author who controls the file controls them too:
 *
 *     SELF-HASH IS NOT AUTHENTICITY.
 *     A COHERENT HASH CHAIN IS NOT A CANONICALLY AUTHORIZED HISTORY.
 *
 * The reproduced attack: take a path reported BLOCKED / NO_APPLICABLE_AUTHORITY,
 * mint a state-binding event that pins a new revision, RECHAIN the entire ledger
 * so every digest is correct, and plant a canonically valid STATE_SEAL for that
 * revision naming the path at its current digest. The seal inventory admitted it —
 * while the canonical ledger validator said the transition was not authorized. The
 * repository held two answers over the same bytes, and the one gating byte
 * authorization was the one that had checked no authority at all.
 *
 * WHY THIS FILE IS A REUSE AND NOT A VALIDATOR.
 *
 * There is no transition table here, no authority-resolution rule, no anchor
 * clause, no state-revision rule, no successor rule, no signature check. This file
 * calls `validateLedger` — the same function the `validate-status-ledger` CLI
 * calls, in the same mode, with the same project policy — and reports what it
 * returned. A second implementation of ledger legality is the failure mode this
 * repair exists to remove, so the only way the seal inventory and the validator
 * can disagree about a ledger is if someone edits the function they now share.
 *
 * WHY IT LIVES IN tools/ AND NOT IN core/.
 *
 * `validateLedger` is deliberately project-agnostic: with no policy it cannot
 * assert an external reinspection verdict, so every COMPLETE_CONFIRMED event fails
 * closed. That is correct, pre-existing behaviour, and it means a caller that
 * supplies no policy would report this repository's real, lawful history as
 * unauthorized — turning a fail-closed repair into a vacuous one that destroys the
 * CLOSED_STATE_SEAL_MEMBER binding class outright. The policy is therefore
 * supplied here, exactly as every other tool in this repository supplies it
 * (generate-status-snapshot, validate-active-gate, gate-lifecycle-orchestrator,
 * the validate-status-ledger CLI itself). tools/ is the layer that already knows
 * which project it is auditing; core/ must not, and does not.
 *
 * WHY LEDGER_INTEGRITY MODE.
 *
 * The question is whether this HISTORY was validly written, not whether today's
 * mutable projections agree with the ledger head. Those are two different
 * questions and fusing them is itself a recorded defect (see the H4 note in
 * validate-status-ledger.mjs): a seal that lawfully froze bytes long ago would
 * stop being evidence the moment an unrelated CURRENT_STATE pointer moved
 * forward. Immutable artifacts stay fully byte-checked in this mode; nothing is
 * relaxed except the question being asked.
 *
 * NO CLI, NO SUBPROCESS, NO EXIT CODE. The verdict is the return value of the
 * canonical function, called in-process against the supplied `root`, so it stays
 * valid for a disposable candidate tree and never becomes a claim some other
 * process made about some other directory.
 */
import fs from 'node:fs';
import path from 'node:path';

import { validateLedger, MODE_LEDGER_INTEGRITY } from './validate-status-ledger.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

export const CANONICAL_LEDGER_AUTHORITY_DOCUMENT = 'CANONICAL_LEDGER_AUTHORITY';
export const CANONICAL_LEDGER_RELATIVE_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';

/** Distinct, reportable reasons authority could not be established. */
export const LEDGER_AUTHORITY_ABSENT = 'CANONICAL_LEDGER_ABSENT';
export const LEDGER_AUTHORITY_UNAUTHORIZED = 'CANONICAL_LEDGER_HISTORY_UNAUTHORIZED';
export const LEDGER_AUTHORITY_FAILED = 'CANONICAL_LEDGER_AUTHORITY_UNEVALUABLE';

/**
 * Establish whether the ledger below `root` is a canonically authorized history.
 *
 * @param {object} options
 * @param {string} options.root Repository or candidate-tree root.
 * @param {string} [options.ledgerPath] Absolute ledger path; defaults below root.
 * @param {object} [options.policy] Project policy; defaults to the Wheel policy.
 * @param {string} [options.mode] Validator mode; defaults to LEDGER_INTEGRITY.
 * @returns {{ document: string, authorized: boolean, reason: string|null,
 *   detail: string|null, eventCount: number, ledgerSha256: string|null,
 *   events: Array<object>, blockingFindings: Array<object> }}
 *
 * `authorized === false` means no seal lineage below this root may lend POSITIVE
 * byte authority. `events` is empty in that case: a consumer must never read a
 * history this function refused, and must never fall back to a chain-only check.
 */
export function authenticateCanonicalLedgerHistory({
  root,
  ledgerPath = null,
  policy = WHEEL_EXTERNAL_AUTHORITY_POLICY,
  mode = MODE_LEDGER_INTEGRITY
} = {}) {
  const unauthorized = (reason, detail) => ({
    document: CANONICAL_LEDGER_AUTHORITY_DOCUMENT,
    authorized: false,
    reason,
    detail: detail ?? null,
    eventCount: 0,
    ledgerSha256: null,
    events: [],
    blockingFindings: []
  });

  if (typeof root !== 'string' || root.length === 0) {
    return unauthorized(LEDGER_AUTHORITY_FAILED, 'root');
  }
  const resolvedLedgerPath = ledgerPath
    ?? path.join(root, ...CANONICAL_LEDGER_RELATIVE_PATH.split('/'));
  if (!fs.existsSync(resolvedLedgerPath) || !fs.statSync(resolvedLedgerPath).isFile()) {
    return unauthorized(LEDGER_AUTHORITY_ABSENT, CANONICAL_LEDGER_RELATIVE_PATH);
  }

  let report;
  try {
    report = validateLedger({ root, ledgerPath: resolvedLedgerPath, policy, mode });
  } catch (error) {
    // A validator that cannot run has not said "authorized". Fail closed and name
    // the failure rather than degrading to a weaker check.
    return unauthorized(LEDGER_AUTHORITY_FAILED, error?.message || String(error));
  }

  const blockingFindings = report.findings.filter((entry) => entry.severity === 'BLOCKING');
  if (!report.valid || blockingFindings.length > 0) {
    const detail = [...new Set(blockingFindings.map((entry) => entry.detectorId))].sort().join(',');
    return {
      ...unauthorized(LEDGER_AUTHORITY_UNAUTHORIZED, detail || 'UNKNOWN'),
      blockingFindings
    };
  }

  return {
    document: CANONICAL_LEDGER_AUTHORITY_DOCUMENT,
    authorized: true,
    reason: null,
    detail: null,
    eventCount: report.events.length,
    ledgerSha256: report.ledgerSha256,
    events: report.events,
    blockingFindings: []
  };
}
