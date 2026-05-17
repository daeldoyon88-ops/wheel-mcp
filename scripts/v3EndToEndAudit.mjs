/**
 * Audit read-only « session V3 » watchlist → shortlist Yahoo → IBKR (optionnel) → Capital Combo.
 * Ne modifie aucune logique live : instancie localement watchlistBuilder + wheelScanner comme le serveur.
 *
 * Prérequis typiques (alignés dashboard) :
 *   YAHOO_LIQUIDITY_V3_SIMULATION=1 YAHOO_LIQUIDITY_V3_LIVE_SAFE=1
 *
 * IBKR (lecture seule via route serveur existante) :
 *   Serveur Node déjà lancé (ex. PORT=3001) + TWS / IB Gateway si tu veux des chiffres réels.
 *   Sinon l’audit indique la donnée manquante dans `missingData`.
 *
 * Usage :
 *   node scripts/v3EndToEndAudit.mjs
 *   node scripts/v3EndToEndAudit.mjs --expiration 2026-05-23 --no-ibkr
 *   node scripts/v3EndToEndAudit.mjs --port 3001 --ibkr-depth 40
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BACKEND_PORT, MAX_SCAN_TICKERS } from "../app/config/constants.js";
import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { isYahooFunnelDiagnosticsV1Enabled } from "../app/diagnostics/yahooFunnelDiagnosticsV1.js";
import {
  isYahooLiquidityV3LiveSafeEnabled,
  isYahooLiquidityV3SimulationEnabled,
  runYahooLiquidityV3Simulation,
  resolvedV3SimulationMaxAbsoluteSpread,
} from "../app/diagnostics/yahooLiquidityV3Simulation.js";
import { createWheelScanner } from "../app/scanners/wheelScanner.js";
import { createWatchlistBuilder } from "../app/watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../app/watchlist/watchlistCache.js";
import { createMarketService } from "../app/services/marketService.js";

import { buildPortfolioCombos, getFinalDisplayRecommendation } from "../wheel-dashboard/src/capitalComboPortfolio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/** Même défaut que `wheel-dashboard/src/dashboard.jsx` → `DEFAULT_BUILD_WATCHLIST_BODY`. */
const DEFAULT_BUILD_CRITERIA = {
  maxPrice: 200,
  minPrice: 10,
  minVolume: 1_000_000,
  maxContractCapital: 25_500,
  minMarketCapB: 5,
  requireLiquidOptions: true,
  requireWeeklyOptions: true,
  liquidityOtmProbePct: 5,
  categories: ["weekly", "core", "growth", "high_premium"],
  limit: 150,
};

function parseArgs(argv) {
  const out = {
    expiration: null,
    port: DEFAULT_BACKEND_PORT,
    skipIbkr: false,
    ibkrDepth: 40,
    capital: 25_500,
    maxCapitalPct: 95,
    maxPositions: 8,
    topN: 150,
    sort: "quality",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-ibkr") out.skipIbkr = true;
    else if (a === "--expiration" && argv[i + 1]) {
      out.expiration = String(argv[++i]).trim();
    } else if (a === "--port" && argv[i + 1]) {
      out.port = Number(argv[++i]) || DEFAULT_BACKEND_PORT;
    } else if (a === "--ibkr-depth" && argv[i + 1]) {
      out.ibkrDepth = Math.min(120, Math.max(10, Number(argv[++i]) || 40));
    } else if (a === "--capital" && argv[i + 1]) {
      out.capital = Number(argv[++i]) || out.capital;
    } else if (a === "--max-capital-pct" && argv[i + 1]) {
      out.maxCapitalPct = Number(argv[++i]) || out.maxCapitalPct;
    } else if (a === "--max-positions" && argv[i + 1]) {
      out.maxPositions = Number(argv[++i]) || out.maxPositions;
    } else if (a === "--topN" && argv[i + 1]) {
      out.topN = Number(argv[++i]) || out.topN;
    }
  }
  return out;
}

function nextFridayYmd() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 5) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function auditStamp() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
}

