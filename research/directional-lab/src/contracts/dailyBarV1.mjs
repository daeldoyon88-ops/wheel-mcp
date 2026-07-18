/**
 * DailyBarV1 — the single daily-bar data contract of the lab.
 *
 * Invariants (see DATA_CONTRACT.md):
 *  - sessionDate is a civil YYYY-MM-DD market date, never a local Date;
 *  - eventTime is the real end of the session (UTC ISO);
 *  - availableAt is the earliest instant the bar could really be used;
 *  - raw and adjusted price blocks are kept strictly separate;
 *  - null stays null (never coerced to 0);
 *  - no future data, no silent forward-fill.
 */

import { isValidCivilDate } from '../time/civilDate.mjs';

export const DAILY_BAR_SCHEMA_VERSION = 'DailyBarV1';

/** Allowed adjustment types for the adjusted block. */
export const ADJUSTMENT_TYPES = Object.freeze([
  'RAW',
  'SPLIT_ADJUSTED',
  'TOTAL_RETURN_ADJUSTED',
  'DERIVED_ADJUSTED',
]);

/**
 * @typedef {Object} PriceBlock
 * @property {number|null} open
 * @property {number|null} high
 * @property {number|null} low
 * @property {number|null} close
 * @property {number|null} volume
 */

/**
 * @typedef {PriceBlock & {adjustmentType: string|null, adjustmentFactor: number|null}} AdjustedBlock
 */

/**
 * @typedef {Object} DailyBarV1
 * @property {'DailyBarV1'} schemaVersion
 * @property {string} symbol
 * @property {string} sessionDate civil YYYY-MM-DD
 * @property {string} eventTime UTC ISO instant of real session end
 * @property {string} availableAt UTC ISO instant the bar became usable
 * @property {string} timezone exchange timezone name (e.g. America/New_York)
 * @property {string} source provenance label (file path or feed id)
 * @property {string} currency
 * @property {PriceBlock} raw
 * @property {AdjustedBlock} adjusted
 * @property {{splitFactor: number|null, cashDividend: number|null}} corporateActions
 * @property {string[]} qualityFlags
 * @property {Object} lineage
 */

/** @param {unknown} v @returns {boolean} */
function isNullOrFiniteNumber(v) {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * Strict UTC ISO instant: regex shape + Date round-trip (rejects 2024-02-30…).
 * @param {unknown} v
 * @returns {boolean}
 */
export function isStrictUtcIsoInstant(v) {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)) return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  const roundTrip = new Date(ms).toISOString();
  if (v.endsWith('Z') && !v.includes('.')) {
    return roundTrip === `${v.slice(0, -1)}.000Z` || roundTrip === v;
  }
  return roundTrip === v;
}

/**
 * Structural validation of one DailyBarV1. Returns a list of problems
 * (empty when valid). Never mutates, never coerces.
 * @param {unknown} bar
 * @returns {string[]}
 */
