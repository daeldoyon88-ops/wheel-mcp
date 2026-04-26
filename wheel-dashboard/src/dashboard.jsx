import React, { useMemo, useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  ShieldCheck,
  AlertTriangle,
  CalendarDays,
  Target,
  Search,
  Activity,
  ChevronRight,
  BarChart3,
  Layers3,
  X,
  RefreshCw,
  Database,
} from "lucide-react";
import { wheelShortlist } from "./data/wheelShortlist";

const API_BASE = "http://127.0.0.1:3001";

const DEFAULT_EXPIRATIONS = [
  "2026-04-24",
  "2026-05-01",
  "2026-05-08",
  "2026-05-15",
  "2026-05-22",
];

/** Liste statique conservée uniquement en secours si /universe/build échoue ou est indisponible. */
const FALLBACK_TICKERS = [
  "CF", "SNOW", "KO", "SLB", "TSCO", "PCG", "DOCU", "PATH", "F", "WBD",
  "BITX", "SOFI", "ABT", "SCHW", "CSX", "NDAQ", "BAC", "CVS", "GM", "HIMS",
  "UBER", "TGT", "AFRM", "SBUX", "NFLX", "TQQQ", "EXPE", "SHOP", "AAPL", "SOXL",
  "AMZN", "AMD", "ORCL", "PLTR", "NVDA", "MSFT", "GOOGL", "MU", "AVGO", "TSM",
  "MRVL", "IBKR", "DUOL", "RYAAY", "NEM", "DELL", "KMI", "HOOD", "LVS", "TW",
  "NI", "FSLR", "INCY", "NBIX", "ROOT", "VST", "TECK", "ZM", "PYPL", "DECK",
  "NVO", "PHM", "DXCM", "USB", "PDD"
];

/** Aligné sur ton backend (schema zod dans server.js) — à ajuster si tes critères changent. */
const DEFAULT_BUILD_WATCHLIST_BODY = {
  maxPrice: 125,
  minVolume: 500000,
  requireLiquidOptions: false,
  requireWeeklyOptions: true,
  categories: ["core", "growth"],
};
const LAST_GOOD_SCAN_KEY = "wheel.lastGoodScan.v1";

const alerts = [
  {
    type: "earnings",
    title: "Règle earnings",
    body: "Les dossiers earnings gardent la logique expected move x2 pour la sélection de la borne basse.",
  },
  {
    type: "rule",
    title: "Watchlist backend",
    body: "Le compteur Watchlist et le scan utilisent /universe/build quand le backend répond ; la liste statique sert de secours.",
  },
];

const verdictStyle = {
  conservative: "bg-emerald-50 text-emerald-700 border-emerald-200",
  balanced: "bg-amber-50 text-amber-700 border-amber-200",
  aggressive: "bg-rose-50 text-rose-700 border-rose-200",
};

const riskToProgress = {
  conservative: 28,
  balanced: 56,
  aggressive: 82,
};

function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

function minPremiumForSpot(spot) {
  if (!spot || spot <= 0) return 0;
  return spot * 0.005;
}

function strikeDistancePct(strike, spot) {
  if (!strike || !spot || spot <= 0) return 0;
  return ((strike - spot) / spot) * 100;
}

function pickTargetExpiration(availableExpirations, targetExpiration) {
  if (!Array.isArray(availableExpirations) || availableExpirations.length === 0) return null;
  if (targetExpiration && availableExpirations.includes(targetExpiration)) return targetExpiration;
  return availableExpirations[0] || null;
}

