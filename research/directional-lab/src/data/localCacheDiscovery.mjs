/**
 * Read-only discovery of local daily-bar files.
 *
 * Safety rules:
 *  - only explicitly allowed paths are inspected (no blind disk scan);
 *  - sources are never modified, moved or deleted;
 *  - unknown formats are reported, not guessed into data.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const DISCOVERY_VERSION = 'localCacheDiscovery/1';

/**
 * @typedef {Object} DiscoveredCandidate
 * @property {string} path
 * @property {string|null} symbol symbol declared by the file (or inferred from name, flagged)
 * @property {string} format OHLC_CACHE_JSON_V1 | CSV_DAILY_V1 | UNKNOWN
 * @property {number} sizeBytes
 * @property {string[]} notes
 */

/**
 * Probe one file (first bytes only for JSON detection, then full parse of the
 * header) and classify its format.
 * @param {string} filePath
 * @returns {DiscoveredCandidate}
 */
export function probeFile(filePath) {
  const st = statSync(filePath);
  const notes = [];
  let format = 'UNKNOWN';
  let symbol = null;
  const name = basename(filePath);
  if (name.endsWith('.json')) {
    const text = readFileSync(filePath, 'utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rows)
        && parsed.rows.length > 0 && typeof parsed.rows[0] === 'object'
        && 'date' in parsed.rows[0] && 'close' in parsed.rows[0]) {
        format = 'OHLC_CACHE_JSON_V1';
        symbol = typeof parsed.symbol === 'string' ? parsed.symbol : null;
        if (!symbol) notes.push('symbol missing in JSON');
        if (typeof parsed.source === 'string') notes.push(`declared source: ${parsed.source}`);
        else notes.push('source field absent (older cache variant)');
      } else {
        notes.push('JSON without rows[] of daily bars');
      }
    } catch {
      notes.push('unparseable JSON');
    }
  } else if (name.endsWith('.csv')) {
    const text = readFileSync(filePath, 'utf8');
    const header = (text.split(/\r?\n/, 1)[0] ?? '').toLowerCase();
    if (['date', 'open', 'high', 'low', 'close'].every((c) => header.includes(c))) {
      format = 'CSV_DAILY_V1';
      notes.push('symbol must be provided externally for CSV');
    } else {
      notes.push(`CSV header not recognized: ${header.slice(0, 120)}`);
    }
  } else {
    notes.push('extension not supported (.json/.csv only)');
  }
  return { path: filePath, symbol, format, sizeBytes: st.size, notes };
}

/**
 * Discover candidate daily-bar files under an explicit allowlist of paths.
 * Directories are listed one level deep only (no recursive disk walk).
 * @param {{allowedPaths: string[]}} options
 * @returns {{candidates: DiscoveredCandidate[], errors: string[]}}
 */
export function discoverLocalDailyFiles(options) {
  if (!options || !Array.isArray(options.allowedPaths) || options.allowedPaths.length === 0) {
    throw new Error('discoverLocalDailyFiles: an explicit allowedPaths list is required');
  }
  const candidates = [];
  const errors = [];
  for (const p of options.allowedPaths) {
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      errors.push(`${p}: ${/** @type {Error} */ (err).message}`);
      continue;
    }
    if (st.isDirectory()) {
      let entries;
      try {
        entries = readdirSync(p, { withFileTypes: true });
      } catch (err) {
        errors.push(`${p}: ${/** @type {Error} */ (err).message}`);
        continue;
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!(e.name.endsWith('.json') || e.name.endsWith('.csv'))) continue;
        try {
          candidates.push(probeFile(join(p, e.name)));
        } catch (err) {
          errors.push(`${join(p, e.name)}: ${/** @type {Error} */ (err).message}`);
        }
      }
    } else if (st.isFile()) {
      try {
        candidates.push(probeFile(p));
      } catch (err) {
        errors.push(`${p}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { candidates, errors };
}
