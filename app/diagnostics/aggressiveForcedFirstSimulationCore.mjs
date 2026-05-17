/**
 * Cœur read-only : scan / shortlist → greedy AGGRESSIVE + scénarios forced-first VirtualAllocator.
 * Partagé par scripts/aggressiveForcedFirstTopNSimulation.mjs et aggressiveAlternativeRecommendationV1.mjs.
 */

import { join } from "node:path";

import { MAX_SCAN_TICKERS } from "../config/constants.js";
import {
  auditStampLocal,
  DEFAULT_BUILD_CRITERIA,
  deltaSummaryVsGreedyBaseline,
  extractShortlistFromExport,
  finalPositionsFromPicks,
  mapScanItemToComboCandidate,
  buildAggressiveScoredStaging,
  nextFridayYmd,
  readJsonSafe,
  summarizeSnapshotForJson,
  verdictVsBaseline,
  pickBestScenario,
} from "./aggressiveComboSimulationShared.mjs";
import { createMarketDataProvider } from "../data_providers/createMarketDataProvider.js";
import { createWheelScanner } from "../scanners/wheelScanner.js";
import { createWatchlistBuilder } from "../watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../watchlist/watchlistCache.js";
import { createMarketService } from "../services/marketService.js";

import { buildPortfolioCombos } from "../../wheel-dashboard/src/capitalComboPortfolio.js";
import {
  VirtualAllocator,
  buildCompositionSnapshot,
  createBalancedVirtualAllocationScorers,
} from "../../wheel-dashboard/src/alternativeCompositionSimV1.js";

/** Candidats forcés en premier (ordre de test). Aligné sur scripts/aggressiveForcedFirstTopNSimulation.mjs */
export const FORCED_FIRST_CANDIDATES = Object.freeze([
  "OKLO",
  "TQQQ",
  "SHOP",
  "CRM",
  "MP",
  "APLD",
  "SLV",
  "HOOD",
  "SMCI",
  "TTD",
  "RBLX",
  "INTC",
  "NOW",
]);

export function parseForcedFirstArgv(argv) {
  const out = {
    expiration: null,
    capital: 25_500,
    maxCapitalPct: 95,
    maxPositions: 8,
    topN: 150,
    sort: "quality",
    scanJsonPath: null,
    targetGoalPct: 95,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expiration" && argv[i + 1]) out.expiration = String(argv[++i]).trim();
    else if (a === "--capital" && argv[i + 1]) out.capital = Number(argv[++i]) || out.capital;
    else if (a === "--max-capital-pct" && argv[i + 1]) out.maxCapitalPct = Number(argv[++i]) || out.maxCapitalPct;
    else if (a === "--max-positions" && argv[i + 1]) out.maxPositions = Number(argv[++i]) || out.maxPositions;
    else if (a === "--topN" && argv[i + 1]) out.topN = Number(argv[++i]) || out.topN;
    else if (a === "--scan-json" && argv[i + 1]) out.scanJsonPath = String(argv[++i]).trim();
    else if (a === "--target-goal-pct" && argv[i + 1]) out.targetGoalPct = Number(argv[++i]) || out.targetGoalPct;
  }
  return out;
}

