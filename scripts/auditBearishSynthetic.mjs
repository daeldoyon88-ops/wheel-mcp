/**
 * Diagnostic local sans Yahoo — simule tickers haussiers/baissiers et analyse les rejets.
 */
import {
  diagnoseBearishAnnualWindows,
  findBestAnnualBearishWindows,
  clearBestAnnualCache,
  buildPriceRowIndex,
  collectAnnualBearishGridCandidates,
  STRICT_STRENGTH_LABELS,
} from "../app/seasonality/seasonalityAnnualStats.js";

function makeTradingCalendar(startDate, numDays, getReturnForDay) {
  const rows = [];
  let price = 100;
  const d = new Date(startDate);
  while (rows.length < numDays) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      price = Number((price * getReturnForDay(d, rows.length)).toFixed(4));
      rows.push({ date: new Date(d), open: price, high: price, low: price, close: price });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return rows;
}

function makeBullWithSeasonalDips(numYears, dipMonths = [9, 10]) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));
  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const m = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (dipMonths.includes(m) && day >= 1 && day <= 22) return 0.985;
    return 1.003;
  });
}

function makePureBull(numYears) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  return makeTradingCalendar(new Date(Date.UTC(startYear, 0, 2)), numYears * 260, () => 1.003);
}

function makeSeptemberDrop(numYears) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  return makeTradingCalendar(new Date(Date.UTC(startYear, 0, 2)), numYears * 260, (date) => {
    const m = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (m === 9 && day >= 1 && day <= 28) return 0.992;
    return 1.0;
  });
}

function report(label, rows) {
  clearBestAnnualCache();
  const diag = diagnoseBearishAnnualWindows(label, rows, { skipCache: true, topRejected: 5 });
  const result = findBestAnnualBearishWindows(label, rows, { skipCache: true });

  console.log(`\n=== ${label} ===`);
  console.log(`  rows=${diag.rowsCount} | grid ${diag.gridCandidatesTotal}→${diag.gridCandidatesUsed} | tested=${diag.bearishAnnualCandidatesTested}`);
  console.log(`  bestBearish=${result.windows.length} | noStrong=${result.noStrongBearishAnnualWindow}`);
  console.log(`  avg5PositivePenalty=${diag.avg5PositivePenalty ?? 0}`);
  console.log(`  rejets:`, diag.rejectCounts);
  if (diag.bestRejectedCandidate) {
    const b = diag.bestRejectedCandidate;
    console.log(`  meilleure rejetée: ${b.displayLabel} | 15y=${b.annual15y} 5y=${b.annual5y} avg5=${((b.avgReturn5y ?? 0) * 100).toFixed(2)}% | ${b.rejectReason} | ${b.strength}`);
  }
  if (result.windows[0]) {
    console.log(`  GAGNANTE: ${result.windows[0].displayLabel} ${result.windows[0].strength}`);
  }

  const grid = collectAnnualBearishGridCandidates(buildPriceRowIndex(rows));
  const targets = diag.gridTargetCoverage;
  console.log(`  grille cible: ${targets.filter((t) => t.foundInGrid).map((t) => t.label).join(", ") || "aucune"}`);
  console.log(`  manquantes: ${targets.filter((t) => !t.foundInGrid).map((t) => t.label).join(", ") || "aucune"}`);

  return { diag, result, gridSize: grid.length };
}

console.log("=== DIAGNOSTIC SYNTHÉTIQUE (sans Yahoo) ===");

report("sept-drop-12y", makeSeptemberDrop(12));
report("bull-pur-15y", makePureBull(15));
report("bull+dip-sept-15y", makeBullWithSeasonalDips(15, [9]));
report("bull+dip-sept-oct-15y", makeBullWithSeasonalDips(15, [9, 10]));

// Test cross-year: nov→jan dip
const crossYear = makeTradingCalendar(
  new Date(Date.UTC(new Date().getUTCFullYear() - 16, 0, 2)),
  16 * 260,
  (date) => {
    const m = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if ((m === 11 && day >= 15) || m === 12 || (m === 1 && day <= 15)) return 0.988;
    return 1.002;
  },
);
report("nov-jan-dip-15y", crossYear);

// Inspect why september drop doesn't always win
clearBestAnnualCache();
const sepRows = makeSeptemberDrop(12);
const sepDiag = diagnoseBearishAnnualWindows("SEP", sepRows, { skipCache: true, topRejected: 10 });
console.log("\n=== TOP 10 REJETÉES (sept-drop-12y) ===");
for (const c of sepDiag.topRejectedBearishAnnualCandidates.slice(0, 5)) {
  console.log(`  ${c.displayLabel} | 15y=${c.annual15y} avg5=${((c.avgReturn5y ?? 0) * 100).toFixed(2)}% | ${c.rejectReason}`);
}
for (const c of sepDiag.topRejectedBearishAnnualCandidates.filter((x) => x.rejectReason === "accepted")) {
  console.log(`  ACCEPTÉE: ${c.displayLabel} | ${c.strength}`);
}
