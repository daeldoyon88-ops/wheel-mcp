/**
 * GEE V1 core — canonical defect state model.
 * RC-5 support: closed enum, explicitly partitioned ACTIVE/TERMINAL.
 * Counting is structurally gated behind document validation: countActiveDefects
 * cannot be called without a document that already validated VALID. Any status
 * outside the enum makes the whole document UNKNOWN, never KNOWN_ZERO.
 */

export const ACTIVE_DEFECT_STATUSES = Object.freeze(['OPEN', 'IN_REPAIR', 'BLOCKED', 'REOPENED']);
export const TERMINAL_DEFECT_STATUSES = Object.freeze(['CLOSED', 'WITHDRAWN', 'SUPERSEDED']);
export const CANONICAL_DEFECT_STATUSES = Object.freeze([...ACTIVE_DEFECT_STATUSES, ...TERMINAL_DEFECT_STATUSES]);

/**
 * @param {unknown} raw — already adapter-translated (canonical vocabulary only)
 */
export function validateDefectDocument(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'NOT_OBJECT', defects: null };
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'defects') || !Array.isArray(raw.defects)) {
    return { valid: false, reason: 'MISSING_DEFECTS_ARRAY', defects: null };
  }
  for (const [index, defect] of raw.defects.entries()) {
    if (!defect || typeof defect !== 'object' || Array.isArray(defect)) {
      return { valid: false, reason: `DEFECT_ENTRY_INVALID:${index}`, defects: null };
    }
    if (typeof defect.status !== 'string' || !defect.status) {
      return { valid: false, reason: `DEFECT_STATUS_INVALID:${index}`, defects: null };
    }
    if (!CANONICAL_DEFECT_STATUSES.includes(defect.status)) {
      return { valid: false, reason: `UNKNOWN_DEFECT_STATUS:${defect.status}`, defects: null };
    }
  }
  return { valid: true, reason: null, defects: raw.defects };
}

/**
 * Unreachable without a VALID document — not "should not be called", but
 * structurally gated: this throws rather than silently returning a count.
 */
export function countActiveDefects(validated) {
  if (!validated || validated.valid !== true || !Array.isArray(validated.defects)) {
    throw new Error('COUNT_REQUIRES_VALID_DEFECT_DOCUMENT');
  }
  const count = validated.defects.filter((defect) => ACTIVE_DEFECT_STATUSES.includes(defect.status)).length;
  return { count, knowledge: count === 0 ? 'KNOWN_ZERO' : 'KNOWN_NONZERO' };
}

/**
 * @param {unknown} raw — already adapter-translated (canonical vocabulary only)
 */
export function resolveDefectKnowledge(raw) {
  const validated = validateDefectDocument(raw);
  if (!validated.valid) {
    return { defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', reason: validated.reason };
  }
  const { count, knowledge } = countActiveDefects(validated);
  return { defectsOpenCount: count, defectsOpenKnowledge: knowledge, reason: null };
}
