/**
 * CLOSED REVISION STATUS — the shared vocabulary for "this state revision is
 * closed", and nothing else.
 *
 * WHY THIS FILE EXISTS. It holds three strings that two layers must agree on:
 *
 *   post-freeze-maintenance-authority   refuses to publish over a member sealed
 *                                       by a CLOSED revision;
 *   sealed-state-evidence               decides which seals are closed at all.
 *
 * The constant used to live in sealed-state-evidence, and the maintenance
 * authority imported it from there. That single edge is what made the canonical
 * ledger validator unreachable from the seal inventory: the validator imports the
 * maintenance authority, so
 *
 *     validate-status-ledger -> post-freeze-maintenance-authority
 *                            -> sealed-state-evidence
 *
 * meant sealed-state-evidence could never import the validator back without a
 * cycle. Authenticating a seal lineage against CANONICALLY AUTHORIZED ledger
 * history requires exactly that import, so the vocabulary is extracted DOWNWARD
 * to where both sides can depend on it — the same move already made for the
 * transition tables (canonical-terminal-proof.mjs) and the chain algorithm
 * (verified-ledger-evidence.mjs):
 *
 *                 closed-revision-status.mjs
 *                   ^                     ^
 *                   |                     |
 *     post-freeze-maintenance-authority   sealed-state-evidence
 *                                             |
 *                                             v
 *                                   validate-status-ledger  (no longer a cycle)
 *
 * NOTHING IS REDEFINED HERE. The three statuses are byte-identical to the set
 * sealed-state-evidence has always exported, and sealed-state-evidence still
 * re-exports `CLOSED_REVISION_STATUSES` so every existing importer and every
 * recorded description of its public surface stays true. This file adds a
 * location, not a second opinion.
 *
 * Pure data: no imports, no filesystem, no clock.
 */

/**
 * The execution statuses that mean a state revision is CLOSED.
 *
 * 'CLOSED' is retained alongside the two governed lifecycle statuses because
 * legacy seals declare it, and dropping it would silently reopen bytes those
 * seals froze.
 */
export const CLOSED_REVISION_STATUSES = Object.freeze([
  'COMPLETE_AGENT',
  'COMPLETE_CONFIRMED',
  'CLOSED'
]);

/** Membership form of the same set, so consumers need not rebuild it. */
export const CLOSED_REVISION_STATUS_SET = new Set(CLOSED_REVISION_STATUSES);
