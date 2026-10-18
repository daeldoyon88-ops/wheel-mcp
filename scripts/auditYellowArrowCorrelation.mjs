/**
 * Audit complet — corrélation flèches jaunes TradingView (WATCH) vs drawdowns TQQQ
 * et règles Top Risk auditées (E2_regime_entry_faiblesse).
 *
 * Usage: node scripts/auditYellowArrowCorrelation.mjs [TQQQ]
 *
 * Reproduit la logique Pine debug/TQQQ_Top_Risk_Live_Final.pine :
 *   - Flèche jaune = dispWatch = entrée de régime WATCH (level==1) + faiblesse daily
 *   - Mode affichage par défaut : "Zone de risque" (pas "Action cassure")
 *
 * Sorties :
 *   - rapport console
 *   - debug/tqqq-yellow-arrow-correlation-audit.md
 *   - debug/tqqq-yellow-arrow-correlation-audit-{ts}.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEBUG_DIR = path.join(ROOT, "debug");

const CLI = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const TICKER = (CLI[0] ?? "TQQQ").trim().toUpperCase();

const PINE_PATH = path.join(DEBUG_DIR, "TQQQ_Top_Risk_Live_Final.pine");
const HORIZONS = [5, 10, 20, 40];
const DROP_THRESHOLDS = [0.05, 0.10, 0.15, 0.20];
const WARMUP = 252;
const LOCAL_PEAK_LOOKBACK = 20;
const LOCAL_PEAK_TOLERANCE = 0.03; // within 3% of recent high
const LATE_DROP_THRESHOLD = 0.05; // already down 5%+ from recent high

const SCORE_WEIGHTS = {
  weekly: {
    rsi70: 18, rsi75extra: 12, ext50_15: 16, ext50_25extra: 8,
    ret8_25: 14, ret12_40: 8, bbUpper: 14, bbUpperRsi70extra: 8,
    volSpike2x: 10, longWick: 8,
  },
  daily: {
    rsi70: 14, rsi75extra: 8, bbUpper: 10, bbUpperRsi70extra: 6,
    ret10_15: 12, ret20_25: 8, ext50_15: 12, ext50_25extra: 6,
    histFall3: 8, belowSma8: 6, belowSma21: 6, distribution: 8,
    longWick: 6, bearEngulf: 8, volSpike2x: 6,
  },
  mtf: {
    wRsi70_dWeak: 8, wExt_dBreak: 8, wBb_dCandle: 7,
    wVol_dWick: 5, wRsi75_dDistrib: 7,
  },
};

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function round3(n) { return n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000; }
function round2(n) { return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100; }
function daysBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
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

let bars = [];

function cacheFile(symbol) {
  return path.join(DEBUG_DIR, `ohlc-cache-${String(symbol).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function loadBars(symbol) {
  const p = cacheFile(symbol);
  if (!fs.existsSync(p)) return null;
  try {
    bars = (JSON.parse(fs.readFileSync(p, "utf8")).rows ?? [])
      .map((r) => ({
        date: new Date(r.date),
        open: +r.open, high: +r.high, low: +r.low, close: +r.close,
        volume: r.volume == null ? null : +r.volume,
      }))
      .filter((r) => r.close > 0 && !Number.isNaN(r.date.getTime()))
      .sort((a, b) => a.date - b.date);
    return bars.length >= 200 ? bars : null;
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
  for (const [, arr0] of buckets) {
    const arr = arr0.sort((a, b) => a.date - b.date);
    const vols = arr.map((x) => x.volume).filter((v) => v != null);
    weeks.push({
      key: weekKey(arr.at(-1).date), date: arr.at(-1).date,
      open: arr[0].open, high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)), close: arr.at(-1).close,
      volume: vols.length ? vols.reduce((s, v) => s + v, 0) : null,
    });
  }
  weeks.sort((a, b) => a.date - b.date);
  return weeks;
}

function buildWeeklyContext(weeks) {
  const closes = weeks.map((w) => w.close);
  const rsi14 = rsiSeries(closes, 14);
  const sma50 = smaSeries(closes, 50);
  const ret8 = returnBarsSeries(closes, 8);
  const ret12 = returnBarsSeries(closes, 12);
  const bb = bollingerSeries(closes, 20);
  const volMa20 = smaSeries(weeks.map((w) => w.volume ?? 0), 20);
  const relVol = weeks.map((w, i) => (volMa20[i] > 0 && w.volume ? w.volume / volMa20[i] : null));
  const ctx = [];
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    const range = w.high - w.low;
    const longWick = range > 0 && (w.high - Math.max(w.open, w.close)) / range > 0.4;
    const extPct = sma50[i] > 0 ? closes[i] / sma50[i] - 1 : null;
    ctx.push({
      rsi14: rsi14[i], extPct, ret8: ret8[i], ret12: ret12[i],
      aboveBb: bb.upper[i] != null && closes[i] > bb.upper[i],
      volSpike2x: relVol[i] != null && relVol[i] > 2,
      longWick,
    });
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

function buildDailyContext(barsIn) {
  const closes = barsIn.map((b) => b.close);
  const sma8 = smaSeries(closes, 8);
  const sma21 = smaSeries(closes, 21);
  const sma50 = smaSeries(closes, 50);
  const rsi14 = rsiSeries(closes, 14);
  const hist = macdHistSeries(closes);
  const bb = bollingerSeries(closes, 20);
  const ret10 = returnBarsSeries(closes, 10);
  const ret20 = returnBarsSeries(closes, 20);
  const volMa20 = smaSeries(barsIn.map((b) => b.volume ?? 0), 20);
  const relVol = barsIn.map((b, i) => (volMa20[i] > 0 && b.volume != null ? b.volume / volMa20[i] : null));

  const histFall3 = (i) => {
    if (i < 4 || hist[i] == null) return false;
    for (let k = 0; k < 3; k++) {
      if (hist[i - k] == null || hist[i - k - 1] == null || !(hist[i - k] < hist[i - k - 1])) return false;
    }
    return true;
  };
  const longWick = (i) => {
    const range = barsIn[i].high - barsIn[i].low;
    return range > 0 && (barsIn[i].high - Math.max(barsIn[i].open, barsIn[i].close)) / range > 0.4;
  };
  const bearEngulf = (i) => i > 0 && barsIn[i].close < barsIn[i].open && barsIn[i - 1].close > barsIn[i - 1].open
    && barsIn[i].open >= barsIn[i - 1].close && barsIn[i].close <= barsIn[i - 1].open;
  const distribution = (i) => i > 0 && barsIn[i].close < barsIn[i - 1].close && relVol[i] != null && relVol[i] > 1.2
    && sma21[i] > 0 && closes[i] / sma21[i] - 1 > 0.05;

  const ctx = [];
  for (let i = 0; i < barsIn.length; i++) {
    const belowSma8 = sma8[i] != null && closes[i] < sma8[i];
    const belowSma21 = sma21[i] != null && closes[i] < sma21[i];
    const hist3 = histFall3(i);
    const distrib = distribution(i);
    const wick = longWick(i);
    const engulf = bearEngulf(i);
    ctx.push({
      rsi14: rsi14[i], extPct: sma50[i] > 0 ? closes[i] / sma50[i] - 1 : null,
      ret10: ret10[i], ret20: ret20[i],
      aboveBb: bb.upper[i] != null && closes[i] > bb.upper[i],
      volSpike2x: relVol[i] != null && relVol[i] > 2,
      histFall3: hist3, belowSma8, belowSma21, distribution: distrib,
      longWick: wick, bearEngulf: engulf,
      weakness: hist3 || belowSma8 || belowSma21 || distrib || wick || engulf,
    });
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

function combineScore(weekly, daily, mtf) {
  return Math.round(Math.min(100, 0.5 * weekly + 0.5 * daily + mtf));
}

function classifyLevel(scores) {
  const { combined, weekly, daily, mtf } = scores;
  if (combined >= 80 && weekly >= 55 && mtf >= 15) return "EXT";
  if (combined >= 65 && mtf >= 15 && weekly >= 40 && daily >= 25) return "CONFIRMED";
  if (combined >= 55 && weekly >= 40 && daily >= 25) return "WATCH";
  return "NONE";
}

function computeForwardMetrics(idx) {
  const baseClose = bars[idx].close;
  const baseHigh = bars[idx].high;
  const metrics = {
    close: baseClose,
    labelable: idx + 40 < bars.length,
    lows: {}, returns: {}, maxDrawdowns: {}, daysToMaxDrawdown: {},
    precededDrop: {}, lowPrices: {},
  };

  for (const h of HORIZONS) {
    let minLow = Infinity;
    let minClose = baseClose;
    let minRet = 0;
    let minAt = null;
    let closeRet = null;

    for (let j = 1; j <= h && idx + j < bars.length; j++) {
      const bar = bars[idx + j];
      if (bar.low < minLow) minLow = bar.low;
      const retClose = bar.close / baseClose - 1;
      const retLow = bar.low / baseClose - 1;
      if (retClose < minClose) minClose = retClose;
      if (retLow < minRet) { minRet = retLow; minAt = j; }
    }

    if (idx + h < bars.length) {
      closeRet = bars[idx + h].close / baseClose - 1;
    }

    metrics.lows[h] = minLow === Infinity ? null : minLow;
    metrics.lowPrices[h] = metrics.lows[h];
    metrics.returns[h] = closeRet;
    metrics.maxDrawdowns[h] = minRet;
    metrics.daysToMaxDrawdown[h] = minAt;
  }

  for (const thresh of DROP_THRESHOLDS) {
    metrics.precededDrop[thresh] = false;
    for (const h of HORIZONS) {
      const dd = metrics.maxDrawdowns[h];
      if (dd != null && dd <= -thresh) {
        metrics.precededDrop[thresh] = true;
        break;
      }
    }
  }

  // local peak / timing
  let recentHigh = baseHigh;
  const lookStart = Math.max(0, idx - LOCAL_PEAK_LOOKBACK);
  for (let k = lookStart; k <= idx; k++) {
    if (bars[k].high > recentHigh) recentHigh = bars[k].high;
  }
  const dropFromPeak = recentHigh > 0 ? 1 - baseClose / recentHigh : 0;
  metrics.recentPeakHigh = recentHigh;
  metrics.dropFromRecentPeak = dropFromPeak;
  metrics.nearLocalPeak = dropFromPeak <= LOCAL_PEAK_TOLERANCE;
  metrics.tooLateAfterDrop = dropFromPeak >= LATE_DROP_THRESHOLD;

  return metrics;
}

function buildScoredDays(barsIn, dctx, wctx, dailyToCompletedWeek) {
  const days = [];
  for (let i = 0; i < barsIn.length; i++) {
    const d = dctx[i];
    const wIdx = dailyToCompletedWeek[i];
    const w = wIdx != null && wIdx >= 0 ? wctx[wIdx] : null;
    const weekly = weeklyScoreFor(w);
    const daily = dailyScoreFor(d);
    const mtf = mtfBonusFor(w, d);
    const combined = combineScore(weekly, daily, mtf);
    const level = classifyLevel({ combined, weekly, daily, mtf });

    // Pine E2 default: isQualified = level >= 1 AND weakness
    const isQualified = level !== "NONE" && d.weakness;
    const prevQualified = i > 0
      ? (classifyLevel({
          combined: days[i - 1]?.combined ?? 0,
          weekly: days[i - 1]?.weekly ?? 0,
          daily: days[i - 1]?.daily ?? 0,
          mtf: days[i - 1]?.mtf ?? 0,
        }) !== "NONE" && dctx[i - 1]?.weakness)
      : false;

    // Recompute prev qualified properly
    days.push({
      idx: i,
      date: barsIn[i].date.toISOString().slice(0, 10),
      close: barsIn[i].close,
      weekly, daily, mtf, combined, level,
      weakness: d.weakness,
      isQualified,
      warmedUp: i >= WARMUP,
    });
  }

  // Second pass for regime entry
  for (let i = 0; i < days.length; i++) {
    const prevQ = i > 0 ? days[i - 1].isQualified : false;
    days[i].isSignal = days[i].isQualified && !prevQ;
    days[i].sigWatch = days[i].isSignal && days[i].level === "WATCH";
    days[i].sigConfirmed = days[i].isSignal && days[i].level === "CONFIRMED";
    days[i].sigExt = days[i].isSignal && days[i].level === "EXT";
    days[i].dispWatch = days[i].sigWatch; // default display mode
    days[i].dispRisk = days[i].sigConfirmed;
    days[i].dispExt = days[i].sigExt;
  }

  return days;
}

function findLatest(pattern) {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const files = fs.readdirSync(DEBUG_DIR).filter((f) => pattern.test(f)).sort().reverse();
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

function parseCsv(content) {
  const lines = content.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ""; });
    rows.push(row);
  }
  return rows;
}

function loadBacktestEvents(configName = "E2_regime_entry_faiblesse") {
  const p = findLatest(/^top-risk-live-rules-backtest-events-.+\.csv$/);
  if (!p) return { path: null, events: [] };
  const rows = parseCsv(fs.readFileSync(p, "utf8")).filter((r) => r.configName === configName);
  return { path: p, events: rows };
}

function loadTvDates() {
  const p = findLatest(/^top-risk-tv-dates-TQQQ-.+\.csv$/);
  if (!p) return { path: null, dates: [] };
  const rows = parseCsv(fs.readFileSync(p, "utf8"));
  const dates = rows.map((r) => r.primaryDateFinal).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return { path: p, dates: [...new Set(dates)].sort() };
}

function overlapStats(sourceDates, targetDates, windows = [0, 3, 5]) {
  const result = {};
  for (const w of windows) {
    let matched = 0;
    const pairs = [];
    for (const s of sourceDates) {
      let best = Infinity;
      let bestT = null;
      for (const t of targetDates) {
        const d = daysBetween(s, t);
        if (d < best) { best = d; bestT = t; }
      }
      if (best <= w) {
        matched++;
        pairs.push({ source: s, target: bestT, deltaDays: best });
      }
    }
    result[w] = { matched, total: sourceDates.length, rate: sourceDates.length ? matched / sourceDates.length : 0, pairs };
  }
  return result;
}

function reverseOverlap(sourceDates, targetDates, window) {
  let matched = 0;
  const unmatched = [];
  for (const t of targetDates) {
    let best = Infinity;
    for (const s of sourceDates) {
      best = Math.min(best, daysBetween(t, s));
    }
    if (best <= window) matched++;
    else unmatched.push(t);
  }
  return { matched, total: targetDates.length, unmatched };
}

function avg(arr) {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function buildSignalAudit(day) {
  const m = computeForwardMetrics(day.idx);
  return {
    date: day.date,
    close: round2(day.close),
    level: day.level,
    weeklyScore: day.weekly,
    dailyScore: day.daily,
    mtfBonus: day.mtf,
    combinedScore: day.combined,
    weakness: day.weakness,
    ...m,
  };
}

function formatSignalRow(s) {
  const dd40 = s.maxDrawdowns?.[40];
  const ret40 = s.returns?.[40];
  return `| ${s.date} | ${s.close ?? "—"} | ${s.level} | ${s.combinedScore} | ${pct(s.maxDrawdowns?.[5])} | ${pct(s.maxDrawdowns?.[10])} | ${pct(s.maxDrawdowns?.[20])} | ${pct(dd40)} | ${pct(ret40)} | ${s.nearLocalPeak ? "oui" : "non"} | ${s.tooLateAfterDrop ? "oui" : "non"} | ${s.precededDrop?.[0.10] ? "oui" : "non"} | ${s.precededDrop?.[0.20] ? "oui" : "non"} |`;
}

function buildRecommendation(stats, yellowAudits, tvDates, e2Events) {
  const labelable = yellowAudits.filter((s) => s.labelable);
  const n = labelable.length;
  const hit10 = labelable.filter((s) => s.precededDrop?.[0.10]).length;
  const hit20 = labelable.filter((s) => s.precededDrop?.[0.20]).length;
  const falsePos = labelable.filter((s) => !s.precededDrop?.[0.05]).length;
  const nearPeak = labelable.filter((s) => s.nearLocalPeak).length;
  const tooLate = labelable.filter((s) => s.tooLateAfterDrop).length;
  const avgDd20 = avg(labelable.map((s) => s.maxDrawdowns?.[20]));
  const perYear = stats.yellowCount / stats.fullYears;

  const lines = [];
  lines.push(`Sur ${n} flèches jaunes labelables :`);
  lines.push(`- ${hit10}/${n} (${pct(hit10 / n)}) ont précédé une baisse ≥10%`);
  lines.push(`- ${hit20}/${n} (${pct(hit20 / n)}) ont précédé une baisse ≥20%`);
  lines.push(`- ${falsePos}/${n} (${pct(falsePos / n)}) n'ont pas atteint -5% (faux positifs légers)`);
  lines.push(`- ${nearPeak}/${n} (${pct(nearPeak / n)}) arrivent près d'un sommet local (≤3% du pic 20j)`);
  lines.push(`- ${tooLate}/${n} (${pct(tooLate / n)}) arrivent trop tard (déjà -5%+ du pic 20j)`);
  lines.push(`- Drawdown moyen 20j : ${pct(avgDd20)}`);
  lines.push(`- Fréquence : ~${perYear.toFixed(1)} flèches/an vs ${(e2Events.length / stats.fullYears).toFixed(1)} signaux E2/an`);

  const tvCover5 = stats.yellowToTv?.[5]?.rate ?? 0;
  const tvMiss = stats.tvToYellow?.[5]?.unmatched?.length ?? 0;

  let verdict = "garder le signal tel quel";
  let rationale = [];

  if (hit20 / n >= 0.35 && falsePos / n <= 0.45 && tvCover5 >= 0.4) {
    verdict = "garder le signal tel quel";
    rationale.push("Bon taux de capture des grosses baisses avec couverture acceptable des tops TV.");
  } else if (hit10 / n >= 0.30 && falsePos / n > 0.50) {
    verdict = "le rendre plus strict";
    rationale.push("Trop de faux positifs — exiger CONFIRMED (MTF≥15) ou mode Action cassure réduirait le bruit.");
  } else if (nearPeak / n < 0.40 || tooLate / n > 0.35) {
    verdict = "le rendre plus précoce";
    rationale.push("Beaucoup de signaux arrivent après le pic ou en retard dans la baisse.");
  } else if (hit10 / n < 0.20 && perYear > 8) {
    verdict = "le convertir en WATCH seulement (alerte légère, pas action)";
    rationale.push("Peu de corrélation avec drawdowns majeurs malgré une fréquence élevée.");
  } else if (hit20 / n < 0.15 && tvMiss > tvDates.length * 0.6) {
    verdict = "l'abandonner";
    rationale.push("Faible lift vs drawdowns et mauvaise couverture des tops majeurs manqués.");
  } else {
    verdict = "le rendre plus strict";
    rationale.push("Performance mitigée — préférer TOP RISK confirmé (orange) pour les actions.");
  }

  return { verdict, rationale, details: lines };
}

function main() {
  console.log("=== AUDIT CORRÉLATION FLÈCHES JAUNES TQQQ ===\n");

  const pineExists = fs.existsSync(PINE_PATH);
  console.log(`Pine script : ${pineExists ? "TROUVÉ" : "NON TROUVÉ"} — ${PINE_PATH}`);

  if (!loadBars(TICKER)) {
    console.error(`Cache ${cacheFile(TICKER)} introuvable.`);
    process.exit(1);
  }

  const weeks = aggregateWeekly(bars);
  const wctx = buildWeeklyContext(weeks);
  const dctx = buildDailyContext(bars);
  const weekIdxByKey = new Map(weeks.map((w, i) => [w.key, i]));
  const dailyToCompletedWeek = bars.map((b) => {
    const wi = weekIdxByKey.get(weekKey(b.date));
    return wi == null ? null : wi - 1;
  });

  const scoredDays = buildScoredDays(bars, dctx, wctx, dailyToCompletedWeek);
  const yellowArrows = scoredDays.filter((d) => d.dispWatch && d.warmedUp);
  const allE2Signals = scoredDays.filter((d) => d.isSignal && d.warmedUp);
  const confirmedSignals = allE2Signals.filter((d) => d.level === "CONFIRMED");
  const extSignals = allE2Signals.filter((d) => d.level === "EXT");

  const yellowAudits = yellowArrows.map(buildSignalAudit);
  const e2Audits = allE2Signals.map(buildSignalAudit);

  const backtest = loadBacktestEvents();
  const tv = loadTvDates();
  const mtfJson = findLatest(/^top-correlation-mtf-TQQQ-.+\.json$/);
  const weeklyJson = findLatest(/^top-correlation-weekly-TQQQ-.+\.json$/);
  const clustersJson = findLatest(/^top-risk-clusters-strict-TQQQ-.+\.json$/);

  const yellowDates = yellowArrows.map((d) => d.date);
  const e2Dates = allE2Signals.map((d) => d.date);
  const confirmedDates = confirmedSignals.map((d) => d.date);
  const extDates = extSignals.map((d) => d.date);

  const fullYears = (bars.at(-1).date - bars[WARMUP].date) / (365.25 * 86_400_000);

  const yellowToE2 = overlapStats(yellowDates, e2Dates, [0, 3, 5]);
  const yellowToConfirmed = overlapStats(yellowDates, confirmedDates, [0, 3, 5]);
  const yellowToExt = overlapStats(yellowDates, extDates, [0, 3, 5]);
  const yellowToTv = overlapStats(yellowDates, tv.dates, [0, 3, 5]);
  const e2ToTv = overlapStats(e2Dates, tv.dates, [0, 3, 5]);
  const confirmedToTv = overlapStats(confirmedDates, tv.dates, [0, 3, 5]);
  const tvToYellow = {
    3: reverseOverlap(yellowDates, tv.dates, 3),
    5: reverseOverlap(yellowDates, tv.dates, 5),
  };
  const tvToE2 = {
    5: reverseOverlap(e2Dates, tv.dates, 5),
  };

  const stats = {
    yellowCount: yellowDates.length,
    e2Count: e2Dates.length,
    confirmedCount: confirmedDates.length,
    extCount: extDates.length,
    tvCount: tv.dates.length,
    fullYears: round2(fullYears),
    yellowToE2,
    yellowToConfirmed,
    yellowToExt,
    yellowToTv,
    e2ToTv,
    confirmedToTv,
    tvToYellow,
    tvToE2,
  };

  const labelableYellow = yellowAudits.filter((s) => s.labelable);
  const bestSignals = [...labelableYellow]
    .sort((a, b) => (a.maxDrawdowns?.[40] ?? 0) - (b.maxDrawdowns?.[40] ?? 0))
    .slice(0, 15);
  const worstFalsePos = [...labelableYellow]
    .filter((s) => !s.precededDrop?.[0.05])
    .sort((a, b) => (b.maxDrawdowns?.[40] ?? 0) - (a.maxDrawdowns?.[40] ?? 0))
    .slice(0, 15);
  const missedDrawdowns = tvToE2[5].unmatched
    .map((date) => {
      const idx = bars.findIndex((b) => b.date.toISOString().slice(0, 10) === date);
      const tvRow = tv.dates.includes(date);
      let nearestYellow = null;
      let nearestDelta = Infinity;
      for (const yd of yellowDates) {
        const d = daysBetween(date, yd);
        if (d < nearestDelta) { nearestDelta = d; nearestYellow = yd; }
      }
      let drop40 = null;
      if (idx >= 0 && idx + 40 < bars.length) {
        let minRet = 0;
        for (let j = 1; j <= 40; j++) {
          const r = bars[idx + j].low / bars[idx].close - 1;
          if (r < minRet) minRet = r;
        }
        drop40 = minRet;
      }
      return { date, drop40, nearestYellow, nearestYellowDelta: nearestDelta, tvRow };
    })
    .sort((a, b) => (a.drop40 ?? 0) - (b.drop40 ?? 0))
    .slice(0, 20);

  const reco = buildRecommendation(stats, yellowAudits, tv.dates, allE2Signals);

  // Console summary
  console.log(`\nDonnées : ${bars[0].date.toISOString().slice(0, 10)} → ${bars.at(-1).date.toISOString().slice(0, 10)} (${bars.length} barres)`);
  console.log(`Période évaluée : ~${fullYears.toFixed(1)} ans (warmup ${WARMUP} barres)\n`);

  console.log("--- SOURCES ---");
  console.log(`  Pine           : ${pineExists ? "debug/TQQQ_Top_Risk_Live_Final.pine" : "(absent)"}`);
  console.log(`  OHLC cache     : debug/ohlc-cache-${TICKER}.json`);
  console.log(`  Backtest E2    : ${backtest.path ? path.basename(backtest.path) : "(absent)"} (${backtest.events.length} events CSV)`);
  console.log(`  TV tops        : ${tv.path ? path.basename(tv.path) : "(absent)"} (${tv.dates.length} dates)`);
  console.log(`  MTF audit      : ${mtfJson ? path.basename(mtfJson) : "(absent)"}`);
  console.log(`  Weekly audit   : ${weeklyJson ? path.basename(weeklyJson) : "(absent)"}`);
  console.log(`  Clusters strict: ${clustersJson ? path.basename(clustersJson) : "(absent)"}`);

  console.log("\n--- LOGIQUE FLÈCHE JAUNE (Pine) ---");
  console.log("  dispWatch = sigWatch = entrée de régime (isSignal) ET level==WATCH");
  console.log("  isQualified = combined≥55 & weekly≥40 & daily≥25 & faiblesse daily");
  console.log("  isSignal = front montant (passage hors-risque → en-risque), pas de cooldown");

  console.log("\n--- COMPTAGES ---");
  console.log(`  Flèches jaunes (WATCH)     : ${yellowDates.length}`);
  console.log(`  Signaux E2 total (W+C+EXT) : ${e2Dates.length}`);
  console.log(`  CONFIRMED (orange)         : ${confirmedDates.length}`);
  console.log(`  EXT (rouge)                : ${extDates.length}`);
  console.log(`  Tops TV référence          : ${tv.dates.length}`);

  console.log("\n--- CHEVAUCHEMENTS flèches jaunes → E2 ---");
  for (const w of [0, 3, 5]) {
    const o = yellowToE2[w];
    console.log(`  ±${w}j : ${o.matched}/${o.total} (${pct(o.rate)}) — identiques car sous-ensemble WATCH de E2`);
  }

  console.log("\n--- CHEVAUCHEMENTS flèches jaunes → tops TV ---");
  for (const w of [0, 3, 5]) {
    const o = yellowToTv[w];
    console.log(`  ±${w}j : ${o.matched}/${o.total} (${pct(o.rate)})`);
  }

  console.log("\n--- TOPS TV SANS flèche jaune (±5j) ---");
  console.log(`  ${tvToYellow[5].unmatched.length}/${tv.dates.length} tops manqués`);
  for (const m of missedDrawdowns.slice(0, 10)) {
    console.log(`  ${m.date} | drop40 ~${pct(m.drop40)} | flèche jaune la plus proche : ${m.nearestYellow ?? "—"} (${m.nearestYellowDelta?.toFixed(0) ?? "—"}j)`);
  }

  console.log("\n--- MEILLEURES FLÈCHES JAUNES (pire drop 40j) ---");
  for (const s of bestSignals.slice(0, 10)) {
    console.log(`  ${s.date} | close ${s.close} | drop40 ${pct(s.maxDrawdowns?.[40])} | nearPeak ${s.nearLocalPeak} | ≥20% ${s.precededDrop?.[0.20]}`);
  }

  console.log("\n--- RECOMMANDATION ---");
  console.log(`  → ${reco.verdict}`);
  for (const r of reco.rationale) console.log(`    ${r}`);

  // Markdown report
  const md = [];
  md.push("# Audit corrélation — flèches jaunes TQQQ Top Risk Live");
  md.push("");
  md.push(`Généré : ${new Date().toISOString()}`);
  md.push("");
  md.push("## 1. Résumé exécutif");
  md.push("");
  md.push(`- **Pine retrouvé** : ${pineExists ? "oui (`debug/TQQQ_Top_Risk_Live_Final.pine`)" : "non"}`);
  md.push(`- **Flèches jaunes reproduites** : ${yellowDates.length} signaux WATCH (entrée de régime + faiblesse daily)`);
  md.push(`- **Signaux E2 complets** : ${e2Dates.length} (WATCH ${yellowDates.length} + CONFIRMED ${confirmedDates.length} + EXT ${extDates.length})`);
  md.push(`- **Tops TradingView référence** : ${tv.dates.length} dates`);
  md.push(`- **Couverture TV par flèches jaunes (±5j)** : ${yellowToTv[5].matched}/${tv.dates.length} tops (${pct(yellowToTv[5].matched / Math.max(1, tv.dates.length))})`);
  md.push(`- **Tops TV manqués par flèches jaunes (±5j)** : ${tvToYellow[5].unmatched.length}`);
  md.push(`- **Recommandation** : **${reco.verdict}**`);
  md.push("");

  md.push("## 2. Sources utilisées");
  md.push("");
  md.push("| Source | Fichier | Usage |");
  md.push("|--------|---------|-------|");
  md.push(`| Pine Script | ${pineExists ? "`debug/TQQQ_Top_Risk_Live_Final.pine`" : "—"} | Conditions flèche jaune (dispWatch) |`);
  md.push(`| OHLC TQQQ | \`debug/ohlc-cache-${TICKER}.json\` | Prix, drawdowns, reproduction Node |`);
  md.push(`| Backtest live rules | \`${backtest.path ? path.basename(backtest.path) : "—"}\` | Validation E2_regime_entry_faiblesse |`);
  md.push(`| Tops TV | \`${tv.path ? path.basename(tv.path) : "—"}\` | ${tv.dates.length} dates tops réels (clusters stricts) |`);
  md.push(`| Audit MTF | \`${mtfJson ? path.basename(mtfJson) : "—"}\` | Signaux multi-timeframe audités |`);
  md.push(`| Audit weekly | \`${weeklyJson ? path.basename(weeklyJson) : "—"}\` | Signaux weekly audités |`);
  md.push(`| Clusters strict | \`${clustersJson ? path.basename(clustersJson) : "—"}\` | Base des dates TV |`);
  md.push("");

  md.push("## 3. Logique flèche jaune (Pine)");
  md.push("");
  md.push("D'après le Pine final (config E2, mode « Zone de risque ») :");
  md.push("");
  md.push("```");
  md.push("cWatch = color.yellow");
  md.push("dispWatch = sigWatch  (mode Zone de risque)");
  md.push("sigWatch = isSignal AND level == 1 (WATCH)");
  md.push("isSignal = isQualified AND NOT isQualified[1]  // entrée de régime");
  md.push("isQualified = level >= 1 AND weakness  // faiblesse daily obligatoire");
  md.push("level WATCH = combined≥55 & weekly≥40 & daily≥25");
  md.push("weakness = MACD hist -3j OR close<SMA8 OR close<SMA21 OR distrib OR mèche OR engulf");
  md.push("```");
  md.push("");
  md.push(`Période : ${bars[WARMUP].date.toISOString().slice(0, 10)} → ${bars.at(-1).date.toISOString().slice(0, 10)} (~${fullYears.toFixed(1)} ans)`);
  md.push("");

  md.push("## 4. Dates des flèches jaunes");
  md.push("");
  md.push(`Total : **${yellowDates.length}** dates`);
  md.push("");
  md.push("<details><summary>Liste complète</summary>");
  md.push("");
  md.push(yellowDates.join(", "));
  md.push("");
  md.push("</details>");
  md.push("");

  md.push("### Principales flèches (meilleur drop 40j)");
  md.push("");
  md.push("| Date | Close | Niveau | Combined | Drop 5j | Drop 10j | Drop 20j | Drop 40j | Ret 40j | Près sommet | Trop tard | ≥10% | ≥20% |");
  md.push("|------|-------|----------|---------|----------|----------|----------|---------|-------------|-----------|------|------|");
  for (const s of bestSignals) md.push(formatSignalRow(s));
  md.push("");

  md.push("## 5. Performance après signal");
  md.push("");
  const lb = labelableYellow;
  md.push("| Horizon | Drawdown moyen | Retour close moyen | Délai moy. au pire DD |");
  md.push("|---------|----------------|--------------------|-----------------------|");
  for (const h of HORIZONS) {
    md.push(`| ${h}j | ${pct(avg(lb.map((s) => s.maxDrawdowns?.[h])))} | ${pct(avg(lb.map((s) => s.returns?.[h])))} | ${avg(lb.map((s) => s.daysToMaxDrawdown?.[h]))?.toFixed(1) ?? "—"} j |`);
  }
  md.push("");
  md.push("### Taux de prédiction de baisse");
  md.push("");
  md.push("| Seuil | Flèches touchées | Taux |");
  md.push("|-------|------------------|------|");
  for (const t of DROP_THRESHOLDS) {
    const c = lb.filter((s) => s.precededDrop?.[t]).length;
    md.push(`| -${t * 100}% | ${c}/${lb.length} | ${pct(c / lb.length)} |`);
  }
  md.push("");
  md.push(`- Près d'un sommet local (≤3% du high 20j) : **${lb.filter((s) => s.nearLocalPeak).length}/${lb.length}** (${pct(lb.filter((s) => s.nearLocalPeak).length / lb.length)})`);
  md.push(`- Trop tard (déjà -5%+ du high 20j) : **${lb.filter((s) => s.tooLateAfterDrop).length}/${lb.length}** (${pct(lb.filter((s) => s.tooLateAfterDrop).length / lb.length)})`);
  md.push("");

  md.push("## 6. Corrélation avec drawdowns");
  md.push("");
  md.push("Comparaison avec les **tops TradingView** (dates `primaryDateFinal` des clusters stricts — pire drop futur) :");
  md.push("");
  md.push("| Fenêtre | Flèches jaunes → TV | E2 total → TV | CONFIRMED → TV |");
  md.push("|---------|---------------------|---------------|-----------------|");
  for (const w of [0, 3, 5]) {
    md.push(`| ±${w}j | ${yellowToTv[w].matched}/${yellowDates.length} (${pct(yellowToTv[w].rate)}) | ${e2ToTv[w].matched}/${e2Dates.length} (${pct(e2ToTv[w].rate)}) | ${confirmedToTv[w].matched}/${confirmedDates.length} (${pct(confirmedToTv[w].rate)}) |`);
  }
  md.push("");
  md.push(`- Tops TV sans flèche jaune (±5j) : **${tvToYellow[5].unmatched.length}** / ${tv.dates.length}`);
  md.push(`- Tops TV sans aucun signal E2 (±5j) : **${tvToE2[5].unmatched.length}** / ${tv.dates.length}`);
  md.push("");

  md.push("## 7. Comparaison avec Top Risk");
  md.push("");
  md.push("| Niveau | Signaux | Description |");
  md.push("|--------|---------|-------------|");
  md.push(`| WATCH (jaune) | ${yellowDates.length} | combined≥55, weekly≥40, daily≥25, faiblesse daily, entrée régime |`);
  md.push(`| CONFIRMED (orange) | ${confirmedDates.length} | + combined≥65, mtfBonus≥15 |`);
  md.push(`| EXT (rouge) | ${extDates.length} | + combined≥80, weekly≥55 |`);
  md.push(`| E2 total | ${e2Dates.length} | Tous niveaux à l'entrée de régime |`);
  md.push("");
  md.push("Les flèches jaunes sont un **sous-ensemble strict** des signaux E2 (seulement level=WATCH à l'entrée).");
  md.push("Les signaux CONFIRMED/EXT à l'entrée de régime n'affichent pas de flèche jaune — ils affichent orange/rouge.");
  md.push("");
  md.push("| Comparaison | Exact | ±3j | ±5j |");
  md.push("|-------------|-------|-----|-----|");
  md.push(`| Jaune → CONFIRMED | ${yellowToConfirmed[0].matched}/${yellowDates.length} | ${yellowToConfirmed[3].matched}/${yellowDates.length} | ${yellowToConfirmed[5].matched}/${yellowDates.length} |`);
  md.push(`| Jaune → EXT | ${yellowToExt[0].matched}/${yellowDates.length} | ${yellowToExt[3].matched}/${yellowDates.length} | ${yellowToExt[5].matched}/${yellowDates.length} |`);
  md.push("");

  md.push("## 8. Faux positifs");
  md.push("");
  md.push(`Flèches jaunes sans baisse ≥5% dans les 40j suivants : **${worstFalsePos.length}** cas (sur ${lb.length} labelables)`);
  md.push("");
  if (worstFalsePos.length) {
    md.push("| Date | Close | Drop 40j max | Combined | Weekly | Daily | MTF |");
    md.push("|------|-------|--------------|----------|--------|-------|-----|");
    for (const s of worstFalsePos.slice(0, 12)) {
      md.push(`| ${s.date} | ${s.close} | ${pct(s.maxDrawdowns?.[40])} | ${s.combinedScore} | ${s.weeklyScore} | ${s.dailyScore} | ${s.mtfBonus} |`);
    }
  }
  md.push("");

  md.push("## 9. Signaux manqués");
  md.push("");
  md.push("Gros drawdowns (tops TV) sans flèche jaune proche (±5j) :");
  md.push("");
  md.push("| Date TV | Drop ~40j | Flèche jaune la plus proche | Écart (j) | Signal E2 ±5j ? |");
  md.push("|---------|-----------|----------------------------|-----------|-----------------|");
  for (const m of missedDrawdowns) {
    const e2Near = e2Dates.some((d) => daysBetween(m.date, d) <= 5) ? "oui" : "non";
    md.push(`| ${m.date} | ${pct(m.drop40)} | ${m.nearestYellow ?? "—"} | ${m.nearestYellowDelta?.toFixed(0) ?? "—"} | ${e2Near} |`);
  }
  md.push("");

  md.push("## 10. Recommandation");
  md.push("");
  md.push(`### Verdict : **${reco.verdict}**`);
  md.push("");
  for (const r of reco.rationale) md.push(`- ${r}`);
  md.push("");
  for (const d of reco.details) md.push(`- ${d}`);
  md.push("");
  md.push("### Notes pratiques");
  md.push("");
  md.push("- La flèche **jaune** est un **WATCH** : alerte précoce avec faiblesse daily, pas une confirmation MTF.");
  md.push("- Pour les grosses corrections, les signaux **CONFIRMED** (orange, MTF≥15) et **EXT** (rouge) capturent mieux les tops TV.");
  md.push("- Le mode « Action cassure » du Pine masque les WATCH sans cassure daily — réduirait le nombre de flèches jaunes.");
  md.push("- Config E2 validée par backtest (`lift majeur 2.36x`) — la flèche jaune seule est plus bruyante que l'ensemble E2.");
  md.push("");

  const mdPath = path.join(DEBUG_DIR, "tqqq-yellow-arrow-correlation-audit.md");
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(DEBUG_DIR, `tqqq-yellow-arrow-correlation-audit-${ts}.json`);
  const jsonPayload = {
    generatedAt: new Date().toISOString(),
    pineFound: pineExists,
    pinePath: pineExists ? "debug/TQQQ_Top_Risk_Live_Final.pine" : null,
    sources: {
      ohlc: cacheFile(TICKER),
      backtestEvents: backtest.path,
      tvDates: tv.path,
      mtfAudit: mtfJson,
      weeklyAudit: weeklyJson,
      clustersStrict: clustersJson,
    },
    counts: stats,
    yellowDates,
    e2Dates,
    confirmedDates,
    extDates,
    tvDates: tv.dates,
    yellowAudits,
    e2Audits,
    bestSignals,
    worstFalsePos,
    missedDrawdowns,
    recommendation: reco,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf8");

  console.log(`\n${"=".repeat(72)}`);
  console.log("FICHIERS GÉNÉRÉS");
  console.log(`  Rapport MD  : ${mdPath}`);
  console.log(`  JSON détail : ${jsonPath}`);
  console.log("\n(Audit seulement — aucun commit.)");
}

main();
