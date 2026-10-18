/**
 * Backtest objectif des règles de signal LIVE "Top Risk TQQQ" (Pine Script).
 * Usage: node scripts/backtestTopRiskLiveRules.mjs [TQQQ]
 *
 * Objectif : tester plusieurs configurations de règles (A..G) avec différentes
 * déduplications (cooldown / entrée de régime) sur les données HISTORIQUES réelles
 * de TQQQ, puis recommander la meilleure config pour un Pine Script final.
 *
 * IMPORTANT (contraintes de la mission)
 *  - Script d'audit SÉPARÉ. Ne touche ni au dashboard, ni au moteur Wheel, ni au Journal POP.
 *  - AUCUN lookahead dans les indicateurs :
 *      • le contexte WEEKLY d'une barre daily utilise la DERNIÈRE semaine TERMINÉE (wi-1),
 *        jamais la semaine en cours (qui contiendrait le futur de la semaine).
 *      • les rendements futurs servent UNIQUEMENT à labelliser les tops (autorisé).
 *  - Les captures TradingView ne sont PAS la source de vérité : on compare seulement
 *    avec le dernier CSV debug/top-risk-tv-dates-TQQQ-*.csv (dates de tops réels dérivées des drops).
 *
 * NOTE SUR LES SCORES
 *  Aucun fichier .pine n'existe dans le repo : les scores weeklyScore / dailyScore /
 *  mtfBonus / combinedScore sont RECONSTRUITS ici à partir de la liste exacte
 *  d'indicateurs fournie dans la mission. Les poids sont des constantes auditables
 *  en tête de fichier (bloc SCORE_WEIGHTS) — faciles à ajuster avant d'écrire le Pine.
 *
 * Sorties :
 *   - rapport console
 *   - debug/top-risk-live-rules-backtest-summary-{ts}.csv
 *   - debug/top-risk-live-rules-backtest-{ts}.json
 *   - debug/top-risk-live-rules-backtest-events-{ts}.csv
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEBUG_DIR = path.join(ROOT, "debug");

const CLI = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const TICKER = (CLI[0] ?? "TQQQ").trim().toUpperCase();

/* ───────────────────────── Définitions de tops (mission) ───────────────────────── */
// DAILY — les signaux LIVE se déclenchent sur barres daily, donc on labellise en daily.
const DAILY_H = { veryShort: 5, swing: 10, medium: 20, major: 40 };
const DAILY_THRESH = { veryShort: -0.06, swing: -0.1, medium: -0.15, major: -0.25 };
const MAX_FORWARD = 40; // horizon max pour labelliser un top daily

/* ───────────────────────── Poids des scores (RECONSTRUITS) ─────────────────────────
 * Reconstruction transparente à partir de la liste d'indicateurs de la mission.
 * Chaque score est plafonné à 100. Les seuils des configs (55/40/25/35/45/65/80,
 * mtfBonus>=15) sont donc à lire relativement à ces poids.
 */
const SCORE_WEIGHTS = {
  weekly: {
    rsi70: 18, rsi75extra: 12,        // RSI14 weekly > 70 (+ extra si > 75)
    ext50_15: 16, ext50_25extra: 8,   // distance prix vs SMA50 weekly (>15%, +extra >25%)
    ret8_25: 14, ret12_40: 8,         // rendement 8s > 25%, rendement 12s > 40%
    bbUpper: 14, bbUpperRsi70extra: 8,// prix > Bollinger sup (+extra si RSI>70)
    volSpike2x: 10,                   // volume spike weekly > 2x moy 20s
    longWick: 8,                      // longue mèche haute weekly
  },
  daily: {
    rsi70: 14, rsi75extra: 8,         // RSI14 > 70 (+ extra > 75)
    bbUpper: 10, bbUpperRsi70extra: 6,// prix > Bollinger sup (+extra si RSI>70)
    ret10_15: 12, ret20_25: 8,        // rendement 10j > 15%, 20j > 25%
    ext50_15: 12, ext50_25extra: 6,   // distance prix vs SMA50 (>15%, +extra >25%)
    histFall3: 8,                     // histogramme MACD baisse 3 jours
    belowSma8: 6, belowSma21: 6,      // clôture sous SMA8 / SMA21
    distribution: 8,                  // distribution day
    longWick: 6,                      // longue mèche haute
    bearEngulf: 8,                    // bearish engulfing
    volSpike2x: 6,                    // volume spike > 2x
  },
  // mtfBonus : weekly étiré + faiblesse daily confirmée (combos multi-timeframe)
  mtf: {
    wRsi70_dWeak: 8,        // weekly RSI>70 ET au moins une faiblesse daily
    wExt_dBreak: 8,         // weekly extension SMA50>15% ET (close<SMA8 ou close<SMA21)
    wBb_dCandle: 7,         // weekly BB sup ET (bear engulf / distribution / mèche daily)
    wVol_dWick: 5,          // weekly vol spike ET mèche haute daily
    wRsi75_dDistrib: 7,     // weekly RSI>75 ET distribution day daily
  },
};

// combinedScore = 0.5*weekly + 0.5*daily + mtfBonus  (plafonné à 100)
function combineScore(weekly, daily, mtf) {
  return Math.round(Math.min(100, 0.5 * weekly + 0.5 * daily + mtf));
}

/* ───────────────────────── Classification universelle des niveaux ─────────────────────────
 * Sert à COMPTER watch / confirmed / extreme de façon comparable entre configs.
 */