export function recommendationFrForcedFirst({ baselineSummary, bestForced, anyExecutable, baselineScore }) {
  if (!anyExecutable) {
    return "Aucun scénario forced-first n’a pu être exécuté (shortlist, pool ou caps). Voir missingData et raisons SKIP.";
  }
  if (!bestForced?.summary) {
    return "Impossible de désigner un meilleur candidat — scores composites manquants.";
  }
  const cand = bestForced.candidate;
  const cs = bestForced.summary.simCompositePortfolioScore;
  const d =
    baselineScore != null && cs != null && Number.isFinite(baselineScore) && Number.isFinite(cs) ? cs - baselineScore : null;
  if (d != null && d > 0.05) {
    return `Parmi les forced-first testés, ${cand} offre le meilleur score composite sim (Δ≈${d.toFixed(2)} vs greedy baseline) après réoptimisation VirtualAllocator — validation read-only seulement, sans changement live.`;
  }
  if (d != null && d < -0.05) {
    return `Le greedy baseline reste supérieur aux forced-first testés (meilleur ${cand} : Δ≈${d.toFixed(2)} vs baseline).`;
  }
  return `Résultats proches du baseline ; meilleur candidat sim : ${cand}. Pas de recommandation live — diagnostic seulement.`;
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {ReturnType<parseForcedFirstArgv>} opts.args
 */
export async function runAggressiveForcedFirstSimulation({ repoRoot, args }) {
  const expiration = args.expiration || nextFridayYmd();
  const missingData = [];

  let shortlistFull = [];
  let scanResult = { status: 200, payload: { ok: true } };
  let tickersForScan = [];

  if (args.scanJsonPath) {
    const abs = join(repoRoot, args.scanJsonPath);
    const exported = readJsonSafe(abs);
    shortlistFull = extractShortlistFromExport(exported);
    if (!shortlistFull.length) {
      missingData.push(
        `--scan-json=${args.scanJsonPath} : aucune shortlist exploitable (clés attendues : shortlist[], payload.shortlist).`,
      );
    } else {
      missingData.push(`Shortlist figée depuis fichier (pas d’appel Yahoo dans cette exécution) : ${args.scanJsonPath}`);
    }
    tickersForScan = [...new Set(shortlistFull.map((r) => String(r?.symbol || "").trim().toUpperCase()).filter(Boolean))];
  } else {
    const provider = createMarketDataProvider();
    const marketService = createMarketService(provider);
    const watchlistCache = createWatchlistCache();
    const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });
    const wheelScanner = createWheelScanner(marketService);

    const v3Wl = await watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD_CRITERIA });
    const watchlistArr = v3Wl.watchlist || [];
    const fromWl = watchlistArr.map((t) => String(t).trim().toUpperCase()).filter(Boolean);
    const mustInclude = [...FORCED_FIRST_CANDIDATES];
    tickersForScan = [...new Set([...mustInclude, ...fromWl])].slice(0, MAX_SCAN_TICKERS);

    if (fromWl.length === 0) {
      missingData.push(
        "Watchlist builder a retourné 0 symbole — fusion avec la liste forced-first pour permettre le scan read-only.",
      );
    }

    scanResult = await wheelScanner.scanShortlist({
      expiration,
      tickers: tickersForScan,
      topN: args.topN,
      sort: args.sort,
    });

    if (scanResult.status !== 200 || !scanResult.payload?.ok) {
      const errMsg = scanResult.payload?.error ? String(scanResult.payload.error) : "résultat incomplet";
      missingData.push(`scan_shortlist status=${scanResult.status} — ${errMsg}.`);
    }

    const payload = scanResult.payload || {};
    shortlistFull = Array.isArray(payload.shortlist) ? payload.shortlist : [];
  }

  const forcedSet = new Set(FORCED_FIRST_CANDIDATES.map((t) => t.toUpperCase()));

  const comboCandidates = shortlistFull
    .filter((it) => {
      const sym = String(it?.symbol || "").trim().toUpperCase();
      const pf = it.passesFilter === true;
      const forcedForSim = forcedSet.has(sym);
      return pf || forcedForSim;
    })
    .map(mapScanItemToComboCandidate);

  for (const it of shortlistFull) {
    const sym = String(it?.symbol || "").trim().toUpperCase();
    if (forcedSet.has(sym) && it.passesFilter !== true) {
      missingData.push(`${sym} : inclus dans le pool simulation malgré passesFilter=false — résultats étiquetés read-only.`);
    }
  }

  const scanDiagnosticsV1 = {
    tickersRequestedCount: tickersForScan.length,
    shortlistLength: shortlistFull.length,
    passesFilterTrueCount: shortlistFull.filter((x) => x.passesFilter === true).length,
    comboCandidatePoolSize: comboCandidates.length,
  };

  const staging = buildAggressiveScoredStaging(
    comboCandidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
  );

  const combos = buildPortfolioCombos(
    comboCandidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
  );

  const agg = combos.find((c) => String(c?.label || "").toUpperCase() === "AGGRESSIVE");
  if (!agg || !Array.isArray(agg.picks)) {
    missingData.push("Combo AGGRESSIVE introuvable après buildPortfolioCombos.");
  }

  const usableCapital = staging.usableCapital;
  const grossCapital = args.capital;
  const scoredPool = staging.scoredPool;
  const modeAlloc = staging.modeAlloc;
  const baselinePicks = agg?.picks ?? [];

  const baseSnap = buildCompositionSnapshot(baselinePicks, usableCapital, grossCapital, scoredPool);
  const baselineSummary = summarizeSnapshotForJson("baseline_greedy", baseSnap, baselinePicks, usableCapital, grossCapital);

  const { primaryScoreFn, fillerScoreFn } = createBalancedVirtualAllocationScorers(usableCapital);

  /** @type {object[]} */
  const scenarios = [];

  scenarios.push({
    id: "baseline_greedy_live_engine",
    candidate: null,
    skipped: false,
    summary: baselineSummary,
    deltaVsGreedyBaseline: deltaSummaryVsGreedyBaseline(baselineSummary, baselineSummary),
    finalPositions: finalPositionsFromPicks(baselinePicks),
    verdict: "Référence — buildPortfolioCombos AGGRESSIVE (greedy live replay).",
  });

  for (const candidateSym of FORCED_FIRST_CANDIDATES) {
    const symU = candidateSym.trim().toUpperCase();
    const row = shortlistFull.find((r) => String(r?.symbol || "").trim().toUpperCase() === symU);

    if (!row) {
      const verdict = `SKIP — absent de la shortlist`;
      scenarios.push({
        id: `force_first_${symU}`,
        candidate: symU,
        skipped: true,
        reason: "missing_from_shortlist",
        summary: null,
        deltaVsGreedyBaseline: null,
        finalPositions: [],
        verdict,
      });
      continue;
    }

    const stagedRow = scoredPool.find((c) => String(c?.ticker || "").trim().toUpperCase() === symU);
    if (!stagedRow) {
      const verdict = `SKIP — hors scoredPool AGGRESSIVE (gates / jambe / capital)`;
      scenarios.push({
        id: `force_first_${symU}`,
        candidate: symU,
        skipped: true,
        reason: "not_in_scored_pool_after_gates",
        summary: null,
        deltaVsGreedyBaseline: null,
        finalPositions: [],
        verdict,
      });
      continue;
    }

    const probe = new VirtualAllocator(
      scoredPool,
      modeAlloc,
      usableCapital,
      staging.maxPositionLines,
      staging.minTargetPositions,
    );
    const evFirst = probe.evaluateCandidate(stagedRow, false);
    if (!evFirst.ok) {
      const verdict = `SKIP — première place refusée (${evFirst.reason})`;
      scenarios.push({
        id: `force_first_${symU}`,
        candidate: symU,
        skipped: true,
        reason: evFirst.reason ?? "evaluateCandidate_failed_empty_portfolio",
        summary: null,
        deltaVsGreedyBaseline: null,
        finalPositions: [],
        verdict,
      });
      continue;
    }

    const mem = new VirtualAllocator(
      scoredPool,
      modeAlloc,
      usableCapital,
      staging.maxPositionLines,
      staging.minTargetPositions,
    );
    const picksForced = mem.runSimulation("aggressive", primaryScoreFn, fillerScoreFn, args.targetGoalPct, symU);
    const snap = buildCompositionSnapshot(picksForced, usableCapital, grossCapital, scoredPool);
    const summary = summarizeSnapshotForJson(`force_first_${symU}`, snap, picksForced, usableCapital, grossCapital);
    const delta = deltaSummaryVsGreedyBaseline(baselineSummary, summary);
    const v = verdictVsBaseline(baseSnap, snap);

    scenarios.push({
      id: `force_first_${symU}_reoptimize`,
      candidate: symU,
      skipped: false,
      forcedFirstApplied: true,
      virtualAllocatorNoteFr:
        "VirtualAllocator + createBalancedVirtualAllocationScorers — première ligne forcée si evaluateCandidate OK, puis greedy strict→soft→filler.",
      summary,
      deltaVsGreedyBaseline: delta,
      penaltiesSimV1: summary.penaltiesSimV1,
      finalPositions: finalPositionsFromPicks(picksForced),
      picksCompact: picksForced.map((p) => ({
        ticker: p.ticker,
        contracts: p.contracts ?? 1,
        capitalUsd: p.capitalUsed,
        premiumUsd: p.premiumCollected,
      })),
      verdict: v,
    });
  }

  const forcedRuns = scenarios.filter((s) => s.candidate && !s.skipped);
  const bestForced = pickBestScenario(forcedRuns);
  const baselineScore = baselineSummary.simCompositePortfolioScore;
  const recommendationFr = recommendationFrForcedFirst({
    baselineSummary,
    bestForced,
    anyExecutable: forcedRuns.length > 0,
    baselineScore,
  });

  return {
    exportedAtIso: new Date().toISOString(),
    expiration,
    args,
    missingData,
    scanDiagnosticsV1,
    stagingMeta: {
      usableCapitalUsd: usableCapital,
      scoredPoolLength: scoredPool.length,
    },
    inputSource: args.scanJsonPath ? `scan_json_file:${args.scanJsonPath}` : "yahoo_scan_shortlist_live",
    forcedFirstCandidatesOrdered: [...FORCED_FIRST_CANDIDATES],
    baselineSummary,
    baselinePicks,
    baseSnap,
    scenarios,
    bestForced,
    recommendationFr,
    fileStampLocal: auditStampLocal(),
    scanStatus: scanResult.status,
    scanOk: !!(scanResult.payload && scanResult.payload.ok === true),
  };
}
