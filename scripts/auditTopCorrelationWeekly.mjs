/**
 * Audit historique — conditions qui précèdent les tops weekly TQQQ / QQQ.
 * Usage: node scripts/auditTopCorrelationWeekly.mjs [TQQQ|QQQ] [--from-cache]
 *
 * TQQQ : série principale = TQQQ réel (depuis première date dispo ~2010).
 *        QQQ / NDX / synthétique = comparaison avec seuils adaptés.
 * QQQ  : série principale = QQQ (seuils indice), comparaisons NDX + synthétique.
 *
 * - Indicateurs sans lookahead ; labels tops = futur seulement.
 * - AUDIT_INSECURE_TLS=1 si erreur certificat Yahoo sur Windows.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YahooFinance from "yahoo-finance2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEBUG_DIR = path.join(ROOT, "debug");

const START_DATE = new Date("2008-01-02T00:00:00Z");
const MIN_WEEKS = 60;
const EXPENSE_DRAG_ANNUAL = 0.0095;

/** Seuils de top — différenciés levier vs indice (QQQ / NDX). */
const THRESHOLD_PROFILES = {
  leveraged: {
    id: "leveraged",
    appliesTo: "TQQQ réel, TQQQ synthétique",
    short: { weeks: 4, threshold: -0.12, name: "Top court (-12% / 4 sem.)" },
    medium: { weeks: 8, threshold: -0.20, name: "Top moyen (-20% / 8 sem.)" },
    major: { weeks: 12, threshold: -0.30, name: "Top majeur (-30% / 12 sem.)" },
    extreme: { weeks: 16, threshold: -0.40, name: "Top extrême (-40% / 16 sem.)" },
  },
  index: {
    id: "index",
    appliesTo: "QQQ, NDX / Nasdaq 100",
    short: { weeks: 4, threshold: -0.05, name: "Top court (-5% / 4 sem.)" },
    medium: { weeks: 8, threshold: -0.08, name: "Top moyen (-8% / 8 sem.)" },
    major: { weeks: 12, threshold: -0.12, name: "Top majeur (-12% / 12 sem.)" },
    extreme: { weeks: 16, threshold: -0.18, name: "Top extrême (-18% / 16 sem.)" },
  },
};

const COMPARISON_SERIES_LABELS = {
  QQQ: { label: "QQQ", role: "proxy_indice_2008", thresholdProfile: "index" },
  NDX: { label: "NDX", role: "validation_nasdaq100", thresholdProfile: "index" },
  TQQQ_SYNTHETIC_3X_QQQ: { label: "TQQQ_SYNTHETIC_3X_QQQ", role: "validation_synthetique", thresholdProfile: "leveraged" },
};

const CLI_ARGS = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const PRIMARY_TICKER = (CLI_ARGS[0] ?? "TQQQ").trim().toUpperCase();
const USE_DISK_CACHE = process.argv.includes("--cache") || process.argv.includes("--from-cache");
const SAVE_DISK_CACHE = !process.argv.includes("--no-save-cache");

if (process.env.AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn("⚠ AUDIT_INSECURE_TLS=1 — vérification certificat TLS désactivée pour cet audit seulement.");
}

const OPTIONAL_SYMBOLS = {
  SPY: "SPY",
  QQQ: "QQQ",
  IWM: "IWM",
  DIA: "DIA",
  VIX: "^VIX",
  VVIX: "^VVIX",
  US10Y: "^TNX",
  US2Y: "^IRX",
  DXY: "DX-Y.NYB",
  OIL: "CL=F",
  S5TH: "^S5TH",
  S5FI: "^S5FI",
  S5OH: "^S5OH",
  PCALL: "^CPC",
  FEAR_GREED: null,
  AAII: null,
  NAAIM: null,
};

let yahooClient = null;
function getYahoo() {
  if (!yahooClient) {
    yahooClient = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
  }
  return yahooClient;
}

function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return {
    week: Math.ceil(((d - jan1) / 86_400_000 + 1) / 7),
    year: d.getUTCFullYear(),
  };
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
  const vol = toNum(q.volume);
  return {
    date,
    open: toNum(q.open) ?? close,
    high: toNum(q.high) ?? close,
    low: toNum(q.low) ?? close,
    close,
    volume: vol != null && vol >= 0 ? vol : null,
  };
}

function cachePathForSymbol(symbol) {
  const safe = String(symbol).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(DEBUG_DIR, `ohlc-cache-${safe}.json`);
}

function loadDiskCache(symbol) {
  const p = cachePathForSymbol(symbol);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const rows = (raw.rows ?? []).map((r) => ({
      ...r,
      date: new Date(r.date),
    })).filter((r) => r.close > 0);
    if (rows.length < 50) return null;
    return {
      symbol,
      rows,
      firstDate: rows[0].date.toISOString().slice(0, 10),
      lastDate: rows[rows.length - 1].date.toISOString().slice(0, 10),
      rowCount: rows.length,
      source: "disk-cache",
    };
  } catch {
    return null;
  }
}

function saveDiskCache(symbol, rows) {
  if (!SAVE_DISK_CACHE || !rows?.length) return;
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const payload = {
    symbol,
    savedAt: new Date().toISOString(),
    rows: rows.map((r) => ({
      date: r.date.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    })),
  };
  fs.writeFileSync(cachePathForSymbol(symbol), JSON.stringify(payload), "utf8");
}

async function fetchExtendedHistory(symbol) {
  const sym = String(symbol ?? "").trim();
  if (!sym) return { symbol: sym, rows: null, error: "symbole vide" };

  if (USE_DISK_CACHE) {
    const cached = loadDiskCache(sym);
    if (cached) return cached;
  }

  try {
    const chartResult = await getYahoo().chart(sym, {
      period1: START_DATE,
      period2: new Date(),
      interval: "1d",
    });
    const quotes = chartResult?.quotes;
    if (!Array.isArray(quotes)) {
      return { symbol: sym, rows: null, error: "quotes invalides" };
    }
    const rows = quotes.map(normalizeDailyQuote).filter(Boolean).sort((a, b) => a.date - b.date);
    if (rows.length < 50) {
      return { symbol: sym, rows: null, error: `seulement ${rows.length} jours` };
    }
    const result = {
      symbol: sym,
      rows,
      firstDate: rows[0].date.toISOString().slice(0, 10),
      lastDate: rows[rows.length - 1].date.toISOString().slice(0, 10),
      rowCount: rows.length,
      source: "yahoo-chart",
    };
    saveDiskCache(sym, rows);
    return result;
  } catch (err) {
    const cached = loadDiskCache(sym);
    if (cached) {
      console.warn(`  ${sym}: Yahoo échoué (${err?.message}) — cache disque utilisé`);
      return cached;
    }
    return { symbol: sym, rows: null, error: err?.message ?? String(err) };
  }
}

function aggregateDailyToWeekly(dailyRows) {
  const buckets = new Map();
  for (const r of dailyRows) {
    const k = weekKey(r.date);
    if (!buckets.has(k)) {
      buckets.set(k, { key: k, dates: [], rows: [] });
    }
    const b = buckets.get(k);
    b.dates.push(r.date);
    b.rows.push(r);
  }
  const weeks = [];
  for (const b of buckets.values()) {
    const sorted = b.rows.sort((a, b) => a.date - b.date);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const vols = sorted.map((x) => x.volume).filter((v) => v != null);
    const volume = vols.length ? vols.reduce((s, v) => s + v, 0) : null;
    const { week, year } = isoWeek(last.date);
    weeks.push({
      key: b.key,
      week,
      year,
      month: last.date.getUTCMonth() + 1,
      weekOfYear: week,
      date: last.date,
      open: first.open,
      high: Math.max(...sorted.map((x) => x.high)),
      low: Math.min(...sorted.map((x) => x.low)),
      close: last.close,
      volume,
    });
  }
  weeks.sort((a, b) => a.date - b.date);
  return weeks;
}

function buildSyntheticTqqqDaily(qqqDaily, startPrice = 40) {
  if (!qqqDaily?.length) return [];
  const dailyDrag = EXPENSE_DRAG_ANNUAL / 252;
  let price = startPrice;
  const out = [];
  for (let i = 0; i < qqqDaily.length; i++) {
    const row = qqqDaily[i];
    if (i === 0) {
      price = startPrice;
      out.push({ ...row, open: price, high: price, low: price, close: price });
      continue;
    }
    const prev = qqqDaily[i - 1].close;
    const ret = prev > 0 ? row.close / prev - 1 : 0;
    const levRet = ret * 3 - dailyDrag;
    price = Math.max(0.01, price * (1 + levRet));
    const range = row.high / row.low > 0 ? (row.high - row.low) / row.close : 0.02;
    out.push({
      date: row.date,
      open: price * (row.open / row.close),
      high: price * (1 + range * 0.5),
      low: price * (1 - range * 0.5),
      close: price,
      volume: row.volume,
    });
  }
  return out;
}

function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let ok = true;
    let sum = 0;
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
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgGain += ch;
    else avgLoss += Math.abs(ch);
  }
  avgGain /= period;
  avgLoss /= period;
  const calc = (g, l) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = calc(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? Math.abs(ch) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = calc(avgGain, avgLoss);
  }
  return out;
}

