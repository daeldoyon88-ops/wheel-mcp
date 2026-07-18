/**
 * Normalize loosely-shaped source rows into strict DailyBarV1 bars.
 *
 * Policy:
 *  - the caller MUST state where the main OHLC columns belong (ohlcBasis);
 *  - raw and adjusted are never mixed implicitly;
 *  - null stays null; absent volume becomes null + VOLUME_MISSING flag (never 0);
 *  - no forward-fill of prices or events;
 *  - sessionDate comes from the civil part of the row date, never local time.
 */

import { DAILY_BAR_SCHEMA_VERSION, ADJUSTMENT_TYPES } from '../contracts/dailyBarV1.mjs';
import { assertCivilDate } from '../time/civilDate.mjs';
import { sessionCloseUtc } from '../time/marketSession.mjs';

export const NORMALIZE_DAILY_BARS_VERSION = 'normalizeDailyBars/1';

/**
 * @typedef {Object} NormalizeOptions
 * @property {string} symbol
 * @property {string} source provenance label (file path)
 * @property {'RAW'|'SPLIT_ADJUSTED'|'TOTAL_RETURN_ADJUSTED'|'DERIVED_ADJUSTED'} ohlcBasis where the main OHLC columns go
 * @property {string} [currency]
 * @property {string} [timezone]
 * @property {Array<{date: string, factor: number, ratioText?: string}>} [documentedSplits]
 * @property {string} [loaderVersion]
 */

/** @param {unknown} v @returns {number|null} */
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Extract the civil session date from a row date that may be either a civil
 * date or a UTC ISO instant. Never uses the local timezone.
 * @param {unknown} d
 * @returns {string}
 */
export function sessionDateFromRowDate(d) {
  if (typeof d !== 'string' || d.length < 10) {
    throw new Error(`Row date invalid: ${JSON.stringify(d)}`);
  }
  return assertCivilDate(d.slice(0, 10));
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {NormalizeOptions} options
 * @returns {import('../contracts/dailyBarV1.mjs').DailyBarV1[]}
 */
export function normalizeDailyBars(rows, options) {
  if (!Array.isArray(rows)) throw new Error('normalizeDailyBars: rows must be an array');
  if (!options || typeof options.symbol !== 'string' || options.symbol.trim().length === 0) {
    throw new Error('normalizeDailyBars: options.symbol required');
  }
  const symbol = options.symbol.trim();
  if (typeof options.source !== 'string' || !options.source) throw new Error('normalizeDailyBars: options.source required');
  if (!ADJUSTMENT_TYPES.includes(options.ohlcBasis)) {
    throw new Error(`normalizeDailyBars: ohlcBasis must be one of ${ADJUSTMENT_TYPES.join(', ')}`);
  }
  const currency = options.currency ?? 'USD';
  const timezone = options.timezone ?? 'America/New_York';
  const loaderVersion = options.loaderVersion ?? NORMALIZE_DAILY_BARS_VERSION;
  const splitsByDate = new Map();
  for (const s of options.documentedSplits ?? []) splitsByDate.set(s.date, s);

  return rows.map((row, rowIndex) => {
    const sessionDate = sessionDateFromRowDate(row.date ?? row.sessionDate);
    const eventTime = sessionCloseUtc(sessionDate);
    const qualityFlags = [];

    const open = numOrNull(row.open);
    const high = numOrNull(row.high);
    const low = numOrNull(row.low);
    const close = numOrNull(row.close);
    const volume = numOrNull(row.volume);
    if (row.volume === undefined || row.volume === null) qualityFlags.push('VOLUME_MISSING');

    const mainBlock = { open, high, low, close, volume };
    /** @type {import('../contracts/dailyBarV1.mjs').PriceBlock} */
    let raw;
    /** @type {import('../contracts/dailyBarV1.mjs').AdjustedBlock} */
    let adjusted;

    if (options.ohlcBasis === 'RAW') {
      raw = mainBlock;
      const adjClose = numOrNull(row.adjclose ?? row.adjClose);
      const adjOpen = numOrNull(row.adjOpen);
      const adjHigh = numOrNull(row.adjHigh);
      const adjLow = numOrNull(row.adjLow);
      const hasAnyAdj = adjClose !== null || adjOpen !== null || adjHigh !== null || adjLow !== null;
      if (hasAnyAdj) {
        adjusted = {
          open: adjOpen, high: adjHigh, low: adjLow, close: adjClose,
          volume: numOrNull(row.adjVolume),
          adjustmentType: 'TOTAL_RETURN_ADJUSTED',
          adjustmentFactor: adjClose !== null && close !== null && close !== 0 ? adjClose / close : null,
        };
        if (adjOpen === null || adjHigh === null || adjLow === null) qualityFlags.push('ADJUSTED_OHLC_PARTIAL');
      } else {
        adjusted = { open: null, high: null, low: null, close: null, volume: null, adjustmentType: null, adjustmentFactor: null };
        qualityFlags.push('ADJUSTED_OHLC_MISSING');
      }
    } else {
      adjusted = { ...mainBlock, adjustmentType: options.ohlcBasis, adjustmentFactor: numOrNull(row.adjustmentFactor) };
      const rawOpen = numOrNull(row.rawOpen);
      const rawHigh = numOrNull(row.rawHigh);
      const rawLow = numOrNull(row.rawLow);
      const rawClose = numOrNull(row.rawClose);
      const hasAnyRaw = rawOpen !== null || rawHigh !== null || rawLow !== null || rawClose !== null;
      if (hasAnyRaw) {
        raw = { open: rawOpen, high: rawHigh, low: rawLow, close: rawClose, volume: numOrNull(row.rawVolume) };
      } else {
        raw = { open: null, high: null, low: null, close: null, volume: null };
        qualityFlags.push('RAW_OHLC_MISSING');
      }
    }

    const documentedSplit = splitsByDate.get(sessionDate) ?? null;
    const rowSplit = numOrNull(row.splitFactor);
    const splitFactor = rowSplit !== null ? rowSplit : (documentedSplit ? documentedSplit.factor : null);
    if (documentedSplit) qualityFlags.push('SPLIT_DOCUMENTED');

    /** @type {Record<string, unknown>} */
    const lineage = {
      loadedFrom: options.source,
      loaderVersion,
      rowIndex,
      sourceRowDate: row.date ?? row.sessionDate ?? null,
    };
    const totalReturnClose = numOrNull(row.adjclose ?? row.adjClose);
    if (options.ohlcBasis !== 'RAW' && totalReturnClose !== null) {
      lineage.totalReturnClose = totalReturnClose;
      qualityFlags.push('TOTAL_RETURN_CLOSE_AVAILABLE');
    }

    return {
      schemaVersion: DAILY_BAR_SCHEMA_VERSION,
      symbol,
      sessionDate,
      eventTime,
      availableAt: eventTime,
      timezone,
      source: options.source,
      currency,
      raw,
      adjusted,
      corporateActions: { splitFactor, cashDividend: numOrNull(row.cashDividend) },
      qualityFlags,
      lineage,
    };
  });
}
