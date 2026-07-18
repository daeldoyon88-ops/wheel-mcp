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

/** @param {unknown} v @returns {boolean} */
function isUtcIso(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v);
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
  if (typeof b.symbol !== 'string' || b.symbol.length === 0) problems.push('symbol must be a non-empty string');
  if (!isValidCivilDate(b.sessionDate)) problems.push(`sessionDate invalid: ${JSON.stringify(b.sessionDate)}`);
  if (!isUtcIso(b.eventTime)) problems.push('eventTime must be a UTC ISO instant');
  if (!isUtcIso(b.availableAt)) problems.push('availableAt must be a UTC ISO instant');
  if (typeof b.timezone !== 'string' || b.timezone.length === 0) problems.push('timezone required');
  if (typeof b.source !== 'string' || b.source.length === 0) problems.push('source required');
  if (typeof b.currency !== 'string' || b.currency.length === 0) problems.push('currency required');
  if (isUtcIso(b.eventTime) && isUtcIso(b.availableAt) && b.availableAt < b.eventTime) {
    problems.push('availableAt cannot precede eventTime');
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
    if (!isNullOrFiniteNumber(adj.adjustmentFactor)) problems.push('adjusted.adjustmentFactor must be null or finite');
  }

  const ca = b.corporateActions;
  if (ca === null || typeof ca !== 'object') {
    problems.push('corporateActions block missing');
  } else {
    if (!isNullOrFiniteNumber(ca.splitFactor)) problems.push('corporateActions.splitFactor must be null or finite');
    if (!isNullOrFiniteNumber(ca.cashDividend)) problems.push('corporateActions.cashDividend must be null or finite');
  }

  if (!Array.isArray(b.qualityFlags)) problems.push('qualityFlags must be an array');
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
    if (typeof v === 'number' && v < 0) problems.push(`${label}.${name} negative price forbidden`);
  }
  if (typeof volume === 'number' && volume < 0) problems.push(`${label}.volume negative volume forbidden`);
  if (typeof high === 'number') {
    for (const [name, v] of [['open', open], ['close', close], ['low', low]]) {
      if (typeof v === 'number' && high < v) problems.push(`${label}.high < ${label}.${name} (impossible OHLC)`);
    }
  }
  if (typeof low === 'number') {
    for (const [name, v] of [['open', open], ['close', close], ['high', high]]) {
      if (typeof v === 'number' && low > v) problems.push(`${label}.low > ${label}.${name} (impossible OHLC)`);
    }
  }
  return problems;
}
