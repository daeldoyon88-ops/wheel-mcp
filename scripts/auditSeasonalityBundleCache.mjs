/**
 * Audit batch — cache SQLite bundle saisonnalité (tickers principaux).
 * Usage:
 *   node scripts/auditSeasonalityBundleCache.mjs
 *   node scripts/auditSeasonalityBundleCache.mjs --live
 *   node scripts/auditSeasonalityBundleCache.mjs --purge-invalid
 *   BASE_URL=http://localhost:3001 node scripts/auditSeasonalityBundleCache.mjs --live
 */

import { createSeasonalityPersistentCache } from "../app/seasonality/seasonalityPersistentCache.js";
import {
  analyzeBundlePayload,
  getBundleRecommendation,
} from "../app/seasonality/seasonalityBundleValidation.js";
import { DEFAULT_BACKEND_PORT } from "../app/config/constants.js";

const PRIMARY_TICKERS = [
  "TQQQ", "SOXL", "NVDA", "TSLA", "AMD", "AAPL",
  "SOFI", "PLTR", "APLD", "UPRO", "AVGO",
];

const args = new Set(process.argv.slice(2));
const LIVE_MODE = args.has("--live");
const PURGE_INVALID = args.has("--purge-invalid");
const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${DEFAULT_BACKEND_PORT}`).replace(/\/$/, "");

function yn(v) {
  return v ? "yes" : "no";
}

function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len - 1) + "…" : s.padEnd(len);
}

async function fetchBundle(ticker) {
  const url = `${BASE_URL}/seasonality/${encodeURIComponent(ticker)}/bundle`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return body;
}

async function auditTicker(ticker, cache) {
  const row = {
    ticker,
    cacheHit: false,
    fresh: false,
    validBundle: false,
    hasCalendarData: false,
    hasShortTermData: false,
    hasWindowsData: false,
    hasChart3yData: false,
    chart3yOk: false,
    error: null,
    recommendation: "",
  };

  try {
    await cache.ensureInitialized();
    const entry = cache.getCache(ticker);

    if (entry) {
      row.cacheHit = true;
      row.fresh = entry.fresh === true;
      const analysis = analyzeBundlePayload(entry.payload);
      Object.assign(row, analysis);
    } else if (LIVE_MODE) {
      const body = await fetchBundle(ticker);
      row.cacheHit = body?.cacheMeta?.hit === true;
      row.fresh = body?.cacheMeta?.fresh === true;
      const analysis = analyzeBundlePayload(body);
      Object.assign(row, analysis);
      if (body?.error) row.error = body.error;
    } else {
      row.recommendation = "NO_CACHE — lancer avec --live ou force=1";
      return row;
    }

    row.recommendation = getBundleRecommendation({
      validBundle: row.validBundle,
      cacheHit: row.cacheHit,
      fresh: row.fresh,
      error: row.error,
    });

    if (PURGE_INVALID && row.cacheHit && !row.validBundle) {
      cache.clearCache(ticker);
      row.recommendation += " [PURGED]";
    }
  } catch (err) {
    row.error = String(err?.message ?? err);
    row.recommendation = getBundleRecommendation({ error: row.error });
  }

  return row;
}

async function main() {
  console.log("\n=== AUDIT BUNDLE CACHE SAISONNALITÉ ===\n");
  console.log(`Tickers : ${PRIMARY_TICKERS.join(", ")}`);
  console.log(`Mode    : SQLite${LIVE_MODE ? " + API live" : ""}${PURGE_INVALID ? " + purge invalid" : ""}`);
  if (LIVE_MODE) console.log(`API     : ${BASE_URL}`);
  console.log("");

  const cache = createSeasonalityPersistentCache();
  const rows = [];

  for (const ticker of PRIMARY_TICKERS) {
    process.stdout.write(`  ${ticker}… `);
    const row = await auditTicker(ticker, cache);
    rows.push(row);
    console.log(row.recommendation);
  }

  const cols = [
    ["ticker", 8],
    ["cacheHit", 8],
    ["fresh", 6],
    ["validBundle", 12],
    ["hasCalendarData", 16],
    ["hasShortTermData", 17],
    ["hasWindowsData", 15],
    ["hasChart3yData", 15],
    ["chart3yOk", 10],
    ["error", 20],
    ["recommendation", 40],
  ];

  console.log("\n── Tableau récapitulatif ──\n");
  console.log(cols.map(([h, w]) => pad(h, w)).join(" "));
  console.log(cols.map(([, w]) => "-".repeat(w)).join(" "));

  for (const r of rows) {
    console.log([
      pad(r.ticker, 8),
      pad(yn(r.cacheHit), 8),
      pad(yn(r.fresh), 6),
      pad(yn(r.validBundle), 12),
      pad(yn(r.hasCalendarData), 16),
      pad(yn(r.hasShortTermData), 17),
      pad(yn(r.hasWindowsData), 15),
      pad(yn(r.hasChart3yData), 15),
      pad(yn(r.chart3yOk), 10),
      pad(r.error ?? "", 20),
      pad(r.recommendation, 40),
    ].join(" "));
  }

  const invalid = rows.filter(r => !r.validBundle && !r.error);
  const corrupt = rows.filter(r => r.cacheHit && !r.validBundle);
  const ok = rows.filter(r => r.validBundle);

  console.log("\n── Résumé ──");
  console.log(`  OK (validBundle)     : ${ok.length}/${rows.length}`);
  console.log(`  INVALID (sans cache) : ${invalid.length}`);
  console.log(`  CACHE_CORROMPU       : ${corrupt.length}`);

  if (corrupt.length) {
    console.log(`  Tickers corrompus    : ${corrupt.map(r => r.ticker).join(", ")}`);
    console.log("\n  Action suggérée :");
    console.log(`  curl -X POST ${BASE_URL}/seasonality/cache/clear -H "Content-Type: application/json" -d "{\\"tickers\\":[${corrupt.map(r => `"${r.ticker}"`).join(",")}]}"`);
  }

  if (invalid.length && !LIVE_MODE) {
    console.log("\n  Certains tickers sans cache — relancer avec --live ou :");
    for (const r of invalid) {
      console.log(`  curl "${BASE_URL}/seasonality/${r.ticker}/bundle?force=1"`);
    }
  }

  console.log("");
  process.exit(corrupt.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
