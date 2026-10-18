// walkForward.mjs  (Étape 6)
// Robustesse des meilleures sorties sur sous-périodes. Classement par robustesse,
// pas seulement par P&L total.
//
// Sortie : debug/tradingview/tqqq-walkforward.json + console.
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement.

import fs from "node:fs";
import path from "node:path";
import { loadRows, userConfig } from "./lib/pineEngine.mjs";
import { runVariant } from "./lib/analysis.mjs";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");
const OUT_JSON = path.join(ROOT, "debug", "tradingview", "tqqq-walkforward.json");

const rows = loadRows(DATA);
const base = { ...userConfig };

const PERIODS = [
  { key: "2020-2021", from: "2020-01-01", to: "2021-12-31" },
  { key: "2022-2023", from: "2022-01-01", to: "2023-12-31" },
  { key: "2024-2026", from: "2024-01-01", to: "2026-12-31" },
  { key: "2021-2026 (post-COVID)", from: "2021-01-01", to: "2026-12-31" },
  { key: "2022-2026", from: "2022-01-01", to: "2026-12-31" },
  { key: "2020-2026 (complet)", from: "2020-01-01", to: "2030-12-31" },
];

// On garde les sorties les plus pertinentes de l'Étape 5
const VARIANTS = [
  { key: "baseline", exitCandidate: null },
  { key: "B", exitCandidate: "B" },
  { key: "C", exitCandidate: "C" },
  { key: "K", exitCandidate: "K" },
  { key: "L", exitCandidate: "L" },
];

const grid = {}; // grid[variant][period] = metrics
for (const v of VARIANTS) {
  grid[v.key] = {};
  for (const p of PERIODS) {
    const r = runVariant(rows, base, { exitCandidate: v.exitCandidate, fromISO: p.from, toISO: p.to });
    grid[v.key][p.key] = {
      ret: r.metrics.totalReturnPct, dd: r.metrics.maxDrawdownPct,
      trades: r.metrics.numTrades, pf: r.metrics.profitFactor,
      win: r.metrics.winRatePct, expo: r.metrics.exposurePct,
      critDD: r.win.worstDDPct,
    };
  }
}

// Score de robustesse : pour chaque sous-période (hors complet), une sortie "gagne"
// si elle améliore le DD vs baseline d'au moins 2 pts ET garde >=50% du rendement baseline ET PF>=2.5.
const subPeriods = PERIODS.filter((p) => p.key !== "2020-2026 (complet)");
// périodes "haussières sans crise" = critDD baseline == 0 -> on veut zéro dégât
const bullPeriods = subPeriods.filter((p) => grid.baseline[p.key].critDD === 0);
const crisisPeriods = subPeriods.filter((p) => grid.baseline[p.key].critDD < 0);
const robustness = {};
for (const v of VARIANTS) {
  if (v.key === "baseline") continue;
  let ddWins = 0, retKept = 0, pfOk = 0;
  let retRetentions = [], bullHarm = 0, tradeInflation = 0;
  const detail = [];
  for (const p of subPeriods) {
    const g = grid[v.key][p.key], b = grid.baseline[p.key];
    const ddImp = Math.abs(g.dd) <= Math.abs(b.dd) - 2;
    const retOk = g.ret >= b.ret * 0.5;
    const pf = Number(g.pf === "Inf" ? 999 : g.pf);
    const pfGood = pf >= 2.5;
    if (ddImp) ddWins++;
    if (retOk) retKept++;
    if (pfGood) pfOk++;
    retRetentions.push(b.ret > 0 ? g.ret / b.ret : 1);
    tradeInflation += (g.trades - b.trades);
    detail.push({ period: p.key, ddImp, retOk, pfGood, ret: g.ret, dd: g.dd, pf: g.pf, trades: g.trades });
  }
  // dégât en marché haussier : 1 - rétention moyenne sur périodes haussières (0 = parfait)
  for (const p of bullPeriods) {
    const g = grid[v.key][p.key], b = grid.baseline[p.key];
    bullHarm += b.ret > 0 ? Math.max(0, 1 - g.ret / b.ret) : 0;
  }
  bullHarm = bullPeriods.length ? bullHarm / bullPeriods.length : 0;
  const avgRet = retRetentions.reduce((a, b) => a + b, 0) / retRetentions.length;
  // protection crise moyenne
  let critProt = 0;
  for (const p of crisisPeriods) {
    const g = grid[v.key][p.key], b = grid.baseline[p.key];
    critProt += (Math.abs(b.critDD) - Math.abs(g.critDD));
  }
  critProt = crisisPeriods.length ? critProt / crisisPeriods.length : 0;
  robustness[v.key] = {
    ddWins, retKept, pfOk, score: ddWins + retKept + pfOk,
    avgRetRetentionPct: Math.round(avgRet * 100),
    bullHarmPct: Math.round(bullHarm * 100),
    tradeInflation, avgCrisisProtectionPts: Math.round(critProt * 10) / 10,
    detail,
  };
}

const out = { generatedAt: new Date().toISOString(), periods: PERIODS, variants: VARIANTS.map((v) => v.key), grid, robustness };
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

// Console
for (const p of PERIODS) {
  console.log("\n=== " + p.key + " (" + p.from + " → " + p.to + ") ===");
  console.log("var".padEnd(10), "ret%".padStart(9), "DD%".padStart(8), "trades".padStart(7), "PF".padStart(7), "critDD%".padStart(8));
  for (const v of VARIANTS) {
    const g = grid[v.key][p.key];
    console.log(v.key.padEnd(10), String(g.ret).padStart(9), String(g.dd).padStart(8), String(g.trades).padStart(7), String(g.pf).padStart(7), g.critDD.toFixed(1).padStart(8));
  }
}
console.log("\n=== Robustesse (sous-périodes, hors complet) ===");
console.log("var".padEnd(10), "rétentRet%".padStart(11), "dégâtBull%".padStart(11), "protCrise±pts".padStart(13), "infTrades".padStart(10), "ddWins".padStart(7));
for (const [k, r] of Object.entries(robustness)) {
  console.log(k.padEnd(10), String(r.avgRetRetentionPct).padStart(11), String(r.bullHarmPct).padStart(11), String(r.avgCrisisProtectionPts).padStart(13), String(r.tradeInflation >= 0 ? "+" + r.tradeInflation : r.tradeInflation).padStart(10), String(r.ddWins).padStart(7));
}
console.log("\nwritten:", path.relative(ROOT, OUT_JSON));
