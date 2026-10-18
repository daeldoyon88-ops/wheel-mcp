/**
 * Audit de CONFLUENCE TECHNIQUE autour des flèches jaunes PERSONNELLES de l'utilisateur (TQQQ).
 * Audit SEULEMENT — ne touche à rien d'autre (dashboard, Wheel, SAFE/AGG, IBKR, Journal POP, Pine).
 *
 * Différence clé vs scripts/auditManualYellowArrowCorrelation.mjs :
 *   - Ici les flèches sont APPROXIMATIVES (relevées visuellement sur TradingView).
 *   - On analyse une FENÊTRE [date - toleranceDays ; date + toleranceDays] autour de chaque flèche,
 *     pas une date exacte. On cherche le JOUR de meilleure confluence TOP (et BOTTOM) dans la fenêtre.
 *   - Le Pine (debug/TQQQ_Top_Risk_Live_Final.pine) n'est PAS utilisé comme source des flèches.
 *
 * Sources lues :
 *   - debug/ohlc-cache-<TICKER>.json
 *   - debug/manual-yellow-arrow-dates-<TICKER>.csv  (colonnes: date,note,toleranceDays ; toleranceDays optionnel)
 *
 * Sorties :
 *   - debug/manual-arrow-technical-confluence-audit.md
 *   - debug/manual-arrow-technical-confluence-audit.json
 *
 * Usage : node scripts/auditTechnicalConfluenceAroundManualArrows.mjs [TQQQ]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEBUG_DIR = path.join(ROOT, "debug");

const CLI = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const TICKER = (CLI[0] ?? "TQQQ").trim().toUpperCase();

const DEFAULT_TOLERANCE_DAYS = 10;
const HORIZONS = [5, 10, 20, 40];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Seuils d'interprétation
const NEAR_PEAK_TOL = 0.03;       // close à <=3% du high 20j => "près d'un sommet local"
const TOO_LATE_DROP = 0.05;       // déjà -5%+ du high 20j à la date du signal => "trop tard"
const TOP_SCORE_CAPTURE = 45;     // score TOP >= ce seuil => "signal actionnable"
const SIGNAL_PRESENCE_AT_TOP = 0.4; // un signal présent dans >=40% des flèches = "récurrent"

// ── utils ────────────────────────────────────────────────────────────────────
const round2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const round4 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
function pct(n) { return n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`; }
function avg(arr) { const v = arr.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }

// ── CSV ──────────────────────────────────────────────────────────────────────
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
  const lines = content.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] ?? "").trim(); });
    rows.push(row);
  }
  return rows;
}

function cacheFile(symbol) {
  return path.join(DEBUG_DIR, `ohlc-cache-${String(symbol).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function loadBars(symbol) {
  const p = cacheFile(symbol);
  if (!fs.existsSync(p)) return null;
  try {
    const rows = JSON.parse(fs.readFileSync(p, "utf8")).rows ?? [];
    const bars = rows
      .map((r) => ({
        date: isoDay(r.date), t: new Date(r.date).getTime(),
        open: +r.open, high: +r.high, low: +r.low, close: +r.close,
        volume: r.volume == null ? null : +r.volume,
      }))
      .filter((r) => r.close > 0 && Number.isFinite(r.t))
      .sort((a, b) => a.t - b.t);
    return bars.length >= 250 ? bars : null;
  } catch { return null; }
}

function loadArrows(symbol) {
  const p = path.join(DEBUG_DIR, `manual-yellow-arrow-dates-${symbol}.csv`);
  if (!fs.existsSync(p)) return { path: null, arrows: [], ignored: [] };
  const rows = parseCsv(fs.readFileSync(p, "utf8"));
  const arrows = [], ignored = [];
  for (const r of rows) {
    const raw = (r.date ?? "").trim();
    if (!DATE_RE.test(raw)) { if (raw) ignored.push(raw); continue; }
    let tol = Number(r.toleranceDays);
    if (!Number.isFinite(tol) || tol <= 0) tol = DEFAULT_TOLERANCE_DAYS;
    arrows.push({ date: raw, note: (r.note ?? "").trim(), toleranceDays: Math.round(tol) });
  }
  arrows.sort((a, b) => a.date.localeCompare(b.date));
  return { path: p, arrows, ignored };
}

// ── Indicateurs (séries indexées par barre) ──────────────────────────────────
function sma(vals, len) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= len) sum -= vals[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}
function ema(vals, len) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    if (i < len - 1) continue;
    if (prev == null) { // seed avec SMA
      let s = 0; for (let j = i - len + 1; j <= i; j++) s += vals[j];
      prev = s / len;
    } else {
      prev = vals[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}
function rollingStd(vals, len) {
  const out = new Array(vals.length).fill(null);
  for (let i = len - 1; i < vals.length; i++) {
    let m = 0; for (let j = i - len + 1; j <= i; j++) m += vals[j]; m /= len;
    let v = 0; for (let j = i - len + 1; j <= i; j++) v += (vals[j] - m) ** 2;
    out[i] = Math.sqrt(v / len);
  }
  return out;
}
function rsi(closes, len = 14) {
  const out = new Array(closes.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= len) { avgG += g; avgL += l; if (i === len) { avgG /= len; avgL /= len; out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); } }
    else { avgG = (avgG * (len - 1) + g) / len; avgL = (avgL * (len - 1) + l) / len; out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL); }
  }
  return out;
}
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const lineVals = line.map((v) => (v == null ? 0 : v));
  const firstIdx = line.findIndex((v) => v != null);
  const sigRaw = ema(lineVals, sig);
  const signal = line.map((v, i) => (i >= firstIdx + sig - 1 && v != null ? sigRaw[i] : null));
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}
function atr(bars, len = 14) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    if (i < len) { if (i === len - 1) { let s = 0; for (let j = 0; j < len; j++) s += tr[j]; prev = s / len; out[i] = prev; } continue; }
    prev = (prev * (len - 1) + tr[i]) / len;
    out[i] = prev;
  }
  return out;
}
function rollingMax(vals, len) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) { const s = Math.max(0, i - len + 1); let m = -Infinity; for (let j = s; j <= i; j++) m = Math.max(m, vals[j]); out[i] = m; }
  return out;
}
function rollingMin(vals, len) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) { const s = Math.max(0, i - len + 1); let m = Infinity; for (let j = s; j <= i; j++) m = Math.min(m, vals[j]); out[i] = m; }
  return out;
}

function computeIndicators(bars) {
  const close = bars.map((b) => b.close);
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const vol = bars.map((b) => b.volume ?? 0);

  const ind = {
    sma8: sma(close, 8), sma21: sma(close, 21), sma34: sma(close, 34), sma50: sma(close, 50), sma200: sma(close, 200),
    ema8: ema(close, 8), ema21: ema(close, 21), ema34: ema(close, 34), ema50: ema(close, 50), ema200: ema(close, 200),
    rsi14: rsi(close, 14),
    atr14: atr(bars, 14),
    volAvg20: sma(vol, 20), volAvg65: sma(vol, 65),
    bbMid: sma(close, 20), bbStd: rollingStd(close, 20),
    high5: rollingMax(high, 5), high10: rollingMax(high, 10), high20: rollingMax(high, 20),
    low5: rollingMin(low, 5), low10: rollingMin(low, 10), low20: rollingMin(low, 20),
  };
  const m = macd(close, 12, 26, 9);
  ind.macdLine = m.line; ind.macdSignal = m.signal; ind.macdHist = m.hist;

  // StochRSI 14
  const rmax = rollingMax(ind.rsi14.map((v) => (v == null ? -Infinity : v)), 14);
  const rmin = rollingMin(ind.rsi14.map((v) => (v == null ? Infinity : v)), 14);
  ind.stochRsi = ind.rsi14.map((v, i) => {
    if (v == null || rmax[i] == null || rmin[i] == null || !Number.isFinite(rmax[i]) || !Number.isFinite(rmin[i]) || rmax[i] === rmin[i]) return null;
    return (v - rmin[i]) / (rmax[i] - rmin[i]);
  });

  // Bollinger 20,2
  ind.bbUpper = close.map((_, i) => (ind.bbMid[i] != null && ind.bbStd[i] != null ? ind.bbMid[i] + 2 * ind.bbStd[i] : null));
  ind.bbLower = close.map((_, i) => (ind.bbMid[i] != null && ind.bbStd[i] != null ? ind.bbMid[i] - 2 * ind.bbStd[i] : null));

  return ind;
}

function slope(series, i, lag) {
  if (i - lag < 0) return null;
  const a = series[i], b = series[i - lag];
  if (a == null || b == null || b === 0) return null;
  return a / b - 1;
}

/**
 * Construit l'objet de signaux booléens + scores TOP/BOTTOM pour une barre i.
 */
