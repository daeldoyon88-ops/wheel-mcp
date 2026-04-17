import React, { useMemo, useState, useEffect } from "react";
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
} from "lucide-react";
import { wheelShortlist } from "./data/wheelShortlist";

const API_BASE = "https://wheel-mcp.onrender.com";
const WEEKLY_TARGET_PCT = 0.5;
const ANNUAL_FACTOR = 52;
const SAFE_STRIKE_FLOOR_RATIO = 0.85;

const DEFAULT_EXPIRATIONS = [
  "2026-04-24",
  "2026-05-01",
  "2026-05-08",
  "2026-05-15",
  "2026-05-22",
];

const SOURCE_TICKERS = [
  "CF", "SNOW", "KO", "SLB", "TSCO", "PCG", "DOCU", "PATH", "F", "WBD",
  "BITX", "SOFI", "ABT", "SCHW", "CSX", "NDAQ", "BAC", "CVS", "GM", "HIMS",
  "UBER", "TGT", "AFRM", "SBUX", "NFLX", "TQQQ", "EXPE", "SHOP", "AAPL", "SOXL",
  "AMZN", "AMD", "ORCL", "PLTR", "NVDA", "MSFT", "GOOGL", "MU", "AVGO", "TSM",
  "MRVL", "IBKR", "DUOL", "RYAAY", "NEM", "DELL", "KMI", "HOOD", "LVS", "TW",
  "NI", "FSLR", "INCY", "NBIX", "ROOT", "VST", "TECK", "ZM", "PYPL", "DECK",
  "NVO", "PHM", "DXCM", "USB", "PDD"
];

const EARNINGS_SYMBOLS = new Set(["NFLX"]);

const alerts = [
  {
    type: "earnings",
    title: "Règle earnings",
    body: "Les dossiers earnings gardent la logique expected move x2 pour la sélection de la borne basse.",
  },
  {
    type: "rule",
    title: "Dashboard mixte",
    body: "Le dashboard principal utilise une shortlist snapshot au chargement. Le bouton Refresh lance un vrai scan live.",
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

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

function weeklyYieldPct(mid, strike) {
  if (!mid || !strike || strike <= 0) return 0;
  return (mid / strike) * 100;
}

function annualizedYieldPct(weeklyPct) {
  return weeklyPct * ANNUAL_FACTOR;
}

function strikeDistancePct(strike, spot) {
  if (!strike || !spot || spot <= 0) return 0;
  return ((strike - spot) / spot) * 100;
}

function getDteDays(expiration) {
  const now = new Date();
  const exp = new Date(`${expiration}T00:00:00`);
  const diff = exp - now;
  return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)));
}

function minPremiumForSpot(spot) {
  if (!spot || spot <= 0) return 0;
  return spot * (WEEKLY_TARGET_PCT / 100);
}

function toNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pickReliablePremium(row) {
  const midField = toNumber(row?.mid);
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  const lastPrice = toNumber(row?.lastPrice);

  const hasBid = bid > 0;
  const hasAsk = ask > 0;
  const bidAskMid = hasBid && hasAsk ? (bid + ask) / 2 : 0;

  if (hasBid && hasAsk) {
    if (midField > 0) {
      const spread = Math.abs(midField - bidAskMid);
      const tolerance = Math.max(0.03, bidAskMid * 0.35);
      if (spread <= tolerance) return midField;
    }
    return bidAskMid;
  }

  if (midField > 0 && !hasBid && !hasAsk) {
    return midField;
  }

  if (midField > 0 && hasAsk && !hasBid) {
    if (midField <= ask * 1.15) return midField;
  }

  if (midField > 0 && hasBid && !hasAsk) {
    if (midField >= bid * 0.85) return midField;
  }

  if (lastPrice > 0) return lastPrice;
  if (midField > 0) return midField;
  if (hasBid) return bid;
  if (hasAsk) return ask;

  return 0;
}

