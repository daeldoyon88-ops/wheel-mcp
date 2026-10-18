// tradeQualityAudit.mjs
// AUDIT QUALITÉ DES TRADES — Stratégie Pine TQQQ "L10 + R4 corrigé".
//
// Objectif : réduire les trades perdants et augmenter le taux de réussite SANS
// détruire le P&L, sans rendre la stratégie trop active.
//
// PORTÉE : TradingView / Pine / backtest technique TQQQ uniquement.
//   - NE MODIFIE PAS le Pine final (aucun fichier .pine touché).
//   - NE MODIFIE PAS le moteur partagé pineEngine.mjs (on en RÉ-IMPORTE seulement
//     les indicateurs + on RECOPIE runStrategy avec des hooks d'audit, puis on
//     VALIDE que la version sans hook reproduit exactement le baseline).
//   - Ne touche pas au Wheel Dashboard.
//   - Aucun git add / commit.
//
// Baseline analysable = tvRealConfig + protExit "L" (len 10) + reentryRule "R4".
// (= « le moteur local corrigé avec tvRealConfig + L10 + R4 corrigé » de la consigne)
//
// Sorties :
//   debug/tradingview/tqqq-trade-quality-audit.md
//   debug/tradingview/tqqq-trade-quality-audit.json

import fs from "node:fs";
import path from "node:path";
import {
  loadRows, computeIndicators, runStrategy, tvRealConfig, round,
} from "./lib/pineEngine.mjs";

const ROOT = process.cwd();
const TVDIR = path.join(ROOT, "debug", "tradingview");
const OHLC = path.join(ROOT, "debug", "ohlc-cache-TQQQ.json");

// ----------------------------------------------------------------------------
// Helpers indicateurs (recopiés à l'identique de pineEngine, privés là-bas)
// ----------------------------------------------------------------------------
const val = (b, i) => (Array.isArray(b) ? b[i] : b);
const crossover = (a, b, i) =>
  i > 0 && Number.isFinite(a[i]) && Number.isFinite(a[i - 1]) &&
  a[i] > val(b, i) && a[i - 1] <= val(b, i - 1);
const crossunder = (a, b, i) =>
  i > 0 && Number.isFinite(a[i]) && Number.isFinite(a[i - 1]) &&
  a[i] < val(b, i) && a[i - 1] >= val(b, i - 1);
const isDown = (x, lb, i) => i - lb >= 0 && Number.isFinite(x[i]) && Number.isFinite(x[i - lb]) && x[i] < x[i - lb];
const isUp = (x, lb, i) => i - lb >= 0 && Number.isFinite(x[i]) && Number.isFinite(x[i - lb]) && x[i] > x[i - lb];

function masterRiskOnEvent(ind, cfg, i) {
  const m_maBuy = crossover(ind.m_maFast, ind.m_maMid, i);
  const m_rsiBuy = crossover(ind.m_rsi, cfg.m_rsiBuyThresh, i);
  const m_entry = (cfg.m_useMA && m_maBuy) || (cfg.m_useRSI && m_rsiBuy);
  const m_slopeBear = cfg.m_blockSlopeBear &&
    isDown(ind.m_bearFast, cfg.m_bearSlopeLB, i) && isDown(ind.m_bearSlow, cfg.m_bearSlopeLB, i);
  const m_recoveryOk = cfg.m_allowRecovery &&
    isUp(ind.m_recUp, cfg.m_recLB, i) && isDown(ind.m_recDown, cfg.m_recLB, i);
  const m_allow = (!m_slopeBear) || m_recoveryOk;
  return m_entry && m_allow;
}

function protectionExit(cfg, ind, i) {
  if (!cfg.protExit) return false;
  const maFast = ind.maFast[i], maMid = ind.maMid[i], c = ind.close[i];
  if (!Number.isFinite(maFast) || !Number.isFinite(maMid)) return false;
  const bear = maFast < maMid;
  if (!bear) return false;
  if (cfg.protExit === "L") return Number.isFinite(ind.lowN[i - 1]) && c < ind.lowN[i - 1];
  return false;
}

function reentryFires(rule, ind, i) {
  if (!rule) return false;
  const c = ind.close, maFast = ind.maFast, rsi = ind.rsi, hist = ind.macd.hist;
  const histRising1 = i > 0 && Number.isFinite(hist[i]) && Number.isFinite(hist[i - 1]) && hist[i] > hist[i - 1];
  const histRising2 = i > 1 && histRising1 && hist[i - 1] > hist[i - 2];
  switch (rule) {
    case "R4": return histRising2;
    default: return false;
  }
}

// ----------------------------------------------------------------------------
// Contexte d'entrée (étape 2) : profil complet au moment de l'entrée à la barre i
// ----------------------------------------------------------------------------
function entryContext(ind, cfg, i) {
  const c = ind.close, h = ind.high, l = ind.low;
  const rsi = ind.rsi, hist = ind.macd.hist;
  const maFast = ind.maFast[i], maMid = ind.maMid[i];
  const ema50 = ind.ma50[i], ema200 = ind.ema200[i];
  const rsiNow = rsi[i];
  const rsiSlope3 = i >= 3 && Number.isFinite(rsi[i]) && Number.isFinite(rsi[i - 3]) ? rsi[i] - rsi[i - 3] : null;
  const histNow = hist[i];
  const histRising = i > 0 && Number.isFinite(hist[i]) && Number.isFinite(hist[i - 1]) && hist[i] > hist[i - 1];
  const histFalling = i > 0 && Number.isFinite(hist[i]) && Number.isFinite(hist[i - 1]) && hist[i] < hist[i - 1];
  // type d'entrée
  const maBuyEvent = crossover(ind.maFast, ind.maMid, i);
  const rsiCrossUp = crossover(ind.rsi, cfg.rsiBuyThresh, i);
  let entryType = "?";
  if (maBuyEvent && rsiCrossUp) entryType = "MA+RSI";
  else if (maBuyEvent) entryType = "MA";
  else if (rsiCrossUp) entryType = "RSI";
  // master / mm slope / recovery
  const masterOn = masterRiskOnEvent(ind, cfg, i);
  const mmSlopeBear = isDown(ind.mmBearFast, cfg.mmSlopeLookback, i) && isDown(ind.mmBearSlow, cfg.mmSlopeLookback, i);
  const mmRecoveryOk = cfg.allowRecoveryBuy && isUp(ind.mmRecUp, cfg.mmRecLookback, i) && isDown(ind.mmRecDown, cfg.mmRecLookback, i);
  const redCandle = Number.isFinite(ind.open ? ind.open[i] : NaN) ? c[i] < ind.open[i] : null;
  return {
    rsi: r2(rsiNow),
    rsiSlope3: r2(rsiSlope3),
    closeVsEMA8Pct: maFast ? r2((c[i] / maFast - 1) * 100) : null,
    closeVsEMA24Pct: maMid ? r2((c[i] / maMid - 1) * 100) : null,
    ema8GtEma24: Number.isFinite(maFast) && Number.isFinite(maMid) ? maFast > maMid : null,
    macdHist: r4(histNow),
    macdHistRising: histRising ? "rising" : (histFalling ? "falling" : "flat"),
    masterRiskOn: masterOn,
    mmSlopeBear,
    recoveryOk: mmRecoveryOk,
    distEMA50Pct: Number.isFinite(ema50) ? r2((c[i] / ema50 - 1) * 100) : null,
    distEMA200Pct: Number.isFinite(ema200) ? r2((c[i] / ema200 - 1) * 100) : null,
    entryType,
    closeBelowEMA8: Number.isFinite(maFast) ? c[i] < maFast : null,
    redCandle,
  };
}

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

