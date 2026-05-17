/**
 * Audit read-only : quel(s) ticker(s) V3 alimentent le livre AGGRESSIVE du Capital Combo.
 * Ne modifie aucune logique V3 / combo / IBKR — rejoue localement watchlist → scan → buildPortfolioCombos.
 *
 * Usage :
 *   node scripts/v3AggressiveImpactAudit.mjs
 *   node scripts/v3AggressiveImpactAudit.mjs --expiration 2026-05-22 --ref-audit debug/v3-end-to-end-audit-....json
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_SCAN_TICKERS } from "../app/config/constants.js";
import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { createWheelScanner } from "../app/scanners/wheelScanner.js";
import { createWatchlistBuilder } from "../app/watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../app/watchlist/watchlistCache.js";
import { createMarketService } from "../app/services/marketService.js";

import { buildPortfolioCombos, getFinalDisplayRecommendation } from "../wheel-dashboard/src/capitalComboPortfolio.js";

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

function auditStamp() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
}

function logLine(msg) {
  console.warn(msg);
}

function nextFridayYmd() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 5) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = {
    expiration: null,
    capital: 25_500,
    maxCapitalPct: 95,
    maxPositions: 8,
    topN: 150,
    sort: "quality",
    refAuditPath: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expiration" && argv[i + 1]) out.expiration = String(argv[++i]).trim();
    else if (a === "--capital" && argv[i + 1]) out.capital = Number(argv[++i]) || out.capital;
    else if (a === "--max-capital-pct" && argv[i + 1]) out.maxCapitalPct = Number(argv[++i]) || out.maxCapitalPct;
    else if (a === "--max-positions" && argv[i + 1]) out.maxPositions = Number(argv[++i]) || out.maxPositions;
    else if (a === "--topN" && argv[i + 1]) out.topN = Number(argv[++i]) || out.topN;
    else if (a === "--ref-audit" && argv[i + 1]) out.refAuditPath = String(argv[++i]).trim();
  }
  return out;
}

/**
 * @param {Record<string, unknown>} item
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

function readJsonSafe(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Quand le replay live ne peut pas reproduire la session (watchlist vide, API, etc.),
 * extraire ce qui est documenté dans l’export `v3-end-to-end-audit-*.json`.
 * @param {Record<string, unknown> | null} refAudit
 */
function aggressiveV3FromRefAudit(refAudit) {
  if (!refAudit) return [];
  const syms = refAudit?.bucketImpact?.aggressive?.v3SymbolsInBook;
  if (!Array.isArray(syms) || syms.length === 0) return [];
  const v3Rows = Array.isArray(refAudit?.shortlistImpact?.v3Rows) ? refAudit.shortlistImpact.v3Rows : [];
  const exp = refAudit?.summary?.expiration ?? null;

  return syms.map((raw) => {
    const ticker = String(raw || "").trim().toUpperCase();
    const refRow = v3Rows.find((r) => r.symbol === ticker) || null;
    return {
      ticker,
      source: "refAuditJsonFrozen",
      v3Bucket: refRow?.v3Bucket ?? null,
      refAuditRankYahoo: refRow?.yahooRankInShortlistSorted ?? null,
      pick: {
        strike: null,
        weeklyReturnPct: null,
        premiumCollectedUsd: null,
        capitalUsedUsd: null,
        popEstimatePercent: null,
        mode: null,
        grade: null,
        spreadPct: null,
        distancePct: null,
        selectionReason: null,
        comboAllocationPhase: null,
        note:
          "Non présent dans l’export E2E : nécessite la ligne `shortlist` complète ou un replay réussi pour strike / prime / rendement de ligne.",
      },
      scan: {
        expirationYmd: exp,
        dteDays: null,
        expectedMove: null,
        expectedMovePercent: null,
        lowerBound: null,
        aggressiveStrike: null,
      },
      funnelFlags: refRow
        ? {
            preIbkrConfidenceScore: refRow.preIbkrConfidenceScore ?? null,
            preIbkrConfidenceBucket: refRow.preIbkrConfidenceBucket ?? null,
          }
        : null,
      riskFlags: {
        qualityWarnings: [],
        qualityTier: null,
        concentrationTheme: null,
        isHighBeta: null,
        premiumTrapPenalty: null,
        preIbkrConfidenceBucket: refRow?.preIbkrConfidenceBucket ?? null,
        liquiditySource: refRow?.liquiditySource ?? null,
        noYahooLiquidity: refRow?.noYahooLiquidity === true,
        passesFilterYahoo: refRow?.passesFilter === true,
      },
      refRowSnapshot: refRow
        ? {
            qualityScore: refRow.qualityScore ?? null,
            finalScore: refRow.finalScore ?? null,
            safeAnnualizedYieldPct: refRow.safeAnnualizedYieldPct ?? null,
          }
        : null,
    };
  });
}

