/**
 * SeasonalityPanel V2 PRO — Layout one-page fidèle à la maquette.
 * Sidebar gauche + toutes les sections visibles sur une seule page, sans sous-onglets.
 * UI seulement — aucun impact backend, IBKR, scanner ou logique Wheel.
 */
import React, { useState, useEffect, useCallback, useMemo } from "react";
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
const MONTH_ABBREV  = ["Jan","Fév","Mar","Avr","Mai","Juin","Juil","Août","Sep","Oct","Nov","Déc"];
const MONTHS_FR_LONG = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];

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

// ─── Histogramme mensuel ────────────────────────────────────────────────────────
function MonthlyBarChart({ months }) {
  if (!months?.length) return <div style={{ color:C.textFaint, textAlign:"center", padding:"28px 0", fontSize:"12px" }}>Données mensuelles non disponibles</div>;
  const aligned = MONTH_ABBREV.map((label, i) => {
    const m = months.find((x) => x.month === i + 1);
    return { label, avgReturn: m?.avgReturn ?? null, winRate: m?.winRate ?? null };
  });
  const W = 560, H = 130;
  const PAD = { left:36, right:6, top:14, bottom:22 };
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
        return (
          <g key={i}>
            <rect x={x - barW / 2} y={y} width={barW} height={Math.max(barH, 1.5)} fill={fill} rx="1.5" opacity="0.85" />
            {m.avgReturn !== null && Math.abs(ret) > 0.005 && (
              <text x={x} y={ret >= 0 ? y - 2 : y + barH + 8} textAnchor="middle" fontSize="7" fill={fill} opacity="0.9">
                {formatPct(ret)}
              </text>
            )}
            <text x={x} y={H - 4} textAnchor="middle" fontSize="8" fill={C.textFaint}>{m.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Courbe cumulée ─────────────────────────────────────────────────────────────
function CumulativeLineChart({ months }) {
  if (!months?.length) return <div style={{ color:C.textFaint, textAlign:"center", padding:"36px 0", fontSize:"12px" }}>Courbe cumulée non disponible</div>;
  const aligned = MONTH_ABBREV.map((label, i) => {
    const m = months.find((x) => x.month === i + 1);
    return { label, avgReturn: m?.avgReturn ?? 0 };
  });
  const cumPoints = [{ label:"Départ", cum:0 }];
  let cum = 0;
  for (const m of aligned) { cum += m.avgReturn; cumPoints.push({ label:m.label, cum }); }
  const W = 600, H = 165;
  const PAD = { left:40, right:14, top:18, bottom:28 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const minV = Math.min(...cumPoints.map((p) => p.cum), -0.02);
  const maxV = Math.max(...cumPoints.map((p) => p.cum), 0.05);
  const range = maxV - minV || 0.1;
  const xOf = (i) => PAD.left + (i / (cumPoints.length - 1)) * chartW;
  const yOf = (v) => PAD.top + (1 - (v - minV) / range) * chartH;
  const linePath = cumPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(p.cum).toFixed(1)}`).join(" ");
  const zeroY = yOf(0);
  const areaPath = `${linePath} L ${xOf(cumPoints.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L ${xOf(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;
  const gridLines = Array.from({ length: 5 }, (_, i) => { const v = minV + (range / 4) * i; return { v, y: yOf(v) }; });
  const finalColor = cum >= 0 ? "#8b5cf6" : C.red;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", display:"block" }} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={finalColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={finalColor} stopOpacity="0.02" />
        </linearGradient>
        <filter id="cumGlow"><feGaussianBlur stdDeviation="2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
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
      <circle cx={xOf(0)} cy={yOf(0)} r="3" fill={C.panel} stroke={finalColor} strokeWidth="1.5" />
      <circle cx={xOf(cumPoints.length - 1)} cy={yOf(cum)} r="4" fill={finalColor} filter="url(#cumGlow)" />
      <text x={xOf(cumPoints.length - 1) + 6} y={yOf(cum) + 4} fontSize="9.5" fill={finalColor} fontWeight="700">
        {cum >= 0 ? "+" : ""}{(cum * 100).toFixed(1)}%
      </text>
      {cumPoints.slice(1).map((p, i) => (
        <text key={i} x={xOf(i + 1).toFixed(1)} y={H - 6} textAnchor="middle" fontSize="8.5" fill={C.textFaint}>{p.label}</text>
      ))}
    </svg>
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
          Meilleure fenêtre CSP : <strong style={{ color:C.textMuted }}>{shortTerm.summary.bestCspWindow?.label ?? "—"}</strong>
          {" · "}Fenêtre CC : <strong style={{ color:C.textMuted }}>{shortTerm.summary.bestCcWindow?.label ?? "—"}</strong>
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
          Source : {calendar.summary.source ?? "Yahoo Finance"} · {calendar.summary.yearsCovered ?? "—"} ans · Cache {calendar.summary.cacheTtlHours}h
        </div>
      )}
    </div>
  );
}

// ─── Tableau fenêtres longues ───────────────────────────────────────────────────
function LongTermWindowsCard({ windows }) {
  if (!windows?.horizons?.length) return <div style={{ color:C.textFaint, fontSize:"12px", padding:"18px 0" }}>Fenêtres saisonnières non disponibles.</div>;
  const allBullish = [];
  for (const h of windows.horizons) {
    for (const wBlock of h.windows ?? []) {
      for (const w of wBlock.bestBullish ?? []) allBullish.push({ ...w, days: wBlock.windowDays });
    }
  }
  allBullish.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rows = allBullish.slice(0, 6);
  const thBase = { padding:"6px 8px", fontSize:"9.5px", fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", color:C.textFaint, borderBottom:`1px solid ${C.border}`, background:C.cardInner, whiteSpace:"nowrap" };
  const tdBase = { padding:"8px 8px", fontSize:"11.5px", color:C.text, borderBottom:`1px solid rgba(120,150,190,0.07)`, verticalAlign:"middle" };
  const activeNow = windows.summary?.activeNow ?? [];
  return (
    <div>
      {activeNow.length > 0 && (
        <div style={{ background:"rgba(139,92,246,0.07)", border:`1px solid rgba(139,92,246,0.2)`, borderRadius:"8px", padding:"8px 12px", marginBottom:"10px", display:"flex", flexWrap:"wrap", gap:"6px", alignItems:"center" }}>
          <span style={{ fontSize:"10px", fontWeight:700, color:C.accentLight, letterSpacing:"0.08em", textTransform:"uppercase" }}>⚡ Actives</span>
          {activeNow.slice(0, 3).map((w, i) => {
            const bias = (w.avgReturn > 0 && w.winRate >= 0.5) ? "favorable" : "faible";
            const vs = verdictStyleObj(bias);
            return (
              <span key={i} style={{ background:vs.bg, border:`1px solid ${vs.border}`, borderRadius:"6px", padding:"2px 10px", fontSize:"11px", color:vs.color, fontWeight:600 }}>
                {w.label} · {formatPct(w.avgReturn)}
              </span>
            );
          })}
        </div>
      )}
      <div style={{ overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:"400px" }}>
          <thead>
            <tr>
              <th style={{ ...thBase, textAlign:"left" }}>Fenêtre</th>
              <th style={{ ...thBase, textAlign:"center" }}>Jours</th>
              <th style={{ ...thBase, textAlign:"right" }}>% Haussier</th>
              <th style={{ ...thBase, textAlign:"right" }}>Rend. moy.</th>
              <th style={{ ...thBase, textAlign:"right" }}>Pire rend.</th>
              <th style={{ ...thBase, textAlign:"center" }}>Verdict LT</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} style={{ padding:"14px", textAlign:"center", fontSize:"12px", color:C.textFaint }}>Aucune fenêtre haussière</td></tr>
            ) : rows.map((w, i) => (
              <tr key={i}>
                <td style={{ ...tdBase, fontWeight:600, color:C.text }}>{w.label ?? "—"}</td>
                <td style={{ ...tdBase, textAlign:"center", color:C.textMuted }}>{w.days ? `${w.days}j` : "—"}</td>
                <td style={{ ...tdBase, textAlign:"right" }}>{formatWinRate(w.winRate)}</td>
                <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.avgReturn), fontWeight:600 }}>{formatPct(w.avgReturn)}</td>
                <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.worstReturn) }}>{formatPct(w.worstReturn)}</td>
                <td style={{ ...tdBase, textAlign:"center" }}>
                  <VerdictBadge verdict={w.status ?? (w.avgReturn > 0 ? "favorable" : "faible")} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop:"7px", fontSize:"10px", color:C.textFaint, fontStyle:"italic" }}>
        Ces fenêtres aident à déterminer les meilleures périodes pour accumuler ou alléger une position.
      </div>
    </div>
  );
}

