/**
 * Audit READ-ONLY — entête Saisonnalité V2 PRO (résumé stats).
 * Reproduit la logique de wheel-dashboard/src/components/SeasonalityPanel.jsx (useMemo summary).
 *
 * Usage: node scripts/auditSeasonalityHeaderScore.mjs [TICKER]
 */

import {
  fetchHistoryRows,
  computeShortTermFromRows,
  computeSeasonalityWindowsFromRows,
} from "../app/seasonality/seasonalityEngine.js";
import { createSeasonalityPersistentCache } from "../app/seasonality/seasonalityPersistentCache.js";

const ticker = (process.argv[2] ?? "TQQQ").trim().toUpperCase();
const USE_CACHE = process.argv.includes("--cache") || process.argv.includes("--from-cache");

const MONTHS_FR_LONG = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

// ─── Miroir SeasonalityPanel.jsx ───────────────────────────────────────────────

function formatWinRate(val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return "—";
  return `${Math.round(val * 100)}%`;
}

function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (d) => `${d.getDate()} ${MONTHS_FR_LONG[d.getMonth()].slice(0, 3)}.`;
  const weekNum = Math.ceil((((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1) / 7);
  return { range: `${fmt(mon)} → ${fmt(sun)}`, weekNum: `Semaine ${weekNum}` };
}

function seasonalWindowPrimaryLabel(w) {
  return w?.displayLabel || w?.label || "—";
}

function verdictLabel(verdict) {
  const map = {
    favorable: "Favorable",
    defavorable: "Défavorable",
    neutre: "Neutre",
    risque_hausse: "Risque hausse",
    bullish: "Haussier",
    bearish: "Baissier",
  };
  return map[String(verdict ?? "").toLowerCase()] ?? String(verdict ?? "—");
}

function computeTendance(win) {
  if (!win) return { tendance: "N/D", tendanceBias: "neutral" };
  const wr = win.winRate || 0;
  const csp = win.cspVerdict;
  if (csp === "favorable" && wr >= 0.70) return { tendance: "Haussière forte", tendanceBias: "green" };
  if (csp === "favorable") return { tendance: "Haussière modérée", tendanceBias: "green" };
  if (csp === "defavorable" && wr <= 0.35) return { tendance: "Baissière forte", tendanceBias: "red" };
  if (csp === "defavorable") return { tendance: "Baissière modérée", tendanceBias: "red" };
  return { tendance: "Neutre", tendanceBias: "yellow" };
}

/** Détail du calcul force saisonnière — miroir exact SeasonalityPanel.jsx L3518–3526 */
function computeForceSeasonniereDetail(win) {
  if (!win) return null;

  const winRate = win.winRate || 0;
  const avgReturn = win.avgReturn || 0;
  const pctBelow5 = win.pctBelow5 || 0;

  const winComp = winRate * 40;
  const retNormRaw = avgReturn / 0.05;
  const retNorm = Math.min(Math.max(retNormRaw, -1), 1);
  const retComp = ((retNorm + 1) / 2) * 30;
  const riskPenaltyFactor = Math.min(pctBelow5 * 3, 1);
  const riskComp = (1 - riskPenaltyFactor) * 30;
  const scoreBeforeClamp = winComp + retComp + riskComp;
  const scoreAfterClamp = Math.max(0, Math.min(100, scoreBeforeClamp));
  const scoreFinal = Math.round(scoreAfterClamp);

  const gaugeLabel = scoreFinal >= 65 ? "Favorable" : scoreFinal >= 35 ? "Modéré" : "Faible";

  return {
    inputs: { winRate, avgReturn, pctBelow5 },
    components: {
      winRate: { raw: winRate, weight: 40, contribution: winComp, formula: "winRate × 40" },
      avgReturn: {
        raw: avgReturn,
        retNormRaw,
        retNorm,
        weight: 30,
        contribution: retComp,
        formula: "((clamp(avgReturn/0.05, -1, 1) + 1) / 2) × 30",
      },
      downsideRisk: {
        raw: pctBelow5,
        penaltyFactor: riskPenaltyFactor,
        weight: 30,
        contribution: riskComp,
        formula: "(1 - min(pctBelow5 × 3, 1)) × 30",
      },
    },
    scoreBeforeClamp,
    scoreAfterClamp,
    scoreFinal,
    gaugeLabel,
  };
}

function buildHeaderSummary(shortTermData, windowsData) {
  const win7 = shortTermData?.windows?.find((w) => w.days === 7);
  const win = win7 ?? shortTermData?.windows?.[0] ?? null;
  const active = windowsData?.summary?.activeNow?.[0] ?? null;
  const best = windowsData?.summary?.bestOverallBullish ?? null;
  const { range, weekNum } = getCurrentWeekRange();
  const tendance = computeTendance(win);
  const forceDetail = computeForceSeasonniereDetail(win);

  return {
    range,
    weekNum,
    ...tendance,
    forceDetail,
    winRate7j: win7?.winRate ?? null,
    downside7j: win7?.pctBelow5 ?? null,
    cspVerdict7j: win7?.cspVerdict ?? null,
    ccVerdict7j: win7?.ccVerdict ?? null,
    win7Full: win7 ?? null,
    forceWindowUsed: win?.label ?? win?.days ? `${win.days}j` : null,
    ltBias: active
      ? (active.avgReturn > 0 && active.winRate >= 0.5 ? "bullish" : "bearish")
      : (best ? "bullish" : null),
    ltLabel: active ? seasonalWindowPrimaryLabel(active) : (best ? seasonalWindowPrimaryLabel(best) : null),
    ltSource: active ? "windows.summary.activeNow[0]" : (best ? "windows.summary.bestOverallBullish (fallback)" : null),
    activeNow: active,
    bestOverallBullish: best,
  };
}

function pctSigned(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}

function printReport(summary) {
  const f = summary.forceDetail;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`AUDIT ENTÊTE SAISONNALITÉ V2 PRO`);
  console.log(`${"=".repeat(72)}\n`);

  console.log(`Ticker: ${ticker}`);
  console.log(`Source données: Yahoo Finance (historique daily)`);
  console.log(`Fenêtre calendaire actuelle (UI): ${summary.range} (${summary.weekNum})`);
  console.log(`Tendance actuelle (7j): ${summary.tendance}`);
  console.log("");

  console.log(`── Métriques court terme 7j ──`);
  console.log(`7j positif: ${formatWinRate(summary.winRate7j)}`);
  console.log(`Risque baisse 7j (pctBelow5): ${formatWinRate(summary.downside7j)}`);
  console.log(`CSP (7j): ${verdictLabel(summary.cspVerdict7j)} (${summary.cspVerdict7j ?? "—"})`);
  console.log(`CC (7j): ${verdictLabel(summary.ccVerdict7j)} (${summary.ccVerdict7j ?? "—"})`);

  if (summary.win7Full) {
    const w = summary.win7Full;
    console.log(`\n  Données brutes fenêtre 7j (backend computeShortTermFromRows):`);
    console.log(`    sampleSize: ${w.sampleSize}`);
    console.log(`    avgReturn: ${pctSigned(w.avgReturn, 3)}`);
    console.log(`    winRate: ${formatWinRate(w.winRate)}`);
    console.log(`    pctBelow5: ${formatWinRate(w.pctBelow5)}`);
    console.log(`    pctBelow10: ${formatWinRate(w.pctBelow10)}`);
    console.log(`    pctAbove5: ${formatWinRate(w.pctAbove5)}`);
    console.log(`    pctAbove10: ${formatWinRate(w.pctAbove10)}`);
  }

  console.log(`\n── Biais long terme (indépendant du score force) ──`);
  console.log(`Biais long terme: ${verdictLabel(summary.ltBias)}`);
  console.log(`Fenêtre long terme affichée: ${summary.ltLabel ?? "—"}`);
  console.log(`Source LT: ${summary.ltSource ?? "—"}`);
  if (summary.activeNow) {
    const a = summary.activeNow;
    console.log(`  activeNow: horizon=${a.horizonYears}y windowDays=${a.windowDays} avgReturn=${pctSigned(a.avgReturn)} winRate=${formatWinRate(a.winRate)} score=${a.score?.toFixed?.(2) ?? a.score}`);
  }

  console.log(`\n── Force saisonnière ──`);
  console.log(`Fenêtre utilisée pour le score: ${summary.forceWindowUsed ?? "—"} (win7 ?? première fenêtre)`);
  if (!f) {
    console.log(`Force saisonnière finale: N/D (données 7j absentes)`);
    return;
  }

  console.log(`Force saisonnière finale: ${f.scoreFinal}/100 — ${f.gaugeLabel}`);
  console.log(`\nDétail du calcul (SeasonalityPanel.jsx L3518–3526, frontend uniquement):`);
  console.log(`  A) Win rate court terme`);
  console.log(`     brute: ${formatWinRate(f.components.winRate.raw)} (${f.components.winRate.raw})`);
  console.log(`     poids max: ${f.components.winRate.weight}`);
  console.log(`     contribution: ${f.components.winRate.contribution.toFixed(2)}`);
  console.log(`     formule: ${f.components.winRate.formula}`);

  console.log(`  B) Rendement moyen (avgReturn)`);
  console.log(`     brute: ${pctSigned(f.components.avgReturn.raw, 4)} (${f.components.avgReturn.raw})`);
  console.log(`     retNormRaw (avgReturn/0.05): ${f.components.avgReturn.retNormRaw.toFixed(4)}`);
  console.log(`     retNorm clampé [-1,1]: ${f.components.avgReturn.retNorm.toFixed(4)}`);
  console.log(`     poids max: ${f.components.avgReturn.weight}`);
  console.log(`     contribution: ${f.components.avgReturn.contribution.toFixed(2)}`);
  console.log(`     formule: ${f.components.avgReturn.formula}`);

  console.log(`  C) Risque baisse (pctBelow5)`);
  console.log(`     brute: ${formatWinRate(f.components.downsideRisk.raw)} (${f.components.downsideRisk.raw})`);
  console.log(`     facteur pénalité min(pctBelow5×3, 1): ${f.components.downsideRisk.penaltyFactor.toFixed(4)}`);
  console.log(`     poids max: ${f.components.downsideRisk.weight}`);
  console.log(`     contribution: ${f.components.downsideRisk.contribution.toFixed(2)}`);
  console.log(`     formule: ${f.components.downsideRisk.formula}`);

  console.log(`\n  bonus/malus fenêtre annuelle: AUCUN (non implémenté)`);
  console.log(`  bonus/malus biais long terme: AUCUN (non implémenté)`);
  console.log(`  score avant clamp: ${f.scoreBeforeClamp.toFixed(2)}`);
  console.log(`  score après clamp [0,100]: ${f.scoreAfterClamp.toFixed(2)}`);
  console.log(`  score final arrondi: ${f.scoreFinal}`);

  const sumCheck =
    f.components.winRate.contribution +
    f.components.avgReturn.contribution +
    f.components.downsideRisk.contribution;
  console.log(`\n  Vérification somme composantes: ${sumCheck.toFixed(2)} (≈ score avant clamp)`);

  console.log(`\n── Seuils verdicts CSP/CC (backend seasonalityEngine.js) ──`);
  console.log(`  CSP favorable: winRate≥60% ET avgReturn≥0 ET pctBelow5≤20% ET pctBelow10≤8%`);
  console.log(`  CSP défavorable: pctBelow5≥35% OU pctBelow10≥15% OU (avgReturn<0 ET winRate<50%)`);
  console.log(`  CSP neutre: sinon`);
  console.log(`  CC risque_hausse: pctAbove5≥30% OU pctAbove10≥12% OU (avgReturn>3% ET winRate≥60%)`);
  console.log(`  CC favorable: pctAbove5≤15% ET pctAbove10≤5% ET avgReturn≤1%`);
  console.log(`  CC neutre: sinon`);

  console.log(`\n── Diagnostic ambiguïté ──`);
  console.log(`  • "7j positif" = winRate glissant historique (fenêtres 7 jours ouvrables)`);
  console.log(`  • "Force saisonnière" = score composite 7j ONLY (40/30/30), PAS le biais LT`);
  console.log(`  • "Biais long terme" = fenêtre saisonnière activeNow (20–90j calendaires)`);
  console.log(`  • "Fenêtre actuelle" (entête) = semaine civile lun→dim, PAS la fenêtre LT`);
  if (summary.winRate7j != null && f) {
    const winOnly = Math.round(f.components.winRate.contribution);
    console.log(`  • Si force ≈ winRate seul (${winOnly}), avgReturn et pctBelow5 tirent le score`);
  }
  console.log("");
}

