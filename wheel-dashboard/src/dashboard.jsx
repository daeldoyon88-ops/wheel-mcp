import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
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
  minPrice: 10,
  minVolume: 1_000_000,
  maxContractCapital: 25_500,
  minMarketCapB: 5,
  requireLiquidOptions: false,
  requireWeeklyOptions: true,
  categories: ["weekly", "core", "growth"],
  // Temporary Yahoo protection: scan first 100 symbols only
  limit: 100,
};
const LAST_GOOD_SCAN_KEY = "wheel.lastGoodScan.v1";
const AUTO_REFRESH_SHORTLIST_ON_LOAD = false;

const alerts = [
  {
    type: "earnings",
    title: "Règle earnings",
    body: "Les dossiers earnings gardent la logique expected move x2 pour la sélection de la borne basse.",
  },
  {
    type: "rule",
    title: "Watchlist backend",
    body: "Le compteur Watchlist et le scan utilisent /universe/build avec la liste weekly TradingView quand le backend répond ; la liste statique sert de secours.",
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
const IBKR_AUTO_PRIORITY_SYMBOLS = new Set([
  "TQQQ", "SOXL", "INTC", "SOFI", "HOOD", "AFRM", "PLTR", "UBER", "AMD", "NVDA",
]);
const IBKR_AUTO_SPECULATIVE_PENALTY = new Set(["U", "IONQ", "UPST", "BMNR", "ROKU", "DKNG", "SMCI"]);
const IBKR_AUTO_WIDE_SPREAD_PENALTY = new Set(["DKNG", "IONQ", "U", "UPST", "ROKU", "BMNR", "SMCI"]);

function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

function minPremiumForSpot(spot) {
  if (!spot || spot <= 0) return 0;
  return spot * 0.005;
}

function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
  const prob =
    1 -
    d *
      (0.31938153 * t -
        0.356563782 * t ** 2 +
        1.781477937 * t ** 3 -
        1.821255978 * t ** 4 +
        1.330274429 * t ** 5);
  return x >= 0 ? prob : 1 - prob;
}

function estimateShortPutPopFromExpectedMove({ spot, level, expectedMove }) {
  const s = Number(spot);
  const l = Number(level);
  const em = Number(expectedMove);
  if (!(s > 0) || !(l > 0) || !(em > 0)) return null;
  const sigmaPeriod = em / s;
  if (!(sigmaPeriod > 0)) return null;
  const z =
    (Math.log(s / l) - 0.5 * sigmaPeriod * sigmaPeriod) /
    sigmaPeriod;
  const pop = normalCdf(z);
  return Number.isFinite(pop) ? Math.max(0, Math.min(1, pop)) : null;
}

function computePreIbkrScore(symbol, candidate) {
  let score = 100;
  const reasons = [];
  const s = String(symbol || "").trim().toUpperCase();
  const rsi = Number(candidate?.rsi);
  const trend = String(candidate?.trend || "");
  const momentum = String(candidate?.momentum || "");
  const supportStatus = String(candidate?.supportStatus || "");
  const earningsDaysUntil = Number(candidate?.earningsDaysUntil);
  const price = Number(candidate?.price);

  if (IBKR_AUTO_PRIORITY_SYMBOLS.has(s)) {
    score += 10;
    reasons.push("prioritaire");
  }
  if (IBKR_AUTO_SPECULATIVE_PENALTY.has(s)) {
    score -= 30;
    reasons.push("malus spéculatif");
  }
  if (IBKR_AUTO_WIDE_SPREAD_PENALTY.has(s)) {
    score -= 18;
    reasons.push("malus spread fréquent");
  }
  if (Number.isFinite(earningsDaysUntil)) {
    if (earningsDaysUntil >= 0 && earningsDaysUntil <= 7) {
      score -= 45;
      reasons.push("malus earnings proche");
    } else if (earningsDaysUntil <= 14) {
      score -= 20;
      reasons.push("malus earnings");
    }
  }
  if (Number.isFinite(rsi) && rsi > 80) {
    score -= 30;
    reasons.push("malus RSI>80");
  }
  if (trend === "bearish") {
    score -= 20;
    reasons.push("malus trend bearish");
  } else if (trend === "bullish") {
    score += 8;
    reasons.push("trend bullish");
  }
  if (momentum === "negative") {
    score -= 15;
    reasons.push("malus momentum négatif");
  } else if (momentum === "positive") {
    score += 8;
    reasons.push("momentum positif");
  }
  if (supportStatus === "below_support" || supportStatus === "near_support") {
    score -= 15;
    reasons.push("malus support fragile");
  } else if (supportStatus === "room_above_support") {
    score += 10;
    reasons.push("support OK");
  }
  if (Number.isFinite(price)) {
    if (price >= 15 && price <= 150) {
      score += 10;
      reasons.push("range prix OK");
    } else if (price < 8 || price > 350) {
      score -= 12;
      reasons.push("prix moins adapté");
    }
  }

  return { score, reasons: reasons.slice(0, 4) };
}

/**
 * Yahoo / scan_shortlist : données techniques utiles au badge (pas d’invention).
 * @param {unknown} item candidat dashboard (carte)
 */
function dashboardCandidateHasYahooTechnicals(item) {
  if (!item || typeof item !== "object") return false;
  if (Number.isFinite(Number(item.rsi))) return true;
  const t = String(item.trend ?? "").trim().toLowerCase();
  if (t && t !== "—" && t !== "unknown") return true;
  const m = String(item.momentum ?? "").trim().toLowerCase();
  if (m && m !== "—" && m !== "unknown") return true;
  if (item.support != null && Number.isFinite(Number(item.support))) return true;
  if (item.resistance != null && Number.isFinite(Number(item.resistance))) return true;
  if (Number.isFinite(Number(item.qualityScore))) return true;
  if (Array.isArray(item.qualityReasons) && item.qualityReasons.length > 0) return true;
  return false;
}

/** Libellé honnête pour le badge technique (cartes IBKR ou fusion). */
function techniqueBadgeLabel(item) {
  const src = item?.techniqueSource;
  if (src === "Yahoo" && dashboardCandidateHasYahooTechnicals(item)) return "Yahoo";
  if (src === "Yahoo" && !dashboardCandidateHasYahooTechnicals(item)) return "non disponible";
  if (!src || src === "—") return "non disponible";
  return String(src);
}

/**
 * Tickers envoyés au scan IBKR manuel : ordre de la shortlist affichée (backend ou IBKR Direct), sinon watchlist.
 * @returns {{ tickers: string[], source: "active_shortlist" | "watchlist" }}
 */
function getManualIbkrTickersForSend({
  ibkrDirectMaxTickers,
  fallbackWatchlistTickers,
  dataSource,
  backendCandidates,
  filteredDisplayedCandidates,
}) {
  const max = Number(ibkrDirectMaxTickers) || 10;

  /** @returns {string[]} */
  const watchlistSlice = () => {
    const seen = new Set();
    const out = [];
    for (const t of fallbackWatchlistTickers || []) {
      const u = String(t || "").trim().toUpperCase();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= max) break;
    }
    return out;
  };

  const hasActiveShortlist = Array.isArray(backendCandidates) && backendCandidates.length > 0;

  if (hasActiveShortlist && (dataSource === "backend" || dataSource === "ibkr_direct")) {
    const backendOrder = backendCandidates
      .map((c) => String(c?.ticker || "").trim().toUpperCase())
      .filter(Boolean);
    const backendSet = new Set(backendOrder);

    const seen = new Set();
    const out = [];

    const rows = Array.isArray(filteredDisplayedCandidates) ? filteredDisplayedCandidates : [];
    for (const item of rows) {
      const sym = String(item?.ticker || "").trim().toUpperCase();
      if (!sym || !backendSet.has(sym)) continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
      if (out.length >= max) return { tickers: out, source: "active_shortlist" };
    }

    for (const sym of backendOrder) {
      if (seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
      if (out.length >= max) break;
    }
    return { tickers: out, source: "active_shortlist" };
  }

  return { tickers: watchlistSlice(), source: "watchlist" };
}

/**
 * Réponse HTTP 200 mais aucune ligne par symbole : souvent TWS fermé ou stdout Python vide.
 * @param {unknown} payload
 */
function isIbkrDirectScanSuspiciousEmpty(payload) {
  if (!payload || payload.ok !== true) return false;
  const scanned = Number(payload.scanned);
  if (!Number.isFinite(scanned) || scanned <= 0) return false;
  const kept = Number(payload.kept);
  if (Number.isFinite(kept) && kept > 0) return false;
  const sl = Array.isArray(payload.shortlist) ? payload.shortlist.length : 0;
  if (sl > 0) return false;
  const rj = Array.isArray(payload.rejected) ? payload.rejected.length : 0;
  const er = Array.isArray(payload.errors) ? payload.errors.length : 0;
  const sd = Array.isArray(payload.shortlistDev) ? payload.shortlistDev.length : 0;
  if (sd > 0) return false;
  return sl === 0 && rj === 0 && er === 0 && sd === 0;
}

const IBKR_TWS_EMPTY_MESSAGE =
  "IBKR / TWS non disponible ou réponse vide. Ouvre TWS / IB Gateway, connecte-toi, puis relance le scan.";

/** Shortlist IBKR principale vide alors que la réponse n’est pas « suspicious » (ex. tout rejeté). */
const IBKR_NO_KEPT_PRIMARY_MESSAGE =
  "IBKR : aucun symbole retenu dans la shortlist principale (voir rejetés / erreurs dans le panneau IBKR Direct). La shortlist actuelle est conservée.";

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

function isPastYmd(value, today = ymdTodayLocal()) {
  return isYmd(value) && String(value) < String(today);
}

/** YYYY-MM-DD ou YYYYMMDD → YYYY-MM-DD pour comparaisons. */
function normalizeExpirationYmd(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Filtre d’affichage : aucune carte dont l’expiration explicite ne correspond pas à la sélection. */
function candidateRowMatchesSelectedExpiration(item, selectedExp) {
  const sel = normalizeExpirationYmd(selectedExp);
  if (!sel) return true;
  const fields = [
    item?.targetExpiration,
    item?.expiration,
    item?.raw?.expiration,
    item?.yahoo?.targetExpiration,
  ];
  for (const f of fields) {
    const n = normalizeExpirationYmd(f);
    if (n && n !== sel) return false;
  }
  return true;
}

/**
 * Lit LAST_GOOD_SCAN_KEY et indique si le cache est utilisable pour la bannière / refresh marché fermé.
 */
function readLastGoodScanCache(selectedExpiration) {
  const selectedExpirationNorm = normalizeExpirationYmd(selectedExpiration);
  if (!selectedExpirationNorm || isPastYmd(selectedExpirationNorm)) {
    return { valid: false, cached: null, cachedShortlist: null };
  }
  try {
    if (typeof window === "undefined") {
      return { valid: false, cached: null, cachedShortlist: null };
    }
    const raw = window.localStorage.getItem(LAST_GOOD_SCAN_KEY);
    const cached = raw ? JSON.parse(raw) : null;
    const cachedShortlist = Array.isArray(cached?.shortlist) ? cached.shortlist : null;
    const cachedExpirationNorm = normalizeExpirationYmd(String(cached?.expiration || "").trim());
    if (
      !cachedShortlist ||
      cachedShortlist.length === 0 ||
      !cachedExpirationNorm ||
      cachedExpirationNorm !== selectedExpirationNorm ||
      isPastYmd(cachedExpirationNorm)
    ) {
      return { valid: false, cached, cachedShortlist };
    }
    const displayable = cachedShortlist.filter((item) =>
      candidateRowMatchesSelectedExpiration(item, selectedExpirationNorm)
    );
    return {
      valid: displayable.length > 0,
      cached,
      cachedShortlist,
    };
  } catch (_e) {
    return { valid: false, cached: null, cachedShortlist: null };
  }
}

function hasValidLastGoodScanForExpiration(selectedExpiration) {
  return readLastGoodScanCache(selectedExpiration).valid;
}

/** Hors marché : marque les candidats /scan_shortlist comme indicatifs (non décision de trade). */
function tagCandidatesOffMarketNonTradable(candidates, marketClosed) {
  if (!marketClosed || !Array.isArray(candidates)) return candidates;
  return candidates.map((c) => ({
    ...c,
    dataTradable: false,
    indicativeShortlistSession: true,
  }));
}

function payloadExpirationMatchesSelected(payloadExpirationField, selectedExp) {
  const p = normalizeExpirationYmd(payloadExpirationField);
  const s = normalizeExpirationYmd(selectedExp);
  if (!s) return true;
  if (!p) return true;
  return p === s;
}

function ibkrPayloadExpirationMatchesSelected(payload, selectedExp) {
  return payloadExpirationMatchesSelected(payload?.expiration, selectedExp);
}

function pickDefaultExpiration(expirations, today = ymdTodayLocal()) {
  const valid = Array.isArray(expirations) ? expirations.filter((e) => isYmd(e)) : [];
  const nonPast = valid.filter((e) => String(e) >= String(today));
  return nonPast[0] || "";
}

function futureExpirations(expirations, today = ymdTodayLocal()) {
  return (Array.isArray(expirations) ? expirations : [])
    .filter((e) => isYmd(e))
    .filter((e) => String(e) >= String(today));
}

function pickRelevantEarningsDate({ earningsDate, nextEarningsDate, expiration, maxDays = 20 }) {
  const today = ymdTodayLocal();
  const candidates = [nextEarningsDate, earningsDate]
    .filter((d) => isYmd(d))
    .filter((d) => String(d) >= String(today))
    .filter((d) => !isYmd(expiration) || String(d) <= String(expiration))
    .filter((d) => {
      const days = daysBetweenYmd(today, d);
      return days != null && days >= 0 && days <= maxDays;
    })
    .sort();
  return candidates[0] || null;
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
  const effectiveDate = pickRelevantEarningsDate({ earningsDate, nextEarningsDate, expiration });
  const earningsDaysUntil = effectiveDate ? daysBetweenYmd(today, effectiveDate) : null;
  const shouldWarn =
    earningsDaysUntil != null && earningsDaysUntil >= 0 && earningsDaysUntil <= 20;
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
  const activeEarningsMode = item?.earningsMode === true;
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
    setup: activeEarningsMode
      ? `Mode earnings — expiration ${selectedExpiration}`
      : `PUT scanner — expiration ${selectedExpiration}`,
    targetExpiration: selectedExpiration,
    price: item.currentPrice ?? 0,
    expectedMovePct:
      item.currentPrice && item.adjustedMove
        ? (item.adjustedMove / item.currentPrice) * 100
        : 0,
    expectedMoveMultiplier: activeEarningsMode ? 2 : 1,
    earningsMode: activeEarningsMode,
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
    tier: item.tier ?? "none",
    qualityScore: Number.isFinite(item?.qualityScore) ? Number(item.qualityScore) : null,
    qualityReasons: Array.isArray(item.qualityReasons) ? item.qualityReasons : [],
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

function buildPortfolioCombos(candidates, capital, maxCapitalPct, maxPositions, rejectedIbkrSymbols = new Set()) {
  const usableCapital = capital * (maxCapitalPct / 100);
  const targetMinPct = 90;
  const targetGoalPct = 95;
  const basePool = candidates
    .filter((c) => !rejectedIbkrSymbols.has(String(c?.ticker || "").trim().toUpperCase()))
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
    const isIbkrPreferred = candidate?.optionsSource === "IBKR live";
    const rawSafe = candidate.raw?.safeStrike ?? null;
    const rawAggressive = candidate.raw?.aggressiveStrike ?? null;
    const mappedSafe = candidate.safeStrike ?? null;
    const mappedAggressive = candidate.aggressiveStrike ?? null;
    const mappedPrimary = isAggressive ? mappedAggressive ?? mappedSafe : mappedSafe ?? mappedAggressive;
    const mappedSecondary = isAggressive ? mappedSafe ?? mappedAggressive : mappedAggressive ?? mappedSafe;
    const rawPrimary = isAggressive ? rawAggressive ?? rawSafe : rawSafe ?? rawAggressive;
    const rawSecondary = isAggressive ? rawSafe ?? rawAggressive : rawAggressive ?? rawSafe;

    const selected = isIbkrPreferred
      ? mappedPrimary ?? mappedSecondary ?? rawPrimary ?? rawSecondary
      : rawPrimary ?? rawSecondary ?? mappedPrimary ?? mappedSecondary;

    const strike = Number(selected?.strike ?? 0);
    let premiumUnit = Number(
      selected?.premiumUsed ??
      selected?.primeUsed ??
      selected?.conservativePremium ??
      selected?.bid ??
      selected?.premium ??
      (!isIbkrPreferred ? selected?.mid : null) ??
      0
    );
    if (isIbkrPreferred && !(premiumUnit > 0)) {
      return { strike: 0, premiumUnit: 0, weeklyReturn: 0, source: "IBKR live", premiumKind: "invalid" };
    }
    if (isIbkrPreferred && !(strike > 0)) {
      return { strike: 0, premiumUnit: 0, weeklyReturn: 0, source: "IBKR live", premiumKind: "invalid" };
    }
    const spot = Number(candidate?.price ?? 0);
    const weeklyReturn =
      selected?.weeklyYield != null
        ? Number(selected.weeklyYield)
        : premiumUnit > 0 && strike > 0
        ? (premiumUnit / strike) * 100
        : Number(candidate.weeklyReturn ?? 0);

    return {
      strike: Number.isFinite(strike) ? strike : 0,
      premiumUnit: Number.isFinite(premiumUnit) ? premiumUnit : 0,
      weeklyReturn: Number.isFinite(weeklyReturn) ? weeklyReturn : 0,
      source: isIbkrPreferred ? "IBKR live" : "Yahoo fallback",
      premiumKind:
        selected?.premiumUsed != null || selected?.primeUsed != null
          ? "prime utilisée"
          : selected?.bid != null
          ? "prime bid"
          : "prime fallback",
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
          source: selected.source,
          premiumKind: selected.premiumKind,
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
        source: candidate.source,
        premiumKind: candidate.premiumKind,
        premiumUnit: candidate.selectedStrike.premiumUnit,
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
  premiumUsed,
  premiumLabel,
  popEstimate,
  popProfitEstimated,
  popOtmEstimated,
  popSource,
  tradeYield,
  weeklyNormalizedYield,
  annualizedYield,
  distancePct,
  label,
  meetsTarget,
  liquidity,
}) {
  const distanceTone = distancePct <= -10 ? "good" : distancePct <= -5 ? "warn" : "bad";
  const displayedPremium = Number.isFinite(Number(premiumUsed))
    ? Number(premiumUsed)
    : Number.isFinite(Number(mid))
    ? Number(mid)
    : null;
  const hasPremiumNumber = displayedPremium != null;
  const premiumTone =
    displayedPremium == null
      ? "default"
      : displayedPremium >= 0.2
      ? "good"
      : displayedPremium >= 0.09
      ? "warn"
      : "bad";
  const yieldOk = typeof tradeYield === "number" && Number.isFinite(tradeYield);
  const yieldTone =
    !yieldOk || tradeYield == null ? "default" : tradeYield >= 1 ? "good" : tradeYield >= 0.5 ? "warn" : "bad";
  const objectiveResolved = meetsTarget && hasPremiumNumber && yieldOk;
  const mainPop = popProfitEstimated ?? popEstimate ?? null;
  const popTone =
    mainPop == null ? "default" : mainPop >= 0.75 ? "good" : mainPop >= 0.6 ? "warn" : "bad";
  const spreadClass = classifySpreadPctPercent(liquidity?.spreadPct);

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
              objectiveResolved
                ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border border-rose-200 bg-rose-50 text-rose-700"
            )}
          >
            {!hasPremiumNumber
              ? "prime indisponible — DEV"
              : objectiveResolved
              ? "objectif validé"
              : "objectif non atteint"}
          </Badge>
          <Badge className={cn("rounded-full border", spreadClass.badgeClass)}>
            {spreadClass.label}
          </Badge>
          <span className={cn("max-w-36 text-right text-[11px] leading-4", spreadClass.textClass)}>
            {spreadClass.reason}
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Strike" value={`$${strike.toFixed(2)}`} strong />
        <Metric
          label={premiumLabel || "Prime (mid)"}
          value={Number.isFinite(displayedPremium) ? `$${displayedPremium.toFixed(2)}` : "—"}
          strong={displayedPremium != null && displayedPremium >= 0.09}
          tone={premiumTone}
        />
        <Metric label="Distance" value={`${distancePct.toFixed(1)}%`} strong tone={distanceTone} />
        <Metric
          label="Rendement"
          value={
            yieldOk ? `${tradeYield.toFixed(2)}%` : "—"
          }
          strong
          tone={yieldTone}
        />
        <Metric
          label="Rendement hebdo (7J)"
          value={
            typeof weeklyNormalizedYield === "number" && Number.isFinite(weeklyNormalizedYield)
              ? `${weeklyNormalizedYield.toFixed(2)}%`
              : "—"
          }
          strong
          tone={yieldTone}
        />
        <Metric
          label="Annualisé"
          value={
            typeof annualizedYield === "number" && Number.isFinite(annualizedYield)
              ? `${annualizedYield.toFixed(1)}%`
              : "—"
          }
          tone={yieldTone}
        />
        <Metric
          label="POP profit estimée"
          value={mainPop != null ? `${(mainPop * 100).toFixed(1)}%` : "—"}
          tone={popTone}
        />
        <Metric
          label="POP OTM estimée"
          value={popOtmEstimated != null ? `${(popOtmEstimated * 100).toFixed(1)}%` : "—"}
          tone={popOtmEstimated == null ? "default" : popOtmEstimated >= 0.7 ? "good" : "warn"}
        />
        <Metric label="Source POP" value={popSource || "—"} />
        <Metric
          label="Spread"
          value={
            liquidity?.spreadPct != null
              ? `${Number(liquidity.spreadPct).toFixed(2)}%`
              : "—"
          }
          tone={spreadClass.metricTone}
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
  const safeEqualsAggressive =
    hasSafe &&
    hasAggressive &&
    Number.isFinite(Number(item.safeStrike.strike)) &&
    Number(item.safeStrike.strike) === Number(item.aggressiveStrike.strike);

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

      {safeEqualsAggressive && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
          Safe = agressif : même strike retenu
        </div>
      )}

      {hasSafe || hasAggressive ? (
        <div className="mt-4 grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
          {hasSafe && (
            <StrikeCard
              className="h-full"
              title="Strike safe"
              subtitle="prime la plus proche de la cible minimale"
              strike={item.safeStrike.strike}
              mid={item.safeStrike.mid}
              premiumUsed={item.safeStrike.premiumUsed}
              premiumLabel={item.safeStrike.premiumLabel}
              popEstimate={item.safeStrike.popEstimate}
              popProfitEstimated={item.safeStrike.popProfitEstimated}
              popOtmEstimated={item.safeStrike.popOtmEstimated}
              popSource={item.safeStrike.popSource}
              tradeYield={item.safeStrike.weeklyYield}
              weeklyNormalizedYield={item.safeStrike.weeklyNormalizedYield}
              annualizedYield={item.safeStrike.annualizedYield}
              distancePct={item.safeStrike.distancePct}
              label={item.safeStrike.label}
              meetsTarget={
                Number.isFinite(Number(item.safeStrike.mid)) &&
                Number(item.safeStrike.mid) >= Number(item.minPremium || 0)
              }
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
              premiumUsed={item.aggressiveStrike.premiumUsed}
              premiumLabel={item.aggressiveStrike.premiumLabel}
              popEstimate={item.aggressiveStrike.popEstimate}
              popProfitEstimated={item.aggressiveStrike.popProfitEstimated}
              popOtmEstimated={item.aggressiveStrike.popOtmEstimated}
              popSource={item.aggressiveStrike.popSource}
              tradeYield={item.aggressiveStrike.weeklyYield}
              weeklyNormalizedYield={item.aggressiveStrike.weeklyNormalizedYield}
              annualizedYield={item.aggressiveStrike.annualizedYield}
              distancePct={item.aggressiveStrike.distancePct}
              label={item.aggressiveStrike.label}
              meetsTarget={
                Number.isFinite(Number(item.aggressiveStrike.mid)) &&
                Number(item.aggressiveStrike.mid) >= Number(item.minPremium || 0)
              }
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

function formatMoneyOrDash(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `$${Number(value).toFixed(2)}`;
}

function formatSignedMoneyOrDash(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function formatStrikeOrDash(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : String(Number(value));
}

function formatYahooIbkrDiff({ yahooValue, ibkrValue, diff }) {
  return `${formatMoneyOrDash(yahooValue)} / ${formatMoneyOrDash(ibkrValue)} (${formatSignedMoneyOrDash(diff)})`;
}

function getIbkrBatchMessage(row) {
  const ibkrError = row?.ibkr?.error || row?.ibkr?.reason;
  const yahooError = row?.yahoo?.error || row?.yahoo?.reason;
  const warnings = Array.isArray(row?.warnings) ? row.warnings.filter(Boolean).join(", ") : "";
  return formatIbkrReason(ibkrError || yahooError || warnings || "");
}

function IbkrMiniStrikeDetails({ title, strike }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">
        Strike {formatStrikeOrDash(strike?.strike)}
      </p>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        Bid {formatMoneyOrDash(strike?.bid)} / Ask {formatMoneyOrDash(strike?.ask)} / Mid{" "}
        {formatMoneyOrDash(strike?.mid)}
      </p>
      <p className="text-xs leading-5 text-slate-600">
        Spread {formatMoneyOrDash(strike?.spread)} / {formatIbkrPercent(strike?.spreadPct)} · Prime{" "}
        {formatMoneyOrDash(strike?.primeUsed)}
      </p>
    </div>
  );
}

function ibkrSpreadIsVeryWide(strike) {
  return Number.isFinite(Number(strike?.spreadPct)) && Number(strike.spreadPct) > 0.5;
}

function buildCandidateLookupKeys(candidate) {
  const rawKeys = [
    candidate?.symbol,
    candidate?.ticker,
    candidate?.underlying,
    candidate?.underlyingSymbol,
    candidate?.raw?.symbol,
  ];
  return [...new Set(rawKeys.map((v) => String(v || "").trim().toUpperCase()).filter(Boolean))];
}

function technicalCompletenessScore(candidate) {
  if (!candidate || typeof candidate !== "object") return 0;
  let score = 0;
  if (candidate.rsi != null && candidate.rsi !== "—") score += 1;
  if (candidate.trend != null && candidate.trend !== "—" && candidate.trend !== "unknown") score += 1;
  if (candidate.momentum != null && candidate.momentum !== "—" && candidate.momentum !== "unknown") score += 1;
  if (candidate.support != null) score += 1;
  if (candidate.resistance != null) score += 1;
  if (candidate.qualityScore != null) score += 1;
  if (Array.isArray(candidate.qualityReasons) && candidate.qualityReasons.length > 0) score += 1;
  if (candidate.earningsWarning || candidate.earningsDate || candidate.nextEarningsDate) score += 1;
  return score;
}

function mergeYahooAndIbkrCandidate(yahooCandidate, ibkrCandidate) {
  const symbol = String(ibkrCandidate?.symbol || yahooCandidate?.ticker || "").trim().toUpperCase();
  const safeStrike = ibkrCandidate?.safeStrike ?? null;
  const aggressiveStrike = ibkrCandidate?.aggressiveStrike ?? null;
  const primaryStrike = safeStrike ?? aggressiveStrike ?? null;
  const yahooReasons = Array.isArray(yahooCandidate?.qualityReasons) ? yahooCandidate.qualityReasons : [];
  const ibkrReasons = Array.isArray(ibkrCandidate?.qualityReasons) ? ibkrCandidate.qualityReasons : [];

  return {
    symbol,
    ticker: symbol,
    techniqueSource: "Yahoo",
    optionsSource: "IBKR live",
    currentPrice: ibkrCandidate?.currentPrice ?? ibkrCandidate?.underlyingPrice ?? yahooCandidate?.price ?? null,
    expectedMove: ibkrCandidate?.expectedMove ?? null,
    lowerBound: ibkrCandidate?.lowerBound ?? yahooCandidate?.expectedMoveLow ?? null,
    upperBound: ibkrCandidate?.upperBound ?? yahooCandidate?.expectedMoveHigh ?? null,
    targetPremium: ibkrCandidate?.targetPremium ?? yahooCandidate?.minPremium ?? null,
    safeStrike,
    aggressiveStrike,
    spread: ibkrCandidate?.spread ?? primaryStrike?.spread ?? null,
    spreadPct: ibkrCandidate?.spreadPct ?? primaryStrike?.spreadPct ?? null,
    premiumUsed: ibkrCandidate?.premiumUsed ?? primaryStrike?.primeUsed ?? null,
    weeklyYield: ibkrCandidate?.weeklyYield ?? null,
    annualizedYield: ibkrCandidate?.annualizedYield ?? null,
    rsi: yahooCandidate?.rsi ?? null,
    trend: yahooCandidate?.trend ?? null,
    momentum: yahooCandidate?.momentum ?? null,
    support: yahooCandidate?.support ?? null,
    resistance: yahooCandidate?.resistance ?? null,
    supportStatus: yahooCandidate?.supportStatus ?? null,
    earningsWarning: yahooCandidate?.earningsWarning ?? null,
    earningsDate: yahooCandidate?.earningsDate ?? null,
    nextEarningsDate: yahooCandidate?.nextEarningsDate ?? null,
    earningsMoment: yahooCandidate?.earningsMoment ?? null,
    targetExpiration: yahooCandidate?.targetExpiration ?? null,
    qualityReasons: [...new Set([...yahooReasons, ...ibkrReasons].filter(Boolean))],
    yahoo: yahooCandidate ?? null,
    ibkr: ibkrCandidate ?? null,
  };
}

function ibkrStrikeToDashboardStrike(strike, spot, label, preserveNullQuotes = false) {
  if (!strike) return null;
  const strikeValue = Number(strike.strike);
  const primeFromQuote = strike.primeUsed ?? strike.bid ?? null;
  const premiumUsed = Number.isFinite(Number(primeFromQuote))
    ? Number(primeFromQuote)
    : preserveNullQuotes
    ? null
    : Number(strike.mid ?? strike.primeUsed ?? strike.bid ?? 0);

  const yieldDecimal = Number(strike.premiumYieldOnUnderlying ?? strike.premiumYield);
  let weeklyYield;
  let weeklyNormalizedYield;
  let annualizedYield;
  if (premiumUsed == null || !Number.isFinite(premiumUsed)) {
    weeklyYield =
      preserveNullQuotes && premiumUsed == null && !Number.isFinite(yieldDecimal) ? null : 0;
    weeklyNormalizedYield = weeklyYield;
    annualizedYield = weeklyYield == null ? null : 0;
  } else if (Number.isFinite(yieldDecimal)) {
    weeklyYield = yieldDecimal * 100;
    weeklyNormalizedYield = yieldDecimal * 100;
    annualizedYield = yieldDecimal * 52 * 100;
  } else {
    weeklyYield = 0;
    weeklyNormalizedYield = 0;
    annualizedYield = 0;
  }

  let midNum;
  if (Number.isFinite(Number(strike.mid))) {
    midNum = Number(strike.mid);
  } else if (Number.isFinite(Number(strike.bid)) && Number.isFinite(Number(strike.ask))) {
    midNum = (Number(strike.bid) + Number(strike.ask)) / 2;
  } else if (premiumUsed != null && Number.isFinite(premiumUsed)) {
    midNum = premiumUsed;
  } else {
    midNum = preserveNullQuotes ? null : Number(strike.mid ?? strike.primeUsed ?? strike.bid ?? 0);
  }

  const spreadPctDecimal = Number(strike.spreadPct);
  const resolvedMid =
    midNum == null
      ? preserveNullQuotes
        ? null
        : 0
      : midNum;

  const resolvedPremiumUsed =
    premiumUsed == null ? (preserveNullQuotes ? null : 0) : premiumUsed;

  return {
    strike: Number.isFinite(strikeValue) ? strikeValue : 0,
    mid: resolvedMid,
    premiumUsed: resolvedPremiumUsed,
    premiumLabel:
      strike?.primeUsed != null && strike?.primeUsed !== ""
        ? "Prime utilisée"
        : preserveNullQuotes
        ? "Prime (bid) — DEV"
        : "BID utilisé",
    popEstimate: null,
    popProfitEstimated: null,
    popOtmEstimated: null,
    popSource: null,
    weeklyYield,
    weeklyNormalizedYield,
    annualizedYield,
    distancePct:
      Number.isFinite(strikeValue) && Number.isFinite(Number(spot)) && Number(spot) > 0
        ? strikeDistancePct(strikeValue, Number(spot))
        : 0,
    label,
    liquidity: {
      spread: strike.spread ?? null,
      spreadPct: Number.isFinite(spreadPctDecimal) ? spreadPctDecimal * 100 : null,
      isLiquid: Number.isFinite(spreadPctDecimal) && spreadPctDecimal <= 0.3,
    },
    bid: strike.bid ?? null,
    ask: strike.ask ?? null,
    primeUsed:
      strike.primeUsed ?? (premiumUsed != null ? premiumUsed : preserveNullQuotes ? null : resolvedPremiumUsed),
    source: "IBKR live",
    raw: strike,
  };
}

function mergeIbkrIntoDashboardCandidate(yahooCandidate, ibkrCandidate, index, selectedExpiration) {
  const symbol = String(ibkrCandidate?.symbol || yahooCandidate?.ticker || "").trim().toUpperCase();
  const spot = ibkrCandidate?.currentPrice ?? ibkrCandidate?.underlyingPrice ?? yahooCandidate?.price ?? 0;
  const expectedMove = ibkrCandidate?.expectedMove ?? null;
  const preserveNullQuotes =
    ibkrCandidate?.dataTradable === false &&
    (ibkrCandidate?.devIncompleteMarketData === true || ibkrCandidate?.premiumUsed == null);
  const safeStrike = ibkrStrikeToDashboardStrike(
    ibkrCandidate?.safeStrike,
    spot,
    "safe IBKR live",
    preserveNullQuotes
  );
  const aggressiveStrike = ibkrStrikeToDashboardStrike(
    ibkrCandidate?.aggressiveStrike,
    spot,
    "agressif IBKR live",
    preserveNullQuotes
  );
  const applyPop = (dashboardStrike, ibkrRawStrike, yahooFallbackStrike) => {
    if (!dashboardStrike) return null;
    const rawPu = ibkrRawStrike?.primeUsed ?? ibkrRawStrike?.bid ?? dashboardStrike?.premiumUsed;
    const premiumUsed = Number.isFinite(Number(rawPu)) ? Number(rawPu) : null;
    const popProfitEstimated =
      premiumUsed == null
        ? null
        : estimateShortPutPopFromExpectedMove({
            spot,
            level: Number(ibkrRawStrike?.strike) - premiumUsed,
            expectedMove,
          });
    const popOtmEstimated = estimateShortPutPopFromExpectedMove({
      spot,
      level: Number(ibkrRawStrike?.strike),
      expectedMove,
    });
    const fallbackPop = yahooFallbackStrike?.popEstimate ?? null;
    return {
      ...dashboardStrike,
      popProfitEstimated: popProfitEstimated ?? fallbackPop,
      popOtmEstimated,
      popEstimate: fallbackPop,
      popSource:
        popProfitEstimated != null
          ? "IBKR expected move"
          : fallbackPop != null
          ? "Yahoo/maison"
          : null,
    };
  };
  const safeStrikeWithPop = applyPop(safeStrike, ibkrCandidate?.safeStrike, yahooCandidate?.safeStrike);
  const aggressiveStrikeWithPop = applyPop(
    aggressiveStrike,
    ibkrCandidate?.aggressiveStrike,
    yahooCandidate?.aggressiveStrike
  );
  const primaryStrike = safeStrikeWithPop ?? aggressiveStrikeWithPop;
  const ibkrNonTradable = ibkrCandidate?.dataTradable === false;
  const ibkrObjectiveBlock =
    ibkrNonTradable &&
    (ibkrCandidate?.devIncompleteMarketData === true || ibkrCandidate?.premiumUsed == null);
  const suppressIbkrWheelReturn = ibkrObjectiveBlock;
  const weeklyYieldDecimal = suppressIbkrWheelReturn
    ? null
    : Number(ibkrCandidate?.weeklyYield ?? primaryStrike?.raw?.premiumYieldOnUnderlying ?? 0);
  const ibkrQualityReasons = Array.isArray(ibkrCandidate?.qualityReasons) ? ibkrCandidate.qualityReasons : [];
  const yahooQualityReasons = Array.isArray(yahooCandidate?.qualityReasons) ? yahooCandidate.qualityReasons : [];
  const weeklyReturnValue =
    weeklyYieldDecimal == null || !Number.isFinite(weeklyYieldDecimal)
      ? suppressIbkrWheelReturn
        ? null
        : yahooCandidate?.weeklyReturn ?? 0
      : weeklyYieldDecimal * 100;
  const primaryPremium = primaryStrike?.premiumUsed ?? primaryStrike?.primeUsed;
  const premiumLabel =
    primaryPremium != null && Number.isFinite(Number(primaryPremium))
      ? Number(primaryPremium).toFixed(2)
      : yahooCandidate?.premium ?? "—";

  return {
    ...(yahooCandidate ?? {}),
    rank: index + 1,
    ticker: symbol,
    name: yahooCandidate?.name ?? symbol,
    setup:
      yahooCandidate?.earningsMode === true
        ? `Mode earnings — expiration ${selectedExpiration}`
        : yahooCandidate
        ? `PUT scanner — expiration ${selectedExpiration}`
        : `IBKR live — expiration ${selectedExpiration}`,
    targetExpiration: selectedExpiration,
    price: Number(spot || 0),
    expectedMovePct:
      Number(spot) > 0 && Number(expectedMove) > 0 ? (Number(expectedMove) / Number(spot)) * 100 : yahooCandidate?.expectedMovePct ?? 0,
    expectedMoveMultiplier: yahooCandidate?.expectedMoveMultiplier ?? 1,
    earningsMode: yahooCandidate?.earningsMode ?? false,
    earningsDate: yahooCandidate?.earningsDate ?? null,
    earningsMoment: yahooCandidate?.earningsMoment ?? null,
    nextEarningsDate: yahooCandidate?.nextEarningsDate ?? null,
    earningsDaysUntil: yahooCandidate?.earningsDaysUntil ?? null,
    earningsWarning: yahooCandidate?.earningsWarning ?? null,
    earningsWarningLevel: yahooCandidate?.earningsWarningLevel ?? null,
    expectedMoveLow: ibkrCandidate?.lowerBound ?? yahooCandidate?.expectedMoveLow ?? 0,
    expectedMoveHigh: ibkrCandidate?.upperBound ?? yahooCandidate?.expectedMoveHigh ?? 0,
    minPremium: ibkrCandidate?.targetPremium ?? yahooCandidate?.minPremium ?? minPremiumForSpot(spot),
    targetWeeks: yahooCandidate?.targetWeeks ?? 1,
    safeStrike: safeStrikeWithPop,
    aggressiveStrike: aggressiveStrikeWithPop,
    premium: premiumLabel,
    weeklyReturn: weeklyReturnValue,
    strikeDistance: primaryStrike ? primaryStrike.distancePct : yahooCandidate?.strikeDistance ?? 0,
    proFinalScore: yahooCandidate?.proFinalScore ?? 0,
    proExecutionScore: yahooCandidate?.proExecutionScore ?? 0,
    proDistanceScore: yahooCandidate?.proDistanceScore ?? 0,
    scoreSource: yahooCandidate?.scoreSource ?? "ibkr_fallback",
    tier: yahooCandidate?.tier ?? "none",
    qualityScore: yahooCandidate?.qualityScore ?? null,
    qualityReasons: [...new Set([...yahooQualityReasons, ...ibkrQualityReasons].filter(Boolean))],
    capitalPerContract: primaryStrike ? primaryStrike.strike * 100 : 0,
    premiumPerContract:
      primaryStrike && primaryPremium != null && Number.isFinite(Number(primaryPremium))
        ? Number(primaryPremium) * 100
        : 0,
    earnings: yahooCandidate?.earnings ?? "—",
    iv: yahooCandidate?.iv ?? null,
    rsi: yahooCandidate?.rsi ?? "—",
    trend: yahooCandidate?.trend ?? "—",
    momentum: yahooCandidate?.momentum ?? "—",
    sma20: yahooCandidate?.sma20 ?? null,
    sma50: yahooCandidate?.sma50 ?? null,
    support: yahooCandidate?.support ?? null,
    resistance: yahooCandidate?.resistance ?? null,
    strikeVsSupportPct: yahooCandidate?.strikeVsSupportPct ?? null,
    strikeVsResistancePct: yahooCandidate?.strikeVsResistancePct ?? null,
    supportStatus: yahooCandidate?.supportStatus ?? "unknown",
    macd: yahooCandidate?.macd ?? "—",
    zone: "sous borne basse IBKR",
    verdict: yahooCandidate?.verdict ?? "conservative",
    ok: yahooCandidate?.ok ?? true,
    note: yahooCandidate?.note ?? "Candidat IBKR live ajouté sans contexte technique Yahoo.",
    techniqueSource: yahooCandidate ? "Yahoo" : "—",
    optionsSource: "IBKR live",
    ibkrDirect: ibkrCandidate,
    ibkrSpreadPct: ibkrCandidate?.spreadPct ?? primaryStrike?.raw?.spreadPct ?? null,
    ibkrDevIncompleteSurface: ibkrCandidate?.devIncompleteMarketData === true,
    ibkrDevObjectiveBlocked: ibkrObjectiveBlock,
    raw: yahooCandidate?.raw ?? null,
  };
}

function MergedCandidateCard({ item }) {
  const spreadPct = Number(item?.spreadPct);
  const hasSpread = Number.isFinite(spreadPct);
  const spreadWarning =
    hasSpread && spreadPct > 0.5
      ? "Spread IBKR extrême — exécution risquée"
      : hasSpread && spreadPct > 0.3
      ? "Spread IBKR large — prudence"
      : "";
  const earningsDisplay =
    item.earningsWarning ||
    buildEarningsWarning({
      earningsDate: item.earningsDate ?? null,
      nextEarningsDate: item.nextEarningsDate ?? null,
      earningsMoment: item.earningsMoment ?? null,
      expiration: item.targetExpiration ?? null,
    }).earningsWarning;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-full border border-slate-300 bg-slate-50 text-slate-700">
              {item.symbol}
            </Badge>
            <Badge className="rounded-full border border-sky-200 bg-sky-50 text-sky-700">
              Technique : {techniqueBadgeLabel(item)}
            </Badge>
            <Badge className="rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
              Options : {item.optionsSource}
            </Badge>
          </div>

          <div>
            <h3 className="text-xl font-semibold tracking-tight text-slate-900">{item.symbol}</h3>
            <p className="mt-1 text-sm text-slate-600">
              Yahoo pour le contexte technique (si disponible) · IBKR pour les options live.
            </p>
            {earningsDisplay ? (
              <p className="mt-1 text-sm text-amber-700">{earningsDisplay}</p>
            ) : item.earningsDate || item.nextEarningsDate ? (
              <p className="mt-1 text-sm text-violet-700">
                Earnings : {formatShortDate(item.nextEarningsDate || item.earningsDate) || "—"}
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <Metric label="Spot IBKR" value={formatMoneyOrDash(item.currentPrice)} strong />
            <Metric
              label="RSI Yahoo"
              value={typeof item.rsi === "number" ? String(item.rsi) : "—"}
            />
            <Metric label="Trend Yahoo" value={item.trend || "—"} />
            <Metric label="Momentum Yahoo" value={item.momentum || "—"} />
            <Metric label="Support Yahoo" value={formatMoneyOrDash(item.support)} />
            <Metric label="Résistance Yahoo" value={formatMoneyOrDash(item.resistance)} />
            <Metric label="Support status" value={item.supportStatus || "—"} />
          </div>

          {item.qualityReasons.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Raisons : {item.qualityReasons.join(" · ")}
            </div>
          )}
        </div>

        <div className="w-full space-y-3 xl:min-w-[460px] xl:max-w-[560px]">
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <Metric label="Expected move IBKR" value={formatMoneyOrDash(item.expectedMove)} />
            <Metric label="Borne basse IBKR" value={formatMoneyOrDash(item.lowerBound)} strong tone="bad" />
            <Metric label="Borne haute IBKR" value={formatMoneyOrDash(item.upperBound)} strong tone="good" />
            <Metric label="Prime cible" value={formatMoneyOrDash(item.targetPremium)} />
            <Metric label="Prime utilisée" value={formatMoneyOrDash(item.premiumUsed)} strong />
            <Metric label="Spread" value={formatIbkrPercent(item.spreadPct)} tone={spreadWarning ? "warn" : "default"} />
            <Metric label="Yield semaine" value={formatIbkrPercent(item.weeklyYield)} strong />
            <Metric label="Yield annualisé" value={formatIbkrPercent(item.annualizedYield)} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <IbkrMiniStrikeDetails title="Safe IBKR" strike={item.safeStrike} />
            <IbkrMiniStrikeDetails title="Agressif IBKR" strike={item.aggressiveStrike} />
          </div>

          {spreadWarning && (
            <div
              className={cn(
                "rounded-xl border px-3 py-2 text-sm font-semibold",
                spreadPct > 0.5
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              )}
            >
              {spreadWarning}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MergedShortlistSection({ candidates }) {
  return (
    <Card className="mb-6 rounded-[28px] border-slate-200 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl text-slate-900">
          Shortlist fusionnée — Yahoo technique + IBKR options live
        </CardTitle>
        <p className="mt-1 text-sm text-slate-500">
          Vue séparée de validation : les techniques viennent de Yahoo quand disponibles, les strikes et primes viennent d’IBKR.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {candidates.length > 0 ? (
          candidates.map((item) => <MergedCandidateCard key={`merged-${item.symbol}`} item={item} />)
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
            Lance IBKR Direct Scan pour afficher la shortlist fusionnée.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function IbkrBatchCardDetails({ item, row }) {
  const ui = ibkrBatchStatusUi(row?.status);
  if (!ui) return null;

  const yahoo = row?.yahoo ?? {};
  const ibkr = row?.ibkr ?? {};
  const comparison = row?.comparison ?? {};
  const yahooSpot = yahoo?.currentPrice ?? item?.price;
  const yahooLowerBound = yahoo?.lowerBound ?? item?.expectedMoveLow;
  const yahooSafeStrike = yahoo?.safeStrike?.strike ?? item?.safeStrike?.strike;
  const yahooAggressiveStrike = yahoo?.aggressiveStrike?.strike ?? item?.aggressiveStrike?.strike;
  const message = getIbkrBatchMessage(row);
  const showFullDetails = row?.status === "different" || row?.status === "yahoo_unavailable";
  const sameIbkrStrike =
    ibkr?.safeStrike?.strike != null &&
    ibkr?.aggressiveStrike?.strike != null &&
    Number(ibkr.safeStrike.strike) === Number(ibkr.aggressiveStrike.strike);
  const hasWideIbkrSpread =
    ibkrSpreadIsVeryWide(ibkr?.safeStrike) || ibkrSpreadIsVeryWide(ibkr?.aggressiveStrike);

  return (
    <div className={cn("mt-3 rounded-xl border px-3 py-2 text-sm", ui.className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">IBKR Shadow</p>
        <span className="rounded-full border border-current/20 px-2 py-0.5 text-xs">{ui.label}</span>
      </div>
      <p className="mt-1">{ui.summary}</p>
      {message !== "—" && <p className="mt-1 text-xs opacity-90">Raison : {message}</p>}

      {row?.status === "ibkr_unavailable" || row?.status === "both_failed" ? (
        <p className="mt-2 text-xs opacity-90">
          IBKR n’a pas retourné de calcul utilisable pour ce titre. Yahoo reste la référence affichée.
        </p>
      ) : null}

      {row?.status === "confirmed" && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Metric label="IBKR spot" value={formatMoneyOrDash(ibkr?.underlyingPrice)} strong />
            <Metric label="IBKR exp. move" value={formatMoneyOrDash(ibkr?.expectedMove)} />
            <Metric label="IBKR borne basse" value={formatMoneyOrDash(ibkr?.lowerBound)} strong />
          </div>

          {sameIbkrStrike ? (
            <IbkrMiniStrikeDetails title="Safe/Agressif IBKR" strike={ibkr?.safeStrike ?? ibkr?.aggressiveStrike} />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              <IbkrMiniStrikeDetails title="Safe IBKR" strike={ibkr?.safeStrike} />
              <IbkrMiniStrikeDetails title="Agressif IBKR" strike={ibkr?.aggressiveStrike} />
            </div>
          )}

          {hasWideIbkrSpread && (
            <p className="rounded-xl border border-amber-300 bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-900">
              Spread IBKR très large — prudence
            </p>
          )}

          <div className="grid gap-2 md:grid-cols-2">
            <Metric
              label="Spot Yahoo / IBKR"
              value={formatYahooIbkrDiff({
                yahooValue: yahooSpot,
                ibkrValue: ibkr?.underlyingPrice,
                diff: comparison?.underlyingPriceDiff,
              })}
            />
            <Metric
              label="Borne basse Y / IBKR"
              value={formatYahooIbkrDiff({
                yahooValue: yahooLowerBound,
                ibkrValue: ibkr?.lowerBound,
                diff: comparison?.lowerBoundDiff,
              })}
            />
          </div>
        </div>
      )}

      {showFullDetails && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="IBKR spot" value={formatMoneyOrDash(ibkr?.underlyingPrice)} strong />
            <Metric label="IBKR exp. move" value={formatMoneyOrDash(ibkr?.expectedMove)} />
            <Metric label="IBKR borne basse" value={formatMoneyOrDash(ibkr?.lowerBound)} strong />
            <Metric label="IBKR safe" value={formatStrikeOrDash(ibkr?.safeStrike?.strike)} />
            <Metric label="IBKR agressif" value={formatStrikeOrDash(ibkr?.aggressiveStrike?.strike)} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <IbkrMiniStrikeDetails title="Safe IBKR" strike={ibkr?.safeStrike} />
            <IbkrMiniStrikeDetails title="Agressif IBKR" strike={ibkr?.aggressiveStrike} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <Metric
              label="Spot Yahoo / IBKR"
              value={formatYahooIbkrDiff({
                yahooValue: yahooSpot,
                ibkrValue: ibkr?.underlyingPrice,
                diff: comparison?.underlyingPriceDiff,
              })}
            />
            <Metric
              label="Borne basse Y / IBKR"
              value={formatYahooIbkrDiff({
                yahooValue: yahooLowerBound,
                ibkrValue: ibkr?.lowerBound,
                diff: comparison?.lowerBoundDiff,
              })}
            />
            <Metric
              label="Safe Yahoo / IBKR"
              value={`${formatStrikeOrDash(yahooSafeStrike)} / ${formatStrikeOrDash(ibkr?.safeStrike?.strike)}`}
              tone={comparison?.sameSafeStrike === false ? "warn" : "default"}
            />
            <Metric
              label="Agressif Yahoo / IBKR"
              value={`${formatStrikeOrDash(yahooAggressiveStrike)} / ${formatStrikeOrDash(
                ibkr?.aggressiveStrike?.strike
              )}`}
              tone={comparison?.sameAggressiveStrike === false ? "warn" : "default"}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function CandidateCard({ item, displayRank, yahooRankForIbkr, onOpenDetail, ibkrBatchRow = null }) {
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
  const relevantEarningsDate = pickRelevantEarningsDate({
    earningsDate: item.earningsDate ?? null,
    nextEarningsDate: item.nextEarningsDate ?? null,
    expiration: item.targetExpiration ?? null,
  });
  const yahooRank = Number.isFinite(Number(yahooRankForIbkr))
    ? Number(yahooRankForIbkr)
    : Number.isFinite(Number(item.rank))
    ? Number(item.rank)
    : null;
  const shownRank = Number.isFinite(Number(displayRank)) ? Number(displayRank) : yahooRank;
  const rsiHigh = typeof item.rsi === "number" && item.rsi >= 75;
  const resistanceValue = Number(item.resistance);
  const priceValue = Number(item.price);
  const resistanceUnderSpot =
    Number.isFinite(resistanceValue) &&
    Number.isFinite(priceValue) &&
    resistanceValue < priceValue;
  const resistanceDisplay =
    item.resistance == null
      ? "â€”"
      : resistanceUnderSpot
      ? "Résistance franchie"
      : `$${Number(item.resistance).toFixed(2)}`;
  const ibkrSpreadClass = classifySpreadPctPercent(item.ibkrSpreadPct);
  const hasIbkrSpread = normalizedIbkrSpreadPctPercent(item.ibkrSpreadPct) != null;

  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <Card className="border-slate-200 shadow-sm transition-all hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex-1 min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="rounded-full border border-slate-300 bg-slate-50 text-slate-700">
                  Choix #{shownRank}
                </Badge>
                {yahooRank != null && (
                  <Badge className="rounded-full border border-slate-200 bg-white text-xs text-slate-500">
                    Rang Yahoo #{yahooRank}
                  </Badge>
                )}
                <Badge className={cn("rounded-full border", verdictStyle[item.verdict])}>
                  {item.verdict}
                </Badge>
                {item.earningsMode && (
                  <Badge className="rounded-full border border-violet-200 bg-violet-50 text-violet-700">
                    mode earnings x{item.expectedMoveMultiplier || 2}
                  </Badge>
                )}
                {item.ok && !item.ibkrDevObjectiveBlocked ? (
                  <Badge className="rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                    objectif validé
                  </Badge>
                ) : (
                  <Badge className="rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                    à surveiller
                  </Badge>
                )}
                {item.optionsSource === "IBKR live" && (
                  <Badge className="rounded-full border border-sky-200 bg-sky-50 text-sky-700">
                    Technique : {techniqueBadgeLabel(item)}
                  </Badge>
                )}
                {item.optionsSource === "IBKR live" && (
                  <Badge className="rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                    Options : IBKR live
                  </Badge>
                )}
                {item.ibkrDirect?.devScanEnabled && (
                  <Badge className="rounded-full border border-amber-400 bg-amber-50 text-amber-950">
                    DEV TEST — données hors marché / non tradables
                  </Badge>
                )}
                {item.indicativeShortlistSession && !item.ibkrDirect?.devScanEnabled && (
                  <Badge className="rounded-full border border-amber-400 bg-amber-50 text-amber-950">
                    DEV TEST — marche ferme / donnees indicatives / non tradables
                  </Badge>
                )}
                {item.ibkrDevIncompleteSurface && (
                  <Badge className="rounded-full border border-amber-300 bg-amber-100 text-amber-950">
                    Données IBKR incomplètes — affichage DEV seulement
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
                ) : relevantEarningsDate ? (
                  <p className="mt-1 text-sm text-violet-700">
                    Earnings: {formatShortDate(relevantEarningsDate) || relevantEarningsDate}
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
                  value={
                    item.weeklyReturn != null && Number.isFinite(Number(item.weeklyReturn))
                      ? `${Number(item.weeklyReturn).toFixed(2)}% / sem`
                      : "—"
                  }
                  strong={
                    Number.isFinite(Number(item.weeklyReturn)) &&
                    Number(item.weeklyReturn) >= 0.5
                  }
                  tone={
                    !Number.isFinite(Number(item.weeklyReturn))
                      ? "default"
                      : Number(item.weeklyReturn) >= 0.5
                      ? "good"
                      : "bad"
                  }
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
                  value={resistanceDisplay}
                  tone={resistanceUnderSpot ? "warn" : "default"}
                />
                <Metric
                  label="Qualité Wheel"
                  value={item.qualityScore != null ? `${item.qualityScore}` : "—"}
                  strong={item.qualityScore != null}
                  tone={
                    item.qualityScore == null
                      ? "default"
                      : item.qualityScore >= 50
                      ? "good"
                      : item.qualityScore >= 20
                      ? "warn"
                      : "bad"
                  }
                />
              </div>

              {item.qualityReasons?.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  Qualité Wheel : {item.qualityReasons.join(" · ")}
                </div>
              )}
              {rsiHigh && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
                  RSI élevé : surachat court terme
                </div>
              )}
              {resistanceUnderSpot && (
                <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-800">
                  Ancienne résistance sous le prix : niveau déjà franchi
                </div>
              )}
              {item.optionsSource === "IBKR live" && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                  <div className="font-semibold">Options IBKR live utilisées dans cette carte</div>
                  <div className="mt-1 leading-5">
                    Safe : bid {formatMoneyOrDash(item.safeStrike?.bid)} / ask{" "}
                    {formatMoneyOrDash(item.safeStrike?.ask)} / mid{" "}
                    {formatMoneyOrDash(item.safeStrike?.mid)} · Agressif : bid{" "}
                    {formatMoneyOrDash(item.aggressiveStrike?.bid)} / ask{" "}
                    {formatMoneyOrDash(item.aggressiveStrike?.ask)} / mid{" "}
                    {formatMoneyOrDash(item.aggressiveStrike?.mid)} · spread{" "}
                    {formatIbkrPercent(item.ibkrSpreadPct)}
                  </div>
                  {hasIbkrSpread && ibkrSpreadClass.label !== "liquide" && (
                    <div className={cn("mt-2 rounded-lg border px-3 py-2 font-semibold", ibkrSpreadClass.badgeClass)}>
                      {ibkrSpreadClass.label} — {ibkrSpreadClass.reason}
                    </div>
                  )}
                </div>
              )}
              <SupportStatusLine item={item} />
              <div className="pt-1">
                <Button className="rounded-xl" onClick={() => onOpenDetail(item)}>
                  Voir la fiche complète <ChevronRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
              <IbkrBatchCardDetails item={item} row={ibkrBatchRow} />
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

async function callScanShortlist({ expiration, topN, tickers, sort = "quality" }) {
  const response = await fetch(`${API_BASE}/scan_shortlist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expiration,
      topN,
      tickers,
      sort,
    }),
  });

  const payload = await response.json();

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

async function callIbkrShadowWheel({ symbol, expiration, clientId }) {
  const response = await fetch(`${API_BASE}/ibkr/shadow/wheel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      symbol,
      expiration,
      clientId: Number(clientId),
      marketDataType: 2,
      maxStrikes: 25,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

async function callIbkrShadowBatch({ tickers, expiration, ibkrExpiration, clientIdStart }) {
  const response = await fetch(`${API_BASE}/shadow/compare/wheel/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tickers,
      expiration,
      ibkrExpiration,
      clientIdStart: Number(clientIdStart),
      marketDataType: 2,
      maxStrikes: 25,
      delayMs: 100,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

async function callIbkrDirectScan({ tickers, expiration, clientIdStart, maxTickers, topN }) {
  const response = await fetch(`${API_BASE}/ibkr/shadow/scan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tickers,
      expiration,
      clientIdStart: Number(clientIdStart),
      maxTickers: Number(maxTickers),
      topN: Number(topN),
      sort: "quality",
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

async function callScanMetrics() {
  const response = await fetch(`${API_BASE}/metrics/scan`);
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function callResetScanMetrics() {
  const response = await fetch(`${API_BASE}/metrics/scan/reset`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

function ymdToIbkr(value) {
  const s = String(value || "").trim();
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}${match[2]}${match[3]}` : s;
}

function getItemExpirationForBatch(item) {
  const raw = item?.expiration ?? item?.targetExpiration ?? "";
  return String(raw || "").trim();
}

function formatIbkrPrice(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(2);
}

function formatIbkrPercent(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(2)}%`;
}

function formatIbkrReason(reason) {
  const translations = {
    directly_below_lower_bound: "Directement sous la borne basse",
    below_aggressive_meets_min_premium: "Plus bas strike sous l’agressif qui respecte la prime cible",
    aggressive_promoted_to_safe_no_lower_acceptable_strike:
      "L’agressif devient aussi le safe : aucun strike plus bas ne respecte la prime cible",
    premium_below_min: "Prime sous la cible minimale",
    above_or_equal_lower_bound: "Rejeté : au-dessus ou égal à la borne basse",
    option_contract_not_qualified: "Contrat option non qualifié par IBKR",
    underlying_contract_not_qualified: "Symbole non reconnu ou contrat sous-jacent non qualifié par IBKR",
    underlying_price_unavailable: "Prix du sous-jacent indisponible",
    atm_straddle_unavailable: "Straddle ATM indisponible",
    no_safe_candidate_meets_min_premium: "Aucun strike safe ne respecte la prime cible",
    no_put_below_lower_bound: "Aucun put disponible sous la borne basse",
    no_put_candidate_below_lower_bound: "Aucun put candidat sous la borne basse",
    no_expected_move_contracts: "Aucun contrat expected move qualifiable",
    no_safe_or_aggressive_strike: "Aucun strike safe ou agressif disponible",
    no_aggressive_strike: "Aucun strike agressif disponible",
    no_bid_ask: "Bid/ask indisponible (souvent hors marché)",
    invalid_bid: "Bid option indisponible ou invalide",
    invalid_ask: "Ask option indisponible ou invalide",
    invalid_mid: "Mid ou spread indisponible",
    dev_display: "Carte DEV hors marché",
    timeout: "Timeout IBKR",
    ibkr_unavailable: "IBKR indisponible",
    OK: "OK",
  };

  if (!reason) return "—";
  return translations[reason] || String(reason).replaceAll("_", " ");
}

/** Spread safe IBKR : fraction 0–1 ou pourcentage déjà > 1. */
function normalizedIbkrSpreadPctPercent(raw) {
  const x = Number(raw);
  if (!Number.isFinite(x)) return null;
  if (x >= 0 && x <= 1.0001) return x * 100;
  return x;
}

function classifySpreadPctPercent(raw) {
  const pct = normalizedIbkrSpreadPctPercent(raw);
  if (pct == null) {
    return {
      label: "spread inconnu",
      reason: "spread indisponible",
      badgeClass: "border-slate-200 bg-slate-50 text-slate-600",
      textClass: "text-slate-500",
      metricTone: "default",
    };
  }
  if (pct <= 5) {
    return {
      label: "liquide",
      reason: "spread faible",
      badgeClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
      textClass: "text-emerald-700",
      metricTone: "good",
    };
  }
  if (pct <= 10) {
    return {
      label: "limite",
      reason: "spread acceptable mais à surveiller",
      badgeClass: "border-yellow-200 bg-yellow-50 text-yellow-800",
      textClass: "text-yellow-800",
      metricTone: "warn",
    };
  }
  if (pct <= 20) {
    return {
      label: "spread large",
      reason: "exécution risquée",
      badgeClass: "border-amber-300 bg-amber-50 text-amber-900",
      textClass: "text-amber-900",
      metricTone: "warn",
    };
  }
  return {
    label: "non actionnable",
    reason: "spread trop large",
    badgeClass: "border-rose-200 bg-rose-50 text-rose-700",
    textClass: "text-rose-700",
    metricTone: "bad",
  };
}

/** Diagnostic spread sur les retenus (safe strike). */
function countIbkrRetainedSafeSpreadBuckets(shortlist) {
  let gt10 = 0;
  let gt20 = 0;
  for (const row of shortlist || []) {
    const pct = normalizedIbkrSpreadPctPercent(row?.safeStrike?.spreadPct ?? row?.spreadPct);
    if (pct == null) continue;
    if (pct > 10) gt10 += 1;
    if (pct > 20) gt20 += 1;
  }
  return { retainedSafeSpreadGt10Pct: gt10, retainedSafeSpreadGt20Pct: gt20 };
}

/** Agrège les raisons de rejet IBKR pour logs et UI. */
function aggregateIbkrRejectedReasons(rejected, limit = 10) {
  const counts = {};
  for (const r of rejected || []) {
    const k = String(r?.reason ?? r?.status ?? "unknown").trim() || "unknown";
    counts[k] = (counts[k] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const topLines = sorted.slice(0, limit).map(([reason, n]) => `${formatIbkrReason(reason)} (${n})`);
  return { counts, sorted, topLines };
}

/** Message UI quand kept = 0 : distinguer rejets métier vs TWS vide. */
function buildIbkrZeroKeptUserMessage(payload) {
  const rejected = Array.isArray(payload?.rejected) ? payload.rejected : [];
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (rejected.length > 0) {
    const { topLines } = aggregateIbkrRejectedReasons(rejected, 10);
    return `IBKR : 0 retenu sur ${payload?.scanned ?? "?"} scanné(s). Raisons : ${topLines.join(" · ")}`;
  }
  if (errors.length > 0) {
    return `IBKR : 0 retenu — ${errors.length} erreur(s) symbole (détails dans le panneau).`;
  }
  return IBKR_NO_KEPT_PRIMARY_MESSAGE;
}

/**
 * Explique filtered.length < scanMeta.kept (filtres UI, topN, expiration).
 * @param {Record<string, unknown>} snap voir displaySnapshotRef
 */
function computeFilteredVsKeptNote(snap) {
  if (!snap || typeof snap !== "object") return "—";
  const filteredLength = Number(snap.filteredLength);
  const scanMetaKept = Number(snap.scanMetaKept);
  const backendCandidatesLength = snap.backendCandidatesLength;
  const backendMatchingExpirationCount = snap.backendMatchingExpirationCount;
  const query = snap.query;
  const filter = snap.filter;
  const topN = snap.topN;
  const dataSource = snap.dataSource;
  if (!Number.isFinite(filteredLength) || !Number.isFinite(scanMetaKept)) return "données affichage incomplètes";
  if (filteredLength >= scanMetaKept) {
    return "cartes affichées ≥ retenus IBKR (pas de perte vs compteur kept)";
  }
  const parts = [];
  const q = String(query ?? "").trim();
  if (q) parts.push(`recherche «${q}»`);
  if (filter && filter !== "all") parts.push(`filtre=${filter}`);
  if (
    Number.isFinite(Number(backendCandidatesLength)) &&
    Number.isFinite(Number(topN)) &&
    Number(topN) < Number(backendCandidatesLength)
  ) {
    parts.push(`topN=${topN} < ${backendCandidatesLength} entrée(s) liste primaire`);
  }
  if (
    Number.isFinite(Number(backendCandidatesLength)) &&
    Number.isFinite(Number(backendMatchingExpirationCount)) &&
    Number(backendMatchingExpirationCount) < Number(backendCandidatesLength)
  ) {
    parts.push(
      `${Number(backendCandidatesLength) - Number(backendMatchingExpirationCount)} carte(s) exclue(s) par expiration`
    );
  }
  if (dataSource === "ibkr_direct" && scanMetaKept > 0 && filteredLength === 0) {
    parts.push("vérifier filtre validés / verdict ou recherche");
  }
  if (!parts.length) parts.push("tri, filtre UI ou rendu transitoire");
  return `filtered (${filteredLength}) < kept (${scanMetaKept}) : ${parts.join(" · ")}`;
}

function logScanDisplayResult(scanId, displaySnapshotRef) {
  if (!scanId) return;
  const snap = displaySnapshotRef?.current && typeof displaySnapshotRef.current === "object"
    ? displaySnapshotRef.current
    : {};
  console.log("[DISPLAY_RESULT]", {
    scanId: String(scanId),
    backendCandidatesLength: snap.backendCandidatesLength ?? null,
    filteredLength: snap.filteredLength ?? null,
    scanMetaKept: snap.scanMetaKept ?? null,
    activeFilter: snap.filter ?? null,
    searchQuery: snap.query ?? "",
    selectedExpiration: snap.selectedExpiration ?? null,
    topN: snap.topN ?? null,
    dataSource: snap.dataSource ?? null,
    filteredVsKeptNote: computeFilteredVsKeptNote(snap),
  });
}

function formatIbkrStatus(status) {
  const translations = {
    kept: "retenu",
    rejected: "rejeté",
    error: "erreur",
    timeout: "timeout",
  };
  return translations[status] || status || "—";
}

function formatDurationShort(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)} ms`;
}

function ibkrBatchStatusUi(status) {
  if (status === "confirmed") {
    return {
      label: "Confirmé",
      summary: "IBKR confirme les strikes Yahoo",
      className: "border-emerald-200 bg-emerald-50 text-emerald-800",
    };
  }
  if (status === "different") {
    return {
      label: "Différent",
      summary: "IBKR diffère de Yahoo — vérifier les détails",
      className: "border-amber-200 bg-amber-50 text-amber-800",
    };
  }
  if (status === "ibkr_unavailable") {
    return {
      label: "IBKR indisponible",
      summary: "IBKR n’a pas pu valider ce ticker",
      className: "border-rose-200 bg-rose-50 text-rose-800",
    };
  }
  if (status === "yahoo_unavailable") {
    return {
      label: "Yahoo indisponible",
      summary: "Yahoo indisponible, IBKR disponible",
      className: "border-orange-200 bg-orange-50 text-orange-800",
    };
  }
  if (status === "both_failed") {
    return {
      label: "Échec deux côtés",
      summary: "Yahoo et IBKR indisponibles",
      className: "border-rose-200 bg-rose-50 text-rose-800",
    };
  }
  return null;
}

function IbkrStrikeBlock({ title, strike }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="mb-3 text-sm font-semibold text-slate-900">{title}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Metric label="Strike" value={formatIbkrPrice(strike?.strike)} strong />
        <Metric label="Bid" value={formatIbkrPrice(strike?.bid)} />
        <Metric label="Ask" value={formatIbkrPrice(strike?.ask)} />
        <Metric label="Mid" value={formatIbkrPrice(strike?.mid)} />
        <Metric label="Spread" value={formatIbkrPrice(strike?.spread)} />
        <Metric label="Spread %" value={formatIbkrPercent(strike?.spreadPct)} />
        <Metric label="Prime utilisée" value={formatIbkrPrice(strike?.primeUsed)} strong />
        <Metric label="Prime vs cible" value={formatIbkrPrice(strike?.premiumVsTarget)} />
        <Metric label="Raison" value={formatIbkrReason(strike?.selectionReason)} />
      </div>
    </div>
  );
}

function IbkrShadowCard({
  symbol,
  setSymbol,
  expiration,
  setExpiration,
  clientId,
  setClientId,
  loading,
  error,
  result,
  onRun,
}) {
  return (
    <Card className="mb-6 rounded-[28px] border-slate-200 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl text-slate-900">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              IBKR Shadow — lecture seule
            </CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Lecture seule. Aucun ordre envoyé. Yahoo reste la source principale.
            </p>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-400">
              IBKR Shadow utilise les données disponibles selon TWS/Gateway. Hors marché, les prix
              peuvent être frozen/delayed. Ce panneau sert à valider la logique, pas à exécuter.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Symbole</label>
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="w-full rounded-xl border-slate-200"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Expiration</label>
            <Input
              value={expiration}
              onChange={(e) => setExpiration(e.target.value)}
              className="w-full rounded-xl border-slate-200"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Client ID</label>
            <Input
              type="number"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-xl border-slate-200"
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full rounded-xl" onClick={onRun} disabled={loading}>
              Tester IBKR Shadow
            </Button>
          </div>
        </div>

        {loading && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            Analyse IBKR Shadow en cours…
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            Erreur réseau IBKR Shadow : {error}
          </div>
        )}

        {result?.ok === false && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">IBKR Shadow a retourné une erreur métier.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Metric label="Symbol" value={result.symbol || "—"} tone="warn" />
              <Metric label="Error" value={formatIbkrReason(result.error)} tone="warn" />
              <Metric label="Mode" value={result.mode || "—"} tone="warn" />
              <Metric label="Read only" value={String(result.readOnly ?? "—")} tone="warn" />
              <Metric label="Can trade" value={String(result.canTrade ?? "—")} tone="warn" />
            </div>
          </div>
        )}

        {result?.ok === true && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <Metric label="Mode" value={result.mode || "—"} tone="good" />
              <Metric label="Read only" value={String(result.readOnly ?? "—")} tone="good" />
              <Metric label="Can trade" value={String(result.canTrade ?? "—")} tone="good" />
              <Metric
                label="Startup fetch disabled"
                value={String(result.startupFetchDisabled ?? "—")}
                tone="good"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              <Metric label="Symbol" value={result.symbol || "—"} strong />
              <Metric label="Expiration" value={result.expiration || "—"} />
              <Metric label="Prix actuel" value={formatIbkrPrice(result.underlyingPrice)} />
              <Metric label="Expected move" value={formatIbkrPrice(result.expectedMove)} />
              <Metric label="Borne basse" value={formatIbkrPrice(result.lowerBound)} />
              <Metric label="Borne haute" value={formatIbkrPrice(result.upperBound)} />
              <Metric label="Prime cible" value={formatIbkrPrice(result.targetPremium)} strong />
            </div>

            <IbkrStrikeBlock title="Strike agressif" strike={result.aggressiveStrike} />
            <IbkrStrikeBlock title="Strike safe" strike={result.safeStrike} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function IbkrDirectScanPanel({
  clientIdStart,
  setClientIdStart,
  maxTickers,
  setMaxTickers,
  topN,
  setTopN,
  expiration,
  tickerCount,
  loading,
  error,
  result,
  sentTickers,
  onRun,
  onRunTest,
}) {
  const shortlist = Array.isArray(result?.shortlist) ? result.shortlist : [];
  const shortlistDev =
    result?.devScanEnabled === true && Array.isArray(result?.shortlistDev) ? result.shortlistDev : [];
  const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const rejectedReasonSummary = aggregateIbkrRejectedReasons(rejected, 10);
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const hasBatchTimeout = warnings.includes("ibkr_shadow_batch_timeout");
  const hasMissingIbkrDuration = result?.ok === true && result?.ibkrDurationMs == null;
  const isSuspiciousEmpty =
    result?.ibkrSuspiciousEmpty === true ||
    (result?.ok === true &&
      !hasBatchTimeout &&
      Number(result?.scanned || 0) > 0 &&
      Number(result?.kept ?? 0) === 0 &&
      shortlist.length === 0 &&
      shortlistDev.length === 0 &&
      rejected.length === 0 &&
      errors.length === 0);
  const rawPayload = result ? JSON.stringify(result, null, 2) : "";

  return (
    <Card className="mb-6 rounded-[28px] border-slate-200 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xl text-slate-900">
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
          IBKR Direct Scan — lecture seule
          {result?.configuredDevScanMode === "auto" ? (
            <Badge className="rounded-full border border-slate-400 bg-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-800">
              Mode auto
            </Badge>
          ) : null}
        </CardTitle>
        <p className="mt-1 text-sm text-slate-500">
          Scan IBKR indépendant. Yahoo construit la shortlist technique; IBKR valide les options en lecture
          seule. Aucun ordre envoyé.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Expiration IBKR : <span className="font-medium text-slate-700">{expiration || "—"}</span> ·
          Watchlist disponible : <span className="font-medium text-slate-700">{tickerCount}</span> titres
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Tickers envoyés :{" "}
          <span className="font-medium text-slate-700">
            {sentTickers.length ? sentTickers.join(", ") : "—"}
          </span>
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Client ID start</label>
            <Input
              type="number"
              value={clientIdStart}
              onChange={(e) => setClientIdStart(e.target.value)}
              className="w-full rounded-xl border-slate-200"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Max titres</label>
            <Select
              value={String(maxTickers)}
              onChange={(e) => setMaxTickers(Number(e.target.value))}
              className="w-full rounded-xl border-slate-200"
            >
              <option value="3">3</option>
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </Select>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Top N</label>
            <Select
              value={String(topN)}
              onChange={(e) => setTopN(Number(e.target.value))}
              className="w-full rounded-xl border-slate-200"
            >
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
            </Select>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <Button className="w-full rounded-xl" onClick={onRun} disabled={loading || tickerCount === 0}>
              Scanner watchlist avec IBKR
            </Button>
            <Button className="w-full rounded-xl" variant="outline" onClick={onRunTest} disabled={loading}>
              Test TQQQ/AFRM/SOXL
            </Button>
          </div>
        </div>

        {Number(maxTickers) >= 20 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
            IBKR complet peut être lent : environ 9-10 sec par ticker. 20 titres peut dépasser 3 minutes.
          </div>
        )}

        {loading && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            Scan direct IBKR en cours…
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            Erreur IBKR Direct Scan : {error}
          </div>
        )}

        {result?.ok === false && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <p className="font-semibold">IBKR Direct Scan a retourné ok:false.</p>
            <p className="mt-1">Erreur : {result.error || "non retournée"}</p>
          </div>
        )}

        {result?.ok === true && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">
              Source active : IBKR Shadow Scan direct
            </div>

            {Boolean(result.warning || result.devScanEnabled) && (
              <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-semibold text-amber-950">
                {result.warning || "DEV TEST — données possiblement figées / non tradables"}
              </div>
            )}

            {hasBatchTimeout && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
                Timeout IBKR : le batch a dépassé la limite avant de retourner les résultats. Réduire Max titres à 10 ou moins.
              </div>
            )}

            {isSuspiciousEmpty && (
              <div className="rounded-2xl border border-amber-300 bg-amber-100 p-4 text-sm font-semibold text-amber-900">
                {IBKR_TWS_EMPTY_MESSAGE}
              </div>
            )}

            {result?.ok === true &&
              !isSuspiciousEmpty &&
              Number(result?.kept ?? 0) === 0 &&
              rejected.length > 0 && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                  <p className="font-semibold">
                    0 retenu IBKR — rejets connus par symbole (pas une réponse « vide » type TWS si cette liste est
                    remplie).
                  </p>
                  <ul className="mt-2 max-h-56 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
                    {rejected.slice(0, 30).map((r, i) => (
                      <li key={`ibkr-panel-rej-${r?.symbol ?? i}-${i}`}>
                        <span className="font-medium text-slate-900">{r?.symbol ?? "—"}</span>
                        {" — "}
                        {formatIbkrReason(r?.reason)}
                      </li>
                    ))}
                  </ul>
                  {rejectedReasonSummary.topLines.length > 0 && (
                    <p className="mt-2 text-xs text-amber-900">
                      Synthèse : {rejectedReasonSummary.topLines.join(" · ")}
                    </p>
                  )}
                </div>
              )}

            <div className="grid gap-3 md:grid-cols-4">
              <Metric label="Scannés" value={String(result.scanned ?? "—")} strong />
              <Metric label="Retenus" value={String(result.kept ?? "—")} tone="good" />
              <Metric label="Retournés" value={String(result.returned ?? "—")} />
              <Metric
                label="Durée totale"
                value={result.durationMs == null ? "non retourné" : `${result.durationMs} ms`}
              />
              <Metric
                label="Durée IBKR"
                value={result.ibkrDurationMs == null ? "non retourné" : `${result.ibkrDurationMs} ms`}
                tone={result.ibkrDurationMs == null ? "warn" : "default"}
              />
              <Metric label="Erreurs" value={String(errors.length)} tone={errors.length ? "warn" : "good"} />
              <Metric label="Rejetés" value={String(rejected.length)} tone={rejected.length ? "warn" : "good"} />
              <Metric label="Read only" value={String(result.readOnly ?? "—")} tone="good" />
              <Metric label="Timeout max" value={result.batchTimeoutMs == null ? "—" : `${result.batchTimeoutMs} ms`} />
              {result.devScanEnabled && (
                <Metric
                  label="DEV affichés (max Top N)"
                  value={String(result.devDisplayedReturned ?? shortlistDev.length ?? "—")}
                  tone="warn"
                />
              )}
            </div>

            <div className="space-y-3">
              <p className="font-semibold text-slate-900">Shortlist IBKR</p>
              {shortlist.map((item) => (
                <div key={`ibkr-direct-${item.symbol}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="text-lg font-semibold text-slate-900">{item.symbol}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        Spot {formatMoneyOrDash(item.currentPrice ?? item.underlyingPrice)} · Borne basse{" "}
                        {formatMoneyOrDash(item.lowerBound)} · Prime cible {formatMoneyOrDash(item.targetPremium)}
                      </p>
                    </div>
                    <div className="text-sm font-medium text-slate-700">
                      Yield {formatIbkrPercent(item.weeklyYield)} · Spread {formatIbkrPercent(item.spreadPct)} · Prime{" "}
                      {formatMoneyOrDash(item.premiumUsed)}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <IbkrMiniStrikeDetails title="Safe IBKR" strike={item.safeStrike} />
                    <IbkrMiniStrikeDetails title="Agressif IBKR" strike={item.aggressiveStrike} />
                  </div>

                  {Array.isArray(item.qualityReasons) && item.qualityReasons.length > 0 && (
                    <p className="mt-3 text-xs leading-5 text-slate-600">
                      {item.qualityReasons.filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
              ))}
              {shortlist.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
                  Aucun candidat IBKR direct retenu (mode LIVE).
                </div>
              )}
            </div>

            {shortlistDev.length > 0 && (
              <div className="space-y-3">
                <p className="font-semibold text-amber-950">Shortlist DEV — affichage hors marché uniquement</p>
                <p className="text-xs text-amber-900">
                  Ces cartes servent à tester l’UI ; ne pas utiliser pour prendre des décisions réelles.
                </p>
                {shortlistDev.map((item) => (
                  <div
                    key={`ibkr-direct-dev-${item.symbol}`}
                    className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4"
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="text-lg font-semibold text-slate-900">{item.symbol}</p>
                        <p className="mt-1 text-xs text-slate-600">
                          statut {formatIbkrReason(item.status)} · {formatIbkrReason(item.reason)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Spot {formatMoneyOrDash(item.currentPrice ?? item.underlyingPrice)} · Borne basse{" "}
                          {formatMoneyOrDash(item.lowerBound)} · Prime cible{" "}
                          {formatMoneyOrDash(item.targetPremium)}
                        </p>
                      </div>
                      <div className="text-sm font-medium text-slate-700">
                        Yield {formatIbkrPercent(item.weeklyYield)} · Spread{" "}
                        {formatIbkrPercent(item.spreadPct)} · Prime {formatMoneyOrDash(item.premiumUsed)}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <IbkrMiniStrikeDetails title="Safe IBKR (DEV)" strike={item.safeStrike} />
                      <IbkrMiniStrikeDetails title="Agressif IBKR (DEV)" strike={item.aggressiveStrike} />
                    </div>
                    {Array.isArray(item.qualityReasons) && item.qualityReasons.length > 0 && (
                      <p className="mt-3 text-xs leading-5 text-amber-950">
                        {item.qualityReasons.filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {rejected.length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="mb-2 font-semibold">Principaux rejetés IBKR</p>
                <div className="space-y-1">
                  {rejected.slice(0, 10).map((row) => (
                    <div key={`ibkr-direct-rejected-${row.symbol}-${row.reason}`}>
                      {row.symbol || "—"} : {formatIbkrReason(row.reason)} · cible{" "}
                      {formatMoneyOrDash(row.targetPremium)} · agressif{" "}
                      {formatStrikeOrDash(row.aggressiveStrike?.strike)} · bid{" "}
                      {formatMoneyOrDash(row.aggressiveStrike?.bid)} · ask{" "}
                      {formatMoneyOrDash(row.aggressiveStrike?.ask)} · prime{" "}
                      {formatMoneyOrDash(row.aggressiveStrike?.primeUsed)} · durée{" "}
                      {row.durationMs == null ? "non retourné" : `${row.durationMs} ms`}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(hasMissingIbkrDuration || isSuspiciousEmpty) && (
              <div className="rounded-2xl border border-slate-200 bg-slate-950 p-4 text-xs text-slate-100">
                <p className="mb-2 font-semibold">Payload brut compact</p>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{rawPayload}</pre>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
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
            ) : relevantEarningsDate ? (
              <p className="mt-1 text-sm text-violet-700">
                Earnings: {formatShortDate(relevantEarningsDate) || relevantEarningsDate}
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
                premiumUsed={item.safeStrike.premiumUsed}
                premiumLabel={item.safeStrike.premiumLabel}
                popEstimate={item.safeStrike.popEstimate}
                popProfitEstimated={item.safeStrike.popProfitEstimated}
                popOtmEstimated={item.safeStrike.popOtmEstimated}
                popSource={item.safeStrike.popSource}
                tradeYield={item.safeStrike.weeklyYield}
                weeklyNormalizedYield={item.safeStrike.weeklyNormalizedYield}
                annualizedYield={item.safeStrike.annualizedYield}
                distancePct={item.safeStrike.distancePct}
                label="safe strike"
                meetsTarget={
                Number.isFinite(Number(item.safeStrike.mid)) &&
                Number(item.safeStrike.mid) >= Number(item.minPremium || 0)
              }
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
                premiumUsed={item.aggressiveStrike.premiumUsed}
                premiumLabel={item.aggressiveStrike.premiumLabel}
                popEstimate={item.aggressiveStrike.popEstimate}
                popProfitEstimated={item.aggressiveStrike.popProfitEstimated}
                popOtmEstimated={item.aggressiveStrike.popOtmEstimated}
                popSource={item.aggressiveStrike.popSource}
                tradeYield={item.aggressiveStrike.weeklyYield}
                weeklyNormalizedYield={item.aggressiveStrike.weeklyNormalizedYield}
                annualizedYield={item.aggressiveStrike.annualizedYield}
                distancePct={item.aggressiveStrike.distancePct}
                label="aggressive strike"
                meetsTarget={
                Number.isFinite(Number(item.aggressiveStrike.mid)) &&
                Number(item.aggressiveStrike.mid) >= Number(item.minPremium || 0)
              }
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
                  className="grid grid-cols-7 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm"
                >
                  <div className="font-semibold text-slate-900">{pick.ticker}</div>
                  <div>PUT {pick.strike}$</div>
                  <div>{pick.source || "Yahoo fallback"}</div>
                  <div>
                    {pick.premiumKind || "prime"} {pick.premiumUnit != null ? `${Number(pick.premiumUnit).toFixed(2)}$` : "—"}
                  </div>
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
  const [sortBy, setSortBy] = useState("quality");
  const [sortOrder, setSortOrder] = useState("desc");
  const [selectedItem, setSelectedItem] = useState(null);

  const [selectedExpiration, setSelectedExpiration] = useState(() =>
    pickDefaultExpiration(DEFAULT_EXPIRATIONS)
  );
  const selectedExpirationRef = useRef(selectedExpiration);

  useEffect(() => {
    selectedExpirationRef.current = selectedExpiration;
  }, [selectedExpiration]);

  const expirationOptions = useMemo(() => futureExpirations(DEFAULT_EXPIRATIONS), []);
  const [topN, setTopN] = useState(() => readStoredNumber("wheel.topYahooReturned", 30));
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
  const [primaryIbkrSourceInfo, setPrimaryIbkrSourceInfo] = useState(null);
  const [scanMeta, setScanMeta] = useState({
    scanned: 0,
    kept: 0,
    returned: 0,
  });
  const [yahooScanMeta, setYahooScanMeta] = useState({
    scanned: 0,
    kept: 0,
    returned: 0,
  });
  const [yahooReturnedCandidates, setYahooReturnedCandidates] = useState([]);
  /** Dernier /scan_shortlist : payload.devScanEnabled (absent du backend → reste false). */
  const [backendShortlistDevScan, setBackendShortlistDevScan] = useState(false);
  /** True seulement si la shortlist affichée vient du LAST_GOOD_SCAN_KEY après échec réseau/API. */
  const [closedMarketCacheFallback, setClosedMarketCacheFallback] = useState(false);
  const [ibkrShadowSymbol, setIbkrShadowSymbol] = useState("NVDA");
  const [ibkrShadowExpiration, setIbkrShadowExpiration] = useState("20260501");
  const [ibkrShadowClientId, setIbkrShadowClientId] = useState("240");
  const [ibkrShadowLoading, setIbkrShadowLoading] = useState(false);
  const [ibkrShadowError, setIbkrShadowError] = useState("");
  const [ibkrShadowResult, setIbkrShadowResult] = useState(null);
  const [ibkrBatchClientIdStart, setIbkrBatchClientIdStart] = useState("400");
  const [ibkrBatchLoading, setIbkrBatchLoading] = useState(false);
  const [ibkrBatchError, setIbkrBatchError] = useState("");
  const [ibkrBatchResult, setIbkrBatchResult] = useState(null);
  const [ibkrDirectClientIdStart, setIbkrDirectClientIdStart] = useState("500");
  const [ibkrDirectMaxTickers, setIbkrDirectMaxTickers] = useState(10);
  const [ibkrDirectTopN, setIbkrDirectTopN] = useState(10);
  const [ibkrDirectLoading, setIbkrDirectLoading] = useState(false);
  const [ibkrDirectError, setIbkrDirectError] = useState("");
  const [ibkrDirectResult, setIbkrDirectResult] = useState(null);
  const [ibkrDirectSentTickers, setIbkrDirectSentTickers] = useState([]);
  const [autoIbkrDirectScan, setAutoIbkrDirectScan] = useState(true);
  const [ibkrAutoMaxTickers, setIbkrAutoMaxTickers] = useState(10);
  const [ibkrAutoTopN] = useState(10);
  const [ibkrAutoClientIdStart] = useState("500");
  const [refreshStage, setRefreshStage] = useState("");
  const [ibkrAutoRankDiagnostics, setIbkrAutoRankDiagnostics] = useState([]);
  const yahooRankForIbkrBySymbol = useMemo(() => {
    const entries = (ibkrAutoRankDiagnostics || [])
      .filter((row) => row?.selectionMode === "yahoo_shortlist" && row?.rank != null)
      .map((row) => [String(row.symbol || "").trim().toUpperCase(), Number(row.rank)]);
    return new Map(entries.filter(([symbol, rank]) => symbol && Number.isFinite(rank)));
  }, [ibkrAutoRankDiagnostics]);
  /** "yahoo_shortlist" | "watchlist_fallback" | "" */
  const [ibkrAutoTickerSource, setIbkrAutoTickerSource] = useState("");
  const [scanMetricsLoading, setScanMetricsLoading] = useState(false);
  const [scanMetricsError, setScanMetricsError] = useState("");
  const [scanMetricsData, setScanMetricsData] = useState(null);
  const technicalCandidatesRef = useRef(new Map());
  /** Snapshot dernier rendu pour [DISPLAY_RESULT] (refs = pas de stale closure). */
  const displaySnapshotRef = useRef({});

  /** Changement d’expiration : purge shortlist/Yahoo persistée et résultats IBKR. */
  useEffect(() => {
    setIbkrDirectResult(null);
    setPrimaryIbkrSourceInfo(null);
    setIbkrDirectSentTickers([]);
    setIbkrDirectError("");
    setIbkrAutoTickerSource("");
    setIbkrAutoRankDiagnostics([]);
    setBackendCandidates(null);
    setDataSource("snapshot");
    setScanMeta({ scanned: 0, kept: 0, returned: 0 });
    setYahooScanMeta({ scanned: 0, kept: 0, returned: 0 });
    setYahooReturnedCandidates([]);
    setBackendShortlistDevScan(false);
    setClosedMarketCacheFallback(false);
    technicalCandidatesRef.current.clear();
  }, [selectedExpiration]);

  const hasValidClosedMarketCache = useMemo(
    () => hasValidLastGoodScanForExpiration(selectedExpiration),
    [selectedExpiration, backendCandidates, dataSource]
  );

  const snapshotCandidates = useMemo(() => {
    return wheelShortlist
      .slice()
      .map((item, index) => toDashboardCandidate(item, index, selectedExpiration));
  }, [selectedExpiration]);

  /** Uniquement la shortlist IBKR actionnable — pas les entrées DEV (affichées dans le panneau IBKR). */
  const ibkrDirectByTicker = useMemo(() => {
    const rows = Array.isArray(ibkrDirectResult?.shortlist) ? ibkrDirectResult.shortlist : [];
    const entries = rows.map((row) => [String(row?.symbol || "").trim().toUpperCase(), row]);
    return new Map(entries.filter(([ticker]) => Boolean(ticker)));
  }, [ibkrDirectResult]);

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

  const enrichedCandidates = useMemo(() => {
    const usedSymbols = new Set();
    const enriched = activeCandidates.map((item, index) => {
      const symbol = String(item?.ticker || "").trim().toUpperCase();
      usedSymbols.add(symbol);
      const ibkrCandidate = ibkrDirectByTicker.get(symbol);
      return ibkrCandidate
        ? mergeIbkrIntoDashboardCandidate(item, ibkrCandidate, index, selectedExpiration)
        : item;
    });

    for (const [symbol, ibkrCandidate] of ibkrDirectByTicker.entries()) {
      if (usedSymbols.has(symbol)) continue;
      enriched.push(
        mergeIbkrIntoDashboardCandidate(null, ibkrCandidate, enriched.length, selectedExpiration)
      );
    }

    return enriched.map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
  }, [activeCandidates, ibkrDirectByTicker, selectedExpiration]);

  const filtered = useMemo(() => {
    const filteredItems = enrichedCandidates.filter((item) => {
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
      if (sortBy === "quality") return item.qualityScore ?? Number.NEGATIVE_INFINITY;
      if (sortBy === "weeklyReturn") return item.weeklyReturn ?? 0;
      if (sortBy === "spread") {
        const spread = item.safeStrike?.liquidity?.spreadPct ?? item.aggressiveStrike?.liquidity?.spreadPct;
        return spread ?? Number.POSITIVE_INFINITY;
      }
      return item.strikeDistance ?? 0;
    };
    return filteredItems
      .slice()
      .sort((a, b) => {
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
      })
      .filter((item) => candidateRowMatchesSelectedExpiration(item, selectedExpiration));
  }, [enrichedCandidates, query, filter, sortBy, sortOrder, selectedExpiration]);

  useEffect(() => {
    const bc = backendCandidates;
    const bLen = Array.isArray(bc) ? bc.length : null;
    const matchingExp =
      bLen && selectedExpiration
        ? bc.filter((c) => candidateRowMatchesSelectedExpiration(c, selectedExpiration)).length
        : null;
    displaySnapshotRef.current = {
      filteredLength: filtered.length,
      scanMetaKept: scanMeta.kept,
      scanMetaReturned: scanMeta.returned,
      filter,
      query,
      selectedExpiration,
      topN,
      backendCandidatesLength: bLen,
      backendMatchingExpirationCount: matchingExp,
      dataSource,
    };
  }, [
    filtered,
    scanMeta,
    filter,
    query,
    selectedExpiration,
    topN,
    backendCandidates,
    dataSource,
  ]);

  const ibkrBatchTickers = useMemo(
    () =>
      [...new Set(filtered.map((item) => String(item?.ticker || "").trim().toUpperCase()).filter(Boolean))],
    [filtered]
  );
  const ibkrBatchTickersForSend = useMemo(() => ibkrBatchTickers.slice(0, 50), [ibkrBatchTickers]);
  const ibkrBatchExpirationInfo = useMemo(() => {
    const expirations = [
      ...new Set(filtered.map((item) => getItemExpirationForBatch(item)).filter(Boolean)),
    ];
    if (expirations.length > 1) {
      return {
        error:
          "Impossible de valider IBKR : plusieurs expirations différentes dans la shortlist affichée.",
        usedExpiration: null,
        ibkrExpiration: null,
      };
    }
    const usedExpiration = expirations[0] || selectedExpiration;
    return {
      error: "",
      usedExpiration,
      ibkrExpiration: ymdToIbkr(usedExpiration),
    };
  }, [filtered, selectedExpiration]);
  const ibkrBatchByTicker = useMemo(() => {
    const rows = Array.isArray(ibkrBatchResult?.results) ? ibkrBatchResult.results : [];
    return new Map(
      rows
        .map((row) => [String(row?.symbol || "").trim().toUpperCase(), row])
        .filter(([ticker]) => Boolean(ticker))
    );
  }, [ibkrBatchResult]);
  const ibkrRejectedSymbols = useMemo(() => {
    const rows = Array.isArray(ibkrDirectResult?.rejected) ? ibkrDirectResult.rejected : [];
    return new Set(
      rows
        .map((row) => String(row?.symbol || "").trim().toUpperCase())
        .filter(Boolean)
    );
  }, [ibkrDirectResult]);

  const combos = useMemo(() => {
    return buildPortfolioCombos(
      filtered,
      Number(capital),
      Number(maxCapitalPct),
      Number(maxPositions),
      ibkrRejectedSymbols
    );
  }, [filtered, capital, maxCapitalPct, maxPositions, ibkrRejectedSymbols]);

  const tickersForScan = watchlistTickers ?? FALLBACK_TICKERS;
  const ibkrDirectTickers = useMemo(
    () => [...new Set((tickersForScan || []).map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))],
    [tickersForScan]
  );
  const manualIbkrDirectSend = useMemo(
    () =>
      getManualIbkrTickersForSend({
        ibkrDirectMaxTickers,
        fallbackWatchlistTickers: ibkrDirectTickers,
        dataSource,
        backendCandidates,
        filteredDisplayedCandidates: filtered,
      }),
    [ibkrDirectMaxTickers, ibkrDirectTickers, dataSource, backendCandidates, filtered]
  );
  const ibkrDirectTickersForSend = manualIbkrDirectSend.tickers;
  const ibkrManualSendSource = manualIbkrDirectSend.source;
  const ibkrSentCount = Array.isArray(ibkrDirectSentTickers) ? ibkrDirectSentTickers.length : 0;
  const yahooReturnedCount = Array.isArray(yahooReturnedCandidates) ? yahooReturnedCandidates.length : 0;
  const ibkrRejectedCount = Array.isArray(ibkrDirectResult?.rejected) ? ibkrDirectResult.rejected.length : 0;
  const ibkrKeptCount = Number.isFinite(Number(ibkrDirectResult?.kept))
    ? Number(ibkrDirectResult.kept)
    : Array.isArray(ibkrDirectResult?.shortlist)
    ? ibkrDirectResult.shortlist.length
    : 0;
  const ibkrSentSet = useMemo(
    () => new Set((ibkrDirectSentTickers || []).map((t) => String(t || "").trim().toUpperCase()).filter(Boolean)),
    [ibkrDirectSentTickers]
  );
  const yahooNonSentCandidates = useMemo(() => {
    const offset = ibkrSentCount > 0 ? ibkrSentCount : Number(ibkrAutoMaxTickers) || 10;
    return (yahooReturnedCandidates || [])
      .slice(offset, 30)
      .filter((item) => !ibkrSentSet.has(String(item?.ticker || "").trim().toUpperCase()));
  }, [yahooReturnedCandidates, ibkrSentSet, ibkrSentCount, ibkrAutoMaxTickers]);
  const sofiDiagnostic = useMemo(() => {
    const watchlist = Array.isArray(tickersForScan) ? tickersForScan : [];
    const watchlistIndex = watchlist.findIndex((t) => String(t || "").trim().toUpperCase() === "SOFI");
    const yahooIndex = (yahooReturnedCandidates || []).findIndex(
      (item) => String(item?.ticker || "").trim().toUpperCase() === "SOFI"
    );
    const sent = ibkrSentSet.has("SOFI");
    return {
      inWatchlist: watchlistIndex >= 0,
      watchlistRank: watchlistIndex >= 0 ? watchlistIndex + 1 : null,
      inYahoo: yahooIndex >= 0,
      yahooRank: yahooIndex >= 0 ? yahooIndex + 1 : null,
      sent,
    };
  }, [tickersForScan, yahooReturnedCandidates, ibkrSentSet]);
  const yahooActionabilityCounts = useMemo(() => {
    let actionable = 0;
    let watch = 0;
    let nonActionable = 0;
    for (const item of yahooReturnedCandidates || []) {
      const spreadPct = normalizedIbkrSpreadPctPercent(item?.safeStrike?.liquidity?.spreadPct);
      const hasEarningsBeforeExpiration =
        item?.hasUpcomingEarningsBeforeExpiration === true ||
        item?.hasEarningsBeforeExpiration === true ||
        item?.hasEarnings === true;
      if (hasEarningsBeforeExpiration || (spreadPct != null && spreadPct > 20)) {
        nonActionable += 1;
      } else if (spreadPct != null && spreadPct > 10 && spreadPct <= 20) {
        watch += 1;
      } else if (spreadPct != null && spreadPct <= 10) {
        actionable += 1;
      }
    }
    return { actionable, watch, nonActionable };
  }, [yahooReturnedCandidates]);
  const yahooCandidateByTicker = useMemo(() => {
    return new Map(
      activeCandidates
        .map((item) => [String(item?.ticker || "").trim().toUpperCase(), item])
        .filter(([ticker]) => Boolean(ticker))
    );
  }, [activeCandidates]);
  const mergedIbkrYahooCandidates = useMemo(() => {
    const ibkrShortlist = Array.isArray(ibkrDirectResult?.shortlist) ? ibkrDirectResult.shortlist : [];
    return ibkrShortlist.map((ibkrCandidate) => {
      const symbol = String(ibkrCandidate?.symbol || "").trim().toUpperCase();
      return mergeYahooAndIbkrCandidate(yahooCandidateByTicker.get(symbol) ?? null, ibkrCandidate);
    });
  }, [ibkrDirectResult, yahooCandidateByTicker]);
  const mergedIbkrYahooCandidatesForPanel = useMemo(
    () =>
      mergedIbkrYahooCandidates.filter((item) =>
        candidateRowMatchesSelectedExpiration(item, selectedExpiration)
      ),
    [mergedIbkrYahooCandidates, selectedExpiration]
  );
  const ibkrTopCostlySymbols = useMemo(() => {
    const bySymbol = scanMetricsData?.ibkr?.bySymbol;
    if (!bySymbol || typeof bySymbol !== "object") return [];
    return Object.entries(bySymbol)
      .map(([symbol, row]) => ({
        symbol,
        approxIbkrCalls: Number(row?.approxIbkrCalls || 0),
        optionQualifyCalls: Number(row?.optionQualifyCalls || 0),
        optionMarketDataRequests: Number(row?.optionMarketDataRequests || 0),
        cancelMarketDataCalls: Number(row?.cancelMarketDataCalls || 0),
        durationMs: Number(row?.durationMs || 0),
      }))
      .sort((a, b) => b.approxIbkrCalls - a.approxIbkrCalls)
      .slice(0, 5);
  }, [scanMetricsData]);
  const ibkrTickerDetailRows = useMemo(() => {
    const bySymbol =
      ibkrDirectResult?.ibkrCallMetrics?.bySymbol ??
      scanMetricsData?.ibkr?.bySymbol;
    if (!bySymbol || typeof bySymbol !== "object") return [];
    return Object.entries(bySymbol)
      .map(([symbol, row]) => {
        const durationMs = row?.lastDurationMs ?? row?.durationMs;
        const approxCalls = row?.approxCalls ?? row?.approxIbkrCalls;
        return {
          symbol,
          status: row?.status ?? "—",
          durationMs,
          approxCalls,
          optionQualifyCalls: row?.optionQualifyCalls ?? 0,
          optionMarketDataRequests: row?.optionMarketDataRequests ?? 0,
          reason: row?.reason ?? "—",
        };
      })
      .sort((a, b) => Number(b.approxCalls || 0) - Number(a.approxCalls || 0));
  }, [ibkrDirectResult, scanMetricsData]);
  const candidateByTickerForPreIbkr = useMemo(
    () =>
      new Map(
        enrichedCandidates
          .map((item) => [String(item?.ticker || "").trim().toUpperCase(), item])
          .filter(([ticker]) => Boolean(ticker))
      ),
    [enrichedCandidates]
  );

  const rememberTechnicalCandidates = useCallback((items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const store = technicalCandidatesRef.current;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const keys = buildCandidateLookupKeys(item);
      if (!keys.length) continue;
      for (const key of keys) {
        const existing = store.get(key);
        if (!existing) {
          store.set(key, item);
          continue;
        }
        const existingScore = technicalCompletenessScore(existing);
        const incomingScore = technicalCompletenessScore(item);
        if (incomingScore > existingScore) {
          store.set(key, item);
        }
      }
    }
  }, []);

  const applyIbkrDirectShortlistToPrimary = useCallback(
    (payload) => {
      if (payload?.ok !== true) return false;
      if (!ibkrPayloadExpirationMatchesSelected(payload, selectedExpirationRef.current)) {
        console.warn("Ignored stale scan payload: IBKR primary expiration mismatch vs selection", {
          payloadExpiration: payload?.expiration,
          selectedExpiration: selectedExpirationRef.current,
        });
        return false;
      }
      const shortlistNorm = Array.isArray(payload?.shortlist) ? payload.shortlist : [];
      const shortlistDev =
        payload?.devScanEnabled === true && Array.isArray(payload?.shortlistDev)
          ? payload.shortlistDev
          : [];
      if (shortlistNorm.length === 0) return false;
      rememberTechnicalCandidates(activeCandidates);
      rememberTechnicalCandidates(backendCandidates);
      rememberTechnicalCandidates(mergedIbkrYahooCandidates);

      const mapped = shortlistNorm.map((ibkrCandidate, index) => {
        const lookupKeys = buildCandidateLookupKeys(ibkrCandidate);
        const yahooCandidate =
          lookupKeys
            .map((key) => technicalCandidatesRef.current.get(key) ?? yahooCandidateByTicker.get(key))
            .find(Boolean) ?? null;
        return mergeIbkrIntoDashboardCandidate(yahooCandidate, ibkrCandidate, index, selectedExpiration);
      });

      setBackendCandidates(mapped);
      setDataSource("ibkr_direct");
      setScanMeta({
        scanned: Number(payload?.scanned ?? shortlistNorm.length),
        kept: Number(payload?.kept ?? shortlistNorm.length),
        returned: shortlistNorm.length,
      });
      setPrimaryIbkrSourceInfo({
        twoPhaseEnabled: payload?.twoPhaseEnabled === true,
        devScanEnabled: payload?.devScanEnabled === true,
        devDisplayed: payload?.devDisplayedReturned ?? payload?.devDisplayed ?? shortlistDev.length,
      });
      setScanError("");
      return true;
    },
    [
      selectedExpiration,
      yahooCandidateByTicker,
      activeCandidates,
      backendCandidates,
      mergedIbkrYahooCandidates,
      rememberTechnicalCandidates,
    ]
  );

  const isRefreshingRef = useRef(false);
  const runAutoIbkrDirectScanRef = useRef(null);

  const runAutoIbkrDirectScan = useCallback(
    async (ibkrAutoInput) => {
      if (!autoIbkrDirectScan) return;
      if (!ibkrAutoInput || typeof ibkrAutoInput !== "object") return;

      const scanId = ibkrAutoInput.scanId != null ? String(ibkrAutoInput.scanId) : "no-scan-id";
      const { mode, orderedSymbols, expirationYmd, candidateBySymbol } = ibkrAutoInput;
      const expLocked = expirationYmd != null ? String(expirationYmd).trim() : "";
      if (!expLocked) return;
      if (normalizeExpirationYmd(selectedExpirationRef.current) !== normalizeExpirationYmd(expLocked)) {
        return;
      }

      const maxN = Number(ibkrAutoMaxTickers) || 10;
      /** @type {{ symbol: string, score?: number, reasons: string[], tierBoost?: number, rank?: number, selectionMode: "yahoo_shortlist" | "watchlist_fallback" }[]} */
      let diagnostics = [];
      /** @type {string[]} */
      let tickersToSend = [];
      /** @type {"yahoo_shortlist" | "watchlist_fallback"} */
      let sourceTag = "watchlist_fallback";

      if (mode === "yahoo_shortlist" && Array.isArray(orderedSymbols) && orderedSymbols.length > 0) {
        sourceTag = "yahoo_shortlist";
        const seen = new Set();
        for (const raw of orderedSymbols) {
          const symbol = String(raw || "").trim().toUpperCase();
          if (!symbol || seen.has(symbol)) continue;
          seen.add(symbol);
          tickersToSend.push(symbol);
          diagnostics.push({
            symbol,
            rank: tickersToSend.length,
            reasons: ["ordre shortlist Yahoo (qualité wheel)"],
            selectionMode: "yahoo_shortlist",
          });
          if (tickersToSend.length >= maxN) break;
        }
      } else {
        const symList = [...new Set((orderedSymbols || []).map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))];
        const preMap =
          candidateBySymbol instanceof Map
            ? candidateBySymbol
            : new Map();
        const ranked = symList
          .map((symbol) => {
            const candidate =
              preMap.get(symbol) ?? candidateByTickerForPreIbkr.get(symbol) ?? null;
            const { score, reasons } = computePreIbkrScore(symbol, candidate);
            const tierBoost = IBKR_AUTO_PRIORITY_SYMBOLS.has(symbol) ? 0 : 1;
            return { symbol, score, reasons, tierBoost, selectionMode: /** @type {const} */ ("watchlist_fallback") };
          })
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.tierBoost !== b.tierBoost) return a.tierBoost - b.tierBoost;
            return a.symbol.localeCompare(b.symbol);
          });
        tickersToSend = ranked.slice(0, maxN).map((row) => row.symbol);
        diagnostics = ranked.slice(0, 20).map((row) => ({
          symbol: row.symbol,
          score: row.score,
          reasons: row.reasons,
          tierBoost: row.tierBoost,
          selectionMode: row.selectionMode,
        }));
      }

      const yahooMappedLen = ibkrAutoInput.yahooMappedLength;
      const decisionReason =
        mode === "yahoo_shortlist" && Array.isArray(orderedSymbols) && orderedSymbols.length > 0
          ? "mapped Yahoo > 0 — IBKR auto en yahoo_shortlist uniquement (pas de fallback watchlist)"
          : mode === "yahoo_shortlist"
          ? "mode yahoo_shortlist mais orderedSymbols vide ou invalide"
          : "watchlist_fallback (scan manuel / hors refresh auto)";

      console.log("[IBKR_AUTO_DECISION]", {
        scanId,
        source: sourceTag,
        decisionReason,
        mappedLength: yahooMappedLen ?? null,
        orderedSymbolsLength: Array.isArray(orderedSymbols) ? orderedSymbols.length : 0,
        tickersSentToIbkr: tickersToSend,
        maxTickers: maxN,
      });

      if (ibkrAutoInput.forceYahooShortlistOnly === true && sourceTag === "watchlist_fallback") {
        console.warn("[IBKR_AUTO_BLOCKED]", {
          scanId,
          reason: "forceYahooShortlistOnly — watchlist_fallback interdit sur ce flux",
        });
        setRefreshStage("IBKR auto annulé : fallback watchlist interdit (règle refresh).");
        setTimeout(() => {
          setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
        }, 0);
        return;
      }

      setIbkrAutoTickerSource(sourceTag);
      setIbkrAutoRankDiagnostics(diagnostics.slice(0, 20));
      if (!tickersToSend.length) {
        console.warn("[IBKR_AUTO_SKIPPED]", { scanId, reason: "tickersToSend vide après sélection" });
        setTimeout(() => {
          setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
        }, 0);
        return;
      }

      setRefreshStage("Étape 2/2 : IBKR Direct Scan — options live");
      setIbkrDirectLoading(true);
      setIbkrDirectError("");
      setIbkrDirectSentTickers(tickersToSend);
      console.warn("[IBKR_AUTO_SEND]", { scanId, source: sourceTag, tickers: tickersToSend, expirationYmd: expLocked });
      try {
        const payload = await callIbkrDirectScan({
          tickers: tickersToSend,
          expiration: ymdToIbkr(expLocked),
          clientIdStart: ibkrAutoClientIdStart,
          maxTickers: ibkrAutoMaxTickers,
          topN: ibkrAutoTopN,
        });
        if (
          normalizeExpirationYmd(selectedExpirationRef.current) !== normalizeExpirationYmd(expLocked)
        ) {
          console.warn(
            "Ignored stale scan payload: IBKR Direct received after expiration changed during request",
            { scanId, lockedExpiration: expLocked, current: selectedExpirationRef.current }
          );
          return;
        }
        if (!ibkrPayloadExpirationMatchesSelected(payload, expLocked)) {
          console.warn(
            "Ignored stale scan payload: IBKR Direct payload expiration mismatch vs selection",
            {
              scanId,
              payloadExpiration: payload?.expiration,
              lockedExpiration: expLocked,
              normalizedPayload: normalizeExpirationYmd(payload?.expiration),
              normalizedLocked: normalizeExpirationYmd(expLocked),
            }
          );
          return;
        }
        const spreadDiag = countIbkrRetainedSafeSpreadBuckets(payload?.shortlist);
        const rejAgg = aggregateIbkrRejectedReasons(payload?.rejected || [], 10);
        console.log("[IBKR_AUTO_RESULT]", {
          scanId,
          ok: payload?.ok,
          scanned: payload?.scanned,
          kept: payload?.kept,
          returned: payload?.returned,
          shortlistLen: payload?.shortlist?.length,
          rejectedLen: payload?.rejected?.length,
          errorsLen: payload?.errors?.length,
          shortlistDevLen: payload?.shortlistDev?.length,
          warnings: payload?.warnings,
          ibkrSuspiciousEmpty: payload?.ibkrSuspiciousEmpty,
          rejectedReasonsTop10: rejAgg.sorted.slice(0, 10),
          shortlistSymbolsKept: (payload?.shortlist || []).map((r) => r?.symbol).filter(Boolean),
          retainedSafeSpreadGt10Pct: spreadDiag.retainedSafeSpreadGt10Pct,
          retainedSafeSpreadGt20Pct: spreadDiag.retainedSafeSpreadGt20Pct,
          tickersSent: tickersToSend,
        });
        const emptySuspicious = isIbkrDirectScanSuspiciousEmpty(payload);
        setIbkrDirectResult(payload);
        if (emptySuspicious) {
          setIbkrDirectError(IBKR_TWS_EMPTY_MESSAGE);
          setRefreshStage("IBKR : aucune donnée par symbole — vérifie TWS / IB Gateway.");
        } else {
          const applied = applyIbkrDirectShortlistToPrimary(payload);
          const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
          if (!applied) {
            const slen = Array.isArray(payload?.shortlist) ? payload.shortlist.length : 0;
            if (slen === 0) {
              setIbkrDirectError(buildIbkrZeroKeptUserMessage(payload));
              setRefreshStage("IBKR : 0 retenu — détail dans le panneau et la console.");
            } else {
              setIbkrDirectError(
                "IBKR : réponse non appliquée (données incohérentes ou expiration). Shortlist actuelle conservée."
              );
              setRefreshStage("IBKR : application annulée — shortlist conservée.");
            }
          } else if (warnings.includes("ibkr_shadow_batch_timeout")) {
            setIbkrDirectError("");
            setRefreshStage("Timeout IBKR : réduire Max IBKR à 10 ou moins. Yahoo/fallback conservé.");
          } else {
            setIbkrDirectError("");
            setRefreshStage("Terminé : Shortlist enrichie disponible");
          }
        }
      } catch (err) {
        setIbkrDirectError(String(err?.message || err || "IBKR Direct Scan indisponible"));
        setRefreshStage("IBKR Direct Scan indisponible. Yahoo/fallback conservé.");
      } finally {
        setIbkrDirectLoading(false);
        setTimeout(() => {
          setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
        }, 0);
      }
    },
    [
      autoIbkrDirectScan,
      ibkrAutoMaxTickers,
      ibkrAutoTopN,
      ibkrAutoClientIdStart,
      candidateByTickerForPreIbkr,
      selectedExpiration,
      applyIbkrDirectShortlistToPrimary,
      displaySnapshotRef,
    ]
  );

  useEffect(() => {
    runAutoIbkrDirectScanRef.current = runAutoIbkrDirectScan;
  }, [runAutoIbkrDirectScan]);

  const handleRefreshShortlist = useCallback(async (options = {}) => {
    if (isRefreshingRef.current) {
      console.log("[REFRESH_GUARD] refresh already in progress, ignoring duplicate trigger");
      return;
    }
    isRefreshingRef.current = true;
    const scanId = Date.now().toString();
    try {
    const shouldRunAutoIbkr = options?.runIbkr !== false && autoIbkrDirectScan;
    console.log("[SCAN_START]", {
      scanId,
      selectedExpiration: selectedExpirationRef.current,
      topN,
      ibkrAutoMaxTickers,
      watchlistTickersLength: watchlistTickers?.length ?? null,
    });
    console.log("[SCAN_DEBUG] watchlistTickers.length", watchlistTickers?.length ?? null);
    const marketClosed = isUsMarketClosedNow();
    setClosedMarketCacheFallback(false);
    setBackendShortlistDevScan(false);
    setRefreshStage("Étape 1/2 : Yahoo/yfinance — contexte technique");

    let tickers = watchlistTickers ?? FALLBACK_TICKERS;
    if (Array.isArray(watchlistTickers) && watchlistTickers.length === 0) {
      console.log("[SCAN_DEBUG] watchlist_empty_using_fallback_no_auto_rebuild");
      tickers = FALLBACK_TICKERS;
      setWatchlistBuildError(
        "Watchlist vide. Utilisation de la liste secours. Cliquer Rebuild watchlist pour relancer /universe/build."
      );
    }

    if (!Array.isArray(tickers) || tickers.length === 0) {
      console.log("[SCAN_DEBUG] scan_cancelled_reason", "no_tickers_to_scan");
      setScanError("Aucun ticker disponible pour lancer le scan.");
      setBackendCandidates(null);
      setDataSource("snapshot");
      setPrimaryIbkrSourceInfo(null);
      setScanMeta({ scanned: 0, kept: 0, returned: 0 });
      return;
    }
    console.log("[SCAN_DEBUG] tickers_sent_to_scan", tickers.length);

    setLoadingScan(true);
    setScanError("");

    try {
      const lockedExpiration = selectedExpirationRef.current;
      const payload = await callScanShortlist({
        expiration: lockedExpiration,
        topN,
        tickers,
        sort: "quality",
      });

      if (
        normalizeExpirationYmd(selectedExpirationRef.current) !== normalizeExpirationYmd(lockedExpiration)
      ) {
        console.warn(
          `Ignored stale scan payload: payload expiration ${lockedExpiration ?? "—"}, selected expiration ${selectedExpirationRef.current ?? "—"}`
        );
        return;
      }
      if (
        payload?.expiration != null &&
        !payloadExpirationMatchesSelected(payload.expiration, lockedExpiration)
      ) {
        console.warn(
          `Ignored stale scan payload: payload expiration ${payload.expiration}, selected expiration ${lockedExpiration}`
        );
        return;
      }

      const mappedRaw = (payload.shortlist || []).map((item, index) =>
        toDashboardCandidate(item, index, lockedExpiration)
      );
      const mapped = tagCandidatesOffMarketNonTradable(mappedRaw, marketClosed);
      rememberTechnicalCandidates(mapped);

      setBackendCandidates(mapped);
      setDataSource("backend");
      setPrimaryIbkrSourceInfo(null);
      const devFromPayload = payload.devScanEnabled === true;
      setBackendShortlistDevScan(devFromPayload);
      setScanMeta({
        scanned: payload.scanned ?? tickers.length,
        kept: payload.kept ?? mapped.length,
        returned: payload.returned ?? mapped.length,
      });
      setYahooScanMeta({
        scanned: payload.scanned ?? tickers.length,
        kept: payload.kept ?? mapped.length,
        returned: payload.returned ?? mapped.length,
      });
      setYahooReturnedCandidates(mapped);

      const yahooTop20 = (payload.shortlist || []).slice(0, 20).map((it) => it.symbol);
      console.log("[SCAN_YAHOO_RESULT]", {
        scanId,
        scanned: payload.scanned,
        kept: payload.kept,
        returned: payload.returned,
        shortlistLen: (payload.shortlist || []).length,
        top20SymbolsYahooOrder: yahooTop20,
        rejectedCount: (payload.rejected || []).length,
        errorsCount: (payload.errors || []).length,
      });

      if (mapped.length > 0) {
        try {
          window.localStorage.setItem(
            LAST_GOOD_SCAN_KEY,
            JSON.stringify({
              expiration: lockedExpiration,
              devScanEnabled: devFromPayload,
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
      if (shouldRunAutoIbkr && runAutoIbkrDirectScanRef.current) {
        const yahooOrdered = mapped
          .map((c) => String(c?.ticker || "").trim().toUpperCase())
          .filter(Boolean);
        if (yahooOrdered.length > 0) {
          await runAutoIbkrDirectScanRef.current({
            scanId,
            forceYahooShortlistOnly: true,
            mode: "yahoo_shortlist",
            orderedSymbols: yahooOrdered,
            expirationYmd: lockedExpiration,
            yahooMappedLength: mapped.length,
          });
        } else {
          const skipMsg =
            "Yahoo shortlist vide — IBKR auto non lancé. Vérifier rejets Yahoo.";
          setScanError(skipMsg);
          setRefreshStage(skipMsg);
          console.warn("[IBKR_AUTO_SKIPPED]", {
            scanId,
            reason: "mapped.length === 0 — pas de fallback watchlist silencieux",
            yahooRejectedCount: (payload.rejected || []).length,
            yahooErrorsCount: (payload.errors || []).length,
          });
          setTimeout(() => {
            setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
          }, 0);
        }
      } else if (!shouldRunAutoIbkr) {
        setTimeout(() => {
          setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
        }, 0);
      }
    } catch (e) {
      const {
        valid: cacheOk,
        cached,
        cachedShortlist,
      } = readLastGoodScanCache(selectedExpirationRef.current);
      const ibkrExp = selectedExpirationRef.current;
      /** @type {unknown[]} */
      let taggedForIbkr = [];
      if (cacheOk && cachedShortlist) {
        const tagged = tagCandidatesOffMarketNonTradable(cachedShortlist, marketClosed);
        taggedForIbkr = tagged;
        rememberTechnicalCandidates(tagged);
        setBackendCandidates(tagged);
        setDataSource("backend");
        setPrimaryIbkrSourceInfo(null);
        setScanMeta(
          cached?.scanMeta ?? {
            scanned: tagged.length,
            kept: tagged.length,
            returned: tagged.length,
          }
        );
        setYahooScanMeta(
          cached?.scanMeta ?? {
            scanned: tagged.length,
            kept: tagged.length,
            returned: tagged.length,
          }
        );
        setYahooReturnedCandidates(tagged);
        setBackendShortlistDevScan(cached?.devScanEnabled === true);
        setClosedMarketCacheFallback(true);
        setScanError("");
      } else {
        setScanError(String(e?.message || e || "Erreur lors du refresh shortlist"));
        setBackendCandidates(null);
        setDataSource("snapshot");
        setPrimaryIbkrSourceInfo(null);
        setScanMeta({
          scanned: tickers.length,
          kept: 0,
          returned: 0,
        });
        setYahooScanMeta({
          scanned: tickers.length,
          kept: 0,
          returned: 0,
        });
        setYahooReturnedCandidates([]);
        setClosedMarketCacheFallback(false);
      }
      if (shouldRunAutoIbkr && runAutoIbkrDirectScanRef.current) {
        if (cacheOk && cachedShortlist) {
          const yahooOrdered = taggedForIbkr
            .map((c) => String(c?.ticker || "").trim().toUpperCase())
            .filter(Boolean);
          if (yahooOrdered.length > 0) {
            await runAutoIbkrDirectScanRef.current({
              scanId,
              forceYahooShortlistOnly: true,
              mode: "yahoo_shortlist",
              orderedSymbols: yahooOrdered,
              expirationYmd: ibkrExp,
              yahooMappedLength: taggedForIbkr.length,
            });
          } else {
            const skipMsg =
              "Yahoo shortlist vide (cache) — IBKR auto non lancé. Vérifier rejets Yahoo.";
            setScanError(skipMsg);
            setRefreshStage(skipMsg);
            console.warn("[IBKR_AUTO_SKIPPED]", {
              scanId,
              reason: "cache taggedForIbkr vide — pas de fallback watchlist",
            });
            setTimeout(() => {
              setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
            }, 0);
          }
        } else {
          const skipMsg =
            "IBKR auto non lancé : pas de shortlist Yahoo (erreur réseau / pas de cache). Pas de fallback watchlist.";
          setIbkrDirectError("");
          setRefreshStage(skipMsg);
          console.warn("[IBKR_AUTO_SKIPPED]", {
            scanId,
            reason: "erreur refresh sans cache Yahoo valide",
          });
          setTimeout(() => {
            setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
          }, 0);
        }
      }
    } finally {
      if (!shouldRunAutoIbkr) {
        setRefreshStage("Terminé : Shortlist Yahoo/fallback disponible");
      }
      setLoadingScan(false);
    }
    } finally {
      isRefreshingRef.current = false;
    }
  }, [watchlistTickers, selectedExpiration, topN, autoIbkrDirectScan, rememberTechnicalCandidates, displaySnapshotRef]);

  useEffect(() => {
    rememberTechnicalCandidates(activeCandidates);
  }, [activeCandidates, rememberTechnicalCandidates]);

  useEffect(() => {
    rememberTechnicalCandidates(mergedIbkrYahooCandidates);
  }, [mergedIbkrYahooCandidates, rememberTechnicalCandidates]);

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

  const handleIbkrShadowTest = useCallback(async () => {
    setIbkrShadowLoading(true);
    setIbkrShadowError("");
    setIbkrShadowResult(null);
    try {
      const payload = await callIbkrShadowWheel({
        symbol: ibkrShadowSymbol,
        expiration: ibkrShadowExpiration,
        clientId: ibkrShadowClientId,
      });
      setIbkrShadowResult(payload);
    } catch (err) {
      setIbkrShadowError(String(err?.message || err || "IBKR Shadow indisponible"));
    } finally {
      setIbkrShadowLoading(false);
    }
  }, [ibkrShadowSymbol, ibkrShadowExpiration, ibkrShadowClientId]);

  const handleIbkrBatchValidate = useCallback(async () => {
    if (!ibkrBatchTickers.length) {
      setIbkrBatchError("Impossible de valider IBKR : aucun ticker affiché dans la shortlist.");
      return;
    }
    if (ibkrBatchExpirationInfo.error) {
      setIbkrBatchError(ibkrBatchExpirationInfo.error);
      return;
    }

    setIbkrBatchLoading(true);
    setIbkrBatchError("");
    setIbkrBatchResult(null);
    try {
      const payload = await callIbkrShadowBatch({
        tickers: ibkrBatchTickersForSend,
        expiration: ibkrBatchExpirationInfo.usedExpiration || selectedExpiration,
        ibkrExpiration: ibkrBatchExpirationInfo.ibkrExpiration || ymdToIbkr(selectedExpiration),
        clientIdStart: ibkrBatchClientIdStart,
      });
      setIbkrBatchResult(payload);
    } catch (err) {
      setIbkrBatchError(String(err?.message || err || "IBKR Shadow batch indisponible"));
    } finally {
      setIbkrBatchLoading(false);
    }
  }, [
    ibkrBatchTickers,
    ibkrBatchTickersForSend,
    ibkrBatchExpirationInfo,
    selectedExpiration,
    ibkrBatchClientIdStart,
  ]);

  const handleIbkrDirectScan = useCallback(async () => {
    const tickersToSend = ibkrDirectTickersForSend;
    if (!tickersToSend.length) {
      setIbkrDirectError("Impossible de scanner IBKR : aucun ticker disponible (shortlist Yahoo ou watchlist vide).");
      return;
    }
    console.warn("[IBKR_MANUAL_TICKERS]", {
      source: ibkrManualSendSource,
      tickers: tickersToSend,
    });

    setIbkrDirectLoading(true);
    setIbkrDirectError("");
    setIbkrDirectSentTickers(tickersToSend);
    try {
      const expLocked = selectedExpirationRef.current;
      const payload = await callIbkrDirectScan({
        tickers: tickersToSend,
        expiration: ymdToIbkr(expLocked),
        clientIdStart: ibkrDirectClientIdStart,
        maxTickers: ibkrDirectMaxTickers,
        topN: ibkrDirectTopN,
      });
      if (
        normalizeExpirationYmd(selectedExpirationRef.current) !== normalizeExpirationYmd(expLocked)
      ) {
        console.warn(
          "Ignored stale scan payload: IBKR Direct manual received after expiration changed during request",
          { lockedExpiration: expLocked, current: selectedExpirationRef.current }
        );
        return;
      }
      if (!ibkrPayloadExpirationMatchesSelected(payload, expLocked)) {
        console.warn(
          "Ignored stale scan payload: IBKR manual payload expiration mismatch vs selection",
          {
            payloadExpiration: payload?.expiration,
            lockedExpiration: expLocked,
            normalizedPayload: normalizeExpirationYmd(payload?.expiration),
            normalizedLocked: normalizeExpirationYmd(expLocked),
          }
        );
        return;
      }
      console.log("[IBKR_MANUAL_RESULT]", {
        ok: payload?.ok,
        scanned: payload?.scanned,
        kept: payload?.kept,
        shortlistLen: payload?.shortlist?.length,
        rejectedLen: payload?.rejected?.length,
        errorsLen: payload?.errors?.length,
        tickersSent: tickersToSend,
      });
      setIbkrDirectResult(payload);
      if (isIbkrDirectScanSuspiciousEmpty(payload)) {
        setIbkrDirectError(IBKR_TWS_EMPTY_MESSAGE);
      } else {
        const applied = applyIbkrDirectShortlistToPrimary(payload);
        if (!applied) {
          const slen = Array.isArray(payload?.shortlist) ? payload.shortlist.length : 0;
          if (slen === 0) {
            setIbkrDirectError(buildIbkrZeroKeptUserMessage(payload));
          } else {
            setIbkrDirectError(
              "IBKR : réponse non appliquée (données incohérentes ou expiration). Shortlist actuelle conservée."
            );
          }
        } else {
          setIbkrDirectError("");
        }
      }
    } catch (err) {
      setIbkrDirectError(String(err?.message || err || "IBKR Direct Scan indisponible"));
    } finally {
      setIbkrDirectLoading(false);
    }
  }, [
    ibkrDirectTickersForSend,
    ibkrManualSendSource,
    selectedExpiration,
    ibkrDirectClientIdStart,
    ibkrDirectMaxTickers,
    ibkrDirectTopN,
    applyIbkrDirectShortlistToPrimary,
  ]);

  const handleIbkrDirectTestScan = useCallback(async () => {
    const tickersToSend = ["TQQQ", "AFRM", "SOXL"];
    setIbkrDirectMaxTickers(3);
    setIbkrDirectTopN(3);
    const expLocked = selectedExpirationRef.current;
    setIbkrDirectLoading(true);
    setIbkrDirectError("");
    setIbkrDirectSentTickers(tickersToSend);
    try {
      const payload = await callIbkrDirectScan({
        tickers: tickersToSend,
        expiration: ymdToIbkr(expLocked),
        clientIdStart: ibkrDirectClientIdStart,
        maxTickers: 3,
        topN: 3,
      });
      if (
        normalizeExpirationYmd(selectedExpirationRef.current) !== normalizeExpirationYmd(expLocked)
      ) {
        console.warn(
          "Ignored stale scan payload: IBKR test scan vs changed expiration",
          { lockedExpiration: expLocked, current: selectedExpirationRef.current }
        );
        return;
      }
      if (!ibkrPayloadExpirationMatchesSelected(payload, expLocked)) {
        console.warn("Ignored stale scan payload: IBKR test payload expiration mismatch", {
          payloadExpiration: payload?.expiration,
          lockedExpiration: expLocked,
        });
        return;
      }
      console.log("[IBKR_TEST_RESULT]", {
        ok: payload?.ok,
        kept: payload?.kept,
        shortlistLen: payload?.shortlist?.length,
        tickersSent: tickersToSend,
      });
      setIbkrDirectResult(payload);
      if (isIbkrDirectScanSuspiciousEmpty(payload)) {
        setIbkrDirectError(IBKR_TWS_EMPTY_MESSAGE);
      } else {
        const applied = applyIbkrDirectShortlistToPrimary(payload);
        if (!applied) {
          const slen = Array.isArray(payload?.shortlist) ? payload.shortlist.length : 0;
          if (slen === 0) {
            setIbkrDirectError(buildIbkrZeroKeptUserMessage(payload));
          } else {
            setIbkrDirectError(
              "IBKR : réponse non appliquée (données incohérentes ou expiration). Shortlist actuelle conservée."
            );
          }
        } else {
          setIbkrDirectError("");
        }
      }
    } catch (err) {
      setIbkrDirectError(String(err?.message || err || "IBKR Direct Scan indisponible"));
    } finally {
      setIbkrDirectLoading(false);
    }
  }, [selectedExpiration, ibkrDirectClientIdStart, applyIbkrDirectShortlistToPrimary]);

  const handleRefreshScanMetrics = useCallback(async () => {
    setScanMetricsLoading(true);
    setScanMetricsError("");
    try {
      const payload = await callScanMetrics();
      setScanMetricsData(payload);
    } catch (err) {
      setScanMetricsError(String(err?.message || err || "métriques non disponibles"));
    } finally {
      setScanMetricsLoading(false);
    }
  }, []);

  const handleResetScanMetrics = useCallback(async () => {
    setScanMetricsLoading(true);
    setScanMetricsError("");
    try {
      const payload = await callResetScanMetrics();
      setScanMetricsData(payload?.metrics ?? null);
    } catch (err) {
      setScanMetricsError(String(err?.message || err || "reset métriques impossible"));
    } finally {
      setScanMetricsLoading(false);
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
    handleRefreshScanMetrics();
  }, [handleRefreshScanMetrics]);

  useEffect(() => {
    if (isPastYmd(selectedExpiration)) {
      const nextExpiration = pickDefaultExpiration(DEFAULT_EXPIRATIONS);
      if (nextExpiration !== selectedExpiration) {
        setSelectedExpiration(nextExpiration);
      }
    }
  }, [selectedExpiration]);

  const handleRefreshShortlistRef = useRef(handleRefreshShortlist);
  const autoRefreshDisabledLogRef = useRef(false);
  useEffect(() => {
    handleRefreshShortlistRef.current = handleRefreshShortlist;
  }, [handleRefreshShortlist]);

  useEffect(() => {
    if (!AUTO_REFRESH_SHORTLIST_ON_LOAD) {
      if (!autoRefreshDisabledLogRef.current) {
        console.log("[AUTO_REFRESH_DISABLED] shortlist auto refresh disabled on dashboard load");
        autoRefreshDisabledLogRef.current = true;
      }
      return;
    }

    if (watchlistLoading) return;
    if (handleRefreshShortlistRef.current) {
      handleRefreshShortlistRef.current({ runIbkr: false });
    }
  }, [watchlistLoading, selectedExpiration, topN]);

  useEffect(() => {
    window.localStorage.setItem("wheel.topYahooReturned", String(topN));
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
        title: "Cartes affichées",
        value: String(filtered.length),
        sub:
          dataSource === "ibkr_direct"
            ? `${scanMeta.kept} retenus IBKR Direct`
            : dataSource === "backend"
            ? `${scanMeta.kept} retenus backend`
            : "snapshot local",
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

  const marketClosedNow = isUsMarketClosedNow();
  const showClosedValidBanner =
    marketClosedNow && hasValidClosedMarketCache && closedMarketCacheFallback;
  const showClosedNoCacheBanner =
    marketClosedNow && !hasValidClosedMarketCache && !closedMarketCacheFallback;
  const showSourceStatusBanner =
    !marketClosedNow ||
    ((dataSource === "backend" || dataSource === "ibkr_direct") && !showClosedValidBanner);
  const showIndicativeClosedBanner =
    marketClosedNow &&
    (dataSource === "backend" || dataSource === "ibkr_direct") &&
    !showClosedValidBanner;

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
              {expirationOptions.map((exp) => (
                <option key={exp} value={exp}>
                  {exp}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Top Yahoo retournés</label>
            <Input
              type="number"
              min="1"
              max="100"
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value || 1))}
              className="w-full rounded-xl border-slate-200"
            />
            <p className="mt-1 text-xs text-slate-500">Nombre demandé à /scan_shortlist.</p>
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

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={autoIbkrDirectScan}
                onChange={(e) => setAutoIbkrDirectScan(e.target.checked)}
              />
              IBKR auto
            </label>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Refresh lance Yahoo puis IBKR Direct Scan en lecture seule.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">Max IBKR</label>
            <Select
              value={String(ibkrAutoMaxTickers)}
              onChange={(e) => setIbkrAutoMaxTickers(Number(e.target.value))}
              className="w-full rounded-xl border-slate-200"
              disabled={!autoIbkrDirectScan}
            >
              <option value="3">3</option>
              <option value="10">10</option>
              <option value="20">20</option>
            </Select>
          </div>

          <div className="flex flex-col gap-2 justify-end">
            <Button
              className="w-full rounded-xl"
              onClick={handleRefreshShortlist}
              disabled={loadingScan || watchlistLoading || ibkrDirectLoading}
            >
              Refresh shortlist <RefreshCw className="ml-2 h-4 w-4" />
            </Button>
            <Button
              className="w-full rounded-xl"
              variant="outline"
              onClick={handleRebuildWatchlist}
              disabled={loadingScan || watchlistLoading || ibkrDirectLoading}
            >
              Rebuild watchlist <Database className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>

        {refreshStage && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm font-medium text-slate-700 shadow-sm">
            {refreshStage}
          </div>
        )}
        {(yahooScanMeta.scanned > 0 || ibkrSentCount > 0 || ibkrDirectResult) && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            <p className="font-semibold text-slate-900">Résumé du funnel</p>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Metric label="Watchlist scannable" value={String(yahooScanMeta.scanned || tickersForScan.length || 0)} />
              <Metric label="Yahoo retenus" value={String(yahooScanMeta.kept || 0)} />
              <Metric label="Yahoo retournés" value={String(yahooReturnedCount)} />
              <Metric label="Envoyés à IBKR" value={String(ibkrSentCount)} />
              <Metric label="Retenus IBKR" value={String(ibkrKeptCount)} />
              <Metric label="Rejetés IBKR" value={String(ibkrRejectedCount)} />
              <Metric
                label="Non envoyés à IBKR"
                value={String(Math.max(0, Number(yahooScanMeta.kept || 0) - ibkrSentCount))}
                tone={Number(yahooScanMeta.kept || 0) > ibkrSentCount ? "warn" : "default"}
              />
              <Metric label="Actionnables" value={String(yahooActionabilityCounts.actionable)} tone="good" />
              <Metric label="À surveiller" value={String(yahooActionabilityCounts.watch)} tone="warn" />
              <Metric label="Non actionnables" value={String(yahooActionabilityCounts.nonActionable)} tone="bad" />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Lecture visuelle seulement : actionnable = spread safe ≤ 10 % sans earnings avant expiration.
            </p>
          </div>
        )}

        {yahooReturnedCount > 0 && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            <p className="font-semibold text-slate-900">Candidats Yahoo non envoyés à IBKR</p>
            {yahooReturnedCount <= (ibkrSentCount || Number(ibkrAutoMaxTickers) || 10) ? (
              <p className="mt-2 text-slate-500">
                Impossible d’afficher les rangs 11-30 : /scan_shortlist retourne seulement le Top Yahoo actuel.
              </p>
            ) : (
              <div className="mt-2 space-y-1">
                {yahooNonSentCandidates.map((item) => (
                  <div key={`yahoo-not-sent-${item.ticker}`}>
                    Rang Yahoo #{item.rank} · {item.ticker} · qualité {item.qualityScore ?? "—"} · RSI{" "}
                    {item.rsi ?? "—"}
                  </div>
                ))}
              </div>
            )}
            <div className={cn("mt-3 rounded-xl border px-3 py-2", sofiDiagnostic.sent ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900")}>
              SOFI : {sofiDiagnostic.inWatchlist ? `watchlist #${sofiDiagnostic.watchlistRank}` : "absent de la watchlist actuelle"} ·{" "}
              {sofiDiagnostic.inYahoo ? `Yahoo #${sofiDiagnostic.yahooRank}` : "absent de la shortlist Yahoo retournée"} ·{" "}
              {sofiDiagnostic.sent ? "envoyé à IBKR" : "SOFI non envoyé à IBKR — hors Top Max IBKR actuel."}
            </div>
          </div>
        )}

        {ibkrAutoRankDiagnostics.length > 0 && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            <p className="font-semibold text-slate-900">
              Pré-sélection IBKR auto (Top {ibkrDirectSentTickers.length || ibkrAutoRankDiagnostics.length})
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Source :{" "}
              <span className="font-mono font-medium text-slate-800">
                {ibkrAutoTickerSource === "yahoo_shortlist"
                  ? "yahoo_shortlist"
                  : ibkrAutoTickerSource === "watchlist_fallback"
                    ? "watchlist_fallback (pré-score technique)"
                    : "—"}
              </span>
            </p>
            <div className="mt-2 space-y-1">
              {ibkrAutoRankDiagnostics.map((row) => (
                <div key={`pre-ibkr-${row.symbol}`}>
                  {row.selectionMode === "yahoo_shortlist" && row.rank != null
                    ? `${row.symbol} : rang Yahoo #${row.rank} · ${row.reasons.join(" · ") || "ordre shortlist"}`
                    : `${row.symbol} : score ${Math.round(Number(row.score) || 0)} · ${row.reasons.join(" · ") || "base"}`}
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Tickers envoyés à IBKR auto : {(ibkrDirectSentTickers || []).join(", ") || "—"}
            </p>
          </div>
        )}

        <details className="mb-6 rounded-[28px] border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm">
          <summary className="cursor-pointer text-base font-semibold text-slate-900">
            Diagnostics IBKR avancés
          </summary>
          <div className="mt-4 space-y-6">
            <details className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer font-semibold text-slate-900">
                Compteurs appels Yahoo / IBKR
              </summary>
              <div className="mt-3 space-y-3 text-sm text-slate-700">
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="rounded-xl"
                    size="sm"
                    variant="outline"
                    onClick={handleRefreshScanMetrics}
                    disabled={scanMetricsLoading}
                  >
                    Rafraîchir métriques
                  </Button>
                  <Button
                    className="rounded-xl"
                    size="sm"
                    variant="outline"
                    onClick={handleResetScanMetrics}
                    disabled={scanMetricsLoading}
                  >
                    Reset métriques
                  </Button>
                </div>

                {scanMetricsLoading && <p className="text-slate-500">Chargement métriques…</p>}
                {scanMetricsError && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-800">
                    {scanMetricsError}
                  </div>
                )}
                {!scanMetricsLoading && !scanMetricsError && !scanMetricsData && (
                  <p className="text-slate-500">métriques non disponibles</p>
                )}

                {scanMetricsData && (
                  <>
                    <p className="text-xs text-slate-500">
                      Dernier refresh détecté : {scanMetricsData?.lastRefreshAt || "—"}
                    </p>
                    <div className="grid gap-3 md:grid-cols-3">
                      <Metric
                        label="Yahoo appels réels"
                        value={String(scanMetricsData?.yahoo?.totals?.totalYahooRealCalls ?? 0)}
                        strong
                      />
                      <Metric
                        label="Yahoo cache hits"
                        value={String(scanMetricsData?.yahoo?.totals?.totalYahooCacheHits ?? 0)}
                      />
                      <Metric
                        label="Yahoo cache misses"
                        value={String(scanMetricsData?.yahoo?.totals?.totalYahooCacheMisses ?? 0)}
                      />
                      <Metric
                        label="Yahoo quote calls"
                        value={String(scanMetricsData?.yahoo?.totals?.quoteCalls ?? 0)}
                      />
                      <Metric
                        label="Yahoo options all/date calls"
                        value={`${scanMetricsData?.yahoo?.totals?.optionsAllCalls ?? 0} / ${scanMetricsData?.yahoo?.totals?.optionsDateCalls ?? 0}`}
                      />
                      <Metric
                        label="Yahoo chart calls"
                        value={String(scanMetricsData?.yahoo?.totals?.chartCalls ?? 0)}
                      />
                      <Metric
                        label="Yahoo chart 120j/180j calls"
                        value={`${scanMetricsData?.yahoo?.totals?.chart120dCalls ?? 0} / ${scanMetricsData?.yahoo?.totals?.chart180dCalls ?? 0}`}
                      />
                      <Metric
                        label="IBKR approx calls"
                        value={String(scanMetricsData?.ibkr?.totals?.totalApproxIbkrCalls ?? 0)}
                        strong
                      />
                      <Metric
                        label="IBKR option MktData"
                        value={String(scanMetricsData?.ibkr?.totals?.totalOptionMarketDataRequests ?? 0)}
                      />
                      <Metric
                        label="IBKR option qualify"
                        value={String(scanMetricsData?.ibkr?.totals?.totalOptionQualifyCalls ?? 0)}
                      />
                      <Metric
                        label="IBKR EM contracts req"
                        value={String(scanMetricsData?.ibkr?.totals?.totalExpectedMoveContractsRequested ?? 0)}
                      />
                      <Metric
                        label="IBKR put contracts req"
                        value={String(scanMetricsData?.ibkr?.totals?.totalPutCandidateContractsRequested ?? 0)}
                      />
                      <Metric
                        label="IBKR cancel calls"
                        value={String(scanMetricsData?.ibkr?.totals?.totalCancelMarketDataCalls ?? 0)}
                      />
                      <Metric
                        label="IBKR timeouts"
                        value={String(scanMetricsData?.ibkr?.totals?.totalTimeouts ?? 0)}
                      />
                      <Metric
                        label="IBKR qualify cache hits"
                        value={String(scanMetricsData?.ibkr?.totals?.totalOptionQualifyCacheHits ?? 0)}
                      />
                      <Metric
                        label="IBKR mktData cache hits"
                        value={String(scanMetricsData?.ibkr?.totals?.totalOptionMarketDataCacheHits ?? 0)}
                      />
                      <Metric
                        label="IBKR duplicates évités"
                        value={`${scanMetricsData?.ibkr?.totals?.totalDuplicateOptionQualifyAvoided ?? 0} / ${scanMetricsData?.ibkr?.totals?.totalDuplicateOptionMarketDataAvoided ?? 0}`}
                      />
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="font-medium text-slate-900">Top 5 tickers IBKR les plus coûteux</p>
                      {ibkrTopCostlySymbols.length === 0 ? (
                        <p className="mt-1 text-slate-500">Aucune donnée ticker disponible.</p>
                      ) : (
                        <div className="mt-2 space-y-1 text-xs text-slate-700">
                          {ibkrTopCostlySymbols.map((row) => (
                            <div key={`ibkr-cost-${row.symbol}`}>
                              {row.symbol} — approx {row.approxIbkrCalls} · qualify opt {row.optionQualifyCalls} ·
                              mktData opt {row.optionMarketDataRequests} · cancel {row.cancelMarketDataCalls} ·
                              durée {row.durationMs} ms
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <details className="rounded-xl border border-slate-200 bg-white p-3">
                      <summary className="cursor-pointer font-medium text-slate-900">
                        Détail IBKR par ticker
                      </summary>
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        IBKR est plus lent que Yahoo : surveiller surtout durée, option qualify et option market data.
                      </p>
                      {ibkrTickerDetailRows.length === 0 ? (
                        <p className="mt-2 text-slate-500">Aucun détail IBKR par ticker disponible.</p>
                      ) : (
                        <div className="mt-3 overflow-x-auto">
                          <table className="min-w-full text-left text-xs text-slate-700">
                            <thead className="border-b border-slate-200 text-slate-500">
                              <tr>
                                <th className="py-2 pr-4 font-medium">Ticker</th>
                                <th className="py-2 pr-4 font-medium">Statut</th>
                                <th className="py-2 pr-4 font-medium">Durée</th>
                                <th className="py-2 pr-4 font-medium">Approx calls</th>
                                <th className="py-2 pr-4 font-medium">Qualify opt</th>
                                <th className="py-2 pr-4 font-medium">MktData opt</th>
                                <th className="py-2 pr-4 font-medium">Raison</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ibkrTickerDetailRows.map((row) => (
                                <tr key={`ibkr-detail-${row.symbol}`} className="border-b border-slate-100 last:border-0">
                                  <td className="py-2 pr-4 font-semibold text-slate-900">{row.symbol}</td>
                                  <td className="py-2 pr-4">{formatIbkrStatus(row.status)}</td>
                                  <td className="py-2 pr-4">{formatDurationShort(row.durationMs)}</td>
                                  <td className="py-2 pr-4">{String(row.approxCalls ?? 0)}</td>
                                  <td className="py-2 pr-4">{String(row.optionQualifyCalls ?? 0)}</td>
                                  <td className="py-2 pr-4">{String(row.optionMarketDataRequests ?? 0)}</td>
                                  <td className="py-2 pr-4">{formatIbkrReason(row.reason)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </details>
                  </>
                )}
                {!scanMetricsData && ibkrTickerDetailRows.length > 0 && (
                  <details className="rounded-xl border border-slate-200 bg-white p-3">
                    <summary className="cursor-pointer font-medium text-slate-900">
                      Détail IBKR par ticker
                    </summary>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      IBKR est plus lent que Yahoo : surveiller surtout durée, option qualify et option market data.
                    </p>
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full text-left text-xs text-slate-700">
                        <thead className="border-b border-slate-200 text-slate-500">
                          <tr>
                            <th className="py-2 pr-4 font-medium">Ticker</th>
                            <th className="py-2 pr-4 font-medium">Statut</th>
                            <th className="py-2 pr-4 font-medium">Durée</th>
                            <th className="py-2 pr-4 font-medium">Approx calls</th>
                            <th className="py-2 pr-4 font-medium">Qualify opt</th>
                            <th className="py-2 pr-4 font-medium">MktData opt</th>
                            <th className="py-2 pr-4 font-medium">Raison</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ibkrTickerDetailRows.map((row) => (
                            <tr key={`ibkr-detail-fallback-${row.symbol}`} className="border-b border-slate-100 last:border-0">
                              <td className="py-2 pr-4 font-semibold text-slate-900">{row.symbol}</td>
                              <td className="py-2 pr-4">{formatIbkrStatus(row.status)}</td>
                              <td className="py-2 pr-4">{formatDurationShort(row.durationMs)}</td>
                              <td className="py-2 pr-4">{String(row.approxCalls ?? 0)}</td>
                              <td className="py-2 pr-4">{String(row.optionQualifyCalls ?? 0)}</td>
                              <td className="py-2 pr-4">{String(row.optionMarketDataRequests ?? 0)}</td>
                              <td className="py-2 pr-4">{formatIbkrReason(row.reason)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </div>
            </details>

            <details className="mb-6 rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
              <summary className="cursor-pointer text-base font-semibold text-slate-900">
                Diagnostic manuel IBKR Shadow single ticker
              </summary>
              <div className="mt-4">
                <IbkrShadowCard
                  symbol={ibkrShadowSymbol}
                  setSymbol={setIbkrShadowSymbol}
                  expiration={ibkrShadowExpiration}
                  setExpiration={setIbkrShadowExpiration}
                  clientId={ibkrShadowClientId}
                  setClientId={setIbkrShadowClientId}
                  loading={ibkrShadowLoading}
                  error={ibkrShadowError}
                  result={ibkrShadowResult}
                  onRun={handleIbkrShadowTest}
                />
              </div>
            </details>

        <Card className="mb-6 rounded-[28px] border-slate-200 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xl text-slate-900">IBKR Shadow Batch — Diagnostic</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              IBKR Shadow Batch est en lecture seule. Aucun ordre envoyé. Les données peuvent être
              frozen/delayed hors marché.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Expiration utilisée pour IBKR :{" "}
              <span className="font-medium text-slate-700">
                {(ibkrBatchExpirationInfo.usedExpiration || "—")} /{" "}
                {(ibkrBatchExpirationInfo.ibkrExpiration || "—")}
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Titres envoyés :{" "}
              <span className="font-medium text-slate-700">
                {ibkrBatchTickersForSend.length} / {ibkrBatchTickers.length} affichés
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Maximum 50 titres par validation IBKR Shadow. Si plus de 50 titres sont affichés,
              seuls les 50 premiers sont envoyés.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Client ID start</label>
                <Input
                  type="number"
                  value={ibkrBatchClientIdStart}
                  onChange={(e) => setIbkrBatchClientIdStart(e.target.value)}
                  className="w-full rounded-xl border-slate-200"
                />
              </div>
              <div className="md:col-span-3 flex items-end">
                <Button
                  className="w-full rounded-xl"
                  onClick={handleIbkrBatchValidate}
                  disabled={ibkrBatchLoading || filtered.length === 0}
                >
                  Valider shortlist avec IBKR Shadow
                </Button>
              </div>
            </div>

            {ibkrBatchLoading && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                Validation IBKR Shadow en cours…
              </div>
            )}

            {ibkrBatchError && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                Erreur batch IBKR Shadow : {ibkrBatchError}
              </div>
            )}

            {ibkrBatchResult?.ok === true && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <Metric label="Total" value={String(ibkrBatchResult?.total ?? "—")} strong />
                  <Metric label="Complétés" value={String(ibkrBatchResult?.completed ?? "—")} />
                  <Metric
                    label="Confirmés"
                    value={String(ibkrBatchResult?.summary?.confirmed ?? 0)}
                    tone="good"
                  />
                  <Metric
                    label="Différents"
                    value={String(ibkrBatchResult?.summary?.different ?? 0)}
                    tone="warn"
                  />
                  <Metric
                    label="IBKR indisponible"
                    value={String(ibkrBatchResult?.summary?.ibkr_unavailable ?? 0)}
                    tone="warn"
                  />
                  <Metric
                    label="Yahoo indisponible"
                    value={String(ibkrBatchResult?.summary?.yahoo_unavailable ?? 0)}
                    tone="warn"
                  />
                  <Metric
                    label="Échec deux côtés"
                    value={String(ibkrBatchResult?.summary?.both_failed ?? 0)}
                    tone="bad"
                  />
                </div>

                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  <p className="mb-2 font-medium text-slate-900">Résultats compacts</p>
                  <div className="space-y-1">
                    {(ibkrBatchResult?.results || []).map((row) => (
                      <div key={`ibkr-batch-${row.symbol}`} className="text-sm">
                        {row.symbol}: {row.status}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <IbkrDirectScanPanel
          clientIdStart={ibkrDirectClientIdStart}
          setClientIdStart={setIbkrDirectClientIdStart}
          maxTickers={ibkrDirectMaxTickers}
          setMaxTickers={setIbkrDirectMaxTickers}
          topN={ibkrDirectTopN}
          setTopN={setIbkrDirectTopN}
          expiration={ymdToIbkr(selectedExpiration)}
          tickerCount={ibkrDirectTickers.length}
          loading={ibkrDirectLoading}
          error={ibkrDirectError}
          result={ibkrDirectResult}
          sentTickers={ibkrDirectSentTickers.length ? ibkrDirectSentTickers : ibkrDirectTickersForSend}
          onRun={handleIbkrDirectScan}
          onRunTest={handleIbkrDirectTestScan}
        />

        <details className="mb-6 rounded-[28px] border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
          <summary className="cursor-pointer font-semibold text-slate-900">
            Diagnostic secondaire : ancienne vue fusionnée
          </summary>
          <div className="mt-4">
            <MergedShortlistSection candidates={mergedIbkrYahooCandidatesForPanel} />
          </div>
        </details>
          </div>
        </details>

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
          <>
            {showClosedValidBanner && (
              <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 shadow-sm">
                Marche ferme — dernier scan valide affiche (cache local). Donnees indicatives / non
                tradables.
              </div>
            )}

            {showIndicativeClosedBanner && (
              <div className="mb-6 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-900 shadow-sm">
                <span className="font-semibold">DEV TEST</span> — marche ferme / donnees indicatives / non
                tradables.
                {backendShortlistDevScan ? " WHEEL_DEV_SCAN actif cote backend." : ""}
              </div>
            )}

            {showSourceStatusBanner && (
              <div
                className={cn(
                  "mb-6 rounded-2xl border p-4 text-sm shadow-sm",
                  dataSource === "backend" || dataSource === "ibkr_direct"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-700"
                )}
              >
                {dataSource === "ibkr_direct"
                  ? `Source active : IBKR Direct Scan — ${scanMeta.kept} retenus sur ${scanMeta.scanned} scannés.${primaryIbkrSourceInfo?.twoPhaseEnabled ? " 2 phases officiel actif." : ""}`
                  : dataSource === "backend"
                  ? `Source active : backend local /scan_shortlist — ${scanMeta.kept} retenus sur ${scanMeta.scanned} scannés (watchlist ${watchlistSource === "backend" ? "backend" : "secours"}).`
                  : "Source active : snapshot local (fallback)."}
              </div>
            )}

            {showClosedNoCacheBanner && (
              <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 shadow-sm">
                Marche ferme et aucun scan valide en cache local.
              </div>
            )}

            {scanError && !showClosedNoCacheBanner && (
              <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 shadow-sm">
                {scanError}
              </div>
            )}
          </>
        )}


        <div className="space-y-6">
          <div className="space-y-6">
            <Card className="rounded-[28px] border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <CardTitle className="text-xl text-slate-900">Shortlist hebdomadaire</CardTitle>
                    <p className="mt-1 text-sm text-slate-500">
                      {dataSource === "ibkr_direct"
                        ? "Shortlist chargée depuis IBKR Direct Scan."
                        : dataSource === "backend"
                        ? "Shortlist chargée automatiquement depuis le backend local /scan_shortlist."
                        : "Snapshot local affiché en fallback tant que le backend n’a pas répondu."}
                    </p>
                    {dataSource === "ibkr_direct" && (
                      <p className="mt-1 text-xs text-slate-500">
                        Source : IBKR Direct Scan — 2 phases officiel · twoPhaseEnabled:{" "}
                        {String(primaryIbkrSourceInfo?.twoPhaseEnabled === true)}
                      </p>
                    )}
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
                      <option value="quality">Trier par: qualité Wheel</option>
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
                    <span className="text-xs font-medium text-slate-500">
                      Tri actif : {sortBy} {sortOrder}
                    </span>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                {filtered.map((item, index) => (
                  <CandidateCard
                    key={`${item.ticker}-${item.setup}`}
                    item={item}
                    displayRank={index + 1}
                    yahooRankForIbkr={yahooRankForIbkrBySymbol.get(String(item?.ticker || "").trim().toUpperCase())}
                    onOpenDetail={setSelectedItem}
                    ibkrBatchRow={ibkrBatchByTicker.get(String(item?.ticker || "").trim().toUpperCase()) || null}
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
                      {dataSource === "ibkr_direct"
                        ? "IBKR Direct Scan"
                        : dataSource === "backend"
                        ? "backend local"
                        : "snapshot"}
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
