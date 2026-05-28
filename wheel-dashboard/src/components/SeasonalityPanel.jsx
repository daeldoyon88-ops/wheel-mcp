/**
 * SeasonalityPanel V2 PRO — Layout one-page fidèle à la maquette.
 * Sidebar gauche + toutes les sections visibles sur une seule page, sans sous-onglets.
 * UI seulement — aucun impact backend, IBKR, scanner ou logique Wheel.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import ThreeYearSeasonalityChart, {
  computeRsi14,
  getRsiMomentumState,
} from "./ThreeYearSeasonalityChart.jsx";
import {
  TrendingUp, TrendingDown, RefreshCw, Search, Info, Star,
  AlertTriangle, BarChart3, CalendarDays, Activity, Shield, Loader2,
  ArrowUpRight, Home, BookOpen, Database, Settings, FileText,
  HelpCircle, BarChart2, ChevronRight,
} from "lucide-react";

// ─── Palette ───────────────────────────────────────────────────────────────────
const C = {
  bg:          "#050b14",
  sidebar:     "#07111f",
  panel:       "#0b1626",
  card:        "#101d31",
  cardInner:   "#0d1a2b",
  border:      "rgba(120,150,190,0.18)",
  borderAccent:"rgba(139,92,246,0.35)",
  accent:      "#8b5cf6",
  accentLight: "#a78bfa",
  cyan:        "#22d3ee",
  green:       "#22c55e",
  red:         "#ef4444",
  yellow:      "#facc15",
  text:        "#e5edf8",
  textMuted:   "#8fa3bf",
  textFaint:   "#4a6580",
};

// ─── Constantes ────────────────────────────────────────────────────────────────
const SCAN_SOURCE_TICKERS = {
  "top20-wheel": ["TQQQ","SOXL","NVDA","AMD","AAPL","TSLA","PLTR","SOFI","HOOD","AFRM","UBER","AMZN","MSFT","SHOP","NFLX","META","GOOGL","MU","AVGO","INTC"],
  "strict-watchlist": ["NVDA","AAPL","MSFT","GOOGL","AMZN","TSLA","META","AMD","PLTR","TQQQ","SOXL","UBER","SHOP","NFLX","INTC"],
  "fallback65": ["CF","SNOW","KO","SLB","TSCO","PCG","DOCU","PATH","F","WBD","SOFI","ABT","SCHW","CSX","BAC","CVS","GM","HIMS","UBER","TGT","AFRM","SBUX","NFLX","TQQQ","SOXL","TNA","SSO","EXPE","SHOP","AAPL","AMZN","AMD","ORCL","PLTR","NVDA","MSFT","GOOGL","MU","AVGO","TSM","MRVL","IBKR","DUOL","NEM","DELL","KMI","HOOD","LVS","FSLR","ROOT","VST","ZM","PYPL","DECK","NVO","PHM","DXCM","USB","PDD","TSLA","META","SMCI","INTC","MSTR","COIN"],
};
const SCAN_SOURCE_LABELS = { "top20-wheel":"Top 20 Wheel","strict-watchlist":"Strict Watchlist","fallback65":"Fallback 65" };
const QUICK_TICKERS = ["TQQQ","NVDA","AAPL","TSLA","SOXL","AMD","PLTR","AMZN"];
const SEASONAL_UNIVERSE = ["TQQQ","SOXL","NVDA","TSLA","AMD","AAPL","SOFI","PLTR","APLD","UPRO","AVGO"];
const MONTH_ABBREV  = ["Jan","Fév","Mar","Avr","Mai","Juin","Juil","Août","Sep","Oct","Nov","Déc"];
const MONTHS_FR_LONG = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEK_TO_DAY_CHART = { 1: 1, 2: 8, 3: 15, 4: 22, 5: 29 };
const FR_MONTH_PARSE = [
  ["jan", 1], ["fév", 2], ["fev", 2], ["mar", 3], ["mars", 3], ["avr", 4],
  ["mai", 5], ["juin", 6], ["juil", 7], ["jul", 7], ["août", 8], ["aout", 8], ["aoû", 8],
  ["sep", 9], ["sept", 9], ["oct", 10], ["nov", 11], ["déc", 12], ["dec", 12],
];

// ─── Utilitaires ───────────────────────────────────────────────────────────────
function formatPct(val, signed = true) {
  if (typeof val !== "number" || !isFinite(val)) return "—";
  const abs = Math.abs(val * 100).toFixed(1);
  if (signed) return val >= 0 ? `+${abs}%` : `-${abs}%`;
  return `${abs}%`;
}
function formatWinRate(val) {
  if (typeof val !== "number") return "—";
  return `${Math.round(val * 100)}%`;
}
function pctColor(val) {
  if (typeof val !== "number") return C.textMuted;
  if (val >= 0.02) return C.green;
  if (val > 0)     return "#86efac";
  if (val <= -0.02) return C.red;
  if (val < 0)     return "#fca5a5";
  return C.textMuted;
}
function verdictStyleObj(verdict) {
  const v = String(verdict ?? "").toLowerCase();
  if (["favorable","bullish","low","très favorable","tres favorable"].includes(v))
    return { bg:"rgba(34,197,94,0.12)", border:"rgba(34,197,94,0.32)", color:C.green };
  if (["neutre","neutral","medium","neutre_long","prudent","modéré","modere"].includes(v))
    return { bg:"rgba(250,204,21,0.1)", border:"rgba(250,204,21,0.28)", color:C.yellow };
  if (["defavorable","défavorable","unfavorable","bearish","high","faible","risque","très risqué","tres risque"].includes(v))
    return { bg:"rgba(239,68,68,0.1)", border:"rgba(239,68,68,0.28)", color:C.red };
  if (v === "risque_hausse")
    return { bg:"rgba(239,68,68,0.1)", border:"rgba(239,68,68,0.28)", color:C.red };
  return { bg:"rgba(143,163,191,0.08)", border:"rgba(143,163,191,0.2)", color:C.textMuted };
}
function verdictLabel(verdict) {
  const map = {
    favorable:"Favorable", defavorable:"Défavorable", défavorable:"Défavorable",
    neutre:"Neutre", neutral:"Neutre", faible:"Faible", prudent:"Prudent",
    risque_hausse:"Risque hausse", bullish:"Haussier", bearish:"Baissier",
    unfavorable:"Défavorable", low:"Faible", medium:"Modéré", high:"Élevé",
    robuste:"Robuste", mesurable:"Mesurable", "très favorable":"Très favorable",
    "tres favorable":"Très favorable", risque:"Risque",
  };
  return map[String(verdict ?? "").toLowerCase()] || String(verdict ?? "—");
}
function getCurrentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = (d) => `${d.getDate()} ${MONTHS_FR_LONG[d.getMonth()].slice(0, 3)}.`;
  const weekNum = Math.ceil((((now - new Date(now.getFullYear(), 0, 1)) / 86400000) + 1) / 7);
  return { range: `${fmt(mon)} → ${fmt(sun)}`, weekNum: `Semaine ${weekNum}` };
}

function dayOfYearFromMonthDay(month, day) {
  const m = Math.min(12, Math.max(1, Number(month) || 1));
  const d = Math.min(31, Math.max(1, Number(day) || 1));
  let doy = d;
  for (let i = 1; i < m; i++) doy += DAYS_IN_MONTH[i];
  return doy;
}

function weekOfMonthToDayChart(month, week) {
  const m = Math.min(12, Math.max(1, Number(month) || 1));
  const w = Math.min(5, Math.max(1, Number(week) || 1));
  if (w < 5) return WEEK_TO_DAY_CHART[w];
  return Math.min(29, DAYS_IN_MONTH[m]);
}

function parseFrenchDayMonth(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase().replace(/\./g, "");
  const m = s.match(/^(\d{1,2})\s+(.+)$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthPart = m[2].trim();
  for (const [key, num] of FR_MONTH_PARSE) {
    if (monthPart === key || monthPart.startsWith(key)) return { month: num, day };
  }
  return null;
}

/** Résout startDOY / endDOY pour overlay graphique (traversement d'année inclus). */
function resolveSwingDayRange(sw) {
  if (sw?.startDayOfYear != null && sw?.endDayOfYear != null) {
    const startDOY = Number(sw.startDayOfYear);
    const endDOY = Number(sw.endDayOfYear);
    return { startDOY, endDOY, wraps: startDOY > endDOY };
  }
  if (sw?.startDay != null && sw?.startMonth != null && sw?.endDay != null && sw?.endMonth != null) {
    const startDOY = dayOfYearFromMonthDay(sw.startMonth, sw.startDay);
    const endDOY = dayOfYearFromMonthDay(sw.endMonth, sw.endDay);
    return { startDOY, endDOY, wraps: startDOY > endDOY };
  }
  if (sw?.startWeekOfMonth != null && sw?.startMonth != null) {
    const startDay = weekOfMonthToDayChart(sw.startMonth, sw.startWeekOfMonth);
    const endDay = weekOfMonthToDayChart(sw.endMonth, sw.endWeekOfMonth ?? sw.startWeekOfMonth ?? 1);
    const startDOY = dayOfYearFromMonthDay(sw.startMonth, startDay);
    const endDOY = dayOfYearFromMonthDay(sw.endMonth, endDay);
    return { startDOY, endDOY, wraps: startDOY > endDOY };
  }
  if (sw?.displayLabel?.includes("→")) {
    const [a, b] = sw.displayLabel.split("→").map((x) => x.trim());
    const start = parseFrenchDayMonth(a);
    const end = parseFrenchDayMonth(b);
    if (start && end) {
      const startDOY = dayOfYearFromMonthDay(start.month, start.day);
      const endDOY = dayOfYearFromMonthDay(end.month, end.day);
      return { startDOY, endDOY, wraps: startDOY > endDOY };
    }
  }
  if (sw?.startMonth && sw?.endMonth) {
    const startDOY = dayOfYearFromMonthDay(sw.startMonth, 15);
    const endDOY = dayOfYearFromMonthDay(sw.endMonth, 15);
    return { startDOY, endDOY, wraps: startDOY > endDOY };
  }
  return null;
}

function swingZoneSegments({ startDOY, endDOY, wraps }) {
  if (wraps) return [[startDOY, 365], [1, endDOY]];
  return [[startDOY, endDOY]];
}

function swingZoneBestSegment(zone, xOfDay) {
  let best = { left: 0, right: 0, width: 0, centerX: 0 };
  for (const [s, e] of swingZoneSegments(zone)) {
    const left = Math.min(xOfDay(s), xOfDay(e));
    const right = Math.max(xOfDay(s), xOfDay(e));
    const width = Math.max(right - left, 2);
    if (width > best.width) {
      best = { left, right, width, centerX: (left + right) / 2 };
    }
  }
  return best;
}

/** Seuils label zone swing (px) — UI seulement, logique simple. */
const SWING_ZONE_LABEL = {
  padX: 8,
  minFullWidth: 88,
  rightEdgeRatio: 0.72,
  bearishYRatio: 0.20,
  bullishYRatio: 0.30,
};

function resolveSwingZoneLabelPlacement(zone, xOfDay, ctx) {
  const { zoneTop, chartH, chartRight, chartLeft, chartW } = ctx;
  const seg = swingZoneBestSegment(zone, xOfDay);
  const { padX, minFullWidth, rightEdgeRatio, bearishYRatio, bullishYRatio } = SWING_ZONE_LABEL;

  const rightEdge = chartLeft + chartW * rightEdgeRatio;
  const nearRight = seg.right >= rightEdge;
  const tooNarrow = seg.width < minFullWidth;
  const forceCompact = nearRight || tooNarrow;

  const pct = typeof zone.avgReturn === "number" ? formatPct(zone.avgReturn) : null;
  const labelText = forceCompact || !pct
    ? (pct ?? zone.label)
    : `${zone.label} · ${pct} attendu`;

  let x = seg.centerX;
  x = Math.max(seg.left + padX, Math.min(x, seg.right - padX));
  x = Math.max(chartLeft + padX, Math.min(x, chartRight - padX));

  const y = zoneTop + chartH * (zone.kind === "bearish" ? bearishYRatio : bullishYRatio);

  return {
    x,
    y,
    textAnchor: "middle",
    labelText,
    fontSize: 7.5,
  };
}

function getTodayDayOfYear() {
  const now = new Date();
  return dayOfYearFromMonthDay(now.getMonth() + 1, now.getDate());
}

/** Libellé principal fenêtre saisonnière (dates lisibles). */
function seasonalWindowPrimaryLabel(w) {
  return w?.displayLabel || w?.label || "—";
}

/** Sous-texte optionnel : format moteur + durée en jours. */
function seasonalWindowSubLabel(w) {
  if (!w?.label) return null;
  const days = w.windowDays ?? w.days;
  return days ? `${w.label} · ${days}j` : w.label;
}

/** Aplatit horizons (fallback si distinct absent). */
function flattenHorizonWindows(windows, direction = "bullish") {
  if (!windows?.horizons?.length) return [];
  const key = direction === "bearish" ? "worstBearish" : "bestBullish";
  const out = [];
  for (const h of windows.horizons) {
    for (const wBlock of h.windows ?? []) {
      for (const w of wBlock[key] ?? []) {
        out.push({ ...w, days: w.days ?? wBlock.windowDays });
      }
    }
  }
  return out;
}