function classifyLevel(s) {
  const { combined, weekly, daily, mtf } = s;
  if (combined >= 80 && weekly >= 55 && mtf >= 15) return "EXT";
  if (combined >= 65 && mtf >= 15 && weekly >= 40 && daily >= 25) return "CONFIRMED";
  if (combined >= 55 && weekly >= 40 && daily >= 25) return "WATCH";
  return "NONE";
}
const LEVEL_RANK = { NONE: 0, WATCH: 1, CONFIRMED: 2, EXT: 3 };

/* ───────────────────────── Indicateurs (mêmes formules que l'audit existant) ───────────────────────── */
function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = toNum(values[j]);
      if (v == null) { ok = false; break; }
      sum += v;
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const v = toNum(values[i]);
    if (v == null) return out;
    sum += v;
  }
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    const v = toNum(values[i]);
    if (v == null) return out;
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgGain += ch; else avgLoss += Math.abs(ch);
  }
  avgGain /= period; avgLoss /= period;
  const calc = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = calc(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? Math.abs(ch) : 0)) / period;
    out[i] = calc(avgGain, avgLoss);
  }
  return out;
}
function macdHistSeries(closes) {
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const macd = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null));
  const sig = emaSeries(macd.map((v) => v ?? 0), 9);
  return closes.map((_, i) => (macd[i] != null && sig[i] != null ? macd[i] - sig[i] : null));
}
function bollingerSeries(closes, period = 20) {
  const mid = smaSeries(closes, period);
  const upper = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i];
    if (m == null) continue;
    const slice = closes.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / period);
    upper[i] = m + 2 * sd;
  }
  return { mid, upper };
}
function returnBarsSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    if (closes[i - n] > 0) out[i] = closes[i] / closes[i - n] - 1;
  }
  return out;
}

/* ───────────────────────── Semaines ISO ───────────────────────── */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((d - jan1) / 86_400_000 + 1) / 7), year: d.getUTCFullYear() };
}
function weekKey(date) {
  const { week, year } = isoWeek(date);
  return `${year}-W${String(week > 52 ? 52 : week).padStart(2, "0")}`;
}

