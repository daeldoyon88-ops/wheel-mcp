/**
 * Audit local — pourquoi bestBearishAnnualWindows est vide ?
 * Usage: node scripts/auditBearishAnnualWindows.mjs [TICKER1,TICKER2,...]
 */

import { fetchHistoryRows, computeSeasonalityWindowsFromRows } from "../app/seasonality/seasonalityEngine.js";
import {
  diagnoseBearishAnnualWindows,
  clearBestAnnualCache,
} from "../app/seasonality/seasonalityAnnualStats.js";

const DEFAULT_TICKERS = [
  "TQQQ", "SOXL", "AMD", "NVDA", "TSLA",
  "AAPL", "AVGO", "SOFI", "PLTR", "APLD",
];

const REJECT_LABELS = {
  donnees_insuffisantes: "données insuffisantes",
  "15y_lt_10_sur_15": "15y < 10/15 baissier",
  "10y_lt_8_sur_10": "10y < 8/10 baissier",
  "5y_lt_4_sur_5": "5y < 4/5 baissier",
  "3y_lt_2_sur_3": "3y < 2/3 baissier",
  avgReturn15y_ge_0: "avgReturnAnnual 15y >= 0",
  medianReturn15y_ge_0: "medianReturnAnnual 15y >= 0",
  strongOpposite: "signal opposé fort",
  inDirection_lt_2_horizons: "< 2 horizons en direction baissière",
  faible: "force Faible seulement",
  autre: "autre",
  accepted: "acceptée",
};

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function formatRejectCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${REJECT_LABELS[k] ?? k}: ${v}`)
    .join("\n");
}

async function auditTicker(ticker) {
  clearBestAnnualCache();
  const rows = await fetchHistoryRows(ticker);
  if (!rows?.length) {
    return { ticker, error: "historique indisponible" };
  }

  const windows = computeSeasonalityWindowsFromRows(rows, {
    ticker,
    skipBestAnnualCache: true,
  });

  const diag = diagnoseBearishAnnualWindows(ticker, rows, {
    horizons: windows?.horizons,
    skipCache: true,
    topRejected: 5,
  });

  return {
    ticker,
    rowsCount: diag.rowsCount,
    yearsSpan: `${diag.firstYear}–${diag.lastCompleteYear}`,
    gridCandidatesTotal: diag.gridCandidatesTotal,
    gridCandidatesUsed: diag.gridCandidatesUsed,
    bearishAnnualCandidatesTested: diag.bearishAnnualCandidatesTested,
    bestBearishAnnualWindowsLength: diag.bestBearishAnnualWindowsCount,
    noStrongBearishAnnualWindow: diag.noStrongBearishAnnualWindow,
    strongBearishFound: diag.strongBearishFound,
    confirmedBearishFound: diag.confirmedBearishFound,
    primaryRejectReason: diag.primaryRejectReasonSummary,
    rejectCounts: diag.rejectCounts,
    avg5PositivePenalty: diag.avg5PositivePenalty,
    bestRejectedCandidate: diag.bestRejectedCandidate,
    topRejectedBearishAnnualCandidates: diag.topRejectedBearishAnnualCandidates,
    gridTargetCoverage: diag.gridTargetCoverage,
    swingBearishCount: windows?.swingWindows?.bearish?.length ?? 0,
    worstOverallBearish: windows?.summary?.worstOverallBearish?.label ?? null,
  };
}

async function main() {
  const arg = process.argv[2];
  const tickers = arg
    ? arg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_TICKERS;

  console.log("=== AUDIT bestBearishAnnualWindows ===\n");
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
    console.log(`  Candidats testés: ${r.bearishAnnualCandidatesTested}`);
    console.log(`  bestBearishAnnualWindows: ${r.bestBearishAnnualWindowsLength} (forte=${r.strongBearishFound}, confirmée=${r.confirmedBearishFound})`);
    console.log(`  noStrongBearishAnnualWindow: ${r.noStrongBearishAnnualWindow}`);
    console.log(`  Swing baissier glissant: ${r.swingBearishCount} fenêtres (pire: ${r.worstOverallBearish ?? "—"})`);
    console.log(`  avg5PositivePenalty: ${r.avg5PositivePenalty ?? 0} candidates avec avg5 > 0 (pénalité score, pas rejet)`);
    console.log(`  Raison principale de rejet: ${REJECT_LABELS[r.primaryRejectReason] ?? r.primaryRejectReason ?? "—"}`);
    console.log("  Compteurs de rejet:");
    console.log(formatRejectCounts(r.rejectCounts));

    if (r.bestRejectedCandidate) {
      const b = r.bestRejectedCandidate;
      console.log("  Meilleure candidate rejetée:");
      console.log(`    ${b.displayLabel} | 15y=${b.annual15y} 10y=${b.annual10y} 5y=${b.annual5y} 3y=${b.annual3y}`);
      console.log(`    avg15=${pct(b.avgReturn15y)} med15=${pct(b.medianReturn15y)} avg5=${pct(b.avgReturn5y)}`);
      console.log(`    force=${b.strength} | rejet=${REJECT_LABELS[b.rejectReason] ?? b.rejectReason}`);
    }

    const gridMissing = r.gridTargetCoverage.filter((g) => !g.foundInGrid);
    const gridFound = r.gridTargetCoverage.filter((g) => g.foundInGrid);
    console.log(`  Grille cible: ${gridFound.length}/${r.gridTargetCoverage.length} fenêtres mois→mois trouvées`);
    if (gridMissing.length) {
      console.log(`    Manquantes: ${gridMissing.map((g) => g.label).join(", ")}`);
    }

    if (r.bestBearishAnnualWindowsLength > 0) anyConfirmed += 1;
  }

  console.log("\n" + "=".repeat(72));
  console.log("\n## SYNTHÈSE");
  console.log(`  Tickers avec fenêtre baissière confirmée/forte: ${anyConfirmed}/${results.length}`);

  const horizon15Dominant = results.filter(
    (r) => !r.error && r.primaryRejectReason === "15y_lt_10_sur_15",
  ).length;

  console.log(`  Tickers où 15y<10/15 domine: ${horizon15Dominant}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