function getDistinctOrLegacyBullish(windows) {
  if (windows?.distinct?.bullish?.length) return windows.distinct.bullish;
  const flat = flattenHorizonWindows(windows, "bullish");
  flat.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return flat.slice(0, 4);
}

function getDistinctOrLegacyBearish(windows) {
  if (windows?.distinct?.bearish?.length) return windows.distinct.bearish;
  const flat = flattenHorizonWindows(windows, "bearish");
  flat.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return flat.slice(0, 4);
}

/** Priorité swingWindows, sinon distinct / legacy. */
function getSwingOrDistinctBullish(windows) {
  const swing = windows?.swingWindows?.bullish;
  if (swing?.length) return { rows: swing.slice(0, 3), mode: "swing" };
  return { rows: getDistinctOrLegacyBullish(windows), mode: "distinct" };
}

function getSwingOrDistinctBearish(windows) {
  const swing = windows?.swingWindows?.bearish;
  if (swing?.length) return { rows: swing.slice(0, 3), mode: "swing" };
  return { rows: getDistinctOrLegacyBearish(windows), mode: "distinct" };
}

function formatConfidenceLabel(raw) {
  const v = String(raw ?? "").toLowerCase();
  if (v.includes("multi")) return "Robuste multi-horizons";
  if (v === "robuste") return "Robuste";
  if (v === "mesurable") return "Mesurable";
  if (v === "préliminaire" || v === "preliminaire") return "Préliminaire";
  if (v === "échantillon limité" || v === "echantillon limite") return "Échantillon limité";
  if (raw) return String(raw);
  return "—";
}

/** Confiance effective — multiHorizonConfidence prioritaire si présent. */
function getEffectiveConfidence(window) {
  return window?.multiHorizonConfidence ?? window?.confidence ?? window?.status;
}

/** Matrice compacte horizonStats pour title/tooltip. */
function formatHorizonStatsMatrix(horizonStats, isBullish) {
  if (!horizonStats || typeof horizonStats !== "object") return null;
  const order = ["3y", "5y", "10y", "15y"];
  const lines = [];
  for (const key of order) {
    const s = horizonStats[key];
    if (!s || s.sampleSize == null) continue;
    const rate = isBullish ? s.winRate : (s.downRate ?? (s.winRate != null ? 1 - s.winRate : null));
    const ratePct = rate != null ? `${Math.round(rate * 100)} %` : "—";
    const ret = typeof s.avgReturn === "number" ? formatPct(s.avgReturn) : "—";
    lines.push(`${key}  ${ret} · ${ratePct} · n=${s.sampleSize}`);
  }
  return lines.length ? lines.join("\n") : null;
}

function formatHorizonConfirmedLine(window) {
  const confirmed = window?.confirmedHorizons;
  if (Array.isArray(confirmed) && confirmed.length) {
    return `Confirmée ${confirmed.join(" / ")}`;
  }
  if (window?.horizonsConfirmedLabel) return window.horizonsConfirmedLabel;
  return null;
}

/** Normalise un taux en fraction 0–1 (accepte aussi 0–100). */
function normalizeRate(val) {
  if (typeof val !== "number" || !isFinite(val)) return null;
  if (val >= 0 && val <= 1) return val;
  if (val > 1 && val <= 100) return val / 100;
  return null;
}

/** Confiance affichée — plafonnée selon sampleSize (ne jamais « Robuste » si n < 12). */
function getDisplayConfidence(rawConfidence, sampleSize, multiHorizonConfidence) {
  const raw = multiHorizonConfidence ?? rawConfidence;
  if (sampleSize == null) {
    const formatted = formatConfidenceLabel(raw);
    return formatted !== "—" ? formatted : "Historique disponible";
  }
  const multi = String(multiHorizonConfidence ?? "").toLowerCase();
  if (multi.includes("multi")) return "Robuste multi-horizons";
  if (sampleSize < 5) return "Échantillon limité";
  if (sampleSize < 8) {
    if (multi === "robuste" || multi === "mesurable") return formatConfidenceLabel(multi);
    return "Préliminaire";
  }
  if (sampleSize < 12) {
    if (multi === "robuste multi-horizons" || multi.includes("multi")) return "Robuste multi-horizons";
    if (multi === "robuste") return "Robuste";
    return "Mesurable";
  }
  const formatted = formatConfidenceLabel(raw);
  return formatted !== "—" ? formatted : "Robuste possible";
}

function getWindowDisplayConfidence(window) {
  return getDisplayConfidence(
    window?.confidence ?? window?.status,
    getSampleSize(window),
    window?.multiHorizonConfidence,
  );
}

/** Libellé occurrences testées — « 1 occurrence » ou « N occurrences ». */
function formatOccurrenceCount(sampleSize) {
  if (typeof sampleSize !== "number" || !isFinite(sampleSize) || sampleSize <= 0) return null;
  const n = Math.round(sampleSize);
  return n === 1 ? "1 occurrence" : `${n} occurrences`;
}

function momentumHintShort(sw, isBullish) {
  const h = sw?.momentumTriggerHint ?? "";
  if (isBullish) return "RSI > 50";
  if (h.toLowerCase().includes("70")) return "Prudence si RSI > 70";
  return "Momentum cassé possible";
}

function SeasonalWideContextLine({ windows }) {
  const cluster = windows?.clusters?.bullish?.[0];
  if (!cluster?.displayLabel) return null;
  return (
    <div style={{ fontSize:"10px", color:C.textFaint, marginBottom:"10px", lineHeight:1.5 }}>
      Contexte saisonnier large :{" "}
      <span style={{ color:C.textMuted, fontWeight:600 }}>{cluster.displayLabel}</span>
      {cluster.durationDays ? ` (${cluster.durationDays}j)` : ""}
    </div>
  );
}

function SeasonalWindowLabel({ window: w, primaryStyle, subStyle }) {
  const primary = seasonalWindowPrimaryLabel(w);
  const sub = seasonalWindowSubLabel(w);
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: "1px" }}>
      <span style={primaryStyle}>{primary}</span>
      {sub && sub !== primary && (
        <span style={subStyle ?? { fontSize: "9px", color: C.textFaint, fontWeight: 400 }}>{sub}</span>
      )}
    </span>
  );
}

// ─── Badge verdict ──────────────────────────────────────────────────────────────
function VerdictBadge({ verdict, size = "sm" }) {
  if (!verdict) return <span style={{ color:C.textFaint }}>—</span>;
  const s = verdictStyleObj(verdict);
  const pad = size === "sm" ? "2px 8px" : "3px 12px";
  const fs  = size === "sm" ? "11px" : "12px";
  return (
    <span style={{ background:s.bg, border:`1px solid ${s.border}`, color:s.color, borderRadius:"20px", padding:pad, fontSize:fs, fontWeight:600, letterSpacing:"0.02em", whiteSpace:"nowrap" }}>
      {verdictLabel(verdict)}
    </span>
  );
}

// ─── Section header ─────────────────────────────────────────────────────────────
function SectionHeader({ title, icon: Icon, right, info }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"10px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:"7px" }}>
        {Icon && <Icon size={13} style={{ color:C.accent, opacity:0.9 }} />}
        <span style={{ fontSize:"10px", fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:C.textMuted }}>
          {title}
        </span>
        {info && <Info size={11} style={{ color:C.textFaint, cursor:"help" }} title={info} />}
      </div>
      {right && <div style={{ fontSize:"10px", color:C.textFaint }}>{right}</div>}
    </div>
  );
}

