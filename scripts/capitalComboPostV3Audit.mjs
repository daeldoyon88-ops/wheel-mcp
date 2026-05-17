/**
 * Audit read-only Capital Combo post-V3 (BALANCED / AGGRESSIVE vs titres V3).
 * Pipeline aligné sur `v3EndToEndAudit.mjs` puis introspection capDiagnostics + garde-fous code.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_SCAN_TICKERS } from "../app/config/constants.js";
import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { isYahooFunnelDiagnosticsV1Enabled } from "../app/diagnostics/yahooFunnelDiagnosticsV1.js";
import {
  isYahooLiquidityV3LiveSafeEnabled,
  isYahooLiquidityV3SimulationEnabled,
} from "../app/diagnostics/yahooLiquidityV3Simulation.js";
import { createWheelScanner } from "../app/scanners/wheelScanner.js";
import { createWatchlistBuilder } from "../app/watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../app/watchlist/watchlistCache.js";
import { createMarketService } from "../app/services/marketService.js";

import {
  buildCapitalComboCandidate,
  buildPortfolioCombos,
  computeTickerQualityOverlay,
  getFinalDisplayRecommendation,
  getLegDistancePct,
  getLegSpreadPct,
  getLegYieldPct,
  gradeLeg,
} from "../wheel-dashboard/src/capitalComboPortfolio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

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

/** Miroir `QUALITY_HIGH_BETA_TICKERS` — capitalComboPortfolio.js */
const HIGH_BETA_GROWTH_CODE_TICKERS = new Set([
  "APLD",
  "OKLO",
  "IONQ",
  "SOUN",
  "RGTI",
  "RKLB",
  "HOOD",
  "AFRM",
  "PLTR",
]);

function auditStampLocal() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
}

function nextFridayYmd() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {
    refJsonPaths: [
      join(REPO_ROOT, "debug/v3-end-to-end-audit-2026-05-17T11-05-09.json"),
    ],
    focus: ["OKLO", "SHOP", "CRM", "MP", "APLD"],
    nearmissJson: join(REPO_ROOT, "debug/v3-nearmiss-impact-audit-2026-05-17T11-18-17.json"),
    aggressiveJson: join(REPO_ROOT, "debug/v3-aggressive-impact-audit-2026-05-17T11-10-55.json"),
    expirationOverride: null,
    capitalOverride: null,
    maxCapitalPctOverride: null,
    maxPositionsOverride: null,
    topN: 150,
    sort: "quality",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref-json" && argv[i + 1]) out.refJsonPaths.push(join(REPO_ROOT, String(argv[++i])));
    else if (a === "--focus") {
      out.focus = [];
      while (argv[i + 1] && !String(argv[i + 1]).startsWith("--")) {
        out.focus.push(String(argv[++i]).trim().toUpperCase());
      }
    } else if (a === "--nearmiss-json" && argv[i + 1]) out.nearmissJson = join(REPO_ROOT, String(argv[++i]));
    else if (a === "--expiration" && argv[i + 1]) out.expirationOverride = String(argv[++i]).trim();
    else if (a === "--capital" && argv[i + 1]) out.capitalOverride = Number(argv[++i]);
    else if (a === "--max-capital-pct" && argv[i + 1]) out.maxCapitalPctOverride = Number(argv[++i]);
    else if (a === "--max-positions" && argv[i + 1]) out.maxPositionsOverride = Number(argv[++i]);
    else if (a === "--topN" && argv[i + 1]) out.topN = Number(argv[++i]) || out.topN;
  }
  return out;
}

