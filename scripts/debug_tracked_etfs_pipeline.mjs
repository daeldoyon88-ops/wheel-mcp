/**
 * Diagnostic read-only — pipeline TQQQ / SOXL / TNA / SSO
 * Usage: node scripts/debug_tracked_etfs_pipeline.mjs [--no-yahoo] [--expiration YYYY-MM-DD]
 *
 * Expiration par défaut : prochain vendredi (local), aligné sur dashboard.jsx nextNFridays().
 * Ne modifie aucun fichier projet hors ce script.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { createMarketService } from "../app/services/marketService.js";
import { createWatchlistBuilder } from "../app/watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../app/watchlist/watchlistCache.js";
import { buildResearchExpandedPool } from "../app/watchlist/researchExpandedPool.js";
import { loadMergedUniverse, loadMasterUniverse } from "../app/watchlist/universeLoader.js";
import { createWheelScanner } from "../app/scanners/wheelScanner.js";
import { LEVERAGED_ETF_RESEARCH_PINNED } from "../app/watchlist/researchExpandedPool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TRACKED = ["TQQQ", "SOXL", "TNA", "SSO"];

/** Aligné wheel-dashboard/src/dashboard.jsx DEFAULT_BUILD_WATCHLIST_BODY */
const DASHBOARD_BUILD = {
  maxPrice: 200,
  minPrice: 10,
  minVolume: 500_000,
  maxContractCapital: 25_500,
  minMarketCapB: 5,
  requireLiquidOptions: true,
  requireWeeklyOptions: true,
  liquidityOtmProbePct: 5,
  categories: ["weekly", "core", "growth", "high_premium"],
  limit: 150,
  watchlistMode: "relaxed",
};

const DASHBOARD_RESEARCH = {
  limit: 150,
  maxPrice: null,
  includeAboveMaxPrice: true,
  flagUnreliable: true,
  categories: ["weekly", "core", "growth", "high_premium", "etf"],
};

function parseArgs(argv) {
  const out = { noYahoo: false, expiration: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-yahoo") {
      out.noYahoo = true;
      continue;
    }
    if (a === "--expiration" && argv[i + 1]) {
      out.expiration = String(argv[++i]).trim();
      continue;
    }
  }
  return out;
}

/** YYYY-MM-DD en fuseau local (évite le décalage UTC de toISOString). */
function ymdLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isYmd(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const WEEKDAY_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function weekdayLabelFromYmd(ymd) {
  if (!isYmd(ymd)) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return WEEKDAY_FR[dt.getDay()] ?? "—";
}

/**
 * Prochains vendredis (local), même logique que dashboard.jsx nextNFridays().
 * @param {number} n
 */
function nextNFridaysLocal(n = 6) {
  const fridays = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (fridays.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 5) {
      fridays.push(ymdLocal(d));
    }
  }
  return fridays;
}

/**
 * @param {string | null | undefined} explicit --expiration CLI
 */
function pickDefaultScanExpiration(explicit) {
  if (isYmd(explicit)) return explicit;
  const todayYmd = ymdLocal(new Date());
  const fridays = nextNFridaysLocal(6);
  return fridays.find((f) => f >= todayYmd) || fridays[0] || "";
}

/**
 * Si l'expiration demandée est absente chez Yahoo, tente le prochain vendredi listé.
 * @param {{ getOptionExpirations: Function }} marketService
 * @param {string} symbol
 * @param {string} preferred
 */
async function resolveExpirationForSymbol(marketService, symbol, preferred) {
  const exp = await marketService.getOptionExpirations(symbol);
  const available = Array.isArray(exp?.availableExpirations) ? exp.availableExpirations : [];
  if (available.includes(preferred)) {
    return { expiration: preferred, source: "requested", availableCount: available.length };
  }
  const fridays = available.filter((d) => {
    if (!isYmd(d)) return false;
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y, m - 1, day).getDay() === 5;
  });
  const todayYmd = ymdLocal(new Date());
  const nextListedFriday =
    fridays.filter((d) => d >= todayYmd).sort()[0] ||
    fridays.sort()[0] ||
    available.filter((d) => d >= todayYmd).sort()[0] ||
    available.sort()[0] ||
    null;
  if (nextListedFriday) {
    return {
      expiration: nextListedFriday,
      source: preferred ? "yahoo_fallback_from_request" : "yahoo_next_listed",
      requested: preferred,
      availableCount: available.length,
      sampleFridays: fridays.slice(0, 4),
    };
  }
  return {
    expiration: preferred,
    source: "no_yahoo_expirations",
    availableCount: 0,
  };
}