// ─── Meilleures / Pires fenêtres ───────────────────────────────────────────────
function BestWorstWindowsCard({ windows }) {
  if (!windows?.horizons?.length) return <div style={{ color:C.textFaint, fontSize:"12px", padding:"16px 0" }}>Fenêtres non disponibles.</div>;
  const allBullish = [], allBearish = [];
  for (const h of windows.horizons) {
    for (const wBlock of h.windows ?? []) {
      for (const w of wBlock.bestBullish ?? []) allBullish.push({ ...w, days: wBlock.windowDays });
      for (const w of wBlock.worstBearish ?? []) allBearish.push({ ...w, days: wBlock.windowDays });
    }
  }
  allBullish.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  allBearish.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
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
        ) : rows.slice(0, 4).map((w, i) => (
          <tr key={i}>
            <td style={{ ...tdBase, textAlign:"center", color:C.textFaint }}>{i + 1}</td>
            <td style={{ ...tdBase, fontWeight:500 }}>{w.label ?? "—"}</td>
            <td style={{ ...tdBase, textAlign:"right" }}>{formatWinRate(w.winRate)}</td>
            <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.avgReturn), fontWeight:600 }}>{formatPct(w.avgReturn)}</td>
            <td style={{ ...tdBase, textAlign:"right", color:pctColor(w.worstReturn) }}>{formatPct(w.worstReturn)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:"14px" }}>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:"12px", padding:"14px 16px" }}>
        <SectionHeader title="Meilleures fenêtres haussières" icon={TrendingUp} right={`${Math.min(allBullish.length, 4)} fenêtres`} />
        <div style={{ overflowX:"auto" }}><MiniTable rows={allBullish} isBullish={true} /></div>
      </div>
      <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:"12px", padding:"14px 16px" }}>
        <SectionHeader title="Pires fenêtres baissières" icon={TrendingDown} right={`${Math.min(allBearish.length, 4)} fenêtres`} />
        <div style={{ overflowX:"auto" }}><MiniTable rows={allBearish} isBullish={false} /></div>
      </div>
    </div>
  );
}

