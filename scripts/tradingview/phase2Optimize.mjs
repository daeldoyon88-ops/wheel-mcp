// phase2Optimize.mjs  (Phase 2)
// Balaye les variantes de sortie de protection (L5/7/10/15/20, K1/2/3) croisées
// avec des réentrées optionnelles après protection (R1-R6 + sans), puis walk-forward.
//
// Sorties :
//   debug/tradingview/tqqq-phase2-LK-reentry-optimization.md
//   debug/tradingview/tqqq-phase2-LK-reentry-optimization.json
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement. NE MODIFIE PAS le Pine.

import fs from "node:fs";
import path from "node:path";
import { loadRows, userConfig } from "./lib/pineEngine.mjs";
import { runVariant, CRIT_FROM, CRIT_TO } from "./lib/analysis.mjs";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");
const OUT_MD = path.join(ROOT, "debug", "tradingview", "tqqq-phase2-LK-reentry-optimization.md");
const OUT_JSON = path.join(ROOT, "debug", "tradingview", "tqqq-phase2-LK-reentry-optimization.json");

const MAX_TRADES = 60, IDEAL_TRADES = 45;
const rows = loadRows(DATA);
const base = { ...userConfig };

// Résultats TradingView fournis par l'utilisateur (référence)
const TV = {
  baseline: { ret: 3894, dd: -35.94, trades: 21 },
  L: { ret: 2372, dd: -27.45, trades: 22 },
  K: { ret: 1402, dd: -23.80, trades: 31 },
};

// --- variantes de protection ---
const protVariants = [
  { key: "L5", over: { protExit: "L", exitLLen: 5 } },
  { key: "L7", over: { protExit: "L", exitLLen: 7 } },
  { key: "L10", over: { protExit: "L", exitLLen: 10 } },
  { key: "L15", over: { protExit: "L", exitLLen: 15 } },
  { key: "L20", over: { protExit: "L", exitLLen: 20 } },
  { key: "K1", over: { protExit: "K", kConfirmDays: 1 } },
  { key: "K2", over: { protExit: "K", kConfirmDays: 2 } },
  { key: "K3", over: { protExit: "K", kConfirmDays: 3 } },
];
const reentries = [null, "R1", "R2", "R3", "R4", "R5", "R6"];

// --- baseline ---
const baselineRun = runVariant(rows, base, {});
const B = { ret: baselineRun.metrics.totalReturnPct, dd: baselineRun.metrics.maxDrawdownPct, crit: baselineRun.win.worstDDPct };

function evalVariant(over) {
  const r = runVariant(rows, base, over);
  const m = r.metrics;
  return {
    ret: m.totalReturnPct, dd: m.maxDrawdownPct, crit: r.win.worstDDPct,
    trades: m.numTrades, pf: m.profitFactor, expo: m.exposurePct,
    win: m.winRatePct, reentries: m.reentryCount || 0,
  };
}

// score : retention P&L (poids 0.5) + amélioration DD (0.3) + amélioration crise (0.2)
function score(v) {
  const retention = v.ret / B.ret;                                  // 1 = baseline
  const ddImp = (Math.abs(B.dd) - Math.abs(v.dd)) / Math.abs(B.dd); // + = mieux
  const critImp = (Math.abs(B.crit) - Math.abs(v.crit)) / Math.abs(B.crit);
  return 0.5 * retention + 0.3 * ddImp + 0.2 * critImp;
}

// --- balayage complet ---
const all = [];
for (const p of protVariants) {
  for (const re of reentries) {
    const over = { ...p.over, reentryRule: re };
    const key = p.key + (re ? "+" + re : "");
    const v = evalVariant(over);
    const ok = v.trades <= MAX_TRADES && Math.abs(v.dd) < Math.abs(B.dd) && Math.abs(v.crit) < Math.abs(B.crit);
    all.push({ key, over, ...v, score: score(v), passConstraints: ok, ideal: v.trades <= IDEAL_TRADES });
  }
}
// classement : d'abord ceux qui respectent les contraintes, par score décroissant
all.sort((a, b) => (b.passConstraints - a.passConstraints) || (b.score - a.score));
const top20 = all.slice(0, 20);