async function loadSeasonalityData() {
  if (USE_CACHE) {
    const cache = createSeasonalityPersistentCache();
    await cache.ensureInitialized();
    const entry = cache.getCache(ticker);
    if (!entry?.payload) {
      throw new Error(`Cache SQLite absent pour ${ticker} — lancer le dashboard ou /seasonality/${ticker}/bundle`);
    }
    console.log(`(source: cache SQLite, computed_at=${entry.computed_at ?? "?"})`);
    return {
      shortTermData: entry.payload.shortTermData ?? null,
      windowsData: entry.payload.windowsData ?? null,
      fromCache: true,
    };
  }

  console.log(`(source: Yahoo Finance live)`);
  const rows = await fetchHistoryRows(ticker);
  if (!rows?.length) {
    throw new Error(`Historique indisponible pour ${ticker}`);
  }
  return {
    shortTermData: computeShortTermFromRows(rows),
    windowsData: computeSeasonalityWindowsFromRows(rows, { ticker, skipBestAnnualCache: true }),
    fromCache: false,
  };
}

async function main() {
  console.log(`Chargement ${ticker}…`);
  let data;
  try {
    data = await loadSeasonalityData();
  } catch (liveErr) {
    if (USE_CACHE) throw liveErr;
    console.warn(`${liveErr.message} — tentative cache SQLite…`);
    const cache = createSeasonalityPersistentCache();
    await cache.ensureInitialized();
    const entry = cache.getCache(ticker);
    if (!entry?.payload) throw liveErr;
    console.log(`(source: cache SQLite fallback, computed_at=${entry.computed_at ?? "?"})`);
    data = {
      shortTermData: entry.payload.shortTermData ?? null,
      windowsData: entry.payload.windowsData ?? null,
    };
  }

  if (!data?.shortTermData?.windows?.length) {
    console.error("shortTermData absent ou sans fenêtres.");
    process.exit(1);
  }

  printReport(buildHeaderSummary(data.shortTermData, data.windowsData));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
