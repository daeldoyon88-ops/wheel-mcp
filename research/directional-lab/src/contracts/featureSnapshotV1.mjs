/**
 * FeatureSnapshotV1 — all features known for one symbol at one decision instant.
 * Every feature carries value/asOf/availableAt/source/missingReason/qualityFlags.
 * A missing input NEVER becomes an invented neutral value: value stays null and
 * missingReason says why.
 */

import { isCanonicalMissingReason } from './missingReasonsV1.mjs';

export const FEATURE_SNAPSHOT_SCHEMA_VERSION = 'FeatureSnapshotV1';

/**
 * @typedef {Object} FeatureValue
 * @property {number|boolean|string|null} value
 * @property {string} asOf UTC ISO instant of the last data used
 * @property {string} availableAt UTC ISO instant this feature became usable
 * @property {string} source
 * @property {string|null} missingReason non-null exactly when value is null
 * @property {string[]} qualityFlags
 */

/**
 * @typedef {Object} FeatureSnapshotV1
 * @property {'FeatureSnapshotV1'} schemaVersion
 * @property {string} symbol
 * @property {string} sessionDate
 * @property {string} asOf
 * @property {string} availableAt
 * @property {string} priceBasis
 * @property {Record<string, FeatureValue>} features
 */

/**
 * Build one FeatureValue. Enforces the null/missingReason pairing.
 * @param {number|boolean|string|null} value
 * @param {{asOf: string, availableAt: string, source: string, missingReason?: string|null, qualityFlags?: string[]}} meta
 * @returns {FeatureValue}
 */
export function featureValue(value, meta) {
  const isMissing = value === null;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`featureValue: non-finite number forbidden (got ${value})`);
  }
  if (isMissing && !meta.missingReason) {
    throw new Error('featureValue: null value requires a missingReason');
  }
  if (!isMissing && meta.missingReason) {
    throw new Error('featureValue: non-null value must not carry a missingReason');
  }
  if (isMissing && !isCanonicalMissingReason(meta.missingReason)) {
    throw new Error(`featureValue: unknown missingReason ${JSON.stringify(meta.missingReason)}`);
  }
  return {
    value,
    asOf: meta.asOf,
    availableAt: meta.availableAt,
    source: meta.source,
    missingReason: isMissing ? meta.missingReason : null,
    qualityFlags: meta.qualityFlags ?? [],
  };
}

/**
 * @param {unknown} snapshot
 * @returns {string[]} problems, empty when valid
 */
export function featureSnapshotProblems(snapshot) {
  const problems = [];
  if (snapshot === null || typeof snapshot !== 'object') return ['snapshot is not an object'];
  const s = /** @type {any} */ (snapshot);
  if (s.schemaVersion !== FEATURE_SNAPSHOT_SCHEMA_VERSION) problems.push(`schemaVersion must be ${FEATURE_SNAPSHOT_SCHEMA_VERSION}`);
  if (typeof s.symbol !== 'string' || !s.symbol) problems.push('symbol required');
  if (typeof s.sessionDate !== 'string') problems.push('sessionDate required');
  if (s.features === null || typeof s.features !== 'object') {
    problems.push('features map required');
    return problems;
  }
  for (const [name, fv] of Object.entries(s.features)) {
    if (fv === null || typeof fv !== 'object') { problems.push(`feature ${name} is not an object`); continue; }
    if (fv.value === null && !fv.missingReason) problems.push(`feature ${name}: null without missingReason`);
    if (fv.value === null && fv.missingReason && !isCanonicalMissingReason(fv.missingReason)) {
      problems.push(`feature ${name}: unknown missingReason ${JSON.stringify(fv.missingReason)}`);
    }
    if (fv.value !== null && fv.missingReason) problems.push(`feature ${name}: value with missingReason`);
    if (typeof fv.value === 'number' && !Number.isFinite(fv.value)) problems.push(`feature ${name}: non-finite value`);
    if (typeof fv.availableAt !== 'string') problems.push(`feature ${name}: availableAt required`);
  }
  return problems;
}
