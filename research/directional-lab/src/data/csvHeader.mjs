/**
 * Canonical CSV header normalization for the CSV daily adapter.
 *
 * canonicalizeCsvHeader is pure: it strips a UTF-8 BOM, trims whitespace,
 * lowercases, collapses spaces/hyphens/underscores, then maps known synonyms
 * to one canonical column name. Unknown headers return null — they are
 * reported by the caller, never guessed. Two source columns normalizing to
 * the same canonical name are a hard CSV_HEADER_COLLISION error (never a
 * silent overwrite).
 */

export const CSV_HEADER_VERSION = 'csvHeader/1';

export const ERROR_CSV_HEADER_COLLISION = 'CSV_HEADER_COLLISION';

/** canonical name -> normalized keys (lowercased, separators removed) */
const CANONICAL_KEYS = {
  date: ['date', 'sessiondate'],
  open: ['open'],
  high: ['high'],
  low: ['low'],
  close: ['close'],
  volume: ['volume'],
  adjclose: ['adjclose', 'adjustedclose'],
  adjOpen: ['adjopen', 'adjustedopen'],
  adjHigh: ['adjhigh', 'adjustedhigh'],
  adjLow: ['adjlow', 'adjustedlow'],
  adjVolume: ['adjvolume', 'adjustedvolume'],
  rawOpen: ['rawopen'],
  rawHigh: ['rawhigh'],
  rawLow: ['rawlow'],
  rawClose: ['rawclose'],
  rawVolume: ['rawvolume'],
  splitFactor: ['splitfactor'],
  cashDividend: ['cashdividend', 'dividend'],
};

const KEY_TO_CANONICAL = new Map();
for (const [canonical, keys] of Object.entries(CANONICAL_KEYS)) {
  for (const key of keys) KEY_TO_CANONICAL.set(key, canonical);
}

/**
 * Normalize one CSV header cell to its canonical column name.
 * @param {unknown} header
 * @returns {string|null} canonical name, or null for an unknown column
 */
export function canonicalizeCsvHeader(header) {
  if (typeof header !== 'string') return null;
  let h = header;
  if (h.length > 0 && h.charCodeAt(0) === 0xfeff) h = h.slice(1);
  h = h.trim().toLowerCase().replace(/[\s\-_]+/g, '');
  if (h === '') return null;
  return KEY_TO_CANONICAL.get(h) ?? null;
}

/**
 * Canonicalize a full header row.
 * @param {string[]} headers original header cells, in order
 * @returns {{canonical: (string|null)[], ignoredColumns: string[]}}
 *   canonical[i] is the canonical name of headers[i] (null = unknown, listed
 *   in ignoredColumns with its original text).
 * @throws {Error} CSV_HEADER_COLLISION when two columns normalize identically
 */
export function canonicalizeCsvHeaderRow(headers) {
  if (!Array.isArray(headers)) throw new Error('canonicalizeCsvHeaderRow: headers must be an array');
  const canonical = headers.map((h) => canonicalizeCsvHeader(h));
  const ignoredColumns = [];
  const seen = new Map();
  headers.forEach((original, i) => {
    const name = canonical[i];
    if (name === null) {
      ignoredColumns.push(original);
      return;
    }
    if (seen.has(name)) {
      throw new Error(
        `${ERROR_CSV_HEADER_COLLISION}: columns "${seen.get(name)}" and "${original}" both normalize to "${name}"; refusing ambiguous header`
      );
    }
    seen.set(name, original);
  });
  return { canonical, ignoredColumns };
}