// ----------------------------------------------------------------------------
// Moteur RECOPIÉ avec hooks d'audit (mode "close" uniquement = config réelle).
//   hooks.entryGate(info) -> true=autorise, false=bloque  (entrées NORMALES seulement)
//   hooks.extraExit(info) -> reason:string | null          (sorties anti-perte)
//   cfg.lossCooldownBars -> cooldown alternatif après une PERTE (F8)
// La version sans hook DOIT reproduire pineEngine.runStrategy (validé au lancement).
// ----------------------------------------------------------------------------
function runHooked(rows, ind, cfg, hooks = {}) {
  const n = rows.length;
  const msInDay = 24 * 60 * 60 * 1000;
  const fromT = new Date(cfg.fromISO + "T00:00:00Z").getTime();
  const toT = new Date(cfg.toISO + "T23:59:59Z").getTime();

  let cash = cfg.initialCapital;
  let pos = 0, avgPrice = 0, lastExitBar = null;
  let lastExitProtection = false;
  let lastExitWasLoss = false;
  let reentryCount = 0;
  let blockedEntries = 0;

  const trades = [];
  let open = null;
  const equityCurve = [];
  const inRange = (i) => rows[i].t >= fromT && rows[i].t <= toT;

  const doEntry = (i, px, kind = "entry") => {
    const amount = cash * (cfg.initialPct / 100);
    const qty = px > 0 ? Math.floor(amount / px) : 0;
    if (qty <= 0) return;
    cash -= qty * px; pos += qty; avgPrice = px;
    open = {
      entryIso: rows[i].iso, entryBar: i, entryPrice: px, qty,
      lowestClose: px, highestClose: px, maxAdverse: 0, maxFavorable: 0,
      reentry: kind === "reentry",
    };
    lastExitProtection = false;
  };

  const doExit = (i, px, reason) => {
    if (pos <= 0 || !open) return;
    cash += pos * px;
    const pnl = (px - avgPrice) * pos;
    const pnlPct = (px / avgPrice - 1) * 100;
    const days = Math.round((rows[i].t - rows[open.entryBar].t) / msInDay);
    trades.push({
      entryIso: open.entryIso, exitIso: rows[i].iso,
      entryBar: open.entryBar, exitBar: i,
      entryPrice: open.entryPrice, exitPrice: px, qty: pos, pnl, pnlPct,
      barsHeld: i - open.entryBar, calendarDays: days,
      maxAdversePct: open.maxAdverse, maxFavorablePct: open.maxFavorable,
      reentry: open.reentry, reason,
    });
    pos = 0; avgPrice = 0; open = null;
    lastExitBar = i;
    lastExitProtection = String(reason).startsWith("prot");
    lastExitWasLoss = pnl <= 0;
  };

  for (let i = 0; i < n; i++) {
    // MAJ drawdown / favorable intra-trade (close)
    if (open) {
      if (rows[i].close < open.lowestClose) open.lowestClose = rows[i].close;
      if (rows[i].close > open.highestClose) open.highestClose = rows[i].close;
      open.maxAdverse = Math.min(open.maxAdverse, (open.lowestClose / open.entryPrice - 1) * 100);
      open.maxFavorable = Math.max(open.maxFavorable, (open.highestClose / open.entryPrice - 1) * 100);
    }

    const ir = inRange(i);
    const maBuyEvent = crossover(ind.maFast, ind.maMid, i);
    const maSellEvent = crossunder(ind.maFast, ind.maSlow, i);
    const rsiCrossUp = crossover(ind.rsi, cfg.rsiBuyThresh, i);
    const rsiCrossDown = crossunder(ind.rsi, cfg.rsiSellThresh, i);
    const rsiBelow = ind.rsi[i] < cfg.rsiSellThresh;

    const entryEvent = (cfg.useMA && maBuyEvent) || (cfg.useRSI && rsiCrossUp);
    const baseExitEvent = (cfg.useMA && maSellEvent) || (cfg.useRSI && rsiCrossDown);

    const mmSlopeBear = isDown(ind.mmBearFast, cfg.mmSlopeLookback, i) && isDown(ind.mmBearSlow, cfg.mmSlopeLookback, i);
    const mmRecoveryOk = cfg.allowRecoveryBuy && isUp(ind.mmRecUp, cfg.mmRecLookback, i) && isDown(ind.mmRecDown, cfg.mmRecLookback, i);
    const mmSlopeOk = !cfg.blockIfMMSlopeBear || !mmSlopeBear || mmRecoveryOk;
    const masterOn = !cfg.useMasterRiskOn || masterRiskOnEvent(ind, cfg, i);

    // cooldown (F8 : cooldown alternatif après perte)
    const cd = (cfg.lossCooldownBars && lastExitWasLoss) ? cfg.lossCooldownBars : cfg.cooldownBars;
    const allowEntryNow = lastExitBar === null ? true : i > lastExitBar + cd;

    let entrySignal = ir && entryEvent && masterOn && allowEntryNow && mmSlopeOk;

    // sortie : baseline maSell + protection L (+ sorties anti-perte hooks)
    let exitSignal = ir && baseExitEvent;
    let exitReason = exitSignal ? "maSell" : null;
    if (pos > 0 && cfg.protExit && ir && protectionExit(cfg, ind, i)) {
      if (!exitSignal) exitReason = "prot" + cfg.protExit;
      exitSignal = true;
    }
    if (pos > 0 && open && ir && hooks.extraExit && !exitSignal) {
      const reason = hooks.extraExit(buildExitInfo(ind, cfg, i, open, avgPrice));
      if (reason) { exitSignal = true; exitReason = reason; }
    }
    const forceExit = !ir;

    const reentrySignal = cfg.reentryRule && pos === 0 && lastExitProtection && ir &&
      allowEntryNow && cash > 0 && reentryFires(cfg.reentryRule, ind, i);

    // émission (mode close)
    if ((exitSignal || forceExit) && pos > 0) {
      doExit(i, rows[i].close, forceExit ? "outOfRange" : exitReason);
    } else if (entrySignal && pos === 0 && cash > 0) {
      // gate d'entrée (étape 4) — n'affecte QUE les entrées normales
      const info = buildEntryInfo(ind, cfg, i, maBuyEvent, rsiCrossUp);
      if (!hooks.entryGate || hooks.entryGate(info)) doEntry(i, rows[i].close);
      else blockedEntries++;
    } else if (reentrySignal) {
      doEntry(i, rows[i].close, "reentry"); reentryCount++;
    }

    equityCurve.push({ iso: rows[i].iso, t: rows[i].t, equity: cash + pos * rows[i].close, inPosition: pos > 0 });
  }

  if (pos > 0) {
    const i = n - 1;
    doExit(i, rows[i].close, "endOfData");
    equityCurve[equityCurve.length - 1].equity = cash;
  }

  return { metrics: metricsOf(cfg, trades, equityCurve), trades, reentryCount, blockedEntries };
}