function signalsAt(bars, ind, i) {
  const b = bars[i], c = b.close;
  const prev = i > 0 ? bars[i - 1] : null;
  const g = (s) => (s[i] == null ? null : s[i]);
  const gp = (s) => (i > 0 && s[i - 1] != null ? s[i - 1] : null);

  const rsiV = g(ind.rsi14), rsiP = gp(ind.rsi14);
  const histV = g(ind.macdHist), histP = gp(ind.macdHist);
  const macdV = g(ind.macdLine), macdSig = g(ind.macdSignal);
  const macdVp = gp(ind.macdLine), macdSigP = gp(ind.macdSignal);
  const ema8 = g(ind.ema8), ema21 = g(ind.ema21), ema34 = g(ind.ema34), ema50 = g(ind.ema50), ema200 = g(ind.ema200);
  const sma50 = g(ind.sma50), sma200 = g(ind.sma200);
  const atrV = g(ind.atr14);
  const volAvg20 = g(ind.volAvg20), volAvg65 = g(ind.volAvg65);
  const bbU = g(ind.bbUpper), bbL = g(ind.bbLower), bbUp = gp(ind.bbUpper), bbLp = gp(ind.bbLower);
  const distMA50 = sma50 ? c / sma50 - 1 : null;
  const distMA200 = sma200 ? c / sma200 - 1 : null;

  // ATR % et expansion (ATR vs sa moyenne 20)
  let atrExpand = null, atrPct = null;
  if (atrV != null && c) {
    atrPct = atrV / c;
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 20); j < i; j++) { if (ind.atr14[j] != null) { s += ind.atr14[j]; n++; } }
    if (n) atrExpand = atrV > (s / n) * 1.1; // ATR >10% au-dessus de sa moyenne 20
  }
  const rangePct = c ? (b.high - b.low) / c : null;

  // structure
  const high20 = g(ind.high20), low20 = g(ind.low20);
  const ddFromHigh20 = high20 ? 1 - c / high20 : null;
  const rallyFromLow20 = low20 ? c / low20 - 1 : null;
  const isLocalTop10 = g(ind.high10) != null && b.high >= g(ind.high10) - 1e-9;
  const isLocalTop20 = high20 != null && b.high >= high20 - 1e-9;
  const isLocalBot10 = g(ind.low10) != null && b.low <= g(ind.low10) + 1e-9;
  const isLocalBot20 = low20 != null && b.low <= low20 + 1e-9;
  const breakLow5 = prev && g(ind.low5) != null && b.low < gp(ind.low5);  // low casse le plus-bas 5j précédent
  const breakLow10 = prev && g(ind.low10) != null && b.low < gp(ind.low10);
  const breakHigh5 = prev && g(ind.high5) != null && b.high > gp(ind.high5);
  const breakHigh10 = prev && g(ind.high10) != null && b.high > gp(ind.high10);

  const ret = (n) => (i - n >= 0 ? c / bars[i - n].close - 1 : null);

  // sur-extension récente (sert au signal "prix repasse sous EMA8 après excès")
  let recentOverext = false;
  for (let j = Math.max(0, i - 5); j <= i; j++) {
    if (ind.sma50[j] != null && bars[j].close / ind.sma50[j] - 1 > 0.15) { recentOverext = true; break; }
  }

  // ── Signaux booléens ──
  const s = {
    // tendance
    aboveMA8: ema8 != null ? c > ema8 : null,
    aboveMA21: ema21 != null ? c > ema21 : null,
    aboveMA34: ema34 != null ? c > ema34 : null,
    aboveMA50: ema50 != null ? c > ema50 : null,
    aboveMA200: ema200 != null ? c > ema200 : null,
    ema8SlopeUp: slope(ind.ema8, i, 3) != null ? slope(ind.ema8, i, 3) > 0 : null,
    ema21SlopeUp: slope(ind.ema21, i, 3) != null ? slope(ind.ema21, i, 3) > 0 : null,
    ema50SlopeUp: slope(ind.ema50, i, 5) != null ? slope(ind.ema50, i, 5) > 0 : null,
    // momentum
    rsiOver70: rsiV != null ? rsiV > 70 : null,
    rsiUnder30: rsiV != null ? rsiV < 30 : null,
    rsiCrossDown70: rsiV != null && rsiP != null ? (rsiP >= 70 && rsiV < 70) : null,
    rsiCrossUp30: rsiV != null && rsiP != null ? (rsiP <= 30 && rsiV > 30) : null,
    rsiSlope3Down: slope(ind.rsi14, i, 3) != null ? slope(ind.rsi14, i, 3) < 0 : null,
    rsiSlope3Up: slope(ind.rsi14, i, 3) != null ? slope(ind.rsi14, i, 3) > 0 : null,
    macdHistFalling: histV != null && histP != null ? histV < histP : null,
    macdHistRising: histV != null && histP != null ? histV > histP : null,
    macdBearishCross: macdV != null && macdSig != null && macdVp != null && macdSigP != null ? (macdVp >= macdSigP && macdV < macdSig) : null,
    macdBullishCross: macdV != null && macdSig != null && macdVp != null && macdSigP != null ? (macdVp <= macdSigP && macdV > macdSig) : null,
    stochRsiOverbought: g(ind.stochRsi) != null ? g(ind.stochRsi) > 0.8 : null,
    stochRsiOversold: g(ind.stochRsi) != null ? g(ind.stochRsi) < 0.2 : null,
    // volatilité / volume
    atrExpansion: atrExpand,
    volSpike20: volAvg20 ? b.volume / volAvg20 > 1.5 : null,
    redHighVol: volAvg20 ? (b.close < b.open && b.volume > volAvg20 * 1.5) : null,
    greenHighVol: volAvg20 ? (b.close > b.open && b.volume > volAvg20 * 1.5) : null,
    volAbove65: volAvg65 ? b.volume > volAvg65 : null,
    // structure
    localTop10: isLocalTop10, localTop20: isLocalTop20,
    localBot10: isLocalBot10, localBot20: isLocalBot20,
    breakLow5, breakLow10, breakHigh5, breakHigh10,
    // extension / excès (TOP)
    extAboveMA50_15: distMA50 != null ? distMA50 > 0.15 : null,
    extAboveMA200_40: distMA200 != null ? distMA200 > 0.40 : null,
    backUnderEMA8AfterExt: ema8 != null ? (c < ema8 && recentOverext) : null,
    aboveBBUpper: bbU != null ? c > bbU : null,
    reEnterUnderBBUpper: bbU != null && bbUp != null ? (prev && prev.close > bbUp && c < bbU) : null,
    // extension / excès (BOTTOM)
    bigDD20: ddFromHigh20 != null ? ddFromHigh20 > 0.20 : null,
    belowBBLower: bbL != null ? c < bbL : null,
    reEnterAboveBBLower: bbL != null && bbLp != null ? (prev && prev.close < bbLp && c > bbL) : null,
    recoverEMA8: ema8 != null && prev ? (c > ema8 && prev.close <= (ind.ema8[i - 1] ?? ema8)) : null,
    recoverEMA21or34: (ema21 != null || ema34 != null) ? (c > (ema21 ?? Infinity) || c > (ema34 ?? Infinity)) && (prev && (prev.close <= (ind.ema21[i - 1] ?? Infinity) || prev.close <= (ind.ema34[i - 1] ?? Infinity))) : null,
    greenAboveVolAvg20: volAvg20 ? (b.close > b.open && b.volume > volAvg20) : null,
  };

  // ── Score TOP (0–100, brut plafonné) ──
  const topComp = {};
  const addTop = (key, cond, w) => { if (cond) topComp[key] = w; };
  addTop("rsiOver70", s.rsiOver70, 10);
  addTop("rsiCrossDown70", s.rsiCrossDown70, 15);
  addTop("macdHistFalling", s.macdHistFalling, 10);
  addTop("macdBearishCross", s.macdBearishCross, 15);
  addTop("extAboveMA50_15", s.extAboveMA50_15, 10);
  addTop("extAboveMA200_40", s.extAboveMA200_40, 10);
  addTop("backUnderEMA8AfterExt", s.backUnderEMA8AfterExt, 10);
  addTop("redHighVol", s.redHighVol, 10);
  addTop("localTop10or20", s.localTop10 || s.localTop20, 10);
  addTop("breakLow5", s.breakLow5, 10);
  addTop("atrExpansion", s.atrExpansion, 5);
  addTop("reEnterUnderBBUpper", s.reEnterUnderBBUpper, 8);
  const topRaw = Object.values(topComp).reduce((a, x) => a + x, 0);

  // ── Score BOTTOM (0–100, brut plafonné) ──
  const botComp = {};
  const addBot = (key, cond, w) => { if (cond) botComp[key] = w; };
  addBot("rsiUnder30", s.rsiUnder30, 15);
  addBot("rsiCrossUp30", s.rsiCrossUp30, 15);
  addBot("macdHistRising", s.macdHistRising, 10);
  addBot("macdBullishCross", s.macdBullishCross, 15);
  addBot("recoverEMA8", s.recoverEMA8, 10);
  addBot("recoverEMA21or34", s.recoverEMA21or34, 10);
  addBot("greenAboveVolAvg20", s.greenAboveVolAvg20, 10);
  addBot("reEnterAboveBBLower", s.reEnterAboveBBLower, 10);
  addBot("localBot10or20", s.localBot10 || s.localBot20, 10);
  addBot("bigDD20", s.bigDD20, 10);
  const botRaw = Object.values(botComp).reduce((a, x) => a + x, 0);

  return {
    signals: s,
    extras: { rsi: round2(rsiV), macdHist: round4(histV), distMA50: round4(distMA50), distMA200: round4(distMA200), atrPct: round4(atrPct), rangePct: round4(rangePct), ddFromHigh20: round4(ddFromHigh20), rallyFromLow20: round4(rallyFromLow20), ret5: round4(ret(5)), ret10: round4(ret(10)), ret20: round4(ret(20)) },
    topScore: Math.min(100, topRaw), topRaw, topComp,
    botScore: Math.min(100, botRaw), botRaw, botComp,
  };
}

