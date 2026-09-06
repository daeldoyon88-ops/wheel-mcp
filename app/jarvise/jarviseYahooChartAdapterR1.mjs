/**
 * Yahoo chart result to CanonicalDailyBars/1 for the P3 historical plane.
 *
 * Two distinct jobs live here, and they are deliberately separate:
 *
 *  1. SERIALIZATION (OD-P3-3). yahoo-finance2 returns a parsed structured
 *     result containing Date instances, not HTTP wire bytes. The pinned source
 *     representation is therefore CANONICAL_PROVIDER_RESULT_BYTES: the
 *     CanonicalJSON/1 encoding of the JSON-domain projection of that result.
 *     No field is added, renamed or dropped except `undefined` members, which
 *     have no JSON-domain representation at all.
 *
 *  2. NORMALIZATION. The pinned bytes are replayed into strict DailyBarV1 via
 *     the already-published normalizeDailyBars, then every timestamp is rebound
 *     to the pinned canonical session close, then reduced to CanonicalDailyBars/1.
 *     The rebind is load-bearing rather than cosmetic: normalizeDailyBars derives
 *     eventTime from marketSession.mjs::sessionCloseUtc, which is a DST-derived
 *     wall-clock close and is wrong for every half-day session.
 *
 * This module performs no acquisition and constructs no HTTP client.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJsonBytes,
  parseCanonicalJsonBytes,
} from '../../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import {
  CANONICAL_DAILY_BARS_SCHEMA_VERSION,
  canonicalDailyBarsFromDailyBarV1,
} from '../../research/directional-lab/src/canonical/canonicalDailyBarsV1.mjs';
import { normalizeDailyBars } from '../../research/directional-lab/src/data/normalizeDailyBars.mjs';
import { applyPinnedSessionTimestampsR1 } from './pinnedSessionTimestampsR1.mjs';

export const JARVISE_YAHOO_CHART_ADAPTER_VERSION = 'jarviseYahooChartAdapterR1/1';
export const SOURCE_FORMAT = 'YAHOO_CHART_EOD_CANONICAL_PROVIDER_RESULT/1';
export const SOURCE_REPRESENTATION = 'CANONICAL_PROVIDER_RESULT_BYTES';
export const OHLC_BASIS = 'SPLIT_ADJUSTED';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_YEARS = Object.freeze([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);

export class JarviseYahooChartAdapterError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseYahooChartAdapterError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {object} [details] */
function fail(code, message, details = {}) {
  throw new JarviseYahooChartAdapterError(code, message, details);
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Project a parsed provider result into the JSON data model. Dates become
 * strict UTC ISO instants; `undefined` members are dropped because JSON has no
 * representation for them. Everything else is preserved exactly.
 * @param {unknown} value @param {string} label
 */
export function toJsonDomainValueR1(value, label = 'providerChartResult') {
  if (value === null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) fail('PROVIDER_RESULT_INVALID', `${label} contains an invalid Date`);
    return value.toISOString();
  }
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) fail('PROVIDER_RESULT_INVALID', `${label} contains a non-finite number`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('PROVIDER_RESULT_INVALID', `${label} contains an unsafe integer`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJsonDomainValueR1(item, `${label}[${index}]`));
  }
  if (!isPlainObject(value)) {
    fail('PROVIDER_RESULT_INVALID', `${label} has an unsupported type: ${type}`);
  }
  /** @type {Record<string, unknown>} */
  const projected = {};
  for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
    const member = /** @type {Record<string, unknown>} */ (value)[key];
    if (member === undefined) continue;
    projected[key] = toJsonDomainValueR1(member, `${label}.${key}`);
  }
  return projected;
}

/**
 * OD-P3-3. The pinned source bytes for one acquisition.
 * sourceObjectId = sha256(canonicalProviderResultBytesR1(providerChartResult)).
 * @param {unknown} providerChartResult
 * @returns {Buffer}
 */
export function canonicalProviderResultBytesR1(providerChartResult) {
  if (!isPlainObject(providerChartResult)) {
    fail('PROVIDER_RESULT_INVALID', 'provider chart result must be a plain object');
  }
  return canonicalJsonBytes(toJsonDomainValueR1(providerChartResult));
}

/** Read pinned source bytes back into the JSON-domain provider result. @param {Buffer|Uint8Array} bytes */
export function parseCanonicalProviderResultBytesR1(bytes) {
  const value = parseCanonicalJsonBytes(bytes);
  if (!isPlainObject(value)) fail('PROVIDER_RESULT_INVALID', 'pinned provider result must be a JSON object');
  return value;
}