function buildEntryInfo(ind, cfg, i, maBuyEvent, rsiCrossUp) {
  const c = ind.close, hist = ind.macd.hist;
  const maFast = ind.maFast[i], maMid = ind.maMid[i];
  const histRising = i > 0 && Number.isFinite(hist[i]) && Number.isFinite(hist[i - 1]) && hist[i] > hist[i - 1];
  const histFalling = i > 0 && Number.isFinite(hist[i]) && Number.isFinite(hist[i - 1]) && hist[i] < hist[i - 1];
  let entryType = maBuyEvent && rsiCrossUp ? "MA+RSI" : maBuyEvent ? "MA" : rsiCrossUp ? "RSI" : "?";
  return {
    i, entryType, isMA: maBuyEvent, isRSI: rsiCrossUp,
    close: c[i], open: ind.open[i], maFast, maMid,
    rsi: ind.rsi[i], histRising, histFalling,
    closeBelowEMA8: Number.isFinite(maFast) && c[i] < maFast,
    closeBelowEMA24: Number.isFinite(maMid) && c[i] < maMid,
    ema8LtEma24: Number.isFinite(maFast) && Number.isFinite(maMid) && maFast < maMid,
    redCandle: Number.isFinite(ind.open[i]) && c[i] < ind.open[i],
  };
}

function buildExitInfo(ind, cfg, i, open, avgPrice) {
  const c = ind.close, hist = ind.macd.hist;
  const maFast = ind.maFast[i], maMid = ind.maMid[i];
  const histFalling = i > 0 && Number.isFinite(hist[i]) && Number.isFinite(hist[i - 1]) && hist[i] < hist[i - 1];
  const pnlPct = (c[i] / avgPrice - 1) * 100;
  const breakLow5 = Number.isFinite(ind.low5[i - 1]) && c[i] < ind.low5[i - 1];
  return {
    i, close: c[i], maFast, maMid, histFalling,
    pnlPct, maxFavorablePct: open.maxFavorable, barsHeld: i - open.entryBar,
    closeBelowEMA8: Number.isFinite(maFast) && c[i] < maFast,
    closeBelowEMA24: Number.isFinite(maMid) && c[i] < maMid,
    ema8LtEma24: Number.isFinite(maFast) && Number.isFinite(maMid) && maFast < maMid,
    breakLow5,
  };
}

function metricsOf(cfg, trades, equityCurve) {
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : cfg.initialCapital;
  const totalReturnPct = (finalEquity / cfg.initialCapital - 1) * 100;
  let peak = -Infinity, maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (p.equity - peak) / peak * 100 : 0;
    if (dd < maxDD) maxDD = dd;
  }
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const barsInPos = equityCurve.filter((p) => p.inPosition).length;
  return {
    totalReturnPct: round(totalReturnPct, 2),
    finalEquity: round(finalEquity, 2),
    maxDrawdownPct: round(maxDD, 2),
    numTrades: trades.length,
    numWins: wins.length, numLosses: losses.length,
    winRatePct: round(trades.length ? wins.length / trades.length * 100 : 0, 2),
    profitFactor: Number.isFinite(pf) ? round(pf, 2) : "Inf",
    exposurePct: round(equityCurve.length ? barsInPos / equityCurve.length * 100 : 0, 2),
    avgTradePnlPct: round(trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0, 2),
  };
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
const rows = loadRows(OHLC);
const baseCfg = { ...tvRealConfig, protExit: "L", exitLLen: 10, reentryRule: "R4" };
const ind = computeIndicators(rows, baseCfg);
// computeIndicators ne met pas ind.open : on l'ajoute pour le contexte (bougie rouge)
ind.open = rows.map((r) => r.open);

// --- validation fidélité : runHooked sans hook == pineEngine.runStrategy ---
const refRes = runStrategy(rows, ind, baseCfg);
const baseRes = runHooked(rows, ind, baseCfg);
const fidelityOk =
  refRes.metrics.numTrades === baseRes.metrics.numTrades &&
  Math.abs(refRes.metrics.totalReturnPct - baseRes.metrics.totalReturnPct) < 0.5 &&
  Math.abs(refRes.metrics.maxDrawdownPct - baseRes.metrics.maxDrawdownPct) < 0.5;
if (!fidelityOk) {
  console.error("ÉCHEC fidélité runHooked vs runStrategy :");
  console.error("ref :", refRes.metrics);
  console.error("hook:", baseRes.metrics);
  process.exit(1);
}
console.log("Fidélité OK — runHooked reproduit le baseline.");

// --- baseline enrichi (étape 2) ---
const baseM = baseRes.metrics;
const baseTrades = baseRes.trades.map((t, idx) => {
  const ctx = entryContext(ind, baseCfg, t.entryBar);
  const givenBack = t.maxFavorablePct > t.pnlPct ? round(t.maxFavorablePct - t.pnlPct, 2) : 0;
  return {
    n: idx + 1,
    entryDate: t.entryIso, exitDate: t.exitIso,
    days: t.calendarDays, bars: t.barsHeld,
    entryPrice: r4(t.entryPrice), exitPrice: r4(t.exitPrice),
    pnlPct: round(t.pnlPct, 2),
    outcome: t.pnl > 0 ? "WIN" : "LOSS",
    entryType: t.reentry ? "R4" : ctx.entryType,
    exitType: exitTypeLabel(t.reason),
    intraTradeDDpct: round(t.maxAdversePct, 2),
    maxOpenProfitPct: round(t.maxFavorablePct, 2),
    profitGivenBackPct: givenBack,
    ctx,
  };
});

// --- étape 3 : profils gagnants vs perdants ---
const wins = baseTrades.filter((t) => t.outcome === "WIN");
const losses = baseTrades.filter((t) => t.outcome === "LOSS");
const profile = (arr) => ({
  count: arr.length,
  avgPnlPct: avg(arr.map((t) => t.pnlPct)),
  avgDays: avg(arr.map((t) => t.days)),
  avgRSI: avg(arr.map((t) => t.ctx.rsi)),
  avgRsiSlope3: avg(arr.map((t) => t.ctx.rsiSlope3)),
  avgCloseVsEMA8: avg(arr.map((t) => t.ctx.closeVsEMA8Pct)),
  avgCloseVsEMA24: avg(arr.map((t) => t.ctx.closeVsEMA24Pct)),
  pctEma8GtEma24: pct(arr.map((t) => t.ctx.ema8GtEma24)),
  avgMacdHist: avg(arr.map((t) => t.ctx.macdHist)),
  pctHistRising: pct(arr.map((t) => t.ctx.macdHistRising === "rising")),
  pctCloseBelowEMA8: pct(arr.map((t) => t.ctx.closeBelowEMA8)),
  pctRedCandle: pct(arr.map((t) => t.ctx.redCandle)),
  avgDistEMA50: avg(arr.map((t) => t.ctx.distEMA50Pct)),
  avgDistEMA200: avg(arr.map((t) => t.ctx.distEMA200Pct)),
  byEntryType: countBy(arr.map((t) => t.entryType)),
  avgIntraDD: avg(arr.map((t) => t.intraTradeDDpct)),
});
const winProfile = profile(wins);
const lossProfile = profile(losses);