// Drawdown forward (lows) sur n barres à partir de idx
function forwardDD(bars, idx, n) {
  const base = bars[idx].close;
  let minRet = 0, seen = 0, minAt = null;
  for (let j = 1; j <= n && idx + j < bars.length; j++) {
    seen++;
    const r = bars[idx + j].low / base - 1;
    if (r < minRet) { minRet = r; minAt = j; }
  }
  return { dd: seen > 0 ? round4(minRet) : null, complete: seen === n, daysTo: minAt, bars: seen };
}
function forwardRally(bars, idx, n) {
  const base = bars[idx].close;
  let maxRet = 0, seen = 0;
  for (let j = 1; j <= n && idx + j < bars.length; j++) { seen++; const r = bars[idx + j].high / base - 1; if (r > maxRet) maxRet = r; }
  return { rally: seen > 0 ? round4(maxRet) : null, complete: seen === n };
}

// liste des signaux TOP/BOTTOM "qui comptent" (pour l'agrégation de récurrence)
const TOP_SIGNAL_KEYS = ["rsiOver70", "rsiCrossDown70", "macdHistFalling", "macdBearishCross", "extAboveMA50_15", "extAboveMA200_40", "backUnderEMA8AfterExt", "redHighVol", "volSpike20", "localTop10", "localTop20", "breakLow5", "breakLow10", "atrExpansion", "aboveBBUpper", "reEnterUnderBBUpper", "rsiSlope3Down", "stochRsiOverbought"];
const BOT_SIGNAL_KEYS = ["rsiUnder30", "rsiCrossUp30", "macdHistRising", "macdBullishCross", "recoverEMA8", "recoverEMA21or34", "greenAboveVolAvg20", "belowBBLower", "reEnterAboveBBLower", "localBot10", "localBot20", "bigDD20", "rsiSlope3Up", "stochRsiOversold"];

