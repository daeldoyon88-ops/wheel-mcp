/**
 * Fail-closed OPEN_DEFECTS knowledge resolution.
 *
 * RC-5 repair: counting is now structurally gated behind the canonical closed
 * defect-status enum in ../core/defect-status.mjs (ACTIVE: OPEN, IN_REPAIR,
 * BLOCKED, REOPENED / TERMINAL: CLOSED, WITHDRAWN, SUPERSEDED). Any status
 * outside that enum — including case variants, RESOLVED, or an unmapped
 * legacy value — makes the whole document UNKNOWN, never KNOWN_ZERO.
 *
 * The Wheel-specific legacy vocabulary (and the decision about which legacy
 * strings are safe to treat as which canonical status) lives in
 * ../adapters/wheel/legacy-defect-vocabulary.mjs, not here. This module
 * translates via that TOTAL map before ever touching the canonical enum, so
 * an unmapped value is UNKNOWN rather than silently assumed terminal.
 */

import { resolveDefectKnowledge } from '../core/defect-status.mjs';
import { translateWheelLegacyDefectsDocument } from '../adapters/wheel/legacy-defect-vocabulary.mjs';

/**
 * @param {unknown} raw
 * @returns {{
 *   defectsOpenCount: number|null,
 *   defectsOpenKnowledge: 'KNOWN_ZERO'|'KNOWN_NONZERO'|'UNKNOWN',
 *   valid: boolean,
 *   reason: string|null
 * }}
 */
export function resolveOpenDefectsKnowledge(raw) {
  if (raw === null || raw === undefined) {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', valid: false, reason: 'ABSENT' };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', valid: false, reason: 'NOT_OBJECT' };
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'defects')) {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', valid: false, reason: 'MISSING_DEFECTS_ARRAY' };
  }
  if (!Array.isArray(raw.defects)) {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', valid: false, reason: 'DEFECTS_NOT_ARRAY' };
  }

  const translated = translateWheelLegacyDefectsDocument(raw);
  if (!translated) {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', valid: false, reason: 'UNMAPPED_OR_INVALID_DEFECT_STATUS' };
  }

  const resolved = resolveDefectKnowledge(translated);
  return {
    defectsOpenCount: resolved.defectsOpenCount,
    defectsOpenKnowledge: resolved.defectsOpenKnowledge,
    valid: resolved.reason === null,
    reason: resolved.reason
  };
}

/**
 * Parse JSON text fail-closed.
 * @param {string} text
 */
export function resolveOpenDefectsKnowledgeFromJsonText(text) {
  if (typeof text !== 'string') {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', valid: false, reason: 'NOT_TEXT' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', valid: false, reason: 'INVALID_JSON' };
  }
  return resolveOpenDefectsKnowledge(parsed);
}