export function dailyBarProblems(bar) {
  const problems = [];
  if (bar === null || typeof bar !== 'object') return ['bar is not an object'];
  const b = /** @type {any} */ (bar);
  if (b.schemaVersion !== DAILY_BAR_SCHEMA_VERSION) problems.push(`schemaVersion must be ${DAILY_BAR_SCHEMA_VERSION}`);
  if (typeof b.symbol !== 'string' || b.symbol.trim().length === 0) {
    problems.push('symbol must be a non-empty string (whitespace-only forbidden)');
  } else if (b.symbol !== b.symbol.trim()) {
    problems.push('symbol must be trimmed (leading/trailing whitespace forbidden)');
  }
  if (!isValidCivilDate(b.sessionDate)) problems.push(`sessionDate invalid: ${JSON.stringify(b.sessionDate)}`);
  if (!isStrictUtcIsoInstant(b.eventTime)) problems.push('eventTime must be a real UTC ISO instant');
  if (!isStrictUtcIsoInstant(b.availableAt)) problems.push('availableAt must be a real UTC ISO instant');
  if (typeof b.timezone !== 'string' || b.timezone.length === 0) problems.push('timezone required');
  if (typeof b.source !== 'string' || b.source.length === 0) problems.push('source required');
  if (typeof b.currency !== 'string' || b.currency.length === 0) problems.push('currency required');
  if (isStrictUtcIsoInstant(b.eventTime) && isStrictUtcIsoInstant(b.availableAt)) {
    if (Date.parse(b.availableAt) < Date.parse(b.eventTime)) {
      problems.push('availableAt cannot precede eventTime');
    }
  }

  for (const blockName of ['raw', 'adjusted']) {
    const block = b[blockName];
    if (block === null || typeof block !== 'object') {
      problems.push(`${blockName} block missing`);
      continue;
    }
    for (const field of ['open', 'high', 'low', 'close', 'volume']) {
      if (!isNullOrFiniteNumber(block[field])) problems.push(`${blockName}.${field} must be null or a finite number`);
    }
    problems.push(...priceBlockProblems(block, blockName));
  }

  const adj = b.adjusted;
  if (adj && typeof adj === 'object') {
    if (adj.adjustmentType !== null && !ADJUSTMENT_TYPES.includes(adj.adjustmentType)) {
      problems.push(`adjusted.adjustmentType invalid: ${JSON.stringify(adj.adjustmentType)}`);
    }
    if (adj.adjustmentFactor !== null) {
      if (typeof adj.adjustmentFactor !== 'number' || !Number.isFinite(adj.adjustmentFactor) || adj.adjustmentFactor <= 0) {
        problems.push('adjusted.adjustmentFactor must be null or a finite number > 0');
      }
    }
  }

  const ca = b.corporateActions;
  if (ca === null || typeof ca !== 'object') {
    problems.push('corporateActions block missing');
  } else {
    if (ca.splitFactor !== null) {
      if (typeof ca.splitFactor !== 'number' || !Number.isFinite(ca.splitFactor) || ca.splitFactor <= 0) {
        problems.push('corporateActions.splitFactor must be null or a finite number > 0');
      }
    }
    if (ca.cashDividend !== null) {
      if (typeof ca.cashDividend !== 'number' || !Number.isFinite(ca.cashDividend) || ca.cashDividend < 0) {
        problems.push('corporateActions.cashDividend must be null or a finite number >= 0');
      }
    }
  }

  if (!Array.isArray(b.qualityFlags)) {
    problems.push('qualityFlags must be an array');
  } else {
    const seen = new Set();
    for (let i = 0; i < b.qualityFlags.length; i++) {
      const flag = b.qualityFlags[i];
      if (typeof flag !== 'string' || flag.length === 0) {
        problems.push(`qualityFlags[${i}] must be a non-empty string`);
        continue;
      }
      if (seen.has(flag)) problems.push(`qualityFlags contains duplicate: ${flag}`);
      seen.add(flag);
    }
  }
  if (b.lineage === null || typeof b.lineage !== 'object') problems.push('lineage must be an object');
  return problems;
}

/**
 * OHLC sanity for one price block. Null fields skip the checks they belong to
 * (missing stays missing; it is reported elsewhere, never invented).
 * @param {PriceBlock} block
 * @param {string} label
 * @returns {string[]}
 */
export function priceBlockProblems(block, label) {
  const problems = [];
  const { open, high, low, close, volume } = block;
  for (const [name, v] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) problems.push(`${label}.${name} must be finite`);
      else if (v <= 0) problems.push(`${label}.${name} must be strictly > 0 when present`);
    }
  }
  if (typeof volume === 'number') {
    if (!Number.isFinite(volume)) problems.push(`${label}.volume must be finite`);
    else if (volume < 0) problems.push(`${label}.volume negative volume forbidden`);
  }
  if (typeof high === 'number' && Number.isFinite(high) && high > 0) {
    for (const [name, v] of [['open', open], ['close', close], ['low', low]]) {
      if (typeof v === 'number' && Number.isFinite(v) && high < v) {
        problems.push(`${label}.high < ${label}.${name} (impossible OHLC)`);
      }
    }
  }
  if (typeof low === 'number' && Number.isFinite(low) && low > 0) {
    for (const [name, v] of [['open', open], ['close', close], ['high', high]]) {
      if (typeof v === 'number' && Number.isFinite(v) && low > v) {
        problems.push(`${label}.low > ${label}.${name} (impossible OHLC)`);
      }
    }
  }
  return problems;
}