function normalizePutForSelection(put, spot, targetPremium) {
  const strike = toNumber(put?.strike);
  const premium = pickReliablePremium(put);

  const weeklyPct = weeklyYieldPct(premium, strike);
  const annualPct = annualizedYieldPct(weeklyPct);
  const distancePct = strikeDistancePct(strike, spot);

  return {
    strike,
    mid: premium,
    bid: toNumber(put?.bid),
    ask: toNumber(put?.ask),
    lastPrice: toNumber(put?.lastPrice),
    openInterest: toNumber(put?.openInterest),
    volume: toNumber(put?.volume),
    impliedVolatility: toNumber(put?.impliedVolatility),
    weeklyYield: weeklyPct,
    annualizedYield: annualPct,
    distancePct,
    targetPremium,
    qualifiesTarget: premium >= targetPremium,
    distanceToTarget: Math.abs(premium - targetPremium),
  };
}

function selectPutStrikes({ puts, spot, lowerBoundForSelection }) {
  const targetPremium = minPremiumForSpot(spot);

  const eligible = (puts || [])
    .map((put) => normalizePutForSelection(put, spot, targetPremium))
    .filter((put) => put.strike > 0)
    .filter((put) => put.strike < lowerBoundForSelection)
    .filter((put) => put.mid > 0)
    .sort((a, b) => a.strike - b.strike);

  const aggressiveStrike =
    eligible.length > 0
      ? [...eligible].sort((a, b) => b.strike - a.strike)[0]
      : null;

  const safeStrikeFloor = lowerBoundForSelection * SAFE_STRIKE_FLOOR_RATIO;

  const safeZone = eligible.filter((put) => put.strike >= safeStrikeFloor);

  const safeCandidates = safeZone
    .filter((put) => put.mid >= targetPremium)
    .sort((a, b) => {
      const diff = a.distanceToTarget - b.distanceToTarget;
      if (diff !== 0) return diff;
      return b.strike - a.strike;
    });

  const safeStrike = safeCandidates.length > 0 ? safeCandidates[0] : null;

  return {
    eligible,
    safeZone,
    safeCandidates,
    targetPremium,
    safeStrike,
    aggressiveStrike,
    maxPremiumStrike: aggressiveStrike,
    safeStrikeFloor,
  };
}

function pickTargetExpiration(availableExpirations, targetExpiration) {
  if (!Array.isArray(availableExpirations) || availableExpirations.length === 0) return null;
  if (targetExpiration && availableExpirations.includes(targetExpiration)) return targetExpiration;
  return availableExpirations[0] || null;
}

function toDashboardCandidate(item, index, selectedExpiration) {
  const safe = item.safeStrike;
  const aggressive = item.maxPremiumStrike;
  const primaryStrike = safe || aggressive;

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
    expectedMoveLow: item.lowerBound ?? 0,
    expectedMoveHigh:
      item.currentPrice != null && item.adjustedMove != null
        ? item.currentPrice + item.adjustedMove
        : 0,
    minPremium: item.targetPremium ?? (item.currentPrice ? item.currentPrice * 0.005 : 0),
    safeStrike: safe
      ? {
          strike: safe.strike,
          mid: safe.premium,
          weeklyYield: (safe.weeklyYield ?? 0) * 100,
          annualizedYield: (safe.annualizedYield ?? 0) * 100,
          label: "prime la plus proche de la cible",
        }
      : null,
    maxPremiumStrike: aggressive
      ? {
          strike: aggressive.strike,
          mid: aggressive.premium,
          weeklyYield: (aggressive.weeklyYield ?? 0) * 100,
          annualizedYield: (aggressive.annualizedYield ?? 0) * 100,
          label: "directement sous borne basse",
        }
      : null,
    premium:
      safe && aggressive
        ? `${safe.premium?.toFixed(2) ?? "—"} / ${aggressive.premium?.toFixed(2) ?? "—"}`
        : primaryStrike
        ? `${primaryStrike.premium?.toFixed(2) ?? "—"}`
        : "—",
    weeklyReturn: primaryStrike ? (primaryStrike.weeklyYield ?? 0) * 100 : 0,
    strikeDistance: primaryStrike ? -((primaryStrike.distancePct ?? 0) * 100) : 0,
    capitalPerContract: primaryStrike ? primaryStrike.strike * 100 : 0,
    premiumPerContract: primaryStrike ? primaryStrike.premium * 100 : 0,
    earnings: item.hasEarnings ? "earnings mode actif" : "pas cette semaine",
    iv: 0,
    rsi: 0,
    macd: "—",
    zone: "sous borne basse",
    verdict: item.hasEarnings ? "balanced" : "conservative",
    ok: !!item.passesFilter,
    note: item.hasEarnings
      ? "Cas earnings conservé avec expected move x2 et détail live dans la fiche complète."
      : "Candidat issu du scanner, prêt à afficher dans le dashboard.",
    raw: item,
  };
}