function formatShortDate(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [y, m, d] = value.trim().split("-").map(Number);
    const localDay = new Date(y, m - 1, d);
    if (!Number.isNaN(localDay.getTime())) {
      return localDay.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function isYmd(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function ymdTodayLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysBetweenYmd(fromYmd, toYmd) {
  if (!isYmd(fromYmd) || !isYmd(toYmd)) return null;
  const [fromY, fromM, fromD] = fromYmd.split("-").map(Number);
  const [toY, toM, toD] = toYmd.split("-").map(Number);
  const fromUtc = Date.UTC(fromY, fromM - 1, fromD);
  const toUtc = Date.UTC(toY, toM - 1, toD);
  return Math.round((toUtc - fromUtc) / (1000 * 60 * 60 * 24));
}

function earningsMomentLabel(moment) {
  if (moment === "morning") return "avant ouverture";
  if (moment === "evening") return "après fermeture";
  return "moment inconnu";
}

function buildEarningsWarning({ earningsDate, nextEarningsDate, earningsMoment, expiration }) {
  const today = ymdTodayLocal();
  const effectiveDate =
    (isYmd(nextEarningsDate) && nextEarningsDate >= today ? nextEarningsDate : null) ??
    (isYmd(earningsDate) ? earningsDate : null);
  const earningsDaysUntil = effectiveDate ? daysBetweenYmd(today, effectiveDate) : null;
  const shouldWarn =
    earningsDaysUntil != null && earningsDaysUntil >= 0 && earningsDaysUntil <= 10;
  const beforeExpiration =
    !!(effectiveDate && isYmd(expiration) && String(effectiveDate) < String(expiration));
  const earningsWarning = shouldWarn
    ? `⚠ Earnings dans ${earningsDaysUntil} jours — ${earningsMomentLabel(earningsMoment)}${
        beforeExpiration ? " — avant expiration" : ""
      }`
    : null;

  return {
    earningsDaysUntil,
    earningsWarning,
    earningsWarningLevel: shouldWarn ? "warning" : null,
  };
}

function isUsMarketClosedNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const totalMinutes = hour * 60 + minute;
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  if (isWeekend) return true;
  if (totalMinutes < 9 * 60 + 30) return true;
  if (totalMinutes >= 16 * 60) return true;
  return false;
}

function toDashboardCandidate(item, index, selectedExpiration) {
  const safe = item.safeStrike;
  const aggressive = item.aggressiveStrike ?? item.maxPremiumStrike ?? null;
  const primaryStrike = safe || aggressive;
  const impliedVolatility = safe?.impliedVolatility ?? aggressive?.impliedVolatility ?? null;
  const earningsDate = item.earningsDate ?? null;
  const fallbackWarning = buildEarningsWarning({
    earningsDate: item.earningsDate ?? null,
    nextEarningsDate: item.nextEarningsDate ?? null,
    earningsMoment: item.earningsMoment ?? null,
    expiration: selectedExpiration,
  });
  const earningsDaysUntil =
    typeof item.earningsDaysUntil === "number" ? item.earningsDaysUntil : fallbackWarning.earningsDaysUntil;
  const earningsWarning = item.earningsWarning ?? fallbackWarning.earningsWarning;
  const earningsWarningLevel = item.earningsWarningLevel ?? fallbackWarning.earningsWarningLevel;

  const safeDistance =
    safe && item.currentPrice > 0 ? strikeDistancePct(safe.strike, item.currentPrice) : 0;

  const aggressiveDistance =
    aggressive && item.currentPrice > 0 ? strikeDistancePct(aggressive.strike, item.currentPrice) : 0;
  const liquiditySpreadPct =
    safe?.liquidity?.spreadPct ?? aggressive?.liquidity?.spreadPct ?? null;
  const fallbackExecutionScore =
    typeof liquiditySpreadPct === "number" && Number.isFinite(liquiditySpreadPct)
      ? Math.max(0, Math.min(1, 1 - liquiditySpreadPct / 50))
      : 0.5;
  const fallbackDistanceScore = Math.min(
    Math.abs((primaryStrike ? strikeDistancePct(primaryStrike.strike, item.currentPrice ?? 0) : 0) / 10),
    1
  );
  const weeklyReturnPct = primaryStrike ? (primaryStrike.weeklyYield ?? 0) * 100 : 0;
  const fallbackFinalScore = Math.max(0, weeklyReturnPct / 100);
  const hasBackendScores =
    Number.isFinite(item?.finalScore) &&
    Number.isFinite(item?.executionScore) &&
    Number.isFinite(item?.distanceScore);
  const proFinalScore = hasBackendScores ? Number(item.finalScore) : fallbackFinalScore;
  const proExecutionScore = hasBackendScores ? Number(item.executionScore) : fallbackExecutionScore;
  const proDistanceScore = hasBackendScores ? Number(item.distanceScore) : fallbackDistanceScore;
  const scoreSource = hasBackendScores ? "backend" : "fallback";

  return {
    rank: index + 1,
    ticker: item.symbol,
    name: item.symbol,
    setup: item.hasEarnings
      ? `Mode earnings — expiration ${selectedExpiration}`
      : `PUT scanner — expiration ${selectedExpiration}`,
    targetExpiration: selectedExpiration,
    price: item.currentPrice ?? 0,
    expectedMovePct:
      item.currentPrice && item.adjustedMove
        ? (item.adjustedMove / item.currentPrice) * 100
        : 0,
    expectedMoveMultiplier: item.hasEarnings ? 2 : 1,
    earningsMode: !!item.hasEarnings,
    earningsDate,
    earningsMoment: item.earningsMoment ?? null,
    nextEarningsDate: item.nextEarningsDate ?? null,
    earningsDaysUntil,
    earningsWarning,
    earningsWarningLevel,
    hasUpcomingEarningsBeforeExpiration:
      item.hasUpcomingEarningsBeforeExpiration ?? false,
    hasPastEarningsBeforeExpiration:
      item.hasPastEarningsBeforeExpiration ?? false,
    expectedMoveLow: item.lowerBound ?? 0,
    expectedMoveHigh:
      item.currentPrice != null && item.adjustedMove != null
        ? item.currentPrice + item.adjustedMove
        : 0,
    minPremium: item.targetPremium ?? minPremiumForSpot(item.currentPrice ?? 0),
    targetWeeks: item.targetWeeks ?? 1,
    safeStrike: safe
      ? {
          strike: safe.strike,
          mid: safe.premium,
          popEstimate: safe.popEstimate ?? null,
          weeklyYield: (safe.weeklyYield ?? 0) * 100,
          weeklyNormalizedYield:
            (safe.weeklyNormalizedYield ?? safe.weeklyYield ?? 0) * 100,
          annualizedYield: (safe.annualizedYield ?? 0) * 100,
          distancePct: safeDistance,
          label: "prime la plus proche de la cible",
          liquidity: safe.liquidity ?? null,
        }
      : null,
    aggressiveStrike: aggressive
      ? {
          strike: aggressive.strike,
          mid: aggressive.premium,
          popEstimate: aggressive.popEstimate ?? null,
          weeklyYield: (aggressive.weeklyYield ?? 0) * 100,
          weeklyNormalizedYield:
            (aggressive.weeklyNormalizedYield ?? aggressive.weeklyYield ?? 0) * 100,
          annualizedYield: (aggressive.annualizedYield ?? 0) * 100,
          distancePct: aggressiveDistance,
          label: "directement sous borne basse",
          liquidity: aggressive.liquidity ?? null,
        }
      : null,
    premium:
      safe && aggressive
        ? `${safe.premium?.toFixed(2) ?? "—"} / ${aggressive.premium?.toFixed(2) ?? "—"}`
        : primaryStrike
        ? `${primaryStrike.premium?.toFixed(2) ?? "—"}`
        : "—",
    weeklyReturn: weeklyReturnPct,
    strikeDistance: primaryStrike
      ? strikeDistancePct(primaryStrike.strike, item.currentPrice ?? 0)
      : 0,
    proFinalScore,
    proExecutionScore,
    proDistanceScore,
    scoreSource,
    capitalPerContract: primaryStrike ? primaryStrike.strike * 100 : 0,
    premiumPerContract: primaryStrike ? primaryStrike.premium * 100 : 0,
    earnings: item.hasEarnings ? "earnings mode actif" : "pas cette semaine",
    iv: typeof impliedVolatility === "number" && Number.isFinite(impliedVolatility)
      ? impliedVolatility * 100
      : null,
    rsi: item.technicals?.rsi ?? "—",
    trend: item.technicals?.trend ?? "unknown",
    momentum: item.technicals?.momentum ?? "unknown",
    sma20: item.technicals?.sma20 ?? null,
    sma50: item.technicals?.sma50 ?? null,
    support: item.supportResistance?.support ?? null,
    resistance: item.supportResistance?.resistance ?? null,
    strikeVsSupportPct: item.supportResistance?.strikeVsSupportPct ?? null,
    strikeVsResistancePct: item.supportResistance?.strikeVsResistancePct ?? null,
    supportStatus: item.supportResistance?.supportStatus ?? "unknown",
    macd: "—",
    zone: "sous borne basse",
    verdict: item.hasEarnings ? "balanced" : "conservative",
    ok: !!item.passesFilter,
    note: item.hasEarnings
      ? "Cas earnings conservé avec expected move x2 et détail live dans la fiche complète."
      : "Candidat issu du scanner backend, prêt à afficher dans le dashboard.",
    raw: item,
  };
}

function buildPortfolioCombos(candidates, capital, maxCapitalPct, maxPositions) {
  const usableCapital = capital * (maxCapitalPct / 100);
  const targetMinPct = 90;
  const targetGoalPct = 95;
  const basePool = candidates
    .filter((c) => Number.isFinite(c.proFinalScore) && Number.isFinite(c.proExecutionScore))
    .filter((c) => c.proFinalScore > 0)
    .filter((c) => {
      const spread = c.safeStrike?.liquidity?.spreadPct ?? c.aggressiveStrike?.liquidity?.spreadPct;
      if (spread == null) return true;
      return spread <= 35;
    });

  if (!basePool.length) return [];

  const modeConfigs = [
    {
      id: "aggressive",
      label: "Agressif",
      tickerCapPct: 0.25,
      positionCapPct: 0.25,
      maxContractsPerTicker: 4,
      minWeeklyYield: 0.007,
      minExecutionScore: 0.45,
      maxSpreadPct: 35,
      score: (c) =>
        0.6 * (c.weeklyReturn / 100) + 0.25 * c.proFinalScore + 0.15 * c.proExecutionScore,
    },
    {
      id: "balanced",
      label: "Équilibré",
      tickerCapPct: 0.2,
      positionCapPct: 0.2,
      maxContractsPerTicker: 3,
      minWeeklyYield: 0,
      minExecutionScore: 0,
      maxSpreadPct: 35,
      score: (c) => 0.4 * c.proFinalScore + 0.35 * c.proExecutionScore + 0.25 * c.proDistanceScore,
    },
    {
      id: "conservative",
      label: "Conservateur",
      tickerCapPct: 0.15,
      positionCapPct: 0.15,
      maxContractsPerTicker: 2,
      minWeeklyYield: 0,
      minExecutionScore: 0,
      maxSpreadPct: 35,
      score: (c) => 0.5 * c.proExecutionScore + 0.3 * c.proDistanceScore + 0.2 * c.proFinalScore,
    },
  ];

  function getModeStrike(candidate, modeId) {
    const isAggressive = modeId === "aggressive";
    const rawSafe = candidate.raw?.safeStrike ?? null;
    const rawAggressive = candidate.raw?.aggressiveStrike ?? null;
    const mappedSafe = candidate.safeStrike ?? null;
    const mappedAggressive = candidate.aggressiveStrike ?? null;

    const rawSelected = isAggressive
      ? rawAggressive ?? rawSafe
      : rawSafe ?? rawAggressive;
    const mappedSelected = isAggressive
      ? mappedAggressive ?? mappedSafe
      : mappedSafe ?? mappedAggressive;

    const strike = Number(rawSelected?.strike ?? mappedSelected?.strike ?? 0);
    const premiumUnit = Number(
      rawSelected?.conservativePremium ??
        rawSelected?.bid ??
        rawSelected?.premium ??
        mappedSelected?.mid ??
        0
    );
    const weeklyReturn =
      rawSelected?.weeklyYield != null
        ? Number(rawSelected.weeklyYield) * 100
        : Number(mappedSelected?.weeklyYield ?? candidate.weeklyReturn ?? 0);

    return {
      strike: Number.isFinite(strike) ? strike : 0,
      premiumUnit: Number.isFinite(premiumUnit) ? premiumUnit : 0,
      weeklyReturn: Number.isFinite(weeklyReturn) ? weeklyReturn : 0,
    };
  }

  function makeCombo(mode) {
    const scoredPool = basePool
      .map((candidate) => {
        const selected = getModeStrike(candidate, mode.id);
        return {
          ...candidate,
          selectedStrike: selected,
          capitalPerContract: selected.strike > 0 ? selected.strike * 100 : 0,
          premiumPerContract: selected.premiumUnit > 0 ? selected.premiumUnit * 100 : 0,
          weeklyReturn: selected.weeklyReturn,
          spreadPct:
            candidate.safeStrike?.liquidity?.spreadPct ??
            candidate.aggressiveStrike?.liquidity?.spreadPct ??
            null,
        };
      })
      .filter((candidate) => candidate.capitalPerContract > 0 && candidate.weeklyReturn > 0)
      .filter((candidate) => candidate.weeklyReturn / 100 >= mode.minWeeklyYield)
      .filter((candidate) => candidate.proExecutionScore >= mode.minExecutionScore)
      .filter((candidate) => candidate.spreadPct == null || candidate.spreadPct <= mode.maxSpreadPct)
      .map((candidate) => ({
        ...candidate,
        allocScore: mode.score(candidate),
      }))
      .sort((a, b) => b.allocScore - a.allocScore);
    if (!scoredPool.length) return null;
    const picks = [];
    let used = 0;
    const pickMap = new Map();
    const tickerCapDollars = usableCapital * mode.tickerCapPct;
    const positionCapDollars = usableCapital * mode.positionCapPct;

    function canAddContract(candidate, currentContracts, useSoftCaps = false) {
      if (candidate.capitalPerContract <= 0) return false;
      const maxContractsAllowed = useSoftCaps
        ? mode.maxContractsPerTicker + 1
        : mode.maxContractsPerTicker;
      if (currentContracts >= maxContractsAllowed) return false;
      if (used + candidate.capitalPerContract > usableCapital) return false;
      const nextPositionCapital = (currentContracts + 1) * candidate.capitalPerContract;
      const tickerCapLimit = useSoftCaps ? tickerCapDollars * 1.2 : tickerCapDollars;
      const positionCapLimit = useSoftCaps ? positionCapDollars * 1.15 : positionCapDollars;
      if (nextPositionCapital > tickerCapLimit) return false;
      if (nextPositionCapital > positionCapLimit) return false;
      return true;
    }

    // Pass 1: breadth first (max 1 contract per ticker)
    for (const candidate of scoredPool) {
      if (picks.length >= maxPositions) break;
      const existing = pickMap.get(candidate.ticker);
      if (existing) continue;
      if (!canAddContract(candidate, 0)) continue;

      const pick = {
        ticker: candidate.ticker,
        strike: candidate.selectedStrike.strike,
        contracts: 1,
        capitalUsed: candidate.capitalPerContract,
        premiumCollected: candidate.premiumPerContract,
        weeklyReturn: candidate.weeklyReturn,
      };
      picks.push(pick);
      pickMap.set(candidate.ticker, pick);
      used += candidate.capitalPerContract;
    }

    // Pass 2: depth by score while respecting caps
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const candidate of scoredPool) {
        const existing = pickMap.get(candidate.ticker);
        if (!existing) continue;
        if (!canAddContract(candidate, existing.contracts)) continue;

        existing.contracts += 1;
        existing.capitalUsed += candidate.capitalPerContract;
        existing.premiumCollected += candidate.premiumPerContract;
        used += candidate.capitalPerContract;
        progressed = true;
      }
    }

    // Pass 3: capital completion with soft caps.
    const usablePct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
    if (usablePct < targetMinPct) {
      let softProgressed = true;
      while (softProgressed) {
        const currentPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
        if (currentPct >= targetGoalPct) break;
        softProgressed = false;
        for (const candidate of scoredPool) {
          const existing = pickMap.get(candidate.ticker);
          if (!existing) continue;
          if (!canAddContract(candidate, existing.contracts, true)) continue;

          existing.contracts += 1;
          existing.capitalUsed += candidate.capitalPerContract;
          existing.premiumCollected += candidate.premiumPerContract;
          used += candidate.capitalPerContract;
          softProgressed = true;

          const updatedPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
          if (updatedPct >= targetGoalPct) break;
        }
      }
    }

    // Pass 4: targeted completion under soft caps.
    let completionProgressed = true;
    while (completionProgressed) {
      const currentPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
      if (currentPct >= targetGoalPct) break;
      completionProgressed = false;
      for (const candidate of scoredPool) {
        const existing = pickMap.get(candidate.ticker);
        if (!existing) continue;
        if (!canAddContract(candidate, existing.contracts, true)) continue;
        existing.contracts += 1;
        existing.capitalUsed += candidate.capitalPerContract;
        existing.premiumCollected += candidate.premiumPerContract;
        used += candidate.capitalPerContract;
        completionProgressed = true;
        const updatedPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
        if (updatedPct >= targetGoalPct) break;
      }
    }

    if (!picks.length) return null;

    const avgWeekly =
      picks.reduce((sum, p) => sum + p.weeklyReturn * p.capitalUsed, 0) /
      picks.reduce((sum, p) => sum + p.capitalUsed, 0);
    const usedPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
    let capitalShortfallReason = null;
    if (usedPct < targetMinPct) {
      const hasAnyCandidate = scoredPool.length > 0;
      const hasAnyPick = picks.length > 0;
      const minContractCost = hasAnyCandidate
        ? Math.min(...scoredPool.map((c) => c.capitalPerContract))
        : Number.POSITIVE_INFINITY;
      if (!hasAnyCandidate) {
        capitalShortfallReason = "not_enough_candidates";
      } else if (!hasAnyPick) {
        capitalShortfallReason = "min_yield_or_execution_filter";
      } else if (picks.length >= maxPositions) {
        capitalShortfallReason = "max_positions_limit";
      } else if (usableCapital - used < minContractCost) {
        capitalShortfallReason = "contract_size_too_large";
      } else {
        capitalShortfallReason = "caps_too_strict";
      }
    }

    return {
      label: mode.label,
      positions: picks.length,
      totalCapital: used,
      capitalPct: capital > 0 ? (used / capital) * 100 : 0,
      capitalTargetReached: usedPct >= targetMinPct,
      capitalShortfallReason,
      avgWeeklyReturn: avgWeekly,
      freeCapital: capital - used,
      picks,
    };
  }

  return modeConfigs.map((mode) => makeCombo(mode)).filter(Boolean);
}

