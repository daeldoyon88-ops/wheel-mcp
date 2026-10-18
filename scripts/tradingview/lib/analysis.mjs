// analysis.mjs — helpers partagés pour Étapes 5-7
import { computeIndicators, runStrategy } from "./pineEngine.mjs";

export const CRIT_FROM = "2026-01-28";
export const CRIT_TO = "2026-03-30";

// Statistiques sur une fenêtre : pire DD non réalisé en position + jours en position
export function windowStats(rows, res, fromISO, toISO) {
  const ft = new Date(fromISO + "T00:00:00Z").getTime();
  const tt = new Date(toISO + "T23:59:59Z").getTime();
  let worstDD = 0, inPosDays = 0, windowDays = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].t < ft || rows[i].t > tt) continue;
    windowDays++;
    const tr = res.trades.find((t) => i >= t.entryBar && i <= t.exitBar);
    if (tr) {
      inPosDays++;
      const dd = (rows[i].close / tr.entryPrice - 1) * 100;
      if (dd < worstDD) worstDD = dd;
    }
  }
  return { worstDDPct: worstDD, inPosDays, windowDays };
}

// Lance une config et renvoie métriques + stats fenêtre critique + comptage sorties candidates
export function runVariant(rows, baseCfg, over, critFrom = CRIT_FROM, critTo = CRIT_TO) {
  const cfg = { ...baseCfg, ...over };
  const ind = computeIndicators(rows, cfg);
  const res = runStrategy(rows, ind, cfg);
  const win = windowStats(rows, res, critFrom, critTo);
  const candidateExits = res.trades.filter((t) => String(t.reason).startsWith("candidate")).length;
  return { cfg, res, metrics: res.metrics, win, candidateExits };
}
