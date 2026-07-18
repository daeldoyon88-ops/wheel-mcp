import { dailyBarProblems, isStrictUtcIsoInstant, priceBlockProblems } from '../contracts/dailyBarV1.mjs';
import { isValidCivilDate } from '../time/civilDate.mjs';
import { CanonicalizationError, assertValidUnicode } from './canonicalJsonV1.mjs';

export const CANONICAL_DAILY_BARS_SCHEMA_VERSION = 'CanonicalDailyBars/1';

const ROOT_FIELDS = Object.freeze(['schemaVersion', 'bars']);
const BAR_FIELDS = Object.freeze([
  'sessionDate', 'eventTime', 'availableAt', 'open', 'high', 'low', 'close', 'volume',
  'corporateActions', 'qualityFlags',
]);
const ACTION_FIELDS = Object.freeze(['splitFactor', 'cashDividend']);

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {string} label */
function rejectUnknownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      throw new CanonicalizationError('CANONICAL_UNKNOWN_FIELD', `${label}.${field} is not part of ${CANONICAL_DAILY_BARS_SCHEMA_VERSION}`);
    }
  }
}

/** @param {unknown} value @param {string} label @param {{positive?: boolean, nonNegative?: boolean}} [options] */
function normalizeNullableNumber(value, label, options = {}) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CanonicalizationError('CANONICAL_NON_FINITE_NUMBER', `${label} must be null or a finite number`);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new CanonicalizationError('CANONICAL_UNSAFE_INTEGER', `${label} is an unsafe integer`);
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  if (options.positive && normalized <= 0) throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `${label} must be > 0`);
  if (options.nonNegative && normalized < 0) throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `${label} must be >= 0`);
  return normalized;
}

/** @param {unknown} value @param {string} label */
function normalizeInstant(value, label) {
  if (!isStrictUtcIsoInstant(value)) {
    throw new CanonicalizationError('CANONICAL_INVALID_DATE', `${label} must be a real UTC ISO instant`);
  }
  return new Date(/** @type {string} */ (value)).toISOString();
}

/**
 * Convert a Phase-1 DailyBarV1 array to the minimal engine-input contract.
 * Physical provenance fields are deliberately excluded from this identity.
 * @param {unknown} dailyBars
 * @param {{priceBasis: 'RAW'|'SPLIT_ADJUSTED'|'TOTAL_RETURN_ADJUSTED'|'DERIVED_ADJUSTED'}} options
 */
export function canonicalDailyBarsFromDailyBarV1(dailyBars, options) {
  if (!Array.isArray(dailyBars)) {
    throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', 'DailyBarV1 input must be an array');
  }
  if (!options || !['RAW', 'SPLIT_ADJUSTED', 'TOTAL_RETURN_ADJUSTED', 'DERIVED_ADJUSTED'].includes(options.priceBasis)) {
    throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', 'a supported priceBasis is required');
  }
  const bars = dailyBars.map((bar, index) => {
    const problems = dailyBarProblems(bar);
    if (problems.length > 0) {
      throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `DailyBarV1 bar[${index}] invalid: ${problems.join('; ')}`);
    }
    const block = options.priceBasis === 'RAW' ? bar.raw : bar.adjusted;
    if (options.priceBasis !== 'RAW' && bar.adjusted.adjustmentType !== options.priceBasis) {
      throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `bar[${index}] adjustmentType does not match ${options.priceBasis}`);
    }
    return {
      sessionDate: bar.sessionDate,
      eventTime: bar.eventTime,
      availableAt: bar.availableAt,
      open: block.open,
      high: block.high,
      low: block.low,
      close: block.close,
      volume: block.volume,
      corporateActions: {
        splitFactor: bar.corporateActions.splitFactor,
        cashDividend: bar.corporateActions.cashDividend,
      },
      qualityFlags: bar.qualityFlags,
    };
  });
  return normalizeCanonicalDailyBarsV1({ schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION, bars });
}

