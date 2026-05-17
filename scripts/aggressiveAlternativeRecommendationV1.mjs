/**
 * Alternative Composition Recommendation V1 — AGGRESSIVE read-only.
 * Export structuré + logs [alt-combo] sans toucher greedy live Capital Combo ni V3/IBKR.
 *
 * Usage :
 *   node scripts/aggressiveAlternativeRecommendationV1.mjs
 *   node scripts/aggressiveAlternativeRecommendationV1.mjs --scan-json debug/mon-export-scan.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAggressiveAlternativeRecommendationV1Envelope } from "../app/diagnostics/aggressiveAlternativeRecommendationV1Envelope.mjs";
import { deltaSummaryVsGreedyBaseline } from "../app/diagnostics/aggressiveComboSimulationShared.mjs";
import {
  parseForcedFirstArgv,
  runAggressiveForcedFirstSimulation,
} from "../app/diagnostics/aggressiveForcedFirstSimulationCore.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function fmt(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

async function main() {
  const args = parseForcedFirstArgv(process.argv);
  const core = await runAggressiveForcedFirstSimulation({ repoRoot: REPO_ROOT, args });

  const { baselineSummary, bestForced } = core;

  const bs = baselineSummary.simCompositePortfolioScore;
  const yb = baselineSummary.portfolioYieldWeightedPct;
  console.warn(
    `[alt-combo] baseline score=${fmt(bs)} yield=${fmt(yb, 3)} premium=${fmt(baselineSummary.premiumTotalUsd, 0)} capUsed=${fmt(baselineSummary.capitalUsedUsd, 0)}`,
  );

  const dScore =
    bestForced?.summary ? deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary).deltaCompositeScore : null;
  const dPrem = bestForced?.summary ? deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary).deltaPremiumUsd : null;
  const dYield =
    bestForced?.summary ? deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary).deltaYieldWeightedPct : null;

  const bestTicker = bestForced?.candidate ?? null;
  console.warn(
    `[alt-combo] best=${bestTicker ?? "—"} deltaScore=${dScore != null ? fmt(dScore) : "—"} deltaYield=${dYield != null ? fmt(dYield, 3) : "—"} deltaPremium=${dPrem != null ? fmt(dPrem, 0) : "—"}`,
  );

  const recLine = core.recommendationFr ?? "";
  console.warn(`[alt-combo] recommendation=${recLine}`);

  const envelope = buildAggressiveAlternativeRecommendationV1Envelope(core);

  mkdirSync(join(REPO_ROOT, "debug"), { recursive: true });
  const stamp = core.fileStampLocal;
  const outPath = join(REPO_ROOT, "debug", `aggressive-alternative-recommendation-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(envelope, null, 2), "utf8");
  console.warn(`[alt-combo] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