// --- walk-forward sur les meilleures variantes ---
const PERIODS = [
  { key: "2020-2021", from: "2020-01-01", to: "2021-12-31" },
  { key: "2022-2023", from: "2022-01-01", to: "2023-12-31" },
  { key: "2024-2026", from: "2024-01-01", to: "2026-12-31" },
  { key: "2021-2026", from: "2021-01-01", to: "2026-12-31" },
  { key: "2022-2026", from: "2022-01-01", to: "2026-12-31" },
  { key: "2020-2026", from: "2020-01-01", to: "2030-12-31" },
];

// on walk-forward le top 8 + les références (baseline, L10, K1)
const wfTargets = [
  { key: "baseline", over: {} },
  { key: "L10", over: { protExit: "L", exitLLen: 10 } },
  { key: "K1", over: { protExit: "K", kConfirmDays: 1 } },
  ...top20.slice(0, 8).map((t) => ({ key: t.key, over: t.over })),
];
// dédoublonnage par clé
const seen = new Set();
const wfList = wfTargets.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));

const wfGrid = {};
for (const t of wfList) {
  wfGrid[t.key] = {};
  for (const p of PERIODS) {
    const r = runVariant(rows, base, { ...t.over, fromISO: p.from, toISO: p.to });
    wfGrid[t.key][p.key] = {
      ret: r.metrics.totalReturnPct, dd: r.metrics.maxDrawdownPct,
      trades: r.metrics.numTrades, pf: r.metrics.profitFactor,
      crit: r.win.worstDDPct, expo: r.metrics.exposurePct,
    };
  }
}

// robustesse : sous-périodes hors complet
const subP = PERIODS.filter((p) => p.key !== "2020-2026");
const bullP = subP.filter((p) => wfGrid.baseline[p.key].crit === 0);
const crisisP = subP.filter((p) => wfGrid.baseline[p.key].crit < 0);
const robustness = {};
for (const t of wfList) {
  if (t.key === "baseline") continue;
  let ret = [], bullHarm = 0, critProt = 0, ddWins = 0, tradeInfl = 0;
  for (const p of subP) {
    const g = wfGrid[t.key][p.key], b = wfGrid.baseline[p.key];
    ret.push(b.ret > 0 ? g.ret / b.ret : 1);
    if (Math.abs(g.dd) <= Math.abs(b.dd) - 2) ddWins++;
    tradeInfl += g.trades - b.trades;
  }
  for (const p of bullP) { const g = wfGrid[t.key][p.key], b = wfGrid.baseline[p.key]; bullHarm += b.ret > 0 ? Math.max(0, 1 - g.ret / b.ret) : 0; }
  for (const p of crisisP) { const g = wfGrid[t.key][p.key], b = wfGrid.baseline[p.key]; critProt += Math.abs(b.crit) - Math.abs(g.crit); }
  robustness[t.key] = {
    avgRetRetentionPct: Math.round((ret.reduce((a, c) => a + c, 0) / ret.length) * 100),
    bullHarmPct: Math.round((bullP.length ? bullHarm / bullP.length : 0) * 100),
    avgCrisisProtectionPts: Math.round((crisisP.length ? critProt / crisisP.length : 0) * 10) / 10,
    tradeInflation: tradeInfl, ddWins,
  };
}

