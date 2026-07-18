/**
 * Read-only adapter for simple daily CSV files:
 *   date,open,high,low,close,volume[,adjclose][,splitFactor][,cashDividend]
 *
 * Headers are normalized through canonicalizeCsvHeaderRow (csvHeader.mjs):
 * BOM/case/space/hyphen/underscore-insensitive, usual synonyms mapped
 * (Adj Close -> adjclose, session_date -> date, Dividend -> cashDividend...).
 * Unknown columns are reported in sourceMeta.ignoredColumns and never
 * interpreted under another name. Collisions after normalization and rows
 * whose cell count differs from the header are refused. Quoted fields stay
 * explicitly out of scope.
 *
 * The caller must state the basis of the OHLC columns (default RAW for CSV,
 * since generic CSV exports are usually unadjusted). Nothing is written back.
 */

import { readFileSync } from 'node:fs';
import { normalizeDailyBars } from './normalizeDailyBars.mjs';
import { canonicalizeCsvHeaderRow } from './csvHeader.mjs';

export const CSV_ADAPTER_VERSION = 'csvDailyAdapter/2';

const REQUIRED_CANONICAL = ['date', 'open', 'high', 'low', 'close'];

/**
 * Minimal CSV parser: comma separated, no quoted fields with embedded commas
 * (rejects them explicitly rather than mis-parsing). Data rows keep their
 * original 1-based line number so malformed rows can be reported precisely.
 * @param {string} text
 * @returns {{header: string[], rows: Array<{cells: string[], lineNumber: number}>}}
 */
export function parseCsv(text) {
  if (text.includes('"')) throw new Error('Quoted CSV fields are not supported by this adapter');
  const lines = text.split(/\r?\n/);
  /** @type {string[]|null} */
  let header = null;
  /** @type {Array<{cells: string[], lineNumber: number}>} */
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const cells = lines[i].split(',').map((c) => c.trim());
    if (header === null) header = cells;
    else rows.push({ cells, lineNumber: i + 1 });
  }
  if (header === null) throw new Error('CSV is empty');
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
  let canonicalized;
  try {
    canonicalized = canonicalizeCsvHeaderRow(header);
  } catch (err) {
    throw new Error(`${filePath}: ${/** @type {Error} */ (err).message}`);
  }
  const { canonical, ignoredColumns } = canonicalized;
  for (const required of REQUIRED_CANONICAL) {
    if (!canonical.includes(required)) {
      throw new Error(`${filePath}: CSV missing required column "${required}" (headers: ${header.join(', ')})`);
    }
  }
  if (rows.length === 0) {
    throw new Error(`CSV_NO_DATA_ROWS: ${filePath}: header present but no data rows`);
  }
  const objects = rows.map(({ cells, lineNumber }) => {
    if (cells.length !== header.length) {
      throw new Error(
        `${filePath}: line ${lineNumber} has ${cells.length} cell(s) but the header has ${header.length} column(s); malformed row refused`
      );
    }
    /** @type {Record<string, string|null>} */
    const o = {};
    canonical.forEach((name, i) => {
      if (name === null) return; // unknown column: reported in ignoredColumns, never interpreted
      o[name] = cells[i] === '' ? null : cells[i];
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
    sourceMeta: { header, canonicalHeader: canonical, ignoredColumns },
    format: 'CSV_DAILY_V1',
  };
}
