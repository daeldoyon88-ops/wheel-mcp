import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

// ── Utilities ───────────────────────────────────────────────────────────────

function numberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatDate(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().slice(0, 10);
}

function formatCompactExpiration(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{8}$/.test(raw)) return raw || "—";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function formatMoney(value) {
  const n = numberOrNull(value);
  if (n == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatPercent(value, digits = 1) {
  const n = numberOrNull(value);
  if (n == null) return "—";
  return `${n.toFixed(digits)}%`;
}

function formatPop(value) {
  const n = numberOrNull(value);
  if (n == null) return "—";
  if (n > 1) return `${n.toFixed(1)}%`;
  return `${(n * 100).toFixed(1)}%`;
}

function formatYesNo(value) {
  if (value === true) return "Oui";
  if (value === false) return "Non";
  return "—";
}

function formatDteRange(minDte, maxDte) {
  const min = numberOrNull(minDte);
  const max = numberOrNull(maxDte);
  if (min == null && max == null) return "—";
  if (min != null && max != null) return `${min} / ${max}`;
  return String(min ?? max);
}

function getResolutionLabel(record) {
  const resolution = record?.resolution ?? {};
  if (resolution?.resolved !== true) return "A resoudre";
  if (resolution?.expiredWorthless === true) return "Expired worthless";
  if (resolution?.assigned === true) return "Assigned";
  if (resolution?.rolled === true) return "Rolled";
  if (resolution?.outcomeStatus) return String(resolution.outcomeStatus);
  return "Resolu";
}

function formatResultStatus(value) {
  if (!value) return "—";
  const labels = {
    expired_worthless: "Exp. worthless",
    assigned: "Assigned",
    assigned_theoretical: "Assigned (theo)",
    rolled: "Rolled",
    pending: "Pending",
  };
  return labels[value] ?? String(value);
}

// ── Dark-mode design tokens ─────────────────────────────────────────────────
// bg-[#020617] = slate-950 (panel root)
// bg-slate-900 = cards
// bg-slate-800/50 = KPI cards
// border-slate-700/60 = borders
// text-slate-100 = primary text
// text-slate-400 = secondary
// text-slate-500/600 = muted

function confidenceLevel(sample) {
  const n = numberOrNull(sample) ?? 0;
  if (n === 0) return { key: "none",        label: "Aucune donnée",      cls: "bg-slate-800 text-slate-500 border-slate-700" };
  if (n < 10)  return { key: "low",         label: `Faible (n=${n})`,    cls: "bg-rose-900/40 text-rose-400 border-rose-800/50" };
  if (n < 30)  return { key: "preliminary", label: `Préliminaire (n=${n})`, cls: "bg-amber-900/40 text-amber-400 border-amber-800/50" };
  if (n < 100) return { key: "usable",      label: `Utilisable (n=${n})`, cls: "bg-sky-900/40 text-sky-400 border-sky-800/50" };
  return       { key: "robust",             label: `Robuste (n=${n})`,   cls: "bg-emerald-900/40 text-emerald-400 border-emerald-800/50" };
}

function ConfidenceBadge({ sample }) {
  const c = confidenceLevel(sample);
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${c.cls}`}>
      {c.label}
    </span>
  );
}

function ProKpi({ label, value, tone = "default", sub, large }) {
  const col = { good: "text-emerald-400", warn: "text-amber-400", risk: "text-rose-400", info: "text-sky-400", muted: "text-slate-500", default: "text-slate-100" }[tone] ?? "text-slate-100";
  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-800/50 p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className={`mt-2 ${large ? "text-3xl" : "text-2xl"} font-bold tabular-nums leading-none ${col}`}>
        {value ?? <span className="text-slate-600 text-lg">N/D</span>}
      </p>
      {sub && <p className="mt-1.5 text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function ProSection({ title, badge, subtitle, children }) {
  return (
    <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-5">
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">{title}</h3>
          {badge && (
            <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
              {badge}
            </span>
          )}
        </div>
        {subtitle && <p className="mt-1 text-[11px] text-slate-600">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function DarkTable({ title, headers, rows, empty = "Aucune donnée." }) {
  return (
    <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-5">
      <h3 className="mb-4 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400">{title}</h3>
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
          {empty}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                {headers.map((h) => (
                  <th key={h} className="px-3 py-3 font-semibold whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">{rows}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CaptureClassBadgeDark({ value }) {
  if (value === "primaryDaily")
    return <span className="rounded bg-emerald-900/40 border border-emerald-800/50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">primary</span>;
  if (value === "intradayRetest")
    return <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">retest</span>;
  if (value === "manualTest")
    return <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">manual</span>;
  return <span className="text-slate-600">—</span>;
}

function DarkJournalTable({ title, rows, showOutcomeV2 = false }) {
  return (
    <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400">{title}</h3>
          <p className="mt-0.5 text-[11px] text-slate-600">{rows.length} record{rows.length !== 1 ? "s" : ""}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-8 text-sm text-slate-600">
          Aucun record.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-3 font-semibold">Date scan</th>
                <th className="px-3 py-3 font-semibold">Classe</th>
                <th className="px-3 py-3 font-semibold">Ticker</th>
                <th className="px-3 py-3 font-semibold">Expiration</th>
                <th className="px-3 py-3 font-semibold">DTE</th>
                <th className="px-3 py-3 font-semibold">Rang</th>
                <th className="px-3 py-3 font-semibold">Source</th>
                <th className="px-3 py-3 font-semibold">Mode</th>
                <th className="px-3 py-3 font-semibold">Strike</th>
                <th className="px-3 py-3 font-semibold">Premium</th>
                <th className="px-3 py-3 font-semibold">POP est.</th>
                <th className="px-3 py-3 font-semibold">EliteScore</th>
                <th className="px-3 py-3 font-semibold">Badge</th>
                <th className="px-3 py-3 font-semibold">Résultat</th>
                <th className="px-3 py-3 font-semibold">Statut</th>
                <th className="px-3 py-3 font-semibold">P/L</th>
                <th className="px-3 py-3 font-semibold">Return %</th>
                <th className="px-3 py-3 font-semibold">Résolu le</th>
                {showOutcomeV2 && <th className="px-3 py-3 font-semibold">Strike touché</th>}
                {showOutcomeV2 && <th className="px-3 py-3 font-semibold">Min prix</th>}
                {showOutcomeV2 && <th className="px-3 py-3 font-semibold">Max ITM</th>}
                {showOutcomeV2 && <th className="px-3 py-3 font-semibold">LB cassé</th>}
                {showOutcomeV2 && <th className="px-3 py-3 font-semibold">Drawdown %</th>}
                {showOutcomeV2 && <th className="px-3 py-3 font-semibold">Support cassé</th>}
                {showOutcomeV2 && <th className="px-3 py-3 font-semibold">Dist. LB</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {rows.map((record) => {
                const pl = numberOrNull(record?.resolution?.realizedPl);
                return (
                  <tr key={record.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-3 py-2.5 text-slate-500">{formatDate(record?.scanTimestamp ?? record?.scanDate)}</td>
                    <td className="px-3 py-2.5"><CaptureClassBadgeDark value={record?.captureClass} /></td>
                    <td className="px-3 py-2.5 font-bold text-slate-100">{record?.symbol || "—"}</td>
                    <td className="px-3 py-2.5 text-slate-400">{formatCompactExpiration(record?.expiration)}</td>
                    <td className="px-3 py-2.5">{numberOrNull(record?.dteAtScan) ?? "—"}</td>
                    <td className="px-3 py-2.5">{numberOrNull(record?.candidateRank) ?? "—"}</td>
                    <td className="px-3 py-2.5 text-slate-500">{record?.captureSource || "—"}</td>
                    <td className="px-3 py-2.5">
                      <span className={record?.strikeMode === "safe" ? "font-semibold text-emerald-400" : record?.strikeMode === "aggressive" ? "font-semibold text-rose-400" : "text-slate-500"}>
                        {record?.strikeMode || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{numberOrNull(record?.strike?.strike) ?? "—"}</td>
                    <td className="px-3 py-2.5 tabular-nums text-sky-400">{formatMoney(record?.strike?.premium)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{formatPop(record?.strike?.popEstimate)}</td>
                    <td className="px-3 py-2.5">{numberOrNull(record?.scores?.eliteScore) != null ? Number(record.scores.eliteScore).toFixed(1) : "—"}</td>
                    <td className="px-3 py-2.5 text-slate-400">{record?.scores?.eliteBadge || "—"}</td>
                    <td className="px-3 py-2.5">{getResolutionLabel(record)}</td>
                    <td className="px-3 py-2.5">{formatResultStatus(record?.resolution?.resultStatus)}</td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {pl == null ? "—" : <span className={pl >= 0 ? "text-emerald-400" : "text-rose-400"}>{formatMoney(pl)}</span>}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{formatPercent(record?.resolution?.realizedReturnPct, 2)}</td>
                    <td className="px-3 py-2.5 text-slate-500">{formatDate(record?.resolution?.resolvedAt)}</td>
                    {showOutcomeV2 && <td className="px-3 py-2.5">{formatYesNo(record?.resolution?.strikeTouched)}</td>}
                    {showOutcomeV2 && <td className="px-3 py-2.5">{formatMoney(record?.resolution?.minPriceBetweenScanAndExpiration)}</td>}
                    {showOutcomeV2 && <td className="px-3 py-2.5">{formatMoney(record?.resolution?.maxItmDepth)}</td>}
                    {showOutcomeV2 && <td className="px-3 py-2.5">{formatYesNo(record?.resolution?.brokeLowerBound)}</td>}
                    {showOutcomeV2 && <td className="px-3 py-2.5">{formatPercent(record?.resolution?.drawdownPct)}</td>}
                    {showOutcomeV2 && <td className="px-3 py-2.5">{formatYesNo(record?.resolution?.supportBreak)}</td>}
                    {showOutcomeV2 && <td className="px-3 py-2.5">{formatMoney(record?.resolution?.lowerBoundDistance)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DarkCalibV2Row({ cells }) {
  return (
    <tr className="hover:bg-slate-800/30 transition-colors">
      {cells.map((cell, i) => (
        <td key={i} className="px-3 py-2.5 whitespace-nowrap">{cell}</td>
      ))}
    </tr>
  );
}

// ── Ticker verdict helper ───────────────────────────────────────────────────

const SPECULATIVE_TICKERS = new Set([
  "RIOT", "CIFR", "WULF", "MARA", "CLSK", "APLD", "OKLO", "IONQ",
  "SOUN", "RGTI", "IREN", "BITF", "HUT",
]);

// Rules: rc < 10 → "Données insuff." · rc 10–29 → Préliminaire max · rc >= 30 required for Core/Balanced
// Speculative tickers blocked from "Core" regardless of sample size
function tickerVerdict(ticker, resolvedCount, winRate, avgPremium) {
  const rc = numberOrNull(resolvedCount) ?? 0;
  const wr = numberOrNull(winRate) ?? 0;
  const pr = numberOrNull(avgPremium) ?? 0;
  const isSpec = SPECULATIVE_TICKERS.has(String(ticker ?? "").toUpperCase().trim());

  if (rc < 10) return { label: "Données insuff.", cls: "text-slate-600" };

  // 10–29 resolved: preliminary ceiling, no Core/Balanced
  if (rc < 30) {
    if (isSpec || pr > 1.2) return { label: "Spéculatif", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
    return { label: "Préliminaire", cls: "rounded bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-slate-400" };
  }

  // rc >= 30: full verdict available
  if (pr > 1.2) return { label: "Premium trap?", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };

  if (isSpec) {
    if (wr >= 85) return { label: "Agressif sain", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
    return { label: "Spéculatif", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
  }

  if (wr >= 90 && pr <= 0.8) return { label: "Core", cls: "rounded bg-emerald-900/40 border border-emerald-800/50 px-1.5 py-0.5 font-bold text-emerald-400" };
  if (wr >= 80 && pr <= 1.2) return { label: "Balanced", cls: "rounded bg-sky-900/40 border border-sky-800/50 px-1.5 py-0.5 font-bold text-sky-400" };
  if (wr >= 70)              return { label: "Agressif sain", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
  return { label: "À valider", cls: "rounded bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-slate-400" };
}

function TickerVerdictBadge({ ticker, resolvedCount, winRate, avgPremium }) {
  const v = tickerVerdict(ticker, resolvedCount, winRate, avgPremium);
  return <span className={`text-[10px] ${v.cls}`}>{v.label}</span>;
}

// ── Premium bucket verdict ──────────────────────────────────────────────────
// Per-bucket rules — "Core défensif" gated behind rc >= 30 + wr >= 90 + defensive bucket only
// Buckets 0.80%+ never show "Core défensif" — higher premium = higher risk framing

function premiumBucketVerdict(bucketLabel, count, resolvedCount, winRate) {
  const n = numberOrNull(count) ?? 0;
  const r = numberOrNull(resolvedCount) ?? 0;
  const wr = numberOrNull(winRate);

  if (n < 5)      return { label: "Données insuff.", cls: "text-slate-600" };
  if (r < 5)      return { label: "Non résolu", cls: "text-slate-600" };
  if (wr == null) return { label: "—", cls: "text-slate-600" };

  const lbl = String(bucketLabel ?? "");

  // 0.40–0.60 %: "Core défensif" gate = rc >= 30 + wr >= 90
  if (lbl.startsWith("0.40")) {
    if (r >= 30 && wr >= 90) return { label: "Core défensif", cls: "rounded bg-emerald-900/40 border border-emerald-800/50 px-1.5 py-0.5 font-bold text-emerald-400" };
    if (r >= 10 && wr >= 80) return { label: "Balanced", cls: "rounded bg-sky-900/40 border border-sky-800/50 px-1.5 py-0.5 font-bold text-sky-400" };
    return { label: "Préliminaire", cls: "rounded bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-slate-400" };
  }

  // 0.60–0.80 %: "Core défensif" gate = rc >= 30 + wr >= 90
  if (lbl.startsWith("0.60")) {
    if (r >= 30 && wr >= 90) return { label: "Core défensif", cls: "rounded bg-emerald-900/40 border border-emerald-800/50 px-1.5 py-0.5 font-bold text-emerald-400" };
    if (r >= 10 && wr >= 75) return { label: "Balanced", cls: "rounded bg-sky-900/40 border border-sky-800/50 px-1.5 py-0.5 font-bold text-sky-400" };
    return { label: "À valider", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
  }

  // 0.80–1.00 %: never "Core défensif"
  if (lbl.startsWith("0.80")) {
    if (r >= 30 && wr >= 85) return { label: "Agressif sain", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
    return { label: "Préliminaire / À valider", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
  }

  // 1.00–1.25 %: never "Core défensif"
  if (lbl.startsWith("1.00")) {
    if (r < 30) return { label: "Préliminaire — 1% à valider", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
    if (wr >= 85) return { label: "Opportuniste", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
    return { label: "À valider", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
  }

  // 1.25 %+ : always speculative framing, never "Core défensif"
  if (r < 30) return { label: "Préliminaire — risque élevé", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
  return { label: "Spéculatif / premium trap?", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
}

function PremiumVerdictBadge({ bucketLabel, count, resolvedCount, winRate }) {
  const v = premiumBucketVerdict(bucketLabel, count, resolvedCount, winRate);
  return <span className={`text-[10px] ${v.cls}`}>{v.label}</span>;
}

// ── Placeholder badge ───────────────────────────────────────────────────────

function PlaceholderBadge({ label }) {
  return (
    <span className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-500">
      {label}
    </span>
  );
}

// ── Win Quality V2A ─────────────────────────────────────────────────────────

function getWinQuality(record) {
  const res = record?.resolution ?? {};
  if (res.resolved !== true) return "pending";
  if (res.assigned === true) return "assignment";
  if (res.expiredWorthless !== true) return "managed_or_loss";
  if (res.brokeLowerBound === true) return "lucky_win";
  if (res.strikeTouched === true) return "stressed_win";
  const drawdown = numberOrNull(res.drawdownPct);
  if (drawdown != null && drawdown >= 5) return "stressed_win";
  if (res.expiredWorthless === true) return "clean_win";
  return "normal_win";
}

function computeWinQualityStats(records) {
  let cleanWinCount = 0;
  let normalWinCount = 0;
  let stressedWinCount = 0;
  let luckyWinCount = 0;
  let assignmentCount = 0;
  let pendingCount = 0;

  for (const r of records) {
    const q = getWinQuality(r);
    if (q === "clean_win") cleanWinCount++;
    else if (q === "normal_win") normalWinCount++;
    else if (q === "stressed_win") stressedWinCount++;
    else if (q === "lucky_win") luckyWinCount++;
    else if (q === "assignment") assignmentCount++;
    else if (q === "pending") pendingCount++;
  }

  const resolvedCount = cleanWinCount + normalWinCount + stressedWinCount + luckyWinCount + assignmentCount;
  const cleanWinRate = resolvedCount > 0 ? (cleanWinCount / resolvedCount) * 100 : null;
  const normalWinRate = resolvedCount > 0 ? (normalWinCount / resolvedCount) * 100 : null;
  const stressedWinRate = resolvedCount > 0 ? (stressedWinCount / resolvedCount) * 100 : null;
  const luckyWinRate = resolvedCount > 0 ? (luckyWinCount / resolvedCount) * 100 : null;
  const assignmentRate = resolvedCount > 0 ? (assignmentCount / resolvedCount) * 100 : null;

  return {
    cleanWinCount,
    normalWinCount,
    stressedWinCount,
    luckyWinCount,
    assignmentCount,
    pendingCount,
    resolvedCount,
    cleanWinRate,
    normalWinRate,
    stressedWinRate,
    luckyWinRate,
    assignmentRate,
  };
}

function computeStressCoverage(resolvedRecords) {
  const n = resolvedRecords.length;
  if (n === 0) {
    return { strikeTouchedCoverage: null, lowerBoundCoverage: null, drawdownCoverage: null, globalCoverage: null, verdict: "Faible" };
  }

  const withStrikeTouched = resolvedRecords.filter((r) => r?.resolution?.strikeTouched != null).length;
  const withLowerBound = resolvedRecords.filter((r) => r?.resolution?.brokeLowerBound != null).length;
  const withDrawdown = resolvedRecords.filter((r) => numberOrNull(r?.resolution?.drawdownPct) != null).length;

  const strikeTouchedCoverage = (withStrikeTouched / n) * 100;
  const lowerBoundCoverage = (withLowerBound / n) * 100;
  const drawdownCoverage = (withDrawdown / n) * 100;
  const globalCoverage = (strikeTouchedCoverage + lowerBoundCoverage + drawdownCoverage) / 3;

  const verdict = globalCoverage < 30 ? "Faible" : globalCoverage <= 70 ? "Partiel" : "Bon";

  return { strikeTouchedCoverage, lowerBoundCoverage, drawdownCoverage, globalCoverage, verdict };
}

// ── 1% Readiness V2B ────────────────────────────────────────────────────────

function computeOnePercentReadiness({
  resolvedCount,
  cleanWinRate,
  stressedWinRate,
  luckyWinRate,
  assignmentRate,
  strikeTouchRate,
  lowerBoundBreakRate,
  avgPop,
  stressCoveragePct,
  premiumBuckets,
}) {
  const reasons = [];
  const penalties = [];
  const positives = [];
  let score = 0;

  // 1. Sample — max 20 pts
  const rc = resolvedCount ?? 0;
  let samplePts = 0;
  if (rc >= 150) samplePts = 20;
  else if (rc >= 100) samplePts = 17;
  else if (rc >= 50) samplePts = 12;
  else if (rc >= 30) samplePts = 8;
  else if (rc >= 10) samplePts = 4;
  score += samplePts;
  if (samplePts >= 12) positives.push(`Sample résolu robuste (n=${rc})`);
  else if (rc >= 10) reasons.push(`Sample résolu limité (n=${rc})`);
  else reasons.push(`Sample insuffisant (n=${rc} < 10)`);

  // 2. Win quality — max 25 pts + pénalités lucky/stressed
  const cwr = cleanWinRate ?? 0;
  let winQPts = 0;
  if (cwr >= 75) winQPts = 25;
  else if (cwr >= 65) winQPts = 20;
  else if (cwr >= 55) winQPts = 14;
  else if (cwr >= 45) winQPts = 8;
  else winQPts = 3;
  score += winQPts;
  if (winQPts >= 20) positives.push(`Clean win rate élevé (${cwr.toFixed(1)}%)`);

  const lwr = luckyWinRate ?? 0;
  if (lwr >= 30) { score -= 15; penalties.push(`Lucky win rate très élevé (${lwr.toFixed(1)}%)`); }
  else if (lwr >= 20) { score -= 10; penalties.push(`Lucky win rate élevé (${lwr.toFixed(1)}%)`); }
  else if (lwr >= 10) { score -= 5; penalties.push(`Lucky win rate modéré (${lwr.toFixed(1)}%)`); }

  const swr = stressedWinRate ?? 0;
  if (swr >= 25) { score -= 8; penalties.push(`Stressed win rate élevé (${swr.toFixed(1)}%)`); }
  else if (swr >= 15) { score -= 4; penalties.push(`Stressed win rate modéré (${swr.toFixed(1)}%)`); }

  // 3. Stress risk — max 20 pts
  const ar = assignmentRate ?? 0;
  if (ar === 0) { score += 8; positives.push("Assignment rate 0%"); }
  else if (ar <= 2) { score += 5; positives.push(`Assignment rate faible (${ar.toFixed(1)}%)`); }
  else if (ar <= 5) score += 2;
  else { score -= 10; penalties.push(`Assignment rate élevé (${ar.toFixed(1)}%)`); }

  if (strikeTouchRate != null) {
    if (strikeTouchRate <= 10) { score += 6; positives.push(`Strike touch rate faible (${strikeTouchRate.toFixed(1)}%)`); }
    else if (strikeTouchRate <= 20) score += 3;
    else if (strikeTouchRate <= 30) score += 0;
    else { score -= 6; penalties.push(`Strike touch rate élevé (${strikeTouchRate.toFixed(1)}%)`); }
  }

  if (lowerBoundBreakRate != null) {
    if (lowerBoundBreakRate <= 10) { score += 6; positives.push(`LowerBound break rate faible (${lowerBoundBreakRate.toFixed(1)}%)`); }
    else if (lowerBoundBreakRate <= 20) score += 3;
    else if (lowerBoundBreakRate <= 30) score += 0;
    else { score -= 8; penalties.push(`LowerBound break rate élevé (${lowerBoundBreakRate.toFixed(1)}%)`); }
  }

  // 4. POP quality — max 10 pts
  const ap = avgPop ?? 0;
  let popPts = 0;
  if (ap >= 90) popPts = 10;
  else if (ap >= 87) popPts = 8;
  else if (ap >= 84) popPts = 5;
  else if (ap >= 80) popPts = 2;
  score += popPts;
  if (popPts >= 8) positives.push(`POP moyenne forte (${ap.toFixed(1)}%)`);

  // 5. Premium opportunity — max 15 pts
  const b080 = premiumBuckets?.find((b) => b.label.startsWith("0.80"))?.resolvedCount ?? 0;
  const b100 = premiumBuckets?.find((b) => b.label.startsWith("1.00"))?.resolvedCount ?? 0;
  const b125 = premiumBuckets?.find((b) => b.label.startsWith("1.25"))?.resolvedCount ?? 0;

  if (b100 >= 30) { score += 8; positives.push(`Bucket 1.00–1.25% robuste (n=${b100})`); }
  else if (b100 >= 10) score += 4;
  else if (b100 > 0) score += 2;
  else reasons.push("Bucket 1.00–1.25% vide — 1% non validé");

  if (b080 >= 30) { score += 5; positives.push(`Bucket 0.80–1.00% solide (n=${b080})`); }
  else if (b080 >= 10) score += 3;

  if (b125 > 0) {
    score += 2;
    if (b125 > b100 + b080) {
      score -= 8;
      penalties.push("1.25%+ domine les hauts buckets — spéculatif");
    } else {
      reasons.push("1.25%+ présent — spéculatif");
    }
  }

  // 6. Data coverage — max 10 pts
  const scp = stressCoveragePct ?? 0;
  let coveragePts = 0;
  if (scp >= 90) coveragePts = 10;
  else if (scp >= 70) coveragePts = 7;
  else if (scp >= 50) coveragePts = 4;
  else if (scp >= 30) coveragePts = 2;
  score += coveragePts;
  if (coveragePts >= 7) positives.push(`Stress data coverage bon (${scp.toFixed(0)}%)`);
  else if (scp < 50) reasons.push(`Stress coverage partiel (${scp.toFixed(0)}%) — readiness partiel`);

  score = Math.max(0, Math.min(100, score));

  // Blocking rules
  let blocked = false;
  const blocks = [];
  if (b100 < 10) blocks.push("Bucket 1.00–1.25% insuffisant (n<10)");
  if (lwr > 25) blocks.push(`Lucky win rate > 25% (${lwr.toFixed(1)}%)`);
  if (lowerBoundBreakRate != null && lowerBoundBreakRate > 25) blocks.push(`LowerBound break rate > 25% (${lowerBoundBreakRate.toFixed(1)}%)`);
  if (blocks.length > 0) {
    blocked = true;
    blocks.forEach((b) => penalties.push(`Blocage : ${b}`));
  }

  if (scp < 50) reasons.push("Readiness partiel — stress data incomplet");

  // Verdict
  let verdict, targetBand, confidence;
  if (blocked) {
    verdict = "1 % non validé";
    targetBand = "0.50–0.65 % prudent";
    confidence = "Bloqué — conditions non remplies";
  } else if (score >= 80) {
    verdict = "1 % potentiellement validable";
    targetBand = "0.90–1.00 % sélectif";
    confidence = "Haute si sample 1% suffisant";
  } else if (score >= 65) {
    verdict = "0.75–1 % opportuniste";
    targetBand = "0.75–1.00 % selon setup";
    confidence = "Moyenne";
  } else if (score >= 50) {
    verdict = "0.65–0.80 % préférable";
    targetBand = "0.65–0.80 %";
    confidence = "Utilisable, mais 1 % non confirmé";
  } else if (score >= 35) {
    verdict = "0.50–0.65 % prudent";
    targetBand = "0.50–0.65 %";
    confidence = "Prudente";
  } else {
    verdict = "1 % non validé";
    targetBand = "0.50 % ou moins";
    confidence = "Faible";
  }

  return { score, verdict, targetBand, confidence, reasons, penalties, positives, blocked, b100, b080, b125 };
}

// ── Main component ──────────────────────────────────────────────────────────

export default function JournalPopPanel({ apiBase, active }) {
  const [journal, setJournal] = useState(null);
  const [calibrationSummary, setCalibrationSummary] = useState(null);
  const [cohortSummary, setCohortSummary] = useState([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [resolveSummary, setResolveSummary] = useState(null);
  const [showRawSections, setShowRawSections] = useState(false);

  // Seasonality V1 — read-only
  const [journalSeasonality, setJournalSeasonality] = useState(null);
  const [seasonalityLoading, setSeasonalityLoading] = useState(false);

  const uniqueJournalSymbols = useMemo(() => {
    if (!Array.isArray(journal?.records)) return [];
    const seen = new Set();
    const result = [];
    for (const r of journal.records) {
      const sym = String(r?.symbol ?? "").trim().toUpperCase();
      if (sym && !seen.has(sym)) { seen.add(sym); result.push(sym); }
      if (result.length >= 25) break;
    }
    return result;
  }, [journal]);

  const fetchJournalSeasonality = useCallback(async () => {
    if (!uniqueJournalSymbols.length) return;
    setSeasonalityLoading(true);
    try {
      const resp = await fetch(
        `${apiBase}/seasonality/scan-summary?tickers=${encodeURIComponent(uniqueJournalSymbols.join(","))}`,
      );
      if (!resp.ok) throw new Error("fetch_failed");
      const data = await resp.json();
      if (data?.ok) setJournalSeasonality(data);
    } catch {
      // silently ignore — V1 informational only
    } finally {
      setSeasonalityLoading(false);
    }
  }, [apiBase, uniqueJournalSymbols]);

  const loadJournal = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [journalResponse, cohortResponse, calibrationResponse] = await Promise.all([
        fetch(`${apiBase}/journal/wheel-validation`),
        fetch(`${apiBase}/journal/wheel-validation/cohort-summary`),
        fetch(`${apiBase}/journal/wheel-validation/calibration-summary`),
      ]);
      const payload = await journalResponse.json();
      const cohortPayload = await cohortResponse.json();
      const calibrationPayload = await calibrationResponse.json();
      if (!journalResponse.ok || payload?.ok !== true) throw new Error(payload?.error || "journal_fetch_failed");
      if (!cohortResponse.ok || cohortPayload?.ok !== true) throw new Error(cohortPayload?.error || "journal_cohort_summary_fetch_failed");
      if (!calibrationResponse.ok || calibrationPayload?.ok !== true) throw new Error(calibrationPayload?.error || "journal_calibration_summary_fetch_failed");
      setJournal(payload.journal ?? { version: "1.0", updatedAt: null, records: [] });
      setCohortSummary(Array.isArray(cohortPayload.summary) ? cohortPayload.summary : []);
      setCalibrationSummary(calibrationPayload.calibration ?? null);
      setHasLoaded(true);
    } catch (err) {
      setError(String(err?.message || err || "journal_fetch_failed"));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  const resolveExpired = useCallback(async () => {
    setResolving(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/journal/wheel-validation/resolve-expired`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "journal_resolve_expired_failed");
      setResolveSummary({
        resolved: Number(payload?.resolved ?? 0),
        skippedNoClose: Number(payload?.skippedNoClose ?? 0),
        errors: Array.isArray(payload?.errors) ? payload.errors.length : 0,
      });
      await loadJournal();
    } catch (err) {
      setError(String(err?.message || err || "journal_resolve_expired_failed"));
    } finally {
      setResolving(false);
    }
  }, [apiBase, loadJournal]);

  useEffect(() => {
    if (active && !hasLoaded && !loading) loadJournal();
  }, [active, hasLoaded, loading, loadJournal]);

  const records = useMemo(() => {
    const rows = Array.isArray(journal?.records) ? journal.records.slice() : [];
    return rows.sort((a, b) => String(b?.scanTimestamp ?? "").localeCompare(String(a?.scanTimestamp ?? "")));
  }, [journal]);

  const unresolvedRecords = useMemo(() => records.filter((r) => r?.resolution?.resolved !== true), [records]);
  const resolvedRecords = useMemo(() => records.filter((r) => r?.resolution?.resolved === true), [records]);

  // ── Core stats ─────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const expiredWorthlessCount = resolvedRecords.filter((r) => r?.resolution?.expiredWorthless === true).length;
    const assignmentCount = resolvedRecords.filter((r) => r?.resolution?.assigned === true).length;
    const winRate = resolvedRecords.length > 0 ? (expiredWorthlessCount / resolvedRecords.length) * 100 : null;

    const avgOf = (arr, fn) => {
      const vals = arr.map(fn).filter((v) => v != null);
      return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };

    const avgPop = avgOf(resolvedRecords, (r) => {
      const n = numberOrNull(r?.strike?.popEstimate);
      if (n == null) return null;
      return n > 1 ? n : n * 100;
    });

    const popResolved = resolvedRecords.filter((r) => typeof r?.resolution?.popPredictionCorrect === "boolean");
    const popAccuracy = popResolved.length > 0
      ? (popResolved.filter((r) => r.resolution.popPredictionCorrect === true).length / popResolved.length) * 100
      : null;

    const realizedValues = resolvedRecords.map((r) => numberOrNull(r?.resolution?.realizedPl)).filter((v) => v != null);
    const averageRealizedPl = realizedValues.length > 0 ? realizedValues.reduce((s, v) => s + v, 0) / realizedValues.length : null;

    return {
      totalRecords: records.length,
      resolvedCount: resolvedRecords.length,
      unresolvedCount: unresolvedRecords.length,
      expiredWorthlessCount,
      assignmentCount,
      winRate,
      avgPop,
      popAccuracy,
      averageRealizedPl,
    };
  }, [records, resolvedRecords, unresolvedRecords]);

  // ── Premium return buckets (Section B) ────────────────────────────────────

  const premiumReturnBuckets = useMemo(() => {
    const defs = [
      { label: "0.40–0.60 %", min: 0.40, max: 0.60 },
      { label: "0.60–0.80 %", min: 0.60, max: 0.80 },
      { label: "0.80–1.00 %", min: 0.80, max: 1.00 },
      { label: "1.00–1.25 %", min: 1.00, max: 1.25 },
      { label: "1.25 % +",    min: 1.25, max: Infinity },
    ];
    return defs.map((def) => {
      const matching = records.filter((r) => {
        const pct = numberOrNull(r?.snapshot?.premium_to_spot_pct) ??
          (r?.strike?.premium != null && r?.underlying?.spotAtScan != null
            ? (r.strike.premium / r.underlying.spotAtScan) * 100
            : null);
        if (pct == null) return false;
        return pct >= def.min && (def.max === Infinity ? true : pct < def.max);
      });
      const resolved = matching.filter((r) => r?.resolution?.resolved === true);
      const wins = resolved.filter((r) => r?.resolution?.expiredWorthless === true);
      const safe = matching.filter((r) => r?.strikeMode === "safe");
      const aggressive = matching.filter((r) => r?.strikeMode === "aggressive");
      const avgPop = (() => {
        const vals = resolved.map((r) => {
          const n = numberOrNull(r?.strike?.popEstimate);
          if (n == null) return null;
          return n > 1 ? n : n * 100;
        }).filter((v) => v != null);
        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      })();
      const avgPremium = (() => {
        const vals = resolved.map((r) => numberOrNull(r?.strike?.premium)).filter((v) => v != null);
        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      })();
      const winRate = resolved.length > 0 ? (wins.length / resolved.length) * 100 : null;
      return {
        label: def.label,
        count: matching.length,
        resolvedCount: resolved.length,
        winRate,
        avgPop,
        avgPremium,
        safeCount: safe.length,
        aggressiveCount: aggressive.length,
      };
    });
  }, [records]);

  // ── Safe vs Aggressive from calibration summary ────────────────────────────

  const safeModeData = useMemo(() => {
    const rows = calibrationSummary?.v2?.strikeModeV2 ?? [];
    return rows.find((r) => r?.bucket === "safe") ?? null;
  }, [calibrationSummary]);

  const aggressiveModeData = useMemo(() => {
    const rows = calibrationSummary?.v2?.strikeModeV2 ?? [];
    return rows.find((r) => r?.bucket === "aggressive") ?? null;
  }, [calibrationSummary]);

  // ── Ticker leaderboard ─────────────────────────────────────────────────────

  const tickerLeaderboard = useMemo(() => {
    const cohorts = calibrationSummary?.v2?.tickerCohorts ?? [];
    return cohorts.map((row) => {
      const safeCount = records.filter((r) => r?.symbol === row.ticker && r?.strikeMode === "safe").length;
      const aggressiveCount = records.filter((r) => r?.symbol === row.ticker && r?.strikeMode === "aggressive").length;
      return { ...row, safeCount, aggressiveCount };
    });
  }, [calibrationSummary, records]);

  const hasProbabilisticCalibrationData = Number(calibrationSummary?.totalResolved ?? 0) > 0;

  // ── Objectif 1% status ─────────────────────────────────────────────────────

  const objectif1pctStatus = useMemo(() => {
    const above1pct = premiumReturnBuckets.filter((b) => b.label.startsWith("1.00") || b.label.startsWith("1.25"));
    const totalAbove = above1pct.reduce((s, b) => s + b.count, 0);
    const totalAll = premiumReturnBuckets.reduce((s, b) => s + b.count, 0);
    if (totalAll === 0) return { label: "N/D", tone: "muted" };
    const pct = (totalAbove / totalAll) * 100;
    if (pct >= 30) return { label: `Atteint (${pct.toFixed(0)}% des records)`, tone: "good" };
    if (pct >= 10) return { label: `En cours (${pct.toFixed(0)}% des records)`, tone: "warn" };
    return { label: "En validation", tone: "muted" };
  }, [premiumReturnBuckets]);

  // ── Win Quality V2A ────────────────────────────────────────────────────────

  const winQualityStats = useMemo(() => computeWinQualityStats(records), [records]);

  const stressCoverage = useMemo(() => computeStressCoverage(resolvedRecords), [resolvedRecords]);

  // ── 1% Readiness V2B ────────────────────────────────────────────────────────

  const readiness = useMemo(() => {
    const stTouchedKnown = resolvedRecords.filter((r) => r?.resolution?.strikeTouched != null);
    const strikeTouchRate = stTouchedKnown.length > 0
      ? (stTouchedKnown.filter((r) => r.resolution.strikeTouched === true).length / stTouchedKnown.length) * 100
      : null;

    const lbKnown = resolvedRecords.filter((r) => r?.resolution?.brokeLowerBound != null);
    const lowerBoundBreakRate = lbKnown.length > 0
      ? (lbKnown.filter((r) => r.resolution.brokeLowerBound === true).length / lbKnown.length) * 100
      : null;

    return computeOnePercentReadiness({
      resolvedCount: stats.resolvedCount,
      cleanWinRate: winQualityStats.cleanWinRate,
      stressedWinRate: winQualityStats.stressedWinRate,
      luckyWinRate: winQualityStats.luckyWinRate,
      assignmentRate: winQualityStats.assignmentRate,
      strikeTouchRate,
      lowerBoundBreakRate,
      avgPop: stats.avgPop,
      stressCoveragePct: stressCoverage.globalCoverage,
      premiumBuckets: premiumReturnBuckets,
    });
  }, [resolvedRecords, stats, winQualityStats, stressCoverage, premiumReturnBuckets]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="bg-[#020617] min-h-screen space-y-4 p-4">

      {/* ── SECTION A — HEADER PRO ──────────────────────────────────────────── */}
      <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-6">
        {/* Top bar */}
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                Journal POP Pro
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-[10px] text-slate-500">
                SQLite · Read-only · Calibration active OFF
              </span>
              {hasLoaded && (
                <span className={`rounded-full border px-3 py-1 text-[10px] font-bold tabular-nums ${
                  readiness.score >= 80 ? "border-emerald-800/50 bg-emerald-900/20 text-emerald-400" :
                  readiness.score >= 65 ? "border-indigo-800/50 bg-indigo-900/20 text-indigo-400" :
                  readiness.score >= 50 ? "border-sky-800/50 bg-sky-900/20 text-sky-400" :
                  readiness.score >= 35 ? "border-amber-800/50 bg-amber-900/20 text-amber-400" :
                  "border-rose-800/50 bg-rose-900/20 text-rose-400"
                }`}>
                  1% Readiness {readiness.score}/100
                </span>
              )}
            </div>
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-slate-100">
              Calibration réelle — Données historiques
            </h2>
            <p className="mt-1.5 text-sm text-slate-500">
              Journal POP Pro V2B · Win Quality + Stress Coverage + 1% Readiness · Lecture seule · Aucun impact scanner, IBKR, Yahoo, EliteScore
            </p>
          </div>
          <div className="flex flex-col gap-2 md:items-end">
            <button
              type="button"
              onClick={loadJournal}
              disabled={loading}
              className="inline-flex items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Refresh Journal
              <RefreshCw className={`ml-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={resolveExpired}
              disabled={resolving || loading}
              className="inline-flex items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Résoudre expirations échues
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-2xl border border-rose-800/50 bg-rose-900/20 px-4 py-3 text-sm text-rose-400">
            {error}
          </div>
        )}
        {resolveSummary && (
          <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-800/50 px-4 py-3 text-sm text-slate-400">
            Résolus : <span className="text-emerald-400 font-semibold">{resolveSummary.resolved}</span>
            {" · "}Sans close : {resolveSummary.skippedNoClose}
            {" · "}Erreurs : {resolveSummary.errors}
          </div>
        )}
        {!hasLoaded && !loading && (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
            Ouvrez l'onglet puis chargez le journal à la demande.
          </div>
        )}

        {/* KPI Grid */}
        {hasLoaded && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ProKpi label="Records totaux" value={stats.totalRecords} large />
              <ProKpi label="Records résolus" value={stats.resolvedCount} tone="good" large />
              <ProKpi label="Non résolus" value={stats.unresolvedCount} tone={stats.unresolvedCount > 0 ? "warn" : "muted"} large />
              <ProKpi
                label="Win rate résolu"
                value={stats.winRate != null ? `${stats.winRate.toFixed(1)} %` : null}
                tone={stats.winRate != null && stats.winRate >= 80 ? "good" : "default"}
                large
                sub="Expired worthless / résolus"
              />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ProKpi
                label="POP moyenne (résolus)"
                value={stats.avgPop != null ? `${stats.avgPop.toFixed(1)} %` : null}
                tone="info"
                sub="Estimation scanner"
              />
              <ProKpi
                label="Prime moy. SAFE"
                value={safeModeData?.avgPremium != null ? formatMoney(safeModeData.avgPremium) : null}
                tone="good"
                sub={safeModeData ? `n=${safeModeData.resolvedCount}` : undefined}
              />
              <ProKpi
                label="Prime moy. AGGRESSIVE"
                value={aggressiveModeData?.avgPremium != null ? formatMoney(aggressiveModeData.avgPremium) : null}
                tone="warn"
                sub={aggressiveModeData ? `n=${aggressiveModeData.resolvedCount}` : undefined}
              />
              <ProKpi
                label="Objectif 1 % / sem."
                value={objectif1pctStatus.label}
                tone={objectif1pctStatus.tone}
              />
            </div>

            {/* Methodological warning */}
            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-800/30 bg-amber-900/10 px-4 py-3">
              <span className="mt-0.5 text-amber-500 text-sm">⚠</span>
              <p className="text-[11px] text-amber-500/80 leading-relaxed">
                Un win rate élevé doit être validé avec stress metrics, touch rate et régimes de marché.
                Les résultats actuels reflètent un échantillon historique limité — interprétez avec prudence.
              </p>
            </div>
          </>
        )}
      </section>

      {/* ── SECTION V2A — WIN QUALITY ───────────────────────────────────────── */}
      {hasLoaded && (
        <ProSection
          title="Win Quality — Qualité réelle des victoires"
          badge="V2A"
          subtitle="Classification des victoires selon les métriques de stress disponibles. Basé sur les records résolus uniquement."
        >
          {winQualityStats.resolvedCount === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              Aucun record résolu. Les classifications apparaîtront après expiration des premières positions.
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <ProKpi
                  label="Clean wins"
                  value={winQualityStats.cleanWinCount}
                  tone="good"
                  sub={winQualityStats.cleanWinRate != null ? `${winQualityStats.cleanWinRate.toFixed(1)}% résolus` : undefined}
                />
                <ProKpi
                  label="Normal wins"
                  value={winQualityStats.normalWinCount}
                  tone="info"
                  sub={winQualityStats.normalWinRate != null ? `${winQualityStats.normalWinRate.toFixed(1)}% résolus` : undefined}
                />
                <ProKpi
                  label="Stressed wins"
                  value={winQualityStats.stressedWinCount}
                  tone="warn"
                  sub={winQualityStats.stressedWinRate != null ? `${winQualityStats.stressedWinRate.toFixed(1)}% résolus` : undefined}
                />
                <ProKpi
                  label="Lucky wins"
                  value={winQualityStats.luckyWinCount}
                  tone="warn"
                  sub={winQualityStats.luckyWinRate != null ? `${winQualityStats.luckyWinRate.toFixed(1)}% résolus` : undefined}
                />
                <ProKpi
                  label="Assignments"
                  value={winQualityStats.assignmentCount}
                  tone="risk"
                  sub={winQualityStats.assignmentRate != null ? `${winQualityStats.assignmentRate.toFixed(1)}% résolus` : undefined}
                />
                <ProKpi
                  label="Pending"
                  value={winQualityStats.pendingCount}
                  tone={winQualityStats.pendingCount > 0 ? "warn" : "muted"}
                  sub="Non résolus"
                />
              </div>

              <div className="mt-4 rounded-xl border border-slate-700/40 bg-slate-800/20 px-4 py-3 space-y-1">
                <p className="text-[11px] text-slate-500"><span className="text-emerald-400 font-semibold">Clean win</span> — Expired worthless, aucun stress détecté.</p>
                <p className="text-[11px] text-slate-500"><span className="text-sky-400 font-semibold">Normal win</span> — Expired worthless, catégorie résiduelle.</p>
                <p className="text-[11px] text-slate-500"><span className="text-amber-400 font-semibold">Stressed win</span> — Strike touché OU drawdown ≥ 5%.</p>
                <p className="text-[11px] text-slate-500"><span className="text-amber-400 font-semibold">Lucky win</span> — LowerBound cassé mais expiré OTM.</p>
                <p className="text-[11px] text-slate-500"><span className="text-rose-400 font-semibold">Assignment</span> — Option assignée.</p>
              </div>

              {/* Stress Data Coverage */}
              <div className="mt-5 rounded-2xl border border-slate-700/40 bg-slate-800/30 p-4">
                <h4 className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 mb-4">
                  Stress Data Coverage
                </h4>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Strike touch</p>
                    <p className="mt-2 text-xl font-bold tabular-nums text-slate-100">
                      {stressCoverage.strikeTouchedCoverage != null ? `${stressCoverage.strikeTouchedCoverage.toFixed(0)}%` : <span className="text-slate-600 text-base">N/D</span>}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-600">Records avec strikeTouched connu</p>
                  </div>
                  <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">LowerBound break</p>
                    <p className="mt-2 text-xl font-bold tabular-nums text-slate-100">
                      {stressCoverage.lowerBoundCoverage != null ? `${stressCoverage.lowerBoundCoverage.toFixed(0)}%` : <span className="text-slate-600 text-base">N/D</span>}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-600">Records avec brokeLowerBound connu</p>
                  </div>
                  <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Drawdown</p>
                    <p className="mt-2 text-xl font-bold tabular-nums text-slate-100">
                      {stressCoverage.drawdownCoverage != null ? `${stressCoverage.drawdownCoverage.toFixed(0)}%` : <span className="text-slate-600 text-base">N/D</span>}
                    </p>
                    <p className="mt-1 text-[10px] text-slate-600">Records avec drawdownPct connu</p>
                  </div>
                  <div className="rounded-xl border border-slate-700/50 bg-slate-800/50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Coverage global</p>
                    <p className={`mt-2 text-xl font-bold tabular-nums ${stressCoverage.globalCoverage == null ? "text-slate-600" : stressCoverage.globalCoverage > 70 ? "text-emerald-400" : stressCoverage.globalCoverage >= 30 ? "text-amber-400" : "text-rose-400"}`}>
                      {stressCoverage.globalCoverage != null ? `${stressCoverage.globalCoverage.toFixed(0)}%` : <span className="text-base">N/D</span>}
                    </p>
                    <p className="mt-1.5">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${
                        stressCoverage.verdict === "Bon"
                          ? "border-emerald-800/50 bg-emerald-900/40 text-emerald-400"
                          : stressCoverage.verdict === "Partiel"
                          ? "border-amber-800/50 bg-amber-900/40 text-amber-400"
                          : "border-rose-800/50 bg-rose-900/40 text-rose-400"
                      }`}>
                        {stressCoverage.verdict}
                      </span>
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-slate-600">
                  Coverage calculé sur {winQualityStats.resolvedCount} records résolus. &lt;30% : Faible · 30–70% : Partiel · &gt;70% : Bon.
                </p>
              </div>
            </>
          )}
        </ProSection>
      )}

      {/* ── SECTION V2B — 1% READINESS ──────────────────────────────────────── */}
      {hasLoaded && (
        <ProSection
          title="1% Readiness — Capacité statistique à viser 1% / semaine"
          badge="V2B"
          subtitle="Score calculé sur les données résolues actuelles. Indicatif uniquement — aucun impact scanner, IBKR, EliteScore."
        >
          {stats.resolvedCount === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              Aucun record résolu. Le score apparaîtra après expiration des premières positions.
            </div>
          ) : (
            <>
              {/* Score card + progress bar */}
              <div className="rounded-2xl border border-slate-700/50 bg-slate-800/40 p-5">
                <div className="flex flex-wrap items-end gap-6">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 mb-2">Score global</p>
                    <div className="flex items-baseline gap-2">
                      <span className={`text-5xl font-bold tabular-nums leading-none ${
                        readiness.score >= 80 ? "text-emerald-400" :
                        readiness.score >= 65 ? "text-indigo-400" :
                        readiness.score >= 50 ? "text-sky-400" :
                        readiness.score >= 35 ? "text-amber-400" : "text-rose-400"
                      }`}>{readiness.score}</span>
                      <span className="text-xl text-slate-600">/100</span>
                    </div>
                  </div>
                  <div className="flex-1 min-w-[200px]">
                    <p className={`text-lg font-bold leading-tight ${
                      readiness.score >= 80 ? "text-emerald-400" :
                      readiness.score >= 65 ? "text-indigo-400" :
                      readiness.score >= 50 ? "text-sky-400" :
                      readiness.score >= 35 ? "text-amber-400" : "text-rose-400"
                    }`}>{readiness.verdict}</p>
                    <p className="mt-1 text-sm font-semibold text-slate-300">Target : {readiness.targetBand}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">Confiance : {readiness.confidence}</p>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="mt-5">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800 border border-slate-700/50">
                    <div
                      className={`h-full rounded-full ${
                        readiness.score >= 80 ? "bg-emerald-500" :
                        readiness.score >= 65 ? "bg-indigo-500" :
                        readiness.score >= 50 ? "bg-sky-500" :
                        readiness.score >= 35 ? "bg-amber-500" : "bg-rose-500"
                      }`}
                      style={{ width: `${readiness.score}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[9px]">
                    <span className="text-slate-700">0</span>
                    <span className="text-rose-900">Non validé · 35</span>
                    <span className="text-amber-900">Prudent · 50</span>
                    <span className="text-sky-900">0.65–0.80% · 65</span>
                    <span className="text-indigo-900">Opportuniste · 80</span>
                    <span className="text-emerald-900">1% validable · 100</span>
                  </div>
                </div>
              </div>

              {/* Positives + Freins */}
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-emerald-800/20 bg-emerald-900/10 p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-600 mb-3">Positifs</p>
                  {readiness.positives.length === 0 ? (
                    <p className="text-[11px] text-slate-600">Aucun signal positif fort détecté.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {readiness.positives.map((p, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] text-emerald-400">
                          <span className="flex-shrink-0 mt-0.5 text-emerald-600">+</span>
                          {p}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-2xl border border-rose-800/20 bg-rose-900/10 p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-rose-600 mb-3">Freins</p>
                  {readiness.penalties.length === 0 && readiness.reasons.length === 0 ? (
                    <p className="text-[11px] text-slate-600">Aucun frein détecté.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {readiness.penalties.map((p, i) => (
                        <li key={`pen-${i}`} className="flex items-start gap-2 text-[11px] text-rose-400">
                          <span className="flex-shrink-0 mt-0.5 text-rose-600">−</span>
                          {p}
                        </li>
                      ))}
                      {readiness.reasons.map((r, i) => (
                        <li key={`rsn-${i}`} className="flex items-start gap-2 text-[11px] text-amber-400">
                          <span className="flex-shrink-0 mt-0.5 text-amber-600">›</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <p className="mt-3 text-[11px] text-slate-600 italic">
                Score V2B basé sur {stats.resolvedCount} records résolus · bucket 1.00–1.25%: n={readiness.b100} · 0.80–1.00%: n={readiness.b080} · 1.25%+: n={readiness.b125} · aucun impact scanner.
              </p>
            </>
          )}
        </ProSection>
      )}

      {/* ── SECTION B — OBJECTIF 1 % / SEMAINE ─────────────────────────────── */}
      {hasLoaded && (
        <ProSection
          title="Objectif 1 % / Semaine — Buckets de rendement prime"
          badge="Premium / Spot"
          subtitle="Distribution des records par rendement de prime (premium / cours sous-jacent au scan). Cible : 1.00–1.25 %."
        >
          <p className="mb-4 text-[10px] text-slate-600 italic">
            Verdict basé sur échantillon résolu, win rate et prudence statistique —
            "Core défensif" exige n≥30 résolu · buckets ≥0.80% ne peuvent pas afficher "Core défensif" · 1.25%+ toujours spéculatif.
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-slate-300">
              <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-3 py-3 font-semibold text-left">Bucket</th>
                  <th className="px-3 py-3 font-semibold text-right">Records</th>
                  <th className="px-3 py-3 font-semibold text-right">Résolus</th>
                  <th className="px-3 py-3 font-semibold text-right">Win rate</th>
                  <th className="px-3 py-3 font-semibold text-right">POP moy.</th>
                  <th className="px-3 py-3 font-semibold text-right">Prime moy.</th>
                  <th className="px-3 py-3 font-semibold text-right">Safe</th>
                  <th className="px-3 py-3 font-semibold text-right">Agressif</th>
                  <th className="px-3 py-3 font-semibold">Confiance</th>
                  <th className="px-3 py-3 font-semibold">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {premiumReturnBuckets.map((b) => (
                  <tr key={b.label} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-3 py-3 font-bold text-slate-100">{b.label}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{b.count || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-slate-400">{b.resolvedCount || "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {b.winRate != null ? (
                        <span className={b.winRate >= 80 ? "text-emerald-400 font-semibold" : b.winRate >= 60 ? "text-amber-400" : "text-rose-400"}>
                          {b.winRate.toFixed(1)} %
                        </span>
                      ) : <span className="text-slate-600">N/D</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                      {b.avgPop != null ? `${b.avgPop.toFixed(1)} %` : <span className="text-slate-600">N/D</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-sky-400">
                      {b.avgPremium != null ? formatMoney(b.avgPremium) : <span className="text-slate-600">N/D</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-emerald-500">{b.safeCount || 0}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-rose-400">{b.aggressiveCount || 0}</td>
                    <td className="px-3 py-3"><ConfidenceBadge sample={b.resolvedCount} /></td>
                    <td className="px-3 py-3"><PremiumVerdictBadge bucketLabel={b.label} count={b.count} resolvedCount={b.resolvedCount} winRate={b.winRate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-slate-600">
            Records sans premium_to_spot_pct calculé exclus de la distribution. Confiance : n&lt;10 faible · 10–29 préliminaire · 30–99 utilisable · 100+ robuste.
          </p>
        </ProSection>
      )}

      {/* ── SECTION C — SAFE vs AGGRESSIVE ─────────────────────────────────── */}
      {hasLoaded && (
        <ProSection
          title="Safe vs Aggressive — Comparaison mode strike"
          badge="V2 calibration"
          subtitle="Données issues de la calibration probabilistique V2. Stress metrics disponibles uniquement pour records avec window data."
        >
          {!hasProbabilisticCalibrationData ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              Aucun record résolu — calibration Safe/Aggressive disponible après expiration des premières positions.
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {/* SAFE */}
                <div className="rounded-2xl border border-emerald-800/30 bg-emerald-900/10 p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="rounded border border-emerald-700/50 bg-emerald-900/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-400">Safe</span>
                    <span className="text-[11px] text-slate-500">Strike défensif · POP haute attendue</span>
                  </div>
                  <div className="space-y-2 text-xs">
                    {[
                      ["Records résolus", safeModeData?.resolvedCount != null ? String(safeModeData.resolvedCount) : "N/D", "default"],
                      ["Win rate", safeModeData?.actualWinRate != null ? formatPercent(safeModeData.actualWinRate) : "N/D", safeModeData?.actualWinRate >= 80 ? "good" : "default"],
                      ["POP moyenne", safeModeData?.avgPop != null ? formatPercent(safeModeData.avgPop) : "N/D", "info"],
                      ["Prime moyenne", safeModeData?.avgPremium != null ? formatMoney(safeModeData.avgPremium) : "N/D", "default"],
                      ["Strike touch rate", safeModeData?.strikeTouchRate != null ? formatPercent(safeModeData.strikeTouchRate) : "N/D", "default"],
                      ["Assignment rate", safeModeData?.assignmentRate != null ? formatPercent(safeModeData.assignmentRate) : "N/D", "default"],
                      ["Drawdown moyen", safeModeData?.avgDrawdownPct != null ? formatPercent(safeModeData.avgDrawdownPct) : "N/D", "default"],
                      ["LowerBound cassé", safeModeData?.lowerBoundBreakRate != null ? formatPercent(safeModeData.lowerBoundBreakRate) : "N/D", "default"],
                    ].map(([lbl, val, tone]) => (
                      <div key={lbl} className="flex justify-between items-center border-b border-slate-800/60 pb-1.5">
                        <span className="text-slate-500">{lbl}</span>
                        <span className={tone === "good" ? "text-emerald-400 font-semibold" : tone === "info" ? "text-sky-400" : val === "N/D" ? "text-slate-600" : "text-slate-300"}>
                          {val}
                        </span>
                      </div>
                    ))}
                    <div className="mt-2 pt-1">
                      <ConfidenceBadge sample={safeModeData?.resolvedCount} />
                    </div>
                  </div>
                </div>

                {/* AGGRESSIVE */}
                <div className="rounded-2xl border border-rose-800/30 bg-rose-900/10 p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="rounded border border-rose-700/50 bg-rose-900/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-rose-400">Aggressive</span>
                    <span className="text-[11px] text-slate-500">Strike agressif · Prime plus haute</span>
                  </div>
                  <div className="space-y-2 text-xs">
                    {[
                      ["Records résolus", aggressiveModeData?.resolvedCount != null ? String(aggressiveModeData.resolvedCount) : "N/D", "default"],
                      ["Win rate", aggressiveModeData?.actualWinRate != null ? formatPercent(aggressiveModeData.actualWinRate) : "N/D", aggressiveModeData?.actualWinRate >= 80 ? "good" : "default"],
                      ["POP moyenne", aggressiveModeData?.avgPop != null ? formatPercent(aggressiveModeData.avgPop) : "N/D", "info"],
                      ["Prime moyenne", aggressiveModeData?.avgPremium != null ? formatMoney(aggressiveModeData.avgPremium) : "N/D", "default"],
                      ["Strike touch rate", aggressiveModeData?.strikeTouchRate != null ? formatPercent(aggressiveModeData.strikeTouchRate) : "N/D", "default"],
                      ["Assignment rate", aggressiveModeData?.assignmentRate != null ? formatPercent(aggressiveModeData.assignmentRate) : "N/D", "default"],
                      ["Drawdown moyen", aggressiveModeData?.avgDrawdownPct != null ? formatPercent(aggressiveModeData.avgDrawdownPct) : "N/D", "default"],
                      ["LowerBound cassé", aggressiveModeData?.lowerBoundBreakRate != null ? formatPercent(aggressiveModeData.lowerBoundBreakRate) : "N/D", "default"],
                    ].map(([lbl, val, tone]) => (
                      <div key={lbl} className="flex justify-between items-center border-b border-slate-800/60 pb-1.5">
                        <span className="text-slate-500">{lbl}</span>
                        <span className={tone === "good" ? "text-emerald-400 font-semibold" : tone === "info" ? "text-sky-400" : val === "N/D" ? "text-slate-600" : "text-slate-300"}>
                          {val}
                        </span>
                      </div>
                    ))}
                    <div className="mt-2 pt-1">
                      <ConfidenceBadge sample={aggressiveModeData?.resolvedCount} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-xl border border-slate-700/40 bg-slate-800/30 px-4 py-3">
                <span className="text-slate-600 text-sm">ℹ</span>
                <p className="text-[11px] text-slate-600">
                  Les stress metrics sont disponibles pour les records résolus actuels. Prochaine phase : intégrer ces métriques dans les buckets, les modes et le score 1 % readiness.
                </p>
              </div>
            </>
          )}
        </ProSection>
      )}

      {/* ── SECTION D — TICKER LEADERBOARD ─────────────────────────────────── */}
      {hasLoaded && (
        <ProSection
          title="Ticker Leaderboard — Calibration par actif"
          badge="≥ 3 résolus"
          subtitle="Tickers avec au moins 3 records résolus. Verdict calculé à partir des données historiques disponibles."
        >
          <p className="mb-4 text-[10px] text-slate-600 italic">
            Verdict basé sur échantillon résolu, win rate, rendement prime et prudence statistique —
            "Core" exige n≥30 · "Balanced" exige n≥30 · tickers spéculatifs connus bloqués à "Agressif sain" maximum.
          </p>
          {tickerLeaderboard.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              Aucun ticker avec assez de records résolus (minimum 3). Revenez après expiration de davantage de positions.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-slate-300">
                <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3 font-semibold text-left">Ticker</th>
                    <th className="px-3 py-3 font-semibold text-right">Résolus</th>
                    <th className="px-3 py-3 font-semibold text-right">Win rate</th>
                    <th className="px-3 py-3 font-semibold text-right">POP moy.</th>
                    <th className="px-3 py-3 font-semibold text-right">Prime moy.</th>
                    <th className="px-3 py-3 font-semibold text-right">Safe</th>
                    <th className="px-3 py-3 font-semibold text-right">Agressif</th>
                    <th className="px-3 py-3 font-semibold">Confiance</th>
                    <th className="px-3 py-3 font-semibold">Verdict</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {tickerLeaderboard.map((row) => (
                    <tr key={row.ticker} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-3 py-3 font-bold text-slate-100">{row.ticker}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{row.resolvedCount ?? "—"}</td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {row.actualWinRate != null ? (
                          <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : row.actualWinRate >= 60 ? "text-amber-400" : "text-rose-400"}>
                            {row.actualWinRate.toFixed(1)} %
                          </span>
                        ) : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-400">
                        {row.avgPop != null ? `${row.avgPop.toFixed(1)} %` : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-sky-400">
                        {row.avgPremium != null ? formatMoney(row.avgPremium) : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-emerald-500">{row.safeCount || 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-rose-400">{row.aggressiveCount || 0}</td>
                      <td className="px-3 py-3"><ConfidenceBadge sample={row.resolvedCount} /></td>
                      <td className="px-3 py-3">
                        <TickerVerdictBadge ticker={row.ticker} resolvedCount={row.resolvedCount} winRate={row.actualWinRate} avgPremium={row.avgPremium} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ProSection>
      )}

      {/* ── SECTION E — DATA CONFIDENCE ─────────────────────────────────────── */}
      {hasLoaded && (
        <ProSection
          title="Confiance statistique — État de la calibration"
          badge="Read-only"
          subtitle="Évaluation de la fiabilité des résultats actuels."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Sample total</p>
              <p className="mt-2 text-xl font-bold text-slate-100">{stats.totalRecords}</p>
              <p className="mt-1 text-[11px] text-slate-600">Tous records (safe + aggressive)</p>
            </div>
            <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Sample résolu</p>
              <p className="mt-2 text-xl font-bold text-slate-100">{stats.resolvedCount}</p>
              <div className="mt-1.5"><ConfidenceBadge sample={stats.resolvedCount} /></div>
            </div>
            <div className="rounded-2xl border border-slate-700/60 bg-slate-800/40 p-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Non résolu</p>
              <p className="mt-2 text-xl font-bold text-amber-400">{stats.unresolvedCount}</p>
              <p className="mt-1 text-[11px] text-slate-600">En cours d'accumulation</p>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {[
              stats.resolvedCount < 30 && "Échantillon résolu encore limité pour valider 1 % systématique.",
              stats.winRate != null && stats.winRate >= 95 && "Le win rate élevé doit être interprété avec stress metrics et régimes de marché.",
              "Les résultats doivent être segmentés par régime de marché (bull/bear/sideways) pour une validation complète.",
              "Les stress metrics sont disponibles pour les records résolus actuels. Prochaine étape : intégrer clean/stressed/lucky wins, strike touch et LowerBound break directement dans les buckets, les modes et les tickers.",
            ].filter(Boolean).map((msg, i) => (
              <div key={i} className="flex items-start gap-2 rounded-xl border border-slate-700/40 bg-slate-800/30 px-4 py-2.5">
                <span className="text-slate-600 text-sm mt-0.5">›</span>
                <p className="text-[11px] text-slate-500 leading-relaxed">{msg}</p>
              </div>
            ))}
          </div>
        </ProSection>
      )}

      {/* ── SECTION F — MÉTRIQUES V2 PRÉPARÉES ─────────────────────────────── */}
      {hasLoaded && (
        <ProSection
          title="Métriques avancées — Préparées pour V2"
          badge="Prochaine phase"
          subtitle="Placeholders visuels. Aucune donnée inventée — tracking requis pour activation."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[
              { label: "Days to First Touch", note: "Tracking requis" },
              { label: "Premium Efficiency", note: "Prime / Strike %" },
              { label: "Market Regime", note: "Bull / Bear / Sideways" },
              { label: "VIX Bucket", note: "Volatilité marché" },
              { label: "Cluster Risk", note: "Secteur / corrélation" },
              { label: "IV Rank at Scan", note: "IVR au moment scan" },
            ].map(({ label, note }) => (
              <div key={label} className="rounded-xl border border-slate-700/40 bg-slate-800/20 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
                <p className="mt-2 text-lg font-bold text-slate-700">N/D</p>
                <p className="mt-1 text-[10px] text-slate-700">{note}</p>
                <div className="mt-2">
                  <PlaceholderBadge label="À venir V2" />
                </div>
              </div>
            ))}
          </div>
        </ProSection>
      )}

      {/* ── SECTION G — DÉTAILS AVANCÉS (preserved, togglable) ─────────────── */}
      {hasLoaded && (
        <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-5">
          <button
            type="button"
            onClick={() => setShowRawSections((s) => !s)}
            className="flex w-full items-center justify-between text-left"
          >
            <div>
              <h3 className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400">
                Détails historiques — Calibration complète
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-600">
                Cohorts d'expiration · POP buckets · DTE stress · FTQS · Tickers calibrés · Secteurs · Tables raw
              </p>
            </div>
            <span className="ml-4 text-slate-500 text-lg">{showRawSections ? "↑" : "↓"}</span>
          </button>

          {showRawSections && (
            <div className="mt-5 space-y-4">

              {/* Cohort summary */}
              <DarkTable
                title="Vue cohorte d'expiration"
                headers={["Expiration", "Scans", "Candidats", "Symboles uniq.", "DTE min/max", "POP moy.", "EliteScore moy.", "Résolus / Non résolus"]}
                rows={cohortSummary.map((row) => (
                  <tr key={`cohort-${String(row?.expirationCohort ?? "na")}`} className="hover:bg-slate-800/30 transition-colors">
                    <td className="px-3 py-2.5 font-semibold text-slate-200">{formatCompactExpiration(row?.expirationCohort)}</td>
                    <td className="px-3 py-2.5">{numberOrNull(row?.scanCount) ?? 0}</td>
                    <td className="px-3 py-2.5">{numberOrNull(row?.candidateCount) ?? 0}</td>
                    <td className="px-3 py-2.5">{numberOrNull(row?.uniqueSymbols) ?? 0}</td>
                    <td className="px-3 py-2.5">{formatDteRange(row?.minDte, row?.maxDte)}</td>
                    <td className="px-3 py-2.5 text-sky-400">{formatPop(row?.avgPopEstimate)}</td>
                    <td className="px-3 py-2.5">{numberOrNull(row?.avgEliteScore)?.toFixed(1) ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <span className="text-emerald-400">{numberOrNull(row?.resolvedCount) ?? 0}</span>
                      <span className="text-slate-600"> / </span>
                      <span className="text-amber-400">{numberOrNull(row?.unresolvedCount) ?? 0}</span>
                    </td>
                  </tr>
                ))}
              />

              {/* Calibration probabilistique */}
              {!hasProbabilisticCalibrationData ? (
                <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
                  Aucun record résolu pour l'instant. La calibration commencera après expiration.
                </div>
              ) : (
                <div className="space-y-4">
                  {/* V1 buckets */}
                  {[
                    { title: "POP buckets — Calibration V1", data: calibrationSummary?.popBuckets ?? [] },
                    { title: "DTE buckets — Calibration V1", data: calibrationSummary?.dteBuckets ?? [] },
                    { title: "Strike mode — Calibration V1", data: calibrationSummary?.strikeModeBuckets ?? [] },
                  ].map(({ title, data }) => (
                    <DarkTable
                      key={title}
                      title={title}
                      headers={["Bucket", "Sample", "POP préd. moy.", "Win rate réel", "Correct", "Incorrect", "Brier", "Warning"]}
                      rows={data.map((row) => (
                        <tr key={`${title}-${String(row?.bucket ?? "na")}`} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-3 py-2.5 font-semibold text-slate-200">{row?.bucket || "—"}</td>
                          <td className="px-3 py-2.5">{numberOrNull(row?.sampleSize) ?? 0}</td>
                          <td className="px-3 py-2.5 text-sky-400">{formatPercent(row?.predictedAvgPop)}</td>
                          <td className="px-3 py-2.5">
                            {row?.actualWinRate != null ? (
                              <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : "text-amber-400"}>
                                {formatPercent(row.actualWinRate)}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-emerald-500">{numberOrNull(row?.correctCount) ?? 0}</td>
                          <td className="px-3 py-2.5 text-rose-400">{numberOrNull(row?.incorrectCount) ?? 0}</td>
                          <td className="px-3 py-2.5 text-slate-400">{numberOrNull(row?.brierScore)?.toFixed(3) ?? "—"}</td>
                          <td className="px-3 py-2.5">
                            {row?.confidenceWarning ? (
                              <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span>
                            ) : "—"}
                          </td>
                        </tr>
                      ))}
                    />
                  ))}

                  {/* FTQS V1 */}
                  {(calibrationSummary?.hasFtqsData ?? false) && (
                    <DarkTable
                      title="FTQS buckets — Calibration V1"
                      headers={["Bucket", "Sample", "POP préd. moy.", "Win rate réel", "Correct", "Incorrect", "Brier", "Warning"]}
                      rows={(calibrationSummary?.ftqsBuckets ?? []).map((row) => (
                        <tr key={`ftqs-${String(row?.bucket ?? "na")}`} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-3 py-2.5 font-semibold text-slate-200">{row?.bucket || "—"}</td>
                          <td className="px-3 py-2.5">{numberOrNull(row?.sampleSize) ?? 0}</td>
                          <td className="px-3 py-2.5 text-sky-400">{formatPercent(row?.predictedAvgPop)}</td>
                          <td className="px-3 py-2.5">{row?.actualWinRate != null ? <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : "text-amber-400"}>{formatPercent(row.actualWinRate)}</span> : "—"}</td>
                          <td className="px-3 py-2.5 text-emerald-500">{numberOrNull(row?.correctCount) ?? 0}</td>
                          <td className="px-3 py-2.5 text-rose-400">{numberOrNull(row?.incorrectCount) ?? 0}</td>
                          <td className="px-3 py-2.5 text-slate-400">{numberOrNull(row?.brierScore)?.toFixed(3) ?? "—"}</td>
                          <td className="px-3 py-2.5">{row?.confidenceWarning ? <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span> : "—"}</td>
                        </tr>
                      ))}
                    />
                  )}

                  {/* V2 Advanced sections */}
                  <DarkTable
                    title="POP Calibration avancée — V2"
                    headers={["Bucket", "N résolu", "Avg POP", "Win Rate", "Strike touché %", "Drawdown moy %", "LowerBound cassé %", "Support cassé %", "Assignment %", "Warning"]}
                    rows={(calibrationSummary?.v2?.popBucketsV2 ?? []).map((row) => (
                      <DarkCalibV2Row
                        key={`v2-pop-${String(row?.bucket ?? "na")}`}
                        cells={[
                          <span className="font-semibold text-slate-200">{row?.bucket || "—"}</span>,
                          numberOrNull(row?.resolvedCount) ?? 0,
                          <span className="text-sky-400">{formatPercent(row?.avgPop)}</span>,
                          row?.actualWinRate != null ? <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : "text-amber-400"}>{formatPercent(row.actualWinRate)}</span> : "—",
                          formatPercent(row?.strikeTouchRate),
                          formatPercent(row?.avgDrawdownPct),
                          formatPercent(row?.lowerBoundBreakRate),
                          formatPercent(row?.supportBreakRate),
                          formatPercent(row?.assignmentRate),
                          row?.confidenceWarning ? <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span> : "—",
                        ]}
                      />
                    ))}
                  />

                  <DarkTable
                    title="DTE Stress Analysis — V2"
                    headers={["Bucket DTE", "N résolu", "Win Rate", "Strike touché %", "Drawdown moy %", "Assignment %", "LowerBound cassé %", "Warning"]}
                    rows={(calibrationSummary?.v2?.dteBucketsV2 ?? []).map((row) => (
                      <DarkCalibV2Row
                        key={`v2-dte-${String(row?.bucket ?? "na")}`}
                        cells={[
                          <span className="font-semibold text-slate-200">{row?.bucket || "—"}</span>,
                          numberOrNull(row?.resolvedCount) ?? 0,
                          row?.actualWinRate != null ? <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : "text-amber-400"}>{formatPercent(row.actualWinRate)}</span> : "—",
                          formatPercent(row?.strikeTouchRate),
                          formatPercent(row?.avgDrawdownPct),
                          formatPercent(row?.assignmentRate),
                          formatPercent(row?.lowerBoundBreakRate),
                          row?.confidenceWarning ? <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span> : "—",
                        ]}
                      />
                    ))}
                  />

                  <DarkTable
                    title="SAFE vs AGGRESSIVE — V2 avancé"
                    headers={["Mode", "N résolu", "Win Rate", "Strike touché %", "Drawdown moy %", "Assignment %", "Prime moy.", "Prime eff %", "LowerBound %", "Support %", "Warning"]}
                    rows={(calibrationSummary?.v2?.strikeModeV2 ?? [])
                      .filter((row) => row?.bucket !== "unknown" || (row?.resolvedCount ?? 0) > 0)
                      .map((row) => (
                        <DarkCalibV2Row
                          key={`v2-mode-${String(row?.bucket ?? "na")}`}
                          cells={[
                            <span className={row?.bucket === "safe" ? "font-bold text-emerald-400" : row?.bucket === "aggressive" ? "font-bold text-rose-400" : "text-slate-500"}>
                              {row?.bucket || "—"}
                            </span>,
                            numberOrNull(row?.resolvedCount) ?? 0,
                            row?.actualWinRate != null ? <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : "text-amber-400"}>{formatPercent(row.actualWinRate)}</span> : "—",
                            formatPercent(row?.strikeTouchRate),
                            formatPercent(row?.avgDrawdownPct),
                            formatPercent(row?.assignmentRate),
                            <span className="text-sky-400">{formatMoney(row?.avgPremium)}</span>,
                            formatPercent(row?.premiumEfficiency),
                            formatPercent(row?.lowerBoundBreakRate),
                            formatPercent(row?.supportBreakRate),
                            row?.confidenceWarning ? <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span> : "—",
                          ]}
                        />
                      ))}
                  />

                  {(calibrationSummary?.v2?.hasFtqsV2Data ?? false) && (
                    <DarkTable
                      title="FTQS réel — V2"
                      headers={["Bucket FTQS", "N résolu", "Win Rate", "Strike touché %", "Drawdown moy %", "Support cassé %", "LowerBound cassé %", "Warning"]}
                      rows={(calibrationSummary?.v2?.ftqsBucketsV2 ?? []).map((row) => (
                        <DarkCalibV2Row
                          key={`v2-ftqs-${String(row?.bucket ?? "na")}`}
                          cells={[
                            <span className="font-semibold text-slate-200">{row?.bucket || "—"}</span>,
                            numberOrNull(row?.resolvedCount) ?? 0,
                            row?.actualWinRate != null ? <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : "text-amber-400"}>{formatPercent(row.actualWinRate)}</span> : "—",
                            formatPercent(row?.strikeTouchRate),
                            formatPercent(row?.avgDrawdownPct),
                            formatPercent(row?.supportBreakRate),
                            formatPercent(row?.lowerBoundBreakRate),
                            row?.confidenceWarning ? <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span> : "—",
                          ]}
                        />
                      ))}
                    />
                  )}

                  {(calibrationSummary?.v2?.tickerCohorts ?? []).length > 0 && (
                    <DarkTable
                      title="Top tickers calibrés — V2"
                      headers={["Ticker", "N résolu", "Avg POP", "Win Rate", "Strike touché %", "Drawdown moy %", "Assignment %", "Support %", "LowerBound %", "Warning"]}
                      rows={(calibrationSummary?.v2?.tickerCohorts ?? []).map((row) => (
                        <DarkCalibV2Row
                          key={`v2-ticker-${String(row?.ticker ?? "na")}`}
                          cells={[
                            <span className="font-bold text-slate-100">{row?.ticker || "—"}</span>,
                            numberOrNull(row?.resolvedCount) ?? 0,
                            <span className="text-sky-400">{formatPercent(row?.avgPop)}</span>,
                            row?.actualWinRate != null ? <span className={row.actualWinRate >= 80 ? "text-emerald-400 font-semibold" : "text-amber-400"}>{formatPercent(row.actualWinRate)}</span> : "—",
                            formatPercent(row?.strikeTouchRate),
                            formatPercent(row?.avgDrawdownPct),
                            formatPercent(row?.assignmentRate),
                            formatPercent(row?.supportBreakRate),
                            formatPercent(row?.lowerBoundBreakRate),
                            row?.confidenceWarning ? <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span> : "—",
                          ]}
                        />
                      ))}
                    />
                  )}

                  {(calibrationSummary?.v2?.hasSectorData ?? false) && (
                    <DarkTable
                      title="Top secteurs calibrés — V2"
                      headers={["Secteur", "N résolu", "Avg POP", "Win Rate", "Strike touché %", "Drawdown moy %", "Assignment %", "Warning"]}
                      rows={(calibrationSummary?.v2?.sectorCohorts ?? []).map((row) => (
                        <DarkCalibV2Row
                          key={`v2-sector-${String(row?.sector ?? "na")}`}
                          cells={[
                            row?.sector || "—",
                            numberOrNull(row?.resolvedCount) ?? 0,
                            <span className="text-sky-400">{formatPercent(row?.avgPop)}</span>,
                            formatPercent(row?.actualWinRate),
                            formatPercent(row?.strikeTouchRate),
                            formatPercent(row?.avgDrawdownPct),
                            formatPercent(row?.assignmentRate),
                            row?.confidenceWarning ? <span className="rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 text-[10px] text-amber-400">{row.confidenceWarning}</span> : "—",
                          ]}
                        />
                      ))}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Seasonality V1 — read-only ──────────────────────────────────────── */}
      {hasLoaded && (
        <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-[11px] font-bold uppercase tracking-[0.15em] text-slate-400">Saisonnalité V1 — Lecture seule</h3>
              <p className="mt-1 text-[11px] text-slate-600">
                Fenêtres saisonnières historiques (Yahoo, cache 6h). Aucun impact scanner, EliteScore, ranking.
              </p>
            </div>
            <button
              type="button"
              onClick={fetchJournalSeasonality}
              disabled={seasonalityLoading || !hasLoaded || !uniqueJournalSymbols.length}
              className="inline-flex items-center justify-center rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Charger saisonnalité
              <RefreshCw className={`ml-2 h-4 w-4 ${seasonalityLoading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {!hasLoaded && (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              Chargez d&apos;abord le journal.
            </div>
          )}
          {hasLoaded && !journalSeasonality && !seasonalityLoading && (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              {uniqueJournalSymbols.length > 0
                ? `${uniqueJournalSymbols.length} tickers détectés — cliquez sur "Charger saisonnalité".`
                : "Aucun ticker dans le journal."}
            </div>
          )}
          {seasonalityLoading && (
            <div className="rounded-2xl border border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              Calcul en cours — Yahoo Finance historique, résultat mis en cache 6h…
            </div>
          )}
          {journalSeasonality && !seasonalityLoading && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs text-slate-300">
                <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3 font-semibold">Ticker</th>
                    <th className="px-3 py-3 font-semibold">Biais actuel</th>
                    <th className="px-3 py-3 font-semibold">Score</th>
                    <th className="px-3 py-3 font-semibold">Risque strike</th>
                    <th className="px-3 py-3 font-semibold">Fenêtre active</th>
                    <th className="px-3 py-3 font-semibold">Win rate</th>
                    <th className="px-3 py-3 font-semibold">Données</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {(journalSeasonality.symbols ?? []).map((sym) => {
                    const d = journalSeasonality.results?.[sym];
                    return (
                      <tr key={`seas-${sym}`} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-3 py-2.5 font-bold text-slate-100">{sym}</td>
                        <td className="px-3 py-2.5">
                          {d?.seasonalBias ? (
                            <span className={d.seasonalBias === "favorable" ? "font-medium text-emerald-400" : d.seasonalBias === "unfavorable" ? "font-medium text-rose-400" : "text-slate-500"}>
                              {d.seasonalBias === "favorable" ? "↑ Favorable" : d.seasonalBias === "unfavorable" ? "↓ Défavorable" : "→ Neutre"}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {d?.seasonalityScore != null ? (
                            <span className={d.seasonalityScore >= 0.25 ? "text-emerald-400" : d.seasonalityScore <= -0.25 ? "text-rose-400" : "text-slate-500"}>
                              {d.seasonalityScore >= 0 ? "+" : ""}{Math.round(d.seasonalityScore * 100)}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {d?.seasonalStrikeRisk ? (
                            <span className={d.seasonalStrikeRisk === "high" ? "font-medium text-rose-400" : d.seasonalStrikeRisk === "low" ? "font-medium text-emerald-400" : "text-amber-400"}>
                              {d.seasonalStrikeRisk === "high" ? "Élevé" : d.seasonalStrikeRisk === "low" ? "Faible" : "Moyen"}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-slate-500">
                          {d?.activeWindowNow
                            ? `S${d.activeWindowNow.windowStart}–S${d.activeWindowNow.windowEnd} · ${d.activeWindowNow.windowSizeWeeks}sem · ${d.activeWindowNow.bias}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {d?.activeWindowNow?.winRate != null ? `${Math.round(d.activeWindowNow.winRate * 100)}%` : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {d?.dataPointCount != null ? `${d.dataPointCount} j` : "n/a"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-[10px] text-slate-600">
                V1 — lecture seule · aucun impact scanner · calibration saisonnière automatique prévue V2 ·
                généré {journalSeasonality.generatedAt ? new Date(journalSeasonality.generatedAt).toLocaleTimeString() : "—"}
              </p>
            </div>
          )}
        </section>
      )}

      {/* ── Raw journal tables ──────────────────────────────────────────────── */}
      {hasLoaded && (
        <>
          <DarkJournalTable title="À résoudre" rows={unresolvedRecords} />
          <DarkJournalTable title="Résolus" rows={resolvedRecords} showOutcomeV2 />
        </>
      )}
    </div>
  );
}