function Card({ className = "", children }) {
  return <div className={cn("rounded-2xl border bg-white", className)}>{children}</div>;
}

function CardHeader({ className = "", children }) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

function CardContent({ className = "", children }) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

function CardTitle({ className = "", children }) {
  return <h3 className={cn("font-semibold", className)}>{children}</h3>;
}

function Input({ className = "", ...props }) {
  return <input {...props} className={cn("border bg-white px-3 py-2 outline-none", className)} />;
}

function Select({ className = "", children, ...props }) {
  return (
    <select {...props} className={cn("border bg-white px-3 py-2 outline-none", className)}>
      {children}
    </select>
  );
}

function Badge({ className = "", children }) {
  return (
    <span className={cn("inline-flex items-center border px-2.5 py-1 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

function Button({ className = "", variant = "default", size = "default", children, ...props }) {
  const variantClass =
    variant === "outline"
      ? "border border-slate-300 bg-white text-slate-700"
      : "border border-slate-900 bg-slate-900 text-white";
  const sizeClass = size === "icon" ? "h-9 w-9 justify-center p-0" : "px-4 py-2";

  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center rounded-xl text-sm font-medium transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60",
        variantClass,
        sizeClass,
        className
      )}
    >
      {children}
    </button>
  );
}

function Progress({ value }) {
  return (
    <div className="h-2 w-full rounded-full bg-slate-200">
      <div
        className="h-2 rounded-full bg-slate-900"
        style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }}
      />
    </div>
  );
}