function trueSignals(sig, keys) { return keys.filter((k) => sig[k] === true); }

// ── Détection des gros drawdowns (swing highs -> baisse) ─────────────────────
function detectDrawdownEpisodes(bars, pivot = 10, fwd = 60) {
  const episodes = [];
  for (let i = pivot; i < bars.length - 1; i++) {
    // swing high local
    let isSwing = true;
    for (let j = Math.max(0, i - pivot); j <= Math.min(bars.length - 1, i + pivot); j++) {
      if (bars[j].high > bars[i].high + 1e-9) { isSwing = false; break; }
    }
    if (!isSwing) continue;
    let minLow = Infinity, minAt = null;
    for (let j = 1; j <= fwd && i + j < bars.length; j++) { if (bars[i + j].low < minLow) { minLow = bars[i + j].low; minAt = j; } }
    if (minLow === Infinity) continue;
    const decline = 1 - minLow / bars[i].high;
    if (decline >= 0.10) episodes.push({ peakIdx: i, peakDate: bars[i].date, peakHigh: round2(bars[i].high), decline: round4(decline), daysToTrough: minAt });
  }
  // dédup : garder, pour des pics proches (<=15 barres), celui avec le plus gros déclin
  episodes.sort((a, b) => a.peakIdx - b.peakIdx);
  const merged = [];
  for (const e of episodes) {
    const last = merged[merged.length - 1];
    if (last && e.peakIdx - last.peakIdx <= 15) { if (e.decline > last.decline) merged[merged.length - 1] = e; }
    else merged.push(e);
  }
  return merged;
}

function classifyDecline(d) { return d >= 0.30 ? ">=30%" : d >= 0.20 ? ">=20%" : ">=10%"; }

// ── Analyse d'une flèche : meilleure confluence dans la fenêtre ──────────────
function analyzeArrow(bars, ind, arrow) {
  const tol = arrow.toleranceDays;
  const center = new Date(arrow.date).getTime();
  const lo = center - tol * 86_400_000, hi = center + tol * 86_400_000;
  const idxs = [];
  for (let i = 0; i < bars.length; i++) { if (bars[i].t >= lo && bars[i].t <= hi) idxs.push(i); }

  const windowStart = isoDay(lo), windowEnd = isoDay(hi);
  if (!idxs.length) {
    return { ...arrow, windowStart, windowEnd, inData: false, note2: "aucune barre dans la fenêtre (hors plage du cache OHLC)" };
  }

  // scoring sur chaque barre de la fenêtre
  const perBar = idxs.map((i) => ({ i, date: bars[i].date, ...signalsAt(bars, ind, i) }));
  const bestTop = perBar.reduce((a, b) => (b.topScore > a.topScore ? b : a));
  const bestBot = perBar.reduce((a, b) => (b.botScore > a.botScore ? b : a));

  // métriques forward au meilleur jour TOP
  const fdd = {}; const fral = {};
  for (const h of HORIZONS) { fdd[h] = forwardDD(bars, bestTop.i, h); fral[h] = forwardRally(bars, bestTop.i, h); }

  // contexte sommet local au meilleur jour TOP
  const ex = bestTop.extras;
  const nearLocalPeak = ex.ddFromHigh20 != null && ex.ddFromHigh20 <= NEAR_PEAK_TOL;
  const tooLate = ex.ddFromHigh20 != null && ex.ddFromHigh20 >= TOO_LATE_DROP;

  // y a-t-il un VRAI sommet local (high20) dans la fenêtre, et à quelle distance du best top ?
  let trueTopIdx = idxs[0];
  for (const i of idxs) if (bars[i].high > bars[trueTopIdx].high) trueTopIdx = i;
  let trueBotIdx = idxs[0];
  for (const i of idxs) if (bars[i].low < bars[trueBotIdx].low) trueBotIdx = i;

  return {
    ...arrow,
    windowStart, windowEnd, inData: true, barsInWindow: idxs.length,
    bestTop: {
      date: bestTop.date, close: round2(bars[bestTop.i].close), topScore: bestTop.topScore, topRaw: bestTop.topRaw,
      components: bestTop.topComp, signalsTrue: trueSignals(bestTop.signals, TOP_SIGNAL_KEYS), extras: ex,
      nearLocalPeak, tooLate,
      forwardDD: Object.fromEntries(HORIZONS.map((h) => [h, fdd[h].dd])),
      forwardDDComplete: Object.fromEntries(HORIZONS.map((h) => [h, fdd[h].complete])),
      precededDrop10: HORIZONS.some((h) => fdd[h].dd != null && fdd[h].dd <= -0.10),
      precededDrop20: HORIZONS.some((h) => fdd[h].dd != null && fdd[h].dd <= -0.20),
    },
    bestBottom: {
      date: bestBot.date, close: round2(bars[bestBot.i].close), botScore: bestBot.botScore, botRaw: bestBot.botRaw,
      components: bestBot.botComp, signalsTrue: trueSignals(bestBot.signals, BOT_SIGNAL_KEYS), extras: bestBot.extras,
      forwardRally: Object.fromEntries(HORIZONS.map((h) => [h, forwardRally(bars, bestBot.i, h).rally])),
    },
    trueLocalTop: { date: bars[trueTopIdx].date, high: round2(bars[trueTopIdx].high), deltaToBestTopDays: Math.round(daysBetween(bars[trueTopIdx].date, bestTop.date)) },
    trueLocalBottom: { date: bars[trueBotIdx].date, low: round2(bars[trueBotIdx].low) },
  };
}