function stochRsiSeries(closes, rsiPeriod = 14, stochPeriod = 14) {
  const rsi = rsiSeries(closes, rsiPeriod);
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < rsiPeriod + stochPeriod) continue;
    const window = rsi.slice(i - stochPeriod + 1, i + 1).filter((v) => v != null);
    if (window.length < stochPeriod) continue;
    const cur = rsi[i];
    if (cur == null) continue;
    const lo = Math.min(...window);
    const hi = Math.max(...window);
    out[i] = hi === lo ? 50 : ((cur - lo) / (hi - lo)) * 100;
  }
  return out;
}

function cciSeries(weeks, period = 20) {
  const tp = weeks.map((w) => (w.high + w.low + w.close) / 3);
  const out = new Array(weeks.length).fill(null);
  for (let i = period - 1; i < weeks.length; i++) {
    const slice = tp.slice(i - period + 1, i + 1);
    const sma = slice.reduce((s, v) => s + v, 0) / period;
    const md = slice.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    if (md === 0) out[i] = 0;
    else out[i] = (tp[i] - sma) / (0.015 * md);
  }
  return out;
}

function macdSeries(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macd = new Array(closes.length).fill(null);
  const signal = new Array(closes.length).fill(null);
  const hist = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] != null && ema26[i] != null) macd[i] = ema12[i] - ema26[i];
  }
  const macdVals = macd.map((v) => (v == null ? 0 : v));
  const sigEma = emaSeries(macdVals.map((v, i) => (macd[i] == null ? null : v)), 9);
  for (let i = 0; i < closes.length; i++) {
    if (macd[i] != null && sigEma[i] != null) {
      signal[i] = sigEma[i];
      hist[i] = macd[i] - sigEma[i];
    }
  }
  return { macd, signal, hist };
}

function atrSeries(weeks, period = 14) {
  const out = new Array(weeks.length).fill(null);
  const tr = new Array(weeks.length).fill(null);
  for (let i = 1; i < weeks.length; i++) {
    const h = weeks[i].high;
    const l = weeks[i].low;
    const pc = weeks[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  for (let i = period; i < weeks.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tr[j] ?? 0;
    out[i] = sum / period;
  }
  return out;
}

function bollingerSeries(closes, period = 20, mult = 2) {
  const mid = smaSeries(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const m = mid[i];
    if (m == null) continue;
    const variance = slice.reduce((s, v) => s + (v - m) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    width[i] = m > 0 ? (upper[i] - lower[i]) / m : null;
  }
  return { mid, upper, lower, width };
}

function slopeSeries(series, lookback = 4) {
  const out = new Array(series.length).fill(null);
  for (let i = lookback; i < series.length; i++) {
    const a = series[i - lookback];
    const b = series[i];
    if (a != null && b != null && a !== 0) out[i] = (b - a) / a;
  }
  return out;
}

function returnWeeksSeries(closes, weeks) {
  const out = new Array(closes.length).fill(null);
  for (let i = weeks; i < closes.length; i++) {
    if (closes[i - weeks] > 0) out[i] = closes[i] / closes[i - weeks] - 1;
  }
  return out;
}

function realizedVolSeries(closes, weeks) {
  const out = new Array(closes.length).fill(null);
  for (let i = weeks; i < closes.length; i++) {
    const rets = [];
    for (let j = i - weeks + 1; j <= i; j++) {
      if (closes[j - 1] > 0) rets.push(Math.log(closes[j] / closes[j - 1]));
    }
    if (rets.length < weeks - 1) continue;
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const variance = rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length;
    out[i] = Math.sqrt(variance) * Math.sqrt(52);
  }
  return out;
}

function obvSeries(weeks) {
  const out = new Array(weeks.length).fill(null);
  let obv = 0;
  for (let i = 1; i < weeks.length; i++) {
    const vol = weeks[i].volume ?? 0;
    if (weeks[i].close > weeks[i - 1].close) obv += vol;
    else if (weeks[i].close < weeks[i - 1].close) obv -= vol;
    out[i] = obv;
  }
  return out;
}

function alignSeriesToWeeks(weeks, dailyRows, valueFn = (r) => r.close) {
  const byWeek = new Map();
  for (const r of dailyRows) {
    byWeek.set(weekKey(r.date), valueFn(r));
  }
  return weeks.map((w) => byWeek.get(w.key) ?? null);
}

function attachFutureLabels(weeks, profile = THRESHOLD_PROFILES.leveraged) {
  const n = weeks.length;
  const horizons = [4, 8, 12, 16];
  for (let i = 0; i < n; i++) {
    const base = weeks[i].close;
    const future = { maxDrop: {}, forwardReturn: {}, weeksToMaxDrop: {} };
    for (const h of horizons) {
      let minRet = 0;
      let minIdx = null;
      let closeRet = null;
      for (let j = 1; j <= h && i + j < n; j++) {
        const r = weeks[i + j].close / base - 1;
        if (r < minRet) {
          minRet = r;
          minIdx = j;
        }
      }
      if (i + h < n) closeRet = weeks[i + h].close / base - 1;
      future.maxDrop[h] = minRet;
      future.forwardReturn[h] = closeRet;
      future.weeksToMaxDrop[h] = minIdx;
    }
    weeks[i].future = future;
    weeks[i].isTopShort = (future.maxDrop[4] ?? 0) <= profile.short.threshold;
    weeks[i].isTopMedium = (future.maxDrop[8] ?? 0) <= profile.medium.threshold;
    weeks[i].isTopMajor = (future.maxDrop[12] ?? 0) <= profile.major.threshold;
    weeks[i].isTopExtreme = (future.maxDrop[16] ?? 0) <= profile.extreme.threshold;
  }
}

function formatThresholdsSummary(profile) {
  const p = profile ?? THRESHOLD_PROFILES.leveraged;
  return `court ${(p.short.threshold * 100).toFixed(0)}%/4s | moyen ${(p.medium.threshold * 100).toFixed(0)}%/8s | majeur ${(p.major.threshold * 100).toFixed(0)}%/12s | extrême ${(p.extreme.threshold * 100).toFixed(0)}%/16s`;
}

function buildIndicatorState(weeks, aux = {}) {
  const closes = weeks.map((w) => w.close);
  const highs = weeks.map((w) => w.high);
  const lows = weeks.map((w) => w.low);
  const n = weeks.length;

  const ma = {
    8: smaSeries(closes, 8),
    21: smaSeries(closes, 21),
    34: smaSeries(closes, 34),
    50: smaSeries(closes, 50),
    100: smaSeries(closes, 100),
    150: smaSeries(closes, 150),
    200: smaSeries(closes, 200),
  };
  const ema = {
    8: emaSeries(closes, 8),
    21: emaSeries(closes, 21),
    34: emaSeries(closes, 34),
    50: emaSeries(closes, 50),
    200: emaSeries(closes, 200),
  };

  const rsi = { 7: rsiSeries(closes, 7), 14: rsiSeries(closes, 14), 21: rsiSeries(closes, 21) };
  const stochRsi = stochRsiSeries(closes);
  const cci = cciSeries(weeks, 20);
  const { macd, signal, hist } = macdSeries(closes);
  const atr = atrSeries(weeks, 14);
  const bb = bollingerSeries(closes, 20, 2);
  const obv = obvSeries(weeks);

  const ret = {
    4: returnWeeksSeries(closes, 4),
    8: returnWeeksSeries(closes, 8),
    12: returnWeeksSeries(closes, 12),
    26: returnWeeksSeries(closes, 26),
  };
  const roc = { 4: ret[4], 8: ret[8], 12: ret[12] };
  const rvol = { 4: realizedVolSeries(closes, 4), 8: realizedVolSeries(closes, 8), 12: realizedVolSeries(closes, 12) };

  const high52 = new Array(n).fill(null);
  const dist52 = new Array(n).fill(null);
  const newHigh26 = new Array(n).fill(false);
  const newHigh52 = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    const w26 = closes.slice(Math.max(0, i - 25), i);
    const w52 = closes.slice(Math.max(0, i - 51), i);
    const h26 = w26.length ? Math.max(...w26) : null;
    const h52 = w52.length ? Math.max(...w52, closes[i]) : closes[i];
    high52[i] = h52;
    dist52[i] = h52 > 0 ? closes[i] / h52 - 1 : null;
    newHigh26[i] = w26.length >= 10 && closes[i] >= Math.max(...w26);
    newHigh52[i] = w52.length >= 26 && closes[i] >= Math.max(...w52);
  }

  const volMa20 = smaSeries(weeks.map((w) => w.volume ?? 0), 20);
  const volMa50 = smaSeries(weeks.map((w) => w.volume ?? 0), 50);
  const relVol20 = weeks.map((w, i) => (volMa20[i] > 0 && w.volume != null ? w.volume / volMa20[i] : null));
  const relVol50 = weeks.map((w, i) => (volMa50[i] > 0 && w.volume != null ? w.volume / volMa50[i] : null));

  const consecPos = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    consecPos[i] = closes[i] > closes[i - 1] ? consecPos[i - 1] + 1 : 0;
  }

  const weeksSinceTouch = { ma8: new Array(n).fill(0), ma21: new Array(n).fill(0), ma34: new Array(n).fill(0) };
  for (let i = 1; i < n; i++) {
    for (const p of [8, 21, 34]) {
      const key = `ma${p}`;
      const touched = ma[p][i] != null && lows[i] <= ma[p][i];
      weeksSinceTouch[key][i] = touched ? 0 : weeksSinceTouch[key][i - 1] + 1;
    }
  }

  const drawdown52 = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const slice = closes.slice(Math.max(0, i - 51), i + 1);
    const peak = Math.max(...slice);
    drawdown52[i] = peak > 0 ? closes[i] / peak - 1 : null;
  }

  const rangeAvg = smaSeries(
    weeks.map((w) => (w.close > 0 ? (w.high - w.low) / w.close : null)),
    8,
  );

  const vix = aux.vix ?? new Array(n).fill(null);
  const s5th = aux.s5th ?? new Array(n).fill(null);
  const spyRet8 = aux.spyRet8 ?? new Array(n).fill(null);
  const iwmRet8 = aux.iwmRet8 ?? new Array(n).fill(null);
  const qqqRet8 = aux.qqqRet8 ?? ret[8];

  const ctx = { weeks, closes, highs, lows, n, ma, ema, rsi, stochRsi, cci, macd, signal, hist, atr, bb, obv, ret, roc, rvol, high52, dist52, newHigh26, newHigh52, volMa20, relVol20, relVol50, consecPos, weeksSinceTouch, drawdown52, rangeAvg, vix, s5th, spyRet8, iwmRet8, qqqRet8 };

  ctx.pctAbove = (maKey, i) => {
    const m = ma[maKey][i];
    return m > 0 ? closes[i] / m - 1 : null;
  };
  ctx.histFallWeeks = (i, w) => {
    if (i < w || hist[i] == null) return false;
    for (let k = 0; k < w; k++) {
      if (hist[i - k] == null || hist[i - k - 1] == null) return false;
      if (!(hist[i - k] < hist[i - k - 1])) return false;
    }
    return true;
  };
  ctx.rsiBearDiv = (i, lookback = 26) => {
    if (i < lookback) return false;
    const pWin = closes.slice(i - lookback, i + 1);
    const rWin = rsi[14].slice(i - lookback, i + 1);
    const pMax = Math.max(...pWin);
    const rAtMax = rWin[pWin.indexOf(pMax)];
    return closes[i] >= pMax * 0.998 && rsi[14][i] != null && rAtMax != null && rsi[14][i] < rAtMax - 2;
  };
  ctx.macdBearDiv = (i, lookback = 26) => {
    if (i < lookback) return false;
    const pWin = closes.slice(i - lookback, i + 1);
    const hWin = hist.slice(i - lookback, i + 1);
    const pMax = Math.max(...pWin);
    const hAtMax = hWin[pWin.indexOf(pMax)];
    return closes[i] >= pMax * 0.998 && hist[i] != null && hAtMax != null && hist[i] < hAtMax;
  };
  ctx.stochCrossDown = (i) => stochRsi[i] != null && stochRsi[i - 1] != null && stochRsi[i] < stochRsi[i - 1] && stochRsi[i - 1] > 80;
  ctx.macdBearCross = (i) => macd[i] != null && signal[i] != null && macd[i - 1] != null && signal[i - 1] != null && macd[i] < signal[i] && macd[i - 1] >= signal[i - 1];
  ctx.momentumSlowHigh = (i) => newHigh52[i] && ret[4][i] != null && ret[4][i - 4] != null && ret[4][i] < ret[4][i - 4];
  ctx.volDownOnHigh = (i) => newHigh52[i] && relVol20[i] != null && relVol20[i - 1] != null && relVol20[i] < relVol20[i - 1] * 0.9;
  ctx.shootingStar = (i) => {
    const body = Math.abs(weeks[i].close - weeks[i].open);
    const range = weeks[i].high - weeks[i].low;
    const upper = weeks[i].high - Math.max(weeks[i].open, weeks[i].close);
    return range > 0 && upper / range > 0.5 && body / range < 0.35;
  };
  ctx.bearEngulf = (i) => i > 0 && weeks[i].close < weeks[i].open && weeks[i - 1].close > weeks[i - 1].open && weeks[i].open >= weeks[i - 1].close && weeks[i].close <= weeks[i - 1].open;
  ctx.longUpperWick = (i) => {
    const range = weeks[i].high - weeks[i].low;
    const upper = weeks[i].high - Math.max(weeks[i].open, weeks[i].close);
    return range > 0 && upper / range > 0.4;
  };
  ctx.closeFarFromHigh = (i) => {
    const range = weeks[i].high - weeks[i].low;
    return range > 0 && (weeks[i].high - weeks[i].close) / range > 0.35;
  };
  ctx.nh52WeakClose = (i) => newHigh52[i] && weeks[i].close < weeks[i].low + (weeks[i].high - weeks[i].low) * 0.45;
  ctx.vixLowRising = (i) => {
    if (vix[i] == null || i < 4) return false;
    const recent = vix.slice(Math.max(0, i - 4), i + 1).filter((v) => v != null);
    if (recent.length < 3) return false;
    const minV = Math.min(...recent);
    return minV < 16 && vix[i] > minV * 1.08;
  };
  ctx.s5thFall = (i, w) => {
    if (s5th[i] == null || i < w) return false;
    for (let k = 0; k < w; k++) {
      if (s5th[i - k] == null || s5th[i - k - 1] == null) return false;
      if (!(s5th[i - k] < s5th[i - k - 1])) return false;
    }
    return true;
  };
  ctx.s5thDiv = (i) => {
    if (s5th[i] == null || !newHigh52[i] || i < 8) return false;
    const prev = s5th.slice(Math.max(0, i - 8), i).filter((v) => v != null);
    if (!prev.length) return false;
    return s5th[i] < Math.max(...prev) * 0.95;
  };
  ctx.spyNoConfirm = (i) => newHigh52[i] && ret[8][i] != null && spyRet8[i] != null && ret[8][i] > 0.15 && spyRet8[i] < 0.08;
  ctx.seasonPos = (i) => {
    const m = weeks[i].month;
    return (m >= 4 && m <= 7) || (m >= 10 && m <= 12);
  };
  ctx.seasonNeg = (i) => weeks[i].month === 9 || weeks[i].month === 8;
  ctx.nearQuarterEnd = (i) => [3, 6, 9, 12].includes(weeks[i].month);
  ctx.regimeBullStrong = (i) => closes[i] > ma[200][i] && ma[200][i] > ma[200][Math.max(0, i - 4)];
  ctx.regimeStretched = (i) => ctx.pctAbove(50, i) > 0.15 && rsi[14][i] > 65;
  ctx.regimeDistribution = (i) => ctx.histFallWeeks(i, 3) && ctx.pctAbove(50, i) > 0.1;
  ctx.regimeVolatile = (i) => rvol[8][i] != null && rvol[8][i - 8] != null && rvol[8][i] > rvol[8][i - 8] * 1.25;

  return ctx;
}

