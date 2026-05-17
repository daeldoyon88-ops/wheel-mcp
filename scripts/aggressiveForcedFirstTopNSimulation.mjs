/**
 * Simulation read-only : Top-N forced-first + réoptimisation du reste (VirtualAllocator AGGRESSIVE).
 * Aucune exécution, aucun changement live, ordre greedy inchangé ailleurs.
 *
 * Usage :
 *   node scripts/aggressiveForcedFirstTopNSimulation.mjs
 *   node scripts/aggressiveForcedFirstTopNSimulation.mjs --scan-json debug/mon-export-scan.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deltaSummaryVsGreedyBaseline,
  finalPositionsFromPicks,
} from "../app/diagnostics/aggressiveComboSimulationShared.mjs";
import { parseForcedFirstArgv, runAggressiveForcedFirstSimulation } from "../app/diagnostics/aggressiveForcedFirstSimulationCore.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

async function main() {
  const args = parseForcedFirstArgv(process.argv);
  const result = await runAggressiveForcedFirstSimulation({ repoRoot: REPO_ROOT, args });

  const { baselineSummary, scenarios, bestForced, missingData, recommendationFr } = result;
  const baselinePicks = result.baselinePicks ?? [];

  const bs = baselineSummary.simCompositePortfolioScore;
  const yb = baselineSummary.portfolioYieldWeightedPct;
  console.warn(
    `[forced-first] baseline score=${fmt(bs)} premium=${fmt(baselineSummary.premiumTotalUsd, 0)} yield=${fmt(yb, 3)} capUsed=${fmt(baselineSummary.capitalUsedUsd, 0)}`,
  );

  for (const s of scenarios) {
    if (!s?.candidate || s.skipped) {
      const symU = s?.candidate ?? "";
      const vs = symU ? `candidate=${symU} verdict=${s.verdict}` : null;
      if (symU && s.skipped === true && vs) console.warn(`[forced-first] ${vs}`);
      continue;
    }
    console.warn(`[forced-first] candidate=${s.candidate} verdict=${s.verdict}`);
  }

  const dScore = bestForced?.summary ? deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary).deltaCompositeScore : null;
  const dPrem = bestForced?.summary ? deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary).deltaPremiumUsd : null;
  const dYield = bestForced?.summary
    ? deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary).deltaYieldWeightedPct
    : null;

  console.warn(
    `[forced-first] best=${bestForced?.candidate ?? "—"} deltaScore=${dScore != null ? fmt(dScore) : "—"} deltaPremium=${dPrem != null ? fmt(dPrem, 0) : "—"} deltaYield=${dYield != null ? fmt(dYield, 3) : "—"}`,
  );

  console.warn(`[forced-first] recommendation=${recommendationFr}`);

  mkdirSync(join(REPO_ROOT, "debug"), { recursive: true });
  const stamp = result.fileStampLocal;
  const outPath = join(REPO_ROOT, "debug", `aggressive-forced-first-topn-simulation-${stamp}.json`);

  const exportPayload = {
    simulationOnly: true,
    exportedAt: result.exportedAtIso,
    kind: "aggressive_forced_first_topn_reoptimize_v1",
    expiration: result.expiration,
    capitalGrossUsd: args.capital,
    maxCapitalPct: args.maxCapitalPct,
    maxPositions: args.maxPositions,
    targetGoalPctAllocator: args.targetGoalPct,
    forcedFirstCandidatesOrdered: result.forcedFirstCandidatesOrdered,
    scanDiagnosticsV1: result.scanDiagnosticsV1,
    inputSource: result.inputSource,
    missingData,
    baselineGreedy: {
      summary: baselineSummary,
      finalPositions: finalPositionsFromPicks(baselinePicks),
      tickers: baselineSummary.tickers,
    },
    scenarios,
    bestForcedFirst: bestForced
      ? {
          candidate: bestForced.candidate,
          summary: bestForced.summary,
          deltaVsGreedyBaseline: deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary),
          verdict: bestForced.verdict,
        }
      : null,
    recommendationFr,
    limitsFr:
      "Heuristique greedy read-only ; pas de relecture exacte leftoverDensityV2 du live. Ne modifie pas l’ordre greedy du dashboard.",
  };

  writeFileSync(outPath, JSON.stringify(exportPayload, null, 2), "utf8");
  console.warn(`[forced-first] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
