/**
 * Read-only adapter for simple daily CSV files:
 *   date,open,high,low,close,volume[,adjclose][,splitFactor][,cashDividend]
 *
 * The caller must state the basis of the OHLC columns (default RAW for CSV,
 * since generic CSV exports are usually unadjusted). Nothing is written back.
 */

import { readFileSync } from 'node:fs';
import { normalizeDailyBars } from './normalizeDailyBars.mjs';

export const CSV_ADAPTER_VERSION = 'csvDailyAdapter/1';

const KNOWN_COLUMNS = new Set([
  'date', 'sessionDate', 'open', 'high', 'low', 'close', 'volume',
  'adjclose', 'adjClose', 'adjOpen', 'adjHigh', 'adjLow', 'adjVolume',
  'rawOpen', 'rawHigh', 'rawLow', 'rawClose', 'rawVolume',
  'splitFactor', 'cashDividend',
]);

/**
 * Minimal CSV parser: comma separated, no quoted fields with embedded commas
 * (rejects them explicitly rather than mis-parsing).
 * @param {string} text
 * @returns {{header: string[], rows: string[][]}}
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('CSV is empty');
  if (text.includes('"')) throw new Error('Quoted CSV fields are not supported by this adapter');
  const header = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim()));
  return { header, rows };
}

/**
 * Load one daily CSV file, read-only.
 * @param {string} filePath
 * @param {{symbol: string, ohlcBasis?: 'RAW'|'SPLIT_ADJUSTED'|'TOTAL_RETURN_ADJUSTED'|'DERIVED_ADJUSTED'}} options
 * @returns {{bars: import('../contracts/dailyBarV1.mjs').DailyBarV1[], sourceMeta: Object, format: string}}
 */
export function loadCsvDaily(filePath, options) {
  if (!options || typeof options.symbol !== 'string' || !options.symbol) {
    throw new Error('loadCsvDaily: options.symbol is required (CSV files carry no symbol)');
  }
  const text = readFileSync(filePath, 'utf8');
  const { header, rows } = parseCsv(text);
  const lower = header.map((h) => h.toLowerCase());
  for (const required of ['date', 'open', 'high', 'low', 'close']) {
    if (!lower.includes(required)) throw new Error(`${filePath}: CSV missing required column "${required}"`);
  }
  const unknown = header.filter((h) => !KNOWN_COLUMNS.has(h) && !KNOWN_COLUMNS.has(h.toLowerCase()));
  const objects = rows.map((cells) => {
    /** @type {Record<string, string|null>} */
    const o = {};
    header.forEach((h, i) => {
      const cell = cells[i];
      o[h.toLowerCase() === h ? h : h] = cell === undefined || cell === '' ? null : cell;
    });
    return o;
  });
  const bars = normalizeDailyBars(objects, {
    symbol: options.symbol,
    source: filePath,
    ohlcBasis: options.ohlcBasis ?? 'RAW',
    loaderVersion: CSV_ADAPTER_VERSION,
  });
  return {
    bars,
    sourceMeta: { header, ignoredColumns: unknown },
    format: 'CSV_DAILY_V1',
  };
}
