/**
 * Audit READ-ONLY — sources UI saisonnalité vs backend.
 * Usage: node scripts/auditSeasonalityUiSources.mjs [TICKER]
 */

import { fetchHistoryRows, computeSeasonalityWindowsFromRows } from "../app/seasonality/seasonalityEngine.js";
import { computeSeasonalityChart3y, buildSeasonalityChart3yFromRows } from "../app/seasonality/seasonalityChart3y.js";
import { selectAdaptiveSwingSeasonalityWindows } from "../app/seasonality/seasonalitySwingWindows.js";
import {
  findBestAnnualBearishWindows,
  diagnoseBearishAnnualWindows,
  buildPriceRowIndex,
  clearBestAnnualCache,
  getStrictMultiHorizonStrength,
  selectRecentBearishVigilanceWindows,
  STRICT_STRENGTH_LABELS,
} from "../app/seasonality/seasonalityAnnualStats.js";

const ticker = (process.argv[2] ?? "TQQQ").trim().toUpperCase();

function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

function fmtWin(w) {
  if (!w) return "—";
  return `${w.displayLabel ?? w.label ?? "?"} [${w.strength ?? "?"}] avg15=${pct(w.avgReturnAnnual)}`;
}

function isRecentStrongBearish(w) {
  const ah = w?.annualHorizons;
  if (!ah) return false;
  const s3 = ah["3y"];
  const s5 = ah["5y"];
  const s10 = ah["10y"];
  const s15 = ah["15y"];
  const strength = w.strength ?? getStrictMultiHorizonStrength(w, "bearish");
  if (isStrongOrConfirmed(strength)) return false;

  const neg3 = s3 && !s3.insufficient && (s3.negativeYears ?? 0) === s3.yearsCount;
  const neg5 = s5 && !s5.insufficient && (s5.negativeYears ?? 0) === s5.yearsCount;
  const avg5neg = s5 && !s5.insufficient && (s5.avgReturnAnnual ?? 0) < 0;
  const calDays = w.calDays ?? null;

  return (neg3 || neg5) && avg5neg && (calDays == null || calDays >= 28);
}

function isStrongOrConfirmed(s) {
  return s === STRICT_STRENGTH_LABELS.FORTE || s === STRICT_STRENGTH_LABELS.CONFIRMEE;
}

function ratio(stats, dir) {
  if (!stats || stats.insufficient) return "—";
  const n = dir === "bearish" ? stats.negativeYears : stats.positiveYears;
  return `${n}/${stats.yearsCount}`;
}