function StatCard({ item }) {
  const Icon = item.icon;

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-slate-500">{item.title}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{item.value}</p>
            <p className="mt-1 text-sm text-slate-500">{item.sub}</p>
          </div>
          <div className="rounded-2xl bg-slate-100 p-3">
            <Icon className="h-5 w-5 text-slate-700" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AlertPanel() {
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <Card
          key={alert.title}
          className={cn(
            "shadow-sm",
            alert.type === "earnings"
              ? "border-rose-200 bg-rose-50/70"
              : "border-emerald-200 bg-emerald-50/70"
          )}
        >
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-xl bg-white/80 p-2">
                {alert.type === "earnings" ? (
                  <AlertTriangle className="h-4 w-4 text-rose-600" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{alert.title}</p>
                <p className="mt-1 text-sm leading-6 text-slate-700">{alert.body}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Metric({ label, value, strong = false, tone = "default" }) {
  const toneClass =
    tone === "good"
      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : tone === "warn"
      ? "bg-amber-50 border-amber-200 text-amber-800"
      : tone === "bad"
      ? "bg-rose-50 border-rose-200 text-rose-800"
      : "bg-white border-slate-200 text-slate-700";

  return (
    <div className={cn("rounded-xl border p-3", toneClass)}>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cn("mt-1 text-sm", strong && "font-semibold")}>{value}</p>
    </div>
  );
}

function StrikeCard({
  className = "",
  title,
  subtitle,
  strike,
  mid,
  popEstimate,
  tradeYield,
  weeklyNormalizedYield,
  annualizedYield,
  distancePct,
  label,
  meetsTarget,
  liquidity,
}) {
  const distanceTone = distancePct <= -10 ? "good" : distancePct <= -5 ? "warn" : "bad";
  const yieldTone = tradeYield >= 1 ? "good" : tradeYield >= 0.5 ? "warn" : "bad";
  const midTone = mid >= 0.2 ? "good" : mid >= 0.09 ? "warn" : "bad";
  const popTone =
    popEstimate == null ? "default" : popEstimate >= 0.75 ? "good" : popEstimate >= 0.6 ? "warn" : "bad";

  return (
    <div className={cn("rounded-2xl border border-slate-200 bg-white p-4 shadow-sm", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{title}</p>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge className="rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700">
            {label}
          </Badge>
          <Badge
            className={cn(
              "rounded-full",
              meetsTarget
                ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border border-rose-200 bg-rose-50 text-rose-700"
            )}
          >
            {meetsTarget ? "objectif validé" : "objectif non atteint"}
          </Badge>
          {liquidity?.isLiquid ? (
            <Badge className="rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
              liquide
            </Badge>
          ) : (
            <Badge className="rounded-full border border-amber-200 bg-amber-50 text-amber-700">
              liquidité faible
            </Badge>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Strike" value={`$${strike.toFixed(2)}`} strong />
        <Metric label="Mid" value={`$${mid.toFixed(2)}`} strong={mid >= 0.09} tone={midTone} />
        <Metric label="Distance" value={`${distancePct.toFixed(1)}%`} strong tone={distanceTone} />
        <Metric label="Rendement" value={`${tradeYield.toFixed(2)}%`} strong tone={yieldTone} />
        <Metric
          label="Rendement hebdo (7J)"
          value={`${weeklyNormalizedYield.toFixed(2)}%`}
          strong
          tone={yieldTone}
        />
        <Metric label="Annualisé" value={`${annualizedYield.toFixed(1)}%`} tone={yieldTone} />
        <Metric
          label="POP estimée"
          value={popEstimate != null ? `${(popEstimate * 100).toFixed(1)}%` : "—"}
          tone={popTone}
        />
        <Metric
          label="Spread"
          value={
            liquidity?.spreadPct != null
              ? `${Number(liquidity.spreadPct).toFixed(2)}%`
              : "—"
          }
          tone={
            liquidity?.spreadPct == null
              ? "default"
              : liquidity.spreadPct <= 4
              ? "good"
              : liquidity.spreadPct <= 8
              ? "warn"
              : "bad"
          }
        />
      </div>
    </div>
  );
}

function StrikeOpportunities({ item }) {
  const adjustedMovePct = item.earningsMode
    ? item.expectedMovePct * (item.expectedMoveMultiplier || 1)
    : item.expectedMovePct;

  const hasSafe = !!item.safeStrike;
  const hasAggressive = !!item.aggressiveStrike;

  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">Opportunités sous la borne basse attendue</p>
          <p className="mt-1 text-sm text-slate-600">
            Spot actuel <span className="font-medium text-slate-900">${item.price.toFixed(2)}</span> · borne basse attendue{" "}
            <span className="font-medium text-rose-700">${item.expectedMoveLow.toFixed(2)}</span> · borne haute attendue{" "}
            <span className="font-medium text-emerald-700">${item.expectedMoveHigh.toFixed(2)}</span>
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Prime minimale cible safe :{" "}
            <span className="font-semibold text-slate-900">${Number(item.minPremium || 0).toFixed(2)}</span>
            {" "}· semaines cible :{" "}
            <span className="font-semibold text-slate-900">{item.targetWeeks ?? 1}</span>
          </p>
          {item.earningsMode && (
            <p className="mt-2 text-sm text-violet-700">
              Mode earnings actif : mouvement attendu normal{" "}
              <span className="font-semibold">{item.expectedMovePct.toFixed(2)}%</span> ×{" "}
              {item.expectedMoveMultiplier || 2} ={" "}
              <span className="font-semibold">{adjustedMovePct.toFixed(2)}%</span>.
            </p>
          )}
        </div>

        <Badge className="rounded-full border border-slate-300 bg-white text-slate-700">
          objectif 0.5% / semaine sur spot
        </Badge>
      </div>

      {hasSafe || hasAggressive ? (
        <div className="mt-4 grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
          {hasSafe && (
            <StrikeCard
              className="h-full"
              title="Strike safe"
              subtitle="prime la plus proche de la cible minimale"
              strike={item.safeStrike.strike}
              mid={item.safeStrike.mid}
              popEstimate={item.safeStrike.popEstimate}
              tradeYield={item.safeStrike.weeklyYield}
              weeklyNormalizedYield={item.safeStrike.weeklyNormalizedYield}
              annualizedYield={item.safeStrike.annualizedYield}
              distancePct={item.safeStrike.distancePct}
              label={item.safeStrike.label}
              meetsTarget={item.safeStrike.mid >= item.minPremium}
              liquidity={item.safeStrike.liquidity}
            />
          )}

          {hasAggressive && (
            <StrikeCard
              className="h-full"
              title="Strike agressif"
              subtitle="directement sous la borne basse"
              strike={item.aggressiveStrike.strike}
              mid={item.aggressiveStrike.mid}
              popEstimate={item.aggressiveStrike.popEstimate}
              tradeYield={item.aggressiveStrike.weeklyYield}
              weeklyNormalizedYield={item.aggressiveStrike.weeklyNormalizedYield}
              annualizedYield={item.aggressiveStrike.annualizedYield}
              distancePct={item.aggressiveStrike.distancePct}
              label={item.aggressiveStrike.label}
              meetsTarget={item.aggressiveStrike.mid >= item.minPremium}
              liquidity={item.aggressiveStrike.liquidity}
            />
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          Aucun strike local à afficher.
        </div>
      )}
    </div>
  );
}

function SupportStatusLine({ item }) {
  if (item.strikeVsSupportPct == null) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        Support: indisponible
      </div>
    );
  }

  const toneClass =
    item.supportStatus === "room_above_support"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : item.supportStatus === "near_support"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-rose-200 bg-rose-50 text-rose-700";

  const label =
    item.supportStatus === "room_above_support"
      ? "support OK"
      : item.supportStatus === "near_support"
      ? "près du support"
      : "sous le support";

  return (
    <div className={cn("rounded-xl border px-3 py-2 text-sm", toneClass)}>
      Strike vs support: {label} ({item.strikeVsSupportPct > 0 ? "+" : ""}{item.strikeVsSupportPct.toFixed(1)}%)
    </div>
  );
}

function CandidateCard({ item, onOpenDetail }) {
  if (["NFLX", "TQQQ", "SOFI", "HOOD"].includes(item?.ticker)) {
    console.log("CANDIDATE CARD DEBUG", {
      ticker: item?.ticker,
      item,
      hasEarnings: item?.hasEarnings,
      earningsDate: item?.earningsDate ?? null,
      nextEarningsDate: item?.nextEarningsDate ?? null,
      iv: item?.iv ?? null,
      safeStrike: item?.safeStrike ?? null,
      aggressiveStrike: item?.aggressiveStrike ?? null,
    });
  }

  const adjustedMovePct = item.earningsMode
    ? item.expectedMovePct * (item.expectedMoveMultiplier || 1)
    : item.expectedMovePct;
  const earningsDisplay =
    item.earningsWarning ||
    buildEarningsWarning({
      earningsDate: item.earningsDate ?? null,
      nextEarningsDate: item.nextEarningsDate ?? null,
      earningsMoment: item.earningsMoment ?? null,
      expiration: item.targetExpiration ?? null,
    }).earningsWarning;

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="border-slate-200 shadow-sm transition-all hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex-1 min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="rounded-full border border-slate-300 bg-slate-50 text-slate-700">
                  Choix #{item.rank}
                </Badge>
                <Badge className={cn("rounded-full border", verdictStyle[item.verdict])}>
                  {item.verdict}
                </Badge>
                {item.earningsMode && (
                  <Badge className="rounded-full border border-violet-200 bg-violet-50 text-violet-700">
                    mode earnings x{item.expectedMoveMultiplier || 2}
                  </Badge>
                )}
                {item.ok ? (
                  <Badge className="rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                    objectif validé
                  </Badge>
                ) : (
                  <Badge className="rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                    à surveiller
                  </Badge>
                )}
              </div>

              <div>
                <h3 className="text-xl font-semibold tracking-tight text-slate-900">
                  {item.ticker} <span className="font-normal text-slate-500">— {item.name}</span>
                </h3>
                <p className="mt-1 text-sm text-slate-600">{item.setup}</p>
                {earningsDisplay ? (
                  <p className="mt-1 text-sm text-amber-700">
                    {earningsDisplay}
                  </p>
                ) : item.earningsDate ? (
                  <p className="mt-1 text-sm text-violet-700">
                    Earnings: {formatShortDate(item.earningsDate) || item.earningsDate}
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4 xl:grid-cols-5">
                <Metric label="Prix actuel" value={`$${item.price.toFixed(2)}`} />
                <Metric
                  label="Mouvement attendu"
                  value={
                    item.earningsMode
                      ? `${item.expectedMovePct.toFixed(2)}% → ${adjustedMovePct.toFixed(2)}%`
                      : `${item.expectedMovePct.toFixed(2)}%`
                  }
                  strong
                  tone={item.earningsMode ? "bad" : "warn"}
                />
                <Metric label="Prix plus bas" value={`$${item.expectedMoveLow.toFixed(2)}`} strong tone="bad" />
                <Metric label="Prix supérieur" value={`$${item.expectedMoveHigh.toFixed(2)}`} strong tone="good" />
                <Metric label="Prime safe mini" value={`$${Number(item.minPremium || 0).toFixed(2)}`} />
                <Metric label="Semaines cible" value={`${item.targetWeeks ?? 1}`} />
                <Metric
                  label="Rendement"
                  value={`${item.weeklyReturn.toFixed(2)}% / sem`}
                  strong={item.weeklyReturn >= 0.5}
                  tone={item.weeklyReturn >= 0.5 ? "good" : "bad"}
                />
                <Metric label="Distance strike" value={`${item.strikeDistance.toFixed(1)}%`} />
                <Metric label="Capital / contrat" value={`$${item.capitalPerContract.toFixed(0)}`} />
                <Metric
                  label="IV"
                  value={typeof item.iv === "number" ? `${item.iv.toFixed(1)}%` : "—"}
                />
                <Metric
                  label="RSI"
                  value={typeof item.rsi === "number" ? `${item.rsi}` : "—"}
                  strong={typeof item.rsi === "number"}
                  tone={
                    typeof item.rsi !== "number"
                      ? "default"
                      : item.rsi >= 70
                      ? "bad"
                      : item.rsi <= 40
                      ? "warn"
                      : "good"
                  }
                />
                <Metric
                  label="Trend"
                  value={item.trend || "unknown"}
                  strong
                  tone={
                    item.trend === "bullish"
                      ? "good"
                      : item.trend === "bearish"
                      ? "bad"
                      : "warn"
                  }
                />
                <Metric
                  label="Momentum"
                  value={item.momentum || "unknown"}
                  strong
                  tone={
                    item.momentum === "positive"
                      ? "good"
                      : item.momentum === "negative"
                      ? "bad"
                      : "warn"
                  }
                />
                <Metric
                  label="Support"
                  value={item.support != null ? `$${Number(item.support).toFixed(2)}` : "—"}
                />
                <Metric
                  label="Résistance"
                  value={item.resistance != null ? `$${Number(item.resistance).toFixed(2)}` : "—"}
                />
              </div>

              <SupportStatusLine item={item} />
              <div className="pt-1">
                <Button className="rounded-xl" onClick={() => onOpenDetail(item)}>
                  Voir la fiche complète <ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="w-full xl:min-w-[420px] xl:max-w-[520px]">
              <StrikeOpportunities item={item} />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

async function callTool(toolName, args) {
  const response = await fetch(`${API_BASE}/tools/${toolName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  const payload = await response.json();

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload.result;
}

async function callBuildWatchlist(body) {
  const response = await fetch(`${API_BASE}/universe/build`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

async function callScanShortlist({ expiration, topN, tickers }) {
  const response = await fetch(`${API_BASE}/scan_shortlist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expiration,
      topN,
      tickers,
    }),
  });

  const payload = await response.json();

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

function DetailModal({ item, onClose }) {
  const [loading, setLoading] = useState(false);
  const [liveData, setLiveData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!item) return;

      setLoading(true);
      setError("");
      setLiveData(null);

      try {
        const quote = await callTool("get_quote", { symbol: item.ticker });
        const expirations = await callTool("get_option_expirations", { symbol: item.ticker });

        const availableExpirations =
          expirations?.availableExpirations ||
          expirations?.expirationDates ||
          expirations?.expirations ||
          [];

        const selectedExpiration = pickTargetExpiration(
          availableExpirations,
          item.targetExpiration
        );

        let expectedMove = null;
        let optionChain = null;
        let supportResistance = null;

        if (selectedExpiration) {
          expectedMove = await callTool("get_expected_move", {
            symbol: item.ticker,
            expiration: selectedExpiration,
          });

          optionChain = await callTool("get_option_chain", {
            symbol: item.ticker,
            expiration: selectedExpiration,
          });
        }

        supportResistance = await callTool("get_support_resistance", {
          symbol: item.ticker,
        });

        if (!cancelled) {
          setLiveData({
            quote,
            expirations,
            firstExpiration: selectedExpiration,
            expectedMove,
            optionChain,
            supportResistance,
          });
        }
      } catch (err) {
        if (!cancelled) {
          const msg = String(err?.message || err || "");
          if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
            setError("Yahoo a temporairement limité les requêtes (429). Réessaie dans un instant.");
          } else {
            setError(msg || "Impossible de charger les données live.");
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [item]);

  if (!item) return null;

  const livePrice =
    liveData?.quote?.regularMarketPrice ??
    liveData?.quote?.currentPrice ??
    item.price;

  const liveExpectedMovePct =
    liveData?.expectedMove?.expectedMovePercent ??
    item.expectedMovePct;

  const liveLow =
    liveData?.expectedMove?.oneSigmaRange?.lower ??
    item.expectedMoveLow;

  const liveHigh =
    liveData?.expectedMove?.oneSigmaRange?.upper ??
    item.expectedMoveHigh;

  const support = liveData?.supportResistance?.support ?? item.support ?? null;
  const resistance = liveData?.supportResistance?.resistance ?? item.resistance ?? null;
  const strikeVsSupportPct =
    item.safeStrike && support
      ? ((item.safeStrike.strike - support) / support) * 100
      : item.strikeVsSupportPct;

  const strikeVsResistancePct =
    item.safeStrike && resistance
      ? ((resistance - item.safeStrike.strike) / resistance) * 100
      : item.strikeVsResistancePct;

  const adjustedMovePct = item.earningsMode
    ? liveExpectedMovePct * (item.expectedMoveMultiplier || 1)
    : liveExpectedMovePct;
  const earningsDisplay =
    item.earningsWarning ||
    buildEarningsWarning({
      earningsDate: item.earningsDate ?? null,
      nextEarningsDate: item.nextEarningsDate ?? null,
      earningsMoment: item.earningsMoment ?? null,
      expiration: item.targetExpiration ?? null,
    }).earningsWarning;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4">
      <div className="mx-auto flex h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {item.ticker} — {item.name}
            </h2>
            <p className="mt-1 text-sm text-slate-500">{item.setup}</p>
            {earningsDisplay ? (
              <p className="mt-1 text-sm text-amber-700">
                {earningsDisplay}
              </p>
            ) : item.earningsDate ? (
              <p className="mt-1 text-sm text-violet-700">
                Earnings: {formatShortDate(item.earningsDate) || item.earningsDate}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={onClose} aria-label="Fermer">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-6 px-6 py-5">
          {loading && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Chargement des données live...
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              {error}
            </div>
          )}

          {!loading && !error && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
              Données live chargées pour le modal.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Metric label="Prix actuel" value={`$${Number(livePrice || 0).toFixed(2)}`} />
            <Metric
              label="Mouvement attendu"
              value={
                item.earningsMode
                  ? `${Number(liveExpectedMovePct || 0).toFixed(2)}% → ${Number(adjustedMovePct || 0).toFixed(2)}%`
                  : `${Number(liveExpectedMovePct || 0).toFixed(2)}%`
              }
              strong
              tone={item.earningsMode ? "bad" : "warn"}
            />
            <Metric label="Prix plus bas" value={`$${Number(liveLow || 0).toFixed(2)}`} strong tone="bad" />
            <Metric label="Prix supérieur" value={`$${Number(liveHigh || 0).toFixed(2)}`} strong tone="good" />
            <Metric label="Expiration" value={liveData?.firstExpiration || "—"} />
            <Metric label="Prime cible safe" value={`$${Number(item.minPremium || 0).toFixed(2)}`} />
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Support" value={support ? `$${Number(support).toFixed(2)}` : "—"} />
            <Metric label="Résistance" value={resistance ? `$${Number(resistance).toFixed(2)}` : "—"} />
            <Metric
              label="Strike vs support"
              value={
                strikeVsSupportPct == null
                  ? "—"
                  : `${strikeVsSupportPct > 0 ? "+" : ""}${Number(strikeVsSupportPct).toFixed(2)}%`
              }
              tone={
                strikeVsSupportPct == null
                  ? "default"
                  : strikeVsSupportPct >= 2
                  ? "good"
                  : strikeVsSupportPct >= 0
                  ? "warn"
                  : "bad"
              }
            />
            <Metric
              label="Strike vs résistance"
              value={
                strikeVsResistancePct == null
                  ? "—"
                  : `${Number(strikeVsResistancePct).toFixed(2)}%`
              }
            />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Résumé</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">{item.note}</p>
            <p className="mt-2 text-sm text-slate-600">
              Borne basse snapshot :{" "}
              <span className="font-semibold text-rose-700">
                ${Number(item.expectedMoveLow || 0).toFixed(2)}
              </span>
              {" "}· cible safe snapshot :{" "}
              <span className="font-semibold">${Number(item.minPremium || 0).toFixed(2)}</span>
              {" "}· semaines cible :{" "}
              <span className="font-semibold">{item.targetWeeks ?? 1}</span>
            </p>
          </div>

          <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
            {item.safeStrike ? (
              <StrikeCard
                className="h-full"
                title="Strike safe snapshot"
                subtitle="issu du backend /scan_shortlist"
                strike={item.safeStrike.strike}
                mid={item.safeStrike.mid}
                popEstimate={item.safeStrike.popEstimate}
                tradeYield={item.safeStrike.weeklyYield}
                weeklyNormalizedYield={item.safeStrike.weeklyNormalizedYield}
                annualizedYield={item.safeStrike.annualizedYield}
                distancePct={item.safeStrike.distancePct}
                label="safe strike"
                meetsTarget={item.safeStrike.mid >= item.minPremium}
                liquidity={item.safeStrike.liquidity}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                Aucun strike safe snapshot.
              </div>
            )}

            {item.aggressiveStrike ? (
              <StrikeCard
                className="h-full"
                title="Strike agressif snapshot"
                subtitle="issu du backend /scan_shortlist"
                strike={item.aggressiveStrike.strike}
                mid={item.aggressiveStrike.mid}
                popEstimate={item.aggressiveStrike.popEstimate}
                tradeYield={item.aggressiveStrike.weeklyYield}
                weeklyNormalizedYield={item.aggressiveStrike.weeklyNormalizedYield}
                annualizedYield={item.aggressiveStrike.annualizedYield}
                distancePct={item.aggressiveStrike.distancePct}
                label="aggressive strike"
                meetsTarget={item.aggressiveStrike.mid >= item.minPremium}
                liquidity={item.aggressiveStrike.liquidity}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                Aucun strike agressif snapshot.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PortfolioCombos({ combos, capital }) {
  if (!combos.length) {
    return (
      <Card className="rounded-[28px] border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-xl text-slate-900">Combinaisons capital</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
            Pas assez de données pour générer des combinaisons.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-[28px] border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-xl text-slate-900">Combinaisons capital</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {combos.map((combo) => (
          <div key={combo.label} className="rounded-2xl border border-slate-200 p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-base font-semibold text-slate-900">{combo.label}</p>
                <p className="text-sm text-slate-500">
                  {combo.positions} positions · Capital {combo.totalCapital.toFixed(0)}$ ({combo.capitalPct.toFixed(0)}%) · Rend. moy ~{combo.avgWeeklyReturn.toFixed(2)}%
                </p>
              </div>
              <Badge className="rounded-full border border-slate-300 bg-slate-50 text-slate-700">
                Libre {combo.freeCapital.toFixed(0)}$
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {combo.picks.map((pick) => (
                <div
                  key={`${combo.label}-${pick.ticker}`}
                  className="grid grid-cols-5 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm"
                >
                  <div className="font-semibold text-slate-900">{pick.ticker}</div>
                  <div>PUT {pick.strike}$</div>
                  <div>×{pick.contracts}</div>
                  <div>{pick.capitalUsed.toFixed(0)}$</div>
                  <div>{pick.weeklyReturn.toFixed(2)}%</div>
                </div>
              ))}
            </div>

            <div className="mt-4 text-sm text-slate-600">
              Prime totale estimée :{" "}
              <span className="font-semibold text-slate-900">
                {combo.picks.reduce((sum, p) => sum + p.premiumCollected, 0).toFixed(0)}$
              </span>
              {" "}· Capital du compte :{" "}
              <span className="font-semibold text-slate-900">{capital.toFixed(0)}$</span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const readStoredNumber = (key, fallback) => {
    const raw = window.localStorage.getItem(key);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("strikeDistance");
  const [sortOrder, setSortOrder] = useState("asc");
  const [selectedItem, setSelectedItem] = useState(null);

  const [selectedExpiration, setSelectedExpiration] = useState("2026-04-24");
  const [topN, setTopN] = useState(() => readStoredNumber("wheel.topN", 30));
  const [capital, setCapital] = useState(25500);
  const [maxCapitalPct, setMaxCapitalPct] = useState(() =>
    readStoredNumber("wheel.maxCapitalPct", 100)
  );
  const [maxPositions, setMaxPositions] = useState(() =>
    readStoredNumber("wheel.maxPositions", 30)
  );

  /** null = chargement initial ; tableau (éventuellement vide) = watchlist résolue. */
  const [watchlistTickers, setWatchlistTickers] = useState(null);
  const [watchlistLoading, setWatchlistLoading] = useState(true);
  const [watchlistSource, setWatchlistSource] = useState("loading");
  const [watchlistStats, setWatchlistStats] = useState(null);
  const [watchlistBuildError, setWatchlistBuildError] = useState("");

  const [backendCandidates, setBackendCandidates] = useState(null);
  const [loadingScan, setLoadingScan] = useState(false);
  const [scanError, setScanError] = useState("");
  const [dataSource, setDataSource] = useState("snapshot");
  const [scanMeta, setScanMeta] = useState({
    scanned: 0,
    kept: 0,
    returned: 0,
  });
  const [marketClosedNotice, setMarketClosedNotice] = useState("");

  const snapshotCandidates = useMemo(() => {
    return wheelShortlist
      .slice()
      .map((item, index) => toDashboardCandidate(item, index, selectedExpiration));
  }, [selectedExpiration]);

  const activeCandidates = useMemo(() => {
    const source =
      backendCandidates === null
        ? snapshotCandidates
        : backendCandidates;

    return source.slice(0, topN).map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
  }, [backendCandidates, snapshotCandidates, topN]);

  const filtered = useMemo(() => {
    const filteredItems = activeCandidates.filter((item) => {
      const matchesQuery =
        item.ticker.toLowerCase().includes(query.toLowerCase()) ||
        item.name.toLowerCase().includes(query.toLowerCase());

      const matchesFilter =
        filter === "all"
          ? true
          : filter === "validated"
          ? item.ok
          : item.verdict === filter;

      return matchesQuery && matchesFilter;
    });
    const getSortValue = (item) => {
      if (sortBy === "weeklyReturn") return item.weeklyReturn ?? 0;
      if (sortBy === "spread") {
        const spread = item.safeStrike?.liquidity?.spreadPct ?? item.aggressiveStrike?.liquidity?.spreadPct;
        return spread ?? Number.POSITIVE_INFINITY;
      }
      return item.strikeDistance ?? 0;
    };
    return filteredItems.slice().sort((a, b) => {
      if (sortBy === "spread") {
        const aSpread = a.safeStrike?.liquidity?.spreadPct ?? a.aggressiveStrike?.liquidity?.spreadPct;
        const bSpread = b.safeStrike?.liquidity?.spreadPct ?? b.aggressiveStrike?.liquidity?.spreadPct;
        const aMissing = aSpread == null;
        const bMissing = bSpread == null;
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
      }
      const aValue = getSortValue(a);
      const bValue = getSortValue(b);
      return sortOrder === "asc" ? aValue - bValue : bValue - aValue;
    });
  }, [activeCandidates, query, filter, sortBy, sortOrder]);

  const combos = useMemo(() => {
    return buildPortfolioCombos(filtered, Number(capital), Number(maxCapitalPct), Number(maxPositions));
  }, [filtered, capital, maxCapitalPct, maxPositions]);

  const tickersForScan = watchlistTickers ?? FALLBACK_TICKERS;

  const handleRefreshShortlist = useCallback(async () => {
    console.log("[SCAN_DEBUG] watchlistTickers.length", watchlistTickers?.length ?? null);
    const marketClosed = isUsMarketClosedNow();
    if (marketClosed) {
      try {
        const raw = window.localStorage.getItem(LAST_GOOD_SCAN_KEY);
        const cached = raw ? JSON.parse(raw) : null;
        const cachedShortlist = Array.isArray(cached?.shortlist) ? cached.shortlist : null;
        if (cachedShortlist && cachedShortlist.length > 0) {
          setBackendCandidates(cachedShortlist);
          setDataSource("backend");
          setScanMeta(cached?.scanMeta ?? {
            scanned: cachedShortlist.length,
            kept: cachedShortlist.length,
            returned: cachedShortlist.length,
          });
          setScanError("");
          setMarketClosedNotice("Marche ferme — dernier scan valide affiche");
          return;
        }
      } catch (_e) {}
      setMarketClosedNotice("Marche ferme — dernier scan valide affiche");
      setScanError("Marche ferme et aucun scan valide en cache local.");
      return;
    }
    setMarketClosedNotice("");

    let tickers = watchlistTickers ?? FALLBACK_TICKERS;
    if (Array.isArray(watchlistTickers) && watchlistTickers.length === 0) {
      try {
        const payload = await callBuildWatchlist(DEFAULT_BUILD_WATCHLIST_BODY);
        const rebuilt = Array.isArray(payload.watchlist) ? payload.watchlist : [];
        if (rebuilt.length > 0) {
          setWatchlistTickers(rebuilt);
          setWatchlistSource("backend");
          setWatchlistStats(payload.stats ?? null);
          setWatchlistBuildError("");
          tickers = rebuilt;
        } else {
          console.log("[SCAN_DEBUG] scan_cancelled_reason", "watchlist_empty_after_rebuild");
          setScanError("Watchlist vide après tentative de reconstruction backend.");
          setBackendCandidates(null);
          setDataSource("snapshot");
          setScanMeta({ scanned: 0, kept: 0, returned: 0 });
          return;
        }
      } catch (err) {
        console.log("[SCAN_DEBUG] scan_cancelled_reason", "watchlist_rebuild_failed");
        setScanError("Watchlist vide et reconstruction backend indisponible.");
        setBackendCandidates(null);
        setDataSource("snapshot");
        setScanMeta({ scanned: 0, kept: 0, returned: 0 });
        return;
      }
    }

    if (!Array.isArray(tickers) || tickers.length === 0) {
      console.log("[SCAN_DEBUG] scan_cancelled_reason", "no_tickers_to_scan");
      setScanError("Aucun ticker disponible pour lancer le scan.");
      setBackendCandidates(null);
      setDataSource("snapshot");
      setScanMeta({ scanned: 0, kept: 0, returned: 0 });
      return;
    }
    console.log("[SCAN_DEBUG] tickers_sent_to_scan", tickers.length);

    setLoadingScan(true);
    setScanError("");

    try {
      const payload = await callScanShortlist({
        expiration: selectedExpiration,
        topN,
        tickers,
      });

      const mapped = (payload.shortlist || []).map((item, index) =>
        toDashboardCandidate(item, index, selectedExpiration)
      );

      setBackendCandidates(mapped);
      setDataSource("backend");
      setScanMeta({
        scanned: payload.scanned ?? tickers.length,
        kept: payload.kept ?? mapped.length,
        returned: payload.returned ?? mapped.length,
      });
      if (mapped.length > 0) {
        try {
          window.localStorage.setItem(
            LAST_GOOD_SCAN_KEY,
            JSON.stringify({
              expiration: selectedExpiration,
              scanMeta: {
                scanned: payload.scanned ?? tickers.length,
                kept: payload.kept ?? mapped.length,
                returned: payload.returned ?? mapped.length,
              },
              shortlist: mapped,
              savedAt: new Date().toISOString(),
            })
          );
        } catch (_e) {}
      }
    } catch (e) {
      setScanError(String(e?.message || e || "Erreur lors du refresh shortlist"));
      setBackendCandidates(null);
      setDataSource("snapshot");
      setScanMeta({
        scanned: tickers.length,
        kept: 0,
        returned: 0,
      });
    } finally {
      setLoadingScan(false);
    }
  }, [watchlistTickers, selectedExpiration, topN]);

  const handleRebuildWatchlist = useCallback(async () => {
    setWatchlistLoading(true);
    setWatchlistBuildError("");
    try {
      const payload = await callBuildWatchlist(DEFAULT_BUILD_WATCHLIST_BODY);
      setWatchlistTickers(Array.isArray(payload.watchlist) ? payload.watchlist : []);
      setWatchlistSource("backend");
      setWatchlistStats(payload.stats ?? null);
    } catch (err) {
      setWatchlistTickers(FALLBACK_TICKERS);
      setWatchlistSource("fallback");
      setWatchlistStats(null);
      setWatchlistBuildError(String(err?.message || err || "universe/build indisponible"));
    } finally {
      setWatchlistLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadWatchlist() {
      setWatchlistLoading(true);
      setWatchlistBuildError("");
      try {
        const payload = await callBuildWatchlist(DEFAULT_BUILD_WATCHLIST_BODY);
        if (cancelled) return;
        setWatchlistTickers(Array.isArray(payload.watchlist) ? payload.watchlist : []);
        setWatchlistSource("backend");
        setWatchlistStats(payload.stats ?? null);
      } catch (err) {
        if (cancelled) return;
        setWatchlistTickers(FALLBACK_TICKERS);
        setWatchlistSource("fallback");
        setWatchlistStats(null);
        setWatchlistBuildError(String(err?.message || err || "universe/build indisponible"));
      } finally {
        if (!cancelled) {
          setWatchlistLoading(false);
        }
      }
    }

    loadWatchlist();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (watchlistLoading) return;
    handleRefreshShortlist();
  }, [watchlistLoading, selectedExpiration, topN, handleRefreshShortlist]);

  useEffect(() => {
    window.localStorage.setItem("wheel.topN", String(topN));
  }, [topN]);

  useEffect(() => {
    window.localStorage.setItem("wheel.maxCapitalPct", String(maxCapitalPct));
  }, [maxCapitalPct]);

  useEffect(() => {
    window.localStorage.setItem("wheel.maxPositions", String(maxPositions));
  }, [maxPositions]);

  const stats = useMemo(
    () => [
      {
        title: "Watchlist",
        value:
          watchlistTickers === null
            ? "…"
            : String(watchlistTickers.length),
        sub:
          watchlistSource === "backend"
            ? watchlistStats
              ? `${watchlistStats.keptCount ?? watchlistTickers?.length ?? 0} tickers (backend)`
              : "tickers backend"
            : watchlistSource === "fallback"
            ? `secours (${FALLBACK_TICKERS.length} statiques)`
            : "chargement…",
        icon: Search,
      },
      {
        title: "Shortlist",
        value: String(filtered.length),
        sub: dataSource === "backend" ? `${scanMeta.kept} retenus backend` : "snapshot local",
        icon: ShieldCheck,
      },
      {
        title: "Expiration",
        value: selectedExpiration,
        sub: "scan backend",
        icon: CalendarDays,
      },
      {
        title: "Objectif",
        value: "0.5%",
        sub: "prime mini par semaine",
        icon: Target,
      },
    ],
    [filtered.length, selectedExpiration, dataSource, scanMeta, watchlistTickers, watchlistSource, watchlistStats]
  );

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto max-w-7xl p-4 md:p-6 lg:p-8">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                <Layers3 className="h-3.5 w-3.5" />
                Wheel Strategy Dashboard — backend shortlist + modal live
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Dashboard options lisible, premium et actionnable
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
                La watchlist est construite via /universe/build ; le bouton Refresh shortlist interroge /scan_shortlist avec cette liste. Le modal reste live pour lecture détaillée.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:w-[640px]">
              {stats.map((item) => (
                <StatCard key={item.title} item={item} />
              ))}
            </div>
          </div>
        </motion.div>

        <div className="mb-6 grid gap-4 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-2 xl:grid-cols-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Expiration</label>
            <Select
              value={selectedExpiration}
              onChange={(e) => setSelectedExpiration(e.target.value)}
              className="w-full rounded-xl border-slate-200"
            >
              {DEFAULT_EXPIRATIONS.map((exp) => (
                <option key={exp} value={exp}>
                  {exp}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Top candidats</label>
            <Input
              type="number"
              min="1"
              max="50"
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value || 1))}
              className="w-full rounded-xl border-slate-200"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Capital compte</label>
            <Input
              type="number"
              min="1000"
              step="100"
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value || 0))}
              className="w-full rounded-xl border-slate-200"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">% max utilisé</label>
            <Input
              type="number"
              min="10"
              max="100"
              value={maxCapitalPct}
              onChange={(e) => setMaxCapitalPct(Number(e.target.value || 0))}
              className="w-full rounded-xl border-slate-200"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Nb max positions</label>
            <Input
              type="number"
              min="1"
              max="10"
              value={maxPositions}
              onChange={(e) => setMaxPositions(Number(e.target.value || 1))}
              className="w-full rounded-xl border-slate-200"
            />
          </div>

          <div className="flex flex-col gap-2 justify-end">
            <Button
              className="w-full rounded-xl"
              onClick={handleRefreshShortlist}
              disabled={loadingScan || watchlistLoading}
            >
              Refresh shortlist <RefreshCw className="ml-2 h-4 w-4" />
            </Button>
            <Button
              className="w-full rounded-xl"
              variant="outline"
              onClick={handleRebuildWatchlist}
              disabled={loadingScan || watchlistLoading}
            >
              Rebuild watchlist <Database className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>

        {watchlistBuildError && watchlistSource === "fallback" && (
          <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">
            Watchlist : secours liste statique ({FALLBACK_TICKERS.length} tickers). Raison : {watchlistBuildError}
          </div>
        )}

        {(watchlistLoading || loadingScan) && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-sm text-slate-700">
              <span>{watchlistLoading ? "Construction watchlist (/universe/build)…" : "Scan backend en cours…"}</span>
              <span>
                {watchlistLoading
                  ? "…"
                  : `${tickersForScan.length} tickers envoyés`}
              </span>
            </div>
            <div className="mt-3">
              <Progress value={watchlistLoading ? 40 : 65} />
            </div>
          </div>
        )}

        {!loadingScan && !watchlistLoading && (
          <div
            className={cn(
              "mb-6 rounded-2xl border p-4 text-sm shadow-sm",
              marketClosedNotice
                ? "border-amber-200 bg-amber-50 text-amber-700"
                : dataSource === "backend"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            )}
          >
            {marketClosedNotice
              ? "Marche ferme — dernier scan valide affiche"
              : dataSource === "backend"
              ? `Source active : backend local /scan_shortlist — ${scanMeta.kept} retenus sur ${scanMeta.scanned} scannés (watchlist ${watchlistSource === "backend" ? "backend" : "secours"}).`
              : "Source active : snapshot local (fallback)."}
          </div>
        )}

        {scanError && (
          <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 shadow-sm">
            {scanError}
          </div>
        )}

        <div className="space-y-6">
          <div className="space-y-6">
            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <CardTitle className="text-xl text-slate-900">Shortlist hebdomadaire</CardTitle>
                    <p className="mt-1 text-sm text-slate-500">
                      {dataSource === "backend"
                        ? "Shortlist chargée automatiquement depuis le backend local /scan_shortlist."
                        : "Snapshot local affiché en fallback tant que le backend n’a pas répondu."}
                    </p>
                  </div>

                  <div className="flex w-full flex-col gap-3 sm:flex-row lg:w-auto">
                    <div className="relative min-w-[240px]">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Ticker ou nom..."
                        className="rounded-xl border-slate-200 pl-9"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {[
                        ["all", "Tous"],
                        ["validated", "Validés"],
                        ["conservative", "Safe"],
                        ["balanced", "Balanced"],
                        ["aggressive", "Aggressive"],
                      ].map(([value, label]) => (
                        <Button
                          key={value}
                          variant={filter === value ? "default" : "outline"}
                          className="rounded-xl"
                          onClick={() => setFilter(value)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                    <Select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="rounded-xl border-slate-200"
                    >
                      <option value="strikeDistance">Trier par: distance strike</option>
                      <option value="weeklyReturn">Trier par: rendement hebdo</option>
                      <option value="spread">Trier par: spread</option>
                    </Select>
                    <Select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value)}
                      className="rounded-xl border-slate-200"
                    >
                      <option value="asc">Ordre: asc</option>
                      <option value="desc">Ordre: desc</option>
                    </Select>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {filtered.map((item) => (
                  <CandidateCard
                    key={`${item.ticker}-${item.setup}`}
                    item={item}
                    onOpenDetail={setSelectedItem}
                  />
                ))}

                {filtered.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
                    Aucun résultat avec ce filtre.
                  </div>
                )}
              </CardContent>
            </Card>

            <PortfolioCombos combos={combos} capital={Number(capital)} />
          </div>

          <div className="space-y-6">
            <AlertPanel />

            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
                  <Activity className="h-5 w-5" />
                  Résumé semaine
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-600">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="font-medium text-slate-900">Lecture rapide</p>
                  <p className="mt-2 leading-6">
                    Le scan principal est calculé côté backend sur la watchlist chargée. Le frontend ne fait pas le scan ticker par ticker.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Source active</span>
                    <span className="font-semibold text-slate-900">
                      {dataSource === "backend" ? "backend local" : "snapshot"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Candidats affichés</span>
                    <span className="font-semibold text-slate-900">{filtered.length}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Scannés backend</span>
                    <span className="font-semibold text-slate-900">{scanMeta.scanned}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Retenus backend</span>
                    <span className="font-semibold text-slate-900">{scanMeta.kept}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Capital compte</span>
                    <span className="font-semibold text-slate-900">${Number(capital).toFixed(0)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
    </div>
  );
}