/* ───────────────────────── Chargement des données (cache disque) ───────────────────────── */
function cacheFile(symbol) {
  return path.join(DEBUG_DIR, `ohlc-cache-${String(symbol).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function loadBars(symbol) {
  const p = cacheFile(symbol);
  if (!fs.existsSync(p)) return null;
  try {
    const rows = (JSON.parse(fs.readFileSync(p, "utf8")).rows ?? [])
      .map((r) => ({ date: new Date(r.date), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: r.volume == null ? null : +r.volume }))
      .filter((r) => r.close > 0 && !Number.isNaN(r.date.getTime()))
      .sort((a, b) => a.date - b.date);
    return rows.length >= 200 ? rows : null;
  } catch { return null; }
}

function aggregateWeekly(daily) {
  const buckets = new Map();
  for (const r of daily) {
    const k = weekKey(r.date);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const weeks = [];
  for (const [key, arr0] of buckets) {
    const arr = arr0.sort((a, b) => a.date - b.date);
    const vols = arr.map((x) => x.volume).filter((v) => v != null);
    weeks.push({
      key, date: arr.at(-1).date,
      open: arr[0].open, high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)), close: arr.at(-1).close,
      volume: vols.length ? vols.reduce((s, v) => s + v, 0) : null,
    });
  }
  weeks.sort((a, b) => a.date - b.date);
  return weeks;
}

/* ───────────────────────── Contexte WEEKLY (par semaine terminée) ───────────────────────── */
function buildWeeklyContext(weeks) {
  const closes = weeks.map((w) => w.close);
  const n = weeks.length;
  const rsi14 = rsiSeries(closes, 14);
  const sma50 = smaSeries(closes, 50);
  const ret8 = returnBarsSeries(closes, 8);
  const ret12 = returnBarsSeries(closes, 12);
  const bb = bollingerSeries(closes, 20);
  const volMa20 = smaSeries(weeks.map((w) => w.volume ?? 0), 20);
  const relVol = weeks.map((w, i) => (volMa20[i] > 0 && w.volume ? w.volume / volMa20[i] : null));
  const ctx = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = weeks[i];
    const range = w.high - w.low;
    const longWick = range > 0 && (w.high - Math.max(w.open, w.close)) / range > 0.4;
    const extPct = sma50[i] > 0 ? closes[i] / sma50[i] - 1 : null;
    ctx[i] = {
      rsi14: rsi14[i], extPct, ret8: ret8[i], ret12: ret12[i],
      aboveBb: bb.upper[i] != null && closes[i] > bb.upper[i],
      volSpike2x: relVol[i] != null && relVol[i] > 2,
      longWick,
    };
  }
  return ctx;
}

function weeklyScoreFor(w) {
  if (!w) return 0;
  const W = SCORE_WEIGHTS.weekly;
  let s = 0;
  if (w.rsi14 != null && w.rsi14 > 70) { s += W.rsi70; if (w.rsi14 > 75) s += W.rsi75extra; }
  if (w.extPct != null && w.extPct > 0.15) { s += W.ext50_15; if (w.extPct > 0.25) s += W.ext50_25extra; }
  if (w.ret8 != null && w.ret8 > 0.25) s += W.ret8_25;
  if (w.ret12 != null && w.ret12 > 0.4) s += W.ret12_40;
  if (w.aboveBb) { s += W.bbUpper; if (w.rsi14 != null && w.rsi14 > 70) s += W.bbUpperRsi70extra; }
  if (w.volSpike2x) s += W.volSpike2x;
  if (w.longWick) s += W.longWick;
  return Math.min(100, s);
}

/* ───────────────────────── Contexte DAILY ───────────────────────── */
function buildDailyContext(bars) {
  const closes = bars.map((b) => b.close);
  const n = bars.length;
  const sma8 = smaSeries(closes, 8);
  const sma21 = smaSeries(closes, 21);
  const sma50 = smaSeries(closes, 50);
  const rsi14 = rsiSeries(closes, 14);
  const hist = macdHistSeries(closes);
  const bb = bollingerSeries(closes, 20);
  const ret10 = returnBarsSeries(closes, 10);
  const ret20 = returnBarsSeries(closes, 20);
  const volMa20 = smaSeries(bars.map((b) => b.volume ?? 0), 20);
  const relVol = bars.map((b, i) => (volMa20[i] > 0 && b.volume != null ? b.volume / volMa20[i] : null));

  const histFall3 = (i) => {
    if (i < 4 || hist[i] == null) return false;
    for (let k = 0; k < 3; k++) {
      if (hist[i - k] == null || hist[i - k - 1] == null || !(hist[i - k] < hist[i - k - 1])) return false;
    }
    return true;
  };
  const longWick = (i) => {
    const range = bars[i].high - bars[i].low;
    return range > 0 && (bars[i].high - Math.max(bars[i].open, bars[i].close)) / range > 0.4;
  };
  const bearEngulf = (i) => i > 0 && bars[i].close < bars[i].open && bars[i - 1].close > bars[i - 1].open
    && bars[i].open >= bars[i - 1].close && bars[i].close <= bars[i - 1].open;
  const distribution = (i) => i > 0 && bars[i].close < bars[i - 1].close && relVol[i] != null && relVol[i] > 1.2
    && sma21[i] > 0 && closes[i] / sma21[i] - 1 > 0.05;

  const ctx = new Array(n);
  for (let i = 0; i < n; i++) {
    const extPct = sma50[i] > 0 ? closes[i] / sma50[i] - 1 : null;
    const belowSma8 = sma8[i] != null && closes[i] < sma8[i];
    const belowSma21 = sma21[i] != null && closes[i] < sma21[i];
    const hist3 = histFall3(i);
    const distrib = distribution(i);
    const wick = longWick(i);
    const engulf = bearEngulf(i);
    ctx[i] = {
      rsi14: rsi14[i], extPct, ret10: ret10[i], ret20: ret20[i],
      aboveBb: bb.upper[i] != null && closes[i] > bb.upper[i],
      volSpike2x: relVol[i] != null && relVol[i] > 2,
      histFall3: hist3, belowSma8, belowSma21, distribution: distrib, longWick: wick, bearEngulf: engulf,
      // faiblesse daily (config B / E2 / mtf)
      weakness: hist3 || belowSma8 || belowSma21 || distrib || wick || engulf,
    };
  }
  return ctx;
}

function dailyScoreFor(d) {
  const D = SCORE_WEIGHTS.daily;
  let s = 0;
  if (d.rsi14 != null && d.rsi14 > 70) { s += D.rsi70; if (d.rsi14 > 75) s += D.rsi75extra; }
  if (d.aboveBb) { s += D.bbUpper; if (d.rsi14 != null && d.rsi14 > 70) s += D.bbUpperRsi70extra; }
  if (d.ret10 != null && d.ret10 > 0.15) s += D.ret10_15;
  if (d.ret20 != null && d.ret20 > 0.25) s += D.ret20_25;
  if (d.extPct != null && d.extPct > 0.15) { s += D.ext50_15; if (d.extPct > 0.25) s += D.ext50_25extra; }
  if (d.histFall3) s += D.histFall3;
  if (d.belowSma8) s += D.belowSma8;
  if (d.belowSma21) s += D.belowSma21;
  if (d.distribution) s += D.distribution;
  if (d.longWick) s += D.longWick;
  if (d.bearEngulf) s += D.bearEngulf;
  if (d.volSpike2x) s += D.volSpike2x;
  return Math.min(100, s);
}

function mtfBonusFor(w, d) {
  if (!w) return 0;
  const M = SCORE_WEIGHTS.mtf;
  let s = 0;
  if (w.rsi14 != null && w.rsi14 > 70 && d.weakness) s += M.wRsi70_dWeak;
  if (w.extPct != null && w.extPct > 0.15 && (d.belowSma8 || d.belowSma21)) s += M.wExt_dBreak;
  if (w.aboveBb && (d.bearEngulf || d.distribution || d.longWick)) s += M.wBb_dCandle;
  if (w.volSpike2x && d.longWick) s += M.wVol_dWick;
  if (w.rsi14 != null && w.rsi14 > 75 && d.distribution) s += M.wRsi75_dDistrib;
  return s;
}

/* ───────────────────────── Labels futurs (drawdown) — autorisé ───────────────────────── */
function attachForward(bars) {
  for (let i = 0; i < bars.length; i++) {
    const base = bars[i].close;
    const maxDrop = {};
    const dayToMin = {};
    for (const [, h] of Object.entries(DAILY_H)) {
      let minRet = 0, minAt = null;
      for (let j = 1; j <= h && i + j < bars.length; j++) {
        const r = bars[i + j].close / base - 1;
        if (r < minRet) { minRet = r; minAt = j; }
      }
      maxDrop[h] = minRet;
      dayToMin[h] = minAt;
    }
    bars[i].fwd = { maxDrop, dayToMin };
    bars[i].labelable = i + MAX_FORWARD < bars.length;
    bars[i].topVeryShort = maxDrop[DAILY_H.veryShort] <= DAILY_THRESH.veryShort;
    bars[i].topSwing = maxDrop[DAILY_H.swing] <= DAILY_THRESH.swing;
    bars[i].topMedium = maxDrop[DAILY_H.medium] <= DAILY_THRESH.medium;
    bars[i].topMajor = maxDrop[DAILY_H.major] <= DAILY_THRESH.major;
  }
}

/* ───────────────────────── Construction de la table de scores par jour ───────────────────────── */
function buildScoredDays(bars, dctx, wctx, dailyToCompletedWeek, warmup) {
  const days = [];
  for (let i = 0; i < bars.length; i++) {
    const d = dctx[i];
    const wIdx = dailyToCompletedWeek[i]; // dernière semaine TERMINÉE (no lookahead)
    const w = wIdx != null && wIdx >= 0 ? wctx[wIdx] : null;
    const weekly = weeklyScoreFor(w);
    const daily = dailyScoreFor(d);
    const mtf = mtfBonusFor(w, d);
    const combined = combineScore(weekly, daily, mtf);
    const scores = { weekly, daily, mtf, combined };
    const level = classifyLevel(scores);
    days.push({
      idx: i,
      date: bars[i].date.toISOString().slice(0, 10),
      year: bars[i].date.getUTCFullYear(),
      close: bars[i].close,
      weekly, daily, mtf, combined, level,
      weakness: d.weakness,
      labelable: bars[i].labelable,
      fwd: bars[i].fwd,
      topVeryShort: bars[i].topVeryShort,
      topSwing: bars[i].topSwing,
      topMedium: bars[i].topMedium,
      topMajor: bars[i].topMajor,
      warmedUp: i >= warmup,
    });
  }
  return days;
}

/* ───────────────────────── Définition des configurations ───────────────────────── */
/*
 * Chaque config = un PRÉDICAT "qualify(day)" (la barre est-elle candidate ?)
 *               + un mode de déduplication
 *               + une option requireWeakness.
 * Le niveau affiché (WATCH/CONFIRMED/EXT) reste donné par classifyLevel pour comparer.
 */
function makeConfigs() {
  const qWatch = (d) => LEVEL_RANK[d.level] >= LEVEL_RANK.WATCH; // combined>=55 & weekly>=40 & daily>=25
  const qConfirmed = (d) => LEVEL_RANK[d.level] >= LEVEL_RANK.CONFIRMED; // + mtf>=15 & combined>=65
  const qStrict = (d) => d.combined >= 65 && d.weekly >= 45 && d.daily >= 35 && d.mtf >= 15;

  return [
    // A — base permissive (WATCH+), cooldown 12j
    { name: "A_base_permissive_cd12", group: "A", qualify: qWatch, dedup: { mode: "cooldown", days: 12 }, requireWeakness: false,
      note: "WATCH si combined>=55 & weekly>=40 & daily>=25, MTF non requis, cooldown 12j" },

    // B — base + faiblesse daily obligatoire, cooldown 12j
    { name: "B_base_faiblesse_cd12", group: "B", qualify: qWatch, dedup: { mode: "cooldown", days: 12 }, requireWeakness: true,
      note: "Comme A mais WATCH exige >=1 faiblesse daily" },

    // C — MTF confirmé seulement
    { name: "C_mtf_confirme", group: "C", qualify: qConfirmed, dedup: { mode: "cooldown", days: 12 }, requireWeakness: false,
      note: "Signal si combined>=65 & weekly>=40 & daily>=25 & mtfBonus>=15" },

    // D — strict
    { name: "D_strict", group: "D", qualify: qStrict, dedup: { mode: "cooldown", days: 12 }, requireWeakness: false,
      note: "Signal si combined>=65 & weekly>=45 & daily>=35 & mtfBonus>=15" },

    // E — entrée de régime (avec / sans faiblesse)
    { name: "E1_regime_entry", group: "E", qualify: qWatch, dedup: { mode: "regime" }, requireWeakness: false,
      note: "Entrée de régime : signal au passage NONE -> WATCH/CONFIRMED (sans faiblesse obligatoire)" },
    { name: "E2_regime_entry_faiblesse", group: "E", qualify: qWatch, dedup: { mode: "regime" }, requireWeakness: true,
      note: "Entrée de régime + faiblesse daily obligatoire" },

    // F — cooldown 10 / 20 / 40 (base WATCH+)
    { name: "F_cooldown_10", group: "F", qualify: qWatch, dedup: { mode: "cooldown", days: 10 }, requireWeakness: false,
      note: "WATCH+ avec cooldown 10j" },
    { name: "F_cooldown_20", group: "F", qualify: qWatch, dedup: { mode: "cooldown", days: 20 }, requireWeakness: false,
      note: "WATCH+ avec cooldown 20j" },
    { name: "F_cooldown_40", group: "F", qualify: qWatch, dedup: { mode: "cooldown", days: 40 }, requireWeakness: false,
      note: "WATCH+ avec cooldown 40j" },

    // Déduplication exigée par la mission : aucun cooldown
    { name: "DEDUP_no_cooldown", group: "DEDUP", qualify: qWatch, dedup: { mode: "none" }, requireWeakness: false,
      note: "WATCH+ sans aucune déduplication (référence brute)" },

    // G — confirmed only vs watch+confirmed
    { name: "G1_confirmed_only_cd12", group: "G", qualify: qConfirmed, dedup: { mode: "cooldown", days: 12 }, requireWeakness: false,
      note: "Affiche seulement TOP RISK confirmé (MTF)" },
    { name: "G2_watch_plus_confirmed_cd12", group: "G", qualify: qWatch, dedup: { mode: "cooldown", days: 12 }, requireWeakness: false,
      note: "Affiche WATCH + TOP RISK confirmé" },
  ];
}

/* ───────────────────────── Génération des signaux d'une config ───────────────────────── */
function generateSignals(days, config, warmup, lastIdx) {
  const qualifies = (d) => d.warmedUp && d.idx <= lastIdx
    && config.qualify(d)
    && (!config.requireWeakness || d.weakness);

  const raw = days.filter(qualifies);

  if (config.dedup.mode === "none") return raw;

  if (config.dedup.mode === "cooldown") {
    const kept = [];
    let last = -Infinity;
    for (const d of raw) {
      if (d.idx - last >= config.dedup.days) { kept.push(d); last = d.idx; }
    }
    return kept;
  }

  if (config.dedup.mode === "regime") {
    // signal au front montant : barre qualifiante dont la précédente ne qualifiait pas
    const qualSet = new Set(raw.map((d) => d.idx));
    return raw.filter((d) => !qualSet.has(d.idx - 1));
  }

  return raw;
}

/* ───────────────────────── Baseline & métriques ───────────────────────── */
function computeBaseline(days, warmup, lastIdx) {
  let n = 0, vs = 0, sw = 0, md = 0, mj = 0;
  for (const d of days) {
    if (!d.warmedUp || d.idx > lastIdx) continue;
    n++;
    if (d.topVeryShort) vs++;
    if (d.topSwing) sw++;
    if (d.topMedium) md++;
    if (d.topMajor) mj++;
  }
  return {
    evaluableBars: n,
    topVeryShortRate: n ? vs / n : 0,
    topSwingRate: n ? sw / n : 0,
    topMediumRate: n ? md / n : 0,
    topMajorRate: n ? mj / n : 0,
  };
}

function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }

function evaluateConfig(events, baseline) {
  const labelable = events.filter((e) => e.labelable);
  const nL = labelable.length;
  const rate = (key) => (nL ? labelable.filter((e) => e[key]).length / nL : 0);

  const topVeryShortRate = rate("topVeryShort");
  const topSwingRate = rate("topSwing");
  const topMediumRate = rate("topMedium");
  const topMajorRate = rate("topMajor");

  const liftMajor = baseline.topMajorRate > 0 ? topMajorRate / baseline.topMajorRate : null;
  const liftMedium = baseline.topMediumRate > 0 ? topMediumRate / baseline.topMediumRate : null;
  const liftSwing = baseline.topSwingRate > 0 ? topSwingRate / baseline.topSwingRate : null;
  const liftVeryShort = baseline.topVeryShortRate > 0 ? topVeryShortRate / baseline.topVeryShortRate : null;

  const drops5 = labelable.map((e) => e.fwd.maxDrop[DAILY_H.veryShort]);
  const drops10 = labelable.map((e) => e.fwd.maxDrop[DAILY_H.swing]);
  const drops20 = labelable.map((e) => e.fwd.maxDrop[DAILY_H.medium]);
  const drops40 = labelable.map((e) => e.fwd.maxDrop[DAILY_H.major]);

  const avgDrawdown5d = avg(drops5);
  const avgDrawdown10d = avg(drops10);
  const avgDrawdown20d = avg(drops20);
  const avgDrawdown40d = avg(drops40);
  const worstDrawdown = drops40.length ? Math.min(...drops40) : null;

  // délai moyen jusqu'au pire drawdown (sur 40j)
  const delays = labelable.map((e) => e.fwd.dayToMin[DAILY_H.major]).filter((v) => v != null);
  const avgDaysToMaxDrawdown = avg(delays);

  // faux signaux = barres labelables ne touchant AUCUN seuil de top
  const falseSignalCount = labelable.filter((e) => !(e.topVeryShort || e.topSwing || e.topMedium || e.topMajor)).length;
  const falseSignalRate = nL ? falseSignalCount / nL : 0;

  // comptages par niveau (sur tous les events, pas seulement labelables)
  let watchCount = 0, confirmedCount = 0, extremeCount = 0;
  for (const e of events) {
    if (e.level === "WATCH") watchCount++;
    else if (e.level === "CONFIRMED") confirmedCount++;
    else if (e.level === "EXT") extremeCount++;
  }

  // signaux par année
  const byYear = {};
  for (const e of events) byYear[e.year] = (byYear[e.year] ?? 0) + 1;

  return {
    signalCount: events.length,
    labelableCount: nL,
    watchCount, confirmedCount, extremeCount,
    topVeryShortRate, topSwingRate, topMediumRate, topMajorRate,
    liftVeryShort, liftSwing, liftMedium, liftMajor,
    avgDrawdown5d, avgDrawdown10d, avgDrawdown20d, avgDrawdown40d, worstDrawdown,
    avgDaysToMaxDrawdown,
    falseSignalCount, falseSignalRate, falseSignalEstimate: falseSignalCount,
    byYear,
  };
}

/* ───────────────────────── Comparaison avec les dates TradingView ───────────────────────── */
function findLatestTvCsv() {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const files = fs.readdirSync(DEBUG_DIR)
    .filter((f) => f.match(/^top-risk-tv-dates-TQQQ-.+\.csv$/))
    .sort().reverse();
  return files[0] ? path.join(DEBUG_DIR, files[0]) : null;
}
function parseCsvLine(line) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function loadTvDates(csvPath) {
  const content = fs.readFileSync(csvPath, "utf8");
  const lines = content.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const iFinal = headers.indexOf("primaryDateFinal");
  const dates = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCsvLine(lines[i]);
    const d = vals[iFinal];
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d);
  }
  return [...new Set(dates)].sort();
}
function daysBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}
function compareToTv(events, tvDates) {
  const sigDates = events.map((e) => e.date);
  const sigSet = new Set(sigDates);
  let exact = 0, near5 = 0, near10 = 0, missed = 0;
  for (const tv of tvDates) {
    if (sigSet.has(tv)) { exact++; near5++; near10++; continue; }
    let best = Infinity;
    for (const s of sigDates) {
      const dd = daysBetween(tv, s);
      if (dd < best) best = dd;
    }
    if (best <= 5) near5++;
    if (best <= 10) near10++;
    else missed++;
  }
  // signaux "en trop" = signaux à >10j de toute date TV
  let extra = 0;
  for (const s of sigDates) {
    let best = Infinity;
    for (const tv of tvDates) {
      const dd = daysBetween(tv, s);
      if (dd < best) best = dd;
    }
    if (best > 10) extra++;
  }
  return { tvTotal: tvDates.length, tvExactMatches: exact, tvNear5dMatches: near5, tvNear10dMatches: near10, tvMissed: missed, tvExtra: extra };
}

/* ───────────────────────── Score de recommandation ───────────────────────── */
function recommendationScore(m, tv, fullYears) {
  let score = 0;
  const parts = {};

  // bonus lift top majeur (ratio vs baseline)
  const lift = m.liftMajor ?? 0;
  const liftBonus = Math.max(0, Math.min(30, (lift - 1) * 12));
  score += liftBonus; parts.liftBonus = round1(liftBonus);

  // bonus match clusters TV (couverture des tops réels à ±10j)
  const tvCover = tv.tvTotal ? tv.tvNear10dMatches / tv.tvTotal : 0;
  const tvBonus = tvCover * 28;
  score += tvBonus; parts.tvBonus = round1(tvBonus);

  // bonus nombre de signaux raisonnable : cible ~1.5 à 5 signaux / an
  const perYear = fullYears > 0 ? m.signalCount / fullYears : m.signalCount;
  let countBonus = 0;
  if (perYear >= 1.5 && perYear <= 5) countBonus = 15;
  else if (perYear >= 1 && perYear < 1.5) countBonus = 8;
  else if (perYear > 5 && perYear <= 8) countBonus = 6;
  score += countBonus; parts.countBonus = countBonus;

  // malus trop peu de signaux
  let fewPenalty = 0;
  if (m.signalCount < 10) fewPenalty = -25;
  else if (perYear < 1) fewPenalty = -12;
  score += fewPenalty; parts.fewPenalty = fewPenalty;

  // malus trop de signaux
  let manyPenalty = 0;
  if (perYear > 12) manyPenalty = -25;
  else if (perYear > 8) manyPenalty = -12;
  score += manyPenalty; parts.manyPenalty = manyPenalty;

  // malus faux signaux élevés
  const falsePenalty = -(m.falseSignalRate * 25);
  score += falsePenalty; parts.falsePenalty = round1(falsePenalty);

  // malus signal trop tardif (drop arrive tard dans la fenêtre 40j)
  const lateRatio = m.avgDaysToMaxDrawdown != null ? m.avgDaysToMaxDrawdown / MAX_FORWARD : 0;
  const latePenalty = -(Math.max(0, lateRatio - 0.5) * 16);
  score += latePenalty; parts.latePenalty = round1(latePenalty);

  return { score: round1(score), parts };
}
function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }
function pct(n) { return n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`; }
function liftFmt(n) { return n == null ? "—" : `${n.toFixed(2)}x`; }

/* ───────────────────────── MAIN ───────────────────────── */
function main() {
  console.log("=== BACKTEST RÈGLES LIVE TOP-RISK — " + TICKER + " ===\n");

  const bars = loadBars(TICKER);
  if (!bars) {
    console.error(`Cache ${cacheFile(TICKER)} introuvable ou insuffisant.`);
    console.error("Lancer d'abord: node scripts/auditTopCorrelationMultiTimeframe.mjs " + TICKER);
    process.exit(1);
  }
  console.log(`${TICKER} : ${bars[0].date.toISOString().slice(0, 10)} → ${bars.at(-1).date.toISOString().slice(0, 10)} (${bars.length} barres)`);

  // validation (info seulement)
  const qqq = loadBars("QQQ");
  const ndx = loadBars("_NDX") ?? loadBars("^NDX") ?? loadBars("NDX");
  console.log(`Validation : QQQ ${qqq ? "✓" : "✗"} | NDX ${ndx ? "✓" : "✗"} (info seulement, pas utilisé dans les scores)\n`);

  attachForward(bars);
  const weeks = aggregateWeekly(bars);
  const wctx = buildWeeklyContext(weeks);
  const dctx = buildDailyContext(bars);

  // map daily -> dernière semaine TERMINÉE (no lookahead)
  const weekIdxByKey = new Map(weeks.map((w, i) => [w.key, i]));
  const dailyToCompletedWeek = bars.map((b) => {
    const wi = weekIdxByKey.get(weekKey(b.date));
    return wi == null ? null : wi - 1; // semaine précédente, entièrement passée
  });

  const warmup = 252; // 1 an daily : suffit pour SMA/RSI/MACD/BB + plusieurs semaines
  const lastIdx = bars.length - 1; // on garde tous les signaux ; non-labelables exclus des taux
  const scoredDays = buildScoredDays(bars, dctx, wctx, dailyToCompletedWeek, warmup);

  const baseline = computeBaseline(scoredDays, warmup, lastIdx);
  const firstYear = bars[warmup].date.getUTCFullYear();
  const lastYear = bars.at(-1).date.getUTCFullYear();
  const fullYears = (bars.at(-1).date - bars[warmup].date) / (365.25 * 86_400_000);

  console.log(`Période évaluée : ${bars[warmup].date.toISOString().slice(0, 10)} → ${bars.at(-1).date.toISOString().slice(0, 10)} (~${fullYears.toFixed(1)} ans, ${baseline.evaluableBars} barres)`);
  console.log("\n--- BASELINE (probabilité de top sur TOUTES les dates) ---");
  console.log(`  top très court (≤-6% /5j)  : ${pct(baseline.topVeryShortRate)}`);
  console.log(`  top swing      (≤-10% /10j): ${pct(baseline.topSwingRate)}`);
  console.log(`  top moyen      (≤-15% /20j): ${pct(baseline.topMediumRate)}`);
  console.log(`  top majeur     (≤-25% /40j): ${pct(baseline.topMajorRate)}`);

  // TradingView reference
  const tvCsv = findLatestTvCsv();
  const tvDates = tvCsv ? loadTvDates(tvCsv) : [];
  console.log(`\nRéférence TradingView : ${tvCsv ? path.basename(tvCsv) : "(aucune)"} — ${tvDates.length} dates de tops réels\n`);

  const configs = makeConfigs();
  const results = [];

  for (const cfg of configs) {
    const events = generateSignals(scoredDays, cfg, warmup, lastIdx);
    const metrics = evaluateConfig(events, baseline);
    const tv = compareToTv(events, tvDates);
    const reco = recommendationScore(metrics, tv, fullYears);
    results.push({ cfg, events, metrics, tv, reco });
  }

  // tri par score de recommandation
  const ranked = [...results].sort((a, b) => b.reco.score - a.reco.score);

  /* ── Rapport console ── */
  console.log("=".repeat(96));
  console.log("RÉSULTATS PAR CONFIGURATION (trié par score de recommandation)");
  console.log("=".repeat(96));
  for (const r of ranked) {
    const m = r.metrics;
    console.log(`\n■ ${r.cfg.name}   [reco ${r.reco.score}]`);
    console.log(`  ${r.cfg.note}`);
    console.log(`  signaux: ${m.signalCount} (W:${m.watchCount} C:${m.confirmedCount} EXT:${m.extremeCount}) | ~${(m.signalCount / fullYears).toFixed(1)}/an | labelables: ${m.labelableCount}`);
    console.log(`  taux tops — très court ${pct(m.topVeryShortRate)} | swing ${pct(m.topSwingRate)} | moyen ${pct(m.topMediumRate)} | majeur ${pct(m.topMajorRate)}`);
    console.log(`  lift   — très court ${liftFmt(m.liftVeryShort)} | swing ${liftFmt(m.liftSwing)} | moyen ${liftFmt(m.liftMedium)} | majeur ${liftFmt(m.liftMajor)}`);
    console.log(`  drawdown moyen — 5j ${pct(m.avgDrawdown5d)} | 10j ${pct(m.avgDrawdown10d)} | 20j ${pct(m.avgDrawdown20d)} | 40j ${pct(m.avgDrawdown40d)} | pire ${pct(m.worstDrawdown)}`);
    console.log(`  délai moyen avant pire drawdown : ${m.avgDaysToMaxDrawdown != null ? m.avgDaysToMaxDrawdown.toFixed(1) + " j" : "—"}`);
    console.log(`  faux signaux : ${m.falseSignalCount} (${pct(m.falseSignalRate)})`);
    console.log(`  TV (${r.tv.tvTotal} tops) — exact ${r.tv.tvExactMatches} | ±5j ${r.tv.tvNear5dMatches} | ±10j ${r.tv.tvNear10dMatches} | manqués ${r.tv.tvMissed} | en trop ${r.tv.tvExtra}`);
    console.log(`  reco détail : ${JSON.stringify(r.reco.parts)}`);
  }

  /* ── Meilleure config ── */
  const best = ranked[0];
  console.log("\n" + "=".repeat(96));
  console.log("MEILLEURE CONFIGURATION RECOMMANDÉE");
  console.log("=".repeat(96));
  console.log(`  → ${best.cfg.name} (score ${best.reco.score})`);
  console.log(`  ${best.cfg.note}`);
  console.log(`  ${best.metrics.signalCount} signaux (~${(best.metrics.signalCount / fullYears).toFixed(1)}/an), lift majeur ${liftFmt(best.metrics.liftMajor)}, couverture TV ±10j ${best.tv.tvNear10dMatches}/${best.tv.tvTotal}, faux signaux ${pct(best.metrics.falseSignalRate)}`);

  /* ── Top 20 dates du best ── */
  const top20 = [...best.events.filter((e) => e.labelable)]
    .sort((a, b) => a.fwd.maxDrop[DAILY_H.major] - b.fwd.maxDrop[DAILY_H.major])
    .slice(0, 20);
  console.log(`\n  Top 20 dates de signaux (${best.cfg.name}, triées par pire drop 40j) :`);
  for (const e of top20) {
    console.log(`    ${e.date} | close ${e.close.toFixed(2)} | ${e.level} | combined ${e.combined} (W${e.weekly}/D${e.daily}/M${e.mtf}) | drop40 ${pct(e.fwd.maxDrop[DAILY_H.major])}`);
  }

  /* ── Sorties fichiers ── */
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // 1) summary CSV
  const summaryCols = [
    "configName", "signalCount", "watchCount", "confirmedCount", "extremeCount",
    "topVeryShortRate", "topSwingRate", "topMediumRate", "topMajorRate",
    "baselineMajorRate", "liftMajor", "avgDrawdown20d", "avgDrawdown40d", "worstDrawdown",
    "avgDaysToMaxDrawdown", "tvExactMatches", "tvNear5dMatches", "tvNear10dMatches", "tvMissed",
    "falseSignalEstimate", "recommendationScore",
  ];
  const summaryRows = ranked.map((r) => ({
    configName: r.cfg.name,
    signalCount: r.metrics.signalCount,
    watchCount: r.metrics.watchCount,
    confirmedCount: r.metrics.confirmedCount,
    extremeCount: r.metrics.extremeCount,
    topVeryShortRate: round3(r.metrics.topVeryShortRate),
    topSwingRate: round3(r.metrics.topSwingRate),
    topMediumRate: round3(r.metrics.topMediumRate),
    topMajorRate: round3(r.metrics.topMajorRate),
    baselineMajorRate: round3(baseline.topMajorRate),
    liftMajor: round3(r.metrics.liftMajor),
    avgDrawdown20d: round3(r.metrics.avgDrawdown20d),
    avgDrawdown40d: round3(r.metrics.avgDrawdown40d),
    worstDrawdown: round3(r.metrics.worstDrawdown),
    avgDaysToMaxDrawdown: round1(r.metrics.avgDaysToMaxDrawdown),
    tvExactMatches: r.tv.tvExactMatches,
    tvNear5dMatches: r.tv.tvNear5dMatches,
    tvNear10dMatches: r.tv.tvNear10dMatches,
    tvMissed: r.tv.tvMissed,
    falseSignalEstimate: r.metrics.falseSignalEstimate,
    recommendationScore: r.reco.score,
  }));
  const summaryPath = path.join(DEBUG_DIR, `top-risk-live-rules-backtest-summary-${ts}.csv`);
  fs.writeFileSync(summaryPath, toCsv(summaryCols, summaryRows), "utf8");

  // 2) events CSV
  const eventCols = ["configName", "date", "year", "close", "level", "weeklyScore", "dailyScore", "mtfBonus", "combinedScore",
    "weakness", "labelable", "drop5", "drop10", "drop20", "drop40", "daysToMaxDrop40", "topVeryShort", "topSwing", "topMedium", "topMajor"];
  const eventRows = [];
  for (const r of ranked) {
    for (const e of r.events) {
      eventRows.push({
        configName: r.cfg.name, date: e.date, year: e.year, close: round4(e.close), level: e.level,
        weeklyScore: e.weekly, dailyScore: e.daily, mtfBonus: e.mtf, combinedScore: e.combined,
        weakness: e.weakness, labelable: e.labelable,
        drop5: round3(e.fwd.maxDrop[DAILY_H.veryShort]), drop10: round3(e.fwd.maxDrop[DAILY_H.swing]),
        drop20: round3(e.fwd.maxDrop[DAILY_H.medium]), drop40: round3(e.fwd.maxDrop[DAILY_H.major]),
        daysToMaxDrop40: e.fwd.dayToMin[DAILY_H.major] ?? "",
        topVeryShort: e.topVeryShort, topSwing: e.topSwing, topMedium: e.topMedium, topMajor: e.topMajor,
      });
    }
  }
  const eventsPath = path.join(DEBUG_DIR, `top-risk-live-rules-backtest-events-${ts}.csv`);
  fs.writeFileSync(eventsPath, toCsv(eventCols, eventRows), "utf8");

  // 3) JSON détaillé
  const jsonPath = path.join(DEBUG_DIR, `top-risk-live-rules-backtest-${ts}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    ticker: TICKER,
    dataRange: { first: bars[0].date.toISOString().slice(0, 10), last: bars.at(-1).date.toISOString().slice(0, 10), bars: bars.length },
    evaluatedRange: { firstYear, lastYear, fullYears: round1(fullYears), warmup, evaluableBars: baseline.evaluableBars },
    note: "Scores RECONSTRUITS depuis la liste d'indicateurs de la mission (aucun .pine dans le repo). Aucun lookahead : weekly = derniere semaine terminee.",
    scoreWeights: SCORE_WEIGHTS,
    combinedFormula: "round(min(100, 0.5*weekly + 0.5*daily + mtfBonus))",
    levelClassifier: "EXT: combined>=80 & weekly>=55 & mtf>=15 | CONFIRMED: combined>=65 & mtf>=15 & weekly>=40 & daily>=25 | WATCH: combined>=55 & weekly>=40 & daily>=25",
    baseline,
    tvReference: { csv: tvCsv ? path.basename(tvCsv) : null, dateCount: tvDates.length, dates: tvDates },
    bestConfig: best.cfg.name,
    configs: ranked.map((r) => ({
      name: r.cfg.name, group: r.cfg.group, note: r.cfg.note,
      dedup: r.cfg.dedup, requireWeakness: r.cfg.requireWeakness,
      metrics: r.metrics, tv: r.tv, recommendation: r.reco,
      eventDates: r.events.map((e) => e.date),
      byYear: r.metrics.byYear,
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  console.log("\n" + "=".repeat(96));
  console.log("FICHIERS GÉNÉRÉS");
  console.log(`  Résumé CSV   : ${summaryPath}`);
  console.log(`  Événements   : ${eventsPath}`);
  console.log(`  JSON détaillé: ${jsonPath}`);
  console.log("\n(Backtest seulement — aucun Pine écrit. Voir la synthèse pour la config recommandée.)");
}

function round3(n) { return n == null || !Number.isFinite(n) ? "" : Math.round(n * 1000) / 1000; }
function round4(n) { return n == null || !Number.isFinite(n) ? "" : Math.round(n * 10000) / 10000; }
function toCsv(cols, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return `${cols.join(",")}\n${body}`;
}

main();