function masterPath() {
  return join(REPO_ROOT, "data", "universe", "universe.master.json");
}

/**
 * @returns {Map<string, object>}
 */
function loadMasterRowsBySymbol() {
  const path = masterPath();
  if (!existsSync(path)) return new Map();
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) return new Map();
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const row of data) {
    const sym = String(row?.symbol || "").trim().toUpperCase();
    if (sym) map.set(sym, row);
  }
  return map;
}

function loaderIncluded(symbol, categories) {
  const merged = loadMergedUniverse({ categories });
  return merged.some((r) => r.symbol === symbol && r.enabled);
}

function rankInList(symbol, list, key = "symbol") {
  const idx = list.findIndex((r) => {
    const s = typeof r === "string" ? r : r?.[key];
    return String(s || "").toUpperCase() === symbol;
  });
  return idx >= 0 ? idx + 1 : null;
}

function pad(str, len) {
  const s = String(str ?? "—");
  return s.length >= len ? s.slice(0, len) : s.padEnd(len);
}

function printTable(rows) {
  const headers = [
    "Ticker",
    "masterEnabled",
    "masterExcluded",
    "masterReason",
    "loaderIncluded",
    "buildRejectedReason",
    "watchlistKept",
    "watchlistRank",
    "researchExpandedRank",
    "sentToYahooPossible",
    "notes",
  ];
  const widths = headers.map((h) => Math.max(h.length, 10));
  for (const row of rows) {
    headers.forEach((h, i) => {
      widths[i] = Math.max(widths[i], pad(row[h], 0).length);
    });
  }
  console.log(headers.map((h, i) => pad(h, widths[i])).join(" | "));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of rows) {
    console.log(headers.map((h, i) => pad(row[h], widths[i])).join(" | "));
  }
}

function analyzeWatchlistBuild(wl) {
  const watchlist = (wl.watchlist || []).map((s) => String(s).toUpperCase());
  const rejected = wl.rejected || [];
  const fullRanked = wl.watchlistDiagnosticsV1?.fullRankedCandidates || [];
  const rejMap = new Map(rejected.map((r) => [String(r.symbol).toUpperCase(), r]));

  /** @type {Record<string, object>} */
  const out = {};
  for (const sym of TRACKED) {
    const kept = watchlist.includes(sym);
    const rej = rejMap.get(sym);
    const rankRow = fullRanked.find((r) => String(r.symbol).toUpperCase() === sym);
    const rankBeforeLimit = rankRow?.rankBeforeLimit ?? rankInList(sym, fullRanked);
    const excludedByLimit = rankRow?.excludedByLimit === true;
    out[sym] = {
      buildRejectedReason: kept ? "" : rej?.reason ?? (rej ? "rejected" : "not_in_kept_rows"),
      watchlistKept: kept ? "yes" : "no",
      watchlistRank: kept ? rankInList(sym, watchlist) : rankBeforeLimit,
      watchlistScore: rankRow?.watchlistScore ?? null,
      sortScore: rankRow?.sortScore ?? null,
      excludedByLimit,
      v3Recovered: rankRow?.recoveredByYahooLiquidityV3LiveSafe === true,
      softPenalized: rankRow?.softPenalized === true,
      detail: rej?.detail ?? null,
    };
  }
  return out;
}

