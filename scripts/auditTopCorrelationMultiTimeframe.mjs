/**
 * Audit top TQQQ multi-timeframe — DAILY + WEEKLY + MTF combiné.
 * Usage: node scripts/auditTopCorrelationMultiTimeframe.mjs [TQQQ|QQQ] [--from-cache]
 *
 * Série principale : TQQQ réel (première date dispo → aujourd'hui).
 * Validation : QQQ, ^NDX, TQQQ synthétique (secondaire).
 * AUDIT_INSECURE_TLS=1 si erreur certificat Yahoo (Windows).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YahooFinance from "yahoo-finance2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEBUG_DIR = path.join(ROOT, "debug");
const START_DATE = new Date("2008-01-02T00:00:00Z");
const EXPENSE_DRAG_ANNUAL = 0.0095;
const MIN_DAILY = 200;
const MIN_WEEKLY = 60;

const CLI_ARGS = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const PRIMARY_TICKER = (CLI_ARGS[0] ?? "TQQQ").trim().toUpperCase();
const USE_DISK_CACHE = process.argv.includes("--cache") || process.argv.includes("--from-cache");
const SAVE_DISK_CACHE = !process.argv.includes("--no-save-cache");

if (process.env.AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("⚠ AUDIT_INSECURE_TLS=1 — vérification TLS désactivée (audit seulement).");
}

const DAILY_PROFILES = {
  leveraged: {
    id: "leveraged_daily",
    horizons: { veryShort: 5, swing: 10, medium: 20, major: 40 },
    thresholds: { veryShort: -0.06, swing: -0.1, medium: -0.15, major: -0.25 },
    labelKeys: ["isTopVeryShort", "isTopSwing", "isTopMedium", "isTopMajor"],
    maxForward: 40,
    warmup: 252,
  },
  index: {
    id: "index_daily",
    horizons: { veryShort: 5, swing: 10, medium: 20, major: 40 },
    thresholds: { veryShort: -0.03, swing: -0.05, medium: -0.08, major: -0.12 },
    labelKeys: ["isTopVeryShort", "isTopSwing", "isTopMedium", "isTopMajor"],
    maxForward: 40,
    warmup: 252,
  },
};

const WEEKLY_PROFILES = {
  leveraged: {
    id: "leveraged_weekly",
    horizons: { short: 4, medium: 8, major: 12, extreme: 16 },
    thresholds: { short: -0.12, medium: -0.2, major: -0.3, extreme: -0.4 },
    labelKeys: ["isTopShort", "isTopMedium", "isTopMajor", "isTopExtreme"],
    maxForward: 16,
    warmup: 52,
  },
  index: {
    id: "index_weekly",
    horizons: { short: 4, medium: 8, major: 12, extreme: 16 },
    thresholds: { short: -0.05, medium: -0.08, major: -0.12, extreme: -0.18 },
    labelKeys: ["isTopShort", "isTopMedium", "isTopMajor", "isTopExtreme"],
    maxForward: 16,
    warmup: 52,
  },
};

const COOLDOWN_VARIANTS = {
  daily: [
    { id: "none", label: "sans cooldown", days: 0 },
    { id: "cd10d", label: "cooldown 10 jours", days: 10 },
    { id: "cd20d", label: "cooldown 20 jours", days: 20 },
  ],
  weekly: [
    { id: "none", label: "sans cooldown", weeks: 0 },
    { id: "cd4w", label: "cooldown 4 semaines", weeks: 4 },
    { id: "cd8w", label: "cooldown 8 semaines", weeks: 8 },
  ],
};

const MISSING_BREADTH = [
  "S5TH", "S5FI", "S5OH", "% S&P > MA50/200", "advance/decline",
  "put/call fiable", "AAII", "NAAIM", "Fear & Greed CNN",
];

let yahooClient = null;
function getYahoo() {
  if (!yahooClient) yahooClient = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
  return yahooClient;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pctFmt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
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

function normalizeDailyQuote(q) {
  if (!q) return null;
  const close = toNum(q.close ?? q.adjclose ?? q.adjClose);
  if (close == null || close <= 0) return null;
  const date = q.date instanceof Date ? q.date : new Date(q.date);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date,
    open: toNum(q.open) ?? close,
    high: toNum(q.high) ?? close,
    low: toNum(q.low) ?? close,
    close,
    volume: toNum(q.volume) != null && toNum(q.volume) >= 0 ? toNum(q.volume) : null,
  };
}

function cachePathForSymbol(symbol) {
  return path.join(DEBUG_DIR, `ohlc-cache-${String(symbol).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function loadDiskCache(symbol) {
  const p = cachePathForSymbol(symbol);
  if (!fs.existsSync(p)) return null;
  try {
    const rows = (JSON.parse(fs.readFileSync(p, "utf8")).rows ?? [])
      .map((r) => ({ ...r, date: new Date(r.date) }))
      .filter((r) => r.close > 0);
    if (rows.length < 50) return null;
    return { symbol, rows, firstDate: rows[0].date.toISOString().slice(0, 10), lastDate: rows.at(-1).date.toISOString().slice(0, 10), rowCount: rows.length, source: "disk-cache" };
  } catch { return null; }
}

function saveDiskCache(symbol, rows) {
  if (!SAVE_DISK_CACHE || !rows?.length) return;
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(cachePathForSymbol(symbol), JSON.stringify({
    symbol, savedAt: new Date().toISOString(),
    rows: rows.map((r) => ({ date: r.date.toISOString(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })),
  }), "utf8");
}

async function fetchExtendedHistory(symbol) {
  const sym = String(symbol ?? "").trim();
  if (!sym) return { rows: null, error: "symbole vide" };
  if (USE_DISK_CACHE) { const c = loadDiskCache(sym); if (c) return c; }
  try {
    const chartResult = await getYahoo().chart(sym, { period1: START_DATE, period2: new Date(), interval: "1d" });
    const rows = (chartResult?.quotes ?? []).map(normalizeDailyQuote).filter(Boolean).sort((a, b) => a.date - b.date);
    if (rows.length < 50) return { symbol: sym, rows: null, error: "insuffisant" };
    const result = { symbol: sym, rows, firstDate: rows[0].date.toISOString().slice(0, 10), lastDate: rows.at(-1).date.toISOString().slice(0, 10), rowCount: rows.length, source: "yahoo-chart" };
    saveDiskCache(sym, rows);
    return result;
  } catch (err) {
    const c = loadDiskCache(sym);
    if (c) return c;
    return { symbol: sym, rows: null, error: err?.message ?? String(err) };
  }
}

function aggregateDailyToWeekly(dailyRows) {
  const buckets = new Map();
  for (const r of dailyRows) {
    const k = weekKey(r.date);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const weeks = [];
  for (const [key, sorted0] of buckets) {
    const sorted = sorted0.sort((a, b) => a.date - b.date);
    const first = sorted[0];
    const last = sorted.at(-1);
    const vols = sorted.map((x) => x.volume).filter((v) => v != null);
    const { week, year } = isoWeek(last.date);
    weeks.push({
      key, week, year, month: last.date.getUTCMonth() + 1, date: last.date,
      open: first.open, high: Math.max(...sorted.map((x) => x.high)),
      low: Math.min(...sorted.map((x) => x.low)), close: last.close,
      volume: vols.length ? vols.reduce((s, v) => s + v, 0) : null,
    });
  }
  return weeks.sort((a, b) => a.date - b.date);
}

function buildSyntheticTqqqDaily(qqqDaily, startPrice = 40) {
  const drag = EXPENSE_DRAG_ANNUAL / 252;
  let price = startPrice;
  const out = [];
  for (let i = 0; i < qqqDaily.length; i++) {
    const row = qqqDaily[i];
    if (i === 0) {
      out.push({ ...row, open: price, high: price, low: price, close: price });
      continue;
    }
    const ret = row.close / qqqDaily[i - 1].close - 1;
    price = Math.max(0.01, price * (1 + ret * 3 - drag));
    const range = (row.high - row.low) / row.close || 0.02;
    out.push({ date: row.date, open: price, high: price * (1 + range * 0.5), low: price * (1 - range * 0.5), close: price, volume: row.volume });
  }
  return out;
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = toNum(values[j]);
      if (v == null) { sum = null; break; }
      sum += v;
    }
    if (sum != null) out[i] = sum / period;
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

function stochRsiSeries(closes) {
  const rsi = rsiSeries(closes, 14);
  const out = new Array(closes.length).fill(null);
  for (let i = 28; i < closes.length; i++) {
    const window = rsi.slice(i - 13, i + 1).filter((v) => v != null);
    if (window.length < 14 || rsi[i] == null) continue;
    const lo = Math.min(...window), hi = Math.max(...window);
    out[i] = hi === lo ? 50 : ((rsi[i] - lo) / (hi - lo)) * 100;
  }
  return out;
}

function cciSeries(bars, period = 20) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const out = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    const slice = tp.slice(i - period + 1, i + 1);
    const sma = slice.reduce((s, v) => s + v, 0) / period;
    const md = slice.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    out[i] = md === 0 ? 0 : (tp[i] - sma) / (0.015 * md);
  }
  return out;
}

function macdSeries(closes) {
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const macd = [], signal = [], hist = [];
  for (let i = 0; i < closes.length; i++) {
    macd[i] = ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null;
  }
  const sigEma = emaSeries(macd.map((v) => v ?? 0), 9);
  for (let i = 0; i < closes.length; i++) {
    signal[i] = sigEma[i];
    hist[i] = macd[i] != null && sigEma[i] != null ? macd[i] - sigEma[i] : null;
  }
  return { macd, signal, hist };
}

function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const tr = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }
  for (let i = period; i < bars.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += tr[j];
    out[i] = s / period;
  }
  return out;
}

function bollingerSeries(closes, period = 20) {
  const mid = smaSeries(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i];
    if (m == null) continue;
    const slice = closes.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(slice.reduce((s, v) => s + (v - m) ** 2, 0) / period);
    upper[i] = m + 2 * sd;
    lower[i] = m - 2 * sd;
  }
  return { mid, upper, lower };
}

function returnBarsSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    if (closes[i - n] > 0) out[i] = closes[i] / closes[i - n] - 1;
  }
  return out;
}

function obvSeries(bars) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const v = bars[i].volume ?? 0;
    out[i] = out[i - 1] + (bars[i].close > bars[i - 1].close ? v : bars[i].close < bars[i - 1].close ? -v : 0);
  }
  return out;
}

function alignByDate(primaryBars, auxRows, fn = (r) => r.close) {
  const map = new Map(auxRows.map((r) => [r.date.toISOString().slice(0, 10), fn(r)]));
  return primaryBars.map((b) => map.get(b.date.toISOString().slice(0, 10)) ?? null);
}

function attachFutureLabelsBars(bars, profile, isWeekly = false) {
  const h = profile.horizons;
  const keys = Object.keys(h);
  const maxF = profile.maxForward;
  for (let i = 0; i < bars.length; i++) {
    const base = bars[i].close;
    const future = { maxDrop: {} };
    for (const key of keys) {
      const horizon = h[key];
      let minRet = 0;
      for (let j = 1; j <= horizon && i + j < bars.length; j++) {
        const r = bars[i + j].close / base - 1;
        if (r < minRet) minRet = r;
      }
      future.maxDrop[horizon] = minRet;
    }
    bars[i].future = future;
    bars[i].isTopVeryShort = (future.maxDrop[h.veryShort] ?? 0) <= profile.thresholds.veryShort;
    bars[i].isTopSwing = (future.maxDrop[h.swing] ?? 0) <= profile.thresholds.swing;
    bars[i].isTopMedium = (future.maxDrop[h.medium] ?? 0) <= profile.thresholds.medium;
    bars[i].isTopMajor = (future.maxDrop[h.major] ?? 0) <= profile.thresholds.major;
    if (isWeekly) {
      bars[i].isTopShort = (future.maxDrop[h.short] ?? 0) <= profile.thresholds.short;
      bars[i].isTopExtreme = (future.maxDrop[h.extreme] ?? 0) <= profile.thresholds.extreme;
      delete bars[i].isTopVeryShort;
      delete bars[i].isTopSwing;
    }
  }
}

function attachFutureLabelsWeekly(weeks, profile) {
  const h = profile.horizons;
  for (let i = 0; i < weeks.length; i++) {
    const base = weeks[i].close;
    const future = { maxDrop: {} };
    for (const k of ["short", "medium", "major", "extreme"]) {
      const horizon = h[k];
      let minRet = 0;
      for (let j = 1; j <= horizon && i + j < weeks.length; j++) {
        const r = weeks[i + j].close / base - 1;
        if (r < minRet) minRet = r;
      }
      future.maxDrop[horizon] = minRet;
    }
    weeks[i].future = future;
    weeks[i].isTopShort = (future.maxDrop[h.short] ?? 0) <= profile.thresholds.short;
    weeks[i].isTopMedium = (future.maxDrop[h.medium] ?? 0) <= profile.thresholds.medium;
    weeks[i].isTopMajor = (future.maxDrop[h.major] ?? 0) <= profile.thresholds.major;
    weeks[i].isTopExtreme = (future.maxDrop[h.extreme] ?? 0) <= profile.thresholds.extreme;
  }
}

function buildDailyCtx(bars, aux = {}) {
  const closes = bars.map((b) => b.close);
  const n = bars.length;
  const sma = { 8: smaSeries(closes, 8), 21: smaSeries(closes, 21), 34: smaSeries(closes, 34), 50: smaSeries(closes, 50), 100: smaSeries(closes, 100), 200: smaSeries(closes, 200) };
  const ema = { 8: emaSeries(closes, 8), 21: emaSeries(closes, 21), 34: emaSeries(closes, 34), 50: emaSeries(closes, 50), 200: emaSeries(closes, 200) };
  const rsi = { 7: rsiSeries(closes, 7), 14: rsiSeries(closes, 14), 21: rsiSeries(closes, 21) };
  const stochRsi = stochRsiSeries(closes);
  const cci = cciSeries(bars, 20);
  const { macd, signal, hist } = macdSeries(closes);
  const bb = bollingerSeries(closes, 20);
  const atr = atrSeries(bars, 14);
  const ret = { 5: returnBarsSeries(closes, 5), 10: returnBarsSeries(closes, 10), 20: returnBarsSeries(closes, 20), 40: returnBarsSeries(closes, 40) };
  const volMa20 = smaSeries(bars.map((b) => b.volume ?? 0), 20);
  const relVol20 = bars.map((b, i) => (volMa20[i] > 0 && b.volume != null ? b.volume / volMa20[i] : null));
  const volMa50 = smaSeries(bars.map((b) => b.volume ?? 0), 50);
  const relVol50 = bars.map((b, i) => (volMa50[i] > 0 && b.volume != null ? b.volume / volMa50[i] : null));
  const obv = obvSeries(bars);
  const nh = { 20: new Array(n).fill(false), 50: new Array(n).fill(false), 100: new Array(n).fill(false), 252: new Array(n).fill(false) };
  for (let i = 0; i < n; i++) {
    for (const [lb, arr] of [[20, nh[20]], [50, nh[50]], [100, nh[100]], [252, nh[252]]]) {
      const prior = closes.slice(Math.max(0, i - lb), i);
      arr[i] = prior.length >= Math.min(lb, 10) && closes[i] > Math.max(...prior);
    }
  }
  const consecPos = new Array(n).fill(0);
  for (let i = 1; i < n; i++) consecPos[i] = closes[i] > closes[i - 1] ? consecPos[i - 1] + 1 : 0;
  const daysSinceTouch = { s8: new Array(n).fill(0), s21: new Array(n).fill(0) };
  for (let i = 1; i < n; i++) {
    daysSinceTouch.s8[i] = bars[i].low <= sma[8][i] ? 0 : daysSinceTouch.s8[i - 1] + 1;
    daysSinceTouch.s21[i] = bars[i].low <= sma[21][i] ? 0 : daysSinceTouch.s21[i - 1] + 1;
  }
  const vix = aux.vix ?? new Array(n).fill(null);
  const qqqSma21 = aux.qqqSma21 ?? new Array(n).fill(null);
  const ndxSma21 = aux.ndxSma21 ?? new Array(n).fill(null);
  const spyRet20 = aux.spyRet20 ?? new Array(n).fill(null);
  const iwmRet20 = aux.iwmRet20 ?? new Array(n).fill(null);

  const ctx = {
    bars, closes, n, sma, ema, rsi, stochRsi, cci, macd, signal, hist, bb, atr, ret, relVol20, relVol50, obv, nh, consecPos, daysSinceTouch, vix, qqqSma21, ndxSma21, spyRet20, iwmRet20,
  };
  ctx.pctAbove = (p, i) => { const m = sma[p][i]; return m > 0 ? closes[i] / m - 1 : null; };
  ctx.histFall = (i, d) => {
    if (i < d || hist[i] == null) return false;
    for (let k = 0; k < d; k++) {
      if (hist[i - k] == null || hist[i - k - 1] == null || !(hist[i - k] < hist[i - k - 1])) return false;
    }
    return true;
  };
  ctx.rsiBearDiv = (i, lb = 50) => {
    if (i < lb) return false;
    const pWin = closes.slice(i - lb, i + 1);
    const rWin = rsi[14].slice(i - lb, i + 1);
    const pMax = Math.max(...pWin);
    const idx = pWin.indexOf(pMax);
    return closes[i] >= pMax * 0.998 && rsi[14][i] != null && rWin[idx] != null && rsi[14][i] < rWin[idx] - 2;
  };
  ctx.macdBearDiv = (i, lb = 50) => {
    if (i < lb) return false;
    const pWin = closes.slice(i - lb, i + 1);
    const hWin = hist.slice(i - lb, i + 1);
    const pMax = Math.max(...pWin);
    const idx = pWin.indexOf(pMax);
    return closes[i] >= pMax * 0.998 && hist[i] != null && hWin[idx] != null && hist[i] < hWin[idx];
  };
  ctx.stochCrossDown = (i) => stochRsi[i] != null && stochRsi[i - 1] != null && stochRsi[i] < stochRsi[i - 1] && stochRsi[i - 1] > 80;
  ctx.longUpperWick = (i) => {
    const range = bars[i].high - bars[i].low;
    const upper = bars[i].high - Math.max(bars[i].open, bars[i].close);
    return range > 0 && upper / range > 0.4;
  };
  ctx.shootingStar = (i) => {
    const body = Math.abs(bars[i].close - bars[i].open);
    const range = bars[i].high - bars[i].low;
    const upper = bars[i].high - Math.max(bars[i].open, bars[i].close);
    return range > 0 && upper / range > 0.5 && body / range < 0.35;
  };
  ctx.bearEngulf = (i) => i > 0 && bars[i].close < bars[i].open && bars[i - 1].close > bars[i - 1].open && bars[i].open >= bars[i - 1].close && bars[i].close <= bars[i - 1].open;
  ctx.closeBelow = (p, i) => sma[p][i] != null && closes[i] < sma[p][i];
  ctx.closeFarFromHigh = (i) => {
    const range = bars[i].high - bars[i].low;
    return range > 0 && (bars[i].high - bars[i].close) / range > 0.35;
  };
  ctx.gapUpWeak = (i) => i > 0 && bars[i].open > bars[i - 1].high * 1.005 && ctx.closeFarFromHigh(i);
  ctx.distributionDay = (i) => i > 0 && bars[i].close < bars[i - 1].close && relVol20[i] > 1.2 && ctx.pctAbove(21, i) > 0.05;
  ctx.vixRise5 = (i) => i >= 5 && vix[i] != null && vix[i - 5] != null && vix[i] > vix[i - 5] * 1.08;
  ctx.vixLowRise = (i) => {
    if (vix[i] == null || i < 10) return false;
    const recent = vix.slice(i - 10, i + 1).filter((v) => v != null);
    const minV = Math.min(...recent);
    return minV < 16 && vix[i] > minV * 1.1;
  };
  ctx.qqqBreakSma21 = (i) => qqqSma21[i] != null && closes[i] > sma[21][i] * 1.05 && qqqSma21[i] != null && i > 0 && qqqSma21[i] < qqqSma21[i - 1];
  ctx.ndxNoConfirm = (i) => nh[252][i] && ndxSma21[i] != null && i > 0 && ndxSma21[i] < ndxSma21[Math.max(0, i - 5)];
  ctx.spyNoConfirm = (i) => nh[50][i] && ret[20][i] > 0.2 && spyRet20[i] != null && spyRet20[i] < 0.05;
  return ctx;
}

function buildWeeklyCtx(weeks, aux = {}) {
  const closes = weeks.map((w) => w.close);
  const n = weeks.length;
  const ma = { 8: smaSeries(closes, 8), 21: smaSeries(closes, 21), 50: smaSeries(closes, 50), 200: smaSeries(closes, 200) };
  const rsi = { 14: rsiSeries(closes, 14) };
  const stochRsi = stochRsiSeries(closes);
  const { hist } = macdSeries(closes);
  const bb = bollingerSeries(closes, 20);
  const ret = { 4: returnBarsSeries(closes, 4), 8: returnBarsSeries(closes, 8), 12: returnBarsSeries(closes, 12) };
  const volMa20 = smaSeries(weeks.map((w) => w.volume ?? 0), 20);
  const relVol20 = weeks.map((w, i) => (volMa20[i] > 0 && w.volume ? w.volume / volMa20[i] : null));
  const newHigh52 = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const w52 = closes.slice(Math.max(0, i - 51), i);
    newHigh52[i] = w52.length >= 26 && closes[i] >= Math.max(...w52);
  }
  const ctx = { weeks, closes, n, ma, rsi, stochRsi, hist, bb, ret, relVol20, newHigh52 };
  ctx.pctAbove = (p, i) => { const m = ma[p][i]; return m > 0 ? closes[i] / m - 1 : null; };
  ctx.histFallWeeks = (i, w) => {
    if (i < w) return false;
    for (let k = 0; k < w; k++) {
      if (hist[i - k] == null || hist[i - k - 1] == null || !(hist[i - k] < hist[i - k - 1])) return false;
    }
    return true;
  };
  ctx.rsiBearDiv = (i) => {
    if (i < 26) return false;
    const pWin = closes.slice(i - 26, i + 1);
    const rWin = rsi[14].slice(i - 26, i + 1);
    const pMax = Math.max(...pWin);
    return closes[i] >= pMax * 0.998 && rsi[14][i] < rWin[pWin.indexOf(pMax)] - 2;
  };
  ctx.stochCrossDown = (i) => stochRsi[i] != null && stochRsi[i - 1] != null && stochRsi[i] < stochRsi[i - 1] && stochRsi[i - 1] > 80;
  ctx.longUpperWick = (i) => {
    const range = weeks[i].high - weeks[i].low;
    return range > 0 && (weeks[i].high - Math.max(weeks[i].open, weeks[i].close)) / range > 0.4;
  };
  ctx.closeFarFromHigh = (i) => {
    const range = weeks[i].high - weeks[i].low;
    return range > 0 && (weeks[i].high - weeks[i].close) / range > 0.35;
  };
  ctx.volSpike = (i, m) => relVol20[i] > m;
  return ctx;
}

function defineDailySignals(ctx) {
  const { rsi, stochRsi, hist, bb, ret, relVol20, nh } = ctx;
  const add = (id, name, desc, fn) => ({ id, name, description: desc, timeframe: "daily", eval: fn });
  return [
    add("d_rsi70", "RSI14 > 70", "RSI daily > 70", (i) => rsi[14][i] > 70),
    add("d_rsi75", "RSI14 > 75", "RSI daily > 75", (i) => rsi[14][i] > 75),
    add("d_rsi70_hist3", "RSI>70 + MACD hist -3j", "RSI>70 et histogramme baisse 3 jours", (i) => rsi[14][i] > 70 && ctx.histFall(i, 3)),
    add("d_rsi70_below_sma8", "RSI>70 + sous SMA8", "RSI>70 et clôture sous SMA8", (i) => rsi[14][i] > 70 && ctx.closeBelow(8, i)),
    add("d_rsi70_below_sma21", "RSI>70 + sous SMA21", "RSI>70 et clôture sous SMA21", (i) => rsi[14][i] > 70 && ctx.closeBelow(21, i)),
    add("d_stoch80_cross", "StochRSI>80 cross down", "StochRSI>80 puis croisement baissier", (i) => stochRsi[i - 1] > 80 && ctx.stochCrossDown(i)),
    add("d_stoch90_cross", "StochRSI>90 cross down", "StochRSI>90 puis croisement baissier", (i) => stochRsi[i - 1] > 90 && ctx.stochCrossDown(i)),
    add("d_ext_sma21_hist", ">SMA21 10% + hist baisse", "Extension SMA21 + MACD hist baisse", (i) => ctx.pctAbove(21, i) > 0.1 && ctx.histFall(i, 2)),
    add("d_ext_sma50_s8", ">SMA50 15% + sous SMA8", "Extension SMA50 + sous SMA8", (i) => ctx.pctAbove(50, i) > 0.15 && ctx.closeBelow(8, i)),
    add("d_ext_sma50_s21", ">SMA50 20% + sous SMA21", "Extension SMA50 + sous SMA21", (i) => ctx.pctAbove(50, i) > 0.2 && ctx.closeBelow(21, i)),
    add("d_ret10_rsi70", "Ret10>15% + RSI>70", "Rendement 10j > 15% + RSI>70", (i) => ret[10][i] > 0.15 && rsi[14][i] > 70),
    add("d_ret20_rsi70", "Ret20>25% + RSI>70", "Rendement 20j > 25% + RSI>70", (i) => ret[20][i] > 0.25 && rsi[14][i] > 70),
    add("d_bb_rsi70", "BB sup + RSI>70", "Bollinger sup + RSI>70", (i) => bb.upper[i] != null && ctx.closes[i] > bb.upper[i] && rsi[14][i] > 70),
    add("d_vol2x", "Volume > 2x moy 20j", "Volume relatif > 2x", (i) => relVol20[i] > 2),
    add("d_vol2x_wick", "Vol>2x + mèche haute", "Volume spike + longue mèche", (i) => relVol20[i] > 2 && ctx.longUpperWick(i)),
    add("d_wick_rsi70", "Mèche haute + RSI>70", "Mèche haute + RSI>70", (i) => ctx.longUpperWick(i) && rsi[14][i] > 70),
    add("d_star_rsi70", "Shooting star + RSI>70", "Shooting star + RSI>70", (i) => ctx.shootingStar(i) && rsi[14][i] > 70),
    add("d_engulf_rsi70", "Bear engulf + RSI>70", "Bearish engulfing + RSI>70", (i) => ctx.bearEngulf(i) && rsi[14][i] > 70),
    add("d_nh50_rsi_div", "NH50 + RSI divergence", "Nouveau haut 50j + divergence RSI", (i) => nh[50][i] && ctx.rsiBearDiv(i, 50)),
    add("d_nh100_macd_div", "NH100 + MACD divergence", "Nouveau haut 100j + divergence MACD", (i) => nh[100][i] && ctx.macdBearDiv(i, 50)),
    add("d_nh252_rsi_div", "NH252 + RSI divergence", "Nouveau haut 252j + divergence RSI", (i) => nh[252][i] && ctx.rsiBearDiv(i, 60)),
    add("d_gap_weak", "Gap up clôture faible", "Gap up puis clôture faible", (i) => ctx.gapUpWeak(i)),
    add("d_distrib_ext", "Distribution après extension", "Distribution day après extension", (i) => ctx.distributionDay(i)),
    add("d_qqq_sma21_break", "QQQ casse SMA21 + TQQQ étiré", "QQQ casse SMA21 pendant extension TQQQ", (i) => ctx.qqqBreakSma21(i)),
    add("d_vix_rise5", "VIX remonte 5j après bas", "VIX remonte sur 5j après bas récent", (i) => ctx.vixLowRise(i) && ctx.vixRise5(i)),
  ];
}

function defineWeeklySignals(wctx) {
  const { rsi, stochRsi, hist, bb, ret, ma, newHigh52, relVol20 } = wctx;
  const add = (id, name, desc, fn) => ({ id, name, description: desc, timeframe: "weekly", eval: fn });
  return [
    add("w_rsi70", "RSI14 > 70", "RSI weekly > 70", (i) => rsi[14][i] > 70),
    add("w_rsi75", "RSI14 > 75", "RSI weekly > 75", (i) => rsi[14][i] > 75),
    add("w_combo2", "RSI>70 + MACD hist -3s", "RSI>70 + MACD hist baisse 3 sem.", (i) => rsi[14][i] > 70 && wctx.histFallWeeks(i, 3)),
    add("w_combo4", "RSI>70 + ret8>25%", "RSI>70 + ret 8 sem > 25%", (i) => rsi[14][i] > 70 && ret[8][i] > 0.25),
    add("w_combo15", "Ret12 fort + RSI extrême", "Ret12 > 40% + RSI>75", (i) => ret[12][i] > 0.4 && rsi[14][i] > 75),
    add("w_combo19", "BB sup + RSI>70", "Bollinger sup + RSI>70", (i) => bb.upper[i] && wctx.closes[i] > bb.upper[i] && rsi[14][i] > 70),
    add("w_combo20", "Mèche haute + RSI>70", "Mèche haute + RSI>70", (i) => wctx.longUpperWick(i) && rsi[14][i] > 70),
    add("w_nh52_rsi_div", "NH52 + RSI divergence", "NH52 + divergence RSI", (i) => newHigh52[i] && wctx.rsiBearDiv(i)),
    add("w_vol2x", "Volume > 2x moy 20s", "Volume relatif > 2x", (i) => relVol20[i] > 2),
    add("w_ext_ma50", ">MA50 15%", "Prix > MA50 de 15%", (i) => wctx.pctAbove(50, i) > 0.15),
    add("w_ret8_25", "Ret8 > 25%", "Rendement 8 semaines > 25%", (i) => ret[8][i] > 0.25),
    add("w_stoch_cross", "StochRSI cross down", "StochRSI croise vers le bas", (i) => wctx.stochCrossDown(i)),
  ];
}

function buildMtfSignals(dctx, wctx, dailyToWeeklyIdx) {
  const add = (id, name, desc, fn) => ({ id, name, description: desc, timeframe: "mtf", eval: fn });
  const w = (i, cond) => { const wi = dailyToWeeklyIdx[i]; return wi != null && cond(wi); };
  const d = (i, cond) => cond(i);
  return [
    add("mtf_1", "W RSI>70 + D hist -3j", "Weekly RSI>70 + daily MACD hist baisse 3j", (i) => w(i, (wi) => wctx.rsi[14][wi] > 70) && d(i, (di) => dctx.histFall(di, 3))),
    add("mtf_2", "W RSI>70 + D sous SMA8", "Weekly RSI>70 + daily clôture sous SMA8", (i) => w(i, (wi) => wctx.rsi[14][wi] > 70) && d(i, (di) => dctx.closeBelow(8, di))),
    add("mtf_3", "W RSI>70 + D sous SMA21", "Weekly RSI>70 + daily clôture sous SMA21", (i) => w(i, (wi) => wctx.rsi[14][wi] > 70) && d(i, (di) => dctx.closeBelow(21, di))),
    add("mtf_4", "W >MA50 15% + D sous SMA21", "Weekly extension MA50 + daily sous SMA21", (i) => w(i, (wi) => wctx.pctAbove(50, wi) > 0.15) && d(i, (di) => dctx.closeBelow(21, di))),
    add("mtf_5", "W BB+RSI + D Stoch cross", "Weekly BB+RSI>70 + daily Stoch cross down", (i) => w(i, (wi) => wctx.rsi[14][wi] > 70 && wctx.bb.upper[wi] && wctx.closes[wi] > wctx.bb.upper[wi]) && d(i, (di) => dctx.stochCrossDown(di))),
    add("mtf_6", "W ret8>25% + D hist baisse", "Weekly ret8>25% + daily MACD hist baisse", (i) => w(i, (wi) => wctx.ret[8][wi] > 0.25) && d(i, (di) => dctx.histFall(di, 2))),
    add("mtf_7", "W mèche + D sous SMA8", "Weekly mèche haute + daily sous SMA8", (i) => w(i, (wi) => wctx.longUpperWick(wi)) && d(i, (di) => dctx.closeBelow(8, di))),
    add("mtf_8", "W vol spike + D mèche", "Weekly vol>2x + daily mèche haute", (i) => w(i, (wi) => wctx.relVol20[wi] > 2) && d(i, (di) => dctx.longUpperWick(di))),
    add("mtf_9", "W NH52 + D RSI div", "Weekly NH52 + daily RSI divergence", (i) => w(i, (wi) => wctx.newHigh52[wi]) && d(i, (di) => dctx.rsiBearDiv(di, 40))),
    add("mtf_10", "W RSI>70 + QQQ casse SMA21", "Weekly RSI>70 + QQQ casse SMA21 daily", (i) => w(i, (wi) => wctx.rsi[14][wi] > 70) && d(i, (di) => dctx.qqqBreakSma21(di))),
    add("mtf_11", "W extension + NDX pas confirmé", "Weekly extension + NDX ne confirme pas", (i) => w(i, (wi) => wctx.pctAbove(50, wi) > 0.15) && d(i, (di) => dctx.ndxNoConfirm(di))),
    add("mtf_12", "W Ret12+RSI + D sous SMA8", "Weekly combo15 + daily sous SMA8", (i) => w(i, (wi) => wctx.ret[12][wi] > 0.4 && wctx.rsi[14][wi] > 75) && d(i, (di) => dctx.closeBelow(8, di))),
    add("mtf_13", "W BB sup + D bear engulf", "Weekly BB sup + daily bear engulf", (i) => w(i, (wi) => wctx.bb.upper[wi] && wctx.closes[wi] > wctx.bb.upper[wi]) && d(i, (di) => dctx.bearEngulf(di))),
    add("mtf_14", "W RSI>75 + D distribution", "Weekly RSI>75 + daily distribution day", (i) => w(i, (wi) => wctx.rsi[14][wi] > 75) && d(i, (di) => dctx.distributionDay(di))),
    add("mtf_15", "W étiré + D VIX remonte 5j", "Weekly étiré + daily VIX remonte", (i) => w(i, (wi) => wctx.pctAbove(50, wi) > 0.15) && d(i, (di) => dctx.vixRise5(di) && dctx.vixLowRise(di))),
  ];
}

function buildDailyToWeeklyMap(bars, weeks) {
  const weekIdxByKey = new Map(weeks.map((w, i) => [w.key, i]));
  const dailyToWeeklyIdx = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    dailyToWeeklyIdx[i] = weekIdxByKey.get(weekKey(bars[i].date)) ?? null;
  }
  return dailyToWeeklyIdx;
}

function applyCooldown(events, cooldownBars) {
  if (!cooldownBars || cooldownBars <= 0) return events;
  const sorted = [...events].sort((a, b) => a.idx - b.idx);
  const kept = [];
  let last = -Infinity;
  for (const e of sorted) {
    if (e.idx - last >= cooldownBars) { kept.push(e); last = e.idx; }
  }
  return kept;
}

function evaluateSignalOnBars(bars, signal, profile, opts = {}) {
  const { warmup, maxForward, isWeekly, cooldownBars = 0 } = opts;
  const lastIdx = bars.length - maxForward - 1;
  const labelKeys = isWeekly
    ? ["isTopShort", "isTopMedium", "isTopMajor", "isTopExtreme"]
    : ["isTopVeryShort", "isTopSwing", "isTopMedium", "isTopMajor"];

  const raw = [];
  for (let i = warmup; i <= lastIdx; i++) {
    if (!signal.eval(i)) continue;
    raw.push({
      idx: i,
      date: bars[i].date.toISOString().slice(0, 10),
      close: bars[i].close,
      labels: Object.fromEntries(labelKeys.map((k) => [k, bars[i][k]])),
      future: bars[i].future,
    });
  }
  const events = applyCooldown(raw, cooldownBars);
  const n = events.length;
  const rate = (k) => (n ? events.filter((e) => e.labels[k]).length / n : null);
  const avgDrop = (horizon) => {
    const vals = events.map((e) => e.future?.maxDrop?.[horizon]).filter((v) => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const worst = (horizon) => {
    const vals = events.map((e) => e.future?.maxDrop?.[horizon]).filter((v) => v != null);
    return vals.length ? Math.min(...vals) : null;
  };
  const anyTop = (e) => labelKeys.some((k) => e.labels[k]);
  const falseSignals = events.filter((e) => !anyTop(e)).length;
  const baseline = computeBaseline(bars, warmup, lastIdx, labelKeys);
  const rates = {
    topVeryShort: rate("isTopVeryShort"),
    topSwing: rate("isTopSwing"),
    topShort: rate("isTopShort"),
    topMedium: rate("isTopMedium"),
    topMajor: rate("isTopMajor"),
    topExtreme: rate("isTopExtreme"),
  };
  const liftMajor = (rates.topMajor ?? 0) - (baseline.rates.topMajor ?? 0);
  const scoreHint = (rates.topMajor ?? 0) * 40 + (rates.topMedium ?? 0) * 25 + (rates.topSwing ?? rates.topShort ?? 0) * 15 + Math.min(0.1, Math.abs(avgDrop(isWeekly ? 12 : 20) ?? 0)) - (n < 10 ? 0.2 : 0);

  return {
    id: signal.id,
    name: signal.name,
    description: signal.description,
    timeframe: signal.timeframe,
    occurrencesRaw: raw.length,
    occurrences: n,
    cooldownBars,
    baseline,
    rates,
    lift: { major: liftMajor, medium: (rates.topMedium ?? 0) - (baseline.rates.topMedium ?? 0) },
    avgFutureDrop: isWeekly
      ? { w4: avgDrop(4), w8: avgDrop(8), w12: avgDrop(12), w16: avgDrop(16) }
      : { d5: avgDrop(5), d10: avgDrop(10), d20: avgDrop(20), d40: avgDrop(40) },
    worstFutureDrop: isWeekly ? { w16: worst(16) } : { d40: worst(40) },
    falseSignals,
    eventDates: events.map((e) => e.date),
    topExamples: [...events].sort((a, b) => (a.future?.maxDrop?.[isWeekly ? 16 : 40] ?? 0) - (b.future?.maxDrop?.[isWeekly ? 16 : 40] ?? 0)).slice(0, 10).map((e) => ({ date: e.date, close: e.close, maxDrop: e.future?.maxDrop })),
    scoreHint,
    verdict: deriveVerdict(n, liftMajor, rates.topMajor),
    lowSampleWarning: n < 10,
  };
}

function computeBaseline(bars, warmup, lastIdx, labelKeys) {
  let n = 0;
  const counts = Object.fromEntries(labelKeys.map((k) => [k, 0]));
  for (let i = warmup; i <= lastIdx; i++) {
    n++;
    for (const k of labelKeys) if (bars[i][k]) counts[k]++;
  }
  const rates = Object.fromEntries(labelKeys.map((k) => [k.replace("isTop", "top").replace("VeryShort", "VeryShort").replace("Swing", "Swing").replace("Short", "Short").replace("Medium", "Medium").replace("Major", "Major").replace("Extreme", "Extreme"), n ? counts[k] / n : null]));
  // normalize keys
  return {
    evaluableBars: n,
    rates: {
      topVeryShort: n ? counts.isTopVeryShort / n : null,
      topSwing: n ? counts.isTopSwing / n : null,
      topShort: n ? counts.isTopShort / n : null,
      topMedium: n ? counts.isTopMedium / n : null,
      topMajor: n ? counts.isTopMajor / n : null,
      topExtreme: n ? counts.isTopExtreme / n : null,
    },
  };
}

function deriveVerdict(n, liftMajor, rateMajor) {
  if (n < 6) return "trop rare";
  if (n < 10) return "exploratoire";
  if (liftMajor >= 0.1 && rateMajor >= 0.2) return "robuste";
  if (liftMajor >= 0.06 || rateMajor >= 0.15) return "prometteur";
  if (liftMajor < 0.02 && n >= 15) return "faible";
  return "exploratoire";
}

function runSignalBattery(bars, signals, profile, isWeekly, cooldownList) {
  const results = [];
  for (const signal of signals) {
    for (const cd of cooldownList) {
      const cooldownBars = isWeekly ? (cd.weeks ?? 0) * 5 : (cd.days ?? 0);
      results.push({
        cooldownVariant: cd.id,
        cooldownLabel: cd.label,
        ...evaluateSignalOnBars(bars, signal, profile, {
          warmup: profile.warmup,
          maxForward: profile.maxForward,
          isWeekly,
          cooldownBars,
        }),
      });
    }
  }
  return results;
}

function pickBestPerSignal(results) {
  const byId = new Map();
  for (const r of results) {
    const key = `${r.id}|${r.timeframe}`;
    const prev = byId.get(key);
    if (!prev || r.scoreHint > prev.scoreHint) byId.set(key, r);
  }
  return [...byId.values()].sort((a, b) => b.scoreHint - a.scoreHint);
}

function computeTopRiskScore(signalResults, timeframe) {
  const pool = signalResults.filter((s) => s.timeframe === timeframe && s.occurrences >= 8 && !s.lowSampleWarning);
  const eligible = pool.sort((a, b) => b.scoreHint - a.scoreHint).slice(0, 10);
  const weightTotal = eligible.reduce((s, r) => s + r.scoreHint, 0) || 1;
  const families = { extension: 0, momentum: 0, weaken: 0, break: 0, volume: 0, candle: 0, intermarket: 0 };
  for (const r of eligible) {
    const n = r.name.toLowerCase();
    const w = r.scoreHint / weightTotal;
    if (n.includes("sma") || n.includes("ma50") || n.includes("ret")) families.extension += w;
    else if (n.includes("rsi") || n.includes("stoch")) families.momentum += w;
    else if (n.includes("hist") || n.includes("div")) families.weaken += w;
    else if (n.includes("sous") || n.includes("casse")) families.break += w;
    else if (n.includes("vol")) families.volume += w;
    else if (n.includes("mèche") || n.includes("engulf") || n.includes("star")) families.candle += w;
    else families.intermarket += w;
  }
  const raw = (families.extension * 22 + families.momentum * 20 + families.weaken * 18 + families.break * 15 + families.volume * 12 + families.candle * 8 + families.intermarket * 5) * 100;
  return {
    score: Math.round(Math.min(100, Math.max(0, raw))),
    families,
    signalsUsed: eligible.map((e) => e.id),
  };
}

function buildCrossValidation(primaryDailyBest, comparisonBatteries) {
  const top = primaryDailyBest.filter((s) => s.timeframe === "daily").slice(0, 10);
  return top.map((sig) => {
    const row = { signalId: sig.id, signalName: sig.name, tqqqDaily: { rateMajor: sig.rates.topMajor, n: sig.occurrences, verdict: sig.verdict } };
    for (const comp of comparisonBatteries) {
      const match = comp.results.find((r) => r.id === sig.id && r.timeframe === "daily");
      row[comp.label] = match ? { rateMajor: match.rates.topMajor, n: match.occurrences } : null;
    }
    const qqqLift = row.QQQ?.rateMajor != null ? row.QQQ.rateMajor - (row.tqqqDaily.rateMajor ?? 0) : null;
    row.concordanceVerdict = sig.occurrences < 10 ? "Trop rare / non concluant"
      : qqqLift != null && qqqLift > -0.05 ? "Confirmé par QQQ / Nasdaq"
      : sig.lift.major >= 0.08 ? "Spécifique au levier TQQQ"
      : "Partiellement confirmé";
    return row;
  });
}

async function fetchNdx() {
  for (const sym of ["^NDX", "NDX"]) {
    const r = await fetchExtendedHistory(sym);
    if (r.rows) return { ...r, symbol: sym };
  }
  return { rows: null, error: "NDX indisponible" };
}

async function loadAuxDaily(bars, extras) {
  const missing = [...MISSING_BREADTH];
  const available = [];
  const aux = {};
  if (extras.qqq?.rows) {
    const qqqCloses = extras.qqq.rows.map((r) => r.close);
    const qqqSma21 = smaSeries(qqqCloses, 21);
    const byDate = new Map(extras.qqq.rows.map((r, i) => [r.date.toISOString().slice(0, 10), qqqSma21[i]]));
    aux.qqqSma21 = bars.map((b) => byDate.get(b.date.toISOString().slice(0, 10)) ?? null);
    available.push("QQQ daily");
  }
  if (extras.ndx?.rows) {
    const ndxCloses = extras.ndx.rows.map((r) => r.close);
    const ndxSma21 = smaSeries(ndxCloses, 21);
    const byDate = new Map(extras.ndx.rows.map((r, i) => [r.date.toISOString().slice(0, 10), ndxSma21[i]]));
    aux.ndxSma21 = bars.map((b) => byDate.get(b.date.toISOString().slice(0, 10)) ?? null);
    available.push("NDX daily");
  }
  const vixRes = await fetchExtendedHistory("^VIX");
  if (vixRes.rows) {
    aux.vix = alignByDate(bars, vixRes.rows);
    available.push("VIX");
  }
  const spyRes = await fetchExtendedHistory("SPY");
  if (spyRes.rows) {
    const spyC = spyRes.rows.map((r) => r.close);
    const byDate = new Map();
    for (let i = 20; i < spyRes.rows.length; i++) {
      byDate.set(spyRes.rows[i].date.toISOString().slice(0, 10), spyC[i] / spyC[i - 20] - 1);
    }
    aux.spyRet20 = bars.map((b) => byDate.get(b.date.toISOString().slice(0, 10)) ?? null);
    available.push("SPY");
  }
  return { aux, missing, available };
}

async function main() {
  console.log("=== AUDIT TOP MULTI-TIMEFRAME (DAILY + WEEKLY + MTF) ===");
  console.log(`Ticker demandé: ${PRIMARY_TICKER}\n`);

  const isLeveragedPrimary = PRIMARY_TICKER === "TQQQ";
  const dailyProfile = isLeveragedPrimary ? DAILY_PROFILES.leveraged : DAILY_PROFILES.index;
  const weeklyProfile = isLeveragedPrimary ? WEEKLY_PROFILES.leveraged : WEEKLY_PROFILES.index;

  let primaryRows;
  let primaryLabel;
  if (PRIMARY_TICKER === "TQQQ") {
    const tqqqRes = await fetchExtendedHistory("TQQQ");
    if (!tqqqRes.rows) { console.error("TQQQ réel requis:", tqqqRes.error); process.exit(1); }
    primaryRows = tqqqRes.rows;
    primaryLabel = "TQQQ_REAL";
    console.log(`Série principale : TQQQ réel`);
    console.log(`Période : ${tqqqRes.firstDate} → ${tqqqRes.lastDate} (${tqqqRes.rowCount} jours)\n`);
  } else {
    const qqqRes = await fetchExtendedHistory(PRIMARY_TICKER);
    if (!qqqRes.rows) { console.error("Échec:", qqqRes.error); process.exit(1); }
    primaryRows = qqqRes.rows;
    primaryLabel = PRIMARY_TICKER;
    console.log(`Série principale : ${PRIMARY_TICKER}`);
    console.log(`Période : ${qqqRes.firstDate} → ${qqqRes.lastDate}\n`);
  }

  if (primaryRows.length < MIN_DAILY) { console.error("Historique trop court"); process.exit(1); }

  const qqqRes = await fetchExtendedHistory("QQQ");
  const ndxRes = await fetchNdx();
  const extras = { qqq: qqqRes, ndx: ndxRes };

  attachFutureLabelsBars(primaryRows, dailyProfile, false);
  const weeks = aggregateDailyToWeekly(primaryRows);
  attachFutureLabelsWeekly(weeks, weeklyProfile);

  const { aux } = await loadAuxDaily(primaryRows, extras);
  const dctx = buildDailyCtx(primaryRows, aux);
  const wctx = buildWeeklyCtx(weeks, {});
  const dailyToWeeklyIdx = buildDailyToWeeklyMap(primaryRows, weeks);

  const dailySignals = defineDailySignals(dctx);
  const weeklySignals = defineWeeklySignals(wctx);
  const mtfSignals = buildMtfSignals(dctx, wctx, dailyToWeeklyIdx);

  const dailyBattery = runSignalBattery(primaryRows, dailySignals, dailyProfile, false, COOLDOWN_VARIANTS.daily);
  const weeklyBattery = runSignalBattery(weeks, weeklySignals, weeklyProfile, true, COOLDOWN_VARIANTS.weekly);
  const mtfBattery = runSignalBattery(primaryRows, mtfSignals, dailyProfile, false, COOLDOWN_VARIANTS.daily);

  const dailyBest = pickBestPerSignal(dailyBattery);
  const weeklyBest = pickBestPerSignal(weeklyBattery);
  const mtfBest = pickBestPerSignal(mtfBattery);

  const dailyRisk = computeTopRiskScore(dailyBest, "daily");
  const weeklyRisk = computeTopRiskScore(weeklyBest, "weekly");
  const combinedRisk = computeTopRiskScore([...dailyBest.slice(0, 5), ...mtfBest.slice(0, 5)], "mtf");

  const comparisonBatteries = [];
  if (qqqRes.rows) {
    const qqqBars = qqqRes.rows;
    attachFutureLabelsBars(qqqBars, DAILY_PROFILES.index, false);
    const qctx = buildDailyCtx(qqqBars, {});
    const qSigs = defineDailySignals(qctx);
    comparisonBatteries.push({ label: "QQQ", results: runSignalBattery(qqqBars, qSigs, DAILY_PROFILES.index, false, [{ id: "cd10d", days: 10 }]) });
  }
  const crossValidation = buildCrossValidation(dailyBest, comparisonBatteries);

  const mtfVsWeekly = mtfBest[0] && weeklyBest[0]
    ? (mtfBest[0].rates.topMajor ?? 0) > (weeklyBest[0].rates.topMajor ?? 0) + 0.03
    : null;

  printReport(dailyBest, weeklyBest, mtfBest, dailyRisk, weeklyRisk, combinedRisk, crossValidation, mtfVsWeekly, primaryLabel, primaryRows, weeks);

  const output = {
    generatedAt: new Date().toISOString(),
    primaryTicker: PRIMARY_TICKER,
    primarySeries: { label: primaryLabel, period: { first: primaryRows[0].date.toISOString().slice(0, 10), last: primaryRows.at(-1).date.toISOString().slice(0, 10) }, role: "primary" },
    comparisonSeries: [
      qqqRes.rows ? { label: "QQQ", role: "validation", period: { first: qqqRes.firstDate, last: qqqRes.lastDate } } : null,
      ndxRes.rows ? { label: "NDX", role: "validation_nasdaq", period: { first: ndxRes.firstDate, last: ndxRes.lastDate } } : null,
    ].filter(Boolean),
    thresholdsUsedBySeries: { daily: dailyProfile, weekly: weeklyProfile },
    missingData: MISSING_BREADTH,
    topRiskScores: { dailyTopRiskScore: dailyRisk, weeklyTopRiskScore: weeklyRisk, combinedTopRiskScore: combinedRisk },
    dailyDoesImproveWeekly: mtfVsWeekly,
    crossSeriesValidation: crossValidation,
    top15: { daily: dailyBest.slice(0, 15), weekly: weeklyBest.slice(0, 15), mtf: mtfBest.slice(0, 15) },
    allResults: { daily: dailyBattery, weekly: weeklyBattery, mtf: mtfBattery },
  };

  writeOutputs(output);
}

function printReport(dailyBest, weeklyBest, mtfBest, dRisk, wRisk, cRisk, cross, mtfVsWeekly, label, bars, weeks) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`RAPPORT FINAL — ${label}`);
  console.log(`Daily: ${bars[0].date.toISOString().slice(0, 10)} → ${bars.at(-1).date.toISOString().slice(0, 10)}`);
  console.log(`Weekly: ${weeks[0].date.toISOString().slice(0, 10)} → ${weeks.at(-1).date.toISOString().slice(0, 10)} (${weeks.length} sem.)`);

  const printTop = (title, list) => {
    console.log(`\n── ${title} ──`);
    for (const s of list.slice(0, 15)) {
      const warn = s.lowSampleWarning ? " ⚠" : "";
      console.log(`  ${s.name}${warn} | n=${s.occurrences} (brut ${s.occurrencesRaw}) | majeur ${pctFmt(s.rates.topMajor)} | lift ${pctFmt(s.lift?.major)} | ${s.verdict} | cd=${s.cooldownVariant}`);
    }
  };
  printTop("Top 15 DAILY (meilleur cooldown par signal)", dailyBest);
  printTop("Top 15 WEEKLY", weeklyBest);
  printTop("Top 15 MULTI-TIMEFRAME", mtfBest);

  console.log(`\n── TopRiskScore ──`);
  console.log(`  DailyTopRiskScore: ${dRisk.score} — familles: ${JSON.stringify(dRisk.families)}`);
  console.log(`  WeeklyTopRiskScore: ${wRisk.score} — signaux: ${wRisk.signalsUsed.join(", ")}`);
  console.log(`  CombinedTopRiskScore: ${cRisk.score}`);

  console.log(`\n── Le daily améliore-t-il le weekly? ──`);
  console.log(`  ${mtfVsWeekly === true ? "Oui — les combos MTF montrent un taux top majeur plus élevé que le meilleur signal weekly seul." : mtfVsWeekly === false ? "Pas clairement — le weekly seul reste compétitif." : "Non concluant"}`);

  console.log(`\n── Validation inter-séries (top daily TQQQ) ──`);
  for (const row of cross.slice(0, 8)) {
    console.log(`  ${row.signalName}: TQQQ majeur ${pctFmt(row.tqqqDaily.rateMajor)} | QQQ ${pctFmt(row.QQQ?.rateMajor)} | ${row.concordanceVerdict}`);
  }

  console.log(`\n── Données externes manquantes ──`);
  console.log(`  ${MISSING_BREADTH.join("; ")}`);

  console.log(`\n── Recommandation dashboard (future) ──`);
  const dash = [...dailyBest, ...mtfBest].filter((s) => s.verdict === "robuste" || s.verdict === "prometteur").slice(0, 5);
  console.log(`  Intégrer en priorité: ${dash.map((s) => s.name).join(", ") || "voir JSON"}`);
  console.log(`  Garder weekly pour contexte; daily/MTF pour timing précis avant correction.`);
}

function writeOutputs(output) {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `top-correlation-mtf-${PRIMARY_TICKER}-${ts}`;
  const jsonPath = path.join(DEBUG_DIR, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");

  const rows = [];
  for (const bucket of ["daily", "weekly", "mtf"]) {
    for (const r of output.allResults[bucket] ?? []) {
      rows.push({
        timeframe: r.timeframe,
        signalId: r.id,
        signalName: r.name,
        cooldown: r.cooldownVariant,
        occurrencesRaw: r.occurrencesRaw,
        occurrences: r.occurrences,
        baselineMajor: r.baseline?.rates?.topMajor,
        topMajorRate: r.rates.topMajor,
        liftMajor: r.lift?.major,
        verdict: r.verdict,
        scoreHint: r.scoreHint,
      });
    }
  }
  const csvPath = path.join(DEBUG_DIR, `${base}-summary.csv`);
  if (rows.length) {
    const hdr = Object.keys(rows[0]).join(",");
    fs.writeFileSync(csvPath, `${hdr}\n${rows.map((row) => Object.values(row).join(",")).join("\n")}`, "utf8");
  }

  const events = [];
  for (const bucket of ["daily", "weekly", "mtf"]) {
    for (const r of output.allResults[bucket] ?? []) {
      if (r.cooldownVariant !== "cd10d" && r.cooldownVariant !== "cd4w" && r.cooldownVariant !== "none") continue;
      for (const d of r.eventDates ?? []) events.push({ timeframe: r.timeframe, signalId: r.id, date: d });
    }
  }
  const eventsPath = path.join(DEBUG_DIR, `${base}-events.csv`);
  fs.writeFileSync(eventsPath, `timeframe,signalId,date\n${events.map((e) => `${e.timeframe},${e.signalId},${e.date}`).join("\n")}`, "utf8");

  const crossPath = path.join(DEBUG_DIR, `${base}-cross-validation.csv`);
  if (output.crossSeriesValidation?.length) {
    const hdr = Object.keys(output.crossSeriesValidation[0]).join(",");
    fs.writeFileSync(crossPath, `${hdr}\n${output.crossSeriesValidation.map((row) => Object.values(row).map((v) => (typeof v === "object" ? JSON.stringify(v) : v ?? "")).join(",")).join("\n")}`, "utf8");
  }

  console.log(`\nFichiers écrits:\n  ${jsonPath}\n  ${csvPath}\n  ${eventsPath}\n  ${crossPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