/** @param {unknown} value @param {string} label */
function civilDateFromInstant(value, label) {
  if (typeof value !== 'string' || value.length < 10) {
    fail('PROVIDER_RESULT_INVALID', `${label} must be an ISO instant or civil date`);
  }
  const civil = /** @type {string} */ (value).slice(0, 10);
  if (!CIVIL_DATE_PATTERN.test(civil)) fail('PROVIDER_RESULT_INVALID', `${label} is not a civil date`);
  return civil;
}

/** @param {unknown} value */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Load the pinned XNYS calendar V2 sessions used to rebind timestamps.
 * @param {{root?: string}} [options]
 */
export function loadPinnedSessionsR1(options = {}) {
  const root = options.root ?? REPOSITORY_ROOT;
  if (!isAbsolute(root)) fail('ADAPTER_INPUT_INVALID', 'root must be an absolute path');
  const sessions = [];
  for (const year of CALENDAR_YEARS) {
    const path = resolve(root, `data/jarvise/session-calendar-historical/XNYS/${year}/session-calendar-core.json`);
    const calendar = JSON.parse(readFileSync(path, 'utf8'));
    if (calendar.schemaVersion !== 'MarketSessionCalendarCore/2') {
      fail('ADAPTER_CALENDAR_INVALID', `unexpected calendar schemaVersion for ${year}`);
    }
    sessions.push(...calendar.sessions);
  }
  sessions.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate, 'en'));
  return sessions;
}

/**
 * Convert a JSON-domain provider chart result into loosely-shaped daily rows
 * plus documented splits. Semantically empty results are refused rather than
 * pinned as an empty series.
 * @param {Record<string, any>} providerResult
 * @param {{expectedSymbol?: string}} [options]
 */
export function chartResultToDailyRowsR1(providerResult, options = {}) {
  if (!isPlainObject(providerResult)) fail('PROVIDER_RESULT_INVALID', 'provider result must be a plain object');
  const quotes = providerResult.quotes;
  if (!Array.isArray(quotes)) fail('PROVIDER_RESULT_MALFORMED', 'provider result has no quotes array');
  if (quotes.length === 0) fail('PROVIDER_RESULT_EMPTY', 'provider result contains no quotes');
  const meta = providerResult.meta;
  if (!isPlainObject(meta)) fail('PROVIDER_RESULT_MALFORMED', 'provider result has no meta object');
  const symbol = typeof meta.symbol === 'string' && meta.symbol.trim().length > 0 ? meta.symbol.trim() : null;
  if (symbol === null) fail('PROVIDER_RESULT_MALFORMED', 'provider meta carries no symbol');
  if (options.expectedSymbol !== undefined && symbol !== options.expectedSymbol) {
    fail('PROVIDER_SYMBOL_MISMATCH', `provider returned ${symbol}, expected ${options.expectedSymbol}`);
  }

  const events = isPlainObject(providerResult.events) ? providerResult.events : {};

  /** @type {Map<string, number>} */
  const dividendByDate = new Map();
  const dividends = events.dividends;
  const dividendList = Array.isArray(dividends)
    ? dividends
    : isPlainObject(dividends) ? Object.values(dividends) : [];
  for (const dividend of dividendList) {
    if (!isPlainObject(dividend)) fail('PROVIDER_RESULT_MALFORMED', 'dividend event is not an object');
    const date = civilDateFromInstant(dividend.date, 'dividend.date');
    const amount = finiteOrNull(dividend.amount);
    if (amount === null) fail('PROVIDER_RESULT_MALFORMED', `dividend on ${date} has no finite amount`);
    dividendByDate.set(date, (dividendByDate.get(date) ?? 0) + amount);
  }

  const splits = events.splits;
  const splitList = Array.isArray(splits) ? splits : isPlainObject(splits) ? Object.values(splits) : [];
  const documentedSplits = [];
  for (const split of splitList) {
    if (!isPlainObject(split)) fail('PROVIDER_RESULT_MALFORMED', 'split event is not an object');
    const date = civilDateFromInstant(split.date, 'split.date');
    const numerator = finiteOrNull(split.numerator);
    const denominator = finiteOrNull(split.denominator);
    if (numerator === null || denominator === null || denominator === 0 || numerator <= 0) {
      fail('PROVIDER_RESULT_MALFORMED', `split on ${date} has no usable numerator/denominator`);
    }
    documentedSplits.push({
      date,
      factor: numerator / denominator,
      ratioText: typeof split.splitRatio === 'string' ? split.splitRatio : `${numerator}:${denominator}`,
    });
  }
  documentedSplits.sort((left, right) => left.date.localeCompare(right.date, 'en'));

  /** @type {Set<string>} */
  const seenDates = new Set();
  const rows = quotes.map((quote, index) => {
    if (!isPlainObject(quote)) fail('PROVIDER_RESULT_MALFORMED', `quotes[${index}] is not an object`);
    const sessionDate = civilDateFromInstant(quote.date, `quotes[${index}].date`);
    if (seenDates.has(sessionDate)) {
      fail('PROVIDER_RESULT_MALFORMED', `duplicate quote session date ${sessionDate}`);
    }
    seenDates.add(sessionDate);
    /** @type {Record<string, unknown>} */
    const row = {
      date: sessionDate,
      open: finiteOrNull(quote.open),
      high: finiteOrNull(quote.high),
      low: finiteOrNull(quote.low),
      close: finiteOrNull(quote.close),
    };
    if (quote.volume !== undefined && quote.volume !== null) row.volume = finiteOrNull(quote.volume);
    if (quote.adjclose !== undefined && quote.adjclose !== null) row.adjclose = finiteOrNull(quote.adjclose);
    const cashDividend = dividendByDate.get(sessionDate);
    if (cashDividend !== undefined) row.cashDividend = cashDividend;
    return row;
  });

  rows.sort((left, right) => String(left.date).localeCompare(String(right.date), 'en'));
  return {
    symbol,
    currency: typeof meta.currency === 'string' ? meta.currency : 'USD',
    rows,
    documentedSplits,
    dividendCount: dividendByDate.size,
    splitCount: documentedSplits.length,
  };
}

