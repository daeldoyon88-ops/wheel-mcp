/**
 * Audit local — fenêtres haussières annuelles réelles (grille indépendante).
 * Usage: node scripts/auditBullishAnnualWindows.mjs [TICKER1,TICKER2,...]
 *
 * Sortie pour chaque ticker :
 * - top 20 candidates haussières annuelles
 * - bestBullishAnnualWindows
 * - fenêtres candidates démarrant en sep/oct/nov
 * - annualHorizons 3y/5y/10y/15y
 * - avgReturnAnnual, medianReturnAnnual, strength
 * - raison de rejet si rejetée
 */

import { fetchHistoryRows, computeSeasonalityWindowsFromRows } from "../app/seasonality/seasonalityEngine.js";
import {
  findBestAnnualBullishWindows,
  collectAnnualBullishGridCandidates,
  buildPriceRowIndex,
  clearBestAnnualCache,
  ANNUAL_HORIZON_YEARS,
} from "../app/seasonality/seasonalityAnnualStats.js";

const DEFAULT_TICKERS = ["TQQQ", "SOXL", "AMD", "NVDA", "TSLA", "AAPL", "PLTR", "SOFI"];

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

function ratioStr(stats, dir) {
  if (!stats || stats.insufficient || stats.yearsCount == null) return "—";
  const n = dir === "bullish" ? (stats.positiveYears ?? 0) : (stats.negativeYears ?? 0);
  return `${n}/${stats.yearsCount}`;
}

function formatWindow(w) {
  if (!w) return "—";
  const s = w.displayLabel ?? w.label ?? "?";
  const str = w.strength ? ` [${w.strength}]` : "";
  const ah = w.annualHorizons;
  const s15 = ah?.["15y"];
  const s5 = ah?.["5y"];
  const pos15 = s15 && !s15.insufficient ? `15y=${ratioStr(s15, "bullish")} avg=${pct(s15.avgReturnAnnual)} med=${pct(s15.medianReturnAnnual)}` : "";
  const pos5 = s5 && !s5.insufficient ? `5y=${ratioStr(s5, "bullish")} avg=${pct(s5.avgReturnAnnual)}` : "";
  return `${s}${str} | ${pos15} ${pos5}`.trim();
}

async function auditTicker(ticker) {
  clearBestAnnualCache();
  const rows = await fetchHistoryRows(ticker);
  if (!rows?.length) return { ticker, error: "historique indisponible" };

  const index = buildPriceRowIndex(rows);
  const windows = computeSeasonalityWindowsFromRows(rows, { ticker, skipBestAnnualCache: true });

  const bullResult = findBestAnnualBullishWindows(ticker, rows, {
    horizons: windows?.horizons,
    index,
    skipCache: true,
  });

  const grid = collectAnnualBullishGridCandidates(index);
  const autumnCandidates = bullResult.allScored.filter(
    (w) => w.startMonth >= 9 && w.startMonth <= 11,
  );

  return {
    ticker,
    rowsCount: index.rowsCount,
    yearsSpan: `${index.firstYear}–${index.lastCompleteYear}`,
    gridCandidatesTotal: bullResult.gridCandidatesTotal,
    gridCandidatesUsed: bullResult.gridCandidatesUsed,
    bullishAnnualCandidatesTested: bullResult.bullishAnnualCandidatesTested,
    bestBullishAnnualWindows: bullResult.windows,
    noStrongBullishAnnualWindow: bullResult.noStrongBullishAnnualWindow,
    strongBullishFound: bullResult.strongBullishFound,
    confirmedBullishFound: bullResult.confirmedBullishFound,
    allScoredTop20: bullResult.allScored.slice(0, 20),
    autumnCandidates: autumnCandidates.slice(0, 10),
    swingBullishCount: windows?.swingWindows?.bullish?.length ?? 0,
    bestAnnualWindow: windows?.bestAnnualWindow?.window?.displayLabel ?? null,
  };
}