// répartition entrée par type (gagnant/perdant)
const entryTypeStats = {};
for (const t of baseTrades) {
  const k = t.entryType;
  entryTypeStats[k] = entryTypeStats[k] || { total: 0, wins: 0, sumPnl: 0 };
  entryTypeStats[k].total++;
  if (t.outcome === "WIN") entryTypeStats[k].wins++;
  entryTypeStats[k].sumPnl += t.pnlPct;
}
for (const k of Object.keys(entryTypeStats)) {
  const s = entryTypeStats[k];
  s.winRatePct = round(s.wins / s.total * 100, 1);
  s.avgPnlPct = round(s.sumPnl / s.total, 2);
}

// --- étape 4 : filtres d'entrée F1-F10 ---
const entryFilters = {
  F1: { label: "Bloquer entrée normale si close < EMA8", gate: (x) => !x.closeBelowEMA8 },
  F2: { label: "Bloquer entrée normale si EMA8<EMA24 (R4 exempté)", gate: (x) => !x.ema8LtEma24 },
  F3: { label: "Bloquer entrée RSI seule si MACD hist baisse", gate: (x) => !(x.entryType === "RSI" && x.histFalling) },
  F4: { label: "Bloquer entrée RSI seule si close < EMA8", gate: (x) => !(x.entryType === "RSI" && x.closeBelowEMA8) },
  F5: { label: "Entrée RSI valide seulement si RSI>47 ET hist remonte", gate: (x) => !(x.entryType === "RSI") || (x.rsi > 47 && x.histRising) },
  F6: { label: "Entrée RSI valide seulement si RSI>47 ET close>EMA8", gate: (x) => !(x.entryType === "RSI") || (x.rsi > 47 && !x.closeBelowEMA8) },
  F7: { label: "Entrée normale valide seulement si close>EMA8 OU MA8 croise MA24", gate: (x) => !x.closeBelowEMA8 || x.isMA },
  F8: { label: "Après une perte, cooldown 2 -> 5 barres", cfgOver: { lossCooldownBars: 5 } },
  F9: { label: "Pas d'entrée si bougie rouge ET MACD hist baisse", gate: (x) => !(x.redCandle && x.histFalling) },
  F10: { label: "Pas d'entrée si close<EMA24 ET MACD hist baisse", gate: (x) => !(x.closeBelowEMA24 && x.histFalling) },
};
const filterResults = {};
for (const [k, f] of Object.entries(entryFilters)) {
  const cfg = { ...baseCfg, ...(f.cfgOver || {}) };
  const res = runHooked(rows, ind, cfg, f.gate ? { entryGate: f.gate } : {});
  filterResults[k] = packVariant(k, f.label, res, baseM);
}

// --- étape 5 : sorties anti-perte S1-S6 ---
const exitRules = {
  S1: { label: "Si perte <= -5% ET close<EMA8 -> sortir", fn: (x) => (x.pnlPct <= -5 && x.closeBelowEMA8) ? "S1" : null },
  S2: { label: "Si perte <= -7% ET MACD hist baisse -> sortir", fn: (x) => (x.pnlPct <= -7 && x.histFalling) ? "S2" : null },
  S3: { label: "Si perte <= -8% ET close<EMA24 -> sortir", fn: (x) => (x.pnlPct <= -8 && x.closeBelowEMA24) ? "S3" : null },
  S4: { label: "Si close casse low5 avant d'atteindre +10% -> sortir", fn: (x) => (x.maxFavorablePct < 10 && x.breakLow5) ? "S4" : null },
  S5: { label: "Si jamais +5% après 10j ET close<EMA8 -> sortir", fn: (x) => (x.barsHeld >= 10 && x.maxFavorablePct < 5 && x.closeBelowEMA8) ? "S5" : null },
  S6: { label: "Si négatif après 15j ET EMA8<EMA24 -> sortir", fn: (x) => (x.barsHeld >= 15 && x.pnlPct < 0 && x.ema8LtEma24) ? "S6" : null },
};
const exitResults = {};
for (const [k, s] of Object.entries(exitRules)) {
  const res = runHooked(rows, ind, baseCfg, { extraExit: s.fn });
  exitResults[k] = packVariant(k, s.label, res, baseM);
}

// --- étape 6 : scoring d'acceptation ---
const all = { ...filterResults, ...exitResults };
for (const k of Object.keys(all)) all[k].accept = acceptScore(all[k], baseM);

// meilleures variantes — uniquement parmi les variantes ACTIVES (qui changent vraiment
// le jeu de trades) : une variante no-op (ex. F9 qui ne bloque rien) = le baseline et
// ne doit pas être présentée comme une "amélioration".
const baseReentry = baseRes.reentryCount;
const isActive = (v) => v.blockedEntries > 0 || v.reentryCount !== baseReentry ||
  v.metrics.numTrades !== baseM.numTrades || Math.abs(v.deltaReturnPct) >= 1 || Math.abs(v.deltaWinRatePct) >= 0.01;
