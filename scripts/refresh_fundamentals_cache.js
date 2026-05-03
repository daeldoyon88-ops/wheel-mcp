/**
 * Génère data/universe/fundamentals.cache.json à partir de universe.master.json
 * (symboles enabled && !excluded) + Yahoo quoteSummary (marketCap, quoteType, etc.).
 *
 * Usage:
 *   node scripts/refresh_fundamentals_cache.js
 *   node scripts/refresh_fundamentals_cache.js --limit 25
 *   node scripts/refresh_fundamentals_cache.js --symbols AAPL,MSFT,NFLX
 *   node scripts/refresh_fundamentals_cache.js --force
 *
 * Ne modifie pas universe.master.json.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YahooFinance from "yahoo-finance2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const UNIVERSE_DIR = join(ROOT, "data", "universe");
const MASTER_PATH = join(UNIVERSE_DIR, "universe.master.json");
const CACHE_PATH = join(UNIVERSE_DIR, "fundamentals.cache.json");
const TEMP_PATH = join(UNIVERSE_DIR, "fundamentals.cache.json.tmp");

const DEFAULT_CONCURRENCY = 4;
const QUOTE_SUMMARY_MODULES = /** @type {const} */ (["price", "summaryDetail", "quoteType"]);

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function toFiniteNumber(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @returns {{ limit: number | null, symbols: string[] | null, force: boolean, concurrency: number }}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  /** @type {number | null} */
  let limit = null;
  /** @type {string[] | null} */
  let symbols = null;
  let force = false;
  let concurrency = DEFAULT_CONCURRENCY;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--limit" && argv[i + 1]) {
      limit = Math.max(1, parseInt(argv[i + 1], 10) || 0) || null;
      i += 1;
      continue;
    }
    if (a === "--symbols" && argv[i + 1]) {
      symbols = argv[i + 1]
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--concurrency" && argv[i + 1]) {
      const c = parseInt(argv[i + 1], 10);
      if (Number.isFinite(c) && c >= 1 && c <= 16) concurrency = c;
      i += 1;
      continue;
    }
  }

  return { limit, symbols, force, concurrency };
}

/**
 * @param {string[]} symbols
 * @param {number} concurrency
 * @param {(symbol: string, index: number) => Promise<void>} fn
 */
async function runPool(symbols, concurrency, fn) {
  const n = Math.max(1, Math.min(concurrency, symbols.length));
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx;
      idx += 1;
      if (i >= symbols.length) return;
      await fn(symbols[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * @param {*} yf client yahoo-finance2
 * @param {string} symbol
 */
async function fetchFundamentalsForSymbol(yf, symbol) {
  const itemAsOf = new Date().toISOString();
  const data = await yf.quoteSummary(symbol, requestOptions());

  const sd = data.summaryDetail;
  const price = data.price;
  const qt = data.quoteType;

  const marketCap = toFiniteNumber(sd?.marketCap ?? price?.marketCap);
  const quoteTypeRaw = qt?.quoteType != null ? String(qt.quoteType) : null;
  const currency =
    (price?.currency != null ? String(price.currency) : null) ??
    (sd?.currency != null ? String(sd.currency) : null) ??
    "USD";

  if (marketCap == null || !(marketCap > 0)) {
    return {
      ok: false,
      error: "market_cap_missing_or_invalid",
      itemAsOf,
    };
  }

  const marketCapB = marketCap / 1e9;

  return {
    ok: true,
    item: {
      symbol,
      marketCap,
      marketCapB,
      currency,
      quoteType: quoteTypeRaw ?? "UNKNOWN",
      asOf: itemAsOf,
    },
    itemAsOf,
  };
}

function requestOptions() {
  return {
    modules: [...QUOTE_SUMMARY_MODULES],
    formatted: false,
  };
}

async function main() {
  const { limit, symbols: symbolsFilter, force, concurrency } = parseArgs();
  const runAsOf = new Date().toISOString();

  if (!existsSync(MASTER_PATH)) {
    console.error(`Absence du master : ${MASTER_PATH}`);
    process.exitCode = 1;
    return;
  }

  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(MASTER_PATH, "utf8"));
  } catch (e) {
    console.error("Lecture universe.master.json impossible:", e);
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(raw)) {
    console.error("universe.master.json doit être un tableau.");
    process.exitCode = 1;
    return;
  }

  /** @type {string[]} */
  const fromMaster = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    if (row.enabled !== true) continue;
    if (row.excluded === true) continue;
    if (typeof row.symbol !== "string") continue;
    const sym = row.symbol.trim().toUpperCase();
    if (sym) fromMaster.push(sym);
  }

  const uniqueSorted = [...new Set(fromMaster)].sort((a, b) => a.localeCompare(b));

  /** @type {string[]} */
  let work = uniqueSorted;
  if (symbolsFilter && symbolsFilter.length > 0) {
    const want = new Set(symbolsFilter);
    work = work.filter((s) => want.has(s));
  }
  if (limit != null) {
    work = work.slice(0, limit);
  }

  console.log(`Symboles à traiter : ${work.length} (concurrence ${concurrency})`);
  if (work.length === 0) {
    console.warn("Aucun symbole — rien à faire.");
    process.exitCode = 0;
    return;
  }

  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  /** @type {Record<string, object>} */
  const items = {};
  /** @type {Record<string, string>} */
  const errors = {};

  let done = 0;
  const total = work.length;

  await runPool(work, concurrency, async (symbol) => {
    try {
      const res = await fetchFundamentalsForSymbol(yf, symbol);
      if (res.ok && res.item) {
        items[symbol] = res.item;
      } else {
        errors[symbol] = res.error ?? "unknown";
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors[symbol] = msg || "error";
    } finally {
      done += 1;
      process.stdout.write(`\rProgression : ${done}/${total}`);
    }
  });

  process.stdout.write("\n");

  const successCount = Object.keys(items).length;

  /** @type {Record<string, object>} */
  const itemsSorted = {};
  for (const k of Object.keys(items).sort((a, b) => a.localeCompare(b))) {
    itemsSorted[k] = items[k];
  }
  /** @type {Record<string, string>} */
  const errorsSorted = {};
  for (const k of Object.keys(errors).sort((a, b) => a.localeCompare(b))) {
    errorsSorted[k] = errors[k];
  }

  const payload = {
    asOf: runAsOf,
    source: "yahoo-finance2",
    count: successCount,
    items: itemsSorted,
    errors: errorsSorted,
  };

  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;

  try {
    writeFileSync(TEMP_PATH, jsonText, "utf8");
  } catch (e) {
    console.error("Écriture du fichier temporaire impossible:", e);
    process.exitCode = 1;
    return;
  }

  if (successCount === 0 && existsSync(CACHE_PATH) && !force) {
    try {
      unlinkSync(TEMP_PATH);
    } catch {
      /* ignore */
    }
    console.warn(
      "0 succès — cache existant conservé (utiliser --force pour écraser avec erreurs seulement)."
    );
    process.exitCode = 1;
    return;
  }

  try {
    if (existsSync(CACHE_PATH)) {
      unlinkSync(CACHE_PATH);
    }
    renameSync(TEMP_PATH, CACHE_PATH);
  } catch (e) {
    console.error("Renommage vers fundamentals.cache.json impossible:", e);
    try {
      unlinkSync(TEMP_PATH);
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
    return;
  }

  console.log(`OK — écrit : ${CACHE_PATH}`);
  console.log(`count: ${successCount}, erreurs: ${Object.keys(errors).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