function logLine(msg) {
  console.warn(msg);
}

/**
 * @param {Record<string, unknown>} item — ligne `scanTicker` / entrée `shortlist` brute backend
 * @returns {Record<string, unknown>}
 */
function mapScanItemToComboCandidate(item) {
  const spot = Number(item.currentPrice) || 0;
  /** @param {Record<string, unknown> | null | undefined} leg */
  const mapLeg = (leg) => {
    if (!leg || typeof leg !== "object") return null;
    const wy = Number(leg.weeklyYield);
    const weeklyYieldPct = Number.isFinite(wy) && wy > 0 ? wy * 100 : null;
    const strike = Number(leg.strike);
    const dist =
      spot > 0 && Number.isFinite(strike)
        ? ((strike - spot) / spot) * 100
        : Number(leg.distancePct) || 0;
    const popRaw = leg.popEstimate;
    return {
      strike: leg.strike,
      bid: leg.bid,
      ask: leg.ask,
      premium: leg.premium,
      conservativePremium: leg.conservativePremium,
      premiumUsed: leg.premiumUsed ?? leg.conservativePremium ?? leg.bid,
      primeUsed: leg.primeUsed,
      mid: leg.premium ?? leg.mid,
      liquidity: leg.liquidity,
      weeklyYield: weeklyYieldPct,
      periodYield: weeklyYieldPct,
      distancePct: dist,
      popEstimate: popRaw,
      popProfitEstimated: popRaw,
      impliedVolatility: leg.impliedVolatility,
    };
  };

  const safeStrike = mapLeg(item.safeStrike);
  const aggressiveStrike = mapLeg(item.aggressiveStrike);
  const rec = getFinalDisplayRecommendation({
    safeStrike,
    aggressiveStrike,
    safeGrade: item.safeGrade ?? null,
    aggressiveGrade: item.aggressiveGrade ?? null,
    recommendationDiagnostics: item.recommendationDiagnostics ?? null,
  });

  return {
    ticker: String(item.symbol || "").trim().toUpperCase(),
    symbol: item.symbol,
    currentPrice: spot,
    safeStrike,
    aggressiveStrike,
    finalDisplayMode: rec.finalDisplayMode,
    finalDisplayGrade: rec.finalDisplayGrade,
    qualityScore: item.qualityScore ?? null,
    finalScore: item.finalScore ?? null,
    executionScore: item.executionScore ?? null,
    distanceScore: item.distanceScore ?? null,
    dteDays: item.dteDays ?? null,
    passesFilter: item.passesFilter === true,
    optionsSource: item.liquiditySource ? "yahoo_strict" : "Yahoo fallback",
  };
}

/**
 * @param {unknown[]} combos — sortie `buildPortfolioCombos`
 * @param {Set<string>} v3Symbols
 */
function analyzeCombosForV3(combos, v3Symbols) {
  /** @type {Record<string, unknown>} */
  const byLabel = {};
  let usedV3Total = 0;
  const allPickedV3 = new Set();

  for (const combo of combos || []) {
    const label = String(combo?.label || "").trim().toUpperCase();
    const picks = Array.isArray(combo?.picks) ? combo.picks : [];
    const v3Picks = picks.filter((p) => v3Symbols.has(String(p?.ticker || "").trim().toUpperCase()));
    for (const p of v3Picks) {
      allPickedV3.add(String(p.ticker).trim().toUpperCase());
    }
    usedV3Total += v3Picks.length;

    const positions = picks.length;
    const v3InBook = v3Picks.length;
    byLabel[label] = {
      positions,
      v3SymbolsInBook: v3Picks.map((p) => p.ticker),
      v3LineCount: v3InBook,
      capitalUsed: combo.totalCapital ?? null,
      freeCapital: combo.freeCapital ?? null,
      avgWeeklyReturn: combo.avgWeeklyReturn ?? null,
      diversificationHealthScore: combo.diversificationHealthScore ?? null,
      largestTickerCapitalPct: combo.largestTickerCapitalPct ?? null,
      largestThemeCapitalPct: combo.largestThemeCapitalPct ?? null,
      totalPremiumCollected: combo.totalPremiumCollected ?? null,
    };
  }

  return { byLabel, usedV3Total, distinctV3UsedInAnyCombo: [...allPickedV3].sort() };
}