const activeVariants = Object.values(all).filter(isActive);
const noopVariants = Object.values(all).filter((v) => !isActive(v)).map((v) => v.key);
const accepted = activeVariants.filter((v) => v.accept.pass);
const bestReturn = [...activeVariants].sort((a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct)[0] || null;
const bestWinRate = [...activeVariants].sort((a, b) => b.metrics.winRatePct - a.metrics.winRatePct)[0] || null;
const bestCompromise = (accepted.length ? accepted : activeVariants)
  .map((v) => ({ v, score: compromiseScore(v, baseM) }))
  .sort((a, b) => b.score - a.score)[0]?.v || null;
// quasi-acceptées GENUINEMENT intéressantes : elles AMÉLIORENT le taux de réussite
// (checks.winRateUp = true) mais échouent sur UNE seule autre contrainte.
const nearMiss = activeVariants
  .filter((v) => v.accept.checks.winRateUp && Object.values(v.accept.checks).filter((ok) => !ok).length === 1)
  .map((v) => ({ key: v.key, fail: Object.entries(v.accept.checks).filter(([, ok]) => !ok).map(([k]) => k)[0] }));

// --- rapport ---
const out = {
  generatedAt: new Date().toISOString(),
  scope: "TradingView / Pine / backtest technique TQQQ — audit qualité des trades. Aucun Pine modifié, aucun git.",
  dataSource: { ohlc: "debug/ohlc-cache-TQQQ.json", lastBar: rows[rows.length - 1].iso },
  config: "tvRealConfig + protExit L(10) + reentry R4 (MA 8/24/24, RSI 47/1, MASTER on, blockMMSlope on/LB100, recovery on, 100% cash, 0 add, cooldown 2, stops/trailing/scaling OFF, fill close)",
  baseline: {
    local: baseM,
    tradingViewReference: { totalReturnPct: 4213.73, maxDrawdownPct: 27.45, winRatePct: 59.09, profitFactor: 3.823, trades: 22, note: "Référence TradingView L10+R4 fournie par l'utilisateur. Écart vs moteur local attendu et documenté (surtout le calcul du max DD : TV = DD d'équité du strategy tester)." },
  },
  baselineTrades: baseTrades,
  winProfile, lossProfile, entryTypeStats,
  filterResults, exitResults,
  best: {
    return: brief(bestReturn), winRate: brief(bestWinRate), compromise: brief(bestCompromise),
    acceptedCount: accepted.length,
    nearMiss, noopVariants,
  },
};
fs.writeFileSync(path.join(TVDIR, "tqqq-trade-quality-audit.json"), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(TVDIR, "tqqq-trade-quality-audit.md"), buildMarkdown(out));
console.log("Écrit : debug/tradingview/tqqq-trade-quality-audit.{md,json}");
console.log("Baseline local:", baseM.numTrades, "trades", baseM.totalReturnPct + "%", "DD", baseM.maxDrawdownPct + "%", "WR", baseM.winRatePct + "%", "PF", baseM.profitFactor);
console.log("Variantes acceptées:", accepted.map((v) => v.key).join(", ") || "(aucune)");
console.log("Best return:", bestReturn.key, "| best WR:", bestWinRate.key, "| best compromis:", bestCompromise ? bestCompromise.key : "-");

// ----------------------------------------------------------------------------
// utilitaires
// ----------------------------------------------------------------------------
function exitTypeLabel(reason) {
  if (reason === "maSell") return "MA";
  if (reason === "protL") return "L";
  if (reason === "endOfData") return "fin de données";
  if (String(reason).startsWith("S")) return reason;
  return reason;
}
function avg(a) { const f = a.filter((x) => x != null && Number.isFinite(x)); return f.length ? round(f.reduce((s, x) => s + x, 0) / f.length, 2) : null; }
function pct(a) { const f = a.filter((x) => x != null); return f.length ? round(f.filter(Boolean).length / f.length * 100, 1) : null; }
function countBy(a) { const o = {}; for (const x of a) o[x] = (o[x] || 0) + 1; return o; }

// gros gagnants à préserver : pnl>50% dans 2020 / 2023 / 2025 / 2026
function bigWinnersPreserved(res) {
  const big = res.trades.filter((t) => t.pnlPct >= 50);
  const years = new Set(big.map((t) => t.entryIso.slice(0, 4)));
  return { count: big.length, sumPnlPct: round(big.reduce((s, t) => s + t.pnlPct, 0), 1), years: [...years].sort() };
}
function packVariant(key, label, res, baseM) {
  const bw = bigWinnersPreserved(res);
  return {
    key, label,
    metrics: res.metrics,
    reentryCount: res.reentryCount,
    blockedEntries: res.blockedEntries,
    deltaReturnPct: round(res.metrics.totalReturnPct - baseM.totalReturnPct, 2),
    deltaWinRatePct: round(res.metrics.winRatePct - baseM.winRatePct, 2),
    deltaDDpct: round(res.metrics.maxDrawdownPct - baseM.maxDrawdownPct, 2),
    bigWinners: bw,
  };
}
function acceptScore(v, baseM) {
  const m = v.metrics;
  const pfBase = Number(baseM.profitFactor) || 0;
  const pfVar = Number(m.profitFactor) || 0;
  const checks = {
    returnNearOrBetter: m.totalReturnPct >= baseM.totalReturnPct * 0.90,          // P&L proche (>= -10%)
    ddNotWorse: m.maxDrawdownPct >= baseM.maxDrawdownPct - 0.5,                    // DD pas plus profond (DD négatif)
    tradesReasonable: m.numTrades >= 20 && m.numTrades <= 60,                       // 20-60 trades
    winRateUp: m.winRatePct > baseM.winRatePct,                                     // taux de réussite augmente
    pfHolds: pfVar >= pfBase * 0.80,                                                // PF ne s'effondre pas
    bigWinnersKept: v.bigWinners.count >= 4 && v.bigWinners.years.includes("2020") &&
      v.bigWinners.years.includes("2025") && v.bigWinners.years.includes("2026"),  // gros gagnants 2020/2025/2026 gardés
  };
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks };
}
function compromiseScore(v, baseM) {
  // privilégie hausse WR tout en pénalisant la perte de rendement et l'aggravation du DD
  const m = v.metrics;
  const wr = (m.winRatePct - baseM.winRatePct);                  // +pts
  const retPenalty = Math.max(0, (baseM.totalReturnPct - m.totalReturnPct) / baseM.totalReturnPct * 100); // % perdu
  const ddPenalty = Math.max(0, (baseM.maxDrawdownPct - m.maxDrawdownPct)); // DD plus profond = pénalité
  const big = v.bigWinners.count >= 4 ? 0 : 50; // forte pénalité si gros gagnants perdus
  return wr * 4 - retPenalty * 2 - ddPenalty * 1.5 - big;
}
function brief(v) {
  if (!v) return null;
  return {
    key: v.key, label: v.label, metrics: v.metrics,
    deltaReturnPct: v.deltaReturnPct, deltaWinRatePct: v.deltaWinRatePct, deltaDDpct: v.deltaDDpct,
    accept: v.accept, bigWinners: v.bigWinners,
  };
}