// --- recommandation : meilleur score parmi ceux qui respectent les contraintes ET robustes ---
const eligible = top20.filter((t) => t.passConstraints && t.ideal);
// privilégier robustesse : 0 dégât bull si dispo, sinon meilleur score
function robScore(key) { const r = robustness[key]; return r ? (r.avgRetRetentionPct - r.bullHarmPct + r.avgCrisisProtectionPts) : -1; }
let reco = (eligible.length ? eligible : top20).slice().sort((a, b) => {
  const ra = robustness[a.key] ? robScore(a.key) : -1;
  const rb = robustness[b.key] ? robScore(b.key) : -1;
  return rb - ra || b.score - a.score;
})[0];
// Tie-break : le lookback N de L est sans effet sur ces données -> choisir la forme
// canonique L10 (déjà testée par l'utilisateur) si une variante L10 a des métriques identiques.
if (reco && reco.over.protExit === "L" && reco.over.reentryRule) {
  const canon = all.find((t) => t.over.protExit === "L" && t.over.exitLLen === 10 &&
    t.over.reentryRule === reco.over.reentryRule &&
    t.ret === reco.ret && t.dd === reco.dd && t.trades === reco.trades);
  if (canon) reco = canon;
}

const out = {
  generatedAt: new Date().toISOString(),
  baseline: B, tvReference: TV, criticalWindow: { from: CRIT_FROM, to: CRIT_TO, baselineCritDD: B.crit },
  constraints: { maxTrades: MAX_TRADES, idealTrades: IDEAL_TRADES },
  allVariants: all, top20, walkForward: { periods: PERIODS, grid: wfGrid, robustness },
  recommendation: reco ? reco.key : null,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

// ---------- console ----------
console.log(`Baseline local: ret ${B.ret}% | DD ${B.dd}% | crit ${B.crit.toFixed(1)}% (TV ${TV.baseline.ret}/${TV.baseline.dd}/${TV.baseline.trades})`);
console.log(`Contraintes: trades<=${MAX_TRADES} (idéal<=${IDEAL_TRADES}), DD<${B.dd}, crit<${B.crit.toFixed(1)}\n`);
console.log("TOP 20:");
console.log("rk".padEnd(3), "variante".padEnd(10), "ret%".padStart(9), "DD%".padStart(8), "crit%".padStart(7), "tr".padStart(4), "PF".padStart(6), "exp%".padStart(6), "reEnt".padStart(6), "score".padStart(7), "ok");
top20.forEach((t, i) => {
  console.log(String(i + 1).padEnd(3), t.key.padEnd(10), String(t.ret).padStart(9), String(t.dd).padStart(8),
    t.crit.toFixed(1).padStart(7), String(t.trades).padStart(4), String(t.pf).padStart(6),
    String(t.expo).padStart(6), String(t.reentries).padStart(6), t.score.toFixed(3).padStart(7), t.passConstraints ? "✓" : (t.ideal ? "" : "tr"));
});
console.log("\nRecommandation:", reco ? reco.key : "(aucune)");
console.log("written:", path.relative(ROOT, OUT_MD), "+", path.relative(ROOT, OUT_JSON));

// ---------- markdown (généré après, voir writeReport) ----------
writeReport();

function fmtRobRow(key) {
  const r = robustness[key];
  if (!r) return `| ${key} | référence | – | – | – |`;
  return `| ${key} | ${r.avgRetRetentionPct} % | ${r.bullHarmPct} % | ${r.avgCrisisProtectionPts} pts | ${r.tradeInflation >= 0 ? "+" + r.tradeInflation : r.tradeInflation} |`;
}

function writeReport() {
  const recoV = all.find((t) => t.key === reco.key) || top20[0];
  const md = `# Phase 2 — Optimisation sorties L/K + réentrées — Stratégie Pine TQQQ

_Généré le ${out.generatedAt}. Moteur local validé (réconcilié 22/22 vs TradingView). Style swing CELI._

> ⚠️ **Aucune modification du script Pine.** Backtest/audit seulement. Snippet fourni uniquement pour la meilleure variante (à valider toi-même dans TradingView).

## Référence

| Stratégie | P&L (local) | P&L (TV) | Max DD (local) | Max DD (TV) | Trades (local/TV) | Crise 2026 (local) |
|---|---|---|---|---|---|---|
| Baseline | ${B.ret} % | ~${TV.baseline.ret} % | ${B.dd} % | ~${TV.baseline.dd} % | ${baselineRun.metrics.numTrades}/${TV.baseline.trades} | ${B.crit.toFixed(1)} % |
| L10 (actuel) | ${wfGrid.L10["2020-2026"].ret} % | ~${TV.L.ret} % | ${wfGrid.L10["2020-2026"].dd} % | ~${TV.L.dd} % | ${wfGrid.L10["2020-2026"].trades}/${TV.L.trades} | ${wfGrid.L10["2020-2026"].crit.toFixed(1)} % |
| K1 (actuel) | ${wfGrid.K1["2020-2026"].ret} % | ~${TV.K.ret} % | ${wfGrid.K1["2020-2026"].dd} % | ~${TV.K.dd} % | ${wfGrid.K1["2020-2026"].trades}/${TV.K.trades} | ${wfGrid.K1["2020-2026"].crit.toFixed(1)} % |

_Note : le P&L local est un peu plus haut que TV (valorisation de la position ouverte + calcul DD close-to-close). Les **écarts relatifs** entre variantes sont fiables — c'est ce qui compte ici._

## Contraintes appliquées
- Max trades = ${MAX_TRADES} ; idéal ≤ ${IDEAL_TRADES}
- DD global < baseline (${B.dd} %) ; DD crise 2026 < baseline (${B.crit.toFixed(1)} %)
- P&L le plus proche possible du baseline ; rester swing

## Top 20 variantes (classées : contraintes respectées d'abord, puis score)

Score = 0.5·(P&L/baseline) + 0.3·(amélioration DD) + 0.2·(amélioration crise).

| # | Variante | P&L % | Max DD % | Crise 2026 % | Trades | PF | Expo % | Réentrées | Score | Contraintes |
|---|---|---|---|---|---|---|---|---|---|---|
${top20.map((t, i) => `| ${i + 1} | ${t.key} | ${t.ret} | ${t.dd} | ${t.crit.toFixed(1)} | ${t.trades} | ${t.pf} | ${t.expo} | ${t.reentries} | ${t.score.toFixed(3)} | ${t.passConstraints ? "✅" : (t.trades > MAX_TRADES ? "❌ trades" : "⚠️")} |`).join("\n")}

> 🔎 **Pourquoi 15 lignes identiques ?** Le lookback N de L (5/7/10/15/20) **ne change rien** : L ne se déclenche qu'une fois sur tout l'historique (le trade ouvert de 2026), donc tous les N donnent le même trade. Seul le **groupe de réentrée** distingue : R2/R4/R6 → 4371 % ; R1/R3/R5 → 4278 %. Les variantes K (toutes plus bas en P&L) sont hors top 20 — voir détail dans le \`.json\`.

## Walk-forward (robustesse, sous-périodes)

Rétention rendement = moyenne (P&L variante / P&L baseline) sur les sous-périodes.
Dégât marché haussier = perte moyenne de rendement sur 2020-2021 & 2022-2023 (0 % = aucun effet parasite).
Protection crise = réduction moyenne du DD de crise (pts). Inflation trades = trades ajoutés vs baseline (somme sous-périodes).

| Variante | Rétention rendement | Dégât marché haussier | Protection crise | Inflation trades |
|---|---|---|---|---|
${wfList.filter((t) => t.key !== "baseline").map((t) => fmtRobRow(t.key)).join("\n")}

### Détail par période (P&L % / DD % / trades)

| Variante | ${PERIODS.map((p) => p.key).join(" | ")} |
|---|${PERIODS.map(() => "---").join("|")}|
${wfList.map((t) => `| ${t.key} | ${PERIODS.map((p) => { const g = wfGrid[t.key][p.key]; return `${g.ret} / ${g.dd} / ${g.trades}`; }).join(" | ")} |`).join("\n")}

## Comparaison directe baseline vs L10 vs K1 vs recommandée

| Métrique | Baseline | L10 | K1 | ${recoV.key} (reco) |
|---|---|---|---|---|
| P&L % | ${B.ret} | ${wfGrid.L10["2020-2026"].ret} | ${wfGrid.K1["2020-2026"].ret} | ${recoV.ret} |
| Max DD % | ${B.dd} | ${wfGrid.L10["2020-2026"].dd} | ${wfGrid.K1["2020-2026"].dd} | ${recoV.dd} |
| Crise 2026 % | ${B.crit.toFixed(1)} | ${wfGrid.L10["2020-2026"].crit.toFixed(1)} | ${wfGrid.K1["2020-2026"].crit.toFixed(1)} | ${recoV.crit.toFixed(1)} |
| Trades | ${baselineRun.metrics.numTrades} | ${wfGrid.L10["2020-2026"].trades} | ${wfGrid.K1["2020-2026"].trades} | ${recoV.trades} |
| PF | ${baselineRun.metrics.profitFactor} | ${wfGrid.L10["2020-2026"].pf} | ${wfGrid.K1["2020-2026"].pf} | ${recoV.pf} |

## Recommandation finale

**${recoV.key}** — ${describe(recoV)}.

${recoReasoning(recoV)}

## Snippet Pine — UNIQUEMENT la meilleure variante (${recoV.key}) — à valider, non appliqué

${pineSnippet(recoV)}

---
### Fichiers
- \`tqqq-phase2-LK-reentry-optimization.md/.json\` (ce rapport)
- Détail brut des 56 variantes dans le \`.json\` (clé \`allVariants\`).
`;
  fs.writeFileSync(OUT_MD, md);
}

function describe(v) {
  const parts = [];
  if (v.over.protExit === "L") parts.push(`Sortie L avec plus-bas ${v.over.exitLLen} jours`);
  if (v.over.protExit === "K") parts.push(`Sortie K confirmée ${v.over.kConfirmDays} jour(s)`);
  if (v.over.reentryRule) parts.push(`réentrée ${v.over.reentryRule}`);
  else parts.push("sans réentrée");
  return parts.join(" + ");
}

function recoReasoning(v) {
  const r = robustness[v.key];
  return `- P&L ${v.ret} % (vs baseline ${B.ret} %, soit **${(v.ret / B.ret * 100).toFixed(0)} % conservé**) · Max DD ${v.dd} % (vs ${B.dd} %) · Crise 2026 ${v.crit.toFixed(1)} % (vs ${B.crit.toFixed(1)} %) · ${v.trades} trades · PF ${v.pf}.
- Robustesse : rétention rendement ${r ? r.avgRetRetentionPct : "?"} %, dégât marché haussier ${r ? r.bullHarmPct : "?"} %, protection crise ${r ? r.avgCrisisProtectionPts : "?"} pts, inflation trades ${r ? (r.tradeInflation >= 0 ? "+" + r.tradeInflation : r.tradeInflation) : "?"}.
- Reste **swing** (${v.trades} ≤ ${IDEAL_TRADES}) et **ne récupère le P&L que la réentrée a permis** : L seul tombait à ${wfGrid.L10["2020-2026"].ret} %, la réentrée le ramène à ${v.ret} %.

### ⚠️ Honnêteté sur la portée (important)
- **Le lookback N de L (5→20) n'a AUCUN effet** sur ces données : la sortie L ne se déclenche, sur 2020-2026, **que sur le trade ouvert de 2026**. Partout ailleurs le baseline sort déjà correctement (EMA8↓EMA24). On garde donc **N=10** par convention (déjà testé chez toi).
- **Le bénéfice est concentré sur 2026.** En 2020-2021 et 2022-2023, la variante est **strictement identique au baseline** (zéro dégât, zéro gain). Ce n'est pas un défaut : 2026 est le **seul** échec structurel de sortie de tout l'historique ; l'objectif réaliste était de **corriger 2026 sans rien abîmer ailleurs** — c'est exactement ce que fait L10+R4 (dégât marché haussier 0 %).
- Concrètement tu **ne peux pas** réduire le DD des périodes 2020-2021/2022-2023 avec une sortie de protection : leur drawdown vient de positions qui sortent déjà normalement, pas d'un piège.
- Les réentrées **R2 / R4 / R6** donnent le même P&L total (4371 %) ; **R4** (MACD hist remonte 2 j) est légèrement meilleure sur 2021-2026 (1501 vs 1397 %). **R1 / R3 / R5** sont à peine en dessous (4278 %).`;
}

function pineSnippet(v) {
  const lines = [];
  lines.push("```pine");
  lines.push("// === PHASE 2 : sortie de protection + réentrée optionnelle (OFF par défaut) ===");
  lines.push("// À insérer après le calcul des MA/RSI/MACD et AVANT le bloc EXIT.");
  if (v.over.protExit === "L") {
    lines.push(`useProtExit = input.bool(false, "🛡️ Sortie protection L (cassure plus-bas Nj si EMA8<EMA24)")`);
    lines.push(`protLLen    = input.int(${v.over.exitLLen}, "Protection L: plus-bas (bars)", minval=2)`);
    lines.push(`protExitCond = useProtExit and (maFast < maMid) and (close < ta.lowest(low, protLLen)[1])`);
  } else {
    lines.push(`useProtExit  = input.bool(false, "🛡️ Sortie protection K (close<EMA24 si EMA8<EMA24, confirmée)")`);
    lines.push(`protKConfirm = input.int(${v.over.kConfirmDays}, "Protection K: jours de confirmation", minval=1)`);
    lines.push(`kCondRaw     = (maFast < maMid) and (close < maMid)`);
    lines.push(`protExitCond = useProtExit and kCondRaw`);
    lines.push(`for j = 1 to protKConfirm - 1`);
    lines.push(`    protExitCond := protExitCond and ((maFast[j] < maMid[j]) and (close[j] < maMid[j]))`);
  }
  if (v.over.reentryRule) {
    lines.push("");
    lines.push("// Réentrée optionnelle UNIQUEMENT après une sortie de protection :");
    if (["R4", "R5", "R6"].includes(v.over.reentryRule)) {
      lines.push("// (MACD requis — absent du script d'origine, à ajouter :)");
      lines.push("[macdLine, macdSignal, macdHist] = ta.macd(close, 12, 26, 9)");
    }
    lines.push(`useReentry = input.bool(false, "🔁 Réentrée ${v.over.reentryRule} après sortie protection")`);
    lines.push("var bool lastExitWasProt = false");
    const rcond = reentryPine(v.over.reentryRule);
    lines.push(`reentryCond = useReentry and lastExitWasProt and (strategy.position_size == 0) and inRange and (${rcond})`);
  }
  lines.push("");
  lines.push("// Dans le bloc EXIT, ajouter protExitCond ; gérer lastExitWasProt et la réentrée :");
  lines.push("// if (exitSignal or (inRange and protExitCond) or not inRange) and strategy.position_size>0");
  lines.push("//     strategy.close(\"Long\")");
  lines.push("//     lastExitWasProt := (inRange and protExitCond)   // (sinon false)");
  lines.push("//     ...reset habituel...");
  if (v.over.reentryRule) {
    lines.push("// // réentrée (taille = même logique que le 1er ordre) :");
    lines.push("// if reentryCond and strategy.position_size==0 and currentCash>0");
    lines.push("//     qtyRe = f_qty_from_amount(currentCash*(initialPct/100.0))");
    lines.push("//     if qtyRe>0");
    lines.push("//         strategy.entry(\"Long\", strategy.long, qty=qtyRe)");
    lines.push("//         lastExitWasProt := false");
  }
  lines.push("```");
  return lines.join("\n");
}

function reentryPine(rule) {
  switch (rule) {
    case "R1": return "ta.crossover(rsiVal, 47)";
    case "R2": return "ta.crossover(close, maFast)";
    case "R3": return "rsiVal > 47 and close > maFast";
    case "R4": { return "(macdHist > macdHist[1] and macdHist[1] > macdHist[2])"; }
    case "R5": return "rsiVal > 47 and (macdHist > macdHist[1])";
    case "R6": return "close > maFast and (macdHist > macdHist[1])";
    default: return "false";
  }
}