async function tryFetchIbkrShadow(baseUrl, body) {
  const url = `${baseUrl.replace(/\/$/, "")}/ibkr/shadow/scan`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { httpOk: res.ok, status: res.status, json };
  } catch (e) {
    return { httpOk: false, error: String(e?.message || e), json: null };
  }
}

async function run() {
  const args = parseArgs(process.argv);
  const expiration = args.expiration || nextFridayYmd();

  const v3SimOn = isYahooLiquidityV3SimulationEnabled();
  const v3LiveOn = isYahooLiquidityV3LiveSafeEnabled();
  const funnelOn = isYahooFunnelDiagnosticsV1Enabled();

  const savedLive = process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
  const savedSim = process.env.YAHOO_LIQUIDITY_V3_SIMULATION;

  const provider = createMarketDataProvider();
  const marketService = createMarketService(provider);
  const watchlistCache = createWatchlistCache();
  const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });
  const wheelScanner = createWheelScanner(marketService);

  /** @type {string[]} */
  const missingData = [];

  if (!v3SimOn || !v3LiveOn) {
    missingData.push(
      "Flags V3 : pour une session « telle que prod », activer YAHOO_LIQUIDITY_V3_SIMULATION=1 (YAHOO_LIQUIDITY_V3_LIVE_SAFE est ON par défaut — désactiver avec =0).",
    );
  }
  if (!funnelOn) {
    missingData.push(
      "YAHOO_FUNNEL_DIAGNOSTICS=1 absent — pas de scanFunnelDiagnosticsV1 (pré-IBKR bucket / flags). Le scan fonctionne ; métriques pré-IBKR partielles.",
    );
  }

  logLine(
    `[v3-e2e] start expiration=${expiration} v3Sim=${v3SimOn ? 1 : 0} v3Live=${v3LiveOn ? 1 : 0} funnel=${funnelOn ? 1 : 0}`,
  );

  // ─── Baseline watchlist (V3 désactivé temporairement, même critères) ───
  process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE = "0";
  process.env.YAHOO_LIQUIDITY_V3_SIMULATION = "0";
  const baselineWl = await watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD_CRITERIA });
  const baselineSymbols = new Set((baselineWl.watchlist || []).map((s) => String(s).trim().toUpperCase()));

  // ─── Session V3 (restaurer l’env d’origine) ───
  if (savedLive != null) process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE = savedLive;
  else delete process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
  if (savedSim != null) process.env.YAHOO_LIQUIDITY_V3_SIMULATION = savedSim;
  else delete process.env.YAHOO_LIQUIDITY_V3_SIMULATION;

  const v3Wl = await watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD_CRITERIA });
  const watchlistArr = v3Wl.watchlist || [];
  const v3Meta = v3Wl.yahooLiquidityV3LiveSafe || {};
  const recoveredArr = Array.isArray(v3Meta.recoveredSymbols) ? v3Meta.recoveredSymbols : [];
  const v3RecoveredSet = new Set(recoveredArr.map((s) => String(s).trim().toUpperCase()));

  /** @type {Record<string, unknown> | null} */
  let v3SimulationPayload = null;
  if (v3Wl.watchlistDiagnosticsV1 && isYahooLiquidityV3SimulationEnabled()) {
    try {
      v3SimulationPayload = runYahooLiquidityV3Simulation(v3Wl.watchlistDiagnosticsV1, {
        stats: v3Wl.stats ?? null,
        maxAbsoluteSpreadV3: resolvedV3SimulationMaxAbsoluteSpread(),
      });
    } catch (e) {
      missingData.push(`runYahooLiquidityV3Simulation a échoué : ${e?.message || e}`);
    }
  } else if (!v3Wl.watchlistDiagnosticsV1) {
    missingData.push("watchlistDiagnosticsV1 absent — impossible de rejouer la simulation V3 read-only côté rapport.");
  }

  const universeTotal =
    v3Wl.watchlistDiagnosticsV1?.universeTotalCount ?? v3Wl.stats?.sourceCount ?? null;

  const excluded = v3Meta.excludedSummary || {};

  const watchlistImpact = {
    universeTotalCount: universeTotal,
    watchlistTotal: watchlistArr.length,
    v3LiveEnabled: v3Meta.enabled === true,
    v3RecoveredCount: Number(v3Meta.recoveredCount) || 0,
    v3HighCount: Array.isArray(v3Meta.highQualityRecovered) ? v3Meta.highQualityRecovered.length : 0,
    v3MediumCount: Array.isArray(v3Meta.mediumQualityRecovered) ? v3Meta.mediumQualityRecovered.length : 0,
    v3RecoveredSymbols: [...v3RecoveredSet].sort(),
    excludedWeak: excluded.weak ?? null,
    excludedNoRealBidAsk: excluded.noRealBidAsk ?? null,
    excludedOtmProbe: excluded.otmProbe ?? null,
    excludedSpreadPctFailed: excluded.spreadPctFailed ?? null,
    excludedPatternNotPure: excluded.patternNotPure ?? null,
    excludedOtherLiquidFailures: excluded.otherLiquidFailures ?? null,
    excludedOverCap: excluded.overCap ?? null,
    baselineWatchlistCount: (baselineWl.watchlist || []).length,
    symbolsAddedVsBaseline: [...v3RecoveredSet].filter((s) => !baselineSymbols.has(s)).sort(),
    note:
      "Comparaison baseline : second build avec YAHOO_LIQUIDITY_V3_* désactivés, mêmes critères JSON — uniquement pour le diff de watchlist.",
  };

  const tickersForScan = watchlistArr
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, MAX_SCAN_TICKERS);

  const scanResult = await wheelScanner.scanShortlist({
    expiration,
    tickers: tickersForScan,
    topN: args.topN,
    sort: args.sort,
  });

  if (scanResult.status !== 200 || !scanResult.payload?.ok) {
    missingData.push(`scan_shortlist a échoué status=${scanResult.status} — shortlist/combo/IBKR incomplets.`);
  }

  const payload = scanResult.payload || {};
  const shortlistFull = Array.isArray(payload.shortlist) ? payload.shortlist : [];

  /** Rang Yahoo pleine liste triée */
  const shortlistRankMap = new Map();
  for (let i = 0; i < shortlistFull.length; i++) {
    shortlistRankMap.set(String(shortlistFull[i]?.symbol || "").trim().toUpperCase(), i + 1);
  }

  const v3InShortlist = shortlistFull
    .map((it) => String(it?.symbol || "").trim().toUpperCase())
    .filter((s) => v3RecoveredSet.has(s));

  const shortlistRows = shortlistFull.map((it) => {
    const sym = String(it?.symbol || "").trim().toUpperCase();
    const inV3 = v3RecoveredSet.has(sym);
    const diag = payload.scanFunnelDiagnosticsV1?.passedCandidates?.find((r) => r.symbol === sym) ?? null;
    return {
      symbol: sym,
      v3Recovered: inV3,
      v3Bucket: inV3 ? (v3Wl.watchlistDiagnosticsV1?.fullRankedCandidates || []).find((c) => c.symbol === sym)?.v3Bucket ?? null : null,
      yahooRankInShortlistSorted: shortlistRankMap.get(sym) ?? null,
      passesFilter: it.passesFilter === true,
      qualityScore: it.qualityScore ?? null,
      finalScore: it.finalScore ?? null,
      safeAnnualizedYieldPct: it.safeStrike?.annualizedYield != null ? Number(it.safeStrike.annualizedYield) * 100 : null,
      liquiditySource: it.liquiditySource ?? null,
      noYahooLiquidity: it.noYahooLiquidity === true,
      preIbkrConfidenceScore: diag?.preIbkrConfidenceScore ?? null,
      preIbkrConfidenceBucket: diag?.preIbkrConfidenceBucket ?? null,
    };
  });

  const v3NotInReturnedShortlistSlice = [...v3RecoveredSet].filter((s) => !shortlistRankMap.has(s)).sort();

  const shortlistImpact = {
    scanInputCount: tickersForScan.length,
    shortlistKept: payload.kept ?? shortlistFull.length,
    shortlistReturnedSlice: shortlistFull.length,
    note:
      "La liste `payload.shortlist` est tronquée par le backend (topN + challengers). Les rangs Yahoo sont dans ce segment seulement.",
    v3SymbolCountInShortlist: v3InShortlist.length,
    v3SymbolsInShortlist: [...new Set(v3InShortlist)].sort(),
    v3Rows: shortlistRows.filter((r) => r.v3Recovered),
    v3RecoveredNotInReturnedSlice: v3NotInReturnedShortlistSlice,
    scanFunnelAvailable: payload.scanFunnelDiagnosticsV1 != null,
  };

  // ─── Capital Combo (Yahoo shortlist uniquement, pas de merge IBKR) ───
  const comboCandidates = shortlistFull.filter((it) => it.passesFilter === true).map(mapScanItemToComboCandidate);
  const comboHolder = {};
  const combos = buildPortfolioCombos(
    comboCandidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
    process.env.CAPITAL_COMBO_TRACE_DEBUG === "1" ? { comboTracePayloadHolder: comboHolder } : {},
  );
  if (
    process.env.CAPITAL_COMBO_TRACE_DEBUG === "1" &&
    comboHolder.capitalComboAllocationTraceV1 != null
  ) {
    const { writeCapitalComboAllocationTraceFile } = await import(
      "../app/diagnostics/capitalComboAllocationTraceWriter.mjs"
    );
    const p = writeCapitalComboAllocationTraceFile(comboHolder.capitalComboAllocationTraceV1);
    logLine(`[combo-trace] wrote ${p}`);
  }

  const comboAnalysis = analyzeCombosForV3(combos, v3RecoveredSet);

  const ibkrImpact = {
    note: "IBKR via POST /ibkr/shadow/scan sur le serveur local — read-only, inchangé dans ce script.",
    serverBaseUrl: `http://127.0.0.1:${args.port}`,
    skipIbkr: args.skipIbkr,
    v3SymbolsInWatchlist: v3RecoveredSet.size,
    ibkrTickersPlanned: [],
    v3SentToIbkr: 0,
    v3IbkrPassed: 0,
    v3IbkrRejected: 0,
    baselineIbkrDeltaNote:
      "Sans V3 live, les symboles « recovered » ne seraient typiquement pas dans la watchlist : pas envoyés à IBKR en baseline.",
    ibkrPassedV3: [],
    ibkrRejectedV3: [],
    rejectionReasonsV3: {},
    v3IbkrNoOutcomeSymbols: [],
    http: null,
  };

  if (!args.skipIbkr) {
    const depth = Math.min(args.ibkrDepth, tickersForScan.length, 120);
    const ibkrTickers = tickersForScan.slice(0, depth);
    ibkrImpact.ibkrTickersPlanned = ibkrTickers;
    ibkrImpact.v3SentToIbkr = ibkrTickers.filter((t) => v3RecoveredSet.has(t)).length;

    const ibkrBody = {
      tickers: ibkrTickers,
      expiration,
      topN: depth,
      maxTickers: depth,
      sort: "quality",
    };
    const ibkrRes = await tryFetchIbkrShadow(ibkrImpact.serverBaseUrl, ibkrBody);
    ibkrImpact.http = {
      httpOk: ibkrRes.httpOk,
      status: ibkrRes.status,
      error: ibkrRes.error ?? null,
    };

    if (!ibkrRes.httpOk || !ibkrRes.json || ibkrRes.json.ok !== true) {
      missingData.push(
        "IBKR shadow indisponible (serveur arrêté, TWS fermé, ou endpoint non local). Voir `ibkrImpact.http`.",
      );
    } else {
      const kept = Array.isArray(ibkrRes.json.shortlist) ? ibkrRes.json.shortlist : [];
      const rej = Array.isArray(ibkrRes.json.rejected) ? ibkrRes.json.rejected : [];
      const keptSet = new Set(
        kept.map((r) => String(r?.symbol || r?.ticker || "").trim().toUpperCase()).filter(Boolean),
      );

      for (const t of v3RecoveredSet) {
        if (!ibkrTickers.includes(t)) continue;
        if (keptSet.has(t)) {
          ibkrImpact.v3IbkrPassed += 1;
          ibkrImpact.ibkrPassedV3.push(t);
        }
      }
      ibkrImpact.ibkrPassedV3.sort();

      const rejBySym = new Map();
      for (const row of rej) {
        const sym = String(row?.symbol || "").trim().toUpperCase();
        if (!sym) continue;
        if (!rejBySym.has(sym)) rejBySym.set(sym, String(row.reason ?? row.status ?? "unknown"));
      }
      const v3RejectedSyms = new Set();
      for (const t of v3RecoveredSet) {
        if (!ibkrTickers.includes(t)) continue;
        if (keptSet.has(t)) continue;
        if (rejBySym.has(t)) v3RejectedSyms.add(t);
      }
      ibkrImpact.v3IbkrRejected = v3RejectedSyms.size;
      ibkrImpact.ibkrRejectedV3 = [...v3RejectedSyms].sort().map((symbol) => ({
        symbol,
        reason: rejBySym.get(symbol) ?? "unknown",
      }));
      for (const { symbol, reason } of ibkrImpact.ibkrRejectedV3) {
        ibkrImpact.rejectionReasonsV3[reason] = (ibkrImpact.rejectionReasonsV3[reason] || 0) + 1;
      }
      const v3NoOutcome = [];
      for (const t of v3RecoveredSet) {
        if (!ibkrTickers.includes(t)) continue;
        if (keptSet.has(t)) continue;
        if (rejBySym.has(t)) continue;
        v3NoOutcome.push(t);
      }
      ibkrImpact.v3IbkrNoOutcomeSymbols = v3NoOutcome.sort();
    }
  } else {
    missingData.push("IBKR — audit lancé avec --no-ibkr ; pas de mesure réelle TWS.");
  }

  if (!args.skipIbkr && Array.isArray(ibkrImpact.v3IbkrNoOutcomeSymbols) && ibkrImpact.v3IbkrNoOutcomeSymbols.length > 0) {
    missingData.push(
      `IBKR : symboles V3 sans kept/rejected explicite dans la réponse — ${ibkrImpact.v3IbkrNoOutcomeSymbols.join(", ")}`,
    );
  }

  const baselinePreIbkr = {
    v3SymbolsThatWouldBeMissingFromWatchlist: [...v3RecoveredSet].filter((s) => !baselineSymbols.has(s)).length,
  };

  const bestV3Symbols = [];
  const noisyV3Symbols = [];

  for (const sym of [...v3RecoveredSet].sort()) {
    const row = shortlistRows.find((r) => r.symbol === sym);
    const inCombo = comboAnalysis.distinctV3UsedInAnyCombo.includes(sym);
    const ibkrPass = ibkrImpact.ibkrPassedV3.includes(sym);
    const ibkrFail =
      !args.skipIbkr && ibkrImpact.ibkrRejectedV3.some((r) => r.symbol === sym);
    const bucket = row?.preIbkrConfidenceBucket;
    const noisy =
      ibkrFail ||
      (row &&
        (row.noYahooLiquidity === true ||
          row.passesFilter === false ||
          bucket === "likely_waste" ||
          bucket === "weak"));
    const useful = inCombo || ibkrPass || (row?.passesFilter === true && !ibkrFail);

    if (useful && !noisy) bestV3Symbols.push(sym);
    else if (noisy) noisyV3Symbols.push(sym);
  }

  /** @type {string[]} */
  const recommendations = [];
  if (v3InShortlist.length === 0 && v3RecoveredSet.size > 0) {
    recommendations.push(
      "Les titres V3 récupérés n’apparaissent dans aucune ligne Yahoo shortlist triée : vérifie limite scan / rejets Wheel (expected move, prime, etc.).",
    );
  }
  if (comboAnalysis.usedV3Total === 0 && v3RecoveredSet.size > 0) {
    recommendations.push(
      "Aucun ticker V3 dans les livres Capital Combo (moteur dashboard) sur cette shortlist : impact combo nul pour cette session.",
    );
  }
  if (!args.skipIbkr && ibkrImpact.v3IbkrRejected > ibkrImpact.v3IbkrPassed && ibkrImpact.v3IbkrPassed + ibkrImpact.v3IbkrRejected > 0) {
    recommendations.push(
      "Plus de V3 rejetés que acceptés côté IBKR sur l’échantillon : risque de « bruit » IBKR pour cette cohorte.",
    );
  }

  let verdict =
    "NEUTRE — pas assez de signal (données manquantes ou V3 sans effet mesurable sur shortlist/combo/IBKR).";
  if (missingData.length === 0 || !missingData.some((m) => m.includes("scan_shortlist"))) {
    if (comboAnalysis.usedV3Total > 0 || (!args.skipIbkr && ibkrImpact.v3IbkrPassed > 0)) {
      verdict = "POSITIF — V3 contribue au combo Yahoo et/ou passe IBKR sur l’échantillon ; garder actif sous surveillance.";
    } else if (v3RecoveredSet.size > 0 && v3InShortlist.length > 0 && comboAnalysis.usedV3Total === 0) {
      verdict = "MIXTE — V3 entre dans Yahoo mais pas dans les combos (filtres rendement/caps) ; utile pour inspection, pas pour capital combo.";
    } else if (noisyV3Symbols.length > bestV3Symbols.length && v3RecoveredSet.size > 0) {
      verdict = "FRAGILE — plusieurs V3 classés bruit (liquidité Yahoo douteuse / pré-IBKR faible) ; considérer surveillance ou ajustement futur des critères (hors scope de ce script).";
    }
  }

  const out = {
    exportedAt: new Date().toISOString(),
    summary: {
      expiration,
      verdict,
      watchlistTotal: watchlistArr.length,
      v3Recovered: v3RecoveredSet.size,
      shortlistV3Count: v3InShortlist.length,
      ibkrV3Passed: ibkrImpact.v3IbkrPassed,
      ibkrV3Rejected: ibkrImpact.v3IbkrRejected,
      comboUsedV3Lines: comboAnalysis.usedV3Total,
      env: {
        YAHOO_LIQUIDITY_V3_SIMULATION: savedSim ?? process.env.YAHOO_LIQUIDITY_V3_SIMULATION ?? null,
        YAHOO_LIQUIDITY_V3_LIVE_SAFE: savedLive ?? process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE ?? null,
        YAHOO_FUNNEL_DIAGNOSTICS: process.env.YAHOO_FUNNEL_DIAGNOSTICS ?? null,
        YAHOO_LIQUIDITY_V3_MAX_ABSOLUTE_SPREAD: process.env.YAHOO_LIQUIDITY_V3_MAX_ABSOLUTE_SPREAD ?? null,
      },
    },
    watchlistImpact,
    shortlistImpact,
    ibkrImpact: { ...ibkrImpact, baselineComparison: baselinePreIbkr },
    capitalComboImpact: {
      capital: args.capital,
      maxCapitalPct: args.maxCapitalPct,
      maxPositions: args.maxPositions,
      eligibleCandidateCount: comboCandidates.length,
      comboModesReturned: combos.length,
      v3DistinctUsedInCombos: comboAnalysis.distinctV3UsedInAnyCombo,
      usedV3LineCountAcrossModes: comboAnalysis.usedV3Total,
      note:
        "Moteur identique au dashboard (`buildPortfolioCombos`) : candidats = shortlist Yahoo avec passesFilter true dans le segment retourné ; pas de merge IBKR ; ibkrRejectedSymbols vide.",
    },
    bucketImpact: {
      safe: comboAnalysis.byLabel.SAFE ?? null,
      balanced: comboAnalysis.byLabel.BALANCED ?? null,
      aggressive: comboAnalysis.byLabel.AGGRESSIVE ?? null,
    },
    v3SimulationReadOnly: v3SimulationPayload
      ? {
          version: v3SimulationPayload.version ?? null,
          simulatedRecoveredCount: v3SimulationPayload.simulated?.recoveredCount ?? null,
          simulatedHigh: Array.isArray(v3SimulationPayload.simulated?.highQualityRecovered)
            ? v3SimulationPayload.simulated.highQualityRecovered.length
            : null,
          simulatedMedium: Array.isArray(v3SimulationPayload.simulated?.mediumQualityRecovered)
            ? v3SimulationPayload.simulated.mediumQualityRecovered.length
            : null,
        }
      : null,
    bestV3Symbols: [...new Set(bestV3Symbols)].sort(),
    noisyV3Symbols: [...new Set(noisyV3Symbols)].sort(),
    missingData,
    recommendations,
  };

  const debugDir = join(REPO_ROOT, "debug");
  mkdirSync(debugDir, { recursive: true });
  const filename = `v3-end-to-end-audit-${auditStamp()}.json`;
  const outPath = join(debugDir, filename);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  // ─── Console résumé demandé ───
  logLine(`[v3-e2e] watchlist total=${watchlistArr.length} v3Recovered=${v3RecoveredSet.size}`);
  logLine(`[v3-e2e] shortlist v3Count=${v3InShortlist.length}`);
  logLine(`[v3-e2e] ibkr v3Passed=${ibkrImpact.v3IbkrPassed} v3Rejected=${ibkrImpact.v3IbkrRejected}`);
  logLine(`[v3-e2e] combo usedV3=${comboAnalysis.usedV3Total}`);
  const sSafe = comboAnalysis.byLabel.SAFE;
  const sBal = comboAnalysis.byLabel.BALANCED;
  const sAgg = comboAnalysis.byLabel.AGGRESSIVE;
  logLine(
    `[v3-e2e] safe impact=v3lines=${sSafe?.v3LineCount ?? "—"} capUsed=${sSafe?.capitalUsed ?? "—"} avgYld=${sSafe?.avgWeeklyReturn != null ? sSafe.avgWeeklyReturn.toFixed(4) : "—"} div=${sSafe?.diversificationHealthScore != null ? sSafe.diversificationHealthScore.toFixed(3) : "—"}`,
  );
  logLine(
    `[v3-e2e] balanced impact=v3lines=${sBal?.v3LineCount ?? "—"} capUsed=${sBal?.capitalUsed ?? "—"} avgYld=${sBal?.avgWeeklyReturn != null ? sBal.avgWeeklyReturn.toFixed(4) : "—"} div=${sBal?.diversificationHealthScore != null ? sBal.diversificationHealthScore.toFixed(3) : "—"}`,
  );
  logLine(
    `[v3-e2e] aggressive impact=v3lines=${sAgg?.v3LineCount ?? "—"} capUsed=${sAgg?.capitalUsed ?? "—"} avgYld=${sAgg?.avgWeeklyReturn != null ? sAgg.avgWeeklyReturn.toFixed(4) : "—"} div=${sAgg?.diversificationHealthScore != null ? sAgg.diversificationHealthScore.toFixed(3) : "—"}`,
  );
  logLine(`[v3-e2e] verdict=${verdict}`);
  logLine(`[v3-e2e] wrote ${outPath}`);

  // restore env strictly
  if (savedLive != null) process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE = savedLive;
  else delete process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
  if (savedSim != null) process.env.YAHOO_LIQUIDITY_V3_SIMULATION = savedSim;
  else delete process.env.YAHOO_LIQUIDITY_V3_SIMULATION;
}

run().catch((e) => {
  console.error("[v3-e2e] fatal", e);
  process.exitCode = 1;
});