function nearMissV3FromRef(refAudit, aggressiveSymbolsUpper) {
  const setA = new Set(aggressiveSymbolsUpper);
  const v3Rows = Array.isArray(refAudit?.shortlistImpact?.v3Rows) ? refAudit.shortlistImpact.v3Rows : [];
  const recovered = v3Rows.filter((r) => r.v3Recovered === true && r.passesFilter === true && !setA.has(r.symbol));
  recovered.sort((a, b) => (Number(b.finalScore) || 0) - (Number(a.finalScore) || 0));
  return recovered.slice(0, 14).map((r) => ({
    symbol: r.symbol,
    finalScore: r.finalScore ?? null,
    v3Bucket: r.v3Bucket ?? null,
    safeAnnualizedYieldPct: r.safeAnnualizedYieldPct ?? null,
    note: "V3 + passesFilter Yahoo dans l’audit ref mais pas dans v3SymbolsInBook AGGRESSIVE (autres modes / knapsack / caps).",
  }));
}

function v3ExcludedRef(refAudit) {
  const v3Rows = Array.isArray(refAudit?.shortlistImpact?.v3Rows) ? refAudit.shortlistImpact.v3Rows : [];
  return v3Rows
    .filter((r) => r.v3Recovered === true && r.passesFilter === false)
    .map((r) => ({
      symbol: r.symbol,
      reasonFr: "passesFilter=false dans shortlist Yahoo (audit ref)",
      liquiditySource: r.liquiditySource ?? null,
      noYahooLiquidity: r.noYahooLiquidity === true,
    }));
}