function defineSignals(ctx) {
  const { weeks, closes, rsi, stochRsi, cci, hist, bb, ret, ma, newHigh52, relVol20, vix, s5th } = ctx;
  const signals = [];

  const add = (id, name, description, fn) => signals.push({ id, name, description, eval: fn });

  for (const th of [65, 70, 75, 80]) {
    add(`rsi14_gt_${th}`, `RSI14 > ${th}`, `RSI 14 weekly au-dessus de ${th}`, (i) => rsi[14][i] > th);
  }
  for (const th of [80, 90]) {
    add(`stochrsi_gt_${th}`, `StochRSI > ${th}`, `StochRSI weekly > ${th}`, (i) => stochRsi[i] > th);
  }
  for (const th of [100, 150, 200]) {
    add(`cci_gt_${th}`, `CCI > ${th}`, `CCI 20 weekly > ${th}`, (i) => cci[i] > th);
  }
  for (const th of [0.1, 0.15, 0.2, 0.25]) {
    const pct = Math.round(th * 100);
    add(`above_ma50_${pct}pct`, `Prix > MA50 +${pct}%`, `Extension au-dessus MA50 de plus de ${pct}%`, (i) => ctx.pctAbove(50, i) > th);
  }
  for (const th of [0.3, 0.4, 0.5, 0.7]) {
    const pct = Math.round(th * 100);
    add(`above_ma200_${pct}pct`, `Prix > MA200 +${pct}%`, `Extension MA200 > ${pct}%`, (i) => ctx.pctAbove(200, i) > th);
  }
  for (const [w, ths] of [
    [4, [0.1, 0.15, 0.2]],
    [8, [0.2, 0.25, 0.35]],
    [12, [0.3, 0.4, 0.5]],
  ]) {
    for (const th of ths) {
      const pct = Math.round(th * 100);
      add(`ret${w}w_gt_${pct}pct`, `Rendement ${w} sem. > ${pct}%`, `Momentum ${w} semaines > ${pct}%`, (i) => ret[w][i] > th);
    }
  }
  for (const w of [2, 3, 4]) {
    add(`macd_hist_fall_${w}w`, `MACD hist baisse ${w} sem.`, `Histogramme MACD baisse ${w} semaines consécutives`, (i) => ctx.histFallWeeks(i, w));
  }
  add("macd_bear_cross", "MACD croisement baissier", "MACD passe sous signal", (i) => ctx.macdBearCross(i));
  add("rsi_bear_div", "RSI divergence baissière", "Prix NH mais RSI plus bas", (i) => ctx.rsiBearDiv(i));
  add("macd_bear_div", "MACD divergence baissière", "Prix NH mais histogramme plus bas", (i) => ctx.macdBearDiv(i));
  add("nh52", "Nouveau haut 52 semaines", "Clôture au plus haut sur 52 semaines", (i) => newHigh52[i]);
  add("nh52_rsi_div", "NH52 + RSI divergence", "Nouveau haut 52s avec RSI divergence", (i) => newHigh52[i] && ctx.rsiBearDiv(i));
  add("nh52_macd_div", "NH52 + MACD divergence", "Nouveau haut 52s avec divergence MACD", (i) => newHigh52[i] && ctx.macdBearDiv(i));
  add("nh52_vol_down", "NH52 + volume rel. baisse", "Nouveau haut avec volume relatif en baisse", (i) => ctx.volDownOnHigh(i));
  add("nh52_momentum_slow", "NH52 + momentum ralentit", "Nouveau haut mais ROC 4s ralentit", (i) => ctx.momentumSlowHigh(i));
  add("momentum_slow_high", "Momentum ralentit près haut", "ROC 4s en décélération", (i) => ctx.momentumSlowHigh(i));
  add("price_above_bb_upper", "Prix > Bollinger sup.", "Clôture au-dessus bande supérieure (20,2)", (i) => bb.upper[i] != null && closes[i] > bb.upper[i]);
  add("long_upper_wick", "Longue mèche haute", "Mèche haute > 40% du range weekly", (i) => ctx.longUpperWick(i));
  add("shooting_star", "Shooting star weekly", "Pattern shooting star", (i) => ctx.shootingStar(i));
  add("bear_engulf", "Bearish engulfing", "Engulfing baissier weekly", (i) => ctx.bearEngulf(i));
  add("close_far_from_high", "Clôture loin du high", "Clôture dans le bas du range", (i) => ctx.closeFarFromHigh(i));
  add("nh52_weak_close", "NH52 + clôture faible", "Fait NH52 mais clôture faible", (i) => ctx.nh52WeakClose(i));
  add("vol_spike_1_5x", "Volume > 1.5x moy. 20s", "Volume relatif > 1.5", (i) => relVol20[i] > 1.5);
  add("vol_spike_2x", "Volume > 2x moy. 20s", "Volume relatif > 2", (i) => relVol20[i] > 2);
  add("vix_lt_12", "VIX < 12", "VIX très bas", (i) => vix[i] != null && vix[i] < 12);
  add("vix_lt_14", "VIX < 14", "VIX bas", (i) => vix[i] != null && vix[i] < 14);
  add("vix_lt_16", "VIX < 16", "VIX sous 16", (i) => vix[i] != null && vix[i] < 16);
  add("vix_low_rising", "VIX bas puis remonte", "VIX remonte depuis bas 4 sem.", (i) => ctx.vixLowRising(i));
  add("vix_mkt_div", "VIX divergence", "Marché fort mais VIX ne baisse plus", (i) => newHigh52[i] && vix[i] != null && i >= 8 && vix[i] >= vix[i - 8] * 0.95);
  add("consec_pos_4", "4 semaines vertes", "4 semaines haussières consécutives", (i) => ctx.consecPos[i] >= 4);
  add("consec_pos_6", "6 semaines vertes", "6 semaines haussières consécutives", (i) => ctx.consecPos[i] >= 6);
  add("no_touch_ma8_4w", "4 sem. sans toucher MA8", "Prix étiré — pas touché MA8 depuis 4 sem.", (i) => ctx.weeksSinceTouch.ma8[i] >= 4);
  add("no_touch_ma21_6w", "6 sem. sans toucher MA21", "Pas touché MA21 depuis 6 sem.", (i) => ctx.weeksSinceTouch.ma21[i] >= 6);
  add("vol_expand", "Expansion volatilité", "Vol réalisée 8s en hausse > 25%", (i) => ctx.regimeVolatile(i));
  add("vol_contract_extreme", "Contraction vol extrême", "Vol 8s < 50% vol 8s d'il y a 8 sem.", (i) => ctx.rvol[8][i] != null && ctx.rvol[8][i - 8] != null && ctx.rvol[8][i] < ctx.rvol[8][i - 8] * 0.5);
  add("regime_bull_strong", "Régime haussier fort", "Au-dessus MA200 montante", (i) => ctx.regimeBullStrong(i));
  add("regime_stretched", "Régime étiré", "> MA50 +15% et RSI>65", (i) => ctx.regimeStretched(i));
  add("regime_distribution", "Régime distribution", "Extension + MACD hist baisse 3s", (i) => ctx.regimeDistribution(i));
  add("season_apr_jul", "Saison avr-juil", "Mois avril à juillet", (i) => weeks[i].month >= 4 && weeks[i].month <= 7);
  add("season_oct_dec", "Saison oct-déc", "Mois octobre à décembre", (i) => weeks[i].month >= 10 && weeks[i].month <= 12);
  add("season_sep", "Septembre", "Mois septembre", (i) => weeks[i].month === 9);
  add("near_quarter_end", "Fin de trimestre", "Mois de fin de trimestre", (i) => ctx.nearQuarterEnd(i));

  if (s5th.some((v) => v != null)) {
    for (const w of [2, 3, 4]) {
      add(`s5th_fall_${w}w`, `S5TH baisse ${w} sem.`, `Breadth S5TH baisse ${w} semaines`, (i) => ctx.s5thFall(i, w));
    }
    add("s5th_div_nh", "S5TH divergence NH", "QQQ/TQQQ NH mais S5TH sous sommet récent", (i) => ctx.s5thDiv(i));
    add("nh52_s5th_div", "NH52 + S5TH divergence", "Nouveau haut avec breadth plus faible", (i) => newHigh52[i] && ctx.s5thDiv(i));
  }

  const combos = [
    ["combo_1", "RSI>70 + >MA50 15%", "RSI > 70 et prix > MA50 de 15%", (i) => rsi[14][i] > 70 && ctx.pctAbove(50, i) > 0.15],
    ["combo_2", "RSI>70 + MACD hist -3s", "RSI > 70 et MACD histogramme baisse 3 sem.", (i) => rsi[14][i] > 70 && ctx.histFallWeeks(i, 3)],
    ["combo_3", "RSI>70 + StochRSI cross down", "RSI > 70 et StochRSI croise vers le bas", (i) => rsi[14][i] > 70 && ctx.stochCrossDown(i)],
    ["combo_4", "RSI>70 + ret8>25%", "RSI > 70 et rendement 8 sem. > 25%", (i) => rsi[14][i] > 70 && ret[8][i] > 0.25],
    ["combo_5", ">MA50 20% + MACD hist baisse", "Prix > MA50 20% et MACD hist en baisse", (i) => ctx.pctAbove(50, i) > 0.2 && ctx.histFallWeeks(i, 2)],
    ["combo_6", ">MA50 20% + StochRSI cross", "Extension MA50 + StochRSI croisement baissier", (i) => ctx.pctAbove(50, i) > 0.2 && ctx.stochCrossDown(i)],
    ["combo_7", "NH52 + RSI divergence", "Nouveau haut 52s + divergence RSI", (i) => newHigh52[i] && ctx.rsiBearDiv(i)],
    ["combo_8", "NH52 + MACD divergence", "Nouveau haut 52s + divergence MACD", (i) => newHigh52[i] && ctx.macdBearDiv(i)],
    ["combo_9", "NH52 + vol rel baisse", "Nouveau haut 52s + volume relatif baisse", (i) => newHigh52[i] && ctx.volDownOnHigh(i)],
    ["combo_10", "NH52 + S5TH divergence", "Nouveau haut + breadth S5TH divergence", (i) => newHigh52[i] && ctx.s5thDiv(i)],
    ["combo_11", "RSI>70 + S5TH -3s", "RSI > 70 et S5TH baisse 3 semaines", (i) => rsi[14][i] > 70 && ctx.s5thFall(i, 3)],
    ["combo_12", "VIX bas + remonte", "VIX très bas puis remonte", (i) => ctx.vixLowRising(i)],
    ["combo_13", "Étiré + VIX remonte", "Prix étiré (>MA50 15%) + VIX remonte", (i) => ctx.pctAbove(50, i) > 0.15 && ctx.vixLowRising(i)],
    ["combo_14", "Étiré + breadth baisse", "Prix étiré + S5TH baisse 2 sem.", (i) => ctx.pctAbove(50, i) > 0.15 && ctx.s5thFall(i, 2)],
    ["combo_15", "Ret12 fort + RSI extrême", "Rendement 12s > 40% et RSI > 75", (i) => ret[12][i] > 0.4 && rsi[14][i] > 75],
    ["combo_16", "Saison+ + épuisement", "Saison positive + RSI>70 + >MA50 10%", (i) => ctx.seasonPos(i) && rsi[14][i] > 70 && ctx.pctAbove(50, i) > 0.1],
    ["combo_17", "Saison- + épuisement", "Saison négative + RSI>70 + MACD hist baisse", (i) => ctx.seasonNeg(i) && rsi[14][i] > 70 && ctx.histFallWeeks(i, 2)],
    ["combo_18", "NH + SPY/IWM pas confirmé", "Nouveau haut sans confirmation large", (i) => ctx.spyNoConfirm(i)],
    ["combo_19", "BB sup + RSI>70", "Au-dessus Bollinger + RSI > 70", (i) => bb.upper[i] != null && closes[i] > bb.upper[i] && rsi[14][i] > 70],
    ["combo_20", "Mèche haute + RSI>70", "Longue mèche haute + RSI > 70", (i) => ctx.longUpperWick(i) && rsi[14][i] > 70],
    ["combo_21", "CCI>200 + MACD hist baisse", "CCI extrême + MACD hist en baisse", (i) => cci[i] > 200 && ctx.histFallWeeks(i, 2)],
    ["combo_22", "StochRSI>90 + cross + étiré", "StochRSI > 90, cross down, > MA50 15%", (i) => stochRsi[i] > 90 && ctx.stochCrossDown(i) && ctx.pctAbove(50, i) > 0.15],
  ];

  for (const [id, name, desc, fn] of combos) {
    add(id, name, desc, fn);
  }

  return signals;
}