function buildPortfolioCombos(candidates, capital, maxCapitalPct, maxPositions) {
  const usableCapital = capital * (maxCapitalPct / 100);
  const top = candidates
    .filter((c) => c.capitalPerContract > 0 && c.weeklyReturn > 0)
    .sort((a, b) => b.weeklyReturn - a.weeklyReturn);

  if (!top.length) return [];

  const aggressivePool = [...top]
    .sort((a, b) => b.weeklyReturn - a.weeklyReturn)
    .slice(0, Math.max(3, maxPositions + 1));

  const balancedPool = [...top]
    .sort((a, b) => {
      const scoreA = a.weeklyReturn - Math.max(0, Math.abs(a.strikeDistance) - 12) * 0.02;
      const scoreB = b.weeklyReturn - Math.max(0, Math.abs(b.strikeDistance) - 12) * 0.02;
      return scoreB - scoreA;
    })
    .slice(0, Math.max(3, maxPositions + 1));

  const conservativePool = [...top]
    .sort((a, b) => Math.abs(b.strikeDistance) - Math.abs(a.strikeDistance))
    .slice(0, Math.max(3, maxPositions + 1));

  function makeCombo(label, pool) {
    const picks = [];
    let used = 0;

    for (const candidate of pool) {
      if (picks.length >= maxPositions) break;
      if (candidate.capitalPerContract <= 0) continue;

      const remaining = usableCapital - used;
      if (remaining < candidate.capitalPerContract) continue;

      const maxContracts = Math.max(1, Math.floor(remaining / candidate.capitalPerContract));
      const contracts = Math.min(
        maxContracts,
        candidate.capitalPerContract < usableCapital * 0.2 ? 3 : 1
      );

      const capitalUsed = contracts * candidate.capitalPerContract;
      const premiumCollected = contracts * candidate.premiumPerContract;

      picks.push({
        ticker: candidate.ticker,
        strike: candidate.safeStrike?.strike ?? candidate.maxPremiumStrike?.strike ?? 0,
        contracts,
        capitalUsed,
        premiumCollected,
        weeklyReturn: candidate.weeklyReturn,
      });

      used += capitalUsed;
    }

    if (!picks.length) return null;

    const avgWeekly =
      picks.reduce((sum, p) => sum + p.weeklyReturn * p.capitalUsed, 0) /
      picks.reduce((sum, p) => sum + p.capitalUsed, 0);

    return {
      label,
      positions: picks.length,
      totalCapital: used,
      capitalPct: capital > 0 ? (used / capital) * 100 : 0,
      avgWeeklyReturn: avgWeekly,
      freeCapital: capital - used,
      picks,
    };
  }

  return [
    makeCombo("Agressif", aggressivePool),
    makeCombo("Équilibré", balancedPool),
    makeCombo("Conservateur", conservativePool),
  ].filter(Boolean);
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
  return <select {...props} className={cn("border bg-white px-3 py-2 outline-none", className)}>{children}</select>;
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
  title,
  subtitle,
  strike,
  mid,
  weeklyYield,
  annualizedYield,
  distancePct,
  label,
  meetsTarget,
}) {
  const distanceTone = distancePct <= -10 ? "good" : distancePct <= -5 ? "warn" : "bad";
  const yieldTone = weeklyYield >= 1 ? "good" : weeklyYield >= 0.5 ? "warn" : "bad";
  const midTone = mid >= 0.2 ? "good" : mid >= 0.09 ? "warn" : "bad";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
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
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Strike" value={`$${strike.toFixed(2)}`} strong />
        <Metric label="Mid" value={`$${mid.toFixed(2)}`} strong={mid >= 0.09} tone={midTone} />
        <Metric label="Distance" value={`${distancePct.toFixed(1)}%`} strong tone={distanceTone} />
        <Metric label="Hebdo" value={`${weeklyYield.toFixed(2)}%`} strong tone={yieldTone} />
        <Metric label="Annualisé" value={`${annualizedYield.toFixed(1)}%`} tone={yieldTone} />
      </div>
    </div>
  );
}

