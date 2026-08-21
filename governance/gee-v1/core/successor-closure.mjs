/**
 * SUCCESSOR CLOSURE — the single statement of when a predecessor Gate's closure
 * is enough to admit its successor.
 *
 * THE DEFECT THIS EXISTS FOR. This rule used to be written FOUR times:
 *
 *   - gee-v1/adapters/wheel/gate-dependency-resolution.mjs
 *   - gee-v1/core/gate-authorization-authority.mjs
 *   - gee-v1/core/gate-start-authority.mjs
 *   - gee-v1/core/precontract-authority.mjs
 *
 * All four listed COMPLETE_AGENT as terminal. Four independent checks that agree
 * are not four proofs; they are one assumption copied four times, and every
 * consumer downstream inherited it. The concrete consequence was that a Gate
 * sitting at COMPLETE_AGENT — agent-closed, with NO external confirmation —
 * satisfied its successor's dependency, so the successor became Fast Gate READY
 * while the only independent check of the predecessor's work had not happened.
 *
 * WHY COMPLETE_AGENT IS NOT CLOSURE. COMPLETE_AGENT is the agent's own report
 * that it finished. EXTERNAL_CONFIRMATION is the separate, independent
 * reinspection that decides whether that report is true, and COMPLETE_CONFIRMED
 * is the status that records the answer. Admitting a successor at COMPLETE_AGENT
 * lets the executing agent certify its own work and immediately spend that
 * certification as the entry condition for the next Gate — which is precisely
 * the check the lifecycle exists to impose.
 *
 * The canonical sources already said so. The registry's entry condition for
 * GATE21 reads "GATE20 is COMPLETE_CONFIRMED", and validate-active-gate.mjs
 * already required COMPLETE_CONFIRMED or SUPERSEDED. Only the dependency
 * resolution path disagreed, so the repository held two answers to one question.
 *
 * SUPERSESSION. SUPERSEDED is terminal because a superseded Gate has no work to
 * confirm: the Project Owner has canonically declared it NON_EXECUTABLE, and
 * that declaration is itself the independent decision. The disposition is
 * resolved from an owner-ratified source and is usable only while the Gate is
 * still genesis-only — one real transition and it stops applying. See
 * gate-dependency-resolution.mjs.
 *
 * NOT THE SAME QUESTION as "has this Gate reached a closed status", which is
 * what CLOSED_LEDGER_STATUSES answers for things like choosing a sealed
 * reference work unit. A COMPLETE_AGENT Gate genuinely is closed; it just is not
 * closed ENOUGH to admit a successor. Those two predicates are deliberately kept
 * apart so that tightening one never silently tightens the other.
 *
 * Pure: no filesystem, no clock.
 */

/**
 * The only statuses that satisfy a successor's dependency on a predecessor.
 *
 * Adding a status here widens what may follow what, across every consumer at
 * once. It is the whole sequencing rule.
 */
export const SUCCESSOR_CLOSURE_STATUSES = Object.freeze(['COMPLETE_CONFIRMED', 'SUPERSEDED']);

/** Statuses that are terminal for a Gate but do NOT admit a successor. */
export const NON_SUCCESSOR_CLOSING_TERMINAL_STATUSES = Object.freeze(['COMPLETE_AGENT']);

/**
 * Whether `status` closes a predecessor for the purpose of admitting a successor.
 *
 * Fail-closed: anything that is not exactly one of the canonical terminal
 * statuses — including null, undefined, a non-string, or a status scalar that
 * merely looks plausible — is not closure.
 */
export function satisfiesSuccessorClosure(status) {
  return typeof status === 'string' && SUCCESSOR_CLOSURE_STATUSES.includes(status);
}