function evaluateSignal(weeks, signal, warmup = 52) {
  const events = [];
  const lastIdx = weeks.length - 17;
  for (let i = warmup; i <= lastIdx; i++) {
    if (!signal.eval(i)) continue;
    const w = weeks[i];
    events.push({
      date: w.date.toISOString().slice(0, 10),
      weekKey: w.key,
      close: w.close,
      isTopShort: w.isTopShort,
      isTopMedium: w.isTopMedium,
      isTopMajor: w.isTopMajor,
      isTopExtreme: w.isTopExtreme,
      future: w.future,
    });
  }

  const n = events.length;
  const rate = (key) => (n ? events.filter((e) => e[key]).length / n : null);
  const avg = (h, field) => {
    const vals = events.map((e) => e.future?.[field]?.[h]).filter((v) => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const worst = (h) => {
    const vals = events.map((e) => e.future?.maxDrop?.[h]).filter((v) => v != null);
    return vals.length ? Math.min(...vals) : null;
  };
  const avgDelay = (h) => {
    const vals = events.map((e) => e.future?.weeksToMaxDrop?.[h]).filter((v) => v != null);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };

  const falseSignals = events.filter(
    (e) => !e.isTopShort && !e.isTopMedium && !e.isTopMajor && !e.isTopExtreme,
  ).length;

  const sortedByDrop = [...events].sort(
    (a, b) => (a.future?.maxDrop?.[16] ?? 0) - (b.future?.maxDrop?.[16] ?? 0),
  );
  const topExamples = sortedByDrop.slice(0, 10).map((e) => ({
    date: e.date,
    close: e.close,
    maxDrop16w: e.future?.maxDrop?.[16],
    maxDrop12w: e.future?.maxDrop?.[12],
    isTopExtreme: e.isTopExtreme,
    isTopMajor: e.isTopMajor,
  }));

  const scoreHint =
    (rate("isTopMajor") ?? 0) * 35 +
    (rate("isTopMedium") ?? 0) * 25 +
    (rate("isTopShort") ?? 0) * 15 +
    (rate("isTopExtreme") ?? 0) * 15 -
    (n < 10 ? 0.15 : 0) +
    Math.min(0.1, Math.abs(avg(8, "maxDrop") ?? 0));

  return {
    id: signal.id,
    name: signal.name,
    description: signal.description,
    occurrences: n,
    lowSampleWarning: n < 10,
    rates: {
      topShort: rate("isTopShort"),
      topMedium: rate("isTopMedium"),
      topMajor: rate("isTopMajor"),
      topExtreme: rate("isTopExtreme"),
    },
    avgFutureDrop: {
      w4: avg(4, "maxDrop"),
      w8: avg(8, "maxDrop"),
      w12: avg(12, "maxDrop"),
      w16: avg(16, "maxDrop"),
    },
    avgForwardReturn: {
      w4: avg(4, "forwardReturn"),
      w8: avg(8, "forwardReturn"),
      w12: avg(12, "forwardReturn"),
      w16: avg(16, "forwardReturn"),
    },
    worstFutureDrop: { w4: worst(4), w8: worst(8), w12: worst(12), w16: worst(16) },
    avgWeeksToMaxDrop: { w4: avgDelay(4), w8: avgDelay(8), w12: avgDelay(12), w16: avgDelay(16) },
    falseSignals,
    eventDates: events.map((e) => e.date),
    topExamples,
    scoreHint,
  };
}

function computeTopRiskScore(weeks, ctx, signalResults, warmup = 52) {
  const eligible = signalResults
    .filter((s) => s.occurrences >= 8 && !s.lowSampleWarning)
    .sort((a, b) => b.scoreHint - a.scoreHint)
    .slice(0, 12);

  const idToFn = new Map();
  for (const s of defineSignals(ctx)) idToFn.set(s.id, s.eval);

  const weightTotal = eligible.reduce((s, r) => s + r.scoreHint, 0) || 1;
  const scores = [];

  for (let i = warmup; i < weeks.length - 17; i++) {
    const components = [];
    let raw = 0;
    for (const r of eligible) {
      const fn = idToFn.get(r.id);
      if (!fn?.(i)) continue;
      const w = r.scoreHint / weightTotal;
      const contrib = w * 100;
      raw += contrib;
      components.push({ signalId: r.id, name: r.name, weight: w, contribution: contrib });
    }
    const penalize = components.length < 2 ? raw * 0.6 : raw;
    const score = Math.max(0, Math.min(100, Math.round(penalize)));
    if (score >= 35) {
      scores.push({
        date: weeks[i].date.toISOString().slice(0, 10),
        weekKey: weeks[i].key,
        topRiskScore: score,
        components,
        futureMaxDrop16w: weeks[i].future?.maxDrop?.[16],
        isTopMajor: weeks[i].isTopMajor,
      });
    }
  }
  return { method: "weighted_top_signals_no_lookahead", eligibleSignals: eligible.map((e) => e.id), scores };
}

function pctFmt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

async function loadAuxiliaryData(weeks) {
  const loaded = {};
  const missing = [];
  const available = [];

  for (const [key, sym] of Object.entries(OPTIONAL_SYMBOLS)) {
    if (!sym) {
      missing.push(`${key} (pas de symbole Yahoo configuré)`);
      continue;
    }
    const res = await fetchExtendedHistory(sym);
    if (!res.rows) {
      missing.push(`${key} (${sym}): ${res.error ?? "indisponible"}`);
      continue;
    }
    loaded[key] = res.rows;
    available.push(`${key}:${sym} (${res.firstDate}→${res.lastDate})`);
    await new Promise((r) => setTimeout(r, 350));
  }

  const aux = {};
  if (loaded.VIX) aux.vix = alignSeriesToWeeks(weeks, loaded.VIX);
  if (loaded.S5TH) aux.s5th = alignSeriesToWeeks(weeks, loaded.S5TH);
  if (loaded.SPY) {
    const spyW = aggregateDailyToWeekly(loaded.SPY);
    const spyCloses = spyW.map((w) => w.close);
    const spyRet8 = new Array(weeks.length).fill(null);
    const spyByKey = new Map(spyW.map((w, idx) => [w.key, idx]));
    for (let i = 0; i < weeks.length; i++) {
      const si = spyByKey.get(weeks[i].key);
      if (si != null && si >= 8) spyRet8[i] = spyCloses[si] / spyCloses[si - 8] - 1;
    }
    aux.spyRet8 = spyRet8;
  }
  if (loaded.IWM) {
    const iwmW = aggregateDailyToWeekly(loaded.IWM);
    const iwmCloses = iwmW.map((w) => w.close);
    const iwmRet8 = new Array(weeks.length).fill(null);
    const iwmByKey = new Map(iwmW.map((w, idx) => [w.key, idx]));
    for (let i = 0; i < weeks.length; i++) {
      const si = iwmByKey.get(weeks[i].key);
      if (si != null && si >= 8) iwmRet8[i] = iwmCloses[si] / iwmCloses[si - 8] - 1;
    }
    aux.iwmRet8 = iwmRet8;
  }

  return { aux, missing, available };
}

async function runAuditForSeries(label, weeks, options = {}) {
  const thresholdProfile =
    THRESHOLD_PROFILES[options.thresholdProfile] ?? THRESHOLD_PROFILES.leveraged;
  const seriesRole = options.seriesRole ?? "comparison";
  const isPrimary = seriesRole === "primary";

  attachFutureLabels(weeks, thresholdProfile);
  const { aux, missing, available } = options.auxData ?? { aux: {}, missing: ["aux non chargé"], available: [] };
  const ctx = buildIndicatorState(weeks, aux);
  const signals = defineSignals(ctx);
  const signalResults = signals.map((s) => evaluateSignal(weeks, s));
  signalResults.sort((a, b) => b.scoreHint - a.scoreHint);
  const topRisk = computeTopRiskScore(weeks, ctx, signalResults);

  const baseline = {
    weeks: weeks.length - 69,
    topShort: weeks.filter((w, i) => i >= 52 && i < weeks.length - 17 && w.isTopShort).length,
    topMedium: weeks.filter((w, i) => i >= 52 && i < weeks.length - 17 && w.isTopMedium).length,
    topMajor: weeks.filter((w, i) => i >= 52 && i < weeks.length - 17 && w.isTopMajor).length,
    topExtreme: weeks.filter((w, i) => i >= 52 && i < weeks.length - 17 && w.isTopExtreme).length,
  };
  const evaluable = baseline.weeks;
  baseline.rates = {
    topShort: evaluable ? baseline.topShort / evaluable : null,
    topMedium: evaluable ? baseline.topMedium / evaluable : null,
    topMajor: evaluable ? baseline.topMajor / evaluable : null,
    topExtreme: evaluable ? baseline.topExtreme / evaluable : null,
  };

  return {
    label,
    seriesRole,
    isPrimary,
    thresholdProfile: thresholdProfile.id,
    thresholdsUsedBySeries: {
      profileId: thresholdProfile.id,
      short: thresholdProfile.short,
      medium: thresholdProfile.medium,
      major: thresholdProfile.major,
      extreme: thresholdProfile.extreme,
    },
    period: {
      first: weeks[0]?.date?.toISOString?.()?.slice(0, 10),
      last: weeks[weeks.length - 1]?.date?.toISOString?.()?.slice(0, 10),
      weeksAnalyzed: weeks.length,
      evaluableWeeks: evaluable,
    },
    baseline,
    signalsTested: signals.length,
    signalResults,
    topRisk,
    dataAvailability: { available, missing },
    lookaheadNote: "Indicateurs = données passées seulement. Labels tops = rendements futurs (max drawdown forward).",
  };
}

function signalSnapshot(sig) {
  if (!sig) return null;
  return {
    occurrences: sig.occurrences,
    topShortRate: sig.rates.topShort,
    topMediumRate: sig.rates.topMedium,
    topMajorRate: sig.rates.topMajor,
    topExtremeRate: sig.rates.topExtreme,
    avgDrop12w: sig.avgFutureDrop?.w12,
    scoreHint: sig.scoreHint,
    lowSampleWarning: sig.lowSampleWarning,
  };
}

function liftRate(signalRate, baselineRate) {
  if (signalRate == null || baselineRate == null) return null;
  return signalRate - baselineRate;
}

function deriveConcordanceVerdict(primarySig, primaryRun, compMap) {
  if (primarySig.occurrences < 10 || primarySig.lowSampleWarning) {
    return "Trop rare / non concluant";
  }

  const base = primaryRun.baseline.rates;
  const liftMajor = liftRate(primarySig.rates.topMajor, base.topMajor) ?? 0;
  const liftMedium = liftRate(primarySig.rates.topMedium, base.topMedium) ?? 0;

  const qqq = compMap.QQQ;
  const ndx = compMap.NDX;
  const syn = compMap.TQQQ_SYNTHETIC_3X_QQQ;

  const indexConfirms = [];
  for (const [name, run] of [["QQQ", qqq], ["NDX", ndx]]) {
    if (!run?.signal) continue;
    const s = run.signal;
    const b = run.baseline;
    if (s.occurrences < 8) continue;
    const mLift = liftRate(s.rates.topMedium, b.topMedium) ?? 0;
    const jLift = liftRate(s.rates.topMajor, b.topMajor) ?? 0;
    if (mLift >= 0.04 || jLift >= 0.03) indexConfirms.push(name);
  }

  let synConfirm = false;
  if (syn?.signal && syn.signal.occurrences >= 8) {
    const s = syn.signal;
    const b = syn.baseline;
    const sLift = liftRate(s.rates.topMajor, b.topMajor) ?? 0;
    if (sLift >= liftMajor * 0.5 - 0.02) synConfirm = true;
  }

  if (indexConfirms.length >= 2 || (indexConfirms.length === 1 && synConfirm)) {
    return "Confirmé par QQQ / Nasdaq";
  }
  if (indexConfirms.length === 1 || synConfirm) {
    return "Partiellement confirmé";
  }
  if (liftMajor >= 0.08 || liftMedium >= 0.1) {
    return "Spécifique au levier TQQQ";
  }
  return "Trop rare / non concluant";
}

function buildCrossSeriesValidation(primaryRun, comparisonRuns) {
  if (!primaryRun?.isPrimary) return [];

  const compByLabel = Object.fromEntries(comparisonRuns.map((r) => [r.label, r]));
  const topSignals = primaryRun.signalResults
    .filter((s) => s.occurrences >= 6)
    .sort((a, b) => b.scoreHint - a.scoreHint)
    .slice(0, 10);

  return topSignals.map((primarySig) => {
    const findSig = (run) => run?.signalResults?.find((s) => s.id === primarySig.id) ?? null;
    const qqqRun = compByLabel.QQQ;
    const ndxRun = compByLabel.NDX;
    const synRun = compByLabel.TQQQ_SYNTHETIC_3X_QQQ;

    const compMap = {
      QQQ: qqqRun ? { signal: findSig(qqqRun), baseline: qqqRun.baseline } : null,
      NDX: ndxRun ? { signal: findSig(ndxRun), baseline: ndxRun.baseline } : null,
      TQQQ_SYNTHETIC_3X_QQQ: synRun ? { signal: findSig(synRun), baseline: synRun.baseline } : null,
    };

    return {
      signalId: primarySig.id,
      signalName: primarySig.name,
      tqqqReal: signalSnapshot(primarySig),
      qqq: signalSnapshot(compMap.QQQ?.signal),
      ndx: signalSnapshot(compMap.NDX?.signal),
      synthetic: signalSnapshot(compMap.TQQQ_SYNTHETIC_3X_QQQ?.signal),
      concordanceVerdict: deriveConcordanceVerdict(primarySig, primaryRun, compMap),
    };
  });
}

function printCrossSeriesValidation(crossValidation, primaryRun) {
  console.log(`\n${"=".repeat(72)}`);
  console.log("VALIDATION INTER-SÉRIES");
  console.log(`${"=".repeat(72)}`);
  console.log(`Série principale : ${primaryRun.label} (${primaryRun.period.first} → ${primaryRun.period.last})`);
  console.log(`Seuils principaux : ${formatThresholdsSummary(THRESHOLD_PROFILES.leveraged)}`);
  console.log(`Seuils QQQ/NDX (comparaison) : ${formatThresholdsSummary(THRESHOLD_PROFILES.index)}`);

  for (const row of crossValidation) {
    console.log(`\n  ▶ ${row.signalName} (n=${row.tqqqReal?.occurrences ?? "—"})`);
    console.log(`    TQQQ réel  — majeur ${pctFmt(row.tqqqReal?.topMajorRate)} | moyen ${pctFmt(row.tqqqReal?.topMediumRate)} | score ${row.tqqqReal?.scoreHint?.toFixed?.(2) ?? "—"}`);
    console.log(`    QQQ        — majeur ${pctFmt(row.qqq?.topMajorRate)} | moyen ${pctFmt(row.qqq?.topMediumRate)} | n=${row.qqq?.occurrences ?? "—"}`);
    console.log(`    NDX        — majeur ${pctFmt(row.ndx?.topMajorRate)} | moyen ${pctFmt(row.ndx?.topMediumRate)} | n=${row.ndx?.occurrences ?? "—"}`);
    console.log(`    Synthétique— majeur ${pctFmt(row.synthetic?.topMajorRate)} | moyen ${pctFmt(row.synthetic?.topMediumRate)} | n=${row.synthetic?.occurrences ?? "—"}`);
    console.log(`    Verdict    : ${row.concordanceVerdict}`);
  }
}

function printConsoleReport(result) {
  const { label, period, baseline, signalResults, topRisk, dataAvailability, seriesRole, isPrimary, thresholdsUsedBySeries } = result;
  const profile = THRESHOLD_PROFILES[result.thresholdProfile] ?? THRESHOLD_PROFILES.leveraged;
  const roleLabel = isPrimary
    ? "SÉRIE PRINCIPALE"
    : seriesRole === "comparison"
      ? "SÉRIE DE COMPARAISON / VALIDATION"
      : "SÉRIE";

  console.log(`\n${"=".repeat(72)}`);
  console.log(`AUDIT TOP CORRÉLATION WEEKLY — ${label}`);
  console.log(`[${roleLabel}]`);
  console.log(`${"=".repeat(72)}`);
  if (isPrimary) {
    console.log(`Série principale : ${label}`);
    console.log(`Période : ${period.first} → ${period.last} (première donnée disponible → dernière)`);
  } else {
    console.log(`Période : ${period.first} → ${period.last}`);
  }
  console.log(`Seuils tops : ${formatThresholdsSummary(profile)}`);
  console.log(`Semaines : ${period.weeksAnalyzed} (évaluables : ${period.evaluableWeeks})`);
  console.log(`Signaux testés : ${result.signalsTested}`);
  console.log(`\nBaseline (sans signal) — taux de tops sur barres évaluables :`);
  console.log(`  Court (${(profile.short.threshold * 100).toFixed(0)}%/4s): ${pctFmt(baseline.rates.topShort)} (${baseline.topShort} cas)`);
  console.log(`  Moyen (${(profile.medium.threshold * 100).toFixed(0)}%/8s): ${pctFmt(baseline.rates.topMedium)} (${baseline.topMedium} cas)`);
  console.log(`  Majeur (${(profile.major.threshold * 100).toFixed(0)}%/12s): ${pctFmt(baseline.rates.topMajor)} (${baseline.topMajor} cas)`);
  console.log(`  Extrême (${(profile.extreme.threshold * 100).toFixed(0)}%/16s): ${pctFmt(baseline.rates.topExtreme)} (${baseline.topExtreme} cas)`);

  console.log(`\n── Top 15 signaux (scoreHint) ──`);
  for (const s of signalResults.slice(0, 15)) {
    const warn = s.lowSampleWarning ? " ⚠ <10 occurrences" : "";
    console.log(
      `\n  ${s.name}${warn} (n=${s.occurrences})`,
    );
    console.log(
      `    Tops: court ${pctFmt(s.rates.topShort)} | moyen ${pctFmt(s.rates.topMedium)} | majeur ${pctFmt(s.rates.topMajor)} | extrême ${pctFmt(s.rates.topExtreme)}`,
    );
    console.log(
      `    Baisse moy. max: 4s=${pctFmt(s.avgFutureDrop.w4)} 8s=${pctFmt(s.avgFutureDrop.w8)} 12s=${pctFmt(s.avgFutureDrop.w12)} 16s=${pctFmt(s.avgFutureDrop.w16)}`,
    );
    console.log(`    Faux signaux: ${s.falseSignals} | Pire 16s: ${pctFmt(s.worstFutureDrop.w16)}`);
  }

  console.log(`\n── TopRiskScore (expérimental) ──`);
  console.log(`  Signaux pondérés: ${topRisk.eligibleSignals.join(", ") || "aucun"}`);
  const highScores = topRisk.scores.filter((x) => x.topRiskScore >= 60).slice(-5);
  if (highScores.length) {
    console.log("  Derniers scores élevés (≥60):");
    for (const h of highScores) {
      console.log(`    ${h.date} score=${h.topRiskScore} drop16s=${pctFmt(h.futureMaxDrop16w)} majeur=${h.isTopMajor ? "oui" : "non"}`);
    }
  }

  console.log(`\n── Données auxiliaires ──`);
  console.log(`  Disponibles: ${dataAvailability.available.length ? dataAvailability.available.join("; ") : "aucune"}`);
  console.log(`  Manquantes: ${dataAvailability.missing.length ? dataAvailability.missing.join("; ") : "aucune"}`);
}

function writeOutputs(primaryTicker, results) {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `top-correlation-weekly-${primaryTicker}-${ts}`;

  const jsonPath = path.join(DEBUG_DIR, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf8");

  const summaryRows = [];
  for (const r of results.runs) {
    for (const s of r.signalResults) {
      summaryRows.push({
        series: r.label,
        seriesRole: r.seriesRole,
        isPrimary: r.isPrimary,
        thresholdProfile: r.thresholdProfile,
        signalId: s.id,
        signalName: s.name,
        occurrences: s.occurrences,
        lowSampleWarning: s.lowSampleWarning,
        topShortRate: s.rates.topShort,
        topMediumRate: s.rates.topMedium,
        topMajorRate: s.rates.topMajor,
        topExtremeRate: s.rates.topExtreme,
        avgDrop4w: s.avgFutureDrop.w4,
        avgDrop8w: s.avgFutureDrop.w8,
        avgDrop12w: s.avgFutureDrop.w12,
        avgDrop16w: s.avgFutureDrop.w16,
        falseSignals: s.falseSignals,
        scoreHint: s.scoreHint,
        periodFirst: r.period.first,
        periodLast: r.period.last,
      });
    }
  }

  const crossRows = (results.crossSeriesValidation ?? []).map((row) => ({
    signalId: row.signalId,
    signalName: row.signalName,
    concordanceVerdict: row.concordanceVerdict,
    tqqqMajor: row.tqqqReal?.topMajorRate,
    qqqMajor: row.qqq?.topMajorRate,
    ndxMajor: row.ndx?.topMajorRate,
    syntheticMajor: row.synthetic?.topMajorRate,
    tqqqOccurrences: row.tqqqReal?.occurrences,
  }));
  if (crossRows.length) {
    const crossPath = path.join(DEBUG_DIR, `${base}-cross-validation.csv`);
    const crossHeader = Object.keys(crossRows[0]).join(",");
    const crossBody = crossRows.map((row) => Object.values(row).map((v) => (v == null ? "" : String(v))).join(",")).join("\n");
    fs.writeFileSync(crossPath, `${crossHeader}\n${crossBody}`, "utf8");
  }

  const csvHeader = Object.keys(summaryRows[0] ?? {}).join(",");
  const csvBody = summaryRows.map((row) => Object.values(row).map((v) => (v == null ? "" : String(v))).join(",")).join("\n");
  const csvPath = path.join(DEBUG_DIR, `${base}-summary.csv`);
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvBody}`, "utf8");

  const eventRows = [];
  for (const r of results.runs) {
    for (const s of r.signalResults) {
      for (const d of s.eventDates ?? []) {
        eventRows.push({ series: r.label, signalId: s.id, date: d });
      }
    }
  }
  const eventsPath = path.join(DEBUG_DIR, `${base}-events.csv`);
  fs.writeFileSync(eventsPath, `series,signalId,date\n${eventRows.map((e) => `${e.series},${e.signalId},${e.date}`).join("\n")}`, "utf8");

  return { jsonPath, csvPath, eventsPath };
}

async function fetchNdxHistory() {
  for (const sym of ["^NDX", "NDX"]) {
    const res = await fetchExtendedHistory(sym);
    if (res.rows) return { ...res, symbol: sym, label: "NDX" };
  }
  return { label: "NDX", rows: null, error: "NDX / ^NDX indisponible" };
}

async function main() {
  console.log("=== AUDIT TOP CORRÉLATION WEEKLY ===");
  console.log(`Ticker demandé: ${PRIMARY_TICKER}`);
  console.log("Note: pas de lookahead sur indicateurs — labels tops = futur seulement.\n");

  const sharedAuxCache = new Map();
  async function getAuxForWeeks(weeks) {
    const k = weeks[0]?.key + "|" + weeks.length;
    if (!sharedAuxCache.has(k)) {
      sharedAuxCache.set(k, await loadAuxiliaryData(weeks));
    }
    return sharedAuxCache.get(k);
  }

  const runs = [];
  const comparisonRuns = [];
  let primaryRun = null;

  if (PRIMARY_TICKER === "TQQQ") {
    const tqqqRes = await fetchExtendedHistory("TQQQ");
    if (!tqqqRes.rows) {
      console.error("TQQQ réel requis — échec:", tqqqRes.error);
      process.exit(1);
    }
    console.log(
      `TQQQ réel: ${tqqqRes.rowCount} jours (${tqqqRes.firstDate} → ${tqqqRes.lastDate}) [${tqqqRes.source ?? "yahoo"}]`,
    );

    const tqqqWeeks = aggregateDailyToWeekly(tqqqRes.rows);
    if (tqqqWeeks.length < MIN_WEEKS) {
      console.error("Historique TQQQ réel insuffisant");
      process.exit(1);
    }

    const tqqqAux = await getAuxForWeeks(tqqqWeeks);
    primaryRun = await runAuditForSeries("TQQQ_REAL", tqqqWeeks, {
      auxData: tqqqAux,
      seriesRole: "primary",
      thresholdProfile: "leveraged",
    });
    runs.push(primaryRun);
    printConsoleReport(primaryRun);

    const qqqRes = await fetchExtendedHistory("QQQ");
    if (qqqRes.rows) {
      console.log(`\nQQQ (comparaison/proxy depuis 2008): ${qqqRes.firstDate} → ${qqqRes.lastDate}`);
      const qqqWeeks = aggregateDailyToWeekly(qqqRes.rows);
      const qqqAux = await getAuxForWeeks(qqqWeeks);
      const qqqAudit = await runAuditForSeries("QQQ", qqqWeeks, {
        auxData: qqqAux,
        seriesRole: "comparison",
        thresholdProfile: "index",
      });
      runs.push(qqqAudit);
      comparisonRuns.push(qqqAudit);
      printConsoleReport(qqqAudit);

      const synDaily = buildSyntheticTqqqDaily(qqqRes.rows);
      const synWeeks = aggregateDailyToWeekly(synDaily);
      const synAudit = await runAuditForSeries("TQQQ_SYNTHETIC_3X_QQQ", synWeeks, {
        auxData: qqqAux,
        seriesRole: "comparison",
        thresholdProfile: "leveraged",
      });
      runs.push(synAudit);
      comparisonRuns.push(synAudit);
      printConsoleReport(synAudit);
    } else {
      console.warn("QQQ comparaison indisponible:", qqqRes.error);
    }

    const ndxRes = await fetchNdxHistory();
    if (ndxRes.rows) {
      console.log(`\nNDX (validation Nasdaq 100): ${ndxRes.firstDate} → ${ndxRes.lastDate} [${ndxRes.symbol}]`);
      const ndxWeeks = aggregateDailyToWeekly(ndxRes.rows);
      const ndxAux = await getAuxForWeeks(ndxWeeks);
      const ndxAudit = await runAuditForSeries("NDX", ndxWeeks, {
        auxData: ndxAux,
        seriesRole: "comparison",
        thresholdProfile: "index",
      });
      runs.push(ndxAudit);
      comparisonRuns.push(ndxAudit);
      printConsoleReport(ndxAudit);
    } else {
      console.warn("NDX comparaison indisponible:", ndxRes.error);
    }
  } else if (PRIMARY_TICKER === "QQQ") {
    const qqqRes = await fetchExtendedHistory("QQQ");
    if (!qqqRes.rows) {
      console.error("QQQ requis — échec:", qqqRes.error);
      process.exit(1);
    }
    console.log(`QQQ: ${qqqRes.rowCount} jours (${qqqRes.firstDate} → ${qqqRes.lastDate})`);

    const qqqWeeks = aggregateDailyToWeekly(qqqRes.rows);
    if (qqqWeeks.length < MIN_WEEKS) {
      console.error("Historique QQQ insuffisant");
      process.exit(1);
    }
    const qqqAux = await getAuxForWeeks(qqqWeeks);
    primaryRun = await runAuditForSeries("QQQ", qqqWeeks, {
      auxData: qqqAux,
      seriesRole: "primary",
      thresholdProfile: "index",
    });
    runs.push(primaryRun);
    printConsoleReport(primaryRun);

    const ndxRes = await fetchNdxHistory();
    if (ndxRes.rows) {
      const ndxWeeks = aggregateDailyToWeekly(ndxRes.rows);
      const ndxAux = await getAuxForWeeks(ndxWeeks);
      const ndxAudit = await runAuditForSeries("NDX", ndxWeeks, {
        auxData: ndxAux,
        seriesRole: "comparison",
        thresholdProfile: "index",
      });
      runs.push(ndxAudit);
      comparisonRuns.push(ndxAudit);
      printConsoleReport(ndxAudit);
    }

    const synDaily = buildSyntheticTqqqDaily(qqqRes.rows);
    const synWeeks = aggregateDailyToWeekly(synDaily);
    const synAudit = await runAuditForSeries("TQQQ_SYNTHETIC_3X_QQQ", synWeeks, {
      auxData: qqqAux,
      seriesRole: "comparison",
      thresholdProfile: "leveraged",
    });
    runs.push(synAudit);
    comparisonRuns.push(synAudit);
    printConsoleReport(synAudit);
  } else {
    const res = await fetchExtendedHistory(PRIMARY_TICKER);
    if (!res.rows) {
      console.error(`${PRIMARY_TICKER} indisponible:`, res.error);
      process.exit(1);
    }
    const weeks = aggregateDailyToWeekly(res.rows);
    const aux = await getAuxForWeeks(weeks);
    const profile = PRIMARY_TICKER === "TQQQ" ? "leveraged" : "index";
    primaryRun = await runAuditForSeries(PRIMARY_TICKER, weeks, {
      auxData: aux,
      seriesRole: "primary",
      thresholdProfile: profile,
    });
    runs.push(primaryRun);
    printConsoleReport(primaryRun);
  }

  const crossSeriesValidation = primaryRun
    ? buildCrossSeriesValidation(primaryRun, comparisonRuns)
    : [];

  if (crossSeriesValidation.length) {
    printCrossSeriesValidation(crossSeriesValidation, primaryRun);
  }

  const recommendations = buildRecommendations(primaryRun, comparisonRuns);
  const primarySeries = primaryRun
    ? {
        label: primaryRun.label,
        role: "primary",
        period: primaryRun.period,
        thresholdProfile: primaryRun.thresholdProfile,
        thresholdsUsedBySeries: primaryRun.thresholdsUsedBySeries,
      }
    : null;

  const comparisonSeries = comparisonRuns.map((r) => ({
    label: r.label,
    role: COMPARISON_SERIES_LABELS[r.label]?.role ?? "comparison",
    period: r.period,
    thresholdProfile: r.thresholdProfile,
    thresholdsUsedBySeries: r.thresholdsUsedBySeries,
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    primaryTicker: PRIMARY_TICKER,
    primarySeries,
    comparisonSeries,
    thresholdsUsedBySeries: {
      leveraged: THRESHOLD_PROFILES.leveraged,
      index: THRESHOLD_PROFILES.index,
    },
    crossSeriesValidation,
    recommendations,
    runs: runs.map((r) => ({
      label: r.label,
      seriesRole: r.seriesRole,
      isPrimary: r.isPrimary,
      thresholdProfile: r.thresholdProfile,
      thresholdsUsedBySeries: r.thresholdsUsedBySeries,
      period: r.period,
      baseline: r.baseline,
      signalsTested: r.signalsTested,
      lookaheadNote: r.lookaheadNote,
      dataAvailability: r.dataAvailability,
      topRisk: r.topRisk,
      signalResults: r.signalResults,
    })),
    top10PrimarySignals: primaryRun
      ? primaryRun.signalResults
          .filter((s) => s.occurrences >= 6)
          .sort((a, b) => b.scoreHint - a.scoreHint)
          .slice(0, 10)
          .map((s) => ({ id: s.id, name: s.name, scoreHint: s.scoreHint, occurrences: s.occurrences, rates: s.rates }))
      : [],
  };

  const paths = writeOutputs(PRIMARY_TICKER, output);
  console.log(`\n${"=".repeat(72)}`);
  console.log("FICHIERS ÉCRITS");
  console.log(`  JSON: ${paths.jsonPath}`);
  console.log(`  CSV résumé: ${paths.csvPath}`);
  console.log(`  CSV événements: ${paths.eventsPath}`);
  if (crossSeriesValidation.length) {
    console.log(`  CSV validation inter-séries: debug/top-correlation-weekly-${PRIMARY_TICKER}-*-cross-validation.csv`);
  }
  console.log("\n── Recommandations (classement = série principale) ──");
  for (const line of recommendations.summary) console.log(`  ${line}`);
}

function buildRecommendations(primaryRun, comparisonRuns = []) {
  const integrate = [];
  const weak = [];
  const external = [
    "Breadth S&P500 (% > MA50 / MA200) — non disponible via Yahoo simple",
    "Fear & Greed CNN, AAII, NAAIM — pas dans le repo",
    "VVIX, put/call — symboles Yahoo parfois instables",
    "Fed balance sheet / CPI — hors scope v1",
  ];

  if (!primaryRun) return { summary: ["Aucun run"], integrate, weak, external };

  const cross = buildCrossSeriesValidation(primaryRun, comparisonRuns);
  const confirmed = cross.filter((c) => c.concordanceVerdict === "Confirmé par QQQ / Nasdaq");

  const baselineMajor = primaryRun.baseline.rates.topMajor ?? 0;
  for (const s of primaryRun.signalResults) {
    if (s.occurrences < 10) continue;
    const lift = (s.rates.topMajor ?? 0) - baselineMajor;
    const crossRow = cross.find((c) => c.signalId === s.id);
    const verdict = crossRow?.concordanceVerdict;
    if (lift >= 0.08 && s.occurrences >= 12) {
      integrate.push({
        id: s.id,
        name: s.name,
        liftMajor: lift,
        n: s.occurrences,
        concordanceVerdict: verdict ?? "—",
      });
    } else if ((s.rates.topMajor ?? 0) < baselineMajor * 1.05 && s.occurrences >= 15) {
      weak.push({ id: s.id, name: s.name, n: s.occurrences });
    }
  }

  integrate.sort((a, b) => b.liftMajor - a.liftMajor);
  weak.sort((a, b) => a.n - b.n);

  const summary = [
    `Série principale: ${primaryRun.label} (${primaryRun.period.first} → ${primaryRun.period.last})`,
    `Seuils principaux: ${formatThresholdsSummary(THRESHOLD_PROFILES[primaryRun.thresholdProfile])}`,
    `Comparaisons: ${comparisonRuns.map((r) => r.label).join(", ") || "aucune"}`,
    `Signaux forts (TQQQ/QQQ principal): ${integrate.slice(0, 5).map((x) => x.name).join(", ") || "voir JSON"}`,
    `Confirmés QQQ/Nasdaq: ${confirmed.slice(0, 3).map((x) => x.signalName).join(", ") || "—"}`,
    `Signaux faibles: ${weak.slice(0, 3).map((x) => x.name).join(", ") || "—"}`,
  ];

  return { summary, integrate: integrate.slice(0, 10), weak: weak.slice(0, 10), external, crossConfirmed: confirmed };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