function pickScanFieldsForTicker(item) {
  return {
    symbol: String(item?.symbol || "").trim().toUpperCase(),
    dteDays: item.dteDays ?? null,
    expectedMove: item.expectedMove ?? null,
    expectedMovePercent: item.expectedMovePercent ?? null,
    lowerBound: item.lowerBound ?? null,
    currentPrice: item.currentPrice ?? null,
    aggressiveStrike: item.aggressiveStrike
      ? {
          strike: item.aggressiveStrike.strike ?? null,
          bid: item.aggressiveStrike.bid ?? null,
          ask: item.aggressiveStrike.ask ?? null,
          conservativePremium: item.aggressiveStrike.conservativePremium ?? null,
          premiumUsed: item.aggressiveStrike.premiumUsed ?? null,
          weeklyYield: item.aggressiveStrike.weeklyYield ?? null,
          annualizedYield: item.aggressiveStrike.annualizedYield ?? null,
          popEstimate: item.aggressiveStrike.popEstimate ?? null,
        }
      : null,
    recommendationDiagnostics: item.recommendationDiagnostics ?? null,
    scanFunnelRow: null,
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const expiration = args.expiration || nextFridayYmd();

  const refAudit = args.refAuditPath ? readJsonSafe(join(REPO_ROOT, args.refAuditPath)) : null;
  const refSummary = refAudit?.summary ?? null;
  const refVerdict = refSummary?.verdict ?? null;

  const missingData = [];
  if (!refAudit) {
    missingData.push(
      "Aucun fichier --ref-audit fourni : comparaison textuelle avec l’audit E2E figé non croisée.",
    );
  }

  const provider = createMarketDataProvider();
  const marketService = createMarketService(provider);
  const watchlistCache = createWatchlistCache();
  const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });
  const wheelScanner = createWheelScanner(marketService);

  const v3Wl = await watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD_CRITERIA });
  const watchlistArr = v3Wl.watchlist || [];
  const v3Meta = v3Wl.yahooLiquidityV3LiveSafe || {};
  const recoveredArr = Array.isArray(v3Meta.recoveredSymbols) ? v3Meta.recoveredSymbols : [];
  const v3RecoveredSet = new Set(recoveredArr.map((s) => String(s).trim().toUpperCase()));

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
    missingData.push(`scan_shortlist status=${scanResult.status} — résultat incomplet.`);
  }

  const payload = scanResult.payload || {};
  const shortlistFull = Array.isArray(payload.shortlist) ? payload.shortlist : [];

  const funnel = payload.scanFunnelDiagnosticsV1;
  const passedMap = new Map(
    (Array.isArray(funnel?.passedCandidates) ? funnel.passedCandidates : []).map((r) => [
      String(r?.symbol || "").trim().toUpperCase(),
      r,
    ]),
  );

  const comboCandidates = shortlistFull.filter((it) => it.passesFilter === true).map(mapScanItemToComboCandidate);

  const combosFull = buildPortfolioCombos(
    comboCandidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
  );

  const nonV3Candidates = comboCandidates.filter((c) => !v3RecoveredSet.has(String(c.ticker || "").trim().toUpperCase()));
  const combosNoV3 = buildPortfolioCombos(
    nonV3Candidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
  );

  const aggFull = combosFull.find((c) => String(c?.label || "").toUpperCase() === "AGGRESSIVE");
  const aggNoV3 = combosNoV3.find((c) => String(c?.label || "").toUpperCase() === "AGGRESSIVE");

  const aggPicks = Array.isArray(aggFull?.picks) ? aggFull.picks : [];
  const v3AggressivePicks = aggPicks.filter((p) => v3RecoveredSet.has(String(p?.ticker || "").trim().toUpperCase()));

  const picksNoV3 = Array.isArray(aggNoV3?.picks) ? aggNoV3.picks : [];
  const tickersWithV3 = new Set(aggPicks.map((p) => String(p.ticker).trim().toUpperCase()));
  const tickersSansV3 = new Set(picksNoV3.map((p) => String(p.ticker).trim().toUpperCase()));

  const displacedByV3 = [...tickersSansV3].filter((t) => !tickersWithV3.has(t));
  const addedOnlyWithV3 = [...tickersWithV3].filter((t) => !tickersSansV3.has(t));

  /** @type {Record<string, unknown>[]} */
  const aggressiveV3Used = [];

  for (const p of v3AggressivePicks) {
    const t = String(p.ticker || "").trim().toUpperCase();
    const row = shortlistFull.find((r) => String(r?.symbol || "").trim().toUpperCase() === t);
    const funnelRow = passedMap.get(t) ?? null;
    const refRow = Array.isArray(refAudit?.shortlistImpact?.v3Rows)
      ? refAudit.shortlistImpact.v3Rows.find((r) => r.symbol === t)
      : null;
    const bucketFromWl = (v3Wl.watchlistDiagnosticsV1?.fullRankedCandidates || []).find((c) => c.symbol === t)?.v3Bucket ?? null;

    const qualityWarnings = Array.isArray(p.qualityWarnings) ? p.qualityWarnings : [];
    const riskFlags = {
      qualityWarnings,
      qualityTier: p.qualityTier ?? null,
      concentrationTheme: p.concentrationTheme ?? null,
      isHighBeta: p.isHighBeta === true,
      premiumTrapPenalty: p.premiumTrapPenalty ?? null,
      preIbkrConfidenceBucket: funnelRow?.preIbkrConfidenceBucket ?? refRow?.preIbkrConfidenceBucket ?? null,
    };

    aggressiveV3Used.push({
      ticker: t,
      v3Bucket: refRow?.v3Bucket ?? bucketFromWl,
      refAuditRankYahoo: refRow?.yahooRankInShortlistSorted ?? null,
      liveYahooRankInShortlist: shortlistFull.findIndex((r) => String(r?.symbol || "").trim().toUpperCase() === t) + 1 || null,
      pick: {
        strike: p.strike ?? null,
        weeklyReturnPct: p.weeklyReturn ?? null,
        premiumCollectedUsd: p.premiumCollected ?? null,
        capitalUsedUsd: p.capitalUsed ?? null,
        popEstimatePercent: p.popEstimate ?? null,
        mode: p.mode ?? null,
        grade: p.grade ?? null,
        spreadPct: p.spreadPct ?? null,
        distancePct: p.distancePct ?? null,
        selectionReason: p.selectionReason ?? null,
        comboAllocationPhase: p.comboAllocationPhase ?? null,
      },
      scan: pickScanFieldsForTicker(row ?? {}),
      funnelFlags: funnelRow
        ? {
            preIbkrConfidenceScore: funnelRow.preIbkrConfidenceScore ?? null,
            preIbkrConfidenceBucket: funnelRow.preIbkrConfidenceBucket ?? null,
          }
        : null,
      riskFlags,
    });
  }

  const v3RowsFromShortlist = shortlistFull
    .map((it) => {
      const sym = String(it?.symbol || "").trim().toUpperCase();
      if (!v3RecoveredSet.has(sym)) return null;
      return {
        symbol: sym,
        passesFilter: it.passesFilter === true,
        finalScore: it.finalScore ?? null,
        v3Bucket: (v3Wl.watchlistDiagnosticsV1?.fullRankedCandidates || []).find((c) => c.symbol === sym)?.v3Bucket ?? null,
        weeklyYieldAggressivePct:
          it.aggressiveStrike?.weeklyYield != null ? Number(it.aggressiveStrike.weeklyYield) * 100 : null,
      };
    })
    .filter((x) => x != null);

  const aggressiveTickers = new Set(aggPicks.map((p) => String(p.ticker).trim().toUpperCase()));

  const nearMiss = v3RowsFromShortlist
    .filter((r) => r.passesFilter && !aggressiveTickers.has(r.symbol))
    .sort((a, b) => (Number(b.finalScore) || 0) - (Number(a.finalScore) || 0))
    .slice(0, 12)
    .map((r) => ({
      symbol: r.symbol,
      finalScore: r.finalScore,
      v3Bucket: r.v3Bucket,
      weeklyYieldAggressivePct: r.weeklyYieldAggressivePct,
      note: "Passe filtre Yahoo shortlist mais absent du livre AGGRESSIVE (caps / scoring combo / rang).",
    }));

  const refDistinct = refAudit?.capitalComboImpact?.v3DistinctUsedInCombos;
  const liveDistinct = [...new Set(combosFull.flatMap((c) => (c.picks || []).map((p) => String(p.ticker).trim().toUpperCase()).filter((t) => v3RecoveredSet.has(t))))].sort();

  if (Array.isArray(refDistinct) && refDistinct.sort().join(",") !== liveDistinct.join(",")) {
    missingData.push(
      `Dérive possible vs audit ref : V3 dans combos ref=${refDistinct.join(",") || "—"} vs replay live=${liveDistinct.join(",") || "—"} (marché/cache).`,
    );
  }

  const summary = {
    refAuditFile: args.refAuditPath ?? null,
    refAuditVerdict: refVerdict,
    expiration,
    exportedAtReplay: new Date().toISOString(),
    watchlistTotal: watchlistArr.length,
    v3Recovered: v3RecoveredSet.size,
    aggressivePositions: aggFull?.positions ?? null,
    aggressiveV3LineCount: v3AggressivePicks.length,
    aggressiveAvgWeeklyReturn: aggFull?.avgWeeklyReturn ?? null,
    dataReplayNote:
      "Métriques pick/scan tirées d’un replay live local (même moteur que l’audit E2E). Les prix Yahoo peuvent différer de l’instant de l’audit référence.",
  };

  const comparisonWithoutV3 = {
    withV3: {
      tickers: [...tickersWithV3].sort(),
      positions: aggFull?.positions ?? null,
      avgWeeklyReturn: aggFull?.avgWeeklyReturn ?? null,
      totalPremiumCollected: aggFull?.totalPremiumCollected ?? null,
      totalCapital: aggFull?.totalCapital ?? null,
      freeCapital: aggFull?.freeCapital ?? null,
    },
    withoutV3: {
      tickers: [...tickersSansV3].sort(),
      positions: aggNoV3?.positions ?? null,
      avgWeeklyReturn: aggNoV3?.avgWeeklyReturn ?? null,
      totalPremiumCollected: aggNoV3?.totalPremiumCollected ?? null,
      totalCapital: aggNoV3?.totalCapital ?? null,
      freeCapital: aggNoV3?.freeCapital ?? null,
    },
    tickerDelta: {
      onlyWhenV3Enabled: addedOnlyWithV3.sort(),
      droppedWhenV3Enabled: displacedByV3.sort(),
    },
    interpretationFr:
      addedOnlyWithV3.length > 0 && displacedByV3.length > 0
        ? "Les lignes V3 ont probablement déplacé d’autres candidats sous contraintes de capital / diversification."
        : addedOnlyWithV3.length > 0
          ? "Les titres listés n’apparaissent dans AGGRESSIVE qu’avec la watchlist V3 (pas de remplacement symétrique détecté)."
          : "Pas de différence de set de tickers entre AGGRESSIVE avec/sans V3 sur ce replay.",
  };

  const riskReview = {
    tickers: aggressiveV3Used.map((x) => ({
      ticker: x.ticker,
      riskFlags: x.riskFlags,
    })),
    note: "Les drapeaux viennent du pick combo (quality overlay) et du funnel pré-IBKR si disponible.",
  };

  const recommendations = [];
  if (v3AggressivePicks.length === 0) {
    recommendations.push("Aucun V3 dans AGGRESSIVE sur ce replay — vérifier filtres ou dérive vs audit ref.");
  }
  if (missingData.some((m) => m.includes("Dérive"))) {
    recommendations.push("Pour figer l’analyse, conserver une shortlist exportée ou relancer l’audit E2E au même instant.");
  }

  let aggressiveOut = aggressiveV3Used;
  let nearOut = nearMiss;
  let comparisonOut = comparisonWithoutV3;
  let riskOut = riskReview;
  let summaryOut = { ...summary };

  const refAggSyms = Array.isArray(refAudit?.bucketImpact?.aggressive?.v3SymbolsInBook)
    ? refAudit.bucketImpact.aggressive.v3SymbolsInBook.map((s) => String(s).trim().toUpperCase())
    : [];

  if (aggressiveOut.length === 0 && refAudit?.bucketImpact?.aggressive) {
    const frozen = aggressiveV3FromRefAudit(refAudit);
    if (frozen.length > 0) {
      aggressiveOut = frozen;
      missingData.push(
        "Renseignements strike / prime / rendement de ligne : absents du JSON E2E — compléter avec un replay réussi ou export `shortlist` raw.",
      );
      summaryOut.aggressiveV3LineCount =
        refAudit.bucketImpact.aggressive.v3LineCount ?? aggressiveOut.length ?? null;
      summaryOut.aggressivePositions = refAudit.bucketImpact.aggressive.positions ?? null;
      summaryOut.aggressiveAvgWeeklyReturn = refAudit.bucketImpact.aggressive.avgWeeklyReturn ?? null;
      summaryOut.watchlistTotal = refAudit.summary?.watchlistTotal ?? summaryOut.watchlistTotal;
      summaryOut.v3Recovered = refAudit.summary?.v3Recovered ?? summaryOut.v3Recovered;
      summaryOut.comboUsedV3LinesRef = refAudit.capitalComboImpact?.usedV3LineCountAcrossModes ?? null;
      summaryOut.frozenFromRefAudit = true;
      summaryOut.bookAggressiveFromRefAudit = refAudit.bucketImpact.aggressive;
      nearOut = nearMissV3FromRef(refAudit, refAggSyms);
      comparisonOut = {
        ...comparisonWithoutV3,
        available: false,
        reasonFr:
          "L’export E2E ne contient pas un second passage `buildPortfolioCombos` sans symboles V3. Sans ça, on ne peut pas prouver quel non-V3 a été « bout pour bout » remplacé.",
        narrativeFr:
          "TQQQ est listé uniquement dans les titres « recovered » par V3 : sans V3 live, ce ticker ne serait typiquement pas dans la watchlist (voir `ibkrImpact.baselineComparison` dans l’E2E). C’est donc une ligne supplémentaire dans l’univers candidat, pas un simple swap documenté dans ce fichier.",
        v3ExcludedShortlistYahoo: v3ExcludedRef(refAudit),
      };
      riskOut = {
        tickers: aggressiveOut.map((x) => ({
          ticker: x.ticker,
          riskFlags: x.riskFlags,
        })),
        note: "Basé sur `v3Rows` de l’audit ref (funnel / liquidité) — pas d’overlay quality combo sans replay.",
      };
      recommendations.push(
        "Pour la prochaine session : joindre au JSON E2E les `picks` AGGRESSIVE bruts ou la shortlist complète avec `aggressiveStrike`.",
      );
      if (v3AggressivePicks.length === 0) {
        recommendations.length = 0;
        recommendations.push(
          "Replay live sans watchlist V3 — analyse AGGRESSIVE tirée du JSON E2E figé (voir `source: refAuditJsonFrozen`).",
        );
        recommendations.push(
          "Pour audit strike/prime : relancer `scripts/v3EndToEndAudit.mjs` quand Yahoo/V3 retournent une watchlist non vide, ou exporter la shortlist depuis le serveur.",
        );
      }
    }
  }

  const bookAgg = refAudit?.bucketImpact?.aggressive;
  const auditQuestions =
    refAudit && refAggSyms.length > 0
      ? {
          q1_tickerV3DansAggressive: refAggSyms.join(", "),
          q2_rendement: {
            livreAggressif_avgWeeklyReturn_pct: bookAgg?.avgWeeklyReturn ?? null,
            ligneV3_weeklyReturn_pct: null,
            noteFr:
              "Le rendement moyen pondéré du livre AGGRESSIF est dans `bucketImpact.aggressive.avgWeeklyReturn`. Le rendement hebdo de la ligne TQQQ seul n’est pas exporté dans le JSON E2E.",
          },
          q3_prime: {
            ligne_premiumUsd: null,
            livre_totalPremiumCollectedUsd: bookAgg?.totalPremiumCollected ?? null,
            noteFr:
              "La prime collectée totale du livre AGGRESSIF est `totalPremiumCollected` (somme des lignes). La prime TQQQ seule n’est pas isolée dans ce fichier.",
          },
          q4_capital: {
            ligne_capitalUsedUsd: null,
            livre_capitalUsedUsd: bookAgg?.capitalUsed ?? null,
            livre_freeCapitalUsd: bookAgg?.freeCapital ?? null,
            noteFr:
              "Capital par ticker non exporté ; seulement agrégats livre dans `bucketImpact.aggressive`.",
          },
          q5_strikeExpirationDte: {
            expirationYmd: refAudit.summary?.expiration ?? null,
            dteDays: null,
            strike: null,
            noteFr: "DTE / strike agressif : non présents dans l’export E2E pour cette ligne.",
          },
          q6_pop_expectedMove_lowerBound: {
            pop: null,
            expectedMove: null,
            lowerBound: null,
            noteFr: "Non présents pour TQQQ dans l’export E2E (voir shortlist complète ou replay).",
          },
          q7_bucketV3_highOuMedium: aggressiveOut[0]?.v3Bucket ?? refAudit.shortlistImpact?.v3Rows?.find((r) => r.symbol === refAggSyms[0])?.v3Bucket ?? null,
          q8_riskFlags: aggressiveOut[0]?.riskFlags ?? null,
          q9_amelioreOuRemplace: {
            conclusionFr:
              "Une comparaison « avec vs sans V3 » au niveau picks n’est pas dans l’export. TQQQ est un titre « recovered » : sans V3 il serait absent de la watchlist de base, donc ce n’est pas qu’un remplacement d’un meilleur candidat documenté ici — c’est l’ajout d’un candidat qui n’entrait pas sans V3.",
          },
          q10_v3ProchesMaisExclus: {
            passesFilterMaisPasDansLivreAggressif: nearOut.map((n) => n.symbol),
            passesFilterFalse: v3ExcludedRef(refAudit).map((x) => x.symbol),
          },
        }
      : null;

  const out = {
    summary: summaryOut,
    aggressiveV3Used: aggressiveOut,
    nearMissV3Candidates: nearOut,
    comparisonWithoutV3: comparisonOut,
    riskReview: riskOut,
    auditQuestions,
    missingData: [
      ...missingData,
      ...(Array.isArray(refAudit?.missingData) ? refAudit.missingData : []),
    ],
    recommendations,
  };

  const debugDir = join(REPO_ROOT, "debug");
  mkdirSync(debugDir, { recursive: true });
  const filename = `v3-aggressive-impact-audit-${auditStamp()}.json`;
  const outPath = join(debugDir, filename);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  const usedV3Count =
    aggressiveOut.length > 0 && aggressiveOut[0]?.source === "refAuditJsonFrozen"
      ? Number(refAudit?.capitalComboImpact?.usedV3LineCountAcrossModes) ||
        refAggSyms.length ||
        0
      : combosFull.reduce((acc, c) => {
          const pp = Array.isArray(c?.picks) ? c.picks : [];
          return acc + pp.filter((p) => v3RecoveredSet.has(String(p?.ticker || "").trim().toUpperCase())).length;
        }, 0);

  logLine(`[v3-aggressive] usedV3=${usedV3Count}`);
  for (const x of aggressiveOut) {
    const pk = x.pick;
    logLine(
      `[v3-aggressive] ticker=${x.ticker} yield=${pk?.weeklyReturnPct ?? "—"} premium=${pk?.premiumCollectedUsd ?? "—"} strike=${pk?.strike ?? "—"} bucket=${x.v3Bucket ?? "—"}`,
    );
  }
  if (aggressiveOut.length === 0) {
    logLine(`[v3-aggressive] ticker=(aucun V3 en AGGRESSIVE sur ce replay ni en ref)`);
  }
  logLine(`[v3-aggressive] nearMiss=${nearOut.map((n) => n.symbol).join(", ") || "—"}`);
  logLine(`[v3-aggressive] verdict=${refVerdict ?? summaryOut.dataReplayNote}`);

  logLine(`[v3-aggressive] wrote ${outPath}`);
}

run().catch((e) => {
  console.error("[v3-aggressive] fatal", e);
  process.exitCode = 1;
});