async function main() {
  clearBestAnnualCache();
  console.log(`\n=== AUDIT UI SOURCES — ${ticker} ===\n`);

  const rows = await fetchHistoryRows(ticker);
  if (!rows?.length) {
    console.log("Historique indisponible.");
    return;
  }

  const windows = computeSeasonalityWindowsFromRows(rows, { ticker, skipBestAnnualCache: true });
  const index = buildPriceRowIndex(rows);
  const chartSwing = selectAdaptiveSwingSeasonalityWindows(windows, { maxBullish: 2, maxBearish: 2 });
  const chart3y = buildSeasonalityChart3yFromRows(rows, chartSwing, { symbol: ticker });

  console.log("── Champs API /windows disponibles ──");
  const topKeys = [
    "bestBullishAnnualWindows",
    "bestBearishAnnualWindows",
    "noStrongBearishAnnualWindow",
    "noStrongBullishAnnualWindow",
    "bestAnnualWindow",
    "swingWindows",
    "bearishAnnualMeta",
    "bullishAnnualMeta",
    "horizons",
    "distinct",
    "clusters",
    "summary",
  ];
  for (const k of topKeys) {
    const v = windows?.[k];
    if (v == null) {
      console.log(`  ${k}: absent`);
      continue;
    }
    if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]`);
    else if (typeof v === "object") console.log(`  ${k}: object (${Object.keys(v).slice(0, 8).join(", ")}…)`);
    else console.log(`  ${k}: ${v}`);
  }

  console.log("\n── 1. Panneau « Saisonnalité annuelle réelle » ──");
  console.log("  Source haussier: windows.bestBullishAnnualWindows → groupBullishAnnualWindowsForDisplay (UI)");
  for (const w of windows?.bestBullishAnnualWindows ?? []) {
    console.log(`    ${fmtWin(w)}`);
  }
  console.log("  Source baissier: windows.bestBearishAnnualWindows");
  if ((windows?.bestBearishAnnualWindows ?? []).length === 0) {
    console.log("    (vide — message « Aucune fenêtre baissière annuelle confirmée »)");
  }
  for (const w of windows?.bestBearishAnnualWindows ?? []) {
    console.log(`    ${fmtWin(w)}`);
  }
  console.log(`  bestAnnualWindow (legacy, diagnostic avancé): ${windows?.bestAnnualWindow?.window?.displayLabel ?? "—"}`);

  console.log("\n── 2. Carte saisonnière cumulée ──");
  console.log("  Ligne violette: /calendar → months[].avgReturn (rendement mensuel moyen)");
  console.log("  Zones vertes: swingWindows.bullish[0..1] — champ avgReturn (GLISSANT)");
  for (const [i, w] of (windows?.swingWindows?.bullish ?? []).slice(0, 2).entries()) {
    console.log(`    Haussier #${i + 1}: ${w.displayLabel} avgReturn=${pct(w.avgReturn)} strength=${w.strength ?? "—"}`);
  }
  console.log("  Zones rouges: swingWindows.bearish[0..1] — champ avgReturn (GLISSANT)");
  for (const [i, w] of (windows?.swingWindows?.bearish ?? []).slice(0, 2).entries()) {
    console.log(`    Baissier #${i + 1}: ${w.displayLabel} avgReturn=${pct(w.avgReturn)} strength=${w.strength ?? "—"}`);
  }
  console.log(`  ≠ bestBearishAnnualWindows (count=${windows?.bestBearishAnnualWindows?.length ?? 0})`);

  console.log("\n── 3. Graphique 3 ans ──");
  console.log("  swingOverlays: selectAdaptiveSwingSeasonalityWindows(max 2/2) → buildSwingOverlays");
  for (const o of chart3y?.swingOverlays ?? []) {
    const realYears = (o.occurrences ?? []).filter((x) => x.status === "complete").length;
    console.log(`    ${o.type} #${o.rank}: ${o.displayLabel} expectedReturn=${pct(o.expectedReturn)} (${realYears} occ. annuelles tracées)`);
  }
  console.log(`  activeWindowProgress: ${chart3y?.activeWindowProgress?.isActive ? chart3y.activeWindowProgress.displayLabel : "aucune"}`);

  console.log("\n── 4. Faiblesses récentes non confirmées (candidats baissiers) ──");
  const bearAll = findBestAnnualBearishWindows(ticker, rows, {
    horizons: windows?.horizons,
    index,
    skipCache: true,
  });

  const recentStrong = (bearAll.allScored ?? [])
    .filter(isRecentStrongBearish)
    .sort((a, b) => (a.annualHorizons?.["5y"]?.avgReturnAnnual ?? 0) - (b.annualHorizons?.["5y"]?.avgReturnAnnual ?? 0))
    .slice(0, 10);

  const vigilance = selectRecentBearishVigilanceWindows(
    bearAll.allScored ?? [],
    bearAll.windows ?? [],
  );
  console.log(`  recentBearishVigilance (API): ${windows?.recentBearishVigilance?.length ?? 0} fenêtre(s)`);
  for (const v of windows?.recentBearishVigilance ?? []) {
    console.log(`    ${v.displayLabel} [${v.status}] reject=${v.rejectReason} avg5=${pct(v.avgReturnAnnual5y)}`);
  }
  console.log(`  allScored total: ${bearAll.allScored?.length ?? 0}`);
  console.log(`  Récentes fortes (3y=3/3 ou 5y=5/5, avg5<0, non Confirmée/Forte): ${recentStrong.length}`);
  for (const w of recentStrong.slice(0, 5)) {
    const ah = w.annualHorizons ?? {};
    console.log(`    ${w.displayLabel} [${w.strength}] 3y=${ratio(ah["3y"], "bearish")} 5y=${ratio(ah["5y"], "bearish")} 10y=${ratio(ah["10y"], "bearish")} 15y=${ratio(ah["15y"], "bearish")} avg5=${pct(ah["5y"]?.avgReturnAnnual)} avg15=${pct(ah["15y"]?.avgReturnAnnual)}`);
  }

  console.log("\n── 5. TQQQ fenêtre 15 fév → 15 mars (si présente) ──");
  const febMar = (bearAll.allScored ?? []).filter((w) => {
    const l = (w.displayLabel ?? "").toLowerCase();
    return l.includes("fév") && l.includes("mars");
  });
  if (febMar.length === 0) {
    console.log("  Pas trouvée dans allScored — recherche par startMonth=2 endMonth=3…");
    const alt = (bearAll.allScored ?? []).filter((w) => w.startMonth === 2 && w.endMonth === 3);
    for (const w of alt.slice(0, 3)) {
      printWindowTable(w);
    }
  } else {
    for (const w of febMar.slice(0, 3)) printWindowTable(w);
  }

  const diag = diagnoseBearishAnnualWindows(ticker, rows, {
    horizons: windows?.horizons,
    skipCache: true,
    topRejected: 8,
  });
  console.log("\n── 6. Diagnostic rejet baissier ──");
  console.log(`  Raison principale: ${diag.primaryRejectReasonSummary}`);
  console.log(`  Rejetés seulement 15y: ${diag.rejectCounts?.["15y_lt_10_sur_15"] ?? 0}`);
  console.log(`  Avec 5y=5/5 mais rejetées: ${(diag.topRejectedBearishAnnualCandidates ?? []).filter((c) => c.annual5y === "5/5").length} (dans top rejetées)`);
}

function printWindowTable(w) {
  const ah = w.annualHorizons ?? {};
  const reject = w.strength === STRICT_STRENGTH_LABELS.FORTE || w.strength === STRICT_STRENGTH_LABELS.CONFIRMEE
    ? "acceptée"
    : "non confirmée long terme";
  console.log(`\n  Fenêtre: ${w.displayLabel}`);
  console.log(`  | 3y | 5y | 10y | 15y | avg5 | avg10 | avg15 | interprétation |`);
  console.log(`  | ${ratio(ah["3y"], "bearish")} | ${ratio(ah["5y"], "bearish")} | ${ratio(ah["10y"], "bearish")} | ${ratio(ah["15y"], "bearish")} | ${pct(ah["5y"]?.avgReturnAnnual)} | ${pct(ah["10y"]?.avgReturnAnnual)} | ${pct(ah["15y"]?.avgReturnAnnual)} | ${reject} |`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
