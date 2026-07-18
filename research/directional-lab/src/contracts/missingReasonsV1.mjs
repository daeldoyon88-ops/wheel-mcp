/**
 * Canonical missingReason vocabulary for FeatureSnapshotV1 / diagnostics.
 * One string per cause — never invent ad-hoc synonyms for the same failure.
 */

export const MISSING_REASON_SCHEMA_VERSION = 'MissingReasonsV1';

export const MISSING_REASONS = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  BENCHMARK_UNAVAILABLE: 'BENCHMARK_UNAVAILABLE',
  BENCHMARK_DATE_MISSING: 'BENCHMARK_DATE_MISSING',
  VOLUME_MISSING: 'VOLUME_MISSING',
  INPUT_MISSING: 'INPUT_MISSING',
  NO_VALID_OBSERVATIONS: 'NO_VALID_OBSERVATIONS',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT_HISTORY',
  /** Specialized: weekly feature has no prior completed ISO week. */
  NO_COMPLETED_WEEK: 'NO_COMPLETED_WEEK',
});

/** Highest precedence first. */
export const MISSING_REASON_PRECEDENCE = Object.freeze([
  MISSING_REASONS.INVALID_INPUT,
  MISSING_REASONS.BENCHMARK_UNAVAILABLE,
  MISSING_REASONS.BENCHMARK_DATE_MISSING,
  MISSING_REASONS.VOLUME_MISSING,
  MISSING_REASONS.INPUT_MISSING,
  MISSING_REASONS.NO_VALID_OBSERVATIONS,
  MISSING_REASONS.INSUFFICIENT_HISTORY,
  MISSING_REASONS.NO_COMPLETED_WEEK,
]);

const REASON_SET = new Set(Object.values(MISSING_REASONS));

/**
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isCanonicalMissingReason(reason) {
  return typeof reason === 'string' && REASON_SET.has(reason);
}

/**
 * Pick the highest-precedence reason from a candidate list.
 * @param {(string|null|undefined)[]} candidates
 * @returns {string|null}
 */
export function pickMissingReason(candidates) {
  let best = null;
  let bestRank = Infinity;
  for (const c of candidates) {
    if (c == null) continue;
    if (!isCanonicalMissingReason(c)) {
      throw new Error(`Unknown missingReason: ${JSON.stringify(c)}`);
    }
    const rank = MISSING_REASON_PRECEDENCE.indexOf(c);
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank;
      best = c;
    }
  }
  return best;
}

/**
 * Diagnose why a trailing window at `index` cannot produce a value.
 * When the window is structurally complete and every observation is valid,
 * returns null (caller should already have a finite value).
 *
 * @param {(number|null|undefined)[]} values
 * @param {number} window
 * @param {number} index
 * @param {{nullReason?: string}} [options] reason when a required observation is null
 *   (VOLUME_MISSING for volume series, INPUT_MISSING otherwise)
 * @returns {string|null}
 */
export function reasonForTrailingWindow(values, window, index, options = {}) {
  const nullReason = options.nullReason ?? MISSING_REASONS.INPUT_MISSING;
  if (!isCanonicalMissingReason(nullReason)) {
    throw new Error(`nullReason must be canonical, got ${JSON.stringify(nullReason)}`);
  }
  if (!Array.isArray(values) || !Number.isInteger(window) || window < 1) {
    return MISSING_REASONS.INVALID_INPUT;
  }
  if (!Number.isInteger(index) || index < 0 || index >= values.length) {
    return MISSING_REASONS.INVALID_INPUT;
  }
  if (index < window - 1) return MISSING_REASONS.INSUFFICIENT_HISTORY;

  const slice = values.slice(index - window + 1, index + 1);
  let nullCount = 0;
  let validCount = 0;
  let invalid = false;
  for (const v of slice) {
    if (v === null || v === undefined) {
      nullCount++;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      invalid = true;
      continue;
    }
    validCount++;
  }
  if (invalid) return MISSING_REASONS.INVALID_INPUT;
  if (validCount === 0) return MISSING_REASONS.NO_VALID_OBSERVATIONS;
  if (nullCount > 0) return nullReason;
  return null;
}