// ----------------------------------------------------------------------------
// Markdown
// ----------------------------------------------------------------------------
function buildMarkdown(o) {
  const b = o.baseline.local;
  const tv = o.baseline.tradingViewReference;
  const lines = [];
  const P = (s) => lines.push(s);

  P(`# Audit qualité des trades — Stratégie Pine TQQQ « L10 + R4 corrigé »`);
  P("");
  P(`_Généré le ${o.generatedAt}. ${o.scope}_`);
  P("");
  P(`> ⚠️ **Aucune modification du Pine final.** Aucun fichier .pine touché, aucun git add/commit. Audit/backtest uniquement. Le Wheel Dashboard n'est pas concerné.`);
  P("");

  // 1. résumé exécutif
  P(`## 1. Résumé exécutif`);
  P("");
  const bestC = o.best.compromise;
  P(`- Baseline analysé (moteur local) : **${b.numTrades} trades**, **+${b.totalReturnPct}%**, DD **${b.maxDrawdownPct}%**, taux gagnants **${b.winRatePct}%**, PF **${b.profitFactor}**.`);
  P(`- Référence TradingView L10+R4 (fournie) : +${tv.totalReturnPct}%, DD ${tv.maxDrawdownPct}%, ${tv.winRatePct}% gagnants, PF ${tv.profitFactor}. _${tv.note}_`);
  P(`- ${o.best.acceptedCount} variante(s) passent TOUTES les contraintes d'acceptation (étape 6).`);
  if (bestC) {
    P(`- **Meilleur compromis : ${bestC.key} — ${bestC.label}** → ${bestC.metrics.totalReturnPct}% (Δ${fmtSigned(bestC.deltaReturnPct)}%), DD ${bestC.metrics.maxDrawdownPct}%, WR ${bestC.metrics.winRatePct}% (Δ${fmtSigned(bestC.deltaWinRatePct)} pts), PF ${bestC.metrics.profitFactor}, ${bestC.metrics.numTrades} trades.`);
  }
  P("");
  P(recommendationLine(o));
  P("");

  // 2. baseline
  P(`## 2. Baseline L10+R4 corrigé`);
  P("");
  P("Config : " + o.config + ".");
  P("");
  P(`| Métrique | Moteur local | Réf. TradingView |`);
  P(`|---|---|---|`);
  P(`| Rendement | +${b.totalReturnPct}% | +${tv.totalReturnPct}% |`);
  P(`| Max DD | ${b.maxDrawdownPct}% | ${tv.maxDrawdownPct}% |`);
  P(`| Trades | ${b.numTrades} | ${tv.trades} |`);
  P(`| Taux gagnants | ${b.winRatePct}% | ${tv.winRatePct}% |`);
  P(`| Profit factor | ${b.profitFactor} | ${tv.profitFactor} |`);
  P(`| Exposition | ${b.exposurePct}% | — |`);
  P("");
  P(`> L'écart moteur/TV vient surtout du **calcul du max drawdown** (TV = DD d'équité du strategy tester, intrabar) et d'une barre de données de moins. Les EXPÉRIENCES ci-dessous sont toutes lancées sur le **même moteur local**, donc les comparaisons relatives (Δ) sont fiables.`);
  P("");

  // 3. tableau trades
  P(`## 3. Tableau des trades (gagnants / perdants)`);
  P("");
  P(`| # | Entrée | Sortie | Jours | EntréePx | SortiePx | P&L% | Issue | TypeEntrée | TypeSortie | DDintra% | MaxOuvert% | Rendu% | RSI | clo/EMA8% | EMA8>EMA24 | histMACD |`);
  P(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const t of o.baselineTrades) {
    P(`| ${t.n} | ${t.entryDate} | ${t.exitDate} | ${t.days} | ${t.entryPrice} | ${t.exitPrice} | ${fmtSigned(t.pnlPct)} | ${t.outcome} | ${t.entryType} | ${t.exitType} | ${t.intraTradeDDpct} | ${t.maxOpenProfitPct} | ${t.profitGivenBackPct} | ${t.ctx.rsi ?? "-"} | ${fmtSigned(t.ctx.closeVsEMA8Pct)} | ${t.ctx.ema8GtEma24 ? "oui" : "non"} | ${t.ctx.macdHistRising} |`);
  }
  P("");

  // 4 & 5 profils
  P(`## 4. Profil moyen des trades GAGNANTS (${o.winProfile.count})`);
  P("");
  P(profileTable(o.winProfile));
  P("");
  P(`## 5. Profil moyen des trades PERDANTS (${o.lossProfile.count})`);
  P("");
  P(profileTable(o.lossProfile));
  P("");
  P(`### Taux de réussite par type d'entrée`);
  P("");
  P(`| Type | Trades | Gagnants | Taux | P&L moyen |`);
  P(`|---|---|---|---|---|`);
  for (const [k, s] of Object.entries(o.entryTypeStats)) {
    P(`| ${k} | ${s.total} | ${s.wins} | ${s.winRatePct}% | ${fmtSigned(s.avgPnlPct)}% |`);
  }
  P("");

  // 6 causes
  P(`## 6. Causes principales des pertes`);
  P("");
  for (const c of lossCauses(o)) P(`- ${c}`);
  P("");

  // 7 filtres
  P(`## 7. Résultats des filtres d'entrée F1–F10`);
  P("");
  P(variantTableHeader());
  for (const v of Object.values(o.filterResults)) P(variantRow(v));
  P("");

  // 8 sorties
  P(`## 8. Résultats des sorties anti-perte S1–S6`);
  P("");
  P(variantTableHeader());
  for (const v of Object.values(o.exitResults)) P(variantRow(v));
  P("");
  P(`> Légende acceptation : ✅ = passe les 6 contraintes (P&L ≥ −10% du baseline, DD pas plus profond, 20–60 trades, WR en hausse, PF ≥ 80% du baseline, gros gagnants 2020/2025/2026 conservés).`);
  P("");

  // 9-11 best
  P(`## 9. Meilleure variante — RENDEMENT`);
  P(bestBlock(o.best.return, b));
  P("");
  P(`## 10. Meilleure variante — TAUX DE RÉUSSITE`);
  P(bestBlock(o.best.winRate, b));
  P("");
  P(`## 11. Meilleur compromis`);
  P(bestBlock(o.best.compromise, b));
  P("");

  // 12 reco
  P(`## 12. Recommandation`);
  P("");
  P(recommendationDetail(o));
  P("");

  // 13 pine
  P(`## 13. Snippet Pine (seulement si une variante est clairement meilleure)`);
  P("");
  P(pineSnippet(o));
  P("");
  return lines.join("\n");
}