// ── Agrégation de récurrence ─────────────────────────────────────────────────
function aggregatePresence(items, keys) {
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const it of items) for (const k of it) if (counts[k] != null) counts[k]++;
  const n = items.length || 1;
  return Object.entries(counts).map(([k, c]) => ({ signal: k, count: c, rate: c / n })).sort((a, b) => b.count - a.count);
}
function topPairs(items, keys, topN = 6) {
  const pairCount = {};
  for (const it of items) {
    const present = it.filter((k) => keys.includes(k));
    for (let a = 0; a < present.length; a++) for (let b = a + 1; b < present.length; b++) {
      const key = [present[a], present[b]].sort().join(" + ");
      pairCount[key] = (pairCount[key] ?? 0) + 1;
    }
  }
  return Object.entries(pairCount).map(([pair, count]) => ({ pair, count, rate: count / (items.length || 1) })).sort((a, b) => b.count - a.count).slice(0, topN);
}

function main() {
  console.log(`=== AUDIT CONFLUENCE TECHNIQUE — flèches jaunes manuelles — ${TICKER} ===\n`);
  console.log("Source flèches : liste manuelle APPROXIMATIVE (le Pine n'est PAS utilisé comme source).\n");

  const bars = loadBars(TICKER);
  if (!bars) { console.error(`⛔ Cache OHLC introuvable ou trop court : ${path.relative(ROOT, cacheFile(TICKER))}`); process.exit(1); }
  const dataStart = bars[0].date, dataEnd = bars.at(-1).date;

  const loaded = loadArrows(TICKER);
  if (!loaded.arrows.length) {
    console.error(`⛔ Aucune flèche valide dans ${loaded.path ? path.relative(ROOT, loaded.path) : "(CSV absent)"}.`);
    console.error("   Renseigne des lignes 'YYYY-MM-DD,note,toleranceDays' puis relance.");
    process.exit(1);
  }

  console.log(`Cache OHLC : ${path.relative(ROOT, cacheFile(TICKER))} (${dataStart} → ${dataEnd}, ${bars.length} barres)`);
  console.log(`Flèches    : ${loaded.arrows.length} (source ${path.relative(ROOT, loaded.path)})\n`);

  const ind = computeIndicators(bars);
  const analyses = loaded.arrows.map((a) => analyzeArrow(bars, ind, a));
  const valid = analyses.filter((a) => a.inData);

  // Agrégation récurrence TOPS / BOTTOMS
  const topSignalLists = valid.map((a) => a.bestTop.signalsTrue);
  const botSignalLists = valid.map((a) => a.bestBottom.signalsTrue);
  const topPresence = aggregatePresence(topSignalLists, TOP_SIGNAL_KEYS);
  const botPresence = aggregatePresence(botSignalLists, BOT_SIGNAL_KEYS);
  const topCombos = topPairs(topSignalLists, TOP_SIGNAL_KEYS);
  const botCombos = topPairs(botSignalLists, BOT_SIGNAL_KEYS);

  // faux positifs : flèche dont le best top n'a pas précédé une baisse >=10% (sur fenêtres complètes)
  const labelable = valid.filter((a) => a.bestTop.forwardDDComplete[40]);
  const falsePos = labelable.filter((a) => !a.bestTop.precededDrop10);
  const tooLateArrows = valid.filter((a) => a.bestTop.tooLate);

  // Score TOP sur tout l'historique pour mesurer faux positifs systémiques
  const allTopScores = [];
  for (let i = 200; i < bars.length; i++) { const sg = signalsAt(bars, ind, i); allTopScores.push({ i, date: bars[i].date, score: sg.topScore }); }
  const highScoreBars = allTopScores.filter((x) => x.score >= TOP_SCORE_CAPTURE);
  let hsHit = 0, hsLabelable = 0;
  for (const x of highScoreBars) { const f = forwardDD(bars, x.i, 40); if (f.complete) { hsLabelable++; if (f.dd <= -0.10) hsHit++; } }
  const systemicFalsePosRate = hsLabelable ? 1 - hsHit / hsLabelable : null;

  // Gros drawdowns + capture
  const episodes = detectDrawdownEpisodes(bars);
  const arrowsByTime = valid.map((a) => ({ start: new Date(a.windowStart).getTime(), end: new Date(a.windowEnd).getTime(), date: a.date }));
  const episodeRows = episodes.map((e) => {
    // flèche utilisateur couvrant le pic ?
    const arrowCovers = arrowsByTime.some((w) => bars[e.peakIdx].t >= w.start && bars[e.peakIdx].t <= w.end);
    let nearestArrow = null, nd = Infinity;
    for (const w of arrowsByTime) { const d = daysBetween(bars[e.peakIdx].date, w.date); if (d < nd) { nd = d; nearestArrow = w.date; } }
    // score TOP élevé dans [peak-15, peak] ?
    let maxScore = 0, maxScoreDate = null;
    for (let j = Math.max(200, e.peakIdx - 15); j <= e.peakIdx; j++) { const sc = signalsAt(bars, ind, j).topScore; if (sc > maxScore) { maxScore = sc; maxScoreDate = bars[j].date; } }
    return { ...e, klass: classifyDecline(e.decline), arrowCovers, nearestArrow, nearestArrowDeltaDays: Number.isFinite(nd) ? Math.round(nd) : null, scoreCaptured: maxScore >= TOP_SCORE_CAPTURE, maxTopScore: maxScore, maxTopScoreDate: maxScoreDate };
  });
  const bigEpisodes = episodeRows.filter((e) => e.decline >= 0.20);
  const capturedByArrow = bigEpisodes.filter((e) => e.arrowCovers || e.nearestArrowDeltaDays <= 15).length;
  const capturedByScore = bigEpisodes.filter((e) => e.scoreCaptured).length;

  // ── Console résumé ──
  console.log("--- Confluence TOP par flèche ---");
  for (const a of analyses) {
    if (!a.inData) { console.log(`  ${a.date} (±${a.toleranceDays}j) : ${a.note2}`); continue; }
    const t = a.bestTop;
    console.log(`  ${a.date} (±${a.toleranceDays}j) → best TOP ${t.date} | score ${t.topScore} | DD20 ${pct(t.forwardDD[20])} DD40 ${pct(t.forwardDD[40])} | ${t.nearLocalPeak ? "près sommet" : t.tooLate ? "trop tard" : "milieu"} | signaux: ${t.signalsTrue.join(", ") || "—"}`);
  }
  console.log("\n--- Signaux TOP les plus récurrents ---");
  for (const p of topPresence.filter((x) => x.count > 0).slice(0, 10)) console.log(`  ${p.signal}: ${p.count}/${valid.length} (${pct(p.rate)})`);
  console.log("\n--- Gros drawdowns (>=20%) capturés ---");
  console.log(`  par flèche utilisateur (±15j) : ${capturedByArrow}/${bigEpisodes.length}`);
  console.log(`  par score TOP >= ${TOP_SCORE_CAPTURE}   : ${capturedByScore}/${bigEpisodes.length}`);
  console.log(`  faux positifs systémiques score TOP>=${TOP_SCORE_CAPTURE} : ${pct(systemicFalsePosRate)} (sur ${hsLabelable} barres labelables)`);

  // ── Rapport ──
  writeReports({
    bars, dataStart, dataEnd, loaded, analyses, valid, labelable, falsePos, tooLateArrows,
    topPresence, botPresence, topCombos, botCombos, episodeRows, bigEpisodes,
    capturedByArrow, capturedByScore, systemicFalsePosRate, hsLabelable, highScoreBars,
  });
}

