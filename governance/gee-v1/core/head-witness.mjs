/**
 * GEE V1 core — head witness.
 * RC-1 support: the ledger's own append-only chain proves ordering, not
 * authenticity. This module grades the ledger head against witnesses that
 * are, by construction, outside the governed (rewritable) set.
 *
 * Witnesses are plural and none is mandatory, so a dirty uncommitted repo is
 * never blocked. Absence of a witness never upgrades trust; a stale or
 * mismatching witness never counts as a match.
 *
 * Honest limit (published, not engineered around): at ANCHORED_APPEND_ONLY a
 * coordinated whole-log rewrite is not detected. That trust level may never
 * authorize closure — only ANCHORED_EXTERNAL may.
 */

import { TRUST_LEVELS } from './authoritative-state.mjs';

export { TRUST_LEVELS };

const WITNESS_KINDS = Object.freeze(['GIT_OBJECT', 'INDEPENDENT_AUDIT_RUN_ROOT', 'PROJECT_OWNER_DOCUMENT']);

/**
 * A witness is pre-verified by the caller (it must state whether the bytes it
 * cites were actually read and hashed) — this module never performs I/O, so it
 * stays pure and project-agnostic. It only applies the comparison rule.
 *
 * @param {{ kind: string, verified: boolean, pinnedLedgerSha256: string|null, ref: string }} witness
 */
function isWitnessMatch(witness, ledgerSha256) {
  if (!witness || typeof witness !== 'object') return false;
  if (!WITNESS_KINDS.includes(witness.kind)) return false;
  if (witness.verified !== true) return false; // absence / unread bytes never counts as PASS
  if (typeof witness.pinnedLedgerSha256 !== 'string' || !witness.pinnedLedgerSha256) return false;
  return witness.pinnedLedgerSha256 === ledgerSha256; // mismatch never counts as PASS
}

/**
 * @param {{
 *   ledgerSha256: string,
 *   chainValid: boolean,
 *   hasNonGenesisTransition: boolean,
 *   witnesses?: Array<object>
 * }} input
 * @returns {{ trustLevel: string, matchedWitness: object|null, reason: string }}
 */
export function verifyHeadWitness({ ledgerSha256, chainValid, hasNonGenesisTransition = false, witnesses = [] }) {
  if (chainValid !== true) {
    return { trustLevel: 'BROKEN', matchedWitness: null, reason: 'LEDGER_CHAIN_OR_TRANSITION_TABLE_INVALID' };
  }
  const matched = (Array.isArray(witnesses) ? witnesses : []).find((witness) => isWitnessMatch(witness, ledgerSha256)) || null;
  if (matched) {
    return { trustLevel: 'ANCHORED_EXTERNAL', matchedWitness: matched, reason: 'HEAD_MATCHED_BY_OUT_OF_REPO_WITNESS' };
  }
  if (hasNonGenesisTransition) {
    return { trustLevel: 'ANCHORED_APPEND_ONLY', matchedWitness: null, reason: 'CHAIN_AND_MONOTONIC_HEAD_VERIFIED_NO_WITNESS' };
  }
  return { trustLevel: 'UNANCHORED_LEGACY', matchedWitness: null, reason: 'FROZEN_AT_GENESIS_NO_REAL_TRANSITION_RECORDED' };
}

export function isKnownWitnessKind(kind) {
  return WITNESS_KINDS.includes(kind);
}