function safeReadJson(absPath) {
  if (!absPath || !existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

function mapScanItemToComboCandidate(item) {
  const spot = Number(item.currentPrice) || 0;
  const mapLeg = (leg) => {
    if (!leg || typeof leg !== "object") return null;
    const wy = Number(leg.weeklyYield);
    const weeklyYieldPct = Number.isFinite(wy) && wy > 0 ? wy * 100 : null;
    const strike = Number(leg.strike);
    const dist =
      spot > 0 && Number.isFinite(strike) ? ((strike - spot) / spot) * 100 : Number(leg.distancePct) || 0;
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

  let proExec = item.proExecutionScore != null ? Number(item.proExecutionScore) : null;
  if (!Number.isFinite(proExec)) {
    const ex = Number(item.executionScore);
    if (Number.isFinite(ex)) proExec = ex;
    else proExec = null;
  }

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
    proExecutionScore: proExec,
    passesFilter: item.passesFilter === true,
    optionsSource: item.liquiditySource ? "yahoo_strict" : "Yahoo fallback",
    earningsDaysUntil: item.earningsDaysUntil ?? null,
    hasEarningsBeforeExpiration:
      item.hasEarningsBeforeExpiration ?? item.hasUpcomingEarningsBeforeExpiration ?? false,
  };
}

/** Snapshot minimal pour JSON. */
function pruneEnriched(enriched) {
  return {
    ticker: enriched.ticker,
    passesBackend: enriched.passesFilter,
    capitalPerContract: enriched.capitalPerContract,
    _hasSafeLegValid: enriched._hasSafeLegValid,
    _hasAggLegValid: enriched._hasAggLegValid,
    _safeYieldPct: enriched._safeYieldPct,
    _aggYieldPct: enriched._aggYieldPct,
    finalDisplayGrade: enriched.finalDisplayGrade,
    finalDisplayMode: enriched.finalDisplayMode,
  };
}

/** Garde-fous « scoredPool avant knapsack » alignés capitalComboPortfolio `makeCombo` (AGGRESSIVE / BALANCED patch inst.). */
function explainUpstreamFailures(scItem, usableCapital, modeLabel) {
  const issues = [];
  const sym = String(scItem.symbol || "").trim().toUpperCase();

  if (!scItem.passesFilter) {
    issues.push({
      gate: "backend_passesFilter",
      ok: false,
      detail: "Scanner : passesFilter=false — absent du pool `comboCandidates`.",
    });
    return { symbol: sym, modeLabel, issues, okForScoredPool: false };
  }

  const c = mapScanItemToComboCandidate(scItem);
  const enriched = buildCapitalComboCandidate(c, usableCapital);

  if (!enriched._isCapitalComboEligible) {
    issues.push({
      gate: "_isCapitalComboEligible",
      ok: false,
      detail:
        enriched._capitalComboExclusionReasons?.length
          ? enriched._capitalComboExclusionReasons.join("; ")
          : "crypto/meta bloquant ou aucune jambe valide CSP",
    });
    return { symbol: sym, modeLabel, issues, enrichedSnapshot: pruneEnriched(enriched), okForScoredPool: false };
  }

  const safeY = enriched._safeYieldPct;
  const aggY = enriched._aggYieldPct;

  if (modeLabel === "AGGRESSIVE") {
    if (!enriched._hasAggLegValid) {
      issues.push({ gate: "agg_leg_invalid", ok: false, detail: `_hasAggLegValid=${false}` });
      return { symbol: sym, modeLabel, issues, enrichedSnapshot: pruneEnriched(enriched), okForScoredPool: false };
    }
    const y = enriched._aggYieldPct;
    const sp = enriched._aggSpreadPct;
    const dist = enriched._aggDistancePct;
    const pop = enriched._aggPopPct;
    const derivedAggGrade = gradeLeg({
      spreadPct: sp,
      weeklyYieldPct: y,
      popDecimal: enriched._aggLeg?.popProfitEstimated ?? enriched._aggLeg?.popEstimate,
    });
    let grade =
      enriched._aggGrade ||
      (derivedAggGrade !== "REJECT" ? derivedAggGrade : null) ||
      String(enriched.aggressiveGrade || "").toUpperCase() ||
      null;

    const watchOk =
      pop != null &&
      pop >= 85 &&
      (sp == null || sp <= 20) &&
      y != null &&
      y >= 0.90 &&
      dist != null &&
      dist <= -6;

    issues.push({
      gate: "aggressive_yield_ge_0p95",
      ok: !(y != null && y < 0.95),
      detail: `aggWeeklyYieldPct=${y} (filtre combo ≥0,95%/sem jambe agg)`,
    });
    issues.push({
      gate: "aggressive_grade_AB_or_watchpremium",
      ok: grade === "A" || grade === "B" || (grade === "WATCH" && watchOk),
      detail: `grade=${grade} watchPremiumAggOk=${watchOk}`,
    });
    issues.push({
      gate: "aggressive_proExecutionScore_ge_0p45_when_numeric",
      ok: !Number.isFinite(Number(enriched.proExecutionScore)) || Number(enriched.proExecutionScore) >= 0.45,
      detail: `proExecutionScore=${enriched.proExecutionScore}`,
    });
    issues.push({
      gate: "aggressive_spread_le_25",
      ok: sp == null || sp <= 25,
      detail: `aggSpreadPct=${sp}`,
    });
    issues.push({
      gate: "aggressive_minDistance_-5_pct",
      ok: dist == null || dist <= -5,
      detail: `aggDistancePct=${dist}`,
    });

    const simForOv = {
      ...enriched,
      spreadPct: sp,
      weeklyReturn: y,
      _popForCombo: pop,
    };
    const ovAgg = computeTickerQualityOverlay(simForOv);

    issues.push({
      gate: "aggressive_filterCandidate_avoid_tier",
      ok: ovAgg.qualityTier !== "avoid",
      detail: `qualityTier=${ovAgg.qualityTier}`,
    });
    issues.push({
      gate: "aggressive_filterCandidate_premium_trap",
      ok: !(ovAgg.premiumTrapPenalty >= 0.4 && (pop == null || pop < 82)),
      detail: `premiumTrapPenalty=${ovAgg.premiumTrapPenalty} pop=${pop}`,
    });
    issues.push({
      gate: "aggressive_filterCandidate_speculative_spread",
      ok: !(ovAgg.qualityTier === "speculative" && sp != null && sp > 20),
      detail: "",
    });

    const passAll =
      issues.filter((x) => !x.ok).length === 0 &&
      !!(y != null && y >= 0.95 && (grade === "A" || grade === "B" || (grade === "WATCH" && watchOk)));

    return {
      symbol: sym,
      modeLabel,
      issues,
      okForScoredPool: passAll,
      legMetrics: { aggWeeklyYieldPct: y, aggSpreadPct: sp, aggDistancePct: dist, aggPopPct: pop, aggGradeResolved: grade },
      enrichedSnapshot: pruneEnriched(enriched),
    };
  }

  // BALANCED (patch institutionnel : minWeekly 0.675, maxWeekly <1.05, spread≤22 ; choix jambe [0.75–1.05) si possible).
  let bucketLeg =
    enriched._safeLeg && enriched._aggLeg
      ? enriched._safeLeg
      : enriched._safeLeg || enriched._aggLeg;
  const safeInRange =
    enriched._hasSafeLegValid && safeY != null && safeY >= 0.75 && safeY < 1.05;
  const aggInRange = enriched._hasAggLegValid && aggY != null && aggY >= 0.75 && aggY < 1.05;
  const MID = 0.875;
  if (safeInRange && aggInRange) {
    bucketLeg = Math.abs(safeY - MID) <= Math.abs(aggY - MID) ? enriched._safeLeg : enriched._aggLeg;
  } else if (safeInRange) bucketLeg = enriched._safeLeg;
  else if (aggInRange) bucketLeg = enriched._aggLeg;
  else if (enriched._hasAggLegValid) bucketLeg = enriched._aggLeg;
  else if (enriched._hasSafeLegValid) bucketLeg = enriched._safeLeg;

  issues.push({
    gate: "_band_context_balanced_mid_875",
    ok: true,
    detail: `safeInBand=${safeInRange} aggInBand=${aggInRange} safeY=${safeY} aggY=${aggY}`,
  });

  const yPick = bucketLeg ? getLegYieldPct(bucketLeg, enriched) : null;
  const spPick = bucketLeg ? getLegSpreadPct(bucketLeg) : null;
  const distPick = bucketLeg ? getLegDistancePct(bucketLeg) : null;
  const popPick = bucketLeg
    ? (() => {
        const rawPop = Number(bucketLeg.popProfitEstimated ?? bucketLeg.popEstimate ?? NaN);
        if (!Number.isFinite(rawPop)) return null;
        return rawPop <= 1 ? rawPop * 100 : rawPop;
      })()
    : null;

  const inferredGrade =
    bucketLeg === enriched._safeLeg
      ? String(enriched._safeGrade || "").toUpperCase()
      : String(enriched._aggGrade || "").toUpperCase();

  const balancedWatchPremiumOk =
    popPick != null &&
    popPick >= 88 &&
    (spPick == null || spPick <= 15) &&
    yPick != null &&
    yPick >= 0.75 &&
    yPick <= 1.05 &&
    distPick != null &&
    distPick <= -6;

  issues.push({
    gate: "balanced_min_yield_ge_0p675_inst_patch",
    ok: !(yPick != null && yPick < 0.675),
    detail: `pickedWeekly=${yPick}`,
  });
  issues.push({
    gate: "balanced_max_yield_lt_1p05_exclusive",
    ok: !(yPick != null && yPick >= 1.05),
    detail: `pickedWeekly=${yPick}`,
  });
  issues.push({
    gate: "balanced_spread_le_22_inst_patch",
    ok: spPick == null || spPick <= 22,
    detail: `pickedSpread=${spPick}`,
  });
  issues.push({
    gate: "balanced_grade_AB_or_balanced_watchpremium",
    ok: inferredGrade === "A" || inferredGrade === "B" || (inferredGrade === "WATCH" && balancedWatchPremiumOk),
    detail: `inferredJambeGrade=${inferredGrade} balancedWatchPremiumOk=${balancedWatchPremiumOk}`,
  });

  const simBal = {
    ...enriched,
    spreadPct: spPick ?? enriched.spreadPct,
    weeklyReturn: yPick ?? enriched.weeklyReturn,
    _popForCombo: popPick ?? enriched._popForCombo,
  };
  const ov = computeTickerQualityOverlay(simBal);

  issues.push({
    gate: "balanced_filterCandidate_avoid_tier",
    ok: ov.qualityTier !== "avoid",
    detail: `qualityTier=${ov.qualityTier}`,
  });
  issues.push({
    gate: "balanced_speculative_hard_gate",
    ok: !(
      ov.qualityTier === "speculative" &&
      ((popPick == null || popPick < 82) || (spPick != null && spPick > 20) || (yPick != null && yPick < 0.75))
    ),
    detail: "tier speculative exige POP≥82 spread≤20 yield≥0,75%/sem jambe sélectionnée",
  });

  const passBal =
    issues.filter((x) => !x.ok && !String(x.gate).includes("_band_context")).length === 0 &&
    bucketLeg != null &&
    (inferredGrade === "A" || inferredGrade === "B" || (inferredGrade === "WATCH" && balancedWatchPremiumOk));

  return {
    symbol: sym,
    modeLabel,
    issues,
    okForScoredPool: passBal,
    legMetrics: {
      balancedWeeklyPct: yPick,
      balancedSpreadPct: spPick,
      balancedDistancePct: distPick,
      balancedPopPct: popPick,
      inferredJambeGrade: inferredGrade || null,
      safeY,
      aggY,
      safeInRange,
      aggInRange,
    },
    enrichedSnapshot: pruneEnriched(enriched),
  };
}

function findResidualRow(capDiagnosticsV2, ticker) {
  const t = String(ticker || "").trim().toUpperCase();
  const rows = Array.isArray(capDiagnosticsV2?.nextBestResiduals)
    ? capDiagnosticsV2.nextBestResiduals
    : [];
  return rows.find((r) => String(r.ticker || "").trim().toUpperCase() === t) ?? null;
}

function findReplacementHint(capDiagnosticsV2, ticker) {
  const t = String(ticker || "").trim().toUpperCase();
  const rows = Array.isArray(capDiagnosticsV2?.replacementClusterHints)
    ? capDiagnosticsV2.replacementClusterHints
    : [];
  return rows.find((r) => String(r.ticker || "").trim().toUpperCase() === t) ?? null;
}

function lookupShortRow(list, ticker) {
  const t = String(ticker || "").trim().toUpperCase();
  return list.find((s) => String(s.symbol || "").trim().toUpperCase() === t) ?? null;
}

function picksMetrics(picks, v3Set) {
  const arr = picks || [];
  const v3Pick = arr.filter((p) => v3Set.has(String(p.ticker || "").trim().toUpperCase()));
  return {
    count: arr.length,
    v3Lines: v3Pick.length,
    v3Syms: v3Pick.map((p) => p.ticker),
    avgWeekly:
      arr.length <= 0
        ? null
        : arr.reduce((s, p) => s + Number(p.weeklyReturn || 0) * Number(p.capitalUsed || 0), 0) /
          arr.reduce((s, p) => s + Number(p.capitalUsed || 0), 0),
    allocScoresApprox: arr.map((p) => ({
      t: p.ticker,
      y: p.weeklyReturn ?? null,
      cap: p.capitalUsed ?? null,
      compositeHint: p.selectionReason ?? null,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const missingData = [];
  /** @type {unknown[]} */
  const recommendations = [];

  const refMerged = {};
  for (const pth of args.refJsonPaths) {
    const abs = existsSync(pth) ? pth : join(REPO_ROOT, pth);
    const j = safeReadJson(abs);
    if (j) Object.assign(refMerged, j);
    else missingData.push(`Réf introuvable ou JSON invalide : ${abs}`);
  }

  const nearmissSnap = safeReadJson(args.nearmissJson);
  const aggressiveSnap = safeReadJson(args.aggressiveJson);

  const expiration =
    args.expirationOverride || refMerged.summary?.expiration || nextFridayYmd();
  const capital =
    Number.isFinite(args.capitalOverride) && args.capitalOverride > 0
      ? args.capitalOverride
      : Number(refMerged.capitalComboImpact?.capital) || 25_500;
  const maxCapitalPct =
    Number.isFinite(args.maxCapitalPctOverride) && args.maxCapitalPctOverride > 0
      ? args.maxCapitalPctOverride
      : Number(refMerged.capitalComboImpact?.maxCapitalPct) || 95;
  const maxPositions =
    Number.isFinite(args.maxPositionsOverride) && args.maxPositionsOverride > 0
      ? args.maxPositionsOverride
      : Number(refMerged.capitalComboImpact?.maxPositions) || 8;

  const usableCapital = capital * (maxCapitalPct / 100);
  const v3FromRef = new Set(
    (refMerged.watchlistImpact?.v3RecoveredSymbols || []).map((s) => String(s).trim().toUpperCase()),
  );

  const provider = createMarketDataProvider();
  const marketService = createMarketService(provider);
  const watchlistCache = createWatchlistCache();
  const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });
  const wheelScanner = createWheelScanner(marketService);

  const savedLive = process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
  const savedSim = process.env.YAHOO_LIQUIDITY_V3_SIMULATION;

  process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE = savedLive ?? "1";
  process.env.YAHOO_LIQUIDITY_V3_SIMULATION = savedSim ?? "1";

  try {
    const v3Wl = await watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD_CRITERIA });
    const watchlistArr = v3Wl.watchlist || [];
    const v3Meta = v3Wl.yahooLiquidityV3LiveSafe || {};
    const recoveredLive = new Set(
      (Array.isArray(v3Meta.recoveredSymbols) ? v3Meta.recoveredSymbols : [])
        .map((s) => String(s).trim().toUpperCase())
        .filter(Boolean),
    );

    const scanResult = await wheelScanner.scanShortlist({
      expiration,
      tickers: watchlistArr.map((t) => String(t).trim().toUpperCase()).slice(0, MAX_SCAN_TICKERS),
      topN: args.topN,
      sort: args.sort,
    });

    const payload = scanResult.payload || {};
    if (scanResult.status !== 200 || !payload.ok) {
      missingData.push(
        `scan_shortlist status=${scanResult.status} — impossible de rejouer les combos (prices périmées vs audit ref).`,
      );
    }

    const shortlistFull = Array.isArray(payload.shortlist) ? payload.shortlist : [];
    const comboCandidates = shortlistFull.filter((it) => it.passesFilter === true).map(mapScanItemToComboCandidate);
    const combos = buildPortfolioCombos(comboCandidates, capital, maxCapitalPct, maxPositions, new Set());

    const replayComboUsable =
      watchlistArr.length > 0 && shortlistFull.length > 0 && comboCandidates.length > 0 && payload.ok !== false;

    const balancedCombo = combos.find((c) => String(c.label).toUpperCase() === "BALANCED");
    const aggressiveCombo = combos.find((c) => String(c.label).toUpperCase() === "AGGRESSIVE");

    const v3SetForCount = recoveredLive.size > 0 ? recoveredLive : v3FromRef;

    let balPm = picksMetrics(balancedCombo?.picks, v3SetForCount);
    let aggPm = picksMetrics(aggressiveCombo?.picks, v3SetForCount);

    const refBalBook = refMerged.bucketImpact?.balanced ?? null;
    const refAggBook = refMerged.bucketImpact?.aggressive ?? null;

    if (!replayComboUsable && refBalBook?.positions >= 1) {
      missingData.push(
        `Freeze ref : replay live indispose (watchlist=${watchlistArr.length} passesFilterEligible=${comboCandidates.length}) → compteurs combo calqués sur v3-end-to-end ref exporté ${refMerged.exportedAt ?? "?"}.`,
      );
      balPm = {
        count: refBalBook.positions ?? 0,
        v3Lines: refBalBook.v3LineCount ?? 0,
        v3Syms: Array.isArray(refBalBook.v3SymbolsInBook) ? refBalBook.v3SymbolsInBook : [],
        avgWeekly:
          typeof refBalBook.avgWeeklyReturn === "number" ? refBalBook.avgWeeklyReturn : null,
        allocScoresApprox: [
          {
            t: "__freeze_reference_audit_balanced__",
            y:
              typeof refBalBook.avgWeeklyReturn === "number" ? refBalBook.avgWeeklyReturn : null,
            cap: refBalBook.capitalUsed ?? null,
            compositeHint:
              `[freeze_ref] diversificationHealth=${refBalBook.diversificationHealthScore ?? "—"} capUsedUsd=${refBalBook.capitalUsed ?? "—"}`,
          },
        ],
      };
      aggPm = {
        count: refAggBook?.positions ?? 0,
        v3Lines: refAggBook?.v3LineCount ?? 0,
        v3Syms: Array.isArray(refAggBook?.v3SymbolsInBook) ? refAggBook.v3SymbolsInBook : [],
        avgWeekly: typeof refAggBook?.avgWeeklyReturn === "number" ? refAggBook.avgWeeklyReturn : null,
        allocScoresApprox: [
          {
            t: "__freeze_reference_audit_aggressive__",
            y:
              typeof refAggBook?.avgWeeklyReturn === "number" ? refAggBook.avgWeeklyReturn : null,
            cap: refAggBook?.capitalUsed ?? null,
            compositeHint:
              `[freeze_ref] diversificationHealth=${refAggBook?.diversificationHealthScore ?? "—"} capUsedUsd=${refAggBook?.capitalUsed ?? "—"} v3Lines=${refAggBook?.v3SymbolsInBook ?? ""}`,
          },
        ],
      };
    }

    const balancedExplainFr =
      balPm.v3Lines === 0
        ? [
            `Aucun ticker V3 du set « recovered » (${v3SetForCount.size}) ne figure parmi les ${balPm.count} lignes sélectionnées BALANCED.`,
            "Causes codées dominantes selon capitalComboPortfolio : (a) rendement jambe CSP hebdomadaire ≥1,05%/sem après fallback hors bande [0.75–1.05), fréquent sur leveraged/meme ⇒ exclu par maxWeeklyYield<1.05 ; (b) filtre speculative/POP/spread institutional ; (c) si éligible scoredPool mais pas pické : greedy + diversification + maxPositions efficaces ~6 lignes sous patch institu.",
          ].join(" ")
        : `BALANCED contient déjà ${balPm.v3Lines} ligne(s) V3 : ${balPm.v3Syms.join(", ")}`;

    const singleV3Ticker = aggPm.v3Syms[0] || null;
    const aggressiveExplainFr =
      aggPm.v3Lines <= 1
        ? [
            `AGGRESSIVE : ${aggPm.count} lignes (${aggPm.v3Lines} avec symbole V3).`,
            "Seuil jambe agg ≥0,95%/sem + minExecution≥0,45 quand champ numérique + distance≤-5% + greedy sur ~4 lignes ⇒ la plupart des V3 éligibles encore en lice perdent contre un panier meilleur composite (capital fit, diversification, POP, spread).",
            singleV3Ticker ? `V3 retenu ici : ${singleV3Ticker}.` : "Aucun V3 sélectionné en AGGRESSIVE sur ce replay.",
          ].join(" ")
        : "";

    /** @type {{ balancedV3Blockers: object; aggressiveV3Blockers: object }} */
    const balancedV3Blockers = {
      v3LinesInBook: balPm.v3Lines,
      replayCandidatesEligible: comboCandidates.length,
      reasonFrBalancedMacro: balancedExplainFr,
      institutionalBalancedYieldBandFr:
        "BALANCED tente jambe CSP dans [0,75–1,05)%/sem ; hors bande le moteur retombe sur une jambe brute puis applique maxWeeklyYield <1.05 → exclut souvent primes hebdomadaires énormes (>1%/sem façon meme/leveraged).",
      codeRefs: ["wheel-dashboard/src/capitalComboPortfolio.js makeCombo balanced branch · filtres lignes ~994–1092"],
    };

    const aggressiveV3Blockers = {
      v3LinesInBook: aggPm.v3Lines,
      v3TickerIfAny: aggPm.v3Syms,
      replayCandidatesEligible: comboCandidates.length,
      reasonFrAggressiveMacro: aggressiveExplainFr,
      codeRefs: ["wheel-dashboard/src/capitalComboPortfolio.js modeConfigs aggressive · ~785–836 · filtres pooled ~1072–1092"],
    };

    const focusRows = [];

    const shortlistBySym = new Map(
      shortlistFull.map((r) => [String(r.symbol || "").trim().toUpperCase(), r]),
    );

    const balDiag = balancedCombo?.capDiagnosticsV2 || null;
    const aggDiag = aggressiveCombo?.capDiagnosticsV2 || null;
    const altBal = balDiag?.alternativeCompositionSimV1 || null;
    const altAgg = aggDiag?.alternativeCompositionSimV1 || null;

    const aggPickSet = new Set(
      (aggressiveCombo?.picks || []).map((p) => String(p.ticker || "").trim().toUpperCase()),
    );
    const balPickSet = new Set(
      (balancedCombo?.picks || []).map((p) => String(p.ticker || "").trim().toUpperCase()),
    );

    for (const sym of args.focus.map((x) => x.trim().toUpperCase())) {
      const refAuditRow =
        (Array.isArray(refMerged.shortlistImpact?.v3Rows)
          ? refMerged.shortlistImpact.v3Rows
          : []).find((rv) => String(rv.symbol) === sym) ?? null;

      const raw = shortlistBySym.get(sym);
      let row = {
        symbol: sym,
        inReplayShortlistSlice: !!raw,
        refAuditPassesFilterApprox: !!(refMerged.shortlistImpact?.v3Rows || []).find(
          (r) => String(r.symbol) === sym,
        )?.passesFilter,
        upstreamAggressive: raw ? explainUpstreamFailures(raw, usableCapital, "AGGRESSIVE") : null,
        upstreamBalanced: raw ? explainUpstreamFailures(raw, usableCapital, "BALANCED") : null,
        residualAggressive: findResidualRow(aggDiag, sym),
        residualBalanced: findResidualRow(balDiag, sym),
        replacementHintAggressive: findReplacementHint(aggDiag, sym),
        replacementHintBalanced: findReplacementHint(balDiag, sym),
        blockerConsoleLineFr: null,
        frozenReferenceAuditV3RowRef: refAuditRow,
        codeFactsFr:
          (HIGH_BETA_GROWTH_CODE_TICKERS.has(sym)
            ? "Ticker listé QUALITY_HIGH_BETA_TICKERS ⇒ concentrationTheme high_beta_growth + plafonds maxHighBetaCapitalPct lors du greedy (voir computeTickerQualityOverlay + evaluateCandidate)."
            : "") +
          (sym === "MP" || sym === "SHOP"
            ? " Pas sous QUALITY_HIGH_BETA_TICKERS explicite : exclusion plutôt par composite score / POP-distance-spread jambe CSP vs meilleures lignes greedy."
            : ""),
      };

      const aggFailGate =
        row.upstreamAggressive &&
        Array.isArray(row.upstreamAggressive.issues)
          ? row.upstreamAggressive.issues.find((z) => !z.ok && z.gate !== "_band_context_balanced_mid_875") ||
            row.upstreamAggressive.issues.find((z) => !z.ok)
          : null;

      const balFailGate =
        row.upstreamBalanced &&
        Array.isArray(row.upstreamBalanced.issues)
          ? row.upstreamBalanced.issues.find(
              (z) => !z.ok && String(z.gate).indexOf("_band_context") < 0,
            ) || row.upstreamBalanced.issues.find((z) => !z.ok)
          : null;

      let blockerBrief = "";

      if (!raw) {
        blockerBrief = !replayComboUsable ? "replay_shortlist_manquant_fallback_ref_audits_only" : "absent_topN_shortlist";
        if (HIGH_BETA_GROWTH_CODE_TICKERS.has(sym)) blockerBrief += "+HIGH_BETA_GROWTH_THEME_CODEPATH";
        row.blockerConsoleLineFr = `${sym} blocker=${blockerBrief}`;
      } else if (!row.upstreamAggressive?.okForScoredPool) {
        blockerBrief =
          aggFailGate != null ? `prefiltre_AGG_${aggFailGate.gate}` : "prefiltre_AGG_inconnu";
        row.blockerConsoleLineFr = `${sym} blocker=${blockerBrief}`;
      } else if (aggPickSet.has(sym)) {
        blockerBrief = "selection_live_AGGRESSIVE";
        row.blockerConsoleLineFr = `${sym} blocker=${blockerBrief}`;
      } else if (findResidualRow(aggDiag, sym)) {
        blockerBrief =
          `knapsack_residual_${findResidualRow(aggDiag, sym).primaryBlocker || "alloc_rejet"}`;
        row.blockerConsoleLineFr = `${sym} blocker=${blockerBrief}`;
      } else if (!row.upstreamBalanced?.okForScoredPool && balFailGate) {
        blockerBrief = `prefiltre_BAL_${balFailGate.gate}`;
        row.blockerConsoleLineFr = `${sym} blocker=${blockerBrief}`;
      } else if (!balPickSet.has(sym)) {
        blockerBrief =
          "competition_greedy_hors_residual_top36_ou_pool_BAL_exclude_yields_hors_bande_si_objectif_balanced_only";
        row.blockerConsoleLineFr = `${sym} blocker=${blockerBrief}`;
      } else {
        blockerBrief = "unexpected_branch";
        row.blockerConsoleLineFr = `${sym} blocker=${blockerBrief}`;
      }

      /** Enrichissement nears-miss figé textual */
      row.nearmissJsonNoteFr =
        aggressiveSnap?.nearMissV3Candidates?.find((n) => n.symbol === sym)?.note ??
        aggressiveSnap?.summary?.dataReplayNote ??
        null;

      focusRows.push(row);
      console.warn(`[combo-post-v3] ${row.blockerConsoleLineFr}`);
    }

    /** Comparaison near-miss vs picks (replay). */
    const nearMissYieldRank = [...args.focus.map((x) => x.trim().toUpperCase())]
      .map((t) => {
        const rr = lookupShortRow(shortlistFull, t);
        const exAgg = rr ? explainUpstreamFailures(rr, usableCapital, "AGGRESSIVE") : null;
        const yAgg = exAgg?.legMetrics?.aggWeeklyYieldPct ?? null;
        const exBal = rr ? explainUpstreamFailures(rr, usableCapital, "BALANCED") : null;
        const yBal = exBal?.legMetrics?.balancedWeeklyPct ?? null;
        return {
          ticker: t,
          finalScoreReplay: rr?.finalScore ?? null,
          yahooQualityReplay: rr?.qualityScore ?? null,
          aggLegWeeklyPctIfValid: yAgg,
          balancedLegWeeklyPctIfValid: yBal,
          okAggPool: !!(exAgg && exAgg.okForScoredPool),
          okBalPool: !!(exBal && exBal.okForScoredPool),
        };
      })
      .sort((a, b) => {
        const fa = Number(a.finalScoreReplay) || -1;
        const fb = Number(b.finalScoreReplay) || -1;
        return fb - fa;
      });

    /** Simulation read-only forcée : heuristiques `alternativeCompositionSimV1` sans toucher greedy live */
    const forcedInclusionSimulation = {
      methodologyFr:
        "Pas de permutation exacte titre-par-titre : `alternativeCompositionSimV1` ré-alloue heuristiquement sur le même `scoredPool` filtré. Voir bestAlternative.isBetterThanBaseline et explanationFr pour savoir si un arrangement concurrent simple « bat » le greedy officiel sous le composite sim lecture seule.",
      noteForcedNearMissFr:
        "Pour OKLO / CRM / etc. : croiser aggWeeklyPct vs greedy picks + blocage diversification (voir replacementClusterHints) + leaderAltExplanation AGG/BAL — ce script ne brute-force pas de swap manuel symétrique.",
      aggressive:
        altAgg == null
          ? { missingAltSim: true }
          : {
              bestAlternative: altAgg.bestAlternative ?? null,
              leaderExplanationFr: altAgg.explanationFr ?? null,
              verdictBaselineStrictlyOptimalApprox: !(altAgg.bestAlternative?.isBetterThanBaseline === true),
              alternativeCount: altAgg.alternativeCompositions?.length ?? 0,
              baselineGreedyTickers: aggressiveCombo?.picks?.map((p) => p.ticker) ?? null,
            },
      balanced:
        altBal == null
          ? { missingAltSim: true }
          : {
              bestAlternative: altBal.bestAlternative ?? null,
              leaderExplanationFr: altBal.explanationFr ?? null,
              verdictBaselineStrictlyOptimalApprox: !(altBal.bestAlternative?.isBetterThanBaseline === true),
              baselineGreedyTickers: balancedCombo?.picks?.map((p) => p.ticker) ?? null,
            },
    };

    const selectedVsNearMissComparison = {
      picksAggressiveApprox: aggPm.allocScoresApprox,
      picksBalancedApprox: balPm.allocScoresApprox,
      nearMissRankedByReplayFinalScore: nearMissYieldRank,
      interpretationFr:
        "Inferiorité marché-vs-marché : comparer `yahoo finalScore replay` avec allocScore greedy (voir trace JSON). near-miss V3 peuvent avoir finalScore Yahoo > titres hors V3 tout en perdant au composite combo (capital, diversification, POP, spread hebdomadaire filtrée).",
    };

    const capitalUsageImpact = {
      balanced: {
        capitalUsedUsd: balancedCombo?.totalCapital ?? null,
        freeCapitalUsdBalancedApprox: balancedCombo?.freeCapital ?? null,
        targetDeployFr: "~90–95% enveloppe brute via greedy (capitalComboPortfolio)",
      },
      aggressive: {
        capitalUsedUsd: aggressiveCombo?.totalCapital ?? null,
        freeCapitalUsdAggressiveApprox: aggressiveCombo?.freeCapital ?? null,
      },
      usableCapitalUsd: usableCapital,
    };

    const diversificationImpact = {
      balanced: {
        diversificationHealthScore: balancedCombo?.diversificationHealthScore ?? null,
        largestThemePct: balancedCombo?.largestThemeCapitalPct ?? null,
        largestTickerPct: balancedCombo?.largestTickerCapitalPct ?? null,
        warnings: balancedCombo?.clusterWarnings ?? [],
      },
      aggressive: {
        diversificationHealthScore: aggressiveCombo?.diversificationHealthScore ?? null,
        largestThemePct: aggressiveCombo?.largestThemeCapitalPct ?? null,
        largestTickerPct: aggressiveCombo?.largestTickerCapitalPct ?? null,
        warnings: aggressiveCombo?.clusterWarnings ?? [],
      },
    };

    recommendations.push(
      "BALANCED (Core Institutional Yield) : si objectif DAËL = capter plusieurs V3 *yield riche*, le plafond <1.05%/sem coupe naturellement beaucoup de jambes agressives — ce n’est pas un bug V3 mais un gabarit risque rendement différent de AGGRESSIVE.",
    );
    recommendations.push(
      "AGGRESSIVE : si plus de lignes V3 souhaitées sans changer thresholds, examiner ordre greedy + residuals `nextBestResiduals`/`replacementClusterHints` — souvent blocker `high_beta_cap_reached` ou `theme_cap_reached`.",
    );

    /** Verdict final console */
    const verdictFr = [
      v3Wl.watchlistDiagnosticsV1
        ? `replay_watchlist_diag_ok countV3_live=${recoveredLive.size}`
        : "replay_watchlist_diag_absent",
      `balanced_v3_live_replay_lines=${balPm.v3Lines} aggressive_v3_live_replay_lines=${aggPm.v3Lines}`,
      altAgg?.bestAlternative?.isBetterThanBaseline
        ? "alternative_sim_meilleure_que_greedy_flag_true_voir_leaderAltExplanation"
        : "alternative_sim_na_ou_dominee_par_greedy",
    ].join(" · ");

    const out = {
      summary: {
        exportedAtReplay: new Date().toISOString(),
        expirationReplay: expiration,
        refJsonPathsMerged: [
          ...new Set(args.refJsonPaths.map((p) => (existsSync(p) ? p : join(REPO_ROOT, String(p))))),
        ],
        watchlistReplayCount: watchlistArr.length,
        v3RecoveredSymbolsReplay: [...recoveredLive].sort(),
        v3RecoveredSymbolsRefAudit: [...v3FromRef].sort(),
        replayScanShortlistCount: shortlistFull.length,
        comboEligiblePassesFilterReplay: comboCandidates.length,
        balancedV3LineCountReplay: balPm.v3Lines,
        aggressiveV3LineCountReplay: aggPm.v3Lines,
        nearmissJsonLoaded: !!nearmissSnap,
        aggressiveAuditJsonLoaded: !!aggressiveSnap,
        funnelDiagnosticsEnabledReplay: isYahooFunnelDiagnosticsV1Enabled(),
        v3SimEnabledReplay: isYahooLiquidityV3SimulationEnabled(),
        verdictFr,
      },
      balancedV3Blockers,
      aggressiveV3Blockers,
      nearMissAnalysis: focusRows,
      selectedVsNearMissComparison,
      forcedInclusionSimulation,
      capitalUsageImpact,
      diversificationImpact,
      recommendations,
      missingData:
        recoveredLive.size === 0 && v3FromRef.size > 0
          ? [...missingData, "Session live : aucun recovered V3 détecté (flags/env ou watchlist différente de ref)."]
          : missingData,
    };

    const debugDir = join(REPO_ROOT, "debug");
    mkdirSync(debugDir, { recursive: true });
    const outfile = join(debugDir, `capital-combo-post-v3-audit-${auditStampLocal()}.json`);
    writeFileSync(outfile, JSON.stringify(out, null, 2), "utf8");

    console.warn(
      `[combo-post-v3] balanced v3Lines=${balPm.v3Lines} reason=BALANCED filtre yields <1,05%/sem jambe CSP + speculative/POP après patch institutional ; aucun ticker V3 du set forcément dans top alloc`,
    );
    console.warn(
      `[combo-post-v3] aggressive v3Lines=${aggPm.v3Lines} ticker=${aggPm.v3Syms.join(",") || "(aucun)"} reason=Greedy+CSP agg≥0.95%/sem+diversification ⇒ V3 hors top4 ou prefiltres distance/POP/exec`,
    );
    console.warn(`[combo-post-v3] verdict=${verdictFr}`);
    console.warn(`[combo-post-v3] wrote ${outfile}`);
  } finally {
    if (savedLive != null) process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE = savedLive;
    else delete process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE;
    if (savedSim != null) process.env.YAHOO_LIQUIDITY_V3_SIMULATION = savedSim;
    else delete process.env.YAHOO_LIQUIDITY_V3_SIMULATION;
  }
}

main().catch((e) => {
  console.error("[combo-post-v3] fatal", e);
  process.exitCode = 1;
});
