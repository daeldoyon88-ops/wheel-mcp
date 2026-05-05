import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

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
  return `${(n * 100).toFixed(1)}%`;
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

function JournalMetric({ label, value, tone = "default" }) {
  const toneClass =
    tone === "good"
      ? "text-emerald-700"
      : tone === "warn"
      ? "text-amber-700"
      : "text-slate-900";
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function JournalTable({ title, rows }) {
  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">{rows.length} record{rows.length > 1 ? "s" : ""}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-sm text-slate-500">
          Aucun record.
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-xs text-slate-700">
            <thead className="border-b border-slate-200 text-[11px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-3 font-medium">Date scan</th>
                <th className="px-3 py-3 font-medium">Ticker</th>
                <th className="px-3 py-3 font-medium">Expiration</th>
                <th className="px-3 py-3 font-medium">Strike mode</th>
                <th className="px-3 py-3 font-medium">Strike</th>
                <th className="px-3 py-3 font-medium">Premium</th>
                <th className="px-3 py-3 font-medium">POP estime</th>
                <th className="px-3 py-3 font-medium">Yahoo Rank</th>
                <th className="px-3 py-3 font-medium">IBKR Rank</th>
                <th className="px-3 py-3 font-medium">Elite Score</th>
                <th className="px-3 py-3 font-medium">Elite Badge</th>
                <th className="px-3 py-3 font-medium">Resultat</th>
                <th className="px-3 py-3 font-medium">P/L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => (
                <tr key={record.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-3">{formatDate(record?.scanTimestamp ?? record?.scanDate)}</td>
                  <td className="px-3 py-3 font-semibold text-slate-900">{record?.symbol || "—"}</td>
                  <td className="px-3 py-3">{formatCompactExpiration(record?.expiration)}</td>
                  <td className="px-3 py-3">{record?.strikeMode || "—"}</td>
                  <td className="px-3 py-3">{numberOrNull(record?.strike?.strike) ?? "—"}</td>
                  <td className="px-3 py-3">{formatMoney(record?.strike?.premium)}</td>
                  <td className="px-3 py-3">{formatPop(record?.strike?.popEstimate)}</td>
                  <td className="px-3 py-3">{numberOrNull(record?.ranks?.yahooRank) ?? "—"}</td>
                  <td className="px-3 py-3">{numberOrNull(record?.ranks?.ibkrRank) ?? "—"}</td>
                  <td className="px-3 py-3">
                    {numberOrNull(record?.scores?.eliteScore) != null
                      ? Number(record.scores.eliteScore).toFixed(1)
                      : "—"}
                  </td>
                  <td className="px-3 py-3">{record?.scores?.eliteBadge || "—"}</td>
                  <td className="px-3 py-3">{getResolutionLabel(record)}</td>
                  <td className="px-3 py-3">{formatMoney(record?.resolution?.realizedPl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CalibrationTable({ title, headers, rows }) {
  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-lg font-semibold text-slate-950">{title}</h3>
      {rows.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
          Aucune donnee.
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-xs text-slate-700">
            <thead className="border-b border-slate-200 text-[11px] uppercase tracking-[0.12em] text-slate-500">
              <tr>
                {headers.map((head) => (
                  <th key={head} className="px-3 py-3 font-medium">
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function JournalPopPanel({ apiBase, active }) {
  const [journal, setJournal] = useState(null);
  const [calibrationStats, setCalibrationStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [resolveSummary, setResolveSummary] = useState(null);

  const loadJournal = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [journalResponse, statsResponse] = await Promise.all([
        fetch(`${apiBase}/journal/wheel-validation`),
        fetch(`${apiBase}/journal/wheel-validation/stats`),
      ]);
      const payload = await journalResponse.json();
      const statsPayload = await statsResponse.json();
      if (!journalResponse.ok || payload?.ok !== true) {
        throw new Error(payload?.error || "journal_fetch_failed");
      }
      if (!statsResponse.ok || statsPayload?.ok !== true) {
        throw new Error(statsPayload?.error || "journal_stats_fetch_failed");
      }
      setJournal(payload.journal ?? { version: "1.0", updatedAt: null, records: [] });
      setCalibrationStats(statsPayload.stats ?? null);
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
      const response = await fetch(`${apiBase}/journal/wheel-validation/resolve-expired`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || "journal_resolve_expired_failed");
      }
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
    if (active && !hasLoaded && !loading) {
      loadJournal();
    }
  }, [active, hasLoaded, loading, loadJournal]);

  const records = useMemo(() => {
    const rows = Array.isArray(journal?.records) ? journal.records.slice() : [];
    return rows.sort((left, right) => {
      const a = String(left?.scanTimestamp ?? "");
      const b = String(right?.scanTimestamp ?? "");
      return b.localeCompare(a);
    });
  }, [journal]);

  const unresolvedRecords = useMemo(
    () => records.filter((record) => record?.resolution?.resolved !== true),
    [records]
  );
  const resolvedRecords = useMemo(
    () => records.filter((record) => record?.resolution?.resolved === true),
    [records]
  );

  const stats = useMemo(() => {
    const expiredWorthlessCount = resolvedRecords.filter(
      (record) => record?.resolution?.expiredWorthless === true
    ).length;
    const assignmentCount = resolvedRecords.filter(
      (record) => record?.resolution?.assigned === true
    ).length;
    const popResolved = resolvedRecords.filter(
      (record) => typeof record?.resolution?.popPredictionCorrect === "boolean"
    );
    const popAccuracy =
      popResolved.length > 0
        ? (popResolved.filter((record) => record.resolution.popPredictionCorrect === true).length /
            popResolved.length) *
          100
        : null;
    const realizedValues = resolvedRecords
      .map((record) => numberOrNull(record?.resolution?.realizedPl))
      .filter((value) => value != null);
    const averageRealizedPl =
      realizedValues.length > 0
        ? realizedValues.reduce((sum, value) => sum + value, 0) / realizedValues.length
        : null;
    return {
      totalRecords: records.length,
      resolvedCount: resolvedRecords.length,
      unresolvedCount: unresolvedRecords.length,
      expiredWorthlessCount,
      assignmentCount,
      popAccuracy,
      averageRealizedPl,
    };
  }, [records, resolvedRecords, unresolvedRecords]);

  const hasResolvedCalibrationData = Number(calibrationStats?.resolvedRecords ?? 0) > 0;

  return (
    <div className="space-y-6">
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
              Journal POP / Validation Wheel
            </div>
            <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-950">
              Lecture seule du journal backend
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Chargement a la demande via <code>/journal/wheel-validation</code>, sans relancer le scan ni modifier la shortlist active.
            </p>
          </div>

          <button
            type="button"
            onClick={loadJournal}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh Journal
            <RefreshCw className={`ml-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={resolveExpired}
            disabled={resolving || loading}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Résoudre expirations échues
          </button>
        </div>

        {error ? (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}
        {resolveSummary ? (
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            Résolus : {resolveSummary.resolved} · Sans close : {resolveSummary.skippedNoClose} · Erreurs :{" "}
            {resolveSummary.errors}
          </div>
        ) : null}

        {!hasLoaded && !loading ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
            Ouvre l onglet puis charge le journal a la demande.
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <JournalMetric label="Total records" value={String(stats.totalRecords)} />
        <JournalMetric label="Resolved" value={String(stats.resolvedCount)} tone="good" />
        <JournalMetric label="Unresolved" value={String(stats.unresolvedCount)} tone="warn" />
        <JournalMetric label="Expired worthless" value={String(stats.expiredWorthlessCount)} tone="good" />
        <JournalMetric label="Assignments" value={String(stats.assignmentCount)} tone="warn" />
        <JournalMetric label="POP accuracy" value={formatPercent(stats.popAccuracy)} />
        <JournalMetric label="Average realized P/L" value={formatMoney(stats.averageRealizedPl)} />
        <JournalMetric
          label="Updated"
          value={journal?.updatedAt ? formatDate(journal.updatedAt) : "—"}
        />
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-950">Calibration</h3>
        {!hasResolvedCalibrationData ? (
          <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
            Pas encore assez de donnees resolues.
          </div>
        ) : (
          <div className="mt-4 space-y-6">
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <JournalMetric label="Total records" value={String(calibrationStats?.totalRecords ?? 0)} />
              <JournalMetric label="Resolved records" value={String(calibrationStats?.resolvedRecords ?? 0)} tone="good" />
              <JournalMetric label="Unresolved records" value={String(calibrationStats?.unresolvedRecords ?? 0)} tone="warn" />
              <JournalMetric label="Success rate" value={formatPercent(calibrationStats?.overall?.successRate)} />
              <JournalMetric label="Avg POP estimate" value={formatPop(calibrationStats?.overall?.avgPopEstimate)} />
              <JournalMetric label="Avg Elite score" value={numberOrNull(calibrationStats?.overall?.avgEliteScore)?.toFixed(1) ?? "—"} />
            </section>

            <CalibrationTable
              title="Par DTE"
              headers={["DTE", "Count", "Success", "Failure", "Success rate", "Avg POP", "Avg Elite"]}
              rows={(calibrationStats?.byDte ?? []).map((row) => (
                <tr key={`dte-${String(row?.dteAtScan ?? "na")}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-3">{numberOrNull(row?.dteAtScan) ?? "—"}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.count) ?? 0}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.successCount) ?? 0}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.failureCount) ?? 0}</td>
                  <td className="px-3 py-3">{formatPercent(row?.successRate)}</td>
                  <td className="px-3 py-3">{formatPop(row?.avgPopEstimate)}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.avgEliteScore)?.toFixed(1) ?? "—"}</td>
                </tr>
              ))}
            />

            <CalibrationTable
              title="Par Strike Mode"
              headers={["Mode", "Count", "Success rate", "Avg POP", "Avg Premium", "Avg Elite"]}
              rows={(calibrationStats?.byStrikeMode ?? []).map((row) => (
                <tr key={`mode-${String(row?.strikeMode ?? "na")}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-3">{row?.strikeMode || "—"}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.count) ?? 0}</td>
                  <td className="px-3 py-3">{formatPercent(row?.successRate)}</td>
                  <td className="px-3 py-3">{formatPop(row?.avgPopEstimate)}</td>
                  <td className="px-3 py-3">{formatMoney(row?.avgPremium)}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.avgEliteScore)?.toFixed(1) ?? "—"}</td>
                </tr>
              ))}
            />

            <CalibrationTable
              title="Par Elite Badge"
              headers={["Badge", "Count", "Success rate", "Avg POP", "Avg Elite"]}
              rows={(calibrationStats?.byEliteBadge ?? []).map((row) => (
                <tr key={`badge-${String(row?.eliteBadge ?? "na")}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-3">{row?.eliteBadge || "unknown"}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.count) ?? 0}</td>
                  <td className="px-3 py-3">{formatPercent(row?.successRate)}</td>
                  <td className="px-3 py-3">{formatPop(row?.avgPopEstimate)}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.avgEliteScore)?.toFixed(1) ?? "—"}</td>
                </tr>
              ))}
            />

            <CalibrationTable
              title="Par Cohorte Expiration"
              headers={["Cohorte", "Count", "Resolved", "Assigned", "Expired worthless", "Success rate"]}
              rows={(calibrationStats?.byExpirationCohort ?? []).map((row) => (
                <tr key={`cohort-${String(row?.expirationCohort ?? "na")}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-3">{row?.expirationCohort || "unknown"}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.count) ?? 0}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.resolvedCount) ?? 0}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.assignedCount) ?? 0}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.expiredWorthlessCount) ?? 0}</td>
                  <td className="px-3 py-3">{formatPercent(row?.successRate)}</td>
                </tr>
              ))}
            />

            <CalibrationTable
              title="Top Tickers (>=3 resolus)"
              headers={["Ticker", "Count", "Success rate"]}
              rows={(calibrationStats?.byTickerTop ?? []).map((row) => (
                <tr key={`ticker-${String(row?.symbol ?? "na")}`} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-3 py-3 font-semibold text-slate-900">{row?.symbol || "—"}</td>
                  <td className="px-3 py-3">{numberOrNull(row?.count) ?? 0}</td>
                  <td className="px-3 py-3">{formatPercent(row?.successRate)}</td>
                </tr>
              ))}
            />
          </div>
        )}
      </section>

      <JournalTable title="A resoudre" rows={unresolvedRecords} />
      <JournalTable title="Resolus" rows={resolvedRecords} />
    </div>
  );
}
