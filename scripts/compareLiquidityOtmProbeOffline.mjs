/**
 * Compare la sonde Yahoo `liquidityOtmProbePct` hors ligne, sans Yahoo ni IBKR.
 *
 * Prérequis : un export JSON d'un POST /universe/build capturé avec
 *   set WATCHLIST_OTM_REPLAY_PACK=1
 * avant de lancer le serveur et le rebuild watchlist, puis sauver le corps JSON.
 *
 * Usage:
 *   node scripts/compareLiquidityOtmProbeOffline.mjs chemin/vers/build-export.json
 *   node scripts/compareLiquidityOtmProbeOffline.mjs build.json --baseline 3 --json-out out.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { computeWatchlistCandidateScore } from "../app/watchlist/watchlistBuilder.js";
import { evaluateAtmPutLiquidity, evaluateOtmPutLiquidityProbe } from "../app/watchlist/watchlistFilters.js";
import { toNumber } from "../app/utils/number.js";

const DEFAULT_LEVELS = Object.freeze([0, 1, 2, 3, 4, 5]);

function parseArgs(argv) {
  const positional = [];
  let baseline = 3;
  let jsonOut = null;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--baseline" && argv[i + 1]) {
      baseline = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (a === "--json-out" && argv[i + 1]) {
      jsonOut = argv[i + 1];
      i += 1;
      continue;
    }
    if (!a.startsWith("-")) positional.push(a);
  }
  return { filePath: positional[0] || null, baseline, jsonOut };
}

function simulateOneEntry(entry, probePct) {
  const { symbol, category, universeRow, scoreCtx, tierBias, chain } = entry;
  const spot = toNumber(chain?.currentPrice) || toNumber(scoreCtx?.spot);
  const chainLike = { puts: chain?.puts ?? [], currentPrice: chain?.currentPrice };

  const atm = evaluateAtmPutLiquidity(chainLike, spot);
  let otmProbeOk = true;
  let otmDetail = null;
  if (probePct > 0) {
    const otm = evaluateOtmPutLiquidityProbe(chainLike, spot, probePct);
    otmProbeOk = otm.ok === true;
    otmDetail = otm.detail ?? null;
  }

  const row = {
    symbol,
    category,
    sources: universeRow?.sources ?? [],
    tags: universeRow?.tags,
  };

  const { score: watchlistScore } = computeWatchlistCandidateScore(row, {
    spot: scoreCtx?.spot,
    maxPrice: scoreCtx?.maxPrice,
    minPrice: scoreCtx?.minPrice,
    minVolume: scoreCtx?.minVolume,
    volumeUsed: scoreCtx?.volumeUsed,
    hasWeeklyStyle: scoreCtx?.hasWeeklyStyle,
    optionLiquidityOk: true,
    atmSpreadPct: scoreCtx?.atmSpreadPct ?? null,
    otmProbeOk,
  });

  const sortScore = watchlistScore + (toNumber(tierBias) || 0);
  const atmSp = scoreCtx?.atmSpreadPct;
  const otmSp = otmDetail?.liquidity?.spreadPct ?? null;

  return {
    symbol,
    atmOk: atm.ok,
    atmReason: atm.ok ? null : atm.reason,
    otmProbeOk,
    otmDetail,
    watchlistScore,
    sortScore,
    atmSpreadPct: atmSp,
    otmWinningSpreadPct: otmSp,
    balancedHeuristic:
      otmProbeOk &&
      atm.ok &&
      toNumber(atmSp) != null &&
      atmSp <= 0.3 &&
      (toNumber(tierBias) ?? 0) >= 0,
    dubiousHeuristic:
      (toNumber(atmSp) != null && atmSp > 0.35) || (toNumber(otmSp) != null && otmSp > 0.45),
  };
}

function runReport(buildPayload, baselinePct) {
  const pack = buildPayload?.liquidityOtmReplayPack;
  if (!Array.isArray(pack) || pack.length === 0) {
    return {
      ok: false,
      error: "liquidityOtmReplayPack_manquant_ou_vide",
      hint: `Refaire un /universe/build avec WATCHLIST_OTM_REPLAY_PACK=1, sauver la réponse JSON complète, puis relancer ce script.`,
      meta: buildPayload?.liquidityOtmReplayMeta ?? null,
    };
  }

  const limit = toNumber(buildPayload?.criteria?.limit) || 120;
  const levels = [...DEFAULT_LEVELS];
  const baselineSafe = levels.includes(baselinePct) ? baselinePct : 3;

  /** @type {Record<number, ReturnType<typeof simulateOneEntry>[]>} */
  const rowsByPct = {};
  for (const pct of levels) {
    rowsByPct[pct] = pack.map((e) => simulateOneEntry(e, pct));
  }

  let baselineSet = new Set();
  const reportByLevel = {};

  for (const pct of levels) {
    const rows = rowsByPct[pct];
    const atmBroken = rows.filter((r) => !r.atmOk);
    const yahooQualified = rows.filter((r) => r.atmOk && r.otmProbeOk);
    const otmProbeFailed = rows.filter((r) => r.atmOk && !r.otmProbeOk);

    const sorted = yahooQualified
      .slice()
      .sort((a, b) => {
        if (b.sortScore !== a.sortScore) return b.sortScore - a.sortScore;
        return a.symbol.localeCompare(b.symbol);
      });
    const watchlistSim = sorted.slice(0, limit).map((r) => r.symbol);

    const balanced = yahooQualified.filter((r) => r.balancedHeuristic);
    const dubious = yahooQualified.filter((r) => r.dubiousHeuristic);

    if (pct === baselineSafe) baselineSet = new Set(yahooQualified.map((r) => r.symbol));

    const meanTop20Spread =
      sorted.length > 0
        ? sorted.slice(0, 20).reduce((acc, r) => acc + (toNumber(r.atmSpreadPct) ?? 0), 0) /
          Math.min(20, sorted.length)
        : null;

    reportByLevel[pct] = {
      watchlistCountSimulated: watchlistSim.length,
      yahooQualifiedCount: yahooQualified.length,
      rejectedLiquidOptionsOtmProbeFailed: otmProbeFailed.length,
      atmSanityFailuresAfterTrim: atmBroken.length,
      tightSpreadNonTier3FriendlyCount: balanced.length,
      wideSpreadHeuristicCount: dubious.length,
      topSimulatedWatchlist: watchlistSim,
      meanAtmSpreadPctTop20: meanTop20Spread != null ? Math.round(meanTop20Spread * 1000) / 1000 : null,
      qualityNote:
        meanTop20Spread != null && meanTop20Spread <= 0.22
          ? "ATM serré en moyenne (top simulé)"
          : meanTop20Spread != null && meanTop20Spread >= 0.32
            ? "ATM large en moyenne — surveillance spread"
            : "ATM modéré",
    };
  }

  const diffs = {};
  for (const pct of levels) {
    const yahooQualified = rowsByPct[pct].filter((r) => r.atmOk && r.otmProbeOk);
    const current = new Set(yahooQualified.map((r) => r.symbol));
    const gained = [...current].filter((s) => !baselineSet.has(s));
    const lost = [...baselineSet].filter((s) => !current.has(s));
    diffs[pct] = {
      vsBaselinePct: baselineSafe,
      tickersGainedVsBaseline: gained.sort(),
      tickersLostVsBaseline: lost.sort(),
    };
  }

  return {
    ok: true,
    inputMeta: {
      liquidityInput: buildPayload?.liquidityOtmReplayMeta ?? null,
      criteriaSnapshot: buildPayload?.criteria ?? null,
      packEntries: pack.length,
    },
    baselinePct: baselineSafe,
    baselineRequested: baselinePct,
    baselineAdjusted: baselineSafe !== baselinePct,
    levels,
    byLevel: reportByLevel,
    diffVsBaseline: diffs,
  };
}

