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

function CollapsibleSection({ title, badge, subtitle, defaultOpen = false, summaryRight, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-[28px] border border-slate-700/50 bg-slate-900 p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-4 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">{title}</h3>
            {badge && (
              <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
                {badge}
              </span>
            )}
          </div>
          {subtitle && <p className="mt-1 text-[11px] text-slate-600">{subtitle}</p>}
          {!open && summaryRight && (
            <p className="mt-1.5 text-[11px] text-slate-500">{summaryRight}</p>
          )}
        </div>
        <span className="flex-shrink-0 text-[10px] text-slate-500 pt-0.5">{open ? "Masquer ▼" : "Afficher ▶"}</span>
      </button>
      {open && <div className="mt-5">{children}</div>}
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

// ── Ticker verdict helper V2C ───────────────────────────────────────────────

const SPECULATIVE_TICKERS = new Set([
  "RIOT", "CIFR", "WULF", "MARA", "CLSK", "APLD", "OKLO", "IONQ",
  "SOUN", "RGTI", "IREN", "BITF", "HUT", "BMNR",
]);

// V2C rules: stress metrics gate verdicts. luckyWinRate/lbr/assignmentRate
// trigger automatic downgrade regardless of win rate.
function tickerVerdict(ticker, resolvedCount, winRate, avgPremium, stressStats) {
  const rc  = numberOrNull(resolvedCount) ?? 0;
  const pr  = numberOrNull(avgPremium) ?? 0;
  const isSpec = SPECULATIVE_TICKERS.has(String(ticker ?? "").toUpperCase().trim());

  const lwr = numberOrNull(stressStats?.luckyWinRate) ?? 0;
  const lbr = numberOrNull(stressStats?.lowerBoundBreakRate) ?? 0;
  const ar  = numberOrNull(stressStats?.assignmentRate) ?? 0;
  const cwr = numberOrNull(stressStats?.cleanWinRate) ?? 0;
  const hasStress = stressStats?.resolvedCount >= 10;
  const downgraded = hasStress && (lwr >= 25 || lbr >= 25 || ar > 5);

  if (rc < 10) return { label: "Données insuff.", cls: "text-slate-600" };

  if (rc < 30) {
    if (isSpec || pr > 1.2) return { label: "Spéculatif", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
    return { label: "Préliminaire", cls: "rounded bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-slate-400" };
  }

  // rc >= 30 — stress gates active
  if (pr > 1.2 && (lwr >= 20 || !hasStress)) return { label: "Premium trap potentiel", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };

  if (downgraded) {
    if (lwr >= 30 || lbr >= 30 || ar > 5) return { label: "À éviter / à limiter", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
    return { label: "Agressif stressé", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
  }

  if (isSpec) {
    if (hasStress && cwr >= 60 && lwr < 20) return { label: "Agressif sain", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
    return { label: "Spéculatif", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
  }

  if (hasStress && cwr >= 70 && lwr < 15 && pr <= 0.8) return { label: "Core", cls: "rounded bg-emerald-900/40 border border-emerald-800/50 px-1.5 py-0.5 font-bold text-emerald-400" };
  if (hasStress && cwr >= 70 && lwr < 15) return { label: "Balanced", cls: "rounded bg-sky-900/40 border border-sky-800/50 px-1.5 py-0.5 font-bold text-sky-400" };
  if (hasStress && cwr >= 60 && lwr < 20) return { label: "Agressif sain", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
  return { label: "Préliminaire", cls: "rounded bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-slate-400" };
}

function TickerVerdictBadge({ ticker, resolvedCount, winRate, avgPremium, stressStats }) {
  const v = tickerVerdict(ticker, resolvedCount, winRate, avgPremium, stressStats);
  return <span className={`text-[10px] ${v.cls}`}>{v.label}</span>;
}

// ── Premium bucket verdict V2C ──────────────────────────────────────────────
// Rules updated: stress metrics gate "Core défensif" and can downgrade buckets.
// 1.25%+ always speculative. Never shows "Core" for buckets ≥ 0.80%.

function premiumBucketVerdict(bucketLabel, count, resolvedCount, winRate, stressStats) {
  const n = numberOrNull(count) ?? 0;
  const r = numberOrNull(resolvedCount) ?? 0;
  const wr = numberOrNull(winRate);

  if (n < 5)      return { label: "Données insuff.", cls: "text-slate-600" };
  if (r < 5)      return { label: "Non résolu", cls: "text-slate-600" };
  if (wr == null) return { label: "—", cls: "text-slate-600" };

  const lbl = String(bucketLabel ?? "");
  const lwr = numberOrNull(stressStats?.luckyWinRate) ?? 0;
  const lbr = numberOrNull(stressStats?.lowerBoundBreakRate) ?? 0;
  const ar  = numberOrNull(stressStats?.assignmentRate) ?? 0;

  if (lbl.startsWith("0.40")) {
    if (r >= 30 && lwr < 20 && lbr < 20) return { label: "Core défensif", cls: "rounded bg-emerald-900/40 border border-emerald-800/50 px-1.5 py-0.5 font-bold text-emerald-400" };
    if (r >= 30 && (lwr >= 20 || lbr >= 20)) return { label: "Balanced stressé / À surveiller", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
    if (r >= 10 && wr >= 80) return { label: "Balanced", cls: "rounded bg-sky-900/40 border border-sky-800/50 px-1.5 py-0.5 font-bold text-sky-400" };
    return { label: "Préliminaire", cls: "rounded bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-slate-400" };
  }

  if (lbl.startsWith("0.60")) {
    if (r >= 30 && lwr < 20) return { label: "Balanced", cls: "rounded bg-sky-900/40 border border-sky-800/50 px-1.5 py-0.5 font-bold text-sky-400" };
    if (r >= 30 && lwr >= 20) return { label: "Balanced stressé / À surveiller", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
    if (r >= 10 && wr >= 75) return { label: "Balanced", cls: "rounded bg-sky-900/40 border border-sky-800/50 px-1.5 py-0.5 font-bold text-sky-400" };
    return { label: "À valider", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
  }

  if (lbl.startsWith("0.80")) {
    if (r >= 30 && lwr < 20 && ar <= 2) return { label: "Agressif sain", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
    if (r >= 30 && lwr >= 20) return { label: "Agressif stressé", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
    return { label: "Préliminaire", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
  }

  if (lbl.startsWith("1.00")) {
    if (r < 30) return { label: "Préliminaire — 1% à valider", cls: "rounded bg-amber-900/40 border border-amber-800/50 px-1.5 py-0.5 font-bold text-amber-400" };
    if (lwr >= 20) return { label: "1% stressé — à limiter", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
    return { label: "Opportuniste", cls: "rounded bg-indigo-900/40 border border-indigo-800/50 px-1.5 py-0.5 font-bold text-indigo-400" };
  }

  // 1.25%+ — always speculative, never Core
  if (lwr >= 20 || lbr >= 20) return { label: "Premium trap probable", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
  if (r < 30) return { label: "Préliminaire — risque élevé", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
  return { label: "Spéculatif / premium trap potentiel", cls: "rounded bg-rose-900/40 border border-rose-800/50 px-1.5 py-0.5 font-bold text-rose-400" };
}

function PremiumVerdictBadge({ bucketLabel, count, resolvedCount, winRate, stressStats }) {
  const v = premiumBucketVerdict(bucketLabel, count, resolvedCount, winRate, stressStats);
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

// ── computeStressStats V2C ──────────────────────────────────────────────────
// Pure function — accepts any records slice (bucket / mode / ticker).
// Rates are always computed over resolved wins+assignments only (no losses).

function computeStressStats(records) {
  const wq = computeWinQualityStats(records);
  const resolvedAll = records.filter((r) => r?.resolution?.resolved === true);

  const stKnown = resolvedAll.filter((r) => r?.resolution?.strikeTouched != null);
  const strikeTouchRate = stKnown.length > 0
    ? (stKnown.filter((r) => r.resolution.strikeTouched === true).length / stKnown.length) * 100
    : null;

  const lbKnown = resolvedAll.filter((r) => r?.resolution?.brokeLowerBound != null);
  const lowerBoundBreakRate = lbKnown.length > 0
    ? (lbKnown.filter((r) => r.resolution.brokeLowerBound === true).length / lbKnown.length) * 100
    : null;

  const ddVals = resolvedAll.map((r) => numberOrNull(r?.resolution?.drawdownPct)).filter((v) => v != null);
  const avgDrawdownPct = ddVals.length > 0 ? ddVals.reduce((s, v) => s + v, 0) / ddVals.length : null;

  const rc = wq.resolvedCount;
  let stressVerdict = "N/D";
  if (rc >= 10) {
    const cwr = wq.cleanWinRate ?? 0;
    const lwr = wq.luckyWinRate ?? 0;
    const ar  = wq.assignmentRate ?? 0;
    const lbr = lowerBoundBreakRate ?? 0;
    if (lwr >= 30 || lbr >= 30 || ar > 5) stressVerdict = "Risque fort";
    else if (lwr >= 20 || lbr >= 20)       stressVerdict = "Stress élevé";
    else if (cwr >= 60 && lwr < 20)         stressVerdict = "Correct";
    if (cwr >= 75 && lwr < 10 && ar === 0)  stressVerdict = "Très propre";
  }

  return {
    resolvedCount: rc,
    cleanWinCount: wq.cleanWinCount,
    normalWinCount: wq.normalWinCount,
    stressedWinCount: wq.stressedWinCount,
    luckyWinCount: wq.luckyWinCount,
    assignmentCount: wq.assignmentCount,
    cleanWinRate: wq.cleanWinRate,
    normalWinRate: wq.normalWinRate,
    stressedWinRate: wq.stressedWinRate,
    luckyWinRate: wq.luckyWinRate,
    assignmentRate: wq.assignmentRate,
    strikeTouchRate,
    lowerBoundBreakRate,
    avgDrawdownPct,
    stressVerdict,
  };
}

// ── Ticker mode split V2D-B ─────────────────────────────────────────────────
// Pure function — computes per-mode (safe/aggressive) metrics for a ticker
// and applies the V2D-B recommended-mode rules.

function computeTickerModeSplit(ticker, recordsForTicker) {
  const safeRecs = recordsForTicker.filter((r) => r?.strikeMode === "safe");
  const aggRecs  = recordsForTicker.filter((r) => r?.strikeMode === "aggressive");

  function modeMetrics(recs) {
    const ss = computeStressStats(recs);
    const resolvedRecs = recs.filter((r) => r?.resolution?.resolved === true);
    const wins = resolvedRecs.filter((r) => r?.resolution?.expiredWorthless === true);
    const winRate = resolvedRecs.length > 0 ? (wins.length / resolvedRecs.length) * 100 : null;

    const premVals = resolvedRecs.map((r) => numberOrNull(r?.strike?.premium)).filter((v) => v != null);
    const avgPremium = premVals.length > 0 ? premVals.reduce((s, v) => s + v, 0) / premVals.length : null;

    const popVals = resolvedRecs
      .map((r) => { const n = numberOrNull(r?.strike?.popEstimate); return n == null ? null : n > 1 ? n : n * 100; })
      .filter((v) => v != null);
    const avgPop = popVals.length > 0 ? popVals.reduce((s, v) => s + v, 0) / popVals.length : null;

    return {
      totalCount: recs.length,
      resolvedCount: ss.resolvedCount,
      avgPremium,
      avgPop,
      winRate,
      strikeTouchRate:     ss.strikeTouchRate,
      cleanWinRate:        ss.cleanWinRate,
      luckyWinRate:        ss.luckyWinRate,
      lowerBoundBreakRate: ss.lowerBoundBreakRate,
      assignmentRate:      ss.assignmentRate,
    };
  }

  const safe       = modeMetrics(safeRecs);
  const aggressive = modeMetrics(aggRecs);
  const globalSS   = computeStressStats(recordsForTicker);
  const globalLwr  = globalSS.luckyWinRate ?? 0;
  const globalLbr  = globalSS.lowerBoundBreakRate ?? 0;
  const isSpec     = SPECULATIVE_TICKERS.has(String(ticker ?? "").toUpperCase().trim());

  let recommendedMode;
  let recommendationReason;

  // Rules 1 & 2 — data insufficiency gates
  if (globalSS.resolvedCount < 10 || (safe.resolvedCount < 5 && aggressive.resolvedCount < 5)) {
    recommendedMode      = "Données insuff.";
    recommendationReason = globalSS.resolvedCount < 10 ? "< 10 résolus global" : "< 5 résolus par mode";
  }
  // Rule 6 — global stress downgrade (overrides mode rules)
  else if (globalLwr >= 25 || globalLbr >= 25) {
    recommendedMode      = "Stress élevé";
    recommendationReason = globalLwr >= 25
      ? `Lucky rate global ${globalLwr.toFixed(0)}%`
      : `LB break rate global ${globalLbr.toFixed(0)}%`;
  }
  else {
    // Touch condition: agg touch not significantly worse than safe touch
    const aggTouch  = aggressive.strikeTouchRate;
    const safeTouch = safe.strikeTouchRate;
    const touchOk   = aggTouch == null || safeTouch == null ? true : aggTouch <= safeTouch + 8;

    const aggQualifies =
      aggressive.resolvedCount >= 5 &&
      (aggressive.cleanWinRate  ?? 0)   >= 70 &&
      (aggressive.luckyWinRate  ?? 100) <  20 &&
      touchOk;

    const safeQualifies =
      safe.resolvedCount >= 5 &&
      (safe.cleanWinRate  ?? 0)   >= 70 &&
      (safe.luckyWinRate  ?? 100) <  20;

    const aggLimitTrigger =
      (aggressive.avgPremium      ?? 0) > (safe.avgPremium      ?? 0) * 1.5 &&
      (aggressive.strikeTouchRate ?? 0) > (safe.strikeTouchRate ?? 0) * 1.7;

    const bothSimilar =
      aggQualifies && safeQualifies &&
      Math.abs((aggressive.cleanWinRate ?? 0) - (safe.cleanWinRate ?? 0)) < 10;

    // Rule 7 — speculative cap
    if (isSpec) {
      if (aggQualifies) {
        recommendedMode      = "Aggressive possible";
        recommendationReason = "Spéculatif — max Aggressive possible";
      } else {
        recommendedMode      = "Spéculatif";
        recommendationReason = "Ticker spéculatif — conditions non remplies";
      }
    }
    // Rule 8 — balanced when both modes qualify with similar clean rate
    else if (bothSimilar) {
      recommendedMode      = "Balanced / à accumuler";
      recommendationReason = "Safe et Aggressive similaires";
    }
    // Rule 3 — aggressive qualifies
    else if (aggQualifies) {
      recommendedMode      = "Aggressive possible";
      recommendationReason = "Clean rate élevé, stress contenu";
    }
    // Rule 4 — safe qualifies
    else if (safeQualifies) {
      recommendedMode      = "Safe préféré";
      recommendationReason = "Safe propre et stable";
    }
    // Rule 5 — aggressive premium high but stress disproportionate
    else if (aggLimitTrigger) {
      recommendedMode      = "Aggressive à limiter";
      recommendationReason = "Prime agressive mais stress disproportionné";
    }
    else {
      recommendedMode      = "Données insuff.";
      recommendationReason = "Conditions non remplies";
    }
  }

  return { safe, aggressive, recommendedMode, recommendationReason };
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

function computePrimeQualityStats(records) {
  const rows = Array.isArray(records) ? records : [];
  const avg = (vals) => (vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null);

  const bidVals = [];
  const askVals = [];
  const spreadVals = [];
  const spreadPctVals = [];
  const premiumVals = [];
  const efficiencyVals = [];
  const staleFlags = [];
  const earningsFlags = [];
  let spreadCoverageKnown = 0;

  for (const r of rows) {
    const bid = numberOrNull(r?.bid) ?? numberOrNull(r?.optionBid) ?? numberOrNull(r?.strike?.bid);
    const ask = numberOrNull(r?.ask) ?? numberOrNull(r?.optionAsk) ?? numberOrNull(r?.strike?.ask);
    const spread = numberOrNull(r?.spread) ?? numberOrNull(r?.bidAskSpread) ?? (bid != null && ask != null ? ask - bid : null);
    const spreadPct = numberOrNull(r?.spreadPct) ?? numberOrNull(r?.bidAskSpreadPct) ?? (spread != null && ask != null && ask > 0 ? (spread / ask) * 100 : null);
    const premium = numberOrNull(r?.premium) ?? numberOrNull(r?.mid) ?? numberOrNull(r?.strike?.premium);
    const premiumEfficiency = numberOrNull(r?.premiumToSpotPct) ?? numberOrNull(r?.premium_to_spot_pct) ??
      numberOrNull(r?.weeklyYield) ?? numberOrNull(r?.annualizedYield) ?? numberOrNull(r?.returnPct) ?? numberOrNull(r?.premiumYield);

    if (bid != null || ask != null || spread != null || spreadPct != null) spreadCoverageKnown += 1;
    if (bid != null) bidVals.push(bid);
    if (ask != null) askVals.push(ask);
    if (spread != null) spreadVals.push(spread);
    if (spreadPct != null) spreadPctVals.push(spreadPct);
    if (premium != null) premiumVals.push(premium);
    if (premiumEfficiency != null) efficiencyVals.push(premiumEfficiency);

    const staleRaw = r?.staleQuote ?? r?.stale_quote;
    if (typeof staleRaw === "boolean") staleFlags.push(staleRaw);

    const earningsRaw = r?.earningsRisk ?? r?.earningsRiskFlag ?? r?.hasEarnings ?? r?.eventRisk ?? r?.eventRiskFlag;
    if (typeof earningsRaw === "boolean") earningsFlags.push(earningsRaw);
  }

  const spreadCoveragePct = rows.length > 0 && spreadCoverageKnown > 0 ? (spreadCoverageKnown / rows.length) * 100 : null;
  const staleQuoteCount = staleFlags.length > 0 ? staleFlags.filter(Boolean).length : null;
  const staleQuoteRate = staleFlags.length > 0 ? (staleFlags.filter(Boolean).length / staleFlags.length) * 100 : null;
  const earningsRiskCount = earningsFlags.length > 0 ? earningsFlags.filter(Boolean).length : null;
  const earningsRiskRate = earningsFlags.length > 0 ? (earningsFlags.filter(Boolean).length / earningsFlags.length) * 100 : null;

  let qualityVerdict = "Spread N/D";
  const avgSpreadPct = avg(spreadPctVals);
  if (avgSpreadPct != null) {
    if (avgSpreadPct <= 5) qualityVerdict = "Prime propre";
    else if (avgSpreadPct <= 10) qualityVerdict = "Prime correcte";
    else if (avgSpreadPct <= 20) qualityVerdict = "Spread limite";
    else qualityVerdict = "Spread risqué";
  }
  if (staleQuoteRate != null && staleQuoteRate > 20) qualityVerdict = "Qualité quote faible";

  const warnings = [];
  if (earningsRiskRate != null && earningsRiskRate > 0) warnings.push("Earnings risk présent");
  if (avgSpreadPct == null) {
    const avgPremium = avg(premiumVals);
    if (avgPremium != null && avgPremium >= 1) warnings.push("Prime élevée mais liquidité non confirmée");
  }

  return {
    avgBid: avg(bidVals),
    avgAsk: avg(askVals),
    avgSpread: avg(spreadVals),
    avgSpreadPct,
    spreadCoveragePct,
    avgPremium: avg(premiumVals),
    premiumEfficiency: avg(efficiencyVals),
    staleQuoteCount,
    staleQuoteRate,
    earningsRiskCount,
    earningsRiskRate,
    qualityVerdict,
    warnings,
    staleCoverageCount: staleFlags.length,
    earningsCoverageCount: earningsFlags.length,
  };
}

function computeBucketTickerVerdict(resolvedCount, stressStats, avgSpreadPct) {
  const rc = numberOrNull(resolvedCount) ?? 0;
  const clean = numberOrNull(stressStats?.cleanWinRate);
  const lucky = numberOrNull(stressStats?.luckyWinRate);
  const lb = numberOrNull(stressStats?.lowerBoundBreakRate);
  const touch = numberOrNull(stressStats?.strikeTouchRate);
  const spread = numberOrNull(avgSpreadPct);

  if (rc === 0) return "N/D";

  if (rc < 10) {
    if ((lucky != null && lucky >= 50) || (lb != null && lb >= 50) || (touch != null && touch >= 50)) {
      return "Trop jeune / Stress élevé";
    }
    if (spread != null && spread > 20) return "Trop jeune / Spread risqué";
    return "Trop jeune";
  }

  if ((lucky != null && lucky >= 30) || (lb != null && lb >= 30) || (touch != null && touch >= 30)) return "Stressé";
  if (
    clean != null && lucky != null && lb != null && touch != null &&
    clean >= 70 && lucky <= 15 && lb <= 15 && touch <= 15
  ) return "Propre";
  return "À surveiller";
}

function computeBucketTickerBreakdown(records) {
  const rows = Array.isArray(records) ? records : [];
  const defs = [
    { label: "0.40–0.60 %", min: 0.40, max: 0.60 },
    { label: "0.60–0.80 %", min: 0.60, max: 0.80 },
    { label: "0.80–1.00 %", min: 0.80, max: 1.00 },
    { label: "1.00–1.25 %", min: 1.00, max: 1.25 },
    { label: "1.25 % +", min: 1.25, max: Infinity },
  ];

  const getPremiumToSpotPct = (r) => {
    const pct = numberOrNull(r?.snapshot?.premium_to_spot_pct);
    if (pct != null) return pct;
    const premium = numberOrNull(r?.strike?.premium);
    const spot = numberOrNull(r?.underlying?.spotAtScan);
    if (premium == null || spot == null || spot <= 0) return null;
    return (premium / spot) * 100;
  };

  const avg = (vals) => (vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null);

  return defs.map((def) => {
    const bucketRows = rows.filter((r) => {
      const pct = getPremiumToSpotPct(r);
      if (pct == null) return false;
      return pct >= def.min && (def.max === Infinity ? true : pct < def.max);
    });

    const byTicker = new Map();
    for (const r of bucketRows) {
      const ticker = String(r?.symbol ?? "").trim().toUpperCase();
      if (!ticker) continue;
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker).push(r);
    }

    const tickers = Array.from(byTicker.entries()).map(([ticker, tickerRecs]) => {
      const resolved = tickerRecs.filter((r) => r?.resolution?.resolved === true);
      const wins = resolved.filter((r) => r?.resolution?.expiredWorthless === true);
      const winRate = resolved.length > 0 ? (wins.length / resolved.length) * 100 : null;
      const modeKnown = tickerRecs.filter((r) => r?.strikeMode === "safe" || r?.strikeMode === "aggressive");
      const safeCount = modeKnown.length > 0 ? modeKnown.filter((r) => r?.strikeMode === "safe").length : null;
      const aggressiveCount = modeKnown.length > 0 ? modeKnown.filter((r) => r?.strikeMode === "aggressive").length : null;
      const premiumVals = resolved.map((r) => numberOrNull(r?.strike?.premium)).filter((v) => v != null);
      const stressStats = computeStressStats(tickerRecs);
      const pq = computePrimeQualityStats(tickerRecs);

      return {
        ticker,
        recordCount: tickerRecs.length,
        resolvedCount: resolved.length,
        safeCount,
        aggressiveCount,
        avgPremium: avg(premiumVals),
        avgSpreadPct: pq.avgSpreadPct,
        winRate,
        cleanWinRate: stressStats?.cleanWinRate ?? null,
        luckyWinRate: stressStats?.luckyWinRate ?? null,
        lowerBoundBreakRate: stressStats?.lowerBoundBreakRate ?? null,
        strikeTouchRate: stressStats?.strikeTouchRate ?? null,
        verdict: computeBucketTickerVerdict(resolved.length, stressStats, pq.avgSpreadPct),
      };
    }).sort((a, b) => {
      const rcGap = (b.resolvedCount ?? 0) - (a.resolvedCount ?? 0);
      if (rcGap !== 0) return rcGap;
      const tcGap = (b.recordCount ?? 0) - (a.recordCount ?? 0);
      if (tcGap !== 0) return tcGap;
      return String(a.ticker).localeCompare(String(b.ticker));
    });

    return {
      label: def.label,
      count: bucketRows.length,
      tickerCount: tickers.length,
      tickers,
    };
  });
}

function firstDefinedText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstDefinedNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n != null) return n;
  }
  return null;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isCapitalModeMap(value) {
  if (!isPlainObject(value)) return false;
  return ["aggressive", "balanced", "conservative", "safe"].some((key) => {
    const row = value?.[key];
    return isPlainObject(row) && (Array.isArray(row?.picks) || Array.isArray(row?.positions));
  });
}

function normalizeCapitalPosition(position, index) {
  const ticker = String(
    position?.ticker ??
    position?.symbol ??
    position?.underlying ??
    position?.asset ??
    "",
  ).trim().toUpperCase();

  return {
    id: firstDefinedText(position?.id, position?.positionId, position?.position_id, `${ticker || "pos"}-${index + 1}`),
    ticker,
    capitalUsed: firstDefinedNumber(
      position?.capitalUsed,
      position?.capital_used,
      position?.capitalRequired,
      position?.capital_required,
      position?.requiredCapital,
      position?.required_capital,
      position?.positionCapital,
      position?.position_capital,
    ),
    allocation: firstDefinedNumber(
      position?.allocation,
      position?.allocationPct,
      position?.allocation_pct,
      position?.weightPct,
      position?.weight_pct,
      position?.capitalPct,
      position?.capital_pct,
    ),
    positionSize: firstDefinedNumber(position?.positionSize, position?.position_size, position?.contracts, position?.qty),
  };
}

function buildNormalizedCapitalCombination(entry, fallbackName) {
  const positionsSource =
    Array.isArray(entry?.picks) ? entry.picks :
    Array.isArray(entry?.positions) ? entry.positions :
    Array.isArray(entry?.capitalCombinationPositions) ? entry.capitalCombinationPositions :
    Array.isArray(entry?.capital_combination_positions) ? entry.capital_combination_positions :
    [];

  const positions = positionsSource
    .map((position, index) => normalizeCapitalPosition(position, index))
    .filter((position) => position?.ticker);

  return {
    id: firstDefinedText(
      entry?.id,
      entry?.combinationId,
      entry?.combination_id,
      entry?.modeId,
      entry?.mode_id,
      fallbackName,
    ) ?? fallbackName,
    name: firstDefinedText(
      entry?.combinationName,
      entry?.combination_name,
      entry?.name,
      entry?.label,
      entry?.modeLabel,
      entry?.mode_label,
      entry?.mode,
      fallbackName,
    ) ?? fallbackName,
    positions,
    capitalUsed: firstDefinedNumber(
      entry?.totalCapital,
      entry?.total_capital,
      entry?.capitalUsed,
      entry?.capital_used,
      entry?.requiredCapital,
      entry?.required_capital,
    ),
    concentrationRisk: firstDefinedNumber(
      entry?.concentrationRiskScore,
      entry?.concentration_risk_score,
      entry?.largestTickerCapitalPct,
      entry?.largest_ticker_capital_pct,
    ),
    avgScore: firstDefinedNumber(
      entry?.avgQualityScore,
      entry?.avg_quality_score,
      entry?.overlayScore,
      entry?.overlay_score,
      entry?.riskAdjustedPopScore,
      entry?.risk_adjusted_pop_score,
    ),
    avgYieldPct: firstDefinedNumber(
      entry?.avgWeeklyReturn,
      entry?.avg_weekly_return,
      entry?.yieldPerPopRisk,
      entry?.yield_per_pop_risk,
    ),
  };
}

function normalizeCapitalCombinationEntries(capitalData) {
  if (capitalData == null) return [];

  if (Array.isArray(capitalData)) {
    return capitalData.flatMap((entry, index) => normalizeCapitalCombinationEntries({
      ...entry,
      __fallbackName: firstDefinedText(entry?.label, entry?.name, entry?.mode, `Combinaison ${index + 1}`),
    }));
  }

  if (!isPlainObject(capitalData)) return [];

  if (Array.isArray(capitalData?.modes)) {
    const baseName = firstDefinedText(capitalData?.label, capitalData?.name, capitalData?.combinationName, capitalData?.snapshotLabel, "Snapshot");
    return capitalData.modes.map((mode, index) => buildNormalizedCapitalCombination(
      {
        ...mode,
        totalCapital: firstDefinedNumber(mode?.totalCapital, mode?.capitalUsed, capitalData?.totalCapital),
      },
      `${baseName} - ${firstDefinedText(mode?.label, mode?.mode, `Mode ${index + 1}`)}`,
    ));
  }

  if (isCapitalModeMap(capitalData)) {
    return Object.entries(capitalData)
      .filter(([, value]) => isPlainObject(value) && (Array.isArray(value?.picks) || Array.isArray(value?.positions)))
      .map(([modeKey, value]) => buildNormalizedCapitalCombination(
        { ...value, mode: modeKey },
        firstDefinedText(value?.label, value?.name, modeKey) ?? modeKey,
      ));
  }

  const nestedCollections = [
    capitalData?.capitalCombinations,
    capitalData?.capitalCombinationSnapshots,
    capitalData?.capitalCombinationModes,
    capitalData?.capitalCombinationData,
    capitalData?.capital_combination_snapshots,
    capitalData?.capital_combination_modes,
    capitalData?.combinations,
    capitalData?.portfolioCombinations,
    capitalData?.journal?.capitalCombinations,
    capitalData?.journal?.capitalCombinationSnapshots,
    capitalData?.journal?.capitalCombinationData,
    capitalData?.journal?.capital_combination_snapshots,
    capitalData?.journal?.combinations,
    capitalData?.journal?.portfolioCombinations,
  ];

  for (const collection of nestedCollections) {
    const normalized = normalizeCapitalCombinationEntries(collection);
    if (normalized.length > 0) return normalized;
  }

  if (Array.isArray(capitalData?.picks) || Array.isArray(capitalData?.positions)) {
    return [buildNormalizedCapitalCombination(
      capitalData,
      firstDefinedText(capitalData?.__fallbackName, capitalData?.label, capitalData?.name, capitalData?.mode, "Combinaison 1") ?? "Combinaison 1",
    )];
  }

  return [];
}

function extractCapitalCombinationData(sources) {
  const roots = Array.isArray(sources) ? sources : [sources];
  for (const root of roots) {
    if (!root) continue;
    const directCandidates = [
      root,
      root?.journal,
      root?.journal?.meta,
      root?.journal?.summary,
      root?.calibration,
      root?.summary,
    ];
    for (const candidate of directCandidates) {
      const normalized = normalizeCapitalCombinationEntries(candidate);
      if (normalized.length > 0) return candidate;
    }
  }
  return null;
}

function buildCapitalOverlayTickerStats(records) {
  const rows = Array.isArray(records) ? records : [];
  const grouped = new Map();

  for (const record of rows) {
    const ticker = String(record?.symbol ?? "").trim().toUpperCase();
    if (!ticker) continue;
    if (!grouped.has(ticker)) grouped.set(ticker, []);
    grouped.get(ticker).push(record);
  }

  const byTicker = new Map();
  for (const [ticker, tickerRecords] of grouped.entries()) {
    const stressStats = computeStressStats(tickerRecords);
    const primeQuality = computePrimeQualityStats(tickerRecords);
    const resolvedCount = numberOrNull(stressStats?.resolvedCount) ?? 0;
    const cleanWinRate = numberOrNull(stressStats?.cleanWinRate);
    const luckyWinRate = numberOrNull(stressStats?.luckyWinRate);
    const lowerBoundBreakRate = numberOrNull(stressStats?.lowerBoundBreakRate);
    const strikeTouchRate = numberOrNull(stressStats?.strikeTouchRate);
    const avgSpreadPct = numberOrNull(primeQuality?.avgSpreadPct);
    const avgPremium = numberOrNull(primeQuality?.avgPremium);

    byTicker.set(ticker, {
      ticker,
      resolvedCount,
      cleanWinRate,
      luckyWinRate,
      lowerBoundBreakRate,
      strikeTouchRate,
      avgSpreadPct,
      avgPremium,
      isHighRisk:
        (luckyWinRate != null && luckyWinRate >= 25) ||
        (lowerBoundBreakRate != null && lowerBoundBreakRate >= 25) ||
        (strikeTouchRate != null && strikeTouchRate >= 25) ||
        (avgSpreadPct != null && avgSpreadPct > 20),
      isClean:
        cleanWinRate != null &&
        cleanWinRate >= 70 &&
        (luckyWinRate == null || luckyWinRate <= 15) &&
        (lowerBoundBreakRate == null || lowerBoundBreakRate <= 15) &&
        (strikeTouchRate == null || strikeTouchRate <= 15) &&
        (avgSpreadPct == null || avgSpreadPct <= 10),
    });
  }

  return byTicker;
}

function computeCapitalOverlayScore(metrics) {
  const unknownRatio = metrics.tickerCount > 0 ? metrics.unknownTickerCount / metrics.tickerCount : 1;
  const highRiskRatio = metrics.tickerCount > 0 ? metrics.highRiskTickerCount / metrics.tickerCount : 0;
  let score = 100;

  if (metrics.avgCleanRate != null) score -= Math.max(0, 70 - metrics.avgCleanRate) * 0.7;
  if (metrics.avgLuckyRate != null) score -= Math.max(0, metrics.avgLuckyRate - 10) * 1.1;
  if (metrics.avgLowerBoundBreakRate != null) score -= Math.max(0, metrics.avgLowerBoundBreakRate - 10) * 1.0;
  if (metrics.avgStrikeTouchRate != null) score -= Math.max(0, metrics.avgStrikeTouchRate - 12) * 0.9;
  if (metrics.avgSpreadPct != null) score -= Math.max(0, metrics.avgSpreadPct - 8) * 1.2;
  if (metrics.concentrationRiskPct != null) score -= Math.max(0, metrics.concentrationRiskPct - 20) * 0.8;

  score -= unknownRatio * 35;
  score -= highRiskRatio * 22;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function computeCapitalOverlayVerdict(metrics) {
  if (metrics.hasCapitalData !== true) return "Capital data N/D";
  if ((metrics.tickerCount ?? 0) === 0) return "Données insuffisantes";

  const unknownRatio = metrics.tickerCount > 0 ? metrics.unknownTickerCount / metrics.tickerCount : 1;
  const highRiskRatio = metrics.tickerCount > 0 ? metrics.highRiskTickerCount / metrics.tickerCount : 0;

  if (unknownRatio >= 0.5 || (metrics.resolvedSampleTotal ?? 0) < 6) return "Données insuffisantes";

  if (
    highRiskRatio >= 0.5 ||
    (metrics.highRiskTickerCount ?? 0) >= 3 ||
    (metrics.concentrationRiskPct != null && metrics.concentrationRiskPct >= 35) ||
    (metrics.avgSpreadPct != null && metrics.avgSpreadPct > 25)
  ) {
    return "À limiter";
  }

  if (
    (metrics.avgLuckyRate != null && metrics.avgLuckyRate >= 25) ||
    (metrics.avgLowerBoundBreakRate != null && metrics.avgLowerBoundBreakRate >= 25) ||
    (metrics.avgStrikeTouchRate != null && metrics.avgStrikeTouchRate >= 25) ||
    (metrics.avgSpreadPct != null && metrics.avgSpreadPct > 20)
  ) {
    return "Agressif stressé";
  }

  if (
    metrics.avgCleanRate != null &&
    metrics.avgCleanRate >= 70 &&
    (metrics.avgLuckyRate == null || metrics.avgLuckyRate <= 12) &&
    (metrics.avgLowerBoundBreakRate == null || metrics.avgLowerBoundBreakRate <= 12) &&
    (metrics.avgStrikeTouchRate == null || metrics.avgStrikeTouchRate <= 15) &&
    (metrics.concentrationRiskPct == null || metrics.concentrationRiskPct <= 22)
  ) {
    return "Conservateur sain";
  }

  if (
    (metrics.avgYieldPct != null && metrics.avgYieldPct >= 0.8) ||
    (metrics.avgPremium != null && metrics.avgPremium >= 1)
  ) {
    return "Agressif sain";
  }

  return "Équilibre propre";
}

function computeCapitalCombinationOverlay(records, capitalData) {
  const combinations = normalizeCapitalCombinationEntries(capitalData);
  if (combinations.length === 0) {
    return { hasCapitalData: false, rows: [] };
  }

  const tickerStatsMap = buildCapitalOverlayTickerStats(records);

  const rows = combinations.map((combination, index) => {
    const dedupedPositions = [];
    const dedupedMap = new Map();

    for (const position of combination.positions ?? []) {
      if (!position?.ticker) continue;
      const existing = dedupedMap.get(position.ticker);
      if (existing) {
        existing.capitalUsed = firstDefinedNumber(
          (existing.capitalUsed ?? 0) + (position.capitalUsed ?? 0),
          existing.capitalUsed,
          position.capitalUsed,
        );
        existing.positionSize = firstDefinedNumber(
          (existing.positionSize ?? 0) + (position.positionSize ?? 0),
          existing.positionSize,
          position.positionSize,
        );
        continue;
      }
      const copy = { ...position };
      dedupedMap.set(position.ticker, copy);
      dedupedPositions.push(copy);
    }

    const knownTickerStats = [];
    let unknownTickerCount = 0;
    let highRiskTickerCount = 0;
    let cleanTickerCount = 0;

    for (const position of dedupedPositions) {
      const stats = tickerStatsMap.get(position.ticker);
      if (!stats || (stats.resolvedCount ?? 0) === 0) {
        unknownTickerCount += 1;
        continue;
      }
      knownTickerStats.push({ ...stats, capitalUsed: position.capitalUsed });
      if (stats.isHighRisk) highRiskTickerCount += 1;
      if (stats.isClean) cleanTickerCount += 1;
    }

    const capitalFromPositions = dedupedPositions
      .map((position) => numberOrNull(position?.capitalUsed))
      .filter((value) => value != null)
      .reduce((sum, value) => sum + value, 0);

    const totalCapital = firstDefinedNumber(
      combination.capitalUsed,
      capitalFromPositions > 0 ? capitalFromPositions : null,
    );

    const capitalWeightBase = knownTickerStats
      .map((row) => numberOrNull(row?.capitalUsed))
      .filter((value) => value != null && value > 0)
      .reduce((sum, value) => sum + value, 0);

    const weightedAverage = (selector) => {
      let weightedSum = 0;
      let totalWeight = 0;
      for (const stats of knownTickerStats) {
        const value = numberOrNull(selector(stats));
        if (value == null) continue;
        const weight = capitalWeightBase > 0 ? (numberOrNull(stats?.capitalUsed) ?? 0) : 1;
        const normalizedWeight = weight > 0 ? weight : 1;
        weightedSum += value * normalizedWeight;
        totalWeight += normalizedWeight;
      }
      return totalWeight > 0 ? weightedSum / totalWeight : null;
    };

    const largestTickerCapital = dedupedPositions
      .map((position) => numberOrNull(position?.capitalUsed))
      .filter((value) => value != null)
      .reduce((max, value) => Math.max(max, value), 0);

    const concentrationRiskPctRaw = firstDefinedNumber(
      combination.concentrationRisk,
      totalCapital != null && totalCapital > 0 && largestTickerCapital > 0
        ? (largestTickerCapital / totalCapital) * 100
        : null,
    );
    const concentrationRiskPct = concentrationRiskPctRaw != null && concentrationRiskPctRaw <= 1
      ? concentrationRiskPctRaw * 100
      : concentrationRiskPctRaw;

    const row = {
      id: combination.id ?? `combination-${index + 1}`,
      combinationName: combination.name ?? `Combinaison ${index + 1}`,
      tickerCount: dedupedPositions.length,
      resolvedSampleTotal: knownTickerStats.length > 0
        ? knownTickerStats.reduce((sum, stats) => sum + (numberOrNull(stats?.resolvedCount) ?? 0), 0)
        : null,
      avgCleanRate: weightedAverage((stats) => stats.cleanWinRate),
      avgLuckyRate: weightedAverage((stats) => stats.luckyWinRate),
      avgLowerBoundBreakRate: weightedAverage((stats) => stats.lowerBoundBreakRate),
      avgStrikeTouchRate: weightedAverage((stats) => stats.strikeTouchRate),
      avgSpreadPct: weightedAverage((stats) => stats.avgSpreadPct),
      avgPremium: weightedAverage((stats) => stats.avgPremium),
      highRiskTickerCount,
      cleanTickerCount,
      unknownTickerCount,
      concentrationRiskPct,
      capitalUsed: totalCapital,
      avgScore: combination.avgScore ?? null,
      avgYieldPct: combination.avgYieldPct ?? null,
      hasCapitalData: true,
    };

    const overlayScore = computeCapitalOverlayScore(row);
    return {
      ...row,
      overlayScore,
      verdict: computeCapitalOverlayVerdict({ ...row, overlayScore }),
    };
  });

  return { hasCapitalData: true, rows };
}

export default function JournalPopPanel({ apiBase, active }) {
  const [journal, setJournal] = useState(null);
  const [calibrationSummary, setCalibrationSummary] = useState(null);
  const [cohortSummary, setCohortSummary] = useState([]);
  const [capitalData, setCapitalData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [resolveSummary, setResolveSummary] = useState(null);
  const [showRawSections, setShowRawSections] = useState(false);
  const [bucketTickerVisibleCounts, setBucketTickerVisibleCounts] = useState({});
  const [openBucketsDetail, setOpenBucketsDetail] = useState(false);
  const [openBuckets, setOpenBuckets] = useState({});

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
      const [journalResponse, cohortResponse, calibrationResponse, capitalResponse] = await Promise.all([
        fetch(`${apiBase}/journal/wheel-validation`),
        fetch(`${apiBase}/journal/wheel-validation/cohort-summary`),
        fetch(`${apiBase}/journal/wheel-validation/calibration-summary`),
        fetch(`${apiBase}/capital-combinations/latest-full`).catch(() => null),
      ]);
      const payload = await journalResponse.json();
      const cohortPayload = await cohortResponse.json();
      const calibrationPayload = await calibrationResponse.json();
      const capitalPayload = capitalResponse ? await capitalResponse.json().catch(() => null) : null;
      if (!journalResponse.ok || payload?.ok !== true) throw new Error(payload?.error || "journal_fetch_failed");
      if (!cohortResponse.ok || cohortPayload?.ok !== true) throw new Error(cohortPayload?.error || "journal_cohort_summary_fetch_failed");
      if (!calibrationResponse.ok || calibrationPayload?.ok !== true) throw new Error(calibrationPayload?.error || "journal_calibration_summary_fetch_failed");
      setJournal(payload.journal ?? { version: "1.0", updatedAt: null, records: [] });
      setCohortSummary(Array.isArray(cohortPayload.summary) ? cohortPayload.summary : []);
      setCalibrationSummary(calibrationPayload.calibration ?? null);
      setCapitalData(extractCapitalCombinationData([payload, cohortPayload, calibrationPayload, capitalPayload]));
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
      const stressStats = computeStressStats(matching);
      return {
        label: def.label,
        count: matching.length,
        resolvedCount: resolved.length,
        winRate,
        avgPop,
        avgPremium,
        safeCount: safe.length,
        aggressiveCount: aggressive.length,
        stressStats,
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

  // ── Mode stress stats V2C ──────────────────────────────────────────────────
  const safeModeStressStats = useMemo(
    () => computeStressStats(records.filter((r) => r?.strikeMode === "safe")),
    [records],
  );
  const aggressiveModeStressStats = useMemo(
    () => computeStressStats(records.filter((r) => r?.strikeMode === "aggressive")),
    [records],
  );

  // ── Ticker leaderboard ─────────────────────────────────────────────────────

  const tickerLeaderboard = useMemo(() => {
    const cohorts = calibrationSummary?.v2?.tickerCohorts ?? [];
    return cohorts.map((row) => {
      const tickerRecs = records.filter((r) => r?.symbol === row.ticker);
      const safeCount = tickerRecs.filter((r) => r?.strikeMode === "safe").length;
      const aggressiveCount = tickerRecs.filter((r) => r?.strikeMode === "aggressive").length;
      const stressStats = computeStressStats(tickerRecs);
      const modeSplit   = computeTickerModeSplit(row.ticker, tickerRecs);
      const primeQuality = computePrimeQualityStats(tickerRecs);
      return { ...row, safeCount, aggressiveCount, stressStats, modeSplit, primeQuality };
    });
  }, [calibrationSummary, records]);

  const primeQualityStats = useMemo(() => computePrimeQualityStats(records), [records]);
  const bucketTickerBreakdown = useMemo(() => computeBucketTickerBreakdown(records), [records]);
  const capitalCombinationOverlay = useMemo(
    () => computeCapitalCombinationOverlay(records, capitalData),
    [records, capitalData],
  );

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
              Journal POP Pro V2D-B · Win Quality + Stress Coverage + 1% Readiness + Stress metrics + Safe/Agg split par ticker · Lecture seule · Aucun impact scanner, IBKR, Yahoo, EliteScore
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
        <CollapsibleSection
          title="Win Quality — Qualité réelle des victoires"
          badge="V2A"
          subtitle="Classification des victoires selon les métriques de stress disponibles. Basé sur les records résolus uniquement."
          defaultOpen={false}
          summaryRight={
            winQualityStats.resolvedCount > 0
              ? `Clean ${winQualityStats.cleanWinRate != null ? winQualityStats.cleanWinRate.toFixed(1) + "%" : "N/D"} · Lucky ${winQualityStats.luckyWinRate != null ? winQualityStats.luckyWinRate.toFixed(1) + "%" : "N/D"} · Assignments ${winQualityStats.assignmentRate != null ? winQualityStats.assignmentRate.toFixed(1) + "%" : "N/D"}`
              : "Aucun record résolu"
          }
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
        </CollapsibleSection>
      )}

      {/* ── SECTION V2B — 1% READINESS ──────────────────────────────────────── */}
      {hasLoaded && (
        <CollapsibleSection
          title="1% Readiness — Capacité statistique à viser 1% / semaine"
          badge="V2B"
          subtitle="Score calculé sur les données résolues actuelles. Indicatif uniquement — aucun impact scanner, IBKR, EliteScore."
          defaultOpen={true}
          summaryRight={
            stats.resolvedCount > 0
              ? `Score ${readiness.score}/100 · ${readiness.verdict} · ${readiness.targetBand}`
              : "Aucun record résolu"
          }
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
        </CollapsibleSection>
      )}

      {/* ── SECTION B — OBJECTIF 1 % / SEMAINE ─────────────────────────────── */}
      {hasLoaded && (
        <CollapsibleSection
          title="Objectif 1 % / Semaine — Buckets de rendement prime"
          badge="Premium / Spot"
          subtitle="Distribution des records par rendement de prime (premium / cours sous-jacent au scan). Cible : 1.00–1.25 %."
          defaultOpen={false}
          summaryRight={(() => {
            const b1 = premiumReturnBuckets.find((b) => b.label.startsWith("1.00"));
            const best = [...premiumReturnBuckets].sort((a, b) => (b.resolvedCount ?? 0) - (a.resolvedCount ?? 0))[0];
            return `Meilleur bucket : ${best ? best.label : "N/D"} · Bucket 1% n=${b1?.resolvedCount ?? 0} · ${readiness.verdict}`;
          })()}
        >
          <p className="mb-4 text-[10px] text-slate-600 italic">
            V2C : verdicts tenant compte de la qualité réelle des victoires (clean/lucky/LB break) — "Core défensif" exige n≥30 + stress faible · 1.25%+ toujours spéculatif.
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-slate-300">
              <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-3 py-3 font-semibold text-left whitespace-nowrap">Bucket</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Records</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Résolus</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Win rate</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">POP moy.</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Prime moy.</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Safe</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Agressif</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Clean</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Stress</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Lucky</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">LB break</th>
                  <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Assign</th>
                  <th className="px-3 py-3 font-semibold whitespace-nowrap">Confiance</th>
                  <th className="px-3 py-3 font-semibold whitespace-nowrap">Verdict</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {premiumReturnBuckets.map((b) => {
                  const ss = b.stressStats;
                  return (
                    <tr key={b.label} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-3 py-3 font-bold text-slate-100 whitespace-nowrap">{b.label}</td>
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
                      <td className="px-3 py-3 text-right tabular-nums">
                        {ss?.cleanWinRate != null ? <span className="text-emerald-400">{ss.cleanWinRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {ss?.stressedWinRate != null ? <span className="text-amber-400">{ss.stressedWinRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {ss?.luckyWinRate != null ? (
                          <span className={ss.luckyWinRate >= 20 ? "text-rose-400 font-semibold" : ss.luckyWinRate >= 10 ? "text-amber-400" : "text-slate-400"}>
                            {ss.luckyWinRate.toFixed(0)}%
                          </span>
                        ) : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {ss?.lowerBoundBreakRate != null ? (
                          <span className={ss.lowerBoundBreakRate >= 20 ? "text-rose-400 font-semibold" : ss.lowerBoundBreakRate >= 10 ? "text-amber-400" : "text-slate-400"}>
                            {ss.lowerBoundBreakRate.toFixed(0)}%
                          </span>
                        ) : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {ss?.assignmentRate != null ? (
                          <span className={ss.assignmentRate > 5 ? "text-rose-400 font-semibold" : ss.assignmentRate > 0 ? "text-amber-400" : "text-slate-400"}>
                            {ss.assignmentRate.toFixed(0)}%
                          </span>
                        ) : <span className="text-slate-600">N/D</span>}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap"><ConfidenceBadge sample={b.resolvedCount} /></td>
                      <td className="px-3 py-3 whitespace-nowrap"><PremiumVerdictBadge bucketLabel={b.label} count={b.count} resolvedCount={b.resolvedCount} winRate={b.winRate} stressStats={ss} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-slate-600">
            V2C : les verdicts tiennent maintenant compte de la qualité des victoires et du stress réel, pas seulement du win rate. · Confiance : n&lt;10 faible · 10–29 préliminaire · 30–99 utilisable · 100+ robuste.
          </p>

          <div className="mt-6 space-y-4">
            <button
              type="button"
              onClick={() => setOpenBucketsDetail((v) => !v)}
              className="flex w-full items-center justify-between gap-3 text-left rounded-xl border border-slate-700/50 bg-slate-800/20 px-4 py-3"
            >
              <div>
                <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
                  Détail des buckets par ticker
                </h4>
                <p className="mt-1 text-[11px] text-slate-600">
                  Montre quels tickers composent chaque bucket de rendement et lesquels créent le stress.
                </p>
              </div>
              <span className="flex-shrink-0 text-[10px] text-slate-500">{openBucketsDetail ? "Masquer ▼" : "Afficher ▶"}</span>
            </button>

            {openBucketsDetail && bucketTickerBreakdown.map((bucket) => {
              const defaultVisible = 20;
              const visibleLimit = numberOrNull(bucketTickerVisibleCounts?.[bucket.label]) ?? defaultVisible;
              const shownCount = Math.min(visibleLimit, bucket.tickers.length);
              const displayedTickers = bucket.tickers.slice(0, shownCount);
              const isBucketOpen = openBuckets[bucket.label] ?? false;
              const totalResolved = bucket.tickers.reduce((sum, t) => sum + (t.resolvedCount ?? 0), 0);
              const matchingB = premiumReturnBuckets.find((b) => b.label === bucket.label);
              const bucketVerdict = matchingB
                ? premiumBucketVerdict(bucket.label, matchingB.count, matchingB.resolvedCount, matchingB.winRate, matchingB.stressStats)
                : null;
              return (
                <div key={`bucket-ticker-${bucket.label}`} className="rounded-2xl border border-slate-700/50 bg-slate-800/20">
                  <button
                    type="button"
                    onClick={() => setOpenBuckets((prev) => ({ ...prev, [bucket.label]: !prev[bucket.label] }))}
                    className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
                  >
                    <p className="flex-1 text-xs font-semibold text-slate-200">
                      {bucket.label}
                      <span className="font-normal text-slate-500">
                        {" — "}{bucket.tickerCount} ticker{bucket.tickerCount !== 1 ? "s" : ""} · {bucket.count} record{bucket.count !== 1 ? "s" : ""}
                        {totalResolved > 0 ? ` · ${totalResolved} résolus` : ""}
                        {!isBucketOpen && bucketVerdict ? ` · ${bucketVerdict.label}` : ""}
                      </span>
                    </p>
                    <span className="flex-shrink-0 text-[10px] text-slate-500 pt-0.5">{isBucketOpen ? "Masquer ▼" : "Afficher ▶"}</span>
                  </button>

                  {isBucketOpen && (
                    <div className="px-4 pb-4">
                      <p className="mb-3 text-[11px] text-slate-600">
                        Affiche {shownCount} / {bucket.tickers.length} tickers — triés par records résolus puis records totaux.
                      </p>

                      {bucket.tickers.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 px-3 py-2 text-[11px] text-slate-600">
                      Aucun ticker dans ce bucket.
                    </div>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-xs text-slate-300">
                          <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                            <tr>
                              <th className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">Ticker</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Records</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Résolus</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Safe</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Agg</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Prime moy.</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Spread %</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Win</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Clean</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Lucky</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">LB Break</th>
                              <th className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">Touch</th>
                              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Verdict</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/70">
                            {displayedTickers.map((row) => (
                              <tr key={`${bucket.label}-${row.ticker}`} className="hover:bg-slate-800/30 transition-colors">
                                <td className="px-3 py-2.5 font-bold text-slate-100 whitespace-nowrap">{row.ticker}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.recordCount}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.resolvedCount}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.safeCount != null ? row.safeCount : <span className="text-slate-600">N/D</span>}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.aggressiveCount != null ? row.aggressiveCount : <span className="text-slate-600">N/D</span>}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-sky-400">{row.avgPremium != null ? formatMoney(row.avgPremium) : <span className="text-slate-600">N/D</span>}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">
                                  {row.avgSpreadPct != null ? (
                                    <span className={row.avgSpreadPct <= 10 ? "text-emerald-400" : row.avgSpreadPct <= 20 ? "text-amber-400" : "text-rose-400"}>
                                      {row.avgSpreadPct.toFixed(1)}%
                                    </span>
                                  ) : <span className="text-slate-600">N/D</span>}
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums">
                                  {row.winRate != null ? (
                                    <span className={row.winRate >= 80 ? "text-emerald-400" : row.winRate >= 60 ? "text-amber-400" : "text-rose-400"}>
                                      {row.winRate.toFixed(0)}%
                                    </span>
                                  ) : <span className="text-slate-600">N/D</span>}
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.cleanWinRate != null ? <span className="text-emerald-400">{row.cleanWinRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.luckyWinRate != null ? <span className={row.luckyWinRate >= 20 ? "text-rose-400 font-semibold" : "text-amber-400"}>{row.luckyWinRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.lowerBoundBreakRate != null ? <span className={row.lowerBoundBreakRate >= 20 ? "text-rose-400 font-semibold" : "text-amber-400"}>{row.lowerBoundBreakRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{row.strikeTouchRate != null ? <span className={row.strikeTouchRate >= 25 ? "text-rose-400 font-semibold" : row.strikeTouchRate >= 10 ? "text-amber-400" : "text-emerald-400"}>{row.strikeTouchRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}</td>
                                <td className="px-3 py-2.5 whitespace-nowrap">
                                  <span className={
                                    row.verdict === "Propre" ? "text-emerald-400" :
                                    row.verdict === "À surveiller" ? "text-amber-400" :
                                    row.verdict === "Stressé" || row.verdict === "Trop jeune / Stress élevé" || row.verdict === "Trop jeune / Spread risqué" ? "text-rose-400 font-semibold" :
                                    row.verdict === "Trop jeune" ? "text-sky-400" :
                                    "text-slate-600"
                                  }>
                                    {row.verdict}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {bucket.tickers.length > defaultVisible && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {shownCount < bucket.tickers.length && (
                            <button
                              type="button"
                              onClick={() => setBucketTickerVisibleCounts((prev) => ({
                                ...prev,
                                [bucket.label]: (numberOrNull(prev?.[bucket.label]) ?? defaultVisible) + 20,
                              }))}
                              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-slate-700"
                            >
                              Afficher 20 de plus
                            </button>
                          )}
                          {shownCount > defaultVisible && (
                            <button
                              type="button"
                              onClick={() => setBucketTickerVisibleCounts((prev) => ({ ...prev, [bucket.label]: defaultVisible }))}
                              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-[11px] font-medium text-slate-300 transition hover:bg-slate-700"
                            >
                              Réduire à 20
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}

      {/* ── SECTION C — SAFE vs AGGRESSIVE ─────────────────────────────────── */}
      {hasLoaded && (
        <CollapsibleSection
          title="Capital Combination Risk Overlay"
          badge="V2E"
          subtitle="Croise les combinaisons de capital avec les résultats réels du Journal POP. Read-only : aucun impact scanner ou SQLite."
          defaultOpen={false}
          summaryRight={
            capitalCombinationOverlay.hasCapitalData
              ? `${capitalCombinationOverlay.rows.length} mode${capitalCombinationOverlay.rows.length !== 1 ? "s" : ""} · ${capitalCombinationOverlay.rows[0]?.verdict ?? "voir détail"}`
              : "Capital data N/D"
          }
        >
          {capitalCombinationOverlay.hasCapitalData !== true ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-slate-700/50 bg-slate-800/20 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-slate-100">Capital data N/D</p>
                  <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-500">
                    Read-only
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  Les tables ou données de combinaisons capital ne sont pas encore exposées dans le payload actuel du Journal POP. V2E est prête côté UI/calcul, mais nécessite un branchement read-only futur.
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {[
                    "Aucun appel backend ajoute",
                    "Aucune ecriture SQLite",
                    "Aucun impact scanner",
                  ].map((line) => (
                    <div key={line} className="rounded-xl border border-slate-700/50 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-400">
                      {line}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-700/50 bg-slate-800/20 p-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
                  Ce que V2E mesurera
                </p>
                <ul className="mt-3 space-y-2 text-sm text-slate-400">
                  <li>concentration sur tickers stressés</li>
                  <li>exposition a lucky / lowerBound break</li>
                  <li>exposition a spread eleve</li>
                  <li>équilibre Safe vs Aggressive</li>
                  <li>robustesse statistique de la combinaison</li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs text-slate-300">
                <thead className="border-b border-slate-700/60 text-[10px] uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="px-3 py-3 text-left font-semibold whitespace-nowrap">Combinaison</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Tickers</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Capital</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Resolus</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Clean</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Lucky</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">LB Break</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Touch</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Spread %</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Tickers a risque</th>
                    <th className="px-3 py-3 text-right font-semibold whitespace-nowrap">Inconnus</th>
                    <th className="px-3 py-3 font-semibold whitespace-nowrap">Verdict</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {capitalCombinationOverlay.rows.map((row) => {
                    const verdictClass =
                      row.verdict === "Conservateur sain"
                        ? "border-emerald-800/50 bg-emerald-900/20 text-emerald-400"
                        : row.verdict === "Équilibre propre"
                        ? "border-sky-800/50 bg-sky-900/20 text-sky-400"
                        : row.verdict === "Agressif sain"
                        ? "border-indigo-800/50 bg-indigo-900/20 text-indigo-400"
                        : row.verdict === "Agressif stressé" || row.verdict === "À limiter"
                        ? "border-rose-800/50 bg-rose-900/20 text-rose-400"
                        : "border-slate-700 bg-slate-800 text-slate-400";
                    return (
                      <tr key={row.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="px-3 py-3">
                          <div className="font-bold text-slate-100 whitespace-nowrap">{row.combinationName}</div>
                          <div className="mt-1 text-[11px] text-slate-600">
                            Score {row.overlayScore != null ? row.overlayScore : "N/D"}
                            {row.concentrationRiskPct != null ? ` · concentration ${row.concentrationRiskPct.toFixed(0)}%` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{row.tickerCount}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-sky-400">
                          {row.capitalUsed != null ? formatMoney(row.capitalUsed) : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{row.resolvedSampleTotal != null ? row.resolvedSampleTotal : <span className="text-slate-600">N/D</span>}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.avgCleanRate != null ? <span className="text-emerald-400">{row.avgCleanRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.avgLuckyRate != null ? <span className={row.avgLuckyRate >= 20 ? "text-rose-400 font-semibold" : "text-amber-400"}>{row.avgLuckyRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.avgLowerBoundBreakRate != null ? <span className={row.avgLowerBoundBreakRate >= 20 ? "text-rose-400 font-semibold" : "text-amber-400"}>{row.avgLowerBoundBreakRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.avgStrikeTouchRate != null ? <span className={row.avgStrikeTouchRate >= 25 ? "text-rose-400 font-semibold" : row.avgStrikeTouchRate >= 10 ? "text-amber-400" : "text-emerald-400"}>{row.avgStrikeTouchRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.avgSpreadPct != null ? <span className={row.avgSpreadPct > 20 ? "text-rose-400 font-semibold" : row.avgSpreadPct > 10 ? "text-amber-400" : "text-emerald-400"}>{row.avgSpreadPct.toFixed(1)}%</span> : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.highRiskTickerCount}
                          <span className="text-slate-600"> / {row.tickerCount}</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {row.unknownTickerCount}
                          <span className="text-slate-600"> / {row.tickerCount}</span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className={`rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${verdictClass}`}>
                            {row.verdict}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleSection>
      )}

      {hasLoaded && (
        <CollapsibleSection
          title="Safe vs Aggressive — Comparaison mode strike"
          badge="V2 calibration"
          subtitle="Données issues de la calibration probabilistique V2. Stress metrics disponibles uniquement pour records avec window data."
          defaultOpen={false}
          summaryRight={
            hasProbabilisticCalibrationData
              ? `Safe n=${safeModeData?.resolvedCount ?? 0} · Agg n=${aggressiveModeData?.resolvedCount ?? 0}`
              : "Aucun record résolu"
          }
        >
          {!hasProbabilisticCalibrationData ? (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-6 text-sm text-slate-600">
              Aucun record résolu — calibration Safe/Aggressive disponible après expiration des premières positions.
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                {/* SAFE */}
                {(() => {
                  const ss = safeModeStressStats;
                  const riskAdj = ss?.luckyWinRate != null && safeModeData?.avgPremium != null
                    ? safeModeData.avgPremium * (1 - ss.luckyWinRate / 100)
                    : null;
                  const modeVerdict = (() => {
                    const rc = ss?.resolvedCount ?? 0;
                    const cwr = ss?.cleanWinRate ?? 0;
                    const lwr = ss?.luckyWinRate ?? 0;
                    if (rc < 30) return { label: "À valider", cls: "border-slate-700 bg-slate-800 text-slate-400" };
                    if (lwr >= 20) return { label: "Défensif stressé", cls: "border-amber-800/50 bg-amber-900/30 text-amber-400" };
                    if (cwr >= 70 && lwr < 15) return { label: "Défensif propre", cls: "border-emerald-800/50 bg-emerald-900/30 text-emerald-400" };
                    return { label: "À valider", cls: "border-slate-700 bg-slate-800 text-slate-400" };
                  })();
                  return (
                    <div className="rounded-2xl border border-emerald-800/30 bg-emerald-900/10 p-5">
                      <div className="flex items-center gap-2 mb-4">
                        <span className="rounded border border-emerald-700/50 bg-emerald-900/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-400">Safe</span>
                        <span className="text-[11px] text-slate-500">Strike défensif · POP haute attendue</span>
                        <span className={`ml-auto rounded border px-1.5 py-0.5 text-[10px] font-bold ${modeVerdict.cls}`}>{modeVerdict.label}</span>
                      </div>
                      <div className="space-y-2 text-xs">
                        {[
                          ["Records résolus", safeModeData?.resolvedCount != null ? String(safeModeData.resolvedCount) : "N/D", "default"],
                          ["Win rate", safeModeData?.actualWinRate != null ? formatPercent(safeModeData.actualWinRate) : "N/D", safeModeData?.actualWinRate >= 80 ? "good" : "default"],
                          ["POP moyenne", safeModeData?.avgPop != null ? formatPercent(safeModeData.avgPop) : "N/D", "info"],
                          ["Prime moyenne", safeModeData?.avgPremium != null ? formatMoney(safeModeData.avgPremium) : "N/D", "default"],
                          ["Assignment rate", safeModeData?.assignmentRate != null ? formatPercent(safeModeData.assignmentRate) : "N/D", "default"],
                          ["Drawdown moyen", safeModeData?.avgDrawdownPct != null ? formatPercent(safeModeData.avgDrawdownPct) : "N/D", "default"],
                          ["LowerBound cassé", safeModeData?.lowerBoundBreakRate != null ? formatPercent(safeModeData.lowerBoundBreakRate) : "N/D", "default"],
                        ].map(([lbl, val, tone]) => (
                          <div key={lbl} className="flex justify-between items-center border-b border-slate-800/60 pb-1.5">
                            <span className="text-slate-500">{lbl}</span>
                            <span className={tone === "good" ? "text-emerald-400 font-semibold" : tone === "info" ? "text-sky-400" : val === "N/D" ? "text-slate-600" : "text-slate-300"}>{val}</span>
                          </div>
                        ))}
                        <div className="flex justify-between items-center rounded-lg border border-emerald-800/40 bg-emerald-900/20 px-2 py-1.5 mt-0.5">
                          <span className="font-semibold text-emerald-400">Strike touch rate</span>
                          <span className="font-bold text-emerald-300">
                            {safeModeData?.strikeTouchRate != null ? formatPercent(safeModeData.strikeTouchRate) : "N/D"}
                          </span>
                        </div>
                        <div className="border-t border-slate-700/40 pt-2 mt-1 space-y-1.5">
                          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">V2C — Qualité des victoires</p>
                          {[
                            ["Clean win %", ss?.cleanWinRate != null ? `${ss.cleanWinRate.toFixed(1)}%` : "N/D", "emerald"],
                            ["Stressed win %", ss?.stressedWinRate != null ? `${ss.stressedWinRate.toFixed(1)}%` : "N/D", "amber"],
                            ["Lucky win %", ss?.luckyWinRate != null ? `${ss.luckyWinRate.toFixed(1)}%` : "N/D", ss?.luckyWinRate >= 20 ? "rose" : "amber"],
                            ["LB break %", ss?.lowerBoundBreakRate != null ? `${ss.lowerBoundBreakRate.toFixed(1)}%` : "N/D", ss?.lowerBoundBreakRate >= 20 ? "rose" : "default"],
                            ["Assignment %", ss?.assignmentRate != null ? `${ss.assignmentRate.toFixed(1)}%` : "N/D", ss?.assignmentRate > 5 ? "rose" : "default"],
                            ["Prime aj. risque", riskAdj != null ? formatMoney(riskAdj) : "N/D", "info"],
                          ].map(([lbl, val, col]) => (
                            <div key={lbl} className="flex justify-between items-center">
                              <span className="text-slate-600">{lbl}</span>
                              <span className={col === "emerald" ? "text-emerald-400" : col === "amber" ? "text-amber-400" : col === "rose" ? "text-rose-400 font-semibold" : col === "info" ? "text-sky-400" : val === "N/D" ? "text-slate-700" : "text-slate-400"}>
                                {val}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 pt-1">
                          <ConfidenceBadge sample={safeModeData?.resolvedCount} />
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* AGGRESSIVE */}
                {(() => {
                  const ss = aggressiveModeStressStats;
                  const riskAdj = ss?.luckyWinRate != null && aggressiveModeData?.avgPremium != null
                    ? aggressiveModeData.avgPremium * (1 - ss.luckyWinRate / 100)
                    : null;
                  const modeVerdict = (() => {
                    const rc = ss?.resolvedCount ?? 0;
                    const cwr = ss?.cleanWinRate ?? 0;
                    const lwr = ss?.luckyWinRate ?? 0;
                    const lbr = ss?.lowerBoundBreakRate ?? 0;
                    const ar  = ss?.assignmentRate ?? 0;
                    if (rc < 30) return { label: "À valider", cls: "border-slate-700 bg-slate-800 text-slate-400" };
                    if (lbr >= 25 || ar > 5) return { label: "À limiter", cls: "border-rose-800/50 bg-rose-900/30 text-rose-400" };
                    if (lwr >= 20) return { label: "Agressif stressé", cls: "border-amber-800/50 bg-amber-900/30 text-amber-400" };
                    if (cwr >= 60 && lwr < 20 && ar <= 2) return { label: "Agressif sain", cls: "border-indigo-800/50 bg-indigo-900/30 text-indigo-400" };
                    return { label: "À valider", cls: "border-slate-700 bg-slate-800 text-slate-400" };
                  })();
                  return (
                    <div className="rounded-2xl border border-rose-800/30 bg-rose-900/10 p-5">
                      <div className="flex items-center gap-2 mb-4">
                        <span className="rounded border border-rose-700/50 bg-rose-900/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-rose-400">Aggressive</span>
                        <span className="text-[11px] text-slate-500">Strike agressif · Prime plus haute</span>
                        <span className={`ml-auto rounded border px-1.5 py-0.5 text-[10px] font-bold ${modeVerdict.cls}`}>{modeVerdict.label}</span>
                      </div>
                      <div className="space-y-2 text-xs">
                        {[
                          ["Records résolus", aggressiveModeData?.resolvedCount != null ? String(aggressiveModeData.resolvedCount) : "N/D", "default"],
                          ["Win rate", aggressiveModeData?.actualWinRate != null ? formatPercent(aggressiveModeData.actualWinRate) : "N/D", aggressiveModeData?.actualWinRate >= 80 ? "good" : "default"],
                          ["POP moyenne", aggressiveModeData?.avgPop != null ? formatPercent(aggressiveModeData.avgPop) : "N/D", "info"],
                          ["Prime moyenne", aggressiveModeData?.avgPremium != null ? formatMoney(aggressiveModeData.avgPremium) : "N/D", "default"],
                          ["Assignment rate", aggressiveModeData?.assignmentRate != null ? formatPercent(aggressiveModeData.assignmentRate) : "N/D", "default"],
                          ["Drawdown moyen", aggressiveModeData?.avgDrawdownPct != null ? formatPercent(aggressiveModeData.avgDrawdownPct) : "N/D", "default"],
                          ["LowerBound cassé", aggressiveModeData?.lowerBoundBreakRate != null ? formatPercent(aggressiveModeData.lowerBoundBreakRate) : "N/D", "default"],
                        ].map(([lbl, val, tone]) => (
                          <div key={lbl} className="flex justify-between items-center border-b border-slate-800/60 pb-1.5">
                            <span className="text-slate-500">{lbl}</span>
                            <span className={tone === "good" ? "text-emerald-400 font-semibold" : tone === "info" ? "text-sky-400" : val === "N/D" ? "text-slate-600" : "text-slate-300"}>{val}</span>
                          </div>
                        ))}
                        <div className="flex justify-between items-center rounded-lg border border-rose-800/40 bg-rose-900/20 px-2 py-1.5 mt-0.5">
                          <span className="font-semibold text-rose-400">Strike touch rate</span>
                          <span className="font-bold text-rose-300">
                            {aggressiveModeData?.strikeTouchRate != null ? formatPercent(aggressiveModeData.strikeTouchRate) : "N/D"}
                          </span>
                        </div>
                        <div className="border-t border-slate-700/40 pt-2 mt-1 space-y-1.5">
                          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">V2C — Qualité des victoires</p>
                          {[
                            ["Clean win %", ss?.cleanWinRate != null ? `${ss.cleanWinRate.toFixed(1)}%` : "N/D", "emerald"],
                            ["Stressed win %", ss?.stressedWinRate != null ? `${ss.stressedWinRate.toFixed(1)}%` : "N/D", "amber"],
                            ["Lucky win %", ss?.luckyWinRate != null ? `${ss.luckyWinRate.toFixed(1)}%` : "N/D", ss?.luckyWinRate >= 20 ? "rose" : "amber"],
                            ["LB break %", ss?.lowerBoundBreakRate != null ? `${ss.lowerBoundBreakRate.toFixed(1)}%` : "N/D", ss?.lowerBoundBreakRate >= 20 ? "rose" : "default"],
                            ["Assignment %", ss?.assignmentRate != null ? `${ss.assignmentRate.toFixed(1)}%` : "N/D", ss?.assignmentRate > 5 ? "rose" : "default"],
                            ["Prime aj. risque", riskAdj != null ? formatMoney(riskAdj) : "N/D", "info"],
                          ].map(([lbl, val, col]) => (
                            <div key={lbl} className="flex justify-between items-center">
                              <span className="text-slate-600">{lbl}</span>
                              <span className={col === "emerald" ? "text-emerald-400" : col === "amber" ? "text-amber-400" : col === "rose" ? "text-rose-400 font-semibold" : col === "info" ? "text-sky-400" : val === "N/D" ? "text-slate-700" : "text-slate-400"}>
                                {val}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 pt-1">
                          <ConfidenceBadge sample={aggressiveModeData?.resolvedCount} />
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {(() => {
                const safeTouch = numberOrNull(safeModeData?.strikeTouchRate);
                const aggTouch = numberOrNull(aggressiveModeData?.strikeTouchRate);
                const gap = safeTouch != null && aggTouch != null ? aggTouch - safeTouch : null;
                const ratio = safeTouch != null && aggTouch != null && safeTouch > 0 ? aggTouch / safeTouch : null;
                return (
                  <div className="mt-4 rounded-2xl border border-slate-600/50 bg-slate-800/50 p-4 space-y-3">
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Différence réelle de risque</p>
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div className="rounded-lg border border-emerald-800/40 bg-emerald-900/20 px-3 py-2.5 text-center">
                        <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-emerald-600 mb-1">Safe</p>
                        <p className="text-xl font-bold text-emerald-300 tabular-nums">
                          {safeTouch != null ? `${safeTouch.toFixed(1)}%` : "N/D"}
                        </p>
                        <p className="text-[9px] text-slate-600 mt-0.5">Strike touch rate</p>
                      </div>
                      <div className="rounded-lg border border-rose-800/40 bg-rose-900/20 px-3 py-2.5 text-center">
                        <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-rose-600 mb-1">Aggressive</p>
                        <p className="text-xl font-bold text-rose-300 tabular-nums">
                          {aggTouch != null ? `${aggTouch.toFixed(1)}%` : "N/D"}
                        </p>
                        <p className="text-[9px] text-slate-600 mt-0.5">Strike touch rate</p>
                      </div>
                      <div className="rounded-lg border border-amber-800/40 bg-amber-900/20 px-3 py-2.5 text-center">
                        <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-amber-600 mb-1">Écart</p>
                        <p className="text-xl font-bold text-amber-300 tabular-nums">
                          {gap != null ? (gap >= 0 ? `+${gap.toFixed(1)} pts` : `${gap.toFixed(1)} pts`) : "N/D"}
                        </p>
                        <p className="text-[9px] text-slate-600 mt-0.5">Aggressive vs Safe</p>
                      </div>
                    </div>
                    {ratio != null && (
                      <p className="text-[11px] text-slate-500 text-center">
                        Aggressive touche le strike environ{" "}
                        <span className="text-amber-400 font-semibold">{ratio.toFixed(1)}×</span>{" "}
                        plus souvent que Safe.
                      </p>
                    )}
                    {safeTouch == null && aggTouch == null && (
                      <p className="text-[11px] text-slate-600 text-center">Strike touch rate indisponible — données insuffisantes.</p>
                    )}
                  </div>
                );
              })()}
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-slate-700/40 bg-slate-800/30 px-4 py-3">
                <span className="text-slate-600 text-sm">ℹ</span>
                <p className="text-[11px] text-slate-600">
                  V2C : les verdicts tiennent maintenant compte de la qualité des victoires et du stress réel, pas seulement du win rate. Safe et Aggressive peuvent avoir le même win rate — V2C montre lequel est plus propre.
                  <span className="block mt-1.5">Lucky win % et LowerBound break % sont basés sur le comportement du sous-jacent — ils peuvent être identiques entre Safe et Aggressive. Le <span className="text-slate-400 font-medium">strike touch rate</span> reste la métrique la plus discriminante entre modes.</span>
                </p>
              </div>
            </>
          )}
        </CollapsibleSection>
      )}

      {/* ── SECTION D — TICKER LEADERBOARD ─────────────────────────────────── */}
      {hasLoaded && (
        <CollapsibleSection
          title="Ticker Leaderboard — Calibration par actif"
          badge="V2D-B"
          subtitle="Tickers avec au moins 3 records résolus. Split Safe / Aggressive par ticker — prime, touch rate, clean rate et mode recommandé."
          defaultOpen={false}
          summaryRight={
            tickerLeaderboard.length > 0
              ? `${tickerLeaderboard.length} ticker${tickerLeaderboard.length !== 1 ? "s" : ""} · meilleur : ${tickerLeaderboard[0]?.ticker ?? "voir détail"}`
              : "Aucun ticker calibré"
          }
        >
          <p className="mb-4 text-[10px] text-slate-600 italic">
            V2C + V2D-B : stress metrics intégrées · split Safe/Aggressive par ticker · luckyWinRate ≥ 25% / LB break ≥ 25% entraînent downgrade automatique.
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
                    {/* ── Global columns ── */}
                    <th className="px-3 py-3 font-semibold text-left whitespace-nowrap">Ticker</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Résolus</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Win rate</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">POP moy.</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Prime moy.</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Safe total</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Agg total</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Clean</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Lucky</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">LB break</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Assign</th>
                    <th className="px-3 py-3 font-semibold whitespace-nowrap">Confiance</th>
                    <th className="px-3 py-3 font-semibold whitespace-nowrap">Verdict V2C</th>
                    {/* ── V2D-B split columns ── */}
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap border-l border-slate-700/60 text-emerald-600/70">S n</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap text-emerald-600/70">S Prime</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap text-emerald-600/70">S Touch</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap text-emerald-600/70">S Clean</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap text-rose-600/70">A n</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap text-rose-600/70">A Prime</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap text-rose-600/70">A Touch</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap text-rose-600/70">A Clean</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Spread %</th>
                    <th className="px-3 py-3 font-semibold text-right whitespace-nowrap">Earn</th>
                    <th className="px-3 py-3 font-semibold whitespace-nowrap">Prime Q</th>
                    <th className="px-3 py-3 font-semibold whitespace-nowrap">Mode rec.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {tickerLeaderboard.map((row) => {
                    const ss    = row.stressStats;
                    const ms    = row.modeSplit;
                    const sMs   = ms?.safe;
                    const aMs   = ms?.aggressive;
                    const pq    = row.primeQuality;
                    const recMode = ms?.recommendedMode ?? "Données insuff.";
                    const recModeCls =
                      recMode === "Safe préféré"
                        ? "rounded border border-emerald-800/50 bg-emerald-900/30 px-1.5 py-0.5 font-bold text-emerald-400"
                        : recMode === "Aggressive possible"
                        ? "rounded border border-amber-800/50 bg-amber-900/30 px-1.5 py-0.5 font-bold text-amber-400"
                        : recMode === "Aggressive à limiter" || recMode === "Stress élevé"
                        ? "rounded border border-rose-800/50 bg-rose-900/30 px-1.5 py-0.5 font-bold text-rose-400"
                        : recMode === "Spéculatif"
                        ? "rounded border border-amber-800/50 bg-amber-900/30 px-1.5 py-0.5 font-bold text-amber-400"
                        : recMode === "Balanced / à accumuler"
                        ? "rounded border border-sky-800/50 bg-sky-900/30 px-1.5 py-0.5 font-bold text-sky-400"
                        : "text-slate-600";
                    return (
                      <tr key={row.ticker} className="hover:bg-slate-800/30 transition-colors">
                        {/* ── Global cells ── */}
                        <td className="px-3 py-3 font-bold text-slate-100 whitespace-nowrap">{row.ticker}</td>
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
                        <td className="px-3 py-3 text-right tabular-nums">
                          {ss?.cleanWinRate != null ? <span className="text-emerald-400">{ss.cleanWinRate.toFixed(0)}%</span> : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {ss?.luckyWinRate != null ? (
                            <span className={ss.luckyWinRate >= 25 ? "text-rose-400 font-semibold" : ss.luckyWinRate >= 10 ? "text-amber-400" : "text-slate-400"}>
                              {ss.luckyWinRate.toFixed(0)}%
                            </span>
                          ) : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {ss?.lowerBoundBreakRate != null ? (
                            <span className={ss.lowerBoundBreakRate >= 25 ? "text-rose-400 font-semibold" : ss.lowerBoundBreakRate >= 10 ? "text-amber-400" : "text-slate-400"}>
                              {ss.lowerBoundBreakRate.toFixed(0)}%
                            </span>
                          ) : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {ss?.assignmentRate != null ? (
                            <span className={ss.assignmentRate > 5 ? "text-rose-400 font-semibold" : ss.assignmentRate > 0 ? "text-amber-400" : "text-slate-400"}>
                              {ss.assignmentRate.toFixed(0)}%
                            </span>
                          ) : <span className="text-slate-600">N/D</span>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap"><ConfidenceBadge sample={row.resolvedCount} /></td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <TickerVerdictBadge ticker={row.ticker} resolvedCount={row.resolvedCount} winRate={row.actualWinRate} avgPremium={row.avgPremium} stressStats={ss} />
                        </td>
                        {/* ── V2D-B split cells (Safe) ── */}
                        <td className="px-3 py-3 text-right tabular-nums border-l border-slate-700/60">
                          <span className={sMs?.resolvedCount ? "text-emerald-500 font-semibold" : "text-slate-700"}>{sMs?.resolvedCount ?? 0}</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {sMs?.avgPremium != null ? <span className="text-emerald-300">{formatMoney(sMs.avgPremium)}</span> : <span className="text-slate-700">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {sMs?.strikeTouchRate != null ? (
                            <span className={sMs.strikeTouchRate >= 25 ? "text-rose-400" : sMs.strikeTouchRate >= 10 ? "text-amber-400" : "text-emerald-400"}>
                              {sMs.strikeTouchRate.toFixed(0)}%
                            </span>
                          ) : <span className="text-slate-700">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {sMs?.cleanWinRate != null ? (
                            <span className={sMs.cleanWinRate >= 70 ? "text-emerald-400" : sMs.cleanWinRate >= 50 ? "text-amber-400" : "text-rose-400"}>
                              {sMs.cleanWinRate.toFixed(0)}%
                            </span>
                          ) : <span className="text-slate-700">N/D</span>}
                        </td>
                        {/* ── V2D-B split cells (Aggressive) ── */}
                        <td className="px-3 py-3 text-right tabular-nums">
                          <span className={aMs?.resolvedCount ? "text-rose-400 font-semibold" : "text-slate-700"}>{aMs?.resolvedCount ?? 0}</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {aMs?.avgPremium != null ? <span className="text-rose-300">{formatMoney(aMs.avgPremium)}</span> : <span className="text-slate-700">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {aMs?.strikeTouchRate != null ? (
                            <span className={aMs.strikeTouchRate >= 25 ? "text-rose-400 font-semibold" : aMs.strikeTouchRate >= 10 ? "text-amber-400" : "text-emerald-400"}>
                              {aMs.strikeTouchRate.toFixed(0)}%
                            </span>
                          ) : <span className="text-slate-700">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {aMs?.cleanWinRate != null ? (
                            <span className={aMs.cleanWinRate >= 70 ? "text-emerald-400" : aMs.cleanWinRate >= 50 ? "text-amber-400" : "text-rose-400"}>
                              {aMs.cleanWinRate.toFixed(0)}%
                            </span>
                          ) : <span className="text-slate-700">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {pq?.avgSpreadPct != null ? (
                            <span className={pq.avgSpreadPct <= 10 ? "text-emerald-400" : pq.avgSpreadPct <= 20 ? "text-amber-400" : "text-rose-400"}>
                              {pq.avgSpreadPct.toFixed(1)}%
                            </span>
                          ) : <span className="text-slate-700">N/D</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          {pq?.earningsRiskRate != null
                            ? <span className={pq.earningsRiskRate > 0 ? "text-amber-400" : "text-emerald-400"}>{pq.earningsRiskRate.toFixed(0)}%</span>
                            : <span className="text-slate-700">N/D</span>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {pq?.qualityVerdict ? <span className="text-[10px] text-slate-400">{pq.qualityVerdict}</span> : <span className="text-slate-700">N/D</span>}
                        </td>
                        {/* ── Mode recommandé ── */}
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className={`text-[10px] ${recModeCls}`} title={ms?.recommendationReason ?? ""}>{recMode}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-[11px] text-slate-600">
            V2D-B : le leaderboard sépare maintenant Safe et Aggressive par ticker. La prime moyenne globale ne suffit pas à recommander un mode.
          </p>
        </CollapsibleSection>
      )}

      {hasLoaded && (
        <CollapsibleSection
          title="Prime Quality — Spread, liquidité et risque événementiel"
          badge="V2D-C"
          subtitle="V2D-C : vérifie si les primes observées sont réellement tradables. N/D si les champs ne sont pas encore capturés."
          defaultOpen={false}
          summaryRight={`Spread moy. ${primeQualityStats.avgSpreadPct != null ? primeQualityStats.avgSpreadPct.toFixed(1) + "%" : "N/D"} · ${primeQualityStats.qualityVerdict}`}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <ProKpi
              label="Spread coverage"
              value={primeQualityStats.spreadCoveragePct != null ? `${primeQualityStats.spreadCoveragePct.toFixed(0)}%` : null}
              tone={primeQualityStats.spreadCoveragePct != null && primeQualityStats.spreadCoveragePct >= 70 ? "good" : "default"}
              sub={primeQualityStats.spreadCoveragePct != null ? "Records avec bid/ask/spread disponibles" : "Aucun champ spread détecté"}
            />
            <ProKpi
              label="Spread moyen"
              value={primeQualityStats.avgSpreadPct != null
                ? `${primeQualityStats.avgSpreadPct.toFixed(1)}%`
                : (primeQualityStats.avgSpread != null ? formatMoney(primeQualityStats.avgSpread) : null)}
              tone={primeQualityStats.avgSpreadPct != null && primeQualityStats.avgSpreadPct <= 10 ? "good" : primeQualityStats.avgSpreadPct != null && primeQualityStats.avgSpreadPct <= 20 ? "warn" : "default"}
              sub={primeQualityStats.avgBid != null && primeQualityStats.avgAsk != null ? `Bid ${formatMoney(primeQualityStats.avgBid)} · Ask ${formatMoney(primeQualityStats.avgAsk)}` : "N/D"}
            />
            <ProKpi
              label="Prime moyenne"
              value={primeQualityStats.avgPremium != null ? formatMoney(primeQualityStats.avgPremium) : null}
              tone="info"
              sub={primeQualityStats.premiumEfficiency != null ? `Premium efficiency ${primeQualityStats.premiumEfficiency.toFixed(2)}%` : "N/D"}
            />
            <ProKpi
              label="Qualité prime"
              value={primeQualityStats.qualityVerdict}
              tone={primeQualityStats.qualityVerdict === "Prime propre" ? "good" : primeQualityStats.qualityVerdict === "Prime correcte" ? "info" : primeQualityStats.qualityVerdict === "Spread limite" ? "warn" : primeQualityStats.qualityVerdict === "Spread risqué" || primeQualityStats.qualityVerdict === "Qualité quote faible" ? "risk" : "muted"}
              sub={primeQualityStats.warnings.length > 0 ? primeQualityStats.warnings.join(" · ") : "Aucun warning détecté"}
            />
            <ProKpi
              label="Earnings risk"
              value={primeQualityStats.earningsRiskRate != null ? `${primeQualityStats.earningsRiskCount}/${primeQualityStats.earningsCoverageCount} (${primeQualityStats.earningsRiskRate.toFixed(0)}%)` : null}
              tone={primeQualityStats.earningsRiskRate != null && primeQualityStats.earningsRiskRate > 0 ? "warn" : "default"}
              sub={primeQualityStats.earningsRiskRate != null ? "Sur les records avec champ earnings" : "N/D"}
            />
            <ProKpi
              label="Stale quote / data quality"
              value={primeQualityStats.staleQuoteRate != null ? `${primeQualityStats.staleQuoteCount}/${primeQualityStats.staleCoverageCount} (${primeQualityStats.staleQuoteRate.toFixed(0)}%)` : null}
              tone={primeQualityStats.staleQuoteRate != null && primeQualityStats.staleQuoteRate > 20 ? "risk" : "default"}
              sub={primeQualityStats.staleQuoteRate != null ? "Stale quote sur records couverts" : "N/D"}
            />
          </div>
        </CollapsibleSection>
      )}

      {/* ── SECTION E — DATA CONFIDENCE ─────────────────────────────────────── */}
      {hasLoaded && (
        <CollapsibleSection
          title="Confiance statistique — État de la calibration"
          badge="Read-only"
          subtitle="Évaluation de la fiabilité des résultats actuels."
          defaultOpen={false}
          summaryRight={`Sample résolu n=${stats.resolvedCount} · ${confidenceLevel(stats.resolvedCount).label} · Non résolu n=${stats.unresolvedCount}`}
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
              "V2C + V2D-B actifs : stress metrics intégrées dans les buckets de rendement, les modes Safe/Aggressive et le Ticker Leaderboard · split Safe/Aggressive par ticker · verdicts prudents, aucun faux chiffre, read-only.",
            ].filter(Boolean).map((msg, i) => (
              <div key={i} className="flex items-start gap-2 rounded-xl border border-slate-700/40 bg-slate-800/30 px-4 py-2.5">
                <span className="text-slate-600 text-sm mt-0.5">›</span>
                <p className="text-[11px] text-slate-500 leading-relaxed">{msg}</p>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* ── SECTION F — MÉTRIQUES V2 PRÉPARÉES ─────────────────────────────── */}
      {hasLoaded && (
        <CollapsibleSection
          title="Métriques avancées — Préparées pour V2"
          badge="Prochaine phase"
          subtitle="Placeholders visuels. Aucune donnée inventée — tracking requis pour activation."
          defaultOpen={false}
          summaryRight="6 métriques préparées · tracking requis · N/D"
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
        </CollapsibleSection>
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
            <span className="ml-4 text-[10px] text-slate-500">{showRawSections ? "Masquer ▼" : "Afficher ▶"}</span>
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
          <CollapsibleSection
            title="À résoudre"
            defaultOpen={false}
            summaryRight={(() => {
              const uniqueTickers = new Set(unresolvedRecords.map((r) => r?.symbol).filter(Boolean));
              const expirations = unresolvedRecords.map((r) => r?.expiration).filter(Boolean).sort();
              const parts = [
                `${unresolvedRecords.length} record${unresolvedRecords.length !== 1 ? "s" : ""}`,
                uniqueTickers.size > 0 ? `${uniqueTickers.size} ticker${uniqueTickers.size !== 1 ? "s" : ""}` : null,
                expirations.length > 0 ? `prochaine exp. ${formatCompactExpiration(expirations[0])}` : null,
              ].filter(Boolean).join(" · ");
              return unresolvedRecords.length === 0 ? "Aucun record en attente" : parts;
            })()}
          >
            <p className="mb-4 text-[11px] text-slate-600">{unresolvedRecords.length} record{unresolvedRecords.length !== 1 ? "s" : ""}</p>
            {unresolvedRecords.length === 0 ? (
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {unresolvedRecords.map((record) => {
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CollapsibleSection>
          <CollapsibleSection
            title="Résolus"
            defaultOpen={false}
            summaryRight={(() => {
              const uniqueTickers = new Set(resolvedRecords.map((r) => r?.symbol).filter(Boolean));
              const plVals = resolvedRecords.map((r) => numberOrNull(r?.resolution?.realizedPl)).filter((v) => v != null);
              const totalPl = plVals.length > 0 ? plVals.reduce((s, v) => s + v, 0) : null;
              const parts = [
                `${resolvedRecords.length} record${resolvedRecords.length !== 1 ? "s" : ""}`,
                uniqueTickers.size > 0 ? `${uniqueTickers.size} ticker${uniqueTickers.size !== 1 ? "s" : ""}` : null,
                stats.winRate != null ? `Win rate ${stats.winRate.toFixed(1)}%` : null,
                totalPl != null ? `P/L total ${formatMoney(totalPl)}` : null,
              ].filter(Boolean).join(" · ");
              return resolvedRecords.length === 0 ? "Aucun record résolu" : parts;
            })()}
          >
            <p className="mb-4 text-[11px] text-slate-600">{resolvedRecords.length} record{resolvedRecords.length !== 1 ? "s" : ""}</p>
            {resolvedRecords.length === 0 ? (
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
                      <th className="px-3 py-3 font-semibold">Strike touché</th>
                      <th className="px-3 py-3 font-semibold">Min prix</th>
                      <th className="px-3 py-3 font-semibold">Max ITM</th>
                      <th className="px-3 py-3 font-semibold">LB cassé</th>
                      <th className="px-3 py-3 font-semibold">Drawdown %</th>
                      <th className="px-3 py-3 font-semibold">Support cassé</th>
                      <th className="px-3 py-3 font-semibold">Dist. LB</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {resolvedRecords.map((record) => {
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
                          <td className="px-3 py-2.5">{formatYesNo(record?.resolution?.strikeTouched)}</td>
                          <td className="px-3 py-2.5">{formatMoney(record?.resolution?.minPriceBetweenScanAndExpiration)}</td>
                          <td className="px-3 py-2.5">{formatMoney(record?.resolution?.maxItmDepth)}</td>
                          <td className="px-3 py-2.5">{formatYesNo(record?.resolution?.brokeLowerBound)}</td>
                          <td className="px-3 py-2.5">{formatPercent(record?.resolution?.drawdownPct)}</td>
                          <td className="px-3 py-2.5">{formatYesNo(record?.resolution?.supportBreak)}</td>
                          <td className="px-3 py-2.5">{formatMoney(record?.resolution?.lowerBoundDistance)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CollapsibleSection>
        </>
      )}
    </div>
  );
}