/**
 * Full deterministic normalizer: pinned canonical provider bytes to
 * CanonicalDailyBars/1. Every returned session must exist in the pinned
 * calendar and fall inside the ratified acquisition window; anything else is
 * refused rather than silently dropped.
 * @param {{
 *   sourceBytes: Buffer|Uint8Array,
 *   expectedSymbol?: string,
 *   sessions?: Array<{sessionDate: string, closeUtc: string}>,
 *   firstSessionDate: string,
 *   lastSessionDate: string,
 *   root?: string,
 * }} input
 */
export function normalizeJarviseYahooChartR1(input) {
  if (!input || typeof input !== 'object') fail('ADAPTER_INPUT_INVALID', 'normalizer input is required');
  const providerResult = parseCanonicalProviderResultBytesR1(input.sourceBytes);
  const extracted = chartResultToDailyRowsR1(providerResult, { expectedSymbol: input.expectedSymbol });
  const sessions = input.sessions ?? loadPinnedSessionsR1({ root: input.root });

  const inWindow = new Set();
  for (const session of sessions) {
    if (session.sessionDate >= input.firstSessionDate && session.sessionDate <= input.lastSessionDate) {
      inWindow.add(session.sessionDate);
    }
  }

  for (const row of extracted.rows) {
    const sessionDate = /** @type {string} */ (row.date);
    if (sessionDate < input.firstSessionDate || sessionDate > input.lastSessionDate) {
      fail('ADAPTER_SESSION_OUT_OF_WINDOW', `provider returned ${sessionDate} outside the ratified window`, {
        sessionDate, firstSessionDate: input.firstSessionDate, lastSessionDate: input.lastSessionDate,
      });
    }
    if (!inWindow.has(sessionDate)) {
      fail('ADAPTER_SESSION_NOT_IN_CALENDAR', `provider returned ${sessionDate}, absent from pinned calendar V2`, { sessionDate });
    }
  }

  const dailyBars = normalizeDailyBars(extracted.rows, {
    symbol: extracted.symbol,
    source: SOURCE_FORMAT,
    ohlcBasis: OHLC_BASIS,
    currency: extracted.currency,
    documentedSplits: extracted.documentedSplits,
    loaderVersion: JARVISE_YAHOO_CHART_ADAPTER_VERSION,
  });

  const pinned = applyPinnedSessionTimestampsR1(dailyBars, sessions);
  const canonical = canonicalDailyBarsFromDailyBarV1(pinned, { priceBasis: OHLC_BASIS });
  if (canonical.schemaVersion !== CANONICAL_DAILY_BARS_SCHEMA_VERSION) {
    fail('ADAPTER_NORMALIZATION_INVALID', `normalized content must be ${CANONICAL_DAILY_BARS_SCHEMA_VERSION}`);
  }
  return canonical;
}