function StrikeOpportunities({ item }) {
  const adjustedMovePct = item.earningsMode
    ? item.expectedMovePct * (item.expectedMoveMultiplier || 1)
    : item.expectedMovePct;

  const hasSafe = !!item.safeStrike;
  const hasAggressive = !!item.maxPremiumStrike;

  const safeDistance =
    hasSafe && item.price > 0 ? ((item.safeStrike.strike - item.price) / item.price) * 100 : 0;

  const aggressiveDistance =
    hasAggressive && item.price > 0 ? ((item.maxPremiumStrike.strike - item.price) / item.price) * 100 : 0;

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
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {hasSafe && (
            <StrikeCard
              title="Strike safe"
              subtitle="prime la plus proche de la cible minimale"
              strike={item.safeStrike.strike}
              mid={item.safeStrike.mid}
              weeklyYield={item.safeStrike.weeklyYield}
              annualizedYield={item.safeStrike.annualizedYield}
              distancePct={safeDistance}
              label={item.safeStrike.label}
              meetsTarget={item.safeStrike.mid >= item.minPremium}
            />
          )}

          {hasAggressive && (
            <StrikeCard
              title="Strike agressif"
              subtitle="directement sous la borne basse"
              strike={item.maxPremiumStrike.strike}
              mid={item.maxPremiumStrike.mid}
              weeklyYield={item.maxPremiumStrike.weeklyYield}
              annualizedYield={item.maxPremiumStrike.annualizedYield}
              distancePct={aggressiveDistance}
              label={item.maxPremiumStrike.label}
              meetsTarget={item.maxPremiumStrike.mid >= item.minPremium}
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

function CandidateCard({ item, onOpenDetail }) {
  const adjustedMovePct = item.earningsMode
    ? item.expectedMovePct * (item.expectedMoveMultiplier || 1)
    : item.expectedMovePct;

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="border-slate-200 shadow-sm transition-all hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
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
                <Metric
                  label="Rendement"
                  value={`${item.weeklyReturn.toFixed(2)}% / sem`}
                  strong={item.weeklyReturn >= 0.5}
                  tone={item.weeklyReturn >= 0.5 ? "good" : "bad"}
                />
                <Metric label="Distance strike" value={`${item.strikeDistance.toFixed(1)}%`} />
                <Metric label="Capital / contrat" value={`$${item.capitalPerContract.toFixed(0)}`} />
                <Metric label="IV" value={`${item.iv.toFixed(1)}%`} />
                <Metric label="RSI" value={`${item.rsi}`} />
              </div>

              <StrikeOpportunities item={item} />
            </div>

            <div className="min-w-[240px] max-w-[280px] rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">Risque</span>
                <span className="text-sm capitalize text-slate-500">{item.verdict}</span>
              </div>
              <div className="mt-3">
                <Progress value={riskToProgress[item.verdict]} />
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-600">{item.note}</p>
              <Button className="mt-4 w-full rounded-xl" onClick={() => onOpenDetail(item)}>
                Voir la fiche complète <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
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

async function scanTickerLive(symbol, expiration) {
  const expirations = await callTool("get_option_expirations", { symbol });

  const availableExpirations =
    expirations?.availableExpirations ||
    expirations?.expirationDates ||
    expirations?.expirations ||
    [];

  if (!availableExpirations.includes(expiration)) {
    return null;
  }

  const [quote, expectedMove, optionChain] = await Promise.all([
    callTool("get_quote", { symbol }),
    callTool("get_expected_move", { symbol, expiration }),
    callTool("get_option_chain", { symbol, expiration }),
  ]);

  const price =
    quote?.regularMarketPrice ??
    quote?.currentPrice ??
    optionChain?.currentPrice ??
    expectedMove?.currentPrice ??
    0;

  const expectedMoveAbs = Number(expectedMove?.expectedMove ?? 0);
  const hasEarnings = EARNINGS_SYMBOLS.has(symbol);
  const adjustedMove = hasEarnings ? expectedMoveAbs * 2 : expectedMoveAbs;
  const lowerBound = price - adjustedMove;

  const dteDays = getDteDays(expiration);
  const puts = Array.isArray(optionChain?.puts) ? optionChain.puts : [];

  const strikeSelection =
    puts.length > 0 && lowerBound > 0 && price > 0
      ? selectPutStrikes({
          puts,
          spot: price,
          lowerBoundForSelection: lowerBound,
        })
      : {
          eligible: [],
          safeZone: [],
          safeCandidates: [],
          targetPremium: minPremiumForSpot(price),
          safeStrike: null,
          aggressiveStrike: null,
          maxPremiumStrike: null,
          safeStrikeFloor: 0,
        };

  const safe = strikeSelection.safeStrike;
  const aggressive = strikeSelection.aggressiveStrike;
  const targetPremium = strikeSelection.targetPremium ?? minPremiumForSpot(price);

  function normalizeStrike(strikeRow) {
    if (!strikeRow) return null;
    const premium = Number(strikeRow.mid ?? 0);
    const weekly = premium > 0 && strikeRow.strike > 0
      ? (premium / strikeRow.strike) * (7 / dteDays)
      : 0;

    return {
      symbol,
      strike: strikeRow.strike,
      premium: round(premium, 3),
      distancePct: round(Math.abs(strikeRow.distancePct) / 100, 4),
      weeklyYield: round(weekly, 4),
      annualizedYield: round(weekly * 52, 4),
      lowerBound: round(lowerBound, 3),
      distanceToTarget: round(Math.abs(premium - targetPremium), 4),
    };
  }

  const normalizedSafe = normalizeStrike(safe);
  const normalizedAggressive = normalizeStrike(aggressive);

  const passesFilter =
    !!normalizedSafe &&
    (normalizedSafe.premium ?? 0) >= targetPremium &&
    (normalizedSafe.annualizedYield ?? 0) >= 0.26;

  return {
    symbol,
    expiration,
    hasEarnings,
    currentPrice: round(price, 3),
    expectedMove: round(expectedMoveAbs, 3),
    adjustedMove: round(adjustedMove, 3),
    lowerBound: round(lowerBound, 3),
    dteDays,
    targetPremium: round(targetPremium, 3),
    safeStrike: normalizedSafe,
    maxPremiumStrike: normalizedAggressive,
    passesFilter,
  };
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

        if (!cancelled) {
          setLiveData({
            quote,
            expirations,
            firstExpiration: selectedExpiration,
            expectedMove,
            optionChain,
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

  const adjustedMovePct = item.earningsMode
    ? liveExpectedMovePct * (item.expectedMoveMultiplier || 1)
    : liveExpectedMovePct;

  const lowerBoundForSelection =
    item.earningsMode && livePrice > 0
      ? livePrice * (1 - adjustedMovePct / 100)
      : liveLow;

  const normalizedPuts = Array.isArray(liveData?.optionChain?.puts) ? liveData.optionChain.puts : [];
  const strikeSelection =
    normalizedPuts.length > 0 && lowerBoundForSelection > 0 && livePrice > 0
      ? selectPutStrikes({
          puts: normalizedPuts,
          spot: livePrice,
          lowerBoundForSelection,
        })
      : {
          eligible: [],
          safeZone: [],
          safeCandidates: [],
          targetPremium: minPremiumForSpot(livePrice),
          safeStrike: null,
          aggressiveStrike: null,
          maxPremiumStrike: null,
          safeStrikeFloor: 0,
        };

  const safeStrike = strikeSelection.safeStrike;
  const aggressiveStrike = strikeSelection.aggressiveStrike;
  const displayedLowForSelection = lowerBoundForSelection > 0 ? lowerBoundForSelection : liveLow;
  const minPremiumHint = strikeSelection.targetPremium ?? minPremiumForSpot(livePrice);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4">
      <div className="mx-auto flex h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              {item.ticker} — {item.name}
            </h2>
            <p className="mt-1 text-sm text-slate-500">{item.setup}</p>
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
            <Metric label="Prime cible safe" value={`$${Number(minPremiumHint || 0).toFixed(2)}`} />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Résumé</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">{item.note}</p>
            <p className="mt-2 text-sm text-slate-600">
              Borne basse utilisée :{" "}
              <span className="font-semibold text-rose-700">
                ${Number(displayedLowForSelection || 0).toFixed(2)}
              </span>
              {" "}· cible safe :{" "}
              <span className="font-semibold">${Number(minPremiumHint || 0).toFixed(2)}</span>
              {" "}· zone safe mini strike :{" "}
              <span className="font-semibold">${Number(strikeSelection.safeStrikeFloor || 0).toFixed(2)}</span>
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {safeStrike ? (
              <StrikeCard
                title="Strike safe live"
                subtitle="prime la plus proche de la cible minimale"
                strike={safeStrike.strike}
                mid={safeStrike.mid}
                weeklyYield={safeStrike.weeklyYield}
                annualizedYield={safeStrike.annualizedYield}
                distancePct={safeStrike.distancePct}
                label="safe strike"
                meetsTarget={safeStrike.mid >= minPremiumHint}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                Aucun strike safe live ne paie la prime minimale cible dans la zone proche de la borne basse.
              </div>
            )}

            {aggressiveStrike ? (
              <StrikeCard
                title="Strike agressif live"
                subtitle="directement sous la borne basse"
                strike={aggressiveStrike.strike}
                mid={aggressiveStrike.mid}
                weeklyYield={aggressiveStrike.weeklyYield}
                annualizedYield={aggressiveStrike.annualizedYield}
                distancePct={aggressiveStrike.distancePct}
                label="aggressive strike"
                meetsTarget={aggressiveStrike.mid >= minPremiumHint}
              />
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                Aucun strike agressif live disponible.
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedItem, setSelectedItem] = useState(null);

  const [selectedExpiration, setSelectedExpiration] = useState("2026-04-24");
  const [topN, setTopN] = useState(10);
  const [capital, setCapital] = useState(25500);
  const [maxCapitalPct, setMaxCapitalPct] = useState(70);
  const [maxPositions, setMaxPositions] = useState(3);

  const [liveShortlist, setLiveShortlist] = useState(null);
  const [loadingScan, setLoadingScan] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanProgress, setScanProgress] = useState({ done: 0, total: SOURCE_TICKERS.length });

  const snapshotCandidates = useMemo(() => {
    return wheelShortlist
      .slice()
      .sort((a, b) => {
        const aYield = a?.safeStrike?.annualizedYield ?? 0;
        const bYield = b?.safeStrike?.annualizedYield ?? 0;
        return bYield - aYield;
      })
      .map((item, index) => toDashboardCandidate(item, index, selectedExpiration));
  }, [selectedExpiration]);

  const activeCandidates = useMemo(() => {
    const source = Array.isArray(liveShortlist) && liveShortlist.length > 0
      ? liveShortlist
      : snapshotCandidates;

    return source.slice(0, topN).map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
  }, [liveShortlist, snapshotCandidates, topN]);

  const filtered = useMemo(() => {
    return activeCandidates.filter((item) => {
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
  }, [activeCandidates, query, filter]);

  const combos = useMemo(() => {
    return buildPortfolioCombos(filtered, Number(capital), Number(maxCapitalPct), Number(maxPositions));
  }, [filtered, capital, maxCapitalPct, maxPositions]);

  const stats = useMemo(
    () => [
      { title: "Watchlist", value: String(SOURCE_TICKERS.length), sub: "tickers source", icon: Search },
      { title: "Shortlist", value: String(filtered.length), sub: `top ${topN} affichés`, icon: ShieldCheck },
      { title: "Expiration", value: selectedExpiration, sub: "sélection UI", icon: CalendarDays },
      { title: "Objectif", value: "0.5%", sub: "prime mini sur spot", icon: Target },
    ],
    [filtered.length, selectedExpiration, topN]
  );

  async function handleRefreshShortlist() {
    setLoadingScan(true);
    setScanError("");
    setScanProgress({ done: 0, total: SOURCE_TICKERS.length });

    const next = [];

    try {
      for (let i = 0; i < SOURCE_TICKERS.length; i += 1) {
        const symbol = SOURCE_TICKERS[i];

        try {
          const scanned = await scanTickerLive(symbol, selectedExpiration);
          if (scanned && scanned.passesFilter) {
            next.push(scanned);
          }
        } catch (e) {
          // ignore individuel
        }

        setScanProgress({ done: i + 1, total: SOURCE_TICKERS.length });
      }

      next.sort((a, b) => {
        const aYield = a?.safeStrike?.annualizedYield ?? 0;
        const bYield = b?.safeStrike?.annualizedYield ?? 0;
        return bYield - aYield;
      });

      const mapped = next.map((item, index) => toDashboardCandidate(item, index, selectedExpiration));
      setLiveShortlist(mapped);
    } catch (e) {
      setScanError(String(e?.message || e || "Erreur lors du refresh shortlist"));
    } finally {
      setLoadingScan(false);
    }
  }

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
                Wheel Strategy Dashboard — snapshot + live refresh
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Dashboard options lisible, premium et actionnable
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
                Safe = prime la plus proche de spot × 0.5% dans une zone proche de la borne basse. Agressif = strike directement sous la borne basse.
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

          <div className="flex items-end">
            <Button
              className="w-full rounded-xl"
              onClick={handleRefreshShortlist}
              disabled={loadingScan}
            >
              Refresh shortlist <RefreshCw className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>

        {loadingScan && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-sm text-slate-700">
              <span>Scan live en cours...</span>
              <span>{scanProgress.done} / {scanProgress.total}</span>
            </div>
            <div className="mt-3">
              <Progress value={(scanProgress.done / Math.max(1, scanProgress.total)) * 100} />
            </div>
          </div>
        )}

        {scanError && (
          <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 shadow-sm">
            {scanError}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <div className="space-y-6">
            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <CardTitle className="text-xl text-slate-900">Shortlist hebdomadaire</CardTitle>
                    <p className="mt-1 text-sm text-slate-500">
                      Snapshot au chargement. Après refresh, shortlist live recalculée sur {SOURCE_TICKERS.length} tickers source.
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
                    Le strike safe est maintenant filtré dans une zone proche de la borne basse pour éviter les strikes absurdes trop éloignés.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Candidats affichés</span>
                    <span className="font-semibold text-slate-900">{filtered.length}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Tickers source</span>
                    <span className="font-semibold text-slate-900">{SOURCE_TICKERS.length}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Capital compte</span>
                    <span className="font-semibold text-slate-900">${Number(capital).toFixed(0)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
                  <BarChart3 className="h-5 w-5" />
                  Priorité UX proposée
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-600">
                <div className="flex gap-3 rounded-2xl border border-slate-200 p-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                    1
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">Top N réel</p>
                    <p className="mt-1 leading-6 text-slate-600">
                      Après refresh, le top 10 ou top 15 fonctionne sur la vraie shortlist live recalculée.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 rounded-2xl border border-slate-200 p-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                    2
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">Combinaisons capital</p>
                    <p className="mt-1 leading-6 text-slate-600">
                      Les paniers se recalculent automatiquement sur la shortlist active.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 rounded-2xl border border-slate-200 p-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                    3
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">Filtre pratique</p>
                    <p className="mt-1 leading-6 text-slate-600">
                      Le strike safe est cherché près de la borne basse pour éviter les quotes lointaines peu utiles.
                    </p>
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