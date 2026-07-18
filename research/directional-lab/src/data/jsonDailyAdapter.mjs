/**
 * Read-only adapter for the local OHLC cache JSON files present in this repo:
 *   { symbol, savedAt, [source], [splits], rows: [{date, open, high, low, close, volume, [adjclose]}] }
 *
 * These caches carry split-adjusted OHLC with a close NOT adjusted for
 * dividends (per their own source note). The adapter therefore normalizes
 * them with ohlcBasis=SPLIT_ADJUSTED by default; raw OHLC is null (missing),
 * never fabricated. The source file is never modified.
 */

import { readFileSync } from 'node:fs';
import { normalizeDailyBars } from './normalizeDailyBars.mjs';

export const JSON_ADAPTER_VERSION = 'jsonDailyAdapter/1';

/**
 * Parse a split ratio like "6:1" (6 new for 1 old -> factor 6) or "1:6"
 * (reverse split -> factor 1/6).
 * @param {string} ratioText
 * @returns {number|null}
 */
export function parseSplitRatio(ratioText) {
  if (typeof ratioText !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratioText.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  return num / den;
}

/**
 * @typedef {Object} JsonAdapterResult
 * @property {import('../contracts/dailyBarV1.mjs').DailyBarV1[]} bars
 * @property {Object} sourceMeta metadata found in the file (savedAt, source, splits, validation, ...)
 * @property {string} format
 */

/**
 * Load one OHLC cache JSON file, read-only.
 * @param {string} filePath
 * @param {{symbol?: string, ohlcBasis?: 'RAW'|'SPLIT_ADJUSTED'|'TOTAL_RETURN_ADJUSTED'|'DERIVED_ADJUSTED'}} [options]
 * @returns {JsonAdapterResult}
 */
export function loadJsonDaily(filePath, options = {}) {
  const text = readFileSync(filePath, 'utf8');
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${filePath}: not valid JSON (${/** @type {Error} */ (err).message})`);
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) {
    throw new Error(`${filePath}: unrecognized JSON shape (expected { rows: [...] })`);
  }
  const fileSymbol = typeof parsed.symbol === 'string' ? parsed.symbol : null;
  const symbol = options.symbol ?? fileSymbol;
  if (!symbol) throw new Error(`${filePath}: symbol missing in file and not provided`);
  if (options.symbol && fileSymbol && options.symbol !== fileSymbol) {
    throw new Error(`${filePath}: requested symbol ${options.symbol} but file declares ${fileSymbol}`);
  }

  const documentedSplits = [];
  if (Array.isArray(parsed.splits)) {
    for (const s of parsed.splits) {
      if (s && typeof s.date === 'string') {
        const factor = typeof s.ratio === 'string' ? parseSplitRatio(s.ratio)
          : typeof s.factor === 'number' ? s.factor : null;
        if (factor !== null) documentedSplits.push({ date: s.date.slice(0, 10), factor, ratioText: s.ratio ?? null });
      }
    }
  }

  const bars = normalizeDailyBars(parsed.rows, {
    symbol,
    source: filePath,
    ohlcBasis: options.ohlcBasis ?? 'SPLIT_ADJUSTED',
    documentedSplits,
    loaderVersion: JSON_ADAPTER_VERSION,
  });

  const { rows: _rows, ...sourceMeta } = parsed;
  return { bars, sourceMeta, format: 'OHLC_CACHE_JSON_V1' };
}