async function main() {
  const arg = process.argv[2];
  const tickers = arg
    ? arg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_TICKERS;

  console.log("=== AUDIT bestBullishAnnualWindows ===\n");
  console.log(`Tickers: ${tickers.join(", ")}\n`);

  const results = [];
  for (const t of tickers) {
    process.stdout.write(`Analyse ${t}… `);
    try {
      const r = await auditTicker(t);
      results.push(r);
      console.log(r.error ? `ERREUR: ${r.error}` : "OK");
    } catch (err) {
      console.log(`EXCEPTION: ${err.message}`);
      results.push({ ticker: t, error: err.message });
    }
  }

  console.log("\n" + "=".repeat(72));

  let anyConfirmed = 0;

  for (const r of results) {
    if (r.error) {
      console.log(`\n## ${r.ticker} — ${r.error}`);
      continue;
    }

    console.log(`\n## ${r.ticker}`);
    console.log(`  Données: ${r.rowsCount} rows (${r.yearsSpan})`);
    console.log(`  Grille: ${r.gridCandidatesTotal} total → ${r.gridCandidatesUsed} utilisées`);
    console.log(`  Candidats testés: ${r.bullishAnnualCandidatesTested}`);
    console.log(`  bestBullishAnnualWindows: ${r.bestBullishAnnualWindows.length} (forte=${r.strongBullishFound}, confirmée=${r.confirmedBullishFound})`);
    console.log(`  noStrongBullishAnnualWindow: ${r.noStrongBullishAnnualWindow}`);
    console.log(`  bestAnnualWindow (swing): ${r.bestAnnualWindow ?? "—"}`);
    console.log(`  Swing haussier glissant: ${r.swingBullishCount} fenêtres`);

    if (r.bestBullishAnnualWindows.length > 0) {
      anyConfirmed += 1;
      console.log("  ✓ Fenêtres haussières annuelles:");
      for (const w of r.bestBullishAnnualWindows) {
        console.log(`    [${w.strength}] ${formatWindow(w)}`);
        if (w.glidingRobustness) {
          const g15 = w.glidingRobustness?.["15y"] ?? w.glidingRobustness?.["5y"];
          if (g15?.sampleSize != null) {
            console.log(`    Robustesse: ${Math.round((g15.winRateGliding ?? 0) * 100)} % · ${g15.sampleSize} tests glissants`);
          }
        }
      }
    }

    console.log(`\n  Top 20 candidates haussières (par score):`);
    for (const w of r.allScoredTop20.slice(0, 20)) {
      const s = w.annualHorizons;
      const s15 = s?.["15y"];
      const s5 = s?.["5y"];
      const line = [
        w.displayLabel ?? "?",
        `[${w.strength}]`,
        s15 && !s15.insufficient ? `15y=${ratioStr(s15, "bullish")} avg=${pct(s15.avgReturnAnnual)}` : "15y=—",
        s5 && !s5.insufficient ? `5y=${ratioStr(s5, "bullish")} avg=${pct(s5.avgReturnAnnual)}` : "5y=—",
        `score=${(w.score ?? 0).toFixed(2)}`,
      ].join(" | ");
      console.log(`    ${line}`);
    }

    console.log(`\n  Candidats automne/hiver (sep–nov) :`);
    if (r.autumnCandidates.length === 0) {
      console.log("    Aucun candidat fort/confirmé en sep–nov");
    } else {
      for (const w of r.autumnCandidates) {
        const s15 = w.annualHorizons?.["15y"];
        const s5 = w.annualHorizons?.["5y"];
        const line = [
          `[${w.strength ?? "?"}]`,
          w.displayLabel ?? "?",
          s15 && !s15.insufficient ? `15y=${ratioStr(s15, "bullish")} avg=${pct(s15.avgReturnAnnual)}` : "15y=—",
          s5 && !s5.insufficient ? `5y=${ratioStr(s5, "bullish")} avg=${pct(s5.avgReturnAnnual)}` : "5y=—",
          `score=${(w.score ?? 0).toFixed(2)}`,
        ].join(" | ");
        console.log(`    ${line}`);
      }
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log("\n## SYNTHÈSE");
  console.log(`  Tickers avec fenêtre haussière confirmée/forte: ${anyConfirmed}/${results.length}`);

  const twoWindows = results.filter((r) => !r.error && r.bestBullishAnnualWindows.length >= 2).length;
  console.log(`  Tickers avec 2+ fenêtres haussières distinctes: ${twoWindows}`);

  const hasAutumn = results.filter((r) => !r.error && r.bestBullishAnnualWindows.some(
    (w) => w.startMonth >= 9 && w.startMonth <= 11,
  )).length;
  console.log(`  Tickers avec fenêtre automne détectée: ${hasAutumn}`);

  const answers = results.filter((r) => !r.error).map((r) => {
    const hasSep = r.bestBullishAnnualWindows.some((w) => w.startMonth >= 9 && w.startMonth <= 11);
    const autumnCand = r.autumnCandidates[0];
    return {
      ticker: r.ticker,
      "Sep/Oct→Dec existe?": hasSep ? "OUI" : "NON",
      "Meilleure automne": autumnCand ? `${autumnCand.displayLabel} [${autumnCand.strength}]` : "—",
      "bestBullishCount": r.bestBullishAnnualWindows.length,
    };
  });

  console.log("\n## Réponses questions TQQQ:");
  const tqqq = answers.find((r) => r.ticker === "TQQQ");
  if (tqqq) {
    console.log(`  1. Fenêtre Sep/Oct→Dec existe ? ${tqqq["Sep/Oct→Dec existe?"]}`);
    console.log(`  2. Meilleure fenêtre automne : ${tqqq["Meilleure automne"]}`);
    console.log(`  3. Nombre de fenêtres haussières distinctes : ${tqqq.bestBullishCount}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