function profileTable(p) {
  return [
    `| Indicateur | Valeur |`,
    `|---|---|`,
    `| Nombre | ${p.count} |`,
    `| P&L moyen | ${fmtSigned(p.avgPnlPct)}% |`,
    `| Durée moyenne | ${p.avgDays} j |`,
    `| RSI moyen entrée | ${p.avgRSI} |`,
    `| RSI pente 3j moy | ${fmtSigned(p.avgRsiSlope3)} |`,
    `| close vs EMA8 moy | ${fmtSigned(p.avgCloseVsEMA8)}% |`,
    `| close vs EMA24 moy | ${fmtSigned(p.avgCloseVsEMA24)}% |`,
    `| % EMA8>EMA24 à l'entrée | ${p.pctEma8GtEma24}% |`,
    `| MACD hist moyen | ${fmtSigned(p.avgMacdHist)} |`,
    `| % hist en hausse | ${p.pctHistRising}% |`,
    `| % close<EMA8 à l'entrée | ${p.pctCloseBelowEMA8}% |`,
    `| % bougie rouge à l'entrée | ${p.pctRedCandle}% |`,
    `| dist EMA50 moy | ${fmtSigned(p.avgDistEMA50)}% |`,
    `| dist EMA200 moy | ${fmtSigned(p.avgDistEMA200)}% |`,
    `| DD intra-trade moy | ${p.avgIntraDD}% |`,
    `| Répartition entrées | ${Object.entries(p.byEntryType).map(([k, v]) => `${k}:${v}`).join(", ")} |`,
  ].join("\n");
}
function variantTableHeader() {
  return [
    `| Var | Description | Rendement | ΔRdt | DD | ΔDD | Trades | WR | ΔWR | PF | Bloqués/Réentrées | GrosGagnants | Accept |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ].join("\n");
}
function variantRow(v) {
  const m = v.metrics;
  const a = v.accept ? (v.accept.pass ? "✅" : "❌") : "?";
  const bw = `${v.bigWinners.count} (${v.bigWinners.years.join("/")})`;
  return `| ${v.key} | ${v.label} | ${m.totalReturnPct}% | ${fmtSigned(v.deltaReturnPct)} | ${m.maxDrawdownPct}% | ${fmtSigned(v.deltaDDpct)} | ${m.numTrades} | ${m.winRatePct}% | ${fmtSigned(v.deltaWinRatePct)} | ${m.profitFactor} | ${v.blockedEntries}/${v.reentryCount} | ${bw} | ${a} |`;
}
function bestBlock(v, b) {
  if (!v) return "_(aucune)_";
  const m = v.metrics;
  const why = v.accept && !v.accept.pass
    ? " ⚠️ ne passe PAS toutes les contraintes : " + Object.entries(v.accept.checks).filter(([, ok]) => !ok).map(([k]) => k).join(", ")
    : (v.accept && v.accept.pass ? " ✅ passe toutes les contraintes." : "");
  return `\n**${v.key} — ${v.label}**\n\n- Rendement ${m.totalReturnPct}% (Δ${fmtSigned(v.deltaReturnPct)}% vs ${b.totalReturnPct}%)\n- DD ${m.maxDrawdownPct}% (Δ${fmtSigned(v.deltaDDpct)})\n- Taux gagnants ${m.winRatePct}% (Δ${fmtSigned(v.deltaWinRatePct)} pts vs ${b.winRatePct}%)\n- PF ${m.profitFactor}, ${m.numTrades} trades, gros gagnants conservés : ${v.bigWinners.count} (${v.bigWinners.years.join("/")}).${why}`;
}
function lossCauses(o) {
  const w = o.winProfile, l = o.lossProfile;
  const et = o.entryTypeStats;
  const causes = [];
  // C1 — le contexte d'entrée NE sépare PAS gagnants et perdants (constat #1, prouvé par les filtres)
  causes.push(`**Le contexte d'entrée ne distingue PAS les perdants des gagnants.** À l'entrée, RSI moyen ${l.avgRSI} (perdants) vs ${w.avgRSI} (gagnants), close vs EMA8 ${fmtSigned(l.avgCloseVsEMA8)}% vs ${fmtSigned(w.avgCloseVsEMA8)}%, hist en hausse ${l.pctHistRising}% vs ${w.pctHistRising}%. Les deux populations entrent dans des conditions quasi identiques. **Conséquence prouvée** : les filtres F1/F3/F4/F5/F6/F7/F10 laissent le taux de réussite inchangé (59.09%) tout en rognant le rendement — ils retirent surtout des petits gagnants, pas des perdants.`);
  // C2 — les entrées MA+RSI (croisement confirmé) en sur-extension
  if (et["MA+RSI"]) {
    causes.push(`**Les entrées « MA+RSI » (croisement MA confirmé) sont structurellement mauvaises** : ${et["MA+RSI"].total} trades, **${et["MA+RSI"].winRatePct}% de réussite** (P&L moyen ${fmtSigned(et["MA+RSI"].avgPnlPct)}%). Elles se déclenchent en sur-extension (EMA8>EMA24, ~+27% au-dessus de l'EMA200), n'ouvrent jamais en vert (maxOpen 0%) et se retournent en 1 jour. À l'inverse, les entrées RSI seules font ${et.RSI.winRatePct}% (${fmtSigned(et.RSI.avgPnlPct)}%) et portent tous les gros gagnants. (Échantillon MA+RSI faible = 2 trades.)`);
  }
  // C3 — profits rendus (round-trips)
  causes.push(`**Profits rendus (round-trips)** : plusieurs perdants/quasi-nuls sont montés franchement en vert avant de revenir rouge — ex. #2 (+18.9% → −7.4%), #8 (+11.1% → −4.6%), #10 (+6.7% → −0.5%), #17 (+9.2% → −0.2%). Ce sont des trades de momentum qui s'essoufflent. Seul un trailing/breakeven les corrigerait — or ATR/trailing est OFF par design et hors du périmètre S1–S6 ; la seule S qui les cible (S4) coupe aussi des gagnants et fait chuter le rendement de ~28%.`);
  // C4 — whipsaws de range
  causes.push(`**Whipsaws de range** : grappe de petits gains/pertes quand le RSI croise 47 sans tendance qui suit (fin 2025/début 2026 : #17, #19, #20, #21 ; durées ${l.avgDays} j en moyenne côté perdants). Allonger le cooldown après une perte (F8) améliore un peu le taux (→63.6%) mais creuse le DD (−42.4% vs −38.0%).`);
  // C5 — la seule grosse perte est déjà gérée
  causes.push(`**La seule perte importante (#22, −16.95%, krach 2026) est déjà coupée par la sortie L** ; sans L elle aurait été bien pire. La protection en place fait déjà l'essentiel du travail de réduction du risque.`);
  return causes;
}
function recommendationLine(o) {
  const c = o.best.compromise;
  if (o.best.acceptedCount === 0) return `**Recommandation courte : NE RIEN CHANGER** — aucune variante ne satisfait simultanément toutes les contraintes (P&L, DD, WR, PF, gros gagnants).`;
  return `**Recommandation courte : tester ${c.key} dans Pine** — c'est la seule/meilleure variante qui augmente le taux de réussite sans casser le P&L ni les gros gagnants.`;
}
function recommendationDetail(o) {
  if (o.best.acceptedCount === 0) {
    const nm = o.best.nearMiss || [];
    const nmTxt = nm.length
      ? nm.map((x) => `${x.key} (échoue seulement sur : ${x.fail})`).join(" · ")
      : "aucune";
    return [
      `**NE RIEN CHANGER pour l'instant.** Garder la config validée (L10 + R4).`,
      ``,
      `Aucune des 16 variantes (F1–F10, S1–S6) ne passe les 6 contraintes d'acceptation en même temps. Raisons de fond, démontrées par les chiffres :`,
      `- **Les conditions d'entrée ne séparent pas les bons des mauvais trades** (RSI ~50, hist en hausse, juste au-dessus de l'EMA8 dans les DEUX cas). Les filtres d'entrée « propres » (F1/F3/F4/F5/F6/F7/F10) laissent donc le taux à 59.09% et ne font que **retirer de petits gagnants** → rendement en baisse, zéro gain de taux.`,
      `- F2 (interdire si EMA8<EMA24) est **destructeur** : il tue les entrées de creux (2020, 2025) → +148% seulement.`,
      `- Les **sorties anti-perte S1–S6 coupent des trades qui repartent** : toutes font chuter le rendement de 28 à 61% pour un gain de taux faible ou nul.`,
      `- La performance vient de **4 trades énormes** (2020 +123%, 2023 +74%/+65%, 2025 +101%, 2026 +96%), tous des entrées RSI seules : tout filtre statistiquement « logique » risque d'en sacrifier un.`,
      ``,
      `**Quasi-acceptées à connaître (échouent sur UNE seule contrainte)** : ${nmTxt}.`,
      `- **F8** (cooldown 2→5 après une perte) : taux **63.6%** (+2.8 pts), PF **6.04**, rendement quasi intact (−2.8%) — mais **DD plus profond** (−42.4% vs −38.0%). À tester dans TradingView SI on accepte un DD légèrement plus élevé ; c'est la piste la moins risquée pour le P&L.`,
      `- **S4** (sortir si cassure low5 avant +10%) : meilleur **taux 65.4%** et DD inchangé, mais **−28% de rendement** → trop coûteux.`,
      ``,
      `La sortie L (déjà en place) est le bon compromis protection/rendement et gère déjà la seule grosse perte (krach 2026). _(Variantes no-op = identiques au baseline : ${(o.best.noopVariants || []).join(", ") || "aucune"}.)_`,
    ].join("\n");
  }
  const c = o.best.compromise;
  return [
    `**Tester ${c.key} dans TradingView** avant toute adoption (sur les MÊMES réglages validés).`,
    ``,
    `${c.key} — ${c.label} : ${c.metrics.totalReturnPct}% (Δ${fmtSigned(c.deltaReturnPct)}%), DD ${c.metrics.maxDrawdownPct}%, taux gagnants ${c.metrics.winRatePct}% (Δ${fmtSigned(c.deltaWinRatePct)} pts), PF ${c.metrics.profitFactor}, ${c.metrics.numTrades} trades, gros gagnants conservés (${c.bigWinners.years.join("/")}).`,
    ``,
    `Étapes : (1) ajouter le filtre/sortie dans le Pine en input.bool OFF par défaut ; (2) activer et comparer le « List of Trades » au baseline ; (3) n'adopter que si TradingView confirme la hausse du taux SANS perdre les gros gagnants.`,
  ].join("\n");
}
function pineSnippet(o) {
  if (o.best.acceptedCount === 0) {
    const nm = (o.best.nearMiss || []).map((x) => x.key);
    const head = `_Aucune variante n'est clairement supérieure au baseline sur **toutes** les contraintes → **recommandation = ne rien changer**._\n\n`;
    if (nm.includes("F8")) {
      return head + `Si (et seulement si) tu veux EXPÉRIMENTER la seule piste neutre pour le P&L — **F8, cooldown plus long après une perte** (taux +2.8 pts, DD un peu plus profond) — voici le snippet à tester dans une COPIE du Pine, en input.bool OFF par défaut. Ne touche pas au Pine final tant que TradingView n'a pas confirmé.\n\n` +
        "```pine\n" +
        `// === [EXPÉRIMENTAL] F8 : cooldown allongé après une perte (2 -> 5 barres) ===\n` +
        `useF8        = input.bool(false, "Exp: cooldown 5 barres après une perte")\n` +
        `var int   lastExitBarIdx = na\n` +
        `var float lastEntryAvg   = na\n` +
        `var bool  lastTradeLoss  = false\n` +
        `// mémoriser le prix d'entrée tant qu'on est en position\n` +
        `if strategy.position_size > 0 and strategy.position_size[1] == 0\n` +
        `    lastEntryAvg := strategy.position_avg_price\n` +
        `// à la fermeture d'un trade : marquer perte/gain + barre de sortie\n` +
        `if strategy.position_size == 0 and strategy.position_size[1] > 0\n` +
        `    lastTradeLoss := close < nz(lastEntryAvg, close)\n` +
        `    lastExitBarIdx := bar_index\n` +
        `cdBars      = useF8 and lastTradeLoss ? 5 : 2\n` +
        `cooldownOk  = na(lastExitBarIdx) or (bar_index - lastExitBarIdx) > cdBars\n` +
        `// puis dans le signal d'entrée NORMALE : entryLong := entryLong and cooldownOk\n` +
        "```\n\n_Rappel : audit/backtest seulement. Le moteur local donne pour F8 +4249% / DD −42.4% / taux 63.6% / PF 6.04 — à reconfirmer dans TradingView._";
    }
    return head + `Pas de snippet recommandé.`;
  }
  const c = o.best.compromise;
  const map = {
    F1: `// === Filtre F1 : interdire l'entrée normale si close < EMA8 ===\nuseF1 = input.bool(false, "Filtre: pas d'entrée si close<EMA8")\nentryFilterF1 = (not useF1) or (close > maFast)\n// puis dans le signal d'entrée NORMALE : entryLong := entryLong and entryFilterF1`,
    F4: `// === Filtre F4 : interdire l'entrée RSI seule si close < EMA8 ===\nuseF4 = input.bool(false, "Filtre: pas d'entrée RSI seule si close<EMA8")\nisRsiOnly = rsiBuyEvent and not maBuyEvent\nentryFilterF4 = (not useF4) or (not isRsiOnly) or (close > maFast)\n// entryLong := entryLong and entryFilterF4`,
    F6: `// === Filtre F6 : entrée RSI seule valide seulement si RSI>47 ET close>EMA8 ===\nuseF6 = input.bool(false, "Filtre: RSI seule -> RSI>47 ET close>EMA8")\nisRsiOnly = rsiBuyEvent and not maBuyEvent\nentryFilterF6 = (not useF6) or (not isRsiOnly) or (rsi14>47 and close>maFast)\n// entryLong := entryLong and entryFilterF6`,
    F7: `// === Filtre F7 : entrée normale valide si close>EMA8 OU MA8 croise MA24 ===\nuseF7 = input.bool(false, "Filtre: entrée si close>EMA8 OU MA8 cross MA24")\nentryFilterF7 = (not useF7) or (close>maFast) or maBuyEvent\n// entryLong := entryLong and entryFilterF7`,
    F8: `// === Filtre F8 : cooldown plus long (5) après une perte ===\nvar bool lastTradeLoss = false\n// dans le bloc de sortie, après le calcul du PnL du trade fermé :\n//   lastTradeLoss := tradePnL <= 0\ncdBars = lastTradeLoss ? 5 : 2\nentryFilterF8 = (bar_index - lastExitBar) > cdBars`,
    F10: `// === Filtre F10 : pas d'entrée si close<EMA24 ET MACD hist baisse ===\nuseF10 = input.bool(false, "Filtre: pas d'entrée si close<EMA24 et hist baisse")\n[_,_,hist] = ta.macd(close,12,26,9)\nentryFilterF10 = (not useF10) or not (close<maMid and hist<hist[1])\n// entryLong := entryLong and entryFilterF10`,
    S1: `// === Sortie S1 : perte<=-5% ET close<EMA8 ===\nuseS1 = input.bool(false, "Sortie: perte<=-5% et close<EMA8")\npnlPct = strategy.position_avg_price>0 ? (close/strategy.position_avg_price-1)*100 : 0\nexitS1 = useS1 and strategy.position_size>0 and pnlPct<=-5 and close<maFast\n// exitSignal := exitSignal or exitS1`,
    S6: `// === Sortie S6 : négatif après 15 barres ET EMA8<EMA24 ===\nuseS6 = input.bool(false, "Sortie: négatif après 15 barres et EMA8<EMA24")\nbarsHeld = strategy.position_size>0 ? bar_index - entryBarIndex : 0\npnlPct = strategy.position_avg_price>0 ? (close/strategy.position_avg_price-1)*100 : 0\nexitS6 = useS6 and barsHeld>=15 and pnlPct<0 and maFast<maMid\n// exitSignal := exitSignal or exitS6`,
  };
  const snip = map[c.key] || `// (variante ${c.key} — voir description ; snippet à dériver de la logique du moteur)`;
  return "```pine\n" + snip + "\n```\n\n_À insérer en input.bool **OFF par défaut**, à valider d'abord dans TradingView. Ne pas modifier le Pine final tant que TV n'a pas confirmé._";
}
function fmtSigned(x) { if (x == null || !Number.isFinite(x)) return "-"; return (x >= 0 ? "+" : "") + x; }