// ─── Jauge circulaire force saisonnière ─────────────────────────────────────────
function SeasonalForceGauge({ score }) {
  const R = 32, cx = 44, cy = 44;
  const circ = 2 * Math.PI * R;
  const safe = typeof score === "number" ? Math.max(0, Math.min(100, score)) : 0;
  const offset = circ * (1 - safe / 100);
  const color = safe >= 65 ? C.green : safe >= 35 ? C.yellow : C.red;
  const label = safe >= 65 ? "Favorable" : safe >= 35 ? "Modéré" : "Faible";
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:"2px" }}>
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(143,163,191,0.1)" strokeWidth="7" />
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`} style={{ transition:"stroke-dashoffset 0.7s ease" }} />
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="18" fontWeight="800" fill={C.text}>{score ?? "—"}</text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize="8.5" fill={C.textFaint}>/100</text>
      </svg>
      <div style={{ fontSize:"10px", fontWeight:700, color, letterSpacing:"0.05em" }}>{label}</div>
    </div>
  );
}

// ─── Histogramme mensuel (rendement + probabilité hausse) ───────────────────────
function MonthlyBarChart({ months }) {
  if (!months?.length) return <div style={{ color:C.textFaint, textAlign:"center", padding:"28px 0", fontSize:"12px" }}>Données mensuelles non disponibles</div>;
  const aligned = MONTH_ABBREV.map((label, i) => {
    const m = months.find((x) => x.month === i + 1);
    return { label, avgReturn: m?.avgReturn ?? null, winRate: m?.winRate ?? null, verdict: m?.verdict ?? null };
  });
  const W = 560, H = 138;
  const PAD = { left:36, right:6, top:14, bottom:28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const maxAbs = Math.max(...aligned.map((m) => Math.abs(m.avgReturn ?? 0)), 0.03);
  const barW   = (chartW / 12) * 0.65;
  const spacing = chartW / 12;
  const zeroY  = PAD.top + chartH / 2;
  const gridLines = [-0.03, 0, 0.03].map((v) => ({
    y: zeroY - (v / maxAbs) * (chartH / 2),
    label: v === 0 ? "0%" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`,
  }));
  const buildTooltip = (m) => {
    const parts = [`${m.label} — rendement moy. ${m.avgReturn != null ? formatPct(m.avgReturn) : "—"}`];
    if (m.winRate != null) parts.push(`Probabilité hausse : ${formatWinRate(m.winRate)}`);
    if (m.verdict) parts.push(`Statut : ${verdictLabel(m.verdict)}`);
    return parts.join(" · ");
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", display:"block" }} preserveAspectRatio="xMidYMid meet">
      {gridLines.map((gl, gi) => (
        <g key={gi}>
          <line x1={PAD.left} y1={gl.y} x2={W - PAD.right} y2={gl.y}
            stroke={gi === 1 ? "rgba(143,163,191,0.25)" : "rgba(143,163,191,0.1)"}
            strokeWidth={gi === 1 ? 1 : 0.5} />
          <text x={PAD.left - 4} y={gl.y + 3.5} textAnchor="end" fontSize="7.5" fill={C.textFaint}>{gl.label}</text>
        </g>
      ))}
      {aligned.map((m, i) => {
        const x = PAD.left + i * spacing + spacing / 2;
        const ret = m.avgReturn ?? 0;
        const barH = Math.abs(ret) / maxAbs * (chartH / 2);
        const y = ret >= 0 ? zeroY - barH : zeroY;
        const fill = m.avgReturn === null ? "rgba(143,163,191,0.2)"
          : ret > 0.01 ? C.green : ret > 0 ? "#86efac"
          : ret < -0.01 ? C.red : ret < 0 ? "#fca5a5"
          : "rgba(143,163,191,0.35)";
        const winPct = m.winRate != null ? `${Math.round(m.winRate * 100)}%` : null;
        return (
          <g key={i} style={{ cursor: "default" }}>
            <title>{buildTooltip(m)}</title>
            <rect x={x - barW / 2} y={y} width={barW} height={Math.max(barH, 1.5)} fill={fill} rx="1.5" opacity="0.85" />
            {m.avgReturn !== null && Math.abs(ret) > 0.005 && (
              <text x={x} y={ret >= 0 ? y - 2 : y + barH + 8} textAnchor="middle" fontSize="7" fill={fill} opacity="0.9">
                {formatPct(ret)}
              </text>
            )}
            {winPct && (
              <text x={x} y={H - 13} textAnchor="middle" fontSize="6.5" fill={C.textFaint} opacity="0.85">{winPct}</text>
            )}
            <text x={x} y={H - 4} textAnchor="middle" fontSize="8" fill={C.textFaint}>{m.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Courbe cumulée (+ zones swing) ─────────────────────────────────────────────
function CumulativeLineChart({ months, swingWindows }) {
  if (!months?.length) return <div style={{ color:C.textFaint, textAlign:"center", padding:"36px 0", fontSize:"12px" }}>Courbe cumulée non disponible</div>;
  const aligned = MONTH_ABBREV.map((label, i) => {
    const m = months.find((x) => x.month === i + 1);
    return { label, avgReturn: m?.avgReturn ?? 0 };
  });
  const cumPoints = [{ label:"Départ", cum:0 }];
  let cum = 0;
  for (const m of aligned) { cum += m.avgReturn; cumPoints.push({ label:m.label, cum }); }
  const W = 600, H = 185;
  const PAD = { left:40, right:18, top:32, bottom:28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const chartRight = W - PAD.right;
  const chartLeft = PAD.left;
  const minV = Math.min(...cumPoints.map((p) => p.cum), -0.02);
  const maxV = Math.max(...cumPoints.map((p) => p.cum), 0.05);
  const range = maxV - minV || 0.1;
  const xOf = (i) => PAD.left + (i / (cumPoints.length - 1)) * chartW;
  const xOfDay = (doy) => PAD.left + ((Math.min(365, Math.max(1, doy)) - 1) / 364) * chartW;
  const yOf = (v) => PAD.top + (1 - (v - minV) / range) * chartH;
  const linePath = cumPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(p.cum).toFixed(1)}`).join(" ");
  const zeroY = yOf(0);
  const areaPath = `${linePath} L ${xOf(cumPoints.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L ${xOf(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;
  const gridLines = Array.from({ length: 5 }, (_, i) => { const v = minV + (range / 4) * i; return { v, y: yOf(v) }; });
  const finalColor = cum >= 0 ? "#8b5cf6" : C.red;

  const swingZones = [];
  (swingWindows?.bullish ?? []).slice(0, 2).forEach((sw, i) => {
    const rangeDOY = resolveSwingDayRange(sw);
    if (rangeDOY) {
      swingZones.push({
        ...rangeDOY,
        kind: "bullish",
        label: `Haussier #${i + 1}`,
        avgReturn: sw.avgReturn,
      });
    }
  });
  (swingWindows?.bearish ?? []).slice(0, 2).forEach((sw, i) => {
    const rangeDOY = resolveSwingDayRange(sw);
    if (rangeDOY) {
      swingZones.push({
        ...rangeDOY,
        kind: "bearish",
        label: `Baissier #${i + 1}`,
        avgReturn: sw.avgReturn,
      });
    }
  });
  const hasSwingOverlay = swingZones.length > 0;
  const todayDOY = getTodayDayOfYear();
  const todayX = xOfDay(todayDOY);
  const zoneTop = PAD.top;
  const zoneBottom = PAD.top + chartH;
  const labelCtx = { zoneTop, chartH, chartRight, chartLeft, chartW };

  const zoneLabelPlacements = hasSwingOverlay
    ? swingZones.map((zone) => resolveSwingZoneLabelPlacement(zone, xOfDay, labelCtx))
    : [];

  const renderZoneRects = (zone) => {
    const fill = zone.kind === "bullish"
      ? "rgba(34,197,94,0.14)"
      : "rgba(239,68,68,0.14)";
    const stroke = zone.kind === "bullish"
      ? "rgba(34,197,94,0.35)"
      : "rgba(239,68,68,0.35)";
    return swingZoneSegments(zone).map(([s, e], segIdx) => {
      const x1 = xOfDay(s);
      const x2 = xOfDay(e);
      const left = Math.min(x1, x2);
      const width = Math.max(Math.abs(x2 - x1), 2);
      return (
        <rect
          key={`${zone.label}-${segIdx}`}
          x={left}
          y={zoneTop}
          width={width}
          height={zoneBottom - zoneTop}
          fill={fill}
          stroke={stroke}
          strokeWidth="0.5"
          rx="2"
        />
      );
    });
  };

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", display:"block" }} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={finalColor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={finalColor} stopOpacity="0.02" />
          </linearGradient>
          <filter id="cumGlow"><feGaussianBlur stdDeviation="2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {hasSwingOverlay && swingZones.map((zone) => (
          <g key={zone.label}>{renderZoneRects(zone)}</g>
        ))}
        {gridLines.map((gl, gi) => (
          <g key={gi}>
            <line x1={PAD.left} y1={gl.y} x2={W - PAD.right} y2={gl.y}
              stroke={Math.abs(gl.v) < 0.001 ? "rgba(143,163,191,0.3)" : "rgba(143,163,191,0.07)"}
              strokeWidth={Math.abs(gl.v) < 0.001 ? 1 : 0.5} />
            <text x={PAD.left - 4} y={gl.y + 3.5} textAnchor="end" fontSize="7.5" fill={C.textFaint}>
              {gl.v >= 0 ? "+" : ""}{(gl.v * 100).toFixed(0)}%
            </text>
          </g>
        ))}
        <path d={areaPath} fill="url(#cumGrad)" />
        <path d={linePath} fill="none" stroke={finalColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hasSwingOverlay && swingZones.map((zone, zi) => {
          const labelColor = zone.kind === "bullish" ? C.green : C.red;
          const placement = zoneLabelPlacements[zi];
          if (!placement) return null;
          return (
            <text
              key={`lbl-${zone.label}-${zone.kind}`}
              x={placement.x}
              y={placement.y}
              textAnchor={placement.textAnchor}
              fontSize={placement.fontSize}
              fill={labelColor}
              fontWeight="700"
              opacity="0.92"
              style={{ pointerEvents:"none" }}
            >
              {placement.labelText}
            </text>
          );
        })}
        <line
          x1={todayX}
          y1={zoneTop}
          x2={todayX}
          y2={zoneBottom}
          stroke="rgba(167,139,250,0.85)"
          strokeWidth="1.25"
          strokeDasharray="4 3"
        />
        <circle cx={xOf(0)} cy={yOf(0)} r="3" fill={C.panel} stroke={finalColor} strokeWidth="1.5" />
        <circle cx={xOf(cumPoints.length - 1)} cy={yOf(cum)} r="3" fill={finalColor} filter="url(#cumGlow)" />
        <g>
          <rect
            x={todayX - 26}
            y={PAD.top - 15}
            width={52}
            height={11}
            fill={C.panel}
            opacity="0.92"
            rx="2"
          />
          <text
            x={todayX}
            y={PAD.top - 6}
            textAnchor="middle"
            fontSize="7.5"
            fill={C.accentLight}
            fontWeight="600"
          >
            Aujourd&apos;hui
          </text>
        </g>
        {cumPoints.slice(1).map((p, i) => (
          <text key={i} x={xOf(i + 1).toFixed(1)} y={H - 6} textAnchor="middle" fontSize="8.5" fill={C.textFaint}>{p.label}</text>
        ))}
      </svg>
      {hasSwingOverlay && (
        <div style={{ display:"flex", flexWrap:"wrap", gap:"12px 16px", marginTop:"8px", fontSize:"10px", color:C.textMuted }}>
          <span style={{ display:"inline-flex", alignItems:"center", gap:"6px" }}>
            <span style={{ width:12, height:10, borderRadius:2, background:"rgba(34,197,94,0.35)", border:"1px solid rgba(34,197,94,0.5)" }} />
            Vert = fenêtre swing haussière
          </span>
          <span style={{ display:"inline-flex", alignItems:"center", gap:"6px" }}>
            <span style={{ width:12, height:10, borderRadius:2, background:"rgba(239,68,68,0.35)", border:"1px solid rgba(239,68,68,0.5)" }} />
            Rouge = fenêtre swing baissière
          </span>
          <span style={{ display:"inline-flex", alignItems:"center", gap:"6px" }}>
            <span style={{ width:14, height:0, borderTop:`2px solid ${finalColor}` }} />
            Ligne = saisonnalité cumulée moyenne
          </span>
          <span style={{ display:"inline-flex", alignItems:"center", gap:"6px" }}>
            <span style={{ width:14, height:0, borderTop:"1.25px dashed rgba(167,139,250,0.85)" }} />
            Pointillé = aujourd&apos;hui
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Tableau court terme CSP/CC ─────────────────────────────────────────────────
function ShortTermTable({ shortTerm }) {
  if (!shortTerm?.windows?.length) return <div style={{ color:C.textFaint, fontSize:"12px", padding:"18px 0" }}>Données court terme non disponibles.</div>;
  const windows = shortTerm.windows;
  const thBase = { padding:"6px 8px", fontSize:"9.5px", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:C.textFaint, borderBottom:`1px solid ${C.border}`, background:C.cardInner, whiteSpace:"nowrap" };
  const tdBase = { padding:"9px 8px", fontSize:"11.5px", color:C.text, borderBottom:`1px solid rgba(120,150,190,0.07)`, verticalAlign:"middle" };
  return (
    <div>
      <div style={{ overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:"520px" }}>
          <thead>
            <tr>
              <th style={{ ...thBase, textAlign:"left" }}>Fenêtre</th>
              <th style={{ ...thBase, textAlign:"right" }}>% Haussier</th>
              <th style={{ ...thBase, textAlign:"right" }}>Rend. moy.</th>
              <th style={{ ...thBase, textAlign:"right" }}>Pire rend.</th>
              <th style={{ ...thBase, textAlign:"right" }}>Baisse &gt;5%</th>
              <th style={{ ...thBase, textAlign:"right" }}>Baisse &gt;10%</th>
              <th style={{ ...thBase, textAlign:"center" }}>CSP</th>
              <th style={{ ...thBase, textAlign:"center" }}>CC</th>
            </tr>
          </thead>
          <tbody>
            {windows.map((w, ri) => (
              <tr key={ri}>
                <td style={{ ...tdBase, textAlign:"left", fontWeight:600, color:C.accentLight }}>{w.label ?? "—"}</td>
                <td style={{ ...tdBase, textAlign:"right" }}>{formatWinRate(w.winRate)}</td>
                <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.avgReturn), fontWeight:600 }}>{formatPct(w.avgReturn)}</td>
                <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.worstReturn) }}>{formatPct(w.worstReturn)}</td>
                <td style={{ ...tdBase, textAlign:"right", color:w.pctBelow5 > 0.2 ? C.red : w.pctBelow5 > 0.12 ? C.yellow : C.text }}>{formatWinRate(w.pctBelow5)}</td>
                <td style={{ ...tdBase, textAlign:"right", color:w.pctBelow10 > 0.12 ? C.red : C.text }}>{formatWinRate(w.pctBelow10)}</td>
                <td style={{ ...tdBase, textAlign:"center" }}><VerdictBadge verdict={w.cspVerdict} /></td>
                <td style={{ ...tdBase, textAlign:"center" }}><VerdictBadge verdict={w.ccVerdict} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shortTerm.summary && (
        <div style={{ marginTop:"8px", fontSize:"10.5px", color:C.textFaint, fontStyle:"italic" }}>
          Meilleure fenêtre CSP : <strong style={{ color:C.textMuted }}>{seasonalWindowPrimaryLabel(shortTerm.summary.bestCspWindow)}</strong>
          {" · "}Fenêtre CC : <strong style={{ color:C.textMuted }}>{seasonalWindowPrimaryLabel(shortTerm.summary.bestCcWindow)}</strong>
          {" · "}Source : {shortTerm.summary.source ?? "Yahoo Finance"}
          {" · "}Cache {shortTerm.summary.cacheTtlHours}h
        </div>
      )}
    </div>
  );
}

// ─── Calendrier heatmap mensuel ─────────────────────────────────────────────────
function CalendarHeatmap({ calendar }) {
  if (!calendar?.months?.length) return <div style={{ color:C.textFaint, fontSize:"12px", padding:"18px 0" }}>Données calendrier non disponibles.</div>;
  const aligned = MONTH_ABBREV.map((label, i) => {
    const m = calendar.months.find((x) => x.month === i + 1);
    return { label, ...(m ?? {}) };
  });
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(6, 1fr)", gap:"6px" }}>
        {aligned.map((m, i) => {
          const ret = m.avgReturn;
          const bg = ret === undefined ? "rgba(143,163,191,0.05)"
            : ret > 0.03 ? "rgba(34,197,94,0.2)" : ret > 0 ? "rgba(34,197,94,0.1)"
            : ret < -0.03 ? "rgba(239,68,68,0.2)" : "rgba(239,68,68,0.1)";
          const textColor = ret === undefined ? C.textFaint : ret > 0 ? C.green : ret < 0 ? C.red : C.textMuted;
          return (
            <div key={i} style={{ background:bg, border:`1px solid ${C.border}`, borderRadius:"7px", padding:"8px 6px", textAlign:"center" }}>
              <div style={{ fontSize:"9px", color:C.textFaint, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase" }}>{m.label}</div>
              <div style={{ fontSize:"14px", fontWeight:700, color:textColor, margin:"3px 0 1px" }}>{ret !== undefined ? formatPct(ret) : "—"}</div>
              <div style={{ fontSize:"8.5px", color:C.textFaint }}>{m.winRate !== undefined ? `${Math.round(m.winRate * 100)}%` : ""}</div>
              {m.verdict && <div style={{ marginTop:"3px" }}><VerdictBadge verdict={m.verdict} /></div>}
            </div>
          );
        })}
      </div>
      {calendar.summary && (
        <div style={{ marginTop:"8px", fontSize:"10px", color:C.textFaint }}>
          Source : {calendar.summary.source ?? "Yahoo Finance"}
          {calendar.summary.yearsCovered != null ? ` · ${calendar.summary.yearsCovered} ans` : ""}
          {" · "}Cache {calendar.summary.cacheTtlHours}h
        </div>
      )}
    </div>
  );
}

// ─── Panneau compact swing (fenêtre active + fenêtres clés) ───────────────────

const CHART3Y_PACE_LABELS = {
  behind: "En retard",
  on_track: "Normal",
  ahead: "En avance",
  too_advanced: "Très avancé",
};

function formatPctWhole(val) {
  if (typeof val !== "number" || !isFinite(val)) return "—";
  if (val >= 0 && val <= 1) return `${Math.round(val * 100)} %`;
  if (val > 1 && val <= 100) return `${Math.round(val)} %`;
  return "—";
}

/** Nombre d'occurrences du primaryHorizon — jamais totalOccurrences (horizons chevauchants). */
function getSampleSize(window) {
  if (!window || typeof window !== "object") return null;
  const totalOcc = typeof window.totalOccurrences === "number" ? window.totalOccurrences : null;
  const occ = typeof window.occurrences === "number" ? window.occurrences : null;
  const candidates = [
    window.displaySampleSize,
    window.primaryHorizonSampleSize,
    window.primaryHorizon && window.horizonStats?.[window.primaryHorizon]?.sampleSize,
    window.sampleSize,
  ];
  if (occ != null && (totalOcc == null || occ !== totalOcc)) {
    candidates.push(occ);
  }
  candidates.push(window.years, window.observations, window.occurrencesCount);
  for (const n of candidates) {
    if (typeof n === "number" && isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function getPrimaryHorizonSuffix(window) {
  const h = window?.primaryHorizon;
  return h ? ` ${h}` : "";
}

function getSwingDisplayReturn(window) {
  if (typeof window?.displayAvgReturn === "number" && isFinite(window.displayAvgReturn)) {
    return window.displayAvgReturn;
  }
  return window?.avgReturn ?? null;
}

/** Taux directionnel : haussier pour bullish, baissier pour bearish (winRate backend = % haussier). */
function getDirectionalWinRate(window, type) {
  if (!window) return null;
  const isBullish = type === "bullish" || type === true;

  if (typeof window.displayWinRate === "number" && isFinite(window.displayWinRate)) {
    const dr = normalizeRate(window.displayWinRate);
    if (dr != null) return dr;
  }

  if (isBullish && typeof window.bullishWinRate === "number") {
    return normalizeRate(window.bullishWinRate);
  }
  if (!isBullish && typeof window.bearishWinRate === "number") {
    return normalizeRate(window.bearishWinRate);
  }
  if (!isBullish && typeof window.downRate === "number") {
    return normalizeRate(window.downRate);
  }

  const winRate = normalizeRate(window.winRate);
  if (winRate == null) return null;
  return isBullish ? winRate : 1 - winRate;
}

const DAYS_IN_MONTH_ISO = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function doyToIsoDate(year, doy) {
  let remaining = Math.max(1, Math.min(366, doy));
  for (let m = 1; m <= 12; m++) {
    const dim = DAYS_IN_MONTH_ISO[m];
    if (remaining <= dim) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${year}-${pad(m)}-${pad(remaining)}`;
    }
    remaining -= dim;
  }
  return `${year}-12-31`;
}

function getTodayIsoUtc() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetweenIso(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00.000Z`).getTime();
  const b = new Date(`${toIso}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86400000);
}

/** Prochaine date de début d'une fenêtre swing dans l'année courante ou suivante. */
function resolveNextWindowStartIso(window, todayIso = getTodayIsoUtc()) {
  const year = parseInt(String(todayIso).slice(0, 4), 10);
  if (!year) return null;

  if (window.startDayOfYear != null) {
    const startThisYear = doyToIsoDate(year, window.startDayOfYear);
    if (startThisYear >= todayIso) return startThisYear;
    return doyToIsoDate(year + 1, window.startDayOfYear);
  }

  if (window.startMonth != null) {
    const sm = window.startMonth;
    const sd = window.startDay ?? 15;
    const pad = (n) => String(n).padStart(2, "0");
    const startThisYear = `${year}-${pad(sm)}-${pad(sd)}`;
    if (startThisYear >= todayIso) return startThisYear;
    return `${year + 1}-${pad(sm)}-${pad(sd)}`;
  }

  if (window.displayLabel?.includes("→")) {
    const startPart = window.displayLabel.split("→")[0].trim();
    const parsed = parseFrenchDayMonth(startPart);
    if (parsed) {
      const startThisYear = doyToIsoDate(year, dayOfYearFromMonthDay(parsed.month, parsed.day));
      if (startThisYear >= todayIso) return startThisYear;
      return doyToIsoDate(year + 1, dayOfYearFromMonthDay(parsed.month, parsed.day));
    }
  }

  return null;
}

function isRobustOrMeasurable(window) {
  const conf = String(getWindowDisplayConfidence(window)).toLowerCase();
  return conf.includes("robuste") || conf === "mesurable";
}

function upcomingDistanceLabel(daysUntil) {
  if (daysUntil <= 14) return "Fenêtre imminente";
  if (daysUntil <= 30) return "Préparation idéale";
  if (daysUntil <= 45) return "Surveillance avancée";
  return null;
}

function confidenceRank(window) {
  const conf = getWindowDisplayConfidence(window);
  const v = String(conf ?? "").toLowerCase();
  if (v.includes("multi")) return 4;
  if (v === "robuste" || v === "robuste possible") return 3;
  if (v === "mesurable") return 2;
  if (v === "préliminaire" || v === "preliminaire") return 1;
  if (v === "échantillon limité") return 0;
  return 0;
}

/** Fenêtre haussière robuste/mesurable dont le début est dans 14–45 jours (pas active). */
function pickUpcomingBullishWindow(windows, activeProgress) {
  if (activeProgress?.isActive) return null;

  const bullish = windows?.swingWindows?.bullish ?? [];
  const todayIso = getTodayIsoUtc();
  const candidates = [];

  for (const w of bullish) {
    if (!isRobustOrMeasurable(w)) continue;
    const startIso = resolveNextWindowStartIso(w, todayIso);
    if (!startIso) continue;
    const daysUntil = daysBetweenIso(todayIso, startIso);
    if (daysUntil < 14 || daysUntil > 45) continue;
    candidates.push({
      window: w,
      startIso,
      daysUntil,
      distanceLabel: upcomingDistanceLabel(daysUntil),
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const confDiff = confidenceRank(b.window) - confidenceRank(a.window);
    if (confDiff !== 0) return confDiff;
    const winA = getDirectionalWinRate(a.window, "bullish") ?? 0;
    const winB = getDirectionalWinRate(b.window, "bullish") ?? 0;
    if (winB !== winA) return winB - winA;
    if (a.daysUntil !== b.daysUntil) return a.daysUntil - b.daysUntil;
    return (b.window.avgReturn ?? 0) - (a.window.avgReturn ?? 0);
  });

  return candidates[0];
}

function buildCombinedMomentumReading({ upcoming, rsiMomentum, activeProgress }) {
  if (!rsiMomentum) return null;

  const rsi = rsiMomentum.rsiCurrent;
  const rising = rsiMomentum.rising;
  const near50 = rsiMomentum.approaching50FromBelow || rsiMomentum.crossedAbove50Recently
    || (rsi >= 45 && rsi < 55);

  if (activeProgress?.isActive) {
    const isBull = activeProgress.type === "bullish";
    if (!isBull) {
      return {
        headline: rsiMomentum.label,
        detail: "Fenêtre baissière active — prudence sur le momentum.",
      };
    }
    if (rsi >= 70) {
      return {
        headline: "Fenêtre active, mouvement avancé",
        detail: "Fenêtre favorable, mais RSI déjà en surchauffe. Surveillance prudente.",
      };
    }
    if (rsi >= 45 && rsi <= 60 && rising) {
      return {
        headline: "Fenêtre active avec momentum favorable",
        detail: "RSI en pente montante pendant la fenêtre haussière active.",
      };
    }
    return {
      headline: rsiMomentum.label,
      detail: "Fenêtre active — momentum à confirmer avant d'accélérer.",
    };
  }

  if (!upcoming) return null;

  const days = upcoming.daysUntil;
  const daysText = days === 1 ? "1 jour" : `${days} jours`;

  if (rsi >= 70) {
    return {
      headline: "Fenêtre favorable, RSI élevé",
      detail: `Fenêtre haussière dans ${daysText}, mais RSI déjà en surchauffe. Prudence.`,
    };
  }
  if (rsiMomentum.crossedAbove50Recently) {
    return {
      headline: "Momentum naissant",
      detail: `RSI vient de repasser au-dessus de 50. Fenêtre haussière dans ${daysText}.`,
    };
  }
  if (rising && near50) {
    return {
      headline: "Préparation momentum",
      detail: `Fenêtre haussière robuste dans ${daysText}. RSI en pente montante près de 50.`,
    };
  }
  if (rising) {
    return {
      headline: "Surveillance momentum",
      detail: `Fenêtre favorable dans ${daysText}. RSI montant — confirmer avant activation.`,
    };
  }
  return {
    headline: upcoming.distanceLabel ?? "Surveillance avancée",
    detail: `Fenêtre haussière dans ${daysText}. RSI pas encore en phase de préparation.`,
  };
}

function formatWindowConfidenceDetails(window, type) {
  const sample = getSampleSize(window);
  const conf = getWindowDisplayConfidence(window);
  const rateFrac = getDirectionalWinRate(window, type);
  const typeWord = type === "bullish" || type === true ? "haussier" : "baissier";
  const occLabel = formatOccurrenceCount(sample);
  const horizonSuffix = getPrimaryHorizonSuffix(window);

  if (rateFrac != null && occLabel) {
    return `${Math.round(rateFrac * 100)} % ${typeWord} sur ${occLabel}${horizonSuffix} · ${conf}`;
  }
  if (rateFrac != null) {
    return `${Math.round(rateFrac * 100)} % ${typeWord} · ${conf}`;
  }
  if (occLabel) {
    return `${occLabel} testée${sample === 1 ? "" : "s"} · ${conf}`;
  }
  if (conf && conf !== "—") {
    return conf === "Historique disponible" ? conf : `Historique disponible · ${conf}`;
  }
  return null;
}

/** Enrichit swingOverlays chart-3y avec sampleSize depuis /windows (même ticker, déjà chargé). */
function enrichChart3yWithWindowStats(chartData, windows) {
  if (!chartData?.swingOverlays?.length || !windows?.swingWindows) return chartData;

  const lookup = new Map();
  for (const w of [
    ...(windows.swingWindows.bullish ?? []),
    ...(windows.swingWindows.bearish ?? []),
  ]) {
    if (w?.displayLabel) lookup.set(w.displayLabel, w);
  }
  if (lookup.size === 0) return chartData;

  return {
    ...chartData,
    swingOverlays: chartData.swingOverlays.map((overlay) => {
      const src = lookup.get(overlay.displayLabel);
      if (!src) return overlay;
      const sampleSize = getSampleSize(src);
      return {
        ...overlay,
        ...(sampleSize != null ? { sampleSize } : {}),
        displaySampleSize: src.displaySampleSize ?? sampleSize,
        primaryHorizon: src.primaryHorizon ?? overlay.primaryHorizon,
        primaryHorizonSampleSize: src.primaryHorizonSampleSize ?? overlay.primaryHorizonSampleSize,
        displayWinRate: src.displayWinRate ?? overlay.displayWinRate,
        displayAvgReturn: src.displayAvgReturn ?? overlay.displayAvgReturn,
        displayConfidence: src.displayConfidence ?? overlay.displayConfidence,
        multiHorizonConfidence: src.multiHorizonConfidence ?? overlay.multiHorizonConfidence,
        confirmedHorizons: src.confirmedHorizons ?? overlay.confirmedHorizons,
        horizonStats: src.horizonStats ?? overlay.horizonStats,
        winRate: src.displayWinRate ?? src.winRate ?? overlay.winRate,
        expectedReturn: getSwingDisplayReturn(src) ?? overlay.expectedReturn,
        confidence: src.displayConfidence ?? src.multiHorizonConfidence ?? src.confidence ?? overlay.confidence,
      };
    }),
  };
}

function CompactWindowLine({ window: w, isBullish }) {
  const label = seasonalWindowPrimaryLabel(w);
  const details = formatWindowConfidenceDetails(w, isBullish ? "bullish" : "bearish");
  const confirmedLine = formatHorizonConfirmedLine(w);
  const matrixTitle = formatHorizonStatsMatrix(w?.horizonStats, isBullish);
  return (
    <div style={{ padding: "4px 0", lineHeight: 1.45 }} title={matrixTitle ?? undefined}>
      <div style={{ fontSize: "11px", color: C.textMuted }}>
        <span style={{ color: C.text, fontWeight: 600 }}>{label}</span>
        {" · "}
        <span style={{ color: pctColor(getSwingDisplayReturn(w)), fontWeight: 700 }}>{formatPct(getSwingDisplayReturn(w))}</span>
      </div>
      {details && (
        <div style={{ fontSize: "10px", color: C.textFaint, marginTop: "2px", fontWeight: 500 }}>
          {details}
        </div>
      )}
      {confirmedLine && (
        <div style={{ fontSize: "9.5px", color: C.accentLight, marginTop: "2px", fontWeight: 600 }}>
          {confirmedLine}
        </div>
      )}
    </div>
  );
}

function SeasonalPreparationBlock({ upcoming, rsiMomentum, combinedReading }) {
  if (!upcoming?.window) return null;
  const w = upcoming.window;
  const label = seasonalWindowPrimaryLabel(w);
  const details = formatWindowConfidenceDetails(w, "bullish");
  const daysText = upcoming.daysUntil === 1 ? "1 jour" : `${upcoming.daysUntil} jours`;

  return (
    <div style={{
      borderTop: `1px solid ${C.border}`,
      paddingTop: "9px",
    }}>
      <div style={{
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: C.green,
        marginBottom: "8px",
      }}>
        Préparation saisonnière
      </div>
      <div style={{ fontSize: "14px", fontWeight: 700, color: C.text, marginBottom: "4px", lineHeight: 1.4 }}>
        {label}
      </div>
      <div style={{ fontSize: "11px", color: C.textMuted, marginBottom: "6px" }}>
        Début dans {daysText}
        {upcoming.distanceLabel && (
          <span style={{ color: C.accentLight, fontWeight: 600 }}> · {upcoming.distanceLabel}</span>
        )}
      </div>
      <div style={{ fontSize: "11px", color: pctColor(getSwingDisplayReturn(w)), fontWeight: 700, marginBottom: "4px" }}>
        {formatPct(getSwingDisplayReturn(w))} attendu historique
      </div>
      {details && (
        <div style={{ fontSize: "10px", color: C.textFaint, marginBottom: "8px", lineHeight: 1.45 }}>
          {details}
        </div>
      )}
      {rsiMomentum && (
        <div style={{ fontSize: "11px", color: C.textMuted, lineHeight: 1.5 }}>
          <span style={{ color: C.text, fontWeight: 600 }}>
            RSI 14 : {rsiMomentum.rsiCurrent.toFixed(1)}
          </span>
          {" · "}
          <span style={{ color: C.accentLight }}>{rsiMomentum.label}</span>
        </div>
      )}
      {combinedReading?.detail && (
        <div style={{
          marginTop: "6px",
          fontSize: "10px",
          color: C.textFaint,
          fontStyle: "italic",
          lineHeight: 1.5,
        }}>
          {combinedReading.detail}
        </div>
      )}
    </div>
  );
}

function SwingCompactSidePanel({
  activeProgress,
  windows,
  chart3yLoading,
  rsiMomentum,
  upcoming,
  combinedReading,
}) {
  const bullish = getSwingOrDistinctBullish(windows ?? {});
  const bearish = getSwingOrDistinctBearish(windows ?? {});
  const bullRows = bullish.rows.slice(0, 2);
  const bearRows = bearish.rows.slice(0, 2);
  const active = activeProgress;
  const hasWindows = bullRows.length > 0 || bearRows.length > 0;
  const showPreparation = !active?.isActive && upcoming?.window;

  const miniLabel = {
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: C.textMuted,
    marginBottom: "6px",
  };
  const cellLabel = { fontSize: "10.5px", color: C.textFaint, marginBottom: "3px", fontWeight: 600 };
  const cellVal = { fontSize: "15px", fontWeight: 700, color: C.text, lineHeight: 1.25 };
  const cellValSecondary = { fontSize: "14px", fontWeight: 700, color: C.text, lineHeight: 1.25 };
  const typeBadge = (isBull) => ({
    marginLeft: "8px",
    fontSize: "10.5px",
    fontWeight: 700,
    padding: "3px 9px",
    borderRadius: "10px",
    background: isBull ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
    border: `1px solid ${isBull ? "rgba(34,197,94,0.38)" : "rgba(239,68,68,0.38)"}`,
    color: isBull ? C.green : C.red,
    verticalAlign: "middle",
  });
  const paceBadge = (pace) => {
    const color = pace === "behind" ? C.yellow
      : pace === "too_advanced" ? C.accentLight
        : pace === "ahead" ? C.green
          : C.text;
    const bg = pace === "behind" ? "rgba(250,204,21,0.12)"
      : pace === "too_advanced" ? "rgba(167,139,250,0.12)"
        : pace === "ahead" ? "rgba(34,197,94,0.12)"
          : "rgba(143,163,191,0.14)";
    const border = pace === "behind" ? "rgba(250,204,21,0.32)"
      : pace === "too_advanced" ? "rgba(167,139,250,0.32)"
        : pace === "ahead" ? "rgba(34,197,94,0.32)"
          : "rgba(143,163,191,0.28)";
    return {
      display: "inline-block",
      fontSize: "12px",
      fontWeight: 700,
      padding: "3px 10px",
      borderRadius: "10px",
      background: bg,
      border: `1px solid ${border}`,
      color,
    };
  };

  return (
    <div style={{
      background: C.cardInner,
      border: `1px solid ${C.border}`,
      borderRadius: "10px",
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: "11px",
      height: "100%",
      minHeight: 0,
    }}>
      {/* Fenêtre active */}
      <div>
        <div style={miniLabel}>Fenêtre active</div>
        {chart3yLoading ? (
          <div style={{ fontSize: "11px", color: C.textFaint }}>Chargement…</div>
        ) : active?.isActive ? (
          <>
            <div style={{ fontSize: "15px", fontWeight: 700, color: C.text, marginBottom: "9px", lineHeight: 1.45 }}>
              {active.displayLabel ?? "—"}
              <span style={typeBadge(active.type === "bullish")}>
                {active.type === "bullish" ? "Haussière" : "Baissière"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "7px 14px" }}>
              <div>
                <div style={cellLabel}>Attendu historique</div>
                <div style={{ ...cellVal, color: active.type === "bullish" ? C.green : C.red }}>
                  {formatPct(active.expectedReturn)}
                </div>
              </div>
              <div>
                <div style={cellLabel}>Réalisé actuel</div>
                <div style={{ ...cellVal, color: active.realizedReturn >= 0 ? C.green : C.red }}>
                  {formatPct(active.realizedReturn)}
                </div>
              </div>
              <div>
                <div style={cellLabel}>Temps écoulé</div>
                <div style={cellValSecondary}>{formatPctWhole(active.progressTimePct)}</div>
              </div>
              <div>
                <div style={cellLabel}>Rythme</div>
                <div style={paceBadge(active.paceStatus)}>
                  {CHART3Y_PACE_LABELS[active.paceStatus] ?? "—"}
                </div>
              </div>
              {rsiMomentum && (
                <>
                  <div>
                    <div style={cellLabel}>RSI 14</div>
                    <div style={cellValSecondary}>{rsiMomentum.rsiCurrent.toFixed(1)}</div>
                  </div>
                  <div>
                    <div style={cellLabel}>Momentum</div>
                    <div style={{ ...cellValSecondary, color: C.accentLight, fontSize: "13px" }}>
                      {rsiMomentum.shortLabel ?? rsiMomentum.label}
                    </div>
                  </div>
                </>
              )}
            </div>
            {combinedReading?.headline && (
              <div style={{
                marginTop: "8px",
                fontSize: "10px",
                color: C.textFaint,
                fontStyle: "italic",
                lineHeight: 1.5,
              }}>
                {combinedReading.headline}
                {combinedReading.detail ? ` — ${combinedReading.detail}` : ""}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: "11px", color: C.textMuted }}>Aucune fenêtre swing active</div>
        )}
      </div>

      {showPreparation && (
        <SeasonalPreparationBlock
          upcoming={upcoming}
          rsiMomentum={rsiMomentum}
          combinedReading={combinedReading}
        />
      )}

      {hasWindows && (
        <>
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: "9px" }}>
            <div style={{ ...miniLabel, color: C.green, opacity: 0.9 }}>Haussières</div>
            {bullRows.length === 0
              ? <div style={{ fontSize: "11px", color: C.textFaint }}>—</div>
              : bullRows.map((w, i) => <CompactWindowLine key={i} window={w} isBullish />)}
          </div>
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: "9px" }}>
            <div style={{ ...miniLabel, color: C.red, opacity: 0.9 }}>Baissières</div>
            {bearRows.length === 0
              ? <div style={{ fontSize: "11px", color: C.textFaint }}>—</div>
              : bearRows.map((w, i) => <CompactWindowLine key={i} window={w} isBullish={false} />)}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Meilleures / Pires fenêtres (swing 5–17 sem. en priorité) ───────────────────
// TODO(Patch-2C): afficher « Réalisé cette année » et « Écart vs attendu » quand
// prix début fenêtre active + prix courant seront exposés par l'API graphique 3 ans.

function SwingWindowsList({ rows, isBullish, activeWindows }) {
  if (!rows?.length) {
    return <div style={{ padding:"12px 0", fontSize:"11px", color:C.textFaint, textAlign:"center" }}>Aucune fenêtre</div>;
  }
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"8px" }}>
      {rows.map((sw, i) => {
        const isActive = activeWindows?.some(
          (a) => a.displayLabel && sw.displayLabel && a.displayLabel === sw.displayLabel,
        );
        return (
        <div
          key={i}
          title={formatHorizonStatsMatrix(sw?.horizonStats, isBullish) ?? undefined}
          style={{
            background:C.cardInner,
            border:`1px solid ${C.border}`,
            borderRadius:"8px",
            padding:"10px 12px",
          }}
        >
          <div style={{ fontSize:"12.5px", fontWeight:700, color:C.text, marginBottom:"5px" }}>
            {sw.displayLabel || `${sw.startLabel} → ${sw.endLabel}`}
            {sw.durationWeeks ? (
              <span style={{ fontWeight:500, color:C.textMuted }}> · ~{sw.durationWeeks} sem.</span>
            ) : null}
          </div>
          <div style={{ fontSize:"11px", color:C.textMuted, lineHeight:1.55 }}>
            <span style={{ color:pctColor(getSwingDisplayReturn(sw)), fontWeight:600 }}>{formatPct(getSwingDisplayReturn(sw))}</span>
            {" · "}
            <span>
              {(() => {
                const dirRate = getDirectionalWinRate(sw, isBullish ? "bullish" : "bearish");
                const typeWord = isBullish ? "haussier" : "baissier";
                return dirRate != null
                  ? `${Math.round(dirRate * 100)} % ${typeWord}`
                  : `${isBullish ? "Win" : "% haussier"} ${formatWinRate(sw.winRate)}`;
              })()}
            </span>
            {" · "}
            <span>Pire {formatPct(sw.worstReturn)}</span>
            {" · "}
            <span style={{ fontWeight:600 }}>
              {getWindowDisplayConfidence(sw)}
            </span>
          </div>
          {sw.confidenceReason && (
            <div style={{ fontSize:"10px", color:C.yellow, marginTop:"3px" }}>
              {sw.confidenceReason}
            </div>
          )}
          {isActive && typeof getSwingDisplayReturn(sw) === "number" && (
            <div style={{ fontSize:"10px", color:C.textMuted, marginTop:"4px" }}>
              Attendu historique : {formatPct(getSwingDisplayReturn(sw))}
            </div>
          )}
          {formatHorizonConfirmedLine(sw) && (
            <div style={{ fontSize:"10px", color:C.accentLight, marginTop:"4px", fontWeight:600 }}>
              {formatHorizonConfirmedLine(sw)}
            </div>
          )}
          <div style={{ fontSize:"9.5px", color:C.textFaint, marginTop:"3px", fontStyle:"italic" }}>
            {momentumHintShort(sw, isBullish)}
          </div>
        </div>
        );
      })}
    </div>
  );
}

function BestWorstWindowsCard({ windows }) {
  const hasData = windows?.horizons?.length || windows?.distinct || windows?.swingWindows;
  if (!hasData) {
    return <div style={{ color:C.textFaint, fontSize:"12px", padding:"16px 0" }}>Fenêtres non disponibles.</div>;
  }

  const bullish = getSwingOrDistinctBullish(windows);
  const bearish = getSwingOrDistinctBearish(windows);
  const thBase = { padding:"5px 7px", fontSize:"9px", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:C.textFaint, borderBottom:`1px solid ${C.border}`, background:C.cardInner };
  const tdBase = { padding:"7px 7px", fontSize:"11px", color:C.text, borderBottom:`1px solid rgba(120,150,190,0.07)`, verticalAlign:"middle" };
  const MiniTable = ({ rows, isBullish }) => (
    <table style={{ width:"100%", borderCollapse:"collapse" }}>
      <thead>
        <tr>
          <th style={{ ...thBase, textAlign:"center" }}>#</th>
          <th style={{ ...thBase, textAlign:"left" }}>Fenêtre</th>
          <th style={{ ...thBase, textAlign:"right" }}>% Haussier</th>
          <th style={{ ...thBase, textAlign:"right" }}>Rend. moy.</th>
          <th style={{ ...thBase, textAlign:"right" }}>Pire rend.</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={5} style={{ padding:"12px", textAlign:"center", fontSize:"11px", color:C.textFaint }}>Aucune fenêtre</td></tr>
        ) : rows.map((w, i) => (
          <tr key={i}>
            <td style={{ ...tdBase, textAlign:"center", color:C.textFaint }}>{i + 1}</td>
            <td style={{ ...tdBase, fontWeight:500 }}>
              <SeasonalWindowLabel window={w} />
            </td>
            <td style={{ ...tdBase, textAlign:"right" }}>{formatWinRate(w.winRate)}</td>
            <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.avgReturn), fontWeight:600 }}>{formatPct(w.avgReturn)}</td>
            <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.worstReturn) }}>{formatPct(w.worstReturn)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const bullishTitle = bullish.mode === "swing"
    ? "Meilleures fenêtres haussières — swing 5 à 17 semaines"
    : "Meilleures fenêtres haussières";
  const bearishTitle = bearish.mode === "swing"
    ? "Pires fenêtres baissières — swing 5 à 17 semaines"
    : "Pires fenêtres baissières";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"14px" }}>
      <SeasonalWideContextLine windows={windows} />
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:"12px", padding:"14px 16px" }}>
        <SectionHeader
          title={bullishTitle}
          icon={TrendingUp}
          right={`${bullish.rows.length} fenêtre${bullish.rows.length > 1 ? "s" : ""}`}
        />
        {bullish.mode === "swing"
          ? <SwingWindowsList rows={bullish.rows} isBullish={true} activeWindows={windows?.summary?.activeNow} />
          : <div style={{ overflowX:"auto" }}><MiniTable rows={bullish.rows} isBullish={true} /></div>}
      </div>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:"12px", padding:"14px 16px" }}>
        <SectionHeader
          title={bearishTitle}
          icon={TrendingDown}
          right={`${bearish.rows.length} fenêtre${bearish.rows.length > 1 ? "s" : ""}`}
        />
        {bearish.mode === "swing"
          ? <SwingWindowsList rows={bearish.rows} isBullish={false} activeWindows={windows?.summary?.activeNow} />
          : <div style={{ overflowX:"auto" }}><MiniTable rows={bearish.rows} isBullish={false} /></div>}
      </div>
    </div>
  );
}

// ─── Lecture stratégique ────────────────────────────────────────────────────────
function buildCspReading(shortTerm) {
  const w = shortTerm?.windows?.find((x) => x.days === 7) ?? shortTerm?.windows?.[0];
  if (!w) return { text:"Données court terme insuffisantes.", icon:"neutral" };
  const wl = seasonalWindowPrimaryLabel(w);
  if (w.cspVerdict === "favorable") return { text:`Fenêtre favorable (${wl}). Taux haussier ${formatWinRate(w.winRate)} · Baisse >5% : ${formatWinRate(w.pctBelow5)}. Strike sous lowerBound recommandé. Viser 1 %+ défendable.`, icon:"green" };
  if (w.cspVerdict === "defavorable") return { text:`Risque de baisse élevé sur ${wl} (Baisse >5% : ${formatWinRate(w.pctBelow5)}). Réduire l'agressivité ou attendre.`, icon:"red" };
  return { text:`Fenêtre neutre sur ${wl}. Prime acceptable seulement avec strike prudent sous lowerBound. Surveillez la volatilité.`, icon:"yellow" };
}
function buildCcReading(shortTerm) {
  const w = shortTerm?.windows?.find((x) => x.days === 14) ?? shortTerm?.windows?.find((x) => x.days === 7);
  if (!w) return { text:"Données court terme insuffisantes.", icon:"neutral" };
  const wl = seasonalWindowPrimaryLabel(w);
  if (w.ccVerdict === "risque_hausse") return { text:`Risque de rally élevé sur ${wl} (Rally >5% : ${formatWinRate(w.pctAbove5)}). Éviter les strikes CC trop proches. Attendre un repli.`, icon:"red" };
  if (w.ccVerdict === "favorable") return { text:`Fenêtre peu explosive sur ${wl} (Rally >5% : ${formatWinRate(w.pctAbove5)}). CC acceptable. Strike at-the-money envisageable.`, icon:"green" };
  return { text:`Fenêtre neutre pour CC sur ${wl}. Prudence : choisir strike plus élevé pour éviter le call away.`, icon:"yellow" };
}
function buildLongTermReading(windows) {
  const activeNow = windows?.summary?.activeNow ?? [];
  const bestBullish = windows?.summary?.bestOverallBullish;
  if (activeNow.length > 0) {
    const a = activeNow[0];
    const isBull = a.avgReturn > 0 && a.winRate >= 0.5;
    const al = seasonalWindowPrimaryLabel(a);
    return isBull
      ? { text:`Fenêtre saisonnière forte active : ${al} (${formatPct(a.avgReturn)} · ${formatWinRate(a.winRate)} haussier). Maintenir positions. Période d'accumulation en cours.`, icon:"green" }
      : { text:`Fenêtre saisonnièrement faible : ${al} (${formatPct(a.avgReturn)}). Garder du cash, éviter de suracheter.`, icon:"red" };
  }
  if (bestBullish) {
    const bl = seasonalWindowPrimaryLabel(bestBullish);
    return { text:`Meilleure fenêtre : ${bl} (${formatPct(bestBullish.avgReturn)} · ${formatWinRate(bestBullish.winRate)}). Idéale pour accumuler ou renforcer.`, icon:"yellow" };
  }
  return { text:"Analyser le calendrier mensuel pour planifier les entrées.", icon:"neutral" };
}
function ReadingCard({ title, text, icon: Icon, iconColor, bgColor, borderColor }) {
  return (
    <div style={{ background:bgColor, border:`1px solid ${borderColor}`, borderRadius:"9px", padding:"12px 14px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:"6px", marginBottom:"6px" }}>
        {Icon && <Icon size={13} style={{ color:iconColor }} />}
        <span style={{ fontSize:"10.5px", fontWeight:700, color:iconColor, letterSpacing:"0.06em", textTransform:"uppercase" }}>{title}</span>
      </div>
      <p style={{ fontSize:"11.5px", color:C.text, lineHeight:1.6, margin:0 }}>{text}</p>
    </div>
  );
}
function StrategicReadingSection({ shortTerm, windows }) {
  if (!shortTerm && !windows) return null;
  const csp = buildCspReading(shortTerm);
  const cc  = buildCcReading(shortTerm);
  const lt  = buildLongTermReading(windows);
  const iconStyleMap = {
    green:  { iconColor:C.green,    bgColor:"rgba(34,197,94,0.07)",   borderColor:"rgba(34,197,94,0.2)" },
    red:    { iconColor:C.red,      bgColor:"rgba(239,68,68,0.07)",   borderColor:"rgba(239,68,68,0.2)" },
    yellow: { iconColor:C.yellow,   bgColor:"rgba(250,204,21,0.07)",  borderColor:"rgba(250,204,21,0.2)" },
    neutral:{ iconColor:C.textMuted,bgColor:"rgba(143,163,191,0.07)", borderColor:C.border },
  };
  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"10px" }}>
        <ReadingCard title="CSP — Vente de put"    text={csp.text} icon={Shield}     {...(iconStyleMap[csp.icon] ?? iconStyleMap.neutral)} />
        <ReadingCard title="CC — Covered Call"      text={cc.text}  icon={ArrowUpRight} {...(iconStyleMap[cc.icon] ?? iconStyleMap.neutral)} />
        <ReadingCard title="Investissement long terme" text={lt.text} icon={TrendingUp}  {...(iconStyleMap[lt.icon] ?? iconStyleMap.neutral)} />
      </div>
      <div style={{ marginTop:"8px", fontSize:"9.5px", color:C.textFaint, fontStyle:"italic" }}>
        Les performances passées ne garantissent pas les résultats futurs. Données historiques indicatives uniquement.
      </div>
    </div>
  );
}

// ─── Confiance des données ──────────────────────────────────────────────────────
function DataConfidenceCard({ calendar, shortTerm }) {
  const years = calendar?.summary?.yearsCovered ?? shortTerm?.summary?.yearsCovered ?? null;
  const score = years ? Math.min(100, Math.round(years / 15 * 100)) : null;
  const R = 26, cx = 38, cy = 38;
  const circ = 2 * Math.PI * R;
  const safe = score ?? 0;
  const offset = circ * (1 - safe / 100);
  const color = safe >= 80 ? C.green : safe >= 50 ? C.yellow : C.red;
  const label = safe >= 80 ? "Robuste" : safe >= 50 ? "Mesurable" : "Prélim.";
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:"12px", padding:"16px", minWidth:"160px", display:"flex", flexDirection:"column", alignItems:"center", gap:"10px" }}>
      <div style={{ fontSize:"10px", fontWeight:700, color:C.textFaint, letterSpacing:"0.1em", textTransform:"uppercase" }}>Confiance des données</div>
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(143,163,191,0.1)" strokeWidth="6" />
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`} />
        <text x={cx} y={cy + 1} textAnchor="middle" fontSize="15" fontWeight="800" fill={C.text}>{score ?? "—"}</text>
        <text x={cx} y={cy + 13} textAnchor="middle" fontSize="7" fill={C.textFaint}>/ 100</text>
      </svg>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontSize:"12px", fontWeight:700, color }}>Qualité des données</div>
        <div style={{ fontSize:"11px", color:C.textMuted, marginTop:"2px" }}>{years ? `${years} ans d'historique` : "N/D"}</div>
        <div style={{ fontSize:"10px", color:C.textFaint, marginTop:"4px" }}>
          <span style={{ background:verdictStyleObj(label.toLowerCase()).bg, border:`1px solid ${verdictStyleObj(label.toLowerCase()).border}`, color:verdictStyleObj(label.toLowerCase()).color, padding:"1px 8px", borderRadius:"10px", fontWeight:600 }}>{label}</span>
        </div>
      </div>
      <div style={{ width:"100%", borderTop:`1px solid ${C.border}`, paddingTop:"8px", fontSize:"10px", color:C.textFaint, lineHeight:1.5 }}>
        <div>· Données : Yahoo Finance</div>
        <div>· Marchés : États-Unis</div>
        <div>· Données ajustées dividendes</div>
      </div>
    </div>
  );
}

// ─── Barre horizontale Univers saisonnier ───────────────────────────────────────
function SeasonalUniverseBar({ ticker, onSelectTicker, winRate7j, search, onSearchChange }) {
  const filtered = useMemo(() => {
    const q = String(search ?? "").trim().toUpperCase();
    if (!q) return SEASONAL_UNIVERSE;
    return SEASONAL_UNIVERSE.filter((t) => t.includes(q));
  }, [search]);

  const handleKeyDown = (e) => {
    if (e.key !== "Enter") return;
    const sym = String(search ?? "").trim().toUpperCase();
    if (sym) onSelectTicker(sym);
  };

  const activeSym = String(ticker ?? "").trim().toUpperCase() || "—";
  const showExtraActive = activeSym !== "—" && !filtered.includes(activeSym);

  const chipStyle = (isActive) => ({
    flex: "0 0 auto",
    padding: "4px 9px",
    borderRadius: "5px",
    border: `1px solid ${isActive ? C.borderAccent : C.border}`,
    background: isActive ? "rgba(139,92,246,0.2)" : "rgba(120,150,190,0.06)",
    color: isActive ? C.accentLight : C.textMuted,
    fontSize: "11px",
    fontWeight: isActive ? 700 : 500,
    cursor: "pointer",
    outline: "none",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
    transition: "background 0.12s, border-color 0.12s",
  });

  return (
    <div className="sea-universe-bar" style={{
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: "10px",
      padding: "7px 12px 8px",
      display: "flex",
      flexDirection: "column",
      gap: "5px",
      flexShrink: 0,
    }}>
      {/* Ligne 1 — ticker actif dominant + label discret */}
      <div className="sea-universe-hero" style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "10px",
        minWidth: 0,
      }}>
        <div style={{ minWidth: 0, flex: "1 1 auto", paddingLeft: "8px" }}>
          <div
            className="sea-universe-active-ticker"
            style={{
              fontSize: "clamp(22px, 4.5vw, 26px)",
              fontWeight: 900,
              letterSpacing: "0.06em",
              color: activeSym !== "—" ? C.text : C.textFaint,
              lineHeight: 1.05,
              paddingLeft: "10px",
              borderLeft: activeSym !== "—" ? `3px solid ${C.accent}` : `3px solid ${C.border}`,
              textShadow: activeSym !== "—" ? "0 0 20px rgba(139,92,246,0.18)" : "none",
            }}
            aria-label={`Ticker actif : ${activeSym}`}
          >
            {activeSym}
          </div>
          <div style={{
            fontSize: "10.5px",
            color: C.textMuted,
            marginTop: "3px",
            paddingLeft: "13px",
            lineHeight: 1.35,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            <span>Yahoo Finance</span>
            {typeof winRate7j === "number" && isFinite(winRate7j) && (
              <>
                <span style={{ margin: "0 5px", opacity: 0.45 }}>·</span>
                <span style={{ color: C.green, fontWeight: 600 }}>
                  7j positif : {formatWinRate(winRate7j)}
                </span>
              </>
            )}
          </div>
        </div>
        <span style={{
          fontSize: "9px",
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.textFaint,
          flexShrink: 0,
          paddingTop: "2px",
          whiteSpace: "nowrap",
        }}>
          Univers saisonnier
        </span>
      </div>

      {/* Ligne 2 — recherche + chips */}
      <div className="sea-universe-controls" style={{ display: "flex", alignItems: "center", gap: "8px", minHeight: "26px", minWidth: 0 }}>
        <div style={{ position: "relative", flexShrink: 0, width: "132px" }}>
          <Search size={11} style={{ position: "absolute", left: "7px", top: "50%", transform: "translateY(-50%)", color: C.textFaint, pointerEvents: "none" }} />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            placeholder="Rechercher ticker..."
            aria-label="Rechercher ticker"
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: C.cardInner,
              border: `1px solid ${C.border}`,
              borderRadius: "6px",
              color: C.text,
              padding: "5px 8px 5px 24px",
              fontSize: "10.5px",
              outline: "none",
            }}
          />
        </div>

        <nav className="sea-universe-chips" style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: "4px",
          overflowX: "auto",
          overflowY: "hidden",
          paddingBottom: "1px",
        }}>
          {filtered.length === 0 && !showExtraActive ? (
            <span style={{ fontSize: "10px", color: C.textFaint, whiteSpace: "nowrap" }}>Aucun ticker · Entrée pour charger</span>
          ) : (
            <>
              {showExtraActive && (
                <button type="button" onClick={() => onSelectTicker(activeSym)} className="sea-universe-chip" style={chipStyle(true)}>
                  {activeSym}
                </button>
              )}
              {filtered.map((sym) => (
                <button
                  key={sym}
                  type="button"
                  onClick={() => onSelectTicker(sym)}
                  className="sea-universe-chip"
                  style={chipStyle(sym === activeSym)}
                >
                  {sym}
                </button>
              ))}
            </>
          )}
        </nav>
      </div>
    </div>
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { key:"dashboard", label:"Accueil",    Icon:Home },
  { key:"scanner",   label:"Scanner",    Icon:Search },
  { key:"top20",     label:"Top 20",     Icon:BarChart2 },
  { key:"wheel",     label:"Wheel / CC", Icon:RefreshCw },
  { key:"journal",   label:"Journal POP",Icon:BookOpen },
  { key:"data",      label:"Données",    Icon:Database },
  { key:"seasonality", label:"Saisonnalité", Icon:Activity, active:true },
  { key:"reports",   label:"Rapports",   Icon:FileText },
  { key:"settings",  label:"Paramètres", Icon:Settings },
];
function Sidebar({ onNavigate, ticker, onSelectTicker, lastUpdated }) {
  const handleNav = (key) => {
    if (key === "seasonality") return;
    if (key === "journal" && onNavigate) { onNavigate("journal"); return; }
    if (onNavigate) onNavigate("dashboard");
  };
  return (
    <aside style={{ width:"196px", flexShrink:0, background:C.sidebar, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", minHeight:"100vh" }}>
      {/* Logo */}
      <div style={{ padding:"20px 16px 16px", borderBottom:`1px solid ${C.border}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:"9px" }}>
          <div style={{ width:"30px", height:"30px", borderRadius:"8px", background:"rgba(139,92,246,0.3)", display:"flex", alignItems:"center", justifyContent:"center" }}>
            <Activity size={16} style={{ color:C.accent }} />
          </div>
          <div>
            <div style={{ fontSize:"12px", fontWeight:800, color:C.text, letterSpacing:"0.06em", textTransform:"uppercase", lineHeight:1 }}>Wheel</div>
            <div style={{ fontSize:"9px", color:C.textFaint, fontWeight:600, letterSpacing:"0.08em", textTransform:"uppercase" }}>Dashboard</div>
          </div>
        </div>
      </div>
      {/* Navigation */}
      <nav style={{ flex:1, padding:"12px 8px", display:"flex", flexDirection:"column", gap:"2px" }}>
        {NAV_ITEMS.map(({ key, label, Icon, active }) => (
          <button
            key={key}
            onClick={() => handleNav(key)}
            style={{
              display:"flex", alignItems:"center", gap:"10px",
              padding:"8px 10px", borderRadius:"8px", cursor:"pointer", border:"none", outline:"none",
              background: active ? "rgba(139,92,246,0.18)" : "transparent",
              color: active ? C.accentLight : C.textMuted,
              fontSize:"12.5px", fontWeight: active ? 700 : 500,
              textAlign:"left", width:"100%", transition:"all 0.12s",
            }}
            className="sea-nav-btn"
          >
            <Icon size={15} style={{ opacity: active ? 1 : 0.7, flexShrink:0 }} />
            {label}
            {active && <div style={{ marginLeft:"auto", width:"4px", height:"4px", borderRadius:"50%", background:C.accent }} />}
          </button>
        ))}
      </nav>
      {/* Favoris rapides */}
      <div style={{ padding:"10px 10px 8px", borderTop:`1px solid ${C.border}` }}>
        <div style={{ fontSize:"9px", fontWeight:700, color:C.textFaint, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"6px" }}>Favoris</div>
        <div style={{ display:"flex", flexWrap:"wrap", gap:"4px" }}>
          {QUICK_TICKERS.slice(0, 6).map((t) => (
            <button
              key={t}
              onClick={() => onSelectTicker(t)}
              style={{
                background: t === ticker ? "rgba(139,92,246,0.22)" : "rgba(120,150,190,0.07)",
                border:`1px solid ${t === ticker ? C.borderAccent : C.border}`,
                borderRadius:"5px", color: t === ticker ? C.accentLight : C.textMuted,
                padding:"3px 7px", fontSize:"10px", fontWeight: t === ticker ? 700 : 400,
                cursor:"pointer", outline:"none",
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <button onClick={() => onNavigate?.("dashboard")} style={{ marginTop:"6px", fontSize:"10px", color:C.textFaint, background:"none", border:"none", cursor:"pointer", padding:0, textDecoration:"underline" }}>
          Voir tous (20)
        </button>
      </div>
      {/* Info bas */}
      <div style={{ padding:"10px 12px 16px", borderTop:`1px solid ${C.border}` }}>
        <div style={{ fontSize:"9.5px", color:C.textFaint, lineHeight:1.6 }}>
          <div><span style={{ color:C.textFaint }}>Dernière MAJ</span></div>
          <div style={{ color:C.textMuted, fontWeight:600 }}>{lastUpdated ?? "—"}</div>
          <div style={{ marginTop:"4px" }}>
            <span style={{ background:"rgba(34,197,94,0.1)", border:"1px solid rgba(34,197,94,0.2)", borderRadius:"4px", padding:"1px 6px", fontSize:"9px", color:C.green, fontWeight:700 }}>
              Cache actif · 6h
            </span>
          </div>
        </div>
        <button
          onClick={() => onNavigate?.("dashboard")}
          style={{ marginTop:"10px", display:"flex", alignItems:"center", gap:"5px", background:"none", border:"none", cursor:"pointer", padding:0, color:C.textFaint, fontSize:"10px" }}
        >
          <HelpCircle size={11} />
          Comment lire ?
        </button>
      </div>
    </aside>
  );
}

// ─── Composant principal ────────────────────────────────────────────────────────
export default function SeasonalityPanel({ apiBase = "http://127.0.0.1:3001", onNavigate }) {
  const [ticker, setTicker]         = useState("TQQQ");
  const [universeSearch, setUniverseSearch] = useState("");
  const [calendarData, setCalendarData]   = useState(null);
  const [shortTermData, setShortTermData] = useState(null);
  const [windowsData, setWindowsData]     = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [chart3yData, setChart3yData]       = useState(null);
  const [chart3yLoading, setChart3yLoading] = useState(false);
  const [chart3yError, setChart3yError]     = useState(false);
  const chart3yAbortRef = useRef(null);

  const loadData = useCallback(async (sym) => {
    if (!sym) return;
    setLoading(true);
    setError(null);
    setCalendarData(null);
    setShortTermData(null);
    setWindowsData(null);
    try {
      const [calRes, stRes, winRes] = await Promise.all([
        fetch(`${apiBase}/seasonality/${sym}/calendar`),
        fetch(`${apiBase}/seasonality/${sym}/short-term`),
        fetch(`${apiBase}/seasonality/${sym}/windows`),
      ]);
      const [calJson, stJson, winJson] = await Promise.all([calRes.json(), stRes.json(), winRes.json()]);
      if (calJson.ok && calJson.calendar) setCalendarData(calJson.calendar);
      if (stJson.ok  && stJson.shortTerm) setShortTermData(stJson.shortTerm);
      if (winJson.ok && winJson.windows)  setWindowsData(winJson.windows);
      if (!calJson.ok && !stJson.ok && !winJson.ok)
        setError(`Aucune donnée disponible pour ${sym}. Historique insuffisant ou ticker invalide.`);
      setLastUpdated(new Date().toLocaleTimeString("fr-CA"));
    } catch (err) {
      setError(`Erreur réseau : ${err?.message ?? err}. Vérifiez que le backend tourne.`);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { loadData(ticker); }, [ticker, loadData]);

  useEffect(() => {
    if (!ticker) return undefined;
    if (chart3yAbortRef.current) chart3yAbortRef.current.abort();
    const controller = new AbortController();
    chart3yAbortRef.current = controller;

    setChart3yLoading(true);
    setChart3yError(false);
    setChart3yData(null);

    fetch(`${apiBase}/seasonality/${ticker}/chart-3y`, { signal: controller.signal })
      .then((res) => res.json())
      .then((json) => {
        if (controller.signal.aborted) return;
        if (json.ok) setChart3yData(json);
        else setChart3yError(true);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setChart3yError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setChart3yLoading(false);
      });

    return () => controller.abort();
  }, [ticker, apiBase]);

  const selectTicker = useCallback((sym) => {
    const normalized = String(sym ?? "").trim().toUpperCase();
    if (!normalized || !/^[A-Z0-9.\-^]{1,10}$/.test(normalized)) return;
    setTicker(normalized);
    setUniverseSearch("");
  }, []);

  // Stats dérivées pour le résumé
  const summary = useMemo(() => {
    const win7  = shortTermData?.windows?.find((w) => w.days === 7);
    const win   = win7 ?? shortTermData?.windows?.[0];
    const active = windowsData?.summary?.activeNow?.[0] ?? null;
    const best   = windowsData?.summary?.bestOverallBullish ?? null;
    const { range, weekNum } = getCurrentWeekRange();

    // Tendance
    let tendance = "N/D", tendanceBias = "neutral";
    if (win) {
      const wr  = win.winRate || 0;
      const csp = win.cspVerdict;
      if      (csp === "favorable"   && wr >= 0.70) { tendance = "Haussière forte";    tendanceBias = "green"; }
      else if (csp === "favorable")                  { tendance = "Haussière modérée";  tendanceBias = "green"; }
      else if (csp === "defavorable" && wr <= 0.35)  { tendance = "Baissière forte";    tendanceBias = "red"; }
      else if (csp === "defavorable")                { tendance = "Baissière modérée";  tendanceBias = "red"; }
      else                                           { tendance = "Neutre";             tendanceBias = "yellow"; }
    }

    // Force saisonnière 0–100
    let force = null;
    if (win) {
      const winComp  = (win.winRate   || 0) * 40;
      const retNorm  = Math.min(Math.max((win.avgReturn || 0) / 0.05, -1), 1);
      const retComp  = (retNorm + 1) / 2 * 30;
      const riskComp = (1 - Math.min((win.pctBelow5 || 0) * 3, 1)) * 30;
      force = Math.round(Math.max(0, Math.min(100, winComp + retComp + riskComp)));
    }

    return {
      range, weekNum,
      tendance, tendanceBias,
      force,
      winRate7j:    win7?.winRate  ?? null,
      downside7j:   win7?.pctBelow5 ?? null,
      cspVerdict7j: win7?.cspVerdict ?? null,
      ccVerdict7j:  win7?.ccVerdict  ?? null,
      ltBias:  active ? (active.avgReturn > 0 && active.winRate >= 0.5 ? "bullish" : "bearish") : (best ? "bullish" : null),
      ltLabel: active ? seasonalWindowPrimaryLabel(active) : (best ? seasonalWindowPrimaryLabel(best) : null),
    };
  }, [shortTermData, windowsData]);

  const tendanceBiasStyle = {
    green:   { color:C.green,    bg:"rgba(34,197,94,0.1)",    border:"rgba(34,197,94,0.3)" },
    red:     { color:C.red,      bg:"rgba(239,68,68,0.1)",    border:"rgba(239,68,68,0.3)" },
    yellow:  { color:C.yellow,   bg:"rgba(250,204,21,0.1)",   border:"rgba(250,204,21,0.3)" },
    neutral: { color:C.textMuted,bg:"rgba(143,163,191,0.08)", border:C.border },
  }[summary.tendanceBias];

  const cardStyle = { background:C.card, border:`1px solid ${C.border}`, borderRadius:"12px", padding:"14px 16px" };
  const hasData   = !loading && (calendarData || shortTermData || windowsData);
  const chart3yEnriched = useMemo(
    () => enrichChart3yWithWindowStats(chart3yData, windowsData),
    [chart3yData, windowsData],
  );

  const rsiSeries = useMemo(
    () => computeRsi14(chart3yData?.priceSeries ?? []),
    [chart3yData?.priceSeries],
  );
  const rsiMomentum = useMemo(() => getRsiMomentumState(rsiSeries), [rsiSeries]);
  const upcomingBullish = useMemo(
    () => pickUpcomingBullishWindow(windowsData, chart3yData?.activeWindowProgress),
    [windowsData, chart3yData?.activeWindowProgress],
  );
  const combinedMomentumReading = useMemo(
    () => buildCombinedMomentumReading({
      upcoming: upcomingBullish,
      rsiMomentum,
      activeProgress: chart3yData?.activeWindowProgress,
    }),
    [upcomingBullish, rsiMomentum, chart3yData?.activeWindowProgress],
  );

  return (
    <div style={{ display:"flex", background:C.bg, minHeight:"100vh", color:C.text, fontFamily:"inherit" }}>
      <style>{`
        @keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
        .sea-nav-btn:hover { background: rgba(139,92,246,0.1) !important; color: ${C.textMuted} !important; }
        .sea-refresh-btn:hover { opacity:0.85; }
        .sea-swing-row { display: grid; grid-template-columns: minmax(0, 1.58fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }
        .sea-universe-chip:hover { background: rgba(139,92,246,0.12) !important; color: ${C.text} !important; border-color: ${C.borderAccent} !important; }
        .sea-universe-chips::-webkit-scrollbar { height: 3px; }
        .sea-universe-chips::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.35); border-radius: 2px; }
        @media (max-width: 640px) {
          .sea-universe-hero { flex-wrap: wrap; gap: 4px !important; }
          .sea-universe-active-ticker { font-size: 22px !important; }
        }
        @media (max-width: 960px) {
          .sea-swing-row { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* ── SIDEBAR ── */}
      <Sidebar
        onNavigate={onNavigate}
        ticker={ticker}
        onSelectTicker={selectTicker}
        lastUpdated={lastUpdated}
      />

      {/* ── CONTENU PRINCIPAL ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", minWidth:0, overflow:"hidden" }}>

        {/* ── HEADER DE PAGE ── */}
        <div style={{ padding:"16px 24px 12px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"4px" }}>
              <h1 style={{ fontSize:"22px", fontWeight:800, letterSpacing:"0.1em", textTransform:"uppercase", color:C.text, margin:0 }}>
                Saisonnalité
              </h1>
              <span style={{ background:"rgba(139,92,246,0.18)", border:`1px solid ${C.borderAccent}`, borderRadius:"20px", padding:"2px 10px", fontSize:"10.5px", fontWeight:700, color:C.accentLight, letterSpacing:"0.06em" }}>
                V2 PRO
              </span>
            </div>
            <p style={{ fontSize:"12px", color:C.textMuted, margin:0, lineHeight:1.5 }}>
              Analyse historique des tendances saisonnières pour investir mieux, vendre des primes intelligemment et optimiser la stratégie Wheel.
            </p>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:"8px", flexShrink:0 }}>
            <button
              style={{ background:"rgba(143,163,191,0.08)", border:`1px solid ${C.border}`, borderRadius:"8px", color:C.textMuted, padding:"6px 13px", fontSize:"11.5px", fontWeight:600, cursor:"pointer", outline:"none", display:"flex", alignItems:"center", gap:"6px" }}
              onClick={() => {}}
            >
              <HelpCircle size={13} /> Aide
            </button>
            <button
              className="sea-refresh-btn"
              onClick={() => loadData(ticker)}
              disabled={loading}
              style={{ background:"rgba(34,211,238,0.08)", border:"1px solid rgba(34,211,238,0.2)", borderRadius:"8px", color:C.cyan, padding:"6px 13px", fontSize:"11.5px", fontWeight:600, cursor:"pointer", outline:"none", display:"flex", alignItems:"center", gap:"6px" }}
            >
              <RefreshCw size={13} style={loading ? { animation:"spin 1s linear infinite" } : {}} />
              MAJ
            </button>
          </div>
        </div>

        {/* ── ZONE SCROLLABLE ── */}
        <div style={{ flex:1, overflowY:"auto", padding:"14px 20px", display:"flex", flexDirection:"column", gap:"12px" }}>

          <SeasonalUniverseBar
            ticker={ticker}
            onSelectTicker={selectTicker}
            winRate7j={summary.winRate7j}
            search={universeSearch}
            onSearchChange={setUniverseSearch}
          />

          {/* ── LIGNE A : RÉSUMÉ STATS ── */}
          <div style={{ ...cardStyle, display:"flex", flexDirection:"column", gap:"10px" }}>
              <div style={{ fontSize:"10px", fontWeight:700, color:C.textFaint, letterSpacing:"0.1em", textTransform:"uppercase" }}>Résumé saisonnalité actuelle</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr auto 1fr 1fr 1fr 1fr", gap:"10px", alignItems:"center" }}>
                {/* Fenêtre actuelle */}
                <div>
                  <div style={{ fontSize:"9.5px", color:C.textFaint, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:"3px" }}>Fenêtre actuelle</div>
                  <div style={{ fontSize:"12.5px", fontWeight:700, color:C.text }}>{summary.range}</div>
                  <div style={{ fontSize:"10px", color:C.textFaint }}>{summary.weekNum}</div>
                </div>
                {/* Tendance */}
                <div>
                  <div style={{ fontSize:"9.5px", color:C.textFaint, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:"4px" }}>Tendance actuelle</div>
                  <span style={{ background:tendanceBiasStyle.bg, border:`1px solid ${tendanceBiasStyle.border}`, color:tendanceBiasStyle.color, borderRadius:"20px", padding:"3px 10px", fontSize:"12px", fontWeight:700, display:"inline-block" }}>
                    {summary.tendance}
                  </span>
                </div>
                {/* Jauge force */}
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
                  <div style={{ fontSize:"9.5px", color:C.textFaint, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:"3px", textAlign:"center" }}>Force saisonnière</div>
                  {summary.force !== null ? <SeasonalForceGauge score={summary.force} /> : <div style={{ fontSize:"14px", color:C.textFaint, padding:"8px 0" }}>N/D</div>}
                </div>
                {/* Risque baisse 7j */}
                <div>
                  <div style={{ fontSize:"9.5px", color:C.textFaint, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:"3px" }}>Risque baisse 7j</div>
                  <div style={{ fontSize:"20px", fontWeight:800, color:summary.downside7j > 0.2 ? C.red : summary.downside7j > 0.1 ? C.yellow : C.green }}>
                    {summary.downside7j !== null ? formatWinRate(summary.downside7j) : "—"}
                  </div>
                  {summary.downside7j !== null && <div style={{ fontSize:"10px", color:C.textFaint }}>{summary.downside7j > 0.2 ? "Risque élevé" : summary.downside7j > 0.1 ? "Risque modéré" : "Risque faible"}</div>}
                </div>
                {/* CSP 7j */}
                <div>
                  <div style={{ fontSize:"9.5px", color:C.textFaint, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:"5px" }}>CSP (7j)</div>
                  <VerdictBadge verdict={summary.cspVerdict7j} size="md" />
                  <div style={{ fontSize:"10px", color:C.textFaint, marginTop:"3px" }}>Risque modéré</div>
                </div>
                {/* CC 7j */}
                <div>
                  <div style={{ fontSize:"9.5px", color:C.textFaint, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:"5px" }}>CC (7j)</div>
                  <VerdictBadge verdict={summary.ccVerdict7j} size="md" />
                  <div style={{ fontSize:"10px", color:C.textFaint, marginTop:"3px" }}>Strike plus haut</div>
                </div>
                {/* Biais LT */}
                <div>
                  <div style={{ fontSize:"9.5px", color:C.textFaint, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", marginBottom:"5px" }}>Biais long terme</div>
                  <VerdictBadge verdict={summary.ltBias} size="md" />
                  {summary.ltLabel && <div style={{ fontSize:"10px", color:C.textFaint, marginTop:"3px" }}>{summary.ltLabel}</div>}
                </div>
              </div>
          </div>

          {/* ── LOADING ── */}
          {loading && (
            <div style={{ ...cardStyle, display:"flex", alignItems:"center", justifyContent:"center", gap:"10px", padding:"28px", color:C.textMuted, fontSize:"13px" }}>
              <Loader2 size={18} style={{ animation:"spin 1s linear infinite", color:C.accent }} />
              Chargement des données saisonnières pour {ticker}…
            </div>
          )}

          {/* ── ERREUR ── */}
          {!loading && error && (
            <div style={{ background:"rgba(239,68,68,0.07)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:"12px", padding:"16px 18px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"7px", marginBottom:"5px" }}>
                <AlertTriangle size={15} style={{ color:C.red }} />
                <span style={{ fontWeight:700, color:C.red }}>Erreur</span>
              </div>
              <p style={{ fontSize:"12px", color:C.textMuted, margin:0 }}>{error}</p>
            </div>
          )}

          {/* ── CONTENU DONNÉES ── */}
          {hasData && (
            <>
              {/* ── LIGNE D : Court terme | Intra-année ── */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px" }}>
                {/* Court terme */}
                <div style={cardStyle}>
                  <SectionHeader
                    title="Court terme — Vente d'options (CSP / CC)"
                    icon={Shield}
                    info="Statistiques historiques basées sur l'historique complet disponible."
                    right={
                      shortTermData?.summary
                        ? (shortTermData.summary.yearsCovered != null
                          ? `${shortTermData.summary.yearsCovered} ans`
                          : "Historique disponible")
                        : undefined
                    }
                  />
                  <ShortTermTable shortTerm={shortTermData} />
                </div>
                {/* Mensuel compact — rendement + probabilité */}
                <div style={cardStyle}>
                  <SectionHeader
                    title="Saisonnalité mensuelle — rendement et probabilité"
                    icon={BarChart3}
                    info="Rendement moyen et probabilité de hausse par mois calendaire. Survoler une barre pour le détail."
                    right={calendarData?.summary ? `${calendarData.summary.yearsCovered} ans` : undefined}
                  />
                  {calendarData?.months
                    ? <MonthlyBarChart months={calendarData.months} />
                    : <div style={{ textAlign:"center", padding:"28px 0", color:C.textFaint, fontSize:"12px" }}>Histogramme non disponible.</div>
                  }
                  <div style={{ marginTop:"4px", fontSize:"9px", color:C.textFaint }}>
                    % sous chaque mois = probabilité de hausse historique
                  </div>
                </div>
              </div>

              {/* ── LIGNE F : Swing — carte annuelle + panneau compact ── */}
              <div className="sea-swing-row">
                <div style={cardStyle}>
                  <SectionHeader
                    title="Carte swing saisonnière — haussier / baissier"
                    icon={Activity}
                    info="Zones vertes/rouges = fenêtres swing 5–17 sem. · Ligne = rendement cumulé moyen par mois."
                    right={calendarData?.summary ? `${calendarData.summary.yearsCovered} ans d'historique` : undefined}
                  />
                  {calendarData?.months
                    ? <CumulativeLineChart months={calendarData.months} swingWindows={windowsData?.swingWindows} />
                    : <div style={{ textAlign:"center", padding:"36px 0", color:C.textFaint, fontSize:"12px" }}>Courbe cumulée non disponible — endpoint /calendar requis.</div>
                  }
                  <div style={{ marginTop:"6px", fontSize:"9.5px", color:C.textFaint }}>
                    Indice base 100 au 1er janvier. Données ajustées des dividendes.
                  </div>
                </div>
                <SwingCompactSidePanel
                  activeProgress={chart3yData?.activeWindowProgress}
                  windows={windowsData}
                  chart3yLoading={chart3yLoading}
                  rsiMomentum={rsiMomentum}
                  upcoming={upcomingBullish}
                  combinedReading={combinedMomentumReading}
                />
              </div>

              {/* ── LIGNE F2 : Graphique 3 ans compact ── */}
              {ticker && (chart3yLoading || chart3yData || chart3yError) && (
                <div style={cardStyle}>
                  <SectionHeader
                    title="Graphique 3 ans — prix réel et fenêtres saisonnières"
                    icon={BarChart2}
                    info="Prix daily 3 ans avec occurrences réelles des fenêtres swing haussières et baissières."
                    right={chart3yData?.range ? `${chart3yData.range.years} ans` : undefined}
                  />
                  <div style={{ fontSize: "10.5px", color: C.textMuted, marginBottom: "8px", lineHeight: 1.4 }}>
                    Prix réel 3 ans avec occurrences saisonnières.
                  </div>
                  <ThreeYearSeasonalityChart
                    data={chart3yEnriched}
                    loading={chart3yLoading}
                    error={chart3yError}
                    symbol={ticker}
                  />
                </div>
              )}

              {/* ── LIGNE G : Lecture stratégique | Confiance ── */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:"12px" }}>
                <div style={cardStyle}>
                  <SectionHeader
                    title="Lecture stratégique"
                    icon={Activity}
                    info="Indicatif historique — ne constitue pas une recommandation de trade."
                  />
                  <StrategicReadingSection shortTerm={shortTermData} windows={windowsData} />
                </div>
                <DataConfidenceCard calendar={calendarData} shortTerm={shortTermData} />
              </div>
            </>
          )}

          {/* ── ÉTAT VIDE ── */}
          {!loading && !error && !calendarData && !shortTermData && !windowsData && (
            <div style={{ ...cardStyle, textAlign:"center", padding:"44px 24px", color:C.textMuted }}>
              <Activity size={28} style={{ color:C.textFaint, marginBottom:"10px" }} />
              <div style={{ fontSize:"13px", fontWeight:600, marginBottom:"5px" }}>Aucune donnée chargée</div>
              <div style={{ fontSize:"11px" }}>Sélectionnez un ticker dans l&apos;univers saisonnier ou saisissez un symbole.</div>
            </div>
          )}
        </div>

        {/* ── FOOTER ── */}
        <div style={{ padding:"6px 20px", borderTop:`1px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
          <div style={{ fontSize:"10px", color:C.textFaint }}>
            Données : Yahoo Finance (ajustées) · {lastUpdated ? `Mise à jour : ${lastUpdated}` : "—"} · Cache : 6 heures
          </div>
          <div style={{ fontSize:"10px", color:C.textFaint, fontStyle:"italic" }}>
            Les performances passées ne garantissent pas les résultats futurs.
          </div>
        </div>
      </div>
    </div>
  );
}