function analyzeScan(scanPayload, tickersSent) {
  const shortlist = (scanPayload?.shortlist || []).map((r) =>
    String(r.symbol || r.ticker || "").toUpperCase()
  );
  const rejected = scanPayload?.rejected || [];
  const rejMap = new Map(
    rejected.map((r) => [String(r.symbol || r.ticker || "").toUpperCase(), r])
  );
  const errors = scanPayload?.errors || [];
  const errMap = new Map(errors.map((e) => [String(e.symbol || "").toUpperCase(), e]));

  /** @type {Record<string, object>} */
  const out = {};
  for (const sym of TRACKED) {
    const inShortlist = shortlist.includes(sym);
    const sent = tickersSent.includes(sym);
    const rej = rejMap.get(sym);
    const err = errMap.get(sym);
    out[sym] = {
      sentToScan: sent,
      scanKept: inShortlist,
      scanRank: inShortlist ? rankInList(sym, shortlist) : null,
      scanRejectedReason: rej?.reason ?? rej?.rejectionReason ?? null,
      scanError: err?.message ?? null,
      wheelStage: rej?.stage ?? null,
    };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  process.env.YAHOO_FUNNEL_DIAGNOSTICS = process.env.YAHOO_FUNNEL_DIAGNOSTICS ?? "1";

  const masterBySym = loadMasterRowsBySymbol();
  const categories = DASHBOARD_BUILD.categories;

  const researchPayload = buildResearchExpandedPool(DASHBOARD_RESEARCH);
  const researchPool = (researchPayload.pool || []).map((s) => String(s).toUpperCase());

  /** @type {Record<string, object>} */
  let watchlistAnalysis = {};
  /** @type {Record<string, object>} */
  let scanAnalysis = {};
  let yahooRan = false;
  let yahooError = null;

  if (!args.noYahoo) {
    const provider = createMarketDataProvider();
    const marketService = createMarketService(provider);
    const cache = createWatchlistCache();
    const watchlistBuilder = createWatchlistBuilder({ marketService, cache, concurrency: 4 });
    const wheelScanner = createWheelScanner(marketService);

    try {
      console.log("[debug] buildWatchlist (dashboard defaults) — Yahoo requis, peut prendre 1-3 min…");
      const wl = await watchlistBuilder.buildWatchlist(DASHBOARD_BUILD);
      watchlistAnalysis = analyzeWatchlistBuild(wl);
      console.log("[debug] watchlist stats:", {
        kept: wl.watchlist?.length,
        retained: wl.stats?.retainedAfterFiltersCount,
        truncated: wl.stats?.truncated,
        limit: wl.stats?.limitApplied,
        rejectedByReason: wl.stats?.rejectedByReason,
      });
    } catch (e) {
      yahooError = e instanceof Error ? e.message : String(e);
      console.warn("[debug] buildWatchlist échoué (scan TRACKED continue):", yahooError);
    }

    try {
      const requestedExpiration = pickDefaultScanExpiration(args.expiration);
      if (args.expiration && !isYmd(args.expiration)) {
        console.warn("[debug] --expiration invalide, ignoré:", args.expiration);
      }

      const expResolve = await resolveExpirationForSymbol(marketService, "TQQQ", requestedExpiration);
      const expiration = expResolve.expiration;

      console.log("[debug] expiration scan", {
        requested: args.expiration ?? "(default next Friday)",
        defaultFriday: pickDefaultScanExpiration(null),
        used: expiration,
        weekday: weekdayLabelFromYmd(expiration),
        resolveSource: expResolve.source,
        yahooExpirationsSample: expResolve.sampleFridays ?? null,
        yahooExpirationsCount: expResolve.availableCount ?? null,
      });

      if (args.expiration && expiration !== args.expiration) {
        console.warn(
          `[debug] expiration ajustée ${args.expiration} (${weekdayLabelFromYmd(args.expiration)}) → ${expiration} (${weekdayLabelFromYmd(expiration)}) — ${expResolve.source}`
        );
      }

      console.log("[debug] scan_shortlist TRACKED only");
      const scan = await wheelScanner.scanShortlist({
        expiration,
        tickers: TRACKED,
        topN: 20,
        sort: "quality",
      });
      const scanPayload = scan.payload || {};
      scanAnalysis = analyzeScan(scanPayload, TRACKED);
      yahooRan = true;

      console.log("[debug] scan TRACKED:", {
        expiration,
        expirationWeekday: weekdayLabelFromYmd(expiration),
        scanned: scanPayload.scanned,
        kept: scanPayload.kept,
        rejectionReasonCounts: scanPayload.rejectionReasonCounts,
        trackedInShortlist: TRACKED.filter((s) =>
          (scanPayload.shortlist || []).some(
            (r) => String(r.symbol || "").toUpperCase() === s
          )
        ),
        trackedRejected: (scanPayload.rejected || [])
          .filter((r) => TRACKED.includes(String(r.symbol || "").toUpperCase()))
          .map((r) => ({ symbol: r.symbol, reason: r.reason })),
      });
    } catch (e) {
      const scanErr = e instanceof Error ? e.message : String(e);
      console.warn("[debug] scan TRACKED échoué:", scanErr);
      if (!yahooError) yahooError = scanErr;
    }
  }

  /** @type {object[]} */
  const tableRows = [];
  for (const sym of TRACKED) {
    const master = masterBySym.get(sym) || null;
    const wl = watchlistAnalysis[sym] || {};
    const sc = scanAnalysis[sym] || {};
    const notes = [];

    if (!master) notes.push("absent du master");
    if (master?.tags?.includes("whitelisted")) notes.push("tag whitelisted");
    if (!loaderIncluded(sym, categories)) notes.push("hors loadMergedUniverse(categories dashboard)");
    if (LEVERAGED_ETF_RESEARCH_PINNED.includes(sym)) notes.push("pinned research");
    if (wl.excludedByLimit) notes.push("coupé par limit=150");
    if (wl.v3Recovered) notes.push("V3 live recovered");
    if (sc.scanRejectedReason) notes.push(`scan: ${sc.scanRejectedReason}`);
    if (sc.scanError) notes.push(`scan err: ${sc.scanError}`);
    if (yahooError && !yahooRan) notes.push(`yahoo skip: ${yahooError}`);

    const sentToYahoo =
      yahooRan && (wl.watchlistKept === "yes" || researchPool.includes(sym) || TRACKED.includes(sym))
        ? sc.sentToScan === false && wl.watchlistKept !== "yes"
          ? "no (watchlist+scan)"
          : sc.scanKept
            ? "yes (scan kept)"
            : sc.sentToScan
              ? "yes (sent scan)"
              : wl.watchlistKept === "yes"
                ? "yes (watchlist)"
                : researchPool.includes(sym)
                  ? "yes (research pool)"
                  : "partial"
        : args.noYahoo
          ? "skipped (--no-yahoo)"
          : yahooError
            ? "failed"
            : "unknown";

    tableRows.push({
      Ticker: sym,
      masterEnabled: master ? (master.enabled === true ? "yes" : "no") : "missing",
      masterExcluded: master ? (master.excluded === true ? "yes" : "no") : "—",
      masterReason: master?.excludeReason ?? "—",
      loaderIncluded: loaderIncluded(sym, categories) ? "yes" : "no",
      buildRejectedReason: wl.buildRejectedReason ?? (yahooRan ? "—" : "not_run"),
      watchlistKept: wl.watchlistKept ?? (yahooRan ? "no" : "not_run"),
      watchlistRank: wl.watchlistRank ?? "—",
      researchExpandedRank: rankInList(sym, researchPool) ?? "—",
      sentToYahooPossible: sentToYahoo,
      notes: notes.join("; ") || "—",
    });
  }

  console.log("\n=== TRACKED ETF PIPELINE (read-only) ===\n");
  printTable(tableRows);

  console.log("\n=== Détails master / research ===\n");
  for (const sym of TRACKED) {
    const m = masterBySym.get(sym);
    console.log(sym, {
      tags: m?.tags ?? [],
      sources: m?.sources ?? [],
      researchExpandedRank: rankInList(sym, researchPool),
      pinned: LEVERAGED_ETF_RESEARCH_PINNED.includes(sym),
      researchInPool: researchPool.includes(sym),
    });
  }

  if (yahooRan) {
    console.log("\n=== Détails watchlist + scan (Yahoo) ===\n");
    for (const sym of TRACKED) {
      console.log(sym, { watchlist: watchlistAnalysis[sym], scan: scanAnalysis[sym] });
    }
  }

  console.log("\n[hint] Exemples:");
  console.log("  node scripts/debug_tracked_etfs_pipeline.mjs --expiration 2026-05-29");
  console.log("  node scripts/debug_tracked_etfs_pipeline.mjs --no-yahoo");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