function buildPineProposal(topPresence, botPresence) {
  // seuils dérivés des signaux les plus fréquents
  const freqTop = topPresence.filter((p) => p.rate >= SIGNAL_PRESENCE_AT_TOP).map((p) => p.signal);
  const freqBot = botPresence.filter((p) => p.rate >= SIGNAL_PRESENCE_AT_TOP).map((p) => p.signal);
  return { freqTop, freqBot };
}

function writeReports(ctx) {
  const { bars, dataStart, dataEnd, loaded, analyses, valid, labelable, falsePos, tooLateArrows,
    topPresence, botPresence, topCombos, botCombos, episodeRows, bigEpisodes,
    capturedByArrow, capturedByScore, systemicFalsePosRate, hsLabelable } = ctx;

  const avgDD = Object.fromEntries(HORIZONS.map((h) => [h, round4(avg(valid.map((a) => a.bestTop.forwardDD[h])))]));
  const hitRate10 = labelable.length ? labelable.filter((a) => a.bestTop.precededDrop10).length / labelable.length : null;
  const hitRate20 = labelable.length ? labelable.filter((a) => a.bestTop.precededDrop20).length / labelable.length : null;
  const nearPeakN = valid.filter((a) => a.bestTop.nearLocalPeak).length;
  const pine = buildPineProposal(topPresence, botPresence);

  // recommandation
  const recommend = (hitRate10 ?? 0) >= 0.6 && (systemicFalsePosRate ?? 1) <= 0.5;
  const mode = (systemicFalsePosRate ?? 1) <= 0.4 ? "agressive (signal plus précoce)" : "conservatrice (confirmation requise)";

  const md = [];
  md.push(`# Audit de confluence technique — flèches jaunes manuelles — ${TICKER}`);
  md.push("");
  md.push(`Généré : ${new Date().toISOString()}`);
  md.push("");
  md.push("> ⚠️ **Dates des flèches = ESTIMATIONS VISUELLES approximatives** (relevées sur la capture TradingView).");
  md.push("> L'audit analyse une **fenêtre ±toleranceDays** autour de chaque flèche et cherche le **jour de meilleure confluence**.");
  md.push("> Le Pine `debug/TQQQ_Top_Risk_Live_Final.pine` n'est **pas** utilisé comme source des flèches.");
  md.push("");

  // 1. Résumé exécutif
  md.push("## 1. Résumé exécutif");
  md.push("");
  md.push(`- Flèches analysées : **${loaded.arrows.length}** (dont **${valid.length}** avec barres dans la fenêtre).`);
  md.push(`- Flèches placées **près d'un sommet local** (≤${NEAR_PEAK_TOL * 100}% du high 20j) : **${nearPeakN}/${valid.length}**.`);
  md.push(`- Une **baisse ≥10%** suit le meilleur jour TOP dans **${labelable.length ? `${labelable.filter((a) => a.bestTop.precededDrop10).length}/${labelable.length}` : "n/a"}** des fenêtres complètes (${pct(hitRate10)}).`);
  md.push(`- Une **baisse ≥20%** suit dans **${labelable.length ? `${labelable.filter((a) => a.bestTop.precededDrop20).length}/${labelable.length}` : "n/a"}** (${pct(hitRate20)}).`);
  md.push(`- Drawdown moyen après le meilleur jour TOP : 5j ${pct(avgDD[5])} · 10j ${pct(avgDD[10])} · 20j ${pct(avgDD[20])} · 40j ${pct(avgDD[40])}.`);
  md.push(`- Gros drawdowns historiques ≥20% : **${bigEpisodes.length}** — capturés par flèche (±15j) : **${capturedByArrow}**, par score TOP≥${TOP_SCORE_CAPTURE} : **${capturedByScore}**.`);
  md.push(`- Faux positifs systémiques du score TOP≥${TOP_SCORE_CAPTURE} (pas de -10% en 40j) : **${pct(systemicFalsePosRate)}** (sur ${hsLabelable} barres).`);
  md.push(`- Signaux TOP récurrents (≥${SIGNAL_PRESENCE_AT_TOP * 100}% des flèches) : ${pine.freqTop.length ? "`" + pine.freqTop.join("`, `") + "`" : "—"}.`);
  md.push("");

  // 2. Sources
  md.push("## 2. Sources utilisées");
  md.push("");
  md.push("| Source | Fichier | Usage |");
  md.push("|--------|---------|-------|");
  md.push(`| Flèches manuelles | \`${path.relative(ROOT, loaded.path)}\` | Dates approx. + toleranceDays |`);
  md.push(`| OHLC ${TICKER} | \`${path.relative(ROOT, cacheFile(TICKER))}\` | Prix, indicateurs, drawdowns |`);
  md.push("| Pine original | (non utilisé comme source) | — |");
  md.push("");
  md.push(`Plage OHLC : ${dataStart} → ${dataEnd} (${bars.length} barres).`);
  if (loaded.ignored.length) md.push(`Entrées CSV ignorées : ${loaded.ignored.join(", ")}.`);
  md.push("");

  // 3. Flèches analysées
  md.push("## 3. Flèches analysées (fenêtres)");
  md.push("");
  md.push("| Flèche (saisie) | Tol. | Fenêtre | Barres | Note |");
  md.push("|-----------------|------|---------|--------|------|");
  for (const a of analyses) md.push(`| ${a.date} | ±${a.toleranceDays}j | ${a.windowStart} → ${a.windowEnd} | ${a.inData ? a.barsInWindow : 0} | ${a.note || a.note2 || ""} |`);
  md.push("");

  // 4. Meilleures confluences TOP
  md.push("## 4. Meilleure confluence TOP autour de chaque flèche");
  md.push("");
  md.push("| Flèche | Best TOP | Close | Score | DD5 | DD10 | DD20 | DD40 | Près sommet | Trop tard | Signaux présents |");
  md.push("|--------|----------|-------|-------|-----|------|------|------|-------------|-----------|------------------|");
  for (const a of valid) {
    const t = a.bestTop;
    md.push(`| ${a.date} | ${t.date} | ${t.close} | ${t.topScore} | ${pct(t.forwardDD[5])} | ${pct(t.forwardDD[10])} | ${pct(t.forwardDD[20])} | ${pct(t.forwardDD[40])} | ${t.nearLocalPeak ? "oui" : "non"} | ${t.tooLate ? "oui" : "non"} | ${t.signalsTrue.join(", ") || "—"} |`);
  }
  md.push("");
  md.push("Vrai sommet local (high max) de chaque fenêtre vs jour de meilleur score :");
  md.push("");
  md.push("| Flèche | Vrai sommet (high) | Best TOP score | Écart (j) |");
  md.push("|--------|--------------------|----------------|-----------|");
  for (const a of valid) md.push(`| ${a.date} | ${a.trueLocalTop.date} (${a.trueLocalTop.high}) | ${a.bestTop.date} | ${a.trueLocalTop.deltaToBestTopDays} |`);
  md.push("");

  // 5. Indicateurs les plus fréquents aux tops
  md.push("## 5. Indicateurs les plus fréquents aux TOPS");
  md.push("");
  md.push("| Signal | Présence | Taux |");
  md.push("|--------|----------|------|");
  for (const p of topPresence.filter((x) => x.count > 0)) md.push(`| ${p.signal} | ${p.count}/${valid.length} | ${pct(p.rate)} |`);
  md.push("");
  md.push("Combinaisons (paires) les plus fréquentes :");
  md.push("");
  if (topCombos.length) { md.push("| Combinaison | Présence | Taux |"); md.push("|-------------|----------|------|"); for (const c of topCombos) md.push(`| ${c.pair} | ${c.count}/${valid.length} | ${pct(c.rate)} |`); }
  else md.push("Aucune paire récurrente.");
  md.push("");

  // 6. Faux positifs
  md.push("## 6. Faux positifs (best TOP sans baisse ≥10% en 40j)");
  md.push("");
  if (falsePos.length) {
    md.push("| Flèche | Best TOP | Close | DD40 | Ret signal |");
    md.push("|--------|----------|-------|------|-----------|");
    for (const a of falsePos) md.push(`| ${a.date} | ${a.bestTop.date} | ${a.bestTop.close} | ${pct(a.bestTop.forwardDD[40])} | score ${a.bestTop.topScore} |`);
  } else md.push("Aucun faux positif sur les fenêtres complètes : chaque meilleur jour TOP a été suivi d'une baisse ≥10%.");
  md.push("");

  // 7. Signaux trop tardifs
  md.push("## 7. Signaux trop tardifs (déjà -5%+ du high 20j au best TOP)");
  md.push("");
  if (tooLateArrows.length) {
    md.push("| Flèche | Best TOP | Baisse depuis high 20j | DD40 suivant |");
    md.push("|--------|----------|------------------------|--------------|");
    for (const a of tooLateArrows) md.push(`| ${a.date} | ${a.bestTop.date} | ${pct(a.bestTop.extras.ddFromHigh20)} | ${pct(a.bestTop.forwardDD[40])} |`);
  } else md.push("Aucune flèche n'arrive en retard : tous les meilleurs jours TOP sont à <5% du high 20j.");
  md.push("");

  // 8. Tops/drawdowns manqués
  md.push("## 8. Gros drawdowns & captures");
  md.push("");
  md.push("| Pic | Classe | Déclin | Jours→creux | Flèche couvre | Flèche +proche (j) | Score TOP capté |");
  md.push("|-----|--------|--------|-------------|---------------|--------------------|-----------------|");
  for (const e of episodeRows.filter((x) => x.decline >= 0.20)) {
    md.push(`| ${e.peakDate} | ${e.klass} | ${pct(e.decline)} | ${e.daysToTrough} | ${e.arrowCovers ? "oui" : "non"} | ${e.nearestArrowDeltaDays ?? "—"} | ${e.scoreCaptured ? `oui (${e.maxTopScore})` : `non (${e.maxTopScore})`} |`);
  }
  md.push("");
  md.push(`- Gros drawdowns ≥20% : **${bigEpisodes.length}** | capturés flèche (±15j) : **${capturedByArrow}** | capturés score TOP≥${TOP_SCORE_CAPTURE} : **${capturedByScore}**.`);
  const missedByArrow = bigEpisodes.filter((e) => !(e.arrowCovers || e.nearestArrowDeltaDays <= 15));
  md.push(`- Manqués par les flèches : **${missedByArrow.length}** → ${missedByArrow.map((e) => e.peakDate).join(", ") || "aucun"}.`);
  md.push("");

  // 9. Confluences bottom
  md.push("## 9. Confluences BOTTOM");
  md.push("");
  md.push("Meilleur jour BOTTOM dans chaque fenêtre (le creux que la flèche aurait pu marquer) :");
  md.push("");
  md.push("| Flèche | Best BOTTOM | Close | Score | Rally10 | Rally20 | Rally40 | Signaux |");
  md.push("|--------|-------------|-------|-------|---------|---------|---------|---------|");
  for (const a of valid) {
    const b = a.bestBottom;
    md.push(`| ${a.date} | ${b.date} | ${b.close} | ${b.botScore} | ${pct(b.forwardRally[10])} | ${pct(b.forwardRally[20])} | ${pct(b.forwardRally[40])} | ${b.signalsTrue.join(", ") || "—"} |`);
  }
  md.push("");
  md.push("Signaux BOTTOM les plus fréquents :");
  md.push("");
  md.push("| Signal | Présence | Taux |");
  md.push("|--------|----------|------|");
  for (const p of botPresence.filter((x) => x.count > 0)) md.push(`| ${p.signal} | ${p.count}/${valid.length} | ${pct(p.rate)} |`);
  md.push("");

  // 10. Proposition Pine
  md.push("## 10. Proposition d'indicateur Pine (à valider)");
  md.push("");
  md.push("Conditions dérivées des signaux récurrents observés (seuils initiaux, à affiner) :");
  md.push("");
  md.push("```");
  md.push("// ── WATCH TOP (surveillance) ──");
  md.push("watchTop = rsi14 > 70 and close > ta.ema(close,8)*1.0 and (close/ta.sma(close,50)-1) > 0.15");
  md.push("// ── CONFIRMED TOP (confirmation) ──");
  md.push("confirmedTop = ta.crossunder(rsi14, 70) and ta.crossunder(macdLine, signalLine) and macdHist < macdHist[1]");
  md.push("// ── EXTREME TOP (excès) ──");
  md.push("extremeTop = (close/ta.sma(close,200)-1) > 0.40 and close > bbUpper and rsi14 > 75");
  md.push("// ── WATCH BOTTOM ──");
  md.push("watchBottom = rsi14 < 30 and close < bbLower");
  md.push("// ── CONFIRMED BOTTOM ──");
  md.push("confirmedBottom = ta.crossover(rsi14, 30) and ta.crossover(macdLine, signalLine) and close > ta.ema(close,8)");
  md.push("```");
  md.push("");
  md.push(`Signaux TOP à prioriser (récurrents ≥${SIGNAL_PRESENCE_AT_TOP * 100}%) : ${pine.freqTop.length ? "`" + pine.freqTop.join("`, `") + "`" : "(aucun au-dessus du seuil — élargir l'échantillon)"}.`);
  md.push(`Signaux BOTTOM à prioriser : ${pine.freqBot.length ? "`" + pine.freqBot.join("`, `") + "`" : "(aucun au-dessus du seuil)"}.`);
  md.push("");

  // 11. Recommandation
  md.push("## 11. Recommandation");
  md.push("");
  md.push(`- **Créer l'indicateur : ${recommend ? "OUI" : "OUI mais en mode WATCH seulement (échantillon limité)"}**.`);
  md.push(`- **Version conseillée : ${mode}**.`);
  md.push(`- Seuils initiaux : RSI 70/30, MACD 12/26/9, dist MA50 >15% (WATCH) / dist MA200 >40% (EXTREME), Bollinger 20,2, score TOP de bascule à **${TOP_SCORE_CAPTURE}/100**.`);
  md.push(`- Justification : baisse ≥10% capturée dans ${pct(hitRate10)} des fenêtres, ${capturedByScore}/${bigEpisodes.length} gros drawdowns ≥20% captés par le score, faux positifs systémiques ${pct(systemicFalsePosRate)}.`);
  md.push("- ⚠️ Échantillon de flèches faible et dates approximatives : valider/affiner les dates dans le CSV puis relancer avant de figer les seuils.");
  md.push("");
  md.push("### Pondérations du score (choix expliqués)");
  md.push("");
  md.push("TOP : RSI>70 (+10), RSI repasse <70 (+15, signal de retournement plus fort que le simple excès), MACD hist baisse (+10), croisement MACD bearish (+15, confirmation), extension >15% MA50 (+10) / >40% MA200 (+10, excès historiquement réversibles sur un 3x), repli sous EMA8 après excès (+10), volume rouge >1.5× (+10, distribution), sommet local 10/20j (+10), cassure low 5j (+10), expansion ATR (+5), réintégration sous bande haute Bollinger (+8). Brut plafonné à 100.");
  md.push("");
  md.push("BOTTOM : RSI<30 (+15), RSI repasse >30 (+15), MACD hist remonte (+10), croisement MACD bullish (+15), récupération EMA8 (+10) / EMA21-34 (+10), volume vert > moyenne 20 (+10), réintégration au-dessus bande basse Bollinger (+10), bottom local 10/20j (+10), drawdown récent >20% (+10).");
  md.push("");

  const mdPath = path.join(DEBUG_DIR, "manual-arrow-technical-confluence-audit.md");
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  const jsonPath = path.join(DEBUG_DIR, "manual-arrow-technical-confluence-audit.json");
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    ticker: TICKER,
    pineUsedAsSource: false,
    arrowsApproximate: true,
    sources: { ohlc: path.relative(ROOT, cacheFile(TICKER)), arrows: path.relative(ROOT, loaded.path) },
    ohlcRange: { start: dataStart, end: dataEnd, bars: bars.length },
    thresholds: { NEAR_PEAK_TOL, TOO_LATE_DROP, TOP_SCORE_CAPTURE, SIGNAL_PRESENCE_AT_TOP, DEFAULT_TOLERANCE_DAYS, HORIZONS },
    summary: {
      arrows: loaded.arrows.length, valid: valid.length, nearPeak: nearPeakN,
      hitRate10, hitRate20, avgDrawdownByHorizon: avgDD,
      bigDrawdowns20: bigEpisodes.length, capturedByArrow, capturedByScore,
      systemicFalsePosRate, recommendIndicator: recommend, recommendedMode: mode,
    },
    topSignalPresence: topPresence,
    bottomSignalPresence: botPresence,
    topCombos, botCombos,
    arrows: analyses,
    drawdownEpisodes: episodeRows,
    pineProposalSignals: pine,
  }, null, 2), "utf8");

  console.log("\n" + "=".repeat(60));
  console.log("FICHIERS GÉNÉRÉS");
  console.log(`  ${path.relative(ROOT, mdPath)}`);
  console.log(`  ${path.relative(ROOT, jsonPath)}`);
  console.log("\n(Audit seulement — aucun commit, aucun git add.)");
}

main();