// ─── Lecture stratégique ────────────────────────────────────────────────────────
function buildCspReading(shortTerm) {
  const w = shortTerm?.windows?.find((x) => x.days === 7) ?? shortTerm?.windows?.[0];
  if (!w) return { text:"Données court terme insuffisantes.", icon:"neutral" };
  if (w.cspVerdict === "favorable") return { text:`Fenêtre favorable (${w.label}). Taux haussier ${formatWinRate(w.winRate)} · Baisse >5% : ${formatWinRate(w.pctBelow5)}. Strike sous lowerBound recommandé. Viser 1 %+ défendable.`, icon:"green" };
  if (w.cspVerdict === "defavorable") return { text:`Risque de baisse élevé sur ${w.label} (Baisse >5% : ${formatWinRate(w.pctBelow5)}). Réduire l'agressivité ou attendre.`, icon:"red" };
  return { text:`Fenêtre neutre sur ${w.label}. Prime acceptable seulement avec strike prudent sous lowerBound. Surveillez la volatilité.`, icon:"yellow" };
}
function buildCcReading(shortTerm) {
  const w = shortTerm?.windows?.find((x) => x.days === 14) ?? shortTerm?.windows?.find((x) => x.days === 7);
  if (!w) return { text:"Données court terme insuffisantes.", icon:"neutral" };
  if (w.ccVerdict === "risque_hausse") return { text:`Risque de rally élevé sur ${w.label} (Rally >5% : ${formatWinRate(w.pctAbove5)}). Éviter les strikes CC trop proches. Attendre un repli.`, icon:"red" };
  if (w.ccVerdict === "favorable") return { text:`Fenêtre peu explosive sur ${w.label} (Rally >5% : ${formatWinRate(w.pctAbove5)}). CC acceptable. Strike at-the-money envisageable.`, icon:"green" };
  return { text:`Fenêtre neutre pour CC sur ${w.label}. Prudence : choisir strike plus élevé pour éviter le call away.`, icon:"yellow" };
}
function buildLongTermReading(windows) {
  const activeNow = windows?.summary?.activeNow ?? [];
  const bestBullish = windows?.summary?.bestOverallBullish;
  if (activeNow.length > 0) {
    const a = activeNow[0];
    const isBull = a.avgReturn > 0 && a.winRate >= 0.5;
    return isBull
      ? { text:`Fenêtre saisonnière forte active : ${a.label} (${formatPct(a.avgReturn)} · ${formatWinRate(a.winRate)} haussier). Maintenir positions. Période d'accumulation en cours.`, icon:"green" }
      : { text:`Fenêtre saisonnièrement faible : ${a.label} (${formatPct(a.avgReturn)}). Garder du cash, éviter de suracheter.`, icon:"red" };
  }
  if (bestBullish) return { text:`Meilleure fenêtre : ${bestBullish.label} (${formatPct(bestBullish.avgReturn)} · ${formatWinRate(bestBullish.winRate)}). Idéale pour accumuler ou renforcer.`, icon:"yellow" };
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
  const [tickerInput, setTickerInput] = useState("");
  const [showTickerInput, setShowTickerInput] = useState(false);
  const [calendarData, setCalendarData]   = useState(null);
  const [shortTermData, setShortTermData] = useState(null);
  const [windowsData, setWindowsData]     = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

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

  const handleAnalyze = () => {
    const sym = tickerInput.trim().toUpperCase();
    if (/^[A-Z0-9.\-^]{1,10}$/.test(sym)) {
      setTicker(sym);
      setTickerInput("");
      setShowTickerInput(false);
    }
  };

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
      ltLabel: active?.label ?? (best ? "Très haussier" : null),
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

  return (
    <div style={{ display:"flex", background:C.bg, minHeight:"100vh", color:C.text, fontFamily:"inherit" }}>
      <style>{`
        @keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
        .sea-nav-btn:hover { background: rgba(139,92,246,0.1) !important; color: ${C.textMuted} !important; }
        .sea-refresh-btn:hover { opacity:0.85; }
      `}</style>

      {/* ── SIDEBAR ── */}
      <Sidebar
        onNavigate={onNavigate}
        ticker={ticker}
        onSelectTicker={(t) => { setTicker(t); setShowTickerInput(false); }}
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

          {/* ── LIGNE A : TICKER + RÉSUMÉ STATS ── */}
          <div style={{ display:"grid", gridTemplateColumns:"210px 1fr", gap:"12px", alignItems:"stretch" }}>

            {/* Carte ticker */}
            <div style={{ ...cardStyle, display:"flex", flexDirection:"column", gap:"10px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
                <div style={{ width:"44px", height:"44px", borderRadius:"10px", background:"rgba(139,92,246,0.2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"14px", fontWeight:800, color:C.accentLight, flexShrink:0 }}>
                  {ticker.slice(0, 2)}
                </div>
                <div>
                  <div style={{ fontSize:"22px", fontWeight:800, color:C.text, lineHeight:1 }}>{ticker}</div>
                  <div style={{ fontSize:"10px", color:C.textFaint, marginTop:"2px" }}>Yahoo Finance</div>
                </div>
              </div>
              {showTickerInput ? (
                <div style={{ display:"flex", gap:"5px" }}>
                  <input
                    value={tickerInput}
                    onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
                    placeholder="Ex: NVDA"
                    autoFocus
                    style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:"7px", color:C.text, padding:"5px 9px", fontSize:"12px", flex:1, outline:"none", minWidth:0 }}
                  />
                  <button onClick={handleAnalyze} style={{ background:"rgba(139,92,246,0.8)", border:"none", borderRadius:"7px", color:"#fff", padding:"5px 10px", fontSize:"11px", fontWeight:700, cursor:"pointer", outline:"none", flexShrink:0 }}>OK</button>
                </div>
              ) : (
                <button
                  onClick={() => setShowTickerInput(true)}
                  style={{ background:"rgba(139,92,246,0.1)", border:`1px solid rgba(139,92,246,0.25)`, borderRadius:"7px", color:C.accentLight, padding:"5px 10px", fontSize:"11px", fontWeight:600, cursor:"pointer", outline:"none", textAlign:"left", display:"flex", alignItems:"center", gap:"5px" }}
                >
                  <Search size={11} /> Changer de ticker
                </button>
              )}
              {summary.winRate7j !== null && (
                <div style={{ fontSize:"11px", color:C.textMuted }}>
                  <span style={{ color:C.green, fontWeight:700 }}>{formatWinRate(summary.winRate7j)} des années</span>
                  <span style={{ marginLeft:"4px" }}>↑</span>
                </div>
              )}
            </div>

            {/* Résumé saisonnalité */}
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
                    right={shortTermData?.summary ? `${shortTermData.summary.yearsCovered ?? "—"} ans` : undefined}
                  />
                  <ShortTermTable shortTerm={shortTermData} />
                </div>
                {/* Intra-année */}
                <div style={cardStyle}>
                  <SectionHeader
                    title="Saisonnalité intra-année — rendement moyen par mois"
                    icon={BarChart3}
                    info="Rendement moyen historique par mois calendaire."
                    right={calendarData?.summary ? `${calendarData.summary.yearsCovered} ans` : undefined}
                  />
                  {calendarData?.months
                    ? <MonthlyBarChart months={calendarData.months} />
                    : <div style={{ textAlign:"center", padding:"28px 0", color:C.textFaint, fontSize:"12px" }}>Histogramme non disponible.</div>
                  }
                </div>
              </div>

              {/* ── LIGNE E : Fenêtres longues | Calendrier ── */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px" }}>
                {/* Fenêtres longues */}
                <div style={cardStyle}>
                  <SectionHeader
                    title="Fenêtres saisonnières longues — investissement long terme"
                    icon={TrendingUp}
                    info="Fenêtres analysées sur 3/5/10/15 ans d'historique."
                  />
                  <LongTermWindowsCard windows={windowsData} />
                </div>
                {/* Calendrier heatmap */}
                <div style={cardStyle}>
                  <SectionHeader
                    title="Calendrier saisonnier — probabilité de hausse par mois"
                    icon={CalendarDays}
                    info="Rendement moyen et taux de hausse par mois calendaire."
                  />
                  <CalendarHeatmap calendar={calendarData} />
                </div>
              </div>

              {/* ── LIGNE F : Courbe cumulée | Meilleures/Pires fenêtres ── */}
              <div style={{ display:"grid", gridTemplateColumns:"55% 45%", gap:"12px" }}>
                {/* Courbe cumulée */}
                <div style={cardStyle}>
                  <SectionHeader
                    title="Courbe saisonnière — rendement cumulé moyen"
                    icon={Activity}
                    info="Somme des rendements mensuels moyens de janvier à décembre."
                    right={calendarData?.summary ? `${calendarData.summary.yearsCovered} ans d'historique` : undefined}
                  />
                  {calendarData?.months
                    ? <CumulativeLineChart months={calendarData.months} />
                    : <div style={{ textAlign:"center", padding:"36px 0", color:C.textFaint, fontSize:"12px" }}>Courbe cumulée non disponible — endpoint /calendar requis.</div>
                  }
                  <div style={{ marginTop:"8px", fontSize:"10px", color:C.textFaint }}>
                    Indice base 100 au 1er janvier. Données ajustées des dividendes.
                  </div>
                </div>
                {/* Meilleures / Pires fenêtres */}
                <BestWorstWindowsCard windows={windowsData} />
              </div>

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
              <div style={{ fontSize:"11px" }}>Sélectionnez un ticker dans la sidebar ou saisissez un symbole.</div>
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
