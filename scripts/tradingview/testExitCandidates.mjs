// testExitCandidates.mjs  (Étape 5)
// Teste les sorties candidates A-H (sans ATR), ajoutées à la sortie baseline,
// sans modifier les entrées. Mesure P&L, DD, trades, PF, exposition, sorties
// supplémentaires, et si la période critique 2026-01-28→2026-03-30 est évitée.
//
// Sortie console + JSON intermédiaire réutilisé par le rapport final (Étape 7).
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement.

import fs from "node:fs";
import path from "node:path";
import { loadRows, userConfig } from "./lib/pineEngine.mjs";
import { runVariant, CRIT_FROM, CRIT_TO } from "./lib/analysis.mjs";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");
const OUT_JSON = path.join(ROOT, "debug", "tradingview", "tqqq-exit-candidates.json");

const rows = loadRows(DATA);
const base = { ...userConfig };

const CANDIDATES = {
  baseline: { exitCandidate: null, label: "Baseline (EMA8↓EMA24 seul)" },
  A: { exitCandidate: "A", label: "A) MASTER OFF (état EMA8<EMA34 master)" },
  B: { exitCandidate: "B", label: "B) MASTER OFF + close<MA8" },
  C: { exitCandidate: "C", label: "C) MASTER OFF + close<MA24" },
  D: { exitCandidate: "D", label: "D) close<MA8 + MACD hist baisse" },
  E: { exitCandidate: "E", label: "E) close<MA8 + RSI baisse" },
  F: { exitCandidate: "F", label: "F) close<MA8 + cassure plus-bas 5j" },
  G: { exitCandidate: "G", label: "G) top protection (MA8+hist+RSI+break5)" },
  H: { exitCandidate: "H", label: "H) post-extension (>10% MA50 puis close<MA8+hist baisse)" },
  I: { exitCandidate: "I", label: "I) close<MA24 (état)" },
  J: { exitCandidate: "J", label: "J) close<MA50 (état lent)" },
  K: { exitCandidate: "K", label: "K) EMA8<EMA24 ET close<MA24 (protège si bear)" },
  L: { exitCandidate: "L", label: "L) EMA8<EMA24 ET cassure plus-bas 10j (laisse courir)" },
  M: { exitCandidate: "M", label: "M) cassure plus-bas 10j seule (Donchian)" },
};

const baselineRun = runVariant(rows, base, { exitCandidate: null });
const baseM = baselineRun.metrics;
const baseTrades = baseM.numTrades;
const maxTrades = Math.round(baseTrades * 1.5);
const baseWinDD = baselineRun.win.worstDDPct;

const results = {};
for (const [key, c] of Object.entries(CANDIDATES)) {
  const r = runVariant(rows, base, { exitCandidate: c.exitCandidate });
  const m = r.metrics;
  // critères d'acceptation
  const tradesOk = m.numTrades <= maxTrades;
  const ddImproved = Math.abs(m.maxDrawdownPct) < Math.abs(baseM.maxDrawdownPct) - 1; // baisse nette (>1pt)
  const pfOk = Number(m.profitFactor === "Inf" ? 999 : m.profitFactor) >= 3; // PF ne s'effondre pas
  const pnlOk = m.totalReturnPct >= baseM.totalReturnPct * 0.5; // P&L pas détruit (>50% du baseline)
  const critAvoided = Math.abs(r.win.worstDDPct) <= Math.abs(baseWinDD) / 2 || r.win.inPosDays <= baselineRun.win.inPosDays / 2;
  results[key] = {
    label: c.label,
    metrics: m,
    win: r.win,
    candidateExits: r.candidateExits,
    extraTrades: m.numTrades - baseTrades,
    acceptance: { tradesOk, ddImproved, pfOk, pnlOk, critAvoided },
    accepted: tradesOk && ddImproved && pfOk && pnlOk,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  criticalWindow: { from: CRIT_FROM, to: CRIT_TO, baselineWorstDDPct: baseWinDD, baselineInPosDays: baselineRun.win.inPosDays },
  baselineTrades: baseTrades, maxAllowedTrades: maxTrades,
  results,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

// Console
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log(`Baseline: ret ${baseM.totalReturnPct}% | DD ${baseM.maxDrawdownPct}% | trades ${baseTrades} | PF ${baseM.profitFactor} | crit DD ${baseWinDD.toFixed(1)}%`);
console.log(`Max trades autorisés (×1.5): ${maxTrades}\n`);
console.log(pad("Cand", 6), padL("ret%", 9), padL("DD%", 8), padL("trades", 7), padL("PF", 7), padL("expo%", 7), padL("xExits", 7), padL("critDD%", 8), " accepté");
for (const [key, r] of Object.entries(results)) {
  const m = r.metrics;
  console.log(
    pad(key, 6), padL(m.totalReturnPct, 9), padL(m.maxDrawdownPct, 8), padL(m.numTrades, 7),
    padL(m.profitFactor, 7), padL(m.exposurePct, 7), padL(r.extraTrades >= 0 ? "+" + r.extraTrades : r.extraTrades, 7),
    padL(r.win.worstDDPct.toFixed(1), 8), " ", r.accepted ? "OUI" : "non",
    r.acceptance.critAvoided ? "(crit évitée)" : ""
  );
}
console.log("\nwritten:", path.relative(ROOT, OUT_JSON));