function printHumanReport(rep) {
  if (!rep.ok) {
    console.error("[OTM_OFFLINE]", rep.error);
    if (rep.hint) console.error("→", rep.hint);
    if (rep.meta) console.error("meta:", JSON.stringify(rep.meta, null, 0));
    return;
  }
  console.log("=== Comparatif sonde OTM Yahoo (hors ligne) ===");
  console.log("Entrées pack:", rep.inputMeta.packEntries, "| limite watchlist:", rep.inputMeta.criteriaSnapshot?.limit);
  if (rep.inputMeta.liquidityInput?.capturedAt) {
    console.log("Capturé:", rep.inputMeta.liquidityInput.capturedAt);
  }
  if (rep.baselineAdjusted) {
    console.warn(
      `[OTM_OFFLINE] Baseline demandée ${rep.baselineRequested}% hors plage — utilisation de ${rep.baselinePct}%.`
    );
  }
  console.log("Référence baseline:", rep.baselinePct, "% OTM");
  console.log("");

  for (const pct of rep.levels) {
    const b = rep.byLevel[pct];
    const d = rep.diffVsBaseline[pct];
    console.log(`--- ${pct}% OTM ---`);
    console.log(
      `  watchlist (simulé, tri score): ${b.watchlistCountSimulated} | Yahoo qualified (ATM+sonde): ${b.yahooQualifiedCount} | otm_probe_failed: ${b.rejectedLiquidOptionsOtmProbeFailed}`
    );
    if (b.atmSanityFailuresAfterTrim > 0) {
      console.log(
        `  ⚠ ${b.atmSanityFailuresAfterTrim} symboles: ATM échoue après troncature export — augmenter maxPuts dans watchlistBuilder si besoin.`
      );
    }
    console.log(
      `  profil « spread serré + tiers >= T2 » (heuristique): ${b.tightSpreadNonTier3FriendlyCount} | zone spread étirée (heuristique): ${b.wideSpreadHeuristicCount}`
    );
    console.log(`  qualité: ${b.qualityNote} | spread ATM moy. top20 simulé: ${b.meanAtmSpreadPctTop20 ?? "n/d"}%`);
    if (pct !== rep.baselinePct) {
      console.log(`  vs ${rep.baselinePct}% → gagnés: ${d.tickersGainedVsBaseline.length}, perdus: ${d.tickersLostVsBaseline.length}`);
      if (d.tickersGainedVsBaseline.length && d.tickersGainedVsBaseline.length <= 25) {
        console.log("    +", d.tickersGainedVsBaseline.join(", "));
      }
      if (d.tickersLostVsBaseline.length && d.tickersLostVsBaseline.length <= 25) {
        console.log("    −", d.tickersLostVsBaseline.join(", "));
      }
    }
    console.log("");
  }
}

function main() {
  const { filePath, baseline, jsonOut } = parseArgs(process.argv);
  if (!filePath) {
    console.error("Usage: node scripts/compareLiquidityOtmProbeOffline.mjs <build-export.json> [--baseline 3] [--json-out out.json]");
    process.exit(1);
  }
  const resolvedPath = resolve(filePath);
  const raw = readFileSync(resolvedPath, "utf8");
  const data = JSON.parse(raw);
  const rep = runReport(data, baseline);
  printHumanReport(rep);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(rep, null, 2), "utf8");
    console.log("JSON écrit:", jsonOut);
  }
  process.exit(rep.ok ? 0 : 2);
}

main();
