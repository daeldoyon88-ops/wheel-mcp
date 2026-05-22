/**
 * Audit read-only : pourquoi seulement ~70 titres watchlist ?
 * Usage: node scripts/watchlist70Audit.mjs [--otm 0] [--expiration 2026-05-29] [--topN 250]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_SCAN_TICKERS } from "../app/config/constants.js";
import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { isYahooFunnelDiagnosticsV1Enabled } from "../app/diagnostics/yahooFunnelDiagnosticsV1.js";
import { isYahooLiquidityV3LiveSafeEnabled } from "../app/diagnostics/yahooLiquidityV3Simulation.js";
import { createWheelScanner } from "../app/scanners/wheelScanner.js";
import { createWatchlistBuilder } from "../app/watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../app/watchlist/watchlistCache.js";
import { createMarketService } from "../app/services/marketService.js";
import { loadMasterUniverse } from "../app/watchlist/universeLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const DEFAULT_BUILD = {
  maxPrice: 200,
  minPrice: 10,
  minVolume: 1_000_000,
  maxContractCapital: 25_500,
  minMarketCapB: 5,
  requireLiquidOptions: true,
  requireWeeklyOptions: true,
  liquidityOtmProbePct: 0,
  categories: ["weekly", "core", "growth", "high_premium"],
  limit: 150,
};

const IMPORTANT = [
  "TQQQ", "SOXL", "TECL", "UPRO", "APLD", "IONQ", "IREN", "RIOT",
  "HOOD", "AFRM", "SOFI", "INTC", "UBER", "HIMS", "OKLO", "CSCO",
];

function parseArgs(argv) {
  const out = { otm: 0, expiration: "2026-05-29", topN: 250, simulateOtms: [0, 1, 2, 3] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--otm" && argv[i + 1]) { out.otm = Number(argv[++i]); continue; }
    if (a === "--expiration" && argv[i + 1]) { out.expiration = String(argv[++i]); continue; }
    if (a === "--topN" && argv[i + 1]) { out.topN = Number(argv[++i]); continue; }
  }
  return out;
}

function topRejectReasons(rejectedByReason, n = 10) {
  return Object.entries(rejectedByReason || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

function analyzeImportant(wl, rejected, fullRanked) {
  const keptSet = new Set((wl.watchlist || []).map((s) => String(s).toUpperCase()));
  const rejMap = new Map((rejected || []).map((r) => [String(r.symbol).toUpperCase(), r]));
  const rankMap = new Map((fullRanked || []).map((r, i) => [String(r.symbol).toUpperCase(), i + 1]));
  const out = {};
  for (const sym of IMPORTANT) {
    if (keptSet.has(sym)) {
      const rank = rankMap.get(sym) ?? null;
      const row = (fullRanked || []).find((r) => r.symbol === sym);
      out[sym] = { kept: true, rank, watchlistScore: row?.watchlistScore ?? null, v3Recovered: row?.recoveredByYahooLiquidityV3LiveSafe ?? false };
    } else {
      const rej = rejMap.get(sym);
      out[sym] = { kept: false, reason: rej?.reason ?? "not_in_universe_or_error", detail: rej?.detail ?? null };
    }
  }
  return out;
}

function computeFunnelFromBuild(wl) {
  const stats = wl.stats || {};
  const d1 = wl.watchlistDiagnosticsV1 || {};
  const rejected = wl.rejected || [];
  const reasons = stats.rejectedByReason || {};

  const afterPrice = (d1.universeAfterCryptoBlockCount ?? stats.sourceCount ?? 0) - (
    (reasons.price_unavailable ?? 0) +
    (reasons.above_max_price ?? 0) +
    (reasons.below_min_price ?? 0)
  );
  const afterVolume = afterPrice - ((reasons.volume_unavailable ?? 0) + (reasons.below_min_volume ?? 0));
  const afterCapital = afterVolume - (reasons.contract_capital_above_max ?? 0);
  const afterMcap = afterCapital - (reasons.market_cap_below_min ?? 0);
  const afterWeekly = afterMcap - ((reasons.expirations_unavailable ?? 0) + (reasons.no_weekly_options ?? 0));
  const afterAtmLiquidity = afterWeekly - (reasons.liquid_options_failed ?? 0);
  const afterOtm = afterAtmLiquidity - (reasons.liquid_options_otm_probe_failed ?? 0);

  return {
    universeTotal: d1.universeTotalCount ?? null,
    afterCategory: d1.universeAfterCategoryCount ?? null,
    afterCryptoBlock: d1.universeAfterCryptoBlockCount ?? stats.sourceCount ?? null,
    afterPrice,
    afterVolume,
    afterCapital,
    afterMcap,
    afterWeeklyOptions: afterWeekly,
    afterAtmLiquidity,
    afterOtmProbe: afterOtm,
    retainedAfterFilters: stats.retainedAfterFiltersCount ?? null,
    finalKept: stats.keptCount ?? (wl.watchlist || []).length,
    truncated: stats.truncated ?? 0,
    limitApplied: stats.limitApplied ?? null,
    v3Recovered: wl.yahooLiquidityV3LiveSafe?.recoveredCount ?? 0,
  };
}

async function buildWithOtm(watchlistBuilder, otmPct) {
  return watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD, liquidityOtmProbePct: otmPct });
}

async function main() {
  const args = parseArgs(process.argv);
  process.env.YAHOO_FUNNEL_DIAGNOSTICS = process.env.YAHOO_FUNNEL_DIAGNOSTICS ?? "1";

  const provider = createMarketDataProvider();
  const marketService = createMarketService(provider);
  const cache = createWatchlistCache();
  const watchlistBuilder = createWatchlistBuilder({ marketService, cache, concurrency: 6 });
  const wheelScanner = createWheelScanner(marketService);

  const masterAll = loadMasterUniverse({ categories: [] }) || [];
  const masterEnabled = masterAll.filter((r) => r.enabled);

  console.log("[AUDIT] env", {
    v3Live: isYahooLiquidityV3LiveSafeEnabled(),
    funnel: isYahooFunnelDiagnosticsV1Enabled(),
    masterTotal: masterAll.length,
    masterEnabled: masterEnabled.length,
  });

  const otmSim = {};
  for (const pct of args.simulateOtms) {
    const wl = await buildWithOtm(watchlistBuilder, pct);
    otmSim[pct] = {
      kept: (wl.watchlist || []).length,
      retained: wl.stats?.retainedAfterFiltersCount ?? null,
      rejected: wl.stats?.rejectedCount ?? null,
      v3Recovered: wl.yahooLiquidityV3LiveSafe?.recoveredCount ?? 0,
      topRejects: topRejectReasons(wl.stats?.rejectedByReason, 5),
    };
  }

  const wl = await buildWithOtm(watchlistBuilder, args.otm);
  const funnel = computeFunnelFromBuild(wl);
  const topRejects = topRejectReasons(wl.stats?.rejectedByReason, 12);
  const important = analyzeImportant(wl, wl.rejected, wl.watchlistDiagnosticsV1?.fullRankedCandidates);

  const top20 = (wl.watchlistDiagnosticsV1?.fullRankedCandidates || [])
    .filter((r) => r.keptBeforeLimit)
    .slice(0, 20)
    .map((r) => ({
      rank: r.rankBeforeLimit,
      symbol: r.symbol,
      score: r.watchlistScore,
      tier: r.tier,
      atmLiq: r.atmLiquidityScore,
      otmProbe: r.otmProbeScore,
      v3Recovered: r.recoveredByYahooLiquidityV3LiveSafe === true,
      quotePrice: r.quotePrice,
    }));

  const tickersForScan = (wl.watchlist || []).slice(0, MAX_SCAN_TICKERS);
  const scan = await wheelScanner.scanShortlist({
    expiration: args.expiration,
    tickers: tickersForScan,
    topN: args.topN,
    sort: "quality",
  });
  const scanPayload = scan.payload || {};

  const premiumSim = { "0.5pct": null, "0.4pct": null, "0.3pct": null };
  if (Array.isArray(scanPayload.rejected)) {
    const kept = scanPayload.shortlist?.length ?? 0;
    const premiumBelow = scanPayload.rejectionReasonCounts?.premium_below_target ?? 0;
    const yieldBelow = scanPayload.rejectionReasonCounts?.yield_below_target ?? 0;
    premiumSim["0.5pct"] = { kept, premiumBelow, yieldBelow, scanned: scanPayload.scanned };
    premiumSim.note = "Simulation 0.4/0.3% nécessite re-scan avec WEEKLY_TARGET_PCT modifié — non exécuté (read-only)";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    params: { ...args, buildCriteria: DEFAULT_BUILD },
    endpoint: {
      rebuildWatchlist: { method: "POST", url: "/universe/build", alias: "/build_watchlist" },
      refreshScan: { method: "POST", url: "/scan_shortlist" },
    },
    funnel,
    topRejectReasons: topRejects,
    otmSimulation: otmSim,
    v3LiveSafe: wl.yahooLiquidityV3LiveSafe,
    top20Retained: top20,
    importantTickers: important,
    scan: {
      expiration: args.expiration,
      watchlistSent: tickersForScan.length,
      scanned: scanPayload.scanned,
      kept: scanPayload.kept,
      returned: scanPayload.returned,
      requestedTopN: scanPayload.requestedTopN,
      rejectionReasonCounts: scanPayload.rejectionReasonCounts,
      stageRejectCounts: scanPayload.stageRejectCounts,
      expirationNotAvailable: (scanPayload.rejected || []).filter((r) => r.reason === "expiration_not_available").length,
    },
    premiumObjective: premiumSim,
    ibkrNote: "Rebuild watchlist = Yahoo/backend only. IBKR auto runs after scan_shortlist and does not shrink watchlist.",
    top250Effect: {
      watchlistBuildLimit: DEFAULT_BUILD.limit,
      topNAppliesTo: "scan_shortlist return slice only (not universe/build)",
      allWatchlistTickersScanned: tickersForScan.length,
      maxReturned: args.topN + (args.topN >= 30 ? 10 : 0),
    },
  };

  console.log("[WATCHLIST_FUNNEL]", funnel);
  console.log("[WATCHLIST_REJECT_REASONS]", topRejects);
  console.log("[WATCHLIST_IMPORTANT_TICKERS]", important);
  console.log("[OTM_SIMULATION]", otmSim);
  console.log("[SCAN_RESULT]", report.scan);

  const outDir = join(REPO_ROOT, "debug");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(outDir, `watchlist70-audit-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log("[AUDIT] written", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