/** @param {unknown} value */
export function normalizeCanonicalDailyBarsV1(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `${CANONICAL_DAILY_BARS_SCHEMA_VERSION} must be an object`);
  }
  const root = /** @type {Record<string, unknown>} */ (value);
  rejectUnknownFields(root, ROOT_FIELDS, 'root');
  if (root.schemaVersion !== CANONICAL_DAILY_BARS_SCHEMA_VERSION) {
    throw new CanonicalizationError('CANONICAL_SCHEMA_UNKNOWN', `schemaVersion must be ${CANONICAL_DAILY_BARS_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(root.bars)) {
    throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', 'bars must be an array');
  }
  const normalizedBars = root.bars.map((bar, index) => {
    if (bar === null || typeof bar !== 'object' || Array.isArray(bar)) {
      throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `bars[${index}] must be an object`);
    }
    const input = /** @type {Record<string, unknown>} */ (bar);
    rejectUnknownFields(input, BAR_FIELDS, `bars[${index}]`);
    for (const required of BAR_FIELDS) {
      if (!Object.hasOwn(input, required)) {
        throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `bars[${index}].${required} is required`);
      }
    }
    if (!isValidCivilDate(input.sessionDate)) {
      throw new CanonicalizationError('CANONICAL_INVALID_DATE', `bars[${index}].sessionDate is invalid`);
    }
    const eventTime = normalizeInstant(input.eventTime, `bars[${index}].eventTime`);
    const availableAt = normalizeInstant(input.availableAt, `bars[${index}].availableAt`);
    if (Date.parse(availableAt) < Date.parse(eventTime)) {
      throw new CanonicalizationError('CANONICAL_INVALID_DATE', `bars[${index}].availableAt precedes eventTime`);
    }
    const price = {
      open: normalizeNullableNumber(input.open, `bars[${index}].open`, { positive: true }),
      high: normalizeNullableNumber(input.high, `bars[${index}].high`, { positive: true }),
      low: normalizeNullableNumber(input.low, `bars[${index}].low`, { positive: true }),
      close: normalizeNullableNumber(input.close, `bars[${index}].close`, { positive: true }),
      volume: normalizeNullableNumber(input.volume, `bars[${index}].volume`, { nonNegative: true }),
    };
    const ohlcProblems = priceBlockProblems(price, `bars[${index}]`);
    if (ohlcProblems.length > 0) {
      throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', ohlcProblems.join('; '));
    }
    if (input.corporateActions === null || typeof input.corporateActions !== 'object' || Array.isArray(input.corporateActions)) {
      throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `bars[${index}].corporateActions must be an object`);
    }
    const actions = /** @type {Record<string, unknown>} */ (input.corporateActions);
    rejectUnknownFields(actions, ACTION_FIELDS, `bars[${index}].corporateActions`);
    for (const required of ACTION_FIELDS) {
      if (!Object.hasOwn(actions, required)) {
        throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `bars[${index}].corporateActions.${required} is required`);
      }
    }
    const splitFactor = normalizeNullableNumber(actions.splitFactor, `bars[${index}].corporateActions.splitFactor`, { positive: true });
    const cashDividend = normalizeNullableNumber(actions.cashDividend, `bars[${index}].corporateActions.cashDividend`, { nonNegative: true });
    if (!Array.isArray(input.qualityFlags)) {
      throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `bars[${index}].qualityFlags must be an array`);
    }
    const qualityFlags = [...new Set(input.qualityFlags.map((flag, flagIndex) => {
      if (typeof flag !== 'string' || flag.length === 0) {
        throw new CanonicalizationError('SNAPSHOT_CONTRACT_INVALID', `bars[${index}].qualityFlags[${flagIndex}] must be a non-empty string`);
      }
      assertValidUnicode(flag);
      return flag;
    }))].sort();
    return {
      sessionDate: /** @type {string} */ (input.sessionDate), eventTime, availableAt,
      ...price,
      corporateActions: { splitFactor, cashDividend },
      qualityFlags,
    };
  });
  normalizedBars.sort((a, b) => a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0);
  for (let index = 1; index < normalizedBars.length; index++) {
    if (normalizedBars[index - 1].sessionDate === normalizedBars[index].sessionDate) {
      throw new CanonicalizationError('CANONICAL_DUPLICATE_SESSION_DATE', `duplicate sessionDate ${normalizedBars[index].sessionDate}`);
    }
  }
  return { schemaVersion: CANONICAL_DAILY_BARS_SCHEMA_VERSION, bars: normalizedBars };
}
